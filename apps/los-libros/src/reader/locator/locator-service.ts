/**
 * Locator Service
 *
 * Provides robust position tracking and anchoring using the Readium Locator model.
 * Uses a fallback chain for anchoring:
 * 1. CFI (exact DOM path)
 * 2. Text context search (exact match)
 * 3. Fuzzy search (Levenshtein distance)
 * 4. Progression fallback
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

import type { Locator } from '../navigator/navigator-interface';
import {
  generateFullCfi,
  resolveCfi,
  getSpineIndexFromCfi,
  isValidCfi,
} from '../renderer/cfi-utils';
import { fuzzyAnchor, levenshteinDistance } from './fuzzy-anchor';

// ============================================================================
// Constants
// ============================================================================

/** Context length for fuzzy matching */
const CONTEXT_LENGTH = 50;

/** Maximum Levenshtein distance threshold (10% of text length) */
const FUZZY_THRESHOLD_PERCENT = 0.1;

// ============================================================================
// Locator Creation
// ============================================================================

/**
 * Create a locator from a DOM range
 *
 * @param range - The DOM range to create a locator for
 * @param href - The spine item href
 * @param spineIndex - The spine index (0-based)
 * @returns A locator with CFI and text context
 */
export function rangeToLocator(
  range: Range,
  href: string,
  spineIndex: number
): Locator {
  // Get the selected text
  const highlight = range.toString();

  // Get text context before and after
  const { before, after } = getTextContext(range, CONTEXT_LENGTH);

  // Generate CFI
  const startNode = range.startContainer;
  const startOffset = range.startOffset;
  const cfi = generateFullCfi(spineIndex, startNode, startOffset);

  // Calculate progression (approximate - based on range position in document)
  const progression = calculateProgression(range);

  return {
    href,
    locations: {
      progression,
      cfi,
      position: spineIndex,
    },
    text: {
      before,
      highlight,
      after,
    },
  };
}

/**
 * Create a locator for the current viewport position
 *
 * @param container - The content container element
 * @param href - The spine item href
 * @param spineIndex - The spine index
 * @param viewportRect - The visible viewport rectangle
 */
export function viewportToLocator(
  container: HTMLElement,
  href: string,
  spineIndex: number,
  viewportRect: DOMRect
): Locator {
  // Find first visible text node
  const range = getFirstVisibleRange(container, viewportRect);

  if (range) {
    return rangeToLocator(range, href, spineIndex);
  }

  // Fallback to basic locator
  return {
    href,
    locations: {
      progression: 0,
      position: spineIndex,
    },
  };
}

// ============================================================================
// Locator Resolution (Anchoring)
// ============================================================================

/**
 * Anchoring result with method used
 */
export interface AnchorResult {
  range: Range;
  method: 'cfi' | 'exact' | 'fuzzy' | 'progression';
  confidence: number; // 0-1, where 1 is exact match
}

/**
 * Anchor a locator to a DOM range
 *
 * Uses fallback chain:
 * 1. CFI (exact DOM path)
 * 2. Text context search (exact match)
 * 3. Fuzzy search (Levenshtein distance)
 * 4. Progression fallback
 *
 * @param locator - The locator to anchor
 * @param container - The container to search in
 * @returns Anchor result with range and method used
 */
export async function anchorToDOM(
  locator: Locator,
  container: HTMLElement | ShadowRoot
): Promise<AnchorResult | null> {
  const doc = container.ownerDocument || (container as ShadowRoot).ownerDocument;
  if (!doc) return null;

  // 1. Try CFI first (most precise)
  if (locator.locations.cfi && isValidCfi(locator.locations.cfi)) {
    const cfiResult = await tryCfiAnchor(locator.locations.cfi, container, doc);
    if (cfiResult) {
      // Validate CFI result matches expected text
      if (locator.text?.highlight) {
        const rangeText = cfiResult.toString();
        if (textMatches(rangeText, locator.text.highlight)) {
          return { range: cfiResult, method: 'cfi', confidence: 1.0 };
        }
        // CFI resolved but text doesn't match - content changed
        console.warn('[LocatorService] CFI resolved but text mismatch, trying text anchor');
      } else {
        return { range: cfiResult, method: 'cfi', confidence: 1.0 };
      }
    }
  }

  // 2. Try exact text match
  if (locator.text?.highlight) {
    const exactResult = tryExactTextAnchor(locator.text, container);
    if (exactResult) {
      return { range: exactResult, method: 'exact', confidence: 0.95 };
    }
  }

  // 3. Try fuzzy text match
  if (locator.text?.highlight) {
    const fuzzyResult = await fuzzyAnchor(locator.text, container);
    if (fuzzyResult) {
      return { range: fuzzyResult.range, method: 'fuzzy', confidence: fuzzyResult.confidence };
    }
  }

  // 4. Fallback to progression-based position
  const progressionResult = tryProgressionAnchor(locator.locations.progression, container);
  if (progressionResult) {
    return { range: progressionResult, method: 'progression', confidence: 0.3 };
  }

  return null;
}

/**
 * Try to anchor using CFI
 */
async function tryCfiAnchor(
  cfi: string,
  container: HTMLElement | ShadowRoot,
  doc: Document
): Promise<Range | null> {
  try {
    const resolved = await resolveCfi(doc, cfi);
    if (!resolved) return null;

    // Create range at resolved position
    const range = doc.createRange();

    if (resolved.node.nodeType === Node.TEXT_NODE) {
      range.setStart(resolved.node, resolved.offset);
      range.setEnd(resolved.node, resolved.offset);
    } else {
      range.selectNodeContents(resolved.node);
    }

    return range;
  } catch (error) {
    console.warn('[LocatorService] CFI anchor failed:', error);
    return null;
  }
}

/**
 * Try to anchor using exact text match with context
 */
function tryExactTextAnchor(
  text: { before?: string; highlight?: string; after?: string },
  container: HTMLElement | ShadowRoot
): Range | null {
  if (!text.highlight) return null;

  const doc = container.ownerDocument || (container as ShadowRoot).ownerDocument;
  if (!doc) return null;

  // Build search pattern with context
  const searchText = [
    text.before?.slice(-20) || '',
    text.highlight,
    text.after?.slice(0, 20) || '',
  ].join('');

  // Search for exact match
  const range = findTextRange(container, searchText);
  if (!range) return null;

  // Narrow range to just the highlight portion
  if (text.before && text.after) {
    try {
      const beforeLen = (text.before?.slice(-20) || '').length;
      const highlightLen = text.highlight.length;

      range.setStart(range.startContainer, range.startOffset + beforeLen);
      range.setEnd(range.startContainer, range.startOffset + beforeLen + highlightLen);
    } catch {
      // Keep original range if adjustment fails
    }
  }

  return range;
}

/**
 * Try to anchor using document progression
 */
function tryProgressionAnchor(
  progression: number,
  container: HTMLElement | ShadowRoot
): Range | null {
  const doc = container.ownerDocument || (container as ShadowRoot).ownerDocument;
  if (!doc) return null;

  // Get all text nodes
  const textNodes: Text[] = [];
  const walker = doc.createTreeWalker(
    container as Node,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (!node.textContent || node.textContent.trim().length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  if (textNodes.length === 0) return null;

  // Calculate total text length and target position
  const totalLength = textNodes.reduce((sum, n) => sum + (n.textContent?.length ?? 0), 0);
  const targetOffset = Math.floor(progression * totalLength);

  // Find the text node at target offset
  let currentOffset = 0;
  for (const textNode of textNodes) {
    const nodeLength = textNode.textContent?.length ?? 0;
    if (currentOffset + nodeLength >= targetOffset) {
      const offsetInNode = targetOffset - currentOffset;
      const range = doc.createRange();
      range.setStart(textNode, Math.min(offsetInNode, nodeLength));
      range.setEnd(textNode, Math.min(offsetInNode, nodeLength));
      return range;
    }
    currentOffset += nodeLength;
  }

  return null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get text context around a range
 */
function getTextContext(
  range: Range,
  length: number
): { before: string; after: string } {
  const container = range.commonAncestorContainer;

  // Get all text in the document
  const fullText = container.textContent || '';
  const selectedText = range.toString();

  // Find the position of selected text
  const startPos = fullText.indexOf(selectedText);
  if (startPos === -1) {
    return { before: '', after: '' };
  }

  const endPos = startPos + selectedText.length;

  return {
    before: fullText.slice(Math.max(0, startPos - length), startPos),
    after: fullText.slice(endPos, endPos + length),
  };
}

/**
 * Calculate approximate progression of a range within its container
 */
function calculateProgression(range: Range): number {
  const container = range.commonAncestorContainer.parentElement;
  if (!container) return 0;

  const fullText = container.textContent || '';
  const rangeOffset = fullText.indexOf(range.toString());

  if (rangeOffset === -1 || fullText.length === 0) return 0;

  return rangeOffset / fullText.length;
}

/**
 * Get the first visible text range in a viewport
 */
function getFirstVisibleRange(
  container: HTMLElement,
  viewportRect: DOMRect
): Range | null {
  const doc = container.ownerDocument;
  if (!doc) return null;

  const walker = doc.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (!node.textContent || node.textContent.trim().length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const range = doc.createRange();
    range.selectNodeContents(node);

    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (
        rect.left >= viewportRect.left &&
        rect.left < viewportRect.right &&
        rect.top >= viewportRect.top &&
        rect.top < viewportRect.bottom
      ) {
        range.setStart(node, 0);
        range.setEnd(node, Math.min(10, (node.textContent?.length ?? 0)));
        return range;
      }
    }
  }

  return null;
}

/**
 * Find a text range in a container
 */
function findTextRange(
  container: HTMLElement | ShadowRoot,
  searchText: string
): Range | null {
  const doc = container.ownerDocument || (container as ShadowRoot).ownerDocument;
  if (!doc) return null;

  // Use TreeWalker to find text nodes
  const walker = doc.createTreeWalker(
    container as Node,
    NodeFilter.SHOW_TEXT,
    null
  );

  // Collect all text with node references
  const textNodes: { node: Text; start: number }[] = [];
  let fullText = '';

  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push({ node: node as Text, start: fullText.length });
    fullText += node.textContent || '';
  }

  // Find search text in full text
  const index = fullText.indexOf(searchText);
  if (index === -1) return null;

  // Find the text nodes that contain this range
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (let i = 0; i < textNodes.length; i++) {
    const { node: textNode, start } = textNodes[i];
    const nodeEnd = start + (textNode.textContent?.length ?? 0);

    if (!startNode && start <= index && nodeEnd > index) {
      startNode = textNode;
      startOffset = index - start;
    }

    const searchEnd = index + searchText.length;
    if (!endNode && start < searchEnd && nodeEnd >= searchEnd) {
      endNode = textNode;
      endOffset = searchEnd - start;
    }

    if (startNode && endNode) break;
  }

  if (!startNode || !endNode) return null;

  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);

  return range;
}

/**
 * Check if two texts match (allowing minor differences)
 */
function textMatches(text1: string, text2: string): boolean {
  // Normalize whitespace
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const n1 = normalize(text1);
  const n2 = normalize(text2);

  // Exact match
  if (n1 === n2) return true;

  // Allow small differences (less than 5%)
  const maxDist = Math.ceil(n2.length * 0.05);
  return levenshteinDistance(n1, n2) <= maxDist;
}

// ============================================================================
// Batch Operations
// ============================================================================

/**
 * Anchor multiple locators in parallel
 */
export async function anchorLocators(
  locators: Locator[],
  container: HTMLElement | ShadowRoot
): Promise<Map<Locator, AnchorResult | null>> {
  const results = new Map<Locator, AnchorResult | null>();

  await Promise.all(
    locators.map(async (locator) => {
      const result = await anchorToDOM(locator, container);
      results.set(locator, result);
    })
  );

  return results;
}

/**
 * Re-anchor all locators after content change (e.g., font size change)
 */
export async function reanchorLocators(
  locators: Locator[],
  container: HTMLElement | ShadowRoot
): Promise<{ success: Locator[]; failed: Locator[] }> {
  const success: Locator[] = [];
  const failed: Locator[] = [];

  const results = await anchorLocators(locators, container);

  for (const [locator, result] of results) {
    if (result && result.confidence >= 0.5) {
      success.push(locator);
    } else {
      failed.push(locator);
    }
  }

  return { success, failed };
}

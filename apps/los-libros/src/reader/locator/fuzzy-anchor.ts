/**
 * Fuzzy Anchor
 *
 * Provides fuzzy text matching for anchoring positions when exact matches fail.
 * Uses Levenshtein distance for similarity scoring.
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Fuzzy match result
 */
export interface FuzzyMatchResult {
  range: Range;
  confidence: number; // 0-1, higher is better
  distance: number; // Levenshtein distance
  matchedText: string;
}

/**
 * Text selector for fuzzy matching
 */
export interface TextSelector {
  before?: string;
  highlight?: string;
  after?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum Levenshtein distance threshold (10% of text length) */
const DEFAULT_THRESHOLD_PERCENT = 0.1;

/** Minimum context length for reliable matching */
const MIN_CONTEXT_LENGTH = 10;

/** Window size for sliding window search */
const SEARCH_WINDOW_MULTIPLIER = 2;

// ============================================================================
// Levenshtein Distance
// ============================================================================

/**
 * Calculate Levenshtein distance between two strings
 * Uses dynamic programming for O(mn) time complexity
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Handle empty strings
  if (m === 0) return n;
  if (n === 0) return m;

  // Create matrix
  const matrix: number[][] = [];

  // Initialize first column
  for (let i = 0; i <= m; i++) {
    matrix[i] = [i];
  }

  // Initialize first row
  for (let j = 0; j <= n; j++) {
    matrix[0][j] = j;
  }

  // Fill in the rest of the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[m][n];
}

/**
 * Calculate similarity ratio between two strings (0-1)
 */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);

  return 1 - distance / maxLength;
}

// ============================================================================
// Fuzzy Anchor
// ============================================================================

/**
 * Find a fuzzy match for text in a container
 *
 * @param selector - Text selector with optional context
 * @param container - Container to search in
 * @param thresholdPercent - Maximum distance threshold as percentage of text length
 * @returns Best fuzzy match result or null
 */
export async function fuzzyAnchor(
  selector: TextSelector,
  container: HTMLElement | ShadowRoot,
  thresholdPercent: number = DEFAULT_THRESHOLD_PERCENT
): Promise<FuzzyMatchResult | null> {
  if (!selector.highlight) return null;

  const doc = container.ownerDocument || (container as ShadowRoot).ownerDocument;
  if (!doc) return null;

  // Build search target with context
  const targetText = buildSearchTarget(selector);
  const highlightLen = selector.highlight.length;

  // Get all text content from container
  const fullText = extractText(container);
  if (!fullText) return null;

  // Calculate threshold
  const maxDistance = Math.ceil(highlightLen * thresholdPercent);

  // Find best match using sliding window
  const result = findBestMatch(fullText, targetText, maxDistance);
  if (!result) return null;

  // Create range for the match
  const range = createRangeFromMatch(container, doc, result.start, result.end);
  if (!range) return null;

  // Calculate confidence based on distance
  const confidence = 1 - result.distance / highlightLen;

  return {
    range,
    confidence: Math.max(0, Math.min(1, confidence)),
    distance: result.distance,
    matchedText: result.text,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build search target from selector with context
 */
function buildSearchTarget(selector: TextSelector): string {
  const parts: string[] = [];

  if (selector.before) {
    // Use last portion of before context
    parts.push(selector.before.slice(-MIN_CONTEXT_LENGTH));
  }

  if (selector.highlight) {
    parts.push(selector.highlight);
  }

  if (selector.after) {
    // Use first portion of after context
    parts.push(selector.after.slice(0, MIN_CONTEXT_LENGTH));
  }

  return normalizeText(parts.join(''));
}

/**
 * Normalize text for comparison (normalize whitespace, lowercase)
 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract all text from a container
 */
function extractText(container: HTMLElement | ShadowRoot): string {
  // For ShadowRoot, we need to handle differently
  if ('host' in container) {
    return (container as ShadowRoot).textContent || '';
  }
  return container.textContent || '';
}

/**
 * Find best match result
 */
interface MatchResult {
  start: number;
  end: number;
  distance: number;
  text: string;
}

/**
 * Find the best fuzzy match using sliding window
 */
function findBestMatch(
  haystack: string,
  needle: string,
  maxDistance: number
): MatchResult | null {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedNeedle = normalizeText(needle);

  if (!normalizedHaystack || !normalizedNeedle) return null;

  const windowSize = normalizedNeedle.length;
  let bestMatch: MatchResult | null = null;

  // Slide window through text
  for (let i = 0; i <= normalizedHaystack.length - windowSize; i++) {
    const window = normalizedHaystack.slice(i, i + windowSize);
    const distance = levenshteinDistance(window, normalizedNeedle);

    // Update best match if this is better
    if (distance <= maxDistance) {
      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = {
          start: i,
          end: i + windowSize,
          distance,
          text: window,
        };

        // Perfect match - no need to continue
        if (distance === 0) break;
      }
    }
  }

  // Also try with slight variations in window size
  if (!bestMatch || bestMatch.distance > 0) {
    for (const delta of [-2, -1, 1, 2]) {
      const adjustedSize = windowSize + delta;
      if (adjustedSize <= 0) continue;

      for (let i = 0; i <= normalizedHaystack.length - adjustedSize; i++) {
        const window = normalizedHaystack.slice(i, i + adjustedSize);
        const distance = levenshteinDistance(window, normalizedNeedle);

        if (distance <= maxDistance) {
          if (!bestMatch || distance < bestMatch.distance) {
            bestMatch = {
              start: i,
              end: i + adjustedSize,
              distance,
              text: window,
            };
          }
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Create a DOM Range from match positions
 */
function createRangeFromMatch(
  container: HTMLElement | ShadowRoot,
  doc: Document,
  start: number,
  end: number
): Range | null {
  // Get text nodes with positions
  const textNodes: { node: Text; start: number; end: number }[] = [];
  let position = 0;

  const walker = doc.createTreeWalker(
    container as Node,
    NodeFilter.SHOW_TEXT,
    null
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    const normalizedText = normalizeText(text);

    if (normalizedText.length > 0) {
      textNodes.push({
        node: node as Text,
        start: position,
        end: position + normalizedText.length,
      });
      position += normalizedText.length;
    }
  }

  if (textNodes.length === 0) return null;

  // Find start and end nodes
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (const { node: textNode, start: nodeStart, end: nodeEnd } of textNodes) {
    // Find start position
    if (!startNode && nodeStart <= start && nodeEnd > start) {
      startNode = textNode;
      startOffset = start - nodeStart;

      // Adjust for actual (non-normalized) text
      startOffset = adjustOffset(textNode.textContent || '', startOffset);
    }

    // Find end position
    if (!endNode && nodeStart < end && nodeEnd >= end) {
      endNode = textNode;
      endOffset = end - nodeStart;

      // Adjust for actual text
      endOffset = adjustOffset(textNode.textContent || '', endOffset);
    }

    if (startNode && endNode) break;
  }

  if (!startNode || !endNode) return null;

  try {
    const range = doc.createRange();
    range.setStart(startNode, Math.min(startOffset, startNode.textContent?.length ?? 0));
    range.setEnd(endNode, Math.min(endOffset, endNode.textContent?.length ?? 0));
    return range;
  } catch (error) {
    console.warn('[FuzzyAnchor] Failed to create range:', error);
    return null;
  }
}

/**
 * Adjust offset from normalized text to actual text
 */
function adjustOffset(actualText: string, normalizedOffset: number): number {
  let actual = 0;
  let normalized = 0;
  let inWhitespace = false;

  for (let i = 0; i < actualText.length && normalized < normalizedOffset; i++) {
    const char = actualText[i];
    const isWs = /\s/.test(char);

    if (isWs) {
      if (!inWhitespace) {
        normalized++;
        inWhitespace = true;
      }
    } else {
      normalized++;
      inWhitespace = false;
    }

    actual = i + 1;
  }

  return actual;
}

// ============================================================================
// Batch Operations
// ============================================================================

/**
 * Find multiple fuzzy matches efficiently
 */
export async function fuzzyAnchorBatch(
  selectors: TextSelector[],
  container: HTMLElement | ShadowRoot
): Promise<Map<TextSelector, FuzzyMatchResult | null>> {
  const results = new Map<TextSelector, FuzzyMatchResult | null>();

  // Process in parallel
  await Promise.all(
    selectors.map(async (selector) => {
      const result = await fuzzyAnchor(selector, container);
      results.set(selector, result);
    })
  );

  return results;
}

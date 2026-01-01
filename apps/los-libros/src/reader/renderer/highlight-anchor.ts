/**
 * Highlight Anchor
 *
 * Re-anchors stored highlights to DOM Ranges for rendering.
 * Uses W3C Web Annotation selectors with fallback chain:
 * 1. CFI (most precise for unchanged content)
 * 2. TextQuote with context (handles content drift)
 * 3. TextPosition (last resort)
 */

import type { HighlightSelector, AnchorResult } from './types';

/**
 * Text quote selector for anchoring
 */
interface TextQuoteSelector {
  type: 'TextQuoteSelector';
  exact: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Highlight re-anchoring engine
 * Converts stored selectors to DOM Ranges for the current view
 */
export class HighlightAnchor {
  private doc: Document;
  private searchScope: Element | null = null;

  constructor(doc: Document) {
    this.doc = doc;
  }

  /**
   * Set the search scope to a specific element (e.g., chapter container)
   * This restricts text searches to within that element only
   */
  setSearchScope(element: Element | null): void {
    this.searchScope = element;
  }

  /**
   * Get the root element for searching (scope or body)
   */
  private getSearchRoot(): Element {
    return this.searchScope || this.doc.body;
  }

  /**
   * Anchor a selector to a DOM Range
   * Strategy: CFI first → TextQuote fallback → Position last resort
   *
   * @param selector - The selector to anchor
   * @param scopeElement - Optional element to restrict search to (e.g., chapter)
   */
  anchor(selector: HighlightSelector, scopeElement?: Element): AnchorResult {
    // Temporarily set scope if provided
    const previousScope = this.searchScope;
    if (scopeElement) {
      this.searchScope = scopeElement;
    }

    try {
      // 1. Try TextQuote first (most robust for reflow scenarios)
      // CFI can break if content changes, but TextQuote with context is resilient
      if (selector.fallback) {
        const textResult = this.anchorByTextQuote(selector.fallback);
        if (textResult.range) {
          return textResult;
        }
      }

      // 2. Try position fallback (character offsets)
      if (selector.position) {
        const posResult = this.anchorByPosition(
          selector.position.start,
          selector.position.end
        );
        if (posResult.range) {
          return posResult;
        }
      }

      // 3. Could not anchor
      return { range: null, status: 'orphaned', confidence: 0 };
    } finally {
      // Restore previous scope
      this.searchScope = previousScope;
    }
  }

  /**
   * Anchor using text quote with prefix/suffix context
   * This is the most robust method for surviving reflows
   */
  private anchorByTextQuote(selector: TextQuoteSelector): AnchorResult {
    const searchRoot = this.getSearchRoot();
    const textContent = searchRoot.textContent || '';
    const { exact, prefix, suffix } = selector;

    // Strategy 1: Match with full context (highest confidence)
    if (prefix && suffix) {
      const pattern = prefix + exact + suffix;
      const index = textContent.indexOf(pattern);
      if (index !== -1) {
        const start = index + prefix.length;
        const end = start + exact.length;
        return this.createRangeFromOffset(start, end, 'exact', 1.0);
      }
    }

    // Strategy 2: Match with prefix only
    if (prefix) {
      const pattern = prefix + exact;
      const index = textContent.indexOf(pattern);
      if (index !== -1) {
        const start = index + prefix.length;
        const end = start + exact.length;
        return this.createRangeFromOffset(start, end, 'exact', 0.9);
      }
    }

    // Strategy 3: Match with suffix only
    if (suffix) {
      const pattern = exact + suffix;
      const index = textContent.indexOf(pattern);
      if (index !== -1) {
        return this.createRangeFromOffset(index, index + exact.length, 'exact', 0.9);
      }
    }

    // Strategy 4: Match exact text only (lowest confidence, may hit wrong instance)
    const exactIndex = textContent.indexOf(exact);
    if (exactIndex !== -1) {
      return this.createRangeFromOffset(
        exactIndex,
        exactIndex + exact.length,
        'fuzzy',
        0.5
      );
    }

    return { range: null, status: 'orphaned', confidence: 0 };
  }

  /**
   * Anchor using character position offsets
   */
  private anchorByPosition(start: number, end: number): AnchorResult {
    const range = this.createRangeFromCharOffset(start, end);
    if (range) {
      return { range, status: 'fuzzy', confidence: 0.3 };
    }
    return { range: null, status: 'orphaned', confidence: 0 };
  }

  /**
   * Create a Range from character offsets in the document
   */
  private createRangeFromOffset(
    start: number,
    end: number,
    status: 'exact' | 'fuzzy' | 'orphaned',
    confidence: number
  ): AnchorResult {
    const range = this.createRangeFromCharOffset(start, end);
    if (range) {
      return { range, status, confidence };
    }
    return { range: null, status: 'orphaned', confidence: 0 };
  }

  /**
   * Create a DOM Range from character offsets
   * Walks the text nodes to find the correct positions
   */
  private createRangeFromCharOffset(start: number, end: number): Range | null {
    const range = this.doc.createRange();
    const searchRoot = this.getSearchRoot();
    const walker = this.doc.createTreeWalker(
      searchRoot,
      NodeFilter.SHOW_TEXT,
      null
    );

    let charCount = 0;
    let foundStart = false;
    let foundEnd = false;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const nodeLength = node.textContent?.length || 0;
      const nodeEnd = charCount + nodeLength;

      // Find start position
      if (!foundStart && start >= charCount && start < nodeEnd) {
        try {
          range.setStart(node, start - charCount);
          foundStart = true;
        } catch (e) {
          console.warn('[HighlightAnchor] Failed to set range start:', e);
          return null;
        }
      }

      // Find end position
      if (!foundEnd && end >= charCount && end <= nodeEnd) {
        try {
          range.setEnd(node, end - charCount);
          foundEnd = true;
          break;
        } catch (e) {
          console.warn('[HighlightAnchor] Failed to set range end:', e);
          return null;
        }
      }

      charCount = nodeEnd;
    }

    if (foundStart && foundEnd) {
      return range;
    }

    return null;
  }

  /**
   * Get viewport-relative rects from a Range
   * CRITICAL: Uses getClientRects() for multi-column support
   *
   * @param range - The DOM Range to get rects for
   * @param iframeRect - Bounding rect of the iframe element
   * @param containerRect - Bounding rect of the container element
   * @returns Array of DOMRects in container-relative coordinates
   */
  static getViewportRects(
    range: Range,
    iframeRect: DOMRect,
    containerRect: DOMRect
  ): DOMRect[] {
    // CRITICAL: Use getClientRects() not getBoundingClientRect()
    // getClientRects() returns individual rects for each line/column fragment
    // getBoundingClientRect() returns one bounding box (wrong for multi-column)
    const rects = Array.from(range.getClientRects());

    // Calculate offset from iframe to container coordinates
    const offsetX = iframeRect.left - containerRect.left;
    const offsetY = iframeRect.top - containerRect.top;

    // Transform rects to container-relative coordinates
    // Filter out empty/tiny rects that can occur at line breaks
    return rects
      .filter(r => r.width > 1 && r.height > 1)
      .map(r => new DOMRect(
        r.x + offsetX,
        r.y + offsetY,
        r.width,
        r.height
      ));
  }

  /**
   * Filter rects to only those visible in the container viewport
   *
   * @param rects - Array of rects to filter
   * @param containerWidth - Width of the visible container
   * @param containerHeight - Height of the visible container
   * @returns Array of visible rects
   */
  static filterVisibleRects(
    rects: DOMRect[],
    containerWidth: number,
    containerHeight: number
  ): DOMRect[] {
    return rects.filter(rect =>
      rect.right > 0 &&
      rect.left < containerWidth &&
      rect.bottom > 0 &&
      rect.top < containerHeight
    );
  }

  /**
   * Merge overlapping rects to reduce rendering load
   * Adjacent rects on the same line are merged into one
   */
  static mergeRects(rects: DOMRect[]): DOMRect[] {
    if (rects.length <= 1) return rects;

    // Sort by y position, then x position
    const sorted = [...rects].sort((a, b) => {
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) < 2) return a.x - b.x; // Same line
      return yDiff;
    });

    const merged: DOMRect[] = [];
    let current = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];

      // Check if on same line (y within 2px) and adjacent/overlapping
      const sameLine = Math.abs(current.y - next.y) < 2;
      const adjacent = next.x <= current.right + 2;

      if (sameLine && adjacent) {
        // Merge: extend current rect to include next
        current = new DOMRect(
          current.x,
          Math.min(current.y, next.y),
          Math.max(current.right, next.right) - current.x,
          Math.max(current.height, next.height)
        );
      } else {
        // Not mergeable, save current and start new
        merged.push(current);
        current = next;
      }
    }

    merged.push(current);
    return merged;
  }
}

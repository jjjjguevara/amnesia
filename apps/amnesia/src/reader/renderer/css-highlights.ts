/**
 * CSS Custom Highlight API Manager
 *
 * Uses the native browser CSS Custom Highlight API to render highlights.
 * This eliminates the coordinate drift issues with SVG overlays because:
 * - No DOM modification (unlike inline <mark> elements)
 * - No coordinate transforms needed (browser handles this internally)
 * - Native browser rendering at compositor level
 * - 5x faster than DOM-based highlighting
 *
 * Browser support: Chrome 105+, Safari 17.2+, Firefox 140+
 * Falls back to inline highlights for unsupported browsers.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API
 */

import type { HighlightColor } from './types';

/**
 * Check if CSS Custom Highlight API is supported
 */
export function isCSSHighlightAPISupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

/**
 * Highlight color values for ::highlight pseudo-elements
 */
const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: 'rgba(254, 243, 199, 0.5)',
  green: 'rgba(187, 247, 208, 0.5)',
  blue: 'rgba(191, 219, 254, 0.5)',
  pink: 'rgba(251, 207, 232, 0.5)',
  purple: 'rgba(221, 214, 254, 0.5)',
  orange: 'rgba(254, 215, 170, 0.5)',
};

/**
 * Stored highlight data
 */
interface HighlightData {
  range: Range;
  color: HighlightColor;
}

/**
 * Click callback for highlight interaction
 */
export type HighlightClickCallback = (
  highlightId: string,
  position: { x: number; y: number }
) => void;

/**
 * CSS Custom Highlight Manager
 *
 * Manages highlights using the native CSS Custom Highlight API.
 * Each color gets its own Highlight object in the registry.
 *
 * IMPORTANT: For Shadow DOM content, pass the shadowRoot parameter
 * to inject styles into the shadow root instead of document.head.
 */
export class CSSHighlightManager {
  private doc: Document;
  private shadowRoot: ShadowRoot | null = null;
  private highlightMap = new Map<string, HighlightData>();
  private colorHighlights = new Map<HighlightColor, Highlight>();
  private styleElement: HTMLStyleElement | null = null;
  private onHighlightClick?: HighlightClickCallback;
  private clickHandler?: (e: MouseEvent) => void;

  constructor(doc: Document, onHighlightClick?: HighlightClickCallback, shadowRoot?: ShadowRoot) {
    this.doc = doc;
    this.shadowRoot = shadowRoot ?? null;
    this.onHighlightClick = onHighlightClick;

    if (!isCSSHighlightAPISupported()) {
      console.warn('[CSSHighlights] CSS Custom Highlight API not supported');
      return;
    }

    this.injectStyles();
    this.setupClickHandler();
  }

  /**
   * Inject CSS styles for highlight pseudo-elements
   *
   * For Shadow DOM: Styles are injected into the shadow root.
   * For regular DOM: Styles are injected into document.head.
   */
  private injectStyles(): void {
    // Remove any existing style element
    if (this.styleElement) {
      this.styleElement.remove();
    }

    this.styleElement = this.doc.createElement('style');
    this.styleElement.id = 'amnesia-css-highlights';

    // Generate CSS for each color
    const rules = Object.entries(HIGHLIGHT_COLORS).map(
      ([color, value]) => `::highlight(hl-${color}) { background-color: ${value}; }`
    );

    this.styleElement.textContent = rules.join('\n');

    // Inject into shadow root if provided, otherwise use document head
    if (this.shadowRoot) {
      this.shadowRoot.appendChild(this.styleElement);
      console.debug('[CSSHighlights] Injected styles into Shadow DOM');
    } else {
      this.doc.head.appendChild(this.styleElement);
      console.debug('[CSSHighlights] Injected styles into document head');
    }
  }

  /**
   * Set up click handler for highlight interaction
   * Since CSS Custom Highlights don't create DOM elements, we need to
   * manually detect clicks on highlighted text ranges
   */
  private setupClickHandler(): void {
    this.clickHandler = (e: MouseEvent) => {
      if (!this.onHighlightClick) return;

      const target = e.target as HTMLElement;

      // Links take priority
      if (target.closest('a')) return;

      // Check if click is within any highlight range
      const clickedHighlight = this.findHighlightAtPoint(e.clientX, e.clientY);
      if (clickedHighlight) {
        e.preventDefault();
        e.stopPropagation();
        this.onHighlightClick(clickedHighlight, { x: e.clientX, y: e.clientY });
      }
    };

    // Listen on shadow root if available, otherwise document
    const eventTarget = this.shadowRoot || this.doc;
    eventTarget.addEventListener('click', this.clickHandler as EventListener);
  }

  /**
   * Get the event target (shadow root or document)
   */
  private getEventTarget(): Document | ShadowRoot {
    return this.shadowRoot || this.doc;
  }

  /**
   * Find which highlight (if any) is at the given point
   */
  private findHighlightAtPoint(x: number, y: number): string | null {
    // Use document.caretPositionFromPoint or caretRangeFromPoint
    // to find what text is at the click position
    let range: Range | null = null;

    // Type assertion for browsers that support caretPositionFromPoint (Firefox)
    const docWithCaretPosition = this.doc as Document & {
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    };

    // Type assertion for browsers that support caretRangeFromPoint (Chrome, Safari)
    const docWithCaretRange = this.doc as Document & {
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };

    if (docWithCaretPosition.caretPositionFromPoint) {
      const pos = docWithCaretPosition.caretPositionFromPoint(x, y);
      if (pos && pos.offsetNode) {
        range = this.doc.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.setEnd(pos.offsetNode, pos.offset);
      }
    } else if (docWithCaretRange.caretRangeFromPoint) {
      range = docWithCaretRange.caretRangeFromPoint(x, y);
    }

    if (!range) return null;

    // Check each highlight to see if the point is within its range
    for (const [id, data] of this.highlightMap) {
      try {
        // Check if the clicked position is within this highlight's range
        if (this.rangesOverlap(data.range, range)) {
          return id;
        }
      } catch {
        // Range may be invalid if content changed
        continue;
      }
    }

    return null;
  }

  /**
   * Check if two ranges overlap
   */
  private rangesOverlap(range1: Range, range2: Range): boolean {
    try {
      // A point range overlaps with range1 if it's between start and end
      const comparison1 = range1.compareBoundaryPoints(Range.START_TO_START, range2);
      const comparison2 = range1.compareBoundaryPoints(Range.END_TO_END, range2);

      // If range2 start is after range1 start and before range1 end, they overlap
      if (comparison1 <= 0) {
        const comparison3 = range1.compareBoundaryPoints(Range.END_TO_START, range2);
        return comparison3 >= 0;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Add a highlight
   */
  add(id: string, range: Range, color: HighlightColor): void {
    if (!isCSSHighlightAPISupported()) return;

    // Remove existing highlight with same ID if present
    if (this.highlightMap.has(id)) {
      this.remove(id);
    }

    // Get or create Highlight for this color
    let highlight = this.colorHighlights.get(color);
    if (!highlight) {
      highlight = new Highlight();
      this.colorHighlights.set(color, highlight);
      // Register with CSS.highlights
      const hlName = `hl-${color}`;
      this.doc.defaultView?.CSS?.highlights?.set(hlName, highlight);
    }

    // Add range to highlight
    highlight.add(range);

    // Store for removal/lookup
    this.highlightMap.set(id, { range, color });

    console.debug(`[CSSHighlights] Added highlight ${id} with color ${color}`);
  }

  /**
   * Remove a highlight by ID
   */
  remove(id: string): void {
    const data = this.highlightMap.get(id);
    if (!data) return;

    const highlight = this.colorHighlights.get(data.color);
    if (highlight) {
      highlight.delete(data.range);
    }

    this.highlightMap.delete(id);
    console.debug(`[CSSHighlights] Removed highlight ${id}`);
  }

  /**
   * Update highlight color
   */
  updateColor(id: string, newColor: HighlightColor): void {
    const data = this.highlightMap.get(id);
    if (!data) return;

    // Remove from old color highlight
    const oldHighlight = this.colorHighlights.get(data.color);
    if (oldHighlight) {
      oldHighlight.delete(data.range);
    }

    // Add to new color highlight
    let newHighlight = this.colorHighlights.get(newColor);
    if (!newHighlight) {
      newHighlight = new Highlight();
      this.colorHighlights.set(newColor, newHighlight);
      const hlName = `hl-${newColor}`;
      this.doc.defaultView?.CSS?.highlights?.set(hlName, newHighlight);
    }
    newHighlight.add(data.range);

    // Update stored data
    data.color = newColor;
  }

  /**
   * Clear all highlights
   */
  clear(): void {
    for (const highlight of this.colorHighlights.values()) {
      highlight.clear();
    }
    this.highlightMap.clear();
    console.debug('[CSSHighlights] Cleared all highlights');
  }

  /**
   * Clear highlights for a specific chapter (by spine index)
   */
  clearForChapter(spineIndex: number): void {
    const idsToRemove: string[] = [];

    for (const [id, data] of this.highlightMap) {
      try {
        // Check if the range is within a chapter container
        const container = data.range.commonAncestorContainer;
        const chapterElement =
          container.nodeType === Node.ELEMENT_NODE
            ? (container as Element).closest('[data-chapter-index]')
            : container.parentElement?.closest('[data-chapter-index]');

        if (chapterElement) {
          const chapterIndex = parseInt(chapterElement.getAttribute('data-chapter-index') || '-1', 10);
          if (chapterIndex === spineIndex) {
            idsToRemove.push(id);
          }
        }
      } catch {
        // Range may be invalid
        idsToRemove.push(id);
      }
    }

    for (const id of idsToRemove) {
      this.remove(id);
    }

    console.debug(`[CSSHighlights] Cleared ${idsToRemove.length} highlights for chapter ${spineIndex}`);
  }

  /**
   * Check if a highlight exists
   */
  has(id: string): boolean {
    return this.highlightMap.has(id);
  }

  /**
   * Get the range for a highlight
   */
  getRange(id: string): Range | null {
    return this.highlightMap.get(id)?.range ?? null;
  }

  /**
   * Get all highlight IDs
   */
  getIds(): string[] {
    return Array.from(this.highlightMap.keys());
  }

  /**
   * Set click callback
   */
  setOnHighlightClick(callback: HighlightClickCallback): void {
    this.onHighlightClick = callback;
  }

  /**
   * Destroy the manager
   */
  destroy(): void {
    // Clear all highlights
    for (const highlight of this.colorHighlights.values()) {
      highlight.clear();
    }
    this.colorHighlights.clear();
    this.highlightMap.clear();

    // Remove click handler from correct target
    if (this.clickHandler) {
      const eventTarget = this.getEventTarget();
      eventTarget.removeEventListener('click', this.clickHandler as EventListener);
    }

    // Remove CSS from registry
    if (isCSSHighlightAPISupported()) {
      for (const color of Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]) {
        this.doc.defaultView?.CSS?.highlights?.delete(`hl-${color}`);
      }
    }

    // Remove style element
    if (this.styleElement) {
      this.styleElement.remove();
      this.styleElement = null;
    }

    console.debug('[CSSHighlights] Destroyed');
  }
}

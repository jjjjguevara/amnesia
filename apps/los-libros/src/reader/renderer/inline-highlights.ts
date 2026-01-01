/**
 * Inline Highlights
 *
 * Renders highlights as <mark> elements directly in the DOM.
 * Highlights are part of the content, so they move naturally with text
 * during animations - no transform sync needed.
 *
 * KEY DESIGN: Marks are added once and persist. We don't clear/re-add
 * on every page change - that's what killed performance before.
 */

import type { HighlightColor, HighlightSelector } from './types';
import { HighlightAnchor } from './highlight-anchor';

/**
 * Color values for highlight backgrounds
 */
const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: 'rgba(254, 243, 199, 0.6)',
  green: 'rgba(187, 247, 208, 0.6)',
  blue: 'rgba(191, 219, 254, 0.6)',
  pink: 'rgba(251, 207, 232, 0.6)',
  purple: 'rgba(221, 214, 254, 0.6)',
  orange: 'rgba(254, 215, 170, 0.6)',
};

/**
 * Highlight data for inline rendering
 */
export interface InlineHighlight {
  id: string;
  spineIndex: number;
  color: HighlightColor;
  text: string;
  cfi: string;
  selector?: HighlightSelector;
}

/**
 * Callback for highlight clicks
 */
export type InlineHighlightClickCallback = (
  highlightId: string,
  position: { x: number; y: number }
) => void;

/**
 * Inline Highlight Manager
 * Wraps highlighted text in <mark> elements within the DOM
 */
export class InlineHighlightManager {
  private doc: Document;
  private renderedHighlights: Set<string> = new Set(); // Track what's already in DOM
  private highlights: Map<string, InlineHighlight> = new Map();
  private onHighlightClick?: InlineHighlightClickCallback;
  private loadedChapters: Set<number> = new Set();

  constructor(doc: Document, onHighlightClick?: InlineHighlightClickCallback) {
    this.doc = doc;
    this.onHighlightClick = onHighlightClick;
    this.setupClickHandler();
  }

  /**
   * Set up click handler for highlights
   */
  private setupClickHandler(): void {
    this.doc.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Links take priority
      if (target.closest('a')) return;

      const mark = target.closest('mark[data-highlight-id]') as HTMLElement;
      if (mark && this.onHighlightClick) {
        const id = mark.dataset.highlightId;
        if (id) {
          e.preventDefault();
          e.stopPropagation();
          this.onHighlightClick(id, { x: e.clientX, y: e.clientY });
        }
      }
    });
  }

  /**
   * Update which chapters are currently loaded
   */
  setLoadedChapters(chapters: Set<number>): void {
    const oldChapters = this.loadedChapters;
    this.loadedChapters = chapters;

    // Remove marks for unloaded chapters
    for (const spineIndex of oldChapters) {
      if (!chapters.has(spineIndex)) {
        this.removeHighlightsForChapter(spineIndex);
      }
    }

    // Add marks for newly loaded chapters
    for (const spineIndex of chapters) {
      if (!oldChapters.has(spineIndex)) {
        this.applyHighlightsForChapter(spineIndex);
      }
    }
  }

  /**
   * Set all highlights (called once when book loads)
   */
  setHighlights(highlights: InlineHighlight[]): void {
    // Store highlights
    this.highlights.clear();
    for (const h of highlights) {
      this.highlights.set(h.id, h);
    }

    // Apply only for currently loaded chapters
    for (const spineIndex of this.loadedChapters) {
      this.applyHighlightsForChapter(spineIndex);
    }
  }

  /**
   * Apply highlights for a specific chapter
   */
  private applyHighlightsForChapter(spineIndex: number): void {
    const anchor = new HighlightAnchor(this.doc);
    let applied = 0;
    let skipped = 0;
    let failed = 0;

    for (const highlight of this.highlights.values()) {
      if (highlight.spineIndex !== spineIndex) continue;
      if (this.renderedHighlights.has(highlight.id)) {
        skipped++;
        continue; // Already rendered
      }

      const selector = highlight.selector ?? {
        primary: { type: 'CfiSelector' as const, cfi: highlight.cfi },
        fallback: {
          type: 'TextQuoteSelector' as const,
          exact: highlight.text,
        },
      };

      const result = anchor.anchor(selector);
      if (result.range && result.status !== 'orphaned') {
        this.wrapRangeWithMark(result.range, highlight);
        this.renderedHighlights.add(highlight.id);
        applied++;
      } else {
        failed++;
        console.debug(`[InlineHighlights] Failed to anchor: ${highlight.text.slice(0, 30)}...`, result.status);
      }
    }

    if (applied > 0 || failed > 0) {
      console.log(`[InlineHighlights] Chapter ${spineIndex}: applied=${applied}, skipped=${skipped}, failed=${failed}`);
    }
  }

  /**
   * Remove highlights for a chapter being unloaded
   */
  private removeHighlightsForChapter(spineIndex: number): void {
    for (const highlight of this.highlights.values()) {
      if (highlight.spineIndex === spineIndex && this.renderedHighlights.has(highlight.id)) {
        this.removeMarkFromDom(highlight.id);
        this.renderedHighlights.delete(highlight.id);
      }
    }
  }

  /**
   * Create mark style string for highlight
   */
  private getMarkStyle(color: string): string {
    // Ensure mark is visible with explicit styles
    return `
      background-color: ${color} !important;
      border-radius: 2px;
      padding: 0 1px;
      display: inline;
      position: relative;
      cursor: pointer;
    `.replace(/\s+/g, ' ').trim();
  }

  /**
   * Wrap a Range with <mark> element
   * Uses a simple approach: wrap the range contents directly
   */
  private wrapRangeWithMark(range: Range, highlight: InlineHighlight): void {
    const color = HIGHLIGHT_COLORS[highlight.color] || HIGHLIGHT_COLORS.yellow;
    const markStyle = this.getMarkStyle(color);

    try {
      // For simple single-container ranges, use surroundContents
      if (range.startContainer === range.endContainer) {
        const mark = this.doc.createElement('mark');
        mark.dataset.highlightId = highlight.id;
        mark.style.cssText = markStyle;
        range.surroundContents(mark);
        return;
      }

      // For complex ranges spanning multiple elements, wrap each text node
      const textNodes = this.getTextNodesInRange(range);

      for (const { node, startOffset, endOffset } of textNodes) {
        const mark = this.doc.createElement('mark');
        mark.dataset.highlightId = highlight.id;
        mark.style.cssText = markStyle;

        const text = node.textContent || '';
        const before = text.slice(0, startOffset);
        const highlighted = text.slice(startOffset, endOffset);
        const after = text.slice(endOffset);

        const parent = node.parentNode;
        if (!parent) continue;

        if (before) parent.insertBefore(this.doc.createTextNode(before), node);
        mark.textContent = highlighted;
        parent.insertBefore(mark, node);
        if (after) {
          node.textContent = after;
        } else {
          parent.removeChild(node);
        }
      }
    } catch (e) {
      // surroundContents can fail for complex ranges - silently skip
      console.debug('[InlineHighlights] Could not wrap range:', e);
    }
  }

  /**
   * Get text nodes in a range
   */
  private getTextNodesInRange(range: Range): Array<{
    node: Text;
    startOffset: number;
    endOffset: number;
  }> {
    const result: Array<{ node: Text; startOffset: number; endOffset: number }> = [];

    if (range.startContainer === range.endContainer &&
        range.startContainer.nodeType === Node.TEXT_NODE) {
      return [{
        node: range.startContainer as Text,
        startOffset: range.startOffset,
        endOffset: range.endOffset
      }];
    }

    const walker = this.doc.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT
    );

    let node: Text | null;
    let inRange = false;

    while ((node = walker.nextNode() as Text | null)) {
      if (node === range.startContainer) inRange = true;

      if (inRange) {
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : (node.textContent?.length || 0);
        if (start < end) {
          result.push({ node, startOffset: start, endOffset: end });
        }
      }

      if (node === range.endContainer) break;
    }

    return result;
  }

  /**
   * Remove a specific mark from DOM
   */
  private removeMarkFromDom(highlightId: string): void {
    const marks = this.doc.querySelectorAll(`mark[data-highlight-id="${highlightId}"]`);
    for (const mark of marks) {
      const text = this.doc.createTextNode(mark.textContent || '');
      mark.parentNode?.replaceChild(text, mark);
    }
  }

  /**
   * Remove a highlight completely
   */
  removeHighlight(highlightId: string): void {
    this.removeMarkFromDom(highlightId);
    this.renderedHighlights.delete(highlightId);
    this.highlights.delete(highlightId);
    // Normalize only the affected area, not entire body
  }

  /**
   * Add a new highlight
   */
  addHighlight(highlight: InlineHighlight): void {
    this.highlights.set(highlight.id, highlight);
    if (this.loadedChapters.has(highlight.spineIndex)) {
      this.applyHighlightsForChapter(highlight.spineIndex);
    }
  }

  /**
   * Update highlight color
   */
  updateHighlightColor(highlightId: string, color: HighlightColor): void {
    const colorValue = HIGHLIGHT_COLORS[color] || HIGHLIGHT_COLORS.yellow;
    const marks = this.doc.querySelectorAll(`mark[data-highlight-id="${highlightId}"]`);
    for (const mark of marks) {
      (mark as HTMLElement).style.backgroundColor = colorValue;
    }
    const h = this.highlights.get(highlightId);
    if (h) h.color = color;
  }

  /**
   * Check if a highlight is already rendered
   */
  isRendered(highlightId: string): boolean {
    return this.renderedHighlights.has(highlightId);
  }

  /**
   * Set click callback
   */
  setOnHighlightClick(callback: InlineHighlightClickCallback): void {
    this.onHighlightClick = callback;
  }

  /**
   * Destroy - remove all marks
   */
  destroy(): void {
    for (const id of this.renderedHighlights) {
      this.removeMarkFromDom(id);
    }
    this.renderedHighlights.clear();
    this.highlights.clear();
  }
}

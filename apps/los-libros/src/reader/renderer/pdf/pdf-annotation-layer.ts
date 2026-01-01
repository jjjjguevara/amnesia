/**
 * PDF Annotation Layer
 *
 * SVG-based overlay for rendering highlights on top of PDF pages.
 * Uses normalized coordinates (0-1) for resolution independence.
 */

import type { HighlightColor } from '../types';
import type { PdfRect, RenderedDocumentHighlight } from '../document-renderer';

/**
 * Color values for highlights
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
 * Highlight click callback
 */
export type PdfHighlightClickCallback = (
  annotationId: string,
  position: { x: number; y: number }
) => void;

/**
 * PDF highlight with page and rect information
 */
export interface PdfHighlight {
  id: string;
  annotationId: string;
  color: HighlightColor;
  page: number;
  rects: PdfRect[];
}

export interface AnnotationLayerConfig {
  /** Show annotation layer for debugging */
  debug?: boolean;
}

/**
 * SVG Annotation Layer for PDF highlights
 */
export class PdfAnnotationLayer {
  private container: HTMLDivElement;
  private svg: SVGSVGElement;
  private highlightGroup: SVGGElement;
  private config: AnnotationLayerConfig;

  // Highlights for current page
  private highlights: Map<string, PdfHighlight> = new Map();
  private currentPage = 0;
  private displayWidth = 0;
  private displayHeight = 0;

  // Callbacks
  private onHighlightClick?: PdfHighlightClickCallback;

  constructor(parent: HTMLElement, config?: AnnotationLayerConfig) {
    this.config = config ?? {};

    this.container = document.createElement('div');
    this.container.className = 'pdf-annotation-layer-container';
    this.container.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      pointer-events: none;
    `;

    this.svg = this.createSvgOverlay();
    this.highlightGroup = this.createHighlightGroup();

    this.container.appendChild(this.svg);
    parent.appendChild(this.container);

    this.setupEventHandlers();
  }

  /**
   * Create SVG overlay element
   */
  private createSvgOverlay(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: visible;
    `;
    svg.setAttribute('class', 'pdf-annotation-overlay');

    // Create defs for filters
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

    // Blend mode filter for better highlight appearance
    const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', 'pdf-highlight-blend');
    filter.innerHTML = `
      <feBlend mode="multiply" in="SourceGraphic"/>
    `;
    defs.appendChild(filter);

    svg.appendChild(defs);

    return svg;
  }

  /**
   * Create highlight group
   */
  private createHighlightGroup(): SVGGElement {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'pdf-highlight-group');
    this.svg.appendChild(group);
    return group;
  }

  /**
   * Set up event handlers
   */
  private setupEventHandlers(): void {
    this.svg.addEventListener('click', (e) => {
      const target = e.target as Element;
      const group = target.closest('g[data-annotation-id]');

      if (group && this.onHighlightClick) {
        const annotationId = group.getAttribute('data-annotation-id');
        if (annotationId) {
          this.onHighlightClick(annotationId, { x: e.clientX, y: e.clientY });
        }
      }
    });
  }

  /**
   * Update display dimensions
   */
  setDimensions(width: number, height: number): void {
    this.displayWidth = width;
    this.displayHeight = height;
    this.refresh();
  }

  /**
   * Set current page and refresh highlights
   */
  setPage(page: number): void {
    this.currentPage = page;
    this.refresh();
  }

  /**
   * Set all highlights (filters to current page)
   */
  setHighlights(highlights: PdfHighlight[]): void {
    this.highlights.clear();
    for (const highlight of highlights) {
      this.highlights.set(highlight.id, highlight);
    }
    this.refresh();
  }

  /**
   * Add a single highlight
   */
  addHighlight(highlight: PdfHighlight): void {
    this.highlights.set(highlight.id, highlight);
    if (highlight.page === this.currentPage) {
      this.renderHighlight(highlight);
    }
  }

  /**
   * Remove a highlight
   */
  removeHighlight(highlightId: string): void {
    this.highlights.delete(highlightId);
    const group = this.highlightGroup.querySelector(
      `g[data-highlight-id="${highlightId}"]`
    );
    group?.remove();
  }

  /**
   * Update a highlight's color
   */
  updateHighlightColor(highlightId: string, color: HighlightColor): void {
    const highlight = this.highlights.get(highlightId);
    if (highlight) {
      highlight.color = color;
      this.removeHighlight(highlightId);
      this.highlights.set(highlightId, highlight);
      if (highlight.page === this.currentPage) {
        this.renderHighlight(highlight);
      }
    }
  }

  /**
   * Clear all highlights from display
   */
  clear(): void {
    const groups = this.highlightGroup.querySelectorAll('g[data-highlight-id]');
    groups.forEach((g) => g.remove());
  }

  /**
   * Refresh display - re-render highlights for current page
   */
  refresh(): void {
    this.clear();

    for (const highlight of this.highlights.values()) {
      if (highlight.page === this.currentPage) {
        this.renderHighlight(highlight);
      }
    }
  }

  /**
   * Render a single highlight
   */
  private renderHighlight(highlight: PdfHighlight): void {
    if (!this.displayWidth || !this.displayHeight) return;

    const color = HIGHLIGHT_COLORS[highlight.color] ?? HIGHLIGHT_COLORS.yellow;

    // Create group for highlight rects
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('data-highlight-id', highlight.id);
    group.setAttribute('data-annotation-id', highlight.annotationId);
    group.style.pointerEvents = 'all';
    group.style.cursor = 'pointer';

    // Convert normalized rects to display coordinates
    for (const rect of highlight.rects) {
      const displayRect = this.normalizedToDisplay(rect);

      const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rectEl.setAttribute('x', String(displayRect.x));
      rectEl.setAttribute('y', String(displayRect.y));
      rectEl.setAttribute('width', String(displayRect.width));
      rectEl.setAttribute('height', String(displayRect.height));
      rectEl.setAttribute('fill', color);
      rectEl.setAttribute('rx', '2');
      rectEl.setAttribute('ry', '2');
      group.appendChild(rectEl);
    }

    this.highlightGroup.appendChild(group);
  }

  /**
   * Convert normalized rect (0-1) to display coordinates
   */
  private normalizedToDisplay(rect: PdfRect): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    return {
      x: rect.x * this.displayWidth,
      y: rect.y * this.displayHeight,
      width: rect.width * this.displayWidth,
      height: rect.height * this.displayHeight,
    };
  }

  /**
   * Convert display coordinates to normalized rect (0-1)
   */
  displayToNormalized(
    x: number,
    y: number,
    width: number,
    height: number
  ): PdfRect {
    return {
      x: x / this.displayWidth,
      y: y / this.displayHeight,
      width: width / this.displayWidth,
      height: height / this.displayHeight,
    };
  }

  /**
   * Get highlight at position
   */
  getHighlightAt(x: number, y: number): string | null {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;

    const group = element.closest('g[data-annotation-id]');
    return group?.getAttribute('data-annotation-id') ?? null;
  }

  /**
   * Set highlight click callback
   */
  setOnHighlightClick(callback: PdfHighlightClickCallback): void {
    this.onHighlightClick = callback;
  }

  /**
   * Get container element
   */
  getContainer(): HTMLDivElement {
    return this.container;
  }

  /**
   * Get highlights for current page
   */
  getHighlightsForPage(page: number): PdfHighlight[] {
    return Array.from(this.highlights.values()).filter((h) => h.page === page);
  }

  /**
   * Convert document highlights to PDF highlights
   */
  static fromDocumentHighlights(
    highlights: RenderedDocumentHighlight[],
    page: number
  ): PdfHighlight[] {
    return highlights
      .filter((h) => {
        // Check if this highlight is for the specified page
        if (h.selector.format !== 'pdf') return false;
        const pdfSelector = h.selector;
        return pdfSelector.page === page;
      })
      .map((h) => ({
        id: h.id,
        annotationId: h.annotationId,
        color: h.color,
        page,
        rects: h.selector.format === 'pdf' && h.selector.rect ? [h.selector.rect] : [],
      }));
  }

  /**
   * Destroy the layer
   */
  destroy(): void {
    this.highlights.clear();
    this.container.remove();
  }
}

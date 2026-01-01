/**
 * Highlight Overlay
 *
 * SVG-based overlay for rendering highlights on top of EPUB content.
 * Handles coordinate transformation between iframe and container.
 */

import type { RenderedHighlight, HighlightColor, AnchoredHighlight } from './types';

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
export type HighlightClickCallback = (annotationId: string, position: { x: number; y: number }) => void;

/**
 * SVG Highlight Overlay Manager
 */
/**
 * Union type for highlights - supports both legacy and new anchored highlights
 */
type OverlayHighlight = RenderedHighlight | AnchoredHighlight;

export class HighlightOverlay {
  private container: HTMLElement;
  private iframe: HTMLIFrameElement;
  private svg: SVGSVGElement;
  private highlightGroup: SVGGElement; // Group that receives transforms
  private highlights: Map<string, OverlayHighlight> = new Map();
  private onHighlightClick?: HighlightClickCallback;
  private transformObserver: MutationObserver | null = null;
  private contentContainer: HTMLElement | null = null;

  // Track whether we're using pre-computed rects (from re-anchoring)
  private usingPrecomputedRects = false;

  constructor(
    container: HTMLElement,
    iframe: HTMLIFrameElement,
    onHighlightClick?: HighlightClickCallback
  ) {
    this.container = container;
    this.iframe = iframe;
    this.onHighlightClick = onHighlightClick;

    this.svg = this.createSvgOverlay();
    this.highlightGroup = this.createHighlightGroup();
    this.setupEventHandlers();
  }

  /**
   * Create SVG overlay element
   */
  private createSvgOverlay(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: visible;
    `;
    svg.setAttribute('class', 'highlight-overlay');

    // Create defs for filters/gradients
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

    // Blend mode filter for better highlight appearance
    const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', 'highlight-blend');
    filter.innerHTML = `
      <feBlend mode="multiply" in="SourceGraphic"/>
    `;
    defs.appendChild(filter);

    svg.appendChild(defs);
    this.container.appendChild(svg);

    return svg;
  }

  /**
   * Create a group element that will hold all highlights
   * This group receives transforms to move highlights with content
   */
  private createHighlightGroup(): SVGGElement {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'highlight-transform-group');
    // Use will-change for GPU acceleration during transforms
    group.style.willChange = 'transform';
    this.svg.appendChild(group);
    return group;
  }

  /**
   * Start observing a content container for transform changes
   * This syncs the highlight overlay with paginated content animations
   */
  observeContentTransform(contentContainer: HTMLElement): void {
    this.contentContainer = contentContainer;

    // Stop any existing observer
    this.transformObserver?.disconnect();

    // Sync initial transform
    this.syncTransform();

    // Observe style changes on the content container
    this.transformObserver = new MutationObserver(() => {
      this.syncTransform();
    });

    this.transformObserver.observe(contentContainer, {
      attributes: true,
      attributeFilter: ['style'],
    });

    // Also use requestAnimationFrame for smoother sync during animations
    this.startAnimationSync();
  }

  /**
   * Start animation frame sync for smooth transform updates
   */
  private animationFrameId: number | null = null;
  private startAnimationSync(): void {
    const sync = () => {
      if (this.contentContainer) {
        this.syncTransform();
        this.animationFrameId = requestAnimationFrame(sync);
      }
    };
    this.animationFrameId = requestAnimationFrame(sync);
  }

  /**
   * Stop animation frame sync
   */
  private stopAnimationSync(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Sync the highlight group transform with the content container
   * Uses getComputedStyle to get the current animated value during CSS transitions
   */
  private syncTransform(): void {
    if (!this.contentContainer) return;

    // Use getComputedStyle to get the CURRENT animated transform value
    // This handles CSS transitions where style.transform is the final value
    // but the visual is still animating
    const computedStyle = getComputedStyle(this.contentContainer);
    const transform = computedStyle.transform;

    if (transform && transform !== 'none') {
      this.highlightGroup.style.transform = transform;
    } else {
      this.highlightGroup.style.transform = '';
    }
  }

  /**
   * Update overlay for scroll position (scrolled mode)
   * Stops any animation sync to prevent conflicts
   */
  updateScrollPosition(scrollTop: number): void {
    // Stop animation sync if active - scroll mode uses direct updates
    this.stopAnimationSync();
    this.contentContainer = null; // Prevent syncTransform from running
    this.highlightGroup.style.transform = `translateY(-${scrollTop}px)`;
  }

  /**
   * Set up event handlers for highlight interaction
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
   * Set highlights to render
   * Accepts either legacy RenderedHighlight[] or new AnchoredHighlight[]
   * When AnchoredHighlight is provided, rects are already in viewport coordinates
   */
  setHighlights(highlights: OverlayHighlight[]): void {
    // Clear existing highlights
    this.clearHighlights();

    // Detect if using pre-computed rects (AnchoredHighlight has 'status' field)
    this.usingPrecomputedRects = highlights.length > 0 && 'status' in highlights[0];

    // Add new highlights
    for (const highlight of highlights) {
      this.highlights.set(highlight.id, highlight);
      this.renderHighlight(highlight);
    }
  }

  /**
   * Add a single highlight
   */
  addHighlight(highlight: RenderedHighlight): void {
    this.highlights.set(highlight.id, highlight);
    this.renderHighlight(highlight);
  }

  /**
   * Remove a highlight
   */
  removeHighlight(highlightId: string): void {
    this.highlights.delete(highlightId);
    const group = this.highlightGroup.querySelector(`g[data-highlight-id="${highlightId}"]`);
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
      this.renderHighlight(highlight);
    }
  }

  /**
   * Clear all highlights
   */
  clearHighlights(): void {
    // Remove all highlight groups from the transform group
    const groups = this.highlightGroup.querySelectorAll('g[data-highlight-id]');
    groups.forEach((g) => g.remove());
    this.highlights.clear();
  }

  /**
   * Render a single highlight
   */
  private renderHighlight(highlight: OverlayHighlight): void {
    const color = HIGHLIGHT_COLORS[highlight.color] ?? HIGHLIGHT_COLORS.yellow;

    // Create group for highlight rects
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('data-highlight-id', highlight.id);
    group.setAttribute('data-annotation-id', highlight.annotationId);
    group.style.pointerEvents = 'all';
    group.style.cursor = 'pointer';

    // Use rects directly if pre-computed (AnchoredHighlight), otherwise transform
    // Pre-computed rects are already in container-relative coordinates
    const rects = this.usingPrecomputedRects
      ? highlight.rects
      : this.transformRects(highlight.rects);

    // Create rect elements
    for (const rect of rects) {
      const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rectEl.setAttribute('x', String(rect.x));
      rectEl.setAttribute('y', String(rect.y));
      rectEl.setAttribute('width', String(rect.width));
      rectEl.setAttribute('height', String(rect.height));
      rectEl.setAttribute('fill', color);
      rectEl.setAttribute('rx', '2');
      rectEl.setAttribute('ry', '2');
      group.appendChild(rectEl);
    }

    // Append to the transform group so highlights move with content
    this.highlightGroup.appendChild(group);
  }

  /**
   * Transform rects from iframe document coordinates to overlay coordinates
   */
  private transformRects(rects: DOMRect[]): DOMRect[] {
    const iframeRect = this.iframe.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();

    const offsetX = iframeRect.left - containerRect.left;
    const offsetY = iframeRect.top - containerRect.top;

    return rects.map((rect) => {
      return new DOMRect(
        rect.x + offsetX,
        rect.y + offsetY,
        rect.width,
        rect.height
      );
    });
  }

  /**
   * Handle container resize - re-render highlights
   * When using pre-computed rects (from re-anchoring), this is a no-op
   * since the renderer's reanchorHighlights() handles the update
   */
  handleResize(): void {
    // If using pre-computed rects, renderer handles re-anchoring
    // This becomes a no-op to avoid double work
    if (this.usingPrecomputedRects) {
      return;
    }

    // Legacy mode: re-render all highlights with new coordinates
    const currentHighlights = Array.from(this.highlights.values());
    this.clearHighlights();

    for (const highlight of currentHighlights) {
      this.highlights.set(highlight.id, highlight);
      this.renderHighlight(highlight);
    }
  }

  /**
   * Get highlight at a position
   */
  getHighlightAt(x: number, y: number): string | null {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;

    const group = element.closest('g[data-annotation-id]');
    return group?.getAttribute('data-annotation-id') ?? null;
  }

  /**
   * Create highlight rects from a selection range
   */
  static getRectsFromRange(range: Range): DOMRect[] {
    const rects = range.getClientRects();
    const result: DOMRect[] = [];

    // Merge adjacent rects on same line
    let currentRect: DOMRect | null = null;

    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];

      // Skip empty rects
      if (rect.width < 1 || rect.height < 1) continue;

      if (currentRect && Math.abs(currentRect.top - rect.top) < 2) {
        // Same line - extend current rect
        const newRight = Math.max(currentRect.right, rect.right);
        const newLeft = Math.min(currentRect.left, rect.left);
        currentRect = new DOMRect(
          newLeft,
          currentRect.top,
          newRight - newLeft,
          currentRect.height
        );
      } else {
        // New line
        if (currentRect) {
          result.push(currentRect);
        }
        currentRect = rect;
      }
    }

    if (currentRect) {
      result.push(currentRect);
    }

    return result;
  }

  /**
   * Set callback for highlight clicks
   */
  setOnHighlightClick(callback: HighlightClickCallback): void {
    this.onHighlightClick = callback;
  }

  /**
   * Show or hide the overlay
   * Used to hide during page turn animations to prevent visual drift
   */
  setVisible(visible: boolean): void {
    this.svg.style.visibility = visible ? 'visible' : 'hidden';
  }

  /**
   * Stop observing content transforms
   */
  stopObservingTransform(): void {
    this.transformObserver?.disconnect();
    this.transformObserver = null;
    this.stopAnimationSync();
    this.contentContainer = null;
    // Clear any existing transform - highlights now use viewport coordinates
    this.highlightGroup.style.transform = '';
  }

  /**
   * Destroy the overlay
   */
  destroy(): void {
    this.stopObservingTransform();
    this.svg.remove();
    this.highlights.clear();
  }
}

/**
 * PDF Multi-Page Container
 *
 * Manages rendering and layout of multiple PDF pages.
 * Supports paginated mode (single/dual/auto pages per view) and
 * scrolled mode (vertical/horizontal continuous scrolling).
 */

import { PdfPageElement, type PageRenderData, type PageHighlight, type ReadingMode } from './pdf-page-element';
import { calculateOptimalLayout, type LayoutResult, type LayoutMode } from './pdf-layout-calculator';
import { getCanvasPool } from './pdf-canvas-pool';
import { getDevicePixelRatio } from './dpr-utils';
import type { PdfTextLayer as TextLayerData, PdfRenderOptions } from '../types';

export type DisplayMode = 'paginated' | 'scrolled';
export type ScrollDirection = 'vertical' | 'horizontal';

export interface MultiPageConfig {
  /** Display mode */
  displayMode: DisplayMode;
  /** Scroll direction for scrolled mode */
  scrollDirection: ScrollDirection;
  /** Page layout mode for paginated mode */
  pageLayout: LayoutMode;
  /** Current scale (used for rendering quality, not layout in auto mode) */
  scale: number;
  /** User-specified zoom scale (overrides auto-fit when set) */
  userZoom?: number;
  /** Gap between pages */
  gap: number;
  /** Padding around content */
  padding: number;
  /** Pixel ratio for HiDPI */
  pixelRatio?: number;
  /** Maximum zoom level used to cap scale tier */
  maxZoom?: number;
  /** Enable text anti-aliasing */
  enableTextAntialiasing?: boolean;
  /** Enable image smoothing */
  enableImageSmoothing?: boolean;
  /** Reading mode / theme (light, sepia, night) */
  readingMode?: ReadingMode;
}

export interface PageDataProvider {
  getPageImage(page: number, options: PdfRenderOptions): Promise<Blob>;
  getPageTextLayer(page: number): Promise<TextLayerData>;
}

interface VisiblePageRange {
  start: number;
  end: number;
}

/**
 * Container for multi-page PDF display
 */
export class PdfMultiPageContainer {
  private container: HTMLElement;
  private scrollContainer: HTMLDivElement;
  private pagesContainer: HTMLDivElement;
  private config: MultiPageConfig;
  private provider: PageDataProvider;

  // Page state
  private pageCount = 0;
  private currentPage = 1;
  private pageElements: Map<number, PdfPageElement> = new Map();
  private currentLayout: LayoutResult | null = null;

  // PDF dimensions (default US Letter at 72 DPI)
  private pageWidth = 612;
  private pageHeight = 792;

  // Virtualization - increased buffer for smoother scrolling
  private readonly BASE_VIRTUALIZATION_BUFFER = 7; // Pages to render outside viewport at 100% zoom
  private readonly PAGE_CACHE_SIZE = 150; // Max number of page images to cache (increased for zoom out)
  private readonly KEEP_BUFFER_MULTIPLIER = 3; // How many times the virtualization buffer to keep in DOM
  private visibleRange: VisiblePageRange = { start: 1, end: 1 };
  private isScrolling = false;
  private scrollTimeout: number | null = null;
  private renderTimeout: number | null = null;

  // Image cache to avoid re-fetching pages
  private pageImageCache: Map<number, Blob> = new Map();
  private cacheOrder: number[] = []; // LRU tracking

  // Request deduplication - prevents duplicate concurrent requests for same page
  private pendingImageRequests: Map<number, Promise<Blob>> = new Map();

  // Callbacks
  private onPageChangeCallback?: (page: number) => void;
  private onSelectionCallback?: (page: number, text: string, rects: DOMRect[]) => void;
  private onHighlightClickCallback?: (annotationId: string, position: { x: number; y: number }) => void;

  // Paginated mode scroll dampening
  private wheelAccumulator = 0;
  private readonly WHEEL_THRESHOLD = 150; // Accumulated delta needed to trigger page turn
  private wheelResetTimeout: number | null = null;
  private isNavigating = false; // Prevent rapid navigation

  // Zoom debouncing and render cancellation
  private zoomDebounceTimeout: number | null = null;
  private renderVersion = 0; // Incremented on each zoom/layout change to cancel stale renders
  private isZooming = false; // Track if we're in a zoom operation

  constructor(
    container: HTMLElement,
    provider: PageDataProvider,
    config: Partial<MultiPageConfig> = {}
  ) {
    this.container = container;
    this.provider = provider;
    this.config = {
      displayMode: config.displayMode ?? 'paginated',
      scrollDirection: config.scrollDirection ?? 'vertical',
      pageLayout: config.pageLayout ?? 'auto',
      scale: config.scale ?? 1.5,
      gap: config.gap ?? 20,
      padding: config.padding ?? 20,
      pixelRatio: config.pixelRatio ?? getDevicePixelRatio(),
      enableTextAntialiasing: config.enableTextAntialiasing ?? true,
      enableImageSmoothing: config.enableImageSmoothing ?? true,
      readingMode: config.readingMode ?? 'device',
    };

    // Create scroll container
    this.scrollContainer = document.createElement('div');
    this.scrollContainer.className = 'pdf-scroll-container';
    this.updateScrollContainerStyles();
    this.container.appendChild(this.scrollContainer);

    // Create pages container
    this.pagesContainer = document.createElement('div');
    this.pagesContainer.className = 'pdf-pages-container';
    this.updatePagesContainerStyles();
    this.scrollContainer.appendChild(this.pagesContainer);

    // Setup scroll listener
    this.setupScrollListener();

    // Setup wheel listener for paginated mode dampening
    this.setupWheelListener();
  }

  /**
   * Initialize with page count
   */
  initialize(pageCount: number): void {
    this.pageCount = pageCount;
    this.calculateLayout();
    this.updatePagesContainerSize();
  }

  /**
   * Get current page
   */
  getCurrentPage(): number {
    return this.currentPage;
  }

  /**
   * Get page count
   */
  getPageCount(): number {
    return this.pageCount;
  }

  /**
   * Calculate optimal layout
   */
  private calculateLayout(): void {
    const containerRect = this.container.getBoundingClientRect();

    // Only pass userScale if user has explicitly zoomed
    // Otherwise, auto-fit to show as many pages as possible
    const userScale = this.config.userZoom;

    this.currentLayout = calculateOptimalLayout({
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
      pageWidth: this.pageWidth,
      pageHeight: this.pageHeight,
      gap: this.config.gap,
      padding: this.config.padding,
      minScale: 0.25,
      maxScale: 5.0,
      layoutMode: this.config.pageLayout,
      userScale: userScale,
    });

    // Update the scale config to match the layout result (for rendering quality)
    if (this.currentLayout && !userScale) {
      this.config.scale = this.currentLayout.scale;
    }
  }

  /**
   * Update scroll container styles based on mode
   */
  private updateScrollContainerStyles(): void {
    const isScrolled = this.config.displayMode === 'scrolled';

    this.scrollContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      overflow: ${isScrolled ? 'auto' : 'hidden'};
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      touch-action: ${isScrolled ? 'pan-x pan-y pinch-zoom' : 'pinch-zoom'};
    `;
  }

  /**
   * Update pages container styles based on mode
   * Ensures content is always centered in the viewport
   */
  private updatePagesContainerStyles(): void {
    const isScrolled = this.config.displayMode === 'scrolled';

    if (isScrolled) {
      // Scrolled mode: flexbox for centering with scrollable content
      const isHorizontal = this.config.scrollDirection === 'horizontal';

      if (isHorizontal) {
        // Horizontal scroll: pages in a row, centered vertically
        this.pagesContainer.style.cssText = `
          position: relative;
          display: flex;
          flex-direction: row;
          flex-wrap: wrap;
          justify-content: center;
          align-items: flex-start;
          align-content: flex-start;
          gap: ${this.config.gap}px;
          padding: ${this.config.padding}px;
          box-sizing: border-box;
          min-width: 100%;
          min-height: 100%;
        `;
      } else {
        // Vertical scroll: pages wrap into rows, centered
        this.pagesContainer.style.cssText = `
          position: relative;
          display: flex;
          flex-direction: row;
          flex-wrap: wrap;
          justify-content: center;
          align-items: flex-start;
          align-content: flex-start;
          gap: ${this.config.gap}px;
          padding: ${this.config.padding}px;
          box-sizing: border-box;
          min-width: 100%;
        `;
      }
    } else {
      // Paginated mode: flexbox for centering
      this.pagesContainer.style.cssText = `
        position: relative;
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: ${this.config.gap}px;
        padding: ${this.config.padding}px;
        min-height: 100%;
        min-width: 100%;
        box-sizing: border-box;
      `;
    }
  }

  /**
   * Update pages container size based on layout
   */
  private updatePagesContainerSize(): void {
    if (!this.currentLayout) return;

    const { pageDisplayWidth, pageDisplayHeight } = this.currentLayout;
    const gap = this.config.gap;
    const padding = this.config.padding;

    if (this.config.displayMode === 'scrolled') {
      const isVertical = this.config.scrollDirection === 'vertical';

      if (isVertical) {
        // Vertical scroll: single column of pages stacked vertically
        const totalHeight = this.pageCount * pageDisplayHeight + (this.pageCount - 1) * gap + padding * 2;
        this.pagesContainer.style.width = '100%';
        this.pagesContainer.style.minHeight = `${totalHeight}px`;
        this.pagesContainer.style.height = '';
        this.pagesContainer.style.minWidth = '';
      } else {
        // Horizontal scroll: single row of all pages
        const totalWidth = this.pageCount * pageDisplayWidth + (this.pageCount - 1) * gap + padding * 2;
        this.pagesContainer.style.width = `${totalWidth}px`;
        this.pagesContainer.style.height = '100%';
        this.pagesContainer.style.minHeight = '';
        this.pagesContainer.style.minWidth = '';
      }
    } else {
      // Paginated: fit to container
      this.pagesContainer.style.width = '100%';
      this.pagesContainer.style.height = '100%';
      this.pagesContainer.style.minWidth = '';
      this.pagesContainer.style.minHeight = '';
    }

  }

  /**
   * Set zoom level - recalculates layout to show appropriate number of pages
   * This is proper canvas-style zoom where pages resize and count changes dynamically
   * Uses debouncing to prevent rapid re-renders during smooth zoom gestures
   */
  setZoom(scale: number): void {
    const clampedScale = Math.max(0.25, Math.min(5.0, scale));

    // Update userZoom which triggers layout recalculation
    this.config.userZoom = clampedScale;
    this.config.scale = clampedScale;

    // Mark that we're zooming to prevent page removal during zoom
    this.isZooming = true;

    // Increment render version to invalidate any in-progress renders
    this.renderVersion++;

    // Recalculate layout with new scale
    this.calculateLayout();
    this.updatePagesContainerSize();
    this.updatePagesContainerStyles();

    // Resize all existing page elements to new dimensions immediately (visual feedback)
    if (this.currentLayout) {
      const { pageDisplayWidth, pageDisplayHeight } = this.currentLayout;
      for (const [page, element] of this.pageElements) {
        element.setDimensions(pageDisplayWidth, pageDisplayHeight);
      }
    }

    // Debounce the expensive render operation
    if (this.zoomDebounceTimeout) {
      clearTimeout(this.zoomDebounceTimeout);
    }

    this.zoomDebounceTimeout = window.setTimeout(() => {
      this.isZooming = false;
      this.zoomDebounceTimeout = null;
      this.renderVisiblePages();
    }, 150); // Wait 150ms after last zoom change before rendering
  }

  /**
   * Get current zoom level
   */
  getZoom(): number {
    return this.config.userZoom ?? this.config.scale;
  }

  /**
   * Reset zoom to auto-fit
   */
  resetZoom(): void {
    this.config.userZoom = undefined;
    this.calculateLayout();
    this.updatePagesContainerSize();
    this.updatePagesContainerStyles();
    this.renderVisiblePages();
  }

  /**
   * Setup scroll listener for virtualization
   */
  private setupScrollListener(): void {
    let rafPending = false;

    this.scrollContainer.addEventListener('scroll', () => {
      if (this.config.displayMode !== 'scrolled') return;

      this.isScrolling = true;

      // Use requestAnimationFrame to batch scroll updates
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          this.updateCurrentPageFromScroll();
          this.updateVisiblePages();
        });
      }

      // Debounce the expensive render operation
      if (this.scrollTimeout) {
        clearTimeout(this.scrollTimeout);
      }
      this.scrollTimeout = window.setTimeout(() => {
        this.isScrolling = false;
        this.renderVisiblePages();
      }, 150); // Longer debounce for rendering
    });
  }

  /**
   * Setup wheel listener for paginated mode with dampening
   * Prevents over-sensitive scroll gestures from causing multiple page turns
   */
  private setupWheelListener(): void {
    this.scrollContainer.addEventListener('wheel', (e) => {
      // Only handle in paginated mode
      if (this.config.displayMode !== 'paginated') return;

      // Don't handle if it's a zoom gesture (Ctrl/Cmd+wheel)
      if (e.ctrlKey || e.metaKey) return;

      e.preventDefault();
      e.stopPropagation();

      // If already navigating, ignore input
      if (this.isNavigating) return;

      // Accumulate wheel delta with dampening
      // Use deltaY for vertical scrolling, deltaX for horizontal
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;

      // Apply dampening factor
      const dampenedDelta = delta * 0.5;
      this.wheelAccumulator += dampenedDelta;

      // Reset accumulator after a pause in scrolling
      if (this.wheelResetTimeout) {
        clearTimeout(this.wheelResetTimeout);
      }
      this.wheelResetTimeout = window.setTimeout(() => {
        this.wheelAccumulator = 0;
      }, 200);

      // Check if accumulated delta exceeds threshold
      if (Math.abs(this.wheelAccumulator) >= this.WHEEL_THRESHOLD) {
        const direction = this.wheelAccumulator > 0 ? 1 : -1;

        // Reset accumulator before navigation
        this.wheelAccumulator = 0;

        // Set navigating flag to prevent rapid consecutive navigation
        this.isNavigating = true;

        // Navigate with a cooldown
        if (direction > 0) {
          this.next();
        } else {
          this.prev();
        }

        // Allow next navigation after animation completes
        setTimeout(() => {
          this.isNavigating = false;
        }, 300); // Match page turn animation duration
      }
    }, { passive: false });
  }

  /**
   * Update current page based on scroll position
   */
  private updateCurrentPageFromScroll(): void {
    if (!this.currentLayout) return;

    const { pageDisplayWidth, pageDisplayHeight, pagesPerRow } = this.currentLayout;
    const gap = this.config.gap;
    const padding = this.config.padding;

    let newPage: number;

    if (this.config.scrollDirection === 'vertical') {
      const scrollTop = this.scrollContainer.scrollTop;
      const rowHeight = pageDisplayHeight + gap;
      const row = Math.floor((scrollTop - padding + rowHeight / 2) / rowHeight);
      newPage = Math.max(1, Math.min(row * pagesPerRow + 1, this.pageCount));
    } else {
      const scrollLeft = this.scrollContainer.scrollLeft;
      const pageWidth = pageDisplayWidth + gap;
      newPage = Math.max(1, Math.min(Math.floor((scrollLeft - padding + pageWidth / 2) / pageWidth) + 1, this.pageCount));
    }

    if (newPage !== this.currentPage) {
      this.currentPage = newPage;
      if (this.onPageChangeCallback) {
        this.onPageChangeCallback(this.currentPage);
      }
    }
  }

  /**
   * Get dynamic virtualization buffer based on current zoom level
   * When zoomed out, more pages are visible so we need a larger buffer
   */
  private getVirtualizationBuffer(): number {
    if (!this.currentLayout) return this.BASE_VIRTUALIZATION_BUFFER;

    const scale = this.currentLayout.scale;
    // At 100% zoom, use base buffer
    // At 50% zoom, use 2x buffer
    // At 25% zoom, use 4x buffer
    const zoomMultiplier = Math.max(1, 1 / scale);
    return Math.ceil(this.BASE_VIRTUALIZATION_BUFFER * zoomMultiplier);
  }

  /**
   * Calculate visible page range
   */
  private updateVisiblePages(): void {
    if (!this.currentLayout) return;

    const { pageDisplayWidth, pageDisplayHeight, pagesPerRow } = this.currentLayout;
    const gap = this.config.gap;
    const padding = this.config.padding;
    const virtualizationBuffer = this.getVirtualizationBuffer();

    const viewportWidth = this.scrollContainer.clientWidth;
    const viewportHeight = this.scrollContainer.clientHeight;
    const scrollLeft = this.scrollContainer.scrollLeft;
    const scrollTop = this.scrollContainer.scrollTop;

    let startPage: number;
    let endPage: number;

    if (this.config.displayMode === 'scrolled') {
      if (this.config.scrollDirection === 'vertical') {
        const rowHeight = pageDisplayHeight + gap;
        const startRow = Math.floor((scrollTop - padding) / rowHeight);
        const endRow = Math.ceil((scrollTop + viewportHeight - padding) / rowHeight);

        startPage = Math.max(1, startRow * pagesPerRow + 1 - virtualizationBuffer * pagesPerRow);
        endPage = Math.min(this.pageCount, (endRow + 1) * pagesPerRow + virtualizationBuffer * pagesPerRow);
      } else {
        const pageWidth = pageDisplayWidth + gap;
        startPage = Math.max(1, Math.floor((scrollLeft - padding) / pageWidth) + 1 - virtualizationBuffer);
        endPage = Math.min(this.pageCount, Math.ceil((scrollLeft + viewportWidth - padding) / pageWidth) + virtualizationBuffer);
      }
    } else {
      // Paginated mode: show current page(s)
      startPage = this.currentPage;
      endPage = Math.min(this.currentPage + pagesPerRow - 1, this.pageCount);
    }

    this.visibleRange = { start: startPage, end: endPage };
  }

  /**
   * Render visible pages
   * Uses render versioning to cancel stale renders when zoom/layout changes
   */
  async renderVisiblePages(): Promise<void> {
    // Capture current render version - if it changes during render, we should abort
    const currentRenderVersion = this.renderVersion;

    this.updateVisiblePages();

    const { start, end } = this.visibleRange;
    const pagesToRender: number[] = [];
    const virtualizationBuffer = this.getVirtualizationBuffer();

    for (let page = start; page <= end; page++) {
      if (!this.pageElements.has(page) || !this.pageElements.get(page)!.getIsRendered()) {
        pagesToRender.push(page);
      }
    }

    // Use a larger buffer for keeping pages in DOM
    // This prevents pages from being destroyed and recreated during scroll/zoom
    const keepBuffer = virtualizationBuffer * this.KEEP_BUFFER_MULTIPLIER;

    // Only remove pages if we're not actively scrolling or zooming
    // This prevents visual glitches during fast scroll/zoom
    if (!this.isScrolling && !this.isZooming) {
      // Remove pages outside keep range (but images stay cached)
      // Be more conservative about removing pages to prevent visual glitches
      for (const [page, element] of this.pageElements) {
        if (page < start - keepBuffer || page > end + keepBuffer) {
          element.destroy();
          this.pageElements.delete(page);
        }
      }
    }

    // Render new pages in parallel, but limit concurrent requests
    // Prioritize pages closest to current viewport
    const sortedPagesToRender = pagesToRender.sort((a, b) => {
      const midPage = (start + end) / 2;
      return Math.abs(a - midPage) - Math.abs(b - midPage);
    });

    // Scale concurrent renders with worker pool (2x workers, capped at 12)
    const pool = getCanvasPool();
    const CONCURRENT_RENDERS = Math.min(pool.workerCount * 2 || 5, 12);
    for (let i = 0; i < sortedPagesToRender.length; i += CONCURRENT_RENDERS) {
      // Check if render version changed (zoom/layout changed) - abort if stale
      if (this.renderVersion !== currentRenderVersion) {
        return; // Abort - a newer render cycle has started
      }

      const batch = sortedPagesToRender.slice(i, i + CONCURRENT_RENDERS);
      await Promise.all(batch.map((page) => this.renderPage(page, currentRenderVersion)));
    }
  }

  // Track the scale at which each cached image was rendered
  private pageCacheScales: Map<number, number> = new Map();

  /**
   * Get cached page image or fetch from server
   * Uses cached images if they have sufficient quality (rendered at same or higher scale)
   * Includes request deduplication to prevent multiple concurrent requests for the same page
   */
  private async getCachedPageImage(page: number): Promise<Blob> {
    const targetScale = this.config.scale * (this.config.pixelRatio ?? 1);

    // Check cache first
    if (this.pageImageCache.has(page)) {
      const cachedScale = this.pageCacheScales.get(page) ?? 0;

      // Use cached image if it was rendered at same or higher scale
      // This allows zooming out without re-fetching
      if (cachedScale >= targetScale * 0.8) { // Allow 20% tolerance
        // Update LRU order
        const idx = this.cacheOrder.indexOf(page);
        if (idx > -1) {
          this.cacheOrder.splice(idx, 1);
          this.cacheOrder.push(page);
        }
        return this.pageImageCache.get(page)!;
      }
      // Cached image is too low quality, need to fetch higher res
    }

    // Check for pending request (deduplication)
    const pendingRequest = this.pendingImageRequests.get(page);
    if (pendingRequest) {
      return pendingRequest;
    }

    // Fetch at appropriate scale (minimum 1.5x to avoid pixelation when zooming)
    const fetchScale = Math.max(targetScale, 1.5);

    // Create the request promise and store it for deduplication
    const requestPromise = (async () => {
      try {
        const imageBlob = await this.provider.getPageImage(page, {
          scale: fetchScale,
          dpi: 150,
          format: 'png',
        });

        // Add to cache with scale info
        this.pageImageCache.set(page, imageBlob);
        this.pageCacheScales.set(page, fetchScale);

        // Update LRU order
        const existingIdx = this.cacheOrder.indexOf(page);
        if (existingIdx > -1) {
          this.cacheOrder.splice(existingIdx, 1);
        }
        this.cacheOrder.push(page);

        // Evict oldest entries if cache is full
        while (this.cacheOrder.length > this.PAGE_CACHE_SIZE) {
          const oldestPage = this.cacheOrder.shift();
          if (oldestPage !== undefined) {
            this.pageImageCache.delete(oldestPage);
            this.pageCacheScales.delete(oldestPage);
          }
        }

        return imageBlob;
      } finally {
        // Remove from pending requests when done (success or failure)
        this.pendingImageRequests.delete(page);
      }
    })();

    // Store the pending request
    this.pendingImageRequests.set(page, requestPromise);

    return requestPromise;
  }

  /**
   * Clear the page image cache
   */
  clearImageCache(): void {
    this.pageImageCache.clear();
    this.pageCacheScales.clear();
    this.cacheOrder = [];
  }

  /**
   * Check if an error is an abort error (should be silently ignored)
   */
  private isAbortError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    const errorStr = String(error);
    return errorStr.includes('aborted') || errorStr.includes('AbortError');
  }

  /**
   * Render a single page
   * @param page Page number to render
   * @param renderVersion Version to check for staleness (optional)
   */
  private async renderPage(page: number, renderVersion?: number): Promise<void> {
    if (!this.currentLayout) return;

    // Early abort check - if render version changed, skip this render
    if (renderVersion !== undefined && this.renderVersion !== renderVersion) {
      return;
    }

    const { pageDisplayWidth, pageDisplayHeight } = this.currentLayout;

    // Get or create page element
    let pageElement = this.pageElements.get(page);
    if (!pageElement) {
      pageElement = new PdfPageElement({
        pageNumber: page,
        pixelRatio: this.config.pixelRatio,
        maxZoom: this.config.maxZoom,
        enableTextAntialiasing: this.config.enableTextAntialiasing,
        enableImageSmoothing: this.config.enableImageSmoothing,
        useSvgTextLayer: true, // Enable vector-crisp text at any zoom
      });

      // Apply reading mode
      if (this.config.readingMode) {
        pageElement.setReadingMode(this.config.readingMode);
      }

      // Wire up callbacks
      pageElement.setOnSelection((p, text, rects) => {
        if (this.onSelectionCallback) {
          this.onSelectionCallback(p, text, rects);
        }
      });

      pageElement.setOnHighlightClick((annotationId, position) => {
        if (this.onHighlightClickCallback) {
          this.onHighlightClickCallback(annotationId, position);
        }
      });

      this.pageElements.set(page, pageElement);

      // Position element
      this.positionPageElement(pageElement, page);
      this.pagesContainer.appendChild(pageElement.getElement());
    }

    // Set dimensions
    pageElement.setDimensions(pageDisplayWidth, pageDisplayHeight);

    // Don't show loading if page is already rendered (just resizing)
    if (!pageElement.getIsRendered()) {
      pageElement.showLoading();
    }

    try {
      // Check version again before expensive fetch
      if (renderVersion !== undefined && this.renderVersion !== renderVersion) {
        pageElement.hideLoading();
        return;
      }

      // Get cached or fetch page image
      const imageBlob = await this.getCachedPageImage(page);

      // Check version after fetch - layout may have changed
      if (renderVersion !== undefined && this.renderVersion !== renderVersion) {
        pageElement.hideLoading();
        return;
      }

      let textLayerData: TextLayerData | undefined;
      try {
        textLayerData = await this.provider.getPageTextLayer(page);
      } catch (error) {
        // Text layer errors are non-fatal, and abort errors should be ignored
        if (!this.isAbortError(error) && !String(error).includes('No document loaded')) {
          console.warn(`Failed to load text layer for page ${page}:`, error);
        }
      }

      // Final version check before render
      if (renderVersion !== undefined && this.renderVersion !== renderVersion) {
        pageElement.hideLoading();
        return;
      }

      // Render
      await pageElement.render({ imageBlob, textLayerData }, this.config.scale);
      pageElement.hideLoading();
    } catch (error) {
      // Silently ignore abort errors - they happen during rapid zoom/scroll
      if (this.isAbortError(error)) {
        pageElement.hideLoading();
        return;
      }

      // Suppress "No document loaded" errors during initialization/reload
      const errorStr = String(error);
      if (!errorStr.includes('No document loaded')) {
        console.error(`Failed to render page ${page}:`, error);
      }
      pageElement.hideLoading();
    }
  }

  /**
   * Position a page element based on its page number
   */
  private positionPageElement(pageElement: PdfPageElement, page: number): void {
    if (!this.currentLayout) return;

    const element = pageElement.getElement();

    // Both scrolled and paginated modes use flexbox now
    // Flexbox handles positioning and centering
    element.style.position = 'relative';
    element.style.left = '';
    element.style.top = '';
    element.style.flexShrink = '0';
    element.style.order = String(page); // Maintain page order in flexbox
  }

  /**
   * Go to a specific page
   */
  async goToPage(page: number): Promise<void> {
    page = Math.max(1, Math.min(page, this.pageCount));
    if (page === this.currentPage && this.pageElements.has(page)) return;

    this.currentPage = page;

    if (this.config.displayMode === 'scrolled') {
      // Scroll to page
      this.scrollToPage(page);
    } else {
      // Clear and render new page(s)
      await this.clearAndRenderPaginatedView();
    }

    if (this.onPageChangeCallback) {
      this.onPageChangeCallback(this.currentPage);
    }
  }

  /**
   * Scroll to a page
   */
  private scrollToPage(page: number): void {
    if (!this.currentLayout) return;

    const { pageDisplayWidth, pageDisplayHeight, pagesPerRow } = this.currentLayout;
    const gap = this.config.gap;
    const padding = this.config.padding;

    if (this.config.scrollDirection === 'vertical') {
      const row = Math.floor((page - 1) / pagesPerRow);
      const scrollTop = padding + row * (pageDisplayHeight + gap);
      this.scrollContainer.scrollTo({ top: scrollTop, behavior: 'smooth' });
    } else {
      const scrollLeft = padding + (page - 1) * (pageDisplayWidth + gap);
      this.scrollContainer.scrollTo({ left: scrollLeft, behavior: 'smooth' });
    }

    // Render visible pages after scroll
    requestAnimationFrame(() => {
      this.renderVisiblePages();
    });
  }

  /**
   * Clear and render paginated view
   */
  private async clearAndRenderPaginatedView(): Promise<void> {
    // Clear existing pages
    for (const element of this.pageElements.values()) {
      element.destroy();
    }
    this.pageElements.clear();

    // Render current page(s)
    await this.renderVisiblePages();
  }

  /**
   * Navigate to next page(s)
   */
  async next(): Promise<void> {
    if (!this.currentLayout) return;

    const pagesPerView = this.currentLayout.pagesPerRow;
    const nextPage = Math.min(this.currentPage + pagesPerView, this.pageCount);
    await this.goToPage(nextPage);
  }

  /**
   * Navigate to previous page(s)
   */
  async prev(): Promise<void> {
    if (!this.currentLayout) return;

    const pagesPerView = this.currentLayout.pagesPerRow;
    const prevPage = Math.max(this.currentPage - pagesPerView, 1);
    await this.goToPage(prevPage);
  }

  /**
   * Update configuration
   */
  async updateConfig(config: Partial<MultiPageConfig>): Promise<void> {
    const oldDisplayMode = this.config.displayMode;
    const oldScrollDirection = this.config.scrollDirection;
    const oldPageLayout = this.config.pageLayout;
    const oldScale = this.config.scale;
    const oldUserZoom = this.config.userZoom;

    Object.assign(this.config, config);

    // Recalculate layout if needed
    if (
      config.displayMode !== undefined ||
      config.pageLayout !== undefined ||
      config.scale !== undefined ||
      config.userZoom !== undefined
    ) {
      this.calculateLayout();
      this.updatePagesContainerSize();
    }

    // Update container styles if mode changed
    if (config.displayMode !== undefined && config.displayMode !== oldDisplayMode) {
      this.updateScrollContainerStyles();
      this.updatePagesContainerStyles();
    }

    if (config.scrollDirection !== undefined && config.scrollDirection !== oldScrollDirection) {
      this.updateScrollContainerStyles();
      this.updatePagesContainerStyles();
      this.updatePagesContainerSize();
    }

    // Check if scale changed significantly
    const newScale = config.scale ?? oldScale;
    const scaleChanged = config.scale !== undefined && Math.abs(config.scale - oldScale) > 0.01;
    const userZoomChanged = config.userZoom !== undefined && config.userZoom !== oldUserZoom;
    const isZoomingIn = newScale > oldScale;

    // Only clear image cache if zooming IN (need higher resolution)
    // When zooming OUT, existing images can be scaled down without quality loss
    if ((scaleChanged || userZoomChanged) && isZoomingIn) {
      this.clearImageCache();
    }

    // Handle reading mode changes - apply to all existing pages without re-rendering
    if (config.readingMode !== undefined) {
      for (const element of this.pageElements.values()) {
        element.setReadingMode(config.readingMode);
      }
    }

    // Re-render if mode or layout changed, but for scale changes just resize elements
    if (config.displayMode !== oldDisplayMode || config.pageLayout !== oldPageLayout) {
      // Clear and re-render for mode/layout changes
      for (const element of this.pageElements.values()) {
        element.destroy();
      }
      this.pageElements.clear();
      await this.renderVisiblePages();
    } else if (scaleChanged || userZoomChanged) {
      // For scale changes, resize existing elements without destroying them
      // This prevents pages from disappearing during zoom
      await this.resizeExistingPages();
    }
  }

  /**
   * Resize existing page elements without destroying them
   * Used during zoom to prevent pages from disappearing
   */
  private async resizeExistingPages(): Promise<void> {
    if (!this.currentLayout) return;

    const { pageDisplayWidth, pageDisplayHeight } = this.currentLayout;

    // Update dimensions of existing page elements
    for (const [page, element] of this.pageElements) {
      element.setDimensions(pageDisplayWidth, pageDisplayHeight);
      this.positionPageElement(element, page);
    }

    // Update visible range and render any new pages that become visible
    this.updateVisiblePages();
    await this.renderVisiblePages();
  }

  /**
   * Handle resize
   */
  async handleResize(): Promise<void> {
    this.calculateLayout();
    this.updatePagesContainerSize();

    // Reposition and resize existing elements
    for (const [page, element] of this.pageElements) {
      if (this.currentLayout) {
        element.setDimensions(this.currentLayout.pageDisplayWidth, this.currentLayout.pageDisplayHeight);
        this.positionPageElement(element, page);
      }
    }

    // Re-render visible pages
    await this.renderVisiblePages();
  }

  /**
   * Set highlights for pages
   */
  setHighlightsForPage(page: number, highlights: PageHighlight[]): void {
    const element = this.pageElements.get(page);
    if (element) {
      element.setHighlights(highlights);
    }
  }

  /**
   * Set page change callback
   */
  setOnPageChange(callback: (page: number) => void): void {
    this.onPageChangeCallback = callback;
  }

  /**
   * Set selection callback
   */
  setOnSelection(callback: (page: number, text: string, rects: DOMRect[]) => void): void {
    this.onSelectionCallback = callback;
  }

  /**
   * Set highlight click callback
   */
  setOnHighlightClick(callback: (annotationId: string, position: { x: number; y: number }) => void): void {
    this.onHighlightClickCallback = callback;
  }

  /**
   * Get current layout
   */
  getLayout(): LayoutResult | null {
    return this.currentLayout;
  }

  /**
   * Destroy container
   */
  destroy(): void {
    for (const element of this.pageElements.values()) {
      element.destroy();
    }
    this.pageElements.clear();

    // Clear caches
    this.pageImageCache.clear();
    this.pageCacheScales.clear();
    this.cacheOrder = [];

    if (this.scrollTimeout) {
      clearTimeout(this.scrollTimeout);
    }
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
    }
    if (this.wheelResetTimeout) {
      clearTimeout(this.wheelResetTimeout);
    }

    this.scrollContainer.remove();
  }
}

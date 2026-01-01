/**
 * PDF Scroller
 *
 * Handles continuous scroll mode for PDF viewing.
 * Implements virtualized rendering with lazy page loading.
 */

export interface PdfScrollInfo {
  /** Current top page number */
  currentPage: number;
  /** Scroll progress through document (0-100) */
  progress: number;
  /** Visible page range */
  visibleRange: { start: number; end: number };
}

export type PdfScrollCallback = (info: PdfScrollInfo) => void;

export type PageRenderCallback = (page: number) => Promise<{
  element: HTMLElement;
  height: number;
}>;

export interface PdfScrollerConfig {
  /** Gap between pages (pixels) */
  pageGap?: number;
  /** Number of pages to preload above/below viewport */
  preloadCount?: number;
  /** Debounce time for scroll events (ms) */
  scrollDebounce?: number;
}

const DEFAULT_CONFIG: Required<PdfScrollerConfig> = {
  pageGap: 20,
  preloadCount: 2,
  scrollDebounce: 100,
};

interface PageEntry {
  page: number;
  element: HTMLElement | null;
  height: number;
  top: number;
  loading: boolean;
}

/**
 * PDF Scroller for continuous scroll mode with virtualization
 */
export class PdfScroller {
  private container: HTMLElement;
  private scrollContainer: HTMLDivElement;
  private config: Required<PdfScrollerConfig>;
  private onScroll: PdfScrollCallback;
  private renderPage: PageRenderCallback;

  // State
  private pages: PageEntry[] = [];
  private totalHeight = 0;
  private viewportHeight = 0;
  private scrollTop = 0;
  private initialized = false;

  // Scroll tracking
  private scrollTimeout: number | null = null;
  private lastScrollTime = 0;

  // Page heights (estimated initially, then actual after render)
  private estimatedPageHeight = 800;

  constructor(
    container: HTMLElement,
    renderPage: PageRenderCallback,
    config?: Partial<PdfScrollerConfig>,
    onScroll?: PdfScrollCallback
  ) {
    this.container = container;
    this.renderPage = renderPage;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onScroll = onScroll ?? (() => {});

    // Create scroll container
    this.scrollContainer = document.createElement('div');
    this.scrollContainer.className = 'pdf-scroll-container';
    this.scrollContainer.style.cssText = `
      position: relative;
      width: 100%;
      overflow-y: auto;
      overflow-x: hidden;
    `;

    this.container.appendChild(this.scrollContainer);
    this.setupScrollListener();
  }

  /**
   * Initialize scroller with page count
   */
  async initialize(
    totalPages: number,
    pageHeights?: number[],
    startPage = 1
  ): Promise<void> {
    // Clear existing pages
    this.pages = [];
    this.scrollContainer.innerHTML = '';

    // Create page entries
    let top = 0;
    for (let i = 1; i <= totalPages; i++) {
      const height = pageHeights?.[i - 1] ?? this.estimatedPageHeight;
      this.pages.push({
        page: i,
        element: null,
        height,
        top,
        loading: false,
      });
      top += height + this.config.pageGap;
    }

    // Calculate total height
    this.totalHeight = top - this.config.pageGap; // Remove last gap
    this.viewportHeight = this.container.clientHeight;

    // Set scroll container height
    const spacer = document.createElement('div');
    spacer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 1px;
      height: ${this.totalHeight}px;
      pointer-events: none;
    `;
    this.scrollContainer.appendChild(spacer);

    this.initialized = true;

    // Navigate to start page
    if (startPage > 1) {
      this.scrollToPage(startPage, false);
    } else {
      await this.updateVisiblePages();
    }
  }

  /**
   * Set up scroll event listener
   */
  private setupScrollListener(): void {
    this.scrollContainer.addEventListener('scroll', () => this.handleScrollEvent(), {
      passive: true,
    });
  }

  /**
   * Handle scroll events
   */
  private handleScrollEvent(): void {
    this.scrollTop = this.scrollContainer.scrollTop;
    this.lastScrollTime = Date.now();

    // Update visible pages immediately
    this.updateVisiblePages();

    // Debounce notification
    if (this.scrollTimeout) {
      clearTimeout(this.scrollTimeout);
    }
    this.scrollTimeout = window.setTimeout(() => {
      this.notifyScrollChange();
    }, this.config.scrollDebounce);
  }

  /**
   * Update which pages are rendered based on scroll position
   */
  private async updateVisiblePages(): Promise<void> {
    if (!this.initialized) return;

    const viewTop = this.scrollTop;
    const viewBottom = viewTop + this.viewportHeight;

    // Calculate visible range with preload buffer
    const preloadDistance = this.viewportHeight * this.config.preloadCount;
    const loadTop = viewTop - preloadDistance;
    const loadBottom = viewBottom + preloadDistance;

    // Find pages in range
    const pagesToRender: number[] = [];
    const pagesToUnload: number[] = [];

    for (const entry of this.pages) {
      const pageTop = entry.top;
      const pageBottom = pageTop + entry.height;

      const inLoadRange = pageBottom >= loadTop && pageTop <= loadBottom;
      const hasElement = entry.element !== null;

      if (inLoadRange && !hasElement && !entry.loading) {
        pagesToRender.push(entry.page);
      } else if (!inLoadRange && hasElement) {
        pagesToUnload.push(entry.page);
      }
    }

    // Unload pages outside range
    for (const pageNum of pagesToUnload) {
      this.unloadPage(pageNum);
    }

    // Render pages in range (in parallel)
    await Promise.all(pagesToRender.map((page) => this.loadPage(page)));
  }

  /**
   * Load and render a page
   */
  private async loadPage(pageNum: number): Promise<void> {
    const entry = this.pages[pageNum - 1];
    if (!entry || entry.loading || entry.element) return;

    entry.loading = true;

    try {
      const result = await this.renderPage(pageNum);

      // Position the element
      result.element.style.cssText = `
        position: absolute;
        top: ${entry.top}px;
        left: 50%;
        transform: translateX(-50%);
      `;

      this.scrollContainer.appendChild(result.element);
      entry.element = result.element;

      // Update height if different from estimate
      if (result.height !== entry.height) {
        const heightDiff = result.height - entry.height;
        entry.height = result.height;
        this.recalculatePositions(pageNum);
      }
    } catch (error) {
      console.error(`Failed to load page ${pageNum}:`, error);
    } finally {
      entry.loading = false;
    }
  }

  /**
   * Unload a page to free memory
   */
  private unloadPage(pageNum: number): void {
    const entry = this.pages[pageNum - 1];
    if (!entry || !entry.element) return;

    entry.element.remove();
    entry.element = null;
  }

  /**
   * Recalculate page positions after height change
   */
  private recalculatePositions(fromPage: number): void {
    let top = this.pages[fromPage - 1].top;

    for (let i = fromPage - 1; i < this.pages.length; i++) {
      const entry = this.pages[i];
      entry.top = top;

      if (entry.element) {
        entry.element.style.top = `${top}px`;
      }

      top += entry.height + this.config.pageGap;
    }

    // Update total height
    this.totalHeight = top - this.config.pageGap;

    // Update spacer
    const spacer = this.scrollContainer.querySelector('div');
    if (spacer) {
      spacer.style.height = `${this.totalHeight}px`;
    }
  }

  /**
   * Scroll down by one viewport
   * @returns true if scrolled, false if at end
   */
  scrollDown(): boolean {
    if (this.isAtEnd()) return false;

    const newScroll = Math.min(
      this.scrollTop + this.viewportHeight * 0.9,
      this.totalHeight - this.viewportHeight
    );

    this.scrollContainer.scrollTo({
      top: newScroll,
      behavior: 'smooth',
    });

    return true;
  }

  /**
   * Scroll up by one viewport
   * @returns true if scrolled, false if at start
   */
  scrollUp(): boolean {
    if (this.isAtStart()) return false;

    const newScroll = Math.max(this.scrollTop - this.viewportHeight * 0.9, 0);

    this.scrollContainer.scrollTo({
      top: newScroll,
      behavior: 'smooth',
    });

    return true;
  }

  /**
   * Scroll to a specific page
   */
  scrollToPage(page: number, animate = true): void {
    if (!this.initialized) return;

    const entry = this.pages[page - 1];
    if (!entry) return;

    this.scrollContainer.scrollTo({
      top: entry.top,
      behavior: animate ? 'smooth' : 'auto',
    });
  }

  /**
   * Scroll to a percentage through the document
   */
  scrollToPercentage(percentage: number, animate = true): void {
    const maxScroll = this.totalHeight - this.viewportHeight;
    const targetScroll = (percentage / 100) * maxScroll;

    this.scrollContainer.scrollTo({
      top: Math.max(0, targetScroll),
      behavior: animate ? 'smooth' : 'auto',
    });
  }

  /**
   * Get current page (page at top of viewport)
   */
  getCurrentPage(): number {
    const viewTop = this.scrollTop;

    for (const entry of this.pages) {
      if (entry.top + entry.height > viewTop) {
        return entry.page;
      }
    }

    return this.pages.length;
  }

  /**
   * Get visible page range
   */
  getVisibleRange(): { start: number; end: number } {
    const viewTop = this.scrollTop;
    const viewBottom = viewTop + this.viewportHeight;

    let start = 1;
    let end = this.pages.length;

    for (const entry of this.pages) {
      const pageBottom = entry.top + entry.height;

      if (pageBottom > viewTop && start === 1) {
        start = entry.page;
      }

      if (entry.top > viewBottom) {
        end = entry.page - 1;
        break;
      }
    }

    return { start, end: Math.max(start, end) };
  }

  /**
   * Get scroll info
   */
  getScrollInfo(): PdfScrollInfo {
    return {
      currentPage: this.getCurrentPage(),
      progress: this.getProgress(),
      visibleRange: this.getVisibleRange(),
    };
  }

  /**
   * Get scroll progress (0-100)
   */
  getProgress(): number {
    const maxScroll = this.totalHeight - this.viewportHeight;
    if (maxScroll <= 0) return 100;
    return Math.min(100, (this.scrollTop / maxScroll) * 100);
  }

  /**
   * Check if at start
   */
  isAtStart(): boolean {
    return this.scrollTop <= 10;
  }

  /**
   * Check if at end
   */
  isAtEnd(): boolean {
    const maxScroll = this.totalHeight - this.viewportHeight;
    return this.scrollTop >= maxScroll - 10;
  }

  /**
   * Get total pages
   */
  getTotalPages(): number {
    return this.pages.length;
  }

  /**
   * Update page height (after actual render)
   */
  updatePageHeight(page: number, height: number): void {
    const entry = this.pages[page - 1];
    if (!entry || entry.height === height) return;

    entry.height = height;
    this.recalculatePositions(page);
  }

  /**
   * Handle resize
   */
  handleResize(): void {
    if (!this.initialized) return;

    // Save scroll progress
    const progress = this.getProgress();

    // Update viewport height
    this.viewportHeight = this.container.clientHeight;

    // Restore scroll position
    this.scrollToPercentage(progress, false);

    // Update visible pages
    this.updateVisiblePages();
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PdfScrollerConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.initialized) {
      this.updateVisiblePages();
    }
  }

  /**
   * Set scroll callback
   */
  setOnScroll(callback: PdfScrollCallback): void {
    this.onScroll = callback;
  }

  /**
   * Notify listener of scroll change
   */
  private notifyScrollChange(): void {
    this.onScroll(this.getScrollInfo());
  }

  /**
   * Destroy the scroller
   */
  destroy(): void {
    if (this.scrollTimeout) {
      clearTimeout(this.scrollTimeout);
    }

    this.scrollContainer.remove();
    this.pages = [];
    this.initialized = false;
  }
}

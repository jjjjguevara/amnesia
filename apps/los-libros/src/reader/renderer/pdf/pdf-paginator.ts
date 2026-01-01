/**
 * PDF Paginator
 *
 * Handles page layout for PDF viewing in paginated mode.
 * Supports single page, dual page, and book spread layouts.
 */

export type PdfPageLayout = 'single' | 'dual' | 'book-spread';

export interface PdfPageInfo {
  current: number;
  total: number;
  /** Pages currently visible (1 or 2) */
  visiblePages: number[];
}

export type PdfPageChangeCallback = (info: PdfPageInfo) => void;

export interface PdfPaginatorConfig {
  /** Page layout */
  layout: PdfPageLayout;
  /** Gap between pages in dual mode (pixels) */
  pageGap?: number;
  /** Animation duration for page turns (ms) */
  animationDuration?: number;
}

const DEFAULT_CONFIG: Required<PdfPaginatorConfig> = {
  layout: 'single',
  pageGap: 20,
  animationDuration: 300,
};

/**
 * PDF Paginator for handling page layout and navigation
 */
export class PdfPaginator {
  private config: Required<PdfPaginatorConfig>;
  private onPageChange: PdfPageChangeCallback;

  // State
  private currentPage = 1;
  private totalPages = 1;
  private initialized = false;

  constructor(config?: Partial<PdfPaginatorConfig>, onPageChange?: PdfPageChangeCallback) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onPageChange = onPageChange ?? (() => {});
  }

  /**
   * Initialize paginator with page count
   */
  initialize(totalPages: number, startPage = 1): void {
    this.totalPages = Math.max(1, totalPages);
    this.currentPage = Math.max(1, Math.min(startPage, totalPages));
    this.initialized = true;
    this.notifyPageChange();
  }

  /**
   * Go to next page(s)
   * @returns true if navigated, false if at end
   */
  next(): boolean {
    if (!this.initialized || this.isAtEnd()) return false;

    const step = this.getNavigationStep();
    const newPage = Math.min(this.currentPage + step, this.totalPages);

    if (newPage !== this.currentPage) {
      this.currentPage = newPage;
      this.notifyPageChange();
      return true;
    }
    return false;
  }

  /**
   * Go to previous page(s)
   * @returns true if navigated, false if at start
   */
  prev(): boolean {
    if (!this.initialized || this.isAtStart()) return false;

    const step = this.getNavigationStep();
    const newPage = Math.max(1, this.currentPage - step);

    if (newPage !== this.currentPage) {
      this.currentPage = newPage;
      this.notifyPageChange();
      return true;
    }
    return false;
  }

  /**
   * Go to a specific page
   */
  goToPage(page: number): boolean {
    if (!this.initialized) return false;

    const targetPage = Math.max(1, Math.min(page, this.totalPages));
    if (targetPage === this.currentPage) return false;

    this.currentPage = targetPage;
    this.notifyPageChange();
    return true;
  }

  /**
   * Go to first page
   */
  goToFirst(): boolean {
    return this.goToPage(1);
  }

  /**
   * Go to last page
   */
  goToLast(): boolean {
    return this.goToPage(this.totalPages);
  }

  /**
   * Navigate to a percentage through the document
   */
  goToPercentage(percentage: number): boolean {
    const page = Math.max(1, Math.ceil((percentage / 100) * this.totalPages));
    return this.goToPage(page);
  }

  /**
   * Get current page number
   */
  getCurrentPage(): number {
    return this.currentPage;
  }

  /**
   * Get total pages
   */
  getTotalPages(): number {
    return this.totalPages;
  }

  /**
   * Get pages currently visible
   */
  getVisiblePages(): number[] {
    const pages: number[] = [this.currentPage];

    if (this.shouldShowDualPage()) {
      const secondPage = this.getSecondVisiblePage();
      if (secondPage) {
        pages.push(secondPage);
      }
    }

    return pages;
  }

  /**
   * Get current page info
   */
  getPageInfo(): PdfPageInfo {
    return {
      current: this.currentPage,
      total: this.totalPages,
      visiblePages: this.getVisiblePages(),
    };
  }

  /**
   * Get progress percentage
   */
  getProgress(): number {
    if (this.totalPages <= 1) return 100;
    return ((this.currentPage - 1) / (this.totalPages - 1)) * 100;
  }

  /**
   * Check if at start
   */
  isAtStart(): boolean {
    return this.currentPage <= 1;
  }

  /**
   * Check if at end
   */
  isAtEnd(): boolean {
    if (this.shouldShowDualPage()) {
      const secondPage = this.getSecondVisiblePage();
      return secondPage ? secondPage >= this.totalPages : this.currentPage >= this.totalPages;
    }
    return this.currentPage >= this.totalPages;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PdfPaginatorConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.initialized) {
      this.notifyPageChange();
    }
  }

  /**
   * Get current layout
   */
  getLayout(): PdfPageLayout {
    return this.config.layout;
  }

  /**
   * Set page change callback
   */
  setOnPageChange(callback: PdfPageChangeCallback): void {
    this.onPageChange = callback;
  }

  /**
   * Destroy the paginator
   */
  destroy(): void {
    this.initialized = false;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Get navigation step (how many pages to advance)
   */
  private getNavigationStep(): number {
    return this.shouldShowDualPage() ? 2 : 1;
  }

  /**
   * Check if we should show dual pages
   */
  private shouldShowDualPage(): boolean {
    if (this.config.layout === 'single') return false;
    if (this.config.layout === 'dual') return true;

    // Book spread mode: first and last pages are single
    if (this.config.layout === 'book-spread') {
      // First page is always single (cover)
      if (this.currentPage === 1) return false;
      // Last page is single if odd total
      if (this.currentPage === this.totalPages && this.totalPages % 2 === 0) return false;
      return true;
    }

    return false;
  }

  /**
   * Get the second visible page in dual mode
   */
  private getSecondVisiblePage(): number | null {
    if (!this.shouldShowDualPage()) return null;

    const secondPage = this.currentPage + 1;
    if (secondPage > this.totalPages) return null;

    return secondPage;
  }

  /**
   * Notify listener of page change
   */
  private notifyPageChange(): void {
    this.onPageChange(this.getPageInfo());
  }
}

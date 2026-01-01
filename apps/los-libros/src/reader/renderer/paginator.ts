/**
 * Paginator
 *
 * Handles CSS Scroll Snap pagination for paginated reading mode.
 * Uses native browser scrolling with CSS columns for layout.
 *
 * Key change from previous implementation:
 * - Previously: CSS columns + translate3d transforms for page turns
 * - Now: CSS columns + native scroll with scroll-snap for page turns
 *
 * Benefits of CSS Scroll Snap:
 * - All children (including CSS Custom Highlights) move atomically with content
 * - Native browser scroll engine handles momentum and smooth scrolling
 * - Consistent coordinates from getClientRects() during scroll
 * - Hardware-accelerated by browser compositor
 */

import type { RendererConfig, ColumnLayout } from './types';

export interface PageInfo {
  current: number;
  total: number;
}

export type PageChangeCallback = (page: PageInfo) => void;

/**
 * CSS Scroll Snap Paginator
 */
export type StyleUpdateCallback = () => void;

// Logging utility for debugging pagination issues
const LOG_PREFIX = '[Paginator]';
const DEBUG = true; // Set to false to disable verbose logging

function log(message: string, data?: Record<string, unknown>): void {
  if (!DEBUG) return;
  if (data) {
    console.log(`${LOG_PREFIX} ${message}`, data);
  } else {
    console.log(`${LOG_PREFIX} ${message}`);
  }
}

function warn(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.warn(`${LOG_PREFIX} ${message}`, data);
  } else {
    console.warn(`${LOG_PREFIX} ${message}`);
  }
}

export class Paginator {
  private iframe: HTMLIFrameElement;
  private config: RendererConfig;
  private onPageChange: PageChangeCallback;
  private onStyleUpdate?: StyleUpdateCallback;

  // Pagination state
  private currentPage = 0;
  private totalPages = 1;
  private columnWidth = 0;
  private containerWidth = 0;
  private exactViewportWidth = 0; // Exact width for column-aligned scrolling
  private initialized = false;

  // First page handling (for cover display)
  private isFirstPage = true;

  // Scroll container reference (viewport-wrapper)
  private scrollContainer: HTMLElement | null = null;

  // Debounce for scroll events
  private scrollDebounceTimer: number | null = null;
  private isScrolling = false;

  // Gesture tracking for trackpad/touch
  private gestureActive = false;
  private gestureStartX = 0;
  private gestureStartScrollLeft = 0;
  private velocityHistory: Array<{ delta: number; time: number }> = [];
  private gestureEndTimeout: number | null = null;

  // Logging state
  private lastLoggedPage = -1;
  private gestureLogCount = 0;

  constructor(
    iframe: HTMLIFrameElement,
    config: RendererConfig,
    onPageChange: PageChangeCallback,
    onStyleUpdate?: StyleUpdateCallback
  ) {
    this.iframe = iframe;
    this.config = config;
    this.onPageChange = onPageChange;
    this.onStyleUpdate = onStyleUpdate;
  }

  /**
   * Set style update callback (called when column layout changes)
   */
  setStyleUpdateCallback(callback: StyleUpdateCallback): void {
    this.onStyleUpdate = callback;
  }

  /**
   * Initialize pagination after content is loaded
   * @param initialPosition - 'start', 'end', or a specific page number
   */
  async initialize(initialPosition: 'start' | 'end' | number = 'start'): Promise<void> {
    log('=== INITIALIZE START ===', { initialPosition });

    const doc = this.iframe.contentDocument;
    if (!doc) {
      warn('Initialize failed: no contentDocument');
      return;
    }

    // Get scroll container (viewport-wrapper)
    this.scrollContainer = doc.getElementById('viewport-wrapper');
    if (!this.scrollContainer) {
      warn('Initialize failed: viewport-wrapper not found');
      return;
    }

    log('Found scroll container', {
      scrollWidth: this.scrollContainer.scrollWidth,
      clientWidth: this.scrollContainer.clientWidth,
      scrollLeft: this.scrollContainer.scrollLeft,
    });

    // Reset scroll position before calculating dimensions
    this.scrollContainer.scrollLeft = 0;

    // Wait for content to render
    // NOTE: requestAnimationFrame may not fire reliably in iframes during initial load
    // Use setTimeout as a more reliable alternative
    await new Promise((resolve) => setTimeout(resolve, 100));

    log('Measuring dimensions...');

    // Calculate dimensions (this determines totalPages)
    this.calculateDimensions();

    // Set initial page based on position parameter
    if (initialPosition === 'end') {
      this.currentPage = Math.max(0, this.totalPages - 1);
      this.isFirstPage = false;
    } else if (typeof initialPosition === 'number') {
      this.currentPage = Math.max(0, Math.min(initialPosition, this.totalPages - 1));
      this.isFirstPage = (this.currentPage === 0);
    } else {
      this.currentPage = 0;
      this.isFirstPage = true;
    }

    log('Initial page calculated', {
      currentPage: this.currentPage,
      totalPages: this.totalPages,
      isFirstPage: this.isFirstPage,
    });

    // Set up scroll event listener
    this.setupScrollListener();

    this.initialized = true;

    // Scroll to initial position without animation
    this.scrollToCurrentPage(false);

    log('=== INITIALIZE COMPLETE ===', {
      currentPage: this.currentPage,
      totalPages: this.totalPages,
      containerWidth: this.containerWidth,
      columnWidth: this.columnWidth,
    });

    this.notifyPageChange();
  }

  /**
   * Set up scroll event listener to track page changes
   */
  private setupScrollListener(): void {
    if (!this.scrollContainer) return;

    log('Setting up scroll event listener');

    this.scrollContainer.addEventListener('scroll', () => {
      // Don't process scroll events during programmatic scrolling
      if (this.isScrolling) {
        return;
      }

      // Don't process scroll events during active gesture - gesture end handles snap
      if (this.gestureActive) {
        return;
      }

      // Debounce to detect when scrolling stops
      if (this.scrollDebounceTimer) {
        clearTimeout(this.scrollDebounceTimer);
      }

      this.scrollDebounceTimer = window.setTimeout(() => {
        // Double-check gesture state when timeout fires (gesture might have started)
        if (this.gestureActive) {
          log('Scroll end timer fired but gesture now active - skipping');
          return;
        }
        this.handleScrollEnd();
      }, 100);
    }, { passive: true });
  }

  /**
   * Handle scroll end - snap to nearest page after user scroll
   */
  private handleScrollEnd(): void {
    if (!this.scrollContainer) return;

    // CRITICAL: Use exactViewportWidth for page width to match column layout
    const pageWidth = this.getPageWidth();
    const scrollLeft = this.scrollContainer.scrollLeft;
    const expectedPosition = this.currentPage * pageWidth;

    log('=== SCROLL END ===', {
      scrollLeft: Math.round(scrollLeft),
      pageWidth: Math.round(pageWidth),
      expectedPosition: Math.round(expectedPosition),
      currentPage: this.currentPage,
      isScrolling: this.isScrolling,
      gestureActive: this.gestureActive,
    });

    // Calculate which page we're on based on scroll position
    const newPage = Math.round(scrollLeft / pageWidth);
    const clampedPage = Math.max(0, Math.min(newPage, this.totalPages - 1));

    // Always snap to page boundary (CSS scroll-snap doesn't work with CSS columns)
    const targetScrollLeft = clampedPage * pageWidth;
    const drift = Math.abs(scrollLeft - targetScrollLeft);
    const needsSnap = drift > 2;

    log('Scroll end calculation', {
      calculatedPage: newPage,
      clampedPage,
      targetScrollLeft: Math.round(targetScrollLeft),
      drift: Math.round(drift),
      needsSnap,
      pageChanged: clampedPage !== this.currentPage,
    });

    // Determine if there's a first-page mode transition
    let needsLayoutChange = false;
    if (clampedPage !== this.currentPage && this.config.columns === 'auto') {
      const wasFirstPage = this.isFirstPage;
      this.isFirstPage = (clampedPage === 0);
      needsLayoutChange = wasFirstPage !== this.isFirstPage;
      if (needsLayoutChange) {
        log('First page mode transition in scroll end (deferred)', { wasFirstPage, isFirstPage: this.isFirstPage });
      }
    }

    const pageChanged = clampedPage !== this.currentPage;
    if (pageChanged) {
      log(`Page change: ${this.currentPage} → ${clampedPage}`);
      this.currentPage = clampedPage;
    }

    if (needsLayoutChange) {
      // For layout changes, apply atomically then scroll instantly
      log('Applying layout change - instant scroll to avoid drift');
      this.onStyleUpdate?.();
      this.calculateDimensions();
      this.scrollToCurrentPage(false);
      this.notifyPageChange();
    } else {
      if (pageChanged) {
        this.notifyPageChange();
      }
      // Snap to exact page position if not aligned
      if (needsSnap) {
        log(`Snapping to page ${clampedPage}, drift was ${Math.round(drift)}px`);
        this.scrollToCurrentPage(true);
      } else {
        log('No snap needed, already aligned');
      }
    }
  }

  /**
   * Calculate pagination dimensions
   */
  private calculateDimensions(): void {
    const doc = this.iframe.contentDocument;
    if (!doc) return;

    const container = doc.getElementById('content-container');
    if (!container || !this.scrollContainer) {
      warn('calculateDimensions: missing container or scrollContainer');
      return;
    }

    // Get viewport dimensions from iframe
    const iframeRect = this.iframe.getBoundingClientRect();
    const viewportWidth = iframeRect.width - (this.config.margin * 2);
    const viewportHeight = iframeRect.height - (this.config.margin * 2);

    this.containerWidth = viewportWidth;

    // Calculate column width based on settings
    const columns = this.getColumnCount();
    const totalGaps = (columns - 1) * this.config.columnGap;
    // CRITICAL: Round to whole pixels to avoid browser rounding inconsistencies
    // Fractional pixels cause drift between calculated pages and actual scroll positions
    this.columnWidth = Math.floor((viewportWidth - totalGaps) / columns);

    // CRITICAL: Calculate the exact viewport width that fits the columns perfectly
    // This prevents drift between scroll positions and column boundaries
    this.exactViewportWidth = this.columnWidth * columns + totalGaps;

    // Force reflow to get accurate measurements
    void container.offsetWidth;

    // Measure the actual content width using scrollWidth of the scroll container
    const scrollWidth = this.scrollContainer.scrollWidth;
    const clientWidth = this.scrollContainer.clientWidth;

    // Each "page" is exact viewport width + gap
    // Must use exactViewportWidth to match the actual column layout
    const pageWidth = this.exactViewportWidth + this.config.columnGap;

    // Calculate total pages based on scroll width
    const prevTotalPages = this.totalPages;
    if (scrollWidth <= viewportWidth) {
      this.totalPages = 1;
    } else {
      this.totalPages = Math.max(1, Math.ceil(scrollWidth / pageWidth));
    }

    // Get actual CSS computed values for debugging
    const computedStyle = doc.defaultView?.getComputedStyle(container);
    const actualColumnWidth = computedStyle?.columnWidth;
    const actualColumnGap = computedStyle?.columnGap;

    log('=== DIMENSIONS CALCULATED ===', {
      iframeWidth: Math.round(iframeRect.width),
      iframeHeight: Math.round(iframeRect.height),
      margin: this.config.margin,
      viewportWidth: Math.round(viewportWidth * 100) / 100,
      viewportHeight: Math.round(viewportHeight),
      columns,
      columnWidth: Math.round(this.columnWidth * 100) / 100,
      columnGap: this.config.columnGap,
      scrollWidth,
      clientWidth,
      pageWidth: Math.round(pageWidth * 100) / 100,
      totalPages: this.totalPages,
      prevTotalPages,
      isFirstPage: this.isFirstPage,
      // CSS actual values (for debugging mismatch)
      cssColumnWidth: actualColumnWidth,
      cssColumnGap: actualColumnGap,
    });
  }

  /**
   * Get number of columns based on config
   * Forces single column on first page in 'auto' mode for cover display
   */
  private getColumnCount(): number {
    if (this.config.columns === 'single') return 1;
    if (this.config.columns === 'dual') return 2;

    // Auto mode: force single column on first page for cover display
    if (this.isFirstPage) return 1;

    // Auto: use 2 columns if wide enough
    return this.containerWidth > 800 ? 2 : 1;
  }

  /**
   * Get column count for external style application
   * Called by renderer.applyRendererStyles() to ensure CSS matches paginator logic
   */
  getColumnCountForStyles(): number {
    return this.getColumnCount();
  }

  /**
   * Go to next page
   * @returns true if there was a next page, false if at end
   */
  nextPage(): boolean {
    log('nextPage() called', {
      initialized: this.initialized,
      currentPage: this.currentPage,
      totalPages: this.totalPages,
      isScrolling: this.isScrolling,
      gestureActive: this.gestureActive,
    });

    if (!this.initialized) {
      warn('nextPage: not initialized');
      return false;
    }
    if (this.currentPage < this.totalPages - 1) {
      // Detect if layout will change (first page mode transition)
      const needsLayoutChange = this.isFirstPage && this.config.columns === 'auto';

      if (needsLayoutChange) {
        log('Transitioning from first page mode');
        this.isFirstPage = false;
        this.onStyleUpdate?.();
        this.calculateDimensions();
      }

      this.currentPage++;
      log(`nextPage: going to page ${this.currentPage}`);
      // Use instant scroll for layout changes to avoid drift during animation
      this.scrollToCurrentPage(!needsLayoutChange);
      return true;
    }
    log('nextPage: already at last page');
    return false;
  }

  /**
   * Go to previous page
   * @returns true if there was a previous page, false if at start
   */
  prevPage(): boolean {
    log('prevPage() called', {
      currentPage: this.currentPage,
      totalPages: this.totalPages,
      isScrolling: this.isScrolling,
      gestureActive: this.gestureActive,
    });

    if (this.currentPage > 0) {
      this.currentPage--;

      // Detect if layout will change (first page mode transition)
      const needsLayoutChange = this.currentPage === 0 && this.config.columns === 'auto' && !this.isFirstPage;

      if (needsLayoutChange) {
        log('Restoring first page mode');
        this.isFirstPage = true;
        this.onStyleUpdate?.();
        this.calculateDimensions();
      }

      log(`prevPage: going to page ${this.currentPage}`);
      // Use instant scroll for layout changes to avoid drift during animation
      this.scrollToCurrentPage(!needsLayoutChange);
      return true;
    }
    log('prevPage: already at first page');
    return false;
  }

  /**
   * Go to a specific page
   * @param pageNumber - Target page number
   * @param instant - If true, skip animation (used for highlight navigation)
   */
  goToPage(pageNumber: number, instant = false): void {
    const page = Math.max(0, Math.min(pageNumber, this.totalPages - 1));

    log('goToPage() called', {
      requestedPage: pageNumber,
      clampedPage: page,
      currentPage: this.currentPage,
      totalPages: this.totalPages,
      instant,
      isScrolling: this.isScrolling,
      gestureActive: this.gestureActive,
    });

    if (page !== this.currentPage || instant) {
      // Handle first page mode transitions in auto mode
      let needsLayoutChange = false;
      if (this.config.columns === 'auto') {
        const wasFirstPage = this.isFirstPage;
        this.isFirstPage = (page === 0);
        needsLayoutChange = wasFirstPage !== this.isFirstPage;
        if (needsLayoutChange) {
          log('First page mode changed in goToPage', { wasFirstPage, isFirstPage: this.isFirstPage });
          this.onStyleUpdate?.();
          this.calculateDimensions();
        }
      }
      this.currentPage = page;
      // Force instant scroll if layout changed or caller requested instant
      const shouldAnimate = !instant && !needsLayoutChange;
      log(`goToPage: navigating to page ${page}, animate=${shouldAnimate}`);
      this.scrollToCurrentPage(shouldAnimate);
    } else {
      log('goToPage: already on requested page');
    }
  }

  /**
   * Go to the last page
   */
  goToLastPage(): void {
    this.goToPage(this.totalPages - 1);
  }

  /**
   * Go to the first page
   */
  goToFirstPage(): void {
    this.goToPage(0);
  }

  /**
   * Get current page info
   */
  getCurrentPage(): PageInfo {
    return {
      current: this.currentPage,
      total: this.totalPages,
    };
  }

  /**
   * Get the width of each column (page)
   */
  getColumnWidth(): number {
    return this.columnWidth;
  }

  /**
   * Get the gap between columns
   */
  getGap(): number {
    return this.config.columnGap;
  }

  /**
   * Get the effective page width (exact viewport width + gap)
   * This is the distance between pages, aligned to column boundaries
   */
  getPageWidth(): number {
    return this.exactViewportWidth + this.config.columnGap;
  }

  /**
   * Get page progress (0-1)
   */
  getProgress(): number {
    if (this.totalPages <= 1) return 0;
    return this.currentPage / (this.totalPages - 1);
  }

  /**
   * Navigate to a percentage within the chapter
   */
  goToPercentage(percentage: number): void {
    const page = Math.floor((percentage / 100) * this.totalPages);
    this.goToPage(page);
  }

  /**
   * Scroll to an element by ID
   */
  scrollToElement(elementId: string): boolean {
    const doc = this.iframe.contentDocument;
    if (!doc || !this.scrollContainer) return false;

    const element = doc.getElementById(elementId);
    if (!element) return false;

    // Get element position relative to content
    const rect = element.getBoundingClientRect();
    const scrollLeft = this.scrollContainer.scrollLeft;
    const containerRect = this.scrollContainer.getBoundingClientRect();

    // Calculate the absolute position of the element
    const elementLeft = scrollLeft + rect.left - containerRect.left;

    // Calculate which page the element is on
    const pageWidth = this.getPageWidth();
    const page = Math.floor(elementLeft / pageWidth);

    this.goToPage(page);
    return true;
  }

  /**
   * Handle resize
   */
  handleResize(): void {
    if (!this.initialized) return;

    // Cancel any pending operations
    if (this.scrollDebounceTimer) {
      clearTimeout(this.scrollDebounceTimer);
      this.scrollDebounceTimer = null;
    }
    if (this.gestureEndTimeout) {
      clearTimeout(this.gestureEndTimeout);
      this.gestureEndTimeout = null;
    }

    // Save current page
    const previousPage = this.currentPage;

    // Recalculate dimensions
    this.calculateDimensions();

    // Preserve page position (clamped to new bounds)
    this.currentPage = Math.min(previousPage, this.totalPages - 1);

    // Scroll to current page without animation
    this.scrollToCurrentPage(false);
  }

  /**
   * Update configuration
   */
  updateConfig(config: RendererConfig): void {
    this.config = config;
    if (this.initialized) {
      this.handleResize();
    }
  }

  // ============================================================================
  // Gesture Handling - For manual trackpad/touch page turning
  // ============================================================================

  /**
   * Handle gesture input (trackpad/touch drag)
   * Uses programmatic scrolling since CSS Scroll Snap doesn't work with CSS columns.
   *
   * @param deltaX - The change in X position (positive = drag right, negative = drag left)
   */
  handleGestureInput(deltaX: number): void {
    if (!this.initialized || !this.scrollContainer) {
      // Log more visibly when events are dropped due to not being ready
      warn('handleGestureInput: DROPPED - paginator not ready', {
        initialized: this.initialized,
        hasScrollContainer: !!this.scrollContainer,
        deltaX: Math.round(deltaX),
      });
      return;
    }

    const now = performance.now();

    // Start gesture if not already active
    if (!this.gestureActive) {
      this.gestureActive = true;
      this.gestureStartScrollLeft = this.scrollContainer.scrollLeft;
      this.velocityHistory = [];
      this.gestureLogCount = 0;

      // Cancel any pending scroll animation
      this.isScrolling = false;

      // Temporarily disable smooth scrolling for responsive drag
      this.scrollContainer.style.scrollBehavior = 'auto';

      log('=== GESTURE START ===', {
        startScrollLeft: Math.round(this.gestureStartScrollLeft),
        currentPage: this.currentPage,
        pageWidth: this.getPageWidth(),
        isScrolling: this.isScrolling,
      });
    }

    // Log every 5th gesture input to avoid spam
    this.gestureLogCount++;
    if (this.gestureLogCount % 5 === 1) {
      log('Gesture input', {
        deltaX: Math.round(deltaX * 100) / 100,
        scrollLeft: Math.round(this.scrollContainer.scrollLeft),
        gestureCount: this.gestureLogCount,
      });
    }

    // Track velocity for momentum
    this.velocityHistory.push({ delta: deltaX, time: now });
    this.velocityHistory = this.velocityHistory.filter(v => now - v.time < 100);

    // Apply scroll directly for live feedback
    const prevScrollLeft = this.scrollContainer.scrollLeft;
    const newScrollLeft = this.scrollContainer.scrollLeft - deltaX;
    const maxScroll = this.scrollContainer.scrollWidth - this.scrollContainer.clientWidth;

    // Clamp with rubber-band effect at edges
    let appliedScrollLeft: number;
    let rubberBand = '';
    if (newScrollLeft < 0) {
      appliedScrollLeft = newScrollLeft * 0.3;
      rubberBand = 'left';
    } else if (newScrollLeft > maxScroll) {
      const overshoot = newScrollLeft - maxScroll;
      appliedScrollLeft = maxScroll + overshoot * 0.3;
      rubberBand = 'right';
    } else {
      appliedScrollLeft = newScrollLeft;
    }

    this.scrollContainer.scrollLeft = appliedScrollLeft;

    // Log rubber-band effect
    if (rubberBand && this.gestureLogCount % 5 === 1) {
      log(`Rubber-band effect (${rubberBand})`, {
        requestedScroll: Math.round(newScrollLeft),
        appliedScroll: Math.round(appliedScrollLeft),
        maxScroll: Math.round(maxScroll),
      });
    }

    // Reset gesture end timer
    if (this.gestureEndTimeout) {
      clearTimeout(this.gestureEndTimeout);
    }
    this.gestureEndTimeout = window.setTimeout(() => {
      this.handleGestureEnd();
    }, 100);
  }

  /**
   * Calculate velocity from recent gesture history
   */
  private calculateVelocity(): number {
    if (this.velocityHistory.length < 2) return 0;

    const recent = this.velocityHistory.slice(-5);
    if (recent.length < 2) return 0;

    const first = recent[0];
    const last = recent[recent.length - 1];
    const timeDelta = last.time - first.time;

    if (timeDelta === 0) return 0;

    const totalDelta = recent.reduce((sum, v) => sum + v.delta, 0);
    return totalDelta / timeDelta;
  }

  /**
   * Explicitly end the gesture and snap to nearest page
   */
  handleGestureEnd(): void {
    if (!this.gestureActive || !this.scrollContainer) {
      log('handleGestureEnd: no active gesture or no container');
      return;
    }

    // Re-enable smooth scrolling
    this.scrollContainer.style.scrollBehavior = 'smooth';

    // Calculate velocity for determining page direction
    const velocity = this.calculateVelocity();
    const pageWidth = this.getPageWidth();
    const rawScrollLeft = this.scrollContainer.scrollLeft;
    // Clamp negative scroll positions (from rubber-band effect) to 0
    const currentScroll = Math.max(0, rawScrollLeft);

    log('=== GESTURE END ===', {
      rawScrollLeft: Math.round(rawScrollLeft),
      currentScroll: Math.round(currentScroll),
      pageWidth: Math.round(pageWidth),
      velocity: Math.round(velocity * 1000) / 1000,
      currentPage: this.currentPage,
      gestureInputCount: this.gestureLogCount,
      totalDrag: Math.round(currentScroll - this.gestureStartScrollLeft),
    });

    // Reset gesture state
    this.gestureActive = false;
    this.velocityHistory = [];

    if (this.gestureEndTimeout) {
      clearTimeout(this.gestureEndTimeout);
      this.gestureEndTimeout = null;
    }

    // Snap to correct page based on position, drag distance, and velocity
    let targetPage: number;
    let snapReason: string;

    // Calculate how far we've dragged from the starting position
    const dragDistance = currentScroll - this.gestureStartScrollLeft;
    const dragProgress = dragDistance / pageWidth; // How many pages we've dragged

    // Lower velocity threshold for more responsive backwards scrolling
    const velocityThreshold = 0.15;
    // Drag threshold: if user dragged more than 20% of a page, respect intent
    const dragThreshold = 0.20;

    if (Math.abs(velocity) > velocityThreshold) {
      // Velocity-based direction (most responsive)
      if (velocity < 0) {
        // Swiping left (content moves right) = next page
        targetPage = Math.ceil(currentScroll / pageWidth);
        snapReason = `velocity (${velocity.toFixed(3)}) → next page (ceil)`;
      } else {
        // Swiping right (content moves left) = previous page
        targetPage = Math.floor(currentScroll / pageWidth);
        snapReason = `velocity (${velocity.toFixed(3)}) → prev page (floor)`;
      }
    } else if (Math.abs(dragProgress) > dragThreshold) {
      // Drag distance-based direction (respects user intent even with slow release)
      if (dragProgress > 0) {
        // Dragged right (towards higher pages)
        targetPage = Math.ceil(currentScroll / pageWidth);
        snapReason = `drag (${(dragProgress * 100).toFixed(0)}%) → next page (ceil)`;
      } else {
        // Dragged left (towards lower pages)
        targetPage = Math.floor(currentScroll / pageWidth);
        snapReason = `drag (${(dragProgress * 100).toFixed(0)}%) → prev page (floor)`;
      }
    } else {
      // Very small drag and velocity - snap to nearest page
      targetPage = Math.round(currentScroll / pageWidth);
      snapReason = `minimal gesture (v=${velocity.toFixed(3)}, d=${(dragProgress * 100).toFixed(0)}%) → nearest (round)`;
    }

    const unclampedTarget = targetPage;
    // Clamp and navigate
    targetPage = Math.max(0, Math.min(targetPage, this.totalPages - 1));

    log('Gesture snap decision', {
      snapReason,
      unclampedTarget,
      clampedTarget: targetPage,
      previousPage: this.currentPage,
      pageChanged: targetPage !== this.currentPage,
    });

    // Determine if there's a first-page mode transition
    let needsLayoutChange = false;
    if (targetPage !== this.currentPage && this.config.columns === 'auto') {
      const wasFirstPage = this.isFirstPage;
      this.isFirstPage = (targetPage === 0);
      needsLayoutChange = wasFirstPage !== this.isFirstPage;
      if (needsLayoutChange) {
        log('First page mode transition in gesture end (deferred)', { wasFirstPage, isFirstPage: this.isFirstPage });
      }
    }

    this.currentPage = targetPage;

    if (needsLayoutChange) {
      // For layout changes (single↔dual column), skip animation
      // Apply style change immediately, recalculate, then scroll instantly
      log('Applying deferred layout change - instant scroll to avoid drift');
      this.onStyleUpdate?.();
      this.calculateDimensions();
      this.scrollToCurrentPage(false); // No animation
    } else {
      // Normal page change - smooth animation
      log(`Snapping to page ${this.currentPage} with animation`);
      this.scrollToCurrentPage(true);
    }
  }

  /**
   * Check if a gesture is currently active
   */
  isGestureActive(): boolean {
    return this.gestureActive;
  }

  /**
   * Cancel any active gesture without changing page
   */
  cancelGesture(): void {
    if (this.gestureEndTimeout) {
      clearTimeout(this.gestureEndTimeout);
      this.gestureEndTimeout = null;
    }

    if (this.gestureActive && this.scrollContainer) {
      this.gestureActive = false;
      this.velocityHistory = [];
      this.scrollContainer.style.scrollBehavior = 'smooth';
      this.scrollToCurrentPage(true);
    }
  }

  /**
   * Reset to first page mode (for new books/chapters)
   */
  resetFirstPage(): void {
    this.isFirstPage = true;
  }

  /**
   * Destroy the paginator
   */
  destroy(): void {
    this.cancelGesture();
    if (this.scrollDebounceTimer) {
      clearTimeout(this.scrollDebounceTimer);
    }
    this.initialized = false;
  }

  /**
   * Scroll to current page using native scroll
   */
  private scrollToCurrentPage(animate = true): void {
    if (!this.scrollContainer) {
      warn('scrollToCurrentPage: no scrollContainer');
      return;
    }

    const pageWidth = this.getPageWidth();
    const targetScrollLeft = this.currentPage * pageWidth;
    const currentScrollLeft = this.scrollContainer.scrollLeft;

    // Clamp to valid scroll range
    const maxScroll = this.scrollContainer.scrollWidth - this.scrollContainer.clientWidth;
    const clampedScrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScroll));

    const scrollDistance = Math.abs(clampedScrollLeft - currentScrollLeft);

    log('=== SCROLL TO PAGE ===', {
      currentPage: this.currentPage,
      pageWidth: Math.round(pageWidth),
      targetScrollLeft: Math.round(targetScrollLeft),
      clampedScrollLeft: Math.round(clampedScrollLeft),
      currentScrollLeft: Math.round(currentScrollLeft),
      scrollDistance: Math.round(scrollDistance),
      maxScroll: Math.round(maxScroll),
      animate,
      wasScrolling: this.isScrolling,
    });

    // Mark that we're doing programmatic scroll
    this.isScrolling = true;

    if (animate) {
      // Use smooth scrolling (CSS scroll-behavior handles animation)
      this.scrollContainer.style.scrollBehavior = 'smooth';
      this.scrollContainer.scrollTo({ left: clampedScrollLeft, behavior: 'smooth' });

      log('Started smooth scroll animation, will reset isScrolling in 350ms');

      // Reset flag after animation completes (300ms typical duration)
      setTimeout(() => {
        this.isScrolling = false;
        if (this.scrollContainer) {
          this.scrollContainer.style.scrollBehavior = 'smooth';
          log('Smooth scroll complete', {
            finalScrollLeft: Math.round(this.scrollContainer.scrollLeft),
            expectedScrollLeft: Math.round(clampedScrollLeft),
            drift: Math.round(Math.abs(this.scrollContainer.scrollLeft - clampedScrollLeft)),
          });
        }
      }, 350);
    } else {
      // Instant scroll without animation
      this.scrollContainer.style.scrollBehavior = 'auto';
      this.scrollContainer.scrollLeft = clampedScrollLeft;

      log('Instant scroll applied', {
        appliedScrollLeft: Math.round(this.scrollContainer.scrollLeft),
      });

      // Reset after next frame
      // NOTE: Use setTimeout instead of RAF - RAF may not fire in iframes
      setTimeout(() => {
        this.isScrolling = false;
        if (this.scrollContainer) {
          this.scrollContainer.style.scrollBehavior = 'smooth';
          log('Instant scroll frame complete', {
            finalScrollLeft: Math.round(this.scrollContainer.scrollLeft),
          });
        }
      }, 16);
    }

    this.notifyPageChange();
  }

  /**
   * Notify listener of page change
   */
  private notifyPageChange(): void {
    this.onPageChange({
      current: this.currentPage,
      total: this.totalPages,
    });
  }

  /**
   * Get the content container element
   */
  getContentContainer(): HTMLElement | null {
    const doc = this.iframe.contentDocument;
    if (!doc) return null;
    return doc.getElementById('content-container');
  }

  /**
   * Get the scroll container element (viewport-wrapper)
   */
  getScrollContainer(): HTMLElement | null {
    return this.scrollContainer;
  }
}

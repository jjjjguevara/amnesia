/**
 * Paginated Navigator
 *
 * CSS multi-column based pagination with:
 * - Integer-forced widths to prevent sub-pixel drift
 * - Native scroll-based navigation (scrollLeft)
 * - CSS scroll-snap for native gesture handling
 *
 * Uses scroll-based pagination instead of transforms for reliable
 * column alignment that works correctly with CSS multi-column layout.
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

import type {
  Navigator,
  NavigatorConfig,
  NavigatorEvents,
  NavigatorEventListener,
  NavigationTarget,
  NavigationOptions,
  Locator,
  PaginationInfo,
  SpineItemContent,
} from './navigator-interface';
import { createLocator } from './navigator-interface';
import { DEFAULT_NAVIGATOR_CONFIG } from './navigator-factory';
import { getSpineIndexFromCfi, resolveCfi } from '../renderer/cfi-utils';

/**
 * Paginated Navigator implementation
 */
export class PaginatedNavigator implements Navigator {
  readonly mode = 'paginated' as const;

  private container: HTMLElement | null = null;
  private config: NavigatorConfig = { ...DEFAULT_NAVIGATOR_CONFIG };

  // Layout state
  private columnWidth = 0;
  private columnCount = 1;
  private totalColumns = 0;
  private currentColumn = 0;
  private gap = 0;
  private pageWidth = 0; // columnWidth + gap, for chapter positioning
  private margin = 0; // Horizontal margin for chapter positioning and navigation

  // Content state
  private spineItems: SpineItemContent[] = [];
  private chapterElements: Map<number, HTMLElement> = new Map();
  private chapterColumnOffsets: Map<number, number> = new Map();
  private chapterColumnCounts: Map<number, number> = new Map();
  private accurateColumnCounts: Set<number> = new Set(); // Track which chapters have been accurately measured

  // Chapter windowing - only load chapters near current position for performance
  private loadedChapterWindow: Set<number> = new Set();
  // Phase 3: Window size is now configurable via config.chapterWindowSize
  private readonly ACCURATE_WINDOW = 5; // Calculate accurate columns for ±5 chapters

  /**
   * Get the chapter window size from config (Phase 3: configurable)
   */
  private get windowSize(): number {
    return this.config.chapterWindowSize ?? 3;
  }

  // Navigation state
  private currentSpineIndex = 0;
  private currentLocator: Locator | null = null;
  private isAnimating = false;

  // Event listeners
  private listeners: Map<keyof NavigatorEvents, Set<NavigatorEventListener<any>>> = new Map();

  // Ready state
  private _isReady = false;

  // Animation state (for tracking scroll position)

  // Resize handling
  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounceTimer: number | null = null;

  // Config update debouncing
  private configUpdateTimer: number | null = null;
  private pendingConfigUpdate: Partial<NavigatorConfig> | null = null;

  // Layout cascade protection (Fix 2.2)
  private layoutUpdatePending = false;
  private pendingLayoutUpdates: Map<number, number> = new Map();

  // Drift detection instrumentation (permanent, controlled by flag)
  private driftLog: Array<{
    step: number;
    operation: string;
    expectedColumn: number;
    actualTranslateX: number;
    currentSpineIndex: number;
    loadedChapters: number[];
    chapterOffsets: Record<number, number>;
    drift: number;
  }> = [];
  private driftStep = 0;
  private DEBUG_DRIFT = false; // Set to true to enable drift detection logging

  // Wheel handling (for page turns)
  private boundHandleWheel: ((e: WheelEvent) => void) | null = null;

  get isReady(): boolean {
    return this._isReady;
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  async initialize(container: HTMLElement, config: NavigatorConfig): Promise<void> {
    this.container = container;
    this.config = { ...this.config, ...config };

    // Apply initial styles
    this.applyContainerStyles();

    // Setup resize observer
    this.setupResizeObserver();

    // Setup scroll handling for manual swipe gestures
    this.setupScrollHandler();

    this._isReady = true;
    this.emit('rendered', { spineIndex: 0 });
  }

  async loadContent(
    spineItems: SpineItemContent[],
    initialLocator?: Locator,
    cachedElements?: Map<number, HTMLElement>
  ): Promise<void> {
    const loadStart = performance.now();
    console.log(`[PaginatedNav] loadContent starting with ${spineItems.length} items`);

    if (!this.container) {
      throw new Error('Navigator not initialized');
    }

    this.emit('loading', true);

    try {
      this.spineItems = spineItems;

      // Clear existing content
      console.log('[PaginatedNav] Clearing existing content...');
      this.container.innerHTML = '';
      this.chapterElements.clear();
      this.chapterColumnOffsets.clear();
      this.chapterColumnCounts.clear();
      this.accurateColumnCounts.clear();
      this.loadedChapterWindow.clear();

      // Phase 3: Sliding window virtualization
      // With per-chapter CSS columns (Phase 2), we can now virtualize!
      // Only load chapters in the initial window, create placeholders for others.

      // Determine initial position
      const initialSpineIndex = initialLocator?.locations?.position ?? 0;
      console.log(`[PaginatedNav] Initial spine index: ${initialSpineIndex}`);

      // Calculate estimated layout FIRST (needed for placeholder positioning)
      console.log('[PaginatedNav] Calculating estimated layout...');
      const estStart = performance.now();
      await this.initializeEstimatedLayout(spineItems);
      console.log(`[PaginatedNav] Estimated layout done in ${(performance.now() - estStart).toFixed(1)}ms`);

      // Load initial window of chapters
      const windowStart = Math.max(0, initialSpineIndex - this.windowSize);
      const windowEnd = Math.min(spineItems.length - 1, initialSpineIndex + this.windowSize);
      console.log(`[PaginatedNav] Loading window [${windowStart}-${windowEnd}], creating ${spineItems.length} elements...`);

      const fragStart = performance.now();
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < spineItems.length; i++) {
        const item = spineItems[i];
        let chapterEl: HTMLElement;

        if (i >= windowStart && i <= windowEnd) {
          // Load real content for chapters in window
          chapterEl = this.getOrCreateChapterElement(item, cachedElements);
          this.loadedChapterWindow.add(i);
        } else {
          // Create placeholder for chapters outside window
          chapterEl = this.createPlaceholderElement(item);
        }

        this.chapterElements.set(i, chapterEl);
        fragment.appendChild(chapterEl);

        // Yield to main thread every 20 elements to prevent freeze
        if (i > 0 && i % 20 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }
      console.log(`[PaginatedNav] Fragment built in ${(performance.now() - fragStart).toFixed(1)}ms`);

      console.log('[PaginatedNav] Appending fragment to container...');
      const appendStart = performance.now();
      this.container.appendChild(fragment);
      console.log(`[PaginatedNav] Fragment appended in ${(performance.now() - appendStart).toFixed(1)}ms`);

      // Yield to browser to process layout before continuing
      await new Promise(r => requestAnimationFrame(r));

      // Calculate accurate layout for loaded chapters
      console.log('[PaginatedNav] Calculating accurate layout...');
      const layoutStart = performance.now();
      await this.calculateLayout();
      console.log(`[PaginatedNav] Layout calculated in ${(performance.now() - layoutStart).toFixed(1)}ms`);

      // Navigate to initial position
      console.log('[PaginatedNav] Navigating to initial position...');
      const navStart = performance.now();
      if (initialLocator) {
        await this.goTo({ type: 'locator', locator: initialLocator }, { instant: true });
      } else {
        await this.goTo({ type: 'position', position: 0 }, { instant: true });
      }
      console.log(`[PaginatedNav] Initial navigation done in ${(performance.now() - navStart).toFixed(1)}ms`);

      this.emit('rendered', { spineIndex: this.currentSpineIndex });
      console.log(`[PaginatedNav] loadContent complete! Total: ${(performance.now() - loadStart).toFixed(1)}ms`);
    } finally {
      this.emit('loading', false);
    }
  }

  /**
   * Initialize estimated layout before loading content
   * Phase 3: Needed for placeholder positioning
   */
  private async initializeEstimatedLayout(spineItems: SpineItemContent[]): Promise<void> {
    const containerWidth = this.columnWidth + this.gap;
    if (containerWidth <= 0) return;

    const charsPerColumn = 2500;
    let totalColumns = 0;

    for (const item of spineItems) {
      const contentLength = item.html?.length || 3000;
      const estimatedColumns = Math.max(1, Math.ceil(contentLength / charsPerColumn));

      this.chapterColumnOffsets.set(item.index, totalColumns);
      this.chapterColumnCounts.set(item.index, estimatedColumns);
      totalColumns += estimatedColumns;
    }

    this.totalColumns = totalColumns;
  }

  /**
   * Synchronous content loading for small books
   */
  private async loadContentSync(
    spineItems: SpineItemContent[],
    cachedElements?: Map<number, HTMLElement>
  ): Promise<void> {
    const fragment = document.createDocumentFragment();

    for (const item of spineItems) {
      const chapterEl = this.getOrCreateChapterElement(item, cachedElements);
      this.loadedChapterWindow.add(item.index);
      this.chapterElements.set(item.index, chapterEl);
      fragment.appendChild(chapterEl);
    }

    this.container!.appendChild(fragment);
  }

  /**
   * Chunked content loading for large books
   */
  private async loadContentChunked(
    spineItems: SpineItemContent[],
    cachedElements?: Map<number, HTMLElement>
  ): Promise<void> {
    const CHUNK_SIZE = 20; // Insert 20 chapters at a time

    for (let i = 0; i < spineItems.length; i += CHUNK_SIZE) {
      const chunk = spineItems.slice(i, i + CHUNK_SIZE);
      const fragment = document.createDocumentFragment();

      for (const item of chunk) {
        const chapterEl = this.getOrCreateChapterElement(item, cachedElements);
        this.loadedChapterWindow.add(item.index);
        this.chapterElements.set(item.index, chapterEl);
        fragment.appendChild(chapterEl);
      }

      this.container!.appendChild(fragment);

      // Yield to main thread between chunks (except for last chunk)
      if (i + CHUNK_SIZE < spineItems.length) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    }
  }

  /**
   * Get cached element or create new one
   * Phase 2: Always apply per-chapter column styles (even to cached elements)
   */
  private getOrCreateChapterElement(
    item: SpineItemContent,
    cachedElements?: Map<number, HTMLElement>
  ): HTMLElement {
    let chapterEl: HTMLElement;

    if (cachedElements?.has(item.index)) {
      const cached = cachedElements.get(item.index)!;
      if (cached.innerHTML && !cached.classList.contains('epub-chapter-placeholder')) {
        chapterEl = cached.cloneNode(true) as HTMLElement;
      } else {
        chapterEl = this.createChapterElement(item);
        return chapterEl; // Already has correct styles from createChapterElement
      }
    } else {
      chapterEl = this.createChapterElement(item);
      return chapterEl; // Already has correct styles from createChapterElement
    }

    // Phase 2: Apply per-chapter column styles to cached elements
    const { height } = this.getIntegerDimensions();
    const effectiveMargin = Math.max(this.config.margin, 10);

    // Get estimated position from layout calculations
    // Include margin offset since absolute positioning ignores container padding
    const containerWidth = this.columnWidth + this.gap;
    const columnOffset = this.chapterColumnOffsets.get(item.index) ?? 0;
    const leftPosition = this.margin + columnOffset * containerWidth;

    // Estimate width based on content length
    const estimatedColumns = Math.max(1, Math.ceil((item.html?.length || 3000) / 2500));
    // Use correct width formula: N * columnWidth + (N-1) * gap
    const estimatedWidth = this.calculateChapterWidth(estimatedColumns);

    chapterEl.style.cssText = `
      position: absolute;
      top: ${effectiveMargin}px;
      left: ${leftPosition}px;
      width: ${estimatedWidth}px;
      height: ${height - 2 * effectiveMargin}px;
      box-sizing: border-box;
      column-count: ${estimatedColumns};
      column-gap: ${this.gap}px;
      column-fill: auto;
      overflow: hidden;
    `;

    return chapterEl;
  }

  /**
   * Create a placeholder element for chapters outside the loading window
   * Phase 2: Placeholders use absolute positioning like real chapters
   */
  private createPlaceholderElement(item: SpineItemContent): HTMLElement {
    const chapterEl = document.createElement('div');
    chapterEl.className = 'epub-chapter epub-chapter-placeholder';
    chapterEl.dataset.spineIndex = String(item.index);
    chapterEl.dataset.href = item.href;

    // Estimate columns based on content length (rough: 1 column per 2500 chars)
    const estimatedColumns = Math.max(1, Math.ceil((item.html?.length || 3000) / 2500));
    const containerWidth = this.columnWidth + this.gap;
    // Use correct width formula: N * columnWidth + (N-1) * gap
    const estimatedWidth = this.calculateChapterWidth(estimatedColumns);

    // Get estimated position from our layout calculations
    // Include margin offset since absolute positioning ignores container padding
    const columnOffset = this.chapterColumnOffsets.get(item.index) ?? 0;
    const leftPosition = this.margin + columnOffset * containerWidth;

    // DEBUG: Log placeholder positioning (only first few and sample)
    if (item.index < 3 || item.index === 100) {
      console.log(`[Placeholder ${item.index}]`, {
        margin: this.margin,
        columnOffset,
        containerWidth,
        leftPosition,
        estimatedColumns,
        estimatedWidth,
        formula: `left = ${this.margin} + ${columnOffset} * ${containerWidth} = ${leftPosition}`
      });
    }

    const { height } = this.getIntegerDimensions();
    const effectiveMargin = Math.max(this.config.margin, 10);

    // Phase 2: Absolute positioning for placeholders
    chapterEl.style.cssText = `
      position: absolute;
      top: ${effectiveMargin}px;
      left: ${leftPosition}px;
      width: ${estimatedWidth}px;
      height: ${height - 2 * effectiveMargin}px;
      background: var(--background-secondary, #f5f5f5);
      opacity: 0.3;
    `;

    return chapterEl;
  }

  /**
   * Update the chapter loading window based on current position
   * Loads nearby chapters and unloads distant ones
   */
  private async updateChapterWindow(targetSpineIndex: number): Promise<void> {
    const startIdx = Math.max(0, targetSpineIndex - this.windowSize);
    const endIdx = Math.min(this.spineItems.length - 1, targetSpineIndex + this.windowSize);

    // Load chapters that should be in window but aren't loaded
    for (let i = startIdx; i <= endIdx; i++) {
      if (!this.loadedChapterWindow.has(i)) {
        await this.loadChapterContent(i);
      }
    }

    // Unload chapters that are far outside the window (keep a buffer)
    const unloadDistance = this.windowSize + 2;
    for (const loadedIdx of this.loadedChapterWindow) {
      if (Math.abs(loadedIdx - targetSpineIndex) > unloadDistance) {
        this.unloadChapterContent(loadedIdx);
      }
    }
  }

  /**
   * Load content for a specific chapter.
   * Includes retry logic for chapters that failed to load initially.
   */
  private async loadChapterContent(index: number): Promise<void> {
    const item = this.spineItems[index];
    const element = this.chapterElements.get(index);

    if (!item || !element || this.loadedChapterWindow.has(index)) return;

    // Check if the chapter has error placeholder content
    const isErrorPlaceholder = item.html.includes('class="error"') ||
                               item.html.includes('Failed to load chapter');

    // If it's an error placeholder and we have a refetcher, try to reload
    if (isErrorPlaceholder && this.config.chapterRefetcher) {
      const freshHtml = await this.loadChapterWithRetry(index, item.href, 2);
      if (freshHtml) {
        // Update the cached content with fresh HTML
        item.html = freshHtml;
      } else {
        // Retry failed, emit navigation failed event
        this.emit('navigationFailed', {
          spineIndex: index,
          href: item.href,
          reason: 'Failed to load chapter after multiple retries',
        });
      }
    }

    // Create loaded element and replace placeholder
    const loadedEl = this.createChapterElement(item);
    element.replaceWith(loadedEl);
    this.chapterElements.set(index, loadedEl);
    this.loadedChapterWindow.add(index);

    // Recalculate column offset for this chapter (it may differ from placeholder estimate)
    this.recalculateChapterLayout(index);
  }

  /**
   * Attempt to load a chapter with retry and exponential backoff.
   * @returns Fresh HTML content if successful, null if all retries failed.
   */
  private async loadChapterWithRetry(
    index: number,
    href: string,
    maxRetries: number
  ): Promise<string | null> {
    if (!this.config.chapterRefetcher) return null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const freshHtml = await this.config.chapterRefetcher(index, href);
        if (freshHtml && !freshHtml.includes('class="error"')) {
          return freshHtml;
        }
      } catch (error) {
        console.warn(`[PaginatedNavigator] Retry ${attempt + 1}/${maxRetries + 1} failed for chapter ${index}:`, error);
      }

      // Exponential backoff before next retry
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }

    return null;
  }

  /**
   * Recalculate layout for a single chapter after content change
   * Phase 2: Also updates chapter positions
   * FIX 2.2: Batches updates during animation to prevent mid-navigation drift
   */
  private recalculateChapterLayout(index: number): void {
    const chapterEl = this.chapterElements.get(index);
    if (!chapterEl) return;

    const containerWidth = this.columnWidth + this.gap;
    // Use content-based measurement for accurate column count
    const chapterColumns = this.measureActualColumnCount(chapterEl, containerWidth);

    // FIX 2.2: If animating, queue the update instead of applying immediately
    if (this.isAnimating) {
      this.pendingLayoutUpdates.set(index, chapterColumns);
      this.scheduleLayoutUpdate();
      return;
    }

    this.applyLayoutUpdate(index, chapterColumns);
  }

  /**
   * FIX 2.2: Schedule layout update after animation completes
   */
  private scheduleLayoutUpdate(): void {
    if (this.layoutUpdatePending) return;
    this.layoutUpdatePending = true;

    // Apply after animation completes
    requestAnimationFrame(() => {
      if (!this.isAnimating) {
        this.applyPendingLayoutUpdates();
      } else {
        // Re-schedule if still animating
        this.layoutUpdatePending = false;
        this.scheduleLayoutUpdate();
      }
    });
  }

  /**
   * FIX 2.2: Apply all pending layout updates atomically
   */
  private applyPendingLayoutUpdates(): void {
    this.layoutUpdatePending = false;

    for (const [index, columns] of this.pendingLayoutUpdates) {
      this.applyLayoutUpdate(index, columns);
    }
    this.pendingLayoutUpdates.clear();
  }

  /**
   * FIX 2.2: Apply a single layout update
   */
  private applyLayoutUpdate(index: number, chapterColumns: number): void {
    const chapterEl = this.chapterElements.get(index);
    if (!chapterEl) return;

    const containerWidth = this.columnWidth + this.gap;
    const oldColumns = this.chapterColumnCounts.get(index) ?? 0;

    this.chapterColumnCounts.set(index, chapterColumns);
    this.accurateColumnCounts.add(index);
    // Use correct width formula and column-count for exact alignment
    const chapterWidth = this.calculateChapterWidth(chapterColumns);
    chapterEl.style.width = `${chapterWidth}px`;
    chapterEl.style.columnCount = String(chapterColumns);

    const delta = chapterColumns - oldColumns;
    if (delta !== 0) {
      this.totalColumns += delta;

      for (let i = index + 1; i < this.spineItems.length; i++) {
        const currentOffset = this.chapterColumnOffsets.get(i) ?? 0;
        const newOffset = currentOffset + delta;
        this.chapterColumnOffsets.set(i, newOffset);

        const subsequentEl = this.chapterElements.get(i);
        if (subsequentEl) {
          // Include margin since absolute positioning ignores container padding
          subsequentEl.style.left = `${this.margin + newOffset * containerWidth}px`;
        }
      }
    }
  }

  /**
   * FIX 2.4: Consistent column count calculation
   * Uses Math.round() for deterministic, balanced rounding
   */
  private calculateColumnCount(scrollWidth: number, containerWidth: number): number {
    return Math.max(1, Math.round(scrollWidth / containerWidth));
  }

  /**
   * Measure actual content column count by finding unique column positions.
   * This is more accurate than scrollWidth which returns container width, not content extent.
   *
   * The scrollWidth approach fails because:
   * - When you set a large width with column-width, browser creates that many column slots
   * - scrollWidth returns the container width, not how much content actually fills
   * - This causes 4-5x overestimation of column counts
   *
   * This method instead finds actual content positions by measuring where paragraphs land.
   */
  private measureActualColumnCount(chapterEl: HTMLElement, containerWidth: number): number {
    // Find content elements (paragraphs, headings, etc.)
    const contentElements = chapterEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, img');

    if (contentElements.length === 0) {
      // Fallback: use scrollWidth if no content elements
      return this.calculateColumnCount(chapterEl.scrollWidth, containerWidth);
    }

    const chapterRect = chapterEl.getBoundingClientRect();
    const columnPositions = new Set<number>();

    for (const el of contentElements) {
      const rect = el.getBoundingClientRect();
      // Skip zero-width elements (like hidden elements)
      if (rect.width === 0) continue;

      // Calculate which column this element is in
      const relativeLeft = rect.left - chapterRect.left;
      const columnIndex = Math.round(relativeLeft / containerWidth);
      columnPositions.add(columnIndex);
    }

    // The actual column count is the number of unique column positions used
    return Math.max(1, columnPositions.size);
  }

  /**
   * Calculate the correct CSS width for a chapter with N columns.
   * Width = N * columnWidth + (N-1) * gap
   * This ensures CSS column-count creates exact column widths matching our navigation grid.
   */
  private calculateChapterWidth(columnCount: number): number {
    // For N columns: width = N * columnWidth + (N-1) * gap
    // This simplifies to: N * (columnWidth + gap) - gap = N * pageWidth - gap
    return columnCount * (this.columnWidth + this.gap) - this.gap;
  }

  /**
   * Unload a chapter's content to free memory
   */
  private unloadChapterContent(index: number): void {
    const item = this.spineItems[index];
    const element = this.chapterElements.get(index);

    if (!item || !element || !this.loadedChapterWindow.has(index)) return;

    // Create placeholder and replace loaded element
    const placeholderEl = this.createPlaceholderElement(item);
    element.replaceWith(placeholderEl);
    this.chapterElements.set(index, placeholderEl);
    this.loadedChapterWindow.delete(index);
  }

  destroy(): void {
    this._isReady = false;

    // Clean up resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Clean up wheel handler
    if (this.container) {
      if (this.boundHandleWheel) {
        this.container.removeEventListener('wheel', this.boundHandleWheel);
        this.boundHandleWheel = null;
      }
    }

    // Clean up timers
    if (this.resizeDebounceTimer !== null) {
      window.clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    if (this.configUpdateTimer !== null) {
      window.clearTimeout(this.configUpdateTimer);
      this.configUpdateTimer = null;
    }
    this.pendingConfigUpdate = null;

    // Clear listeners
    this.listeners.clear();

    // Clear content
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.container = null;
    this.chapterElements.clear();
    this.spineItems = [];
  }

  // ============================================================================
  // Container Styling
  // ============================================================================

  private applyContainerStyles(): void {
    if (!this.container) return;

    // Calculate integer dimensions
    const { width, height } = this.getIntegerDimensions();

    // Calculate column configuration
    const effectiveColumns = this.calculateEffectiveColumns(width);
    const totalGap = (effectiveColumns - 1) * this.config.columnGap;

    // Minimum margin for usability (10px to prevent cramped layouts)
    const effectiveMargin = Math.max(this.config.margin, 10);

    // Force integer column width to prevent sub-pixel drift
    // This is the KEY algorithm for zero drift
    this.columnWidth = Math.floor((width - 2 * effectiveMargin - totalGap) / effectiveColumns);
    this.columnCount = effectiveColumns;
    this.gap = this.config.columnGap;

    // Calculate exact content width (integer-forced)
    const exactContentWidth = this.columnWidth * effectiveColumns + totalGap;
    const actualMargin = Math.floor((width - exactContentWidth) / 2);

    // Store margin for chapter positioning and navigation transforms
    this.margin = actualMargin;

    // DEBUG: Log all layout calculations
    console.log('[Layout] Container dimensions:', { width, height });
    console.log('[Layout] Column config:', {
      effectiveColumns,
      columnWidth: this.columnWidth,
      gap: this.gap,
      totalGap,
      exactContentWidth,
      actualMargin: this.margin,
      pageWidth: this.columnWidth + this.gap
    });

    // Use transform-based pagination for clean clipping and virtualization
    // Each chapter will have its own CSS columns, navigated via translate3d
    // NOTE: overflow is NOT hidden here - viewport-wrapper handles clipping
    // Content-container must allow absolutely-positioned chapters to extend beyond bounds
    this.container.style.cssText = `
      width: ${width}px;
      height: ${height}px;
      overflow: visible;
      position: relative;
      box-sizing: border-box;
      --page-margin: ${actualMargin}px;
      --page-mask-width: ${Math.min(30, actualMargin)}px;
    `;

    // Phase 2: NO CSS columns on main container
    // Each chapter gets its own CSS columns for per-chapter pagination
    // This enables virtualization (only load 3-5 chapters at a time)
    // NOTE: For paginated mode, we DON'T use horizontal padding because absolute positioning
    // ignores padding. Instead, margin is added to chapter left positioning.
    // Vertical padding is still used for top/bottom margins.
    this.container.style.paddingLeft = '0px';
    this.container.style.paddingRight = '0px';
    this.container.style.paddingTop = `${effectiveMargin}px`;
    this.container.style.paddingBottom = `${effectiveMargin}px`;

    // Store column dimensions for chapter CSS
    this.pageWidth = this.columnWidth + this.gap;

    // Typography
    this.container.style.fontSize = `${this.config.fontSize}px`;
    this.container.style.fontFamily = this.config.fontFamily;
    this.container.style.lineHeight = `${this.config.lineHeight}`;
    this.container.style.textAlign = this.config.textAlign;

    // Theme
    this.container.style.backgroundColor = this.config.theme.background;
    this.container.style.color = this.config.theme.foreground;

    // NOTE: overflow:visible is intentional - viewport-wrapper handles clipping
    // The content-container must allow chapters to extend beyond for transform-based nav
  }

  /**
   * Get integer-forced dimensions to prevent sub-pixel drift
   */
  private getIntegerDimensions(): { width: number; height: number } {
    if (!this.container?.parentElement) {
      return { width: 800, height: 600 };
    }

    const rect = this.container.parentElement.getBoundingClientRect();
    return {
      width: Math.floor(rect.width),
      height: Math.floor(rect.height),
    };
  }

  /**
   * Calculate effective column count based on width and config
   */
  private calculateEffectiveColumns(width: number): number {
    const { columns } = this.config;

    if (columns === 'single') return 1;
    if (columns === 'dual') return 2;

    // Auto: use 2 columns if width > 1000px
    return width > 1000 ? 2 : 1;
  }

  // ============================================================================
  // Chapter Element Creation
  // ============================================================================

  private createChapterElement(item: SpineItemContent): HTMLElement {
    const chapterEl = document.createElement('div');
    chapterEl.className = 'epub-chapter';
    chapterEl.dataset.spineIndex = String(item.index);
    chapterEl.dataset.href = item.href;

    // Parse and insert HTML content
    chapterEl.innerHTML = item.html;

    // Phase 2: Per-chapter CSS columns
    // Each chapter is its own multi-column container, enabling virtualization
    const { height } = this.getIntegerDimensions();
    const effectiveMargin = Math.max(this.config.margin, 10);

    // Get estimated position from layout calculations
    // Include margin offset since absolute positioning ignores container padding
    const containerWidth = this.columnWidth + this.gap;
    const columnOffset = this.chapterColumnOffsets.get(item.index) ?? 0;
    const leftPosition = this.margin + columnOffset * containerWidth;

    // Estimate width based on content length (will be refined during accurate layout)
    const estimatedColumns = Math.max(1, Math.ceil((item.html?.length || 3000) / 2500));
    // Use correct width formula: N * columnWidth + (N-1) * gap
    const estimatedWidth = this.calculateChapterWidth(estimatedColumns);

    // DEBUG: Log chapter positioning (only first few and sample)
    if (item.index < 3 || item.index === 100) {
      console.log(`[Chapter ${item.index}]`, {
        margin: this.margin,
        columnOffset,
        containerWidth,
        leftPosition,
        estimatedColumns,
        estimatedWidth,
        formula: `left = ${this.margin} + ${columnOffset} * ${containerWidth} = ${leftPosition}`
      });
    }

    // Apply chapter-specific styles plus column break handling FIRST
    const columnStyles = `
      /* Prevent awkward column breaks */
      p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, table {
        break-inside: avoid-column;
        orphans: 2;
        widows: 2;
      }
      /* Keep headings with following content */
      h1, h2, h3, h4, h5, h6 {
        break-after: avoid-column;
      }
      /* Prevent images from splitting across columns */
      img, svg, figure {
        break-inside: avoid;
        max-width: 100%;
        height: auto;
      }
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = columnStyles + (item.css || '');
    chapterEl.insertBefore(styleEl, chapterEl.firstChild);

    // PHASE 1: Set up with column-width to let browser determine actual column count
    // Use a very large width to allow content to flow naturally
    const maxEstimatedWidth = estimatedColumns * 2 * containerWidth; // 2x estimate as buffer
    chapterEl.style.cssText = `
      position: absolute;
      top: ${effectiveMargin}px;
      left: ${leftPosition}px;
      width: ${maxEstimatedWidth}px;
      height: ${height - 2 * effectiveMargin}px;
      box-sizing: border-box;
      column-width: ${this.columnWidth}px;
      column-gap: ${this.gap}px;
      column-fill: auto;
      overflow: visible;
    `;

    // PHASE 2: Measure actual content and set precise column-count
    // This happens after DOM insertion, so we schedule it
    requestAnimationFrame(() => {
      if (!chapterEl.isConnected) return;

      // Use content-based measurement instead of scrollWidth
      // scrollWidth returns container width, not actual content extent
      const actualColumns = this.measureActualColumnCount(chapterEl, containerWidth);
      const actualWidth = this.calculateChapterWidth(actualColumns);

      // Lock down with column-count to prevent drift
      chapterEl.style.width = `${actualWidth}px`;
      chapterEl.style.columnWidth = '';  // Remove column-width
      chapterEl.style.columnCount = String(actualColumns);
      chapterEl.style.overflow = 'hidden';

      // Update our tracking
      this.chapterColumnCounts.set(item.index, actualColumns);
      this.accurateColumnCounts.add(item.index);

      // Recalculate offsets if this chapter's column count changed significantly
      const previousColumns = estimatedColumns;
      if (actualColumns !== previousColumns) {
        // Trigger a lazy recalculation for subsequent chapters
        this.recalculateChapterLayout(item.index);
      }
    });

    return chapterEl;
  }

  // ============================================================================
  // Layout Calculation
  // ============================================================================

  /**
   * Calculate layout and column offsets for all chapters.
   * Uses ESTIMATION for large books to avoid blocking - accurate measurement happens lazily.
   */
  private async calculateLayout(): Promise<void> {
    if (!this.container) return;

    const containerWidth = this.columnWidth + this.gap;
    if (containerWidth <= 0) return;

    // Clear accurate tracking
    this.accurateColumnCounts.clear();

    // For small books, calculate synchronously with accurate measurements
    if (this.chapterElements.size <= 20) {
      this.calculateLayoutSync(containerWidth);
      return;
    }

    // For large books, use estimation-based layout (FAST)
    await this.calculateLayoutEstimated(containerWidth);
  }

  /**
   * Synchronous layout calculation for small books (accurate measurement)
   * Phase 2: Also positions chapters absolutely at their column offsets
   */
  private calculateLayoutSync(containerWidth: number): void {
    let totalColumns = 0;

    for (const [index, chapterEl] of this.chapterElements) {
      this.chapterColumnOffsets.set(index, totalColumns);

      // Phase 2: Position chapter at its column offset
      // Include margin since absolute positioning ignores container padding
      const leftPosition = this.margin + totalColumns * containerWidth;
      chapterEl.style.left = `${leftPosition}px`;

      // Use content-based measurement for accurate column count
      const chapterColumns = this.measureActualColumnCount(chapterEl, containerWidth);
      this.chapterColumnCounts.set(index, chapterColumns);
      this.accurateColumnCounts.add(index);

      // Set chapter width using correct formula and column-count for exact alignment
      const chapterWidth = this.calculateChapterWidth(chapterColumns);
      chapterEl.style.width = `${chapterWidth}px`;
      chapterEl.style.columnCount = String(chapterColumns);

      totalColumns += chapterColumns;
    }

    this.totalColumns = totalColumns;
  }

  /**
   * Estimation-based layout for large books.
   * Uses content length to estimate columns - NO reflow triggered.
   * Accurate measurements happen lazily during navigation.
   * NOTE: This only updates offset maps, NOT element positions.
   * Elements are positioned during creation (createPlaceholderElement/createChapterElement)
   * and refined during refineColumnsAroundPosition for nearby chapters.
   */
  private async calculateLayoutEstimated(containerWidth: number): Promise<void> {
    console.log(`[PaginatedNav] calculateLayoutEstimated: ${this.spineItems.length} items, containerWidth=${containerWidth}`);
    const startTime = performance.now();
    let totalColumns = 0;

    // Estimate columns based on content length (chars per column estimate)
    // Average: ~2500 chars per column at default font size
    const charsPerColumn = 2500;

    for (let i = 0; i < this.spineItems.length; i++) {
      const item = this.spineItems[i];
      const contentLength = item.html?.length || 3000;
      const estimatedColumns = Math.max(1, Math.ceil(contentLength / charsPerColumn));

      this.chapterColumnOffsets.set(item.index, totalColumns);
      this.chapterColumnCounts.set(item.index, estimatedColumns);

      // NOTE: DO NOT set element positions here - it triggers massive reflows
      // with 277 chapters. Elements are already positioned during creation.
      // Positions are refined lazily in refineColumnsAroundPosition.

      totalColumns += estimatedColumns;
    }

    this.totalColumns = totalColumns;
    console.log(`[PaginatedNav] calculateLayoutEstimated done: ${totalColumns} total columns in ${(performance.now() - startTime).toFixed(1)}ms`);
  }

  /**
   * Lazily measure accurate column counts for chapters around the current position.
   * Called during navigation to refine estimates without blocking.
   * Phase 2: Also updates chapter positions after recalculation
   */
  private refineColumnsAroundPosition(spineIndex: number): void {
    if (!this.container) return;

    const containerWidth = this.columnWidth + this.gap;
    if (containerWidth <= 0) return;

    const startIdx = Math.max(0, spineIndex - this.ACCURATE_WINDOW);
    const endIdx = Math.min(this.spineItems.length - 1, spineIndex + this.ACCURATE_WINDOW);

    let needsRecalculation = false;

    // Check if any nearby chapters need accurate measurement
    for (let i = startIdx; i <= endIdx; i++) {
      if (!this.accurateColumnCounts.has(i)) {
        needsRecalculation = true;
        break;
      }
    }

    if (!needsRecalculation) return;

    // Recalculate all column offsets with accurate measurements for window
    let totalColumns = 0;
    for (let i = 0; i < this.spineItems.length; i++) {
      this.chapterColumnOffsets.set(i, totalColumns);

      // Measure accurately if in window, otherwise keep estimate
      const chapterEl = this.chapterElements.get(i);
      if (i >= startIdx && i <= endIdx && chapterEl) {
        // Use content-based measurement for accurate column count
        const chapterColumns = this.measureActualColumnCount(chapterEl, containerWidth);
        this.chapterColumnCounts.set(i, chapterColumns);
        this.accurateColumnCounts.add(i);
      }

      const columns = this.chapterColumnCounts.get(i) || 1;

      // Phase 2: Update chapter position
      // Include margin since absolute positioning ignores container padding
      if (chapterEl) {
        const leftPosition = this.margin + totalColumns * containerWidth;
        chapterEl.style.left = `${leftPosition}px`;
        // Use correct width formula and column-count for exact alignment
        const chapterWidth = this.calculateChapterWidth(columns);
        chapterEl.style.width = `${chapterWidth}px`;
        chapterEl.style.columnCount = String(columns);
      }

      totalColumns += columns;
    }

    this.totalColumns = totalColumns;
  }

  // ============================================================================
  // Navigation Methods
  // ============================================================================

  async goTo(target: NavigationTarget, options?: NavigationOptions): Promise<boolean> {
    if (!this.container || this.isAnimating) {
      return false;
    }

    const instant = options?.instant ?? false;

    let targetColumn = 0;
    let targetSpineIndex = 0;

    switch (target.type) {
      case 'position':
        targetSpineIndex = Math.min(target.position, this.spineItems.length - 1);
        targetColumn = this.chapterColumnOffsets.get(targetSpineIndex) ?? 0;
        break;

      case 'href':
        targetSpineIndex = this.findSpineIndexByHref(target.href);
        if (targetSpineIndex === -1) return false;

        // Phase 3: Update chapter window to ensure target chapter is loaded
        await this.updateChapterWindow(targetSpineIndex);

        // Refine column counts around target position (lazy accurate measurement)
        this.refineColumnsAroundPosition(targetSpineIndex);

        targetColumn = this.chapterColumnOffsets.get(targetSpineIndex) ?? 0;

        // If href has a fragment (#id), try to navigate to that element
        let blinkTarget: HTMLElement | null = null;
        if (target.href.includes('#')) {
          const fragment = target.href.split('#')[1];
          if (fragment) {
            const targetElement = this.findElementById(fragment, targetSpineIndex);
            if (targetElement) {
              // Calculate which column contains this element
              const elementColumn = this.getColumnForElement(targetElement, targetSpineIndex);
              if (elementColumn !== null) {
                targetColumn = elementColumn;
              }
              blinkTarget = targetElement;
            }
          }
        }

        // Perform navigation and then trigger blink animation
        await this.navigateToColumn(targetColumn, instant);
        this.currentSpineIndex = targetSpineIndex;
        this.currentColumn = targetColumn;
        this.updateCurrentLocator();

        // Phase 6: Add delay after navigation before triggering blink
        // This ensures the view has settled and the element is visible
        if (blinkTarget) {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          this.triggerBlinkAnimation(blinkTarget);
        }

        // Emit events
        this.emit('chapterVisible', { spineIndex: targetSpineIndex, visible: true });
        if (this.currentLocator) {
          this.emit('relocated', this.currentLocator);
        }
        return true;

      case 'cfi':
        // Phase 5: Fix CFI navigation with proper chapter preloading
        // 1. Extract spine index from CFI first
        const cfiSpineIndex = getSpineIndexFromCfi(target.cfi);
        if (cfiSpineIndex === null || cfiSpineIndex < 0 || cfiSpineIndex >= this.spineItems.length) {
          console.warn('[Navigator] Invalid CFI spine index:', cfiSpineIndex);
          return false;
        }
        targetSpineIndex = cfiSpineIndex;

        // 2. Load the chapter window BEFORE trying to resolve CFI
        await this.updateChapterWindow(targetSpineIndex);
        this.refineColumnsAroundPosition(targetSpineIndex);

        // 3. Wait for render to complete
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        // 4. Get the chapter element and resolve CFI
        const cfiChapterEl = this.chapterElements.get(targetSpineIndex);
        if (cfiChapterEl && this.loadedChapterWindow.has(targetSpineIndex)) {
          try {
            // Resolve CFI to find the target node
            const resolution = await resolveCfi(document, target.cfi);
            if (resolution && resolution.node) {
              // Find the element containing this node
              let targetEl: HTMLElement | null = null;
              if (resolution.node.nodeType === Node.TEXT_NODE) {
                targetEl = resolution.node.parentElement;
              } else if (resolution.node.nodeType === Node.ELEMENT_NODE) {
                targetEl = resolution.node as HTMLElement;
              }

              if (targetEl && cfiChapterEl.contains(targetEl)) {
                // Calculate which column contains this element
                const elementColumn = this.getColumnForElement(targetEl, targetSpineIndex);
                if (elementColumn !== null) {
                  targetColumn = elementColumn;
                  // Navigate and trigger blink
                  await this.navigateToColumn(targetColumn, instant);
                  this.currentSpineIndex = targetSpineIndex;
                  this.currentColumn = targetColumn;
                  this.updateCurrentLocator();
                  this.triggerBlinkAnimation(targetEl);

                  // Emit events
                  this.emit('chapterVisible', { spineIndex: targetSpineIndex, visible: true });
                  if (this.currentLocator) {
                    this.emit('relocated', this.currentLocator);
                  }
                  return true;
                }
              }
            }
          } catch (err) {
            console.warn('[Navigator] CFI resolution failed:', err);
          }
        }

        // Fallback: Navigate to chapter start if CFI resolution failed
        targetColumn = this.chapterColumnOffsets.get(targetSpineIndex) ?? 0;
        break;

      case 'progression':
        // Calculate column from overall progression
        targetColumn = Math.floor(target.progression * this.totalColumns);
        targetSpineIndex = this.getSpineIndexFromColumn(targetColumn);
        break;

      case 'locator':
        const locator = target.locator;
        targetSpineIndex = this.spineItems.findIndex(item => item.href === locator.href);
        if (targetSpineIndex === -1) return false;

        const chapterOffset = this.chapterColumnOffsets.get(targetSpineIndex) ?? 0;
        const chapterColumns = this.chapterColumnCounts.get(targetSpineIndex) ?? 1;
        const progressionColumn = Math.floor(locator.locations.progression * chapterColumns);
        targetColumn = chapterOffset + progressionColumn;
        break;
    }

    // Phase 3: Update chapter window BEFORE navigation to ensure content is loaded
    await this.updateChapterWindow(targetSpineIndex);

    // Refine column counts around target position (lazy accurate measurement)
    this.refineColumnsAroundPosition(targetSpineIndex);

    // Recalculate target column after refinement (may have changed)
    if (target.type === 'position') {
      targetColumn = this.chapterColumnOffsets.get(targetSpineIndex) ?? targetColumn;
    }

    // Perform navigation
    await this.navigateToColumn(targetColumn, instant);

    // Update state
    this.currentSpineIndex = targetSpineIndex;
    this.currentColumn = targetColumn;
    this.updateCurrentLocator();

    // Emit events
    this.emit('chapterVisible', { spineIndex: targetSpineIndex, visible: true });
    if (this.currentLocator) {
      this.emit('relocated', this.currentLocator);
    }

    return true;
  }

  async next(): Promise<boolean> {
    // Prevent navigation during animation to avoid drift from rapid clicks
    if (this.isAnimating) {
      return false;
    }

    const nextColumn = this.currentColumn + this.columnCount;

    if (nextColumn >= this.totalColumns) {
      return false; // At end
    }

    // FIX 2.1: Calculate target spine index BEFORE navigation
    const targetSpineIndex = this.getSpineIndexFromColumn(nextColumn);

    // Only load chapters if target is not already loaded (expensive)
    if (!this.loadedChapterWindow.has(targetSpineIndex)) {
      await this.updateChapterWindow(targetSpineIndex);
    }

    // ALWAYS refine column positions to prevent drift
    // This ensures offsets are accurate before navigation
    this.refineColumnsAroundPosition(targetSpineIndex);

    this.emit('pageAnimationStart', { direction: 'forward' });

    await this.navigateToColumn(nextColumn, false);
    this.currentColumn = nextColumn;
    this.currentSpineIndex = targetSpineIndex;
    this.updateCurrentLocator();

    this.emit('pageAnimationEnd', { direction: 'forward' });
    if (this.currentLocator) {
      this.emit('relocated', this.currentLocator);
    }

    // Drift detection instrumentation
    this.detectAndLogDrift('next()');

    return true;
  }

  async prev(): Promise<boolean> {
    // Prevent navigation during animation to avoid drift from rapid clicks
    if (this.isAnimating) {
      return false;
    }

    const prevColumn = this.currentColumn - this.columnCount;

    if (prevColumn < 0) {
      return false; // At beginning
    }

    // FIX 2.1: Calculate target spine index BEFORE navigation
    const targetSpineIndex = this.getSpineIndexFromColumn(prevColumn);

    // Only load chapters if target is not already loaded (expensive)
    if (!this.loadedChapterWindow.has(targetSpineIndex)) {
      await this.updateChapterWindow(targetSpineIndex);
    }

    // ALWAYS refine column positions to prevent drift
    // This ensures offsets are accurate before navigation
    this.refineColumnsAroundPosition(targetSpineIndex);

    this.emit('pageAnimationStart', { direction: 'backward' });

    await this.navigateToColumn(prevColumn, false);
    this.currentColumn = prevColumn;
    this.currentSpineIndex = targetSpineIndex;
    this.updateCurrentLocator();

    this.emit('pageAnimationEnd', { direction: 'backward' });
    if (this.currentLocator) {
      this.emit('relocated', this.currentLocator);
    }

    // Drift detection instrumentation
    this.detectAndLogDrift('prev()');

    return true;
  }

  async nextChapter(): Promise<boolean> {
    const nextSpineIndex = this.currentSpineIndex + 1;

    if (nextSpineIndex >= this.spineItems.length) {
      return false;
    }

    return this.goTo({ type: 'position', position: nextSpineIndex });
  }

  async prevChapter(): Promise<boolean> {
    const prevSpineIndex = this.currentSpineIndex - 1;

    if (prevSpineIndex < 0) {
      return false;
    }

    return this.goTo({ type: 'position', position: prevSpineIndex });
  }

  // ============================================================================
  // Column Navigation
  // ============================================================================

  /**
   * Navigate to a specific column using CSS transforms
   * This uses translate3d for GPU-accelerated, clean-clipping navigation
   * NOTE: Transform must NOT include margin offset - chapters are positioned with margin,
   * so transform only needs to account for column offset. Adding margin to transform
   * would double-offset the content.
   */
  private async navigateToColumn(column: number, instant: boolean): Promise<void> {
    if (!this.container) return;

    const pageWidth = this.columnWidth + this.gap;
    // Transform moves by column offset only - margin is already in chapter positions
    const targetTranslateX = -(column * pageWidth);

    // DEBUG: Log navigation transform
    console.log(`[Navigate] column=${column}`, {
      pageWidth,
      targetTranslateX,
      margin: this.margin,
      formula: `translateX = -(${column} * ${pageWidth}) = ${targetTranslateX}`,
      instant
    });

    if (instant) {
      // Instant navigation: no transition
      this.container.style.transition = 'none';
      this.container.style.transform = `translate3d(${targetTranslateX}px, 0, 0)`;
      // Force reflow to apply transform immediately
      void this.container.offsetWidth;
      // FIX 2.3: Validate navigation state
      await this.validateNavigationState(column);
      return;
    }

    // Animated navigation using CSS transition
    this.isAnimating = true;

    await new Promise<void>(resolve => {
      if (!this.container) {
        this.isAnimating = false;
        resolve();
        return;
      }

      const handleTransitionEnd = () => {
        this.isAnimating = false;
        this.container?.removeEventListener('transitionend', handleTransitionEnd);
        resolve();
      };

      // Set up transition
      this.container.style.transition = 'transform 300ms ease-out';
      this.container.addEventListener('transitionend', handleTransitionEnd, { once: true });

      // Apply transform
      this.container.style.transform = `translate3d(${targetTranslateX}px, 0, 0)`;

      // Fallback timeout in case transitionend doesn't fire
      setTimeout(() => {
        if (this.isAnimating) {
          this.isAnimating = false;
          this.container?.removeEventListener('transitionend', handleTransitionEnd);
          resolve();
        }
      }, 400);
    });

    // FIX 2.3: Validate navigation state after animation
    await this.validateNavigationState(column);
  }

  // ============================================================================
  // Drift Detection (Permanent Instrumentation)
  // ============================================================================

  /**
   * Detect and log drift after navigation
   * Only runs when DEBUG_DRIFT is true
   */
  private detectAndLogDrift(operation: string): void {
    if (!this.DEBUG_DRIFT || !this.container) return;

    const pageWidth = this.columnWidth + this.gap;
    const expectedTranslateX = -(this.currentColumn * pageWidth);
    const actualTranslateX = this.getCurrentTransformX();
    const drift = actualTranslateX - expectedTranslateX;

    const entry = {
      step: this.driftStep++,
      operation,
      expectedColumn: this.currentColumn,
      actualTranslateX,
      currentSpineIndex: this.currentSpineIndex,
      loadedChapters: Array.from(this.loadedChapterWindow),
      chapterOffsets: Object.fromEntries(this.chapterColumnOffsets),
      drift,
    };

    this.driftLog.push(entry);

    if (Math.abs(drift) > 1) {
      console.warn(`[DRIFT] ${drift}px detected after ${operation}`, entry);
    }
  }

  /**
   * Get drift log for debugging (exposed for external access via MCP)
   */
  public getDriftLog(): typeof this.driftLog {
    return this.driftLog;
  }

  /**
   * Clear drift log
   */
  public clearDriftLog(): void {
    this.driftLog = [];
    this.driftStep = 0;
  }

  /**
   * Enable/disable drift detection at runtime
   */
  public setDebugDrift(enabled: boolean): void {
    this.DEBUG_DRIFT = enabled;
    if (enabled) {
      console.log('[Navigator] Drift detection enabled');
    } else {
      console.log('[Navigator] Drift detection disabled');
    }
  }

  // ============================================================================
  // Navigation Validation (Fix 2.3)
  // ============================================================================

  /**
   * FIX 2.3: Validate navigation state after navigation completes
   * Only performs drift detection and correction - chapter loading is handled by next()/prev()
   * Lightweight: skips validation if DEBUG_DRIFT is disabled to avoid performance impact
   */
  private async validateNavigationState(expectedColumn: number): Promise<void> {
    // Skip validation entirely if not debugging - this is a significant performance optimization
    if (!this.DEBUG_DRIFT || !this.container) return;

    // Wait for next frame to ensure transforms applied (only when debugging)
    await new Promise(r => requestAnimationFrame(r));

    const pageWidth = this.columnWidth + this.gap;
    const expectedTranslateX = -(expectedColumn * pageWidth);
    const actualTranslateX = this.getCurrentTransformX();
    const drift = Math.abs(actualTranslateX - expectedTranslateX);

    // Threshold: allow 1px tolerance for rounding
    if (drift > 1) {
      console.warn(`[Navigator] Position drift detected: ${drift}px, correcting...`);

      // Correct by re-applying transform
      this.container.style.transition = 'none';
      this.container.style.transform = `translate3d(${expectedTranslateX}px, 0, 0)`;
      void this.container.offsetWidth; // Force reflow
    }
  }

  // ============================================================================
  // Position Tracking
  // ============================================================================

  private getSpineIndexFromColumn(column: number): number {
    for (const [spineIndex, offset] of this.chapterColumnOffsets) {
      const columns = this.chapterColumnCounts.get(spineIndex) ?? 1;
      if (column >= offset && column < offset + columns) {
        return spineIndex;
      }
    }
    return this.spineItems.length - 1;
  }

  private updateCurrentLocator(): void {
    const spineItem = this.spineItems[this.currentSpineIndex];
    if (!spineItem) {
      this.currentLocator = null;
      return;
    }

    const chapterOffset = this.chapterColumnOffsets.get(this.currentSpineIndex) ?? 0;
    const chapterColumns = this.chapterColumnCounts.get(this.currentSpineIndex) ?? 1;
    const columnInChapter = this.currentColumn - chapterOffset;
    const progression = chapterColumns > 0 ? columnInChapter / chapterColumns : 0;
    const totalProgression = this.totalColumns > 0 ? this.currentColumn / this.totalColumns : 0;

    this.currentLocator = {
      href: spineItem.href,
      locations: {
        progression: Math.min(1, Math.max(0, progression)),
        totalProgression: Math.min(1, Math.max(0, totalProgression)),
        position: this.currentSpineIndex,
      },
    };
  }

  getCurrentLocation(): Locator | null {
    return this.currentLocator;
  }

  getPaginationInfo(): PaginationInfo | null {
    if (!this.currentLocator) return null;

    const chapterColumns = this.chapterColumnCounts.get(this.currentSpineIndex) ?? 1;
    const chapterOffset = this.chapterColumnOffsets.get(this.currentSpineIndex) ?? 0;
    const currentPageInChapter = this.currentColumn - chapterOffset + 1;
    const totalPagesInChapter = Math.ceil(chapterColumns / this.columnCount);

    return {
      currentPage: Math.ceil(currentPageInChapter / this.columnCount),
      totalPages: totalPagesInChapter,
      spineIndex: this.currentSpineIndex,
      totalSpineItems: this.spineItems.length,
      bookProgression: this.currentLocator.locations.totalProgression ?? 0,
      chapterTitle: this.spineItems[this.currentSpineIndex]?.href,
    };
  }

  isLocatorVisible(locator: Locator): boolean {
    if (!this.container) return false;

    const spineIndex = this.spineItems.findIndex(item => item.href === locator.href);
    if (spineIndex === -1) return false;

    const chapterOffset = this.chapterColumnOffsets.get(spineIndex) ?? 0;
    const chapterColumns = this.chapterColumnCounts.get(spineIndex) ?? 1;
    const locatorColumn = chapterOffset + Math.floor(locator.locations.progression * chapterColumns);

    // Check if locator column is within visible range
    return locatorColumn >= this.currentColumn &&
           locatorColumn < this.currentColumn + this.columnCount;
  }

  // ============================================================================
  // Navigation Feedback
  // ============================================================================

  /**
   * Trigger blink animation on an element to indicate navigation target
   * Uses the .highlight-blink class defined in shadow-dom-view.ts
   */
  private triggerBlinkAnimation(element: HTMLElement): void {
    // Remove existing animation class (in case of rapid navigation)
    element.classList.remove('highlight-blink');

    // Force reflow to restart animation
    void element.offsetWidth;

    // Add animation class
    element.classList.add('highlight-blink');

    // Remove class after animation completes (1.4s = 0.7s × 2 iterations)
    setTimeout(() => {
      element.classList.remove('highlight-blink');
    }, 1500);
  }

  // ============================================================================
  // Href Navigation Helpers
  // ============================================================================

  /**
   * Find spine index by href with fuzzy matching
   * Handles various href formats: relative, absolute, with/without extension
   */
  private findSpineIndexByHref(href: string): number {
    // Remove fragment
    const targetHref = href.split('#')[0];

    // Try exact match first
    let index = this.spineItems.findIndex(item => item.href === targetHref);
    if (index !== -1) return index;

    // Try without leading ./
    const normalized = targetHref.replace(/^\.\//, '');
    index = this.spineItems.findIndex(item => item.href.replace(/^\.\//, '') === normalized);
    if (index !== -1) return index;

    // Try matching just the filename
    const filename = targetHref.split('/').pop() || targetHref;
    index = this.spineItems.findIndex(item => {
      const itemFilename = item.href.split('/').pop() || item.href;
      return itemFilename === filename;
    });
    if (index !== -1) return index;

    // Try suffix match (item.href ends with targetHref)
    index = this.spineItems.findIndex(item => item.href.endsWith(targetHref));
    if (index !== -1) return index;

    // Try suffix match (targetHref ends with item.href)
    index = this.spineItems.findIndex(item => targetHref.endsWith(item.href));
    if (index !== -1) return index;

    // Try without extension
    const withoutExt = filename.replace(/\.(x?html?|xml)$/i, '');
    index = this.spineItems.findIndex(item => {
      const itemFilename = (item.href.split('/').pop() || item.href).replace(/\.(x?html?|xml)$/i, '');
      return itemFilename === withoutExt;
    });

    return index;
  }

  /**
   * Find an element by ID within a chapter
   */
  private findElementById(id: string, spineIndex: number): HTMLElement | null {
    const chapterEl = this.chapterElements.get(spineIndex);
    if (!chapterEl) return null;

    // Try direct ID match
    let element = chapterEl.querySelector(`#${CSS.escape(id)}`);
    if (element) return element as HTMLElement;

    // Try name attribute (for anchors)
    element = chapterEl.querySelector(`[name="${CSS.escape(id)}"]`);
    if (element) return element as HTMLElement;

    // Try data-id attribute
    element = chapterEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (element) return element as HTMLElement;

    return null;
  }

  /**
   * Get the column number containing a specific element
   */
  private getColumnForElement(element: HTMLElement, spineIndex: number): number | null {
    if (!this.container || this.columnWidth <= 0) return null;

    const chapterOffset = this.chapterColumnOffsets.get(spineIndex) ?? 0;
    const pageWidth = this.columnWidth + this.gap;

    // Get element's position relative to the container
    const containerRect = this.container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();

    // Get current transform offset (negative value)
    const currentTransformX = this.getCurrentTransformX();
    const elementLeft = elementRect.left - containerRect.left - currentTransformX;
    const elementColumn = Math.floor(elementLeft / pageWidth);

    return chapterOffset + elementColumn;
  }

  /**
   * Get the current translateX value from the container transform
   */
  private getCurrentTransformX(): number {
    if (!this.container) return 0;

    const transform = this.container.style.transform;
    if (!transform || transform === 'none') return 0;

    // Parse translate3d(Xpx, Ypx, Zpx) or translateX(Xpx)
    const match = transform.match(/translate3d\(([-\d.]+)px/);
    if (match) {
      return parseFloat(match[1]);
    }

    const matchX = transform.match(/translateX\(([-\d.]+)px/);
    if (matchX) {
      return parseFloat(matchX[1]);
    }

    return 0;
  }

  // ============================================================================
  // CFI Handling
  // ============================================================================

  private parseCfiToColumn(cfi: string): { spineIndex: number; column: number } | null {
    // TODO: Implement full CFI parsing
    // For now, extract spine index from CFI structure
    const match = cfi.match(/epubcfi\(\/(\d+)/);
    if (!match) return null;

    const spineStep = parseInt(match[1], 10);
    const spineIndex = Math.floor(spineStep / 2) - 1;

    if (spineIndex < 0 || spineIndex >= this.spineItems.length) {
      return null;
    }

    const chapterOffset = this.chapterColumnOffsets.get(spineIndex) ?? 0;
    return { spineIndex, column: chapterOffset };
  }

  getCfiRange(cfi: string): Range | null {
    // TODO: Implement CFI to Range conversion
    return null;
  }

  getRangeCfi(range: Range): string | null {
    // TODO: Implement Range to CFI conversion
    return null;
  }

  // ============================================================================
  // Configuration Methods
  // ============================================================================

  /**
   * Update configuration with debouncing to prevent UI freeze on rapid changes.
   * Typography changes (font size, line height) trigger expensive reflows,
   * so we debounce them to only apply after the user stops adjusting.
   */
  updateConfig(config: Partial<NavigatorConfig>): void {
    // Merge pending updates
    this.pendingConfigUpdate = { ...this.pendingConfigUpdate, ...config };

    // Clear existing timer
    if (this.configUpdateTimer !== null) {
      window.clearTimeout(this.configUpdateTimer);
    }

    // Debounce: wait 150ms before applying to allow rapid slider adjustments
    this.configUpdateTimer = window.setTimeout(() => {
      this.applyPendingConfigUpdate();
    }, 150);
  }

  /**
   * Apply pending configuration updates and reflow
   */
  private async applyPendingConfigUpdate(): Promise<void> {
    if (!this.pendingConfigUpdate) return;

    const updates = this.pendingConfigUpdate;
    this.pendingConfigUpdate = null;
    this.configUpdateTimer = null;

    // Apply config changes
    this.config = { ...this.config, ...updates };

    // Save current position before reflow
    const savedLocator = this.currentLocator;
    const savedSpineIndex = this.currentSpineIndex;

    // Apply styles and recalculate layout
    this.applyContainerStyles();
    await this.calculateLayout();

    // Restore position
    if (savedLocator) {
      await this.goTo({ type: 'locator', locator: savedLocator }, { instant: true });
    } else if (savedSpineIndex >= 0) {
      await this.goTo({ type: 'position', position: savedSpineIndex }, { instant: true });
    }
  }

  getConfig(): NavigatorConfig {
    return { ...this.config };
  }

  // ============================================================================
  // Content Access
  // ============================================================================

  getVisibleText(): string {
    // TODO: Implement visible text extraction
    return '';
  }

  getContentContainer(): HTMLElement {
    if (!this.container) {
      throw new Error('Navigator not initialized');
    }
    return this.container;
  }

  getColumnWidth(): number {
    return this.columnWidth;
  }

  getViewportDimensions(): { width: number; height: number } {
    return this.getIntegerDimensions();
  }

  // ============================================================================
  // Layout Methods
  // ============================================================================

  async reflow(): Promise<void> {
    if (!this.container) return;

    // Save current position
    const savedLocator = this.currentLocator;
    const savedSpineIndex = this.currentSpineIndex;

    // Recalculate styles (this updates columnWidth and gap)
    this.applyContainerStyles();

    // Update placeholder dimensions based on new column width
    this.updatePlaceholderDimensions();

    // Recalculate layout
    await this.calculateLayout();

    // Restore position
    if (savedLocator) {
      await this.goTo({ type: 'locator', locator: savedLocator }, { instant: true });
    } else if (savedSpineIndex >= 0) {
      await this.goTo({ type: 'position', position: savedSpineIndex }, { instant: true });
    }

    this.emit('resize', this.getIntegerDimensions());
  }

  /**
   * Update placeholder dimensions based on current column width
   */
  private updatePlaceholderDimensions(): void {
    for (const [index, element] of this.chapterElements) {
      if (element.classList.contains('epub-chapter-placeholder')) {
        const item = this.spineItems[index];
        const estimatedColumns = Math.max(1, Math.ceil((item?.html?.length || 3000) / 3000));
        const estimatedWidth = estimatedColumns * (this.columnWidth + this.gap);

        element.style.width = `${estimatedWidth}px`;
      }
    }
  }

  // ============================================================================
  // Resize Observer
  // ============================================================================

  private setupResizeObserver(): void {
    if (!this.container?.parentElement) return;

    this.resizeObserver = new ResizeObserver(() => {
      // Debounce resize handling
      if (this.resizeDebounceTimer !== null) {
        window.clearTimeout(this.resizeDebounceTimer);
      }

      this.resizeDebounceTimer = window.setTimeout(() => {
        this.reflow();
      }, 150);
    });

    this.resizeObserver.observe(this.container.parentElement);
  }

  // ============================================================================
  // Manual Scroll Handling (for swipe gestures)
  // ============================================================================

  /**
   * Setup wheel event listener for page navigation
   * With transform-based navigation, we only need wheel handling (no scroll events)
   */
  private setupScrollHandler(): void {
    if (!this.container) return;

    // Wheel handler for page turns
    this.boundHandleWheel = (e: WheelEvent) => this.handleWheel(e);
    this.container.addEventListener('wheel', this.boundHandleWheel, { passive: false });
  }

  /**
   * Handle wheel events to turn pages
   * Scrollwheel up/down or left/right triggers page navigation
   */
  private handleWheel(e: WheelEvent): void {
    // Don't handle if animating
    if (this.isAnimating) return;

    // Use deltaY for vertical scroll wheels, deltaX for horizontal
    // Most mice scroll vertically, but trackpads may scroll horizontally
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;

    // Threshold to prevent accidental page turns
    if (Math.abs(delta) < 30) return;

    // Prevent default scroll behavior
    e.preventDefault();

    // Navigate based on scroll direction
    if (delta > 0) {
      this.next();
    } else {
      this.prev();
    }
  }


  // ============================================================================
  // Event System
  // ============================================================================

  on<K extends keyof NavigatorEvents>(
    event: K,
    callback: NavigatorEventListener<K>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => this.off(event, callback);
  }

  off<K extends keyof NavigatorEvents>(
    event: K,
    callback: NavigatorEventListener<K>
  ): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit<K extends keyof NavigatorEvents>(event: K, data: NavigatorEvents[K]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (error) {
          console.error(`[PaginatedNavigator] Error in ${event} handler:`, error);
        }
      }
    }
  }
}

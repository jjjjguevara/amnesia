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

  // Content state
  private spineItems: SpineItemContent[] = [];
  private chapterElements: Map<number, HTMLElement> = new Map();
  private chapterColumnOffsets: Map<number, number> = new Map();
  private chapterColumnCounts: Map<number, number> = new Map();
  private accurateColumnCounts: Set<number> = new Set(); // Track which chapters have been accurately measured

  // Chapter windowing - only load chapters near current position for performance
  private loadedChapterWindow: Set<number> = new Set();
  private readonly WINDOW_SIZE = 3; // Load current chapter ± 3 chapters
  private readonly ACCURATE_WINDOW = 5; // Calculate accurate columns for ±5 chapters

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

  // Manual scroll handling (for swipe gestures)
  private scrollEndTimer: number | null = null;
  private isManualScrolling = false;
  private boundHandleScroll: (() => void) | null = null;
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
    if (!this.container) {
      throw new Error('Navigator not initialized');
    }

    this.emit('loading', true);

    try {
      this.spineItems = spineItems;

      // Clear existing content
      this.container.innerHTML = '';
      this.chapterElements.clear();
      this.chapterColumnOffsets.clear();
      this.chapterColumnCounts.clear();
      this.accurateColumnCounts.clear();
      this.loadedChapterWindow.clear();

      // NOTE: Paginated mode requires all content loaded for CSS columns to work properly.
      // Windowing/virtualization doesn't work with CSS multi-column layout because columns
      // are calculated based on content flow, not fixed positions.

      // For small books, insert all at once
      if (spineItems.length <= 20) {
        await this.loadContentSync(spineItems, cachedElements);
      } else {
        // For large books, insert in chunks to avoid UI freeze
        await this.loadContentChunked(spineItems, cachedElements);
      }

      // Calculate layout
      await this.calculateLayout();

      // Navigate to initial position
      if (initialLocator) {
        await this.goTo({ type: 'locator', locator: initialLocator }, { instant: true });
      } else {
        await this.goTo({ type: 'position', position: 0 }, { instant: true });
      }

      this.emit('rendered', { spineIndex: this.currentSpineIndex });
    } finally {
      this.emit('loading', false);
    }
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
   */
  private getOrCreateChapterElement(
    item: SpineItemContent,
    cachedElements?: Map<number, HTMLElement>
  ): HTMLElement {
    if (cachedElements?.has(item.index)) {
      const cached = cachedElements.get(item.index)!;
      if (cached.innerHTML && !cached.classList.contains('epub-chapter-placeholder')) {
        return cached.cloneNode(true) as HTMLElement;
      }
    }
    return this.createChapterElement(item);
  }

  /**
   * Create a placeholder element for chapters outside the loading window
   * Placeholders have estimated dimensions to maintain scroll position accuracy
   */
  private createPlaceholderElement(item: SpineItemContent): HTMLElement {
    const chapterEl = document.createElement('div');
    chapterEl.className = 'epub-chapter epub-chapter-placeholder';
    chapterEl.dataset.spineIndex = String(item.index);
    chapterEl.dataset.href = item.href;

    // Estimate height based on content length (rough: 1 column per 3000 chars)
    const estimatedColumns = Math.max(1, Math.ceil((item.html?.length || 3000) / 3000));
    const estimatedWidth = estimatedColumns * (this.columnWidth + this.gap);

    // Set inline-block to maintain column flow
    chapterEl.style.cssText = `
      display: inline-block;
      width: ${estimatedWidth}px;
      height: 100%;
      vertical-align: top;
    `;

    return chapterEl;
  }

  /**
   * Update the chapter loading window based on current position
   * Loads nearby chapters and unloads distant ones
   */
  private async updateChapterWindow(targetSpineIndex: number): Promise<void> {
    const startIdx = Math.max(0, targetSpineIndex - this.WINDOW_SIZE);
    const endIdx = Math.min(this.spineItems.length - 1, targetSpineIndex + this.WINDOW_SIZE);

    // Load chapters that should be in window but aren't loaded
    for (let i = startIdx; i <= endIdx; i++) {
      if (!this.loadedChapterWindow.has(i)) {
        await this.loadChapterContent(i);
      }
    }

    // Unload chapters that are far outside the window (keep a buffer)
    const unloadDistance = this.WINDOW_SIZE + 2;
    for (const loadedIdx of this.loadedChapterWindow) {
      if (Math.abs(loadedIdx - targetSpineIndex) > unloadDistance) {
        this.unloadChapterContent(loadedIdx);
      }
    }
  }

  /**
   * Load content for a specific chapter
   */
  private async loadChapterContent(index: number): Promise<void> {
    const item = this.spineItems[index];
    const element = this.chapterElements.get(index);

    if (!item || !element || this.loadedChapterWindow.has(index)) return;

    // Create loaded element and replace placeholder
    const loadedEl = this.createChapterElement(item);
    element.replaceWith(loadedEl);
    this.chapterElements.set(index, loadedEl);
    this.loadedChapterWindow.add(index);

    // Recalculate column offset for this chapter (it may differ from placeholder estimate)
    this.recalculateChapterLayout(index);
  }

  /**
   * Recalculate layout for a single chapter after content change
   */
  private recalculateChapterLayout(index: number): void {
    const chapterEl = this.chapterElements.get(index);
    if (!chapterEl) return;

    const containerWidth = this.columnWidth + this.gap;
    const scrollWidth = chapterEl.scrollWidth;
    const chapterColumns = Math.ceil(scrollWidth / containerWidth);

    // Update column count for this chapter
    const oldColumns = this.chapterColumnCounts.get(index) ?? 0;
    this.chapterColumnCounts.set(index, chapterColumns);

    // Adjust total columns
    const delta = chapterColumns - oldColumns;
    if (delta !== 0) {
      this.totalColumns += delta;

      // Update offsets for all subsequent chapters
      for (let i = index + 1; i < this.spineItems.length; i++) {
        const currentOffset = this.chapterColumnOffsets.get(i) ?? 0;
        this.chapterColumnOffsets.set(i, currentOffset + delta);
      }
    }
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

    // Clean up scroll and wheel handlers
    if (this.container) {
      if (this.boundHandleScroll) {
        this.container.removeEventListener('scroll', this.boundHandleScroll);
        this.boundHandleScroll = null;
      }
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
    if (this.scrollEndTimer !== null) {
      window.clearTimeout(this.scrollEndTimer);
      this.scrollEndTimer = null;
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

    // Increase effective margin for better reading experience (minimum 60px)
    const effectiveMargin = Math.max(this.config.margin, 60);

    // Force integer column width to prevent sub-pixel drift
    // This is the KEY algorithm for zero drift
    this.columnWidth = Math.floor((width - 2 * effectiveMargin - totalGap) / effectiveColumns);
    this.columnCount = effectiveColumns;
    this.gap = this.config.columnGap;

    // Calculate exact content width (integer-forced)
    const exactContentWidth = this.columnWidth * effectiveColumns + totalGap;
    const actualMargin = Math.floor((width - exactContentWidth) / 2);

    // Use scroll-based pagination instead of transform
    // This matches the proven approach from the iframe-based paginator
    this.container.style.cssText = `
      width: ${width}px;
      height: ${height}px;
      overflow-x: scroll;
      overflow-y: hidden;
      position: relative;
      box-sizing: border-box;
      scroll-snap-type: x mandatory;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch;
      --page-margin: ${actualMargin}px;
    `;

    // Hide scrollbar but keep scroll functionality
    this.container.style.scrollbarWidth = 'none'; // Firefox
    // @ts-ignore - WebKit scrollbar hiding
    this.container.style.msOverflowStyle = 'none'; // IE/Edge

    // Apply CSS columns to container
    // Use exact integer values to prevent drift
    this.container.style.columnWidth = `${this.columnWidth}px`;
    this.container.style.columnGap = `${this.gap}px`;
    this.container.style.columnFill = 'auto';
    this.container.style.paddingLeft = `${actualMargin}px`;
    this.container.style.paddingRight = `${actualMargin}px`;
    this.container.style.paddingTop = `${effectiveMargin}px`;
    this.container.style.paddingBottom = `${effectiveMargin}px`;

    // Typography
    this.container.style.fontSize = `${this.config.fontSize}px`;
    this.container.style.fontFamily = this.config.fontFamily;
    this.container.style.lineHeight = `${this.config.lineHeight}`;
    this.container.style.textAlign = this.config.textAlign;

    // Theme
    this.container.style.backgroundColor = this.config.theme.background;
    this.container.style.color = this.config.theme.foreground;
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

    // Apply chapter-specific styles plus column break handling
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

    // Note: scroll-snap-align doesn't work with CSS columns since columns
    // are virtual, not actual DOM elements. The snap must be handled via
    // JavaScript in handleScrollEnd() which snaps to column boundaries.

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
   */
  private calculateLayoutSync(containerWidth: number): void {
    let totalColumns = 0;

    for (const [index, chapterEl] of this.chapterElements) {
      this.chapterColumnOffsets.set(index, totalColumns);
      const scrollWidth = chapterEl.scrollWidth;
      const chapterColumns = Math.max(1, Math.ceil(scrollWidth / containerWidth));
      this.chapterColumnCounts.set(index, chapterColumns);
      this.accurateColumnCounts.add(index);
      totalColumns += chapterColumns;
    }

    this.totalColumns = totalColumns;
  }

  /**
   * Estimation-based layout for large books.
   * Uses content length to estimate columns - NO reflow triggered.
   * Accurate measurements happen lazily during navigation.
   */
  private async calculateLayoutEstimated(containerWidth: number): Promise<void> {
    let totalColumns = 0;

    // Estimate columns based on content length (chars per column estimate)
    // Average: ~2500 chars per column at default font size
    const charsPerColumn = 2500;

    for (const item of this.spineItems) {
      const contentLength = item.html?.length || 3000;
      const estimatedColumns = Math.max(1, Math.ceil(contentLength / charsPerColumn));

      this.chapterColumnOffsets.set(item.index, totalColumns);
      this.chapterColumnCounts.set(item.index, estimatedColumns);
      totalColumns += estimatedColumns;
    }

    this.totalColumns = totalColumns;
  }

  /**
   * Lazily measure accurate column counts for chapters around the current position.
   * Called during navigation to refine estimates without blocking.
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
      if (i >= startIdx && i <= endIdx) {
        const chapterEl = this.chapterElements.get(i);
        if (chapterEl) {
          const scrollWidth = chapterEl.scrollWidth;
          const chapterColumns = Math.max(1, Math.ceil(scrollWidth / containerWidth));
          this.chapterColumnCounts.set(i, chapterColumns);
          this.accurateColumnCounts.add(i);
        }
      }

      totalColumns += this.chapterColumnCounts.get(i) || 1;
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

        // Trigger blink animation on target element after navigation
        if (blinkTarget) {
          this.triggerBlinkAnimation(blinkTarget);
        }

        // Emit events
        this.emit('chapterVisible', { spineIndex: targetSpineIndex, visible: true });
        if (this.currentLocator) {
          this.emit('relocated', this.currentLocator);
        }
        return true;

      case 'cfi':
        // Parse CFI to find spine item and position
        const cfiResult = this.parseCfiToColumn(target.cfi);
        if (!cfiResult) return false;
        targetSpineIndex = cfiResult.spineIndex;
        targetColumn = cfiResult.column;
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
    const nextColumn = this.currentColumn + this.columnCount;

    if (nextColumn >= this.totalColumns) {
      return false; // At end
    }

    this.emit('pageAnimationStart', { direction: 'forward' });

    await this.navigateToColumn(nextColumn, false);
    this.currentColumn = nextColumn;
    this.currentSpineIndex = this.getSpineIndexFromColumn(nextColumn);
    this.updateCurrentLocator();

    this.emit('pageAnimationEnd', { direction: 'forward' });
    if (this.currentLocator) {
      this.emit('relocated', this.currentLocator);
    }

    return true;
  }

  async prev(): Promise<boolean> {
    const prevColumn = this.currentColumn - this.columnCount;

    if (prevColumn < 0) {
      return false; // At beginning
    }

    this.emit('pageAnimationStart', { direction: 'backward' });

    await this.navigateToColumn(prevColumn, false);
    this.currentColumn = prevColumn;
    this.currentSpineIndex = this.getSpineIndexFromColumn(prevColumn);
    this.updateCurrentLocator();

    this.emit('pageAnimationEnd', { direction: 'backward' });
    if (this.currentLocator) {
      this.emit('relocated', this.currentLocator);
    }

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
   * Navigate to a specific column using scrollLeft
   * This uses native scroll with scroll-snap for reliable pagination
   */
  private async navigateToColumn(column: number, instant: boolean): Promise<void> {
    if (!this.container) return;

    const pageWidth = this.columnWidth + this.gap;
    const targetScrollLeft = column * pageWidth;

    if (instant) {
      // Disable smooth scrolling temporarily for instant navigation
      this.container.style.scrollBehavior = 'auto';
      this.container.scrollLeft = targetScrollLeft;
      // Re-enable smooth scrolling
      this.container.style.scrollBehavior = 'smooth';
      return;
    }

    // Animated scroll using native smooth scrolling
    this.isAnimating = true;

    return new Promise(resolve => {
      if (!this.container) {
        this.isAnimating = false;
        resolve();
        return;
      }

      const handleScrollEnd = () => {
        this.isAnimating = false;
        this.container?.removeEventListener('scrollend', handleScrollEnd);
        resolve();
      };

      // Use scrollend event if available, fallback to timeout
      if ('onscrollend' in window) {
        this.container.addEventListener('scrollend', handleScrollEnd, { once: true });
      }

      // Perform smooth scroll
      this.container.scrollTo({
        left: targetScrollLeft,
        behavior: 'smooth'
      });

      // Fallback timeout in case scrollend doesn't fire or isn't supported
      setTimeout(() => {
        if (this.isAnimating) {
          this.isAnimating = false;
          this.container?.removeEventListener('scrollend', handleScrollEnd);
          resolve();
        }
      }, 400);
    });
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

    // Calculate which column the element is in based on scroll position
    const scrollLeft = this.container.scrollLeft;
    const elementLeft = elementRect.left - containerRect.left + scrollLeft;
    const elementColumn = Math.floor(elementLeft / pageWidth);

    return chapterOffset + elementColumn;
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
   * Setup scroll and wheel event listeners for navigation
   * - Scroll handler: snaps to column boundaries after manual swipe
   * - Wheel handler: turns pages with scrollwheel
   */
  private setupScrollHandler(): void {
    if (!this.container) return;

    // Scroll handler for swipe gesture snapping
    this.boundHandleScroll = () => this.handleScroll();
    this.container.addEventListener('scroll', this.boundHandleScroll, { passive: true });

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

  /**
   * Handle scroll events to detect manual scrolling and snap when stopped
   */
  private handleScroll(): void {
    // Skip if we're programmatically animating
    if (this.isAnimating) return;

    // Mark as manual scrolling
    this.isManualScrolling = true;

    // Clear existing timer
    if (this.scrollEndTimer !== null) {
      window.clearTimeout(this.scrollEndTimer);
    }

    // Set timer to detect scroll end (debounce)
    this.scrollEndTimer = window.setTimeout(() => {
      this.handleScrollEnd();
    }, 100);
  }

  /**
   * Snap to the nearest column boundary when manual scrolling ends
   * This provides the "rubber-band" snap effect for swipe gestures
   */
  private handleScrollEnd(): void {
    if (!this.container || !this.isManualScrolling) return;

    this.isManualScrolling = false;
    this.scrollEndTimer = null;

    const pageWidth = this.columnWidth + this.gap;
    if (pageWidth <= 0) return;

    const currentScroll = this.container.scrollLeft;
    const targetColumn = Math.round(currentScroll / pageWidth);
    const targetScroll = targetColumn * pageWidth;

    // Snap to column boundary if not aligned
    if (Math.abs(currentScroll - targetScroll) > 1) {
      this.isAnimating = true;
      this.container.scrollTo({
        left: targetScroll,
        behavior: 'smooth'
      });

      // Reset animation flag after scroll completes
      setTimeout(() => {
        this.isAnimating = false;
      }, 300);
    }

    // Update state if column changed
    if (targetColumn !== this.currentColumn) {
      const oldColumn = this.currentColumn;
      this.currentColumn = targetColumn;
      this.currentSpineIndex = this.getSpineIndexFromColumn(targetColumn);
      this.updateCurrentLocator();

      // Emit navigation events
      const direction = targetColumn > oldColumn ? 'forward' : 'backward';
      this.emit('pageAnimationStart', { direction });
      this.emit('pageAnimationEnd', { direction });
      if (this.currentLocator) {
        this.emit('relocated', this.currentLocator);
      }
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

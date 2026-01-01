/**
 * Scrolled Navigator
 *
 * Continuous scroll mode with virtual scrolling for performance.
 * Features:
 * - Smooth native scrolling
 * - Virtual DOM for memory efficiency with large books
 * - Intersection Observer for visibility tracking
 * - Position persistence across sessions
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
 * Chapter visibility state
 */
interface ChapterState {
  element: HTMLElement;
  index: number;
  href: string;
  isLoaded: boolean;
  isVisible: boolean;
  height: number;
  offsetTop: number;
}

/**
 * Scrolled Navigator implementation
 */
export class ScrolledNavigator implements Navigator {
  readonly mode = 'scrolled' as const;

  private container: HTMLElement | null = null;
  private scrollContainer: HTMLElement | null = null;
  private config: NavigatorConfig = { ...DEFAULT_NAVIGATOR_CONFIG, mode: 'scrolled' };

  // Content state
  private spineItems: SpineItemContent[] = [];
  private chapterStates: Map<number, ChapterState> = new Map();

  // Navigation state
  private currentSpineIndex = 0;
  private currentLocator: Locator | null = null;
  private isScrolling = false;
  private scrollTimeout: number | null = null;

  // Event listeners
  private listeners: Map<keyof NavigatorEvents, Set<NavigatorEventListener<any>>> = new Map();

  // Ready state
  private _isReady = false;

  // Observers
  private intersectionObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Scroll tracking
  private lastScrollTop = 0;
  private scrollDirection: 'up' | 'down' = 'down';

  // Virtualization
  private virtualWindowSize = 5; // Number of chapters to keep rendered
  private loadedChapters: Set<number> = new Set();

  get isReady(): boolean {
    return this._isReady;
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  async initialize(container: HTMLElement, config: NavigatorConfig): Promise<void> {
    this.container = container;
    this.config = { ...this.config, ...config };

    // Create scroll container
    this.createScrollContainer();

    // Apply styles
    this.applyContainerStyles();

    // Setup observers
    this.setupIntersectionObserver();
    this.setupResizeObserver();
    this.setupScrollListener();

    this._isReady = true;
    this.emit('rendered', { spineIndex: 0 });
  }

  async loadContent(
    spineItems: SpineItemContent[],
    initialLocator?: Locator,
    cachedElements?: Map<number, HTMLElement>
  ): Promise<void> {
    if (!this.container || !this.scrollContainer) {
      throw new Error('Navigator not initialized');
    }

    this.emit('loading', true);

    try {
      this.spineItems = spineItems;

      // Clear existing content
      this.scrollContainer.innerHTML = '';
      this.chapterStates.clear();
      this.loadedChapters.clear();

      // Use DocumentFragment for batch DOM insertion
      const fragment = document.createDocumentFragment();

      // Create chapter elements (reuse cached if available AND has content)
      for (const item of spineItems) {
        let chapterEl: HTMLElement;
        let isPreloaded = false;

        if (cachedElements?.has(item.index)) {
          const cached = cachedElements.get(item.index)!;
          // Only reuse cached element if it has actual content (not a placeholder)
          if (cached.innerHTML && !cached.classList.contains('epub-chapter-placeholder')) {
            chapterEl = cached.cloneNode(true) as HTMLElement;
            // Apply scrolled mode styling to cached element
            chapterEl.style.cssText = `
              min-height: 200px;
              margin-bottom: 2rem;
              border-bottom: 1px solid rgba(128, 128, 128, 0.2);
              padding-bottom: 2rem;
            `;
            chapterEl.classList.remove('epub-chapter-placeholder');
            chapterEl.dataset.loaded = 'true';
            isPreloaded = true;
          } else {
            // Cached element is a placeholder - create new placeholder element
            chapterEl = this.createChapterElement(item);
          }
        } else {
          // Create new placeholder element
          chapterEl = this.createChapterElement(item);
        }

        fragment.appendChild(chapterEl);

        this.chapterStates.set(item.index, {
          element: chapterEl,
          index: item.index,
          href: item.href,
          isLoaded: isPreloaded,
          isVisible: false,
          height: 0,
          offsetTop: 0,
        });

        if (isPreloaded) {
          this.loadedChapters.add(item.index);
        }
      }

      // Single DOM operation for all chapters
      this.scrollContainer.appendChild(fragment);

      // Only load initial chapters if we didn't have cached elements
      if (!cachedElements || cachedElements.size === 0) {
        await this.loadInitialChapters();
      }

      // Setup observers for all chapter elements
      if (this.intersectionObserver) {
        for (const state of this.chapterStates.values()) {
          this.intersectionObserver.observe(state.element);
        }
      }

      // Navigate to initial position
      if (initialLocator) {
        await this.goTo({ type: 'locator', locator: initialLocator }, { instant: true });
      } else {
        await this.goTo({ type: 'position', position: 0 }, { instant: true });
      }

      // Update chapter offsets
      this.updateChapterOffsets();

      this.emit('rendered', { spineIndex: this.currentSpineIndex });
    } finally {
      this.emit('loading', false);
    }
  }

  destroy(): void {
    this._isReady = false;

    // Clean up observers
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Clear timers
    if (this.scrollTimeout !== null) {
      window.clearTimeout(this.scrollTimeout);
      this.scrollTimeout = null;
    }

    // Clear listeners
    this.listeners.clear();

    // Clear content
    if (this.scrollContainer) {
      this.scrollContainer.innerHTML = '';
    }

    this.container = null;
    this.scrollContainer = null;
    this.chapterStates.clear();
    this.spineItems = [];
  }

  // ============================================================================
  // Container Setup
  // ============================================================================

  private createScrollContainer(): void {
    if (!this.container) return;

    this.scrollContainer = document.createElement('div');
    this.scrollContainer.id = 'scroll-container';
    this.scrollContainer.className = 'epub-scroll-container';
    this.container.appendChild(this.scrollContainer);
  }

  private applyContainerStyles(): void {
    if (!this.container || !this.scrollContainer) return;

    // Container styles
    this.container.style.cssText = `
      width: 100%;
      height: 100%;
      overflow: hidden;
      position: relative;
      background-color: ${this.config.theme.background};
      color: ${this.config.theme.foreground};
    `;

    // Scroll container styles
    this.scrollContainer.style.cssText = `
      width: 100%;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      scroll-behavior: smooth;
      padding: ${this.config.margin}px;
      box-sizing: border-box;
      font-size: ${this.config.fontSize}px;
      font-family: ${this.config.fontFamily};
      line-height: ${this.config.lineHeight};
      text-align: ${this.config.textAlign};
    `;
  }

  // ============================================================================
  // Chapter Elements
  // ============================================================================

  private createChapterElement(item: SpineItemContent): HTMLElement {
    const chapterEl = document.createElement('div');
    chapterEl.className = 'epub-chapter epub-chapter-placeholder';
    chapterEl.dataset.spineIndex = String(item.index);
    chapterEl.dataset.href = item.href;
    chapterEl.dataset.loaded = 'false';

    // Set minimum height for placeholder
    chapterEl.style.cssText = `
      min-height: 200px;
      margin-bottom: 2rem;
      border-bottom: 1px solid rgba(128, 128, 128, 0.2);
      padding-bottom: 2rem;
    `;

    return chapterEl;
  }

  private async loadChapterContent(index: number): Promise<void> {
    const state = this.chapterStates.get(index);
    if (!state || state.isLoaded) return;

    const spineItem = this.spineItems[index];
    if (!spineItem) return;

    // Mark as loaded
    state.isLoaded = true;
    state.element.dataset.loaded = 'true';
    state.element.classList.remove('epub-chapter-placeholder');

    // Set content
    state.element.innerHTML = spineItem.html;

    // Apply chapter-specific styles if any
    if (spineItem.css) {
      const styleEl = document.createElement('style');
      styleEl.textContent = spineItem.css;
      state.element.insertBefore(styleEl, state.element.firstChild);
    }

    // Update height
    state.height = state.element.offsetHeight;

    this.loadedChapters.add(index);
  }

  private unloadChapterContent(index: number): void {
    const state = this.chapterStates.get(index);
    if (!state || !state.isLoaded) return;

    // Preserve height to prevent layout shift
    const currentHeight = state.element.offsetHeight;
    state.element.style.minHeight = `${currentHeight}px`;

    // Clear content
    state.element.innerHTML = '';
    state.element.classList.add('epub-chapter-placeholder');
    state.element.dataset.loaded = 'false';
    state.isLoaded = false;

    this.loadedChapters.delete(index);
  }

  private async loadInitialChapters(): Promise<void> {
    // Load first few chapters
    const initialCount = Math.min(3, this.spineItems.length);

    for (let i = 0; i < initialCount; i++) {
      await this.loadChapterContent(i);
    }
  }

  // ============================================================================
  // Virtualization
  // ============================================================================

  private async updateVirtualWindow(): Promise<void> {
    const windowStart = Math.max(0, this.currentSpineIndex - Math.floor(this.virtualWindowSize / 2));
    const windowEnd = Math.min(
      this.spineItems.length - 1,
      this.currentSpineIndex + Math.ceil(this.virtualWindowSize / 2)
    );

    // Load chapters in window
    for (let i = windowStart; i <= windowEnd; i++) {
      if (!this.loadedChapters.has(i)) {
        await this.loadChapterContent(i);
      }
    }

    // Unload chapters outside window (but keep some buffer)
    const bufferSize = 2;
    for (const index of this.loadedChapters) {
      if (index < windowStart - bufferSize || index > windowEnd + bufferSize) {
        this.unloadChapterContent(index);
      }
    }
  }

  // ============================================================================
  // Scroll Handling
  // ============================================================================

  private setupScrollListener(): void {
    if (!this.scrollContainer) return;

    this.scrollContainer.addEventListener('scroll', this.handleScroll.bind(this), {
      passive: true,
    });
  }

  private handleScroll = (): void => {
    if (!this.scrollContainer) return;

    const scrollTop = this.scrollContainer.scrollTop;
    this.scrollDirection = scrollTop > this.lastScrollTop ? 'down' : 'up';
    this.lastScrollTop = scrollTop;

    // Debounce scroll end detection
    if (this.scrollTimeout !== null) {
      window.clearTimeout(this.scrollTimeout);
    }

    this.isScrolling = true;

    this.scrollTimeout = window.setTimeout(() => {
      this.isScrolling = false;
      this.onScrollEnd();
    }, 150);

    // Emit scroll event
    this.emit('scroll', {
      scrollTop,
      scrollHeight: this.scrollContainer.scrollHeight,
    });

    // Update current chapter based on scroll position
    this.updateCurrentChapter();
  };

  private onScrollEnd(): void {
    this.updateCurrentLocator();
    this.updateVirtualWindow();

    if (this.currentLocator) {
      this.emit('relocated', this.currentLocator);
    }
  }

  private updateCurrentChapter(): void {
    if (!this.scrollContainer) return;

    const scrollTop = this.scrollContainer.scrollTop;
    const viewportHeight = this.scrollContainer.clientHeight;
    const viewportMiddle = scrollTop + viewportHeight / 2;

    // Find chapter at viewport middle
    for (const [index, state] of this.chapterStates) {
      const chapterTop = state.element.offsetTop;
      const chapterBottom = chapterTop + state.element.offsetHeight;

      if (viewportMiddle >= chapterTop && viewportMiddle < chapterBottom) {
        if (this.currentSpineIndex !== index) {
          const prevIndex = this.currentSpineIndex;
          this.currentSpineIndex = index;

          // Emit visibility changes
          this.emit('chapterVisible', { spineIndex: prevIndex, visible: false });
          this.emit('chapterVisible', { spineIndex: index, visible: true });
        }
        break;
      }
    }
  }

  private updateChapterOffsets(): void {
    for (const [index, state] of this.chapterStates) {
      state.offsetTop = state.element.offsetTop;
      state.height = state.element.offsetHeight;
    }
  }

  // ============================================================================
  // Intersection Observer
  // ============================================================================

  private setupIntersectionObserver(): void {
    if (!this.scrollContainer) return;

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = parseInt(entry.target.getAttribute('data-spine-index') || '0', 10);
          const state = this.chapterStates.get(index);

          if (state) {
            const wasVisible = state.isVisible;
            state.isVisible = entry.isIntersecting;

            // Load content when becoming visible
            if (!wasVisible && state.isVisible && !state.isLoaded) {
              this.loadChapterContent(index);
            }
          }
        }
      },
      {
        root: this.scrollContainer,
        rootMargin: '100px 0px',
        threshold: 0,
      }
    );

    // Observe all chapter elements
    for (const state of this.chapterStates.values()) {
      this.intersectionObserver.observe(state.element);
    }
  }

  // ============================================================================
  // Resize Observer
  // ============================================================================

  private setupResizeObserver(): void {
    if (!this.container) return;

    this.resizeObserver = new ResizeObserver(() => {
      this.updateChapterOffsets();
      this.emit('resize', this.getViewportDimensions());
    });

    this.resizeObserver.observe(this.container);
  }

  // ============================================================================
  // Navigation Methods
  // ============================================================================

  async goTo(target: NavigationTarget, options?: NavigationOptions): Promise<boolean> {
    if (!this.scrollContainer) return false;

    const instant = options?.instant ?? false;
    let targetElement: HTMLElement | null = null;
    let targetSpineIndex = 0;

    switch (target.type) {
      case 'position':
        targetSpineIndex = Math.min(target.position, this.spineItems.length - 1);
        targetElement = this.chapterStates.get(targetSpineIndex)?.element ?? null;
        break;

      case 'href': {
        const searchHref = target.href.split('#')[0];
        const index = this.spineItems.findIndex(item => {
          const itemHref = item.href.split('#')[0];
          // Try multiple matching strategies
          return (
            itemHref === searchHref ||
            itemHref.endsWith(searchHref) ||
            searchHref.endsWith(itemHref) ||
            // Also try matching just filenames
            itemHref.split('/').pop() === searchHref.split('/').pop()
          );
        });
        if (index === -1) return false;
        targetSpineIndex = index;
        targetElement = this.chapterStates.get(index)?.element ?? null;
        break;
      }

      case 'cfi': {
        // Parse CFI to find spine item
        const spineIndex = this.getSpineIndexFromCfi(target.cfi);
        if (spineIndex === null) return false;
        targetSpineIndex = spineIndex;
        targetElement = this.chapterStates.get(spineIndex)?.element ?? null;
        break;
      }

      case 'progression': {
        // Calculate position from progression
        const totalHeight = this.scrollContainer.scrollHeight;
        const targetScroll = target.progression * totalHeight;

        if (instant) {
          this.scrollContainer.scrollTop = targetScroll;
        } else {
          this.scrollContainer.scrollTo({
            top: targetScroll,
            behavior: 'smooth',
          });
        }

        this.updateCurrentChapter();
        this.updateCurrentLocator();
        return true;
      }

      case 'locator': {
        const locator = target.locator;
        const index = this.spineItems.findIndex(item => item.href === locator.href);
        if (index === -1) return false;
        targetSpineIndex = index;

        // Ensure chapter is loaded
        await this.loadChapterContent(index);

        const state = this.chapterStates.get(index);
        if (!state) return false;

        // Calculate scroll position within chapter
        const chapterTop = state.element.offsetTop;
        const chapterHeight = state.element.offsetHeight;
        const progressionOffset = locator.locations.progression * chapterHeight;

        const targetScroll = chapterTop + progressionOffset;

        if (instant) {
          this.scrollContainer.scrollTop = targetScroll;
        } else {
          this.scrollContainer.scrollTo({
            top: targetScroll,
            behavior: 'smooth',
          });
        }

        this.currentSpineIndex = index;
        this.updateCurrentLocator();
        return true;
      }
    }

    if (!targetElement) return false;

    // Ensure target chapter is loaded before scrolling
    await this.loadChapterContent(targetSpineIndex);

    // Load surrounding chapters for context
    const loadPromises: Promise<void>[] = [];
    for (let i = Math.max(0, targetSpineIndex - 2); i <= Math.min(this.spineItems.length - 1, targetSpineIndex + 2); i++) {
      loadPromises.push(this.loadChapterContent(i));
    }
    await Promise.all(loadPromises);

    // Wait for layout to settle (use setTimeout as RAF may not fire in hidden views)
    await new Promise(resolve => setTimeout(resolve, 50));

    // Get fresh reference since content was loaded
    const freshElement = this.chapterStates.get(targetSpineIndex)?.element;
    if (!freshElement || !this.scrollContainer) return false;

    // Calculate the correct scroll offset using bounding rects
    // This works correctly regardless of placeholder heights
    const containerRect = this.scrollContainer.getBoundingClientRect();
    const elementRect = freshElement.getBoundingClientRect();
    const newScrollTop = this.scrollContainer.scrollTop + (elementRect.top - containerRect.top);

    // Use instant scroll for reliable navigation
    this.scrollContainer.scrollTo({
      top: newScrollTop,
      behavior: 'instant',
    });

    this.currentSpineIndex = targetSpineIndex;
    this.updateCurrentLocator();

    this.emit('chapterVisible', { spineIndex: targetSpineIndex, visible: true });
    if (this.currentLocator) {
      this.emit('relocated', this.currentLocator);
    }

    return true;
  }

  async next(): Promise<boolean> {
    if (!this.scrollContainer) return false;

    // Scroll by viewport height
    const viewportHeight = this.scrollContainer.clientHeight;
    const currentScroll = this.scrollContainer.scrollTop;
    const maxScroll = this.scrollContainer.scrollHeight - viewportHeight;

    if (currentScroll >= maxScroll) {
      return false; // At end
    }

    const newScroll = Math.min(currentScroll + viewportHeight * 0.9, maxScroll);

    this.scrollContainer.scrollTo({
      top: newScroll,
      behavior: 'smooth',
    });

    return true;
  }

  async prev(): Promise<boolean> {
    if (!this.scrollContainer) return false;

    const viewportHeight = this.scrollContainer.clientHeight;
    const currentScroll = this.scrollContainer.scrollTop;

    if (currentScroll <= 0) {
      return false; // At beginning
    }

    const newScroll = Math.max(currentScroll - viewportHeight * 0.9, 0);

    this.scrollContainer.scrollTo({
      top: newScroll,
      behavior: 'smooth',
    });

    return true;
  }

  async nextChapter(): Promise<boolean> {
    return this.goTo({ type: 'position', position: this.currentSpineIndex + 1 });
  }

  async prevChapter(): Promise<boolean> {
    return this.goTo({ type: 'position', position: this.currentSpineIndex - 1 });
  }

  // ============================================================================
  // Position Tracking
  // ============================================================================

  private updateCurrentLocator(): void {
    if (!this.scrollContainer) {
      this.currentLocator = null;
      return;
    }

    const spineItem = this.spineItems[this.currentSpineIndex];
    if (!spineItem) {
      this.currentLocator = null;
      return;
    }

    const state = this.chapterStates.get(this.currentSpineIndex);
    if (!state) {
      this.currentLocator = null;
      return;
    }

    // Calculate progression within chapter
    const scrollTop = this.scrollContainer.scrollTop;
    const chapterTop = state.element.offsetTop;
    const chapterHeight = state.element.offsetHeight || 1;
    const progressionInChapter = Math.max(0, Math.min(1, (scrollTop - chapterTop) / chapterHeight));

    // Calculate total progression
    const totalHeight = this.scrollContainer.scrollHeight || 1;
    const totalProgression = scrollTop / totalHeight;

    this.currentLocator = {
      href: spineItem.href,
      locations: {
        progression: progressionInChapter,
        totalProgression,
        position: this.currentSpineIndex,
      },
    };
  }

  getCurrentLocation(): Locator | null {
    return this.currentLocator;
  }

  getPaginationInfo(): PaginationInfo | null {
    if (!this.currentLocator || !this.scrollContainer) return null;

    const viewportHeight = this.scrollContainer.clientHeight;
    const totalHeight = this.scrollContainer.scrollHeight;
    const currentScroll = this.scrollContainer.scrollTop;

    // Estimate "pages" based on viewport
    const totalPages = Math.ceil(totalHeight / viewportHeight);
    const currentPage = Math.floor(currentScroll / viewportHeight) + 1;

    return {
      currentPage,
      totalPages,
      spineIndex: this.currentSpineIndex,
      totalSpineItems: this.spineItems.length,
      bookProgression: this.currentLocator.locations.totalProgression ?? 0,
      chapterTitle: this.spineItems[this.currentSpineIndex]?.href,
    };
  }

  isLocatorVisible(locator: Locator): boolean {
    if (!this.scrollContainer) return false;

    const spineIndex = this.spineItems.findIndex(item => item.href === locator.href);
    if (spineIndex === -1) return false;

    const state = this.chapterStates.get(spineIndex);
    if (!state) return false;

    const scrollTop = this.scrollContainer.scrollTop;
    const viewportHeight = this.scrollContainer.clientHeight;
    const viewportBottom = scrollTop + viewportHeight;

    const chapterTop = state.element.offsetTop;
    const chapterHeight = state.element.offsetHeight;
    const locatorPosition = chapterTop + locator.locations.progression * chapterHeight;

    return locatorPosition >= scrollTop && locatorPosition <= viewportBottom;
  }

  // ============================================================================
  // CFI Handling
  // ============================================================================

  private getSpineIndexFromCfi(cfi: string): number | null {
    const match = cfi.match(/epubcfi\(\/6\/(\d+)/);
    if (!match) return null;

    const spinePosition = parseInt(match[1], 10);
    return (spinePosition / 2) - 1;
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

  updateConfig(config: Partial<NavigatorConfig>): void {
    this.config = { ...this.config, ...config };
    this.applyContainerStyles();
    this.updateChapterOffsets();
  }

  getConfig(): NavigatorConfig {
    return { ...this.config };
  }

  // ============================================================================
  // Content Access
  // ============================================================================

  getVisibleText(): string {
    if (!this.scrollContainer) return '';

    const scrollTop = this.scrollContainer.scrollTop;
    const viewportHeight = this.scrollContainer.clientHeight;
    const viewportBottom = scrollTop + viewportHeight;

    let visibleText = '';

    for (const state of this.chapterStates.values()) {
      if (!state.isLoaded) continue;

      const chapterTop = state.element.offsetTop;
      const chapterBottom = chapterTop + state.element.offsetHeight;

      // Check if chapter is in viewport
      if (chapterBottom >= scrollTop && chapterTop <= viewportBottom) {
        visibleText += (state.element.textContent || '') + '\n';
      }
    }

    return visibleText.trim();
  }

  getContentContainer(): HTMLElement {
    if (!this.scrollContainer) {
      throw new Error('Navigator not initialized');
    }
    return this.scrollContainer;
  }

  getColumnWidth(): number {
    // Not applicable for scrolled mode, return container width
    return this.container?.clientWidth ?? 0;
  }

  getViewportDimensions(): { width: number; height: number } {
    return {
      width: this.scrollContainer?.clientWidth ?? 0,
      height: this.scrollContainer?.clientHeight ?? 0,
    };
  }

  // ============================================================================
  // Layout Methods
  // ============================================================================

  async reflow(): Promise<void> {
    if (!this.scrollContainer) return;

    // Save current position
    const savedLocator = this.currentLocator;

    // Update styles
    this.applyContainerStyles();

    // Update offsets
    this.updateChapterOffsets();

    // Restore position
    if (savedLocator) {
      await this.goTo({ type: 'locator', locator: savedLocator }, { instant: true });
    }

    this.emit('resize', this.getViewportDimensions());
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
          console.error(`[ScrolledNavigator] Error in ${event} handler:`, error);
        }
      }
    }
  }
}

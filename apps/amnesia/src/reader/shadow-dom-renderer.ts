/**
 * Shadow DOM Renderer
 *
 * Main renderer that integrates Shadow DOM, Navigator, and Locator systems.
 * Replaces the iframe-based EpubRenderer with a modern, performant architecture.
 *
 * Key improvements over iframe-based renderer:
 * - No RAF throttling (events fire immediately)
 * - Events bubble naturally (no forwarding needed)
 * - Reduced memory overhead (~15MB savings)
 * - Zero sub-pixel drift (integer-forced dimensions)
 * - CSS isolation via Shadow DOM encapsulation
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

import type {
  ParsedBook,
  ChapterContent,
  RendererConfig,
  ReadingLocation,
  NavigationTarget,
  RendererEvents,
  RendererEventListener,
  ThemeColors,
  HighlightColor,
  DisplayMode,
} from './renderer/types';
import type { Highlight } from '../library/types';
import { DEFAULT_RENDERER_CONFIG } from './renderer/types';
import type { ContentProvider } from './renderer/content-provider';
import { ShadowDOMView } from './shadow-dom-view';
import {
  createNavigator,
  type Navigator,
  type NavigatorConfig,
  type Locator,
  type SpineItemContent,
} from './navigator';
import { CSSHighlightManager, isCSSHighlightAPISupported } from './renderer/css-highlights';
import { SelectionHandler, type SelectionData } from './renderer/selection';
import { getObsidianThemeColors, isObsidianDarkMode } from './reader-settings';
import { generateFullCfi } from './renderer/cfi-utils';
import { ContentSanitizer, type SanitizerConfig } from '../security';
import { parseHref, pageToSpineIndex } from './utils/href-parser';

// ============================================================================
// Theme Colors
// ============================================================================

const THEME_COLORS: Record<string, ThemeColors> = {
  system: {
    background: '#ffffff',
    foreground: '#333333',
    linkColor: '#0066cc',
    highlightColor: 'rgba(0, 102, 204, 0.3)',
  },
  light: {
    background: '#ffffff',
    foreground: '#1a1a1a',
    linkColor: '#0066cc',
    highlightColor: 'rgba(255, 255, 0, 0.3)',
  },
  dark: {
    background: '#1a1a1a',
    foreground: '#e0e0e0',
    linkColor: '#6bb3ff',
    highlightColor: 'rgba(255, 255, 0, 0.2)',
  },
  sepia: {
    background: '#f4ecd8',
    foreground: '#5b4636',
    linkColor: '#7c5e3c',
    highlightColor: 'rgba(255, 200, 100, 0.3)',
  },
  night: {
    background: '#000000',
    foreground: '#ffcc66',
    linkColor: '#ffcc66',
    highlightColor: 'rgba(255, 204, 102, 0.2)',
  },
  paper: {
    background: '#f5f5f0',
    foreground: '#1a1a1a',
    linkColor: '#4a5568',
    highlightColor: 'rgba(255, 255, 0, 0.3)',
  },
  forest: {
    background: '#1a2e1a',
    foreground: '#a8d8a8',
    linkColor: '#7cb87c',
    highlightColor: 'rgba(168, 216, 168, 0.2)',
  },
};

function getSystemThemeColors(): ThemeColors {
  const obsidian = getObsidianThemeColors();
  return {
    background: obsidian.bg,
    foreground: obsidian.text,
    linkColor: obsidian.link,
    highlightColor: obsidian.selection,
  };
}

// ============================================================================
// Shadow DOM Renderer
// ============================================================================

export class ShadowDOMRenderer {
  private container: HTMLElement;
  private config: RendererConfig;
  private api: ContentProvider;

  // Shadow DOM view
  private view: ShadowDOMView | null = null;

  // Navigator (handles pagination/scrolling)
  private navigator: Navigator | null = null;

  // Book state
  private book: ParsedBook | null = null;
  private bookId: string = '';

  // Highlights
  private cssHighlights: CSSHighlightManager | null = null;
  private storedHighlights: Highlight[] = [];

  // Selection handling
  private selection: SelectionHandler | null = null;

  // Content sanitizer for XSS protection
  private sanitizer: ContentSanitizer;

  // Navigation state
  private currentSpineIndex = 0;
  private currentLocation: ReadingLocation | null = null;

  // Event listeners
  private listeners: Map<keyof RendererEvents, Set<RendererEventListener<any>>> = new Map();

  // Loading state
  private isLoading = false;

  // Cached spine content (avoids re-fetching on mode switch)
  private cachedSpineContent: SpineItemContent[] | null = null;

  // Cached parsed chapter elements (avoids re-parsing HTML on mode switch)
  private cachedChapterElements: Map<number, HTMLElement> = new Map();

  // Theme observer
  private themeObserver: MutationObserver | null = null;

  // Cleanup function for navigator events
  private navigatorCleanup: (() => void)[] = [];

  // Link click handler for cleanup
  private boundLinkClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor(container: HTMLElement, api: ContentProvider, config?: Partial<RendererConfig>) {
    this.container = container;
    this.api = api;
    this.config = { ...DEFAULT_RENDERER_CONFIG, ...config };

    // Initialize content sanitizer for XSS protection
    this.sanitizer = new ContentSanitizer({
      allowExternalImages: false,
      allowExternalStylesheets: false,
      allowDataUrls: true,
      allowBlobUrls: true,
      allowedDomains: [],
      strictMode: false,
    });

    this.initialize();
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  private initialize(): void {
    // Set up container styles
    this.container.style.position = 'relative';
    this.container.style.overflow = 'hidden';
    this.container.classList.add('epub-renderer', 'shadow-dom-renderer');

    // Create Shadow DOM view
    this.view = new ShadowDOMView(this.container);

    // Apply theme
    this.applyTheme();

    // Set up theme observer
    this.setupThemeObserver();

    // Set up CSS highlights if supported
    // IMPORTANT: Pass shadow root to inject highlight styles into Shadow DOM
    if (isCSSHighlightAPISupported()) {
      console.log('[ShadowDOMRenderer] Using CSS Custom Highlight API');
      this.cssHighlights = new CSSHighlightManager(
        this.view.getDocument(),
        (highlightId, position) => this.emit('highlightClicked', { annotationId: highlightId, position }),
        this.view.getShadowRoot()
      );
    }

    // Set up text selection handler (pass shadow root for proper event handling)
    this.selection = new SelectionHandler(
      this.view.getDocument(),
      this.config,
      (selectionData) => this.handleSelection(selectionData),
      this.view.getShadowRoot()
    );

    // Set up link click handler
    this.setupLinkHandler();

    // Create navigator
    this.createNavigator();

    // Set up resize handling
    this.view.onResize(() => this.handleResize());
  }

  private createNavigator(): void {
    // Clean up previous navigator
    this.destroyNavigator();

    // Create new navigator based on mode
    this.navigator = createNavigator(this.config.mode);

    // Connect navigator events
    this.connectNavigatorEvents();
  }

  private destroyNavigator(): void {
    // Clean up event listeners with error handling to prevent one failure blocking others
    for (const cleanup of this.navigatorCleanup) {
      try {
        cleanup();
      } catch (error) {
        console.warn('[ShadowDOMRenderer] Error during event cleanup:', error);
      }
    }
    this.navigatorCleanup = [];

    // Destroy navigator
    if (this.navigator) {
      try {
        this.navigator.destroy();
      } catch (error) {
        console.warn('[ShadowDOMRenderer] Error during navigator destruction:', error);
      }
      this.navigator = null;
    }
  }

  private connectNavigatorEvents(): void {
    if (!this.navigator) return;

    // Relocated event - update current location
    this.navigatorCleanup.push(
      this.navigator.on('relocated', (locator) => {
        this.currentSpineIndex = locator.locations.position ?? 0;
        this.currentLocation = this.locatorToReadingLocation(locator);
        this.emit('relocated', this.currentLocation);
      })
    );

    // Rendered event
    this.navigatorCleanup.push(
      this.navigator.on('rendered', ({ spineIndex }) => {
        const href = this.book?.spine[spineIndex]?.href || '';
        this.emit('rendered', { spineIndex, href });
        this.reanchorHighlights();
      })
    );

    // Chapter visibility changed - re-anchor highlights for newly visible chapters
    // This is critical for scrolled mode where chapters get virtualized
    this.navigatorCleanup.push(
      this.navigator.on('chapterVisible', ({ spineIndex, visible }) => {
        if (visible) {
          // Delay to ensure chapter content is fully rendered before anchoring.
          // Use 200ms to account for DOM rendering time after content injection.
          // Also do a second pass at 500ms for any late-loading content.
          setTimeout(() => this.reanchorHighlights(), 200);
          setTimeout(() => this.reanchorHighlights(), 500);
        }
      })
    );

    // Loading event
    this.navigatorCleanup.push(
      this.navigator.on('loading', (loading) => {
        this.isLoading = loading;
      })
    );

    // Error event
    this.navigatorCleanup.push(
      this.navigator.on('error', (error) => {
        console.error('[ShadowDOMRenderer] Navigator error:', error);
      })
    );

    // Navigation failed event - show user-facing notification
    this.navigatorCleanup.push(
      this.navigator.on('navigationFailed', ({ spineIndex, href, reason }) => {
        console.error(`[ShadowDOMRenderer] Navigation failed: chapter ${spineIndex} (${href}): ${reason}`);
        // Emit error event for the UI to show a toast notification
        this.emit('error', new Error(`Failed to load chapter: ${reason}`));
      })
    );
  }

  // ============================================================================
  // Book Loading
  // ============================================================================

  async load(bookId: string): Promise<void> {
    this.emit('loading', true);

    try {
      const book = await this.api.getBook(bookId);
      await this.setBook(book);
    } finally {
      this.emit('loading', false);
    }
  }

  async loadFromBytes(data: ArrayBuffer, filename?: string): Promise<void> {
    this.emit('loading', true);

    try {
      const book = await this.api.uploadBook(data, filename);
      await this.setBook(book);
    } finally {
      this.emit('loading', false);
    }
  }

  private async setBook(book: ParsedBook): Promise<void> {
    // Clear cached spine content when loading a new book
    this.cachedSpineContent = null;

    this.book = book;
    this.bookId = book.id;

    if (!this.view || !this.navigator) {
      throw new Error('Renderer not initialized');
    }

    // Initialize navigator with content container
    const navigatorConfig = this.getNavigatorConfig();
    await this.navigator.initialize(this.view.getContentContainer(), navigatorConfig);

    // Load all spine content
    const spineContent = await this.loadSpineContent();

    // Load into navigator
    await this.navigator.loadContent(spineContent);

    this.emit('rendered', { spineIndex: 0, href: this.book?.spine[0]?.href || '' });
  }

  private async loadSpineContent(forceReload = false): Promise<SpineItemContent[]> {
    if (!this.book) return [];

    // Return cached content if available and not forcing reload
    if (!forceReload && this.cachedSpineContent) {
      console.log('[ShadowDOMRenderer] Using cached spine content');
      return this.cachedSpineContent;
    }

    console.log('[ShadowDOMRenderer] Loading spine content from API...');
    const content: SpineItemContent[] = [];

    for (let i = 0; i < this.book.spine.length; i++) {
      const spineItem = this.book.spine[i];

      try {
        const chapter = await this.api.getChapter(this.bookId, spineItem.href, true);
        const processedHtml = await this.processHtml(chapter.html, chapter.href);

        content.push({
          index: i,
          href: spineItem.href,
          html: processedHtml,
          linear: spineItem.linear,
        });
      } catch (error) {
        console.error(`[ShadowDOMRenderer] Failed to load spine item ${i}:`, error);
        content.push({
          index: i,
          href: spineItem.href,
          html: `<div class="error">Failed to load chapter</div>`,
          linear: spineItem.linear,
        });
      }
    }

    // Cache the content for future mode switches
    this.cachedSpineContent = content;
    return content;
  }

  private async processHtml(html: string, href: string): Promise<string> {
    // Sanitize HTML to prevent XSS attacks
    // DOMPurify removes scripts, event handlers, and dangerous content
    const result = this.sanitizer.sanitize(html);

    // Log blocked URLs in development
    if (result.blockedUrls.length > 0) {
      console.warn(
        `[ShadowDOMRenderer] Blocked ${result.blockedUrls.length} external URLs in ${href}:`,
        result.blockedUrls.slice(0, 5)
      );
    }

    return result.html;
  }

  // ============================================================================
  // Navigation
  // ============================================================================

  async display(target?: NavigationTarget, options?: { instant?: boolean }): Promise<void> {
    if (!this.navigator) return;

    // Handle undefined target - display at start
    if (!target) {
      await this.navigator.goTo({ type: 'position', position: 0 }, { instant: options?.instant });
      return;
    }

    let navTarget;

    switch (target.type) {
      case 'cfi':
        navTarget = { type: 'cfi' as const, cfi: target.cfi };
        break;

      case 'spine':
        navTarget = { type: 'position' as const, position: target.spineIndex };
        break;

      case 'href':
        navTarget = { type: 'href' as const, href: target.href, fragment: target.hash };
        break;

      case 'percentage':
        navTarget = { type: 'progression' as const, progression: target.percentage / 100 };
        break;

      default:
        return;
    }

    await this.navigator.goTo(navTarget, { instant: options?.instant });
  }

  async next(): Promise<boolean> {
    if (!this.navigator) return false;
    return this.navigator.next();
  }

  async prev(): Promise<boolean> {
    if (!this.navigator) return false;
    return this.navigator.prev();
  }

  async nextChapter(): Promise<boolean> {
    if (!this.navigator) return false;
    return this.navigator.nextChapter();
  }

  async prevChapter(): Promise<boolean> {
    if (!this.navigator) return false;
    return this.navigator.prevChapter();
  }

  // ============================================================================
  // Location
  // ============================================================================

  getLocation(): ReadingLocation | null {
    return this.currentLocation;
  }

  private locatorToReadingLocation(locator: Locator): ReadingLocation {
    return {
      cfi: locator.locations.cfi || '',
      href: locator.href,
      spineIndex: locator.locations.position ?? 0,
      percentage: (locator.locations.totalProgression ?? 0) * 100,
      progressionInChapter: locator.locations.progression ?? 0,
      text: locator.text ? {
        highlight: locator.text.highlight || '',
        before: locator.text.before,
        after: locator.text.after,
      } : undefined,
    };
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  async updateConfig(config: Partial<RendererConfig>): Promise<void> {
    const oldMode = this.config.mode;
    this.config = { ...this.config, ...config };

    // Handle mode switch - MUST await to prevent race conditions
    if (config.mode && config.mode !== oldMode) {
      await this.handleModeSwitch(config.mode);
    } else {
      // Just update navigator config
      if (this.navigator) {
        this.navigator.updateConfig(this.getNavigatorConfig());
      }
    }

    // Handle theme change
    if (config.theme) {
      this.applyTheme();
    }
  }

  private async handleModeSwitch(newMode: DisplayMode): Promise<void> {
    const startTime = performance.now();
    console.log(`[ModeSwitch] Starting mode switch to ${newMode}`);

    // Save current location
    console.log('[ModeSwitch] Step 1: Saving current location...');
    const savedLocation = this.navigator?.getCurrentLocation();
    console.log('[ModeSwitch] Step 1 complete:', savedLocation ? 'location saved' : 'no location');

    // DISABLED: Caching was causing freezes due to synchronous cloneNode(true) on large DOMs
    // Skip caching entirely - the navigator will recreate elements from HTML
    console.log('[ModeSwitch] Step 2: Skipping cache (disabled to prevent freeze)');
    this.cachedChapterElements.clear();

    // Update config mode BEFORE creating navigator
    this.config.mode = newMode;

    // Update view's mode class
    console.log('[ModeSwitch] Step 3: Updating view mode class...');
    if (this.view) {
      this.view.setMode(newMode);
    }
    console.log('[ModeSwitch] Step 3 complete');

    // Create new navigator (uses this.config.mode)
    console.log('[ModeSwitch] Step 4: Creating new navigator...');
    const navStart = performance.now();
    this.createNavigator();
    console.log(`[ModeSwitch] Step 4 complete in ${(performance.now() - navStart).toFixed(1)}ms`);

    // Reinitialize with content
    if (this.view && this.navigator && this.book) {
      console.log('[ModeSwitch] Step 5: Initializing navigator...');
      const initStart = performance.now();
      await this.navigator.initialize(this.view.getContentContainer(), this.getNavigatorConfig());
      console.log(`[ModeSwitch] Step 5 complete in ${(performance.now() - initStart).toFixed(1)}ms`);

      console.log('[ModeSwitch] Step 6: Loading spine content...');
      const spineStart = performance.now();
      const spineContent = await this.loadSpineContent();
      console.log(`[ModeSwitch] Step 6 complete: ${spineContent.length} chapters in ${(performance.now() - spineStart).toFixed(1)}ms`);

      // Use cached elements if available for faster switching
      console.log('[ModeSwitch] Step 7: Loading content into navigator...');
      const loadStart = performance.now();
      await this.navigator.loadContent(spineContent, savedLocation ?? undefined, this.cachedChapterElements);
      console.log(`[ModeSwitch] Step 7 complete in ${(performance.now() - loadStart).toFixed(1)}ms`);

      // Clear cache after successful load to free memory
      // The new navigator now owns the elements
      this.cachedChapterElements.clear();
      console.log('[ModeSwitch] Step 8: Cache cleared to free memory');
    }

    console.log(`[ModeSwitch] Mode switch complete! Total time: ${(performance.now() - startTime).toFixed(1)}ms`);
  }

  /**
   * Cache chapter elements from current navigator for reuse.
   * Uses chunked async cloning to prevent main thread freeze.
   */
  private async cacheChapterElements(): Promise<void> {
    if (!this.view) return;

    const container = this.view.getContentContainer();

    // Find all chapter elements in current DOM
    const chapters = container.querySelectorAll('.epub-chapter');

    // Chunk size: clone this many chapters before yielding to main thread
    const CHUNK_SIZE = 10;

    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const spineIndex = parseInt(chapter.getAttribute('data-spine-index') || '-1', 10);
      if (spineIndex >= 0) {
        // Clone the element to preserve it (since we'll clear the container)
        this.cachedChapterElements.set(spineIndex, chapter.cloneNode(true) as HTMLElement);
      }

      // Yield to main thread every CHUNK_SIZE chapters to prevent freeze
      if (i > 0 && i % CHUNK_SIZE === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  private getNavigatorConfig(): NavigatorConfig {
    const themeColors = this.getThemeColors();

    return {
      mode: this.config.mode,
      columns: this.config.columns,
      fontSize: this.config.fontSize,
      fontFamily: this.config.fontFamily,
      lineHeight: this.config.lineHeight,
      textAlign: this.config.textAlign,
      margin: this.config.margin,
      columnGap: this.config.columnGap,
      theme: themeColors,
      pageSnap: true,
      momentumScrolling: true,
      // Provide chapter re-fetch callback for retry logic
      chapterRefetcher: async (spineIndex: number, href: string): Promise<string | null> => {
        try {
          const chapter = await this.api.getChapter(this.bookId, href, true);
          const processedHtml = await this.processHtml(chapter.html, chapter.href);
          // Update cached spine content if successful
          if (this.cachedSpineContent && this.cachedSpineContent[spineIndex]) {
            this.cachedSpineContent[spineIndex].html = processedHtml;
          }
          return processedHtml;
        } catch (error) {
          console.error(`[ShadowDOMRenderer] Chapter refetch failed for ${href}:`, error);
          return null;
        }
      },
    };
  }

  getConfig(): RendererConfig {
    return { ...this.config };
  }

  getMode(): DisplayMode {
    return this.config.mode;
  }

  // ============================================================================
  // Theme
  // ============================================================================

  private getThemeColors(): ThemeColors {
    if (this.config.theme === 'system') {
      return getSystemThemeColors();
    }

    if (this.config.theme === 'custom' && this.config.customColors) {
      return this.config.customColors;
    }

    return THEME_COLORS[this.config.theme] ?? THEME_COLORS.light;
  }

  private applyTheme(): void {
    if (!this.view) return;

    const colors = this.getThemeColors();
    this.view.applyTheme(colors);
    this.view.applyRendererConfig(this.config);
  }

  private setupThemeObserver(): void {
    if (typeof document === 'undefined' || !document.body) return;

    this.themeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          if (this.config.theme === 'system') {
            this.applyTheme();
          }
        }
      }
    });

    this.themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  // ============================================================================
  // Highlights
  // ============================================================================

  setStoredHighlights(highlights: Highlight[]): void {
    this.storedHighlights = highlights;
    this.reanchorHighlights();
  }

  /**
   * Re-anchor stored highlights to the DOM.
   * @param skipHighlightId - Optional highlight ID to skip (used when navigating to a specific highlight to prevent range mismatch flash)
   */
  private async reanchorHighlights(skipHighlightId?: string): Promise<void> {
    if (!this.view || !this.cssHighlights || this.storedHighlights.length === 0) {
      return;
    }

    const shadowRoot = this.view.getShadowRoot();
    const TIMEOUT_MS = 100; // Max 100ms per highlight for text matching
    let anchored = 0;
    let skipped = 0;

    // Process highlights one at a time with timeout protection
    for (let i = 0; i < this.storedHighlights.length; i++) {
      const highlight = this.storedHighlights[i];

      // Skip the target highlight if specified OR if we're currently navigating to it
      // This prevents visual flash from range mismatch between anchorToDOM and findTextRange
      if ((skipHighlightId && highlight.id === skipHighlightId) ||
          (this.navigatingToHighlightId && highlight.id === this.navigatingToHighlightId)) {
        skipped++;
        continue;
      }

      if (!highlight.text) {
        skipped++;
        continue;
      }

      // Get the chapter element for this specific highlight
      // This is crucial - we must search within the correct chapter, not the entire container
      const chapterEl = shadowRoot.querySelector(
        `.epub-chapter[data-spine-index="${highlight.spineIndex}"]`
      ) as HTMLElement | null;

      if (!chapterEl || !chapterEl.textContent?.length) {
        // Chapter not loaded yet or empty - skip for now
        skipped++;
        continue;
      }

      // Use findTextRange for consistency with navigateToHighlight
      // This ensures all highlights use the same range-finding algorithm
      // Previously used anchorToDOM which could return different ranges
      try {
        const range = this.findTextRange(highlight.text, chapterEl);

        if (range) {
          this.cssHighlights.add(
            highlight.id,
            range,
            highlight.color as HighlightColor
          );
          anchored++;
        } else {
          skipped++;
        }
      } catch {
        skipped++;
      }

      // Yield to main thread every 3 highlights
      if (i > 0 && i % 3 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    console.log(`[reanchorHighlights] Done: ${anchored} anchored, ${skipped} skipped`);
  }

  addHighlight(id: string, range: Range, color: HighlightColor): void {
    this.cssHighlights?.add(id, range, color);
  }

  removeHighlight(id: string): void {
    this.cssHighlights?.remove(id);
  }

  clearHighlights(): void {
    this.cssHighlights?.clear();
  }

  // ============================================================================
  // Resize Handling
  // ============================================================================

  private handleResize(): void {
    if (this.navigator) {
      this.navigator.reflow();
    }
  }

  // ============================================================================
  // Selection Handling
  // ============================================================================

  private handleSelection(data: SelectionData): void {
    // Generate CFI from the selection range
    let cfi = '';
    try {
      // Get the start node of the range for CFI generation
      const startNode = data.range.startContainer;
      const startOffset = data.range.startOffset;
      cfi = generateFullCfi(this.currentSpineIndex, startNode, startOffset);
    } catch (error) {
      console.warn('[ShadowDOMRenderer] Failed to generate CFI for selection:', error);
    }

    // IMPORTANT: data.position is already in viewport coordinates (clientX/clientY)
    // from the SelectionHandler. No translation needed.
    // The previous translateToViewportCoords() incorrectly added container offsets.

    // Emit the selected event
    this.emit('selected', {
      text: data.text,
      cfi,
      range: data.range,
      position: data.position, // Already viewport coordinates
      spineIndex: this.currentSpineIndex,
      selector: data.selector,
    });
  }

  // ============================================================================
  // Link Handling
  // ============================================================================

  /**
   * Set up click handler for links and images within the content
   */
  private setupLinkHandler(): void {
    if (!this.view) return;

    const shadowRoot = this.view.getShadowRoot();

    this.boundLinkClickHandler = (e: MouseEvent) => {
      const target = e.target as Element;

      // Check if clicked on an image (directly or within a figure)
      const img = target.tagName === 'IMG' ? target as HTMLImageElement : target.closest('img');
      if (img) {
        const src = img.getAttribute('src') || '';
        const blobUrl = src.startsWith('blob:') ? src : '';
        const alt = img.getAttribute('alt') || undefined;

        // Emit image clicked event
        this.emit('imageClicked', {
          src,
          blobUrl,
          alt,
          spineIndex: this.currentSpineIndex,
        });
        return;
      }

      // Check for link clicks
      const link = target.closest('a');
      if (!link) return;

      const href = link.getAttribute('href');
      if (!href) return;

      // Prevent default navigation
      e.preventDefault();

      // Handle the link click
      this.handleLinkClick(href, link);
    };

    shadowRoot.addEventListener('click', this.boundLinkClickHandler as EventListener);
  }

  /**
   * Handle a link click
   */
  private handleLinkClick(href: string, linkElement: HTMLAnchorElement): void {
    // External links (http, https, mailto, etc.)
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
      this.emit('linkClicked', { href, external: true });
      return;
    }

    // Internal links
    this.emit('linkClicked', { href, external: false });

    // Handle hash-only links (e.g., #section1) - scroll within current chapter
    if (href.startsWith('#')) {
      const targetId = href.substring(1);
      this.scrollToElementWithRetry(targetId, 5, 50);
      return;
    }

    // Navigate to chapter (with optional hash fragment)
    this.navigateToHref(href);
  }

  /**
   * Scroll to an element by ID and apply blink animation
   * Uses retry logic for large books where content may load slowly
   * Handles both scrolled mode (actual scrolling) and paginated mode (no scrolling)
   */
  private scrollToElementWithRetry(elementId: string, retries = 5, delay = 100): void {
    if (!this.view) return;

    const shadowRoot = this.view.getShadowRoot();
    const element = shadowRoot.getElementById(elementId);

    if (element) {
      // Check if we're in scrolled mode (has scroll container) or paginated mode
      const scrollContainer = shadowRoot.querySelector('.epub-scroll-container') as HTMLElement;

      if (scrollContainer) {
        // Scrolled mode: scroll to the element with offset to avoid toolbar overlap
        const containerRect = scrollContainer.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        // Add 100px offset from top to avoid toolbar
        const targetScrollTop = scrollContainer.scrollTop + (elementRect.top - containerRect.top) - 100;
        scrollContainer.scrollTo({
          top: Math.max(0, targetScrollTop),
          behavior: 'smooth'
        });
      }
      // In paginated mode: DON'T call scrollIntoView - it breaks CSS columns
      // The navigator's goTo() already positioned us on the correct page

      // Apply blink animation in both modes
      this.applyLinkTargetAnimation(element);
    } else if (retries > 0) {
      // Retry with exponentially increasing delay for large books
      setTimeout(() => {
        this.scrollToElementWithRetry(elementId, retries - 1, delay * 1.5);
      }, delay);
    }
  }

  /**
   * Find and highlight the first visible content element (heading or paragraph)
   * Used when navigating to a chapter without a specific fragment
   */
  private highlightFirstVisibleElement(spineIndex: number): void {
    if (!this.view) return;

    const shadowRoot = this.view.getShadowRoot();
    const chapterEl = shadowRoot.querySelector(`.epub-chapter[data-spine-index="${spineIndex}"]`);

    if (!chapterEl) return;

    // Find the first heading or paragraph
    const target = chapterEl.querySelector('h1, h2, h3, h4, h5, h6, p');
    if (target) {
      this.applyLinkTargetAnimation(target);
    }
  }

  /**
   * Navigate to an href (chapter/section) within the book.
   * Public method - can be called from Sidebar TOC or internal link clicks.
   */
  async navigateToHref(href: string): Promise<void> {
    if (!this.book || !this.navigator) return;

    // Parse the href to determine navigation type
    const parsed = parseHref(href);

    // Handle special schemes (position:N, page:N)
    if (parsed.type === 'position') {
      // Direct spine index navigation
      const spineIndex = parsed.spineIndex;
      if (spineIndex >= 0 && spineIndex < this.book.spine.length) {
        await this.navigator.goTo(
          { type: 'position', position: spineIndex },
          { instant: false }
        );
        setTimeout(() => {
          this.highlightFirstVisibleElement(spineIndex);
        }, 150);
      } else {
        console.warn('[ShadowDOMRenderer] Invalid position index:', spineIndex);
      }
      return;
    }

    if (parsed.type === 'page') {
      // Page-based navigation (1-indexed page → 0-indexed spine)
      const spineIndex = pageToSpineIndex(parsed.pageNumber, this.book.spine.length);
      if (spineIndex >= 0) {
        await this.navigator.goTo(
          { type: 'position', position: spineIndex },
          { instant: false }
        );
        setTimeout(() => {
          this.highlightFirstVisibleElement(spineIndex);
        }, 150);
      } else {
        console.warn('[ShadowDOMRenderer] Invalid page number:', parsed.pageNumber);
      }
      return;
    }

    // Standard href navigation
    const targetHref = parsed.href;
    const hash = parsed.fragment;

    // Find the spine index with flexible matching
    let spineIndex = this.findSpineIndex(targetHref);

    if (spineIndex === -1) {
      console.warn('[ShadowDOMRenderer] Could not find spine item for href:', href);
      return;
    }

    // Navigate to the chapter
    const navResult = await this.navigator.goTo(
      { type: 'href', href: targetHref, fragment: hash },
      { instant: false }
    );

    // Apply pulse animation to target
    if (hash) {
      // Wait for content to render, then scroll to and highlight the element
      this.scrollToElementWithRetry(hash, 8, 50);
    } else {
      // No fragment - highlight the first visible element in the chapter
      setTimeout(() => {
        this.highlightFirstVisibleElement(spineIndex);
      }, 150);
    }
  }

  /**
   * Find spine index with flexible path matching
   */
  private findSpineIndex(href: string): number {
    if (!this.book) return -1;

    // Normalize the target href
    const normalizedTarget = this.normalizePath(href);
    const targetFilename = href.split('/').pop()?.split('#')[0] || '';

    return this.book.spine.findIndex((item) => {
      const itemHref = item.href.split('#')[0];
      const normalizedItem = this.normalizePath(itemHref);
      const itemFilename = itemHref.split('/').pop() || '';

      // Try various matching strategies
      return (
        // Exact match
        itemHref === href ||
        normalizedItem === normalizedTarget ||
        // Filename match
        itemFilename === targetFilename ||
        // Suffix/prefix matching for relative paths
        itemHref.endsWith(href) ||
        href.endsWith(itemHref) ||
        normalizedItem.endsWith(normalizedTarget) ||
        normalizedTarget.endsWith(normalizedItem)
      );
    });
  }

  /**
   * Normalize path by removing common prefixes
   */
  private normalizePath(path: string): string {
    return path
      .replace(/^\.\.\//, '')
      .replace(/^\.\//, '')
      .replace(/^OEBPS\//, '')
      .replace(/^OPS\//, '')
      .replace(/^text\//, '')
      .replace(/^Text\//, '');
  }

  // Track highlight ID being navigated to - prevents chapterVisible from adding it with wrong range
  private navigatingToHighlightId: string | null = null;

  /**
   * Navigate to a highlight by CFI and text.
   * Uses text search to find the exact location within the chapter.
   * Enhanced with:
   * - Skip navigation if already visible
   * - Highlight color for blink effect
   * - Directional animations for scrolled mode
   * - Fade transitions for paginated mode
   */
  async navigateToHighlight(cfi: string, text: string, color?: HighlightColor): Promise<void> {
    if (!this.navigator || !this.view || !this.book) return;

    // Extract spine index from CFI
    const spineIndex = this.getSpineIndexFromCfi(cfi);
    if (spineIndex === null || spineIndex < 0) {
      console.warn('[ShadowDOMRenderer] Could not parse CFI:', cfi);
      return;
    }

    const spineItem = this.book.spine[spineIndex];
    if (!spineItem) {
      console.warn('[ShadowDOMRenderer] Invalid spine index:', spineIndex);
      return;
    }

    // Find the matching highlight IMMEDIATELY and remove it from CSS highlights
    // This prevents chapterVisible's reanchorHighlights from adding it with the wrong range
    const matchingHighlight = this.storedHighlights.find(h =>
      h.spineIndex === spineIndex && h.text === text && h.color === color
    );
    if (matchingHighlight) {
      this.navigatingToHighlightId = matchingHighlight.id;
      // Remove immediately to prevent any flash of wrong range
      this.cssHighlights?.remove(matchingHighlight.id);
    }

    const shadowRoot = this.view.getShadowRoot();
    const viewportWrapper = this.view.getViewportWrapper();
    const isPaginatedMode = this.navigator.mode === 'paginated';
    const scrollContainer = shadowRoot.querySelector('.epub-scroll-container') as HTMLElement | null;

    // Try to find the chapter and range in current state
    let chapterEl = shadowRoot.querySelector(`.epub-chapter[data-spine-index="${spineIndex}"]`) as HTMLElement | null;
    let range: Range | null = null;
    let fullHighlightRange: Range | null = null;
    const searchText = text.slice(0, 100);

    // Pre-compute both ranges BEFORE any navigation/fading
    if (chapterEl) {
      range = this.findTextRange(searchText, chapterEl);
      if (range && matchingHighlight) {
        fullHighlightRange = this.findTextRange(matchingHighlight.text, chapterEl);
      }
    }

    const rangeToUse = fullHighlightRange || range;

    // CASE 1: Highlight is already visible - just scroll to center and pulse
    if (range && this.isRangeVisible(range)) {
      // Add CSS highlight first (ensures persistence)
      if (matchingHighlight && this.cssHighlights && color && rangeToUse) {
        this.cssHighlights.add(matchingHighlight.id, rangeToUse.cloneRange(), color);
      }

      // Smooth scroll to center the highlight (for scrolled mode)
      if (!isPaginatedMode && scrollContainer) {
        const rect = range.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        const targetScrollTop = scrollContainer.scrollTop + (rect.top - containerRect.top) - (containerRect.height / 2) + (rect.height / 2);
        scrollContainer.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
      }

      // Apply pulse animation (visual effect only, CSS highlight already added)
      if (rangeToUse) {
        this.highlightTextWithBlink(rangeToUse, text, color, rangeToUse);
      }

      this.navigatingToHighlightId = null;
      return;
    }

    // CASE 2: Highlight not visible - hide, navigate, then fade in
    const fadeTarget = isPaginatedMode ? viewportWrapper : scrollContainer;

    // Set opacity 0 AND visibility hidden for complete invisibility during navigation
    if (fadeTarget) {
      fadeTarget.style.transition = 'none';
      fadeTarget.style.opacity = '0';
      fadeTarget.style.visibility = 'hidden';
    }

    // Force instant scrolling (disable smooth scroll during navigation)
    const originalScrollBehavior = scrollContainer?.style.scrollBehavior || '';
    if (scrollContainer) {
      scrollContainer.style.scrollBehavior = 'auto';
    }

    // CRITICAL: Wait for hide styles to be painted BEFORE navigation
    // Without this, goTo() triggers DOM operations that paint before opacity:0 is rendered
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Navigate to the chapter to ensure it's loaded
    await this.navigator.goTo(
      { type: 'href', href: spineItem.href },
      { instant: true }
    );

    // Re-find the chapter element after navigation (may have changed)
    chapterEl = shadowRoot.querySelector(`.epub-chapter[data-spine-index="${spineIndex}"]`) as HTMLElement | null;

    if (!chapterEl) {
      console.warn('[ShadowDOMRenderer] Chapter element not found for spine index:', spineIndex);
      if (fadeTarget) {
        fadeTarget.style.transition = '';
        fadeTarget.style.opacity = '';
        fadeTarget.style.visibility = '';
      }
      this.navigatingToHighlightId = null;
      return;
    }

    // Re-find range if chapter element changed or wasn't found before
    if (!range || !chapterEl.contains(range.commonAncestorContainer)) {
      range = this.findTextRange(searchText, chapterEl);
      if (range && matchingHighlight) {
        fullHighlightRange = this.findTextRange(matchingHighlight.text, chapterEl);
      }
    }

    if (!range) {
      console.warn('[ShadowDOMRenderer] Text not found in chapter:', searchText.slice(0, 30));
      if (fadeTarget) {
        fadeTarget.style.transition = '';
        fadeTarget.style.opacity = '';
        fadeTarget.style.visibility = '';
      }
      this.navigatingToHighlightId = null;
      return;
    }

    const finalRange = fullHighlightRange || range;

    // For paginated mode, navigate while hidden
    const targetElement = range.commonAncestorContainer.parentElement;
    if (isPaginatedMode && targetElement) {
      await this.navigator.navigateToElement(targetElement, spineIndex, { instant: true });
    }

    // Add CSS highlight (while still hidden) - ensures persistence
    if (matchingHighlight && this.cssHighlights && color) {
      this.cssHighlights.add(matchingHighlight.id, finalRange.cloneRange(), color);
    }

    // Restore visibility but keep opacity 0 - needed for accurate getBoundingClientRect
    if (fadeTarget) {
      fadeTarget.style.visibility = '';
    }

    // Wait for layout with visibility restored
    await new Promise(r => requestAnimationFrame(r));

    // For scrolled mode, now calculate and set scroll position (visibility restored, opacity still 0)
    if (!isPaginatedMode && scrollContainer && targetElement) {
      const rect = range.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const targetScrollTop = scrollContainer.scrollTop + (rect.top - containerRect.top) - (containerRect.height / 2) + (rect.height / 2);
      scrollContainer.scrollTop = targetScrollTop;
      // Wait for scroll to be painted
      await new Promise(r => requestAnimationFrame(r));
    }

    // Now fade in
    if (fadeTarget) {
      fadeTarget.style.transition = 'opacity 0.15s ease-in';
      fadeTarget.style.opacity = '1';
      await new Promise(r => setTimeout(r, 150));
      fadeTarget.style.transition = '';
      fadeTarget.style.opacity = '';
    }

    // Restore original scroll behavior
    if (scrollContainer) {
      scrollContainer.style.scrollBehavior = originalScrollBehavior;
    }

    // Start pulse animation AFTER fade-in (visual effect only, CSS highlight already added)
    this.highlightTextWithBlink(finalRange, text, color, finalRange);

    // Re-anchor OTHER highlights in background
    this.reanchorHighlights().then(() => {
      this.navigatingToHighlightId = null;
    });
  }

  /**
   * Check if a range is currently visible in the viewport
   */
  private isRangeVisible(range: Range): boolean {
    const rect = range.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    // Check if any part of the range is in the viewport
    return (
      rect.top < viewportHeight &&
      rect.bottom > 0 &&
      rect.left < viewportWidth &&
      rect.right > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  /**
   * Get spine index from CFI
   */
  private getSpineIndexFromCfi(cfi: string): number | null {
    // Extract spine step from CFI (e.g., "epubcfi(/6/4!/4/2)" -> 4 -> spineIndex 1)
    const match = cfi.match(/epubcfi\(\/\d+\/(\d+)/);
    if (!match) return null;

    const spineStep = parseInt(match[1], 10);
    // CFI uses 1-based indexing with step of 2
    return Math.floor(spineStep / 2) - 1;
  }

  /**
   * Find text range within an element.
   * Fixed: Uses direct text matching without problematic whitespace normalization.
   * Fixed: Properly handles multi-node text selections.
   */
  private findTextRange(searchText: string, container: HTMLElement): Range | null {
    const doc = container.ownerDocument;
    const treeWalker = doc.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      null
    );

    // Collect all text nodes with their positions
    let fullText = '';
    const textNodes: Text[] = [];
    const nodeStarts: number[] = [];

    while (treeWalker.nextNode()) {
      const node = treeWalker.currentNode as Text;
      nodeStarts.push(fullText.length);
      textNodes.push(node);
      fullText += node.textContent || '';
    }

    if (textNodes.length === 0) return null;

    // Try direct match first (preserve original whitespace)
    let matchStart = fullText.indexOf(searchText);

    // If no direct match, try with normalized whitespace
    if (matchStart === -1) {
      // Build a mapping from normalized position to original position
      const normalizedToOriginal: number[] = [];
      let normalizedText = '';

      for (let i = 0; i < fullText.length; i++) {
        const char = fullText[i];
        if (/\s/.test(char)) {
          // Collapse consecutive whitespace
          if (normalizedText.length === 0 || !/\s/.test(normalizedText[normalizedText.length - 1])) {
            normalizedToOriginal.push(i);
            normalizedText += ' ';
          }
        } else {
          normalizedToOriginal.push(i);
          normalizedText += char;
        }
      }

      const normalizedSearch = searchText.replace(/\s+/g, ' ');
      let normalizedMatchStart = normalizedText.indexOf(normalizedSearch);

      // Try case-insensitive if still not found
      if (normalizedMatchStart === -1) {
        normalizedMatchStart = normalizedText.toLowerCase().indexOf(normalizedSearch.toLowerCase());
      }

      if (normalizedMatchStart === -1) return null;

      // Map back to original position
      matchStart = normalizedToOriginal[normalizedMatchStart] ?? 0;
    }

    // Find the text length to match (use original search text length as guide)
    const matchLength = searchText.length;
    const matchEnd = Math.min(matchStart + matchLength, fullText.length);

    // Find start node and offset
    let startNodeIndex = 0;
    for (let i = textNodes.length - 1; i >= 0; i--) {
      if (nodeStarts[i] <= matchStart) {
        startNodeIndex = i;
        break;
      }
    }

    // Find end node and offset
    let endNodeIndex = startNodeIndex;
    for (let i = textNodes.length - 1; i >= 0; i--) {
      if (nodeStarts[i] <= matchEnd) {
        endNodeIndex = i;
        break;
      }
    }

    const startNode = textNodes[startNodeIndex];
    const endNode = textNodes[endNodeIndex];
    const startOffset = matchStart - nodeStarts[startNodeIndex];
    const endOffset = matchEnd - nodeStarts[endNodeIndex];

    // Create the range spanning multiple nodes if needed
    const range = doc.createRange();
    try {
      range.setStart(startNode, Math.min(startOffset, startNode.length));
      range.setEnd(endNode, Math.min(endOffset, endNode.length));
    } catch (e) {
      console.warn('[ShadowDOMRenderer] Range creation error:', e);
      return null;
    }

    return range;
  }

  /**
   * Highlight color mapping for blink animation.
   * IMPORTANT: Must match opacity values in css-highlights.ts (0.5/50%)
   * to prevent duplicate/layered visual effect when both are visible.
   */
  private readonly BLINK_COLORS: Record<HighlightColor, string> = {
    yellow: 'rgba(254, 243, 199, 0.5)',
    green: 'rgba(187, 247, 208, 0.5)',
    blue: 'rgba(191, 219, 254, 0.5)',
    pink: 'rgba(251, 207, 232, 0.5)',
    purple: 'rgba(221, 214, 254, 0.5)',
    orange: 'rgba(254, 215, 170, 0.5)',
  };

  /**
   * Highlight text with blink animation using the highlight's color.
   * For highlights: Uses the actual highlight color to span the full text.
   * For other elements (links, headings): Uses the accent color.
   *
   * @param range - The base range to animate
   * @param fullText - Optional full text (used as fallback for range finding)
   * @param color - Highlight color for blink effect
   * @param precomputedRange - Optional pre-computed range to use directly (avoids re-finding)
   */
  private highlightTextWithBlink(range: Range, fullText?: string, color?: HighlightColor, precomputedRange?: Range): void {
    try {
      // For highlights with color, create a custom blink effect
      if (color && this.BLINK_COLORS[color]) {
        this.applyHighlightBlink(range, fullText, color, precomputedRange);
        return;
      }

      // Fallback: Create a temporary span around the text with default accent color
      const span = document.createElement('span');
      span.className = 'highlight-blink';
      range.surroundContents(span);

      // Remove after animation
      setTimeout(() => {
        const parent = span.parentNode;
        if (parent) {
          while (span.firstChild) {
            parent.insertBefore(span.firstChild, span);
          }
          parent.removeChild(span);
        }
      }, 800);
    } catch (e) {
      // Range might span multiple elements, use alternative approach
      const ancestor = range.commonAncestorContainer.parentElement;
      if (ancestor) {
        this.applyLinkTargetAnimation(ancestor);
      }
    }
  }

  /**
   * Apply blink animation for highlights with their specific color.
   * Creates an overlay that pulses with the highlight color.
   *
   * In scrolled mode: Uses position: absolute within scroll container so
   * the overlay scrolls with content (prevents floating/stuck overlays).
   * In paginated mode: Uses position: fixed for viewport-relative overlay.
   *
   * Note: CSS highlight should already be added before calling this method.
   * This just provides the visual pulse effect.
   *
   * @param range - Base range (used as fallback)
   * @param fullText - Full text (used for fallback range finding)
   * @param color - Highlight color
   * @param precomputedRange - Optional pre-computed range (used directly if provided)
   */
  private applyHighlightBlink(range: Range, fullText?: string, color?: HighlightColor, precomputedRange?: Range): void {
    if (!this.view || !color) return;

    const blinkColor = this.BLINK_COLORS[color] || this.BLINK_COLORS.yellow;

    // Use precomputed range if provided, otherwise try to find it
    let targetRange: Range;
    if (precomputedRange) {
      // Use the exact same range as the CSS highlight - no re-finding needed
      targetRange = precomputedRange;
    } else if (fullText && fullText.length > 100) {
      // Fallback: Try to find the full text range
      const container = range.commonAncestorContainer.parentElement;
      if (container) {
        const fullRange = this.findTextRange(fullText, container);
        targetRange = fullRange || range;
      } else {
        targetRange = range;
      }
    } else {
      targetRange = range;
    }

    // Get all client rects for the range (handles multi-line highlights)
    const rects = Array.from(targetRange.getClientRects());
    if (rects.length === 0) return;

    // Check if we're in scrolled mode by looking for scroll container
    const shadowRoot = this.view.getShadowRoot();
    const scrollContainer = shadowRoot?.querySelector('.epub-scroll-container') as HTMLElement | null;
    const isScrolledMode = !!scrollContainer;

    // Get scroll offset and container position for coordinate adjustment
    let scrollOffsetX = 0;
    let scrollOffsetY = 0;
    let containerOffsetX = 0;
    let containerOffsetY = 0;

    if (isScrolledMode && scrollContainer) {
      scrollOffsetX = scrollContainer.scrollLeft;
      scrollOffsetY = scrollContainer.scrollTop;
      const containerRect = scrollContainer.getBoundingClientRect();
      containerOffsetX = containerRect.left;
      containerOffsetY = containerRect.top;
    }

    // Create overlay container
    const overlayContainer = document.createElement('div');
    overlayContainer.className = 'highlight-blink-overlay';

    if (isScrolledMode) {
      // Scrolled mode: Use absolute positioning within scroll container
      overlayContainer.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 9999;
      `;
    } else {
      // Paginated mode: Use fixed positioning for viewport overlay
      overlayContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 9999;
      `;
    }

    // Create blink rectangles for each line of the highlight
    for (const rect of rects) {
      if (rect.width < 2 || rect.height < 2) continue;

      const blinkRect = document.createElement('div');
      blinkRect.className = 'highlight-blink-rect';

      if (isScrolledMode) {
        // Convert viewport coords to scroll-container coords
        // rect.top/left are viewport-relative from getClientRects()
        // We need scroll-container-relative + scroll offset
        const absoluteTop = rect.top - containerOffsetY + scrollOffsetY;
        const absoluteLeft = rect.left - containerOffsetX + scrollOffsetX;

        blinkRect.style.cssText = `
          position: absolute;
          top: ${absoluteTop}px;
          left: ${absoluteLeft}px;
          width: ${rect.width}px;
          height: ${rect.height}px;
          background-color: ${blinkColor};
          border-radius: 2px;
          animation: highlight-pulse 1.3s ease-in-out forwards;
          pointer-events: none;
        `;
      } else {
        // Paginated mode: Use viewport coords directly
        blinkRect.style.cssText = `
          position: fixed;
          top: ${rect.top}px;
          left: ${rect.left}px;
          width: ${rect.width}px;
          height: ${rect.height}px;
          background-color: ${blinkColor};
          border-radius: 2px;
          animation: highlight-pulse 1.3s ease-in-out forwards;
          pointer-events: none;
        `;
      }
      overlayContainer.appendChild(blinkRect);
    }

    // Add keyframes - in scrolled mode add to scroll container, otherwise document
    if (isScrolledMode && scrollContainer) {
      this.ensureBlinkKeyframesInScrollContainer(scrollContainer);
      scrollContainer.appendChild(overlayContainer);
    } else {
      this.ensureBlinkKeyframesInDocument();
      document.body.appendChild(overlayContainer);
    }

    // Track scroll ignore timeout for cleanup
    let scrollIgnoreTimeout: ReturnType<typeof setTimeout> | null = null;

    // Cleanup function for removing overlay and event listeners
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;

      overlayContainer.remove();

      if (scrollCleanupHandler) {
        scrollContainer?.removeEventListener('scroll', scrollCleanupHandler);
      }
      // Clear the ignore timeout if still pending (prevents memory leak)
      if (scrollIgnoreTimeout !== null) {
        clearTimeout(scrollIgnoreTimeout);
        scrollIgnoreTimeout = null;
      }
    };

    // In scrolled mode: add scroll listener to cancel blink if user scrolls
    // This prevents the overlay from becoming stale/misaligned during user interaction
    let scrollCleanupHandler: ((event: Event) => void) | null = null;
    if (isScrolledMode && scrollContainer) {
      // Small debounce to ignore the initial scroll that brought us here
      scrollIgnoreTimeout = setTimeout(() => {
        scrollIgnoreTimeout = null;
      }, 100);

      scrollCleanupHandler = () => {
        // Ignore scroll events within first 100ms (from navigation)
        if (scrollIgnoreTimeout !== null) return;
        // User scrolled during animation - clean up immediately
        cleanup();
      };
      scrollContainer.addEventListener('scroll', scrollCleanupHandler, { passive: true });
    }

    // Remove after animation completes (1.3s animation + small buffer)
    setTimeout(cleanup, 1400);
  }

  /**
   * Pulse animation keyframes CSS.
   * CSS highlight is visible underneath. Overlay pulses to create attention effect.
   * Pattern: 0.5 → 0 → 0.5 → 0 → 0.5 → 0.5 (ends matching CSS highlight)
   * Duration: 1.3s
   */
  private readonly PULSE_KEYFRAMES = `
    @keyframes highlight-pulse {
      0% { opacity: 0.5; }
      20% { opacity: 0; }
      40% { opacity: 0.5; }
      60% { opacity: 0; }
      80% { opacity: 0.5; }
      100% { opacity: 0.5; }
    }
  `;

  /**
   * Ensure the blink keyframes are added to the scroll container
   */
  private ensureBlinkKeyframesInScrollContainer(scrollContainer: HTMLElement): void {
    const existingStyle = scrollContainer.querySelector('#highlight-blink-keyframes-scroll');
    if (existingStyle) return;

    const style = document.createElement('style');
    style.id = 'highlight-blink-keyframes-scroll';
    style.textContent = this.PULSE_KEYFRAMES;
    scrollContainer.appendChild(style);
  }

  /**
   * Ensure the blink keyframes are added to the shadow root
   */
  private ensureBlinkKeyframes(shadowRoot: ShadowRoot): void {
    const existingStyle = shadowRoot.querySelector('#highlight-blink-keyframes');
    if (existingStyle) return;

    const style = document.createElement('style');
    style.id = 'highlight-blink-keyframes';
    style.textContent = this.PULSE_KEYFRAMES;
    shadowRoot.appendChild(style);
  }

  /**
   * Ensure the blink keyframes are added to the document head
   * (needed when overlay is appended to document.body instead of shadow root)
   */
  private ensureBlinkKeyframesInDocument(): void {
    const existingStyle = document.getElementById('highlight-blink-keyframes-global');
    if (existingStyle) return;

    const style = document.createElement('style');
    style.id = 'highlight-blink-keyframes-global';
    style.textContent = this.PULSE_KEYFRAMES;
    document.head.appendChild(style);
  }

  /**
   * Apply blink animation to highlight a navigation target
   */
  private applyLinkTargetAnimation(element: Element): void {
    // Remove any existing animation
    element.classList.remove('highlight-blink');

    // Force a reflow to restart animation
    void (element as HTMLElement).offsetWidth;

    // Add the animation class
    element.classList.add('highlight-blink');

    // Remove the class after animation completes (2 blinks × 0.7s = 1.4s)
    setTimeout(() => {
      element.classList.remove('highlight-blink');
    }, 1500);
  }

  // ============================================================================
  // Event System
  // ============================================================================

  on<K extends keyof RendererEvents>(
    event: K,
    callback: RendererEventListener<K>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => this.off(event, callback);
  }

  off<K extends keyof RendererEvents>(
    event: K,
    callback: RendererEventListener<K>
  ): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit<K extends keyof RendererEvents>(event: K, data: RendererEvents[K]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (error) {
          console.error(`[ShadowDOMRenderer] Error in ${event} handler:`, error);
        }
      }
    }
  }

  // ============================================================================
  // Accessors
  // ============================================================================

  getBook(): ParsedBook | null {
    return this.book;
  }

  getToc() {
    return this.book?.toc ?? [];
  }

  getSpine() {
    return this.book?.spine ?? [];
  }

  getMetadata() {
    return this.book?.metadata ?? null;
  }

  getShadowRoot(): ShadowRoot | null {
    return this.view?.getShadowRoot() ?? null;
  }

  getContentContainer(): HTMLElement | null {
    return this.view?.getContentContainer() ?? null;
  }

  /**
   * Clear the current text selection.
   * Call this immediately after creating a highlight to deselect text.
   */
  clearSelection(): void {
    this.selection?.clearSelection();
    // Also clear using window.getSelection for broader compatibility
    window.getSelection()?.removeAllRanges();
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  destroy(): void {
    // Stop theme observer
    if (this.themeObserver) {
      this.themeObserver.disconnect();
      this.themeObserver = null;
    }

    // Remove link click handler
    if (this.boundLinkClickHandler && this.view) {
      this.view.getShadowRoot().removeEventListener('click', this.boundLinkClickHandler as EventListener);
      this.boundLinkClickHandler = null;
    }

    // Destroy navigator
    this.destroyNavigator();

    // Clear highlights
    this.cssHighlights?.clear();
    this.cssHighlights = null;

    // Destroy selection handler
    this.selection?.destroy();
    this.selection = null;

    // Destroy content sanitizer
    this.sanitizer.destroy();

    // Destroy view
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }

    // Clear listeners
    this.listeners.clear();

    // Clear state
    this.book = null;
    this.bookId = '';
    this.storedHighlights = [];
  }
}

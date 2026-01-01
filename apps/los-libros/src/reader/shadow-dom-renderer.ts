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
import type { ContentProvider } from './renderer/renderer';
import { ShadowDOMView } from './shadow-dom-view';
import {
  createNavigator,
  type Navigator,
  type NavigatorConfig,
  type Locator,
  type SpineItemContent,
} from './navigator';
import { anchorToDOM, reanchorLocators } from './locator';
import { CSSHighlightManager, isCSSHighlightAPISupported } from './renderer/css-highlights';
import { SelectionHandler, type SelectionData } from './renderer/selection';
import { getObsidianThemeColors, isObsidianDarkMode } from './reader-settings';
import { generateFullCfi } from './renderer/cfi-utils';

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
    if (isCSSHighlightAPISupported()) {
      console.log('[ShadowDOMRenderer] Using CSS Custom Highlight API');
      this.cssHighlights = new CSSHighlightManager(
        this.view.getDocument(),
        (highlightId, position) => this.emit('highlightClicked', { annotationId: highlightId, position })
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
    // Clean up event listeners
    for (const cleanup of this.navigatorCleanup) {
      cleanup();
    }
    this.navigatorCleanup = [];

    // Destroy navigator
    if (this.navigator) {
      this.navigator.destroy();
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
    // Process relative URLs, sanitize, etc.
    // This can be expanded based on needs
    return html;
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

  updateConfig(config: Partial<RendererConfig>): void {
    const oldMode = this.config.mode;
    this.config = { ...this.config, ...config };

    // Handle mode switch
    if (config.mode && config.mode !== oldMode) {
      this.handleModeSwitch(config.mode);
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
    // Save current location
    const savedLocation = this.navigator?.getCurrentLocation();

    // Cache chapter elements from current navigator before destroying
    this.cacheChapterElements();

    // Update config mode BEFORE creating navigator
    this.config.mode = newMode;

    // Update view's mode class
    if (this.view) {
      this.view.setMode(newMode);
    }

    // Create new navigator (uses this.config.mode)
    this.createNavigator();

    // Reinitialize with content
    if (this.view && this.navigator && this.book) {
      await this.navigator.initialize(this.view.getContentContainer(), this.getNavigatorConfig());

      const spineContent = await this.loadSpineContent();

      // Use cached elements if available for faster switching
      await this.navigator.loadContent(spineContent, savedLocation ?? undefined, this.cachedChapterElements);
    }
  }

  /**
   * Cache chapter elements from current navigator for reuse
   */
  private cacheChapterElements(): void {
    if (!this.view) return;

    const container = this.view.getContentContainer();

    // Find all chapter elements in current DOM
    const chapters = container.querySelectorAll('.epub-chapter');

    for (const chapter of chapters) {
      const spineIndex = parseInt(chapter.getAttribute('data-spine-index') || '-1', 10);
      if (spineIndex >= 0) {
        // Clone the element to preserve it (since we'll clear the container)
        this.cachedChapterElements.set(spineIndex, chapter.cloneNode(true) as HTMLElement);
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

  private async reanchorHighlights(): Promise<void> {
    if (!this.view || !this.cssHighlights || this.storedHighlights.length === 0) {
      return;
    }

    const container = this.view.getContentContainer();

    for (const highlight of this.storedHighlights) {
      if (!highlight.cfi) continue;

      // Get the href from the spine index
      const spineItem = this.book?.spine[highlight.spineIndex];
      const href = spineItem?.href || '';

      // Create locator from highlight
      const locator: Locator = {
        href,
        locations: {
          progression: 0,
          cfi: highlight.cfi,
          position: highlight.spineIndex,
        },
        text: highlight.text
          ? { highlight: highlight.text }
          : undefined,
      };

      // Anchor to DOM
      const result = await anchorToDOM(locator, container);

      if (result) {
        this.cssHighlights.add(
          highlight.id,
          result.range,
          highlight.color as HighlightColor
        );
      }
    }
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

    // Translate position from shadow DOM to viewport coordinates
    const viewportPosition = this.translateToViewportCoords(data.position);

    // Emit the selected event
    this.emit('selected', {
      text: data.text,
      cfi,
      range: data.range,
      position: viewportPosition,
      spineIndex: this.currentSpineIndex,
      selector: data.selector,
    });
  }

  /**
   * Translate coordinates from shadow DOM document to main viewport
   */
  private translateToViewportCoords(pos: { x: number; y: number }): { x: number; y: number } {
    if (!this.view) return pos;

    // Get the container's position in the viewport
    const containerRect = this.container.getBoundingClientRect();

    return {
      x: pos.x + containerRect.left,
      y: pos.y + containerRect.top,
    };
  }

  // ============================================================================
  // Link Handling
  // ============================================================================

  /**
   * Set up click handler for links within the content
   */
  private setupLinkHandler(): void {
    if (!this.view) return;

    const shadowRoot = this.view.getShadowRoot();

    this.boundLinkClickHandler = (e: MouseEvent) => {
      const target = e.target as Element;
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

    // Split href into path and hash
    let targetHref = href;
    let hash: string | undefined;

    const hashIndex = href.indexOf('#');
    if (hashIndex !== -1) {
      targetHref = href.substring(0, hashIndex);
      hash = href.substring(hashIndex + 1);
    }

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

  /**
   * Navigate to a highlight by CFI and text.
   * Uses text search to find the exact location within the chapter.
   */
  async navigateToHighlight(cfi: string, text: string): Promise<void> {
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

    // First, navigate to the chapter to ensure it's loaded
    await this.navigator.goTo(
      { type: 'href', href: spineItem.href },
      { instant: true }
    );

    // Wait for content to be ready
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 100));

    // Find the text within the chapter
    const searchText = text.slice(0, 100);
    const shadowRoot = this.view.getShadowRoot();
    const chapterEl = shadowRoot.querySelector(`.epub-chapter[data-spine-index="${spineIndex}"]`);

    if (!chapterEl) {
      console.warn('[ShadowDOMRenderer] Chapter element not found for spine index:', spineIndex);
      return;
    }

    // Search for the text
    const range = this.findTextRange(searchText, chapterEl as HTMLElement);

    if (!range) {
      console.warn('[ShadowDOMRenderer] Text not found in chapter:', searchText.slice(0, 30));
      return;
    }

    // Navigate to the column containing the text
    const targetElement = range.commonAncestorContainer.parentElement;
    if (targetElement) {
      // For paginated mode, need to navigate to the correct column
      const elementColumn = this.getColumnForElement(targetElement, spineIndex);
      if (elementColumn !== null) {
        await this.navigator.goTo(
          { type: 'progression', progression: elementColumn / this.getTotalColumns() },
          { instant: true }
        );
      }

      // Apply blink animation
      await new Promise(r => setTimeout(r, 50));
      this.highlightTextWithBlink(range);
    }
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
   * Find text range within an element
   */
  private findTextRange(searchText: string, container: HTMLElement): Range | null {
    const doc = container.ownerDocument;
    const treeWalker = doc.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      null
    );

    let fullText = '';
    const textNodes: Text[] = [];
    const nodeStarts: number[] = [];

    while (treeWalker.nextNode()) {
      const node = treeWalker.currentNode as Text;
      nodeStarts.push(fullText.length);
      textNodes.push(node);
      fullText += node.textContent || '';
    }

    // Normalize text for comparison
    const normalizedFull = fullText.replace(/\s+/g, ' ');
    const normalizedSearch = searchText.replace(/\s+/g, ' ');

    let matchIndex = normalizedFull.indexOf(normalizedSearch);
    if (matchIndex === -1) {
      // Try case-insensitive
      matchIndex = normalizedFull.toLowerCase().indexOf(normalizedSearch.toLowerCase());
    }

    if (matchIndex === -1) return null;

    // Map back to original positions
    let currentPos = 0;
    let originalStart = 0;
    for (let i = 0; i < normalizedFull.length && i <= matchIndex; i++) {
      while (currentPos < fullText.length && /\s/.test(fullText[currentPos]) && fullText[currentPos] !== normalizedFull[i]) {
        currentPos++;
      }
      if (i === matchIndex) {
        originalStart = currentPos;
        break;
      }
      currentPos++;
    }

    // Find start node and offset
    let startNodeIndex = 0;
    for (let i = textNodes.length - 1; i >= 0; i--) {
      if (nodeStarts[i] <= originalStart) {
        startNodeIndex = i;
        break;
      }
    }

    const startOffset = originalStart - nodeStarts[startNodeIndex];
    const startNode = textNodes[startNodeIndex];

    // Create the range
    const range = doc.createRange();
    try {
      range.setStart(startNode, Math.min(startOffset, startNode.length));
      // Set end based on search text length (approximate)
      const endOffset = Math.min(startOffset + searchText.length, startNode.length);
      range.setEnd(startNode, endOffset);
    } catch (e) {
      console.warn('[ShadowDOMRenderer] Range creation error:', e);
      return null;
    }

    return range;
  }

  /**
   * Get column number for an element
   */
  private getColumnForElement(element: HTMLElement, spineIndex: number): number | null {
    if (!this.navigator) return null;

    const container = this.navigator.getContentContainer();
    if (!container) return null;

    const columnWidth = this.navigator.getColumnWidth();
    const gap = this.config.columnGap;
    const pageWidth = columnWidth + gap;

    if (pageWidth <= 0) return null;

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const scrollLeft = container.scrollLeft;
    const elementLeft = elementRect.left - containerRect.left + scrollLeft;

    return Math.floor(elementLeft / pageWidth);
  }

  /**
   * Get total columns
   */
  private getTotalColumns(): number {
    const info = this.navigator?.getPaginationInfo();
    return info?.totalPages ?? 1;
  }

  /**
   * Highlight text with blink animation
   */
  private highlightTextWithBlink(range: Range): void {
    try {
      // Create a temporary span around the text
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
      }, 1500);
    } catch (e) {
      // Range might span multiple elements, use alternative approach
      const ancestor = range.commonAncestorContainer.parentElement;
      if (ancestor) {
        this.applyLinkTargetAnimation(ancestor);
      }
    }
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

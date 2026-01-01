/**
 * Shadow DOM View
 *
 * Replaces the iframe-based content isolation with Shadow DOM.
 * Benefits:
 * - No RAF throttling (iframe issue eliminated)
 * - Events bubble naturally to parent (no forwarding needed)
 * - Reduced memory overhead (~15MB savings)
 * - No sub-pixel drift from separate document contexts
 * - CSS isolation via Shadow DOM encapsulation
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

import type { ThemeColors, RendererConfig } from './renderer/types';

/**
 * Configuration for Shadow DOM View
 */
export interface ShadowDOMViewConfig {
  /** Theme colors to apply */
  themeColors: ThemeColors;
  /** Renderer configuration for styling */
  rendererConfig: Partial<RendererConfig>;
}

/**
 * Shadow DOM View class
 *
 * Provides CSS-isolated content rendering without iframe overhead.
 * The Shadow DOM boundary ensures book CSS doesn't leak to the app,
 * while allowing events to bubble naturally.
 */
export class ShadowDOMView {
  private host: HTMLElement;
  private shadowRoot: ShadowRoot;
  private viewportWrapper: HTMLElement;
  private contentContainer: HTMLElement;
  private navigatorMount: HTMLElement;

  // Style elements for dynamic updates
  private rendererStyles: HTMLStyleElement;
  private themeStyles: HTMLStyleElement;
  private bookStyles: HTMLStyleElement;
  private highlightStyles: HTMLStyleElement;

  // ResizeObserver for responsive layout
  private resizeObserver: ResizeObserver | null = null;
  private resizeCallbacks: Set<(rect: DOMRectReadOnly) => void> = new Set();

  // Track if view is attached to DOM
  private isAttached = false;

  constructor(container: HTMLElement) {
    this.host = container;

    // Create Shadow DOM with open mode for debugging
    this.shadowRoot = this.host.attachShadow({ mode: 'open' });

    // Create internal structure
    this.rendererStyles = document.createElement('style');
    this.rendererStyles.id = 'renderer-styles';

    this.themeStyles = document.createElement('style');
    this.themeStyles.id = 'theme-styles';

    this.bookStyles = document.createElement('style');
    this.bookStyles.id = 'book-styles';

    this.highlightStyles = document.createElement('style');
    this.highlightStyles.id = 'highlight-styles';

    // Viewport wrapper for scroll containment
    this.viewportWrapper = document.createElement('div');
    this.viewportWrapper.id = 'viewport-wrapper';

    // Content container for chapters
    this.contentContainer = document.createElement('div');
    this.contentContainer.id = 'content-container';

    // Navigator mount point (for navigator components)
    this.navigatorMount = document.createElement('div');
    this.navigatorMount.id = 'navigator-mount';

    // Assemble DOM structure
    this.viewportWrapper.appendChild(this.contentContainer);
    this.shadowRoot.appendChild(this.rendererStyles);
    this.shadowRoot.appendChild(this.themeStyles);
    this.shadowRoot.appendChild(this.bookStyles);
    this.shadowRoot.appendChild(this.highlightStyles);
    this.shadowRoot.appendChild(this.viewportWrapper);
    this.shadowRoot.appendChild(this.navigatorMount);

    // Apply base styles
    this.applyBaseStyles();

    // Setup resize observer
    this.setupResizeObserver();

    this.isAttached = true;
  }

  /**
   * Get the Shadow Root for direct access
   */
  getShadowRoot(): ShadowRoot {
    return this.shadowRoot;
  }

  /**
   * Get the content container element
   */
  getContentContainer(): HTMLElement {
    return this.contentContainer;
  }

  /**
   * Get the viewport wrapper element
   */
  getViewportWrapper(): HTMLElement {
    return this.viewportWrapper;
  }

  /**
   * Get the navigator mount point
   */
  getNavigatorMount(): HTMLElement {
    return this.navigatorMount;
  }

  /**
   * Get the document for selection/range operations
   * Shadow DOM shares the same document as the host
   */
  getDocument(): Document {
    return this.host.ownerDocument;
  }

  /**
   * Apply base renderer styles
   */
  private applyBaseStyles(): void {
    this.rendererStyles.textContent = `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        position: relative;
        overflow: hidden;
      }

      #viewport-wrapper {
        width: 100%;
        height: 100%;
        overflow: hidden;
        position: relative;
      }

      #content-container {
        width: 100%;
        height: 100%;
        position: relative;
        /* Enable text selection (override Obsidian's user-select: none) */
        user-select: text;
        -webkit-user-select: text;
        cursor: text;
      }

      /* Clipping wrapper for paginated mode - hides column overflow */
      #paginated-clip {
        width: 100%;
        height: 100%;
        position: absolute;
        top: 0;
        left: 0;
        overflow: hidden;
        pointer-events: none;
      }

      #paginated-clip > * {
        pointer-events: auto;
      }

      #navigator-mount {
        width: 100%;
        height: 100%;
        position: absolute;
        top: 0;
        left: 0;
        pointer-events: none;
      }

      #navigator-mount > * {
        pointer-events: auto;
      }

      /* Base chapter styles */
      .epub-chapter {
        box-sizing: border-box;
      }

      /* Paginated mode styles - use scroll for native scroll-snap pagination */
      :host(.mode-paginated) #viewport-wrapper {
        overflow: hidden;
        position: relative;
      }

      /* Right-edge mask to hide bleeding content from next column */
      :host(.mode-paginated) #viewport-wrapper::after {
        content: '';
        position: absolute;
        top: 0;
        right: 0;
        width: var(--page-margin, 60px);
        height: 100%;
        background: var(--theme-bg, var(--background-primary));
        z-index: 10;
        pointer-events: none;
      }

      :host(.mode-paginated) #content-container {
        column-fill: auto;
        overflow-x: scroll;
        overflow-y: hidden;
        scroll-snap-type: x mandatory;
        scroll-behavior: smooth;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none; /* Firefox */
      }

      :host(.mode-paginated) #content-container::-webkit-scrollbar {
        display: none; /* Chrome/Safari */
      }

      /* Paginated mode - ensure proper snap behavior for swipe gestures */
      :host(.mode-paginated) .epub-chapter {
        scroll-snap-align: start;
        scroll-snap-stop: always;
      }

      /* Scrolled mode styles */
      :host(.mode-scrolled) #viewport-wrapper {
        overflow-y: auto;
        overflow-x: hidden;
        /* Reserve space for scrollbar to prevent layout shift and margin asymmetry */
        scrollbar-gutter: stable;
      }

      :host(.mode-scrolled) #content-container {
        min-height: 100%;
      }

      /* Image handling */
      img {
        max-width: 100%;
        height: auto;
        object-fit: contain;
      }

      /* SVG handling */
      svg {
        max-width: 100%;
        height: auto;
      }

      /* Table handling for better responsiveness */
      table {
        max-width: 100%;
        overflow-x: auto;
        display: block;
      }

      /* Code block handling */
      pre {
        overflow-x: auto;
        max-width: 100%;
      }

      /* Prevent text selection during navigation */
      :host(.navigating) * {
        user-select: none !important;
      }

      /* CSS Custom Highlight API support */
      ::highlight(selection-preview) {
        background-color: rgba(0, 120, 215, 0.3);
      }

      ::highlight(search-result) {
        background-color: rgba(255, 235, 59, 0.6);
      }

      ::highlight(search-result-active) {
        background-color: rgba(255, 152, 0, 0.8);
      }

      /* Highlight colors */
      ::highlight(highlight-yellow) {
        background-color: rgba(255, 235, 59, 0.4);
      }

      ::highlight(highlight-green) {
        background-color: rgba(76, 175, 80, 0.4);
      }

      ::highlight(highlight-blue) {
        background-color: rgba(33, 150, 243, 0.4);
      }

      ::highlight(highlight-pink) {
        background-color: rgba(233, 30, 99, 0.4);
      }

      ::highlight(highlight-orange) {
        background-color: rgba(255, 152, 0, 0.4);
      }

      ::highlight(highlight-purple) {
        background-color: rgba(156, 39, 176, 0.4);
      }

      /* Blink animation for navigation feedback - uses Obsidian accent color */
      @keyframes highlight-blink {
        0%, 100% { background-color: transparent; }
        50% { background-color: var(--interactive-accent, #7b6cd9); opacity: 0.35; }
      }

      .highlight-blink {
        animation: highlight-blink 0.7s ease-in-out 2;
      }
    `;
  }

  /**
   * Apply theme colors
   */
  applyTheme(colors: ThemeColors): void {
    this.themeStyles.textContent = `
      :host {
        --theme-bg: ${colors.background};
        --theme-fg: ${colors.foreground};
        --theme-link: ${colors.linkColor};
        --theme-highlight: ${colors.highlightColor};
      }

      #viewport-wrapper {
        background-color: var(--theme-bg);
        color: var(--theme-fg);
      }

      #content-container {
        color: var(--theme-fg);
      }

      a {
        color: var(--theme-link);
      }

      a:visited {
        color: var(--theme-link);
        opacity: 0.8;
      }

      ::selection {
        background-color: var(--theme-highlight);
      }
    `;
  }

  /**
   * Apply typography and layout configuration
   */
  applyRendererConfig(config: Partial<RendererConfig>): void {
    const fontSize = config.fontSize ?? 16;
    const fontFamily = config.fontFamily ?? 'Georgia, serif';
    const lineHeight = config.lineHeight ?? 1.6;
    const textAlign = config.textAlign ?? 'justify';
    const margin = config.margin ?? 40;
    const columnGap = config.columnGap ?? 60;

    // Update host class for mode
    this.host.classList.remove('mode-paginated', 'mode-scrolled');
    this.host.classList.add(`mode-${config.mode ?? 'paginated'}`);

    this.rendererStyles.textContent = this.rendererStyles.textContent + `
      #content-container {
        font-size: ${fontSize}px;
        font-family: ${fontFamily};
        line-height: ${lineHeight};
        text-align: ${textAlign};
        padding: ${margin}px;
      }

      :host(.mode-paginated) #content-container {
        column-gap: ${columnGap}px;
      }
    `;
  }

  /**
   * Set book-specific styles (from EPUB CSS)
   */
  setBookStyles(css: string): void {
    // Sanitize and scope the CSS
    const sanitizedCSS = this.sanitizeBookCSS(css);
    this.bookStyles.textContent = sanitizedCSS;
  }

  /**
   * Sanitize book CSS to prevent escaping shadow DOM
   * and remove potentially dangerous rules
   */
  private sanitizeBookCSS(css: string): string {
    // Remove @import rules (security)
    let sanitized = css.replace(/@import[^;]+;/gi, '');

    // Remove @font-face with external URLs (keep data: URLs)
    sanitized = sanitized.replace(
      /@font-face\s*\{[^}]*url\s*\(\s*["']?(?!data:)[^"')]+["']?\s*\)[^}]*\}/gi,
      ''
    );

    // Remove position: fixed (would escape shadow DOM visually)
    sanitized = sanitized.replace(/position\s*:\s*fixed/gi, 'position: absolute');

    // Remove z-index values above 1000 (prevent overlay issues)
    sanitized = sanitized.replace(/z-index\s*:\s*(\d+)/gi, (match, value) => {
      const zIndex = parseInt(value, 10);
      return zIndex > 1000 ? 'z-index: 1000' : match;
    });

    // Scope body/html selectors to content container
    sanitized = sanitized.replace(/\bbody\b/gi, '#content-container');
    sanitized = sanitized.replace(/\bhtml\b/gi, ':host');

    return sanitized;
  }

  /**
   * Set custom highlight styles
   */
  setHighlightStyles(css: string): void {
    this.highlightStyles.textContent = css;
  }

  /**
   * Add content to the container
   */
  setContent(html: string): void {
    this.contentContainer.innerHTML = html;
  }

  /**
   * Append content to the container
   */
  appendContent(element: HTMLElement): void {
    this.contentContainer.appendChild(element);
  }

  /**
   * Clear all content
   */
  clearContent(): void {
    this.contentContainer.innerHTML = '';
  }

  /**
   * Setup resize observer for responsive layout
   */
  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === this.host) {
          for (const callback of this.resizeCallbacks) {
            callback(entry.contentRect);
          }
        }
      }
    });

    this.resizeObserver.observe(this.host);
  }

  /**
   * Register a resize callback
   */
  onResize(callback: (rect: DOMRectReadOnly) => void): () => void {
    this.resizeCallbacks.add(callback);
    return () => this.resizeCallbacks.delete(callback);
  }

  /**
   * Get the current dimensions
   */
  getDimensions(): { width: number; height: number } {
    const rect = this.host.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
    };
  }

  /**
   * Force integer dimensions to prevent sub-pixel drift
   * Call this before calculating column widths for pagination
   */
  getIntegerDimensions(): { width: number; height: number } {
    const rect = this.host.getBoundingClientRect();
    return {
      width: Math.floor(rect.width),
      height: Math.floor(rect.height),
    };
  }

  /**
   * Set display mode class
   */
  setMode(mode: 'paginated' | 'scrolled'): void {
    this.host.classList.remove('mode-paginated', 'mode-scrolled');
    this.host.classList.add(`mode-${mode}`);
  }

  /**
   * Set navigating state (disables text selection)
   */
  setNavigating(navigating: boolean): void {
    if (navigating) {
      this.host.classList.add('navigating');
    } else {
      this.host.classList.remove('navigating');
    }
  }

  /**
   * Query elements within the shadow DOM
   */
  querySelector<E extends Element = Element>(selector: string): E | null {
    return this.shadowRoot.querySelector<E>(selector);
  }

  /**
   * Query all elements within the shadow DOM
   */
  querySelectorAll<E extends Element = Element>(selectors: string): NodeListOf<E> {
    return this.shadowRoot.querySelectorAll<E>(selectors);
  }

  /**
   * Get element by ID within shadow DOM
   */
  getElementById(id: string): HTMLElement | null {
    return this.shadowRoot.getElementById(id);
  }

  /**
   * Check if a point is within the shadow DOM view
   */
  containsPoint(x: number, y: number): boolean {
    const rect = this.host.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  /**
   * Get element at point within shadow DOM
   */
  elementFromPoint(x: number, y: number): Element | null {
    // elementFromPoint on shadowRoot returns the element within the shadow tree
    const elements = this.shadowRoot.elementsFromPoint(x, y);
    return elements.length > 0 ? elements[0] : null;
  }

  /**
   * Check if attached to DOM
   */
  isConnected(): boolean {
    return this.isAttached && this.host.isConnected;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.isAttached = false;

    // Clear resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Clear callbacks
    this.resizeCallbacks.clear();

    // Clear content
    this.clearContent();
  }
}

/**
 * Check if Shadow DOM is supported
 */
export function isShadowDOMSupported(): boolean {
  return typeof Element.prototype.attachShadow === 'function';
}

/**
 * Check if CSS Custom Highlight API is supported
 * (Required for highlight rendering in Shadow DOM)
 */
export function isCSSHighlightSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

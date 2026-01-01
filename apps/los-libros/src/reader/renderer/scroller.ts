/**
 * Scroller
 *
 * Handles continuous scroll mode for reading.
 * Tracks scroll position and provides navigation helpers.
 */

import type { RendererConfig } from './types';

export type ScrollCallback = (scrollY: number) => void;

/**
 * Continuous Scroll Handler
 */
export class Scroller {
  private iframe: HTMLIFrameElement;
  private config: RendererConfig;
  private onScroll: ScrollCallback;

  // Scroll state
  private scrollY = 0;
  private contentHeight = 0;
  private viewportHeight = 0;
  private initialized = false;

  // Scroll tracking
  private scrollTimeout: number | null = null;
  private lastScrollTime = 0;

  constructor(
    iframe: HTMLIFrameElement,
    config: RendererConfig,
    onScroll: ScrollCallback
  ) {
    this.iframe = iframe;
    this.config = config;
    this.onScroll = onScroll;

    this.setupScrollListener();
  }

  /**
   * Initialize scroller after content is loaded
   * @param skipScrollReset - If true, don't reset scroll position (useful when switching modes)
   */
  async initialize(skipScrollReset = false): Promise<void> {
    const doc = this.iframe.contentDocument;
    if (!doc) return;

    // Wait for content to render
    // NOTE: Use setTimeout instead of RAF - RAF may not fire in iframes
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Calculate dimensions
    this.calculateDimensions();

    // Reset scroll position only if not skipping (e.g., mode switching preserves position)
    if (!skipScrollReset) {
      this.scrollY = 0;
      doc.documentElement.scrollTop = 0;
    } else {
      // Just sync internal state with current scroll position
      this.scrollY = doc.documentElement.scrollTop || doc.body.scrollTop;
    }

    this.initialized = true;
  }

  /**
   * Set up scroll event listener
   */
  private setupScrollListener(): void {
    const doc = this.iframe.contentDocument;
    if (!doc) return;

    doc.addEventListener('scroll', () => this.handleScrollEvent(), { passive: true });
  }

  /**
   * Handle scroll events
   */
  private handleScrollEvent(): void {
    const doc = this.iframe.contentDocument;
    if (!doc) return;

    this.scrollY = doc.documentElement.scrollTop || doc.body.scrollTop;
    this.lastScrollTime = Date.now();

    // Debounce scroll callback
    if (this.scrollTimeout) {
      clearTimeout(this.scrollTimeout);
    }
    this.scrollTimeout = window.setTimeout(() => {
      this.onScroll(this.scrollY);
    }, 100);
  }

  /**
   * Calculate content dimensions
   */
  private calculateDimensions(): void {
    const doc = this.iframe.contentDocument;
    if (!doc) return;

    this.contentHeight = doc.documentElement.scrollHeight;
    this.viewportHeight = doc.documentElement.clientHeight;
  }

  /**
   * Scroll down by one viewport
   * @returns true if scrolled, false if at end
   */
  scrollDown(): boolean {
    const doc = this.iframe.contentDocument;
    if (!doc) return false;

    const maxScroll = this.contentHeight - this.viewportHeight;
    if (this.scrollY >= maxScroll - 10) {
      return false;
    }

    const newScroll = Math.min(this.scrollY + this.viewportHeight * 0.9, maxScroll);
    doc.documentElement.scrollTo({
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
    const doc = this.iframe.contentDocument;
    if (!doc) return false;

    if (this.scrollY <= 10) {
      return false;
    }

    const newScroll = Math.max(this.scrollY - this.viewportHeight * 0.9, 0);
    doc.documentElement.scrollTo({
      top: newScroll,
      behavior: 'smooth',
    });

    return true;
  }

  /**
   * Scroll to a specific Y position
   */
  scrollTo(y: number, animate = true): void {
    const doc = this.iframe.contentDocument;
    if (!doc) return;

    const maxScroll = this.contentHeight - this.viewportHeight;
    const targetY = Math.max(0, Math.min(y, maxScroll));

    doc.documentElement.scrollTo({
      top: targetY,
      behavior: animate ? 'smooth' : 'auto',
    });
  }

  /**
   * Scroll to end of content
   */
  scrollToEnd(): void {
    const maxScroll = this.contentHeight - this.viewportHeight;
    this.scrollTo(maxScroll);
  }

  /**
   * Scroll to start of content
   */
  scrollToStart(): void {
    this.scrollTo(0);
  }

  /**
   * Scroll to a percentage of the content
   */
  scrollToPercentage(percentage: number): void {
    const maxScroll = this.contentHeight - this.viewportHeight;
    const targetY = (percentage / 100) * maxScroll;
    this.scrollTo(targetY);
  }

  /**
   * Scroll to an element by ID
   */
  scrollToElement(elementId: string): boolean {
    const doc = this.iframe.contentDocument;
    if (!doc) return false;

    const element = doc.getElementById(elementId);
    if (!element) return false;

    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  /**
   * Get current scroll Y position
   */
  getScrollY(): number {
    return this.scrollY;
  }

  /**
   * Get scroll progress (0-1)
   */
  getScrollProgress(): number {
    const maxScroll = this.contentHeight - this.viewportHeight;
    if (maxScroll <= 0) return 0;
    return Math.min(1, this.scrollY / maxScroll);
  }

  /**
   * Get chapter progress (0-1) - alias for getScrollProgress for API consistency with Paginator
   */
  getProgress(): number {
    return this.getScrollProgress();
  }

  /**
   * Check if at bottom of content
   */
  isAtEnd(): boolean {
    const maxScroll = this.contentHeight - this.viewportHeight;
    return this.scrollY >= maxScroll - 10;
  }

  /**
   * Check if at top of content
   */
  isAtStart(): boolean {
    return this.scrollY <= 10;
  }

  /**
   * Get content height
   */
  getContentHeight(): number {
    return this.contentHeight;
  }

  /**
   * Get viewport height
   */
  getViewportHeight(): number {
    return this.viewportHeight;
  }

  /**
   * Handle resize
   */
  handleResize(): void {
    if (!this.initialized) return;

    // Save scroll progress
    const progress = this.getScrollProgress();

    // Recalculate dimensions
    this.calculateDimensions();

    // Restore scroll position based on progress
    const maxScroll = this.contentHeight - this.viewportHeight;
    const newScrollY = progress * maxScroll;
    this.scrollTo(newScrollY, false);
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

  /**
   * Destroy the scroller
   */
  destroy(): void {
    if (this.scrollTimeout) {
      clearTimeout(this.scrollTimeout);
    }
    this.initialized = false;
  }
}

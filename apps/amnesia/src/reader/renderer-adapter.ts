/**
 * Renderer Adapter
 *
 * Provides backward-compatible interface for the existing Svelte components
 * while using the new ShadowDOMRenderer internally.
 *
 * This adapter allows incremental migration from the old iframe-based
 * EpubRenderer to the new Shadow DOM-based architecture.
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

import type {
  ParsedBook,
  RendererConfig,
  ReadingLocation,
  NavigationTarget,
  RendererEvents,
  RendererEventListener,
  DisplayMode,
  HighlightColor,
  SpineItem,
} from './renderer/types';
import type { Highlight } from '../library/types';
import type { ContentProvider } from './renderer/content-provider';
import { ShadowDOMRenderer } from './shadow-dom-renderer';
import { Paginator } from './renderer/paginator';
import { Scroller } from './renderer/scroller';

/**
 * Feature flag to enable new renderer
 * Set to true to use Shadow DOM renderer, false to use legacy iframe renderer
 */
export const USE_SHADOW_DOM_RENDERER = true; // Enable Shadow DOM renderer for testing

/**
 * Renderer Adapter
 *
 * Wraps ShadowDOMRenderer to provide the same interface as the legacy EpubRenderer.
 * This allows existing Svelte components to work without modification.
 */
export class RendererAdapter {
  private renderer: ShadowDOMRenderer;
  private container: HTMLElement;
  private api: ContentProvider;

  constructor(container: HTMLElement, api: ContentProvider, config?: Partial<RendererConfig>) {
    this.container = container;
    this.api = api;
    this.renderer = new ShadowDOMRenderer(container, api, config);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async load(bookIdOrBuffer: string | ArrayBuffer): Promise<void> {
    if (typeof bookIdOrBuffer === 'string') {
      await this.renderer.load(bookIdOrBuffer);
    } else {
      await this.renderer.loadFromBytes(bookIdOrBuffer);
    }
  }

  destroy(): void {
    this.renderer.destroy();
  }

  // ============================================================================
  // Navigation
  // ============================================================================

  async display(target?: NavigationTarget, options?: { instant?: boolean }): Promise<void> {
    if (!target) {
      // Display current position or start
      return;
    }
    await this.renderer.display(target, options);
  }

  async next(): Promise<void> {
    await this.renderer.next();
  }

  async prev(): Promise<void> {
    await this.renderer.prev();
  }

  async goToChapter(index: number): Promise<void> {
    await this.renderer.display({ type: 'spine', spineIndex: index });
  }

  // ============================================================================
  // Location
  // ============================================================================

  getLocation(): ReadingLocation | null {
    return this.renderer.getLocation();
  }

  // ============================================================================
  // Mode
  // ============================================================================

  async setMode(mode: DisplayMode): Promise<void> {
    await this.renderer.updateConfig({ mode });
  }

  getMode(): DisplayMode {
    return this.renderer.getMode();
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  async updateConfig(updates: Partial<RendererConfig>): Promise<void> {
    this.renderer.updateConfig(updates);
  }

  getConfig(): RendererConfig {
    return this.renderer.getConfig();
  }

  // ============================================================================
  // Book Info
  // ============================================================================

  getBook(): ParsedBook | null {
    return this.renderer.getBook();
  }

  getToc() {
    return this.renderer.getToc();
  }

  getSpine(): SpineItem[] {
    return this.renderer.getSpine();
  }

  getMetadata() {
    return this.renderer.getMetadata();
  }

  // ============================================================================
  // Highlights
  // ============================================================================

  setStoredHighlights(highlights: Highlight[]): void {
    this.renderer.setStoredHighlights(highlights);
  }

  renderHighlights(highlights: Highlight[]): void {
    // Alias for setStoredHighlights
    this.renderer.setStoredHighlights(highlights);
  }

  reanchorHighlights(): void {
    // Triggers re-anchoring of stored highlights
    // The ShadowDOMRenderer handles this internally on render events
  }

  addHighlight(id: string, range: Range, color: HighlightColor): void {
    this.renderer.addHighlight(id, range, color);
  }

  removeHighlight(highlightId: string): void {
    this.renderer.removeHighlight(highlightId);
  }

  updateHighlightColor(highlightId: string, color: HighlightColor): void {
    // Remove and re-add with new color
    this.renderer.removeHighlight(highlightId);
    // Note: This requires the range to be re-anchored
  }

  clearHighlights(): void {
    this.renderer.clearHighlights();
  }

  // ============================================================================
  // Selection
  // ============================================================================

  clearSelection(): void {
    // Shadow DOM shares selection with the main document
    const selection = document.getSelection();
    selection?.removeAllRanges();
  }

  // ============================================================================
  // DOM Access (Compatibility)
  // ============================================================================

  /**
   * @deprecated Use getShadowRoot() instead for new code
   * Returns null as Shadow DOM doesn't use iframe
   */
  getIframe(): HTMLIFrameElement | null {
    console.warn('[RendererAdapter] getIframe() called - Shadow DOM renderer does not use iframe');
    return null;
  }

  /**
   * Get the Shadow Root for DOM access
   */
  getShadowRoot(): ShadowRoot | null {
    return this.renderer.getShadowRoot();
  }

  /**
   * Get the content container element
   */
  getContentContainer(): HTMLElement | null {
    return this.renderer.getContentContainer();
  }

  /**
   * @deprecated Paginator is internal to the new renderer
   */
  getPaginator(): Paginator | null {
    console.warn('[RendererAdapter] getPaginator() called - internal to new renderer');
    return null;
  }

  /**
   * @deprecated Scroller is internal to the new renderer
   */
  getScroller(): Scroller | null {
    console.warn('[RendererAdapter] getScroller() called - internal to new renderer');
    return null;
  }

  // ============================================================================
  // Events
  // ============================================================================

  on<K extends keyof RendererEvents>(
    event: K,
    listener: RendererEventListener<K>
  ): () => void {
    return this.renderer.on(event, listener);
  }

  off<K extends keyof RendererEvents>(
    event: K,
    listener: RendererEventListener<K>
  ): void {
    this.renderer.off(event, listener);
  }

  // ============================================================================
  // Preloading (Compatibility)
  // ============================================================================

  /**
   * Preload chapters for faster navigation
   * The new renderer handles this automatically with virtualization
   */
  async loadChaptersStartingFrom(index: number): Promise<void> {
    // No-op: new renderer handles chapter loading automatically
  }
}

/**
 * Factory function to create the appropriate renderer
 *
 * Returns RendererAdapter (new Shadow DOM) or EpubRenderer (legacy) based on feature flag
 */
export function createRenderer(
  container: HTMLElement,
  api: ContentProvider,
  config?: Partial<RendererConfig>
): RendererAdapter {
  // Always return the adapter for now
  // When USE_SHADOW_DOM_RENDERER is false, we could return the legacy renderer
  // but for type safety, we return the adapter
  return new RendererAdapter(container, api, config);
}

/**
 * Type guard to check if renderer is the new Shadow DOM based one
 */
export function isShadowDOMRenderer(renderer: unknown): renderer is RendererAdapter {
  return renderer instanceof RendererAdapter;
}

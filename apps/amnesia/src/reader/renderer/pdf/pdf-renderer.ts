/**
 * PDF Renderer
 *
 * Main PDF renderer class implementing the DocumentRenderer interface.
 * Orchestrates canvas, text, and annotation layers.
 */

import type {
  DocumentRenderer,
  DocumentFormat,
  DocumentMetadata,
  DocumentLocation,
  DocumentNavigationTarget,
  DocumentRendererConfig,
  DocumentSelector,
  DocumentRendererEvents,
  DocumentRendererEventListener,
  DocumentSearchOptions,
  DocumentSearchResult,
  RenderedDocumentHighlight,
  PdfSelector,
} from '../document-renderer';
import { createPdfLocator, parsePdfLocator } from '../document-renderer';
import { getDevicePixelRatio } from './dpr-utils';
import type {
  TocEntry,
  HighlightColor,
  ParsedPdf,
  PdfTextLayer as TextLayerData,
  PdfRenderOptions,
  RegionSelectionEvent,
} from '../types';
import { PdfCanvasLayer } from './pdf-canvas-layer';
import { PdfTextLayer } from './pdf-text-layer';
import { PdfAnnotationLayer, type PdfHighlight } from './pdf-annotation-layer';
import { PdfRegionSelection } from './pdf-region-selection';
import { PdfGestureHandler } from './pdf-gesture-handler';
import { calculateOptimalLayout, type LayoutResult, type LayoutMode } from './pdf-layout-calculator';
import { PdfCanvasView } from './pdf-canvas-view';
import { PdfContextMenu, createDefaultPdfActions } from './pdf-context-menu';
import { PdfMultiPageContainer, type PageDataProvider } from './pdf-multi-page-container';
import { PdfInfiniteCanvas } from './pdf-infinite-canvas';

// ============================================================================
// Types
// ============================================================================

export interface PdfRendererConfig extends Partial<DocumentRendererConfig> {
  /** Base URL for API */
  baseUrl?: string;
  /** Default scale factor */
  scale?: number;
  /** Default rotation */
  rotation?: number;
  /** Scroll direction for scrolled mode */
  scrollDirection?: 'vertical' | 'horizontal';

  // ==========================================================================
  // Optimization Settings
  // ==========================================================================

  /** Render DPI for server-side rendering. Higher = sharper but slower. Default: 150 */
  renderDpi?: number;
  /** Enable hardware/GPU acceleration for rendering. Default: true */
  enableHardwareAcceleration?: boolean;
  /** Use canvas 2D hardware acceleration hints. Default: true */
  enableCanvasAcceleration?: boolean;
  /** Number of pages to preload ahead of current page. Default: 2 */
  pagePreloadCount?: number;
  /** Enable rendered page caching. Default: true */
  enablePageCache?: boolean;
  /** Maximum number of pages to keep in cache. Default: 10 */
  pageCacheSize?: number;
  /** Image format for rendered pages. Default: 'png' */
  imageFormat?: 'png' | 'jpeg' | 'webp';
  /** Image quality for lossy formats (jpeg/webp). 1-100. Default: 85 */
  imageQuality?: number;
  /** Enable progressive rendering (show low-res first). Default: true */
  enableProgressiveRendering?: boolean;
  /** Low-res preview scale multiplier. Default: 0.25 */
  previewScale?: number;
  /** Enable text layer anti-aliasing. Default: true */
  enableTextAntialiasing?: boolean;
  /** Enable image smoothing/interpolation. Default: true */
  enableImageSmoothing?: boolean;
}

export interface PdfContentProvider {
  /** Get PDF metadata */
  getPdf(id: string): Promise<ParsedPdf>;
  /** Upload PDF */
  uploadPdf(data: ArrayBuffer, filename?: string): Promise<ParsedPdf>;
  /** Get rendered page image */
  getPdfPage(id: string, page: number, options?: PdfRenderOptions): Promise<Blob>;
  /** Get text layer for a page */
  getPdfTextLayer(id: string, page: number): Promise<TextLayerData>;
  /** Search PDF content */
  searchPdf(id: string, query: string, limit?: number): Promise<Array<{
    page: number;
    text: string;
    prefix?: string;
    suffix?: string;
  }>>;
}

// ============================================================================
// PDF Renderer Implementation
// ============================================================================

export class PdfRenderer implements DocumentRenderer {
  readonly type: DocumentFormat = 'pdf';

  // DOM
  private container: HTMLElement;
  private pageContainer: HTMLDivElement;

  // Layers (single-page mode fallback)
  private canvasLayer: PdfCanvasLayer | null = null;
  private textLayer: PdfTextLayer | null = null;
  private annotationLayer: PdfAnnotationLayer | null = null;
  private regionSelection: PdfRegionSelection | null = null;

  // Multi-page container (paginated mode)
  private multiPageContainer: PdfMultiPageContainer | null = null;

  // Infinite canvas (scrolled mode with proper pan-zoom)
  private infiniteCanvas: PdfInfiniteCanvas | null = null;
  private useInfiniteCanvas: boolean = true; // Use infinite canvas for scrolled mode

  // Gesture handling
  private gestureHandler: PdfGestureHandler | null = null;

  // Layout
  private currentLayout: LayoutResult | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Canvas view (thumbnail grid when zoomed out)
  private canvasView: PdfCanvasView | null = null;
  private contextMenu: PdfContextMenu | null = null;
  private isCanvasMode: boolean = false;
  private canvasModeHideTimeout: number | null = null; // Track timeout to cancel on exit
  private readonly CANVAS_VIEW_THRESHOLD = 0.3; // Switch to canvas at 30% zoom

  // Provider
  private provider: PdfContentProvider;

  // State
  private document: ParsedPdf | null = null;
  private currentPage = 1;
  private config: DocumentRendererConfig & {
    scrollDirection?: 'vertical' | 'horizontal';
    // Optimization settings
    renderDpi?: number;
    enableHardwareAcceleration?: boolean;
    enableCanvasAcceleration?: boolean;
    pagePreloadCount?: number;
    enablePageCache?: boolean;
    pageCacheSize?: number;
    imageFormat?: 'png' | 'jpeg' | 'webp';
    imageQuality?: number;
    enableProgressiveRendering?: boolean;
    previewScale?: number;
    enableTextAntialiasing?: boolean;
    enableImageSmoothing?: boolean;
  };
  private isInitialLoad = true; // Track if this is the first load (for loading indicator)

  // Page cache: Map<cacheKey, {blob, timestamp}>
  private pageCache: Map<string, { blob: Blob; timestamp: number }> = new Map();

  // Preload state
  private preloadAbortController: AbortController | null = null;

  // Highlights
  private highlights: Map<string, RenderedDocumentHighlight> = new Map();

  // Events
  private listeners: Map<
    keyof DocumentRendererEvents,
    Set<DocumentRendererEventListener<any>>
  > = new Map();

  constructor(
    container: HTMLElement,
    provider: PdfContentProvider,
    config?: PdfRendererConfig
  ) {
    this.container = container;
    this.provider = provider;

    const pdfConfig = config as PdfRendererConfig;
    this.config = {
      mode: config?.mode ?? 'paginated',
      pageLayout: config?.pageLayout ?? 'auto', // Auto-fit: show as many pages as fit in viewport
      theme: config?.theme ?? 'system',
      scale: config?.scale ?? 1.5,
      rotation: config?.rotation ?? 0,
      margin: config?.margin ?? 20,
      scrollDirection: pdfConfig?.scrollDirection ?? 'vertical',
      // Optimization settings
      renderDpi: pdfConfig?.renderDpi ?? 150,
      enableHardwareAcceleration: pdfConfig?.enableHardwareAcceleration ?? true,
      enableCanvasAcceleration: pdfConfig?.enableCanvasAcceleration ?? true,
      pagePreloadCount: pdfConfig?.pagePreloadCount ?? 0, // Disabled: server crashes with concurrent renders
      enablePageCache: pdfConfig?.enablePageCache ?? true,
      pageCacheSize: pdfConfig?.pageCacheSize ?? 10,
      imageFormat: pdfConfig?.imageFormat ?? 'png',
      imageQuality: pdfConfig?.imageQuality ?? 85,
      enableProgressiveRendering: pdfConfig?.enableProgressiveRendering ?? false, // Disabled: doubles request load
      previewScale: pdfConfig?.previewScale ?? 0.25,
      enableTextAntialiasing: pdfConfig?.enableTextAntialiasing ?? true,
      enableImageSmoothing: pdfConfig?.enableImageSmoothing ?? true,
    };

    // Create page container
    this.pageContainer = document.createElement('div');
    this.pageContainer.className = 'pdf-page-container';
    this.pageContainer.style.cssText = `
      position: relative;
      width: 100%;
      height: 100%;
    `;
    this.container.appendChild(this.pageContainer);

    // Create page container based on mode
    // Infinite canvas for all non-paginated modes, multi-page for paginated
    if (this.config.mode !== 'paginated' && this.useInfiniteCanvas) {
      this.initializeInfiniteCanvas();
    } else {
      this.initializeMultiPageContainer();
    }

    // Set up gesture handling for zoom (on pageContainer)
    // Note: Infinite canvas has its own gesture handling
    if (!this.infiniteCanvas) {
      this.setupGestureHandler();
    }

    // Set up resize observer for dynamic layout
    this.setupResizeObserver();
  }

  /**
   * Initialize multi-page container
   */
  private initializeMultiPageContainer(): void {
    // Create page data provider that wraps our provider
    const pageDataProvider: PageDataProvider = {
      getPageImage: async (page: number, options: PdfRenderOptions) => {
        if (!this.document) throw new Error('No document loaded');
        return this.provider.getPdfPage(this.document.id, page, options);
      },
      getPageTextLayer: async (page: number) => {
        if (!this.document) throw new Error('No document loaded');
        return this.provider.getPdfTextLayer(this.document.id, page);
      },
    };

    const layoutMode = this.getPageLayoutMode();

    this.multiPageContainer = new PdfMultiPageContainer(
      this.pageContainer,
      pageDataProvider,
      {
        displayMode: this.config.mode === 'scrolled' ? 'scrolled' : 'paginated',
        scrollDirection: this.config.scrollDirection ?? 'vertical',
        pageLayout: layoutMode,
        scale: this.config.scale ?? 1.5,
        // Don't set userZoom initially - let auto-fit work
        // userZoom is only set when user explicitly zooms
        userZoom: undefined,
        gap: 20,
        padding: this.config.margin ?? 20,
        pixelRatio: getDevicePixelRatio(),
        enableTextAntialiasing: this.config.enableTextAntialiasing,
        enableImageSmoothing: this.config.enableImageSmoothing,
      }
    );

    // Wire up callbacks
    this.multiPageContainer.setOnPageChange((page) => {
      this.currentPage = page;
      this.emitLocation();
    });

    this.multiPageContainer.setOnSelection((page, text, rects) => {
      const containerRect = this.container.getBoundingClientRect();
      const avgX = rects.reduce((sum, r) => sum + r.x + r.width / 2, 0) / rects.length;
      const avgY = rects.reduce((sum, r) => sum + r.y, 0) / rects.length;

      this.emit('selected', {
        text,
        selector: {
          format: 'pdf',
          page,
          textQuote: {
            exact: text,
          },
        },
        position: {
          x: containerRect.left + avgX,
          y: containerRect.top + avgY,
        },
        rects: rects.map(r => ({
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        })),
      });
    });

    this.multiPageContainer.setOnHighlightClick((annotationId, position) => {
      this.emit('highlightClicked', { annotationId, position });
    });
  }

  /**
   * Initialize infinite canvas for scrolled mode with proper pan-zoom
   */
  private initializeInfiniteCanvas(): void {
    // Create page data provider that wraps our provider
    const pageDataProvider = {
      getPageImage: async (page: number, options: PdfRenderOptions) => {
        if (!this.document) throw new Error('No document loaded');
        return this.provider.getPdfPage(this.document.id, page, options);
      },
      getPageTextLayer: async (page: number) => {
        if (!this.document) throw new Error('No document loaded');
        return this.provider.getPdfTextLayer(this.document.id, page);
      },
      // Prefetch methods for spatial/linear prefetching
      notifyPageChange: (page: number) => {
        // Linear prefetch: provider handles page ± N prefetch
        if ('notifyPageChange' in this.provider && typeof (this.provider as any).notifyPageChange === 'function') {
          (this.provider as any).notifyPageChange(page);
        }
      },
      prefetchPages: async (pages: number[]) => {
        // Spatial prefetch: explicit page list
        if ('prefetchPages' in this.provider && typeof (this.provider as any).prefetchPages === 'function') {
          await (this.provider as any).prefetchPages(pages);
        }
      },
      // Dual-resolution rendering: returns best cached version immediately,
      // starts background upgrade if needed (never show blank pages)
      getPageImageDualRes: async (page: number, options: PdfRenderOptions) => {
        if (!this.document) throw new Error('No document loaded');
        // Check if provider supports dual-res rendering
        if ('renderPageDualRes' in this.provider && typeof (this.provider as any).renderPageDualRes === 'function') {
          return (this.provider as any).renderPageDualRes(page, options);
        }
        // Fallback: wrap regular render as full quality
        const blob = await this.provider.getPdfPage(this.document.id, page, options);
        return {
          initial: blob,
          initialScale: options.scale ?? 1.5,
          isFullQuality: true,
        };
      },
      // Tile rendering methods for CATiledLayer-style rendering at high zoom
      renderTile: 'renderTile' in this.provider && typeof (this.provider as any).renderTile === 'function'
        ? async (tile: { page: number; tileX: number; tileY: number; scale: number }) => {
            return (this.provider as any).renderTile(tile);
          }
        : undefined,
      getRenderCoordinator: 'getRenderCoordinator' in this.provider && typeof (this.provider as any).getRenderCoordinator === 'function'
        ? () => (this.provider as any).getRenderCoordinator()
        : undefined,
      isTileRenderingAvailable: 'isTileRenderingAvailable' in this.provider && typeof (this.provider as any).isTileRenderingAvailable === 'function'
        ? () => (this.provider as any).isTileRenderingAvailable()
        : undefined,
      // Thumbnail suspension methods for smooth scroll/zoom
      suspendThumbnailGeneration: 'suspendThumbnailGeneration' in this.provider && typeof (this.provider as any).suspendThumbnailGeneration === 'function'
        ? () => (this.provider as any).suspendThumbnailGeneration()
        : undefined,
      resumeThumbnailGeneration: 'resumeThumbnailGeneration' in this.provider && typeof (this.provider as any).resumeThumbnailGeneration === 'function'
        ? () => (this.provider as any).resumeThumbnailGeneration()
        : undefined,
      // Document ID for cross-document isolation in global singletons (RenderCoordinator)
      getDocumentId: 'getDocumentId' in this.provider && typeof (this.provider as any).getDocumentId === 'function'
        ? () => (this.provider as any).getDocumentId()
        : undefined,
    };

    this.infiniteCanvas = new PdfInfiniteCanvas(
      this.pageContainer,
      pageDataProvider,
      {
        gap: 20,
        padding: this.config.margin ?? 20,
        minZoom: 0.1,
        maxZoom: 32, // Increased to 32 for very high zoom capability (amnesia-pi0)
        pageWidth: 612,
        pageHeight: 792,
        renderScale: this.config.scale ?? 1.5,
        pixelRatio: getDevicePixelRatio(),
        readingMode: 'device',
        layoutMode: this.config.scrollDirection === 'horizontal' ? 'horizontal' : 'vertical',
        pagesPerRow: 1,
      }
    );

    // Wire up callbacks
    this.infiniteCanvas.setOnPageChange((page) => {
      this.currentPage = page;
      this.emitLocation();
    });

    this.infiniteCanvas.setOnZoomChange((zoom) => {
      this.config.scale = zoom;
      this.emit('zoomed', zoom);
    });

    this.infiniteCanvas.setOnSelection((page, text, rects) => {
      const containerRect = this.container.getBoundingClientRect();
      const avgX = rects.reduce((sum, r) => sum + r.x + r.width / 2, 0) / rects.length;
      const avgY = rects.reduce((sum, r) => sum + r.y, 0) / rects.length;

      this.emit('selected', {
        text,
        selector: {
          format: 'pdf',
          page,
          textQuote: {
            exact: text,
          },
        },
        position: {
          x: containerRect.left + avgX,
          y: containerRect.top + avgY,
        },
        rects: rects.map(r => ({
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        })),
      });
    });

    this.infiniteCanvas.setOnHighlightClick((annotationId, position) => {
      this.emit('highlightClicked', { annotationId, position });
    });

    // Set display mode based on config (handles extended modes)
    const mode = this.config.mode;
    if (mode && mode !== 'paginated' && mode !== 'scrolled') {
      // Extended mode like 'vertical-scroll', 'horizontal-scroll', 'auto-grid', 'canvas'
      this.infiniteCanvas.setDisplayMode(mode as 'horizontal-scroll' | 'vertical-scroll' | 'auto-grid' | 'canvas');
    }
  }

  /**
   * Set up gesture handler for zoom
   */
  private setupGestureHandler(): void {
    this.gestureHandler = new PdfGestureHandler(
      this.pageContainer,
      {
        onZoom: (scale) => {
          // Clamp scale to reasonable bounds
          const clampedScale = Math.max(0.25, Math.min(5.0, scale));
          this.setScale(clampedScale);
        },
        getScale: () => this.multiPageContainer?.getZoom() ?? this.config.scale ?? 1.5,
      },
      {
        minScale: 0.25,
        maxScale: 5.0,
        displayMode: this.config.mode === 'paginated' ? 'paginated' : 'scrolled',
        enableZoom: this.config.mode !== 'paginated', // Disable zoom in paginated mode
      }
    );
  }

  /**
   * Set up resize observer for dynamic layout
   */
  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver((entries) => {
      if (!this.document) return;

      // Debounce resize handling
      requestAnimationFrame(() => {
        this.handleResize();
      });
    });

    this.resizeObserver.observe(this.container);
  }

  /**
   * Handle container resize
   */
  private handleResize(): void {
    if (!this.document) return;

    // Update the appropriate container
    if (this.infiniteCanvas) {
      this.infiniteCanvas.handleResize();
    } else if (this.multiPageContainer) {
      this.multiPageContainer.handleResize();
    }
  }

  /**
   * Calculate optimal layout based on container size
   */
  private calculateLayout(): void {
    if (!this.document) return;

    const containerRect = this.container.getBoundingClientRect();

    // Get page dimensions (use defaults if not available)
    // Standard US Letter at 72 DPI: 612 x 792
    const pageWidth = 612;
    const pageHeight = 792;

    this.currentLayout = calculateOptimalLayout({
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
      pageWidth,
      pageHeight,
      gap: 20,
      padding: this.config.margin ?? 20,
      minScale: 0.25,
      maxScale: this.config.scale ?? 1.5,
      layoutMode: this.getPageLayoutMode(),
      userScale: this.config.scale,
    });
  }

  /**
   * Get page layout mode from config
   */
  private getPageLayoutMode(): 'single' | 'dual' | 'auto' {
    const layout = this.config.pageLayout;
    if (layout === 'single' || layout === 'dual') {
      return layout;
    }
    return 'auto';
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  async load(documentId: string): Promise<void> {
    this.emit('loading', true);

    try {
      this.document = await this.provider.getPdf(documentId);
      this.currentPage = 1;

      // Initialize the appropriate container with page count
      if (this.infiniteCanvas) {
        this.infiniteCanvas.initialize(this.document.pageCount);
        // Update layouts with actual PDF dimensions (from tile engine if available)
        this.infiniteCanvas.updatePageDimensions();
        this.infiniteCanvas.goToPage(1);
      } else if (this.multiPageContainer) {
        this.multiPageContainer.initialize(this.document.pageCount);
        await this.multiPageContainer.goToPage(1);
      }

      this.emit('loading', false);
      this.emitLocation();
    } catch (error) {
      this.emit('loading', false);
      this.emit('error', error as Error);
      throw error;
    }
  }

  async loadFromBytes(data: ArrayBuffer, filename?: string): Promise<void> {
    this.emit('loading', true);

    try {
      this.document = await this.provider.uploadPdf(data, filename);
      this.currentPage = 1;

      // Initialize the appropriate container with page count
      if (this.infiniteCanvas) {
        this.infiniteCanvas.initialize(this.document.pageCount);
        // Update layouts with actual PDF dimensions (from tile engine if available)
        this.infiniteCanvas.updatePageDimensions();
        this.infiniteCanvas.goToPage(1);
      } else if (this.multiPageContainer) {
        this.multiPageContainer.initialize(this.document.pageCount);
        await this.multiPageContainer.goToPage(1);
      }

      this.emit('loading', false);
      this.emitLocation();
    } catch (error) {
      this.emit('loading', false);
      this.emit('error', error as Error);
      throw error;
    }
  }

  destroy(): void {
    // Cancel any pending preloads
    if (this.preloadAbortController) {
      this.preloadAbortController.abort();
    }

    // Clear cache
    this.pageCache.clear();

    // Destroy gesture handler
    if (this.gestureHandler) {
      this.gestureHandler.destroy();
      this.gestureHandler = null;
    }

    // Disconnect resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Destroy canvas view and context menu
    if (this.canvasView) {
      this.canvasView.destroy();
      this.canvasView = null;
    }
    if (this.contextMenu) {
      this.contextMenu.destroy();
      this.contextMenu = null;
    }

    // Destroy infinite canvas
    if (this.infiniteCanvas) {
      this.infiniteCanvas.destroy();
      this.infiniteCanvas = null;
    }

    // Destroy multi-page container
    if (this.multiPageContainer) {
      this.multiPageContainer.destroy();
      this.multiPageContainer = null;
    }

    // Destroy legacy layers (if used)
    this.canvasLayer?.destroy();
    this.textLayer?.destroy();
    this.annotationLayer?.destroy();
    this.regionSelection?.destroy();

    this.pageContainer.remove();
    this.listeners.clear();
    this.highlights.clear();
  }

  // ============================================================================
  // Navigation Methods
  // ============================================================================

  async display(target: DocumentNavigationTarget): Promise<void> {
    if (!this.document) return;

    let page = 1;

    switch (target.type) {
      case 'locator':
        page = parsePdfLocator(target.locator) ?? 1;
        break;
      case 'percentage':
        page = Math.max(1, Math.ceil((target.percentage / 100) * this.document.pageCount));
        break;
      case 'position':
        page = Math.max(1, Math.min(target.position, this.document.pageCount));
        break;
      case 'href':
        // Parse PDF outline href to page number
        page = this.parseOutlineHref(target.href) ?? 1;
        break;
    }

    await this.goToPage(page);
  }

  async next(): Promise<void> {
    if (!this.document) return;

    if (this.infiniteCanvas) {
      this.infiniteCanvas.nextPage();
      this.currentPage = this.infiniteCanvas.getCurrentPage();
      this.emitLocation();
    } else if (this.multiPageContainer) {
      await this.multiPageContainer.next();
      this.currentPage = this.multiPageContainer.getCurrentPage();
      this.emitLocation();
    }
  }

  async prev(): Promise<void> {
    if (!this.document) return;

    if (this.infiniteCanvas) {
      this.infiniteCanvas.prevPage();
      this.currentPage = this.infiniteCanvas.getCurrentPage();
      this.emitLocation();
    } else if (this.multiPageContainer) {
      await this.multiPageContainer.prev();
      this.currentPage = this.multiPageContainer.getCurrentPage();
      this.emitLocation();
    }
  }

  getLocation(): DocumentLocation | null {
    if (!this.document) return null;

    const page = this.currentPage;
    const pageCount = this.document.pageCount;

    return {
      locator: createPdfLocator(page),
      percentage: (page / pageCount) * 100,
      position: page,
      totalPositions: pageCount,
      displayLabel: this.document.pageLabels?.[page - 1] ?? `Page ${page}`,
      pageInSection: 1,
      totalPagesInSection: 1,
    };
  }

  // ============================================================================
  // Document Info Methods
  // ============================================================================

  getMetadata(): DocumentMetadata | null {
    if (!this.document) return null;

    return {
      id: this.document.id,
      title: this.document.metadata.title,
      author: this.document.metadata.author,
      language: 'en', // PDF doesn't have explicit language
      pageCount: this.document.pageCount,
    };
  }

  getToc(): TocEntry[] {
    return this.document?.toc ?? [];
  }

  // ============================================================================
  // Configuration Methods
  // ============================================================================

  updateConfig(config: Partial<DocumentRendererConfig>): void {
    const oldScale = this.config.scale;
    const oldRotation = this.config.rotation;

    this.config = { ...this.config, ...config };

    // Update multi-page container config
    if (this.multiPageContainer && this.document) {
      if (config.scale !== undefined && config.scale !== oldScale) {
        this.multiPageContainer.updateConfig({ scale: config.scale });
      }
    }
  }

  getConfig(): DocumentRendererConfig {
    return { ...this.config };
  }

  // ============================================================================
  // Highlight Methods
  // ============================================================================

  addHighlight(selector: DocumentSelector, color: HighlightColor): string {
    const id = `highlight-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const highlight: RenderedDocumentHighlight = {
      id,
      annotationId: id,
      color,
      selector,
    };

    this.highlights.set(id, highlight);
    this.refreshHighlights();

    return id;
  }

  removeHighlight(highlightId: string): void {
    this.highlights.delete(highlightId);
    this.refreshHighlights();
  }

  updateHighlightColor(highlightId: string, color: HighlightColor): void {
    const highlight = this.highlights.get(highlightId);
    if (highlight) {
      highlight.color = color;
      this.refreshHighlights();
    }
  }

  getHighlights(): RenderedDocumentHighlight[] {
    return Array.from(this.highlights.values());
  }

  refreshHighlights(): void {
    if (!this.multiPageContainer && !this.infiniteCanvas) return;

    // Group highlights by page
    const highlightsByPage = new Map<number, Array<{
      id: string;
      annotationId: string;
      color: HighlightColor;
      rects: Array<{ x: number; y: number; width: number; height: number }>;
    }>>();

    for (const highlight of this.highlights.values()) {
      if (highlight.selector.format !== 'pdf') continue;

      const pdfSelector = highlight.selector as PdfSelector;
      const rects = pdfSelector.rect ? [pdfSelector.rect] : [];
      if (rects.length === 0) continue;

      if (!highlightsByPage.has(pdfSelector.page)) {
        highlightsByPage.set(pdfSelector.page, []);
      }

      highlightsByPage.get(pdfSelector.page)!.push({
        id: highlight.id,
        annotationId: highlight.annotationId,
        color: highlight.color,
        rects,
      });
    }

    // Update highlights for each page using the appropriate container
    for (const [page, highlights] of highlightsByPage) {
      if (this.infiniteCanvas) {
        this.infiniteCanvas.setHighlightsForPage(page, highlights);
      } else if (this.multiPageContainer) {
        this.multiPageContainer.setHighlightsForPage(page, highlights);
      }
    }
  }

  // ============================================================================
  // Search Methods
  // ============================================================================

  async search(
    query: string,
    options?: DocumentSearchOptions
  ): Promise<DocumentSearchResult[]> {
    if (!this.document) return [];

    const results = await this.provider.searchPdf(
      this.document.id,
      query,
      options?.limit ?? 50
    );

    return results.map((result) => ({
      text: result.text,
      prefix: result.prefix,
      suffix: result.suffix,
      location: {
        locator: createPdfLocator(result.page),
        percentage: (result.page / this.document!.pageCount) * 100,
        position: result.page,
        totalPositions: this.document!.pageCount,
        displayLabel: `Page ${result.page}`,
      },
      selector: {
        format: 'pdf' as const,
        page: result.page,
        textQuote: {
          exact: result.text,
          prefix: result.prefix,
          suffix: result.suffix,
        },
      },
    }));
  }

  // ============================================================================
  // Event Methods
  // ============================================================================

  on<K extends keyof DocumentRendererEvents>(
    event: K,
    callback: DocumentRendererEventListener<K>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => this.off(event, callback);
  }

  off<K extends keyof DocumentRendererEvents>(
    event: K,
    callback: DocumentRendererEventListener<K>
  ): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit<K extends keyof DocumentRendererEvents>(
    event: K,
    data: DocumentRendererEvents[K]
  ): void {
    this.listeners.get(event)?.forEach((callback) => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in ${event} listener:`, error);
      }
    });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async goToPage(page: number): Promise<void> {
    if (!this.document) return;

    page = Math.max(1, Math.min(page, this.document.pageCount));

    if (this.infiniteCanvas) {
      this.infiniteCanvas.goToPage(page);
      this.currentPage = this.infiniteCanvas.getCurrentPage();
      this.emitLocation();
    } else if (this.multiPageContainer) {
      await this.multiPageContainer.goToPage(page);
      this.currentPage = this.multiPageContainer.getCurrentPage();
      this.emitLocation();
    }
  }

  // Old single-page renderPage method removed - now using PdfMultiPageContainer

  /**
   * Generate a unique cache key for a page configuration
   */
  private getCacheKey(page: number, scale: number, rotation: number, format: string): string {
    const docId = this.document?.id ?? 'unknown';
    return `${docId}:${page}:${scale.toFixed(2)}:${rotation}:${format}`;
  }

  /**
   * Add a page to the cache, evicting oldest entries if needed
   */
  private addToCache(key: string, blob: Blob): void {
    const maxSize = this.config.pageCacheSize ?? 10;

    // Evict oldest entries if cache is full
    while (this.pageCache.size >= maxSize) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.pageCache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.pageCache.delete(oldestKey);
      }
    }

    this.pageCache.set(key, { blob, timestamp: Date.now() });
  }

  /**
   * Preload adjacent pages in background
   */
  private preloadAdjacentPages(currentPage: number): void {
    const preloadCount = this.config.pagePreloadCount ?? 2;
    const enableCache = this.config.enablePageCache ?? true;
    if (!enableCache || preloadCount <= 0 || !this.document) return;

    // Cancel any existing preload
    if (this.preloadAbortController) {
      this.preloadAbortController.abort();
    }
    this.preloadAbortController = new AbortController();

    const pagesToPreload: number[] = [];
    const pageCount = this.document.pageCount;

    // Add pages ahead
    for (let i = 1; i <= preloadCount; i++) {
      const nextPage = currentPage + i;
      if (nextPage <= pageCount) {
        pagesToPreload.push(nextPage);
      }
    }

    // Add one page behind
    if (currentPage > 1) {
      pagesToPreload.push(currentPage - 1);
    }

    // Preload in background
    const baseScale = this.config.scale ?? 1.5;
    const rotation = this.config.rotation ?? 0;
    const renderDpi = this.config.renderDpi ?? 150;
    const imageFormat = this.config.imageFormat ?? 'png';
    const imageQuality = this.config.imageQuality ?? 85;
    const dpr = getDevicePixelRatio();
    const renderScale = baseScale * dpr;

    for (const page of pagesToPreload) {
      const cacheKey = this.getCacheKey(page, renderScale, rotation, imageFormat);

      // Skip if already cached
      if (this.pageCache.has(cacheKey)) continue;

      // Preload with low priority
      this.provider.getPdfPage(this.document.id, page, {
        scale: renderScale,
        rotation,
        format: imageFormat,
        dpi: renderDpi,
        quality: imageQuality,
      }).then((blob) => {
        // Check if preload was cancelled or page changed
        if (this.preloadAbortController?.signal.aborted) return;
        this.addToCache(cacheKey, blob);
      }).catch((error) => {
        // Silently ignore preload errors
        console.debug(`Preload failed for page ${page}:`, error);
      });
    }
  }

  /**
   * Clear the page cache
   */
  clearCache(): void {
    this.pageCache.clear();
  }

  private emitLocation(): void {
    const location = this.getLocation();
    if (location) {
      this.emit('relocated', location);
    }
  }

  /**
   * Parse PDF outline href to page number
   * Supports multiple formats:
   * - "page:5" - direct page reference
   * - "#page=5" or "page=5" - PDF.js style
   * - "5" - just a number
   * - Named destinations - lookup in ToC
   */
  private parseOutlineHref(href: string): number | null {
    if (!href) return null;

    // Format: "page:5"
    if (href.startsWith('page:')) {
      const pageNum = parseInt(href.slice(5), 10);
      return isNaN(pageNum) ? null : pageNum;
    }

    // Format: "#page=5" or "page=5"
    const pageMatch = href.match(/page[=:](\d+)/i);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1], 10);
      return isNaN(pageNum) ? null : pageNum;
    }

    // Format: Just a number "5" or "#5"
    const cleanHref = href.replace(/^#/, '');
    if (/^\d+$/.test(cleanHref)) {
      return parseInt(cleanHref, 10);
    }

    // Try to find named destination in ToC
    const toc = this.document?.toc ?? [];
    const entry = this.findTocEntryByHref(toc, href);
    if (entry?.href && entry.href !== href) {
      // Recursive call to parse the found href
      return this.parseOutlineHref(entry.href);
    }

    // Try parsing numeric suffix (common in PDF outlines like "chapter1" -> page 1)
    const numericSuffix = href.match(/(\d+)$/);
    if (numericSuffix) {
      return parseInt(numericSuffix[1], 10);
    }

    console.warn('[PdfRenderer] Could not parse outline href:', href);
    return null;
  }

  /**
   * Find ToC entry by href (recursive search)
   */
  private findTocEntryByHref(entries: TocEntry[], href: string): TocEntry | null {
    for (const entry of entries) {
      if (entry.href === href || entry.id === href) {
        return entry;
      }
      if (entry.children?.length) {
        const found = this.findTocEntryByHref(entry.children, href);
        if (found) return found;
      }
    }
    return null;
  }

  // Selection and annotation handlers are now managed by PdfMultiPageContainer
  // through callbacks set up in initializeMultiPageContainer()

  // ============================================================================
  // Public Utilities
  // ============================================================================

  /**
   * Get current page number
   */
  getCurrentPage(): number {
    return this.currentPage;
  }

  /**
   * Get total page count
   */
  getPageCount(): number {
    return this.document?.pageCount ?? 0;
  }

  /**
   * Check if document has text layer
   */
  hasTextLayer(): boolean {
    return this.document?.hasTextLayer ?? false;
  }

  /**
   * Set scale (user-initiated zoom)
   * For infinite canvas: updates the camera zoom
   * For multi-page container: recalculates layout
   */
  setScale(scale: number): void {
    // When using infinite canvas, just update the zoom
    if (this.infiniteCanvas) {
      this.infiniteCanvas.setZoom(scale);
      this.config.scale = scale;
      return;
    }

    // Canvas mode only available in scrolled mode with multi-page container
    const isScrolledMode = this.config.mode === 'scrolled';

    // Check for canvas mode transition (only in scrolled mode)
    if (isScrolledMode) {
      if (scale <= this.CANVAS_VIEW_THRESHOLD && !this.isCanvasMode) {
        this.enterCanvasMode();
      } else if (scale > this.CANVAS_VIEW_THRESHOLD && this.isCanvasMode) {
        this.exitCanvasMode();
      }
    }

    // Update zoom in multi-page container - this recalculates layout
    if (this.multiPageContainer) {
      this.multiPageContainer.setZoom(scale);
    }

    // Store the scale for reference
    this.config.scale = scale;
  }

  /**
   * Get the current zoom level
   */
  getZoom(): number {
    if (this.infiniteCanvas) {
      return this.infiniteCanvas.getZoom();
    }
    if (this.multiPageContainer) {
      return this.multiPageContainer.getZoom();
    }
    return this.config.scale ?? 1;
  }

  /**
   * Set zoom level (for stress testing)
   */
  setZoom(zoom: number): void {
    if (this.infiniteCanvas) {
      this.infiniteCanvas.setZoom(zoom);
    }
  }

  /**
   * Get camera state (for stress testing)
   */
  getCamera(): { x: number; y: number; z: number } {
    if (this.infiniteCanvas) {
      return this.infiniteCanvas.getCamera();
    }
    return { x: 0, y: 0, z: this.config.scale ?? 1 };
  }

  /**
   * Set camera position and zoom (for stress testing)
   */
  setCamera(x: number, y: number, zoom: number): void {
    if (this.infiniteCanvas) {
      this.infiniteCanvas.setCamera(x, y, zoom);
    }
  }

  /**
   * Get container element (for stress testing - synthetic events)
   */
  getContainer(): HTMLElement {
    return this.container;
  }

  /**
   * Get diagnostic state for stress testing
   */
  getDiagnosticState(): { coverage: number; cssStretch: number } | null {
    if (this.infiniteCanvas) {
      return this.infiniteCanvas.getDiagnosticState();
    }
    return null;
  }

  /**
   * Get zoom scale service (for stress testing)
   */
  getZoomScaleService(): any {
    if (this.infiniteCanvas) {
      return this.infiniteCanvas.getZoomScaleService();
    }
    return null;
  }

  /**
   * Get comprehensive diagnostic state for live testing
   */
  getFullDiagnosticState(): any {
    if (this.infiniteCanvas) {
      return this.infiniteCanvas.getFullDiagnosticState();
    }
    return null;
  }

  /**
   * Reset to auto-fit scale (clears user zoom)
   */
  resetScale(): void {
    if (this.multiPageContainer && this.document) {
      // Reset zoom to auto-fit
      this.multiPageContainer.resetZoom();

      // Get the calculated scale from the layout
      const layout = this.multiPageContainer.getLayout();
      if (layout) {
        this.config.scale = layout.scale;
      }
    }
  }

  /**
   * Set reading mode (theme) for PDF pages
   * - 'device': Match Obsidian's theme (light or dark)
   * - 'light': White background
   * - 'sepia': Warm sepia tint for reduced eye strain
   * - 'dark': Inverted colors (dark background, light text)
   * - 'night': Dark with warm tint (reduced blue light)
   */
  setReadingMode(mode: 'device' | 'light' | 'sepia' | 'dark' | 'night'): void {
    if (this.infiniteCanvas) {
      this.infiniteCanvas.setReadingMode(mode);
    } else if (this.multiPageContainer) {
      this.multiPageContainer.updateConfig({ readingMode: mode });
    }
  }

  /**
   * Get current reading mode
   */
  getReadingMode(): 'device' | 'light' | 'sepia' | 'dark' | 'night' {
    return (this.multiPageContainer as any)?.config?.readingMode ?? 'device';
  }

  // Thumbnail cache for canvas view (separate from page cache)
  private thumbnailCache: Map<number, string> = new Map();

  /**
   * Enter canvas mode (thumbnail grid)
   */
  private async enterCanvasMode(): Promise<void> {
    if (!this.document || this.isCanvasMode) return;

    this.isCanvasMode = true;

    try {
      // Create canvas view if not exists
      if (!this.canvasView) {
        const pageWidth = 612; // Default US Letter
        const pageHeight = 792;

        this.canvasView = new PdfCanvasView(this.container, {
          onPageSelect: (page) => {
            this.exitCanvasMode();
            this.goToPage(page);
          },
          onContextMenu: (pages, x, y) => {
            this.showContextMenu(pages, x, y);
          },
          getThumbnail: async (page) => {
            // Check cache first
            const cached = this.thumbnailCache.get(page);
            if (cached) return cached;

            try {
              const dataUrl = await this.getThumbnailDataUrl(page);
              this.thumbnailCache.set(page, dataUrl);
              return dataUrl;
            } catch (error) {
              console.error(`Failed to get thumbnail for page ${page}:`, error);
              // Return a placeholder
              return 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjE0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjE0MCIgZmlsbD0iI2YwZjBmMCIvPjx0ZXh0IHg9IjUwIiB5PSI3MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iIzk5OSI+PC90ZXh0Pjwvc3ZnPg==';
            }
          },
        },
        {
          pageWidth,
          pageHeight,
          thumbnailSize: 120, // Smaller thumbnails for faster loading
          gap: 12,
        });
      }

      // Create context menu if not exists
      if (!this.contextMenu) {
        this.contextMenu = new PdfContextMenu();
      }

      // Show canvas view with fade-in
      this.canvasView.show();

      // Pre-load first batch of thumbnails (first ~20 visible)
      const preloadCount = Math.min(20, this.document.pageCount);
      const preloadPromises: Promise<string>[] = [];
      for (let i = 1; i <= preloadCount; i++) {
        if (!this.thumbnailCache.has(i)) {
          preloadPromises.push(
            this.getThumbnailDataUrl(i).then(url => {
              this.thumbnailCache.set(i, url);
              return url;
            }).catch(() => '')
          );
        }
      }

      // Wait for first batch before rendering (max 500ms)
      await Promise.race([
        Promise.all(preloadPromises),
        new Promise(resolve => setTimeout(resolve, 500))
      ]);

      // Now render and fade out page container
      await this.canvasView.render(this.document.pageCount);

      // Fade out page container smoothly
      this.pageContainer.style.transition = 'opacity 0.2s ease-out';
      this.pageContainer.style.opacity = '0';

      // Store timeout ID so it can be cancelled if exitCanvasMode is called
      this.canvasModeHideTimeout = window.setTimeout(() => {
        // Only hide if still in canvas mode (prevents race condition during rapid zoom)
        if (this.isCanvasMode) {
          this.pageContainer.style.display = 'none';
        }
        this.pageContainer.style.transition = '';
        this.pageContainer.style.opacity = '';
        this.canvasModeHideTimeout = null;
      }, 200);

    } catch (error) {
      console.error('Failed to enter canvas mode:', error);
      this.isCanvasMode = false;
      this.pageContainer.style.display = '';
      this.pageContainer.style.opacity = '';
    }
  }

  /**
   * Exit canvas mode
   */
  private exitCanvasMode(): void {
    if (!this.isCanvasMode) return;

    this.isCanvasMode = false;

    // Cancel any pending hide timeout to prevent race condition
    if (this.canvasModeHideTimeout !== null) {
      clearTimeout(this.canvasModeHideTimeout);
      this.canvasModeHideTimeout = null;
    }

    // Show page container with fade-in
    this.pageContainer.style.display = '';
    this.pageContainer.style.opacity = '0';
    this.pageContainer.style.transition = 'opacity 0.15s ease-in';

    requestAnimationFrame(() => {
      this.pageContainer.style.opacity = '1';
      setTimeout(() => {
        this.pageContainer.style.transition = '';
        this.canvasView?.hide();
      }, 150);
    });
  }

  /**
   * Get thumbnail data URL for a page
   */
  private async getThumbnailDataUrl(page: number): Promise<string> {
    if (!this.document) {
      throw new Error('No document loaded');
    }

    // Request a small thumbnail using low scale and DPI
    const blob = await this.provider.getPdfPage(this.document.id, page, {
      scale: 0.2, // Small scale for thumbnails
      dpi: 72,
      format: 'jpeg',
      quality: 70,
    });

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Show context menu for selected pages
   */
  private showContextMenu(pages: number[], x: number, y: number): void {
    if (!this.contextMenu) return;

    const actions = createDefaultPdfActions({
      onGoToPage: (page) => {
        this.exitCanvasMode();
        this.goToPage(page);
      },
      onCopyAsImage: async (pages) => {
        // Copy first page as image to clipboard
        const blob = await this.provider.getPdfPage(this.document!.id, pages[0], {
          scale: 2,
          format: 'png',
        });
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob }),
          ]);
        } catch (error) {
          console.error('Failed to copy to clipboard:', error);
        }
      },
      onExportAsImage: async (pages) => {
        for (const page of pages) {
          const blob = await this.provider.getPdfPage(this.document!.id, page, {
            scale: 2,
            format: 'png',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `page-${page}.png`;
          a.click();
          URL.revokeObjectURL(url);
        }
      },
      onPrintPages: async (pages) => {
        // Open print dialog with pages
        console.log('Print pages:', pages);
        // TODO: Implement print functionality
      },
      onRotateClockwise: (pages) => {
        // TODO: Store per-page rotation
        console.log('Rotate clockwise:', pages);
      },
      onRotateCounterClockwise: (pages) => {
        // TODO: Store per-page rotation
        console.log('Rotate counter-clockwise:', pages);
      },
      onCopyToNote: async (pages) => {
        // TODO: Implement copy to note functionality
        // This would emit a custom event for the container to handle
        console.log('Copy to note:', pages);
      },
    });

    this.contextMenu.show(x, y, pages, actions);
  }

  /**
   * Set rotation
   */
  setRotation(rotation: number): void {
    // Normalize to 0, 90, 180, 270
    rotation = ((rotation % 360) + 360) % 360;
    rotation = Math.round(rotation / 90) * 90;
    this.updateConfig({ rotation });
  }

  /**
   * Rotate clockwise by 90 degrees
   */
  rotateClockwise(): void {
    const current = this.config.rotation ?? 0;
    this.setRotation((current + 90) % 360);
  }

  /**
   * Rotate counter-clockwise by 90 degrees
   */
  rotateCounterClockwise(): void {
    const current = this.config.rotation ?? 0;
    this.setRotation((current - 90 + 360) % 360);
  }

  /**
   * Set display mode (paginated or scrolled)
   * Switches between infinite canvas (scrolled) and multi-page container (paginated)
   *
   * Implements seamless transitions:
   * 1. Pause prefetch to prevent race conditions
   * 2. Store current state (page position)
   * 3. Swap containers (provider cache persists)
   * 4. Restore position
   * 5. Resume prefetch
   */
  setMode(mode: 'paginated' | 'scrolled'): void {
    if (this.config.mode === mode) return;

    const startTime = performance.now();
    const previousPage = this.currentPage;
    const previousZoom = this.config.scale ?? 1.5;

    // 1. Pause prefetch during transition
    this.pausePrefetch();

    this.config.mode = mode;

    // Switch container type based on mode
    // NOTE: Provider cache (IndexedDB) persists across switches - only container's
    // in-memory state is lost, which is acceptable since pages will be fetched
    // from the provider's cache on the new container initialization.
    if (this.useInfiniteCanvas && mode === 'scrolled') {
      // Switch to infinite canvas for scrolled mode
      if (this.multiPageContainer) {
        this.multiPageContainer.destroy();
        this.multiPageContainer = null;
      }
      if (this.gestureHandler) {
        this.gestureHandler.destroy();
        this.gestureHandler = null;
      }

      this.initializeInfiniteCanvas();

      if (this.document && this.infiniteCanvas) {
        this.infiniteCanvas.initialize(this.document.pageCount);
        // Update layouts with actual PDF dimensions (from tile engine if available)
        this.infiniteCanvas.updatePageDimensions();
        this.infiniteCanvas.goToPage(previousPage);
      }
    } else {
      // Switch to multi-page container for paginated mode
      if (this.infiniteCanvas) {
        this.infiniteCanvas.destroy();
        this.infiniteCanvas = null;
      }

      this.initializeMultiPageContainer();
      this.setupGestureHandler();

      // Update gesture handler - zoom only enabled in scrolled mode
      if (this.gestureHandler) {
        this.gestureHandler.setDisplayMode(mode === 'paginated' ? 'paginated' : 'scrolled');
        this.gestureHandler.setZoomEnabled(mode !== 'paginated');
      }

      if (this.document && this.multiPageContainer) {
        this.multiPageContainer.initialize(this.document.pageCount);
        this.multiPageContainer.goToPage(previousPage);
      }
    }

    // 5. Resume prefetch
    this.resumePrefetch();

    // Log transition time for performance monitoring
    const duration = performance.now() - startTime;
    console.log(`[PdfRenderer] Mode transition to '${mode}' took ${duration.toFixed(1)}ms`);
    if (duration > 100) {
      console.warn(`[PdfRenderer] Mode transition exceeded 100ms target (${duration.toFixed(1)}ms)`);
    }
  }

  /**
   * Get current display mode (legacy: paginated/scrolled)
   */
  getMode(): 'paginated' | 'scrolled' {
    return this.config.mode ?? 'paginated';
  }

  /**
   * Set extended display mode (5 modes)
   * Uses infinite canvas for all modes except 'paginated'
   *
   * @param mode One of: 'paginated', 'horizontal-scroll', 'vertical-scroll', 'auto-grid', 'canvas'
   */
  setDisplayMode(mode: 'paginated' | 'horizontal-scroll' | 'vertical-scroll' | 'auto-grid' | 'canvas'): void {
    const isPaginated = mode === 'paginated';
    const currentIsPaginated = this.config.mode === 'paginated';

    // If switching between paginated and non-paginated, switch containers
    if (isPaginated !== currentIsPaginated) {
      this.setMode(isPaginated ? 'paginated' : 'scrolled');
    }

    // For non-paginated modes, update infinite canvas display mode
    if (!isPaginated && this.infiniteCanvas) {
      this.infiniteCanvas.setDisplayMode(mode);
    }
  }

  /**
   * Get extended display mode
   */
  getDisplayMode(): 'paginated' | 'horizontal-scroll' | 'vertical-scroll' | 'auto-grid' | 'canvas' {
    if (this.config.mode === 'paginated') {
      return 'paginated';
    }
    if (this.infiniteCanvas) {
      return this.infiniteCanvas.getDisplayMode();
    }
    // Fallback based on scroll direction
    return this.config.scrollDirection === 'horizontal' ? 'horizontal-scroll' : 'vertical-scroll';
  }

  /**
   * Fit the current page to the viewport
   */
  fitToPage(): void {
    if (this.infiniteCanvas) {
      this.infiniteCanvas.fitToPage();
    }
    // For multi-page container, reset zoom triggers auto-fit
    if (this.multiPageContainer) {
      this.resetScale();
    }
  }

  /**
   * Fit to viewport width
   */
  fitToWidth(): void {
    if (this.infiniteCanvas) {
      this.infiniteCanvas.fitToWidth();
    }
    // For multi-page container, we'd need to calculate the width-fit zoom
  }

  /**
   * Set scroll direction (for scrolled mode)
   * @deprecated Use setDisplayMode('horizontal-scroll') or setDisplayMode('vertical-scroll') instead
   */
  setScrollDirection(direction: 'vertical' | 'horizontal'): void {
    if (this.config.scrollDirection === direction) return;
    this.config.scrollDirection = direction;

    // Update infinite canvas layout mode
    if (this.infiniteCanvas && this.document) {
      this.infiniteCanvas.setLayoutMode(
        direction === 'horizontal' ? 'horizontal' : 'vertical'
      );
    }

    // Update multi-page container
    if (this.multiPageContainer && this.document) {
      this.multiPageContainer.updateConfig({
        scrollDirection: direction,
      });
    }
  }

  /**
   * Get current scroll direction
   */
  getScrollDirection(): 'vertical' | 'horizontal' {
    return this.config.scrollDirection ?? 'vertical';
  }

  /**
   * Update container scroll direction based on mode and direction settings
   */
  private updateContainerScrollDirection(): void {
    const direction = this.getScrollDirection();
    if (this.config.mode === 'scrolled') {
      if (direction === 'vertical') {
        this.pageContainer.style.overflowY = 'auto';
        this.pageContainer.style.overflowX = 'hidden';
        this.pageContainer.style.flexDirection = 'column';
      } else {
        this.pageContainer.style.overflowX = 'auto';
        this.pageContainer.style.overflowY = 'hidden';
        this.pageContainer.style.flexDirection = 'row';
      }
    } else {
      // Paginated mode - no overflow
      this.pageContainer.style.overflow = 'auto';
      this.pageContainer.style.flexDirection = 'row';
    }
  }

  // ============================================================================
  // Region Selection Methods
  // Note: Region selection is not yet implemented in multi-page mode
  // ============================================================================

  /**
   * Enable region selection mode (for scanned PDFs)
   */
  enableRegionSelection(): void {
    this.regionSelection?.setEnabled(true);
  }

  /**
   * Disable region selection mode
   */
  disableRegionSelection(): void {
    this.regionSelection?.setEnabled(false);
  }

  /**
   * Check if region selection is enabled
   */
  isRegionSelectionEnabled(): boolean {
    return this.regionSelection?.isEnabled() ?? false;
  }

  /**
   * Clear current region selection
   */
  clearRegionSelection(): void {
    this.regionSelection?.clearSelection();
  }

  /**
   * Highlight a region temporarily (for showing OCR results)
   */
  highlightRegion(rect: { x: number; y: number; width: number; height: number }, duration = 2000): void {
    this.regionSelection?.highlightRegion(rect, duration);
  }

  // ============================================================================
  // Optimization Settings Methods
  // ============================================================================

  /**
   * Get current optimization settings
   */
  getOptimizationSettings(): {
    renderDpi: number;
    enableHardwareAcceleration: boolean;
    enableCanvasAcceleration: boolean;
    pagePreloadCount: number;
    enablePageCache: boolean;
    pageCacheSize: number;
    imageFormat: 'png' | 'jpeg' | 'webp';
    imageQuality: number;
    enableProgressiveRendering: boolean;
    previewScale: number;
    enableTextAntialiasing: boolean;
    enableImageSmoothing: boolean;
  } {
    return {
      renderDpi: this.config.renderDpi ?? 150,
      enableHardwareAcceleration: this.config.enableHardwareAcceleration ?? true,
      enableCanvasAcceleration: this.config.enableCanvasAcceleration ?? true,
      pagePreloadCount: this.config.pagePreloadCount ?? 2,
      enablePageCache: this.config.enablePageCache ?? true,
      pageCacheSize: this.config.pageCacheSize ?? 10,
      imageFormat: this.config.imageFormat ?? 'png',
      imageQuality: this.config.imageQuality ?? 85,
      enableProgressiveRendering: this.config.enableProgressiveRendering ?? true,
      previewScale: this.config.previewScale ?? 0.25,
      enableTextAntialiasing: this.config.enableTextAntialiasing ?? true,
      enableImageSmoothing: this.config.enableImageSmoothing ?? true,
    };
  }

  /**
   * Update optimization settings
   */
  updateOptimizationSettings(settings: Partial<{
    renderDpi: number;
    enableHardwareAcceleration: boolean;
    enableCanvasAcceleration: boolean;
    pagePreloadCount: number;
    enablePageCache: boolean;
    pageCacheSize: number;
    imageFormat: 'png' | 'jpeg' | 'webp';
    imageQuality: number;
    enableProgressiveRendering: boolean;
    previewScale: number;
    enableTextAntialiasing: boolean;
    enableImageSmoothing: boolean;
  }>): void {
    const needsRerender =
      settings.renderDpi !== undefined && settings.renderDpi !== this.config.renderDpi ||
      settings.imageFormat !== undefined && settings.imageFormat !== this.config.imageFormat ||
      settings.imageQuality !== undefined && settings.imageQuality !== this.config.imageQuality;

    // Clear cache if render settings changed
    if (needsRerender) {
      this.clearCache();
    }

    // Apply new settings
    Object.assign(this.config, settings);

    // Re-render if needed - trigger multi-page container re-render
    if (needsRerender && this.document && this.multiPageContainer) {
      this.multiPageContainer.handleResize();
    }
  }

  /**
   * Set render DPI (clears cache and re-renders)
   */
  setRenderDpi(dpi: number): void {
    if (this.config.renderDpi === dpi) return;
    this.clearCache();
    this.config.renderDpi = dpi;
    if (this.document && this.multiPageContainer) {
      this.multiPageContainer.handleResize();
    }
  }

  /**
   * Get current render DPI
   */
  getRenderDpi(): number {
    return this.config.renderDpi ?? 150;
  }

  /**
   * Set image format (clears cache and re-renders)
   */
  setImageFormat(format: 'png' | 'jpeg' | 'webp'): void {
    if (this.config.imageFormat === format) return;
    this.clearCache();
    this.config.imageFormat = format;
    if (this.document && this.multiPageContainer) {
      this.multiPageContainer.handleResize();
    }
  }

  /**
   * Get current image format
   */
  getImageFormat(): 'png' | 'jpeg' | 'webp' {
    return this.config.imageFormat ?? 'png';
  }

  /**
   * Set page cache enabled
   */
  setPageCacheEnabled(enabled: boolean): void {
    this.config.enablePageCache = enabled;
    if (!enabled) {
      this.clearCache();
    }
  }

  /**
   * Check if page cache is enabled
   */
  isPageCacheEnabled(): boolean {
    return this.config.enablePageCache ?? true;
  }

  /**
   * Get current cache size (number of pages cached)
   */
  getCacheSize(): number {
    return this.pageCache.size;
  }

  /**
   * Pause prefetching (e.g., during mode transitions)
   * Preserves the queue but stops processing
   */
  private pausePrefetch(): void {
    if ('pausePrefetch' in this.provider && typeof (this.provider as any).pausePrefetch === 'function') {
      (this.provider as any).pausePrefetch();
    }
  }

  /**
   * Resume prefetching after pause
   */
  private resumePrefetch(): void {
    if ('resumePrefetch' in this.provider && typeof (this.provider as any).resumePrefetch === 'function') {
      (this.provider as any).resumePrefetch();
    }
  }
}

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

  // Layers
  private canvasLayer: PdfCanvasLayer;
  private textLayer: PdfTextLayer;
  private annotationLayer: PdfAnnotationLayer;
  private regionSelection: PdfRegionSelection;

  // Provider
  private provider: PdfContentProvider;

  // State
  private document: ParsedPdf | null = null;
  private currentPage = 1;
  private config: DocumentRendererConfig;

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

    this.config = {
      mode: config?.mode ?? 'paginated',
      pageLayout: config?.pageLayout ?? 'single',
      theme: config?.theme ?? 'system',
      scale: config?.scale ?? 1.5,
      rotation: config?.rotation ?? 0,
      margin: config?.margin ?? 20,
    };

    // Create page container
    this.pageContainer = document.createElement('div');
    this.pageContainer.className = 'pdf-page-container';
    this.pageContainer.style.cssText = `
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: auto;
    `;
    this.container.appendChild(this.pageContainer);

    // Create layers (order matters: canvas -> text -> annotation -> region)
    this.canvasLayer = new PdfCanvasLayer(this.pageContainer);
    this.textLayer = new PdfTextLayer(this.pageContainer);
    this.annotationLayer = new PdfAnnotationLayer(this.pageContainer);
    this.regionSelection = new PdfRegionSelection(this.pageContainer, {
      enabled: false, // Disabled by default, enabled for scanned PDFs
    });

    // Set up event handlers
    this.setupSelectionHandler();
    this.setupAnnotationHandler();
    this.setupRegionSelectionHandler();
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  async load(documentId: string): Promise<void> {
    this.emit('loading', true);

    try {
      this.document = await this.provider.getPdf(documentId);
      this.currentPage = 1;

      // Render first page
      await this.renderPage(1);

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

      // Render first page
      await this.renderPage(1);

      this.emit('loading', false);
      this.emitLocation();
    } catch (error) {
      this.emit('loading', false);
      this.emit('error', error as Error);
      throw error;
    }
  }

  destroy(): void {
    this.canvasLayer.destroy();
    this.textLayer.destroy();
    this.annotationLayer.destroy();
    this.regionSelection.destroy();
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
        // Parse page from href (e.g., "page:5")
        if (target.href.startsWith('page:')) {
          page = parseInt(target.href.slice(5), 10) || 1;
        }
        break;
    }

    await this.goToPage(page);
  }

  async next(): Promise<void> {
    if (!this.document) return;

    const nextPage = Math.min(this.currentPage + 1, this.document.pageCount);
    if (nextPage !== this.currentPage) {
      await this.goToPage(nextPage);
    }
  }

  async prev(): Promise<void> {
    if (!this.document) return;

    const prevPage = Math.max(this.currentPage - 1, 1);
    if (prevPage !== this.currentPage) {
      await this.goToPage(prevPage);
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

    // Re-render if scale or rotation changed
    if (
      this.document &&
      (config.scale !== oldScale || config.rotation !== oldRotation)
    ) {
      this.renderPage(this.currentPage);
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
    // Convert document highlights to PDF highlights for current page
    const pdfHighlights: PdfHighlight[] = [];

    for (const highlight of this.highlights.values()) {
      if (highlight.selector.format !== 'pdf') continue;

      const pdfSelector = highlight.selector as PdfSelector;
      if (pdfSelector.page !== this.currentPage) continue;

      const rects = pdfSelector.rect ? [pdfSelector.rect] : [];
      if (rects.length === 0) continue;

      pdfHighlights.push({
        id: highlight.id,
        annotationId: highlight.annotationId,
        color: highlight.color,
        page: pdfSelector.page,
        rects,
      });
    }

    this.annotationLayer.setHighlights(pdfHighlights);
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

    if (page === this.currentPage) return;

    this.currentPage = page;
    await this.renderPage(page);
    this.emitLocation();
  }

  private async renderPage(page: number): Promise<void> {
    if (!this.document) return;

    this.emit('loading', true);

    try {
      const scale = this.config.scale ?? 1.5;
      const rotation = this.config.rotation ?? 0;

      // Fetch page image
      const imageBlob = await this.provider.getPdfPage(this.document.id, page, {
        scale,
        rotation,
      });

      // Calculate display dimensions
      // For now, use a fixed aspect ratio; in production, get from server
      const containerRect = this.container.getBoundingClientRect();
      const maxWidth = containerRect.width - (this.config.margin ?? 20) * 2;
      const maxHeight = containerRect.height - (this.config.margin ?? 20) * 2;

      // Render canvas
      await this.canvasLayer.renderPage(imageBlob, maxWidth, maxHeight, rotation);

      // Fetch and render text layer
      try {
        const textLayerData = await this.provider.getPdfTextLayer(
          this.document.id,
          page
        );
        const dimensions = this.canvasLayer.getDimensions();
        this.textLayer.render(
          textLayerData,
          scale,
          rotation,
          dimensions.width,
          dimensions.height
        );
      } catch (error) {
        console.warn('Failed to load text layer:', error);
        this.textLayer.clear();
      }

      // Update annotation and region selection layers
      const dimensions = this.canvasLayer.getDimensions();
      this.annotationLayer.setDimensions(dimensions.width, dimensions.height);
      this.annotationLayer.setPage(page);
      this.regionSelection.setDimensions(dimensions.width, dimensions.height);
      this.regionSelection.setPage(page);

      // Refresh highlights for the new page
      this.refreshHighlights();

      this.emit('rendered', { position: page });
      this.emit('loading', false);
    } catch (error) {
      this.emit('loading', false);
      this.emit('error', error as Error);
      throw error;
    }
  }

  private emitLocation(): void {
    const location = this.getLocation();
    if (location) {
      this.emit('relocated', location);
    }
  }

  private setupSelectionHandler(): void {
    this.textLayer.getContainer().addEventListener('mouseup', () => {
      const selection = this.textLayer.getSelection();
      if (!selection) return;

      const rect = this.textLayer.getSelectionRect();
      if (!rect) return;

      const containerRect = this.container.getBoundingClientRect();

      this.emit('selected', {
        text: selection.text,
        selector: {
          format: 'pdf',
          page: selection.page,
          textQuote: {
            exact: selection.text,
            prefix: selection.prefix,
            suffix: selection.suffix,
          },
          position: {
            start: selection.startIndex,
            end: selection.endIndex,
          },
        },
        position: {
          x: containerRect.left + rect.x + rect.width / 2,
          y: containerRect.top + rect.y,
        },
      });
    });
  }

  private setupAnnotationHandler(): void {
    this.annotationLayer.setOnHighlightClick((annotationId, position) => {
      this.emit('highlightClicked', { annotationId, position });
    });
  }

  private setupRegionSelectionHandler(): void {
    this.regionSelection.setOnSelection((selection) => {
      const event: RegionSelectionEvent = {
        page: selection.page,
        rect: selection.rect,
        position: selection.position,
      };
      this.emit('regionSelected', event);
    });
  }

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
   * Set scale
   */
  setScale(scale: number): void {
    this.updateConfig({ scale });
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

  // ============================================================================
  // Region Selection Methods
  // ============================================================================

  /**
   * Enable region selection mode (for scanned PDFs)
   */
  enableRegionSelection(): void {
    this.regionSelection.setEnabled(true);
  }

  /**
   * Disable region selection mode
   */
  disableRegionSelection(): void {
    this.regionSelection.setEnabled(false);
  }

  /**
   * Check if region selection is enabled
   */
  isRegionSelectionEnabled(): boolean {
    return this.regionSelection.isEnabled();
  }

  /**
   * Clear current region selection
   */
  clearRegionSelection(): void {
    this.regionSelection.clearSelection();
  }

  /**
   * Highlight a region temporarily (for showing OCR results)
   */
  highlightRegion(rect: { x: number; y: number; width: number; height: number }, duration = 2000): void {
    this.regionSelection.highlightRegion(rect, duration);
  }
}

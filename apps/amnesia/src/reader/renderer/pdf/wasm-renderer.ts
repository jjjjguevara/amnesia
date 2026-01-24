/**
 * WASM PDF Renderer
 *
 * Client-side PDF rendering using MuPDF WASM for fast, local rendering.
 * Provides <50ms first paint by eliminating server round-trips.
 *
 * Features:
 * - Local WASM-based rendering (no server required)
 * - Accurate text layer with character-level positions
 * - Search with bounding boxes
 * - Memory-efficient caching
 *
 * @example
 * ```typescript
 * import { WasmPdfRenderer } from './wasm-renderer';
 *
 * const renderer = new WasmPdfRenderer();
 * await renderer.initialize();
 * await renderer.loadDocument(pdfArrayBuffer);
 * const pageBlob = await renderer.renderPage(1, { scale: 1.5 });
 * ```
 */

import { getSharedMuPDFBridge, destroySharedMuPDFBridge, type RenderFormat, type IMuPDFBridge } from './mupdf-bridge';
import type { TextLayerData, TextItem, CharPosition, SearchResult, TocEntry } from './mupdf-worker';
import type { PdfTextLayerData, PdfRenderOptions, PdfSearchResult } from '../types';
import { createPipelineTimer, type PipelineTimerBuilder } from './pdf-telemetry';
import { isFeatureEnabled } from './feature-flags';

/**
 * Result from tile/page rendering - can be PNG Blob or raw RGBA pixels
 */
export interface TileRenderResult {
  format: RenderFormat;
  /** PNG blob (when format === 'png') */
  blob?: Blob;
  /** Raw RGBA pixel data (when format === 'rgba') */
  rgba?: Uint8Array;
  /** Rendered width in pixels */
  width: number;
  /** Rendered height in pixels */
  height: number;
  /**
   * Scale epoch at render time (INV-6: Scale/Layout Atomicity).
   * Used to validate tiles at display time - stale epochs are discarded.
   */
  scaleEpoch?: number;
}

/**
 * Configuration for WASM renderer
 */
export interface WasmRendererConfig {
  /** Enable memory caching of rendered pages (default: true) */
  enableCache?: boolean;
  /** Maximum number of pages to cache in memory (default: 10) */
  cacheSize?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
}

/**
 * Cached page data
 */
interface CachedPage {
  blob: Blob;
  scale: number;
  timestamp: number;
}

/**
 * WASM-based PDF renderer using MuPDF
 */
export class WasmPdfRenderer {
  private bridge: IMuPDFBridge | null = null;
  private documentId: string | null = null;
  private pageCount: number = 0;
  private config: Required<WasmRendererConfig>;

  // Page cache: Map<pageNum, Map<scale, CachedPage>>
  private pageCache: Map<number, Map<number, CachedPage>> = new Map();

  // Text layer cache: Map<pageNum, TextLayerData>
  private textLayerCache: Map<number, TextLayerData> = new Map();

  constructor(config: WasmRendererConfig = {}) {
    this.config = {
      enableCache: config.enableCache ?? true,
      cacheSize: config.cacheSize ?? 10,
      debug: config.debug ?? false,
    };
  }

  /**
   * Initialize the WASM renderer
   * Spawns the Web Worker and loads MuPDF WASM
   */
  async initialize(): Promise<void> {
    if (this.bridge) return;

    const startTime = performance.now();
    console.log('[WasmRenderer] initialize() - calling getSharedMuPDFBridge()...');

    this.bridge = await getSharedMuPDFBridge();
    console.log('[WasmRenderer] Bridge obtained, type:', this.bridge?.constructor?.name);

    if (this.config.debug) {
      console.log(`[WasmRenderer] Initialized in ${(performance.now() - startTime).toFixed(1)}ms`);
    }
  }

  /**
   * Load a PDF document from ArrayBuffer
   *
   * @param data PDF file as ArrayBuffer
   * @returns Page count, document info, and TOC
   */
  async loadDocument(data: ArrayBuffer): Promise<{ pageCount: number; id: string; toc: TocEntry[] }> {
    if (!this.bridge) {
      throw new Error('Renderer not initialized. Call initialize() first.');
    }

    const startTime = performance.now();

    // Clear any existing caches
    this.clearCache();

    const result = await this.bridge.loadDocumentWithId(data);
    this.documentId = result.id;
    this.pageCount = result.pageCount;

    if (this.config.debug) {
      console.log(
        `[WasmRenderer] Loaded document with ${result.pageCount} pages in ` +
          `${(performance.now() - startTime).toFixed(1)}ms`
      );
    }

    return result;
  }

  /**
   * Load document on all workers for maximum parallel rendering
   * Call this after loadDocument() when expecting heavy batch rendering
   *
   * @param data Original document data (will be cloned for each worker)
   */
  async loadDocumentOnAllWorkers(data: ArrayBuffer): Promise<void> {
    if (!this.bridge || !this.documentId) {
      throw new Error('Document not loaded. Call loadDocument() first.');
    }

    // Check if bridge supports loading on all workers (PooledMuPDFBridge)
    const bridgeWithPool = this.bridge as IMuPDFBridge & {
      loadDocumentOnAllWorkers?: (docId: string, data: ArrayBuffer) => Promise<void>;
      getWorkerCount?: () => number;
    };

    if (typeof bridgeWithPool.loadDocumentOnAllWorkers === 'function') {
      const workerCount = bridgeWithPool.getWorkerCount?.() ?? 1;
      console.log(`[WasmRenderer] Loading document on all ${workerCount} workers for parallel rendering`);
      await bridgeWithPool.loadDocumentOnAllWorkers(this.documentId, data);
    } else {
      console.log('[WasmRenderer] Bridge does not support multi-worker loading');
    }
  }

  /**
   * Render a page to PNG blob
   *
   * @param pageNumber 1-indexed page number
   * @param options Render options (scale, etc.)
   * @returns PNG blob
   */
  async renderPage(pageNumber: number, options?: PdfRenderOptions): Promise<Blob> {
    if (!this.bridge || !this.documentId) {
      throw new Error('No document loaded');
    }

    const scale = options?.scale ?? 1.5;
    const startTime = performance.now();

    // Check cache first
    if (this.config.enableCache) {
      const cached = this.getCachedPage(pageNumber, scale);
      if (cached) {
        if (this.config.debug) {
          console.log(`[WasmRenderer] Cache hit for page ${pageNumber} @ ${scale}x`);
        }
        return cached;
      }
    }

    // Create pipeline timer for telemetry tracking
    const enableTelemetry = isFeatureEnabled('enablePipelineTelemetry');
    let timer: PipelineTimerBuilder | null = null;
    if (enableTelemetry) {
      const requestId = `page-${pageNumber}-${Date.now()}`;
      timer = createPipelineTimer(requestId, {
        page: pageNumber,
        scale,
        transferFormat: 'png',
      });
    }

    // Render via worker
    const result = await this.bridge.renderPage(this.documentId, pageNumber, scale);

    // Record worker timing if available
    if (timer && result.workerTiming) {
      timer
        .setStage('pageLoad', result.workerTiming.pageLoad)
        .setStage('render', result.workerTiming.render)
        .setStage('encode', result.workerTiming.encode);
    }

    // Record transfer time if available
    if (timer && result.transferTime !== undefined) {
      timer.setStage('transfer', result.transferTime);
    }

    // Convert Uint8Array PNG to Blob (decode stage)
    const decodeStart = performance.now();
    const pngData = new Uint8Array(result.data);
    const blob = new Blob([pngData], { type: 'image/png' });
    if (timer) {
      timer.setStage('decode', performance.now() - decodeStart);
    }

    // Cache the result (cache stage)
    const cacheStart = performance.now();
    if (this.config.enableCache) {
      this.setCachedPage(pageNumber, scale, blob);
    }
    if (timer) {
      timer.setStage('cache', performance.now() - cacheStart);
    }

    // Finalize and record telemetry
    if (timer) {
      timer.complete();
    }

    if (this.config.debug) {
      console.log(
        `[WasmRenderer] Rendered page ${pageNumber} @ ${scale}x ` +
          `(${result.width}x${result.height}) in ${(performance.now() - startTime).toFixed(1)}ms`
      );
    }

    return blob;
  }

  /**
   * Render multiple pages in batch across all workers
   * Uses parallel rendering when PooledMuPDFBridge is available
   *
   * @param pageNumbers Array of 1-indexed page numbers to render
   * @param options Render options (scale)
   * @param onProgress Optional progress callback
   * @returns Map of page number to PNG blob
   */
  async renderPageBatch(
    pageNumbers: number[],
    options?: PdfRenderOptions,
    onProgress?: (completed: number, total: number, pageNum: number) => void
  ): Promise<Map<number, Blob>> {
    if (!this.bridge || !this.documentId) {
      throw new Error('No document loaded');
    }

    const scale = options?.scale ?? 1.5;
    const results = new Map<number, Blob>();

    // Check if bridge supports batch rendering (PooledMuPDFBridge)
    const bridgeWithBatch = this.bridge as IMuPDFBridge & {
      renderPageBatch?: (
        docId: string,
        pageNums: number[],
        scale: number,
        format?: string,
        onProgress?: (completed: number, total: number, pageNum: number) => void
      ) => Promise<Map<number, { data: Uint8Array; width: number; height: number; format: string }>>;
    };

    if (typeof bridgeWithBatch.renderPageBatch === 'function') {
      // Use batch rendering for parallel execution
      const startTime = performance.now();
      console.log(`[WasmRenderer] Starting batch render: ${pageNumbers.length} pages at scale ${scale}`);

      const batchResults = await bridgeWithBatch.renderPageBatch(
        this.documentId,
        pageNumbers,
        scale,
        'png',
        onProgress
      );

      // Convert Uint8Array to Blobs
      for (const [pageNum, result] of batchResults) {
        // Ensure we have a regular ArrayBuffer (not SharedArrayBuffer) for Blob creation
        const dataArray = new Uint8Array(result.data);
        const blob = new Blob([dataArray], { type: 'image/png' });
        results.set(pageNum, blob);

        // Cache the result
        if (this.config.enableCache) {
          this.setCachedPage(pageNum, scale, blob);
        }
      }

      console.log(
        `[WasmRenderer] Batch render complete: ${results.size}/${pageNumbers.length} in ${(performance.now() - startTime).toFixed(0)}ms`
      );
    } else {
      // Fall back to sequential rendering
      console.log(`[WasmRenderer] Batch rendering not available, falling back to sequential`);
      let completed = 0;
      for (const pageNum of pageNumbers) {
        try {
          const blob = await this.renderPage(pageNum, options);
          results.set(pageNum, blob);
          completed++;
          onProgress?.(completed, pageNumbers.length, pageNum);
        } catch (err) {
          console.error(`[WasmRenderer] Batch render failed for page ${pageNum}:`, err);
        }
      }
    }

    return results;
  }

  /**
   * Render a specific tile (256x256 region) of a page
   *
   * @param pageNumber 1-indexed page number
   * @param tileX Tile X coordinate (0-indexed)
   * @param tileY Tile Y coordinate (0-indexed)
   * @param options Render options (scale, tileSize)
   * @returns PNG blob of the tile (for legacy compatibility)
   */
  async renderTile(
    pageNumber: number,
    tileX: number,
    tileY: number,
    options?: { scale?: number; tileSize?: number }
  ): Promise<Blob> {
    // Use raw RGBA if feature flag is enabled, but convert to blob for compatibility
    const result = await this.renderTileWithFormat(pageNumber, tileX, tileY, options);

    if (result.blob) {
      return result.blob;
    }

    // If raw RGBA, convert to PNG blob for legacy callers
    // This shouldn't normally happen since renderTileWithFormat auto-selects format
    if (result.rgba) {
      // Copy to a regular ArrayBuffer to ensure compatibility with ImageData
      const rgbaArray = new Uint8ClampedArray(result.rgba.length);
      rgbaArray.set(result.rgba);
      const imageData = new ImageData(rgbaArray, result.width, result.height);
      const bitmap = await createImageBitmap(imageData);

      // Convert to blob using canvas (slower path, but maintains API compatibility)
      const canvas = document.createElement('canvas');
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to convert to blob'));
        }, 'image/png');
      });
    }

    throw new Error('No render data available');
  }

  /**
   * Render a tile with explicit format control
   *
   * @param pageNumber 1-indexed page number
   * @param tileX Tile X coordinate (0-indexed)
   * @param tileY Tile Y coordinate (0-indexed)
   * @param options Render options (scale, tileSize, format)
   * @returns RenderResult with either PNG blob or raw RGBA data
   */
  async renderTileWithFormat(
    pageNumber: number,
    tileX: number,
    tileY: number,
    options?: { scale?: number; tileSize?: number; format?: RenderFormat }
  ): Promise<TileRenderResult> {
    if (!this.bridge || !this.documentId) {
      throw new Error('No document loaded');
    }

    const scale = options?.scale ?? 2;
    const tileSize = options?.tileSize ?? 256;

    // Determine format: use provided format, or check feature flag for auto-selection
    const useRawRGBA = isFeatureEnabled('useRawRGBA');
    const format: RenderFormat = options?.format ?? (useRawRGBA ? 'rgba' : 'png');

    const startTime = performance.now();

    // Create pipeline timer for telemetry tracking
    const enableTelemetry = isFeatureEnabled('enablePipelineTelemetry');
    let timer: PipelineTimerBuilder | null = null;
    if (enableTelemetry) {
      const requestId = `tile-${pageNumber}-${tileX}-${tileY}-${Date.now()}`;
      timer = createPipelineTimer(requestId, {
        page: pageNumber,
        scale,
        tileX,
        tileY,
        transferFormat: format,
      });
    }

    // Note: Tile caching is handled by TileCacheManager at a higher level
    // This method just renders the tile

    const result = await this.bridge.renderTile(
      this.documentId,
      pageNumber,
      tileX,
      tileY,
      tileSize,
      scale,
      format
    );

    // Record worker timing if available
    if (timer && result.workerTiming) {
      timer
        .setStage('pageLoad', result.workerTiming.pageLoad)
        .setStage('render', result.workerTiming.render)
        .setStage('encode', result.workerTiming.encode);
    }

    // Record transfer time if available
    if (timer && result.transferTime !== undefined) {
      timer.setStage('transfer', result.transferTime);
    }

    // Process result based on format
    const decodeStart = performance.now();
    let renderResult: TileRenderResult;

    if (result.format === 'rgba') {
      // Raw RGBA - no decode needed, just wrap the data
      renderResult = {
        format: 'rgba',
        rgba: new Uint8Array(result.data),
        width: result.width,
        height: result.height,
      };
    } else {
      // PNG - convert to Blob
      const pngData = new Uint8Array(result.data);
      const blob = new Blob([pngData], { type: 'image/png' });
      renderResult = {
        format: 'png',
        blob,
        width: result.width,
        height: result.height,
      };
    }

    if (timer) {
      timer.setStage('decode', performance.now() - decodeStart);
    }

    // Finalize and record telemetry
    if (timer) {
      timer.complete();
    }

    if (this.config.debug) {
      console.log(
        `[WasmRenderer] Rendered tile (${pageNumber}, ${tileX}, ${tileY}) @ ${scale}x ` +
          `format=${format} (${result.width}x${result.height}) in ${(performance.now() - startTime).toFixed(1)}ms`
      );
    }

    return renderResult;
  }

  /**
   * Get the document ID (needed by RenderCoordinator)
   */
  getDocumentId(): string | null {
    return this.documentId;
  }

  /**
   * Get text layer with character positions
   *
   * @param pageNumber 1-indexed page number
   * @returns Text layer data compatible with existing text layer format
   */
  async getTextLayer(pageNumber: number): Promise<PdfTextLayerData> {
    if (!this.bridge || !this.documentId) {
      throw new Error('No document loaded');
    }

    // Check cache
    const cached = this.textLayerCache.get(pageNumber);
    if (cached) {
      return this.convertTextLayerData(cached);
    }

    const startTime = performance.now();
    const textLayer = await this.bridge.getTextLayer(this.documentId, pageNumber);

    // Cache for reuse
    this.textLayerCache.set(pageNumber, textLayer);

    if (this.config.debug) {
      console.log(
        `[WasmRenderer] Extracted text layer for page ${pageNumber} ` +
          `(${textLayer.items.length} items) in ${(performance.now() - startTime).toFixed(1)}ms`
      );
    }

    return this.convertTextLayerData(textLayer);
  }

  /**
   * Search document for text
   *
   * @param query Search query
   * @param maxHits Maximum number of results (default: 100)
   * @returns Search results with bounding boxes
   */
  async search(query: string, maxHits: number = 100): Promise<PdfSearchResult[]> {
    if (!this.bridge || !this.documentId) {
      throw new Error('No document loaded');
    }

    const startTime = performance.now();
    const results = await this.bridge.search(this.documentId, query, maxHits);

    if (this.config.debug) {
      console.log(
        `[WasmRenderer] Search "${query}" found ${results.length} results ` +
          `in ${(performance.now() - startTime).toFixed(1)}ms`
      );
    }

    return this.convertSearchResults(results);
  }

  /**
   * Get page dimensions at scale 1.0 (72 DPI)
   *
   * @param pageNumber 1-indexed page number
   * @returns Width and height in points
   */
  async getPageDimensions(pageNumber: number): Promise<{ width: number; height: number }> {
    if (!this.bridge || !this.documentId) {
      throw new Error('No document loaded');
    }

    return this.bridge.getPageDimensions(this.documentId, pageNumber);
  }

  /**
   * Get page count
   */
  getPageCount(): number {
    return this.pageCount;
  }

  /**
   * Check if a document is loaded
   */
  isDocumentLoaded(): boolean {
    return this.documentId !== null;
  }

  /**
   * Unload current document and free resources
   */
  async unloadDocument(): Promise<void> {
    if (this.bridge && this.documentId) {
      await this.bridge.unloadDocument(this.documentId);
    }

    this.documentId = null;
    this.pageCount = 0;
    this.clearCache();
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.pageCache.clear();
    this.textLayerCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { pageCount: number; textLayerCount: number } {
    let pageCount = 0;
    for (const scaleMap of this.pageCache.values()) {
      pageCount += scaleMap.size;
    }

    return {
      pageCount,
      textLayerCount: this.textLayerCache.size,
    };
  }

  /**
   * Destroy the renderer and release all resources
   */
  destroy(): void {
    this.clearCache();
    this.documentId = null;
    this.pageCount = 0;
    this.bridge = null;

    // Note: We don't destroy the shared bridge here since it may be used by other renderers
    // Call destroySharedMuPDFBridge() explicitly when done with all renderers
  }

  // Private methods

  /**
   * Get cached page if exists
   */
  private getCachedPage(pageNumber: number, scale: number): Blob | null {
    const scaleMap = this.pageCache.get(pageNumber);
    if (!scaleMap) return null;

    // Normalize scale for cache key (2 decimal places)
    const normalizedScale = Math.round(scale * 100) / 100;
    const cached = scaleMap.get(normalizedScale);

    return cached?.blob ?? null;
  }

  /**
   * Set cached page
   */
  private setCachedPage(pageNumber: number, scale: number, blob: Blob): void {
    // Enforce cache size limit by evicting oldest entries
    this.evictOldestIfNeeded();

    let scaleMap = this.pageCache.get(pageNumber);
    if (!scaleMap) {
      scaleMap = new Map();
      this.pageCache.set(pageNumber, scaleMap);
    }

    const normalizedScale = Math.round(scale * 100) / 100;
    scaleMap.set(normalizedScale, {
      blob,
      scale: normalizedScale,
      timestamp: Date.now(),
    });
  }

  /**
   * Evict oldest cache entries if over limit
   */
  private evictOldestIfNeeded(): void {
    // Count total cached pages
    let totalCached = 0;
    for (const scaleMap of this.pageCache.values()) {
      totalCached += scaleMap.size;
    }

    // Evict oldest while over limit
    while (totalCached >= this.config.cacheSize) {
      let oldestTime = Infinity;
      let oldestPage = -1;
      let oldestScale = -1;

      for (const [pageNum, scaleMap] of this.pageCache) {
        for (const [scale, cached] of scaleMap) {
          if (cached.timestamp < oldestTime) {
            oldestTime = cached.timestamp;
            oldestPage = pageNum;
            oldestScale = scale;
          }
        }
      }

      if (oldestPage >= 0) {
        const scaleMap = this.pageCache.get(oldestPage);
        if (scaleMap) {
          scaleMap.delete(oldestScale);
          if (scaleMap.size === 0) {
            this.pageCache.delete(oldestPage);
          }
        }
        totalCached--;
      } else {
        break;
      }
    }
  }

  /**
   * Convert MuPDF text layer to standard format
   */
  private convertTextLayerData(data: TextLayerData): PdfTextLayerData {
    return {
      page: data.pageNum,
      width: data.width,
      height: data.height,
      items: data.items.map((item) => ({
        text: item.text,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        fontSize: item.fontSize,
        // Add character-level positions
        charPositions: item.charPositions.map((char) => ({
          char: char.char,
          x: char.x,
          y: char.y,
          width: char.width,
          height: char.height,
          fontSize: char.fontSize,
          fontName: char.fontName,
        })),
      })),
    };
  }

  /**
   * Convert MuPDF search results to standard format
   */
  private convertSearchResults(results: SearchResult[]): PdfSearchResult[] {
    return results.map((result) => ({
      page: result.page,
      text: result.text,
      bounds: result.quads.map((quad) => ({
        x: quad.x,
        y: quad.y,
        width: quad.width,
        height: quad.height,
      })),
    }));
  }
}

/**
 * Singleton instance for shared use - use promise to prevent race conditions
 */
let sharedRendererPromise: Promise<WasmPdfRenderer> | null = null;
let sharedRendererInstance: WasmPdfRenderer | null = null;

/**
 * Get or create the shared WASM renderer instance.
 * Uses promise-based singleton to prevent race conditions when multiple
 * callers invoke this concurrently during initialization.
 */
export async function getSharedWasmRenderer(): Promise<WasmPdfRenderer> {
  if (!sharedRendererPromise) {
    sharedRendererPromise = (async () => {
      const renderer = new WasmPdfRenderer();
      await renderer.initialize();
      sharedRendererInstance = renderer;
      return renderer;
    })();
  }
  return sharedRendererPromise;
}

/**
 * Destroy the shared WASM renderer
 */
export function destroySharedWasmRenderer(): void {
  if (sharedRendererInstance) {
    sharedRendererInstance.destroy();
    sharedRendererInstance = null;
  }
  sharedRendererPromise = null;
  destroySharedMuPDFBridge();
}

/**
 * Factory function to create a WASM renderer
 */
export function createWasmRenderer(config?: WasmRendererConfig): WasmPdfRenderer {
  return new WasmPdfRenderer(config);
}

/**
 * Pooled MuPDF Bridge
 *
 * Adapter that wraps WorkerPoolManager with the same interface as MuPDFBridge.
 * This allows existing code to seamlessly use the worker pool without changes.
 *
 * The pool distributes rendering requests across multiple MuPDF WASM workers
 * for improved throughput (2-4x depending on worker count).
 */

import type { TocEntry, WorkerTiming, RenderFormat } from './mupdf-worker';
import {
  WorkerPoolManager,
  setWorkerPoolPluginPath,
  destroyWorkerPool,
  getWorkerPool,
} from './worker-pool-manager';
import { setMuPDFPluginPath, type IMuPDFBridge } from './mupdf-bridge';

// Re-export types for compatibility
export type { RenderFormat };

/**
 * Pooled MuPDF Bridge
 *
 * Drop-in replacement for MuPDFBridge that uses a worker pool for parallelism.
 * Implements the same API as MuPDFBridge for seamless integration.
 */
export class PooledMuPDFBridge implements IMuPDFBridge {
  private pool: WorkerPoolManager | null = null;
  private isReady = false;

  constructor() {
    // Pool is obtained lazily via getWorkerPool() singleton
    // This allows pre-warming to work correctly
  }

  /**
   * Initialize the worker pool
   * Uses the singleton pool (may be pre-warmed during plugin load)
   */
  async initialize(): Promise<void> {
    console.log('[PooledMuPDFBridge] initialize() called, isReady:', this.isReady);
    if (this.isReady && this.pool) return;

    console.log('[PooledMuPDFBridge] Getting singleton worker pool...');
    this.pool = await getWorkerPool();
    this.isReady = true;
    console.log('[PooledMuPDFBridge] Worker pool ready (singleton), worker count:', this.pool.getWorkerCount());
  }

  /**
   * Get the pool, throwing if not initialized
   */
  private getPool(): WorkerPoolManager {
    if (!this.pool) {
      throw new Error('[PooledMuPDFBridge] Pool not initialized. Call initialize() first.');
    }
    return this.pool;
  }

  /**
   * Load a PDF document from ArrayBuffer
   */
  async loadDocument(data: ArrayBuffer): Promise<{ pageCount: number; toc: TocEntry[] }> {
    const result = await this.getPool().loadDocument(data);
    return { pageCount: result.pageCount, toc: result.toc };
  }

  /**
   * Load a PDF document and return the document ID
   */
  async loadDocumentWithId(data: ArrayBuffer): Promise<{ id: string; pageCount: number; toc: TocEntry[] }> {
    return this.getPool().loadDocument(data);
  }

  /**
   * Render a page to PNG or raw RGBA
   */
  async renderPage(
    docId: string,
    pageNum: number,
    scale: number,
    format: RenderFormat = 'png'
  ): Promise<{
    data: Uint8Array;
    width: number;
    height: number;
    format: RenderFormat;
    workerTiming?: WorkerTiming;
    transferTime?: number;
  }> {
    const startTime = performance.now();
    const result = await this.getPool().renderPage(docId, pageNum, scale, format);

    // Calculate transfer time (approximate since pool handles routing)
    const totalTime = performance.now() - startTime;
    const workerTime = result.timing?.total ?? 0;
    const transferTime = Math.max(0, totalTime - workerTime);

    return {
      data: result.data,
      width: result.width,
      height: result.height,
      format: result.format,
      workerTiming: result.timing,
      transferTime,
    };
  }

  /**
   * Render a tile (256x256 region) of a page
   */
  async renderTile(
    docId: string,
    pageNum: number,
    tileX: number,
    tileY: number,
    tileSize: number,
    scale: number,
    format: RenderFormat = 'png'
  ): Promise<{
    data: Uint8Array;
    width: number;
    height: number;
    format: RenderFormat;
    workerTiming?: WorkerTiming;
    transferTime?: number;
  }> {
    const startTime = performance.now();
    const result = await this.getPool().renderTile(docId, pageNum, tileX, tileY, tileSize, scale, format);

    const totalTime = performance.now() - startTime;
    const workerTime = result.timing?.total ?? 0;
    const transferTime = Math.max(0, totalTime - workerTime);

    return {
      data: result.data,
      width: result.width,
      height: result.height,
      format: result.format,
      workerTiming: result.timing,
      transferTime,
    };
  }

  /**
   * Get text layer with character positions
   */
  async getTextLayer(docId: string, pageNum: number): Promise<import('./mupdf-worker').TextLayerData> {
    return this.getPool().getTextLayer(docId, pageNum);
  }

  /**
   * Search document for text
   */
  async search(docId: string, query: string, maxHits: number = 100): Promise<import('./mupdf-worker').SearchResult[]> {
    return this.getPool().search(docId, query, maxHits);
  }

  /**
   * Render multiple pages in batch across all workers
   * Distributes work evenly for maximum parallelism
   *
   * @param docId Document ID
   * @param pageNums Array of page numbers to render
   * @param scale Render scale
   * @param format Render format (png or rgba)
   * @param onProgress Optional progress callback
   * @returns Map of page number to render result
   */
  async renderPageBatch(
    docId: string,
    pageNums: number[],
    scale: number,
    format: RenderFormat = 'rgba',
    onProgress?: (completed: number, total: number, pageNum: number) => void
  ): Promise<Map<number, { data: Uint8Array; width: number; height: number; format: RenderFormat }>> {
    return this.getPool().renderPageBatch(docId, pageNums, scale, format, onProgress);
  }

  /**
   * Get page count for a loaded document
   */
  async getPageCount(docId: string): Promise<number> {
    return this.getPool().getPageCount(docId);
  }

  /**
   * Get page dimensions (at scale 1.0)
   */
  async getPageDimensions(docId: string, pageNum: number): Promise<{ width: number; height: number }> {
    return this.getPool().getPageDimensions(docId, pageNum);
  }

  /**
   * Unload a document from the worker pool
   */
  async unloadDocument(docId: string): Promise<void> {
    await this.getPool().unloadDocument(docId);
  }

  /**
   * Terminate the worker pool
   */
  terminate(): void {
    if (this.pool) {
      this.pool.terminate();
    }
    this.isReady = false;
  }

  /**
   * Check if pool is ready
   */
  get ready(): boolean {
    return this.isReady;
  }

  /**
   * Get worker pool statistics
   */
  getPoolStats() {
    return this.getPool().getStats();
  }

  /**
   * Get number of workers in the pool
   */
  getWorkerCount(): number {
    return this.getPool().getWorkerCount();
  }

  /**
   * Load document on all workers for maximum parallelism
   * Use when expecting heavy concurrent rendering
   */
  async loadDocumentOnAllWorkers(docId: string, data: ArrayBuffer): Promise<void> {
    await this.getPool().loadDocumentOnAllWorkers(docId, data);
  }

  // ============ Content-Type Detection API (Phase 5) ============

  /**
   * Classify a page's content type for optimized rendering.
   *
   * @see WorkerPoolManager.classifyPage for detailed documentation
   */
  async classifyPage(docId: string, pageNum: number): Promise<{
    type: string;
    confidence: number;
    classificationTimeMs: number;
    hasTransparency: boolean;
    pageNum: number;
    operatorCounts?: { text: number; path: number; image: number; graphicsState: number; color: number; clipping: number; total: number };
    images?: Array<{ name: string; width: number; height: number; filter: string; coveragePercent: number }>;
  }> {
    return this.getPool().classifyPage(docId, pageNum);
  }

  /**
   * Classify multiple pages in batch.
   *
   * @see WorkerPoolManager.classifyPages for detailed documentation
   */
  async classifyPages(docId: string, pageNums: number[]): Promise<Map<number, {
    type: string;
    confidence: number;
    classificationTimeMs: number;
    hasTransparency: boolean;
    pageNum: number;
  }>> {
    return this.getPool().classifyPages(docId, pageNums);
  }

  /**
   * Extract JPEG directly from a scanned page.
   *
   * @see WorkerPoolManager.extractJpeg for detailed documentation
   */
  async extractJpeg(docId: string, pageNum: number): Promise<{
    data: Uint8Array;
    width: number;
    height: number;
  }> {
    return this.getPool().extractJpeg(docId, pageNum);
  }
}

/**
 * Set the plugin path for the pooled bridge
 * This must be called before initializing the pool
 */
export function setPooledBridgePluginPath(vaultPath: string): void {
  // Set path for both single-worker bridge and pool
  setMuPDFPluginPath(vaultPath);
  setWorkerPoolPluginPath(vaultPath);
}

/**
 * Destroy the pooled bridge and clean up resources
 */
export function destroyPooledBridge(): void {
  destroyWorkerPool();
}

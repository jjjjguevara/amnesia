/**
 * Pooled Document Bridge
 *
 * Adapter that wraps DocumentWorkerPoolManager with the same interface as DocumentBridge.
 * This allows existing code to seamlessly use the worker pool without changes.
 *
 * The pool distributes rendering requests across multiple Document WASM workers
 * for improved throughput (2-4x depending on worker count).
 */

import type { ParsedDocument, StructuredText, SearchResult } from './document-worker';
import type { IDocumentBridge } from './document-bridge';
import {
  DocumentWorkerPoolManager,
  setDocumentWorkerPoolPluginPath,
  destroyDocumentWorkerPool,
} from './document-worker-pool-manager';
import { setDocumentPluginPath } from './document-bridge';

/**
 * Pooled Document Bridge
 *
 * Drop-in replacement for DocumentBridge that uses a worker pool for parallelism.
 * Implements the same API as DocumentBridge for seamless integration.
 */
export class PooledDocumentBridge implements IDocumentBridge {
  private pool: DocumentWorkerPoolManager;
  private isReady = false;

  constructor() {
    this.pool = new DocumentWorkerPoolManager();
  }

  /**
   * Initialize the worker pool
   */
  async initialize(): Promise<void> {
    console.log('[PooledDocumentBridge] initialize() called, isReady:', this.isReady);
    if (this.isReady) return;

    console.log('[PooledDocumentBridge] Initializing worker pool...');
    await this.pool.initialize();
    this.isReady = true;
    console.log('[PooledDocumentBridge] Worker pool ready, worker count:', this.pool.getWorkerCount());
  }

  /**
   * Load a document from ArrayBuffer
   * @param data Document bytes
   * @param filename Optional filename for format detection
   * @returns Parsed document metadata
   */
  async loadDocument(data: ArrayBuffer, filename?: string): Promise<ParsedDocument> {
    const result = await this.pool.loadDocument(data, filename);
    return result.document;
  }

  /**
   * Load a document and return both ID and metadata
   */
  async loadDocumentWithId(data: ArrayBuffer, filename?: string): Promise<{ id: string; document: ParsedDocument }> {
    return this.pool.loadDocument(data, filename);
  }

  /**
   * Render a document item (page or chapter) to PNG
   * @param docId Document ID
   * @param itemIndex 0-indexed item number
   * @param scale Render scale (1.0 = 72 DPI)
   */
  async renderItem(
    docId: string,
    itemIndex: number,
    scale: number
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    return this.pool.renderItem(docId, itemIndex, scale);
  }

  /**
   * Render a tile of a document item
   * @param docId Document ID
   * @param itemIndex 0-indexed item number
   * @param tileX Tile X coordinate (0-indexed)
   * @param tileY Tile Y coordinate (0-indexed)
   * @param tileSize Tile size in pixels
   * @param scale Render scale
   */
  async renderTile(
    docId: string,
    itemIndex: number,
    tileX: number,
    tileY: number,
    tileSize: number,
    scale: number
  ): Promise<{
    data: Uint8Array;
    width: number;
    height: number;
    workerTiming?: { pageLoad: number; render: number; encode: number; total: number };
    transferTime?: number;
  }> {
    return this.pool.renderTile(docId, itemIndex, tileX, tileY, tileSize, scale);
  }

  /**
   * Get structured text with character positions
   * @param docId Document ID
   * @param itemIndex 0-indexed item number
   */
  async getStructuredText(docId: string, itemIndex: number): Promise<StructuredText> {
    return this.pool.getStructuredText(docId, itemIndex);
  }

  /**
   * Search document for text
   * @param docId Document ID
   * @param query Search query
   * @param maxHits Maximum number of results
   * @param includeContext Whether to include prefix/suffix context
   */
  async search(
    docId: string,
    query: string,
    maxHits: number = 100,
    includeContext: boolean = false
  ): Promise<SearchResult[]> {
    return this.pool.search(docId, query, maxHits, includeContext);
  }

  /**
   * Get item count
   * @param docId Document ID
   */
  async getItemCount(docId: string): Promise<number> {
    return this.pool.getItemCount(docId);
  }

  /**
   * Get item dimensions (at scale 1.0)
   * @param docId Document ID
   * @param itemIndex 0-indexed item number
   */
  async getItemDimensions(
    docId: string,
    itemIndex: number
  ): Promise<{ width: number; height: number }> {
    return this.pool.getItemDimensions(docId, itemIndex);
  }

  /**
   * Get EPUB chapter XHTML content
   * @param docId Document ID (must be an EPUB)
   * @param chapterIndex 0-indexed chapter number
   */
  async getEpubChapter(docId: string, chapterIndex: number): Promise<string> {
    return this.pool.getEpubChapter(docId, chapterIndex);
  }

  /**
   * Unload a document from the worker pool
   * @param docId Document ID
   */
  async unloadDocument(docId: string): Promise<void> {
    await this.pool.unloadDocument(docId);
  }

  /**
   * Terminate the worker pool
   */
  terminate(): void {
    this.pool.terminate();
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
    return this.pool.getStats();
  }

  /**
   * Get number of workers in the pool
   */
  getWorkerCount(): number {
    return this.pool.getWorkerCount();
  }

  /**
   * Load document on all workers for maximum parallelism
   * Use when expecting heavy concurrent rendering
   */
  async loadDocumentOnAllWorkers(docId: string, data: ArrayBuffer, filename?: string): Promise<void> {
    await this.pool.loadDocumentOnAllWorkers(docId, data, filename);
  }
}

/**
 * Set the plugin path for the pooled bridge
 * This must be called before initializing the pool
 */
export function setPooledDocumentBridgePluginPath(vaultPath: string): void {
  // Set path for both single-worker bridge and pool
  setDocumentPluginPath(vaultPath);
  setDocumentWorkerPoolPluginPath(vaultPath);
}

/**
 * Destroy the pooled bridge and clean up resources
 */
export function destroyPooledDocumentBridge(): void {
  destroyDocumentWorkerPool();
}

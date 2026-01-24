/**
 * Document Bridge
 *
 * Main thread interface to the unified Document Web Worker.
 * Provides Promise-based API for document operations across PDF and EPUB formats.
 *
 * Features:
 * - Type-safe messaging with request/response correlation
 * - Automatic request deduplication
 * - Transferable support for efficient data passing
 * - Graceful error handling
 */

import type {
  DocumentWorkerRequest,
  DocumentWorkerResponse,
  ParsedDocument,
  StructuredText,
  SearchResult,
} from './document-worker';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  type: string;
};

// Static plugin path for worker loading - set by the plugin on startup
export let pluginBasePath: string | null = null;
let cachedWorkerBlobUrl: string | null = null;

/**
 * Set the plugin base path for loading workers.
 * Should be called once during plugin initialization with the vault path.
 */
export function setDocumentPluginPath(vaultPath: string): void {
  pluginBasePath = `${vaultPath}/.obsidian/plugins/amnesia`;
}

/**
 * Create a Blob URL from the worker file for cross-origin compatibility.
 * Obsidian runs on Electron with app:// origin, which can't load file:// workers directly.
 */
async function getWorkerBlobUrl(): Promise<string> {
  if (cachedWorkerBlobUrl) {
    return cachedWorkerBlobUrl;
  }

  if (!pluginBasePath) {
    throw new Error('Document worker path not configured. Call setDocumentPluginPath() first.');
  }

  // Use Node.js fs to read the pre-built worker file (available in Electron)
  const fs = window.require('fs') as typeof import('fs');
  const workerPath = `${pluginBasePath}/document-worker.js`;

  const workerCode = fs.readFileSync(workerPath, 'utf-8');
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  cachedWorkerBlobUrl = URL.createObjectURL(blob);

  return cachedWorkerBlobUrl;
}

/**
 * Interface for document bridge implementations.
 * Allows for different backends (single worker, worker pool, etc.)
 */
export interface IDocumentBridge {
  initialize(): Promise<void>;
  loadDocument(data: ArrayBuffer, filename?: string): Promise<ParsedDocument>;
  loadDocumentWithId(
    data: ArrayBuffer,
    filename?: string
  ): Promise<{ id: string; document: ParsedDocument }>;
  renderItem(
    docId: string,
    itemIndex: number,
    scale: number
  ): Promise<{ data: Uint8Array; width: number; height: number }>;
  renderTile(
    docId: string,
    itemIndex: number,
    tileX: number,
    tileY: number,
    tileSize: number,
    scale: number
  ): Promise<{ data: Uint8Array; width: number; height: number }>;
  getStructuredText(docId: string, itemIndex: number): Promise<StructuredText>;
  search(
    docId: string,
    query: string,
    maxHits?: number,
    includeContext?: boolean
  ): Promise<SearchResult[]>;
  getItemCount(docId: string): Promise<number>;
  getItemDimensions(
    docId: string,
    itemIndex: number
  ): Promise<{ width: number; height: number }>;
  getEpubChapter(docId: string, chapterIndex: number): Promise<string>;
  unloadDocument(docId: string): Promise<void>;
  terminate(): void;
  readonly ready: boolean;
}

/**
 * Bridge to communicate with Document Web Worker
 */
export class DocumentBridge implements IDocumentBridge {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestIdCounter = 0;
  private isReady = false;
  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;

  constructor() {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /**
   * Initialize the worker
   */
  async initialize(): Promise<void> {
    if (this.worker) {
      return this.readyPromise;
    }

    if (!pluginBasePath) {
      throw new Error('Document plugin path not configured. Call setDocumentPluginPath() first.');
    }

    // Read WASM binary from disk using Node.js fs (available in Electron)
    const fs = window.require('fs') as typeof import('fs');
    const wasmPath = `${pluginBasePath}/mupdf-wasm.wasm`;
    const wasmBinary = fs.readFileSync(wasmPath);

    // Create worker from Blob URL
    const workerUrl = await getWorkerBlobUrl();
    this.worker = new Worker(workerUrl, { type: 'module' });

    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);

    // Send WASM binary to worker
    this.worker.postMessage(
      { type: 'INIT_WASM', wasmBinary: wasmBinary },
      [wasmBinary.buffer]
    );

    return this.readyPromise;
  }

  /**
   * Handle messages from worker
   */
  private handleMessage(event: MessageEvent<DocumentWorkerResponse | { type: 'READY' }>): void {
    const response = event.data;

    // Handle ready signal
    if (response.type === 'READY') {
      this.isReady = true;
      this.readyResolve?.();
      this.readyResolve = null; // Clear to prevent memory leak
      return;
    }

    // Handle response with requestId
    if ('requestId' in response) {
      const pending = this.pendingRequests.get(response.requestId);
      if (!pending) {
        console.warn('[Document Bridge] No pending request for ID:', response.requestId);
        return;
      }

      this.pendingRequests.delete(response.requestId);

      // Check for error responses
      if (this.isErrorResponse(response)) {
        pending.reject(new Error((response as { error: string }).error));
        return;
      }

      pending.resolve(response);
    }
  }

  /**
   * Check if response is an error type
   */
  private isErrorResponse(response: DocumentWorkerResponse): boolean {
    return (
      response.type === 'LOAD_ERROR' ||
      response.type === 'RENDER_ERROR' ||
      response.type === 'TILE_RENDER_ERROR' ||
      response.type === 'STRUCTURED_TEXT_ERROR' ||
      response.type === 'SEARCH_ERROR' ||
      response.type === 'ITEM_COUNT_ERROR' ||
      response.type === 'ITEM_DIMENSIONS_ERROR' ||
      response.type === 'EPUB_CHAPTER_ERROR' ||
      response.type === 'UNLOAD_ERROR'
    );
  }

  /**
   * Handle worker errors
   */
  private handleError(event: ErrorEvent): void {
    console.error('[Document Bridge] Worker error:', event.message);

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error(`Worker error: ${event.message}`));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    return `req-${++this.requestIdCounter}`;
  }

  /**
   * Send a request to the worker and wait for response
   */
  private async sendRequest<T>(
    request: DocumentWorkerRequest,
    transferables?: Transferable[]
  ): Promise<T> {
    if (!this.worker) {
      throw new Error('Worker not initialized. Call initialize() first.');
    }

    await this.readyPromise;

    const requestId = request.requestId;

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        type: request.type,
      });

      if (transferables?.length) {
        this.worker!.postMessage(request, transferables);
      } else {
        this.worker!.postMessage(request);
      }
    });
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Load a document from ArrayBuffer
   * @param data Document bytes
   * @param filename Optional filename for format detection
   * @returns Parsed document metadata
   */
  async loadDocument(data: ArrayBuffer, filename?: string): Promise<ParsedDocument> {
    const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'LOADED';
      requestId: string;
      document: ParsedDocument;
    }>(
      { type: 'LOAD_DOCUMENT', requestId, docId, data, filename },
      [data]
    );

    return response.document;
  }

  /**
   * Load a document and return both ID and metadata
   */
  async loadDocumentWithId(
    data: ArrayBuffer,
    filename?: string
  ): Promise<{ id: string; document: ParsedDocument }> {
    const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'LOADED';
      requestId: string;
      document: ParsedDocument;
    }>(
      { type: 'LOAD_DOCUMENT', requestId, docId, data, filename },
      [data]
    );

    return { id: docId, document: response.document };
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
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'ITEM_RENDERED';
      requestId: string;
      itemIndex: number;
      data: Uint8Array;
      width: number;
      height: number;
    }>({ type: 'RENDER_ITEM', requestId, docId, itemIndex, scale });

    return {
      data: response.data,
      width: response.width,
      height: response.height,
    };
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
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'TILE_RENDERED';
      requestId: string;
      itemIndex: number;
      tileX: number;
      tileY: number;
      data: Uint8Array;
      width: number;
      height: number;
    }>({
      type: 'RENDER_TILE',
      requestId,
      docId,
      itemIndex,
      tileX,
      tileY,
      tileSize,
      scale,
    });

    return {
      data: response.data,
      width: response.width,
      height: response.height,
    };
  }

  /**
   * Get structured text with character positions
   * @param docId Document ID
   * @param itemIndex 0-indexed item number
   */
  async getStructuredText(docId: string, itemIndex: number): Promise<StructuredText> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'STRUCTURED_TEXT';
      requestId: string;
      itemIndex: number;
      data: StructuredText;
    }>({ type: 'GET_STRUCTURED_TEXT', requestId, docId, itemIndex });

    return response.data;
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
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'SEARCH_RESULTS';
      requestId: string;
      results: SearchResult[];
    }>({ type: 'SEARCH', requestId, docId, query, maxHits, includeContext });

    return response.results;
  }

  /**
   * Get item count
   * @param docId Document ID
   */
  async getItemCount(docId: string): Promise<number> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'ITEM_COUNT';
      requestId: string;
      itemCount: number;
    }>({ type: 'GET_ITEM_COUNT', requestId, docId });

    return response.itemCount;
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
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'ITEM_DIMENSIONS';
      requestId: string;
      itemIndex: number;
      width: number;
      height: number;
    }>({ type: 'GET_ITEM_DIMENSIONS', requestId, docId, itemIndex });

    return { width: response.width, height: response.height };
  }

  /**
   * Get EPUB chapter XHTML content
   * @param docId Document ID (must be an EPUB)
   * @param chapterIndex 0-indexed chapter number
   */
  async getEpubChapter(docId: string, chapterIndex: number): Promise<string> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'EPUB_CHAPTER';
      requestId: string;
      chapterIndex: number;
      xhtml: string;
    }>({ type: 'GET_EPUB_CHAPTER', requestId, docId, chapterIndex });

    return response.xhtml;
  }

  /**
   * Unload a document from the worker
   * @param docId Document ID
   */
  async unloadDocument(docId: string): Promise<void> {
    const requestId = this.generateRequestId();

    await this.sendRequest<{ type: 'DOCUMENT_UNLOADED'; requestId: string }>({
      type: 'UNLOAD_DOCUMENT',
      requestId,
      docId,
    });
  }

  /**
   * Terminate the worker
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isReady = false;
      this.pendingRequests.clear();
    }
  }

  /**
   * Check if worker is ready
   */
  get ready(): boolean {
    return this.isReady;
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

let sharedBridgePromise: Promise<DocumentBridge> | null = null;
let sharedBridgeInstance: DocumentBridge | null = null;

/**
 * Get or create the shared Document bridge instance.
 * Uses promise-based singleton to prevent race conditions.
 */
export async function getSharedDocumentBridge(): Promise<DocumentBridge> {
  if (!sharedBridgePromise) {
    sharedBridgePromise = (async () => {
      const bridge = new DocumentBridge();
      await bridge.initialize();
      sharedBridgeInstance = bridge;
      return bridge;
    })();
  }
  return sharedBridgePromise;
}

/**
 * Destroy the shared bridge instance
 */
export function destroySharedDocumentBridge(): void {
  if (sharedBridgeInstance) {
    sharedBridgeInstance.terminate();
    sharedBridgeInstance = null;
  }
  sharedBridgePromise = null;
}

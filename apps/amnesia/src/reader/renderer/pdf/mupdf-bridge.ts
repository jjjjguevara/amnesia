/**
 * MuPDF Bridge
 *
 * Main thread interface to the MuPDF Web Worker.
 * Provides Promise-based API for PDF operations.
 */

import type {
  WorkerRequest,
  WorkerResponse,
  TextLayerData,
  SearchResult,
  TocEntry,
  WorkerTiming,
  RenderFormat,
  SharedBufferSlot,
} from './mupdf-worker';
import { getSharedBufferPool, type SharedBufferPool, type BufferSlot } from './shared-buffer-pool';
import { isFeatureEnabled } from './feature-flags';

export type { RenderFormat };

/**
 * Common interface for MuPDF bridge implementations.
 * Both MuPDFBridge and PooledMuPDFBridge implement this interface,
 * allowing transparent switching between single-worker and multi-worker modes.
 */
export interface IMuPDFBridge {
  initialize(): Promise<void>;
  loadDocument(data: ArrayBuffer): Promise<{ pageCount: number; toc: TocEntry[] }>;
  loadDocumentWithId(data: ArrayBuffer): Promise<{ id: string; pageCount: number; toc: TocEntry[] }>;
  renderPage(
    docId: string,
    pageNum: number,
    scale: number,
    format?: RenderFormat
  ): Promise<{
    data: Uint8Array;
    width: number;
    height: number;
    format: RenderFormat;
    workerTiming?: WorkerTiming;
    transferTime?: number;
  }>;
  renderTile(
    docId: string,
    pageNum: number,
    tileX: number,
    tileY: number,
    tileSize: number,
    scale: number,
    format?: RenderFormat
  ): Promise<{
    data: Uint8Array;
    width: number;
    height: number;
    format: RenderFormat;
    workerTiming?: WorkerTiming;
    transferTime?: number;
  }>;
  getTextLayer(docId: string, pageNum: number): Promise<TextLayerData>;
  search(docId: string, query: string, maxHits?: number): Promise<SearchResult[]>;
  getPageCount(docId: string): Promise<number>;
  getPageDimensions(docId: string, pageNum: number): Promise<{ width: number; height: number }>;
  unloadDocument(docId: string): Promise<void>;
  terminate(): void;
  readonly ready: boolean;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  type: string;
};

// Static plugin path for worker loading - set by the plugin on startup
let pluginBasePath: string | null = null;
let cachedWorkerBlobUrl: string | null = null;

/**
 * Set the plugin base path for loading workers.
 * Should be called once during plugin initialization with the vault path.
 */
export function setMuPDFPluginPath(vaultPath: string): void {
  pluginBasePath = `${vaultPath}/.obsidian/plugins/amnesia`;
}

/**
 * Create a Blob URL from the worker file for cross-origin compatibility.
 * Obsidian runs on Electron with app:// origin, which can't load file:// workers directly.
 * The pre-built worker already has all necessary initialization code from esbuild.
 */
async function getWorkerBlobUrl(): Promise<string> {
  if (cachedWorkerBlobUrl) {
    return cachedWorkerBlobUrl;
  }

  if (!pluginBasePath) {
    throw new Error('MuPDF worker path not configured. Call setMuPDFPluginPath() first.');
  }

  // Use Node.js fs to read the pre-built worker file (available in Electron)
  const fs = window.require('fs') as typeof import('fs');
  const workerPath = `${pluginBasePath}/mupdf-worker.js`;

  // Read the pre-built worker - don't modify it, esbuild already set up initialization
  const workerCode = fs.readFileSync(workerPath, 'utf-8');
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  cachedWorkerBlobUrl = URL.createObjectURL(blob);

  return cachedWorkerBlobUrl;
}

/**
 * Bridge to communicate with MuPDF Web Worker
 */
export class MuPDFBridge implements IMuPDFBridge {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestIdCounter = 0;
  private isReady = false;
  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  /** SharedArrayBuffer pool for zero-copy transfer */
  private sharedBufferPool: SharedBufferPool | null = null;
  /** Whether SAB is enabled and initialized */
  private sabEnabled = false;

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
      throw new Error('MuPDF plugin path not configured. Call setMuPDFPluginPath() first.');
    }

    // Read WASM binary from disk using Node.js fs (available in Electron main thread)
    const fs = window.require('fs') as typeof import('fs');
    const wasmPath = `${pluginBasePath}/mupdf-wasm.wasm`;
    const wasmBinaryBuffer = fs.readFileSync(wasmPath);

    // Convert Node.js Buffer to ArrayBuffer (ensure it's a proper ArrayBuffer, not SharedArrayBuffer)
    const wasmArrayBuffer = new ArrayBuffer(wasmBinaryBuffer.length);
    new Uint8Array(wasmArrayBuffer).set(new Uint8Array(wasmBinaryBuffer.buffer, wasmBinaryBuffer.byteOffset, wasmBinaryBuffer.byteLength));

    // Pre-compile WASM module for faster worker initialization
    // Saves 400-800ms by doing compilation once on main thread
    let wasmModule: WebAssembly.Module | undefined;
    try {
      const compileStart = performance.now();
      wasmModule = await WebAssembly.compile(wasmArrayBuffer);
      console.log(`[MuPDFBridge] WASM module compiled in ${(performance.now() - compileStart).toFixed(1)}ms`);
    } catch (err) {
      console.warn('[MuPDFBridge] WASM pre-compilation failed, falling back to worker compilation:', err);
    }

    // Create worker from Blob URL (required for cross-origin in Obsidian/Electron)
    const workerUrl = await getWorkerBlobUrl();

    // Use module worker for ESM format with top-level await support
    this.worker = new Worker(workerUrl, { type: 'module' });

    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);

    // Send WASM module and/or binary to worker
    // Try with pre-compiled module first (saves 400-800ms)
    // Fall back to binary-only if Module cloning fails (Electron compatibility)
    const wasmBinaryCopy = wasmArrayBuffer.slice(0);

    if (wasmModule) {
      try {
        const initMessage = {
          type: 'INIT_WASM',
          wasmBinary: wasmBinaryCopy,
          wasmModule: wasmModule,
        };
        this.worker.postMessage(initMessage, [wasmBinaryCopy]);
        console.log('[MuPDFBridge] Sent WASM module + binary to worker');
      } catch (err) {
        // WebAssembly.Module may not be cloneable in some Electron versions
        console.warn('[MuPDFBridge] Module cloning failed, falling back to binary:', err);
        // Need fresh copy since the first one was transferred (or invalidated)
        const fallbackCopy = wasmArrayBuffer.slice(0);
        const fallbackMessage = {
          type: 'INIT_WASM',
          wasmBinary: fallbackCopy,
        };
        this.worker.postMessage(fallbackMessage, [fallbackCopy]);
      }
    } else {
      const initMessage = {
        type: 'INIT_WASM',
        wasmBinary: wasmBinaryCopy,
      };
      this.worker.postMessage(initMessage, [wasmBinaryCopy]);
      console.log('[MuPDFBridge] Sent WASM binary to worker (no pre-compiled module)');
    }

    // Wait for worker to be ready before initializing SharedArrayBuffer
    await this.readyPromise;

    // Initialize SharedArrayBuffer pool if enabled
    await this.initializeSharedBuffers();
  }

  /**
   * Initialize SharedArrayBuffer pool and send references to worker
   */
  private async initializeSharedBuffers(): Promise<void> {
    // Check if SharedArrayBuffer is enabled
    if (!isFeatureEnabled('useSharedArrayBuffer')) {
      console.log('[MuPDFBridge] SharedArrayBuffer disabled by feature flag');
      return;
    }

    try {
      this.sharedBufferPool = getSharedBufferPool();

      if (!this.sharedBufferPool.isSharedArrayBufferEnabled()) {
        console.log('[MuPDFBridge] SharedArrayBuffer not available (fallback mode)');
        return;
      }

      // Get buffer references to send to worker
      const bufferRefs = this.sharedBufferPool.getBufferReferences();
      if (!bufferRefs) {
        console.log('[MuPDFBridge] No SharedArrayBuffer references available');
        return;
      }

      // Flatten buffer references for message passing
      const buffers: Array<{ tierSize: number; buffer: SharedArrayBuffer }> = [];
      for (const [tierSize, tierBuffers] of bufferRefs) {
        for (const buffer of tierBuffers) {
          buffers.push({ tierSize, buffer });
        }
      }

      if (buffers.length === 0) {
        console.log('[MuPDFBridge] No SharedArrayBuffer slots available');
        return;
      }

      // Send INIT_SHARED_BUFFERS to worker
      const requestId = this.generateRequestId();
      const response = await this.sendRequest<{
        type: 'SHARED_BUFFERS_INITIALIZED';
        requestId: string;
        success: boolean;
        tierSizes: number[];
      }>({
        type: 'INIT_SHARED_BUFFERS',
        requestId,
        buffers,
      } as WorkerRequest);

      this.sabEnabled = response.success;
      console.log(
        `[MuPDFBridge] SharedArrayBuffer initialized: ${response.success}, ` +
        `tiers: ${response.tierSizes.join(', ')}`
      );
    } catch (err) {
      console.error('[MuPDFBridge] Failed to initialize SharedArrayBuffer:', err);
      this.sabEnabled = false;
    }
  }

  /**
   * Handle messages from worker
   */
  private handleMessage(event: MessageEvent<WorkerResponse | { type: 'READY' }>): void {
    const response = event.data;

    // Handle ready signal
    if (response.type === 'READY') {
      this.isReady = true;
      this.readyResolve?.();
      return;
    }

    // Handle response with requestId
    if ('requestId' in response) {
      const pending = this.pendingRequests.get(response.requestId);
      if (!pending) {
        console.warn('[MuPDF Bridge] No pending request for ID:', response.requestId);
        return;
      }

      this.pendingRequests.delete(response.requestId);

      // Check for error responses
      if (
        response.type === 'LOAD_ERROR' ||
        response.type === 'RENDER_ERROR' ||
        response.type === 'TILE_RENDER_ERROR' ||
        response.type === 'TEXT_LAYER_ERROR' ||
        response.type === 'SEARCH_ERROR' ||
        response.type === 'PAGE_COUNT_ERROR' ||
        response.type === 'PAGE_DIMENSIONS_ERROR' ||
        response.type === 'UNLOAD_ERROR'
      ) {
        pending.reject(new Error((response as { error: string }).error));
        return;
      }

      pending.resolve(response);
    }
  }

  /**
   * Handle worker errors
   */
  private handleError(event: ErrorEvent): void {
    console.error('[MuPDF Bridge] Worker error:', event.message);

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
    request: WorkerRequest,
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

  /**
   * Load a PDF document from ArrayBuffer
   */
  async loadDocument(data: ArrayBuffer): Promise<{ pageCount: number; toc: TocEntry[] }> {
    // Generate a document ID
    const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'LOADED';
      requestId: string;
      pageCount: number;
      toc: TocEntry[];
    }>(
      { type: 'LOAD_DOCUMENT', requestId, docId, data },
      [data] // Transfer ArrayBuffer ownership
    );

    return { pageCount: response.pageCount, toc: response.toc };
  }

  /**
   * Load a PDF document and return the document ID
   */
  async loadDocumentWithId(data: ArrayBuffer): Promise<{ id: string; pageCount: number; toc: TocEntry[] }> {
    const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'LOADED';
      requestId: string;
      pageCount: number;
      toc: TocEntry[];
    }>(
      { type: 'LOAD_DOCUMENT', requestId, docId, data },
      [data]
    );

    return { id: docId, pageCount: response.pageCount, toc: response.toc };
  }

  /**
   * Render a page to PNG or raw RGBA
   * @param docId Document ID from loadDocumentWithId
   * @param pageNum 1-indexed page number
   * @param scale Render scale (1.0 = 72 DPI)
   * @param format Output format: 'png' (compressed) or 'rgba' (raw pixels, faster)
   */
  async renderPage(
    docId: string,
    pageNum: number,
    scale: number,
    format: RenderFormat = 'png'
  ): Promise<{ data: Uint8Array; width: number; height: number; format: RenderFormat; workerTiming?: WorkerTiming; transferTime?: number }> {
    const requestId = this.generateRequestId();
    const sendTime = performance.now();

    const response = await this.sendRequest<{
      type: 'PAGE_RENDERED';
      requestId: string;
      pageNum: number;
      data: Uint8Array;
      width: number;
      height: number;
      format: RenderFormat;
      timing?: WorkerTiming;
    }>({ type: 'RENDER_PAGE', requestId, docId, pageNum, scale, format });

    const receiveTime = performance.now();
    // Transfer time = round-trip - worker processing time
    const transferTime = response.timing
      ? (receiveTime - sendTime) - response.timing.total
      : receiveTime - sendTime;

    return {
      data: response.data,
      width: response.width,
      height: response.height,
      format: response.format,
      workerTiming: response.timing,
      transferTime: Math.max(0, transferTime),
    };
  }

  /**
   * Get text layer with character positions
   * @param docId Document ID
   * @param pageNum 1-indexed page number
   */
  async getTextLayer(docId: string, pageNum: number): Promise<TextLayerData> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'TEXT_LAYER';
      requestId: string;
      pageNum: number;
      data: TextLayerData;
    }>({ type: 'GET_TEXT_LAYER', requestId, docId, pageNum });

    return response.data;
  }

  /**
   * Search document for text
   * @param docId Document ID
   * @param query Search query
   * @param maxHits Maximum number of results
   */
  async search(docId: string, query: string, maxHits: number = 100): Promise<SearchResult[]> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'SEARCH_RESULTS';
      requestId: string;
      results: SearchResult[];
    }>({ type: 'SEARCH', requestId, docId, query, maxHits });

    return response.results;
  }

  /**
   * Get page count for a loaded document
   * @param docId Document ID
   */
  async getPageCount(docId: string): Promise<number> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'PAGE_COUNT';
      requestId: string;
      pageCount: number;
    }>({ type: 'GET_PAGE_COUNT', requestId, docId });

    return response.pageCount;
  }

  /**
   * Get page dimensions (at scale 1.0)
   * @param docId Document ID
   * @param pageNum 1-indexed page number
   */
  async getPageDimensions(
    docId: string,
    pageNum: number
  ): Promise<{ width: number; height: number }> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'PAGE_DIMENSIONS';
      requestId: string;
      pageNum: number;
      width: number;
      height: number;
    }>({ type: 'GET_PAGE_DIMENSIONS', requestId, docId, pageNum });

    return { width: response.width, height: response.height };
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
   * Render a tile (256x256 region) of a page
   * @param docId Document ID from loadDocumentWithId
   * @param pageNum 1-indexed page number
   * @param tileX Tile X coordinate (0-indexed)
   * @param tileY Tile Y coordinate (0-indexed)
   * @param tileSize Tile size in pixels (typically 256)
   * @param scale Render scale (1.0 = 72 DPI, 2.0 = 144 DPI for retina)
   * @param format Output format: 'png' (compressed) or 'rgba' (raw pixels, faster)
   */
  async renderTile(
    docId: string,
    pageNum: number,
    tileX: number,
    tileY: number,
    tileSize: number,
    scale: number,
    format: RenderFormat = 'png'
  ): Promise<{ data: Uint8Array; width: number; height: number; format: RenderFormat; workerTiming?: WorkerTiming; transferTime?: number }> {
    const requestId = this.generateRequestId();
    const sendTime = performance.now();

    // Try to use SharedArrayBuffer for RGBA format if enabled
    let acquiredSlot: BufferSlot | null = null;
    let sharedSlot: SharedBufferSlot | undefined;

    if (this.sabEnabled && this.sharedBufferPool && format === 'rgba') {
      // Calculate required buffer size for tile
      const scaledTileSize = Math.ceil(tileSize * scale);
      const requiredSize = scaledTileSize * scaledTileSize * 4; // RGBA

      acquiredSlot = this.sharedBufferPool.acquire(requiredSize);
      if (acquiredSlot && acquiredSlot.isShared) {
        sharedSlot = {
          tierSize: acquiredSlot.size,
          index: acquiredSlot.index,
        };
      } else if (acquiredSlot) {
        // Got fallback buffer, not shared - release it
        this.sharedBufferPool.release(acquiredSlot);
        acquiredSlot = null;
      }
    }

    try {
      // Build request with optional shared buffer slot
      const request: WorkerRequest = {
        type: 'RENDER_TILE',
        requestId,
        docId,
        pageNum,
        tileX,
        tileY,
        tileSize,
        scale,
        format,
        ...(sharedSlot && { sharedSlot }),
      } as WorkerRequest;

      const response = await this.sendRequest<{
        type: 'TILE_RENDERED' | 'TILE_RENDERED_SHARED';
        requestId: string;
        pageNum: number;
        tileX: number;
        tileY: number;
        data?: Uint8Array;
        dataLength?: number;
        sharedSlot?: SharedBufferSlot;
        width: number;
        height: number;
        format: RenderFormat;
        timing?: WorkerTiming;
        usedSharedBuffer?: boolean;
      }>(request);

      const receiveTime = performance.now();
      // Transfer time = round-trip - worker processing time
      const transferTime = response.timing
        ? (receiveTime - sendTime) - response.timing.total
        : receiveTime - sendTime;

      // Handle shared buffer response
      let data: Uint8Array;
      if (response.type === 'TILE_RENDERED_SHARED' && response.usedSharedBuffer && acquiredSlot) {
        // Read data from shared buffer
        // We must copy before releasing the slot, but we still save the transfer copy
        const dataLength = response.dataLength ?? (response.width * response.height * 4);
        const sourceView = new Uint8Array(acquiredSlot.view.buffer, acquiredSlot.view.byteOffset, dataLength);
        data = new Uint8Array(dataLength);
        data.set(sourceView);
        // Note: The benefit of SAB is we avoided the structured clone during message transfer
        // We still need one copy here, but it's faster than the MessagePort serialization
      } else if (response.data) {
        // Standard response with data
        data = response.data;
      } else {
        throw new Error('No tile data received');
      }

      return {
        data,
        width: response.width,
        height: response.height,
        format: response.format,
        workerTiming: response.timing,
        transferTime: Math.max(0, transferTime),
      };
    } finally {
      // Always release the slot after use
      if (acquiredSlot && this.sharedBufferPool) {
        this.sharedBufferPool.release(acquiredSlot);
      }
    }
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

// Singleton instance for shared use - use promise to prevent race conditions
let sharedBridgePromise: Promise<IMuPDFBridge> | null = null;
let sharedBridgeInstance: IMuPDFBridge | null = null;

/**
 * Get or create the shared MuPDF bridge instance.
 * Uses promise-based singleton to prevent race conditions when multiple
 * callers invoke this concurrently during initialization.
 *
 * When workerCount > 1, returns a PooledMuPDFBridge that distributes
 * requests across multiple workers for improved throughput.
 */
export async function getSharedMuPDFBridge(): Promise<IMuPDFBridge> {
  console.log('[MuPDFBridge] getSharedMuPDFBridge() called, promise exists:', !!sharedBridgePromise);
  if (!sharedBridgePromise) {
    sharedBridgePromise = (async () => {
      console.log('[MuPDFBridge] Creating new bridge...');
      // Check if we should use the worker pool
      const { getFeatureFlags } = await import('./feature-flags');
      const flags = getFeatureFlags();
      const resolved = flags.resolveFlags();
      const workerCount = resolved.workerCount;
      console.log('[MuPDFBridge] Feature flags resolved, workerCount:', workerCount);

      if (workerCount > 1) {
        // Use pooled bridge for multi-worker mode
        const { PooledMuPDFBridge } = await import('./pooled-mupdf-bridge');
        const pooledBridge = new PooledMuPDFBridge();
        await pooledBridge.initialize();
        sharedBridgeInstance = pooledBridge;
        console.log(`[MuPDFBridge] Using pooled bridge with ${workerCount} workers`);
        return pooledBridge;
      }

      // Single worker mode - use standard bridge
      const bridge = new MuPDFBridge();
      await bridge.initialize();
      sharedBridgeInstance = bridge;
      console.log('[MuPDFBridge] Using single-worker bridge');
      return bridge;
    })();
  }
  return sharedBridgePromise;
}

/**
 * Destroy the shared bridge instance
 */
export function destroySharedMuPDFBridge(): void {
  if (sharedBridgeInstance) {
    sharedBridgeInstance.terminate();
    sharedBridgeInstance = null;
  }
  sharedBridgePromise = null;

  // Clean up Blob URL to prevent memory leak
  if (cachedWorkerBlobUrl) {
    URL.revokeObjectURL(cachedWorkerBlobUrl);
    cachedWorkerBlobUrl = null;
    console.log('[MuPDFBridge] Worker Blob URL revoked');
  }
}

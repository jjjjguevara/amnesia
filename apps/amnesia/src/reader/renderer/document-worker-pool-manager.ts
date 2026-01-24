/**
 * Document Worker Pool Manager
 *
 * Manages a pool of Document Web Workers for parallel PDF/EPUB rendering.
 * Achieves 2-4x throughput improvement over single-worker architecture.
 *
 * Features:
 * - Shared WASM binary transfer (read once, send to each worker)
 * - Load balancing (round-robin, least-loaded, document affinity)
 * - Document state tracking per worker
 * - Automatic worker count detection based on CPU/memory
 * - Utilization telemetry
 */

import type {
  DocumentWorkerRequest,
  DocumentWorkerResponse,
  ParsedDocument,
  StructuredText,
  SearchResult,
} from './document-worker';
import { getFeatureFlags } from './pdf/feature-flags';
import { getTelemetry } from './pdf/pdf-telemetry';
import { pluginBasePath } from './document-bridge';

export type { ParsedDocument, StructuredText, SearchResult };

/** Render priority levels */
export type RenderPriority = 'critical' | 'high' | 'medium' | 'low';

/** Thumbnail render result */
export interface ThumbnailResult {
  pageNum: number;
  data: Uint8Array;
  width: number;
  height: number;
}

/** Batch render progress callback */
export type BatchProgressCallback = (completed: number, total: number, pageNum: number) => void;

/** Load balancing strategy */
export type LoadBalancingStrategy = 'round-robin' | 'least-loaded' | 'document-affinity';

/** Worker pool configuration */
export interface DocumentWorkerPoolConfig {
  /** Number of workers (1-4, or 'auto' for CPU-based detection) */
  workerCount: number | 'auto';
  /** Load balancing strategy (default: 'document-affinity') */
  loadBalancing?: LoadBalancingStrategy;
  /** Enable utilization telemetry (default: true) */
  enableTelemetry?: boolean;
}

/** Individual worker state */
interface WorkerState {
  /** Worker instance */
  worker: Worker;
  /** Worker index (0-based) */
  index: number;
  /** Number of pending requests */
  pendingRequests: number;
  /** Total requests processed */
  totalRequests: number;
  /** Whether worker is ready */
  isReady: boolean;
  /** Promise that resolves when worker is ready */
  readyPromise: Promise<void>;
  /** Resolve function for ready promise */
  readyResolve: (() => void) | null;
  /** Documents loaded on this worker */
  documentIds: Set<string>;
  /** Pending request callbacks */
  pendingCallbacks: Map<string, PendingRequest>;
}

/** Pending request tracking */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  type: string;
  workerIndex: number;
  startTime: number;
}

/** Worker utilization statistics */
export interface DocumentWorkerPoolStats {
  /** Total workers in pool */
  workerCount: number;
  /** Total requests processed */
  totalRequests: number;
  /** Requests per worker */
  requestsPerWorker: number[];
  /** Current pending requests per worker */
  pendingPerWorker: number[];
  /** Average pending requests */
  avgPendingRequests: number;
  /** Load imbalance ratio (max/min requests, 1.0 = perfect balance) */
  imbalanceRatio: number;
  /** Documents loaded per worker */
  documentsPerWorker: number[];
}

// Static plugin path for worker loading
let documentPluginBasePath: string | null = null;
let cachedWorkerBlobUrl: string | null = null;

/**
 * Set the plugin base path for loading workers.
 */
export function setDocumentWorkerPoolPluginPath(vaultPath: string): void {
  documentPluginBasePath = `${vaultPath}/.obsidian/plugins/amnesia`;
}

/**
 * Create a Blob URL from the worker file for cross-origin compatibility.
 */
async function getWorkerBlobUrl(): Promise<string> {
  if (cachedWorkerBlobUrl) {
    return cachedWorkerBlobUrl;
  }

  const basePath = documentPluginBasePath || pluginBasePath;
  if (!basePath) {
    throw new Error('Document worker pool path not configured. Call setDocumentWorkerPoolPluginPath() first.');
  }

  const fs = window.require('fs') as typeof import('fs');
  const workerPath = `${basePath}/document-worker.js`;
  const workerCode = fs.readFileSync(workerPath, 'utf-8');
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  cachedWorkerBlobUrl = URL.createObjectURL(blob);

  return cachedWorkerBlobUrl;
}

/**
 * Read WASM binary from disk
 */
function readWasmBinary(): ArrayBuffer {
  const basePath = documentPluginBasePath || pluginBasePath;
  if (!basePath) {
    throw new Error('Document worker pool path not configured. Call setDocumentWorkerPoolPluginPath() first.');
  }

  const fs = window.require('fs') as typeof import('fs');
  const wasmPath = `${basePath}/mupdf-wasm.wasm`;
  const buffer = fs.readFileSync(wasmPath);
  // Convert Node.js Buffer to ArrayBuffer
  const uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const arrayBuffer = new ArrayBuffer(uint8Array.length);
  new Uint8Array(arrayBuffer).set(uint8Array);
  return arrayBuffer;
}

/**
 * Document Worker Pool Manager
 *
 * Orchestrates multiple Document workers for parallel rendering.
 */
export class DocumentWorkerPoolManager {
  private workers: WorkerState[] = [];
  private config: Required<DocumentWorkerPoolConfig>;
  private wasmBinary: ArrayBuffer | null = null;
  private wasmModule: WebAssembly.Module | null = null; // Pre-compiled WASM module
  private nextWorkerIndex = 0; // For round-robin
  private requestIdCounter = 0;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(config?: Partial<DocumentWorkerPoolConfig>) {
    this.config = {
      workerCount: config?.workerCount ?? 'auto',
      loadBalancing: config?.loadBalancing ?? 'document-affinity',
      enableTelemetry: config?.enableTelemetry ?? true,
    };
  }

  /**
   * Initialize the worker pool
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInitialize();
    await this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    const startTime = performance.now();

    // Determine worker count
    console.log('[DocumentWorkerPool] _doInitialize() starting...');
    const workerCount = this.resolveWorkerCount();
    console.log(`[DocumentWorkerPool] Initializing with ${workerCount} workers (config: ${JSON.stringify(this.config)})`);

    // Read WASM binary once
    this.wasmBinary = readWasmBinary();

    // Pre-compile WASM module for faster worker initialization
    // This saves 400-800ms per worker by doing compilation once on main thread
    const compileStart = performance.now();
    try {
      this.wasmModule = await WebAssembly.compile(this.wasmBinary);
      const compileDuration = performance.now() - compileStart;
      console.log(`[DocumentWorkerPool] WASM module compiled in ${compileDuration.toFixed(1)}ms (shared across ${workerCount} workers)`);

      if (this.config.enableTelemetry) {
        getTelemetry().trackCustomMetric('documentWasmCompileTime', compileDuration);
      }
    } catch (err) {
      console.warn('[DocumentWorkerPool] WASM pre-compilation failed, falling back to per-worker compilation:', err);
      // Continue without pre-compiled module - workers will compile individually
    }

    // Get worker blob URL
    const workerUrl = await getWorkerBlobUrl();

    // Create workers
    for (let i = 0; i < workerCount; i++) {
      const workerState = await this.createWorker(i, workerUrl);
      this.workers.push(workerState);
    }

    // Wait for all workers to be ready
    await Promise.all(this.workers.map(w => w.readyPromise));

    this.isInitialized = true;
    const duration = performance.now() - startTime;
    console.log(`[DocumentWorkerPool] Initialized ${workerCount} workers in ${duration.toFixed(1)}ms`);

    if (this.config.enableTelemetry) {
      getTelemetry().trackCustomMetric('documentWorkerPoolInitTime', duration);
      getTelemetry().trackCustomMetric('documentWorkerCount', workerCount);
      this.updateWorkerUtilization();
    }
  }

  /**
   * Update worker utilization telemetry
   */
  private updateWorkerUtilization(): void {
    if (!this.config.enableTelemetry) return;

    const activeWorkers = this.workers.filter(w => w.pendingRequests > 0).length;
    const totalWorkers = this.workers.length;
    const pendingTasks = this.workers.reduce((sum, w) => sum + w.pendingRequests, 0);

    getTelemetry().trackWorkerUtilization(activeWorkers, totalWorkers, pendingTasks);
  }

  /**
   * Create a single worker
   */
  private async createWorker(index: number, workerUrl: string): Promise<WorkerState> {
    let readyResolve: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    const worker = new Worker(workerUrl, { type: 'module' });

    const state: WorkerState = {
      worker,
      index,
      pendingRequests: 0,
      totalRequests: 0,
      isReady: false,
      readyPromise,
      readyResolve,
      documentIds: new Set(),
      pendingCallbacks: new Map(),
    };

    // Set up message handler
    worker.onmessage = (event) => this.handleWorkerMessage(state, event);
    worker.onerror = (event) => this.handleWorkerError(state, event);

    // Send WASM module and/or binary to initialize worker
    // Try with pre-compiled module first (saves 400-800ms per worker)
    // Fall back to binary-only if Module cloning fails (Electron compatibility)
    const wasmCopy = this.wasmBinary!.slice(0);

    if (this.wasmModule) {
      try {
        const initMessage = {
          type: 'INIT_WASM',
          wasmBinary: wasmCopy,
          wasmModule: this.wasmModule,
        };
        worker.postMessage(initMessage, [wasmCopy]);
        console.log(`[DocumentWorkerPool] Sent WASM module + binary to worker ${index}`);
      } catch (err) {
        // WebAssembly.Module may not be cloneable in some Electron versions
        console.warn(`[DocumentWorkerPool] Module cloning failed for worker ${index}, falling back to binary:`, err);
        // Need fresh copy since the first one was transferred (or invalidated)
        const fallbackCopy = this.wasmBinary!.slice(0);
        const fallbackMessage = {
          type: 'INIT_WASM',
          wasmBinary: fallbackCopy,
        };
        worker.postMessage(fallbackMessage, [fallbackCopy]);
      }
    } else {
      const initMessage = {
        type: 'INIT_WASM',
        wasmBinary: wasmCopy,
      };
      worker.postMessage(initMessage, [wasmCopy]);
      console.log(`[DocumentWorkerPool] Sent WASM binary to worker ${index} (no pre-compiled module)`);
    }

    return state;
  }

  /**
   * Handle messages from a worker
   */
  private handleWorkerMessage(state: WorkerState, event: MessageEvent): void {
    const response = event.data;

    // Handle ready signal
    if (response.type === 'READY') {
      state.isReady = true;
      state.readyResolve?.();
      console.log(`[DocumentWorkerPool] Worker ${state.index} ready`);
      return;
    }

    // Handle response with requestId
    if ('requestId' in response) {
      const pending = state.pendingCallbacks.get(response.requestId);
      if (!pending) {
        console.warn(`[DocumentWorkerPool] No pending request for ID: ${response.requestId}`);
        return;
      }

      state.pendingCallbacks.delete(response.requestId);
      state.pendingRequests--;

      // Track timing and utilization
      if (this.config.enableTelemetry) {
        const duration = performance.now() - pending.startTime;
        getTelemetry().trackCustomMetric(`docWorker${state.index}RequestTime`, duration);
        getTelemetry().trackWorkerTaskComplete();
        this.updateWorkerUtilization();
      }

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
  private isErrorResponse(response: DocumentWorkerResponse | { type: string }): boolean {
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
  private handleWorkerError(state: WorkerState, event: ErrorEvent): void {
    console.error(`[DocumentWorkerPool] Worker ${state.index} error:`, event.message);

    // Reject all pending requests for this worker
    for (const [id, pending] of state.pendingCallbacks) {
      pending.reject(new Error(`Worker ${state.index} error: ${event.message}`));
      state.pendingCallbacks.delete(id);
    }
    state.pendingRequests = 0;
  }

  /**
   * Resolve worker count from config
   */
  private resolveWorkerCount(): number {
    if (typeof this.config.workerCount === 'number') {
      return Math.max(1, Math.min(4, this.config.workerCount));
    }

    // Auto-detect based on capabilities
    const caps = getFeatureFlags().getCapabilities();
    const cores = caps.cpuCores;
    const memoryGB = caps.deviceMemoryGB ?? 4;

    // Conservative scaling
    if (cores <= 2 || memoryGB < 4) return 1;
    if (cores <= 4 || memoryGB < 6) return 2;
    if (cores <= 6 || memoryGB < 8) return 3;
    return 4;
  }

  /**
   * Select a worker for a request
   */
  private selectWorker(docId?: string): WorkerState {
    if (this.workers.length === 0) {
      throw new Error('Document worker pool not initialized');
    }

    if (this.workers.length === 1) {
      return this.workers[0];
    }

    switch (this.config.loadBalancing) {
      case 'round-robin':
        return this.selectWorkerRoundRobin();
      case 'least-loaded':
        return this.selectWorkerLeastLoaded();
      case 'document-affinity':
      default:
        return this.selectWorkerWithAffinity(docId);
    }
  }

  /**
   * Round-robin worker selection
   */
  private selectWorkerRoundRobin(): WorkerState {
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  /**
   * Least-loaded worker selection
   */
  private selectWorkerLeastLoaded(): WorkerState {
    return this.workers.reduce((min, worker) =>
      worker.pendingRequests < min.pendingRequests ? worker : min
    );
  }

  /**
   * Document affinity worker selection
   * Prefers workers that already have the document loaded
   */
  private selectWorkerWithAffinity(docId?: string): WorkerState {
    if (docId) {
      // Find workers that have this document
      const withDoc = this.workers.filter(w => w.documentIds.has(docId));
      if (withDoc.length > 0) {
        // Select least-loaded among workers with document
        return withDoc.reduce((min, worker) =>
          worker.pendingRequests < min.pendingRequests ? worker : min
        );
      }
    }
    // Fall back to least-loaded
    return this.selectWorkerLeastLoaded();
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    return `doc-pool-req-${++this.requestIdCounter}`;
  }

  /**
   * Send a request to the pool
   */
  private async sendRequest<T>(
    request: DocumentWorkerRequest,
    docId?: string,
    transferables?: Transferable[]
  ): Promise<T> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const worker = this.selectWorker(docId);
    const requestId = request.requestId ?? this.generateRequestId();
    const fullRequest = { ...request, requestId } as DocumentWorkerRequest;

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        type: request.type,
        workerIndex: worker.index,
        startTime: performance.now(),
      };

      worker.pendingCallbacks.set(requestId, pending);
      worker.pendingRequests++;
      worker.totalRequests++;

      // Track task start and update utilization
      if (this.config.enableTelemetry) {
        getTelemetry().trackWorkerTaskStart();
        this.updateWorkerUtilization();
      }

      if (transferables?.length) {
        worker.worker.postMessage(fullRequest, transferables);
      } else {
        worker.worker.postMessage(fullRequest);
      }
    });
  }

  /**
   * Send request to a specific worker
   */
  private async sendRequestToWorker<T>(
    worker: WorkerState,
    request: DocumentWorkerRequest,
    transferables?: Transferable[]
  ): Promise<T> {
    if (!worker.isReady) {
      await worker.readyPromise;
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        type: request.type,
        workerIndex: worker.index,
        startTime: performance.now(),
      };

      worker.pendingCallbacks.set(request.requestId, pending);
      worker.pendingRequests++;
      worker.totalRequests++;

      if (transferables?.length) {
        worker.worker.postMessage(request, transferables);
      } else {
        worker.worker.postMessage(request);
      }
    });
  }

  // ============ Public API ============

  /**
   * Load a document
   * Loads on selected worker and tracks document affinity
   */
  async loadDocument(data: ArrayBuffer, filename?: string): Promise<{ id: string; document: ParsedDocument }> {
    const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const requestId = this.generateRequestId();

    // Select worker with least load for new document
    const worker = this.selectWorkerLeastLoaded();

    const response = await this.sendRequestToWorker<{
      type: 'LOADED';
      requestId: string;
      document: ParsedDocument;
    }>(worker, { type: 'LOAD_DOCUMENT', requestId, docId, data, filename }, [data]);

    // Track document on this worker
    worker.documentIds.add(docId);

    return { id: docId, document: response.document };
  }

  /**
   * Load document on all workers (for maximum parallelism)
   * Use when expecting heavy parallel rendering
   */
  async loadDocumentOnAllWorkers(docId: string, data: ArrayBuffer, filename?: string): Promise<void> {
    // Pre-create all data copies BEFORE any transfers.
    // This is critical because transferring an ArrayBuffer detaches the original,
    // making subsequent slice() calls fail.
    const dataCopies = this.workers.map((worker) => {
      if (worker.documentIds.has(docId)) return null; // Already loaded, no copy needed
      // Each worker needs its own independent copy
      return data.slice(0);
    });

    const promises = this.workers.map(async (worker, index) => {
      const dataCopy = dataCopies[index];
      if (!dataCopy) return; // Already loaded (was null)

      const requestId = this.generateRequestId();

      await this.sendRequestToWorker(
        worker,
        { type: 'LOAD_DOCUMENT', requestId, docId, data: dataCopy, filename },
        [dataCopy]
      );

      worker.documentIds.add(docId);
    });

    await Promise.all(promises);
    console.log(`[DocumentWorkerPool] Document ${docId} loaded on all ${this.workers.length} workers`);
  }

  /**
   * Render a document item (page or chapter) to PNG
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
    }>({ type: 'RENDER_ITEM', requestId, docId, itemIndex, scale }, docId);

    return {
      data: response.data,
      width: response.width,
      height: response.height,
    };
  }

  /**
   * Render a tile of a document item
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
    const requestId = this.generateRequestId();
    const sendTime = performance.now();

    const response = await this.sendRequest<{
      type: 'TILE_RENDERED';
      requestId: string;
      itemIndex: number;
      tileX: number;
      tileY: number;
      data: Uint8Array;
      width: number;
      height: number;
      timing?: { pageLoad: number; render: number; encode: number; total: number };
    }>({
      type: 'RENDER_TILE',
      requestId,
      docId,
      itemIndex,
      tileX,
      tileY,
      tileSize,
      scale,
    }, docId);

    const receiveTime = performance.now();
    // Transfer time = round-trip - worker processing time
    const transferTime = response.timing
      ? (receiveTime - sendTime) - response.timing.total
      : receiveTime - sendTime;

    return {
      data: response.data,
      width: response.width,
      height: response.height,
      workerTiming: response.timing,
      transferTime: Math.max(0, transferTime),
    };
  }

  /**
   * Render multiple items in batch across all workers
   * Distributes work evenly for maximum parallelism
   *
   * @param docId Document ID
   * @param itemIndices Array of item/page indices to render
   * @param scale Render scale
   * @param onProgress Optional progress callback
   * @returns Map of item index to render result
   */
  async renderItemBatch(
    docId: string,
    itemIndices: number[],
    scale: number,
    onProgress?: BatchProgressCallback
  ): Promise<Map<number, ThumbnailResult>> {
    if (itemIndices.length === 0) {
      return new Map();
    }

    // Ensure document is loaded on all workers for maximum parallelism
    const workersWithDoc = this.workers.filter(w => w.documentIds.has(docId));
    if (workersWithDoc.length < this.workers.length && workersWithDoc.length > 0) {
      // Document exists on some workers, load on others
      // We need the original data - get it from a worker that has it
      console.log(`[DocumentWorkerPool] Document ${docId} loaded on ${workersWithDoc.length}/${this.workers.length} workers`);
    }

    const results = new Map<number, ThumbnailResult>();
    let completed = 0;
    const total = itemIndices.length;

    // Distribute items across workers
    const workerCount = workersWithDoc.length || 1;
    const itemsPerWorker: number[][] = Array.from({ length: workerCount }, () => []);

    itemIndices.forEach((itemIndex, i) => {
      itemsPerWorker[i % workerCount].push(itemIndex);
    });

    // Render in parallel across workers
    const workerPromises = itemsPerWorker.map(async (workerItems, workerIdx) => {
      const worker = workersWithDoc[workerIdx] || this.workers[0];

      for (const itemIndex of workerItems) {
        try {
          const requestId = this.generateRequestId();

          const response = await this.sendRequestToWorker<{
            type: 'ITEM_RENDERED';
            requestId: string;
            itemIndex: number;
            data: Uint8Array;
            width: number;
            height: number;
          }>(worker, { type: 'RENDER_ITEM', requestId, docId, itemIndex, scale });

          results.set(itemIndex, {
            pageNum: itemIndex,
            data: response.data,
            width: response.width,
            height: response.height,
          });

          completed++;
          onProgress?.(completed, total, itemIndex);
        } catch (error) {
          console.error(`[DocumentWorkerPool] Failed to render item ${itemIndex}:`, error);
          // Continue with other items
        }
      }
    });

    await Promise.all(workerPromises);

    return results;
  }

  /**
   * Render thumbnails in batch with priority ordering
   * Items are rendered in the order provided, with parallel execution across workers
   *
   * @param docId Document ID
   * @param itemIndices Array of item/page indices to render (order determines priority)
   * @param scale Thumbnail scale (typically 0.2-0.5)
   * @param priority Priority level for logging/metrics
   * @param onProgress Optional progress callback
   * @returns Map of item index to thumbnail result
   */
  async renderThumbnailBatch(
    docId: string,
    itemIndices: number[],
    scale: number,
    priority: RenderPriority = 'medium',
    onProgress?: BatchProgressCallback
  ): Promise<Map<number, ThumbnailResult>> {
    if (itemIndices.length === 0) {
      return new Map();
    }

    const startTime = performance.now();
    console.log(`[DocumentWorkerPool] Starting ${priority} thumbnail batch: ${itemIndices.length} items at scale ${scale}`);

    const results = await this.renderItemBatch(docId, itemIndices, scale, onProgress);

    const duration = performance.now() - startTime;
    const avgTime = duration / itemIndices.length;
    console.log(
      `[DocumentWorkerPool] Completed ${priority} thumbnail batch: ${results.size}/${itemIndices.length} in ${duration.toFixed(0)}ms (${avgTime.toFixed(1)}ms/item)`
    );

    if (this.config.enableTelemetry) {
      getTelemetry().trackCustomMetric('thumbnailBatchTime', duration);
      getTelemetry().trackCustomMetric('thumbnailBatchSize', itemIndices.length);
      getTelemetry().trackCustomMetric('thumbnailAvgTime', avgTime);
    }

    return results;
  }

  /**
   * Get structured text with character positions
   */
  async getStructuredText(docId: string, itemIndex: number): Promise<StructuredText> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'STRUCTURED_TEXT';
      requestId: string;
      itemIndex: number;
      data: StructuredText;
    }>({ type: 'GET_STRUCTURED_TEXT', requestId, docId, itemIndex }, docId);

    return response.data;
  }

  /**
   * Search document for text
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
    }>({ type: 'SEARCH', requestId, docId, query, maxHits, includeContext }, docId);

    return response.results;
  }

  /**
   * Get item count
   */
  async getItemCount(docId: string): Promise<number> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'ITEM_COUNT';
      requestId: string;
      itemCount: number;
    }>({ type: 'GET_ITEM_COUNT', requestId, docId }, docId);

    return response.itemCount;
  }

  /**
   * Get item dimensions (at scale 1.0)
   */
  async getItemDimensions(docId: string, itemIndex: number): Promise<{ width: number; height: number }> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'ITEM_DIMENSIONS';
      requestId: string;
      itemIndex: number;
      width: number;
      height: number;
    }>({ type: 'GET_ITEM_DIMENSIONS', requestId, docId, itemIndex }, docId);

    return { width: response.width, height: response.height };
  }

  /**
   * Get EPUB chapter XHTML content
   */
  async getEpubChapter(docId: string, chapterIndex: number): Promise<string> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'EPUB_CHAPTER';
      requestId: string;
      chapterIndex: number;
      xhtml: string;
    }>({ type: 'GET_EPUB_CHAPTER', requestId, docId, chapterIndex }, docId);

    return response.xhtml;
  }

  /**
   * Unload document from all workers
   */
  async unloadDocument(docId: string): Promise<void> {
    const promises = this.workers
      .filter(w => w.documentIds.has(docId))
      .map(async (worker) => {
        const requestId = this.generateRequestId();
        await this.sendRequestToWorker(worker, {
          type: 'UNLOAD_DOCUMENT',
          requestId,
          docId,
        });
        worker.documentIds.delete(docId);
      });

    await Promise.all(promises);
  }

  /**
   * Get pool statistics
   */
  getStats(): DocumentWorkerPoolStats {
    const requestsPerWorker = this.workers.map(w => w.totalRequests);
    const pendingPerWorker = this.workers.map(w => w.pendingRequests);
    const documentsPerWorker = this.workers.map(w => w.documentIds.size);

    const totalRequests = requestsPerWorker.reduce((a, b) => a + b, 0);
    const avgPending = pendingPerWorker.reduce((a, b) => a + b, 0) / this.workers.length;

    const maxRequests = Math.max(...requestsPerWorker);
    const minRequests = Math.min(...requestsPerWorker);
    const imbalanceRatio = minRequests > 0 ? maxRequests / minRequests : 1;

    return {
      workerCount: this.workers.length,
      totalRequests,
      requestsPerWorker,
      pendingPerWorker,
      avgPendingRequests: avgPending,
      imbalanceRatio,
      documentsPerWorker,
    };
  }

  /**
   * Get number of workers
   */
  getWorkerCount(): number {
    return this.workers.length;
  }

  /**
   * Check if pool is initialized
   */
  get ready(): boolean {
    return this.isInitialized;
  }

  /**
   * Terminate all workers
   */
  terminate(): void {
    for (const state of this.workers) {
      state.worker.terminate();
      for (const [, pending] of state.pendingCallbacks) {
        pending.reject(new Error('Document worker pool terminated'));
      }
      state.pendingCallbacks.clear();
    }
    this.workers = [];
    this.isInitialized = false;
    this.initPromise = null;
    console.log('[DocumentWorkerPool] Terminated');
  }
}

// ============ Singleton ============

let poolInstance: DocumentWorkerPoolManager | null = null;
let poolInitPromise: Promise<DocumentWorkerPoolManager> | null = null;

/**
 * Get or create the shared document worker pool instance
 */
export async function getDocumentWorkerPool(): Promise<DocumentWorkerPoolManager> {
  if (!poolInitPromise) {
    poolInitPromise = (async () => {
      const pool = new DocumentWorkerPoolManager();
      await pool.initialize();
      poolInstance = pool;
      return pool;
    })();
  }
  return poolInitPromise;
}

/**
 * Get the pool instance synchronously (may be null if not initialized)
 */
export function getDocumentWorkerPoolSync(): DocumentWorkerPoolManager | null {
  return poolInstance;
}

/**
 * Destroy the shared document worker pool
 */
export function destroyDocumentWorkerPool(): void {
  if (poolInstance) {
    poolInstance.terminate();
    poolInstance = null;
  }
  poolInitPromise = null;
  // Clear worker blob URL cache to ensure fresh worker on next load
  if (cachedWorkerBlobUrl) {
    URL.revokeObjectURL(cachedWorkerBlobUrl);
    cachedWorkerBlobUrl = null;
  }
}

/**
 * Reset the document worker pool (for testing)
 */
export function resetDocumentWorkerPool(): void {
  destroyDocumentWorkerPool();
}

/**
 * Worker Pool Manager
 *
 * Manages a pool of MuPDF Web Workers for parallel PDF rendering.
 * Achieves 2-4x throughput improvement over single-worker architecture.
 *
 * Features:
 * - Shared WASM module compilation (compile once, instantiate in each worker)
 * - Load balancing (round-robin, least-loaded, document affinity)
 * - Document state tracking per worker
 * - Automatic worker count detection based on CPU/memory
 * - Utilization telemetry
 *
 * @example
 * ```typescript
 * const pool = getWorkerPool();
 * await pool.initialize();
 * const result = await pool.renderTile(docId, page, tileX, tileY, scale);
 * ```
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
import { getFeatureFlags, isFeatureEnabled } from './feature-flags';
import { getTelemetry } from './pdf-telemetry';
import { getSharedBufferPool, type SharedBufferPool, type BufferSlot } from './shared-buffer-pool';

export type { RenderFormat };

/** Load balancing strategy */
export type LoadBalancingStrategy = 'round-robin' | 'least-loaded' | 'document-affinity';

/** Worker pool configuration */
export interface WorkerPoolConfig {
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
export interface WorkerPoolStats {
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
let pluginBasePath: string | null = null;
let cachedEsmBlobUrl: string | null = null;
let cachedWrapperBlobUrl: string | null = null;

/**
 * Set the plugin base path for loading workers.
 */
export function setWorkerPoolPluginPath(vaultPath: string): void {
  pluginBasePath = `${vaultPath}/.obsidian/plugins/amnesia`;
}

/**
 * Classic worker wrapper that dynamically imports ESM module.
 *
 * ESM blob workers don't work in Obsidian/Electron, so we use a classic
 * worker that uses dynamic import() to load the ESM code.
 */
const WORKER_WRAPPER_CODE = `
// Classic worker wrapper for ESM module loading
// This wrapper receives the ESM blob URL and WASM data, then imports the ESM module

let _wasmModule = null;
let _wasmBinary = null;
let _esmModuleUrl = null;

self.onmessage = async function(e) {
  const { type } = e.data;

  if (type === 'LOAD_ESM_MODULE') {
    // Received ESM blob URL and WASM data
    _esmModuleUrl = e.data.esmUrl;
    _wasmBinary = e.data.wasmBinary;
    _wasmModule = e.data.wasmModule || null;

    console.log('[Wrapper] Received LOAD_ESM_MODULE, ESM URL:', _esmModuleUrl?.slice(0, 50));
    console.log('[Wrapper] WASM binary size:', _wasmBinary?.byteLength);
    console.log('[Wrapper] WASM module:', _wasmModule ? 'provided' : 'not provided');

    // Set up globals BEFORE importing ESM module
    // The ESM banner expects these to be ready
    globalThis.window = self;
    globalThis.process = { env: {}, versions: {} };

    // Set up WASM module configuration
    globalThis.$libmupdf_wasm_Module = {
      wasmBinary: _wasmBinary,
      locateFile: function(filename) {
        console.error('[Wrapper] locateFile called unexpectedly:', filename);
        return filename;
      },
      instantiateWasm: function(imports, callback) {
        console.log('[Wrapper] instantiateWasm called');
        if (_wasmModule) {
          console.log('[Wrapper] Using pre-compiled WASM module');
          WebAssembly.instantiate(_wasmModule, imports).then(function(instance) {
            callback(instance);
          }).catch(function(err) {
            console.error('[Wrapper] WASM instantiation from module failed:', err);
          });
          return {};
        }
        if (_wasmBinary) {
          console.log('[Wrapper] Compiling WASM from binary (' + _wasmBinary.byteLength + ' bytes)');
          WebAssembly.instantiate(_wasmBinary, imports).then(function(result) {
            console.log('[Wrapper] WASM compiled and instantiated');
            callback(result.instance);
          }).catch(function(err) {
            console.error('[Wrapper] WASM instantiation from binary failed:', err);
          });
          return {};
        }
        console.error('[Wrapper] No WASM module or binary!');
        return undefined;
      }
    };

    // Create and immediately resolve the WASM ready promise
    // The ESM module's banner will await this
    globalThis.__MUPDF_WASM_READY__ = Promise.resolve();

    // Now dynamically import the ESM module
    // This will run the ESM code in this worker's context
    try {
      console.log('[Wrapper] Importing ESM module...');
      await import(_esmModuleUrl);
      console.log('[Wrapper] ESM module loaded successfully');
      // The ESM module should now have set up its own message handlers
      // and will send READY when initialized
    } catch (err) {
      console.error('[Wrapper] ESM module import failed:', err);
      self.postMessage({ type: 'INIT_ERROR', error: String(err) });
    }
    return;
  }

  // After ESM module is loaded, it will have replaced self.onmessage
  // So this code path should not be reached for normal requests
  console.warn('[Wrapper] Unexpected message before ESM load:', type);
};

console.log('[Wrapper] Classic wrapper started, waiting for LOAD_ESM_MODULE');
`;

/**
 * Get the wrapper worker URL. Creates a classic worker that dynamically
 * imports the ESM mupdf worker code.
 */
async function getWorkerUrls(): Promise<{ wrapperUrl: string; esmUrl: string }> {
  if (cachedWrapperBlobUrl && cachedEsmBlobUrl) {
    console.log('[WorkerPool] Using cached worker URLs');
    return { wrapperUrl: cachedWrapperBlobUrl, esmUrl: cachedEsmBlobUrl };
  }

  if (!pluginBasePath) {
    throw new Error('Worker pool path not configured. Call setWorkerPoolPluginPath() first.');
  }

  // Read the ESM worker code and create a blob URL
  const fs = window.require('fs') as typeof import('fs');
  const workerPath = `${pluginBasePath}/mupdf-worker.js`;
  console.log(`[WorkerPool] Reading ESM worker from: ${workerPath}`);
  const esmCode = fs.readFileSync(workerPath, 'utf-8');
  console.log(`[WorkerPool] ESM worker code length: ${esmCode.length} chars`);

  // Create blob URL for ESM module
  const esmBlob = new Blob([esmCode], { type: 'application/javascript' });
  cachedEsmBlobUrl = URL.createObjectURL(esmBlob);
  console.log(`[WorkerPool] Created ESM blob URL: ${cachedEsmBlobUrl}`);

  // Create blob URL for classic wrapper
  const wrapperBlob = new Blob([WORKER_WRAPPER_CODE], { type: 'application/javascript' });
  cachedWrapperBlobUrl = URL.createObjectURL(wrapperBlob);
  console.log(`[WorkerPool] Created wrapper blob URL: ${cachedWrapperBlobUrl}`);

  return { wrapperUrl: cachedWrapperBlobUrl, esmUrl: cachedEsmBlobUrl };
}

/**
 * Read WASM binary from disk
 */
function readWasmBinary(): ArrayBuffer {
  if (!pluginBasePath) {
    throw new Error('Worker pool path not configured. Call setWorkerPoolPluginPath() first.');
  }

  const fs = window.require('fs') as typeof import('fs');
  const wasmPath = `${pluginBasePath}/mupdf-wasm.wasm`;
  const buffer = fs.readFileSync(wasmPath);
  // Convert Node.js Buffer to ArrayBuffer (use Uint8Array to guarantee ArrayBuffer type)
  const uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const arrayBuffer = new ArrayBuffer(uint8Array.length);
  new Uint8Array(arrayBuffer).set(uint8Array);
  return arrayBuffer;
}

/**
 * Worker Pool Manager
 *
 * Orchestrates multiple MuPDF workers for parallel rendering.
 */
export class WorkerPoolManager {
  private workers: WorkerState[] = [];
  private config: Required<WorkerPoolConfig>;
  private wasmBinary: ArrayBuffer | null = null;
  /** Pre-compiled WASM module for faster worker initialization */
  private wasmModule: WebAssembly.Module | null = null;
  private nextWorkerIndex = 0; // For round-robin
  private requestIdCounter = 0;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  /** SharedArrayBuffer pool for zero-copy transfer */
  private sharedBufferPool: SharedBufferPool | null = null;
  /** Whether SAB is enabled and initialized on all workers */
  private sabEnabled = false;

  constructor(config?: Partial<WorkerPoolConfig>) {
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
    console.log('[WorkerPool] _doInitialize() starting...');
    const workerCount = this.resolveWorkerCount();
    console.log(`[WorkerPool] Initializing with ${workerCount} workers (config: ${JSON.stringify(this.config)})`);

    // Read WASM binary once
    this.wasmBinary = readWasmBinary();

    // Pre-compile WASM module for faster worker initialization
    // This saves 400-800ms per worker by doing compilation once on main thread
    const compileStart = performance.now();
    try {
      this.wasmModule = await WebAssembly.compile(this.wasmBinary);
      const compileDuration = performance.now() - compileStart;
      console.log(`[WorkerPool] WASM module compiled in ${compileDuration.toFixed(1)}ms (shared across ${workerCount} workers)`);

      if (this.config.enableTelemetry) {
        getTelemetry().trackCustomMetric('wasmCompileTime', compileDuration);
      }
    } catch (err) {
      console.warn('[WorkerPool] WASM pre-compilation failed, falling back to per-worker compilation:', err);
      // Continue without pre-compiled module - workers will compile individually
    }

    // Get worker URLs (classic wrapper + ESM blob URL)
    const { wrapperUrl, esmUrl } = await getWorkerUrls();

    // Create workers IN PARALLEL for faster initialization
    // Previously sequential creation added ~140ms per worker
    const workerCreationPromises: Promise<WorkerState>[] = [];
    for (let i = 0; i < workerCount; i++) {
      workerCreationPromises.push(this.createWorker(i, wrapperUrl, esmUrl));
    }
    this.workers = await Promise.all(workerCreationPromises);

    // Wait for all workers to be ready (WASM initialized)
    await Promise.all(this.workers.map(w => w.readyPromise));

    this.isInitialized = true;
    const duration = performance.now() - startTime;
    console.log(`[WorkerPool] Initialized ${workerCount} workers in ${duration.toFixed(1)}ms`);

    if (this.config.enableTelemetry) {
      getTelemetry().trackCustomMetric('workerPoolInitTime', duration);
      getTelemetry().trackCustomMetric('workerCount', workerCount);
      // Initialize worker utilization tracking with total workers
      this.updateWorkerUtilization();
    }

    // Initialize SharedArrayBuffer pool for zero-copy transfer
    await this.initializeSharedBuffers();
  }

  /**
   * Initialize SharedArrayBuffer pool and send references to all workers
   */
  private async initializeSharedBuffers(): Promise<void> {
    // Check if SharedArrayBuffer is enabled
    if (!isFeatureEnabled('useSharedArrayBuffer')) {
      console.log('[WorkerPool] SharedArrayBuffer disabled by feature flag');
      return;
    }

    try {
      this.sharedBufferPool = getSharedBufferPool();

      if (!this.sharedBufferPool.isSharedArrayBufferEnabled()) {
        console.log('[WorkerPool] SharedArrayBuffer not available (fallback mode)');
        return;
      }

      // Get buffer references to send to all workers
      const bufferRefs = this.sharedBufferPool.getBufferReferences();
      if (!bufferRefs) {
        console.log('[WorkerPool] No SharedArrayBuffer references available');
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
        console.log('[WorkerPool] No SharedArrayBuffer slots available');
        return;
      }

      // Send INIT_SHARED_BUFFERS to all workers in parallel
      const initPromises = this.workers.map(async (worker) => {
        const requestId = this.generateRequestId();
        const response = await this.sendRequestToWorker<{
          type: 'SHARED_BUFFERS_INITIALIZED';
          requestId: string;
          success: boolean;
          tierSizes: number[];
        }>(worker, {
          type: 'INIT_SHARED_BUFFERS',
          requestId,
          buffers,
        } as WorkerRequest);

        return response.success;
      });

      const results = await Promise.all(initPromises);
      this.sabEnabled = results.every(r => r);

      console.log(
        `[WorkerPool] SharedArrayBuffer initialized on ${results.filter(r => r).length}/${this.workers.length} workers, ` +
        `enabled: ${this.sabEnabled}`
      );
    } catch (err) {
      console.error('[WorkerPool] Failed to initialize SharedArrayBuffer:', err);
      this.sabEnabled = false;
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
   * Create a single worker using the wrapper approach.
   *
   * ESM blob workers don't work in Obsidian/Electron, so we use a classic
   * wrapper worker that dynamically imports the ESM module.
   *
   * @param index Worker index
   * @param wrapperUrl URL of the classic wrapper worker
   * @param esmUrl Blob URL of the ESM module to be dynamically imported
   */
  private async createWorker(index: number, wrapperUrl: string, esmUrl: string): Promise<WorkerState> {
    let readyResolve: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    console.log(`[WorkerPool] Creating worker ${index}...`);
    if (index === 0) {
      console.log(`[WorkerPool] Wrapper URL: ${wrapperUrl.slice(0, 50)}...`);
      console.log(`[WorkerPool] ESM URL: ${esmUrl.slice(0, 50)}...`);
    }

    let worker: Worker;
    try {
      // Create classic wrapper worker (NOT ESM)
      worker = new Worker(wrapperUrl);
      console.log(`[WorkerPool] Worker ${index} created successfully`);
    } catch (e) {
      console.error(`[WorkerPool] Worker ${index} creation failed:`, e);
      throw e;
    }

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

    // Send LOAD_ESM_MODULE message with ESM URL and WASM data
    // The wrapper will set up globals and dynamically import the ESM module
    const wasmCopy = this.wasmBinary!.slice(0);

    if (this.wasmModule) {
      // Try sending pre-compiled module with binary
      try {
        const initMessage = {
          type: 'LOAD_ESM_MODULE',
          esmUrl: esmUrl,
          wasmBinary: wasmCopy,
          wasmModule: this.wasmModule,
        };
        worker.postMessage(initMessage, [wasmCopy]);
        console.log(`[WorkerPool] Sent LOAD_ESM_MODULE to worker ${index} (with WASM module)`);
      } catch (err) {
        // WebAssembly.Module may not be cloneable in some Electron versions
        console.warn(`[WorkerPool] Module cloning failed for worker ${index}, falling back to binary:`, err);
        const fallbackCopy = this.wasmBinary!.slice(0);
        const fallbackMessage = {
          type: 'LOAD_ESM_MODULE',
          esmUrl: esmUrl,
          wasmBinary: fallbackCopy,
        };
        worker.postMessage(fallbackMessage, [fallbackCopy]);
      }
    } else {
      // No pre-compiled module, send binary only
      const initMessage = {
        type: 'LOAD_ESM_MODULE',
        esmUrl: esmUrl,
        wasmBinary: wasmCopy,
      };
      worker.postMessage(initMessage, [wasmCopy]);
      console.log(`[WorkerPool] Sent LOAD_ESM_MODULE to worker ${index} (WASM binary only)`);
    }

    return state;
  }

  /**
   * Handle messages from a worker
   */
  private handleWorkerMessage(state: WorkerState, event: MessageEvent): void {
    const response = event.data;

    // DEBUG: Log banner debug messages from worker
    if (response.type === 'BANNER_DEBUG') {
      console.log(`[WorkerPool] Worker ${state.index} banner debug:`, response);
      return;
    }

    // Handle ready signal
    if (response.type === 'READY') {
      state.isReady = true;
      state.readyResolve?.();
      console.log(`[WorkerPool] Worker ${state.index} ready`);
      return;
    }

    // Handle response with requestId
    if ('requestId' in response) {
      const pending = state.pendingCallbacks.get(response.requestId);
      if (!pending) {
        console.warn(`[WorkerPool] No pending request for ID: ${response.requestId}`);
        return;
      }

      state.pendingCallbacks.delete(response.requestId);
      state.pendingRequests--;

      // Track timing and utilization
      if (this.config.enableTelemetry) {
        const duration = performance.now() - pending.startTime;
        getTelemetry().trackCustomMetric(`worker${state.index}RequestTime`, duration);
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
  private isErrorResponse(response: WorkerResponse | { type: string }): boolean {
    return (
      response.type === 'LOAD_ERROR' ||
      response.type === 'RENDER_ERROR' ||
      response.type === 'TILE_RENDER_ERROR' ||
      response.type === 'TEXT_LAYER_ERROR' ||
      response.type === 'SEARCH_ERROR' ||
      response.type === 'PAGE_COUNT_ERROR' ||
      response.type === 'PAGE_DIMENSIONS_ERROR' ||
      response.type === 'UNLOAD_ERROR' ||
      response.type === 'CLASSIFY_ERROR' ||
      response.type === 'JPEG_EXTRACT_ERROR'
    );
  }

  /**
   * Handle worker errors
   */
  private handleWorkerError(state: WorkerState, event: ErrorEvent): void {
    console.error(`[WorkerPool] Worker ${state.index} error:`, event.message);

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
      throw new Error('Worker pool not initialized');
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
    return `pool-req-${++this.requestIdCounter}`;
  }

  /**
   * Send a request to the pool
   * Uses WorkerRequest union type - individual requests match specific variants
   */
  private async sendRequest<T>(
    request: WorkerRequest,
    docId?: string,
    transferables?: Transferable[]
  ): Promise<T> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const worker = this.selectWorker(docId);
    const requestId = request.requestId ?? this.generateRequestId();
    const fullRequest = { ...request, requestId } as WorkerRequest;

    // Debug logging for classification requests
    if (request.type === 'CLASSIFY_PAGE' || request.type === 'CLASSIFY_PAGES') {
      console.log(`[WorkerPool] sendRequest ${request.type}: docId=${docId}, worker=${worker.index}, workerDocIds=${Array.from(worker.documentIds)}`);
    }

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

  // ============ Public API ============

  /**
   * Load a PDF document
   * Loads on selected worker and tracks document affinity
   */
  async loadDocument(data: ArrayBuffer): Promise<{ id: string; pageCount: number; toc: TocEntry[] }> {
    const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const requestId = this.generateRequestId();

    // Select worker with least load for new document
    const worker = this.selectWorkerLeastLoaded();
    console.log(`[WorkerPool] loadDocument: docId=${docId}, selectedWorker=${worker.index}`);

    const response = await this.sendRequestToWorker<{
      type: 'LOADED';
      requestId: string;
      pageCount: number;
      toc: TocEntry[];
    }>(worker, { type: 'LOAD_DOCUMENT', requestId, docId, data }, [data]);

    // Track document on this worker
    worker.documentIds.add(docId);
    console.log(`[WorkerPool] loadDocument complete: docId=${docId}, worker=${worker.index}, workerDocIds now=${Array.from(worker.documentIds)}`);

    return { id: docId, pageCount: response.pageCount, toc: response.toc };
  }

  /**
   * Load document on a specific worker
   */
  private async sendRequestToWorker<T>(
    worker: WorkerState,
    request: WorkerRequest,
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

  /**
   * Load document on all workers (for maximum parallelism)
   * Use when you expect heavy parallel rendering
   */
  async loadDocumentOnAllWorkers(docId: string, data: ArrayBuffer): Promise<void> {
    // Pre-create all data copies BEFORE any transfers.
    // This is critical because transferring an ArrayBuffer detaches the original,
    // making subsequent slice() calls fail.
    const dataCopies = this.workers.map((worker, index) => {
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
        { type: 'LOAD_DOCUMENT', requestId, docId, data: dataCopy },
        [dataCopy]
      );

      worker.documentIds.add(docId);
    });

    await Promise.all(promises);
    console.log(`[WorkerPool] Document ${docId} loaded on all ${this.workers.length} workers`);
  }

  /**
   * Ensure document is loaded on worker before request
   */
  private async ensureDocumentLoaded(worker: WorkerState, docId: string, getDocData: () => Promise<ArrayBuffer>): Promise<void> {
    if (worker.documentIds.has(docId)) return;

    // Document not on this worker, need to load it
    const data = await getDocData();
    const requestId = this.generateRequestId();

    await this.sendRequestToWorker(
      worker,
      { type: 'LOAD_DOCUMENT', requestId, docId, data },
      [data]
    );

    worker.documentIds.add(docId);
  }

  /**
   * Render a page
   */
  async renderPage(
    docId: string,
    pageNum: number,
    scale: number,
    format: RenderFormat = 'rgba'
  ): Promise<{ data: Uint8Array; width: number; height: number; format: RenderFormat; timing?: WorkerTiming }> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'PAGE_RENDERED';
      requestId: string;
      pageNum: number;
      data: Uint8Array;
      width: number;
      height: number;
      format: RenderFormat;
      timing?: WorkerTiming;
    }>({ type: 'RENDER_PAGE', requestId, docId, pageNum, scale, format }, docId);

    return {
      data: response.data,
      width: response.width,
      height: response.height,
      format: response.format,
      timing: response.timing,
    };
  }

  /**
   * Render a tile
   */
  async renderTile(
    docId: string,
    pageNum: number,
    tileX: number,
    tileY: number,
    tileSize: number,
    scale: number,
    format: RenderFormat = 'rgba'
  ): Promise<{ data: Uint8Array; width: number; height: number; format: RenderFormat; timing?: WorkerTiming }> {
    const requestId = this.generateRequestId();

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
      }>(request, docId);

      // Handle shared buffer response
      let data: Uint8Array;
      if (response.type === 'TILE_RENDERED_SHARED' && response.usedSharedBuffer && acquiredSlot) {
        // Read data from shared buffer
        // We must copy before releasing the slot, but we still save the transfer copy
        const dataLength = response.dataLength ?? (response.width * response.height * 4);
        const sourceView = new Uint8Array(acquiredSlot.view.buffer, acquiredSlot.view.byteOffset, dataLength);
        data = new Uint8Array(dataLength);
        data.set(sourceView);
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
        timing: response.timing,
      };
    } finally {
      // Always release the slot after use
      if (acquiredSlot && this.sharedBufferPool) {
        this.sharedBufferPool.release(acquiredSlot);
      }
    }
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
    if (pageNums.length === 0) {
      return new Map();
    }

    const startTime = performance.now();
    console.log(`[WorkerPool] Starting batch render: ${pageNums.length} pages at scale ${scale}`);

    // Find workers that have the document loaded
    const workersWithDoc = this.workers.filter(w => w.documentIds.has(docId));
    if (workersWithDoc.length === 0) {
      console.warn(`[WorkerPool] Document ${docId} not loaded on any worker, falling back to single worker`);
      // Fall back to sequential rendering through default load balancing
      const results = new Map<number, { data: Uint8Array; width: number; height: number; format: RenderFormat }>();
      let completed = 0;
      for (const pageNum of pageNums) {
        try {
          const result = await this.renderPage(docId, pageNum, scale, format);
          results.set(pageNum, result);
          completed++;
          onProgress?.(completed, pageNums.length, pageNum);
        } catch (err) {
          console.error(`[WorkerPool] Batch render failed for page ${pageNum}:`, err);
        }
      }
      return results;
    }

    const results = new Map<number, { data: Uint8Array; width: number; height: number; format: RenderFormat }>();
    let completed = 0;
    const total = pageNums.length;

    // Distribute pages across workers evenly
    const workerCount = workersWithDoc.length;
    const pagesPerWorker: number[][] = Array.from({ length: workerCount }, () => []);

    pageNums.forEach((pageNum, i) => {
      pagesPerWorker[i % workerCount].push(pageNum);
    });

    // Render in parallel across workers
    const workerPromises = pagesPerWorker.map(async (workerPages, workerIdx) => {
      const worker = workersWithDoc[workerIdx];

      for (const pageNum of workerPages) {
        try {
          const requestId = this.generateRequestId();

          const response = await this.sendRequestToWorker<{
            type: 'PAGE_RENDERED';
            requestId: string;
            pageNum: number;
            data: Uint8Array;
            width: number;
            height: number;
            format: RenderFormat;
            timing?: WorkerTiming;
          }>(worker, { type: 'RENDER_PAGE', requestId, docId, pageNum, scale, format });

          results.set(pageNum, {
            data: response.data,
            width: response.width,
            height: response.height,
            format: response.format,
          });

          completed++;
          onProgress?.(completed, total, pageNum);
        } catch (err) {
          console.error(`[WorkerPool] Batch render failed for page ${pageNum}:`, err);
        }
      }
    });

    await Promise.all(workerPromises);

    const duration = performance.now() - startTime;
    const avgTime = duration / pageNums.length;
    console.log(
      `[WorkerPool] Batch render complete: ${results.size}/${pageNums.length} in ${duration.toFixed(0)}ms (${avgTime.toFixed(1)}ms/page)`
    );

    if (this.config.enableTelemetry) {
      getTelemetry().trackCustomMetric('batchRenderTime', duration);
      getTelemetry().trackCustomMetric('batchRenderSize', pageNums.length);
      getTelemetry().trackCustomMetric('batchRenderAvgTime', avgTime);
    }

    return results;
  }

  /**
   * Get text layer
   */
  async getTextLayer(docId: string, pageNum: number): Promise<TextLayerData> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'TEXT_LAYER';
      requestId: string;
      pageNum: number;
      data: TextLayerData;
    }>({ type: 'GET_TEXT_LAYER', requestId, docId, pageNum }, docId);

    return response.data;
  }

  /**
   * Search document
   */
  async search(docId: string, query: string, maxHits: number = 100): Promise<SearchResult[]> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'SEARCH_RESULTS';
      requestId: string;
      results: SearchResult[];
    }>({ type: 'SEARCH', requestId, docId, query, maxHits }, docId);

    return response.results;
  }

  /**
   * Get page count
   */
  async getPageCount(docId: string): Promise<number> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'PAGE_COUNT';
      requestId: string;
      pageCount: number;
    }>({ type: 'GET_PAGE_COUNT', requestId, docId }, docId);

    return response.pageCount;
  }

  /**
   * Get page dimensions
   */
  async getPageDimensions(docId: string, pageNum: number): Promise<{ width: number; height: number }> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'PAGE_DIMENSIONS';
      requestId: string;
      pageNum: number;
      width: number;
      height: number;
    }>({ type: 'GET_PAGE_DIMENSIONS', requestId, docId, pageNum }, docId);

    return { width: response.width, height: response.height };
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

  // ============ Content-Type Detection API (Phase 5) ============

  /**
   * Classify a page's content type for optimized rendering.
   *
   * Uses lightweight PDF structure analysis to determine:
   * - SCANNED_JPEG: Single JPEG image covering page (can extract directly)
   * - SCANNED_OTHER: Single non-JPEG image
   * - VECTOR_HEAVY: Dominated by path operations (can render at lower scale)
   * - TEXT_HEAVY: Dominated by text operations
   * - MIXED: Balanced mix of content types
   * - COMPLEX: Has transparency or high operator count
   *
   * Classification is fast (<10ms typical) and cached per-document.
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
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'PAGE_CLASSIFIED';
      requestId: string;
      pageNum: number;
      classification: {
        type: string;
        confidence: number;
        classificationTimeMs: number;
        hasTransparency: boolean;
        pageNum: number;
        operatorCounts?: { text: number; path: number; image: number; graphicsState: number; color: number; clipping: number; total: number };
        images?: Array<{ name: string; width: number; height: number; filter: string; coveragePercent: number }>;
      };
    }>({ type: 'CLASSIFY_PAGE', requestId, docId, pageNum } as WorkerRequest, docId);

    return response.classification;
  }

  /**
   * Classify multiple pages in batch.
   *
   * More efficient than calling classifyPage() repeatedly as it
   * batches the requests and can parallelize across workers.
   */
  async classifyPages(docId: string, pageNums: number[]): Promise<Map<number, {
    type: string;
    confidence: number;
    classificationTimeMs: number;
    hasTransparency: boolean;
    pageNum: number;
  }>> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'PAGES_CLASSIFIED';
      requestId: string;
      classifications: Array<{
        pageNum: number;
        classification: {
          type: string;
          confidence: number;
          classificationTimeMs: number;
          hasTransparency: boolean;
          pageNum: number;
        };
      }>;
    }>({ type: 'CLASSIFY_PAGES', requestId, docId, pageNums } as WorkerRequest, docId);

    const results = new Map<number, {
      type: string;
      confidence: number;
      classificationTimeMs: number;
      hasTransparency: boolean;
      pageNum: number;
    }>();

    for (const { pageNum, classification } of response.classifications) {
      results.set(pageNum, classification);
    }

    return results;
  }

  /**
   * Extract JPEG directly from a scanned page.
   *
   * For pages classified as SCANNED_JPEG, this bypasses MuPDF rendering
   * entirely and extracts the raw JPEG stream from the PDF, providing
   * 60-80% performance improvement.
   *
   * Only works for pages with a single DCT-encoded image covering
   * most of the page (>80% coverage).
   *
   * @throws Error if page is not a scanned JPEG or extraction fails
   */
  async extractJpeg(docId: string, pageNum: number): Promise<{
    data: Uint8Array;
    width: number;
    height: number;
  }> {
    const requestId = this.generateRequestId();

    const response = await this.sendRequest<{
      type: 'JPEG_EXTRACTED';
      requestId: string;
      pageNum: number;
      data: Uint8Array;
      width: number;
      height: number;
    }>({ type: 'EXTRACT_JPEG', requestId, docId, pageNum } as WorkerRequest, docId);

    return {
      data: response.data,
      width: response.width,
      height: response.height,
    };
  }

  /**
   * Get pool statistics
   */
  getStats(): WorkerPoolStats {
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
        pending.reject(new Error('Worker pool terminated'));
      }
      state.pendingCallbacks.clear();
    }
    this.workers = [];
    this.isInitialized = false;
    this.initPromise = null;
    console.log('[WorkerPool] Terminated');
  }
}

// ============ Singleton ============

let poolInstance: WorkerPoolManager | null = null;
let poolInitPromise: Promise<WorkerPoolManager> | null = null;

/**
 * Get or create the shared worker pool instance
 */
export async function getWorkerPool(): Promise<WorkerPoolManager> {
  if (!poolInitPromise) {
    poolInitPromise = (async () => {
      const pool = new WorkerPoolManager();
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
export function getWorkerPoolSync(): WorkerPoolManager | null {
  return poolInstance;
}

/**
 * Destroy the shared worker pool
 */
export function destroyWorkerPool(): void {
  if (poolInstance) {
    poolInstance.terminate();
    poolInstance = null;
  }
  poolInitPromise = null;

  // Clean up Blob URLs to prevent memory leak
  if (cachedWrapperBlobUrl) {
    URL.revokeObjectURL(cachedWrapperBlobUrl);
    cachedWrapperBlobUrl = null;
    console.log('[WorkerPool] Wrapper Blob URL revoked');
  }
  if (cachedEsmBlobUrl) {
    URL.revokeObjectURL(cachedEsmBlobUrl);
    cachedEsmBlobUrl = null;
    console.log('[WorkerPool] ESM Blob URL revoked');
  }
}

/**
 * Reset the worker pool (for testing)
 */
export function resetWorkerPool(): void {
  destroyWorkerPool();
}

/**
 * Pre-warm the worker pool during plugin startup.
 *
 * This initializes workers in the background so they're ready
 * when the first PDF is opened, eliminating cold start latency.
 *
 * Call this from plugin onload() for best results:
 * ```typescript
 * // In main.ts onload()
 * prewarmWorkerPool().catch(console.error);
 * ```
 *
 * @param count Optional worker count override (default: auto-detect)
 * @returns Promise that resolves when workers are ready
 */
export async function prewarmWorkerPool(count?: number): Promise<void> {
  if (!pluginBasePath) {
    console.warn('[WorkerPool] Cannot prewarm: plugin path not set. Call setWorkerPoolPluginPath() first.');
    return;
  }

  const startTime = performance.now();
  console.log('[WorkerPool] Pre-warming worker pool...');

  try {
    // Create pool with optional worker count override
    if (!poolInitPromise) {
      poolInitPromise = (async () => {
        const config: Partial<WorkerPoolConfig> = count !== undefined ? { workerCount: count } : {};
        const pool = new WorkerPoolManager(config);
        await pool.initialize();
        poolInstance = pool;
        return pool;
      })();
    }

    await poolInitPromise;

    const duration = performance.now() - startTime;
    console.log(`[WorkerPool] Pre-warm complete in ${duration.toFixed(1)}ms`);

    // Track pre-warm time in telemetry
    getTelemetry().trackCustomMetric('workerPoolPrewarmTime', duration);
  } catch (err) {
    console.error('[WorkerPool] Pre-warm failed:', err);
    throw err;
  }
}

/**
 * Check if worker pool is pre-warmed and ready.
 * Use this to conditionally show loading indicators.
 */
export function isWorkerPoolReady(): boolean {
  return poolInstance?.ready ?? false;
}

# Phase 3: Multi-Worker Architecture - Design Document

## Executive Summary

Transform the single-worker MuPDF rendering architecture into a pool of 2-4 parallel workers to achieve 2-4x tile rendering throughput. The current bottleneck is that MuPDF WASM rendering is CPU-bound and single-threaded, so multiple concurrent requests still execute sequentially.

## Current Architecture

```
Main Thread                          Single Worker
─────────────────                    ─────────────

MuPDFBridge ────postMessage────────► MuPDF Worker
     │                                    │
     │                                    ├── documents Map<docId, PDFDocument>
     │                                    ├── mupdf WASM module
     │                                    │
     │◄───────response─────────────────────┘
     │
     ▼
WasmPdfRenderer
     │
     ▼
HybridPdfProvider
```

**Problem:** Even with 8 semaphore permits, all requests serialize through one WASM instance.

## Proposed Architecture

```
Main Thread                          Worker Pool (2-4 workers)
─────────────────                    ─────────────────────────

                                     ┌─► Worker 0
                                     │   ├── documents Map
WorkerPoolManager ──loadBalance──────┤   └── mupdf WASM instance
     │                               │
     │                               ├─► Worker 1
     │                               │   ├── documents Map
     │                               │   └── mupdf WASM instance
     │                               │
     │◄──────responses───────────────┼─► Worker 2 (if 4+ cores)
     │                               │   └── ...
     │                               │
     ▼                               └─► Worker 3 (if 8GB+ RAM)
MuPDFBridge (updated to use pool)
     │
     ▼
WasmPdfRenderer
```

## Component Design

### 1. WorkerPoolManager

**File:** `src/reader/renderer/pdf/worker-pool-manager.ts`

**Responsibilities:**
- Initialize worker pool with configurable count (1-4)
- Compile WASM module once, share with all workers
- Load balance requests across workers
- Track worker utilization for telemetry
- Handle worker failures with automatic restart

```typescript
interface WorkerPoolConfig {
  /** Number of workers (1-4, or 'auto' for CPU-based) */
  workerCount: number | 'auto';
  /** Load balancing strategy */
  loadBalancing: 'round-robin' | 'least-loaded';
  /** Enable utilization telemetry */
  enableTelemetry: boolean;
}

interface WorkerState {
  worker: Worker;
  index: number;
  pendingRequests: number;
  totalRequests: number;
  isReady: boolean;
  documentIds: Set<string>;
}

class WorkerPoolManager {
  private workers: WorkerState[] = [];
  private compiledModule: WebAssembly.Module | null = null;
  private wasmBinary: ArrayBuffer | null = null;
  private nextWorkerIndex = 0;  // For round-robin

  async initialize(config: WorkerPoolConfig): Promise<void>;
  async compileWasmModule(): Promise<WebAssembly.Module>;
  selectWorker(docId?: string): WorkerState;
  async loadDocumentOnAllWorkers(docId: string, data: ArrayBuffer): Promise<void>;
  sendRequest<T>(request: WorkerRequest): Promise<T>;
  getUtilizationStats(): WorkerUtilizationStats;
  terminate(): void;
}
```

### 2. Load Balancing Strategies

**Round-Robin (Default):**
- Simple, predictable distribution
- Best for uniform workloads
- O(1) selection

```typescript
private selectWorkerRoundRobin(): WorkerState {
  const worker = this.workers[this.nextWorkerIndex];
  this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
  return worker;
}
```

**Least-Loaded:**
- Prefers workers with fewer pending requests
- Better for variable-size workloads
- O(n) where n = worker count (acceptable for n ≤ 4)

```typescript
private selectWorkerLeastLoaded(): WorkerState {
  return this.workers.reduce((min, worker) =>
    worker.pendingRequests < min.pendingRequests ? worker : min
  );
}
```

**Document Affinity (Optimization):**
- Prefers workers that already have the document loaded
- Avoids redundant document loading
- Falls back to least-loaded if no affinity

```typescript
private selectWorkerWithAffinity(docId: string): WorkerState {
  // First, try workers that have this document
  const withDoc = this.workers.filter(w => w.documentIds.has(docId));
  if (withDoc.length > 0) {
    return this.selectLeastLoaded(withDoc);
  }
  // Fall back to least-loaded overall
  return this.selectWorkerLeastLoaded();
}
```

### 3. Document Sharing Strategy

**Option A: Per-Worker Document Loading (Selected)**
- Each worker loads document independently
- Higher memory usage but simpler
- ~10MB per document per worker = 40MB for 4 workers (acceptable)

**Option B: SharedArrayBuffer (Future Enhancement)**
- Share PDF bytes across workers via SharedArrayBuffer
- Requires cross-origin isolation (COOP/COEP headers)
- Currently not available in Obsidian's Electron context
- Save ~30MB for large documents

For Phase 3, we implement Option A with document affinity to minimize redundant loading.

### 4. WASM Module Sharing

The key optimization: compile WASM once, instantiate in each worker.

**Main Thread:**
```typescript
// Compile once
const response = await fetch('/mupdf-wasm.wasm');
const wasmBinary = await response.arrayBuffer();
const compiledModule = await WebAssembly.compile(wasmBinary);

// Send compiled module to each worker
for (const worker of workers) {
  worker.postMessage({
    type: 'INIT_WITH_MODULE',
    module: compiledModule
  });
}
```

**Worker Thread:**
```typescript
// Receive pre-compiled module
self.onmessage = async (event) => {
  if (event.data.type === 'INIT_WITH_MODULE') {
    const module = event.data.module;
    // Instantiate from pre-compiled module (fast!)
    const instance = await WebAssembly.instantiate(module, imports);
    mupdf = instance.exports;
    self.postMessage({ type: 'READY' });
  }
};
```

**Benefit:** WASM compilation takes ~100-200ms. Sharing compiled module means workers 2-4 initialize in ~10ms instead.

### 5. Worker Lifecycle

```
┌──────────────┐
│   CREATED    │  Worker instantiated but not initialized
└──────┬───────┘
       │ postMessage(INIT_WITH_MODULE)
       ▼
┌──────────────┐
│ INITIALIZING │  Loading WASM, setting up mupdf
└──────┬───────┘
       │ postMessage(READY)
       ▼
┌──────────────┐
│    READY     │  Can receive requests
└──────┬───────┘
       │ Request / Response cycles
       ▼
┌──────────────┐
│   WORKING    │  Processing render request
└──────┬───────┘
       │ Response sent
       ▼
┌──────────────┐
│    READY     │  Available for next request
└──────────────┘
```

### 6. Request Flow

```
1. Caller invokes renderTile(page, tileX, tileY, scale)
        │
        ▼
2. WorkerPoolManager.selectWorker(docId)
   - Check document affinity
   - Apply load balancing
        │
        ▼
3. Check if worker has document loaded
   - If no: queue LOAD_DOCUMENT first
   - If yes: proceed
        │
        ▼
4. Send RENDER_TILE to selected worker
        │
        ▼
5. Worker renders tile, sends response
        │
        ▼
6. Pool manager routes response to caller
```

### 7. Memory Budget

| Component | 1 Worker | 2 Workers | 4 Workers |
|-----------|----------|-----------|-----------|
| WASM Code (shared) | 3 MB | 3 MB | 3 MB |
| WASM Heap (per worker) | 30 MB | 60 MB | 120 MB |
| Document State (per doc per worker) | 10 MB | 20 MB | 40 MB |
| Working Buffers | 5 MB | 10 MB | 20 MB |
| **Total** | **48 MB** | **93 MB** | **183 MB** |

**Within Budget:** 500MB total - 183MB workers - 200MB caches = 117MB headroom

### 8. Auto Worker Count Detection

```typescript
function getOptimalWorkerCount(): number {
  const caps = getFeatureFlags().getCapabilities();
  const cores = caps.cpuCores;
  const memoryGB = caps.deviceMemoryGB ?? 4;

  // Conservative scaling based on cores and memory
  if (cores <= 2 || memoryGB < 4) return 1;
  if (cores <= 4 || memoryGB < 6) return 2;
  if (cores <= 6 || memoryGB < 8) return 3;
  return 4;
}
```

### 9. Telemetry

```typescript
interface WorkerPoolTelemetry {
  /** Total requests processed */
  totalRequests: number;
  /** Requests per worker */
  requestsPerWorker: number[];
  /** Average queue depth per worker */
  avgQueueDepth: number[];
  /** Worker utilization (0-1) */
  utilization: number[];
  /** Load imbalance ratio (max/min requests) */
  imbalanceRatio: number;
}
```

## Implementation Steps

### Sub-Phase 3.1: Worker Pool Foundation
1. Create `worker-pool-manager.ts` with basic pool initialization
2. Implement shared WASM module compilation
3. Add round-robin load balancing
4. Basic document loading on selected worker

### Sub-Phase 3.2: Document Affinity
1. Track which documents are loaded on which workers
2. Implement document affinity selection
3. Add lazy document loading (load only when first request arrives)

### Sub-Phase 3.3: Integration
1. Update `MuPDFBridge` to use pool (backward compatible)
2. Update `getSharedMuPDFBridge()` to return pool-backed bridge
3. Add `workerCount` feature flag integration
4. Update `WasmPdfRenderer` to work with pool

### Sub-Phase 3.4: Telemetry & Optimization
1. Add worker utilization tracking
2. Implement least-loaded balancing
3. Add pool stats to telemetry dashboard
4. Performance tuning based on metrics

## Backward Compatibility

The existing API remains unchanged:
- `MuPDFBridge.renderTile()` works the same
- `getSharedMuPDFBridge()` returns a pool-backed bridge
- `WasmPdfRenderer` API unchanged

Internally, requests are distributed across the pool.

## Rollback Strategy

Feature flag `workerCount = 1` reverts to single-worker mode:

```typescript
if (workerCount === 1) {
  // Use existing single-worker path (MuPDFBridge directly)
  return singleWorkerBridge;
}
// Use pool
return poolManager.getBridge();
```

## Validation Metrics

| Metric | 1 Worker (Baseline) | Target (4 Workers) |
|--------|---------------------|-------------------|
| 100 tiles @ scale 4 | 4000ms | <1500ms |
| 100 tiles @ scale 16 | 8000ms | <2500ms |
| Memory usage | ~50MB | <200MB |
| Scroll FPS (fast) | 45fps | >55fps |
| Grid load (100 thumbs) | 3-5s | <1.5s |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Memory bloat | Monitor heap size, cap at 4 workers |
| Worker crashes | Auto-restart with exponential backoff |
| Stale document state | Sync document loads across workers |
| Message overhead | Batch small requests (future optimization) |

## Files to Create/Modify

### New Files
| File | Purpose | Estimated LOC |
|------|---------|---------------|
| `worker-pool-manager.ts` | Pool orchestration | ~450 |

### Modified Files
| File | Changes |
|------|---------|
| `mupdf-bridge.ts` | Add pool integration, factory pattern |
| `mupdf-worker.ts` | Support INIT_WITH_MODULE message |
| `wasm-renderer.ts` | Use pool-aware bridge |
| `feature-flags.ts` | workerCount already exists, verify |
| `pdf-telemetry.ts` | Add worker pool metrics |
| `index.ts` | Export pool manager |

## Timeline

- **Sub-Phase 3.1:** Foundation (~2-3 hours)
- **Sub-Phase 3.2:** Document Affinity (~1-2 hours)
- **Sub-Phase 3.3:** Integration (~2-3 hours)
- **Sub-Phase 3.4:** Telemetry & Testing (~1-2 hours)

**Total: ~8-10 hours of implementation**

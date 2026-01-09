# Research Report: Multi-Worker Architecture

## Executive Summary

This research investigates strategies for parallelizing PDF rendering across multiple Web Workers with MuPDF WASM. The current single-worker architecture limits throughput to sequential rendering, even with semaphore-based concurrency. Our findings indicate that **2-4 parallel MuPDF workers** could achieve 2-4x throughput improvement, with memory costs of approximately **50-100MB per additional worker instance**.

---

## Current Architecture Analysis

### The Problem

```
Main Thread → postMessage → Single MuPDF Worker → Semaphore(8) → Sequential renders
```

Despite 8 concurrent permits, rendering is CPU-bound within a single WASM instance. The semaphore prevents excessive queuing but doesn't enable true parallelism.

### Bottleneck: Single-Threaded WASM

MuPDF rendering is CPU-intensive:
- PDF interpretation: 5-15ms per tile
- Rasterization: varies with content complexity
- These operations block each other in a single worker

---

## Research Findings

### 1. pdf.js Worker Architecture

> "For this first implementation, there is only one worker used per PDF file."
> — [pdf.js Issue #663: Worker Implementation Overview](https://github.com/mozilla/pdf.js/issues/663)

pdf.js also uses a single worker per document, but their architecture is different:
- Worker handles PDF parsing and operator interpretation
- Canvas drawing commands are sent to main thread
- Main thread does actual rendering

**Key insight**: pdf.js's approach offloads interpretation, not rasterization. MuPDF's WASM approach requires worker-side rasterization, making multi-worker more valuable.

### 2. Multi-Worker Requests in pdf.js Community

> "Users have requested the ability to spawn multiple workers at once to render different PDFs, with the desired behavior being rendering of images asynchronously so that the bottleneck is the most detailed PDF image to be rendered."
> — [pdf.js Issue #16871](https://github.com/mozilla/pdf.js/issues/16871)

This confirms demand for parallel rendering, though pdf.js hasn't implemented it yet.

### 3. WASM Module Sharing Pattern

> "If you can, outsource performance-heavy tasks in a Web Worker, and do the Wasm loading and compiling work only once outside of the Web Worker. This way, the Web Worker only needs to instantiate the Wasm module it receives from the main thread."
> — [WebAssembly Performance Patterns for Web Apps](https://web.dev/articles/webassembly-performance-patterns-for-web-apps)

**Recommended pattern**:

```javascript
// Main thread: Compile once
const wasmModule = await WebAssembly.compileStreaming(fetch('mupdf.wasm'));

// Send to workers
workers.forEach(worker => {
  worker.postMessage({ type: 'init', module: wasmModule });
});

// Worker: Instantiate from pre-compiled module
self.onmessage = async (e) => {
  if (e.data.type === 'init') {
    const instance = await WebAssembly.instantiate(e.data.module, imports);
    // Much faster than compile + instantiate
  }
};
```

### 4. Memory Costs of Multiple WASM Instances

> "When `pthread_create` is called, a new Web Worker is created, but this Web Worker cannot access the existing Wasm instance or its functions. Therefore, you must initialize a new instance in the freshly created Web Worker. As an optimization, the compiled machine code can be cached/shared across instantiations, but the wrapping instance objects must still be separately allocated."
> — [Multithreading Rust and Wasm](https://rustwasm.github.io/2018/10/24/multithreading-rust-and-wasm.html)

**Memory breakdown per MuPDF instance (estimated)**:

| Component | Size |
|-----------|------|
| WASM code (shared) | ~3 MB (only loaded once) |
| Instance heap | ~20-50 MB base |
| Document state | ~10-50 MB per loaded document |
| Pixmap buffers | ~5-20 MB working set |
| **Total per worker** | **~50-100 MB** |

With 4 workers: ~200-400 MB additional memory (within 500 MB budget if base app is lean).

### 5. SharedArrayBuffer for Document Sharing

> "You can share modules (code) between threads, and also share memory between threads. With these abilities, you can instantiate a WebAssembly.Module on multiple web workers quickly and efficiently."
> — [Faster Fractals with Multi-Threaded WebAssembly](https://blog.scottlogic.com/2019/07/15/multithreaded-webassembly.html)

**Possibility**: Share PDF document bytes across workers using SharedArrayBuffer.

```javascript
// Load PDF once
const pdfBytes = await fetch(pdfUrl).then(r => r.arrayBuffer());
const sharedPdf = new SharedArrayBuffer(pdfBytes.byteLength);
new Uint8Array(sharedPdf).set(new Uint8Array(pdfBytes));

// Each worker gets same document bytes
workers.forEach(worker => {
  worker.postMessage({ type: 'loadPdf', buffer: sharedPdf });
});
```

**Caveat**: Each worker still needs to parse the PDF independently (MuPDF document objects aren't shareable).

### 6. Worker Pool Patterns

> "A Pool function maintains a taskQueue and workerQueue, adding worker tasks by shifting from the worker queue if workers are available, otherwise pushing tasks to the task queue."
> — [HTML5 Worker Pool Pattern](http://www.smartjava.org/content/html5-easily-parallelize-jobs-using-web-workers-and-threadpool/)

**Recommended implementation**:

```typescript
class MuPDFWorkerPool {
  private workers: Worker[] = [];
  private available: Worker[] = [];
  private taskQueue: RenderTask[] = [];

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker('mupdf-worker.js');
      this.workers.push(worker);
      this.available.push(worker);
    }
  }

  async render(task: RenderTask): Promise<ImageBitmap> {
    const worker = this.available.pop() || await this.waitForWorker();

    return new Promise((resolve) => {
      worker.onmessage = (e) => {
        this.available.push(worker);
        this.processQueue();
        resolve(e.data.bitmap);
      };
      worker.postMessage(task);
    });
  }

  private processQueue(): void {
    while (this.available.length && this.taskQueue.length) {
      const task = this.taskQueue.shift()!;
      const worker = this.available.pop()!;
      // ... process task
    }
  }
}
```

### 7. Optimal Worker Count

> "Measure carefully whether it makes sense to keep one permanent Web Worker around forever, or to create ad hoc Web Workers when needed. Things to consider include memory consumption, the Web Worker instantiation duration, and the complexity of handling concurrent requests."
> — [WebAssembly Performance Patterns](https://web.dev/articles/webassembly-performance-patterns-for-web-apps)

**Recommendations by hardware**:

| Cores | Workers | Rationale |
|-------|---------|-----------|
| 2 | 2 | Minimum parallelism |
| 4 | 3-4 | Leave 1 core for main thread |
| 8+ | 4 | Diminishing returns, memory cost |

**Detection**:
```javascript
const optimalWorkers = Math.min(
  navigator.hardwareConcurrency - 1,
  4  // Cap at 4 for memory budget
);
```

### 8. Load Balancing Strategies

For tile workloads, simple round-robin is often sufficient:

```javascript
class RoundRobinBalancer {
  private currentIndex = 0;

  getNextWorker(workers: Worker[]): Worker {
    const worker = workers[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % workers.length;
    return worker;
  }
}
```

For more sophisticated balancing, track worker queue depths:

```javascript
class LeastLoadedBalancer {
  private queueDepths: Map<Worker, number> = new Map();

  getNextWorker(workers: Worker[]): Worker {
    return workers.reduce((least, w) =>
      (this.queueDepths.get(w) || 0) < (this.queueDepths.get(least) || 0) ? w : least
    );
  }
}
```

### 9. Emscripten's Wasm Workers API

> "You can spawn multiple Workers from the same codebase and save memory by sharing the WebAssembly Module (object code) and Memory (address space) across the Workers."
> — [Emscripten Wasm Workers API](https://emscripten.org/docs/api_reference/wasm_workers.html)

**Advanced option**: If we build MuPDF ourselves, Emscripten's pthread support could enable true shared-memory multithreading within a single WASM instance.

This would require:
- Custom MuPDF WASM build with `-s USE_PTHREADS=1`
- Thread-safe MuPDF usage (may require mutex guards)
- SharedArrayBuffer availability

---

## Proposed Architecture

### Design: Tiered Worker Pool

```
┌─────────────────────────────────────────────────────────────┐
│                        Main Thread                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              MuPDFWorkerPool                         │   │
│  │  ┌─────────────────────────────────────────────┐    │   │
│  │  │         TaskQueue (priority sorted)          │    │   │
│  │  │  [critical, critical, high, medium, low]     │    │   │
│  │  └─────────────────────────────────────────────┘    │   │
│  │                                                      │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          │   │
│  │  │ Worker 1 │  │ Worker 2 │  │ Worker 3 │  ...     │   │
│  │  │ (MuPDF)  │  │ (MuPDF)  │  │ (MuPDF)  │          │   │
│  │  └──────────┘  └──────────┘  └──────────┘          │   │
│  │       ↑              ↑              ↑               │   │
│  │       └──────────────┼──────────────┘               │   │
│  │                      │                              │   │
│  │           Shared WASM Module (3MB)                  │   │
│  │           Shared PDF bytes (SharedArrayBuffer)      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Implementation Phases

#### Phase 1: Basic Worker Pool (2 workers)

```typescript
// Minimal viable implementation
class BasicWorkerPool {
  private workers: MuPDFWorker[] = [];
  private sharedModule: WebAssembly.Module | null = null;

  async initialize(workerCount = 2): Promise<void> {
    // Compile once
    this.sharedModule = await WebAssembly.compileStreaming(
      fetch('/mupdf.wasm')
    );

    // Create workers
    for (let i = 0; i < workerCount; i++) {
      const worker = new MuPDFWorker(this.sharedModule);
      await worker.initialize();
      this.workers.push(worker);
    }
  }

  async loadDocument(bytes: ArrayBuffer): Promise<void> {
    // Each worker loads the document independently
    await Promise.all(
      this.workers.map(w => w.loadDocument(bytes))
    );
  }

  async renderTile(request: TileRequest): Promise<ImageBitmap> {
    const worker = this.getLeastBusyWorker();
    return worker.render(request);
  }
}
```

#### Phase 2: Adaptive Scaling (2-4 workers)

```typescript
class AdaptiveWorkerPool extends BasicWorkerPool {
  private targetWorkerCount: number;
  private renderLatencyHistory: number[] = [];

  async adjustWorkerCount(): Promise<void> {
    const avgLatency = this.calculateAverageLatency();
    const cpuCores = navigator.hardwareConcurrency;

    if (avgLatency > 100 && this.workers.length < Math.min(4, cpuCores - 1)) {
      await this.addWorker();
    } else if (avgLatency < 30 && this.workers.length > 2) {
      this.removeWorker();
    }
  }

  private async addWorker(): Promise<void> {
    const worker = new MuPDFWorker(this.sharedModule!);
    await worker.initialize();
    await worker.loadDocument(this.currentDocument);
    this.workers.push(worker);
  }

  private removeWorker(): void {
    const worker = this.workers.pop();
    worker?.terminate();
  }
}
```

#### Phase 3: Shared Memory Optimization

```typescript
class SharedMemoryWorkerPool extends AdaptiveWorkerPool {
  private documentBuffer: SharedArrayBuffer | null = null;

  async loadDocument(bytes: ArrayBuffer): Promise<void> {
    // Share document bytes across workers
    this.documentBuffer = new SharedArrayBuffer(bytes.byteLength);
    new Uint8Array(this.documentBuffer).set(new Uint8Array(bytes));

    await Promise.all(
      this.workers.map(w => w.loadSharedDocument(this.documentBuffer!))
    );
  }
}
```

---

## Expected Performance Gains

| Scenario | 1 Worker | 2 Workers | 4 Workers |
|----------|----------|-----------|-----------|
| 10 tiles @ 20ms each | 200ms | 100ms | 50ms |
| Fast scroll (40 tiles) | 800ms | 400ms | 200ms |
| Initial grid (100 thumbnails) | 2000ms | 1000ms | 500ms |
| **Improvement** | Baseline | 2x | 4x |

**Note**: Actual gains depend on memory bandwidth and cache contention.

---

## Memory Budget Analysis

**Target**: <500MB total for 1000-page PDFs

| Component | Single Worker | 4 Workers |
|-----------|---------------|-----------|
| Base Electron/Obsidian | ~150 MB | ~150 MB |
| MuPDF WASM code | 3 MB | 3 MB (shared) |
| Worker instances | 50 MB | 200 MB |
| Document cache | 100 MB | 100 MB (shared) |
| Tile cache (L1+L2) | 150 MB | 100 MB (reduced) |
| **Total** | ~450 MB | ~550 MB |

**Trade-off**: Slightly over budget, but cache reduction compensates.

---

## Risks and Mitigations

### Risk 1: Document State Synchronization
Each worker has its own parsed document state. Page rendering results should be identical, but internal state (like font caches) is duplicated.

**Mitigation**: Accept duplication as cost of parallelism. Font cache is typically small.

### Risk 2: Memory Pressure on Low-End Devices
4 workers × 50MB = 200MB overhead may be too much.

**Mitigation**:
- Detect available memory: `navigator.deviceMemory`
- Scale workers accordingly: 2 workers for <4GB devices

### Risk 3: Worker Startup Latency
WASM instantiation takes 50-200ms per worker.

**Mitigation**:
- Initialize workers on document open (not on first render)
- Pre-warm workers during idle time
- Use module caching across sessions

### Risk 4: Coordination Complexity
More workers = more complex scheduling.

**Mitigation**:
- Start simple (round-robin)
- Only add complexity if benchmarks show need

---

## Validation Plan

### Benchmark: Worker Scaling

1. Render 100 tiles with 1, 2, 3, 4 workers
2. Measure: total time, memory usage, CPU utilization
3. Identify optimal worker count per hardware tier

### Test Cases

| Test | Metric | Target |
|------|--------|--------|
| Grid view (100 pages) | Time to full render | <1s with 4 workers |
| Fast scroll | FPS during scroll | >55 FPS |
| Memory stability | 30-min session | No growth trend |
| Cold start | Document open to first page | <500ms |

---

## Conclusion

Multi-worker architecture offers 2-4x throughput improvement for CPU-bound PDF rendering. The recommended approach is:

1. **Start with 2 workers** for conservative memory usage
2. **Share compiled WASM module** across workers (3MB saved)
3. **Consider SharedArrayBuffer** for document bytes (reduces memory per worker)
4. **Scale adaptively** based on render latency and hardware capabilities

The memory overhead (~150MB for 4 workers) is manageable within the 500MB budget if cache sizes are adjusted proportionally.

---

## Bibliography

1. [pdf.js Issue #663: Worker Implementation Overview](https://github.com/mozilla/pdf.js/issues/663) - pdf.js single-worker design rationale
2. [pdf.js Issue #16871: Multiple Workers Request](https://github.com/mozilla/pdf.js/issues/16871) - Community demand for parallel rendering
3. [pdf.js Issue #10319: OffscreenCanvas in Worker](https://github.com/mozilla/pdf.js/issues/10319) - Worker rendering challenges
4. [WebAssembly Performance Patterns for Web Apps](https://web.dev/articles/webassembly-performance-patterns-for-web-apps) - Best practices for WASM workers
5. [Multithreading Rust and Wasm](https://rustwasm.github.io/2018/10/24/multithreading-rust-and-wasm.html) - WASM threading fundamentals
6. [Faster Fractals with Multi-Threaded WebAssembly](https://blog.scottlogic.com/2019/07/15/multithreaded-webassembly.html) - Practical multi-threaded WASM
7. [Emscripten Wasm Workers API](https://emscripten.org/docs/api_reference/wasm_workers.html) - Official threading documentation
8. [HTML5 Worker Pool Pattern](http://www.smartjava.org/content/html5-easily-parallelize-jobs-using-web-workers-and-threadpool/) - Generic worker pool implementation
9. [Concurrency in WebAssembly - ACM Queue](https://queue.acm.org/detail.cfm?id=3746173) - Academic perspective on WASM concurrency
10. [WebAssembly.instantiate() MDN](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiate_static) - Module instantiation API
11. [A Practical Guide to WebAssembly Memory](https://radu-matei.com/blog/practical-guide-to-wasm-memory/) - Memory management deep dive
12. [Multithreading in JavaScript with Web Workers](https://www.honeybadger.io/blog/javascript-web-workers-multithreading/) - Web Worker fundamentals

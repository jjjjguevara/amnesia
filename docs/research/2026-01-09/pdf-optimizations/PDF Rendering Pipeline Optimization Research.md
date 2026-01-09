# **High-Performance PDF Rendering Architectures in Electron: Leveraging MuPDF, WASM, and Parallel Computing for Obsidian Plugins**

## **1\. Introduction: The Convergence of Web Technologies and High-Fidelity Document Rendering**

The contemporary landscape of desktop application development has been fundamentally altered by the dominance of the Electron framework, which allows developers to bridge the ubiquity of web technologies with the underlying power of native operating systems. However, this convergence is not without its friction points. One of the most persistent challenges remains the rendering of complex, high-resolution document formats—specifically the Portable Document Format (PDF)—at speeds and efficiencies that rival native, platform-specific applications like Preview on macOS or SumatraPDF on Windows. For users of knowledge management tools such as Obsidian, the expectation is a "second brain" environment where document transitions are instantaneous, scrolling is fluid at 60 frames per second (FPS), and memory consumption is unobtrusive, allowing for the simultaneous manipulation of gigabyte-sized archives alongside graph databases and markdown editors.

Achieving this "native-like" performance profile within the constraints of a JavaScript-based environment requires a radical departure from traditional Document Object Model (DOM) manipulation. The standard approach—relied upon by libraries such as PDF.js—involves parsing binary data on the main thread or a simple worker, converting graphical primitives into Canvas drawing commands, and relying on the browser's rasterizer. While functional for casual web browsing, this architecture collapses under the weight of high-velocity interaction. The inherent latency of the JavaScript event loop, the overhead of garbage collection (GC) cycles within the V8 engine, and the serialization costs of moving data between threads create a performance ceiling that prevents smooth 0.5x to 16x zooming and rapid pagination.

This report presents a comprehensive architectural analysis for optimizing a PDF rendering pipeline specifically designed for an Obsidian plugin environment. It proposes a shift toward a heterogeneous computing model that leverages Artifex’s MuPDF library compiled to WebAssembly (WASM), orchestrated via a multi-threaded worker pool communicating through SharedArrayBuffer memory regions. This architecture effectively bypasses the serialization bottlenecks of standard message passing, exploits the parallelism of modern multi-core CPUs, and utilizes hardware-accelerated compositing via OffscreenCanvas. Furthermore, we explore the intricate memory constraints imposed by the V8 "memory cage" in recent Electron versions, the necessity of Single Instruction, Multiple Data (SIMD) compilation flags for image decoding throughput, and the implementation of predictive cache eviction algorithms derived from geospatial mapping systems to maintain a memory footprint strictly under 500MB.

By treating the browser not merely as a document viewer but as a low-level virtual machine, developers can unlock performance characteristics that were previously the exclusive domain of C++ and Rust applications. The following sections detail the theoretical underpinnings and practical implementations of this high-performance pipeline.

## **2\. The Data Transport Layer: Overcoming the Serialization Bottleneck**

The most significant impediment to high-performance graphics in a web-worker environment is not the speed of computation, but the cost of communication. In a naive implementation where a WASM worker renders a PDF page to a bitmap and sends it to the main thread for display, the browser must copy that memory. For a standard 1080p page rendered at a typical reading DPI (resulting in a 4K texture for crisp text), the raw buffer size exceeds 30MB. Transferring this buffer via postMessage triggers the structured clone algorithm, a process that involves allocating new memory in the destination thread and performing a deep copy of the data.1

### **2.1 The Throughput Limitations of Structured Cloning and Transferables**

Benchmark analyses of structured cloning reveal a latency profile that is incompatible with a 16.6ms frame budget (required for 60fps). Transferring a 32MB buffer can take between 50ms and 300ms depending on the hardware and browser engine.1 This latency introduces "jank"—perceptible stutters during scrolling—as the main thread locks up waiting for memory allocation and copying routines to complete.

The introduction of Transferable Objects (e.g., ArrayBuffer, ImageBitmap) offered a partial solution by allowing the "transfer" of memory ownership rather than copying. This creates a zero-copy transfer in theory, akin to passing a pointer by reference in C++. However, the semantics of Transferable Objects are destructive: once the worker transfers the buffer to the main thread, the worker loses access to that memory block.1

In a PDF rendering context, this ownership transfer creates a logistical nightmare known as "buffer ping-pong." To render the next frame or update a tile, the worker must either allocate a new buffer (triggering garbage collection pressure) or wait for the main thread to transfer the original buffer back. This synchronization overhead, combined with the non-deterministic nature of garbage collection when old buffers are discarded, results in unpredictable frame times. While ImageBitmap offers efficient transfer to the GPU, the creation of the bitmap itself on the CPU side remains a heavy operation that can block the worker thread, preventing it from processing subsequent tile requests.1

### **2.2 The SharedArrayBuffer Paradigm**

To achieve true parallelism without the overhead of ownership transfer or copying, the architecture must utilize SharedArrayBuffer (SAB). Unlike standard ArrayBuffers, an SAB references a block of memory that can be mapped into the address space of multiple web workers and the main thread simultaneously.2 This effectively mimics the shared memory model of native multi-threaded applications using Pthreads in C or C++.

By allocating a large, contiguous slab of memory (e.g., 256MB) at the application's startup within the main process, and passing this reference to a pool of WASM workers, we establish a "Zero-Copy" pipeline. The WASM module, configured with the \-s SHARED\_MEMORY=1 flag during compilation, treats this SAB as its linear memory (or a portion thereof).6

When MuPDF renders a page, instead of allocating a local buffer within the WASM heap that must be extracted, we direct the renderer to write pixels directly into a specific offset within the SharedArrayBuffer. The function fz\_new\_pixmap\_with\_bbox\_and\_data is critical here; it allows the initialization of a pixmap struct that wraps an existing block of data rather than allocating new heap memory.7

### **2.3 Synchronization and Atomic Operations**

The power of shared memory comes with the peril of race conditions. If the main thread attempts to read a tile while a worker is still writing to it, the user will see visual artifacts (tearing) or incomplete data. To manage this, we employ Atomics, a JavaScript API that provides thread-safe operations on shared memory.5

The architecture defines a specific memory layout where the first section of the SAB is reserved for "Control Flags"—a set of 32-bit integers representing the state of each tile slot (e.g., 0: EMPTY, 1: WRITING, 2: READY, 3: READING).

**Operational Flow:**

1. **Allocation:** The main thread identifies a free slot in the SAB and sets its status to WRITING via Atomics.store().  
2. **Dispatch:** The main thread sends a lightweight message to the worker: "Render Tile X into Slot Y."  
3. **Execution:** The worker computes the pixel data and writes it to the SAB at the calculated offset.  
4. **Commit:** Upon completion, the worker performs Atomics.store(SlotY\_Status, READY) and creates a memory fence to ensure all writes are propagated.  
5. **Display:** The main thread, monitoring the status flags (either via polling in requestAnimationFrame or Atomics.wait() in a dedicated compositor worker), detects the state change. It then creates a Uint8ClampedArray view on the SAB offset and uploads it to the GPU.8

This mechanism ensures that the heavy pixel data never crosses the thread boundary via message passing. Only tiny metadata packets and state flags are exchanged, reducing the inter-thread communication overhead to negligible levels (microseconds).

### **2.4 Electron-Specific Security Headers**

Implementing SharedArrayBuffer in an Electron environment requires strict adherence to security protocols introduced to mitigate Spectre and Meltdown vulnerabilities. The renderer process must be "cross-origin isolated." This is achieved by configuring the Electron session to serve the application with specific HTTP headers:

* Cross-Origin-Opener-Policy: same-origin  
* Cross-Origin-Embedder-Policy: require-corp

Without these headers, the global SharedArrayBuffer constructor is hidden from the window object, causing the application to fail.9 For an Obsidian plugin, which operates within a local file context or a controlled file:// protocol, developers must ensure that the main Electron process intercepts protocol requests to inject these headers, or use the webPreferences configuration to enable the requisite security features explicitly.

## **3\. The Computation Engine: MuPDF and WASM Optimization**

The choice of rendering engine is pivotal. While PDF.js is the standard for web rendering, it is implemented entirely in JavaScript. For massive documents, the Just-In-Time (JIT) compilation and garbage collection of JS objects struggle to maintain performance. MuPDF, written in portable C, offers a significant performance advantage due to its highly optimized rasterizer and low memory footprint. However, porting C to the web via WebAssembly requires a sophisticated compilation strategy to retain these native performance characteristics.

### **3.1 WASM Compilation Flags and SIMD**

The performance of the resulting WASM binary is heavily dependent on the flags passed to the Emscripten compiler. Standard optimizations like \-O3 perform aggressive code transformation, loop unrolling, and function inlining.12 However, the critical optimization for graphical applications is **SIMD (Single Instruction, Multiple Data)**.

PDF rendering involves massive amounts of arithmetic operations on pixel data—color space conversion (CMYK to RGB), alpha blending, and anti-aliasing interpolation. A standard scalar CPU instruction processes one pixel component at a time. SIMD instructions allow the processor to operate on 128-bit vectors, effectively processing four 32-bit pixels in a single cycle.14

Benchmarks on image manipulation algorithms demonstrate that enabling SIMD in WASM (-msimd128) can yield speedups of 2x to 4x compared to scalar execution.16 For the Obsidian plugin, this translates to faster page load times and smoother zooming. The compilation command must strictly include \-msimd128 and potentially \-flto (Link Time Optimization) to allow the compiler to optimize across the boundary of MuPDF's internal object files, removing redundant code paths and inlining small helper functions crucial for the tight loops of the rasterizer.13

### **3.2 Threading and Context Management**

MuPDF's internal architecture relies on a global context (fz\_context) which is not inherently thread-safe for concurrent rendering without explicit locking. In a multi-worker environment, sharing a single context across threads would require mutex locks that serialize execution, negating the benefits of parallelism.

The optimal strategy involves using **Thread-Local Contexts**. Each WASM worker is initialized with its own fz\_context using fz\_clone\_context. This creates a lightweight clone of the global state (caches, error handlers) while allowing independent execution.18

However, the fz\_document structure (the parsed PDF representation) is heavy. Parsing the PDF in every worker consumes excessive memory. The solution is to parse the document once in the main thread (or a dedicated I/O worker) and pass the underlying data pointer or file descriptor to the workers. MuPDF supports "cloning" document handles or reopening documents efficiently if the underlying I/O stream is managed correctly. By ensuring each worker has an isolated context but shares read-only access to the document data, we achieve scalable parallelism.

### **3.3 The Role of Display Lists**

A naive rendering loop parses the PDF syntax and rasterizes it to pixels in one pass. This is inefficient for zooming. If a user zooms from 100% to 150%, the parser must re-read the PDF objects, re-decode images, and re-calculate positions.

MuPDF provides an intermediate structure called a **Display List** (fz\_display\_list). This is a resolution-independent recording of the drawing commands (e.g., "draw text 'Hello' at 10,10", "draw image X at 50,50").

**Optimization Strategy (H):**

1. **Parse Phase:** When a page is first loaded, the worker parses it into an fz\_display\_list rather than a pixmap. This list is stored in the worker's heap.  
2. **Rasterize Phase:** When the user requests a tile at a specific zoom level, the worker "plays back" the display list onto the destination pixmap.  
3. **Zooming:** If the user zooms, the worker simply replays the *existing* display list at a new scale factor. This bypasses the expensive parsing and image decoding steps (as decoded images are cached within the list resource store), significantly reducing the latency of zoom operations.19

### **3.4 Reducing Binary Size**

One of the criticisms of including a full PDF engine like MuPDF is the binary size, which can exceed 15-20MB. This impacts the "Time to Interactive" metric as the WASM module must be downloaded (or loaded from disk) and compiled by the browser.

Analysis of the MuPDF build process reveals that a substantial portion of this size is attributed to the CJK (Chinese, Japanese, Korean) font packs and support for non-PDF formats like XPS, SVG, and EPUB. By modifying config.h and the Makefile, developers can create a "lean" build. Explicitly disabling \#define FZ\_ENABLE\_XPS 0 and excluding the droid-sans-fallback fonts (relying instead on OS-provided fonts passed into the WASM instance) can reduce the binary size to under 5MB.20 This lean binary allows for faster instantiation of the worker pool, critical for the responsiveness of the Obsidian plugin.

## **4\. Multi-Worker Tiling Architecture: Parallelizing the Pipeline**

Rendering a single high-resolution PDF page is a blocking operation that can take 100ms-500ms depending on complexity. To achieve 60fps (16ms per frame), the main thread must never be blocked by rendering. Furthermore, rendering the entire page at once is inefficient if only a small viewport is visible. The solution is a **Tiled Rendering Architecture** distributed across a pool of workers.

### **4.1 The Quadtree Tiling Strategy**

We subdivide the PDF page into a grid of tiles. A standard tile size of 256x256 or 512x512 pixels balances the overhead of draw calls against the granularity of memory management. However, a flat grid is insufficient for a zoomable interface. We implement a **Quadtree** structure.22

* **Root Level (LOD 0):** The entire page is represented by a single low-resolution tile (thumbnail).  
* **Level 1:** The page is split into 4 quadrants.  
* **Level 2:** Each quadrant is split again (16 tiles total).

This hierarchical structure allows for **Level-of-Detail (LOD)** management. When the user is zoomed out, the system requests only the Level 0 or Level 1 tiles. As the user zooms in to a specific area, the system traverses the Quadtree to identify the specific Level 4 or Level 5 tiles required for the viewport, ignoring the hundreds of other tiles at that resolution.22

### **4.2 Work Stealing and Job Queues**

To manage the worker pool (sized typically to navigator.hardwareConcurrency \- 1), we avoid statically assigning pages to workers. A static assignment can lead to "stragglers"—a worker stuck on a complex vector-heavy page while others sit idle.

Instead, we implement a **Centralized Job Queue** in the main thread.

1. **Prioritization:** The main thread calculates the set of required tiles based on the current viewport and push them to the queue.  
2. **Fetching:** Idle workers request a job from the queue.  
3. **Work Stealing:** If a worker finishes its tasks, it can "steal" low-priority prefetch tasks from the tail of the queue.

This ensures maximal utilization of the CPU cores. The priority algorithm is strictly strictly:

1. **Visible Tiles:** Tiles currently intersecting the viewport.  
2. **Imminent Tiles:** Tiles within 1 screen length of the scrolling direction.  
3. **Speculative Tiles:** Lower resolution tiles for the whole page (to serve as placeholders during fast seeking).

### **4.3 Velocity-Based Prefetching Algorithms**

A key requirement for "native-like" feel is the absence of blank space during rapid scrolling. This requires **Predictive Prefetching**. Standard prefetching loads all neighbors, but this wastes bandwidth and memory. We implement a physics-based model derived from mapping applications.24

Algorithm D: Velocity Vector Prediction  
We calculate the user's scroll velocity vector $\\vec{v} \= (v\_x, v\_y)$ in pixels per frame.  
The "Lookahead Distance" $d$ is dynamically adjusted: $d \= k \\cdot |\\vec{v}|$, where $k$ is a tuning constant (e.g., 2.0 seconds of scrolling time).  
The scheduler identifies tiles that intersect the bounding box defined by $\[current\\\_scroll, current\\\_scroll \+ \\vec{v} \\cdot k\]$. This "Cone of Vision" ensures that we strictly prioritize the data the user is *about* to see. If the user is scrolling vertically, we do not prefetch horizontal neighbors. If the user stops scrolling, the velocity decays, and the prefetcher reverts to a standard concentric neighborhood loading strategy.26

## **5\. Memory Management: The 500MB Constraint**

Electron applications are notorious for memory bloat. The V8 engine's garbage collector is lazy; it prefers to allocate more memory rather than pause execution to clean up. In a PDF viewer creating hundreds of 1MB tile buffers, this leads to rapid heap expansion until the 4GB V8 limit (or system limit) is hit, causing a crash.28

### **5.1 The LRU Cache with Object Pooling**

To adhere to the strict 500MB limit, we cannot rely on the browser's GC. We must implement a manual **Least Recently Used (LRU) Cache** for tile data.

**The Memory Budget:**

* **V8 Heap:** \~100MB (Application logic, DOM, Plugin overhead).  
* **WASM/Shared Memory:** \~300MB (Pixel Cache).  
* **GPU Memory:** Managed separately but correlated.

300MB allows for caching approximately 75 tiles at 1024x1024 (4MB each). This covers roughly 10 full 1080p screens.

Eviction Policy:  
When the cache is full, the LRU algorithm selects the tile that is furthest from the current viewport (spatial distance) and has not been accessed recently. Crucially, we do not delete the Uint8Array or free the SAB slot. We simply mark the slot as "Dirty/Available" in our metadata. The next tile request overwrites this memory.  
Impact on GC:  
By reusing a fixed set of SAB slots (Object Pooling), we eliminate the allocation/deallocation cycle. The V8 GC sees a stable heap size. This prevents the "Stop-the-World" GC pauses that cause frame drops in traditional implementations.30

### **5.2 The V8 Memory Cage and Electron**

Modern Electron versions (14+) enable the V8 Memory Cage (Pointer Compression), which creates a hard 4GB limit on the V8 heap and prevents ArrayBuffers from pointing to external memory addresses securely.32

This constraint validates our SharedArrayBuffer approach. Since the SAB is allocated within the V8 heap (or managed as a compliant backing store), it plays nicely with the memory cage. In contrast, attempting to use Node.js C++ addons (N-API) to malloc system RAM and pass it to JS as a Buffer is now a risky pattern that can lead to security crashes or instability in Electron.32 Our WASM-centric approach bypasses this by staying within the WebAssembly memory model, which is sandboxed and managed by the runtime in a way that respects V8's boundaries.

## **6\. GPU Acceleration: WebGL and OffscreenCanvas**

The final stage of the pipeline is compositing the tiles onto the screen. DOM-based tiling (creating thousands of \<div\> or \<img\> elements) is the "Death of Performance" due to reflow and layout thrashing. The "native-like" solution is a single Canvas element.

### **6.1 OffscreenCanvas Architecture**

We utilize OffscreenCanvas, which allows a Worker thread (the "Compositor Worker") to control a \<canvas\> element without blocking the main UI thread.33

**The Compositor Pipeline:**

1. **Input:** The Compositor Worker receives "Ready" signals from the Decoder Workers (pointing to SAB slots).  
2. **Upload:** The Compositor creates a WebGL texture from the SAB data (gl.texImage2D).  
3. **Draw:** The Compositor runs a render loop synced to requestAnimationFrame. It clears the canvas and draws textured quads for every visible tile based on the current scroll transform.

### **6.2 WebGL vs. 2D Context**

Benchmarks indicate that WebGL significantly outperforms the 2D Canvas Context (drawImage) for this use case.34

* **Scaling:** WebGL handles fractional zoom levels (e.g., 1.34x) with hardware-accelerated linear interpolation, whereas 2D context scaling is CPU-heavy.  
* **Compositing:** Blending tiles and handling overlaps is virtually free on the GPU.  
* **Texture Management:** We can explicitly manage GPU memory by calling gl.deleteTexture when our LRU cache evicts a tile, ensuring we don't leak VRAM (a common issue in Electron apps).36

**Texture Atlas:** For optimal performance, rather than creating one texture per tile, we can implement a "Texture Atlas"—a single large texture (e.g., 4096x4096) where we slot in smaller tiles. This reduces draw calls and state changes, though it adds complexity to the memory management logic.

## **7\. Electron-Specific Constraints and Solutions**

Developing for Electron introduces nuances absent in standard web development.

### **7.1 Process Isolation**

Electron runs the main logic in the "Main Process" and the UI in "Renderer Processes." The GPU runs in its own process. Massive data transfer between the Renderer and GPU process (texture uploads) can bottleneck.

* **Constraint:** The GPU process has its own memory limit. If we upload 2GB of textures, the GPU process may crash even if the Renderer is fine.36  
* **Solution:** Strict texture recycling. We mirror the CPU-side LRU cache with a GPU-side texture cache. We never keep more textures in VRAM than strictly necessary for the current view \+ a small prefetch buffer.

### **7.2 Native Modules vs. WASM**

While native Node.js modules (C++ addons) offer direct system access, they introduce stability risks (a segfault crashes the app) and distribution complexity (compiling for every OS). WASM provides a "Write Once, Run Everywhere" binary that is sandboxed. If a specific PDF causes a crash in WASM, only the worker dies, and the plugin can restart it gracefully without crashing Obsidian. This resilience is critical for a plugin ecosystem.

## **8\. Summary of Recommendations**

To achieve the goal of a 60fps, low-memory PDF reader in Obsidian:

1. **Build System:** Compile MuPDF to **WASM** with **SIMD** (-msimd128), **LTO** (-flto), and **Pthreads** (-s USE\_PTHREADS=1). Strip fonts to reduce binary size.20  
2. **Architecture:** Implement a **Main Thread \-\> Compositor Worker \-\> Decoder Pool** topology.  
3. **Data Transport:** Use a pre-allocated **SharedArrayBuffer** for all pixel data. Use **Atomics** for state synchronization. **Zero copies** allowed.  
4. **Tiling:** Use a **Quadtree** index with **Velocity-Based Prefetching** to predictively load tiles.  
5. **Rendering:** Use **OffscreenCanvas** with **WebGL** for hardware-accelerated composition.  
6. **Memory:** Enforce a strict **LRU Cache** using **Object Pooling** on the SAB slots to prevent GC pauses.

### **Comparative Data: Proposed Architecture vs. Standard Approaches**

| Metric | Standard (PDF.js / DOM) | Native Module (C++) | Proposed (WASM \+ SAB) |
| :---- | :---- | :---- | :---- |
| **Decoding Speed** | Low (JS JIT overhead) | High (Native Speed) | **High** (Near-Native with SIMD) |
| **Data Transport** | Slow (Structured Clone) | Fast (External Buffer) | **Instant** (Shared Memory) |
| **Main Thread Block** | High (Parsing/Layout) | Low (Async) | **Zero** (Worker-based) |
| **Memory Safety** | High (Managed JS) | Low (Segfault risk) | **High** (Sandboxed) |
| **Zoom Performance** | Jerky (Re-layout) | Smooth | **Smooth** (WebGL scaling) |
| **Portable** | Yes | No (OS-specific builds) | **Yes** (Standard Web Tech) |

This architecture represents the state-of-the-art for high-performance web graphics and aligns perfectly with the constraints and capabilities of the Electron environment hosting Obsidian.

## **9\. Future Outlook**

The landscape of web assembly is evolving. The **WASM GC Proposal** 37 promises to allow WASM to reference host GC objects directly, potentially simplifying the interop layer in the future. Additionally, **WebGPU** is poised to replace WebGL, offering even lower-overhead access to the GPU for compositing tasks. However, for the current generation of Electron (and Obsidian), the SharedArrayBuffer \+ WebGL pipeline remains the gold standard for performance.

#### **Obras citadas**

1. Transferable objects \- Lightning fast | Blog \- Chrome for Developers, fecha de acceso: enero 9, 2026, [https://developer.chrome.com/blog/transferable-objects-lightning-fast](https://developer.chrome.com/blog/transferable-objects-lightning-fast)  
2. Web workers in JavaScript and when to use them \- bene : studio, fecha de acceso: enero 9, 2026, [https://benestudio.co/web-workers-in-javascript-and-when-to-use-them/](https://benestudio.co/web-workers-in-javascript-and-when-to-use-them/)  
3. Web Workers II — Internals and Data Transfer | by Ayush Maurya, fecha de acceso: enero 9, 2026, [https://medium.com/@ayushmaurya461/web-workers-ii-internals-and-data-transfer-fe960e45e274](https://medium.com/@ayushmaurya461/web-workers-ii-internals-and-data-transfer-fe960e45e274)  
4. Enhancing Web Worker Performance with Transferable Objects in ..., fecha de acceso: enero 9, 2026, [https://ksrae.github.io/angular/webworker-heavy-data/](https://ksrae.github.io/angular/webworker-heavy-data/)  
5. Sharedarraybuffer mechanics \- Rust Users Forum, fecha de acceso: enero 9, 2026, [https://users.rust-lang.org/t/sharedarraybuffer-mechanics/102393](https://users.rust-lang.org/t/sharedarraybuffer-mechanics/102393)  
6. Using shared WebAssembly.Memory (SharedArrayBuffer) with non ..., fecha de acceso: enero 9, 2026, [https://github.com/emscripten-core/emscripten/discussions/16596](https://github.com/emscripten-core/emscripten/discussions/16596)  
7. mupdf/fitz/fitz.h at master · mariusmuja/mupdf \- GitHub, fecha de acceso: enero 9, 2026, [https://github.com/mariusmuja/mupdf/blob/master/fitz/fitz.h](https://github.com/mariusmuja/mupdf/blob/master/fitz/fitz.h)  
8. Javascript Synchronize SharedArrayBuffer to main thread, fecha de acceso: enero 9, 2026, [https://stackoverflow.com/questions/45439334/javascript-synchronize-sharedarraybuffer-to-main-thread](https://stackoverflow.com/questions/45439334/javascript-synchronize-sharedarraybuffer-to-main-thread)  
9. WASM writes to SharedArrayBuffer not visible to workers ... \- GitHub, fecha de acceso: enero 9, 2026, [https://github.com/oven-sh/bun/issues/25677](https://github.com/oven-sh/bun/issues/25677)  
10. SharedArrayBuffer \- JavaScript \- MDN Web Docs, fecha de acceso: enero 9, 2026, [https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global\_Objects/SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)  
11. Enable SharedArrayBuffer on localhost \- Stack Overflow, fecha de acceso: enero 9, 2026, [https://stackoverflow.com/questions/70535752/enable-sharedarraybuffer-on-localhost](https://stackoverflow.com/questions/70535752/enable-sharedarraybuffer-on-localhost)  
12. MSYS2 Packages, fecha de acceso: enero 9, 2026, [https://packages.msys2.org/package/](https://packages.msys2.org/package/)  
13. Improving performance using WebAssembly SIMD Intrinsics, fecha de acceso: enero 9, 2026, [https://jeromewu.github.io/improving-performance-using-webassembly-simd-intrinsics/](https://jeromewu.github.io/improving-performance-using-webassembly-simd-intrinsics/)  
14. WebAssembly and SIMD \- Wasmer, fecha de acceso: enero 9, 2026, [https://blog.wasmer.io/webassembly-and-simd-13badb9bf1a8](https://blog.wasmer.io/webassembly-and-simd-13badb9bf1a8)  
15. Algorithmic Optimizations: How to Leverage SIMD \- News \- Blippar, fecha de acceso: enero 9, 2026, [https://www.blippar.com/technology/2024/11/11/algorithmic-optimizations-how-to-leverage-simd](https://www.blippar.com/technology/2024/11/11/algorithmic-optimizations-how-to-leverage-simd)  
16. Exploring SIMD performance improvements in WebAssembly, fecha de acceso: enero 9, 2026, [https://www.awelm.com/posts/simd-web-assembly-experiment](https://www.awelm.com/posts/simd-web-assembly-experiment)  
17. Boosting WebAssembly Performance with SIMD and Multi-Threading, fecha de acceso: enero 9, 2026, [https://www.infoq.com/articles/webassembly-simd-multithreading-performance-gains/](https://www.infoq.com/articles/webassembly-simd-multithreading-performance-gains/)  
18. MuPDF 1.24.0 documentation, fecha de acceso: enero 9, 2026, [https://mupdf.readthedocs.io/en/1.24.0/](https://mupdf.readthedocs.io/en/1.24.0/)  
19. An Improved MuPDF API Using C++ \- Artifex Software, fecha de acceso: enero 9, 2026, [https://artifex.com/blog/an-improved-mupdf-api-using-c-plus-plus](https://artifex.com/blog/an-improved-mupdf-api-using-c-plus-plus)  
20. Mupdf compile with only pdf support \- Stack Overflow, fecha de acceso: enero 9, 2026, [https://stackoverflow.com/questions/38168518/mupdf-compile-with-only-pdf-support](https://stackoverflow.com/questions/38168518/mupdf-compile-with-only-pdf-support)  
21. platform/wasm/Makefile \- Joffrey Wallaart / mupdf \- TU Delft Gitlab, fecha de acceso: enero 9, 2026, [https://gitlab.tudelft.nl/joffreywallaar/mupdf/-/blob/f37e92866b7066d506f5d66e0ec59dd7e2e42516/platform/wasm/Makefile](https://gitlab.tudelft.nl/joffreywallaar/mupdf/-/blob/f37e92866b7066d506f5d66e0ec59dd7e2e42516/platform/wasm/Makefile)  
22. QuadTree Visualizer, fecha de acceso: enero 9, 2026, [https://www.ijert.org/research/quadtree-visualizer-IJERTV11IS040156.pdf](https://www.ijert.org/research/quadtree-visualizer-IJERTV11IS040156.pdf)  
23. ajuc/jsPointQuadtree: Quad tree for compression of 2d tile maps., fecha de acceso: enero 9, 2026, [https://github.com/ajuc/jsPointQuadtree](https://github.com/ajuc/jsPointQuadtree)  
24. Probability-Based Tile Pre-fetching and Cache Replacement ..., fecha de acceso: enero 9, 2026, [https://homes.cs.aau.dk/\~simas/teaching/map\_download/MobilePrefetching2.pdf](https://homes.cs.aau.dk/~simas/teaching/map_download/MobilePrefetching2.pdf)  
25. Dynamic Prefetching of Data Tiles for Interactive Visualization, fecha de acceso: enero 9, 2026, [https://homes.cs.washington.edu/\~leibatt/static/papers/forecache\_cr\_sigmod2016.pdf](https://homes.cs.washington.edu/~leibatt/static/papers/forecache_cr_sigmod2016.pdf)  
26. Dynamic Viewport Selection-Based Prioritized Bitrate Adaptation for ..., fecha de acceso: enero 9, 2026, [https://3dvar.com/Yaqoob2022Dynamic.pdf](https://3dvar.com/Yaqoob2022Dynamic.pdf)  
27. Dynamic Viewport Selection-based Prioritized Bitrate Adaptation for ..., fecha de acceso: enero 9, 2026, [https://www.eeng.dcu.ie/\~munteang/papers/2022\_ACC\_10\_3\_AY.pdf](https://www.eeng.dcu.ie/~munteang/papers/2022_ACC_10_3_AY.pdf)  
28. \[Bug\]: memory limitations introduced with Electron 14+ · Issue \#31330, fecha de acceso: enero 9, 2026, [https://github.com/electron/electron/issues/31330](https://github.com/electron/electron/issues/31330)  
29. max-old-space-size in Node.js: A Deep Dive into Memory ... \- Medium, fecha de acceso: enero 9, 2026, [https://medium.com/@nagasai317/understanding-max-old-space-size-in-node-js-a-deep-dive-into-memory-management-7955e9d79ad0](https://medium.com/@nagasai317/understanding-max-old-space-size-in-node-js-a-deep-dive-into-memory-management-7955e9d79ad0)  
30. Trash talk: the Orinoco garbage collector \- V8 JavaScript engine, fecha de acceso: enero 9, 2026, [https://v8.dev/blog/trash-talk](https://v8.dev/blog/trash-talk)  
31. Debugging memory leaks in WebAssembly using Emscripten | Articles, fecha de acceso: enero 9, 2026, [https://web.dev/articles/webassembly-memory-debugging](https://web.dev/articles/webassembly-memory-debugging)  
32. Electron and the V8 Memory Cage, fecha de acceso: enero 9, 2026, [https://electronjs.org/blog/v8-memory-cage](https://electronjs.org/blog/v8-memory-cage)  
33. OffscreenCanvas—speed up your canvas operations with a web ..., fecha de acceso: enero 9, 2026, [https://web.dev/articles/offscreen-canvas](https://web.dev/articles/offscreen-canvas)  
34. WebGL vs Canvas: Best Choice for Browser-Based CAD Tools, fecha de acceso: enero 9, 2026, [https://altersquare.io/webgl-vs-canvas-best-choice-for-browser-based-cad-tools/](https://altersquare.io/webgl-vs-canvas-best-choice-for-browser-based-cad-tools/)  
35. WebGL vs. 2D Canvas Comparison, fecha de acceso: enero 9, 2026, [https://2dgraphs.netlify.app/](https://2dgraphs.netlify.app/)  
36. \[Feature Request\]: Ability to limit gpu-process system memory usage, fecha de acceso: enero 9, 2026, [https://github.com/electron/electron/issues/31354](https://github.com/electron/electron/issues/31354)  
37. WebAssembly Garbage Collection (WasmGC) now enabled by ..., fecha de acceso: enero 9, 2026, [https://developer.chrome.com/blog/wasmgc](https://developer.chrome.com/blog/wasmgc)  
38. A new way to bring garbage collected programming languages ..., fecha de acceso: enero 9, 2026, [https://v8.dev/blog/wasm-gc-porting](https://v8.dev/blog/wasm-gc-porting)
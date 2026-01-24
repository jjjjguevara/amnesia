# PDF Rendering Performance Optimization - Research & Implementation Plan

## Non-Negotiables

Before diving into analysis, these are the **absolute requirements** that cannot be compromised:

| Requirement | Specification | Rationale |
|-------------|---------------|-----------|
| **5 Display Modes** | All must perform excellently: Paginated, Vertical-Scroll, Horizontal-Scroll, Auto-Grid, Canvas | Users switch modes based on task; no "slow mode" is acceptable |
| **Pixel-Perfect Fonts** | Crisp text at 16x+ zoom on Retina displays | Academic/professional users zoom to examine details |
| **60 FPS** | Smooth scrolling/panning at all zoom levels | Stuttering destroys reading experience |
| **Zero Text Detection Sacrifice** | Full text layer accuracy in all modes | Search, selection, annotations depend on this |
| **Electron Runtime** | Must run in Obsidian's Electron (no native code) | Plugin distribution requirement |
| **MuPDF Engine** | Cannot switch PDF engines | Licensing, quality, feature completeness |
| **Offline Operation** | Core rendering must work without server | Users expect offline reading |
| **Memory Budget** | <500MB for 1000-page PDFs | Must coexist with other Obsidian plugins |

## Phase 1: Current State Analysis (Complete)

### Executive Summary

We are building a high-performance PDF reader for Obsidian using MuPDF compiled to WASM. Despite a sophisticated architecture with 3-tier caching, velocity-based prefetching, and priority-based rendering, our performance still lags behind simpler JavaScript-based PDF readers (including Obsidian's built-in PDF viewer).

### Current Tech Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| **Platform** | Electron (Chromium 120+) | Obsidian's runtime |
| **PDF Engine** | MuPDF 1.27.0 | WASM build via npm package |
| **Worker** | Web Worker | Single worker, semaphore-limited concurrency |
| **Rendering** | Canvas 2D API | No WebGL/GPU acceleration |
| **Caching** | 3-tier LRU | L1=50 tiles, L2=200 tiles/200MB, L3=metadata |
| **Transfer** | PNG Blobs + Transferable | Not raw bitmaps |
| **Rust Server** | MuPDF 0.5 Rust bindings | For server-side rendering (optional) |

### Display Mode Architecture

Amnesia implements **5 distinct PDF display modes** with mode-specific rendering strategies:

| Mode | Layout | Tiling Strategy | Prefetch Strategy | Primary Bottleneck |
|------|--------|-----------------|-------------------|-------------------|
| **Paginated** | Multi-page fit-to-view | >2x zoom: tile, else full-page | ±1 page radius | Initial load (100-300ms) |
| **Vertical-Scroll** | Single column, continuous | Always tiled (256×256) | Velocity-based 1-4x viewport | Tile throughput at >500px/s |
| **Horizontal-Scroll** | Single row, all pages | Always tiled | Velocity-based | Same as vertical + wider viewport |
| **Auto-Grid** | Dynamic columns (zoom-based) | Never tiled (thumbnails) | Ripple from center (Chebyshev) | Thumbnail generation (3-5s/100pg) |
| **Canvas** | Fixed grid (10 columns) | >4x zoom: tile | 2D spatial ripple | Extreme zoom render (2-5s at 16x) |

**Mode → Strategy Mapping:**
- `paginated` → `PaginatedStrategy` (210 lines)
- `vertical-scroll`, `horizontal-scroll` → `ScrollStrategy` (600+ lines)
- `auto-grid`, `canvas` → `GridStrategy` (324 lines)

### PDF Content Type Analysis (Currently Unused)

MuPDF exposes APIs to analyze PDF internal structure, but **Amnesia does not currently leverage this**:

| Content Type | Characteristics | Detection Method | Optimization Opportunity |
|--------------|-----------------|------------------|-------------------------|
| **Scanned/Raster** | 1 XObject/page, no text ops | Count `/XObject`, parse content stream | Direct JPEG decode (skip MuPDF render) |
| **Vector** | Many path ops, no images | Count `m`,`l`,`c`,`h` operators | Lower scale, rely on anti-aliasing |
| **Text-Heavy** | Text ops dominate | Count `Tj`,`TJ` operators | Aggressive caching, high-quality text |
| **Mixed** | Balanced operator counts | Heuristic analysis | Standard rendering |
| **OCR'd** | Image + invisible text | Image XObject + zero-size text | Render image, overlay text layer |

**Untapped APIs:**
- `PDFDocument.findPage(n).get("Resources")` → XObject/Font dictionaries
- `PDFObject.readStream()` → Content stream for operator analysis
- `PDFPage.getObject().get("ExtGState")` → Transparency detection

### Identified Performance Bottlenecks

#### Tier 1: Critical (10-50ms+ latency)

1. **PNG Encoding in Worker** (10-50ms/tile)
   - Location: `mupdf-worker.ts:166, 262` - `pixmap.asPNG()`
   - Root cause: Every render goes Pixmap → PNG compress → Blob → transfer → PNG decode → ImageBitmap
   - Alternative: Raw RGBA transfer would eliminate encode+decode (~15-70ms savings)

2. **createImageBitmap() Decode** (1-5ms/tile)
   - Location: `tile-cache-manager.ts:222, 236`
   - Root cause: Even cache hits pay PNG decode cost
   - Alternative: Store ImageBitmaps directly (but lifecycle complexity)

3. **Text Extraction Serialization** (50-200ms/page)
   - Location: `mupdf-worker.ts:281-370`
   - Root cause: Complex nested objects (lines → chars → quads) can't use Transferable
   - Alternative: Flatten to TypedArray, use SharedArrayBuffer

#### Tier 2: Moderate (5-20ms latency)

4. **MuPDF page.run()** (5-15ms/tile)
   - Root cause: PDF interpretation + rasterization
   - Potential: Display list caching could skip re-parsing

5. **Worker Message Overhead** (~1-2ms/round-trip)
   - Root cause: postMessage serialization even for small payloads
   - Potential: Batch multiple requests, SharedArrayBuffer for hot path

6. **Scale Calculation at High Zoom**
   - At zoom 16x + 2x DPR, scale = 32, tiles become 8192×8192 pixels
   - Memory pressure: ~268MB per tile uncompressed

#### Tier 3: Systemic

7. **Single Worker Bottleneck**
   - Only 1 MuPDF WASM instance, semaphore-limited to 8 concurrent
   - True parallelism requires multiple workers (but 2-4x WASM memory)

8. **No Memory Pressure Handling**
   - L1 cache has no byte limit
   - No dynamic cache resizing based on heap usage
   - Blob URL leak in MuPDF bridge

9. **Suboptimal Prefetch Tuning**
   - Speed zone thresholds may not match real user behavior
   - No ML-based scroll prediction

### High Zoom Requirements (16x+)

**Scale Calculation for Crisp Fonts:**
```
effectiveRatio = (renderScale × pixelRatio) / cssZoom
For crisp text: effectiveRatio >= 2.0 (Retina quality)

Example: 16x zoom on 2x DPR display
- renderScale = 16 × 2 = 32
- effectiveRatio = 32 / 16 = 2.0 ✓
- DPI = 72 × 32 = 2304 DPI (maximum supported)
```

**Memory at Extreme Zoom:**

| Render Type | Scale | Resolution | Memory | Feasible? |
|-------------|-------|------------|--------|-----------|
| Full-page | 16 | 9792×12672 | ~497 MB | ❌ OOM |
| Full-page | 32 | 19584×25344 | ~1.9 GB | ❌ Crash |
| Tile (256px) | 32 | 8192×8192 | 256 MB/tile | ⚠️ With caching |
| 40 visible tiles | 32 | - | ~10 GB total | ❌ Must render on-demand |

**Current Solution:** Tile-based rendering with on-demand fetching, L1/L2 cache limits prevent OOM.

### Current Timing Constants

| Constant | Value | Rationale |
|----------|-------|-----------|
| `SCROLL_RERENDER_DEBOUNCE` | 32ms | ~2 frames responsiveness |
| `ZOOM_RERENDER_DEBOUNCE` | 150ms | Wait for gesture completion |
| `MAX_CONCURRENT_RENDERS` | 8 | Semaphore limit |
| `TILE_SIZE` | 256px | CATiledLayer standard |
| `L1_CACHE_SIZE` | 50 tiles | ~6 pages |
| `L2_CACHE_SIZE` | 200 tiles / 200MB | ~25 pages |
| `MAX_TILE_SCALE` | 32 | Crisp at 16x zoom + Retina |

### Known Strengths (What's Working)

1. **Camera Snapshot Pattern** - Fixes "0 visible tiles" during fast scroll
2. **Priority-Based Rendering** - Critical tiles (0-0.5 viewport) render before low priority
3. **Velocity-Based Quality Adaptation** - 50% quality at >500 px/s scroll
4. **3-Tier Cache with Promotion** - L2 hits promote to L1
5. **Request Deduplication** - Same tile only rendered once
6. **Semaphore Concurrency** - Event-driven, not polling

### Known Weaknesses (What Needs Work)

1. **PNG Encode/Decode Overhead** - 15-70ms wasted per tile
2. **Single MuPDF Worker** - No true parallelism
3. **L1 Cache No Byte Limit** - Could exceed memory budget
4. **Blob URL Leak** - `cachedWorkerBlobUrl` never revoked
5. **No Content-Type Detection** - All PDFs rendered identically
6. **No Memory Pressure Handling** - No dynamic cache resizing
7. **Auto-Grid Initial Load** - 3-5s for 100 pages

---

## Phase 2: Research Prompt

### Context for Research

We are optimizing a PDF rendering pipeline for an Obsidian plugin. The goal is to achieve **native-like performance** (comparable to Preview.app, Adobe Reader, or Chrome's built-in PDF viewer) within the constraints of Electron/WASM.

**Non-negotiables:**
- Must run in Electron (no native code, no NAPI)
- Must use MuPDF (licensing, quality, feature completeness)
- Must support zoom 0.5x-16x with crisp rendering
- Must work offline (no server dependency for core rendering)
- Must not exceed ~500MB memory for 1000-page PDFs

**What we can change:**
- Transfer format (PNG → raw bitmap → WebP → etc.)
- Worker architecture (single → pool)
- Caching strategy (sizes, eviction, tiers)
- Prefetch algorithms
- WASM compilation flags (if we compile ourselves)
- Canvas API usage (2D → WebGL → OffscreenCanvas)

### Research Questions

#### A. Raw Bitmap Transfer vs PNG

1. What is the **actual latency breakdown** of PNG encode in MuPDF WASM vs raw RGBA transfer?
2. How do other high-performance WASM PDF renderers (pdf.js, pdfium.js) handle this?
3. What is the memory overhead of raw RGBA vs PNG Blob at various scales?
4. Can we use **WebP encoding** (faster encode, similar size) in MuPDF WASM?
5. Is **ImageBitmap direct creation in worker** (without PNG intermediate) possible?

#### B. Multi-Worker Architecture

1. What is the memory cost of multiple MuPDF WASM instances?
2. How do high-performance tiled renderers (Google Maps, Figma) scale workers?
3. What is the optimal worker count for Electron on typical hardware (4-8 cores)?
4. Can we share document state across workers (SharedArrayBuffer for document bytes)?
5. What load balancing strategy works best for tile workloads?

#### C. WASM Optimization

1. What **Emscripten flags** should we use for optimal MuPDF WASM performance?
   - `-O3 -flto`? SIMD? threading?
2. Can we enable **WASM SIMD** for matrix operations in MuPDF?
3. What is the impact of **WASM memory growth** vs pre-allocated heap?
4. Can we use **wasm-opt** for additional optimization passes?
5. What is the **minimum viable WASM binary size** for MuPDF (tree shaking)?

#### D. Caching & Prefetch

1. What cache eviction policies do top PDF readers use?
   - LRU, LFU, ARC, LIRS?
2. How do they handle **zoom-level-specific caching** (don't evict current zoom)?
3. What prefetch algorithms work best for **reading patterns** (linear, jumping)?
4. Can we use **IndexedDB for L4 cache** (persistent across sessions)?
5. What is the optimal **tile size** for various zoom levels (adaptive)?

#### E. GPU Acceleration

1. Can we use **WebGL** for PDF page compositing (like Figma)?
2. Is **OffscreenCanvas with WebGL** viable in Electron workers?
3. What is the latency difference between Canvas 2D and WebGL for tiled rendering?
4. Can we use **CSS transforms** for zoom (GPU compositing) instead of re-rendering?
5. How does Chrome's PDF viewer use GPU acceleration?

#### F. Electron-Specific Optimizations

1. Can we use **native Node modules** (N-API) for MuPDF? (Trade-off: portability)
2. What Chromium flags improve Canvas/WASM performance in Electron?
3. Is **process isolation** (BrowserView per PDF) worth the overhead?
4. Can we use Electron's **offscreen rendering** for background pages?
5. What are the **memory limits** in Electron renderer processes?

#### G. Benchmarking & Telemetry

1. What metrics define "good" PDF rendering performance?
   - First contentful paint? Time to interactive? Frame drops during scroll?
2. How do we measure **perceived smoothness** (not just FPS)?
3. What tools exist for WASM profiling (Chrome DevTools, wasm-specific)?
4. How do we create **reproducible benchmarks** for PDF rendering?
5. What telemetry should we collect in production for regression detection?

#### H. PDF Format & Content-Aware Rendering

1. How do high-performance PDF readers **classify PDF content types**?
   - Scanned (raster) vs vector vs text-heavy vs mixed
2. What PDF operators indicate page complexity?
   - Content stream analysis: `Tj`, `TJ`, `Do`, `m`, `l`, `c`, `re`, `S`, `f`, `B`
3. Can we **directly extract JPEG/PNG images** from XObjects without re-rendering?
   - `/XObject` → `/Subtype /Image` → `/Filter /DCTDecode` (JPEG) or `/FlateDecode` (PNG)
4. How do we detect **transparency requirements**?
   - `/ExtGState` with `/CA`, `/ca`, or `/SMask`
5. What PDF structures indicate **resource sharing** across pages?
   - Inherited resources, `/XRef` streams, `/ObjStm` (object streams)
6. How can we estimate **page complexity** without rendering?
   - Content stream size, operator count, XObject count
7. What are the **common PDF production patterns** we should optimize for?
   - LaTeX (vector fonts, equations), Word (embedded fonts), Scanned (single image), InDesign (complex layouts)

#### I. Display Mode-Specific Questions

1. How do other multi-mode viewers (Preview.app, Acrobat) handle mode transitions?
2. What is the optimal **thumbnail size** for grid modes?
3. How do infinite canvas tools (Figma, Miro) handle **extreme zoom**?
4. What **text layer strategies** work best for grid/canvas modes?
5. How should we handle **mode-specific prefetch** differently?

### Research Sources

#### GitHub Projects to Analyze (Priority Order)

| Project | Stars | Focus Areas | Research Questions |
|---------|-------|-------------|-------------------|
| **mozilla/pdf.js** | 48k+ | Worker architecture, canvas rendering, text layer | How do they handle multi-worker? What's their tile strategy? |
| **nicolo-nicaso/nicaso** | - | WASM PDF viewer | Compare WASM optimization approaches |
| **nicaso/nicaso-nicaso** | - | PDFium WASM port | How does PDFium WASM compare to MuPDF? |
| **nicaso/nicaso** | - | Official MuPDF WASM | Best practices from maintainers |
| **nicaso/nicaso** | - | Figma's canvas engine | How do they achieve 60fps with complex graphics? |
| **nicaso/nicaso** | - | Google Maps tiles | Industry-standard tile caching patterns |
| **nicaso/nicaso** | - | React PDF viewer | Alternative rendering approaches |
| **nicaso/nicaso** | - | High-performance canvas lib | Canvas optimization techniques |

#### Key Engineers / Experts to Research

| Person | Organization | Expertise | Where to Find |
|--------|--------------|-----------|---------------|
| Andreas Nicaso | MuPDF/Artifex | MuPDF internals, WASM compilation | MuPDF mailing list, GitHub |
| nicaso nicaso | Mozilla | pdf.js architecture | Mozilla Hacks blog, GitHub |
| nicaso nicaso | Nicaso | WebAssembly performance | nicaso blog |
| nicaso nicaso | Chrome | Skia/PDF rendering | Chromium design docs |
| nicaso nicaso | Nicaso | Canvas performance | nicaso blog |

#### Technical Resources

| Topic | Resource | URL Pattern |
|-------|----------|-------------|
| **WASM SIMD** | WebAssembly SIMD proposal | github.com/nicaso/nicaso |
| **Emscripten Optimization** | Emscripten docs | emscripten.org/docs/optimizing |
| **Chrome PDF** | Chromium design docs | chromium.googlesource.com |
| **ImageBitmap** | MDN Web Docs | developer.mozilla.org |
| **CATiledLayer** | Apple docs | developer.apple.com |
| **Tile Rendering** | Google Maps Platform | developers.google.com/maps |

#### PDF Format Specifications

| Resource | Coverage | Use For |
|----------|----------|---------|
| **PDF 2.0 (ISO 32000-2:2020)** | Complete spec | Understanding content streams, operators |
| **PDF Reference 1.7** | Adobe's original | Historical context, operator definitions |
| **MuPDF Source (C)** | Implementation details | How MuPDF interprets PDF internals |
| **qpdf documentation** | PDF structure analysis | Cross-reference, object streams |

### Proven Approaches (From Our Experience)

1. **Camera Snapshot Pattern** - Captures camera position at schedule time, not render time. Fixed "0 visible tiles" during fast scroll.

2. **Priority-Based Tile Rendering** - Critical (0-0.5 viewport) renders before Low (2.5+ viewport). Prevents distant tiles from blocking visible content.

3. **Velocity-Based Quality Adaptation** - Reduce quality to 50% during fast scroll (>500 px/s), upgrade when stopped. Trades quality for smoothness.

4. **3-Tier Cache with Promotion** - L2 hits promote to L1. Natural heat-based migration.

5. **Request Deduplication** - Multiple identical requests return same Promise. Prevents duplicate renders.

6. **Semaphore Concurrency Control** - Event-driven (not polling) limits concurrent renders to 8.

### Current Architecture (Detailed)

```
User Input (Wheel Event)
    │
    ├─── Zoom Gesture (Ctrl/Cmd + Wheel)
    │        │
    │        └─── zoomAtPoint() → applyTransform() [IMMEDIATE - GPU]
    │                  │
    │                  └─── scheduleZoomRerender() [150ms debounce]
    │
    └─── Pan Gesture (Normal Wheel)
             │
             └─── panCamera() → applyTransform() [IMMEDIATE - GPU]
                       │
                       ├─── Camera Snapshot [CAPTURED]
                       │
                       └─── scheduleScrollRerender() [32ms debounce]
                                 │
                                 ▼
             ┌─────────────────────────────────────┐
             │ updateVisiblePages()                │
             │ - O(1) page range calculation       │
             │ - 3-tier buffers (render/element/keep) │
             └─────────────────────────────────────┘
                                 │
                                 ▼
             ┌─────────────────────────────────────┐
             │ processRenderQueue()                │
             │ - Priority queue (neighbors first) │
             │ - CONCURRENT_RENDERS = 12 max      │
             └─────────────────────────────────────┘
                                 │
                                 ▼
             ┌─────────────────────────────────────┐
             │ RenderCoordinator                   │
             │ - Request deduplication (Map)       │
             │ - Cache check (L1 → L2)            │
             │ - Semaphore acquire (8 permits)    │
             └─────────────────────────────────────┘
                                 │
                                 ▼
             ┌─────────────────────────────────────┐
             │ MuPDF Worker (Web Worker)           │
             │ - page.loadPage()                   │
             │ - page.run(device, matrix) [5-15ms] │
             │ - pixmap.asPNG() [10-50ms] ❌ BOTTLENECK │
             │ - postMessage(png, [buffer])        │
             └─────────────────────────────────────┘
                                 │
                                 ▼
             ┌─────────────────────────────────────┐
             │ TileCacheManager                    │
             │ - set(key, blob) → L1/L2           │
             │ - LRU eviction                      │
             └─────────────────────────────────────┘
                                 │
                                 ▼
             ┌─────────────────────────────────────┐
             │ Canvas Pool Worker                  │
             │ - createImageBitmap(blob) [1-5ms]  │
             │ - Transfer ImageBitmap to main     │
             └─────────────────────────────────────┘
                                 │
                                 ▼
             ┌─────────────────────────────────────┐
             │ PDF Page Element                    │
             │ - ctx.drawImage(bitmap) [<1ms]     │
             │ - bitmap.close()                    │
             └─────────────────────────────────────┘
```

### Benchmarking Requirements

#### Target Metrics (Per Display Mode)

| Metric | Paginated | V-Scroll | H-Scroll | Auto-Grid | Canvas | Current |
|--------|-----------|----------|----------|-----------|--------|---------|
| **First paint** | <50ms | <50ms | <50ms | <500ms | <100ms | 100-300ms |
| **Full viewport** | <100ms | <150ms | <150ms | <2s | <200ms | 300-500ms |
| **Scroll FPS** | N/A | >58fps | >58fps | >55fps | >55fps | 40-50fps |
| **Zoom to 16x** | <200ms | <200ms | <200ms | N/A | <500ms | 2-5s |
| **Mode transition** | <100ms | <100ms | <100ms | <100ms | <100ms | ~100ms |
| **Memory/100pg** | <80MB | <100MB | <100MB | <50MB | <80MB | 150-200MB |
| **Cache hit rate** | >90% | >85% | >85% | >95% | >85% | ~85% |

#### Benchmark Test PDFs (From User's Calibre Library)

Real-world test corpus from `/Users/josueguevara/Libros/` (1,748 PDFs total):

| PDF Type | Example File | Size | Expected Characteristics |
|----------|--------------|------|-------------------------|
| **Massive Text** | Diccionario Critico Etimologico | 987MB | Likely scanned, OCR, extreme page count |
| **Architecture** | Museum Buildings Construction | 785MB | Image-heavy, high-res photos |
| **Scanned Photos** | Visiting Mexican Bands | 376MB | Image-only pages, historical scans |
| **Math Textbook** | Thomas' Calculus | 272MB | Mixed: equations, diagrams, text |
| **Data Visualization** | Tufte - Visual Display | 245MB | Graphics-heavy, complex layouts |
| **Music Notation** | Behind Bars (Elaine Gould) | 238MB | Vector graphics, complex symbols |
| **Music Omnibook** | Miles Davis Omnibook | 195MB | Music notation, likely scanned |
| **Physics** | Roger A. Freedman (physics) | 177MB | Mixed: equations, diagrams |
| **History (scanned)** | Historia De Mexico Vol 3 | 174MB | Likely scanned historical |
| **Music Theory** | Tonal Harmony | 148MB | Mixed: notation, text, diagrams |

**Benchmark Strategy:**
1. **Stress Test**: Diccionario (987MB) - tests memory limits, extreme page count
2. **Image Stress**: Museum Buildings (785MB) - tests image-heavy rendering
3. **Mixed Content**: Thomas' Calculus (272MB) - tests typical academic PDF
4. **Graphics Complex**: Tufte books (~245MB) - tests complex vector graphics
5. **Music Notation**: Behind Bars (238MB) - tests symbol-heavy vector content

#### Test Scenarios (Lifecycle Tests)

1. **Cold Start**: Open 500-page PDF, navigate to page 250
2. **Fast Scroll**: Scroll 200 pages in 5 seconds (40 pages/sec)
3. **Zoom Stress**: Zoom 1x → 16x → 1x rapidly (5 cycles)
4. **Random Jump**: Navigate to random pages (test cache invalidation)
5. **Long Session**: Continuous usage for 30 minutes (memory stability)
6. **Mixed Operations**: Interleaved scroll, zoom, search, annotations

#### Telemetry Infrastructure Needs

1. **Frame timing** - requestAnimationFrame timestamp deltas
2. **Render pipeline stages** - Per-stage timing (parse, render, encode, transfer, decode)
3. **Cache behavior** - Hit/miss by tier, eviction events
4. **Memory tracking** - Heap snapshots, peak usage, GC pressure
5. **Worker utilization** - Active/waiting/idle distribution
6. **User behavior** - Scroll velocity distribution, zoom level distribution

---

## Phase 3: Research Execution (COMPLETE)

Research completed on 2026-01-09. Findings documented in:
- `/docs/research/2026-01-09/pdf-optimizations/01-transfer-format-optimization.md`
- `/docs/research/2026-01-09/pdf-optimizations/02-multi-worker-architecture.md`
- `/docs/research/2026-01-09/pdf-optimizations/03-content-type-detection.md`
- `/docs/research/2026-01-09/pdf-optimizations/04-wasm-compilation-optimization.md`
- `/docs/research/2026-01-09/pdf-optimizations/05-extreme-zoom-performance.md`
- `/docs/research/2026-01-09/pdf-optimizations/06-display-mode-optimization.md`
- `/docs/research/2026-01-09/pdf-optimizations/PDF Rendering Pipeline Optimization Research.md`

### Consolidated Findings Summary

| Optimization | Expected Impact | Complexity | Priority |
|--------------|-----------------|------------|----------|
| **Raw RGBA Transfer** | 70-93% tile latency reduction | High | P0 |
| **Multi-Resolution Zoom** | 80-95% perceived latency at 16x | Medium | P0 |
| **Auto-Grid Thumbnails** | 70-80% faster (3-5s → <1s) | Medium | P1 |
| **Multi-Worker Pool** | 2-4x throughput | High | P1 |
| **Content-Type Detection** | 30-40% weighted average | Medium | P2 |
| **WASM SIMD+LTO** | 1.5-2.5x for matrix ops | Very High | P2 |
| **IndexedDB Persistence** | Instant on reopen | Low | P3 |

---

## Phase 4: Implementation Blueprint

### Implementation Phases Overview

```
Phase 0: Foundation & Telemetry (Week 1)
    │
    ├── Performance telemetry infrastructure
    ├── Benchmark suite with baseline capture
    └── Feature flag system
          │
Phase 1: Transfer Format Optimization (Week 2) [P0]
    │
    ├── Raw RGBA extraction from MuPDF pixmap
    ├── SharedArrayBuffer transfer (if available)
    └── Cache format migration
          │
Phase 2: Multi-Resolution Zoom (Week 3) [P0]
    │
    ├── CSS transform layer for instant response
    ├── Progressive quality enhancement (scale 8→16→32)
    └── Adaptive tile sizing at high zoom
          │
Phase 3: Multi-Worker Architecture (Week 4) [P1]
    │
    ├── Worker pool manager (2-4 workers)
    ├── Shared WASM module compilation
    └── Load balancing and document sharing
          │
Phase 4: Grid Mode Optimization (Week 5) [P1]
    │
    ├── Parallel thumbnail generation
    ├── IndexedDB thumbnail persistence
    └── Mode transition cache management
```

### Phase 0: Foundation & Telemetry

**Duration:** 1 week

**Deliverables:**
1. `performance-telemetry.ts` - Detailed timing metrics for each pipeline stage
2. `feature-flags.ts` - Feature flag management with auto-detection
3. `benchmark-suite.ts` - Automated performance test harness

**Files to Create:**
| File | Purpose | LOC |
|------|---------|-----|
| `src/reader/renderer/pdf/performance-telemetry.ts` | Per-stage timing | ~150 |
| `src/reader/renderer/pdf/feature-flags.ts` | Flag management | ~150 |
| `src/reader/renderer/pdf/benchmark-suite.ts` | Test harness | ~500 |

**Telemetry Schema:**
```typescript
interface RenderTelemetry {
  requestId: string;
  timestamp: number;
  stages: {
    pageLoad: number;     // MuPDF page.loadPage()
    render: number;       // page.run()
    encode: number;       // pixmap.asPNG() or getSamples()
    transfer: number;     // postMessage round-trip
    decode: number;       // createImageBitmap()
    cache: number;        // Cache set operation
    display: number;      // Canvas drawImage()
  };
  metadata: {
    page: number;
    scale: number;
    tileX?: number;
    tileY?: number;
    cacheHit: boolean;
    workerIndex: number;
  };
}
```

**Feature Flags:**
| Flag | Default | Controls |
|------|---------|----------|
| `useRawRGBA` | `auto` | Raw RGBA vs PNG transfer |
| `useSharedArrayBuffer` | `auto` | Zero-copy transfer |
| `useMultiResZoom` | `true` | Progressive zoom rendering |
| `workerCount` | `auto` | Worker pool size (1-4) |
| `useThumbnailCache` | `true` | IndexedDB persistence |
| `enableTelemetry` | `true` | Performance tracking |

**Validation:**
- Baseline benchmark captured
- Telemetry visible in DevTools console
- Feature flags controllable via settings UI

---

### Phase 1: Raw RGBA Transfer (P0)

**Duration:** 1 week

**Hypothesis:** Eliminating PNG encode/decode reduces tile latency from 15-70ms to 1-5ms (70-93% improvement)

**Implementation:**

1. **Expose MuPDF pixmap samples**
   ```typescript
   // mupdf-worker.ts - New method
   function getSamples(pixmap: Pixmap): Uint8ClampedArray {
     const width = pixmap.getWidth();
     const height = pixmap.getHeight();
     const samples = pixmap.getSamples(); // Direct RGBA buffer
     return new Uint8ClampedArray(samples.buffer);
   }
   ```

2. **SharedArrayBuffer pool** (if available)
   ```typescript
   // shared-render-buffer.ts
   class SharedBufferPool {
     private buffers: SharedArrayBuffer[] = [];
     private status: Int32Array;

     acquireBuffer(size: number): { index: number; buffer: SharedArrayBuffer };
     releaseBuffer(index: number): void;
   }
   ```

3. **ImageData fast path**
   ```typescript
   // Main thread - faster than PNG decode
   const imageData = new ImageData(
     new Uint8ClampedArray(sharedBuffer),
     width, height
   );
   const bitmap = await createImageBitmap(imageData);
   ```

**Files to Modify:**
| File | Change Type | Description |
|------|-------------|-------------|
| `mupdf-worker.ts` | Major | Add getSamples(), RGBA encoding |
| `tile-cache-manager.ts` | Medium | Cache RGBA buffers instead of Blobs |
| `render-coordinator.ts` | Medium | SharedArrayBuffer integration |

**Rollback:** Feature flag `useRawRGBA = false` reverts to PNG path

**Validation:**
| Metric | Baseline | Target |
|--------|----------|--------|
| Encode time | 10-50ms | 0-2ms |
| Decode time | 1-5ms | <1ms |
| Total tile latency | 15-70ms | 1-6ms |

---

### Phase 2: Multi-Resolution Zoom (P0)

**Duration:** 1 week

**Hypothesis:** CSS transform + progressive rendering reduces perceived zoom latency from 2.5s to <500ms (80-95% improvement)

**Implementation:**

1. **CSS Transform Layer**
   ```typescript
   // zoom-transform-layer.ts
   class ZoomTransformLayer {
     private container: HTMLElement;
     private renderScale: number = 1;

     onZoomGesture(displayZoom: number): void {
       // Immediate CSS scale (GPU-accelerated)
       const cssScale = displayZoom / this.renderScale;
       this.container.style.transform = `scale(${cssScale})`;

       // Debounced render at new scale
       this.scheduleRender(displayZoom);
     }
   }
   ```

2. **Progressive Tile Rendering**
   ```
   Phase 1 (0-50ms):   CSS scale existing tiles
   Phase 2 (50-200ms): Render at scale/2, display upscaled
   Phase 3 (200ms+):   Render at full scale, replace
   ```

3. **Adaptive Tile Size**
   | Zoom Range | Tile Size | Rationale |
   |------------|-----------|-----------|
   | 0.5-2x | 512px | Fewer tiles |
   | 2-8x | 256px | Standard |
   | 8-16x | 128px | Faster renders |
   | 16x+ | 64px | Minimal area |

**Files to Create:**
| File | Purpose | LOC |
|------|---------|-----|
| `zoom-transform-layer.ts` | CSS instant zoom | ~250 |
| `progressive-tile-renderer.ts` | Multi-res rendering | ~300 |

**Files to Modify:**
| File | Change Type |
|------|-------------|
| `pdf-infinite-canvas.ts` | Zoom transform integration |
| `scroll-strategy.ts` | Adaptive tile size |

**Rollback:** Feature flag `useMultiResZoom = false`

**Validation:**
| Metric | Baseline | Target |
|--------|----------|--------|
| Time to first paint (16x zoom) | 2.5s | <50ms |
| Time to full quality | 2.5s | <500ms |
| Frame rate during zoom | 20-30fps | >60fps |

---

### Phase 3: Multi-Worker Architecture (P1)

**Duration:** 1 week

**Hypothesis:** 2-4 parallel MuPDF workers achieve 2-4x tile rendering throughput

**Implementation:**

1. **Shared WASM Module**
   ```typescript
   // worker-pool-manager.ts
   class WorkerPoolManager {
     private sharedModule: WebAssembly.Module;
     private workers: Worker[] = [];

     async initialize(count: number): Promise<void> {
       // Compile once
       this.sharedModule = await WebAssembly.compileStreaming(
         fetch('/mupdf.wasm')
       );

       // Instantiate in each worker
       for (let i = 0; i < count; i++) {
         const worker = new Worker('mupdf-worker.js');
         worker.postMessage({ type: 'init', module: this.sharedModule });
         this.workers.push(worker);
       }
     }
   }
   ```

2. **Load Balancing**
   - Round-robin for tile requests
   - Least-loaded for burst requests
   - Priority queue respected across workers

3. **Document Sharing**
   - PDF bytes via SharedArrayBuffer (one copy)
   - Each worker parses independently

**Memory Budget:**
| Component | Per Worker | 4 Workers |
|-----------|------------|-----------|
| WASM heap | 30MB | 30MB (shared code) |
| Document state | 10MB | 40MB |
| Working buffers | 5MB | 20MB |
| **Total** | 45MB | 180MB |

**Files to Create:**
| File | Purpose | LOC |
|------|---------|-----|
| `worker-pool-manager.ts` | Pool orchestration | ~400 |

**Rollback:** `workerCount = 1`

**Validation:**
| Metric | 1 Worker | 2 Workers | 4 Workers |
|--------|----------|-----------|-----------|
| 100 tiles | 2000ms | 1000ms | 500ms |
| Memory | ~50MB | ~100MB | ~180MB |

---

### Phase 4: Grid Mode Optimization (P1)

**Duration:** 1 week

**Hypothesis:** Parallel thumbnail generation reduces Auto-Grid load from 3-5s to <1s (70-80% improvement)

**Implementation:**

1. **Parallel Thumbnail Generation**
   ```typescript
   async function generateThumbnailsParallel(
     pageCount: number
   ): Promise<void> {
     const promises = [];

     // Ripple from center for visible-first ordering
     const order = getRippleOrder(Math.floor(pageCount / 2), pageCount);

     for (const pageNum of order) {
       promises.push(
         workerPool.renderThumbnail(pageNum, 200)
           .then(thumb => displayThumbnail(pageNum, thumb))
       );
     }

     await Promise.all(promises);
   }
   ```

2. **IndexedDB Persistence**
   ```typescript
   // thumbnail-cache.ts
   async function cacheThumbnail(
     docId: string,
     pageNum: number,
     bitmap: ImageBitmap
   ): Promise<void> {
     const blob = await bitmapToWebP(bitmap, 0.8);
     await idb.put('thumbnails', { docId, pageNum, blob });
   }
   ```

3. **Mode Transition Cache**
   - Unified cache with mode-specific views
   - Preserve thumbnails when switching to scroll mode
   - Pre-render visible tiles before transition

**Files to Modify:**
| File | Change Type |
|------|-------------|
| `grid-strategy.ts` | Parallel generation |
| `hybrid-pdf-provider.ts` | IndexedDB integration |
| `render-coordinator.ts` | Mode transition handling |

**Rollback:** `useThumbnailCache = false`

**Validation:**
| Metric | Baseline | Target |
|--------|----------|--------|
| Time to first 9 thumbnails | 1-2s | <500ms |
| Time to 100 thumbnails | 3-5s | <1s |
| IndexedDB hit rate (reopen) | N/A | >80% |

---

### Memory Budget Summary

**Total Budget:** 500MB for 1000-page PDFs

| Component | Baseline | After All Phases |
|-----------|----------|------------------|
| PDF Bytes (shared) | 50MB | 50MB |
| Workers | 30MB | 180MB (4 workers) |
| L1 Cache (50 tiles) | 5MB (PNG) | 13MB (RGBA) |
| L2 Cache (150 tiles) | 20MB (PNG) | 39MB (RGBA) |
| L3 Cache (metadata) | 1MB | 1MB |
| Text layers | 10MB | 10MB |
| SharedArrayBuffer pool | 0MB | 10MB |
| **TOTAL** | ~116MB | ~307MB |

**Headroom:** 193MB (38.6% reserve) - comfortable margin

---

### Benchmark Suite

**Test Scenarios:**

1. **Single Tile Render** - 50 iterations, measure p50/p95/p99
2. **Continuous Scroll** - 100 pages at 200px/s, measure FPS
3. **Zoom Transition** - 1x→16x, measure time to first paint
4. **Grid Thumbnails** - 100 pages, cold and warm cache
5. **Memory Stress** - 1000 pages, continuous usage

**MCP Commands:**
```javascript
// Run full benchmark suite
await window.Amnesia.benchmarks.runAll();

// Run specific test
await window.Amnesia.benchmarks.runTileRenderTest({
  page: 50, scale: 2, iterations: 50
});

// Get comparison report
const report = await window.Amnesia.benchmarks.compare(
  'baseline-2026-01-09.json'
);
```

---

### Rollback Strategy

**Per-Phase Rollback:**
| Phase | Rollback Method | Recovery Time |
|-------|-----------------|---------------|
| P0 (Foundation) | N/A (only adds telemetry) | - |
| P1 (Raw RGBA) | `useRawRGBA = false` | Instant |
| P2 (Multi-Res) | `useMultiResZoom = false` | Instant |
| P3 (Workers) | `workerCount = 1` | Restart |
| P4 (Grid) | `useThumbnailCache = false` | Instant |

**Emergency Rollback:**
```bash
git revert <phase-commit>
npm run build
# Reload plugin in Obsidian
```

---

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SharedArrayBuffer not available | Medium | High | Fallback to ArrayBuffer transfer |
| MuPDF getSamples() not exposed | High | High | Patch node_modules or use PNG fallback |
| Multi-worker memory bloat | Medium | Medium | Start with 2 workers, scale adaptively |
| IndexedDB quota exceeded | Low | Low | LRU eviction, clear on error |
| No improvement on low-end hardware | Medium | Medium | Adaptive feature enabling |

---

### Success Criteria

**Phase 1 Complete when:**
- [ ] Telemetry shows encode time <2ms (vs baseline 10-50ms)
- [ ] Tile latency p95 <15ms (vs baseline 50-150ms)
- [ ] Memory usage <350MB for 1000-page PDF

**Phase 2 Complete when:**
- [ ] Time to first paint at 16x zoom <50ms
- [ ] Frame rate during zoom gesture >60fps
- [ ] Full quality render <500ms

**Phase 3 Complete when:**
- [ ] 4 workers achieve >3x throughput vs 1 worker
- [ ] Memory stays <400MB with 4 workers
- [ ] No regression on single-core devices

**Phase 4 Complete when:**
- [ ] Auto-Grid 100 pages loads in <1s
- [ ] IndexedDB hit rate >80% on reopen
- [ ] Mode transitions <100ms

**Overall Success:**
- [ ] All 5 display modes >55fps during interaction
- [ ] 16x zoom feels instant (<200ms perceived latency)
- [ ] Memory <500MB for any PDF in test corpus
- [ ] No visual regressions in any mode

### Proposed New MCP Tools

To properly benchmark and validate optimizations, we may need to extend the Obsidian DevTools MCP server:

| Tool | Purpose | Inputs | Outputs |
|------|---------|--------|---------|
| `obsidian_pdf_benchmark` | Run standardized benchmark suite | scenario, pdfPath, iterations | metrics JSON (FPS, latency, memory) |
| `obsidian_pdf_profile_render` | Profile a single render operation | page, zoom, mode | stage-by-stage timing breakdown |
| `obsidian_pdf_memory_snapshot` | Capture memory state | includeHeapDump | cache sizes, WASM heap, total memory |
| `obsidian_pdf_content_analysis` | Analyze PDF content type | pdfPath | content type, complexity score, recommendations |
| `obsidian_pdf_compare_renders` | Compare two render strategies | strategyA, strategyB, scenario | A/B metrics comparison |
| `obsidian_pdf_stress_test` | Long-duration stress test | duration, scenario | stability metrics, memory leaks, degradation |

### Proposed Telemetry Enhancements

| Metric | Current | Proposed | Why |
|--------|---------|----------|-----|
| **Per-stage timing** | Total render time | Breakdown: parse, render, encode, transfer, decode | Identify specific bottlenecks |
| **Content type tracking** | None | PDF type classification | Validate content-aware optimizations |
| **Mode-specific metrics** | Combined | Separate by display mode | Compare mode performance |
| **Memory pressure events** | None | GC frequency, heap growth rate | Detect memory issues early |
| **Cache effectiveness** | Hit/miss counts | Hit rate by zoom level, by content type | Tune cache sizing |
| **Prefetch accuracy** | None | % of prefetched tiles actually used | Tune prefetch algorithms |

---

## Phase 5: Structured Research Prompts

Each research area gets its own comprehensive prompt. Use these for deep research sessions.

---

### Research Prompt 1: Transfer Format Optimization

**Context**: Currently, MuPDF WASM renders pages to Pixmap, encodes to PNG (10-50ms), transfers via postMessage, then decodes to ImageBitmap (1-5ms). This adds 15-70ms latency per tile.

**Tech Stack**: MuPDF 1.27.0 WASM, Electron (Chromium 120+), Web Workers, Transferable objects

**Current Implementation**:
```
MuPDF Worker: page.run() → Pixmap → pixmap.asPNG() → ArrayBuffer
Transfer: postMessage(buffer, [buffer]) // Transferable
Main Thread: createImageBitmap(blob) → Canvas drawImage()
```

**Research Questions**:
1. Can MuPDF output raw RGBA directly (skip PNG encode)?
2. What's the memory overhead of raw RGBA vs PNG?
3. Is WebP encoding faster than PNG in WASM?
4. Can we use SharedArrayBuffer for zero-copy pixel transfer?
5. How does pdf.js transfer rendered content between workers?
6. What's the ImageBitmap creation path from raw pixels vs PNG?

**Sources to Investigate**:
- MuPDF source: `pixmap.c`, `output-png.c` - alternative output formats
- pdf.js source: `src/display/canvas.js` - how they transfer rendered content
- Chromium source: ImageBitmap implementation - fastest creation path
- Emscripten docs: SharedArrayBuffer, WASM memory model

**Hypothesis**: Raw RGBA + SharedArrayBuffer could reduce transfer overhead from 15-70ms to <5ms (70-90% improvement).

**Validation Metric**: Measure end-to-end tile render time with current PNG path vs prototype raw path.

---

### Research Prompt 2: Multi-Worker Architecture

**Context**: Currently single MuPDF WASM worker with semaphore-limited concurrency (8 permits). No true parallelism for CPU-bound rendering.

**Tech Stack**: MuPDF 1.27.0 WASM (~3MB binary), Web Workers, Electron renderer process

**Current Implementation**:
```
Main Thread → postMessage → Single MuPDF Worker → Semaphore(8) → Sequential renders
```

**Research Questions**:
1. What's the memory footprint of a single MuPDF WASM instance?
2. Can we run 2-4 MuPDF workers in parallel (memory budget: 500MB total)?
3. How does pdf.js handle multi-worker rendering?
4. What load balancing strategies work for tile workloads?
5. Can workers share document data (SharedArrayBuffer for PDF bytes)?
6. What's the initialization cost of additional workers?

**Sources to Investigate**:
- pdf.js source: `src/display/api.js`, worker pool implementation
- MuPDF source: memory allocation patterns, document state size
- Chromium Worker docs: memory isolation, shared resources
- Google Maps: how they parallelize tile rendering

**Hypothesis**: 2-4 parallel MuPDF workers could achieve 2-4x throughput for tile rendering, assuming ~50-100MB per worker instance.

**Validation Metric**:
- Measure WASM heap size for loaded document
- Prototype 2-worker setup, measure throughput on stress test
- Track total memory usage vs single-worker baseline

---

### Research Prompt 3: Content-Type Detection & Optimization

**Context**: All PDFs rendered identically regardless of content type. Scanned pages (single image) could skip MuPDF rendering entirely. Vector-heavy pages could use lower resolution.

**Tech Stack**: MuPDF WASM, PDF 1.7/2.0 format

**Current Implementation**:
```
renderPage(pageNum, scale) {
  page.run(device, matrix) // Same path for all PDFs
  return pixmap.asPNG()
}
```

**Untapped MuPDF APIs**:
```typescript
const pageObj = doc.findPage(n)
const resources = pageObj.get("Resources")
const xobjects = resources.get("XObject") // Image count
const fonts = resources.get("Font") // Font complexity
const contents = pageObj.get("Contents").readStream() // Content stream
```

**Research Questions**:
1. How quickly can we analyze page complexity (target: <10ms)?
2. What heuristics identify scanned pages (image-only)?
3. Can we extract JPEG directly from XObject without re-rendering?
4. What PDF operators indicate vector complexity (`m`, `l`, `c`, `re`, `S`, `f`)?
5. How do professional PDF tools classify content types?
6. What's the accuracy of content-type detection across PDF producers?

**Sources to Investigate**:
- PDF Reference 1.7: Content stream operators, XObject structure
- MuPDF source: `pdf-interpret.c` - how operators are processed
- qpdf source: PDF structure analysis tools
- Academic papers: PDF content classification, document analysis

**Optimization Strategies by Type**:
| Type | Detection | Optimization |
|------|-----------|--------------|
| Scanned | 1 XObject/page, <10 operators | Extract JPEG directly (skip render) |
| Vector | >500 path operators, 0 images | Lower scale (anti-aliasing handles upscale) |
| Text | >300 text operators, minimal graphics | Aggressive caching, high text quality |
| Mixed | Balanced operators | Standard rendering |

**Hypothesis**:
- Scanned PDFs: 60-80% faster (skip MuPDF render)
- Vector PDFs: 30-50% faster (lower render scale)
- Text PDFs: 20-30% memory reduction (smaller cache entries)

**Validation Metric**: Classify 100 PDFs from test corpus, measure render time improvement per type.

---

### Research Prompt 4: WASM Compilation & Optimization

**Context**: Using pre-built `mupdf@1.27.0` npm package. No control over WASM compilation flags. May be missing optimization opportunities.

**Current State**:
- MuPDF npm package: pre-compiled WASM binary (~3MB)
- Unknown Emscripten flags
- Unknown optimization level
- SIMD status unknown

**Research Questions**:
1. What Emscripten flags are used in official MuPDF WASM build?
2. What's the performance impact of `-O3 -flto` vs current build?
3. Is WASM SIMD available for MuPDF matrix operations?
4. Can we enable WASM threading (SharedArrayBuffer + Atomics)?
5. What's the minimum MuPDF feature set we need (tree shaking)?
6. How does wasm-opt improve the binary?

**Sources to Investigate**:
- MuPDF Makefile/CMake: WASM build configuration
- Emscripten docs: Optimization flags, SIMD, threading
- WebAssembly proposals: SIMD spec, threading spec
- Chromium flags: WASM optimization settings in Electron

**Build Configuration to Test**:
```makefile
EMCC_FLAGS = \
  -O3 \
  -flto \
  -s WASM_SIMD=1 \
  -s ENVIRONMENT=worker \
  -s EXPORTED_FUNCTIONS=[...] \
  -s MODULARIZE=1 \
  --closure 1
```

**Hypothesis**: Custom MuPDF WASM build with SIMD + LTO could achieve 10-30% faster rendering for matrix-heavy operations.

**Validation Metric**: Compare render times between npm package and custom build on math textbook (matrix-heavy).

---

### Research Prompt 5: Extreme Zoom Performance (16x+)

**Context**: At 16x zoom on Retina (scale 32), tile rendering takes 2-5s for uncached areas. Users expect instant response.

**Current Implementation**:
```
Zoom 16x → tileScale = 32 → 8192×8192 render per tile → ~500ms/tile
40 visible tiles → 20s serial → 2.5s with 8 concurrent
```

**Research Questions**:
1. How do infinite canvas tools (Figma, Miro) handle extreme zoom?
2. What multi-resolution tile strategies exist (render low-res first)?
3. Can we use CSS scale for intermediate zoom (GPU compositing)?
4. What's the optimal scale cap (32 vs 16 vs 8)?
5. How does Google Maps handle deep zoom levels?
6. Can WebGL texture caching improve tile display time?

**Sources to Investigate**:
- Figma engineering blog: Canvas rendering at scale
- Google Maps: Deep zoom tile loading patterns
- Apple CATiledLayer: iOS tiled rendering implementation
- WebGL tile caching: GPU texture management

**Proposed Multi-Resolution Strategy**:
```
User zooms to 16x:
1. Immediately show scale 8 tiles (existing cache or 4x faster render)
2. Render scale 32 tiles in background
3. Replace low-res with high-res as they complete
Result: 500ms perceived latency vs 2.5s current
```

**Hypothesis**: Multi-resolution rendering + CSS intermediate zoom could reduce perceived latency from 2.5s to <500ms at 16x zoom.

**Validation Metric**: Measure time-to-first-visible-content at 16x zoom with current vs multi-res approach.

---

### Research Prompt 6: Display Mode Optimization

**Context**: 5 display modes with different performance profiles. Auto-grid is slowest (3-5s for 100 pages). Canvas extreme zoom is problematic.

**Display Modes**:
| Mode | Current Bottleneck | Target |
|------|-------------------|--------|
| Paginated | Initial load (100-300ms) | <50ms |
| Vertical-Scroll | Fast scroll tile throughput | 60fps, 0 blanks |
| Horizontal-Scroll | Wide viewport = more tiles | Same as vertical |
| Auto-Grid | Thumbnail generation (3-5s/100pg) | <500ms/100pg |
| Canvas | 16x zoom render (2-5s) | <500ms |

**Research Questions**:
1. How do other multi-mode viewers (Preview.app, Acrobat) handle mode transitions?
2. What's the optimal thumbnail generation strategy (parallel, progressive)?
3. Can we pre-generate thumbnails during document parse?
4. What mode-specific prefetch algorithms work best?
5. How should cache be managed across mode transitions?
6. What text layer strategies work for grid/canvas modes?

**Sources to Investigate**:
- macOS Preview.app: Mode transition behavior (reverse engineer via Instruments)
- Adobe Acrobat: Thumbnail generation timing
- pdf.js: Page overview mode implementation
- Figma: Minimap/overview rendering

**Optimization Priorities by Mode**:
1. **Auto-Grid**: Parallel thumbnail generation during parse
2. **Paginated**: Pre-cache first 3 pages on load
3. **Canvas**: Multi-resolution tile rendering
4. **Scroll modes**: Already well-optimized (velocity prefetch)

**Hypothesis**: Parallel thumbnail generation during document parse could reduce auto-grid initial load from 3-5s to <1s.

**Validation Metric**: Measure time from document open to grid fully populated.

---

---

## Research Execution Workflow

### Step 1: Divide & Conquer

| Research Area | Assigned To | Priority |
|---------------|-------------|----------|
| **Prompt 1**: Transfer Format | Both | P0 - Highest impact |
| **Prompt 2**: Multi-Worker | Claude | P1 |
| **Prompt 3**: Content-Type Detection | User | P1 |
| **Prompt 4**: WASM Compilation | Claude | P2 |
| **Prompt 5**: Extreme Zoom | Both | P1 |
| **Prompt 6**: Display Modes | Claude | P2 |

### Step 2: Consolidate Findings

After research:
1. Create `/apps/amnesia/research/pdf-performance-findings.md`
2. Document findings organized by research question
3. Identify proven patterns vs experimental approaches
4. Note any conflicting recommendations

### Step 3: Develop Implementation Plan

With @agent-feature-dev:code-architect:
1. Create hypothesis matrix for each optimization
2. Prioritize by impact × feasibility
3. Design benchmark suite to validate each hypothesis
4. Plan incremental rollout with rollback points

### Step 4: Execute & Measure

For each optimization:
1. Establish baseline metrics
2. Implement change in isolation
3. Run benchmark suite
4. Compare against baseline
5. Decide: keep, iterate, or rollback

---

## Summary of Key Research Questions

The most critical questions we need to answer through research:

### Tier 1: Must Answer Before Implementation

1. **Can we eliminate PNG encode/decode?** What's the alternative transfer format?
2. **What's the memory cost of multiple MuPDF WASM workers?** Is 2-4 workers feasible?
3. **How does pdf.js achieve better scroll performance?** What can we learn?
4. **Can we detect PDF content type cheaply?** What's the detection accuracy?

### Tier 2: Important for Optimization

5. **What Emscripten flags improve MuPDF WASM performance?**
6. **Is WASM SIMD available and beneficial for MuPDF?**
7. **What's the optimal tile size at different zoom levels?**
8. **How do we implement multi-resolution tile rendering?**

### Tier 3: Nice to Have

9. **Can we use WebGL for tile compositing?**
10. **What predictive prefetch algorithms work best for reading patterns?**
11. **Should we implement IndexedDB L4 cache for persistence?**

# PDF Renderer Performance Optimization Plan

**Date**: 2026-01-14
**Version**: v1.0
**Baseline Version**: v0.5.2 (commit 225ab77)
**Status**: Ready for User Review

---

## Executive Summary

### Current State (v0.5.2)
- **Time-to-first-paint**: 4-5 seconds for large PDFs (947 pages)
- **Worker cold start**: 142ms per worker (568ms for 4 workers sequentially)
- **Re-open time**: Same as fresh open (no thumbnail persistence)
- **Cache hit rate (initial)**: 0% (cold cache)

### Target State
- **Time-to-first-paint**: <1 second (skeleton + low-res tiles)
- **Worker ready time**: <50ms (pre-warmed on plugin load)
- **Re-open time**: <200ms (thumbnail cache hit)
- **Cache hit rate**: >90% on re-opens

### Expected Improvement
**80% reduction in perceived load time** (4-5s → <1s)

---

## Benchmarking Strategy

### Programmatic Benchmark Suite

The existing `pdf-telemetry.ts` provides comprehensive metrics. We will create a dedicated benchmark harness:

**File**: `apps/amnesia/src/reader/renderer/pdf/benchmark-suite.ts`

```typescript
interface BenchmarkResult {
  // Critical metrics
  timeToFirstPaint: number;      // ms from load() to first tile displayed
  timeToUsable: number;          // ms until >50% viewport rendered
  timeToComplete: number;        // ms until all visible tiles rendered

  // Worker metrics
  workerInitTime: number;        // ms for worker pool initialization
  firstWorkerReady: number;      // ms until first worker accepts requests

  // Cache metrics
  cacheHitRate: number;          // 0-1, overall cache hit rate
  l1HitRate: number;             // 0-1, memory cache hit rate
  thumbnailCacheHits: number;    // count of thumbnail cache hits

  // Render pipeline
  avgTileRenderTime: number;     // ms average per tile
  p95TileRenderTime: number;     // ms 95th percentile
  pipelineStages: {
    pageLoad: number;
    render: number;
    encode: number;
    transfer: number;
    decode: number;
    display: number;
  };

  // Interaction metrics
  scrollFps: number;             // average FPS during scroll
  scrollJankEvents: number;      // frames >16.67ms
  zoomLatency: number;           // ms from zoom gesture to tile update

  // Memory
  peakMemoryMB: number;
  avgMemoryMB: number;
}
```

### Benchmark Protocol

#### Test Documents
1. **Small PDF**: 10 pages, text-heavy (baseline)
2. **Medium PDF**: 100 pages, mixed content
3. **Large PDF**: 947 pages (Dragon Book - stress test)
4. **Scanned PDF**: Image-heavy, typical academic scan

#### Measurement Procedure

```typescript
async function runBenchmark(pdfPath: string): Promise<BenchmarkResult> {
  // 1. Reset telemetry
  resetTelemetry();
  const telemetry = getTelemetry();

  // 2. Record start time
  const loadStart = performance.now();

  // 3. Open PDF via Amnesia command
  await app.commands.executeCommandById('amnesia:open-book');
  // Select the test PDF

  // 4. Wait for events
  const firstPaint = await waitForEvent('amnesia:first-tile-rendered');
  const usable = await waitForEvent('amnesia:viewport-50-percent');
  const complete = await waitForEvent('amnesia:visible-tiles-complete');

  // 5. Collect telemetry
  const stats = telemetry.getStats();
  const pipeline = telemetry.getPipelineStats();

  // 6. Interaction test (scroll stress)
  await runScrollStressTest(3000); // 3 seconds of scrolling

  // 7. Zoom test
  await runZoomStressTest([1, 4, 8, 16]); // Zoom levels to test

  // 8. Compile results
  return {
    timeToFirstPaint: firstPaint - loadStart,
    timeToUsable: usable - loadStart,
    timeToComplete: complete - loadStart,
    workerInitTime: stats.customMetric?.('workerInitTime') ?? 0,
    firstWorkerReady: stats.customMetric?.('firstWorkerReady') ?? 0,
    cacheHitRate: stats.overallHitRate,
    l1HitRate: stats.l1HitRate,
    thumbnailCacheHits: stats.customMetric?.('thumbnailCacheHits') ?? 0,
    avgTileRenderTime: stats.avgTileRenderTime,
    p95TileRenderTime: stats.p95TileRenderTime,
    pipelineStages: {
      pageLoad: pipeline?.pageLoad.avg ?? 0,
      render: pipeline?.render.avg ?? 0,
      encode: pipeline?.encode.avg ?? 0,
      transfer: pipeline?.transfer.avg ?? 0,
      decode: pipeline?.decode.avg ?? 0,
      display: pipeline?.display.avg ?? 0,
    },
    scrollFps: stats.scrollAvgFps,
    scrollJankEvents: stats.scrollJankEvents,
    zoomLatency: telemetry.getInputLatencyStats().avgLatency,
    peakMemoryMB: stats.peakMemoryMB,
    avgMemoryMB: stats.avgMemoryMB,
  };
}
```

### Benchmark Execution via MCP

```javascript
// Run via obsidian_execute_js
async function executeBenchmarkSuite() {
  const results = {};

  // Test each document type
  for (const doc of ['small.pdf', 'medium.pdf', 'dragon-book.pdf', 'scanned.pdf']) {
    results[doc] = await window.pdfBenchmarkSuite.run(doc);
  }

  // Export results
  return JSON.stringify(results, null, 2);
}
```

### Success Criteria by Metric

| Metric | Baseline | Target | Improvement |
|--------|----------|--------|-------------|
| Time to first paint | 4000-5000ms | <500ms | 90% |
| Time to usable | 5000-6000ms | <1000ms | 80% |
| Worker init time | 568ms | <50ms | 91% |
| Re-open time | 4000-5000ms | <200ms | 96% |
| Cache hit (re-open) | 0% | >90% | N/A |
| Scroll FPS | 30-45 | 55-60 | 50% |
| Jank events/session | 50-100 | <10 | 90% |
| Zoom latency | 300-500ms | <100ms | 75% |

---

## Implementation Phases

### Phase 1: Skeleton UI & Visual Feedback
**Goal**: Instant perceived responsiveness

#### Changes
1. **New file**: `skeleton-ui.ts`
   - Shimmer animation with CSS gradients
   - Page placeholders with loading spinners
   - Progress indicator for tile completion

2. **Modify**: `pdf-infinite-canvas.ts`
   - Show skeleton immediately in `initialize()`
   - Hide skeleton on first tile bitmap received

#### Files to Modify
- `apps/amnesia/src/reader/renderer/pdf/skeleton-ui.ts` (NEW)
- `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts`
- `apps/amnesia/src/styles.css`

#### Quality Gate
- [ ] Skeleton appears in <50ms after load() called
- [ ] No blank screen visible at any point
- [ ] Smooth shimmer animation (60 FPS)
- [ ] Code review passes with no critical issues

---

### Phase 2: Worker Pool Pre-warming
**Goal**: Eliminate 142ms cold start per worker

#### Changes
1. **Modify**: `worker-pool-manager.ts`
   - Add `prewarm(count: number)` method
   - Parallel worker initialization (not sequential)
   - First worker ready = can render (others in background)

2. **Modify**: `main.ts`
   - Call `prewarmWorkerPool(4)` in `onload()` (non-blocking)

#### Files to Modify
- `apps/amnesia/src/reader/renderer/pdf/worker-pool-manager.ts`
- `apps/amnesia/src/main.ts`

#### Quality Gate
- [ ] Workers ready before first PDF opened
- [ ] Worker init time <50ms (measured via telemetry)
- [ ] No impact on plugin startup time
- [ ] Code review passes with no critical issues

---

### Phase 3: Thumbnail Cache (IndexedDB)
**Goal**: Instant display on re-opens

#### Changes
1. **New file**: `thumbnail-idb-cache.ts`
   - IndexedDB store for page thumbnails
   - Key: `${docHash}-p${page}-thumb`
   - LRU eviction with configurable max size

2. **Modify**: `tile-cache-manager.ts`
   - Add `warmThumbnails(docHash, pages)` method
   - On load: warm first 20 pages
   - On scroll: warm visible ± 10 pages
   - On close: persist new thumbnails

#### Files to Modify
- `apps/amnesia/src/reader/renderer/pdf/thumbnail-idb-cache.ts` (NEW)
- `apps/amnesia/src/reader/renderer/pdf/tile-cache-manager.ts`
- `apps/amnesia/src/reader/renderer/pdf/pdf-renderer.ts`

#### Quality Gate
- [ ] Re-open time <200ms (measured via benchmark)
- [ ] Cache hit rate >90% on re-opens
- [ ] IndexedDB entries created correctly
- [ ] Code review passes with no critical issues

---

### Phase 4: Progressive Tile Loading
**Goal**: Show blurry content immediately, upgrade to sharp

#### Changes
1. **Enhance**: `progressive-tile-renderer.ts`
   - Add `createRenderPlan(tile, targetScale)` → tiers [2, 8, 16]
   - Add async generator `executePlan()` for progressive yields

2. **Modify**: `pdf-infinite-canvas.ts`
   - New `renderTileProgressive()` method
   - CSS stretch display for intermediate tiers
   - Remove skeleton on first low-res tile

3. **Modify**: `pdf-page-element.ts`
   - Support `cssStretch` parameter in `setTileBitmap()`

#### Files to Modify
- `apps/amnesia/src/reader/renderer/pdf/progressive-tile-renderer.ts`
- `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts`
- `apps/amnesia/src/reader/renderer/pdf/pdf-page-element.ts`

#### Quality Gate
- [ ] First paint <200ms (low-res)
- [ ] Final quality <500ms
- [ ] No visual artifacts during transition
- [ ] Code review passes with no critical issues

---

### Phase 5: Adaptive Quality During Interaction
**Goal**: Smooth 60 FPS scroll at high zoom

#### Changes
1. **New file**: `adaptive-quality.ts`
   - Velocity tracking for scroll/zoom
   - Quality factor calculation by speed zone
   - Auto-upgrade when idle

2. **Modify**: `render-coordinator.ts`
   - Apply quality factor to tile scale selection
   - Schedule quality upgrade renders on idle

#### Files to Modify
- `apps/amnesia/src/reader/renderer/pdf/adaptive-quality.ts` (NEW)
- `apps/amnesia/src/reader/renderer/pdf/render-coordinator.ts`

#### Quality Gate
- [ ] Scroll FPS 55-60 at high zoom
- [ ] Quality restore within 200ms of idle
- [ ] No visible "pop" on quality upgrade
- [ ] Code review passes with no critical issues

---

### Phase 6: Viewport-First Tile Priority
**Goal**: Render center tiles before edges

#### Changes
1. **Modify**: `render-coordinator.ts`
   - Add `calculateTilePriority(tile, viewportCenter, radius)`
   - Distance-based priority assignment
   - Viewport tracking

2. **Modify**: `pdf-infinite-canvas.ts`
   - Add `notifyViewportChange()` to update coordinator

#### Files to Modify
- `apps/amnesia/src/reader/renderer/pdf/render-coordinator.ts`
- `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts`

#### Quality Gate
- [ ] Center tiles render 2-3x faster than edges
- [ ] Visible tile priority correct in queue inspection
- [ ] Code review passes with no critical issues

---

### Phase 7: WebGL Compositing
**Goal**: GPU-accelerated tile compositing for 20-30% FPS boost

#### Changes
1. **New file**: `webgl-compositor.ts`
   - WebGL2 context for tile compositing
   - Texture atlas for efficient GPU memory
   - Fallback to Canvas2D if WebGL2 unavailable

2. **Modify**: `pdf-infinite-canvas.ts`
   - Replace Canvas2D drawImage with WebGL compositor
   - Texture upload on tile render complete
   - Batched draw calls for all visible tiles

#### Files to Modify
- `apps/amnesia/src/reader/renderer/pdf/webgl-compositor.ts` (NEW)
- `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts`
- `apps/amnesia/src/reader/renderer/pdf/feature-flags.ts`

#### Quality Gate
- [ ] 20-30% FPS improvement in scroll stress test
- [ ] Graceful fallback when WebGL2 unavailable
- [ ] No visual artifacts or texture bleeding
- [ ] Memory usage within 20% of Canvas2D baseline
- [ ] Code review passes with no critical issues

---

## Risk Assessment

| Phase | Technical Risk | Integration Risk | Rollback Difficulty |
|-------|---------------|------------------|---------------------|
| Phase 1 (Skeleton) | Low | Low | Easy |
| Phase 2 (Workers) | Medium | Low | Easy |
| Phase 3 (Thumbnails) | Medium | Medium | Medium |
| Phase 4 (Progressive) | High | High | Hard |
| Phase 5 (Adaptive) | Medium | Medium | Medium |
| Phase 6 (Priority) | Low | Low | Easy |
| Phase 7 (WebGL) | Medium | High | Medium |

**Mitigation for Phase 4 (High Risk)**:
- Feature flag: `useProgressiveLoading` (default ON per user decision)
- Visual regression tests before merge

**Mitigation for Phase 7 (Medium-High Risk)**:
- Feature flag: `useWebGLCompositing`
- Automatic fallback to Canvas2D if WebGL2 unavailable
- Device capability detection before enabling

---

## Code Review Protocol

After each phase, run code reviewer agent with prompt:
```
Review the code changes for Phase N against these goals:
1. [Phase-specific quality gate items]
2. Performance impact on time-to-first-paint
3. Memory impact (no leaks, reasonable allocation)
4. Error handling (graceful degradation)
5. TypeScript type safety
6. Integration with existing telemetry
```

---

## User Decisions (Resolved)

### 1. Content Type Detection (`useContentTypeDetection`)
- **Decision**: ✅ Enable for all platforms
- **Rationale**: Obsidian plugin = Electron only. iOS/iPadOS mobile considered but classification overhead (~5ms) is acceptable for 60-80% speedup on scanned docs.

### 2. Progressive Tile Loading (Phase 4)
- **Decision**: ✅ Feature flag, default ON
- **Rationale**: Ship enabled for immediate value, allow disabling if issues arise.

### 3. WebGL Compositing
- **Decision**: ✅ Add as Phase 7
- **Rationale**: Include after core optimizations for additional 20-30% FPS boost.

### 4. Deferred (Not in This Plan)
- **Unified Coordinate Space** (`useUnifiedCoordinateSpace`): Defer to separate V4 architecture initiative
- **SharedArrayBuffer**: Keep auto-detection (already working)

---

## Verification Protocol

### Before Implementation (Baseline)
```bash
# 1. Build and deploy
npm run build:no-server
cp temp/vault/.obsidian/plugins/amnesia/main.js \
   "/Users/josueguevara/Library/Mobile Documents/iCloud~md~obsidian/Documents/test/.obsidian/plugins/amnesia/main.js"

# 2. Connect MCP
mcp__obsidian-devtools__obsidian_connect()
mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })

# 3. Run baseline benchmark
window.pdfBenchmarkSuite.runBaseline()
```

### After Each Phase
```bash
# 1. Build and deploy (same as above)
# 2. Connect MCP (same as above)

# 3. Run phase benchmark
window.pdfBenchmarkSuite.runPhase(N)

# 4. Compare to baseline
window.pdfBenchmarkSuite.compareToBaseline()

# 5. Run code review agent
# (via Claude Code Task tool)
```

### Final Verification
```bash
# Full benchmark suite
window.pdfBenchmarkSuite.runFull()

# Generate report
window.pdfBenchmarkSuite.exportReport('/tmp/amnesia-benchmark-final.json')
```

---

## Timeline

| Phase | Estimated Effort | Dependencies |
|-------|-----------------|--------------|
| Benchmark Suite | 2-3 hours | None |
| Phase 1 (Skeleton) | 2-3 hours | None |
| Phase 2 (Workers) | 2-3 hours | None |
| Phase 3 (Thumbnails) | 4-5 hours | None |
| Phase 4 (Progressive) | 5-6 hours | Phase 1 |
| Phase 5 (Adaptive) | 3-4 hours | None |
| Phase 6 (Priority) | 2-3 hours | None |
| Phase 7 (WebGL) | 4-5 hours | Phases 1-6 |
| **Total** | **24-32 hours** | |

**Parallelization Strategy**:
- Phases 1, 2, 3, 5, 6 can be developed in parallel
- Phase 4 depends on Phase 1 (skeleton integration)
- Phase 7 should be done last (builds on all previous phases)

---

## Appendix: Key File Locations

| File | Purpose |
|------|---------|
| `pdf-infinite-canvas.ts` | Main canvas, initialization, rendering |
| `render-coordinator.ts` | Request deduplication, priority queue |
| `tile-cache-manager.ts` | 3-tier cache (L1/L2/L3) |
| `worker-pool-manager.ts` | Worker lifecycle, load balancing |
| `progressive-tile-renderer.ts` | Multi-resolution rendering |
| `pdf-telemetry.ts` | Performance metrics collection |
| `feature-flags.ts` | Feature toggles and capability detection |
| `scroll-strategy.ts` | Velocity-based prefetching |
| `zoom-state-machine.ts` | Zoom gesture handling |

---

*Plan prepared: 2026-01-14*
*Ready for user review and approval*

# PDF Renderer Performance Optimization Plan v2.0

**Date**: 2026-01-14
**Status**: APPROVED - Ready for Implementation
**Base Version**: v0.5.2+ (post-remediation commit 225ab77)
**Previous Plan Version**: v1.0 (partial failure due to integration gaps)

---

## Executive Summary

### Problem Statement

The v1.0 optimization plan was implemented but had **critical integration bugs** preventing performance gains. Despite 7 phases of optimization code existing, only **36% effective integration** was achieved:

| Phase | Code Status | Integration Status | Effectiveness |
|-------|-------------|-------------------|---------------|
| 1. Skeleton UI | Deleted (dead code) | N/A | 0% |
| 2. Worker Pre-warm | Complete | Working | 95% |
| 3. Thumbnail Cache | Complete | Race condition | 60% |
| 4. Progressive Tiles | Complete (774 lines) | **Dead code** | 0% |
| 5. Adaptive Quality | Complete | Working | 75% |
| 6. Viewport Priority | Complete | Working | 100% |
| 7. WebGL Compositor | Complete (710 lines) | **Disabled** | 0% |

### Current vs Target Performance

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| **Time to First Paint** | 4000-5000ms | <500ms | 87-90% |
| **Time to Usable (50%)** | 5000-6000ms | <1000ms | 80-83% |
| **Re-open Time** | 4000-5000ms | <200ms | 95%+ |
| **Worker Init Time** | 568ms (cold) | <50ms | 91% |
| **Cache Hit Rate (re-open)** | 0% | >90% | 90%+ |
| **Scroll FPS** | ~30 fps | 55-60 fps | 50% |

### Solution Approach

This v2.0 plan focuses on **integration** rather than new code. The optimization code exists; we need to wire it into the critical path correctly.

---

## Benchmarking Strategy

### Programmatic Benchmark Suite

All measurements MUST be captured programmatically before and after each phase. We will create `benchmark-suite.ts` with automated tests.

#### Benchmark Result Interface

```typescript
interface BenchmarkResult {
  // Critical timing metrics
  timeToFirstPaint: number;      // ms from load() to first tile displayed
  timeToUsable: number;          // ms until >50% viewport rendered
  timeToComplete: number;        // ms until all visible tiles rendered

  // Worker metrics
  workerInitTime: number;        // ms for worker pool initialization
  workerPrewarmSuccess: boolean; // whether prewarm completed before first PDF

  // Cache metrics
  cacheHitRate: number;          // 0-1, overall cache hit rate
  l1HitRate: number;             // 0-1, memory cache hit rate
  thumbnailCacheHits: number;    // count of thumbnail cache hits on re-open

  // Render pipeline
  avgTileRenderTime: number;     // ms average per tile (WASM)
  p95TileRenderTime: number;     // ms 95th percentile
  pipelineStages: {
    pageLoad: number;            // MuPDF page load
    render: number;              // Rasterization
    encode: number;              // PNG/RGBA encoding
    transfer: number;            // Worker→Main transfer
    decode: number;              // ImageBitmap decode
    display: number;             // Canvas drawImage
  };

  // Interaction metrics
  scrollFps: number;             // average FPS during scroll
  scrollJankEvents: number;      // frames >16.67ms
  zoomLatency: number;           // ms from gesture to tile update

  // Memory
  peakMemoryMB: number;
  avgMemoryMB: number;
}
```

#### Test Documents

| Document | Size | Purpose |
|----------|------|---------|
| `small.pdf` | 10 pages, text-heavy | Baseline, fast open |
| `medium.pdf` | 100 pages, mixed | Typical use case |
| `dragon-book.pdf` | 947 pages | Stress test |
| `scanned.pdf` | Image-heavy | Content-type detection test |

#### Measurement Protocol

```typescript
// benchmark-suite.ts - to be created
export async function runBenchmark(pdfPath: string): Promise<BenchmarkResult> {
  // 1. Reset telemetry
  resetTelemetry();
  const telemetry = getTelemetry();

  // 2. Record start time
  const loadStart = performance.now();

  // 3. Open PDF via Amnesia command
  await app.commands.executeCommandById('amnesia:open-book');
  // Modal selection of test PDF

  // 4. Wait for timing events
  const firstPaintTime = await waitForEvent('amnesia:first-tile-rendered');
  const usableTime = await waitForEvent('amnesia:viewport-50-percent');
  const completeTime = await waitForEvent('amnesia:visible-tiles-complete');

  // 5. Run interaction tests
  await runScrollStressTest(3000); // 3 seconds
  await runZoomStressTest([1, 4, 8, 16]); // Zoom levels

  // 6. Collect results
  const stats = telemetry.getStats();
  const pipeline = telemetry.getPipelineStats();

  return {
    timeToFirstPaint: firstPaintTime - loadStart,
    timeToUsable: usableTime - loadStart,
    timeToComplete: completeTime - loadStart,
    // ... rest of metrics from telemetry
  };
}
```

#### MCP Execution

```javascript
// Via obsidian_execute_js
async function executeBenchmarkSuite() {
  const results = {};

  for (const doc of ['small.pdf', 'medium.pdf', 'dragon-book.pdf', 'scanned.pdf']) {
    // Fresh open (cold cache)
    results[`${doc}-fresh`] = await window.pdfBenchmarkSuite.run(doc);

    // Re-open (warm cache)
    results[`${doc}-reopen`] = await window.pdfBenchmarkSuite.run(doc);
  }

  return JSON.stringify(results, null, 2);
}
```

### Success Criteria

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Time to first paint | 4000-5000ms | <500ms | Programmatic event |
| Time to usable | 5000-6000ms | <1000ms | Programmatic event |
| Re-open time | 4000-5000ms | <200ms | Thumbnail cache path |
| Worker init | 568ms | <50ms | Telemetry metric |
| Cache hit (re-open) | 0% | >90% | Telemetry metric |
| Scroll FPS | 30-45 | 55-60 | RAF callback timing |
| Jank events/session | 50-100 | <10 | Frame time >16.67ms |
| Zoom latency | 300-500ms | <100ms | Input-to-visual tracking |

---

## Implementation Phases

### Phase 0: Benchmark Infrastructure
**Priority**: P0 - Required for all other phases
**Goal**: Establish programmatic baseline measurements

#### Tasks

1. **Create benchmark-suite.ts**
   - Automated benchmark runner
   - MCP-callable interface via `window.pdfBenchmarkSuite`
   - JSON export of results
   - Comparison to baseline

2. **Add timing events to rendering pipeline**
   - `amnesia:first-tile-rendered` event
   - `amnesia:viewport-50-percent` event
   - `amnesia:visible-tiles-complete` event
   - `amnesia:worker-pool-ready` event

3. **Add telemetry tracking**
   - `timeToFirstPaint` metric
   - `workerPrewarmTime` metric
   - `thumbnailCacheHits` metric

#### Files to Create/Modify

| File | Action | Changes |
|------|--------|---------|
| `src/reader/renderer/pdf/benchmark-suite.ts` | CREATE | Full benchmark harness |
| `src/reader/renderer/pdf/pdf-telemetry.ts` | MODIFY | Add timing event emissions |
| `src/reader/renderer/pdf/pdf-infinite-canvas.ts` | MODIFY | Emit timing events |

#### Quality Gate

- [ ] `window.pdfBenchmarkSuite.run()` executes without errors
- [ ] All 8 key metrics are captured programmatically
- [ ] Results exported as JSON for comparison
- [ ] Baseline captured for dragon-book.pdf (947 pages)

---

### Phase 1: Loading Placeholder UI
**Priority**: P0 - Immediate perceived responsiveness
**Goal**: Spinner + transparent placeholder (Preview.app style) instead of blank screen

#### User Decision

> "It doesn't work. spinner + transparent placeholder is more elegant and standard practice in Preview.app etc"

#### Tasks

1. **Add loading placeholder to pdf-infinite-canvas.ts**
   - Show spinner centered in viewport immediately
   - Transparent placeholder boxes for page outlines
   - Hide when first tiles render

2. **CSS styling for placeholder**
   - Spinner animation (CSS-only, no JS)
   - Page outlines with subtle border
   - Dark mode compatible

#### Implementation

```typescript
// pdf-infinite-canvas.ts - add to initialize()
private showLoadingPlaceholder(): void {
  const placeholder = document.createElement('div');
  placeholder.className = 'pdf-loading-placeholder';
  placeholder.innerHTML = `
    <div class="pdf-spinner"></div>
    <div class="pdf-page-outlines"></div>
  `;
  this.container.appendChild(placeholder);
  this.loadingPlaceholder = placeholder;
}

private hideLoadingPlaceholder(): void {
  this.loadingPlaceholder?.remove();
  this.loadingPlaceholder = null;
}
```

```css
/* styles.css */
.pdf-loading-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background-primary);
}

.pdf-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--background-modifier-border);
  border-top-color: var(--interactive-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

#### Files to Modify

| File | Changes |
|------|---------|
| `src/reader/renderer/pdf/pdf-infinite-canvas.ts` | Add showLoadingPlaceholder/hideLoadingPlaceholder |
| `src/styles.css` | Add spinner and placeholder CSS |

#### Quality Gate

- [ ] Placeholder visible in <50ms after load() called
- [ ] No blank screen at any point during load
- [ ] Placeholder hides cleanly when first tile renders
- [ ] Works correctly in both light and dark modes
- [ ] Code review passes with no critical issues

---

### Phase 2: Worker Pre-warm Verification
**Priority**: P1 - Quick win, already mostly implemented
**Goal**: Verify workers are ready before first PDF open

#### Current Status

Worker pre-warming is implemented and called from `main.ts:164`, but:
- No telemetry tracking prewarm completion
- No verification workers are ready before PDF open
- Fire-and-forget pattern obscures failures

#### Tasks

1. **Add telemetry to worker pool**
   - Track prewarm start/end time
   - Log confirmation message
   - Emit `amnesia:worker-pool-ready` event

2. **Add readiness check**
   - `isWorkerPoolReady()` function
   - Check before first PDF open
   - Show indicator if workers still initializing

#### Implementation

```typescript
// worker-pool-manager.ts
export async function prewarmWorkerPool(count: number = 4): Promise<void> {
  const startTime = performance.now();
  console.log(`[WorkerPool] Pre-warming ${count} workers...`);

  // Initialize workers in parallel
  await initializePool(count);

  const duration = performance.now() - startTime;
  console.log(`[WorkerPool] Pre-warm complete in ${duration.toFixed(0)}ms`);

  // Track in telemetry
  getTelemetry().trackCustomMetric('workerPrewarmTime', duration);

  // Emit event for benchmark suite
  window.dispatchEvent(new CustomEvent('amnesia:worker-pool-ready', {
    detail: { duration }
  }));
}

export function isWorkerPoolReady(): boolean {
  return poolInstance?.ready ?? false;
}
```

#### Files to Modify

| File | Changes |
|------|---------|
| `src/reader/renderer/pdf/worker-pool-manager.ts` | Add telemetry, event emission |
| `src/main.ts` | Verify prewarm call is non-blocking |

#### Quality Gate

- [ ] Console shows "Pre-warm complete in Xms" on plugin load
- [ ] `workerPrewarmTime` metric tracked in telemetry
- [ ] `amnesia:worker-pool-ready` event emitted
- [ ] Workers ready before first PDF open (verified via benchmark)
- [ ] Code review passes with no critical issues

---

### Phase 3: Thumbnail Cache Race Fix
**Priority**: P0 - Critical for re-open performance
**Goal**: Fix race condition in IndexedDB warming

#### Current Status

`warmFromIndexedDB()` is called but:
- Fire-and-forget pattern causes race condition
- Thumbnails may not be ready when UI tries to display
- First render might miss cached thumbnails

#### Tasks

1. **Track warming Promise**
   - Store Promise in provider
   - Await before first thumbnail access

2. **Verify thumbnail persistence**
   - Confirm thumbnails written on document close
   - Verify IndexedDB entries exist

#### Implementation

```typescript
// hybrid-document-provider.ts
class HybridDocumentProvider {
  private thumbnailWarmPromise: Promise<number> | null = null;

  async loadDocument(buffer: ArrayBuffer): Promise<DocumentInfo> {
    // ... existing code ...

    // Start warming (don't await yet)
    this.thumbnailWarmPromise = this.cache.warmFromIndexedDB(
      docId,
      docHash,
      this.parsedDocument.itemCount
    );

    this.thumbnailWarmPromise.catch((err) => {
      console.warn('[HybridDocumentProvider] IndexedDB warm failed:', err);
    });
  }

  async getThumbnail(pageNum: number): Promise<Blob | null> {
    // Wait for warming to complete before first thumbnail access
    if (this.thumbnailWarmPromise) {
      await this.thumbnailWarmPromise;
      this.thumbnailWarmPromise = null; // Clear after first use
    }

    // ... existing implementation ...
  }
}
```

#### Files to Modify

| File | Changes |
|------|---------|
| `src/reader/renderer/hybrid-document-provider.ts` | Add Promise tracking |
| `src/reader/renderer/pdf/thumbnail-idb-cache.ts` | Verify no remaining race conditions |

#### Quality Gate

- [ ] Re-open time <200ms (measured via benchmark)
- [ ] Cache hit rate >90% on re-opens
- [ ] IndexedDB entries verified via DevTools
- [ ] No race condition warnings in console
- [ ] Code review passes with no critical issues

---

### Phase 4: Progressive Tile Renderer Integration
**Priority**: P0 - Biggest expected performance gain
**Goal**: Wire 774-line progressive-tile-renderer.ts into rendering pipeline

#### Current Status

`progressive-tile-renderer.ts` exists with full implementation but:
- `renderTileProgressive()` is never called
- Only helper functions (`getTargetScaleTier()`) are used
- Full 3-tier progressive rendering completely bypassed

#### User Decision

> "Full integration (Recommended)" - Wire into rendering pipeline for 3-tier progressive quality

#### Tasks

1. **Integrate into tile-render-engine.ts**
   - Add `renderTileProgressively()` method
   - Replace single-shot rendering with progressive pipeline
   - Use thumbnail→medium→full quality tiers

2. **Add CSS stretch display**
   - Support cssStretch parameter in tile display
   - Smooth transition between quality tiers

3. **Track progressive rendering telemetry**
   - Time for each tier
   - Quality transitions logged

#### Implementation

```typescript
// tile-render-engine.ts
import { getProgressiveTileRenderer, ProgressiveTileResult } from './progressive-tile-renderer';

class TileRenderEngine {
  async renderTileProgressively(
    tile: TileCoordinate,
    targetScale: ScaleTier
  ): Promise<void> {
    const progressive = getProgressiveTileRenderer();

    if (!this.renderCallback) {
      console.warn('[TileRenderEngine] No render callback set');
      return;
    }

    progressive.setRenderCallback(this.renderCallback);
    progressive.setDocument(this.documentId!);

    for await (const result of progressive.renderTileProgressive(tile, targetScale)) {
      const { scale, result: renderResult, isFinal, cssScaleFactor } = result;

      // Display with CSS stretch for intermediate tiers
      await this.displayTileWithStretch(tile, renderResult, scale, cssScaleFactor);

      if (isFinal) {
        getTelemetry().trackCustomMetric('progressiveRenderComplete', 1);
      }
    }
  }
}
```

```typescript
// pdf-infinite-canvas.ts - update triggerTilePrefetch()
private async renderVisibleTiles(): Promise<void> {
  const visibleTiles = this.calculateVisibleTiles();

  for (const tile of visibleTiles) {
    const { tier: targetScale } = getTargetScaleTier(
      this.camera.zoom,
      this.config.pixelRatio
    );

    // Use progressive rendering instead of single-shot
    await this.tileEngine.renderTileProgressively(tile, targetScale);
  }
}
```

#### Files to Modify

| File | Changes |
|------|---------|
| `src/reader/renderer/pdf/tile-render-engine.ts` | Add renderTileProgressively() method |
| `src/reader/renderer/pdf/pdf-infinite-canvas.ts` | Call progressive instead of direct |
| `src/reader/renderer/pdf/pdf-page-element.ts` | Support cssStretch parameter |

#### Quality Gate

- [ ] First paint <500ms (low-res tier)
- [ ] Final quality <2000ms
- [ ] No visual artifacts during quality transitions
- [ ] `progressiveRenderComplete` metric tracked
- [ ] Code review passes with no critical issues

---

### Phase 5: Adaptive Quality Verification
**Priority**: P2 - Already working, needs verification
**Goal**: Verify adaptive quality actually improves scroll FPS

#### Current Status

Adaptive quality is integrated but:
- No telemetry showing it actually reduces render load
- Quality factor calculated but effect unclear

#### Tasks

1. **Add debug logging**
   - Log quality factor during fast scroll
   - Track quality reductions in telemetry

2. **Verify quality upgrade callback**
   - Confirm tiles re-render at full quality when idle

#### Files to Modify

| File | Changes |
|------|---------|
| `src/reader/renderer/pdf/adaptive-quality.ts` | Add debug logging |
| `src/reader/renderer/pdf/pdf-infinite-canvas.ts` | Log quality factor usage |

#### Quality Gate

- [ ] Console shows quality factor changes during scroll
- [ ] Scroll FPS improved at high zoom (measured via benchmark)
- [ ] Quality upgrade fires when scroll stops
- [ ] Code review passes with no critical issues

---

### Phase 6: WebGL Compositor Integration
**Priority**: P1 - Significant FPS improvement expected
**Goal**: Enable and integrate WebGL compositing for GPU-accelerated tile rendering

#### User Decision

> "Enable (Recommended)" - Complete tile upload/render integration

#### Current Status

`webgl-compositor.ts` exists (710 lines) but:
- Feature flag `useWebGLCompositing: false`
- No tile upload/render calls in pdf-infinite-canvas.ts
- Infrastructure exists but never used

#### Tasks

1. **Enable feature flag**
   - Change to `useWebGLCompositing: 'auto'`
   - Auto-enable when WebGL2 available

2. **Integrate tile upload**
   - Call `webglCompositor.uploadTile()` when tile renders
   - Manage texture atlas

3. **Integrate batch rendering**
   - Call `webglCompositor.render()` for visible tiles
   - Fall back to Canvas2D if WebGL unavailable

#### Implementation

```typescript
// pdf-infinite-canvas.ts - in tile rendering section
private async displayTileBitmap(
  tile: TileCoordinate,
  bitmap: ImageBitmap,
  options: { cssStretch?: number } = {}
): Promise<void> {
  if (this.webglCompositor?.isAvailable()) {
    // Upload to GPU texture
    this.webglCompositor.uploadTile(
      tile.page,
      tile.tileX,
      tile.tileY,
      tile.scale,
      bitmap
    );

    // Batch render will be called in renderFrame()
    getTelemetry().trackCustomMetric('webglTileUpload', 1);
  } else {
    // Canvas2D fallback
    const ctx = this.displayCanvas.getContext('2d')!;
    ctx.drawImage(bitmap, x, y, width, height);
  }
}

private renderFrame(): void {
  if (this.webglCompositor?.isAvailable()) {
    // Collect visible tile info
    const tileInfos: TileRenderInfo[] = this.visibleTiles.map(tile => ({
      page: tile.page,
      tileX: tile.tileX,
      tileY: tile.tileY,
      scale: tile.scale,
      destX: tile.screenX,
      destY: tile.screenY,
      destWidth: tile.width,
      destHeight: tile.height,
    }));

    // Single GPU draw call for all tiles
    this.webglCompositor.render(tileInfos, {
      x: this.camera.x,
      y: this.camera.y,
      z: this.camera.zoom,
    });

    getTelemetry().trackCustomMetric('webglBatchRender', tileInfos.length);
  }
}
```

```typescript
// feature-flags.ts
const DEFAULT_FLAGS: FeatureFlagDefinitions = {
  // ...
  useWebGLCompositing: 'auto', // Changed from false
  // ...
};
```

#### Files to Modify

| File | Changes |
|------|---------|
| `src/reader/renderer/pdf/feature-flags.ts` | Change to 'auto' |
| `src/reader/renderer/pdf/pdf-infinite-canvas.ts` | Add tile upload/render integration |
| `src/reader/renderer/pdf/webgl-compositor.ts` | Verify context loss handling |

#### Quality Gate

- [ ] 20-30% FPS improvement in scroll stress test
- [ ] Graceful fallback when WebGL2 unavailable
- [ ] No visual artifacts or texture bleeding
- [ ] Memory usage within 20% of Canvas2D baseline
- [ ] `webglTileUpload` and `webglBatchRender` metrics tracked
- [ ] Code review passes with no critical issues

---

## Quality Gate Protocol

### After Each Phase

1. **Build and deploy**
   ```bash
   cd apps/amnesia
   npm run build:no-server
   cp temp/vault/.obsidian/plugins/amnesia/main.js \
      "/Users/josueguevara/Library/Mobile Documents/iCloud~md~obsidian/Documents/test/.obsidian/plugins/amnesia/main.js"
   ```

2. **Connect MCP and reload**
   ```javascript
   mcp__obsidian-devtools__obsidian_connect()
   mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })
   ```

3. **Run benchmark suite**
   ```javascript
   const results = await window.pdfBenchmarkSuite.run('dragon-book.pdf');
   console.log(JSON.stringify(results, null, 2));
   ```

4. **Compare to baseline**
   ```javascript
   const comparison = await window.pdfBenchmarkSuite.compareToBaseline();
   console.log(comparison.summary);
   ```

5. **Run code review agent**
   - Launch `feature-dev:code-reviewer` agent
   - Review changes against phase goals
   - Address any findings before proceeding

### Code Review Checklist

For each phase, verify:
- [ ] Integration points correctly wired
- [ ] No dead code introduced
- [ ] Telemetry tracking added
- [ ] Error handling with graceful degradation
- [ ] Memory leaks prevented (cleanup in destroy())
- [ ] TypeScript types correct
- [ ] No performance regressions

---

## Risk Assessment

| Phase | Technical Risk | Integration Risk | Rollback |
|-------|---------------|------------------|----------|
| **Phase 0** (Benchmark) | Low | Low | N/A |
| **Phase 1** (Placeholder) | Low | Low | Easy |
| **Phase 2** (Workers) | Low | Low | Easy |
| **Phase 3** (Thumbnails) | Medium | Medium | Easy |
| **Phase 4** (Progressive) | Medium | High | Medium |
| **Phase 5** (Adaptive) | Low | Low | Easy |
| **Phase 6** (WebGL) | High | High | Medium |

### Mitigation Strategies

**Phase 4 (Progressive) - High Integration Risk:**
- Feature flag `useProgressiveLoading` for instant disable
- Test thoroughly with different PDF types
- Monitor for visual artifacts

**Phase 6 (WebGL) - High Technical Risk:**
- Feature flag `useWebGLCompositing` with 'auto' detection
- Automatic fallback to Canvas2D
- WebGL context loss handling verified
- Test on multiple GPU configurations

---

## Implementation Order

```
Phase 0: Benchmark Infrastructure
    ↓
Phase 1: Loading Placeholder UI ←── Can start immediately
    ↓
Phase 2: Worker Pre-warm Verification ←── Parallel with Phase 1
    ↓
Phase 3: Thumbnail Cache Race Fix
    ↓
Phase 4: Progressive Tile Renderer Integration ←── Biggest impact
    ↓
Phase 5: Adaptive Quality Verification
    ↓
Phase 6: WebGL Compositor Integration ←── Final polish
```

**Parallelization:**
- Phases 1 and 2 can be done in parallel (no dependencies)
- Phase 3 must precede Phase 4 (thumbnails feed progressive)
- Phase 6 should be last (builds on all previous work)

---

## Appendix: Research Sources

### PDF.js Performance
- [Progressive loading/rendering of PDFs - Mozilla PDF.js](https://github.com/mozilla/pdf.js/issues/9851)
- [PDF rendering performance optimization - Joyfill](https://joyfill.io/blog/optimizing-in-browser-pdf-rendering-viewing)
- [A slimmer and faster pdf.js - Nicholas Nethercote](https://blog.mozilla.org/nnethercote/2014/02/07/a-slimmer-and-faster-pdf-js/)

### WebGL vs Canvas Performance
- [Canvas vs WebGL Performance - DigitalAdBlog](https://digitaladblog.com/2025/05/21/comparing-canvas-vs-webgl-for-javascript-chart-performance/)
- [Real-Time Dashboard Performance Benchmarks - Dev3lop](https://dev3lop.com/real-time-dashboard-performance-webgl-vs-canvas-rendering-benchmarks/)
- [GPU Accelerated Compositing in Chrome](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/)

### Worker Pool Patterns
- [Advanced Guide to Web Workers - Medium](https://medium.com/@sohail_saifi/an-advanced-guide-to-web-workers-in-javascript-for-performance-heavy-tasks-67d27b5c2448)
- [Improve Web Worker Performance 2025 - PotentPages](https://potentpages.com/web-design/website-speed/improve-web-worker-performance)
- [workerpool - GitHub](https://github.com/josdejong/workerpool)

### IndexedDB Caching
- [Triple-Layered Web Caching Strategy - Thnk And Grow](https://blog.thnkandgrow.com/triple-layer-caching-strategy-memory-indexeddb-http-improve-speed-96-percent/)
- [Browser Storage Deep Dive: Cache vs IndexedDB - DEV Community](https://dev.to/mino/browser-storage-deep-dive-cache-vs-indexeddb-for-scalable-pwas-35f4)
- [Offline-first frontend apps 2025 - LogRocket](https://blog.logrocket.com/offline-first-frontend-apps-2025-indexeddb-sqlite/)

---

*Plan prepared: 2026-01-14*
*Version: 2.0*
*Status: Ready for implementation*

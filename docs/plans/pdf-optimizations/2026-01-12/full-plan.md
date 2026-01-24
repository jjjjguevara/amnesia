# PDF Renderer Performance Optimization Plan

**Created**: 2026-01-12
**Previous Session**: 2026-01-09 (Phases 0-5 implemented)
**Context**: Session focused on fixing scroll/zoom performance issues, implementing overclock settings, and resource detection.

**Deliverables Location**: `/docs/plans/pdf-optimizations/2026-01-12/`

---

## Implementation Summary: Carried Over vs New Work

### From 2026-01-09 Session (COMPLETE)

| Phase | Status | Key Achievement |
|-------|--------|-----------------|
| Phase 0: Telemetry | ✅ Complete | `pdf-telemetry.ts` (1,339 LOC), feature flags, benchmarks |
| Phase 1: Raw RGBA | ⚠️ Partial | 26% improvement (vs 70% target), SharedArrayBuffer NOT implemented |
| Phase 2: Multi-Res Zoom | ✅ Complete | `zoom-transform-layer.ts`, `progressive-tile-renderer.ts` - 80-90% perceived latency reduction |
| Phase 3: Multi-Worker | ⚠️ 90% | 4-worker pool (580 LOC), 3x throughput, shared WASM NOT implemented |
| Phase 4: Grid Mode | ⚠️ 85% | Parallel thumbnails, IndexedDB cache, speed targets NOT benchmarked |
| Phase 5: Content-Type | ⚠️ 85% | 285x JPEG speedup, vector optimization NOT wired |

### From 2026-01-09 Session (PENDING - To Be Addressed)

| Item | Status | This Session Priority |
|------|--------|----------------------|
| SharedArrayBuffer Pool | ❌ Not started | P2 (after core fixes) |
| Vector Scale Optimization | Code exists, not wired | P1 (wire existing code) |
| ZoomTransformLayer Integration | NOT integrated with infinite canvas | **P0 (critical bug)** |
| Camera snapshot usage | NOT used in tile visibility | **P0 (critical bug)** |
| Blob URL Leak Fix | ❌ Not started | P3 |
| 1000-page memory test | ❌ Not validated | P2 |

### New in 2026-01-12 Session

| Item | Priority | Description |
|------|----------|-------------|
| Camera Snapshot Fix | P0 | Use snapshot in tile visibility calculation |
| ZoomTransformLayer Integration | P0 | Wire existing component to infinite canvas |
| ZoomTransformLayer Regression Fix | P0 | **NEW** - Create separate container per research doc 05 |
| AbortController for Renders | P1 | Cancel obsolete in-flight renders |
| Hybrid Renderer Architecture | P1 | **NEW** - Full-page vs tiled based on zoom level |
| Performance Settings UI | P1 | 4 presets with overclock capability |
| Resource Detector | P2 | System profiler + recommendations |
| Settings Spec Document | P1 | Document all exposed settings |

---

## Code Review Validation Protocol

**CRITICAL**: After each phase, use the `feature-dev:code-reviewer` agent to validate:
1. No regressions in existing functionality
2. Code follows codebase patterns
3. Telemetry is capturing new metrics
4. No new memory leaks or performance issues

**Command Template**:
```
Task: feature-dev:code-reviewer
Prompt: Review changes in [files] for Phase X. Check for:
- Logic errors and race conditions
- Memory leaks (unclosed ImageBitmaps, dangling refs)
- Adherence to camera snapshot pattern
- Proper error handling for AbortError
- Integration with existing telemetry
```

**Do NOT proceed to next phase until all HIGH severity findings are addressed.**

---

## Executive Summary

The PDF renderer has sophisticated architecture (camera snapshots, 3-tier cache, velocity prefetch, progressive rendering) but critical integration gaps cause blank tiles during fast scroll/zoom. This plan addresses 5 core issues, adds user-configurable performance settings, and implements a resource detector for adaptive optimization.

---

## Phase 1: Core Performance Fixes

### 1.1 Camera Snapshot Usage (HIGH - 50% of blank tile issues)

**Problem**: Camera snapshot captured at debounce time (line 2007) but `this.visiblePages` used directly (line 2012) which reflects CURRENT camera, not snapshot.

**File**: `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts`

**Fix** (Lines 2010-2016):
```typescript
// BEFORE: Uses this.visiblePages (stale)
for (const page of this.visiblePages) {
  if (this.needsZoomRerender(page)) {
    pagesToRerender.push(page);
  }
}

// AFTER: Recalculate from snapshot
const snapshotVisiblePages = this.calculateVisiblePages(this.scrollRenderCameraSnapshot);
for (const page of snapshotVisiblePages) {
  if (this.needsZoomRerender(page)) {
    pagesToRerender.push(page);
  }
}
```

**Verification**: `await window.pdfLifecycleTests.runTest('scrollStress')` - expect <5% blank tiles

---

### 1.2 ZoomTransformLayer Integration (HIGH - Poor zoom transitions)

**Problem**: `ZoomTransformLayer` exists with proper progressive phases (immediate/50ms/200ms) but is NOT imported or used in `pdf-infinite-canvas.ts`.

**Files to Modify**:
- `pdf-infinite-canvas.ts` - Import and wire ZoomTransformLayer
- Remove manual timeout management (lines ~1950-2030)

**Integration Points**:
1. Import: `import { ZoomTransformLayer } from './zoom-transform-layer'`
2. Initialize in constructor
3. Replace `scheduleZoomRerender()` with `zoomLayer.onZoomGesture()`
4. Wire phase callbacks to existing render methods

**Verification**: Zoom should feel instant (<16ms CSS), progressive refinement visible at 50ms/200ms

---

### 1.3 AbortController for Obsolete Renders (MEDIUM)

**Problem**: Old timeouts cleared but in-flight RenderCoordinator renders continue, wasting work.

**Files to Modify**:
- `render-coordinator.ts` - Add `AbortController` tracking per request
- `tile-render-engine.ts` - Check `signal.aborted` before WASM calls
- `wasm-renderer.ts` - Wire signal to worker communication
- `mupdf-worker.ts` - Handle abort in worker

**Key Change** (render-coordinator.ts):
```typescript
private activeControllers = new Map<string, AbortController>();

enqueueRender(request: RenderRequest): void {
  const key = this.generateKey(request);
  this.activeControllers.get(key)?.abort(); // Cancel previous
  const controller = new AbortController();
  this.activeControllers.set(key, controller);
  // Pass signal through pipeline
}
```

**Verification**: Rapid zoom (10 changes) should produce <20 renders (vs 50+ baseline)

---

### 1.4 OffscreenCanvas ImageBitmap Creation (LOW - 5-10ms main thread savings)

**Problem**: `createImageBitmap()` called on main thread, blocking during tile load.

**Files to Modify**:
- `mupdf-worker.ts` - Create ImageBitmap in worker, transfer ownership
- `wasm-renderer.ts` - Update return type to receive ImageBitmap directly
- `tile-render-engine.ts` - Remove main thread bitmap creation

**Verification**: Fewer long tasks (>16ms) during scroll stress test

---

### 1.5 Scale Tracking Consistency (MEDIUM)

**Problem**: Global `currentRenderScale` can desync during rapid zoom when multiple async paths update it.

**Solution**: Implement scale lock mechanism to prevent concurrent scale updates.

**File**: `pdf-infinite-canvas.ts`
```typescript
private scaleState = {
  current: 1.0,
  pending: null as number | null,
  locked: false
};

private lockScale(scale: number): () => void { ... }
```

**Verification**: Max 2 scale tiers visible simultaneously during rapid zoom

---

## Phase 2: Performance Settings System

### 2.1 Settings Interface

**New File**: `apps/amnesia/src/reader/renderer/pdf/performance-settings-manager.ts`

**Settings to Expose** (with overclock capability):

| Setting | Balanced | Performance | Memory Saver | Quality |
|---------|----------|-------------|--------------|---------|
| L1 Cache | 50/50MB | 100/100MB | 30/30MB | 80/80MB |
| L2 Cache | 200/200MB | 300/300MB | 100/100MB | 250/250MB |
| Workers | auto | 4 | 1 | auto |
| Scroll Debounce | 32ms | 16ms | 64ms | 50ms |
| Zoom Debounce | 150ms | 50ms | 250ms | 200ms |
| Prefetch Viewports | 2 | 3 | 1 | 2 |
| Max Tile Scale | 32 | 32 | 16 | 32 |
| Fast Scroll Quality | 50% | 75% | 50% | 90% |

### 2.2 Hot-Reload Mechanism

- Settings manager uses subscriber pattern
- Components subscribe: `tileCacheManager`, `workerPoolManager`, `scrollStrategy`, `progressiveTileRenderer`
- Changes apply immediately without restart

### 2.3 Files to Modify

- `settings/settings.ts` - Add `PdfPerformanceSettings` interface (~40 lines)
- `tile-cache-manager.ts` - Add `updateLimits(config)` method
- `worker-pool-manager.ts` - Add `setWorkerCount()` method
- `scroll-strategy.ts` - Wire settings subscription
- `settings-tab/` - Add "PDF Performance" tab with preset selector

---

## Phase 3: Resource Detector System

### 3.1 Components

1. **SystemProfiler** - Detect hardware at startup (CPU cores, memory, GPU tier)
2. **RuntimeMonitor** - Track live metrics (FPS, memory pressure, thermal throttling)
3. **RecommendationEngine** - Decision matrix (6 rules initially)
4. **PromptManager** - Non-intrusive prompts via Obsidian Notice/Modal
5. **PreferenceStore** - Persist user choices (dismissed, never-show)

### 3.2 Initial Rules

| Trigger | Severity | Action |
|---------|----------|--------|
| Low-end device + 500+ page PDF | Warning | Suggest Memory Saver preset |
| 16x zoom + retina + <8GB RAM | Warning | Cap zoom at 6x or reduce scale |
| Battery <20% | Info | Offer Power Saver mode |
| Thermal throttling detected | Warning | Auto-reduce workers |
| Critical memory pressure | Critical | Auto-apply cache cleanup |
| Sustained high CPU | Warning | Suggest reducing workers |

### 3.3 New Files

- `resource-capacity-detector.ts` - Orchestrator (~200 lines)
- `system-profiler.ts` - Hardware detection (~300 lines)
- `runtime-monitor.ts` - Live tracking (~400 lines)
- `recommendation-engine.ts` - Decision logic (~150 lines)
- `recommendation-rules.ts` - Rule definitions (~300 lines)
- `prompt-manager.ts` - UI prompts (~350 lines)
- `preference-store.ts` - Persistence (~150 lines)

---

## Phase 4: Telemetry Validation

### 4.1 Current Coverage (Verified Complete)

- Cache metrics: L1/L2/L3 hit rates, evictions
- Render timing: Page/tile render times, P95/P99
- Pipeline stages: pageLoad, render, encode, transfer, decode, cache, display
- Scroll metrics: FPS, jank events, velocity tracking
- Zoom metrics: Changes, time per level, distribution
- Worker metrics: Utilization, pending tasks
- Memory: Current, peak, average

### 4.2 Benchmarks to Use

```javascript
// Lifecycle tests
await window.pdfLifecycleTests.runTest('scrollStress');      // Scroll continuity
await window.pdfLifecycleTests.runTest('zoomTransitions');   // Zoom smoothness
await window.pdfLifecycleTests.runTest('tileCache');         // Cache efficiency
await window.pdfLifecycleTests.runTest('prefetchStrategy');  // Prefetch accuracy

// Benchmark suite
await window.pdfBenchmarks.runAll();
window.pdfBenchmarks.formatReport(results);
```

### 4.3 Performance Targets

| Metric | Target | How to Measure |
|--------|--------|----------------|
| First tile visible | <100ms | `telemetry.firstTileTime` |
| Scroll FPS | >=60 | `telemetry.scrollAvgFps` |
| Blank tiles | <5% | Count during scrollStress |
| Zoom CSS phase | <16ms | DevTools Performance |
| Zoom full render | <500ms | `telemetry.avgRenderTime` at 16x |
| Memory at 16x | <500MB | `telemetry.peakMemoryMB` |

---

## Phase 5: Settings Specification Document

### 5.1 Document Location

`/docs/specifications/settings/reader-performance.md`

### 5.2 Structure (Reader-Wide)

```markdown
# Reader Performance Settings Specification

**Draft**: 2026-01-12
**Context**: PDF optimization work session

## Overview
Unified performance settings for PDF and EPUB readers with format-specific optimizations.

## Shared Settings (PDF + EPUB)
- Cache tier sizes
- Prefetch strategy (none/fixed/adaptive)
- Rendering debounce
- Worker allocation

## PDF-Specific Settings
- Tile scale limits
- Velocity-based quality reduction
- Progressive zoom phases
- Content-type detection

## EPUB-Specific Settings (Future)
- Chapter window size
- Column calculation strategy
- Scroll position snapshot pattern (mirror PDF camera snapshot)

## Presets
[Balanced, Performance, Memory Saver, Quality tables]

## Impacted Files
[List all modified files with line references]

## Expected Benchmarks
[Performance targets by preset]
```

---

## Phase 6: WASM Compiler Pattern Notes

### 6.1 Non-Negotiable Capabilities (Observed)

1. **Page rendering to ImageData/ImageBitmap** - Core functionality
2. **Text extraction** - Search, highlights
3. **Page dimensions** - Layout calculations
4. **Annotation support** - Highlight creation/editing
5. **Rotation handling** - Per-page rotation
6. **Print support** - (TODO noted in code)

### 6.2 Optimization Opportunities for Custom WASM

1. **Direct JPEG extraction** - Scanned PDFs (60-80% faster)
2. **Content-type classification** - Already stubbed, needs MuPDF backend
3. **SIMD acceleration** - WASM SIMD for rasterization
4. **SharedArrayBuffer** - Zero-copy transfer (already has feature flag)
5. **Streaming decode** - Progressive page loading

### 6.3 EPUB Consolidation Points

- Text rendering path could share with PDF text layers
- Image handling is similar (blob caching, resolution scaling)
- Search infrastructure could unify
- Annotation storage already unified

---

## Implementation Order (With Code Review Gates)

### Phase A: Critical Core Fixes (P0)

**A.1 Camera Snapshot Fix** (~1 hour)
- [ ] Modify `pdf-infinite-canvas.ts:2010-2016` to use `scrollRenderCameraSnapshot`
- [ ] Build and deploy to test vault
- [ ] Run `scrollStress` lifecycle test
- [ ] **CODE REVIEW GATE**: Run `feature-dev:code-reviewer` on changes
- [ ] Address all HIGH severity findings before proceeding

**A.2 ZoomTransformLayer Integration** (~4 hours) ✅ COMPLETE
- [x] Import `ZoomTransformLayer` in `pdf-infinite-canvas.ts`
- [x] Wire to existing zoom handling (replace manual timeouts)
- [x] **FIX REGRESSION**: Added `disableCssTransforms` config flag
  - Research analysis: Camera system already provides instant zoom feedback
  - Solution: Disable ZoomTransformLayer CSS transforms, keep timing/scheduling logic
  - Files changed: `zoom-transform-layer.ts` (added flag), `pdf-infinite-canvas.ts` (set flag)
- [x] Build and deploy
- [x] Validation: 61fps, 0 jank, no checkerboarding, no console errors
- [x] **CODE REVIEW GATE**: Passed - fixed `reset()` method to respect flag
- [x] All HIGH severity findings addressed

**A.3 AbortController Integration** (~3 hours)
- [ ] Add `AbortController` tracking to `render-coordinator.ts`
- [ ] Wire abort signals through `tile-render-engine.ts` and `wasm-renderer.ts`
- [ ] Build and deploy
- [ ] Test rapid zoom (expect <20 renders vs 50+ baseline)
- [ ] **CODE REVIEW GATE**: Review for async/error handling
- [ ] Address all HIGH severity findings

**Checkpoint A**: Run full lifecycle test suite, compare to baseline

---

### Phase A+: Hybrid Renderer Architecture (P1)

> **Reference**: Research doc `05-extreme-zoom-performance.md` lines 322-330:
> ```
> | 0.5-1x | 1-2 | 512px | Full page, no tiling |
> | 1-4x   | 2-4 | 256px | Standard tiles |
> | 4-8x   | 4-8 | 256px | Standard tiles |
> | 8-16x  | 8 → 16 | 128px | Progressive (8 then 16) |
> | 16x+   | 8 → 16 → 32 | 64px | Three-stage progressive |
> ```

**Rationale**: At low zoom (<1.5x), tiling adds overhead (4 render calls per page instead of 1). At high zoom (>4x), tiling is essential (only renders visible portion). The Hybrid Renderer dynamically selects the optimal strategy.

**A+.1 Hybrid Rendering Strategy** (~4 hours)
- [ ] Create `hybrid-rendering-strategy.ts` (~250 lines)
  ```typescript
  interface RenderingStrategy {
    shouldUseTiling(zoom: number, pageWidth: number, pageHeight: number): boolean;
    getOptimalTileSize(zoom: number): number;
  }
  ```
- [ ] Implement zoom threshold logic:
  - `zoom < 1.5`: Always full-page
  - `1.5 ≤ zoom ≤ 4.0`: Adaptive (based on page size + memory)
  - `zoom > 4.0`: Always tiled
- [ ] Add page size heuristics for adaptive zone
- [ ] **CODE REVIEW GATE**: Review threshold logic

**A+.2 Integration with Tile Render Engine** (~3 hours)
- [ ] Modify `tile-render-engine.ts` to query strategy before tiling
- [ ] Add full-page render path (bypass tile grid calculation)
- [ ] Wire to `render-coordinator.ts` for request routing
- [ ] **CODE REVIEW GATE**: Review integration points

**A+.3 Cache Compatibility** (~2 hours)
- [ ] Ensure `tile-cache-manager.ts` handles full-page cache entries
- [ ] Add cache key differentiation: `page-${pageNum}-full` vs `tile-${pageNum}-${x}x${y}`
- [ ] Verify eviction doesn't break mixed mode
- [ ] **CODE REVIEW GATE**: Review cache key collisions

**A+.4 Adaptive Tile Sizing** (~2 hours)
- [ ] Implement zoom-based tile size from research:
  - `zoom ≤ 2`: 512px tiles
  - `2 < zoom ≤ 8`: 256px tiles (current)
  - `8 < zoom ≤ 16`: 128px tiles
  - `zoom > 16`: 64px tiles
- [ ] Update `getTileSizeForZoom()` function
- [ ] **CODE REVIEW GATE**: Review memory impact

**Checkpoint A+**: Benchmark full-page vs tiled at 1x zoom
- Target: 40-60% fewer render calls at fit-to-width
- Memory: No regression at high zoom

---

### Phase B: Wire Existing Code (P1)

**B.1 Vector Scale Optimization** (~2 hours)
- [ ] Wire `getOptimizedRenderParams()` in `render-coordinator.ts:734-804`
- [ ] Add CSS transform application for vector pages
- [ ] Test with vector-heavy PDF (if available)
- [ ] **CODE REVIEW GATE**: Review integration points

**B.2 OffscreenCanvas ImageBitmap** (~1 hour)
- [ ] Move `createImageBitmap()` to `mupdf-worker.ts`
- [ ] Update return types in `wasm-renderer.ts`
- [ ] Verify fewer long tasks during scroll
- [ ] **CODE REVIEW GATE**: Review for transfer ownership correctness

**Checkpoint B**: Run benchmarks, verify no regressions

---

### Phase C: Performance Settings (P1)

**C.1 Settings Interface** (~2 hours)
- [ ] Create `PdfPerformanceSettings` interface in `settings.ts`
- [ ] Define 4 preset constants (Balanced, Performance, Memory Saver, Quality)
- [ ] Add to `LibrosSettings` and defaults
- [ ] **CODE REVIEW GATE**: Review interface design

**C.2 Settings Manager** (~3 hours)
- [ ] Create `performance-settings-manager.ts`
- [ ] Implement hot-reload via subscriber pattern
- [ ] Wire to `tile-cache-manager.ts`, `worker-pool-manager.ts`, etc.
- [ ] **CODE REVIEW GATE**: Review for memory leaks in subscriptions

**C.3 Settings UI Tab** (~4 hours)
- [ ] Create `pdf-performance-settings.ts` tab
- [ ] Implement preset selector with auto-switch to Custom
- [ ] Add parameter sliders with trade-off explainers
- [ ] **CODE REVIEW GATE**: Review UI for accessibility

**C.4 Settings Spec Document** (~2 hours)
- [ ] Write `/docs/specifications/settings/reader-performance.md`
- [ ] Document all parameters, files impacted, benchmarks

**Checkpoint C**: Verify settings persist and hot-reload works

---

### Phase D: Resource Detector (P2)

**D.1 System Profiler** (~2 hours)
- [ ] Create `system-profiler.ts` with hardware detection
- [ ] Implement device tier classification (low/mid/high)
- [ ] **CODE REVIEW GATE**: Review for browser compatibility

**D.2 Runtime Monitor** (~3 hours)
- [ ] Create `runtime-monitor.ts` with live metric tracking
- [ ] Implement thermal throttling detection
- [ ] Wire to existing telemetry
- [ ] **CODE REVIEW GATE**: Review for performance overhead

**D.3 Recommendation Engine** (~3 hours)
- [ ] Create `recommendation-engine.ts` with decision matrix
- [ ] Implement 6 initial rules
- [ ] **CODE REVIEW GATE**: Review rule logic

**D.4 Prompt Manager & Preferences** (~3 hours)
- [ ] Create `prompt-manager.ts` with Notice/Modal UI
- [ ] Create `preference-store.ts` for persistence
- [ ] Wire to infinite canvas
- [ ] **CODE REVIEW GATE**: Review for user agency (no auto-apply without consent except critical)

**Checkpoint D**: Test on simulated low-end device profile

---

### Phase E: Scale Tracking & Polish (P2)

**E.1 Scale Tracking Fix** (~2 hours)
- [ ] Implement scale lock mechanism in `pdf-infinite-canvas.ts`
- [ ] Prevent concurrent scale updates
- [ ] Verify max 2 scale tiers visible during rapid zoom
- [ ] **CODE REVIEW GATE**: Review state machine

**E.2 Final Validation** (~4 hours)
- [ ] Run full benchmark suite
- [ ] Compare all metrics to baseline
- [ ] Stress test with 1000-page PDF (<500MB memory)
- [ ] Update implementation summary

---

## Deliverables to Create in `/docs/plans/pdf-optimizations/2026-01-12/`

When exiting plan mode, create:

1. **`full-plan.md`** - This plan document (copy from plan file)
2. **`impl-summary.md`** - Implementation summary with:
   - What was carried over from 2026-01-09
   - What was newly implemented
   - What remains pending for future sessions
3. **`phase-X-review.md`** - Code review findings for each phase
4. **`benchmark-results.json`** - Final benchmark metrics
5. **`settings-spec.md`** - Link to `/docs/specifications/settings/reader-performance.md`

---

## Build & Test Commands

```bash
# Build
cd apps/amnesia && npm run build

# Deploy to test vault
cp temp/vault/.obsidian/plugins/amnesia/main.js \
   "/Users/josueguevara/Library/Mobile Documents/iCloud~md~obsidian/Documents/test/.obsidian/plugins/amnesia/main.js"

# MCP reload
mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })

# Run tests
await window.pdfLifecycleTests.runTest('scrollStress')
await window.pdfLifecycleTests.runTest('zoomTransitions')
window.pdfTelemetry.getSummary()
```

---

## Critical Files Reference

| File | Lines | Purpose |
|------|-------|---------|
| `pdf-infinite-canvas.ts` | 3000+ | Main canvas, camera, zoom |
| `render-coordinator.ts` | 1000 | Request deduplication |
| `zoom-transform-layer.ts` | 460 | Progressive zoom (integrated, needs container fix) |
| `tile-cache-manager.ts` | 1244 | 3-tier cache |
| `tile-render-engine.ts` | ~600 | Tile rendering orchestration |
| `scroll-strategy.ts` | 604 | Velocity prefetch |
| `feature-flags.ts` | 428 | Feature flags system |
| `pdf-telemetry.ts` | 1339 | Telemetry |
| `benchmark-suite.ts` | 907 | Benchmarks |
| `hybrid-rendering-strategy.ts` | ~250 | **NEW** - Full-page vs tiled decision |

### Research Reference

| Document | Key Content |
|----------|-------------|
| `05-extreme-zoom-performance.md` | Multi-resolution architecture, CSS transform layer design, adaptive tile sizing |

---

## Success Criteria

- [ ] 60fps sustained scroll for 10 seconds
- [ ] <5% blank tiles during fast scroll (>500px/s)
- [ ] Zoom feels instant (<16ms visual feedback)
- [ ] <500ms zoom transition at 16x
- [ ] Settings presets work with hot-reload
- [ ] Resource detector prompts are non-intrusive
- [ ] Spec document captures all exposed settings

# Balancing Forces: PDF Renderer Specification

> **Purpose:** Define the mental model, invariants, and success criteria needed to properly debug and maintain the PDF rendering system.

---

## Table of Contents

1. [Invariants](#1-invariants-the-non-negotiables)
2. [State Machine](#2-state-machine)
3. [Two-Track Pipeline](#3-two-track-pipeline)
4. [Component Ownership Matrix](#4-component-ownership-matrix)
5. [Zoom Level Matrix](#5-zoom-level-matrix)
6. [Failure Mode Catalog](#6-failure-mode-catalog)
7. [Performance Budgets](#7-performance-budgets)
8. [Debugging Protocols](#8-debugging-protocols)
9. [File Reference Index](#9-file-reference-index)
10. [Hypothesis Tracking Log](#10-hypothesis-tracking-log)

---

## 1. INVARIANTS (The Non-Negotiables)

These MUST always be true regardless of display mode, zoom level, or gesture state.

| ID | Invariant | Definition | Mathematical Expression | Violation Symptom |
|----|-----------|------------|------------------------|-------------------|
| **INV-1** | Focal Point Preservation | Screen position under cursor stays fixed during zoom | `screenPos(focalPoint, before) === screenPos(focalPoint, after)` | Content "jumps" or drifts when zooming |
| **INV-2** | Epoch Consistency | Rendered tiles match current camera epoch | `tile.epoch === camera.epoch` | Old tiles display at wrong position |
| **INV-3** | Transform Coherence | CSS transform reflects camera state at all times | `parseTransform(css) === {x: camera.x, y: camera.y, scale: camera.z}` | Visual desync between transform and content |
| **INV-4** | Coordinate Reversibility | screen↔canvas↔tile conversions are lossless | `canvasToScreen(screenToCanvas(p)) === p ± 0.5px` | Tiles render in wrong position |
| **INV-5** | Mode Transition Continuity | No visual discontinuity at render mode boundaries | `visual(before_transition) === visual(after_transition)` | Stretch/flash when crossing 4.0x threshold |
| **INV-6** | Scale/Layout Atomicity | A render batch MUST use a single renderParams identity for both tile generation AND grid layout | `∀t ∈ Batch: t.renderParamsId = Batch.renderParamsId ∧ Grid.renderParamsId = Batch.renderParamsId` | Mixed-scale tiles causing visible seams, blurry tiles adjacent to sharp tiles |
| **INV-6a** | Scale × cssStretch Consistency | When using spatial multi-resolution, scale × cssStretch must produce consistent visual size | `∀tile: tile.scale × tile.cssStretch = expectedVisualScale ± 0.01` | Tiles at different scales appear different sizes |

### Invariant Dependencies

```
INV-1 (Focal Point) ─────────────────────────────────────────────────────────►
    │
    │ depends on
    ▼
INV-3 (Transform Coherence) ──────────────────────────────────────────────────►
    │
    │ depends on
    ▼
INV-4 (Coordinate Reversibility) ─────────────────────────────────────────────►

INV-2 (Epoch) ◄────────────────────────────────────────────────────────────────
    │
    │ independent but intersects with
    ▼
INV-5 (Mode Transition) ──────────────────────────────────────────────────────►
    │
    │ affected by
    ▼
INV-6 (Scale/Layout Atomicity) ───────────────────────────────────────────────►
    │
    │ enables
    ▼
INV-6a (Scale × cssStretch Consistency) ──────────────────────────────────────►
```

### Detailed Invariant Definitions

#### INV-1: Focal Point Preservation

**Definition:** When zooming, the point on the document under the cursor/focal point must remain at the same screen position.

```
Given:
  - focalPoint_screen: (x, y) in screen coordinates
  - zoom_old, zoom_new: zoom levels before/after

Then:
  - Let focalPoint_canvas = screenToCanvas(focalPoint_screen, camera_old)
  - After zoom: screenToCanvas(focalPoint_screen, camera_new) === focalPoint_canvas
```

**Critical Edge Case:** When zoom is clamped (e.g., at 32x max), NO position adjustment should occur because the effective zoom change is 0.

#### INV-4: Coordinate Reversibility

**Definition:** Coordinate conversions must be lossless within floating-point precision.

```typescript
// Screen → Canvas → Screen must round-trip
const screenPoint = { x: 150, y: 200 };
const canvasPoint = screenToCanvas(screenPoint, camera);
const roundTrip = canvasToScreen(canvasPoint, camera);

assert(Math.abs(roundTrip.x - screenPoint.x) < 0.5);
assert(Math.abs(roundTrip.y - screenPoint.y) < 0.5);
```

#### INV-5: Mode Transition Continuity

**Definition:** When switching render modes (e.g., tiled → full-page at 4x boundary), there must be no visible discontinuity.

```
Requirements:
  1. Snapshot canvas sized to FULL page dimensions (not viewport-only)
  2. Tiled content composited at correct offset
  3. Snapshot visible during render, hidden after
  4. No aspect ratio change: snapshot.aspectRatio === finalRender.aspectRatio
```

---

## 2. STATE MACHINE

### 2.1 Gesture Lifecycle

```
                    ┌─────────────────────────────────────────┐
                    │                 IDLE                     │
                    │  • No active input                       │
                    │  • Tiles at final quality                │
                    └─────────────────────────────────────────┘
                                      │
                                      │ gesture start (wheel/pinch)
                                      ▼
                    ┌─────────────────────────────────────────┐
                    │                ACTIVE                    │◄────┐
                    │  • CSS transforms updating every frame   │     │
                    │  • Epoch incrementing                    │     │ continuous
                    │  • Progressive tiles rendering           │     │ input
                    └─────────────────────────────────────────┘─────┘
                                      │
                                      │ no input for 150ms
                                      ▼
                    ┌─────────────────────────────────────────┐
                    │               SETTLING                   │
                    │  • Final quality render triggered        │
                    │  • Waiting for tiles to complete         │
                    └─────────────────────────────────────────┘
                                      │
                                      │ render complete
                                      ▼
                    ┌─────────────────────────────────────────┐
                    │                 IDLE                     │
                    └─────────────────────────────────────────┘
```

**State Definitions:**

| State | Entry Condition | Exit Condition | Behavior |
|-------|-----------------|----------------|----------|
| IDLE | Render complete | Gesture starts | Accept new gestures, tiles are final quality |
| ACTIVE | User touching/scrolling | 150ms no input | CSS transforms only, queue tile renders |
| SETTLING | Gesture ended | Final render complete | Progressive refinement, epoch validation |

### 2.2 Render Mode Transitions

```
   zoom < 1.5x              1.5x < zoom < 4.0x               zoom > 4.0x
  ┌───────────┐            ┌───────────────────┐           ┌───────────┐
  │ FULL-PAGE │◄──────────►│ ADAPTIVE (hybrid) │◄─────────►│  TILED    │
  │           │            │                   │           │           │
  │ Single    │            │ Decision-based    │           │ 256×256   │
  │ render    │            │ per page          │           │ tiles     │
  └───────────┘            └───────────────────┘           └───────────┘

  Hysteresis: Mode changes only when crossing threshold by >10%
  (prevents oscillation at boundaries)
```

**Mode Transition Logic:**

```typescript
function shouldChangeMode(currentMode: RenderMode, zoom: number): RenderMode | null {
  const HYSTERESIS = 0.1; // 10%

  if (currentMode === 'full-page' && zoom > 1.5 * (1 + HYSTERESIS)) {
    return 'adaptive';
  }
  if (currentMode === 'adaptive' && zoom < 1.5 * (1 - HYSTERESIS)) {
    return 'full-page';
  }
  if (currentMode === 'adaptive' && zoom > 4.0 * (1 + HYSTERESIS)) {
    return 'tiled';
  }
  if (currentMode === 'tiled' && zoom < 4.0 * (1 - HYSTERESIS)) {
    return 'adaptive';
  }
  return null; // Stay in current mode
}
```

### 2.3 Zoom State Machine

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ZOOM STATE MACHINE                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌─────────┐     zoom in      ┌─────────┐     zoom in     ┌─────────┐ │
│   │ MIN (1x)│ ───────────────► │ NORMAL  │ ──────────────► │MAX (32x)│ │
│   └─────────┘                  └─────────┘                 └─────────┘ │
│        ▲                            │                           │      │
│        │         zoom out           │          zoom out         │      │
│        └────────────────────────────┴───────────────────────────┘      │
│                                                                         │
│   CLAMP BEHAVIOR:                                                       │
│   - At MIN: zoom out requests → clamp, NO position change              │
│   - At MAX: zoom in requests → clamp, NO position change               │
│   - wasClamped flag prevents focal point adjustment                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.4 Rebound Window Detection

At max zoom (32x), trackpad continues sending zoom-out "rebound" events after gesture ends.

```
                       GESTURE
  ────────────────────────┬──────────────────────────────────►
                          │
                          │ gesture end at max zoom
                          ▼
                    ┌─────────────┐
                    │   REBOUND   │  300ms window
                    │   WINDOW    │  Filter spurious events
                    └─────────────┘
                          │
                          │ window expires
                          ▼
                    ┌─────────────┐
                    │   NORMAL    │
                    │   INPUT     │
                    └─────────────┘
```

---

## 3. TWO-TRACK PIPELINE

The core architecture enabling smooth 60fps zooming at 32x.

```
USER INPUT (wheel/pinch)
         │
         ├─────────────────────────────────────────────┐
         │                                             │
         ▼                                             ▼
┌─────────────────────────────┐       ┌─────────────────────────────┐
│   INTERACTION TRACK         │       │   REFINEMENT TRACK          │
│   (Synchronous/GPU)         │       │   (Asynchronous/CPU)        │
├─────────────────────────────┤       ├─────────────────────────────┤
│                             │       │                             │
│ 1. ZoomStateManager         │       │ 1. Calculate visible tiles  │
│    • Updates zoom/epoch     │       │    from camera SNAPSHOT     │
│    • Tracks gesture state   │       │                             │
│                             │       │ 2. Queue tile renders       │
│ 2. Camera calculates        │       │    with priority:           │
│    new position             │       │    • Focal center first     │
│    • Preserves focal point  │       │    • Edges last             │
│                             │       │                             │
│ 3. CSS transform applied    │       │ 3. Progressive quality      │
│    • GPU-accelerated        │       │    • 50ms: intermediate     │
│    • No re-rendering        │       │    • 200ms: final           │
│                             │       │                             │
│ LATENCY: <1ms               │       │ 4. Epoch validation         │
│ RESPONSIBILITY: Visual      │       │    before display           │
│ feedback                    │       │                             │
│                             │       │ LATENCY: 50-500ms           │
└─────────────────────────────┘       │ RESPONSIBILITY: Quality     │
                                      └─────────────────────────────┘

═══════════════════════════════════════════════════════════════════════
                        DECOUPLING CONTRACT
═══════════════════════════════════════════════════════════════════════
• Interaction track NEVER waits for refinement
• Refinement track uses SNAPSHOT of camera at debounce time
• Epoch system discards stale tiles automatically
• CSS transform = source of truth for visual position
═══════════════════════════════════════════════════════════════════════
```

### Critical Pattern: Camera Snapshot

**WRONG** (causes "0 visible tiles during scroll"):
```typescript
// Camera moved during debounce window
debounce(() => calculateVisible(this.camera), 32);
```

**CORRECT**:
```typescript
// Snapshot at schedule time, use snapshot at render time
const snapshot = { ...this.camera };
debounce(() => calculateVisible(snapshot), 32);
```

---

## 4. COMPONENT OWNERSHIP MATRIX

| Display Mode | Container | Render Strategy | State Manager | Gesture Handler | Key File |
|--------------|-----------|-----------------|---------------|-----------------|----------|
| paginated | PdfMultiPageContainer | PaginatedStrategy | N/A | PdfGestureHandler | pdf-multi-page-container.ts |
| vertical-scroll | PdfInfiniteCanvas | ScrollStrategy | ZoomStateManager | Internal | pdf-infinite-canvas.ts |
| horizontal-scroll | PdfInfiniteCanvas | ScrollStrategy | ZoomStateManager | Internal | pdf-infinite-canvas.ts |
| auto-grid | PdfInfiniteCanvas | GridStrategy | ZoomStateManager | Internal | pdf-infinite-canvas.ts |
| canvas | PdfInfiniteCanvas | HybridStrategy | ZoomStateManager | Internal | pdf-infinite-canvas.ts |

### Component Stack

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PDF RENDERING STACK                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      PdfInfiniteCanvas                          │   │
│  │  - Owns scroll container and viewport                           │   │
│  │  - Handles wheel/touch events                                   │   │
│  │  - Manages camera state                                         │   │
│  │  - Applies CSS transforms                                       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                              ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      PdfPageElement                              │   │
│  │  - Owns page canvas(es): tiled + fullPage + snapshot            │   │
│  │  - Manages render mode transitions                               │   │
│  │  - Handles mode-specific compositing                            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                              ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    TileRenderEngine                              │   │
│  │  - Calculates visible tiles                                      │   │
│  │  - Manages tile cache (TileCacheManager)                         │   │
│  │  - Validates epochs before display                               │   │
│  │  - Prioritizes render queue                                      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                              ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      MuPDFWorker                                 │   │
│  │  - Runs in Web Worker                                            │   │
│  │  - Renders pages/tiles via WASM                                  │   │
│  │  - Returns ImageBitmap or ImageData                              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. ZOOM LEVEL MATRIX

| Zoom Range | Render Mode | Tile Size | Scale Tiers | Memory Budget | Tiles/Page |
|------------|-------------|-----------|-------------|---------------|------------|
| < 1.5x | Full-page | N/A | 1 | Single page | 1 |
| 1.5x - 4.0x | Adaptive | Decision-based | 2-4 | < 24MP | 1-16 |
| 4.0x - 8.0x | Tiled | 256×256 CSS px | 4, 6, 8 | ~100MB | ~100 |
| 8.0x - 16x | Tiled | 256×256 CSS px | 8, 12, 16 | ~150MB | ~200 |
| 16x - 32x | Tiled | 256×256 CSS px | 16, 24, 32 | ~200MB | ~400 |
| 32x (max) | Tiled (capped) | 256×256 CSS px | 32 | ~250MB | ~600 |

**Target max zoom: 32x** (matching Preview.app benchmark)

### Scale Tier Selection

```typescript
function selectScaleTier(zoom: number): number {
  // Available tiers: 1, 2, 4, 6, 8, 12, 16, 24, 32
  const tiers = [1, 2, 4, 6, 8, 12, 16, 24, 32];

  // Select tier >= zoom to avoid upscaling blur
  for (const tier of tiers) {
    if (tier >= zoom) return tier;
  }
  return 32; // Max tier
}
```

### Tile Size Calculation

```typescript
const CSS_TILE_SIZE = 256; // pixels
const dpr = window.devicePixelRatio;
const physicalTileSize = CSS_TILE_SIZE * dpr * scaleTier;
// e.g., at 8x zoom with 2x DPR: 256 * 2 * 8 = 4096px physical tile
```

---

## 6. FAILURE MODE CATALOG

| ID | Failure | Invariant Violated | Root Cause Pattern | Key Files | Debugging Protocol |
|----|---------|-------------------|-------------------|-----------|-------------------|
| F1 | Focal point drift | INV-1 | Position adjustment after zoom clamp | pdf-canvas-camera.ts | Protocol A |
| F2 | Stale tile position | INV-2 | Tile rendered with old camera snapshot | tile-render-engine.ts | Protocol B |
| F3 | Mode transition stretch | INV-5 | Snapshot sized to viewport, not full page | pdf-page-element.ts | Protocol C |
| F4 | Rebound zoom-out | INV-1 | Trackpad rebound events at 32x | zoom-state-manager.ts | Protocol A |
| F5 | Transform desync | INV-3 | applyTransform() not called after state change | pdf-infinite-canvas.ts | Protocol D |
| F6 | Coordinate error | INV-4 | Lossy screen↔canvas conversion | pdf-canvas-camera.ts | Protocol E |
| F7 | Integer/float mismatch | INV-4, INV-5 | Tile uses Math.floor(), CSS preserves float | pdf-page-element.ts | Protocol C |
| F8 | Multi-scale tiles | INV-6 | Scale calculated independently at 7+ locations | zoom-orchestrator.ts, render-coordinator.ts | Protocol F |

### Detailed Failure Analysis

#### F3/F7: Mode Transition Stretch (Integer vs Float)

**Symptom:** Brief vertical stretch when crossing 4.0x threshold.

**Root Cause (LLM Council Consensus 85-95%):**
The tiled rendering engine forces integer dimensions (e.g., 518px) while CSS preserves float precision (e.g., 517.647px). The 0.353px delta causes vertical stretching when bitmap is drawn into CSS-constrained container.

```typescript
// PROBLEMATIC: Integer truncation
const tiledHeight = Math.floor(pageHeight * scaleTier);  // 518
const cssHeight = pageHeight * scaleTier;  // 517.647

// Mismatch causes stretch when compositing
```

---

## 7. PERFORMANCE BUDGETS (Quality Floor: Preview.app)

### 7.1 Quality Floor Metrics

| Metric | Target | Acceptable | Unacceptable | Measurement |
|--------|--------|------------|--------------|-------------|
| Interaction latency | <8ms | <16ms (1 frame) | >16ms | Time from input to CSS transform |
| Focal point drift | 0px | <1px | >1px visible | Pixel distance of cursor target |
| Frame rate during zoom | 60fps | 45fps | <30fps | Chrome DevTools Performance |
| Mode transition flash | None | <1 frame | Visible glitch | Visual inspection |
| Tile pop-in | Seamless | Subtle fade | Visible "pop" | Visual inspection |
| First tile visible | <50ms | <100ms | >200ms | Console timestamp |
| Final quality render | <200ms | <500ms | >1s | Console timestamp |

### 7.2 Preview.app-Inspired Optimizations

| Optimization | Purpose | Success Criterion |
|--------------|---------|-------------------|
| On-zoom rendering | Tiles render during gesture, not after | First tile appears within 50ms of zoom start |
| Focal center priority | Tiles under cursor render first | Center tiles available before edge tiles |
| Progressive quality | Show stretched low-res immediately | No blank space during zoom |
| CSS transform decoupling | GPU handles visual feedback | Interaction track never blocked by rendering |
| Epoch-based invalidation | Prevent stale tile display | 0 tiles displayed with wrong position |

### 7.3 Memory Budgets

| Zoom Range | Max Tiles | Max Memory | Strategy |
|------------|-----------|------------|----------|
| <4x | 10 pages | 100MB | Full-page cache |
| 4x-8x | 100 tiles | 150MB | Visible + 1 screen prefetch |
| 8x-16x | 200 tiles | 200MB | Visible only + LRU eviction |
| 16x-32x | 400 tiles | 250MB | Aggressive eviction |

### 7.4 Frame Budget Breakdown

```
16.67ms frame budget (60fps)
├── Input processing:     <1ms
├── Camera update:        <1ms
├── Transform apply:      <1ms
├── Tile visibility calc: <2ms
├── Compositing:          <4ms
└── Buffer:               ~8ms
```

---

## 8. DEBUGGING PROTOCOLS

### Protocol A: Focal Point Drift

**Symptoms:** Content shifts when zooming, especially at max zoom boundary (32x)

**Diagnostic Steps:**
1. Add console log to `zoomCameraToPoint()` in pdf-canvas-camera.ts
   ```typescript
   console.log('[DRIFT-DEBUG] before:', camera, 'delta:', delta, 'point:', point, 'wasClamped:', wasClamped);
   ```
2. Check if `wasClamped` is true when drift occurs
3. If clamped: verify position adjustment is blocked
4. If not clamped: trace focal point calculation

**Checkpoints:**
- [ ] `zoomCameraToPoint()` receives correct focal point (screen coords)
- [ ] `screenToCanvas()` conversion is correct before zoom
- [ ] Position delta is calculated correctly
- [ ] Delta is NOT applied when zoom is clamped
- [ ] `applyTransform()` is called after camera update

---

### Protocol B: Stale Tile Display

**Symptoms:** Old tiles briefly flash at wrong position during rapid zoom

**Diagnostic Steps:**
1. Enable epoch logging in tile-render-engine.ts
   ```typescript
   console.log('[EPOCH] render:', tileEpoch, 'current:', currentEpoch);
   ```
2. Check if tiles pass epoch validation in `displayTile()`
3. Verify epoch increments on EVERY zoom change

**Checkpoints:**
- [ ] `ZoomStateManager.incrementEpoch()` called in wheel handler
- [ ] Tile render request includes correct epoch
- [ ] `validateEpoch()` returns false for stale tiles
- [ ] Stale tiles are discarded, not displayed

---

### Protocol C: Mode Transition Glitch

**Symptoms:** Stretch/flash when crossing 4.0x threshold

**Diagnostic Steps:**
1. Add dimension logging in `prepareForFullPageRender()`:
   ```typescript
   console.log('[MODE-TRANSITION] tiled:', tiledW, 'x', tiledH, 'fullPage:', fullW, 'x', fullH);
   ```
2. Compare snapshot dimensions to expected full-page dimensions
3. Check if snapshot is sized to FULL page, not viewport-only

**Golden Frame Log (add to any component):**
```typescript
console.log('[GOLDEN-FRAME]', {
  mode: currentRenderMode,
  camera: { x: camera.x, y: camera.y, z: camera.z },
  epoch: zoomStateManager.getEpoch(),
  cssHeight: element.getBoundingClientRect().height,
  offsetHeight: element.offsetHeight,
  tiledCanvas: { w: tiledCanvas?.width, h: tiledCanvas?.height },
  fullPageCanvas: { w: fullPageCanvas?.width, h: fullPageCanvas?.height },
  snapshotCanvas: { w: snapshotCanvas?.width, h: snapshotCanvas?.height }
});
```

**Checkpoints:**
- [ ] Snapshot canvas sized to `currentWidth × currentHeight` (full page)
- [ ] Tiled content drawn at correct offset in snapshot
- [ ] Snapshot visible during render, hidden after
- [ ] No aspect ratio difference between snapshot and final render
- [ ] Integer/float dimensions match (no 0.353px mismatch)

---

### Protocol D: Transform Desync

**Symptoms:** CSS transform doesn't match camera state

**Diagnostic Steps:**
1. Compare `getCameraTransform()` output with actual CSS:
   ```typescript
   console.log('[TRANSFORM] camera:', camera, 'css:', container.style.transform);
   ```
2. Check if `applyTransform()` is called after every camera mutation
3. Verify no intermediate state between camera update and transform apply

**Checkpoints:**
- [ ] Every camera mutation followed by `applyTransform()`
- [ ] No async gaps between camera change and DOM update
- [ ] Transform string matches camera {x, y, z} exactly

---

### Protocol E: Coordinate Conversion Error

**Symptoms:** Tiles render at wrong position, visible offset

**Diagnostic Steps:**
1. Round-trip test coordinate conversions:
   ```typescript
   const p = {x: 100, y: 100};
   const canvas = screenToCanvas(p, camera);
   const back = canvasToScreen(canvas, camera);
   console.log('[COORD] original:', p, 'roundtrip:', back, 'delta:', back.x - p.x, back.y - p.y);
   ```
2. Delta should be <0.001 (floating point epsilon)

**Checkpoints:**
- [ ] `screenToCanvas()` uses correct camera values
- [ ] `canvasToScreen()` is inverse of `screenToCanvas()`
- [ ] No integer truncation in coordinate math
- [ ] DPR (devicePixelRatio) applied consistently

---

### Protocol F: Multi-Scale Bug Detection (INV-6)

**Symptoms:** Tiles at different scales in the same render batch, visible seams between tiles, blurry tiles adjacent to sharp tiles

**Diagnostic Steps:**
1. Add multi-scale detection in `pdf-page-element.ts` (already exists):
   ```typescript
   const uniqueScales = [...new Set(tiles.map(t => t.tile.scale))];
   if (uniqueScales.length > 1) {
     console.error(`[MULTI-SCALE-BUG] tiles at DIFFERENT scales: ${uniqueScales.join(', ')}`);
   }
   ```

2. Enable scale debug logging:
   ```typescript
   console.log('[SCALE-DEBUG]', {
     tilesReceived: tiles.length,
     uniqueScales: [...new Set(tiles.map(t => t.scale))],
     uniqueEpochs: [...new Set(tiles.map(t => t.scaleEpoch))],
     currentEpoch: scaleManager?.getEpoch(),
   });
   ```

3. Trace scale calculation through all 7+ distributed locations:
   - `zoom-orchestrator.ts` (4 locations)
   - `pdf-infinite-canvas.ts` (4 locations) - **Only place passing `maxZoom`!**
   - `render-coordinator.ts` (3 locations)
   - `scroll-strategy.ts` (2 locations)
   - `pdf-page-element.ts` (3 locations)

**Root Cause Pattern:** Scale calculated independently at multiple locations, creating temporal race conditions where tiles in the same batch arrive at different scales.

**Fix:** Centralize all scale calculations in ScaleStateManager with epoch-based validation. All tile requests must use `captureSnapshot()` at request time and `validateEpoch()` at display time.

**Checkpoints:**
- [ ] All tile requests use `scaleManager.captureSnapshot()` (not local calculation)
- [ ] All tile displays validate `scaleManager.validateEpoch(tile.scaleEpoch)`
- [ ] No `[MULTI-SCALE-BUG]` errors in console during rapid zoom
- [ ] After INV-6a implemented: multi-scale allowed with cssStretch compensation

---

## 9. FILE REFERENCE INDEX

### By Concern

| Concern | Primary File | Secondary Files |
|---------|--------------|-----------------|
| Camera math | pdf-canvas-camera.ts | - |
| Zoom state | zoom-state-manager.ts | zoom-orchestrator.ts (deprecated) |
| Infinite canvas | pdf-infinite-canvas.ts | pdf-canvas-camera.ts |
| Tile rendering | tile-render-engine.ts | render-coordinator.ts, mupdf-worker.ts |
| Mode transitions | pdf-page-element.ts | hybrid-rendering-strategy.ts |
| Gesture handling | pdf-infinite-canvas.ts (internal) | pdf-gesture-handler.ts (legacy) |
| Scroll prediction | scroll-strategy.ts | grid-strategy.ts |
| Progressive render | progressive-tile-renderer.ts | zoom-transform-layer.ts |
| Tile cache | tile-cache-manager.ts | - |
| WASM rendering | mupdf-worker.ts | mupdf-bridge.ts |

### By File (Quick Lookup)

| File | Primary Responsibility | Key Functions |
|------|----------------------|---------------|
| `pdf-canvas-camera.ts` | Coordinate math, zoom calculations | `zoomCameraToPoint()`, `screenToCanvas()`, `canvasToScreen()` |
| `pdf-infinite-canvas.ts` | Viewport management, event handling | `handleWheel()`, `applyTransform()`, `render()` |
| `pdf-page-element.ts` | Page canvas management, mode switching | `prepareForFullPageRender()`, `switchRenderMode()` |
| `tile-render-engine.ts` | Tile lifecycle, visibility calculation | `calculateVisibleTiles()`, `displayTile()`, `validateEpoch()` |
| `zoom-state-manager.ts` | Zoom state, epoch management | `setZoom()`, `incrementEpoch()`, `getEpoch()` |
| `render-coordinator.ts` | Render queue management | `queueRender()`, `processQueue()` |
| `mupdf-worker.ts` | WASM rendering interface | `renderPage()`, `renderTile()` |

---

## 10. HYPOTHESIS TRACKING LOG

### Purpose

Prevent "debugging drift" by maintaining canonical bug descriptions and tracking hypothesis validation with scientific rigor.

### Evidence & Artifacts Location

All debugging evidence, screenshots, plans, and logs MUST be compiled in dated subfolders:
```
/docs/debug/max-zoom-distortion-bug/YYYY-MM-DD/
├── screenshots/          # Visual evidence
├── console-logs/         # Captured logs
├── plans/               # Session-specific plans
└── hypothesis-results/   # Test results
```

### LLM Council Consensus (2026-01-20)

**Primary Root Cause (85-95% certainty):** Integer vs Float Rounding Mismatch

The tiled rendering engine forces integer dimensions (518px) while CSS preserves float precision (517.647px). The 0.353px delta causes vertical stretching when bitmap is drawn into CSS-constrained container.

All 4 council models (Grok, Gemini, Claude Opus, GPT-5.2) agree on this primary diagnosis.

### Ranked Hypotheses from Council

| ID | Certainty | Invariant | Core Issue | Code Location |
|----|-----------|-----------|------------|---------------|
| H1 | 90% | INV-4, INV-5 | Integer truncation in tiles vs float CSS | `pdf-page-element.ts`, `tile-render-engine.ts` |
| H2 | 75% | INV-3 | CSS transform scale vs canvas scale diverge | `pdf-infinite-canvas.ts` |
| H3 | 65% | INV-5 | Snapshot sized for target (float) not source (int) | `pdf-page-element.ts:prepareForFullPageRender()` |
| H4 | 65% | INV-4 | Mixed `getBoundingClientRect()` vs `offsetHeight` | Multiple files |
| H5 | 55% | INV-4, INV-5 | Tile extent rounding leaks into page size | `tile-render-engine.ts` |
| H6 | 50% | INV-4, INV-5 | PDF units conversion differs between paths | `pdf-canvas-camera.ts` |
| H7 | 45% | INV-4, INV-3 | DPR applied inconsistently | Canvas sizing code |
| H8 | 40% | INV-2, INV-3 | Epoch mismatch CSS vs bitmap | `zoom-state-manager.ts` |
| H9 | 35% | INV-5 | Threshold flapping at z≈4.0 | Mode selection logic |
| H10 | 30% | INV-3, INV-5 | Stale transform from tiled mode | DOM updates |

### Hypothesis Clusters

**Cluster A (Unit/Rounding - PRIMARY):** H1, H4, H5, H6, H7
- All reduce to INV-4 violations producing int vs float disagreement
- **Fixing H1 likely fixes entire cluster**

**Cluster B (Two-Track Ordering):** H3, H8, H10
- Explain "brief" artifacts via swap timing or stale style

**Cluster C (Threshold Behavior):** H9
- Only relevant if logs show repeated mode toggles

### Hypothesis Table

| ID | Created | Depends On | bd Issue | Canonical Bug Description | Invariant | Hypothesis Statement | Code Location | Expected After Fix | Status |
|----|---------|------------|----------|--------------------------|-----------|---------------------|---------------|-------------------|--------|
| H1 | 2026-01-20 | - | TBD | Integer truncation (518px) vs CSS float (517.647px) causes vertical stretch at mode boundary | INV-4, INV-5 | Tile dimensions use `Math.floor()` while CSS preserves float precision, creating 0.353px delta | `pdf-page-element.ts`, `tile-render-engine.ts` | Dimensions match exactly (int or float, consistently) | UNTESTED |
| H2 | 2026-01-20 | - | TBD | CSS transform scale diverges from canvas backing scale | INV-3 | Transform uses camera.z while canvas uses rounded scaleTier | `pdf-infinite-canvas.ts` | Single source of truth for scale | UNTESTED |
| H3 | 2026-01-20 | - | TBD | Snapshot sized for float target, not integer source | INV-5 | `prepareForFullPageRender()` copies target dims, not source | `pdf-page-element.ts` | Snapshot matches tiled canvas exactly | UNTESTED |
| H4 | 2026-01-20 | - | TBD | Mixed `getBoundingClientRect()` vs `offsetHeight` usage | INV-4 | Different measurement APIs return different precision | Multiple files | Consistent measurement API throughout | UNTESTED |
| H5 | 2026-01-20 | - | TBD | Tile extent rounding leaks into page size calculation | INV-4, INV-5 | Accumulated tile rounding affects page dimensions | `tile-render-engine.ts` | Page size independent of tile grid | UNTESTED |

### Status Values

- **UNTESTED**: Hypothesis formulated, not yet tested
- **TESTING**: Currently being validated
- **VALIDATED**: Fix applied, expected behavior observed
- **INVALIDATED**: Fix applied, unexpected behavior observed
- **SUPERSEDED**: Hypothesis replaced by more accurate formulation

### Hypothesis Formulation Rules

1. **Canonical Description**: Use precise, measurable language
   - BAD: "zoom is buggy"
   - GOOD: "focal point shifts >1px rightward when releasing gesture at 32x"

2. **One Variable Per Hypothesis**: Each hypothesis tests ONE specific cause

3. **Falsifiable**: Define what "fixed" looks like AND what "not fixed" looks like

4. **Linked to Invariant**: Every bug maps to a violated invariant

### Council's Recommended Debugging Protocol

**Phase 1: Golden Frame Log**
```typescript
console.log({
  mode: currentRenderMode,
  cameraZ: camera.z,
  cssHeight: element.getBoundingClientRect().height,
  tiledCanvasHeight: this.tiledCanvas?.height,
  fullPageCanvasHeight: this.fullPageCanvas?.height,
  snapshotHeight: this.snapshotCanvas?.height
});
```

**Phase 2: Force Integer Rounding (Test H1)**
- Wrap dimension calculations in `Math.round()` in `prepareForFullPageRender`
- If stretch vanishes → H1 confirmed

**Phase 3: CSS Compensation (If Phase 2 fails)**
- Apply `scale(canvas.height / pageBaseHeight)` instead of `scale(camera.z)`
- If fixed → H2 confirmed

### Red Herrings (Avoid These)

- **GPU anti-aliasing**: Would cause symmetric blur, not 1D vertical delta
- **PDF MediaBox/CropBox**: Would cause larger offsets, not sub-pixel
- **Max Zoom 32x**: Bug is at 4x boundary, not max zoom
- **Browser rendering quirks**: Would be inconsistent, not reproducible

### Hypothesis Lifecycle

```
FORMULATE → TEST → VALIDATE/INVALIDATE → (REFINE if needed)
     │                    │
     │                    ├─► VALIDATED: Close bug, document fix
     │                    │
     │                    └─► INVALIDATED: New hypothesis (H1.1, H1.2, ...)
     │
     └─► Before testing, write down EXACTLY what you expect to see
```

---

## 11. RAW BUG DESCRIPTION

**Current Persisting Issue (2026-01-20):**

When using real trackpad pinch-to-zoom gestures on a PDF in canvas mode:
1. Zoom from 1x to ~2x (crossing mode transition threshold from tiled to full-page)
2. Content appears to stretch/distort briefly
3. Console shows dimension mismatch: `tiled=400x518` vs `cssSize=400x517.647`

Screenshot evidence shows the mode transition occurring with slight dimension discrepancy during the tiled→full-page transition.

**Root Cause Analysis:**
- The 0.353px height difference (518 vs 517.647) is causing the visible distortion
- This is primarily a rounding issue (H1 - 90% certainty)
- INV-4 (Coordinate Reversibility) and INV-5 (Mode Transition Continuity) are being violated

---

## Appendix A: Quick Reference Card

```
═══════════════════════════════════════════════════════════════════════════
                         PDF RENDERER QUICK REFERENCE
═══════════════════════════════════════════════════════════════════════════

INVARIANTS (must ALWAYS hold):
  INV-1: Focal point stays fixed during zoom
  INV-2: Displayed tiles match current epoch
  INV-3: CSS transform === camera state
  INV-4: Coordinate conversions are reversible
  INV-5: No visual discontinuity at mode boundaries
  INV-6: Render batch uses single renderParams identity
  INV-6a: scale × cssStretch = consistent visual

TWO TRACKS:
  Interaction: <1ms, CSS only, never blocks
  Refinement: 50-500ms, tiles, uses camera SNAPSHOT

ZOOM MODES:
  <1.5x  → Full-page
  1.5-4x → Adaptive
  >4x    → Tiled (256px CSS tiles)

MAX ZOOM: 32x (Preview.app benchmark)

CRITICAL PATTERN:
  const snapshot = { ...this.camera };
  debounce(() => render(snapshot), 32);  // NOT this.camera

KEY FILES:
  Camera:    pdf-canvas-camera.ts
  Canvas:    pdf-infinite-canvas.ts
  Tiles:     tile-render-engine.ts
  Mode:      pdf-page-element.ts
  Zoom:      zoom-state-manager.ts

PRIMARY BUG (2026-01-20):
  Integer truncation in tiles vs float CSS
  H1: 90% certainty - fix with consistent rounding

═══════════════════════════════════════════════════════════════════════════
```

---

## Appendix B: Verification Checklist

After any PDF renderer changes, verify:

1. **Build and deploy** to test vault
2. **Run debugging protocols** A-E as needed
3. **Verify performance metrics** meet quality floor:
   - [ ] Interaction latency: <16ms
   - [ ] Focal point drift: <1px
   - [ ] Mode transition: no visible glitch
   - [ ] Frame rate: >45fps during zoom
4. **Real trackpad test**: zoom 1x→32x→1x with focal point stability
5. **All display modes**: paginated, vertical-scroll, horizontal-scroll, canvas, auto-grid

**Remember:** Synthetic tests DO NOT capture real user experience. Always test with actual trackpad gestures.

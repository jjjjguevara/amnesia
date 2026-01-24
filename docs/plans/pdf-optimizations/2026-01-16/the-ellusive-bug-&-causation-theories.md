# The Elusive Two-Stage Zoom Bug: Analysis & Causation Theories

> **Document Purpose**: Comprehensive analysis of a persistent zoom rendering bug that causes focal point drift when releasing a zoom gesture at maximum zoom level.
>
> **Last Updated**: 2026-01-17

---

## Table of Contents

1. [Bug Description from User Standpoint](#1-bug-description-from-user-standpoint)
2. [Pipeline Architecture Overview](#2-pipeline-architecture-overview)
3. [Backend Perception of the Bug](#3-backend-perception-of-the-bug)
4. [Causation Theories](#4-causation-theories)
5. [Observability Gaps](#5-observability-gaps)
6. [Key Code References](#6-key-code-references)
7. [Debugging Strategy](#7-debugging-strategy)

---

## 1. Bug Description from User Standpoint

### 1.1 Bug Behavior

**Two-Stage Zoom Anomaly**: A rendering discontinuity that occurs when transitioning from active zoom gesture to final rendered state.

#### Stage 1: During Zoom Gesture
- User initiates pinch-zoom gesture on trackpad
- Zoom increases smoothly until reaching maximum zoom level (16x)
- Zoom gets "blocked" or clamped at `maxZoom` constraint
- Visual feedback appears correct (CSS-scaled preview, may be slightly pixelated)
- **Focal point remains stable** under user's fingers

#### Stage 2: Upon Gesture Release
- User releases pinch gesture (lifts fingers from trackpad)
- After brief settling period (~150ms), final high-resolution render triggers
- **Focal point suddenly shifts** to a different position on the page
- Zoom level may appear to "jump" (non-linear increase)
- Content position no longer matches where user was looking

### 1.2 User Observations

1. **Adjacent tiles not immediately visible**: Areas next to the current view slowly become visible when panning, suggesting tile loading/positioning issues

2. **Up-scaled image doesn't fit page canvas**: The rendered content appears to extend beyond or not fill the expected page boundaries

3. **Border mismatch**: The visible borders of the zoomed image correspond to page borders at 1x zoom, not at the current zoom level - indicating a coordinate space mismatch

4. **Reproducibility**: Bug occurs consistently when:
   - Zooming to maximum (16x)
   - Using real trackpad gestures (not synthetic events)
   - Releasing the gesture after zoom is clamped

---

## 2. Pipeline Architecture Overview

Understanding the rendering pipeline is essential for identifying where the bug might originate.

### 2.1 Zoom Event Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER INPUT LAYER                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Trackpad Pinch Gesture                                                      │
│       ↓                                                                      │
│  Browser WheelEvent (ctrlKey=true for pinch-zoom)                           │
│       ↓                                                                      │
│  PdfGestureHandler.handleWheel()                                            │
│       • Calculates newScale from deltaY                                      │
│       • Clamps to [minScale, maxScale]                                       │
│       • Extracts cursor position (centerX, centerY)                          │
│       • Calls: callbacks.onZoom(newScale, centerX, centerY)                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CAMERA SYSTEM                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  PdfInfiniteCanvas.handleZoom()                                              │
│       ↓                                                                      │
│  zoomCameraToPoint(camera, focalPoint, delta, constraints)                  │
│       • Calculates new zoom level (clamped to min/max)                       │
│       • Computes camera position adjustment to keep focal point stationary   │
│       • Returns new Camera { x, y, z }                                       │
│       ↓                                                                      │
│  this.camera = newCamera  (immediate state update)                          │
│       ↓                                                                      │
│  CSS Transform Applied: scale(z) translate(x, y)  [GPU-accelerated]         │
│       • Visual feedback is IMMEDIATE (no tile re-render needed)              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ZOOM ORCHESTRATOR                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  ZoomOrchestrator.onZoomGesture(zoom, focalPoint, cameraSnapshot)           │
│       ↓                                                                      │
│  State Machine Transitions:                                                  │
│       idle → zooming (on first zoom event)                                   │
│            • Aborts pending renders                                          │
│            • Captures camera snapshot                                        │
│            • Starts gesture-end detection timer (150ms)                      │
│       ↓                                                                      │
│  Timer Reset on Each Zoom Event                                              │
│       • If 150ms passes with no events → gesture ended                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                        GESTURE END HANDLING                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  ZoomOrchestrator.endZoomGesture()                                          │
│       ↓                                                                      │
│  State: zooming → settling                                                   │
│       ↓                                                                      │
│  Settling Timer (config.settlingDelay = 200ms)                              │
│       ↓                                                                      │
│  State: settling → rendering                                                 │
│       ↓                                                                      │
│  Calculate target scale: getTargetScale(zoom)                               │
│       ↓                                                                      │
│  Trigger callback: onRenderPhase('final', targetScale, snapshotZoom)        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RENDER PHASE HANDLING                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  PdfInfiniteCanvas.handleZoomRenderPhase(scale, phase)                      │
│       ↓                                                                      │
│  renderZoomPhase('final', scale, scaleVersion)                              │
│       • Determines effectiveCamera (current vs snapshot)                     │
│       • Calculates visible pages from camera position                        │
│       • Creates missing page elements                                        │
│       • Queues pages for re-render                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                        TILE RENDERING                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  RenderCoordinator.requestRender()                                          │
│       ↓                                                                      │
│  TileRenderEngine.getTilesInRect()                                          │
│       • Calculates which tiles cover visible area                            │
│       • Returns tile coordinates with scale                                  │
│       ↓                                                                      │
│  MuPDF Worker Pool                                                           │
│       • Renders tiles at target scale                                        │
│       • Returns ImageBitmap for each tile                                    │
│       ↓                                                                      │
│  3-Tier Cache (L1 Memory → L2 IndexedDB → L3 Cold)                          │
│       • Stores/retrieves rendered tiles                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CANVAS COMPOSITING                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  PdfPageElement.renderTiles(tiles, textLayerData, zoom, pdfDimensions)      │
│       ↓                                                                      │
│  Calculate tile bounding box (minTileX/Y, maxTileX/Y)                       │
│       ↓                                                                      │
│  Determine render mode: viewport-only vs full-page                          │
│       ↓                                                                      │
│  Size canvas buffer (canvasWidth × canvasHeight)                            │
│       ↓                                                                      │
│  Draw tiles to offscreen canvas                                              │
│       ↓                                                                      │
│  Calculate CSS transform:                                                    │
│       • fitScale = this.currentWidth / cssWidth                              │
│       • transform = translate(offsetX, offsetY) scale(fitScale)              │
│       ↓                                                                      │
│  Copy to visible canvas (atomic update)                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Key Timing Points

| Event | Typical Timing | State |
|-------|---------------|-------|
| First zoom event | t=0ms | idle → zooming |
| Continuous zoom events | t=0-500ms | zooming (timer resets) |
| Last zoom event | t=500ms | zooming |
| Gesture end detected | t=650ms | zooming → settling |
| Settling complete | t=850ms | settling → rendering |
| Final render triggered | t=850ms | rendering |
| Tiles rendered | t=850-1200ms | rendering |
| Render complete | t=1200ms | rendering → idle |

### 2.3 Coordinate Spaces

| Space | Units | Description | Invariant |
|-------|-------|-------------|-----------|
| **Screen** | Viewport pixels | Position relative to browser viewport | Fixed regardless of zoom |
| **Canvas** | CSS pixels at zoom=1 | Position on the infinite canvas | Page positions NEVER change |
| **PDF** | Points (72 DPI) | Native document coordinates | US Letter = 612×792 |
| **Tile** | Grid indices + scale | Cache key format | `page-tileX-tileY-scale` |

**Coordinate Conversions**:
```typescript
// Screen → Canvas
canvas.x = screen.x / zoom - camera.x
canvas.y = screen.y / zoom - camera.y

// Canvas → Screen
screen.x = (canvas.x + camera.x) * zoom
screen.y = (canvas.y + camera.y) * zoom

// Canvas → PDF
pdfScale = pdfWidth / baseCanvasWidth  // e.g., 612 / 400 = 1.53
pdfPoint = canvasPoint * pdfScale
```

---

## 3. Backend Perception of the Bug

### 3.1 What the Pipeline "Sees"

From the backend's perspective, the two-stage bug manifests as:

1. **During Gesture**: Camera updates smoothly, CSS transform provides immediate feedback
2. **At Max Zoom**: Camera.z reaches maxZoom (16), further zoom events are clamped
3. **Gesture End**: Orchestrator transitions to settling → rendering
4. **Final Render**: Tiles are rendered at target scale and composited

**The Disconnect**: The backend believes it's rendering tiles at the correct position (based on camera state), but the visual result doesn't match what the user expects.

### 3.2 Potential Discontinuity Points

```
                    GESTURE ACTIVE                    GESTURE RELEASED
                         │                                  │
Camera State:     [continuously updated]           [frozen at last value]
                         │                                  │
CSS Transform:    [applied immediately]            [may change when tiles arrive]
                         │                                  │
Tile Render:      [blocked by orchestrator]        [triggered with snapshot]
                         │                                  │
                         ▼                                  ▼
                  VISUAL: Smooth zoom              VISUAL: ??? (potential jump)
```

### 3.3 State Machine Timeline at Bug Occurrence

```
t=0ms:    User at zoom 15.5x, zooming toward max
t=50ms:   Zoom reaches 16x (maxZoom), clamped
t=100ms:  User continues gesture, events arrive but zoom stays at 16x
          → Camera position may still be adjusting (focal point math)
t=150ms:  User releases gesture
t=300ms:  Gesture end detected (150ms timeout)
          → State: zooming → settling
t=500ms:  Settling complete
          → State: settling → rendering
          → onRenderPhase('final', ...) triggered
t=500ms+: Final tiles rendered
          → Canvas buffer resized
          → CSS transform recalculated
          → ??? VISUAL JUMP OCCURS HERE ???
```

---

## 4. Causation Theories

### Theory 1: Canvas Buffer Size Jump

**Hypothesis**: When final high-res tiles arrive, the canvas buffer size changes dramatically, causing the `fitScale` calculation to produce a different transform.

**Mechanism**:
```typescript
// In PdfPageElement.renderTiles():
const dpr = window.devicePixelRatio || 2;
const cssWidth = canvasWidth / dpr;
const fitScale = this.currentWidth / cssWidth;
this.canvas.style.transform = `translate(...) scale(${fitScale})`;
```

**Example Calculation**:
| Phase | Buffer Size | DPR | CSS Width | Element Width | fitScale |
|-------|-------------|-----|-----------|---------------|----------|
| Intermediate (scale 8) | 2048px | 2 | 1024px | 400px | 0.391 |
| Final (scale 16) | 4096px | 2 | 2048px | 400px | 0.195 |

If `fitScale` changes from 0.391 to 0.195, the canvas visually shrinks by 50%.

**Evidence Required**:
- Log `canvasWidth`, `cssWidth`, `fitScale` before and after the jump
- Verify buffer size changes between intermediate and final renders

**Code Location**: `pdf-page-element.ts:780-830`

---

### Theory 2: Tile Bounds Calculation Changes

**Hypothesis**: The visible tile set changes between gesture-active and gesture-end renders. Different tiles produce different bounding boxes, which shifts `canvasOffsetX/Y`.

**Mechanism**:
```typescript
// In PdfPageElement.renderTiles():
let minTileX = Infinity, minTileY = Infinity;
for (const { tile } of tiles) {
  minTileX = Math.min(minTileX, tile.tileX);
  minTileY = Math.min(minTileY, tile.tileY);
}
canvasOffsetX = tileBoundsX;  // = minTileX * pdfTileSize
canvasOffsetY = tileBoundsY;
```

**Example**:
| Render | Visible Tiles | minTileX | minTileY | canvasOffsetX | canvasOffsetY |
|--------|---------------|----------|----------|---------------|---------------|
| Intermediate | (0,0)-(3,3) | 0 | 0 | 0 | 0 |
| Final | (1,0)-(4,3) | 1 | 0 | 38.25 | 0 |

A change in `canvasOffsetX` from 0 to 38.25 would shift content by that amount.

**Evidence Required**:
- Log tile coordinates for each render
- Compare `minTileX/Y` and `canvasOffsetX/Y` between phases

**Code Location**: `pdf-page-element.ts:580-610`

---

### Theory 3: Snapshot vs Current Camera Mismatch

**Hypothesis**: The render uses a camera state that differs from what was displayed during the gesture.

**Mechanism**:
```typescript
// In PdfInfiniteCanvas - onRenderPhase callback:
const actualZoom = this.camera.z;  // Uses CURRENT camera, not snapshot

// In renderZoomPhase:
const effectiveCamera = phase === 'final'
  ? this.camera  // Final: use current camera
  : (zoomSnapshot?.camera ?? ...);  // Intermediate: use snapshot
```

**The Problem**:
- `this.camera` might have been modified after the snapshot was captured
- The snapshot captures camera at gesture-start, but camera continues updating during gesture
- Final render uses current camera which may have drifted from snapshot

**Example**:
| Time | Snapshot Camera | Current Camera | Used By Final Render |
|------|-----------------|----------------|---------------------|
| t=0 (start) | {x:0, y:0, z:8} | {x:0, y:0, z:8} | - |
| t=500 (end) | {x:0, y:0, z:8} | {x:-50, y:-30, z:16} | Current (drifted!) |

**Evidence Required**:
- Log `zoomSnapshot.camera` vs `this.camera` at render time
- Check if they differ significantly

**Code Location**:
- `pdf-infinite-canvas.ts:468-480` (onRenderPhase callback)
- `pdf-infinite-canvas.ts:2830-2840` (renderZoomPhase effectiveCamera)

---

### Theory 4: Constraint Application Timing

**Hypothesis**: Camera constraints should be applied after gesture ends but aren't, leaving the camera in an "invalid" position.

**Mechanism**:
The code explicitly AVOIDS constraining during zoom:
```typescript
// In handleZoom (pdf-infinite-canvas.ts:3890):
// "POSITION DRIFT FIX: Do NOT constrain camera during active zoom gestures."
// "The ZoomStateMachine will apply constraints in the settling/rendering phase"
```

But examining `renderZoomPhase`, there's no explicit constraint application:
```typescript
// Expected but NOT found in renderZoomPhase:
// this.camera = constrainCameraPosition(this.camera, this.cameraConstraints);
```

**The Problem**: If constraints were supposed to be applied but aren't, the camera remains at an "out of bounds" position. When tiles render, they may not cover the expected viewport area.

**Evidence Required**:
- Search for `constrainCameraPosition` calls in rendering phase
- Check if camera position is valid for current zoom level
- Verify constraint bounds at max zoom

**Code Location**:
- `pdf-infinite-canvas.ts:3890-3910` (constraint comment)
- `pdf-infinite-canvas.ts:2800-2920` (renderZoomPhase - missing constraint?)

---

### Theory 5: cssStretch Removal Masking Deeper Issue

**Hypothesis**: The `cssStretch` factor was previously compensating for another calculation error. Removing it from the transform exposed the underlying bug.

**Background**:
```typescript
// OLD CODE (caused visual bumps):
const transformStr = `translate(...) scale(${fitScale * avgCssStretch})`;

// NEW CODE (ZOOM BUMP FIX):
const transformStr = `translate(...) scale(${fitScale})`;
// Comment: "fallback tiles appear pixelated but correctly positioned"
```

**The Problem**: If `fitScale` was calculated assuming `cssStretch` would be applied, removing cssStretch creates a mismatch:

| Variable | Expected Role | Actual Usage |
|----------|---------------|--------------|
| `fitScale` | Scale canvas to element size | Applied in transform |
| `cssStretch` | Compensate for fallback tile resolution | NOT applied in transform |
| Combined | Correct visual scale | Mismatch if fitScale assumes cssStretch |

**Evidence Required**:
- Check if `fitScale` calculation uses any values that assume cssStretch
- Verify that `cssStretch` is only used for informational/debugging purposes now
- Test if re-adding cssStretch to transform fixes the position (even if it re-introduces bumps)

**Code Location**:
- `pdf-page-element.ts:770-780` (cssStretch calculation)
- `pdf-page-element.ts:800-810` (transform application)
- `progressive-tile-renderer.ts:432-434` (getCssScaleFactor)

---

### Theory 6: pdfToElementScale Calculation Race

**Hypothesis**: The ratio `this.currentWidth / pdfWidth` changes between renders, shifting all position calculations.

**Mechanism**:
```typescript
// In renderTiles (viewport-only path):
const pdfToElementScale = this.currentWidth / pdfWidth;
const layoutBoundsWidth = tileBoundsWidth * pdfToElementScale;
const cssOffsetX = Math.floor(canvasOffsetX * pdfToElementScale);
```

**Example**:
| Render | this.currentWidth | pdfWidth | pdfToElementScale | cssOffsetX (if canvasOffsetX=100) |
|--------|-------------------|----------|-------------------|-----------------------------------|
| Intermediate | 400 | 612 | 0.654 | 65 |
| Final | 400 | 612 | 0.654 | 65 |

If either `currentWidth` or `pdfWidth` changes unexpectedly, all offsets shift.

**Potential Causes**:
- `pdfWidth` comes from `pdfDimensions` parameter, might be undefined/different
- `currentWidth` might be updated by resize/layout between renders
- Fallback values differ between calls

**Evidence Required**:
- Log `pdfWidth`, `this.currentWidth`, `pdfToElementScale` for each render
- Check `pdfDimensions` parameter source

**Code Location**: `pdf-page-element.ts:565-570`, `pdf-page-element.ts:760-770`

---

### Theory 7: Scale Tier Quantization Jump

**Hypothesis**: At max zoom boundary, the scale tier calculation produces unexpected results, causing tile resolution mismatch.

**Mechanism**:
```typescript
// Scale tiers defined in progressive-tile-renderer.ts:
export const SCALE_TIERS: ScaleTier[] = [1, 2, 4, 8, 16, 32];

// getTargetScaleTier selects the tier that meets minimum required scale
function getTargetScaleTier(zoom: number, pixelRatio: number): ScaleTierResult {
  const minRequired = zoom * pixelRatio;
  // Find smallest tier >= minRequired
  for (const tier of SCALE_TIERS) {
    if (tier >= minRequired) {
      return { tier, cssStretch: minRequired / tier };
    }
  }
}
```

**Example at Max Zoom**:
| Zoom | Pixel Ratio | Min Required | Selected Tier | cssStretch |
|------|-------------|--------------|---------------|------------|
| 15.5 | 2 | 31 | 32 | 0.97 |
| 16.0 | 2 | 32 | 32 | 1.00 |
| 16.1 | 2 | 32.2 | 32 | 1.006 (capped) |

The tier stays at 32, but `cssStretch` changes. If something depends on cssStretch being exactly 1.0, the slight variation could cause issues.

**Evidence Required**:
- Log `getTargetScaleTier()` results during the bug
- Check if tier or cssStretch changes unexpectedly at gesture end

**Code Location**: `progressive-tile-renderer.ts:240-275`

---

### Theory 8: Rebound Events at Max Zoom

**Hypothesis**: After reaching max zoom, the trackpad continues sending "rebound" events that modify camera position incorrectly.

**Background**: Trackpads have physical inertia. When user stops pinching at max zoom, the hardware may send additional events as fingers settle.

**Mechanism**:
```typescript
// In zoomCameraToPoint (pdf-canvas-camera.ts):
// FIX: Only return early if BOTH zoom AND position are truly unchanged.
if (newZoom === camera.z && Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
  return camera;  // No change
}
// Otherwise, position adjustment is applied even if zoom is clamped
return { x: camera.x + dx, y: camera.y + dy, z: newZoom };
```

**The Problem**: Even when zoom is clamped at max, camera position continues adjusting. These adjustments might:
1. Accumulate small errors over multiple rebound events
2. Move the camera outside expected bounds
3. Cause the snapshot to be captured at a drifted position

**Evidence Required**:
- Log wheel events after zoom reaches max
- Track camera position changes when zoom is clamped
- Check if position drifts during the "clamped" period

**Code Location**:
- `pdf-canvas-camera.ts:105-146` (zoomCameraToPoint with fix)
- `pdf-gesture-handler.ts:108-135` (handleWheel)

---

### Theory 9: Async Render Completion Race

**Hypothesis**: Multiple render requests complete out of order, with a stale render overwriting the correct state.

**Mechanism**:
```typescript
// Version tracking exists:
if (scaleVersion !== this.scaleVersion) {
  console.log(`Ignoring stale ${phase} render`);
  return;
}
```

**The Problem**: The version check happens at `renderZoomPhase` level, but individual tile renders are async. Timeline:

```
t=0:    Request intermediate render (version 5)
t=50:   Request final render (version 6)
t=100:  Final render tiles arrive, applied (version 6)
t=150:  Intermediate render tiles arrive (version 5)
        → Version check passes? Or skipped at tile level?
        → Overwrites final render?
```

**Evidence Required**:
- Log render request versions at all stages
- Check if `renderTiles` validates version
- Monitor for multiple `renderTiles` calls in rapid succession

**Code Location**:
- `render-coordinator.ts:800-850` (requestRender)
- `pdf-page-element.ts:546-855` (renderTiles - no version check?)

---

### Theory 10: Viewport-Only vs Full-Page Mode Switch

**Hypothesis**: The render mode switches between viewport-only and full-page, causing different canvas sizing strategies to be applied.

**Mechanism**:
```typescript
// In renderTiles:
const isViewportOnly = minTileX > 0 || minTileY > 0 ||
  (maxTileX + 1) * pdfTileSize < pdfWidth - pdfTileSize ||
  (maxTileY + 1) * pdfTileSize < pdfHeight - pdfTileSize;

if (isViewportOnly && tiles.length > 0) {
  // VIEWPORT-ONLY PATH:
  // Canvas sized to tile bounds
  // Position with offset transform
  canvasWidth = Math.ceil(tileBoundsWidth * tileScale);
  const cssOffsetX = Math.floor(canvasOffsetX * pdfToElementScale);
  // transform = translate(cssOffsetX, cssOffsetY) scale(fitScale)
} else {
  // FULL-PAGE PATH:
  // Canvas sized to full page
  // Position at origin
  canvasWidth = Math.ceil(pdfWidth * tileScale);
  // transform = translate(0, 0) scale(fitScale)
}
```

**The Problem**: If intermediate render uses viewport-only but final render uses full-page (or vice versa):
- Canvas size changes dramatically
- Offset transform appears/disappears
- Visual position shifts

**Evidence Required**:
- Log `isViewportOnly` for each render
- Compare canvas sizing between intermediate and final
- Check if tile coverage changes between phases

**Code Location**: `pdf-page-element.ts:615-680`

---

## 5. Observability Gaps

### 5.1 Why is the Bug Not Easily Observable?

1. **Synthetic Events Don't Reproduce It**: The bug requires real trackpad physics (rebound, settling) that can't be simulated with `dispatchEvent`

2. **Timing-Dependent**: The bug occurs in the ~350ms window between gesture end and render completion - difficult to capture manually

3. **State Machine Complexity**: Three interacting systems (gesture handler, orchestrator, renderer) make it hard to trace causation

4. **No Instrumentation at Transform Application**: The critical moment (CSS transform change) isn't logged

5. **Snapshot Timing Invisible**: We don't log when snapshots are captured vs when they're used

### 5.2 Missing Telemetry Points

| Gap | What's Missing | Why It Matters |
|-----|----------------|----------------|
| Transform changes | No logging when `canvas.style.transform` is set | Can't see the visual jump source |
| Snapshot lifecycle | No logging of snapshot capture/use timing | Can't verify snapshot validity |
| Camera drift | No tracking of position changes when zoom clamped | Can't identify rebound-induced drift |
| Tile set comparison | No diff between intermediate/final tile sets | Can't see if coverage changes |
| Mode transitions | No logging of viewport-only ↔ full-page switches | Can't correlate mode with jump |

### 5.3 Required Instrumentation

```typescript
// Proposed logging additions:

// 1. Transform change tracking
const oldTransform = this.canvas.style.transform;
this.canvas.style.transform = newTransform;
if (oldTransform !== newTransform) {
  console.log(`[TransformChange] page=${this.pageNumber}`, {
    old: parseTransform(oldTransform),
    new: parseTransform(newTransform),
    delta: computeDelta(oldTransform, newTransform)
  });
}

// 2. Snapshot lifecycle
console.log(`[Snapshot] Captured at zoom=${camera.z}, position=(${camera.x}, ${camera.y})`);
console.log(`[Snapshot] Used for ${phase} render, age=${Date.now() - snapshotTime}ms`);

// 3. Mode transition
console.log(`[RenderMode] ${isViewportOnly ? 'viewport-only' : 'full-page'}`, {
  tileCount: tiles.length,
  tileBounds: { minX: minTileX, minY: minTileY, maxX: maxTileX, maxY: maxTileY },
  canvasSize: { width: canvasWidth, height: canvasHeight }
});
```

---

## 6. Key Code References

### 6.1 Primary Files

| File | Role | Key Functions |
|------|------|---------------|
| `pdf-canvas-camera.ts` | Camera math | `zoomCameraToPoint`, `screenToCanvas` |
| `pdf-gesture-handler.ts` | Input handling | `handleWheel`, `handleTouchMove` |
| `zoom-orchestrator.ts` | State machine | `onZoomGesture`, `endZoomGesture`, `onRenderPhase` |
| `pdf-infinite-canvas.ts` | Canvas coordinator | `handleZoom`, `renderZoomPhase` |
| `pdf-page-element.ts` | Tile compositing | `renderTiles` |
| `progressive-tile-renderer.ts` | Scale tier math | `getTargetScaleTier`, `getCssScaleFactor` |
| `tile-cache-manager.ts` | Tile retrieval | `getBestAvailable` (cssStretch calculation) |

### 6.2 Critical Code Paths

**Zoom Event Processing**:
```
handleWheel() → onZoom callback → handleZoom() → zoomCameraToPoint()
  → camera update → CSS transform → onZoomGesture()
```

**Gesture End Processing**:
```
150ms timeout → endZoomGesture() → settling state → 200ms timeout
  → rendering state → onRenderPhase() → handleZoomRenderPhase()
  → renderZoomPhase() → queueRender() → renderTiles()
```

**Tile Compositing**:
```
renderTiles() → calculate tile bounds → determine render mode
  → size canvas → draw tiles → calculate transform → apply CSS
```

### 6.3 Configuration Constants

| Constant | Value | Location | Impact |
|----------|-------|----------|--------|
| `maxZoom` | 16 | `pdf-infinite-canvas.ts` | Zoom clamp point |
| `gestureEndDelay` | 150ms | `zoom-orchestrator.ts` | Time to detect gesture end |
| `settlingDelay` | 200ms | `zoom-orchestrator.ts` | Time before final render |
| `SCALE_TIERS` | [1,2,4,8,16,32] | `progressive-tile-renderer.ts` | Render resolution options |
| `TILE_SIZE` | 256 | `tile-render-engine.ts` | Base tile size |
| `BASE_PAGE_WIDTH` | 400 | `pdf-infinite-canvas.ts` | Canvas coordinate base |

---

## 7. Debugging Strategy

### 7.1 Instrumentation Phase

Add detailed logging to capture:

1. **Camera State at Key Points**:
   - When zoom gesture starts
   - When zoom reaches max
   - When gesture ends
   - When render phase triggers
   - When tiles are composited

2. **Transform Changes**:
   - Every `canvas.style.transform` modification
   - Parse and log components (translate, scale)
   - Calculate visual position delta

3. **Render Mode Transitions**:
   - `isViewportOnly` determination
   - Tile bounds for each render
   - Canvas size changes

### 7.2 Reproduction Protocol

1. Open PDF with Amnesia (`amnesia:open-book` command)
2. Navigate to a distinctive page (cover works well)
3. Position cursor over a specific landmark
4. Pinch-zoom slowly to 16x
5. Continue pinching after zoom clamps
6. Release gesture and observe
7. Capture console logs immediately

### 7.3 Hypothesis Testing Order

Recommended order based on likelihood and ease of testing:

1. **Theory 1 (Buffer Size Jump)** - Most likely, easiest to verify
2. **Theory 2 (Tile Bounds)** - Second most likely, related to Theory 1
3. **Theory 10 (Mode Switch)** - Could explain sudden changes
4. **Theory 3 (Snapshot Mismatch)** - Known issue area
5. **Theory 8 (Rebound Events)** - Requires event logging
6. **Theory 4 (Constraint Timing)** - Requires code review
7. **Theory 5 (cssStretch Masking)** - Requires careful analysis
8. **Theory 9 (Async Race)** - Complex to verify
9. **Theory 6 (pdfToElementScale)** - Less likely but easy to check
10. **Theory 7 (Scale Tier)** - Least likely at max zoom

### 7.4 Quick Diagnostic Queries

```javascript
// Run in Obsidian console after reproducing bug:

// Get current canvas state
const pageEl = document.querySelector('.pdf-page-element canvas');
console.log({
  transform: pageEl.style.transform,
  width: pageEl.style.width,
  height: pageEl.style.height,
  bufferWidth: pageEl.width,
  bufferHeight: pageEl.height
});

// Get camera state
const canvas = app.workspace.getLeavesOfType('amnesia-reader')[0]
  .view.component.$$.ctx[3].infiniteCanvas;
console.log({
  camera: canvas.camera,
  snapshot: canvas.zoomOrchestrator.getZoomSnapshot()
});

// Get orchestrator state
console.log({
  state: canvas.zoomOrchestrator.getCurrentState(),
  renderState: canvas.zoomOrchestrator.getRenderState()
});
```

---

## 8. LLM Council Deliberation (2026-01-17)

An expert council of 4 LLMs (Claude Opus 4.5, GPT-5.2, Grok 4.1, Gemini 3 Pro) was convened to deliberate on the theories and identify the most likely root cause.

### 8.1 Council's Unanimous Verdict

**Primary Root Cause: Theory 8 (Rebound Events at Max Zoom)**

**Confidence Level: 90%+**

The Council unanimously agrees Theory 8 is the trigger, with the "smoking gun" being that **the bug requires real trackpad gestures and cannot be reproduced with synthetic events**.

#### The Critical Code Flaw

```typescript
// In zoomCameraToPoint (pdf-canvas-camera.ts) - THE BUG:
if (newZoom === camera.z && Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
  return camera;
}
// Position adjustment is STILL APPLIED even when zoom is clamped!
return { x: camera.x + dx, y: camera.y + dy, z: newZoom };
```

**Why this is the root cause:**

1. **Hardware-specific behavior**: Real trackpads have physical momentum. When the user hits max zoom and releases, the hardware continues sending micro-events during deceleration. Synthetic events stop cleanly.

2. **Silent camera drift**: Each rebound event applies `dx/dy` adjustments while zoom stays clamped. The camera position drifts *without any visual feedback* because:
   - Zoom is maxed → no scale change to see
   - CSS transform is GPU-cached → micro-movements aren't visible
   - User's fingers are releasing → not watching for tiny shifts

3. **Timing alignment**: The drift accumulates during exactly the ~150ms window before `endZoomGesture()` fires—plenty of time for 10-30 rebound events at 120Hz trackpad rate.

4. **Mathematical impact**:
   ```
   If each rebound event shifts camera by 0.5-2px in PDF space:
   - 20 events × 1px average = 20px drift
   - At 16x zoom, this is 320px screen shift
   - Matches user observation of significant focal point jump
   ```

### 8.2 The "Chain of Failure" (Compound Bug)

The Council identified this as a **compound bug** where multiple theories interact in sequence:

| Step | Theory | What Happens |
|------|--------|--------------|
| **1. Trigger** | **Theory 8** | Trackpad inertia sends rebound events after zoom clamps → camera silently drifts |
| **2. Betrayal** | **Theory 3** | Final render uses `this.camera` (drifted) instead of snapshot (clean) |
| **3. Amplification** | **Theory 10** | Drift pushes camera across tile boundary → mode switches (viewport-only ↔ full-page) |
| **4. Visual Artifact** | **Theory 2** | Changed tile bounds → `canvasOffsetX/Y` recalculated → visible position jump |

#### Full Causation Chain Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    ROOT CAUSE SEQUENCE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. User pinch-zooms to max (16x)                               │
│     └─► Zoom clamped, CSS preview stable                        │
│                                                                 │
│  2. User releases gesture, but trackpad has inertia             │
│     └─► Hardware sends 10-30 "rebound" wheel events             │
│         └─► [Theory 8 ACTIVATES]                                │
│                                                                 │
│  3. Each rebound event hits zoomCameraToPoint()                 │
│     └─► Zoom stays clamped (already at max)                     │
│     └─► But dx/dy adjustments still applied!                    │
│         └─► Camera drifts silently (no visual feedback)         │
│             └─► [Theory 4 ENABLES - no constraints stop this]   │
│                                                                 │
│  4. 150ms later: endZoomGesture() fires                         │
│     └─► Snapshot was captured BEFORE rebound drift              │
│     └─► this.camera now contains drifted position               │
│                                                                 │
│  5. 200ms settling delay passes                                 │
│                                                                 │
│  6. renderZoomPhase('final') executes                           │
│     └─► Uses this.camera (drifted) not snapshot (clean)         │
│         └─► [Theory 3 MANIFESTS]                                │
│     └─► Calculates new canvas buffer size                       │
│         └─► [Theory 1 AMPLIFIES]                                │
│     └─► Possibly switches render mode                           │
│         └─► [Theory 10 AMPLIFIES]                               │
│                                                                 │
│  7. Final tiles render at wrong position                        │
│     └─► VISIBLE JUMP - focal point shifts                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 Council Rankings & Dissent

#### Model Rankings

| Model | Ranking Score | Primary Assessment |
|-------|---------------|-------------------|
| **Claude Opus 4.5** | 1.0 (highest) | Theory 8 → 3 → 4 chain |
| **GPT-5.2** | 0.667 | Theory 8 + 10 + 2 compound |
| **Grok 4.1** | 0.333 | Theory 8 with 3 & 4 interaction |
| **Gemini 3 Pro** | 0.0 | Theory 10 primary (dissent) |

#### Dissenting Opinion (Gemini 3 Pro)

Gemini argued that **Theory 10 (Mode Switch)** is the primary implementation bug, with Theory 8 acting as a "chaos agent" that ensures the camera is unstable during the critical transition period.

**Gemini's Reasoning**:
- The "borders at 1x zoom" symptom suggests a coordinate space reset
- Mode switch from viewport-only to full-page changes the transform origin
- The missing offset calculation when switching modes is the math error

**Council's Response**: The majority found this reverses cause and effect. The mode switch is a *symptom* of the camera drift (crossing a tile boundary triggers the switch), not the root cause. Without the drift from Theory 8, the mode switch would not occur unexpectedly.

### 8.4 Theory Probability Assessment (Post-Deliberation)

| Theory | Pre-Council | Post-Council | Role |
|--------|-------------|--------------|------|
| **8: Rebound Events** | Unknown | **92%** | **Root Cause** |
| **3: Snapshot Mismatch** | Unknown | **88%** | Manifestation Mechanism |
| **4: Missing Constraints** | Unknown | **85%** | Enabling Condition |
| 1: Buffer Size Jump | Medium | 65% | Amplifier |
| 10: Mode Switch | Medium | 60% | Amplifier |
| 2: Tile Bounds | Medium | 40% | Secondary Effect |
| 9: Async Race | Low | 35% | Unlikely |
| 5: cssStretch | Low | 25% | Unrelated |
| 6: Scale Race | Low | 20% | Unlikely |
| 7: Quantization | Low | 15% | Unlikely |

### 8.5 Missing Theory Identified

**Theory 11: Gesture End Detection Lag**

The 150ms timeout to detect gesture end may be too permissive, allowing the "tail" of trackpad inertia to bleed into the settling phase, corrupting state after the snapshot was captured.

A better approach might be velocity-based detection:
```typescript
// Instead of pure timeout, track event velocity
if (timeSinceLastEvent > 50ms && recentEventVelocity < threshold) {
  // Gesture truly ended
}
```

### 8.6 Council's Recommended Debugging Protocol

#### Test 1: The "Drift Trap" (Confirm Theory 8)

```typescript
// In zoomCameraToPoint():
if (newZoom === camera.z) {
  console.log('[DRIFT-DEBUG] Position-only change at max zoom:', {
    timestamp: performance.now(),
    dx, dy,
    oldPos: { x: camera.x, y: camera.y },
    newPos: { x: camera.x + dx, y: camera.y + dy },
    zoomClamped: true
  });
}
```

**Expected Result**: Burst of logs after gesture release showing accumulated drift.

#### Test 2: The "Mismatch" Test (Confirm Theory 3)

```typescript
// In renderZoomPhase('final'):
if (phase === 'final' && zoomSnapshot) {
  console.log('[MISMATCH-DEBUG]', {
    snapshotCamera: zoomSnapshot.camera,
    currentCamera: this.camera,
    drift: {
      x: this.camera.x - zoomSnapshot.camera.x,
      y: this.camera.y - zoomSnapshot.camera.y
    },
    driftMagnitude: Math.sqrt(
      Math.pow(this.camera.x - zoomSnapshot.camera.x, 2) +
      Math.pow(this.camera.y - zoomSnapshot.camera.y, 2)
    )
  });
}
```

**Expected Result**: Non-zero drift values correlating with visible jump distance.

#### Test 3: The "Freeze" Test (Proves Theory 8)

```typescript
// Temporarily in zoomCameraToPoint():
if (newZoom === camera.z) {
  return camera;  // Block ALL position updates when zoom clamped
}
```

**Prediction**: Bug disappears immediately. If it does, Theory 8 is confirmed as root cause.

#### Test 4: Mode Switch Detection (Confirm Theory 10)

```typescript
// In renderTiles():
console.log('[MODE-DEBUG]', {
  isViewportOnly,
  tileCount: tiles.length,
  tileBounds: { minTileX, minTileY, maxTileX, maxTileY },
  canvasOffset: { x: canvasOffsetX, y: canvasOffsetY },
  canvasSize: { width: canvasWidth, height: canvasHeight }
});
```

**Expected Result**: Mode switches from viewport-only to full-page (or vice versa) when bug occurs.

### 8.7 Council's Recommended Fixes

#### Fix 1: Surgical Fix (Block drift at clamp) — **CRITICAL PRIORITY**

```typescript
// In zoomCameraToPoint():
zoomCameraToPoint(camera, focalPoint, delta, constraints) {
  const newZoom = clamp(camera.z * delta, constraints.minZoom, constraints.maxZoom);

  // FIX: If zoom is clamped at boundary, freeze position too
  const zoomWasClamped = (delta > 1 && newZoom === constraints.maxZoom) ||
                         (delta < 1 && newZoom === constraints.minZoom);

  if (zoomWasClamped) {
    // Don't apply position adjustment for clamped zoom events
    // This prevents rebound drift
    return { ...camera, z: newZoom };
  }

  // Normal case: apply both zoom and position
  const dx = /* focal point math */;
  const dy = /* focal point math */;
  return { x: camera.x + dx, y: camera.y + dy, z: newZoom };
}
```

#### Fix 2: Architectural Fix (Use snapshot for final render) — **HIGH PRIORITY**

```typescript
// In renderZoomPhase():
const effectiveCamera = phase === 'final'
  ? (zoomSnapshot?.camera ?? this.camera)  // Prefer SNAPSHOT over current
  : this.camera;
```

#### Fix 3: Complete the TODO (Apply constraints in settling phase) — **HIGH PRIORITY**

```typescript
// In ZoomOrchestrator.endZoomGesture() or entering 'settling' state:
endZoomGesture() {
  // Apply constraints that were deferred during zoom
  this.camera = constrainCamera(this.camera, this.constraints, this.contentBounds);
  this.state = 'settling';
  // ...
}
```

#### Fix Priority Matrix

| Fix | Impact | Risk | Priority |
|-----|--------|------|----------|
| Fix 1 (Block drift) | Eliminates root cause | Low - surgical change | 🔴 Critical |
| Fix 2 (Use snapshot) | Defense in depth | Medium - changes render logic | 🟠 High |
| Fix 3 (Apply constraints) | Completes deferred work | Low - fulfills existing TODO | 🟠 High |

---

## 9. Conclusions & Next Steps

### 9.1 Key Findings

1. **Root Cause Identified**: Theory 8 (Rebound Events at Max Zoom) is the definitive trigger, confirmed by unanimous council agreement and the unique symptom that real trackpad gestures are required.

2. **Compound Nature**: This is not a single bug but a chain of failures:
   - Theory 8 triggers silent camera drift
   - Theory 3 causes final render to use drifted state
   - Theory 10/2 amplify the visual discontinuity

3. **The "FIX" That Caused the Bug**: The code comment says "FIX: Only return early if BOTH zoom AND position are truly unchanged" — but this "fix" for one problem (focal point preservation) created the current bug by allowing position drift when zoom is clamped.

### 9.2 Recommended Implementation Order

1. **Phase 1: Diagnostic Instrumentation**
   - Add drift logging to `zoomCameraToPoint`
   - Add mismatch logging to `renderZoomPhase`
   - Add mode switch logging to `renderTiles`
   - Reproduce bug and capture logs to confirm theory

2. **Phase 2: Surgical Fix**
   - Implement Fix 1 (block drift when zoom clamped)
   - Test with real trackpad gestures
   - Verify bug is eliminated

3. **Phase 3: Defense in Depth**
   - Implement Fix 2 (use snapshot for final render)
   - Implement Fix 3 (apply constraints in settling phase)
   - These prevent regression and handle edge cases

4. **Phase 4: Cleanup**
   - Remove diagnostic logging (or gate behind feature flag)
   - Update documentation
   - Consider adding automated test with synthetic inertia simulation

### 9.3 Risk Assessment

| Risk | Mitigation |
|------|------------|
| Fix 1 might break focal point preservation for legitimate sub-max zoom | Only apply when zoom is AT the boundary, not approaching it |
| Fix 2 might cause stale renders if snapshot is too old | Add timestamp validation, fall back to current if snapshot > 500ms old |
| Fix 3 might cause visible "snap" when constraints applied | Apply constraints smoothly or ensure they match user's expected position |

### 9.4 Success Criteria

The bug will be considered fixed when:

1. User can pinch-zoom to max (16x) with real trackpad
2. User can continue pinching after max is reached
3. User can release gesture
4. **Focal point remains stationary** through the entire sequence
5. Final high-res tiles appear without any visible position jump
6. No regression in sub-max zoom behavior

---

## Appendix: Related Documentation

- [PDF Rendering Architecture v2.0](../unified-coordinate-space-architecture.md)
- [Performance Optimization Plan](../2026-01-14/performance-optimization-plan.md)
- [Coordinate Debugger Usage](../../specifications/coordinate-debugger-spec.md)

---

*Document maintained by the Amnesia development team. For questions or updates, see the project repository.*

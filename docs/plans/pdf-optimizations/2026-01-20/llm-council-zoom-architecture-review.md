# LLM Council: PDF Zoom Architecture Review

**Date:** 2026-01-20
**Council Members:** GPT-5.2, Gemini-3-Pro, Claude Opus 4.5, Grok-4
**Status:** Partial synthesis (all 4 models responded)

---

## Executive Summary

The Council identified a **critical architectural flaw**: the current implementation attempts to drive visual updates via the render loop. Native apps (like Preview.app) decouple these using a **Two-Track Pipeline**:

1. **Interaction Track (Synchronous/GPU):** CSS Transforms update the container *every frame* based on gesture input. No re-rendering.
2. **Refinement Track (Asynchronous/CPU):** Canvas re-renders at the new scale in the background, updating the DOM only when the frame is ready.

---

## Bug Validation Summary

| Fix | Verdict | Critical Adjustment Required |
|-----|---------|------------------------------|
| **1. Remove `isRendered` check** | CONDITIONAL | **DO NOT use `toDataURL()`**. Use `ctx.drawImage` to offscreen canvas or DOM layering instead. |
| **2. Investigate Exact Scale** | VALID | The "Stepped" feel is likely **Input Quantization** (wheel events) or **CSS Transforms being disabled**. |
| **3. Unified Constraint Math** | VALID | Must be unified (no "fit vs exceed" branching), **BUT** constraints should **decouple** during the gesture. |
| **4. Transition Timing** | APPROVED | "Snapshot → Move Camera" is the correct order. Never blank (`opacity: 0`) until new layer is ready. |
| **5. Enable CSS Transforms** | **CRITICAL** | **Highest priority.** Cannot achieve 60fps smooth zoom by re-rasterizing every frame. |
| **6. Epoch Validation** | APPROVED | Mandatory for async rendering pipeline to prevent "time travel" bugs. |

---

## Revised Priority Order

| Priority | Fix | Why | Est. Effort |
|----------|-----|-----|-------------|
| **P0** | Fix 5 (CSS Transforms) | Solves stepped zoom by decoupling interaction from rendering | Low (1 day) |
| **P1** | Fix 6 (Epochs) | Solves data integrity/race conditions | Low (1 day) |
| **P2** | Fix 1 (Snapshots) | Solves blanking, provided `toDataURL` replaced with drawImage | Med (1-2 days) |
| **P3** | Fix 3 (Constraints) | Solves drift, apply hard constraints only at gesture END | Med (2-3 days) |
| **P4** | Fix 4 (Deferred Transitions) | Polish to prevent mode-switch jank | Low (1 day) |

---

## Critical Architectural Insights

### 1. The "ToDataURL" Trap

All models **unanimously rejected** `canvas.toDataURL()` for snapshots. It forces a synchronous PNG encode/decode cycle (100ms+).

**Solution:** Use **DOM Layering**:
- Keep the "stale" canvas visible via CSS z-index
- Or copy using `destCtx.drawImage(sourceCanvas)`
- Or use `createImageBitmap()` (async, avoids PNG encode)

### 2. Constraint Philosophy

The math error causes jumps, but applying *any* hard constraint during a multi-touch gesture causes "Focal Drift."

**Solution:**
- **During Gesture:** Apply **Soft Constraints** (or none). Allow rubber-banding.
- **Gesture End:** Animate the camera back to hard constraint boundaries.

### 3. Mode Switching Strategy

Do not swap rendering modes (Full Page ↔ Tiled) *during* a pinch.

**Solution: Deferred Switching**
- If user starts pinching in "Full Page" mode, keep that mode active (just scale via CSS)
- Wait until gesture ends (plus hysteresis buffer) to switch to Tiled engine

---

## What Native Apps Do That We're Missing

| Feature | Native Apps | Current Implementation |
|---------|-------------|------------------------|
| **Core Animation layers** | GPU-composited, persistent | CSS + Canvas (recreated) |
| **CATiledLayer** | Automatic LOD, async tiles | Manual tile management |
| **Gesture velocity prediction** | Built-in momentum | None |
| **Layer caching** | Automatic | Manual snapshots |
| **60-120Hz sync** | CADisplayLink | requestAnimationFrame |

### Missing Pieces to Add:

1. **Velocity/Input Smoothing:** Raw wheel events are stepped. Need spring physics interpolator.
2. **Visual vs Logical Split:** Visual camera updates instantly (CSS); Logical camera catches up when it can.
3. **Predictive Pre-Rendering:** Queue tiles at `targetZoom ±0.5`; use velocity to predict 3 frames ahead.

---

## Detailed Fix Implementations

### P0: Re-enable CSS Transforms

```typescript
// CURRENT (buggy)
this.zoomTransformLayer = new ZoomTransformLayer(this.canvas, {
  disableCssTransforms: true, // Camera handles CSS transforms
});

// FIX
this.zoomTransformLayer = new ZoomTransformLayer(this.canvas, {
  disableCssTransforms: false, // Let ZoomTransformLayer handle smooth interpolation
});
```

Also add layer promotion:
```typescript
this.contentLayer.style.willChange = 'transform';
this.contentLayer.style.transform = 'translateZ(0)'; // Force GPU layer
```

### P1: Wire Epoch Validation

```typescript
// Find all renderTiles() calls and add epoch parameter
// BEFORE:
await element.renderTiles(tiles, textLayerData, zoom, pdfDimensions, transformSnapshot);

// AFTER:
await element.renderTiles(tiles, textLayerData, zoom, pdfDimensions, transformSnapshot, this.renderVersion);
```

### P2: Fix Snapshot Mechanism

```typescript
// BEFORE (slow, blocking)
const dataUrl = this.canvas.toDataURL('image/png');
this.transitionSnapshot.src = dataUrl;

// AFTER (fast, non-blocking)
private createFastSnapshot(): HTMLCanvasElement | null {
  if (this.canvas.width === 0 || this.canvas.height === 0) return null;

  const snapshot = document.createElement('canvas');
  snapshot.width = this.canvas.width;
  snapshot.height = this.canvas.height;
  const ctx = snapshot.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(this.canvas, 0, 0); // Fast GPU copy, no encoding
  return snapshot;
}
```

### P3: Rewrite Constraint Logic

```typescript
constrainCameraPosition(
  camera: Camera,
  viewport: Size,
  contentSize: Size,
  isGestureActive: boolean = false
): Camera {
  // CRITICAL: During active gestures, use SOFT constraints only
  if (isGestureActive) {
    return this.applySoftConstraints(camera, viewport, contentSize);
  }

  // At gesture END: apply hard constraints
  return this.applyHardConstraints(camera, viewport, contentSize);
}

private applySoftConstraints(camera: Camera, viewport: Size, content: Size): Camera {
  // Allow 30% overscroll with rubber-band resistance
  const { x, y, z } = camera;
  const scaledW = content.width * z;
  const scaledH = content.height * z;

  let targetX = x, targetY = y;

  if (scaledW > viewport.width) {
    const minX = 0;
    const maxX = content.width - viewport.width / z;
    if (x < minX) targetX = minX + (x - minX) * 0.3; // Rubber band
    if (x > maxX) targetX = maxX + (x - maxX) * 0.3;
  }
  // Similar for Y...

  return { x: targetX, y: targetY, z };
}
```

### P4: Defer Mode Transitions

```typescript
handleZoomChange(newZoom: number, isGestureActive: boolean) {
  const shouldBeTiled = newZoom >= this.TILING_THRESHOLD;

  if (isGestureActive) {
    // Just note pending transition, don't execute
    this.pendingMode = shouldBeTiled ? 'tiled' : 'full-page';
    // Start pre-rendering in background
    this.preRenderForMode(this.pendingMode, newZoom);
  } else {
    // Gesture ended, execute transition
    if (this.pendingMode !== this.currentMode) {
      this.executeTransition(this.pendingMode);
    }
  }
}
```

---

## Risk Assessment

| Fix | Risks | Mitigation | Severity |
|-----|-------|------------|----------|
| P0 (CSS Transforms) | Jank on low-end devices | Fallback to ctx.scale() | Low |
| P1 (Epoch) | None - pure safety | - | None |
| P2 (Snapshots) | Memory leaks if not cleaned | Track and revoke bitmaps | Med |
| P3 (Constraints) | Infinite loops if math off | Unit tests for 100 zooms | High |
| P4 (Mode Transitions) | State machine complexity | Thorough testing | Med |

---

## Success Criteria

### P0: CSS Transforms
- [ ] Zoom feels continuous, not stepped
- [ ] No visible "jumps" between wheel events
- [ ] 60 FPS maintained during pinch gesture

### P1: Epoch Validation
- [ ] No console warnings about epoch mismatch
- [ ] Stale tiles never displayed after zoom change
- [ ] Rapid zoom-in/out doesn't show old content

### P2: Snapshots
- [ ] Mode transitions have zero blank frames
- [ ] No `toDataURL` calls in hot path
- [ ] Memory doesn't grow unbounded during zoom

### P3: Constraints
- [ ] Focal point drift < 5px during full zoom gesture
- [ ] No "jumps" when crossing content-fits-viewport threshold
- [ ] Rubber-band effect visible at edges during gesture

### P4: Mode Transitions
- [ ] No blank frames when crossing 4x threshold
- [ ] Mode switch only happens after gesture ends
- [ ] Hysteresis prevents oscillation at threshold

---

## Council Details

- **gemini-3-pro-preview:** 40587ms response time
- **grok-4.1-fast:** 48942ms response time
- **gpt-5.2:** 71465ms response time
- **claude-opus-4.5:** 105215ms response time

All models reached consensus on the Two-Track Pipeline architecture and the priority ordering of fixes.

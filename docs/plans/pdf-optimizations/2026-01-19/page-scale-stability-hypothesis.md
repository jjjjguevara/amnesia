# Page Scale Stability Bug: Root Cause Hypothesis

> **Date**: 2026-01-19
> **Status**: Pending Council Validation
> **Symptom**: Page content "stretches" and "drifts" during zoom transitions

---

## The Correct Mental Model

### How It SHOULD Work

```
┌─────────────────────────────────────────────────────────────┐
│                    PAGE CONTAINER                            │
│                                                              │
│   • Fixed size (e.g., 400×518 CSS pixels)                   │
│   • NEVER changes dimensions                                 │
│   • Position controlled by camera CSS transform              │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐  │
│   │                 RENDERED CONTENT                      │  │
│   │                                                       │  │
│   │   • Always fits exactly within container bounds       │  │
│   │   • Resolution changes based on zoom (more detail)    │  │
│   │   • Visual size NEVER changes                         │  │
│   │                                                       │  │
│   └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Camera Transform: scale(zoom) translate(x, y)
  └─> Controls visual magnification (what user sees)
  └─> Page container stays fixed, camera "magnifies" it
```

### Key Invariant

**The page container is the stable reference frame.**

- Container dimensions: CONSTANT (400×518px or similar)
- Content rendered inside: Always PRE-FITTED to container bounds
- Camera zoom: Magnifies the entire container uniformly
- Tile resolution: Only affects sharpness/detail, NOT visual size

---

## What's Actually Happening (The Bug)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. User zooms from 2x to 4x                                  │
│    Camera transform updates: scale(2) → scale(4)            │
│    Container visually magnifies (correct!)                   │
└────────────────────────────────────┬────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. System requests higher-resolution tiles for 4x zoom       │
│    Tiles rendered at scale=8 (zoom × pixelRatio)            │
│    Tiles are large buffers (e.g., 3584×1680 pixels)         │
└────────────────────────────────────┬────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Tiles complete rendering, ready to display                │
│                                                              │
│    ★ BUG: Tiles are displayed with fitScale transform ★     │
│                                                              │
│    fitScale = pdfToElementScale × dpr / tileScale           │
│    fitScale = (containerWidth / pdfWidth) × 2 / 8           │
│    fitScale ≈ 0.22 (varies based on current container!)     │
│                                                              │
│    This CSS transform is applied AT DISPLAY TIME            │
│    Container dimensions may have changed since request!      │
└────────────────────────────────────┬────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. RESULT: Visual content "stretches" or "drifts"           │
│                                                              │
│    • Tiles rendered for one container state                  │
│    • Displayed with transform calculated for different state │
│    • Visual mismatch = content appears wrong size            │
│    • User sees page "stretch" then "snap" to correct size   │
└─────────────────────────────────────────────────────────────┘
```

---

## Hypotheses

### H1: Post-Render Transformation (HIGH CONFIDENCE)

**The fitScale transformation is applied AFTER tiles render, not BEFORE.**

Current flow:
```
Request tiles → Render at tileScale → Display → Apply fitScale CSS
                                                 ↑
                                                 This step uses
                                                 CURRENT dimensions
```

Correct flow:
```
Request tiles → Calculate fitScale NOW → Render with transform baked in → Display
                ↑
                Use REQUEST-TIME dimensions
                Tiles arrive pre-fitted to container
```

**Evidence:**
- Console shows `fitScale=0.2179` calculated at display time
- `expectedScale=4, actualScale=6` shows scale mismatch
- Content visibly changes size when tiles swap

### H2: Container Size Instability (MEDIUM CONFIDENCE)

**The container dimensions change during zoom, invalidating tile positioning.**

The code may be updating container dimensions based on zoom:
```typescript
// Possibly in setFinalDimensions() or similar
this.currentWidth = baseWidth × zoom;  // Container size changes!
```

But tiles were requested when container was a different size. When they display, the fitScale calculation uses the NEW container size, causing mismatch.

**Evidence:**
- `pdfToElementScale = currentWidth / pdfWidth` depends on container
- Container may resize during zoom transitions

### H3: Two Transforms Fighting (MEDIUM CONFIDENCE)

**Camera transform AND fitScale transform both affect visual size.**

```
Visual size = camera.scale × fitScale × tileBuffer

If camera.scale changes but fitScale doesn't update atomically,
the visual size temporarily changes.
```

**Evidence:**
- Camera transform: `scale(2.699)`
- Tile transform: `scale(0.2179)` (fitScale)
- These should compose to show content at correct size
- But timing mismatch causes temporary wrong size

### H4: Tile Buffer Not Pre-Scaled (HIGH CONFIDENCE)

**Tiles should be scaled to fit container BEFORE entering the display buffer.**

Current architecture:
```
MuPDF renders tile at scale=8 → Raw buffer → Display → CSS scales it down
```

Correct architecture:
```
MuPDF renders tile at scale=8 → Scale to container fit → Buffer → Display as-is
```

The scaling should happen in the worker or immediately after, NOT via CSS at display time.

---

## The Core Insight

From the user's description:

> "The page container shouldn't change in size at any point... The only thing that requires careful orchestration are the requests sent for the correct image resolutions, so that they're transformed to the correct aspect ratio (fit-to-width) BEFORE they're queued in the buffer and served to the page."

**The fix is architectural:**

1. **Pre-compute the target size** at request time
2. **Transform tiles to target size** in the render pipeline (worker or post-worker)
3. **Display tiles without additional CSS transform** (or with identity transform)
4. **Container stays fixed**, camera handles all visual scaling

---

## Current Code Flow (Problematic)

```typescript
// pdf-page-element.ts renderTiles()

// 1. Tiles arrive with their native resolution
const canvasWidth = Math.ceil(tileBoundsWidth * tileScale);  // Large buffer

// 2. Draw tiles to offscreen canvas at native resolution
offCtx.drawImage(bitmap, canvasX, canvasY, drawWidth, drawHeight);

// 3. Calculate fitScale at display time (THE PROBLEM)
const pdfToElementScale = this.currentWidth / pdfWidth;  // Uses CURRENT width
const fitScale = pdfToElementScale * dpr / expectedTileScale;

// 4. Apply CSS transform to shrink the large buffer
this.canvas.style.transform = `translate(...) scale(${fitScale})`;
//                                                    ↑
//                                         This varies based on current state!
```

---

## Proposed Fix Direction

### Option A: Bake Transform Into Tile Buffer

Scale tiles to target size immediately after rendering, before display:

```typescript
// In worker or post-worker processing
const targetWidth = containerWidth;  // Fixed at request time
const targetHeight = containerHeight;

// Scale the tile buffer to fit container
const scaledBitmap = scaleToFit(rawBitmap, targetWidth, targetHeight);

// Display without additional CSS transform
canvas.style.transform = 'none';  // Or identity
ctx.drawImage(scaledBitmap, 0, 0);
```

### Option B: Fixed Container, Fixed Tiles

Ensure container NEVER changes size, and tiles are always rendered to match:

```typescript
// Container size is constant
const CONTAINER_WIDTH = 400;
const CONTAINER_HEIGHT = 518;

// Tile target is always the container
// Higher zoom = higher resolution tiles, but same output size
const tileOutputWidth = CONTAINER_WIDTH;
const tileOutputHeight = CONTAINER_HEIGHT;
```

### Option C: Unified Coordinate Space (Proper Implementation)

The unified coordinate space was meant to solve this, but may be implemented incorrectly:

```typescript
// All tiles, regardless of zoom or scale, render to the same coordinate space
// The coordinate space IS the container
// Camera zoom is purely visual magnification via CSS, separate from tile rendering
```

---

## Questions for Council Validation

1. **Is H1 (post-render transformation) the root cause?**
2. **Should tiles be pre-scaled before display, eliminating fitScale CSS?**
3. **Is the container size supposed to be fixed or zoom-dependent?**
4. **What's the correct separation between camera zoom and tile resolution?**

---

## Next Steps

1. Validate hypotheses with LLM Council
2. Identify which code paths are violating the invariant
3. Design fix that bakes transforms into tiles pre-display
4. Implement and test with real trackpad gestures

# ScaleStateManager Gap Analysis

## Code Review Findings

### Issue 1: Coordinate Space Mismatch (FIXED)
**Status:** Fixed in this session

The focal point was being passed in viewport coordinates but compared against tile positions in canvas coordinates.

**Fix Applied:**
```typescript
// pdf-infinite-canvas.ts - zoomAtPoint()
const canvasFocalPoint: Point = {
  x: point.x + this.camera.x,
  y: point.y + this.camera.y,
};
this.scaleStateManager.setFocalPoint(canvasFocalPoint, 'zoom');
```

### Issue 2: Duplicated Mode Transition Logic (FIXED - amnesia-wbp)
**Status:** Fixed in this session

**Changes Applied:**
1. Added `MAX_TILED_ZOOM = 64.0` to ScaleStateManager.RENDER_MODE_THRESHOLDS
2. Added `committedRenderMode`/`pendingRenderMode` to ScaleState for gesture-aware tracking
3. Added `getEffectiveRenderMode()`, `isTiledMode()` getters
4. Removed `TILING_THRESHOLD`, `HYSTERESIS_BAND`, `MAX_TILED_ZOOM` from pdf-infinite-canvas
5. Removed `lastRenderMode`, `pendingModeTransition` state variables
6. Added `checkAndExecuteModeTransition()` helper
7. Updated all 6 mode decision sites to use ScaleStateManager
8. Fixed MAX_TILED_ZOOM boundary condition (>= instead of >)

**Impact on Open Issues:**
1. **H9 (amnesia-4bj) - Threshold flapping:** NOW UNBLOCKED. Single source of truth eliminates mode disagreements.
2. **H8 (amnesia-2t8) - Epoch mismatch:** NOW UNBLOCKED. Mode transitions go through ScaleStateManager with epoch tracking.
3. **H10 (amnesia-1hy) - Stale transform:** NOW UNBLOCKED. Gesture-aware mode tracking prevents stale state.

### Issue 3: Scale Calculation Sites Still Distributed
**Status:** Partial migration (unchanged from before)

ScaleStateManager centralizes mode decisions, but some scale calculations remain distributed:
- `render-coordinator.ts` - `getTileScale()` method
- `scroll-strategy.ts` - `getScaleForZoom()` method

## Relationship to Cluster A (H4-H7)

These issues (DPR, measurement APIs, PDF units, tile extent rounding) are **orthogonal** to ScaleStateManager:
- ScaleStateManager ensures scale consistency across time (epoch-based)
- Cluster A issues are about coordinate precision within a single frame

ScaleStateManager cannot fix Cluster A issues. They require:
1. Consistent measurement API usage (all float or all integer)
2. Single DPR application point
3. Centralized PDF units conversion

## Next Steps Priority

1. **Critical:** Fix duplicated mode transition logic (affects H9)
2. **High:** Complete scale centralization (affects all tile rendering)
3. **Medium:** Address Cluster A after amnesia-x6q unblocks H1 verification
4. **Low:** Mode transition atomicity (H8, H10) after above are stable

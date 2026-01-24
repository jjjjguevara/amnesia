# ZoomOrchestrator Abort Fix (2026-01-22)

## Problem
Aggressive `abortAllPending()` calls in ZoomOrchestrator caused only 54% of tiles to complete rendering during continuous zooming. Tiles were being killed mid-render, and full-page fallbacks never got cached.

**Root Cause**: Two methods in zoom-orchestrator.ts called `renderCoordinator.abortAllPending()` too aggressively:
1. `startZoomGesture()` - called on every zoom gesture start (idle→zooming, rendering→zooming)
2. `resumeZoomGesture()` - called when resuming from settling state

## Fix Applied

### 1. resumeZoomGesture (line 402-442)
**Before**: Always aborted all pending renders when resuming from settling
**After**: Removed `abortAllPending()` - tiles from settling phase are still valid for the same gesture

```typescript
// FIX: Do NOT abort pending renders when resuming from settling.
// The tiles in-flight were requested for the same gesture context.
this.abortCurrentPhase();
// REMOVED: this.renderCoordinator.abortAllPending();
```

### 2. startZoomGesture (line 342-371)
**Before**: Always aborted all pending renders on any zoom gesture
**After**: Only abort if scale changes by more than 1.5x (one tier)

```typescript
const scaleRatio = Math.max(targetScale, currentScale) / Math.min(targetScale, currentScale);
const SCALE_ABORT_THRESHOLD = 1.5;
const shouldAbort = scaleRatio > SCALE_ABORT_THRESHOLD;

if (this.renderCoordinator && shouldAbort) {
  this.renderCoordinator.abortAllPending();
}
```

## Rationale
- Tiles at similar scales are still useful and shouldn't be discarded
- In-flight renders during settling phase were requested for the same gesture context
- Only abort when scale changes significantly enough that tiles would be useless

## Testing
- Rapid zoom in/out cycles show no coverage errors
- Mode transitions work smoothly with snapshots
- No visual corruption or blank tiles observed

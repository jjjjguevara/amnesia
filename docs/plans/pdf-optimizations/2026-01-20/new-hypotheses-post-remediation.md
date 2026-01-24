# New Hypotheses: Why The Elusive Bug Persists Post-Remediation

> **Date**: 2026-01-20
> **Status**: Investigation Complete
> **Context**: Despite implementing the LLM Council's remediation plan (2026-01-19), the focal point drift bug persists when releasing zoom gesture at max zoom level.

---

## Executive Summary

**Three parallel code review agents identified that the Council's recommendations were PARTIALLY implemented.** The critical fixes that block rebound-induced drift were either not implemented or not wired up.

**Key Finding**: The correct solution exists as dead code (`ZoomStateManager`), while a broken implementation (`renderVersion` in `pdf-infinite-canvas.ts`) is active.

---

## New Hypotheses (Ranked by Likelihood)

### H1: Epoch Only Increments at Gesture Start, Not Every Zoom Change (Confidence: 95%)

**Location**: `pdf-infinite-canvas.ts:4086-4091`

**The Bug**: The epoch (`renderVersion`) only increments when a NEW gesture starts, not during continuous zoom. This means tiles rendered at intermediate zoom levels pass validation when they should fail.

**Current Code**:
```typescript
const isNewGesture = currentState === 'idle' || currentState === 'settling' || currentState === 'rendering';
if (isNewGesture) {
  ++this.renderVersion;  // Only at gesture START!
}
```

**Bug Timeline**:
```
Time 0ms:   Gesture starts → renderVersion=100, zoom=15.5x
Time 50ms:  Zoom continues → renderVersion=100 (unchanged!), zoom=15.97x
            Tile queued with epoch=100
Time 150ms: Zoom continues → renderVersion=100 (unchanged!), zoom=16.00x
            CSS shows 16.00x
Time 200ms: Tile completes (rendered at 15.97x, epoch=100)
            Validation: snapshot.epoch=100 === current.epoch=100 ✓ PASS (should FAIL!)
            Tile displayed at wrong position → DRIFT
```

**Fix**: Increment `renderVersion` on EVERY zoom change, not just gesture start.

**The Irony**: `ZoomStateManager` (zoom-state-manager.ts:230) has correct epoch logic that increments on every `onZoomGesture()` call, but this class is NEVER instantiated or used!

---

### H2: Core Council Fix NOT Implemented - Position Still Adjusts When Zoom Clamped (Confidence: 100%)

**Location**: `pdf-canvas-camera.ts:106-155`

**The Bug**: The Council's surgical fix for Theory 8 (Rebound Events at Max Zoom) was **never implemented**. The `zoomCameraToPoint()` function still allows position adjustment when zoom is clamped at max.

**Current Code** (lines 146-154):
```typescript
if (newZoom === camera.z && Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
  return camera;  // Only returns early if BOTH zoom AND position unchanged
}
return { x: camera.x + dx, y: camera.y + dy, z: newZoom };  // Position still adjusts!
```

**Council's Recommended Fix** (NOT IMPLEMENTED):
```typescript
const zoomWasClamped = (delta > 1 && newZoom === constraints.maxZoom) ||
                       (delta < 1 && newZoom === constraints.minZoom);
if (zoomWasClamped) {
  return { ...camera, z: newZoom };  // Block position adjustment
}
```

**Impact**: Every rebound event at max zoom causes ~0.1-0.5px drift. Over 20-30 rebound events (typical trackpad inertia), this accumulates to ~10-20px, which at 16x zoom appears as ~150-300px screen shift.

---

### H3: Rebound Protection Exists But Never Wired Up (Confidence: 95%)

**Location**: `zoom-orchestrator.ts:616` (exists) vs `pdf-infinite-canvas.ts` (not called)

**The Bug**: `ZoomOrchestrator.isInReboundWindow()` method exists but is NEVER called in the zoom handling pipeline.

**Evidence**:
- Grep for `isInReboundWindow` in `pdf-infinite-canvas.ts` returns NO matches
- The wheel handler directly calls `zoomAtPoint()` without rebound detection
- `zoomAtPoint()` has no rebound filtering logic

**Expected Usage**:
```typescript
// In handleWheel or zoomAtPoint:
if (this.zoomStateMachine.isInReboundWindow(600)) {
  this.zoomStateMachine.signalOngoingActivity();
  return;  // Ignore rebound events
}
```

---

### H4: `cssStretch` Still Tracked Despite Being "Eliminated" (Confidence: 95%)

**Location**: `pdf-page-element.ts:138, 276-278, 886-912`

**The Bug**: While `fitScale` was removed from the transform string, `cssStretch` is still calculated, tracked, and stored as instance state. This creates hidden state that could cause coordinate drift.

**Evidence**:
- Line 138: `private currentCssStretch: number = 1;`
- Lines 276-278: `getCurrentCssStretch()` method exposes this value
- Lines 886-912: `avgCssStretch` calculated from tiles on every render

**Risk**: If ANY code path reads `getCurrentCssStretch()` and applies it to transforms or position calculations, drift occurs. The remediation should have removed ALL cssStretch tracking.

---

### H5: Constraints Applied During Active Gesture (Confidence: 85%)

**Location**: `pdf-infinite-canvas.ts:4066`

**The Bug**: `constrainCameraPositionPreservingFocalPoint()` is called on EVERY zoom event during active gestures, not just at gesture end.

**Council Recommendation**:
- During gesture: Soft constraints only (or none) - allow rubber-banding
- At gesture end: Hard constraints in settling phase

**Current Behavior**: Hard constraints applied continuously, potentially fighting with focal point calculations.

---

### H6: Canvas CSS Not Fixed During Mode Transitions (Confidence: 90%)

**Location**: `pdf-page-element.ts:1745-1768`

**The Bug**: During viewport-only → full-page transitions, `prepareForFullPageRender()` uses `opacity: 0` to hide the canvas while changing dimensions. The old viewport-only buffer content gets stretched when revealed.

**Timeline**:
```
1. Old canvas: CSS 200×200px, buffer has viewport-only content
2. Transition starts: opacity=0, CSS changed to 400×600px
3. Buffer content (still 200×200) stretched to fill 400×600
4. New render completes, buffer updated
5. opacity=1 - user sees momentary stretched content
```

---

### H7: Strict Epoch Validation Causes Cascading Tile Rejection (Confidence: 85%)

**Location**: `pdf-page-element.ts:654-663`

**The Bug**: When epoch mismatch is detected, ALL tiles are discarded. During continuous zoom, this creates blank screen:

```typescript
} else if (usedSnapshot && !epochValid) {
  console.warn(`[PDFPageElement] REJECTING stale tiles: epoch mismatch`);
  for (const { bitmap } of tiles) {
    bitmap.close();
  }
  return;  // Discard all tiles
}
```

**Impact**: During 4x → 8x → 12x zoom over 300ms:
- Tiles at 4x (epoch 1) rejected when epoch is 3
- Tiles at 8x (epoch 2) rejected when epoch is 3
- Only tiles at exact current zoom (12x) display
- Result: Blank frames during zoom, sudden pop when zoom stops

---

### H8: Mode Switching Can Occur During Active Gestures (Confidence: 75%)

**Location**: `pdf-page-element.ts:723-725`

**The Bug**: `isViewportOnly` is calculated fresh on every `renderTiles()` call with no hysteresis or gesture-awareness.

```typescript
const isViewportOnly = minTileX > 0 || minTileY > 0 ||
  (maxTileX + 1) * pdfTileSize < pdfWidth - pdfTileSize ||
  (maxTileY + 1) * pdfTileSize < pdfHeight - pdfTileSize;
```

**Risk**: If user pans while zooming, mode could flip between frames:
- Frame 1: Full viewport coverage → `isViewportOnly = false` → full-page CSS
- Frame 2: Slight pan → `isViewportOnly = true` → viewport-only CSS
- Result: Visual jump from CSS size/transform change

---

## Code Review Agent Findings Summary

### Agent 1: Zoom Transform Architecture

| Check | Status | Issue |
|-------|--------|-------|
| P0: CSS Transforms enabled | ✅ IMPLEMENTED | `disableCssTransforms: false` |
| P1: Epoch validation | ❌ BROKEN | Epoch only increments at gesture START |
| Correct implementation exists | ⚠️ UNUSED | `ZoomStateManager` has correct logic |

### Agent 2: Camera & Constraints

| Check | Status | Issue |
|-------|--------|-------|
| Block drift when zoom clamped | ❌ NOT IMPLEMENTED | Core Council fix missing |
| Rebound window detection | ❌ NOT WIRED | Method exists, never called |
| Snapshot for final render | ✅ IMPLEMENTED | Camera snapshot pattern correct |
| Constraints at gesture end only | ❌ WRONG TIMING | Applied during active gesture |

### Agent 3: Tile Rendering Pipeline

| Check | Status | Issue |
|-------|--------|-------|
| fitScale eliminated | ✅ IMPLEMENTED | No scale in transform string |
| cssStretch tracking removed | ❌ STILL PRESENT | Hidden state persists |
| Fixed CSS dimensions | ⚠️ PARTIAL | Not fixed during transitions |
| Epoch validation | ⚠️ TOO STRICT | Rejects all stale tiles |
| Mode switch protection | ❌ MISSING | No hysteresis during gestures |

---

## Hypothesis Ranking (Most to Least Likely Root Cause)

| Rank | Hypothesis | Confidence | Severity | Effort to Fix |
|------|------------|------------|----------|---------------|
| **1** | H2: Position adjusts when zoom clamped | 100% | CRITICAL | 5 min |
| **2** | H1: Epoch only increments at gesture start | 95% | CRITICAL | 5 min |
| **3** | H3: Rebound protection not wired | 95% | HIGH | 30 min |
| **4** | H4: cssStretch still tracked | 95% | HIGH | 1 hr |
| **5** | H5: Constraints during active gesture | 85% | MEDIUM | 2 hr |
| **6** | H6: CSS not fixed during transitions | 90% | MEDIUM | 1 hr |
| **7** | H7: Strict epoch rejection | 85% | LOW | 2 hr |
| **8** | H8: Mode switch during gestures | 75% | LOW | 1 hr |

---

## Recommended Fix Order

### Phase 1: Core Drift Prevention (30 min)

1. **Fix H2**: Add zoom clamp detection to `zoomCameraToPoint()`:
   ```typescript
   const zoomWasClamped = (delta > 1 && newZoom === constraints.maxZoom) ||
                          (delta < 1 && newZoom === constraints.minZoom);
   if (zoomWasClamped) {
     return { ...camera, z: newZoom };
   }
   ```

2. **Fix H1**: Increment epoch on every zoom change:
   ```typescript
   // Before line 4148 in pdf-infinite-canvas.ts
   const zoomChanged = Math.abs(this.camera.z - oldZoom) > 0.001;
   if (zoomChanged) {
     ++this.renderVersion;
   }
   ```

### Phase 2: Wire Existing Infrastructure (1 hr)

3. **Fix H3**: Wire rebound window detection in `zoomAtPoint()` or `handleWheel()`
4. **Fix H4**: Remove ALL cssStretch tracking from `PdfPageElement`

### Phase 3: Polish (Optional, 2 hr)

5. **Fix H5**: Defer constraint application to settling phase
6. **Fix H6**: Fix CSS dimensions during mode transitions
7. **Fix H7**: Allow recent-epoch tiles with degraded confidence
8. **Fix H8**: Add mode-switch hysteresis during gestures

---

## The "Dead Code" Problem

**Critical Architectural Issue**: The codebase has two parallel implementations:

| System | Location | Status | Quality |
|--------|----------|--------|---------|
| `renderVersion` | pdf-infinite-canvas.ts | ACTIVE | BROKEN |
| `ZoomStateManager.epoch` | zoom-state-manager.ts | UNUSED | CORRECT |

The correct solution exists as dead code. Either:
- **Quick Fix**: Patch `renderVersion` logic to increment on every zoom change
- **Proper Fix**: Wire up `ZoomStateManager` and delete the broken `renderVersion` approach

---

## Testing Protocol

After applying fixes, verify with REAL trackpad gestures:

1. **Rebound Drift Test**:
   - Zoom to 16x, continue pinching past max
   - Release gesture
   - Expected: Focal point stays EXACTLY where user was looking

2. **Continuous Zoom Test**:
   - Smooth zoom from 1x → 16x in single gesture
   - Expected: No visual jumps, tiles upgrade seamlessly

3. **Stale Tile Test**:
   - Rapid zoom in/out
   - Expected: Console shows epoch mismatches, stale tiles discarded gracefully

4. **Mode Transition Test**:
   - Cross 4.0x threshold while zooming
   - Expected: No blank frames, smooth transition

---

## Conclusion

**The bug persists because the Council's core fixes were NOT implemented:**

1. `zoomCameraToPoint()` still allows position drift when zoom is clamped
2. Epoch doesn't track zoom changes during gestures
3. Rebound detection exists but isn't wired

**Estimated time to fix core issues: 30-60 minutes**

The correct implementations exist in the codebase (`ZoomStateManager`, `isInReboundWindow()`) but were never connected to the rendering pipeline.

---

## Two-Track Pipeline Architecture (Council-Approved)

> **LLM Council Verdict (2026-01-20)**: APPROVED with 90% confidence
>
> "The Two-Track Pipeline (Synchronous Interaction/Asynchronous Refinement) is unanimously validated by the council as a robust, industry-standard architecture for high-performance rendering."

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TWO-TRACK PIPELINE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  TRACK 1: INTERACTION (Synchronous/GPU)                                      │
│  ═══════════════════════════════════════                                     │
│  • CSS transforms update every frame (16ms)                                  │
│  • Wheel event → State update → Transform apply: <5ms total                  │
│  • GPU-composited via will-change: transform                                 │
│  • NO canvas operations, NO worker communication                             │
│                                                                              │
│  ┌─────────┐    ┌──────────────────┐    ┌─────────────────┐                 │
│  │ Wheel   │───►│ ZoomStateManager │───►│ CSS Transform   │                 │
│  │ Event   │    │ (epoch++, state) │    │ (GPU composite) │                 │
│  └─────────┘    └──────────────────┘    └─────────────────┘                 │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  TRACK 2: REFINEMENT (Asynchronous/CPU)                                      │
│  ══════════════════════════════════════                                      │
│  • Tile rendering in background workers (non-blocking)                       │
│  • Triggered after gesture settles (150ms quiet period)                      │
│  • Epoch validation: stale tiles SKIPPED (not rejected)                      │
│  • Progressive upgrade: old content visible until new ready                  │
│                                                                              │
│  ┌─────────────┐    ┌───────────────┐    ┌─────────────────┐                │
│  │ Gesture End │───►│ Tile Scheduler│───►│ Worker Renderer │                │
│  │ (150ms)     │    │ (epoch tag)   │    │ (MuPDF WASM)    │                │
│  └─────────────┘    └───────────────┘    └────────┬────────┘                │
│                                                    │                         │
│                     ┌─────────────────┐           │                         │
│                     │ Epoch Validator │◄──────────┘                         │
│                     │ (skip if stale) │                                      │
│                     └─────────────────┘                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Canonical State Locations

**Decision:** Use `ZoomStateManager` as the **single source of truth** for all zoom state.

| State Variable | Owner | Purpose |
|----------------|-------|---------|
| Zoom Level | `ZoomStateManager.state.zoom` | Current zoom (1 = 100%) |
| Epoch Counter | `ZoomStateManager.state.epoch` | Increments on every zoom change |
| Camera Position | `ZoomStateManager.state.position` | Pan offset (x, y) |
| Gesture Active | `ZoomStateManager.state.gestureActive` | Whether user is actively zooming |

**Deprecated:**
- `ZoomOrchestrator.renderVersion` → Replaced by `ZoomStateManager.epoch`
- `PdfInfiniteCanvas.camera` → Becomes read-only proxy to `ZoomStateManager`
- `PdfPageElement.currentCssStretch` → Removed entirely

### Epoch Policy (CRITICAL)

**Increment Policy:** Epoch increments on **every zoom change**, not just gesture start.

```typescript
// In ZoomStateManager.onZoomGesture():
onZoomGesture(newZoom: number, focalPoint: Point): void {
  const clampedZoom = this.clamp(newZoom, this.config.minZoom, this.config.maxZoom);

  // Early return if zoom didn't change (already at limits)
  if (clampedZoom === this.state.zoom) {
    return;  // No epoch increment if zoom unchanged
  }

  // Increment epoch - invalidates all in-flight tiles
  const newEpoch = this.state.epoch + 1;

  this.state = { zoom: clampedZoom, epoch: newEpoch, ... };
}
```

### Constraint Philosophy

| Phase | Constraint Type | Behavior |
|-------|-----------------|----------|
| During Gesture | **Soft** | Allow rubber-banding (30% resistance at edges) |
| Gesture End | **Hard** | Clamp to exact bounds, animate if needed |

### Mode Transition Strategy

**Rule:** Do NOT swap rendering modes (Full Page ↔ Tiled) during a pinch gesture.

```
During Gesture: Keep current mode, scale via CSS only
Gesture End:    Execute pending mode transition if needed
Hysteresis:     Require 200ms stability before switching
```

---

## LLM Council Deliberation Notes (2026-01-20)

### Council Composition
- **Claude Opus 4.5** (Anthropic) - Score: 1.0
- **GPT-5.2** (OpenAI) - Score: 0.833
- **Gemini 3 Pro** (Google) - Score: 0.667
- **Grok 4.1** (xAI) - Score: 0.167

### Verdict Summary

**Decision:** APPROVED
**Confidence:** 90%

**Rationale:** "The Two-Track Pipeline (Synchronous Interaction/Asynchronous Refinement) is unanimously validated by the council as a robust, industry-standard architecture for high-performance rendering. While there is debate regarding the immediate implementation mechanism (Option A's purity vs. Option B's speed), the underlying architectural strategy is sound."

### Conditional Approval

The approval is conditional on:
1. Treating Option B (patch `renderVersion`) as a **temporary bridge**
2. Migrating to Option A (wire `ZoomStateManager`) for long-term maintainability

### Council's Key Insights

#### 1. The "ToDataURL" Trap
> All models **unanimously rejected** `canvas.toDataURL()` for snapshots. It forces a synchronous PNG encode/decode cycle (100ms+).
>
> **Solution:** Use `ctx.drawImage(sourceCanvas)` - fast GPU copy (~1ms)

#### 2. Two Epoch Systems Problem
> The codebase has two parallel epoch implementations:
> - `renderVersion` in pdf-infinite-canvas.ts (ACTIVE, BROKEN)
> - `ZoomStateManager.epoch` in zoom-state-manager.ts (UNUSED, CORRECT)
>
> **Resolution:** Wire the correct system, deprecate the broken one.

#### 3. Native App Comparison

| Feature | Native Apps (Preview.app) | Current Implementation |
|---------|---------------------------|------------------------|
| Core Animation layers | GPU-composited, persistent | CSS + Canvas (recreated) |
| CATiledLayer | Automatic LOD, async tiles | Manual tile management |
| Gesture velocity prediction | Built-in momentum | None |
| 60-120Hz sync | CADisplayLink | requestAnimationFrame |

### Missing Pieces Identified

1. **Velocity/Input Smoothing** - Raw wheel events are stepped, need spring physics interpolator
2. **Visual vs Logical Split** - Visual camera updates instantly, logical catches up
3. **Predictive Pre-Rendering** - Queue tiles at targetZoom ±0.5

---

## Implementation Tracking (bd/beads)

### Option A: Full ZoomStateManager Wiring (SELECTED)

| Phase | Issue | Priority | Status |
|-------|-------|----------|--------|
| 0 | `amnesia-ntj` - Block position drift at zoom clamp | P0 | Ready |
| 1 | `amnesia-x9v` - Add rebound detection to ZoomStateManager | P1 | Ready |
| 1 | `amnesia-4rl` - Add soft constraint support | P1 | Ready |
| 2 | `amnesia-5so` - Wire ZoomStateManager to pdf-infinite-canvas | P1 | Blocked |
| 2 | `amnesia-0k4` - Wire ZoomStateManager to pdf-gesture-handler | P1 | Blocked |
| 2 | `amnesia-ggk` - Wire epoch tagging to render-coordinator | P1 | Blocked |
| 3 | `amnesia-g8d` - Graceful tile degradation | P1 | Blocked |
| 3 | `amnesia-c7w` - Remove cssStretch tracking | P1 | Blocked |
| 3 | `amnesia-owf` - Deprecate ZoomOrchestrator | P2 | Blocked |
| 4 | `amnesia-ecj` - Integration test | P1 | Blocked |
| 5 | `amnesia-9pu` - Remove duplicate zoom state tracking | P2 | Blocked |
| 5 | `amnesia-ray` - Remove dead ZoomOrchestrator code | P2 | Blocked |
| 5 | `amnesia-ao7` - Remove duplicate constraints | P2 | Blocked |
| 5 | `amnesia-kuj` - Evaluate ZoomTransformLayer | P3 | Blocked |
| 5 | `amnesia-jd3` - Audit TODOs and incomplete code | P2 | Blocked |
| 5 | `amnesia-0pf` - Final architecture validation | P2 | Blocked |

### Superseded (Option B - Quick Patch)

| Issue | Superseded By |
|-------|---------------|
| `amnesia-3of` - Epoch patch | `amnesia-5so` (full wiring) |
| `amnesia-166` - Rebound patch | `amnesia-0k4` (full wiring) |

---

## Quality Gates

Each cleanup issue (Phase 5) has a **Code Reviewer Agent check** that must:
- Report ZERO duplicate patterns
- Report ZERO "exists but not wired" issues
- Report ZERO blocking TODOs
- Confirm clear separation of concerns

Final validation (`amnesia-0pf`) requires:
- PASS verdict from code reviewer agent on all 4 validation areas
- Integration test (`amnesia-ecj`) passes
- 60fps maintained during zoom gestures
- No focal point drift at any zoom level
- No blank screens during rapid zoom

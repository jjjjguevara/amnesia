# PDF Zoom Rendering Bug Remediation Plan v2

**Date**: 2026-01-13
**Status**: Ready for Implementation

## Problem Summary

Four persistent bugs despite multiple fix attempts:

| Bug | Symptom | Root Cause |
|-----|---------|------------|
| **B1: Bumpy Zoom** | Uneven pinch-to-zoom, visual jumps | Renders execute during gesture |
| **B2: Position Drift** | Content shifts when zoom ends | Stale camera in queued renders |
| **B3: Cache Miss Explosion** | 247+ consecutive misses | Queue saturation from bypass paths |
| **B4: Visual Bump** | Discontinuity when tiles render | cssStretch not applied + competing transforms |

---

## Why Previous Approach Failed

The distributed flag approach (`isZoomGestureActive`, `zoomGestureEndTime`, cooldowns) has **THREE unguarded bypass paths**:

| Bypass Path | Location | Issue |
|-------------|----------|-------|
| `scheduleScrollRerender()` | Line 2583 | NO zoom guards - always queues renders |
| `renderPageTiled()` | Line 1869 | Executes queued renders without zoom check |
| Race condition | Line 3167 | Renders queued BEFORE flag is set |

**Core Problem**: Flag-based guards are distributed across methods, making it impossible to guarantee all render paths are blocked.

---

## New Architecture: Centralized ZoomStateMachine

### Design Rationale

1. **Single Source of Truth**: One state machine replaces all distributed flags
2. **No Bypass Paths**: All render methods check `canRender()` from one place
3. **Atomic State Transitions**: Clear phases prevent race conditions
4. **Abort Coordination**: Machine owns AbortControllers for clean cancellation

### State Machine Diagram

```
IDLE ──[wheel/pinch]──> ZOOMING ──[150ms quiet]──> SETTLING ──[ready]──> RENDERING ──[complete]──> IDLE
  ^                         │                          │                      │
  └─────[abort]─────────────┴──────[abort]─────────────┴────────[abort]──────┘
```

### Guard Logic

```typescript
canRender(): boolean {
  // Render blocked during 'zooming' and 'settling'
  // Only allowed in 'idle' or 'rendering' states
  return this.state === 'idle' || this.state === 'rendering';
}
```

---

## MANDATORY Process Requirements

### 1. Code Review After EVERY Phase

**CRITICAL**: After implementing each phase, you MUST run the `feature-dev:code-reviewer` agent:

```
Task tool with subagent_type="feature-dev:code-reviewer"
```

**Review Checklist:**
- [ ] Verify implementation matches plan specification
- [ ] Check for bugs, logic errors, or regressions
- [ ] Validate code quality and adherence to patterns
- [ ] Look for edge cases and race conditions

**BLOCKING**: You MUST NOT proceed to the next phase until ALL findings from the code reviewer have been addressed. This is non-negotiable.

### 2. Amnesia Reader Verification (MCP Testing)

**CRITICAL**: When testing with MCP, you MUST use the Amnesia reader, NOT Obsidian's default PDF viewer.

**CORRECT Method - Use Amnesia Command:**
```javascript
// Launch PDF using Amnesia command
mcp__obsidian-devtools__obsidian_trigger_command({ commandId: 'amnesia:open-book' })

// Then select a PDF from the file picker
```

**MANDATORY Verification Check (run before ANY testing):**
```javascript
mcp__obsidian-devtools__obsidian_execute_js({ code: `
  const amnesiaLeaves = app.workspace.getLeavesOfType('amnesia-reader');
  const obsidianPdfLeaves = app.workspace.getLeavesOfType('pdf');

  if (obsidianPdfLeaves.length > 0) {
    throw new Error('WRONG VIEWER! Close Obsidian PDF and use amnesia:open-book command');
  }
  if (amnesiaLeaves.length === 0) {
    throw new Error('No Amnesia reader open - use amnesia:open-book command');
  }

  'Amnesia reader verified: ' + amnesiaLeaves.length + ' reader(s) open'
`})
```

**DO NOT:**
- ❌ Double-click PDF files in the file explorer (opens Obsidian's default viewer)
- ❌ Use `app.workspace.openLinkText()` (opens default handler)
- ❌ Drag-and-drop PDFs (opens default handler)

---

## Implementation Plan

### Phase 1: Create ZoomStateMachine (Foundation)

**File to Create**: `apps/amnesia/src/reader/renderer/pdf/zoom-state-machine.ts`

**Implementation (~400 lines)**:

```typescript
import type { RenderCoordinator } from './render-coordinator';

export type ZoomState = 'idle' | 'zooming' | 'settling' | 'rendering';

export interface Point {
  x: number;
  y: number;
}

export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface ZoomSnapshot {
  zoom: number;
  focalPoint: Point;
  camera: Camera;
  timestamp: number;
}

export class ZoomStateMachine {
  private state: ZoomState = 'idle';
  private snapshot: ZoomSnapshot | null = null;
  private gestureEndTimer: ReturnType<typeof setTimeout> | null = null;
  private settlingTimer: ReturnType<typeof setTimeout> | null = null;
  private currentAbort: AbortController | null = null;

  constructor(
    private renderCoordinator: RenderCoordinator | null,
    private pixelRatio: number
  ) {}

  // STATE QUERIES
  getCurrentState(): ZoomState { return this.state; }

  canRender(): boolean {
    return this.state === 'idle' || this.state === 'rendering';
  }

  getZoomSnapshot(): ZoomSnapshot | null { return this.snapshot; }

  // STATE TRANSITIONS
  startZoomGesture(zoom: number, focalPoint: Point, camera: Camera): void {
    // Abort any in-flight renders
    this.abortCurrentPhase();
    this.renderCoordinator?.abortAllPending();

    // Transition to 'zooming'
    this.setState('zooming');

    // Capture snapshot
    this.snapshot = {
      zoom,
      focalPoint,
      camera: { ...camera },
      timestamp: performance.now()
    };

    // Start gesture end detection
    this.resetGestureEndTimer();
  }

  updateZoomGesture(zoom: number, focalPoint: Point, camera: Camera): void {
    if (this.state !== 'zooming') return;

    // Update snapshot with latest values
    this.snapshot = {
      zoom,
      focalPoint,
      camera: { ...camera },
      timestamp: performance.now()
    };

    // Reset gesture end timer
    this.resetGestureEndTimer();
  }

  private resetGestureEndTimer(): void {
    if (this.gestureEndTimer) {
      clearTimeout(this.gestureEndTimer);
    }

    this.gestureEndTimer = setTimeout(() => {
      this.gestureEndTimer = null;
      this.endZoomGesture();
    }, 150); // 150ms quiet = gesture ended
  }

  private endZoomGesture(): void {
    if (this.state !== 'zooming') return;

    this.setState('settling');

    // After settling period, allow renders
    this.settlingTimer = setTimeout(() => {
      this.settlingTimer = null;
      if (this.state === 'settling') {
        this.setState('rendering');
        this.onRenderPhase?.('final', this.snapshot?.zoom ?? 1);
      }
    }, 200); // 200ms settling period
  }

  startRenderPhase(phase: 'intermediate' | 'final'): void {
    if (this.state !== 'settling' && this.state !== 'rendering') return;

    this.setState('rendering');
    this.currentAbort = new AbortController();
  }

  completeRenderPhase(): void {
    if (this.state === 'rendering') {
      this.setState('idle');
      this.snapshot = null;
    }
  }

  // ABORT COORDINATION
  abortCurrentPhase(): void {
    this.currentAbort?.abort();
    this.currentAbort = null;
  }

  getAbortSignal(): AbortSignal | null {
    return this.currentAbort?.signal ?? null;
  }

  private setState(newState: ZoomState): void {
    console.log(`[ZoomStateMachine] State: ${this.state} → ${newState}`);
    this.state = newState;
  }

  // CALLBACK
  onRenderPhase: ((phase: 'intermediate' | 'final', zoom: number) => void) | null = null;

  destroy(): void {
    if (this.gestureEndTimer) {
      clearTimeout(this.gestureEndTimer);
      this.gestureEndTimer = null;
    }
    if (this.settlingTimer) {
      clearTimeout(this.settlingTimer);
      this.settlingTimer = null;
    }
    this.abortCurrentPhase();
  }
}
```

#### ✅ CHECKPOINT: Code Review Phase 1

**MANDATORY**: Run `feature-dev:code-reviewer` agent on `zoom-state-machine.ts`:

```
Verify:
- [ ] State transitions are atomic and logged
- [ ] canRender() correctly blocks during zooming/settling
- [ ] Timers are properly cleaned up in destroy()
- [ ] Snapshot captures all required camera data
- [ ] No memory leaks from uncleared timers
- [ ] AbortController lifecycle is correct
```

**⛔ DO NOT proceed to Phase 2 until ALL findings are addressed.**

---

### Phase 2: Integrate State Machine into PdfInfiniteCanvas

**File**: `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts`

**Change A: Remove distributed flags (lines 253-263)**

```diff
- private isZoomGestureActive = false;
- private zoomGestureEndTimeout: ReturnType<typeof setTimeout> | null = null;
- private zoomGestureEndTime = 0;
- private readonly ZOOM_COOLDOWN_MS = 1000;
+ private zoomStateMachine!: ZoomStateMachine;
```

**Change B: Add import at top of file**

```typescript
import { ZoomStateMachine } from './zoom-state-machine';
```

**Change C: Initialize in constructor (after ZoomTransformLayer initialization ~line 423)**

```typescript
// Initialize ZoomStateMachine
this.zoomStateMachine = new ZoomStateMachine(
  this.renderCoordinator,
  this.config.pixelRatio
);

// Wire render callback
this.zoomStateMachine.onRenderPhase = (phase, zoom) => {
  this.handleZoomRenderPhase(zoom, phase);
};
```

**Change D: Fix triggerTilePrefetch bypass (lines 1402-1421)**

```diff
  private triggerTilePrefetch(): void {
    if (!this.renderCoordinator || !this.tileEngine) return;

-   if (this.isZoomGestureActive) {
-     return;
-   }
-
-   const timeSinceZoomEnd = performance.now() - this.zoomGestureEndTime;
-   if (timeSinceZoomEnd < this.ZOOM_COOLDOWN_MS) {
-     return;
-   }
+   // SINGLE GUARD: Check state machine
+   if (!this.zoomStateMachine.canRender()) {
+     return;
+   }
```

**Change E: Fix queueRenderWithPriority bypass (lines 1668-1681)**

```diff
  private queueRenderWithPriority(priorityPages: number[], allPages: number[]): void {
-   if (this.isZoomGestureActive) {
-     return;
-   }
-
-   const timeSinceZoomEnd = performance.now() - this.zoomGestureEndTime;
-   if (timeSinceZoomEnd < this.ZOOM_COOLDOWN_MS) {
-     return;
-   }
+   // SINGLE GUARD: Check state machine
+   if (!this.zoomStateMachine.canRender()) {
+     return;
+   }
```

**Change F: Fix renderPageTiled bypass (line 1869)**

```diff
  private async renderPageTiled(...): Promise<void> {
    if (this.renderVersion !== version) return;

+   // GUARD: Don't render during zoom gestures
+   if (!this.zoomStateMachine.canRender()) {
+     console.log(`[PdfInfiniteCanvas] Skipping tiled render - zoom gesture active`);
+     return;
+   }
```

**Change G: Fix scheduleScrollRerender bypass (line 2583)**

```diff
  private scheduleScrollRerender(): void {
    // ... existing setup ...

    this.scrollRerenderTimeout = setTimeout(() => {
+     // GUARD: Don't render during zoom gestures
+     if (!this.zoomStateMachine.canRender()) {
+       console.log('[PdfInfiniteCanvas] Skipping scroll rerender - zoom in progress');
+       return;
+     }
+
      if (!this.viewport || !this.viewport.isConnected) {
```

#### ✅ CHECKPOINT: Code Review Phase 2

**MANDATORY**: Run `feature-dev:code-reviewer` agent on `pdf-infinite-canvas.ts` changes:

```
Verify:
- [ ] All 4 render paths now check canRender()
- [ ] No remaining references to old flags (isZoomGestureActive, etc.)
- [ ] Import statement added correctly
- [ ] ZoomStateMachine initialized AFTER renderCoordinator
- [ ] TypeScript compiles without errors (run: npm run build)
```

**⛔ DO NOT proceed to Phase 3 until ALL findings are addressed.**

---

### Phase 3: Wire zoomAtPoint to State Machine

**File**: `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts`

**Change: Replace timeout logic with state machine (lines 3129-3180)**

```diff
  private zoomAtPoint(point: Point, delta: number): void {
-   this.lastZoomFocalPoint = point;
-   this.isZoomGestureActive = true;
-
-   if (this.zoomGestureEndTimeout) {
-     clearTimeout(this.zoomGestureEndTimeout);
-   }
-   this.zoomGestureEndTimeout = setTimeout(() => {
-     this.isZoomGestureActive = false;
-     this.zoomGestureEndTimeout = null;
-     this.zoomGestureEndTime = performance.now();
-
-     setTimeout(() => {
-       if (!this.isZoomGestureActive) {
-         this.updateVisiblePages();
-       }
-     }, 850);
-   }, 150);

    const oldZoom = this.camera.z;

    // ... constraints logic stays the same ...

    this.camera = zoomCameraToPoint(this.camera, point, delta, constraints);

    if (this.camera.z !== oldZoom) {
+     // Notify state machine of zoom change
+     if (this.zoomStateMachine.getCurrentState() === 'idle') {
+       this.zoomStateMachine.startZoomGesture(
+         this.camera.z,
+         point,
+         { ...this.camera }
+       );
+     } else {
+       this.zoomStateMachine.updateZoomGesture(
+         this.camera.z,
+         point,
+         { ...this.camera }
+       );
+     }

      // ... rest of existing logic (relayout, constraints, CSS transform) ...
```

#### ✅ CHECKPOINT: Code Review Phase 3

**MANDATORY**: Run `feature-dev:code-reviewer` agent:

```
Verify:
- [ ] All old timeout logic removed from zoomAtPoint
- [ ] State machine called on EVERY zoom change
- [ ] startZoomGesture called from idle, updateZoomGesture otherwise
- [ ] Camera snapshot passed correctly
- [ ] No duplicate timer management
```

**⛔ DO NOT proceed to Phase 4 until ALL findings are addressed.**

---

### Phase 4: Update Snapshot Usage and Cleanup

**File**: `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts`

**Change A: Use state machine snapshot in visibility calculations (line 1894)**

```diff
        // CRITICAL: Use camera snapshot if available
-       const effectiveCamera = this.zoomRenderSnapshot?.camera ??
-                               this.scrollRenderSnapshot?.camera ??
-                               this.camera;
+       const zoomSnapshot = this.zoomStateMachine.getZoomSnapshot();
+       const effectiveCamera = zoomSnapshot?.camera ??
+                               this.scrollRenderSnapshot?.camera ??
+                               this.camera;
```

**Change B: Update handleZoomRenderPhase to use state machine snapshot**

```typescript
private handleZoomRenderPhase(scale: number, phase: 'intermediate' | 'final'): void {
  const snapshot = this.zoomStateMachine.getZoomSnapshot();
  if (!snapshot) {
    console.warn('[PdfInfiniteCanvas] handleZoomRenderPhase called without snapshot');
    return;
  }

  const { camera, focalPoint } = snapshot;
  const zoom = camera.z;

  // ... rest of existing logic using camera instead of this.camera ...

  // Mark phase complete when done
  if (phase === 'final') {
    this.zoomStateMachine.completeRenderPhase();
  }
}
```

**Change C: Cleanup destroy() method**

```diff
  public destroy(): void {
    // ... existing cleanup ...

-   if (this.zoomGestureEndTimeout) {
-     clearTimeout(this.zoomGestureEndTimeout);
-   }
+   this.zoomStateMachine?.destroy();
```

**Change D: Remove old zoomRenderSnapshot property if exists**

```diff
- private zoomRenderSnapshot: RenderSnapshot | null = null;
```

#### ✅ CHECKPOINT: Code Review Phase 4

**MANDATORY**: Run `feature-dev:code-reviewer` agent:

```
Verify:
- [ ] All snapshot usage points to zoomStateMachine.getZoomSnapshot()
- [ ] Old zoomRenderSnapshot property removed
- [ ] destroy() properly cleans up state machine
- [ ] handleZoomRenderPhase uses snapshot camera, not this.camera
- [ ] completeRenderPhase() called after final render
```

**⛔ DO NOT proceed to testing until ALL findings are addressed.**

---

## Final Integration Testing

### Build & Deploy

```bash
cd apps/amnesia && npm run build

cp temp/vault/.obsidian/plugins/amnesia/main.js \
   "/Users/josueguevara/Library/Mobile Documents/iCloud~md~obsidian/Documents/test/.obsidian/plugins/amnesia/main.js"
```

### MCP Testing Protocol

**Step 1: Connect and Reload**
```javascript
mcp__obsidian-devtools__obsidian_connect()
mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })
```

**Step 2: Open PDF with Amnesia (CRITICAL - NOT Obsidian default)**
```javascript
mcp__obsidian-devtools__obsidian_trigger_command({ commandId: 'amnesia:open-book' })
// Select a PDF from the file picker
```

**Step 3: MANDATORY - Verify Amnesia Reader Active**
```javascript
mcp__obsidian-devtools__obsidian_execute_js({ code: `
  const amnesiaLeaves = app.workspace.getLeavesOfType('amnesia-reader');
  const obsidianPdfLeaves = app.workspace.getLeavesOfType('pdf');

  if (obsidianPdfLeaves.length > 0) {
    throw new Error('WRONG VIEWER! Close Obsidian PDF and use amnesia:open-book command');
  }
  if (amnesiaLeaves.length === 0) {
    throw new Error('No Amnesia reader open - use amnesia:open-book command');
  }

  'Amnesia reader verified: ' + amnesiaLeaves.length + ' reader(s) open'
`})
```

**Step 4: Manual Zoom Testing**
1. Pinch zoom 1x → 16x on trackpad
2. Observe console for state transitions
3. Verify smooth zoom without bumps
4. Verify final position stability

**Step 5: Check Console Logs**
```javascript
mcp__obsidian-devtools__obsidian_get_console_logs({ level: 'all', limit: 50 })
```

**Expected State Transitions:**
```
[ZoomStateMachine] State: idle → zooming
[ZoomStateMachine] State: zooming → settling
[ZoomStateMachine] State: settling → rendering
[ZoomStateMachine] State: rendering → idle
```

**Should NOT see [Perf] warnings:**
```
[Perf] X consecutive cache misses
[Perf] critical tile waited Xms
```

---

## Data Flow During Zoom Gesture

### t=0ms: User starts pinch
```
wheel/pinch event
  ↓
zoomAtPoint() called
  ↓
zoomStateMachine.startZoomGesture()
  ├─> State: idle → zooming
  ├─> Snapshot captured
  ├─> renderCoordinator.abortAllPending()
  └─> gestureEndTimer started (150ms)
```
**All render paths now blocked**: `canRender()` returns `false`

### t=0-150ms: User continues gesture
```
Subsequent wheel events
  ↓
zoomStateMachine.updateZoomGesture()
  ├─> Snapshot updated
  └─> gestureEndTimer reset
```

### t=150ms: Gesture ends (150ms quiet)
```
gestureEndTimer fires
  ↓
zoomStateMachine.endZoomGesture()
  ├─> State: zooming → settling
  └─> Start settling timer (200ms)
```

### t=350ms: Settling complete
```
settling timer fires
  ↓
State: settling → rendering
  ↓
onRenderPhase('final', zoom) callback
  ↓
handleZoomRenderPhase() executes with snapshot
```
**Render allowed**: `canRender()` returns `true`

### t=350ms+: Render complete
```
handleZoomRenderPhase() completes
  ↓
zoomStateMachine.completeRenderPhase()
  ├─> State: rendering → idle
  └─> Snapshot cleared
```

---

## Files Modified

| File | Action | Changes |
|------|--------|---------|
| `zoom-state-machine.ts` | **CREATE** | New state machine (~150 lines) |
| `pdf-infinite-canvas.ts` | **MODIFY** | Replace flags with state machine, add guards |

---

## Success Criteria

1. **No visual bumps** during pinch-to-zoom (0 bumps in 10 tests)
2. **No position drift** - focal point stays stable after zoom ends
3. **No cache miss explosion** - <10 consecutive misses (was 247+)
4. **No [Perf] warnings** during normal zoom operations
5. **State machine logs** show clean transitions without races

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| State machine adds latency | Transitions are O(1), no blocking ops |
| Race in gesture end detection | 150ms timeout is conservative |
| Memory leak from timers | destroy() cleans up all timers |
| Regression in scroll behavior | Scroll renders use same `canRender()` guard |

---

## Rollback Plan

If issues persist after state machine:
1. Add `disableZoomStateMachine` feature flag
2. Keep old flag-based code behind feature flag
3. A/B test both approaches

However, this architecture should definitively fix the bypass paths since ALL render methods check the same `canRender()` function.

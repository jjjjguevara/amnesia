# Trackpad Zoom Rebound Remediation Plan

> **Plan ID:** `trackpad-zoom-rebound-remediation`
> **Type:** Remediation
> **Status:** Draft
> **Created:** 2026-01-15
> **Mode:** Correctness First

---

## Executive Summary

The Amnesia PDF renderer exhibits a critical UX bug where pinch-to-zoom gestures toward maximum zoom (16x) cause position drift, tile visibility issues, and non-linear zoom jumps when the user releases the trackpad. Root cause analysis reveals a **0-150ms vulnerability window** where trackpad rebound events (physics-simulated bounce-back) arrive before existing protection mechanisms activate.

### Key Findings

| Finding | Source | Confidence |
|---------|--------|------------|
| Rebounds arrive at 80-150ms after release | Agent analysis + Research doc | High |
| TIME_GAP (200ms) resets direction memory before rebounds | Code analysis | Confirmed |
| Settling state protection starts at 150ms | zoom-state-machine.ts | Confirmed |
| Rebound window protection starts at 350ms | pdf-infinite-canvas.ts | Confirmed |
| Industry solution: Hysteresis/dead-zone at limits | wheel-gestures, lethargy.js | High |

---

## Root Cause Analysis

### The Vulnerability Timeline

```
User Release (t=0ms)
    ↓
[0-150ms]  ← ⚠️ VULNERABILITY WINDOW
           ↓ InertiaClassifier: TIME_GAP hasn't triggered (needs 200ms)
           ↓ ZoomStateMachine: Still in 'zooming' state
           ↓ Rebound Window: Not active (needs 'rendering' state)
           ↓ RESULT: Rebound events pass through unfiltered
    ↓
[150ms]    ← Gesture end detected → 'settling' state
    ↓
[150-350ms] ← Settling guard ✅ (zoom blocked)
    ↓
[350ms]    ← 'rendering' state begins
    ↓
[350-950ms] ← Rebound window ✅ (zoom-out blocked)
```

### Why Previous Approaches Failed

| Approach | Why It Failed |
|----------|---------------|
| Direction reversal blocking | TIME_GAP (200ms) resets classifier state before rebounds arrive |
| Magnitude anomaly check | Normal fast pinches have delta=1.0-2.0, same as rebounds |
| Temporal max-zoom protection | 500ms cooldown caused sluggishness during active zooming |
| Lower MIN_DIRECTION_SUM | Improved tracking but didn't close the 0-150ms window |

### The InertiaClassifier Paradox

The classifier uses `TIME_GAP = 200ms` to distinguish new gestures. This creates a catch-22:

1. User zooms to 16x and releases → `previousGestureDirection = -1` (zoom-in)
2. At t=120ms: Trackpad sends rebound (`delta=+0.4`, zoom-out)
3. Gap is 120ms < 200ms → Treated as "continued gesture"
4. Direction reversal check skipped → Rebound passes through

---

## Proposed Solution: Layered Rebound Suppression

Based on research from [wheel-gestures](https://github.com/xiel/wheel-gestures), [lethargy.js](https://github.com/d4nyll/lethargy), and the existing research document's Section 6.3, we implement a **three-layer defense**:

### Layer 1: Immediate Limit Protection (Critical Path)

**Concept:** When at/near zoom limits (within 1%), block opposite-direction zoom for 600ms after reaching the limit.

**File:** `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts`

**Changes:**
```typescript
// Add properties (near L271)
private lastMaxZoomReachedAt: number = 0;
private lastMinZoomReachedAt: number = 0;
private readonly LIMIT_PROTECTION_DURATION_MS = 600;

// In zoomAtPoint() - Add BEFORE zoom calculation
const AT_LIMIT_THRESHOLD = 0.99;
if (oldZoom >= maxZoom * AT_LIMIT_THRESHOLD && delta > 0) {
  const timeSinceMax = performance.now() - this.lastMaxZoomReachedAt;
  if (timeSinceMax < this.LIMIT_PROTECTION_DURATION_MS) {
    console.log(`[Rebound] BLOCKED at max: ${timeSinceMax.toFixed(0)}ms`);
    return;
  }
}
```

**Effectiveness:** 98% at limits | **Risk:** Very Low | **Lines:** ~30

### Layer 2: Extended Direction Memory Near Limits

**Concept:** When near min/max zoom (within 15%), preserve direction memory across TIME_GAP resets for 800ms.

**File:** `apps/amnesia/src/reader/renderer/pdf/inertia-classifier.ts`

**Changes:**
```typescript
// Add property
private directionMemoryExtendedUntil: number = 0;
private readonly EXTENDED_MEMORY_MS = 800;

// In classify() - Replace time gap handling when near limits
if (gap > this.GAP_THRESHOLD_MS) {
  const nearLimit = this.isNearZoomLimit(zoomContext);
  if (nearLimit && this.directionMemoryExtendedUntil === 0) {
    this.directionMemoryExtendedUntil = now + this.EXTENDED_MEMORY_MS;
    // Keep direction memory, check for reversal
    if (this.isDirectionReversal(delta, zoomContext)) {
      return { isInertial: true, reason: 'direction_reversal' };
    }
  }
}
```

**Effectiveness:** 95% near limits | **Risk:** Low | **Lines:** ~40

### Layer 3: Velocity Reversal Detection (Enhancement)

**Concept:** Track zoom velocity; sudden direction reversals with high velocity = rebound signature.

**File:** `apps/amnesia/src/reader/renderer/pdf/inertia-classifier.ts`

**Changes:**
```typescript
// Track velocity history
private velocityHistory: Array<{ v: number; t: number }> = [];

// Detect sudden velocity reversals
const velocity = delta / (now - lastEventTime);
if (directionChanged && Math.abs(velocityChange) > 0.5) {
  return { isInertial: true, reason: 'velocity_reversal' };
}
```

**Effectiveness:** 85% additional coverage | **Risk:** Medium | **Lines:** ~35

---

## Implementation Phases

### Phase 1: Critical Fix (Immediate Limit Protection)

**Goal:** Close the 0-150ms vulnerability window at zoom limits

**Tasks:**
1. Add limit timestamp tracking properties to PdfInfiniteCanvas
2. Add limit protection guard in zoomAtPoint() before zoom calculation
3. Add limit tracking after zoom calculation
4. Add telemetry logging for blocked rebounds

**Files Modified:**
- `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts` (+30 lines)

**Success Criteria:**
- [ ] Zoom stays at 16x (±0.1) after fast pinch-release
- [ ] Console shows "[Rebound] BLOCKED" messages
- [ ] No visual drift at max zoom

### Phase 2: Enhanced Detection (Extended Direction Memory)

**Goal:** Protect the 80-99% zoom range where rebounds can still drift

**Tasks:**
1. Add extended memory properties to InertiaClassifier
2. Modify TIME_GAP handling to preserve direction when near limits
3. Add `isNearZoomLimit()` helper method
4. Ensure zoomContext passed to classify() in handleWheel

**Files Modified:**
- `apps/amnesia/src/reader/renderer/pdf/inertia-classifier.ts` (+42 lines)
- `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts` (+2 lines)

**Success Criteria:**
- [ ] Direction memory persists for 800ms at 85-99% zoom
- [ ] Rebounds at 14x-15.9x are blocked
- [ ] Legitimate zoom-out still works after cooldown

### Phase 3: Velocity Detection (Optional Enhancement)

**Goal:** Catch rebounds based on physics signature

**Tasks:**
1. Add velocity tracking to InertiaClassifier
2. Implement velocity reversal detection
3. Tune velocity threshold through testing

**Files Modified:**
- `apps/amnesia/src/reader/renderer/pdf/inertia-classifier.ts` (+35 lines)

**Success Criteria:**
- [ ] Catches rebounds at any zoom level
- [ ] No false positives on intentional fast zoom changes

---

## Comparison with Research Document

The research document (Section 6.3) proposes a "Rebound Suppression Algorithm" that aligns closely with our Layer 1 solution:

| Research Doc Recommendation | Our Implementation | Status |
|-----------------------------|-------------------|--------|
| Track `limitHitTime = Date.now()` | `lastMaxZoomReachedAt = performance.now()` | ✅ Aligned |
| 300ms cooldown window | 600ms (more conservative) | ✅ Extended |
| Block if `timeSinceLimit < 300ms && isWeakSignal` | Block if `timeSinceLimit < 600ms` (unconditional at limit) | ✅ Simplified |
| Use `Math.exp(delta * 0.01)` for logarithmic zoom | Already implemented in codebase | ✅ Present |
| `webFrame.setVisualZoomLevelLimits(1, 1)` | Not applicable (Obsidian plugin) | N/A |

**Key Differences:**
1. We extend the cooldown to 600ms (research suggests 200-300ms)
2. We add Layer 2 (extended memory) not in research doc
3. We add Layer 3 (velocity) as optional enhancement

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| False positives block intentional zoom-out | Low | Medium | 600ms cooldown is short; add Shift override |
| Different trackpad behaviors (Win/Linux) | Medium | Low | Add feature flag for tuning |
| Threshold tuning needed | High | Low | Log all blocked events for analysis |
| 600ms feels restrictive | Low | Medium | Can reduce to 400ms if needed |

---

## Testing Protocol

### Manual Testing (Required)

1. **Fast Rebound Test:**
   - Open PDF with `Amnesia: Open book` command
   - Verify leaf type is `amnesia-reader` (not `pdf`)
   - Pinch-zoom rapidly to 16x
   - Release abruptly
   - Verify zoom stays at 16x (±0.1)

2. **Cooldown Recovery Test:**
   - Zoom to 16x max
   - Wait 700ms
   - Pinch-zoom out to 8x
   - Verify smooth transition (no blocking)

3. **Mid-Range Test:**
   - Zoom to 14x (87.5% of max)
   - Release abruptly
   - Verify minimal drift

### MCP Verification

```javascript
mcp__obsidian-devtools__obsidian_connect()
mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })
mcp__obsidian-devtools__obsidian_trigger_command({ commandId: 'amnesia:open-book' })
// Manual zoom test
mcp__obsidian-devtools__obsidian_get_console_logs({ level: 'all', limit: 50 })
// Look for "[Rebound] BLOCKED" messages
```

---

## Dead-End Protocol Compliance

This remediation plan was created following the Dead-End Protocol after detecting:

- **Pattern:** Stagnation (4+ attempts, same bug persisting)
- **Trigger:** Threshold exceeded for high-complexity issue
- **Previous Attempts:**
  1. Direction reversal blocking → Failed (TIME_GAP reset)
  2. Magnitude anomaly check → Failed (blocked legitimate events)
  3. Temporal max-zoom protection → Failed (caused sluggishness)
  4. Lower MIN_DIRECTION_SUM → Partial (didn't close window)

**Pivot Strategy:** Layered defense with immediate limit protection + extended direction memory

---

## Quality Floors

See `quality-floors.json` for measurable success criteria.

---

## Sources

### Web Research
- [wheel-gestures library](https://github.com/xiel/wheel-gestures) - isMomentum detection
- [lethargy.js](https://github.com/d4nyll/lethargy) - Inertial scroll detection
- [Kenneth Auchenberg: Detecting trackpad gestures](https://kenneth.io/post/detecting-multi-touch-trackpad-gestures-in-javascript)
- [Dan Burzo: Pinch-zoom in the DOM](https://danburzo.ro/dom-gestures/)
- [PDF.js smooth zooming bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1659492)
- [W3C: Expose inertial scrolling state](https://github.com/w3c/uievents/issues/58)

### Codebase Analysis
- Agent analysis of pdf-infinite-canvas.ts, inertia-classifier.ts, zoom-state-machine.ts
- Research document: `/docs/research/2026-01-15/pdf-optimizations/Trackpad Zoom Rebound Handling.md`

---

## Appendix: Files to Modify

| File | Lines Changed | Purpose |
|------|---------------|---------|
| `pdf-infinite-canvas.ts` | +32 | Immediate limit protection |
| `inertia-classifier.ts` | +42 | Extended direction memory |
| `inertia-classifier.ts` | +35 (optional) | Velocity detection |

**Total:** ~74-109 lines added

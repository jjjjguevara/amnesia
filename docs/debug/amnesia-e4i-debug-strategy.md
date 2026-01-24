# Debug Strategy: amnesia-e4i Tile Corruption Bug

> **Session Date:** 2026-01-24
> **Issue:** Tiles dropped from queue during zoom gestures causing incomplete coverage
> **North Star:** balancing-forces.md

---

## 1. EXECUTIVE SUMMARY

The `amnesia-e4i` bug manifests as visual corruption during pan/zoom gestures at mid-zoom (4-16x). Multiple fixes have been applied, but we need systematic testing to verify they work and identify any remaining issues.

**Key Insight:** The codebase has excellent debug infrastructure that is underutilized:
- `TileDiagnosticOverlay` - real-time stats panel
- `CoordinateDebugger` - snapshot-based operation tracing
- `ScaleStateManager` - centralized scale/epoch management
- `debug-tile-renderer` - visual tile identification

---

## 2. INVARIANT → OBSERVABLE STATE MAPPING

| Invariant | Observable State | Where to Read | How to Test |
|-----------|-----------------|---------------|-------------|
| **INV-1** Focal Point | `camera.x, camera.y` delta after zoom | `CoordinateDebugger.recordZoom()` | Place cursor, zoom, verify pixel stays fixed |
| **INV-2** Epoch Consistency | `tile.scaleEpoch === scaleManager.getEpoch()` | `pdf-page-element.ts:921` | Rapid zoom should show [SCALE-EPOCH-STALE] logs |
| **INV-3** Transform Coherence | `css.transform === camera state` | `CoordinateDebugger.recordTransformApply()` | Compare logged transform to camera |
| **INV-4** Coordinate Reversibility | `canvasToScreen(screenToCanvas(p)) === p` | `coordinate-debugger.ts` | Log round-trip deltas |
| **INV-5** Mode Transition | `visual(before) === visual(after)` | Screenshot at 4.0x boundary | Zoom slowly through 4x, no stretch/flash |
| **INV-6** Scale/Layout Atomicity | `∀tile: tile.scaleEpoch === batch.scaleEpoch` | `[MULTI-SCALE-INFO]` logs | Mixed scales = violation |
| **INV-6a** Scale × cssStretch | `tile.scale × cssStretch = expectedVisualScale` | `[TILE-DRAW-DETAIL]` logs | Check tileStretch values |

---

## 3. CURRENT DEBUG INFRASTRUCTURE ANALYSIS

### 3.1 TileDiagnosticOverlay (`tile-diagnostic-overlay.ts`)

**Current State:**
- Shows: zoom, pixelRatio, renderMode, requestedScale, tileScale, activeRenders, queueSize, cache stats
- Updates every 100ms via `autoUpdate()`
- Toggle debug tiles button
- Clear cache button

**Gap Analysis:**
| Missing | Why Needed | Priority |
|---------|-----------|----------|
| Epoch counter | Track INV-2 violations | HIGH |
| Gesture phase | Know if zooming/settling/idle | HIGH |
| Tile coverage % | See how many tiles rendered vs expected | HIGH |
| Last tile error | Show drop/abort reasons | MEDIUM |
| Focal point coords | Debug INV-1 | MEDIUM |
| cssStretch value | Debug INV-6a | MEDIUM |

### 3.2 CoordinateDebugger (`coordinate-debugger.ts`)

**Current State:**
- Records: zoom, pan, visibility, tile, constraint, render-request, render-complete, canvas-update, transform-apply, cssStretch-change
- Exposed via `window.pdfCoordinateDebugger`
- Has validation framework with failure callbacks
- Export to JSON

**Gap Analysis:**
| Missing | Why Needed | Priority |
|---------|-----------|----------|
| Wired to overlay | Need visual feedback, not just logs | HIGH |
| Rate of failures | Track failure frequency over time | MEDIUM |
| Epoch tracking | Need to correlate with INV-2 | MEDIUM |

### 3.3 ScaleStateManager (`scale-state-manager.ts`)

**Current State:**
- Central source of truth for scale
- Epoch-based tile validation
- Gesture phase awareness (idle/active/settling)
- Committed vs pending scale during gestures
- Focal point tracking
- CSS stretch consolidation

**Gap Analysis:**
| Missing | Why Needed | Priority |
|---------|-----------|----------|
| Exposed to overlay | Need to show in debug panel | HIGH |
| Epoch increment events | Need to log when epoch changes | MEDIUM |
| Phase transition logging | Debug settling issues | MEDIUM |

### 3.4 Debug Tile Renderer (`debug-tile-renderer.ts`)

**Current State:**
- Color-coded tiles by scale (Red=1-2, Orange=3-4, Yellow=5-8, Green=9-16, Blue=17-32, Purple=33+)
- Shows: tile coords (x,y), scale (LARGE), page, zoom
- Red dashed border for scale mismatch
- Orange triangle for fallback tiles
- Enabled via feature flag `useDebugTiles`

**Gap Analysis:**
| Missing | Why Needed | Priority |
|---------|-----------|----------|
| Epoch display | Show tile epoch vs current epoch | HIGH |
| cssStretch display | Show stretch factor | MEDIUM |
| Priority display | Show critical/high/medium/low | LOW |

---

## 4. GRAY AREAS & POTENTIAL BREAKING POINTS

### 4.1 Fixes Applied vs Issues Remaining

| Fix Applied | Invariant | Tested? | Potential Regression |
|-------------|-----------|---------|---------------------|
| Semaphore queue 100→400 | INV-6 | NO | Queue still fills at high zoom |
| getBestAvailable coord translation | INV-6 | NO | Edge cases at scale boundaries |
| MULTI-SCALE FIX (tile positioning) | INV-6a | NO | Different tile sizes (256 vs 512) |
| PAN CORRUPTION FIX | INV-5 | NO | Edge case when tileBoundsChanged=true but content valid |
| Resume gesture preserves tiles | INV-2 | NO | Stale tiles might slip through |
| Selective session abort | INV-2 | NO | Session age calculation |

### 4.2 Untested Interactions

| Interaction | Components | Test Scenario |
|-------------|-----------|---------------|
| Zoom + Pan simultaneously | ZoomOrchestrator, Camera, TileEngine | Pinch-zoom while panning |
| Mode transition under pan | PdfPageElement, RenderCoordinator | Pan to new area at exactly 4.0x |
| Scale tier change + cache hit | TileCacheManager, ScaleStateManager | Zoom in, zoom out, zoom in again |
| High tile count + queue overflow | Semaphore, RenderCoordinator | Zoom to 8x on 1000-page PDF |
| Epoch rollover | ScaleStateManager | Generate 10000+ epochs |
| DPR change mid-session | ScaleStateManager, PdfPageElement | Move window to different display |

### 4.3 Stress Test Scenarios

1. **Rapid Zoom Oscillation**: Zoom 2x→16x→2x→16x rapidly for 30 seconds
2. **Pan at High Zoom**: At 16x, pan continuously across entire page
3. **Diagonal Gesture**: Simultaneous zoom + pan (trackpad gesture)
4. **Mode Boundary Dance**: Hover zoom at 3.9x-4.1x for 30 seconds
5. **Cache Pressure**: Clear cache, zoom to 16x, observe tile queue behavior

---

## 5. HYPOTHESIS TEST MATRIX

### 5.1 Primary Hypotheses (from balancing-forces.md)

| ID | Hypothesis | Invariant | Test Method | Expected Observation |
|----|-----------|-----------|-------------|---------------------|
| H-E4I-1 | Tiles dropped from queue cause visual corruption | INV-6 | Zoom rapidly, observe queue size | Queue > 400 = drops |
| H-E4I-2 | Fallback tiles positioned incorrectly | INV-6a | Enable debug tiles, zoom in | See red-dashed tiles at wrong position |
| H-E4I-3 | Pan during render causes stale tiles | INV-2 | Pan while tiles rendering | See [SCALE-EPOCH-STALE] logs |
| H-E4I-4 | Incomplete coverage triggers wrong fallback | INV-5 | Zoom to mid-zoom, pan | [PRESERVE-CHECK] shows preserveAsLastResort=true |

### 5.2 New Hypotheses to Test

| ID | Hypothesis | Invariant | Test Method | Expected Observation |
|----|-----------|-----------|-------------|---------------------|
| H-E4I-5 | Tile scale != grid scale during zoom | INV-6 | Log tile.scale vs gridTileScale | Mismatch during continuous zoom |
| H-E4I-6 | pdfTileSize varies by tile | INV-6a | Log tilePdfTileSize per tile | Should be constant for batch |
| H-E4I-7 | canvasOffset calculated from wrong bounds | INV-4 | Log canvasOffsetX/Y vs expected | Offset doesn't match viewport |
| H-E4I-8 | CSS transform set before tiles drawn | INV-3 | Log CSS vs buffer commits | CSS applied, buffer still old |

---

## 6. ENHANCED DIAGNOSTIC PANEL DESIGN

### 6.1 Proposed DiagnosticState Extensions

```typescript
interface EnhancedDiagnosticState extends DiagnosticState {
  // INV-2: Epoch tracking
  currentEpoch: number;
  lastTileEpoch: number;
  epochMismatchCount: number;
  
  // INV-6: Scale atomicity
  tilesInLastBatch: number;
  uniqueScalesInBatch: number[];
  avgCssStretch: number;
  
  // Gesture state
  gesturePhase: 'idle' | 'active' | 'settling';
  focalPoint: { x: number; y: number } | null;
  
  // Coverage tracking
  expectedTileCount: number;
  actualTileCount: number;
  coveragePercent: number;
  
  // Error tracking
  lastDropReason: string | null;
  dropCountLast10s: number;
  abortCountLast10s: number;
  
  // Mode transition
  renderModeTransitionAt: number | null;
  timeSinceTransition: number;
}
```

### 6.2 Panel Layout

```
┌────────────────────────────────────────┐
│ TILE DIAGNOSTICS               [×]     │
├────────────────────────────────────────┤
│ CAMERA                                 │
│   Zoom: 8.00x    Epoch: 1234          │
│   Mode: TILED    Phase: settling      │
│   Focal: (450, 300)                    │
├────────────────────────────────────────┤
│ SCALE                                  │
│   Requested: 16.00   Actual: 12.00 ⚠️ │
│   cssStretch: 1.33                     │
│   Unique scales: [8, 12] ⚠️           │
├────────────────────────────────────────┤
│ COVERAGE                               │
│   Expected: 77    Actual: 65          │
│   Coverage: 84.4% [████████░░]        │
├────────────────────────────────────────┤
│ QUEUE                                  │
│   Active: 4/4     Queued: 156         │
│   Drops (10s): 23  Aborts (10s): 8    │
├────────────────────────────────────────┤
│ CACHE                                  │
│   L1: 234 tiles   L2: 1,204 tiles     │
├────────────────────────────────────────┤
│ INVARIANTS                             │
│   INV-2: ✓  INV-6: ⚠️  INV-6a: ✓     │
├────────────────────────────────────────┤
│ [Debug Tiles] [Clear Cache] [Export]   │
└────────────────────────────────────────┘
```

---

## 7. DATA COLLECTION PROTOCOL

### 7.1 Pre-Test Setup

1. Enable diagnostic overlay: `window.tileDiag.show()`
2. Enable coordinate debugger: `window.pdfCoordinateDebugger.setEnabled(true)`
3. Clear existing snapshots: `window.pdfCoordinateDebugger.clearSnapshots()`
4. Clear tile cache: `getTileCacheManager().clear()`
5. Reset epoch counter (optional): reload plugin

### 7.2 During Test

1. Perform gesture (zoom/pan/combined)
2. Observe overlay for:
   - Queue size spikes (>200 = problem)
   - Coverage drops (<95% = problem)
   - Scale mismatches (unique scales > 1 = warning)
   - Epoch mismatches (count > 0 = problem)
3. Note any visual corruption with timestamp

### 7.3 Post-Test Collection

```javascript
// Collect all data
const report = {
  snapshots: window.pdfCoordinateDebugger.getSnapshots(),
  failures: window.pdfCoordinateDebugger.getValidationFailures(),
  summary: window.pdfCoordinateDebugger.getSummary(),
  tileDiagState: window.tileDiag.getState(), // Need to add this
};

// Export to file
const blob = new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'});
const url = URL.createObjectURL(blob);
const a = document.createElement('a'); a.href = url; a.download = 'debug-report.json'; a.click();
```

---

## 8. IMPLEMENTATION PLAN

### Phase 1: Wire Up Existing Infrastructure (1-2 hours)
- [ ] Add epoch to DiagnosticState
- [ ] Add gesture phase to DiagnosticState
- [ ] Add coverage stats to DiagnosticState
- [ ] Wire ScaleStateManager to overlay updates
- [ ] Add epoch display to debug tiles

### Phase 2: Enhanced Logging (1 hour)
- [ ] Add `[INVARIANT-VIOLATION]` tagged logs for each invariant
- [ ] Add rate-limited aggregate logging for drops/aborts
- [ ] Add JSON export to coordinate debugger

### Phase 3: Test Execution (2-3 hours)
- [ ] Execute each stress test scenario
- [ ] Collect data for each
- [ ] Document observed violations

### Phase 4: Root Cause Analysis (1-2 hours)
- [ ] Correlate violations with code paths
- [ ] Identify remaining bug(s)
- [ ] Propose targeted fixes

---

## 9. SUCCESS CRITERIA

A session is successful when:

1. **No visual corruption** during any stress test
2. **Coverage ≥ 95%** at all zoom levels
3. **Zero INV-2 violations** (no stale tiles displayed)
4. **Zero INV-6 violations** (single scale per batch)
5. **Queue never exceeds 300** (leaves headroom from 400 limit)
6. **Mode transitions invisible** (no stretch/flash at 4.0x boundary)

---

## 10. CONSOLE COMMANDS QUICK REFERENCE

```javascript
// Show diagnostic overlay
window.tileDiag.show()

// Enable debug tiles (colored, labeled)
window.Amnesia?.toggleDebugTiles?.() || 
  (getFeatureFlags().setFlag('useDebugTiles', true))

// Get coordinate debugger
const dbg = window.pdfCoordinateDebugger

// Get recent snapshots
dbg.getSnapshots({ limit: 50 })

// Get failures only
dbg.getValidationFailures()

// Export full trace
dbg.exportToJSON()

// Get scale state manager
const leaves = app.workspace.getLeavesOfType('amnesia-reader')
const view = leaves[0]?.view
const reader = view?.component?.$$.ctx?.[3]
const canvas = reader?.infiniteCanvas
const ssm = canvas?.scaleStateManager

// Check scale state
ssm?.getScale()
ssm?.getEpoch()
ssm?.getState()
```

---

## Appendix: Log Patterns to Watch

| Pattern | Meaning | Action |
|---------|---------|--------|
| `[SCALE-EPOCH-STALE]` | Tile epoch != current epoch | INV-2 violation |
| `[MULTI-SCALE-INFO]` | Multiple scales in batch | Expected with cssStretch |
| `[FALLBACK-COORD-FIX]` | Fallback tile coordinates translated | Good - fix working |
| `[COVERAGE-CALC]` incomplete=true | <95% tile coverage | Potential visual gap |
| `[PRESERVE-CHECK]` preserveAsLastResort=true | Using old canvas as fallback | Check for corruption |
| `[SEMAPHORE] dropLowestPriorityWaiters` | Queue overflow | Too many tiles requested |
| `[ASPECT-ABORT]` | Buffer/CSS aspect mismatch | Render aborted to prevent corruption |
| `[ZOOM-RESET-OVERWRITE]` | Stale render overwrote zoom reset | Race condition detected |

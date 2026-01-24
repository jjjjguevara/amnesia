# PDF Renderer Mode Transition Bug - Remediation Session Kickoff

> **Copy everything below the line to start a new remediation session**

---

## Context

I'm working on fixing a PDF renderer bug in the Amnesia Obsidian plugin. The bug causes a brief vertical stretch/distortion when zooming through the mode transition boundary (around 4.0x zoom, transitioning from tiled to full-page rendering).

## Key Documentation

Read these files first:
1. **Specification:** `docs/plans/pdf-optimizations/2026-01-20/balancing-forces.md` - Contains invariants, state machines, debugging protocols, and hypothesis tracking
2. **Project Guide:** `CLAUDE.md` - Development patterns and critical warnings

## The Bug

**Symptom:** When using trackpad pinch-to-zoom on a PDF in canvas mode, content briefly stretches/distorts when crossing the ~4.0x zoom boundary.

**Console Evidence:** `tiled=400x518` vs `cssSize=400x517.647` (0.353px mismatch)

**Invariants Violated:**
- INV-4 (Coordinate Reversibility): Integer truncation breaks lossless conversions
- INV-5 (Mode Transition Continuity): Visual discontinuity at mode boundary

## LLM Council Consensus (90% Certainty)

**Primary Root Cause:** Integer vs Float Rounding Mismatch

Tile dimensions use `Math.floor()` while CSS preserves float precision, creating a sub-pixel delta that causes vertical stretching when bitmap is drawn into CSS-constrained container.

## Hypothesis Priority Order

Test in this order (use `bd ready` to see available work):

| Priority | Issue ID | Hypothesis | Certainty |
|----------|----------|------------|-----------|
| 1 | `amnesia-5hf` | H1: Integer truncation in tiles vs float CSS | 90% |
| 2 | `amnesia-x4h` | H3: Snapshot sized for float target, not int source | 65% |
| 3 | `amnesia-b59` | H2: CSS transform scale vs canvas scale diverge | 75% |

**Note:** Fixing H1 likely fixes the entire Cluster A (H4, H5, H6, H7).

## Debugging Protocol (Protocol C)

### Phase 1: Add Golden Frame Log

Add to `pdf-page-element.ts` during mode transition:
```typescript
console.log('[GOLDEN-FRAME]', {
  mode: currentRenderMode,
  camera: { x: camera.x, y: camera.y, z: camera.z },
  cssHeight: element.getBoundingClientRect().height,
  offsetHeight: element.offsetHeight,
  tiledCanvas: { w: tiledCanvas?.width, h: tiledCanvas?.height },
  fullPageCanvas: { w: fullPageCanvas?.width, h: fullPageCanvas?.height },
  snapshotCanvas: { w: snapshotCanvas?.width, h: snapshotCanvas?.height }
});
```

### Phase 2: Force Integer Rounding (Test H1)

In `prepareForFullPageRender()`, wrap dimension calculations in `Math.round()`:
- If stretch vanishes → H1 confirmed, implement proper fix
- If stretch persists → Move to H3

### Phase 3: CSS Compensation (Test H2)

Apply `scale(canvas.height / pageBaseHeight)` instead of `scale(camera.z)`:
- If fixed → H2 confirmed

## Key Files

| Concern | File |
|---------|------|
| Canvas dimensions | `apps/amnesia/src/reader/renderer/pdf/pdf-page-element.ts` |
| Tile calculations | `apps/amnesia/src/reader/renderer/pdf/tile-render-engine.ts` |
| Camera/transform | `apps/amnesia/src/reader/renderer/pdf/pdf-infinite-canvas.ts` |
| Zoom state | `apps/amnesia/src/reader/renderer/pdf/zoom-state-manager.ts` |

## bd Workflow

```bash
# See available work
bd ready

# Claim H1 for testing
bd update amnesia-5hf --status=in_progress

# After testing, if H1 is confirmed and fixed:
bd close amnesia-5hf

# If H1 is invalidated, move to H3:
bd update amnesia-5hf --status=blocked
bd update amnesia-x4h --status=in_progress
```

## Success Criteria

- [ ] Dimensions match exactly (int or float, consistently)
- [ ] No aspect ratio difference between snapshot and final render
- [ ] Mode transition has no visible glitch (<1 frame)
- [ ] Real trackpad test: zoom 1x→32x→1x with no distortion

## Testing Protocol

1. Build: `cd apps/amnesia && npm run build`
2. Deploy to test vault (see CLAUDE.md)
3. Connect MCP: `mcp__obsidian-devtools__obsidian_connect()`
4. Reload plugin: `mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })`
5. Open PDF with `Amnesia: Open book` command (NOT double-click)
6. Test with REAL trackpad gestures - synthetic tests don't capture the bug

## Red Herrings (Avoid)

- GPU anti-aliasing (symmetric, not 1D delta)
- PDF MediaBox/CropBox (larger offsets, not sub-pixel)
- Max zoom 32x (bug is at 4x boundary)
- Browser quirks (inconsistent, not reproducible)

## Session Close Protocol

```bash
git status && git add <files> && bd sync && git commit -m "..." && bd sync && git push
```

---

**Start by:** Reading `balancing-forces.md`, then run `bd show amnesia-5hf` to see full H1 details.

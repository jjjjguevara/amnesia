# PDF Rendering Architecture V4 - Unified Coordinate Space

## Executive Summary

**Abandon cssStretch-based patching. Implement architectural redesign.**

The current issues (visual jumps, mode transitions, cache explosions) are **fundamental design flaws**, not bugs. Patching cssStretch cannot fix coordinate system fragmentation.

### User's Key Insight (Validated by Research)
> "The final page size is the key. By knowing how much the page will scale up, we can stretch the text to that size and just adjust the final resolution of the tiles to match that without losing retina sharpness."

### Research Validation

**PDF.js Dual-Layer Architecture** ([PR #19128](https://github.com/mozilla/pdf.js/pull/19128)):
- Background CSS-zoomed canvas (fast, low-res)
- Detail canvas at **native DPR resolution** for visible viewport
- Abandons detail rendering during rapid scroll for responsiveness

**Industry Best Practices** ([Joyfill](https://joyfill.io/blog/optimizing-in-browser-pdf-rendering-viewing), [Apryse](https://apryse.com/blog/pdf-js/guide-to-pdf-js-rendering)):
- Tile like Google Maps: only render visible viewport + buffer
- Adaptive tile sizes: smaller at high zoom, larger at low zoom
- Prefer CSS `transform: scale()` for instant feedback, then replace with high-res tiles

---

## Critical Issues Identified (Code Review)

| # | Issue | Confidence | Impact |
|---|-------|------------|--------|
| 1 | ZoomStateMachine snapshot never cleared | 100% | Memory leak |
| 2 | frozenCssStretch Map never cleared | 95% | Visual artifacts, stale values |
| 3 | Viewport-only translate() discontinuity | 90% | **Visual jump on zoom release** |
| 4 | Cache budget 450 tiles vs 7,600 needed at 16x | 85% | 14,000+ cache misses |
| 5 | DPR double-accounting in viewport-only | 80% | Page sizing errors |
| 6 | 350ms settling delay blocks scroll renders | 75% | Blank pages during interaction |
| 7 | Async/sync mismatch in freeze lifecycle | 80% | Root cause of leaks |

**Root Cause**: Issues #2, #3, #5, #7 all stem from **cssStretch compensation** - a complex mechanism that can't work correctly because it fights the coordinate system.

---

## Proposed Architecture: Unified Coordinate Space

### Core Principle

**Before** (Current):
```
Page elements → fixed layout size (zoom=1)
Camera → scale transform (scales everything)
Tiles → rendered at zoom×DPR, then CSS-stretched
Result → cssStretch mismatch, mode transitions, visual jumps
```

**After** (Proposed):
```
Page elements → final zoomed size (zoom×layout)
Camera → translate-only (no scale transform)
Tiles → rendered at DPR resolution, positioned exactly
Result → single coordinate system, no stretching
```

### Memory Budget Compliance

| Zoom | Tile Size | Visible Tiles (800×600) | L1 Memory |
|------|-----------|-------------------------|-----------|
| 16x | 64px | ~118 tiles | 7.5 MB |
| 8x | 128px | ~30 tiles | 1.9 MB |
| 4x | 256px | ~7 tiles | 450 KB |
| 1x | 512px | ~2 tiles | 128 KB |

Adaptive tile sizing keeps **visible tiles < 120** at all zoom levels, within L1 budget.

---

## Implementation Plan

### Phase 1: Page Element Final Sizing (Foundation)

**Goal**: Pages sized to their **final displayed dimensions**, no CSS scaling

**Files**:
- `pdf-page-element.ts` - New `setFinalDimensions(width, height, zoom)` method
- `pdf-infinite-canvas.ts` - `handleZoomChange()` resizes all page elements

**Changes**:

```typescript
// pdf-page-element.ts - NEW method
setFinalDimensions(finalWidth: number, finalHeight: number, zoom: number): void {
  this.finalWidth = finalWidth;
  this.finalHeight = finalHeight;
  this.currentZoom = zoom;

  this.container.style.width = `${finalWidth}px`;
  this.container.style.height = `${finalHeight}px`;
}

// pdf-infinite-canvas.ts - Resize on zoom
private handleZoomChange(newZoom: number, focalPoint: Point): void {
  const oldZoom = this.camera.z;

  // 1. Resize page elements to final dimensions
  for (const [page, element] of this.pageElements) {
    const layout = this.pageLayouts.get(page)!;
    element.setFinalDimensions(
      layout.baseWidth * newZoom,
      layout.baseHeight * newZoom,
      newZoom
    );
  }

  // 2. Adjust camera to maintain focal point
  const zoomRatio = newZoom / oldZoom;
  this.camera.x = focalPoint.x + (this.camera.x - focalPoint.x) * zoomRatio;
  this.camera.y = focalPoint.y + (this.camera.y - focalPoint.y) * zoomRatio;
  this.camera.z = newZoom;

  // 3. Apply transform (translate only) and schedule render
  this.applyTransform();
  this.scheduleRenderAtZoom(newZoom);
}
```

**DELETE**:
- `frozenCssStretch` Map
- `frozenCssStretchDefault` value
- `freezeCssStretch()` method
- `unfreezeCssStretch()` method

### Phase 2: Camera Transform Simplification

**Goal**: Camera only translates, never scales

**File**: `pdf-canvas-camera.ts`

```typescript
// BEFORE:
export function getCameraTransform(camera: Camera): string {
  const scale = camera.z;
  return `translate(${-camera.x * scale}px, ${-camera.y * scale}px) scale(${scale})`;
}

// AFTER:
export function getCameraTransform(camera: Camera): string {
  // Camera positions are already in final coordinate space
  return `translate(${-camera.x}px, ${-camera.y}px)`;
}
```

**File**: `pdf-infinite-canvas.ts` - Simplified pan handling

```typescript
private handlePan(deltaX: number, deltaY: number): void {
  // Delta is already in screen pixels (final space)
  this.camera.x += deltaX;
  this.camera.y += deltaY;
  this.constrainCameraPosition();
  this.applyTransform();
}
```

### Phase 3: Adaptive Tile Sizing

**Goal**: Fewer tiles at high zoom, larger tiles at low zoom

**File**: `tile-render-engine.ts`

```typescript
// NEW: Adaptive tile size based on zoom
export function getTileSize(zoom: number): number {
  if (zoom >= 16) return 64;    // Extreme zoom: tiny tiles
  if (zoom >= 8) return 128;    // High zoom
  if (zoom >= 4) return 256;    // Medium zoom
  if (zoom >= 2) return 512;    // Low zoom
  return 1024;                   // Thumbnail zoom
}

// REWRITE: Calculate visible tiles in final coordinate space
getVisibleTiles(viewport: Rect, camera: Camera, zoom: number): TileCoordinate[] {
  const tileSize = getTileSize(zoom);
  const dpr = window.devicePixelRatio || 2;
  const tiles: TileCoordinate[] = [];

  // Viewport bounds in final coordinate space
  const viewportWorld = {
    x: camera.x,
    y: camera.y,
    width: viewport.width,
    height: viewport.height,
  };

  for (const [page, layout] of this.pageLayouts) {
    // Page bounds at current zoom
    const pageBounds = {
      x: layout.baseX * zoom,
      y: layout.baseY * zoom,
      width: layout.baseWidth * zoom,
      height: layout.baseHeight * zoom,
    };

    if (!rectsIntersect(viewportWorld, pageBounds)) continue;

    const intersection = intersectRects(viewportWorld, pageBounds);
    const pageRelX = intersection.x - pageBounds.x;
    const pageRelY = intersection.y - pageBounds.y;

    // Tile grid in screen pixels
    const startTX = Math.floor(pageRelX / tileSize);
    const startTY = Math.floor(pageRelY / tileSize);
    const endTX = Math.ceil((pageRelX + intersection.width) / tileSize);
    const endTY = Math.ceil((pageRelY + intersection.height) / tileSize);

    for (let ty = startTY; ty < endTY; ty++) {
      for (let tx = startTX; tx < endTX; tx++) {
        tiles.push({
          page,
          tileX: tx,
          tileY: ty,
          scale: zoom * dpr,  // MuPDF scale for sharpness
          screenSize: { width: tileSize, height: tileSize },
        });
      }
    }
  }

  return tiles;
}
```

### Phase 4: Remove cssStretch Mechanism Entirely

**Goal**: Tiles positioned exactly, no CSS scaling

**File**: `pdf-page-element.ts` - Simplified renderTiles

```typescript
async renderTiles(
  tiles: Array<{ tile: TileCoordinate; bitmap: ImageBitmap }>,
  zoom: number
): Promise<void> {
  const tileSize = getTileSize(zoom);
  const dpr = window.devicePixelRatio || 2;

  for (const { tile, bitmap } of tiles) {
    // Position in page-relative coordinates (final space)
    const x = tile.tileX * tileSize;
    const y = tile.tileY * tileSize;

    // Get or create canvas for this tile
    let canvas = this.tileCanvases.get(getTileKey(tile));
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = tileSize * dpr;   // Buffer for sharpness
      canvas.height = tileSize * dpr;
      canvas.style.width = `${tileSize}px`;   // CSS = screen size
      canvas.style.height = `${tileSize}px`;
      canvas.style.position = 'absolute';
      canvas.style.left = `${x}px`;
      canvas.style.top = `${y}px`;
      // NO SCALE TRANSFORM - always 1:1
      this.container.appendChild(canvas);
      this.tileCanvases.set(getTileKey(tile), canvas);
    }

    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  }

  this.isRendered = true;
}

// NEW: Clear tiles on zoom change
clearTileCanvases(): void {
  for (const canvas of this.tileCanvases.values()) {
    canvas.remove();
  }
  this.tileCanvases.clear();
}
```

**DELETE from codebase**:
- `cssStretch` parameter in TileCoordinate
- `avgCssStretch` calculations
- `getCurrentCssStretch()` method
- `enableTransition()` method
- All `fitScale * cssStretch` transforms

### Phase 5: Simplify Progressive Zoom

**File**: `progressive-tile-renderer.ts`

```typescript
// SIMPLIFY: No cssStretch in result
interface ProgressiveTileResult {
  scale: ScaleTier;
  tile: TileCoordinate;
  result: TileRenderResult;
  isFinal: boolean;
  // DELETE: cssScaleFactor
}

// SIMPLIFY: Always render at exact tier
export function getTargetScaleTier(zoom: number, pixelRatio: number): ScaleTierResult {
  const minRequired = zoom * pixelRatio;
  let tier = SCALE_TIERS.find(t => t >= minRequired) ?? SCALE_TIERS[SCALE_TIERS.length - 1];
  tier = Math.min(tier, getDynamicMaxScaleTier());
  return { tier, cssStretch: 1 };  // cssStretch ALWAYS 1
}
```

### Phase 6: Clean Up Lifecycle Issues

**File**: `zoom-state-machine.ts`

```typescript
// FIX: Clear snapshot when truly done
completeRenderPhase(): void {
  this.setState('idle');
  // NOW SAFE: No cssStretch to coordinate
  this.snapshot = null;
  this.currentAbort = null;
}
```

**File**: `tile-cache-manager.ts`

```typescript
// REMOVE: cssScaleFactor from cache
interface CachedTileData {
  format: RenderFormat;
  blob?: Blob;
  rgba?: Uint8Array;
  width: number;
  height: number;
  // DELETE: cssScaleFactor, targetWidth, targetHeight
}
```

---

## Critical Files to Modify

| File | Changes |
|------|---------|
| `pdf-page-element.ts` | Final sizing, tile canvas management, DELETE cssStretch |
| `pdf-infinite-canvas.ts` | handleZoomChange(), DELETE freeze mechanism |
| `pdf-canvas-camera.ts` | Translate-only transform |
| `tile-render-engine.ts` | Adaptive tile sizing, final coordinate space |
| `progressive-tile-renderer.ts` | Remove cssStretch from results |
| `tile-cache-manager.ts` | Remove cssScaleFactor from cache |
| `zoom-state-machine.ts` | Safe snapshot cleanup |

---

## Verification Protocol

### Build Verification
```bash
npm run build:no-server
# Must pass with no errors
```

### Manual Testing (REAL gestures only)

1. **Open PDF**: `Cmd+P` → "Amnesia: Open book" → verify `amnesia-reader` leaf type

2. **Zoom Transition Test**:
   - Pinch zoom 1x → 16x in one continuous gesture
   - **Pass**: Smooth zoom, NO visual jump at any point
   - **Fail**: Any discontinuity during or after gesture

3. **Pan Responsiveness Test**:
   - At 16x zoom, pan rapidly for 10 seconds
   - **Pass**: Tiles load within 1-2s, no gaps, smooth 60 FPS
   - **Fail**: Blank tiles persist >5s, stuttering, memory warnings

4. **Memory Budget Test**:
   - Chrome DevTools → Memory → Take heap snapshot
   - **Pass**: < 10MB tile memory at 16x zoom
   - **Fail**: > 50MB or continuous growth

5. **Sharpness Test**:
   - At 8x and 16x zoom, inspect text clarity
   - **Pass**: Retina-sharp text (DPR-aware)
   - **Fail**: Blurry or pixelated text

---

## Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| Visual jump on zoom release | Always | Never |
| Tiles at 16x | 7,600+ per page | < 120 visible |
| cssStretch calculations | Hundreds | Zero |
| Memory at 16x | 470MB+ (crash) | < 10MB |
| Code complexity | High (dual mode) | Low (single mode) |
| Cache hit rate | < 30% | > 80% |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Coordinate bugs | Extensive unit tests on `getVisibleTiles()` |
| Memory budget violation | Hard cap MAX_VISIBLE_TILES = 120 |
| Performance regression | Profile with Chrome DevTools, feature flag |
| Rollback needed | Feature flag `useUnifiedArchitecture` |

---

## Implementation Order with Quality Gates

### Mandatory Quality Gate Protocol

**CRITICAL**: After completing each phase, you MUST:
1. Run `npm run build:no-server` - build must pass
2. Invoke `feature-dev:code-reviewer` agent on ALL modified files for that phase
3. Fix ALL CRITICAL and HIGH findings before proceeding
4. MEDIUM findings should be fixed unless there's documented reason to defer
5. Only proceed to next phase after gate passes

### Phase Sequence

| Phase | Scope | Files | Quality Gate |
|-------|-------|-------|--------------|
| 1 | Page element final sizing | `pdf-page-element.ts`, `pdf-infinite-canvas.ts` | Code review → fix findings |
| 2 | Camera transform simplification | `pdf-canvas-camera.ts`, `pdf-infinite-canvas.ts` | Code review → fix findings |
| 3 | Adaptive tile sizing | `tile-render-engine.ts` | Code review → fix findings |
| 4 | Remove cssStretch mechanism | `pdf-page-element.ts`, `pdf-infinite-canvas.ts` | Code review → fix findings |
| 5 | Simplify progressive zoom | `progressive-tile-renderer.ts` | Code review → fix findings |
| 6 | Lifecycle cleanup | `zoom-state-machine.ts`, `tile-cache-manager.ts` | Code review → fix findings |

### Quality Gate Example

After Phase 1:
```
1. npm run build:no-server  # Must pass
2. Launch Task: feature-dev:code-reviewer
   - Files: pdf-page-element.ts, pdf-infinite-canvas.ts
   - Focus: setFinalDimensions(), handleZoomChange(), DELETE freeze mechanism
3. Review findings:
   - CRITICAL: Must fix immediately
   - HIGH: Must fix before proceeding
   - MEDIUM: Fix or document deferral reason
4. Re-run code-reviewer if fixes made
5. Only proceed to Phase 2 when gate passes
```

### Time Estimates

1. **Phase 1-2** (Foundation): 3-5 hours + quality gates
2. **Phase 3-4** (Core): 5-7 hours + quality gates
3. **Phase 5-6** (Polish): 4-6 hours + quality gates

**Total**: 12-18 hours implementation + ~4-6 hours quality gates

---

## Sources

- [PDF.js High-Res Partial Page PR #19128](https://github.com/mozilla/pdf.js/pull/19128)
- [PDF.js Tiling Issue #6419](https://github.com/mozilla/pdf.js/issues/6419)
- [Joyfill: Optimizing In-Browser PDF Rendering](https://joyfill.io/blog/optimizing-in-browser-pdf-rendering-viewing)
- [Apryse: PDF.js Rendering Quality Guide](https://apryse.com/blog/pdf-js/guide-to-pdf-js-rendering)
- [Mozilla Bug 1492303: High Zoom Blurriness](https://bugzilla.mozilla.org/show_bug.cgi?id=1492303)

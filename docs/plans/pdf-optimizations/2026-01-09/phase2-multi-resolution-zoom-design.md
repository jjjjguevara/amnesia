# Phase 2: Multi-Resolution Zoom - Detailed Design

## Executive Summary

**Goal:** Reduce perceived zoom latency from 2.5s to <500ms (80-95% improvement) using CSS transform + progressive quality enhancement.

**Key Insight:** Users don't need pixel-perfect rendering instantly. They need immediate visual feedback followed by progressive quality improvement. The human eye is more sensitive to latency than to intermediate blur.

---

## Current State Analysis

### What We Have

The `PdfInfiniteCanvas` already implements:
1. **CSS Transform Zoom** - `applyTransform()` applies `getCameraTransform(camera)` immediately
2. **Debounced Re-render** - `scheduleZoomRerender()` waits 150ms then triggers tile renders
3. **Tile-based Rendering** - `renderPageTiled()` renders 256px tiles at calculated scale
4. **Scale Calculation** - `getZoomAwareRenderScale()` computes `zoom * pixelRatio`

### Current Problem

When user zooms from 2x to 16x:
```
T+0ms:     CSS transform scales existing tiles (instant, but blurry - 8x stretch)
T+150ms:   Debounce completes
T+150ms:   Clears ALL cached tile renders for visible pages
T+150ms:   Queues new renders at scale 32 (16x zoom × 2 pixelRatio)
T+150-2500ms: Renders ~40 tiles × 68ms each (with 8 concurrent = ~340ms theoretical)
T+2500ms:  User finally sees crisp content
```

**Issues:**
1. 150ms of blurry content before even starting to render
2. All-or-nothing quality (no intermediate states)
3. Old tiles discarded immediately (no fallback)
4. Single target scale (no progressive enhancement)

---

## Phase 2 Architecture

### Core Concept: Scale Tiers

Define discrete scale levels for predictable caching and progressive enhancement:

```
Scale Tier    CSS Zoom Range    Rendered Resolution    Memory/Tile
─────────────────────────────────────────────────────────────────────
Tier 1        0.5x - 1x         scale 2 (144 DPI)      ~262 KB
Tier 2        1x - 2x           scale 4 (288 DPI)      ~1 MB
Tier 3        2x - 4x           scale 8 (576 DPI)      ~4 MB
Tier 4        4x - 8x           scale 16 (1152 DPI)    ~16 MB
Tier 5        8x - 16x          scale 32 (2304 DPI)    ~64 MB
```

### Progressive Enhancement Strategy

When zooming from 2x to 16x:

```
Phase 0 (0ms - instant):    CSS scale existing Tier 2 tiles by 8x
                            Blurry but immediate feedback

Phase 1 (50ms target):      Render critical tiles at Tier 3 (scale 8)
                            Tiles stretch 2x via CSS, less blurry

Phase 2 (150ms target):     Render critical tiles at Tier 4 (scale 16)
                            Tiles stretch 2x via CSS, nearly crisp

Phase 3 (300ms+ async):     Render at Tier 5 (scale 32)
                            Pixel-perfect quality
```

### Component Design

#### 1. ProgressiveTileRenderer

```typescript
// src/reader/renderer/pdf/progressive-tile-renderer.ts

/**
 * Manages multi-resolution tile rendering with progressive enhancement.
 * Renders tiles at intermediate scales first for faster visual feedback.
 */
export class ProgressiveTileRenderer {
  /** Discrete scale tiers for caching and progressive enhancement */
  static readonly SCALE_TIERS = [2, 4, 8, 16, 32] as const;

  /** Map of scale tier to in-flight render promises */
  private rendersByScale: Map<number, Map<string, Promise<TileRenderResult>>>;

  /**
   * Get the optimal scale tier for a given zoom level.
   * Returns the smallest scale tier that provides acceptable quality.
   */
  getTargetScaleTier(zoom: number, pixelRatio: number): number {
    const targetScale = zoom * pixelRatio;
    // Find smallest tier >= target for crisp rendering
    return SCALE_TIERS.find(t => t >= targetScale) ?? 32;
  }

  /**
   * Get intermediate scale tiers to render before final quality.
   * Returns array of scales to render progressively.
   */
  getProgressiveScales(currentScale: number, targetScale: number): number[] {
    const tiers = SCALE_TIERS.filter(t => t > currentScale && t <= targetScale);
    return tiers;
  }

  /**
   * Render a tile progressively through scale tiers.
   * Yields intermediate results as they complete.
   */
  async *renderTileProgressive(
    tile: TileCoordinate,
    currentScale: number,
    targetScale: number
  ): AsyncGenerator<{ scale: number; result: TileRenderResult }> {
    const scales = this.getProgressiveScales(currentScale, targetScale);

    for (const scale of scales) {
      const tileAtScale = { ...tile, scale };
      const result = await this.renderTile(tileAtScale);
      yield { scale, result };
    }
  }
}
```

#### 2. Multi-Scale Tile Cache

```typescript
// Extend TileCacheManager to support multi-scale caching

interface MultiScaleTileCacheManager {
  /**
   * Get best available tile for coordinates, preferring higher scales.
   * Returns tile at requested scale or best fallback.
   */
  getBestAvailable(
    tile: TileCoordinate,
    preferredScale: number
  ): { data: CachedTileData; actualScale: number } | null;

  /**
   * Get all cached scales for a tile coordinate.
   * Used for determining what intermediate renders are needed.
   */
  getCachedScales(page: number, tileX: number, tileY: number): number[];

  /**
   * Evict tiles below a scale threshold for a page.
   * Called when memory pressure is high.
   */
  evictBelowScale(page: number, minScale: number): void;
}
```

#### 3. Adaptive Tile Sizing

```typescript
// src/reader/renderer/pdf/adaptive-tile-size.ts

/**
 * Calculate optimal tile size based on zoom level.
 * Smaller tiles at high zoom = faster individual renders = better perceived performance.
 */
export function getAdaptiveTileSize(zoom: number): number {
  if (zoom >= 16) return 64;   // 64px tiles at extreme zoom
  if (zoom >= 8) return 128;   // 128px tiles at high zoom
  if (zoom >= 2) return 256;   // 256px standard tiles
  return 512;                   // 512px tiles at low zoom (fewer tiles)
}

/**
 * Calculate tile coordinate transform when tile size changes.
 * Maps old tile coords to new coords for cache lookup.
 */
export function remapTileCoordinates(
  oldTile: TileCoordinate,
  oldSize: number,
  newSize: number
): TileCoordinate[] {
  // If newSize is smaller, one old tile maps to multiple new tiles
  // If newSize is larger, multiple old tiles map to one new tile
  // ...
}
```

---

## Integration Points

### pdf-infinite-canvas.ts Changes

```typescript
// Key changes to integrate progressive zoom:

class PdfInfiniteCanvas {
  private progressiveRenderer: ProgressiveTileRenderer;
  private currentRenderScale: number = 4; // Track what scale tiles are rendered at

  private scheduleZoomRerender(): void {
    // CHANGE: Don't clear existing tiles immediately
    // Instead, start progressive enhancement

    if (this.zoomRerenderTimeout) {
      clearTimeout(this.zoomRerenderTimeout);
    }

    const targetScale = this.getZoomAwareRenderScale();

    // Phase 1: Quick intermediate render (50ms)
    this.zoomRerenderTimeout = setTimeout(() => {
      this.renderProgressivePhase(targetScale, 'intermediate');
    }, 50);

    // Phase 2: Final quality render (200ms)
    this.zoomFinalRenderTimeout = setTimeout(() => {
      this.renderProgressivePhase(targetScale, 'final');
    }, 200);
  }

  private async renderProgressivePhase(
    targetScale: number,
    phase: 'intermediate' | 'final'
  ): Promise<void> {
    const intermediateScale = phase === 'intermediate'
      ? this.progressiveRenderer.getIntermediateScale(this.currentRenderScale, targetScale)
      : targetScale;

    // Render visible tiles at this scale
    // Display them stretched via CSS if not at target scale
    // ...
  }
}
```

### tile-render-engine.ts Changes

```typescript
// Support for adaptive tile sizing

class TileRenderEngine {
  getTileSize(zoom: number): number {
    if (!isFeatureEnabled('useMultiResZoom')) {
      return TILE_SIZE; // Fixed 256px
    }
    return getAdaptiveTileSize(zoom);
  }

  getPageTileGrid(page: number, scale: number, zoom?: number): TileCoordinate[] {
    const tileSize = zoom ? this.getTileSize(zoom) : TILE_SIZE;
    // Generate grid with dynamic tile size
    // ...
  }
}
```

---

## Memory Management

### Multi-Scale Cache Budget

With multiple scale tiers cached, memory grows. Budget allocation:

```
Total Budget: 200MB (current L2 cache size)

Scale Tier Distribution:
- Tier 5 (32): 40% = 80MB  (most recent high-quality renders)
- Tier 4 (16): 25% = 50MB  (intermediate quality fallback)
- Tier 3 (8):  20% = 40MB  (lower zoom fallback)
- Tier 2 (4):  10% = 20MB  (thumbnails/overview)
- Tier 1 (2):  5%  = 10MB  (extreme zoom-out)
```

### Eviction Strategy

```typescript
/**
 * Smart eviction that preserves fallback quality.
 *
 * Priority order (lowest evicted first):
 * 1. Tiles far from viewport at any scale
 * 2. Tiles at scales user is moving away from
 * 3. Intermediate scales (keep highest and lowest)
 * 4. Never evict currently visible tiles
 */
```

---

## Implementation Phases

### Sub-Phase 2.1: Scale Tier System (Day 1)
- [ ] Define `SCALE_TIERS` constant
- [ ] Implement `getTargetScaleTier()`
- [ ] Implement `getProgressiveScales()`
- [ ] Add feature flag `useMultiResZoom`

### Sub-Phase 2.2: Progressive Tile Renderer (Day 2)
- [ ] Create `ProgressiveTileRenderer` class
- [ ] Implement `renderTileProgressive()` async generator
- [ ] Integrate with render coordinator

### Sub-Phase 2.3: Multi-Scale Cache (Day 3)
- [ ] Extend `TileCacheManager` with `getBestAvailable()`
- [ ] Add scale tracking to cache entries
- [ ] Implement `getCachedScales()`
- [ ] Update eviction to consider scale tiers

### Sub-Phase 2.4: Canvas Integration (Day 4)
- [ ] Modify `scheduleZoomRerender()` for progressive phases
- [ ] Update `renderPageTiled()` to use progressive renderer
- [ ] Add CSS transform adjustment for intermediate scales
- [ ] Handle tile replacement animations (fade/snap)

### Sub-Phase 2.5: Adaptive Tile Sizing (Day 5)
- [ ] Implement `getAdaptiveTileSize()`
- [ ] Update `TileRenderEngine.getPageTileGrid()`
- [ ] Handle tile coordinate remapping
- [ ] Test across zoom range

### Sub-Phase 2.6: Testing & Optimization (Day 6-7)
- [ ] Benchmark progressive vs current approach
- [ ] Tune phase timings (50ms, 200ms thresholds)
- [ ] Memory pressure testing
- [ ] Cross-mode testing (all 5 display modes)

---

## Success Metrics

| Metric | Current | Phase 2 Target | Measurement |
|--------|---------|----------------|-------------|
| Time to first visual change | 150ms | <50ms | CSS transform already applied |
| Time to intermediate quality | N/A | <100ms | First progressive render |
| Time to final quality | 2.5s | <500ms | All visible tiles at target scale |
| Frame rate during zoom | 20-30fps | >60fps | No jank during progressive renders |
| Memory usage | ~150MB | <200MB | With multi-scale caching |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Memory bloat from multi-scale cache | Medium | High | Strict per-tier budgets, aggressive eviction |
| Visual "popping" during tile replacement | High | Medium | Smooth fade transitions, batch updates |
| Complexity in coordinate mapping | Medium | Medium | Comprehensive unit tests, fallback to fixed size |
| Performance regression in low-memory devices | Medium | High | Feature flag, capability detection |

---

## Rollback Plan

Feature flag `useMultiResZoom = false` disables all Phase 2 changes:
- Reverts to fixed 256px tiles
- Reverts to single-scale rendering
- Reverts to 150ms debounce-then-render
- No intermediate quality phases

---

## Dependencies

- **Phase 1 Complete** - Raw RGBA transfer for faster tile renders
- **Tile Cache Manager** - Must support scale-aware caching
- **Feature Flags** - Already implemented in Phase 0
- **Telemetry** - Track progressive render phases

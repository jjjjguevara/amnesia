# Research Report: Extreme Zoom Performance (16x+)

## Executive Summary

This research investigates strategies for achieving responsive rendering at extreme zoom levels (16x+) where current tile rendering takes 2-5 seconds. Our findings indicate that **multi-resolution rendering with CSS intermediate zoom** could reduce perceived latency from 2.5s to <500ms. The key insight is that users don't need pixel-perfect resolution during zoom gestures—only when they stop to read.

---

## The Problem at Extreme Zoom

### Current State

```
Zoom 16x on Retina (2x DPR):
→ renderScale = 16 × 2 = 32
→ Tile at scale 32: 8192×8192 pixels
→ Render time: ~500ms per tile
→ 40 visible tiles = 20s serial, 2.5s with 8 concurrent
```

### User Experience

- **Expected**: Instant response like Google Maps or Figma
- **Actual**: Multi-second delay with blank tiles
- **Pain point**: Users zoom to examine fine details (annotations, equations, figures)

---

## Research Findings

### 1. How Figma Handles Extreme Zoom

> "Figma's canvas is practically infinite. You can zoom from an entire app screen down to a pixel — instantly. This requires a virtualized rendering engine to avoid drawing everything at once."
> — [Figma Rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)

**Figma's approach**:
- Tile-based rendering engine (C++ → WASM → WebGL/WebGPU)
- Resolution-independent vectors (no pre-rasterization)
- Only visible content is rendered
- GPU-accelerated compositing

> "By default, vectors in Figma are rendered as resolution-independent. This means that there aren't fixed resolutions for the paths you create in the canvas."

**Key insight**: Figma renders vectors on-demand at any scale. PDFs are rasterized, so we need a different strategy.

### 2. CATiledLayer (iOS) Multi-Resolution Approach

> "CATiledLayer draws large images at multiple zoom levels, and gives you asynchronous callbacks as it needs a new tile at a new level. It caches the results, so you only get your drawRect: calls once."
> — [CATiledLayer Part 1](http://www.mlsite.net/blog/?p=1857)

**Level of Detail (LOD) system**:

> "LOD is the number of levels it will ask for as you zoom out. LODB is the number of levels it will use as you zoom in. zoomScale is measured on a linear scale but has an exponential effect on pixels."
> — [CATiledLayer Part 2](http://www.mlsite.net/blog/?p=1884)

**Configuration example**:
```
minimumZoomScale: 0.125
maximumZoomScale: 8
levelsOfDetail: 7
levelsOfDetailBias: 3
```

> "Each LODB/LOD is a power of two more or less than the previous level of detail."

**For PDF rendering**:
- Render at discrete scale levels: 1, 2, 4, 8, 16
- At zoom 12x, use scale 8 tiles (upscaled) while rendering scale 16

### 3. Google Maps Tile Pyramid

> "The organization of Google Map tiles is best understood as a pyramid. At the base of the pyramid (zoom level 0), the entire world is represented by a single tile. As you move up the pyramid, each tile is subdivided into four child tiles."
> — [MapTiler: Google Maps Coordinates](https://docs.maptiler.com/google-maps-coordinates-tile-bounds-projection/)

**Pyramid structure**:

| Zoom Level | Tiles | Coverage |
|------------|-------|----------|
| 0 | 1 | Entire world |
| 1 | 4 | Quarter each |
| 2 | 16 | 1/16 each |
| ... | 4^n | ... |
| 20 | 1 trillion | ~1m per pixel |

> "This represents more than a 100,000x scale factor from the lowest to highest zoom level."

**Loading strategy**:
> "Progressive loading can be used to display low-resolution tiles immediately while high-resolution versions load in the background. Load base tiles first at reduced quality, then progressively enhance detail levels as bandwidth allows."
> — [Map Library: 7 Strategies to Optimize Map Rendering](https://www.maplibrary.org/10942/7-strategies-to-optimize-map-rendering-performance/)

### 4. CSS Transform for Intermediate Zoom

> "Using CSS `transform: translate()` to move the canvas inside a wrapper element is much more performant than using Fabric.js own functions. Zooming can be done with `transform: scale()` and only needs to be updated after the user is done zooming."
> — [Performant Drag and Zoom](https://medium.com/@Fjonan/performant-drag-and-zoom-using-fabric-js-3f320492f24b)

**GPU acceleration**:
> "CSS transforms are faster since they use the GPU."
> — [MDN: Optimizing Canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)

> "The reason is hardware acceleration. The browser can do these tasks on your GPU, letting the CPU handle other things."
> — [Smashing Magazine: CSS GPU Animation](https://www.smashingmagazine.com/2016/12/gpu-animation-doing-it-right/)

**Triggering GPU compositing**:
```css
.tile-container {
  transform: translateZ(0); /* Force GPU layer */
  will-change: transform;   /* Hint to browser */
}
```

### 5. Retina Display Considerations

> "On retina displays, a 256 px tile can look blurry because the screen packs more pixels per inch. The common solution is to request @2x tiles (512 px) but render them at 256 px in CSS, giving sharp details on high-DPI devices."
> — [Understanding Map Tile Grids](https://medium.com/tomtom-developers/understanding-map-tile-grids-and-zoom-levels-262b3cf644e2)

**For PDF at 16x zoom on Retina**:
- Target visual resolution: 16x × 2 DPR = 32 effective scale
- Minimum readable: 16x scale (1:1 device pixels)
- Acceptable during gesture: 8x scale (2x upscaled)

### 6. Adaptive Tile Size

> "Choosing the appropriate tile size and defining zoom levels is crucial for efficient map rendering. Smaller tile sizes result in more tiles to load but offer higher detail, while larger tile sizes reduce the number of tiles but may compromise visual quality."
> — [Saturn Cloud: Map Tiling Algorithm](https://saturncloud.io/blog/map-tiling-algorithm-an-essential-technique-for-efficient-data-visualization/)

**Current**: Fixed 256px CSS tiles

**Proposed**: Adaptive tile size based on zoom

| Zoom Range | Tile Size (CSS) | Rationale |
|------------|-----------------|-----------|
| 0.5-2x | 512px | Fewer tiles needed |
| 2-8x | 256px | Standard (current) |
| 8-16x | 128px | Faster per-tile render |
| 16x+ | 64px | Minimal render area |

At 16x zoom, a 64px CSS tile at scale 32 = 2048×2048 pixels (vs 8192×8192 for 256px tile).

### 7. Scale Cap Strategy

Current cap: scale 32 (16x zoom × 2 DPR)

**Alternative: Lower cap with upscaling**

> "The best case is to not scale the canvas, or have a smaller canvas and scale up rather than a bigger canvas and scale down."
> — [MDN: Optimizing Canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)

| Max Scale | Result at 16x Zoom | Trade-off |
|-----------|-------------------|-----------|
| 32 | Pixel-perfect | 500ms/tile |
| 16 | Slight softness | 125ms/tile |
| 8 | Noticeable blur | 30ms/tile |

**Hybrid approach**: Cap at 16, but allow 32 for stationary viewing after delay.

---

## Proposed Multi-Resolution Architecture

### Design: Progressive Enhancement

```
User zooms to 16x:

PHASE 1 (0-50ms): CSS Transform
├── Apply CSS scale to existing tiles
├── Immediate visual response
└── No new renders needed

PHASE 2 (50-200ms): Low-Res Render
├── Render at scale 8 (4x faster)
├── Display with CSS 2x upscale
└── Remove blur progressively

PHASE 3 (200ms+): High-Res Render
├── Render at scale 32 (full quality)
├── Replace low-res tiles
└── Only for visible + prefetch
```

### Implementation

#### Step 1: CSS Transform Layer

```typescript
class ZoomManager {
  private renderScale = 1;
  private displayScale = 1;

  onZoomGesture(newZoom: number): void {
    // Immediate: CSS transform only
    this.displayScale = newZoom;
    this.applyDisplayScale();

    // Debounced: Actual render
    this.scheduleRender(newZoom);
  }

  private applyDisplayScale(): void {
    const cssScale = this.displayScale / this.renderScale;
    this.container.style.transform = `scale(${cssScale})`;
  }

  private scheduleRender(targetZoom: number): void {
    // Phase 2: Low-res after 50ms
    setTimeout(() => {
      if (this.displayScale === targetZoom) {
        this.renderAtScale(Math.min(targetZoom * 0.5, 8));
      }
    }, 50);

    // Phase 3: High-res after 200ms
    setTimeout(() => {
      if (this.displayScale === targetZoom) {
        this.renderAtScale(targetZoom);
      }
    }, 200);
  }
}
```

#### Step 2: Multi-Resolution Tile Cache

```typescript
interface MultiResTile {
  pageNum: number;
  tileX: number;
  tileY: number;
  scales: Map<number, ImageBitmap>;  // scale → bitmap
}

class MultiResTileCache {
  private tiles: Map<string, MultiResTile> = new Map();

  getBestAvailable(
    pageNum: number,
    tileX: number,
    tileY: number,
    targetScale: number
  ): { bitmap: ImageBitmap; scale: number } | null {
    const tile = this.tiles.get(`${pageNum}:${tileX}:${tileY}`);
    if (!tile) return null;

    // Find best available scale (highest ≤ target)
    let bestScale = 0;
    let bestBitmap: ImageBitmap | null = null;

    for (const [scale, bitmap] of tile.scales) {
      if (scale <= targetScale && scale > bestScale) {
        bestScale = scale;
        bestBitmap = bitmap;
      }
    }

    return bestBitmap ? { bitmap: bestBitmap, scale: bestScale } : null;
  }
}
```

#### Step 3: Progressive Tile Rendering

```typescript
async function renderTileProgressive(
  pageNum: number,
  tileX: number,
  tileY: number,
  targetScale: number
): Promise<void> {
  // Immediately show best available
  const cached = cache.getBestAvailable(pageNum, tileX, tileY, targetScale);
  if (cached) {
    displayTile(cached.bitmap, targetScale / cached.scale);
  }

  // Render at intermediate scales
  const scaleSteps = [4, 8, 16, 32].filter(s => s <= targetScale);

  for (const scale of scaleSteps) {
    if (cache.has(pageNum, tileX, tileY, scale)) continue;

    const bitmap = await renderTile(pageNum, tileX, tileY, scale);
    cache.set(pageNum, tileX, tileY, scale, bitmap);

    // Update display if this is best so far
    if (scale > (cached?.scale || 0)) {
      displayTile(bitmap, targetScale / scale);
    }
  }
}
```

#### Step 4: Adaptive Tile Size

```typescript
function getTileSizeForZoom(zoom: number): number {
  if (zoom <= 2) return 512;
  if (zoom <= 8) return 256;
  if (zoom <= 16) return 128;
  return 64;
}

function getTileGridForViewport(
  viewport: Rect,
  zoom: number,
  dpr: number
): TileGrid {
  const tileSize = getTileSizeForZoom(zoom);
  const scaledTileSize = tileSize * zoom;

  return {
    tileSize,
    cols: Math.ceil(viewport.width / scaledTileSize) + 1,
    rows: Math.ceil(viewport.height / scaledTileSize) + 1,
    startX: Math.floor(viewport.x / scaledTileSize),
    startY: Math.floor(viewport.y / scaledTileSize),
  };
}
```

---

## Rendering Strategy by Zoom Level

| Zoom | Render Scale | Tile Size | Strategy |
|------|--------------|-----------|----------|
| 0.5-1x | 1-2 | 512px | Full page, no tiling |
| 1-4x | 2-4 | 256px | Standard tiles |
| 4-8x | 4-8 | 256px | Standard tiles |
| 8-16x | 8 → 16 | 128px | Progressive (8 then 16) |
| 16x+ | 8 → 16 → 32 | 64px | Three-stage progressive |

---

## Expected Performance Gains

### Current (Single Resolution)

| Action | Time to Display |
|--------|-----------------|
| Zoom 1x → 16x | 2.5s (blank during) |
| Pan at 16x | 500ms per new tile |
| Stationary at 16x | N/A (already rendered) |

### Proposed (Multi-Resolution)

| Action | Time to Display |
|--------|-----------------|
| Zoom 1x → 16x | <50ms (CSS transform) |
| Low-res appearance | 50-100ms |
| Full quality | 200-500ms |
| Pan at 16x | <100ms (low-res) |

**Perceived improvement**: 80-95% faster initial response

---

## Memory Considerations

### Multi-Resolution Cache Growth

Storing multiple resolutions per tile increases memory:

| Approach | Memory per Tile | 100 Tiles |
|----------|-----------------|-----------|
| Single (scale 32) | 256 MB | 25.6 GB (impossible) |
| Single (scale 16) | 64 MB | 6.4 GB (still bad) |
| Multi-res (8+16) | 80 MB combined | 8 GB (bad) |
| **With eviction** | 10 MB avg | 1 GB (acceptable) |

**Key insight**: Don't cache high scales long-term. Evict aggressively.

### Eviction Strategy

```typescript
class AdaptiveCache {
  private readonly LOW_SCALE_LIMIT = 100;   // Keep more low-res
  private readonly HIGH_SCALE_LIMIT = 20;   // Fewer high-res

  evict(): void {
    // Evict high-scale tiles first
    const highScaleTiles = this.getTilesAtScale(s => s >= 16);
    if (highScaleTiles.length > this.HIGH_SCALE_LIMIT) {
      this.evictLRU(highScaleTiles, highScaleTiles.length - this.HIGH_SCALE_LIMIT);
    }

    // Keep more low-scale tiles
    const lowScaleTiles = this.getTilesAtScale(s => s < 16);
    if (lowScaleTiles.length > this.LOW_SCALE_LIMIT) {
      this.evictLRU(lowScaleTiles, lowScaleTiles.length - this.LOW_SCALE_LIMIT);
    }
  }
}
```

---

## Risks and Mitigations

### Risk 1: Blurry Text During Transition
Users may notice blur during progressive enhancement.

**Mitigation**:
- Make transition fast (<200ms to acceptable quality)
- Consider font-specific detection (prioritize text pages)
- Allow user preference for "quality over speed"

### Risk 2: Cache Complexity
Multi-resolution cache is harder to manage.

**Mitigation**:
- Clear API: `getBestAvailable(page, tile, targetScale)`
- Aggressive high-scale eviction
- Telemetry on cache hit rates

### Risk 3: GPU Memory Limits
CSS-scaled tiles still consume GPU memory.

**Mitigation**:
- Limit CSS-scaled tiles to visible viewport
- Use `will-change` sparingly
- Monitor GPU memory via DevTools

### Risk 4: Jank During Scale Transitions
Replacing low-res with high-res may cause flicker.

**Mitigation**:
- Smooth crossfade transition
- Ensure new tile is fully loaded before swap
- Consider double-buffering approach

---

## Validation Plan

### Benchmark: Zoom Gesture Response

1. Measure time from gesture start to first visual change
2. Target: <50ms (CSS transform)

### Benchmark: Progressive Enhancement

1. Measure time to each quality level
2. Targets:
   - Low-res visible: <100ms
   - Medium-res visible: <300ms
   - Full quality: <800ms

### User Study Metrics

| Metric | Target |
|--------|--------|
| Perceived smoothness | >90% positive |
| Text readability score | >80% satisfied |
| Zoom gesture FPS | >55 fps |

---

## Implementation Phases

### Phase 1: CSS Transform Layer

1. Add transform wrapper around tile container
2. Apply CSS scale during zoom gesture
3. Debounce actual rendering

### Phase 2: Multi-Resolution Rendering

1. Implement scale stepping (8 → 16 → 32)
2. Add multi-res tile cache
3. Progressive tile replacement

### Phase 3: Adaptive Tile Size

1. Implement zoom-based tile sizing
2. Adjust prefetch strategies
3. Tune cache limits

### Phase 4: Polish

1. Smooth crossfade transitions
2. Font-detection priority
3. User preference option

---

## Conclusion

Extreme zoom performance can be dramatically improved through:

1. **CSS Transform Layer**: Instant response via GPU scaling
2. **Multi-Resolution Rendering**: Progressive quality enhancement
3. **Adaptive Tile Sizing**: Faster per-tile renders at high zoom
4. **Aggressive Cache Management**: Prioritize low-res for coverage

The key insight is separating **perceived responsiveness** from **final quality**. Users accept brief blur during interaction if the interface feels immediate.

---

## Bibliography

1. [Figma Rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/) - Modern GPU rendering architecture
2. [How to Create a Figma-like Infinite Canvas in React](https://betterprogramming.pub/how-to-create-a-figma-like-infinite-canvas-in-react-a2b0365b2a7) - Implementation patterns
3. [How to Create a Figma-like Infinite Canvas in WebGL](https://betterprogramming.pub/how-to-create-a-figma-like-infinite-canvas-in-webgl-8be94f65674f) - WebGL approach
4. [JCTiledScrollView (GitHub)](https://github.com/jessedc/JCTiledScrollView) - iOS CATiledLayer implementation
5. [CATiledLayer Part 1](http://www.mlsite.net/blog/?p=1857) - Fundamentals of tiled layers
6. [CATiledLayer Part 2](http://www.mlsite.net/blog/?p=1884) - LOD and zoom configuration
7. [Apple: CATiledLayer Documentation](https://developer.apple.com/documentation/quartzcore/catiledlayer) - Official API reference
8. [MapTiler: Google Maps Coordinates and Tile Bounds](https://docs.maptiler.com/google-maps-coordinates-tile-bounds-projection/) - Tile pyramid fundamentals
9. [7 Strategies to Optimize Map Rendering Performance](https://www.maplibrary.org/10942/7-strategies-to-optimize-map-rendering-performance/) - Progressive loading strategies
10. [Saturn Cloud: Map Tiling Algorithm](https://saturncloud.io/blog/map-tiling-algorithm-an-essential-technique-for-efficient-data-visualization/) - Tile size considerations
11. [Understanding Map Tile Grids](https://medium.com/tomtom-developers/understanding-map-tile-grids-and-zoom-levels-262b3cf644e2) - Retina display handling
12. [MDN: Optimizing Canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas) - Canvas performance tips
13. [Smashing Magazine: CSS GPU Animation](https://www.smashingmagazine.com/2016/12/gpu-animation-doing-it-right/) - GPU compositing deep dive
14. [Performant Drag and Zoom with Fabric.js](https://medium.com/@Fjonan/performant-drag-and-zoom-using-fabric-js-3f320492f24b) - CSS transform for zoom
15. [Build an Infinite Canvas: Step-by-Step Tutorial](https://www.ywian.com/blog/build-infinite-canvas-step-by-step) - Implementation walkthrough
16. [What is an Infinite Canvas?](https://antv.vision/infinite-canvas-tutorial/guide/what-is-an-infinite-canvas) - Concept overview

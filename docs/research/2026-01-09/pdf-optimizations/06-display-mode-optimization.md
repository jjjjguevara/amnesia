# Research Report: Display Mode Optimization

## Executive Summary

This research investigates optimization strategies for Amnesia's 5 distinct PDF display modes. Each mode has unique performance characteristics and bottlenecks. Our findings indicate that **parallel thumbnail generation during document parse** could reduce Auto-Grid initial load from 3-5s to <1s, and **mode-specific cache management** could improve transitions between modes.

---

## Display Mode Overview

### Current Modes and Bottlenecks

| Mode | Layout | Primary Bottleneck | Current Time |
|------|--------|-------------------|--------------|
| **Paginated** | Multi-page fit-to-view | Initial load | 100-300ms |
| **Vertical-Scroll** | Continuous single column | Tile throughput at speed | 40-50 FPS |
| **Horizontal-Scroll** | Single row, all pages | Wide viewport | 40-50 FPS |
| **Auto-Grid** | Dynamic columns | Thumbnail generation | 3-5s/100pg |
| **Canvas** | Fixed 10-column grid | Extreme zoom render | 2-5s at 16x |

### Target Metrics

| Mode | First Paint | Full Viewport | Scroll FPS | Zoom to 16x |
|------|-------------|---------------|------------|-------------|
| Paginated | <50ms | <100ms | N/A | <200ms |
| V-Scroll | <50ms | <150ms | >58 FPS | <200ms |
| H-Scroll | <50ms | <150ms | >58 FPS | <200ms |
| Auto-Grid | <500ms | <2s | >55 FPS | N/A |
| Canvas | <100ms | <200ms | >55 FPS | <500ms |

---

## Research Findings

### 1. Progressive PDF Loading

> "The idea of progressive loading is that as you download a PDF file into a browser, you can display the pages as they appear."
> — [MuPDF: Progressive Loading](https://mupdf.readthedocs.io/en/1.22.0/progressive-loading.html)

**Linearized PDFs**:
> "Adobe defines 'linearized' PDFs as being ones that have both a specific layout of objects and a small amount of extra information to help avoid seeking within a file. The stated aim is to deliver the first page of a document in advance of the whole document downloading."

**Implication**: For paginated mode, the first page should render before full document loads.

### 2. pdf.js Progressive Rendering

> "When you directly open a linearized/web-optimized PDF in Firefox, progressive rendering happens. The first page gets displayed before the complete PDF is downloaded."
> — [pdf.js Issue #9851](https://github.com/mozilla/pdf.js/issues/9851)

**Approach**: Detect linearized PDFs and prioritize first-page rendering.

### 3. Thumbnail Generation Strategies

> "A suggested optimization is to pre-generate thumbnails for recently uploaded/scanned content, downsizing large content (> 1MB) into something small like 384x384."
> — [Nextcloud Issue #1732](https://github.com/nextcloud/server/issues/1732)

**Options**:
1. **On-demand**: Render thumbnails as grid becomes visible
2. **Background**: Generate during idle time after document open
3. **Parallel**: Use multiple workers for concurrent generation
4. **Persistent**: Cache thumbnails to disk/IndexedDB

### 4. Optimal Thumbnail Size

> "Traditionally, raster tiles are 256×256 px, but many providers also support 512×512 px tiles—especially for vector tiles."
> — [Geoapify: Map Zoom Levels](https://dev.to/geoapify-maps-api/understanding-map-zoom-levels-and-xyz-tile-coordinates-55da)

For PDF thumbnails in grid view:

| Grid Columns | Thumbnail Width | Recommended Size |
|--------------|-----------------|------------------|
| 3 | ~200px | 200-256px |
| 5 | ~120px | 128-150px |
| 10 | ~60px | 64-80px |

**Scale calculation**:
```javascript
const thumbnailScale = thumbnailWidth / pageWidth;
// For A4 page (595pt) at 150px display: scale = 0.25
```

### 5. Debounce and requestAnimationFrame

> "There can be very many scroll events in quick succession. The solution for this is to debounce it by using requestAnimationFrame."
> — [pdf.js Issue #5178](https://github.com/mozilla/pdf.js/issues/5178)

**Current constants**:
- `SCROLL_RERENDER_DEBOUNCE`: 32ms (~2 frames)
- `ZOOM_RERENDER_DEBOUNCE`: 150ms (gesture completion)

> "requestAnimationFrame() sets up a callback function. Instead of running after a certain period of time, it runs the next time a page paint is requested."
> — [Go Make Things: Debouncing with rAF](https://gomakethings.com/debouncing-events-with-requestanimationframe-for-better-performance/)

### 6. Virtualization for Grid Modes

> "Lazy load only the first visible page, then load subsequent pages on scroll. Prioritize low-resolution previews first, with full rendering deferred."
> — [Joyfill: Optimizing In-Browser PDF Rendering](https://joyfill.io/blog/optimizing-in-browser-pdf-rendering-viewing)

**For Auto-Grid and Canvas modes**:
- Only render visible thumbnails + small buffer
- Use placeholder skeleton until rendered
- Progressive quality enhancement

### 7. Cache Management Across Modes

Different modes have different cache needs:

| Mode | Preferred Cache | Reason |
|------|-----------------|--------|
| Paginated | Current page ± 1 | Limited navigation |
| V-Scroll | Velocity-based lookahead | Continuous scroll |
| H-Scroll | Wider horizontal buffer | All pages visible |
| Auto-Grid | Thumbnails (scale ~0.2) | Low-res many pages |
| Canvas | Mixed: thumbnails + tiles | Grid + zoom |

**Mode transition challenge**: Switching modes may invalidate useful cache.

### 8. Mode Transition Handling

**Current behavior**: Cache is preserved but not mode-aware.

**Proposed**: Mode-specific cache regions with different eviction policies.

```typescript
interface ModeSpecificCache {
  paginated: TileCache;      // High-res, few pages
  scroll: TileCache;         // Variable scale, wide range
  grid: ThumbnailCache;      // Low-res, all pages
  canvas: MultiResCache;     // Both thumbnails and tiles
}
```

---

## Mode-Specific Optimization Strategies

### Mode 1: Paginated

**Current bottleneck**: 100-300ms initial load

**Optimizations**:

1. **Pre-cache first 3 pages on open**
   ```typescript
   async function onDocumentOpen(doc: PDFDocument): Promise<void> {
     // Parallel render of first 3 pages
     await Promise.all([
       renderPage(0, 'high'),
       renderPage(1, 'high'),
       renderPage(2, 'high'),
     ]);
   }
   ```

2. **Linearized PDF detection**
   ```typescript
   function isLinearized(doc: PDFDocument): boolean {
     const catalog = doc.getTrailer().get("Root");
     const linearized = catalog?.get("Linearized");
     return linearized !== undefined;
   }
   ```

3. **Predictive prefetch on navigation**
   ```typescript
   function onPageChange(newPage: number): void {
     // Immediately show cached if available
     if (cache.has(newPage)) {
       displayCached(newPage);
     }

     // Prefetch neighbors
     prefetch([newPage - 1, newPage, newPage + 1, newPage + 2]);
   }
   ```

**Target**: <50ms first paint, <100ms full viewport

### Mode 2: Vertical-Scroll

**Current bottleneck**: Tile throughput at >500px/s scroll

**Optimizations** (mostly implemented):

1. **Velocity-based quality adaptation**
   - Already implemented with 4 speed zones
   - Consider more aggressive quality reduction

2. **Camera snapshot pattern**
   - Already implemented
   - Prevents "0 visible tiles" issue

3. **Priority-based rendering**
   - Critical (0-0.5 viewport) → Priority 0
   - High (0.5-1.5 viewport) → Priority 1
   - Medium (1.5-2.5 viewport) → Priority 2
   - Low (2.5+ viewport) → Priority 3

4. **Continuous scroll detection**
   ```typescript
   const isScrolling = velocity > 0;
   const isFastScrolling = velocity > 500;

   if (isFastScrolling) {
     // Skip non-critical tiles entirely
     // Reduce quality to 50%
     // Increase debounce to 64ms
   }
   ```

**Target**: >58 FPS, 0 blank tiles visible

### Mode 3: Horizontal-Scroll

**Current bottleneck**: Wider viewport = more tiles

**Optimizations**:

Same as vertical-scroll, plus:

1. **Horizontal-aware prefetch**
   ```typescript
   function getPrefetchPages(currentPage: number, velocity: number): number[] {
     const direction = velocity > 0 ? 1 : -1;
     const lookahead = Math.ceil(Math.abs(velocity) / 100);

     const pages = [];
     for (let i = 1; i <= lookahead; i++) {
       pages.push(currentPage + i * direction);
     }
     return pages;
   }
   ```

2. **All-pages-visible awareness**
   - In horizontal mode, all pages are theoretically visible
   - Prioritize pages near viewport center

**Target**: Same as vertical-scroll

### Mode 4: Auto-Grid (Primary Optimization Target)

**Current bottleneck**: 3-5s for 100 page thumbnails

**Problem analysis**:
```
100 pages × 50ms/thumbnail = 5000ms serial
With 8 concurrent: 5000/8 = 625ms theoretical
Actual: 3-5s (overhead, cache misses, etc.)
```

**Optimizations**:

1. **Parallel thumbnail generation during parse**
   ```typescript
   async function onDocumentOpen(doc: PDFDocument): Promise<void> {
     const pageCount = doc.countPages();

     // Start thumbnail generation immediately
     const thumbnailPromises = [];
     for (let i = 0; i < pageCount; i++) {
       thumbnailPromises.push(
         generateThumbnail(i, 150, 'low')
           .catch(() => null)  // Don't fail on error
       );
     }

     // Show document while thumbnails generate
     showDocumentSkeleton(pageCount);

     // Replace skeletons as thumbnails complete
     for (const [i, promise] of thumbnailPromises.entries()) {
       promise.then(thumb => {
         if (thumb) replaceSkeleton(i, thumb);
       });
     }
   }
   ```

2. **Ripple-from-center prefetch**
   ```typescript
   function getRippleOrder(centerPage: number, totalPages: number): number[] {
     const order = [centerPage];
     let radius = 1;

     while (order.length < totalPages) {
       if (centerPage - radius >= 0) {
         order.push(centerPage - radius);
       }
       if (centerPage + radius < totalPages) {
         order.push(centerPage + radius);
       }
       radius++;
     }

     return order;
   }
   ```

3. **Low-resolution fast path**
   ```typescript
   const THUMBNAIL_SCALE = 0.2;  // 20% of full size

   async function generateThumbnail(pageNum: number): Promise<ImageBitmap> {
     // At scale 0.2, A4 page = 119×168 pixels
     // Much faster than full resolution
     return renderPage(pageNum, THUMBNAIL_SCALE);
   }
   ```

4. **IndexedDB thumbnail persistence**
   ```typescript
   async function getCachedThumbnail(
     docId: string,
     pageNum: number
   ): Promise<ImageBitmap | null> {
     const key = `${docId}:${pageNum}:thumb`;
     const cached = await idb.get('thumbnails', key);

     if (cached) {
       return createImageBitmap(cached.blob);
     }
     return null;
   }

   async function cacheThumbnail(
     docId: string,
     pageNum: number,
     bitmap: ImageBitmap
   ): Promise<void> {
     const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
     const ctx = canvas.getContext('2d');
     ctx.drawImage(bitmap, 0, 0);
     const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });

     await idb.put('thumbnails', { docId, pageNum, blob }, `${docId}:${pageNum}:thumb`);
   }
   ```

**Target**: <500ms initial visibility, <2s full grid

### Mode 5: Canvas

**Current bottleneck**: 2-5s at 16x zoom

**Optimizations** (covered in Extreme Zoom report):

1. **Multi-resolution tiles**
   - Low-res immediate, high-res progressive
   - CSS transform for intermediate scales

2. **Thumbnail foundation**
   - Grid starts with thumbnails
   - Only render high-res on zoom

3. **Spatial prefetch for grid**
   ```typescript
   function getSpatialPrefetch(
     centerX: number,
     centerY: number,
     gridCols: number,
     gridRows: number
   ): Array<{row: number, col: number}> {
     // Chebyshev distance ordering
     const cells = [];
     for (let dy = -2; dy <= 2; dy++) {
       for (let dx = -2; dx <= 2; dx++) {
         const col = centerX + dx;
         const row = centerY + dy;
         if (col >= 0 && col < gridCols && row >= 0 && row < gridRows) {
           cells.push({ row, col, dist: Math.max(Math.abs(dx), Math.abs(dy)) });
         }
       }
     }
     return cells.sort((a, b) => a.dist - b.dist);
   }
   ```

**Target**: <100ms first paint, <500ms zoom to 16x

---

## Mode Transition Optimization

### Current Problem

Mode switches discard useful cached content:
- Switch from Grid → Paginated: Grid thumbnails ignored
- Switch from Scroll → Grid: High-res tiles not reused

### Proposed: Unified Cache with Mode Views

```typescript
class UnifiedCache {
  private tiles: Map<string, CachedTile> = new Map();

  // Each mode has a "view" into the same cache
  getPaginatedView(): TileView {
    return new TileView(this, tile =>
      tile.scale >= 2 && tile.pageNum === this.currentPage);
  }

  getScrollView(): TileView {
    return new TileView(this, tile =>
      tile.scale >= 1 && this.isNearViewport(tile));
  }

  getGridView(): TileView {
    return new TileView(this, tile =>
      tile.scale < 1);  // Thumbnails only
  }
}
```

### Transition Strategies

| From | To | Strategy |
|------|----|----------|
| Paginated → Scroll | Keep current page tiles, prefetch neighbors |
| Scroll → Paginated | Keep visible tiles, evict distant |
| Any → Grid | Generate thumbnails, keep existing |
| Grid → Any | Keep thumbnails for overview, render high-res |

```typescript
async function transitionMode(from: Mode, to: Mode): Promise<void> {
  // Pre-render for new mode while keeping old content visible
  const preRenderPromise = prerenderForMode(to);

  // Fade transition (CSS)
  container.classList.add('mode-transition');

  await preRenderPromise;

  // Swap views
  setActiveMode(to);
  container.classList.remove('mode-transition');

  // Background: clean up old mode's specific cache
  scheduleCleanup(from);
}
```

---

## Text Layer Strategies by Mode

| Mode | Text Layer Need | Strategy |
|------|-----------------|----------|
| Paginated | Full (selection, search) | Render with page |
| V-Scroll | Full | Lazy, attached to visible pages |
| H-Scroll | Full | Same as V-Scroll |
| Auto-Grid | None (overview only) | Skip entirely |
| Canvas | Conditional (zoom-dependent) | Render at zoom > 2x |

```typescript
function shouldRenderTextLayer(mode: Mode, zoom: number): boolean {
  switch (mode) {
    case 'paginated':
    case 'vertical-scroll':
    case 'horizontal-scroll':
      return true;
    case 'auto-grid':
      return false;
    case 'canvas':
      return zoom > 2;
  }
}
```

---

## Implementation Priorities

### Priority 1: Auto-Grid Thumbnail Generation

**Impact**: High (3-5s → <1s)
**Effort**: Medium

1. Parallel generation with worker pool
2. Ripple-from-center ordering
3. Progressive skeleton replacement

### Priority 2: IndexedDB Thumbnail Persistence

**Impact**: High (instant on reopen)
**Effort**: Medium

1. Hash-based document ID
2. WebP compression for storage
3. LRU eviction for storage limits

### Priority 3: Mode Transition Caching

**Impact**: Medium (smoother UX)
**Effort**: Low

1. Unified cache with mode views
2. Transition-aware eviction
3. Pre-render for target mode

### Priority 4: Linearized PDF Fast Path

**Impact**: Low-Medium (first page only)
**Effort**: Low

1. Detect linearized flag
2. Prioritize first page render
3. Stream remaining pages

---

## Validation Plan

### Auto-Grid Benchmark

| Metric | Baseline | Target |
|--------|----------|--------|
| Time to first thumbnail | 500ms | <100ms |
| Time to 10 thumbnails | 1000ms | <300ms |
| Time to full grid (100 pages) | 5000ms | <2000ms |

### Mode Transition Benchmark

| Transition | Target |
|------------|--------|
| Any → Any (cached) | <100ms |
| Scroll → Grid | <200ms |
| Grid → Scroll | <200ms |
| Cold mode switch | <500ms |

### Memory Stability

| Scenario | Target |
|----------|--------|
| 30-min session, mode switching | No memory growth |
| 100 mode transitions | <10MB total growth |

---

## Conclusion

Display mode optimization focuses on three key areas:

1. **Auto-Grid initialization** (parallel thumbnails, persistence)
2. **Mode transitions** (unified cache, pre-rendering)
3. **Mode-specific tuning** (text layers, prefetch patterns)

The most impactful optimization is parallel thumbnail generation during document open, which could reduce grid mode initialization from 3-5s to under 1s.

---

## Bibliography

1. [MuPDF: Progressive Loading](https://mupdf.readthedocs.io/en/1.22.0/progressive-loading.html) - Linearized PDF handling
2. [pdf.js Issue #9851: Progressive Loading](https://github.com/mozilla/pdf.js/issues/9851) - Progressive rendering discussion
3. [pdf.js Issue #5178: Debounce Scroll](https://github.com/mozilla/pdf.js/issues/5178) - Scroll performance optimization
4. [Joyfill: Optimizing In-Browser PDF Rendering](https://joyfill.io/blog/optimizing-in-browser-pdf-rendering-viewing) - General PDF optimization
5. [Nutrient: PDF Rendering Performance](https://www.nutrient.io/guides/web/best-practices/performance/) - Best practices guide
6. [Go Make Things: Debouncing with rAF](https://gomakethings.com/debouncing-events-with-requestanimationframe-for-better-performance/) - requestAnimationFrame patterns
7. [High-Performance Input Handling](https://nolanlawson.com/2019/08/11/high-performance-input-handling-on-the-web/) - Frame budget management
8. [Nextcloud Issue #1732: Thumbnail Generation](https://github.com/nextcloud/server/issues/1732) - Pre-generation strategies
9. [voidtools Forum: Generating Thumbnails](https://www.voidtools.com/forum/viewtopic.php?t=13201) - Thumbnail caching approaches
10. [PDF Slice Loading](https://medium.com/@ggluopeihai/pdf-slice-loading-full-stack-solution-89c12d92a2a4) - Progressive loading patterns
11. [react-fast-scroll-pdf (npm)](https://www.npmjs.com/package/react-fast-scroll-pdf) - React PDF optimization library
12. [Geoapify: Map Zoom Levels](https://dev.to/geoapify-maps-api/understanding-map-zoom-levels-and-xyz-tile-coordinates-55da) - Tile size considerations
13. [OffscreenCanvas (web.dev)](https://web.dev/articles/offscreen-canvas) - Background rendering
14. [pdf.js Issue #18199: Hardware Acceleration](https://github.com/mozilla/pdf.js/discussions/18199) - GPU acceleration discussion
15. [Optimizing Canvas Performance](https://reintech.io/blog/optimizing-canvas-performance-large-scale-apps) - Large-scale canvas optimization

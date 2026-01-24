# PDF Renderer Performance Baseline Metrics

**Date**: 2026-01-13
**Commit**: Before remediation fixes

## Observed Symptoms

1. **96% L1 cache miss rate** during zoom changes
2. **800ms+ tile wait times** during rapid interaction
3. **Blurry text at 16x zoom** when using fallback tiles
4. **Sluggish perceived performance** despite 60 FPS in telemetry
5. **Page aspect ratio issues** - pages may not match original PDF dimensions

## Telemetry Baseline

### Cache Performance
| Metric | Value | Target |
|--------|-------|--------|
| Overall Hit Rate | 19.1% | >70% |
| L1 Hit Rate | 2.8% | >50% |
| L2 Hit Rate | 23.4% | >60% |

### Render Performance
| Metric | Value | Target |
|--------|-------|--------|
| Avg Render Time | 1648.2ms | <200ms |
| P95 Render Time | 9397.3ms | <500ms |
| First Tile Time | 1145.6ms | <300ms |
| Avg Tile Time | 135.5ms | <50ms |

### Zoom Usage
| Metric | Value |
|--------|-------|
| Current Zoom | 2.1x |
| Zoom Changes | 36 |
| Max Zoom Used | 32x |
| Most Used Zoom | 15.0x |

### System Resources
| Metric | Value |
|--------|-------|
| Memory Current | 172.9MB |
| Memory Peak | 214.1MB |
| Worker Utilization | 13% |
| Pending Tasks | 1 |
| Session Duration | 546.9s |
| Total Renders | 1836 |

## Identified Root Causes

### Issue 1: L1 Cache Not Evicted on Zoom
- **Location**: `tile-cache-manager.ts:1392-1398`
- **Problem**: `onModeTransition()` clears L1, but zoom changes don't call it
- **Impact**: Stale scale tiles fill L1, causing 96% miss rate

### Issue 2: cssStretch Dropped in Tile Collection
- **Location**: `pdf-infinite-canvas.ts:1747-1754`
- **Problem**: Fallback tile's `cssStretch` not passed to page element
- **Impact**: Blur at high zoom when using cached fallback tiles

### Issue 3: FIFO Semaphore Without Priority
- **Location**: `render-coordinator.ts:93-164`
- **Problem**: Critical and background renders share same FIFO queue
- **Impact**: 800ms+ wait times for visible tiles

### Issue 4: Single Aspect Ratio for All Pages
- **Location**: `pdf-infinite-canvas.ts:698-705`
- **Problem**: All pages use page 1's aspect ratio for layout
- **Impact**: Mixed page sizes display incorrectly

### Issue 5: Optional Thumbnail Suspension
- **Location**: `pdf-infinite-canvas.ts:2687`
- **Problem**: Optional chaining means no-op if not implemented
- **Impact**: Thumbnails compete with interactive rendering

### Issue 6: No Input-to-Visual Latency Tracking
- **Location**: Throughout pdf-infinite-canvas.ts
- **Problem**: Only RAF FPS tracked, not actual input→display latency
- **Impact**: Can't measure real user experience

## Fix Implementation Order

1. **Phase 1**: Add input-to-visual latency instrumentation (measurement)
2. **Phase 2**: Fix cssStretch propagation (visual quality)
3. **Phase 3**: Add L1 cache eviction on zoom (cache performance)
4. **Phase 4**: Implement priority semaphore (responsiveness)
5. **Phase 5**: Fix per-page aspect ratio (layout correctness)
6. **Phase 6**: Make thumbnail suspension effective (resource priority)
7. **Phase 7**: Validate all fixes with code review

## Success Criteria

After all fixes:
- L1 hit rate > 50%
- Avg render time < 200ms
- P95 render time < 500ms
- Input-to-visual latency < 100ms
- Crisp text at 16x zoom
- Per-page aspect ratios preserved

---

# Fresh Baseline After Worker Fix (2026-01-15)

**Version**: v0.5.2 + ESM worker wrapper fix
**Test Document**: marx-reference-benchmark.pdf (945 pages)

## Key Fix Applied

ESM blob workers don't work in Obsidian/Electron (timeout without error).
Solution: Classic wrapper worker that dynamically imports the ESM module.

## Worker Initialization Metrics
| Metric | Value |
|--------|-------|
| Worker pool init time | 10,439.9ms |
| WASM compile time | 309.6ms |
| Worker count | 4 |
| Per-worker request time | 1.5-2.3ms |

## Render Performance (Cold Cache)
| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| First tile time | 6,338ms | <500ms | Needs work |
| Avg tile render | 3,350ms | <200ms | Needs work |
| P95 tile render | 6,518ms | <500ms | Needs work |
| Total tile renders | 33 | - | - |

## Cache Performance (Initial Load)
| Metric | Value |
|--------|-------|
| Hit rate | 0% (cold) |
| Cache misses | 832 |

## Memory Usage
| Metric | Value |
|--------|-------|
| Peak | 1,245.6 MB |
| Average | 1,221.3 MB |

## Scroll Performance
| Metric | Value |
|--------|-------|
| FPS | 60 |
| Jank events | 0 |

## Analysis

The 10.4s worker pool init time includes timeout/retry logic from before
the ESM worker fix. With workers now initializing correctly, subsequent
measurements should show much faster init times (~300-400ms for WASM compile + worker creation).

## Next Steps

1. Run fresh benchmark with pre-warmed workers
2. Implement skeleton UI for perceived responsiveness
3. Add thumbnail cache for fast re-opens

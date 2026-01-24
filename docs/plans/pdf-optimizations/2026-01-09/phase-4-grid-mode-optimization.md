# Phase 4: Grid Mode Optimization - Design Document

## Executive Summary

Phase 4 focuses on optimizing the Auto-Grid and Canvas display modes by leveraging the multi-worker architecture from Phase 3 for parallel thumbnail generation, adding IndexedDB persistence for instant reopening, and implementing intelligent mode transition cache management.

**Target Metrics:**
| Metric | Baseline | Target | Improvement |
|--------|----------|--------|-------------|
| Auto-Grid 100 pages | 3-5s | <1s | 70-80% faster |
| Auto-Grid 945 pages | 35s | <8s | 75%+ faster |
| IndexedDB hit rate (reopen) | N/A | >80% | Instant on reopen |
| Mode transition | ~100ms | <100ms | Maintain current |

---

## Current State Analysis

### Thumbnail Generation (hybrid-pdf-provider.ts:1050-1162)

**Two-Phase Approach:**
```
Phase 1: First 20 pages → Promise.all() → Parallel but single-threaded
Phase 2: Remaining pages → Batch of 5 with 10ms yields → Sequential
```

**Current Timing (945 pages):**
- Phase 1 (20 pages): 876ms (~43.8ms/page)
- Phase 2 (925 pages): ~34,000ms (~37ms/page)
- Total: 35,067ms

**Bottleneck:** All rendering goes through single MuPDF WASM context, despite having 4 workers available.

### Ripple-From-Center Prefetch (grid-strategy.ts)

Uses Chebyshev distance (chess king moves) to prioritize pages:
```
Ring 0: [center]           → priority 100
Ring 1: [±1 in any dir]    → priority 80
Ring 2: [±2 in any dir]    → priority 60
Ring 3: [±3 in any dir]    → priority 40
```

**Gap:** Priority not respected in thumbnail generation - all pages treated equally.

### Current Architecture Flow

```
Document Load
    │
    ├── generateThumbnails(pageCount) [fire-and-forget]
    │       │
    │       ├── Phase 1: renderPageThumbnail(0-19) → Promise.all()
    │       │       └── Single worker, parallel promises but serialized
    │       │
    │       └── Phase 2: for each batch of 5
    │               └── renderPageThumbnail() → yield 10ms
    │                       └── Sequential through single worker
    │
    └── User sees blank thumbnails until each completes
```

---

## Phase 4 Implementation Plan

### Sub-Phase 4.1: Parallel Thumbnail Generation via Worker Pool

**Goal:** Distribute thumbnail rendering across 4 workers for 4x throughput.

**Files to Modify:**
| File | Change |
|------|--------|
| `hybrid-pdf-provider.ts` | Route thumbnail requests through worker pool |
| `hybrid-document-provider.ts` | Add `renderThumbnailBatch()` method |
| `document-worker-pool-manager.ts` | Add priority-aware rendering |

**Implementation:**

1. **Add batch thumbnail method to pool manager:**
```typescript
// document-worker-pool-manager.ts
async renderThumbnailBatch(
  docId: string,
  pages: number[],
  scale: number,
  priority: 'critical' | 'high' | 'medium' | 'low'
): Promise<Map<number, { data: Uint8Array; width: number; height: number }>>
```

2. **Modify generateThumbnails() in hybrid-pdf-provider.ts:**
```typescript
// BEFORE: Sequential with single worker
for (let i = 0; i < pageCount; i += BATCH_SIZE) {
  await renderBatch(i, BATCH_SIZE);
  await sleep(10);
}

// AFTER: Parallel across worker pool
const workerCount = provider.getWorkerCount();
const pagesPerWorker = Math.ceil(pageCount / workerCount);
const batches = chunk(pages, pagesPerWorker);
await Promise.all(batches.map(batch =>
  provider.renderThumbnailBatch(docId, batch, THUMBNAIL_SCALE)
));
```

3. **Add progress callback for UI feedback:**
```typescript
generateThumbnails(pageCount, onProgress?: (completed: number, total: number) => void)
```

**Expected Improvement:**
- 4 workers × current speed = ~8.75s for 945 pages (vs 35s baseline)
- Phase 1 (20 pages): ~220ms (vs 876ms)

---

### Sub-Phase 4.2: Ripple-Based Priority Queue

**Goal:** Render visible/near pages first, distant pages last.

**Files to Modify:**
| File | Change |
|------|--------|
| `grid-strategy.ts` | Export priority calculation |
| `document-worker-pool-manager.ts` | Add priority queue |
| `hybrid-pdf-provider.ts` | Use priority in thumbnail generation |

**Implementation:**

1. **Add priority levels to pool manager:**
```typescript
type RenderPriority = 'critical' | 'high' | 'medium' | 'low';

interface PrioritizedRequest {
  docId: string;
  pageNum: number;
  scale: number;
  priority: RenderPriority;
}

private priorityQueues = {
  critical: [],  // Visible pages
  high: [],      // Ring 1 neighbors
  medium: [],    // Ring 2-3
  low: []        // Background prefetch
};
```

2. **Modify thumbnail generation to use ripple order:**
```typescript
async generateThumbnailsWithPriority(
  docId: string,
  pageCount: number,
  centerPage: number = 0
): Promise<void> {
  // Get ripple order from grid strategy
  const rippleOrder = gridStrategy.getRipplePrefetchList(
    centerPage, pageCount, pageCount
  );

  // Group by priority
  const critical = rippleOrder.filter(p => p.priority >= 80);
  const high = rippleOrder.filter(p => p.priority >= 60 && p.priority < 80);
  const medium = rippleOrder.filter(p => p.priority >= 40 && p.priority < 60);
  const low = rippleOrder.filter(p => p.priority < 40);

  // Render in priority order
  await this.renderThumbnailBatch(docId, critical.map(p => p.page), 'critical');
  await this.renderThumbnailBatch(docId, high.map(p => p.page), 'high');
  // ... medium and low in background
}
```

**Expected Improvement:**
- First 9 thumbnails (3×3 grid): <200ms
- First 25 thumbnails (5×5 visible): <400ms
- Perceived instant load for visible area

---

### Sub-Phase 4.3: IndexedDB Thumbnail Persistence

**Goal:** Cache thumbnails persistently so reopening a document shows thumbnails instantly.

**Files to Create:**
| File | Purpose | LOC |
|------|---------|-----|
| `thumbnail-idb-cache.ts` | IndexedDB wrapper for thumbnails | ~200 |

**Files to Modify:**
| File | Change |
|------|--------|
| `hybrid-pdf-provider.ts` | Check IDB before rendering |
| `hybrid-document-provider.ts` | Integrate IDB cache |

**Implementation:**

1. **Create IndexedDB cache wrapper:**
```typescript
// thumbnail-idb-cache.ts
import { openDB, DBSchema, IDBPDatabase } from 'idb';

interface ThumbnailDB extends DBSchema {
  thumbnails: {
    key: string;  // `${docHash}-${pageNum}`
    value: {
      docHash: string;
      pageNum: number;
      data: ArrayBuffer;
      width: number;
      height: number;
      createdAt: number;
      accessedAt: number;
    };
    indexes: {
      'by-doc': string;
      'by-access': number;
    };
  };
}

class ThumbnailIDBCache {
  private db: IDBPDatabase<ThumbnailDB> | null = null;

  async initialize(): Promise<void>;
  async get(docHash: string, pageNum: number): Promise<ThumbnailData | null>;
  async set(docHash: string, pageNum: number, data: ThumbnailData): Promise<void>;
  async hasDocument(docHash: string): Promise<boolean>;
  async getDocumentThumbnails(docHash: string): Promise<Map<number, ThumbnailData>>;
  async evictOldest(maxBytes: number): Promise<void>;
  async clear(): Promise<void>;
}
```

2. **Document hash for cache key:**
```typescript
async function getDocumentHash(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data.slice(0, 1024 * 1024));
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}
```

3. **Modify thumbnail generation to check cache first:**
```typescript
async generateThumbnails(docId: string, pageCount: number): Promise<void> {
  const docHash = await this.getDocumentHash(docId);

  // Check if we have cached thumbnails
  const cached = await this.idbCache.getDocumentThumbnails(docHash);
  if (cached.size >= pageCount * 0.9) {
    // 90%+ cached, use them
    for (const [page, data] of cached) {
      this.emitThumbnail(page, data);
    }
    return;
  }

  // Generate missing thumbnails
  const missing = [];
  for (let i = 0; i < pageCount; i++) {
    if (!cached.has(i)) missing.push(i);
  }

  await this.renderThumbnailBatch(docId, missing);
}
```

4. **Cache eviction policy:**
```typescript
const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_CACHE_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

async evict(): Promise<void> {
  // Remove entries older than 30 days
  // Then LRU eviction if still over 100MB
}
```

**Expected Improvement:**
- Reopen document: <100ms (vs 35s cold)
- Storage: ~50-100KB per 100 pages (WebP compressed)

---

### Sub-Phase 4.4: Mode Transition Cache Management

**Goal:** Preserve thumbnails when switching modes, pre-render visible tiles.

**Files to Modify:**
| File | Change |
|------|--------|
| `render-coordinator.ts` | Enhanced mode transition logic |
| `tile-cache-manager.ts` | Mode-aware cache preservation |
| `pdf-infinite-canvas.ts` | Pre-transition rendering |

**Implementation:**

1. **Enhanced mode transition in RenderCoordinator:**
```typescript
async setMode(mode: DisplayMode): Promise<void> {
  const previousMode = this.currentMode;
  this.currentMode = mode;

  // Pre-transition: warm cache for new mode
  if (mode === 'grid' || mode === 'canvas') {
    // Ensure thumbnails are ready
    await this.ensureThumbnailsReady();
  } else if (mode === 'vertical-scroll' || 'horizontal-scroll') {
    // Pre-render first few pages at scroll scale
    await this.prerenderScrollPages(0, 5);
  }

  // Notify cache manager
  this.cacheManager.onModeTransition(previousMode, mode);
}
```

2. **Cache preservation rules:**
```typescript
// tile-cache-manager.ts
onModeTransition(from: DisplayMode, to: DisplayMode): void {
  // Grid → Scroll: Keep thumbnails in L2, they become prefetch data
  // Scroll → Grid: Keep scroll tiles in L2, useful for zoom
  // Always preserve L3 (metadata)

  if (from === 'grid' && (to === 'vertical-scroll' || to === 'horizontal-scroll')) {
    // Thumbnails are lower priority but still useful
    this.demoteThumbnailsToL2();
  }

  // Clear L1 for fresh visible content
  this.l1Cache.clear();
}
```

3. **Pre-render visible pages before transition:**
```typescript
// pdf-infinite-canvas.ts
async prepareForModeTransition(newMode: DisplayMode): Promise<void> {
  const visiblePages = this.getVisiblePageRange();

  // Render at appropriate scale for new mode
  const scale = newMode.startsWith('scroll') ? 2.0 : 0.5;

  await Promise.all(
    visiblePages.map(page =>
      this.provider.getPageImage(page, { scale, priority: 'critical' })
    )
  );
}
```

**Expected Improvement:**
- Mode transition remains <100ms
- No blank pages during transition
- Smooth visual continuity

---

## Task List Summary

### Sub-Phase 4.1: Parallel Thumbnail Generation (Priority: P0)
- [ ] 4.1.1: Add `renderThumbnailBatch()` to DocumentWorkerPoolManager
- [ ] 4.1.2: Modify `generateThumbnails()` in hybrid-pdf-provider.ts
- [ ] 4.1.3: Add progress callback for thumbnail generation
- [ ] 4.1.4: Update HybridDocumentProvider to use batch rendering
- [ ] 4.1.5: Test with 945-page PDF, verify <10s generation

### Sub-Phase 4.2: Ripple-Based Priority Queue (Priority: P1)
- [ ] 4.2.1: Export priority calculation from grid-strategy.ts
- [ ] 4.2.2: Add priority queues to DocumentWorkerPoolManager
- [ ] 4.2.3: Modify generateThumbnails to use ripple order
- [ ] 4.2.4: Test visible-first rendering in auto-grid mode
- [ ] 4.2.5: Verify first 9 thumbnails render in <200ms

### Sub-Phase 4.3: IndexedDB Thumbnail Persistence (Priority: P1)
- [ ] 4.3.1: Create thumbnail-idb-cache.ts with idb library
- [ ] 4.3.2: Implement document hash generation
- [ ] 4.3.3: Add cache check before thumbnail generation
- [ ] 4.3.4: Implement LRU eviction (100MB limit, 30-day expiry)
- [ ] 4.3.5: Integrate with hybrid-pdf-provider.ts
- [ ] 4.3.6: Test reopen performance (target: <100ms)

### Sub-Phase 4.4: Mode Transition Cache Management (Priority: P2)
- [ ] 4.4.1: Enhance setMode() in RenderCoordinator
- [ ] 4.4.2: Add mode-aware cache preservation rules
- [ ] 4.4.3: Implement pre-transition rendering
- [ ] 4.4.4: Test all 5 mode transitions
- [ ] 4.4.5: Verify no blank pages during transition

### Testing & Validation (Priority: P0)
- [ ] 4.5.1: Benchmark auto-grid with 100-page PDF
- [ ] 4.5.2: Benchmark auto-grid with 945-page PDF
- [ ] 4.5.3: Test IndexedDB hit rate on reopen
- [ ] 4.5.4: Test mode transitions (all 20 combinations)
- [ ] 4.5.5: Memory usage validation (<500MB budget)
- [ ] 4.5.6: Capture Phase 4 metrics JSON

---

## Dependencies

- **Phase 3 Complete:** ✅ Multi-worker architecture available
- **idb library:** Need to add `idb` npm package for IndexedDB wrapper
- **crypto.subtle:** Available in Electron for document hashing

## Rollback Strategy

| Component | Rollback Flag | Effect |
|-----------|---------------|--------|
| Parallel generation | `workerCount = 1` | Falls back to sequential |
| Priority queue | Remove priority params | FIFO order |
| IndexedDB cache | `useThumbnailCache = false` | Skip IDB, always render |
| Mode transition | N/A | No changes to existing behavior |

## Success Criteria

- [ ] Auto-Grid 100 pages loads in <1s
- [ ] Auto-Grid 945 pages loads in <10s
- [ ] IndexedDB hit rate >80% on reopen
- [ ] Mode transitions <100ms
- [ ] No memory regression (stays <500MB)
- [ ] No visual regressions in any mode

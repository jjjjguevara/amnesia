/**
 * Adaptive Prefetcher
 *
 * Intelligent page prefetching based on scroll behavior and reading patterns.
 * Optimizes for:
 * - Scroll direction (prefetch more in direction of travel)
 * - Scroll velocity (prefetch more during fast scrolling)
 * - Reading patterns (dwell time on pages)
 *
 * Uses a priority queue to ensure important pages are fetched first.
 */

export type PrefetchStrategy = 'none' | 'fixed' | 'adaptive';

export type PrefetchPriority = 'high' | 'medium' | 'low';

export interface PrefetchRequest {
  page: number;
  priority: PrefetchPriority;
  timestamp: number;
}

export interface AdaptivePrefetcherConfig {
  /** Prefetch strategy. Default: 'adaptive' */
  strategy?: PrefetchStrategy;
  /** Base number of pages to prefetch. Default: 2 */
  basePrefetchCount?: number;
  /** Maximum pages to prefetch. Default: 8 */
  maxPrefetchCount?: number;
  /** Minimum pages to prefetch. Default: 1 */
  minPrefetchCount?: number;
  /** Velocity threshold for fast scrolling (pages/second). Default: 2 */
  fastScrollThreshold?: number;
  /** Time window for velocity calculation (ms). Default: 500 */
  velocityWindow?: number;
  /** Delay before processing queue (ms). Default: 50 */
  queueProcessDelay?: number;
}

export interface PrefetchStats {
  strategy: PrefetchStrategy;
  currentDirection: 'forward' | 'backward' | 'unknown';
  scrollVelocity: number;
  queueSize: number;
  highPriorityCount: number;
  mediumPriorityCount: number;
  lowPriorityCount: number;
  prefetchedPages: number[];
}

/**
 * Adaptive prefetcher with scroll velocity tracking and priority queue
 */
export class AdaptivePrefetcher {
  private config: Required<AdaptivePrefetcherConfig>;

  // Scroll tracking
  private scrollHistory: Array<{ page: number; timestamp: number }> = [];
  private currentDirection: 'forward' | 'backward' | 'unknown' = 'unknown';
  private scrollVelocity = 0; // pages per second

  // Dwell time tracking (time spent on each page)
  private dwellTimes: Map<number, number> = new Map();
  private lastPageVisit: { page: number; timestamp: number } | null = null;

  // Priority queue (separate arrays for O(1) priority access)
  private highPriorityQueue: Set<number> = new Set();
  private mediumPriorityQueue: Set<number> = new Set();
  private lowPriorityQueue: Set<number> = new Set();

  // Processing state
  private processTimeout: ReturnType<typeof setTimeout> | null = null;
  private isPaused = false;

  // Page state
  private pageCount = 0;
  private currentPage = 1;
  private cachedPages: Set<number> = new Set();
  private prefetchedPages: Set<number> = new Set();

  // Fetch callback
  private fetchCallback: ((page: number) => Promise<void>) | null = null;

  constructor(config: AdaptivePrefetcherConfig = {}) {
    this.config = {
      strategy: config.strategy ?? 'adaptive',
      basePrefetchCount: config.basePrefetchCount ?? 2,
      maxPrefetchCount: config.maxPrefetchCount ?? 8,
      minPrefetchCount: config.minPrefetchCount ?? 1,
      fastScrollThreshold: config.fastScrollThreshold ?? 2,
      velocityWindow: config.velocityWindow ?? 500,
      queueProcessDelay: config.queueProcessDelay ?? 50,
    };
  }

  /**
   * Initialize with page count and fetch callback
   */
  initialize(
    pageCount: number,
    fetchCallback: (page: number) => Promise<void>
  ): void {
    this.pageCount = pageCount;
    this.fetchCallback = fetchCallback;
    this.reset();
  }

  /**
   * Notify prefetcher of page change
   */
  onPageChange(newPage: number): void {
    const now = Date.now();

    // Update dwell time for previous page
    if (this.lastPageVisit) {
      const dwellTime = now - this.lastPageVisit.timestamp;
      const existingDwell = this.dwellTimes.get(this.lastPageVisit.page) ?? 0;
      this.dwellTimes.set(this.lastPageVisit.page, existingDwell + dwellTime);
    }

    // Track page visit
    this.lastPageVisit = { page: newPage, timestamp: now };

    // Update scroll history
    this.scrollHistory.push({ page: newPage, timestamp: now });

    // Keep only recent history
    const cutoff = now - this.config.velocityWindow * 2;
    this.scrollHistory = this.scrollHistory.filter(h => h.timestamp > cutoff);

    // Calculate direction and velocity
    this.updateScrollMetrics(newPage);

    // Update current page
    this.currentPage = newPage;

    // Schedule prefetch
    if (this.config.strategy !== 'none') {
      this.schedulePrefetch();
    }
  }

  /**
   * Mark a page as cached (already available)
   */
  markCached(page: number): void {
    this.cachedPages.add(page);
    // Remove from queues if present
    this.highPriorityQueue.delete(page);
    this.mediumPriorityQueue.delete(page);
    this.lowPriorityQueue.delete(page);
  }

  /**
   * Mark multiple pages as cached
   */
  markCachedBatch(pages: number[]): void {
    for (const page of pages) {
      this.markCached(page);
    }
  }

  /**
   * Clear cached pages (e.g., after cache eviction)
   */
  clearCached(page?: number): void {
    if (page !== undefined) {
      this.cachedPages.delete(page);
    } else {
      this.cachedPages.clear();
    }
  }

  /**
   * Pause prefetching
   */
  pause(): void {
    this.isPaused = true;
    if (this.processTimeout) {
      clearTimeout(this.processTimeout);
      this.processTimeout = null;
    }
  }

  /**
   * Resume prefetching
   */
  resume(): void {
    this.isPaused = false;
    this.schedulePrefetch();
  }

  /**
   * Get prefetch statistics
   */
  getStats(): PrefetchStats {
    return {
      strategy: this.config.strategy,
      currentDirection: this.currentDirection,
      scrollVelocity: this.scrollVelocity,
      queueSize: this.highPriorityQueue.size + this.mediumPriorityQueue.size + this.lowPriorityQueue.size,
      highPriorityCount: this.highPriorityQueue.size,
      mediumPriorityCount: this.mediumPriorityQueue.size,
      lowPriorityCount: this.lowPriorityQueue.size,
      prefetchedPages: Array.from(this.prefetchedPages),
    };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<AdaptivePrefetcherConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * Reset prefetcher state
   */
  reset(): void {
    this.scrollHistory = [];
    this.currentDirection = 'unknown';
    this.scrollVelocity = 0;
    this.dwellTimes.clear();
    this.lastPageVisit = null;
    this.highPriorityQueue.clear();
    this.mediumPriorityQueue.clear();
    this.lowPriorityQueue.clear();
    this.prefetchedPages.clear();
    this.currentPage = 1;

    if (this.processTimeout) {
      clearTimeout(this.processTimeout);
      this.processTimeout = null;
    }
  }

  /**
   * Destroy prefetcher
   */
  destroy(): void {
    this.reset();
    this.fetchCallback = null;
    this.cachedPages.clear();
  }

  // Private methods

  /**
   * Update scroll direction and velocity from history
   */
  private updateScrollMetrics(newPage: number): void {
    const now = Date.now();
    const windowStart = now - this.config.velocityWindow;

    // Get recent scroll events
    const recentEvents = this.scrollHistory.filter(h => h.timestamp > windowStart);

    if (recentEvents.length < 2) {
      this.scrollVelocity = 0;
      return;
    }

    // Calculate direction from last few events
    const lastPages = recentEvents.slice(-3).map(h => h.page);
    const forwardCount = lastPages.filter((p, i) => i > 0 && p > lastPages[i - 1]).length;
    const backwardCount = lastPages.filter((p, i) => i > 0 && p < lastPages[i - 1]).length;

    if (forwardCount > backwardCount) {
      this.currentDirection = 'forward';
    } else if (backwardCount > forwardCount) {
      this.currentDirection = 'backward';
    }

    // Calculate velocity (pages per second)
    const firstEvent = recentEvents[0];
    const lastEvent = recentEvents[recentEvents.length - 1];
    const timeDelta = (lastEvent.timestamp - firstEvent.timestamp) / 1000;

    if (timeDelta > 0) {
      const pageDelta = Math.abs(lastEvent.page - firstEvent.page);
      this.scrollVelocity = pageDelta / timeDelta;
    }
  }

  /**
   * Schedule prefetch with debouncing
   */
  private schedulePrefetch(): void {
    if (this.isPaused || this.config.strategy === 'none') return;

    if (this.processTimeout) {
      clearTimeout(this.processTimeout);
    }

    this.processTimeout = setTimeout(() => {
      this.processTimeout = null;
      this.queuePrefetchPages();
      this.processQueue();
    }, this.config.queueProcessDelay);
  }

  /**
   * Add pages to prefetch queue based on strategy
   */
  private queuePrefetchPages(): void {
    const pagesToPrefetch = this.getPagesToPrefetch();

    for (const { page, priority } of pagesToPrefetch) {
      // Skip if already cached or queued
      if (this.cachedPages.has(page)) continue;
      if (this.prefetchedPages.has(page)) continue;
      if (this.isQueued(page)) continue;

      // Add to appropriate queue
      this.addToQueue(page, priority);
    }
  }

  /**
   * Get pages to prefetch with priorities
   */
  private getPagesToPrefetch(): Array<{ page: number; priority: PrefetchPriority }> {
    const result: Array<{ page: number; priority: PrefetchPriority }> = [];

    if (this.config.strategy === 'fixed') {
      // Fixed strategy: always prefetch same number of pages ahead/behind
      const count = this.config.basePrefetchCount;

      for (let i = 1; i <= count; i++) {
        const ahead = this.currentPage + i;
        const behind = this.currentPage - i;

        if (ahead <= this.pageCount) {
          result.push({ page: ahead, priority: i === 1 ? 'high' : 'medium' });
        }
        if (behind >= 1) {
          result.push({ page: behind, priority: 'medium' });
        }
      }
    } else if (this.config.strategy === 'adaptive') {
      // Adaptive strategy: adjust based on scroll behavior
      const prefetchCount = this.getAdaptivePrefetchCount();
      const forwardBias = this.getDirectionBias();

      // Calculate how many pages in each direction
      const forwardCount = Math.ceil(prefetchCount * forwardBias);
      const backwardCount = prefetchCount - forwardCount;

      // Add forward pages
      for (let i = 1; i <= forwardCount; i++) {
        const page = this.currentPage + i;
        if (page <= this.pageCount) {
          const priority = this.getPagePriority(page, i, 'forward');
          result.push({ page, priority });
        }
      }

      // Add backward pages
      for (let i = 1; i <= backwardCount; i++) {
        const page = this.currentPage - i;
        if (page >= 1) {
          const priority = this.getPagePriority(page, i, 'backward');
          result.push({ page, priority });
        }
      }
    }

    return result;
  }

  /**
   * Get adaptive prefetch count based on scroll velocity
   */
  private getAdaptivePrefetchCount(): number {
    const { basePrefetchCount, minPrefetchCount, maxPrefetchCount, fastScrollThreshold } = this.config;

    if (this.scrollVelocity >= fastScrollThreshold) {
      // Fast scrolling: prefetch more pages
      const velocityMultiplier = Math.min(this.scrollVelocity / fastScrollThreshold, 3);
      return Math.min(
        Math.ceil(basePrefetchCount * velocityMultiplier),
        maxPrefetchCount
      );
    }

    return Math.max(basePrefetchCount, minPrefetchCount);
  }

  /**
   * Get direction bias (0.5 = even, 1.0 = all forward, 0.0 = all backward)
   */
  private getDirectionBias(): number {
    switch (this.currentDirection) {
      case 'forward':
        return 0.75; // 75% forward, 25% backward
      case 'backward':
        return 0.25; // 25% forward, 75% backward
      default:
        return 0.6; // Slight forward bias for unknown
    }
  }

  /**
   * Get priority for a page based on distance and direction
   */
  private getPagePriority(
    page: number,
    distance: number,
    direction: 'forward' | 'backward'
  ): PrefetchPriority {
    // Immediate neighbors are always high priority
    if (distance === 1) {
      return 'high';
    }

    // Pages in scroll direction get higher priority
    if (direction === this.currentDirection && distance <= 3) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Check if page is in any queue
   */
  private isQueued(page: number): boolean {
    return this.highPriorityQueue.has(page) ||
           this.mediumPriorityQueue.has(page) ||
           this.lowPriorityQueue.has(page);
  }

  /**
   * Add page to priority queue
   * Public to allow external modules (e.g., SpatialPrefetcher) to queue pages
   */
  addToQueue(page: number, priority: PrefetchPriority): void {
    switch (priority) {
      case 'high':
        this.highPriorityQueue.add(page);
        break;
      case 'medium':
        this.mediumPriorityQueue.add(page);
        break;
      case 'low':
        this.lowPriorityQueue.add(page);
        break;
    }
  }

  /**
   * Get next page from queue (respects priority)
   */
  private getNextFromQueue(): number | null {
    // High priority first
    if (this.highPriorityQueue.size > 0) {
      const iter = this.highPriorityQueue.values().next();
      if (!iter.done && iter.value !== undefined) {
        const page = iter.value;
        this.highPriorityQueue.delete(page);
        return page;
      }
    }

    // Then medium priority
    if (this.mediumPriorityQueue.size > 0) {
      const iter = this.mediumPriorityQueue.values().next();
      if (!iter.done && iter.value !== undefined) {
        const page = iter.value;
        this.mediumPriorityQueue.delete(page);
        return page;
      }
    }

    // Finally low priority
    if (this.lowPriorityQueue.size > 0) {
      const iter = this.lowPriorityQueue.values().next();
      if (!iter.done && iter.value !== undefined) {
        const page = iter.value;
        this.lowPriorityQueue.delete(page);
        return page;
      }
    }

    return null;
  }

  /**
   * Process the prefetch queue
   */
  private async processQueue(): Promise<void> {
    if (this.isPaused || !this.fetchCallback) return;

    // Process up to 3 pages concurrently
    const CONCURRENT_FETCHES = 3;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < CONCURRENT_FETCHES; i++) {
      const page = this.getNextFromQueue();
      if (page === null) break;

      // Skip if already cached (might have been cached while queued)
      if (this.cachedPages.has(page)) continue;

      this.prefetchedPages.add(page);

      promises.push(
        this.fetchCallback(page).catch((error) => {
          // Remove from prefetched on error (allow retry)
          this.prefetchedPages.delete(page);
          console.warn(`[Prefetch] Failed to prefetch page ${page}:`, error);
        })
      );
    }

    // Wait for current batch
    if (promises.length > 0) {
      await Promise.all(promises);
    }

    // Continue processing if more in queue
    const hasMore = this.highPriorityQueue.size > 0 ||
                    this.mediumPriorityQueue.size > 0 ||
                    this.lowPriorityQueue.size > 0;

    if (hasMore && !this.isPaused) {
      // Small delay between batches to avoid overwhelming
      setTimeout(() => this.processQueue(), 50);
    }
  }
}

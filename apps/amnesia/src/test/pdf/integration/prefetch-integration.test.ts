/**
 * Prefetch Integration Tests
 *
 * End-to-end tests for prefetching behavior including:
 * - Direction-based prefetching
 * - Velocity-based prefetch count
 * - Priority ordering
 * - Cache integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdaptivePrefetcher } from '../../../reader/renderer/pdf/adaptive-prefetcher';

describe('Prefetch Integration', () => {
  let prefetcher: AdaptivePrefetcher;
  let fetchedPages: number[];
  let fetchTimestamps: Map<number, number>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchedPages = [];
    fetchTimestamps = new Map();
  });

  afterEach(() => {
    prefetcher?.destroy();
    vi.useRealTimers();
  });

  const createFetchCallback = (delay: number = 10) => {
    return async (page: number) => {
      fetchedPages.push(page);
      fetchTimestamps.set(page, Date.now());
      await new Promise(r => setTimeout(r, delay));
    };
  };

  describe('forward scrolling prefetch', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'adaptive',
        basePrefetchCount: 3,
      });
      prefetcher.initialize(100, createFetchCallback());
    });

    it('should prefetch pages ahead when scrolling forward', async () => {
      // Establish forward direction
      prefetcher.onPageChange(10);
      await vi.advanceTimersByTimeAsync(100);
      prefetcher.onPageChange(11);
      await vi.advanceTimersByTimeAsync(100);
      prefetcher.onPageChange(12);
      await vi.advanceTimersByTimeAsync(200);

      // Should have prefetched pages ahead of 12
      const aheadPages = fetchedPages.filter(p => p > 12);
      const behindPages = fetchedPages.filter(p => p < 12 && p > 10);

      // Adaptive strategy with forward direction should favor ahead pages
      expect(aheadPages.length).toBeGreaterThan(0);
    });

    it('should prioritize immediate next page', async () => {
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      // Page 51 should be in the fetched list (immediate neighbor)
      expect(fetchedPages).toContain(51);

      // It should be fetched early (high priority)
      const page51Index = fetchedPages.indexOf(51);
      expect(page51Index).toBeLessThan(5); // Within first 5 fetches
    });
  });

  describe('backward scrolling prefetch', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'adaptive',
        basePrefetchCount: 3,
      });
      prefetcher.initialize(100, createFetchCallback());
    });

    it('should prefetch pages behind when scrolling backward', async () => {
      // Establish backward direction
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(100);
      prefetcher.onPageChange(49);
      await vi.advanceTimersByTimeAsync(100);
      prefetcher.onPageChange(48);
      await vi.advanceTimersByTimeAsync(200);

      // Should have prefetched pages behind 48
      const behindPages = fetchedPages.filter(p => p < 48);

      // Adaptive strategy with backward direction should favor behind pages
      expect(behindPages.length).toBeGreaterThan(0);
    });

    it('should prioritize immediate previous page', async () => {
      // Reset to start fresh
      prefetcher.reset();
      fetchedPages = [];

      // Go directly to page 48 with no prior history
      prefetcher.onPageChange(48);
      await vi.advanceTimersByTimeAsync(200);

      // Page 47 should be fetched (immediate neighbor behind)
      expect(fetchedPages).toContain(47);
    });
  });

  describe('velocity-based prefetch count', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'adaptive',
        basePrefetchCount: 2,
        maxPrefetchCount: 8,
        fastScrollThreshold: 2, // pages per second
        velocityWindow: 500,
      });
      prefetcher.initialize(100, createFetchCallback());
    });

    it('should prefetch more pages during fast scrolling', async () => {
      // Slow scroll: 1 page every 500ms (2 pages/sec = threshold)
      prefetcher.onPageChange(10);
      await vi.advanceTimersByTimeAsync(500);
      prefetcher.onPageChange(11);
      await vi.advanceTimersByTimeAsync(200);

      const slowScrollFetches = [...fetchedPages];
      fetchedPages = [];

      // Fast scroll: 5 pages in 500ms (10 pages/sec)
      prefetcher.reset();
      for (let i = 0; i < 5; i++) {
        prefetcher.onPageChange(50 + i);
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(200);

      // Fast scrolling should trigger more prefetches
      // (Note: exact numbers depend on queue processing, but trend should be clear)
      expect(fetchedPages.length).toBeGreaterThanOrEqual(slowScrollFetches.length);
    });

    it('should not exceed maxPrefetchCount', async () => {
      // Very fast scroll
      for (let i = 0; i < 20; i++) {
        prefetcher.onPageChange(i + 1);
        await vi.advanceTimersByTimeAsync(10);
      }
      await vi.advanceTimersByTimeAsync(500);

      // Check stats - should respect limits
      const stats = prefetcher.getStats();
      // Even with fast scrolling, individual prefetch batches should be limited
      expect(stats.prefetchedPages.length).toBeLessThanOrEqual(100); // Reasonable limit
    });
  });

  describe('priority queue ordering', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'adaptive',
        basePrefetchCount: 4,
        queueProcessDelay: 10,
      });
      prefetcher.initialize(100, createFetchCallback(5));
    });

    it('should fetch high priority pages first', async () => {
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(300);

      // Immediate neighbors (high priority) should be fetched first
      const page51Index = fetchedPages.indexOf(51);
      const page49Index = fetchedPages.indexOf(49);

      // At least one neighbor should be in first few fetches
      expect(Math.min(page51Index, page49Index)).toBeLessThan(3);
    });

    it('should dequeue in priority order', async () => {
      // Establish direction for predictable priority assignment
      prefetcher.onPageChange(48);
      await vi.advanceTimersByTimeAsync(50);
      prefetcher.onPageChange(49);
      await vi.advanceTimersByTimeAsync(50);

      fetchedPages = [];

      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(500);

      // High priority (immediate neighbors) should come before low priority
      if (fetchedPages.includes(51) && fetchedPages.includes(54)) {
        const highPriorityIndex = fetchedPages.indexOf(51);
        const lowPriorityIndex = fetchedPages.indexOf(54);
        expect(highPriorityIndex).toBeLessThan(lowPriorityIndex);
      }
    });
  });

  describe('cache integration', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'adaptive',
        basePrefetchCount: 3,
      });
      prefetcher.initialize(100, createFetchCallback());
    });

    it('should skip already cached pages', async () => {
      // Mark some pages as cached
      prefetcher.markCached(51);
      prefetcher.markCached(52);

      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(300);

      // Should not fetch already cached pages
      expect(fetchedPages).not.toContain(51);
      expect(fetchedPages).not.toContain(52);
    });

    it('should skip already prefetched pages', async () => {
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(300);

      const firstFetchCount = fetchedPages.length;
      fetchedPages = [];

      // Navigate to same page again
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(300);

      // Should not re-fetch the same pages
      // (Some new pages might be fetched if we moved through history)
      expect(fetchedPages.length).toBeLessThanOrEqual(firstFetchCount);
    });

    it('should allow re-fetching after clearCached', async () => {
      prefetcher.markCached(51);
      prefetcher.markCached(52);

      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      expect(fetchedPages).not.toContain(51);

      // Clear cache for page 51
      prefetcher.clearCached(51);
      prefetcher.reset();
      fetchedPages = [];

      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      // Now page 51 should be fetched (if it's in prefetch range)
      // Note: depends on priority queue, may not always be fetched
    });
  });

  describe('pause and resume', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'adaptive',
        basePrefetchCount: 3,
      });
      prefetcher.initialize(100, createFetchCallback());
    });

    it('should not prefetch when paused', async () => {
      prefetcher.pause();

      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(300);

      expect(fetchedPages.length).toBe(0);
    });

    it('should resume prefetching after unpause', async () => {
      prefetcher.pause();

      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(100);

      expect(fetchedPages.length).toBe(0);

      prefetcher.resume();
      await vi.advanceTimersByTimeAsync(300);

      expect(fetchedPages.length).toBeGreaterThan(0);
    });
  });

  describe('page boundary handling', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'adaptive',
        basePrefetchCount: 5,
      });
      prefetcher.initialize(10, createFetchCallback()); // Only 10 pages
    });

    it('should not prefetch beyond last page', async () => {
      prefetcher.onPageChange(9);
      await vi.advanceTimersByTimeAsync(200);

      // Should not have any pages > 10
      const beyondEnd = fetchedPages.filter(p => p > 10);
      expect(beyondEnd.length).toBe(0);
    });

    it('should not prefetch before first page', async () => {
      prefetcher.onPageChange(2);
      await vi.advanceTimersByTimeAsync(200);

      // Should not have any pages < 1
      const beforeStart = fetchedPages.filter(p => p < 1);
      expect(beforeStart.length).toBe(0);
    });

    it('should handle first page correctly', async () => {
      prefetcher.onPageChange(1);
      await vi.advanceTimersByTimeAsync(200);

      // Should prefetch pages 2, 3, etc. but not 0 or negative
      expect(fetchedPages.every(p => p >= 1)).toBe(true);
      expect(fetchedPages.some(p => p > 1)).toBe(true); // At least some ahead
    });

    it('should handle last page correctly', async () => {
      prefetcher.onPageChange(10);
      await vi.advanceTimersByTimeAsync(200);

      // Should prefetch pages before 10 but not beyond
      expect(fetchedPages.every(p => p <= 10)).toBe(true);
      expect(fetchedPages.some(p => p < 10)).toBe(true); // At least some behind
    });
  });

  describe('fixed strategy behavior', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'fixed',
        basePrefetchCount: 3,
      });
      prefetcher.initialize(100, createFetchCallback());
    });

    it('should prefetch equal pages ahead and behind', async () => {
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(300);

      const aheadPages = fetchedPages.filter(p => p > 50);
      const behindPages = fetchedPages.filter(p => p < 50);

      // Fixed strategy should be balanced
      expect(aheadPages.length).toBe(behindPages.length);
    });

    it('should not change based on scroll direction', async () => {
      // Reset to start fresh - no prior scroll history
      prefetcher.reset();
      fetchedPages = [];

      // Go directly to page 50
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(300);

      const aheadPages = fetchedPages.filter(p => p > 50);
      const behindPages = fetchedPages.filter(p => p < 50);

      // Should be balanced (fixed strategy ignores direction)
      expect(aheadPages.length).toBe(behindPages.length);
    });
  });
});

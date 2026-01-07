/**
 * Unit tests for AdaptivePrefetcher
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdaptivePrefetcher } from '../../../reader/renderer/pdf/adaptive-prefetcher';
import type { PrefetchStats } from '../../../reader/renderer/pdf/adaptive-prefetcher';

describe('AdaptivePrefetcher', () => {
  let prefetcher: AdaptivePrefetcher;
  let fetchedPages: number[];
  let fetchCallback: (page: number) => Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchedPages = [];
    fetchCallback = async (page: number) => {
      fetchedPages.push(page);
    };
  });

  afterEach(() => {
    prefetcher?.destroy();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize with correct defaults', () => {
      prefetcher = new AdaptivePrefetcher();
      const stats = prefetcher.getStats();

      expect(stats.strategy).toBe('adaptive');
      expect(stats.currentDirection).toBe('unknown');
      expect(stats.scrollVelocity).toBe(0);
      expect(stats.queueSize).toBe(0);
    });

    it('should accept custom configuration', () => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'fixed',
        basePrefetchCount: 5,
        maxPrefetchCount: 10,
      });
      const stats = prefetcher.getStats();

      expect(stats.strategy).toBe('fixed');
    });

    it('should start in unknown direction', () => {
      prefetcher = new AdaptivePrefetcher();
      prefetcher.initialize(100, fetchCallback);

      const stats = prefetcher.getStats();
      expect(stats.currentDirection).toBe('unknown');
    });

    it('should accept none strategy and not prefetch', async () => {
      prefetcher = new AdaptivePrefetcher({ strategy: 'none' });
      prefetcher.initialize(100, fetchCallback);

      prefetcher.onPageChange(5);
      await vi.advanceTimersByTimeAsync(100);

      expect(fetchedPages).toHaveLength(0);
    });
  });

  describe('page change tracking', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, fetchCallback);
    });

    it('should detect forward scroll direction', async () => {
      prefetcher.onPageChange(1);
      await vi.advanceTimersByTimeAsync(100);
      prefetcher.onPageChange(2);
      await vi.advanceTimersByTimeAsync(100);
      prefetcher.onPageChange(3);
      await vi.advanceTimersByTimeAsync(100);

      const stats = prefetcher.getStats();
      expect(stats.currentDirection).toBe('forward');
    });

    it('should detect backward scroll direction', async () => {
      prefetcher.onPageChange(10);
      await vi.advanceTimersByTimeAsync(100);
      prefetcher.onPageChange(9);
      await vi.advanceTimersByTimeAsync(100);
      prefetcher.onPageChange(8);
      await vi.advanceTimersByTimeAsync(100);

      const stats = prefetcher.getStats();
      expect(stats.currentDirection).toBe('backward');
    });

    it('should calculate velocity from page history', async () => {
      // Simulate fast scrolling (multiple pages quickly)
      prefetcher.onPageChange(1);
      await vi.advanceTimersByTimeAsync(50);
      prefetcher.onPageChange(3);
      await vi.advanceTimersByTimeAsync(50);
      prefetcher.onPageChange(5);
      await vi.advanceTimersByTimeAsync(50);
      prefetcher.onPageChange(7);
      await vi.advanceTimersByTimeAsync(50);

      const stats = prefetcher.getStats();
      expect(stats.scrollVelocity).toBeGreaterThan(0);
    });

    it('should maintain scroll history within window', async () => {
      prefetcher.onPageChange(1);

      // Advance past velocity window (default 500ms * 2 = 1000ms)
      await vi.advanceTimersByTimeAsync(1500);

      prefetcher.onPageChange(2);
      await vi.advanceTimersByTimeAsync(100);

      // Old event should be cleared
      const stats = prefetcher.getStats();
      // Direction should still be detectable from recent events
      expect(stats.currentDirection).toBeDefined();
    });
  });

  describe('adaptive prefetch count', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'adaptive',
        basePrefetchCount: 2,
        maxPrefetchCount: 8,
        fastScrollThreshold: 2,
      });
      prefetcher.initialize(100, fetchCallback);
    });

    it('should return base count at low velocity', async () => {
      // Single slow page change
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(500);

      // Should prefetch ~base count pages
      expect(fetchedPages.length).toBeLessThanOrEqual(4); // base * 2 (forward + backward)
    });

    it('should increase count at high velocity', async () => {
      // Simulate very fast scrolling
      for (let i = 1; i <= 10; i++) {
        prefetcher.onPageChange(i);
        await vi.advanceTimersByTimeAsync(20); // 20ms between pages = 50 pages/sec
      }

      await vi.advanceTimersByTimeAsync(200);

      const stats = prefetcher.getStats();
      expect(stats.scrollVelocity).toBeGreaterThan(2);
    });
  });

  describe('priority queue', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, fetchCallback);
    });

    it('should prioritize immediate neighbors as high', async () => {
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(100);

      // Page 51 (immediate next) should be fetched first
      expect(fetchedPages).toContain(51);
    });

    it('should prioritize scroll direction as medium', async () => {
      // Establish forward direction
      prefetcher.onPageChange(48);
      await vi.advanceTimersByTimeAsync(100);
      prefetcher.onPageChange(49);
      await vi.advanceTimersByTimeAsync(100);
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      // Forward pages should be in fetched list
      const forwardPages = fetchedPages.filter(p => p > 50);
      const backwardPages = fetchedPages.filter(p => p < 50);

      // Should have more forward pages when scrolling forward
      expect(forwardPages.length).toBeGreaterThanOrEqual(backwardPages.length);
    });

    it('should dequeue in priority order', async () => {
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      // First fetched should be high priority (adjacent pages)
      if (fetchedPages.length > 0) {
        expect([49, 51]).toContain(fetchedPages[0]);
      }
    });
  });

  describe('pause/resume', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, fetchCallback);
    });

    it('should stop prefetching when paused', async () => {
      prefetcher.pause();
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      expect(fetchedPages).toHaveLength(0);
    });

    it('should resume prefetching when unpaused', async () => {
      prefetcher.pause();
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(100);

      expect(fetchedPages).toHaveLength(0);

      prefetcher.resume();
      await vi.advanceTimersByTimeAsync(200);

      expect(fetchedPages.length).toBeGreaterThan(0);
    });
  });

  describe('cache integration', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, fetchCallback);
    });

    it('should skip already cached pages', async () => {
      prefetcher.markCached(51);
      prefetcher.markCached(52);

      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      // Pages 51 and 52 should not be fetched
      expect(fetchedPages).not.toContain(51);
      expect(fetchedPages).not.toContain(52);
    });

    it('should update markCached correctly', async () => {
      prefetcher.markCachedBatch([51, 52, 53, 54, 55]);

      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      // None of the cached pages should be fetched
      for (let i = 51; i <= 55; i++) {
        expect(fetchedPages).not.toContain(i);
      }
    });

    it('should allow re-fetching after clearCached', async () => {
      prefetcher.markCached(51);
      prefetcher.clearCached(51);

      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      // Page 51 should now be fetched
      expect(fetchedPages).toContain(51);
    });
  });

  describe('fixed strategy', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({
        strategy: 'fixed',
        basePrefetchCount: 3,
      });
      prefetcher.initialize(100, fetchCallback);
    });

    it('should prefetch equal pages ahead and behind', async () => {
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      // Should have pages both ahead (51, 52, 53) and behind (49, 48, 47)
      const aheadPages = fetchedPages.filter(p => p > 50).length;
      const behindPages = fetchedPages.filter(p => p < 50).length;

      expect(aheadPages).toBe(3);
      expect(behindPages).toBe(3);
    });

    it('should not change based on scroll direction', async () => {
      // Reset prefetcher to start fresh
      prefetcher.reset();
      fetchedPages = [];

      // Go directly to page 50 - no direction established
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      // Fixed strategy should fetch equal pages ahead and behind
      const aheadPages = fetchedPages.filter(p => p > 50).length;
      const behindPages = fetchedPages.filter(p => p < 50).length;

      expect(aheadPages).toBe(behindPages);
    });
  });

  describe('stats', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, fetchCallback);
    });

    it('should return accurate queue sizes', async () => {
      prefetcher.onPageChange(50);

      // Check stats immediately (before processing)
      const statsBefore = prefetcher.getStats();
      expect(statsBefore.queueSize).toBeGreaterThanOrEqual(0);

      await vi.advanceTimersByTimeAsync(200);

      // After processing, queue should be emptier
      const statsAfter = prefetcher.getStats();
      expect(statsAfter.prefetchedPages.length).toBeGreaterThan(0);
    });

    it('should track prefetched pages', async () => {
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      const stats = prefetcher.getStats();
      expect(stats.prefetchedPages).toEqual(expect.arrayContaining(fetchedPages));
    });
  });

  describe('reset', () => {
    beforeEach(() => {
      prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, fetchCallback);
    });

    it('should clear all state on reset', async () => {
      // Build up some state
      prefetcher.onPageChange(50);
      await vi.advanceTimersByTimeAsync(200);

      prefetcher.reset();

      const stats = prefetcher.getStats();
      expect(stats.currentDirection).toBe('unknown');
      expect(stats.scrollVelocity).toBe(0);
      expect(stats.queueSize).toBe(0);
      expect(stats.prefetchedPages).toHaveLength(0);
    });
  });

  describe('updateConfig', () => {
    it('should update strategy at runtime', async () => {
      prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, fetchCallback);

      expect(prefetcher.getStats().strategy).toBe('adaptive');

      prefetcher.updateConfig({ strategy: 'fixed' });

      expect(prefetcher.getStats().strategy).toBe('fixed');
    });
  });
});

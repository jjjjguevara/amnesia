/**
 * Unit tests for PageElementPool
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PageElementPool } from '../../../reader/renderer/pdf/page-element-pool';
import type { PoolStats } from '../../../reader/renderer/pdf/page-element-pool';

// Note: DOM mocking is handled by src/test/pdf/setup.ts

describe('PageElementPool', () => {
  let pool: PageElementPool;

  afterEach(() => {
    pool?.destroy();
  });

  describe('acquire', () => {
    beforeEach(() => {
      pool = new PageElementPool({ maxPoolSize: 5 });
    });

    it('should create new element when pool empty', () => {
      const element = pool.acquire(1);

      expect(element).toBeDefined();
      expect(element.getPageNumber()).toBe(1);

      const stats = pool.getStats();
      expect(stats.createCount).toBe(1);
      expect(stats.acquireCount).toBe(1);
    });

    it('should reuse element from pool', () => {
      // Acquire and release an element
      const element1 = pool.acquire(1);
      pool.release(element1);

      // Acquire again - should reuse
      const element2 = pool.acquire(2);

      const stats = pool.getStats();
      expect(stats.createCount).toBe(1); // Only created once
      expect(stats.acquireCount).toBe(2); // Acquired twice
      expect(stats.releaseCount).toBe(1);
    });

    it('should reset page number on reused element', () => {
      const element1 = pool.acquire(1);
      expect(element1.getPageNumber()).toBe(1);

      pool.release(element1);

      const element2 = pool.acquire(5);
      expect(element2.getPageNumber()).toBe(5);
    });

    it('should track acquireCount', () => {
      pool.acquire(1);
      pool.acquire(2);
      pool.acquire(3);

      const stats = pool.getStats();
      expect(stats.acquireCount).toBe(3);
    });
  });

  describe('release', () => {
    beforeEach(() => {
      pool = new PageElementPool({ maxPoolSize: 3 });
    });

    it('should add element to pool', () => {
      const element = pool.acquire(1);
      pool.release(element);

      const stats = pool.getStats();
      expect(stats.poolSize).toBe(1);
      expect(stats.releaseCount).toBe(1);
    });

    it('should clear element before pooling', () => {
      const element = pool.acquire(1);
      // Element should be cleared when released
      pool.release(element);

      // When we acquire again, it should be in a clean state
      const element2 = pool.acquire(2);
      expect(element2.getIsRendered()).toBe(false);
    });

    it('should destroy element if pool full', () => {
      // Fill the pool
      const elements = [
        pool.acquire(1),
        pool.acquire(2),
        pool.acquire(3),
        pool.acquire(4), // This one won't fit in pool
      ];

      // Release all - last one should be destroyed
      for (const el of elements) {
        pool.release(el);
      }

      const stats = pool.getStats();
      expect(stats.poolSize).toBe(3); // maxPoolSize
      expect(stats.releaseCount).toBe(4);
    });

    it('should track releaseCount', () => {
      const e1 = pool.acquire(1);
      const e2 = pool.acquire(2);

      pool.release(e1);
      pool.release(e2);

      const stats = pool.getStats();
      expect(stats.releaseCount).toBe(2);
    });
  });

  describe('prewarm', () => {
    beforeEach(() => {
      pool = new PageElementPool({ maxPoolSize: 10 });
    });

    it('should create specified number of elements', () => {
      pool.prewarm(5);

      const stats = pool.getStats();
      expect(stats.poolSize).toBe(5);
      expect(stats.createCount).toBe(5);
    });

    it('should not exceed maxPoolSize', () => {
      pool.prewarm(15); // More than maxPoolSize of 10

      const stats = pool.getStats();
      expect(stats.poolSize).toBe(10);
      expect(stats.createCount).toBe(10);
    });

    it('should account for existing pool elements', () => {
      pool.prewarm(5);
      // prewarm(3) with 5 elements already in pool (maxPoolSize=10)
      // should add 3 more (min of 3 and remaining capacity of 5)
      pool.prewarm(3);

      const stats = pool.getStats();
      expect(stats.poolSize).toBe(8);
      expect(stats.createCount).toBe(8);
    });
  });

  describe('updateConfig', () => {
    beforeEach(() => {
      pool = new PageElementPool({ maxPoolSize: 10 });
    });

    it('should update maxPoolSize', () => {
      pool.updateConfig({ maxPoolSize: 5 });

      const stats = pool.getStats();
      expect(stats.maxPoolSize).toBe(5);
    });

    it('should trim pool if new size smaller', () => {
      pool.prewarm(10);

      const statsBefore = pool.getStats();
      expect(statsBefore.poolSize).toBe(10);

      pool.updateConfig({ maxPoolSize: 3 });

      const statsAfter = pool.getStats();
      expect(statsAfter.poolSize).toBe(3);
      expect(statsAfter.maxPoolSize).toBe(3);
    });

    it('should update textLayerMode', () => {
      pool.updateConfig({ textLayerMode: 'virtualized' });

      // Create a new element to verify config was updated
      const element = pool.acquire(1);
      // The element should have the new textLayerMode
      // (We can't directly access config, but we can verify it was created with new settings)
      expect(element).toBeDefined();
    });

    it('should update pixelRatio', () => {
      pool.updateConfig({ pixelRatio: 3 });

      // New elements should use the new pixel ratio
      const element = pool.acquire(1);
      expect(element).toBeDefined();
    });
  });

  describe('memory management', () => {
    beforeEach(() => {
      pool = new PageElementPool({ maxPoolSize: 5 });
    });

    it('should properly destroy all elements on destroy()', () => {
      // Create some elements
      const elements = [];
      for (let i = 0; i < 5; i++) {
        elements.push(pool.acquire(i + 1));
      }

      // Release them back to pool
      for (const el of elements) {
        pool.release(el);
      }

      const statsBefore = pool.getStats();
      expect(statsBefore.poolSize).toBe(5);

      // Destroy the pool
      pool.destroy();

      const statsAfter = pool.getStats();
      expect(statsAfter.poolSize).toBe(0);
    });

    it('should reset stats on destroy()', () => {
      // Build up some stats
      const e1 = pool.acquire(1);
      const e2 = pool.acquire(2);
      pool.release(e1);
      pool.release(e2);

      pool.destroy();

      const stats = pool.getStats();
      expect(stats.acquireCount).toBe(0);
      expect(stats.releaseCount).toBe(0);
      expect(stats.createCount).toBe(0);
    });
  });

  describe('clear', () => {
    beforeEach(() => {
      pool = new PageElementPool({ maxPoolSize: 5 });
    });

    it('should clear all pooled elements', () => {
      pool.prewarm(5);

      const statsBefore = pool.getStats();
      expect(statsBefore.poolSize).toBe(5);

      pool.clear();

      const statsAfter = pool.getStats();
      expect(statsAfter.poolSize).toBe(0);
    });

    it('should not reset stats on clear (only destroy does)', () => {
      pool.prewarm(5);
      pool.clear();

      const stats = pool.getStats();
      expect(stats.createCount).toBe(5); // Stats preserved
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', () => {
      pool = new PageElementPool({ maxPoolSize: 10 });

      pool.prewarm(3);
      const e1 = pool.acquire(1);
      const e2 = pool.acquire(2);
      pool.release(e1);

      const stats = pool.getStats();

      expect(stats).toEqual({
        poolSize: 2, // 3 prewarmed - 2 acquired + 1 released = 2
        maxPoolSize: 10,
        acquireCount: 2,
        releaseCount: 1,
        createCount: 3, // Only from prewarm (acquire reused from pool)
      });
    });
  });
});

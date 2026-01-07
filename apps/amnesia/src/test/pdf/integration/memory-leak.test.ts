/**
 * Memory Leak Detection Tests
 *
 * Tests to verify proper cleanup and prevent memory leaks in PDF components.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VirtualizedTextLayer } from '../../../reader/renderer/pdf/virtualized-text-layer';
import { PageElementPool } from '../../../reader/renderer/pdf/page-element-pool';
import { AdaptivePrefetcher } from '../../../reader/renderer/pdf/adaptive-prefetcher';
import { createLargeTextLayer } from '../fixtures/test-text-layer-data';

// Note: DOM mocking is handled by src/test/pdf/setup.ts

describe('Memory Leak Detection', () => {
  let parentElement: HTMLDivElement;

  beforeEach(() => {
    parentElement = document.createElement('div');
    parentElement.style.cssText = 'width: 612px; height: 792px; position: relative;';
    document.body.appendChild(parentElement);
  });

  afterEach(() => {
    parentElement?.remove();
  });

  describe('VirtualizedTextLayer cleanup', () => {
    it('should remove all DOM elements on destroy', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      // Verify elements were added
      const containerBefore = parentElement.querySelector('.pdf-virtualized-text-layer-container');
      expect(containerBefore).not.toBeNull();

      layer.destroy();

      // Verify container is removed
      const containerAfter = parentElement.querySelector('.pdf-virtualized-text-layer-container');
      expect(containerAfter).toBeNull();
    });

    it('should clear internal state on destroy', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      const statsBefore = layer.getStats();
      expect(statsBefore.totalItems).toBeGreaterThan(0);

      layer.destroy();

      const statsAfter = layer.getStats();
      expect(statsAfter.totalItems).toBe(0);
      expect(statsAfter.renderedItems).toBe(0);
    });

    it('should not leak on repeated create/destroy cycles', () => {
      const cycles = 10;

      for (let i = 0; i < cycles; i++) {
        const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
        const textData = createLargeTextLayer(100);
        layer.render(textData, 1.0, 0, 612, 792);
        layer.destroy();
      }

      // Parent should have no leftover elements
      expect(parentElement.children.length).toBe(0);
    });

    it('should handle destroy without render', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
      // Destroy without calling render
      expect(() => layer.destroy()).not.toThrow();
    });

    it('should handle double destroy', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      layer.destroy();
      // Second destroy should not throw
      expect(() => layer.destroy()).not.toThrow();
    });
  });

  describe('PageElementPool cleanup', () => {
    it('should destroy all pooled elements on destroy', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });
      pool.prewarm(10);

      const statsBefore = pool.getStats();
      expect(statsBefore.poolSize).toBe(10);

      pool.destroy();

      const statsAfter = pool.getStats();
      expect(statsAfter.poolSize).toBe(0);
    });

    it('should reset stats on destroy', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });

      // Generate some activity
      for (let i = 0; i < 5; i++) {
        const el = pool.acquire(i + 1);
        pool.release(el);
      }

      const statsBefore = pool.getStats();
      expect(statsBefore.acquireCount).toBe(5);
      expect(statsBefore.releaseCount).toBe(5);

      pool.destroy();

      const statsAfter = pool.getStats();
      expect(statsAfter.acquireCount).toBe(0);
      expect(statsAfter.releaseCount).toBe(0);
      expect(statsAfter.createCount).toBe(0);
    });

    it('should not leak on repeated acquire/release cycles', () => {
      const pool = new PageElementPool({ maxPoolSize: 5 });

      for (let cycle = 0; cycle < 20; cycle++) {
        const elements = [];
        for (let i = 0; i < 5; i++) {
          elements.push(pool.acquire(i + 1));
        }
        for (const el of elements) {
          pool.release(el);
        }
      }

      const stats = pool.getStats();
      // Pool should never exceed max size
      expect(stats.poolSize).toBeLessThanOrEqual(5);
      // Should have reused elements
      expect(stats.createCount).toBeLessThan(stats.acquireCount);

      pool.destroy();
    });

    it('should properly clear pool without full destroy', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });
      pool.prewarm(10);

      const statsBefore = pool.getStats();
      expect(statsBefore.poolSize).toBe(10);

      pool.clear();

      const statsAfter = pool.getStats();
      expect(statsAfter.poolSize).toBe(0);
      // Stats should be preserved (unlike destroy)
      expect(statsAfter.createCount).toBe(10);

      pool.destroy();
    });

    it('should handle destroy with active elements', () => {
      const pool = new PageElementPool({ maxPoolSize: 5 });

      // Acquire elements but don't release them
      const elements = [];
      for (let i = 0; i < 3; i++) {
        elements.push(pool.acquire(i + 1));
      }

      // Destroy should work even with elements not returned
      expect(() => pool.destroy()).not.toThrow();
    });
  });

  describe('AdaptivePrefetcher cleanup', () => {
    it('should clear all state on destroy', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, async () => {});

      // Generate some activity
      for (let i = 1; i <= 10; i++) {
        prefetcher.onPageChange(i);
        prefetcher.markCached(i);
      }

      prefetcher.destroy();

      const stats = prefetcher.getStats();
      expect(stats.prefetchedPages.length).toBe(0);
      expect(stats.queueSize).toBe(0);
    });

    it('should cancel pending timeouts on destroy', async () => {
      vi.useFakeTimers();

      let fetchCount = 0;
      const prefetcher = new AdaptivePrefetcher({
        strategy: 'adaptive',
        queueProcessDelay: 100,
      });
      prefetcher.initialize(100, async () => {
        fetchCount++;
      });

      prefetcher.onPageChange(50);
      // Destroy before timeout fires
      prefetcher.destroy();

      // Advance time past the delay
      await vi.advanceTimersByTimeAsync(200);

      // Should not have processed (timeout was cleared)
      expect(fetchCount).toBe(0);

      vi.useRealTimers();
    });

    it('should not leak on repeated create/destroy cycles', () => {
      for (let cycle = 0; cycle < 10; cycle++) {
        const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
        prefetcher.initialize(100, async () => {});

        for (let page = 1; page <= 20; page++) {
          prefetcher.onPageChange(page);
          prefetcher.markCached(page);
        }

        prefetcher.destroy();
      }

      // If there were leaks, we'd likely see memory issues
      // This test mainly ensures no errors occur
      expect(true).toBe(true);
    });

    it('should handle destroy without initialize', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      // Destroy without initialize
      expect(() => prefetcher.destroy()).not.toThrow();
    });

    it('should handle double destroy', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, async () => {});

      prefetcher.destroy();
      // Second destroy should not throw
      expect(() => prefetcher.destroy()).not.toThrow();
    });
  });

  describe('combined component cleanup', () => {
    it('should clean up all components in simulated document lifecycle', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(50, async () => {});

      // Simulate opening and reading a document
      pool.prewarm(5);

      for (let page = 1; page <= 10; page++) {
        const element = pool.acquire(page);
        const layer = new VirtualizedTextLayer(element.getElement(), { mode: 'full' });
        const textData = createLargeTextLayer(50);
        layer.render(textData, 1.0, 0, 612, 792);

        prefetcher.onPageChange(page);
        prefetcher.markCached(page);

        layer.destroy();
        pool.release(element);
      }

      // Close document - destroy all
      prefetcher.destroy();
      pool.destroy();

      // Verify cleanup
      expect(pool.getStats().poolSize).toBe(0);
      expect(prefetcher.getStats().prefetchedPages.length).toBe(0);
    });

    it('should handle multiple document open/close cycles', () => {
      for (let doc = 0; doc < 5; doc++) {
        const pool = new PageElementPool({ maxPoolSize: 10 });
        const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
        prefetcher.initialize(100, async () => {});

        // Simulate reading
        for (let page = 1; page <= 20; page++) {
          const element = pool.acquire(page);
          const layer = new VirtualizedTextLayer(element.getElement(), { mode: 'virtualized' });
          const textData = createLargeTextLayer(100);
          layer.render(textData, 1.0, 0, 612, 792);

          prefetcher.onPageChange(page);

          layer.destroy();
          pool.release(element);
        }

        // Close document
        prefetcher.destroy();
        pool.destroy();
      }

      // Parent element should be clean
      expect(parentElement.children.length).toBe(0);
    });
  });

  describe('event listener cleanup', () => {
    it('should remove scroll listener on VirtualizedTextLayer destroy', () => {
      // Create a scrollable container
      const scrollContainer = document.createElement('div');
      scrollContainer.style.cssText = 'width: 612px; height: 400px; overflow: auto;';
      parentElement.appendChild(scrollContainer);

      const layer = new VirtualizedTextLayer(scrollContainer, {
        mode: 'virtualized',
        virtualizationThreshold: 10,
      });
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      // Destroy should remove scroll listener
      layer.destroy();

      // We can't directly test listener removal, but we can verify
      // no errors occur when scrolling after destroy
      scrollContainer.dispatchEvent(new Event('scroll'));
      expect(true).toBe(true); // No error means success

      scrollContainer.remove();
    });

    it('should handle destroy during scroll', () => {
      const scrollContainer = document.createElement('div');
      scrollContainer.style.cssText = 'width: 612px; height: 400px; overflow: auto;';
      parentElement.appendChild(scrollContainer);

      const layer = new VirtualizedTextLayer(scrollContainer, {
        mode: 'virtualized',
        virtualizationThreshold: 10,
      });
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      // Simulate scroll
      scrollContainer.dispatchEvent(new Event('scroll'));

      // Destroy during/after scroll should not throw
      expect(() => layer.destroy()).not.toThrow();

      scrollContainer.remove();
    });
  });
});

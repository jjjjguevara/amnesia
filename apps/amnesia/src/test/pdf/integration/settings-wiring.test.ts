/**
 * Settings Integration Tests
 *
 * Verifies that PDF optimization settings properly propagate
 * through the component hierarchy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VirtualizedTextLayer } from '../../../reader/renderer/pdf/virtualized-text-layer';
import { PageElementPool } from '../../../reader/renderer/pdf/page-element-pool';
import { AdaptivePrefetcher } from '../../../reader/renderer/pdf/adaptive-prefetcher';
import { createLargeTextLayer } from '../fixtures/test-text-layer-data';

// Note: DOM mocking is handled by src/test/pdf/setup.ts

describe('Settings Integration', () => {
  let parentElement: HTMLDivElement;

  beforeEach(() => {
    parentElement = document.createElement('div');
    parentElement.style.cssText = 'width: 612px; height: 792px; position: relative;';
    document.body.appendChild(parentElement);
  });

  afterEach(() => {
    parentElement?.remove();
  });

  describe('textLayerMode propagation', () => {
    it('should render all items when mode is "full"', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      const stats = layer.getStats();
      expect(stats.mode).toBe('full');
      // In full mode, all items should be rendered (minus empty ones)
      expect(stats.renderedItems).toBeGreaterThan(0);
      expect(stats.isVirtualized).toBe(false);

      layer.destroy();
    });

    it('should virtualize when mode is "virtualized" and items exceed threshold', () => {
      const layer = new VirtualizedTextLayer(parentElement, {
        mode: 'virtualized',
        virtualizationThreshold: 50,
      });
      const textData = createLargeTextLayer(200);
      layer.render(textData, 1.0, 0, 612, 792);

      const stats = layer.getStats();
      expect(stats.mode).toBe('virtualized');
      expect(stats.isVirtualized).toBe(true);
      // Should not render all items
      expect(stats.renderedItems).toBeLessThan(stats.totalItems);

      layer.destroy();
    });

    it('should not virtualize when items below threshold', () => {
      const layer = new VirtualizedTextLayer(parentElement, {
        mode: 'virtualized',
        virtualizationThreshold: 200,
      });
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      const stats = layer.getStats();
      expect(stats.mode).toBe('virtualized');
      expect(stats.isVirtualized).toBe(false);

      layer.destroy();
    });

    it('should render nothing when mode is "disabled"', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'disabled' });
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      const stats = layer.getStats();
      expect(stats.mode).toBe('disabled');
      expect(stats.renderedItems).toBe(0);

      layer.destroy();
    });

    it('should update mode via updateConfig', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });

      expect(layer.getStats().mode).toBe('full');

      layer.updateConfig({ mode: 'virtualized' });
      expect(layer.getStats().mode).toBe('virtualized');

      layer.updateConfig({ mode: 'disabled' });
      expect(layer.getStats().mode).toBe('disabled');

      layer.destroy();
    });
  });

  describe('prefetchStrategy propagation', () => {
    it('should use adaptive strategy by default', () => {
      const prefetcher = new AdaptivePrefetcher();
      prefetcher.initialize(100, async () => {});

      const stats = prefetcher.getStats();
      expect(stats.strategy).toBe('adaptive');

      prefetcher.destroy();
    });

    it('should use fixed strategy when configured', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'fixed' });
      prefetcher.initialize(100, async () => {});

      const stats = prefetcher.getStats();
      expect(stats.strategy).toBe('fixed');

      prefetcher.destroy();
    });

    it('should disable prefetching when strategy is "none"', async () => {
      let fetchCount = 0;
      const prefetcher = new AdaptivePrefetcher({ strategy: 'none' });
      prefetcher.initialize(100, async () => {
        fetchCount++;
      });

      // Trigger page changes
      prefetcher.onPageChange(10);
      prefetcher.onPageChange(11);
      prefetcher.onPageChange(12);

      // Wait for any async processing
      await new Promise(r => setTimeout(r, 100));

      // No fetches should have been triggered
      expect(fetchCount).toBe(0);

      prefetcher.destroy();
    });

    it('should update strategy via updateConfig', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, async () => {});

      expect(prefetcher.getStats().strategy).toBe('adaptive');

      prefetcher.updateConfig({ strategy: 'fixed' });
      expect(prefetcher.getStats().strategy).toBe('fixed');

      prefetcher.destroy();
    });
  });

  describe('enableDomPooling behavior', () => {
    it('should reuse elements when pooling enabled', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });

      const element1 = pool.acquire(1);
      pool.release(element1);

      const element2 = pool.acquire(2);

      const stats = pool.getStats();
      expect(stats.createCount).toBe(1); // Only created once
      expect(stats.acquireCount).toBe(2); // Acquired twice

      pool.release(element2);
      pool.destroy();
    });

    it('should properly reset elements for reuse', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });

      const element1 = pool.acquire(1);
      expect(element1.getPageNumber()).toBe(1);

      pool.release(element1);

      const element2 = pool.acquire(5);
      expect(element2.getPageNumber()).toBe(5);

      pool.release(element2);
      pool.destroy();
    });

    it('should update pool config at runtime', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });
      pool.prewarm(10);

      expect(pool.getStats().maxPoolSize).toBe(10);
      expect(pool.getStats().poolSize).toBe(10);

      // Reduce pool size
      pool.updateConfig({ maxPoolSize: 5 });

      expect(pool.getStats().maxPoolSize).toBe(5);
      expect(pool.getStats().poolSize).toBe(5); // Trimmed to new max

      pool.destroy();
    });
  });

  describe('component coordination', () => {
    it('should work together in simulated scroll scenario', async () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });
      pool.prewarm(5);

      let prefetchedPages: number[] = [];
      const prefetcher = new AdaptivePrefetcher({
        strategy: 'adaptive',
        basePrefetchCount: 2,
      });
      prefetcher.initialize(100, async (page) => {
        prefetchedPages.push(page);
      });

      // Simulate scrolling through pages
      for (let page = 1; page <= 10; page++) {
        const element = pool.acquire(page);

        // Create text layer for the page
        const layer = new VirtualizedTextLayer(element.getElement(), {
          mode: 'virtualized',
          virtualizationThreshold: 50,
        });
        const textData = createLargeTextLayer(100);
        layer.render(textData, 1.0, 0, 612, 792);

        // Notify prefetcher
        prefetcher.onPageChange(page);
        prefetcher.markCached(page);

        // Cleanup
        layer.destroy();
        pool.release(element);
      }

      // Wait for prefetch queue to drain
      await new Promise(r => setTimeout(r, 200));

      // Verify prefetcher was active
      expect(prefetchedPages.length).toBeGreaterThan(0);

      // Verify pool was reused
      const poolStats = pool.getStats();
      expect(poolStats.acquireCount).toBe(10);
      expect(poolStats.releaseCount).toBe(10);
      expect(poolStats.createCount).toBeLessThanOrEqual(10);

      prefetcher.destroy();
      pool.destroy();
    });

    it('should handle rapid setting changes', () => {
      const pool = new PageElementPool({ maxPoolSize: 20 });
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, async () => {});

      // Rapidly change settings
      for (let i = 0; i < 10; i++) {
        pool.updateConfig({ maxPoolSize: 10 + i });
        prefetcher.updateConfig({
          strategy: i % 2 === 0 ? 'adaptive' : 'fixed',
        });
      }

      // Should not throw, final state should be correct
      expect(pool.getStats().maxPoolSize).toBe(19);
      expect(prefetcher.getStats().strategy).toBe('fixed');

      prefetcher.destroy();
      pool.destroy();
    });
  });

  describe('debug mode', () => {
    it('should toggle text layer visibility with debug mode', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full', debug: false });

      // Initially not in debug mode
      const container = layer.getContainer();
      const textLayer = container.querySelector('.pdf-virtualized-text-layer') as HTMLElement;

      expect(textLayer.style.opacity).toBe('0.001');

      // Enable debug mode
      layer.setDebug(true);
      expect(textLayer.style.opacity).toBe('0.3');

      // Disable debug mode
      layer.setDebug(false);
      expect(textLayer.style.opacity).toBe('0.001');

      layer.destroy();
    });

    it('should update debug mode via updateConfig', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full', debug: false });

      const container = layer.getContainer();
      const textLayer = container.querySelector('.pdf-virtualized-text-layer') as HTMLElement;

      layer.updateConfig({ debug: true });
      expect(textLayer.style.opacity).toBe('0.3');

      layer.destroy();
    });
  });
});

/**
 * PDF Performance Benchmarks
 *
 * Vitest benchmarks for PDF optimization components.
 * Run with: pnpm test -- --run --benchmark
 */

import { describe, bench, beforeAll, afterAll } from 'vitest';
import { VirtualizedTextLayer } from '../../../reader/renderer/pdf/virtualized-text-layer';
import { PageElementPool } from '../../../reader/renderer/pdf/page-element-pool';
import { AdaptivePrefetcher } from '../../../reader/renderer/pdf/adaptive-prefetcher';
import {
  createLargeTextLayer,
  createMinimalTextLayer,
} from '../fixtures/test-text-layer-data';

// Note: DOM mocking is handled by src/test/pdf/setup.ts

describe('PDF Performance Benchmarks', () => {
  let parentElement: HTMLDivElement;

  beforeAll(() => {
    parentElement = document.createElement('div');
    parentElement.style.cssText = 'width: 612px; height: 792px; position: relative;';
    document.body.appendChild(parentElement);
  });

  afterAll(() => {
    parentElement?.remove();
  });

  describe('Text Layer Rendering', () => {
    bench('render text layer - full mode (50 items)', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
      const textData = createLargeTextLayer(50);
      layer.render(textData, 1.0, 0, 612, 792);
      layer.destroy();
    });

    bench('render text layer - full mode (200 items)', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
      const textData = createLargeTextLayer(200);
      layer.render(textData, 1.0, 0, 612, 792);
      layer.destroy();
    });

    bench('render text layer - virtualized mode (200 items)', () => {
      const layer = new VirtualizedTextLayer(parentElement, {
        mode: 'virtualized',
        virtualizationThreshold: 50,
      });
      const textData = createLargeTextLayer(200);
      layer.render(textData, 1.0, 0, 612, 792);
      layer.destroy();
    });

    bench('render text layer - virtualized mode (500 items)', () => {
      const layer = new VirtualizedTextLayer(parentElement, {
        mode: 'virtualized',
        virtualizationThreshold: 50,
      });
      const textData = createLargeTextLayer(500);
      layer.render(textData, 1.0, 0, 612, 792);
      layer.destroy();
    });

    bench('render text layer - disabled mode (500 items)', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'disabled' });
      const textData = createLargeTextLayer(500);
      layer.render(textData, 1.0, 0, 612, 792);
      layer.destroy();
    });
  });

  describe('Text Layer Operations', () => {
    bench('getFullText - small layer', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 0, 612, 792);
      layer.getFullText();
      layer.destroy();
    });

    bench('getFullText - large layer', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
      const textData = createLargeTextLayer(300);
      layer.render(textData, 1.0, 0, 612, 792);
      layer.getFullText();
      layer.destroy();
    });

    bench('clear and re-render', () => {
      const layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);
      layer.clear();
      layer.render(textData, 1.0, 0, 612, 792);
      layer.destroy();
    });
  });

  describe('Page Element Pool', () => {
    bench('acquire from empty pool', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });
      const element = pool.acquire(1);
      pool.release(element);
      pool.destroy();
    });

    bench('acquire from prewarmed pool', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });
      pool.prewarm(5);
      const element = pool.acquire(1);
      pool.release(element);
      pool.destroy();
    });

    bench('acquire/release cycle (10 elements)', () => {
      const pool = new PageElementPool({ maxPoolSize: 20 });
      pool.prewarm(10);

      const elements = [];
      for (let i = 0; i < 10; i++) {
        elements.push(pool.acquire(i + 1));
      }
      for (const el of elements) {
        pool.release(el);
      }

      pool.destroy();
    });

    bench('acquire/release cycle (20 elements)', () => {
      const pool = new PageElementPool({ maxPoolSize: 30 });
      pool.prewarm(20);

      const elements = [];
      for (let i = 0; i < 20; i++) {
        elements.push(pool.acquire(i + 1));
      }
      for (const el of elements) {
        pool.release(el);
      }

      pool.destroy();
    });

    bench('pool prewarm (10 elements)', () => {
      const pool = new PageElementPool({ maxPoolSize: 20 });
      pool.prewarm(10);
      pool.destroy();
    });
  });

  describe('Adaptive Prefetcher', () => {
    bench('prefetcher initialization', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, async () => {});
      prefetcher.destroy();
    });

    bench('page change processing (single)', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, async () => {});
      prefetcher.onPageChange(50);
      prefetcher.destroy();
    });

    bench('page change processing (sequential 10)', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, async () => {});

      for (let i = 1; i <= 10; i++) {
        prefetcher.onPageChange(i);
      }

      prefetcher.destroy();
    });

    bench('page change processing (sequential 50)', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(200, async () => {});

      for (let i = 1; i <= 50; i++) {
        prefetcher.onPageChange(i);
      }

      prefetcher.destroy();
    });

    bench('prefetcher with fixed strategy', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'fixed' });
      prefetcher.initialize(100, async () => {});

      for (let i = 1; i <= 20; i++) {
        prefetcher.onPageChange(i);
      }

      prefetcher.destroy();
    });

    bench('cache marking (100 pages)', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(200, async () => {});

      for (let i = 1; i <= 100; i++) {
        prefetcher.markCached(i);
      }

      prefetcher.destroy();
    });

    bench('getStats', () => {
      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, async () => {});
      prefetcher.onPageChange(50);
      prefetcher.getStats();
      prefetcher.destroy();
    });
  });

  describe('Combined Operations', () => {
    bench('full page simulation - render + text layer', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });
      const element = pool.acquire(1);

      const layer = new VirtualizedTextLayer(element.getElement(), { mode: 'full' });
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      layer.destroy();
      pool.release(element);
      pool.destroy();
    });

    bench('page scroll simulation (5 pages)', () => {
      const pool = new PageElementPool({ maxPoolSize: 10 });
      pool.prewarm(5);

      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, async () => {});

      for (let page = 1; page <= 5; page++) {
        const element = pool.acquire(page);
        prefetcher.onPageChange(page);
        prefetcher.markCached(page);
        pool.release(element);
      }

      prefetcher.destroy();
      pool.destroy();
    });

    bench('rapid page navigation (20 pages)', () => {
      const pool = new PageElementPool({ maxPoolSize: 20 });
      pool.prewarm(10);

      const prefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
      prefetcher.initialize(100, async () => {});

      // Simulate rapid forward scrolling
      for (let page = 1; page <= 20; page++) {
        const element = pool.acquire(page);
        prefetcher.onPageChange(page);
        prefetcher.markCached(page);
        pool.release(element);
      }

      prefetcher.destroy();
      pool.destroy();
    });
  });
});

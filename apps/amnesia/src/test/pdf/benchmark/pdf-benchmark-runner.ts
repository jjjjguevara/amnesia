/**
 * PDF Benchmark Runner
 *
 * Orchestrates PDF optimization benchmarks for:
 * - Page rendering performance
 * - Scroll performance
 * - Memory usage
 * - Prefetch efficiency
 * - DOM node counts
 */

import {
  BenchmarkTimer,
  MemoryTracker,
  FpsCounter,
  countDomNodes,
  waitFrames,
} from './benchmark-utils';
import {
  BenchmarkResult,
  BenchmarkSuite,
  PERFORMANCE_TARGETS,
  createResult,
  createSuite,
} from './benchmark-results';
import { AdaptivePrefetcher } from '../../../reader/renderer/pdf/adaptive-prefetcher';
import { PageElementPool } from '../../../reader/renderer/pdf/page-element-pool';
import { VirtualizedTextLayer } from '../../../reader/renderer/pdf/virtualized-text-layer';
import { createLargeTextLayer } from '../fixtures/test-text-layer-data';
import { createMockProvider } from '../fixtures/mock-pdf-provider';

export interface BenchmarkOptions {
  /** Number of iterations for timing benchmarks */
  iterations?: number;
  /** Number of warmup runs */
  warmup?: number;
  /** Number of pages for multi-page tests */
  pageCount?: number;
  /** Whether to run memory benchmarks (requires Chrome) */
  includeMemory?: boolean;
  /** Whether to run FPS benchmarks */
  includeFps?: boolean;
}

const DEFAULT_OPTIONS: Required<BenchmarkOptions> = {
  iterations: 10,
  warmup: 2,
  pageCount: 100,
  includeMemory: true,
  includeFps: true,
};

/**
 * PDF Benchmark Runner
 */
export class PdfBenchmarkRunner {
  private options: Required<BenchmarkOptions>;
  private results: BenchmarkResult[] = [];

  constructor(options: BenchmarkOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Run all benchmarks
   */
  async runAllBenchmarks(): Promise<BenchmarkSuite> {
    this.results = [];

    // Page rendering benchmarks
    await this.runTextLayerBenchmarks();
    await this.runPoolBenchmarks();
    await this.runPrefetcherBenchmarks();

    // DOM benchmarks
    await this.runDomNodeBenchmarks();

    return createSuite('PDF Optimization Benchmarks', this.results);
  }

  /**
   * Benchmark text layer rendering modes
   */
  async runTextLayerBenchmarks(): Promise<void> {
    const parent = document.createElement('div');
    parent.style.cssText = 'width: 612px; height: 792px; position: relative;';
    document.body.appendChild(parent);

    try {
      // Full mode benchmark
      const fullTimer = new BenchmarkTimer();
      for (let i = 0; i < this.options.iterations; i++) {
        const layer = new VirtualizedTextLayer(parent, { mode: 'full' });
        const textData = createLargeTextLayer(200);

        fullTimer.start();
        layer.render(textData, 1.0, 0, 612, 792);
        fullTimer.stop();

        layer.destroy();
        await waitFrames(1);
      }

      const fullStats = fullTimer.getStats();
      this.results.push(
        createResult(
          'Text Layer (full mode)',
          'textLayerFull',
          fullStats.average,
          'ms',
          { target: PERFORMANCE_TARGETS.pageRenderTime }
        )
      );

      // Virtualized mode benchmark
      const virtTimer = new BenchmarkTimer();
      for (let i = 0; i < this.options.iterations; i++) {
        const layer = new VirtualizedTextLayer(parent, {
          mode: 'virtualized',
          virtualizationThreshold: 50,
        });
        const textData = createLargeTextLayer(200);

        virtTimer.start();
        layer.render(textData, 1.0, 0, 612, 792);
        virtTimer.stop();

        layer.destroy();
        await waitFrames(1);
      }

      const virtStats = virtTimer.getStats();
      this.results.push(
        createResult(
          'Text Layer (virtualized mode)',
          'textLayerVirtualized',
          virtStats.average,
          'ms',
          { target: PERFORMANCE_TARGETS.pageRenderTime, baseline: fullStats.average }
        )
      );

      // Disabled mode benchmark (baseline)
      const disabledTimer = new BenchmarkTimer();
      for (let i = 0; i < this.options.iterations; i++) {
        const layer = new VirtualizedTextLayer(parent, { mode: 'disabled' });
        const textData = createLargeTextLayer(200);

        disabledTimer.start();
        layer.render(textData, 1.0, 0, 612, 792);
        disabledTimer.stop();

        layer.destroy();
        await waitFrames(1);
      }

      const disabledStats = disabledTimer.getStats();
      this.results.push(
        createResult(
          'Text Layer (disabled mode)',
          'textLayerDisabled',
          disabledStats.average,
          'ms'
        )
      );
    } finally {
      parent.remove();
    }
  }

  /**
   * Benchmark element pool performance
   */
  async runPoolBenchmarks(): Promise<void> {
    // Pool acquire/release benchmark
    const pool = new PageElementPool({ maxPoolSize: 20 });
    const timer = new BenchmarkTimer();

    // Warmup
    pool.prewarm(10);

    for (let i = 0; i < this.options.iterations; i++) {
      timer.start();

      // Simulate page scrolling - acquire and release elements
      const elements = [];
      for (let j = 0; j < 10; j++) {
        elements.push(pool.acquire(j + 1));
      }
      for (const el of elements) {
        pool.release(el);
      }

      timer.stop();
    }

    const stats = timer.getStats();
    const poolStats = pool.getStats();

    this.results.push(
      createResult(
        'Pool Acquire/Release (10 elements)',
        'poolAcquireRelease',
        stats.average,
        'ms'
      )
    );

    this.results.push(
      createResult(
        'Pool Reuse Rate',
        'poolReuseRate',
        ((poolStats.acquireCount - poolStats.createCount) / poolStats.acquireCount) * 100,
        '%'
      )
    );

    pool.destroy();
  }

  /**
   * Benchmark prefetcher performance
   */
  async runPrefetcherBenchmarks(): Promise<void> {
    const pageCount = this.options.pageCount;
    let fetchCount = 0;
    let cacheHits = 0;
    const fetchedPages = new Set<number>();

    const fetchCallback = async (page: number) => {
      fetchCount++;
      if (fetchedPages.has(page)) {
        cacheHits++;
      }
      fetchedPages.add(page);
      // Simulate fetch delay
      await new Promise(r => setTimeout(r, 1));
    };

    // Adaptive strategy benchmark
    const adaptivePrefetcher = new AdaptivePrefetcher({ strategy: 'adaptive' });
    adaptivePrefetcher.initialize(pageCount, fetchCallback);

    const timer = new BenchmarkTimer();

    // Simulate reading through pages
    timer.start();
    for (let page = 1; page <= Math.min(50, pageCount); page++) {
      adaptivePrefetcher.onPageChange(page);
      await new Promise(r => setTimeout(r, 10)); // Simulate reading time
    }
    timer.stop();

    // Wait for prefetch queue to drain
    await new Promise(r => setTimeout(r, 200));

    const adaptiveStats = adaptivePrefetcher.getStats();

    this.results.push(
      createResult(
        'Prefetcher Queue Processing',
        'prefetchProcessing',
        timer.getStats().average,
        'ms'
      )
    );

    this.results.push(
      createResult(
        'Prefetch Accuracy',
        'prefetchAccuracy',
        (adaptiveStats.prefetchedPages.length / fetchCount) * 100,
        '%',
        { target: PERFORMANCE_TARGETS.prefetchAccuracy }
      )
    );

    adaptivePrefetcher.destroy();

    // Fixed strategy benchmark
    fetchCount = 0;
    fetchedPages.clear();

    const fixedPrefetcher = new AdaptivePrefetcher({ strategy: 'fixed' });
    fixedPrefetcher.initialize(pageCount, fetchCallback);

    for (let page = 1; page <= Math.min(50, pageCount); page++) {
      fixedPrefetcher.onPageChange(page);
      await new Promise(r => setTimeout(r, 10));
    }

    await new Promise(r => setTimeout(r, 200));

    const fixedStats = fixedPrefetcher.getStats();

    this.results.push(
      createResult(
        'Fixed Prefetch Pages',
        'fixedPrefetchPages',
        fixedStats.prefetchedPages.length,
        'pages'
      )
    );

    fixedPrefetcher.destroy();
  }

  /**
   * Benchmark DOM node counts
   */
  async runDomNodeBenchmarks(): Promise<void> {
    const parent = document.createElement('div');
    parent.style.cssText = 'width: 612px; height: 792px; position: relative;';
    document.body.appendChild(parent);

    try {
      // Full mode DOM nodes
      const fullLayer = new VirtualizedTextLayer(parent, { mode: 'full' });
      const textData = createLargeTextLayer(300);
      fullLayer.render(textData, 1.0, 0, 612, 792);

      const fullCount = countDomNodes(parent);

      this.results.push(
        createResult(
          'DOM Nodes (full mode, 300 items)',
          'domNodesFull',
          fullCount.total,
          'nodes',
          { target: PERFORMANCE_TARGETS.domNodeCount }
        )
      );

      fullLayer.destroy();

      // Virtualized mode DOM nodes
      const virtLayer = new VirtualizedTextLayer(parent, {
        mode: 'virtualized',
        virtualizationThreshold: 50,
      });
      virtLayer.render(textData, 1.0, 0, 612, 792);

      const virtCount = countDomNodes(parent);

      this.results.push(
        createResult(
          'DOM Nodes (virtualized mode, 300 items)',
          'domNodesVirtualized',
          virtCount.total,
          'nodes',
          { target: PERFORMANCE_TARGETS.domNodeCount, baseline: fullCount.total }
        )
      );

      virtLayer.destroy();
    } finally {
      parent.remove();
    }
  }

  /**
   * Benchmark memory usage
   */
  async runMemoryBenchmarks(): Promise<void> {
    if (!this.options.includeMemory) return;

    const tracker = new MemoryTracker();
    const initialSnapshot = tracker.snapshot();
    if (!initialSnapshot) {
      console.warn('Memory tracking not available (Chrome only)');
      return;
    }

    tracker.startTracking(50);

    // Create and destroy many elements to test for leaks
    const pool = new PageElementPool({ maxPoolSize: 20 });
    pool.prewarm(20);

    for (let cycle = 0; cycle < 10; cycle++) {
      const elements = [];
      for (let i = 0; i < 20; i++) {
        elements.push(pool.acquire(i + 1));
      }
      for (const el of elements) {
        pool.release(el);
      }
      await waitFrames(2);
    }

    pool.destroy();

    // Force GC if available
    if (typeof gc === 'function') {
      gc();
    }

    await waitFrames(10);
    tracker.stopTracking();

    const growth = tracker.getMemoryGrowth();
    const peak = tracker.getPeakMemory();

    if (growth) {
      this.results.push(
        createResult(
          'Memory Growth',
          'memoryGrowth',
          growth.absolute,
          'bytes'
        )
      );

      this.results.push(
        createResult(
          'Memory Growth %',
          'memoryGrowthPercent',
          growth.percentage,
          '%'
        )
      );
    }

    this.results.push(
      createResult(
        'Peak Memory',
        'memoryPeak',
        peak,
        'bytes',
        { target: PERFORMANCE_TARGETS.memoryPeak }
      )
    );
  }

  /**
   * Get current results
   */
  getResults(): BenchmarkResult[] {
    return [...this.results];
  }

  /**
   * Reset runner state
   */
  reset(): void {
    this.results = [];
  }
}

/**
 * Run benchmarks and return suite
 */
export async function runPdfBenchmarks(
  options?: BenchmarkOptions
): Promise<BenchmarkSuite> {
  const runner = new PdfBenchmarkRunner(options);
  return runner.runAllBenchmarks();
}

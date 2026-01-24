/**
 * PDF Benchmark Suite
 *
 * Comprehensive performance benchmarking for PDF rendering pipeline.
 * Used to validate optimizations and detect regressions.
 *
 * Features:
 * - Single tile render benchmarks
 * - Continuous scroll stress tests
 * - Zoom transition measurements
 * - Grid thumbnail generation tests
 * - Memory stress tests
 * - Baseline comparison and reporting
 *
 * @example
 * ```typescript
 * const suite = getBenchmarkSuite();
 * const results = await suite.runAll();
 * console.log(suite.formatReport(results));
 * ```
 */

import {
  getTelemetry,
  type TelemetryStats,
  type PipelineStats,
} from './pdf-telemetry';
import { getFeatureFlags, type ResolvedFeatureFlags } from './feature-flags';
import { LifecycleTestRunner, type LifecycleTestResult } from './lifecycle-test-runner';
import { STANDARD_SCENARIOS } from './standard-scenarios';

/** Configuration for a single benchmark */
export interface BenchmarkConfig {
  /** Human-readable name */
  name: string;
  /** Unique identifier */
  id: string;
  /** Number of iterations (for statistical tests) */
  iterations?: number;
  /** Warm-up iterations (not counted) */
  warmupIterations?: number;
  /** Timeout in ms */
  timeout?: number;
  /** Parameters specific to this benchmark */
  params?: Record<string, unknown>;
}

/** Result of a single benchmark iteration */
export interface IterationResult {
  iteration: number;
  durationMs: number;
  metrics: {
    firstPaintMs?: number;
    fullRenderMs?: number;
    fps?: number;
    cacheHitRate?: number;
    memoryMB?: number;
    tilesRendered?: number;
  };
}

/** Aggregated benchmark result */
export interface BenchmarkResult {
  config: BenchmarkConfig;
  timestamp: number;
  iterations: IterationResult[];
  summary: {
    count: number;
    avgDurationMs: number;
    minDurationMs: number;
    maxDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    p99DurationMs: number;
    stdDev: number;
    avgFirstPaintMs?: number;
    avgFullRenderMs?: number;
    avgFps?: number;
    avgCacheHitRate?: number;
    peakMemoryMB?: number;
    totalTilesRendered?: number;
  };
  telemetry: TelemetryStats;
  pipelineStats: PipelineStats | null;
  featureFlags: ResolvedFeatureFlags;
  success: boolean;
  error?: string;
}

/** Complete suite results */
export interface SuiteResults {
  timestamp: number;
  duration: number;
  environment: {
    platform: string;
    userAgent: string;
    cpuCores: number;
    deviceMemoryGB: number | null;
    chromeVersion: number | null;
    featureFlags: ResolvedFeatureFlags;
  };
  benchmarks: BenchmarkResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

/** Baseline data for comparison */
export interface Baseline {
  timestamp: number;
  benchmarks: Map<string, BenchmarkResult>;
}

/**
 * Target metrics for success criteria
 * Based on optimization plan targets
 */
export const BENCHMARK_TARGETS = {
  timeToFirstPaint: 500,      // ms (target: <500ms)
  timeToUsable: 1000,         // ms (target: <1000ms)
  workerInitTime: 50,         // ms (target: <50ms)
  reopenTime: 200,            // ms (target: <200ms)
  cacheHitRateReopen: 0.9,    // 90% (target: >90%)
  scrollFps: 55,              // FPS (target: 55-60)
  scrollJankEvents: 10,       // max count (target: <10)
  zoomLatency: 100,           // ms (target: <100ms)
} as const;

/** Phase benchmark result for optimization tracking */
export interface PhaseBenchmarkResult {
  phase: string;
  timestamp: number;
  suiteResults: SuiteResults;
  targetsMet: string[];
  targetsMissed: string[];
}

/** Comparison between current and baseline */
export interface BenchmarkComparison {
  benchmark: string;
  current: {
    avgDurationMs: number;
    p95DurationMs: number;
    avgFps?: number;
  };
  baseline: {
    avgDurationMs: number;
    p95DurationMs: number;
    avgFps?: number;
  };
  change: {
    durationPercent: number;
    p95Percent: number;
    fpsPercent?: number;
  };
  verdict: 'improved' | 'regressed' | 'unchanged';
}

/**
 * PDF Benchmark Suite
 */
export class BenchmarkSuite {
  private canvas: unknown = null;
  private baseline: Baseline | null = null;
  private baselineResults: SuiteResults | null = null;
  private phaseResults: Map<number, PhaseBenchmarkResult> = new Map();

  /**
   * Set the canvas reference for benchmarks
   */
  setCanvas(canvas: unknown): void {
    this.canvas = canvas;
  }

  /**
   * Get the current canvas (from window if not set)
   */
  private getCanvas(): unknown {
    if (this.canvas) return this.canvas;

    // Try to get from window (set by PDF reader)
    const win = globalThis as Record<string, unknown>;
    if (win.pdfInfiniteCanvas) {
      return win.pdfInfiniteCanvas;
    }

    return null;
  }

  // =====================================================================
  // Optimization Plan Methods
  // =====================================================================

  /**
   * Run baseline benchmark before optimizations
   * Stores results for later comparison
   */
  async runBaseline(): Promise<SuiteResults> {
    console.log('[BenchmarkSuite] Running BASELINE benchmark...');
    const results = await this.runAll();
    this.baselineResults = results;
    this.setBaseline(results);
    console.log('[BenchmarkSuite] Baseline captured. Use compareToBaseline() after optimizations.');
    return results;
  }

  /**
   * Run benchmark for a specific optimization phase
   */
  async runPhase(phase: number): Promise<PhaseBenchmarkResult> {
    console.log(`[BenchmarkSuite] Running PHASE ${phase} benchmark...`);
    const results = await this.runAll();

    // Check against targets
    const { met, missed } = this.checkTargets(results);

    const phaseResult: PhaseBenchmarkResult = {
      phase: `phase-${phase}`,
      timestamp: Date.now(),
      suiteResults: results,
      targetsMet: met,
      targetsMissed: missed,
    };

    this.phaseResults.set(phase, phaseResult);
    console.log(`[BenchmarkSuite] Phase ${phase} complete. Targets met: ${met.length}/${met.length + missed.length}`);

    return phaseResult;
  }

  /**
   * Compare current results to baseline
   */
  compareToBaseline(): BenchmarkComparison[] | null {
    if (!this.baselineResults) {
      console.warn('[BenchmarkSuite] No baseline available. Run runBaseline() first.');
      return null;
    }

    const latestPhase = Math.max(...Array.from(this.phaseResults.keys()), 0);
    const latestResults = this.phaseResults.get(latestPhase)?.suiteResults;

    if (!latestResults) {
      console.warn('[BenchmarkSuite] No phase results available. Run runPhase() first.');
      return null;
    }

    return this.compare(latestResults);
  }

  /**
   * Check results against optimization targets
   */
  private checkTargets(results: SuiteResults): { met: string[]; missed: string[] } {
    const met: string[] = [];
    const missed: string[] = [];

    // Find relevant benchmark results
    const scrollBench = results.benchmarks.find(b => b.config.id === 'continuous-scroll');
    const zoomBench = results.benchmarks.find(b => b.config.id === 'zoom-transition');
    const tileBench = results.benchmarks.find(b => b.config.id === 'single-tile');

    // Check scroll FPS
    if (scrollBench?.summary.avgFps !== undefined) {
      if (scrollBench.summary.avgFps >= BENCHMARK_TARGETS.scrollFps) {
        met.push(`scrollFps: ${scrollBench.summary.avgFps.toFixed(0)} >= ${BENCHMARK_TARGETS.scrollFps}`);
      } else {
        missed.push(`scrollFps: ${scrollBench.summary.avgFps.toFixed(0)} < ${BENCHMARK_TARGETS.scrollFps}`);
      }
    }

    // Check cache hit rate
    if (tileBench?.summary.avgCacheHitRate !== undefined) {
      if (tileBench.summary.avgCacheHitRate >= BENCHMARK_TARGETS.cacheHitRateReopen) {
        met.push(`cacheHitRate: ${(tileBench.summary.avgCacheHitRate * 100).toFixed(0)}% >= ${BENCHMARK_TARGETS.cacheHitRateReopen * 100}%`);
      } else {
        missed.push(`cacheHitRate: ${(tileBench.summary.avgCacheHitRate * 100).toFixed(0)}% < ${BENCHMARK_TARGETS.cacheHitRateReopen * 100}%`);
      }
    }

    // Check zoom latency (first paint time in zoom benchmark)
    if (zoomBench?.summary.avgFirstPaintMs !== undefined) {
      if (zoomBench.summary.avgFirstPaintMs <= BENCHMARK_TARGETS.zoomLatency) {
        met.push(`zoomLatency: ${zoomBench.summary.avgFirstPaintMs.toFixed(0)}ms <= ${BENCHMARK_TARGETS.zoomLatency}ms`);
      } else {
        missed.push(`zoomLatency: ${zoomBench.summary.avgFirstPaintMs.toFixed(0)}ms > ${BENCHMARK_TARGETS.zoomLatency}ms`);
      }
    }

    // Check first paint time
    if (tileBench?.summary.avgFirstPaintMs !== undefined) {
      if (tileBench.summary.avgFirstPaintMs <= BENCHMARK_TARGETS.timeToFirstPaint) {
        met.push(`timeToFirstPaint: ${tileBench.summary.avgFirstPaintMs.toFixed(0)}ms <= ${BENCHMARK_TARGETS.timeToFirstPaint}ms`);
      } else {
        missed.push(`timeToFirstPaint: ${tileBench.summary.avgFirstPaintMs.toFixed(0)}ms > ${BENCHMARK_TARGETS.timeToFirstPaint}ms`);
      }
    }

    return { met, missed };
  }

  /**
   * Get baseline results
   */
  getBaseline(): SuiteResults | null {
    return this.baselineResults;
  }

  /**
   * Get phase result by number
   */
  getPhaseResult(phase: number): PhaseBenchmarkResult | null {
    return this.phaseResults.get(phase) ?? null;
  }

  /**
   * Get all phase results
   */
  getAllPhaseResults(): Map<number, PhaseBenchmarkResult> {
    return this.phaseResults;
  }

  /**
   * Export comprehensive report with all phases
   */
  exportOptimizationReport(): string {
    const report = {
      generatedAt: new Date().toISOString(),
      targets: BENCHMARK_TARGETS,
      baseline: this.baselineResults,
      phases: Object.fromEntries(this.phaseResults),
      comparison: this.compareToBaseline(),
    };

    return JSON.stringify(report, null, 2);
  }

  /**
   * Run all benchmarks in the suite
   */
  async runAll(): Promise<SuiteResults> {
    const startTime = performance.now();
    const benchmarks: BenchmarkResult[] = [];

    // Get environment info
    const flags = getFeatureFlags();
    const caps = flags.getCapabilities();
    const resolvedFlags = flags.resolveFlags();

    console.log('[BenchmarkSuite] Starting full benchmark suite...');
    console.log(flags.getSummary());

    // Run each benchmark
    const benchmarkList: BenchmarkConfig[] = [
      { id: 'single-tile', name: 'Single Tile Render', iterations: 50 },
      { id: 'continuous-scroll', name: 'Continuous Scroll', iterations: 3 },
      { id: 'zoom-transition', name: 'Zoom Transition', iterations: 5 },
      { id: 'grid-thumbnails', name: 'Grid Thumbnails', iterations: 3 },
      { id: 'memory-stress', name: 'Memory Stress', iterations: 1, timeout: 60000 },
    ];

    for (const config of benchmarkList) {
      console.log(`[BenchmarkSuite] Running: ${config.name}...`);
      try {
        const result = await this.runBenchmark(config);
        benchmarks.push(result);
        console.log(
          `[BenchmarkSuite] ${config.name}: ${result.success ? 'PASSED' : 'FAILED'} ` +
            `(avg: ${result.summary.avgDurationMs.toFixed(1)}ms, p95: ${result.summary.p95DurationMs.toFixed(1)}ms)`
        );
      } catch (e) {
        console.error(`[BenchmarkSuite] ${config.name} failed:`, e);
        benchmarks.push(this.createErrorResult(config, e));
      }
    }

    const endTime = performance.now();
    const passed = benchmarks.filter((b) => b.success).length;

    return {
      timestamp: Date.now(),
      duration: endTime - startTime,
      environment: {
        platform: navigator.platform,
        userAgent: navigator.userAgent,
        cpuCores: caps.cpuCores,
        deviceMemoryGB: caps.deviceMemoryGB,
        chromeVersion: caps.chromeVersion,
        featureFlags: resolvedFlags,
      },
      benchmarks,
      summary: {
        total: benchmarks.length,
        passed,
        failed: benchmarks.length - passed,
      },
    };
  }

  /**
   * Run a specific benchmark
   */
  async runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const iterations = config.iterations ?? 10;
    const warmupIterations = config.warmupIterations ?? 2;
    const timeout = config.timeout ?? 30000;

    // Reset telemetry
    getTelemetry().reset();

    const results: IterationResult[] = [];
    const startTime = performance.now();

    try {
      // Run warmup iterations
      for (let i = 0; i < warmupIterations; i++) {
        await this.runSingleIteration(config, i, true);
      }

      // Reset telemetry after warmup
      getTelemetry().reset();

      // Run measured iterations
      for (let i = 0; i < iterations; i++) {
        const iterStart = performance.now();
        const metrics = await this.runSingleIteration(config, i, false);
        const iterDuration = performance.now() - iterStart;

        results.push({
          iteration: i,
          durationMs: iterDuration,
          metrics,
        });

        // Check timeout
        if (performance.now() - startTime > timeout) {
          throw new Error(`Benchmark timed out after ${timeout}ms`);
        }
      }

      const telemetry = getTelemetry().getStats();
      const pipelineStats = getTelemetry().getPipelineStats();

      return {
        config,
        timestamp: Date.now(),
        iterations: results,
        summary: this.calculateSummary(results),
        telemetry,
        pipelineStats,
        featureFlags: getFeatureFlags().resolveFlags(),
        success: true,
      };
    } catch (e) {
      return this.createErrorResult(config, e);
    }
  }

  /**
   * Run a single iteration of a benchmark
   */
  private async runSingleIteration(
    config: BenchmarkConfig,
    iteration: number,
    isWarmup: boolean
  ): Promise<IterationResult['metrics']> {
    const canvas = this.getCanvas();
    if (!canvas) {
      throw new Error('No PDF canvas available');
    }

    switch (config.id) {
      case 'single-tile':
        return this.runSingleTileIteration(canvas, config.params);
      case 'continuous-scroll':
        return this.runContinuousScrollIteration(canvas, config.params);
      case 'zoom-transition':
        return this.runZoomTransitionIteration(canvas, config.params);
      case 'grid-thumbnails':
        return this.runGridThumbnailsIteration(canvas, config.params);
      case 'memory-stress':
        return this.runMemoryStressIteration(canvas, config.params);
      default:
        throw new Error(`Unknown benchmark: ${config.id}`);
    }
  }

  /**
   * Single tile render benchmark
   */
  private async runSingleTileIteration(
    canvas: unknown,
    params?: Record<string, unknown>
  ): Promise<IterationResult['metrics']> {
    const c = canvas as {
      clearCache?: () => void;
      renderTile?: (page: number, x: number, y: number, scale: number) => Promise<void>;
      goToPage?: (page: number) => Promise<void>;
      getPageCount?: () => number;
    };

    // Clear cache to ensure cold render
    c.clearCache?.();

    // Pick a random page
    const pageCount = c.getPageCount?.() ?? 100;
    const page = Math.floor(Math.random() * Math.min(50, pageCount)) + 1;
    const scale = params?.scale as number ?? 2;

    const startTime = performance.now();

    // Navigate to the page (triggers render)
    await c.goToPage?.(page);

    // Wait for render to complete
    await this.waitForRender(100);

    const endTime = performance.now();
    const stats = getTelemetry().getStats();

    return {
      firstPaintMs: endTime - startTime,
      fullRenderMs: stats.avgTileRenderTime,
      tilesRendered: 1,
      cacheHitRate: stats.overallHitRate,
      memoryMB: stats.currentMemoryMB,
    };
  }

  /**
   * Continuous scroll benchmark
   */
  private async runContinuousScrollIteration(
    canvas: unknown,
    params?: Record<string, unknown>
  ): Promise<IterationResult['metrics']> {
    const c = canvas as {
      goToPage?: (page: number) => Promise<void>;
      getPageCount?: () => number;
    };

    const pagesToScroll = (params?.pages as number) ?? 100;
    const velocityPxPerSec = (params?.velocity as number) ?? 200;
    const pageHeight = 800; // Approximate
    const totalDistance = pagesToScroll * pageHeight;
    const durationMs = (totalDistance / velocityPxPerSec) * 1000;
    const steps = Math.ceil(durationMs / 16); // ~60fps steps
    const stepDistance = totalDistance / steps;
    const stepDuration = durationMs / steps;

    // Start at page 1
    await c.goToPage?.(1);
    await this.waitForRender(200);

    const frameStartTimes: number[] = [];
    let lastFrameTime = performance.now();

    // Simulate scroll
    for (let i = 0; i < steps; i++) {
      const viewport = document.querySelector('.pdf-infinite-canvas-viewport');
      if (viewport) {
        const event = new WheelEvent('wheel', {
          deltaY: stepDistance,
          bubbles: true,
          cancelable: true,
        });
        viewport.dispatchEvent(event);
      }

      await this.sleep(stepDuration);

      const now = performance.now();
      const frameTime = now - lastFrameTime;
      frameStartTimes.push(frameTime);
      lastFrameTime = now;

      // Track scroll frame in telemetry
      getTelemetry().trackScrollFrame(velocityPxPerSec, frameTime);
    }

    const stats = getTelemetry().getStats();

    return {
      fps: stats.scrollAvgFps,
      cacheHitRate: stats.overallHitRate,
      memoryMB: stats.currentMemoryMB,
      tilesRendered: stats.totalTileRenders,
    };
  }

  /**
   * Zoom transition benchmark
   */
  private async runZoomTransitionIteration(
    canvas: unknown,
    params?: Record<string, unknown>
  ): Promise<IterationResult['metrics']> {
    const c = canvas as {
      setZoom?: (zoom: number) => void;
      getZoom?: () => number;
      goToPage?: (page: number) => Promise<void>;
    };

    const startZoom = (params?.startZoom as number) ?? 1;
    const endZoom = (params?.endZoom as number) ?? 16;

    // Go to a page with content
    await c.goToPage?.(10);
    await this.waitForRender(300);

    // Reset to start zoom
    c.setZoom?.(startZoom);
    await this.waitForRender(300);

    const startTime = performance.now();

    // Zoom to target
    c.setZoom?.(endZoom);

    // Wait for first paint
    await this.waitForRender(100);
    const firstPaintTime = performance.now();

    // Wait for full render
    await this.waitForRender(2000);
    const fullRenderTime = performance.now();

    const stats = getTelemetry().getStats();

    return {
      firstPaintMs: firstPaintTime - startTime,
      fullRenderMs: fullRenderTime - startTime,
      cacheHitRate: stats.overallHitRate,
      memoryMB: stats.currentMemoryMB,
      tilesRendered: stats.totalTileRenders,
    };
  }

  /**
   * Grid thumbnails benchmark
   */
  private async runGridThumbnailsIteration(
    canvas: unknown,
    params?: Record<string, unknown>
  ): Promise<IterationResult['metrics']> {
    const c = canvas as {
      setMode?: (mode: string) => void;
      getMode?: () => string;
      getPageCount?: () => number;
    };

    const pageCount = (params?.pages as number) ?? 100;

    // Switch to grid mode (triggers thumbnail generation)
    const originalMode = c.getMode?.() ?? 'vertical-scroll';

    const startTime = performance.now();
    c.setMode?.('auto-grid');

    // Wait for thumbnails to render
    await this.waitForRender(5000);
    const endTime = performance.now();

    const stats = getTelemetry().getStats();

    // Restore original mode
    c.setMode?.(originalMode);
    await this.waitForRender(500);

    return {
      fullRenderMs: endTime - startTime,
      cacheHitRate: stats.overallHitRate,
      memoryMB: stats.currentMemoryMB,
      tilesRendered: Math.min(pageCount, stats.totalRenders + stats.totalTileRenders),
    };
  }

  /**
   * Memory stress benchmark
   */
  private async runMemoryStressIteration(
    canvas: unknown,
    params?: Record<string, unknown>
  ): Promise<IterationResult['metrics']> {
    const c = canvas as {
      goToPage?: (page: number) => Promise<void>;
      getPageCount?: () => number;
      setZoom?: (zoom: number) => void;
    };

    const durationMs = (params?.duration as number) ?? 30000;
    const startTime = performance.now();
    const pageCount = c.getPageCount?.() ?? 100;
    let peakMemory = 0;

    // Continuous random navigation
    while (performance.now() - startTime < durationMs) {
      // Random page jump
      const page = Math.floor(Math.random() * pageCount) + 1;
      await c.goToPage?.(page);
      await this.waitForRender(100);

      // Random zoom
      const zoom = 1 + Math.random() * 3;
      c.setZoom?.(zoom);
      await this.waitForRender(200);

      // Track memory
      getTelemetry().snapshotMemory();
      const stats = getTelemetry().getStats();
      peakMemory = Math.max(peakMemory, stats.currentMemoryMB);
    }

    const stats = getTelemetry().getStats();

    return {
      fullRenderMs: performance.now() - startTime,
      cacheHitRate: stats.overallHitRate,
      memoryMB: peakMemory,
      tilesRendered: stats.totalTileRenders,
    };
  }

  /**
   * Wait for render to complete (simple delay-based)
   */
  private async waitForRender(maxWaitMs: number): Promise<void> {
    // Use requestAnimationFrame to wait for paint
    await new Promise<void>((resolve) => {
      let elapsed = 0;
      const check = () => {
        elapsed += 16;
        if (elapsed >= maxWaitMs) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Calculate summary statistics from iterations
   */
  private calculateSummary(
    iterations: IterationResult[]
  ): BenchmarkResult['summary'] {
    const durations = iterations.map((i) => i.durationMs);
    const sortedDurations = [...durations].sort((a, b) => a - b);

    const avg = this.average(durations);
    const variance =
      durations.reduce((sum, d) => sum + Math.pow(d - avg, 2), 0) /
      durations.length;
    const stdDev = Math.sqrt(variance);

    // Calculate metric averages
    const firstPaints = iterations
      .map((i) => i.metrics.firstPaintMs)
      .filter((v): v is number => v !== undefined);
    const fullRenders = iterations
      .map((i) => i.metrics.fullRenderMs)
      .filter((v): v is number => v !== undefined);
    const fpsList = iterations
      .map((i) => i.metrics.fps)
      .filter((v): v is number => v !== undefined);
    const hitRates = iterations
      .map((i) => i.metrics.cacheHitRate)
      .filter((v): v is number => v !== undefined);
    const memories = iterations
      .map((i) => i.metrics.memoryMB)
      .filter((v): v is number => v !== undefined);
    const tiles = iterations
      .map((i) => i.metrics.tilesRendered)
      .filter((v): v is number => v !== undefined);

    return {
      count: iterations.length,
      avgDurationMs: avg,
      minDurationMs: Math.min(...durations),
      maxDurationMs: Math.max(...durations),
      p50DurationMs: this.percentile(sortedDurations, 50),
      p95DurationMs: this.percentile(sortedDurations, 95),
      p99DurationMs: this.percentile(sortedDurations, 99),
      stdDev,
      avgFirstPaintMs: firstPaints.length > 0 ? this.average(firstPaints) : undefined,
      avgFullRenderMs: fullRenders.length > 0 ? this.average(fullRenders) : undefined,
      avgFps: fpsList.length > 0 ? this.average(fpsList) : undefined,
      avgCacheHitRate: hitRates.length > 0 ? this.average(hitRates) : undefined,
      peakMemoryMB: memories.length > 0 ? Math.max(...memories) : undefined,
      totalTilesRendered: tiles.length > 0 ? tiles.reduce((a, b) => a + b, 0) : undefined,
    };
  }

  /**
   * Create an error result
   */
  private createErrorResult(
    config: BenchmarkConfig,
    error: unknown
  ): BenchmarkResult {
    return {
      config,
      timestamp: Date.now(),
      iterations: [],
      summary: {
        count: 0,
        avgDurationMs: 0,
        minDurationMs: 0,
        maxDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        p99DurationMs: 0,
        stdDev: 0,
      },
      telemetry: getTelemetry().getStats(),
      pipelineStats: null,
      featureFlags: getFeatureFlags().resolveFlags(),
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * Set baseline for comparison
   */
  setBaseline(results: SuiteResults): void {
    this.baseline = {
      timestamp: results.timestamp,
      benchmarks: new Map(
        results.benchmarks.map((b) => [b.config.id, b])
      ),
    };
  }

  /**
   * Load baseline from JSON
   */
  loadBaseline(json: string): void {
    const data = JSON.parse(json) as SuiteResults;
    this.setBaseline(data);
  }

  /**
   * Compare current results to baseline
   */
  compare(current: SuiteResults): BenchmarkComparison[] {
    if (!this.baseline) {
      throw new Error('No baseline set');
    }

    const comparisons: BenchmarkComparison[] = [];

    for (const benchmark of current.benchmarks) {
      const baselineBenchmark = this.baseline.benchmarks.get(benchmark.config.id);
      if (!baselineBenchmark) continue;

      const durationChange =
        ((benchmark.summary.avgDurationMs - baselineBenchmark.summary.avgDurationMs) /
          baselineBenchmark.summary.avgDurationMs) *
        100;

      const p95Change =
        ((benchmark.summary.p95DurationMs - baselineBenchmark.summary.p95DurationMs) /
          baselineBenchmark.summary.p95DurationMs) *
        100;

      let fpsChange: number | undefined;
      if (benchmark.summary.avgFps && baselineBenchmark.summary.avgFps) {
        fpsChange =
          ((benchmark.summary.avgFps - baselineBenchmark.summary.avgFps) /
            baselineBenchmark.summary.avgFps) *
          100;
      }

      // Verdict: >5% slower = regressed, >5% faster = improved
      let verdict: 'improved' | 'regressed' | 'unchanged' = 'unchanged';
      if (durationChange < -5) verdict = 'improved';
      else if (durationChange > 5) verdict = 'regressed';

      comparisons.push({
        benchmark: benchmark.config.name,
        current: {
          avgDurationMs: benchmark.summary.avgDurationMs,
          p95DurationMs: benchmark.summary.p95DurationMs,
          avgFps: benchmark.summary.avgFps,
        },
        baseline: {
          avgDurationMs: baselineBenchmark.summary.avgDurationMs,
          p95DurationMs: baselineBenchmark.summary.p95DurationMs,
          avgFps: baselineBenchmark.summary.avgFps,
        },
        change: {
          durationPercent: durationChange,
          p95Percent: p95Change,
          fpsPercent: fpsChange,
        },
        verdict,
      });
    }

    return comparisons;
  }

  /**
   * Format results as a report string
   */
  formatReport(results: SuiteResults): string {
    const lines: string[] = [
      '',
      '═══════════════════════════════════════════════════════════════',
      '                    PDF BENCHMARK SUITE RESULTS                 ',
      '═══════════════════════════════════════════════════════════════',
      '',
      `Date: ${new Date(results.timestamp).toISOString()}`,
      `Duration: ${(results.duration / 1000).toFixed(2)}s`,
      `Platform: ${results.environment.platform}`,
      `CPU Cores: ${results.environment.cpuCores}`,
      `Memory: ${results.environment.deviceMemoryGB ?? 'unknown'}GB`,
      `Chrome: v${results.environment.chromeVersion ?? 'unknown'}`,
      '',
      `Summary: ${results.summary.passed}/${results.summary.total} passed`,
      '',
      '───────────────────────────────────────────────────────────────',
      '                       BENCHMARK RESULTS                        ',
      '───────────────────────────────────────────────────────────────',
    ];

    for (const benchmark of results.benchmarks) {
      const status = benchmark.success ? '✓' : '✗';
      lines.push('');
      lines.push(`${status} ${benchmark.config.name}`);

      if (benchmark.success) {
        lines.push(`  Iterations: ${benchmark.summary.count}`);
        lines.push(`  Duration:   avg=${benchmark.summary.avgDurationMs.toFixed(1)}ms, p95=${benchmark.summary.p95DurationMs.toFixed(1)}ms, stddev=${benchmark.summary.stdDev.toFixed(1)}ms`);

        if (benchmark.summary.avgFirstPaintMs !== undefined) {
          lines.push(`  First Paint: ${benchmark.summary.avgFirstPaintMs.toFixed(1)}ms`);
        }
        if (benchmark.summary.avgFps !== undefined) {
          lines.push(`  FPS: ${benchmark.summary.avgFps.toFixed(0)}`);
        }
        if (benchmark.summary.avgCacheHitRate !== undefined) {
          lines.push(`  Cache Hit: ${(benchmark.summary.avgCacheHitRate * 100).toFixed(1)}%`);
        }
        if (benchmark.summary.peakMemoryMB !== undefined) {
          lines.push(`  Peak Memory: ${benchmark.summary.peakMemoryMB.toFixed(1)}MB`);
        }

        // Pipeline stats
        if (benchmark.pipelineStats) {
          const p = benchmark.pipelineStats;
          lines.push(`  Pipeline (avg): encode=${p.encode.avg.toFixed(1)}ms, transfer=${p.transfer.avg.toFixed(1)}ms, decode=${p.decode.avg.toFixed(1)}ms`);
        }
      } else {
        lines.push(`  Error: ${benchmark.error}`);
      }
    }

    lines.push('');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('                       FEATURE FLAGS                           ');
    lines.push('───────────────────────────────────────────────────────────────');
    const flags = results.environment.featureFlags;
    lines.push(`  useRawRGBA: ${flags.useRawRGBA}`);
    lines.push(`  useSharedArrayBuffer: ${flags.useSharedArrayBuffer}`);
    lines.push(`  useMultiResZoom: ${flags.useMultiResZoom}`);
    lines.push(`  workerCount: ${flags.workerCount}`);
    lines.push(`  enableTelemetry: ${flags.enableTelemetry}`);
    lines.push(`  enablePipelineTelemetry: ${flags.enablePipelineTelemetry}`);

    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  /**
   * Format comparison as a report
   */
  formatComparisonReport(comparisons: BenchmarkComparison[]): string {
    const lines: string[] = [
      '',
      '═══════════════════════════════════════════════════════════════',
      '                   BENCHMARK COMPARISON REPORT                  ',
      '═══════════════════════════════════════════════════════════════',
      '',
    ];

    for (const comp of comparisons) {
      const icon =
        comp.verdict === 'improved' ? '🟢' :
        comp.verdict === 'regressed' ? '🔴' : '⚪';

      lines.push(`${icon} ${comp.benchmark}`);
      lines.push(`  Duration: ${comp.current.avgDurationMs.toFixed(1)}ms vs ${comp.baseline.avgDurationMs.toFixed(1)}ms (${comp.change.durationPercent >= 0 ? '+' : ''}${comp.change.durationPercent.toFixed(1)}%)`);
      lines.push(`  P95: ${comp.current.p95DurationMs.toFixed(1)}ms vs ${comp.baseline.p95DurationMs.toFixed(1)}ms (${comp.change.p95Percent >= 0 ? '+' : ''}${comp.change.p95Percent.toFixed(1)}%)`);

      if (comp.current.avgFps !== undefined && comp.baseline.avgFps !== undefined) {
        lines.push(`  FPS: ${comp.current.avgFps.toFixed(0)} vs ${comp.baseline.avgFps.toFixed(0)} (${comp.change.fpsPercent! >= 0 ? '+' : ''}${comp.change.fpsPercent!.toFixed(1)}%)`);
      }

      lines.push('');
    }

    // Summary
    const improved = comparisons.filter((c) => c.verdict === 'improved').length;
    const regressed = comparisons.filter((c) => c.verdict === 'regressed').length;
    const unchanged = comparisons.filter((c) => c.verdict === 'unchanged').length;

    lines.push('───────────────────────────────────────────────────────────────');
    lines.push(`Summary: ${improved} improved, ${regressed} regressed, ${unchanged} unchanged`);
    lines.push('═══════════════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  /**
   * Export results as JSON
   */
  exportJSON(results: SuiteResults): string {
    return JSON.stringify(results, null, 2);
  }

  /**
   * Calculate average
   */
  private average(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  /**
   * Calculate percentile
   */
  private percentile(sortedArr: number[], p: number): number {
    if (sortedArr.length === 0) return 0;
    const index = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[Math.max(0, index)];
  }

  /**
   * Expose to window for DevTools access
   */
  exposeToWindow(): void {
    (globalThis as Record<string, unknown>).pdfBenchmarks = this;
  }
}

// Singleton instance
let suiteInstance: BenchmarkSuite | null = null;

/**
 * Get the shared benchmark suite instance
 */
export function getBenchmarkSuite(): BenchmarkSuite {
  if (!suiteInstance) {
    suiteInstance = new BenchmarkSuite();
    suiteInstance.exposeToWindow();
  }
  return suiteInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetBenchmarkSuite(): void {
  suiteInstance = null;
}

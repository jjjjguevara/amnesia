/**
 * Benchmark Utilities
 *
 * Timing and measurement utilities for PDF performance benchmarks.
 */

export interface TimingResult {
  name: string;
  duration: number;
  iterations: number;
  average: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MemorySnapshot {
  timestamp: number;
  usedHeapSize: number;
  totalHeapSize: number;
}

/**
 * High-precision timer for benchmarks
 */
export class BenchmarkTimer {
  private startTime: number = 0;
  private measurements: number[] = [];

  start(): void {
    this.startTime = performance.now();
  }

  stop(): number {
    const duration = performance.now() - this.startTime;
    this.measurements.push(duration);
    return duration;
  }

  reset(): void {
    this.startTime = 0;
    this.measurements = [];
  }

  getStats(): TimingResult {
    if (this.measurements.length === 0) {
      return {
        name: '',
        duration: 0,
        iterations: 0,
        average: 0,
        min: 0,
        max: 0,
        p50: 0,
        p95: 0,
        p99: 0,
      };
    }

    const sorted = [...this.measurements].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);

    return {
      name: '',
      duration: sum,
      iterations: sorted.length,
      average: sum / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: this.percentile(sorted, 50),
      p95: this.percentile(sorted, 95),
      p99: this.percentile(sorted, 99),
    };
  }

  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}

/**
 * Memory tracker for leak detection
 */
export class MemoryTracker {
  private snapshots: MemorySnapshot[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Take a memory snapshot
   */
  snapshot(): MemorySnapshot | null {
    // Note: performance.memory is only available in Chrome
    const memory = (performance as any).memory;
    if (!memory) {
      return null;
    }

    const snap: MemorySnapshot = {
      timestamp: Date.now(),
      usedHeapSize: memory.usedJSHeapSize,
      totalHeapSize: memory.totalJSHeapSize,
    };
    this.snapshots.push(snap);
    return snap;
  }

  /**
   * Start periodic memory tracking
   */
  startTracking(intervalMs: number = 100): void {
    this.stopTracking();
    this.intervalId = setInterval(() => this.snapshot(), intervalMs);
  }

  /**
   * Stop periodic memory tracking
   */
  stopTracking(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Get memory growth between first and last snapshot
   */
  getMemoryGrowth(): { absolute: number; percentage: number } | null {
    if (this.snapshots.length < 2) {
      return null;
    }

    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    const absolute = last.usedHeapSize - first.usedHeapSize;
    const percentage = (absolute / first.usedHeapSize) * 100;

    return { absolute, percentage };
  }

  /**
   * Get peak memory usage
   */
  getPeakMemory(): number {
    if (this.snapshots.length === 0) {
      return 0;
    }
    return Math.max(...this.snapshots.map(s => s.usedHeapSize));
  }

  /**
   * Get all snapshots
   */
  getSnapshots(): MemorySnapshot[] {
    return [...this.snapshots];
  }

  /**
   * Reset tracker
   */
  reset(): void {
    this.stopTracking();
    this.snapshots = [];
  }
}

/**
 * FPS counter for scroll performance
 */
export class FpsCounter {
  private frameTimes: number[] = [];
  private lastFrameTime: number = 0;
  private animationFrameId: number | null = null;
  private isRunning = false;

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.frameTimes = [];
    this.lastFrameTime = performance.now();
    this.tick();
  }

  stop(): void {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private tick(): void {
    if (!this.isRunning) return;

    const now = performance.now();
    const delta = now - this.lastFrameTime;
    this.frameTimes.push(delta);
    this.lastFrameTime = now;

    this.animationFrameId = requestAnimationFrame(() => this.tick());
  }

  getStats(): { average: number; min: number; p5: number } {
    if (this.frameTimes.length < 2) {
      return { average: 0, min: 0, p5: 0 };
    }

    // Convert frame times to FPS
    const fps = this.frameTimes.slice(1).map(dt => 1000 / dt);
    const sorted = [...fps].sort((a, b) => a - b);

    return {
      average: fps.reduce((a, b) => a + b, 0) / fps.length,
      min: sorted[0],
      p5: sorted[Math.floor(sorted.length * 0.05)] || sorted[0],
    };
  }

  reset(): void {
    this.stop();
    this.frameTimes = [];
    this.lastFrameTime = 0;
  }
}

/**
 * DOM node counter
 */
export function countDomNodes(root: Element | Document = document): {
  total: number;
  byTag: Map<string, number>;
} {
  const byTag = new Map<string, number>();
  let total = 0;

  const walk = (node: Element) => {
    total++;
    const tag = node.tagName.toLowerCase();
    byTag.set(tag, (byTag.get(tag) || 0) + 1);

    for (const child of node.children) {
      walk(child);
    }
  };

  if (root instanceof Document) {
    if (root.documentElement) {
      walk(root.documentElement);
    }
  } else {
    walk(root);
  }

  return { total, byTag };
}

/**
 * Wait for a specified number of animation frames
 */
export function waitFrames(count: number): Promise<void> {
  return new Promise(resolve => {
    let remaining = count;
    const tick = () => {
      remaining--;
      if (remaining <= 0) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Run a function multiple times and collect timing stats
 */
export async function benchmark(
  fn: () => Promise<void> | void,
  options: { iterations?: number; warmup?: number; name?: string } = {}
): Promise<TimingResult> {
  const { iterations = 10, warmup = 2, name = 'benchmark' } = options;
  const timer = new BenchmarkTimer();

  // Warmup runs
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  // Measured runs
  for (let i = 0; i < iterations; i++) {
    timer.start();
    await fn();
    timer.stop();
  }

  const stats = timer.getStats();
  stats.name = name;
  return stats;
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format duration to human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

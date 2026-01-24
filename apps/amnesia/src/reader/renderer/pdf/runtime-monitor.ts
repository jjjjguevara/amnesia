/**
 * Runtime Monitor
 *
 * Tracks live performance metrics during PDF rendering to detect degradation
 * and inform adaptive recommendations. Integrates with the telemetry system
 * for historical analysis.
 *
 * Monitored metrics:
 * - Frame rate (FPS) via requestAnimationFrame
 * - Memory pressure via Performance Memory API (Chrome) or estimation
 * - Thermal throttling detection via frame time variance
 * - Long task detection via Performance Observer
 *
 * @example
 * ```typescript
 * const monitor = getRuntimeMonitor();
 *
 * // Start monitoring
 * monitor.start();
 *
 * // Get current metrics
 * const metrics = monitor.getMetrics();
 * console.log('Current FPS:', metrics.fps.current);
 * console.log('Memory pressure:', metrics.memory.pressure);
 *
 * // Subscribe to alerts
 * const unsubscribe = monitor.onAlert((alert) => {
 *   console.log('Alert:', alert.type, alert.severity);
 * });
 *
 * // Stop monitoring
 * monitor.stop();
 * ```
 */

import { getTelemetry } from './pdf-telemetry';

/**
 * Alert severity levels
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * Alert types
 */
export type AlertType =
  | 'low-fps'
  | 'high-memory'
  | 'memory-pressure'
  | 'thermal-throttling'
  | 'long-tasks'
  | 'low-battery';

/**
 * Runtime alert
 */
export interface RuntimeAlert {
  /** Alert type */
  type: AlertType;
  /** Severity level */
  severity: AlertSeverity;
  /** Human-readable message */
  message: string;
  /** Alert timestamp */
  timestamp: number;
  /** Associated metric value */
  value: number;
  /** Threshold that was exceeded */
  threshold: number;
}

/**
 * FPS metrics
 */
export interface FpsMetrics {
  /** Current FPS (smoothed) */
  current: number;
  /** Average FPS over monitoring period */
  average: number;
  /** Minimum FPS recorded */
  min: number;
  /** Maximum FPS recorded */
  max: number;
  /** Number of janky frames (>16.67ms) */
  jankCount: number;
  /** Frame time variance (ms²) - high variance indicates throttling */
  variance: number;
}

/**
 * Memory metrics
 */
export interface MemoryMetrics {
  /** Used JS heap size in bytes (Chrome only) */
  usedHeapSize: number | null;
  /** Total JS heap size in bytes (Chrome only) */
  totalHeapSize: number | null;
  /** Heap usage percentage (0-1) */
  heapUsagePercent: number | null;
  /** Memory pressure level */
  pressure: 'normal' | 'moderate' | 'critical';
  /** Estimated memory used by tile cache in bytes */
  tileCacheEstimate: number;
}

/**
 * Thermal metrics
 */
export interface ThermalMetrics {
  /** Whether thermal throttling is detected */
  isThrottled: boolean;
  /** Confidence in throttling detection (0-1) */
  confidence: number;
  /** Frame time trend (positive = getting slower) */
  frameTimeTrend: number;
}

/**
 * Long task metrics
 */
export interface LongTaskMetrics {
  /** Number of long tasks (>50ms) in the last second */
  countLastSecond: number;
  /** Total long task duration in the last second */
  durationLastSecond: number;
  /** Longest task duration observed */
  longestTask: number;
}

/**
 * Complete runtime metrics
 */
export interface RuntimeMetrics {
  /** FPS metrics */
  fps: FpsMetrics;
  /** Memory metrics */
  memory: MemoryMetrics;
  /** Thermal metrics */
  thermal: ThermalMetrics;
  /** Long task metrics */
  longTasks: LongTaskMetrics;
  /** Monitoring duration in ms */
  monitoringDuration: number;
  /** Whether monitoring is active */
  isMonitoring: boolean;
}

/**
 * Alert callback type
 */
export type AlertCallback = (alert: RuntimeAlert) => void;

/**
 * Monitoring configuration
 */
export interface MonitorConfig {
  /** FPS sample window size */
  fpsSampleSize: number;
  /** Memory check interval in ms */
  memoryCheckInterval: number;
  /** FPS threshold for warning */
  fpsWarningThreshold: number;
  /** FPS threshold for critical */
  fpsCriticalThreshold: number;
  /** Heap usage threshold for warning (0-1) */
  heapWarningThreshold: number;
  /** Heap usage threshold for critical (0-1) */
  heapCriticalThreshold: number;
  /** Frame time variance threshold for throttling detection */
  throttlingVarianceThreshold: number;
  /** Long task threshold in ms */
  longTaskThreshold: number;
  /** Long tasks per second for warning */
  longTaskWarningCount: number;
}

const DEFAULT_CONFIG: MonitorConfig = {
  fpsSampleSize: 60,
  memoryCheckInterval: 2000,
  fpsWarningThreshold: 45,
  fpsCriticalThreshold: 30,
  heapWarningThreshold: 0.7,
  heapCriticalThreshold: 0.9,
  throttlingVarianceThreshold: 100, // ms² variance indicating throttling
  longTaskThreshold: 50,
  longTaskWarningCount: 5,
};

/**
 * Runtime Monitor class
 */
export class RuntimeMonitor {
  private config: MonitorConfig;
  private isMonitoring = false;
  private rafId: number | null = null;
  private memoryIntervalId: ReturnType<typeof setInterval> | null = null;
  private longTaskObserver: PerformanceObserver | null = null;

  // FPS tracking
  private frameTimes: number[] = [];
  private lastFrameTime = 0;
  private frameCount = 0;
  private jankCount = 0;
  private startTime = 0;

  // Memory tracking
  private lastMemoryCheck: MemoryMetrics | null = null;

  // Thermal tracking
  private frameTimeHistory: number[] = [];
  private thermalWindowSize = 30; // frames to analyze

  // Long task tracking
  private longTasks: { timestamp: number; duration: number }[] = [];
  private longestTask = 0;

  // Alert subscribers
  private alertCallbacks: Set<AlertCallback> = new Set();
  private lastAlerts: Map<AlertType, number> = new Map();
  private alertCooldown = 5000; // ms between same alert type

  constructor(config: Partial<MonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start monitoring
   */
  start(): void {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    this.startTime = performance.now();
    this.lastFrameTime = this.startTime;
    this.frameTimes = [];
    this.frameTimeHistory = [];
    this.frameCount = 0;
    this.jankCount = 0;
    this.longTasks = [];
    this.longestTask = 0;

    // Start FPS monitoring
    this.rafId = requestAnimationFrame(this.frameCallback);

    // Start memory monitoring
    this.memoryIntervalId = setInterval(
      () => this.checkMemory(),
      this.config.memoryCheckInterval
    );

    // Start long task monitoring
    this.setupLongTaskObserver();

    getTelemetry().trackCustomMetric('runtimeMonitorStarted', 1);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.isMonitoring) return;

    this.isMonitoring = false;

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.memoryIntervalId !== null) {
      clearInterval(this.memoryIntervalId);
      this.memoryIntervalId = null;
    }

    if (this.longTaskObserver) {
      this.longTaskObserver.disconnect();
      this.longTaskObserver = null;
    }

    // Clear memory leak sources
    this.alertCallbacks.clear();
    this.lastAlerts.clear();
    this.longTasks = [];
    this.longestTask = 0;

    getTelemetry().trackCustomMetric('runtimeMonitorStopped', 1);
  }

  /**
   * Get current metrics
   */
  getMetrics(): RuntimeMetrics {
    return {
      fps: this.getFpsMetrics(),
      memory: this.getMemoryMetrics(),
      thermal: this.getThermalMetrics(),
      longTasks: this.getLongTaskMetrics(),
      monitoringDuration: this.isMonitoring ? performance.now() - this.startTime : 0,
      isMonitoring: this.isMonitoring,
    };
  }

  /**
   * Subscribe to alerts
   */
  onAlert(callback: AlertCallback): () => void {
    this.alertCallbacks.add(callback);
    return () => this.alertCallbacks.delete(callback);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<MonitorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get a formatted summary for debugging
   */
  getSummary(): string {
    const metrics = this.getMetrics();

    return [
      '[Runtime Monitor]',
      `  Status: ${metrics.isMonitoring ? 'active' : 'stopped'}`,
      `  Duration: ${(metrics.monitoringDuration / 1000).toFixed(1)}s`,
      '',
      '  FPS:',
      `    Current: ${metrics.fps.current.toFixed(1)}`,
      `    Average: ${metrics.fps.average.toFixed(1)}`,
      `    Range: ${metrics.fps.min.toFixed(0)}-${metrics.fps.max.toFixed(0)}`,
      `    Jank: ${metrics.fps.jankCount} frames`,
      `    Variance: ${metrics.fps.variance.toFixed(1)}ms²`,
      '',
      '  Memory:',
      metrics.memory.usedHeapSize !== null
        ? `    Heap: ${(metrics.memory.usedHeapSize / 1024 / 1024).toFixed(0)}MB / ${(metrics.memory.totalHeapSize! / 1024 / 1024).toFixed(0)}MB`
        : '    Heap: unavailable',
      metrics.memory.heapUsagePercent !== null
        ? `    Usage: ${(metrics.memory.heapUsagePercent * 100).toFixed(0)}%`
        : '',
      `    Pressure: ${metrics.memory.pressure}`,
      `    Tile Cache: ~${(metrics.memory.tileCacheEstimate / 1024 / 1024).toFixed(0)}MB`,
      '',
      '  Thermal:',
      `    Throttled: ${metrics.thermal.isThrottled ? 'yes' : 'no'}`,
      `    Confidence: ${(metrics.thermal.confidence * 100).toFixed(0)}%`,
      `    Trend: ${metrics.thermal.frameTimeTrend > 0 ? '+' : ''}${metrics.thermal.frameTimeTrend.toFixed(2)}ms/frame`,
      '',
      '  Long Tasks:',
      `    Last Second: ${metrics.longTasks.countLastSecond} tasks`,
      `    Duration: ${metrics.longTasks.durationLastSecond.toFixed(0)}ms`,
      `    Longest: ${metrics.longTasks.longestTask.toFixed(0)}ms`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private frameCallback = (now: number): void => {
    if (!this.isMonitoring) return;

    const frameTime = now - this.lastFrameTime;
    this.lastFrameTime = now;
    this.frameCount++;

    // Track frame time
    this.frameTimes.push(frameTime);
    if (this.frameTimes.length > this.config.fpsSampleSize) {
      this.frameTimes.shift();
    }

    // Track for thermal detection
    this.frameTimeHistory.push(frameTime);
    if (this.frameTimeHistory.length > this.thermalWindowSize) {
      this.frameTimeHistory.shift();
    }

    // Detect jank (>16.67ms = below 60fps)
    if (frameTime > 16.67) {
      this.jankCount++;
    }

    // Check for FPS alerts periodically (every 60 frames)
    if (this.frameCount % 60 === 0) {
      this.checkFpsAlerts();
      this.checkThermalAlerts();
    }

    // Only schedule next frame if still monitoring (prevents race condition with stop())
    if (this.isMonitoring) {
      this.rafId = requestAnimationFrame(this.frameCallback);
    }
  };

  private getFpsMetrics(): FpsMetrics {
    if (this.frameTimes.length === 0) {
      return {
        current: 0,
        average: 0,
        min: 0,
        max: 0,
        jankCount: 0,
        variance: 0,
      };
    }

    const times = this.frameTimes;
    const avgFrameTime = times.reduce((a, b) => a + b, 0) / times.length;
    const currentFps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;

    // Calculate min/max FPS from frame times
    const minFrameTime = Math.min(...times);
    const maxFrameTime = Math.max(...times);
    const maxFps = minFrameTime > 0 ? 1000 / minFrameTime : 0;
    const minFps = maxFrameTime > 0 ? 1000 / maxFrameTime : 0;

    // Calculate variance
    const variance =
      times.reduce((sum, t) => sum + Math.pow(t - avgFrameTime, 2), 0) /
      times.length;

    // Calculate average FPS over entire monitoring period
    const totalTime = performance.now() - this.startTime;
    const averageFps = this.frameCount > 0 ? (this.frameCount / totalTime) * 1000 : 0;

    return {
      current: currentFps,
      average: averageFps,
      min: minFps,
      max: maxFps,
      jankCount: this.jankCount,
      variance,
    };
  }

  private getMemoryMetrics(): MemoryMetrics {
    if (this.lastMemoryCheck) {
      return this.lastMemoryCheck;
    }

    return this.checkMemory();
  }

  private checkMemory(): MemoryMetrics {
    const perf = performance as Performance & {
      memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      };
    };

    let usedHeapSize: number | null = null;
    let totalHeapSize: number | null = null;
    let heapUsagePercent: number | null = null;
    let pressure: MemoryMetrics['pressure'] = 'normal';

    if (perf.memory) {
      usedHeapSize = perf.memory.usedJSHeapSize;
      totalHeapSize = perf.memory.jsHeapSizeLimit;
      heapUsagePercent = usedHeapSize / totalHeapSize;

      // Determine pressure level
      if (heapUsagePercent >= this.config.heapCriticalThreshold) {
        pressure = 'critical';
      } else if (heapUsagePercent >= this.config.heapWarningThreshold) {
        pressure = 'moderate';
      }
    }

    // Estimate tile cache size from telemetry
    const telemetry = getTelemetry();
    const summary = telemetry.getSummary();
    // Parse tile cache estimate from telemetry (simplified)
    const tileCacheEstimate = this.estimateTileCacheSize();

    const metrics: MemoryMetrics = {
      usedHeapSize,
      totalHeapSize,
      heapUsagePercent,
      pressure,
      tileCacheEstimate,
    };

    this.lastMemoryCheck = metrics;

    // Check for memory alerts
    if (this.isMonitoring) {
      this.checkMemoryAlerts(metrics);
    }

    return metrics;
  }

  private estimateTileCacheSize(): number {
    // Estimate based on typical tile sizes
    // Average tile: 256x256 @ 4 bytes/pixel = 256KB
    // This is a rough estimate; actual tracking would require cache integration
    try {
      const telemetry = getTelemetry();
      // Use a rough estimate based on render count
      // Each render is approximately 256KB
      return 256 * 1024 * 50; // Estimate ~50 tiles in cache
    } catch {
      return 0;
    }
  }

  private getThermalMetrics(): ThermalMetrics {
    if (this.frameTimeHistory.length < 10) {
      return {
        isThrottled: false,
        confidence: 0,
        frameTimeTrend: 0,
      };
    }

    const times = this.frameTimeHistory;
    const halfPoint = Math.floor(times.length / 2);

    // Calculate average frame time for first and second half
    const firstHalfAvg =
      times.slice(0, halfPoint).reduce((a, b) => a + b, 0) / halfPoint;
    const secondHalfAvg =
      times.slice(halfPoint).reduce((a, b) => a + b, 0) / (times.length - halfPoint);

    // Trend: positive means getting slower
    const frameTimeTrend = (secondHalfAvg - firstHalfAvg) / times.length;

    // Calculate variance
    const avgFrameTime = times.reduce((a, b) => a + b, 0) / times.length;
    const variance =
      times.reduce((sum, t) => sum + Math.pow(t - avgFrameTime, 2), 0) /
      times.length;

    // Throttling indicators:
    // 1. High variance (inconsistent frame times)
    // 2. Positive trend (getting slower over time)
    // 3. Frame times significantly above 16.67ms
    const isHighVariance = variance > this.config.throttlingVarianceThreshold;
    const isSlowingDown = frameTimeTrend > 0.5; // >0.5ms/frame trend
    const isSlowFrames = avgFrameTime > 20; // Below 50fps average

    const throttlingScore =
      (isHighVariance ? 0.4 : 0) +
      (isSlowingDown ? 0.3 : 0) +
      (isSlowFrames ? 0.3 : 0);

    return {
      isThrottled: throttlingScore >= 0.5,
      confidence: Math.min(1, this.frameTimeHistory.length / this.thermalWindowSize),
      frameTimeTrend,
    };
  }

  private getLongTaskMetrics(): LongTaskMetrics {
    const now = performance.now();
    const oneSecondAgo = now - 1000;

    // Filter to tasks in the last second
    const recentTasks = this.longTasks.filter((t) => t.timestamp > oneSecondAgo);

    return {
      countLastSecond: recentTasks.length,
      durationLastSecond: recentTasks.reduce((sum, t) => sum + t.duration, 0),
      longestTask: this.longestTask,
    };
  }

  private setupLongTaskObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      this.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'longtask') {
            const taskDuration = entry.duration;
            this.longTasks.push({
              timestamp: entry.startTime,
              duration: taskDuration,
            });

            if (taskDuration > this.longestTask) {
              this.longestTask = taskDuration;
            }

            // Clean up old entries
            const cutoff = performance.now() - 5000;
            this.longTasks = this.longTasks.filter((t) => t.timestamp > cutoff);
          }
        }

        // Check for long task alerts
        this.checkLongTaskAlerts();
      });

      this.longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      // Long Task API not supported
    }
  }

  // ==========================================================================
  // Alert Methods
  // ==========================================================================

  private emitAlert(alert: RuntimeAlert): void {
    // Check cooldown
    const lastAlert = this.lastAlerts.get(alert.type);
    if (lastAlert && alert.timestamp - lastAlert < this.alertCooldown) {
      return;
    }

    this.lastAlerts.set(alert.type, alert.timestamp);

    // Notify subscribers
    for (const callback of this.alertCallbacks) {
      try {
        callback(alert);
      } catch (e) {
        console.error('[RuntimeMonitor] Alert callback error:', e);
      }
    }

    // Track in telemetry
    getTelemetry().trackCustomMetric(`alert_${alert.type}`, 1);
  }

  private checkFpsAlerts(): void {
    const fps = this.getFpsMetrics();

    if (fps.current < this.config.fpsCriticalThreshold) {
      this.emitAlert({
        type: 'low-fps',
        severity: 'critical',
        message: `FPS dropped to ${fps.current.toFixed(0)} (below ${this.config.fpsCriticalThreshold})`,
        timestamp: Date.now(),
        value: fps.current,
        threshold: this.config.fpsCriticalThreshold,
      });
    } else if (fps.current < this.config.fpsWarningThreshold) {
      this.emitAlert({
        type: 'low-fps',
        severity: 'warning',
        message: `FPS dropped to ${fps.current.toFixed(0)} (below ${this.config.fpsWarningThreshold})`,
        timestamp: Date.now(),
        value: fps.current,
        threshold: this.config.fpsWarningThreshold,
      });
    }
  }

  private checkMemoryAlerts(metrics: MemoryMetrics): void {
    if (metrics.heapUsagePercent === null) return;

    if (metrics.heapUsagePercent >= this.config.heapCriticalThreshold) {
      this.emitAlert({
        type: 'high-memory',
        severity: 'critical',
        message: `Memory usage at ${(metrics.heapUsagePercent * 100).toFixed(0)}%`,
        timestamp: Date.now(),
        value: metrics.heapUsagePercent,
        threshold: this.config.heapCriticalThreshold,
      });
    } else if (metrics.heapUsagePercent >= this.config.heapWarningThreshold) {
      this.emitAlert({
        type: 'high-memory',
        severity: 'warning',
        message: `Memory usage at ${(metrics.heapUsagePercent * 100).toFixed(0)}%`,
        timestamp: Date.now(),
        value: metrics.heapUsagePercent,
        threshold: this.config.heapWarningThreshold,
      });
    }

    if (metrics.pressure === 'critical') {
      this.emitAlert({
        type: 'memory-pressure',
        severity: 'critical',
        message: 'Critical memory pressure detected',
        timestamp: Date.now(),
        value: metrics.heapUsagePercent ?? 0,
        threshold: this.config.heapCriticalThreshold,
      });
    }
  }

  private checkThermalAlerts(): void {
    const thermal = this.getThermalMetrics();

    if (thermal.isThrottled && thermal.confidence > 0.7) {
      this.emitAlert({
        type: 'thermal-throttling',
        severity: 'warning',
        message: `Thermal throttling detected (confidence: ${(thermal.confidence * 100).toFixed(0)}%)`,
        timestamp: Date.now(),
        value: thermal.frameTimeTrend,
        threshold: 0.5,
      });
    }
  }

  private checkLongTaskAlerts(): void {
    const longTasks = this.getLongTaskMetrics();

    if (longTasks.countLastSecond >= this.config.longTaskWarningCount) {
      this.emitAlert({
        type: 'long-tasks',
        severity: 'warning',
        message: `${longTasks.countLastSecond} long tasks in the last second (${longTasks.durationLastSecond.toFixed(0)}ms total)`,
        timestamp: Date.now(),
        value: longTasks.countLastSecond,
        threshold: this.config.longTaskWarningCount,
      });
    }
  }
}

// ==========================================================================
// Singleton Instance
// ==========================================================================

let instance: RuntimeMonitor | null = null;

/**
 * Get the shared runtime monitor instance
 */
export function getRuntimeMonitor(): RuntimeMonitor {
  if (!instance) {
    instance = new RuntimeMonitor();
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetRuntimeMonitor(): void {
  if (instance) {
    instance.stop();
  }
  instance = null;
}

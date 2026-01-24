/**
 * PDF Telemetry Module
 *
 * Tracks performance metrics for PDF rendering to guide optimization decisions.
 * Provides real-time visibility into cache hit rates, render times, worker utilization,
 * and memory usage.
 *
 * Features:
 * - L1/L2/L3 cache tier tracking
 * - Page and tile render time tracking
 * - First tile time for initial load performance
 * - Mode transition tracking
 * - Worker utilization monitoring
 * - Memory usage tracking with peak detection
 *
 * Usage:
 * ```typescript
 * const telemetry = getTelemetry();
 * telemetry.trackCacheAccess('L1', true);
 * telemetry.trackRenderTime(45, 'tile');
 * console.log(telemetry.getStats());
 * ```
 */

/** Content-type classification metrics for Phase 5 optimization tracking */
export interface ClassificationMetrics {
  /** Count by content type */
  countByType: Map<string, number>;
  /** Classification time tracking */
  classificationTimes: number[];
  /** Render time by content type (type → array of render times) */
  renderTimesByType: Map<string, number[]>;
  /** Optimization savings tracking */
  optimizationSavings: {
    jpegExtractions: number;  // Pages served via direct JPEG extraction
    vectorOptimizations: number;  // Pages rendered at reduced scale
    totalBytesSkipped: number;  // Estimated bytes saved by JPEG extraction
    totalTimeSkipped: number;  // Estimated ms saved by optimizations
  };
  /** Cache behavior by content type */
  cacheHitsByType: Map<string, { hits: number; misses: number }>;
}

/** Zoom change entry for tracking user zoom patterns */
export interface ZoomChange {
  timestamp: number;
  from: number;
  to: number;
  duration: number; // Time spent at this zoom (calculated on next change)
}

/** Scroll metrics for tracking scroll performance */
export interface ScrollMetrics {
  totalScrollDistance: number;
  averageVelocity: number;
  maxVelocity: number;
  scrollEvents: number;
  framesDropped: number;
  averageFps: number;
  jankEvents: number; // Frames > 16.67ms
  frameTimes: number[]; // Rolling window of frame times
}

/**
 * Per-stage pipeline timing for a single render operation.
 * Used to identify bottlenecks in the render pipeline.
 */
export interface PipelineTiming {
  /** Unique identifier for this render operation */
  requestId: string;
  /** Timestamp when the operation started */
  timestamp: number;
  /** Whether this was a cache hit */
  cacheHit: boolean;
  /** Render metadata */
  metadata: {
    page: number;
    scale: number;
    tileX?: number;
    tileY?: number;
    workerIndex?: number;
    transferFormat?: 'png' | 'rgba' | 'webp';
  };
  /** Per-stage durations in milliseconds */
  stages: {
    /** MuPDF page.loadPage() - time to load page object */
    pageLoad?: number;
    /** page.run() - PDF interpretation + rasterization */
    render?: number;
    /** pixmap.asPNG() or getSamples() - encoding for transfer */
    encode?: number;
    /** postMessage round-trip - worker to main thread */
    transfer?: number;
    /** createImageBitmap() - decode on main thread */
    decode?: number;
    /** Cache set operation */
    cache?: number;
    /** Canvas drawImage() - final display */
    display?: number;
    /** Total end-to-end time */
    total?: number;
  };
}

/** Aggregated pipeline stage statistics */
export interface PipelineStageStats {
  count: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

/** All pipeline stage aggregates */
export interface PipelineStats {
  pageLoad: PipelineStageStats;
  render: PipelineStageStats;
  encode: PipelineStageStats;
  transfer: PipelineStageStats;
  decode: PipelineStageStats;
  cache: PipelineStageStats;
  display: PipelineStageStats;
  total: PipelineStageStats;
  /** Breakdown by transfer format */
  byFormat: {
    png: { count: number; avgTotal: number };
    rgba: { count: number; avgTotal: number };
    webp: { count: number; avgTotal: number };
  };
}

export interface TelemetryMetrics {
  // Cache metrics (tier-specific - overall computed from these in getStats())
  l1Hits: number;
  l1Misses: number;
  l2Hits: number;
  l2Misses: number;
  l3Hits: number;
  l3Misses: number;

  // Render metrics (rolling window)
  renderTimes: number[];
  tileRenderTimes: number[];
  firstTileTime: number | null;

  // Worker metrics
  workerUtilization: number[];
  activeWorkers: number;
  totalWorkers: number;
  pendingTasks: number;

  // Memory metrics
  memorySnapshots: number[];
  peakMemory: number;

  // Mode transition metrics
  modeTransitions: ModeTransition[];

  // Session metrics
  sessionStartTime: number;
  totalRenders: number;
  totalTileRenders: number;

  // Zoom metrics (NEW)
  zoomChanges: ZoomChange[];
  zoomDistribution: Map<number, number>; // zoom level (bucketed) → count
  currentZoom: number;

  // Scroll metrics (NEW)
  scrollMetrics: ScrollMetrics;

  // Scale distribution (NEW)
  scaleDistribution: Map<string, number>; // "type-scale-bucket" → count

  // Pipeline timing metrics (NEW - Phase 0)
  pipelineTimings: PipelineTiming[];

  // Classification metrics (NEW - Phase 5)
  classificationMetrics: ClassificationMetrics;

  // Input-to-visual latency metrics (NEW - Performance Debug)
  inputLatencyMetrics: InputLatencyMetrics;

  // Transform lifecycle metrics (NEW - Bug Investigation 2026-01-20)
  transformLifecycleMetrics: TransformLifecycleMetrics;
}

/** Input-to-visual latency tracking for real user experience measurement */
export interface InputLatencyMetrics {
  /** Rolling window of input-to-visual latency samples */
  latencySamples: number[];
  /** Count of high-latency events (>100ms) */
  highLatencyCount: number;
  /** Pending input events awaiting visual completion */
  pendingInputs: Map<number, { inputTime: number; type: 'scroll' | 'zoom' }>;
  /** Next input event ID */
  nextInputId: number;
}

// =====================================================================
// Transform Lifecycle Metrics (Bug Investigation - 2026-01-20)
// =====================================================================

/** Transform lifecycle event for tracking CSS desync bugs */
export interface TransformEvent {
  timestamp: number;
  trigger: string;  // 'zoom' | 'pan' | 'constraint' | 'gesture-end' | 'animation'
  cameraBefore: { x: number; y: number; z: number };
  cameraAfter: { x: number; y: number; z: number };
  delta: { x: number; y: number; z: number };
  cssTransformApplied: boolean;
}

/** Constraint application event for tracking position drift */
export interface ConstraintEvent {
  timestamp: number;
  mode: 'soft' | 'hard';
  cameraBefore: { x: number; y: number; z: number };
  cameraAfter: { x: number; y: number; z: number };
  delta: { x: number; y: number };
  magnitude: number;
  trigger: string;
}

/** Gesture lifecycle event for tracking gesture boundaries */
export interface GestureEvent {
  timestamp: number;
  type: 'start' | 'end';
  camera: { x: number; y: number; z: number };
  wasAtMaxZoom?: boolean;
  wasAtMinZoom?: boolean;
  totalDrift?: { x: number; y: number; z: number };
  duration?: number;
}

/** Rebound filter event for tracking filtered events */
export interface ReboundFilterEvent {
  timestamp: number;
  direction: 'zoom-in' | 'zoom-out';
  timeSinceGestureEnd: number;
  wasAtMax: boolean;
  wasAtMin: boolean;
  filtered: boolean;
}

/** Transform lifecycle metrics for bug investigation */
export interface TransformLifecycleMetrics {
  /** Rolling window of transform events */
  transformEvents: TransformEvent[];
  /** Rolling window of constraint events */
  constraintEvents: ConstraintEvent[];
  /** Rolling window of gesture events */
  gestureEvents: GestureEvent[];
  /** Rolling window of rebound filter events */
  reboundFilterEvents: ReboundFilterEvent[];
  /** Accumulated focal point drift */
  focalPointDrift: { x: number; y: number };
  /** Count of CSS desync events (constraint without applyTransform) */
  cssDesyncCount: number;
  /** Current gesture state */
  currentGestureStart: number | null;
  currentGestureStartCamera: { x: number; y: number; z: number } | null;
}

export interface ModeTransition {
  from: string;
  to: string;
  duration: number;
  timestamp: number;
}

export interface TelemetryStats {
  // Cache statistics
  overallHitRate: number;
  l1HitRate: number;
  l2HitRate: number;
  l3HitRate: number;

  // Render statistics
  avgRenderTime: number;
  avgTileRenderTime: number;
  p95RenderTime: number;
  p95TileRenderTime: number;
  firstTileTime: number | null;

  // Worker statistics
  avgWorkerUtilization: number;
  currentActiveWorkers: number;
  currentTotalWorkers: number;
  currentPendingTasks: number;

  // Memory statistics
  avgMemoryMB: number;
  peakMemoryMB: number;
  currentMemoryMB: number;

  // Mode statistics
  totalModeTransitions: number;
  avgTransitionDuration: number;

  // Session statistics
  sessionDuration: number;
  totalRenders: number;
  totalTileRenders: number;
  rendersPerSecond: number;

  // Zoom statistics (NEW)
  currentZoom: number;
  totalZoomChanges: number;
  avgTimeAtZoomLevel: number;
  mostUsedZoomLevel: number | null;

  // Scroll statistics (NEW)
  scrollTotalDistance: number;
  scrollMaxVelocity: number;
  scrollAvgFps: number;
  scrollJankEvents: number;
  scrollFrameDropRate: number;

  // Scale statistics (NEW)
  avgRenderScale: number;
  maxRenderScale: number;
  scaleDistributionSummary: Record<string, number>;

  // Legacy compat
  hitRate: number;
  cacheHits: number;
  cacheMisses: number;

  // Pipeline statistics (NEW - Phase 0)
  pipeline: PipelineStats | null;

  // Classification statistics (NEW - Phase 5)
  classification: ClassificationStats | null;
}

/** Aggregated classification statistics */
export interface ClassificationStats {
  /** Total pages classified */
  totalClassified: number;
  /** Distribution by content type (type → count) */
  distributionByType: Record<string, number>;
  /** Average classification time in ms */
  avgClassificationTime: number;
  /** Average render time by content type (type → avg ms) */
  avgRenderTimeByType: Record<string, number>;
  /** Optimization impact */
  optimizationImpact: {
    jpegExtractions: number;
    vectorOptimizations: number;
    estimatedTimeSaved: number;
    estimatedBytesSaved: number;
  };
  /** Most common content type */
  mostCommonType: string | null;
  /** Cache hit rate by content type */
  cacheHitRateByType: Record<string, number>;
}

export class PdfTelemetry {
  private metrics: TelemetryMetrics;
  private readonly maxSamples = 100;
  private lastLatencyWarningTime = 0;

  constructor() {
    this.metrics = this.createEmptyMetrics();
  }

  private createEmptyMetrics(): TelemetryMetrics {
    return {
      l1Hits: 0,
      l1Misses: 0,
      l2Hits: 0,
      l2Misses: 0,
      l3Hits: 0,
      l3Misses: 0,
      renderTimes: [],
      tileRenderTimes: [],
      firstTileTime: null,
      workerUtilization: [],
      activeWorkers: 0,
      totalWorkers: 0,
      pendingTasks: 0,
      memorySnapshots: [],
      peakMemory: 0,
      modeTransitions: [],
      sessionStartTime: Date.now(),
      totalRenders: 0,
      totalTileRenders: 0,
      // Zoom metrics
      zoomChanges: [],
      zoomDistribution: new Map(),
      currentZoom: 1.0,
      // Scroll metrics
      scrollMetrics: {
        totalScrollDistance: 0,
        averageVelocity: 0,
        maxVelocity: 0,
        scrollEvents: 0,
        framesDropped: 0,
        averageFps: 60,
        jankEvents: 0,
        frameTimes: [],
      },
      // Scale distribution
      scaleDistribution: new Map(),
      // Pipeline timing metrics
      pipelineTimings: [],
      // Classification metrics (Phase 5)
      classificationMetrics: {
        countByType: new Map(),
        classificationTimes: [],
        renderTimesByType: new Map(),
        optimizationSavings: {
          jpegExtractions: 0,
          vectorOptimizations: 0,
          totalBytesSkipped: 0,
          totalTimeSkipped: 0,
        },
        cacheHitsByType: new Map(),
      },
      // Input-to-visual latency metrics (Performance Debug)
      inputLatencyMetrics: {
        latencySamples: [],
        highLatencyCount: 0,
        pendingInputs: new Map(),
        nextInputId: 0,
      },
      // Transform lifecycle metrics (Bug Investigation 2026-01-20)
      transformLifecycleMetrics: {
        transformEvents: [],
        constraintEvents: [],
        gestureEvents: [],
        reboundFilterEvents: [],
        focalPointDrift: { x: 0, y: 0 },
        cssDesyncCount: 0,
        currentGestureStart: null,
        currentGestureStartCamera: null,
      },
    };
  }

  /**
   * Track cache access with tier information
   * @param tier Cache tier (L1 = visible, L2 = prefetch, L3 = metadata)
   * @param hit Whether it was a cache hit
   *
   * Note: The overall cacheHits/cacheMisses counters are computed from tier
   * counters in getStats() to avoid double counting.
   */
  trackCacheAccess(tier: 'L1' | 'L2' | 'L3', hit: boolean): void;
  /**
   * Track cache access (legacy overload for backward compatibility)
   * @param hit Whether it was a cache hit
   */
  trackCacheAccess(hit: boolean): void;
  trackCacheAccess(tierOrHit: 'L1' | 'L2' | 'L3' | boolean, hit?: boolean): void {
    // Handle legacy call signature: trackCacheAccess(true/false)
    // For legacy, we only update overall counters (assume L1)
    if (typeof tierOrHit === 'boolean') {
      if (tierOrHit) {
        this.metrics.l1Hits++;
      } else {
        this.metrics.l1Misses++;
      }
      return;
    }

    // Handle new call signature: trackCacheAccess('L1', true/false)
    // Only update tier-specific counters - overall is computed in getStats()
    const tier = tierOrHit;
    const wasHit = hit ?? false;

    switch (tier) {
      case 'L1':
        wasHit ? this.metrics.l1Hits++ : this.metrics.l1Misses++;
        break;
      case 'L2':
        wasHit ? this.metrics.l2Hits++ : this.metrics.l2Misses++;
        break;
      case 'L3':
        wasHit ? this.metrics.l3Hits++ : this.metrics.l3Misses++;
        break;
    }
  }

  /**
   * Track render time
   * @param ms Duration in milliseconds
   * @param type 'page' for full page renders, 'tile' for tile renders
   */
  trackRenderTime(ms: number, type?: 'page' | 'tile'): void {
    const renderType = type ?? 'page';

    if (renderType === 'page') {
      this.metrics.renderTimes.push(ms);
      this.metrics.totalRenders++;

      if (this.metrics.renderTimes.length > this.maxSamples) {
        this.metrics.renderTimes.shift();
      }
    } else {
      this.metrics.tileRenderTimes.push(ms);
      this.metrics.totalTileRenders++;

      // Track first tile time for initial load performance
      if (this.metrics.firstTileTime === null) {
        this.metrics.firstTileTime = ms;
      }

      if (this.metrics.tileRenderTimes.length > this.maxSamples) {
        this.metrics.tileRenderTimes.shift();
      }
    }
  }

  /**
   * Track first tile render time explicitly
   */
  trackFirstTile(ms: number): void {
    if (this.metrics.firstTileTime === null) {
      this.metrics.firstTileTime = ms;
    }
  }

  /**
   * Track mode transition (paginated <-> scroll <-> grid)
   */
  trackModeTransition(from: string, to: string, durationMs: number): void {
    this.metrics.modeTransitions.push({
      from,
      to,
      duration: durationMs,
      timestamp: Date.now(),
    });

    // Keep last 50 transitions
    if (this.metrics.modeTransitions.length > 50) {
      this.metrics.modeTransitions.shift();
    }
  }

  /**
   * Track zoom level change
   * @param from Previous zoom level
   * @param to New zoom level
   */
  trackZoomChange(from: number, to: number): void {
    const now = Date.now();

    // Update duration of previous entry if exists
    if (this.metrics.zoomChanges.length > 0) {
      const prev = this.metrics.zoomChanges[this.metrics.zoomChanges.length - 1];
      prev.duration = now - prev.timestamp;
    }

    // Add new entry
    this.metrics.zoomChanges.push({
      timestamp: now,
      from,
      to,
      duration: 0, // Will be calculated on next change
    });

    this.metrics.currentZoom = to;

    // Update distribution (bucket to 0.5 increments)
    const bucket = Math.round(to * 2) / 2;
    this.metrics.zoomDistribution.set(
      bucket,
      (this.metrics.zoomDistribution.get(bucket) ?? 0) + 1
    );

    // Keep last 100 zoom changes
    if (this.metrics.zoomChanges.length > 100) {
      this.metrics.zoomChanges.shift();
    }
  }

  /**
   * Track scroll frame for performance analysis
   * @param velocity Current scroll velocity (px/s)
   * @param frameTime Frame duration in ms (16.67ms = 60fps)
   */
  trackScrollFrame(velocity: number, frameTime: number): void {
    const scroll = this.metrics.scrollMetrics;

    scroll.scrollEvents++;
    scroll.totalScrollDistance += Math.abs(velocity * (frameTime / 1000));
    scroll.maxVelocity = Math.max(scroll.maxVelocity, Math.abs(velocity));

    // Track frame time for FPS calculation
    scroll.frameTimes.push(frameTime);
    if (scroll.frameTimes.length > this.maxSamples) {
      scroll.frameTimes.shift();
    }

    // Track jank (frame time > 16.67ms = sub-60fps)
    if (frameTime > 16.67) {
      scroll.jankEvents++;
      scroll.framesDropped++;
    }

    // Update rolling averages
    if (scroll.frameTimes.length > 0) {
      const avgFrameTime = this.average(scroll.frameTimes);
      scroll.averageFps = avgFrameTime > 0 ? 1000 / avgFrameTime : 60;
      scroll.averageVelocity =
        scroll.scrollEvents > 0
          ? scroll.totalScrollDistance / (scroll.scrollEvents * (avgFrameTime / 1000))
          : 0;
    }
  }

  /**
   * Track render scale used for a render operation
   * @param scale The scale factor used (e.g., 2, 4, 8, 16, 32)
   * @param type 'page' for full page renders, 'tile' for tile renders
   */
  trackRenderScale(scale: number, type: 'page' | 'tile'): void {
    const bucket = Math.ceil(scale);
    const key = `${type}-scale-${bucket}`;
    this.metrics.scaleDistribution.set(
      key,
      (this.metrics.scaleDistribution.get(key) ?? 0) + 1
    );
  }

  /**
   * Begin tracking an input event for input-to-visual latency measurement.
   * Call this when a wheel/gesture input is received.
   *
   * @param type Type of input ('scroll' or 'zoom')
   * @returns Input event ID to pass to trackVisualComplete()
   */
  trackInputEvent(type: 'scroll' | 'zoom'): number {
    const metrics = this.metrics.inputLatencyMetrics;
    const inputId = metrics.nextInputId++;
    const inputTime = performance.now();

    metrics.pendingInputs.set(inputId, { inputTime, type });

    // Clean up old pending inputs (>5 seconds old are stale)
    const staleThreshold = inputTime - 5000;
    for (const [id, input] of metrics.pendingInputs) {
      if (input.inputTime < staleThreshold) {
        metrics.pendingInputs.delete(id);
      }
    }

    return inputId;
  }

  /**
   * Complete tracking for an input event when visual update is displayed.
   * Call this when tiles are actually rendered to canvas.
   *
   * @param inputId The ID returned from trackInputEvent()
   */
  trackVisualComplete(inputId: number): void {
    const metrics = this.metrics.inputLatencyMetrics;
    const pending = metrics.pendingInputs.get(inputId);

    if (!pending) return; // Already completed or expired

    const visualTime = performance.now();
    const latency = visualTime - pending.inputTime;

    // Record latency sample
    metrics.latencySamples.push(latency);
    if (metrics.latencySamples.length > this.maxSamples) {
      metrics.latencySamples.shift();
    }

    // Track high-latency events (internal metric continues at 100ms threshold)
    if (latency > 100) {
      metrics.highLatencyCount++;
    }
    // Only warn for truly excessive latency (>1s) and rate-limit to once per 5 seconds
    const now = performance.now();
    if (latency > 1000 && now - this.lastLatencyWarningTime > 5000) {
      this.lastLatencyWarningTime = now;
      console.warn(`[Perf] Input-to-visual latency: ${latency.toFixed(0)}ms (${pending.type})`);
    }

    // Clean up
    metrics.pendingInputs.delete(inputId);
  }

  /**
   * Get input-to-visual latency statistics
   */
  getInputLatencyStats(): {
    avgLatency: number;
    p95Latency: number;
    maxLatency: number;
    highLatencyCount: number;
    sampleCount: number;
  } {
    const samples = this.metrics.inputLatencyMetrics.latencySamples;
    if (samples.length === 0) {
      return { avgLatency: 0, p95Latency: 0, maxLatency: 0, highLatencyCount: 0, sampleCount: 0 };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);

    return {
      avgLatency: this.average(samples),
      p95Latency: sorted[p95Index] ?? sorted[sorted.length - 1],
      maxLatency: Math.max(...samples),
      highLatencyCount: this.metrics.inputLatencyMetrics.highLatencyCount,
      sampleCount: samples.length,
    };
  }

  /**
   * Track a custom metric value.
   *
   * Used for tracking Phase 2+ optimization metrics like progressive
   * render timing, zoom scale upgrades, CSS stretch factors, etc.
   *
   * @param name Metric name (e.g., 'progressiveRenderTotal', 'zoomScaleUpgrade')
   * @param value The metric value
   */
  trackCustomMetric(name: string, value: number): void {
    // Store in scale distribution map with 'custom-' prefix
    const key = `custom-${name}`;
    const existing = this.metrics.scaleDistribution.get(key) ?? 0;
    // For timing metrics, track running average; for counts, accumulate
    if (name.includes('Time') || name.includes('Total') || name.includes('Duration')) {
      // Running average for timing metrics
      const count = this.metrics.scaleDistribution.get(`${key}-count`) ?? 0;
      const newCount = count + 1;
      const newAvg = (existing * count + value) / newCount;
      this.metrics.scaleDistribution.set(key, newAvg);
      this.metrics.scaleDistribution.set(`${key}-count`, newCount);
    } else {
      // Accumulate for other metrics
      this.metrics.scaleDistribution.set(key, existing + value);
    }
  }

  /**
   * Get a custom metric value.
   * @param name Metric name
   * @returns The metric value or null if not tracked
   */
  getCustomMetric(name: string): number | null {
    const key = `custom-${name}`;
    return this.metrics.scaleDistribution.get(key) ?? null;
  }

  /**
   * Track complete pipeline timing for a render operation
   * @param timing The complete pipeline timing record
   */
  trackPipelineTiming(timing: PipelineTiming): void {
    this.metrics.pipelineTimings.push(timing);

    // Keep last 200 pipeline timings for detailed analysis
    if (this.metrics.pipelineTimings.length > 200) {
      this.metrics.pipelineTimings.shift();
    }
  }

  /**
   * Create a pipeline timing builder for tracking render stages
   * @param requestId Unique identifier for this render operation
   * @param metadata Render metadata
   * @returns Builder object for tracking stages
   */
  createPipelineTimer(
    requestId: string,
    metadata: PipelineTiming['metadata']
  ): PipelineTimerBuilder {
    return new PipelineTimerBuilder(this, requestId, metadata);
  }

  // =====================================================================
  // Classification Telemetry (Phase 5)
  // =====================================================================

  /**
   * Track a page classification result
   * @param contentType The detected content type (e.g., 'SCANNED_JPEG', 'VECTOR_HEAVY')
   * @param classificationTimeMs Time taken to classify in milliseconds
   */
  trackClassification(contentType: string, classificationTimeMs: number): void {
    const cm = this.metrics.classificationMetrics;

    // Update count by type
    cm.countByType.set(contentType, (cm.countByType.get(contentType) ?? 0) + 1);

    // Track classification time
    cm.classificationTimes.push(classificationTimeMs);
    if (cm.classificationTimes.length > this.maxSamples) {
      cm.classificationTimes.shift();
    }
  }

  /**
   * Track render time by content type for optimization analysis
   * @param contentType The content type of the rendered page
   * @param renderTimeMs Render time in milliseconds
   */
  trackRenderByContentType(contentType: string, renderTimeMs: number): void {
    const cm = this.metrics.classificationMetrics;

    let times = cm.renderTimesByType.get(contentType);
    if (!times) {
      times = [];
      cm.renderTimesByType.set(contentType, times);
    }

    times.push(renderTimeMs);
    if (times.length > this.maxSamples) {
      times.shift();
    }
  }

  /**
   * Track when JPEG extraction optimization is used
   * @param bytesSaved Estimated bytes saved by skipping MuPDF render
   * @param timeSavedMs Estimated time saved in milliseconds
   */
  trackJpegExtraction(bytesSaved: number, timeSavedMs: number): void {
    const savings = this.metrics.classificationMetrics.optimizationSavings;
    savings.jpegExtractions++;
    savings.totalBytesSkipped += bytesSaved;
    savings.totalTimeSkipped += timeSavedMs;
  }

  /**
   * Track when vector scale optimization is used
   * @param timeSavedMs Estimated time saved by reduced scale rendering
   */
  trackVectorOptimization(timeSavedMs: number): void {
    const savings = this.metrics.classificationMetrics.optimizationSavings;
    savings.vectorOptimizations++;
    savings.totalTimeSkipped += timeSavedMs;
  }

  /**
   * Track cache access by content type
   * @param contentType The content type of the page
   * @param hit Whether it was a cache hit
   */
  trackCacheAccessByContentType(contentType: string, hit: boolean): void {
    const cm = this.metrics.classificationMetrics;

    let entry = cm.cacheHitsByType.get(contentType);
    if (!entry) {
      entry = { hits: 0, misses: 0 };
      cm.cacheHitsByType.set(contentType, entry);
    }

    if (hit) {
      entry.hits++;
    } else {
      entry.misses++;
    }
  }

  // =====================================================================
  // Transform Lifecycle Telemetry (Bug Investigation 2026-01-20)
  // =====================================================================

  /**
   * Track a transform event (camera change + CSS update)
   * @param trigger What caused the transform ('zoom', 'pan', 'constraint', etc.)
   * @param cameraBefore Camera state before the change
   * @param cameraAfter Camera state after the change
   * @param cssTransformApplied Whether applyTransform() was called
   */
  trackTransformEvent(
    trigger: string,
    cameraBefore: { x: number; y: number; z: number },
    cameraAfter: { x: number; y: number; z: number },
    cssTransformApplied: boolean
  ): void {
    const tlm = this.metrics.transformLifecycleMetrics;

    const event: TransformEvent = {
      timestamp: performance.now(),
      trigger,
      cameraBefore: { ...cameraBefore },
      cameraAfter: { ...cameraAfter },
      delta: {
        x: cameraAfter.x - cameraBefore.x,
        y: cameraAfter.y - cameraBefore.y,
        z: cameraAfter.z - cameraBefore.z,
      },
      cssTransformApplied,
    };

    tlm.transformEvents.push(event);
    if (tlm.transformEvents.length > this.maxSamples) {
      tlm.transformEvents.shift();
    }

    // Track CSS desync
    if (!cssTransformApplied && (event.delta.x !== 0 || event.delta.y !== 0 || event.delta.z !== 0)) {
      tlm.cssDesyncCount++;
      console.warn(`[TELEMETRY] CSS DESYNC #${tlm.cssDesyncCount}: camera changed by (${event.delta.x.toFixed(1)}, ${event.delta.y.toFixed(1)}, ${event.delta.z.toFixed(4)}) but applyTransform NOT called. Trigger: ${trigger}`);
    }
  }

  /**
   * Track a constraint application event
   * @param mode 'soft' or 'hard' constraint
   * @param cameraBefore Camera state before constraint
   * @param cameraAfter Camera state after constraint
   * @param trigger What caused the constraint ('zoom', 'pan', 'gesture-end', etc.)
   */
  trackConstraintEvent(
    mode: 'soft' | 'hard',
    cameraBefore: { x: number; y: number; z: number },
    cameraAfter: { x: number; y: number; z: number },
    trigger: string
  ): void {
    const tlm = this.metrics.transformLifecycleMetrics;

    const delta = {
      x: cameraAfter.x - cameraBefore.x,
      y: cameraAfter.y - cameraBefore.y,
    };
    const magnitude = Math.sqrt(delta.x * delta.x + delta.y * delta.y);

    const event: ConstraintEvent = {
      timestamp: performance.now(),
      mode,
      cameraBefore: { ...cameraBefore },
      cameraAfter: { ...cameraAfter },
      delta,
      magnitude,
      trigger,
    };

    tlm.constraintEvents.push(event);
    if (tlm.constraintEvents.length > this.maxSamples) {
      tlm.constraintEvents.shift();
    }

    // Accumulate focal point drift for hard constraints
    if (mode === 'hard' && magnitude > 0) {
      tlm.focalPointDrift.x += Math.abs(delta.x);
      tlm.focalPointDrift.y += Math.abs(delta.y);
    }

    // Log significant constraint changes
    if (magnitude > 1) {
      console.log(`[TELEMETRY] CONSTRAINT-${mode.toUpperCase()}: delta=(${delta.x.toFixed(1)}, ${delta.y.toFixed(1)}), magnitude=${magnitude.toFixed(1)}px, trigger=${trigger}`);
    }
  }

  /**
   * Track gesture start
   * @param camera Current camera state at gesture start
   */
  trackGestureStart(camera: { x: number; y: number; z: number }): void {
    const tlm = this.metrics.transformLifecycleMetrics;

    tlm.currentGestureStart = performance.now();
    tlm.currentGestureStartCamera = { ...camera };

    const event: GestureEvent = {
      timestamp: performance.now(),
      type: 'start',
      camera: { ...camera },
    };

    tlm.gestureEvents.push(event);
    if (tlm.gestureEvents.length > this.maxSamples) {
      tlm.gestureEvents.shift();
    }

    console.log(`[TELEMETRY] GESTURE-START: camera=(${camera.x.toFixed(1)}, ${camera.y.toFixed(1)}, ${camera.z.toFixed(2)})`);
  }

  /**
   * Track gesture end
   * @param camera Current camera state at gesture end
   * @param wasAtMaxZoom Whether zoom was at max boundary
   * @param wasAtMinZoom Whether zoom was at min boundary
   */
  trackGestureEnd(
    camera: { x: number; y: number; z: number },
    wasAtMaxZoom: boolean,
    wasAtMinZoom: boolean
  ): void {
    const tlm = this.metrics.transformLifecycleMetrics;

    const duration = tlm.currentGestureStart ? performance.now() - tlm.currentGestureStart : 0;
    const totalDrift = tlm.currentGestureStartCamera
      ? {
          x: camera.x - tlm.currentGestureStartCamera.x,
          y: camera.y - tlm.currentGestureStartCamera.y,
          z: camera.z - tlm.currentGestureStartCamera.z,
        }
      : { x: 0, y: 0, z: 0 };

    const event: GestureEvent = {
      timestamp: performance.now(),
      type: 'end',
      camera: { ...camera },
      wasAtMaxZoom,
      wasAtMinZoom,
      totalDrift,
      duration,
    };

    tlm.gestureEvents.push(event);
    if (tlm.gestureEvents.length > this.maxSamples) {
      tlm.gestureEvents.shift();
    }

    // Reset current gesture tracking
    tlm.currentGestureStart = null;
    tlm.currentGestureStartCamera = null;

    console.log(`[TELEMETRY] GESTURE-END: camera=(${camera.x.toFixed(1)}, ${camera.y.toFixed(1)}, ${camera.z.toFixed(2)}), duration=${duration.toFixed(0)}ms, drift=(${totalDrift.x.toFixed(1)}, ${totalDrift.y.toFixed(1)}, ${totalDrift.z.toFixed(4)}), atMax=${wasAtMaxZoom}, atMin=${wasAtMinZoom}`);
  }

  /**
   * Track a rebound filter event
   * @param direction 'zoom-in' or 'zoom-out'
   * @param timeSinceGestureEnd Time since gesture ended in ms
   * @param wasAtMax Whether at max zoom when gesture ended
   * @param wasAtMin Whether at min zoom when gesture ended
   * @param filtered Whether the event was filtered
   */
  trackReboundFilter(
    direction: 'zoom-in' | 'zoom-out',
    timeSinceGestureEnd: number,
    wasAtMax: boolean,
    wasAtMin: boolean,
    filtered: boolean
  ): void {
    const tlm = this.metrics.transformLifecycleMetrics;

    const event: ReboundFilterEvent = {
      timestamp: performance.now(),
      direction,
      timeSinceGestureEnd,
      wasAtMax,
      wasAtMin,
      filtered,
    };

    tlm.reboundFilterEvents.push(event);
    if (tlm.reboundFilterEvents.length > this.maxSamples) {
      tlm.reboundFilterEvents.shift();
    }

    if (filtered) {
      console.log(`[TELEMETRY] REBOUND-FILTERED: direction=${direction}, timeSinceEnd=${timeSinceGestureEnd.toFixed(0)}ms, atMax=${wasAtMax}, atMin=${wasAtMin}`);
    }
  }

  /**
   * Get transform lifecycle statistics summary
   */
  getTransformLifecycleStats(): {
    totalTransforms: number;
    cssDesyncCount: number;
    totalConstraints: number;
    hardConstraintDriftTotal: { x: number; y: number };
    avgHardConstraintMagnitude: number;
    maxHardConstraintMagnitude: number;
    totalGestures: number;
    totalReboundsFiltered: number;
    totalReboundsPassedThrough: number;
  } {
    const tlm = this.metrics.transformLifecycleMetrics;

    const hardConstraints = tlm.constraintEvents.filter((e) => e.mode === 'hard');
    const avgMagnitude =
      hardConstraints.length > 0 ? this.average(hardConstraints.map((e) => e.magnitude)) : 0;
    const maxMagnitude =
      hardConstraints.length > 0 ? Math.max(...hardConstraints.map((e) => e.magnitude)) : 0;

    const reboundsFiltered = tlm.reboundFilterEvents.filter((e) => e.filtered).length;
    const reboundsPassedThrough = tlm.reboundFilterEvents.filter((e) => !e.filtered).length;

    return {
      totalTransforms: tlm.transformEvents.length,
      cssDesyncCount: tlm.cssDesyncCount,
      totalConstraints: tlm.constraintEvents.length,
      hardConstraintDriftTotal: { ...tlm.focalPointDrift },
      avgHardConstraintMagnitude: avgMagnitude,
      maxHardConstraintMagnitude: maxMagnitude,
      totalGestures: tlm.gestureEvents.filter((e) => e.type === 'start').length,
      totalReboundsFiltered: reboundsFiltered,
      totalReboundsPassedThrough: reboundsPassedThrough,
    };
  }

  /**
   * Get aggregated classification statistics
   */
  getClassificationStats(): ClassificationStats | null {
    const cm = this.metrics.classificationMetrics;

    // Calculate total classified
    let totalClassified = 0;
    const distributionByType: Record<string, number> = {};
    let mostCommonType: string | null = null;
    let maxCount = 0;

    for (const [type, count] of cm.countByType) {
      totalClassified += count;
      distributionByType[type] = count;
      if (count > maxCount) {
        maxCount = count;
        mostCommonType = type;
      }
    }

    if (totalClassified === 0) {
      return null;
    }

    // Calculate average classification time
    const avgClassificationTime = this.average(cm.classificationTimes);

    // Calculate average render time by type
    const avgRenderTimeByType: Record<string, number> = {};
    for (const [type, times] of cm.renderTimesByType) {
      avgRenderTimeByType[type] = this.average(times);
    }

    // Calculate cache hit rate by type
    const cacheHitRateByType: Record<string, number> = {};
    for (const [type, entry] of cm.cacheHitsByType) {
      const total = entry.hits + entry.misses;
      cacheHitRateByType[type] = total > 0 ? entry.hits / total : 0;
    }

    return {
      totalClassified,
      distributionByType,
      avgClassificationTime,
      avgRenderTimeByType,
      optimizationImpact: {
        jpegExtractions: cm.optimizationSavings.jpegExtractions,
        vectorOptimizations: cm.optimizationSavings.vectorOptimizations,
        estimatedTimeSaved: cm.optimizationSavings.totalTimeSkipped,
        estimatedBytesSaved: cm.optimizationSavings.totalBytesSkipped,
      },
      mostCommonType,
      cacheHitRateByType,
    };
  }

  /**
   * Get aggregated pipeline statistics
   */
  getPipelineStats(): PipelineStats | null {
    const timings = this.metrics.pipelineTimings;
    if (timings.length === 0) return null;

    const createStageStats = (values: number[]): PipelineStageStats => {
      if (values.length === 0) {
        return { count: 0, avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
      }
      return {
        count: values.length,
        avg: this.average(values),
        min: Math.min(...values),
        max: Math.max(...values),
        p50: this.percentile(values, 50),
        p95: this.percentile(values, 95),
        p99: this.percentile(values, 99),
      };
    };

    // Extract stage values
    const pageLoads = timings.map((t) => t.stages.pageLoad).filter((v): v is number => v !== undefined);
    const renders = timings.map((t) => t.stages.render).filter((v): v is number => v !== undefined);
    const encodes = timings.map((t) => t.stages.encode).filter((v): v is number => v !== undefined);
    const transfers = timings.map((t) => t.stages.transfer).filter((v): v is number => v !== undefined);
    const decodes = timings.map((t) => t.stages.decode).filter((v): v is number => v !== undefined);
    const caches = timings.map((t) => t.stages.cache).filter((v): v is number => v !== undefined);
    const displays = timings.map((t) => t.stages.display).filter((v): v is number => v !== undefined);
    const totals = timings.map((t) => t.stages.total).filter((v): v is number => v !== undefined);

    // Group by format
    const byFormat = {
      png: { count: 0, avgTotal: 0, totals: [] as number[] },
      rgba: { count: 0, avgTotal: 0, totals: [] as number[] },
      webp: { count: 0, avgTotal: 0, totals: [] as number[] },
    };

    for (const timing of timings) {
      const format = timing.metadata.transferFormat ?? 'png';
      if (format in byFormat && timing.stages.total !== undefined) {
        byFormat[format].count++;
        byFormat[format].totals.push(timing.stages.total);
      }
    }

    // Calculate averages
    for (const format of ['png', 'rgba', 'webp'] as const) {
      if (byFormat[format].totals.length > 0) {
        byFormat[format].avgTotal = this.average(byFormat[format].totals);
      }
    }

    return {
      pageLoad: createStageStats(pageLoads),
      render: createStageStats(renders),
      encode: createStageStats(encodes),
      transfer: createStageStats(transfers),
      decode: createStageStats(decodes),
      cache: createStageStats(caches),
      display: createStageStats(displays),
      total: createStageStats(totals),
      byFormat: {
        png: { count: byFormat.png.count, avgTotal: byFormat.png.avgTotal },
        rgba: { count: byFormat.rgba.count, avgTotal: byFormat.rgba.avgTotal },
        webp: { count: byFormat.webp.count, avgTotal: byFormat.webp.avgTotal },
      },
    };
  }

  /**
   * Track worker task started (legacy compat)
   */
  trackWorkerTaskStart(): void {
    this.metrics.pendingTasks++;
  }

  /**
   * Track worker task completed (legacy compat)
   */
  trackWorkerTaskComplete(): void {
    if (this.metrics.pendingTasks > 0) {
      this.metrics.pendingTasks--;
    }
  }

  /**
   * Track worker utilization snapshot
   */
  trackWorkerUtilization(activeWorkers: number, totalWorkers: number, pendingTasks?: number): void {
    const utilization = totalWorkers > 0 ? activeWorkers / totalWorkers : 0;
    this.metrics.workerUtilization.push(utilization);
    this.metrics.activeWorkers = activeWorkers;
    this.metrics.totalWorkers = totalWorkers;
    if (pendingTasks !== undefined) {
      this.metrics.pendingTasks = pendingTasks;
    }

    if (this.metrics.workerUtilization.length > this.maxSamples) {
      this.metrics.workerUtilization.shift();
    }
  }

  /**
   * Take memory snapshot
   */
  snapshotMemory(): void {
    const memory = this.getMemoryUsage();
    if (memory > 0) {
      this.metrics.memorySnapshots.push(memory);
      this.metrics.peakMemory = Math.max(this.metrics.peakMemory, memory);

      if (this.metrics.memorySnapshots.length > this.maxSamples) {
        this.metrics.memorySnapshots.shift();
      }
    }
  }

  /**
   * Get current memory usage in bytes
   */
  private getMemoryUsage(): number {
    const perf = performance as Performance & {
      memory?: { usedJSHeapSize: number };
    };
    return perf?.memory?.usedJSHeapSize ?? 0;
  }

  /**
   * Calculate percentile from array
   */
  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Calculate average from array
   */
  private average(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  /**
   * Calculate hit rate
   */
  private hitRate(hits: number, misses: number): number {
    const total = hits + misses;
    return total > 0 ? hits / total : 0;
  }

  /**
   * Get comprehensive statistics
   */
  getStats(): TelemetryStats {
    const now = Date.now();
    const sessionDuration = (now - this.metrics.sessionStartTime) / 1000;
    const currentMemory = this.getMemoryUsage();

    // Compute overall cache hits/misses from tier counters to avoid double counting
    const totalCacheHits = this.metrics.l1Hits + this.metrics.l2Hits + this.metrics.l3Hits;
    const totalCacheMisses = this.metrics.l1Misses + this.metrics.l2Misses + this.metrics.l3Misses;
    const overallHitRate = this.hitRate(totalCacheHits, totalCacheMisses);

    // Compute zoom statistics
    const avgTimeAtZoomLevel =
      this.metrics.zoomChanges.length > 0
        ? this.average(this.metrics.zoomChanges.map((z) => z.duration).filter((d) => d > 0))
        : 0;

    // Find most used zoom level
    let mostUsedZoomLevel: number | null = null;
    let maxCount = 0;
    for (const [level, count] of this.metrics.zoomDistribution) {
      if (count > maxCount) {
        maxCount = count;
        mostUsedZoomLevel = level;
      }
    }

    // Compute scroll statistics
    const scroll = this.metrics.scrollMetrics;
    const scrollFrameDropRate =
      scroll.scrollEvents > 0 ? scroll.framesDropped / scroll.scrollEvents : 0;

    // Compute scale statistics
    const scaleValues: number[] = [];
    const scaleDistSummary: Record<string, number> = {};
    for (const [key, count] of this.metrics.scaleDistribution) {
      scaleDistSummary[key] = count;
      const match = key.match(/scale-(\d+)/);
      if (match) {
        const scale = parseInt(match[1], 10);
        for (let i = 0; i < count; i++) {
          scaleValues.push(scale);
        }
      }
    }

    return {
      // Cache statistics
      overallHitRate,
      l1HitRate: this.hitRate(this.metrics.l1Hits, this.metrics.l1Misses),
      l2HitRate: this.hitRate(this.metrics.l2Hits, this.metrics.l2Misses),
      l3HitRate: this.hitRate(this.metrics.l3Hits, this.metrics.l3Misses),

      // Render statistics
      avgRenderTime: this.average(this.metrics.renderTimes),
      avgTileRenderTime: this.average(this.metrics.tileRenderTimes),
      p95RenderTime: this.percentile(this.metrics.renderTimes, 95),
      p95TileRenderTime: this.percentile(this.metrics.tileRenderTimes, 95),
      firstTileTime: this.metrics.firstTileTime,

      // Worker statistics
      avgWorkerUtilization: this.average(this.metrics.workerUtilization),
      currentActiveWorkers: this.metrics.activeWorkers,
      currentTotalWorkers: this.metrics.totalWorkers,
      currentPendingTasks: this.metrics.pendingTasks,

      // Memory statistics
      avgMemoryMB: this.average(this.metrics.memorySnapshots) / (1024 * 1024),
      peakMemoryMB: this.metrics.peakMemory / (1024 * 1024),
      currentMemoryMB: currentMemory / (1024 * 1024),

      // Mode statistics
      totalModeTransitions: this.metrics.modeTransitions.length,
      avgTransitionDuration: this.average(
        this.metrics.modeTransitions.map((t) => t.duration)
      ),

      // Session statistics
      sessionDuration,
      totalRenders: this.metrics.totalRenders,
      totalTileRenders: this.metrics.totalTileRenders,
      rendersPerSecond:
        sessionDuration > 0
          ? (this.metrics.totalRenders + this.metrics.totalTileRenders) / sessionDuration
          : 0,

      // Zoom statistics (NEW)
      currentZoom: this.metrics.currentZoom,
      totalZoomChanges: this.metrics.zoomChanges.length,
      avgTimeAtZoomLevel,
      mostUsedZoomLevel,

      // Scroll statistics (NEW)
      scrollTotalDistance: scroll.totalScrollDistance,
      scrollMaxVelocity: scroll.maxVelocity,
      scrollAvgFps: scroll.averageFps,
      scrollJankEvents: scroll.jankEvents,
      scrollFrameDropRate,

      // Scale statistics (NEW)
      avgRenderScale: this.average(scaleValues),
      maxRenderScale: scaleValues.length > 0 ? Math.max(...scaleValues) : 0,
      scaleDistributionSummary: scaleDistSummary,

      // Legacy compat - use computed totals
      hitRate: overallHitRate,
      cacheHits: totalCacheHits,
      cacheMisses: totalCacheMisses,

      // Pipeline statistics (NEW - Phase 0)
      pipeline: this.getPipelineStats(),

      // Classification statistics (NEW - Phase 5)
      classification: this.getClassificationStats(),
    };
  }

  /**
   * Get raw metrics (for detailed analysis)
   */
  getRawMetrics(): Readonly<TelemetryMetrics> {
    return { ...this.metrics };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics = this.createEmptyMetrics();
  }

  /**
   * Expose telemetry to window for DevTools MCP access
   */
  exposeToWindow(): void {
    (globalThis as Record<string, unknown>).pdfTelemetry = this;
  }

  /**
   * Get a formatted summary string
   */
  getSummary(): string {
    const stats = this.getStats();
    const lines = [
      `[PDF Telemetry Summary]`,
      `  Cache: ${(stats.overallHitRate * 100).toFixed(1)}% hit rate (L1: ${(stats.l1HitRate * 100).toFixed(1)}%, L2: ${(stats.l2HitRate * 100).toFixed(1)}%)`,
      `  Render: avg ${stats.avgRenderTime.toFixed(1)}ms, p95 ${stats.p95RenderTime.toFixed(1)}ms`,
      `  Tiles: avg ${stats.avgTileRenderTime.toFixed(1)}ms, first ${stats.firstTileTime?.toFixed(1) ?? 'N/A'}ms`,
      `  Scale: avg ${stats.avgRenderScale.toFixed(1)}x, max ${stats.maxRenderScale}x`,
      `  Zoom: current ${stats.currentZoom.toFixed(1)}x, ${stats.totalZoomChanges} changes, most used: ${stats.mostUsedZoomLevel?.toFixed(1) ?? 'N/A'}x`,
      `  Scroll: ${stats.scrollAvgFps.toFixed(0)} FPS, ${stats.scrollJankEvents} jank events, ${(stats.scrollFrameDropRate * 100).toFixed(1)}% dropped`,
      `  Workers: ${(stats.avgWorkerUtilization * 100).toFixed(0)}% utilization, ${stats.currentPendingTasks} pending`,
      `  Memory: ${stats.currentMemoryMB.toFixed(1)}MB current, ${stats.peakMemoryMB.toFixed(1)}MB peak`,
      `  Session: ${stats.sessionDuration.toFixed(1)}s, ${stats.totalRenders + stats.totalTileRenders} renders`,
    ];

    // Add classification summary if available
    if (stats.classification) {
      const cs = stats.classification;
      const distSummary = Object.entries(cs.distributionByType)
        .map(([type, count]) => `${type}: ${count}`)
        .join(', ');

      lines.push(`  [Content-Type Classification]`);
      lines.push(`    Classified: ${cs.totalClassified} pages, avg ${cs.avgClassificationTime.toFixed(1)}ms`);
      lines.push(`    Distribution: ${distSummary}`);
      lines.push(`    Most Common: ${cs.mostCommonType ?? 'N/A'}`);
      lines.push(`    Optimizations: ${cs.optimizationImpact.jpegExtractions} JPEG extractions, ${cs.optimizationImpact.vectorOptimizations} vector opts`);
      lines.push(`    Time Saved: ${cs.optimizationImpact.estimatedTimeSaved.toFixed(1)}ms, Bytes Saved: ${(cs.optimizationImpact.estimatedBytesSaved / 1024).toFixed(1)}KB`);
    }

    return lines.join('\n');
  }

  /**
   * Log current stats to console
   */
  logStats(): void {
    console.log(this.getSummary());
  }

  /**
   * Start periodic memory tracking
   * @returns Cleanup function to stop tracking
   */
  startPeriodicMemoryTracking(intervalMs: number = 5000): () => void {
    const interval = setInterval(() => {
      this.snapshotMemory();
    }, intervalMs);
    return () => clearInterval(interval);
  }
}

// Singleton instance
let telemetryInstance: PdfTelemetry | null = null;

/**
 * Get the shared telemetry instance
 */
export function getTelemetry(): PdfTelemetry {
  if (!telemetryInstance) {
    telemetryInstance = new PdfTelemetry();
    telemetryInstance.exposeToWindow();
  }
  return telemetryInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetTelemetry(): void {
  telemetryInstance = null;
}

/**
 * Convenience function to track cache access
 */
export function trackCacheAccess(tier: 'L1' | 'L2' | 'L3', hit: boolean): void;
export function trackCacheAccess(hit: boolean): void;
export function trackCacheAccess(tierOrHit: 'L1' | 'L2' | 'L3' | boolean, hit?: boolean): void {
  if (typeof tierOrHit === 'boolean') {
    getTelemetry().trackCacheAccess(tierOrHit);
  } else {
    getTelemetry().trackCacheAccess(tierOrHit, hit ?? false);
  }
}

/**
 * Convenience function to track render time
 */
export function trackRenderTime(ms: number, type?: 'page' | 'tile'): void {
  getTelemetry().trackRenderTime(ms, type);
}

/**
 * Decorator/wrapper for timing async functions
 */
export async function withTelemetry<T>(
  type: 'page' | 'tile',
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const duration = performance.now() - start;
    getTelemetry().trackRenderTime(duration, type);
  }
}

/**
 * Create a timer for manual timing
 */
export function createRenderTimer(type: 'page' | 'tile'): () => void {
  const start = performance.now();
  return () => {
    const duration = performance.now() - start;
    getTelemetry().trackRenderTime(duration, type);
  };
}

/**
 * Builder class for tracking pipeline stages with precise timing.
 *
 * @example
 * ```typescript
 * const timer = getTelemetry().createPipelineTimer('req-123', { page: 1, scale: 2 });
 *
 * timer.startStage('pageLoad');
 * await page.loadPage();
 * timer.endStage('pageLoad');
 *
 * timer.startStage('render');
 * await page.run();
 * timer.endStage('render');
 *
 * timer.complete(); // Records the full timing
 * ```
 */
export class PipelineTimerBuilder {
  private telemetry: PdfTelemetry;
  private timing: PipelineTiming;
  private stageStarts: Map<string, number> = new Map();
  private startTime: number;
  private completed = false;

  constructor(
    telemetry: PdfTelemetry,
    requestId: string,
    metadata: PipelineTiming['metadata']
  ) {
    this.telemetry = telemetry;
    this.startTime = performance.now();
    this.timing = {
      requestId,
      timestamp: Date.now(),
      cacheHit: false,
      metadata,
      stages: {},
    };
  }

  /**
   * Mark this as a cache hit (skips most stages)
   */
  markCacheHit(): this {
    this.timing.cacheHit = true;
    return this;
  }

  /**
   * Set the transfer format used
   */
  setTransferFormat(format: 'png' | 'rgba' | 'webp'): this {
    this.timing.metadata.transferFormat = format;
    return this;
  }

  /**
   * Set the worker index that processed this request
   */
  setWorkerIndex(index: number): this {
    this.timing.metadata.workerIndex = index;
    return this;
  }

  /**
   * Start timing a stage
   */
  startStage(stage: keyof PipelineTiming['stages']): this {
    this.stageStarts.set(stage, performance.now());
    return this;
  }

  /**
   * End timing a stage (must have called startStage first)
   */
  endStage(stage: keyof PipelineTiming['stages']): this {
    const start = this.stageStarts.get(stage);
    if (start !== undefined) {
      this.timing.stages[stage] = performance.now() - start;
      this.stageStarts.delete(stage);
    }
    return this;
  }

  /**
   * Set a stage duration directly (for cases where timing is external)
   */
  setStage(stage: keyof PipelineTiming['stages'], durationMs: number): this {
    this.timing.stages[stage] = durationMs;
    return this;
  }

  /**
   * Complete the timing and record it
   */
  complete(): PipelineTiming {
    if (this.completed) {
      return this.timing;
    }

    // Calculate total time
    this.timing.stages.total = performance.now() - this.startTime;

    // Record the timing
    this.telemetry.trackPipelineTiming(this.timing);
    this.completed = true;

    return this.timing;
  }

  /**
   * Get the current timing without completing
   */
  peek(): PipelineTiming {
    return {
      ...this.timing,
      stages: {
        ...this.timing.stages,
        total: performance.now() - this.startTime,
      },
    };
  }

  /**
   * Abort the timing (don't record it)
   */
  abort(): void {
    this.completed = true;
  }
}

/**
 * Convenience function to create a pipeline timer
 */
export function createPipelineTimer(
  requestId: string,
  metadata: PipelineTiming['metadata']
): PipelineTimerBuilder {
  return getTelemetry().createPipelineTimer(requestId, metadata);
}

// =====================================================================
// Classification Telemetry Convenience Functions (Phase 5)
// =====================================================================

/**
 * Track a page classification result
 */
export function trackClassification(contentType: string, classificationTimeMs: number): void {
  getTelemetry().trackClassification(contentType, classificationTimeMs);
}

/**
 * Track render time by content type
 */
export function trackRenderByContentType(contentType: string, renderTimeMs: number): void {
  getTelemetry().trackRenderByContentType(contentType, renderTimeMs);
}

/**
 * Track JPEG extraction optimization usage
 */
export function trackJpegExtraction(bytesSaved: number, timeSavedMs: number): void {
  getTelemetry().trackJpegExtraction(bytesSaved, timeSavedMs);
}

/**
 * Track vector scale optimization usage
 */
export function trackVectorOptimization(timeSavedMs: number): void {
  getTelemetry().trackVectorOptimization(timeSavedMs);
}

/**
 * Track cache access by content type
 */
export function trackCacheAccessByContentType(contentType: string, hit: boolean): void {
  getTelemetry().trackCacheAccessByContentType(contentType, hit);
}

/**
 * Get classification statistics
 */
export function getClassificationStats(): ClassificationStats | null {
  return getTelemetry().getClassificationStats();
}

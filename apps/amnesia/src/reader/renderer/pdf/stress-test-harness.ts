/**
 * Stress Test Harness
 * 
 * Automated stress testing for PDF render lifecycle:
 * - Gesture simulation (direct API + synthetic DOM events)
 * - Quality floor enforcement
 * - JSON report generation
 * 
 * @module stress-test-harness
 */

import { getLifecycleTelemetry, type TelemetryStats } from './lifecycle-telemetry';
import { getDeviceProfileSync, type DeviceProfile } from './device-profiler';
import { getPerformanceConfig, getCurrentTier, type PerformanceConfig } from './performance-config';
import { getTileDiagnosticOverlay } from './tile-diagnostic-overlay';
import type { GesturePhase } from './zoom-scale-service';

/**
 * Quality floors for pass/fail determination
 */
export interface QualityFloor {
  /** Minimum coverage percentage during gesture */
  minCoverageDuringGesture: number;
  /** Minimum coverage percentage at idle */
  minCoverageAtIdle: number;
  /** Maximum time for page to be blank (ms) */
  maxBlankDurationMs: number;
  /** Maximum time to reach sharp tiles after idle (ms) */
  maxTimeToSharpMs: number;
  /** Maximum CSS stretch factor allowed */
  maxCssStretch: number;
  /** Minimum retry success rate */
  minRetrySuccessRate: number;
  /** Maximum drop rate during test */
  maxDropRate: number;
}

/**
 * Default quality floors
 */
export const DEFAULT_QUALITY_FLOORS: QualityFloor = {
  minCoverageDuringGesture: 0.7,  // 70%
  minCoverageAtIdle: 0.95,        // 95%
  maxBlankDurationMs: 100,        // No blank page > 100ms
  maxTimeToSharpMs: 3000,         // Sharp within 3s
  maxCssStretch: 2.0,             // Max 2x stretch
  minRetrySuccessRate: 0.7,       // 70% retry success
  maxDropRate: 0.3,               // Max 30% drops
};

/**
 * Individual test result
 */
export interface StressTestResult {
  /** Test name */
  testName: string;
  /** Test description */
  description: string;
  /** Test duration (ms) */
  durationMs: number;
  /** Whether test passed quality floors */
  passed: boolean;
  /** Specific failures */
  failures: string[];
  /** Warnings (non-fatal) */
  warnings: string[];
  /** Collected metrics */
  metrics: {
    minCoverage: number;
    maxCoverage: number;
    avgCoverage: number;
    maxBlankDurationMs: number;
    timeToSharpMs: number | null;
    maxCssStretch: number;
    totalDrops: number;
    dropRate: number;
    retryAttempts: number;
    retrySuccesses: number;
    retrySuccessRate: number;
    phaseTransitions: number;
    evictionCount: number;
    fallbackUsageRate: number;
    avgRenderTimeMs: number;
  };
  /** Timestamps */
  startTime: number;
  endTime: number;
}

/**
 * Full stress test report
 */
export interface StressTestReport {
  /** Report metadata */
  meta: {
    generatedAt: string;
    harnessVersion: string;
    testDurationMs: number;
  };
  /** Device profile */
  device: DeviceProfile;
  /** Performance configuration used */
  config: PerformanceConfig;
  /** Quality floors used */
  qualityFloors: QualityFloor;
  /** Individual test results */
  tests: StressTestResult[];
  /** Overall summary */
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    warnings: number;
    overallHealth: 'healthy' | 'degraded' | 'critical';
  };
  /** Recommendations based on results */
  recommendations: string[];
  /** Raw telemetry stats */
  telemetryStats: TelemetryStats;
}

/**
 * Canvas accessor interface (to avoid circular deps)
 * Note: Uses 'z' for zoom to match Camera type from pdf-canvas-camera.ts
 */
interface CanvasAccessor {
  getZoom(): number;
  setZoom(zoom: number): void;
  getCamera(): { x: number; y: number; z: number };
  setCamera(x: number, y: number, zoom: number): void;
  getZoomScaleService(): { 
    getGesturePhase(): GesturePhase;
    canRender(): boolean;
  } | null;
  getDiagnosticState(): {
    coverage: number;
    cssStretch: number;
  } | null;
  getContainer(): HTMLElement | null;
}

/**
 * Stress Test Harness
 */
export class StressTestHarness {
  private canvas: CanvasAccessor | null = null;
  private qualityFloors: QualityFloor;
  private telemetry = getLifecycleTelemetry();
  private abortController: AbortController | null = null;
  
  // Test state tracking
  private coverageSamples: number[] = [];
  private cssStretchSamples: number[] = [];
  private blankStartTime: number | null = null;
  private maxBlankDuration = 0;
  private testStartTime = 0;
  private sharpAchievedTime: number | null = null;
  
  constructor(qualityFloors?: Partial<QualityFloor>) {
    this.qualityFloors = { ...DEFAULT_QUALITY_FLOORS, ...qualityFloors };
  }
  
  /**
   * Set the canvas accessor
   */
  setCanvas(canvas: CanvasAccessor): void {
    this.canvas = canvas;
  }
  
  /**
   * Update quality floors
   */
  setQualityFloors(floors: Partial<QualityFloor>): void {
    this.qualityFloors = { ...this.qualityFloors, ...floors };
  }

  // ===== LIVE CAPTURE =====
  
  private liveCaptureSamples: any[] = [];
  private liveCaptureInterval: ReturnType<typeof setInterval> | null = null;
  private liveCaptureStartTime = 0;
  
  /**
   * Start live capture - records state at regular intervals during real gestures
   * @param intervalMs - Sampling interval in ms (default 16ms = 60fps)
   */
  startLiveCapture(intervalMs = 16): void {
    if (!this.canvas) {
      console.error('[StressTestHarness] Cannot start live capture: canvas not set');
      return;
    }
    
    this.stopLiveCapture(); // Clear any existing capture
    this.liveCaptureSamples = [];
    this.liveCaptureStartTime = performance.now();
    
    console.log('[StressTestHarness] Live capture started (interval: ' + intervalMs + 'ms)');
    console.log('[StressTestHarness] Perform your gesture, then call stopLiveCapture()');
    
    this.liveCaptureInterval = setInterval(() => {
      const sample = this.captureLiveSample();
      if (sample) {
        this.liveCaptureSamples.push(sample);
      }
    }, intervalMs);
  }
  
  /**
   * Capture a single live sample
   */
  private captureLiveSample(): any {
    if (!this.canvas) return null;
    
    // Try to get full diagnostic state, fall back to basic
    const fullDiag = (this.canvas as any).getFullDiagnosticState?.();
    if (fullDiag) {
      return {
        ...fullDiag,
        relativeTime: performance.now() - this.liveCaptureStartTime,
      };
    }
    
    // Fallback to basic diagnostics
    const basicDiag = this.canvas.getDiagnosticState?.();
    const zss = this.canvas.getZoomScaleService?.();
    const camera = this.canvas.getCamera?.();
    
    return {
      relativeTime: performance.now() - this.liveCaptureStartTime,
      timestamp: performance.now(),
      zoom: camera?.z ?? this.canvas.getZoom(),
      camera,
      phase: zss?.getGesturePhase?.() ?? 'unknown',
      canRender: zss?.canRender?.() ?? false,
      coverage: basicDiag?.coverage ?? 0,
      cssStretch: basicDiag?.cssStretch ?? 1,
    };
  }
  
  /**
   * Stop live capture and return report
   */
  stopLiveCapture(): {
    samples: any[];
    summary: {
      duration: number;
      sampleCount: number;
      minZoom: number;
      maxZoom: number;
      minCoverage: number;
      maxCoverage: number;
      avgCoverage: number;
      maxCssStretch: number;
      blankDuration: number;
      phaseTransitions: string[];
      coverageDrops: { time: number; from: number; to: number }[];
    };
  } {
    if (this.liveCaptureInterval) {
      clearInterval(this.liveCaptureInterval);
      this.liveCaptureInterval = null;
    }
    
    const samples = this.liveCaptureSamples;
    const duration = samples.length > 0 
      ? samples[samples.length - 1].relativeTime 
      : 0;
    
    // Calculate summary stats
    const zooms = samples.map(s => s.zoom).filter(z => typeof z === 'number' && !isNaN(z));
    const coverages = samples.map(s => s.coverage).filter(c => typeof c === 'number' && !isNaN(c));
    const stretches = samples.map(s => s.cssStretch).filter(s => typeof s === 'number' && !isNaN(s));
    
    // Track phase transitions
    const phaseTransitions: string[] = [];
    let lastPhase = '';
    for (const sample of samples) {
      if (sample.phase && sample.phase !== lastPhase) {
        phaseTransitions.push(`${lastPhase || 'start'} → ${sample.phase} @ ${sample.relativeTime.toFixed(0)}ms`);
        lastPhase = sample.phase;
      }
    }
    
    // Track significant coverage drops
    const coverageDrops: { time: number; from: number; to: number }[] = [];
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1].coverage;
      const curr = samples[i].coverage;
      if (typeof prev === 'number' && typeof curr === 'number' && prev - curr > 20) {
        coverageDrops.push({
          time: samples[i].relativeTime,
          from: prev,
          to: curr,
        });
      }
    }
    
    // Calculate blank duration (coverage < 10%)
    let blankDuration = 0;
    let blankStart: number | null = null;
    for (const sample of samples) {
      if (sample.coverage < 10) {
        if (blankStart === null) blankStart = sample.relativeTime;
      } else {
        if (blankStart !== null) {
          blankDuration = Math.max(blankDuration, sample.relativeTime - blankStart);
          blankStart = null;
        }
      }
    }
    
    const summary = {
      duration,
      sampleCount: samples.length,
      minZoom: zooms.length > 0 ? Math.min(...zooms) : 0,
      maxZoom: zooms.length > 0 ? Math.max(...zooms) : 0,
      minCoverage: coverages.length > 0 ? Math.min(...coverages) : 0,
      maxCoverage: coverages.length > 0 ? Math.max(...coverages) : 0,
      avgCoverage: coverages.length > 0 
        ? coverages.reduce((a, b) => a + b, 0) / coverages.length 
        : 0,
      maxCssStretch: stretches.length > 0 ? Math.max(...stretches) : 1,
      blankDuration,
      phaseTransitions,
      coverageDrops,
    };
    
    console.log('[StressTestHarness] Live capture stopped');
    console.log('[StressTestHarness] Summary:', JSON.stringify(summary, null, 2));
    
    return { samples, summary };
  }
  
  /**
   * Get current live capture samples (for monitoring during capture)
   */
  getLiveCaptureSamples(): any[] {
    return [...this.liveCaptureSamples];
  }
  
  // ===== GESTURE SIMULATION =====
  
  /**
   * Wait for next animation frame
   */
  private frame(): Promise<number> {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }
  
  /**
   * Wait for specified milliseconds
   */
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Easing function for smooth animations
   */
  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }
  
  /**
   * Simulate zoom gesture (direct API call)
   */
  async simulateZoomDirect(
    targetZoom: number, 
    durationMs: number,
    onFrame?: (zoom: number) => void
  ): Promise<void> {
    if (!this.canvas) throw new Error('Canvas not set');
    
    const startZoom = this.canvas.getZoom();
    const steps = Math.max(1, Math.ceil(durationMs / 16));
    
    for (let i = 0; i <= steps; i++) {
      if (this.abortController?.signal.aborted) return;
      
      const t = i / steps;
      const eased = this.easeOutCubic(t);
      const zoom = startZoom + (targetZoom - startZoom) * eased;
      
      this.canvas.setZoom(zoom);
      this.sampleMetrics();
      onFrame?.(zoom);
      
      await this.frame();
    }
  }
  
  /**
   * Simulate pan gesture (direct API call)
   */
  async simulatePanDirect(
    deltaX: number, 
    deltaY: number, 
    durationMs: number,
    onFrame?: (x: number, y: number) => void
  ): Promise<void> {
    if (!this.canvas) throw new Error('Canvas not set');
    
    const startCamera = this.canvas.getCamera();
    const steps = Math.max(1, Math.ceil(durationMs / 16));
    
    for (let i = 0; i <= steps; i++) {
      if (this.abortController?.signal.aborted) return;
      
      const t = i / steps;
      const eased = this.easeOutCubic(t);
      const x = startCamera.x + deltaX * eased;
      const y = startCamera.y + deltaY * eased;
      
      this.canvas.setCamera(x, y, startCamera.z);
      this.sampleMetrics();
      onFrame?.(x, y);
      
      await this.frame();
    }
  }
  
  /**
   * Simulate wheel event (synthetic DOM event)
   */
  async simulateWheelEvent(
    deltaY: number, 
    ctrlKey: boolean = false,
    clientX?: number,
    clientY?: number
  ): Promise<void> {
    if (!this.canvas) throw new Error('Canvas not set');
    
    const container = this.canvas.getContainer();
    if (!container) throw new Error('Container not found');
    
    const rect = container.getBoundingClientRect();
    const x = clientX ?? rect.left + rect.width / 2;
    const y = clientY ?? rect.top + rect.height / 2;
    
    const event = new WheelEvent('wheel', {
      deltaY,
      deltaX: 0,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey,
      metaKey: ctrlKey, // For Mac
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });
    
    container.dispatchEvent(event);
    this.sampleMetrics();
    await this.frame();
  }
  
  /**
   * Simulate a series of wheel events for smooth zoom
   */
  async simulateWheelZoom(
    targetZoom: number,
    durationMs: number
  ): Promise<void> {
    if (!this.canvas) throw new Error('Canvas not set');
    
    const startZoom = this.canvas.getZoom();
    const zoomRatio = targetZoom / startZoom;
    const steps = Math.max(1, Math.ceil(durationMs / 50)); // 50ms between events
    
    for (let i = 0; i < steps; i++) {
      if (this.abortController?.signal.aborted) return;
      
      // Calculate delta to achieve portion of zoom
      const stepRatio = Math.pow(zoomRatio, 1 / steps);
      const deltaY = stepRatio > 1 ? -100 : 100; // Negative = zoom in
      
      await this.simulateWheelEvent(deltaY, true);
      await this.wait(50);
    }
  }
  
  // ===== METRIC SAMPLING =====
  
  /**
   * Sample current metrics
   */
  private sampleMetrics(): void {
    const diag = this.canvas?.getDiagnosticState?.();
    if (!diag) return;
    
    // Coverage
    this.coverageSamples.push(diag.coverage);
    
    // CSS stretch
    this.cssStretchSamples.push(diag.cssStretch);
    
    // Track blank page
    if (diag.coverage < 10) {
      if (!this.blankStartTime) {
        this.blankStartTime = performance.now();
      }
    } else {
      if (this.blankStartTime) {
        const blankDuration = performance.now() - this.blankStartTime;
        this.maxBlankDuration = Math.max(this.maxBlankDuration, blankDuration);
        this.blankStartTime = null;
      }
    }
    
    // Track time to sharp
    if (diag.cssStretch <= 1.1 && !this.sharpAchievedTime) {
      this.sharpAchievedTime = performance.now();
    }
  }
  
  /**
   * Reset metric tracking for new test
   */
  private resetMetrics(): void {
    this.coverageSamples = [];
    this.cssStretchSamples = [];
    this.blankStartTime = null;
    this.maxBlankDuration = 0;
    this.testStartTime = performance.now();
    this.sharpAchievedTime = null;
  }
  
  /**
   * Wait for idle phase
   */
  async waitForIdle(timeoutMs = 10000): Promise<boolean> {
    const startTime = performance.now();
    
    while (performance.now() - startTime < timeoutMs) {
      if (this.abortController?.signal.aborted) return false;
      
      const zss = this.canvas?.getZoomScaleService?.();
      if (zss?.getGesturePhase() === 'idle' && zss?.canRender()) {
        return true;
      }
      
      this.sampleMetrics();
      await this.wait(50);
    }
    
    return false;
  }
  
  /**
   * Wait for coverage target
   */
  async waitForCoverage(target: number, timeoutMs = 10000): Promise<boolean> {
    const startTime = performance.now();
    
    while (performance.now() - startTime < timeoutMs) {
      if (this.abortController?.signal.aborted) return false;
      
      const diag = this.canvas?.getDiagnosticState?.();
      if (diag && diag.coverage >= target * 100) {
        return true;
      }
      
      this.sampleMetrics();
      await this.wait(50);
    }
    
    return false;
  }
  
  // ===== TESTS =====
  
  /**
   * Test A: Zoom-out eviction
   * Zoom to max, then zoom out - page should never go blank
   */
  async runZoomOutEvictionTest(): Promise<StressTestResult> {
    this.resetMetrics();
    const startTime = performance.now();
    const failures: string[] = [];
    const warnings: string[] = [];
    
    this.telemetry.clear();
    this.telemetry.setEnabled(true);
    
    try {
      // 1. Start at 1x
      await this.simulateZoomDirect(1, 100);
      await this.waitForIdle(5000);
      
      // 2. Zoom to max (32x)
      await this.simulateZoomDirect(32, 800);
      await this.waitForIdle(5000);
      await this.waitForCoverage(0.95, 5000);
      
      // 3. Zoom out to 1x
      this.resetMetrics(); // Reset for zoom-out phase
      await this.simulateZoomDirect(1, 800);
      
      // 4. Wait for recovery
      await this.waitForIdle(5000);
      await this.waitForCoverage(0.95, 5000);
      
    } catch (e) {
      failures.push(`Test error: ${(e as Error).message}`);
    }
    
    const endTime = performance.now();
    const stats = this.telemetry.getStats();
    
    // Evaluate results
    if (this.maxBlankDuration > this.qualityFloors.maxBlankDurationMs) {
      failures.push(`Page blank for ${this.maxBlankDuration.toFixed(0)}ms (max: ${this.qualityFloors.maxBlankDurationMs}ms)`);
    }
    
    const minCoverage = Math.min(...this.coverageSamples) / 100;
    if (minCoverage < this.qualityFloors.minCoverageDuringGesture) {
      failures.push(`Coverage dropped to ${(minCoverage * 100).toFixed(1)}% (min: ${this.qualityFloors.minCoverageDuringGesture * 100}%)`);
    }
    
    return this.buildResult(
      'Zoom-Out Eviction',
      'Zoom to max then back to 1x - page should never go blank',
      startTime, endTime, failures, warnings, stats
    );
  }
  
  /**
   * Test B: Queue drop recovery
   * Rapid pan at mid-zoom - dropped tiles should recover
   */
  async runQueueDropRecoveryTest(): Promise<StressTestResult> {
    this.resetMetrics();
    const startTime = performance.now();
    const failures: string[] = [];
    const warnings: string[] = [];
    
    this.telemetry.clear();
    this.telemetry.setEnabled(true);
    
    try {
      // 1. Start at 8x
      await this.simulateZoomDirect(8, 300);
      await this.waitForIdle(5000);
      
      // 2. Rapid pan in multiple directions
      for (let i = 0; i < 5; i++) {
        if (this.abortController?.signal.aborted) break;
        
        const angle = (i * 72) * Math.PI / 180; // 72° increments
        const dx = Math.cos(angle) * 500;
        const dy = Math.sin(angle) * 500;
        
        await this.simulatePanDirect(dx, dy, 200);
      }
      
      // 3. Wait for recovery
      await this.waitForIdle(5000);
      const recovered = await this.waitForCoverage(0.95, 5000);
      
      if (!recovered) {
        warnings.push('Coverage did not reach 95% within 5s');
      }
      
    } catch (e) {
      failures.push(`Test error: ${(e as Error).message}`);
    }
    
    const endTime = performance.now();
    const stats = this.telemetry.getStats();
    
    // Evaluate results
    if (stats.dropRate > this.qualityFloors.maxDropRate) {
      failures.push(`Drop rate ${(stats.dropRate * 100).toFixed(1)}% exceeds max ${this.qualityFloors.maxDropRate * 100}%`);
    }
    
    if (stats.retrySuccessRate < this.qualityFloors.minRetrySuccessRate && stats.dropRate > 0.1) {
      failures.push(`Retry success rate ${(stats.retrySuccessRate * 100).toFixed(1)}% below min ${this.qualityFloors.minRetrySuccessRate * 100}%`);
    }
    
    return this.buildResult(
      'Queue Drop Recovery',
      'Rapid pan at 8x zoom - dropped tiles should be retried and recover',
      startTime, endTime, failures, warnings, stats
    );
  }
  
  /**
   * Test C: Blurry tile persistence
   * Zoom to high level, pan to new area - should get sharp tiles
   */
  async runBlurryTilePersistenceTest(): Promise<StressTestResult> {
    this.resetMetrics();
    const startTime = performance.now();
    const failures: string[] = [];
    const warnings: string[] = [];
    
    this.telemetry.clear();
    this.telemetry.setEnabled(true);
    
    try {
      // 1. Start at 16x
      await this.simulateZoomDirect(16, 500);
      await this.waitForIdle(5000);
      
      // 2. Pan to completely new area
      await this.simulatePanDirect(2000, 1500, 500);
      
      // 3. Wait and track time to sharp
      await this.waitForIdle(5000);
      
      // Monitor for 15 seconds
      const monitorStart = performance.now();
      while (performance.now() - monitorStart < 15000) {
        if (this.abortController?.signal.aborted) break;
        
        this.sampleMetrics();
        
        // Check if we got sharp
        const diag = this.canvas?.getDiagnosticState?.();
        if (diag && diag.cssStretch <= 1.1) {
          break;
        }
        
        await this.wait(100);
      }
      
    } catch (e) {
      failures.push(`Test error: ${(e as Error).message}`);
    }
    
    const endTime = performance.now();
    const stats = this.telemetry.getStats();
    
    // Evaluate results
    const timeToSharp = this.sharpAchievedTime 
      ? this.sharpAchievedTime - this.testStartTime 
      : null;
    
    if (!timeToSharp) {
      failures.push('Sharp tiles never achieved');
    } else if (timeToSharp > this.qualityFloors.maxTimeToSharpMs) {
      failures.push(`Time to sharp ${timeToSharp.toFixed(0)}ms exceeds max ${this.qualityFloors.maxTimeToSharpMs}ms`);
    }
    
    const maxStretch = Math.max(...this.cssStretchSamples);
    if (maxStretch > this.qualityFloors.maxCssStretch) {
      warnings.push(`Max CSS stretch ${maxStretch.toFixed(2)} exceeds preferred ${this.qualityFloors.maxCssStretch}`);
    }
    
    return this.buildResult(
      'Blurry Tile Persistence',
      'Zoom to 16x and pan to new area - should achieve sharp tiles within 3s',
      startTime, endTime, failures, warnings, stats
    );
  }
  
  /**
   * Test D: Rapid zoom oscillation
   * Rapidly zoom in/out - should maintain coverage
   */
  async runRapidZoomOscillationTest(): Promise<StressTestResult> {
    this.resetMetrics();
    const startTime = performance.now();
    const failures: string[] = [];
    const warnings: string[] = [];
    
    this.telemetry.clear();
    this.telemetry.setEnabled(true);
    
    try {
      // Reset to known state first (previous test may have panned out of bounds)
      this.canvas?.setCamera?.(0, 0, 1);
      await this.wait(200);
      
      // Oscillate between 4x and 16x, 5 times
      for (let i = 0; i < 5; i++) {
        if (this.abortController?.signal.aborted) break;
        
        await this.simulateZoomDirect(16, 300);
        await this.wait(100);
        await this.simulateZoomDirect(4, 300);
        await this.wait(100);
      }
      
      // Wait for stabilization
      await this.waitForIdle(5000);
      await this.waitForCoverage(0.95, 5000);
      
    } catch (e) {
      failures.push(`Test error: ${(e as Error).message}`);
    }
    
    const endTime = performance.now();
    const stats = this.telemetry.getStats();
    
    // Evaluate
    const avgCoverage = this.coverageSamples.reduce((a, b) => a + b, 0) / this.coverageSamples.length / 100;
    if (avgCoverage < 0.6) {
      failures.push(`Average coverage ${(avgCoverage * 100).toFixed(1)}% too low during oscillation`);
    }
    
    return this.buildResult(
      'Rapid Zoom Oscillation',
      'Rapidly oscillate between 4x and 16x - should maintain reasonable coverage',
      startTime, endTime, failures, warnings, stats
    );
  }
  
  /**
   * Test E: Synthetic wheel gestures
   * Uses DOM events instead of direct API calls
   */
  async runSyntheticWheelTest(): Promise<StressTestResult> {
    this.resetMetrics();
    const startTime = performance.now();
    const failures: string[] = [];
    const warnings: string[] = [];
    
    this.telemetry.clear();
    this.telemetry.setEnabled(true);
    
    try {
      // Zoom in using wheel events
      for (let i = 0; i < 10; i++) {
        if (this.abortController?.signal.aborted) break;
        await this.simulateWheelEvent(-120, true); // Ctrl+wheel up = zoom in
        await this.wait(50);
      }
      
      await this.waitForIdle(3000);
      
      // Zoom out using wheel events
      for (let i = 0; i < 10; i++) {
        if (this.abortController?.signal.aborted) break;
        await this.simulateWheelEvent(120, true); // Ctrl+wheel down = zoom out
        await this.wait(50);
      }
      
      await this.waitForIdle(3000);
      await this.waitForCoverage(0.9, 5000);
      
    } catch (e) {
      failures.push(`Test error: ${(e as Error).message}`);
    }
    
    const endTime = performance.now();
    const stats = this.telemetry.getStats();
    
    return this.buildResult(
      'Synthetic Wheel Gestures',
      'Zoom using synthetic wheel events - tests gesture handler path',
      startTime, endTime, failures, warnings, stats
    );
  }
  
  // ===== REPORT GENERATION =====
  
  /**
   * Build a test result
   */
  private buildResult(
    testName: string,
    description: string,
    startTime: number,
    endTime: number,
    failures: string[],
    warnings: string[],
    stats: TelemetryStats
  ): StressTestResult {
    const minCoverage = this.coverageSamples.length > 0 
      ? Math.min(...this.coverageSamples) / 100 : 0;
    const maxCoverage = this.coverageSamples.length > 0 
      ? Math.max(...this.coverageSamples) / 100 : 0;
    const avgCoverage = this.coverageSamples.length > 0
      ? (this.coverageSamples.reduce((a, b) => a + b, 0) / this.coverageSamples.length) / 100 : 0;
    const maxCssStretch = this.cssStretchSamples.length > 0
      ? Math.max(...this.cssStretchSamples) : 0;
    
    return {
      testName,
      description,
      durationMs: endTime - startTime,
      passed: failures.length === 0,
      failures,
      warnings,
      metrics: {
        minCoverage,
        maxCoverage,
        avgCoverage,
        maxBlankDurationMs: this.maxBlankDuration,
        timeToSharpMs: this.sharpAchievedTime ? this.sharpAchievedTime - this.testStartTime : null,
        maxCssStretch,
        totalDrops: stats.eventsByType.drop,
        dropRate: stats.dropRate,
        retryAttempts: stats.eventsByType['retry-attempt'],
        retrySuccesses: stats.eventsByType['retry-success'],
        retrySuccessRate: stats.retrySuccessRate,
        phaseTransitions: stats.phaseTransitions,
        evictionCount: Object.values(stats.evictionsByReason).reduce((a, b) => a + b, 0),
        fallbackUsageRate: stats.fallbackUsageRate,
        avgRenderTimeMs: stats.avgRenderTime,
      },
      startTime,
      endTime,
    };
  }
  
  /**
   * Run all tests and generate report
   */
  async runAllTests(): Promise<StressTestReport> {
    this.abortController = new AbortController();
    const reportStartTime = performance.now();
    const tests: StressTestResult[] = [];
    
    console.log('[StressTestHarness] Starting full test suite...');
    
    // Run each test
    const testFunctions = [
      () => this.runZoomOutEvictionTest(),
      () => this.runQueueDropRecoveryTest(),
      () => this.runBlurryTilePersistenceTest(),
      () => this.runRapidZoomOscillationTest(),
      () => this.runSyntheticWheelTest(),
    ];
    
    for (const testFn of testFunctions) {
      if (this.abortController.signal.aborted) break;
      
      try {
        const result = await testFn();
        tests.push(result);
        console.log(`[StressTestHarness] ${result.testName}: ${result.passed ? 'PASSED' : 'FAILED'}`);
        
        // Wait between tests
        await this.wait(1000);
      } catch (e) {
        console.error('[StressTestHarness] Test error:', e);
      }
    }
    
    const reportEndTime = performance.now();
    
    // Build report
    const passed = tests.filter(t => t.passed).length;
    const failed = tests.filter(t => !t.passed).length;
    const warnings = tests.reduce((sum, t) => sum + t.warnings.length, 0);
    
    let overallHealth: 'healthy' | 'degraded' | 'critical';
    if (failed === 0) {
      overallHealth = 'healthy';
    } else if (failed <= tests.length / 2) {
      overallHealth = 'degraded';
    } else {
      overallHealth = 'critical';
    }
    
    // Generate recommendations
    const recommendations = this.generateRecommendations(tests);
    
    const report: StressTestReport = {
      meta: {
        generatedAt: new Date().toISOString(),
        harnessVersion: '1.0.0',
        testDurationMs: reportEndTime - reportStartTime,
      },
      device: getDeviceProfileSync(),
      config: getPerformanceConfig(),
      qualityFloors: this.qualityFloors,
      tests,
      summary: {
        totalTests: tests.length,
        passed,
        failed,
        warnings,
        overallHealth,
      },
      recommendations,
      telemetryStats: this.telemetry.getStats(),
    };
    
    console.log(`[StressTestHarness] Complete: ${passed}/${tests.length} passed, health: ${overallHealth}`);
    
    return report;
  }
  
  /**
   * Generate recommendations based on test results
   */
  private generateRecommendations(tests: StressTestResult[]): string[] {
    const recommendations: string[] = [];
    
    // Analyze failures
    const zoomOutTest = tests.find(t => t.testName === 'Zoom-Out Eviction');
    if (zoomOutTest && !zoomOutTest.passed) {
      recommendations.push('Consider preserving fallback tiles during zoom-out transitions');
      recommendations.push('Review L1 cache eviction policy on significant zoom changes');
    }
    
    const dropTest = tests.find(t => t.testName === 'Queue Drop Recovery');
    if (dropTest && !dropTest.passed) {
      if (dropTest.metrics.retrySuccessRate < 0.5) {
        recommendations.push('Increase retry queue TTL or process more frequently');
      }
      if (dropTest.metrics.dropRate > 0.3) {
        recommendations.push('Consider increasing semaphore queue limit or reducing prefetch aggressiveness');
      }
    }
    
    const blurryTest = tests.find(t => t.testName === 'Blurry Tile Persistence');
    if (blurryTest && !blurryTest.passed) {
      recommendations.push('Check if render phase is being triggered after gesture ends');
      recommendations.push('Verify watchdog timer is forcing idle state when stuck');
    }
    
    // General recommendations based on metrics
    const avgDropRate = tests.reduce((sum, t) => sum + t.metrics.dropRate, 0) / tests.length;
    if (avgDropRate > 0.2) {
      recommendations.push('High overall drop rate - consider reducing concurrent render limit during gestures');
    }
    
    const avgFallback = tests.reduce((sum, t) => sum + t.metrics.fallbackUsageRate, 0) / tests.length;
    if (avgFallback > 0.3) {
      recommendations.push('High fallback usage - consider increasing cache sizes or improving prefetch prediction');
    }
    
    return recommendations;
  }
  
  /**
   * Abort running tests
   */
  abort(): void {
    this.abortController?.abort();
  }
  
  /**
   * Export report to file
   */
  async exportReport(report: StressTestReport, vaultPath: string): Promise<string | null> {
    try {
      const fs = require('fs');
      const path = require('path');
      
      const reportsDir = path.join(vaultPath, '.obsidian', 'plugins', 'amnesia', 'reports');
      if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `stress-test-${timestamp}.json`;
      const filePath = path.join(reportsDir, filename);
      
      fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
      
      console.log(`[StressTestHarness] Report exported to: ${filePath}`);
      return filePath;
    } catch (e) {
      console.error('[StressTestHarness] Export failed:', e);
      return null;
    }
  }
}

// Singleton instance
let harnessInstance: StressTestHarness | null = null;

/**
 * Get the stress test harness instance
 */
export function getStressTestHarness(): StressTestHarness {
  if (!harnessInstance) {
    harnessInstance = new StressTestHarness();
  }
  return harnessInstance;
}

// Expose to window for console access
if (typeof window !== 'undefined') {
  (window as unknown as { stressTestHarness: StressTestHarness }).stressTestHarness = getStressTestHarness();
}

/**
 * Optimization Health Check
 *
 * Automated validation runner that checks:
 * - Device profile matches applied configuration
 * - T2HR metrics against target thresholds
 * - Focal-point prioritization effectiveness
 * - Generates actionable recommendations
 *
 * Run via DiagnosticsTab or devtools:
 *   window.runOptimizationHealthCheck()
 *
 * @module optimization-health-check
 */

import { getDeviceProfileSync, type DeviceProfile } from './device-profiler';
import { getPerformanceConfig, getCurrentTier, type PerformanceConfig } from './performance-config';
import { getT2HRTracker, getT2HRThreshold, type T2HRStats } from './t2hr-tracker';
import { getFocalPointTracker, type FocalPointStats } from './focal-point-tracker';
import { getFeatureFlags, type ResolvedFeatureFlags } from './feature-flags';
import { isFeatureEnabled } from './feature-flags';

// =============================================================================
// Types
// =============================================================================

export type HealthStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface HealthCheckResult {
  name: string;
  status: HealthStatus;
  message: string;
  details?: Record<string, unknown>;
  recommendation?: string;
}

export interface HealthCheckReport {
  timestamp: Date;
  overallStatus: HealthStatus;
  checks: HealthCheckResult[];
  summary: string;
  recommendations: string[];
}

// Expected config values per device tier
const EXPECTED_CONFIG_BY_TIER: Record<string, {
  minMaxScale: number;
  minWorkers: number;
  minConcurrent: number;
  minL1Cache: number;
}> = {
  extreme: { minMaxScale: 64, minWorkers: 4, minConcurrent: 8, minL1Cache: 64 },
  high: { minMaxScale: 32, minWorkers: 4, minConcurrent: 6, minL1Cache: 48 },
  medium: { minMaxScale: 16, minWorkers: 2, minConcurrent: 4, minL1Cache: 32 },
  low: { minMaxScale: 8, minWorkers: 1, minConcurrent: 2, minL1Cache: 16 },
};

// =============================================================================
// Individual Health Checks
// =============================================================================

/**
 * Check 1: Device Tier Detection
 */
function checkDeviceTier(): HealthCheckResult {
  const profile = getDeviceProfileSync();
  const tier = getCurrentTier();

  if (!profile) {
    return {
      name: 'Device Tier Detection',
      status: 'unknown',
      message: 'Device profile not available',
      recommendation: 'Wait for device detection to complete',
    };
  }

  // Validate tier is reasonable for hardware
  const memGB = profile.memory.totalGB;
  const cores = profile.cpu.cores;

  let expectedTier: string;
  if (memGB >= 16 && cores >= 8) {
    expectedTier = 'extreme';
  } else if (memGB >= 8 && cores >= 4) {
    expectedTier = 'high';
  } else if (memGB >= 4 && cores >= 2) {
    expectedTier = 'medium';
  } else {
    expectedTier = 'low';
  }

  const isCorrect = tier === expectedTier || 
    (tier === 'high' && expectedTier === 'extreme') || // High is acceptable for extreme
    (tier === 'medium' && expectedTier === 'high');    // Medium is acceptable for high (conservative)

  return {
    name: 'Device Tier Detection',
    status: isCorrect ? 'pass' : 'warn',
    message: isCorrect 
      ? `Detected ${tier} tier for ${memGB.toFixed(1)}GB / ${cores} cores`
      : `Detected ${tier} tier but expected ${expectedTier} for ${memGB.toFixed(1)}GB / ${cores} cores`,
    details: {
      detectedTier: tier,
      expectedTier,
      memory: memGB,
      cores,
    },
    recommendation: isCorrect ? undefined : `Consider manually setting tier to ${expectedTier}`,
  };
}

/**
 * Check 2: Configuration Match
 */
function checkConfigMatch(): HealthCheckResult {
  const tier = getCurrentTier();
  const config = getPerformanceConfig();
  const expected = EXPECTED_CONFIG_BY_TIER[tier];

  if (!config || !expected) {
    return {
      name: 'Configuration Match',
      status: 'unknown',
      message: 'Configuration not available',
    };
  }

  const issues: string[] = [];

  if (config.maxScaleTier < expected.minMaxScale) {
    issues.push(`maxScale ${config.maxScaleTier} < expected ${expected.minMaxScale}`);
  }
  if (config.workerCount < expected.minWorkers) {
    issues.push(`workers ${config.workerCount} < expected ${expected.minWorkers}`);
  }
  if (config.maxConcurrentRenders < expected.minConcurrent) {
    issues.push(`concurrent ${config.maxConcurrentRenders} < expected ${expected.minConcurrent}`);
  }
  if (config.l1CacheSize < expected.minL1Cache) {
    issues.push(`l1Cache ${config.l1CacheSize} < expected ${expected.minL1Cache}`);
  }

  return {
    name: 'Configuration Match',
    status: issues.length === 0 ? 'pass' : 'warn',
    message: issues.length === 0 
      ? `Config matches ${tier} tier expectations`
      : `Config mismatch: ${issues.join(', ')}`,
    details: {
      tier,
      expected,
      actual: {
        maxScale: config.maxScaleTier,
        workers: config.workerCount,
        concurrent: config.maxConcurrentRenders,
        l1Cache: config.l1CacheSize,
      },
    },
    recommendation: issues.length > 0 
      ? 'Check device-profiler.ts and performance-config.ts for tier-config mapping'
      : undefined,
  };
}

/**
 * Check 3: T2HR Performance
 * 
 * v2: Now tracks by source (zoom vs pan) to reveal the "nudge bug"
 * where zoom-initiated tiles don't display until user pans.
 */
function checkT2HRPerformance(): HealthCheckResult {
  const tracker = getT2HRTracker();
  const stats = tracker.getStats();

  const totalCount = stats.combined.count;
  if (totalCount === 0) {
    return {
      name: 'T2HR Performance',
      status: 'unknown',
      message: 'No T2HR data available. Zoom or pan to generate measurements.',
    };
  }

  // Check for the "nudge bug": zoom tiles never displayed but pan tiles work
  const zoomNeverDisplayed = stats.zoomTilesNeverDisplayed;
  const panImmediate = stats.panTilesDisplayedImmediately;
  const hasNudgeBug = zoomNeverDisplayed > 5 && panImmediate > 0;

  // Evaluate each source
  const issues: string[] = [];
  const warnings: string[] = [];
  
  // Using zoom32 thresholds as baseline (most demanding)
  const threshold = getT2HRThreshold(32);

  // Check zoom-initiated T2HR
  if (stats.zoom.count > 0) {
    if (stats.zoom.avgMs > threshold.fail) {
      issues.push(`Zoom T2HR: ${stats.zoom.avgMs}ms (>${threshold.fail}ms)`);
    } else if (stats.zoom.avgMs > threshold.warn) {
      warnings.push(`Zoom T2HR: ${stats.zoom.avgMs}ms (>${threshold.warn}ms)`);
    }
  }

  // Check pan-initiated T2HR
  if (stats.pan.count > 0) {
    if (stats.pan.avgMs > threshold.fail) {
      issues.push(`Pan T2HR: ${stats.pan.avgMs}ms (>${threshold.fail}ms)`);
    } else if (stats.pan.avgMs > threshold.warn) {
      warnings.push(`Pan T2HR: ${stats.pan.avgMs}ms (>${threshold.warn}ms)`);
    }
  }

  let status: HealthStatus = 'pass';
  let message: string;
  let recommendation: string | undefined;

  if (hasNudgeBug) {
    status = 'fail';
    message = `NUDGE BUG DETECTED: ${zoomNeverDisplayed} zoom tiles never displayed, but pan works (${panImmediate} immediate).`;
    recommendation = 'Tiles complete rendering but are not pushed to canvas. Check re-composite trigger after render completion.';
  } else if (issues.length > 0) {
    status = 'fail';
    message = issues.join('; ');
    recommendation = 'Check tile rendering pipeline for bottlenecks. See T2HR breakdown in DIAG tab.';
  } else if (warnings.length > 0) {
    status = 'warn';
    message = warnings.join('; ');
    recommendation = 'Consider reducing max zoom or optimizing worker pool.';
  } else {
    message = `T2HR within targets. Combined avg: ${stats.combined.avgMs}ms (${totalCount} tiles)`;
  }

  return {
    name: 'T2HR Performance',
    status,
    message,
    details: {
      combined: stats.combined,
      zoom: stats.zoom,
      pan: stats.pan,
      scroll: stats.scroll,
      zoomTilesNeverDisplayed: stats.zoomTilesNeverDisplayed,
      panTilesDisplayedImmediately: stats.panTilesDisplayedImmediately,
    },
    recommendation,
  };
}

/**
 * Check 4: Focal-Point Prioritization
 */
function checkFocalPointPrioritization(): HealthCheckResult {
  const tracker = getFocalPointTracker();
  const stats = tracker.getStats();

  if (!stats || stats.gestureCount === 0) {
    return {
      name: 'Focal-Point Prioritization',
      status: 'unknown',
      message: 'No focal-point data available. Zoom or pan to generate measurements.',
    };
  }

  const criticalFirstRate = stats.avgCriticalFirstRate;
  const inversions = stats.avgPriorityInversions;

  let status: HealthStatus;
  let message: string;
  let recommendation: string | undefined;

  if (criticalFirstRate >= 0.8 && inversions < 3) {
    status = 'pass';
    message = `Prioritization effective: ${Math.round(criticalFirstRate * 100)}% critical-first, ${inversions.toFixed(1)} avg inversions`;
  } else if (criticalFirstRate >= 0.6 && inversions < 10) {
    status = 'warn';
    message = `Prioritization suboptimal: ${Math.round(criticalFirstRate * 100)}% critical-first, ${inversions.toFixed(1)} avg inversions`;
    recommendation = 'Check priority queue implementation. High inversions suggest queue instability.';
  } else {
    status = 'fail';
    message = `Prioritization ineffective: ${Math.round(criticalFirstRate * 100)}% critical-first, ${inversions.toFixed(1)} avg inversions`;
    recommendation = 'Focal-point prioritization is not working. Check RenderCoordinator.requestRender() priority handling.';
  }

  return {
    name: 'Focal-Point Prioritization',
    status,
    message,
    details: {
      criticalFirstRate,
      avgPriorityInversions: inversions,
      gestureCount: stats.gestureCount,
      avgPriorityDistribution: stats.avgPriorityDistribution,
    },
    recommendation,
  };
}

/**
 * Check 5: Feature Flags Sanity
 */
function checkFeatureFlags(): HealthCheckResult {
  const flags = getFeatureFlags().resolveFlags();
  const issues: string[] = [];

  // Check for conflicting or suboptimal flags
  if (!flags.useExactScaleRendering && flags.useZoomStateManager) {
    // This combination should work, but exact scale is recommended
    issues.push('useExactScaleRendering disabled - may cause zoom quality jumps');
  }

  if (flags.useDebugTiles) {
    issues.push('useDebugTiles enabled - disable for production');
  }

  if (!flags.useCoordinatorForFullPage) {
    issues.push('useCoordinatorForFullPage disabled - full-page renders bypass semaphore');
  }

  if (!flags.useTileComplianceValidation) {
    // Not an issue, just informational
  }

  return {
    name: 'Feature Flags',
    status: issues.length === 0 ? 'pass' : 'warn',
    message: issues.length === 0 
      ? 'Feature flags configured correctly'
      : `Flag issues: ${issues.join('; ')}`,
    details: flags as unknown as Record<string, unknown>,
    recommendation: issues.length > 0 ? 'Review feature flags in devtools' : undefined,
  };
}

/**
 * Check 6: Memory Pressure
 */
function checkMemoryPressure(): HealthCheckResult {
  const profile = getDeviceProfileSync();
  
  if (!profile) {
    return {
      name: 'Memory Pressure',
      status: 'unknown',
      message: 'Device profile not available',
    };
  }

  // Check if JS heap is available (Chrome-only)
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  
  if (!memory) {
    return {
      name: 'Memory Pressure',
      status: 'unknown',
      message: 'Memory API not available (non-Chrome browser)',
    };
  }

  const usedMB = memory.usedJSHeapSize / (1024 * 1024);
  const limitMB = memory.jsHeapSizeLimit / (1024 * 1024);
  const usagePercent = (usedMB / limitMB) * 100;

  let status: HealthStatus;
  let message: string;
  let recommendation: string | undefined;

  if (usagePercent < 50) {
    status = 'pass';
    message = `Memory OK: ${usedMB.toFixed(0)}MB / ${limitMB.toFixed(0)}MB (${usagePercent.toFixed(0)}%)`;
  } else if (usagePercent < 75) {
    status = 'warn';
    message = `Memory elevated: ${usedMB.toFixed(0)}MB / ${limitMB.toFixed(0)}MB (${usagePercent.toFixed(0)}%)`;
    recommendation = 'Consider clearing tile cache or reducing max zoom';
  } else {
    status = 'fail';
    message = `Memory critical: ${usedMB.toFixed(0)}MB / ${limitMB.toFixed(0)}MB (${usagePercent.toFixed(0)}%)`;
    recommendation = 'Clear tile cache immediately. Reduce concurrent renders.';
  }

  return {
    name: 'Memory Pressure',
    status,
    message,
    details: {
      usedMB,
      limitMB,
      usagePercent,
      deviceMemoryGB: profile.memory.totalGB,
    },
    recommendation,
  };
}

// =============================================================================
// Main Health Check Runner
// =============================================================================

/**
 * Run all health checks and generate a report
 */
export function runHealthCheck(): HealthCheckReport {
  const checks: HealthCheckResult[] = [
    checkDeviceTier(),
    checkConfigMatch(),
    checkT2HRPerformance(),
    checkFocalPointPrioritization(),
    checkFeatureFlags(),
    checkMemoryPressure(),
  ];

  // Determine overall status
  const statuses = checks.map(c => c.status);
  let overallStatus: HealthStatus;
  if (statuses.includes('fail')) {
    overallStatus = 'fail';
  } else if (statuses.includes('warn')) {
    overallStatus = 'warn';
  } else if (statuses.every(s => s === 'pass')) {
    overallStatus = 'pass';
  } else {
    overallStatus = 'unknown';
  }

  // Collect recommendations
  const recommendations = checks
    .filter(c => c.recommendation)
    .map(c => `[${c.name}] ${c.recommendation!}`);

  // Generate summary
  const passCount = statuses.filter(s => s === 'pass').length;
  const warnCount = statuses.filter(s => s === 'warn').length;
  const failCount = statuses.filter(s => s === 'fail').length;
  const unknownCount = statuses.filter(s => s === 'unknown').length;

  const summary = `${passCount} pass, ${warnCount} warn, ${failCount} fail, ${unknownCount} unknown`;

  const report: HealthCheckReport = {
    timestamp: new Date(),
    overallStatus,
    checks,
    summary,
    recommendations,
  };

  // Log to console if diagnostics JSON export is enabled
  if (isFeatureEnabled('exportDiagnosticsJson')) {
    console.log('[HealthCheck] Report:', JSON.stringify(report, null, 2));
  }

  return report;
}

/**
 * Get a quick status string for display
 */
export function getQuickHealthStatus(): { status: HealthStatus; summary: string } {
  const report = runHealthCheck();
  return {
    status: report.overallStatus,
    summary: report.summary,
  };
}

// =============================================================================
// Window Global for DevTools Access
// =============================================================================

let healthCheckInstance: { runHealthCheck: typeof runHealthCheck; getQuickHealthStatus: typeof getQuickHealthStatus } | null = null;

/**
 * Get or create the health check instance
 */
export function getHealthCheck() {
  if (!healthCheckInstance) {
    healthCheckInstance = {
      runHealthCheck,
      getQuickHealthStatus,
    };

    // Expose to window for devtools access
    (globalThis as Record<string, unknown>).runOptimizationHealthCheck = runHealthCheck;
    (globalThis as Record<string, unknown>).getQuickHealthStatus = getQuickHealthStatus;
  }
  return healthCheckInstance;
}

// Auto-initialize on import
getHealthCheck();

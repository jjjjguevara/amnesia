/**
 * Focal Point Priority Tracker
 *
 * Tracks tile priority assignment and completion order to validate
 * that focal-point prioritization is working correctly.
 *
 * Focal-point prioritization means tiles near the zoom/pan focal point
 * (or viewport center) should be assigned higher priority and thus
 * complete rendering before tiles at the edges.
 *
 * This tracker answers:
 * - Are critical tiles completing before low priority tiles?
 * - How many "priority inversions" occur (low before critical)?
 * - What's the average completion time by priority level?
 *
 * @module focal-point-tracker
 */

import { isFeatureEnabled } from './feature-flags';

/**
 * Priority level for tiles
 */
export type TilePriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Distribution of priorities in a gesture
 */
export interface PriorityDistribution {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * Single tile completion record
 */
export interface TileCompletionRecord {
  tileKey: string;
  priority: TilePriority;
  completedAtMs: number;  // Relative to gesture start
  wasSharp: boolean;      // cssStretch === 1.0
}

/**
 * Complete gesture tracking record
 */
export interface FocalPointGesture {
  id: string;
  timestamp: number;
  startTime: number;  // performance.now() at gesture start

  // Priority distribution at request time
  priorityDistribution: PriorityDistribution;

  // Completion tracking
  completionOrder: TileCompletionRecord[];

  // Analysis (calculated on finalization)
  criticalFirstRate: number;    // % of critical tiles that finished before any low tile
  priorityInversions: number;   // Count of low tiles finishing before critical
  avgCompletionTime: Record<TilePriority, number>;  // Average completion time by priority

  // Status
  status: 'tracking' | 'complete' | 'aborted';
}

/**
 * Aggregated statistics across gestures
 */
export interface FocalPointStats {
  gestureCount: number;

  // Average distribution
  avgPriorityDistribution: PriorityDistribution;

  // Effectiveness metrics
  avgCriticalFirstRate: number;
  avgPriorityInversions: number;

  // Timing by priority
  avgCompletionTimeByPriority: Record<TilePriority, number>;

  // Quality assessment
  prioritizationEffective: boolean;  // true if critical tiles generally finish first
  recommendation: string | null;
}

// Maximum gestures to keep in memory
const MAX_GESTURES = 50;

// Gesture timeout (if no completions in this time, gesture is finalized)
const GESTURE_TIMEOUT_MS = 5000;

/**
 * Focal Point Tracker Service
 */
export class FocalPointTracker {
  private gestures: FocalPointGesture[] = [];
  private currentGesture: FocalPointGesture | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Expose for debugging
    if (typeof window !== 'undefined') {
      (window as any).focalPointTracker = this;
    }
  }

  /**
   * Start tracking a new gesture
   * Called when tiles are requested with priorities assigned
   */
  startGesture(distribution: PriorityDistribution): void {
    // Finalize any pending gesture
    if (this.currentGesture) {
      this.finalizeGesture('new-gesture-started');
    }

    const id = `focal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = performance.now();

    this.currentGesture = {
      id,
      timestamp: Date.now(),
      startTime: now,
      priorityDistribution: { ...distribution },
      completionOrder: [],
      criticalFirstRate: 0,
      priorityInversions: 0,
      avgCompletionTime: { critical: 0, high: 0, medium: 0, low: 0 },
      status: 'tracking',
    };

    // Set timeout for auto-finalization
    this.timeoutHandle = setTimeout(() => {
      this.finalizeGesture('timeout');
    }, GESTURE_TIMEOUT_MS);

    if (isFeatureEnabled('exportDiagnosticsJson')) {
      console.log(`[FocalPoint] Gesture started:`, {
        id,
        distribution,
        totalTiles: distribution.critical + distribution.high + distribution.medium + distribution.low,
      });
    }
  }

  /**
   * Record a tile completion
   * Called from RenderCoordinator when a tile finishes
   */
  recordTileCompletion(record: Omit<TileCompletionRecord, 'completedAtMs'> & { completedAtMs?: number }): void {
    if (!this.currentGesture) return;
    if (this.currentGesture.status !== 'tracking') return;

    const completedAtMs = record.completedAtMs ?? 
      (performance.now() - this.currentGesture.startTime);

    this.currentGesture.completionOrder.push({
      tileKey: record.tileKey,
      priority: record.priority,
      completedAtMs,
      wasSharp: record.wasSharp,
    });

    // Check if all expected tiles are complete
    const dist = this.currentGesture.priorityDistribution;
    const expectedTotal = dist.critical + dist.high + dist.medium + dist.low;
    
    if (this.currentGesture.completionOrder.length >= expectedTotal) {
      this.finalizeGesture('all-tiles-complete');
    }
  }

  /**
   * Finalize the current gesture and calculate metrics
   */
  private finalizeGesture(reason: string): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    if (!this.currentGesture) return;

    const g = this.currentGesture;
    g.status = reason === 'all-tiles-complete' ? 'complete' : 'aborted';

    // Calculate metrics
    this.calculateGestureMetrics(g);

    if (isFeatureEnabled('exportDiagnosticsJson')) {
      console.log(`[FocalPoint] Gesture ${g.status}:`, JSON.stringify({
        id: g.id,
        reason,
        completions: g.completionOrder.length,
        criticalFirstRate: g.criticalFirstRate,
        priorityInversions: g.priorityInversions,
        avgCompletionTime: g.avgCompletionTime,
      }, null, 2));
    }

    // Store gesture
    this.gestures.push(g);
    while (this.gestures.length > MAX_GESTURES) {
      this.gestures.shift();
    }

    this.currentGesture = null;
  }

  /**
   * Calculate metrics for a gesture
   */
  private calculateGestureMetrics(g: FocalPointGesture): void {
    const completions = g.completionOrder;
    if (completions.length === 0) return;

    // Group by priority
    const byPriority: Record<TilePriority, TileCompletionRecord[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };

    for (const c of completions) {
      byPriority[c.priority].push(c);
    }

    // Calculate average completion time by priority
    for (const priority of ['critical', 'high', 'medium', 'low'] as TilePriority[]) {
      const records = byPriority[priority];
      if (records.length > 0) {
        g.avgCompletionTime[priority] = Math.round(
          records.reduce((sum, r) => sum + r.completedAtMs, 0) / records.length
        );
      }
    }

    // Find first low-priority tile completion time
    const lowCompletions = byPriority.low;
    const firstLowTime = lowCompletions.length > 0
      ? Math.min(...lowCompletions.map(c => c.completedAtMs))
      : Infinity;

    // Count critical tiles that finished before first low tile
    const criticalCompletions = byPriority.critical;
    const criticalBeforeLow = criticalCompletions.filter(c => c.completedAtMs < firstLowTime).length;
    
    g.criticalFirstRate = criticalCompletions.length > 0
      ? criticalBeforeLow / criticalCompletions.length
      : 1.0;

    // Count priority inversions (low tiles completing before critical tiles)
    let inversions = 0;
    for (let i = 0; i < completions.length; i++) {
      if (completions[i].priority === 'low') {
        // Check if any critical tile completed after this low tile
        for (let j = i + 1; j < completions.length; j++) {
          if (completions[j].priority === 'critical') {
            inversions++;
          }
        }
      }
    }
    g.priorityInversions = inversions;
  }

  /**
   * Get the current gesture (for UI)
   */
  getCurrentGesture(): FocalPointGesture | null {
    return this.currentGesture;
  }

  /**
   * Get the last completed gesture
   */
  getLastGesture(): FocalPointGesture | null {
    return this.gestures.length > 0 ? this.gestures[this.gestures.length - 1] : null;
  }

  /**
   * Get all gestures
   */
  getGestures(): FocalPointGesture[] {
    return [...this.gestures];
  }

  /**
   * Get aggregated statistics
   */
  getStats(): FocalPointStats {
    const completedGestures = this.gestures.filter(g => g.status === 'complete');

    if (completedGestures.length === 0) {
      return {
        gestureCount: 0,
        avgPriorityDistribution: { critical: 0, high: 0, medium: 0, low: 0 },
        avgCriticalFirstRate: 0,
        avgPriorityInversions: 0,
        avgCompletionTimeByPriority: { critical: 0, high: 0, medium: 0, low: 0 },
        prioritizationEffective: false,
        recommendation: 'No gesture data available yet. Zoom or pan to generate data.',
      };
    }

    // Calculate averages
    const avgDist: PriorityDistribution = { critical: 0, high: 0, medium: 0, low: 0 };
    const avgTime: Record<TilePriority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    let totalCriticalFirstRate = 0;
    let totalInversions = 0;

    for (const g of completedGestures) {
      avgDist.critical += g.priorityDistribution.critical;
      avgDist.high += g.priorityDistribution.high;
      avgDist.medium += g.priorityDistribution.medium;
      avgDist.low += g.priorityDistribution.low;

      avgTime.critical += g.avgCompletionTime.critical;
      avgTime.high += g.avgCompletionTime.high;
      avgTime.medium += g.avgCompletionTime.medium;
      avgTime.low += g.avgCompletionTime.low;

      totalCriticalFirstRate += g.criticalFirstRate;
      totalInversions += g.priorityInversions;
    }

    const count = completedGestures.length;
    avgDist.critical = Math.round(avgDist.critical / count);
    avgDist.high = Math.round(avgDist.high / count);
    avgDist.medium = Math.round(avgDist.medium / count);
    avgDist.low = Math.round(avgDist.low / count);

    avgTime.critical = Math.round(avgTime.critical / count);
    avgTime.high = Math.round(avgTime.high / count);
    avgTime.medium = Math.round(avgTime.medium / count);
    avgTime.low = Math.round(avgTime.low / count);

    const avgCriticalFirstRate = totalCriticalFirstRate / count;
    const avgInversions = totalInversions / count;

    // Determine if prioritization is effective
    const effective = avgCriticalFirstRate >= 0.7 && avgInversions < 5;

    // Generate recommendation
    let recommendation: string | null = null;
    if (!effective) {
      if (avgCriticalFirstRate < 0.7) {
        recommendation = `Critical tiles completing first only ${Math.round(avgCriticalFirstRate * 100)}% of the time. ` +
          `Check that getTilePriority() is being called in triggerTilePrefetch().`;
      } else if (avgInversions >= 5) {
        recommendation = `High priority inversion rate (${Math.round(avgInversions)} per gesture). ` +
          `Consider increasing semaphore priority for critical tiles.`;
      }
    }

    return {
      gestureCount: count,
      avgPriorityDistribution: avgDist,
      avgCriticalFirstRate,
      avgPriorityInversions: avgInversions,
      avgCompletionTimeByPriority: avgTime,
      prioritizationEffective: effective,
      recommendation,
    };
  }

  /**
   * Check if tracking is in progress
   */
  isTracking(): boolean {
    return this.currentGesture !== null && this.currentGesture.status === 'tracking';
  }

  /**
   * Clear all data
   */
  clear(): void {
    if (this.currentGesture) {
      this.finalizeGesture('manual-clear');
    }
    this.gestures = [];
  }

  /**
   * Export as JSON
   */
  exportJSON(): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      stats: this.getStats(),
      gestures: this.gestures,
    }, null, 2);
  }
}

// Singleton instance
let instance: FocalPointTracker | null = null;

/**
 * Get the focal point tracker singleton
 */
export function getFocalPointTracker(): FocalPointTracker {
  if (!instance) {
    instance = new FocalPointTracker();
    // Expose to window for devtools access
    (globalThis as Record<string, unknown>).focalPointTracker = instance;
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetFocalPointTracker(): void {
  if (instance) {
    instance.clear();
  }
  instance = null;
  delete (globalThis as Record<string, unknown>).focalPointTracker;
}

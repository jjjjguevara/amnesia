/**
 * Time-to-Highest-Res (T2HR) Tracker - v2
 *
 * Measures time from tile REQUEST to tile DISPLAY at maximum resolution.
 *
 * TWO-SOURCE MODEL:
 * - Zoom-initiated: Tiles requested during zoom gesture (should be ready by zoom end)
 * - Pan-initiated: Tiles requested after reaching max zoom via panning
 *
 * FLOW:
 * 1. onTileRequested() - Called when tile is queued for rendering
 *    Records: tileKey, requestTime, source ('zoom' | 'pan'), targetScale
 *
 * 2. onTileDisplayed() - Called when tile is composited to canvas
 *    Records: displayTime, actualScale
 *    Calculates: T2HR = displayTime - requestTime
 *
 * This model reveals the actual bug: if zoom-initiated tiles never complete,
 * it means tiles are rendered but not pushed to canvas until pan triggers re-composite.
 *
 * @module t2hr-tracker
 */

import { isFeatureEnabled } from './feature-flags';

/**
 * Source of the tile request
 */
export type TileRequestSource = 'zoom' | 'pan' | 'scroll' | 'initial';

/**
 * Pending tile request being tracked
 */
export interface PendingTileRequest {
  tileKey: string;
  page: number;
  tileX: number;
  tileY: number;
  requestTime: number;  // performance.now()
  source: TileRequestSource;
  targetScale: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Completed T2HR measurement for a single tile
 */
export interface TileT2HRResult {
  tileKey: string;
  page: number;
  tileX: number;
  tileY: number;
  source: TileRequestSource;
  targetScale: number;
  actualScale: number;
  requestTime: number;
  displayTime: number;
  t2hrMs: number;
  isHighestRes: boolean;  // actualScale >= targetScale * 0.9
  priority: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Aggregated statistics by source
 */
export interface T2HRSourceStats {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  highestResRate: number;  // % of tiles that reached highest res
  pendingCount: number;    // tiles requested but not yet displayed
  neverDisplayedCount: number;  // tiles that timed out
}

/**
 * Overall T2HR statistics
 */
export interface T2HRStats {
  zoom: T2HRSourceStats;
  pan: T2HRSourceStats;
  scroll: T2HRSourceStats;
  initial: T2HRSourceStats;
  combined: {
    avgMs: number;
    count: number;
  };
  // Diagnostic: reveals the "nudge bug"
  zoomTilesNeverDisplayed: number;
  panTilesDisplayedImmediately: number;  // < 100ms = cache hit
}

// Quality thresholds by zoom level
export const T2HR_THRESHOLDS = {
  zoom32: { target: 400, warn: 500, fail: 1000 },
  zoom16: { target: 250, warn: 400, fail: 750 },
  zoom8: { target: 150, warn: 250, fail: 500 },
  zoom4: { target: 75, warn: 150, fail: 300 },
} as const;

/**
 * Get threshold for a zoom level
 */
export function getT2HRThreshold(zoom: number): { target: number; warn: number; fail: number } {
  if (zoom >= 24) return T2HR_THRESHOLDS.zoom32;
  if (zoom >= 12) return T2HR_THRESHOLDS.zoom16;
  if (zoom >= 6) return T2HR_THRESHOLDS.zoom8;
  return T2HR_THRESHOLDS.zoom4;
}

// Configuration
const PENDING_TIMEOUT_MS = 15000;  // Tiles not displayed after 15s are marked as "never displayed"
const MAX_RESULTS = 500;           // Keep last 500 measurements
const MAX_PENDING = 200;           // Max pending requests to track (prevent memory leak)

/**
 * T2HR Tracker Service - v2
 */
export class T2HRTracker {
  private pendingRequests: Map<string, PendingTileRequest> = new Map();
  private results: TileT2HRResult[] = [];
  private neverDisplayed: Map<TileRequestSource, number> = new Map([
    ['zoom', 0],
    ['pan', 0],
    ['scroll', 0],
    ['initial', 0],
  ]);
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Expose for debugging
    if (typeof window !== 'undefined') {
      (window as any).t2hrTracker = this;
    }

    // Periodic cleanup of stale pending requests
    this.cleanupInterval = setInterval(() => this.cleanupStaleRequests(), 5000);
  }

  /**
   * Record a tile request (call at REQUEST time, not render time)
   */
  onTileRequested(params: {
    tileKey: string;
    page: number;
    tileX: number;
    tileY: number;
    source: TileRequestSource;
    targetScale: number;
    priority: 'critical' | 'high' | 'medium' | 'low';
  }): void {
    // Don't track if we already have a pending request for this tile
    // (prevents duplicate tracking from retries)
    if (this.pendingRequests.has(params.tileKey)) {
      return;
    }

    // Enforce max pending to prevent memory leak
    if (this.pendingRequests.size >= MAX_PENDING) {
      // Remove oldest entries
      const entries = Array.from(this.pendingRequests.entries());
      entries.sort((a, b) => a[1].requestTime - b[1].requestTime);
      for (let i = 0; i < 50; i++) {
        const [key, req] = entries[i];
        this.pendingRequests.delete(key);
        // Count as never displayed
        this.neverDisplayed.set(req.source, (this.neverDisplayed.get(req.source) ?? 0) + 1);
      }
    }

    const request: PendingTileRequest = {
      tileKey: params.tileKey,
      page: params.page,
      tileX: params.tileX,
      tileY: params.tileY,
      requestTime: performance.now(),
      source: params.source,
      targetScale: params.targetScale,
      priority: params.priority,
    };

    this.pendingRequests.set(params.tileKey, request);

    if (isFeatureEnabled('exportDiagnosticsJson')) {
      console.log(`[T2HR] Tile requested:`, {
        tileKey: params.tileKey,
        source: params.source,
        targetScale: params.targetScale,
        priority: params.priority,
      });
    }
  }

  /**
   * Record a tile being displayed (call at COMPOSITING time)
   */
  onTileDisplayed(params: {
    tileKey: string;
    actualScale: number;
  }): void {
    const pending = this.pendingRequests.get(params.tileKey);
    if (!pending) {
      // Tile wasn't tracked (maybe from before tracker initialized, or cache hit without request)
      return;
    }

    const displayTime = performance.now();
    const t2hrMs = displayTime - pending.requestTime;
    const isHighestRes = params.actualScale >= pending.targetScale * 0.9;

    const result: TileT2HRResult = {
      tileKey: params.tileKey,
      page: pending.page,
      tileX: pending.tileX,
      tileY: pending.tileY,
      source: pending.source,
      targetScale: pending.targetScale,
      actualScale: params.actualScale,
      requestTime: pending.requestTime,
      displayTime,
      t2hrMs,
      isHighestRes,
      priority: pending.priority,
    };

    this.results.push(result);
    this.pendingRequests.delete(params.tileKey);

    // Trim results to max size
    while (this.results.length > MAX_RESULTS) {
      this.results.shift();
    }

    if (isFeatureEnabled('exportDiagnosticsJson')) {
      console.log(`[T2HR] Tile displayed:`, {
        tileKey: params.tileKey,
        source: pending.source,
        t2hrMs: Math.round(t2hrMs),
        isHighestRes,
        actualScale: params.actualScale,
        targetScale: pending.targetScale,
      });
    }
  }

  /**
   * Cleanup stale pending requests (tiles that were never displayed)
   */
  private cleanupStaleRequests(): void {
    const now = performance.now();
    const staleKeys: string[] = [];

    for (const [key, request] of this.pendingRequests) {
      if (now - request.requestTime > PENDING_TIMEOUT_MS) {
        staleKeys.push(key);
        this.neverDisplayed.set(request.source, (this.neverDisplayed.get(request.source) ?? 0) + 1);
      }
    }

    for (const key of staleKeys) {
      this.pendingRequests.delete(key);
    }

    if (staleKeys.length > 0 && isFeatureEnabled('exportDiagnosticsJson')) {
      console.log(`[T2HR] Cleaned up ${staleKeys.length} stale pending requests`);
    }
  }

  /**
   * Get statistics for a specific source
   */
  private getSourceStats(source: TileRequestSource): T2HRSourceStats {
    const sourceResults = this.results.filter(r => r.source === source);
    const times = sourceResults.map(r => r.t2hrMs);

    if (times.length === 0) {
      return {
        count: 0,
        avgMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        minMs: 0,
        maxMs: 0,
        highestResRate: 0,
        pendingCount: Array.from(this.pendingRequests.values()).filter(r => r.source === source).length,
        neverDisplayedCount: this.neverDisplayed.get(source) ?? 0,
      };
    }

    const sorted = [...times].sort((a, b) => a - b);
    const highestResCount = sourceResults.filter(r => r.isHighestRes).length;

    return {
      count: times.length,
      avgMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      p50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)]),
      p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]),
      minMs: Math.round(sorted[0]),
      maxMs: Math.round(sorted[sorted.length - 1]),
      highestResRate: highestResCount / times.length,
      pendingCount: Array.from(this.pendingRequests.values()).filter(r => r.source === source).length,
      neverDisplayedCount: this.neverDisplayed.get(source) ?? 0,
    };
  }

  /**
   * Get aggregated statistics
   */
  getStats(): T2HRStats {
    const zoomStats = this.getSourceStats('zoom');
    const panStats = this.getSourceStats('pan');
    const scrollStats = this.getSourceStats('scroll');
    const initialStats = this.getSourceStats('initial');

    // Combined average
    const allTimes = this.results.map(r => r.t2hrMs);
    const combinedAvg = allTimes.length > 0
      ? Math.round(allTimes.reduce((a, b) => a + b, 0) / allTimes.length)
      : 0;

    // Diagnostic metrics
    const panImmediateCount = this.results.filter(r => r.source === 'pan' && r.t2hrMs < 100).length;

    return {
      zoom: zoomStats,
      pan: panStats,
      scroll: scrollStats,
      initial: initialStats,
      combined: {
        avgMs: combinedAvg,
        count: this.results.length,
      },
      zoomTilesNeverDisplayed: this.neverDisplayed.get('zoom') ?? 0,
      panTilesDisplayedImmediately: panImmediateCount,
    };
  }

  /**
   * Get recent results
   */
  getRecentResults(count: number = 20): TileT2HRResult[] {
    return this.results.slice(-count);
  }

  /**
   * Get pending request count by source
   */
  getPendingBySource(): Record<TileRequestSource, number> {
    const counts: Record<TileRequestSource, number> = {
      zoom: 0,
      pan: 0,
      scroll: 0,
      initial: 0,
    };

    for (const request of this.pendingRequests.values()) {
      counts[request.source]++;
    }

    return counts;
  }

  /**
   * Get all pending requests (for debugging)
   */
  getPendingRequests(): PendingTileRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.pendingRequests.clear();
    this.results = [];
    this.neverDisplayed = new Map([
      ['zoom', 0],
      ['pan', 0],
      ['scroll', 0],
      ['initial', 0],
    ]);
  }

  /**
   * Export data as JSON
   */
  exportJSON(): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      stats: this.getStats(),
      recentResults: this.getRecentResults(50),
      pendingRequests: this.getPendingRequests(),
    }, null, 2);
  }

  /**
   * Cleanup on destroy
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // ============================================================
  // LEGACY API - kept for compatibility during transition
  // These will be removed once all callers are updated
  // ============================================================

  /** @deprecated Use onTileRequested instead */
  startMeasurement(_params: { targetZoom: number; targetScale: number; focalPoint?: { x: number; y: number } | null }): void {
    // No-op in v2 - measurement is per-tile, not per-gesture
    if (isFeatureEnabled('exportDiagnosticsJson')) {
      console.log('[T2HR] startMeasurement called (legacy, no-op in v2)');
    }
  }

  /** @deprecated Use onTileRequested instead */
  setExpectedFocalTileCount(_count: number): void {
    // No-op in v2
  }

  /** @deprecated Use onTileDisplayed instead */
  onTileComplete(_event: {
    tile: { page: number; tileX: number; tileY: number; scale: number };
    actualScale?: number;
    priority: 'critical' | 'high' | 'medium' | 'low';
    isFocalTile?: boolean;
    isFallback?: boolean;
    pipelineTiming?: Record<string, number>;
  }): void {
    // No-op in v2 - use onTileDisplayed instead
  }

  /** @deprecated Not needed in v2 */
  abortMeasurement(_reason: string): void {
    // No-op in v2
  }

  /** @deprecated Use getStats() instead */
  getMeasurements(): any[] {
    return this.results;
  }

  /** @deprecated Use getRecentResults() instead */
  getRecentMeasurements(count: number = 10): any[] {
    return this.getRecentResults(count);
  }

  /** @deprecated Not applicable in v2 */
  getPendingMeasurement(): null {
    return null;
  }

  /** @deprecated Not applicable in v2 */
  isMeasuring(): boolean {
    return this.pendingRequests.size > 0;
  }
}

// Singleton instance
let instance: T2HRTracker | null = null;

/**
 * Get the T2HR tracker singleton
 */
export function getT2HRTracker(): T2HRTracker {
  if (!instance) {
    instance = new T2HRTracker();
    // Expose to window for devtools access
    (globalThis as Record<string, unknown>).t2hrTracker = instance;
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetT2HRTracker(): void {
  if (instance) {
    instance.destroy();
    instance.clear();
  }
  instance = null;
  delete (globalThis as Record<string, unknown>).t2hrTracker;
}

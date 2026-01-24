/**
 * Tile Integrity Checker
 *
 * Diagnostic tool to track tile lifecycle and detect rendering failures.
 * Implements:
 * 1. Tile map sanity checking - track requested vs received tiles
 * 2. Re-request mechanism for failed tiles
 * 3. Tiered resolution fallback for non-focused areas
 *
 * @module tile-integrity-checker
 */

export interface TileRequest {
  page: number;
  tileX: number;
  tileY: number;
  scale: number;
  requestTime: number;
  renderSeqId: string;
}

export interface TileResult {
  request: TileRequest;
  success: boolean;
  receiveTime: number;
  error?: string;
  cssStretch?: number;
  retryCount: number;
}

export interface TileMapReport {
  renderSeqId: string;
  page: number;
  zoom: number;
  requested: number;
  received: number;
  failed: number;
  missing: TileRequest[];
  coverage: number; // 0-1
  isComplete: boolean;
  failedTiles: Array<{ x: number; y: number; error: string }>;
}

export interface RetryConfig {
  maxRetries: number;
  retryDelayMs: number;
  exponentialBackoff: boolean;
  priorityBoost: number; // Higher priority for retries
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  retryDelayMs: 100,
  exponentialBackoff: true,
  priorityBoost: 10,
};

/**
 * Tile Integrity Checker - diagnoses and recovers from tile rendering failures
 */
export class TileIntegrityChecker {
  private pendingRequests = new Map<string, TileRequest>();
  private completedResults = new Map<string, TileResult>();
  private retryCounts = new Map<string, number>();
  private retryConfig: RetryConfig;
  private retryCallback?: (tiles: TileRequest[]) => Promise<void>;

  // Diagnostics
  private renderReports: TileMapReport[] = [];
  private maxStoredReports = 50;

  constructor(config: Partial<RetryConfig> = {}) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Generate a unique key for a tile
   */
  private getTileKey(page: number, tileX: number, tileY: number, scale: number): string {
    return `p${page}-t${tileX}x${tileY}-s${scale}`;
  }

  /**
   * Set the callback for retrying failed tiles
   */
  setRetryCallback(callback: (tiles: TileRequest[]) => Promise<void>): void {
    this.retryCallback = callback;
  }

  /**
   * Record a tile request
   */
  recordRequest(
    renderSeqId: string,
    page: number,
    tileX: number,
    tileY: number,
    scale: number
  ): void {
    const key = this.getTileKey(page, tileX, tileY, scale);
    const request: TileRequest = {
      page,
      tileX,
      tileY,
      scale,
      requestTime: Date.now(),
      renderSeqId,
    };
    this.pendingRequests.set(key, request);
  }

  /**
   * Record a batch of tile requests
   */
  recordBatchRequest(
    renderSeqId: string,
    page: number,
    tiles: Array<{ tileX: number; tileY: number; scale: number }>
  ): void {
    for (const tile of tiles) {
      this.recordRequest(renderSeqId, page, tile.tileX, tile.tileY, tile.scale);
    }
  }

  /**
   * Record a tile result (success or failure)
   */
  recordResult(
    page: number,
    tileX: number,
    tileY: number,
    scale: number,
    success: boolean,
    error?: string,
    cssStretch?: number
  ): void {
    const key = this.getTileKey(page, tileX, tileY, scale);
    const request = this.pendingRequests.get(key);

    if (!request) {
      console.warn(`[TileIntegrity] Result for unknown tile: ${key}`);
      return;
    }

    const retryCount = this.retryCounts.get(key) || 0;
    const result: TileResult = {
      request,
      success,
      receiveTime: Date.now(),
      error,
      cssStretch,
      retryCount,
    };

    this.completedResults.set(key, result);
    this.pendingRequests.delete(key);
  }

  /**
   * Generate a tile map report for a render sequence
   */
  generateReport(
    renderSeqId: string,
    page: number,
    zoom: number,
    expectedTiles: Array<{ tileX: number; tileY: number; scale: number }>
  ): TileMapReport {
    const requested = expectedTiles.length;
    let received = 0;
    let failed = 0;
    const missing: TileRequest[] = [];
    const failedTiles: Array<{ x: number; y: number; error: string }> = [];

    for (const tile of expectedTiles) {
      const key = this.getTileKey(page, tile.tileX, tile.tileY, tile.scale);
      const result = this.completedResults.get(key);

      if (!result) {
        // Tile never completed - still pending or dropped
        const pendingRequest = this.pendingRequests.get(key);
        if (pendingRequest) {
          missing.push(pendingRequest);
        } else {
          // Create a request record for the missing tile
          missing.push({
            page,
            tileX: tile.tileX,
            tileY: tile.tileY,
            scale: tile.scale,
            requestTime: 0,
            renderSeqId,
          });
        }
        failed++;
      } else if (result.success) {
        received++;
      } else {
        failed++;
        failedTiles.push({
          x: tile.tileX,
          y: tile.tileY,
          error: result.error || 'unknown',
        });
      }
    }

    const coverage = requested > 0 ? received / requested : 1;
    const isComplete = coverage >= 0.95; // 95% threshold for "complete"

    const report: TileMapReport = {
      renderSeqId,
      page,
      zoom,
      requested,
      received,
      failed,
      missing,
      coverage,
      isComplete,
      failedTiles,
    };

    // Store report for diagnostics
    this.renderReports.push(report);
    if (this.renderReports.length > this.maxStoredReports) {
      this.renderReports.shift();
    }

    // Log detailed report at mid-zoom
    if (zoom >= 4 && !isComplete) {
      console.error(`[TILE-INTEGRITY] page=${page} zoom=${zoom.toFixed(2)}: ` +
        `${received}/${requested} tiles (${(coverage * 100).toFixed(1)}% coverage), ` +
        `${failed} failed, ${missing.length} missing`);

      if (failedTiles.length > 0) {
        const failedCoords = failedTiles.slice(0, 10)
          .map(t => `(${t.x},${t.y}):${t.error}`)
          .join(', ');
        console.error(`[TILE-INTEGRITY] Failed tiles: ${failedCoords}` +
          (failedTiles.length > 10 ? ` ... (${failedTiles.length} total)` : ''));
      }
    }

    return report;
  }

  /**
   * Attempt to re-request failed tiles
   */
  async retryFailedTiles(report: TileMapReport): Promise<number> {
    if (!this.retryCallback) {
      console.warn('[TileIntegrity] No retry callback configured');
      return 0;
    }

    const tilesToRetry: TileRequest[] = [];

    for (const tile of report.missing) {
      const key = this.getTileKey(tile.page, tile.tileX, tile.tileY, tile.scale);
      const currentRetries = this.retryCounts.get(key) || 0;

      if (currentRetries < this.retryConfig.maxRetries) {
        this.retryCounts.set(key, currentRetries + 1);
        tilesToRetry.push(tile);
      } else {
        console.warn(`[TileIntegrity] Max retries (${this.retryConfig.maxRetries}) reached for tile ${key}`);
      }
    }

    if (tilesToRetry.length === 0) {
      return 0;
    }

    // Calculate retry delay with optional exponential backoff
    const maxRetryCount = Math.max(...tilesToRetry.map(t =>
      this.retryCounts.get(this.getTileKey(t.page, t.tileX, t.tileY, t.scale)) || 0
    ));
    const delay = this.retryConfig.exponentialBackoff
      ? this.retryConfig.retryDelayMs * Math.pow(2, maxRetryCount - 1)
      : this.retryConfig.retryDelayMs;

    console.log(`[TILE-RETRY] Retrying ${tilesToRetry.length} tiles after ${delay}ms delay ` +
      `(attempt ${maxRetryCount}/${this.retryConfig.maxRetries})`);

    // Wait before retry
    await new Promise(resolve => setTimeout(resolve, delay));

    // Re-record as pending
    for (const tile of tilesToRetry) {
      this.recordRequest(
        tile.renderSeqId + `-retry${this.retryCounts.get(this.getTileKey(tile.page, tile.tileX, tile.tileY, tile.scale))}`,
        tile.page,
        tile.tileX,
        tile.tileY,
        tile.scale
      );
    }

    // Trigger retry
    try {
      await this.retryCallback(tilesToRetry);
      return tilesToRetry.length;
    } catch (e) {
      console.error('[TileIntegrity] Retry callback failed:', e);
      return 0;
    }
  }

  /**
   * Get recent render reports for diagnostics
   */
  getRecentReports(): TileMapReport[] {
    return [...this.renderReports];
  }

  /**
   * Get summary statistics
   */
  getSummaryStats(): {
    totalRequests: number;
    totalSuccesses: number;
    totalFailures: number;
    avgCoverage: number;
    recentIncomplete: number;
  } {
    const recentReports = this.renderReports.slice(-20);
    const totalSuccesses = recentReports.reduce((sum, r) => sum + r.received, 0);
    const totalRequests = recentReports.reduce((sum, r) => sum + r.requested, 0);
    const totalFailures = recentReports.reduce((sum, r) => sum + r.failed, 0);
    const avgCoverage = recentReports.length > 0
      ? recentReports.reduce((sum, r) => sum + r.coverage, 0) / recentReports.length
      : 1;
    const recentIncomplete = recentReports.filter(r => !r.isComplete).length;

    return {
      totalRequests,
      totalSuccesses,
      totalFailures,
      avgCoverage,
      recentIncomplete,
    };
  }

  /**
   * Clear all tracking data (e.g., on document change)
   */
  clear(): void {
    this.pendingRequests.clear();
    this.completedResults.clear();
    this.retryCounts.clear();
    this.renderReports = [];
  }

  /**
   * Clear data for a specific render sequence (e.g., when superseded)
   */
  clearRenderSequence(renderSeqId: string): void {
    // Clear pending requests for this sequence
    for (const [key, request] of this.pendingRequests.entries()) {
      if (request.renderSeqId === renderSeqId) {
        this.pendingRequests.delete(key);
      }
    }
  }
}

// Singleton instance for global access
let globalChecker: TileIntegrityChecker | null = null;

export function getTileIntegrityChecker(): TileIntegrityChecker {
  if (!globalChecker) {
    globalChecker = new TileIntegrityChecker();
  }
  return globalChecker;
}

export function resetTileIntegrityChecker(): void {
  if (globalChecker) {
    globalChecker.clear();
  }
  globalChecker = null;
}

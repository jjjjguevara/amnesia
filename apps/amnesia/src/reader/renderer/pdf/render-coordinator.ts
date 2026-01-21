/**
 * Render Coordinator
 *
 * Unified render queue that coordinates between mode-specific strategies.
 * Manages request deduplication, concurrency limiting, and mode transitions.
 *
 * Features:
 * - Request deduplication (same tile/page only rendered once)
 * - Semaphore-based concurrency limiting (no busy-wait)
 * - Mode transition handling (cancel obsolete requests)
 * - Abort signal support for cancellation
 * - Telemetry integration
 *
 * @example
 * ```typescript
 * const coordinator = getRenderCoordinator();
 * coordinator.setMode('scroll');
 *
 * // Request a tile render
 * const result = await coordinator.requestRender({
 *   type: 'tile',
 *   tile: { page: 1, tileX: 0, tileY: 0, scale: 2 },
 *   priority: 'critical',
 * });
 * ```
 */

import type { TileCoordinate } from './tile-render-engine';
import { getTileCacheManager, quantizeScale, type CachedTileData, type CachedPageClassification } from './tile-cache-manager';
import { getPaginatedStrategy } from './paginated-strategy';
import { getScrollStrategy, type PrioritizedTile, type SpeedZone } from './scroll-strategy';
import { MAX_SCALE_TIER, getTargetScaleTier } from './progressive-tile-renderer';
import { getGridStrategy } from './grid-strategy';
import { getTelemetry } from './pdf-telemetry';
import type { TileRenderResult } from './wasm-renderer';
import {
  PDFContentType,
  getOptimizedRenderParams,
  shouldApplyVectorOptimization,
  calculateVectorOptimizationSavings,
  type PageClassification,
  type RenderStrategy,
  type OptimizedRenderParams,
  getRenderStrategy,
} from './content-type-classifier';
import { getTypedArrayPool } from './typed-array-pool';
import { getHybridRenderingStrategy, type RenderingDecision } from './hybrid-rendering-strategy';
import { getCanvasPool } from './pdf-canvas-pool';
import { getRenderSessionManager } from './render-session';

/** Render request priority levels */
export type RenderPriority = 'critical' | 'high' | 'medium' | 'low';

/** Tile render request */
export interface TileRenderRequest {
  type: 'tile';
  tile: TileCoordinate;
  priority: RenderPriority;
  abortController?: AbortController;
  /** Document ID for cross-document isolation. Required for proper deduplication. */
  documentId?: string;
  /** Session ID for selective abort. Requests from old sessions can be aborted. */
  sessionId?: number;
}

/** Page render request */
export interface PageRenderRequest {
  type: 'page';
  page: number;
  scale: number;
  priority: RenderPriority;
  abortController?: AbortController;
  /** Document ID for cross-document isolation. Required for proper deduplication. */
  documentId?: string;
  /** Session ID for selective abort. Requests from old sessions can be aborted. */
  sessionId?: number;
}

/** Render request union type */
export type RenderRequest = TileRenderRequest | PageRenderRequest;

/** Render result */
export interface RenderResult {
  success: boolean;
  data?: ImageBitmap | Blob;
  error?: string;
  fromCache: boolean;
  /** If true, this is a fallback tile at a different scale than requested */
  isFallback?: boolean;
  /** The actual scale of the returned tile (may differ from requested if fallback) */
  actualScale?: number;
  /** CSS scale factor to apply (< 1 = downscale, > 1 = upscale) */
  cssStretch?: number;
}

/** Render mode */
export type RenderMode = 'paginated' | 'scroll' | 'grid';

/**
 * Priority-based semaphore for concurrency limiting
 *
 * Implements priority lanes: critical > high > medium > low
 * When a permit is released, highest-priority waiters are served first.
 * This prevents 800ms+ wait times for visible tiles when background
 * renders (prefetch/thumbnails) are queued.
 */
class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private readonly maxQueueSize: number;

  // Priority queues: critical (0) > high (1) > medium (2) > low (3)
  private priorityQueues: Map<RenderPriority, Array<(acquired: boolean) => void>> = new Map([
    ['critical', []],
    ['high', []],
    ['medium', []],
    ['low', []],
  ]);

  private static readonly PRIORITY_ORDER: RenderPriority[] = ['critical', 'high', 'medium', 'low'];

  constructor(maxPermits: number, maxQueueSize = 100) {
    this.permits = maxPermits;
    this.maxPermits = maxPermits;
    this.maxQueueSize = maxQueueSize;
  }

  /**
   * Get total number of waiters across all priorities
   */
  private getTotalWaiters(): number {
    let total = 0;
    for (const queue of this.priorityQueues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Drop lowest-priority waiters when queue is full
   */
  private dropLowestPriorityWaiters(): void {
    // Drop from lowest priority first (low → medium → high → critical)
    const reversePriorities = [...Semaphore.PRIORITY_ORDER].reverse();
    for (const priority of reversePriorities) {
      const queue = this.priorityQueues.get(priority)!;
      while (queue.length > 0 && this.getTotalWaiters() >= this.maxQueueSize) {
        const dropped = queue.shift();
        if (dropped) {
          dropped(false); // Signal that permit was NOT acquired
        }
      }
      if (this.getTotalWaiters() < this.maxQueueSize) break;
    }
  }

  /**
   * Acquire a permit with priority. Returns true if permit was acquired, false if dropped.
   * When false is returned, caller must NOT call release() - no permit was consumed.
   *
   * @param priority Render priority (critical renders get permits before low priority)
   */
  async acquire(priority: RenderPriority = 'medium'): Promise<boolean> {
    if (this.permits > 0) {
      this.permits--;
      return true;
    }

    // Prevent unbounded queue growth - drop lowest priority waiters first
    if (this.getTotalWaiters() >= this.maxQueueSize) {
      this.dropLowestPriorityWaiters();
    }

    // Wait for a permit to become available
    return new Promise<boolean>((resolve) => {
      this.priorityQueues.get(priority)!.push(resolve);
    });
  }

  release(): void {
    // Give permit to highest-priority waiter first
    for (const priority of Semaphore.PRIORITY_ORDER) {
      const queue = this.priorityQueues.get(priority)!;
      if (queue.length > 0) {
        const waiter = queue.shift()!;
        waiter(true); // Signal successful acquisition
        return;
      }
    }

    // No waiters - return permit to pool
    if (this.permits < this.maxPermits) {
      this.permits++;
    }
  }

  /**
   * Clear all pending waiters (for major view changes like page jumps)
   * Each waiter receives false to indicate they were dropped
   */
  clearQueue(): number {
    let count = 0;
    for (const queue of this.priorityQueues.values()) {
      count += queue.length;
      while (queue.length > 0) {
        const waiter = queue.shift();
        if (waiter) waiter(false); // Signal drop, not acquisition
      }
    }
    return count;
  }

  get available(): number {
    return this.permits;
  }

  get waiting(): number {
    return this.getTotalWaiters();
  }

  /**
   * Get waiting count by priority (for debugging)
   */
  getWaitingByPriority(): Record<RenderPriority, number> {
    return {
      critical: this.priorityQueues.get('critical')!.length,
      high: this.priorityQueues.get('high')!.length,
      medium: this.priorityQueues.get('medium')!.length,
      low: this.priorityQueues.get('low')!.length,
    };
  }
}

/**
 * Render Coordinator
 */
export class RenderCoordinator {
  /** In-flight requests (for deduplication) */
  private inFlight = new Map<string, Promise<RenderResult>>();

  /** Current render mode */
  private currentMode: RenderMode = 'paginated';

  /** Render callback (injected by provider) */
  private renderTileCallback:
    | ((tile: TileCoordinate, docId: string) => Promise<TileRenderResult | Blob>)
    | null = null;
  private renderPageCallback:
    | ((page: number, scale: number, docId: string) => Promise<Blob>)
    | null = null;

  /** Current document ID */
  private documentId: string | null = null;

  /** Concurrency semaphore */
  private semaphore: Semaphore;

  /** Active render tracking for stats */
  private activeRenders = 0;

  /** Abort controllers for cancellation */
  private abortControllers = new Set<AbortController>();

  /**
   * Active render requests by position (without scale).
   * Used to abort old-scale renders when new-scale requests come in.
   * Key format: "tile-p{page}-t{x}x{y}" or "page-{page}"
   */
  private activeByPosition = new Map<string, AbortController>();

  /** Mode transition callbacks */
  private modeTransitionCallbacks = new Set<(from: RenderMode, to: RenderMode) => void>();

  /** Pre-transition render callback (for rendering key frames before switch) */
  private preTransitionCallback:
    | ((targetMode: RenderMode, currentPage: number) => Promise<void>)
    | null = null;

  /** Whether a mode transition is in progress */
  private transitionInProgress = false;

  /** Last time we warned about wait time (rate limiting) */
  private lastWaitWarningTime = 0;

  // ============================================================
  // Content-Type Detection (Phase 5)
  // ============================================================

  /** Whether content-type detection is enabled */
  private contentTypeDetectionEnabled = false;

  /** Callback to classify a page (provided by hybrid-pdf-provider) */
  private classifyPageCallback:
    | ((docId: string, pageNum: number) => Promise<PageClassification>)
    | null = null;

  /** Callback to extract JPEG from scanned page (provided by hybrid-pdf-provider) */
  private extractJpegCallback:
    | ((docId: string, pageNum: number) => Promise<{ data: Uint8Array; width: number; height: number }>)
    | null = null;

  /** In-flight classification requests (for deduplication) */
  private classificationInFlight = new Map<number, Promise<PageClassification | null>>();

  /** Session tracking for in-flight requests (enables selective abort) */
  private inFlightSessions = new Map<string, number>();

  constructor(options?: { maxConcurrent?: number; enableContentTypeDetection?: boolean }) {
    // PERF FIX: Reduced from 16 to 4 permits to match worker pool size.
    // With 16 permits but only 4 workers, 12 requests would hold permits while
    // waiting for a worker, causing queue saturation (68+ tiles waiting 2-4 seconds).
    // Now permits match actual worker capacity for <100ms queue wait times.
    this.semaphore = new Semaphore(options?.maxConcurrent ?? 4);
    this.contentTypeDetectionEnabled = options?.enableContentTypeDetection ?? false;
  }

  /**
   * Abort all pending render requests and clear the queue.
   * Call this on major view changes (page jumps, large zoom changes)
   * to prevent wasted work on stale requests.
   */
  abortAllPending(): void {
    // Abort all tracked controllers
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
    this.activeByPosition.clear();
    this.inFlight.clear();
    this.inFlightSessions.clear();

    // Clear the semaphore queue (resolves all waiters immediately)
    const cleared = this.semaphore.clearQueue();
    if (cleared > 0) {
      console.log(`[RenderCoordinator] Cleared ${cleared} pending requests from queue`);
    }
  }

  /**
   * Abort stale render sessions, keeping recent ones.
   *
   * This solves the abort tradeoff:
   * - WITH blanket abort: Cache destroyed every 32ms, ~40% hit rate
   * - WITHOUT abort: Queue saturates with 100+ stale requests, 400ms+ wait
   * - WITH selective abort: Keep recent sessions (high hit rate), abort old (no saturation)
   *
   * @param keepRecent Number of recent sessions to keep (default: 2)
   * @returns Number of requests aborted
   */
  abortStaleSessions(keepRecent: number = 2): number {
    const sessionManager = getRenderSessionManager();
    const currentSessionId = sessionManager.getCurrentSessionId();

    // Session counter uses modulo 10000, so we need modular arithmetic
    // to handle wraparound correctly
    const MAX_SESSION_ID = 10000;

    let abortedCount = 0;

    // Abort in-flight requests from stale sessions
    for (const [key, sessionId] of this.inFlightSessions) {
      // Compute age using modular distance
      // Age = (current - session + MAX) % MAX handles wraparound
      const age = (currentSessionId - sessionId + MAX_SESSION_ID) % MAX_SESSION_ID;

      if (age > keepRecent) {
        // Extract position key to find the abort controller
        const positionKey = this.extractPositionKeyFromRequestKey(key);
        const controller = this.activeByPosition.get(positionKey);
        if (controller) {
          controller.abort();
          this.activeByPosition.delete(positionKey);
          this.abortControllers.delete(controller);
          abortedCount++;
        }
      }
    }

    // NOTE: Do NOT clear the entire queue here! The semaphore doesn't track session IDs,
    // so clearQueue() would drop ALL waiting requests including valid ones from the current
    // session. This was causing an infinite loop where tiles were constantly cleared and
    // re-queued without ever rendering.
    //
    // The in-flight abort logic above (lines 354-370) is sufficient - it selectively aborts
    // only stale sessions. Queued requests from the current session will proceed normally.

    if (abortedCount > 0) {
      console.log(`[RenderCoordinator] Aborted ${abortedCount} stale in-flight requests (age > ${keepRecent})`);
    }

    return abortedCount;
  }

  /**
   * Get adaptive session keep count based on tile scale.
   *
   * At high scale, tile renders take longer due to higher resolution,
   * so we need to keep more sessions to avoid aborting valid renders.
   *
   * CRITICAL: Render times are much slower than originally estimated!
   * Actual measured render times (MuPDF WASM):
   * - Scale 2-4: ~100-200ms per tile
   * - Scale 4-8: ~300-500ms per tile
   * - Scale 8-16: ~500-800ms per tile
   * - Scale 16+: ~800-1200ms per tile
   *
   * Sessions are created every 32ms during scroll.
   * keepRecent × 32ms = tolerance window.
   *
   * @param scale Tile scale (zoom × pixelRatio)
   */
  getAdaptiveKeepRecent(scale: number): number {
    // PERF FIX: Reduced from (32/24/16/8) which caused queue saturation.
    // With 32ms scroll debounce and 400ms avg render, keeping 32 sessions
    // means 32×20=640 tiles potentially queued, causing 7+ second waits.
    // Lower values = more aggressive abort = faster response to new tiles.
    if (scale >= 16) return 8;   // Scale 16+: ~256ms tolerance (high zoom)
    if (scale >= 8) return 6;    // Scale 8-15: ~192ms tolerance
    if (scale >= 4) return 4;    // Scale 4-7: ~128ms tolerance
    return 3;                     // Scale < 4: ~96ms tolerance
  }

  /**
   * Extract position key from request key.
   * Request key: "docId-tile-p{page}-t{x}x{y}-s{scale}" or "docId-page-{page}-s{scale}"
   * Position key: "docId-tile-p{page}-t{x}x{y}" or "docId-page-{page}"
   * Just removes the scale suffix.
   */
  private extractPositionKeyFromRequestKey(requestKey: string): string {
    // Simply remove the scale suffix - the rest already matches getPositionKey format
    return requestKey.replace(/-s[\d.]+$/, '');
  }

  /**
   * Set render callbacks (provided by hybrid-pdf-provider)
   */
  setRenderCallbacks(callbacks: {
    renderTile: (tile: TileCoordinate, docId: string) => Promise<TileRenderResult | Blob>;
    renderPage: (page: number, scale: number, docId: string) => Promise<Blob>;
  }): void {
    this.renderTileCallback = callbacks.renderTile;
    this.renderPageCallback = callbacks.renderPage;
  }

  /**
   * Set content-type detection callbacks (provided by hybrid-pdf-provider)
   *
   * These callbacks enable content-aware rendering optimizations:
   * - Scanned JPEG pages: Direct JPEG extraction (60-80% faster)
   * - Vector-heavy pages: Reduced scale rendering with CSS upscale (30-50% faster)
   */
  setContentTypeCallbacks(callbacks: {
    classifyPage: (docId: string, pageNum: number) => Promise<PageClassification>;
    extractJpeg: (docId: string, pageNum: number) => Promise<{ data: Uint8Array; width: number; height: number }>;
  }): void {
    this.classifyPageCallback = callbacks.classifyPage;
    this.extractJpegCallback = callbacks.extractJpeg;
  }

  /**
   * Enable or disable content-type detection.
   *
   * When enabled, pages are classified before rendering to select
   * the optimal render path (JPEG extraction, vector scale optimization, etc.)
   */
  setContentTypeDetectionEnabled(enabled: boolean): void {
    this.contentTypeDetectionEnabled = enabled;
    if (!enabled) {
      // Clear classification cache when disabled
      this.classificationInFlight.clear();
    }
  }

  /**
   * Check if content-type detection is enabled
   */
  isContentTypeDetectionEnabled(): boolean {
    return this.contentTypeDetectionEnabled && this.classifyPageCallback !== null;
  }

  /**
   * Get page classification (with caching).
   *
   * Checks L3 cache first, then classifies if not cached.
   * Deduplicates concurrent classification requests for the same page.
   *
   * @param pageNum Page number (1-indexed)
   * @returns Classification or null if detection is disabled/failed
   */
  async getPageClassification(pageNum: number): Promise<PageClassification | null> {
    if (!this.isContentTypeDetectionEnabled() || !this.documentId) {
      return null;
    }

    // Check L3 cache first
    const cached = getTileCacheManager().getPageClassification(pageNum);
    if (cached) {
      return {
        type: cached.type as PDFContentType,
        confidence: cached.confidence,
        classificationTimeMs: cached.classificationTimeMs,
        hasTransparency: cached.hasTransparency,
        pageNum,
      };
    }

    // Check if classification is already in flight
    const inFlight = this.classificationInFlight.get(pageNum);
    if (inFlight) {
      return inFlight;
    }

    // Start classification
    const classificationPromise = this.classifyPageInternal(pageNum);
    this.classificationInFlight.set(pageNum, classificationPromise);

    try {
      const result = await classificationPromise;
      return result;
    } finally {
      this.classificationInFlight.delete(pageNum);
    }
  }

  /**
   * Internal: Classify a page and cache the result
   */
  private async classifyPageInternal(pageNum: number): Promise<PageClassification | null> {
    if (!this.classifyPageCallback || !this.documentId) {
      return null;
    }

    try {
      const classification = await this.classifyPageCallback(this.documentId, pageNum);

      // Cache in L3
      getTileCacheManager().setPageClassification(pageNum, {
        type: classification.type,
        confidence: classification.confidence,
        classificationTimeMs: classification.classificationTimeMs,
        hasTransparency: classification.hasTransparency,
      });

      // Track telemetry
      getTelemetry().trackCustomMetric('classificationTime', classification.classificationTimeMs);
      getTelemetry().trackCustomMetric(`contentType_${classification.type}`, 1);

      return classification;
    } catch (error) {
      console.warn(`[RenderCoordinator] Failed to classify page ${pageNum}:`, error);
      return null;
    }
  }

  /**
   * Get render strategy for a page based on its classification.
   *
   * @param pageNum Page number (1-indexed)
   * @returns Render strategy or null if classification unavailable
   */
  async getRenderStrategyForPage(pageNum: number): Promise<RenderStrategy | null> {
    const classification = await this.getPageClassification(pageNum);
    if (!classification) {
      return null;
    }
    return getRenderStrategy(classification);
  }

  /**
   * Set current document
   */
  setDocument(docId: string): void {
    this.documentId = docId;
    getTileCacheManager().setDocument(docId);
    // Clear classification in-flight cache when switching documents
    this.classificationInFlight.clear();
  }

  /**
   * Get current mode
   */
  getMode(): RenderMode {
    return this.currentMode;
  }

  /**
   * Set render mode
   *
   * Handles mode transitions:
   * - Cancels pending requests for old mode
   * - Triggers cache transition (L1 evicted, L2/L3 preserved)
   * - Notifies listeners of mode change
   *
   * For smooth transitions with pre-rendering, use setModeAsync() instead.
   */
  setMode(mode: RenderMode): void {
    if (mode === this.currentMode) return;

    const prevMode = this.currentMode;
    const transitionStart = performance.now();

    this.transitionInProgress = true;

    // Cancel pending requests (they're for the old mode layout)
    this.cancelAll();

    // Update mode
    this.currentMode = mode;

    // Trigger cache transition (user decision: only evict L1)
    // L2 preserved for cross-mode sharing (thumbnails, tiles)
    getTileCacheManager().onModeTransition();

    // Track transition for telemetry
    const duration = performance.now() - transitionStart;
    getTelemetry().trackModeTransition(prevMode, mode, duration);

    this.transitionInProgress = false;

    // Notify listeners
    for (const callback of this.modeTransitionCallbacks) {
      try {
        callback(prevMode, mode);
      } catch (err) {
        console.warn('[RenderCoordinator] Mode transition callback error:', err);
      }
    }
  }

  /**
   * Set render mode with async pre-transition rendering.
   *
   * This method ensures smooth transitions by:
   * 1. Calling pre-transition callback to render key frames for target mode
   * 2. Waiting for pre-renders to complete (with timeout)
   * 3. Then switching modes
   *
   * Use this for user-initiated mode switches where visual smoothness matters.
   *
   * @param mode Target render mode
   * @param currentPage Current page for pre-rendering context
   * @param timeout Maximum time to wait for pre-renders (default: 500ms)
   */
  async setModeAsync(
    mode: RenderMode,
    currentPage: number = 1,
    timeout: number = 500
  ): Promise<void> {
    if (mode === this.currentMode) return;

    const prevMode = this.currentMode;
    const transitionStart = performance.now();

    this.transitionInProgress = true;

    // Cancel pending requests (they're for the old mode layout)
    this.cancelAll();

    // Pre-render for target mode (if callback is set)
    if (this.preTransitionCallback) {
      try {
        const preRenderPromise = this.preTransitionCallback(mode, currentPage);

        // Wait with timeout
        await Promise.race([
          preRenderPromise,
          new Promise((resolve) => setTimeout(resolve, timeout)),
        ]);
      } catch (err) {
        console.warn('[RenderCoordinator] Pre-transition render error:', err);
      }
    }

    // Update mode
    this.currentMode = mode;

    // Trigger cache transition (user decision: only evict L1)
    // L2 preserved for cross-mode sharing (thumbnails, tiles)
    getTileCacheManager().onModeTransition();

    // Track transition for telemetry
    const duration = performance.now() - transitionStart;
    getTelemetry().trackModeTransition(prevMode, mode, duration);

    this.transitionInProgress = false;

    // Notify listeners
    for (const callback of this.modeTransitionCallbacks) {
      try {
        callback(prevMode, mode);
      } catch (err) {
        console.warn('[RenderCoordinator] Mode transition callback error:', err);
      }
    }
  }

  /**
   * Check if a mode transition is currently in progress
   */
  isTransitioning(): boolean {
    return this.transitionInProgress;
  }

  /**
   * Set pre-transition render callback
   *
   * Called before mode switch to pre-render key frames for target mode.
   * For example, when switching to grid mode, this can pre-render visible thumbnails.
   */
  setPreTransitionCallback(
    callback: ((targetMode: RenderMode, currentPage: number) => Promise<void>) | null
  ): void {
    this.preTransitionCallback = callback;
  }

  /**
   * Add a mode transition listener
   *
   * Called after mode transitions complete. Useful for UI updates.
   */
  onModeTransition(callback: (from: RenderMode, to: RenderMode) => void): () => void {
    this.modeTransitionCallbacks.add(callback);
    return () => this.modeTransitionCallbacks.delete(callback);
  }

  /**
   * Get the current strategy based on mode
   */
  getCurrentStrategy() {
    switch (this.currentMode) {
      case 'paginated':
        return getPaginatedStrategy();
      case 'scroll':
        return getScrollStrategy();
      case 'grid':
        return getGridStrategy();
    }
  }

  /**
   * Request a render
   *
   * Deduplicates requests and manages concurrency.
   * Returns immediately if result is in cache.
   * Aborts old-scale renders when new-scale requests arrive for same position.
   */
  async requestRender(request: RenderRequest): Promise<RenderResult> {
    // BUG FIX: Ensure documentId is always set for consistent cache key generation.
    // If request.documentId is undefined, fall back to the global documentId.
    // This prevents cache key mismatches when requests are created without documentId.
    if (!request.documentId && this.documentId) {
      request.documentId = this.documentId;
    }

    // Assign current session ID for selective abort tracking
    if (request.sessionId === undefined) {
      request.sessionId = getRenderSessionManager().getCurrentSessionId();
    }

    const key = this.getRequestKey(request);
    const positionKey = this.getPositionKey(request);

    // PERF FIX: Check in-flight FIRST, before cache.
    // This prevents false cache misses for tiles that are already being rendered.
    // During scroll, updateVisiblePages is called every frame, requesting the same tiles.
    // Without this early return, each duplicate request increments the cache miss counter.
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    // Check cache
    if (request.type === 'tile') {
      // First try exact scale match
      const cached = await getTileCacheManager().get(request.tile);
      if (cached) {
        return { success: true, data: cached, fromCache: true };
      }

      // PERF FIX: Try fallback at different scale
      // This prevents blank tiles during zoom by using cached tiles at nearby scales
      // with CSS scaling. We return the fallback immediately AND queue a background
      // render at the target scale for quality upgrade.
      //
      // CHECKERBOARD FIX: Only use fallback for non-critical requests.
      // Critical (visible) tiles should wait for fresh render to avoid checkerboard
      // where some tiles are high-res and others are stretched low-res fallbacks.
      // This ensures all visible tiles render at consistent quality.
      //
      // HIGH ZOOM EXCEPTION: Allow fallback for critical tiles at high zoom (scale >= 16).
      // At 16x zoom, tiles take ~200ms to render. A blurry fallback is much better than
      // a permanently blank tile. The background render will upgrade quality.
      // Note: request.type === 'tile' is guaranteed by parent if-block (line 744)
      const isHighZoom = request.tile.scale >= 16;

      // MEMORY PROTECTION: Adaptive queue limits based on tile scale.
      // Higher scales = larger tiles = more memory pressure.
      // Memory per tile (512px CSS tiles):
      // - Scale 16: 268MB  → queue limit 10
      // - Scale 24: 604MB  → queue limit 4
      // - Scale 32: 1.07GB → queue limit 2
      const scale = request.tile.scale;
      const maxQueueByScale = scale >= 24 ? 4 : scale >= 16 ? 6 : 10;
      const queueIsSaturated = this.semaphore.waiting > maxQueueByScale;
      const useFallbackPath = request.priority !== 'critical' || isHighZoom || queueIsSaturated;

      if (useFallbackPath) {
        const fallback = await getTileCacheManager().getBestAvailableBitmap(request.tile);
        if (fallback) {
          // Queue background render at target scale (don't await - fire and forget)
          // Use low priority to avoid competing with visible tile requests
          this.queueBackgroundRender(request);

          // Return fallback immediately for display
          return {
            success: true,
            data: fallback.bitmap,
            fromCache: true,
            isFallback: true,
            actualScale: fallback.actualScale,
            cssStretch: fallback.cssStretch,
          };
        }
      }
    }

    // Abort any existing render at same position (e.g., old scale during zoom)
    // This prevents wasted work when zoom changes rapidly
    const existingController = this.activeByPosition.get(positionKey);
    if (existingController) {
      existingController.abort();
      this.activeByPosition.delete(positionKey);
      this.abortControllers.delete(existingController);
    }

    // Create abort controller for this request if not provided
    const controller = request.abortController ?? new AbortController();
    request.abortController = controller;

    // Track abort controller
    this.abortControllers.add(controller);
    this.activeByPosition.set(positionKey, controller);

    // Create promise and add to in-flight
    const promise = this.executeRequest(request, key);
    this.inFlight.set(key, promise);
    // Track sessionId for selective abort
    if (request.sessionId !== undefined) {
      this.inFlightSessions.set(key, request.sessionId);
    }

    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
      this.inFlightSessions.delete(key);
      this.abortControllers.delete(controller);
      // Only clear position tracking if this controller is still active
      if (this.activeByPosition.get(positionKey) === controller) {
        this.activeByPosition.delete(positionKey);
      }
    }
  }

  /**
   * Request multiple renders
   */
  async requestBatch(requests: RenderRequest[]): Promise<RenderResult[]> {
    return Promise.all(requests.map((req) => this.requestRender(req)));
  }

  /**
   * Cancel all pending requests
   */
  cancelAll(): void {
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
    this.activeByPosition.clear();
    this.inFlightSessions.clear();
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    inFlightCount: number;
    activeRenders: number;
    waitingCount: number;
    mode: RenderMode;
  } {
    return {
      inFlightCount: this.inFlight.size,
      activeRenders: this.activeRenders,
      waitingCount: this.semaphore.waiting,
      mode: this.currentMode,
    };
  }

  /**
   * Get prefetch tiles based on current strategy
   *
   * Delegates to mode-specific strategy for intelligent prefetching:
   * - Paginated: prefetch ±1 pages
   * - Scroll: velocity-based prediction
   * - Grid: ripple from center
   */
  getPrefetchTiles(
    viewport: { x: number; y: number; width: number; height: number },
    pageLayouts: Array<{ page: number; x: number; y: number; width: number; height: number }>,
    velocity: { x: number; y: number },
    zoom: number
  ): TileCoordinate[] {
    const strategy = this.getCurrentStrategy();

    if (this.currentMode === 'scroll') {
      const scrollStrategy = strategy as ReturnType<typeof getScrollStrategy>;
      return scrollStrategy.getPrefetchTiles(viewport, velocity, pageLayouts, zoom);
    }

    // For paginated/grid, get visible tiles only (prefetch handled at page level)
    return [];
  }

  /**
   * Get prefetch tiles with priority information.
   *
   * Returns tiles sorted by priority (0 = critical, 3 = background).
   * Uses velocity-based adaptive lookahead in scroll mode.
   *
   * Priority zones (in viewport units):
   * - Critical (0-0.5): Priority 0 - must render immediately
   * - High (0.5-1.5): Priority 1 - prefetch soon
   * - Medium (1.5-2.5): Priority 2 - opportunistic
   * - Low (2.5-lookahead): Priority 3 - background
   */
  getPrefetchTilesWithPriority(
    viewport: { x: number; y: number; width: number; height: number },
    pageLayouts: Array<{ page: number; x: number; y: number; width: number; height: number }>,
    velocity: { x: number; y: number },
    zoom: number,
    pixelRatio: number = 1
  ): PrioritizedTile[] {
    if (this.currentMode !== 'scroll') {
      // Only scroll mode supports prioritized prefetching
      return [];
    }

    const scrollStrategy = this.getCurrentStrategy() as ReturnType<typeof getScrollStrategy>;
    return scrollStrategy.getPrefetchTilesWithPriority(
      viewport,
      velocity,
      pageLayouts,
      zoom,
      pixelRatio
    );
  }

  /**
   * Get the current speed zone based on velocity.
   * Used for adaptive quality/prefetch decisions.
   */
  getSpeedZone(velocity: { x: number; y: number }): SpeedZone {
    if (this.currentMode !== 'scroll') {
      return 'stationary';
    }

    const scrollStrategy = this.getCurrentStrategy() as ReturnType<typeof getScrollStrategy>;
    return scrollStrategy.getSpeedZone(velocity);
  }

  /**
   * Get pages to prefetch based on current strategy
   */
  getPrefetchPages(currentPage: number, pageCount: number): number[] {
    const strategy = this.getCurrentStrategy();

    if (this.currentMode === 'paginated') {
      const paginatedStrategy = strategy as ReturnType<typeof getPaginatedStrategy>;
      return paginatedStrategy.getPrefetchList(currentPage, pageCount).map(r => r.page);
    }

    // For scroll/grid, page prefetching is viewport-based, not page-number based
    return [];
  }

  /**
   * Determine if tiling should be used based on current mode and zoom.
   *
   * Uses HybridRenderingStrategy for sophisticated decision-making that considers:
   * - Zoom level thresholds (< 1.5x: full-page, > 4x: always tiled)
   * - Page dimensions and memory budget in the adaptive zone (1.5x - 4x)
   * - Viewport coverage optimization
   *
   * At HIGH zoom, tiling is MORE efficient because:
   * 1. Only a small portion of the page is visible = few tiles needed
   * 2. Full-page rendering at high scale creates massive images (e.g., 9600×12800)
   * 3. Tiles can be rendered at exactly the scale needed for the viewport
   *
   * @param zoom Current zoom level
   * @param pageWidth Optional page width in PDF units (for adaptive zone decisions)
   * @param pageHeight Optional page height in PDF units (for adaptive zone decisions)
   */
  shouldUseTiling(zoom: number, pageWidth?: number, pageHeight?: number): boolean {
    // Grid mode uses thumbnails (no tiling)
    if (this.currentMode === 'grid') {
      return false;
    }

    // Use hybrid strategy for sophisticated tiling decision
    const hybridStrategy = getHybridRenderingStrategy();

    // If page dimensions provided, use full hybrid strategy
    if (pageWidth !== undefined && pageHeight !== undefined) {
      return hybridStrategy.shouldUseTiling(zoom, pageWidth, pageHeight);
    }

    // Fallback: use simple threshold-based decision (backward compatibility)
    // This matches the hybrid strategy's threshold behavior
    if (zoom < 1.5) return false;  // Full-page below threshold
    if (zoom > 4.0) return true;   // Always tiled above threshold

    // In adaptive zone without dimensions, default to tiling (safe choice)
    return true;
  }

  /**
   * Get full rendering decision with mode, tile size, and reasoning.
   *
   * Use this method when you need more than just the tiling boolean,
   * such as the optimal tile size or the reason for the decision.
   *
   * @param zoom Current zoom level
   * @param pageWidth Page width in PDF units
   * @param pageHeight Page height in PDF units
   * @param viewportWidth Optional viewport width for coverage calculation
   * @param viewportHeight Optional viewport height for coverage calculation
   */
  getRenderingDecision(
    zoom: number,
    pageWidth: number,
    pageHeight: number,
    viewportWidth?: number,
    viewportHeight?: number
  ): RenderingDecision {
    // Grid mode always returns full-page (thumbnails)
    if (this.currentMode === 'grid') {
      return {
        mode: 'full-page',
        tileSize: 0,
        reason: 'grid mode uses thumbnails',
        estimatedRenderCalls: 1,
      };
    }

    return getHybridRenderingStrategy().getDecision({
      zoom,
      pageWidth,
      pageHeight,
      viewportWidth: viewportWidth ?? 0,
      viewportHeight: viewportHeight ?? 0,
    });
  }

  /**
   * Get tile scale based on zoom level and optional pixel ratio.
   * For crisp rendering: scale = zoom * pixelRatio
   *
   * MEMORY FIX: Capped at MAX_SCALE_TIER (16) to prevent:
   * - Tile explosion (scale 32 = 4x more tiles)
   * - malloc failures (169MB+ allocations)
   * - Cache thrashing (tiles >> cache capacity)
   *
   * @param zoom Current zoom level
   * @param pixelRatio Device pixel ratio (default: 1)
   * @param velocity Optional scroll velocity for quality reduction during fast scroll
   */
  getTileScale(zoom: number, pixelRatio: number = 1, velocity?: { x: number; y: number }): number {
    // TILE SCALE FIX: Use getTargetScaleTier to get a VALID scale tier.
    //
    // Before: Math.ceil(zoom * pixelRatio) produced arbitrary scales like 7, 9, 11
    // which don't exist in SCALE_TIERS, causing every tile to miss cache.
    //
    // Now: getTargetScaleTier returns the nearest valid tier, ensuring cache hits.
    let { tier: scale } = getTargetScaleTier(zoom, pixelRatio);

    // Optional: reduce quality during fast scroll (by stepping down to lower tier)
    if (velocity && this.currentMode === 'scroll') {
      const scrollStrategy = this.getCurrentStrategy() as ReturnType<typeof getScrollStrategy>;
      const qualityFactor = scrollStrategy.getQualityFactorForVelocity(velocity);
      if (qualityFactor < 1) {
        // Step down to a lower tier based on quality factor
        const reducedZoom = zoom * qualityFactor;
        const { tier: reducedScale } = getTargetScaleTier(reducedZoom, pixelRatio);
        scale = reducedScale;
      }
    }

    return scale;
  }

  // Private helpers

  /**
   * Execute a render request with concurrency limiting
   */
  private async executeRequest(
    request: RenderRequest,
    key: string
  ): Promise<RenderResult> {
    // Check if aborted before acquiring permit
    // FALLBACK FIX: Even when aborted, try to return a cached fallback tile
    // to prevent blank areas during rapid zoom changes
    if (request.abortController?.signal.aborted) {
      if (request.type === 'tile') {
        const fallback = await getTileCacheManager().getBestAvailableBitmap(request.tile);
        if (fallback) {
          return {
            success: true,
            data: fallback.bitmap,
            fromCache: true,
            isFallback: true,
            actualScale: fallback.actualScale,
            cssStretch: fallback.cssStretch,
          };
        }
      }
      return { success: false, error: 'Aborted', fromCache: false };
    }

    // Wait for a permit (non-blocking, priority-driven)
    // acquire() returns false if dropped from queue - must NOT release in that case
    // Priority lanes ensure critical renders (visible tiles) skip ahead of background renders
    const queueStartTime = performance.now();
    const acquired = await this.semaphore.acquire(request.priority);
    const queueWaitTime = performance.now() - queueStartTime;

    // Log queue wait time for performance debugging
    // At high zoom (16x+ with scale 32), tiles take 500-800ms to render which is expected.
    // Only warn when wait time is truly excessive (>1s) to avoid flooding the console.
    // Rate-limited: only warn once per 5 seconds for similar wait times.
    const waitingCount = this.semaphore.waiting;
    const now = performance.now();
    const shouldWarn = queueWaitTime > 1000 && (now - this.lastWaitWarningTime > 5000);

    if (shouldWarn) {
      this.lastWaitWarningTime = now;
      console.warn(`[Perf] ${request.priority} tile waited ${queueWaitTime.toFixed(1)}ms for render permit (queue: ${waitingCount}, key: ${key})`);
    }

    if (!acquired) {
      // FALLBACK FIX: Even when dropped from queue, try to return a cached fallback tile
      if (request.type === 'tile') {
        const fallback = await getTileCacheManager().getBestAvailableBitmap(request.tile);
        if (fallback) {
          return {
            success: true,
            data: fallback.bitmap,
            fromCache: true,
            isFallback: true,
            actualScale: fallback.actualScale,
            cssStretch: fallback.cssStretch,
          };
        }
      }
      return { success: false, error: 'Dropped from queue', fromCache: false };
    }
    this.activeRenders++;

    const startTime = performance.now();

    try {
      // Check if aborted after acquiring permit
      // FALLBACK FIX: Even when aborted, try to return a cached fallback tile
      if (request.abortController?.signal.aborted) {
        if (request.type === 'tile') {
          const fallback = await getTileCacheManager().getBestAvailableBitmap(request.tile);
          if (fallback) {
            return {
              success: true,
              data: fallback.bitmap,
              fromCache: true,
              isFallback: true,
              actualScale: fallback.actualScale,
              cssStretch: fallback.cssStretch,
            };
          }
        }
        return { success: false, error: 'Aborted', fromCache: false };
      }

      let blob: Blob | null = null;
      let cachedData: CachedTileData | null = null;

      if (request.type === 'tile') {
        if (!this.renderTileCallback || !this.documentId) {
          return {
            success: false,
            error: 'No render callback configured',
            fromCache: false,
          };
        }

        // ========== Content-Type Aware Routing (Phase 5) ==========
        // Check if we should use JPEG extraction for scanned pages
        // or vector scale optimization for vector-heavy pages
        const pageNum = request.tile.page;
        let usedFastPath = false;
        let vectorOptimization: OptimizedRenderParams | null = null;

        const contentTypeEnabled = this.isContentTypeDetectionEnabled();
        console.log(`[RenderCoordinator] Tile render page ${pageNum}, contentTypeEnabled: ${contentTypeEnabled}`);

        if (contentTypeEnabled) {
          const classification = await this.getPageClassification(pageNum);
          console.log(`[RenderCoordinator] Page ${pageNum} classification:`, classification?.type || 'null');
          if (classification) {
            const strategy = getRenderStrategy(classification);

            // Track classification telemetry
            getTelemetry().trackCustomMetric(`render_contentType_${classification.type}`, 1);

            // SCANNED_JPEG fast path: Direct JPEG extraction
            if (
              strategy.useDirectExtraction &&
              classification.type === PDFContentType.SCANNED_JPEG &&
              this.extractJpegCallback
            ) {
              try {
                const jpegStartTime = performance.now();
                const jpegData = await this.extractJpegCallback(this.documentId, pageNum);
                const jpegDuration = performance.now() - jpegStartTime;

                // Create blob from JPEG data
                // Copy data to ensure regular ArrayBuffer (not SharedArrayBuffer)
                const jpegCopy = new Uint8Array(jpegData.data);
                const jpegBlob = new Blob([jpegCopy], { type: 'image/jpeg' });
                // Store as 'png' format for cache compatibility (it's still a Blob)
                cachedData = {
                  format: 'png',
                  blob: jpegBlob,
                  width: jpegData.width,
                  height: jpegData.height,
                };

                // Track fast path telemetry
                getTelemetry().trackCustomMetric('jpegExtraction_count', 1);
                getTelemetry().trackCustomMetric('jpegExtraction_time', jpegDuration);
                usedFastPath = true;

                console.log(
                  `[RenderCoordinator] JPEG extraction for page ${pageNum}: ${jpegDuration.toFixed(1)}ms`
                );
              } catch (error) {
                // Fall back to standard rendering
                console.warn(
                  `[RenderCoordinator] JPEG extraction failed for page ${pageNum}, falling back:`,
                  error
                );
              }
            }

            // VECTOR_HEAVY optimization: Render at reduced scale with CSS upscaling
            if (
              !usedFastPath &&
              shouldApplyVectorOptimization(request.tile.scale, classification)
            ) {
              vectorOptimization = getOptimizedRenderParams(request.tile.scale, classification);

              if (vectorOptimization.wasOptimized) {
                // Track vector optimization telemetry
                const memorySaved = calculateVectorOptimizationSavings(
                  vectorOptimization.requestedScale,
                  vectorOptimization.actualScale,
                  256 // tile size
                );
                getTelemetry().trackCustomMetric('vectorOptimization_count', 1);
                getTelemetry().trackCustomMetric('vectorOptimization_memorySaved', memorySaved);

                console.log(
                  `[RenderCoordinator] Vector optimization for page ${pageNum}: ` +
                  `scale ${request.tile.scale} → ${vectorOptimization.actualScale}, ` +
                  `CSS ${vectorOptimization.cssScaleFactor.toFixed(2)}x, ` +
                  `saved ${(memorySaved / 1024 / 1024).toFixed(2)}MB`
                );
              }
            }
          }
        }

        // Standard rendering path (or fallback)
        if (!usedFastPath) {
          // Apply vector optimization by modifying the tile scale
          const tileToRender: TileCoordinate = vectorOptimization?.wasOptimized
            ? { ...request.tile, scale: vectorOptimization.actualScale }
            : request.tile;

          const result = await this.renderTileCallback(tileToRender, this.documentId);

          // DEBUG: Log what the render callback returned
          console.log(`[RenderCoordinator] renderTileCallback returned: isBlob=${result instanceof Blob}, format=${(result as any)?.format}, hasRgba=${!!(result as any)?.rgba}, hasBlob=${!!(result as any)?.blob}`);

          // Handle TileRenderResult (new format-aware) or legacy Blob
          if (result instanceof Blob) {
            blob = result;
            cachedData = { format: 'png', blob, width: 0, height: 0 };
          } else {
            // TileRenderResult - extract the appropriate data
            if (result.format === 'rgba' && result.rgba) {
              cachedData = {
                format: 'rgba',
                rgba: result.rgba,
                width: result.width,
                height: result.height,
              };
            } else if (result.blob) {
              blob = result.blob;
              cachedData = {
                format: 'png',
                blob,
                width: result.width,
                height: result.height,
              };
            } else {
              // DEBUG: This means cachedData stays null!
              console.warn(`[RenderCoordinator] CACHE BUG: result has neither rgba nor blob! result.format=${result.format}`);
            }
          }

          // Add vector optimization metadata to cached data
          if (cachedData && vectorOptimization?.wasOptimized) {
            cachedData.wasOptimized = true;
            cachedData.cssScaleFactor = vectorOptimization.cssScaleFactor;
            // Calculate target dimensions (original requested scale dimensions)
            cachedData.targetWidth = Math.ceil(cachedData.width * vectorOptimization.cssScaleFactor);
            cachedData.targetHeight = Math.ceil(cachedData.height * vectorOptimization.cssScaleFactor);
          }
        }

        // Cache the result
        // Use content type's cache priority to influence tier selection:
        // - 'high' priority (TEXT_HEAVY, SCANNED) → prefer L1 for faster retrieval
        // - 'low' priority (COMPLEX) → demote to L2/L3
        // - 'normal' → use request priority as before
        // DEBUG: Log whether we're caching
        console.log(`[RenderCoordinator] Tile render complete, cachedData=${cachedData ? 'yes' : 'NO'}, blob=${blob ? 'yes' : 'no'}, key=${key}`);
        if (cachedData) {
          let tier: 'L1' | 'L2' | 'L3' = request.priority === 'critical' ? 'L1' : 'L2';

          // Get content-type based cache priority
          if (contentTypeEnabled) {
            const classification = getTileCacheManager().getPageClassification(pageNum);
            if (classification) {
              const pageClassification: PageClassification = {
                type: classification.type as PDFContentType,
                confidence: classification.confidence,
                classificationTimeMs: classification.classificationTimeMs,
                hasTransparency: classification.hasTransparency,
                pageNum,
              };
              const strategy = getRenderStrategy(pageClassification);
              if (strategy.cachePriority === 'high') {
                // Text-heavy and scanned pages benefit from L1 caching
                tier = 'L1';
              } else if (strategy.cachePriority === 'low' && tier === 'L1') {
                // Complex pages don't need premium caching
                tier = 'L2';
              }
            }
          }

          await getTileCacheManager().set(request.tile, cachedData, tier);
        }
      } else {
        // ========== Full-Page Render Path ==========
        // Full-page renders are used at low zoom levels (< tiling threshold).
        // This path now has full cache integration (previously missing).
        if (!this.renderPageCallback || !this.documentId) {
          return {
            success: false,
            error: 'No render callback configured',
            fromCache: false,
          };
        }

        // Check full-page cache first - returns ImageBitmap directly if cached
        const cacheManager = getTileCacheManager();
        const cachedFullPage = await cacheManager.getFullPage(request.page, request.scale);
        if (cachedFullPage) {
          // Cache hit - return the ImageBitmap directly
          console.log(`[RenderCoordinator] Full-page cache HIT for page ${request.page} at scale ${request.scale}`);
          getTelemetry().trackCustomMetric('fullPageCacheHit', 1);
          const duration = performance.now() - startTime;
          getTelemetry().trackRenderTime(duration, 'page');
          return { success: true, data: cachedFullPage, fromCache: true };
        }

        // Cache miss - render the full page
        console.log(`[RenderCoordinator] Full-page render for page ${request.page} at scale ${request.scale}`);
        blob = await this.renderPageCallback(
          request.page,
          request.scale,
          this.documentId
        );

        // Cache the result for future use
        if (blob) {
          const fullPageCacheData: CachedTileData = {
            format: 'png',
            blob,
            width: 0, // Unknown for full-page
            height: 0,
          };
          const tier = request.priority === 'critical' ? 'L1' : 'L2';
          await cacheManager.setFullPage(request.page, request.scale, fullPageCacheData, tier);
          console.log(`[RenderCoordinator] Full-page cached at ${tier} for page ${request.page}`);
        }
      }

      // Track render time
      const duration = performance.now() - startTime;
      getTelemetry().trackRenderTime(
        duration,
        request.type === 'tile' ? 'tile' : 'page'
      );

      // Return data - prefer ImageBitmap for raw RGBA, otherwise Blob
      if (cachedData?.format === 'rgba' && cachedData.rgba) {
        // Convert raw RGBA to ImageBitmap for display
        // Use pool for temporary array to reduce GC pressure
        const pool = getTypedArrayPool();
        const rgbaArray = pool.acquireUint8ClampedArray(cachedData.rgba.length);
        rgbaArray.set(cachedData.rgba);
        const imageData = new ImageData(rgbaArray, cachedData.width, cachedData.height);
        const bitmap = await createImageBitmap(imageData);
        // Release array back to pool after bitmap is created
        pool.releaseUint8ClampedArray(rgbaArray);
        return { success: true, data: bitmap, fromCache: false };
      } else if (blob) {
        // Convert Blob to ImageBitmap before returning
        // Use canvas pool for off-main-thread decoding when available
        const canvasPool = getCanvasPool();
        const pageNum = request.type === 'tile' ? request.tile.page : request.page;
        let bitmap: ImageBitmap;
        if (canvasPool.isAvailable()) {
          const result = await canvasPool.processImage(blob, 0, 0, pageNum);
          bitmap = result.imageBitmap;
        } else {
          // Fallback to main thread decoding
          bitmap = await createImageBitmap(blob);
        }
        return { success: true, data: bitmap, fromCache: false };
      } else {
        return { success: false, error: 'Render failed', fromCache: false };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message, fromCache: false };
    } finally {
      this.activeRenders--;
      this.semaphore.release();
    }
  }

  /**
   * Get position key (without scale) for abort tracking.
   * Used to cancel old-scale renders when new-scale requests arrive.
   */
  private getPositionKey(request: RenderRequest): string {
    const docPrefix = request.documentId ? `${request.documentId}-` : '';
    if (request.type === 'tile') {
      const t = request.tile;
      return `${docPrefix}tile-p${t.page}-t${t.tileX}x${t.tileY}`;
    } else {
      return `${docPrefix}page-${request.page}`;
    }
  }

  /**
   * Queue a background render for quality upgrade (fallback → full quality).
   *
   * PERF FIX: When a fallback tile is returned, we queue the actual render
   * at low priority so it doesn't compete with visible tile requests.
   * This ensures smooth interaction while progressively upgrading quality.
   */
  private queueBackgroundRender(request: RenderRequest): void {
    const key = this.getRequestKey(request);

    // Skip if already in flight
    if (this.inFlight.has(key)) {
      return;
    }

    // Execute at low priority (don't await)
    this.executeRequest(request, key)
      .then(() => {
        // Render completed, cache was populated by executeRequest
      })
      .catch((error) => {
        // Log but don't propagate - this is a background upgrade
        if (error.name !== 'AbortError') {
          console.warn('[RenderCoordinator] Background render failed:', error);
        }
      });
  }

  /**
   * Get unique key for a render request.
   *
   * CRITICAL: Includes documentId for cross-document isolation.
   * Without documentId, two different PDFs requesting the same tile coordinates
   * would be deduplicated together, causing data leaks between documents.
   */
  private getRequestKey(request: RenderRequest): string {
    // Use documentId prefix for isolation, fallback to empty string if not provided
    const docPrefix = request.documentId ? `${request.documentId}-` : '';

    if (request.type === 'tile') {
      const t = request.tile;
      // CRITICAL: Use quantized scale to match cache key format.
      // This ensures deduplication works correctly - without quantization,
      // tiles at scale 2.0 and 2.0001 would have different request keys but
      // the same cache key, causing duplicate renders.
      const qScale = quantizeScale(t.scale);
      return `${docPrefix}tile-p${t.page}-t${t.tileX}x${t.tileY}-s${qScale}`;
    } else {
      return `${docPrefix}page-${request.page}-s${request.scale.toFixed(2)}`;
    }
  }
}

// Singleton instance
let coordinatorInstance: RenderCoordinator | null = null;

/**
 * Get the shared render coordinator instance
 */
export function getRenderCoordinator(): RenderCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new RenderCoordinator();
  }
  return coordinatorInstance;
}

/**
 * Reset the coordinator (for testing)
 */
export function resetRenderCoordinator(): void {
  if (coordinatorInstance) {
    coordinatorInstance.cancelAll();
  }
  coordinatorInstance = null;
}

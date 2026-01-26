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
import { getTileSize } from './tile-render-engine';
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
import { isFeatureEnabled } from './feature-flags';
import type { GesturePhase } from './zoom-scale-service';
// Diagnostic trackers for T2HR and focal-point analysis
import { getT2HRTracker } from './t2hr-tracker';
import { getFocalPointTracker } from './focal-point-tracker';

// ─────────────────────────────────────────────────────────────────
// Dynamic Semaphore Policy (amnesia-e4i)
// ─────────────────────────────────────────────────────────────────

/**
 * Semaphore policy configuration based on reader state.
 * 
 * During active gestures, we need to be aggressive about dropping tiles
 * to prevent queue overflow. During idle, we can be more permissive.
 */
export interface SemaphorePolicy {
  /** Maximum queue size before dropping tiles */
  maxQueueSize: number;
  /** Zoom threshold above which viewport-only tiles are used */
  viewportOnlyThreshold: number;
  /** How aggressively to drop tiles: 'aggressive' drops more, 'conservative' less */
  dropBehavior: 'aggressive' | 'moderate' | 'conservative';
  /** Maximum tiles per page to request (0 = unlimited) */
  maxTilesPerPage: number;
}

/**
 * Get semaphore policy based on gesture phase and zoom level.
 * 
 * The key insight: during active gestures, the viewport is constantly changing,
 * so there's no point rendering tiles that will be obsolete in milliseconds.
 * We should:
 * 1. Keep queue small (drop old requests fast)
 * 2. Only render viewport-visible tiles
 * 3. Accept lower resolution fallbacks
 * 
 * During idle, we can prefetch and build up the cache.
 */
export function getSemaphorePolicy(gesturePhase: GesturePhase, zoom: number): SemaphorePolicy {
  // amnesia-e4i FIX: Apply zoom-based tile limits to ALL phases, not just idle.
  // At extreme zoom (32x), each tile takes 500ms+ to render.
  // Even during 'rendering' phase, 200 tiles × 500ms = 100 seconds is too long.
  // 
  // The zoom-based limit is the UPPER BOUND - phase-based limits can be lower.
  // zoom >= 32: max 50 tiles (5s at 100ms/tile)
  // zoom >= 16: max 100 tiles (10s at 100ms/tile)
  // zoom >= 8: max 150 tiles (15s at 100ms/tile)
  // zoom < 8: no zoom-based limit
  const zoomBasedMax = zoom >= 32 ? 50 : 
                       zoom >= 16 ? 100 : 
                       zoom >= 8 ? 150 : Infinity;

  switch (gesturePhase) {
    case 'active':
      // During active zoom/pan: very aggressive
      // User is actively moving, tiles become stale instantly
      return {
        maxQueueSize: 50,
        viewportOnlyThreshold: 2, // Always use viewport-only during gestures
        dropBehavior: 'aggressive',
        maxTilesPerPage: Math.min(30, zoomBasedMax),
      };
    
    case 'settling':
      // Gesture just ended, waiting for final position
      // Still moving but slowing down
      return {
        maxQueueSize: 150,
        viewportOnlyThreshold: 4,
        dropBehavior: 'moderate',
        maxTilesPerPage: Math.min(100, zoomBasedMax),
      };
    
    case 'rendering':
      // Settled, actively rendering final tiles
      // Position stable, can render more - BUT respect zoom-based limit
      return {
        maxQueueSize: 300,
        viewportOnlyThreshold: 8,
        dropBehavior: 'moderate',
        maxTilesPerPage: Math.min(200, zoomBasedMax),
      };
    
    case 'idle':
    default:
      // Fully idle, can prefetch and build cache
      // Use zoom-based limit directly
      const maxTiles = zoom >= 32 ? 50 : 
                       zoom >= 16 ? 100 : 
                       zoom >= 8 ? 200 : 300;
      return {
        maxQueueSize: 400,
        viewportOnlyThreshold: 8,
        dropBehavior: 'conservative',
        maxTilesPerPage: maxTiles,
      };
  }
}

/** Current gesture phase for policy decisions */
let currentGesturePhase: GesturePhase = 'idle';

/** Update the current gesture phase (called from ZoomScaleService) */
export function setGesturePhase(phase: GesturePhase): void {
  if (currentGesturePhase !== phase) {
    const oldPhase = currentGesturePhase;
    console.log(`[SemaphorePolicy] Gesture phase: ${oldPhase} → ${phase}`);
    currentGesturePhase = phase;
    
    // Record transition for timing analysis (amnesia-e4i)
    try {
      getTileDiagnosticOverlay().recordPhaseTransition(oldPhase, phase);
    } catch { /* overlay may not be initialized */ }
    
    // Update semaphore policy
    const coordinator = getRenderCoordinatorInstance();
    if (coordinator) {
      const currentZoom = coordinator.getCurrentZoom?.() ?? 1;
      const policy = getSemaphorePolicy(phase, currentZoom);
      console.log(`[PHASE-CHANGE-POLICY] phase=${phase}, zoom=${currentZoom.toFixed(2)}, maxTilesPerPage=${policy.maxTilesPerPage}`);
      coordinator.updateSemaphorePolicy(policy);
    } else {
      console.warn(`[PHASE-CHANGE-POLICY] NO COORDINATOR for phase=${phase} - policy NOT updated!`);
    }
  }
}

/** Get current gesture phase */
export function getGesturePhase(): GesturePhase {
  return currentGesturePhase;
}

/** Get current policy based on gesture phase and zoom */
export function getCurrentSemaphorePolicy(zoom: number): SemaphorePolicy {
  return getSemaphorePolicy(currentGesturePhase, zoom);
}

// Singleton instance accessor (set during initialization)
let renderCoordinatorInstance: RenderCoordinator | null = null;

function getRenderCoordinatorInstance(): RenderCoordinator | null {
  return renderCoordinatorInstance;
}
import { generateDebugTileSvg, type DebugTileInfo } from './debug-tile-renderer';
import { isDebugTileModeEnabled } from './debug-mock-pdf';
import { getTileDiagnosticOverlay } from './tile-diagnostic-overlay';

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
  /** CSS scale factor for per-tile quality variation (amnesia-d9f). */
  cssStretch?: number;
  /** Scale epoch at request time (INV-6: Scale/Layout Atomicity). */
  scaleEpoch?: number;
  /** Render parameters identity hash (INV-6: Scale/Layout Atomicity). */
  renderParamsId?: string;
  /** Current zoom level (for debug tiles). */
  zoom?: number;
  /** Originally requested scale before any capping (for debug). */
  requestedScale?: number;
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
  /** Scale epoch from request (INV-6: Scale/Layout Atomicity). */
  scaleEpoch?: number;
  /** Render parameters identity hash (INV-6: Scale/Layout Atomicity). */
  renderParamsId?: string;
  /**
   * amnesia-e4i FIX: The actual tile coordinates of the fallback tile.
   * When a fallback is used, this contains the tile coordinates that map to
   * the actual PDF region in the bitmap. The compositing code MUST use these
   * coordinates (not the original request coordinates) for correct positioning.
   *
   * If undefined, the original request tile coordinates should be used.
   */
  fallbackTile?: import('./tile-render-engine').TileCoordinate;
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
  private maxQueueSize: number; // Mutable for dynamic policy (amnesia-e4i)

  // Priority queues: critical (0) > high (1) > medium (2) > low (3)
  private priorityQueues: Map<RenderPriority, Array<(acquired: boolean) => void>> = new Map([
    ['critical', []],
    ['high', []],
    ['medium', []],
    ['low', []],
  ]);

  private static readonly PRIORITY_ORDER: RenderPriority[] = ['critical', 'high', 'medium', 'low'];

  // Queue size increased from 100 to 400 for amnesia-e4i fix.
  // At mid-zoom (4-16x), a single page can require 294+ tiles (e.g., 14×21 grid).
  // With queue size 100, most tiles were "Dropped from queue" causing 18% coverage.
  // Queue size 400 handles ~1.3 full pages at mid-zoom, sufficient for typical viewports.
  constructor(maxPermits: number, maxQueueSize = 400) {
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
   * Drop lowest priority waiters when queue is full
   */
  private dropLowestPriorityWaiters(): void {
    const beforeCount = this.getTotalWaiters();
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
    const afterCount = this.getTotalWaiters();
    const droppedCount = beforeCount - afterCount;
    if (droppedCount > 0) {
      console.warn(`[SEMAPHORE] dropLowestPriorityWaiters: Dropped ${droppedCount} tiles (queue was ${beforeCount}, now ${afterCount}, max=${this.maxQueueSize})`);
      // Record drops for diagnostic overlay (amnesia-e4i debugging)
      for (let i = 0; i < droppedCount; i++) {
        try {
          getTileDiagnosticOverlay().recordDrop('queue-overflow');
        } catch { /* overlay may not be initialized */ }
      }
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
    if (count > 0) {
      console.warn(`[SEMAPHORE] clearQueue: Dropped ${count} waiting tiles`);
      // Record drops for diagnostic overlay (amnesia-e4i debugging)
      for (let i = 0; i < count; i++) {
        try {
          getTileDiagnosticOverlay().recordDrop('queue-cleared');
        } catch { /* overlay may not be initialized */ }
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

  /**
   * Dynamically update max queue size (amnesia-e4i).
   * Used to adjust queue limits based on reader state (scrolling, zooming, idle).
   * 
   * If current queue exceeds new limit, excess waiters are dropped.
   */
  setMaxQueueSize(newSize: number): void {
    const oldSize = this.maxQueueSize;
    this.maxQueueSize = newSize;
    
    // If we're over the new limit, drop excess waiters
    if (this.getTotalWaiters() > newSize) {
      console.log(`[SEMAPHORE] Policy change: maxQueue ${oldSize} → ${newSize}, trimming queue`);
      this.dropLowestPriorityWaiters();
    } else if (oldSize !== newSize) {
      console.log(`[SEMAPHORE] Policy change: maxQueue ${oldSize} → ${newSize}`);
    }
  }

  /** Get current max queue size */
  getMaxQueueSize(): number {
    return this.maxQueueSize;
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
   * 
   * amnesia-d9f FIX: Now stores scale along with controller to avoid
   * aborting same-scale requests during continuous zoom.
   */
  private activeByPosition = new Map<string, { controller: AbortController; scale: number }>();

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

  /** Current zoom level (tracked for policy decisions) */
  private currentZoom = 1;

  /** Current semaphore policy */
  private currentPolicy: SemaphorePolicy = getSemaphorePolicy('idle', 1);

  // ============================================================
  // Tile Ready Callback (amnesia-xc0: Nudge Bug Fix)
  // ============================================================
  
  /**
   * Callback triggered when a tile finishes rendering and is cached.
   * Used to trigger re-composite for visible pages without requiring user interaction.
   * 
   * amnesia-xc0: Extended to include scaleEpoch for epoch-gated compositing.
   * The epoch allows the canvas to validate that tiles are compatible with
   * the current render state before drawing them.
   * 
   * @param page - Page number the tile belongs to
   * @param priority - Priority level of the completed tile
   * @param scaleEpoch - The epoch when this tile was requested (for validation)
   */
  public onTileReady: ((page: number, priority: RenderPriority, scaleEpoch: number) => void) | null = null;

  // ============================================================
  // Smart Retry Queue (amnesia-e4i)
  // ============================================================
  
  /** 
   * Retry queue for tiles that were dropped from the semaphore queue.
   * Key: tile position key (without scale), Value: retry entry
   * 
   * SAFEGUARDS against infinite loops and memory leaks:
   * 1. MAX_RETRY_ATTEMPTS limits retries per tile
   * 2. RETRY_COOLDOWN_MS prevents rapid-fire retries
   * 3. MAX_RETRY_QUEUE_SIZE caps memory usage
   * 4. RETRY_ENTRY_TTL_MS expires stale entries
   * 5. Viewport check ensures we don't retry off-screen tiles
   */
  private retryQueue = new Map<string, {
    tile: TileCoordinate;
    attempts: number;
    lastDropTime: number;
    priority: RenderPriority;
  }>();
  
  // Retry safeguard constants
  private static readonly MAX_RETRY_ATTEMPTS = 3;
  private static readonly RETRY_COOLDOWN_MS = 500;
  private static readonly MAX_RETRY_QUEUE_SIZE = 100;
  private static readonly RETRY_ENTRY_TTL_MS = 5000; // 5 seconds

  constructor(options?: { maxConcurrent?: number; enableContentTypeDetection?: boolean }) {
    // PERF FIX: Reduced from 16 to 4 permits to match worker pool size.
    // With 16 permits but only 4 workers, 12 requests would hold permits while
    // waiting for a worker, causing queue saturation (68+ tiles waiting 2-4 seconds).
    // Now permits match actual worker capacity for <100ms queue wait times.
    this.semaphore = new Semaphore(options?.maxConcurrent ?? 4);
    this.contentTypeDetectionEnabled = options?.enableContentTypeDetection ?? false;
    
    // Register this instance for policy updates
    renderCoordinatorInstance = this;
  }

  // ============================================================
  // Dynamic Semaphore Policy (amnesia-e4i)
  // ============================================================

  /**
   * Update semaphore policy based on reader state.
   * Called when gesture phase changes or zoom level changes significantly.
   */
  updateSemaphorePolicy(policy: SemaphorePolicy): void {
    const stack = new Error().stack?.split('\n').slice(1, 4).join(' <- ') || 'no stack';
    console.log(`[POLICY-UPDATE-CALLER] maxTilesPerPage=${policy.maxTilesPerPage}, caller: ${stack}`);
    const oldPolicy = this.currentPolicy;
    this.currentPolicy = policy;
    
    // Update semaphore queue size
    this.semaphore.setMaxQueueSize(policy.maxQueueSize);
    
    if (oldPolicy.maxQueueSize !== policy.maxQueueSize || 
        oldPolicy.viewportOnlyThreshold !== policy.viewportOnlyThreshold) {
      console.log(`[RenderCoordinator] Policy update:`, {
        maxQueueSize: `${oldPolicy.maxQueueSize} → ${policy.maxQueueSize}`,
        viewportOnlyThreshold: `${oldPolicy.viewportOnlyThreshold} → ${policy.viewportOnlyThreshold}`,
        dropBehavior: policy.dropBehavior,
        maxTilesPerPage: policy.maxTilesPerPage || 'unlimited',
      });
    }
  }

  /**
   * Get current semaphore policy.
   * Used by rendering code to decide viewport-only vs full-page tiles.
   */
  getCurrentPolicy(): SemaphorePolicy {
    return this.currentPolicy;
  }

  /**
   * Update current zoom level (for policy calculations).
   * Also updates the semaphore policy since maxTilesPerPage depends on zoom.
   */
  setCurrentZoom(zoom: number): void {
    const oldZoom = this.currentZoom;
    this.currentZoom = zoom;
    
    // amnesia-e4i FIX: Update policy when zoom changes significantly.
    // The maxTilesPerPage limit depends on zoom level (50 at 32x, 300 at 8x).
    // Without this, policy only updates on gesture phase change, leaving
    // stale limits that cause queue saturation at extreme zoom.
    const zoomRatio = Math.max(zoom / oldZoom, oldZoom / zoom);
    if (zoomRatio >= 1.5 || (zoom >= 16 && oldZoom < 16) || (zoom >= 32 && oldZoom < 32)) {
      const policy = getSemaphorePolicy(currentGesturePhase, zoom);
      this.updateSemaphorePolicy(policy);
      console.log(`[RenderCoordinator] Zoom-triggered policy update: zoom ${oldZoom.toFixed(0)} → ${zoom.toFixed(0)}, maxTilesPerPage=${policy.maxTilesPerPage}`);
    }
  }

  /**
   * Get current zoom level.
   */
  getCurrentZoom(): number {
    return this.currentZoom;
  }

  /**
   * Check if viewport-only tiles should be used at the given zoom level.
   * Based on current policy which is determined by gesture state.
   * 
   * amnesia-e4i FIX: Use >= instead of > to avoid requesting 4704+ tiles
   * at exactly the threshold zoom level. At zoom 16 with threshold 16,
   * the old logic (16 > 16 = false) would request full-page tiles, but
   * a 441×666 PDF at scale 32 needs 56×84 = 4704 tiles - way too many!
   */
  shouldUseViewportOnlyTiles(zoom: number): boolean {
    return zoom >= this.currentPolicy.viewportOnlyThreshold;
  }

  /**
   * Get max tiles per page based on current policy AND current zoom.
   * 
   * amnesia-e4i FIX: Compute zoom-based limit dynamically instead of relying
   * on cached policy. This fixes the issue where policy updates during
   * gesture phase transitions weren't being applied correctly during render.
   * 
   * The issue: During `settling → rendering` transition, the policy update
   * might not have propagated by the time `renderPageTiled()` calls this method.
   * By computing the zoom limit here, we guarantee correct behavior regardless
   * of policy update timing.
   * 
   * Returns Infinity for no limit.
   */
  getMaxTilesPerPage(): number {
    // Compute zoom-based limit dynamically (mirrors getSemaphorePolicy logic)
    const zoomLimit = this.currentZoom >= 32 ? 50 : 
                      this.currentZoom >= 16 ? 100 : 
                      this.currentZoom >= 8 ? 150 : Infinity;
    
    // Return the stricter of policy limit and zoom limit
    const effectiveLimit = Math.min(this.currentPolicy.maxTilesPerPage, zoomLimit);
    
    // Debug log to verify fix is working
    if (this.currentZoom >= 8) {
      console.log(`[getMaxTilesPerPage] zoom=${this.currentZoom.toFixed(2)}, policyLimit=${this.currentPolicy.maxTilesPerPage}, zoomLimit=${zoomLimit}, effective=${effectiveLimit}`);
    }
    
    return effectiveLimit;
  }

  // ============================================================
  // Smart Retry Queue Methods (amnesia-e4i)
  // ============================================================

  /**
   * Add a dropped tile to the retry queue.
   * Includes multiple safeguards to prevent infinite loops and memory leaks.
   */
  private addToRetryQueue(tile: TileCoordinate, priority: RenderPriority): void {
    const key = this.getTilePositionKey(tile);
    const now = performance.now();
    const existing = this.retryQueue.get(key);
    
    // SAFEGUARD 1: Max retry attempts
    if (existing && existing.attempts >= RenderCoordinator.MAX_RETRY_ATTEMPTS) {
      console.warn(`[RetryQueue] Max attempts reached for ${key}, not re-queuing`);
      this.retryQueue.delete(key);
      return;
    }
    
    // SAFEGUARD 2: Queue size limit (prevent memory leaks)
    if (this.retryQueue.size >= RenderCoordinator.MAX_RETRY_QUEUE_SIZE) {
      // Remove oldest entry
      const oldestKey = this.retryQueue.keys().next().value;
      if (oldestKey) {
        this.retryQueue.delete(oldestKey);
        console.log(`[RetryQueue] Queue full, evicted oldest: ${oldestKey}`);
      }
    }
    
    // Add or update entry
    const attempts = (existing?.attempts ?? 0) + 1;
    this.retryQueue.set(key, {
      tile: { ...tile }, // Clone to prevent mutation
      attempts,
      lastDropTime: now,
      // Boost priority for retries (but don't go above 'high' to avoid starving critical)
      priority: priority === 'low' ? 'medium' : priority === 'medium' ? 'high' : priority,
    });
    
    console.log(`[RetryQueue] Added ${key} (attempt ${attempts}/${RenderCoordinator.MAX_RETRY_ATTEMPTS}), queue size: ${this.retryQueue.size}`);
  }
  
  /**
   * Get tile position key (without scale) for retry tracking.
   * We use position-only key because the same visual tile might be
   * requested at different scales during zoom transitions.
   */
  private getTilePositionKey(tile: TileCoordinate): string {
    return `p${tile.page}-t${tile.tileX}x${tile.tileY}`;
  }
  
  /**
   * Process retry queue - attempt to re-render dropped tiles.
   * Call this after renders complete or on a periodic basis.
   * 
   * @param viewportBounds Optional viewport to filter out off-screen tiles
   * @returns Number of tiles queued for retry
   */
  async processRetryQueue(viewportBounds?: { x: number; y: number; width: number; height: number }): Promise<number> {
    // amnesia-e4i FIX: Don't process retry queue if semaphore is saturated.
    // This prevents the infinite loop where retried tiles get immediately dropped
    // and re-added to the retry queue.
    const queueSaturation = this.semaphore.waiting / this.currentPolicy.maxQueueSize;
    if (queueSaturation >= 0.5) {
      console.log(`[RetryQueue] Skipping - queue ${(queueSaturation * 100).toFixed(0)}% saturated`);
      return 0;
    }
    
    const now = performance.now();
    let retriedCount = 0;
    const toRetry: Array<{ key: string; tile: TileCoordinate; priority: RenderPriority }> = [];
    
    // First pass: collect eligible tiles and clean up stale entries
    for (const [key, entry] of this.retryQueue) {
      // SAFEGUARD 3: TTL expiry (prevent stale entries from accumulating)
      if (now - entry.lastDropTime > RenderCoordinator.RETRY_ENTRY_TTL_MS) {
        this.retryQueue.delete(key);
        console.log(`[RetryQueue] Entry expired: ${key}`);
        continue;
      }
      
      // SAFEGUARD 4: Cooldown (prevent rapid-fire retries)
      if (now - entry.lastDropTime < RenderCoordinator.RETRY_COOLDOWN_MS) {
        continue; // Not ready for retry yet
      }
      
      // SAFEGUARD 5: Viewport check - skip tiles that are off-screen
      // (This is a simple check; full viewport intersection would need layout info)
      if (viewportBounds) {
        // We don't have full layout info here, so just log that we're doing viewport filtering
        // The actual filtering happens in the caller who has the layout info
      }
      
      toRetry.push({ key, tile: entry.tile, priority: entry.priority });
    }
    
    // Second pass: queue retries (limit batch size to prevent queue flood)
    const BATCH_SIZE = 10;
    for (const { key, tile, priority } of toRetry.slice(0, BATCH_SIZE)) {
      this.retryQueue.delete(key); // Remove from retry queue before re-requesting
      
      console.log(`[RetryQueue] Retrying ${key} at priority ${priority}`);
      
      // Don't await - fire and forget to avoid blocking
      this.requestRender({
        type: 'tile',
        tile,
        priority,
      }).catch(err => {
        console.warn(`[RetryQueue] Retry failed for ${key}:`, err);
      });
      
      retriedCount++;
    }
    
    if (retriedCount > 0) {
      console.log(`[RetryQueue] Queued ${retriedCount} retries, ${this.retryQueue.size} remaining`);
    }
    
    return retriedCount;
  }
  
  /**
   * Clear all entries from the retry queue.
   * Call this on major view changes (zoom, page jump) to avoid retrying stale tiles.
   */
  clearRetryQueue(): void {
    const count = this.retryQueue.size;
    this.retryQueue.clear();
    if (count > 0) {
      console.log(`[RetryQueue] Cleared ${count} entries`);
    }
  }
  
  /**
   * Get retry queue stats for diagnostics.
   */
  getRetryQueueStats(): { size: number; maxSize: number; maxAttempts: number } {
    return {
      size: this.retryQueue.size,
      maxSize: RenderCoordinator.MAX_RETRY_QUEUE_SIZE,
      maxAttempts: RenderCoordinator.MAX_RETRY_ATTEMPTS,
    };
  }

  /**
   * Abort all pending render requests and clear the queue.
   * Call this on major view changes (page jumps, large zoom changes)
   * to prevent wasted work on stale requests.
   */
  abortAllPending(): void {
    // Abort all tracked controllers
    const abortCount = this.abortControllers.size;
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
    this.activeByPosition.clear();
    this.inFlight.clear();
    this.inFlightSessions.clear();

    // Record aborts for diagnostic overlay (amnesia-e4i debugging)
    if (abortCount > 0) {
      for (let i = 0; i < abortCount; i++) {
        try {
          getTileDiagnosticOverlay().recordAbort('abort-all-pending');
        } catch { /* overlay may not be initialized */ }
      }
    }

    // Clear the semaphore queue (resolves all waiters immediately)
    const cleared = this.semaphore.clearQueue();
    if (cleared > 0) {
      console.log(`[RenderCoordinator] Cleared ${cleared} pending requests from queue`);
    }
    
    // amnesia-e4i: Also clear retry queue on major view changes
    this.clearRetryQueue();
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
        const entry = this.activeByPosition.get(positionKey);
        if (entry) {
          entry.controller.abort();
          this.activeByPosition.delete(positionKey);
          this.abortControllers.delete(entry.controller);
          abortedCount++;
          // Record abort for diagnostic overlay (amnesia-e4i debugging)
          try {
            getTileDiagnosticOverlay().recordAbort('stale-session');
          } catch { /* overlay may not be initialized */ }
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
   * Abort all tiles when scale changes significantly (amnesia-rwe).
   *
   * When user zooms rapidly (e.g., 1x → 32x), tiles get requested at many
   * intermediate scales (4, 8, 16, 24, etc.). These fill up the queue and
   * prevent high-res tiles from rendering quickly.
   *
   * Call this when scale changes by > 2x to clear stale-scale tiles.
   *
   * @param newScale The new target scale
   * @param oldScale The previous scale (optional)
   * @returns Number of tiles aborted/cleared
   */
  abortStaleScaleTiles(newScale: number, oldScale?: number): number {
    // Only clear if scale changed significantly (> 2x ratio)
    if (oldScale !== undefined) {
      const ratio = Math.max(newScale / oldScale, oldScale / newScale);
      if (ratio < 2) {
        return 0; // Scale didn't change enough to warrant clearing
      }
    }

    let abortedCount = 0;

    // 1. Abort in-flight requests at different scales
    for (const [posKey, entry] of this.activeByPosition) {
      // Allow 50% tolerance for scale match (e.g., 64 matches 48-96)
      const scaleDiff = Math.abs(entry.scale - newScale) / newScale;
      if (scaleDiff > 0.5) {
        entry.controller.abort();
        this.activeByPosition.delete(posKey);
        this.abortControllers.delete(entry.controller);
        abortedCount++;
      }
    }

    // 2. Clear the entire semaphore queue if we aborted any in-flight
    // This is aggressive but necessary - queued tiles are likely stale-scale too
    if (abortedCount > 0) {
      const queuedCount = this.semaphore.clearQueue();
      console.log(`[amnesia-rwe] Scale change ${oldScale?.toFixed(0) ?? '?'} → ${newScale.toFixed(0)}: ` +
        `aborted ${abortedCount} in-flight, cleared ${queuedCount} queued`);
      abortedCount += queuedCount;
    }

    // 3. Clear retry queue too
    this.clearRetryQueue();

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
    // amnesia-aqv FIX: Increased tolerance at high scale to let tiles complete.
    // Previous values (8/6/4/3) were too aggressive - tiles at scale 16+ take
    // 800-1200ms to render, but 8 sessions × 32ms = 256ms tolerance meant
    // tiles were aborted before completion, causing permanent blurry fallbacks.
    //
    // With focal-point priority now active, critical tiles (center) get
    // rendered first, so we can afford longer tolerance without queue saturation.
    // The priority queue ensures important tiles complete even if edge tiles
    // are eventually dropped.
    //
    // Tile render times (from profiling):
    // - Scale 2-4: ~100-200ms per tile
    // - Scale 4-8: ~300-500ms per tile  
    // - Scale 8-16: ~500-800ms per tile
    // - Scale 16+: ~800-1200ms per tile
    //
    // Sessions created every 32ms during scroll.
    // keepRecent × 32ms = tolerance window.
    if (scale >= 16) return 40;  // Scale 16+: ~1280ms tolerance (matches render time)
    if (scale >= 8) return 20;   // Scale 8-15: ~640ms tolerance
    if (scale >= 4) return 10;   // Scale 4-7: ~320ms tolerance
    return 5;                     // Scale < 4: ~160ms tolerance
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
    
    // amnesia-xlc.3: Also wire the JPEG callback to TileCacheManager for tile slicing
    getTileCacheManager().setExtractJpegCallback(callbacks.extractJpeg);
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
   * Get content-type callback state for diagnostics (amnesia-xlc.1).
   * 
   * Returns detailed state about the content-type detection system
   * for validation and debugging.
   */
  getContentTypeCallbackState(): {
    detectionEnabled: boolean;
    classifyCallbackWired: boolean;
    extractJpegCallbackWired: boolean;
    documentId: string | null;
    classificationsInFlight: number;
  } {
    return {
      detectionEnabled: this.contentTypeDetectionEnabled,
      classifyCallbackWired: this.classifyPageCallback !== null,
      extractJpegCallbackWired: this.extractJpegCallback !== null,
      documentId: this.documentId,
      classificationsInFlight: this.classificationInFlight.size,
    };
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

    // Check cache (skip if debug tiles are enabled)
    if (request.type === 'tile' && !isDebugTileModeEnabled()) {
      // First try exact scale match
      const cached = await getTileCacheManager().get(request.tile);
      if (cached) {
        // Track cache hit for T2HR measurement
        // Exact cache match means tile.scale === requested scale (highest-res)
        const t2hrTracker = getT2HRTracker();
        const focalTracker = getFocalPointTracker();
        const isFocal = request.priority === 'critical' || request.priority === 'high';
        
        t2hrTracker.onTileComplete({
          tile: request.tile,
          actualScale: request.tile.scale, // Exact match = requested scale
          priority: request.priority,
          isFocalTile: isFocal,
          isFallback: false, // Exact cache hit is NOT a fallback
          pipelineTiming: { total: 0 }, // Instant from cache
        });
        
        focalTracker.recordTileCompletion({
          tileKey: `${request.tile.page}-${request.tile.tileX}-${request.tile.tileY}`,
          priority: request.priority,
          wasSharp: true, // Exact cache hit is always at requested scale
        });
        
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

          // Track fallback for T2HR - this is NOT highest-res
          const t2hrTracker = getT2HRTracker();
          const focalTracker = getFocalPointTracker();
          const isFocal = request.priority === 'critical' || request.priority === 'high';
          
          t2hrTracker.onTileComplete({
            tile: request.tile,
            actualScale: fallback.actualScale, // Actual scale of fallback (lower than requested)
            priority: request.priority,
            isFocalTile: isFocal,
            isFallback: true, // This IS a fallback
            pipelineTiming: { total: 0 }, // Instant from cache
          });
          
          focalTracker.recordTileCompletion({
            tileKey: `${request.tile.page}-${request.tile.tileX}-${request.tile.tileY}`,
            priority: request.priority,
            wasSharp: false, // Fallback is NOT sharp
          });

          // Return fallback immediately for display
          // amnesia-e4i: Include fallbackTile for correct compositing position
          return {
            success: true,
            data: fallback.bitmap,
            fromCache: true,
            isFallback: true,
            actualScale: fallback.actualScale,
            cssStretch: fallback.cssStretch,
            fallbackTile: fallback.fallbackTile,
          };
        }
      }
    }

    // amnesia-d9f FIX: Only abort existing render if scale is DIFFERENT.
    // 
    // PROBLEM: During continuous zoom at max scale (32x), the viewport shifts slightly
    // causing new tile requests for tiles already being rendered at the SAME scale.
    // The old logic aborted these in-progress renders to start new ones, causing
    // 10-15% tile loss and visual corruption.
    //
    // FIX: Check if existing render is at same scale. If so, let it continue.
    // The in-flight deduplication (line 794) should catch most duplicates, but
    // there's a race window between setting activeByPosition and inFlight.
    const newScale = request.type === 'tile' ? request.tile.scale : request.scale;
    const existingEntry = this.activeByPosition.get(positionKey);
    if (existingEntry) {
      const existingScale = existingEntry.scale;
      if (existingScale !== newScale) {
        // Different scale - abort old render (e.g., zooming from 16x to 32x)
        existingEntry.controller.abort();
        this.activeByPosition.delete(positionKey);
        this.abortControllers.delete(existingEntry.controller);
        console.warn(`[POSITION-ABORT] Aborting existing render at ${positionKey} (scale ${existingScale}→${newScale})`);
        // Record abort for diagnostic overlay (amnesia-e4i debugging)
        try {
          getTileDiagnosticOverlay().recordAbort(`scale-change:${existingScale}→${newScale}`);
        } catch { /* overlay may not be initialized */ }
      } else {
        // Same scale - let the existing render continue, return its promise
        // This handles the race condition where inFlight wasn't set yet
        // Note: Removed verbose logging as this is normal behavior during continuous zoom
        // Try to return the in-flight promise if it exists now
        const inFlightPromise = this.inFlight.get(key);
        if (inFlightPromise) {
          return inFlightPromise;
        }
        // If no in-flight promise yet, we're in the race window
        // Create a small delay to let the first request finish setting up
        // This is a defensive measure - shouldn't happen often
      }
    }

    // Create abort controller for this request if not provided
    const controller = request.abortController ?? new AbortController();
    request.abortController = controller;

    // Track abort controller with scale
    this.abortControllers.add(controller);
    this.activeByPosition.set(positionKey, { controller, scale: newScale });

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
      const currentEntry = this.activeByPosition.get(positionKey);
      if (currentEntry && currentEntry.controller === controller) {
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
   * Get the current queue size (number of waiting render requests)
   * Used by amnesia-xc0 to determine when to trigger page refresh
   */
  getQueueSize(): number {
    return this.semaphore.waiting;
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
    // Note: Use `number` type since TILE PIXEL CAP may reduce below tier values
    let scale: number = getTargetScaleTier(zoom, pixelRatio).tier;

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

    // TILE PIXEL CAP FIX (amnesia-d9f): Apply same cap as renderPageTiled.
    // With 512px tiles at scale 32, each tile would be 16384px which exceeds GPU limits.
    // Cap scale so tile pixels ≤ MAX_TILE_PIXELS.
    //
    // MEMORY FIX (amnesia-e4i): Reduced from 8192 to 4096.
    // At 8192: 128px tile × scale 64 = 8192px = 256MB per tile (causes 7+ second render times)
    // At 4096: 128px tile × scale 32 = 4096px = 64MB per tile (much faster rendering)
    // This means zoom 32x will have cssStretch=2x (slight blur) but remains responsive.
    const MAX_TILE_PIXELS = 4096;
    const tileSize = getTileSize(zoom);
    const maxScaleForTileSize = Math.floor(MAX_TILE_PIXELS / tileSize);
    scale = Math.min(scale, maxScaleForTileSize);

    return scale;
  }

  // Private helpers

  // DIAGNOSTIC (amnesia-d9f): Track abort patterns
  private static abortedBeforeAcquire = 0;
  private static abortedAfterAcquire = 0;
  private static droppedFromQueue = 0;
  private static lastAbortLogTime = 0;

  private logAbortStats(reason: string): void {
    const now = performance.now();
    // Rate-limit abort logging to once per 2 seconds to avoid console spam
    if (now - RenderCoordinator.lastAbortLogTime > 2000) {
      RenderCoordinator.lastAbortLogTime = now;
      console.warn(`[ABORT-STATS] ${reason}: beforeAcquire=${RenderCoordinator.abortedBeforeAcquire}, afterAcquire=${RenderCoordinator.abortedAfterAcquire}, dropped=${RenderCoordinator.droppedFromQueue}`);
    }
  }

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
      RenderCoordinator.abortedBeforeAcquire++;
      this.logAbortStats('pre-acquire abort');
      if (request.type === 'tile') {
        const fallback = await getTileCacheManager().getBestAvailableBitmap(request.tile);
        if (fallback) {
          // amnesia-e4i: Include fallbackTile for correct compositing position
          return {
            success: true,
            data: fallback.bitmap,
            fromCache: true,
            isFallback: true,
            actualScale: fallback.actualScale,
            cssStretch: fallback.cssStretch,
            fallbackTile: fallback.fallbackTile,
          };
        }
      }
      return { success: false, error: 'Aborted', fromCache: false };
    }

    // DEBUG TILES FAST PATH: Skip semaphore for debug tiles since they render instantly
    if (isDebugTileModeEnabled() && request.type === 'tile') {
      const tileSize = getTileSize(request.tile.scale);
      // Gather debug info to stamp on tile
      const debugInfo = {
        zoom: (request as any).zoom,
        epoch: request.scaleEpoch,
        priority: request.priority,
        cssStretch: request.cssStretch,
        requestedScale: (request as any).requestedScale,
        renderMode: this.currentMode,
      };
      const debugBlob = await generateDebugTileSvg(request.tile, tileSize, request.tile.scale, debugInfo);
      const bitmap = await createImageBitmap(debugBlob);
      console.log(`[DEBUG-TILE-FAST] page=${request.tile.page}, (${request.tile.tileX},${request.tile.tileY}), scale=${request.tile.scale}, zoom=${debugInfo.zoom?.toFixed(1)}, epoch=${debugInfo.epoch}`);
      return { success: true, data: bitmap, fromCache: false };
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
      RenderCoordinator.droppedFromQueue++;
      this.logAbortStats('dropped from queue');
      
      // amnesia-e4i: Add to retry queue for later processing
      // BUT NOT when queue is saturated - that creates an infinite loop!
      // If the queue is nearly full, tiles will just get dropped again immediately.
      const queueSaturation = this.semaphore.waiting / this.currentPolicy.maxQueueSize;
      const shouldRetry = request.type === 'tile' && queueSaturation < 0.8; // Only retry if queue < 80% full
      
      if (shouldRetry) {
        this.addToRetryQueue(request.tile, request.priority);
      }
      
      // FALLBACK FIX: Even when dropped from queue, try to return a cached fallback tile
      if (request.type === 'tile') {
        const fallback = await getTileCacheManager().getBestAvailableBitmap(request.tile);
        if (fallback) {
          // amnesia-e4i: Include fallbackTile for correct compositing position
          return {
            success: true,
            data: fallback.bitmap,
            fromCache: true,
            isFallback: true,
            actualScale: fallback.actualScale,
            cssStretch: fallback.cssStretch,
            fallbackTile: fallback.fallbackTile,
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
        RenderCoordinator.abortedAfterAcquire++;
        this.logAbortStats('post-acquire abort');
        if (request.type === 'tile') {
          const fallback = await getTileCacheManager().getBestAvailableBitmap(request.tile);
          if (fallback) {
            // amnesia-e4i: Include fallbackTile for correct compositing position
            return {
              success: true,
              data: fallback.bitmap,
              fromCache: true,
              isFallback: true,
              actualScale: fallback.actualScale,
              cssStretch: fallback.cssStretch,
              fallbackTile: fallback.fallbackTile,
            };
          }
        }
        return { success: false, error: 'Aborted', fromCache: false };
      }

      let blob: Blob | null = null;
      let cachedData: CachedTileData | null = null;
      // VECTOR OPTIMIZATION FIX (amnesia-e4i): Hoist vectorOptimization to outer scope
      // so it can be included in return values at the end of executeRequest.
      let vectorOptimization: OptimizedRenderParams | null = null;

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

        const contentTypeEnabled = this.isContentTypeDetectionEnabled();

        if (contentTypeEnabled) {
          const classification = await this.getPageClassification(pageNum);
          if (classification) {
            const strategy = getRenderStrategy(classification);

            // Track classification telemetry
            getTelemetry().trackCustomMetric(`render_contentType_${classification.type}`, 1);

            // SCANNED_JPEG fast path: JPEG tile slicing (amnesia-xlc.3)
            // For scanned PDFs, extract the embedded JPEG once, cache it, then slice
            // tiles from the cached decoded image. This is much faster than WASM rendering.
            //
            // The old approach extracted the full-page JPEG and cached it under tile keys,
            // causing the "checkerboard" visual bug. The new approach properly slices
            // the tile region from the cached full-page decoded ImageData.
            const JPEG_EXTRACTION_ENABLED_FOR_TILES = isFeatureEnabled('useJpegTileSlicing');
            if (
              JPEG_EXTRACTION_ENABLED_FOR_TILES &&
              strategy.useDirectExtraction &&
              classification.type === PDFContentType.SCANNED_JPEG &&
              getTileCacheManager().canUseJpegSlicing(pageNum)
            ) {
              try {
                const jpegStartTime = performance.now();
                const jpegTile = await getTileCacheManager().getJpegTile(
                  request.tile,
                  getTileSize(request.tile.scale)
                );
                const jpegDuration = performance.now() - jpegStartTime;

                if (jpegTile) {
                  cachedData = jpegTile;
                  usedFastPath = true;

                  // Track fast path telemetry
                  getTelemetry().trackCustomMetric('jpegTileSlice_count', 1);
                  getTelemetry().trackCustomMetric('jpegTileSlice_time', jpegDuration);
                }
              } catch (error) {
                // Fall back to standard rendering - don't log to avoid spam
                getTelemetry().trackCustomMetric('jpegTileSlice_fallback', 1);
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

          // DEBUG TILES: Generate colored PNG tiles for visual debugging
          // Check both feature flag AND runtime debug mode
          if (isFeatureEnabled('useDebugTiles') || isDebugTileModeEnabled()) {
            const tileSize = getTileSize(tileToRender.scale);
            const debugBlob = await generateDebugTileSvg(tileToRender, tileSize, request.tile.scale);
            blob = debugBlob;
            cachedData = { format: 'png', blob, width: tileSize, height: tileSize };
            console.log(`[DEBUG-TILE] Generated debug tile: page=${tileToRender.page}, (${tileToRender.tileX},${tileToRender.tileY}), scale=${tileToRender.scale}, targetScale=${request.tile.scale}`);
          } else {
            const result = await this.renderTileCallback(tileToRender, this.documentId);

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
        }

        // Cache the result
        // Use content type's cache priority to influence tier selection:
        // - 'high' priority (TEXT_HEAVY, SCANNED) → prefer L1 for faster retrieval
        // - 'low' priority (COMPLEX) → demote to L2/L3
        // - 'normal' → use request priority as before
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
          
          // Track tile completion for T2HR and focal-point analysis
          const t2hrTracker = getT2HRTracker();
          const focalTracker = getFocalPointTracker();
          
          // For fresh renders, actualScale = requested scale (we rendered at full quality)
          // Vector optimization may use a lower internal scale with CSS upscaling
          const actualScale = vectorOptimization?.wasOptimized 
            ? vectorOptimization.actualScale 
            : request.tile.scale;
          
          // Record for T2HR measurement
          t2hrTracker.onTileComplete({
            tile: request.tile,
            actualScale, // Actual scale we rendered at
            priority: request.priority,
            isFocalTile: request.priority === 'critical' || request.priority === 'high',
            isFallback: false, // Fresh render is NOT a fallback
            pipelineTiming: {
              total: performance.now() - startTime,
              // Note: Individual stage timings would need to be passed from worker
            },
          });
          
          // Record for focal-point tracking
          // Sharp = rendered at requested scale (not a downscaled fallback)
          focalTracker.recordTileCompletion({
            tileKey: key,
            priority: request.priority,
            wasSharp: actualScale >= request.tile.scale * 0.9,
          });
          
          // amnesia-xc0: Trigger onTileReady callback with scaleEpoch for epoch-gated compositing.
          // The epoch allows PdfInfiniteCanvas to validate that tiles are compatible
          // with the current canvas render state before drawing them.
          //
          // amnesia-e4i.1 FIX: Skip callback during active/settling gestures to prevent
          // callback storm that overwhelms the renderer. Tiles rendered during gestures
          // are likely stale anyway (viewport is constantly changing).
          // Only trigger callbacks during 'rendering' and 'idle' phases.
          const gesturePhase = getGesturePhase();
          const shouldTriggerCallback = 
            this.onTileReady && 
            request.priority !== 'low' &&
            (gesturePhase === 'rendering' || gesturePhase === 'idle');
          
          if (shouldTriggerCallback && this.onTileReady) {
            try {
              const epoch = request.scaleEpoch ?? 0;
              this.onTileReady(request.tile.page, request.priority, epoch);
            } catch (err) {
              console.warn('[RenderCoordinator] onTileReady callback error:', err);
            }
          }
          
        }
      } else {
        // ========== Full-Page Render Path ==========
        // Full-page renders are used at low zoom levels (< tiling threshold).
        // This path now has full cache integration (previously missing).
        // amnesia-xlc.2: Added content-type detection for JPEG extraction optimization.
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

        // ========== Content-Type Aware Full-Page Rendering (amnesia-xlc.2) ==========
        // For scanned PDFs (single JPEG per page), extract JPEG directly instead of
        // rendering via MuPDF. This is 60-80% faster for scanned documents.
        let usedJpegExtraction = false;
        const fullPageContentTypeEnabled = this.isContentTypeDetectionEnabled();
        
        if (fullPageContentTypeEnabled && this.extractJpegCallback) {
          const classification = await this.getPageClassification(request.page);
          if (classification?.type === PDFContentType.SCANNED_JPEG) {
            try {
              const jpegStartTime = performance.now();
              const jpegData = await this.extractJpegCallback(this.documentId, request.page);
              const jpegDuration = performance.now() - jpegStartTime;
              
              // Create blob from JPEG data
              const jpegCopy = new Uint8Array(jpegData.data);
              const jpegBlob = new Blob([jpegCopy], { type: 'image/jpeg' });
              blob = jpegBlob;
              usedJpegExtraction = true;
              
              // Track telemetry - estimate time saved vs MuPDF render
              // Typical full-page render takes 200-500ms, JPEG extraction takes 20-50ms
              const estimatedMuPDFTime = 300; // Conservative estimate
              const timeSaved = Math.max(0, estimatedMuPDFTime - jpegDuration);
              getTelemetry().trackJpegExtraction(jpegData.data.length, timeSaved);
              getTelemetry().trackCustomMetric('jpegExtraction_count', 1);
              getTelemetry().trackCustomMetric('jpegExtraction_time', jpegDuration);
              getTelemetry().trackCustomMetric('fullPageJpegExtraction', 1);
              
              console.log(
                `[RenderCoordinator] Full-page JPEG extraction for page ${request.page}: ` +
                `${jpegDuration.toFixed(1)}ms (est. ${timeSaved.toFixed(0)}ms saved)`
              );
            } catch (error) {
              // Fall back to standard rendering
              console.warn(
                `[RenderCoordinator] Full-page JPEG extraction failed for page ${request.page}, falling back:`,
                error
              );
            }
          } else if (classification) {
            // Track classification for non-JPEG pages
            getTelemetry().trackCustomMetric(`fullPage_contentType_${classification.type}`, 1);
          }
        }

        // Standard rendering path (if JPEG extraction not used or failed)
        if (!usedJpegExtraction) {
          console.log(`[RenderCoordinator] Full-page render for page ${request.page} at scale ${request.scale}`);
          blob = await this.renderPageCallback(
            request.page,
            request.scale,
            this.documentId
          );
        }

        // Cache the result for future use
        if (blob) {
          const fullPageCacheData: CachedTileData = {
            format: usedJpegExtraction ? 'png' : 'png', // Both stored as blob
            blob,
            width: 0, // Unknown for full-page
            height: 0,
          };
          const tier = request.priority === 'critical' ? 'L1' : 'L2';
          await cacheManager.setFullPage(request.page, request.scale, fullPageCacheData, tier);
          console.log(`[RenderCoordinator] Full-page cached at ${tier} for page ${request.page}${usedJpegExtraction ? ' (JPEG extracted)' : ''}`);
        }
      }

      // Track render time
      const duration = performance.now() - startTime;
      getTelemetry().trackRenderTime(
        duration,
        request.type === 'tile' ? 'tile' : 'page'
      );

      // Return data - prefer ImageBitmap for raw RGBA, otherwise Blob
      // VECTOR OPTIMIZATION FIX (amnesia-e4i): Include actualScale and cssStretch in result
      // when vector optimization was applied. This allows compositing to use correct
      // positioning even when tiles were rendered at a different scale than requested.
      const baseResult: Partial<RenderResult> = {
        success: true,
        fromCache: false,
        // Include vector optimization info if applicable
        ...(vectorOptimization?.wasOptimized && request.type === 'tile' ? {
          actualScale: vectorOptimization.actualScale,
          cssStretch: vectorOptimization.cssScaleFactor,
        } : {}),
      };

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
        return { ...baseResult, data: bitmap } as RenderResult;
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
        return { ...baseResult, data: bitmap } as RenderResult;
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
      //
      // amnesia-e4i FIX: Include tileSize in request key. Tiles with different
      // tileSizes cover different PDF regions (even with same indices), so they
      // must not be deduplicated together.
      const qScale = quantizeScale(t.scale);
      const tileSize = t.tileSize ?? 256;
      return `${docPrefix}tile-p${t.page}-t${t.tileX}x${t.tileY}-s${qScale}-ts${tileSize}`;
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
    // amnesia-e4i Phase 4: Use device-detected concurrency
    const permits = getEffectiveConcurrency();
    console.log(`[RenderCoordinator] Initializing with ${permits} permits`);
    coordinatorInstance = new RenderCoordinator({ maxConcurrent: permits });
    
    // amnesia-xlc.3: Set JPEG cache memory budget based on device memory
    // Use the same detection as concurrency to get system RAM
    const memoryGB = getDeviceMemoryGB();
    getTileCacheManager().setJpegCacheMemoryBudget(memoryGB);
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

// ============================================================
// Device-Aware Concurrency (amnesia-e4i Phase 4)
// ============================================================

/**
 * Concurrency configuration for A/B testing.
 */
export interface ConcurrencyConfig {
  /** Number of concurrent render permits */
  permits: number;
  /** How the value was determined */
  source: 'device-detected' | 'user-configured' | 'default';
}

// Cached device-detected concurrency
let deviceConcurrency: number | null = null;

// Cached device memory in GB
let cachedDeviceMemoryGB: number | null = null;

// User-configured override (null = use device detection)
let userConcurrencyOverride: number | null = null;

/**
 * Get device memory in gigabytes (cached).
 * Uses navigator.deviceMemory on Chrome, falls back to os.totalmem in Electron.
 */
export function getDeviceMemoryGB(): number {
  if (cachedDeviceMemoryGB !== null) {
    return cachedDeviceMemoryGB;
  }
  
  let detected = 8; // Default fallback
  
  // Try navigator.deviceMemory (Chrome-only)
  if (typeof navigator !== 'undefined' && (navigator as any).deviceMemory) {
    detected = (navigator as any).deviceMemory;
  } else {
    // Try Node.js os.totalmem (Electron/Node)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require('os');
      if (os && typeof os.totalmem === 'function') {
        detected = os.totalmem() / (1024 * 1024 * 1024);
      }
    } catch {
      // Not in Node.js environment
    }
  }
  
  cachedDeviceMemoryGB = detected;
  return cachedDeviceMemoryGB;
}

/**
 * Detect optimal concurrency based on device capabilities.
 * 
 * Heuristics:
 * - Uses navigator.hardwareConcurrency (CPU cores)
 * - Uses navigator.deviceMemory (RAM in GB, Chrome only)
 * - Clamps between 2 and 8 permits
 * 
 * @returns Optimal number of concurrent renders
 */
export function detectDeviceConcurrency(): number {
  if (deviceConcurrency !== null) {
    return deviceConcurrency;
  }
  
  const cores = typeof navigator !== 'undefined' 
    ? navigator.hardwareConcurrency || 4 
    : 4;
    
  // navigator.deviceMemory is Chrome-only, returns RAM in GB
  const memoryGB = typeof navigator !== 'undefined'
    ? (navigator as any).deviceMemory || 4
    : 4;
    
  // Heuristics:
  // - 8+ cores and 8+ GB RAM: 8 permits (high-end desktop/laptop)
  // - 4-7 cores or 4-7 GB RAM: 6 permits (mid-range)
  // - 2-3 cores or <4 GB RAM: 4 permits (low-end/mobile)
  // - 1 core: 2 permits (very low-end)
  
  let permits: number;
  if (cores >= 8 && memoryGB >= 8) {
    permits = 8;
  } else if (cores >= 4 && memoryGB >= 4) {
    permits = 6;
  } else if (cores >= 2) {
    permits = 4;
  } else {
    permits = 2;
  }
  
  console.log(`[DEVICE-CONCURRENCY] Detected: cores=${cores}, memory=${memoryGB}GB → permits=${permits}`);
  deviceConcurrency = permits;
  return permits;
}

/**
 * Get the current concurrency configuration.
 */
export function getConcurrencyConfig(): ConcurrencyConfig {
  if (userConcurrencyOverride !== null) {
    return { permits: userConcurrencyOverride, source: 'user-configured' };
  }
  return { permits: detectDeviceConcurrency(), source: 'device-detected' };
}

/**
 * Set the concurrency override for A/B testing.
 * 
 * @param permits Number of permits (2-12), or null to use device detection
 * @example
 * // Test with 8 concurrent renders
 * window.amnesiaConcurrency.setPermits(8);
 * // Then reload the PDF to see effect
 */
export function setConcurrencyOverride(permits: number | null): void {
  if (permits !== null) {
    permits = Math.max(2, Math.min(12, permits)); // Clamp between 2-12
  }
  userConcurrencyOverride = permits;
  console.log(`[CONCURRENCY] Override set to: ${permits ?? 'device-detected'}`);
  
  // Note: Existing coordinator will continue using old value.
  // User needs to reload PDF for change to take effect.
  // To apply immediately, we'd need to expose semaphore.setPermits()
}

/**
 * Get the effective concurrency (used when creating coordinator).
 */
export function getEffectiveConcurrency(): number {
  const config = getConcurrencyConfig();
  return config.permits;
}

// Expose concurrency configuration API to window for A/B testing
if (typeof window !== 'undefined') {
  (window as any).amnesiaConcurrency = {
    /**
     * Get the current concurrency configuration.
     * @returns Object with permits and source
     */
    getConfig: getConcurrencyConfig,
    
    /**
     * Get device-detected concurrency (ignoring overrides).
     * @returns Number of detected permits
     */
    detectDevice: detectDeviceConcurrency,
    
    /**
     * Set concurrency override for A/B testing.
     * @param permits Number of permits (2-12), or null to use device detection
     * @example
     * // Test with 8 concurrent renders
     * window.amnesiaConcurrency.setPermits(8);
     */
    setPermits: setConcurrencyOverride,
    
    /**
     * Clear the override and use device detection.
     */
    clearOverride: () => setConcurrencyOverride(null),
    
    /**
     * Log current configuration info to console.
     */
    info: () => {
      const config = getConcurrencyConfig();
      console.log('[CONCURRENCY] Current config:', config);
      console.log('[CONCURRENCY] Device-detected:', detectDeviceConcurrency());
      console.log('[CONCURRENCY] User override:', userConcurrencyOverride);
    },
  };
}

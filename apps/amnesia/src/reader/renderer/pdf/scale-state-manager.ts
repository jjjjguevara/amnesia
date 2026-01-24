/**
 * Scale State Manager
 *
 * Central source of truth for all scale-related state, eliminating the 7+
 * distributed scale calculation locations that cause temporal race conditions
 * where tiles in the same batch arrive at different scales.
 *
 * Architecture (LLM Council Approved - 95% confidence):
 * - Parallel to ZoomStateManager (NOT child/extension)
 * - ZoomStateManager = UX domain (continuous, user-driven zoom gestures)
 * - ScaleStateManager = Render domain (discrete, quantized, resource-driven scale)
 *
 * Key Features:
 * - Single canonical scale value derived from zoom
 * - Epoch-based tile validation (stale tiles are discarded)
 * - Gesture-phase awareness (committed vs pending scales)
 * - Atomic snapshots for async tile operations
 * - cssStretch consolidation (eliminates 5+ distributed calculations)
 *
 * Invariant INV-6: Scale/Layout Atomicity
 * A render batch MUST use a single renderParams identity for both tile
 * generation AND grid layout.
 *
 * @example
 * ```typescript
 * // Create manager with ZoomStateManager for internal subscription
 * const scaleManager = createScaleStateManager(zoomManager, {
 *   pixelRatio: 2,
 *   maxZoom: 32,
 * });
 *
 * // Get snapshot for async tile request
 * const snapshot = scaleManager.captureSnapshot();
 *
 * // Validate before displaying tile
 * if (scaleManager.validateEpoch(tile.scaleEpoch)) {
 *   displayTile(tile);
 * }
 * ```
 */

import type { ZoomState, ZoomStateManager as ZoomManagerType } from './zoom-state-manager';
import type { Point } from './pdf-canvas-camera';
import type { RenderPriority } from './render-coordinator';
import type { TileCoordinate } from './tile-render-engine';
import {
  SCALE_TIERS,
  type ScaleTier,
  getTargetScaleTier,
  getExactTargetScale,
  getDynamicMaxScaleTier,
} from './progressive-tile-renderer';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type ScaleMode = 'tier' | 'exact';
export type RenderMode = 'full-page' | 'adaptive' | 'tiled';
export type GesturePhase = 'idle' | 'active' | 'settling';
export type QualityFalloffMode = 'none' | 'linear' | 'quadratic';

export { SCALE_TIERS, type ScaleTier };

/**
 * Render parameters identity - hash for equality checks across tile batches.
 */
export interface RenderParamsId {
  readonly scaleEpoch: number;
  readonly scale: number;
  readonly dpr: number;
  readonly renderMode: RenderMode;
}

/**
 * Full scale state for consumers.
 */
export interface ScaleState {
  readonly scale: number;
  readonly epoch: number;
  readonly renderMode: RenderMode;
  readonly scaleMode: ScaleMode;
  readonly cssStretch: number;
  readonly scaleTier: ScaleTier | null;
  readonly gesturePhase: GesturePhase;
  /** Frozen at gesture START - use during active gesture for stable rendering */
  readonly committedScale: number;
  /** Scale at current zoom - may change during gesture */
  readonly pendingScale: number;
  /** Render mode frozen at gesture START - use during active gesture (amnesia-wbp) */
  readonly committedRenderMode: RenderMode;
  /** Render mode at current zoom - may change during gesture (amnesia-wbp) */
  readonly pendingRenderMode: RenderMode;
}

/**
 * Lightweight snapshot for async operations (tile requests).
 * Captured at request time, validated at display time.
 */
export interface ScaleSnapshot {
  readonly scale: number;
  readonly epoch: number;
  readonly dpr: number;
  readonly renderMode: RenderMode;
  readonly cssStretch: number;
  /** Hash for equality checks */
  readonly renderParamsId: string;
}

/**
 * Per-tile quality parameters for spatial multi-resolution rendering.
 */
export interface TileQualityParams {
  readonly scale: number;
  readonly cssStretch: number;
  readonly priority: RenderPriority;
  /** Quality factor 0.0-1.0 (1.0 = full quality at focal point) */
  readonly qualityFactor: number;
}

/**
 * Focal point state for radial priority/quality calculations.
 */
export interface FocalPointState {
  readonly point: Point | null;
  readonly capturedAt: number;
  readonly gestureType: 'zoom' | 'pan' | 'idle';
}

/**
 * Configuration for ScaleStateManager.
 */
export interface ScaleStateManagerConfig {
  /** Device pixel ratio */
  pixelRatio: number;
  /** Maximum zoom level (for computing max scale) */
  maxZoom: number;
  /** Scale quantization mode (default: 'tier') */
  scaleMode?: ScaleMode;
  /** Maximum epoch increment rate (Hz, default: 60) */
  maxEpochRate?: number;
  /** Quality falloff mode (default: 'none') */
  qualityFalloff?: QualityFalloffMode;
  /** Falloff radius in CSS pixels (default: 1024) */
  falloffRadius?: number;
}

// ─────────────────────────────────────────────────────────────────
// Render Mode Thresholds
// ─────────────────────────────────────────────────────────────────

/** Thresholds for render mode transitions with hysteresis */
const RENDER_MODE_THRESHOLDS = {
  /** Zoom level where full-page → adaptive transition occurs */
  FULL_TO_ADAPTIVE: 1.5,
  /** Zoom level where adaptive → tiled transition occurs */
  ADAPTIVE_TO_TILED: 4.0,
  /** Upper bound for tiled mode - above this, revert to full-page (amnesia-wbp) */
  MAX_TILED_ZOOM: 64.0,
  /** Hysteresis band to prevent oscillation at boundaries (10%) */
  HYSTERESIS: 0.1,
} as const;

// ─────────────────────────────────────────────────────────────────
// ScaleStateManager
// ─────────────────────────────────────────────────────────────────

/**
 * Central scale state manager - single source of truth for all scale decisions.
 */
export class ScaleStateManager {
  private state: ScaleState;
  private config: ScaleStateManagerConfig;
  private listeners: Set<(state: ScaleState) => void> = new Set();

  /** Focal point for radial priority/quality (Phase 6-9) */
  private focalPoint: FocalPointState = {
    point: null,
    capturedAt: 0,
    gestureType: 'idle',
  };

  /** Last epoch increment timestamp for rate limiting */
  private lastEpochTime: number = 0;

  /** Unsubscribe function for ZoomStateManager subscription */
  private unsubscribeZoom: (() => void) | null = null;

  constructor(
    zoomManager: ZoomManagerType,
    config: ScaleStateManagerConfig
  ) {
    this.config = {
      scaleMode: 'tier',
      maxEpochRate: 60,
      qualityFalloff: 'none',
      falloffRadius: 1024,
      ...config,
    };

    // Initialize state at zoom=1
    const initialScale = this.calculateScale(1);
    const initialCssStretch = this.calculateCssStretch(1, initialScale);

    this.state = {
      scale: initialScale,
      epoch: 0,
      renderMode: 'full-page',
      scaleMode: this.config.scaleMode!,
      cssStretch: initialCssStretch,
      scaleTier: this.findNearestTier(initialScale),
      gesturePhase: 'idle',
      committedScale: initialScale,
      pendingScale: initialScale,
      committedRenderMode: 'full-page',
      pendingRenderMode: 'full-page',
    };

    // Subscribe to ZoomStateManager (internal - council requirement)
    this.unsubscribeZoom = zoomManager.subscribe((zoomState) => {
      this.syncFromZoomState(zoomState);
    });

    console.log('[ScaleStateManager] Initialized:', {
      scale: this.state.scale,
      cssStretch: this.state.cssStretch,
      renderMode: this.state.renderMode,
      pixelRatio: config.pixelRatio,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Read API - All consumers use these
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get the current canonical scale.
   */
  getScale(): number {
    return this.state.scale;
  }

  /**
   * Get the current epoch counter.
   */
  getEpoch(): number {
    return this.state.epoch;
  }

  /**
   * Get the current render mode.
   */
  getRenderMode(): RenderMode {
    return this.state.renderMode;
  }

  /**
   * Get the current gesture phase.
   */
  getGesturePhase(): GesturePhase {
    return this.state.gesturePhase;
  }

  /**
   * Get the committed scale (frozen at gesture start).
   * Use this during active gestures for stable tile rendering.
   */
  getCommittedScale(): number {
    return this.state.committedScale;
  }

  /**
   * Get the committed render mode (frozen at gesture start).
   * Use this during active gestures to prevent mode flapping (amnesia-wbp).
   */
  getCommittedRenderMode(): RenderMode {
    return this.state.committedRenderMode;
  }

  /**
   * Get the pending render mode (may change during gesture).
   * The actual mode at current zoom level.
   */
  getPendingRenderMode(): RenderMode {
    return this.state.pendingRenderMode;
  }

  /**
   * Get the effective render mode for rendering decisions.
   * During active gesture, returns committed mode for stability.
   * Otherwise, returns current mode.
   */
  getEffectiveRenderMode(): RenderMode {
    if (this.state.gesturePhase === 'active') {
      return this.state.committedRenderMode;
    }
    return this.state.renderMode;
  }

  /**
   * Check if currently in tiled rendering mode.
   * Uses effective mode (committed during gesture, current otherwise).
   * This simplifies pdf-infinite-canvas which only cares about tiled vs non-tiled.
   */
  isTiledMode(): boolean {
    return this.getEffectiveRenderMode() === 'tiled';
  }

  /**
   * Get the current CSS stretch factor.
   */
  getCssStretch(): number {
    return this.state.cssStretch;
  }

  /**
   * Get the full scale state.
   */
  getState(): ScaleState {
    return { ...this.state };
  }

  /**
   * Capture a snapshot for async operations (tile requests).
   * This should be called at request time; validate at display time.
   */
  captureSnapshot(): ScaleSnapshot {
    const renderParamsId = this.computeRenderParamsId();

    return {
      scale: this.state.scale,
      epoch: this.state.epoch,
      dpr: this.config.pixelRatio,
      renderMode: this.state.renderMode,
      cssStretch: this.state.cssStretch,
      renderParamsId,
    };
  }

  /**
   * Validate that a tile's epoch matches current state.
   *
   * @param epoch The epoch from the tile render request
   * @returns true if epoch matches (tile is valid), false if stale
   */
  validateEpoch(epoch: number): boolean {
    return epoch === this.state.epoch;
  }

  /**
   * Validate that a tile's render params match current state.
   *
   * @param paramsId The renderParamsId from the tile request
   * @returns true if params match, false if stale
   */
  validateRenderParams(paramsId: string): boolean {
    return paramsId === this.computeRenderParamsId();
  }

  // ─────────────────────────────────────────────────────────────────
  // Focal Point Priority API (Phase 6)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get the current zoom focal point.
   */
  getFocalPoint(): Point | null {
    return this.focalPoint.point;
  }

  /**
   * Set the focal point for radial priority calculations.
   * Called by zoom gesture handlers.
   */
  setFocalPoint(point: Point | null, gestureType: 'zoom' | 'pan' | 'idle' = 'idle'): void {
    this.focalPoint = {
      point,
      capturedAt: performance.now(),
      gestureType,
    };
  }

  /**
   * Get tile priority based on distance from focal point.
   * Closer tiles get higher priority.
   *
   * @param tile Tile coordinate to evaluate
   * @param tileSize Size of tiles in CSS pixels
   * @param pageLayout Layout info for converting tile coords to canvas coords
   */
  getTilePriority(
    tile: TileCoordinate,
    tileSize: number = 256,
    pageLayout?: { x: number; y: number }
  ): RenderPriority {
    const focal = this.focalPoint.point;
    if (!focal || this.focalPoint.gestureType === 'idle') {
      return 'medium';
    }

    // Calculate tile center in canvas coordinates
    const tileX = (pageLayout?.x ?? 0) + (tile.tileX + 0.5) * (tileSize / tile.scale);
    const tileY = (pageLayout?.y ?? 0) + (tile.tileY + 0.5) * (tileSize / tile.scale);

    const distance = Math.sqrt(
      (tileX - focal.x) ** 2 + (tileY - focal.y) ** 2
    );

    // Radial priority zones (in CSS pixels)
    if (distance < tileSize) return 'critical';      // 1 tile radius
    if (distance < tileSize * 2) return 'high';      // 2 tile radius
    if (distance < tileSize * 4) return 'medium';    // 4 tile radius
    return 'low';
  }

  // ─────────────────────────────────────────────────────────────────
  // Per-Tile Quality API (Phase 7)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get scale and cssStretch for a specific tile based on distance from focal point.
   * Tiles further from focal point may render at lower scale with CSS compensation.
   *
   * @param tile Tile coordinate
   * @param tileSize Tile size in CSS pixels
   * @param pageLayout Page layout info
   */
  getTileScale(
    tile: TileCoordinate,
    tileSize: number = 256,
    pageLayout?: { x: number; y: number }
  ): { scale: number; cssStretch: number } {
    const baseScale = this.state.scale;
    const focal = this.focalPoint.point;

    // No falloff or no focal point: use base scale
    if (
      !focal ||
      this.config.qualityFalloff === 'none' ||
      this.focalPoint.gestureType === 'idle'
    ) {
      return { scale: baseScale, cssStretch: 1.0 };
    }

    // Calculate tile center
    const tileX = (pageLayout?.x ?? 0) + (tile.tileX + 0.5) * (tileSize / tile.scale);
    const tileY = (pageLayout?.y ?? 0) + (tile.tileY + 0.5) * (tileSize / tile.scale);

    const distance = Math.sqrt(
      (tileX - focal.x) ** 2 + (tileY - focal.y) ** 2
    );

    const falloff = this.calculateFalloff(distance);

    // Reduce scale for distant tiles (min scale = 2)
    const reducedScale = Math.max(baseScale * falloff, 2);
    const cssStretch = baseScale / reducedScale;

    return { scale: reducedScale, cssStretch };
  }

  /**
   * Get spatial quality map for all tiles in a viewport.
   * Returns a map of tile keys to quality params.
   */
  getSpatialQualityMap(
    visibleTiles: TileCoordinate[],
    tileSize: number = 256,
    pageLayout?: { x: number; y: number }
  ): Map<string, TileQualityParams> {
    const map = new Map<string, TileQualityParams>();

    for (const tile of visibleTiles) {
      const { scale, cssStretch } = this.getTileScale(tile, tileSize, pageLayout);
      const priority = this.getTilePriority(tile, tileSize, pageLayout);

      // Calculate quality factor (1.0 = full quality)
      const qualityFactor = scale / this.state.scale;

      const key = `${tile.page}-${tile.tileY}-${tile.tileX}-${tile.scale}`;
      map.set(key, { scale, cssStretch, priority, qualityFactor });
    }

    return map;
  }

  // ─────────────────────────────────────────────────────────────────
  // Quality Falloff API (Phase 9)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Set the quality falloff mode.
   */
  setQualityFalloff(mode: QualityFalloffMode): void {
    this.config.qualityFalloff = mode;
  }

  /**
   * Get the current quality falloff mode.
   */
  getQualityFalloff(): QualityFalloffMode {
    return this.config.qualityFalloff ?? 'none';
  }

  // ─────────────────────────────────────────────────────────────────
  // Write API - Internal (Council Requirement: syncFromZoom is PRIVATE)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Sync scale state from ZoomStateManager.
   * PRIVATE - driven by internal subscription, NOT public setter.
   */
  private syncFromZoomState(zoomState: ZoomState): void {
    const zoom = zoomState.zoom;
    const newScale = this.calculateScale(zoom);
    const newCssStretch = this.calculateCssStretch(zoom, newScale);
    const newRenderMode = this.determineRenderMode(zoom);

    // Check if scale actually changed
    const scaleChanged = newScale !== this.state.scale;
    const modeChanged = newRenderMode !== this.state.renderMode;

    // Track gesture phase
    const gesturePhase: GesturePhase = zoomState.gestureActive
      ? 'active'
      : this.state.gesturePhase === 'active'
        ? 'settling'
        : 'idle';

    // Committed scale: freeze at gesture start, release at gesture end
    let committedScale = this.state.committedScale;
    let committedRenderMode = this.state.committedRenderMode;

    if (gesturePhase === 'active' && this.state.gesturePhase === 'idle') {
      // Gesture just started - commit current scale AND render mode (amnesia-wbp)
      committedScale = this.state.scale;
      committedRenderMode = this.state.renderMode;
    } else if (gesturePhase === 'idle' && this.state.gesturePhase !== 'idle') {
      // Gesture just ended - update committed to current
      committedScale = newScale;
      committedRenderMode = newRenderMode;
    }

    // Increment epoch if scale or mode changed (rate-limited)
    let newEpoch = this.state.epoch;
    if (scaleChanged || modeChanged) {
      newEpoch = this.incrementEpochInternal();
    }

    this.state = {
      scale: newScale,
      epoch: newEpoch,
      renderMode: newRenderMode,
      scaleMode: this.config.scaleMode!,
      cssStretch: newCssStretch,
      scaleTier: this.findNearestTier(newScale),
      gesturePhase,
      committedScale,
      pendingScale: newScale,
      committedRenderMode,
      pendingRenderMode: newRenderMode,
    };

    if (scaleChanged || modeChanged) {
      console.log(`[ScaleStateManager] syncFromZoomState:`, {
        zoom: zoom.toFixed(3),
        scale: newScale,
        cssStretch: newCssStretch.toFixed(3),
        renderMode: newRenderMode,
        epoch: newEpoch,
        gesturePhase,
      });
    }

    this.notifyListeners();
  }

  /**
   * Commit the current scale transition.
   * Returns atomic {scale, epoch} for tile requests.
   */
  commitScaleTransition(): ScaleSnapshot {
    // If settling from gesture, update committed scale
    if (this.state.gesturePhase === 'settling') {
      this.state = {
        ...this.state,
        gesturePhase: 'idle',
        committedScale: this.state.scale,
      };
      this.notifyListeners();
    }

    return this.captureSnapshot();
  }

  /**
   * Request a render mode transition.
   * The transition is deferred by hysteresis logic.
   */
  requestModeTransition(mode: RenderMode): void {
    if (mode === this.state.renderMode) return;

    this.state = {
      ...this.state,
      renderMode: mode,
      epoch: this.incrementEpochInternal(),
    };

    console.log(`[ScaleStateManager] Mode transition: ${this.state.renderMode} → ${mode}`);
    this.notifyListeners();
  }

  /**
   * Explicitly increment the epoch counter.
   * Use for non-scale events that should invalidate tiles (e.g., page navigation).
   *
   * @returns The new epoch value
   */
  incrementEpoch(): number {
    const newEpoch = this.incrementEpochInternal();
    this.state = {
      ...this.state,
      epoch: newEpoch,
    };
    console.log(`[ScaleStateManager] incrementEpoch: epoch=${newEpoch}`);
    return newEpoch;
  }

  // ─────────────────────────────────────────────────────────────────
  // Subscription
  // ─────────────────────────────────────────────────────────────────

  /**
   * Subscribe to scale state changes.
   *
   * @param listener Callback invoked on state change
   * @returns Unsubscribe function
   */
  subscribe(listener: (state: ScaleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Calculate scale from zoom using configured mode.
   */
  private calculateScale(zoom: number): number {
    if (this.config.scaleMode === 'exact') {
      // FIX (amnesia-d9f): Pass maxZoom to ensure proper scale cap
      const { scale } = getExactTargetScale(zoom, this.config.pixelRatio, this.config.maxZoom);
      return scale;
    }

    // Tier mode: use getTargetScaleTier with maxZoom for proper scaling
    const { tier } = getTargetScaleTier(
      zoom,
      this.config.pixelRatio,
      this.config.maxZoom
    );
    return tier;
  }

  /**
   * Calculate CSS stretch factor.
   */
  private calculateCssStretch(zoom: number, scale: number): number {
    const minRequired = zoom * this.config.pixelRatio;
    return minRequired / scale;
  }

  /**
   * Determine render mode from zoom with hysteresis.
   */
  private determineRenderMode(zoom: number): RenderMode {
    const currentMode = this.state.renderMode;
    const { FULL_TO_ADAPTIVE, ADAPTIVE_TO_TILED, MAX_TILED_ZOOM, HYSTERESIS } = RENDER_MODE_THRESHOLDS;

    // EXTREME ZOOM FIX (amnesia-wbp): At or above MAX_TILED_ZOOM, always use full-page
    // Tiled rendering breaks at extreme zoom due to coordinate calculation issues.
    // NOTE: Use >= to prevent tiled mode at exactly MAX_TILED_ZOOM (boundary fix)
    if (zoom >= MAX_TILED_ZOOM) {
      return 'full-page';
    }

    // Apply hysteresis based on transition direction
    if (currentMode === 'full-page') {
      // Need to exceed threshold + hysteresis to switch to adaptive
      if (zoom > FULL_TO_ADAPTIVE * (1 + HYSTERESIS)) {
        // Check if should go directly to tiled (but not at or above MAX_TILED_ZOOM)
        if (zoom > ADAPTIVE_TO_TILED * (1 + HYSTERESIS) && zoom < MAX_TILED_ZOOM) {
          return 'tiled';
        }
        return 'adaptive';
      }
      return 'full-page';
    }

    if (currentMode === 'adaptive') {
      // Check downward transition to full-page
      if (zoom < FULL_TO_ADAPTIVE * (1 - HYSTERESIS)) {
        return 'full-page';
      }
      // Check upward transition to tiled (but not at or above MAX_TILED_ZOOM)
      if (zoom > ADAPTIVE_TO_TILED * (1 + HYSTERESIS) && zoom < MAX_TILED_ZOOM) {
        return 'tiled';
      }
      return 'adaptive';
    }

    if (currentMode === 'tiled') {
      // Early exit at MAX_TILED_ZOOM is handled above
      // Check downward transition to adaptive
      if (zoom < ADAPTIVE_TO_TILED * (1 - HYSTERESIS)) {
        // Check if should go directly to full-page
        if (zoom < FULL_TO_ADAPTIVE * (1 - HYSTERESIS)) {
          return 'full-page';
        }
        return 'adaptive';
      }
      return 'tiled';
    }

    return currentMode;
  }

  /**
   * Find the nearest scale tier.
   */
  private findNearestTier(scale: number): ScaleTier | null {
    let nearest: ScaleTier = SCALE_TIERS[0];
    let minDiff = Math.abs(scale - SCALE_TIERS[0]);

    for (const tier of SCALE_TIERS) {
      const diff = Math.abs(scale - tier);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = tier;
      }
    }

    // Only return tier if scale is within 5% of a tier
    if (minDiff / scale < 0.05) {
      return nearest;
    }
    return null;
  }

  /**
   * Calculate quality falloff based on distance from focal point.
   */
  private calculateFalloff(distance: number): number {
    const maxDistance = this.config.falloffRadius ?? 1024;
    const normalizedDist = Math.min(distance / maxDistance, 1);

    switch (this.config.qualityFalloff) {
      case 'none':
        return 1.0;
      case 'linear':
        // Quality = 1.0 at center, 0.5 at max distance
        return 1.0 - normalizedDist * 0.5;
      case 'quadratic':
        // Quality drops faster at edges
        return 1.0 - normalizedDist * normalizedDist * 0.7;
      default:
        return 1.0;
    }
  }

  /**
   * Increment epoch with rate limiting.
   */
  private incrementEpochInternal(): number {
    const now = performance.now();
    const minInterval = 1000 / (this.config.maxEpochRate ?? 60); // 16.67ms at 60Hz

    if (now - this.lastEpochTime < minInterval) {
      // Rate limited - don't increment
      return this.state.epoch;
    }

    this.lastEpochTime = now;
    return this.state.epoch + 1;
  }

  /**
   * Compute a hash string for render params identity.
   */
  private computeRenderParamsId(): string {
    return `${this.state.epoch}:${this.state.scale}:${this.config.pixelRatio}:${this.state.renderMode}`;
  }

  /**
   * Notify all listeners of state change.
   */
  private notifyListeners(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (e) {
        console.error('[ScaleStateManager] Listener error:', e);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  /**
   * Clean up resources.
   */
  destroy(): void {
    if (this.unsubscribeZoom) {
      this.unsubscribeZoom();
      this.unsubscribeZoom = null;
    }
    this.listeners.clear();
  }
}

// ─────────────────────────────────────────────────────────────────
// Per-Document Singleton Management
// ─────────────────────────────────────────────────────────────────

const managers = new Map<string, ScaleStateManager>();

/**
 * Get ScaleStateManager for a specific document.
 *
 * @param docId Document identifier
 */
export function getScaleStateManager(docId: string): ScaleStateManager | null {
  return managers.get(docId) ?? null;
}

/**
 * Create and register ScaleStateManager for a document.
 *
 * @param docId Document identifier
 * @param zoomManager ZoomStateManager for internal subscription
 * @param config Manager configuration
 */
export function createScaleStateManager(
  docId: string,
  zoomManager: ZoomManagerType,
  config: ScaleStateManagerConfig
): ScaleStateManager {
  // Clean up existing manager if any
  const existing = managers.get(docId);
  if (existing) {
    existing.destroy();
  }

  const manager = new ScaleStateManager(zoomManager, config);
  managers.set(docId, manager);
  return manager;
}

/**
 * Clear ScaleStateManager for a document.
 *
 * @param docId Document identifier
 */
export function clearScaleStateManager(docId: string): void {
  const manager = managers.get(docId);
  if (manager) {
    manager.destroy();
    managers.delete(docId);
  }
}

/**
 * Clear all ScaleStateManager instances.
 */
export function clearAllScaleStateManagers(): void {
  for (const manager of managers.values()) {
    manager.destroy();
  }
  managers.clear();
}

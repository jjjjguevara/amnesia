/**
 * Zoom State Manager
 *
 * Central source of truth for zoom state, eliminating the 6 different zoom state
 * locations that can desync during gestures (camera.z, displayZoom, snapshot.camera.z,
 * scrollRenderSnapshot.camera.z, cssStretch, and scale tiers).
 *
 * Key Features:
 * - Single canonical zoom value
 * - Epoch-based tile validation (stale tiles are discarded)
 * - CSS always owns positioning (GPU-accelerated)
 * - Tiles only determine resolution quality, not position
 *
 * The epoch system prevents the "two-stage zoom bug" where:
 * - Tiles render with snapshot zoom (15.97) while CSS shows live zoom (16.00)
 * - 0.03x mismatch causes visible position jump when tiles display
 *
 * With epoch validation:
 * - If zoom changes during tile rendering, the tile's epoch won't match current
 * - Stale tiles are discarded rather than displayed with wrong positioning
 *
 * @example
 * ```typescript
 * const manager = new ZoomStateManager({ pixelRatio: 2, minZoom: 0.25, maxZoom: 32 });
 *
 * // On zoom gesture
 * manager.onZoomGesture(newZoom, focalPoint);
 *
 * // Get CSS transform for canvas
 * canvas.style.transform = manager.getCssTransform();
 *
 * // Request tiles with epoch
 * const { scale, epoch } = manager.getTileParams();
 *
 * // Validate before displaying tile
 * if (manager.validateEpoch(tile.epoch)) {
 *   displayTile(tile);
 * }
 * ```
 */

import type { Point, Camera, CameraConstraints } from './pdf-canvas-camera';
import { screenToCanvas } from './pdf-canvas-camera';

/**
 * Zoom state snapshot for consumers
 */
export interface ZoomState {
  /** Current zoom level */
  readonly zoom: number;
  /** Epoch counter - incremented on every zoom change */
  readonly epoch: number;
  /** Camera position in canvas coordinates */
  readonly position: { x: number; y: number };
  /** Target scale for tile rendering (zoom × pixelRatio) */
  readonly tileScale: number;
  /** Whether a zoom gesture is currently active */
  readonly gestureActive: boolean;
}

/**
 * Tile render parameters
 */
export interface TileParams {
  /** Scale for rendering (zoom × pixelRatio) */
  scale: number;
  /** Epoch at time of request - validate before displaying */
  epoch: number;
  /** Current zoom level */
  zoom: number;
}

/**
 * Configuration for ZoomStateManager
 */
export interface ZoomStateManagerConfig {
  /** Device pixel ratio for crisp rendering */
  pixelRatio: number;
  /** Minimum allowed zoom level */
  minZoom: number;
  /** Maximum allowed zoom level */
  maxZoom: number;
  /** Initial zoom level (default: 1) */
  initialZoom?: number;
  /** Initial camera position (default: { x: 0, y: 0 }) */
  initialPosition?: { x: number; y: number };
}

/**
 * Get the global zoom config (maxZoom, pixelRatio) from the singleton manager.
 * Returns null if no manager is initialized.
 * Used by getTargetScaleTier to get maxZoom when not explicitly provided.
 */
export function getGlobalZoomConfig(): { maxZoom: number; pixelRatio: number } | null {
  const manager = getZoomStateManager();
  if (!manager) return null;
  return {
    maxZoom: manager.getMaxZoom(),
    pixelRatio: manager.getPixelRatio(),
  };
}

/**
 * Central zoom state manager - single source of truth
 */
export class ZoomStateManager {
  private state: ZoomState;
  private config: ZoomStateManagerConfig;
  private listeners: Set<(state: ZoomState) => void> = new Set();

  // ─────────────────────────────────────────────────────────────────
  // Rebound Detection State (amnesia-x9v)
  // ─────────────────────────────────────────────────────────────────
  /** Timestamp when the last gesture ended */
  private gestureEndTime: number = 0;
  /** Whether zoom was at max boundary when gesture ended */
  private wasAtMaxZoom: boolean = false;
  /** Whether zoom was at min boundary when gesture ended */
  private wasAtMinZoom: boolean = false;

  constructor(config: ZoomStateManagerConfig) {
    this.config = config;

    // Initialize state
    const initialZoom = config.initialZoom ?? 1;
    const initialPosition = config.initialPosition ?? { x: 0, y: 0 };

    this.state = {
      zoom: initialZoom,
      epoch: 0,
      position: { ...initialPosition },
      tileScale: this.calculateTileScale(initialZoom),
      gestureActive: false,
    };

    console.log('[ZoomStateManager] Initialized:', {
      zoom: this.state.zoom,
      tileScale: this.state.tileScale,
      pixelRatio: config.pixelRatio,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Read API - All consumers use these
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get the current canonical zoom level
   */
  getZoom(): number {
    return this.state.zoom;
  }

  /**
   * Get the configured maximum zoom level
   */
  getMaxZoom(): number {
    return this.config.maxZoom;
  }

  /**
   * Get the configured pixel ratio
   */
  getPixelRatio(): number {
    return this.config.pixelRatio;
  }

  /**
   * Get the current epoch counter
   */
  getEpoch(): number {
    return this.state.epoch;
  }


  /**
   * Explicitly increment the epoch counter.
   * Use this for non-zoom events that should invalidate in-flight tiles:
   * - Mode transitions (full-page ↔ tiled)
   * - Page navigation
   * - Initial render
   *
   * For zoom changes, use syncFromCamera() which increments epoch automatically.
   *
   * @returns The new epoch value
   */
  incrementEpoch(): number {
    this.state = {
      ...this.state,
      epoch: this.state.epoch + 1,
    };
    console.log(`[ZoomStateManager] incrementEpoch: epoch=${this.state.epoch}`);
    return this.state.epoch;
  }

  /**
   * Get the current camera position
   */
  getPosition(): { x: number; y: number } {
    return { ...this.state.position };
  }

  /**
   * Get the target scale for tile rendering
   */
  getTileScale(): number {
    return this.state.tileScale;
  }

  /**
   * Get the current zoom state snapshot
   */
  getState(): ZoomState {
    return { ...this.state };
  }

  /**
   * Check if a zoom gesture is currently active
   */
  isGestureActive(): boolean {
    return this.state.gestureActive;
  }

  // ─────────────────────────────────────────────────────────────────
  // Rebound Detection API (amnesia-x9v)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Check if we're in a rebound window after hitting zoom limits.
   *
   * Trackpads send "rebound" events after hitting max zoom - these are
   * zoom-out events from inertia that would cause focal point drift.
   * By detecting this window, callers can filter out these spurious events.
   *
   * @param windowMs Time window in ms after gesture end (default: 600ms)
   * @returns true if we're within the rebound window at a zoom boundary
   */
  isInReboundWindow(windowMs: number = 600): boolean {
    if (this.state.gestureActive) {
      return false; // Still in gesture, not in rebound
    }

    const timeSinceGestureEnd = performance.now() - this.gestureEndTime;
    if (timeSinceGestureEnd > windowMs) {
      return false; // Outside rebound window
    }

    // We're in the rebound window if gesture ended while at a zoom boundary
    return this.wasAtMaxZoom || this.wasAtMinZoom;
  }

  /**
   * Check if we're in a rebound window after hitting MAX zoom specifically.
   * Use this to filter zoom-out events that would drift focal point.
   *
   * @param windowMs Time window in ms after gesture end (default: 600ms)
   */
  isReboundZoomOut(windowMs: number = 600): boolean {
    if (this.state.gestureActive) return false;

    const timeSinceGestureEnd = performance.now() - this.gestureEndTime;
    return timeSinceGestureEnd <= windowMs && this.wasAtMaxZoom;
  }

  /**
   * Check if we're in a rebound window after hitting MIN zoom specifically.
   * Use this to filter zoom-in events that would drift focal point.
   *
   * @param windowMs Time window in ms after gesture end (default: 600ms)
   */
  isReboundZoomIn(windowMs: number = 600): boolean {
    if (this.state.gestureActive) return false;

    const timeSinceGestureEnd = performance.now() - this.gestureEndTime;
    return timeSinceGestureEnd <= windowMs && this.wasAtMinZoom;
  }

  /**
   * Check if zoom is currently at the maximum boundary
   */
  isAtMaxZoom(): boolean {
    return Math.abs(this.state.zoom - this.config.maxZoom) < 0.0001;
  }

  /**
   * Check if zoom is currently at the minimum boundary
   */
  isAtMinZoom(): boolean {
    return Math.abs(this.state.zoom - this.config.minZoom) < 0.0001;
  }

  /**
   * Get the timestamp when the last gesture ended.
   * Used for telemetry and rebound window calculations.
   */
  getGestureEndTime(): number {
    return this.gestureEndTime;
  }

  // ─────────────────────────────────────────────────────────────────
  // Soft Constraint API (amnesia-4rl)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Apply zoom constraints with soft or hard mode.
   *
   * Soft mode (during gesture): Allow rubber-band effect with resistance.
   * Hard mode (gesture settled): Snap to exact boundaries.
   *
   * @param zoom Raw zoom value to constrain
   * @param soft If true, allow overshoot with resistance (30%)
   * @returns Constrained zoom value
   */
  constrainZoom(zoom: number, soft: boolean = false): number {
    const { minZoom, maxZoom } = this.config;

    if (!soft) {
      // Hard constraint: strict clamping
      return this.clamp(zoom, minZoom, maxZoom);
    }

    // Soft constraint: rubber-band effect with 30% resistance
    const resistance = 0.3;

    if (zoom > maxZoom) {
      // Over max: allow overshoot with diminishing returns
      const overshoot = zoom - maxZoom;
      return maxZoom + overshoot * resistance;
    }

    if (zoom < minZoom) {
      // Under min: allow undershoot with diminishing returns
      const undershoot = minZoom - zoom;
      return minZoom - undershoot * resistance;
    }

    return zoom;
  }

  /**
   * Signal that a zoom gesture is ongoing.
   *
   * Call this on every zoom event to keep the gesture alive.
   * This is used by the infinite canvas to prevent premature gesture-end detection.
   */
  signalOngoingActivity(): void {
    // If a gesture isn't active, start one
    if (!this.state.gestureActive) {
      this.startGesture();
    }
    // Note: The actual gesture-end timer is managed externally (ZoomStateMachine/ZoomOrchestrator)
    // This method exists for API compatibility with the planned full wiring.
  }

  /**
   * Get the CSS transform string for the camera
   */
  getCssTransform(): string {
    const { zoom, position } = this.state;
    return `scale(${zoom}) translate(${position.x}px, ${position.y}px)`;
  }

  /**
   * Get tile render parameters with current epoch
   */
  getTileParams(): TileParams {
    return {
      scale: this.state.tileScale,
      epoch: this.state.epoch,
      zoom: this.state.zoom,
    };
  }

  /**
   * Validate that a tile's epoch matches current state
   *
   * @param epoch The epoch from the tile render request
   * @returns true if epoch matches (tile is valid), false if stale
   */
  validateEpoch(epoch: number): boolean {
    return epoch === this.state.epoch;
  }

  /**
   * Get the camera as a Camera object (for compatibility)
   */
  getCamera(): Camera {
    return {
      x: this.state.position.x,
      y: this.state.position.y,
      z: this.state.zoom,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Write API - Only input handlers call these
  // ─────────────────────────────────────────────────────────────────

  /**
   * Handle a zoom gesture input
   *
   * Updates zoom level while preserving focal point position.
   * Increments epoch to invalidate any in-flight tile renders.
   *
   * @param newZoom Target zoom level (will be clamped to min/max)
   * @param focalPoint Screen coordinates of zoom center
   */
  onZoomGesture(newZoom: number, focalPoint: Point): void {
    const clampedZoom = this.clamp(newZoom, this.config.minZoom, this.config.maxZoom);

    // Early return if zoom didn't actually change (already at limits)
    if (clampedZoom === this.state.zoom) {
      return;
    }

    // Calculate new position to preserve focal point
    const newPosition = this.calculateFocalPointPosition(clampedZoom, focalPoint);

    // Increment epoch - this invalidates all in-flight tiles
    const newEpoch = this.state.epoch + 1;

    this.state = {
      zoom: clampedZoom,
      epoch: newEpoch,
      position: newPosition,
      tileScale: this.calculateTileScale(clampedZoom),
      gestureActive: true,
    };

    console.log(`[ZoomStateManager] onZoomGesture: zoom=${clampedZoom.toFixed(3)}, epoch=${newEpoch}, focal=(${focalPoint.x.toFixed(0)}, ${focalPoint.y.toFixed(0)})`);

    this.notifyListeners();
  }

  /**
   * Apply zoom change from camera delta
   *
   * This is used when integrating with the existing camera system.
   * Updates the state to match the camera's new zoom level.
   *
   * @param camera The updated camera state
   */
  syncFromCamera(camera: Camera): void {
    // Check if zoom actually changed
    if (camera.z === this.state.zoom &&
        camera.x === this.state.position.x &&
        camera.y === this.state.position.y) {
      return;
    }

    const zoomChanged = camera.z !== this.state.zoom;

    this.state = {
      zoom: camera.z,
      // Only increment epoch if zoom changed (not just pan)
      epoch: zoomChanged ? this.state.epoch + 1 : this.state.epoch,
      position: { x: camera.x, y: camera.y },
      tileScale: zoomChanged ? this.calculateTileScale(camera.z) : this.state.tileScale,
      gestureActive: this.state.gestureActive,
    };

    if (zoomChanged) {
      console.log(`[ZoomStateManager] syncFromCamera: zoom=${camera.z.toFixed(3)}, epoch=${this.state.epoch}`);
    }

    this.notifyListeners();
  }

  /**
   * Update camera position without changing zoom
   *
   * @param position New camera position
   */
  setPosition(position: { x: number; y: number }): void {
    if (position.x === this.state.position.x && position.y === this.state.position.y) {
      return;
    }

    this.state = {
      ...this.state,
      position: { ...position },
    };

    this.notifyListeners();
  }

  /**
   * Set zoom directly (for programmatic zoom like keyboard shortcuts)
   *
   * @param zoom Target zoom level
   * @param focalPoint Screen coordinates of zoom center
   */
  setZoomDirect(zoom: number, focalPoint: Point): void {
    const clampedZoom = this.clamp(zoom, this.config.minZoom, this.config.maxZoom);
    const newPosition = this.calculateFocalPointPosition(clampedZoom, focalPoint);

    this.state = {
      zoom: clampedZoom,
      epoch: this.state.epoch + 1,
      position: newPosition,
      tileScale: this.calculateTileScale(clampedZoom),
      gestureActive: false,
    };

    console.log(`[ZoomStateManager] setZoomDirect: zoom=${clampedZoom.toFixed(3)}, epoch=${this.state.epoch}`);

    this.notifyListeners();
  }

  /**
   * Mark gesture as started
   */
  startGesture(): void {
    if (this.state.gestureActive) return;

    this.state = {
      ...this.state,
      gestureActive: true,
    };

    console.log('[ZoomStateManager] Gesture started');
    this.notifyListeners();
  }

  /**
   * Mark gesture as ended
   *
   * Records the gesture end timestamp and boundary state for rebound detection.
   * Callers can use isInReboundWindow() to filter spurious events.
   */
  endGesture(): void {
    if (!this.state.gestureActive) return;

    // Record rebound detection state BEFORE changing gestureActive
    this.gestureEndTime = performance.now();
    this.wasAtMaxZoom = this.isAtMaxZoom();
    this.wasAtMinZoom = this.isAtMinZoom();

    this.state = {
      ...this.state,
      gestureActive: false,
    };

    console.log('[ZoomStateManager] Gesture ended:', {
      atMaxZoom: this.wasAtMaxZoom,
      atMinZoom: this.wasAtMinZoom,
      timestamp: this.gestureEndTime.toFixed(0),
    });
    this.notifyListeners();
  }

  // ─────────────────────────────────────────────────────────────────
  // Subscription
  // ─────────────────────────────────────────────────────────────────

  /**
   * Subscribe to zoom state changes
   *
   * @param listener Callback invoked on state change
   * @returns Unsubscribe function
   */
  subscribe(listener: (state: ZoomState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Calculate the target scale for tile rendering
   *
   * Uses zoom × pixelRatio for crisp rendering at current zoom level.
   */
  private calculateTileScale(zoom: number): number {
    return zoom * this.config.pixelRatio;
  }

  /**
   * Calculate new camera position to preserve focal point
   *
   * When zooming, the point under the cursor/pinch center should remain
   * stationary on screen. This requires adjusting the camera position.
   */
  private calculateFocalPointPosition(
    newZoom: number,
    focalPoint: Point
  ): { x: number; y: number } {
    const oldZoom = this.state.zoom;
    const oldPos = this.state.position;

    // Find where the focal point is in canvas coordinates BEFORE zoom
    const p1 = screenToCanvas(focalPoint, { x: oldPos.x, y: oldPos.y, z: oldZoom });

    // Find where the focal point would be in canvas coordinates AFTER zoom
    // (using the new zoom level but old position)
    const p2 = screenToCanvas(focalPoint, { x: oldPos.x, y: oldPos.y, z: newZoom });

    // Calculate position adjustment to keep the focal point stationary
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    return {
      x: oldPos.x + dx,
      y: oldPos.y + dy,
    };
  }

  /**
   * Clamp a value between min and max
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Notify all listeners of state change
   */
  private notifyListeners(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (e) {
        console.error('[ZoomStateManager] Listener error:', e);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  /**
   * Clean up resources
   */
  destroy(): void {
    this.listeners.clear();
  }
}

// ─────────────────────────────────────────────────────────────────
// Singleton Management
// ─────────────────────────────────────────────────────────────────

let managerInstance: ZoomStateManager | null = null;

/**
 * Get the shared ZoomStateManager instance
 *
 * Note: In a multi-document scenario, you may need to manage multiple
 * instances keyed by document ID instead of using a singleton.
 */
export function getZoomStateManager(): ZoomStateManager | null {
  return managerInstance;
}

/**
 * Create and set the shared ZoomStateManager instance
 */
export function createZoomStateManager(config: ZoomStateManagerConfig): ZoomStateManager {
  if (managerInstance) {
    managerInstance.destroy();
  }
  managerInstance = new ZoomStateManager(config);
  return managerInstance;
}

/**
 * Clear the shared ZoomStateManager instance
 */
export function clearZoomStateManager(): void {
  if (managerInstance) {
    managerInstance.destroy();
    managerInstance = null;
  }
}

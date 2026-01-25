/**
 * Zoom Scale Service
 *
 * Unified source of truth for zoom and scale state, replacing the fragmented
 * architecture of ZoomOrchestrator + ZoomStateManager + ScaleStateManager.
 *
 * Key Principles:
 * - ONE canonical zoom value (from camera.z)
 * - ONE epoch counter (incremented on zoom change, mode change, or explicit invalidation)
 * - Scale is DERIVED from zoom (never stored separately)
 * - cssStretch is DERIVED from zoom and scale (never stored separately)
 * - ONE gesture phase state machine
 * - ONE snapshot mechanism (captureSnapshot at request time, validateEpoch at display time)
 *
 * Architecture:
 * - Config is immutable after initialization (pixelRatio, minZoom, maxZoom)
 * - State is minimal (zoom, epoch, position, gesturePhase)
 * - Derived values are computed on-demand via getters
 * - Gesture timing is internal (300ms inactivity detection)
 *
 * Two-Track Pipeline Support:
 * - Interaction Track: CSS transforms updated synchronously via camera system
 * - Refinement Track: Tiles rendered asynchronously using snapshots
 *
 * @example
 * ```typescript
 * const service = createZoomScaleService({
 *   pixelRatio: 2,
 *   minZoom: 0.25,
 *   maxZoom: 32,
 * });
 *
 * // On zoom gesture
 * service.onZoomGesture(newZoom, focalPoint, camera);
 *
 * // Get derived scale for tile rendering
 * const { scale, cssStretch } = service.getScale();
 *
 * // Capture snapshot for async tile request
 * const snapshot = service.captureSnapshot();
 *
 * // Validate before displaying tile
 * if (service.validateEpoch(tile.epoch)) {
 *   displayTile(tile);
 * }
 * ```
 */

import type { Point, Camera, CameraConstraints } from './pdf-canvas-camera';
import { screenToCanvas } from './pdf-canvas-camera';
import { getTargetScaleTier, getExactTargetScale, type ScaleTier } from './progressive-tile-renderer';
import { isFeatureEnabled } from './feature-flags';
import { setGesturePhase, type RenderPriority } from './render-coordinator';
import type { TileCoordinate } from './tile-render-engine';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/** Gesture phase in the zoom state machine */
export type GesturePhase = 'idle' | 'active' | 'settling' | 'rendering';

/** Render mode based on zoom level */
export type RenderMode = 'full-page' | 'adaptive' | 'tiled';

/**
 * Configuration for ZoomScaleService (immutable after init)
 */
export interface ZoomScaleServiceConfig {
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
  /** Time without input before gesture is considered ended (ms, default: 300) */
  gestureEndDelay?: number;
  /** Time to wait after gesture ends before triggering final render (ms, default: 200) */
  settlingDelay?: number;
}

/**
 * Minimal canonical state (everything else is derived)
 */
interface ZoomScaleState {
  /** Current zoom level */
  zoom: number;
  /** Epoch counter - incremented on zoom/mode/invalidation */
  epoch: number;
  /** Camera position in canvas coordinates */
  position: { x: number; y: number };
  /** Current gesture phase */
  gesturePhase: GesturePhase;
  /** Current render mode (with hysteresis applied) */
  renderMode: RenderMode;
}

/**
 * Scale result computed on-demand
 */
export interface ScaleResult {
  /** Scale tier for tile rendering */
  scale: number;
  /** CSS stretch factor: (zoom * pixelRatio) / scale */
  cssStretch: number;
  /** Whether using exact scale mode (vs tier-based) */
  isExact: boolean;
}

/**
 * Snapshot captured at tile REQUEST time for async validation
 */
export interface ZoomScaleSnapshot {
  /** Zoom at request time */
  readonly zoom: number;
  /** Epoch at request time - validate at display time */
  readonly epoch: number;
  /** Scale at request time */
  readonly scale: number;
  /** CSS stretch at request time */
  readonly cssStretch: number;
  /** Render mode at request time */
  readonly renderMode: RenderMode;
  /** Pixel ratio (for reference) */
  readonly pixelRatio: number;
  /** Hash for quick equality checks */
  readonly snapshotId: string;
}

/**
 * Tile render parameters for consumers
 */
export interface TileParams {
  scale: number;
  epoch: number;
  zoom: number;
  cssStretch: number;
  renderMode: RenderMode;
}

// ─────────────────────────────────────────────────────────────────
// Render Mode Thresholds
// ─────────────────────────────────────────────────────────────────

const RENDER_MODE_THRESHOLDS = {
  /** Zoom level where full-page -> adaptive transition occurs */
  FULL_TO_ADAPTIVE: 1.5,
  /** Zoom level where adaptive -> tiled transition occurs */
  ADAPTIVE_TO_TILED: 4.0,
  /** Hysteresis band to prevent oscillation at boundaries (10%) */
  HYSTERESIS: 0.1,
} as const;

// ─────────────────────────────────────────────────────────────────
// ZoomScaleService
// ─────────────────────────────────────────────────────────────────

/**
 * Unified zoom and scale state service
 */
export class ZoomScaleService {
  private state: ZoomScaleState;
  private readonly config: Required<ZoomScaleServiceConfig>;
  private listeners: Set<(state: ZoomScaleState) => void> = new Set();

  // ─────────────────────────────────────────────────────────────────
  // Gesture Timing
  // ─────────────────────────────────────────────────────────────────
  private gestureEndTimer: ReturnType<typeof setTimeout> | null = null;
  private settlingTimer: ReturnType<typeof setTimeout> | null = null;
  
  // Watchdog timer for stuck phases (amnesia-e4i)
  private phaseWatchdog: ReturnType<typeof setTimeout> | null = null;
  private static readonly PHASE_WATCHDOG_TIMEOUT_MS = 3000; // 3 seconds max in non-idle phase

  // ─────────────────────────────────────────────────────────────────
  // Rebound Detection
  // ─────────────────────────────────────────────────────────────────
  private gestureEndTime: number = 0;
  private wasAtMaxZoom: boolean = false;
  private wasAtMinZoom: boolean = false;

  // ─────────────────────────────────────────────────────────────────
  // Focal Point (merged from ScaleStateManager)
  // ─────────────────────────────────────────────────────────────────
  private focalPoint: Point | null = null;
  private focalPointGestureType: 'zoom' | 'pan' | 'idle' = 'idle';

  // ─────────────────────────────────────────────────────────────────
  // Zoom Snapshot (merged from ZoomOrchestrator)
  // ─────────────────────────────────────────────────────────────────
  private zoomSnapshot: { zoom: number; focalPoint: Point; camera: { x: number; y: number; z: number }; timestamp: number } | null = null;
  private lastRenderedScale: number = 1;

  // ─────────────────────────────────────────────────────────────────
  // Callbacks (set by PdfInfiniteCanvas)
  // ─────────────────────────────────────────────────────────────────
  /** Called when gesture starts */
  onGestureStart: (() => void) | null = null;
  /** Called when gesture ends (entering settling) */
  onGestureEnd: (() => void) | null = null;
  /** Called when settling completes and final render should begin */
  onSettlingComplete: ((scale: number, zoom: number) => void) | null = null;
  /** Called when render mode changes */
  onRenderModeChange: ((mode: RenderMode) => void) | null = null;

  constructor(config: ZoomScaleServiceConfig) {
    this.config = {
      pixelRatio: config.pixelRatio,
      minZoom: config.minZoom,
      maxZoom: config.maxZoom,
      initialZoom: config.initialZoom ?? 1,
      initialPosition: config.initialPosition ?? { x: 0, y: 0 },
      gestureEndDelay: config.gestureEndDelay ?? 300,
      settlingDelay: config.settlingDelay ?? 200,
    };

    const initialZoom = this.config.initialZoom;
    const initialMode = this.deriveRenderMode(initialZoom, 'full-page');

    this.state = {
      zoom: initialZoom,
      epoch: 0,
      position: { ...this.config.initialPosition },
      gesturePhase: 'idle',
      renderMode: initialMode,
    };

    console.log('[ZoomScaleService] Initialized:', {
      zoom: this.state.zoom,
      maxZoom: this.config.maxZoom,
      pixelRatio: this.config.pixelRatio,
      renderMode: this.state.renderMode,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Config API (immutable)
  // ─────────────────────────────────────────────────────────────────

  /** Get the immutable configuration */
  getConfig(): Readonly<Required<ZoomScaleServiceConfig>> {
    return this.config;
  }

  /** Get maxZoom from config */
  getMaxZoom(): number {
    return this.config.maxZoom;
  }

  /** Get minZoom from config */
  getMinZoom(): number {
    return this.config.minZoom;
  }

  /** Get pixelRatio from config */
  getPixelRatio(): number {
    return this.config.pixelRatio;
  }

  // ─────────────────────────────────────────────────────────────────
  // State Read API
  // ─────────────────────────────────────────────────────────────────

  /** Get the current canonical zoom level */
  getZoom(): number {
    return this.state.zoom;
  }

  /** Get the current epoch counter */
  getEpoch(): number {
    return this.state.epoch;
  }

  /** Get the current camera position */
  getPosition(): { x: number; y: number } {
    return { ...this.state.position };
  }

  /** Get the current gesture phase */
  getGesturePhase(): GesturePhase {
    return this.state.gesturePhase;
  }

  /** Get the current render mode */
  getRenderMode(): RenderMode {
    return this.state.renderMode;
  }

  /** Check if a gesture is currently active (active or settling) */
  isGestureActive(): boolean {
    return this.state.gesturePhase === 'active' || this.state.gesturePhase === 'settling';
  }

  /** Check if rendering is allowed (idle or rendering phase) */
  canRender(): boolean {
    return this.state.gesturePhase === 'idle' || this.state.gesturePhase === 'rendering';
  }

  // ─────────────────────────────────────────────────────────────────
  // Derived Values (computed on-demand, never stored)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get the current scale and cssStretch.
   * These are DERIVED from zoom, never stored.
   */
  getScale(): ScaleResult {
    const zoom = this.state.zoom;
    const { pixelRatio, maxZoom } = this.config;

    if (isFeatureEnabled('useExactScaleRendering')) {
      // FIX (amnesia-d9f): Pass maxZoom to getExactTargetScale for proper scale cap
      const { scale, cssStretch } = getExactTargetScale(zoom, pixelRatio, maxZoom);
      return { scale, cssStretch, isExact: true };
    } else {
      const { tier, cssStretch } = getTargetScaleTier(zoom, pixelRatio, maxZoom);
      return { scale: tier, cssStretch, isExact: false };
    }
  }

  /**
   * Get tile render parameters with current epoch.
   * Convenience method for tile request code.
   */
  getTileParams(): TileParams {
    const { scale, cssStretch } = this.getScale();
    return {
      scale,
      epoch: this.state.epoch,
      zoom: this.state.zoom,
      cssStretch,
      renderMode: this.state.renderMode,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Snapshot API (for async tile operations)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Capture a snapshot at tile REQUEST time.
   * The snapshot's epoch should be validated at DISPLAY time.
   */
  captureSnapshot(): ZoomScaleSnapshot {
    const { scale, cssStretch } = this.getScale();
    const snapshotId = `${this.state.epoch}-${scale}-${this.state.renderMode}`;

    return {
      zoom: this.state.zoom,
      epoch: this.state.epoch,
      scale,
      cssStretch,
      renderMode: this.state.renderMode,
      pixelRatio: this.config.pixelRatio,
      snapshotId,
    };
  }

  /**
   * Validate that a tile's epoch matches current state.
   * Returns true if tile is still valid, false if stale.
   */
  validateEpoch(epoch: number): boolean {
    return epoch === this.state.epoch;
  }

  /**
   * Validate that a snapshot matches current state.
   * More comprehensive than epoch-only validation.
   */
  validateSnapshot(snapshotId: string): boolean {
    const current = this.captureSnapshot();
    return current.snapshotId === snapshotId;
  }

  // ─────────────────────────────────────────────────────────────────
  // Boundary Detection
  // ─────────────────────────────────────────────────────────────────

  /** Check if zoom is at the maximum boundary */
  isAtMaxZoom(): boolean {
    return Math.abs(this.state.zoom - this.config.maxZoom) < 0.0001;
  }

  /** Check if zoom is at the minimum boundary */
  isAtMinZoom(): boolean {
    return Math.abs(this.state.zoom - this.config.minZoom) < 0.0001;
  }

  // ─────────────────────────────────────────────────────────────────
  // Rebound Detection (for trackpad gesture artifacts)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Check if we're in a rebound window after hitting zoom limits.
   * Trackpads send "rebound" events after hitting max zoom.
   */
  isInReboundWindow(windowMs: number = 600): boolean {
    if (this.state.gesturePhase === 'active') {
      return false;
    }
    const timeSinceGestureEnd = performance.now() - this.gestureEndTime;
    if (timeSinceGestureEnd > windowMs) {
      return false;
    }
    return this.wasAtMaxZoom || this.wasAtMinZoom;
  }

  /** Check if we're in a rebound window after hitting MAX zoom */
  isReboundZoomOut(windowMs: number = 600): boolean {
    if (this.state.gesturePhase === 'active') return false;
    const timeSinceGestureEnd = performance.now() - this.gestureEndTime;
    return timeSinceGestureEnd <= windowMs && this.wasAtMaxZoom;
  }

  /** Check if we're in a rebound window after hitting MIN zoom */
  isReboundZoomIn(windowMs: number = 600): boolean {
    if (this.state.gesturePhase === 'active') return false;
    const timeSinceGestureEnd = performance.now() - this.gestureEndTime;
    return timeSinceGestureEnd <= windowMs && this.wasAtMinZoom;
  }

  // ─────────────────────────────────────────────────────────────────
  // Focal Point API (merged from ScaleStateManager)
  // ─────────────────────────────────────────────────────────────────

  /** Get the current focal point for tile priority ordering */
  getFocalPoint(): Point | null {
    return this.focalPoint;
  }

  /** Set the focal point for radial priority calculations */
  setFocalPoint(point: Point | null, gestureType: 'zoom' | 'pan' | 'idle' = 'idle'): void {
    this.focalPoint = point;
    this.focalPointGestureType = gestureType;
  }

  /**
   * Get tile priority based on radial distance from focal point.
   * amnesia-aqv: Migrated from ScaleStateManager to consolidate zoom state.
   *
   * @param tile Tile coordinate
   * @param tileSize Tile size in CSS pixels (default 256)
   * @param pageLayout Layout info for converting tile coords to canvas coords
   */
  getTilePriority(
    tile: TileCoordinate,
    tileSize: number = 256,
    pageLayout?: { x: number; y: number }
  ): RenderPriority {
    const focal = this.focalPoint;
    if (!focal || this.focalPointGestureType === 'idle') {
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
  // Zoom Snapshot API (merged from ZoomOrchestrator)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get the zoom snapshot captured at gesture start.
   * Used for camera restoration during gesture cancel.
   * Returns null if not in an active gesture.
   */
  getZoomSnapshot(): { zoom: number; focalPoint: Point; camera: { x: number; y: number; z: number }; timestamp: number } | null {
    if (this.state.gesturePhase === 'idle') {
      return null;
    }
    return this.zoomSnapshot;
  }

  /**
   * Check if a zoom gesture is currently active.
   * Alias for isGestureActive() for ZoomOrchestrator compatibility.
   */
  isZoomActive(): boolean {
    return this.isGestureActive();
  }

  /**
   * Track that a specific scale was rendered.
   * Used for quality progression decisions.
   */
  onScaleRendered(scale: number): void {
    this.lastRenderedScale = scale;
  }

  /** Get the last rendered scale */
  getLastRenderedScale(): number {
    return this.lastRenderedScale;
  }

  // ─────────────────────────────────────────────────────────────────
  // Public Gesture Control (for external callers)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Manually start a gesture (for programmatic zoom).
   * Usually gestures start automatically via onZoomGesture().
   */
  startGestureManual(): void {
    if (this.state.gesturePhase === 'idle') {
      this.startGesture();
    }
  }

  /**
   * Manually end a gesture (for programmatic zoom).
   * Usually gestures end automatically via timeout.
   */
  endGestureManual(): void {
    if (this.state.gesturePhase === 'active') {
      this.clearTimers();
      this.endGesture();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Zoom Constraints
  // ─────────────────────────────────────────────────────────────────

  /**
   * Apply zoom constraints with soft or hard mode.
   * Soft mode: rubber-band effect with 30% resistance (during gesture)
   * Hard mode: strict clamping (after gesture settles)
   */
  constrainZoom(zoom: number, soft: boolean = false): number {
    const { minZoom, maxZoom } = this.config;

    if (!soft) {
      return this.clamp(zoom, minZoom, maxZoom);
    }

    // Soft constraint: rubber-band effect
    const resistance = 0.3;
    if (zoom > maxZoom) {
      const overshoot = zoom - maxZoom;
      return maxZoom + overshoot * resistance;
    }
    if (zoom < minZoom) {
      const undershoot = minZoom - zoom;
      return minZoom - undershoot * resistance;
    }
    return zoom;
  }

  // ─────────────────────────────────────────────────────────────────
  // State Write API
  // ─────────────────────────────────────────────────────────────────

  /**
   * Handle zoom gesture input.
   * Called on each wheel/pinch event.
   */
  onZoomGesture(newZoom: number, _focalPoint: Point, camera: Camera): void {
    const clampedZoom = this.clamp(newZoom, this.config.minZoom, this.config.maxZoom);

    // Check for state transition
    const wasIdle = this.state.gesturePhase === 'idle';
    const wasSettling = this.state.gesturePhase === 'settling';

    // Start new gesture if idle, or resume if settling
    if (wasIdle) {
      this.startGesture();
    } else if (wasSettling) {
      this.resumeGesture();
    }

    // Check if zoom actually changed
    const zoomChanged = clampedZoom !== this.state.zoom;
    if (!zoomChanged) {
      // Still reset timer even if zoom didn't change (user is gesturing)
      this.resetGestureEndTimer();
      return;
    }

    // Determine new render mode with hysteresis
    const newRenderMode = this.deriveRenderMode(clampedZoom, this.state.renderMode);
    const modeChanged = newRenderMode !== this.state.renderMode;

    // Update state
    this.state = {
      zoom: clampedZoom,
      epoch: this.state.epoch + 1, // Increment on zoom change
      position: { x: camera.x, y: camera.y },
      gesturePhase: 'active',
      renderMode: newRenderMode,
    };

    if (modeChanged) {
      console.log(`[ZoomScaleService] Mode changed: ${this.state.renderMode} at zoom=${clampedZoom.toFixed(2)}`);
      this.onRenderModeChange?.(newRenderMode);
    }

    // Reset gesture end timer
    this.resetGestureEndTimer();
    this.notifyListeners();
  }

  /**
   * Sync state from camera (for pan operations that don't go through onZoomGesture)
   */
  syncFromCamera(camera: Camera): void {
    const zoomChanged = camera.z !== this.state.zoom;
    const positionChanged = camera.x !== this.state.position.x || camera.y !== this.state.position.y;

    if (!zoomChanged && !positionChanged) return;

    const newRenderMode = zoomChanged
      ? this.deriveRenderMode(camera.z, this.state.renderMode)
      : this.state.renderMode;

    this.state = {
      zoom: camera.z,
      epoch: zoomChanged ? this.state.epoch + 1 : this.state.epoch,
      position: { x: camera.x, y: camera.y },
      gesturePhase: this.state.gesturePhase,
      renderMode: newRenderMode,
    };

    if (zoomChanged) {
      console.log(`[ZoomScaleService] syncFromCamera: zoom=${camera.z.toFixed(3)}, epoch=${this.state.epoch}`);
    }

    this.notifyListeners();
  }

  /**
   * Explicitly increment the epoch counter.
   * Use for non-zoom events that should invalidate tiles:
   * - Mode transitions
   * - Page navigation
   * - Initial render
   */
  incrementEpoch(): number {
    this.state = {
      ...this.state,
      epoch: this.state.epoch + 1,
    };
    console.log(`[ZoomScaleService] incrementEpoch: epoch=${this.state.epoch}`);
    return this.state.epoch;
  }

  /**
   * Signal ongoing gesture activity.
   * Resets the gesture-end timer without applying zoom change.
   * Use when zoom events are blocked (e.g., by rebound protection).
   */
  signalOngoingActivity(): void {
    if (this.state.gesturePhase === 'idle') {
      this.startGesture();
    }
    this.resetGestureEndTimer();
  }

  /**
   * Mark render phase as complete.
   * Transitions from 'rendering' back to 'idle'.
   */
  completeRenderPhase(): void {
    console.log(`[ZoomScaleService] completeRenderPhase() called, current phase=${this.state.gesturePhase}`);
    
    if (this.state.gesturePhase !== 'rendering') {
      console.warn(`[ZoomScaleService] completeRenderPhase skipped - not in rendering (currently ${this.state.gesturePhase})`);
      return;
    }

    // Clear watchdog - we're successfully transitioning to idle
    this.clearPhaseWatchdog();
    
    // Clear zoom snapshot - gesture cycle is complete
    this.zoomSnapshot = null;
    
    this.state = {
      ...this.state,
      gesturePhase: 'idle',
    };
    setGesturePhase('idle'); // amnesia-e4i: Update semaphore policy

    console.log('[ZoomScaleService] Render phase complete, now idle');
    this.notifyListeners();
  }
  
  /**
   * Force transition to idle state (amnesia-e4i: escape hatch for stuck states)
   * Called by watchdog when phase is stuck for too long.
   */
  forceIdleState(reason: string): void {
    const previousPhase = this.state.gesturePhase;
    console.warn(`[ZoomScaleService] FORCE IDLE: ${reason} (was in ${previousPhase})`);
    
    this.clearTimers();
    this.clearPhaseWatchdog();
    this.state = { ...this.state, gesturePhase: 'idle' };
    setGesturePhase('idle');
    this.notifyListeners();
  }
  
  /**
   * Start watchdog timer for stuck phases (amnesia-e4i)
   * If the phase doesn't transition to idle within timeout, force idle.
   */
  private startPhaseWatchdog(expectedPhase: GesturePhase): void {
    this.clearPhaseWatchdog();
    
    this.phaseWatchdog = setTimeout(() => {
      this.phaseWatchdog = null;
      
      // Only force idle if we're still in a non-idle phase
      if (this.state.gesturePhase !== 'idle') {
        console.error(`[ZoomScaleService] WATCHDOG TRIGGERED: stuck in '${this.state.gesturePhase}' for ${ZoomScaleService.PHASE_WATCHDOG_TIMEOUT_MS}ms (expected: ${expectedPhase})`);
        this.forceIdleState(`watchdog: stuck in ${this.state.gesturePhase}`);
      }
    }, ZoomScaleService.PHASE_WATCHDOG_TIMEOUT_MS);
  }
  
  /**
   * Clear the watchdog timer
   */
  private clearPhaseWatchdog(): void {
    if (this.phaseWatchdog) {
      clearTimeout(this.phaseWatchdog);
      this.phaseWatchdog = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Gesture State Machine (internal)
  // ─────────────────────────────────────────────────────────────────

  private startGesture(): void {
    console.log('[ZoomScaleService] Gesture started');
    this.clearTimers();
    
    // Capture zoom snapshot at gesture start (merged from ZoomOrchestrator)
    this.zoomSnapshot = {
      zoom: this.state.zoom,
      focalPoint: this.focalPoint ?? { x: 0, y: 0 },
      camera: { x: this.state.position.x, y: this.state.position.y, z: this.state.zoom },
      timestamp: performance.now(),
    };
    
    this.state = { ...this.state, gesturePhase: 'active' };
    setGesturePhase('active'); // amnesia-e4i: Update semaphore policy
    this.onGestureStart?.();
    this.notifyListeners();
  }

  private resumeGesture(): void {
    console.log('[ZoomScaleService] Resuming gesture from settling');
    if (this.settlingTimer) {
      clearTimeout(this.settlingTimer);
      this.settlingTimer = null;
    }
    this.state = { ...this.state, gesturePhase: 'active' };
    setGesturePhase('active'); // amnesia-e4i: Update semaphore policy
    this.notifyListeners();
  }

  private endGesture(): void {
    if (this.state.gesturePhase !== 'active') return;

    console.log('[ZoomScaleService] Gesture ended, entering settling');

    // Record rebound detection state
    this.gestureEndTime = performance.now();
    this.wasAtMaxZoom = this.isAtMaxZoom();
    this.wasAtMinZoom = this.isAtMinZoom();

    this.state = { ...this.state, gesturePhase: 'settling' };
    setGesturePhase('settling'); // amnesia-e4i: Update semaphore policy
    this.onGestureEnd?.();

    // Schedule settling -> rendering transition
    this.settlingTimer = setTimeout(() => {
      this.settlingTimer = null;
      this.completeSettling();
    }, this.config.settlingDelay);

    // amnesia-e4i: Start watchdog timer for stuck phases
    this.startPhaseWatchdog('settling');

    this.notifyListeners();
  }

  private completeSettling(): void {
    console.log(`[ZoomScaleService] completeSettling() called, current phase=${this.state.gesturePhase}`);
    
    if (this.state.gesturePhase !== 'settling') {
      console.warn(`[ZoomScaleService] completeSettling skipped - not in settling (currently ${this.state.gesturePhase})`);
      return;
    }

    console.log('[ZoomScaleService] Settling complete, triggering final render');

    this.state = { ...this.state, gesturePhase: 'rendering' };
    setGesturePhase('rendering'); // amnesia-e4i: Update semaphore policy

    const { scale } = this.getScale();
    
    if (this.onSettlingComplete) {
      console.log(`[ZoomScaleService] Calling onSettlingComplete callback (scale=${scale}, zoom=${this.state.zoom.toFixed(2)})`);
      this.onSettlingComplete(scale, this.state.zoom);
    } else {
      console.warn('[ZoomScaleService] No onSettlingComplete callback registered!');
    }

    this.notifyListeners();
  }

  private resetGestureEndTimer(): void {
    if (this.gestureEndTimer) {
      clearTimeout(this.gestureEndTimer);
    }
    this.gestureEndTimer = setTimeout(() => {
      this.gestureEndTimer = null;
      this.endGesture();
    }, this.config.gestureEndDelay);
  }

  private clearTimers(): void {
    if (this.gestureEndTimer) {
      clearTimeout(this.gestureEndTimer);
      this.gestureEndTimer = null;
    }
    if (this.settlingTimer) {
      clearTimeout(this.settlingTimer);
      this.settlingTimer = null;
    }
    // Also clear watchdog (amnesia-e4i)
    this.clearPhaseWatchdog();
  }

  // ─────────────────────────────────────────────────────────────────
  // Render Mode Derivation (with hysteresis)
  // ─────────────────────────────────────────────────────────────────

  private deriveRenderMode(zoom: number, currentMode: RenderMode): RenderMode {
    const { FULL_TO_ADAPTIVE, ADAPTIVE_TO_TILED, HYSTERESIS } = RENDER_MODE_THRESHOLDS;

    if (currentMode === 'full-page') {
      if (zoom > FULL_TO_ADAPTIVE * (1 + HYSTERESIS)) {
        if (zoom > ADAPTIVE_TO_TILED * (1 + HYSTERESIS)) {
          return 'tiled';
        }
        return 'adaptive';
      }
      return 'full-page';
    }

    if (currentMode === 'adaptive') {
      if (zoom < FULL_TO_ADAPTIVE * (1 - HYSTERESIS)) {
        return 'full-page';
      }
      if (zoom > ADAPTIVE_TO_TILED * (1 + HYSTERESIS)) {
        return 'tiled';
      }
      return 'adaptive';
    }

    if (currentMode === 'tiled') {
      if (zoom < ADAPTIVE_TO_TILED * (1 - HYSTERESIS)) {
        if (zoom < FULL_TO_ADAPTIVE * (1 - HYSTERESIS)) {
          return 'full-page';
        }
        return 'adaptive';
      }
      return 'tiled';
    }

    return currentMode;
  }

  // ─────────────────────────────────────────────────────────────────
  // Subscription
  // ─────────────────────────────────────────────────────────────────

  subscribe(listener: (state: ZoomScaleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const snapshot = { ...this.state };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (e) {
        console.error('[ZoomScaleService] Listener error:', e);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  /** Get the camera as a Camera object (for compatibility) */
  getCamera(): Camera {
    return {
      x: this.state.position.x,
      y: this.state.position.y,
      z: this.state.zoom,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  destroy(): void {
    this.clearTimers();
    this.listeners.clear();
    this.onGestureStart = null;
    this.onGestureEnd = null;
    this.onSettlingComplete = null;
    this.onRenderModeChange = null;
    this.focalPoint = null;
    this.zoomSnapshot = null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Singleton Management
// ─────────────────────────────────────────────────────────────────

let serviceInstance: ZoomScaleService | null = null;

/** Get the shared ZoomScaleService instance */
export function getZoomScaleService(): ZoomScaleService | null {
  return serviceInstance;
}

/** Create and set the shared ZoomScaleService instance */
export function createZoomScaleService(config: ZoomScaleServiceConfig): ZoomScaleService {
  if (serviceInstance) {
    serviceInstance.destroy();
  }
  serviceInstance = new ZoomScaleService(config);
  return serviceInstance;
}

/** Clear the shared ZoomScaleService instance */
export function clearZoomScaleService(): void {
  if (serviceInstance) {
    serviceInstance.destroy();
    serviceInstance = null;
  }
}

/**
 * Get global zoom config from the singleton service.
 * Returns null if no service is initialized.
 * Used by getTargetScaleTier when maxZoom is not explicitly provided.
 */
export function getGlobalZoomConfig(): { maxZoom: number; pixelRatio: number } | null {
  if (!serviceInstance) return null;
  return {
    maxZoom: serviceInstance.getMaxZoom(),
    pixelRatio: serviceInstance.getPixelRatio(),
  };
}

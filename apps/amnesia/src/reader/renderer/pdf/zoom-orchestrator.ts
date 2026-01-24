/**
 * Zoom Orchestrator
 *
 * Unified zoom state management combining state machine logic with progressive
 * rendering scheduling. This is the single source of truth for zoom state.
 *
 * State Flow:
 * ```
 * IDLE ──[wheel/pinch]──> ZOOMING ──[150ms quiet]──> SETTLING ──[ready]──> RENDERING ──[complete]──> IDLE
 *   ^                         │                          │                      │
 *   └─────[abort]─────────────┴──────[abort]─────────────┴────────[abort]──────┘
 * ```
 *
 * Key Features:
 * - `canRender()` - Single guard function for all render paths
 * - Snapshot management - Captures camera state at gesture start
 * - Abort coordination - Cancels in-flight renders on new gestures
 * - Progressive rendering - Schedules intermediate → final quality
 *
 * Note: CSS transforms are NOT handled here - the camera system owns them.
 * ZoomOrchestrator only tracks state and schedules renders.
 *
 * @deprecated Use ZoomStateManager instead for new code (amnesia-owf).
 * ZoomOrchestrator will be removed in a future version. ZoomStateManager provides:
 * - Correct epoch logic (increments on every zoom change, not just gesture start)
 * - Built-in rebound detection for trackpad gestures
 * - Soft/hard constraint support for natural rubber-band effects
 * - Single source of truth without distributed state
 *
 * Migration: Replace orchestrator.onZoomGesture() with zoomStateManager.syncFromCamera()
 *
 * @example
 * ```typescript
 * const orchestrator = new ZoomOrchestrator(renderCoordinator, pixelRatio);
 *
 * // On zoom gesture
 * orchestrator.onZoomGesture(zoom, focalPoint, camera);
 *
 * // In render methods
 * if (!orchestrator.canRender()) return; // Skip if zooming
 * ```
 */

import type { Point, Camera } from './pdf-canvas-camera';
import type { RenderCoordinator } from './render-coordinator';
import {
  getTargetScaleTier,
  getExactTargetScale,
  getIntermediateScale,
  type ScaleTier,
} from './progressive-tile-renderer';
import { isFeatureEnabled } from './feature-flags';
import { getTelemetry } from './pdf-telemetry';

/**
 * Zoom state phases
 */
export type ZoomState = 'idle' | 'zooming' | 'settling' | 'rendering';

/**
 * Render phase for progressive rendering
 */
export type RenderPhase = 'immediate' | 'intermediate' | 'final';

/**
 * Snapshot of camera state at zoom gesture start
 */
export interface ZoomSnapshot {
  /** Zoom level at snapshot time */
  zoom: number;
  /** Focal point of zoom gesture (screen coordinates) */
  focalPoint: Point;
  /** Camera state at snapshot time */
  camera: Camera;
  /** Timestamp of snapshot (for debugging) */
  timestamp: number;
}

/**
 * Zoom transform state for quality tracking
 */
export interface ZoomRenderState {
  /** Current display zoom (what user sees) */
  displayZoom: number;
  /** Current render scale (tile quality) */
  renderScale: ScaleTier;
  /** CSS stretch factor (displayZoom * pixelRatio / renderScale) */
  cssStretch: number;
  /** Current render phase */
  phase: RenderPhase;
}

/**
 * Configuration for zoom orchestrator
 */
export interface ZoomOrchestratorConfig {
  /** Time without input before gesture is considered ended (ms) */
  gestureEndDelay: number;
  /** Time to wait after gesture ends before final render (ms) */
  settlingDelay: number;
  /** Delay before intermediate render (ms) */
  intermediateDelay: number;
  /** Minimum zoom change to trigger re-render */
  zoomChangeThreshold: number;
  /** Maximum CSS stretch before forcing immediate render */
  maxCssStretch: number;
  /** Device pixel ratio */
  pixelRatio: number;
  /** Maximum zoom level (optional - used to cap scale tier) */
  maxZoom?: number;
}

const DEFAULT_CONFIG: ZoomOrchestratorConfig = {
  gestureEndDelay: 300,   // 300ms quiet = gesture ended (amnesia-p64: increased from 150ms to prevent premature gesture restarts)
  settlingDelay: 200,     // 200ms settling before final render
  intermediateDelay: 50,  // 50ms before intermediate render
  zoomChangeThreshold: 0.1,
  maxCssStretch: 4.0,     // Don't stretch more than 4x (too blurry)
  pixelRatio: window.devicePixelRatio || 2,
};

/**
 * Unified zoom state orchestrator
 *
 * Manages zoom gesture state and progressive rendering scheduling,
 * providing a single point of truth for zoom operations.
 */
export class ZoomOrchestrator {
  /** Current state */
  private state: ZoomState = 'idle';

  /** Camera snapshot captured at gesture start */
  private snapshot: ZoomSnapshot | null = null;

  /** Timer for gesture end detection */
  private gestureEndTimer: ReturnType<typeof setTimeout> | null = null;

  /** Timer for settling period / final render */
  private settlingTimer: ReturnType<typeof setTimeout> | null = null;

  /** Timer for intermediate render */
  private intermediateTimer: ReturnType<typeof setTimeout> | null = null;

  /** Current abort controller for render phase */
  private currentAbort: AbortController | null = null;

  /** Configuration */
  private config: ZoomOrchestratorConfig;

  /** Timestamp when we entered 'rendering' state (for rebound detection) */
  private renderingStartTime: number = 0;

  /** Render quality state */
  private renderState: ZoomRenderState;

  /**
   * Callback invoked when a render phase should begin.
   * Set by the canvas to trigger actual rendering.
   * Note: scale can be either a ScaleTier (tier-based) or any number (exact scale mode)
   */
  onRenderPhase: ((phase: RenderPhase, scale: number, zoom: number) => void) | null = null;

  /**
   * Callback invoked when a zoom gesture starts.
   * Used by the canvas to freeze cssStretch values for visual stability.
   */
  onZoomStart: (() => void) | null = null;

  /**
   * Callback invoked when a zoom gesture ends (amnesia-5so).
   * Used to sync gesture state to ZoomStateManager for rebound detection.
   * Called after 150ms of no zoom activity (gesture end detection).
   */
  onGestureEnd: (() => void) | null = null;

  constructor(
    private renderCoordinator: RenderCoordinator | null,
    config?: Partial<ZoomOrchestratorConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize render state at 1x zoom
    const { tier: initialScale, cssStretch: initialStretch } = getTargetScaleTier(1, this.config.pixelRatio, this.config.maxZoom);
    this.renderState = {
      displayZoom: 1,
      renderScale: initialScale,
      cssStretch: initialStretch,
      phase: 'final',
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get target scale for a given zoom level.
   *
   * When `useExactScaleRendering` feature flag is enabled, returns exact
   * zoom × pixelRatio scale with cssStretch to compensate when scale is capped.
   *
   * Otherwise, returns quantized tier with cssStretch for fallback tiles.
   */
  private getTargetScale(zoom: number): { scale: number; cssStretch: number } {
    if (isFeatureEnabled('useExactScaleRendering')) {
      // FIX (2026-01-22): Return cssStretch from getExactTargetScale instead of hardcoding 1.
      // When scale is capped at max zoom, cssStretch compensates so content appears correctly.
      // FIX (amnesia-d9f): Pass maxZoom to ensure proper scale cap
      const { scale, cssStretch } = getExactTargetScale(zoom, this.config.pixelRatio, this.config.maxZoom);
      return { scale, cssStretch };
    } else {
      // FIX (2026-01-23): Pass maxZoom to prevent scale jumps at zoom boundaries
      const { tier, cssStretch } = getTargetScaleTier(zoom, this.config.pixelRatio, this.config.maxZoom);
      return { scale: tier, cssStretch };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // State Queries
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get current state
   */
  getCurrentState(): ZoomState {
    return this.state;
  }

  /**
   * Check if rendering is allowed in current state.
   *
   * Returns false during 'zooming' and 'settling' phases to prevent
   * renders from executing while the user is actively zooming.
   *
   * This is the SINGLE guard function that all render paths must check.
   */
  canRender(): boolean {
    return this.state === 'idle' || this.state === 'rendering';
  }

  /**
   * Get the zoom snapshot captured at gesture start.
   *
   * Returns null unless actively zooming (state is 'zooming').
   * Use this for consistent camera state during render calculations.
   *
   * BUG FIX (2026-01-22): Previously returned stale snapshot in all non-idle states,
   * causing NO OVERLAP errors when viewport was calculated from outdated camera
   * position. Now only returns snapshot during 'zooming' state - when we need to
   * defer rendering. In 'settling', 'rendering', and 'idle' states, returns null
   * to force use of current camera which has already settled to its final position.
   */
  getZoomSnapshot(): ZoomSnapshot | null {
    // Only return snapshot when actively zooming
    // In 'settling', 'rendering', and 'idle' states, use current camera
    // because the camera has already moved to its final position
    if (this.state !== 'zooming') {
      return null;
    }
    return this.snapshot;
  }

  /**
   * Get current render state (displayZoom, renderScale, cssStretch)
   */
  getRenderState(): Readonly<ZoomRenderState> {
    return { ...this.renderState };
  }

  /**
   * Check if currently in a zoom gesture (zooming or settling)
   */
  isZoomActive(): boolean {
    return this.state === 'zooming' || this.state === 'settling';
  }

  // ─────────────────────────────────────────────────────────────────
  // Zoom Gesture Handling
  // ─────────────────────────────────────────────────────────────────

  /**
   * Handle zoom gesture input.
   *
   * Called on each zoom input (wheel/pinch). Manages state transitions,
   * camera snapshots, and schedules progressive renders.
   *
   * @param zoom Current zoom level
   * @param focalPoint Center point of zoom gesture (screen coords)
   * @param camera Current camera state
   */
  onZoomGesture(zoom: number, focalPoint: Point, camera: Camera): void {
    console.log(`[ZoomOrchestrator] onZoomGesture: zoom=${zoom.toFixed(2)}, state=${this.state}`);

    // Calculate zoom change from last known display zoom
    const zoomDelta = Math.abs(zoom - this.renderState.displayZoom);

    // If this is the start of a new gesture
    if (this.state === 'idle') {
      this.startZoomGesture(zoom, focalPoint, camera);
    } else if (this.state === 'zooming') {
      // Continue existing gesture
      this.updateZoomGesture(zoom, focalPoint, camera);
    } else if (this.state === 'settling') {
      // FIX (amnesia-p64): RESUME gesture instead of starting a new one
      // This prevents focal point drift caused by premature gesture restarts.
      //
      // Problem: Trackpad events can have gaps >150ms during continuous pinching
      // (due to main thread stalls, event batching, or finger micro-adjustments).
      // When gestureEndDelay (150ms) expires, we enter settling state, and new
      // events would trigger startZoomGesture() - creating a new snapshot with
      // a potentially different focal point, causing visible "jumps".
      //
      // Solution: Resume the previous gesture context instead of starting fresh.
      // This preserves the original focal point and zoom baseline.
      console.log('[ZoomOrchestrator] Resuming gesture from settling state');
      this.resumeZoomGesture(zoom, focalPoint, camera);
    } else {
      // In rendering state - start a new gesture (user explicitly re-engaged)
      this.startZoomGesture(zoom, focalPoint, camera);
    }

    // Update display zoom
    this.renderState.displayZoom = zoom;

    // Calculate target scale for this zoom (uses exact scale when feature flag enabled)
    const { scale: targetScale, cssStretch: targetCssStretch } = this.getTargetScale(zoom);

    // FIX (2026-01-23): Always use targetCssStretch from getTargetScale to ensure consistency.
    // Previously, non-exact mode used stale renderScale to calculate cssStretch, causing
    // a mismatch between gesture phase and final render (the "zoom jump" bug).
    // By always using targetCssStretch and updating renderScale immediately, we ensure
    // the scale/cssStretch relationship stays coherent throughout the zoom transition.
    this.renderState.cssStretch = targetCssStretch;
    this.renderState.renderScale = targetScale as ScaleTier;

    // Schedule progressive renders if zoom change is significant
    if (zoomDelta >= this.config.zoomChangeThreshold) {
      this.scheduleProgressiveRenders(targetScale);
    }
  }

  /**
   * Start a new zoom gesture.
   *
   * Called when the first zoom input is detected (wheel/pinch).
   * Aborts any in-flight renders and captures camera snapshot.
   */
  private startZoomGesture(zoom: number, focalPoint: Point, camera: Camera): void {
    console.log(`[ZoomOrchestrator] startZoomGesture: zoom=${zoom.toFixed(2)}`);

    // Notify listeners that zoom is starting (for cssStretch freeze)
    this.onZoomStart?.();

    // FIX (2026-01-22): Only abort pending renders if scale changes significantly.
    // Aborting on every zoom gesture causes the 54% coverage bug where tiles are
    // killed mid-render, never reaching completion. In-flight tiles at similar
    // scales are still useful and should complete.
    const { scale: targetScale } = this.getTargetScale(zoom);
    const currentScale = this.renderState.renderScale;
    const scaleRatio = Math.max(targetScale, currentScale) / Math.min(targetScale, currentScale);
    
    // Only abort if scale changed by more than 1.5x (more than one tier)
    // This preserves tiles that are still useful while discarding truly stale ones
    const SCALE_ABORT_THRESHOLD = 1.5;
    const shouldAbort = scaleRatio > SCALE_ABORT_THRESHOLD;
    
    this.abortCurrentPhase();
    if (this.renderCoordinator && shouldAbort) {
      this.renderCoordinator.abortAllPending();
      console.log(`[ZoomOrchestrator] Zoom gesture started: aborting pending renders (scale ratio ${scaleRatio.toFixed(2)} > ${SCALE_ABORT_THRESHOLD})`);
    } else {
      console.log(`[ZoomOrchestrator] Zoom gesture started: preserving in-flight tiles (scale ratio ${scaleRatio.toFixed(2)} <= ${SCALE_ABORT_THRESHOLD})`);
    }

    // Clear any pending timers
    this.clearTimers();

    // Transition to 'zooming' state
    this.setState('zooming');

    // Capture camera snapshot for consistent render calculations
    this.snapshot = {
      zoom,
      focalPoint: { x: focalPoint.x, y: focalPoint.y },
      camera: { x: camera.x, y: camera.y, z: camera.z },
      timestamp: performance.now(),
    };

    // Start gesture end detection timer
    this.resetGestureEndTimer();
  }

  /**
   * Update an ongoing zoom gesture.
   *
   * Called on subsequent zoom inputs during a gesture.
   * Updates the snapshot with latest values and resets the gesture end timer.
   */
  private updateZoomGesture(zoom: number, focalPoint: Point, camera: Camera): void {
    // Update snapshot with latest values
    this.snapshot = {
      zoom,
      focalPoint: { x: focalPoint.x, y: focalPoint.y },
      camera: { x: camera.x, y: camera.y, z: camera.z },
      timestamp: performance.now(),
    };

    // Reset gesture end timer (user is still zooming)
    this.resetGestureEndTimer();
  }

  /**
   * Resume a zoom gesture from settling state (amnesia-p64).
   *
   * Called when new zoom events arrive during the settling phase.
   * Unlike startZoomGesture(), this preserves the original gesture context
   * (focal point and zoom baseline) to prevent visible "jumps".
   *
   * This handles the case where trackpad events have brief gaps (>gestureEndDelay)
   * during what the user perceives as continuous pinching.
   */
  private resumeZoomGesture(zoom: number, focalPoint: Point, camera: Camera): void {
    console.log(`[ZoomOrchestrator] resumeZoomGesture: zoom=${zoom.toFixed(2)}, preserving original snapshot`);

    // Cancel settling timer (user is still interacting)
    if (this.settlingTimer) {
      clearTimeout(this.settlingTimer);
      this.settlingTimer = null;
    }

    // FIX (2026-01-22): Do NOT abort pending renders when resuming from settling.
    // The tiles in-flight were requested for the same gesture context and are
    // likely still valid. Aborting them causes the 54% coverage bug where tiles
    // are killed mid-render during continuous zooming.
    //
    // We only abort the current phase controller (progressive render scheduling),
    // NOT the actual tile renders in the coordinator.
    this.abortCurrentPhase();
    // REMOVED: this.renderCoordinator.abortAllPending();
    console.log('[ZoomOrchestrator] Resumed gesture from settling: preserving in-flight tiles');

    // Transition back to 'zooming' state
    this.setState('zooming');

    // CRITICAL: Do NOT create a new snapshot!
    // Preserve the original focal point to prevent position drift.
    // Only update the zoom value in the existing snapshot.
    if (this.snapshot) {
      this.snapshot.zoom = zoom;
      this.snapshot.camera = { x: camera.x, y: camera.y, z: camera.z };
      this.snapshot.timestamp = performance.now();
      // Focal point intentionally NOT updated - this is the key fix!
    } else {
      // Safety fallback: if no snapshot exists, create one
      console.warn('[ZoomOrchestrator] resumeZoomGesture: no existing snapshot, creating new one');
      this.snapshot = {
        zoom,
        focalPoint: { x: focalPoint.x, y: focalPoint.y },
        camera: { x: camera.x, y: camera.y, z: camera.z },
        timestamp: performance.now(),
      };
    }

    // Restart gesture end detection
    this.resetGestureEndTimer();
  }

  /**
   * Sync displayZoom with actual camera zoom without triggering renders.
   *
   * Use this to keep displayZoom in sync when zoom changes outside of
   * the onZoomGesture path (e.g., after programmatic zoom).
   */
  syncDisplayZoom(zoom: number): void {
    if (zoom <= 0) {
      console.warn('[ZoomOrchestrator] syncDisplayZoom: Invalid zoom value:', zoom);
      return;
    }
    this.renderState.displayZoom = zoom;
    console.log(`[ZoomOrchestrator] syncDisplayZoom: displayZoom synced to ${zoom.toFixed(2)}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Progressive Rendering
  // ─────────────────────────────────────────────────────────────────

  /**
   * Schedule progressive render phases
   *
   * Note: When exact scale rendering is enabled, progressive rendering is skipped
   * since tiles are always rendered at the exact target scale (no fallback tiers).
   */
  private scheduleProgressiveRenders(targetScale: number): void {
    // Cancel any existing schedules
    this.cancelScheduledRenders();

    if (!isFeatureEnabled('useMultiResZoom')) {
      // Feature disabled - will render at final in settling phase
      return;
    }

    // With exact scale rendering, no progressive fallback is needed
    if (isFeatureEnabled('useExactScaleRendering')) {
      return;
    }

    // Check if CSS stretch is too high (too blurry)
    if (this.renderState.cssStretch > this.config.maxCssStretch) {
      // Force immediate intermediate render
      console.log('[ZoomOrchestrator] CSS stretch too high, scheduling immediate intermediate');
      this.scheduleIntermediateRender(targetScale as ScaleTier, 0);
    } else {
      // Schedule normal intermediate render
      const intermediateScale = getIntermediateScale(
        this.renderState.renderScale,
        targetScale as ScaleTier
      );

      if (intermediateScale !== targetScale) {
        this.scheduleIntermediateRender(intermediateScale, this.config.intermediateDelay);
      }
    }
  }

  /**
   * Schedule intermediate quality render
   */
  private scheduleIntermediateRender(scale: ScaleTier, delay: number): void {
    this.intermediateTimer = setTimeout(() => {
      this.intermediateTimer = null;

      if (this.state !== 'zooming') return;

      this.renderState.phase = 'intermediate';
      const zoom = this.snapshot?.zoom ?? this.renderState.displayZoom;
      console.log(`[ZoomOrchestrator] Triggering intermediate render: scale=${scale}, zoom=${zoom.toFixed(2)}`);
      this.onRenderPhase?.('intermediate', scale, zoom);
    }, delay);
  }

  /**
   * Notify that tiles at a specific scale have been rendered
   *
   * Called by the tile renderer when a progressive phase completes.
   * Updates internal state to reflect improved quality.
   */
  onScaleRendered(scale: ScaleTier): void {
    // Only update if this improves our current quality
    if (scale > this.renderState.renderScale) {
      this.renderState.renderScale = scale;

      // Recalculate CSS stretch
      this.renderState.cssStretch =
        (this.renderState.displayZoom * this.config.pixelRatio) / scale;

      // If stretch is now ~1, we're at final quality
      if (this.renderState.cssStretch <= 1.1) {
        this.renderState.cssStretch = 1;
        this.renderState.phase = 'final';
      }

      // Track telemetry
      const telemetry = getTelemetry();
      telemetry.trackCustomMetric('zoomScaleUpgrade', scale);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Render Phase Management
  // ─────────────────────────────────────────────────────────────────

  /**
   * Start a render phase.
   *
   * Called by the render callback to indicate rendering is beginning.
   * Creates an abort controller for this phase.
   */
  startRenderPhase(phase: RenderPhase): void {
    if (this.state !== 'settling' && this.state !== 'rendering') {
      console.warn(`[ZoomOrchestrator] startRenderPhase called in ${this.state} state`);
      return;
    }

    this.setState('rendering');
    this.currentAbort = new AbortController();

    console.log(`[ZoomOrchestrator] Started ${phase} render phase`);
  }

  /**
   * Complete the current render phase.
   *
   * Called when rendering is complete. Transitions back to idle state.
   */
  completeRenderPhase(): void {
    if (this.state !== 'rendering') {
      console.warn(`[ZoomOrchestrator] completeRenderPhase called in ${this.state} state`);
      return;
    }

    console.log('[ZoomOrchestrator] Render phase complete');

    this.setState('idle');
    this.currentAbort = null;
    // Keep snapshot for async renders that need cssStretch reconciliation
  }

  // ─────────────────────────────────────────────────────────────────
  // Abort Coordination
  // ─────────────────────────────────────────────────────────────────

  /**
   * Abort the current render phase.
   */
  abortCurrentPhase(): void {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
  }

  /**
   * Get the abort signal for the current render phase.
   */
  getAbortSignal(): AbortSignal | null {
    return this.currentAbort?.signal ?? null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Reset the gesture end timer.
   */
  private resetGestureEndTimer(): void {
    if (this.gestureEndTimer) {
      clearTimeout(this.gestureEndTimer);
    }

    this.gestureEndTimer = setTimeout(() => {
      this.gestureEndTimer = null;
      this.endZoomGesture();
    }, this.config.gestureEndDelay);
  }

  /**
   * Signal ongoing zoom activity without applying a zoom change.
   * 
   * This should be called when zoom events are blocked (e.g., by rebound protection)
   * but the user is still actively gesturing. Without this, the gesture-end timer
   * would fire prematurely, causing tiles to render with a stale snapshot while
   * the camera continues moving - resulting in a visual "jump".
   */
  signalOngoingActivity(): void {
    // Reset the gesture-end timer to prevent premature gesture end
    this.resetGestureEndTimer();
    
    console.log(`[ZoomOrchestrator] signalOngoingActivity: timer reset, state=${this.state}`);
  }

  /**
   * End a zoom gesture.
   * Transitions: zooming → settling → rendering
   */
  private endZoomGesture(): void {
    if (this.state !== 'zooming') {
      return;
    }

    // FIX (2026-01-23): Log the frozen scale/cssStretch values at gesture end.
    // These values were calculated during onZoomGesture() and should NOT be
    // recalculated at settling time. This ensures the visual zoom at gesture end
    // matches the final render exactly (no "zoom jump").
    console.log(`[ZoomOrchestrator] Gesture ended, freezing: scale=${this.renderState.renderScale}, cssStretch=${this.renderState.cssStretch.toFixed(3)}, displayZoom=${this.renderState.displayZoom.toFixed(4)}`);
    this.setState('settling');

    // Notify listeners that gesture has ended (amnesia-5so)
    // This is called before settling completes, enabling rebound detection
    this.onGestureEnd?.();

    // After settling period, transition to rendering and trigger final render
    this.settlingTimer = setTimeout(() => {
      this.settlingTimer = null;

      if (this.state === 'settling') {
        this.setState('rendering');

        // FIX (2026-01-23): Use the scale/cssStretch that was already calculated during
        // the gesture phase instead of recalculating. Recalculating here caused the
        // "zoom jump" bug where the final render used a different scale than the gesture.
        // The renderState was already updated in onZoomGesture(), so we use those frozen values.
        const zoom = this.snapshot?.zoom ?? this.renderState.displayZoom;
        const targetScale = this.renderState.renderScale; // Use already-calculated scale
        const targetCssStretch = this.renderState.cssStretch; // Use already-calculated stretch

        console.log(`[ZoomOrchestrator] Settling complete, triggering final render: scale=${targetScale}, cssStretch=${targetCssStretch.toFixed(3)}, zoom=${zoom.toFixed(2)}`);
        this.renderState.phase = 'final';
        this.onRenderPhase?.('final', targetScale, zoom);
      }
    }, this.config.settlingDelay);
  }

  /**
   * Cancel all scheduled renders
   */
  private cancelScheduledRenders(): void {
    if (this.intermediateTimer) {
      clearTimeout(this.intermediateTimer);
      this.intermediateTimer = null;
    }
  }

  /**
   * Clear all pending timers.
   */
  private clearTimers(): void {
    if (this.gestureEndTimer) {
      clearTimeout(this.gestureEndTimer);
      this.gestureEndTimer = null;
    }
    if (this.settlingTimer) {
      clearTimeout(this.settlingTimer);
      this.settlingTimer = null;
    }
    this.cancelScheduledRenders();
  }

  /**
   * Set state with logging.
   */
  private setState(newState: ZoomState): void {
    const oldState = this.state;
    this.state = newState;

    // Track when we enter 'rendering' state for rebound detection
    if (newState === 'rendering') {
      this.renderingStartTime = performance.now();
    }

    console.log(`[ZoomOrchestrator] State: ${oldState} → ${newState}`);
  }

  /**
   * Check if we're in the "rebound window" - a short period after entering
   * 'rendering' state where zoom-out events are likely trackpad artifacts.
   */
  isInReboundWindow(windowMs: number = 600): boolean {
    if (this.state !== 'rendering') {
      return false;
    }
    const elapsed = performance.now() - this.renderingStartTime;
    return elapsed < windowMs;
  }

  // ─────────────────────────────────────────────────────────────────
  // Direct Zoom (for programmatic zoom)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Set zoom level directly for programmatic zoom.
   *
   * This bypasses the gesture handling and immediately triggers rendering.
   * Use for keyboard zoom, button clicks, etc.
   */
  setZoomDirect(zoom: number, focalPoint: Point, camera: Camera): void {
    console.log(`[ZoomOrchestrator] setZoomDirect: zoom=${zoom.toFixed(2)}`);

    // Update state
    this.snapshot = {
      zoom,
      focalPoint: { x: focalPoint.x, y: focalPoint.y },
      camera: { x: camera.x, y: camera.y, z: camera.z },
      timestamp: performance.now(),
    };
    this.renderState.displayZoom = zoom;

    // Calculate target scale (uses exact scale when feature flag enabled)
    const { scale: targetScale, cssStretch } = this.getTargetScale(zoom);
    this.renderState.renderScale = targetScale as ScaleTier;
    this.renderState.cssStretch = cssStretch;
    this.renderState.phase = 'final';

    // Go through the state machine flow
    this.startZoomGesture(zoom, focalPoint, camera);
    this.endZoomGesture();
  }

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.clearTimers();
    this.abortCurrentPhase();
    this.snapshot = null;
    this.onRenderPhase = null;
    this.onZoomStart = null;
    this.onGestureEnd = null;
  }
}

/**
 * Calculate the quality degradation factor for a given CSS stretch.
 *
 * Returns a value from 0-1 indicating how much quality is lost.
 * 0 = perfect quality (no stretch)
 * 1 = maximum acceptable stretch
 */
export function getQualityDegradation(
  cssStretch: number,
  maxStretch: number = 4.0
): number {
  if (cssStretch <= 1) return 0;
  return Math.min(1, (cssStretch - 1) / (maxStretch - 1));
}

/**
 * Determine if a zoom change should trigger progressive rendering.
 *
 * When using exact scale rendering, always returns false since there's no
 * tier-based fallback system - tiles are rendered at exact target scale.
 *
 * When using tier-based rendering, returns true if the scale tier changes.
 *
 * @param fromZoom Starting zoom level
 * @param toZoom Target zoom level
 * @param pixelRatio Device pixel ratio
 * @param maxZoom Optional maximum zoom level to cap scale tier
 */
export function shouldUseProgressiveZoom(
  fromZoom: number,
  toZoom: number,
  pixelRatio: number,
  maxZoom?: number
): boolean {
  if (!isFeatureEnabled('useMultiResZoom')) {
    return false;
  }

  // With exact scale rendering, no progressive fallback is needed
  // since tiles are always at the exact target scale
  if (isFeatureEnabled('useExactScaleRendering')) {
    return false;
  }

  // FIX (2026-01-23): Pass maxZoom to prevent scale jumps at zoom boundaries
  const { tier: fromScale } = getTargetScaleTier(fromZoom, pixelRatio, maxZoom);
  const { tier: toScale } = getTargetScaleTier(toZoom, pixelRatio, maxZoom);

  // If scale tier changes, use progressive
  return fromScale !== toScale;
}

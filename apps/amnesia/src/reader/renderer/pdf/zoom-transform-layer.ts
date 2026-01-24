/**
 * Zoom Transform Layer
 *
 * Manages progressive zoom rendering with timing-based phases.
 * This class handles:
 * - Gesture timing (immediate → intermediate → final)
 * - Progressive render scheduling based on gesture state
 *
 * ## Responsibility Boundary (amnesia-kuj)
 *
 * ZoomTransformLayer is responsible for TIMING of progressive renders:
 * - When to trigger intermediate renders (after intermediateDelay)
 * - When to trigger final renders (after finalDelay)
 * - Scheduling the immediate → intermediate → final phase progression
 *
 * ZoomTransformLayer is NOT responsible for (handled by other classes):
 * - Zoom state source of truth → ZoomStateManager
 * - Render blocking during zoom → ZoomStateMachine
 * - Epoch validation → renderVersion in PdfInfiniteCanvas
 * - CSS transforms → Camera system in PdfInfiniteCanvas
 *
 * This class is ONLY instantiated when useMultiResZoom feature flag is enabled.
 *
 * Note: CSS transforms are NOT applied here when disableCssTransforms is true.
 * The camera system owns CSS transforms for instant zoom feedback.
 */

import type { Point } from './pdf-canvas-camera';
import type { ScaleTier } from './progressive-tile-renderer';

/**
 * Zoom phase for progressive rendering
 */
export type ZoomPhase = 'immediate' | 'intermediate' | 'final';

/**
 * Configuration options for ZoomTransformLayer
 */
export interface ZoomTransformLayerOptions {
  /** Device pixel ratio */
  pixelRatio: number;
  /** Delay before intermediate render (ms) */
  intermediateDelay: number;
  /** Delay before final render (ms) */
  finalDelay: number;
  /** If true, CSS transforms are handled externally (by camera system) */
  disableCssTransforms?: boolean;
}

/**
 * Progressive zoom rendering layer
 *
 * Coordinates timing between zoom gestures and tile rendering
 * to provide smooth zoom experience with progressive quality.
 */
export class ZoomTransformLayer {
  private canvas: HTMLElement;
  private options: ZoomTransformLayerOptions;
  private renderCallback: ((scale: ScaleTier, phase: ZoomPhase) => void) | null = null;
  private zoomChangeCallback: ((zoom: number) => void) | null = null;
  private intermediateTimer: ReturnType<typeof setTimeout> | null = null;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;
  private currentZoom = 1;
  private isGestureActive = false;

  constructor(canvas: HTMLElement, options: ZoomTransformLayerOptions) {
    this.canvas = canvas;
    this.options = options;
  }

  /**
   * Set callback for render phase changes
   */
  setRenderCallback(callback: (scale: ScaleTier, phase: ZoomPhase) => void): void {
    this.renderCallback = callback;
  }

  /**
   * Set callback for zoom value changes
   */
  setZoomChangeCallback(callback: (zoom: number) => void): void {
    this.zoomChangeCallback = callback;
  }

  /**
   * Handle zoom gesture input
   *
   * Called on each wheel/pinch event during zoom gesture.
   * Manages timing and triggers render callbacks at appropriate phases.
   */
  onZoomGesture(zoom: number, focalPoint: Point): void {
    const zoomChanged = Math.abs(zoom - this.currentZoom) > 0.001;
    this.currentZoom = zoom;

    // Cancel pending timers on new input
    this.clearTimers();

    if (zoomChanged) {
      this.zoomChangeCallback?.(zoom);
    }

    // Start gesture if not already active
    if (!this.isGestureActive) {
      this.isGestureActive = true;
      // Immediate phase - CSS transform only (handled by camera)
      this.triggerPhase('immediate');
    }

    // Schedule intermediate render
    this.intermediateTimer = setTimeout(() => {
      this.triggerPhase('intermediate');
    }, this.options.intermediateDelay);

    // Schedule final render
    this.finalTimer = setTimeout(() => {
      this.isGestureActive = false;
      this.triggerPhase('final');
    }, this.options.finalDelay);
  }

  /**
   * Notify that a scale tier was rendered
   * Used for quality tracking
   */
  onScaleRendered(scale: ScaleTier): void {
    // Quality tracking - can be extended for metrics
    console.log(`[ZoomTransformLayer] Scale ${scale} rendered`);
  }

  /**
   * Notify that zoom gesture ended
   */
  onZoomGestureEnd(): void {
    this.isGestureActive = false;
  }

  /**
   * Clean up timers and resources
   */
  destroy(): void {
    this.clearTimers();
    this.renderCallback = null;
    this.zoomChangeCallback = null;
  }

  private clearTimers(): void {
    if (this.intermediateTimer) {
      clearTimeout(this.intermediateTimer);
      this.intermediateTimer = null;
    }
    if (this.finalTimer) {
      clearTimeout(this.finalTimer);
      this.finalTimer = null;
    }
  }

  private triggerPhase(phase: ZoomPhase): void {
    // Calculate scale tier for current zoom
    const pixelRatio = this.options.pixelRatio;
    const minRequired = this.currentZoom * pixelRatio;
    const tiers: ScaleTier[] = [2, 3, 4, 6, 8, 12, 16, 24, 32];
    const scale = tiers.find(t => t >= minRequired) ?? 32;

    this.renderCallback?.(scale, phase);
  }
}

/**
 * Coordinate Debugger for V4 Unified Coordinate Space Architecture
 *
 * Provides instrumentation to validate coordinate math at every operation.
 * Records snapshots of camera state, visibility calculations, pan operations,
 * and constraint applications for debugging zoom/coordinate issues.
 *
 * Usage:
 * - Access via `window.pdfCoordinateDebugger` in console
 * - Query snapshots: `getSnapshots({ operation: 'visibility' })`
 * - Get failures: `getValidationFailures()`
 * - Export trace: `exportToJSON()`
 *
 * @example
 * ```typescript
 * const debugger = getCoordinateDebugger();
 * debugger.recordVisibility({
 *   inputs: { camera, viewport, unifiedMode },
 *   outputs: { visibleBounds, pageCount }
 * });
 * ```
 */

import type { Camera } from './pdf-canvas-camera';

// ============================================================================
// TYPES
// ============================================================================

export type OperationType =
  | 'zoom' | 'pan' | 'visibility' | 'tile' | 'constraint'
  // Render pipeline events (for tracing the zoom bump)
  | 'render-request' | 'render-complete' | 'canvas-update' | 'transform-apply' | 'cssStretch-change';

export interface CoordinateSnapshot {
  timestamp: number;
  operation: OperationType;
  unifiedMode: boolean;
  camera: { x: number; y: number; z: number };
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  validation?: ValidationResult;
}

export interface ValidationResult {
  passed: boolean;
  message?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface SnapshotFilter {
  operation?: OperationType;
  failed?: boolean;
  since?: number;
  limit?: number;
}

export interface ZoomInputs {
  point: { x: number; y: number };
  delta: number;
  cameraBefore: Camera;
  unifiedMode: boolean;
}

export interface ZoomOutputs {
  cameraAfter: Camera;
  pagesResized: number;
  canvasBoundsAfter?: { width: number; height: number };
}

export interface PanInputs {
  dx: number;
  dy: number;
  invertSign: boolean;
  unifiedMode: boolean;
}

export interface PanOutputs {
  camera: Camera;
}

export interface VisibilityInputs {
  camera: Camera;
  viewportWidth: number;
  viewportHeight: number;
  unifiedMode: boolean;
}

export interface VisibilityOutputs {
  visibleBounds: { x: number; y: number; width: number; height: number };
  pageCount: number;
}

export interface ConstraintInputs {
  cameraBefore: Camera;
  canvasBounds: { width: number; height: number };
  viewportWidth: number;
  viewportHeight: number;
  unifiedMode: boolean;
}

export interface ConstraintOutputs {
  cameraAfter: Camera;
  constrained: boolean;
  constraintType?: 'x' | 'y' | 'both' | 'none';
}

export interface TileInputs {
  page: number;
  tileX: number;
  tileY: number;
  zoom: number;
  unifiedMode: boolean;
}

export interface TileOutputs {
  worldX: number;
  worldY: number;
  screenX: number;
  screenY: number;
  tileSize: number;
}

// ============================================================================
// RENDER PIPELINE TYPES (for tracing the zoom bump)
// ============================================================================

export interface RenderRequestInputs {
  page: number;
  scale: number;
  tileCount: number;
  zoom: number;
  source: 'zoom' | 'scroll' | 'initial' | 'prefetch';
}

export interface RenderCompleteInputs {
  page: number;
  scale: number;
  tileCount: number;
  fromCache: boolean;
  renderTimeMs: number;
}

export interface CanvasUpdateInputs {
  page: number;
  tileCount: number;
  avgCssStretch: number;
  canvasWidth: number;
  canvasHeight: number;
}

export interface TransformApplyInputs {
  page: number;
  transform: string;
  cssStretch: number;
  fitScale: number;
  offsetX: number;
  offsetY: number;
}

export interface CssStretchChangeInputs {
  page: number;
  previousStretch: number;
  newStretch: number;
  tileScales: number[];
  requestedScale: number;
}

// ============================================================================
// COORDINATE DEBUGGER CLASS
// ============================================================================

export class CoordinateDebugger {
  private snapshots: CoordinateSnapshot[] = [];
  private readonly maxSnapshots: number;
  private enabled: boolean;
  private autoDisableThreshold: number;
  private autoDisableWindowMs: number;
  private lastWarningTime: number = 0;
  private readonly warningThrottleMs: number = 1000; // Throttle warnings to 1 per second

  /**
   * Callback invoked when validation fails.
   * Can be used to auto-disable unified mode on excessive failures.
   */
  public onValidationFailure: ((snapshot: CoordinateSnapshot) => void) | null = null;

  constructor(options: {
    maxSnapshots?: number;
    enabled?: boolean;
    autoDisableThreshold?: number;
    autoDisableWindowMs?: number;
  } = {}) {
    this.maxSnapshots = options.maxSnapshots ?? 500;
    this.enabled = options.enabled ?? true;
    this.autoDisableThreshold = options.autoDisableThreshold ?? 10;
    this.autoDisableWindowMs = options.autoDisableWindowMs ?? 60000;
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clear(): void {
    this.snapshots = [];
  }

  // --------------------------------------------------------------------------
  // Recording Methods
  // --------------------------------------------------------------------------

  recordZoom(inputs: ZoomInputs, outputs: ZoomOutputs): void {
    if (!this.enabled) return;

    const validation = this.validateZoom(inputs, outputs);

    this.addSnapshot({
      timestamp: Date.now(),
      operation: 'zoom',
      unifiedMode: inputs.unifiedMode,
      camera: { ...outputs.cameraAfter },
      inputs: inputs as unknown as Record<string, unknown>,
      outputs: outputs as unknown as Record<string, unknown>,
      validation,
    });
  }

  recordPan(inputs: PanInputs, outputs: PanOutputs): void {
    if (!this.enabled) return;

    const validation = this.validatePan(inputs, outputs);

    this.addSnapshot({
      timestamp: Date.now(),
      operation: 'pan',
      unifiedMode: inputs.unifiedMode,
      camera: { ...outputs.camera },
      inputs: inputs as unknown as Record<string, unknown>,
      outputs: outputs as unknown as Record<string, unknown>,
      validation,
    });
  }

  recordVisibility(inputs: VisibilityInputs, outputs: VisibilityOutputs): void {
    if (!this.enabled) return;

    const validation = this.validateVisibility(inputs, outputs);

    this.addSnapshot({
      timestamp: Date.now(),
      operation: 'visibility',
      unifiedMode: inputs.unifiedMode,
      camera: { ...inputs.camera },
      inputs: inputs as unknown as Record<string, unknown>,
      outputs: outputs as unknown as Record<string, unknown>,
      validation,
    });
  }

  recordConstraint(inputs: ConstraintInputs, outputs: ConstraintOutputs): void {
    if (!this.enabled) return;

    const validation = this.validateConstraint(inputs, outputs);

    this.addSnapshot({
      timestamp: Date.now(),
      operation: 'constraint',
      unifiedMode: inputs.unifiedMode,
      camera: { ...outputs.cameraAfter },
      inputs: inputs as unknown as Record<string, unknown>,
      outputs: outputs as unknown as Record<string, unknown>,
      validation,
    });
  }

  recordTilePosition(inputs: TileInputs, outputs: TileOutputs): void {
    if (!this.enabled) return;

    const validation = this.validateTilePosition(inputs, outputs);

    this.addSnapshot({
      timestamp: Date.now(),
      operation: 'tile',
      unifiedMode: inputs.unifiedMode,
      camera: { x: 0, y: 0, z: inputs.zoom }, // Tile doesn't have full camera
      inputs: inputs as unknown as Record<string, unknown>,
      outputs: outputs as unknown as Record<string, unknown>,
      validation,
    });
  }

  // --------------------------------------------------------------------------
  // Render Pipeline Recording Methods (for tracing the zoom bump)
  // --------------------------------------------------------------------------

  /**
   * Record when tiles are requested for a page.
   * Call this when a render request is queued.
   */
  recordRenderRequest(inputs: RenderRequestInputs): void {
    if (!this.enabled) return;

    this.addSnapshot({
      timestamp: Date.now(),
      operation: 'render-request',
      unifiedMode: false, // Not relevant for render tracking
      camera: { x: 0, y: 0, z: inputs.zoom },
      inputs: inputs as unknown as Record<string, unknown>,
      outputs: {},
    });
  }

  /**
   * Record when tiles finish rendering (from cache or fresh).
   * Call this when tiles are ready to be drawn.
   */
  recordRenderComplete(inputs: RenderCompleteInputs): void {
    if (!this.enabled) return;

    this.addSnapshot({
      timestamp: Date.now(),
      operation: 'render-complete',
      unifiedMode: false,
      camera: { x: 0, y: 0, z: inputs.scale },
      inputs: inputs as unknown as Record<string, unknown>,
      outputs: { renderTimeMs: inputs.renderTimeMs, fromCache: inputs.fromCache },
    });
  }

  /**
   * Record when canvas is updated with tiles.
   * Call this when tiles are drawn to the canvas context.
   */
  recordCanvasUpdate(inputs: CanvasUpdateInputs): void {
    if (!this.enabled) return;

    const validation = this.validateCssStretch(inputs.avgCssStretch);

    this.addSnapshot({
      timestamp: Date.now(),
      operation: 'canvas-update',
      unifiedMode: false,
      camera: { x: 0, y: 0, z: 1 },
      inputs: inputs as unknown as Record<string, unknown>,
      outputs: { validation: validation.message ?? 'ok' },
      validation,
    });
  }

  /**
   * Record when CSS transform is applied to a page element.
   * This is where the "bump" manifests visually.
   */
  recordTransformApply(inputs: TransformApplyInputs): void {
    if (!this.enabled) return;

    const validation = this.validateTransform(inputs);

    this.addSnapshot({
      timestamp: Date.now(),
      operation: 'transform-apply',
      unifiedMode: false,
      camera: { x: inputs.offsetX, y: inputs.offsetY, z: inputs.cssStretch },
      inputs: inputs as unknown as Record<string, unknown>,
      outputs: { transform: inputs.transform },
      validation,
    });
  }

  /**
   * Record when cssStretch value changes.
   * This is the most likely source of the "bump" - a sudden change in cssStretch.
   */
  recordCssStretchChange(inputs: CssStretchChangeInputs): void {
    if (!this.enabled) return;

    const delta = Math.abs(inputs.newStretch - inputs.previousStretch);
    const validation: ValidationResult = delta > 0.1
      ? {
          passed: false,
          message: `Large cssStretch change: ${inputs.previousStretch.toFixed(3)} → ${inputs.newStretch.toFixed(3)} (Δ${delta.toFixed(3)})`,
          expected: 'Δ < 0.1',
          actual: delta,
        }
      : { passed: true };

    this.addSnapshot({
      timestamp: Date.now(),
      operation: 'cssStretch-change',
      unifiedMode: false,
      camera: { x: 0, y: 0, z: inputs.requestedScale },
      inputs: inputs as unknown as Record<string, unknown>,
      outputs: { delta, significantChange: delta > 0.1 },
      validation,
    });

    // Log significant cssStretch changes immediately for visibility
    if (delta > 0.1) {
      console.warn(
        `[RenderPipeline] SIGNIFICANT cssStretch change on page ${inputs.page}: ` +
        `${inputs.previousStretch.toFixed(3)} → ${inputs.newStretch.toFixed(3)} ` +
        `(tiles at scales: ${inputs.tileScales.join(', ')})`
      );
    }
  }

  // --------------------------------------------------------------------------
  // Validation Methods
  // --------------------------------------------------------------------------

  private validateCssStretch(cssStretch: number): ValidationResult {
    if (!isFinite(cssStretch) || cssStretch <= 0) {
      return {
        passed: false,
        message: `Invalid cssStretch: ${cssStretch}`,
        expected: 'finite and > 0',
        actual: cssStretch,
      };
    }
    if (cssStretch > 4) {
      return {
        passed: false,
        message: `cssStretch too high (${cssStretch.toFixed(2)}x) - indicates severe quality degradation`,
        expected: '< 4',
        actual: cssStretch,
      };
    }
    return { passed: true };
  }

  private validateTransform(inputs: TransformApplyInputs): ValidationResult {
    // Check for NaN or Infinity in offsets
    if (!isFinite(inputs.offsetX) || !isFinite(inputs.offsetY)) {
      return {
        passed: false,
        message: 'Transform has non-finite offsets',
        expected: 'finite offsetX, offsetY',
        actual: { offsetX: inputs.offsetX, offsetY: inputs.offsetY },
      };
    }
    // Check for invalid cssStretch
    if (!isFinite(inputs.cssStretch) || inputs.cssStretch <= 0) {
      return {
        passed: false,
        message: 'Transform has invalid cssStretch',
        expected: 'finite and > 0',
        actual: inputs.cssStretch,
      };
    }
    return { passed: true };
  }

  private validateZoom(inputs: ZoomInputs, outputs: ZoomOutputs): ValidationResult {
    // Check camera values are finite
    if (!isFinite(outputs.cameraAfter.x) || !isFinite(outputs.cameraAfter.y) || !isFinite(outputs.cameraAfter.z)) {
      return {
        passed: false,
        message: 'Camera has non-finite values after zoom',
        expected: 'finite x, y, z',
        actual: outputs.cameraAfter,
      };
    }

    // Check zoom is positive
    if (outputs.cameraAfter.z <= 0) {
      return {
        passed: false,
        message: 'Zoom is non-positive',
        expected: '> 0',
        actual: outputs.cameraAfter.z,
      };
    }

    return { passed: true };
  }

  private validatePan(inputs: PanInputs, outputs: PanOutputs): ValidationResult {
    // Check camera values are finite
    if (!isFinite(outputs.camera.x) || !isFinite(outputs.camera.y)) {
      return {
        passed: false,
        message: 'Camera has non-finite values after pan',
        expected: 'finite x, y',
        actual: outputs.camera,
      };
    }

    return { passed: true };
  }

  private validateVisibility(inputs: VisibilityInputs, outputs: VisibilityOutputs): ValidationResult {
    const { visibleBounds, pageCount } = outputs;

    // Check visible bounds are finite and positive
    if (!isFinite(visibleBounds.x) || !isFinite(visibleBounds.y) ||
        !isFinite(visibleBounds.width) || !isFinite(visibleBounds.height)) {
      return {
        passed: false,
        message: 'Visible bounds have non-finite values',
        expected: 'finite x, y, width, height',
        actual: visibleBounds,
      };
    }

    if (visibleBounds.width <= 0 || visibleBounds.height <= 0) {
      return {
        passed: false,
        message: 'Visible bounds have non-positive dimensions',
        expected: 'width > 0, height > 0',
        actual: { width: visibleBounds.width, height: visibleBounds.height },
      };
    }

    // In unified mode, visible bounds width/height should match viewport
    if (inputs.unifiedMode) {
      const widthMismatch = Math.abs(visibleBounds.width - inputs.viewportWidth) > 1;
      const heightMismatch = Math.abs(visibleBounds.height - inputs.viewportHeight) > 1;

      if (widthMismatch || heightMismatch) {
        return {
          passed: false,
          message: 'Unified mode: visible bounds should match viewport dimensions',
          expected: { width: inputs.viewportWidth, height: inputs.viewportHeight },
          actual: { width: visibleBounds.width, height: visibleBounds.height },
        };
      }
    }

    // Warn if 0 pages visible (not necessarily an error, but suspicious)
    if (pageCount === 0) {
      return {
        passed: true, // Not an error, but record the warning
        message: 'Warning: 0 pages visible',
      };
    }

    return { passed: true };
  }

  private validateConstraint(inputs: ConstraintInputs, outputs: ConstraintOutputs): ValidationResult {
    // Check camera values are finite
    if (!isFinite(outputs.cameraAfter.x) || !isFinite(outputs.cameraAfter.y)) {
      return {
        passed: false,
        message: 'Camera has non-finite values after constraint',
        expected: 'finite x, y',
        actual: outputs.cameraAfter,
      };
    }

    return { passed: true };
  }

  private validateTilePosition(inputs: TileInputs, outputs: TileOutputs): ValidationResult {
    // Check tile positions are finite
    if (!isFinite(outputs.worldX) || !isFinite(outputs.worldY) ||
        !isFinite(outputs.screenX) || !isFinite(outputs.screenY)) {
      return {
        passed: false,
        message: 'Tile has non-finite position values',
        expected: 'finite worldX, worldY, screenX, screenY',
        actual: outputs,
      };
    }

    // Check tile size is positive
    if (outputs.tileSize <= 0) {
      return {
        passed: false,
        message: 'Tile size is non-positive',
        expected: '> 0',
        actual: outputs.tileSize,
      };
    }

    return { passed: true };
  }

  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------

  getSnapshots(filter?: SnapshotFilter): CoordinateSnapshot[] {
    let result = [...this.snapshots];

    if (filter?.operation) {
      result = result.filter(s => s.operation === filter.operation);
    }

    if (filter?.failed) {
      result = result.filter(s => s.validation && !s.validation.passed);
    }

    if (filter?.since) {
      result = result.filter(s => s.timestamp >= filter.since!);
    }

    if (filter?.limit && filter.limit > 0) {
      result = result.slice(-filter.limit);
    }

    return result;
  }

  getValidationFailures(): CoordinateSnapshot[] {
    return this.getSnapshots({ failed: true });
  }

  getRecentFailures(windowMs: number): CoordinateSnapshot[] {
    const since = Date.now() - windowMs;
    return this.getSnapshots({ failed: true, since });
  }

  getLastSnapshot(operation?: OperationType): CoordinateSnapshot | undefined {
    if (operation) {
      const filtered = this.snapshots.filter(s => s.operation === operation);
      return filtered[filtered.length - 1];
    }
    return this.snapshots[this.snapshots.length - 1];
  }

  getSnapshotCount(): number {
    return this.snapshots.length;
  }

  // --------------------------------------------------------------------------
  // Render Pipeline Query Methods
  // --------------------------------------------------------------------------

  /**
   * Get all render pipeline events (for tracing the zoom bump).
   * Returns events in chronological order.
   */
  getRenderPipelineEvents(options?: { since?: number; limit?: number }): CoordinateSnapshot[] {
    const renderOps: OperationType[] = [
      'render-request', 'render-complete', 'canvas-update', 'transform-apply', 'cssStretch-change'
    ];

    let result = this.snapshots.filter(s => renderOps.includes(s.operation));

    if (options?.since) {
      result = result.filter(s => s.timestamp >= options.since!);
    }

    if (options?.limit && options.limit > 0) {
      result = result.slice(-options.limit);
    }

    return result;
  }

  /**
   * Get cssStretch changes that might cause the "bump".
   * Returns only significant changes (delta > 0.1).
   */
  getSignificantCssStretchChanges(): CoordinateSnapshot[] {
    return this.snapshots.filter(
      s => s.operation === 'cssStretch-change' &&
           s.validation &&
           !s.validation.passed
    );
  }

  /**
   * Get a summary of the render pipeline state for quick debugging.
   */
  getRenderPipelineSummary(): {
    totalRenderRequests: number;
    totalRenderCompletes: number;
    totalTransformApplies: number;
    significantCssStretchChanges: number;
    recentEvents: CoordinateSnapshot[];
  } {
    const events = this.getRenderPipelineEvents();
    const now = Date.now();
    const recentWindow = 5000; // 5 seconds

    return {
      totalRenderRequests: events.filter(e => e.operation === 'render-request').length,
      totalRenderCompletes: events.filter(e => e.operation === 'render-complete').length,
      totalTransformApplies: events.filter(e => e.operation === 'transform-apply').length,
      significantCssStretchChanges: this.getSignificantCssStretchChanges().length,
      recentEvents: this.getRenderPipelineEvents({ since: now - recentWindow, limit: 20 }),
    };
  }

  // --------------------------------------------------------------------------
  // Export Methods
  // --------------------------------------------------------------------------

  exportToJSON(): string {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      snapshotCount: this.snapshots.length,
      failureCount: this.getValidationFailures().length,
      snapshots: this.snapshots,
    }, null, 2);
  }

  getSummary(): {
    totalSnapshots: number;
    failures: number;
    byOperation: Record<OperationType, number>;
    unifiedModeSnapshots: number;
    legacyModeSnapshots: number;
  } {
    const byOperation: Record<OperationType, number> = {
      zoom: 0,
      pan: 0,
      visibility: 0,
      tile: 0,
      constraint: 0,
      // Render pipeline operations
      'render-request': 0,
      'render-complete': 0,
      'canvas-update': 0,
      'transform-apply': 0,
      'cssStretch-change': 0,
    };

    let unifiedModeSnapshots = 0;
    let legacyModeSnapshots = 0;

    for (const snapshot of this.snapshots) {
      byOperation[snapshot.operation]++;
      if (snapshot.unifiedMode) {
        unifiedModeSnapshots++;
      } else {
        legacyModeSnapshots++;
      }
    }

    return {
      totalSnapshots: this.snapshots.length,
      failures: this.getValidationFailures().length,
      byOperation,
      unifiedModeSnapshots,
      legacyModeSnapshots,
    };
  }

  // --------------------------------------------------------------------------
  // Internal Methods
  // --------------------------------------------------------------------------

  private addSnapshot(snapshot: CoordinateSnapshot): void {
    // PERF FIX: Use shift() to maintain max size instead of slice()
    // This avoids creating a new array on every trim operation
    if (this.snapshots.length >= this.maxSnapshots) {
      this.snapshots.shift(); // Remove oldest before adding new
    }

    this.snapshots.push(snapshot);

    // Handle validation failure
    if (snapshot.validation && !snapshot.validation.passed) {
      // Throttle console warnings to prevent spam during high-frequency failures
      const now = Date.now();
      const isWarningOnly = snapshot.validation.message?.startsWith('Warning:');

      if (!isWarningOnly && now - this.lastWarningTime >= this.warningThrottleMs) {
        console.warn('[CoordinateDebugger] Validation failure:', snapshot.validation.message, snapshot);
        this.lastWarningTime = now;
      }

      if (this.onValidationFailure) {
        this.onValidationFailure(snapshot);
      }

      // Check for auto-disable threshold
      this.checkAutoDisable();
    }
  }

  private checkAutoDisable(): void {
    const recentFailures = this.getRecentFailures(this.autoDisableWindowMs);
    if (recentFailures.length >= this.autoDisableThreshold) {
      console.error(
        `[CoordinateDebugger] ${recentFailures.length} validation failures in ${this.autoDisableWindowMs}ms. ` +
        'Review coordinate calculations for potential issues.'
      );
    }
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let debuggerInstance: CoordinateDebugger | null = null;

export function getCoordinateDebugger(): CoordinateDebugger {
  if (!debuggerInstance) {
    debuggerInstance = new CoordinateDebugger();
  }
  return debuggerInstance;
}

export function resetCoordinateDebugger(): void {
  debuggerInstance = null;
}

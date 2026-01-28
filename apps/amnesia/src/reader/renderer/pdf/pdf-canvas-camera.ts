/**
 * PDF Canvas Camera System
 *
 * Implements an infinite canvas with pan and zoom using the camera model.
 * Pages remain at fixed positions while the viewport moves.
 *
 * Key concepts:
 * - Camera: {x, y, z} where x,y is position and z is zoom
 * - Screen coordinates: Pixel positions in the viewport
 * - Canvas coordinates: Positions on the infinite canvas
 * - Transform: CSS transform applied to canvas container
 */

export interface Point {
  x: number;
  y: number;
}

export interface Camera {
  /** X offset in canvas coordinates */
  x: number;
  /** Y offset in canvas coordinates */
  y: number;
  /** Zoom level (1 = 100%, 0.5 = 50%, 2 = 200%) */
  z: number;
}

/**
 * CameraState - Alias for Camera interface for semantic clarity.
 * Used when the camera state is being read/modified in real-time.
 */
export type CameraState = Camera;

/**
 * Immutable camera snapshot captured at a specific point in time.
 *
 * INV-4: Viewport snapshots prevent coordinate drift when camera moves
 * during debounced render operations. At 32x zoom, 1px of camera drift
 * causes 32px of tile misalignment.
 *
 * Key properties:
 * - Immutable: Once created, values cannot be modified
 * - Timestamped: Includes capture time for debugging
 * - Bounds-clamped: Values are constrained to valid ranges
 */
export interface CameraSnapshot {
  /** X offset in canvas coordinates (clamped to >= 0) */
  readonly x: number;
  /** Y offset in canvas coordinates (clamped to >= 0) */
  readonly y: number;
  /** Zoom level (clamped to 0.1-64 range) */
  readonly z: number;
  /** Timestamp when snapshot was captured */
  readonly timestamp: number;
}

// Bounds for camera snapshot clamping
const SNAPSHOT_MIN_ZOOM = 0.1;
const SNAPSHOT_MAX_ZOOM = 64;

/**
 * Create an immutable camera snapshot from current camera state.
 *
 * INV-4: This function is critical for preventing coordinate drift.
 * The snapshot captures camera state at tile REQUEST time, ensuring
 * tiles are positioned correctly even if the camera moves during
 * debounced render operations.
 *
 * The snapshot is frozen to prevent accidental modification.
 *
 * @param camera Current camera state to snapshot
 * @returns Immutable camera snapshot
 */
export function createCameraSnapshot(camera: CameraState): CameraSnapshot {
  // Clamp values to valid ranges
  const x = Math.max(0, camera.x);
  const y = Math.max(0, camera.y);
  const z = clamp(camera.z, SNAPSHOT_MIN_ZOOM, SNAPSHOT_MAX_ZOOM);

  // Create frozen object for immutability
  const snapshot: CameraSnapshot = Object.freeze({
    x,
    y,
    z,
    timestamp: Date.now(),
  });

  return snapshot;
}

export interface CameraConstraints {
  minZoom: number;
  maxZoom: number;
  /** If true, constrain camera to keep content visible */
  constrainToBounds: boolean;
  /** Canvas bounds (if constrainToBounds is true) */
  bounds?: { width: number; height: number };
  /** Viewport size (needed for constraint calculations) */
  viewport?: { width: number; height: number };
}

const DEFAULT_CONSTRAINTS: CameraConstraints = {
  minZoom: 0.1,
  maxZoom: 32, // Allow very high zoom for detailed viewing (amnesia-pi0)
  constrainToBounds: false,
};

/**
 * Clamp a value between min and max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Convert a screen point to canvas coordinates
 *
 * Screen coordinates are relative to the viewport (0,0 is top-left of viewport)
 * Canvas coordinates are positions on the infinite canvas
 */
export function screenToCanvas(screen: Point, camera: Camera): Point {
  return {
    x: screen.x / camera.z - camera.x,
    y: screen.y / camera.z - camera.y,
  };
}

/**
 * Convert a canvas point to screen coordinates
 */
export function canvasToScreen(canvas: Point, camera: Camera): Point {
  return {
    x: (canvas.x + camera.x) * camera.z,
    y: (canvas.y + camera.y) * camera.z,
  };
}

/**
 * Create a new camera at default position
 */
export function createCamera(initialZoom = 1): Camera {
  return { x: 0, y: 0, z: initialZoom };
}

/**
 * Pan the camera by screen delta
 *
 * The delta is divided by zoom so panning feels consistent at any zoom level
 */
export function panCamera(camera: Camera, dx: number, dy: number): Camera {
  return {
    x: camera.x - dx / camera.z,
    y: camera.y - dy / camera.z,
    z: camera.z,
  };
}

/**
 * Zoom the camera toward a point
 *
 * The point (in screen coordinates) remains stationary during zoom.
 * This creates the natural "zoom to cursor" or "pinch-to-zoom" behavior.
 *
 * @param camera Current camera state
 * @param point Screen point to zoom toward (e.g., cursor position)
 * @param delta Zoom delta (positive = zoom out, negative = zoom in)
 * @param constraints Optional zoom constraints
 */
export function zoomCameraToPoint(
  camera: Camera,
  point: Point,
  delta: number,
  constraints: CameraConstraints = DEFAULT_CONSTRAINTS
): Camera {
  // Calculate new zoom level
  // Using multiplicative zoom: zoom *= (1 - delta)
  // This gives smooth, proportional zoom at any level
  const zoomFactor = 1 - delta;
  const rawNewZoom = camera.z * zoomFactor;
  const newZoom = clamp(rawNewZoom, constraints.minZoom, constraints.maxZoom);

  // CRITICAL FIX (amnesia-ntj): Detect when zoom was clamped at HARD boundary
  // When user continues pinching at max/min zoom, trackpad sends rebound events
  // that would cause position drift if we calculated position adjustments.
  //
  // IMPORTANT: Only apply at HARD limits (0.1 and 32), NOT at soft constraints
  // like "fit to page". Soft constraints can be dynamic and the rebound fix
  // would incorrectly block legitimate zoom gestures.
  //
  // Detection logic:
  // - atHardBoundary: zoom is at the absolute min (0.1) or max (32)
  // - noEffectiveZoomChange: new zoom equals current zoom
  //
  // FIX (amnesia-eff): Use RELATIVE epsilon comparisons for floats
  const HARD_MIN_ZOOM = 0.1;
  const HARD_MAX_ZOOM = 32;
  const EPSILON_PERCENT = 0.001; // 0.1%
  const epsilon = Math.max(1e-6, newZoom * EPSILON_PERCENT);
  const atHardMaxZoom = Math.abs(newZoom - HARD_MAX_ZOOM) < epsilon;
  const atHardMinZoom = Math.abs(newZoom - HARD_MIN_ZOOM) < epsilon;
  const noEffectiveZoomChange = Math.abs(newZoom - camera.z) < epsilon;

  if ((atHardMaxZoom || atHardMinZoom) && noEffectiveZoomChange) {
    // At hard boundary and zoom can't change - block position adjustment
    // This prevents rebound events from causing focal point drift
    console.log(`[ZOOM-CLAMP-FIX] Blocked at hard limit: zoom=${newZoom.toFixed(4)}, boundary=${atHardMaxZoom ? 'MAX(32)' : 'MIN(0.1)'}`);
    return camera;
  }

  // Find where the point is in canvas coordinates BEFORE zoom
  const p1 = screenToCanvas(point, camera);

  // Find where the point would be in canvas coordinates AFTER zoom
  // (using the new zoom level but old position)
  const p2 = screenToCanvas(point, { ...camera, z: newZoom });

  // Calculate position adjustment to keep the point stationary
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  // DEBUG: Log significant camera changes to track focal point drift
  const significantChange = Math.abs(dx) > 5 || Math.abs(dy) > 5;
  if (significantChange) {
    // Use explicit string format to avoid Object truncation in MCP console capture
    console.log(`[ZOOM-DEBUG] zoomCameraToPoint: delta=${delta.toFixed(4)}, ` +
      `zoom=${camera.z.toFixed(2)}→${newZoom.toFixed(2)}, ` +
      `focal=(${point.x.toFixed(0)},${point.y.toFixed(0)}), ` +
      `posDelta=(${dx.toFixed(1)},${dy.toFixed(1)}), ` +
      `camBefore=(${camera.x.toFixed(1)},${camera.y.toFixed(1)}), ` +
      `camAfter=(${(camera.x + dx).toFixed(1)},${(camera.y + dy).toFixed(1)})`);
  }

  // Early return if no effective change
  if (newZoom === camera.z && Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
    return camera;
  }

  return {
    x: camera.x + dx,
    y: camera.y + dy,
    z: newZoom,
  };
}

/**
 * Zoom the camera toward the center of the viewport
 */
export function zoomCamera(
  camera: Camera,
  delta: number,
  viewportWidth: number,
  viewportHeight: number,
  constraints: CameraConstraints = DEFAULT_CONSTRAINTS
): Camera {
  const center: Point = {
    x: viewportWidth / 2,
    y: viewportHeight / 2,
  };
  return zoomCameraToPoint(camera, center, delta, constraints);
}

/**
 * Set the camera to a specific zoom level, centered on viewport
 */
export function setCameraZoom(
  camera: Camera,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
  constraints: CameraConstraints = DEFAULT_CONSTRAINTS
): Camera {
  const newZoom = clamp(zoom, constraints.minZoom, constraints.maxZoom);

  // Calculate delta needed to reach target zoom
  // Using: newZoom = oldZoom * (1 - delta)
  // So: delta = 1 - newZoom / oldZoom
  const delta = 1 - newZoom / camera.z;

  return zoomCamera(camera, delta, viewportWidth, viewportHeight, constraints);
}

/**
 * Center the camera on a specific canvas point
 */
export function centerOnPoint(
  camera: Camera,
  canvasPoint: Point,
  viewportWidth: number,
  viewportHeight: number
): Camera {
  // We want canvasPoint to be at screen center
  // Screen center is at (viewportWidth/2, viewportHeight/2)
  // Using canvasToScreen: screenX = (canvasX + camera.x) * camera.z
  // We want: viewportWidth/2 = (canvasPoint.x + newCamera.x) * camera.z
  // So: newCamera.x = viewportWidth/(2*camera.z) - canvasPoint.x

  return {
    x: viewportWidth / (2 * camera.z) - canvasPoint.x,
    y: viewportHeight / (2 * camera.z) - canvasPoint.y,
    z: camera.z,
  };
}

/**
 * Fit a bounding box in the viewport
 *
 * @param box The bounding box to fit (in canvas coordinates)
 * @param viewportWidth Viewport width in pixels
 * @param viewportHeight Viewport height in pixels
 * @param padding Padding around the box (in screen pixels)
 */
export function fitBoxInView(
  box: { x: number; y: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
  padding = 20,
  constraints: CameraConstraints = DEFAULT_CONSTRAINTS
): Camera {
  // Calculate zoom to fit box with padding
  const availableWidth = viewportWidth - padding * 2;
  const availableHeight = viewportHeight - padding * 2;

  const scaleX = availableWidth / box.width;
  const scaleY = availableHeight / box.height;
  const zoom = clamp(
    Math.min(scaleX, scaleY),
    constraints.minZoom,
    constraints.maxZoom
  );

  // Center the box
  const boxCenterX = box.x + box.width / 2;
  const boxCenterY = box.y + box.height / 2;

  return {
    x: viewportWidth / (2 * zoom) - boxCenterX,
    y: viewportHeight / (2 * zoom) - boxCenterY,
    z: zoom,
  };
}

/**
 * Constrain camera to keep content visible
 */
export function constrainCamera(
  camera: Camera,
  constraints: CameraConstraints
): Camera {
  if (!constraints.constrainToBounds || !constraints.bounds || !constraints.viewport) {
    return camera;
  }

  const { bounds, viewport } = constraints;
  const { z } = camera;

  // Calculate the visible canvas area at current zoom
  const visibleWidth = viewport.width / z;
  const visibleHeight = viewport.height / z;

  // Calculate camera position limits
  // We want at least some of the content to be visible
  const margin = 100 / z; // 100px margin in screen space

  let { x, y } = camera;

  // Horizontal constraint
  const minX = -bounds.width + margin;
  const maxX = visibleWidth - margin;
  if (bounds.width * z < viewport.width) {
    // Content is smaller than viewport - center it
    x = (visibleWidth - bounds.width) / 2;
  } else {
    x = clamp(x, minX, maxX);
  }

  // Vertical constraint
  const minY = -bounds.height + margin;
  const maxY = visibleHeight - margin;
  if (bounds.height * z < viewport.height) {
    // Content is smaller than viewport - center it
    y = (visibleHeight - bounds.height) / 2;
  } else {
    y = clamp(y, minY, maxY);
  }

  return { x, y, z };
}

/**
 * Get the CSS transform string for the camera.
 * Uses scale-then-translate for proper pan-zoom behavior.
 *
 * GPU COMPOSITING: Uses translate3d (with z=0) instead of translate to
 * create a 3D rendering context. This ensures the canvas is promoted to
 * its own compositing layer, enabling smooth 60fps zoom via GPU acceleration.
 * Without 3D context, browsers may batch transforms with other layers,
 * causing stepped/quantized zoom appearance.
 */
export function getCameraTransform(camera: Camera): string {
  // Camera transform: scale then translate3d for GPU-accelerated pan-zoom
  // translate3d creates a 3D context for GPU layer promotion
  return `scale(${camera.z}) translate3d(${camera.x}px, ${camera.y}px, 0)`;
}

/**
 * Get the visible canvas bounds at current camera position
 */
export function getVisibleBounds(
  camera: Camera,
  viewportWidth: number,
  viewportHeight: number
): { x: number; y: number; width: number; height: number } {
  // Top-left corner in canvas coordinates
  const topLeft = screenToCanvas({ x: 0, y: 0 }, camera);

  // Visible dimensions in canvas coordinates
  const width = viewportWidth / camera.z;
  const height = viewportHeight / camera.z;

  return {
    x: topLeft.x,
    y: topLeft.y,
    width,
    height,
  };
}

// ============================================================================
// UNIFIED COORDINATE SPACE FUNCTIONS (V4 Architecture)
// ============================================================================

/**
 * Pan camera in unified coordinate space.
 *
 * In unified coordinate space, pages are already at zoomed dimensions,
 * so pan delta is applied directly without dividing by zoom.
 */
export function panCameraUnified(camera: Camera, dx: number, dy: number): Camera {
  return {
    x: camera.x - dx,
    y: camera.y - dy,
    z: camera.z,
  };
}

/**
 * Get visible bounds in unified coordinate space.
 *
 * In unified coordinate space, pages are sized to (baseWidth * zoom),
 * and the camera's zoom is effectively 1 for visibility calculations
 * since pages are already at final dimensions.
 */
export function getVisibleBoundsUnified(
  camera: Camera,
  viewportWidth: number,
  viewportHeight: number
): { x: number; y: number; width: number; height: number } {
  // In unified space, camera.z represents the zoom applied to page dimensions
  // Viewport covers the same screen area but pages are larger
  // So visible bounds in page coordinates = viewport / zoom
  const width = viewportWidth / camera.z;
  const height = viewportHeight / camera.z;

  return {
    x: -camera.x,
    y: -camera.y,
    width,
    height,
  };
}

// ============================================================================
// ANIMATION FUNCTIONS
// ============================================================================

/**
 * Animate camera transition (returns intermediate camera states)
 *
 * @param from Starting camera
 * @param to Target camera
 * @param progress Animation progress (0 to 1)
 */
export function lerpCamera(from: Camera, to: Camera, progress: number): Camera {
  const t = clamp(progress, 0, 1);

  // Use easeOutCubic for smooth deceleration
  const eased = 1 - Math.pow(1 - t, 3);

  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
    // Zoom should interpolate logarithmically for perceptual smoothness
    z: from.z * Math.pow(to.z / from.z, eased),
  };
}

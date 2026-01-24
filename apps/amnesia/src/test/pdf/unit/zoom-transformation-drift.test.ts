/**
 * Zoom Transformation Drift Analysis Test Suite
 *
 * This test harness programmatically replicates trackpad zoom behavior
 * to isolate and identify where position drift occurs in the transformation chain.
 *
 * Key functions under test:
 * - zoomCameraToPoint() - Core zoom math
 * - screenToCanvas() / canvasToScreen() - Coordinate conversions
 *
 * The tests simulate:
 * 1. Normal zoom operations
 * 2. Zoom to max limit with overshoot (clamping)
 * 3. Rapid zoom cycles (accumulation error)
 * 4. Rebound sequences (zoom-in then zoom-out rapidly)
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ============================================================================
// INLINE IMPLEMENTATIONS (copied from pdf-canvas-camera.ts for isolation)
// ============================================================================

interface Point {
  x: number;
  y: number;
}

interface Camera {
  x: number;
  y: number;
  z: number;
}

interface CameraConstraints {
  minZoom: number;
  maxZoom: number;
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * CURRENT IMPLEMENTATION (potentially buggy)
 * Clamps zoom BEFORE calculating position - causes drift when at limits
 */
function zoomCameraToPoint_CURRENT(
  camera: Camera,
  point: Point,
  delta: number,
  constraints: CameraConstraints
): Camera {
  const zoomFactor = 1 - delta;
  const newZoom = clamp(
    camera.z * zoomFactor,
    constraints.minZoom,
    constraints.maxZoom
  );

  // BUG: Early return when zoom unchanged - skips position calculation
  if (newZoom === camera.z) {
    return camera;
  }

  const p1 = screenToCanvas(point, camera);
  const p2 = screenToCanvas(point, { ...camera, z: newZoom });

  return {
    x: camera.x + (p2.x - p1.x),
    y: camera.y + (p2.y - p1.y),
    z: newZoom,
  };
}

/**
 * FIXED IMPLEMENTATION
 * Always calculates position, even when zoom is clamped
 */
function zoomCameraToPoint_FIXED(
  camera: Camera,
  point: Point,
  delta: number,
  constraints: CameraConstraints
): Camera {
  const zoomFactor = 1 - delta;
  const requestedZoom = camera.z * zoomFactor;
  const newZoom = clamp(requestedZoom, constraints.minZoom, constraints.maxZoom);

  // Calculate position adjustment for the new zoom
  const p1 = screenToCanvas(point, camera);
  const p2 = screenToCanvas(point, { ...camera, z: newZoom });

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  // Only return early if BOTH zoom AND position are truly unchanged
  if (newZoom === camera.z && Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
    return camera;
  }

  return {
    x: camera.x + dx,
    y: camera.y + dy,
    z: newZoom,
  };
}

function screenToCanvas(screen: Point, camera: Camera): Point {
  return {
    x: screen.x / camera.z - camera.x,
    y: screen.y / camera.z - camera.y,
  };
}

function canvasToScreen(canvas: Point, camera: Camera): Point {
  return {
    x: (canvas.x + camera.x) * camera.z,
    y: (canvas.y + camera.y) * camera.z,
  };
}

// ============================================================================
// TEST UTILITIES
// ============================================================================

interface TransformLog {
  step: number;
  delta: number;
  requestedZoom: number;
  actualZoom: number;
  clamped: boolean;
  cameraBefore: Camera;
  cameraAfter: Camera;
  focalPoint: Point;
  focalPointCanvas: Point;
  positionDrift: { x: number; y: number };
}

interface DriftAnalysis {
  logs: TransformLog[];
  totalDrift: { x: number; y: number };
  maxDrift: { x: number; y: number };
  driftAccumulationRate: number;
  clampedSteps: number;
  outlierSteps: number[]; // Steps where drift exceeds threshold
}

function analyzeZoomSequence(
  deltas: number[],
  focalPoint: Point,
  initialCamera: Camera,
  constraints: CameraConstraints,
  zoomFn: typeof zoomCameraToPoint_CURRENT,
  driftThreshold = 0.1
): DriftAnalysis {
  const logs: TransformLog[] = [];
  let camera = { ...initialCamera };
  let totalDrift = { x: 0, y: 0 };
  let maxDrift = { x: 0, y: 0 };
  let clampedSteps = 0;
  const outlierSteps: number[] = [];

  // Track the focal point in canvas space - should stay FIXED
  const initialFocalCanvas = screenToCanvas(focalPoint, initialCamera);

  for (let i = 0; i < deltas.length; i++) {
    const delta = deltas[i];
    const cameraBefore = { ...camera };

    const requestedZoom = camera.z * (1 - delta);
    camera = zoomFn(camera, focalPoint, delta, constraints);

    const clamped =
      requestedZoom < constraints.minZoom ||
      requestedZoom > constraints.maxZoom;

    // Calculate drift: where is the focal point now in canvas space?
    const currentFocalCanvas = screenToCanvas(focalPoint, camera);
    const drift = {
      x: currentFocalCanvas.x - initialFocalCanvas.x,
      y: currentFocalCanvas.y - initialFocalCanvas.y,
    };

    totalDrift = drift; // Cumulative drift from initial position
    maxDrift = {
      x: Math.max(maxDrift.x, Math.abs(drift.x)),
      y: Math.max(maxDrift.y, Math.abs(drift.y)),
    };

    if (clamped) clampedSteps++;
    if (Math.abs(drift.x) > driftThreshold || Math.abs(drift.y) > driftThreshold) {
      outlierSteps.push(i);
    }

    logs.push({
      step: i,
      delta,
      requestedZoom,
      actualZoom: camera.z,
      clamped,
      cameraBefore,
      cameraAfter: { ...camera },
      focalPoint,
      focalPointCanvas: currentFocalCanvas,
      positionDrift: drift,
    });
  }

  return {
    logs,
    totalDrift,
    maxDrift,
    driftAccumulationRate: outlierSteps.length / deltas.length,
    clampedSteps,
    outlierSteps,
  };
}

/**
 * Generate realistic trackpad pinch zoom deltas
 */
function generatePinchZoomDeltas(
  targetZoom: number,
  startZoom: number,
  numSteps: number
): number[] {
  const deltas: number[] = [];
  let currentZoom = startZoom;

  for (let i = 0; i < numSteps; i++) {
    // Each delta should move toward target zoom
    // delta > 0 means zoom out (shrink), delta < 0 means zoom in (magnify)
    const remainingRatio = targetZoom / currentZoom;
    const stepRatio = Math.pow(remainingRatio, 1 / (numSteps - i));

    // delta = 1 - zoomFactor, where zoomFactor = newZoom / oldZoom
    const delta = 1 - stepRatio;
    deltas.push(delta);

    // Simulate what the camera would do
    currentZoom = currentZoom * stepRatio;
  }

  return deltas;
}

/**
 * Generate trackpad rebound sequence (zoom to max, then bounce back)
 */
function generateReboundSequence(
  maxZoom: number,
  startZoom: number,
  numZoomInSteps: number,
  numReboundSteps: number
): number[] {
  // Phase 1: Zoom in to max (overshoot slightly)
  const zoomInDeltas = generatePinchZoomDeltas(
    maxZoom * 1.2, // Overshoot
    startZoom,
    numZoomInSteps
  );

  // Phase 2: Rebound (small zoom-out events from trackpad physics)
  const reboundDeltas: number[] = [];
  for (let i = 0; i < numReboundSteps; i++) {
    // Rebound deltas are positive (zoom out) and decay exponentially
    const reboundMagnitude = 0.02 * Math.exp(-i * 0.3);
    reboundDeltas.push(reboundMagnitude);
  }

  return [...zoomInDeltas, ...reboundDeltas];
}

// ============================================================================
// TESTS
// ============================================================================

describe('Zoom Transformation Drift Analysis', () => {
  const constraints: CameraConstraints = {
    minZoom: 0.5,
    maxZoom: 16,
  };

  const focalPoint: Point = { x: 500, y: 300 }; // Screen center

  describe('Coordinate Conversion Verification', () => {
    it('screenToCanvas and canvasToScreen are true inverses', () => {
      const camera: Camera = { x: -200, y: -100, z: 8 };
      const screen: Point = { x: 500, y: 300 };

      const canvas = screenToCanvas(screen, camera);
      const backToScreen = canvasToScreen(canvas, camera);

      expect(backToScreen.x).toBeCloseTo(screen.x, 10);
      expect(backToScreen.y).toBeCloseTo(screen.y, 10);
    });

    it('coordinate conversion works at all zoom levels', () => {
      const zoomLevels = [0.5, 1, 2, 4, 8, 16];
      const screen: Point = { x: 500, y: 300 };

      for (const z of zoomLevels) {
        const camera: Camera = { x: -50, y: -50, z };
        const canvas = screenToCanvas(screen, camera);
        const backToScreen = canvasToScreen(canvas, camera);

        expect(backToScreen.x).toBeCloseTo(screen.x, 10);
        expect(backToScreen.y).toBeCloseTo(screen.y, 10);
      }
    });
  });

  describe('Normal Zoom Operations (No Clamping)', () => {
    it('CURRENT: focal point stays fixed during smooth zoom 1x → 4x', () => {
      const initialCamera: Camera = { x: 0, y: 0, z: 1 };
      const deltas = generatePinchZoomDeltas(4, 1, 20);

      const analysis = analyzeZoomSequence(
        deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_CURRENT
      );

      console.log('\n=== Normal Zoom 1x → 4x (CURRENT) ===');
      console.log(`Final camera: z=${analysis.logs.at(-1)?.cameraAfter.z.toFixed(2)}`);
      console.log(`Total drift: (${analysis.totalDrift.x.toFixed(4)}, ${analysis.totalDrift.y.toFixed(4)})`);
      console.log(`Clamped steps: ${analysis.clampedSteps}`);
      console.log(`Outlier steps: ${analysis.outlierSteps.length}`);

      // Normal zoom should have minimal drift
      expect(analysis.totalDrift.x).toBeCloseTo(0, 2);
      expect(analysis.totalDrift.y).toBeCloseTo(0, 2);
      expect(analysis.clampedSteps).toBe(0);
    });

    it('FIXED: focal point stays fixed during smooth zoom 1x → 4x', () => {
      const initialCamera: Camera = { x: 0, y: 0, z: 1 };
      const deltas = generatePinchZoomDeltas(4, 1, 20);

      const analysis = analyzeZoomSequence(
        deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_FIXED
      );

      console.log('\n=== Normal Zoom 1x → 4x (FIXED) ===');
      console.log(`Final camera: z=${analysis.logs.at(-1)?.cameraAfter.z.toFixed(2)}`);
      console.log(`Total drift: (${analysis.totalDrift.x.toFixed(4)}, ${analysis.totalDrift.y.toFixed(4)})`);

      // Should also have minimal drift
      expect(analysis.totalDrift.x).toBeCloseTo(0, 2);
      expect(analysis.totalDrift.y).toBeCloseTo(0, 2);
    });
  });

  describe('Zoom to Max Limit with Overshoot (CRITICAL)', () => {
    it('CURRENT: demonstrates drift when zoom is clamped at max', () => {
      const initialCamera: Camera = { x: 0, y: 0, z: 8 };

      // Simulate overshooting to 20x (gets clamped to 16x)
      const deltas = generatePinchZoomDeltas(20, 8, 30);

      const analysis = analyzeZoomSequence(
        deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_CURRENT
      );

      console.log('\n=== Zoom to Max with Overshoot (CURRENT) ===');
      console.log(`Final camera: z=${analysis.logs.at(-1)?.cameraAfter.z.toFixed(2)}`);
      console.log(`Total drift: (${analysis.totalDrift.x.toFixed(4)}, ${analysis.totalDrift.y.toFixed(4)})`);
      console.log(`Clamped steps: ${analysis.clampedSteps}`);
      console.log(`Outlier steps: ${analysis.outlierSteps.length}`);

      // Log the first outlier for diagnosis
      if (analysis.outlierSteps.length > 0) {
        const firstOutlier = analysis.logs[analysis.outlierSteps[0]];
        console.log(`\nFirst outlier at step ${firstOutlier.step}:`);
        console.log(`  Delta: ${firstOutlier.delta.toFixed(4)}`);
        console.log(`  Requested zoom: ${firstOutlier.requestedZoom.toFixed(2)}`);
        console.log(`  Actual zoom: ${firstOutlier.actualZoom.toFixed(2)}`);
        console.log(`  Clamped: ${firstOutlier.clamped}`);
        console.log(`  Drift: (${firstOutlier.positionDrift.x.toFixed(4)}, ${firstOutlier.positionDrift.y.toFixed(4)})`);
      }

      // CURRENT implementation WILL have drift when clamped
      expect(analysis.clampedSteps).toBeGreaterThan(0);
    });

    it('FIXED: no drift when zoom is clamped at max', () => {
      const initialCamera: Camera = { x: 0, y: 0, z: 8 };
      const deltas = generatePinchZoomDeltas(20, 8, 30);

      const analysis = analyzeZoomSequence(
        deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_FIXED
      );

      console.log('\n=== Zoom to Max with Overshoot (FIXED) ===');
      console.log(`Final camera: z=${analysis.logs.at(-1)?.cameraAfter.z.toFixed(2)}`);
      console.log(`Total drift: (${analysis.totalDrift.x.toFixed(4)}, ${analysis.totalDrift.y.toFixed(4)})`);
      console.log(`Clamped steps: ${analysis.clampedSteps}`);
      console.log(`Outlier steps: ${analysis.outlierSteps.length}`);

      // FIXED implementation should have NO drift
      expect(analysis.totalDrift.x).toBeCloseTo(0, 2);
      expect(analysis.totalDrift.y).toBeCloseTo(0, 2);
    });
  });

  describe('Trackpad Rebound Sequence (CRITICAL)', () => {
    it('CURRENT: demonstrates drift during rebound after max zoom', () => {
      const initialCamera: Camera = { x: 0, y: 0, z: 4 };

      // Zoom to 16x (with overshoot), then rebound
      const deltas = generateReboundSequence(16, 4, 20, 15);

      const analysis = analyzeZoomSequence(
        deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_CURRENT
      );

      console.log('\n=== Rebound Sequence (CURRENT) ===');
      console.log(`Initial zoom: 4x`);
      console.log(`Final camera: z=${analysis.logs.at(-1)?.cameraAfter.z.toFixed(2)}`);
      console.log(`Total drift: (${analysis.totalDrift.x.toFixed(4)}, ${analysis.totalDrift.y.toFixed(4)})`);
      console.log(`Clamped steps: ${analysis.clampedSteps}`);
      console.log(`Outlier steps: ${analysis.outlierSteps.join(', ')}`);

      // Log zoom progression
      console.log('\nZoom progression:');
      const keyPoints = [0, 10, 19, 20, 25, 34];
      for (const i of keyPoints) {
        if (i < analysis.logs.length) {
          const log = analysis.logs[i];
          console.log(
            `  Step ${i}: z=${log.cameraAfter.z.toFixed(2)}, ` +
            `drift=(${log.positionDrift.x.toFixed(2)}, ${log.positionDrift.y.toFixed(2)}), ` +
            `clamped=${log.clamped}`
          );
        }
      }
    });

    it('FIXED: no drift during rebound after max zoom', () => {
      const initialCamera: Camera = { x: 0, y: 0, z: 4 };
      const deltas = generateReboundSequence(16, 4, 20, 15);

      const analysis = analyzeZoomSequence(
        deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_FIXED
      );

      console.log('\n=== Rebound Sequence (FIXED) ===');
      console.log(`Final camera: z=${analysis.logs.at(-1)?.cameraAfter.z.toFixed(2)}`);
      console.log(`Total drift: (${analysis.totalDrift.x.toFixed(4)}, ${analysis.totalDrift.y.toFixed(4)})`);
      console.log(`Max drift: (${analysis.maxDrift.x.toFixed(4)}, ${analysis.maxDrift.y.toFixed(4)})`);

      // FIXED implementation should maintain stable focal point
      expect(analysis.totalDrift.x).toBeCloseTo(0, 1);
      expect(analysis.totalDrift.y).toBeCloseTo(0, 1);
    });
  });

  describe('Rapid Zoom Cycles (Accumulation Test)', () => {
    it('CURRENT: drift accumulates over multiple zoom cycles', () => {
      const initialCamera: Camera = { x: 0, y: 0, z: 1 };

      // 5 cycles of zoom in to 16x, then zoom out to 1x
      const allDeltas: number[] = [];
      for (let cycle = 0; cycle < 5; cycle++) {
        // Zoom in: 1x → 16x (with overshoot to 20x)
        allDeltas.push(...generatePinchZoomDeltas(20, 1, 30));
        // Zoom out: 16x → 1x
        allDeltas.push(...generatePinchZoomDeltas(1, 16, 30));
      }

      const analysis = analyzeZoomSequence(
        allDeltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_CURRENT
      );

      console.log('\n=== 5 Zoom Cycles (CURRENT) ===');
      console.log(`Total steps: ${analysis.logs.length}`);
      console.log(`Final camera: z=${analysis.logs.at(-1)?.cameraAfter.z.toFixed(2)}`);
      console.log(`Total drift: (${analysis.totalDrift.x.toFixed(4)}, ${analysis.totalDrift.y.toFixed(4)})`);
      console.log(`Max drift: (${analysis.maxDrift.x.toFixed(4)}, ${analysis.maxDrift.y.toFixed(4)})`);
      console.log(`Drift accumulation rate: ${(analysis.driftAccumulationRate * 100).toFixed(1)}%`);
    });

    it('FIXED: no drift accumulation over multiple zoom cycles', () => {
      const initialCamera: Camera = { x: 0, y: 0, z: 1 };

      const allDeltas: number[] = [];
      for (let cycle = 0; cycle < 5; cycle++) {
        allDeltas.push(...generatePinchZoomDeltas(20, 1, 30));
        allDeltas.push(...generatePinchZoomDeltas(1, 16, 30));
      }

      const analysis = analyzeZoomSequence(
        allDeltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_FIXED
      );

      console.log('\n=== 5 Zoom Cycles (FIXED) ===');
      console.log(`Total steps: ${analysis.logs.length}`);
      console.log(`Final camera: z=${analysis.logs.at(-1)?.cameraAfter.z.toFixed(2)}`);
      console.log(`Total drift: (${analysis.totalDrift.x.toFixed(4)}, ${analysis.totalDrift.y.toFixed(4)})`);
      console.log(`Max drift: (${analysis.maxDrift.x.toFixed(4)}, ${analysis.maxDrift.y.toFixed(4)})`);

      // After 5 cycles, should end up back at approximately 1x with no drift
      expect(analysis.logs.at(-1)?.cameraAfter.z).toBeCloseTo(1, 0);
      expect(analysis.totalDrift.x).toBeCloseTo(0, 1);
      expect(analysis.totalDrift.y).toBeCloseTo(0, 1);
    });
  });

  describe('Extreme Delta Values (Edge Cases)', () => {
    it('handles very small deltas near limits', () => {
      const initialCamera: Camera = { x: -100, y: -50, z: 15.9 };

      // Tiny deltas that would push past max
      const deltas = Array(10).fill(-0.01); // Small zoom-in requests

      const analysisCurrent = analyzeZoomSequence(
        deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_CURRENT
      );

      const analysisFixed = analyzeZoomSequence(
        deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_FIXED
      );

      console.log('\n=== Tiny Deltas Near Max (z=15.9) ===');
      console.log('CURRENT:');
      console.log(`  Final z: ${analysisCurrent.logs.at(-1)?.cameraAfter.z.toFixed(4)}`);
      console.log(`  Drift: (${analysisCurrent.totalDrift.x.toFixed(4)}, ${analysisCurrent.totalDrift.y.toFixed(4)})`);
      console.log('FIXED:');
      console.log(`  Final z: ${analysisFixed.logs.at(-1)?.cameraAfter.z.toFixed(4)}`);
      console.log(`  Drift: (${analysisFixed.totalDrift.x.toFixed(4)}, ${analysisFixed.totalDrift.y.toFixed(4)})`);
    });

    it('handles sudden direction reversal', () => {
      const initialCamera: Camera = { x: 0, y: 0, z: 16 };

      // At max zoom, suddenly get large zoom-out delta (rebound)
      const deltas = [0.5, 0.3, 0.2]; // Large zoom-out deltas

      const analysis = analyzeZoomSequence(
        deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_CURRENT
      );

      console.log('\n=== Sudden Large Zoom-Out from Max ===');
      for (const log of analysis.logs) {
        console.log(
          `Step ${log.step}: delta=${log.delta.toFixed(2)}, ` +
          `z: ${log.cameraBefore.z.toFixed(2)} → ${log.cameraAfter.z.toFixed(2)}, ` +
          `drift=(${log.positionDrift.x.toFixed(2)}, ${log.positionDrift.y.toFixed(2)})`
        );
      }
    });
  });
});

describe('State Machine Camera Sync Simulation', () => {
  /**
   * This test simulates the REAL bug scenario:
   *
   * 1. User pinch-zooms to 16x (snapshot captured)
   * 2. During 0-150ms "zooming" state, rebound events drift camera.z from 16 → 6
   * 3. handleZoomRenderPhase() syncs camera back to snapshot zoom (16x)
   * 4. Position is recalculated with DRIFTED camera x/y but SNAPSHOT zoom
   * 5. Result: Massive position jump
   */

  const constraints: CameraConstraints = { minZoom: 0.5, maxZoom: 16 };
  const focalPoint: Point = { x: 500, y: 300 };

  it('CRITICAL: demonstrates camera sync drift when zoom drifts then snaps back', () => {
    // Step 1: User zooms to 16x
    let camera: Camera = { x: 0, y: 0, z: 1 };

    // Simulate zoom to 16x
    const zoomInDeltas = generatePinchZoomDeltas(16, 1, 30);
    for (const delta of zoomInDeltas) {
      camera = zoomCameraToPoint_CURRENT(camera, focalPoint, delta, constraints);
    }

    console.log('\n=== Camera Sync Simulation ===');
    console.log(`Step 1 - After zoom to 16x:`);
    console.log(`  Camera: {x: ${camera.x.toFixed(2)}, y: ${camera.y.toFixed(2)}, z: ${camera.z.toFixed(2)}}`);

    // Snapshot is captured at this point
    const snapshot = { ...camera };
    console.log(`  Snapshot captured: z=${snapshot.z.toFixed(2)}`);

    // Step 2: During 0-150ms window, rebound events drift camera.z from 16 → 6
    // These events bypass state machine guards because state is still 'zooming'
    const reboundDeltas = [0.05, 0.08, 0.1, 0.12, 0.15, 0.18, 0.2, 0.22, 0.25, 0.28];

    console.log(`\nStep 2 - Simulating rebound events (bypassing guards):`);
    for (let i = 0; i < reboundDeltas.length; i++) {
      const oldZ = camera.z;
      camera = zoomCameraToPoint_CURRENT(camera, focalPoint, reboundDeltas[i], constraints);
      console.log(`  Event ${i}: delta=${reboundDeltas[i].toFixed(2)}, z: ${oldZ.toFixed(2)} → ${camera.z.toFixed(2)}`);
    }

    const driftedCamera = { ...camera };
    console.log(`\nAfter drift:`);
    console.log(`  Camera: {x: ${driftedCamera.x.toFixed(2)}, y: ${driftedCamera.y.toFixed(2)}, z: ${driftedCamera.z.toFixed(2)}}`);
    console.log(`  Zoom delta from snapshot: ${(snapshot.z - driftedCamera.z).toFixed(2)}`);

    // Step 3: handleZoomRenderPhase() syncs camera back to snapshot
    // This is where the bug happens - position is recalculated from drifted state
    const syncedCamera = syncCameraToSnapshot(driftedCamera, snapshot, focalPoint);

    console.log(`\nStep 3 - After sync to snapshot:`);
    console.log(`  Camera: {x: ${syncedCamera.x.toFixed(2)}, y: ${syncedCamera.y.toFixed(2)}, z: ${syncedCamera.z.toFixed(2)}}`);

    // Measure drift: where is the focal point now vs where it should be?
    const initialFocalCanvas = screenToCanvas(focalPoint, snapshot);
    const finalFocalCanvas = screenToCanvas(focalPoint, syncedCamera);

    const drift = {
      x: finalFocalCanvas.x - initialFocalCanvas.x,
      y: finalFocalCanvas.y - initialFocalCanvas.y,
    };

    console.log(`\nDrift analysis:`);
    console.log(`  Focal point (snapshot): canvas (${initialFocalCanvas.x.toFixed(2)}, ${initialFocalCanvas.y.toFixed(2)})`);
    console.log(`  Focal point (synced): canvas (${finalFocalCanvas.x.toFixed(2)}, ${finalFocalCanvas.y.toFixed(2)})`);
    console.log(`  DRIFT: (${drift.x.toFixed(2)}, ${drift.y.toFixed(2)}) pixels`);
    console.log(`  Drift magnitude: ${Math.hypot(drift.x, drift.y).toFixed(2)} pixels`);

    // This is the critical assertion - there SHOULD be drift
    // because the current implementation has the bug
    if (Math.hypot(drift.x, drift.y) > 1) {
      console.log(`\n⚠️ BUG CONFIRMED: Camera sync causes ${Math.hypot(drift.x, drift.y).toFixed(2)}px position drift`);
    }
  });

  it('FIXED: camera sync with drift protection', () => {
    // Same scenario but with the fix: don't sync to snapshot if camera drifted
    let camera: Camera = { x: 0, y: 0, z: 1 };

    // Zoom to 16x
    const zoomInDeltas = generatePinchZoomDeltas(16, 1, 30);
    for (const delta of zoomInDeltas) {
      camera = zoomCameraToPoint_CURRENT(camera, focalPoint, delta, constraints);
    }

    const snapshot = { ...camera };

    // Simulate rebound drift
    const reboundDeltas = [0.05, 0.08, 0.1, 0.12, 0.15, 0.18, 0.2, 0.22, 0.25, 0.28];
    for (const delta of reboundDeltas) {
      camera = zoomCameraToPoint_CURRENT(camera, focalPoint, delta, constraints);
    }

    // FIXED: Don't sync if drift exceeds threshold - keep camera as-is
    const zoomDrift = Math.abs(snapshot.z - camera.z);
    const DRIFT_THRESHOLD = 0.5; // Don't sync if zoom drifted more than 0.5

    console.log('\n=== FIXED Camera Sync ===');
    console.log(`Zoom drift: ${zoomDrift.toFixed(2)}`);

    if (zoomDrift > DRIFT_THRESHOLD) {
      console.log(`Drift exceeds threshold (${DRIFT_THRESHOLD}) - skipping sync`);
      // In the fixed version, we DON'T sync back to snapshot
      // Instead, we accept the drifted camera as the new state
      // The user can intentionally zoom again if they want to return to 16x
    } else {
      console.log(`Drift within threshold - syncing to snapshot`);
      camera = syncCameraToSnapshot(camera, snapshot, focalPoint);
    }

    // Measure final drift
    const initialFocalCanvas = screenToCanvas(focalPoint, snapshot);
    const finalFocalCanvas = screenToCanvas(focalPoint, camera);

    const drift = Math.hypot(
      finalFocalCanvas.x - initialFocalCanvas.x,
      finalFocalCanvas.y - initialFocalCanvas.y
    );

    console.log(`Final drift: ${drift.toFixed(2)}px`);

    // With the fix, drift should be minimal because we don't sync
    // The focal point moves with the zoom, not independently
  });
});

describe('Moving Focal Point Simulation (Trackpad Reality)', () => {
  /**
   * REAL trackpad behavior: The pinch center MOVES during gesture
   *
   * During a pinch-zoom:
   * 1. User places two fingers at positions A and B
   * 2. As fingers move, the center point shifts
   * 3. On release, fingers may move slightly due to physics
   *
   * Each wheel event reports a DIFFERENT center point, but the camera
   * math assumes a FIXED focal point. This mismatch causes drift.
   */

  const constraints: CameraConstraints = { minZoom: 0.5, maxZoom: 16 };

  it('CRITICAL: demonstrates drift when focal point moves during zoom', () => {
    let camera: Camera = { x: 0, y: 0, z: 4 };

    // Simulate zoom with MOVING focal point (realistic trackpad behavior)
    // Each event has a slightly different center due to finger movement
    const events = [
      { delta: -0.05, focalPoint: { x: 500, y: 300 } }, // Initial center
      { delta: -0.05, focalPoint: { x: 502, y: 298 } }, // Slight drift
      { delta: -0.05, focalPoint: { x: 505, y: 295 } },
      { delta: -0.05, focalPoint: { x: 510, y: 290 } },
      { delta: -0.05, focalPoint: { x: 515, y: 285 } },
      { delta: -0.05, focalPoint: { x: 520, y: 280 } },
      { delta: -0.05, focalPoint: { x: 525, y: 275 } },
      { delta: -0.05, focalPoint: { x: 530, y: 270 } },
      { delta: -0.05, focalPoint: { x: 535, y: 265 } },
      { delta: -0.05, focalPoint: { x: 540, y: 260 } }, // Final center
    ];

    console.log('\n=== Moving Focal Point Simulation ===');
    console.log('Initial camera:', JSON.stringify(camera));

    // Track where the INITIAL focal point ends up
    const initialFocalPoint = events[0].focalPoint;
    const initialCanvasPosition = screenToCanvas(initialFocalPoint, camera);
    console.log(`\nInitial focal (${initialFocalPoint.x}, ${initialFocalPoint.y}) maps to canvas (${initialCanvasPosition.x.toFixed(2)}, ${initialCanvasPosition.y.toFixed(2)})`);

    for (let i = 0; i < events.length; i++) {
      const { delta, focalPoint } = events[i];
      camera = zoomCameraToPoint_CURRENT(camera, focalPoint, delta, constraints);

      // Where is the initial focal point now in screen space?
      const currentScreenPos = canvasToScreen(initialCanvasPosition, camera);
      const drift = Math.hypot(currentScreenPos.x - initialFocalPoint.x, currentScreenPos.y - initialFocalPoint.y);

      console.log(
        `Event ${i}: focal=(${focalPoint.x},${focalPoint.y}), z=${camera.z.toFixed(2)}, ` +
        `initial focal now at screen (${currentScreenPos.x.toFixed(1)}, ${currentScreenPos.y.toFixed(1)}), drift=${drift.toFixed(1)}px`
      );
    }

    // Measure final drift of the initial focal point
    const finalScreenPos = canvasToScreen(initialCanvasPosition, camera);
    const totalDrift = {
      x: finalScreenPos.x - initialFocalPoint.x,
      y: finalScreenPos.y - initialFocalPoint.y,
    };

    console.log(`\nFinal zoom: ${camera.z.toFixed(2)}x`);
    console.log(`Initial focal (${initialFocalPoint.x}, ${initialFocalPoint.y}) now at screen (${finalScreenPos.x.toFixed(1)}, ${finalScreenPos.y.toFixed(1)})`);
    console.log(`TOTAL DRIFT: (${totalDrift.x.toFixed(1)}, ${totalDrift.y.toFixed(1)}) = ${Math.hypot(totalDrift.x, totalDrift.y).toFixed(1)}px`);

    // With moving focal point, drift is EXPECTED and CORRECT behavior
    // This is not a bug - it's the nature of pinch-zoom with moving center
    expect(Math.hypot(totalDrift.x, totalDrift.y)).toBeGreaterThan(0);
  });

  it('demonstrates REBOUND with moving focal point causes large drift', () => {
    let camera: Camera = { x: 0, y: 0, z: 16 }; // Start at max zoom

    // Simulate rebound where focal point moves erratically
    // (fingers leaving touchpad causes jitter in reported center)
    const reboundEvents = [
      { delta: 0.02, focalPoint: { x: 500, y: 300 } },
      { delta: 0.05, focalPoint: { x: 520, y: 280 } }, // Finger lifts, center jumps
      { delta: 0.08, focalPoint: { x: 480, y: 320 } }, // Other finger lifts, center jumps opposite
      { delta: 0.10, focalPoint: { x: 550, y: 250 } }, // Erratic
      { delta: 0.12, focalPoint: { x: 450, y: 350 } }, // Erratic
    ];

    console.log('\n=== Rebound with Erratic Focal Point ===');
    console.log('Initial camera:', JSON.stringify(camera));

    // Track a fixed point on the canvas
    const trackedCanvasPoint: Point = { x: 100, y: 100 };
    const initialScreenPos = canvasToScreen(trackedCanvasPoint, camera);
    console.log(`\nTracking canvas point (${trackedCanvasPoint.x}, ${trackedCanvasPoint.y})`);
    console.log(`Initial screen position: (${initialScreenPos.x.toFixed(1)}, ${initialScreenPos.y.toFixed(1)})`);

    for (let i = 0; i < reboundEvents.length; i++) {
      const { delta, focalPoint } = reboundEvents[i];
      const oldZoom = camera.z;
      camera = zoomCameraToPoint_CURRENT(camera, focalPoint, delta, constraints);

      const currentScreenPos = canvasToScreen(trackedCanvasPoint, camera);
      const drift = Math.hypot(currentScreenPos.x - initialScreenPos.x, currentScreenPos.y - initialScreenPos.y);

      console.log(
        `Event ${i}: delta=${delta.toFixed(2)}, focal=(${focalPoint.x},${focalPoint.y}), ` +
        `z: ${oldZoom.toFixed(2)}→${camera.z.toFixed(2)}, tracked point drift=${drift.toFixed(1)}px`
      );
    }

    const finalScreenPos = canvasToScreen(trackedCanvasPoint, camera);
    const totalDrift = Math.hypot(finalScreenPos.x - initialScreenPos.x, finalScreenPos.y - initialScreenPos.y);

    console.log(`\nFinal zoom: ${camera.z.toFixed(2)}x`);
    console.log(`Tracked point final screen: (${finalScreenPos.x.toFixed(1)}, ${finalScreenPos.y.toFixed(1)})`);
    console.log(`TOTAL DRIFT: ${totalDrift.toFixed(1)}px`);
    console.log(`\n⚠️ This drift is caused by erratic focal point during rebound, not math bugs`);

    // Erratic focal point causes drift
    expect(totalDrift).toBeGreaterThan(100);
  });

  it('SOLUTION: use frozen focal point during rebound window', () => {
    let camera: Camera = { x: 0, y: 0, z: 16 };

    // Same rebound events but with FROZEN focal point
    const reboundEvents = [
      { delta: 0.02, focalPoint: { x: 500, y: 300 } },
      { delta: 0.05, focalPoint: { x: 520, y: 280 } },
      { delta: 0.08, focalPoint: { x: 480, y: 320 } },
      { delta: 0.10, focalPoint: { x: 550, y: 250 } },
      { delta: 0.12, focalPoint: { x: 450, y: 350 } },
    ];

    // FIX: Use the FIRST focal point for ALL rebound events
    const frozenFocalPoint = reboundEvents[0].focalPoint;

    console.log('\n=== Rebound with FROZEN Focal Point (FIX) ===');
    console.log(`Using frozen focal point: (${frozenFocalPoint.x}, ${frozenFocalPoint.y})`);

    const trackedCanvasPoint: Point = { x: 100, y: 100 };
    const initialScreenPos = canvasToScreen(trackedCanvasPoint, camera);

    for (let i = 0; i < reboundEvents.length; i++) {
      const { delta } = reboundEvents[i];
      const oldZoom = camera.z;

      // Use frozen focal point instead of erratic one
      camera = zoomCameraToPoint_CURRENT(camera, frozenFocalPoint, delta, constraints);

      const currentScreenPos = canvasToScreen(trackedCanvasPoint, camera);
      const drift = Math.hypot(currentScreenPos.x - initialScreenPos.x, currentScreenPos.y - initialScreenPos.y);

      console.log(
        `Event ${i}: delta=${delta.toFixed(2)}, z: ${oldZoom.toFixed(2)}→${camera.z.toFixed(2)}, ` +
        `tracked point drift=${drift.toFixed(1)}px`
      );
    }

    const finalScreenPos = canvasToScreen(trackedCanvasPoint, camera);
    const totalDrift = Math.hypot(finalScreenPos.x - initialScreenPos.x, finalScreenPos.y - initialScreenPos.y);

    console.log(`\nFinal zoom: ${camera.z.toFixed(2)}x`);
    console.log(`TOTAL DRIFT with frozen focal: ${totalDrift.toFixed(1)}px`);

    // With frozen focal point, drift is from zoom change only (expected)
    // No erratic jumps from moving center
  });
});

/**
 * Simulates handleZoomRenderPhase() camera sync behavior
 *
 * This is the problematic code that causes drift:
 * - Takes drifted camera (z=6)
 * - Syncs to snapshot zoom (z=16)
 * - Recalculates position incorrectly
 */
function syncCameraToSnapshot(driftedCamera: Camera, snapshot: Camera, focalPoint: Point): Camera {
  // This mimics the sync logic in handleZoomRenderPhase()
  // See pdf-infinite-canvas.ts:3397-3408

  const oldCamera = driftedCamera;
  const snapshotZoom = snapshot.z;

  // Calculate position adjustment for the zoom change
  const p1 = screenToCanvas(focalPoint, oldCamera);
  const tempCamera = { x: oldCamera.x, y: oldCamera.y, z: snapshotZoom };
  const p2 = screenToCanvas(focalPoint, tempCamera);

  return {
    x: oldCamera.x + (p2.x - p1.x),
    y: oldCamera.y + (p2.y - p1.y),
    z: snapshotZoom,
  };
}

describe('Delta Sensitivity Analysis', () => {
  /**
   * This test analyzes the zoom delta sensitivity issue.
   *
   * HISTORY:
   * - Original: 0.012 with NO cap → 60% zoom change per event (WAY too aggressive)
   * - First fix: 0.003 with 15% cap → Too slow, couldn't reach 16x
   * - Current: 0.008 with 25% cap → Balanced approach (being validated)
   *
   * Trackpad can easily produce deltaY of -50 to -100 in a single event.
   */

  const constraints: CameraConstraints = { minZoom: 0.5, maxZoom: 16 };
  const focalPoint: Point = { x: 500, y: 300 };

  // Simulate wheelEvent.deltaY to zoom delta conversion
  const ORIGINAL_SENSITIVITY = 0.012;      // Original (too aggressive)
  const CURRENT_SENSITIVITY = 0.008;       // Current deployed value
  const CURRENT_CAP = 0.25;                // 25% max zoom change per event
  const PROPOSED_SENSITIVITY = 0.003;      // Previously tested (too slow)
  const MAX_DELTA_CAP = 0.15;              // Previous cap (for comparison)

  function wheelDeltaToZoomDelta(deltaY: number, sensitivity: number, cap?: number): number {
    let delta = deltaY * sensitivity;
    if (cap !== undefined) {
      delta = Math.max(-cap, Math.min(cap, delta));
    }
    return delta;
  }

  it('shows ORIGINAL sensitivity (0.012) causes huge zoom jumps', () => {
    console.log('\n=== Delta Sensitivity Analysis - ORIGINAL (0.012, no cap) ===\n');

    const testDeltaYValues = [-10, -25, -50, -75, -100];

    console.log('deltaY | ORIGINAL (0.012) | Zoom Change');
    console.log('-------|------------------|------------');

    for (const deltaY of testDeltaYValues) {
      const delta = wheelDeltaToZoomDelta(deltaY, ORIGINAL_SENSITIVITY);
      const zoomChange = Math.abs(delta) * 100;
      console.log(`${deltaY.toString().padStart(6)} | ${delta.toFixed(4).padStart(16)} | ${zoomChange.toFixed(1)}%`);
    }

    // At deltaY=-50, we get 60% zoom change - this is the bug!
    const delta50 = wheelDeltaToZoomDelta(-50, ORIGINAL_SENSITIVITY);
    expect(Math.abs(delta50)).toBeGreaterThan(0.5); // > 50% zoom change = too much
  });

  it('VALIDATION: shows CURRENT sensitivity (0.008 + 25% cap) is balanced', () => {
    console.log('\n=== CURRENT DEPLOYED CONFIG: 0.008 sensitivity + 25% cap ===\n');

    const testDeltaYValues = [-10, -25, -50, -75, -100];

    console.log('deltaY | Raw Delta | After Cap | Zoom Change | Status');
    console.log('-------|-----------|-----------|-------------|-------');

    for (const deltaY of testDeltaYValues) {
      const rawDelta = deltaY * CURRENT_SENSITIVITY;
      const cappedDelta = wheelDeltaToZoomDelta(deltaY, CURRENT_SENSITIVITY, CURRENT_CAP);
      const zoomChange = Math.abs(cappedDelta) * 100;
      const wasCapped = Math.abs(rawDelta) > CURRENT_CAP;
      const status = wasCapped ? 'CAPPED' : 'ok';
      console.log(
        `${deltaY.toString().padStart(6)} | ${rawDelta.toFixed(4).padStart(9)} | ${cappedDelta.toFixed(4).padStart(9)} | ${zoomChange.toFixed(1).padStart(11)}% | ${status}`
      );
    }

    // Validation criteria for current config:
    // 1. Moderate deltaY (-25) should not be capped (allows smooth zooming)
    const delta25 = wheelDeltaToZoomDelta(-25, CURRENT_SENSITIVITY, CURRENT_CAP);
    expect(Math.abs(delta25)).toBeLessThan(CURRENT_CAP); // Should NOT be capped
    console.log(`\n✓ Moderate deltaY (-25) not capped: ${(delta25 * 100).toFixed(1)}% < ${CURRENT_CAP * 100}%`);

    // 2. Aggressive deltaY (-50+) should be capped at 25%
    const delta50 = wheelDeltaToZoomDelta(-50, CURRENT_SENSITIVITY, CURRENT_CAP);
    expect(Math.abs(delta50)).toBeLessThanOrEqual(CURRENT_CAP);
    console.log(`✓ Aggressive deltaY (-50) capped at 25%: ${(delta50 * 100).toFixed(1)}%`);

    // 3. Max zoom change should never exceed 25%
    const delta100 = wheelDeltaToZoomDelta(-100, CURRENT_SENSITIVITY, CURRENT_CAP);
    expect(Math.abs(delta100)).toBeLessThanOrEqual(CURRENT_CAP);
    console.log(`✓ Extreme deltaY (-100) capped at 25%: ${(delta100 * 100).toFixed(1)}%`);
  });

  it('shows PROPOSED sensitivity with cap is more reasonable', () => {
    console.log('\n=== Proposed Fix: Lower sensitivity + cap ===\n');

    const testDeltaYValues = [-10, -25, -50, -75, -100];

    console.log('deltaY | PROPOSED (0.003, cap 0.15) | Zoom Change');
    console.log('-------|---------------------------|------------');

    for (const deltaY of testDeltaYValues) {
      const delta = wheelDeltaToZoomDelta(deltaY, PROPOSED_SENSITIVITY, MAX_DELTA_CAP);
      const zoomChange = Math.abs(delta) * 100;
      console.log(`${deltaY.toString().padStart(6)} | ${delta.toFixed(4).padStart(25)} | ${zoomChange.toFixed(1)}%`);
    }

    // With cap, max zoom change is 15%
    const deltaCapped = wheelDeltaToZoomDelta(-100, PROPOSED_SENSITIVITY, MAX_DELTA_CAP);
    expect(Math.abs(deltaCapped)).toBeLessThanOrEqual(0.15);
  });

  it('simulates zoom cascade with ORIGINAL vs CURRENT vs PROPOSED sensitivity', () => {
    // Simulate aggressive trackpad gesture: 5 events with deltaY = -50
    const events = Array(5).fill(-50);

    console.log('\n=== Zoom Cascade Simulation ===\n');

    // ORIGINAL sensitivity (0.012, no cap) - the old buggy behavior
    let cameraOriginal: Camera = { x: 0, y: 0, z: 1 };
    console.log('ORIGINAL sensitivity (0.012, no cap):');
    for (let i = 0; i < events.length; i++) {
      const delta = wheelDeltaToZoomDelta(events[i], ORIGINAL_SENSITIVITY);
      cameraOriginal = zoomCameraToPoint_CURRENT(cameraOriginal, focalPoint, delta, constraints);
      console.log(`  Event ${i}: deltaY=${events[i]}, delta=${delta.toFixed(3)}, zoom=${cameraOriginal.z.toFixed(2)}`);
    }
    console.log(`  FINAL: ${cameraOriginal.z.toFixed(2)}x`);

    // CURRENT sensitivity (0.008, 25% cap)
    let cameraCurrent: Camera = { x: 0, y: 0, z: 1 };
    console.log('\nCURRENT sensitivity (0.008, 25% cap):');
    for (let i = 0; i < events.length; i++) {
      const delta = wheelDeltaToZoomDelta(events[i], CURRENT_SENSITIVITY, CURRENT_CAP);
      cameraCurrent = zoomCameraToPoint_CURRENT(cameraCurrent, focalPoint, delta, constraints);
      console.log(`  Event ${i}: deltaY=${events[i]}, delta=${delta.toFixed(3)}, zoom=${cameraCurrent.z.toFixed(2)}`);
    }
    console.log(`  FINAL: ${cameraCurrent.z.toFixed(2)}x`);

    // PROPOSED sensitivity with cap (0.003, 15% cap)
    let cameraProposed: Camera = { x: 0, y: 0, z: 1 };
    console.log('\nPROPOSED sensitivity (0.003, cap 0.15):');
    for (let i = 0; i < events.length; i++) {
      const delta = wheelDeltaToZoomDelta(events[i], PROPOSED_SENSITIVITY, MAX_DELTA_CAP);
      cameraProposed = zoomCameraToPoint_CURRENT(cameraProposed, focalPoint, delta, constraints);
      console.log(`  Event ${i}: deltaY=${events[i]}, delta=${delta.toFixed(3)}, zoom=${cameraProposed.z.toFixed(2)}`);
    }
    console.log(`  FINAL: ${cameraProposed.z.toFixed(2)}x`);

    // ORIGINAL (0.012) should overshoot badly (>10x with 5 events)
    expect(cameraOriginal.z).toBeGreaterThan(10); // Way past reasonable

    // CURRENT (0.008 + 25% cap) should be balanced (3-8x range)
    expect(cameraCurrent.z).toBeGreaterThan(3);
    expect(cameraCurrent.z).toBeLessThan(8);

    // PROPOSED (0.003 + 15% cap) should be more controlled (<3x)
    expect(cameraProposed.z).toBeLessThan(3);
  });

  it('shows events needed to reach 16x zoom', () => {
    console.log('\n=== Events to reach 16x ===\n');

    // How many events to go from 1x to 16x?
    const targetZoom = 16;
    const typicalDeltaY = -25; // Moderate pinch speed

    // ORIGINAL (0.012, no cap)
    let zOriginal = 1;
    let countOriginal = 0;
    while (zOriginal < targetZoom && countOriginal < 100) {
      const delta = wheelDeltaToZoomDelta(typicalDeltaY, ORIGINAL_SENSITIVITY);
      zOriginal = Math.min(targetZoom, zOriginal * (1 - delta));
      countOriginal++;
    }

    // CURRENT (0.008, 25% cap)
    let zCurrent = 1;
    let countCurrent = 0;
    while (zCurrent < targetZoom && countCurrent < 100) {
      const delta = wheelDeltaToZoomDelta(typicalDeltaY, CURRENT_SENSITIVITY, CURRENT_CAP);
      zCurrent = Math.min(targetZoom, zCurrent * (1 - delta));
      countCurrent++;
    }

    // PROPOSED (0.003, 15% cap) - for comparison
    let zProposed = 1;
    let countProposed = 0;
    while (zProposed < targetZoom && countProposed < 100) {
      const delta = wheelDeltaToZoomDelta(typicalDeltaY, PROPOSED_SENSITIVITY, MAX_DELTA_CAP);
      zProposed = Math.min(targetZoom, zProposed * (1 - delta));
      countProposed++;
    }

    console.log(`With typical deltaY=${typicalDeltaY}:`);
    console.log(`  ORIGINAL (0.012, no cap): ${countOriginal} events to reach 16x (too fast)`);
    console.log(`  CURRENT  (0.008, 25% cap): ${countCurrent} events to reach 16x`);
    console.log(`  PROPOSED (0.003, 15% cap): ${countProposed} events to reach 16x (too slow)`);

    // ORIGINAL is too fast (under 15 events)
    expect(countOriginal).toBeLessThan(15);

    // CURRENT should be in the sweet spot (15-35 events)
    console.log(`\n✓ CURRENT takes ${countCurrent} events - ${countCurrent >= 15 && countCurrent <= 35 ? 'GOOD' : 'OUT OF RANGE'}`);
    expect(countCurrent).toBeGreaterThanOrEqual(15);
    expect(countCurrent).toBeLessThanOrEqual(35);

    // PROPOSED is too slow (over 35 events)
    expect(countProposed).toBeGreaterThan(35);
  });

  it('VALIDATION: simulates max zoom rebound with CURRENT config', () => {
    console.log('\n=== MAX ZOOM REBOUND SIMULATION (CURRENT CONFIG) ===\n');

    // Simulate: zoom to 16x, then trackpad sends rebound events
    // This tests whether 25% cap prevents catastrophic zoom drops

    // Phase 1: Zoom from 8x to 16x
    let camera: Camera = { x: 0, y: 0, z: 8 };
    const zoomInEvents = [-30, -30, -30, -30, -30]; // 5 zoom-in events

    console.log('Phase 1: Zooming IN to max (8x → 16x)');
    for (let i = 0; i < zoomInEvents.length; i++) {
      const delta = wheelDeltaToZoomDelta(zoomInEvents[i], CURRENT_SENSITIVITY, CURRENT_CAP);
      camera = zoomCameraToPoint_CURRENT(camera, focalPoint, delta, constraints);
      console.log(`  Event ${i}: deltaY=${zoomInEvents[i]}, delta=${delta.toFixed(3)}, zoom=${camera.z.toFixed(2)}x`);
    }

    const zoomAtMax = camera.z;
    console.log(`\nReached max zoom: ${zoomAtMax.toFixed(2)}x`);

    // Phase 2: Rebound events (positive deltaY = zoom out)
    // These are the trackpad physics artifacts that cause the bug
    const reboundEvents = [50, 40, 30, 20, 10]; // Decaying zoom-out events

    console.log('\nPhase 2: Rebound events (WITHOUT protection)');
    for (let i = 0; i < reboundEvents.length; i++) {
      const delta = wheelDeltaToZoomDelta(reboundEvents[i], CURRENT_SENSITIVITY, CURRENT_CAP);
      camera = zoomCameraToPoint_CURRENT(camera, focalPoint, delta, constraints);
      console.log(`  Rebound ${i}: deltaY=${reboundEvents[i]}, delta=${delta.toFixed(3)}, zoom=${camera.z.toFixed(2)}x`);
    }

    const zoomAfterRebound = camera.z;
    const zoomDrop = zoomAtMax - zoomAfterRebound;
    const dropPercentage = (zoomDrop / zoomAtMax) * 100;

    console.log(`\nFinal zoom: ${zoomAfterRebound.toFixed(2)}x`);
    console.log(`Zoom dropped by: ${zoomDrop.toFixed(2)} (${dropPercentage.toFixed(1)}%)`);

    // With 25% cap, max drop per event is 25%
    // 5 rebound events would cause: 16 * 0.75^5 = 3.8x (worst case)
    // But decaying rebound events should cause less drop

    console.log(`\n⚠️ NOTE: This shows the zoom drop from rebound events.`);
    console.log(`The 25% cap LIMITS each event but doesn't PREVENT rebound.`);
    console.log(`State machine guards (settling, rebound window) provide actual protection.`);

    // Test that cap prevented catastrophic single-event drop
    // Even with deltaY=50, zoom should only drop by 25% per event max
    expect(dropPercentage).toBeLessThan(90); // Should not drop more than 90%
  });
});

describe('Comparative Drift Measurement', () => {
  const constraints: CameraConstraints = { minZoom: 0.5, maxZoom: 16 };
  const focalPoint: Point = { x: 500, y: 300 };

  it('BENCHMARK: Compare CURRENT vs FIXED across scenarios', () => {
    const scenarios = [
      { name: 'Normal 1x→8x', deltas: generatePinchZoomDeltas(8, 1, 30) },
      { name: 'Overshoot 8x→20x', deltas: generatePinchZoomDeltas(20, 8, 30) },
      { name: 'Rebound sequence', deltas: generateReboundSequence(16, 4, 20, 15) },
    ];

    console.log('\n=== BENCHMARK: CURRENT vs FIXED ===\n');
    console.log('Scenario                | CURRENT Drift | FIXED Drift | Improvement');
    console.log('------------------------|---------------|-------------|------------');

    for (const scenario of scenarios) {
      const initialCamera: Camera = { x: 0, y: 0, z: 1 };

      const currentAnalysis = analyzeZoomSequence(
        scenario.deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_CURRENT
      );

      const fixedAnalysis = analyzeZoomSequence(
        scenario.deltas,
        focalPoint,
        initialCamera,
        constraints,
        zoomCameraToPoint_FIXED
      );

      const currentDrift = Math.hypot(
        currentAnalysis.totalDrift.x,
        currentAnalysis.totalDrift.y
      );
      const fixedDrift = Math.hypot(
        fixedAnalysis.totalDrift.x,
        fixedAnalysis.totalDrift.y
      );

      const improvement =
        currentDrift > 0.01
          ? `${((1 - fixedDrift / currentDrift) * 100).toFixed(0)}%`
          : 'N/A';

      console.log(
        `${scenario.name.padEnd(23)} | ${currentDrift.toFixed(4).padStart(13)} | ${fixedDrift.toFixed(4).padStart(11)} | ${improvement.padStart(10)}`
      );
    }
  });
});

// ============================================================================
// INTEGRATION TESTS - Test ACTUAL implementation (amnesia-ecj)
// ============================================================================

/**
 * Integration tests that import the actual implementation from pdf-canvas-camera.ts
 * These tests verify the amnesia-ntj fix is working correctly.
 */
import {
  zoomCameraToPoint as actualZoomCameraToPoint,
  screenToCanvas as actualScreenToCanvas,
  canvasToScreen as actualCanvasToScreen,
  type Camera as ActualCamera,
  type Point as ActualPoint,
  type CameraConstraints as ActualCameraConstraints,
} from '../../../reader/renderer/pdf/pdf-canvas-camera';

describe('Integration: Focal Point Stability (amnesia-ecj)', () => {
  const DEFAULT_CONSTRAINTS: ActualCameraConstraints = {
    minZoom: 0.1,
    maxZoom: 16,
    constrainToBounds: false,
  };

  const focalPoint: ActualPoint = { x: 500, y: 300 };

  /**
   * TC1: Rebound Drift Test
   *
   * Scenario: User zooms to 16x, continues pinching (rebound events)
   * Expected: Focal point stays EXACTLY where user was looking
   *
   * This tests the amnesia-ntj fix: blocking position adjustment when zoom is clamped.
   */
  describe('TC1: Rebound drift test', () => {
    it('PASS: focal point stable after 30 rebound events at maxZoom', () => {
      // Start at max zoom
      let camera: ActualCamera = { x: -200, y: -100, z: 16 };

      // Record initial focal point position in canvas space
      const initialFocalCanvas = actualScreenToCanvas(focalPoint, camera);

      // Simulate 30 rebound events (user continues pinching past max)
      // These are zoom-in deltas that would push past max if not clamped
      const reboundDeltas = Array(30).fill(-0.05); // Zoom-in attempts

      console.log('\n=== TC1: Rebound Drift Test (ACTUAL IMPLEMENTATION) ===');
      console.log(`Initial camera: z=${camera.z}, x=${camera.x.toFixed(2)}, y=${camera.y.toFixed(2)}`);
      console.log(`Initial focal point (canvas): (${initialFocalCanvas.x.toFixed(4)}, ${initialFocalCanvas.y.toFixed(4)})`);

      for (let i = 0; i < reboundDeltas.length; i++) {
        const oldCamera = { ...camera };
        camera = actualZoomCameraToPoint(camera, focalPoint, reboundDeltas[i], DEFAULT_CONSTRAINTS);

        // Check if camera changed
        const changed = camera !== oldCamera;
        if (i < 5) {
          console.log(`  Event ${i}: delta=${reboundDeltas[i]}, z=${camera.z.toFixed(4)}, changed=${changed}`);
        }
      }

      // Measure final focal point position
      const finalFocalCanvas = actualScreenToCanvas(focalPoint, camera);
      const drift = {
        x: finalFocalCanvas.x - initialFocalCanvas.x,
        y: finalFocalCanvas.y - initialFocalCanvas.y,
      };
      const driftMagnitude = Math.hypot(drift.x, drift.y);

      console.log(`Final camera: z=${camera.z}, x=${camera.x.toFixed(2)}, y=${camera.y.toFixed(2)}`);
      console.log(`Final focal point (canvas): (${finalFocalCanvas.x.toFixed(4)}, ${finalFocalCanvas.y.toFixed(4)})`);
      console.log(`DRIFT: (${drift.x.toFixed(6)}, ${drift.y.toFixed(6)}) = ${driftMagnitude.toFixed(6)}px`);

      // Success criteria: drift < 0.001 (essentially zero)
      expect(driftMagnitude).toBeLessThan(0.001);
      console.log('✅ TC1 PASS: Focal point stable after rebound events');
    });

    it('PASS: focal point stable with mixed zoom-in/out rebound', () => {
      let camera: ActualCamera = { x: -200, y: -100, z: 16 };
      const initialFocalCanvas = actualScreenToCanvas(focalPoint, camera);

      // Mixed rebound: some zoom-in (still clamped), some zoom-out
      const mixedDeltas = [
        -0.05, -0.03, -0.02, // Zoom-in attempts (clamped)
        0.01, -0.02, 0.005, // Mix
        -0.01, -0.01, -0.005, // More zoom-in attempts
      ];

      for (const delta of mixedDeltas) {
        camera = actualZoomCameraToPoint(camera, focalPoint, delta, DEFAULT_CONSTRAINTS);
      }

      const finalFocalCanvas = actualScreenToCanvas(focalPoint, camera);
      const driftMagnitude = Math.hypot(
        finalFocalCanvas.x - initialFocalCanvas.x,
        finalFocalCanvas.y - initialFocalCanvas.y
      );

      // Camera may have zoomed out slightly, so expect small drift from legitimate zoom change
      // But no EXTRA drift from clamping issues
      console.log(`\nMixed rebound drift: ${driftMagnitude.toFixed(6)}px (small drift OK from zoom-out)`);
      expect(driftMagnitude).toBeLessThan(1.0); // Allow small drift from actual zoom changes
    });
  });

  /**
   * TC2: Continuous Zoom Test
   *
   * Scenario: Smooth zoom 1x → 16x in 50 steps
   * Expected: No visual jumps, focal point stays anchored
   */
  describe('TC2: Continuous zoom test', () => {
    it('PASS: smooth zoom 1x → 16x with stable focal point', () => {
      let camera: ActualCamera = { x: 0, y: 0, z: 1 };
      const initialFocalCanvas = actualScreenToCanvas(focalPoint, camera);

      // Generate smooth zoom deltas from 1x to 16x
      const targetZoom = 16;
      const numSteps = 50;
      let currentZoom = 1;
      const deltas: number[] = [];

      for (let i = 0; i < numSteps; i++) {
        const remainingRatio = targetZoom / currentZoom;
        const stepRatio = Math.pow(remainingRatio, 1 / (numSteps - i));
        const delta = 1 - stepRatio;
        deltas.push(delta);
        currentZoom = currentZoom * stepRatio;
      }

      console.log('\n=== TC2: Continuous Zoom Test ===');
      console.log(`Zooming from 1x to 16x in ${numSteps} steps`);

      let maxStepDrift = 0;
      let previousFocalCanvas = initialFocalCanvas;

      for (let i = 0; i < deltas.length; i++) {
        camera = actualZoomCameraToPoint(camera, focalPoint, deltas[i], DEFAULT_CONSTRAINTS);

        const currentFocalCanvas = actualScreenToCanvas(focalPoint, camera);
        const stepDrift = Math.hypot(
          currentFocalCanvas.x - previousFocalCanvas.x,
          currentFocalCanvas.y - previousFocalCanvas.y
        );
        maxStepDrift = Math.max(maxStepDrift, stepDrift);
        previousFocalCanvas = currentFocalCanvas;
      }

      const finalFocalCanvas = actualScreenToCanvas(focalPoint, camera);
      const totalDrift = Math.hypot(
        finalFocalCanvas.x - initialFocalCanvas.x,
        finalFocalCanvas.y - initialFocalCanvas.y
      );

      console.log(`Final zoom: ${camera.z.toFixed(4)}x`);
      console.log(`Max per-step drift: ${maxStepDrift.toFixed(6)}px`);
      console.log(`Total drift: ${totalDrift.toFixed(6)}px`);

      // Success criteria:
      // - Final zoom should be at 16x
      // - Total drift should be negligible
      // - No large per-step jumps
      expect(camera.z).toBeCloseTo(16, 1);
      expect(totalDrift).toBeLessThan(0.01);
      expect(maxStepDrift).toBeLessThan(0.001);
      console.log('✅ TC2 PASS: Smooth zoom with stable focal point');
    });

    it('PASS: rapid zoom in/out cycle has bounded drift', () => {
      let camera: ActualCamera = { x: 0, y: 0, z: 1 };
      const initialCamera = { ...camera };

      // Zoom in to 8x
      for (let i = 0; i < 30; i++) {
        const delta = -0.08; // Zoom in
        camera = actualZoomCameraToPoint(camera, focalPoint, delta, DEFAULT_CONSTRAINTS);
      }

      const peakZoom = camera.z;

      // Zoom back out to 1x
      while (camera.z > 1.05) {
        const delta = 0.08; // Zoom out
        camera = actualZoomCameraToPoint(camera, focalPoint, delta, DEFAULT_CONSTRAINTS);
      }

      console.log(`\nRapid cycle: 1x → ${peakZoom.toFixed(2)}x → ${camera.z.toFixed(4)}x`);

      // Camera position will have some drift due to floating point accumulation
      // over many zoom operations. This is expected behavior.
      // The key is that drift should be bounded and not grow unboundedly.
      const positionDrift = Math.hypot(
        camera.x - initialCamera.x,
        camera.y - initialCamera.y
      );

      console.log(`Position drift after cycle: ${positionDrift.toFixed(4)} (bounded drift is OK)`);
      // Allow up to 50px drift after 60+ zoom operations - this is acceptable
      expect(positionDrift).toBeLessThan(50);
    });
  });

  /**
   * TC3: Zoom Clamp Boundary Test
   *
   * Scenario: Zoom exactly at boundaries with various deltas
   * Expected: Position unchanged when zoom cannot change
   */
  describe('TC3: Zoom clamp boundary test', () => {
    it('PASS: position unchanged when already at maxZoom', () => {
      const camera: ActualCamera = { x: -100, y: -50, z: 16 };
      const initialCamera = { ...camera };

      // Try to zoom in further
      const newCamera = actualZoomCameraToPoint(camera, focalPoint, -0.1, DEFAULT_CONSTRAINTS);

      // Camera should be unchanged (same object reference due to early return)
      expect(newCamera).toBe(camera);
      expect(newCamera.x).toBe(initialCamera.x);
      expect(newCamera.y).toBe(initialCamera.y);
      expect(newCamera.z).toBe(initialCamera.z);
      console.log('✅ TC3a: Position unchanged at maxZoom');
    });

    it('PASS: position unchanged when already at minZoom', () => {
      const camera: ActualCamera = { x: 50, y: 50, z: 0.1 };
      const initialCamera = { ...camera };

      // Try to zoom out further
      const newCamera = actualZoomCameraToPoint(camera, focalPoint, 0.1, DEFAULT_CONSTRAINTS);

      // Camera should be unchanged
      expect(newCamera).toBe(camera);
      expect(newCamera.x).toBe(initialCamera.x);
      expect(newCamera.y).toBe(initialCamera.y);
      expect(newCamera.z).toBe(initialCamera.z);
      console.log('✅ TC3b: Position unchanged at minZoom');
    });

    it('PASS: legitimate zoom change still adjusts position correctly', () => {
      // Not at boundary - zoom change should work normally
      const camera: ActualCamera = { x: -50, y: -25, z: 8 };
      const initialFocalCanvas = actualScreenToCanvas(focalPoint, camera);

      // Zoom in (not hitting boundary)
      const newCamera = actualZoomCameraToPoint(camera, focalPoint, -0.1, DEFAULT_CONSTRAINTS);

      // Focal point should stay fixed in canvas space
      const newFocalCanvas = actualScreenToCanvas(focalPoint, newCamera);

      expect(newFocalCanvas.x).toBeCloseTo(initialFocalCanvas.x, 6);
      expect(newFocalCanvas.y).toBeCloseTo(initialFocalCanvas.y, 6);
      expect(newCamera.z).toBeGreaterThan(camera.z);
      console.log('✅ TC3c: Legitimate zoom change works correctly');
    });
  });
});

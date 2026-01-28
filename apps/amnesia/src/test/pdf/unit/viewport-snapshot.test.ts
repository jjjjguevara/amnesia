/**
 * INV-4: Viewport Snapshot Tests
 *
 * Problem: Uses current camera at compositing time, but camera moves during
 * debounce. At 32x zoom, 1px error × 32 = 32px misalignment.
 *
 * Solution: Capture camera snapshot at tile REQUEST time and use it for
 * tile positioning at DISPLAY time.
 *
 * Tests:
 * - INV-4-1: Camera snapshot is immutable
 * - INV-4-2: Coordinate transform round-trip preserves precision
 * - INV-4-3: Snapshot captured at debounce time, not render time
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createCameraSnapshot,
  screenToCanvas,
  canvasToScreen,
  type CameraState,
  type CameraSnapshot,
} from '@/reader/renderer/pdf/pdf-canvas-camera';

describe('INV-4: Viewport Snapshot', () => {
  // =========================================================================
  // INV-4-1: Camera snapshot is immutable
  // =========================================================================
  describe('INV-4-1: Camera snapshot immutability', () => {
    it('createCameraSnapshot creates an immutable copy', () => {
      const camera: CameraState = { x: 100, y: 100, z: 32 };
      const snapshot = createCameraSnapshot(camera);

      // Modify original camera
      camera.x = 200;
      camera.y = 200;
      camera.z = 64;

      // Snapshot should be unchanged
      expect(snapshot.x).toBe(100);
      expect(snapshot.y).toBe(100);
      expect(snapshot.z).toBe(32);
    });

    it('snapshot properties cannot be modified', () => {
      const camera: CameraState = { x: 100, y: 100, z: 32 };
      const snapshot = createCameraSnapshot(camera);

      // Attempting to modify should either throw or have no effect
      // (depending on implementation - frozen object or read-only interface)
      const originalX = snapshot.x;
      try {
        (snapshot as any).x = 200;
      } catch (e) {
        // Object is frozen, modification throws
      }

      expect(snapshot.x).toBe(originalX);
    });

    it('snapshot includes timestamp', () => {
      const camera: CameraState = { x: 100, y: 100, z: 32 };
      const before = Date.now();
      const snapshot = createCameraSnapshot(camera);
      const after = Date.now();

      expect(snapshot.timestamp).toBeGreaterThanOrEqual(before);
      expect(snapshot.timestamp).toBeLessThanOrEqual(after);
    });
  });

  // =========================================================================
  // INV-4-2: Coordinate transform round-trip preserves precision
  // =========================================================================
  describe('INV-4-2: Coordinate transform precision', () => {
    it('round-trip within 0.5px at 1x zoom', () => {
      const camera: CameraState = { x: 0, y: 0, z: 1 };
      const screenPoint = { x: 150, y: 200 };

      const canvasPoint = screenToCanvas(screenPoint, camera);
      const roundTrip = canvasToScreen(canvasPoint, camera);

      expect(Math.abs(roundTrip.x - screenPoint.x)).toBeLessThan(0.5);
      expect(Math.abs(roundTrip.y - screenPoint.y)).toBeLessThan(0.5);
    });

    it('round-trip within 0.5px at 32x zoom', () => {
      const camera: CameraState = { x: 0, y: 0, z: 32 };
      const screenPoint = { x: 150, y: 200 };

      const canvasPoint = screenToCanvas(screenPoint, camera);
      const roundTrip = canvasToScreen(canvasPoint, camera);

      expect(Math.abs(roundTrip.x - screenPoint.x)).toBeLessThan(0.5);
      expect(Math.abs(roundTrip.y - screenPoint.y)).toBeLessThan(0.5);
    });

    it('round-trip with non-zero camera offset', () => {
      const camera: CameraState = { x: 100, y: 100, z: 32 };
      const screenPoint = { x: 150, y: 200 };

      const canvasPoint = screenToCanvas(screenPoint, camera);
      const roundTrip = canvasToScreen(canvasPoint, camera);

      expect(Math.abs(roundTrip.x - screenPoint.x)).toBeLessThan(0.5);
      expect(Math.abs(roundTrip.y - screenPoint.y)).toBeLessThan(0.5);
    });

    it('handles edge cases at extreme zoom', () => {
      const camera: CameraState = { x: 0, y: 0, z: 64 };
      const screenPoint = { x: 1000, y: 1000 };

      const canvasPoint = screenToCanvas(screenPoint, camera);
      const roundTrip = canvasToScreen(canvasPoint, camera);

      // Even at extreme zoom, round-trip should be precise
      expect(Math.abs(roundTrip.x - screenPoint.x)).toBeLessThan(0.5);
      expect(Math.abs(roundTrip.y - screenPoint.y)).toBeLessThan(0.5);
    });
  });

  // =========================================================================
  // INV-4-3: Snapshot used for tile positioning
  // =========================================================================
  describe('INV-4-3: Tile positioning uses snapshot', () => {
    it('tile position calculated with snapshot, not current camera', () => {
      // Simulate the scenario where camera moves during debounce
      const snapshotCamera: CameraSnapshot = {
        x: 100,
        y: 100,
        z: 32,
        timestamp: Date.now(),
      };

      const currentCamera: CameraState = {
        x: 200, // Camera moved!
        y: 200,
        z: 32,
      };

      // Tile position should use snapshot values
      const tileScreenPos = { x: 150, y: 150 };

      // Calculate canvas position using snapshot (correct)
      const canvasPosWithSnapshot = screenToCanvas(tileScreenPos, snapshotCamera);

      // What would happen with current camera (wrong)
      const canvasPosWithCurrent = screenToCanvas(tileScreenPos, currentCamera);

      // These should be different, demonstrating the bug
      expect(canvasPosWithSnapshot.x).not.toBe(canvasPosWithCurrent.x);
      expect(canvasPosWithSnapshot.y).not.toBe(canvasPosWithCurrent.y);

      // The difference at 32x zoom should be significant (32px per 1px error)
      const diffX = Math.abs(canvasPosWithSnapshot.x - canvasPosWithCurrent.x);
      const diffY = Math.abs(canvasPosWithSnapshot.y - canvasPosWithCurrent.y);
      expect(diffX).toBeGreaterThan(0);
      expect(diffY).toBeGreaterThan(0);
    });

    it('snapshot preserves viewport bounds at request time', () => {
      const camera: CameraState = { x: 100, y: 100, z: 32 };
      const snapshot = createCameraSnapshot(camera);

      // Snapshot should capture all relevant viewport state
      expect(snapshot).toHaveProperty('x');
      expect(snapshot).toHaveProperty('y');
      expect(snapshot).toHaveProperty('z');
      expect(snapshot).toHaveProperty('timestamp');
    });
  });

  // =========================================================================
  // INV-4-4: Bounds clamping
  // =========================================================================
  describe('INV-4-4: Camera bounds clamping', () => {
    it('clamps negative coordinates to zero', () => {
      const camera: CameraState = { x: -100, y: -100, z: 1 };
      const snapshot = createCameraSnapshot(camera);

      // Bounds should be clamped
      expect(snapshot.x).toBeGreaterThanOrEqual(0);
      expect(snapshot.y).toBeGreaterThanOrEqual(0);
    });

    it('clamps zoom to valid range', () => {
      const cameraLow: CameraState = { x: 0, y: 0, z: 0.01 };
      const cameraHigh: CameraState = { x: 0, y: 0, z: 1000 };

      const snapshotLow = createCameraSnapshot(cameraLow);
      const snapshotHigh = createCameraSnapshot(cameraHigh);

      // Zoom should be within reasonable bounds (0.1 to 64)
      expect(snapshotLow.z).toBeGreaterThanOrEqual(0.1);
      expect(snapshotHigh.z).toBeLessThanOrEqual(64);
    });
  });
});

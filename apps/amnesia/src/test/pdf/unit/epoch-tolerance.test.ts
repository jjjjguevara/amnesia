/**
 * INV-2: Adaptive Epoch Tolerance Tests
 *
 * Problem: EPOCH_TOLERANCE=5 ≈ 160ms tolerance, but 32x tiles take 300-500ms
 * to render. Tiles rejected as "stale" immediately after completing.
 *
 * Solution: Tolerance scales with zoom level to accommodate longer render times
 * at high zoom without allowing stale tiles from completely different viewports.
 *
 * Tests:
 * - INV-2-1: getEpochTolerance returns higher values at higher zoom
 * - INV-2-2: Tolerance bounds are respected (min=5, max=15)
 * - INV-2-3: Tolerance values match specification
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  getEpochTolerance,
} from '@/reader/renderer/pdf/pdf-page-element';

describe('INV-2: Adaptive Epoch Tolerance', () => {
  // =========================================================================
  // INV-2-1: getEpochTolerance returns higher values at higher zoom
  // =========================================================================
  describe('INV-2-1: Tolerance scales with zoom level', () => {
    it('returns base tolerance (5) at zoom 1x', () => {
      expect(getEpochTolerance(1)).toBe(5);
    });

    it('returns higher tolerance at zoom 16x', () => {
      const tolerance = getEpochTolerance(16);
      expect(tolerance).toBeGreaterThan(5);
      expect(tolerance).toBeLessThanOrEqual(15);
    });

    it('returns maximum tolerance (15) at zoom 32x', () => {
      expect(getEpochTolerance(32)).toBe(15);
    });

    it('tolerance increases monotonically with zoom', () => {
      const zooms = [1, 2, 4, 8, 16, 32];
      for (let i = 1; i < zooms.length; i++) {
        const prevTolerance = getEpochTolerance(zooms[i - 1]);
        const currTolerance = getEpochTolerance(zooms[i]);
        expect(currTolerance).toBeGreaterThanOrEqual(prevTolerance);
      }
    });
  });

  // =========================================================================
  // INV-2-2: Tolerance bounds are respected
  // =========================================================================
  describe('INV-2-2: Tolerance bounds', () => {
    it('never returns less than 5 (minimum)', () => {
      const zooms = [0.1, 0.5, 1, 2, 4, 8, 16, 32, 64, 100];
      for (const zoom of zooms) {
        expect(getEpochTolerance(zoom)).toBeGreaterThanOrEqual(5);
      }
    });

    it('never returns more than 15 (maximum)', () => {
      const zooms = [0.1, 0.5, 1, 2, 4, 8, 16, 32, 64, 100];
      for (const zoom of zooms) {
        expect(getEpochTolerance(zoom)).toBeLessThanOrEqual(15);
      }
    });

    it('handles edge case zoom values', () => {
      expect(getEpochTolerance(0)).toBeGreaterThanOrEqual(5);
      expect(getEpochTolerance(-1)).toBeGreaterThanOrEqual(5);
      expect(getEpochTolerance(Infinity)).toBeLessThanOrEqual(15);
    });
  });

  // =========================================================================
  // INV-2-3: Tolerance values match specification
  // =========================================================================
  describe('INV-2-3: Tolerance specification', () => {
    it('zoom <= 4: tolerance = 5 (160ms)', () => {
      expect(getEpochTolerance(1)).toBe(5);
      expect(getEpochTolerance(2)).toBe(5);
      expect(getEpochTolerance(4)).toBe(5);
    });

    it('zoom 4 < x <= 16: tolerance = 10 (320ms)', () => {
      expect(getEpochTolerance(5)).toBe(10);
      expect(getEpochTolerance(8)).toBe(10);
      expect(getEpochTolerance(16)).toBe(10);
    });

    it('zoom > 16: tolerance = 15 (480ms)', () => {
      expect(getEpochTolerance(17)).toBe(15);
      expect(getEpochTolerance(32)).toBe(15);
      expect(getEpochTolerance(64)).toBe(15);
    });
  });

  // =========================================================================
  // Integration: Tolerance used in epoch validation
  // =========================================================================
  describe('INV-2-4: Integration with epoch validation', () => {
    it('tolerance allows tiles within adaptive range at 32x', () => {
      // At 32x zoom, tolerance is 15
      // If currentEpoch=60 and tileEpoch=50, diff=10 < 15, should be accepted
      const tolerance = getEpochTolerance(32);
      const currentEpoch = 60;
      const tileEpoch = 50;
      const epochDiff = Math.abs(currentEpoch - tileEpoch);

      expect(epochDiff).toBeLessThanOrEqual(tolerance);
    });

    it('tolerance rejects tiles outside adaptive range at 1x', () => {
      // At 1x zoom, tolerance is 5
      // If currentEpoch=60 and tileEpoch=50, diff=10 > 5, should be rejected
      const tolerance = getEpochTolerance(1);
      const currentEpoch = 60;
      const tileEpoch = 50;
      const epochDiff = Math.abs(currentEpoch - tileEpoch);

      expect(epochDiff).toBeGreaterThan(tolerance);
    });
  });
});

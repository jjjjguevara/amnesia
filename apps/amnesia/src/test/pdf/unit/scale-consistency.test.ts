/**
 * INV-6: Scale Consistency Tests
 *
 * Problem: Scale calculated at 7+ locations with different capping logic.
 * Request uses getTargetScaleTier() (5 caps), cache lookup uses only precision
 * rounding → cache miss despite tiles existing.
 *
 * Solution: Centralize scale calculation with applyScaleCaps() function that
 * is used consistently for both tile requests AND cache key generation.
 *
 * Tests:
 * - INV-6-1: getTargetScaleTier matches cache lookup scale
 * - INV-6-2: All scale paths agree at 32x zoom
 * - INV-6-3: Cache key uses same scale calculation as request
 * - INV-6-4: applyScaleCaps is idempotent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  ZoomScaleService,
  createZoomScaleService,
  clearZoomScaleService,
  type ZoomScaleServiceConfig,
} from '@/reader/renderer/pdf/zoom-scale-service';

import {
  getTargetScaleTier,
  getExactTargetScale,
  applyScaleCaps,
} from '@/reader/renderer/pdf/progressive-tile-renderer';

import {
  TileCacheManager,
  resetTileCacheManager,
  quantizeScale,
  getScaleForCacheKey,
} from '@/reader/renderer/pdf/tile-cache-manager';

describe('INV-6: Scale Consistency', () => {
  const testConfig: ZoomScaleServiceConfig = {
    pixelRatio: 2,
    minZoom: 0.25,
    maxZoom: 32,
  };

  let service: ZoomScaleService;
  let cacheManager: TileCacheManager;

  beforeEach(() => {
    clearZoomScaleService();
    resetTileCacheManager();
    service = createZoomScaleService(testConfig);
    cacheManager = new TileCacheManager();
    cacheManager.setDocument('test-doc');
  });

  afterEach(() => {
    clearZoomScaleService();
    resetTileCacheManager();
  });

  // =========================================================================
  // INV-6-1: getTargetScaleTier matches cache lookup scale
  // =========================================================================
  describe('INV-6-1: Scale tier matches cache key', () => {
    it('getTargetScaleTier tier matches quantizeScale output', () => {
      const zooms = [1, 2, 4, 8, 16, 32];

      for (const zoom of zooms) {
        const { tier } = getTargetScaleTier(zoom, 2, 32);
        const quantized = quantizeScale(tier);

        // The tier should already be quantized, so quantizing again should be idempotent
        expect(quantized).toBe(tier);
      }
    });

    it('cache lookup finds tiles stored at getTargetScaleTier scale', async () => {
      // Store a tile using the scale from getTargetScaleTier
      const zoom = 32;
      const { tier: requestScale } = getTargetScaleTier(zoom, 2, 32);

      const tile = { page: 1, tileX: 0, tileY: 0, scale: requestScale, tileSize: 256 };
      const mockData = {
        format: 'rgba' as const,
        width: 256,
        height: 256,
        rgba: new Uint8Array(256 * 256 * 4),
      };

      await cacheManager.set(tile, mockData);

      // Cache lookup should find the tile
      expect(cacheManager.has(tile)).toBe(true);

      // Cache lookup with same scale calculation should also find it
      const lookupScale = getScaleForCacheKey(requestScale);
      const lookupTile = { ...tile, scale: lookupScale };
      expect(cacheManager.has(lookupTile)).toBe(true);
    });
  });

  // =========================================================================
  // INV-6-2: All scale paths agree at 32x zoom
  // =========================================================================
  describe('INV-6-2: All scale paths agree', () => {
    it('ZoomScaleService and getTargetScaleTier agree at 32x', () => {
      service.onZoomGesture(32, { x: 0, y: 0 }, { x: 0, y: 0, z: 32 });

      const serviceResult = service.getScale();
      const { tier } = getTargetScaleTier(32, 2, 32);

      // Both should return the same scale (within device capability limits)
      // Note: ZoomScaleService may apply velocity-based reduction, so we check at rest
      expect(serviceResult.scale).toBe(tier);
    });

    it('getExactTargetScale and getTargetScaleTier agree on base scale', () => {
      const zooms = [4, 8, 16, 32];

      for (const zoom of zooms) {
        const { scale: exactScale } = getExactTargetScale(zoom, 2, 32);
        const { tier } = getTargetScaleTier(zoom, 2, 32);

        // exactScale may be slightly different due to precision, but tier should match
        // or exactScale should round to tier
        const roundedExact = quantizeScale(exactScale);
        expect(roundedExact).toBe(tier);
      }
    });
  });

  // =========================================================================
  // INV-6-3: Cache key uses same scale calculation as request
  // =========================================================================
  describe('INV-6-3: Cache key consistency', () => {
    it('cache key uses quantized scale', () => {
      const tile = { page: 1, tileX: 5, tileY: 10, scale: 32, tileSize: 256 };
      const key = cacheManager.getTileKey(tile);

      // Key should contain quantized scale
      const expectedScale = getScaleForCacheKey(32);
      expect(key).toContain(`s${expectedScale}`);
    });

    it('tiles stored and retrieved use consistent scale', async () => {
      // Simulate the full flow: request → render → cache → lookup
      const zoom = 32;
      const { tier: requestScale } = getTargetScaleTier(zoom, 2, 32);

      // Store tile at request scale
      const tile = { page: 1, tileX: 0, tileY: 0, scale: requestScale, tileSize: 256 };
      const mockData = {
        format: 'rgba' as const,
        width: 256,
        height: 256,
        rgba: new Uint8Array(256 * 256 * 4),
      };
      await cacheManager.set(tile, mockData);

      // Lookup using the same scale calculation
      const lookupTile = { ...tile, scale: requestScale };
      const cached = cacheManager.getCachedData(lookupTile);

      expect(cached).not.toBeNull();
      expect(cached?.width).toBe(256);
    });

    it('different raw scales quantize to same key when in same tier', async () => {
      // Scales 31.5 and 32.5 should both quantize to 32
      const scale1 = 31.5;
      const scale2 = 32.5;

      const quantized1 = quantizeScale(scale1);
      const quantized2 = quantizeScale(scale2);

      expect(quantized1).toBe(quantized2);
    });
  });

  // =========================================================================
  // INV-6-4: applyScaleCaps is idempotent
  // =========================================================================
  describe('INV-6-4: Scale capping idempotency', () => {
    it('applyScaleCaps is idempotent', () => {
      const scales = [4, 8, 16, 32, 64, 128];

      for (const scale of scales) {
        const capped1 = applyScaleCaps(scale, 2, 32);
        const capped2 = applyScaleCaps(capped1, 2, 32);
        const capped3 = applyScaleCaps(capped2, 2, 32);

        expect(capped2).toBe(capped1);
        expect(capped3).toBe(capped1);
      }
    });

    it('applyScaleCaps respects maxZoom', () => {
      // At maxZoom=32 with DPR=2, minRequired = 64
      // But scale should be capped at device-appropriate level
      const capped = applyScaleCaps(128, 2, 32);

      // Should not exceed GPU_SAFE_MAX_SCALE (64)
      expect(capped).toBeLessThanOrEqual(64);
    });

    it('applyScaleCaps returns power of 2 or quantized value', () => {
      const scales = [3, 5, 7, 10, 15, 20, 30, 50];

      for (const scale of scales) {
        const capped = applyScaleCaps(scale, 2, 32);

        // Should be a recognized scale tier
        const isPowerOf2 = (capped & (capped - 1)) === 0;
        const isQuantized = quantizeScale(capped) === capped;

        expect(isPowerOf2 || isQuantized).toBe(true);
      }
    });
  });

  // =========================================================================
  // INV-6-5: Integration with tile rendering flow
  // =========================================================================
  describe('INV-6-5: Rendering flow integration', () => {
    it('tile request and cache lookup scales match', async () => {
      // This test simulates the full rendering flow
      const zoom = 32;
      const pixelRatio = 2;
      const maxZoom = 32;

      // Step 1: Calculate scale for tile request (what render coordinator does)
      const { tier: requestScale, cssStretch } = getTargetScaleTier(zoom, pixelRatio, maxZoom);

      // Step 2: Store tile in cache (what happens after render)
      const tile = { page: 1, tileX: 0, tileY: 0, scale: requestScale, tileSize: 256 };
      const mockData = {
        format: 'rgba' as const,
        width: 256,
        height: 256,
        rgba: new Uint8Array(256 * 256 * 4),
      };
      await cacheManager.set(tile, mockData);

      // Step 3: Calculate scale for cache lookup (what compositor does)
      const lookupScale = getScaleForCacheKey(requestScale);

      // Verify scales match
      expect(lookupScale).toBe(requestScale);

      // Step 4: Verify cache hit
      const lookupTile = { ...tile, scale: lookupScale };
      expect(cacheManager.has(lookupTile)).toBe(true);
    });
  });
});

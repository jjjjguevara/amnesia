/**
 * INV-7: Tile Data Integrity Tests
 *
 * These tests verify that invalid tile data is properly rejected at cache boundaries.
 * Root cause: Tiles with dims=0x0 cause silent compositing failure ("drew 0/25 tiles").
 *
 * Tests:
 * - INV-7-1: Reject tiles with zero width
 * - INV-7-2: Reject tiles with zero height
 * - INV-7-3: Reject tiles with rgba size mismatch
 * - INV-7-4: Reject legacy Blob without dimensions (throw error)
 * - INV-7-5: Accept valid tile data
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  TileCacheManager,
  resetTileCacheManager,
  CachedTileData,
  TileDataIntegrityError,
} from '@/reader/renderer/pdf/tile-cache-manager';

describe('INV-7: Tile Data Integrity', () => {
  let cacheManager: TileCacheManager;

  beforeEach(() => {
    resetTileCacheManager();
    cacheManager = new TileCacheManager();
    cacheManager.setDocument('test-doc');
  });

  afterEach(() => {
    resetTileCacheManager();
  });

  // =========================================================================
  // INV-7-1: Reject tiles with zero width
  // =========================================================================
  describe('INV-7-1: Reject tiles with zero width', () => {
    it('throws TileDataIntegrityError when width is 0', async () => {
      const tile = { page: 1, tileX: 0, tileY: 0, scale: 32, tileSize: 256 };
      const invalidData: CachedTileData = {
        format: 'rgba',
        width: 0,
        height: 256,
        rgba: new Uint8Array(0),
      };

      await expect(cacheManager.set(tile, invalidData)).rejects.toThrow(TileDataIntegrityError);
      await expect(cacheManager.set(tile, invalidData)).rejects.toThrow(/INV-7.*width/i);
    });

    it('does not cache tile with zero width', async () => {
      const tile = { page: 1, tileX: 0, tileY: 0, scale: 32, tileSize: 256 };
      const invalidData: CachedTileData = {
        format: 'rgba',
        width: 0,
        height: 256,
        rgba: new Uint8Array(0),
      };

      try {
        await cacheManager.set(tile, invalidData);
      } catch (e) {
        // Expected to throw
      }

      expect(cacheManager.has(tile)).toBe(false);
    });
  });

  // =========================================================================
  // INV-7-2: Reject tiles with zero height
  // =========================================================================
  describe('INV-7-2: Reject tiles with zero height', () => {
    it('throws TileDataIntegrityError when height is 0', async () => {
      const tile = { page: 1, tileX: 0, tileY: 0, scale: 32, tileSize: 256 };
      const invalidData: CachedTileData = {
        format: 'rgba',
        width: 256,
        height: 0,
        rgba: new Uint8Array(0),
      };

      await expect(cacheManager.set(tile, invalidData)).rejects.toThrow(TileDataIntegrityError);
      await expect(cacheManager.set(tile, invalidData)).rejects.toThrow(/INV-7.*height/i);
    });
  });

  // =========================================================================
  // INV-7-3: Reject tiles with rgba size mismatch
  // =========================================================================
  describe('INV-7-3: Reject tiles with rgba size mismatch', () => {
    it('throws TileDataIntegrityError when rgba array size does not match dimensions', async () => {
      const tile = { page: 1, tileX: 0, tileY: 0, scale: 32, tileSize: 256 };
      // Expected size: 256 * 256 * 4 = 262144 bytes
      // Provided: 100 bytes
      const invalidData: CachedTileData = {
        format: 'rgba',
        width: 256,
        height: 256,
        rgba: new Uint8Array(100),
      };

      await expect(cacheManager.set(tile, invalidData)).rejects.toThrow(TileDataIntegrityError);
      await expect(cacheManager.set(tile, invalidData)).rejects.toThrow(/INV-7.*rgba.*mismatch/i);
    });

    it('calculates expected size as width * height * 4', async () => {
      const tile = { page: 1, tileX: 0, tileY: 0, scale: 32, tileSize: 256 };
      // Off by one error test
      const invalidData: CachedTileData = {
        format: 'rgba',
        width: 256,
        height: 256,
        rgba: new Uint8Array(256 * 256 * 4 - 1), // One byte short
      };

      await expect(cacheManager.set(tile, invalidData)).rejects.toThrow(TileDataIntegrityError);
    });
  });

  // =========================================================================
  // INV-7-4: Reject legacy Blob without dimensions
  // =========================================================================
  describe('INV-7-4: Reject legacy Blob without dimensions', () => {
    it('throws TileDataIntegrityError for legacy Blob data', async () => {
      const tile = { page: 1, tileX: 0, tileY: 0, scale: 32, tileSize: 256 };
      const legacyBlob = new Blob([new Uint8Array(100)]);

      await expect(cacheManager.set(tile, legacyBlob)).rejects.toThrow(TileDataIntegrityError);
      await expect(cacheManager.set(tile, legacyBlob)).rejects.toThrow(/INV-7.*legacy.*blob/i);
    });
  });

  // =========================================================================
  // INV-7-5: Accept valid tile data
  // =========================================================================
  describe('INV-7-5: Accept valid tile data', () => {
    it('accepts tile with valid rgba data', async () => {
      const tile = { page: 1, tileX: 0, tileY: 0, scale: 32, tileSize: 256 };
      const validData: CachedTileData = {
        format: 'rgba',
        width: 256,
        height: 256,
        rgba: new Uint8Array(256 * 256 * 4),
      };

      // Should not throw
      await cacheManager.set(tile, validData);
      expect(cacheManager.has(tile)).toBe(true);

      const retrieved = cacheManager.getCachedData(tile);
      expect(retrieved).toBeDefined();
      expect(retrieved?.width).toBe(256);
      expect(retrieved?.height).toBe(256);
    });

    it('accepts tile with png blob and dimensions', async () => {
      const tile = { page: 1, tileX: 0, tileY: 0, scale: 16, tileSize: 256 };
      const validData: CachedTileData = {
        format: 'png',
        blob: new Blob([new Uint8Array(100)]),
        width: 256,
        height: 256,
      };

      // Should not throw
      await cacheManager.set(tile, validData);
      expect(cacheManager.has(tile)).toBe(true);
    });

    it('accepts tile with non-256 dimensions', async () => {
      const tile = { page: 1, tileX: 0, tileY: 0, scale: 8, tileSize: 512 };
      const validData: CachedTileData = {
        format: 'rgba',
        width: 512,
        height: 512,
        rgba: new Uint8Array(512 * 512 * 4),
      };

      await cacheManager.set(tile, validData);
      expect(cacheManager.has(tile)).toBe(true);
    });
  });

  // =========================================================================
  // INV-7 violation counter
  // =========================================================================
  describe('INV-7: Violation tracking', () => {
    it('increments violation counter on rejected tiles', async () => {
      const tile = { page: 1, tileX: 0, tileY: 0, scale: 32, tileSize: 256 };
      const invalidData: CachedTileData = {
        format: 'rgba',
        width: 0,
        height: 0,
        rgba: new Uint8Array(0),
      };

      const initialCount = cacheManager.getInv7ViolationCount();

      try {
        await cacheManager.set(tile, invalidData);
      } catch (e) {
        // Expected
      }

      expect(cacheManager.getInv7ViolationCount()).toBe(initialCount + 1);
    });
  });
});

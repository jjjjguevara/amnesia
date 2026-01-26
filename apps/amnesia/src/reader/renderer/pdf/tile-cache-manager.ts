/**
 * Tile Cache Manager
 *
 * 3-tier cache system inspired by Preview.app's caching strategy:
 *
 * - **L1 Cache**: Visible tiles as ImageBitmaps (GPU-ready)
 *   - Fast access for currently visible tiles
 *   - Limited size (50 tiles = ~6 pages)
 *   - Evicted on mode transition
 *
 * - **L2 Cache**: Prefetched tiles as Blobs
 *   - Quick decode to ImageBitmap
 *   - Larger capacity (200 tiles = ~25 pages)
 *   - Preserved across mode transitions
 *
 * - **L3 Cache**: Document metadata (page dimensions, text layer refs)
 *   - Never evicted during session
 *   - Shared across all modes
 *
 * @example
 * ```typescript
 * const cacheManager = getTileCacheManager();
 * const tile = { page: 1, tileX: 0, tileY: 0, scale: 2 };
 *
 * // Try to get tile from cache
 * const bitmap = await cacheManager.get(tile);
 * if (!bitmap) {
 *   // Render and cache
 *   const blob = await renderTile(tile);
 *   await cacheManager.set(tile, blob, 'L2');
 * }
 * ```
 */

import { getTelemetry } from './pdf-telemetry';
import type { TileCoordinate, TileScale } from './tile-render-engine';
import type { RenderFormat } from './mupdf-bridge';
import { SCALE_TIERS, getScaleTiers, getDynamicMaxScaleTier, roundScaleForCache, getTargetScaleTier, type ScaleTier } from './progressive-tile-renderer';
import { getTypedArrayPool } from './typed-array-pool';
import { isFeatureEnabled } from './feature-flags';
import { getTileSize } from './tile-render-engine';

// ============================================================================
// TILE COMPLIANCE VALIDATOR (amnesia-e4i)
// ============================================================================
// Validates tiles at cache boundaries to detect and log scale/grid mismatches
// that cause visual corruption during zoom+pan operations.
// ============================================================================

/**
 * Tile compliance validation result
 */
export interface TileComplianceResult {
  isCompliant: boolean;
  violations: string[];
  expectedCacheKey: string;
  actualCacheKey: string;
  caller: string;
}

/**
 * Global tile compliance statistics for debugging
 */
export interface TileComplianceStats {
  totalChecked: number;
  totalViolations: number;
  violationsByType: Record<string, number>;
  recentViolations: Array<{
    timestamp: number;
    tile: TileCoordinate;
    violation: string;
    caller: string;
    stack: string;
  }>;
}

// Global compliance stats singleton
let complianceStats: TileComplianceStats = {
  totalChecked: 0,
  totalViolations: 0,
  violationsByType: {},
  recentViolations: [],
};

const MAX_RECENT_VIOLATIONS = 50;

/**
 * Reset compliance statistics (useful for testing)
 */
export function resetTileComplianceStats(): void {
  complianceStats = {
    totalChecked: 0,
    totalViolations: 0,
    violationsByType: {},
    recentViolations: [],
  };
}

/**
 * Get current compliance statistics
 */
export function getTileComplianceStats(): TileComplianceStats {
  return { ...complianceStats };
}

/**
 * Validate a tile against expected grid parameters.
 * 
 * This function checks that:
 * 1. The tile scale matches the expected quantized scale for the cache key
 * 2. The tile coordinates are valid for the given scale (non-negative, within reasonable bounds)
 * 3. The caller stack is captured for debugging
 * 
 * @param tile The tile coordinate to validate
 * @param expectedScale The scale that SHOULD be used for this tile (from grid calculation)
 * @param currentZoom Current zoom level (for context)
 * @param caller Description of the calling code path
 * @returns Compliance result with any violations found
 */
export function validateTileCompliance(
  tile: TileCoordinate,
  expectedScale: number | undefined,
  currentZoom: number,
  caller: string
): TileComplianceResult {
  const violations: string[] = [];
  
  // Get what the cache key WOULD be for this tile
  const actualCacheKey = `p${tile.page}-t${tile.tileX}x${tile.tileY}-s${getScaleForCacheKey(tile.scale)}`;
  const expectedCacheKey = expectedScale !== undefined 
    ? `p${tile.page}-t${tile.tileX}x${tile.tileY}-s${getScaleForCacheKey(expectedScale)}`
    : actualCacheKey;
  
  complianceStats.totalChecked++;
  
  // VIOLATION 1: Scale mismatch between tile and expected grid scale
  if (expectedScale !== undefined) {
    const tileScaleForKey = getScaleForCacheKey(tile.scale);
    const expectedScaleForKey = getScaleForCacheKey(expectedScale);
    
    if (tileScaleForKey !== expectedScaleForKey) {
      violations.push(
        `SCALE_MISMATCH: tile.scale=${tile.scale} (key=${tileScaleForKey}) ` +
        `vs expected=${expectedScale} (key=${expectedScaleForKey})`
      );
    }
  }
  
  // VIOLATION 2: Invalid tile coordinates
  if (tile.tileX < 0 || tile.tileY < 0) {
    violations.push(`NEGATIVE_COORDS: tileX=${tile.tileX}, tileY=${tile.tileY}`);
  }
  
  // VIOLATION 3: Extremely large tile coordinates (likely calculation error)
  // At scale 32 with 256px tiles, a 612x792 PDF has ~76x99 tiles max
  const tileSize = getTileSize(currentZoom);
  const maxReasonableTileIndex = Math.ceil(2000 / (tileSize / tile.scale)); // 2000 PDF units is huge
  if (tile.tileX > maxReasonableTileIndex || tile.tileY > maxReasonableTileIndex) {
    violations.push(
      `EXTREME_COORDS: tileX=${tile.tileX}, tileY=${tile.tileY} ` +
      `(max reasonable ~${maxReasonableTileIndex} at scale=${tile.scale})`
    );
  }
  
  // VIOLATION 4: Scale doesn't match zoom expectation
  // amnesia-e4i FIX (2026-01-25): Use getTargetScaleTier which accounts for:
  // 1. SCALE_TIERS quantization
  // 2. GPU_SAFE_MAX_SCALE cap
  // 3. MAX_TILE_PIXELS/tileSize cap (critical for high zoom)
  // Allow 4x range for fallbacks (e.g., scale 4 at zoom 8 is a 2x fallback)
  const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 2;
  const { tier: idealTier } = getTargetScaleTier(currentZoom, pixelRatio);
  const tileScaleForKey = getScaleForCacheKey(tile.scale);
  const scaleRatio = Math.max(idealTier, tileScaleForKey) / Math.min(idealTier, tileScaleForKey);
  
  if (scaleRatio > 4 && currentZoom >= 4) {
    violations.push(
      `SCALE_ZOOM_MISMATCH: tile.scale=${tile.scale} is ${scaleRatio.toFixed(1)}x off ` +
      `from ideal=${idealTier} at zoom=${currentZoom.toFixed(2)}`
    );
  }
  
  // Record violations
  if (violations.length > 0) {
    complianceStats.totalViolations++;
    
    for (const v of violations) {
      const vType = v.split(':')[0];
      complianceStats.violationsByType[vType] = (complianceStats.violationsByType[vType] || 0) + 1;
    }
    
    // Capture stack trace for debugging
    const stack = new Error().stack?.split('\n').slice(2, 6).join(' <- ') || 'no stack';
    
    complianceStats.recentViolations.push({
      timestamp: Date.now(),
      tile: { ...tile },
      violation: violations.join('; '),
      caller,
      stack,
    });
    
    // Keep only recent violations
    if (complianceStats.recentViolations.length > MAX_RECENT_VIOLATIONS) {
      complianceStats.recentViolations.shift();
    }
    
    // Log violation with full context
    console.error(
      `[TILE-COMPLIANCE-VIOLATION] ${caller}:`,
      {
        tile: `p${tile.page} (${tile.tileX},${tile.tileY}) s${tile.scale}`,
        violations,
        expectedCacheKey,
        actualCacheKey,
        currentZoom: currentZoom.toFixed(2),
        stack: stack.substring(0, 200),
      }
    );
  }
  
  return {
    isCompliant: violations.length === 0,
    violations,
    expectedCacheKey,
    actualCacheKey,
    caller,
  };
}

/**
 * Validate a batch of tiles and return summary
 */
export function validateTileBatchCompliance(
  tiles: TileCoordinate[],
  expectedScale: number | undefined,
  currentZoom: number,
  caller: string
): { compliant: number; violations: number; details: TileComplianceResult[] } {
  let compliant = 0;
  let violations = 0;
  const details: TileComplianceResult[] = [];
  
  for (const tile of tiles) {
    const result = validateTileCompliance(tile, expectedScale, currentZoom, caller);
    if (result.isCompliant) {
      compliant++;
    } else {
      violations++;
      details.push(result);
    }
  }
  
  // Log batch summary if there are violations
  if (violations > 0) {
    console.error(
      `[TILE-BATCH-COMPLIANCE] ${caller}: ${violations}/${tiles.length} tiles have violations`,
      {
        zoom: currentZoom.toFixed(2),
        expectedScale,
        uniqueViolationTypes: [...new Set(details.flatMap(d => d.violations.map(v => v.split(':')[0])))],
      }
    );
  }
  
  return { compliant, violations, details };
}

// Expose compliance stats on window for debugging
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).getTileComplianceStats = getTileComplianceStats;
  (window as unknown as Record<string, unknown>).resetTileComplianceStats = resetTileComplianceStats;
}

// ============================================================================
// END TILE COMPLIANCE VALIDATOR
// ============================================================================

/**
 * Quantize a scale to the nearest cache-friendly tier.
 *
 * This dramatically improves cache hit rates by mapping nearby scales to the same key:
 * - Raw scales like 0.526, 0.53, 0.52 all map to tier 1 (or thumbnail bucket)
 * - Raw scales like 3.8, 4.0, 4.2 all map to tier 4
 *
 * SCALE_TIERS = [2, 3, 4, 6, 8, 12, 16, 24, 32]
 * Sub-1 scales use buckets: [0.25, 0.5, 1] for thumbnails and low-zoom
 *
 * CRITICAL: This function MUST be used by both TileCacheManager and RenderCoordinator
 * to ensure cache keys match deduplication keys. Using different quantization would cause:
 * 1. Duplicate renders (same visual tile rendered multiple times)
 * 2. Cache misses (keys don't match between set and get)
 *
 * @param scale The raw scale value to quantize
 * @returns The quantized scale tier
 */
export function quantizeScale(scale: number): number {
  // For sub-1 scales (thumbnails, low zoom), use coarse buckets
  if (scale < 1) {
    if (scale < 0.375) return 0.25;  // 0.25 bucket
    if (scale < 0.75) return 0.5;    // 0.5 bucket (thumbnail scale)
    return 1;                         // 1 bucket
  }

  // For scales >= 1, find the nearest scale tier
  // amnesia-e4i: Use getScaleTiers() for configurable A/B testing
  // Scale 1-1.5 maps to 1, 1.5-2.5 maps to 2, etc.
  if (scale < 1.5) return 1;

  // Get dynamic max scale for high-end devices
  const dynamicMaxScale = getDynamicMaxScaleTier();
  if (scale >= dynamicMaxScale) return dynamicMaxScale;

  // Find closest tier using active configuration
  const scaleTiers = getScaleTiers();
  let prevTier: number = scaleTiers[0];
  for (const tier of scaleTiers) {
    // Stop at dynamic max scale
    if (tier > dynamicMaxScale) break;

    if (scale < tier) {
      // Check which is closer: prev tier or current tier
      const midpoint = (prevTier + tier) / 2;
      return scale < midpoint ? prevTier : tier;
    }
    prevTier = tier;
  }

  // Scale exceeds max tier, use dynamic max
  return dynamicMaxScale;
}

/**
 * Get the scale value to use for cache keys.
 *
 * When useExactScaleRendering is enabled, returns precision-rounded exact scale.
 * Otherwise, returns quantized scale tier for backwards compatibility.
 *
 * @param scale The raw scale value
 * @returns The scale value to use in cache keys
 */
export function getScaleForCacheKey(scale: number): number {
  if (isFeatureEnabled('useExactScaleRendering')) {
    // Exact scale mode: use precision-rounded scale
    return roundScaleForCache(scale);
  }
  // Legacy mode: quantize to nearest tier
  return quantizeScale(scale);
}

/**
 * Cached tile data - either PNG blob or raw RGBA pixels
 */
export interface CachedTileData {
  format: RenderFormat;
  /** PNG blob (when format === 'png') */
  blob?: Blob;
  /** Raw RGBA pixel data (when format === 'rgba') */
  rgba?: Uint8Array;
  /** Tile dimensions (required for RGBA format) */
  width: number;
  height: number;
  /** CSS scale factor to apply when displaying (for vector optimization) */
  cssScaleFactor?: number;
  /** Whether this tile was rendered with vector scale optimization */
  wasOptimized?: boolean;
  /** Target display width after CSS scaling (for vector optimization) */
  targetWidth?: number;
  /** Target display height after CSS scaling (for vector optimization) */
  targetHeight?: number;
}

/**
 * Cached page classification data (Phase 5: Content-Type Detection)
 */
export interface CachedPageClassification {
  /** Content type classification */
  type: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Time taken to classify (ms) */
  classificationTimeMs: number;
  /** Whether page has transparency */
  hasTransparency: boolean;
  /** Timestamp when classification was created */
  timestamp: number;
}

/** Page metadata cached in L3 */
export interface PageMetadata {
  page: number;
  width: number;
  height: number;
  hasTextLayer: boolean;
  textLayerData?: unknown; // Cached text layer
  /** Content-type classification (Phase 5) */
  classification?: CachedPageClassification;
}

/** L1/L2 cache entry with timestamp for LRU */
interface CacheEntry<T> {
  value: T;
  timestamp: number;
  size: number; // Approximate size in bytes
}

/**
 * Simple LRU cache implementation with optional cleanup callback
 */
class LRUCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private maxSize: number;
  private currentSize = 0;
  private maxBytes: number;
  private onEvict?: (value: V) => void;

  constructor(options: { maxSize?: number; maxBytes?: number; onEvict?: (value: V) => void }) {
    this.maxSize = options.maxSize ?? 100;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024; // 100MB default
    this.onEvict = options.onEvict;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Update timestamp (move to end for LRU)
      entry.timestamp = Date.now();
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry.value;
    }
    return undefined;
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  set(key: K, value: V, size: number = 0): void {
    // Remove existing entry if present
    if (this.cache.has(key)) {
      const existing = this.cache.get(key)!;
      this.currentSize -= existing.size;
      this.cache.delete(key);
    }

    // Evict entries if over limits
    while (
      (this.cache.size >= this.maxSize || this.currentSize + size > this.maxBytes) &&
      this.cache.size > 0
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.cache.get(oldestKey)!;
        // Call cleanup callback before evicting (e.g., ImageBitmap.close())
        this.onEvict?.(oldest.value);
        this.currentSize -= oldest.size;
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { value, timestamp: Date.now(), size });
    this.currentSize += size;
  }

  delete(key: K): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.currentSize -= entry.size;
      return this.cache.delete(key);
    }
    return false;
  }

  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Resize the cache limits dynamically
   * Evicts entries if new limits are smaller than current usage
   */
  resize(options: { maxSize?: number; maxBytes?: number }): void {
    if (options.maxSize !== undefined) {
      this.maxSize = options.maxSize;
    }
    if (options.maxBytes !== undefined) {
      this.maxBytes = options.maxBytes;
    }

    // Evict entries if over new limits
    while (
      (this.cache.size > this.maxSize || this.currentSize > this.maxBytes) &&
      this.cache.size > 0
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.cache.get(oldestKey)!;
        this.onEvict?.(oldest.value);
        this.currentSize -= oldest.size;
        this.cache.delete(oldestKey);
      }
    }
  }

  get bytes(): number {
    return this.currentSize;
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  entries(): IterableIterator<[K, CacheEntry<V>]> {
    return this.cache.entries();
  }
}

/**
 * Cache entry type indicator
 */
export type CacheEntryType = 'tile' | 'full-page';

/**
 * Tile Cache Manager with 2-tier caching
 *
 * NOTE: We store CachedTileData (Blobs or RGBA pixels) instead of ImageBitmaps
 * to avoid lifecycle issues. ImageBitmaps are created fresh on each get() call -
 * the caller owns them and is responsible for closing them after use.
 *
 * Supports both PNG (legacy) and RGBA (optimized) tile formats.
 *
 * Phase A+.3: Also supports full-page cache entries for the hybrid rendering
 * strategy. Full-page entries use a different key format:
 * - Tiles: `${docId}-p${page}-t${tileX}x${tileY}-s${scale}`
 * - Full-page: `${docId}-p${page}-full-s${scale}`
 */
export class TileCacheManager {
  /** L1: Hot tiles (recently accessed, smaller capacity) */
  private l1Cache: LRUCache<string, CachedTileData>;

  /** L2: Prefetched tiles (larger capacity) */
  private l2Cache: LRUCache<string, CachedTileData>;

  /** L3: Document metadata cache */
  private l3Cache: Map<number, PageMetadata>;

  /** Current document ID */
  private documentId: string | null = null;

  /** Track consecutive cache misses for performance debugging */
  private consecutiveMisses = 0;

  /** L2 cache max size for memory pressure calculation */
  private l2MaxSize: number;

  /**
   * Priority function for focal-point-aware eviction (amnesia-x6q).
   * When set, eviction prefers low-priority tiles over high-priority ones.
   */
  private priorityFunction: ((page: number, tileX: number, tileY: number) => number) | null = null;

  // ============================================================================
  // JPEG TILE SLICING CACHE (amnesia-xlc.3)
  // ============================================================================
  // For scanned PDFs (SCANNED_JPEG content type), extracting the embedded JPEG
  // and decoding it to ImageData is much faster than WASM rendering. This cache
  // stores decoded page images for tile slicing at high zoom levels.
  //
  // Flow:
  // 1. On first tile request for a scanned page, extract JPEG and decode to ImageData
  // 2. Cache the decoded ImageData (full page resolution)
  // 3. Slice requested tile region from cached ImageData
  // 4. Evict oldest entries when memory budget exceeded
  // ============================================================================

  /**
   * Cached decoded JPEG page data for tile slicing.
   * Key: `${docId}-${pageNum}`
   */
  private jpegCache: Map<string, {
    /** Decoded RGBA pixel data */
    imageData: ImageData;
    /** Page dimensions at native resolution */
    width: number;
    height: number;
    /** Page number (1-indexed) */
    pageNum: number;
    /** Last access timestamp for LRU eviction */
    lastAccess: number;
    /** Size in bytes (width * height * 4) */
    sizeBytes: number;
  }> = new Map();

  /** Current JPEG cache size in bytes */
  private jpegCacheBytes = 0;

  /** Max JPEG cache size in bytes (device-aware, set in constructor) */
  private jpegCacheMaxBytes: number = 100 * 1024 * 1024; // 100MB default

  /** Callback to extract JPEG from document (set by RenderCoordinator) */
  private extractJpegCallback: ((docId: string, pageNum: number) => Promise<{
    data: Uint8Array;
    width: number;
    height: number;
  }>) | null = null;

  // ============================================================================
  // SCALE-TIER INDEX (amnesia-aqv Phase 2A)
  // ============================================================================
  // Tracks which (page, scale, tileSize) combinations have any cached tiles.
  // This enables O(1) lookup to skip scale tiers with no cached data during
  // fallback tile search, reducing the search from O(scale_tiers × tile_sizes)
  // to O(populated_tiers).
  //
  // Structure: page → scale → Set of tileSizes that have at least one tile
  // Example: Map { 1 → Map { 8 → Set { 256, 512 }, 16 → Set { 256 } } }
  // ============================================================================
  
  /**
   * Index of cached tile scale tiers by page.
   * Used for O(1) lookup during fallback tile search.
   */
  private scaleTierIndex: Map<number, Map<number, Set<number>>> = new Map();

  constructor(options?: {
    l1MaxSize?: number;
    l2MaxSize?: number;
    l2MaxBytes?: number;
  }) {
    // LOOKAHEAD FIX: Increased L1 cache to match larger buffer sizes.
    //
    // At 16x zoom with 3-tile lookahead buffers:
    // - Visible area: ~6x4 = 24 tiles
    // - Render buffer (3 tiles each direction): +6x2 + 4x2 = 20 tiles
    // - Total per page: ~44 tiles
    // - With 2-3 pages in element buffer: ~130 tiles needed
    //
    // L1: 200 tiles - holds visible area + render buffer for 2-3 pages
    // This prevents excessive L1 misses during scroll at high zoom.
    this.l1Cache = new LRUCache<string, CachedTileData>({
      maxSize: options?.l1MaxSize ?? 200,
    });

    // L2: 360 tiles (~40 pages), 360MB max
    // Increased from 200/200MB to accommodate more scale tiers
    this.l2MaxSize = options?.l2MaxSize ?? 360;
    this.l2Cache = new LRUCache<string, CachedTileData>({
      maxSize: this.l2MaxSize,
      maxBytes: options?.l2MaxBytes ?? 360 * 1024 * 1024,
    });

    // L3: Unbounded metadata cache
    this.l3Cache = new Map();
  }

  /**
   * Set the current document ID
   *
   * MULTI-TAB FIX: We no longer clear L1/L2 caches when switching documents.
   * Since documentId is included in the cache key (via getTileKey()), tiles
   * from different documents are already isolated and won't collide.
   *
   * Previously, switching between two PDF tabs would clear all cached tiles,
   * causing 79+ consecutive cache misses and severe performance degradation.
   *
   * L3 (metadata cache) still needs clearing because it uses page number as key
   * without documentId, so page metadata from different documents would collide.
   */
  setDocument(docId: string): void {
    if (this.documentId !== docId) {
      // Only clear L3 (metadata) which uses page numbers without documentId
      // L1/L2 tile caches include documentId in keys, so no need to clear
      this.l3Cache.clear();
      this.documentId = docId;
      console.log(`[TileCacheManager] Document switched to ${docId}, L3 cleared (L1/L2 preserved)`);
    }
  }

  /**
   * Update cache limits at runtime (hot-reload support)
   *
   * Note: L1 cache only supports maxSize (entry count), not byte limits.
   * L2 cache supports both maxSize and maxBytes.
   *
   * @param options New cache limits
   */
  updateCacheLimits(options: {
    l1MaxSize?: number;
    l2MaxSize?: number;
    l2MaxBytes?: number;
  }): void {
    // L1 only supports entry count limit (not byte limit)
    if (options.l1MaxSize !== undefined) {
      this.l1Cache.resize({
        maxSize: options.l1MaxSize,
      });
    }

    // L2 supports both entry count and byte limits
    if (options.l2MaxSize !== undefined || options.l2MaxBytes !== undefined) {
      // Update tracked max size for memory pressure calculation
      if (options.l2MaxSize !== undefined) {
        this.l2MaxSize = options.l2MaxSize;
      }
      this.l2Cache.resize({
        maxSize: options.l2MaxSize,
        maxBytes: options.l2MaxBytes,
      });
    }

    // Track that cache limits were updated (count)
    getTelemetry().trackCustomMetric('cacheLimitsUpdated', 1);
  }

  /**
   * Get tile cache key
   *
   * Note: Scale is processed for cache-friendly keys:
   * - Legacy mode: Quantized to nearest tier for better cache hit rates
   * - Exact scale mode: Precision-rounded for exact-scale rendering
   *
   * amnesia-e4i FIX: Cache key now includes tileSize because tile indices map to
   * different PDF regions depending on tileSize. Without this, a tile(2,2)@s8
   * rendered with tileSize=256 (covering PDF 64,64) would collide with tile(2,2)@s8
   * rendered with tileSize=512 (covering PDF 128,128).
   */
  private getTileKey(tile: TileCoordinate): string {
    const cacheScale = getScaleForCacheKey(tile.scale);
    // Use 256 as default for backward compatibility with pre-adaptive tiles
    const tileSize = tile.tileSize ?? 256;
    return `${this.documentId}-p${tile.page}-t${tile.tileX}x${tile.tileY}-s${cacheScale}-ts${tileSize}`;
  }

  /**
   * Get full-page cache key (Phase A+.3: Hybrid Rendering)
   *
   * Full-page entries use a different format to prevent key collisions with tiles:
   * - Tiles: `${docId}-p${page}-t${tileX}x${tileY}-s${scale}`
   * - Full-page: `${docId}-p${page}-full-s${scale}`
   *
   * Note: Scale is processed for cache-friendly keys.
   */
  private getFullPageKey(page: number, scale: number): string {
    const cacheScale = getScaleForCacheKey(scale);
    return `${this.documentId}-p${page}-full-s${cacheScale}`;
  }

  /**
   * Parse a cache key to determine its type and extract metadata
   *
   * @param key Cache key string
   * @returns Parsed key info or null if invalid
   */
  private parseKey(key: string): {
    type: CacheEntryType;
    page: number;
    scale: number;
    tileX?: number;
    tileY?: number;
  } | null {
    // Try full-page format first: docId-p{page}-full-s{scale}
    // Using (\d+(?:\.\d+)?) to support both integer and decimal scales
    const fullPageMatch = key.match(/-p(\d+)-full-s(\d+(?:\.\d+)?)$/);
    if (fullPageMatch) {
      return {
        type: 'full-page',
        page: parseInt(fullPageMatch[1], 10),
        scale: parseFloat(fullPageMatch[2]),
      };
    }

    // Try tile format: docId-p{page}-t{tileX}x{tileY}-s{scale}
    const tileMatch = key.match(/-p(\d+)-t(\d+)x(\d+)-s(\d+(?:\.\d+)?)$/);
    if (tileMatch) {
      return {
        type: 'tile',
        page: parseInt(tileMatch[1], 10),
        tileX: parseInt(tileMatch[2], 10),
        tileY: parseInt(tileMatch[3], 10),
        scale: parseFloat(tileMatch[4]),
      };
    }

    return null;
  }

  /**
   * Create ImageBitmap from cached tile data
   * Handles both PNG blobs and raw RGBA formats
   *
   * For vector-optimized tiles (cssScaleFactor > 1), applies CSS upscaling
   * via createImageBitmap's resize options for crisp vector graphics.
   */
  private async createBitmapFromCachedData(data: CachedTileData): Promise<ImageBitmap> {
    // Calculate target dimensions for vector-optimized tiles
    const needsUpscale = data.wasOptimized && data.cssScaleFactor && data.cssScaleFactor > 1;
    const targetWidth = needsUpscale && data.targetWidth ? data.targetWidth : undefined;
    const targetHeight = needsUpscale && data.targetHeight ? data.targetHeight : undefined;

    // Resize options for vector upscaling (high quality bicubic)
    const resizeOptions: ImageBitmapOptions | undefined = targetWidth && targetHeight
      ? {
          resizeWidth: targetWidth,
          resizeHeight: targetHeight,
          resizeQuality: 'high'  // Use high quality for vector upscaling
        }
      : undefined;

    if (data.format === 'rgba' && data.rgba) {
      // Create ImageBitmap from raw RGBA pixels
      // Much faster than PNG decode - no compression overhead
      // Use pool for temporary array to reduce GC pressure
      const pool = getTypedArrayPool();
      const rgbaArray = pool.acquireUint8ClampedArray(data.rgba.length);
      rgbaArray.set(data.rgba);
      const imageData = new ImageData(rgbaArray, data.width, data.height);

      // Apply resize if vector-optimized
      let bitmap: ImageBitmap;
      if (resizeOptions) {
        bitmap = await createImageBitmap(imageData, resizeOptions);
      } else {
        bitmap = await createImageBitmap(imageData);
      }
      // Release array back to pool after bitmap is created
      pool.releaseUint8ClampedArray(rgbaArray);
      return bitmap;
    } else if (data.blob) {
      // PNG/JPEG path
      if (resizeOptions) {
        return createImageBitmap(data.blob, resizeOptions);
      }
      return createImageBitmap(data.blob);
    }
    throw new Error('Invalid cached tile data: missing rgba or blob');
  }

  /**
   * Get size of cached tile data in bytes
   */
  private getCachedDataSize(data: CachedTileData): number {
    if (data.rgba) {
      return data.rgba.byteLength;
    } else if (data.blob) {
      return data.blob.size;
    }
    return 0;
  }

  /**
   * Get a tile from cache as a fresh ImageBitmap
   *
   * Checks L1 first, then L2. Creates a new ImageBitmap from cached data.
   * The caller owns the returned ImageBitmap and should close() it after use.
   *
   * Returns null if not cached
   */
  async get(tile: TileCoordinate): Promise<ImageBitmap | null> {
    const key = this.getTileKey(tile);
    const telemetry = getTelemetry();
    
    // 2026-01-24 FIX: Max tile dimension for validation
    // A tile bitmap should be at most (tileSize * 4 * 2) per dimension to account for high-DPI
    const effectiveTileSize = tile.tileSize ?? 256;
    const MAX_TILE_DIMENSION = effectiveTileSize * 4 * 2; // e.g., 256 * 4 * 2 = 2048

    // L1 check (hot tiles)
    const l1Result = this.l1Cache.get(key);
    if (l1Result) {
      telemetry.trackCacheAccess('L1', true);
      this.consecutiveMisses = 0; // Reset on hit
      try {
        // Create fresh ImageBitmap - caller owns it
        const bitmap = await this.createBitmapFromCachedData(l1Result);
        
        // 2026-01-24 FIX: Validate bitmap dimensions
        const isBitmapOversized = bitmap.width > MAX_TILE_DIMENSION || bitmap.height > MAX_TILE_DIMENSION;
        if (isBitmapOversized) {
          console.warn(`[TileCacheManager] PURGING corrupted L1 cache entry: ` +
            `key=${key}, bitmap=${bitmap.width}x${bitmap.height} exceeds max ${MAX_TILE_DIMENSION}`);
          bitmap.close();
          this.l1Cache.delete(key);
          // Fall through to L2/null
        } else {
          return bitmap;
        }
      } catch (error) {
        console.warn('[TileCacheManager] Failed to decode L1 tile:', error);
        this.l1Cache.delete(key);
      }
    }
    telemetry.trackCacheAccess('L1', false);

    // L2 check (prefetched tiles)
    const l2Result = this.l2Cache.get(key);
    if (l2Result) {
      telemetry.trackCacheAccess('L2', true);
      this.consecutiveMisses = 0; // Reset on hit
      try {
        // Create fresh ImageBitmap - caller owns it
        const bitmap = await this.createBitmapFromCachedData(l2Result);
        
        // 2026-01-24 FIX: Validate bitmap dimensions
        const isBitmapOversized = bitmap.width > MAX_TILE_DIMENSION || bitmap.height > MAX_TILE_DIMENSION;
        if (isBitmapOversized) {
          console.warn(`[TileCacheManager] PURGING corrupted L2 cache entry: ` +
            `key=${key}, bitmap=${bitmap.width}x${bitmap.height} exceeds max ${MAX_TILE_DIMENSION}`);
          bitmap.close();
          this.l2Cache.delete(key);
          // Fall through to null
        } else {
          // Promote to L1
          const size = this.getCachedDataSize(l2Result);
          this.l1Cache.set(key, l2Result, size);
          return bitmap;
        }
      } catch (error) {
        console.warn('[TileCacheManager] Failed to decode L2 tile:', error);
        this.l2Cache.delete(key);
      }
    }
    telemetry.trackCacheAccess('L2', false);

    // Track consecutive misses for performance debugging
    // Only warn at specific thresholds to avoid flooding the console.
    // At high zoom (16x+), 100+ new tiles is normal behavior when scrolling.
    this.consecutiveMisses++;
    const missThresholds = [50, 100, 250, 500, 1000];
    if (missThresholds.includes(this.consecutiveMisses)) {
      console.warn(`[Perf] ${this.consecutiveMisses} consecutive cache misses (key: ${key})`);
    }

    return null;
  }

  /**
   * Get raw cached tile data (without creating ImageBitmap)
   */
  getCachedData(tile: TileCoordinate): CachedTileData | null {
    const key = this.getTileKey(tile);

    // Check L1 first
    const l1Result = this.l1Cache.get(key);
    if (l1Result) {
      return l1Result;
    }

    // Check L2
    const l2Result = this.l2Cache.get(key);
    if (l2Result) {
      return l2Result;
    }

    return null;
  }

  /**
   * Get tile as Blob (without decoding to ImageBitmap)
   * @deprecated Use getCachedData for format-agnostic access
   */
  async getBlob(tile: TileCoordinate): Promise<Blob | null> {
    const key = this.getTileKey(tile);

    // Check L2 directly
    const l2Result = this.l2Cache.get(key);
    if (l2Result?.blob) {
      return l2Result.blob;
    }

    return null;
  }

  /**
   * Check if tile is cached (L1 or L2)
   */
  has(tile: TileCoordinate): boolean {
    const key = this.getTileKey(tile);
    return this.l1Cache.has(key) || this.l2Cache.has(key);
  }

  /**
   * Set a tile in cache
   *
   * @param tile Tile coordinate
   * @param data Cached tile data (CachedTileData or Blob for legacy compatibility)
   * @param tier Which tier to cache in ('L1' for hot, 'L2' for prefetch)
   * @param validationContext Optional context for compliance validation
   */
  async set(
    tile: TileCoordinate,
    data: CachedTileData | Blob,
    tier: 'L1' | 'L2' = 'L2',
    validationContext?: { expectedScale?: number; currentZoom?: number; caller?: string }
  ): Promise<void> {
    const key = this.getTileKey(tile);

    // TILE COMPLIANCE CHECK (amnesia-e4i): Validate tile before caching
    // This catches scale mismatches at the source before they cause visual corruption
    if (validationContext && isFeatureEnabled('useTileComplianceValidation')) {
      const result = validateTileCompliance(
        tile,
        validationContext.expectedScale,
        validationContext.currentZoom ?? 1,
        validationContext.caller ?? 'TileCacheManager.set'
      );
      
      if (!result.isCompliant) {
        // Log but don't reject - we want to see what happens downstream
        console.warn(
          `[TILE-CACHE-SET-VIOLATION] Caching non-compliant tile:`,
          {
            key,
            tile: `p${tile.page} (${tile.tileX},${tile.tileY}) s${tile.scale}`,
            violations: result.violations,
            expectedScale: validationContext.expectedScale,
            zoom: validationContext.currentZoom?.toFixed(2),
          }
        );
      }
    }

    // Convert Blob to CachedTileData for legacy compatibility
    let cacheData: CachedTileData;
    let size: number;

    if (data instanceof Blob) {
      // Legacy Blob format
      cacheData = {
        format: 'png',
        blob: data,
        width: 0, // Unknown for legacy blobs
        height: 0,
      };
      size = data.size;
    } else {
      // New CachedTileData format
      cacheData = data;
      size = this.getCachedDataSize(data);
    }

    // Always store in L2 (larger capacity)
    this.l2Cache.set(key, cacheData, size);

    // If L1 requested, also store in hot cache
    if (tier === 'L1') {
      this.l1Cache.set(key, cacheData, size);
    }

    // amnesia-aqv Phase 2A: Update scale-tier index for fast fallback lookup
    this.indexTile(tile);

    // Reset consecutive misses since we just cached something
    this.consecutiveMisses = 0;
  }

  /**
   * Index a tile in the scale-tier index for O(1) fallback lookup.
   * @internal
   */
  private indexTile(tile: TileCoordinate): void {
    const page = tile.page;
    const scale = tile.scale;
    const tileSize = tile.tileSize ?? 256;

    let pageIndex = this.scaleTierIndex.get(page);
    if (!pageIndex) {
      pageIndex = new Map();
      this.scaleTierIndex.set(page, pageIndex);
    }

    let scaleSizes = pageIndex.get(scale);
    if (!scaleSizes) {
      scaleSizes = new Set();
      pageIndex.set(scale, scaleSizes);
    }

    scaleSizes.add(tileSize);
  }

  /**
   * Check if any tiles exist for a given page, scale, and tileSize.
   * Used for O(1) fallback search optimization.
   * @internal
   */
  private hasAnyTilesAtScale(page: number, scale: number, tileSize: number): boolean {
    const pageIndex = this.scaleTierIndex.get(page);
    if (!pageIndex) return false;

    const scaleSizes = pageIndex.get(scale);
    if (!scaleSizes) return false;

    return scaleSizes.has(tileSize);
  }

  /**
   * Get all scale tiers that have cached tiles for a page.
   * Returns scales in descending order (highest first) for zoom-out fallback.
   * @internal
   */
  private getPopulatedScaleTiers(page: number): number[] {
    const pageIndex = this.scaleTierIndex.get(page);
    if (!pageIndex) return [];

    return Array.from(pageIndex.keys()).sort((a, b) => b - a);
  }

  /**
   * Set a tile in cache with explicit format
   *
   * @param tile Tile coordinate
   * @param rgba Raw RGBA pixel data
   * @param width Tile width in pixels
   * @param height Tile height in pixels
   * @param tier Which tier to cache in
   */
  async setRgba(
    tile: TileCoordinate,
    rgba: Uint8Array,
    width: number,
    height: number,
    tier: 'L1' | 'L2' = 'L2'
  ): Promise<void> {
    const cacheData: CachedTileData = {
      format: 'rgba',
      rgba,
      width,
      height,
    };
    await this.set(tile, cacheData, tier);
  }

  /**
   * Set a tile in cache as PNG blob
   *
   * @param tile Tile coordinate
   * @param blob PNG blob data
   * @param width Tile width in pixels
   * @param height Tile height in pixels
   * @param tier Which tier to cache in
   */
  async setBlob(
    tile: TileCoordinate,
    blob: Blob,
    width: number,
    height: number,
    tier: 'L1' | 'L2' = 'L2'
  ): Promise<void> {
    const cacheData: CachedTileData = {
      format: 'png',
      blob,
      width,
      height,
    };
    await this.set(tile, cacheData, tier);
  }

  /**
   * Get low-res tile as fallback
   *
   * If high-res (scale=2) tile isn't available, try to get low-res (scale=1)
   */
  async getFallback(tile: TileCoordinate): Promise<ImageBitmap | null> {
    // If already requesting low-res, no fallback
    if (tile.scale === 1) {
      return null;
    }

    // Try low-res version
    const lowResTile: TileCoordinate = { ...tile, scale: 1 };
    return this.get(lowResTile);
  }

  // ============================================================
  // Full-Page Cache Support (Phase A+.3: Hybrid Rendering)
  // ============================================================

  /**
   * Get a full-page render from cache as ImageBitmap
   *
   * Full-page renders are used at low zoom (<1.5x) where tiling adds overhead.
   * The caller owns the returned ImageBitmap and should close() it after use.
   *
   * @param page Page number (1-indexed)
   * @param scale Render scale
   * @returns ImageBitmap or null if not cached
   */
  async getFullPage(page: number, scale: number): Promise<ImageBitmap | null> {
    const key = this.getFullPageKey(page, scale);
    const telemetry = getTelemetry();

    // Check L1 first
    const l1Result = this.l1Cache.get(key);
    if (l1Result) {
      telemetry.trackCacheAccess('L1', true);
      this.consecutiveMisses = 0; // Reset on full-page hit
      try {
        return await this.createBitmapFromCachedData(l1Result);
      } catch (error) {
        console.warn('[TileCacheManager] Failed to decode L1 full-page:', error);
        this.l1Cache.delete(key);
      }
    }
    telemetry.trackCacheAccess('L1', false);

    // Check L2
    const l2Result = this.l2Cache.get(key);
    if (l2Result) {
      telemetry.trackCacheAccess('L2', true);
      this.consecutiveMisses = 0; // Reset on full-page hit
      try {
        const bitmap = await this.createBitmapFromCachedData(l2Result);
        // Promote to L1
        const size = this.getCachedDataSize(l2Result);
        this.l1Cache.set(key, l2Result, size);
        return bitmap;
      } catch (error) {
        console.warn('[TileCacheManager] Failed to decode L2 full-page:', error);
        this.l2Cache.delete(key);
      }
    }
    telemetry.trackCacheAccess('L2', false);

    return null;
  }

  /**
   * Get raw cached full-page data (without creating ImageBitmap)
   *
   * @param page Page number (1-indexed)
   * @param scale Render scale
   * @param trackTelemetry Whether to track cache access in telemetry (default: true)
   * @returns Cached data or null
   */
  getFullPageCachedData(page: number, scale: number, trackTelemetry: boolean = true): CachedTileData | null {
    const key = this.getFullPageKey(page, scale);
    const telemetry = trackTelemetry ? getTelemetry() : null;

    const l1Result = this.l1Cache.get(key);
    if (l1Result) {
      telemetry?.trackCacheAccess('L1', true);
      this.consecutiveMisses = 0; // Reset on full-page hit
      return l1Result;
    }
    telemetry?.trackCacheAccess('L1', false);

    const l2Result = this.l2Cache.get(key);
    if (l2Result) {
      telemetry?.trackCacheAccess('L2', true);
      this.consecutiveMisses = 0; // Reset on full-page hit
      return l2Result;
    }
    telemetry?.trackCacheAccess('L2', false);

    return null;
  }

  /**
   * Check if a full-page render is cached
   *
   * @param page Page number (1-indexed)
   * @param scale Render scale
   * @returns true if cached
   */
  hasFullPage(page: number, scale: number): boolean {
    const key = this.getFullPageKey(page, scale);
    return this.l1Cache.has(key) || this.l2Cache.has(key);
  }

  /**
   * Set a full-page render in cache
   *
   * @param page Page number (1-indexed)
   * @param scale Render scale
   * @param data Cached tile data
   * @param tier Which tier to cache in
   */
  async setFullPage(
    page: number,
    scale: number,
    data: CachedTileData,
    tier: 'L1' | 'L2' = 'L2'
  ): Promise<void> {
    const key = this.getFullPageKey(page, scale);
    const size = this.getCachedDataSize(data);

    // Always store in L2
    this.l2Cache.set(key, data, size);

    // If L1 requested, also store in hot cache
    if (tier === 'L1') {
      this.l1Cache.set(key, data, size);
    }
  }

  /**
   * Get the best available full-page render, preferring higher scales.
   *
   * Similar to getBestAvailable for tiles, but for full-page renders.
   * Useful for smooth zoom transitions in hybrid mode.
   *
   * @param page Page number (1-indexed)
   * @param requestedScale Preferred render scale
   * @returns Cached data with actual scale and CSS stretch factor, or null
   *
   * @example
   * // Request scale 4, but only scale 2 is cached
   * const result = cache.getBestAvailableFullPage(1, 4);
   * // result = { data: CachedTileData, actualScale: 2, cssStretch: 2 }
   */
  getBestAvailableFullPage(
    page: number,
    requestedScale: number
  ): { data: CachedTileData; actualScale: number; cssStretch: number } | null {
    const telemetry = getTelemetry();

    // First, check if exact scale is available
    // Don't track telemetry internally since we track the overall result
    const exactData = this.getFullPageCachedData(page, requestedScale, false);
    if (exactData) {
      telemetry.trackCacheAccess('L2', true); // Track successful lookup
      return { data: exactData, actualScale: requestedScale, cssStretch: 1 };
    }

    // Check for HIGHER scales first (can be CSS-downscaled)
    for (let i = 0; i < SCALE_TIERS.length; i++) {
      const scaleTier = SCALE_TIERS[i];
      if (scaleTier <= requestedScale) continue;

      const higherData = this.getFullPageCachedData(page, scaleTier, false);
      if (higherData) {
        telemetry.trackCacheAccess('L2', true); // Track fallback hit
        const cssStretch = requestedScale / scaleTier;
        return { data: higherData, actualScale: scaleTier, cssStretch };
      }
    }

    // Then check for LOWER scales (can be CSS-upscaled)
    for (let i = SCALE_TIERS.length - 1; i >= 0; i--) {
      const scaleTier = SCALE_TIERS[i];
      if (scaleTier >= requestedScale) continue;

      const lowerData = this.getFullPageCachedData(page, scaleTier, false);
      if (lowerData) {
        telemetry.trackCacheAccess('L2', true); // Track fallback hit
        const cssStretch = requestedScale / scaleTier;
        return { data: lowerData, actualScale: scaleTier, cssStretch };
      }
    }

    telemetry.trackCacheAccess('L2', false); // Track overall miss
    return null;
  }

  /**
   * Get best available full-page as ImageBitmap.
   *
   * Convenience wrapper around getBestAvailableFullPage.
   * The caller owns the returned ImageBitmap and should close() it after use.
   *
   * @param page Page number (1-indexed)
   * @param requestedScale Preferred render scale
   * @returns ImageBitmap and metadata, or null if nothing cached
   */
  async getBestAvailableFullPageBitmap(
    page: number,
    requestedScale: number
  ): Promise<{ bitmap: ImageBitmap; actualScale: number; cssStretch: number } | null> {
    const result = this.getBestAvailableFullPage(page, requestedScale);
    if (!result) return null;

    try {
      const bitmap = await this.createBitmapFromCachedData(result.data);
      return { bitmap, actualScale: result.actualScale, cssStretch: result.cssStretch };
    } catch (error) {
      console.warn('[TileCacheManager] Failed to create bitmap from best available full-page:', error);
      return null;
    }
  }

  /**
   * Get all cached full-page scales for a page.
   *
   * @param page Page number (1-indexed)
   * @returns Array of cached scale tiers (sorted ascending)
   */
  getCachedFullPageScales(page: number): ScaleTier[] {
    const cachedScales: ScaleTier[] = [];

    for (const scale of SCALE_TIERS) {
      if (this.hasFullPage(page, scale)) {
        cachedScales.push(scale);
      }
    }

    return cachedScales;
  }

  /**
   * Evict all tile entries for a page, keeping full-page entries.
   *
   * Useful when switching from tiled to full-page mode.
   *
   * @param page Page number (1-indexed)
   * @returns Number of tiles evicted
   */
  evictTilesForPage(page: number): number {
    const keysToEvict: string[] = [];

    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (parsed && parsed.type === 'tile' && parsed.page === page) {
        keysToEvict.push(key);
      }
    }

    for (const key of keysToEvict) {
      this.l2Cache.delete(key);
      this.l1Cache.delete(key);
    }

    return keysToEvict.length;
  }

  /**
   * Evict all full-page entries for a page, keeping tile entries.
   *
   * Useful when switching from full-page to tiled mode.
   *
   * @param page Page number (1-indexed)
   * @returns Number of full-page entries evicted
   */
  evictFullPagesForPage(page: number): number {
    const keysToEvict: string[] = [];

    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (parsed && parsed.type === 'full-page' && parsed.page === page) {
        keysToEvict.push(key);
      }
    }

    for (const key of keysToEvict) {
      this.l2Cache.delete(key);
      this.l1Cache.delete(key);
    }

    return keysToEvict.length;
  }

  /**
   * Get cache statistics including full-page vs tile breakdown.
   */
  getCacheTypeStats(): {
    tiles: number;
    fullPages: number;
    tileBytes: number;
    fullPageBytes: number;
  } {
    let tiles = 0;
    let fullPages = 0;
    let tileBytes = 0;
    let fullPageBytes = 0;

    for (const [key, entry] of this.l2Cache.entries()) {
      const parsed = this.parseKey(key);
      if (parsed) {
        if (parsed.type === 'tile') {
          tiles++;
          tileBytes += entry.size;
        } else {
          fullPages++;
          fullPageBytes += entry.size;
        }
      }
    }

    return { tiles, fullPages, tileBytes, fullPageBytes };
  }

  // ============================================================
  // Multi-Scale Caching Support (Phase 2: Multi-Resolution Zoom)
  // ============================================================

  /**
   * Get the best available tile for coordinates, preferring higher scales.
   *
   * If the exact requested scale isn't available, returns the highest
   * cached scale that's still below the requested scale.
   *
   * CRITICAL FIX (amnesia-e4i): Tile coordinates are SCALE-DEPENDENT!
   * Tile (5,3) at scale 12 covers DIFFERENT PDF content than (5,3) at scale 8.
   * - At scale 12: tileSize = 256/12 ≈ 21.33 PDF units, so (5,3) covers (106.65, 64)
   * - At scale 8: tileSize = 256/8 = 32 PDF units, so (5,3) covers (160, 96)
   *
   * The old code returned tiles with same (tileX, tileY) but different scale,
   * which caused visual corruption during pan (content from wrong PDF position).
   *
   * FIX: Calculate PDF position first, then find which tile at fallback scale
   * covers that same PDF position.
   *
   * @param tile Tile coordinate with preferred scale
   * @param tileSize Optional tile size in CSS pixels (default 256)
   * @returns Tile data and actual scale, or null if nothing cached
   *
   * @example
   * // Request scale 32, but only scale 8 is cached
   * const result = await cache.getBestAvailable({ page: 1, tileX: 0, tileY: 0, scale: 32 });
   * // result = { data: CachedTileData, actualScale: 8, cssStretch: 4 }
   */
   async getBestAvailable(
    tile: TileCoordinate,
    tileSize: number = 256
  ): Promise<{
    data: CachedTileData;
    actualScale: number;
    cssStretch: number;
    /** amnesia-e4i: The actual tile coordinates used (for correct compositing) */
    fallbackTile?: TileCoordinate;
  } | null> {
    // First, check if exact scale is available
    const exactData = this.getCachedData(tile);
    if (exactData) {
      // Exact match - no fallback needed, use original tile coords
      return { data: exactData, actualScale: tile.scale, cssStretch: 1 };
    }

    // amnesia-e4i FIX: Use tile.tileSize if available (from TileCoordinate),
    // otherwise fall back to the parameter. This ensures PDF position
    // calculation matches the tile grid that generated the indices.
    const effectiveTileSize = tile.tileSize ?? tileSize;

    // Calculate the PDF position this tile covers
    // PDF position = tileIndex * (tileSize / scale)
    const pdfTileSize = effectiveTileSize / tile.scale;
    const pdfX = tile.tileX * pdfTileSize;
    const pdfY = tile.tileY * pdfTileSize;

    // amnesia-e4i CRITICAL FIX: Fallback tiles may have been rendered with DIFFERENT
    // tileSizes than the current request. When looking up fallbacks, we must try ALL
    // possible tileSizes (128, 256, 512) since we don't know what zoom level was active
    // when the fallback tile was rendered.
    //
    // Example: Current tile at scale 32 with tileSize 256 covers PDF (72, 160).
    // We look for fallback at scale 16, but that tile was rendered at zoom 16 with
    // tileSize 512. The cache key is different:
    // - Looking for: p1-t4x10-s16-ts256 (wrong - doesn't exist)
    // - Actual:      p1-t2x5-s16-ts512  (correct - this is what was cached)
    //
    // FIX: Try all possible tileSizes for each scale tier.
    const POSSIBLE_TILE_SIZES = [512, 256, 128]; // Prefer larger tiles (better quality)

    // Helper: find cached tile at given scale+tileSize that covers the same PDF position
    // amnesia-aqv Phase 2A: Uses scale-tier index for O(1) skip of empty tiers
    const findCachedTileForPdfPosition = (
      scaleTier: number
    ): { tile: TileCoordinate; data: CachedTileData } | null => {
      // Try each possible tileSize the fallback might have been rendered with
      for (const fallbackTileSize of POSSIBLE_TILE_SIZES) {
        // O(1) check: Skip this tileSize if no tiles exist at this scale
        if (!this.hasAnyTilesAtScale(tile.page, scaleTier, fallbackTileSize)) {
          continue;
        }
        
        const fallbackPdfTileSize = fallbackTileSize / scaleTier;
        const fallbackTileX = Math.floor(pdfX / fallbackPdfTileSize);
        const fallbackTileY = Math.floor(pdfY / fallbackPdfTileSize);
        
        // Create lookup with the fallback's ACTUAL tileSize (for correct cache key)
        const fallbackTile: TileCoordinate = {
          page: tile.page,
          tileX: fallbackTileX,
          tileY: fallbackTileY,
          scale: scaleTier,
          tileSize: fallbackTileSize, // Use fallback's tileSize, not original!
        };
        
        const fallbackData = this.getCachedData(fallbackTile);
        if (fallbackData) {
          return { tile: fallbackTile, data: fallbackData };
        }
      }
      return null;
    };

    // ZOOM-OUT FIX: Check for HIGHER scales first (can be CSS-downscaled)
    // Downscaling high-res content looks better than upscaling low-res content
    // This prevents blank pages when zooming out from high zoom levels
    for (let i = 0; i < SCALE_TIERS.length; i++) {
      const scaleTier = SCALE_TIERS[i];
      if (scaleTier <= tile.scale) continue; // Skip scales at or below requested

      // COORDINATE FIX (amnesia-e4i): Find the tile at this scale that covers the SAME PDF position
      const found = findCachedTileForPdfPosition(scaleTier);
      if (found) {
        // cssStretch < 1 means downscale (e.g., have scale 16, need 8 → stretch 0.5)
        const cssStretch = tile.scale / scaleTier;
        // amnesia-e4i: Include fallbackTile so compositing can position correctly
        return { data: found.data, actualScale: scaleTier, cssStretch, fallbackTile: found.tile };
      }
    }

    // Then check for LOWER scales (can be CSS-upscaled for zoom-in)
    for (let i = SCALE_TIERS.length - 1; i >= 0; i--) {
      const scaleTier = SCALE_TIERS[i];
      if (scaleTier >= tile.scale) continue; // Skip scales at or above requested

      // COORDINATE FIX (amnesia-e4i): Find the tile at this scale that covers the SAME PDF position
      const found = findCachedTileForPdfPosition(scaleTier);
      if (found) {
        // cssStretch > 1 means upscale (e.g., have scale 4, need 8 → stretch 2)
        const cssStretch = tile.scale / scaleTier;
        // amnesia-e4i: Include fallbackTile so compositing can position correctly
        return { data: found.data, actualScale: scaleTier, cssStretch, fallbackTile: found.tile };
      }
    }

    return null;
  }

  /**
   * Get best available tile as ImageBitmap.
   *
   * Convenience wrapper around getBestAvailable that returns ImageBitmap.
   * The caller owns the returned ImageBitmap and should close() it after use.
   *
   * amnesia-e4i ENHANCEMENT: If no tile is cached at any scale, try to extract
   * the tile region from a cached full-page image. This guarantees a fallback
   * exists when tiles are dropped from the render queue due to overflow.
   *
   * @param tile Tile coordinate with preferred scale
   * @param tileSize Optional tile size in pixels (default 256)
   * @returns ImageBitmap and metadata, or null if nothing cached
   */
   async getBestAvailableBitmap(
    tile: TileCoordinate,
    tileSize: number = 256
  ): Promise<{
    bitmap: ImageBitmap;
    actualScale: number;
    cssStretch: number;
    /** amnesia-e4i: The actual tile coordinates for the fallback (for correct compositing) */
    fallbackTile?: TileCoordinate;
  } | null> {
    // amnesia-e4i FIX: Use tile.tileSize if available for correct PDF position calculation
    const effectiveTileSize = tile.tileSize ?? tileSize;
    
    // First, try to find a cached tile at any scale
    const result = await this.getBestAvailable(tile, effectiveTileSize);
    if (result) {
      try {
        const bitmap = await this.createBitmapFromCachedData(result.data);
        
        // 2026-01-24 FIX: Validate bitmap dimensions are reasonable for a tile.
        // A tile bitmap should be at most (tileSize * devicePixelRatio * 2) per dimension.
        // If larger, it's likely a corrupted cache entry (full-page stored under tile key).
        // The 2× factor allows for high-DPI tiles + some margin.
        const MAX_TILE_DIMENSION = effectiveTileSize * 4 * 2; // e.g., 256 * 4 * 2 = 2048
        const isBitmapOversized = bitmap.width > MAX_TILE_DIMENSION || bitmap.height > MAX_TILE_DIMENSION;
        
        if (isBitmapOversized) {
          console.warn(`[TileCacheManager] REJECTING oversized fallback bitmap: ` +
            `page=${tile.page} tile=(${tile.tileX},${tile.tileY}) scale=${tile.scale}, ` +
            `bitmap=${bitmap.width}x${bitmap.height} exceeds max ${MAX_TILE_DIMENSION}. ` +
            `Likely corrupted cache entry (full-page stored as tile).`);
          bitmap.close();
          // Fall through to full-page extraction which will properly slice the region
        } else {
          // amnesia-e4i FIX: Include fallbackTile when tile coordinates differ
          const fallbackTile = result.fallbackTile;
          return { bitmap, actualScale: result.actualScale, cssStretch: result.cssStretch, fallbackTile };
        }
      } catch (error) {
        console.warn('[TileCacheManager] Failed to create bitmap from best available:', error);
        // Fall through to full-page fallback
      }
    }

    // amnesia-e4i: If no tile cached, try to extract from full-page cache
    // This is the "guaranteed fallback" for queue overflow scenarios
    const fullPageResult = await this.extractTileFromFullPageCache(tile, effectiveTileSize);
    if (fullPageResult) {
      console.log(`[TileCacheManager] Using full-page fallback for tile page=${tile.page} ` +
        `(${tile.tileX},${tile.tileY}) at scale ${tile.scale}, actual=${fullPageResult.actualScale}`);
      return fullPageResult;
    }

    return null;
  }

  /**
   * Extract a tile region from a cached full-page image (amnesia-e4i).
   *
   * When tile cache misses but full-page cache has content, we can slice
   * the relevant region from the full-page image. This provides a guaranteed
   * fallback when high-res tile requests are dropped from the queue.
   *
   * @param tile Tile coordinate to extract
   * @param tileSize Tile size in pixels (default 256)
   * @returns Extracted tile bitmap and metadata, or null if no full-page cached
   */
  private async extractTileFromFullPageCache(
    tile: TileCoordinate,
    tileSize: number = 256
  ): Promise<{ bitmap: ImageBitmap; actualScale: number; cssStretch: number } | null> {
    // Find best available full-page image (any scale)
    const fullPageResult = this.getBestAvailableFullPage(tile.page, tile.scale);
    if (!fullPageResult) return null;

    try {
      // Create bitmap from full-page cache
      const fullPageBitmap = await this.createBitmapFromCachedData(fullPageResult.data);
      
      // Calculate tile position in full-page coordinate space
      // The full-page is at actualScale, tile coordinates are at tile.scale
      const scaleRatio = tile.scale / fullPageResult.actualScale;
      
      // Tile coordinates in the full-page bitmap
      // Use the cached data dimensions to ensure correct slicing
      const srcX = (tile.tileX * tileSize) / scaleRatio;
      const srcY = (tile.tileY * tileSize) / scaleRatio;
      const srcW = Math.min(tileSize / scaleRatio, fullPageBitmap.width - srcX);
      const srcH = Math.min(tileSize / scaleRatio, fullPageBitmap.height - srcY);

      // Skip if tile is completely outside the full-page bounds
      if (srcX >= fullPageBitmap.width || srcY >= fullPageBitmap.height || srcW <= 0 || srcH <= 0) {
        fullPageBitmap.close();
        return null;
      }

      // Create offscreen canvas for the tile
      const offscreen = new OffscreenCanvas(tileSize, tileSize);
      const ctx = offscreen.getContext('2d');
      if (!ctx) {
        fullPageBitmap.close();
        return null;
      }

      // Clear to white (in case tile extends beyond page bounds)
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, tileSize, tileSize);

      // Calculate destination dimensions (may be smaller than tileSize for edge tiles)
      const dstW = srcW * scaleRatio;
      const dstH = srcH * scaleRatio;

      // Draw the tile region from the full-page bitmap
      ctx.drawImage(
        fullPageBitmap,
        srcX, srcY, srcW, srcH,  // Source region
        0, 0, dstW, dstH  // Destination (scaled to fit)
      );

      // Clean up full-page bitmap
      fullPageBitmap.close();

      // Create tile bitmap from offscreen canvas
      const tileBitmap = await createImageBitmap(offscreen);

      // Calculate CSS stretch factor
      // If full-page was at scale 2 and tile needs scale 16, cssStretch = 8
      const cssStretch = tile.scale / fullPageResult.actualScale;

      return {
        bitmap: tileBitmap,
        actualScale: fullPageResult.actualScale,
        cssStretch,
      };
    } catch (error) {
      console.warn('[TileCacheManager] Failed to extract tile from full-page cache:', error);
      return null;
    }
  }

  /**
   * Get all cached scale tiers for a tile coordinate.
   *
   * Used for determining what intermediate renders are needed
   * during progressive zoom.
   *
   * @param page Page number
   * @param tileX Tile X coordinate
   * @param tileY Tile Y coordinate
   * @returns Array of cached scale tiers (sorted ascending)
   */
  getCachedScales(page: number, tileX: number, tileY: number): ScaleTier[] {
    const cachedScales: ScaleTier[] = [];

    for (const scale of SCALE_TIERS) {
      const tile: TileCoordinate = { page, tileX, tileY, scale };
      if (this.has(tile)) {
        cachedScales.push(scale);
      }
    }

    return cachedScales;
  }

  /**
   * Get highest cached scale for a tile coordinate.
   *
   * @param page Page number
   * @param tileX Tile X coordinate
   * @param tileY Tile Y coordinate
   * @returns Highest cached scale, or 0 if nothing cached
   */
  getHighestCachedScale(page: number, tileX: number, tileY: number): number {
    for (let i = SCALE_TIERS.length - 1; i >= 0; i--) {
      const scale = SCALE_TIERS[i];
      const tile: TileCoordinate = { page, tileX, tileY, scale };
      if (this.has(tile)) {
        return scale;
      }
    }
    return 0;
  }

  /**
   * Evict entries below a scale threshold for a specific page.
   *
   * Called when memory pressure is high to free up space
   * by removing lower-quality entries that have higher-quality versions.
   *
   * Handles both tile and full-page cache entries.
   *
   * @param page Page number (or null for all pages)
   * @param minScale Minimum scale to keep (entries below this are evicted)
   * @param entryType Optional filter by entry type ('tile' | 'full-page' | undefined for both)
   * @returns Number of entries evicted
   */
  evictBelowScale(page: number | null, minScale: number, entryType?: CacheEntryType): number {
    let evictedCount = 0;

    // Collect keys to evict
    const keysToEvict: string[] = [];

    // Check L2 cache (larger, more impact)
    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;

      // Filter by entry type if specified
      if (entryType && parsed.type !== entryType) continue;

      // Skip if wrong page (when page filter is specified)
      if (page !== null && parsed.page !== page) continue;

      // Evict if below minimum scale
      if (parsed.scale < minScale) {
        keysToEvict.push(key);
      }
    }

    // Perform eviction
    for (const key of keysToEvict) {
      this.l2Cache.delete(key);
      this.l1Cache.delete(key); // Also remove from L1 if present
      evictedCount++;
    }

    if (evictedCount > 0) {
      const typeStr = entryType ? ` ${entryType}` : '';
      console.log(
        `[TileCacheManager] Evicted ${evictedCount}${typeStr} entries below scale ${minScale}` +
          (page !== null ? ` for page ${page}` : '')
      );
    }

    return evictedCount;
  }

  /**
   * Evict tiles above a maximum scale (for zoom-out memory optimization).
   *
   * When zooming from 8x to 2x, high-scale tiles become wasteful.
   * This method evicts tiles that are much higher than needed,
   * freeing memory for new renders at the current zoom level.
   *
   * Uses a 1.5x margin to prevent thrashing near scale boundaries.
   *
   * @param maxScale Maximum scale to keep (entries above threshold are evicted)
   * @param page Page number (or null for all pages)
   * @returns Number of entries evicted
   */
  evictScalesAbove(maxScale: number, page: number | null = null): number {
    // FALLBACK PRESERVATION FIX: More lenient threshold to preserve fallback tiles.
    // - Normal: Keep tiles up to 2x current scale as potential fallbacks
    // - Under memory pressure (>80% full): Tighten to 1.5x to make room
    // This allows zooming out to use higher-res tiles as fallbacks before fresh render.
    const cacheUtilization = this.l2Cache.size / this.l2MaxSize;
    const underMemoryPressure = cacheUtilization > 0.8;
    const threshold = underMemoryPressure ? maxScale * 1.5 : maxScale * 2;

    let evictedCount = 0;

    // Collect keys to evict from L2 (larger, more impact)
    const keysToEvict: string[] = [];

    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;

      // Skip if wrong page (when page filter is specified)
      if (page !== null && parsed.page !== page) continue;

      // Evict if above threshold
      if (parsed.scale > threshold) {
        keysToEvict.push(key);
      }
    }

    // Perform eviction
    for (const key of keysToEvict) {
      this.l2Cache.delete(key);
      this.l1Cache.delete(key); // Also remove from L1 if present
      evictedCount++;
    }

    if (evictedCount > 0) {
      console.log(
        `[TileCacheManager] Evicted ${evictedCount} entries with scale > ${threshold.toFixed(1)}` +
          (page !== null ? ` for page ${page}` : '') +
          ` (L2 util: ${(cacheUtilization * 100).toFixed(0)}%)`
      );
    }

    return evictedCount;
  }

  /**
   * Evict all scales except the highest for each coordinate.
   *
   * Aggressive memory optimization: keeps only the best quality
   * version of each entry, removing intermediate scales.
   *
   * Handles both tile and full-page cache entries.
   *
   * @returns Number of entries evicted
   */
  evictIntermediateScales(): number {
    // Build a map of coordinates to their scales
    // For tiles: baseKey = docId-p{page}-t{tileX}x{tileY}
    // For full-page: baseKey = docId-p{page}-full
    const coordScales = new Map<string, { scales: number[]; keys: string[] }>();

    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;

      // Create base key without scale
      let baseKey: string;
      if (parsed.type === 'tile') {
        baseKey = key.replace(/-s\d+$/, ''); // Remove scale suffix
      } else {
        baseKey = key.replace(/-s\d+$/, ''); // Same for full-page
      }

      if (!coordScales.has(baseKey)) {
        coordScales.set(baseKey, { scales: [], keys: [] });
      }
      const entry = coordScales.get(baseKey)!;
      entry.scales.push(parsed.scale);
      entry.keys.push(key);
    }

    // Evict all but highest scale for each coordinate
    let evictedCount = 0;

    for (const [, entry] of coordScales) {
      if (entry.scales.length <= 1) continue;

      // Find highest scale
      const maxScale = Math.max(...entry.scales);

      // Evict others
      for (let i = 0; i < entry.scales.length; i++) {
        if (entry.scales[i] !== maxScale) {
          this.l2Cache.delete(entry.keys[i]);
          this.l1Cache.delete(entry.keys[i]);
          evictedCount++;
        }
      }
    }

    if (evictedCount > 0) {
      console.log(`[TileCacheManager] Evicted ${evictedCount} intermediate scale entries`);
    }

    return evictedCount;
  }

  /**
   * Get multi-scale cache statistics.
   *
   * @returns Statistics about scale distribution in cache (includes both tiles and full-pages)
   */
  getMultiScaleStats(): {
    scaleDistribution: Record<number, number>;
    totalEntries: number;
    avgScale: number;
    /** @deprecated Use totalEntries instead */
    totalTiles: number;
  } {
    const scaleDistribution: Record<number, number> = {};
    let totalEntries = 0;
    let scaleSum = 0;

    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (parsed) {
        scaleDistribution[parsed.scale] = (scaleDistribution[parsed.scale] || 0) + 1;
        totalEntries++;
        scaleSum += parsed.scale;
      }
    }

    return {
      scaleDistribution,
      totalEntries,
      totalTiles: totalEntries, // Backward compatibility
      avgScale: totalEntries > 0 ? scaleSum / totalEntries : 0,
    };
  }

  /**
   * Get page metadata from L3 cache
   */
  getPageMetadata(page: number): PageMetadata | undefined {
    const result = this.l3Cache.get(page);
    if (result) {
      getTelemetry().trackCacheAccess('L3', true);
    } else {
      getTelemetry().trackCacheAccess('L3', false);
    }
    return result;
  }

  /**
   * Set page metadata in L3 cache
   */
  setPageMetadata(page: number, metadata: PageMetadata): void {
    this.l3Cache.set(page, metadata);
  }

  // ============================================================
  // Classification Caching (Phase 5: Content-Type Detection)
  // ============================================================

  /**
   * Get cached page classification from L3 cache.
   *
   * Returns the cached classification if available and not stale.
   * Classifications are considered stale after 24 hours (document may have changed).
   *
   * @param page Page number (1-indexed)
   * @param maxAgeMs Maximum age in milliseconds (default: 24 hours)
   * @returns Cached classification or null if not available/stale
   */
  getPageClassification(page: number, maxAgeMs: number = 24 * 60 * 60 * 1000): CachedPageClassification | null {
    const metadata = this.l3Cache.get(page);
    if (!metadata?.classification) {
      getTelemetry().trackCacheAccess('L3', false);
      return null;
    }

    // Check if classification is stale
    const age = Date.now() - metadata.classification.timestamp;
    if (age > maxAgeMs) {
      getTelemetry().trackCacheAccess('L3', false);
      return null;
    }

    getTelemetry().trackCacheAccess('L3', true);
    return metadata.classification;
  }

  /**
   * Set page classification in L3 cache.
   *
   * Classifications are stored as part of page metadata for efficient access.
   * If page metadata doesn't exist, creates a minimal entry.
   *
   * @param page Page number (1-indexed)
   * @param classification Classification data to cache
   */
  setPageClassification(page: number, classification: Omit<CachedPageClassification, 'timestamp'>): void {
    const existing = this.l3Cache.get(page);
    const classificationWithTimestamp: CachedPageClassification = {
      ...classification,
      timestamp: Date.now(),
    };

    if (existing) {
      // Update existing metadata with classification
      existing.classification = classificationWithTimestamp;
    } else {
      // Create minimal metadata entry for classification
      this.l3Cache.set(page, {
        page,
        width: 0, // Will be set when page dimensions are requested
        height: 0,
        hasTextLayer: false,
        classification: classificationWithTimestamp,
      });
    }
  }

  /**
   * Get all cached classifications for the current document.
   *
   * Returns a map of page numbers to classification types.
   * Useful for understanding document composition and optimizing prefetch.
   *
   * @returns Map of page number to content type string
   */
  getAllClassifications(): Map<number, string> {
    const classifications = new Map<number, string>();

    for (const [page, metadata] of this.l3Cache) {
      if (metadata.classification) {
        classifications.set(page, metadata.classification.type);
      }
    }

    return classifications;
  }

  /**
   * Get classification statistics for the document.
   *
   * Returns breakdown of content types for understanding document composition.
   * Useful for telemetry and optimization decisions.
   */
  getClassificationStats(): {
    totalClassified: number;
    byType: Record<string, number>;
    avgConfidence: number;
    avgClassificationTimeMs: number;
  } {
    const byType: Record<string, number> = {};
    let totalConfidence = 0;
    let totalTime = 0;
    let count = 0;

    for (const [, metadata] of this.l3Cache) {
      if (metadata.classification) {
        const type = metadata.classification.type;
        byType[type] = (byType[type] || 0) + 1;
        totalConfidence += metadata.classification.confidence;
        totalTime += metadata.classification.classificationTimeMs;
        count++;
      }
    }

    return {
      totalClassified: count,
      byType,
      avgConfidence: count > 0 ? totalConfidence / count : 0,
      avgClassificationTimeMs: count > 0 ? totalTime / count : 0,
    };
  }

  /**
   * Check if page classification is cached.
   *
   * @param page Page number (1-indexed)
   * @returns true if classification is cached (may be stale)
   */
  hasClassification(page: number): boolean {
    const metadata = this.l3Cache.get(page);
    return !!metadata?.classification;
  }

  /**
   * Clear all classifications (but keep other metadata).
   *
   * Called when document is reloaded or classification algorithm changes.
   */
  clearClassifications(): void {
    for (const [, metadata] of this.l3Cache) {
      delete metadata.classification;
    }
  }

  // ============================================================================
  // JPEG TILE SLICING (amnesia-xlc.3)
  // ============================================================================

  /**
   * Set the JPEG extraction callback.
   * Called by RenderCoordinator to provide the extraction function.
   *
   * @param callback Function to extract JPEG from a page
   */
  setExtractJpegCallback(callback: ((docId: string, pageNum: number) => Promise<{
    data: Uint8Array;
    width: number;
    height: number;
  }>) | null): void {
    this.extractJpegCallback = callback;
  }

  /**
   * Set the JPEG cache memory budget based on device capabilities.
   *
   * Called during initialization with device profile information.
   * Uses ~1% of system RAM for the JPEG cache:
   * - 8GB system → 80MB JPEG cache
   * - 16GB system → 160MB JPEG cache
   * - 32GB system → 320MB JPEG cache
   *
   * @param memoryGB System RAM in gigabytes
   */
  setJpegCacheMemoryBudget(memoryGB: number): void {
    // Budget: ~1% of system RAM, with min 50MB and max 500MB
    const budgetMB = Math.max(50, Math.min(500, memoryGB * 10));
    this.jpegCacheMaxBytes = budgetMB * 1024 * 1024;
    console.log(`[TileCacheManager] JPEG cache budget set to ${budgetMB}MB (${memoryGB}GB system RAM)`);
  }

  /**
   * Get the cache key for a JPEG page.
   */
  private getJpegCacheKey(pageNum: number): string {
    return `${this.documentId}-${pageNum}`;
  }

  /**
   * Get or load decoded JPEG for a page.
   *
   * If the page JPEG is already cached, returns it immediately.
   * Otherwise, extracts and decodes the JPEG, caches it, then returns.
   *
   * @param pageNum Page number (1-indexed)
   * @returns Decoded ImageData or null if extraction fails/not available
   */
  async getOrLoadJpegPage(pageNum: number): Promise<{
    imageData: ImageData;
    width: number;
    height: number;
  } | null> {
    if (!this.documentId || !this.extractJpegCallback) {
      return null;
    }

    const key = this.getJpegCacheKey(pageNum);

    // Check cache first
    const cached = this.jpegCache.get(key);
    if (cached) {
      cached.lastAccess = Date.now();
      return {
        imageData: cached.imageData,
        width: cached.width,
        height: cached.height,
      };
    }

    // Extract and decode JPEG
    try {
      const jpegData = await this.extractJpegCallback(this.documentId, pageNum);

      // Decode JPEG to ImageData using createImageBitmap
      // Copy data to ensure regular ArrayBuffer (not SharedArrayBuffer) for Blob
      const jpegCopy = new Uint8Array(jpegData.data);
      const blob = new Blob([jpegCopy], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);

      // Draw to canvas to get ImageData
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close();
        return null;
      }

      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const sizeBytes = imageData.data.byteLength;

      // Evict old entries if needed to make room
      this.evictJpegCacheIfNeeded(sizeBytes);

      // Cache the decoded image
      this.jpegCache.set(key, {
        imageData,
        width: canvas.width,
        height: canvas.height,
        pageNum,
        lastAccess: Date.now(),
        sizeBytes,
      });
      this.jpegCacheBytes += sizeBytes;

      getTelemetry().trackCustomMetric('jpegCache_load', 1);
      getTelemetry().trackCustomMetric('jpegCache_bytes', this.jpegCacheBytes);

      return { imageData, width: canvas.width, height: canvas.height };
    } catch (error) {
      console.warn(`[TileCacheManager] Failed to load JPEG for page ${pageNum}:`, error);
      getTelemetry().trackCustomMetric('jpegCache_loadError', 1);
      return null;
    }
  }

  /**
   * Evict JPEG cache entries using LRU until we have room for newBytes.
   */
  private evictJpegCacheIfNeeded(newBytes: number): void {
    // Check if we need to evict
    if (this.jpegCacheBytes + newBytes <= this.jpegCacheMaxBytes) {
      return;
    }

    // Sort entries by lastAccess (oldest first)
    const entries = Array.from(this.jpegCache.entries())
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    // Evict oldest entries until we have room
    let evicted = 0;
    for (const [key, entry] of entries) {
      if (this.jpegCacheBytes + newBytes <= this.jpegCacheMaxBytes) {
        break;
      }
      this.jpegCache.delete(key);
      this.jpegCacheBytes -= entry.sizeBytes;
      evicted++;
    }

    if (evicted > 0) {
      console.log(`[TileCacheManager] Evicted ${evicted} JPEG pages, cache now ${(this.jpegCacheBytes / 1024 / 1024).toFixed(1)}MB`);
      getTelemetry().trackCustomMetric('jpegCache_evictions', evicted);
    }
  }

  /**
   * Get a tile by slicing from cached JPEG page.
   *
   * This is the fast path for scanned PDFs at high zoom:
   * 1. Get/load the decoded JPEG page from cache
   * 2. Calculate source region for the requested tile
   * 3. Slice the region and return as CachedTileData
   *
   * @param tile Tile coordinate to render
   * @param tileSize Tile size in CSS pixels (default 256)
   * @returns CachedTileData or null if JPEG not available
   */
  async getJpegTile(
    tile: TileCoordinate,
    tileSize: number = 256
  ): Promise<CachedTileData | null> {
    // Load or get cached JPEG page
    const jpegPage = await this.getOrLoadJpegPage(tile.page);
    if (!jpegPage) {
      return null;
    }

    const { imageData, width: jpegWidth, height: jpegHeight } = jpegPage;

    // Calculate source region in JPEG coordinate space
    // The JPEG is at native resolution, tiles are at tile.scale
    // We need to find what region of the JPEG corresponds to this tile
    //
    // tile.scale = devicePixelRatio * zoom
    // A tile at (tileX, tileY) with tileSize 256 at scale 8 covers:
    // - PDF coordinates: (tileX * 256/8, tileY * 256/8) with size (256/8 × 256/8) = (32 × 32) PDF units
    //
    // The JPEG has dimensions (jpegWidth × jpegHeight) which map to the full PDF page.
    // We need to know the PDF page dimensions to calculate the mapping.
    //
    // For scanned PDFs, the JPEG typically IS the page content, so:
    // jpegWidth ≈ pdfWidth * (JPEG_DPI / 72)
    // jpegHeight ≈ pdfHeight * (JPEG_DPI / 72)
    //
    // Simplified: assume JPEG covers full page at its native resolution.
    // The ratio jpegWidth / pdfWidth gives us the effective "JPEG scale".

    // Calculate JPEG scale (pixels per PDF unit)
    // For scanned PDFs, we need to know the effective scale of the JPEG relative to the tile grid.
    //
    // If we have page metadata (PDF dimensions), we can compute the exact mapping:
    //   jpegScale = jpegWidth / pdfWidth
    //
    // If we don't have metadata, we can still compute a reasonable mapping:
    //   For a tile at scale S, the tile grid assumes the page is (jpegWidth / S) × (jpegHeight / S) in size.
    //   So the JPEG-to-tile mapping is simply S (the tile scale).
    //
    // This works because at render time, tiles expect pixels at tile.scale resolution.
    // The JPEG is at a fixed resolution (e.g., 300 DPI for 8.5x11 page = 2550x3300 pixels).
    // At scale 8, the tile grid divides the page into 256/8 = 32 pixel chunks (in PDF space).
    
    const metadata = this.l3Cache.get(tile.page);
    const effectiveTileSize = tile.tileSize ?? tileSize;
    
    let jpegScale: number;
    if (metadata && metadata.width > 0 && metadata.height > 0) {
      // Have metadata: compute exact scale
      jpegScale = jpegWidth / metadata.width;
    } else {
      // No metadata: estimate based on JPEG dimensions and tile scale
      // Assume typical 8.5x11 page at 72 DPI = 612x792 PDF units
      // For scanned PDFs at 300 DPI, JPEG is ~2550x3300 pixels
      // jpegScale ≈ 2550/612 ≈ 4.2 (close to 300/72)
      // 
      // However, we want to match the tile coordinate system which is based on tile.scale.
      // The tile grid at scale S has tiles of size (effectiveTileSize/S) in PDF units.
      // The JPEG covers the entire page, so:
      //   jpegScale = jpegWidth / (page_width_in_pdf_units)
      //
      // Without metadata, estimate PDF width as: jpegWidth / (typical_dpi_ratio)
      // Typical scanned PDF ratio: 300 DPI / 72 DPI ≈ 4.17
      const estimatedDpiRatio = 4.0; // Conservative estimate
      jpegScale = estimatedDpiRatio;
    }

    // Calculate tile's PDF position and size
    const pdfTileSize = effectiveTileSize / tile.scale; // Size in PDF units
    const pdfX = tile.tileX * pdfTileSize;
    const pdfY = tile.tileY * pdfTileSize;

    // Map to JPEG coordinates
    const srcX = Math.floor(pdfX * jpegScale);
    const srcY = Math.floor(pdfY * jpegScale);
    const srcW = Math.ceil(pdfTileSize * jpegScale);
    const srcH = Math.ceil(pdfTileSize * jpegScale);

    // Check bounds
    if (srcX >= jpegWidth || srcY >= jpegHeight) {
      // Tile is outside JPEG bounds (shouldn't happen for valid tiles)
      return null;
    }

    // Clamp to JPEG bounds
    const clampedW = Math.min(srcW, jpegWidth - srcX);
    const clampedH = Math.min(srcH, jpegHeight - srcY);

    if (clampedW <= 0 || clampedH <= 0) {
      return null;
    }

    // Calculate output tile dimensions
    // If tile is at edge, it may be smaller than tileSize
    const outputW = Math.ceil(effectiveTileSize * (clampedW / srcW));
    const outputH = Math.ceil(effectiveTileSize * (clampedH / srcH));

    // Extract the tile region
    // Create output canvas at tile output size
    const canvas = new OffscreenCanvas(outputW, outputH);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }

    // We need to draw from ImageData, which requires creating an ImageBitmap first
    // This is a bit inefficient but necessary because we can't draw ImageData directly
    const tempCanvas = new OffscreenCanvas(imageData.width, imageData.height);
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) {
      return null;
    }
    tempCtx.putImageData(imageData, 0, 0);

    // Draw the source region scaled to output size
    ctx.drawImage(
      tempCanvas,
      srcX, srcY, clampedW, clampedH, // Source region
      0, 0, outputW, outputH // Destination (scaled)
    );

    // Get output pixel data
    const outputImageData = ctx.getImageData(0, 0, outputW, outputH);
    const rgba = new Uint8Array(outputImageData.data.buffer);

    getTelemetry().trackCustomMetric('jpegTile_slice', 1);

    return {
      format: 'rgba',
      rgba,
      width: outputW,
      height: outputH,
    };
  }

  /**
   * Check if JPEG slicing is available for a page.
   *
   * Returns true if:
   * 1. extractJpegCallback is set
   * 2. Page is classified as SCANNED_JPEG
   *
   * Note: Page metadata is no longer required. For scanned PDFs, we can
   * compute the mapping from JPEG dimensions and tile scale directly.
   *
   * @param pageNum Page number (1-indexed)
   * @returns true if JPEG slicing can be used
   */
  canUseJpegSlicing(pageNum: number): boolean {
    if (!this.extractJpegCallback) {
      return false;
    }

    // Check classification
    // Note: PDFContentType.SCANNED_JPEG = 'scanned-jpeg' (lowercase)
    const classification = this.getPageClassification(pageNum);
    if (!classification || classification.type !== 'scanned-jpeg') {
      return false;
    }

    return true;
  }

  /**
   * Get JPEG cache statistics.
   */
  getJpegCacheStats(): {
    entries: number;
    bytes: number;
    maxBytes: number;
    utilizationPercent: number;
  } {
    return {
      entries: this.jpegCache.size,
      bytes: this.jpegCacheBytes,
      maxBytes: this.jpegCacheMaxBytes,
      utilizationPercent: (this.jpegCacheBytes / this.jpegCacheMaxBytes) * 100,
    };
  }

  /**
   * Clear the JPEG cache.
   * Called on document close or when memory pressure is critical.
   */
  clearJpegCache(): void {
    this.jpegCache.clear();
    this.jpegCacheBytes = 0;
    console.log('[TileCacheManager] JPEG cache cleared');
  }

  /**
   * Called on mode transition (paginated ↔ scroll ↔ grid)
   *
   * User decision: Only evict L1, keep L2/L3
   * This allows tiles rendered in one mode to be reused in another
   */
  onModeTransition(): void {
    // Clear L1 only (hot tiles)
    // Since we store Blobs, no need to close anything
    this.l1Cache.clear();

    // L2 and L3 preserved for cross-mode sharing
  }

  /**
   * Mode-aware cache transition with selective preservation.
   *
   * Unlike onModeTransition() which only clears L1, this method
   * provides granular control over what to preserve based on
   * source and target modes.
   *
   * Preservation rules:
   * - scroll → grid: Keep L2 tiles (useful for zoom in grid)
   * - grid → scroll: Keep L2 tiles + thumbnails
   * - paginated → scroll: Keep L2 tiles
   * - * → paginated: Keep current page tiles only
   *
   * @param fromMode Source render mode
   * @param toMode Target render mode
   * @param currentPage Current page for selective preservation
   */
  onModeTransitionAware(
    fromMode: 'paginated' | 'scroll' | 'grid',
    toMode: 'paginated' | 'scroll' | 'grid',
    currentPage: number
  ): void {
    // Always clear L1 (hot tiles specific to old viewport)
    this.l1Cache.clear();

    // Mode-specific L2 handling
    if (toMode === 'paginated') {
      // Paginated mode: only keep tiles for current page ±1
      // Other tiles won't be visible anyway
      this.evictDistantTiles(currentPage, 1);
    }

    // L3 metadata always preserved (page dimensions, text layer refs)

    console.log(
      `[TileCacheManager] Mode transition ${fromMode} → ${toMode}: ` +
      `L1 cleared, L2=${this.l2Cache.size} tiles, L3=${this.l3Cache.size} pages`
    );
  }

  /**
   * Called on significant zoom changes (>1.5x or <0.67x ratio)
   *
   * Clears L1 cache because tiles at the old scale are no longer optimal.
   * This prevents the 96% L1 miss rate observed when stale scale tiles
   * fill the cache during rapid zoom changes.
   *
   * L2 is preserved since those tiles can still serve as fallbacks.
   *
   * @param zoomRatio Ratio of new zoom to old zoom
   * @param newZoom The new zoom level (for scale calculation)
   */
  onZoomChange(zoomRatio: number, newZoom: number): void {
    // Only act on significant zoom changes
    if (zoomRatio > 0.67 && zoomRatio < 1.5) {
      return;
    }

    const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 2;
    const targetScale = Math.ceil(newZoom * pixelRatio);

    // FALLBACK PRESERVATION FIX: Don't clear L1 entirely.
    // Only evict tiles with >3x scale difference from target.
    // This keeps nearby-scale tiles as usable fallbacks during transitions.
    let l1EvictedCount = 0;
    const l1KeysToEvict: string[] = [];

    for (const key of this.l1Cache.keys()) {
      const parsed = this.parseKey(key);
      if (parsed) {
        const scaleDiff = Math.max(parsed.scale / targetScale, targetScale / parsed.scale);
        if (scaleDiff > 3) {
          l1KeysToEvict.push(key);
        }
      }
    }

    for (const key of l1KeysToEvict) {
      this.l1Cache.delete(key);
      l1EvictedCount++;
    }

    // Phase 5: When zooming OUT significantly, evict high-scale tiles from L2
    // to free memory for new renders at lower scale.
    let l2EvictedCount = 0;
    if (zoomRatio < 0.67) {
      l2EvictedCount = this.evictScalesAbove(targetScale);
    }

    console.log(
      `[TileCacheManager] Zoom change ${zoomRatio.toFixed(2)}x: ` +
        `L1 evicted ${l1EvictedCount} (kept ${this.l1Cache.size})` +
        (l2EvictedCount > 0 ? `, L2 evicted ${l2EvictedCount} high-scale tiles` : '') +
        `, L2=${this.l2Cache.size} tiles preserved`
    );
  }

  /**
   * Get cache warmth for a specific page.
   *
   * Returns the proportion of tiles cached for a page at a given scale.
   * Useful for determining if pre-rendering is needed before mode switch.
   *
   * @param page Page number
   * @param scale Tile scale to check
   * @param pageDimensions Page dimensions at scale 1
   * @param tileSize Tile size in CSS pixels
   * @returns Proportion of tiles cached (0-1)
   */
  getPageCacheWarmth(
    page: number,
    scale: number,
    pageDimensions: { width: number; height: number },
    tileSize: number = 256
  ): number {
    // Calculate total tiles needed for page at this scale
    const scaledWidth = pageDimensions.width * scale;
    const scaledHeight = pageDimensions.height * scale;
    const tilesX = Math.ceil(scaledWidth / tileSize);
    const tilesY = Math.ceil(scaledHeight / tileSize);
    const totalTiles = tilesX * tilesY;

    if (totalTiles === 0) return 1;

    // Count cached tiles
    let cachedCount = 0;
    for (let tileX = 0; tileX < tilesX; tileX++) {
      for (let tileY = 0; tileY < tilesY; tileY++) {
        if (this.has({ page, tileX, tileY, scale })) {
          cachedCount++;
        }
      }
    }

    return cachedCount / totalTiles;
  }

  /**
   * Pre-warm cache for a page (render all tiles).
   *
   * Used before mode transitions to ensure smooth display.
   * Returns immediately if page is already warm.
   *
   * @param page Page number
   * @param scale Tile scale
   * @param pageDimensions Page dimensions at scale 1
   * @param renderCallback Callback to render missing tiles
   * @param tileSize Tile size in CSS pixels
   */
  async prewarmPage(
    page: number,
    scale: number,
    pageDimensions: { width: number; height: number },
    renderCallback: (tile: TileCoordinate) => Promise<CachedTileData>,
    tileSize: number = 256
  ): Promise<void> {
    const warmth = this.getPageCacheWarmth(page, scale, pageDimensions, tileSize);
    if (warmth >= 0.95) {
      // Page is already warm enough
      return;
    }

    const scaledWidth = pageDimensions.width * scale;
    const scaledHeight = pageDimensions.height * scale;
    const tilesX = Math.ceil(scaledWidth / tileSize);
    const tilesY = Math.ceil(scaledHeight / tileSize);

    // Render missing tiles
    const renderPromises: Promise<void>[] = [];

    for (let tileX = 0; tileX < tilesX; tileX++) {
      for (let tileY = 0; tileY < tilesY; tileY++) {
        // amnesia-e4i FIX: Include tileSize so render uses matching size
        const tile: TileCoordinate = { page, tileX, tileY, scale, tileSize };
        if (!this.has(tile)) {
          renderPromises.push(
            renderCallback(tile).then((data) => {
              this.set(tile, data, 'L2');
            })
          );
        }
      }
    }

    await Promise.all(renderPromises);
  }

  /**
   * Populate tile cache from a full-page image (amnesia-e4i: Fallback tile system).
   *
   * This method solves the queue overflow problem at mid-zoom:
   * - At zoom 8x, a page needs 294 tiles (14×21 grid)
   * - Queue max is 400, but with multiple pages visible, tiles get dropped
   * - Dropped tiles cause gaps (blank regions) in the rendered page
   *
   * Solution: Before requesting high-res tiles, render a single low-res full-page
   * image and slice it into tile-sized chunks. These chunks serve as guaranteed
   * fallbacks when high-res tiles fail.
   *
   * Performance:
   * - One MuPDF render at scale 2 (~100ms) instead of 294 individual tile renders
   * - Slicing is pure CPU work (~10ms for 294 chunks)
   * - Result: Every tile position has SOMETHING cached
   *
   * @param page Page number
   * @param fullPageBitmap Full-page ImageBitmap rendered at low scale
   * @param sourceScale The scale at which fullPageBitmap was rendered
   * @param pageDimensions Page dimensions at scale 1
   * @param targetScale The tile scale we're caching for (usually = sourceScale)
   * @param tileSize Tile size in CSS pixels (default 256)
   * @returns Number of tile chunks cached
   */
  async populateTileCacheFromFullPage(
    page: number,
    fullPageBitmap: ImageBitmap,
    sourceScale: number,
    pageDimensions: { width: number; height: number },
    targetScale: number = sourceScale,
    tileSize: number = 256
  ): Promise<number> {
    // Calculate how many tiles this page needs at the target scale
    const scaledWidth = pageDimensions.width * targetScale;
    const scaledHeight = pageDimensions.height * targetScale;
    const tilesX = Math.ceil(scaledWidth / tileSize);
    const tilesY = Math.ceil(scaledHeight / tileSize);

    // Create an offscreen canvas to slice the full-page image
    const offscreen = new OffscreenCanvas(tileSize, tileSize);
    const ctx = offscreen.getContext('2d');
    if (!ctx) {
      console.error('[TileCacheManager] Failed to get offscreen canvas context');
      return 0;
    }

    // Scale factor from source bitmap to target tile scale
    // If sourceScale = 2 and targetScale = 2, scaleRatio = 1 (no scaling needed)
    // If sourceScale = 2 and targetScale = 16, scaleRatio = 8 (each chunk is 8x smaller)
    const scaleRatio = targetScale / sourceScale;

    let cachedCount = 0;

    for (let tileY = 0; tileY < tilesY; tileY++) {
      for (let tileX = 0; tileX < tilesX; tileX++) {
        // Calculate source rectangle in the full-page bitmap
        // Source is at sourceScale, so coordinates need adjustment
        const srcX = (tileX * tileSize) / scaleRatio;
        const srcY = (tileY * tileSize) / scaleRatio;
        const srcW = tileSize / scaleRatio;
        const srcH = tileSize / scaleRatio;

        // Clear and draw the tile chunk
        ctx.clearRect(0, 0, tileSize, tileSize);
        ctx.drawImage(
          fullPageBitmap,
          srcX, srcY, srcW, srcH,  // Source rectangle
          0, 0, tileSize, tileSize  // Destination (full tile)
        );

        // Convert to blob for cache storage
        const blob = await offscreen.convertToBlob({ type: 'image/png' });

        // Create tile coordinate
        const tile: TileCoordinate = {
          page,
          tileX,
          tileY,
          scale: targetScale,
        };

        // Only cache if we don't already have this tile (don't overwrite high-res)
        if (!this.has(tile)) {
          const cacheData: CachedTileData = {
            format: 'png',
            blob,
            width: tileSize,
            height: tileSize,
          };
          this.set(tile, cacheData, 'L2');
          cachedCount++;
        }
      }
    }

    console.log(`[TileCacheManager] populateTileCacheFromFullPage: page=${page}, ` +
      `sourceScale=${sourceScale}, targetScale=${targetScale}, ` +
      `grid=${tilesX}×${tilesY}=${tilesX * tilesY} tiles, cached=${cachedCount} new`);

    return cachedCount;
  }

  /**
   * Evict tiles that are no longer near the viewport
   *
   * Called during scroll to free memory for new tiles
   */
  evictDistantTiles(
    currentPage: number,
    keepRadius: number = 5
  ): void {
    const keysToEvict: string[] = [];

    for (const key of this.l1Cache.keys()) {
      const match = key.match(/-p(\d+)-/);
      if (match) {
        const tilePage = parseInt(match[1], 10);
        if (Math.abs(tilePage - currentPage) > keepRadius) {
          keysToEvict.push(key);
        }
      }
    }

    for (const key of keysToEvict) {
      this.l1Cache.delete(key);
    }
  }

  /**
   * Set the priority function for focal-point-aware eviction (amnesia-x6q).
   * Higher priority values = less important (evicted first).
   *
   * @param fn Function that returns priority (0=critical, 3=low) for a tile
   */
  setPriorityFunction(fn: ((page: number, tileX: number, tileY: number) => number) | null): void {
    this.priorityFunction = fn;
    console.log(`[TileCacheManager] Priority function ${fn ? 'set' : 'cleared'}`);
  }

  /**
   * Evict tiles by priority, removing lowest-priority tiles first (amnesia-x6q).
   * Uses the priority function if set, otherwise falls back to page distance.
   *
   * @param targetCount Number of tiles to evict
   * @param currentPage Current visible page (for fallback distance calculation)
   * @returns Number of tiles actually evicted
   */
  evictByPriority(targetCount: number, currentPage: number = 1): number {
    let evicted = 0;

    // Collect tiles with their priorities
    type TileWithPriority = { key: string; priority: number; cache: 'l1' | 'l2' };
    const tilesWithPriority: TileWithPriority[] = [];

    // Collect from both caches
    for (const key of this.l1Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;

      let priority: number;
      if (this.priorityFunction && 'tileX' in parsed) {
        // Use focal-point priority function
        priority = this.priorityFunction(parsed.page, parsed.tileX!, parsed.tileY!);
      } else {
        // Fallback: priority by page distance (further = higher priority = evicted first)
        priority = Math.abs(parsed.page - currentPage);
      }

      tilesWithPriority.push({ key, priority, cache: 'l1' });
    }

    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;

      let priority: number;
      if (this.priorityFunction && 'tileX' in parsed) {
        priority = this.priorityFunction(parsed.page, parsed.tileX!, parsed.tileY!);
      } else {
        priority = Math.abs(parsed.page - currentPage);
      }

      tilesWithPriority.push({ key, priority, cache: 'l2' });
    }

    // Sort by priority descending (highest priority value = least important = evict first)
    tilesWithPriority.sort((a, b) => b.priority - a.priority);

    // Evict up to targetCount tiles, starting from least important
    for (const tile of tilesWithPriority) {
      if (evicted >= targetCount) break;

      if (tile.cache === 'l1') {
        this.l1Cache.delete(tile.key);
      } else {
        this.l2Cache.delete(tile.key);
      }
      evicted++;
    }

    if (evicted > 0) {
      console.log(`[TileCacheManager] evictByPriority: evicted ${evicted}/${targetCount} tiles`);
    }

    return evicted;
  }

  // ============================================================================
  // SPATIAL-AWARE EVICTION (amnesia-aqv Phase 2B)
  // ============================================================================
  // Combines distance from viewport center with recency for smarter eviction.
  // At high zoom (32x), this keeps nearby tiles cached while evicting distant
  // tiles that the user is unlikely to pan back to.
  //
  // Score = DISTANCE_WEIGHT × normalized_distance + RECENCY_WEIGHT × normalized_age
  // Higher score = more likely to evict.
  // ============================================================================

  /**
   * Evict tiles based on combined distance + recency scoring.
   * 
   * This method improves on pure LRU by considering spatial proximity to the
   * current viewport. At high zoom levels, a tile that was accessed recently
   * but is now 10 pages away is less valuable than an older tile on the current page.
   * 
   * Scoring formula:
   * - normalized_distance = distance / max_distance (0 = at center, 1 = farthest)
   * - normalized_age = age / max_age (0 = just accessed, 1 = oldest)
   * - score = 0.7 × normalized_distance + 0.3 × normalized_age
   * 
   * Distance is calculated as:
   * - Page distance: |tile.page - currentPage| contributes 1.0 per page
   * - Within-page: Manhattan distance from tile center to focal tile
   * 
   * @param currentPage The page currently centered in viewport
   * @param focalTile Optional (tileX, tileY) of the focal point on currentPage
   * @param targetEvictions Number of tiles to evict
   * @returns Number of tiles actually evicted
   */
  evictByDistanceAndRecency(
    currentPage: number,
    focalTile: { tileX: number; tileY: number } | null,
    targetEvictions: number
  ): number {
    const DISTANCE_WEIGHT = 0.7;
    const RECENCY_WEIGHT = 0.3;
    
    // Collect all tiles with their metadata
    type TileScore = {
      key: string;
      cache: 'l1' | 'l2';
      page: number;
      tileX: number;
      tileY: number;
      timestamp: number;
      score: number;
    };
    
    const tiles: TileScore[] = [];
    const now = Date.now();
    let maxDistance = 0;
    let maxAge = 0;
    
    // Helper to calculate raw distance
    const calculateRawDistance = (page: number, tileX: number, tileY: number): number => {
      // Page distance contributes heavily (equivalent to ~10 tiles per page)
      const pageDistance = Math.abs(page - currentPage) * 10;
      
      // Within-page distance using Manhattan distance from focal tile
      let withinPageDistance = 0;
      if (page === currentPage && focalTile) {
        withinPageDistance = Math.abs(tileX - focalTile.tileX) + Math.abs(tileY - focalTile.tileY);
      } else if (page === currentPage) {
        // No focal tile - use distance from center (assume 4x4 grid center = 2,2)
        withinPageDistance = Math.abs(tileX - 2) + Math.abs(tileY - 2);
      }
      
      return pageDistance + withinPageDistance;
    };
    
    // First pass: collect tiles and find max values for normalization
    for (const [key, entry] of this.l1Cache.entries()) {
      const parsed = this.parseKey(key);
      if (!parsed || parsed.type !== 'tile') continue;
      
      const distance = calculateRawDistance(parsed.page, parsed.tileX!, parsed.tileY!);
      const age = now - entry.timestamp;
      
      maxDistance = Math.max(maxDistance, distance);
      maxAge = Math.max(maxAge, age);
      
      tiles.push({
        key,
        cache: 'l1',
        page: parsed.page,
        tileX: parsed.tileX!,
        tileY: parsed.tileY!,
        timestamp: entry.timestamp,
        score: 0, // Calculated in second pass
      });
    }
    
    for (const [key, entry] of this.l2Cache.entries()) {
      const parsed = this.parseKey(key);
      if (!parsed || parsed.type !== 'tile') continue;
      
      const distance = calculateRawDistance(parsed.page, parsed.tileX!, parsed.tileY!);
      const age = now - entry.timestamp;
      
      maxDistance = Math.max(maxDistance, distance);
      maxAge = Math.max(maxAge, age);
      
      tiles.push({
        key,
        cache: 'l2',
        page: parsed.page,
        tileX: parsed.tileX!,
        tileY: parsed.tileY!,
        timestamp: entry.timestamp,
        score: 0,
      });
    }
    
    // Avoid division by zero
    if (maxDistance === 0) maxDistance = 1;
    if (maxAge === 0) maxAge = 1;
    
    // Second pass: calculate normalized scores
    for (const tile of tiles) {
      const distance = calculateRawDistance(tile.page, tile.tileX, tile.tileY);
      const age = now - tile.timestamp;
      
      const normalizedDistance = distance / maxDistance;
      const normalizedAge = age / maxAge;
      
      tile.score = DISTANCE_WEIGHT * normalizedDistance + RECENCY_WEIGHT * normalizedAge;
    }
    
    // Sort by score descending (highest score = evict first)
    tiles.sort((a, b) => b.score - a.score);
    
    // Evict up to targetEvictions
    let evicted = 0;
    for (const tile of tiles) {
      if (evicted >= targetEvictions) break;
      
      if (tile.cache === 'l1') {
        this.l1Cache.delete(tile.key);
      } else {
        this.l2Cache.delete(tile.key);
      }
      evicted++;
    }
    
    if (evicted > 0) {
      console.log(
        `[TileCacheManager] evictByDistanceAndRecency: evicted ${evicted}/${targetEvictions} tiles ` +
        `(page=${currentPage}, focal=${focalTile ? `${focalTile.tileX},${focalTile.tileY}` : 'none'})`
      );
    }
    
    return evicted;
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    l1Count: number;
    l1Bytes: number;
    l2Count: number;
    l2Bytes: number;
    l3Count: number;
  } {
    return {
      l1Count: this.l1Cache.size,
      l1Bytes: this.l1Cache.bytes,
      l2Count: this.l2Cache.size,
      l2Bytes: this.l2Cache.bytes,
      l3Count: this.l3Cache.size,
    };
  }

  /**
   * Handle memory pressure by reducing cache sizes.
   *
   * Implements a graduated response:
   * - Level 1 (moderate): Reduce L2 limits by 25%
   * - Level 2 (high): Reduce L2 limits by 50%, clear L1
   * - Level 3 (critical): Reduce L2 limits by 75%, clear L1, evict intermediate scales
   *
   * @param level Memory pressure level (1=moderate, 2=high, 3=critical)
   * @returns Number of tiles evicted
   */
  handleMemoryPressure(level: 1 | 2 | 3): number {
    let evictedCount = 0;
    // Base limits match constructor defaults (scaled for 9 scale tiers)
    const baseL2Size = 360;
    const baseL2Bytes = 360 * 1024 * 1024;

    switch (level) {
      case 1: // Moderate pressure - reduce L2 limits by 25%
        // amnesia-x6q: Use priority-based eviction if available
        if (this.priorityFunction) {
          evictedCount = this.evictByPriority(Math.floor(this.l2Cache.size * 0.25));
        }
        this.l2Cache.resize({
          maxSize: Math.floor(baseL2Size * 0.75),
          maxBytes: Math.floor(baseL2Bytes * 0.75),
        });
        console.log(`[TileCacheManager] Memory pressure level 1: Reduced L2 to 75%, evicted ${evictedCount} by priority`);
        break;

      case 2: // High pressure - reduce L2 by 50%, evict by priority
        // amnesia-x6q: Use priority-based eviction instead of clearing all L1
        if (this.priorityFunction) {
          // Evict 50% of tiles by priority (keeps high-priority tiles in L1)
          evictedCount = this.evictByPriority(Math.floor((this.l1Cache.size + this.l2Cache.size) * 0.5));
        } else {
          this.l1Cache.clear();
          evictedCount = this.l1Cache.size;
        }
        this.l2Cache.resize({
          maxSize: Math.floor(baseL2Size * 0.5),
          maxBytes: Math.floor(baseL2Bytes * 0.5),
        });
        console.log(`[TileCacheManager] Memory pressure level 2: Reduced L2 to 50%, evicted ${evictedCount} tiles`);
        break;

      case 3: // Critical pressure - aggressive reduction
        // amnesia-x6q: Even at critical, use priority to keep the most important tiles
        if (this.priorityFunction) {
          // Keep only ~10% of tiles (the highest priority ones)
          evictedCount = this.evictByPriority(Math.floor((this.l1Cache.size + this.l2Cache.size) * 0.9));
        } else {
          this.l1Cache.clear();
          evictedCount = this.evictIntermediateScales();
        }
        this.l2Cache.resize({
          maxSize: Math.floor(baseL2Size * 0.25),
          maxBytes: Math.floor(baseL2Bytes * 0.25),
        });
        console.log(`[TileCacheManager] Memory pressure level 3: Critical reduction, evicted ${evictedCount} tiles`);
        break;
    }

    return evictedCount;
  }

  /**
   * Restore cache limits to default after memory pressure subsides.
   */
  restoreCacheLimits(): void {
    // Restore to constructor defaults (scaled for 9 scale tiers)
    this.l2Cache.resize({
      maxSize: 360,
      maxBytes: 360 * 1024 * 1024,
    });
    console.log('[TileCacheManager] Cache limits restored to default');
  }

  // ─────────────────────────────────────────────────────────────────
  // amnesia-x6q Phase 3-4: Gesture-Aware Eviction Strategies
  // ─────────────────────────────────────────────────────────────────

  /**
   * Evict tiles during zoom-in gesture.
   * Strategy: Aggressively evict distant pages, keep focal point high quality.
   * 
   * @param currentPage Current page number
   * @param focalPoint Focal point in canvas coordinates
   * @param keepRadius Number of pages around focal point to preserve
   * @returns Number of tiles evicted
   */
  evictForZoomIn(currentPage: number, focalPoint?: { x: number; y: number }, keepRadius: number = 2): number {
    let evicted = 0;
    const pagesToKeep = new Set<number>();
    
    // Keep pages near current page
    for (let i = -keepRadius; i <= keepRadius; i++) {
      pagesToKeep.add(currentPage + i);
    }

    // Collect tiles to evict (distant pages only)
    const keysToEvict: string[] = [];
    
    for (const key of this.l1Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      
      if (!pagesToKeep.has(parsed.page)) {
        keysToEvict.push(key);
      }
    }
    
    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      
      if (!pagesToKeep.has(parsed.page)) {
        keysToEvict.push(key);
      }
    }

    // Evict collected tiles
    for (const key of keysToEvict) {
      if (this.l1Cache.has(key)) {
        this.l1Cache.delete(key);
        evicted++;
      } else if (this.l2Cache.has(key)) {
        this.l2Cache.delete(key);
        evicted++;
      }
    }

    if (evicted > 0) {
      console.log(`[TileCacheManager] evictForZoomIn: evicted ${evicted} tiles from distant pages (kept pages ${currentPage - keepRadius} to ${currentPage + keepRadius})`);
    }

    return evicted;
  }

  /**
   * Evict tiles during zoom-out gesture.
   * Strategy: Preserve high-quality cache for current pages, only add thumbnails for new pages.
   * Don't evict high-scale tiles aggressively - user may zoom back in.
   * 
   * @param currentPage Current page number
   * @param maxPagesToKeep Maximum pages to keep in cache
   * @returns Number of tiles evicted
   */
  evictForZoomOut(currentPage: number, maxPagesToKeep: number = 10): number {
    let evicted = 0;
    
    // Get all pages in cache with their distances
    const pageDistances = new Map<number, number>();
    
    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      
      const distance = Math.abs(parsed.page - currentPage);
      if (!pageDistances.has(parsed.page) || pageDistances.get(parsed.page)! > distance) {
        pageDistances.set(parsed.page, distance);
      }
    }
    
    // Sort pages by distance, keep closest maxPagesToKeep pages
    const sortedPages = [...pageDistances.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([page]) => page);
    
    const pagesToKeep = new Set(sortedPages.slice(0, maxPagesToKeep));
    
    // Only evict from L2 (persistent cache) - don't touch L1 during zoom-out
    // because L1 contains recent high-quality tiles user may want when zooming back in
    const keysToEvict: string[] = [];
    
    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      
      if (!pagesToKeep.has(parsed.page)) {
        keysToEvict.push(key);
      }
    }

    for (const key of keysToEvict) {
      this.l2Cache.delete(key);
      evicted++;
    }

    if (evicted > 0) {
      console.log(`[TileCacheManager] evictForZoomOut: evicted ${evicted} tiles from L2 (kept ${pagesToKeep.size} pages near page ${currentPage})`);
    }

    return evicted;
  }

  /**
   * Pan-gesture quality preservation.
   * During pan gestures, we should NOT evict tiles from the current viewport.
   * Only evict tiles that have scrolled completely out of view.
   * 
   * @param visiblePages Set of currently visible page numbers
   * @param bufferPages Number of additional pages to keep as buffer
   * @returns Number of tiles evicted
   */
  evictForPan(visiblePages: Set<number>, bufferPages: number = 1): number {
    let evicted = 0;
    
    // Build set of pages to keep (visible + buffer)
    const pagesToKeep = new Set<number>();
    for (const page of visiblePages) {
      for (let i = -bufferPages; i <= bufferPages; i++) {
        pagesToKeep.add(page + i);
      }
    }
    
    // Only evict from L2 to preserve L1 quality tiles
    const keysToEvict: string[] = [];
    
    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      
      if (!pagesToKeep.has(parsed.page)) {
        keysToEvict.push(key);
      }
    }

    for (const key of keysToEvict) {
      this.l2Cache.delete(key);
      evicted++;
    }

    if (evicted > 0) {
      console.log(`[TileCacheManager] evictForPan: evicted ${evicted} tiles from L2 (kept ${visiblePages.size} visible + ${bufferPages} buffer pages)`);
    }

    return evicted;
  }

  /**
   * Get tiles to preserve at current quality during gesture.
   * Returns the cache keys that should NOT be evicted during quality preservation.
   * 
   * @param visiblePages Set of currently visible pages
   * @param currentScale The current render scale
   * @returns Array of cache keys to preserve
   */
  getQualityPreservationKeys(visiblePages: Set<number>, currentScale: number): string[] {
    const keysToPreserve: string[] = [];
    const scaleThreshold = currentScale * 0.5; // Keep tiles at 50%+ of current scale
    
    for (const key of this.l1Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed || !visiblePages.has(parsed.page)) continue;
      
      // Check if this is a high-quality tile (scale >= threshold)
      if ('scale' in parsed && (parsed as { scale: number }).scale >= scaleThreshold) {
        keysToPreserve.push(key);
      }
    }
    
    for (const key of this.l2Cache.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed || !visiblePages.has(parsed.page)) continue;
      
      if ('scale' in parsed && (parsed as { scale: number }).scale >= scaleThreshold) {
        keysToPreserve.push(key);
      }
    }
    
    return keysToPreserve;
  }

  /**
   * Clear all caches
   */
  clear(): void {
    // Since we store Blobs (not ImageBitmaps), no need to close anything
    this.l1Cache.clear();
    this.l2Cache.clear();
    this.l3Cache.clear();
    // amnesia-aqv Phase 2A: Clear scale-tier index
    this.scaleTierIndex.clear();
    this.documentId = null;
  }
}

// Singleton instance
let tileCacheManagerInstance: TileCacheManager | null = null;

/**
 * Get the shared tile cache manager instance
 */
export function getTileCacheManager(): TileCacheManager {
  if (!tileCacheManagerInstance) {
    tileCacheManagerInstance = new TileCacheManager();
  }
  return tileCacheManagerInstance;
}

/**
 * Reset the tile cache manager (for testing)
 */
export function resetTileCacheManager(): void {
  if (tileCacheManagerInstance) {
    tileCacheManagerInstance.clear();
  }
  tileCacheManagerInstance = null;
}

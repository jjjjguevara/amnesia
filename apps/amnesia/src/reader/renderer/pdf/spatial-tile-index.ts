/**
 * spatial-tile-index.ts
 * 
 * QuadTree-based spatial index for PDF tiles.
 * Implements CATiledLayer-style "best available" semantics.
 * 
 * Architecture: Hybrid (Option C)
 * - One quadtree per page for 2D spatial indexing
 * - Cross-page coordinator for viewport queries
 * - Adaptive depth by default (configurable)
 * - Fallback protection (always keeps low-scale coverage)
 * 
 * This replaces epoch-based tile validation with spatial multi-resolution lookup.
 * Tiles are never rejected based on "staleness" - the best available is always shown.
 * 
 * @module spatial-tile-index
 */

import type { TileCoordinate } from './tile-render-engine';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A rectangular region in PDF coordinate space.
 */
export interface PdfRegion {
  x: number;      // Left edge in PDF units
  y: number;      // Top edge in PDF units
  width: number;  // Width in PDF units
  height: number; // Height in PDF units
}

/**
 * Configuration for the spatial index.
 */
export interface SpatialIndexConfig {
  /** Use adaptive depth (subdivide based on tile count) vs fixed depth */
  adaptive: boolean;
  
  /** Maximum tiles per node before subdivision (adaptive mode) */
  maxTilesPerNode: number;
  
  /** Minimum region size in PDF units (stops subdivision) */
  minRegionSize: number;
  
  /** Fixed tree depth when adaptive=false */
  fixedDepth: number;
  
  /** Maximum nodes per page (memory limit) */
  maxNodesPerPage: number;
}

/**
 * Eviction policy configuration.
 */
export interface EvictionPolicy {
  /** Always keep at least one tile per fallback region */
  protectFallbackTiles: boolean;
  
  /** Fallback grid size (NxN regions per page) */
  fallbackGridSize: number;
  
  /** Minimum scale to protect for fallback */
  fallbackMinScale: number;
}

/**
 * Entry stored in the quadtree.
 * 
 * MEMORY FIX (amnesia-aqv): No longer stores CachedTileData to avoid memory duplication.
 * The actual tile data is stored in L1/L2 cache only. When queried, callers look up
 * data from the cache using the tile coordinates.
 */
interface TileEntry {
  tile: TileCoordinate;
  cacheKey: string;  // Key to look up data in L1/L2 cache
  region: PdfRegion;
  insertTime: number;
  accessTime: number;
}

/**
 * QuadTree node.
 */
interface QuadNode {
  bounds: PdfRegion;
  tiles: Map<string, TileEntry>;  // Key: tileKey
  children: QuadNode[] | null;    // [NW, NE, SW, SE] or null if leaf
  depth: number;
}

/**
 * Result from a best-available query.
 * 
 * MEMORY FIX (amnesia-aqv): No longer includes CachedTileData. Callers must look up
 * data from the L1/L2 cache using the cacheKey.
 */
export interface SpatialQueryResult {
  tile: TileCoordinate;
  cacheKey: string;  // Key to look up data in L1/L2 cache
  cssStretch: number;  // targetScale / actualScale
  region: PdfRegion;
}

/**
 * Page dimensions for coordinate calculations.
 */
export interface PageDimensions {
  width: number;
  height: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Scale tiers for multi-resolution lookup (descending order for best-first) */
const SCALE_TIERS_DESCENDING = [64, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1, 0.5, 0.25];

/** Default configuration */
const DEFAULT_CONFIG: SpatialIndexConfig = {
  adaptive: true,
  maxTilesPerNode: 4,
  minRegionSize: 16,  // PDF units
  fixedDepth: 8,
  maxNodesPerPage: 1000,
};

/**
 * Maximum tiles per page in the spatial index.
 * At 32x zoom, viewport needs ~120 tiles. With scrolling, we allow 3x viewport (360 tiles).
 * This prevents unbounded memory growth that causes GPU crashes.
 */
const MAX_TILES_PER_PAGE = 400;

/** Default eviction policy */
const DEFAULT_EVICTION_POLICY: EvictionPolicy = {
  protectFallbackTiles: true,
  fallbackGridSize: 4,    // 4x4 = 16 regions per page
  fallbackMinScale: 4,    // Keep at least scale-4 coverage
};

// ─────────────────────────────────────────────────────────────────────────────
// PageQuadTree: Per-page spatial index
// ─────────────────────────────────────────────────────────────────────────────

/**
 * QuadTree for a single page.
 * Handles 2D spatial indexing of tiles at multiple scales.
 */
class PageQuadTree {
  private root: QuadNode;
  private nodeCount: number = 1;
  private tileCount: number = 0;
  
  constructor(
    public readonly page: number,
    public readonly dimensions: PageDimensions,
    private readonly config: SpatialIndexConfig,
  ) {
    this.root = this.createNode({
      x: 0,
      y: 0,
      width: dimensions.width,
      height: dimensions.height,
    }, 0);
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────
  
  /**
   * Insert a tile into the quadtree.
   * 
   * MEMORY FIX (amnesia-aqv): Only stores cacheKey, not the actual data.
   * Also enforces MAX_TILES_PER_PAGE limit with LRU eviction.
   */
  insert(tile: TileCoordinate, cacheKey: string, region: PdfRegion): void {
    const entry: TileEntry = {
      tile,
      cacheKey,
      region,
      insertTime: performance.now(),
      accessTime: performance.now(),
    };
    
    this.insertIntoNode(this.root, entry);
    this.tileCount++;
    
    // MEMORY FIX (amnesia-aqv): Enforce tile limit to prevent unbounded growth
    // At 32x zoom with scrolling, we can accumulate thousands of tiles causing GPU crash
    if (this.tileCount > MAX_TILES_PER_PAGE) {
      this.evictOldestTiles(this.tileCount - MAX_TILES_PER_PAGE);
    }
  }
  
  /**
   * Evict oldest tiles (LRU) to stay under the limit.
   * Prefers evicting high-zoom tiles over fallback (low-zoom) tiles.
   */
  private evictOldestTiles(count: number): void {
    const allTiles = this.getAllTiles();
    
    // Sort by accessTime ascending (oldest first), but protect fallback tiles (scale <= 4)
    allTiles.sort((a, b) => {
      // Protect fallback tiles - sort them to the end
      const aIsFallback = a.tile.scale <= 4;
      const bIsFallback = b.tile.scale <= 4;
      if (aIsFallback !== bIsFallback) {
        return aIsFallback ? 1 : -1; // Fallback tiles go to end (less likely to evict)
      }
      // Within same protection level, sort by accessTime (oldest first)
      return a.accessTime - b.accessTime;
    });
    
    // Evict the oldest tiles
    let evicted = 0;
    for (const entry of allTiles) {
      if (evicted >= count) break;
      
      const tileKey = this.getTileKey(entry.tile);
      if (this.remove(tileKey)) {
        evicted++;
      }
    }
  }
  
  /**
   * Remove a tile from the quadtree.
   */
  remove(tileKey: string): boolean {
    const removed = this.removeFromNode(this.root, tileKey);
    if (removed) {
      this.tileCount--;
    }
    return removed;
  }
  
  /**
   * Query tiles overlapping a region at a specific scale.
   */
  queryAtScale(region: PdfRegion, scale: number): TileEntry[] {
    const results: TileEntry[] = [];
    this.queryNode(this.root, region, scale, results);
    return results;
  }
  
  /**
   * Get best available tiles for a region, searching from target scale down.
   * Returns tiles that provide coverage, preferring higher scales.
   */
  getBestAvailable(region: PdfRegion, targetScale: number): SpatialQueryResult[] {
    const results: SpatialQueryResult[] = [];
    const coveredRegions = new Set<string>();
    
    // Search from target scale down to lowest
    for (const scale of SCALE_TIERS_DESCENDING) {
      if (scale > targetScale * 1.5) continue;  // Don't use much higher than needed
      
      const tiles = this.queryAtScale(region, scale);
      
      for (const entry of tiles) {
        const regionKey = this.getRegionKey(entry.region, scale);
        
        // Skip if this region is already covered by a higher-scale tile
        if (coveredRegions.has(regionKey)) continue;
        
        // Mark region as covered
        coveredRegions.add(regionKey);
        
        // Update access time (LRU tracking)
        entry.accessTime = performance.now();
        
        results.push({
          tile: entry.tile,
          cacheKey: entry.cacheKey,
          cssStretch: targetScale / scale,
          region: entry.region,
        });
      }
      
      // If we have full coverage, stop searching lower scales
      if (this.hasFullCoverage(coveredRegions, region, scale)) {
        break;
      }
    }
    
    return results;
  }
  
  /**
   * Get all tiles in the tree.
   */
  getAllTiles(): TileEntry[] {
    const results: TileEntry[] = [];
    this.collectAllTiles(this.root, results);
    return results;
  }
  
  /**
   * Get tiles sorted by distance from a point (farthest first, for eviction).
   */
  getTilesByDistance(
    centerX: number,
    centerY: number,
    excludeProtected: boolean,
    protectedRegions?: Set<string>,
  ): TileEntry[] {
    const tiles = this.getAllTiles();
    
    // Calculate distance for each tile
    const withDistance = tiles.map(entry => {
      const tileCenterX = entry.region.x + entry.region.width / 2;
      const tileCenterY = entry.region.y + entry.region.height / 2;
      const distance = Math.sqrt(
        Math.pow(tileCenterX - centerX, 2) +
        Math.pow(tileCenterY - centerY, 2)
      );
      return { entry, distance };
    });
    
    // Filter out protected tiles if requested
    const filtered = excludeProtected && protectedRegions
      ? withDistance.filter(({ entry }) => {
          const regionKey = this.getFallbackRegionKey(entry.region);
          return !protectedRegions.has(regionKey);
        })
      : withDistance;
    
    // Sort by distance descending (farthest first)
    filtered.sort((a, b) => b.distance - a.distance);
    
    return filtered.map(({ entry }) => entry);
  }
  
  /**
   * Get statistics about this tree.
   */
  getStats(): { nodeCount: number; tileCount: number; depth: number } {
    return {
      nodeCount: this.nodeCount,
      tileCount: this.tileCount,
      depth: this.getMaxDepth(this.root),
    };
  }
  
  /**
   * Clear all tiles from this tree.
   */
  clear(): void {
    this.root = this.createNode({
      x: 0,
      y: 0,
      width: this.dimensions.width,
      height: this.dimensions.height,
    }, 0);
    this.nodeCount = 1;
    this.tileCount = 0;
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Private: Node operations
  // ───────────────────────────────────────────────────────────────────────────
  
  private createNode(bounds: PdfRegion, depth: number): QuadNode {
    return {
      bounds,
      tiles: new Map(),
      children: null,
      depth,
    };
  }
  
  private insertIntoNode(node: QuadNode, entry: TileEntry): void {
    const tileKey = this.getTileKey(entry.tile);
    
    // If this is a leaf node
    if (!node.children) {
      node.tiles.set(tileKey, entry);
      
      // Check if we should subdivide
      if (this.shouldSubdivide(node)) {
        this.subdivide(node);
      }
      return;
    }
    
    // Find which child(ren) the tile overlaps
    const overlappingChildren = this.getOverlappingChildren(node, entry.region);
    
    if (overlappingChildren.length === 1) {
      // Tile fits entirely in one child
      this.insertIntoNode(overlappingChildren[0], entry);
    } else {
      // Tile spans multiple children - store at this level
      node.tiles.set(tileKey, entry);
    }
  }
  
  private removeFromNode(node: QuadNode, tileKey: string): boolean {
    // Check this node
    if (node.tiles.has(tileKey)) {
      node.tiles.delete(tileKey);
      return true;
    }
    
    // Check children
    if (node.children) {
      for (const child of node.children) {
        if (this.removeFromNode(child, tileKey)) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  private queryNode(
    node: QuadNode,
    region: PdfRegion,
    scale: number,
    results: TileEntry[],
  ): void {
    // Check if query region overlaps this node
    if (!this.regionsOverlap(node.bounds, region)) {
      return;
    }
    
    // Check tiles at this node
    for (const entry of node.tiles.values()) {
      if (entry.tile.scale === scale && this.regionsOverlap(entry.region, region)) {
        results.push(entry);
      }
    }
    
    // Recurse into children
    if (node.children) {
      for (const child of node.children) {
        this.queryNode(child, region, scale, results);
      }
    }
  }
  
  private collectAllTiles(node: QuadNode, results: TileEntry[]): void {
    for (const entry of node.tiles.values()) {
      results.push(entry);
    }
    
    if (node.children) {
      for (const child of node.children) {
        this.collectAllTiles(child, results);
      }
    }
  }
  
  private shouldSubdivide(node: QuadNode): boolean {
    if (!this.config.adaptive) {
      return node.depth < this.config.fixedDepth;
    }
    
    // Adaptive: subdivide if too many tiles and region is large enough
    const tooManyTiles = node.tiles.size > this.config.maxTilesPerNode;
    const regionLargeEnough = 
      node.bounds.width > this.config.minRegionSize * 2 &&
      node.bounds.height > this.config.minRegionSize * 2;
    const underNodeLimit = this.nodeCount + 4 <= this.config.maxNodesPerPage;
    
    return tooManyTiles && regionLargeEnough && underNodeLimit;
  }
  
  private subdivide(node: QuadNode): void {
    const { x, y, width, height } = node.bounds;
    const halfW = width / 2;
    const halfH = height / 2;
    const nextDepth = node.depth + 1;
    
    // Create children: NW, NE, SW, SE
    node.children = [
      this.createNode({ x, y, width: halfW, height: halfH }, nextDepth),           // NW
      this.createNode({ x: x + halfW, y, width: halfW, height: halfH }, nextDepth), // NE
      this.createNode({ x, y: y + halfH, width: halfW, height: halfH }, nextDepth), // SW
      this.createNode({ x: x + halfW, y: y + halfH, width: halfW, height: halfH }, nextDepth), // SE
    ];
    
    this.nodeCount += 4;
    
    // Redistribute tiles that fit entirely in one child
    const toRedistribute = Array.from(node.tiles.entries());
    for (const [key, entry] of toRedistribute) {
      const overlapping = this.getOverlappingChildren(node, entry.region);
      if (overlapping.length === 1) {
        node.tiles.delete(key);
        overlapping[0].tiles.set(key, entry);
      }
      // Tiles spanning multiple children stay at this level
    }
  }
  
  private getOverlappingChildren(node: QuadNode, region: PdfRegion): QuadNode[] {
    if (!node.children) return [];
    
    return node.children.filter(child => this.regionsOverlap(child.bounds, region));
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Private: Geometry helpers
  // ───────────────────────────────────────────────────────────────────────────
  
  private regionsOverlap(a: PdfRegion, b: PdfRegion): boolean {
    return !(
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y
    );
  }
  
  private hasFullCoverage(
    coveredRegions: Set<string>,
    queryRegion: PdfRegion,
    scale: number,
  ): boolean {
    // Approximate: check if we have tiles covering the four corners
    const corners = [
      { x: queryRegion.x, y: queryRegion.y },
      { x: queryRegion.x + queryRegion.width, y: queryRegion.y },
      { x: queryRegion.x, y: queryRegion.y + queryRegion.height },
      { x: queryRegion.x + queryRegion.width, y: queryRegion.y + queryRegion.height },
    ];
    
    for (const corner of corners) {
      const regionKey = `${Math.floor(corner.x / 100)}-${Math.floor(corner.y / 100)}-${scale}`;
      // This is a heuristic - full coverage check would be more complex
    }
    
    // For now, return false to continue searching lower scales
    // This ensures we always have fallback content
    return false;
  }
  
  private getRegionKey(region: PdfRegion, scale: number): string {
    // Use actual tile coordinates for deduplication.
    // 
    // CRITICAL FIX: Previously used a fixed gridSize=50 PDF units, but at scale 32
    // with tileSize 128, tiles are only 4x4 PDF units. Many tiles would map to the
    // same grid cell and get incorrectly deduplicated.
    //
    // Now we use the actual tile position (rounded to avoid float precision issues)
    // to ensure each tile gets a unique key.
    const x = Math.round(region.x * 10);  // 0.1 PDF unit precision
    const y = Math.round(region.y * 10);
    return `${x}-${y}-${scale}`;
  }
  
  private getFallbackRegionKey(region: PdfRegion): string {
    // Coarse grid for fallback protection
    const gridSize = Math.max(this.dimensions.width, this.dimensions.height) / 4;
    const gx = Math.floor((region.x + region.width / 2) / gridSize);
    const gy = Math.floor((region.y + region.height / 2) / gridSize);
    return `${gx}-${gy}`;
  }
  
  private getTileKey(tile: TileCoordinate): string {
    const tileSize = tile.tileSize ?? 256;
    return `p${tile.page}-t${tile.tileX}x${tile.tileY}-s${tile.scale}-ts${tileSize}`;
  }
  
  private getMaxDepth(node: QuadNode): number {
    if (!node.children) return node.depth;
    return Math.max(...node.children.map(c => this.getMaxDepth(c)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SpatialTileIndex: Cross-page coordinator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main spatial tile index.
 * Coordinates multiple per-page quadtrees for viewport queries.
 */
export class SpatialTileIndex {
  private pageIndices: Map<number, PageQuadTree> = new Map();
  private pageDimensions: Map<number, PageDimensions> = new Map();
  private config: SpatialIndexConfig;
  private evictionPolicy: EvictionPolicy;
  
  constructor(
    config: Partial<SpatialIndexConfig> = {},
    evictionPolicy: Partial<EvictionPolicy> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.evictionPolicy = { ...DEFAULT_EVICTION_POLICY, ...evictionPolicy };
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Configuration
  // ───────────────────────────────────────────────────────────────────────────
  
  /**
   * Update configuration (affects new trees, not existing).
   */
  updateConfig(config: Partial<SpatialIndexConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * Update eviction policy.
   */
  updateEvictionPolicy(policy: Partial<EvictionPolicy>): void {
    this.evictionPolicy = { ...this.evictionPolicy, ...policy };
  }
  
  /**
   * Set page dimensions (required before inserting tiles for a page).
   */
  setPageDimensions(page: number, dimensions: PageDimensions): void {
    this.pageDimensions.set(page, dimensions);
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Insert / Remove
  // ───────────────────────────────────────────────────────────────────────────
  
  /**
   * Insert a tile into the spatial index.
   * 
   * MEMORY FIX (amnesia-aqv): Only stores cacheKey, not the actual data.
   * The cacheKey is used to look up data from L1/L2 cache when queried.
   */
  insert(tile: TileCoordinate, cacheKey: string): void {
    const tree = this.getOrCreateTree(tile.page);
    if (!tree) {
      console.warn(`[SpatialTileIndex] Cannot insert tile for page ${tile.page}: dimensions not set`);
      return;
    }
    
    const region = this.tileToRegion(tile);
    tree.insert(tile, cacheKey, region);
    
    // DEBUG: Log every 20th insert at scale 32
    const stats = tree.getStats();
    if (tile.scale === 32 && stats.tileCount % 20 === 0) {
      console.log(`[SpatialTileIndex] INSERT page=${tile.page} tileCount=${stats.tileCount}`);
    }
  }
  
  /**
   * Remove a tile from the spatial index.
   */
  remove(tile: TileCoordinate): boolean {
    const tree = this.pageIndices.get(tile.page);
    if (!tree) return false;
    
    const tileKey = this.getTileKey(tile);
    return tree.remove(tileKey);
  }
  
  /**
   * Check if a tile exists in the index.
   */
  has(tile: TileCoordinate): boolean {
    const tree = this.pageIndices.get(tile.page);
    if (!tree) return false;
    
    const region = this.tileToRegion(tile);
    const results = tree.queryAtScale(region, tile.scale);
    const tileKey = this.getTileKey(tile);
    return results.some(e => this.getTileKey(e.tile) === tileKey);
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Query
  // ───────────────────────────────────────────────────────────────────────────
  
  /**
   * Get best available tiles for a region on a page.
   * Returns tiles at various scales, preferring higher (more detailed).
   * 
   * This is the core CATiledLayer-style query: "give me the best content
   * you have for this region, whatever scale it may be at".
   */
  getBestAvailable(
    page: number,
    region: PdfRegion,
    targetScale: number,
  ): SpatialQueryResult[] {
    const tree = this.pageIndices.get(page);
    if (!tree) return [];
    
    return tree.getBestAvailable(region, targetScale);
  }
  
  /**
   * Get best available tile for a specific tile coordinate.
   * Convenience wrapper that converts tile coord to region.
   */
  getBestAvailableForTile(tile: TileCoordinate): SpatialQueryResult | null {
    const region = this.tileToRegion(tile);
    const results = this.getBestAvailable(tile.page, region, tile.scale);
    
    // Return the best result (highest scale / lowest cssStretch)
    if (results.length === 0) return null;
    
    results.sort((a, b) => a.cssStretch - b.cssStretch);
    return results[0];
  }
  
  /**
   * Get tiles within a viewport across multiple pages.
   * Used for determining what to render.
   */
  getTilesInViewport(
    visiblePages: number[],
    getViewportRegion: (page: number) => PdfRegion,
    targetScale: number,
  ): Map<number, SpatialQueryResult[]> {
    const results = new Map<number, SpatialQueryResult[]>();
    
    for (const page of visiblePages) {
      const region = getViewportRegion(page);
      const pageTiles = this.getBestAvailable(page, region, targetScale);
      results.set(page, pageTiles);
    }
    
    return results;
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Eviction
  // ───────────────────────────────────────────────────────────────────────────
  
  /**
   * Get eviction candidates sorted by priority (lowest priority first).
   * Respects fallback protection policy.
   */
  getEvictionCandidates(
    viewportCenter: { page: number; x: number; y: number },
    count: number,
  ): { page: number; tile: TileCoordinate }[] {
    const candidates: { page: number; tile: TileCoordinate; priority: number }[] = [];
    
    // Get protected regions if fallback protection is enabled
    const protectedRegions = this.evictionPolicy.protectFallbackTiles
      ? this.getProtectedFallbackRegions()
      : new Set<string>();
    
    // Collect candidates from all pages
    for (const [page, tree] of this.pageIndices) {
      // Page distance factor
      const pageDistance = Math.abs(page - viewportCenter.page);
      
      // Get tiles sorted by distance within page
      const pageTiles = tree.getTilesByDistance(
        viewportCenter.x,
        viewportCenter.y,
        this.evictionPolicy.protectFallbackTiles,
        protectedRegions,
      );
      
      for (const entry of pageTiles) {
        // Priority: combine page distance and spatial distance
        // Higher priority = more likely to be evicted
        const tileCenterX = entry.region.x + entry.region.width / 2;
        const tileCenterY = entry.region.y + entry.region.height / 2;
        const spatialDistance = Math.sqrt(
          Math.pow(tileCenterX - viewportCenter.x, 2) +
          Math.pow(tileCenterY - viewportCenter.y, 2)
        );
        
        // Page distance is weighted more heavily
        const priority = pageDistance * 10000 + spatialDistance;
        
        candidates.push({ page, tile: entry.tile, priority });
      }
    }
    
    // Sort by priority descending (highest priority = evict first)
    candidates.sort((a, b) => b.priority - a.priority);
    
    // Return top N candidates
    return candidates.slice(0, count).map(c => ({ page: c.page, tile: c.tile }));
  }
  
  /**
   * Check if evicting a tile would leave a region without fallback coverage.
   */
  isOnlyCoverageForRegion(tile: TileCoordinate): boolean {
    const tree = this.pageIndices.get(tile.page);
    if (!tree) return false;
    
    const region = this.tileToRegion(tile);
    
    // Check if any other tile covers this region
    for (const scale of SCALE_TIERS_DESCENDING) {
      if (scale === tile.scale) continue;
      
      const otherTiles = tree.queryAtScale(region, scale);
      if (otherTiles.length > 0) {
        return false;  // Another tile provides coverage
      }
    }
    
    return true;  // This is the only tile covering this region
  }
  
  /**
   * Get regions that must have fallback coverage (protected from eviction).
   */
  private getProtectedFallbackRegions(): Set<string> {
    const protected_ = new Set<string>();
    
    for (const [page, tree] of this.pageIndices) {
      const dims = this.pageDimensions.get(page);
      if (!dims) continue;
      
      const gridSize = Math.max(dims.width, dims.height) / this.evictionPolicy.fallbackGridSize;
      
      // Mark regions that have low-scale tiles
      const allTiles = tree.getAllTiles();
      for (const entry of allTiles) {
        if (entry.tile.scale <= this.evictionPolicy.fallbackMinScale) {
          const gx = Math.floor((entry.region.x + entry.region.width / 2) / gridSize);
          const gy = Math.floor((entry.region.y + entry.region.height / 2) / gridSize);
          protected_.add(`${page}-${gx}-${gy}`);
        }
      }
    }
    
    return protected_;
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Page management
  // ───────────────────────────────────────────────────────────────────────────
  
  /**
   * Clear all tiles for a page.
   */
  clearPage(page: number): void {
    const tree = this.pageIndices.get(page);
    if (tree) {
      tree.clear();
    }
  }
  
  /**
   * Remove a page's tree entirely.
   */
  removePage(page: number): void {
    this.pageIndices.delete(page);
    this.pageDimensions.delete(page);
  }
  
  /**
   * Clear all pages.
   */
  clear(): void {
    this.pageIndices.clear();
    // Keep pageDimensions - they're still valid
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Statistics
  // ───────────────────────────────────────────────────────────────────────────
  
  /**
   * Get statistics about the spatial index.
   */
  getStats(): {
    pageCount: number;
    totalTiles: number;
    totalNodes: number;
    perPage: Map<number, { nodeCount: number; tileCount: number; depth: number }>;
  } {
    let totalTiles = 0;
    let totalNodes = 0;
    const perPage = new Map<number, { nodeCount: number; tileCount: number; depth: number }>();
    
    for (const [page, tree] of this.pageIndices) {
      const stats = tree.getStats();
      totalTiles += stats.tileCount;
      totalNodes += stats.nodeCount;
      perPage.set(page, stats);
    }
    
    return {
      pageCount: this.pageIndices.size,
      totalTiles,
      totalNodes,
      perPage,
    };
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────
  
  private getOrCreateTree(page: number): PageQuadTree | null {
    let tree = this.pageIndices.get(page);
    if (tree) return tree;
    
    const dims = this.pageDimensions.get(page);
    if (!dims) return null;
    
    tree = new PageQuadTree(page, dims, this.config);
    this.pageIndices.set(page, tree);
    return tree;
  }
  
  /**
   * Convert a tile coordinate to a PDF region.
   */
  private tileToRegion(tile: TileCoordinate): PdfRegion {
    const tileSize = tile.tileSize ?? 256;
    const pdfTileSize = tileSize / tile.scale;
    
    return {
      x: tile.tileX * pdfTileSize,
      y: tile.tileY * pdfTileSize,
      width: pdfTileSize,
      height: pdfTileSize,
    };
  }
  
  private getTileKey(tile: TileCoordinate): string {
    const tileSize = tile.tileSize ?? 256;
    return `p${tile.page}-t${tile.tileX}x${tile.tileY}-s${tile.scale}-ts${tileSize}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory function with system detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a SpatialTileIndex with configuration based on system capabilities.
 */
export function createSpatialTileIndex(
  systemProfile?: { tier: 'high' | 'mid' | 'low' },
): SpatialTileIndex {
  const tier = systemProfile?.tier ?? 'mid';
  
  const configByTier: Record<string, Partial<SpatialIndexConfig>> = {
    high: {
      adaptive: true,
      maxTilesPerNode: 8,
      minRegionSize: 8,
      maxNodesPerPage: 2000,
    },
    mid: {
      adaptive: true,
      maxTilesPerNode: 4,
      minRegionSize: 16,
      maxNodesPerPage: 500,
    },
    low: {
      adaptive: true,
      maxTilesPerNode: 4,
      minRegionSize: 32,
      maxNodesPerPage: 200,
    },
  };
  
  return new SpatialTileIndex(configByTier[tier]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export { PageQuadTree };
export type { TileEntry, QuadNode };

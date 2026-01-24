/**
 * Hybrid Document Provider
 *
 * Unified provider for PDF and EPUB document handling using MuPDF WASM.
 * Provides a single interface for loading, rendering, and searching across both document formats.
 *
 * Features:
 * - Format-agnostic document operations
 * - Two-tier caching (Memory + IndexedDB)
 * - Prefetching for adjacent pages/chapters
 * - Offline-capable via WASM
 *
 * @example
 * ```typescript
 * const provider = await createHybridDocumentProvider({ pluginPath: '...' });
 * const doc = await provider.loadDocument(pdfOrEpubData, 'document.pdf');
 * const pageBlob = await provider.renderItem(doc.id, 0, { scale: 1.5 });
 * ```
 */

import { DocumentBridge, getSharedDocumentBridge, destroySharedDocumentBridge } from './document-bridge';
import type { ParsedDocument, StructuredText, SearchResult, DocumentFormat } from './document-worker';
import { getTileEngine, type TileCoordinate } from './pdf/tile-render-engine';
import { getRenderCoordinator, type RenderCoordinator } from './pdf/render-coordinator';
import { getTargetScaleTier, SCALE_TIERS } from './pdf/progressive-tile-renderer';
import { getSharedMuPDFBridge } from './pdf/mupdf-bridge';
import type { PageClassification } from './pdf/content-type-classifier';
import type { ParsedPdf, PdfTextLayerData, TocEntry } from './types';
import type { PdfContentProvider } from './pdf/pdf-renderer';
import {
  getThumbnailIdbCache,
  generateDocumentHash,
  imageToWebPBlob,
  blobToImageBitmap,
} from './pdf/thumbnail-idb-cache';

// ============================================================================
// Types
// ============================================================================

export interface HybridDocumentProviderConfig {
  /** Plugin base path for loading WASM files */
  pluginPath?: string;
  /** Enable caching (default: true) */
  enableCache?: boolean;
  /** Enable prefetching (default: true) */
  enablePrefetch?: boolean;
  /** Number of items to prefetch ahead/behind (default: 2) */
  prefetchCount?: number;
}

export interface ProviderStatus {
  wasmAvailable: boolean;
  documentId: string | null;
  format: DocumentFormat | null;
  itemCount: number;
}

export interface RenderOptions {
  /** Render scale (1.0 = 72 DPI) */
  scale?: number;
  /** Image format */
  format?: 'png' | 'jpeg' | 'webp';
  /** Rotation in degrees (0, 90, 180, 270) */
  rotation?: number;
}

export interface TileRenderOptions extends RenderOptions {
  /** Tile size in pixels (default: 256) */
  tileSize?: number;
}

/**
 * Provider mode for document handling.
 * - 'auto': Use server when available, fallback to WASM
 * - 'wasm': Always use WASM (offline mode)
 * - 'server': Always use server (legacy mode)
 */
export type ProviderMode = 'auto' | 'wasm' | 'server';

// ============================================================================
// Cache Implementation
// ============================================================================

interface CacheEntry {
  blob: Blob;
  timestamp: number;
}

/** Thumbnail scale for IndexedDB persistence (must match THUMBNAIL_SCALE in provider) */
const THUMBNAIL_SCALE = 0.5;

class DocumentCache {
  private memoryCache = new Map<string, CacheEntry>();
  private maxMemoryEntries = 100;
  private maxMemoryBytes = 100 * 1024 * 1024; // 100MB
  private currentBytes = 0;

  /** Map docId to document hash for IndexedDB lookups */
  private docHashMap = new Map<string, string>();

  /** Track IndexedDB cache hit stats */
  private idbHits = 0;
  private idbMisses = 0;

  private makeCacheKey(docId: string, itemIndex: number, scale: number): string {
    return `${docId}-${itemIndex}-${scale.toFixed(2)}`;
  }

  /**
   * Set the document hash for a docId (needed for IndexedDB lookups)
   */
  setDocumentHash(docId: string, docHash: string): void {
    this.docHashMap.set(docId, docHash);
  }

  /**
   * Get document hash for a docId
   */
  getDocumentHash(docId: string): string | null {
    return this.docHashMap.get(docId) ?? null;
  }

  async get(docId: string, itemIndex: number, scale: number): Promise<Blob | null> {
    const key = this.makeCacheKey(docId, itemIndex, scale);
    const entry = this.memoryCache.get(key);

    // Memory cache hit
    if (entry?.blob) {
      return entry.blob;
    }

    // For thumbnail scale, check IndexedDB as L2
    const isThumbnail = Math.abs(scale - THUMBNAIL_SCALE) < 0.01;
    if (isThumbnail) {
      const docHash = this.docHashMap.get(docId);
      if (docHash) {
        try {
          const idbCache = getThumbnailIdbCache();
          // Pages are 1-indexed in IndexedDB, items are 0-indexed
          const idbEntry = await idbCache.get(docHash, itemIndex + 1);

          if (idbEntry) {
            this.idbHits++;
            // Warm memory cache from IndexedDB
            await this.set(docId, itemIndex, scale, idbEntry.blob, false); // Don't re-persist
            console.log(`[DocumentCache] IDB hit: page ${itemIndex + 1} (${this.idbHits} hits, ${this.idbMisses} misses)`);
            return idbEntry.blob;
          } else {
            this.idbMisses++;
          }
        } catch (err) {
          console.warn('[DocumentCache] IndexedDB get error:', err);
        }
      }
    }

    return null;
  }

  /**
   * Store a cached item
   * @param persistToIdb Whether to also persist to IndexedDB (default: true for thumbnails)
   */
  async set(
    docId: string,
    itemIndex: number,
    scale: number,
    blob: Blob,
    persistToIdb: boolean = true
  ): Promise<void> {
    const key = this.makeCacheKey(docId, itemIndex, scale);
    const size = blob.size;

    // Evict if necessary
    while (this.currentBytes + size > this.maxMemoryBytes && this.memoryCache.size > 0) {
      this.evictOldest();
    }

    const existing = this.memoryCache.get(key);
    if (existing) {
      this.currentBytes -= existing.blob.size;
    }

    this.memoryCache.set(key, { blob, timestamp: Date.now() });
    this.currentBytes += size;

    // Persist thumbnails to IndexedDB for cross-session caching
    const isThumbnail = Math.abs(scale - THUMBNAIL_SCALE) < 0.01;
    if (isThumbnail && persistToIdb) {
      const docHash = this.docHashMap.get(docId);
      if (docHash) {
        // Persist to IndexedDB in background (non-blocking)
        this.persistThumbnailToIdb(docHash, itemIndex, blob).catch((err) => {
          console.warn('[DocumentCache] IndexedDB persist error:', err);
        });
      }
    }
  }

  /**
   * Persist a thumbnail to IndexedDB
   */
  private async persistThumbnailToIdb(docHash: string, itemIndex: number, blob: Blob): Promise<void> {
    const idbCache = getThumbnailIdbCache();

    // Convert to WebP for better compression if not already WebP
    let persistBlob = blob;
    let width = 0;
    let height = 0;

    if (blob.type !== 'image/webp') {
      try {
        const bitmap = await createImageBitmap(blob);
        width = bitmap.width;
        height = bitmap.height;
        persistBlob = await imageToWebPBlob(bitmap, 0.8);
        bitmap.close();
      } catch {
        // If WebP conversion fails, store as-is
        width = 100; // Estimate
        height = 100;
      }
    } else {
      // Already WebP, get dimensions
      try {
        const bitmap = await createImageBitmap(blob);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close();
      } catch {
        width = 100;
        height = 100;
      }
    }

    // Pages are 1-indexed in IndexedDB
    await idbCache.set(docHash, itemIndex + 1, persistBlob, width, height);
  }

  async has(docId: string, itemIndex: number, scale: number): Promise<boolean> {
    const key = this.makeCacheKey(docId, itemIndex, scale);

    // Check memory first
    if (this.memoryCache.has(key)) {
      return true;
    }

    // For thumbnail scale, check IndexedDB
    const isThumbnail = Math.abs(scale - THUMBNAIL_SCALE) < 0.01;
    if (isThumbnail) {
      const docHash = this.docHashMap.get(docId);
      if (docHash) {
        try {
          const idbCache = getThumbnailIdbCache();
          return await idbCache.has(docHash, itemIndex + 1);
        } catch {
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Pre-warm memory cache from IndexedDB for a document
   * Called when document opens for instant thumbnail display
   *
   * Uses parallel batch retrieval (getMany) instead of sequential loop
   * to avoid blocking time-to-first-paint.
   */
  async warmFromIndexedDB(docId: string, docHash: string, pageCount: number): Promise<number> {
    this.setDocumentHash(docId, docHash);

    const startTime = performance.now();
    let warmed = 0;

    try {
      const idbCache = getThumbnailIdbCache();
      const cachedPages = await idbCache.getCachedPages(docHash);

      if (cachedPages.length === 0) {
        console.log(`[DocumentCache] No cached thumbnails for document ${docHash.slice(0, 8)}...`);
        return 0;
      }

      // Warm first 20 pages for initial view
      const pagesToWarm = cachedPages.slice(0, Math.min(20, pageCount));

      // Use batch retrieval for parallel IndexedDB reads instead of sequential loop
      // This significantly reduces warm time (20 sequential reads → 1 batch)
      const entries = await idbCache.getMany(docHash, pagesToWarm);

      // Process retrieved entries (memory cache writes are fast, don't need parallelization)
      for (const [page, entry] of entries) {
        // Pages are 1-indexed, items are 0-indexed
        const itemIndex = page - 1;
        await this.set(docId, itemIndex, THUMBNAIL_SCALE, entry.blob, false);
        warmed++;
      }

      const duration = performance.now() - startTime;
      console.log(
        `[DocumentCache] Warmed ${warmed}/${cachedPages.length} thumbnails from IndexedDB in ${duration.toFixed(0)}ms`
      );

      return warmed;
    } catch (err) {
      console.warn('[DocumentCache] IndexedDB warm error:', err);
      return 0;
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.memoryCache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.memoryCache.get(oldestKey);
      if (entry) {
        this.currentBytes -= entry.blob.size;
        this.memoryCache.delete(oldestKey);
      }
    }
  }

  clearDocument(docId: string): void {
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(`${docId}-`)) {
        const entry = this.memoryCache.get(key);
        if (entry) {
          this.currentBytes -= entry.blob.size;
        }
        this.memoryCache.delete(key);
      }
    }
    this.docHashMap.delete(docId);
  }

  clear(): void {
    this.memoryCache.clear();
    this.docHashMap.clear();
    this.currentBytes = 0;
    this.idbHits = 0;
    this.idbMisses = 0;
  }

  getStats(): {
    size: number;
    bytes: number;
    maxBytes: number;
    idbHits: number;
    idbMisses: number;
  } {
    return {
      size: this.memoryCache.size,
      bytes: this.currentBytes,
      maxBytes: this.maxMemoryBytes,
      idbHits: this.idbHits,
      idbMisses: this.idbMisses,
    };
  }
}

// ============================================================================
// Provider Implementation
// ============================================================================

export class HybridDocumentProvider {
  private config: Required<HybridDocumentProviderConfig>;
  private wasmBridge: DocumentBridge | null = null;
  private wasmAvailable = false;

  // Current document state
  private wasmDocumentId: string | null = null;
  private parsedDocument: ParsedDocument | null = null;
  private documentData: ArrayBuffer | null = null;

  // Caching
  private cache = new DocumentCache();

  // Prefetching
  private prefetchQueue: number[] = [];
  private isPrefetching = false;
  private isDestroyed = false;
  private lastPrefetchCenter = -1;

  /** Maximum prefetch queue size to prevent runaway background rendering */
  private static readonly MAX_PREFETCH_QUEUE_SIZE = 6;

  // RenderCoordinator for PDF tile management
  private renderCoordinator: RenderCoordinator | null = null;

  constructor(config: HybridDocumentProviderConfig = {}) {
    this.config = {
      pluginPath: config.pluginPath ?? '',
      enableCache: config.enableCache ?? true,
      enablePrefetch: config.enablePrefetch ?? true,
      prefetchCount: config.prefetchCount ?? 2,
    };
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Initialize the provider - initializes WASM bridge
   */
  async initialize(): Promise<void> {
    try {
      const startTime = performance.now();
      this.wasmBridge = await getSharedDocumentBridge();
      this.wasmAvailable = true;
      console.log(`[HybridDocumentProvider] WASM bridge initialized in ${(performance.now() - startTime).toFixed(1)}ms`);
    } catch (error) {
      console.warn('[HybridDocumentProvider] WASM initialization failed:', error);
      this.wasmAvailable = false;
      throw new Error('WASM document provider unavailable.');
    }
  }

  /**
   * Get current provider status
   */
  getStatus(): ProviderStatus {
    return {
      wasmAvailable: this.wasmAvailable,
      documentId: this.wasmDocumentId,
      format: this.parsedDocument?.format ?? null,
      itemCount: this.parsedDocument?.itemCount ?? 0,
    };
  }

  // ============================================================================
  // Document Loading
  // ============================================================================

  /**
   * Load a document from ArrayBuffer
   * @param data Document bytes
   * @param filename Optional filename for identification and format detection
   */
  async loadDocument(data: ArrayBuffer, filename?: string): Promise<ParsedDocument> {
    if (!this.wasmAvailable) {
      throw new Error('Provider not initialized. Call initialize() first.');
    }

    this.documentData = data;

    // Generate document hash BEFORE loading (for IndexedDB lookups)
    // This allows us to warm the cache while WASM loads
    const docHashPromise = generateDocumentHash(data);

    // Load via WASM
    const wasmResult = await this.loadDocumentToWasm(data, filename);
    if (wasmResult) {
      this.parsedDocument = wasmResult.document;
      this.wasmDocumentId = wasmResult.id;
      this.wasmDocumentId = wasmResult.id;

      // Get document hash (should be ready by now)
      const docHash = await docHashPromise;
      const docId = wasmResult.id;

      // Warm thumbnail cache from IndexedDB in background
      // This makes re-opens instant (~200ms instead of 4-5s)
      this.cache.warmFromIndexedDB(docId, docHash, this.parsedDocument.itemCount).catch((err) => {
        console.warn('[HybridDocumentProvider] IndexedDB warm failed:', err);
      });

      // Set up TileEngine for PDF documents (MUST await - updatePageDimensions needs this)
      if (this.parsedDocument.format === 'pdf') {
        try {
          await this.setupTileEngine();
        } catch (err) {
          console.warn('[HybridDocumentProvider] TileEngine setup failed:', err);
        }
        // Set up RenderCoordinator if it was already created before document load
        if (this.renderCoordinator) {
          this.setupRenderCoordinator();
        }
      }

      // Start background thumbnail generation (non-blocking)
      // This will use cached thumbnails if available, or generate new ones
      this.generateThumbnails(this.parsedDocument.itemCount).catch((err) => {
        console.warn('[HybridDocumentProvider] Thumbnail generation failed:', err);
      });

      return this.parsedDocument;
    }

    throw new Error('Failed to load document with any available provider');
  }

  /**
   * Load document into WASM bridge
   */
  private async loadDocumentToWasm(
    data: ArrayBuffer,
    filename?: string
  ): Promise<{ id: string; document: ParsedDocument } | null> {
    if (!this.wasmBridge || !this.wasmAvailable) {
      return null;
    }

    try {
      const startTime = performance.now();
      const result = await this.wasmBridge.loadDocumentWithId(data.slice(0), filename);
      this.wasmDocumentId = result.id;
      console.log(`[HybridDocumentProvider] WASM loaded (${result.document.itemCount} items) in ${(performance.now() - startTime).toFixed(1)}ms`);
      return result;
    } catch (error) {
      console.warn('[HybridDocumentProvider] WASM document load failed:', error);
      this.wasmDocumentId = null;
      return null;
    }
  }

  // ============================================================================
  // Rendering
  // ============================================================================

  /**
   * Render a document item (page or chapter) to Blob
   * @param itemIndex 0-indexed item number
   * @param options Render options
   */
  async renderItem(itemIndex: number, options?: RenderOptions): Promise<Blob> {
    if (!this.wasmDocumentId && !this.wasmDocumentId) {
      throw new Error('No document loaded');
    }

    // PERF FIX: Quantize scale to valid SCALE_TIERS for cache hits.
    // Arbitrary scales like 6.112... can't be cached and cause cache misses.
    const rawScale = Math.min(options?.scale ?? 1.5, 32.0); // Cap increased to max tier
    let scale: number = SCALE_TIERS[0];
    let prevTier: number = SCALE_TIERS[0];
    for (const tier of SCALE_TIERS) {
      if (tier >= rawScale) {
        const distToPrev = rawScale - prevTier;
        const distToCurrent = tier - rawScale;
        scale = distToCurrent < distToPrev ? tier : prevTier;
        break;
      }
      prevTier = tier;
      scale = tier; // Use max tier if rawScale exceeds all
    }

    // Check cache
    if (this.config.enableCache) {
      const docId = this.wasmDocumentId ?? this.wasmDocumentId!;
      const cached = await this.cache.get(docId, itemIndex, scale);
      if (cached) {
        // PERF FIX: Disable full-page prefetch. In tiled mode, tiles have their own
        // prefetch system (scroll strategy). Full-page prefetch causes worker starvation
        // by rendering pages 100+ away while user waits for visible tiles.
        // this.triggerPrefetch(itemIndex, scale);
        return cached;
      }
    }

    let blob: Blob;

    // Render via WASM
    if (this.wasmBridge && this.wasmDocumentId) {
      const startTime = performance.now();
      const result = await this.wasmBridge.renderItem(this.wasmDocumentId, itemIndex, scale);
      // Create a new Uint8Array to ensure proper ArrayBuffer type for Blob
      const data = new Uint8Array(result.data);
      blob = new Blob([data], { type: 'image/png' });
      console.log(`[HybridDocumentProvider] WASM rendered item ${itemIndex} @ ${scale}x in ${(performance.now() - startTime).toFixed(1)}ms`);
    } else {
      throw new Error('No rendering backend available');
    }

    // Cache result
    if (this.config.enableCache) {
      const docId = this.wasmDocumentId ?? this.wasmDocumentId!;
      await this.cache.set(docId, itemIndex, scale, blob);
    }

    // PERF FIX: Disable full-page prefetch. In tiled mode, tiles have their own
    // prefetch system (scroll strategy). Full-page prefetch causes worker starvation
    // by rendering pages 100+ away while user waits for visible tiles.
    // this.triggerPrefetch(itemIndex, scale);

    return blob;
  }

  /**
   * Render a tile of a document item
   */
  async renderTile(
    itemIndex: number,
    tileX: number,
    tileY: number,
    options?: TileRenderOptions
  ): Promise<Blob> {
    if (!this.wasmBridge || !this.wasmDocumentId) {
      throw new Error('WASM not available for tile rendering');
    }

    const scale = options?.scale ?? 1.5;
    const tileSize = options?.tileSize ?? 256;

    const result = await this.wasmBridge.renderTile(
      this.wasmDocumentId,
      itemIndex,
      tileX,
      tileY,
      tileSize,
      scale
    );

    // Create a new Uint8Array to ensure proper ArrayBuffer type for Blob
    const data = new Uint8Array(result.data);
    return new Blob([data], { type: 'image/png' });
  }

  // ============================================================================
  // Text Operations
  // ============================================================================

  /**
   * Get structured text with character positions
   */
  async getStructuredText(itemIndex: number): Promise<StructuredText> {
    if (!this.wasmDocumentId) {
      throw new Error('No document loaded');
    }

    if (this.wasmBridge && this.wasmDocumentId) {
      return this.wasmBridge.getStructuredText(this.wasmDocumentId, itemIndex);
    }

    throw new Error('No text extraction backend available');
  }

  /**
   * Search document
   */
  async search(query: string, limit: number = 50, includeContext: boolean = true): Promise<SearchResult[]> {
    if (!this.wasmDocumentId) {
      throw new Error('No document loaded');
    }

    if (this.wasmBridge && this.wasmDocumentId) {
      return this.wasmBridge.search(this.wasmDocumentId, query, limit, includeContext);
    }

    throw new Error('No search backend available');
  }

  // ============================================================================
  // EPUB-Specific Operations
  // ============================================================================

  /**
   * Get EPUB chapter XHTML content
   */
  async getEpubChapter(chapterIndex: number): Promise<string> {
    if (!this.parsedDocument || this.parsedDocument.format !== 'epub') {
      throw new Error('No EPUB document loaded');
    }

    if (this.wasmBridge && this.wasmDocumentId) {
      return this.wasmBridge.getEpubChapter(this.wasmDocumentId, chapterIndex);
    }

    throw new Error('No chapter content backend available');
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get item dimensions
   */
  async getItemDimensions(itemIndex: number): Promise<{ width: number; height: number }> {
    if (this.wasmBridge && this.wasmDocumentId) {
      const dims = await this.wasmBridge.getItemDimensions(this.wasmDocumentId, itemIndex);
      
      // DIAGNOSTIC: Log WASM dimensions for first page (amnesia-e4i)
      if (itemIndex === 0) {
        console.log(`[getItemDimensions] WASM returned: ${dims.width.toFixed(1)}x${dims.height.toFixed(1)} for page 0`);
      }
      
      return dims;
    }

    // DIAGNOSTIC: Log fallback usage (amnesia-e4i)
    console.warn(`[getItemDimensions] Using FALLBACK dimensions (no WASM): wasmBridge=${!!this.wasmBridge}, wasmDocId=${!!this.wasmDocumentId}`);
    
    // Default dimensions
    return { width: 612, height: 792 }; // US Letter at 72 DPI
  }

  /**
   * Get item count
   */
  getItemCount(): number {
    return this.parsedDocument?.itemCount ?? 0;
  }

  /**
   * Get parsed document metadata
   */
  getParsedDocument(): ParsedDocument | null {
    return this.parsedDocument;
  }

  /**
   * Get document format
   */
  getFormat(): DocumentFormat | null {
    return this.parsedDocument?.format ?? null;
  }

  /**
   * Check if WASM tile rendering is available
   */
  isTileRenderingAvailable(): boolean {
    return this.wasmAvailable && this.wasmDocumentId !== null;
  }

  // ============================================================================
  // Thumbnail Generation
  // ============================================================================

  /** Thumbnail scale factor (low-DPI for fast loading) */
  private static readonly THUMBNAIL_SCALE = 0.5; // 72 DPI equivalent

  /** Track if thumbnail generation is in progress */
  private isGeneratingThumbnails = false;

  /**
   * Generate thumbnails for all items in the background.
   * Uses a two-phase approach for perceived instant document open:
   *
   * Phase 1: First 20 items with minimal delay (critical for initial view)
   * Phase 2: Remaining items with yields to avoid UI blocking
   *
   * Benefits:
   * - Thumbnails are cached and available instantly when items come into view
   * - Never shows blank content - thumbnail is displayed while full-res loads
   * - First 20 items load fast for immediate perceived responsiveness
   * - Batched processing prevents memory spikes
   */
  async generateThumbnails(itemCount?: number): Promise<void> {
    if (this.isGeneratingThumbnails) {
      console.log('[HybridDocumentProvider] Thumbnail generation already in progress');
      return;
    }

    const docId = this.wasmDocumentId ?? this.wasmDocumentId;
    const count = itemCount ?? this.getItemCount();

    if (!docId || count === 0) {
      console.warn('[HybridDocumentProvider] Cannot generate thumbnails - no document loaded');
      return;
    }

    this.isGeneratingThumbnails = true;
    const startTime = performance.now();

    // PERF FIX: Sequential thumbnail generation to avoid blocking tile renders.
    //
    // Previous implementation used Promise.all to render 20 thumbnails in parallel,
    // which saturated the 4-worker pool and caused tiles to wait 9+ seconds.
    //
    // Now we render thumbnails sequentially with yields, giving priority to tiles.
    // This is slower for thumbnail generation but ensures tiles render smoothly.
    const BACKGROUND_BATCH = 1; // One at a time to minimize blocking
    const YIELD_DELAY_MS = 50; // Yield to let tiles render
    const thumbnailScale = HybridDocumentProvider.THUMBNAIL_SCALE;

    try {
      let generated = 0;

      // Render all thumbnails sequentially with yields
      for (let item = 0; item < count; item++) {
        // Check if we should stop (e.g., document changed)
        const currentDocId = this.wasmDocumentId ?? this.wasmDocumentId;
        if (this.isDestroyed || currentDocId !== docId) {
          console.log('[HybridDocumentProvider] Stopping thumbnail generation - document changed');
          break;
        }

        // Skip if already cached
        const isCached = await this.cache.has(docId, item, thumbnailScale);
        if (isCached) continue;

        try {
          await this.renderItem(item, { scale: thumbnailScale });
          generated++;
        } catch (err) {
          console.warn(`[HybridDocumentProvider] Thumbnail failed for item ${item}:`, err);
        }

        // Yield to let tiles render - critical for scrolling performance
        await new Promise((resolve) => setTimeout(resolve, YIELD_DELAY_MS));

        // Log progress every 20 items
        if ((item + 1) % 20 === 0) {
          console.log(
            `[HybridDocumentProvider] Thumbnail progress: ${item + 1}/${count} in ${(performance.now() - startTime).toFixed(0)}ms`
          );
        }
      }

      console.log(
        `[HybridDocumentProvider] Thumbnail generation complete: ${generated} thumbnails in ${(performance.now() - startTime).toFixed(0)}ms`
      );
    } finally {
      this.isGeneratingThumbnails = false;
    }
  }

  /**
   * Get a thumbnail for an item (low-scale cached version)
   * Returns null if thumbnail not yet generated
   */
  async getThumbnail(itemIndex: number): Promise<Blob | null> {
    const docId = this.wasmDocumentId ?? this.wasmDocumentId;
    if (!docId) return null;

    return this.cache.get(docId, itemIndex, HybridDocumentProvider.THUMBNAIL_SCALE);
  }

  /**
   * Check if a thumbnail exists for an item
   */
  async hasThumbnail(itemIndex: number): Promise<boolean> {
    const docId = this.wasmDocumentId ?? this.wasmDocumentId;
    if (!docId) return false;

    return this.cache.has(docId, itemIndex, HybridDocumentProvider.THUMBNAIL_SCALE);
  }

  /**
   * Render with dual-resolution strategy (never show blank).
   * Returns the best available cached version immediately,
   * with an optional upgrade promise for full quality.
   *
   * @param itemIndex Item to render (0-indexed)
   * @param options Render options
   * @returns Initial blob to display + optional upgrade promise
   */
  async renderItemWithFallback(
    itemIndex: number,
    options?: RenderOptions
  ): Promise<{
    initial: Blob;
    initialScale: number;
    isFullQuality: boolean;
    upgradePromise?: Promise<Blob>;
  }> {
    const docId = this.wasmDocumentId ?? this.wasmDocumentId;
    if (!docId) {
      throw new Error('No document loaded');
    }

    const requestedScale = options?.scale ?? 1.5;
    const thumbnailScale = HybridDocumentProvider.THUMBNAIL_SCALE;

    // 1. Check if we have full quality cached
    const fullCached = await this.cache.get(docId, itemIndex, requestedScale);
    if (fullCached) {
      return {
        initial: fullCached,
        initialScale: requestedScale,
        isFullQuality: true,
      };
    }

    // 2. Check if we have thumbnail cached
    const thumbnailCached = await this.cache.get(docId, itemIndex, thumbnailScale);
    if (thumbnailCached) {
      // Thumbnail exists - return it and start full fetch
      const upgradePromise = this.renderItem(itemIndex, options);
      return {
        initial: thumbnailCached,
        initialScale: thumbnailScale,
        isFullQuality: false,
        upgradePromise,
      };
    }

    // 3. Nothing cached - fetch thumbnail first for speed
    try {
      const thumbnail = await this.renderItem(itemIndex, { scale: thumbnailScale });
      const upgradePromise = this.renderItem(itemIndex, options);
      return {
        initial: thumbnail,
        initialScale: thumbnailScale,
        isFullQuality: false,
        upgradePromise,
      };
    } catch {
      // If thumbnail fails, just fetch full directly
      const fullBlob = await this.renderItem(itemIndex, options);
      return {
        initial: fullBlob,
        initialScale: requestedScale,
        isFullQuality: true,
      };
    }
  }

  // ============================================================================
  // TileEngine Integration (PDF-specific)
  // ============================================================================

  /**
   * Get page dimensions map for TileEngine setup (PDF only)
   */
  async getPageDimensionsMap(): Promise<Map<number, { width: number; height: number }>> {
    const dimensionsMap = new Map<number, { width: number; height: number }>();
    const itemCount = this.getItemCount();

    for (let i = 0; i < itemCount; i++) {
      const dims = await this.getItemDimensions(i);
      // TileEngine uses 1-indexed pages
      dimensionsMap.set(i + 1, dims);
      
      // DIAGNOSTIC: Log first page dimensions to trace source (amnesia-e4i)
      if (i === 0) {
        console.log(`[getPageDimensionsMap] page 1 dims: ${dims.width.toFixed(1)}x${dims.height.toFixed(1)}, hasWasmBridge=${!!this.wasmBridge}, wasmDocId=${this.wasmDocumentId?.slice(0,20)}`);
        if (dims.width < 500 || dims.height < 600) {
          console.warn(`[getPageDimensionsMap] WARNING: Layout dimensions!`);
          console.trace('[getPageDimensionsMap] Stack:');
        }
      }
    }

    return dimensionsMap;
  }

  /**
   * Get document ID for TileEngine
   */
  getDocumentId(): string | null {
    return this.wasmDocumentId ?? this.wasmDocumentId;
  }

  /**
   * Set up the TileEngine for PDF rendering.
   * Configures the shared TileEngine with document info and render callback.
   * Should be called after loading a PDF document.
   */
  async setupTileEngine(): Promise<void> {
    const docId = this.wasmDocumentId ?? this.wasmDocumentId;
    const format = this.getFormat();

    if (!docId || format !== 'pdf') {
      console.log('[HybridDocumentProvider] TileEngine setup skipped - not a PDF document');
      return;
    }

    const pageCount = this.getItemCount();
    if (pageCount === 0) {
      console.warn('[HybridDocumentProvider] TileEngine setup skipped - no pages');
      return;
    }

    // Get page dimensions for all pages
    const pageDimensions = await this.getPageDimensionsMap();

    // Configure the shared TileEngine
    const tileEngine = getTileEngine();
    tileEngine.setDocument(docId, pageCount, pageDimensions);
    tileEngine.setRenderCallback(async (tile: TileCoordinate, _docId: string) => {
      // Convert TileCoordinate to our renderTile format (0-indexed itemIndex)
      const itemIndex = tile.page - 1; // TileEngine uses 1-indexed pages
      // amnesia-e4i FIX: Pass tileSize from TileCoordinate to ensure render matches grid
      return this.renderTile(itemIndex, tile.tileX, tile.tileY, { 
        scale: tile.scale,
        tileSize: tile.tileSize,
      });
    });

    console.log(`[HybridDocumentProvider] TileEngine configured for ${pageCount} pages`);
  }

  /**
   * Create a tile render callback for external use (e.g., PdfRenderer).
   * Returns a callback function compatible with TileEngine.
   */
  createTileRenderCallback(): (tile: TileCoordinate, docId: string) => Promise<Blob> {
    return async (tile: TileCoordinate, _docId: string): Promise<Blob> => {
      const itemIndex = tile.page - 1; // TileEngine uses 1-indexed pages
      // amnesia-e4i FIX: Pass tileSize from TileCoordinate to ensure render matches grid
      return this.renderTile(itemIndex, tile.tileX, tile.tileY, { 
        scale: tile.scale,
        tileSize: tile.tileSize,
      });
    };
  }

  // ============================================================================
  // RenderCoordinator Integration
  // ============================================================================

  /**
   * Get the RenderCoordinator for PDF tile management.
   * Lazily initializes the coordinator. Callbacks are configured only if
   * a document is already loaded; otherwise they're set during loadDocument().
   */
  getRenderCoordinator(): RenderCoordinator {
    if (!this.renderCoordinator) {
      this.renderCoordinator = getRenderCoordinator();
      // Only setup if document is already loaded (avoids timing race)
      const docId = this.wasmDocumentId ?? this.wasmDocumentId;
      if (docId) {
        this.setupRenderCoordinator();
      }
    }
    return this.renderCoordinator;
  }

  /**
   * Set up the RenderCoordinator with render callbacks.
   * Called from getRenderCoordinator() if document is loaded, or from
   * loadDocument() after document is ready. Safe to call multiple times.
   */
  private setupRenderCoordinator(): void {
    if (!this.renderCoordinator) return;

    const docId = this.wasmDocumentId ?? this.wasmDocumentId;
    if (!docId) {
      // This shouldn't happen if callers check document state first
      console.warn('[HybridDocumentProvider] setupRenderCoordinator called without document');
      return;
    }

    // Set render callbacks
    this.renderCoordinator.setRenderCallbacks({
      renderTile: async (tile: TileCoordinate, _docId: string) => {
        const itemIndex = tile.page - 1; // Convert 1-indexed to 0-indexed
        // amnesia-e4i FIX: Pass tileSize from TileCoordinate to ensure render matches grid.
        // Without this, tiles render at 256px but grid uses 512px, causing seams.
        return this.renderTile(itemIndex, tile.tileX, tile.tileY, { 
          scale: tile.scale,
          tileSize: tile.tileSize,  // Pass through from TileCoordinate
        });
      },
      renderPage: async (page: number, scale: number, _docId: string) => {
        const itemIndex = page - 1; // Convert 1-indexed to 0-indexed
        // PERF FIX: Quantize scale to valid SCALE_TIERS for cache hits.
        // Arbitrary scales like 6.112... can't be cached and block tile renders.
        // Round to nearest valid tier using same logic as TileCacheManager.quantizeScale()
        let quantizedScale: number = SCALE_TIERS[0];
        let prevTier: number = SCALE_TIERS[0];
        for (const tier of SCALE_TIERS) {
          if (tier >= scale) {
            const distToPrev = scale - prevTier;
            const distToCurrent = tier - scale;
            quantizedScale = distToCurrent < distToPrev ? tier : prevTier;
            break;
          }
          prevTier = tier;
          quantizedScale = tier; // Use max tier if scale exceeds all
        }
        return this.renderItem(itemIndex, { scale: quantizedScale });
      },
    });

    // Set current document
    this.renderCoordinator.setDocument(docId);
    
    // Wire up content-type detection callbacks (amnesia-xlc fix)
    // These enable 60-80% faster rendering for scanned PDFs via JPEG extraction
    // and 30-50% faster for vector-heavy pages via scale optimization
    this.wireContentTypeCallbacks().catch((err) => {
      console.warn('[HybridDocumentProvider] Content-type callback setup failed:', err);
    });
    
    console.log(`[HybridDocumentProvider] RenderCoordinator configured for document ${docId}`);
  }
  
  /**
   * Wire up content-type detection callbacks from MuPDF bridge.
   * 
   * The PooledMuPDFBridge has classifyPage/extractJpeg methods that enable:
   * - JPEG extraction for scanned PDFs (60-80% faster)
   * - Vector scale optimization (30-50% faster)
   * 
   * This was identified as NOT RUNNING in amnesia-xlc - the callbacks were never set.
   * 
   * IMPORTANT: The document must be loaded into the PooledMuPDFBridge for classification
   * to work. This is separate from the DocumentBridge used for rendering.
   */
  private async wireContentTypeCallbacks(): Promise<void> {
    if (!this.renderCoordinator) return;
    
    const docId = this.wasmDocumentId;
    const docData = this.documentData;
    
    if (!docId || !docData) {
      console.warn('[HybridDocumentProvider] Cannot wire content-type callbacks - no document loaded');
      return;
    }
    
    try {
      const bridge = await getSharedMuPDFBridge();
      
      // Check if bridge supports content-type detection (PooledMuPDFBridge)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pooledBridge = bridge as any;
      if (typeof pooledBridge.classifyPage !== 'function' || 
          typeof pooledBridge.extractJpeg !== 'function') {
        console.log('[HybridDocumentProvider] MuPDF bridge does not support content-type detection (single-worker mode)');
        return;
      }
      
      // Load document into the pooled bridge for classification
      // This is necessary because PooledMuPDFBridge has its own document store
      // separate from DocumentBridge used for rendering
      if (typeof pooledBridge.loadDocumentOnAllWorkers === 'function') {
        console.log(`[HybridDocumentProvider] Loading document ${docId} into worker pool for classification...`);
        await pooledBridge.loadDocumentOnAllWorkers(docId, docData.slice(0));
        console.log(`[HybridDocumentProvider] Document loaded into worker pool successfully`);
      } else {
        console.warn('[HybridDocumentProvider] Worker pool does not support loadDocumentOnAllWorkers');
        return;
      }
      
      // Set the callbacks
      this.renderCoordinator.setContentTypeCallbacks({
        classifyPage: async (classifyDocId: string, pageNum: number): Promise<PageClassification> => {
          const result = await pooledBridge.classifyPage(classifyDocId, pageNum);
          return result as PageClassification;
        },
        extractJpeg: async (extractDocId: string, pageNum: number): Promise<{ data: Uint8Array; width: number; height: number }> => {
          return pooledBridge.extractJpeg(extractDocId, pageNum);
        },
      });
      
      // Enable content-type detection
      this.renderCoordinator.setContentTypeDetectionEnabled(true);
      
      console.log('[HybridDocumentProvider] Content-type detection callbacks wired successfully');
    } catch (err) {
      console.warn('[HybridDocumentProvider] Failed to wire content-type callbacks:', err);
    }
  }

  // ============================================================================
  // Prefetching
  // ============================================================================

  /**
   * Trigger prefetch of adjacent items.
   *
   * PERF FIX: Clear stale queue items when user navigates far.
   * This prevents runaway prefetching of pages 100+ away while user waits.
   */
  private triggerPrefetch(currentItem: number, scale: number): void {
    if (!this.config.enablePrefetch) return;

    const itemCount = this.getItemCount();

    // PERF FIX: If user jumped far (>10 pages), clear the stale queue
    // This prevents rendering pages 300+ when user is viewing page 20
    if (this.lastPrefetchCenter >= 0 && Math.abs(currentItem - this.lastPrefetchCenter) > 10) {
      this.prefetchQueue = [];
    }
    this.lastPrefetchCenter = currentItem;

    // PERF FIX: Prune queue items that are now far from current position
    // Only keep items within ±5 pages of current view
    const MAX_DISTANCE = 5;
    this.prefetchQueue = this.prefetchQueue.filter(
      item => Math.abs(item - currentItem) <= MAX_DISTANCE
    );

    const toFetch: number[] = [];

    for (let i = 1; i <= this.config.prefetchCount; i++) {
      if (currentItem + i < itemCount) toFetch.push(currentItem + i);
      if (currentItem - i >= 0) toFetch.push(currentItem - i);
    }

    for (const item of toFetch) {
      if (!this.prefetchQueue.includes(item)) {
        // PERF FIX: Enforce queue size limit
        if (this.prefetchQueue.length >= HybridDocumentProvider.MAX_PREFETCH_QUEUE_SIZE) {
          break;
        }
        this.prefetchQueue.push(item);
      }
    }

    this.processPrefetchQueue(scale);
  }

  /**
   * Process prefetch queue.
   *
   * PERF FIX: Skip items that are now stale (far from current view).
   * Each render takes 800-1000ms, during which user may have navigated.
   */
  private async processPrefetchQueue(scale: number): Promise<void> {
    if (this.isPrefetching || this.prefetchQueue.length === 0) return;

    this.isPrefetching = true;

    // PERF FIX: Quantize scale to valid SCALE_TIERS for cache hits.
    let quantizedScale: number = scale;
    let prevTier: number = SCALE_TIERS[0];
    for (const tier of SCALE_TIERS) {
      if (tier >= scale) {
        const distToPrev = scale - prevTier;
        const distToCurrent = tier - scale;
        quantizedScale = distToCurrent < distToPrev ? tier : prevTier;
        break;
      }
      prevTier = tier;
      quantizedScale = tier; // Use max tier if scale exceeds all
    }

    while (this.prefetchQueue.length > 0 && !this.isDestroyed) {
      const item = this.prefetchQueue.shift()!;
      const docId = this.wasmDocumentId ?? this.wasmDocumentId;

      if (!docId) break;

      // PERF FIX: Skip items that are now far from user's current position
      // This handles cases where user navigated during a previous long render
      if (this.lastPrefetchCenter >= 0 && Math.abs(item - this.lastPrefetchCenter) > 10) {
        continue; // Skip stale item
      }

      try {
        const isCached = await this.cache.has(docId, item, quantizedScale);
        if (!isCached) {
          await this.renderItem(item, { scale: quantizedScale });
          // Reduce log spam - only log if verbose debugging needed
          // console.log(`[HybridDocumentProvider] Prefetched item ${item}`);
        }
      } catch (error) {
        console.warn(`[HybridDocumentProvider] Prefetch failed for item ${item}:`, error);
      }

      // Yield to prevent blocking
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    this.isPrefetching = false;
  }

  // ============================================================================
  // PdfContentProvider Adapter (for PdfRenderer compatibility)
  // ============================================================================

  /**
   * Create a PdfContentProvider adapter for use with PdfRenderer.
   *
   * @returns PdfContentProvider-compatible object with additional methods
   */
  createPdfContentAdapter(): PdfContentProvider & {
    renderTile?: (tile: TileCoordinate) => Promise<Blob>;
    isTileRenderingAvailable?: () => boolean;
    getRenderCoordinator?: () => RenderCoordinator;
    getPdfSvgTextLayer?: (id: string, page: number) => Promise<string>;
  } {
    const provider = this;

    return {
      async getPdf(_id: string): Promise<ParsedPdf> {
        if (!provider.parsedDocument) {
          throw new Error('No document loaded');
        }
        return provider.toParsedPdf(provider.parsedDocument);
      },

      async uploadPdf(data: ArrayBuffer, filename?: string): Promise<ParsedPdf> {
        const doc = await provider.loadDocument(data, filename);
        return provider.toParsedPdf(doc);
      },

      async getPdfPage(_id: string, page: number, options?: { scale?: number; format?: string }): Promise<Blob> {
        // PdfRenderer uses 1-indexed pages, our API uses 0-indexed
        const itemIndex = page - 1;
        // PERF FIX: Quantize scale to valid SCALE_TIERS for cache hits.
        let quantizedScale: number | undefined = options?.scale;
        if (quantizedScale !== undefined) {
          let prevTier: number = SCALE_TIERS[0];
          for (const tier of SCALE_TIERS) {
            if (tier >= quantizedScale) {
              const distToPrev = quantizedScale - prevTier;
              const distToCurrent = tier - quantizedScale;
              quantizedScale = distToCurrent < distToPrev ? tier : prevTier;
              break;
            }
            prevTier = tier;
            if (tier === SCALE_TIERS[SCALE_TIERS.length - 1]) {
              quantizedScale = tier; // Use max tier if scale exceeds all
            }
          }
        }
        return provider.renderItem(itemIndex, {
          scale: quantizedScale,
          format: options?.format as 'png' | 'jpeg' | 'webp' | undefined,
        });
      },

      async getPdfTextLayer(_id: string, page: number): Promise<PdfTextLayerData> {
        const itemIndex = page - 1;
        const structuredText = await provider.getStructuredText(itemIndex);
        return provider.toPdfTextLayer(structuredText, page);
      },

      async searchPdf(_id: string, query: string, limit?: number): Promise<Array<{
        page: number;
        text: string;
        prefix?: string;
        suffix?: string;
      }>> {
        const results = await provider.search(query, limit ?? 50, true);
        return results.map((r) => ({
          page: r.page, // SearchResult already uses 1-indexed pages
          text: r.text,
          prefix: r.context?.prefix,
          suffix: r.context?.suffix,
        }));
      },

      // Tile rendering methods
      renderTile: async (tile: TileCoordinate): Promise<Blob> => {
        const itemIndex = tile.page - 1;
        // amnesia-e4i FIX: Pass tileSize from TileCoordinate to ensure render matches grid
        return provider.renderTile(itemIndex, tile.tileX, tile.tileY, { 
          scale: tile.scale,
          tileSize: tile.tileSize,
        });
      },

      isTileRenderingAvailable: () => provider.isTileRenderingAvailable(),

      getRenderCoordinator: () => provider.getRenderCoordinator(),

      async getPdfSvgTextLayer(_id: string, _page: number): Promise<string> {
        // SVG text layer not implemented - use standard text layer
        return '';
      },
    };
  }

  /**
   * Convert ParsedDocument to ParsedPdf format
   */
  private toParsedPdf(doc: ParsedDocument): ParsedPdf {
    // Convert ToC entries from document-worker format to types format
    // document-worker.TocEntry has: title, page, level, children
    // types.TocEntry expects: id, label, href, children (non-optional array)
    type DocWorkerTocEntry = typeof doc.toc[number];
    const convertToc = (entries: DocWorkerTocEntry[]): TocEntry[] => {
      return entries.map((entry, idx) => ({
        id: `toc-${idx}-p${entry.page}`,
        label: entry.title,
        href: `#page=${entry.page}`, // Generate href from page number
        children: entry.children ? convertToc(entry.children) : [],
      }));
    };

    return {
      id: doc.id,
      metadata: {
        title: doc.metadata?.title ?? 'Untitled',
        author: doc.metadata?.author,
        keywords: [],
      },
      toc: convertToc(doc.toc),
      pageCount: doc.itemCount,
      hasTextLayer: doc.hasTextLayer,
      orientation: 'portrait', // Default - could be calculated from dimensions
    };
  }

  /**
   * Convert StructuredText to PdfTextLayerData format
   */
  private toPdfTextLayer(text: StructuredText, page: number): PdfTextLayerData {
    return {
      page,
      width: text.width ?? 612,
      height: text.height ?? 792,
      items: text.items?.map((item) => ({
        text: item.text,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        fontSize: item.fontSize,
        charPositions: item.charPositions?.map((c) => ({
          char: c.char,
          x: c.x,
          y: c.y,
          width: c.width,
          height: c.height,
          fontSize: c.fontSize,
          fontName: c.fontName,
        })),
      })) ?? [],
    };
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Clear cache for current document
   */
  async clearCache(): Promise<void> {
    const docId = this.wasmDocumentId ?? this.wasmDocumentId;
    if (docId) {
      this.cache.clearDocument(docId);
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; bytes: number; maxBytes: number } {
    return this.cache.getStats();
  }

  /**
   * Destroy the provider and release resources
   */
  async destroy(): Promise<void> {
    this.isDestroyed = true;
    this.prefetchQueue = [];

    // Unload WASM document
    if (this.wasmBridge && this.wasmDocumentId) {
      await this.wasmBridge.unloadDocument(this.wasmDocumentId);
    }

    // Clear cache
    this.cache.clear();

    this.wasmDocumentId = null;
    this.parsedDocument = null;
    this.documentData = null;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a hybrid document provider with default configuration
 */
export function createHybridDocumentProvider(
  config?: HybridDocumentProviderConfig
): HybridDocumentProvider {
  return new HybridDocumentProvider(config);
}

/**
 * Destroy shared document bridge (call on plugin unload)
 */
export function destroySharedResources(): void {
  destroySharedDocumentBridge();
}

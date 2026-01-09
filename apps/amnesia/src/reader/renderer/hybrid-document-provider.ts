/**
 * Hybrid Document Provider
 *
 * Unified provider for PDF and EPUB document handling, combining server and WASM capabilities.
 * Provides a single interface for loading, rendering, and searching across both document formats.
 *
 * Features:
 * - Format-agnostic document operations
 * - Automatic server/WASM mode selection
 * - Two-tier caching (Memory + IndexedDB)
 * - Prefetching for adjacent pages/chapters
 * - Offline support via WASM
 *
 * @example
 * ```typescript
 * const provider = new HybridDocumentProvider({
 *   serverBaseUrl: 'http://localhost:3000',
 * });
 *
 * await provider.initialize();
 * const doc = await provider.loadDocument(pdfOrEpubData, 'document.pdf');
 * const pageBlob = await provider.renderItem(doc.id, 0, { scale: 1.5 });
 * ```
 */

import { ApiClient, getApiClient } from './api-client';
import { DocumentBridge, getSharedDocumentBridge, destroySharedDocumentBridge } from './document-bridge';
import type { ParsedDocument, StructuredText, SearchResult, DocumentFormat } from './document-worker';
import { getTileEngine, type TileCoordinate } from './pdf/tile-render-engine';
import { getRenderCoordinator, type RenderCoordinator } from './pdf/render-coordinator';
import type { ParsedPdf, PdfTextLayerData, TocEntry } from './types';
import type { PdfContentProvider } from './pdf/pdf-renderer';

// ============================================================================
// Types
// ============================================================================

export type ProviderMode = 'server' | 'wasm' | 'auto';

export interface HybridDocumentProviderConfig {
  /** Server base URL */
  serverBaseUrl?: string;
  /**
   * Preferred provider mode:
   * - 'server': Use server for all operations
   * - 'wasm': Use local WASM for operations (faster, offline capable)
   * - 'auto': Use WASM if available, fallback to server
   */
  preferMode?: ProviderMode;
  /** Timeout for server health check in ms */
  healthCheckTimeout?: number;
  /** Device ID for server requests */
  deviceId?: string;
  /** Enable caching (default: true) */
  enableCache?: boolean;
  /** Enable prefetching (default: true) */
  enablePrefetch?: boolean;
  /** Number of items to prefetch ahead/behind (default: 2) */
  prefetchCount?: number;
  /** Enable WASM rendering when available (default: true) */
  enableWasm?: boolean;
}

export interface ProviderStatus {
  activeMode: 'server' | 'wasm';
  serverAvailable: boolean;
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

// ============================================================================
// Cache Implementation
// ============================================================================

interface CacheEntry {
  blob: Blob;
  timestamp: number;
}

class DocumentCache {
  private memoryCache = new Map<string, CacheEntry>();
  private maxMemoryEntries = 100;
  private maxMemoryBytes = 100 * 1024 * 1024; // 100MB
  private currentBytes = 0;

  private makeCacheKey(docId: string, itemIndex: number, scale: number): string {
    return `${docId}-${itemIndex}-${scale.toFixed(2)}`;
  }

  async get(docId: string, itemIndex: number, scale: number): Promise<Blob | null> {
    const key = this.makeCacheKey(docId, itemIndex, scale);
    const entry = this.memoryCache.get(key);
    return entry?.blob ?? null;
  }

  async set(docId: string, itemIndex: number, scale: number, blob: Blob): Promise<void> {
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
  }

  async has(docId: string, itemIndex: number, scale: number): Promise<boolean> {
    const key = this.makeCacheKey(docId, itemIndex, scale);
    return this.memoryCache.has(key);
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
  }

  clear(): void {
    this.memoryCache.clear();
    this.currentBytes = 0;
  }

  getStats(): { size: number; bytes: number; maxBytes: number } {
    return {
      size: this.memoryCache.size,
      bytes: this.currentBytes,
      maxBytes: this.maxMemoryBytes,
    };
  }
}

// ============================================================================
// Provider Implementation
// ============================================================================

export class HybridDocumentProvider {
  private config: Required<HybridDocumentProviderConfig>;
  private apiClient: ApiClient | null = null;
  private serverAvailable = false;
  private wasmBridge: DocumentBridge | null = null;
  private wasmAvailable = false;

  // Current document state
  private documentId: string | null = null;
  private wasmDocumentId: string | null = null;
  private parsedDocument: ParsedDocument | null = null;
  private documentData: ArrayBuffer | null = null;

  // Caching
  private cache = new DocumentCache();

  // Prefetching
  private prefetchQueue: number[] = [];
  private isPrefetching = false;
  private isDestroyed = false;

  // RenderCoordinator for PDF tile management (Phase 1: HybridPdfProvider migration)
  private renderCoordinator: RenderCoordinator | null = null;

  constructor(config: HybridDocumentProviderConfig = {}) {
    this.config = {
      serverBaseUrl: config.serverBaseUrl ?? '',
      preferMode: config.preferMode ?? 'auto',
      healthCheckTimeout: config.healthCheckTimeout ?? 5000,
      deviceId: config.deviceId ?? 'document-provider',
      enableCache: config.enableCache ?? true,
      enablePrefetch: config.enablePrefetch ?? true,
      prefetchCount: config.prefetchCount ?? 2,
      enableWasm: config.enableWasm ?? true,
    };
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Initialize the provider - checks server and WASM availability
   */
  async initialize(): Promise<void> {
    // Initialize WASM bridge if enabled
    if (this.config.enableWasm) {
      try {
        const startTime = performance.now();
        this.wasmBridge = await getSharedDocumentBridge();
        this.wasmAvailable = true;
        console.log(`[HybridDocumentProvider] WASM bridge initialized in ${(performance.now() - startTime).toFixed(1)}ms`);
      } catch (error) {
        console.warn('[HybridDocumentProvider] WASM initialization failed:', error);
        this.wasmAvailable = false;
      }
    }

    // Check server availability
    if (await this.checkServerHealth()) {
      this.apiClient = getApiClient();
    } else if (!this.wasmAvailable) {
      throw new Error('No document provider available. Both server and WASM are unavailable.');
    } else {
      console.log('[HybridDocumentProvider] Server unavailable, using WASM-only mode');
    }
  }

  /**
   * Check if server is available
   */
  private async checkServerHealth(): Promise<boolean> {
    if (!this.config.serverBaseUrl) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.healthCheckTimeout);

      const response = await fetch(`${this.config.serverBaseUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);
      this.serverAvailable = response.ok;
      return this.serverAvailable;
    } catch {
      this.serverAvailable = false;
      return false;
    }
  }

  /**
   * Get current provider status
   */
  getStatus(): ProviderStatus {
    return {
      activeMode: this.shouldUseWasm() ? 'wasm' : 'server',
      serverAvailable: this.serverAvailable,
      wasmAvailable: this.wasmAvailable,
      documentId: this.documentId ?? this.wasmDocumentId,
      format: this.parsedDocument?.format ?? null,
      itemCount: this.parsedDocument?.itemCount ?? 0,
    };
  }

  /**
   * Check if WASM should be used
   */
  private shouldUseWasm(): boolean {
    if (!this.config.enableWasm || !this.wasmAvailable) return false;
    if (this.config.preferMode === 'wasm') return true;
    if (this.config.preferMode === 'auto') return true;
    return false;
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
    if (!this.apiClient && !this.wasmAvailable) {
      throw new Error('Provider not initialized. Call initialize() first.');
    }

    this.documentData = data;

    // Load into WASM in parallel
    const wasmLoadPromise = this.loadDocumentToWasm(data, filename);

    // Try server if available
    if (this.apiClient && this.serverAvailable) {
      try {
        // Use unified documents API
        const response = await fetch(`${this.config.serverBaseUrl}/api/v1/documents`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Document-Filename': filename ?? 'document',
          },
          body: data,
        });

        if (response.ok) {
          const result = await response.json();
          this.parsedDocument = {
            id: result.id,
            format: result.format,
            metadata: result.metadata,
            toc: result.toc ?? [],
            itemCount: result.item_count,
            hasTextLayer: result.has_text_layer,
          };
          this.documentId = result.id;
          console.log('[HybridDocumentProvider] Loaded via server:', result.id);

          // Wait for WASM load to complete
          await wasmLoadPromise;

          // Set up TileEngine for PDF documents (non-blocking)
          if (this.parsedDocument.format === 'pdf') {
            this.setupTileEngine().catch((err) => {
              console.warn('[HybridDocumentProvider] TileEngine setup failed:', err);
            });
            // Set up RenderCoordinator if it was already created before document load
            if (this.renderCoordinator) {
              this.setupRenderCoordinator();
            }
          }

          // Start background thumbnail generation (non-blocking)
          this.generateThumbnails(this.parsedDocument.itemCount).catch((err) => {
            console.warn('[HybridDocumentProvider] Thumbnail generation failed:', err);
          });

          return this.parsedDocument;
        }
      } catch (error) {
        console.warn('[HybridDocumentProvider] Server load failed:', error);
      }
    }

    // Fallback to WASM-only
    const wasmResult = await wasmLoadPromise;
    if (wasmResult) {
      this.parsedDocument = wasmResult.document;
      this.wasmDocumentId = wasmResult.id;
      this.documentId = wasmResult.id;

      // Set up TileEngine for PDF documents (non-blocking)
      if (this.parsedDocument.format === 'pdf') {
        this.setupTileEngine().catch((err) => {
          console.warn('[HybridDocumentProvider] TileEngine setup failed:', err);
        });
        // Set up RenderCoordinator if it was already created before document load
        if (this.renderCoordinator) {
          this.setupRenderCoordinator();
        }
      }

      // Start background thumbnail generation (non-blocking)
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
    if (!this.documentId && !this.wasmDocumentId) {
      throw new Error('No document loaded');
    }

    const scale = Math.min(options?.scale ?? 1.5, 12.0);

    // Check cache
    if (this.config.enableCache) {
      const docId = this.documentId ?? this.wasmDocumentId!;
      const cached = await this.cache.get(docId, itemIndex, scale);
      if (cached) {
        this.triggerPrefetch(itemIndex, scale);
        return cached;
      }
    }

    let blob: Blob;

    // Use WASM if available
    if (this.shouldUseWasm() && this.wasmBridge && this.wasmDocumentId) {
      const startTime = performance.now();
      const result = await this.wasmBridge.renderItem(this.wasmDocumentId, itemIndex, scale);
      // Create a new Uint8Array to ensure proper ArrayBuffer type for Blob
      const data = new Uint8Array(result.data);
      blob = new Blob([data], { type: 'image/png' });
      console.log(`[HybridDocumentProvider] WASM rendered item ${itemIndex} @ ${scale}x in ${(performance.now() - startTime).toFixed(1)}ms`);
    } else if (this.apiClient && this.documentId) {
      // Fallback to server
      const response = await fetch(
        `${this.config.serverBaseUrl}/api/v1/documents/${this.documentId}/items/${itemIndex}/render?scale=${scale}`
      );
      if (!response.ok) {
        throw new Error(`Server render failed: ${response.statusText}`);
      }
      blob = await response.blob();
    } else {
      throw new Error('No rendering backend available');
    }

    // Cache result
    if (this.config.enableCache) {
      const docId = this.documentId ?? this.wasmDocumentId!;
      await this.cache.set(docId, itemIndex, scale, blob);
    }

    // Trigger prefetch
    this.triggerPrefetch(itemIndex, scale);

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
    if (!this.documentId && !this.wasmDocumentId) {
      throw new Error('No document loaded');
    }

    // Prefer WASM for accurate character positions
    if (this.shouldUseWasm() && this.wasmBridge && this.wasmDocumentId) {
      return this.wasmBridge.getStructuredText(this.wasmDocumentId, itemIndex);
    }

    // Fallback to server
    if (this.apiClient && this.documentId) {
      const response = await fetch(
        `${this.config.serverBaseUrl}/api/v1/documents/${this.documentId}/items/${itemIndex}/text`
      );
      if (!response.ok) {
        throw new Error(`Server text extraction failed: ${response.statusText}`);
      }
      return response.json();
    }

    throw new Error('No text extraction backend available');
  }

  /**
   * Search document
   */
  async search(query: string, limit: number = 50, includeContext: boolean = true): Promise<SearchResult[]> {
    if (!this.documentId && !this.wasmDocumentId) {
      throw new Error('No document loaded');
    }

    // Use WASM for search
    if (this.shouldUseWasm() && this.wasmBridge && this.wasmDocumentId) {
      return this.wasmBridge.search(this.wasmDocumentId, query, limit, includeContext);
    }

    // Fallback to server
    if (this.apiClient && this.documentId) {
      const params = new URLSearchParams({
        query,
        limit: String(limit),
        include_context: String(includeContext),
      });
      const response = await fetch(
        `${this.config.serverBaseUrl}/api/v1/documents/${this.documentId}/search?${params}`
      );
      if (!response.ok) {
        throw new Error(`Server search failed: ${response.statusText}`);
      }
      return response.json();
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

    // Server fallback
    if (this.apiClient && this.documentId) {
      const response = await fetch(
        `${this.config.serverBaseUrl}/api/v1/documents/${this.documentId}/items/${chapterIndex}/content`
      );
      if (!response.ok) {
        throw new Error(`Server chapter fetch failed: ${response.statusText}`);
      }
      return response.text();
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
      return this.wasmBridge.getItemDimensions(this.wasmDocumentId, itemIndex);
    }

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

    const docId = this.documentId ?? this.wasmDocumentId;
    const count = itemCount ?? this.getItemCount();

    if (!docId || count === 0) {
      console.warn('[HybridDocumentProvider] Cannot generate thumbnails - no document loaded');
      return;
    }

    this.isGeneratingThumbnails = true;
    const startTime = performance.now();

    // Two-phase thumbnail generation
    const IMMEDIATE_BATCH = 20; // First 20 for instant perceived load
    const BACKGROUND_BATCH = 5; // Rest in smaller batches with yields
    const thumbnailScale = HybridDocumentProvider.THUMBNAIL_SCALE;

    try {
      let generated = 0;

      // PHASE 1: First batch without yields for immediate availability
      if (count > 0) {
        const phase1End = Math.min(IMMEDIATE_BATCH, count);
        await Promise.all(
          Array.from({ length: phase1End }, (_, i) => i).map(async (item) => {
            // Skip if already cached
            const isCached = await this.cache.has(docId, item, thumbnailScale);
            if (isCached) return;

            try {
              await this.renderItem(item, { scale: thumbnailScale });
              generated++;
            } catch (err) {
              console.warn(`[HybridDocumentProvider] Thumbnail failed for item ${item}:`, err);
            }
          })
        );
        console.log(
          `[HybridDocumentProvider] Phase 1 complete: ${generated} thumbnails in ${(performance.now() - startTime).toFixed(0)}ms`
        );
      }

      // PHASE 2: Remaining items with yields to avoid UI blocking
      for (let i = IMMEDIATE_BATCH; i < count; i += BACKGROUND_BATCH) {
        // Check if we should stop (e.g., document changed)
        const currentDocId = this.documentId ?? this.wasmDocumentId;
        if (this.isDestroyed || currentDocId !== docId) {
          console.log('[HybridDocumentProvider] Stopping thumbnail generation - document changed');
          break;
        }

        const batchEnd = Math.min(i + BACKGROUND_BATCH, count);
        const batch: number[] = [];

        // Build batch of items that need thumbnails
        for (let item = i; item < batchEnd; item++) {
          const isCached = await this.cache.has(docId, item, thumbnailScale);
          if (!isCached) {
            batch.push(item);
          }
        }

        // Render batch
        for (const item of batch) {
          try {
            await this.renderItem(item, { scale: thumbnailScale });
            generated++;
          } catch (err) {
            console.warn(`[HybridDocumentProvider] Thumbnail failed for item ${item}:`, err);
          }
        }

        // Yield to UI thread
        await new Promise((resolve) => setTimeout(resolve, 0));
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
    const docId = this.documentId ?? this.wasmDocumentId;
    if (!docId) return null;

    return this.cache.get(docId, itemIndex, HybridDocumentProvider.THUMBNAIL_SCALE);
  }

  /**
   * Check if a thumbnail exists for an item
   */
  async hasThumbnail(itemIndex: number): Promise<boolean> {
    const docId = this.documentId ?? this.wasmDocumentId;
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
    const docId = this.documentId ?? this.wasmDocumentId;
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
    }

    return dimensionsMap;
  }

  /**
   * Get document ID for TileEngine
   */
  getDocumentId(): string | null {
    return this.documentId ?? this.wasmDocumentId;
  }

  /**
   * Set up the TileEngine for PDF rendering.
   * Configures the shared TileEngine with document info and render callback.
   * Should be called after loading a PDF document.
   */
  async setupTileEngine(): Promise<void> {
    const docId = this.documentId ?? this.wasmDocumentId;
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
      return this.renderTile(itemIndex, tile.tileX, tile.tileY, { scale: tile.scale });
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
      return this.renderTile(itemIndex, tile.tileX, tile.tileY, { scale: tile.scale });
    };
  }

  // ============================================================================
  // RenderCoordinator Integration (Phase 1: HybridPdfProvider migration)
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
      const docId = this.documentId ?? this.wasmDocumentId;
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

    const docId = this.documentId ?? this.wasmDocumentId;
    if (!docId) {
      // This shouldn't happen if callers check document state first
      console.warn('[HybridDocumentProvider] setupRenderCoordinator called without document');
      return;
    }

    // Set render callbacks
    this.renderCoordinator.setRenderCallbacks({
      renderTile: async (tile: TileCoordinate, _docId: string) => {
        const itemIndex = tile.page - 1; // Convert 1-indexed to 0-indexed
        return this.renderTile(itemIndex, tile.tileX, tile.tileY, { scale: tile.scale });
      },
      renderPage: async (page: number, scale: number, _docId: string) => {
        const itemIndex = page - 1; // Convert 1-indexed to 0-indexed
        return this.renderItem(itemIndex, { scale });
      },
    });

    // Set current document
    this.renderCoordinator.setDocument(docId);
    console.log(`[HybridDocumentProvider] RenderCoordinator configured for document ${docId}`);
  }

  // ============================================================================
  // Prefetching
  // ============================================================================

  /**
   * Trigger prefetch of adjacent items
   */
  private triggerPrefetch(currentItem: number, scale: number): void {
    if (!this.config.enablePrefetch) return;

    const itemCount = this.getItemCount();
    const toFetch: number[] = [];

    for (let i = 1; i <= this.config.prefetchCount; i++) {
      if (currentItem + i < itemCount) toFetch.push(currentItem + i);
      if (currentItem - i >= 0) toFetch.push(currentItem - i);
    }

    for (const item of toFetch) {
      if (!this.prefetchQueue.includes(item)) {
        this.prefetchQueue.push(item);
      }
    }

    this.processPrefetchQueue(scale);
  }

  /**
   * Process prefetch queue
   */
  private async processPrefetchQueue(scale: number): Promise<void> {
    if (this.isPrefetching || this.prefetchQueue.length === 0) return;

    this.isPrefetching = true;

    while (this.prefetchQueue.length > 0 && !this.isDestroyed) {
      const item = this.prefetchQueue.shift()!;
      const docId = this.documentId ?? this.wasmDocumentId;

      if (!docId) break;

      try {
        const isCached = await this.cache.has(docId, item, scale);
        if (!isCached) {
          const blob = await this.renderItem(item, { scale });
          console.log(`[HybridDocumentProvider] Prefetched item ${item}`);
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
   * This allows HybridDocumentProvider to be used as a drop-in replacement
   * for HybridPdfProvider in ServerReaderContainer.
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
        return provider.renderItem(itemIndex, {
          scale: options?.scale,
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
        return provider.renderTile(itemIndex, tile.tileX, tile.tileY, { scale: tile.scale });
      },

      isTileRenderingAvailable: () => provider.isTileRenderingAvailable(),

      // RenderCoordinator for PDF tile management (Phase 1 addition)
      getRenderCoordinator: () => provider.getRenderCoordinator(),

      // SVG text layer stub (Phase 1 addition)
      // Note: This feature was referenced in ServerReaderContainer but not implemented
      // in HybridPdfProvider. Stubbed here for API compatibility.
      async getPdfSvgTextLayer(_id: string, _page: number): Promise<string> {
        console.warn('[HybridDocumentProvider] SVG text layer not implemented - using standard text layer');
        return ''; // Return empty string as fallback
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
    const docId = this.documentId ?? this.wasmDocumentId;
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

    this.documentId = null;
    this.wasmDocumentId = null;
    this.parsedDocument = null;
    this.documentData = null;
    this.apiClient = null;
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

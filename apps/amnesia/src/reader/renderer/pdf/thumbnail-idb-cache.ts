/**
 * IndexedDB Thumbnail Cache
 *
 * Persistent thumbnail cache using IndexedDB for cross-session caching.
 * Thumbnails are stored as WebP blobs for space efficiency.
 *
 * Features:
 * - Document hash-based cache keys (survives file moves/renames)
 * - LRU eviction with 100MB limit
 * - 30-day automatic expiry
 * - Batch operations for efficient bulk retrieval
 *
 * @example
 * ```typescript
 * const cache = getThumbnailIdbCache();
 * await cache.initialize();
 *
 * // Check if thumbnail exists
 * const cached = await cache.get(docHash, pageNum);
 * if (cached) {
 *   displayThumbnail(cached);
 * } else {
 *   const thumbnail = await generateThumbnail(pageNum);
 *   await cache.set(docHash, pageNum, thumbnail);
 * }
 * ```
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/** Maximum cache size in bytes (100MB) */
const MAX_CACHE_BYTES = 100 * 1024 * 1024;

/** Maximum age for cache entries (30 days in milliseconds) */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Database name */
const DB_NAME = 'amnesia-thumbnails';

/** Database version */
const DB_VERSION = 1;

/** Cached thumbnail entry */
export interface ThumbnailEntry {
  /** Document hash (first 16 bytes of document SHA-256) */
  docHash: string;
  /** Page number (1-indexed) */
  page: number;
  /** Thumbnail image as Blob (WebP format) */
  blob: Blob;
  /** Thumbnail width in pixels */
  width: number;
  /** Thumbnail height in pixels */
  height: number;
  /** Timestamp when cached (for LRU/expiry) */
  timestamp: number;
  /** Size in bytes (for cache size tracking) */
  size: number;
}

/** Cache metadata entry */
interface CacheMetadata {
  key: 'stats';
  totalBytes: number;
  entryCount: number;
  lastCleanup: number;
}

/** IndexedDB schema */
interface ThumbnailDbSchema extends DBSchema {
  thumbnails: {
    key: string; // `${docHash}-${page}`
    value: ThumbnailEntry;
    indexes: {
      'by-timestamp': number;
      'by-docHash': string;
    };
  };
  metadata: {
    key: string;
    value: CacheMetadata;
  };
}

/**
 * Generate a cache key from document hash and page number
 */
function getCacheKey(docHash: string, page: number): string {
  return `${docHash}-${page}`;
}

/**
 * Generate document hash from ArrayBuffer
 *
 * Uses first 8KB of document + file size for fast, unique identification.
 * This approach handles:
 * - File moves/renames (same content = same hash)
 * - Large files efficiently (only reads beginning)
 * - Different documents with same start (size differentiates)
 */
export async function generateDocumentHash(data: ArrayBuffer): Promise<string> {
  // Use first 8KB + file size for fingerprinting
  const sampleSize = Math.min(8192, data.byteLength);
  const sample = new Uint8Array(data, 0, sampleSize);

  // Create a buffer with sample + size
  const sizeBytes = new Uint8Array(8);
  const view = new DataView(sizeBytes.buffer);
  view.setBigUint64(0, BigInt(data.byteLength), true);

  const combined = new Uint8Array(sampleSize + 8);
  combined.set(sample, 0);
  combined.set(sizeBytes, sampleSize);

  // Hash using SubtleCrypto
  const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
  const hashArray = new Uint8Array(hashBuffer);

  // Convert to hex string (first 16 bytes = 32 hex chars)
  return Array.from(hashArray.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * IndexedDB Thumbnail Cache
 */
export class ThumbnailIdbCache {
  private db: IDBPDatabase<ThumbnailDbSchema> | null = null;
  private initPromise: Promise<void> | null = null;
  private totalBytes = 0;
  private entryCount = 0;
  private cleanupInProgress = false;

  /**
   * Initialize the database connection
   */
  async initialize(): Promise<void> {
    if (this.db) return;

    // Prevent concurrent initialization
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    try {
      this.db = await openDB<ThumbnailDbSchema>(DB_NAME, DB_VERSION, {
        upgrade(db) {
          // Create thumbnails store
          const thumbnailStore = db.createObjectStore('thumbnails', {
            keyPath: undefined, // We'll use explicit keys
          });
          thumbnailStore.createIndex('by-timestamp', 'timestamp');
          thumbnailStore.createIndex('by-docHash', 'docHash');

          // Create metadata store
          db.createObjectStore('metadata');
        },
      });

      // Load cached stats
      await this.loadStats();

      // Run cleanup on startup (non-blocking)
      this.cleanupExpired().catch((err) => {
        console.warn('[ThumbnailIdbCache] Cleanup error:', err);
      });

      console.log(
        `[ThumbnailIdbCache] Initialized: ${this.entryCount} entries, ${(this.totalBytes / 1024 / 1024).toFixed(1)}MB`
      );
    } catch (error) {
      console.error('[ThumbnailIdbCache] Failed to initialize:', error);
      this.db = null;
      throw error;
    }
  }

  /**
   * Load stats from metadata store
   */
  private async loadStats(): Promise<void> {
    if (!this.db) return;

    try {
      const stats = await this.db.get('metadata', 'stats');
      if (stats) {
        this.totalBytes = stats.totalBytes;
        this.entryCount = stats.entryCount;
      } else {
        // Compute from scratch if no stats
        await this.recomputeStats();
      }
    } catch (error) {
      console.warn('[ThumbnailIdbCache] Failed to load stats, recomputing:', error);
      await this.recomputeStats();
    }
  }

  /**
   * Recompute stats by scanning all entries
   */
  private async recomputeStats(): Promise<void> {
    if (!this.db) return;

    let totalBytes = 0;
    let entryCount = 0;

    const tx = this.db.transaction('thumbnails', 'readonly');
    let cursor = await tx.store.openCursor();

    while (cursor) {
      totalBytes += cursor.value.size;
      entryCount++;
      cursor = await cursor.continue();
    }

    this.totalBytes = totalBytes;
    this.entryCount = entryCount;
    await this.saveStats();
  }

  /**
   * Save stats to metadata store
   */
  private async saveStats(): Promise<void> {
    if (!this.db) return;

    await this.db.put('metadata', {
      key: 'stats',
      totalBytes: this.totalBytes,
      entryCount: this.entryCount,
      lastCleanup: Date.now(),
    }, 'stats');
  }

  /**
   * Get a cached thumbnail
   *
   * @param docHash Document hash
   * @param page Page number (1-indexed)
   * @returns Thumbnail entry or null if not cached
   */
  async get(docHash: string, page: number): Promise<ThumbnailEntry | null> {
    await this.initialize();
    if (!this.db) return null;

    try {
      const key = getCacheKey(docHash, page);
      const entry = await this.db.get('thumbnails', key);

      if (!entry) return null;

      // Check if expired
      if (Date.now() - entry.timestamp > MAX_AGE_MS) {
        // Delete expired entry (non-blocking)
        this.delete(docHash, page).catch(() => {});
        return null;
      }

      // Update timestamp for LRU (non-blocking)
      this.touch(docHash, page).catch(() => {});

      return entry;
    } catch (error) {
      console.warn('[ThumbnailIdbCache] Get error:', error);
      return null;
    }
  }

  /**
   * Get multiple thumbnails for a document
   *
   * @param docHash Document hash
   * @param pages Page numbers to retrieve
   * @returns Map of page number to thumbnail entry
   */
  async getMany(
    docHash: string,
    pages: number[]
  ): Promise<Map<number, ThumbnailEntry>> {
    await this.initialize();
    if (!this.db) return new Map();

    const results = new Map<number, ThumbnailEntry>();
    const now = Date.now();

    try {
      const tx = this.db.transaction('thumbnails', 'readonly');

      await Promise.all(
        pages.map(async (page) => {
          const key = getCacheKey(docHash, page);
          const entry = await tx.store.get(key);

          if (entry && now - entry.timestamp <= MAX_AGE_MS) {
            results.set(page, entry);
          }
        })
      );

      return results;
    } catch (error) {
      console.warn('[ThumbnailIdbCache] GetMany error:', error);
      return results;
    }
  }

  /**
   * Check if thumbnail is cached (without retrieving)
   *
   * @param docHash Document hash
   * @param page Page number
   * @returns true if cached and not expired
   */
  async has(docHash: string, page: number): Promise<boolean> {
    await this.initialize();
    if (!this.db) return false;

    try {
      const key = getCacheKey(docHash, page);
      const entry = await this.db.get('thumbnails', key);

      if (!entry) return false;

      // Check expiry
      return Date.now() - entry.timestamp <= MAX_AGE_MS;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get all cached page numbers for a document
   *
   * @param docHash Document hash
   * @returns Array of cached page numbers
   */
  async getCachedPages(docHash: string): Promise<number[]> {
    await this.initialize();
    if (!this.db) return [];

    try {
      const pages: number[] = [];
      const now = Date.now();

      const tx = this.db.transaction('thumbnails', 'readonly');
      const index = tx.store.index('by-docHash');
      let cursor = await index.openCursor(IDBKeyRange.only(docHash));

      while (cursor) {
        if (now - cursor.value.timestamp <= MAX_AGE_MS) {
          pages.push(cursor.value.page);
        }
        cursor = await cursor.continue();
      }

      return pages.sort((a, b) => a - b);
    } catch (error) {
      console.warn('[ThumbnailIdbCache] getCachedPages error:', error);
      return [];
    }
  }

  /**
   * Store a thumbnail
   *
   * @param docHash Document hash
   * @param page Page number (1-indexed)
   * @param blob Thumbnail image blob
   * @param width Thumbnail width
   * @param height Thumbnail height
   */
  async set(
    docHash: string,
    page: number,
    blob: Blob,
    width: number,
    height: number
  ): Promise<void> {
    await this.initialize();
    if (!this.db) return;

    const key = getCacheKey(docHash, page);
    const size = blob.size;
    const now = Date.now();

    try {
      // Check if we need to evict first
      if (this.totalBytes + size > MAX_CACHE_BYTES) {
        await this.evictLRU(size);
      }

      // Check if replacing existing entry
      const existing = await this.db.get('thumbnails', key);
      if (existing) {
        this.totalBytes -= existing.size;
        this.entryCount--;
      }

      // Store new entry
      const entry: ThumbnailEntry = {
        docHash,
        page,
        blob,
        width,
        height,
        timestamp: now,
        size,
      };

      await this.db.put('thumbnails', entry, key);

      this.totalBytes += size;
      this.entryCount++;

      // Save stats periodically (every 10 entries)
      if (this.entryCount % 10 === 0) {
        await this.saveStats();
      }
    } catch (error) {
      console.warn('[ThumbnailIdbCache] Set error:', error);
    }
  }

  /**
   * Store multiple thumbnails
   *
   * @param entries Array of thumbnail entries to store
   */
  async setMany(
    entries: Array<{
      docHash: string;
      page: number;
      blob: Blob;
      width: number;
      height: number;
    }>
  ): Promise<void> {
    await this.initialize();
    if (!this.db) return;

    const now = Date.now();

    try {
      // Calculate total size needed
      const totalNewSize = entries.reduce((sum, e) => sum + e.blob.size, 0);

      // Evict if needed
      if (this.totalBytes + totalNewSize > MAX_CACHE_BYTES) {
        await this.evictLRU(totalNewSize);
      }

      // Track state changes - defer mutation until transaction commits
      // to avoid race condition where partial updates leave totalBytes inconsistent
      let bytesToSubtract = 0;
      let entriesToSubtract = 0;
      let bytesToAdd = 0;
      let entriesToAdd = 0;

      // Store all entries in a single transaction
      const tx = this.db.transaction('thumbnails', 'readwrite');

      for (const entry of entries) {
        const key = getCacheKey(entry.docHash, entry.page);
        const size = entry.blob.size;

        // Check for existing - track but don't mutate yet
        const existing = await tx.store.get(key);
        if (existing) {
          bytesToSubtract += existing.size;
          entriesToSubtract++;
        }

        const fullEntry: ThumbnailEntry = {
          docHash: entry.docHash,
          page: entry.page,
          blob: entry.blob,
          width: entry.width,
          height: entry.height,
          timestamp: now,
          size,
        };

        await tx.store.put(fullEntry, key);
        bytesToAdd += size;
        entriesToAdd++;
      }

      // Wait for transaction to complete before mutating state
      await tx.done;

      // Apply state changes atomically after successful commit
      this.totalBytes = this.totalBytes - bytesToSubtract + bytesToAdd;
      this.entryCount = this.entryCount - entriesToSubtract + entriesToAdd;
      await this.saveStats();
    } catch (error) {
      console.warn('[ThumbnailIdbCache] SetMany error:', error);
    }
  }

  /**
   * Update timestamp without retrieving data (for LRU)
   */
  private async touch(docHash: string, page: number): Promise<void> {
    if (!this.db) return;

    try {
      const key = getCacheKey(docHash, page);
      const entry = await this.db.get('thumbnails', key);

      if (entry) {
        entry.timestamp = Date.now();
        await this.db.put('thumbnails', entry, key);
      }
    } catch (error) {
      // Ignore touch errors
    }
  }

  /**
   * Delete a cached thumbnail
   */
  async delete(docHash: string, page: number): Promise<void> {
    if (!this.db) return;

    try {
      const key = getCacheKey(docHash, page);
      const entry = await this.db.get('thumbnails', key);

      if (entry) {
        await this.db.delete('thumbnails', key);
        this.totalBytes -= entry.size;
        this.entryCount--;
      }
    } catch (error) {
      console.warn('[ThumbnailIdbCache] Delete error:', error);
    }
  }

  /**
   * Delete all thumbnails for a document
   */
  async deleteDocument(docHash: string): Promise<void> {
    await this.initialize();
    if (!this.db) return;

    try {
      const tx = this.db.transaction('thumbnails', 'readwrite');
      const index = tx.store.index('by-docHash');
      let cursor = await index.openCursor(IDBKeyRange.only(docHash));
      let deletedBytes = 0;
      let deletedCount = 0;

      while (cursor) {
        deletedBytes += cursor.value.size;
        deletedCount++;
        await cursor.delete();
        cursor = await cursor.continue();
      }

      await tx.done;

      this.totalBytes -= deletedBytes;
      this.entryCount -= deletedCount;
      await this.saveStats();

      console.log(
        `[ThumbnailIdbCache] Deleted ${deletedCount} thumbnails for document ${docHash.slice(0, 8)}...`
      );
    } catch (error) {
      console.warn('[ThumbnailIdbCache] DeleteDocument error:', error);
    }
  }

  /**
   * Evict oldest entries to make room for new data (LRU)
   *
   * @param neededBytes Bytes needed for new entry
   */
  private async evictLRU(neededBytes: number): Promise<void> {
    if (!this.db || this.cleanupInProgress) return;

    this.cleanupInProgress = true;

    try {
      const targetBytes = MAX_CACHE_BYTES - neededBytes;
      let evictedBytes = 0;
      let evictedCount = 0;

      const tx = this.db.transaction('thumbnails', 'readwrite');
      const index = tx.store.index('by-timestamp');

      // Get oldest entries first
      let cursor = await index.openCursor();

      while (cursor && this.totalBytes - evictedBytes > targetBytes) {
        evictedBytes += cursor.value.size;
        evictedCount++;
        await cursor.delete();
        cursor = await cursor.continue();
      }

      await tx.done;

      this.totalBytes -= evictedBytes;
      this.entryCount -= evictedCount;

      if (evictedCount > 0) {
        console.log(
          `[ThumbnailIdbCache] Evicted ${evictedCount} entries (${(evictedBytes / 1024 / 1024).toFixed(1)}MB)`
        );
      }
    } catch (error) {
      console.warn('[ThumbnailIdbCache] EvictLRU error:', error);
    } finally {
      this.cleanupInProgress = false;
    }
  }

  /**
   * Clean up expired entries
   */
  async cleanupExpired(): Promise<void> {
    await this.initialize();
    if (!this.db || this.cleanupInProgress) return;

    this.cleanupInProgress = true;

    try {
      const now = Date.now();
      const expiryThreshold = now - MAX_AGE_MS;
      let expiredBytes = 0;
      let expiredCount = 0;

      const tx = this.db.transaction('thumbnails', 'readwrite');
      const index = tx.store.index('by-timestamp');

      // Get entries older than threshold
      let cursor = await index.openCursor(IDBKeyRange.upperBound(expiryThreshold));

      while (cursor) {
        expiredBytes += cursor.value.size;
        expiredCount++;
        await cursor.delete();
        cursor = await cursor.continue();
      }

      await tx.done;

      this.totalBytes -= expiredBytes;
      this.entryCount -= expiredCount;

      if (expiredCount > 0) {
        console.log(
          `[ThumbnailIdbCache] Cleaned up ${expiredCount} expired entries (${(expiredBytes / 1024 / 1024).toFixed(1)}MB)`
        );
        await this.saveStats();
      }
    } catch (error) {
      console.warn('[ThumbnailIdbCache] Cleanup error:', error);
    } finally {
      this.cleanupInProgress = false;
    }
  }

  /**
   * Clear all cached thumbnails
   */
  async clear(): Promise<void> {
    await this.initialize();
    if (!this.db) return;

    try {
      await this.db.clear('thumbnails');
      this.totalBytes = 0;
      this.entryCount = 0;
      await this.saveStats();
      console.log('[ThumbnailIdbCache] Cache cleared');
    } catch (error) {
      console.warn('[ThumbnailIdbCache] Clear error:', error);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    totalBytes: number;
    entryCount: number;
    maxBytes: number;
    usagePercent: number;
  } {
    return {
      totalBytes: this.totalBytes,
      entryCount: this.entryCount,
      maxBytes: MAX_CACHE_BYTES,
      usagePercent: (this.totalBytes / MAX_CACHE_BYTES) * 100,
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initPromise = null;
    }
  }
}

// Singleton instance
let thumbnailIdbCacheInstance: ThumbnailIdbCache | null = null;

/**
 * Get the shared thumbnail IndexedDB cache instance
 */
export function getThumbnailIdbCache(): ThumbnailIdbCache {
  if (!thumbnailIdbCacheInstance) {
    thumbnailIdbCacheInstance = new ThumbnailIdbCache();
  }
  return thumbnailIdbCacheInstance;
}

/**
 * Reset the thumbnail cache (for testing)
 */
export function resetThumbnailIdbCache(): void {
  if (thumbnailIdbCacheInstance) {
    thumbnailIdbCacheInstance.close();
  }
  thumbnailIdbCacheInstance = null;
}

/**
 * Convert ImageBitmap to WebP blob for storage
 *
 * WebP provides ~30% better compression than PNG/JPEG
 * with similar quality, reducing IndexedDB storage needs.
 *
 * @param bitmap ImageBitmap to convert
 * @param quality WebP quality (0.0 - 1.0)
 * @returns WebP blob
 */
export async function imageToWebPBlob(
  bitmap: ImageBitmap,
  quality: number = 0.8
): Promise<Blob> {
  // Use OffscreenCanvas if available (worker-safe)
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');

    ctx.drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: 'image/webp', quality });
  }

  // Fallback to regular canvas (main thread only)
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context');

  ctx.drawImage(bitmap, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to create blob'));
      },
      'image/webp',
      quality
    );
  });
}

/**
 * Convert Blob to ImageBitmap
 *
 * @param blob Image blob
 * @returns ImageBitmap
 */
export async function blobToImageBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

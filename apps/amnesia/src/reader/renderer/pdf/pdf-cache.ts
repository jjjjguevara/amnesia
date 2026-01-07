/**
 * PDF Page Cache using IndexedDB
 *
 * Provides persistent caching of rendered PDF pages to avoid
 * re-fetching from the server on page reloads.
 *
 * Features:
 * - Two-tier cache: Memory (hot) + IndexedDB (persistent)
 * - Automatic eviction of entries older than 7 days
 * - LRU-like behavior in memory tier
 */

interface CacheEntry {
  blob: Blob;
  timestamp: number;
  pdfId: string;
  page: number;
  scale: number;
}

export class PdfPageCache {
  private dbName = 'amnesia-pdf-cache';
  private storeName = 'pages';
  private dbVersion = 5; // Incremented to match existing DB version
  private db: IDBDatabase | null = null;
  private memoryCache: Map<string, Blob> = new Map();
  private maxMemoryEntries = 20;
  private maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  private initialized = false;

  /**
   * Initialize the cache (opens IndexedDB)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.warn('[PdfCache] Failed to open IndexedDB:', request.error);
        // Continue without persistence
        this.initialized = true;
        resolve();
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.initialized = true;
        // Evict old entries in the background
        this.evictOldEntries().catch(console.warn);
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName);
          // Create indexes for efficient queries
          store.createIndex('pdfId', 'pdfId', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  /**
   * Generate cache key from page parameters
   */
  private getCacheKey(pdfId: string, page: number, scale: number): string {
    return `${pdfId}-${page}-${scale.toFixed(2)}`;
  }

  /**
   * Get a cached page blob
   */
  async get(pdfId: string, page: number, scale: number): Promise<Blob | null> {
    const key = this.getCacheKey(pdfId, page, scale);

    // Check memory cache first (hot tier)
    if (this.memoryCache.has(key)) {
      return this.memoryCache.get(key)!;
    }

    // Check IndexedDB (persistent tier)
    if (!this.db) return null;

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.get(key);

        request.onsuccess = () => {
          const entry = request.result as CacheEntry | undefined;
          if (entry && Date.now() - entry.timestamp < this.maxAgeMs) {
            // Promote to memory cache
            this.addToMemory(key, entry.blob);
            resolve(entry.blob);
          } else {
            resolve(null);
          }
        };

        request.onerror = () => {
          console.warn('[PdfCache] Failed to read from IndexedDB:', request.error);
          resolve(null);
        };
      } catch (error) {
        console.warn('[PdfCache] IndexedDB transaction error:', error);
        resolve(null);
      }
    });
  }

  /**
   * Cache a page blob
   */
  async set(pdfId: string, page: number, scale: number, blob: Blob): Promise<void> {
    const key = this.getCacheKey(pdfId, page, scale);

    // Always add to memory cache
    this.addToMemory(key, blob);

    // Persist to IndexedDB
    if (!this.db) return;

    const entry: CacheEntry = {
      blob,
      timestamp: Date.now(),
      pdfId,
      page,
      scale,
    };

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put(entry, key);

        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          console.warn('[PdfCache] Failed to write to IndexedDB:', tx.error);
          resolve();
        };
      } catch (error) {
        console.warn('[PdfCache] IndexedDB write error:', error);
        resolve();
      }
    });
  }

  /**
   * Check if a page is cached (memory or disk)
   */
  async has(pdfId: string, page: number, scale: number): Promise<boolean> {
    const key = this.getCacheKey(pdfId, page, scale);

    // Check memory first
    if (this.memoryCache.has(key)) {
      return true;
    }

    // Check IndexedDB
    if (!this.db) return false;

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.getKey(key);

        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Get the best available cached version of a page.
   * Tries scales from highest to lowest, returning the first available.
   *
   * This enables instant display: show thumbnail/low-res immediately
   * while full resolution loads in background.
   *
   * @param pdfId PDF document ID
   * @param page Page number
   * @param preferredScale Preferred scale (will try this and lower)
   * @returns Cached blob and its scale, or null if nothing cached
   */
  async getBestAvailable(
    pdfId: string,
    page: number,
    preferredScale: number = 2.0
  ): Promise<{ blob: Blob; scale: number } | null> {
    // Common scales to check, from highest to lowest
    // Includes thumbnail scale (72 DPI = 1.0 scale) as fallback
    const scalesToCheck = [preferredScale, 2.0, 1.5, 1.0].filter(
      (s) => s <= preferredScale
    );

    // Deduplicate and sort descending
    const uniqueScales = [...new Set(scalesToCheck)].sort((a, b) => b - a);

    for (const scale of uniqueScales) {
      const blob = await this.get(pdfId, page, scale);
      if (blob) {
        return { blob, scale };
      }
    }

    return null;
  }

  /**
   * Add to memory cache with LRU eviction
   */
  private addToMemory(key: string, blob: Blob): void {
    // If already exists, move to end (most recently used)
    if (this.memoryCache.has(key)) {
      this.memoryCache.delete(key);
    }

    this.memoryCache.set(key, blob);

    // Evict oldest if over limit
    if (this.memoryCache.size > this.maxMemoryEntries) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) {
        this.memoryCache.delete(firstKey);
      }
    }
  }

  /**
   * Evict entries older than maxAgeMs
   */
  private async evictOldEntries(): Promise<void> {
    if (!this.db) return;

    const cutoffTime = Date.now() - this.maxAgeMs;

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const index = store.index('timestamp');
        const range = IDBKeyRange.upperBound(cutoffTime);
        const request = index.openCursor(range);

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        tx.oncomplete = () => {
          console.log('[PdfCache] Evicted old entries');
          resolve();
        };
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  /**
   * Clear all cached pages for a specific PDF
   */
  async clearPdf(pdfId: string): Promise<void> {
    // Clear from memory
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(`${pdfId}-`)) {
        this.memoryCache.delete(key);
      }
    }

    // Clear from IndexedDB
    if (!this.db) return;

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const index = store.index('pdfId');
        const request = index.openCursor(IDBKeyRange.only(pdfId));

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  /**
   * Clear the entire cache
   */
  async clear(): Promise<void> {
    this.memoryCache.clear();

    if (!this.db) return;

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.clear();

        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  /**
   * Get cache statistics
   */
  getStats(): { memorySize: number; maxMemory: number } {
    return {
      memorySize: this.memoryCache.size,
      maxMemory: this.maxMemoryEntries,
    };
  }

  /**
   * Destroy the cache (close IndexedDB connection)
   */
  destroy(): void {
    this.memoryCache.clear();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }
}

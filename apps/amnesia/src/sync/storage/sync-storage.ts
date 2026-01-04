/**
 * Sync Storage
 *
 * IndexedDB-based storage for sync state including:
 * - Delta tracking state
 * - Checkpoint persistence
 * - Manifest caching
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type { SyncAdapterType, SyncCheckpoint, ManifestEntry } from '../types';
import type { DeltaState, DeltaStorage } from '../delta-tracker';

// ============================================================================
// Database Configuration
// ============================================================================

const DB_NAME = 'amnesia-sync';
const DB_VERSION = 1;

const STORES = {
  DELTA_STATES: 'delta-states',
  SYNC_METADATA: 'sync-metadata',
  CHECKPOINTS: 'checkpoints',
  MANIFESTS: 'manifests',
} as const;

// ============================================================================
// Types
// ============================================================================

/**
 * Stored delta state with composite key
 */
interface StoredDeltaState extends DeltaState {
  /** Composite key: source:id */
  key: string;
}

/**
 * Sync metadata record
 */
interface SyncMetadata {
  /** Metadata key */
  key: string;
  /** Source adapter */
  source: SyncAdapterType;
  /** Last sync timestamp */
  lastSyncTime?: Date;
  /** Last manifest hash */
  lastManifestHash?: string;
  /** Total synced items */
  totalSyncedItems: number;
  /** Last error */
  lastError?: string;
  /** Updated timestamp */
  updatedAt: Date;
}

/**
 * Cached manifest
 */
interface CachedManifest {
  /** Manifest key: source */
  key: SyncAdapterType;
  /** Manifest entries */
  entries: ManifestEntry[];
  /** Cache timestamp */
  cachedAt: Date;
  /** Manifest version */
  version: number;
  /** Total size */
  totalSize: number;
}

// ============================================================================
// IndexedDB Sync Storage Implementation
// ============================================================================

/**
 * IndexedDB-based storage for sync state
 */
export class SyncStorage implements DeltaStorage {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  // ==========================================================================
  // Database Initialization
  // ==========================================================================

  /**
   * Open or create the database
   */
  private async openDatabase(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        const errorMsg = `Failed to open database: ${request.error?.message}`;
        console.error(`[SyncStorage] ${errorMsg}`);
        this.dbPromise = null; // Reset promise so retry is possible
        reject(new Error(errorMsg));
      };

      request.onsuccess = () => {
        this.db = request.result;

        // Handle database connection errors
        this.db.onerror = (event) => {
          console.error('[SyncStorage] Database error:', event);
        };

        // Handle version change (another tab upgraded the database)
        this.db.onversionchange = () => {
          console.warn('[SyncStorage] Database version changed in another tab, closing connection');
          this.close();
        };

        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;
        const newVersion = event.newVersion || DB_VERSION;

        console.log(`[SyncStorage] Upgrading database from v${oldVersion} to v${newVersion}`);

        // Run migrations based on version
        this.runMigrations(db, oldVersion, newVersion);
      };

      // Handle blocked state (another tab has the database open with old version)
      request.onblocked = () => {
        console.warn('[SyncStorage] Database upgrade blocked - close other tabs with the app open');
      };
    });

    return this.dbPromise;
  }

  /**
   * Run database migrations
   */
  private runMigrations(db: IDBDatabase, oldVersion: number, newVersion: number): void {
    // Migration from v0 (new install) to v1
    if (oldVersion < 1) {
      console.log('[SyncStorage] Running migration v0 -> v1: Creating initial stores');
      this.createStores(db);
    }

    // Future migrations would go here:
    // if (oldVersion < 2) {
    //   console.log('[SyncStorage] Running migration v1 -> v2');
    //   // Add new stores or indexes
    // }
  }

  /**
   * Create object stores
   */
  private createStores(db: IDBDatabase): void {
    // Delta states store
    if (!db.objectStoreNames.contains(STORES.DELTA_STATES)) {
      const deltaStore = db.createObjectStore(STORES.DELTA_STATES, {
        keyPath: 'key',
      });
      deltaStore.createIndex('source', 'source', { unique: false });
      deltaStore.createIndex('type', 'type', { unique: false });
      deltaStore.createIndex('lastModified', 'lastModified', { unique: false });
      deltaStore.createIndex('lastSynced', 'lastSynced', { unique: false });
    }

    // Sync metadata store
    if (!db.objectStoreNames.contains(STORES.SYNC_METADATA)) {
      const metaStore = db.createObjectStore(STORES.SYNC_METADATA, {
        keyPath: 'key',
      });
      metaStore.createIndex('source', 'source', { unique: false });
    }

    // Checkpoints store
    if (!db.objectStoreNames.contains(STORES.CHECKPOINTS)) {
      const checkpointStore = db.createObjectStore(STORES.CHECKPOINTS, {
        keyPath: 'sessionId',
      });
      checkpointStore.createIndex('timestamp', 'timestamp', { unique: false });
    }

    // Manifests store
    if (!db.objectStoreNames.contains(STORES.MANIFESTS)) {
      db.createObjectStore(STORES.MANIFESTS, { keyPath: 'key' });
    }
  }

  /**
   * Close the database
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPromise = null;
    }
  }

  // ==========================================================================
  // DeltaStorage Implementation
  // ==========================================================================

  /**
   * Get a delta state by source and ID
   */
  async get(source: SyncAdapterType, id: string): Promise<DeltaState | null> {
    const db = await this.openDatabase();
    const key = this.makeKey(source, id);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.DELTA_STATES, 'readonly');
      const store = transaction.objectStore(STORES.DELTA_STATES);
      const request = store.get(key);

      request.onerror = () => {
        const error = new Error(`Failed to get delta state for ${key}: ${request.error?.message}`);
        (error as any).cause = request.error;
        reject(error);
      };
      request.onsuccess = () => {
        const result = request.result as StoredDeltaState | undefined;
        if (result) {
          // Convert stored dates back to Date objects
          resolve({
            ...result,
            lastModified: new Date(result.lastModified),
            lastSynced: new Date(result.lastSynced),
          });
        } else {
          resolve(null);
        }
      };
    });
  }

  /**
   * Get all delta states for a source
   */
  async getAll(source: SyncAdapterType): Promise<DeltaState[]> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.DELTA_STATES, 'readonly');
      const store = transaction.objectStore(STORES.DELTA_STATES);
      const index = store.index('source');
      const request = index.getAll(source);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const results = (request.result as StoredDeltaState[]).map((r) => ({
          ...r,
          lastModified: new Date(r.lastModified),
          lastSynced: new Date(r.lastSynced),
        }));
        resolve(results);
      };
    });
  }

  /**
   * Set a delta state
   */
  async set(state: DeltaState): Promise<void> {
    const db = await this.openDatabase();
    const stored: StoredDeltaState = {
      ...state,
      key: this.makeKey(state.source, state.id),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.DELTA_STATES, 'readwrite');
      const store = transaction.objectStore(STORES.DELTA_STATES);
      const request = store.put(stored);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Set multiple delta states in a batch
   */
  async setBatch(states: DeltaState[]): Promise<void> {
    if (states.length === 0) return;

    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.DELTA_STATES, 'readwrite');
      const store = transaction.objectStore(STORES.DELTA_STATES);

      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();

      for (const state of states) {
        const stored: StoredDeltaState = {
          ...state,
          key: this.makeKey(state.source, state.id),
        };
        store.put(stored);
      }
    });
  }

  /**
   * Delete a delta state
   */
  async delete(source: SyncAdapterType, id: string): Promise<void> {
    const db = await this.openDatabase();
    const key = this.makeKey(source, id);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.DELTA_STATES, 'readwrite');
      const store = transaction.objectStore(STORES.DELTA_STATES);
      const request = store.delete(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Clear delta states
   */
  async clear(source?: SyncAdapterType): Promise<void> {
    const db = await this.openDatabase();

    if (!source) {
      // Clear all
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORES.DELTA_STATES, 'readwrite');
        const store = transaction.objectStore(STORES.DELTA_STATES);
        const request = store.clear();

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    }

    // Clear only for specific source
    const states = await this.getAll(source);
    const transaction = db.transaction(STORES.DELTA_STATES, 'readwrite');
    const store = transaction.objectStore(STORES.DELTA_STATES);

    return new Promise((resolve, reject) => {
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();

      for (const state of states) {
        store.delete(this.makeKey(source, state.id));
      }
    });
  }

  /**
   * Get last sync time for a source
   */
  async getLastSyncTime(source: SyncAdapterType): Promise<Date | null> {
    const db = await this.openDatabase();
    const key = `meta:${source}`;

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.SYNC_METADATA, 'readonly');
      const store = transaction.objectStore(STORES.SYNC_METADATA);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result as SyncMetadata | undefined;
        if (result?.lastSyncTime) {
          resolve(new Date(result.lastSyncTime));
        } else {
          resolve(null);
        }
      };
    });
  }

  /**
   * Set last sync time for a source
   */
  async setLastSyncTime(source: SyncAdapterType, time: Date): Promise<void> {
    const db = await this.openDatabase();
    const key = `meta:${source}`;

    // Get existing metadata
    const existing = await this.getMetadata(source);
    const metadata: SyncMetadata = {
      key,
      source,
      lastSyncTime: time,
      totalSyncedItems: existing.totalSyncedItems ?? 0,
      lastManifestHash: existing.lastManifestHash,
      lastError: existing.lastError,
      updatedAt: new Date(),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.SYNC_METADATA, 'readwrite');
      const store = transaction.objectStore(STORES.SYNC_METADATA);
      const request = store.put(metadata);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  // ==========================================================================
  // Checkpoint Operations
  // ==========================================================================

  /**
   * Save a checkpoint
   */
  async saveCheckpoint(checkpoint: SyncCheckpoint): Promise<void> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.CHECKPOINTS, 'readwrite');
      const store = transaction.objectStore(STORES.CHECKPOINTS);
      const request = store.put(checkpoint);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Get a checkpoint by session ID
   */
  async getCheckpoint(sessionId: string): Promise<SyncCheckpoint | null> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.CHECKPOINTS, 'readonly');
      const store = transaction.objectStore(STORES.CHECKPOINTS);
      const request = store.get(sessionId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result as SyncCheckpoint | undefined;
        if (result) {
          // Convert dates
          resolve({
            ...result,
            timestamp: new Date(result.timestamp),
            lastSyncTimestamp: Object.fromEntries(
              Object.entries(result.lastSyncTimestamp).map(([k, v]) => [
                k,
                new Date(v),
              ])
            ) as Record<SyncAdapterType, Date>,
          });
        } else {
          resolve(null);
        }
      };
    });
  }

  /**
   * Get all incomplete checkpoints
   */
  async getIncompleteCheckpoints(): Promise<SyncCheckpoint[]> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.CHECKPOINTS, 'readonly');
      const store = transaction.objectStore(STORES.CHECKPOINTS);
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const results = (request.result as SyncCheckpoint[])
          .filter((cp) => cp.pendingChanges.length > 0)
          .map((cp) => ({
            ...cp,
            timestamp: new Date(cp.timestamp),
            lastSyncTimestamp: Object.fromEntries(
              Object.entries(cp.lastSyncTimestamp).map(([k, v]) => [
                k,
                new Date(v),
              ])
            ) as Record<SyncAdapterType, Date>,
          }));
        resolve(results);
      };
    });
  }

  /**
   * Delete a checkpoint
   */
  async deleteCheckpoint(sessionId: string): Promise<void> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.CHECKPOINTS, 'readwrite');
      const store = transaction.objectStore(STORES.CHECKPOINTS);
      const request = store.delete(sessionId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Clear all checkpoints
   */
  async clearCheckpoints(): Promise<void> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.CHECKPOINTS, 'readwrite');
      const store = transaction.objectStore(STORES.CHECKPOINTS);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  // ==========================================================================
  // Manifest Cache Operations
  // ==========================================================================

  /**
   * Cache a manifest
   */
  async cacheManifest(
    source: SyncAdapterType,
    entries: ManifestEntry[],
    version: number
  ): Promise<void> {
    const db = await this.openDatabase();
    const cached: CachedManifest = {
      key: source,
      entries,
      cachedAt: new Date(),
      version,
      totalSize: entries.reduce((sum, e) => sum + (e.size || 0), 0),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.MANIFESTS, 'readwrite');
      const store = transaction.objectStore(STORES.MANIFESTS);
      const request = store.put(cached);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Get cached manifest
   */
  async getCachedManifest(source: SyncAdapterType): Promise<CachedManifest | null> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.MANIFESTS, 'readonly');
      const store = transaction.objectStore(STORES.MANIFESTS);
      const request = store.get(source);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result as CachedManifest | undefined;
        if (result) {
          resolve({
            ...result,
            cachedAt: new Date(result.cachedAt),
            entries: result.entries.map((e) => ({
              ...e,
              lastModified: new Date(e.lastModified),
            })),
          });
        } else {
          resolve(null);
        }
      };
    });
  }

  /**
   * Invalidate cached manifest
   */
  async invalidateManifest(source: SyncAdapterType): Promise<void> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.MANIFESTS, 'readwrite');
      const store = transaction.objectStore(STORES.MANIFESTS);
      const request = store.delete(source);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Create composite key
   */
  private makeKey(source: SyncAdapterType, id: string): string {
    return `${source}:${id}`;
  }

  /**
   * Get metadata for a source
   */
  private async getMetadata(source: SyncAdapterType): Promise<Partial<SyncMetadata>> {
    const db = await this.openDatabase();
    const key = `meta:${source}`;

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.SYNC_METADATA, 'readonly');
      const store = transaction.objectStore(STORES.SYNC_METADATA);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(request.result || { source, totalSyncedItems: 0 });
      };
    });
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{
    deltaStates: number;
    checkpoints: number;
    manifests: number;
  }> {
    const db = await this.openDatabase();

    const count = (storeName: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.count();

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });

    const [deltaStates, checkpoints, manifests] = await Promise.all([
      count(STORES.DELTA_STATES),
      count(STORES.CHECKPOINTS),
      count(STORES.MANIFESTS),
    ]);

    return { deltaStates, checkpoints, manifests };
  }

  /**
   * Clear all sync data
   */
  async clearAll(): Promise<void> {
    const db = await this.openDatabase();

    const clearStore = (storeName: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.clear();

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });

    await Promise.all([
      clearStore(STORES.DELTA_STATES),
      clearStore(STORES.SYNC_METADATA),
      clearStore(STORES.CHECKPOINTS),
      clearStore(STORES.MANIFESTS),
    ]);
  }
}

// ============================================================================
// Storage Index
// ============================================================================

export { STORES as SYNC_STORES };

/**
 * Checkpoint Manager
 *
 * Manages sync checkpoints for cross-session resume capability.
 * Uses IndexedDB for persistent storage.
 *
 * Features:
 * - Automatic checkpointing every N items
 * - Session state persistence
 * - Resume detection on plugin load
 * - Cleanup of completed checkpoints
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type {
  SyncCheckpoint,
  SyncChange,
  SyncConflict,
  SyncAdapterType,
  SyncSession,
} from './types';

// ============================================================================
// Types
// ============================================================================

/**
 * Stored checkpoint in IndexedDB
 */
export interface StoredCheckpoint {
  /** Checkpoint ID (same as session ID) */
  id: string;
  /** Checkpoint data */
  checkpoint: SyncCheckpoint;
  /** Created timestamp */
  createdAt: number;
  /** Updated timestamp */
  updatedAt: number;
  /** Is checkpoint complete (session finished) */
  complete: boolean;
}

/**
 * Checkpoint store configuration
 */
export interface CheckpointStoreConfig {
  /** Database name */
  dbName: string;
  /** Store name */
  storeName: string;
  /** Database version */
  version: number;
  /** Max checkpoints to keep */
  maxCheckpoints: number;
  /** Max checkpoint age in ms (default: 7 days) */
  maxAge: number;
}

/**
 * Default configuration
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointStoreConfig = {
  dbName: 'amnesia-sync',
  storeName: 'checkpoints',
  version: 1,
  maxCheckpoints: 10,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// ============================================================================
// Checkpoint Manager
// ============================================================================

/**
 * Manages sync checkpoints for cross-session resume
 */
export class CheckpointManager {
  private config: CheckpointStoreConfig;
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private currentCheckpoint: SyncCheckpoint | null = null;

  constructor(config: Partial<CheckpointStoreConfig> = {}) {
    this.config = { ...DEFAULT_CHECKPOINT_CONFIG, ...config };
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Initialize the database
   */
  async init(): Promise<void> {
    if (this.db) return;

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.openDatabase();
    await this.initPromise;

    // Cleanup old checkpoints
    await this.cleanupOldCheckpoints();
  }

  private async openDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.config.dbName, this.config.version);

      request.onerror = () => {
        reject(new Error(`Failed to open checkpoint DB: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(this.config.storeName)) {
          const store = db.createObjectStore(this.config.storeName, {
            keyPath: 'id',
          });

          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('complete', 'complete', { unique: false });
        }
      };
    });
  }

  private async ensureInit(): Promise<IDBDatabase> {
    await this.init();
    if (!this.db) {
      throw new Error('Checkpoint database not initialized');
    }
    return this.db;
  }

  // ==========================================================================
  // Checkpoint Operations
  // ==========================================================================

  /**
   * Create a new checkpoint from session
   */
  async createCheckpoint(session: SyncSession): Promise<SyncCheckpoint> {
    const checkpoint: SyncCheckpoint = {
      sessionId: session.id,
      timestamp: new Date(),
      adapterProgress: session.adapters.reduce(
        (acc, adapter) => {
          acc[adapter] = session.processedItems;
          return acc;
        },
        {} as Record<SyncAdapterType, number>
      ),
      pendingChanges: [],
      pendingConflicts: session.conflicts.filter((c) => !c.resolved),
      lastSyncTimestamp: session.adapters.reduce(
        (acc, adapter) => {
          acc[adapter] = session.startedAt;
          return acc;
        },
        {} as Record<SyncAdapterType, Date>
      ),
    };

    await this.saveCheckpoint(checkpoint, false);
    this.currentCheckpoint = checkpoint;

    return checkpoint;
  }

  /**
   * Update checkpoint with current progress
   */
  async updateCheckpoint(
    sessionId: string,
    updates: Partial<{
      adapterProgress: Record<SyncAdapterType, number>;
      pendingChanges: SyncChange[];
      pendingConflicts: SyncConflict[];
    }>
  ): Promise<SyncCheckpoint | null> {
    const stored = await this.getCheckpoint(sessionId);
    if (!stored) return null;

    const checkpoint = stored.checkpoint;

    if (updates.adapterProgress) {
      checkpoint.adapterProgress = {
        ...checkpoint.adapterProgress,
        ...updates.adapterProgress,
      };
    }

    if (updates.pendingChanges) {
      checkpoint.pendingChanges = updates.pendingChanges;
    }

    if (updates.pendingConflicts) {
      checkpoint.pendingConflicts = updates.pendingConflicts;
    }

    checkpoint.timestamp = new Date();

    await this.saveCheckpoint(checkpoint, false);
    this.currentCheckpoint = checkpoint;

    return checkpoint;
  }

  /**
   * Add pending changes to checkpoint
   */
  async addPendingChanges(sessionId: string, changes: SyncChange[]): Promise<void> {
    const stored = await this.getCheckpoint(sessionId);
    if (!stored) return;

    const checkpoint = stored.checkpoint;
    checkpoint.pendingChanges = [
      ...checkpoint.pendingChanges,
      ...changes,
    ];
    checkpoint.timestamp = new Date();

    await this.saveCheckpoint(checkpoint, false);
  }

  /**
   * Remove processed changes from checkpoint
   */
  async removeProcessedChanges(sessionId: string, changeIds: string[]): Promise<void> {
    const stored = await this.getCheckpoint(sessionId);
    if (!stored) return;

    const checkpoint = stored.checkpoint;
    checkpoint.pendingChanges = checkpoint.pendingChanges.filter(
      (c) => !changeIds.includes(c.id)
    );
    checkpoint.timestamp = new Date();

    await this.saveCheckpoint(checkpoint, false);
  }

  /**
   * Mark checkpoint as complete
   */
  async completeCheckpoint(sessionId: string): Promise<void> {
    const stored = await this.getCheckpoint(sessionId);
    if (!stored) return;

    await this.saveCheckpoint(stored.checkpoint, true);
    this.currentCheckpoint = null;
  }

  /**
   * Delete a checkpoint
   */
  async deleteCheckpoint(sessionId: string): Promise<void> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.config.storeName, 'readwrite');
      const store = transaction.objectStore(this.config.storeName);
      const request = store.delete(sessionId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (this.currentCheckpoint?.sessionId === sessionId) {
          this.currentCheckpoint = null;
        }
        resolve();
      };
    });
  }

  // ==========================================================================
  // Retrieval
  // ==========================================================================

  /**
   * Get checkpoint by session ID
   */
  async getCheckpoint(sessionId: string): Promise<StoredCheckpoint | null> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.config.storeName, 'readonly');
      const store = transaction.objectStore(this.config.storeName);
      const request = store.get(sessionId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  /**
   * Get all incomplete checkpoints (for resume)
   * Note: We use getAll() and filter in JS because IndexedDB doesn't support boolean index keys
   */
  async getIncompleteCheckpoints(): Promise<StoredCheckpoint[]> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.config.storeName, 'readonly');
      const store = transaction.objectStore(this.config.storeName);
      // Get all checkpoints and filter for incomplete ones
      // (IndexedDB doesn't support boolean keys, so we can't use IDBKeyRange.only(false))
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const allCheckpoints = (request.result as StoredCheckpoint[]) || [];
        // Filter for incomplete and sort by most recent first
        const incomplete = allCheckpoints
          .filter(cp => cp.complete === false)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(incomplete);
      };
    });
  }

  /**
   * Get most recent incomplete checkpoint
   */
  async getMostRecentIncomplete(): Promise<StoredCheckpoint | null> {
    const incomplete = await this.getIncompleteCheckpoints();
    return incomplete[0] || null;
  }

  /**
   * Check if there's an incomplete sync to resume
   */
  async hasResumableSync(): Promise<boolean> {
    const incomplete = await this.getIncompleteCheckpoints();
    return incomplete.length > 0;
  }

  /**
   * Get all checkpoints
   */
  async getAllCheckpoints(): Promise<StoredCheckpoint[]> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.config.storeName, 'readonly');
      const store = transaction.objectStore(this.config.storeName);
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const results = (request.result as StoredCheckpoint[]) || [];
        results.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(results);
      };
    });
  }

  // ==========================================================================
  // Current Checkpoint
  // ==========================================================================

  /**
   * Get current in-memory checkpoint
   */
  getCurrentCheckpoint(): SyncCheckpoint | null {
    return this.currentCheckpoint;
  }

  /**
   * Set current checkpoint
   */
  setCurrentCheckpoint(checkpoint: SyncCheckpoint): void {
    this.currentCheckpoint = checkpoint;
  }

  /**
   * Clear current checkpoint
   */
  clearCurrentCheckpoint(): void {
    this.currentCheckpoint = null;
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Clean up old checkpoints
   */
  async cleanupOldCheckpoints(): Promise<number> {
    const db = await this.ensureInit();
    const all = await this.getAllCheckpoints();
    const now = Date.now();
    let deleted = 0;

    const toDelete: string[] = [];

    // Delete old checkpoints
    for (const stored of all) {
      const age = now - stored.createdAt;
      if (age > this.config.maxAge) {
        toDelete.push(stored.id);
      }
    }

    // Keep only maxCheckpoints (excluding incomplete)
    const complete = all.filter((s) => s.complete);
    if (complete.length > this.config.maxCheckpoints) {
      const excess = complete.slice(this.config.maxCheckpoints);
      for (const stored of excess) {
        if (!toDelete.includes(stored.id)) {
          toDelete.push(stored.id);
        }
      }
    }

    // Delete
    for (const id of toDelete) {
      await this.deleteCheckpoint(id);
      deleted++;
    }

    return deleted;
  }

  /**
   * Clear all checkpoints
   */
  async clearAll(): Promise<void> {
    const db = await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.config.storeName, 'readwrite');
      const store = transaction.objectStore(this.config.storeName);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.currentCheckpoint = null;
        resolve();
      };
    });
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Save checkpoint to IndexedDB
   */
  private async saveCheckpoint(checkpoint: SyncCheckpoint, complete: boolean): Promise<void> {
    const db = await this.ensureInit();
    const now = Date.now();

    const existing = await this.getCheckpoint(checkpoint.sessionId);

    const stored: StoredCheckpoint = {
      id: checkpoint.sessionId,
      checkpoint,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      complete,
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.config.storeName, 'readwrite');
      const store = transaction.objectStore(this.config.storeName);
      const request = store.put(stored);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Close the database
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initPromise = null;
    this.currentCheckpoint = null;
  }

  /**
   * Delete the database
   */
  async destroy(): Promise<void> {
    this.close();

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.config.dbName);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

let managerInstance: CheckpointManager | null = null;

/**
 * Get or create the checkpoint manager singleton
 */
export function getCheckpointManager(
  config?: Partial<CheckpointStoreConfig>
): CheckpointManager {
  if (!managerInstance) {
    managerInstance = new CheckpointManager(config);
  }
  return managerInstance;
}

/**
 * Create a new checkpoint manager instance
 */
export function createCheckpointManager(
  config?: Partial<CheckpointStoreConfig>
): CheckpointManager {
  return new CheckpointManager(config);
}

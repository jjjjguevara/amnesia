/**
 * Delta Tracker
 *
 * Tracks changes between sync sessions using SHA-256 content hashing
 * and timestamp comparison for efficient incremental sync.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type {
  SyncChange,
  SyncAdapterType,
  ManifestEntry,
  SyncManifest,
  TimeRange,
} from './types';

// ============================================================================
// Types
// ============================================================================

/**
 * Delta tracking state for an entity
 */
export interface DeltaState {
  /** Entity ID */
  id: string;
  /** Entity type */
  type: SyncChange['entityType'];
  /** Content hash */
  hash: string;
  /** Last modified timestamp */
  lastModified: Date;
  /** Last synced timestamp */
  lastSynced: Date;
  /** Source adapter */
  source: SyncAdapterType;
  /** Size in bytes */
  size?: number;
}

/**
 * Delta comparison result
 */
export interface DeltaResult {
  /** New entities not in local state */
  added: ManifestEntry[];
  /** Modified entities (hash changed) */
  modified: ManifestEntry[];
  /** Deleted entities (in local but not remote) */
  deleted: DeltaState[];
  /** Unchanged entities */
  unchanged: string[];
  /** Total changes */
  totalChanges: number;
}

/**
 * Hash computation options
 */
export interface HashOptions {
  /** Include metadata in hash */
  includeMetadata?: boolean;
  /** Fields to exclude from hash */
  excludeFields?: string[];
  /** Algorithm to use */
  algorithm?: 'SHA-256' | 'SHA-384' | 'SHA-512';
}

/**
 * Delta tracker configuration
 */
export interface DeltaTrackerConfig {
  /** Hash algorithm */
  algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512';
  /** Enable debug logging */
  debug: boolean;
}

/**
 * Storage interface for delta state
 */
export interface DeltaStorage {
  get(source: SyncAdapterType, id: string): Promise<DeltaState | null>;
  getAll(source: SyncAdapterType): Promise<DeltaState[]>;
  set(state: DeltaState): Promise<void>;
  setBatch(states: DeltaState[]): Promise<void>;
  delete(source: SyncAdapterType, id: string): Promise<void>;
  clear(source?: SyncAdapterType): Promise<void>;
  getLastSyncTime(source: SyncAdapterType): Promise<Date | null>;
  setLastSyncTime(source: SyncAdapterType, time: Date): Promise<void>;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_DELTA_CONFIG: DeltaTrackerConfig = {
  algorithm: 'SHA-256',
  debug: false,
};

// ============================================================================
// Delta Tracker Implementation
// ============================================================================

/**
 * Tracks entity changes for incremental sync
 */
export class DeltaTracker {
  private storage: DeltaStorage;
  private config: DeltaTrackerConfig;
  private hashCache = new Map<string, string>();

  constructor(storage: DeltaStorage, config: Partial<DeltaTrackerConfig> = {}) {
    this.storage = storage;
    this.config = { ...DEFAULT_DELTA_CONFIG, ...config };
  }

  // ==========================================================================
  // Hash Computation
  // ==========================================================================

  /**
   * Compute SHA-256 hash of content
   */
  async computeHash(content: unknown, options: HashOptions = {}): Promise<string> {
    const algorithm = options.algorithm || this.config.algorithm;

    // Normalize content for consistent hashing
    const normalized = this.normalizeForHash(content, options);
    const json = JSON.stringify(normalized);

    // Use Web Crypto API
    const encoder = new TextEncoder();
    const data = encoder.encode(json);
    const hashBuffer = await crypto.subtle.digest(algorithm, data);

    // Convert to hex string
    return this.bufferToHex(hashBuffer);
  }

  /**
   * Compute hash for a file/binary content
   */
  async computeFileHash(data: ArrayBuffer | Uint8Array): Promise<string> {
    // Ensure we have an ArrayBuffer for crypto.subtle.digest
    let buffer: ArrayBuffer;
    if (data instanceof ArrayBuffer) {
      buffer = data;
    } else {
      // Create a new ArrayBuffer copy from the Uint8Array
      buffer = new Uint8Array(data).buffer;
    }
    const hashBuffer = await crypto.subtle.digest(this.config.algorithm, buffer);
    return this.bufferToHex(hashBuffer);
  }

  /**
   * Compute hash for a manifest entry
   */
  async computeEntryHash(entry: ManifestEntry): Promise<string> {
    // Use existing hash if available
    if (entry.hash) {
      return entry.hash;
    }

    // Compute from entry data
    return this.computeHash({
      id: entry.id,
      type: entry.type,
      lastModified: entry.lastModified.toISOString(),
      metadata: entry.metadata,
    });
  }

  // ==========================================================================
  // Change Detection
  // ==========================================================================

  /**
   * Compare remote manifest with local state to find changes
   */
  async detectChanges(
    source: SyncAdapterType,
    remoteManifest: SyncManifest
  ): Promise<DeltaResult> {
    const localStates = await this.storage.getAll(source);
    const localMap = new Map(localStates.map((s) => [s.id, s]));
    const remoteMap = new Map(remoteManifest.entries.map((e) => [e.id, e]));

    const added: ManifestEntry[] = [];
    const modified: ManifestEntry[] = [];
    const deleted: DeltaState[] = [];
    const unchanged: string[] = [];

    // Check remote entries against local
    for (const entry of remoteManifest.entries) {
      const local = localMap.get(entry.id);

      if (!local) {
        // New entity
        added.push(entry);
      } else if (await this.hasChanged(local, entry)) {
        // Modified entity
        modified.push(entry);
      } else {
        // Unchanged
        unchanged.push(entry.id);
      }
    }

    // Check for deleted (local entries not in remote)
    for (const local of localStates) {
      if (!remoteMap.has(local.id)) {
        deleted.push(local);
      }
    }

    const result: DeltaResult = {
      added,
      modified,
      deleted,
      unchanged,
      totalChanges: added.length + modified.length + deleted.length,
    };

    if (this.config.debug) {
      console.log(`[DeltaTracker] Changes detected:`, {
        added: added.length,
        modified: modified.length,
        deleted: deleted.length,
        unchanged: unchanged.length,
      });
    }

    return result;
  }

  /**
   * Check if an entity has changed based on hash and timestamp
   */
  async hasChanged(local: DeltaState, remote: ManifestEntry): Promise<boolean> {
    // First, quick check on timestamp
    if (remote.lastModified > local.lastModified) {
      // Remote is newer, but verify with hash
      const remoteHash = await this.computeEntryHash(remote);
      return remoteHash !== local.hash;
    }

    // If timestamps are equal, check hash
    if (remote.lastModified.getTime() === local.lastModified.getTime()) {
      const remoteHash = await this.computeEntryHash(remote);
      return remoteHash !== local.hash;
    }

    // Local is newer (shouldn't happen in one-way sync, but handle it)
    return false;
  }

  /**
   * Get entities changed since a specific time
   */
  async getChangesSince(
    source: SyncAdapterType,
    manifest: SyncManifest,
    since: Date
  ): Promise<ManifestEntry[]> {
    return manifest.entries.filter((entry) => entry.lastModified > since);
  }

  /**
   * Get entities within a time range
   */
  async getChangesInRange(
    source: SyncAdapterType,
    manifest: SyncManifest,
    range: TimeRange
  ): Promise<ManifestEntry[]> {
    return manifest.entries.filter((entry) => {
      if (range.since && entry.lastModified < range.since) return false;
      if (range.until && entry.lastModified > range.until) return false;
      return true;
    });
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Update local state after successful sync
   */
  async updateState(
    source: SyncAdapterType,
    entries: ManifestEntry[]
  ): Promise<void> {
    const states: DeltaState[] = await Promise.all(
      entries.map(async (entry) => ({
        id: entry.id,
        type: entry.type,
        hash: await this.computeEntryHash(entry),
        lastModified: entry.lastModified,
        lastSynced: new Date(),
        source,
        size: entry.size,
      }))
    );

    await this.storage.setBatch(states);

    if (this.config.debug) {
      console.log(`[DeltaTracker] Updated ${states.length} states for ${source}`);
    }
  }

  /**
   * Mark entity as synced without changing hash
   */
  async markSynced(source: SyncAdapterType, id: string): Promise<void> {
    const state = await this.storage.get(source, id);
    if (state) {
      state.lastSynced = new Date();
      await this.storage.set(state);
    }
  }

  /**
   * Remove entity from tracking
   */
  async removeState(source: SyncAdapterType, id: string): Promise<void> {
    await this.storage.delete(source, id);
  }

  /**
   * Clear all tracking state for a source
   */
  async clearState(source?: SyncAdapterType): Promise<void> {
    await this.storage.clear(source);
    this.hashCache.clear();
  }

  /**
   * Get last sync time for a source
   */
  async getLastSyncTime(source: SyncAdapterType): Promise<Date | null> {
    return this.storage.getLastSyncTime(source);
  }

  /**
   * Update last sync time for a source
   */
  async setLastSyncTime(source: SyncAdapterType, time: Date): Promise<void> {
    await this.storage.setLastSyncTime(source, time);
  }

  /**
   * Get current state for an entity
   */
  async getState(source: SyncAdapterType, id: string): Promise<DeltaState | null> {
    return this.storage.get(source, id);
  }

  /**
   * Get all tracked states for a source
   */
  async getAllStates(source: SyncAdapterType): Promise<DeltaState[]> {
    return this.storage.getAll(source);
  }

  // ==========================================================================
  // Batch Operations
  // ==========================================================================

  /**
   * Compute hashes for multiple entities in parallel
   */
  async computeHashesBatch(
    contents: Array<{ id: string; content: unknown }>,
    concurrency = 10
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const chunks = this.chunkArray(contents, concurrency);

    for (const chunk of chunks) {
      const hashes = await Promise.all(
        chunk.map(async ({ id, content }) => ({
          id,
          hash: await this.computeHash(content),
        }))
      );

      for (const { id, hash } of hashes) {
        results.set(id, hash);
      }
    }

    return results;
  }

  /**
   * Verify integrity of multiple entries
   */
  async verifyIntegrity(
    source: SyncAdapterType,
    entries: ManifestEntry[]
  ): Promise<{
    valid: ManifestEntry[];
    invalid: ManifestEntry[];
    missing: string[];
  }> {
    const valid: ManifestEntry[] = [];
    const invalid: ManifestEntry[] = [];
    const missing: string[] = [];

    for (const entry of entries) {
      const state = await this.storage.get(source, entry.id);

      if (!state) {
        missing.push(entry.id);
        continue;
      }

      const currentHash = await this.computeEntryHash(entry);
      if (currentHash === state.hash) {
        valid.push(entry);
      } else {
        invalid.push(entry);
      }
    }

    return { valid, invalid, missing };
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Normalize content for consistent hashing
   */
  private normalizeForHash(content: unknown, options: HashOptions): unknown {
    if (content === null || content === undefined) {
      return null;
    }

    if (typeof content !== 'object') {
      return content;
    }

    if (Array.isArray(content)) {
      return content.map((item) => this.normalizeForHash(item, options));
    }

    // Object normalization
    const obj = content as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};

    // Sort keys for consistent ordering
    const keys = Object.keys(obj).sort();

    for (const key of keys) {
      // Skip excluded fields
      if (options.excludeFields?.includes(key)) continue;

      // Skip metadata if not included
      if (!options.includeMetadata && key === 'metadata') continue;

      // Normalize dates to ISO strings
      const value = obj[key];
      if (value instanceof Date) {
        normalized[key] = value.toISOString();
      } else if (typeof value === 'object') {
        normalized[key] = this.normalizeForHash(value, options);
      } else {
        normalized[key] = value;
      }
    }

    return normalized;
  }

  /**
   * Convert ArrayBuffer to hex string
   */
  private bufferToHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Split array into chunks
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

// ============================================================================
// In-Memory Delta Storage (for testing)
// ============================================================================

/**
 * In-memory implementation of DeltaStorage for testing
 */
export class InMemoryDeltaStorage implements DeltaStorage {
  private states = new Map<string, DeltaState>();
  private lastSyncTimes = new Map<SyncAdapterType, Date>();

  private makeKey(source: SyncAdapterType, id: string): string {
    return `${source}:${id}`;
  }

  async get(source: SyncAdapterType, id: string): Promise<DeltaState | null> {
    return this.states.get(this.makeKey(source, id)) || null;
  }

  async getAll(source: SyncAdapterType): Promise<DeltaState[]> {
    const results: DeltaState[] = [];
    for (const [key, state] of this.states) {
      if (key.startsWith(`${source}:`)) {
        results.push(state);
      }
    }
    return results;
  }

  async set(state: DeltaState): Promise<void> {
    this.states.set(this.makeKey(state.source, state.id), state);
  }

  async setBatch(states: DeltaState[]): Promise<void> {
    for (const state of states) {
      await this.set(state);
    }
  }

  async delete(source: SyncAdapterType, id: string): Promise<void> {
    this.states.delete(this.makeKey(source, id));
  }

  async clear(source?: SyncAdapterType): Promise<void> {
    if (source) {
      for (const key of this.states.keys()) {
        if (key.startsWith(`${source}:`)) {
          this.states.delete(key);
        }
      }
      this.lastSyncTimes.delete(source);
    } else {
      this.states.clear();
      this.lastSyncTimes.clear();
    }
  }

  async getLastSyncTime(source: SyncAdapterType): Promise<Date | null> {
    return this.lastSyncTimes.get(source) || null;
  }

  async setLastSyncTime(source: SyncAdapterType, time: Date): Promise<void> {
    this.lastSyncTimes.set(source, time);
  }
}

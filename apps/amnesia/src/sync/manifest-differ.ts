/**
 * Manifest Differ
 *
 * Efficiently compares two sync manifests to identify differences.
 * Uses optimized algorithms for large manifests (5000+ entries).
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type {
  SyncChange,
  SyncAdapterType,
  ManifestEntry,
  SyncManifest,
} from './types';

// ============================================================================
// Types
// ============================================================================

/**
 * Difference type between manifests
 */
export type DiffType = 'added' | 'modified' | 'deleted' | 'unchanged';

/**
 * A single difference between two manifest entries
 */
export interface ManifestDiff {
  /** Difference type */
  type: DiffType;
  /** Entity ID */
  id: string;
  /** Entity type */
  entityType: SyncChange['entityType'];
  /** Local entry (if exists) */
  local?: ManifestEntry;
  /** Remote entry (if exists) */
  remote?: ManifestEntry;
  /** Changed fields (for modifications) */
  changedFields?: string[];
}

/**
 * Summary of manifest differences
 */
export interface DiffSummary {
  /** Total entries compared */
  totalCompared: number;
  /** Added entries count */
  added: number;
  /** Modified entries count */
  modified: number;
  /** Deleted entries count */
  deleted: number;
  /** Unchanged entries count */
  unchanged: number;
  /** Total changes (added + modified + deleted) */
  totalChanges: number;
  /** Size difference in bytes */
  sizeDelta: number;
  /** Comparison duration in ms */
  duration: number;
}

/**
 * Full diff result
 */
export interface DiffResult {
  /** Summary statistics */
  summary: DiffSummary;
  /** All differences */
  diffs: ManifestDiff[];
  /** Added entries */
  added: ManifestDiff[];
  /** Modified entries */
  modified: ManifestDiff[];
  /** Deleted entries */
  deleted: ManifestDiff[];
}

/**
 * Differ configuration
 */
export interface ManifestDifferConfig {
  /** Compare hashes for modification detection */
  compareHashes: boolean;
  /** Compare timestamps for modification detection */
  compareTimestamps: boolean;
  /** Compare metadata fields */
  compareMetadata: boolean;
  /** Fields to ignore in comparison */
  ignoreFields: string[];
  /** Enable streaming mode for large manifests */
  streamingMode: boolean;
  /** Chunk size for streaming mode */
  chunkSize: number;
  /** Enable debug logging */
  debug: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_DIFFER_CONFIG: ManifestDifferConfig = {
  compareHashes: true,
  compareTimestamps: true,
  compareMetadata: false,
  ignoreFields: [],
  streamingMode: false,
  chunkSize: 1000,
  debug: false,
};

// ============================================================================
// Manifest Differ Implementation
// ============================================================================

/**
 * Compares two manifests efficiently
 */
export class ManifestDiffer {
  private config: ManifestDifferConfig;

  constructor(config: Partial<ManifestDifferConfig> = {}) {
    this.config = { ...DEFAULT_DIFFER_CONFIG, ...config };
  }

  // ==========================================================================
  // Main Comparison Methods
  // ==========================================================================

  /**
   * Compare two manifests and return differences
   */
  diff(local: SyncManifest, remote: SyncManifest): DiffResult {
    const startTime = performance.now();

    // Build lookup maps for O(1) access
    const localMap = this.buildEntryMap(local.entries);
    const remoteMap = this.buildEntryMap(remote.entries);

    const added: ManifestDiff[] = [];
    const modified: ManifestDiff[] = [];
    const deleted: ManifestDiff[] = [];

    // Find added and modified entries
    for (const [id, remoteEntry] of remoteMap) {
      const localEntry = localMap.get(id);

      if (!localEntry) {
        // New entry in remote
        added.push({
          type: 'added',
          id,
          entityType: remoteEntry.type,
          remote: remoteEntry,
        });
      } else if (this.hasChanged(localEntry, remoteEntry)) {
        // Modified entry
        modified.push({
          type: 'modified',
          id,
          entityType: remoteEntry.type,
          local: localEntry,
          remote: remoteEntry,
          changedFields: this.getChangedFields(localEntry, remoteEntry),
        });
      }
    }

    // Find deleted entries
    for (const [id, localEntry] of localMap) {
      if (!remoteMap.has(id)) {
        deleted.push({
          type: 'deleted',
          id,
          entityType: localEntry.type,
          local: localEntry,
        });
      }
    }

    const duration = performance.now() - startTime;
    const unchangedCount =
      local.entries.length - modified.length - deleted.length;

    const summary: DiffSummary = {
      totalCompared: Math.max(local.entries.length, remote.entries.length),
      added: added.length,
      modified: modified.length,
      deleted: deleted.length,
      unchanged: unchangedCount,
      totalChanges: added.length + modified.length + deleted.length,
      sizeDelta: remote.totalSize - local.totalSize,
      duration,
    };

    if (this.config.debug) {
      console.log('[ManifestDiffer] Comparison complete:', summary);
    }

    return {
      summary,
      diffs: [...added, ...modified, ...deleted],
      added,
      modified,
      deleted,
    };
  }

  /**
   * Compare manifests in streaming mode for large datasets
   */
  async *diffStreaming(
    local: SyncManifest,
    remote: SyncManifest
  ): AsyncGenerator<ManifestDiff> {
    const localMap = this.buildEntryMap(local.entries);
    const remoteMap = this.buildEntryMap(remote.entries);
    const processedIds = new Set<string>();

    // Stream added and modified
    for (const [id, remoteEntry] of remoteMap) {
      processedIds.add(id);
      const localEntry = localMap.get(id);

      if (!localEntry) {
        yield {
          type: 'added',
          id,
          entityType: remoteEntry.type,
          remote: remoteEntry,
        };
      } else if (this.hasChanged(localEntry, remoteEntry)) {
        yield {
          type: 'modified',
          id,
          entityType: remoteEntry.type,
          local: localEntry,
          remote: remoteEntry,
          changedFields: this.getChangedFields(localEntry, remoteEntry),
        };
      }

      // Allow event loop to process other tasks
      if (processedIds.size % this.config.chunkSize === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // Stream deleted
    for (const [id, localEntry] of localMap) {
      if (!processedIds.has(id)) {
        yield {
          type: 'deleted',
          id,
          entityType: localEntry.type,
          local: localEntry,
        };
      }
    }
  }

  /**
   * Quick check if any changes exist (early exit optimization)
   */
  hasAnyChanges(local: SyncManifest, remote: SyncManifest): boolean {
    // Quick size check
    if (local.entries.length !== remote.entries.length) {
      return true;
    }

    // Quick total size check
    if (local.totalSize !== remote.totalSize) {
      return true;
    }

    // Need to do full comparison
    const localMap = this.buildEntryMap(local.entries);

    for (const remoteEntry of remote.entries) {
      const localEntry = localMap.get(remoteEntry.id);
      if (!localEntry || this.hasChanged(localEntry, remoteEntry)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get only changes of a specific type
   */
  getChangesOfType(
    local: SyncManifest,
    remote: SyncManifest,
    type: DiffType
  ): ManifestDiff[] {
    const result = this.diff(local, remote);

    switch (type) {
      case 'added':
        return result.added;
      case 'modified':
        return result.modified;
      case 'deleted':
        return result.deleted;
      default:
        return [];
    }
  }

  // ==========================================================================
  // Comparison Helpers
  // ==========================================================================

  /**
   * Check if an entry has changed
   */
  private hasChanged(local: ManifestEntry, remote: ManifestEntry): boolean {
    // Hash comparison (most reliable)
    if (this.config.compareHashes && local.hash !== remote.hash) {
      return true;
    }

    // Timestamp comparison
    if (this.config.compareTimestamps) {
      const localTime =
        local.lastModified instanceof Date
          ? local.lastModified.getTime()
          : new Date(local.lastModified).getTime();
      const remoteTime =
        remote.lastModified instanceof Date
          ? remote.lastModified.getTime()
          : new Date(remote.lastModified).getTime();

      if (localTime !== remoteTime) {
        return true;
      }
    }

    // Size comparison
    if (local.size !== undefined && remote.size !== undefined) {
      if (local.size !== remote.size) {
        return true;
      }
    }

    // Metadata comparison
    if (this.config.compareMetadata && local.metadata && remote.metadata) {
      if (!this.metadataEquals(local.metadata, remote.metadata)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get list of changed fields between two entries
   */
  private getChangedFields(
    local: ManifestEntry,
    remote: ManifestEntry
  ): string[] {
    const changed: string[] = [];

    if (local.hash !== remote.hash) {
      changed.push('hash');
    }

    const localTime =
      local.lastModified instanceof Date
        ? local.lastModified.getTime()
        : new Date(local.lastModified).getTime();
    const remoteTime =
      remote.lastModified instanceof Date
        ? remote.lastModified.getTime()
        : new Date(remote.lastModified).getTime();

    if (localTime !== remoteTime) {
      changed.push('lastModified');
    }

    if (local.size !== remote.size) {
      changed.push('size');
    }

    if (local.metadata && remote.metadata) {
      const metaChanges = this.getMetadataChanges(local.metadata, remote.metadata);
      changed.push(...metaChanges.map((f) => `metadata.${f}`));
    }

    return changed;
  }

  /**
   * Compare metadata objects
   */
  private metadataEquals(
    local: Record<string, unknown>,
    remote: Record<string, unknown>
  ): boolean {
    const localKeys = Object.keys(local).filter(
      (k) => !this.config.ignoreFields.includes(k)
    );
    const remoteKeys = Object.keys(remote).filter(
      (k) => !this.config.ignoreFields.includes(k)
    );

    if (localKeys.length !== remoteKeys.length) {
      return false;
    }

    for (const key of localKeys) {
      if (!remoteKeys.includes(key)) {
        return false;
      }
      if (JSON.stringify(local[key]) !== JSON.stringify(remote[key])) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get changed metadata fields
   */
  private getMetadataChanges(
    local: Record<string, unknown>,
    remote: Record<string, unknown>
  ): string[] {
    const changed: string[] = [];
    const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);

    for (const key of allKeys) {
      if (this.config.ignoreFields.includes(key)) continue;

      if (JSON.stringify(local[key]) !== JSON.stringify(remote[key])) {
        changed.push(key);
      }
    }

    return changed;
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Build an ID -> Entry map for fast lookup
   */
  private buildEntryMap(entries: ManifestEntry[]): Map<string, ManifestEntry> {
    return new Map(entries.map((e) => [e.id, e]));
  }

  /**
   * Create a minimal manifest from a full one (for caching)
   */
  createMinimalManifest(manifest: SyncManifest): {
    version: number;
    source: SyncAdapterType;
    entries: Array<{ id: string; hash: string; lastModified: number }>;
  } {
    return {
      version: manifest.version,
      source: manifest.source,
      entries: manifest.entries.map((e) => ({
        id: e.id,
        hash: e.hash,
        lastModified:
          e.lastModified instanceof Date
            ? e.lastModified.getTime()
            : new Date(e.lastModified).getTime(),
      })),
    };
  }

  /**
   * Merge multiple diff results
   */
  mergeDiffResults(results: DiffResult[]): DiffResult {
    const merged: DiffResult = {
      summary: {
        totalCompared: 0,
        added: 0,
        modified: 0,
        deleted: 0,
        unchanged: 0,
        totalChanges: 0,
        sizeDelta: 0,
        duration: 0,
      },
      diffs: [],
      added: [],
      modified: [],
      deleted: [],
    };

    for (const result of results) {
      merged.summary.totalCompared += result.summary.totalCompared;
      merged.summary.added += result.summary.added;
      merged.summary.modified += result.summary.modified;
      merged.summary.deleted += result.summary.deleted;
      merged.summary.unchanged += result.summary.unchanged;
      merged.summary.totalChanges += result.summary.totalChanges;
      merged.summary.sizeDelta += result.summary.sizeDelta;
      merged.summary.duration += result.summary.duration;

      merged.diffs.push(...result.diffs);
      merged.added.push(...result.added);
      merged.modified.push(...result.modified);
      merged.deleted.push(...result.deleted);
    }

    return merged;
  }

  /**
   * Filter diffs by entity type
   */
  filterByEntityType(
    diffs: ManifestDiff[],
    entityType: SyncChange['entityType']
  ): ManifestDiff[] {
    return diffs.filter((d) => d.entityType === entityType);
  }

  /**
   * Sort diffs by priority (deletes first, then modifications, then adds)
   */
  sortByPriority(diffs: ManifestDiff[]): ManifestDiff[] {
    const priority: Record<DiffType, number> = {
      deleted: 0,
      modified: 1,
      added: 2,
      unchanged: 3,
    };

    return [...diffs].sort((a, b) => priority[a.type] - priority[b.type]);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a manifest differ with default configuration
 */
export function createManifestDiffer(
  config?: Partial<ManifestDifferConfig>
): ManifestDiffer {
  return new ManifestDiffer(config);
}

/**
 * Quick diff utility function
 */
export function quickDiff(
  local: SyncManifest,
  remote: SyncManifest
): DiffSummary {
  const differ = new ManifestDiffer();
  return differ.diff(local, remote).summary;
}

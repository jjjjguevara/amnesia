/**
 * Conflict Resolution Manager
 *
 * Handles conflict detection and resolution for sync operations.
 * Supports auto-resolution strategies and user-interactive resolution.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type {
  SyncConflict,
  SyncChange,
  ConflictStrategy,
  FieldChange,
} from './types';

// ============================================================================
// Types
// ============================================================================

/**
 * Field-specific conflict resolution settings
 */
export interface FieldResolutionConfig {
  /** Default resolution strategy for this field */
  defaultStrategy: ConflictStrategy;
  /** Allow auto-resolution (skip user prompt) */
  autoResolve: boolean;
  /** Custom merge function for this field */
  mergeFn?: (local: unknown, remote: unknown) => unknown;
}

/**
 * Resolution result from user interaction or auto-resolution
 */
export interface ResolutionResult {
  /** Conflict ID */
  conflictId: string;
  /** Chosen resolution strategy */
  strategy: ConflictStrategy;
  /** Resolved value */
  resolvedValue: unknown;
  /** Apply to similar conflicts */
  applyToSimilar: boolean;
  /** Remember this choice for future */
  rememberChoice: boolean;
}

/**
 * Conflict group for batch resolution
 */
export interface ConflictGroup {
  /** Group key (field name or entity type) */
  key: string;
  /** Conflicts in this group */
  conflicts: SyncConflict[];
  /** Suggested resolution based on majority */
  suggestedStrategy?: ConflictStrategy;
}

/**
 * Conflict resolution statistics
 */
export interface ResolutionStats {
  /** Total conflicts */
  total: number;
  /** Auto-resolved */
  autoResolved: number;
  /** User-resolved */
  userResolved: number;
  /** Skipped/deferred */
  deferred: number;
  /** By strategy */
  byStrategy: Record<ConflictStrategy, number>;
}

/**
 * Conflict Resolution Manager configuration
 */
export interface ConflictResolutionConfig {
  /** Default global strategy */
  defaultStrategy: ConflictStrategy;
  /** Field-specific configurations */
  fieldConfigs: Record<string, FieldResolutionConfig>;
  /** Enable batch resolution for similar conflicts */
  enableBatchResolution: boolean;
  /** Maximum conflicts before prompting for batch action */
  batchThreshold: number;
  /** Enable auto-resolution for trivial conflicts */
  enableAutoResolution: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_RESOLUTION_CONFIG: ConflictResolutionConfig = {
  defaultStrategy: 'last-write-wins',
  fieldConfigs: {
    rating: { defaultStrategy: 'ask-user', autoResolve: false },
    tags: { defaultStrategy: 'merge', autoResolve: true, mergeFn: mergeTags },
    bookshelves: { defaultStrategy: 'merge', autoResolve: true, mergeFn: mergeTags },
    progress: { defaultStrategy: 'last-write-wins', autoResolve: true },
    currentCfi: { defaultStrategy: 'last-write-wins', autoResolve: true },
    highlights: { defaultStrategy: 'merge', autoResolve: true, mergeFn: mergeHighlights },
    notes: { defaultStrategy: 'merge', autoResolve: true, mergeFn: mergeNotes },
    title: { defaultStrategy: 'prefer-remote', autoResolve: true },
    author: { defaultStrategy: 'prefer-remote', autoResolve: true },
  },
  enableBatchResolution: true,
  batchThreshold: 5,
  enableAutoResolution: true,
};

// ============================================================================
// Merge Functions
// ============================================================================

/**
 * Merge tag arrays (union)
 */
function mergeTags(local: unknown, remote: unknown): unknown {
  const localTags = Array.isArray(local) ? local : [];
  const remoteTags = Array.isArray(remote) ? remote : [];
  return [...new Set([...localTags, ...remoteTags])];
}

/**
 * Merge highlight arrays (union by ID, prefer newer)
 */
function mergeHighlights(local: unknown, remote: unknown): unknown {
  const localHighlights = Array.isArray(local) ? local : [];
  const remoteHighlights = Array.isArray(remote) ? remote : [];

  const merged = new Map<string, unknown>();

  for (const h of localHighlights) {
    if (h && typeof h === 'object' && 'id' in h) {
      merged.set(h.id as string, h);
    }
  }

  for (const h of remoteHighlights) {
    if (h && typeof h === 'object' && 'id' in h) {
      const existing = merged.get(h.id as string);
      if (!existing) {
        merged.set(h.id as string, h);
      } else if (
        'updatedAt' in h &&
        'updatedAt' in (existing as object) &&
        new Date(h.updatedAt as string) > new Date((existing as { updatedAt: string }).updatedAt)
      ) {
        merged.set(h.id as string, h);
      }
    }
  }

  return Array.from(merged.values());
}

/**
 * Merge note arrays (union by ID, prefer newer)
 */
function mergeNotes(local: unknown, remote: unknown): unknown {
  // Same logic as highlights
  return mergeHighlights(local, remote);
}

// ============================================================================
// Conflict Resolution Manager
// ============================================================================

/**
 * Manages conflict detection and resolution for sync operations
 */
export class ConflictResolutionManager {
  private config: ConflictResolutionConfig;
  private pendingConflicts: SyncConflict[] = [];
  private resolvedConflicts: SyncConflict[] = [];
  private stats: ResolutionStats = {
    total: 0,
    autoResolved: 0,
    userResolved: 0,
    deferred: 0,
    byStrategy: {
      'last-write-wins': 0,
      'prefer-local': 0,
      'prefer-remote': 0,
      merge: 0,
      'ask-user': 0,
    },
  };

  /** Remembered choices for similar conflicts */
  private rememberedChoices = new Map<string, ConflictStrategy>();

  constructor(config: Partial<ConflictResolutionConfig> = {}) {
    this.config = { ...DEFAULT_RESOLUTION_CONFIG, ...config };
  }

  // ==========================================================================
  // Conflict Detection
  // ==========================================================================

  /**
   * Detect conflict between local and remote changes
   */
  detectConflict(
    localChange: SyncChange,
    remoteChange: SyncChange
  ): SyncConflict | null {
    // Same entity, same field, different values
    if (
      localChange.entityId !== remoteChange.entityId ||
      localChange.entityType !== remoteChange.entityType
    ) {
      return null;
    }

    // Compare data
    const localData = localChange.data;
    const remoteData = remoteChange.data;

    if (this.deepEqual(localData, remoteData)) {
      return null; // No conflict
    }

    // Create conflict
    const conflict: SyncConflict = {
      id: crypto.randomUUID(),
      entityType: localChange.entityType,
      entityId: localChange.entityId,
      localChange,
      remoteChange,
      localValue: localData,
      remoteValue: remoteData,
      resolved: false,
    };

    this.pendingConflicts.push(conflict);
    this.stats.total++;

    return conflict;
  }

  /**
   * Detect field-level conflicts
   */
  detectFieldConflicts(
    entityId: string,
    entityType: SyncConflict['entityType'],
    localData: Record<string, unknown>,
    remoteData: Record<string, unknown>
  ): SyncConflict[] {
    const conflicts: SyncConflict[] = [];

    const allFields = new Set([
      ...Object.keys(localData),
      ...Object.keys(remoteData),
    ]);

    for (const field of allFields) {
      const localValue = localData[field];
      const remoteValue = remoteData[field];

      if (!this.deepEqual(localValue, remoteValue)) {
        const conflict: SyncConflict = {
          id: crypto.randomUUID(),
          entityType,
          entityId,
          localChange: {
            id: crypto.randomUUID(),
            source: 'file', // Placeholder
            entityType,
            entityId,
            operation: 'update',
            timestamp: new Date(),
            data: localData,
          },
          remoteChange: {
            id: crypto.randomUUID(),
            source: 'server',
            entityType,
            entityId,
            operation: 'update',
            timestamp: new Date(),
            data: remoteData,
          },
          field,
          localValue,
          remoteValue,
          resolved: false,
        };

        conflicts.push(conflict);
        this.pendingConflicts.push(conflict);
        this.stats.total++;
      }
    }

    return conflicts;
  }

  // ==========================================================================
  // Auto-Resolution
  // ==========================================================================

  /**
   * Attempt auto-resolution for a conflict
   */
  tryAutoResolve(conflict: SyncConflict): boolean {
    if (!this.config.enableAutoResolution) {
      return false;
    }

    // Check for remembered choice
    const choiceKey = this.getChoiceKey(conflict);
    const rememberedStrategy = this.rememberedChoices.get(choiceKey);
    if (rememberedStrategy) {
      this.resolveConflict(conflict, rememberedStrategy);
      return true;
    }

    // Check field-specific config
    const fieldConfig = conflict.field
      ? this.config.fieldConfigs[conflict.field]
      : null;

    if (fieldConfig?.autoResolve) {
      this.resolveConflict(conflict, fieldConfig.defaultStrategy);
      this.stats.autoResolved++;
      return true;
    }

    // Try timestamp-based auto-resolution for last-write-wins
    if (this.config.defaultStrategy === 'last-write-wins') {
      const localTime = conflict.localChange.timestamp;
      const remoteTime = conflict.remoteChange.timestamp;

      if (localTime && remoteTime) {
        this.resolveConflict(conflict, 'last-write-wins');
        this.stats.autoResolved++;
        return true;
      }
    }

    return false;
  }

  /**
   * Auto-resolve all pending conflicts that can be auto-resolved
   */
  autoResolveAll(): SyncConflict[] {
    const remaining: SyncConflict[] = [];

    for (const conflict of this.pendingConflicts) {
      if (!this.tryAutoResolve(conflict)) {
        remaining.push(conflict);
      }
    }

    this.pendingConflicts = remaining;
    return remaining;
  }

  // ==========================================================================
  // Manual Resolution
  // ==========================================================================

  /**
   * Resolve a conflict with a specific strategy
   */
  resolveConflict(conflict: SyncConflict, strategy: ConflictStrategy): void {
    const resolvedValue = this.computeResolvedValue(conflict, strategy);

    conflict.resolved = true;
    conflict.resolutionStrategy = strategy;
    conflict.resolvedValue = resolvedValue;

    // Move from pending to resolved
    this.pendingConflicts = this.pendingConflicts.filter(
      (c) => c.id !== conflict.id
    );
    this.resolvedConflicts.push(conflict);

    // Update stats
    this.stats.byStrategy[strategy]++;
  }

  /**
   * Apply resolution result (from UI)
   */
  applyResolution(result: ResolutionResult): void {
    const conflict = this.pendingConflicts.find(
      (c) => c.id === result.conflictId
    );
    if (!conflict) return;

    conflict.resolved = true;
    conflict.resolutionStrategy = result.strategy;
    conflict.resolvedValue = result.resolvedValue;

    // Move from pending to resolved
    this.pendingConflicts = this.pendingConflicts.filter(
      (c) => c.id !== conflict.id
    );
    this.resolvedConflicts.push(conflict);
    this.stats.userResolved++;
    this.stats.byStrategy[result.strategy]++;

    // Remember choice if requested
    if (result.rememberChoice) {
      const choiceKey = this.getChoiceKey(conflict);
      this.rememberedChoices.set(choiceKey, result.strategy);
    }

    // Apply to similar conflicts if requested
    if (result.applyToSimilar) {
      this.applyToSimilarConflicts(conflict, result.strategy);
    }
  }

  /**
   * Apply strategy to similar conflicts
   */
  private applyToSimilarConflicts(
    conflict: SyncConflict,
    strategy: ConflictStrategy
  ): void {
    const similar = this.pendingConflicts.filter(
      (c) =>
        c.field === conflict.field && c.entityType === conflict.entityType
    );

    for (const similarConflict of similar) {
      this.resolveConflict(similarConflict, strategy);
      this.stats.userResolved++;
    }
  }

  /**
   * Defer conflict for later resolution
   */
  deferConflict(conflictId: string): void {
    const conflict = this.pendingConflicts.find((c) => c.id === conflictId);
    if (conflict) {
      this.stats.deferred++;
      // Keep in pending
    }
  }

  // ==========================================================================
  // Batch Resolution
  // ==========================================================================

  /**
   * Group conflicts for batch resolution
   */
  groupConflicts(): ConflictGroup[] {
    const groups = new Map<string, SyncConflict[]>();

    for (const conflict of this.pendingConflicts) {
      const key = conflict.field || conflict.entityType;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(conflict);
    }

    return Array.from(groups.entries())
      .map(([key, conflicts]) => ({
        key,
        conflicts,
        suggestedStrategy: this.suggestGroupStrategy(conflicts),
      }))
      .sort((a, b) => b.conflicts.length - a.conflicts.length);
  }

  /**
   * Suggest resolution strategy for a group based on field config
   */
  private suggestGroupStrategy(
    conflicts: SyncConflict[]
  ): ConflictStrategy | undefined {
    if (conflicts.length === 0) return undefined;

    const field = conflicts[0].field;
    if (field) {
      return this.config.fieldConfigs[field]?.defaultStrategy;
    }

    return this.config.defaultStrategy;
  }

  /**
   * Resolve all conflicts in a group with the same strategy
   */
  resolveGroup(groupKey: string, strategy: ConflictStrategy): void {
    const conflicts = this.pendingConflicts.filter(
      (c) => (c.field || c.entityType) === groupKey
    );

    for (const conflict of conflicts) {
      this.resolveConflict(conflict, strategy);
    }
  }

  // ==========================================================================
  // Value Computation
  // ==========================================================================

  /**
   * Compute resolved value based on strategy
   */
  private computeResolvedValue(
    conflict: SyncConflict,
    strategy: ConflictStrategy
  ): unknown {
    switch (strategy) {
      case 'prefer-local':
        return conflict.localValue;

      case 'prefer-remote':
        return conflict.remoteValue;

      case 'last-write-wins': {
        const localTime = conflict.localChange.timestamp;
        const remoteTime = conflict.remoteChange.timestamp;
        return localTime >= remoteTime
          ? conflict.localValue
          : conflict.remoteValue;
      }

      case 'merge': {
        const fieldConfig = conflict.field
          ? this.config.fieldConfigs[conflict.field]
          : null;

        if (fieldConfig?.mergeFn) {
          return fieldConfig.mergeFn(
            conflict.localValue,
            conflict.remoteValue
          );
        }

        // Default merge: arrays union, objects shallow merge
        if (
          Array.isArray(conflict.localValue) &&
          Array.isArray(conflict.remoteValue)
        ) {
          return [
            ...new Set([...conflict.localValue, ...conflict.remoteValue]),
          ];
        }

        if (
          typeof conflict.localValue === 'object' &&
          typeof conflict.remoteValue === 'object' &&
          conflict.localValue !== null &&
          conflict.remoteValue !== null
        ) {
          return { ...conflict.localValue, ...conflict.remoteValue };
        }

        // Fallback to prefer-remote
        return conflict.remoteValue;
      }

      case 'ask-user':
        // This shouldn't be called directly - requires UI interaction
        return conflict.localValue;

      default:
        return conflict.remoteValue;
    }
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Get pending conflicts
   */
  getPendingConflicts(): SyncConflict[] {
    return [...this.pendingConflicts];
  }

  /**
   * Get resolved conflicts
   */
  getResolvedConflicts(): SyncConflict[] {
    return [...this.resolvedConflicts];
  }

  /**
   * Get resolution statistics
   */
  getStats(): ResolutionStats {
    return { ...this.stats };
  }

  /**
   * Check if there are pending conflicts requiring user input
   */
  hasPendingConflicts(): boolean {
    return this.pendingConflicts.length > 0;
  }

  /**
   * Get count of pending conflicts
   */
  getPendingCount(): number {
    return this.pendingConflicts.length;
  }

  /**
   * Clear all conflicts
   */
  clearAll(): void {
    this.pendingConflicts = [];
    this.resolvedConflicts = [];
    this.stats = {
      total: 0,
      autoResolved: 0,
      userResolved: 0,
      deferred: 0,
      byStrategy: {
        'last-write-wins': 0,
        'prefer-local': 0,
        'prefer-remote': 0,
        merge: 0,
        'ask-user': 0,
      },
    };
  }

  /**
   * Clear remembered choices
   */
  clearRememberedChoices(): void {
    this.rememberedChoices.clear();
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Generate key for remembering choices
   */
  private getChoiceKey(conflict: SyncConflict): string {
    return `${conflict.entityType}:${conflict.field || 'all'}`;
  }

  /**
   * Deep equality check
   */
  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;

    if (
      typeof a !== 'object' ||
      typeof b !== 'object' ||
      a === null ||
      b === null
    ) {
      return false;
    }

    if (Array.isArray(a) !== Array.isArray(b)) return false;

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (
        !keysB.includes(key) ||
        !this.deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key]
        )
      ) {
        return false;
      }
    }

    return true;
  }
}

// ============================================================================
// Export
// ============================================================================

export default ConflictResolutionManager;

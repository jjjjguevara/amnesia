/**
 * Unified Sync Engine
 *
 * Orchestrates all sync operations across Calibre, Server, and File adapters.
 * Provides a single interface for sync management with support for:
 * - Incremental (delta) sync
 * - Parallel processing
 * - Cross-session resume
 * - Conflict resolution
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { LibrosSettings } from '../settings/settings';
import type { CalibreService } from '../calibre/calibre-service';
import type { AmnesiaClient } from '../server/amnesia-client';

import {
  type SyncAdapter,
  type AdapterStatus,
  AdapterRegistry,
} from './sync-adapter';
import { CalibreSyncAdapter, ServerSyncAdapter, FileSyncAdapter } from './adapters';
import { CheckpointManager, getCheckpointManager } from './checkpoint-manager';

// Delta tracking and parallel execution
import { DeltaTracker, InMemoryDeltaStorage, type DeltaStorage } from './delta-tracker';
import { ManifestDiffer } from './manifest-differ';
import { ParallelExecutor, type TaskResult, type ExecutorProgress } from './parallel-executor';
import {
  TokenBucketRateLimiter,
  createRateLimiter,
  createNoOpRateLimiter,
  type RateLimiter,
} from './rate-limiter';
import { SyncStorage } from './storage/sync-storage';

import {
  type SyncAdapterType,
  type SyncEngineStatus,
  type SyncMode,
  type ConflictStrategy,
  type SyncChange,
  type SyncConflict,
  type SyncSession,
  type SyncCheckpoint,
  type SyncProgress,
  type SyncOptions,
  type SyncResult,
  type SyncConfig,
  type SyncError,
  type SyncEngineEvents,
  type SyncEventListener,
  type SyncManifest,
  DEFAULT_SYNC_CONFIG,
} from './types';

// ============================================================================
// Types
// ============================================================================

/**
 * Engine initialization options
 */
export interface EngineInitOptions {
  calibreService?: CalibreService;
  amnesiaClient?: AmnesiaClient;
  config?: Partial<SyncConfig>;
}

// ============================================================================
// Unified Sync Engine
// ============================================================================

/**
 * Main sync engine that orchestrates all adapters
 */
export class UnifiedSyncEngine {
  private app: App;
  private getSettings: () => LibrosSettings;
  private config: SyncConfig;
  private registry: AdapterRegistry;
  private checkpointManager: CheckpointManager;

  // Delta tracking and parallel execution
  private deltaTracker: DeltaTracker;
  private manifestDiffer: ManifestDiffer;
  private syncStorage: SyncStorage;
  private rateLimiter: RateLimiter;
  private executor: ParallelExecutor<void> | null = null;

  // State
  private status: SyncEngineStatus = 'idle';
  private currentSession: SyncSession | null = null;
  private pendingQueue: SyncChange[] = [];
  private conflicts: SyncConflict[] = [];

  // Event listeners
  private listeners = new Map<keyof SyncEngineEvents, Set<SyncEventListener<keyof SyncEngineEvents>>>();

  // Processing
  private abortController: AbortController | null = null;
  private processedCount = 0;
  private startTime: number = 0;

  // Stats tracking
  private createdCount = 0;
  private updatedCount = 0;
  private deletedCount = 0;

  constructor(
    app: App,
    getSettings: () => LibrosSettings,
    options: EngineInitOptions = {}
  ) {
    this.app = app;
    this.getSettings = getSettings;
    this.config = { ...DEFAULT_SYNC_CONFIG, ...options.config };
    this.registry = new AdapterRegistry();
    this.checkpointManager = getCheckpointManager();

    // Initialize delta tracking and storage
    this.syncStorage = new SyncStorage();
    this.deltaTracker = new DeltaTracker(this.syncStorage, {
      algorithm: 'SHA-256',
      debug: this.config.debug,
    });
    this.manifestDiffer = new ManifestDiffer({
      compareHashes: true,
      compareTimestamps: true,
      debug: this.config.debug,
    });

    // Initialize rate limiter
    this.rateLimiter = this.config.rateLimit > 0
      ? createRateLimiter(this.config.rateLimit)
      : createNoOpRateLimiter();

    // Register adapters if services provided
    if (options.calibreService) {
      const calibreAdapter = new CalibreSyncAdapter(
        app,
        options.calibreService,
        getSettings
      );
      this.registry.register(calibreAdapter);
    }

    if (options.amnesiaClient) {
      const serverAdapter = new ServerSyncAdapter(
        app,
        options.amnesiaClient,
        getSettings
      );
      this.registry.register(serverAdapter);
    }

    // File adapter doesn't need external service
    const fileAdapter = new FileSyncAdapter(app, getSettings);
    this.registry.register(fileAdapter);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Initialize the sync engine
   */
  async initialize(): Promise<void> {
    this.status = 'initializing';

    // Initialize checkpoint manager
    await this.checkpointManager.init();

    // Initialize all adapters
    await this.registry.initializeAll();

    // Check for resumable sessions
    const hasResumable = await this.checkpointManager.hasResumableSync();
    if (hasResumable) {
      this.emit('resume', { sessionId: '' });
    }

    this.status = 'idle';
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Cancel any running executor
    if (this.executor) {
      this.executor.cancel();
      this.executor = null;
    }

    await this.registry.cleanupAll();
    this.checkpointManager.close();
    this.syncStorage.close();
    this.listeners.clear();
  }

  /**
   * Destroy the engine (alias for cleanup)
   */
  destroy(): void {
    this.cleanup();
  }

  // ==========================================================================
  // Sync Operations
  // ==========================================================================

  /**
   * Run sync with given options
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const mode = options.mode || this.config.defaultMode;
    const adapters = options.adapters || this.getEnabledAdapters();

    // Create session
    const session = this.createSession(mode, adapters);
    this.currentSession = session;

    this.emit('start', { session });
    this.startTime = Date.now();
    this.processedCount = 0;
    this.createdCount = 0;
    this.updatedCount = 0;
    this.deletedCount = 0;
    this.abortController = new AbortController();

    try {
      this.status = 'detecting-changes';

      // Detect changes from all adapters
      const changes = await this.detectAllChanges(
        adapters,
        mode === 'incremental' ? options.since : undefined
      );

      session.totalItems = changes.length;
      this.pendingQueue = changes;

      // Create initial checkpoint
      await this.checkpointManager.createCheckpoint(session);

      // Process changes
      this.status = 'syncing';
      const results = await this.processChanges(changes, options);

      // Handle conflicts
      if (this.conflicts.length > 0) {
        this.status = 'resolving-conflicts';
        await this.resolveConflicts(options.conflictStrategy);
      }

      // Complete session
      session.completedAt = new Date();
      await this.checkpointManager.completeCheckpoint(session.id);

      const result = this.buildResult(session, true);
      this.emit('complete', { session });

      return result;
    } catch (error) {
      const syncError = this.createSyncError(error);
      session.errors.push(syncError);
      this.emit('error', { error: syncError });

      return this.buildResult(session, false);
    } finally {
      this.status = 'idle';
      this.currentSession = null;
      this.abortController = null;
    }
  }

  /**
   * Full sync (all adapters, rebuild everything)
   */
  async fullSync(options: Omit<SyncOptions, 'mode'> = {}): Promise<SyncResult> {
    return this.sync({ ...options, mode: 'full' });
  }

  /**
   * Incremental sync (only changes since last sync)
   */
  async incrementalSync(options: Omit<SyncOptions, 'mode'> = {}): Promise<SyncResult> {
    const settings = this.getSettings();
    // Get last sync time from settings or use 24 hours ago
    const since = options.since || new Date(Date.now() - 24 * 60 * 60 * 1000);

    return this.sync({ ...options, mode: 'incremental', since });
  }

  /**
   * Resume an interrupted sync
   */
  async resumeIfIncomplete(): Promise<SyncResult | null> {
    const incomplete = await this.checkpointManager.getMostRecentIncomplete();
    if (!incomplete) return null;

    const checkpoint = incomplete.checkpoint;

    // Recreate session from checkpoint
    const session = this.createSession(
      'incremental',
      Object.keys(checkpoint.adapterProgress) as SyncAdapterType[]
    );
    session.id = checkpoint.sessionId;
    this.currentSession = session;

    this.emit('resume', { sessionId: session.id });

    try {
      this.status = 'syncing';
      this.pendingQueue = checkpoint.pendingChanges;
      this.conflicts = checkpoint.pendingConflicts;

      // Resume processing
      const results = await this.processChanges(checkpoint.pendingChanges, {});

      // Complete
      session.completedAt = new Date();
      await this.checkpointManager.completeCheckpoint(session.id);

      return this.buildResult(session, true);
    } catch (error) {
      const syncError = this.createSyncError(error);
      session.errors.push(syncError);

      return this.buildResult(session, false);
    } finally {
      this.status = 'idle';
      this.currentSession = null;
    }
  }

  /**
   * Cancel current sync
   */
  async cancel(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }

    if (this.currentSession) {
      this.emit('cancel', { sessionId: this.currentSession.id });
    }

    this.status = 'idle';
  }

  /**
   * Pause current sync
   */
  async pause(): Promise<void> {
    if (this.currentSession) {
      this.status = 'paused';
      this.emit('pause', { sessionId: this.currentSession.id });

      // Save checkpoint
      await this.checkpointManager.updateCheckpoint(this.currentSession.id, {
        pendingChanges: this.pendingQueue,
        pendingConflicts: this.conflicts,
      });
    }
  }

  // ==========================================================================
  // Change Detection
  // ==========================================================================

  /**
   * Detect changes from all specified adapters
   */
  private async detectAllChanges(
    adapterTypes: SyncAdapterType[],
    since?: Date
  ): Promise<SyncChange[]> {
    const allChanges: SyncChange[] = [];

    for (const type of adapterTypes) {
      const adapter = this.registry.get(type);
      if (!adapter) continue;

      try {
        const changes = await adapter.detectChanges(since);
        allChanges.push(...changes);

        for (const change of changes) {
          this.emit('change-detected', { change });
        }
      } catch (error) {
        console.error(`Change detection failed for ${type}:`, error);
      }
    }

    return allChanges;
  }

  // ==========================================================================
  // Change Processing
  // ==========================================================================

  /**
   * Process all changes with parallel execution using ParallelExecutor
   */
  private async processChanges(
    changes: SyncChange[],
    options: SyncOptions
  ): Promise<void> {
    if (changes.length === 0) return;

    const checkpointInterval = this.config.checkpointInterval;

    // Create executor with rate limiting
    this.executor = new ParallelExecutor<void>({
      concurrency: this.config.concurrency,
      maxRetries: this.config.retryCount,
      retryDelay: this.config.retryDelay,
      taskTimeout: this.config.requestTimeout,
      rateLimiter: this.rateLimiter,
      debug: this.config.debug,
    });

    // Add all changes as tasks
    for (const change of changes) {
      this.executor.addTask(
        change.id,
        async () => {
          await this.processChange(change, options);
        },
        {
          priority: this.getChangePriority(change),
          metadata: {
            entityType: change.entityType,
            entityId: change.entityId,
            operation: change.operation,
          },
        }
      );
    }

    // Execute with progress tracking
    let lastCheckpointCount = 0;

    await this.executor.execute(async (progress: ExecutorProgress) => {
      this.processedCount = progress.completed + progress.failed;
      this.emitProgress();

      // Checkpoint at intervals
      if (this.processedCount - lastCheckpointCount >= checkpointInterval) {
        await this.saveCheckpoint();
        lastCheckpointCount = this.processedCount;
      }

      // Handle pause
      if (this.status === 'paused') {
        this.executor?.pause();
      }

      // Handle cancel
      if (this.abortController?.signal.aborted) {
        this.executor?.cancel();
      }
    });

    // Final checkpoint
    await this.saveCheckpoint();

    this.executor = null;
  }

  /**
   * Get priority for a change based on type
   */
  private getChangePriority(change: SyncChange): 'high' | 'normal' | 'low' {
    // Deletes are processed first to free up resources
    if (change.operation === 'delete') return 'high';
    // Metadata updates are lower priority
    if (change.entityType === 'metadata') return 'low';
    // Everything else is normal
    return 'normal';
  }

  /**
   * Process a single change
   */
  private async processChange(
    change: SyncChange,
    options: SyncOptions
  ): Promise<void> {
    const adapter = this.registry.get(change.source);
    if (!adapter) return;

    try {
      // Check for conflicts
      const conflict = await this.detectConflict(change);
      if (conflict) {
        this.conflicts.push(conflict);
        this.emit('conflict-detected', { conflict });
        return;
      }

      // Apply change
      if (!options.dryRun) {
        const result = await adapter.applyChange(change);
        if (!result.success) {
          throw new Error(result.error?.message || 'Apply failed');
        }

        // Track operation stats
        switch (change.operation) {
          case 'create':
            this.createdCount++;
            break;
          case 'update':
          case 'sync':
            this.updatedCount++;
            break;
          case 'delete':
            this.deletedCount++;
            break;
        }

        // Update delta state after successful apply
        if (change.hash) {
          await this.deltaTracker.updateState(change.source, [
            {
              id: change.entityId,
              type: change.entityType,
              hash: change.hash,
              lastModified: change.timestamp,
            },
          ]);
        }
      }

      // Remove from pending queue
      this.pendingQueue = this.pendingQueue.filter((c) => c.id !== change.id);
      this.emit('change-applied', { change });

      if (this.currentSession) {
        this.currentSession.processedItems++;
      }
    } catch (error) {
      const syncError = this.createSyncError(error, change.entityId);
      this.currentSession?.errors.push(syncError);
      this.emit('error', { error: syncError });
      throw error; // Re-throw so ParallelExecutor can handle retries
    }
  }

  // ==========================================================================
  // Conflict Detection & Resolution
  // ==========================================================================

  /**
   * Detect if a change conflicts with local state
   *
   * A conflict exists when:
   * 1. There's an existing local state for the entity
   * 2. The local state was modified after the last sync
   * 3. The remote change also modified the entity (different hash/timestamp)
   */
  private async detectConflict(change: SyncChange): Promise<SyncConflict | null> {
    // Skip conflict detection for deletes - they're handled specially
    if (change.operation === 'delete') {
      // Check if local has unsaved modifications to an entity being deleted remotely
      const localState = await this.deltaTracker.getState(change.source, change.entityId);
      if (localState && this.hasLocalModifications(localState)) {
        return this.createDeleteConflict(change, localState);
      }
      return null;
    }

    // Get all adapter types to check for cross-adapter conflicts
    const otherAdapters = this.registry
      .getAll()
      .filter(a => a.type !== change.source)
      .map(a => a.type);

    // Check each potential source of local state
    for (const adapterType of otherAdapters) {
      const localState = await this.deltaTracker.getState(adapterType, change.entityId);
      if (!localState) continue;

      // Check if local was modified after last sync
      if (!this.hasLocalModifications(localState)) continue;

      // Check for hash mismatch (indicates both sides modified the entity)
      if (change.hash && localState.hash && change.hash === localState.hash) {
        // Same content, no conflict
        continue;
      }

      // Check timestamp overlap (both modified since last sync)
      const remoteModified = change.timestamp.getTime();
      const localModified = localState.lastModified.getTime();
      const lastSynced = localState.lastSynced.getTime();

      // If both were modified after last sync, it's a conflict
      if (localModified > lastSynced && remoteModified > lastSynced) {
        return this.createConflict(change, localState, adapterType);
      }
    }

    // Also check the same adapter for field-level conflicts
    const sameAdapterState = await this.deltaTracker.getState(change.source, change.entityId);
    if (sameAdapterState && this.hasLocalModifications(sameAdapterState)) {
      // Check for field-level conflicts in metadata changes
      if (change.entityType === 'metadata' && change.fieldChanges) {
        const fieldConflict = await this.detectFieldConflict(change, sameAdapterState);
        if (fieldConflict) {
          return fieldConflict;
        }
      }
    }

    return null;
  }

  /**
   * Check if local state has modifications since last sync
   */
  private hasLocalModifications(state: import('./delta-tracker').DeltaState): boolean {
    const lastModified = state.lastModified.getTime();
    const lastSynced = state.lastSynced.getTime();

    // Allow a small grace period (1 second) to handle timestamp precision issues
    return lastModified > lastSynced + 1000;
  }

  /**
   * Create a conflict for a delete operation conflicting with local modifications
   */
  private createDeleteConflict(
    change: SyncChange,
    localState: import('./delta-tracker').DeltaState
  ): SyncConflict {
    // Create a synthetic local change representing the unsaved modifications
    const localChange: SyncChange = {
      id: crypto.randomUUID(),
      source: localState.source,
      entityType: change.entityType,
      entityId: change.entityId,
      operation: 'update',
      timestamp: localState.lastModified,
      hash: localState.hash,
    };

    return {
      id: crypto.randomUUID(),
      entityType: change.entityType,
      entityId: change.entityId,
      localChange,
      remoteChange: change,
      localValue: `[Local modifications exist for this ${change.entityType}]`,
      remoteValue: '[Entity will be deleted]',
      resolved: false,
    };
  }

  /**
   * Create a conflict between local and remote changes
   */
  private async createConflict(
    remoteChange: SyncChange,
    localState: import('./delta-tracker').DeltaState,
    localAdapterType: SyncAdapterType
  ): Promise<SyncConflict> {
    // Create a synthetic local change
    const localChange: SyncChange = {
      id: crypto.randomUUID(),
      source: localAdapterType,
      entityType: remoteChange.entityType,
      entityId: remoteChange.entityId,
      operation: 'update',
      timestamp: localState.lastModified,
      hash: localState.hash,
    };

    // Try to get actual values for display
    let localValue: unknown = `[Modified at ${localState.lastModified.toISOString()}]`;
    let remoteValue: unknown = remoteChange.data;

    // Attempt to fetch local data from adapter
    const localAdapter = this.registry.get(localAdapterType);
    if (localAdapter) {
      try {
        // This would require adapters to implement a getData method
        // For now, use available metadata
        localValue = {
          hash: localState.hash,
          lastModified: localState.lastModified.toISOString(),
          source: localState.source,
        };
      } catch (e) {
        // Use fallback
      }
    }

    return {
      id: crypto.randomUUID(),
      entityType: remoteChange.entityType,
      entityId: remoteChange.entityId,
      localChange,
      remoteChange,
      localValue,
      remoteValue,
      resolved: false,
    };
  }

  /**
   * Detect field-level conflicts for metadata changes
   */
  private async detectFieldConflict(
    change: SyncChange,
    localState: import('./delta-tracker').DeltaState
  ): Promise<SyncConflict | null> {
    if (!change.fieldChanges || change.fieldChanges.length === 0) {
      return null;
    }

    // For field-level conflicts, we create a single conflict with the first conflicting field
    // A more sophisticated implementation might track all conflicting fields
    for (const fieldChange of change.fieldChanges) {
      // Check if the local state has a different value for this field
      // This requires comparing with what we know about local state
      // Since we only have the hash, we can infer conflict from hash mismatch

      if (localState.hash !== change.hash) {
        // Create a field-specific conflict
        const localChange: SyncChange = {
          id: crypto.randomUUID(),
          source: localState.source,
          entityType: change.entityType,
          entityId: change.entityId,
          operation: 'update',
          timestamp: localState.lastModified,
          hash: localState.hash,
          fieldChanges: [{
            field: fieldChange.field,
            oldValue: fieldChange.oldValue,
            newValue: '[local value unknown]',
            timestamp: localState.lastModified,
          }],
        };

        return {
          id: crypto.randomUUID(),
          entityType: change.entityType,
          entityId: change.entityId,
          field: fieldChange.field,
          localChange,
          remoteChange: change,
          localValue: `[Local value for ${fieldChange.field}]`,
          remoteValue: fieldChange.newValue,
          resolved: false,
        };
      }
    }

    return null;
  }

  /**
   * Resolve all pending conflicts
   */
  private async resolveConflicts(strategy?: ConflictStrategy): Promise<void> {
    const resolveStrategy = strategy || this.config.defaultConflictStrategy;

    for (const conflict of this.conflicts) {
      if (conflict.resolved) continue;

      switch (resolveStrategy) {
        case 'last-write-wins':
          conflict.resolvedValue =
            conflict.localChange.timestamp > conflict.remoteChange.timestamp
              ? conflict.localValue
              : conflict.remoteValue;
          break;

        case 'prefer-local':
          conflict.resolvedValue = conflict.localValue;
          break;

        case 'prefer-remote':
          conflict.resolvedValue = conflict.remoteValue;
          break;

        case 'merge':
          conflict.resolvedValue = this.mergeValues(
            conflict.localValue,
            conflict.remoteValue
          );
          break;

        case 'ask-user':
          // Will be handled by UI
          continue;
      }

      conflict.resolved = true;
      conflict.resolutionStrategy = resolveStrategy;
      this.emit('conflict-resolved', { conflict });
    }
  }

  /**
   * Merge two values (for arrays, union; for objects, deep merge)
   */
  private mergeValues(local: unknown, remote: unknown): unknown {
    if (Array.isArray(local) && Array.isArray(remote)) {
      // Union arrays
      return [...new Set([...local, ...remote])];
    }

    if (typeof local === 'object' && typeof remote === 'object' && local && remote) {
      // Deep merge objects
      return { ...local, ...remote };
    }

    // Default to remote for primitives
    return remote;
  }

  // ==========================================================================
  // Progress & Checkpoints
  // ==========================================================================

  /**
   * Emit progress event
   */
  private emitProgress(): void {
    if (!this.currentSession) return;

    const elapsed = Date.now() - this.startTime;
    const speed = this.processedCount / (elapsed / 1000);
    const remaining = this.currentSession.totalItems - this.processedCount;
    const eta = remaining / speed;

    const progress: SyncProgress = {
      sessionId: this.currentSession.id,
      status: this.status,
      phase: this.getPhaseDescription(),
      total: this.currentSession.totalItems,
      processed: this.processedCount,
      skipped: this.currentSession.skippedItems,
      errors: this.currentSession.errors.length,
      percentage: Math.round(
        (this.processedCount / this.currentSession.totalItems) * 100
      ),
      speed,
      eta,
    };

    this.emit('progress', progress);
  }

  /**
   * Save current checkpoint
   */
  private async saveCheckpoint(): Promise<void> {
    if (!this.currentSession) return;

    const checkpoint = await this.checkpointManager.updateCheckpoint(
      this.currentSession.id,
      {
        pendingChanges: this.pendingQueue,
        pendingConflicts: this.conflicts.filter((c) => !c.resolved),
      }
    );

    if (checkpoint) {
      this.emit('checkpoint', { checkpoint });
    }
  }

  // ==========================================================================
  // Adapter Management
  // ==========================================================================

  /**
   * Get adapter by type
   */
  getAdapter(type: SyncAdapterType): SyncAdapter | undefined {
    return this.registry.get(type);
  }

  /**
   * Get all adapters
   */
  getAllAdapters(): SyncAdapter[] {
    return this.registry.getAll();
  }

  /**
   * Get enabled adapter types based on settings
   */
  private getEnabledAdapters(): SyncAdapterType[] {
    const settings = this.getSettings();
    const adapters: SyncAdapterType[] = [];

    if (settings.calibreEnabled) {
      adapters.push('calibre');
    }

    if (settings.serverEnabled) {
      adapters.push('server');
    }

    return adapters;
  }

  /**
   * Connect all adapters
   */
  async connectAll(): Promise<Map<SyncAdapterType, boolean>> {
    const results = new Map<SyncAdapterType, boolean>();

    for (const adapter of this.registry.getAll()) {
      try {
        await adapter.connect();
        results.set(adapter.type, true);
      } catch {
        results.set(adapter.type, false);
      }
    }

    return results;
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  /**
   * Subscribe to an event
   * @returns Unsubscribe function
   */
  on<K extends keyof SyncEngineEvents>(
    event: K,
    listener: SyncEventListener<K>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as SyncEventListener<keyof SyncEngineEvents>);

    // Return unsubscribe function
    return () => {
      this.off(event, listener);
    };
  }

  /**
   * Unsubscribe from an event
   */
  off<K extends keyof SyncEngineEvents>(
    event: K,
    listener: SyncEventListener<K>
  ): void {
    this.listeners.get(event)?.delete(listener as SyncEventListener<keyof SyncEngineEvents>);
  }

  /**
   * Emit an event
   */
  private emit<K extends keyof SyncEngineEvents>(
    event: K,
    data: SyncEngineEvents[K]
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          (listener as SyncEventListener<K>)(data);
        } catch (error) {
          console.error(`Event listener error for ${event}:`, error);
        }
      }
    }
  }

  // ==========================================================================
  // State Accessors
  // ==========================================================================

  /**
   * Get current status
   */
  getStatus(): SyncEngineStatus {
    return this.status;
  }

  /**
   * Get current session
   */
  getCurrentSession(): SyncSession | null {
    return this.currentSession;
  }

  /**
   * Get pending changes
   */
  getPendingChanges(): SyncChange[] {
    return [...this.pendingQueue];
  }

  /**
   * Get conflicts
   */
  getConflicts(): SyncConflict[] {
    return [...this.conflicts];
  }

  /**
   * Get unresolved conflicts
   */
  getUnresolvedConflicts(): SyncConflict[] {
    return this.conflicts.filter((c) => !c.resolved);
  }

  /**
   * Check if there's a resumable sync session
   */
  async hasResumableSync(): Promise<boolean> {
    return this.checkpointManager.hasResumableSync();
  }

  /**
   * Get current progress
   */
  getProgress(): SyncProgress | null {
    if (!this.currentSession) return null;

    const elapsed = Date.now() - this.startTime;
    const speed = this.processedCount / (elapsed / 1000);
    const remaining = this.currentSession.totalItems - this.processedCount;
    const eta = speed > 0 ? remaining / speed : undefined;

    return {
      sessionId: this.currentSession.id,
      status: this.status,
      phase: this.getPhaseDescription(),
      total: this.currentSession.totalItems,
      processed: this.processedCount,
      skipped: this.currentSession.skippedItems,
      errors: this.currentSession.errors.length,
      percentage: this.currentSession.totalItems > 0
        ? Math.round((this.processedCount / this.currentSession.totalItems) * 100)
        : 0,
      speed,
      eta,
    };
  }

  /**
   * Register an adapter
   */
  registerAdapter(adapter: SyncAdapter): void {
    this.registry.register(adapter);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Create a new session
   */
  private createSession(mode: SyncMode, adapters: SyncAdapterType[]): SyncSession {
    return {
      id: crypto.randomUUID(),
      startedAt: new Date(),
      mode,
      adapters,
      totalItems: 0,
      processedItems: 0,
      skippedItems: 0,
      errorItems: 0,
      conflicts: [],
      errors: [],
    };
  }

  /**
   * Build sync result
   */
  private buildResult(session: SyncSession, success: boolean): SyncResult {
    const duration = Date.now() - this.startTime;
    const succeeded = this.createdCount + this.updatedCount + this.deletedCount;

    return {
      success,
      session,
      stats: {
        total: session.totalItems,
        processed: session.processedItems,
        succeeded,
        skipped: session.skippedItems,
        created: this.createdCount,
        updated: this.updatedCount,
        deleted: this.deletedCount,
        failed: session.errors.length,
        errors: session.errors.length,
        conflicts: {
          detected: this.conflicts.length,
          autoResolved: this.conflicts.filter((c) => c.resolved).length,
          manualRequired: this.conflicts.filter((c) => !c.resolved).length,
        },
      },
      duration,
    };
  }

  /**
   * Create sync error
   */
  private createSyncError(error: unknown, entityId?: string): SyncError {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;

    return {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      message,
      entityId,
      recoverable: true,
      stack,
    };
  }

  /**
   * Get phase description
   */
  private getPhaseDescription(): string {
    switch (this.status) {
      case 'initializing':
        return 'Initializing sync...';
      case 'detecting-changes':
        return 'Detecting changes...';
      case 'syncing':
        return 'Syncing items...';
      case 'resolving-conflicts':
        return 'Resolving conflicts...';
      case 'checkpointing':
        return 'Saving checkpoint...';
      case 'completing':
        return 'Completing sync...';
      case 'paused':
        return 'Sync paused';
      case 'error':
        return 'Sync error';
      default:
        return 'Idle';
    }
  }
}

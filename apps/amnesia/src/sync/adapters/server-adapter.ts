/**
 * Server Sync Adapter
 *
 * Wraps AmnesiaClient to provide unified sync interface.
 * Handles progress, highlights, and notes sync with the Amnesia Server.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type { App } from 'obsidian';
import type { AmnesiaClient, ReadingProgress, ServerHighlight } from '../../server/amnesia-client';
import type { LibrosSettings } from '../../settings/settings';

import {
  BaseSyncAdapter,
  type AdapterCapabilities,
} from '../sync-adapter';

import type {
  SyncChange,
  SyncManifest,
  ManifestEntry,
  PaginationOptions,
  AsyncResult,
  BatchOperation,
  BatchOperationResult,
} from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Server sync data types
 */
export type ServerSyncData =
  | { type: 'progress'; data: ReadingProgress }
  | { type: 'highlight'; data: ServerHighlight }
  | { type: 'note'; data: unknown };

// ============================================================================
// Server Sync Adapter
// ============================================================================

/**
 * Adapter for syncing with Amnesia Server
 *
 * Wraps the AmnesiaClient and provides:
 * - Progress sync (reading position, percentage)
 * - Highlights sync (annotations, notes)
 * - Batch operations for efficiency
 */
export class ServerSyncAdapter extends BaseSyncAdapter {
  readonly type = 'server' as const;
  readonly name = 'Amnesia Server';

  readonly capabilities: AdapterCapabilities = {
    incrementalSync: true,
    batchOperations: true,
    contentHashing: true,
    resumable: true,
    bidirectional: true,
    parallelRequests: true,
    maxConcurrency: 10,
    entityTypes: ['progress', 'highlight', 'note'],
  };

  private app: App;
  private client: AmnesiaClient;
  private getSettings: () => LibrosSettings;

  constructor(
    app: App,
    client: AmnesiaClient,
    getSettings: () => LibrosSettings
  ) {
    super();
    this.app = app;
    this.client = client;
    this.getSettings = getSettings;
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  async connect(): Promise<void> {
    try {
      this.setStatus('connecting');
      const connected = await this.client.testConnection();
      if (!connected) {
        throw new Error('Failed to connect to Amnesia Server');
      }
      this.setStatus('connected');
    } catch (error) {
      this.setStatus('error');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // AmnesiaClient doesn't have explicit disconnect
    this.setStatus('disconnected');
  }

  async testConnection(): Promise<boolean> {
    return this.client.testConnection();
  }

  // ==========================================================================
  // Change Detection
  // ==========================================================================

  /**
   * Detect changes from server since given timestamp
   *
   * TODO: Implement when server supports /api/v1/sync/changes endpoint
   */
  async detectChanges(
    since?: Date,
    entityTypes?: SyncChange['entityType'][]
  ): Promise<SyncChange[]> {
    const changes: SyncChange[] = [];
    const settings = this.getSettings();

    // For now, we can only detect changes by comparing with local state
    // Full implementation requires server-side change tracking API

    if (!entityTypes || entityTypes.includes('progress')) {
      // TODO: Fetch progress changes from server
      // const progressChanges = await this.client.getProgressChanges(since);
    }

    if (!entityTypes || entityTypes.includes('highlight')) {
      // TODO: Fetch highlight changes from server
      // const highlightChanges = await this.client.getHighlightChanges(since);
    }

    return changes;
  }

  /**
   * Generate manifest of server entities
   *
   * TODO: Implement when server supports manifest endpoint
   */
  async getManifest(
    entityTypes?: SyncChange['entityType'][],
    pagination?: PaginationOptions
  ): Promise<SyncManifest> {
    const entries: ManifestEntry[] = [];

    // TODO: Implement manifest generation from server

    return {
      version: 1,
      generatedAt: new Date(),
      source: 'server',
      entries,
      totalCount: entries.length,
      totalSize: 0,
    };
  }

  /**
   * Compare local manifest with server
   */
  async compareManifest(localManifest: ManifestEntry[]): Promise<SyncChange[]> {
    const remoteManifest = await this.getManifest();
    const changes: SyncChange[] = [];

    // TODO: Implement manifest comparison

    return changes;
  }

  // ==========================================================================
  // Data Operations
  // ==========================================================================

  /**
   * Get entity from server
   */
  async getEntity(
    entityType: SyncChange['entityType'],
    entityId: string
  ): AsyncResult<unknown> {
    try {
      switch (entityType) {
        case 'progress': {
          const progress = await this.client.getProgress(entityId);
          return this.success(progress);
        }
        case 'highlight': {
          const highlights = await this.client.getHighlights(entityId);
          const highlight = highlights.find((h) => h.id === entityId);
          return this.success(highlight || null);
        }
        default:
          return this.failure(
            this.createError(`Unsupported entity type: ${entityType}`)
          );
      }
    } catch (error) {
      return this.failure(
        this.createError(
          `Failed to get entity: ${error instanceof Error ? error.message : 'Unknown error'}`,
          { entityId }
        )
      );
    }
  }

  /**
   * Get multiple entities from server
   */
  async getEntities(
    entityType: SyncChange['entityType'],
    entityIds: string[]
  ): AsyncResult<Map<string, unknown>> {
    try {
      const result = new Map<string, unknown>();

      // TODO: Implement batch fetch when server supports it
      for (const id of entityIds) {
        const entityResult = await this.getEntity(entityType, id);
        if (entityResult.success && entityResult.data) {
          result.set(id, entityResult.data);
        }
      }

      return this.success(result);
    } catch (error) {
      return this.failure(
        this.createError(
          `Failed to get entities: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      );
    }
  }

  /**
   * Apply a change to the server
   */
  async applyChange(change: SyncChange): AsyncResult<void> {
    try {
      switch (change.entityType) {
        case 'progress': {
          const progress = change.data as ReadingProgress;
          if (change.operation === 'delete') {
            // TODO: Implement progress deletion
          } else {
            await this.client.updateProgress(progress.bookId, progress);
          }
          break;
        }

        case 'highlight': {
          const highlight = change.data as ServerHighlight;
          if (change.operation === 'delete') {
            await this.client.deleteHighlight(highlight.id);
          } else if (change.operation === 'create') {
            await this.client.createHighlight(highlight);
          } else {
            // Update: delete and recreate since no updateHighlight exists
            await this.client.deleteHighlight(highlight.id);
            await this.client.createHighlight(highlight);
          }
          break;
        }

        default:
          return this.failure(
            this.createError(`Unsupported entity type: ${change.entityType}`)
          );
      }

      this.updateLastSync();
      return this.success(undefined);
    } catch (error) {
      return this.failure(
        this.createError(
          `Failed to apply change: ${error instanceof Error ? error.message : 'Unknown error'}`,
          { entityId: change.entityId }
        )
      );
    }
  }

  // ==========================================================================
  // Batch Operations
  // ==========================================================================

  /**
   * Execute batch operations
   *
   * TODO: Implement when server supports /api/v1/books/batch
   */
  async executeBatch(operations: BatchOperation[]): Promise<BatchOperationResult[]> {
    const results: BatchOperationResult[] = [];

    // For now, execute sequentially
    for (const op of operations) {
      try {
        const change: SyncChange = {
          id: this.generateChangeId(),
          source: 'server',
          entityType: op.type,
          entityId: op.id,
          operation: op.op === 'get' ? 'sync' : op.op,
          timestamp: new Date(),
          data: op.data,
        };

        const result = await this.applyChange(change);
        results.push({
          id: op.id,
          success: result.success,
          data: result.data,
          error: result.error?.message,
        });
      } catch (error) {
        results.push({
          id: op.id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  /**
   * Sync progress for a book
   */
  async syncProgress(bookId: string, localProgress: ReadingProgress): Promise<ReadingProgress> {
    try {
      const serverProgress = await this.client.getProgress(bookId);

      if (!serverProgress) {
        // No server progress, push local
        await this.client.updateProgress(bookId, localProgress);
        return localProgress;
      }

      // Compare timestamps for conflict resolution
      if (localProgress.updatedAt > serverProgress.updatedAt) {
        // Local is newer, push to server
        await this.client.updateProgress(bookId, localProgress);
        return localProgress;
      } else {
        // Server is newer, return server progress
        return serverProgress;
      }
    } catch (error) {
      console.error('Progress sync failed:', error);
      return localProgress;
    }
  }

  /**
   * Sync highlights for a book
   */
  async syncHighlights(bookId: string, localHighlights: ServerHighlight[]): Promise<ServerHighlight[]> {
    try {
      const serverHighlights = await this.client.getHighlights(bookId);

      // Merge highlights (union strategy)
      const merged = new Map<string, ServerHighlight>();

      // Add all server highlights
      for (const h of serverHighlights) {
        merged.set(h.id, h);
      }

      // Add/update local highlights
      for (const h of localHighlights) {
        const existing = merged.get(h.id);
        if (!existing || h.updatedAt > existing.updatedAt) {
          merged.set(h.id, h);
          // Push to server if newer
          if (!existing) {
            await this.client.createHighlight(h);
          } else {
            // Update: delete and recreate since no updateHighlight exists
            await this.client.deleteHighlight(h.id);
            await this.client.createHighlight(h);
          }
        }
      }

      return Array.from(merged.values());
    } catch (error) {
      console.error('Highlights sync failed:', error);
      return localHighlights;
    }
  }

  /**
   * Push local progress to server
   */
  async pushProgress(bookId: string, progress: ReadingProgress): Promise<void> {
    await this.client.updateProgress(bookId, progress);
    this.updateLastSync();
  }

  /**
   * Pull progress from server
   */
  async pullProgress(bookId: string): Promise<ReadingProgress | null> {
    return this.client.getProgress(bookId);
  }

  /**
   * Push highlights to server
   */
  async pushHighlights(bookId: string, highlights: ServerHighlight[]): Promise<void> {
    for (const highlight of highlights) {
      await this.client.createHighlight(highlight);
    }
    this.updateLastSync();
  }

  /**
   * Pull highlights from server
   */
  async pullHighlights(bookId: string): Promise<ServerHighlight[]> {
    return this.client.getHighlights(bookId);
  }
}

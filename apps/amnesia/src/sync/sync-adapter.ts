/**
 * Sync Adapter Interface
 *
 * Base interface for all sync adapters (Calibre, Server, File).
 * Adapters wrap existing services and provide a unified API for the sync engine.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type {
  SyncAdapterType,
  SyncChange,
  SyncManifest,
  ManifestEntry,
  BatchOperation,
  BatchOperationResult,
  TimeRange,
  PaginationOptions,
  AsyncResult,
  SyncError,
} from './types';

// ============================================================================
// Adapter State Types
// ============================================================================

/**
 * Adapter connection status
 */
export type AdapterStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Adapter capabilities
 */
export interface AdapterCapabilities {
  /** Supports incremental sync */
  incrementalSync: boolean;
  /** Supports batch operations */
  batchOperations: boolean;
  /** Supports content hashing */
  contentHashing: boolean;
  /** Supports resumable operations */
  resumable: boolean;
  /** Supports bidirectional sync */
  bidirectional: boolean;
  /** Supports parallel requests */
  parallelRequests: boolean;
  /** Maximum concurrent operations */
  maxConcurrency: number;
  /** Supported entity types */
  entityTypes: SyncChange['entityType'][];
}

/**
 * Adapter statistics
 */
export interface AdapterStats {
  /** Total entities */
  totalEntities: number;
  /** Last sync timestamp */
  lastSyncAt: Date | null;
  /** Total data size (bytes) */
  totalSize: number;
  /** Pending changes count */
  pendingChanges: number;
  /** Error count since last sync */
  errorCount: number;
}

// ============================================================================
// Base Adapter Interface
// ============================================================================

/**
 * Base interface for sync adapters
 *
 * Each adapter wraps an existing service (CalibreService, AmnesiaClient, ChunkedUploader)
 * and provides a unified API for the UnifiedSyncEngine.
 */
export interface SyncAdapter {
  // ==========================================================================
  // Identity & Configuration
  // ==========================================================================

  /** Adapter type identifier */
  readonly type: SyncAdapterType;

  /** Human-readable name */
  readonly name: string;

  /** Adapter capabilities */
  readonly capabilities: AdapterCapabilities;

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  /**
   * Get current connection status
   */
  getStatus(): AdapterStatus;

  /**
   * Connect to the data source
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the data source
   */
  disconnect(): Promise<void>;

  /**
   * Test connection health
   */
  testConnection(): Promise<boolean>;

  // ==========================================================================
  // Change Detection
  // ==========================================================================

  /**
   * Detect changes since a given timestamp
   *
   * @param since - Only return changes after this timestamp
   * @param entityTypes - Filter by entity types (optional)
   * @returns List of detected changes
   */
  detectChanges(
    since?: Date,
    entityTypes?: SyncChange['entityType'][]
  ): Promise<SyncChange[]>;

  /**
   * Generate a manifest of all entities for full comparison
   *
   * @param entityTypes - Filter by entity types (optional)
   * @param pagination - Pagination options for large datasets
   * @returns Manifest of entities
   */
  getManifest(
    entityTypes?: SyncChange['entityType'][],
    pagination?: PaginationOptions
  ): Promise<SyncManifest>;

  /**
   * Compare local manifest with remote and return differences
   *
   * @param localManifest - Local manifest entries
   * @returns Changes representing the differences
   */
  compareManifest(localManifest: ManifestEntry[]): Promise<SyncChange[]>;

  // ==========================================================================
  // Data Operations
  // ==========================================================================

  /**
   * Get entity by ID
   *
   * @param entityType - Type of entity
   * @param entityId - Entity ID
   * @returns Entity data or null if not found
   */
  getEntity(
    entityType: SyncChange['entityType'],
    entityId: string
  ): AsyncResult<unknown>;

  /**
   * Get multiple entities
   *
   * @param entityType - Type of entities
   * @param entityIds - Entity IDs
   * @returns Map of entity ID to data
   */
  getEntities(
    entityType: SyncChange['entityType'],
    entityIds: string[]
  ): AsyncResult<Map<string, unknown>>;

  /**
   * Apply a change from the sync engine
   *
   * @param change - The change to apply
   * @returns Success status and any resulting data
   */
  applyChange(change: SyncChange): AsyncResult<void>;

  /**
   * Apply multiple changes in batch
   *
   * @param changes - Changes to apply
   * @returns Results for each change
   */
  applyChanges(changes: SyncChange[]): Promise<BatchOperationResult[]>;

  // ==========================================================================
  // Batch Operations (if supported)
  // ==========================================================================

  /**
   * Execute batch operations
   *
   * @param operations - Operations to execute
   * @returns Results for each operation
   */
  executeBatch?(operations: BatchOperation[]): Promise<BatchOperationResult[]>;

  // ==========================================================================
  // Statistics & Monitoring
  // ==========================================================================

  /**
   * Get adapter statistics
   */
  getStats(): Promise<AdapterStats>;

  /**
   * Reset statistics
   */
  resetStats(): void;

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Initialize the adapter
   */
  initialize(): Promise<void>;

  /**
   * Cleanup resources
   */
  cleanup(): Promise<void>;
}

// ============================================================================
// Abstract Base Adapter Class
// ============================================================================

/**
 * Abstract base class for sync adapters
 *
 * Provides common functionality and event handling.
 * Concrete adapters extend this class and implement the abstract methods.
 */
export abstract class BaseSyncAdapter implements SyncAdapter {
  abstract readonly type: SyncAdapterType;
  abstract readonly name: string;
  abstract readonly capabilities: AdapterCapabilities;

  protected status: AdapterStatus = 'disconnected';
  protected lastError: SyncError | null = null;
  protected stats: AdapterStats = {
    totalEntities: 0,
    lastSyncAt: null,
    totalSize: 0,
    pendingChanges: 0,
    errorCount: 0,
  };

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  getStatus(): AdapterStatus {
    return this.status;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract testConnection(): Promise<boolean>;

  // ==========================================================================
  // Change Detection
  // ==========================================================================

  abstract detectChanges(
    since?: Date,
    entityTypes?: SyncChange['entityType'][]
  ): Promise<SyncChange[]>;

  abstract getManifest(
    entityTypes?: SyncChange['entityType'][],
    pagination?: PaginationOptions
  ): Promise<SyncManifest>;

  abstract compareManifest(localManifest: ManifestEntry[]): Promise<SyncChange[]>;

  // ==========================================================================
  // Data Operations
  // ==========================================================================

  abstract getEntity(
    entityType: SyncChange['entityType'],
    entityId: string
  ): AsyncResult<unknown>;

  abstract getEntities(
    entityType: SyncChange['entityType'],
    entityIds: string[]
  ): AsyncResult<Map<string, unknown>>;

  abstract applyChange(change: SyncChange): AsyncResult<void>;

  /**
   * Default implementation applies changes sequentially
   */
  async applyChanges(changes: SyncChange[]): Promise<BatchOperationResult[]> {
    const results: BatchOperationResult[] = [];

    for (const change of changes) {
      const result = await this.applyChange(change);
      results.push({
        id: change.entityId,
        success: result.success,
        error: result.error?.message,
      });
    }

    return results;
  }

  // ==========================================================================
  // Statistics & Monitoring
  // ==========================================================================

  async getStats(): Promise<AdapterStats> {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalEntities: 0,
      lastSyncAt: null,
      totalSize: 0,
      pendingChanges: 0,
      errorCount: 0,
    };
    this.lastError = null;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async initialize(): Promise<void> {
    // Override in subclasses if needed
  }

  async cleanup(): Promise<void> {
    await this.disconnect();
    this.resetStats();
  }

  // ==========================================================================
  // Protected Helpers
  // ==========================================================================

  /**
   * Set adapter status
   */
  protected setStatus(status: AdapterStatus): void {
    this.status = status;
  }

  /**
   * Record an error
   */
  protected recordError(error: SyncError): void {
    this.lastError = error;
    this.stats.errorCount++;
  }

  /**
   * Update last sync timestamp
   */
  protected updateLastSync(): void {
    this.stats.lastSyncAt = new Date();
  }

  /**
   * Create a success result
   */
  protected success<T>(data?: T): { success: true; data: T } {
    return { success: true, data: data as T };
  }

  /**
   * Create a failure result
   */
  protected failure(error: SyncError): { success: false; error: SyncError } {
    this.recordError(error);
    return { success: false, error };
  }

  /**
   * Create a sync error
   */
  protected createError(
    message: string,
    options: {
      code?: string;
      entityId?: string;
      recoverable?: boolean;
      stack?: string;
    } = {}
  ): SyncError {
    return {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      source: this.type,
      message,
      code: options.code,
      entityId: options.entityId,
      recoverable: options.recoverable ?? true,
      stack: options.stack,
    };
  }

  /**
   * Generate a change ID
   */
  protected generateChangeId(): string {
    return crypto.randomUUID();
  }

  /**
   * Hash content for deduplication
   */
  protected async hashContent(content: ArrayBuffer | string): Promise<string> {
    const data =
      typeof content === 'string'
        ? new TextEncoder().encode(content)
        : new Uint8Array(content);

    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

// ============================================================================
// Adapter Registry
// ============================================================================

/**
 * Registry for sync adapters
 */
export class AdapterRegistry {
  private adapters = new Map<SyncAdapterType, SyncAdapter>();

  /**
   * Register an adapter
   */
  register(adapter: SyncAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  /**
   * Unregister an adapter
   */
  unregister(type: SyncAdapterType): void {
    this.adapters.delete(type);
  }

  /**
   * Get an adapter by type
   */
  get(type: SyncAdapterType): SyncAdapter | undefined {
    return this.adapters.get(type);
  }

  /**
   * Get all registered adapters
   */
  getAll(): SyncAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Get adapters by capability
   */
  getByCapability(
    capability: keyof AdapterCapabilities
  ): SyncAdapter[] {
    return this.getAll().filter(
      (adapter) => adapter.capabilities[capability] === true
    );
  }

  /**
   * Check if an adapter is registered
   */
  has(type: SyncAdapterType): boolean {
    return this.adapters.has(type);
  }

  /**
   * Get count of registered adapters
   */
  get size(): number {
    return this.adapters.size;
  }

  /**
   * Initialize all adapters
   */
  async initializeAll(): Promise<void> {
    await Promise.all(this.getAll().map((a) => a.initialize()));
  }

  /**
   * Cleanup all adapters
   */
  async cleanupAll(): Promise<void> {
    await Promise.all(this.getAll().map((a) => a.cleanup()));
  }
}

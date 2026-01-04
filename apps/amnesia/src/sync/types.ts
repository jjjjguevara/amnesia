/**
 * Unified Sync Engine Types
 *
 * Core type definitions for the unified sync architecture.
 * Supports Calibre, Amnesia Server, and chunked file upload adapters.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

// ============================================================================
// Core Sync Types
// ============================================================================

/**
 * Sync adapter type identifier
 */
export type SyncAdapterType = 'calibre' | 'server' | 'file';

/**
 * Sync operation type
 */
export type SyncOperation = 'create' | 'update' | 'delete' | 'sync';

/**
 * Sync status for the engine
 */
export type SyncEngineStatus =
  | 'idle'
  | 'initializing'
  | 'detecting-changes'
  | 'syncing'
  | 'resolving-conflicts'
  | 'checkpointing'
  | 'completing'
  | 'paused'
  | 'error';

/**
 * Sync mode selection
 */
export type SyncMode =
  | 'incremental'  // Catch-up sync (only changes since last sync)
  | 'full'         // Full re-sync (rebuild entire library)
  | 'custom';      // Custom adapter selection

/**
 * Conflict resolution strategy
 */
export type ConflictStrategy =
  | 'last-write-wins'
  | 'prefer-local'
  | 'prefer-remote'
  | 'merge'
  | 'ask-user';

// ============================================================================
// Change Detection Types
// ============================================================================

/**
 * A detected change from a sync source
 */
export interface SyncChange {
  /** Unique change ID */
  id: string;
  /** Source adapter type */
  source: SyncAdapterType;
  /** Target entity type */
  entityType: 'book' | 'progress' | 'highlight' | 'note' | 'metadata' | 'file';
  /** Entity ID (book ID, highlight ID, etc.) */
  entityId: string;
  /** Operation type */
  operation: SyncOperation;
  /** Timestamp of the change */
  timestamp: Date;
  /** Content hash for deduplication */
  hash?: string;
  /** The actual change data */
  data?: unknown;
  /** Previous value (for updates) */
  previousData?: unknown;
  /** Field-level changes for metadata */
  fieldChanges?: FieldChange[];
}

/**
 * A field-level change within an entity
 */
export interface FieldChange {
  /** Field name/path */
  field: string;
  /** Old value */
  oldValue: unknown;
  /** New value */
  newValue: unknown;
  /** Change timestamp */
  timestamp: Date;
}

/**
 * A conflict between local and remote data
 */
export interface SyncConflict {
  /** Unique conflict ID */
  id: string;
  /** Entity type */
  entityType: SyncChange['entityType'];
  /** Entity ID */
  entityId: string;
  /** Local change */
  localChange: SyncChange;
  /** Remote change */
  remoteChange: SyncChange;
  /** Conflicting field (for metadata conflicts) */
  field?: string;
  /** Local value */
  localValue: unknown;
  /** Remote value */
  remoteValue: unknown;
  /** Resolution status */
  resolved: boolean;
  /** Resolution strategy used */
  resolutionStrategy?: ConflictStrategy;
  /** Resolved value */
  resolvedValue?: unknown;
}

// ============================================================================
// Sync Session Types
// ============================================================================

/**
 * A sync session representing one sync operation
 */
export interface SyncSession {
  /** Session ID */
  id: string;
  /** Session started timestamp */
  startedAt: Date;
  /** Session completed timestamp */
  completedAt?: Date;
  /** Sync mode */
  mode: SyncMode;
  /** Adapters involved */
  adapters: SyncAdapterType[];
  /** Total items to process */
  totalItems: number;
  /** Items processed */
  processedItems: number;
  /** Items skipped (unchanged) */
  skippedItems: number;
  /** Items with errors */
  errorItems: number;
  /** Conflicts detected */
  conflicts: SyncConflict[];
  /** Errors encountered */
  errors: SyncError[];
  /** Last checkpoint timestamp */
  lastCheckpoint?: Date;
  /** Checkpoint data for resume */
  checkpointData?: SyncCheckpoint;
}

/**
 * Checkpoint data for cross-session resume
 */
export interface SyncCheckpoint {
  /** Session ID */
  sessionId: string;
  /** Checkpoint timestamp */
  timestamp: Date;
  /** Last processed item index per adapter */
  adapterProgress: Record<SyncAdapterType, number>;
  /** Pending changes not yet processed */
  pendingChanges: SyncChange[];
  /** Pending conflicts not yet resolved */
  pendingConflicts: SyncConflict[];
  /** Last sync timestamp per adapter */
  lastSyncTimestamp: Record<SyncAdapterType, Date>;
}

/**
 * Sync error record
 */
export interface SyncError {
  /** Error ID */
  id: string;
  /** Timestamp */
  timestamp: Date;
  /** Source adapter */
  source?: SyncAdapterType;
  /** Entity ID if applicable */
  entityId?: string;
  /** Error message */
  message: string;
  /** Error code */
  code?: string;
  /** Is error recoverable */
  recoverable: boolean;
  /** Stack trace */
  stack?: string;
}

// ============================================================================
// Progress Tracking Types
// ============================================================================

/**
 * Sync progress event
 */
export interface SyncProgress {
  /** Session ID */
  sessionId: string;
  /** Current status */
  status: SyncEngineStatus;
  /** Current phase description */
  phase: string;
  /** Active adapter */
  activeAdapter?: SyncAdapterType;
  /** Total items */
  total: number;
  /** Processed items */
  processed: number;
  /** Skipped items */
  skipped: number;
  /** Error items */
  errors: number;
  /** Percentage (0-100) */
  percentage: number;
  /** Current item name */
  currentItem?: string;
  /** Estimated time remaining (seconds) */
  eta?: number;
  /** Processing speed (items/sec) */
  speed?: number;
  /** Memory usage (bytes) */
  memoryUsage?: number;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Sync engine event types
 */
export interface SyncEngineEvents {
  'start': { session: SyncSession };
  'progress': SyncProgress;
  'change-detected': { change: SyncChange };
  'change-applied': { change: SyncChange };
  'conflict-detected': { conflict: SyncConflict };
  'conflict-resolved': { conflict: SyncConflict };
  'checkpoint': { checkpoint: SyncCheckpoint };
  'error': { error: SyncError };
  'complete': { session: SyncSession };
  'cancel': { sessionId: string };
  'pause': { sessionId: string };
  'resume': { sessionId: string };
}

/**
 * Event listener type
 */
export type SyncEventListener<K extends keyof SyncEngineEvents> = (
  data: SyncEngineEvents[K]
) => void;

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Sync engine configuration
 */
export interface SyncConfig {
  /** Default sync mode */
  defaultMode: SyncMode;
  /** Default conflict strategy */
  defaultConflictStrategy: ConflictStrategy;
  /** Parallel processing concurrency */
  concurrency: number;
  /** Checkpoint interval (items) */
  checkpointInterval: number;
  /** Enable cross-session resume */
  enableResume: boolean;
  /** Rate limit (requests per second, 0 = unlimited) */
  rateLimit: number;
  /** Request timeout (ms) */
  requestTimeout: number;
  /** Retry count for failed operations */
  retryCount: number;
  /** Retry delay (ms) */
  retryDelay: number;
  /** Enable debug logging */
  debug: boolean;
}

/**
 * Default sync configuration
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  defaultMode: 'incremental',
  defaultConflictStrategy: 'last-write-wins',
  concurrency: 5,
  checkpointInterval: 100,
  enableResume: true,
  rateLimit: 0,
  requestTimeout: 30000,
  retryCount: 3,
  retryDelay: 1000,
  debug: false,
};

// ============================================================================
// Sync Options Types
// ============================================================================

/**
 * Options for a sync operation
 */
export interface SyncOptions {
  /** Sync mode */
  mode?: SyncMode;
  /** Specific adapters to sync */
  adapters?: SyncAdapterType[];
  /** Conflict strategy override */
  conflictStrategy?: ConflictStrategy;
  /** Force full rescan even in incremental mode */
  force?: boolean;
  /** Dry run (detect changes only, don't apply) */
  dryRun?: boolean;
  /** Since timestamp (for incremental) */
  since?: Date;
  /** Specific entity IDs to sync */
  entityIds?: string[];
  /** Include covers */
  includeCovers?: boolean;
  /** Progress callback */
  onProgress?: (progress: SyncProgress) => void;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  /** Was sync successful */
  success: boolean;
  /** Session data */
  session: SyncSession;
  /** Summary statistics */
  stats: {
    total: number;
    processed: number;
    succeeded: number;
    skipped: number;
    created: number;
    updated: number;
    deleted: number;
    failed: number;
    errors: number;
    conflicts: {
      detected: number;
      autoResolved: number;
      manualRequired: number;
    };
  };
  /** Duration in milliseconds */
  duration: number;
  /** Resume checkpoint if incomplete */
  checkpoint?: SyncCheckpoint;
}

// ============================================================================
// Batch Operation Types
// ============================================================================

/**
 * Batch operation for server sync
 */
export interface BatchOperation {
  /** Operation type */
  op: 'get' | 'create' | 'update' | 'delete';
  /** Entity ID */
  id: string;
  /** Entity type */
  type: SyncChange['entityType'];
  /** Data for create/update */
  data?: unknown;
}

/**
 * Batch operation result (single item result)
 */
export interface BatchOperationResult {
  /** Entity ID */
  id: string;
  /** Was operation successful */
  success: boolean;
  /** Result data */
  data?: unknown;
  /** Error if failed */
  error?: string;
}


// ============================================================================
// Manifest Types (for delta sync)
// ============================================================================

/**
 * Manifest entry for a syncable entity
 */
export interface ManifestEntry {
  /** Entity ID */
  id: string;
  /** Entity type */
  type: SyncChange['entityType'];
  /** Content hash */
  hash: string;
  /** Last modified timestamp */
  lastModified: Date;
  /** Size in bytes */
  size?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Full manifest for change detection
 */
export interface SyncManifest {
  /** Manifest version */
  version: number;
  /** Generated timestamp */
  generatedAt: Date;
  /** Source adapter */
  source: SyncAdapterType;
  /** Entries */
  entries: ManifestEntry[];
  /** Total count */
  totalCount: number;
  /** Total size */
  totalSize: number;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Timestamp range for queries
 */
export interface TimeRange {
  since?: Date;
  until?: Date;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  offset: number;
  limit: number;
}

/**
 * Generic async result with error handling
 */
export type AsyncResult<T> = Promise<{
  success: boolean;
  data?: T;
  error?: SyncError;
}>;

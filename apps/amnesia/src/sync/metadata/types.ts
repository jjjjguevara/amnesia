/**
 * Metadata Sync Types
 *
 * Type definitions for the metadata synchronization system.
 * Supports Calibre ↔ Obsidian bidirectional sync with schema-based field mapping.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

// ============================================================================
// Core Metadata Types
// ============================================================================

/**
 * Reading status for a book
 */
export type ReadingStatus =
  | 'unread'
  | 'reading'
  | 'completed'
  | 'abandoned'
  | 'on-hold';

/**
 * Highlight color options
 */
export type HighlightColor =
  | 'yellow'
  | 'green'
  | 'blue'
  | 'pink'
  | 'purple'
  | 'orange';

/**
 * A highlight/annotation in a book
 */
export interface Highlight {
  /** Unique ID */
  id: string;
  /** CFI range in the book */
  cfiRange: string;
  /** Highlighted text */
  text: string;
  /** Highlight color */
  color: HighlightColor;
  /** Optional note attached to highlight */
  note?: string;
  /** Chapter name/number */
  chapter?: string;
  /** Page percentage (0-100) */
  pagePercent?: number;
  /** When created */
  createdAt: Date;
  /** When last updated */
  updatedAt?: Date;
}

/**
 * A note in a book (not attached to highlight)
 */
export interface BookNote {
  /** Unique ID */
  id: string;
  /** Chapter name/number */
  chapter?: string;
  /** CFI position */
  cfi?: string;
  /** Note content (markdown) */
  content: string;
  /** When created */
  createdAt: Date;
  /** When last updated */
  updatedAt?: Date;
}

/**
 * A bookmark in a book
 */
export interface Bookmark {
  /** Unique ID */
  id: string;
  /** CFI position */
  cfi: string;
  /** Optional label */
  label?: string;
  /** When created */
  createdAt: Date;
}

/**
 * Full book metadata
 */
export interface BookMetadata {
  // Identity
  bookId: string;
  calibreId?: number;
  uuid?: string;
  title: string;
  authors: string[];

  // Reading state
  progress: number;
  currentCfi?: string;
  lastReadAt?: Date;
  status: ReadingStatus;

  // Annotations
  highlights: Highlight[];
  notes: BookNote[];
  bookmarks: Bookmark[];

  // User metadata
  rating?: number;
  tags: string[];
  bookshelves: string[];

  // Calibre metadata
  series?: {
    name: string;
    index?: number;
  };
  publisher?: string;
  publishedDate?: string;
  description?: string;
  identifiers?: Record<string, string>;
  customColumns?: Record<string, unknown>;

  // Timestamps for conflict resolution
  timestamps: MetadataTimestamps;
}

/**
 * Per-field timestamps for conflict resolution
 */
export interface MetadataTimestamps {
  progress?: Date;
  highlights?: Date;
  notes?: Date;
  rating?: Date;
  tags?: Date;
  status?: Date;
  bookshelves?: Date;
}

// ============================================================================
// Field Mapping Types
// ============================================================================

/**
 * Sync direction for a field
 */
export type SyncDirection =
  | 'calibre-wins'     // Calibre is authoritative
  | 'obsidian-wins'    // Obsidian is authoritative
  | 'bidirectional'    // Two-way sync with conflict resolution
  | 'read-only';       // Never sync back

/**
 * Conflict resolution strategy for a field
 */
export type FieldConflictStrategy =
  | 'last-write-wins'
  | 'prefer-local'
  | 'prefer-remote'
  | 'merge-union'      // For arrays: union of both
  | 'merge-concat'     // For arrays: concatenate
  | 'ask-user';

/**
 * Field type for validation
 */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'array'
  | 'object';

/**
 * Configuration for a single field mapping
 */
export interface FieldMappingConfig {
  /** Path in Obsidian frontmatter/body */
  obsidianPath: string;
  /** Sync direction */
  direction: SyncDirection;
  /** Conflict resolution strategy */
  conflictStrategy?: FieldConflictStrategy;
  /** Field type */
  type?: FieldType;
  /** Transformer name (e.g., 'wikilink', 'date') */
  transformer?: string;
  /** Validator function name */
  validator?: string;
  /** Default value if missing */
  defaultValue?: unknown;
  /** Whether field is required */
  required?: boolean;
}

/**
 * Schema for Calibre ↔ Obsidian field mapping
 */
export interface CalibreSchemaMapping {
  /** Standard Calibre fields */
  standardFields: Record<string, FieldMappingConfig>;

  /** Custom columns (user-configurable) */
  customColumns: Record<string, FieldMappingConfig>;

  /** Obsidian-only fields (not in Calibre) */
  obsidianOnlyFields: string[];

  /** Transformer functions */
  transformers: Record<string, TransformerFunction>;
}

/**
 * Transformer function type
 */
export type TransformerFunction = (
  value: unknown,
  direction: 'toCalibre' | 'toObsidian',
  metadata?: Record<string, unknown>
) => unknown;

// ============================================================================
// Conflict Types
// ============================================================================

/**
 * A conflict between local and remote metadata
 */
export interface MetadataConflict {
  /** Conflict ID */
  id: string;
  /** Book ID */
  bookId: string;
  /** Field that has conflict */
  field: string;
  /** Local value */
  localValue: unknown;
  /** Remote value */
  remoteValue: unknown;
  /** Local timestamp */
  localTimestamp?: Date;
  /** Remote timestamp */
  remoteTimestamp?: Date;
  /** Whether resolved */
  resolved: boolean;
  /** Resolution strategy used */
  resolutionStrategy?: FieldConflictStrategy;
  /** Resolved value */
  resolvedValue?: unknown;
}

/**
 * Result of a metadata sync operation
 */
export interface MetadataSyncResult {
  /** Was sync successful */
  success: boolean;
  /** Book ID */
  bookId: string;
  /** Fields that were updated */
  updatedFields: string[];
  /** Conflicts detected */
  conflicts: MetadataConflict[];
  /** Errors encountered */
  errors: MetadataSyncError[];
  /** Sync timestamp */
  timestamp: Date;
}

/**
 * Batch sync result
 */
export interface BatchSyncResult {
  /** Total books processed */
  total: number;
  /** Successful syncs */
  succeeded: number;
  /** Failed syncs */
  failed: number;
  /** Individual results */
  results: MetadataSyncResult[];
  /** Total conflicts */
  conflicts: {
    detected: number;
    autoResolved: number;
    manualRequired: number;
  };
  /** Duration in ms */
  duration: number;
}

/**
 * Metadata sync error
 */
export interface MetadataSyncError {
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Field that caused error */
  field?: string;
  /** Is error recoverable */
  recoverable: boolean;
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Validation result for a field
 */
export interface ValidationResult {
  /** Is value valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Suggested fix */
  suggestion?: unknown;
}

/**
 * Consistency check result
 */
export interface ConsistencyResult {
  /** Is metadata consistent */
  consistent: boolean;
  /** Issues found */
  issues: ValidationIssue[];
}

/**
 * A validation issue
 */
export interface ValidationIssue {
  /** Field with issue */
  field: string;
  /** Issue type */
  issue: 'out-of-range' | 'invalid-format' | 'empty-value' | 'inconsistent' | 'orphaned';
  /** Current value */
  currentValue: unknown;
  /** Expected/suggested value */
  expectedValue?: unknown;
  /** Can be auto-fixed */
  autoFixable: boolean;
}

// ============================================================================
// Recovery Types
// ============================================================================

/**
 * Stored metadata for recovery after book removal
 */
export interface StoredMetadata {
  /** Book ID */
  bookId: string;
  /** Calibre ID */
  calibreId?: number;
  /** Book title (for matching) */
  title: string;
  /** Full metadata */
  metadata: BookMetadata;
  /** When archived */
  archivedAt: Date;
  /** File hash for matching */
  fileHash?: string;
}

/**
 * Recovery result
 */
export interface RecoveryResult {
  /** Was recovery successful */
  success: boolean;
  /** Has stored metadata */
  hasStoredMetadata: boolean;
  /** Recovered metadata */
  recoveredMetadata?: BookMetadata;
  /** Conflicts with new data */
  conflicts: MetadataConflict[];
  /** Fields that were restored */
  restoredFields: string[];
}

// ============================================================================
// Liquid Template Types
// ============================================================================

/**
 * Available fields for Nunjucks templates
 */
export interface TemplateContext {
  /** Book metadata */
  book: BookMetadata;
  /** Book highlights */
  highlights: Highlight[];
  /** Book notes */
  notes: BookNote[];
  /** Calibre-specific data */
  calibre?: {
    id: number;
    formats: string[];
    coverPath?: string;
  };
  /** Plugin settings (folder paths) */
  settings: {
    authorsFolder: string;
    seriesFolder: string;
    bookshelvesFolder: string;
    booksFolder?: string;
    highlightsFolder?: string;
    notesFolder?: string;
  };
  /** Helper functions */
  helpers: {
    formatDate: (date: Date, format: string) => string;
    wikilink: (text: string, folder?: string) => string;
    slugify: (text: string) => string;
  };
}

/**
 * Field definition for template editor
 */
export interface FieldDefinition {
  /** Field name */
  name: string;
  /** Display label */
  label: string;
  /** Field type */
  type: FieldType;
  /** Description */
  description: string;
  /** Example value */
  example: unknown;
  /** Is array */
  isArray: boolean;
}

// ============================================================================
// Change Detection Types
// ============================================================================

/**
 * A change detected in Calibre
 */
export interface CalibreChange {
  /** Calibre book ID */
  calibreId: number;
  /** Book UUID */
  uuid: string;
  /** Field that changed */
  field: string;
  /** Old value */
  oldValue: unknown;
  /** New value */
  newValue: unknown;
  /** Change timestamp */
  timestamp: Date;
}

/**
 * A change detected in Obsidian
 */
export interface ObsidianChange {
  /** Book ID */
  bookId: string;
  /** Note path */
  notePath: string;
  /** Field that changed */
  field: string;
  /** Old value */
  oldValue: unknown;
  /** New value */
  newValue: unknown;
  /** Change timestamp */
  timestamp: Date;
}

/**
 * Comparison result between Calibre and Obsidian
 */
export interface MetadataComparison {
  /** Are they equal */
  equal: boolean;
  /** Fields that differ */
  differences: FieldDifference[];
  /** Calibre is newer */
  calibreNewer: boolean;
  /** Obsidian is newer */
  obsidianNewer: boolean;
}

/**
 * A difference in a field
 */
export interface FieldDifference {
  /** Field name */
  field: string;
  /** Calibre value */
  calibreValue: unknown;
  /** Obsidian value */
  obsidianValue: unknown;
  /** Which is newer */
  newerSource: 'calibre' | 'obsidian' | 'unknown';
}

// ============================================================================
// Sync Options
// ============================================================================

/**
 * Options for metadata sync
 */
export interface MetadataSyncOptions {
  /** Specific fields to sync */
  fields?: string[];
  /** Conflict strategy override */
  conflictStrategy?: FieldConflictStrategy;
  /** Force overwrite without conflict check */
  force?: boolean;
  /** Dry run (detect changes only) */
  dryRun?: boolean;
  /** Include archived metadata in recovery */
  includeArchived?: boolean;
}

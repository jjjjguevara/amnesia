/**
 * Metadata Sync Service
 *
 * Orchestrates metadata synchronization between Calibre, Obsidian, and Amnesia Server.
 * Uses schema-based field mapping, validation, and conflict resolution.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type { App } from 'obsidian';
import type {
  BookMetadata,
  MetadataSyncResult,
  BatchSyncResult,
  MetadataConflict,
  MetadataSyncOptions,
  FieldConflictStrategy,
  StoredMetadata,
  RecoveryResult,
  ValidationResult,
  ConsistencyResult,
} from './types';

import {
  FieldMappingManager,
  createFieldMappingManager,
} from './field-mapping';

import {
  MetadataValidator,
  createMetadataValidator,
  sanitizeMetadata,
  mergeMetadata,
} from './metadata-validator';

import {
  MetadataRecoveryService,
  createRecoveryService,
} from './recovery-service';

import {
  LiquidTemplateService,
  createLiquidTemplateService,
} from './liquid-template-service';

// ============================================================================
// Types
// ============================================================================

/**
 * Metadata store interface for persistence
 */
export interface MetadataStore {
  get(bookId: string): Promise<BookMetadata | null>;
  set(bookId: string, metadata: BookMetadata): Promise<void>;
  delete(bookId: string): Promise<void>;
  getAll(): Promise<Map<string, BookMetadata>>;
  getTimestamp(bookId: string, field: string): Promise<Date | null>;
  setTimestamp(bookId: string, field: string, timestamp: Date): Promise<void>;
}

/**
 * Calibre client interface
 */
export interface CalibreClient {
  getBook(calibreId: number): Promise<CalibreBook | null>;
  updateBook(calibreId: number, fields: Record<string, unknown>): Promise<void>;
  getModifiedBooks(since: Date): Promise<CalibreBook[]>;
}

/**
 * Calibre book data
 */
export interface CalibreBook {
  id: number;
  uuid: string;
  title: string;
  authors: string[];
  rating?: number;
  tags?: string[];
  series?: string;
  series_index?: number;
  publisher?: string;
  pubdate?: string;
  comments?: string;
  identifiers?: Record<string, string>;
  custom_columns?: Record<string, unknown>;
  last_modified: Date;
}

/**
 * Obsidian note interface
 */
export interface ObsidianNote {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  mtime: Date;
}

/**
 * Obsidian vault interface
 */
export interface ObsidianVault {
  getNote(path: string): Promise<ObsidianNote | null>;
  updateNote(path: string, frontmatter: Record<string, unknown>, body?: string): Promise<void>;
  createNote(path: string, content: string): Promise<void>;
  deleteNote(path: string): Promise<void>;
  getModifiedNotes(folder: string, since: Date): Promise<ObsidianNote[]>;
}

/**
 * Server client interface
 */
export interface ServerClient {
  syncMetadata(bookId: string, metadata: Partial<BookMetadata>): Promise<void>;
  getMetadata(bookId: string): Promise<Partial<BookMetadata> | null>;
  getModifiedMetadata(since: Date): Promise<Array<{ bookId: string; metadata: Partial<BookMetadata> }>>;
}

/**
 * Sync service configuration
 */
export interface MetadataSyncServiceConfig {
  /** Book notes folder path */
  bookNotesFolder: string;
  /** Conflict resolution strategy */
  defaultConflictStrategy: FieldConflictStrategy;
  /** Auto-sync interval in ms (0 to disable) */
  autoSyncInterval: number;
  /** Sync server metadata */
  syncToServer: boolean;
  /** Enable validation */
  enableValidation: boolean;
  /** Enable auto-fix for validation issues */
  enableAutoFix: boolean;
}

/**
 * Event types for sync service
 */
export type MetadataSyncEvent =
  | { type: 'sync-started'; bookId: string }
  | { type: 'sync-completed'; bookId: string; result: MetadataSyncResult }
  | { type: 'sync-failed'; bookId: string; error: Error }
  | { type: 'conflict-detected'; bookId: string; conflict: MetadataConflict }
  | { type: 'conflict-resolved'; bookId: string; conflict: MetadataConflict }
  | { type: 'batch-started'; total: number }
  | { type: 'batch-progress'; completed: number; total: number }
  | { type: 'batch-completed'; result: BatchSyncResult }
  | { type: 'validation-error'; bookId: string; errors: Record<string, ValidationResult> }
  | { type: 'recovery-available'; bookId: string; stored: StoredMetadata };

type EventListener = (event: MetadataSyncEvent) => void;

// ============================================================================
// Metadata Sync Service
// ============================================================================

/**
 * Main service for metadata synchronization
 */
export class MetadataSyncService {
  private fieldMapping: FieldMappingManager;
  private validator: MetadataValidator;
  private recovery: MetadataRecoveryService | null = null;
  private templates: LiquidTemplateService;
  private config: MetadataSyncServiceConfig;
  private listeners: Set<EventListener>;
  private pendingConflicts: Map<string, MetadataConflict[]>;
  private store: MetadataStore | null = null;
  private calibre: CalibreClient | null = null;
  private vault: ObsidianVault | null = null;
  private server: ServerClient | null = null;

  constructor(config: Partial<MetadataSyncServiceConfig> = {}) {
    this.config = {
      bookNotesFolder: 'Florilegios',
      defaultConflictStrategy: 'last-write-wins',
      autoSyncInterval: 0,
      syncToServer: false,
      enableValidation: true,
      enableAutoFix: true,
      ...config,
    };

    this.fieldMapping = createFieldMappingManager();
    this.validator = createMetadataValidator();
    this.templates = createLiquidTemplateService();
    this.listeners = new Set();
    this.pendingConflicts = new Map();
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Initialize with external dependencies
   */
  initialize(deps: {
    app?: App;
    store?: MetadataStore;
    calibre?: CalibreClient;
    vault?: ObsidianVault;
    server?: ServerClient;
  }): void {
    this.store = deps.store || null;
    this.calibre = deps.calibre || null;
    this.vault = deps.vault || null;
    this.server = deps.server || null;

    // Initialize recovery service if app is provided
    if (deps.app) {
      this.recovery = createRecoveryService(deps.app);
    }
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  /**
   * Subscribe to sync events
   */
  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Emit an event to all listeners
   */
  private emit(event: MetadataSyncEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Metadata sync event listener error:', e);
      }
    }
  }

  // ==========================================================================
  // Core Sync Operations
  // ==========================================================================

  /**
   * Sync metadata for a single book
   */
  async syncBookMetadata(
    bookId: string,
    options: MetadataSyncOptions = {}
  ): Promise<MetadataSyncResult> {
    this.emit({ type: 'sync-started', bookId });

    const result: MetadataSyncResult = {
      success: true,
      bookId,
      updatedFields: [],
      conflicts: [],
      errors: [],
      timestamp: new Date(),
    };

    try {
      // Get current local metadata
      const localMetadata = await this.store?.get(bookId);

      // Validate if enabled
      if (this.config.enableValidation && localMetadata) {
        const validation = this.validator.validateMetadata(localMetadata);
        if (!validation.valid) {
          this.emit({ type: 'validation-error', bookId, errors: validation.fieldErrors });

          if (this.config.enableAutoFix) {
            const autoFixableIssues = validation.consistency.issues.filter((i) => i.autoFixable);
            if (autoFixableIssues.length > 0) {
              const fixed = this.validator.autoFixIssues(localMetadata, autoFixableIssues);
              await this.store?.set(bookId, fixed);
            }
          }
        }
      }

      // Detect conflicts with Calibre
      if (this.calibre && localMetadata?.calibreId) {
        const calibreBook = await this.calibre.getBook(localMetadata.calibreId);
        if (calibreBook) {
          const conflicts = await this.detectConflicts(localMetadata, calibreBook);
          result.conflicts.push(...conflicts);

          for (const conflict of conflicts) {
            this.emit({ type: 'conflict-detected', bookId, conflict });
          }
        }
      }

      // Resolve conflicts
      if (result.conflicts.length > 0 && !options.dryRun) {
        const resolvedConflicts = await this.resolveConflicts(
          result.conflicts,
          options.conflictStrategy || this.config.defaultConflictStrategy
        );

        for (const conflict of resolvedConflicts) {
          if (conflict.resolved) {
            this.emit({ type: 'conflict-resolved', bookId, conflict });
          }
        }

        // Queue unresolved conflicts for manual resolution
        const unresolved = resolvedConflicts.filter((c) => !c.resolved);
        if (unresolved.length > 0) {
          this.pendingConflicts.set(bookId, unresolved);
        }
      }

      // Sync to server if enabled
      if (this.config.syncToServer && this.server && localMetadata && !options.dryRun) {
        const serverFields = this.fieldMapping.getFieldsByDirection('bidirectional');
        const serverMetadata: Partial<BookMetadata> = {};

        for (const field of serverFields) {
          const value = (localMetadata as unknown as Record<string, unknown>)[field];
          if (value !== undefined) {
            (serverMetadata as unknown as Record<string, unknown>)[field] = value;
          }
        }

        await this.server.syncMetadata(bookId, serverMetadata);
        result.updatedFields.push(...serverFields);
      }

      result.success = true;
    } catch (error) {
      result.success = false;
      result.errors.push({
        code: 'SYNC_FAILED',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      });
      this.emit({ type: 'sync-failed', bookId, error: error instanceof Error ? error : new Error(String(error)) });
    }

    this.emit({ type: 'sync-completed', bookId, result });
    return result;
  }

  /**
   * Sync metadata for all books
   */
  async syncAllMetadata(options: MetadataSyncOptions = {}): Promise<BatchSyncResult> {
    const startTime = Date.now();
    const results: MetadataSyncResult[] = [];
    let succeeded = 0;
    let failed = 0;
    let conflictsDetected = 0;
    let conflictsAutoResolved = 0;
    let conflictsManual = 0;

    const allMetadata = await this.store?.getAll();
    const total = allMetadata?.size || 0;

    this.emit({ type: 'batch-started', total });

    if (allMetadata) {
      let completed = 0;

      for (const [bookId] of allMetadata) {
        const result = await this.syncBookMetadata(bookId, options);
        results.push(result);

        if (result.success) {
          succeeded++;
        } else {
          failed++;
        }

        conflictsDetected += result.conflicts.length;
        conflictsAutoResolved += result.conflicts.filter((c) => c.resolved).length;
        conflictsManual += result.conflicts.filter((c) => !c.resolved).length;

        completed++;
        this.emit({ type: 'batch-progress', completed, total });
      }
    }

    const batchResult: BatchSyncResult = {
      total,
      succeeded,
      failed,
      results,
      conflicts: {
        detected: conflictsDetected,
        autoResolved: conflictsAutoResolved,
        manualRequired: conflictsManual,
      },
      duration: Date.now() - startTime,
    };

    this.emit({ type: 'batch-completed', result: batchResult });
    return batchResult;
  }

  // ==========================================================================
  // Conflict Detection & Resolution
  // ==========================================================================

  /**
   * Detect conflicts between local and Calibre metadata
   */
  async detectConflicts(
    local: BookMetadata,
    calibre: CalibreBook
  ): Promise<MetadataConflict[]> {
    const conflicts: MetadataConflict[] = [];
    const bidirectionalFields = this.fieldMapping.getBidirectionalFields();

    for (const field of bidirectionalFields) {
      const mapping = this.fieldMapping.getCalibreFieldMapping(field);
      if (!mapping) continue;

      // Get local value
      const localValue = (local as unknown as Record<string, unknown>)[field];

      // Get Calibre value (with transformation)
      let calibreValue = (calibre as unknown as Record<string, unknown>)[field];
      calibreValue = this.fieldMapping.transformValue(field, calibreValue, 'toObsidian');

      // Compare values
      if (!this.valuesEqual(localValue, calibreValue)) {
        const localTimestamp = await this.store?.getTimestamp(local.bookId, field);
        const remoteTimestamp = calibre.last_modified;

        conflicts.push({
          id: `${local.bookId}-${field}-${Date.now()}`,
          bookId: local.bookId,
          field,
          localValue,
          remoteValue: calibreValue,
          localTimestamp: localTimestamp || undefined,
          remoteTimestamp,
          resolved: false,
        });
      }
    }

    return conflicts;
  }

  /**
   * Resolve conflicts using the specified strategy
   */
  async resolveConflicts(
    conflicts: MetadataConflict[],
    strategy: FieldConflictStrategy
  ): Promise<MetadataConflict[]> {
    const resolved: MetadataConflict[] = [];

    for (const conflict of conflicts) {
      const fieldStrategy = this.fieldMapping.getConflictStrategy(conflict.field);
      const effectiveStrategy = fieldStrategy !== 'last-write-wins' ? fieldStrategy : strategy;

      let resolvedValue: unknown;
      let isResolved = true;

      switch (effectiveStrategy) {
        case 'last-write-wins':
          if (conflict.localTimestamp && conflict.remoteTimestamp) {
            resolvedValue =
              conflict.localTimestamp > conflict.remoteTimestamp
                ? conflict.localValue
                : conflict.remoteValue;
          } else {
            resolvedValue = conflict.remoteValue;
          }
          break;

        case 'prefer-local':
          resolvedValue = conflict.localValue;
          break;

        case 'prefer-remote':
          resolvedValue = conflict.remoteValue;
          break;

        case 'merge-union':
          if (Array.isArray(conflict.localValue) && Array.isArray(conflict.remoteValue)) {
            resolvedValue = [...new Set([...conflict.localValue, ...conflict.remoteValue])];
          } else {
            resolvedValue = conflict.remoteValue;
          }
          break;

        case 'merge-concat':
          if (Array.isArray(conflict.localValue) && Array.isArray(conflict.remoteValue)) {
            resolvedValue = [...conflict.localValue, ...conflict.remoteValue];
          } else {
            resolvedValue = conflict.remoteValue;
          }
          break;

        case 'ask-user':
          isResolved = false;
          break;

        default:
          resolvedValue = conflict.remoteValue;
      }

      resolved.push({
        ...conflict,
        resolved: isResolved,
        resolutionStrategy: effectiveStrategy,
        resolvedValue: isResolved ? resolvedValue : undefined,
      });
    }

    return resolved;
  }

  /**
   * Manually resolve a conflict
   */
  async resolveConflictManually(
    conflictId: string,
    resolution: 'local' | 'remote' | 'merge',
    mergedValue?: unknown
  ): Promise<void> {
    for (const [bookId, conflicts] of this.pendingConflicts) {
      const conflict = conflicts.find((c) => c.id === conflictId);
      if (conflict) {
        let resolvedValue: unknown;

        switch (resolution) {
          case 'local':
            resolvedValue = conflict.localValue;
            break;
          case 'remote':
            resolvedValue = conflict.remoteValue;
            break;
          case 'merge':
            resolvedValue = mergedValue;
            break;
        }

        conflict.resolved = true;
        conflict.resolvedValue = resolvedValue;

        // Apply resolution
        const metadata = await this.store?.get(bookId);
        if (metadata) {
          (metadata as unknown as Record<string, unknown>)[conflict.field] = resolvedValue;
          await this.store?.set(bookId, metadata);
          await this.store?.setTimestamp(bookId, conflict.field, new Date());
        }

        this.emit({ type: 'conflict-resolved', bookId, conflict });

        // Remove from pending if all resolved
        const remaining = conflicts.filter((c) => !c.resolved);
        if (remaining.length === 0) {
          this.pendingConflicts.delete(bookId);
        } else {
          this.pendingConflicts.set(bookId, remaining);
        }

        return;
      }
    }
  }

  /**
   * Get pending conflicts for a book
   */
  getPendingConflicts(bookId: string): MetadataConflict[] {
    return this.pendingConflicts.get(bookId) || [];
  }

  /**
   * Get all pending conflicts
   */
  getAllPendingConflicts(): Map<string, MetadataConflict[]> {
    return new Map(this.pendingConflicts);
  }

  // ==========================================================================
  // Data Recovery
  // ==========================================================================

  /**
   * Get stored metadata for recovery
   */
  async getStoredMetadata(bookId: string): Promise<StoredMetadata | null> {
    if (!this.recovery) {
      return null;
    }
    return this.recovery.retrieveMetadata(bookId);
  }

  /**
   * Restore metadata for a book
   */
  async restoreMetadata(bookId: string, stored: StoredMetadata): Promise<RecoveryResult> {
    if (!this.recovery) {
      return {
        success: false,
        hasStoredMetadata: false,
        conflicts: [],
        restoredFields: [],
      };
    }

    const current = await this.store?.get(bookId);

    if (current) {
      // Merge with existing
      const conflicts = this.recovery.detectConflicts(stored.metadata, current);
      if (conflicts.length > 0) {
        return {
          success: false,
          hasStoredMetadata: true,
          recoveredMetadata: stored.metadata,
          conflicts,
          restoredFields: [],
        };
      }

      const merged = this.recovery.mergeMetadata(
        stored.metadata,
        current,
        'prefer-remote' // Prefer stored (archived) values
      );
      await this.store?.set(bookId, merged);

      return {
        success: true,
        hasStoredMetadata: true,
        recoveredMetadata: merged,
        conflicts: [],
        restoredFields: Object.keys(stored.metadata),
      };
    } else {
      // No existing metadata, restore fully
      await this.store?.set(bookId, stored.metadata);

      return {
        success: true,
        hasStoredMetadata: true,
        recoveredMetadata: stored.metadata,
        conflicts: [],
        restoredFields: Object.keys(stored.metadata),
      };
    }
  }

  /**
   * Handle book removal (archive metadata)
   */
  async onBookRemoved(bookId: string): Promise<void> {
    if (!this.recovery) {
      return;
    }
    const metadata = await this.store?.get(bookId);
    if (metadata) {
      await this.recovery.storeMetadata(bookId, metadata);
    }
  }

  /**
   * Handle book addition (check for recovery)
   */
  async onBookAdded(bookId: string): Promise<RecoveryResult> {
    if (!this.recovery) {
      return {
        success: true,
        hasStoredMetadata: false,
        conflicts: [],
        restoredFields: [],
      };
    }

    const stored = await this.recovery.retrieveMetadata(bookId);

    if (stored) {
      this.emit({ type: 'recovery-available', bookId, stored });
      return {
        success: false, // Needs user action
        hasStoredMetadata: true,
        recoveredMetadata: stored.metadata,
        conflicts: [],
        restoredFields: [],
      };
    }

    return {
      success: true,
      hasStoredMetadata: false,
      conflicts: [],
      restoredFields: [],
    };
  }

  // ==========================================================================
  // Schema & Templates
  // ==========================================================================

  /**
   * Get field mapping manager
   */
  getFieldMapping(): FieldMappingManager {
    return this.fieldMapping;
  }

  /**
   * Update field mapping
   */
  updateFieldMapping(customSchema: Parameters<typeof createFieldMappingManager>[0]): void {
    this.fieldMapping = createFieldMappingManager(customSchema);
  }

  /**
   * Get template service
   */
  getTemplateService(): LiquidTemplateService {
    return this.templates;
  }

  /**
   * Render book note using template
   */
  renderBookNote(metadata: BookMetadata, templateName?: string): string {
    return this.templates.renderBookNote(metadata, templateName);
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  /**
   * Validate metadata
   */
  validateMetadata(metadata: BookMetadata): {
    valid: boolean;
    fieldErrors: Record<string, ValidationResult>;
    consistency: ConsistencyResult;
  } {
    return this.validator.validateMetadata(metadata);
  }

  /**
   * Sanitize metadata
   */
  sanitizeMetadata(metadata: Partial<BookMetadata>): Partial<BookMetadata> {
    return sanitizeMetadata(metadata);
  }

  /**
   * Merge metadata with validation
   */
  mergeMetadata(base: BookMetadata, updates: Partial<BookMetadata>): BookMetadata {
    return mergeMetadata(base, updates, this.validator);
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Check if two values are equal
   */
  private valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (a === undefined || b === undefined) return a === b;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      const sortedA = [...a].sort();
      const sortedB = [...b].sort();
      return sortedA.every((v, i) => this.valuesEqual(v, sortedB[i]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
      const keysA = Object.keys(a as object);
      const keysB = Object.keys(b as object);
      if (keysA.length !== keysB.length) return false;
      return keysA.every((key) =>
        this.valuesEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key]
        )
      );
    }

    return false;
  }

  /**
   * Get book note path
   */
  getBookNotePath(bookId: string, title: string): string {
    const sanitizedTitle = title
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    return `${this.config.bookNotesFolder}/${sanitizedTitle}.md`;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a metadata sync service instance
 */
export function createMetadataSyncService(
  config?: Partial<MetadataSyncServiceConfig>
): MetadataSyncService {
  return new MetadataSyncService(config);
}

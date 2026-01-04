/**
 * Calibre Bidirectional Sync Service
 *
 * Handles two-way synchronization between Calibre and Obsidian.
 * Maps fields according to schema and handles conflicts.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import { App, TFile } from 'obsidian';
import type { CalibreService } from '../../calibre/calibre-service';
import type { CalibreBookFull } from '../../calibre/calibre-types';
import type {
  BookMetadata,
  CalibreChange,
  ObsidianChange,
  MetadataComparison,
  FieldDifference,
  MetadataSyncResult,
  BatchSyncResult,
  MetadataConflict,
  MetadataSyncOptions,
  CalibreSchemaMapping,
} from './types';
import {
  FieldMappingManager,
  parseObsidianPath,
  getNestedValue,
  setNestedValue,
} from './field-mapping';
import type { FieldAlias } from '../../settings/settings';
import { MetadataValidator } from './metadata-validator';
import { FileWriteQueue, type QueueStats } from './sync-queue';
import {
  computeBookSyncHash,
  bookNeedsSync,
  formatSyncHashForFrontmatter,
  SYNC_HASH_KEY,
} from './hash-utils';

// ============================================================================
// Calibre Bidirectional Sync Service
// ============================================================================

/**
 * Options for sync operations
 */
export interface SyncOptions {
  /** Enable Smart Skip optimization (default: true) */
  enableSmartSkip?: boolean;
  /** Progress callback */
  onProgress?: (stats: QueueStats) => void;
  /** Concurrency limit for file writes (default: 5) */
  concurrency?: number;
  /** Field aliases for frontmatter flexibility */
  fieldAliases?: FieldAlias[];
}

/**
 * Manages bidirectional sync between Calibre and Obsidian
 */
export class CalibreBidirectionalSync {
  private app: App;
  private calibreService: CalibreService;
  private fieldMapping: FieldMappingManager;
  private validator: MetadataValidator;
  private lastSyncTime: Map<number, Date> = new Map();
  private writeQueue: FileWriteQueue;
  private enableSmartSkip: boolean = true;

  constructor(
    app: App,
    calibreService: CalibreService,
    schemaMapping?: Partial<CalibreSchemaMapping>,
    options?: SyncOptions
  ) {
    this.app = app;
    this.calibreService = calibreService;
    this.fieldMapping = new FieldMappingManager(schemaMapping, options?.fieldAliases);
    this.validator = new MetadataValidator();
    this.writeQueue = new FileWriteQueue({
      concurrency: options?.concurrency ?? 5,
    });
    this.enableSmartSkip = options?.enableSmartSkip ?? true;

    // Set up progress callback if provided
    if (options?.onProgress) {
      this.writeQueue.onProgress(options.onProgress);
    }
  }

  /**
   * Update field aliases (for when settings change)
   */
  setFieldAliases(fieldAliases: FieldAlias[]): void {
    this.fieldMapping.setAliases(fieldAliases);
  }

  /**
   * Get the schema mapping
   */
  get schemaMapping(): CalibreSchemaMapping {
    return this.fieldMapping.exportSchema();
  }

  // ==========================================================================
  // Sync Operations
  // ==========================================================================

  /**
   * Sync metadata from Calibre to Obsidian
   */
  async syncToObsidian(calibreId: number): Promise<MetadataSyncResult> {
    const startTime = Date.now();
    const errors: MetadataSyncResult['errors'] = [];
    const updatedFields: string[] = [];

    try {
      // Get Calibre book
      const book = await this.getCalibreBook(calibreId);
      if (!book) {
        return {
          success: false,
          bookId: String(calibreId),
          updatedFields: [],
          conflicts: [],
          errors: [{ code: 'NOT_FOUND', message: 'Book not found in Calibre', recoverable: false }],
          timestamp: new Date(),
        };
      }

      // Find Obsidian note
      const notePath = await this.findBookNote(book.uuid);
      if (!notePath) {
        return {
          success: false,
          bookId: book.uuid,
          updatedFields: [],
          conflicts: [],
          errors: [{ code: 'NOTE_NOT_FOUND', message: 'Book note not found in Obsidian', recoverable: true }],
          timestamp: new Date(),
        };
      }

      // Get current Obsidian metadata
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (!file || !(file instanceof TFile)) {
        return {
          success: false,
          bookId: book.uuid,
          updatedFields: [],
          conflicts: [],
          errors: [{ code: 'FILE_ERROR', message: 'Could not read note file', recoverable: false }],
          timestamp: new Date(),
        };
      }

      // Smart Skip: Check if sync is needed based on content hash
      if (this.enableSmartSkip) {
        const cache = this.app.metadataCache.getFileCache(file as TFile);
        const frontmatter = cache?.frontmatter || {};

        // Build hashable book data (convert null to undefined for type compatibility)
        const hashableBook = {
          calibreId: book.id,
          title: book.title,
          authors: book.authors.map(a => a.name),
          rating: book.rating ?? undefined,
          tags: book.tags.map(t => t.name),
          series: book.series ? { name: book.series.name, index: book.seriesIndex ?? undefined } : undefined,
          lastModified: book.lastModified,
        };

        if (!bookNeedsSync(frontmatter, hashableBook)) {
          console.log(`[CalibreSync] Smart Skip: ${book.title} - no changes detected`);
          return {
            success: true,
            bookId: book.uuid,
            updatedFields: [],
            conflicts: [],
            errors: [],
            timestamp: new Date(),
          };
        }
      }

      // Transform and apply each mapped field
      const mappings = this.fieldMapping.getAllMappings();

      for (const [calibreField, config] of Object.entries(mappings)) {
        if (config.direction === 'obsidian-wins' || config.direction === 'read-only') {
          continue; // Skip fields that Calibre shouldn't overwrite
        }

        const calibreValue = this.getCalibreFieldValue(book, calibreField);
        if (calibreValue === undefined) continue;

        const transformedValue = this.fieldMapping.transformValue(
          calibreField,
          calibreValue,
          'toObsidian',
          { folder: this.getFieldFolder(calibreField), title: book.title }
        );

        // Validate
        const validation = this.validator.validateField(calibreField, transformedValue);
        if (!validation.valid) {
          errors.push({
            code: 'VALIDATION_ERROR',
            message: validation.error || 'Validation failed',
            field: calibreField,
            recoverable: true,
          });
          continue;
        }

        // Update note via write queue for concurrency control
        await this.writeQueue.writeFile(
          notePath,
          async () => {
            await this.updateNoteFrontmatter(file as TFile, config.obsidianPath, transformedValue);
          }
        );
        updatedFields.push(calibreField);
      }

      // Store sync hash for Smart Skip
      if (this.enableSmartSkip && updatedFields.length > 0) {
        const hashableBook = {
          calibreId: book.id,
          title: book.title,
          authors: book.authors.map(a => a.name),
          rating: book.rating ?? undefined,
          tags: book.tags.map(t => t.name),
          series: book.series ? { name: book.series.name, index: book.seriesIndex ?? undefined } : undefined,
          lastModified: book.lastModified,
        };
        const syncHash = computeBookSyncHash(hashableBook);
        const hashValue = formatSyncHashForFrontmatter(syncHash);

        await this.writeQueue.writeFile(
          `${notePath}:hash`,
          async () => {
            await this.app.fileManager.processFrontMatter(file as TFile, (frontmatter) => {
              frontmatter[SYNC_HASH_KEY] = hashValue;
            });
          }
        );
      }

      this.lastSyncTime.set(calibreId, new Date());

      return {
        success: true,
        bookId: book.uuid,
        updatedFields,
        conflicts: [],
        errors,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        success: false,
        bookId: String(calibreId),
        updatedFields,
        conflicts: [],
        errors: [{
          code: 'SYNC_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          recoverable: false,
        }],
        timestamp: new Date(),
      };
    }
  }

  /**
   * Sync metadata from Obsidian to Calibre
   */
  async syncToCalibre(bookId: string): Promise<MetadataSyncResult> {
    const errors: MetadataSyncResult['errors'] = [];
    const updatedFields: string[] = [];

    try {
      // Find note
      const notePath = await this.findBookNote(bookId);
      if (!notePath) {
        return {
          success: false,
          bookId,
          updatedFields: [],
          conflicts: [],
          errors: [{ code: 'NOTE_NOT_FOUND', message: 'Book note not found', recoverable: false }],
          timestamp: new Date(),
        };
      }

      // Get frontmatter
      const file = this.app.vault.getAbstractFileByPath(notePath) as TFile;
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter || {};

      // Get Calibre ID
      const calibreId = frontmatter.calibreId as number;
      if (!calibreId) {
        return {
          success: false,
          bookId,
          updatedFields: [],
          conflicts: [],
          errors: [{ code: 'NO_CALIBRE_ID', message: 'Note has no Calibre ID', recoverable: false }],
          timestamp: new Date(),
        };
      }

      // Get bidirectional fields only
      const bidirectionalFields = this.fieldMapping.getBidirectionalFields();

      for (const calibreField of bidirectionalFields) {
        const mapping = this.fieldMapping.getCalibreFieldMapping(calibreField);
        if (!mapping) continue;

        const { location, key } = parseObsidianPath(mapping.obsidianPath);
        let obsidianValue: unknown;

        if (location === 'frontmatter') {
          obsidianValue = getNestedValue(frontmatter, key);
        } else {
          // Body content - skip for now
          continue;
        }

        if (obsidianValue === undefined) continue;

        // Transform back to Calibre format
        const transformedValue = this.fieldMapping.transformValue(
          calibreField,
          obsidianValue,
          'toCalibre'
        );

        // Update in Calibre (via API if available)
        const success = await this.updateCalibreField(calibreId, calibreField, transformedValue);
        if (success) {
          updatedFields.push(calibreField);
        } else {
          errors.push({
            code: 'CALIBRE_UPDATE_ERROR',
            message: `Failed to update ${calibreField} in Calibre`,
            field: calibreField,
            recoverable: true,
          });
        }
      }

      return {
        success: errors.length === 0,
        bookId,
        updatedFields,
        conflicts: [],
        errors,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        success: false,
        bookId,
        updatedFields,
        conflicts: [],
        errors: [{
          code: 'SYNC_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          recoverable: false,
        }],
        timestamp: new Date(),
      };
    }
  }

  /**
   * Full bidirectional sync
   */
  async fullBidirectionalSync(
    options: MetadataSyncOptions = {}
  ): Promise<BatchSyncResult> {
    const startTime = Date.now();
    const results: MetadataSyncResult[] = [];
    let conflicts = { detected: 0, autoResolved: 0, manualRequired: 0 };

    // Get all Calibre books
    const books = await this.calibreService.scan();

    for (const book of books) {
      // Compare versions
      const comparison = await this.compareVersions(book);

      if (comparison.equal) {
        continue; // No sync needed
      }

      // Handle based on which is newer
      let result: MetadataSyncResult;

      if (comparison.differences.length > 0) {
        const conflictList: MetadataConflict[] = [];

        for (const diff of comparison.differences) {
          if (diff.newerSource === 'calibre' || diff.newerSource === 'unknown') {
            // Sync from Calibre to Obsidian
            result = await this.syncToObsidian(book.id);
          } else {
            // Sync from Obsidian to Calibre
            const notePath = await this.findBookNote(book.uuid);
            if (notePath) {
              result = await this.syncToCalibre(book.uuid);
            } else {
              result = await this.syncToObsidian(book.id);
            }
          }

          // Check for conflicts based on strategy
          const strategy = options.conflictStrategy || this.fieldMapping.getConflictStrategy(diff.field);

          if (strategy === 'ask-user') {
            conflictList.push({
              id: `${book.uuid}-${diff.field}`,
              bookId: book.uuid,
              field: diff.field,
              localValue: diff.obsidianValue,
              remoteValue: diff.calibreValue,
              resolved: false,
            });
            conflicts.detected++;
            conflicts.manualRequired++;
          } else {
            conflicts.detected++;
            conflicts.autoResolved++;
          }
        }

        result = {
          success: true,
          bookId: book.uuid,
          updatedFields: comparison.differences.map(d => d.field),
          conflicts: conflictList,
          errors: [],
          timestamp: new Date(),
        };
      } else {
        result = {
          success: true,
          bookId: book.uuid,
          updatedFields: [],
          conflicts: [],
          errors: [],
          timestamp: new Date(),
        };
      }

      results.push(result);
    }

    return {
      total: books.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
      conflicts,
      duration: Date.now() - startTime,
    };
  }

  // ==========================================================================
  // Change Detection
  // ==========================================================================

  /**
   * Detect changes in Calibre since last sync
   */
  async detectCalibreChanges(since: Date): Promise<CalibreChange[]> {
    const changes: CalibreChange[] = [];
    const books = await this.calibreService.scan();

    for (const book of books) {
      if (book.lastModified > since) {
        // Get all changed fields
        const lastSyncTime = this.lastSyncTime.get(book.id);
        const mappings = this.fieldMapping.getAllMappings();

        for (const [field, config] of Object.entries(mappings)) {
          if (config.direction === 'obsidian-wins') continue;

          changes.push({
            calibreId: book.id,
            uuid: book.uuid,
            field,
            oldValue: undefined, // Would need to track previous values
            newValue: this.getCalibreFieldValue(book, field),
            timestamp: book.lastModified,
          });
        }
      }
    }

    return changes;
  }

  /**
   * Detect changes in Obsidian since last sync
   */
  async detectObsidianChanges(since: Date): Promise<ObsidianChange[]> {
    const changes: ObsidianChange[] = [];
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      if (file.stat.mtime > since.getTime()) {
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter;

        if (frontmatter?.bookId) {
          // Check bidirectional fields
          const bidirectionalFields = this.fieldMapping.getBidirectionalFields();

          for (const field of bidirectionalFields) {
            const mapping = this.fieldMapping.getCalibreFieldMapping(field);
            if (!mapping) continue;

            const { location, key } = parseObsidianPath(mapping.obsidianPath);
            if (location !== 'frontmatter') continue;

            const value = getNestedValue(frontmatter, key);
            if (value !== undefined) {
              changes.push({
                bookId: frontmatter.bookId as string,
                notePath: file.path,
                field,
                oldValue: undefined,
                newValue: value,
                timestamp: new Date(file.stat.mtime),
              });
            }
          }
        }
      }
    }

    return changes;
  }

  /**
   * Compare Calibre book with Obsidian note
   */
  async compareVersions(book: CalibreBookFull): Promise<MetadataComparison> {
    const differences: FieldDifference[] = [];

    // Find Obsidian note
    const notePath = await this.findBookNote(book.uuid);
    if (!notePath) {
      return {
        equal: false,
        differences: [],
        calibreNewer: true,
        obsidianNewer: false,
      };
    }

    const file = this.app.vault.getAbstractFileByPath(notePath) as TFile;
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter || {};

    // Compare each bidirectional field
    const bidirectionalFields = this.fieldMapping.getBidirectionalFields();

    for (const field of bidirectionalFields) {
      const mapping = this.fieldMapping.getCalibreFieldMapping(field);
      if (!mapping) continue;

      const calibreValue = this.getCalibreFieldValue(book, field);
      const { location, key } = parseObsidianPath(mapping.obsidianPath);

      let obsidianValue: unknown;
      if (location === 'frontmatter') {
        obsidianValue = getNestedValue(frontmatter, key);
      }

      // Transform for comparison
      const transformedCalibre = this.fieldMapping.transformValue(
        field,
        calibreValue,
        'toObsidian'
      );

      if (!this.valuesEqual(transformedCalibre, obsidianValue)) {
        // Determine which is newer
        const noteModified = new Date(file.stat.mtime);
        const bookModified = book.lastModified;

        differences.push({
          field,
          calibreValue,
          obsidianValue,
          newerSource: bookModified > noteModified ? 'calibre' : 'obsidian',
        });
      }
    }

    const calibreNewer = differences.some(d => d.newerSource === 'calibre');
    const obsidianNewer = differences.some(d => d.newerSource === 'obsidian');

    return {
      equal: differences.length === 0,
      differences,
      calibreNewer,
      obsidianNewer,
    };
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Get Calibre book by ID
   */
  private async getCalibreBook(calibreId: number): Promise<CalibreBookFull | null> {
    const books = await this.calibreService.scan();
    return books.find(b => b.id === calibreId) || null;
  }

  /**
   * Find book note by UUID
   */
  private async findBookNote(bookId: string): Promise<string | null> {
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.bookId === bookId ||
          cache?.frontmatter?.calibreUuid === bookId) {
        return file.path;
      }
    }

    return null;
  }

  /**
   * Get field value from Calibre book
   */
  private getCalibreFieldValue(book: CalibreBookFull, field: string): unknown {
    switch (field) {
      case 'title':
        return book.title;
      case 'authors':
        return book.authors.map(a => a.name);
      case 'series':
        return book.series?.name;
      case 'series_index':
        return book.seriesIndex;
      case 'rating':
        return book.rating;
      case 'tags':
        return book.tags.map(t => t.name);
      case 'publisher':
        return book.publisher;
      case 'pubdate':
        return book.pubdate;
      case 'uuid':
        return book.uuid;
      case 'identifiers':
        return book.identifiers;
      default:
        // Custom columns not currently supported in CalibreBookFull
        // TODO: Add custom column support when Calibre API supports it
        return undefined;
    }
  }

  /**
   * Update Calibre field via Content Server API
   *
   * Uses the /cdb/set-fields/ endpoint to update metadata in Calibre.
   * Only works when connected via Content Server (not local database).
   */
  private async updateCalibreField(
    calibreId: number,
    field: string,
    value: unknown
  ): Promise<boolean> {
    const contentServer = this.calibreService.getContentServer();

    if (!contentServer) {
      console.log(`[CalibreSync] No Content Server connection - cannot update ${field} for book ${calibreId}`);
      console.log(`[CalibreSync] Local database mode does not support writes. Use Content Server for bidirectional sync.`);
      return false;
    }

    // Enable verbose logging for debugging
    contentServer.setVerbose(true);

    console.log(`[CalibreSync] Updating ${field} = ${JSON.stringify(value)} for book ${calibreId}`);

    try {
      const result = await contentServer.setField(calibreId, field, value);

      if (result.success) {
        console.log(`[CalibreSync] Successfully updated ${field} in Calibre`);
        return true;
      } else {
        console.error(`[CalibreSync] Failed to update ${field}: ${result.error}`);
        return false;
      }
    } catch (error) {
      console.error(`[CalibreSync] Error updating ${field}:`, error);
      return false;
    }
  }

  /**
   * Update note frontmatter
   */
  private async updateNoteFrontmatter(
    file: TFile,
    path: string,
    value: unknown
  ): Promise<void> {
    const { location, key } = parseObsidianPath(path);

    if (location !== 'frontmatter') {
      return; // Only handle frontmatter for now
    }

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      setNestedValue(frontmatter, key, value);
    });
  }

  /**
   * Get folder for field (for wikilink transformer)
   */
  private getFieldFolder(field: string): string {
    switch (field) {
      case 'authors':
        return 'Library/Authors';
      case 'series':
        return 'Library/Series';
      case 'tags':
        return 'Library/Shelves';
      default:
        return '';
    }
  }

  /**
   * Get queue statistics for progress tracking
   */
  getQueueStats(): QueueStats {
    return this.writeQueue.getStats();
  }

  /**
   * Wait for all pending writes to complete
   */
  async waitForPendingWrites(): Promise<void> {
    await this.writeQueue.onIdle();
  }

  /**
   * Pause the write queue
   */
  pauseSync(): void {
    this.writeQueue.pause();
  }

  /**
   * Resume the write queue
   */
  resumeSync(): void {
    this.writeQueue.resume();
  }

  /**
   * Clear pending write queue
   */
  clearQueue(): void {
    this.writeQueue.clear();
  }

  /**
   * Compare two values for equality
   */
  private valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === undefined && b === null) return true;
    if (a === null && b === undefined) return true;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      const sortedA = [...a].sort();
      const sortedB = [...b].sort();
      return JSON.stringify(sortedA) === JSON.stringify(sortedB);
    }

    return JSON.stringify(a) === JSON.stringify(b);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Calibre bidirectional sync service
 */
export function createCalibreBidirectionalSync(
  app: App,
  calibreService: CalibreService,
  schemaMapping?: Partial<CalibreSchemaMapping>
): CalibreBidirectionalSync {
  return new CalibreBidirectionalSync(app, calibreService, schemaMapping);
}

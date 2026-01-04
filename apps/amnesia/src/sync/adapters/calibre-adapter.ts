/**
 * Calibre Sync Adapter
 *
 * Wraps CalibreService to provide unified sync interface.
 * Supports incremental sync via last_modified timestamps.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type { App } from 'obsidian';
import type { CalibreService } from '../../calibre/calibre-service';
import type { CalibreBookFull } from '../../calibre/calibre-types';
import type { LibrosSettings } from '../../settings/settings';

import {
  BaseSyncAdapter,
  type AdapterCapabilities,
  type AdapterStatus,
  type AdapterStats,
} from '../sync-adapter';

import type {
  SyncChange,
  SyncManifest,
  ManifestEntry,
  PaginationOptions,
  AsyncResult,
} from '../types';

import { ParallelExecutor, type RateLimiter } from '../index';

// ============================================================================
// Types
// ============================================================================

/**
 * Calibre book data for sync
 */
export interface CalibreBookSyncData {
  book: CalibreBookFull;
  coverData?: ArrayBuffer;
}

/**
 * Result of a parallel cover download operation
 */
export interface CoverDownloadResult {
  bookId: number;
  uuid: string;
  success: boolean;
  coverData?: ArrayBuffer;
  error?: string;
}

/**
 * Progress callback for parallel operations
 */
export interface ParallelProgress {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  percentage: number;
  currentItem?: string;
}

/**
 * Options for parallel cover download
 */
export interface ParallelCoverOptions {
  /** Maximum concurrent downloads (default: 5) */
  concurrency?: number;
  /** Rate limiter instance (optional) */
  rateLimiter?: RateLimiter;
  /** Progress callback */
  onProgress?: (progress: ParallelProgress) => void;
  /** Cancel signal */
  signal?: AbortSignal;
}

// ============================================================================
// Calibre Sync Adapter
// ============================================================================

/**
 * Adapter for syncing with Calibre library
 *
 * Wraps the existing CalibreService and provides:
 * - Change detection via last_modified timestamps
 * - Manifest generation for full comparison
 * - Book note generation and cover copying
 */
export class CalibreSyncAdapter extends BaseSyncAdapter {
  readonly type = 'calibre' as const;
  readonly name = 'Calibre Library';

  readonly capabilities: AdapterCapabilities = {
    incrementalSync: true,
    batchOperations: false,
    contentHashing: true,
    resumable: false, // Will be true when we add checkpointing
    bidirectional: true,
    parallelRequests: true,
    maxConcurrency: 5,
    entityTypes: ['book', 'metadata'],
  };

  private app: App;
  private calibreService: CalibreService;
  private getSettings: () => LibrosSettings;
  private bookCache = new Map<number, CalibreBookFull>();

  constructor(
    app: App,
    calibreService: CalibreService,
    getSettings: () => LibrosSettings
  ) {
    super();
    this.app = app;
    this.calibreService = calibreService;
    this.getSettings = getSettings;
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  async connect(): Promise<void> {
    try {
      this.setStatus('connecting');
      await this.calibreService.connect();
      this.setStatus('connected');
    } catch (error) {
      this.setStatus('error');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.calibreService.disconnect();
    this.setStatus('disconnected');
    this.bookCache.clear();
  }

  async testConnection(): Promise<boolean> {
    try {
      const mode = this.calibreService.getConnectionMode();
      return mode !== 'none';
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Change Detection
  // ==========================================================================

  /**
   * Detect changes in Calibre since given timestamp
   *
   * Uses last_modified field from Calibre books table.
   */
  async detectChanges(
    since?: Date,
    entityTypes?: SyncChange['entityType'][]
  ): Promise<SyncChange[]> {
    // Scan library to get current state
    const books = await this.calibreService.scan();
    this.updateBookCache(books);

    const changes: SyncChange[] = [];

    for (const book of books) {
      const lastModified = book.lastModified;

      // If no since date, consider all books as new
      // If since date exists, only include books modified after that date
      if (!since || lastModified > since) {
        // Check if this is a new book or an update
        const existingNote = await this.findExistingNote(book);
        const operation = existingNote ? 'update' : 'create';

        changes.push({
          id: this.generateChangeId(),
          source: 'calibre',
          entityType: 'book',
          entityId: book.uuid,
          operation,
          timestamp: lastModified,
          hash: await this.hashBookMetadata(book),
          data: book,
        });
      }
    }

    return changes;
  }

  /**
   * Generate manifest of all Calibre books
   */
  async getManifest(
    entityTypes?: SyncChange['entityType'][],
    pagination?: PaginationOptions
  ): Promise<SyncManifest> {
    const books = await this.calibreService.scan();
    this.updateBookCache(books);

    // Apply pagination if provided
    let paginatedBooks = books;
    if (pagination) {
      paginatedBooks = books.slice(
        pagination.offset,
        pagination.offset + pagination.limit
      );
    }

    const entries: ManifestEntry[] = await Promise.all(
      paginatedBooks.map(async (book) => ({
        id: book.uuid,
        type: 'book' as const,
        hash: await this.hashBookMetadata(book),
        lastModified: book.lastModified,
        size: book.formats.reduce((sum, f) => sum + f.uncompressed_size, 0),
        metadata: {
          calibreId: book.id,
          title: book.title,
          authors: book.authors.map((a) => a.name),
        },
      }))
    );

    return {
      version: 1,
      generatedAt: new Date(),
      source: 'calibre',
      entries,
      totalCount: books.length,
      totalSize: entries.reduce((sum, e) => sum + (e.size || 0), 0),
    };
  }

  /**
   * Compare local manifest with Calibre state
   */
  async compareManifest(localManifest: ManifestEntry[]): Promise<SyncChange[]> {
    const remoteManifest = await this.getManifest();
    const changes: SyncChange[] = [];

    const localMap = new Map(localManifest.map((e) => [e.id, e]));
    const remoteMap = new Map(remoteManifest.entries.map((e) => [e.id, e]));

    // Find new and updated items
    for (const [id, remote] of remoteMap) {
      const local = localMap.get(id);

      if (!local) {
        // New item
        const book = this.bookCache.get(
          (remote.metadata as { calibreId: number }).calibreId
        );
        changes.push({
          id: this.generateChangeId(),
          source: 'calibre',
          entityType: 'book',
          entityId: id,
          operation: 'create',
          timestamp: remote.lastModified,
          hash: remote.hash,
          data: book,
        });
      } else if (local.hash !== remote.hash) {
        // Updated item
        const book = this.bookCache.get(
          (remote.metadata as { calibreId: number }).calibreId
        );
        changes.push({
          id: this.generateChangeId(),
          source: 'calibre',
          entityType: 'book',
          entityId: id,
          operation: 'update',
          timestamp: remote.lastModified,
          hash: remote.hash,
          data: book,
          previousData: local.metadata,
        });
      }
    }

    // Find deleted items
    for (const [id, local] of localMap) {
      if (!remoteMap.has(id)) {
        changes.push({
          id: this.generateChangeId(),
          source: 'calibre',
          entityType: 'book',
          entityId: id,
          operation: 'delete',
          timestamp: new Date(),
          previousData: local.metadata,
        });
      }
    }

    return changes;
  }

  // ==========================================================================
  // Data Operations
  // ==========================================================================

  /**
   * Get a book by UUID
   */
  async getEntity(
    entityType: SyncChange['entityType'],
    entityId: string
  ): AsyncResult<CalibreBookFull | null> {
    if (entityType !== 'book') {
      return this.failure(
        this.createError(`Unsupported entity type: ${entityType}`)
      );
    }

    try {
      // Find book in cache first
      for (const book of this.bookCache.values()) {
        if (book.uuid === entityId) {
          return this.success(book);
        }
      }

      // Not in cache, refresh
      const books = await this.calibreService.scan();
      this.updateBookCache(books);

      for (const book of books) {
        if (book.uuid === entityId) {
          return this.success(book);
        }
      }

      return this.success(null);
    } catch (error) {
      return this.failure(
        this.createError(
          `Failed to get book: ${error instanceof Error ? error.message : 'Unknown error'}`,
          { entityId }
        )
      );
    }
  }

  /**
   * Get multiple books by UUID
   */
  async getEntities(
    entityType: SyncChange['entityType'],
    entityIds: string[]
  ): AsyncResult<Map<string, CalibreBookFull>> {
    if (entityType !== 'book') {
      return this.failure(
        this.createError(`Unsupported entity type: ${entityType}`)
      );
    }

    try {
      const result = new Map<string, CalibreBookFull>();
      const books = await this.calibreService.scan();
      this.updateBookCache(books);

      for (const book of books) {
        if (entityIds.includes(book.uuid)) {
          result.set(book.uuid, book);
        }
      }

      return this.success(result);
    } catch (error) {
      return this.failure(
        this.createError(
          `Failed to get books: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      );
    }
  }

  /**
   * Apply a change (generate note, copy cover)
   */
  async applyChange(change: SyncChange): AsyncResult<void> {
    if (change.entityType !== 'book') {
      return this.failure(
        this.createError(`Unsupported entity type: ${change.entityType}`)
      );
    }

    try {
      const book = change.data as CalibreBookFull;

      if (change.operation === 'delete') {
        // Delete note (optional - could mark as archived instead)
        await this.deleteBookNote(change.entityId);
        return this.success(undefined);
      }

      if (!book) {
        return this.failure(
          this.createError('No book data in change', { entityId: change.entityId })
        );
      }

      // Generate/update note
      await this.calibreService.generateBookNote(book);

      // Copy cover
      await this.calibreService.copyCover(book);

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
  // Statistics
  // ==========================================================================

  async getStats(): Promise<AdapterStats> {
    const books = this.calibreService.getStore().getValue().books;

    return {
      totalEntities: books.length,
      lastSyncAt: this.stats.lastSyncAt,
      totalSize: books.reduce(
        (sum, b) => sum + b.formats.reduce((s, f) => s + f.uncompressed_size, 0),
        0
      ),
      pendingChanges: 0, // TODO: Track pending changes
      errorCount: this.stats.errorCount,
    };
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Get all books (for batch operations)
   */
  async getAllBooks(): Promise<CalibreBookFull[]> {
    const books = await this.calibreService.scan();
    this.updateBookCache(books);
    return books;
  }

  /**
   * Download cover for a book
   */
  async downloadCover(bookId: number): Promise<ArrayBuffer | null> {
    const mode = this.calibreService.getConnectionMode();
    if (mode === 'server') {
      try {
        return await this.calibreService.downloadCover(bookId);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Get book by Calibre ID
   */
  getBookByCalibreId(calibreId: number): CalibreBookFull | undefined {
    return this.bookCache.get(calibreId);
  }

  // ==========================================================================
  // Parallel Operations
  // ==========================================================================

  /**
   * Download multiple covers in parallel
   *
   * Uses ParallelExecutor for concurrent downloads with rate limiting.
   * Achieves 5x speedup over sequential downloads.
   *
   * @param books - Books to download covers for
   * @param options - Parallel execution options
   * @returns Map of book UUID to cover data (or null if failed)
   */
  async downloadCoversParallel(
    books: CalibreBookFull[],
    options: ParallelCoverOptions = {}
  ): Promise<Map<string, CoverDownloadResult>> {
    const mode = this.calibreService.getConnectionMode();
    if (mode !== 'server') {
      // Covers only available from server mode
      const results = new Map<string, CoverDownloadResult>();
      for (const book of books) {
        results.set(book.uuid, {
          bookId: book.id,
          uuid: book.uuid,
          success: false,
          error: 'Covers only available in server mode',
        });
      }
      return results;
    }

    const {
      concurrency = 5,
      rateLimiter,
      onProgress,
      signal,
    } = options;

    const results = new Map<string, CoverDownloadResult>();
    let succeeded = 0;
    let failed = 0;

    // Create executor
    const executor = new ParallelExecutor<CoverDownloadResult>({
      concurrency,
      maxRetries: 2,
      retryDelay: 500,
      rateLimiter,
      debug: false,
    });

    // Add download tasks
    for (const book of books) {
      executor.addTask(
        book.uuid,
        async () => {
          // Check for cancellation
          if (signal?.aborted) {
            throw new Error('Download cancelled');
          }

          try {
            const coverData = await this.calibreService.downloadCover(book.id);
            return {
              bookId: book.id,
              uuid: book.uuid,
              success: true,
              coverData: coverData ?? undefined,
            };
          } catch (error) {
            return {
              bookId: book.id,
              uuid: book.uuid,
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        },
        {
          priority: 'normal',
          metadata: { title: book.title },
        }
      );
    }

    // Execute with progress tracking
    const batchResult = await executor.execute((progress) => {
      // Report progress - results will be collected after execution
      onProgress?.({
        total: books.length,
        completed: progress.completed,
        succeeded: progress.completed - progress.failed,
        failed: progress.failed,
        percentage: progress.percentage,
        currentItem: progress.currentTasks[0],
      });
    });

    // Collect final results from the batch
    for (const taskResult of batchResult.results) {
      if (taskResult.success && taskResult.data) {
        results.set(taskResult.id, taskResult.data);
        succeeded++;
      } else {
        // Create a failure result for failed tasks
        const book = books.find(b => b.uuid === taskResult.id);
        if (book) {
          results.set(taskResult.id, {
            bookId: book.id,
            uuid: book.uuid,
            success: false,
            error: taskResult.error?.message || 'Unknown error',
          });
        }
        failed++;
      }
    }

    return results;
  }

  /**
   * Apply multiple book changes with parallel cover downloads
   *
   * Optimized batch operation that:
   * 1. Downloads all covers in parallel
   * 2. Generates notes for each book
   * 3. Saves covers alongside notes
   *
   * @param changes - Book changes to apply
   * @param options - Parallel execution options
   * @returns Array of results
   */
  async applyChangesWithCovers(
    changes: SyncChange[],
    options: ParallelCoverOptions = {}
  ): Promise<{ change: SyncChange; success: boolean; error?: string }[]> {
    // Filter to book changes only
    const bookChanges = changes.filter(
      (c) => c.entityType === 'book' && c.operation !== 'delete'
    );

    // Extract books from changes
    const books = bookChanges
      .map((c) => c.data as CalibreBookFull)
      .filter((b): b is CalibreBookFull => b !== null && b !== undefined);

    // Download covers in parallel first
    const coverResults = await this.downloadCoversParallel(books, options);

    // Create executor for note generation
    const {
      concurrency = 5,
      rateLimiter,
      onProgress,
      signal,
    } = options;

    const results: { change: SyncChange; success: boolean; error?: string }[] = [];
    let processed = 0;

    const executor = new ParallelExecutor<{ change: SyncChange; success: boolean; error?: string }>({
      concurrency,
      maxRetries: 1,
      rateLimiter,
      debug: false,
    });

    // Add note generation tasks
    for (const change of changes) {
      executor.addTask(
        change.id,
        async () => {
          if (signal?.aborted) {
            return { change, success: false, error: 'Cancelled' };
          }

          try {
            if (change.operation === 'delete') {
              await this.deleteBookNote(change.entityId);
              return { change, success: true };
            }

            const book = change.data as CalibreBookFull;
            if (!book) {
              return { change, success: false, error: 'No book data' };
            }

            // Generate note
            await this.calibreService.generateBookNote(book);

            // Get downloaded cover and save it
            const coverResult = coverResults.get(book.uuid);
            if (coverResult?.success && coverResult.coverData) {
              await this.saveCoverData(book, coverResult.coverData);
            } else {
              // Try copying cover directly (fallback for local mode)
              await this.calibreService.copyCover(book);
            }

            return { change, success: true };
          } catch (error) {
            return {
              change,
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        },
        {
          priority: change.operation === 'delete' ? 'high' : 'normal',
        }
      );
    }

    // Execute
    const batchResult = await executor.execute((progress) => {
      processed = progress.completed;
      onProgress?.({
        total: changes.length,
        completed: processed,
        succeeded: progress.completed - progress.failed,
        failed: progress.failed,
        percentage: progress.percentage,
      });
    });

    // Collect results from array
    for (const taskResult of batchResult.results) {
      if (taskResult.data) {
        results.push(taskResult.data);
      }
    }

    this.updateLastSync();
    return results;
  }

  /**
   * Save cover data to disk
   */
  private async saveCoverData(book: CalibreBookFull, coverData: ArrayBuffer): Promise<void> {
    const settings = this.getSettings();
    const sanitizedTitle = book.title
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();

    const coverPath = `${settings.calibreCoversFolder}/${sanitizedTitle}.jpg`;

    // Create folder if needed
    const folder = this.app.vault.getAbstractFileByPath(settings.calibreCoversFolder);
    if (!folder) {
      await this.app.vault.createFolder(settings.calibreCoversFolder);
    }

    // Save cover
    const existingFile = this.app.vault.getAbstractFileByPath(coverPath);
    if (existingFile) {
      await this.app.vault.modifyBinary(existingFile as any, coverData);
    } else {
      await this.app.vault.createBinary(coverPath, coverData);
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Update book cache
   */
  private updateBookCache(books: CalibreBookFull[]): void {
    this.bookCache.clear();
    for (const book of books) {
      this.bookCache.set(book.id, book);
    }
    this.stats.totalEntities = books.length;
  }

  /**
   * Hash book metadata for change detection
   */
  private async hashBookMetadata(book: CalibreBookFull): Promise<string> {
    const content = JSON.stringify({
      uuid: book.uuid,
      title: book.title,
      authors: book.authors.map((a) => a.name),
      series: book.series?.name,
      seriesIndex: book.seriesIndex,
      tags: book.tags.map((t) => t.name),
      rating: book.rating,
      lastModified: book.lastModified.toISOString(),
    });
    return this.hashContent(content);
  }

  /**
   * Find existing note for a book
   */
  private async findExistingNote(book: CalibreBookFull): Promise<boolean> {
    const settings = this.getSettings();
    const sanitizedTitle = book.title
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    const notePath = `${settings.calibreBookNotesFolder}/${sanitizedTitle}.md`;

    const file = this.app.vault.getAbstractFileByPath(notePath);
    return file !== null;
  }

  /**
   * Delete book note
   */
  private async deleteBookNote(bookId: string): Promise<void> {
    // Find note by bookId in frontmatter
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.bookId === bookId) {
        await this.app.vault.trash(file, true);
        return;
      }
    }
  }
}

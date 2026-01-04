/**
 * Metadata Recovery Service
 *
 * Archives and recovers book metadata when books are removed and re-added.
 * Ensures no data loss (highlights, notes, progress) during library changes.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type { App } from 'obsidian';
import type {
  BookMetadata,
  StoredMetadata,
  RecoveryResult,
  MetadataConflict,
  FieldConflictStrategy,
} from './types';

// ============================================================================
// Constants
// ============================================================================

/** IndexedDB database name */
const DB_NAME = 'amnesia-metadata-recovery';

/** IndexedDB version */
const DB_VERSION = 1;

/** Store name for archived metadata */
const ARCHIVE_STORE = 'metadata-archive';

/** Maximum age for archived metadata (90 days) */
const MAX_ARCHIVE_AGE_DAYS = 90;

// ============================================================================
// Recovery Service
// ============================================================================

/**
 * Service for archiving and recovering book metadata
 */
export class MetadataRecoveryService {
  private app: App;
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(app: App) {
    this.app = app;
  }

  // ==========================================================================
  // Database Operations
  // ==========================================================================

  /**
   * Open or create the database
   */
  private async openDatabase(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open database: ${request.error?.message}`));
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create archive store
        if (!db.objectStoreNames.contains(ARCHIVE_STORE)) {
          const store = db.createObjectStore(ARCHIVE_STORE, { keyPath: 'bookId' });
          store.createIndex('calibreId', 'calibreId', { unique: false });
          store.createIndex('title', 'title', { unique: false });
          store.createIndex('archivedAt', 'archivedAt', { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
    });

    return this.dbPromise;
  }

  // ==========================================================================
  // Archive Operations
  // ==========================================================================

  /**
   * Archive metadata when a book is removed
   */
  async storeMetadata(bookId: string, metadata: BookMetadata): Promise<void> {
    const db = await this.openDatabase();

    const stored: StoredMetadata = {
      bookId,
      calibreId: metadata.calibreId,
      title: metadata.title,
      metadata,
      archivedAt: new Date(),
      fileHash: undefined,
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(ARCHIVE_STORE, 'readwrite');
      const store = transaction.objectStore(ARCHIVE_STORE);
      const request = store.put(stored);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        console.log(
          `[MetadataRecovery] Archived metadata for "${metadata.title}" (${bookId})`
        );
        resolve();
      };
    });
  }

  /**
   * Retrieve archived metadata for a book
   */
  async retrieveMetadata(bookId: string): Promise<StoredMetadata | null> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(ARCHIVE_STORE, 'readonly');
      const store = transaction.objectStore(ARCHIVE_STORE);
      const request = store.get(bookId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const stored = request.result as StoredMetadata | undefined;

        if (!stored) {
          resolve(null);
          return;
        }

        // Check if too old
        const ageMs = Date.now() - new Date(stored.archivedAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        if (ageDays > MAX_ARCHIVE_AGE_DAYS) {
          // Remove stale archive
          this.removeArchive(bookId).catch(console.error);
          resolve(null);
          return;
        }

        resolve(stored);
      };
    });
  }

  /**
   * Remove archived metadata
   */
  async removeArchive(bookId: string): Promise<void> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(ARCHIVE_STORE, 'readwrite');
      const store = transaction.objectStore(ARCHIVE_STORE);
      const request = store.delete(bookId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Get all archived metadata
   */
  async getAllArchived(): Promise<StoredMetadata[]> {
    const db = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(ARCHIVE_STORE, 'readonly');
      const store = transaction.objectStore(ARCHIVE_STORE);
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(request.result as StoredMetadata[]);
      };
    });
  }

  // ==========================================================================
  // Recovery Workflow
  // ==========================================================================

  /**
   * Handle book removal - archive metadata
   */
  async onBookRemoved(bookId: string, metadata?: BookMetadata): Promise<void> {
    if (!metadata) {
      // Try to get metadata from existing note
      metadata = await this.extractMetadataFromNote(bookId);
    }

    if (metadata) {
      await this.storeMetadata(bookId, metadata);
    }
  }

  /**
   * Handle book addition - attempt recovery
   */
  async onBookAdded(bookId: string): Promise<RecoveryResult> {
    const stored = await this.retrieveMetadata(bookId);

    if (!stored) {
      return {
        success: true,
        hasStoredMetadata: false,
        conflicts: [],
        restoredFields: [],
      };
    }

    console.log(
      `[MetadataRecovery] Found archived metadata for "${stored.title}"`
    );

    // Get current metadata (from new book note if exists)
    const currentMetadata = await this.extractMetadataFromNote(bookId);

    if (!currentMetadata) {
      // No current metadata, full restore
      return {
        success: true,
        hasStoredMetadata: true,
        recoveredMetadata: stored.metadata,
        conflicts: [],
        restoredFields: this.getAllMetadataFields(stored.metadata),
      };
    }

    // Check for conflicts
    const conflicts = this.detectConflicts(stored.metadata, currentMetadata);

    return {
      success: true,
      hasStoredMetadata: true,
      recoveredMetadata: stored.metadata,
      conflicts,
      restoredFields: conflicts.length === 0
        ? this.getAllMetadataFields(stored.metadata)
        : [],
    };
  }

  /**
   * Find archived metadata by title (fuzzy matching)
   */
  async findByTitle(title: string): Promise<StoredMetadata | null> {
    const allArchived = await this.getAllArchived();

    // Exact match first
    for (const stored of allArchived) {
      if (stored.title.toLowerCase() === title.toLowerCase()) {
        return stored;
      }
    }

    // Fuzzy match
    const normalizedTitle = this.normalizeTitle(title);
    for (const stored of allArchived) {
      if (this.normalizeTitle(stored.title) === normalizedTitle) {
        return stored;
      }
    }

    return null;
  }

  /**
   * Find archived metadata by Calibre ID
   */
  async findByCalibreId(calibreId: number): Promise<StoredMetadata | null> {
    const allArchived = await this.getAllArchived();

    for (const stored of allArchived) {
      if (stored.calibreId === calibreId) {
        return stored;
      }
    }

    return null;
  }

  // ==========================================================================
  // Conflict Detection
  // ==========================================================================

  /**
   * Detect conflicts between stored and current metadata
   */
  detectConflicts(
    stored: BookMetadata,
    current: BookMetadata
  ): MetadataConflict[] {
    const conflicts: MetadataConflict[] = [];
    const fieldsToCheck = [
      'progress',
      'rating',
      'status',
      'tags',
      'bookshelves',
      'highlights',
      'notes',
    ];

    for (const field of fieldsToCheck) {
      const storedValue = (stored as unknown as Record<string, unknown>)[field];
      const currentValue = (current as unknown as Record<string, unknown>)[field];

      if (this.hasConflict(storedValue, currentValue)) {
        conflicts.push({
          id: `${stored.bookId}-${field}`,
          bookId: stored.bookId,
          field,
          localValue: currentValue,
          remoteValue: storedValue,
          localTimestamp: current.timestamps?.[field as keyof typeof current.timestamps],
          remoteTimestamp: stored.timestamps?.[field as keyof typeof stored.timestamps],
          resolved: false,
        });
      }
    }

    return conflicts;
  }

  /**
   * Check if two values conflict
   */
  private hasConflict(stored: unknown, current: unknown): boolean {
    // If current is empty/default, no conflict (restore stored)
    if (current === undefined || current === null) {
      return false;
    }

    // If stored is empty, no conflict (keep current)
    if (stored === undefined || stored === null) {
      return false;
    }

    // Array comparison
    if (Array.isArray(stored) && Array.isArray(current)) {
      if (stored.length === 0) return false;
      if (current.length === 0) return false;
      // Check if any items differ
      return JSON.stringify(stored.sort()) !== JSON.stringify(current.sort());
    }

    // Deep comparison
    return JSON.stringify(stored) !== JSON.stringify(current);
  }

  // ==========================================================================
  // Merge Strategies
  // ==========================================================================

  /**
   * Merge stored and current metadata
   */
  mergeMetadata(
    stored: BookMetadata,
    current: BookMetadata,
    strategy: FieldConflictStrategy = 'last-write-wins'
  ): BookMetadata {
    // Merge based on strategy
    switch (strategy) {
      case 'prefer-remote':
        // Prefer stored (archived) values
        return this.mergePreferStored(stored, current);

      case 'prefer-local':
        // Prefer current values
        return this.mergePreferCurrent(stored, current);

      case 'merge-union':
        // Merge arrays as union
        return this.mergeUnion(stored, current);

      case 'last-write-wins':
      default:
        // Use timestamps to decide
        return this.mergeByTimestamp(stored, current);
    }
  }

  /**
   * Merge preferring stored values
   */
  private mergePreferStored(stored: BookMetadata, current: BookMetadata): BookMetadata {
    return {
      ...current,
      progress: stored.progress ?? current.progress,
      currentCfi: stored.currentCfi ?? current.currentCfi,
      lastReadAt: stored.lastReadAt ?? current.lastReadAt,
      rating: stored.rating ?? current.rating,
      status: stored.status ?? current.status,
      highlights: stored.highlights.length > 0 ? stored.highlights : current.highlights,
      notes: stored.notes.length > 0 ? stored.notes : current.notes,
      bookmarks: stored.bookmarks.length > 0 ? stored.bookmarks : current.bookmarks,
      tags: stored.tags.length > 0 ? stored.tags : current.tags,
      bookshelves: stored.bookshelves.length > 0 ? stored.bookshelves : current.bookshelves,
      timestamps: {
        ...current.timestamps,
        ...stored.timestamps,
      },
    };
  }

  /**
   * Merge preferring current values
   */
  private mergePreferCurrent(stored: BookMetadata, current: BookMetadata): BookMetadata {
    return {
      ...current,
      // Only fill in missing values from stored
      progress: current.progress ?? stored.progress,
      currentCfi: current.currentCfi ?? stored.currentCfi,
      lastReadAt: current.lastReadAt ?? stored.lastReadAt,
      rating: current.rating ?? stored.rating,
      status: current.status ?? stored.status,
      highlights: current.highlights.length > 0 ? current.highlights : stored.highlights,
      notes: current.notes.length > 0 ? current.notes : stored.notes,
      bookmarks: current.bookmarks.length > 0 ? current.bookmarks : stored.bookmarks,
      tags: current.tags.length > 0 ? current.tags : stored.tags,
      bookshelves: current.bookshelves.length > 0 ? current.bookshelves : stored.bookshelves,
    };
  }

  /**
   * Merge arrays as union
   */
  private mergeUnion(stored: BookMetadata, current: BookMetadata): BookMetadata {
    return {
      ...current,
      highlights: this.mergeHighlights(stored.highlights, current.highlights),
      notes: this.mergeNotes(stored.notes, current.notes),
      bookmarks: this.mergeBookmarks(stored.bookmarks, current.bookmarks),
      tags: [...new Set([...stored.tags, ...current.tags])],
      bookshelves: [...new Set([...stored.bookshelves, ...current.bookshelves])],
    };
  }

  /**
   * Merge using timestamps
   */
  private mergeByTimestamp(stored: BookMetadata, current: BookMetadata): BookMetadata {
    const merged: BookMetadata = { ...current };

    // Compare timestamps for each field
    const fields = ['progress', 'rating', 'status', 'highlights', 'notes'] as const;

    for (const field of fields) {
      const storedTime = stored.timestamps?.[field];
      const currentTime = current.timestamps?.[field];

      if (storedTime && (!currentTime || storedTime > currentTime)) {
        (merged as unknown as Record<string, unknown>)[field] = stored[field];
      }
    }

    // Always merge arrays as union for safety
    merged.highlights = this.mergeHighlights(stored.highlights, current.highlights);
    merged.notes = this.mergeNotes(stored.notes, current.notes);
    merged.bookmarks = this.mergeBookmarks(stored.bookmarks, current.bookmarks);
    merged.tags = [...new Set([...stored.tags, ...current.tags])];
    merged.bookshelves = [...new Set([...stored.bookshelves, ...current.bookshelves])];

    return merged;
  }

  /**
   * Merge highlights by ID
   */
  private mergeHighlights(
    stored: BookMetadata['highlights'],
    current: BookMetadata['highlights']
  ): BookMetadata['highlights'] {
    const map = new Map<string, BookMetadata['highlights'][0]>();

    for (const h of stored) {
      map.set(h.id, h);
    }

    for (const h of current) {
      const existing = map.get(h.id);
      if (!existing || (h.updatedAt && existing.updatedAt && h.updatedAt > existing.updatedAt)) {
        map.set(h.id, h);
      }
    }

    return Array.from(map.values());
  }

  /**
   * Merge notes by ID
   */
  private mergeNotes(
    stored: BookMetadata['notes'],
    current: BookMetadata['notes']
  ): BookMetadata['notes'] {
    const map = new Map<string, BookMetadata['notes'][0]>();

    for (const n of stored) {
      map.set(n.id, n);
    }

    for (const n of current) {
      const existing = map.get(n.id);
      if (!existing || (n.updatedAt && existing.updatedAt && n.updatedAt > existing.updatedAt)) {
        map.set(n.id, n);
      }
    }

    return Array.from(map.values());
  }

  /**
   * Merge bookmarks by ID
   */
  private mergeBookmarks(
    stored: BookMetadata['bookmarks'],
    current: BookMetadata['bookmarks']
  ): BookMetadata['bookmarks'] {
    const map = new Map<string, BookMetadata['bookmarks'][0]>();

    for (const b of stored) {
      map.set(b.id, b);
    }

    for (const b of current) {
      map.set(b.id, b);
    }

    return Array.from(map.values());
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Extract metadata from an existing book note
   */
  private async extractMetadataFromNote(bookId: string): Promise<BookMetadata | undefined> {
    // Find note by bookId in frontmatter
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.bookId === bookId) {
        // Found the note, extract metadata
        return this.parseNoteMetadata(file, cache.frontmatter);
      }
    }

    return undefined;
  }

  /**
   * Parse metadata from note frontmatter
   */
  private parseNoteMetadata(
    file: { basename: string },
    frontmatter: Record<string, unknown>
  ): BookMetadata {
    return {
      bookId: frontmatter.bookId as string,
      calibreId: frontmatter.calibreId as number | undefined,
      title: (frontmatter.title as string) || file.basename,
      authors: this.parseArray(frontmatter.author),
      progress: (frontmatter.progress as number) || 0,
      currentCfi: frontmatter.currentCfi as string | undefined,
      lastReadAt: frontmatter.lastReadAt
        ? new Date(frontmatter.lastReadAt as string)
        : undefined,
      status: (frontmatter.status as BookMetadata['status']) || 'unread',
      highlights: [],
      notes: [],
      bookmarks: [],
      rating: frontmatter.rating as number | undefined,
      tags: this.parseArray(frontmatter.tags),
      bookshelves: this.parseArray(frontmatter.bookshelves),
      timestamps: {},
    };
  }

  /**
   * Parse array from frontmatter
   */
  private parseArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((v) => typeof v === 'string');
    }
    if (typeof value === 'string') {
      return [value];
    }
    return [];
  }

  /**
   * Get all metadata field names
   */
  private getAllMetadataFields(metadata: BookMetadata): string[] {
    const fields: string[] = ['bookId', 'title', 'authors', 'status'];

    if (metadata.progress) fields.push('progress');
    if (metadata.currentCfi) fields.push('currentCfi');
    if (metadata.lastReadAt) fields.push('lastReadAt');
    if (metadata.rating !== undefined) fields.push('rating');
    if (metadata.highlights.length > 0) fields.push('highlights');
    if (metadata.notes.length > 0) fields.push('notes');
    if (metadata.bookmarks.length > 0) fields.push('bookmarks');
    if (metadata.tags.length > 0) fields.push('tags');
    if (metadata.bookshelves.length > 0) fields.push('bookshelves');

    return fields;
  }

  /**
   * Normalize title for matching
   */
  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Clean up old archived metadata
   */
  async cleanupOldArchives(): Promise<number> {
    const allArchived = await this.getAllArchived();
    const now = Date.now();
    let cleaned = 0;

    for (const stored of allArchived) {
      const ageMs = now - new Date(stored.archivedAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      if (ageDays > MAX_ARCHIVE_AGE_DAYS) {
        await this.removeArchive(stored.bookId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[MetadataRecovery] Cleaned up ${cleaned} old archives`);
    }

    return cleaned;
  }

  /**
   * Get count of archived items
   */
  async getArchiveCount(): Promise<number> {
    const allArchived = await this.getAllArchived();
    return allArchived.length;
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPromise = null;
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a metadata recovery service
 */
export function createRecoveryService(app: App): MetadataRecoveryService {
  return new MetadataRecoveryService(app);
}

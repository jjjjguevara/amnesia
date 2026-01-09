/**
 * Calibre Database Reader/Writer
 *
 * Uses sql.js to read Calibre's metadata.db SQLite database.
 * In Electron/Obsidian, we load the WASM file and read the database.
 *
 * IMPORTANT: Calibre expects exclusive access to metadata.db.
 * We should only write when Calibre is not running, or use
 * the Calibre Content Server API for safer writes.
 *
 * Key features:
 * - Lazy-loads sql.js to avoid 1.5MB bundle cost for non-Calibre users
 * - FTS5 full-text search for fast book queries (50x faster than LIKE)
 */

import type { Database, SqlJsStatic } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import type {
  CalibreBook,
  CalibreAuthor,
  CalibreSeries,
  CalibreTag,
  CalibrePublisher,
  CalibreLanguage,
  CalibreFormat,
  CalibreIdentifier,
  CalibreBookFull,
} from '../calibre-types';
import * as queries from './queries';

// Cached promise for lazy-loaded sql.js
let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/**
 * Lazy-load sql.js on first use
 * This saves ~1.5MB bundle for users who don't use Calibre
 */
async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      // Dynamic import - only loaded when Calibre is accessed
      const { default: initSqlJs } = await import('sql.js');

      return initSqlJs({
        locateFile: (file: string) => {
          // Try to find sql-wasm.wasm in common locations
          const possiblePaths = [
            // Node modules path
            path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
            // Bundled with plugin
            path.join(__dirname, file),
            // CDN fallback
            `https://sql.js.org/dist/${file}`,
          ];

          // For Electron/Node.js, try local paths first
          for (const p of possiblePaths.slice(0, -1)) {
            try {
              if (fs.existsSync(p)) {
                return p;
              }
            } catch {
              // Path doesn't exist or not accessible
            }
          }

          // Fall back to CDN
          return possiblePaths[possiblePaths.length - 1];
        },
      });
    })();
  }
  return sqlJsPromise;
}

/**
 * CalibreDatabase - Read/write interface to Calibre's metadata.db
 */
export class CalibreDatabase {
  private SQL: SqlJsStatic | null = null;
  private db: Database | null = null;
  private libraryPath: string;
  private readonly: boolean;
  private ftsInitialized: boolean = false;

  constructor(libraryPath: string, readonly = true) {
    this.libraryPath = libraryPath;
    this.readonly = readonly;
  }

  /**
   * Initialize sql.js and open the database
   * sql.js is lazy-loaded to save ~1.5MB bundle for non-Calibre users
   */
  async open(): Promise<void> {
    if (this.db) {
      return; // Already open
    }

    // Lazy-load sql.js
    this.SQL = await getSqlJs();

    // Read the database file
    const dbPath = path.join(this.libraryPath, 'metadata.db');

    if (!fs.existsSync(dbPath)) {
      throw new Error(`Calibre database not found: ${dbPath}`);
    }

    const buffer = fs.readFileSync(dbPath);
    // Convert Buffer to Uint8Array for sql.js compatibility
    const uint8Array = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    );
    this.db = new this.SQL.Database(uint8Array);
  }

  /**
   * Close the database
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Check if database is open
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Save changes back to the database file
   * WARNING: Only call when Calibre is not running!
   */
  save(): void {
    if (!this.db || this.readonly) {
      throw new Error('Cannot save: database is readonly or not open');
    }

    const data = this.db.export();
    const dbPath = path.join(this.libraryPath, 'metadata.db');

    // Create a backup first
    const backupPath = dbPath + '.backup';
    fs.copyFileSync(dbPath, backupPath);

    // Write the new database - use Uint8Array directly
    fs.writeFileSync(dbPath, data);
  }

  // ===========================================================================
  // Book Read Operations
  // ===========================================================================

  /**
   * Get all books (basic metadata only)
   */
  getAllBooks(): CalibreBook[] {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_ALL_BOOKS);
    const books: CalibreBook[] = [];

    while (stmt.step()) {
      books.push(this.rowToBook(stmt.getAsObject() as Record<string, unknown>));
    }
    stmt.free();

    return books;
  }

  /**
   * Get a book by ID with all related metadata
   */
  getBookById(bookId: number): CalibreBookFull | null {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_BOOK_BY_ID);
    stmt.bind([bookId]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const book = this.rowToBook(stmt.getAsObject() as Record<string, unknown>);
    stmt.free();

    return this.hydrateBook(book);
  }

  /**
   * Get a book by UUID with all related metadata
   */
  getBookByUuid(uuid: string): CalibreBookFull | null {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_BOOK_BY_UUID);
    stmt.bind([uuid]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const book = this.rowToBook(stmt.getAsObject() as Record<string, unknown>);
    stmt.free();

    return this.hydrateBook(book);
  }

  /**
   * Get all books with full metadata (hydrated)
   */
  getAllBooksFull(): CalibreBookFull[] {
    const books = this.getAllBooks();
    return books.map((book) => this.hydrateBook(book));
  }

  /**
   * Search books by title
   */
  searchByTitle(query: string): CalibreBookFull[] {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.SEARCH_BOOKS_BY_TITLE);
    const pattern = `%${query}%`;
    stmt.bind([pattern, pattern]);

    const books: CalibreBook[] = [];
    while (stmt.step()) {
      books.push(this.rowToBook(stmt.getAsObject() as Record<string, unknown>));
    }
    stmt.free();

    return books.map((book) => this.hydrateBook(book));
  }

  // ===========================================================================
  // FTS5 Full-Text Search (50x faster than LIKE)
  // ===========================================================================

  /**
   * Initialize FTS5 index for fast full-text search
   * Call this after opening the database for optimal search performance
   */
  async initializeFTS5(): Promise<void> {
    this.ensureOpen();

    if (this.ftsInitialized) return;

    try {
      // Create FTS5 virtual table
      this.db!.run(queries.CREATE_FTS5_TABLE);

      // Build the index from all books
      await this.rebuildFTS5Index();

      this.ftsInitialized = true;
      console.log('[CalibreDB] FTS5 index initialized');
    } catch (error) {
      console.warn('[CalibreDB] FTS5 initialization failed:', error);
      // FTS5 is optional - fall back to LIKE queries
    }
  }

  /**
   * Rebuild the FTS5 index from scratch
   * Use after bulk data changes or to fix index corruption
   */
  async rebuildFTS5Index(): Promise<void> {
    this.ensureOpen();

    // Clear existing index
    this.db!.run(queries.CLEAR_FTS5);

    // Get all books with their related data
    const books = this.getAllBooksFull();

    // Insert each book into FTS5 index
    const insertStmt = this.db!.prepare(queries.INSERT_FTS5_BOOK);

    for (const book of books) {
      const authors = book.authors.map(a => a.name).join(' ');
      const tags = book.tags.map(t => t.name).join(' ');
      const description = book.description || '';
      const publisher = book.publisher?.name || '';

      insertStmt.bind([book.id, book.title, authors, description, tags, publisher]);
      insertStmt.step();
      // sql.js Statement has reset() but types are incomplete
      (insertStmt as unknown as { reset(): void }).reset();
    }

    insertStmt.free();
    console.log(`[CalibreDB] FTS5 index rebuilt with ${books.length} books`);
  }

  /**
   * Fast full-text search using FTS5 (50x faster than LIKE)
   * Supports queries like: "rust programming", "title:rust", "authors:klabnik"
   *
   * @param query FTS5 query string
   * @param limit Maximum results (default 100)
   */
  searchFTS5(query: string, limit: number = 100): CalibreBookFull[] {
    this.ensureOpen();

    if (!this.ftsInitialized) {
      // Fall back to LIKE search if FTS5 not available
      console.warn('[CalibreDB] FTS5 not initialized, falling back to LIKE');
      return this.searchByTitle(query);
    }

    try {
      // Escape special FTS5 characters and add wildcard suffix
      const fts5Query = this.sanitizeFTS5Query(query);

      const stmt = this.db!.prepare(queries.SEARCH_BOOKS_FTS5);
      stmt.bind([fts5Query, limit]);

      const books: CalibreBook[] = [];
      while (stmt.step()) {
        books.push(this.rowToBook(stmt.getAsObject() as Record<string, unknown>));
      }
      stmt.free();

      return books.map(book => this.hydrateBook(book));
    } catch (error) {
      console.warn('[CalibreDB] FTS5 search failed, falling back to LIKE:', error);
      return this.searchByTitle(query);
    }
  }

  /**
   * Advanced FTS5 search with highlighted results
   * Returns book IDs with highlight snippets
   */
  searchFTS5WithHighlights(query: string, limit: number = 100): Array<{
    bookId: number;
    titleHighlight: string;
    authorsHighlight: string;
    descriptionSnippet: string;
  }> {
    this.ensureOpen();

    if (!this.ftsInitialized) {
      return [];
    }

    try {
      const fts5Query = this.sanitizeFTS5Query(query);

      const stmt = this.db!.prepare(queries.SEARCH_FTS5_ADVANCED);
      stmt.bind([fts5Query, limit]);

      const results: Array<{
        bookId: number;
        titleHighlight: string;
        authorsHighlight: string;
        descriptionSnippet: string;
      }> = [];

      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>;
        results.push({
          bookId: row.rowid as number,
          titleHighlight: row.title_highlight as string || '',
          authorsHighlight: row.authors_highlight as string || '',
          descriptionSnippet: row.description_snippet as string || '',
        });
      }

      stmt.free();
      return results;
    } catch (error) {
      console.warn('[CalibreDB] FTS5 highlight search failed:', error);
      return [];
    }
  }

  /**
   * Check if FTS5 is available and initialized
   */
  isFTS5Available(): boolean {
    return this.ftsInitialized;
  }

  /**
   * Sanitize a query string for FTS5
   * Escapes special characters and adds prefix matching
   */
  private sanitizeFTS5Query(query: string): string {
    // Trim and handle empty query
    query = query.trim();
    if (!query) return '""';

    // If query contains FTS5 operators, use as-is
    if (query.includes(':') || query.includes('OR') || query.includes('AND') || query.includes('NOT')) {
      return query;
    }

    // Split into words and add wildcard suffix for prefix matching
    const words = query.split(/\s+/).filter(w => w.length > 0);

    // Escape special characters in each word
    const escapedWords = words.map(word => {
      // Escape quotes
      word = word.replace(/"/g, '""');
      // Add wildcard for prefix matching
      return `"${word}"*`;
    });

    return escapedWords.join(' ');
  }

  // ===========================================================================
  // Relationship Queries
  // ===========================================================================

  /**
   * Get authors for a book
   */
  getAuthorsForBook(bookId: number): CalibreAuthor[] {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_AUTHORS_FOR_BOOK);
    stmt.bind([bookId]);

    const authors: CalibreAuthor[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      authors.push({
        id: row.id as number,
        name: row.name as string,
        sort: row.sort as string,
        link: (row.link as string) || '',
      });
    }
    stmt.free();

    return authors;
  }

  /**
   * Get series for a book
   */
  getSeriesForBook(bookId: number): CalibreSeries | null {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_SERIES_FOR_BOOK);
    stmt.bind([bookId]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();

    return {
      id: row.id as number,
      name: row.name as string,
      sort: row.sort as string,
    };
  }

  /**
   * Get tags for a book
   */
  getTagsForBook(bookId: number): CalibreTag[] {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_TAGS_FOR_BOOK);
    stmt.bind([bookId]);

    const tags: CalibreTag[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      tags.push({
        id: row.id as number,
        name: row.name as string,
      });
    }
    stmt.free();

    return tags;
  }

  /**
   * Get publisher for a book
   */
  getPublisherForBook(bookId: number): CalibrePublisher | null {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_PUBLISHER_FOR_BOOK);
    stmt.bind([bookId]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();

    return {
      id: row.id as number,
      name: row.name as string,
      sort: (row.sort as string) || (row.name as string),
    };
  }

  /**
   * Get languages for a book
   */
  getLanguagesForBook(bookId: number): CalibreLanguage[] {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_LANGUAGES_FOR_BOOK);
    stmt.bind([bookId]);

    const languages: CalibreLanguage[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      languages.push({
        id: row.id as number,
        lang_code: row.lang_code as string,
      });
    }
    stmt.free();

    return languages;
  }

  /**
   * Get formats for a book
   */
  getFormatsForBook(bookId: number): CalibreFormat[] {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_FORMATS_FOR_BOOK);
    stmt.bind([bookId]);

    const formats: CalibreFormat[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      formats.push({
        id: row.id as number,
        book: row.book as number,
        format: row.format as string,
        uncompressed_size: row.uncompressed_size as number,
        name: row.name as string,
      });
    }
    stmt.free();

    return formats;
  }

  /**
   * Get identifiers for a book
   */
  getIdentifiersForBook(bookId: number): Record<string, string> {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_IDENTIFIERS_FOR_BOOK);
    stmt.bind([bookId]);

    const identifiers: Record<string, string> = {};
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      identifiers[row.type as string] = row.val as string;
    }
    stmt.free();

    return identifiers;
  }

  /**
   * Get rating for a book (0-5 scale)
   */
  getRatingForBook(bookId: number): number | null {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_RATING_FOR_BOOK);
    stmt.bind([bookId]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();

    return row.rating as number;
  }

  /**
   * Get description/comment for a book
   */
  getDescriptionForBook(bookId: number): string | null {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_COMMENT_FOR_BOOK);
    stmt.bind([bookId]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();

    return row.text as string;
  }

  // ===========================================================================
  // Index Queries
  // ===========================================================================

  /**
   * Get all unique authors
   */
  getAllAuthors(): CalibreAuthor[] {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_ALL_AUTHORS);
    const authors: CalibreAuthor[] = [];

    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      authors.push({
        id: row.id as number,
        name: row.name as string,
        sort: row.sort as string,
        link: (row.link as string) || '',
      });
    }
    stmt.free();

    return authors;
  }

  /**
   * Get all unique series
   */
  getAllSeries(): CalibreSeries[] {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_ALL_SERIES);
    const series: CalibreSeries[] = [];

    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      series.push({
        id: row.id as number,
        name: row.name as string,
        sort: row.sort as string,
      });
    }
    stmt.free();

    return series;
  }

  /**
   * Get all unique tags
   */
  getAllTags(): CalibreTag[] {
    this.ensureOpen();

    const stmt = this.db!.prepare(queries.GET_ALL_TAGS);
    const tags: CalibreTag[] = [];

    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      tags.push({
        id: row.id as number,
        name: row.name as string,
      });
    }
    stmt.free();

    return tags;
  }

  // ===========================================================================
  // Write Operations (for bidirectional sync)
  // ===========================================================================

  /**
   * Update rating for a book
   */
  setRating(bookId: number, rating: number): void {
    if (this.readonly) {
      throw new Error('Database is readonly');
    }
    this.ensureOpen();

    // Calibre stores ratings as 0-10 (2 per star)
    const calibreRating = Math.round(rating * 2);

    // First, upsert the rating value
    this.db!.run(queries.UPSERT_RATING, [calibreRating]);

    // Then link it to the book
    this.db!.run(queries.LINK_BOOK_RATING, [bookId, calibreRating]);

    // Update last_modified
    this.updateBookModified(bookId);
  }

  /**
   * Add a tag to a book
   */
  addTag(bookId: number, tagName: string): void {
    if (this.readonly) {
      throw new Error('Database is readonly');
    }
    this.ensureOpen();

    // Create tag if it doesn't exist
    this.db!.run(queries.CREATE_TAG, [tagName]);

    // Link to book
    this.db!.run(queries.ADD_TAG_TO_BOOK, [bookId, tagName]);

    // Update last_modified
    this.updateBookModified(bookId);
  }

  /**
   * Remove a tag from a book
   */
  removeTag(bookId: number, tagName: string): void {
    if (this.readonly) {
      throw new Error('Database is readonly');
    }
    this.ensureOpen();

    this.db!.run(queries.REMOVE_TAG_FROM_BOOK, [bookId, tagName]);

    // Update last_modified
    this.updateBookModified(bookId);
  }

  /**
   * Update book's last_modified timestamp
   */
  private updateBookModified(bookId: number): void {
    const now = new Date().toISOString();
    this.db!.run(queries.UPDATE_BOOK_MODIFIED, [now, bookId]);
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Ensure database is open
   */
  private ensureOpen(): void {
    if (!this.db) {
      throw new Error('Database is not open. Call open() first.');
    }
  }

  /**
   * Convert a database row to a CalibreBook object
   */
  private rowToBook(row: Record<string, unknown>): CalibreBook {
    return {
      id: row.id as number,
      title: row.title as string,
      sort: row.sort as string,
      timestamp: row.timestamp as string,
      pubdate: (row.pubdate as string) || null,
      series_index: (row.series_index as number) || 1,
      author_sort: row.author_sort as string,
      isbn: (row.isbn as string) || null,
      lccn: (row.lccn as string) || null,
      path: row.path as string,
      flags: (row.flags as number) || 0,
      uuid: row.uuid as string,
      has_cover: Boolean(row.has_cover),
      last_modified: row.last_modified as string,
    };
  }

  /**
   * Hydrate a CalibreBook with all related data
   */
  private hydrateBook(book: CalibreBook): CalibreBookFull {
    const authors = this.getAuthorsForBook(book.id);
    const series = this.getSeriesForBook(book.id);
    const tags = this.getTagsForBook(book.id);
    const publisher = this.getPublisherForBook(book.id);
    const languages = this.getLanguagesForBook(book.id);
    const formats = this.getFormatsForBook(book.id);
    const identifiers = this.getIdentifiersForBook(book.id);
    const rating = this.getRatingForBook(book.id);
    const description = this.getDescriptionForBook(book.id);

    // Build full paths
    const calibrePath = path.join(this.libraryPath, book.path);
    const coverPath = book.has_cover
      ? path.join(calibrePath, 'cover.jpg')
      : null;

    // Find EPUB path
    const epubFormat = formats.find((f) => f.format === 'EPUB');
    const epubPath = epubFormat
      ? path.join(calibrePath, `${epubFormat.name}.epub`)
      : null;

    return {
      id: book.id,
      uuid: book.uuid,
      title: book.title,
      titleSort: book.sort,
      path: book.path,
      hasCover: book.has_cover,
      addedAt: new Date(book.timestamp),
      lastModified: new Date(book.last_modified),

      authors,
      series,
      seriesIndex: series ? book.series_index : null,
      tags,
      publisher,
      languages,
      formats,
      identifiers,
      rating,
      description,
      pubdate: book.pubdate ? new Date(book.pubdate) : null,

      coverPath,
      epubPath,
      calibrePath,
    };
  }
}

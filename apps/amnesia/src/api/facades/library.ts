/**
 * Library API Facade
 * @module api/facades/library
 */

import type { Readable } from 'svelte/store';
import type {
  LibraryState,
  LibraryCommands,
  Book,
  ReadingStatus,
  ScanResult,
  Capability,
  BookQueryOptions,
  LibraryStats
} from '../types';
import type { LibraryService } from '../../library/library-service';
import type { Store } from '../../helpers/store';
import { createReactiveStore } from '../reactive-selector';
import { requireCapability } from '../security/capabilities';
import { TypedEventEmitter } from '../events/emitter';

/**
 * Library API implementation
 */
export class LibraryAPI implements LibraryCommands {
  private stateStore: Readable<LibraryState>;

  constructor(
    private service: LibraryService,
    private store: Store<any, any>,
    private capabilities: Set<Capability>,
    private events: TypedEventEmitter
  ) {
    this.stateStore = createReactiveStore(store);
  }

  /**
   * Get reactive state store
   */
  getState(): Readable<LibraryState> {
    return this.stateStore;
  }

  /**
   * Get a book by ID
   */
  getBook(bookId: string): Book | null {
    const book = this.service.getBook(bookId);
    return book ? this.toPublicBook(book) : null;
  }

  /**
   * Search books by query
   */
  search(query: string): Book[] {
    return this.service.search(query).map(b => this.toPublicBook(b));
  }

  /**
   * Filter books by status
   */
  filterByStatus(status: ReadingStatus): Book[] {
    // Convert 'unread' to 'to-read' for internal compatibility
    const internalStatus = status === 'unread' ? 'to-read' : status;
    return this.service.filterByStatus(internalStatus as any).map(b => this.toPublicBook(b));
  }

  /**
   * Update reading progress
   */
  async updateProgress(bookId: string, progress: number, cfi?: string): Promise<void> {
    requireCapability(this.capabilities, 'write-library', 'update progress');

    await this.service.updateProgress(bookId, progress, cfi);

    // Emit event
    this.events.emit('progress-updated', { bookId, progress, cfi });
  }

  /**
   * Scan library folder
   */
  async scan(folder?: string): Promise<ScanResult> {
    requireCapability(this.capabilities, 'write-library', 'scan library');

    const result = await this.service.scan(folder || '') as any;

    // The internal ScanResult has { books: Book[], errors: ScanError[] }
    // We convert to the public API format
    const publicResult: ScanResult = {
      added: result.books?.length ?? 0,
      updated: 0, // Not tracked by internal scanner
      removed: 0, // Not tracked by internal scanner
      errors: (result.errors ?? []).map((e: any) => `${e.path}: ${e.error}`)
    };

    // Emit event
    this.events.emit('library-scanned', { result: publicResult });

    return publicResult;
  }

  /**
   * Get recent books
   */
  getRecentBooks(limit: number = 10): Book[] {
    return this.service.getRecentBooks(limit).map(b => this.toPublicBook(b));
  }

  /**
   * Get all books
   */
  getAllBooks(): Book[] {
    return this.store.getValue().books.map((b: any) => this.toPublicBook(b));
  }

  // ============================================================================
  // Advanced Query Methods
  // ============================================================================

  /**
   * Query books with flexible filtering, sorting, and pagination
   */
  queryBooks(options: BookQueryOptions): Book[] {
    let books = this.getAllBooks();

    // Apply filters
    if (options.author) {
      const authorLower = options.author.toLowerCase();
      books = books.filter(b => b.author.toLowerCase().includes(authorLower));
    }

    if (options.tag) {
      books = books.filter(b => b.metadata?.tags?.includes(options.tag!));
    }

    if (options.tags && options.tags.length > 0) {
      books = books.filter(b => {
        const bookTags = b.metadata?.tags || [];
        return options.tags!.every(t => bookTags.includes(t));
      });
    }

    if (options.series) {
      const seriesLower = options.series.toLowerCase();
      books = books.filter(b =>
        b.metadata?.series?.toLowerCase().includes(seriesLower)
      );
    }

    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      books = books.filter(b => statuses.includes(b.status));
    }

    if (options.language) {
      books = books.filter(b => b.metadata?.language === options.language);
    }

    if (options.publisher) {
      const pubLower = options.publisher.toLowerCase();
      books = books.filter(b =>
        b.metadata?.publisher?.toLowerCase().includes(pubLower)
      );
    }

    if (options.addedAfter) {
      const after = new Date(options.addedAfter).getTime();
      books = books.filter(b => new Date(b.dateAdded).getTime() >= after);
    }

    if (options.addedBefore) {
      const before = new Date(options.addedBefore).getTime();
      books = books.filter(b => new Date(b.dateAdded).getTime() <= before);
    }

    if (options.readAfter) {
      const after = new Date(options.readAfter).getTime();
      books = books.filter(b => b.lastRead && new Date(b.lastRead).getTime() >= after);
    }

    if (options.readBefore) {
      const before = new Date(options.readBefore).getTime();
      books = books.filter(b => b.lastRead && new Date(b.lastRead).getTime() <= before);
    }

    if (options.minProgress !== undefined) {
      books = books.filter(b => b.progress >= options.minProgress!);
    }

    if (options.maxProgress !== undefined) {
      books = books.filter(b => b.progress <= options.maxProgress!);
    }

    if (options.textSearch) {
      const searchLower = options.textSearch.toLowerCase();
      books = books.filter(b =>
        b.title.toLowerCase().includes(searchLower) ||
        b.author.toLowerCase().includes(searchLower) ||
        b.metadata?.description?.toLowerCase().includes(searchLower)
      );
    }

    // Apply sorting
    if (options.sortBy) {
      const order = options.sortOrder === 'desc' ? -1 : 1;
      books.sort((a, b) => {
        let aVal: string | number = '';
        let bVal: string | number = '';
        switch (options.sortBy) {
          case 'title':
            aVal = a.title.toLowerCase();
            bVal = b.title.toLowerCase();
            break;
          case 'author':
            aVal = a.author.toLowerCase();
            bVal = b.author.toLowerCase();
            break;
          case 'dateAdded':
            aVal = new Date(a.dateAdded).getTime();
            bVal = new Date(b.dateAdded).getTime();
            break;
          case 'lastRead':
            aVal = a.lastRead ? new Date(a.lastRead).getTime() : 0;
            bVal = b.lastRead ? new Date(b.lastRead).getTime() : 0;
            break;
          case 'progress':
            aVal = a.progress;
            bVal = b.progress;
            break;
          case 'series':
            aVal = a.metadata?.series?.toLowerCase() || '';
            bVal = b.metadata?.series?.toLowerCase() || '';
            break;
          default:
            return 0;
        }
        if (aVal < bVal) return -order;
        if (aVal > bVal) return order;
        return 0;
      });
    }

    // Apply pagination
    const offset = options.offset || 0;
    if (options.limit) {
      books = books.slice(offset, offset + options.limit);
    } else if (offset > 0) {
      books = books.slice(offset);
    }

    return books;
  }

  /**
   * Get books by a specific author (partial match)
   */
  getBooksByAuthor(author: string): Book[] {
    return this.queryBooks({ author, sortBy: 'title' });
  }

  /**
   * Get books with a specific tag
   */
  getBooksWithTag(tag: string): Book[] {
    return this.queryBooks({ tag, sortBy: 'title' });
  }

  /**
   * Get books in a series
   */
  getBooksInSeries(series: string): Book[] {
    const books = this.queryBooks({ series });
    // Sort by series index
    return books.sort((a, b) => {
      const aIdx = a.metadata?.seriesIndex ?? Infinity;
      const bIdx = b.metadata?.seriesIndex ?? Infinity;
      return aIdx - bIdx;
    });
  }

  /**
   * Get books by language
   */
  getBooksByLanguage(language: string): Book[] {
    return this.queryBooks({ language, sortBy: 'title' });
  }

  /**
   * Get books modified since a date
   */
  getBooksModifiedSince(since: Date | string): Book[] {
    const sinceDate = new Date(since);
    return this.getAllBooks().filter(b => {
      const lastRead = b.lastRead ? new Date(b.lastRead) : null;
      const dateAdded = new Date(b.dateAdded);
      const lastModified = lastRead && lastRead > dateAdded ? lastRead : dateAdded;
      return lastModified >= sinceDate;
    });
  }

  // ============================================================================
  // Aggregation Methods
  // ============================================================================

  /**
   * Get all unique authors in the library
   */
  getAuthors(): string[] {
    const authors = new Set<string>();
    for (const book of this.getAllBooks()) {
      if (book.author) {
        // Handle multiple authors separated by common delimiters
        const bookAuthors = book.author.split(/[,;&]/).map(a => a.trim());
        bookAuthors.forEach(a => {
          if (a) authors.add(a);
        });
      }
    }
    return Array.from(authors).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Get all unique tags in the library
   */
  getTags(): string[] {
    const tags = new Set<string>();
    for (const book of this.getAllBooks()) {
      const bookTags = book.metadata?.tags || book.metadata?.subjects || [];
      bookTags.forEach(t => tags.add(t));
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Get all unique series in the library
   */
  getSeries(): Array<{ name: string; bookCount: number }> {
    const seriesMap = new Map<string, number>();
    for (const book of this.getAllBooks()) {
      const series = book.metadata?.series;
      if (series) {
        seriesMap.set(series, (seriesMap.get(series) || 0) + 1);
      }
    }
    return Array.from(seriesMap.entries())
      .map(([name, bookCount]) => ({ name, bookCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get all unique languages in the library
   */
  getLanguages(): string[] {
    const languages = new Set<string>();
    for (const book of this.getAllBooks()) {
      if (book.metadata?.language) {
        languages.add(book.metadata.language);
      }
    }
    return Array.from(languages).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Get library statistics
   */
  getLibraryStats(): LibraryStats {
    const books = this.getAllBooks();
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Initialize status counts with all possible statuses
    const byStatus: Record<ReadingStatus, number> = {
      'to-read': 0,
      'reading': 0,
      'completed': 0,
      'archived': 0,
      'unread': 0
    };

    const byLanguage: Record<string, number> = {};
    const bySeries: Record<string, number> = {};
    const authors = new Set<string>();
    const tags = new Set<string>();
    let totalProgress = 0;
    let recentlyAdded = 0;
    let recentlyRead = 0;
    let completedThisMonth = 0;

    for (const book of books) {
      // Status counts
      byStatus[book.status] = (byStatus[book.status] || 0) + 1;

      // Language counts
      const lang = book.metadata?.language || 'Unknown';
      byLanguage[lang] = (byLanguage[lang] || 0) + 1;

      // Series counts
      if (book.metadata?.series) {
        bySeries[book.metadata.series] = (bySeries[book.metadata.series] || 0) + 1;
      }

      // Author tracking
      if (book.author) {
        book.author.split(/[,;&]/).forEach(a => {
          const trimmed = a.trim();
          if (trimmed) authors.add(trimmed);
        });
      }

      // Tag tracking
      const bookTags = book.metadata?.tags || book.metadata?.subjects || [];
      bookTags.forEach(t => tags.add(t));

      // Progress
      totalProgress += book.progress;

      // Recent activity
      if (new Date(book.dateAdded) >= sevenDaysAgo) {
        recentlyAdded++;
      }
      if (book.lastRead && new Date(book.lastRead) >= sevenDaysAgo) {
        recentlyRead++;
      }

      // Completed this month
      if (book.status === 'completed' && book.lastRead) {
        const completedDate = new Date(book.lastRead);
        if (completedDate >= startOfMonth) {
          completedThisMonth++;
        }
      }
    }

    return {
      totalBooks: books.length,
      byStatus,
      byLanguage,
      bySeries,
      averageProgress: books.length > 0 ? totalProgress / books.length : 0,
      recentlyAdded,
      recentlyRead,
      completedThisMonth,
      uniqueAuthors: authors.size,
      uniqueTags: tags.size
    };
  }

  /**
   * Convert internal Book to public API Book
   */
  private toPublicBook(book: any): Book {
    return {
      id: book.id,
      title: book.title,
      author: book.author || '',
      localPath: book.localPath || '',
      coverPath: book.coverPath,
      progress: book.progress || 0,
      status: book.status || 'unread',
      lastRead: book.lastRead?.toISOString?.() || book.lastRead,
      dateAdded: book.dateAdded?.toISOString?.() || book.dateAdded || new Date().toISOString(),
      metadata: book.metadata
    };
  }
}

/**
 * Create library API
 */
export function createLibraryAPI(
  service: LibraryService,
  store: Store<any, any>,
  capabilities: Set<Capability>,
  events: TypedEventEmitter
): { state: Readable<LibraryState>; commands: LibraryCommands } {
  const api = new LibraryAPI(service, store, capabilities, events);
  return {
    state: api.getState(),
    commands: api
  };
}

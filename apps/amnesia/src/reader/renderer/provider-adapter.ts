/**
 * Provider Adapter
 *
 * Adapts book providers to the ContentProvider interface.
 */

import type { ParsedBook, ChapterContent } from './types';

interface HybridBookProvider {
  loadBook(data: ArrayBuffer, filename?: string): Promise<ParsedBook>;
  loadBookById?(bookId: string): Promise<ParsedBook>;
  getChapter(bookId: string, href: string): Promise<ChapterContent>;
  getResource(bookId: string, href: string): Promise<Uint8Array>;
  getResourceAsUrl(bookId: string, href: string): Promise<string>;
  isAvailable(): boolean;
}

/**
 * Chapter cache for provider adapter
 */
class ChapterCache {
  private cache: Map<string, ChapterContent> = new Map();
  private pending: Map<string, Promise<ChapterContent>> = new Map();

  private getKey(bookId: string, href: string): string {
    return `${bookId}:${href}`;
  }

  has(bookId: string, href: string): boolean {
    return this.cache.has(this.getKey(bookId, href));
  }

  get(bookId: string, href: string): ChapterContent | undefined {
    return this.cache.get(this.getKey(bookId, href));
  }

  set(bookId: string, href: string, content: ChapterContent): void {
    this.cache.set(this.getKey(bookId, href), content);
  }

  getPending(bookId: string, href: string): Promise<ChapterContent> | undefined {
    return this.pending.get(this.getKey(bookId, href));
  }

  setPending(bookId: string, href: string, promise: Promise<ChapterContent>): void {
    this.pending.set(this.getKey(bookId, href), promise);
  }

  removePending(bookId: string, href: string): void {
    this.pending.delete(this.getKey(bookId, href));
  }

  clear(bookId?: string): void {
    if (bookId) {
      const prefix = `${bookId}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }
}

/**
 * Adapts HybridBookProvider to renderer-compatible interface
 */
export class ProviderAdapter {
  private provider: HybridBookProvider;
  private chapterCache: ChapterCache;
  private loadedBooks: Map<string, ParsedBook> = new Map();

  constructor(provider: HybridBookProvider) {
    this.provider = provider;
    this.chapterCache = new ChapterCache();
  }

  /**
   * Get a book by ID (from already loaded books)
   */
  async getBook(bookId: string): Promise<ParsedBook> {
    const cached = this.loadedBooks.get(bookId);
    if (cached) {
      return cached;
    }

    // Try to load from provider if it supports loadBookById
    if (this.provider.loadBookById) {
      const book = await this.provider.loadBookById(bookId);
      this.loadedBooks.set(bookId, book);
      return book;
    }

    throw new Error(`Book ${bookId} not loaded`);
  }

  /**
   * Upload and parse a book from raw bytes
   */
  async uploadBook(data: ArrayBuffer, filename?: string): Promise<ParsedBook> {
    const book = await this.provider.loadBook(data, filename);
    this.loadedBooks.set(book.id, book);
    return book;
  }

  /**
   * Check if a chapter is cached
   */
  isChapterCached(bookId: string, href: string): boolean {
    return this.chapterCache.has(bookId, href);
  }

  /**
   * Clear chapter cache
   */
  clearChapterCache(bookId?: string): void {
    this.chapterCache.clear(bookId);
  }

  /**
   * Get chapter content with caching
   */
  async getChapter(
    bookId: string,
    href: string,
    _includeHighlights = true
  ): Promise<ChapterContent> {
    // Check cache
    const cached = this.chapterCache.get(bookId, href);
    if (cached) {
      console.log('[ProviderAdapter] getChapter HIT CACHE for:', href);
      return cached;
    }

    // Check pending request
    const pending = this.chapterCache.getPending(bookId, href);
    if (pending) {
      console.log('[ProviderAdapter] getChapter HIT PENDING for:', href);
      return pending;
    }

    // Fetch from provider
    console.log('[ProviderAdapter] getChapter FETCHING from provider for:', href);
    const promise = this.provider.getChapter(bookId, href).then((chapter) => {
      console.log('[ProviderAdapter] getChapter RECEIVED from provider:', href, 'html length:', chapter.html.length);
      // DEBUG: Check for img tags in received content
      const imgTags = chapter.html.match(/<img[^>]*>/gi) || [];
      console.log('[ProviderAdapter] img tags in received chapter:', imgTags.slice(0, 3));
      this.chapterCache.set(bookId, href, chapter);
      this.chapterCache.removePending(bookId, href);
      return chapter;
    }).catch((error) => {
      this.chapterCache.removePending(bookId, href);
      throw error;
    });

    this.chapterCache.setPending(bookId, href, promise);
    return promise;
  }

  /**
   * Preload a chapter without waiting
   */
  preloadChapter(bookId: string, href: string): void {
    if (this.chapterCache.has(bookId, href) || this.chapterCache.getPending(bookId, href)) {
      return;
    }

    this.getChapter(bookId, href, true).catch((error) => {
      console.warn('[ProviderAdapter] Failed to preload chapter:', href, error);
    });
  }

  /**
   * Get a resource (image, CSS, font) as a Blob
   */
  async getResource(bookId: string, href: string): Promise<Blob> {
    const bytes = await this.provider.getResource(bookId, href);
    const mimeType = this.guessMimeType(href);
    // Convert Uint8Array to ArrayBuffer for Blob constructor
    // Use a new Uint8Array to ensure we have a standard ArrayBuffer
    const copy = new Uint8Array(bytes);
    return new Blob([copy], { type: mimeType });
  }

  /**
   * Get resource as data URL for embedding
   */
  async getResourceAsDataUrl(bookId: string, href: string): Promise<string> {
    return this.provider.getResourceAsUrl(bookId, href);
  }

  /**
   * Health check (always returns true for adapter)
   */
  async healthCheck(): Promise<boolean> {
    return this.provider.isAvailable();
  }

  /**
   * Get the underlying provider
   */
  getProvider(): HybridBookProvider {
    return this.provider;
  }

  /**
   * Guess MIME type from file extension
   */
  private guessMimeType(href: string): string {
    const ext = href.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webp: 'image/webp',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      otf: 'font/otf',
      css: 'text/css',
      html: 'text/html',
      xhtml: 'application/xhtml+xml',
      xml: 'application/xml',
    };
    return mimeTypes[ext || ''] || 'application/octet-stream';
  }
}

/**
 * Create a provider adapter
 */
export function createProviderAdapter(provider: HybridBookProvider): ProviderAdapter {
  return new ProviderAdapter(provider);
}

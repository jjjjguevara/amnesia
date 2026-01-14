/**
 * MuPDF EPUB Content Provider
 *
 * Implements the ContentProvider interface using MuPDF WASM for EPUB parsing.
 * This is the bridge between the Shadow DOM renderer and MuPDF EPUB backend.
 *
 * Features:
 * - Chapter HTML extraction via MuPDF
 * - TOC and metadata extraction
 * - Resource resolution (images, CSS) to data URLs
 * - Chapter-level caching for performance
 */

import type { ContentProvider } from '../renderer';
import type {
  ParsedBook,
  ChapterContent,
  SpineItem,
  TocEntry,
  BookMetadata,
  RenderedHighlight,
} from '../types';
import {
  MuPDFEpubBridge,
  getSharedMuPDFEpubBridge,
  type ParsedEpub,
  type EpubChapterContent,
} from './mupdf-epub-bridge';

// ============================================================================
// Types
// ============================================================================

/**
 * Cached chapter data
 */
interface CachedChapter {
  content: ChapterContent;
  timestamp: number;
}

/**
 * Resource cache entry
 */
interface CachedResource {
  dataUrl: string;
  timestamp: number;
}

// ============================================================================
// MuPDF EPUB Content Provider
// ============================================================================

/**
 * ContentProvider implementation that uses MuPDF WASM for EPUB parsing.
 *
 * This provider is designed for the hybrid approach:
 * - MuPDF handles: Parsing, text extraction, TOC, search
 * - Shadow DOM handles: Visual rendering, typography, highlights
 *
 * The provider caches chapter content to avoid repeated MuPDF calls
 * and resolves embedded resources to data URLs for Shadow DOM.
 */
export class MuPDFEpubContentProvider implements ContentProvider {
  private bridge: MuPDFEpubBridge | null = null;

  // Cached parsed books
  private bookCache = new Map<string, {
    book: ParsedBook;
    epubData: ParsedEpub;
  }>();

  // Chapter content cache (per book)
  private chapterCache = new Map<string, Map<string, CachedChapter>>();

  // Resource cache (per book)
  private resourceCache = new Map<string, Map<string, CachedResource>>();

  // Cache configuration
  private readonly maxChapterCacheAge = 5 * 60 * 1000; // 5 minutes
  private readonly maxResourceCacheAge = 30 * 60 * 1000; // 30 minutes

  /**
   * Initialize the content provider
   */
  async initialize(): Promise<void> {
    if (this.bridge) {
      return;
    }
    this.bridge = await getSharedMuPDFEpubBridge();
    console.log('[MuPDF EPUB ContentProvider] Initialized');
  }

  /**
   * Ensure bridge is available
   */
  private async ensureBridge(): Promise<MuPDFEpubBridge> {
    if (!this.bridge) {
      await this.initialize();
    }
    if (!this.bridge) {
      throw new Error('MuPDF EPUB ContentProvider not initialized');
    }
    return this.bridge;
  }

  // ============================================================================
  // ContentProvider Interface
  // ============================================================================

  /**
   * Get a book by ID (must be loaded first via uploadBook)
   */
  async getBook(bookId: string): Promise<ParsedBook> {
    const cached = this.bookCache.get(bookId);
    if (cached) {
      return cached.book;
    }

    throw new Error(`Book ${bookId} not found. Call uploadBook() first.`);
  }

  /**
   * Upload and parse an EPUB file
   *
   * This is the main entry point for loading EPUBs.
   * MuPDF parses the EPUB and extracts structure.
   */
  async uploadBook(data: ArrayBuffer, filename?: string): Promise<ParsedBook> {
    const bridge = await this.ensureBridge();

    // Generate book ID from filename or hash
    const bookId = filename
      ? `epub-${filename.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`
      : `epub-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Open EPUB with MuPDF
    const epub = await bridge.openEpub(data, bookId);

    // Convert to ParsedBook format
    const book: ParsedBook = {
      id: bookId,
      metadata: this.convertMetadata(epub.metadata, filename),
      toc: epub.toc,
      spine: this.convertSpine(epub.spine),
    };

    // Cache the book
    this.bookCache.set(bookId, { book, epubData: epub });
    this.chapterCache.set(bookId, new Map());
    this.resourceCache.set(bookId, new Map());

    console.log(`[MuPDF EPUB ContentProvider] Loaded book: ${book.metadata.title} (${epub.chapterCount} chapters)`);

    return book;
  }

  /**
   * Check if a chapter is cached
   */
  isChapterCached(bookId: string, href: string): boolean {
    const bookChapters = this.chapterCache.get(bookId);
    if (!bookChapters) {
      return false;
    }

    const cached = bookChapters.get(href);
    if (!cached) {
      return false;
    }

    // Check if cache is still valid
    return Date.now() - cached.timestamp < this.maxChapterCacheAge;
  }

  /**
   * Get chapter content
   *
   * Extracts HTML from EPUB chapter via MuPDF.
   * Caches result for performance.
   */
  async getChapter(
    bookId: string,
    href: string,
    _includeHighlights?: boolean
  ): Promise<ChapterContent> {
    const bridge = await this.ensureBridge();

    // Check cache first
    const bookChapters = this.chapterCache.get(bookId);
    if (bookChapters) {
      const cached = bookChapters.get(href);
      if (cached && Date.now() - cached.timestamp < this.maxChapterCacheAge) {
        // Refresh TTL on cache hit (sliding expiration)
        cached.timestamp = Date.now();
        return cached.content;
      }
    }

    // Get book info
    const bookData = this.bookCache.get(bookId);
    if (!bookData) {
      throw new Error(`Book ${bookId} not loaded`);
    }

    // Parse href to get chapter index
    const chapterIndex = this.hrefToChapterIndex(href, bookData.book.spine);

    // Get chapter content from MuPDF
    const epubContent = await bridge.getChapterHtml(bookId, chapterIndex);

    // Convert to ChapterContent format
    const content: ChapterContent = {
      html: epubContent.html,
      href: href,
      spineIndex: chapterIndex,
      highlights: [], // Highlights are managed separately by Shadow DOM renderer
    };

    // Cache the content
    if (!this.chapterCache.has(bookId)) {
      this.chapterCache.set(bookId, new Map());
    }
    this.chapterCache.get(bookId)!.set(href, {
      content,
      timestamp: Date.now(),
    });

    return content;
  }

  /**
   * Preload a chapter in the background
   */
  preloadChapter(bookId: string, href: string): void {
    // Fire and forget - just populate the cache
    this.getChapter(bookId, href).catch(err => {
      // Clean up potentially corrupt cache entry on failure
      this.chapterCache.get(bookId)?.delete(href);
      console.warn(`[MuPDFEpubContentProvider] Failed to preload chapter ${href}:`, err);
    });
  }

  /**
   * Clear chapter cache
   */
  clearChapterCache(bookId?: string): void {
    if (bookId) {
      this.chapterCache.get(bookId)?.clear();
    } else {
      this.chapterCache.forEach(cache => cache.clear());
    }
  }

  /**
   * Get resource as data URL
   *
   * For embedded images and stylesheets in EPUB.
   * Currently not implemented - MuPDF HTML extraction includes inline styles.
   */
  async getResourceAsDataUrl(bookId: string, href: string): Promise<string> {
    // Check cache first
    const bookResources = this.resourceCache.get(bookId);
    if (bookResources) {
      const cached = bookResources.get(href);
      if (cached && Date.now() - cached.timestamp < this.maxResourceCacheAge) {
        return cached.dataUrl;
      }
    }

    // TODO: Implement resource extraction via MuPDF
    // For now, return empty data URL
    console.warn(`[MuPDF EPUB ContentProvider] Resource not available: ${href}`);
    return 'data:application/octet-stream;base64,';
  }

  // ============================================================================
  // Extended API (beyond ContentProvider)
  // ============================================================================

  /**
   * Search book for text
   */
  async search(bookId: string, query: string, maxHits: number = 100): Promise<Array<{
    chapterIndex: number;
    text: string;
    snippet: string;
  }>> {
    const bridge = await this.ensureBridge();
    const results = await bridge.search(bookId, query, maxHits);

    return results.map(r => ({
      chapterIndex: r.chapterIndex,
      text: r.text,
      snippet: r.snippet,
    }));
  }

  /**
   * Get plain text of a chapter (for search indexing)
   */
  async getChapterText(bookId: string, chapterIndex: number): Promise<string> {
    const bridge = await this.ensureBridge();
    return bridge.getChapterText(bookId, chapterIndex);
  }

  /**
   * Check if book is fixed-layout
   */
  isFixedLayout(bookId: string): boolean {
    const bookData = this.bookCache.get(bookId);
    return bookData?.epubData.isFixedLayout ?? false;
  }

  /**
   * Get chapter count
   */
  getChapterCount(bookId: string): number {
    const bookData = this.bookCache.get(bookId);
    return bookData?.epubData.chapterCount ?? 0;
  }

  /**
   * Close a book and release resources
   */
  async closeBook(bookId: string): Promise<void> {
    const bridge = await this.ensureBridge();
    await bridge.closeEpub(bookId);

    this.bookCache.delete(bookId);
    this.chapterCache.delete(bookId);
    this.resourceCache.delete(bookId);

    console.log(`[MuPDF EPUB ContentProvider] Closed book: ${bookId}`);
  }

  /**
   * Destroy the provider
   */
  destroy(): void {
    this.bookCache.clear();
    this.chapterCache.clear();
    this.resourceCache.clear();
    this.bridge = null;
    console.log('[MuPDF EPUB ContentProvider] Destroyed');
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Convert MuPDF metadata to BookMetadata format
   */
  private convertMetadata(
    epubMeta: { title: string; creator?: string; publisher?: string; language?: string },
    filename?: string
  ): BookMetadata {
    return {
      id: `metadata-${Date.now()}`,
      title: epubMeta.title || filename?.replace(/\.[^.]+$/, '') || 'Unknown',
      creators: epubMeta.creator
        ? [{ name: epubMeta.creator }]
        : [],
      publisher: epubMeta.publisher,
      // Use provided language or fallback to 'und' (undetermined) per BCP-47
      language: epubMeta.language || 'und',
    };
  }

  /**
   * Convert MuPDF spine to SpineItem format
   */
  private convertSpine(epubSpine: Array<{
    id: string;
    href: string;
    linear: boolean;
    mediaType: string;
  }>): SpineItem[] {
    return epubSpine.map(item => ({
      id: item.id,
      href: item.href,
      linear: item.linear,
      mediaType: item.mediaType,
    }));
  }

  /**
   * Convert href to chapter index
   *
   * Handles various href formats:
   * - "chapter:0" -> 0
   * - "chapter-0" -> 0
   * - Spine lookup by href
   *
   * Returns 0 for invalid/unparseable hrefs.
   */
  private hrefToChapterIndex(href: string, spine: SpineItem[]): number {
    // Direct chapter reference
    if (href.startsWith('chapter:')) {
      const index = parseInt(href.slice(8), 10);
      if (isNaN(index) || index < 0) {
        console.warn(`[MuPDFEpubContentProvider] Invalid chapter index in href: ${href}`);
        return 0;
      }
      return index;
    }

    // Look up in spine
    const spineIndex = spine.findIndex(item => item.href === href || item.id === href);
    if (spineIndex >= 0) {
      return spineIndex;
    }

    // Try parsing as number
    const match = href.match(/\d+/);
    if (match) {
      const parsed = parseInt(match[0], 10);
      if (!isNaN(parsed) && parsed >= 0) {
        return parsed;
      }
    }

    // Default to first chapter
    console.warn(`[MuPDFEpubContentProvider] Unknown href: ${href}, defaulting to chapter 0`);
    return 0;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

// Promise-based singleton to prevent race conditions when multiple
// callers invoke getSharedMuPDFEpubContentProvider() concurrently
let sharedProviderPromise: Promise<MuPDFEpubContentProvider> | null = null;
let sharedProviderInstance: MuPDFEpubContentProvider | null = null;

/**
 * Get the shared MuPDF EPUB content provider.
 * Uses promise-based singleton to prevent race conditions when multiple
 * callers invoke this concurrently during initialization.
 */
export async function getSharedMuPDFEpubContentProvider(): Promise<MuPDFEpubContentProvider> {
  if (!sharedProviderPromise) {
    sharedProviderPromise = (async () => {
      console.log('[MuPDFEpubContentProvider] Creating new content provider...');
      const provider = new MuPDFEpubContentProvider();
      await provider.initialize();
      sharedProviderInstance = provider;
      return provider;
    })();
  }
  return sharedProviderPromise;
}

/**
 * Destroy the shared content provider
 */
export function destroySharedMuPDFEpubContentProvider(): void {
  if (sharedProviderInstance) {
    sharedProviderInstance.destroy();
    sharedProviderInstance = null;
  }
  sharedProviderPromise = null;
}

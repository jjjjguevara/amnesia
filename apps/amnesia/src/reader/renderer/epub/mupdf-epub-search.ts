/**
 * MuPDF EPUB Search
 *
 * Provides MuPDF-powered search for EPUB documents.
 * Uses MuPDF's native text search capability for faster and more accurate results.
 *
 * Features:
 * - Native MuPDF text search (no HTML parsing required)
 * - Chapter-aware results with context
 * - Compatible with existing SearchResult interface
 * - Fallback-ready design (can be swapped with DOM-based search)
 */

import type { MuPDFEpubBridge, EpubSearchResult } from './mupdf-epub-bridge';
import { getSharedMuPDFEpubBridge } from './mupdf-epub-bridge';
import type { TocEntry } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Search result compatible with existing search-index.ts interface
 */
export interface MuPDFSearchResult {
  id: string;
  spineIndex: number;
  spineHref: string;
  chapter: string;
  text: string;
  matchStart: number;
  matchEnd: number;
  contextBefore: string;
  contextAfter: string;
}

/**
 * Search options
 */
export interface MuPDFSearchOptions {
  /** Maximum number of results to return */
  maxResults?: number;
  /** Case-sensitive search */
  caseSensitive?: boolean;
  /** Whole word matching */
  wholeWord?: boolean;
}

// ============================================================================
// MuPDF EPUB Search
// ============================================================================

/**
 * MuPDF-powered search for EPUB documents.
 *
 * Uses MuPDF's native search instead of building a DOM-based index.
 * This provides faster search without the overhead of parsing HTML.
 */
export class MuPDFEpubSearch {
  private bridge: MuPDFEpubBridge | null = null;
  private bookId: string | null = null;
  private toc: TocEntry[] = [];
  private spine: Array<{ href: string }> = [];
  private isInitialized = false;

  /**
   * Initialize the search with a book
   */
  async initialize(
    bookId: string,
    toc: TocEntry[],
    spine: Array<{ href: string }>
  ): Promise<void> {
    try {
      this.bridge = await getSharedMuPDFEpubBridge();
      this.bookId = bookId;
      this.toc = toc;
      this.spine = spine;
      this.isInitialized = true;
      console.log('[MuPDFEpubSearch] Initialized for book:', bookId);
    } catch (err) {
      console.error('[MuPDFEpubSearch] Failed to initialize:', err);
      throw err;
    }
  }

  /**
   * Check if search is ready
   */
  get ready(): boolean {
    return this.isInitialized && this.bridge !== null && this.bookId !== null;
  }

  /**
   * Search the book for a query string
   */
  async search(
    query: string,
    options: MuPDFSearchOptions = {}
  ): Promise<MuPDFSearchResult[]> {
    if (!this.ready || !this.bridge || !this.bookId) {
      console.warn('[MuPDFEpubSearch] Search called but not initialized');
      return [];
    }

    if (!query.trim()) {
      return [];
    }

    const maxResults = options.maxResults ?? 100;

    try {
      const startTime = performance.now();
      const mupdfResults = await this.bridge.search(this.bookId, query, maxResults);
      const elapsed = performance.now() - startTime;

      console.log(`[MuPDFEpubSearch] Found ${mupdfResults.length} results in ${elapsed.toFixed(1)}ms`);

      // Convert MuPDF results to SearchResult format
      return mupdfResults.map((result, index) => this.convertResult(result, index));
    } catch (err) {
      console.error('[MuPDFEpubSearch] Search failed:', err);
      return [];
    }
  }

  /**
   * Search and group results by chapter
   */
  async searchGrouped(
    query: string,
    options: MuPDFSearchOptions = {}
  ): Promise<Map<string, MuPDFSearchResult[]>> {
    const results = await this.search(query, options);
    const grouped = new Map<string, MuPDFSearchResult[]>();

    for (const result of results) {
      const key = result.chapter;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(result);
    }

    return grouped;
  }

  /**
   * Get chapter text for building custom index (if needed)
   */
  async getChapterText(chapterIndex: number): Promise<string> {
    if (!this.bridge || !this.bookId) {
      throw new Error('MuPDFEpubSearch not initialized');
    }

    return this.bridge.getChapterText(this.bookId, chapterIndex);
  }

  /**
   * Clear the search state
   */
  clear(): void {
    this.bookId = null;
    this.toc = [];
    this.spine = [];
    this.isInitialized = false;
  }

  /**
   * Convert MuPDF search result to SearchResult format
   */
  private convertResult(result: EpubSearchResult, index: number): MuPDFSearchResult {
    const spineHref = this.spine[result.chapterIndex]?.href ?? `chapter:${result.chapterIndex}`;
    const chapter = this.resolveChapterName(result.chapterIndex);

    // Extract context from snippet
    const { contextBefore, matchText, contextAfter } = this.parseSnippet(result.snippet, result.text);

    return {
      id: `mupdf-${result.chapterIndex}-${index}`,
      spineIndex: result.chapterIndex,
      spineHref,
      chapter,
      text: matchText || result.text,
      matchStart: 0, // MuPDF doesn't provide exact positions
      matchEnd: result.text.length,
      contextBefore,
      contextAfter,
    };
  }

  /**
   * Resolve chapter name from spine index using TOC
   */
  private resolveChapterName(spineIndex: number): string {
    // Try to find matching TOC entry
    const spineHref = this.spine[spineIndex]?.href;
    if (spineHref) {
      const tocEntry = this.findTocEntry(this.toc, spineHref);
      if (tocEntry) {
        return tocEntry.label;
      }
    }

    // Fallback to generic chapter name
    return `Chapter ${spineIndex + 1}`;
  }

  /**
   * Find TOC entry by href (recursive)
   */
  private findTocEntry(entries: TocEntry[], href: string): TocEntry | null {
    for (const entry of entries) {
      // Check for exact match or partial match
      if (entry.href === href ||
          href.endsWith(entry.href) ||
          entry.href.endsWith(href)) {
        return entry;
      }

      // Check children
      if (entry.children?.length) {
        const found = this.findTocEntry(entry.children, href);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Parse snippet to extract context before and after match
   */
  private parseSnippet(
    snippet: string,
    matchText: string
  ): { contextBefore: string; matchText: string; contextAfter: string } {
    const lowerSnippet = snippet.toLowerCase();
    const lowerMatch = matchText.toLowerCase();
    const matchIndex = lowerSnippet.indexOf(lowerMatch);

    if (matchIndex === -1) {
      // Match not found in snippet, return snippet as context
      return {
        contextBefore: snippet,
        matchText,
        contextAfter: '',
      };
    }

    return {
      contextBefore: snippet.slice(0, matchIndex),
      matchText: snippet.slice(matchIndex, matchIndex + matchText.length),
      contextAfter: snippet.slice(matchIndex + matchText.length),
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let sharedSearch: MuPDFEpubSearch | null = null;

/**
 * Get the shared MuPDF EPUB search instance
 */
export function getMuPDFEpubSearch(): MuPDFEpubSearch {
  if (!sharedSearch) {
    sharedSearch = new MuPDFEpubSearch();
  }
  return sharedSearch;
}

/**
 * Clear the shared search instance
 */
export function clearMuPDFEpubSearch(): void {
  if (sharedSearch) {
    sharedSearch.clear();
    sharedSearch = null;
  }
}

// ============================================================================
// Hybrid Search Factory
// ============================================================================

/**
 * Search provider interface compatible with both MuPDF and DOM-based search
 */
export interface SearchProvider {
  readonly ready: boolean;
  search(query: string, options?: MuPDFSearchOptions): Promise<MuPDFSearchResult[]> | MuPDFSearchResult[];
  searchGrouped(query: string, options?: MuPDFSearchOptions): Promise<Map<string, MuPDFSearchResult[]>> | Map<string, MuPDFSearchResult[]>;
  clear(): void;
}

/**
 * Create a search provider that uses MuPDF when available,
 * falling back to the provided DOM-based search.
 */
export async function createHybridSearchProvider(
  bookId: string,
  toc: TocEntry[],
  spine: Array<{ href: string }>,
  useMuPDF: boolean = true
): Promise<{ provider: SearchProvider; isMuPDF: boolean }> {
  if (useMuPDF) {
    try {
      const mupdfSearch = getMuPDFEpubSearch();
      await mupdfSearch.initialize(bookId, toc, spine);
      console.log('[HybridSearch] Using MuPDF search provider');
      return { provider: mupdfSearch, isMuPDF: true };
    } catch (err) {
      console.warn('[HybridSearch] MuPDF search unavailable, caller should use DOM-based fallback:', err);
    }
  }

  // Return null provider - caller should use existing SearchIndex
  console.log('[HybridSearch] MuPDF search disabled or unavailable');
  return {
    provider: {
      ready: false,
      search: (_query: string, _options?: MuPDFSearchOptions) => [],
      searchGrouped: (_query: string, _options?: MuPDFSearchOptions) => new Map(),
      clear: () => {},
    },
    isMuPDF: false,
  };
}

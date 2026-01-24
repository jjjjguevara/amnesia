/**
 * Content Provider Interface
 *
 * Abstraction for book content delivery using MuPDF WASM.
 */

import type { ParsedBook, ChapterContent } from './types';

/**
 * Content provider interface for book data access.
 *
 * Implementations:
 * - MuPDFEpubContentProvider: MuPDF WASM for EPUB
 * - HybridDocumentProvider: Unified PDF/EPUB provider
 */
export interface ContentProvider {
  /** Get parsed book metadata and structure */
  getBook(bookId: string): Promise<ParsedBook>;

  /** Upload and parse a book from raw data */
  uploadBook(data: ArrayBuffer, filename?: string): Promise<ParsedBook>;

  /** Check if chapter is already cached locally */
  isChapterCached(bookId: string, href: string): boolean;

  /** Get chapter HTML content with optional highlights */
  getChapter(bookId: string, href: string, includeHighlights?: boolean): Promise<ChapterContent>;

  /** Preload chapter for faster navigation */
  preloadChapter(bookId: string, href: string): void;

  /** Clear chapter cache (optional) */
  clearChapterCache?(bookId?: string): void;

  /** Get resource URL for embedding in HTML (data URL or server URL) */
  getResourceAsDataUrl?(bookId: string, href: string): Promise<string>;
}

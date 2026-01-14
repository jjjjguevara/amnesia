/**
 * MuPDF EPUB Bridge
 *
 * Bridge to MuPDF worker for EPUB operations.
 * Uses MuPDF's native EPUB support for parsing, TOC extraction, and search.
 *
 * Part of the EPUB migration from pub-rs to unified MuPDF WASM architecture.
 */

import type { TocEntry } from '../types';
import type { IMuPDFBridge, RenderFormat } from '../pdf/mupdf-bridge';
import { getSharedMuPDFBridge } from '../pdf/mupdf-bridge';

// ============================================================================
// Types
// ============================================================================

/**
 * EPUB metadata extracted by MuPDF
 */
export interface EpubMetadata {
  title: string;
  creator?: string;
  publisher?: string;
  language?: string;
  identifier?: string;
  description?: string;
}

/**
 * Spine item representing a chapter/section in reading order
 */
export interface EpubSpineItem {
  id: string;
  href: string;
  linear: boolean;
  mediaType: string;
}

/**
 * Full EPUB structure returned after opening
 */
export interface ParsedEpub {
  id: string;
  pageCount: number;
  chapterCount: number;
  metadata: EpubMetadata;
  toc: TocEntry[];
  spine: EpubSpineItem[];
  isFixedLayout: boolean;
  /** Fixed-layout page dimensions (if applicable) */
  pageDimensions?: FixedLayoutPageDimensions;
}

/**
 * Chapter content extracted from EPUB
 */
export interface EpubChapterContent {
  html: string;
  text: string;
  href: string;
  chapterIndex: number;
}

/**
 * EPUB search result
 */
export interface EpubSearchResult {
  chapterIndex: number;
  page: number;
  text: string;
  snippet: string;
  quads: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

/**
 * Fixed-layout page dimensions
 */
export interface FixedLayoutPageDimensions {
  width: number;
  height: number;
  /** Number of pages (for fixed-layout EPUBs) */
  pageCount?: number;
}

// ============================================================================
// MuPDF EPUB Bridge
// ============================================================================

/**
 * Bridge for EPUB operations using MuPDF WASM.
 *
 * Uses the shared MuPDF bridge instance (singleton) to communicate with the
 * MuPDF worker pool. MuPDF natively supports EPUB format via its HTML engine.
 *
 * For reflowable EPUBs, this bridge extracts chapter HTML for Shadow DOM rendering.
 * For fixed-layout EPUBs, this bridge provides pixmap rendering like PDFs.
 */
export class MuPDFEpubBridge {
  private bridge: IMuPDFBridge | null = null;
  private initialized = false;

  // Document cache for quick access
  private documentCache = new Map<string, {
    docId: string;
    metadata: EpubMetadata;
    spine: EpubSpineItem[];
    toc: TocEntry[];
    chapterCount: number;
    isFixedLayout: boolean;
  }>();

  /**
   * Initialize the bridge
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.bridge = await getSharedMuPDFBridge();
    this.initialized = true;
    console.log('[MuPDF EPUB Bridge] Initialized');
  }

  /**
   * Ensure bridge is initialized
   */
  private async ensureInitialized(): Promise<IMuPDFBridge> {
    if (!this.bridge) {
      await this.initialize();
    }
    if (!this.bridge) {
      throw new Error('MuPDF EPUB Bridge not initialized');
    }
    return this.bridge;
  }

  /**
   * Open an EPUB document
   *
   * MuPDF handles EPUB files natively via its HTML rendering engine.
   * The document is loaded into the worker and parsed for structure.
   *
   * NOTE: The ArrayBuffer is transferred to the worker, so the caller should
   * not use it after calling this method. If the caller needs to retain the
   * data, they should make a copy before calling openEpub().
   *
   * @param data EPUB file data as ArrayBuffer (will be transferred)
   * @param bookId Optional book ID for caching
   */
  async openEpub(data: ArrayBuffer, bookId?: string): Promise<ParsedEpub> {
    const bridge = await this.ensureInitialized();

    // Load document with MuPDF - it auto-detects EPUB from magic bytes
    // The ArrayBuffer is transferred to the worker (ownership transfer)
    const result = await bridge.loadDocumentWithId(data);
    const docId = result.id;

    // Extract metadata from TOC structure
    // MuPDF provides basic metadata via the document API
    const metadata = await this.extractMetadata(docId);

    // Build spine from page structure
    // In MuPDF, EPUB chapters map to pages with (chapter, pageNo) tuples
    const chapterCount = result.pageCount;
    const spine = this.buildSpine(chapterCount);

    // Detect if fixed-layout EPUB
    // Fixed-layout EPUBs have specific viewport metadata
    const isFixedLayout = await this.detectFixedLayout(docId);

    // Convert MuPDF TOC to our format
    const toc = this.normalizeToc(result.toc);

    // Cache document info including TOC
    const id = bookId || docId;
    this.documentCache.set(id, {
      docId,
      metadata,
      spine,
      toc,
      chapterCount,
      isFixedLayout,
    });

    return {
      id,
      pageCount: result.pageCount,
      chapterCount,
      metadata,
      toc,
      spine,
      isFixedLayout,
    };
  }

  /**
   * Get chapter HTML content for Shadow DOM rendering
   *
   * Extracts HTML from EPUB chapter using MuPDF's toText("html") method.
   * Resources (images, CSS) are resolved to data URLs.
   *
   * @param bookId Book identifier
   * @param chapterIndex 0-indexed chapter number
   */
  async getChapterHtml(bookId: string, chapterIndex: number): Promise<EpubChapterContent> {
    const bridge = await this.ensureInitialized();
    const cached = this.documentCache.get(bookId);

    if (!cached) {
      throw new Error(`EPUB ${bookId} not loaded`);
    }

    // MuPDF uses 1-indexed pages
    const pageNum = chapterIndex + 1;

    // Get text layer which includes structured content
    const textLayer = await bridge.getTextLayer(cached.docId, pageNum);

    // Build HTML from text layer items
    // MuPDF's toStructuredText provides positioned text blocks
    const html = this.textLayerToHtml(textLayer);

    // Get plain text for search indexing
    const text = textLayer.items.map(item => item.text).join(' ');

    return {
      html,
      text,
      href: cached.spine[chapterIndex]?.href || `chapter-${chapterIndex}`,
      chapterIndex,
    };
  }

  /**
   * Get plain text content of a chapter
   *
   * @param bookId Book identifier
   * @param chapterIndex 0-indexed chapter number
   */
  async getChapterText(bookId: string, chapterIndex: number): Promise<string> {
    const bridge = await this.ensureInitialized();
    const cached = this.documentCache.get(bookId);

    if (!cached) {
      throw new Error(`EPUB ${bookId} not loaded`);
    }

    const pageNum = chapterIndex + 1;
    const textLayer = await bridge.getTextLayer(cached.docId, pageNum);

    return textLayer.items.map(item => item.text).join(' ');
  }

  /**
   * Search EPUB for text
   *
   * @param bookId Book identifier
   * @param query Search query
   * @param maxHits Maximum results to return
   */
  async search(bookId: string, query: string, maxHits: number = 100): Promise<EpubSearchResult[]> {
    const bridge = await this.ensureInitialized();
    const cached = this.documentCache.get(bookId);

    if (!cached) {
      throw new Error(`EPUB ${bookId} not loaded`);
    }

    const results = await bridge.search(cached.docId, query, maxHits);

    // Convert PDF search results to EPUB format
    return results.map(result => ({
      chapterIndex: result.page - 1, // Convert 1-indexed to 0-indexed
      page: result.page,
      text: result.text,
      snippet: result.text, // MuPDF provides the matching text
      quads: result.quads,
    }));
  }

  /**
   * Render a fixed-layout page as RGBA pixels
   *
   * For fixed-layout EPUBs that should render like PDFs.
   *
   * @param bookId Book identifier
   * @param pageNum 1-indexed page number
   * @param scale Render scale
   */
  async renderPage(
    bookId: string,
    pageNum: number,
    scale: number,
    format: RenderFormat = 'rgba'
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    const bridge = await this.ensureInitialized();
    const cached = this.documentCache.get(bookId);

    if (!cached) {
      throw new Error(`EPUB ${bookId} not loaded`);
    }

    if (!cached.isFixedLayout) {
      throw new Error(`EPUB ${bookId} is not fixed-layout`);
    }

    const result = await bridge.renderPage(cached.docId, pageNum, scale, format);
    return {
      data: result.data,
      width: result.width,
      height: result.height,
    };
  }

  /**
   * Render a tile of a fixed-layout page
   *
   * @param bookId Book identifier
   * @param pageNum 1-indexed page number
   * @param tileX Tile X coordinate
   * @param tileY Tile Y coordinate
   * @param tileSize Tile size in pixels
   * @param scale Render scale
   */
  async renderTile(
    bookId: string,
    pageNum: number,
    tileX: number,
    tileY: number,
    tileSize: number,
    scale: number,
    format: RenderFormat = 'rgba'
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    const bridge = await this.ensureInitialized();
    const cached = this.documentCache.get(bookId);

    if (!cached) {
      throw new Error(`EPUB ${bookId} not loaded`);
    }

    if (!cached.isFixedLayout) {
      throw new Error(`EPUB ${bookId} is not fixed-layout`);
    }

    const result = await bridge.renderTile(cached.docId, pageNum, tileX, tileY, tileSize, scale, format);
    return {
      data: result.data,
      width: result.width,
      height: result.height,
    };
  }

  /**
   * Get page dimensions for fixed-layout EPUB
   *
   * @param bookId Book identifier
   * @param pageNum 1-indexed page number
   */
  async getPageDimensions(bookId: string, pageNum: number): Promise<FixedLayoutPageDimensions> {
    const bridge = await this.ensureInitialized();
    const cached = this.documentCache.get(bookId);

    if (!cached) {
      throw new Error(`EPUB ${bookId} not loaded`);
    }

    return bridge.getPageDimensions(cached.docId, pageNum);
  }

  /**
   * Get TOC entries
   */
  getToc(bookId: string): TocEntry[] {
    const cached = this.documentCache.get(bookId);
    if (!cached) {
      throw new Error(`EPUB ${bookId} not loaded`);
    }

    return cached.toc;
  }

  /**
   * Check if EPUB is fixed-layout
   */
  isFixedLayout(bookId: string): boolean {
    const cached = this.documentCache.get(bookId);
    return cached?.isFixedLayout ?? false;
  }

  /**
   * Get chapter count
   */
  getChapterCount(bookId: string): number {
    const cached = this.documentCache.get(bookId);
    return cached?.chapterCount ?? 0;
  }

  /**
   * Close an EPUB document
   */
  async closeEpub(bookId: string): Promise<void> {
    const cached = this.documentCache.get(bookId);
    if (!cached) {
      return;
    }

    const bridge = await this.ensureInitialized();
    await bridge.unloadDocument(cached.docId);
    this.documentCache.delete(bookId);
    console.log(`[MuPDF EPUB Bridge] Closed EPUB ${bookId}`);
  }

  /**
   * Terminate the bridge
   */
  terminate(): void {
    this.documentCache.clear();
    this.bridge = null;
    this.initialized = false;
    console.log('[MuPDF EPUB Bridge] Terminated');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Extract metadata from document
   */
  private async extractMetadata(_docId: string): Promise<EpubMetadata> {
    // MuPDF provides basic metadata via the outline/TOC
    // For now, return placeholder metadata - will be populated by first TOC entry
    // In future, we can extend mupdf-worker.ts to expose document metadata
    // TODO: Add GET_DOCUMENT_METADATA message to mupdf-worker.ts
    return {
      title: 'Unknown',
      creator: undefined,
      publisher: undefined,
      language: undefined, // Don't assume language; 'und' (undetermined) is also valid
    };
  }

  /**
   * Build spine from chapter count
   */
  private buildSpine(chapterCount: number): EpubSpineItem[] {
    const spine: EpubSpineItem[] = [];

    for (let i = 0; i < chapterCount; i++) {
      spine.push({
        id: `chapter-${i}`,
        href: `chapter:${i}`,
        linear: true,
        mediaType: 'application/xhtml+xml',
      });
    }

    return spine;
  }

  /**
   * Detect if EPUB uses fixed layout
   *
   * Fixed-layout EPUBs have specific characteristics:
   * - Viewport meta tag with fixed dimensions
   * - rendition:layout = pre-paginated in OPF
   */
  private async detectFixedLayout(_docId: string): Promise<boolean> {
    // For now, default to false (reflowable)
    // Fixed-layout detection requires deeper EPUB structure analysis
    // which we'll implement in Stage 4
    return false;
  }

  /**
   * Normalize MuPDF TOC to our format
   */
  private normalizeToc(mupdfToc: TocEntry[]): TocEntry[] {
    // MuPDF TOC format matches our format
    // Just need to ensure href uses chapter:N format for EPUB
    return mupdfToc.map((entry, index) => ({
      ...entry,
      id: entry.id || `toc-${index}`,
      // Keep original href if it's already chapter-based
      href: entry.href.startsWith('chapter:') ? entry.href : `chapter:${index}`,
      children: entry.children ? this.normalizeToc(entry.children) : [],
    }));
  }

  /**
   * Convert MuPDF text layer to HTML
   *
   * Reconstructs HTML from positioned text blocks.
   *
   * IMPORTANT: This is a TEMPORARY placeholder for Stage 1.
   * The conversion is naive and loses semantic structure (headings, lists, links).
   * Stage 2/3 will implement proper HTML extraction using MuPDF's HTML output
   * or preserve the original EPUB HTML structure.
   *
   * TODO (Stage 2): Implement proper HTML extraction with semantic preservation
   */
  private textLayerToHtml(textLayer: {
    pageNum: number;
    width: number;
    height: number;
    items: Array<{
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      fontSize: number;
    }>;
  }): string {
    const paragraphs: string[] = [];
    let currentParagraph: string[] = [];
    let lastY = -1;

    for (const item of textLayer.items) {
      // New paragraph if Y position jumps significantly (more than 1.5x font size)
      // This heuristic may fail on tightly-spaced or loosely-spaced content
      if (lastY !== -1 && Math.abs(item.y - lastY) > item.fontSize * 1.5) {
        if (currentParagraph.length > 0) {
          paragraphs.push(`<p>${currentParagraph.join(' ')}</p>`);
          currentParagraph = [];
        }
      }

      currentParagraph.push(this.escapeHtml(item.text));
      lastY = item.y;
    }

    // Add remaining paragraph
    if (currentParagraph.length > 0) {
      paragraphs.push(`<p>${currentParagraph.join(' ')}</p>`);
    }

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
${paragraphs.join('\n')}
</body>
</html>`;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

// Promise-based singleton to prevent race conditions when multiple
// callers invoke getSharedMuPDFEpubBridge() concurrently
let sharedEpubBridgePromise: Promise<MuPDFEpubBridge> | null = null;
let sharedEpubBridgeInstance: MuPDFEpubBridge | null = null;

/**
 * Get the shared MuPDF EPUB bridge instance.
 * Uses promise-based singleton to prevent race conditions when multiple
 * callers invoke this concurrently during initialization.
 */
export async function getSharedMuPDFEpubBridge(): Promise<MuPDFEpubBridge> {
  if (!sharedEpubBridgePromise) {
    sharedEpubBridgePromise = (async () => {
      console.log('[MuPDFEpubBridge] Creating new EPUB bridge...');
      const bridge = new MuPDFEpubBridge();
      await bridge.initialize();
      sharedEpubBridgeInstance = bridge;
      return bridge;
    })();
  }
  return sharedEpubBridgePromise;
}

/**
 * Destroy the shared EPUB bridge instance
 */
export function destroySharedMuPDFEpubBridge(): void {
  if (sharedEpubBridgeInstance) {
    sharedEpubBridgeInstance.terminate();
    sharedEpubBridgeInstance = null;
  }
  sharedEpubBridgePromise = null;
}

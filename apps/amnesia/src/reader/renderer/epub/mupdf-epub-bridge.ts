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
import { ZipReader } from '../shared/zip-reader';

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
/** Parsed EPUB internal structure for direct ZIP access */
interface EpubZipStructure {
  opfPath: string;
  spine: string[]; // hrefs of chapters in reading order
  manifest: Map<string, { href: string; mediaType: string }>;
  basePath: string;
  toc: TocEntry[]; // Table of Contents parsed from NCX or NAV
}

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
    /** Original EPUB data for direct ZIP extraction */
    epubData?: ArrayBuffer;
    /** Parsed EPUB ZIP structure */
    zipStructure?: EpubZipStructure;
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

    // IMPORTANT: Copy the data BEFORE transferring to worker
    // This allows us to extract chapter content directly from the ZIP later
    const epubDataCopy = data.slice(0);

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

    // Convert MuPDF TOC to our format (may be empty for EPUBs)
    const mupdfToc = this.normalizeToc(result.toc);

    // Parse EPUB structure for direct ZIP access
    let zipStructure: EpubZipStructure | undefined;
    try {
      zipStructure = await this.parseEpubStructure(epubDataCopy);
      console.log(`[MuPDF EPUB Bridge] Parsed EPUB structure: ${zipStructure.spine.length} chapters in spine, ${zipStructure.toc.length} TOC entries`);
    } catch (err) {
      console.warn('[MuPDF EPUB Bridge] Failed to parse EPUB structure:', err);
    }

    // Use ZIP-parsed TOC if MuPDF returns empty (common for EPUBs)
    const toc = mupdfToc.length > 0 ? mupdfToc : (zipStructure?.toc ?? []);
    if (mupdfToc.length === 0 && zipStructure?.toc?.length) {
      console.log(`[MuPDF EPUB Bridge] Using ZIP-parsed TOC (${zipStructure.toc.length} entries) instead of empty MuPDF TOC`);
    }

    // Use ZIP structure's spine length for chapter count (more accurate than MuPDF's pageCount)
    // MuPDF's pageCount often returns incorrect values for EPUBs
    const actualChapterCount = zipStructure?.spine.length ?? chapterCount;
    const actualSpine: EpubSpineItem[] = zipStructure
      ? zipStructure.spine.map((href, i) => {
          const manifestItem = zipStructure.manifest.get(href);
          return {
            id: `chapter-${i}`,
            href: `chapter:${i}`,
            linear: true, // Assume linear for now
            mediaType: manifestItem?.mediaType || 'application/xhtml+xml',
          };
        })
      : spine;

    // Cache document info including TOC and EPUB data for direct access
    const id = bookId || docId;
    this.documentCache.set(id, {
      docId,
      metadata,
      spine: actualSpine,
      toc,
      chapterCount: actualChapterCount,
      isFixedLayout,
      epubData: epubDataCopy,
      zipStructure,
    });

    return {
      id,
      pageCount: actualChapterCount, // Use actual chapter count as page count for EPUBs
      chapterCount: actualChapterCount,
      metadata,
      toc,
      spine: actualSpine,
      isFixedLayout,
    };
  }

  /**
   * Get chapter HTML content for Shadow DOM rendering
   *
   * Uses direct ZIP extraction to get the original XHTML content from the EPUB.
   * This bypasses MuPDF's text extraction which doesn't work well for EPUBs.
   *
   * @param bookId Book identifier
   * @param chapterIndex 0-indexed chapter number
   */
  async getChapterHtml(bookId: string, chapterIndex: number): Promise<EpubChapterContent> {
    const cached = this.documentCache.get(bookId);

    if (!cached) {
      throw new Error(`EPUB ${bookId} not loaded`);
    }

    let html: string | null = null;
    let text: string = '';
    let zipError: Error | null = null;
    let mupdfError: Error | null = null;

    // Try direct ZIP extraction first (preferred method)
    if (cached.epubData && cached.zipStructure) {
      try {
        html = await this.readChapterFromZip(cached.epubData, cached.zipStructure, chapterIndex);
        // Extract plain text from HTML for search/highlights
        text = this.extractTextFromHtml(html);
        console.log(`[MuPDF EPUB Bridge] Direct ZIP extraction: chapter ${chapterIndex}, ${html.length} chars`);

        return {
          html,
          text,
          href: cached.spine[chapterIndex]?.href || `chapter-${chapterIndex}`,
          chapterIndex,
        };
      } catch (err) {
        zipError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[MuPDF EPUB Bridge] ZIP extraction failed for chapter ${chapterIndex}:`, err);
      }
    } else {
      zipError = new Error('EPUB data or structure not cached');
    }

    // Fallback to MuPDF text layer extraction (rarely works for EPUBs)
    try {
      const bridge = await this.ensureInitialized();
      const pageNum = chapterIndex + 1;
      const textLayer = await bridge.getTextLayer(cached.docId, pageNum);

      if (textLayer.htmlContent || textLayer.textContent) {
        html = textLayer.htmlContent || this.wrapTextInHtml(textLayer.textContent || '');
        text = textLayer.textContent || '';
      } else if (textLayer.items.length > 0) {
        html = this.textLayerToHtml(textLayer);
        text = textLayer.items.map(item => item.text).join(' ');
      }
    } catch (err) {
      mupdfError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[MuPDF EPUB Bridge] MuPDF text layer extraction failed for chapter ${chapterIndex}:`, err);
    }

    // If both methods failed to produce content, throw with context
    if (!html || html.trim().length === 0 || html === this.wrapTextInHtml('')) {
      const attemptedPath = cached.spine[chapterIndex]?.href || `chapter-${chapterIndex}`;
      const zipInfo = zipError ? zipError.message : 'no EPUB data cached';
      const mupdfInfo = mupdfError ? mupdfError.message : 'returned empty content';

      throw new Error(
        `Failed to extract chapter ${chapterIndex} (${attemptedPath}) from "${bookId}". ` +
        `ZIP extraction: ${zipInfo}. MuPDF fallback: ${mupdfInfo}.`
      );
    }

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

    // Use fallback textContent for EPUBs
    if (textLayer.textContent) {
      return textLayer.textContent;
    }

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
   * Get the actual file path of a chapter in the EPUB ZIP
   *
   * Returns the real file path (e.g., "OPS/chapter1.xhtml") for resolving
   * relative resource paths like images.
   */
  getChapterFilePath(bookId: string, chapterIndex: number): string | undefined {
    const cached = this.documentCache.get(bookId);
    if (!cached?.zipStructure) {
      return undefined;
    }
    return cached.zipStructure.spine[chapterIndex];
  }

  /**
   * Get a resource (image, CSS, font) from the EPUB as bytes
   *
   * @param bookId Book identifier
   * @param href Resource path (relative to EPUB root or chapter)
   * @param chapterHref Optional chapter href to resolve relative paths
   */
  async getResource(bookId: string, href: string, chapterHref?: string): Promise<Uint8Array> {
    const cached = this.documentCache.get(bookId);
    if (!cached || !cached.epubData || !cached.zipStructure) {
      throw new Error(`EPUB ${bookId} not loaded or missing ZIP data`);
    }

    const zip = new ZipReader(cached.epubData);
    const basePath = cached.zipStructure.basePath;

    // Resolve the resource path
    let resourcePath: string;

    if (href.startsWith('/')) {
      // Absolute path from EPUB root
      resourcePath = href.substring(1);
    } else if (chapterHref) {
      // Relative to chapter location
      const chapterDir = chapterHref.includes('/')
        ? chapterHref.substring(0, chapterHref.lastIndexOf('/') + 1)
        : '';
      resourcePath = this.sanitizeEpubPath(basePath + chapterDir, href);
    } else {
      // Relative to EPUB basePath
      resourcePath = this.sanitizeEpubPath(basePath, href);
    }

    console.log(`[MuPDF EPUB Bridge] Loading resource: ${href} -> ${resourcePath}`);
    return await zip.read(resourcePath);
  }

  /**
   * Get a resource as a data URL
   */
  async getResourceAsDataUrl(bookId: string, href: string, chapterHref?: string): Promise<string> {
    const bytes = await this.getResource(bookId, href, chapterHref);
    const mimeType = this.guessMimeType(href);

    // Convert to base64
    const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
    const base64 = btoa(binary);

    return `data:${mimeType};base64,${base64}`;
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

  /**
   * Wrap plain text in a basic HTML document
   */
  private wrapTextInHtml(text: string): string {
    // Split text into paragraphs on double newlines or single newlines
    const paragraphs = text
      .split(/\n\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 0)
      .map(p => `<p>${this.escapeHtml(p.replace(/\n/g, ' '))}</p>`);

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

  // ============================================================================
  // ZIP Parsing for Direct EPUB Content Extraction
  // ============================================================================

  /**
   * Parse EPUB ZIP structure to extract spine, manifest, and TOC
   *
   * EPUBs are ZIP files with:
   * - META-INF/container.xml → points to OPF file
   * - OPF file → contains manifest (all files) and spine (reading order)
   * - NCX file (EPUB 2) or NAV file (EPUB 3) → contains TOC
   */
  private async parseEpubStructure(data: ArrayBuffer): Promise<EpubZipStructure> {
    const zip = new ZipReader(data);

    // 1. Read container.xml to find OPF path
    const containerXml = await zip.readText('META-INF/container.xml');
    const opfMatch = containerXml.match(/full-path="([^"]+)"/);
    if (!opfMatch) {
      throw new Error('Could not find OPF path in container.xml');
    }
    const opfPath = opfMatch[1];
    const basePath = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    // 2. Read and parse OPF file
    const opfXml = await zip.readText(opfPath);

    // 3. Parse manifest (all content items)
    const manifest = new Map<string, { href: string; mediaType: string; properties?: string }>();
    // Match items with various attribute orders
    const itemRegex = /<item\s+([^>]+)\/?\s*>/gi;
    let match;
    while ((match = itemRegex.exec(opfXml)) !== null) {
      const attrs = match[1];
      const idMatch = attrs.match(/id="([^"]+)"/);
      const hrefMatch = attrs.match(/href="([^"]+)"/);
      const mediaMatch = attrs.match(/media-type="([^"]+)"/);
      const propsMatch = attrs.match(/properties="([^"]+)"/);

      if (idMatch && hrefMatch && mediaMatch) {
        manifest.set(idMatch[1], {
          href: hrefMatch[1],
          mediaType: mediaMatch[1],
          properties: propsMatch?.[1]
        });
      }
    }

    // 4. Parse spine (reading order)
    const spine: string[] = [];
    const spineRegex = /<itemref[^>]+idref="([^"]+)"[^>]*\/?>/gi;
    while ((match = spineRegex.exec(opfXml)) !== null) {
      const itemId = match[1];
      const item = manifest.get(itemId);
      if (item && (item.mediaType === 'application/xhtml+xml' || item.mediaType === 'text/html')) {
        spine.push(item.href);
      }
    }

    // 5. Parse TOC from NCX (EPUB 2) or NAV (EPUB 3)
    let toc: TocEntry[] = [];

    // Try EPUB 3 NAV first (properties="nav")
    let navHref: string | null = null;
    for (const [, item] of manifest) {
      if (item.properties?.includes('nav')) {
        navHref = item.href;
        break;
      }
    }

    if (navHref) {
      try {
        const navPath = basePath + navHref;
        const navXml = await zip.readText(navPath);
        toc = this.parseNavToc(navXml, spine, basePath);
        console.log(`[MuPDF EPUB Bridge] Parsed EPUB 3 NAV TOC: ${toc.length} entries`);
      } catch (err) {
        console.warn('[MuPDF EPUB Bridge] Failed to parse NAV TOC:', err);
      }
    }

    // Fall back to NCX (EPUB 2)
    if (toc.length === 0) {
      let ncxHref: string | null = null;
      for (const [, item] of manifest) {
        if (item.mediaType === 'application/x-dtbncx+xml') {
          ncxHref = item.href;
          break;
        }
      }

      if (ncxHref) {
        try {
          const ncxPath = basePath + ncxHref;
          const ncxXml = await zip.readText(ncxPath);
          toc = this.parseNcxToc(ncxXml, spine, basePath);
          console.log(`[MuPDF EPUB Bridge] Parsed EPUB 2 NCX TOC: ${toc.length} entries`);
        } catch (err) {
          console.warn('[MuPDF EPUB Bridge] Failed to parse NCX TOC:', err);
        }
      }
    }

    console.log(`[MuPDF EPUB Bridge] Parsed EPUB: OPF at ${opfPath}, ${manifest.size} manifest items, ${spine.length} spine items, ${toc.length} TOC entries`);

    return { opfPath, spine, manifest, basePath, toc };
  }

  /**
   * Parse EPUB 3 NAV document TOC
   */
  private parseNavToc(navXml: string, spine: string[], basePath: string): TocEntry[] {
    const toc: TocEntry[] = [];

    // Find the nav element with epub:type="toc"
    const tocNavMatch = navXml.match(/<nav[^>]*epub:type="toc"[^>]*>([\s\S]*?)<\/nav>/i);
    if (!tocNavMatch) {
      // Try without epub:type (some EPUBs use id="toc")
      const altMatch = navXml.match(/<nav[^>]*id="toc"[^>]*>([\s\S]*?)<\/nav>/i);
      if (!altMatch) return toc;
      return this.parseNavList(altMatch[1], spine, basePath, 0);
    }

    return this.parseNavList(tocNavMatch[1], spine, basePath, 0);
  }

  /**
   * Parse nav list (ol/li structure) recursively
   */
  private parseNavList(html: string, spine: string[], basePath: string, level: number): TocEntry[] {
    const entries: TocEntry[] = [];

    // Match li elements at this level
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let match;
    let idx = 0;

    while ((match = liRegex.exec(html)) !== null) {
      const liContent = match[1];

      // Extract anchor
      const anchorMatch = liContent.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (anchorMatch) {
        const href = anchorMatch[1];
        const label = anchorMatch[2].replace(/<[^>]+>/g, '').trim();

        // Find spine index for this href
        const chapterIndex = this.findChapterIndex(href, spine, basePath);

        const entry: TocEntry = {
          id: `toc-${level}-${idx}`,
          label,
          href: chapterIndex >= 0 ? `chapter:${chapterIndex}` : href,
          children: [],
        };

        // Check for nested ol
        const nestedOlMatch = liContent.match(/<ol[^>]*>([\s\S]*)<\/ol>/i);
        if (nestedOlMatch) {
          entry.children = this.parseNavList(nestedOlMatch[1], spine, basePath, level + 1);
        }

        entries.push(entry);
        idx++;
      }
    }

    return entries;
  }

  /**
   * Parse EPUB 2 NCX document TOC
   */
  private parseNcxToc(ncxXml: string, spine: string[], basePath: string): TocEntry[] {
    // Find navMap
    const navMapMatch = ncxXml.match(/<navMap[^>]*>([\s\S]*)<\/navMap>/i);
    if (!navMapMatch) return [];

    return this.parseNcxNavPoints(navMapMatch[1], spine, basePath, 0);
  }

  /**
   * Parse NCX navPoint elements recursively
   */
  private parseNcxNavPoints(xml: string, spine: string[], basePath: string, level: number): TocEntry[] {
    const entries: TocEntry[] = [];

    // Match navPoint elements (non-greedy to handle nesting)
    const navPointRegex = /<navPoint[^>]*>([\s\S]*?)<\/navPoint>/gi;
    let match;
    let idx = 0;

    // Process in order of appearance
    while ((match = navPointRegex.exec(xml)) !== null) {
      const content = match[1];

      // Extract navLabel/text
      const labelMatch = content.match(/<navLabel[^>]*>[\s\S]*?<text[^>]*>([\s\S]*?)<\/text>/i);
      const label = labelMatch ? labelMatch[1].trim() : `Chapter ${idx + 1}`;

      // Extract content src
      const srcMatch = content.match(/<content[^>]+src="([^"]+)"/i);
      const href = srcMatch ? srcMatch[1] : '';

      // Find spine index
      const chapterIndex = this.findChapterIndex(href, spine, basePath);

      const entry: TocEntry = {
        id: `toc-${level}-${idx}`,
        label,
        href: chapterIndex >= 0 ? `chapter:${chapterIndex}` : href,
        children: [],
      };

      // Check for nested navPoints (after first closing tags)
      const afterContent = content.substring(content.indexOf('</content>') + 10);
      if (afterContent.includes('<navPoint')) {
        entry.children = this.parseNcxNavPoints(afterContent, spine, basePath, level + 1);
      }

      entries.push(entry);
      idx++;
    }

    return entries;
  }

  /**
   * Find the spine index for a given href
   */
  private findChapterIndex(href: string, spine: string[], basePath: string): number {
    // Remove fragment identifier
    const hrefWithoutFragment = href.split('#')[0];

    // Decode URI
    let decodedHref = hrefWithoutFragment;
    try {
      decodedHref = decodeURIComponent(hrefWithoutFragment);
    } catch {
      // Keep original if decode fails
    }

    // Try exact match first
    let index = spine.indexOf(decodedHref);
    if (index >= 0) return index;

    // Try with basePath prefix removed
    if (decodedHref.startsWith(basePath)) {
      const withoutBase = decodedHref.substring(basePath.length);
      index = spine.indexOf(withoutBase);
      if (index >= 0) return index;
    }

    // Try adding basePath
    index = spine.indexOf(basePath + decodedHref);
    if (index >= 0) return index;

    // Try matching just the filename
    const filename = decodedHref.split('/').pop();
    if (filename) {
      for (let i = 0; i < spine.length; i++) {
        if (spine[i].endsWith(filename) || spine[i].split('/').pop() === filename) {
          return i;
        }
      }
    }

    return -1;
  }

  /**
   * Sanitize a path to prevent traversal attacks
   *
   * Security: URL decoding is performed BEFORE traversal checks to prevent
   * bypasses via encoded sequences like %2e%2e%2f (../)
   */
  private sanitizeEpubPath(basePath: string, relativePath: string): string {
    // Normalize path separators first
    let normalized = relativePath.replace(/\\/g, '/');

    // URL-decode the path FIRST to catch encoded traversal attempts
    // (e.g., %2e%2e%2f would decode to ../)
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // If decoding fails, log warning and continue with original
      console.warn(`[EPUB] Invalid URL encoding in path: ${relativePath}`);
    }

    // Re-normalize after decoding (in case decoding introduced backslashes)
    normalized = normalized.replace(/\\/g, '/');

    // Reject path traversal attempts AFTER decoding
    if (normalized.includes('../') || normalized.startsWith('/') || normalized.includes('..\\')) {
      throw new Error(`Invalid EPUB path: traversal attempt detected in "${relativePath}"`);
    }

    // Reject paths with null bytes (another common attack vector)
    if (normalized.includes('\0')) {
      throw new Error(`Invalid EPUB path: null byte detected in "${relativePath}"`);
    }

    return basePath + normalized;
  }

  /**
   * Read chapter content directly from EPUB ZIP
   */
  private async readChapterFromZip(
    data: ArrayBuffer,
    structure: EpubZipStructure,
    chapterIndex: number
  ): Promise<string> {
    if (chapterIndex < 0 || chapterIndex >= structure.spine.length) {
      throw new Error(`Chapter index ${chapterIndex} out of range (0-${structure.spine.length - 1})`);
    }

    const chapterHref = structure.spine[chapterIndex];
    // Use sanitized path to prevent traversal attacks
    const chapterPath = this.sanitizeEpubPath(structure.basePath, chapterHref);

    const zip = new ZipReader(data);
    const content = await zip.readText(chapterPath);

    return content;
  }

  /**
   * Extract plain text from HTML content
   */
  private extractTextFromHtml(html: string): string {
    // Remove script and style tags and their content
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // Remove all HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode numeric entities FIRST (before named entities)
    // Decimal: &#8212; -> em-dash
    text = text.replace(/&#(\d+);/g, (match, dec) => {
      const code = parseInt(dec, 10);
      if (isNaN(code)) return match; // Preserve malformed
      // Valid Unicode scalar values: 0x0000-0xD7FF, 0xE000-0x10FFFF
      // (excludes surrogate pair range 0xD800-0xDFFF)
      if (code < 0 || code > 0x10FFFF) return ''; // Out of range
      if (code >= 0xD800 && code <= 0xDFFF) return ''; // Invalid surrogates
      return String.fromCodePoint(code);
    });
    // Hexadecimal: &#x2014; -> em-dash
    text = text.replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = parseInt(hex, 16);
      if (isNaN(code)) return match; // Preserve malformed
      if (code < 0 || code > 0x10FFFF) return ''; // Out of range
      if (code >= 0xD800 && code <= 0xDFFF) return ''; // Invalid surrogates
      return String.fromCodePoint(code);
    });

    // Decode named entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&apos;/g, "'");
    text = text.replace(/&#039;/g, "'");
    // Common typography entities
    text = text.replace(/&mdash;/g, '\u2014'); // em-dash —
    text = text.replace(/&ndash;/g, '\u2013'); // en-dash –
    text = text.replace(/&hellip;/g, '\u2026'); // ellipsis …
    text = text.replace(/&rsquo;/g, '\u2019'); // right single quote '
    text = text.replace(/&lsquo;/g, '\u2018'); // left single quote '
    text = text.replace(/&rdquo;/g, '\u201D'); // right double quote "
    text = text.replace(/&ldquo;/g, '\u201C'); // left double quote "
    text = text.replace(/&copy;/g, '\u00A9'); // copyright ©
    text = text.replace(/&reg;/g, '\u00AE'); // registered ®
    text = text.replace(/&trade;/g, '\u2122'); // trademark ™

    // Normalize whitespace
    text = text.replace(/\s+/g, ' ').trim();

    return text;
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

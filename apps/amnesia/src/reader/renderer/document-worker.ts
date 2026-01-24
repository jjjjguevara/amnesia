/**
 * Unified Document Worker
 *
 * Web Worker for PDF and EPUB document handling via MuPDF WASM.
 * Provides a unified interface for loading, rendering, text extraction, and search
 * across both document formats.
 *
 * This worker consolidates the functionality of mupdf-worker.ts while adding
 * EPUB-specific capabilities like chapter XHTML extraction.
 *
 * IMPORTANT: This worker uses dynamic import for mupdf to wait for the WASM binary
 * to be provided by the main thread via INIT_WASM message before loading.
 */

// Import types only - the actual module is loaded dynamically
// @ts-ignore - mupdf types are available but moduleResolution needs bundler
import type * as MuPDFTypes from 'mupdf';
import { ZipReader } from './shared/zip-reader';

// MuPDF is loaded dynamically after receiving WASM binary
// @ts-ignore - mupdf types are available but moduleResolution needs bundler
let mupdf: typeof MuPDFTypes;

// ============================================================================
// Types
// ============================================================================

export type DocumentFormat = 'pdf' | 'epub';

export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
}

export interface TocEntry {
  title: string;
  page: number;
  level: number;
  children: TocEntry[];
}

export interface ParsedDocument {
  id: string;
  format: DocumentFormat;
  metadata: DocumentMetadata;
  toc: TocEntry[];
  itemCount: number;
  hasTextLayer: boolean;
}

export interface CharPosition {
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
}

export interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  charPositions: CharPosition[];
}

export interface StructuredText {
  itemIndex: number;
  width: number;
  height: number;
  items: TextItem[];
}

export interface SearchResult {
  page: number;
  text: string;
  quads: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  context?: {
    prefix: string;
    suffix: string;
  };
}

// Worker message types
export type DocumentWorkerRequest =
  | { type: 'LOAD_DOCUMENT'; requestId: string; docId: string; data: ArrayBuffer; filename?: string }
  | { type: 'RENDER_ITEM'; requestId: string; docId: string; itemIndex: number; scale: number }
  | { type: 'RENDER_TILE'; requestId: string; docId: string; itemIndex: number; tileX: number; tileY: number; tileSize: number; scale: number }
  | { type: 'GET_STRUCTURED_TEXT'; requestId: string; docId: string; itemIndex: number }
  | { type: 'SEARCH'; requestId: string; docId: string; query: string; maxHits: number; includeContext?: boolean }
  | { type: 'GET_ITEM_COUNT'; requestId: string; docId: string }
  | { type: 'GET_ITEM_DIMENSIONS'; requestId: string; docId: string; itemIndex: number }
  | { type: 'GET_EPUB_CHAPTER'; requestId: string; docId: string; chapterIndex: number }
  | { type: 'UNLOAD_DOCUMENT'; requestId: string; docId: string };

export type DocumentWorkerResponse =
  | { type: 'LOADED'; requestId: string; document: ParsedDocument; success: true }
  | { type: 'LOAD_ERROR'; requestId: string; error: string; success: false }
  | { type: 'ITEM_RENDERED'; requestId: string; itemIndex: number; data: Uint8Array; width: number; height: number }
  | { type: 'TILE_RENDERED'; requestId: string; itemIndex: number; tileX: number; tileY: number; data: Uint8Array; width: number; height: number; timing?: WorkerTiming }
  | { type: 'TILE_RENDER_ERROR'; requestId: string; itemIndex: number; tileX: number; tileY: number; error: string }
  | { type: 'RENDER_ERROR'; requestId: string; itemIndex: number; error: string }
  | { type: 'STRUCTURED_TEXT'; requestId: string; itemIndex: number; data: StructuredText }
  | { type: 'STRUCTURED_TEXT_ERROR'; requestId: string; itemIndex: number; error: string }
  | { type: 'SEARCH_RESULTS'; requestId: string; results: SearchResult[] }
  | { type: 'SEARCH_ERROR'; requestId: string; error: string }
  | { type: 'ITEM_COUNT'; requestId: string; itemCount: number }
  | { type: 'ITEM_COUNT_ERROR'; requestId: string; error: string }
  | { type: 'ITEM_DIMENSIONS'; requestId: string; itemIndex: number; width: number; height: number }
  | { type: 'ITEM_DIMENSIONS_ERROR'; requestId: string; itemIndex: number; error: string }
  | { type: 'EPUB_CHAPTER'; requestId: string; chapterIndex: number; xhtml: string }
  | { type: 'EPUB_CHAPTER_ERROR'; requestId: string; chapterIndex: number; error: string }
  | { type: 'DOCUMENT_UNLOADED'; requestId: string }
  | { type: 'UNLOAD_ERROR'; requestId: string; error: string };

// ============================================================================
// Document Storage
// ============================================================================

interface CachedDocument {
  doc: any; // MuPDF Document
  format: DocumentFormat;
  metadata: ParsedDocument;
  /** Original EPUB data for direct ZIP parsing */
  epubData?: ArrayBuffer;
  /** Parsed EPUB structure */
  epubStructure?: EpubStructure;
}

/** Parsed EPUB internal structure */
interface EpubStructure {
  opfPath: string;
  spine: string[]; // hrefs of chapters in reading order
  manifest: Map<string, { href: string; mediaType: string }>;
  basePath: string;
}

const documents = new Map<string, CachedDocument>();

// ============================================================================
// Format Detection
// ============================================================================

function detectFormat(data: ArrayBuffer, filename?: string): DocumentFormat {
  const bytes = new Uint8Array(data);

  // PDF magic: %PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'pdf';
  }

  // EPUB magic: PK (ZIP with specific content)
  if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
    // Could be EPUB or other ZIP - check filename
    if (filename?.toLowerCase().endsWith('.epub')) {
      return 'epub';
    }
    // Default to EPUB for ZIP files without better info
    return 'epub';
  }

  // Fallback to filename extension
  if (filename) {
    const ext = filename.toLowerCase().split('.').pop();
    if (ext === 'pdf') return 'pdf';
    if (ext === 'epub') return 'epub';
  }

  // Default to PDF
  return 'pdf';
}

function getMimeType(format: DocumentFormat): string {
  return format === 'pdf' ? 'application/pdf' : 'application/epub+zip';
}

// ============================================================================
// EPUB Structure Parsing
// ============================================================================

/**
 * Parse EPUB structure from ZIP data.
 * Reads container.xml -> OPF -> extracts spine and manifest.
 */
async function parseEpubStructure(data: ArrayBuffer): Promise<EpubStructure> {
  const zip = new ZipReader(data);

  // Step 1: Read container.xml to find OPF path
  const containerXml = await zip.readText('META-INF/container.xml');
  const opfPath = extractOpfPath(containerXml);

  if (!opfPath) {
    throw new Error('Could not find OPF path in container.xml');
  }

  // Determine base path for relative URLs in OPF
  const basePath = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // Step 2: Read and parse OPF
  const opfXml = await zip.readText(opfPath);
  const { spine, manifest } = parseOpf(opfXml);

  return {
    opfPath,
    spine,
    manifest,
    basePath,
  };
}

/**
 * Extract OPF path from container.xml using regex (lightweight parsing)
 */
function extractOpfPath(containerXml: string): string | null {
  // Look for: <rootfile full-path="..." media-type="application/oebps-package+xml"/>
  const match = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
}

/**
 * Parse OPF to extract spine (reading order) and manifest
 */
function parseOpf(opfXml: string): { spine: string[]; manifest: Map<string, { href: string; mediaType: string }> } {
  const manifest = new Map<string, { href: string; mediaType: string }>();
  const spine: string[] = [];

  // Parse manifest items
  // <item id="..." href="..." media-type="..."/>
  const itemRegex = /<item\s+([^>]+)\/?\s*>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(opfXml)) !== null) {
    const attrs = itemMatch[1];
    const id = extractAttr(attrs, 'id');
    const href = extractAttr(attrs, 'href');
    const mediaType = extractAttr(attrs, 'media-type');

    if (id && href) {
      manifest.set(id, { href, mediaType: mediaType || 'application/xhtml+xml' });
    }
  }

  // Parse spine itemrefs
  // <itemref idref="..."/>
  const itemrefRegex = /<itemref\s+([^>]+)\/?\s*>/gi;
  let itemrefMatch;
  while ((itemrefMatch = itemrefRegex.exec(opfXml)) !== null) {
    const attrs = itemrefMatch[1];
    const idref = extractAttr(attrs, 'idref');

    if (idref) {
      const item = manifest.get(idref);
      if (item) {
        spine.push(item.href);
      }
    }
  }

  return { spine, manifest };
}

/**
 * Extract attribute value from HTML/XML attribute string
 */
function extractAttr(attrStr: string, name: string): string | null {
  const regex = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = attrStr.match(regex);
  return match ? decodeXmlEntities(match[1]) : null;
}

/**
 * Decode common XML entities
 */
function decodeXmlEntities(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Sanitize a path to prevent traversal attacks
 *
 * Security: URL decoding is performed BEFORE traversal checks to prevent
 * bypasses via encoded sequences like %2e%2e%2f (../)
 */
function sanitizeEpubPath(basePath: string, relativePath: string): string {
  // Normalize path separators first
  let normalized = relativePath.replace(/\\/g, '/');

  // URL-decode the path FIRST to catch encoded traversal attempts
  // (e.g., %2e%2e%2f would decode to ../)
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // If decoding fails, log warning and continue with original
    console.warn(`[EPUB Worker] Invalid URL encoding in path: ${relativePath}`);
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
 * Read EPUB chapter content directly from ZIP
 */
async function readEpubChapter(data: ArrayBuffer, structure: EpubStructure, chapterIndex: number): Promise<string> {
  if (chapterIndex < 0 || chapterIndex >= structure.spine.length) {
    throw new Error(`Invalid chapter index: ${chapterIndex}. EPUB has ${structure.spine.length} chapters.`);
  }

  const chapterHref = structure.spine[chapterIndex];
  // Use sanitized path to prevent traversal attacks
  const fullPath = sanitizeEpubPath(structure.basePath, chapterHref);

  const zip = new ZipReader(data);
  const xhtml = await zip.readText(fullPath);

  return xhtml;
}

// ============================================================================
// Document Operations
// ============================================================================

function loadDocument(id: string, data: ArrayBuffer, filename?: string): ParsedDocument {
  // Unload existing document with same ID
  if (documents.has(id)) {
    try {
      documents.get(id)?.doc?.destroy?.();
    } catch {
      // Ignore destroy errors
    }
    documents.delete(id);
  }

  const format = detectFormat(data, filename);
  const mimeType = getMimeType(format);

  // Copy EPUB data BEFORE passing to MuPDF (MuPDF may consume/transfer the buffer)
  const epubData = format === 'epub' ? data.slice(0) : undefined;

  const doc = mupdf.Document.openDocument(data, mimeType);

  // Extract metadata
  const metadata: DocumentMetadata = {};
  try {
    metadata.title = doc.getMetaData('info:Title') || undefined;
    metadata.author = doc.getMetaData('info:Author') || undefined;
    metadata.subject = doc.getMetaData('info:Subject') || undefined;
    metadata.creator = doc.getMetaData('info:Creator') || undefined;
    metadata.producer = doc.getMetaData('info:Producer') || undefined;
    metadata.creationDate = doc.getMetaData('info:CreationDate') || undefined;
    metadata.modificationDate = doc.getMetaData('info:ModDate') || undefined;
    const keywords = doc.getMetaData('info:Keywords');
    if (keywords) {
      metadata.keywords = keywords.split(',').map((k: string) => k.trim());
    }
  } catch {
    // Metadata extraction is optional
  }

  // Extract TOC
  const toc: TocEntry[] = [];
  try {
    const outline = doc.loadOutline();
    if (outline) {
      function convertOutline(items: any[]): TocEntry[] {
        return items.map((item) => ({
          title: item.title || '',
          page: item.page ?? 0,
          level: item.level ?? 0,
          children: item.down ? convertOutline(item.down) : [],
        }));
      }
      toc.push(...convertOutline(outline));
    }
  } catch {
    // TOC is optional
  }

  const itemCount = doc.countPages();
  const hasTextLayer = checkHasTextLayer(doc, format);

  const parsed: ParsedDocument = {
    id,
    format,
    metadata,
    toc,
    itemCount,
    hasTextLayer,
  };

  documents.set(id, { doc, format, metadata: parsed, epubData });
  return parsed;
}

function checkHasTextLayer(doc: any, format: DocumentFormat): boolean {
  if (format === 'epub') {
    return true; // EPUBs always have text
  }

  try {
    if (doc.countPages() === 0) return false;
    const page = doc.loadPage(0);
    const stext = page.toStructuredText('preserve-whitespace');
    const text = stext.asText?.() || '';
    stext.destroy();
    page.destroy();
    return text.trim().length > 0;
  } catch {
    return false;
  }
}

function renderItem(
  id: string,
  itemIndex: number,
  scale: number
): { data: Uint8Array; width: number; height: number } {
  const cached = documents.get(id);
  if (!cached) {
    throw new Error(`Document ${id} not loaded`);
  }

  const page = cached.doc.loadPage(itemIndex);
  let pixmap: any = null;
  let device: any = null;

  try {
    const bounds = page.getBounds();
    const pageWidth = bounds[2] - bounds[0];
    const pageHeight = bounds[3] - bounds[1];

    // PERF FIX: Cap output dimensions to prevent OOM on full-page renders.
    // At scale 32 with US Letter (612×792), output would be 19584×25344 = ~2GB.
    // Cap to 4096px max dimension (still high quality for most use cases).
    // This matches the approach used in renderTile but with larger limit for full pages.
    const MAX_OUTPUT_DIM = 4096;
    const rawOutputWidth = Math.ceil(pageWidth * scale);
    const rawOutputHeight = Math.ceil(pageHeight * scale);

    // If output would exceed max, reduce effective scale
    const dimensionScale = Math.min(
      MAX_OUTPUT_DIM / rawOutputWidth,
      MAX_OUTPUT_DIM / rawOutputHeight,
      1.0 // Don't increase scale
    );

    const outputWidth = Math.ceil(rawOutputWidth * dimensionScale);
    const outputHeight = Math.ceil(rawOutputHeight * dimensionScale);
    const effectiveScale = scale * dimensionScale;

    const bbox: [number, number, number, number] = [0, 0, outputWidth, outputHeight];
    pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
    pixmap.clear(255); // Fill with white background

    device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    // Scale the page to output size
    // Use effectiveScale (capped) instead of raw scale to prevent OOM
    const matrix = mupdf.Matrix.scale(effectiveScale, effectiveScale);

    page.run(device, matrix);
    device.close();

    const pngData = pixmap.asPNG();

    return {
      data: pngData,
      width: outputWidth,
      height: outputHeight,
    };
  } finally {
    // Ensure cleanup even if an error occurs
    try { device?.destroy(); } catch { /* ignore */ }
    try { pixmap?.destroy(); } catch { /* ignore */ }
    try { page.destroy(); } catch { /* ignore */ }
  }
}

/** Worker timing data for pipeline telemetry */
export interface WorkerTiming {
  pageLoad: number;
  render: number;
  encode: number;
  total: number;
}

function renderTile(
  id: string,
  itemIndex: number,
  tileX: number,
  tileY: number,
  tileSize: number,
  scale: number
): { data: Uint8Array; width: number; height: number; timing: WorkerTiming } {
  const startTotal = performance.now();

  const cached = documents.get(id);
  if (!cached) {
    throw new Error(`Document ${id} not loaded`);
  }

  // Time page load
  const startPageLoad = performance.now();
  const page = cached.doc.loadPage(itemIndex);
  const pageLoadTime = performance.now() - startPageLoad;

  let pixmap: any = null;
  let device: any = null;

  try {
    const bounds = page.getBounds();
    const pageWidth = bounds[2] - bounds[0];
    const pageHeight = bounds[3] - bounds[1];

    // Calculate tile region
    const pageTileSize = tileSize / scale;
    const originX = tileX * pageTileSize;
    const originY = tileY * pageTileSize;

    const tileWidthPage = Math.min(pageTileSize, pageWidth - originX);
    const tileHeightPage = Math.min(pageTileSize, pageHeight - originY);

    if (tileWidthPage <= 0 || tileHeightPage <= 0) {
      throw new Error(`Tile (${tileX}, ${tileY}) is outside page bounds`);
    }

    const outputWidth = Math.ceil(tileWidthPage * scale);
    const outputHeight = Math.ceil(tileHeightPage * scale);

    const bbox: [number, number, number, number] = [0, 0, outputWidth, outputHeight];
    pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
    pixmap.clear(255);

    device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    // Translate to tile origin, then scale
    const translateMatrix = mupdf.Matrix.translate(-originX, -originY);
    const scaleMatrix = mupdf.Matrix.scale(scale, scale);
    const matrix = mupdf.Matrix.concat(translateMatrix, scaleMatrix);

    // Time render
    const startRender = performance.now();
    page.run(device, matrix);
    device.close();
    const renderTime = performance.now() - startRender;

    // Time encode
    const startEncode = performance.now();
    const pngData = pixmap.asPNG();
    const encodeTime = performance.now() - startEncode;

    return {
      data: pngData,
      width: outputWidth,
      height: outputHeight,
      timing: {
        pageLoad: pageLoadTime,
        render: renderTime,
        encode: encodeTime,
        total: performance.now() - startTotal,
      },
    };
  } finally {
    // Ensure cleanup even if an error occurs
    try { device?.destroy(); } catch { /* ignore */ }
    try { pixmap?.destroy(); } catch { /* ignore */ }
    try { page.destroy(); } catch { /* ignore */ }
  }
}

function getStructuredText(id: string, itemIndex: number): StructuredText {
  const cached = documents.get(id);
  if (!cached) {
    throw new Error(`Document ${id} not loaded`);
  }

  const page = cached.doc.loadPage(itemIndex);
  let stext: any = null;

  try {
    const bounds = page.getBounds();
    const width = bounds[2] - bounds[0];
    const height = bounds[3] - bounds[1];

    stext = page.toStructuredText('preserve-whitespace');
    const items: TextItem[] = [];
    let currentLine: { chars: CharPosition[]; bbox: MuPDFTypes.Rect } | null = null;

    stext.walk({
      beginLine(bbox: MuPDFTypes.Rect) {
        currentLine = { chars: [], bbox };
      },

      onChar(
        c: string,
        _origin: MuPDFTypes.Point,
        font: MuPDFTypes.Font,
        size: number,
        quad: MuPDFTypes.Quad
      ) {
        if (!currentLine) return;

        const charX = Math.min(quad[0], quad[6]);
        const charY = Math.min(quad[1], quad[3]);
        const charWidth = Math.abs(quad[2] - quad[0]);
        const charHeight = Math.abs(quad[5] - quad[1]);

        currentLine.chars.push({
          char: c,
          x: charX,
          y: charY,
          width: charWidth,
          height: charHeight,
          fontSize: size,
          fontName: font.getName(),
        });
      },

      endLine() {
        if (!currentLine || currentLine.chars.length === 0) {
          currentLine = null;
          return;
        }

        const text = currentLine.chars.map((c) => c.char).join('');
        const lineX = currentLine.bbox[0];
        const lineY = currentLine.bbox[1];
        const lineWidth = currentLine.bbox[2] - currentLine.bbox[0];
        const lineHeight = currentLine.bbox[3] - currentLine.bbox[1];
        const fontSize = currentLine.chars[0]?.fontSize ?? 12;

        items.push({
          text,
          x: lineX,
          y: lineY,
          width: lineWidth,
          height: lineHeight,
          fontSize,
          charPositions: currentLine.chars,
        });

        currentLine = null;
      },
    });

    return { itemIndex, width, height, items };
  } finally {
    // Ensure cleanup even if an error occurs
    try { stext?.destroy(); } catch { /* ignore */ }
    try { page.destroy(); } catch { /* ignore */ }
  }
}

function searchDocument(
  id: string,
  query: string,
  maxHits: number,
  includeContext: boolean = false
): SearchResult[] {
  const cached = documents.get(id);
  if (!cached) {
    throw new Error(`Document ${id} not loaded`);
  }

  const results: SearchResult[] = [];
  const pageCount = cached.doc.countPages();
  let remaining = maxHits;

  for (let i = 0; i < pageCount && remaining > 0; i++) {
    const page = cached.doc.loadPage(i);
    const quads = page.search(query, remaining);

    for (const quadArray of quads) {
      if (remaining <= 0) break;

      const rects = quadArray.map((quad: MuPDFTypes.Quad) => {
        const x = Math.min(quad[0], quad[6]);
        const y = Math.min(quad[1], quad[3]);
        const quadWidth = Math.max(quad[2], quad[4]) - x;
        const quadHeight = Math.max(quad[5], quad[7]) - y;
        return { x, y, width: quadWidth, height: quadHeight };
      });

      const result: SearchResult = {
        page: i + 1, // 1-indexed
        text: query,
        quads: rects,
      };

      // Extract context if requested
      if (includeContext) {
        try {
          const context = extractSearchContext(page, rects[0], query);
          if (context) {
            result.context = context;
          }
        } catch {
          // Context extraction is optional
        }
      }

      results.push(result);
      remaining--;
    }

    page.destroy();
  }

  return results;
}

function extractSearchContext(
  page: any,
  rect: { x: number; y: number; width: number; height: number },
  query: string
): { prefix: string; suffix: string } | null {
  try {
    const stext = page.toStructuredText('preserve-whitespace');
    const fullText = stext.asText?.() || '';
    stext.destroy();

    const queryIndex = fullText.toLowerCase().indexOf(query.toLowerCase());
    if (queryIndex === -1) return null;

    const prefixStart = Math.max(0, queryIndex - 50);
    const suffixEnd = Math.min(fullText.length, queryIndex + query.length + 50);

    return {
      prefix: fullText.slice(prefixStart, queryIndex),
      suffix: fullText.slice(queryIndex + query.length, suffixEnd),
    };
  } catch {
    return null;
  }
}

function getItemDimensions(id: string, itemIndex: number): { width: number; height: number } {
  const cached = documents.get(id);
  if (!cached) {
    throw new Error(`Document ${id} not loaded`);
  }

  const page = cached.doc.loadPage(itemIndex);
  const bounds = page.getBounds();
  const result = {
    width: bounds[2] - bounds[0],
    height: bounds[3] - bounds[1],
  };
  page.destroy();
  return result;
}

/**
 * Get EPUB chapter XHTML content using direct ZIP extraction.
 * This bypasses MuPDF's text extraction (which doesn't work for EPUBs)
 * and reads the original XHTML directly from the EPUB ZIP archive.
 */
async function getEpubChapter(id: string, chapterIndex: number): Promise<string> {
  const cached = documents.get(id);
  if (!cached) {
    throw new Error(`Document ${id} not loaded`);
  }

  if (cached.format !== 'epub') {
    throw new Error('getEpubChapter is only available for EPUB documents');
  }

  if (!cached.epubData) {
    throw new Error('EPUB data not available. Document may have been loaded incorrectly.');
  }

  // Parse EPUB structure lazily (first access parses and caches)
  if (!cached.epubStructure) {
    console.log('[Document Worker] Parsing EPUB structure...');
    cached.epubStructure = await parseEpubStructure(cached.epubData);
    console.log(`[Document Worker] EPUB has ${cached.epubStructure.spine.length} chapters in spine`);
  }

  // Read chapter content directly from ZIP
  const xhtml = await readEpubChapter(cached.epubData, cached.epubStructure, chapterIndex);
  console.log(`[Document Worker] Read chapter ${chapterIndex}: ${xhtml.length} chars`);

  return xhtml;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function unloadDocument(id: string): void {
  const cached = documents.get(id);
  if (cached) {
    try {
      cached.doc.destroy?.();
    } catch {
      // Ignore destroy errors
    }
    documents.delete(id);
  }
}

// ============================================================================
// Message Handling
// ============================================================================

function handleRequest(request: DocumentWorkerRequest): void {
  try {
    switch (request.type) {
      case 'LOAD_DOCUMENT': {
        const document = loadDocument(request.docId, request.data, request.filename);
        self.postMessage({
          type: 'LOADED',
          requestId: request.requestId,
          document,
          success: true,
        } as DocumentWorkerResponse);
        break;
      }

      case 'RENDER_ITEM': {
        const { data, width, height } = renderItem(
          request.docId,
          request.itemIndex,
          request.scale
        );
        const message: DocumentWorkerResponse = {
          type: 'ITEM_RENDERED',
          requestId: request.requestId,
          itemIndex: request.itemIndex,
          data,
          width,
          height,
        };
        (self.postMessage as (message: unknown, transfer: Transferable[]) => void)(
          message,
          [data.buffer as ArrayBuffer]
        );
        break;
      }

      case 'RENDER_TILE': {
        const { data, width, height, timing } = renderTile(
          request.docId,
          request.itemIndex,
          request.tileX,
          request.tileY,
          request.tileSize,
          request.scale
        );
        const message: DocumentWorkerResponse = {
          type: 'TILE_RENDERED',
          requestId: request.requestId,
          itemIndex: request.itemIndex,
          tileX: request.tileX,
          tileY: request.tileY,
          data,
          width,
          height,
          timing,
        };
        (self.postMessage as (message: unknown, transfer: Transferable[]) => void)(
          message,
          [data.buffer as ArrayBuffer]
        );
        break;
      }

      case 'GET_STRUCTURED_TEXT': {
        const stext = getStructuredText(request.docId, request.itemIndex);
        self.postMessage({
          type: 'STRUCTURED_TEXT',
          requestId: request.requestId,
          itemIndex: request.itemIndex,
          data: stext,
        } as DocumentWorkerResponse);
        break;
      }

      case 'SEARCH': {
        const results = searchDocument(
          request.docId,
          request.query,
          request.maxHits,
          request.includeContext
        );
        self.postMessage({
          type: 'SEARCH_RESULTS',
          requestId: request.requestId,
          results,
        } as DocumentWorkerResponse);
        break;
      }

      case 'GET_ITEM_COUNT': {
        const cached = documents.get(request.docId);
        if (!cached) {
          throw new Error(`Document ${request.docId} not loaded`);
        }
        self.postMessage({
          type: 'ITEM_COUNT',
          requestId: request.requestId,
          itemCount: cached.doc.countPages(),
        } as DocumentWorkerResponse);
        break;
      }

      case 'GET_ITEM_DIMENSIONS': {
        const dims = getItemDimensions(request.docId, request.itemIndex);
        self.postMessage({
          type: 'ITEM_DIMENSIONS',
          requestId: request.requestId,
          itemIndex: request.itemIndex,
          ...dims,
        } as DocumentWorkerResponse);
        break;
      }

      case 'GET_EPUB_CHAPTER': {
        // Async handler for EPUB chapter extraction
        getEpubChapter(request.docId, request.chapterIndex)
          .then((xhtml) => {
            self.postMessage({
              type: 'EPUB_CHAPTER',
              requestId: request.requestId,
              chapterIndex: request.chapterIndex,
              xhtml,
            } as DocumentWorkerResponse);
          })
          .catch((error) => {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            self.postMessage({
              type: 'EPUB_CHAPTER_ERROR',
              requestId: request.requestId,
              chapterIndex: request.chapterIndex,
              error: errorMessage,
            } as DocumentWorkerResponse);
          });
        break;
      }

      case 'UNLOAD_DOCUMENT': {
        unloadDocument(request.docId);
        self.postMessage({
          type: 'DOCUMENT_UNLOADED',
          requestId: request.requestId,
        } as DocumentWorkerResponse);
        break;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    handleError(request, errorMessage);
  }
}

function handleError(request: DocumentWorkerRequest, errorMessage: string): void {
  switch (request.type) {
    case 'LOAD_DOCUMENT':
      self.postMessage({
        type: 'LOAD_ERROR',
        requestId: request.requestId,
        error: errorMessage,
        success: false,
      } as DocumentWorkerResponse);
      break;

    case 'RENDER_ITEM':
      self.postMessage({
        type: 'RENDER_ERROR',
        requestId: request.requestId,
        itemIndex: request.itemIndex,
        error: errorMessage,
      } as DocumentWorkerResponse);
      break;

    case 'RENDER_TILE':
      self.postMessage({
        type: 'TILE_RENDER_ERROR',
        requestId: request.requestId,
        itemIndex: request.itemIndex,
        tileX: request.tileX,
        tileY: request.tileY,
        error: errorMessage,
      } as DocumentWorkerResponse);
      break;

    case 'GET_STRUCTURED_TEXT':
      self.postMessage({
        type: 'STRUCTURED_TEXT_ERROR',
        requestId: request.requestId,
        itemIndex: request.itemIndex,
        error: errorMessage,
      } as DocumentWorkerResponse);
      break;

    case 'SEARCH':
      self.postMessage({
        type: 'SEARCH_ERROR',
        requestId: request.requestId,
        error: errorMessage,
      } as DocumentWorkerResponse);
      break;

    case 'GET_ITEM_COUNT':
      self.postMessage({
        type: 'ITEM_COUNT_ERROR',
        requestId: request.requestId,
        error: errorMessage,
      } as DocumentWorkerResponse);
      break;

    case 'GET_ITEM_DIMENSIONS':
      self.postMessage({
        type: 'ITEM_DIMENSIONS_ERROR',
        requestId: request.requestId,
        itemIndex: request.itemIndex,
        error: errorMessage,
      } as DocumentWorkerResponse);
      break;

    case 'GET_EPUB_CHAPTER':
      self.postMessage({
        type: 'EPUB_CHAPTER_ERROR',
        requestId: request.requestId,
        chapterIndex: request.chapterIndex,
        error: errorMessage,
      } as DocumentWorkerResponse);
      break;

    case 'UNLOAD_DOCUMENT':
      self.postMessage({
        type: 'UNLOAD_ERROR',
        requestId: request.requestId,
        error: errorMessage,
      } as DocumentWorkerResponse);
      break;

    default:
      console.error('[Document Worker] Error:', errorMessage);
  }
}

// ============================================================================
// Initialization
// ============================================================================

async function initializeWorker(): Promise<void> {
  // Wait for WASM binary from main thread
  const wasmReady = (globalThis as Record<string, unknown>).__MUPDF_WASM_READY__ as Promise<void>;
  await wasmReady;

  // Dynamically import mupdf
  // @ts-ignore
  mupdf = await import('mupdf');

  // Set up message handler
  self.onmessage = (event: MessageEvent<DocumentWorkerRequest>) => {
    handleRequest(event.data);
  };

  // Signal worker is ready
  self.postMessage({ type: 'READY' });
}

// Start initialization
initializeWorker().catch((error) => {
  console.error('[Document Worker] Initialization failed:', error);
  self.postMessage({ type: 'INIT_ERROR', error: String(error) });
});

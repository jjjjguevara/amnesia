/**
 * MuPDF Web Worker
 *
 * Runs MuPDF WASM in a dedicated Web Worker to avoid blocking the main thread.
 * Handles PDF loading, rendering, and text extraction.
 *
 * IMPORTANT: This worker uses dynamic import for mupdf to wait for the WASM binary
 * to be provided by the main thread via INIT_WASM message before loading.
 */

// Import types only - the actual module is loaded dynamically
// @ts-ignore - mupdf types are available but moduleResolution needs bundler
import type * as MuPDFTypes from 'mupdf';

// MuPDF is loaded dynamically after receiving WASM binary
// @ts-ignore - mupdf types are available but moduleResolution needs bundler
let mupdf: typeof MuPDFTypes;

/**
 * Output format for rendered tiles/pages
 * - 'png': PNG encoded (legacy, slower but compressed)
 * - 'rgba': Raw RGBA pixels (faster, uncompressed)
 */
export type RenderFormat = 'png' | 'rgba';

// Import content type classifier types
import type {
  PDFContentType,
  PageClassification,
  OperatorCounts,
  PageImageInfo,
} from './content-type-classifier';

/** SharedArrayBuffer slot reference for zero-copy rendering */
export interface SharedBufferSlot {
  /** Size tier of the buffer */
  tierSize: number;
  /** Slot index within the tier */
  index: number;
}

// Types for worker messages
// Each request has a `requestId` for correlation and `docId` for the document ID
export type WorkerRequest =
  | { type: 'LOAD_DOCUMENT'; requestId: string; docId: string; data: ArrayBuffer }
  | { type: 'RENDER_PAGE'; requestId: string; docId: string; pageNum: number; scale: number; format?: RenderFormat }
  | { type: 'RENDER_TILE'; requestId: string; docId: string; pageNum: number; tileX: number; tileY: number; tileSize: number; scale: number; format?: RenderFormat; sharedSlot?: SharedBufferSlot }
  | { type: 'INIT_SHARED_BUFFERS'; requestId: string; buffers: Array<{ tierSize: number; buffer: SharedArrayBuffer }> }
  | { type: 'GET_TEXT_LAYER'; requestId: string; docId: string; pageNum: number }
  | { type: 'SEARCH'; requestId: string; docId: string; query: string; maxHits: number }
  | { type: 'GET_PAGE_COUNT'; requestId: string; docId: string }
  | { type: 'GET_PAGE_DIMENSIONS'; requestId: string; docId: string; pageNum: number }
  | { type: 'CLASSIFY_PAGE'; requestId: string; docId: string; pageNum: number }
  | { type: 'CLASSIFY_PAGES'; requestId: string; docId: string; pageNums: number[] }
  | { type: 'EXTRACT_JPEG'; requestId: string; docId: string; pageNum: number }
  | { type: 'UNLOAD_DOCUMENT'; requestId: string; docId: string };

export type WorkerResponse =
  | { type: 'LOADED'; requestId: string; pageCount: number; toc: TocEntry[]; success: true }
  | { type: 'LOAD_ERROR'; requestId: string; error: string; success: false }
  | { type: 'PAGE_RENDERED'; requestId: string; pageNum: number; data: Uint8Array; width: number; height: number; format: RenderFormat; timing?: WorkerTiming }
  | { type: 'TILE_RENDERED'; requestId: string; pageNum: number; tileX: number; tileY: number; data: Uint8Array; width: number; height: number; format: RenderFormat; timing?: WorkerTiming }
  | { type: 'TILE_RENDERED_SHARED'; requestId: string; pageNum: number; tileX: number; tileY: number; sharedSlot: SharedBufferSlot; dataLength: number; width: number; height: number; format: RenderFormat; timing?: WorkerTiming }
  | { type: 'SHARED_BUFFERS_INITIALIZED'; requestId: string; success: boolean; tierSizes: number[] }
  | { type: 'TILE_RENDER_ERROR'; requestId: string; pageNum: number; tileX: number; tileY: number; error: string }
  | { type: 'RENDER_ERROR'; requestId: string; pageNum: number; error: string }
  | { type: 'TEXT_LAYER'; requestId: string; pageNum: number; data: TextLayerData }
  | { type: 'TEXT_LAYER_ERROR'; requestId: string; pageNum: number; error: string }
  | { type: 'SEARCH_RESULTS'; requestId: string; results: SearchResult[] }
  | { type: 'SEARCH_ERROR'; requestId: string; error: string }
  | { type: 'PAGE_COUNT'; requestId: string; pageCount: number }
  | { type: 'PAGE_COUNT_ERROR'; requestId: string; error: string }
  | { type: 'PAGE_DIMENSIONS'; requestId: string; pageNum: number; width: number; height: number }
  | { type: 'PAGE_DIMENSIONS_ERROR'; requestId: string; pageNum: number; error: string }
  | { type: 'PAGE_CLASSIFIED'; requestId: string; pageNum: number; classification: PageClassification }
  | { type: 'PAGES_CLASSIFIED'; requestId: string; classifications: Array<{ pageNum: number; classification: PageClassification }> }
  | { type: 'CLASSIFY_ERROR'; requestId: string; pageNum: number; error: string }
  | { type: 'JPEG_EXTRACTED'; requestId: string; pageNum: number; data: Uint8Array; width: number; height: number }
  | { type: 'JPEG_EXTRACT_ERROR'; requestId: string; pageNum: number; error: string }
  | { type: 'DOCUMENT_UNLOADED'; requestId: string }
  | { type: 'UNLOAD_ERROR'; requestId: string; error: string };

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

export interface TextLayerData {
  pageNum: number;
  width: number;
  height: number;
  items: TextItem[];
  /** EPUB fallback: plain text content when items is empty */
  textContent?: string;
  /** EPUB fallback: HTML content when items is empty */
  htmlContent?: string;
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
}

export interface TocEntry {
  id: string;
  label: string;
  href: string;
  children: TocEntry[];
}

/**
 * Timing data for worker operations
 * Used by the main thread for telemetry
 */
export interface WorkerTiming {
  /** Time to load the page (ms) */
  pageLoad: number;
  /** Time to render/run the page through device (ms) */
  render: number;
  /** Time to encode to PNG (ms) */
  encode: number;
  /** Total worker operation time (ms) */
  total: number;
}

// Document cache - uses 'any' since mupdf is dynamically loaded
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const documents = new Map<string, any>();

// SharedArrayBuffer pool references for zero-copy rendering
// Key: tier size in bytes, Value: array of SharedArrayBuffers for that tier
const sharedBuffers = new Map<number, SharedArrayBuffer[]>();

/**
 * Initialize shared buffer references from main thread
 */
function initializeSharedBuffers(
  buffers: Array<{ tierSize: number; buffer: SharedArrayBuffer }>
): { success: boolean; tierSizes: number[] } {
  sharedBuffers.clear();

  for (const { tierSize, buffer } of buffers) {
    if (!sharedBuffers.has(tierSize)) {
      sharedBuffers.set(tierSize, []);
    }
    sharedBuffers.get(tierSize)!.push(buffer);
  }

  const tierSizes = Array.from(sharedBuffers.keys());
  console.log(
    `[MuPDF Worker] Initialized shared buffers: ${tierSizes.length} tiers, ` +
      `sizes: ${tierSizes.map((s) => `${(s / 1024).toFixed(0)}KB`).join(', ')}`
  );

  return { success: true, tierSizes };
}

/**
 * Get a shared buffer view for a specific slot
 */
function getSharedBufferView(
  tierSize: number,
  slotIndex: number,
  dataLength: number
): Uint8Array | null {
  const tierBuffers = sharedBuffers.get(tierSize);
  if (!tierBuffers || slotIndex >= tierBuffers.length) {
    console.warn(
      `[MuPDF Worker] Invalid shared buffer slot: tier=${tierSize}, index=${slotIndex}`
    );
    return null;
  }

  const buffer = tierBuffers[slotIndex];
  if (buffer.byteLength < dataLength) {
    console.warn(
      `[MuPDF Worker] Shared buffer too small: have ${buffer.byteLength}, need ${dataLength}`
    );
    return null;
  }

  return new Uint8Array(buffer, 0, dataLength);
}

/**
 * Load a PDF document from ArrayBuffer
 */
function loadDocument(id: string, data: ArrayBuffer): { pageCount: number; toc: TocEntry[] } {
  // Unload existing document with same ID
  if (documents.has(id)) {
    try {
      documents.get(id)?.destroy?.();
    } catch {
      // Ignore destroy errors
    }
    documents.delete(id);
  }

  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  documents.set(id, doc);

  // Extract TOC using MuPDF's loadOutline
  const toc: TocEntry[] = [];
  let tocIdCounter = 0;
  try {
    const outline = doc.loadOutline();
    if (outline) {
      // Convert MuPDF outline to our TocEntry format
      // Uses page:X as href for PDF navigation
      function convertOutline(items: any[]): TocEntry[] {
        return items.map((item) => {
          const pageNum = typeof item.page === 'number' ? item.page + 1 : 1; // MuPDF uses 0-indexed pages
          return {
            id: `toc-${tocIdCounter++}`,
            label: item.title || `Page ${pageNum}`,
            href: `page:${pageNum}`,
            children: item.down ? convertOutline(item.down) : [],
          };
        });
      }
      toc.push(...convertOutline(outline));
    }
  } catch {
    // TOC extraction is optional - some PDFs don't have outlines
  }

  return { pageCount: doc.countPages(), toc };
}

/**
 * Render a page to PNG or raw RGBA bytes
 * @param format Output format: 'png' (compressed) or 'rgba' (raw pixels, faster)
 */
function renderPage(
  id: string,
  pageNum: number,
  scale: number,
  format: RenderFormat = 'png'
): { data: Uint8Array; width: number; height: number; format: RenderFormat; timing: WorkerTiming } {
  const startTotal = performance.now();

  const doc = documents.get(id);
  if (!doc) {
    throw new Error(`Document ${id} not loaded`);
  }

  // MuPDF uses 0-indexed pages
  const startPageLoad = performance.now();
  const page = doc.loadPage(pageNum - 1);
  const pageLoadTime = performance.now() - startPageLoad;

  // Get page bounds to calculate output dimensions
  const bounds = page.getBounds();
  const pageWidth = bounds[2] - bounds[0];
  const pageHeight = bounds[3] - bounds[1];

  // DEBUG: Log bounds for first few pages to diagnose clipping
  if (pageNum <= 3) {
    console.log(`[MuPDF Worker] renderPage ${pageNum}: bounds=[${bounds.map((b: number) => b.toFixed(1)).join(', ')}], pageSize=${pageWidth.toFixed(1)}x${pageHeight.toFixed(1)}, scale=${scale.toFixed(2)}, output=${Math.ceil(pageWidth * scale)}x${Math.ceil(pageHeight * scale)}`);
  }

  // Calculate output dimensions in device pixels
  // PERF FIX: Cap output dimensions to prevent OOM for large pages at high scale
  // A 612x792 PDF at scale 32 would be 19584x25344 = 1.98GB - impossible!
  // Cap to 4096px (generous for full pages, allows scale 8 on typical pages)
  const MAX_PAGE_OUTPUT_DIM = 4096;

  // ASPECT RATIO FIX (2026-01-23): Derive height from width to preserve exact aspect ratio.
  // Independent Math.ceil() on width and height causes aspect drift (e.g., 0.6622 vs 0.6624),
  // which causes text clipping when the rendered buffer is drawn to a canvas with different aspect.
  const pdfAspect = pageWidth / pageHeight;
  const rawOutputWidth = Math.ceil(pageWidth * scale);
  const rawOutputHeight = Math.round(rawOutputWidth / pdfAspect);

  // If output would exceed max, reduce effective scale proportionally
  const dimensionScale = Math.min(
    MAX_PAGE_OUTPUT_DIM / rawOutputWidth,
    MAX_PAGE_OUTPUT_DIM / rawOutputHeight,
    1.0 // Don't increase scale
  );

  // Apply dimension scale while preserving aspect ratio
  const outputWidth = Math.ceil(rawOutputWidth * dimensionScale);
  const outputHeight = Math.round(outputWidth / pdfAspect);
  const effectiveScale = scale * dimensionScale;

  // Log if scale was reduced
  if (dimensionScale < 1) {
    console.log(`[MuPDF Worker] Full page scale capped: ${scale.toFixed(1)} → ${effectiveScale.toFixed(1)} (${rawOutputWidth}x${rawOutputHeight} → ${outputWidth}x${outputHeight})`);
  }

  // Create a Pixmap with specific bounding box
  // This is the same pattern as renderTile - fixes transparent background issue
  const bbox: [number, number, number, number] = [0, 0, outputWidth, outputHeight];
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);

  // Clear pixmap to white (critical - otherwise background is transparent)
  pixmap.clear(255);

  // Create DrawDevice to render into the pixmap
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);

  // Create transformation matrix for page.run() - uses effectiveScale (capped)
  //
  // PAGE ORIGIN FIX: PDF pages can have non-zero origin (bounds[0], bounds[1]).
  // Without translation, content would be offset and clipped.
  // We translate by (-bounds[0], -bounds[1]) to move the page origin to (0,0),
  // then scale to device coordinates.
  const translateMatrix = mupdf.Matrix.translate(-bounds[0], -bounds[1]);
  const scaleMatrix = mupdf.Matrix.scale(effectiveScale, effectiveScale);
  const matrix = mupdf.Matrix.concat(translateMatrix, scaleMatrix);

  // Render the page through the device
  const startRender = performance.now();
  page.run(device, matrix);
  const renderTime = performance.now() - startRender;

  // Close the device to finalize rendering
  device.close();

  // Encode based on format
  const startEncode = performance.now();
  let outputData: Uint8Array;

  if (format === 'rgba') {
    // Raw RGBA pixels - skip PNG encoding entirely
    // getSamples() returns pixel data in row-major order
    const samples = pixmap.getSamples();
    // Make a copy since the pixmap will be destroyed
    outputData = new Uint8Array(samples);
  } else {
    // Legacy PNG path
    outputData = pixmap.asPNG();
  }
  const encodeTime = performance.now() - startEncode;

  const result = {
    data: outputData,
    width: pixmap.getWidth(),
    height: pixmap.getHeight(),
    format,
    timing: {
      pageLoad: pageLoadTime,
      render: renderTime,
      encode: encodeTime,
      total: performance.now() - startTotal,
    },
  };

  // Clean up resources to prevent memory leaks
  device.destroy();
  pixmap.destroy();
  page.destroy();

  return result;
}

/**
 * Render a specific tile of a page to PNG or raw RGBA bytes
 * Enables CATiledLayer-style partial page rendering for smooth scrolling
 *
 * @param id Document ID
 * @param pageNum Page number (1-indexed)
 * @param tileX Tile X index (0-indexed)
 * @param tileY Tile Y index (0-indexed)
 * @param tileSize Tile size in pixels (typically 256)
 * @param scale Render scale (1 = 72 DPI, 2 = 144 DPI)
 * @param format Output format: 'png' (compressed) or 'rgba' (raw pixels, faster)
 */
function renderTile(
  id: string,
  pageNum: number,
  tileX: number,
  tileY: number,
  tileSize: number,
  scale: number,
  format: RenderFormat = 'png',
  sharedSlot?: SharedBufferSlot
): {
  data: Uint8Array;
  width: number;
  height: number;
  format: RenderFormat;
  timing: WorkerTiming;
  usedSharedBuffer: boolean;
  dataLength?: number;
} {
  const startTotal = performance.now();

  const doc = documents.get(id);
  if (!doc) {
    throw new Error(`Document ${id} not loaded`);
  }

  // MuPDF uses 0-indexed pages
  const startPageLoad = performance.now();
  const page = doc.loadPage(pageNum - 1);
  const pageLoadTime = performance.now() - startPageLoad;

  // Calculate tile region in page coordinates (before scaling)
  // Each tile covers (tileSize/scale) points in page space
  const pageTileSize = tileSize / scale;
  const originX = tileX * pageTileSize;
  const originY = tileY * pageTileSize;

  // Get page bounds to calculate tile dimensions at page edge
  const bounds = page.getBounds();
  const pageWidth = bounds[2] - bounds[0];
  const pageHeight = bounds[3] - bounds[1];

  // DEBUG: Log tile rendering info for first page
  if (pageNum === 1 && tileX <= 2 && tileY === 0) {
    console.log(`[MuPDF Worker] renderTile p${pageNum} t${tileX}x${tileY}: bounds=[${bounds.map((b: number) => b.toFixed(1)).join(', ')}], pageSize=${pageWidth.toFixed(1)}x${pageHeight.toFixed(1)}, origin=(${originX.toFixed(1)}, ${originY.toFixed(1)}), scale=${scale.toFixed(2)}`);
  }

  // Calculate actual tile dimensions in page coordinates (may be smaller at edges)
  const tileWidthPage = Math.min(pageTileSize, pageWidth - originX);
  const tileHeightPage = Math.min(pageTileSize, pageHeight - originY);

  // Skip if tile is outside page bounds
  if (tileWidthPage <= 0 || tileHeightPage <= 0) {
    throw new Error(`Tile (${tileX}, ${tileY}) is outside page bounds`);
  }

  // Calculate output dimensions in device pixels
  // PERF FIX: Cap output dimensions to prevent OOM. At scale 32 with 256px tiles,
  // output would be 8192x8192 = 268MB per tile. Cap to 2048px max dimension.
  // This is still 4x retina quality (512px CSS @ 4x = 2048px).
  const MAX_TILE_OUTPUT_DIM = 2048;

  // ASPECT RATIO FIX (2026-01-23): Derive height from width to preserve exact aspect ratio.
  // For edge tiles, the tile region may not be square, but we must preserve that aspect.
  const tileAspect = tileWidthPage / tileHeightPage;
  const rawOutputWidth = Math.ceil(tileWidthPage * scale);
  const rawOutputHeight = Math.round(rawOutputWidth / tileAspect);

  // If output would exceed max, reduce effective scale
  const dimensionScale = Math.min(
    MAX_TILE_OUTPUT_DIM / rawOutputWidth,
    MAX_TILE_OUTPUT_DIM / rawOutputHeight,
    1.0 // Don't increase scale
  );

  // Apply dimension scale while preserving aspect ratio
  const outputWidth = Math.ceil(rawOutputWidth * dimensionScale);
  const outputHeight = Math.round(outputWidth / tileAspect);
  const effectiveScale = scale * dimensionScale;

  // Create a Pixmap with specific bounding box (in device coordinates)
  // This defines both the output size AND clips the content
  // Bbox: [x0, y0, x1, y1] in device coordinates
  const bbox: [number, number, number, number] = [0, 0, outputWidth, outputHeight];
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);

  // Clear pixmap to white (otherwise it may have garbage data)
  pixmap.clear(255);

  // Create DrawDevice to render into the pixmap
  // The device uses identity matrix - all transformation is in the page.run() call
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);

  // Create transformation matrix:
  // 1. Translate to move tile origin to (0, 0): translate(-originX - bounds[0], -originY - bounds[1])
  // 2. Scale to device coordinates: scale(effectiveScale, effectiveScale)
  //
  // MuPDF Matrix.concat(A, B) = B * A (applies A first, then B)
  // So concat(translate, scale) applies translate first, then scale
  // Note: Uses effectiveScale (capped) instead of raw scale to prevent OOM
  //
  // PAGE ORIGIN FIX: PDF pages can have non-zero origin (bounds[0], bounds[1]).
  // For example, a page with mediabox [10, 10, 622, 802] has origin at (10, 10).
  // Without this fix, tile (0,0) would render from (0,0) instead of (10,10),
  // causing content on the right/bottom edges to be clipped.
  const translateMatrix = mupdf.Matrix.translate(-originX - bounds[0], -originY - bounds[1]);
  const scaleMatrix = mupdf.Matrix.scale(effectiveScale, effectiveScale);
  const matrix = mupdf.Matrix.concat(translateMatrix, scaleMatrix);

  // Run the page through the device - content will be clipped to pixmap bounds
  const startRender = performance.now();
  page.run(device, matrix);
  const renderTime = performance.now() - startRender;

  // Close the device to finalize rendering
  device.close();

  // Encode based on format
  const startEncode = performance.now();
  let outputData: Uint8Array;
  let usedSharedBuffer = false;
  let dataLength = 0;

  if (format === 'rgba') {
    // Raw RGBA pixels - skip PNG encoding entirely
    // getSamples() returns pixel data in row-major order (RGBA for each pixel)
    const samples = pixmap.getSamples();
    dataLength = samples.length;

    // Try to use shared buffer if slot provided
    if (sharedSlot) {
      const sharedView = getSharedBufferView(
        sharedSlot.tierSize,
        sharedSlot.index,
        dataLength
      );

      if (sharedView) {
        // Copy directly into shared buffer (still one copy, but into pre-allocated memory)
        sharedView.set(samples);
        outputData = sharedView;
        usedSharedBuffer = true;
      } else {
        // Fallback: create new array (shared buffer unavailable or too small)
        outputData = new Uint8Array(samples);
      }
    } else {
      // No shared slot provided - use regular copy
      outputData = new Uint8Array(samples);
    }
  } else {
    // Legacy PNG path
    outputData = pixmap.asPNG();
    dataLength = outputData.length;
  }
  const encodeTime = performance.now() - startEncode;

  const result = {
    data: outputData,
    width: outputWidth,
    height: outputHeight,
    format,
    timing: {
      pageLoad: pageLoadTime,
      render: renderTime,
      encode: encodeTime,
      total: performance.now() - startTotal,
    },
    usedSharedBuffer,
    dataLength,
  };

  // Clean up resources to prevent memory leaks
  device.destroy();
  pixmap.destroy();
  page.destroy();

  return result;
}

/**
 * Extract text layer with character positions
 */
function getTextLayer(id: string, pageNum: number): TextLayerData {
  const doc = documents.get(id);
  if (!doc) {
    throw new Error(`Document ${id} not loaded`);
  }

  const page = doc.loadPage(pageNum - 1);
  const bounds = page.getBounds();
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];

  // Get structured text
  const stext = page.toStructuredText('preserve-whitespace');

  const items: TextItem[] = [];
  let currentItem: TextItem | null = null;
  let currentLine: { chars: CharPosition[]; bbox: MuPDFTypes.Rect } | null = null;

  // Walk through structured text to extract character positions
  stext.walk({
    beginLine(bbox: MuPDFTypes.Rect, _wmode: number, _direction: MuPDFTypes.Point) {
      currentLine = { chars: [], bbox };
    },

    onChar(
      c: string,
      origin: MuPDFTypes.Point,
      font: MuPDFTypes.Font,
      size: number,
      quad: MuPDFTypes.Quad,
      _color: MuPDFTypes.Color
    ) {
      if (!currentLine) return;

      // Quad format: [ul_x, ul_y, ur_x, ur_y, lr_x, lr_y, ll_x, ll_y]
      const charX = Math.min(quad[0], quad[6]); // min of ul_x and ll_x
      const charY = Math.min(quad[1], quad[3]); // min of ul_y and ur_y
      const charWidth = Math.abs(quad[2] - quad[0]); // ur_x - ul_x
      const charHeight = Math.abs(quad[5] - quad[1]); // lr_y - ul_y

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

      // Convert line to TextItem
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

  // EPUB Fallback: If walk() returned no items (common for EPUB documents),
  // try using asText() or asHTML() as alternative extraction methods.
  // MuPDF's structured text walk doesn't work the same for EPUBs as PDFs.
  let htmlContent = '';
  let textContent = '';
  if (items.length === 0) {
    try {
      // Try asText() first - plain text extraction
      textContent = stext.asText();

      // Try asHTML() for structured content
      // The parameter is an ID for reference purposes
      htmlContent = stext.asHTML(pageNum);

      console.log(`[MuPDF Worker] EPUB fallback extraction: text=${textContent.length} chars, html=${htmlContent.length} chars`);
    } catch (e) {
      console.warn('[MuPDF Worker] EPUB fallback extraction failed:', e);
    }
  }

  // Clean up resources to prevent memory leaks
  stext.destroy();
  page.destroy();

  return {
    pageNum,
    width,
    height,
    items,
    // Include fallback content for EPUB documents
    textContent: textContent || undefined,
    htmlContent: htmlContent || undefined,
  };
}

/**
 * Search document for text
 */
function searchDocument(
  id: string,
  query: string,
  maxHits: number
): SearchResult[] {
  const doc = documents.get(id);
  if (!doc) {
    throw new Error(`Document ${id} not loaded`);
  }

  const results: SearchResult[] = [];
  const pageCount = doc.countPages();
  let remaining = maxHits;

  for (let i = 0; i < pageCount && remaining > 0; i++) {
    const page = doc.loadPage(i);
    const quads = page.search(query, remaining);

    for (const quadArray of quads) {
      if (remaining <= 0) break;

      const rects = quadArray.map((quad: MuPDFTypes.Quad) => {
        // Convert quad to bounding box
        // Quad format: [ul_x, ul_y, ur_x, ur_y, lr_x, lr_y, ll_x, ll_y]
        const x = Math.min(quad[0], quad[6]);
        const y = Math.min(quad[1], quad[3]);
        const width = Math.max(quad[2], quad[4]) - x;
        const height = Math.max(quad[5], quad[7]) - y;
        return { x, y, width, height };
      });

      results.push({
        page: i + 1, // 1-indexed
        text: query,
        quads: rects,
      });

      remaining--;
    }

    // Clean up page to prevent memory leaks
    page.destroy();
  }

  return results;
}

/**
 * Get page dimensions
 */
function getPageDimensions(
  id: string,
  pageNum: number
): { width: number; height: number } {
  const doc = documents.get(id);
  if (!doc) {
    throw new Error(`Document ${id} not loaded`);
  }

  const page = doc.loadPage(pageNum - 1);
  const bounds = page.getBounds();

  const result = {
    width: bounds[2] - bounds[0],
    height: bounds[3] - bounds[1],
  };

  // Clean up page to prevent memory leaks
  page.destroy();

  return result;
}

/**
 * Unload a document
 */
function unloadDocument(id: string): void {
  const doc = documents.get(id);
  if (doc) {
    try {
      doc.destroy?.();
    } catch {
      // Ignore destroy errors
    }
    documents.delete(id);
  }
}

/**
 * Classify a page by content type
 * Uses MuPDF's PDFObject API for structure analysis and custom Device for operator counting
 */
function classifyPageContent(
  id: string,
  pageNum: number
): PageClassification {
  const startTime = performance.now();

  const doc = documents.get(id);
  if (!doc) {
    throw new Error(`Document ${id} not loaded`);
  }

  // Check if document is a PDF (has PDF-specific methods)
  const pdfDoc = doc.asPDF?.();
  if (!pdfDoc) {
    // Not a PDF, return UNKNOWN
    return {
      type: 'unknown' as PDFContentType,
      confidence: 0,
      classificationTimeMs: performance.now() - startTime,
      hasTransparency: false,
      pageNum,
    };
  }

  const page = pdfDoc.loadPage(pageNum - 1);
  const bounds = page.getBounds();
  const pageWidth = bounds[2] - bounds[0];
  const pageHeight = bounds[3] - bounds[1];

  const result: PageClassification = {
    type: 'unknown' as PDFContentType,
    confidence: 0,
    classificationTimeMs: 0,
    hasTransparency: false,
    pageNum,
  };

  try {
    // Get page object for structure analysis
    const pageObj = page.getObject();

    // Step 1: Analyze images (XObjects)
    const images = analyzePageImagesInternal(pageObj, pageWidth, pageHeight);
    result.images = images;

    // Debug: Log classification image analysis
    console.log(`[MuPDF Worker] classifyPageContent page ${pageNum}: images found:`, JSON.stringify(images.map(i => ({
      name: i.name,
      filter: i.filter,
      coverage: i.coverageRatio.toFixed(2),
      hasSoftMask: i.hasSoftMask
    }))));

    // Step 2: Check for scanned page (single large image)
    if (images.length === 1) {
      const image = images[0];
      if (image.coverageRatio >= 0.85 && !image.hasSoftMask) {
        if (image.filter === 'DCTDecode') {
          result.type = 'scanned-jpeg' as PDFContentType;
          result.confidence = 0.95;
          result.classificationTimeMs = performance.now() - startTime;
          page.destroy();
          return result;
        } else {
          result.type = 'scanned-other' as PDFContentType;
          result.confidence = 0.9;
          result.classificationTimeMs = performance.now() - startTime;
          page.destroy();
          return result;
        }
      }
    }

    // Step 3: Check for transparency
    result.hasTransparency = detectTransparencyInternal(pageObj);

    // Step 4: Count operators using custom device
    const counts = countOperatorsInternal(page);
    result.operatorCounts = counts;

    // Step 5: Classify based on operator distribution
    const { text, path, total } = counts;

    // Complex: high total ops or transparency
    if (total > 5000 || result.hasTransparency) {
      result.type = 'complex' as PDFContentType;
      result.confidence = 0.85;
    }
    // Vector heavy: dominated by path operations
    else if (path >= 500 && path / total >= 0.7) {
      result.type = 'vector-heavy' as PDFContentType;
      result.confidence = 0.9;
    }
    // Text heavy: dominated by text operations
    else if (text >= 300 && text / total >= 0.7) {
      result.type = 'text-heavy' as PDFContentType;
      result.confidence = 0.9;
    }
    // Mixed: balanced content
    else {
      result.type = 'mixed' as PDFContentType;
      result.confidence = 0.8;
    }

    page.destroy();
  } catch (error) {
    console.warn(`[MuPDF Worker] Failed to classify page ${pageNum}:`, error);
    result.type = 'unknown' as PDFContentType;
    result.confidence = 0;
    try { page.destroy(); } catch { /* ignore */ }
  }

  result.classificationTimeMs = performance.now() - startTime;
  return result;
}

/**
 * Internal: Analyze XObjects on a page to find images
 */
function analyzePageImagesInternal(
  pageObj: MuPDFTypes.PDFObject,
  pageWidth: number,
  pageHeight: number
): PageImageInfo[] {
  const images: PageImageInfo[] = [];

  try {
    const resources = pageObj.get('Resources');
    if (!resources || resources.isNull()) return images;

    const xobjects = resources.get('XObject');
    if (!xobjects || xobjects.isNull() || !xobjects.isDictionary()) return images;

    xobjects.forEach((xobj: MuPDFTypes.PDFObject, name: string | number) => {
      try {
        const resolved = xobj.resolve();
        if (!resolved || !resolved.isDictionary()) return;

        const subtype = resolved.get('Subtype');
        if (!subtype || subtype.asName() !== 'Image') return;

        const width = resolved.get('Width')?.asNumber() || 0;
        const height = resolved.get('Height')?.asNumber() || 0;
        const bpc = resolved.get('BitsPerComponent')?.asNumber() || 8;

        let colorSpace = 'Unknown';
        const cs = resolved.get('ColorSpace');
        if (cs) {
          if (cs.isName()) {
            colorSpace = cs.asName();
          } else if (cs.isArray() && cs.length > 0) {
            const csName = cs.get(0);
            if (csName?.isName()) {
              colorSpace = csName.asName();
            }
          }
        }

        // Parse filter
        let filter: string = 'Unknown';
        const filterObj = resolved.get('Filter');
        if (filterObj) {
          if (filterObj.isName()) {
            filter = filterObj.asName().replace('/', '');
          } else if (filterObj.isArray() && filterObj.length > 0) {
            const firstFilter = filterObj.get(0);
            if (firstFilter?.isName()) {
              filter = firstFilter.asName().replace('/', '');
            }
          }
        }

        const hasSoftMask = resolved.get('SMask') !== null && !resolved.get('SMask')?.isNull();
        const hasMask = resolved.get('Mask') !== null && !resolved.get('Mask')?.isNull();

        // Estimate coverage
        const widthRatio = width / (pageWidth * 72 / 72);
        const heightRatio = height / (pageHeight * 72 / 72);
        const coverageRatio = Math.min(1, Math.max(widthRatio, heightRatio) * Math.min(widthRatio, heightRatio));

        images.push({
          name: String(name),
          width,
          height,
          bitsPerComponent: bpc,
          colorSpace,
          filter: filter as PageImageInfo['filter'],
          hasSoftMask,
          hasMask,
          coverageRatio,
        });
      } catch {
        // Ignore errors for individual XObjects
      }
    });
  } catch {
    // Ignore errors in image analysis
  }

  return images;
}

/**
 * Internal: Check if page has transparency indicators
 */
function detectTransparencyInternal(pageObj: MuPDFTypes.PDFObject): boolean {
  try {
    const resources = pageObj.get('Resources');
    if (!resources || resources.isNull()) return false;

    const extGState = resources.get('ExtGState');
    if (!extGState || extGState.isNull() || !extGState.isDictionary()) return false;

    let hasTransparency = false;

    extGState.forEach((gs: MuPDFTypes.PDFObject) => {
      try {
        const resolved = gs.resolve();
        if (!resolved || !resolved.isDictionary()) return;

        const ca = resolved.get('ca');
        const CA = resolved.get('CA');
        const SMask = resolved.get('SMask');
        const BM = resolved.get('BM');

        if (ca && ca.asNumber() < 1) hasTransparency = true;
        if (CA && CA.asNumber() < 1) hasTransparency = true;
        if (SMask && !SMask.isNull()) hasTransparency = true;
        if (BM && BM.asName() !== 'Normal') hasTransparency = true;
      } catch {
        // Ignore errors
      }
    });

    return hasTransparency;
  } catch {
    return false;
  }
}

/**
 * Internal: Count operators using custom device
 */
function countOperatorsInternal(page: MuPDFTypes.Page): OperatorCounts {
  const counts: OperatorCounts = {
    text: 0,
    path: 0,
    image: 0,
    graphicsState: 0,
    color: 0,
    clipping: 0,
    total: 0,
  };

  try {
    const device = new mupdf.Device({
      fillText: () => { counts.text++; counts.total++; },
      strokeText: () => { counts.text++; counts.total++; },
      clipText: () => { counts.text++; counts.total++; },
      clipStrokeText: () => { counts.text++; counts.total++; },
      ignoreText: () => { counts.text++; counts.total++; },
      fillPath: () => { counts.path++; counts.total++; },
      strokePath: () => { counts.path++; counts.total++; },
      clipPath: () => { counts.path++; counts.clipping++; counts.total++; },
      clipStrokePath: () => { counts.path++; counts.clipping++; counts.total++; },
      fillImage: () => { counts.image++; counts.total++; },
      fillImageMask: () => { counts.image++; counts.total++; },
      clipImageMask: () => { counts.image++; counts.clipping++; counts.total++; },
      fillShade: () => { counts.path++; counts.total++; },
      beginGroup: () => { counts.graphicsState++; counts.total++; },
      endGroup: () => { counts.graphicsState++; counts.total++; },
      beginMask: () => { counts.graphicsState++; counts.total++; },
      endMask: () => { counts.graphicsState++; counts.total++; },
      popClip: () => { counts.clipping++; counts.total++; },
      beginTile: () => { counts.graphicsState++; counts.total++; return 0; },
      endTile: () => { counts.graphicsState++; counts.total++; },
      beginLayer: () => { counts.graphicsState++; counts.total++; },
      endLayer: () => { counts.graphicsState++; counts.total++; },
    });

    page.run(device, mupdf.Matrix.identity);
    device.close();
    device.destroy();
  } catch (error) {
    console.warn('[MuPDF Worker] Error counting operators:', error);
  }

  return counts;
}

/**
 * Extract JPEG data directly from a scanned page
 * Only works for pages with a single DCTDecode image.
 * Uses the same analyzePageImagesInternal function as classification
 * to ensure consistency in image detection.
 */
function extractJpegFromPage(
  id: string,
  pageNum: number
): { data: Uint8Array; width: number; height: number } {
  const doc = documents.get(id);
  if (!doc) {
    throw new Error(`Document ${id} not loaded`);
  }

  const pdfDoc = doc.asPDF?.();
  if (!pdfDoc) {
    throw new Error('Document is not a PDF');
  }

  const page = pdfDoc.loadPage(pageNum - 1);
  const bounds = page.getBounds();
  const pageWidth = bounds[2] - bounds[0];
  const pageHeight = bounds[3] - bounds[1];

  try {
    const pageObj = page.getObject();

    // Use the same image analysis as classification to find the image
    const images = analyzePageImagesInternal(pageObj, pageWidth, pageHeight);

    // Find the DCTDecode image
    const jpegImage = images.find(img => img.filter === 'DCTDecode');
    if (!jpegImage) {
      throw new Error(`No JPEG image found on page ${pageNum}. Images found: ${JSON.stringify(images.map(i => ({ name: i.name, filter: i.filter, coverage: i.coverageRatio.toFixed(2) })))}`);
    }

    // Get the XObjects and find the image by iterating (like analyzePageImagesInternal)
    // This preserves the stream property that gets lost with xobjects.get().resolve()
    const resources = pageObj.get('Resources');
    if (!resources) throw new Error('No resources found');

    const xobjects = resources.get('XObject');
    if (!xobjects) throw new Error('No XObjects found');

    // Find the image by iterating - forEach gives us the actual stream object
    let foundImageObj: MuPDFTypes.PDFObject | null = null;
    let foundImageWidth = 0;
    let foundImageHeight = 0;

    xobjects.forEach((xobj: MuPDFTypes.PDFObject, name: string | number) => {
      if (String(name) === jpegImage.name) {
        foundImageObj = xobj;
        // Get dimensions from the object
        const resolved = xobj.resolve();
        if (resolved) {
          foundImageWidth = resolved.get('Width')?.asNumber() || 0;
          foundImageHeight = resolved.get('Height')?.asNumber() || 0;
        }
      }
    });

    if (!foundImageObj) {
      throw new Error(`Image ${jpegImage.name} not found in XObjects via forEach`);
    }

    // Try multiple approaches to read the stream
    try {
      // Approach 1: Try reading raw stream directly from the object (without resolve)
      let buffer: MuPDFTypes.Buffer | null = null;
      let streamSource = 'direct';

      try {
        buffer = (foundImageObj as MuPDFTypes.PDFObject).readRawStream();
      } catch {
        // Approach 2: Try reading from resolved object
        streamSource = 'resolved';
        const resolved = (foundImageObj as MuPDFTypes.PDFObject).resolve();
        if (resolved?.isStream?.()) {
          buffer = resolved.readRawStream();
        } else if (resolved?.readRawStream) {
          buffer = resolved.readRawStream();
        }
      }

      if (!buffer) {
        const resolved = (foundImageObj as MuPDFTypes.PDFObject).resolve();
        throw new Error(`Could not read stream. isStream=${(foundImageObj as MuPDFTypes.PDFObject).isStream?.()}, resolvedIsStream=${resolved?.isStream?.()}, resolvedIsDictionary=${resolved?.isDictionary?.()}`);
      }

      const data = buffer.asUint8Array();
      const jpegData = new Uint8Array(data);
      buffer.destroy();
      page.destroy();

      console.log(`[MuPDF Worker] JPEG extracted from ${jpegImage.name} via ${streamSource}: ${jpegData.length} bytes, ${foundImageWidth}x${foundImageHeight}`);
      return { data: jpegData, width: foundImageWidth, height: foundImageHeight };
    } catch (streamError) {
      page.destroy();
      throw new Error(`Failed to read JPEG stream for ${jpegImage.name}: ${streamError instanceof Error ? streamError.message : String(streamError)}`);
    }
  } catch (error) {
    page.destroy();
    throw error;
  }
}

/**
 * Handle regular PDF operation requests.
 * Only called after mupdf is initialized.
 */
function handleRequest(request: WorkerRequest): void {
  try {
    switch (request.type) {
      case 'LOAD_DOCUMENT': {
        const { pageCount, toc } = loadDocument(request.docId, request.data);
        self.postMessage({
          type: 'LOADED',
          requestId: request.requestId,
          pageCount,
          toc,
          success: true,
        } as WorkerResponse);
        break;
      }

      case 'INIT_SHARED_BUFFERS': {
        const result = initializeSharedBuffers(request.buffers);
        self.postMessage({
          type: 'SHARED_BUFFERS_INITIALIZED',
          requestId: request.requestId,
          success: result.success,
          tierSizes: result.tierSizes,
        } as WorkerResponse);
        break;
      }

      case 'RENDER_PAGE': {
        const format = request.format ?? 'png';
        const { data, width, height, format: outputFormat, timing } = renderPage(
          request.docId,
          request.pageNum,
          request.scale,
          format
        );
        const message: WorkerResponse = {
          type: 'PAGE_RENDERED',
          requestId: request.requestId,
          pageNum: request.pageNum,
          data,
          width,
          height,
          format: outputFormat,
          timing,
        };
        (self.postMessage as (message: unknown, transfer: Transferable[]) => void)(
          message,
          [data.buffer as ArrayBuffer]
        );
        break;
      }

      case 'RENDER_TILE': {
        const format = request.format ?? 'png';
        const result = renderTile(
          request.docId,
          request.pageNum,
          request.tileX,
          request.tileY,
          request.tileSize,
          request.scale,
          format,
          request.sharedSlot
        );

        if (result.usedSharedBuffer && request.sharedSlot) {
          // Shared buffer path: data is already in shared memory, no transfer needed
          const message: WorkerResponse = {
            type: 'TILE_RENDERED_SHARED',
            requestId: request.requestId,
            pageNum: request.pageNum,
            tileX: request.tileX,
            tileY: request.tileY,
            sharedSlot: request.sharedSlot,
            dataLength: result.dataLength!,
            width: result.width,
            height: result.height,
            format: result.format,
            timing: result.timing,
          };
          self.postMessage(message);
        } else {
          // Regular path: transfer the buffer
          const message: WorkerResponse = {
            type: 'TILE_RENDERED',
            requestId: request.requestId,
            pageNum: request.pageNum,
            tileX: request.tileX,
            tileY: request.tileY,
            data: result.data,
            width: result.width,
            height: result.height,
            format: result.format,
            timing: result.timing,
          };
          (self.postMessage as (message: unknown, transfer: Transferable[]) => void)(
            message,
            [result.data.buffer as ArrayBuffer]
          );
        }
        break;
      }

      case 'GET_TEXT_LAYER': {
        const textLayer = getTextLayer(request.docId, request.pageNum);
        self.postMessage({
          type: 'TEXT_LAYER',
          requestId: request.requestId,
          pageNum: request.pageNum,
          data: textLayer,
        } as WorkerResponse);
        break;
      }

      case 'SEARCH': {
        const results = searchDocument(request.docId, request.query, request.maxHits);
        self.postMessage({
          type: 'SEARCH_RESULTS',
          requestId: request.requestId,
          results,
        } as WorkerResponse);
        break;
      }

      case 'GET_PAGE_COUNT': {
        const doc = documents.get(request.docId);
        if (!doc) {
          throw new Error(`Document ${request.docId} not loaded`);
        }
        self.postMessage({
          type: 'PAGE_COUNT',
          requestId: request.requestId,
          pageCount: doc.countPages(),
        } as WorkerResponse);
        break;
      }

      case 'GET_PAGE_DIMENSIONS': {
        const dims = getPageDimensions(request.docId, request.pageNum);
        self.postMessage({
          type: 'PAGE_DIMENSIONS',
          requestId: request.requestId,
          pageNum: request.pageNum,
          ...dims,
        } as WorkerResponse);
        break;
      }

      case 'CLASSIFY_PAGE': {
        console.log(`[MuPDF Worker] CLASSIFY_PAGE received: docId=${request.docId}, pageNum=${request.pageNum}, requestId=${request.requestId}`);
        console.log(`[MuPDF Worker] Documents loaded:`, Array.from(documents.keys()));
        const classification = classifyPageContent(request.docId, request.pageNum);
        console.log(`[MuPDF Worker] Classification complete:`, classification.type, `confidence=${classification.confidence}`);
        self.postMessage({
          type: 'PAGE_CLASSIFIED',
          requestId: request.requestId,
          pageNum: request.pageNum,
          classification,
        } as WorkerResponse);
        console.log(`[MuPDF Worker] PAGE_CLASSIFIED response sent`);
        break;
      }

      case 'CLASSIFY_PAGES': {
        const classifications = request.pageNums.map(pageNum => ({
          pageNum,
          classification: classifyPageContent(request.docId, pageNum),
        }));
        self.postMessage({
          type: 'PAGES_CLASSIFIED',
          requestId: request.requestId,
          classifications,
        } as WorkerResponse);
        break;
      }

      case 'EXTRACT_JPEG': {
        const { data, width, height } = extractJpegFromPage(request.docId, request.pageNum);
        const message: WorkerResponse = {
          type: 'JPEG_EXTRACTED',
          requestId: request.requestId,
          pageNum: request.pageNum,
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

      case 'UNLOAD_DOCUMENT': {
        unloadDocument(request.docId);
        self.postMessage({
          type: 'DOCUMENT_UNLOADED',
          requestId: request.requestId,
        } as WorkerResponse);
        break;
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    switch (request.type) {
      case 'LOAD_DOCUMENT':
        self.postMessage({
          type: 'LOAD_ERROR',
          requestId: request.requestId,
          error: errorMessage,
          success: false,
        } as WorkerResponse);
        break;

      case 'RENDER_PAGE':
        self.postMessage({
          type: 'RENDER_ERROR',
          requestId: request.requestId,
          pageNum: request.pageNum,
          error: errorMessage,
        } as WorkerResponse);
        break;

      case 'RENDER_TILE':
        self.postMessage({
          type: 'TILE_RENDER_ERROR',
          requestId: request.requestId,
          pageNum: request.pageNum,
          tileX: request.tileX,
          tileY: request.tileY,
          error: errorMessage,
        } as WorkerResponse);
        break;

      case 'GET_TEXT_LAYER':
        self.postMessage({
          type: 'TEXT_LAYER_ERROR',
          requestId: request.requestId,
          pageNum: request.pageNum,
          error: errorMessage,
        } as WorkerResponse);
        break;

      case 'SEARCH':
        self.postMessage({
          type: 'SEARCH_ERROR',
          requestId: request.requestId,
          error: errorMessage,
        } as WorkerResponse);
        break;

      case 'GET_PAGE_COUNT':
        self.postMessage({
          type: 'PAGE_COUNT_ERROR',
          requestId: request.requestId,
          error: errorMessage,
        } as WorkerResponse);
        break;

      case 'GET_PAGE_DIMENSIONS':
        self.postMessage({
          type: 'PAGE_DIMENSIONS_ERROR',
          requestId: request.requestId,
          pageNum: request.pageNum,
          error: errorMessage,
        } as WorkerResponse);
        break;

      case 'CLASSIFY_PAGE':
        self.postMessage({
          type: 'CLASSIFY_ERROR',
          requestId: request.requestId,
          pageNum: request.pageNum,
          error: errorMessage,
        } as WorkerResponse);
        break;

      case 'CLASSIFY_PAGES':
        self.postMessage({
          type: 'CLASSIFY_ERROR',
          requestId: request.requestId,
          pageNum: 0, // Batch classification error
          error: errorMessage,
        } as WorkerResponse);
        break;

      case 'EXTRACT_JPEG':
        self.postMessage({
          type: 'JPEG_EXTRACT_ERROR',
          requestId: request.requestId,
          pageNum: request.pageNum,
          error: errorMessage,
        } as WorkerResponse);
        break;

      case 'UNLOAD_DOCUMENT':
        self.postMessage({
          type: 'UNLOAD_ERROR',
          requestId: request.requestId,
          error: errorMessage,
        } as WorkerResponse);
        break;

      default:
        console.error('[MuPDF Worker] Error:', errorMessage);
    }
  }
}

/**
 * Initialize the worker by waiting for WASM binary from main thread,
 * then dynamically importing mupdf.
 */
async function initializeWorker(): Promise<void> {
  // Wait for WASM binary from main thread
  // The esbuild banner sets up $libmupdf_wasm_Module and __MUPDF_WASM_READY__
  const wasmReady = (globalThis as Record<string, unknown>).__MUPDF_WASM_READY__ as Promise<void>;
  await wasmReady;

  // Now dynamically import mupdf - it will use the wasmBinary we provided
  // @ts-ignore - mupdf types are available but moduleResolution needs bundler
  mupdf = await import('mupdf');

  // Set up message handler for regular requests
  self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    handleRequest(event.data);
  };

  // Signal worker is ready
  self.postMessage({ type: 'READY' });
}

// Start initialization
initializeWorker().catch((error) => {
  console.error('[MuPDF Worker] Initialization failed:', error);
  self.postMessage({ type: 'INIT_ERROR', error: String(error) });
});

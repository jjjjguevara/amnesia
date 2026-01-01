/**
 * PDF.js Provider
 *
 * Client-side PDF rendering fallback using PDF.js.
 * Used when the server is unavailable or for offline rendering.
 *
 * @example
 * ```typescript
 * import { PdfJsProvider } from './pdfjs-provider';
 *
 * const provider = new PdfJsProvider();
 * await provider.loadDocument(pdfData);
 *
 * const pageImage = await provider.renderPage(1, { scale: 1.5 });
 * const textLayer = await provider.getTextLayer(1);
 * ```
 */

import type {
  PdfMetadata,
  PdfTextLayerData,
  PdfTextItem,
  PdfCharPosition,
  ParsedPdf,
  TocEntry,
  PdfRenderOptions,
  PdfSearchResult,
} from '../types';

// Types for PDF.js (any since it may not be available)
type PDFDocumentProxy = any;
type PDFPageProxy = any;

// Lazy-loaded pdfjs-dist module
let pdfjsLib: any = null;
let pdfjsInitialized = false;

/**
 * Initialize PDF.js library lazily
 */
async function initPdfJs(): Promise<any> {
  if (pdfjsLib) return pdfjsLib;

  try {
    // @ts-ignore - dynamic import
    pdfjsLib = await import('pdfjs-dist');

    // Initialize PDF.js worker
    if (typeof window !== 'undefined' && !pdfjsInitialized) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
      pdfjsInitialized = true;
    }

    return pdfjsLib;
  } catch (e) {
    console.warn('[PdfJsProvider] pdfjs-dist not available:', e);
    throw new Error('PDF.js library is not available');
  }
}

/**
 * Provider status
 */
export interface PdfJsProviderStatus {
  isLoaded: boolean;
  pageCount: number;
  hasTextLayer: boolean;
  documentId: string | null;
}

/**
 * PDF.js-based provider for client-side PDF rendering
 */
export class PdfJsProvider {
  private document: PDFDocumentProxy | null = null;
  private documentId: string | null = null;
  private pageCache: Map<string, HTMLCanvasElement> = new Map();
  private textLayerCache: Map<number, PdfTextLayerData> = new Map();

  /**
   * Get provider status
   */
  getStatus(): PdfJsProviderStatus {
    return {
      isLoaded: this.document !== null,
      pageCount: this.document?.numPages ?? 0,
      hasTextLayer: true, // PDF.js always provides text layer if available
      documentId: this.documentId,
    };
  }

  /**
   * Load a PDF document from ArrayBuffer
   */
  async loadDocument(data: ArrayBuffer, documentId?: string): Promise<ParsedPdf> {
    // Initialize PDF.js library
    const pdfjs = await initPdfJs();

    // Close existing document
    if (this.document) {
      await this.destroy();
    }

    // Load the document
    const loadingTask = pdfjs.getDocument({ data });
    this.document = await loadingTask.promise;
    this.documentId = documentId ?? `pdf-${Date.now()}`;

    // Extract metadata
    const metadata = await this.extractMetadata();
    const toc = await this.extractOutline();
    const hasTextLayer = await this.checkTextLayer();

    return {
      id: this.documentId,
      metadata,
      toc,
      pageCount: this.document.numPages,
      pageLabels: undefined,
      hasTextLayer,
      orientation: await this.determineOrientation(),
    };
  }

  /**
   * Load a PDF document from URL
   */
  async loadDocumentFromUrl(url: string, documentId?: string): Promise<ParsedPdf> {
    // Initialize PDF.js library
    const pdfjs = await initPdfJs();

    // Close existing document
    if (this.document) {
      await this.destroy();
    }

    // Load the document
    const loadingTask = pdfjs.getDocument(url);
    this.document = await loadingTask.promise;
    this.documentId = documentId ?? url.split('/').pop() ?? `pdf-${Date.now()}`;

    // Extract metadata
    const metadata = await this.extractMetadata();
    const toc = await this.extractOutline();
    const hasTextLayer = await this.checkTextLayer();

    return {
      id: this.documentId,
      metadata,
      toc,
      pageCount: this.document.numPages,
      pageLabels: undefined,
      hasTextLayer,
      orientation: await this.determineOrientation(),
    };
  }

  /**
   * Render a page to a canvas/blob
   */
  async renderPage(
    pageNumber: number,
    options?: PdfRenderOptions
  ): Promise<Blob> {
    if (!this.document) {
      throw new Error('No document loaded');
    }

    const scale = options?.scale ?? 1.5;
    const rotation = options?.rotation ?? 0;
    const format = options?.format ?? 'png';

    // Check cache
    const cacheKey = `${pageNumber}-${scale}-${rotation}-${format}`;
    const cachedCanvas = this.pageCache.get(cacheKey);
    if (cachedCanvas) {
      return this.canvasToBlob(cachedCanvas, format);
    }

    // Get the page
    const page = await this.document.getPage(pageNumber);
    const viewport = page.getViewport({ scale, rotation });

    // Create canvas
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    // Render
    await page.render({
      canvasContext: context,
      viewport,
    }).promise;

    // Cache the canvas (limit cache size)
    if (this.pageCache.size > 20) {
      const firstKey = this.pageCache.keys().next().value;
      if (firstKey) this.pageCache.delete(firstKey);
    }
    this.pageCache.set(cacheKey, canvas);

    return this.canvasToBlob(canvas, format);
  }

  /**
   * Render page directly to a provided canvas element
   */
  async renderPageToCanvas(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    options?: PdfRenderOptions
  ): Promise<void> {
    if (!this.document) {
      throw new Error('No document loaded');
    }

    const scale = options?.scale ?? 1.5;
    const rotation = options?.rotation ?? 0;

    const page = await this.document.getPage(pageNumber);
    const viewport = page.getViewport({ scale, rotation });

    const context = canvas.getContext('2d')!;
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvasContext: context,
      viewport,
    }).promise;
  }

  /**
   * Get text layer for a page
   */
  async getTextLayer(pageNumber: number): Promise<PdfTextLayerData> {
    if (!this.document) {
      throw new Error('No document loaded');
    }

    // Check cache
    const cached = this.textLayerCache.get(pageNumber);
    if (cached) {
      return cached;
    }

    const page = await this.document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();

    const items: PdfTextItem[] = [];

    for (const item of textContent.items as any[]) {
      if (!('str' in item)) continue;
      const textItem = item as any;

      if (!textItem.str.trim()) continue;

      // Transform coordinates
      const transform = textItem.transform;
      const x = transform[4];
      const y = viewport.height - transform[5];
      const width = textItem.width;
      const height = textItem.height;

      // Create character positions (approximate)
      const charPositions: PdfCharPosition[] = [];
      const charCount = textItem.str.length;
      if (charCount > 0) {
        const charWidth = width / charCount;
        for (let i = 0; i < charCount; i++) {
          charPositions.push({
            char: textItem.str[i],
            x: x + i * charWidth,
            width: charWidth,
          });
        }
      }

      items.push({
        text: textItem.str,
        x,
        y,
        width,
        height,
        fontSize: Math.abs(transform[0]),
        charPositions: charPositions.length > 0 ? charPositions : undefined,
      });
    }

    const layer: PdfTextLayerData = {
      page: pageNumber,
      width: viewport.width,
      height: viewport.height,
      items,
    };

    // Cache the layer
    this.textLayerCache.set(pageNumber, layer);

    return layer;
  }

  /**
   * Get page dimensions
   */
  async getPageDimensions(pageNumber: number): Promise<{ width: number; height: number }> {
    if (!this.document) {
      throw new Error('No document loaded');
    }

    const page = await this.document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });

    return {
      width: viewport.width,
      height: viewport.height,
    };
  }

  /**
   * Search for text across all pages
   */
  async search(query: string, limit: number = 50): Promise<PdfSearchResult[]> {
    if (!this.document) {
      throw new Error('No document loaded');
    }

    const results: PdfSearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (let pageNum = 1; pageNum <= this.document.numPages && results.length < limit; pageNum++) {
      const page = await this.document.getPage(pageNum);
      const textContent = await page.getTextContent();

      const fullText = (textContent.items as any[])
        .filter((item: any) => 'str' in item)
        .map((item: any) => item.str as string)
        .join(' ');

      const fullTextLower = fullText.toLowerCase();
      let start = 0;

      while (results.length < limit) {
        const pos = fullTextLower.indexOf(queryLower, start);
        if (pos === -1) break;

        const matchedText = fullText.substring(pos, pos + query.length);
        const prefixStart = Math.max(0, pos - 32);
        const suffixEnd = Math.min(fullText.length, pos + query.length + 32);

        results.push({
          page: pageNum,
          text: matchedText,
          prefix: pos > 0 ? fullText.substring(prefixStart, pos) : undefined,
          suffix: pos + query.length < fullText.length
            ? fullText.substring(pos + query.length, suffixEnd)
            : undefined,
        });

        start = pos + query.length;
      }
    }

    return results;
  }

  /**
   * Get page count
   */
  getPageCount(): number {
    return this.document?.numPages ?? 0;
  }

  /**
   * Destroy the provider and release resources
   */
  async destroy(): Promise<void> {
    if (this.document) {
      await this.document.destroy();
      this.document = null;
    }
    this.documentId = null;
    this.pageCache.clear();
    this.textLayerCache.clear();
  }

  // Private methods

  private async extractMetadata(): Promise<PdfMetadata> {
    if (!this.document) {
      throw new Error('No document loaded');
    }

    try {
      const metadata = await this.document.getMetadata();
      const info = metadata.info as Record<string, unknown>;

      return {
        title: (info?.Title as string) ?? this.documentId ?? 'Unknown',
        author: (info?.Author as string) ?? undefined,
        subject: (info?.Subject as string) ?? undefined,
        keywords: ((info?.Keywords as string) ?? '')
          .split(',')
          .map(k => k.trim())
          .filter(k => k.length > 0),
        creator: (info?.Creator as string) ?? undefined,
        producer: (info?.Producer as string) ?? undefined,
        creationDate: (info?.CreationDate as string) ?? undefined,
        modificationDate: (info?.ModDate as string) ?? undefined,
      };
    } catch {
      return {
        title: this.documentId ?? 'Unknown',
        keywords: [],
      };
    }
  }

  private async extractOutline(): Promise<TocEntry[]> {
    if (!this.document) {
      return [];
    }

    try {
      const outline = await this.document.getOutline();
      if (!outline) return [];

      return this.convertOutline(outline);
    } catch {
      return [];
    }
  }

  private convertOutline(items: any[], prefix = ''): TocEntry[] {
    return items.map((item, index) => ({
      id: `${prefix}${index}`,
      label: item.title || 'Untitled',
      href: item.dest ? `page:${item.dest}` : '#',
      children: item.items ? this.convertOutline(item.items, `${prefix}${index}-`) : [],
    }));
  }

  private async checkTextLayer(): Promise<boolean> {
    if (!this.document) return false;

    try {
      const page = await this.document.getPage(1);
      const textContent = await page.getTextContent();
      return textContent.items.length > 0;
    } catch {
      return false;
    }
  }

  private async determineOrientation(): Promise<'portrait' | 'landscape' | 'mixed'> {
    if (!this.document) return 'portrait';

    let portrait = 0;
    let landscape = 0;

    const pagesToCheck = Math.min(this.document.numPages, 10);

    for (let i = 1; i <= pagesToCheck; i++) {
      const page = await this.document.getPage(i);
      const viewport = page.getViewport({ scale: 1 });

      if (viewport.width > viewport.height) {
        landscape++;
      } else {
        portrait++;
      }
    }

    if (portrait > 0 && landscape > 0) {
      return 'mixed';
    }
    return landscape > portrait ? 'landscape' : 'portrait';
  }

  private canvasToBlob(canvas: HTMLCanvasElement, format: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      canvas.toBlob(
        blob => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to convert canvas to blob'));
          }
        },
        mimeType,
        0.9
      );
    });
  }
}

/**
 * Create a singleton instance
 */
let instance: PdfJsProvider | null = null;

export function getPdfJsProvider(): PdfJsProvider {
  if (!instance) {
    instance = new PdfJsProvider();
  }
  return instance;
}

export function resetPdfJsProvider(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

/**
 * PDF Renderer Module
 *
 * Provides PDF rendering functionality for Los Libros:
 * - Server-based page rendering
 * - Text layer for selection
 * - Annotation layer for highlights
 * - Region selection for scanned PDFs
 */

export { PdfRenderer } from './pdf-renderer';
export type { PdfRendererConfig, PdfContentProvider } from './pdf-renderer';

export { PdfCanvasLayer } from './pdf-canvas-layer';
export type { CanvasLayerConfig } from './pdf-canvas-layer';

export { PdfTextLayer } from './pdf-text-layer';
export type { TextLayerConfig, TextSelection } from './pdf-text-layer';

export { PdfAnnotationLayer } from './pdf-annotation-layer';
export type {
  PdfHighlightClickCallback,
  PdfHighlight,
  AnnotationLayerConfig,
} from './pdf-annotation-layer';

export { PdfRegionSelection } from './pdf-region-selection';
export type {
  RegionSelectionData,
  RegionSelectionCallback,
  RegionSelectionConfig,
} from './pdf-region-selection';

export { PdfPaginator } from './pdf-paginator';
export type {
  PdfPageLayout,
  PdfPageInfo,
  PdfPageChangeCallback,
  PdfPaginatorConfig,
} from './pdf-paginator';

export { PdfScroller } from './pdf-scroller';
export type {
  PdfScrollInfo,
  PdfScrollCallback,
  PageRenderCallback,
  PdfScrollerConfig,
} from './pdf-scroller';

// PDF.js fallback provider
export { PdfJsProvider, getPdfJsProvider, resetPdfJsProvider } from './pdfjs-provider';
export type { PdfJsProviderStatus } from './pdfjs-provider';

// Hybrid provider (server + PDF.js fallback)
export { HybridPdfProvider, createHybridPdfProvider } from './hybrid-pdf-provider';
export type {
  HybridPdfProviderConfig,
  HybridPdfProviderStatus,
  PdfProviderMode,
} from './hybrid-pdf-provider';

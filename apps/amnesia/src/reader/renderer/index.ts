/**
 * Document Renderer Module
 *
 * Unified rendering for EPUB and PDF documents using MuPDF WASM:
 * - WASM-based content delivery (MuPDF)
 * - CSS multi-column pagination (EPUB)
 * - Shadow DOM isolation (EPUB)
 * - Tiled rendering (PDF)
 * - Multi-selector annotations
 * - TextQuote-based highlight anchoring
 *
 * @example
 * ```typescript
 * import { HybridDocumentProvider, createHybridDocumentProvider } from './renderer';
 * import { ShadowDOMRenderer } from '../shadow-dom-renderer';
 *
 * // Create document provider
 * const provider = await createHybridDocumentProvider({ pluginPath: '...' });
 *
 * // Load document
 * await provider.loadDocument(arrayBuffer);
 *
 * // For EPUB rendering, use ShadowDOMRenderer
 * const renderer = new ShadowDOMRenderer(container, contentProvider, config);
 * await renderer.loadFromBytes(arrayBuffer);
 * ```
 */

// Core types
export type {
  // Book types
  BookMetadata,
  Creator,
  TocEntry,
  SpineItem,
  ParsedBook,
  ChapterContent,

  // Configuration
  DisplayMode,
  ColumnLayout,
  ThemePreset,
  RendererConfig,
  ThemeColors,

  // Location and navigation
  ReadingLocation,
  NavigationTarget,

  // Annotations
  HighlightColor,
  AnnotationType,
  TextSelector,
  Annotation,
  RenderedHighlight,

  // Sync
  SyncStatus,
  SyncOperation,
  SyncConflict,
  ReadingProgress,
  PushRequest,
  PushResponse,
  PullRequest,
  PullResponse,

  // Events
  RendererEvents,
  RendererEventListener,

  // API
  ApiResponse,

  // PDF types
  ParsedPdf,
  PdfMetadata,
  PdfTextLayerData,
  PdfTextItem,
  PdfCharPosition,
  PdfPageDimensions,
  PdfSearchResult,
  PdfSelector,
  PdfRect,
  PdfPosition,
  PdfRenderOptions,
  RegionSelectionEvent,
} from './types';

export { DEFAULT_RENDERER_CONFIG } from './types';

// Document Renderer Interface (unified EPUB/PDF)
export type {
  DocumentFormat,
  DocumentMetadata,
  ParsedDocument,
  DocumentLocation,
  DocumentNavigationTarget,
  DocumentDisplayMode,
  DocumentPageLayout,
  DocumentRendererConfig,
  DocumentSelector,
  EpubSelector,
  DocumentSelectionEvent,
  DocumentSearchOptions,
  DocumentSearchResult,
  DocumentRendererEvents,
  DocumentRendererEventListener,
  RenderedDocumentHighlight,
  DocumentRenderer,
} from './document-renderer';

export {
  detectDocumentFormat,
  isPdfLocation,
  isPdfSelector,
  createPdfLocator,
  parsePdfLocator,
} from './document-renderer';


// Content Provider Interface
export type { ContentProvider } from './content-provider';

// Pagination
export { Paginator } from './paginator';
export type { PageInfo, PageChangeCallback } from './paginator';

// Scrolling
export { Scroller } from './scroller';
export type { ScrollCallback } from './scroller';

// Highlights
export { HighlightOverlay } from './overlay';
export type { HighlightClickCallback } from './overlay';
export { InlineHighlightManager } from './inline-highlights';
export type { InlineHighlight, InlineHighlightClickCallback } from './inline-highlights';

// Selection
export { SelectionHandler } from './selection';
export type { SelectionData, SelectionCallback } from './selection';


// Device ID
export { getDeviceId, resetDeviceId } from './device-id';


// Book Providers
export type { BookProvider, SearchResult, ProviderStatus } from './book-provider';
export { WasmBookProvider } from './wasm-provider';
export { ProviderAdapter, createProviderAdapter } from './provider-adapter';
// Unified Document Provider (PDF + EPUB)
export {
  HybridDocumentProvider,
  createHybridDocumentProvider,
  destroySharedResources,
} from './hybrid-document-provider';
export type { HybridDocumentProviderConfig, RenderOptions, TileRenderOptions } from './hybrid-document-provider';

// PDF Renderer (WASM-based)
export {
  PdfRenderer,
  PdfCanvasLayer,
  PdfTextLayer,
  PdfAnnotationLayer,
  PdfRegionSelection,
  PdfPaginator,
  PdfScroller,
} from './pdf';
export type {
  PdfRendererConfig,
  PdfContentProvider,
  CanvasLayerConfig,
  TextLayerConfig,
  TextSelection,
  PdfHighlightClickCallback,
  PdfHighlight,
  AnnotationLayerConfig,
  RegionSelectionData,
  RegionSelectionCallback,
  RegionSelectionConfig,
  PdfPageLayout,
  PdfPageInfo,
  PdfPageChangeCallback,
  PdfPaginatorConfig,
  PdfScrollInfo,
  PdfScrollCallback,
  PageRenderCallback,
  PdfScrollerConfig,
} from './pdf';

// Highlight Anchoring (unified EPUB/PDF)
export { HighlightAnchor } from './highlight-anchor';
export type {
  UnifiedAnchorResult,
  AnchorError,
  AnchorErrorCode,
} from './highlight-anchor';

// MuPDF EPUB Module (EPUB Migration)
export {
  MuPDFEpubBridge,
  getSharedMuPDFEpubBridge,
  destroySharedMuPDFEpubBridge,
  MuPDFEpubContentProvider,
  getSharedMuPDFEpubContentProvider,
  destroySharedMuPDFEpubContentProvider,
  // Search (Stage 3)
  MuPDFEpubSearch,
  getMuPDFEpubSearch,
  clearMuPDFEpubSearch,
  createHybridSearchProvider,
  // Format detection (Stage 4)
  EpubFormatDetector,
  getEpubFormatDetector,
  isFixedLayoutEpub,
  getEpubFormatInfo,
  // Fixed-layout renderer (Stage 4)
  FixedLayoutEpubRenderer,
} from './epub';
export type {
  EpubMetadata,
  EpubSpineItem,
  ParsedEpub,
  EpubChapterContent,
  EpubSearchResult,
  FixedLayoutPageDimensions,
  // Search types (Stage 3)
  MuPDFSearchResult,
  MuPDFSearchOptions,
  SearchProvider,
  // Format detection types (Stage 4)
  EpubLayoutType,
  EpubFormatInfo,
  DetectionOptions,
  // Fixed-layout renderer types (Stage 4)
  FixedLayoutRendererConfig,
  PageRenderOptions,
  RenderedPage,
  FixedLayoutRendererEvents,
} from './epub';

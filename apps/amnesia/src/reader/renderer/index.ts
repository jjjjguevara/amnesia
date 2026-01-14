/**
 * EPUB Renderer Module
 *
 * Custom EPUB renderer that replaces epub.js with:
 * - Server-based content delivery (amnesia-server)
 * - CSS multi-column pagination
 * - Continuous scroll mode
 * - SVG highlight overlay
 * - Multi-selector annotations
 * - Automatic background sync
 *
 * @example
 * ```typescript
 * import {
 *   EpubRenderer,
 *   ApiClient,
 *   createApiClient,
 *   SyncManager
 * } from './renderer';
 *
 * // Initialize API client
 * const api = createApiClient({
 *   baseUrl: 'http://localhost:3000',
 *   deviceId: 'device-123'
 * });
 *
 * // Create renderer
 * const renderer = new EpubRenderer(containerElement, api, {
 *   mode: 'paginated',
 *   fontSize: 18,
 *   theme: 'sepia'
 * });
 *
 * // Load book
 * await renderer.load(bookId);
 *
 * // Set up sync
 * const sync = new SyncManager(api, {
 *   deviceId: 'device-123',
 *   onStatusChange: (status) => console.log('Sync:', status)
 * });
 * await sync.initialize(bookId);
 *
 * // Listen for events
 * renderer.on('relocated', (location) => {
 *   sync.update('progress', bookId, location);
 * });
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

// API Client
export { ApiClient, ApiError, createApiClient, getApiClient } from './api-client';
export type { ApiClientConfig } from './api-client';

// Renderer
export { EpubRenderer } from './renderer';
export type { ContentProvider } from './renderer';

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

// Sync
export { SyncManager } from './sync-manager';
export type { SyncManagerConfig } from './sync-manager';

// Device ID
export { getDeviceId, resetDeviceId } from './device-id';

// Reader Adapter (epub.js compatibility layer)
export { ReaderAdapter, createReaderAdapter } from './reader-adapter';

// Book Providers
export type { BookProvider, SearchResult, ProviderStatus } from './book-provider';
export { WasmBookProvider } from './wasm-provider';
export { HybridBookProvider, createHybridProvider } from './hybrid-provider';
export type { HybridProviderConfig, ProviderMode } from './hybrid-provider';
export { ProviderAdapter, createProviderAdapter } from './provider-adapter';
// Unified Document Provider (PDF + EPUB)
export {
  HybridDocumentProvider,
  createHybridDocumentProvider,
  destroySharedResources,
} from './hybrid-document-provider';
export type { HybridDocumentProviderConfig, RenderOptions, TileRenderOptions } from './hybrid-document-provider';

// PDF Renderer (server-based, PDF.js deprecated)
export {
  PdfRenderer,
  PdfCanvasLayer,
  PdfTextLayer,
  PdfAnnotationLayer,
  PdfRegionSelection,
  PdfPaginator,
  PdfScroller,
  HybridPdfProvider,
  createHybridPdfProvider,
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
  HybridPdfProviderConfig,
  HybridPdfProviderStatus,
  PdfProviderMode,
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

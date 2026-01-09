/**
 * PDF Renderer Module
 *
 * Provides PDF rendering functionality for Amnesia:
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

/**
 * @deprecated Use HybridDocumentProvider from '../hybrid-document-provider' instead.
 * HybridPdfProvider is being phased out in favor of the unified document provider
 * that handles both PDF and EPUB formats.
 *
 * Migration:
 * - Replace: createHybridPdfProvider(config) → createHybridDocumentProvider(config)
 * - Replace: pdfProvider.loadDocument(data) → documentProvider.loadDocument(data)
 * - Replace: manual adapter creation → documentProvider.createPdfContentAdapter()
 */
export { HybridPdfProvider, createHybridPdfProvider } from './hybrid-pdf-provider';
/**
 * @deprecated Use HybridDocumentProviderConfig from '../hybrid-document-provider' instead.
 */
export type {
  HybridPdfProviderConfig,
  HybridPdfProviderStatus,
  PdfProviderMode,
} from './hybrid-pdf-provider';

// Multi-page container
export { PdfMultiPageContainer } from './pdf-multi-page-container';
export type {
  MultiPageConfig,
  DisplayMode,
  ScrollDirection,
} from './pdf-multi-page-container';

// Page element
export { PdfPageElement } from './pdf-page-element';
export type { ReadingMode, PageHighlight, PageRenderData } from './pdf-page-element';

// Infinite canvas (new pan-zoom system)
export { PdfInfiniteCanvas } from './pdf-infinite-canvas';
export type { InfiniteCanvasConfig, PageLayout, DisplayMode as InfiniteCanvasDisplayMode } from './pdf-infinite-canvas';

// Camera system
export {
  createCamera,
  panCamera,
  zoomCameraToPoint,
  zoomCamera,
  setCameraZoom,
  centerOnPoint,
  fitBoxInView,
  getCameraTransform,
  getVisibleBounds,
  lerpCamera,
  screenToCanvas,
  canvasToScreen,
} from './pdf-canvas-camera';
export type { Camera, Point, CameraConstraints } from './pdf-canvas-camera';

// Canvas worker pool for off-main-thread image processing
export {
  PdfCanvasPool,
  getCanvasPool,
  initializeCanvasPool,
} from './pdf-canvas-pool';

// Telemetry for performance monitoring
export {
  PdfTelemetry,
  getTelemetry,
  trackCacheAccess,
  trackRenderTime,
} from './pdf-telemetry';
export type { TelemetryMetrics, TelemetryStats } from './pdf-telemetry';

// SVG text layer for vector-crisp text rendering
export { PdfSvgTextLayer } from './pdf-svg-text-layer';
export type { SvgTextLayerConfig, SvgTextSelection, SvgTextLayerFetcher } from './pdf-svg-text-layer';

// Tile rendering infrastructure (CATiledLayer-style)
export { TileRenderEngine, TILE_SIZE } from './tile-render-engine';
export type { TileCoordinate, TileScale, TileRenderRequest, PageLayout as TilePageLayout, Rect } from './tile-render-engine';

export { TileCacheManager, getTileCacheManager } from './tile-cache-manager';
export type { PageMetadata } from './tile-cache-manager';

export { RenderCoordinator, getRenderCoordinator, resetRenderCoordinator } from './render-coordinator';
export type { RenderRequest, RenderResult, RenderMode, RenderPriority } from './render-coordinator';

// Mode-specific strategies
export { PaginatedStrategy, getPaginatedStrategy } from './paginated-strategy';
export { ScrollStrategy, getScrollStrategy } from './scroll-strategy';
export type { PrioritizedTile, SpeedZone, SpeedZoneConfig } from './scroll-strategy';
export { GridStrategy, getGridStrategy } from './grid-strategy';

// Lifecycle testing (Phase C & D)
export { LifecycleTestRunner, formatTestResults } from './lifecycle-test-runner';
export type {
  LifecycleTestStep,
  LifecycleTestResult,
  LifecycleTestStepResult,
  StepMetrics,
  TestStepType,
  TestStepParams,
} from './lifecycle-test-runner';

export {
  STANDARD_SCENARIOS,
  SCENARIO_DESCRIPTIONS,
  listScenarios,
  getScenario,
  createScenario,
} from './standard-scenarios';

export {
  exposeLifecycleTests,
  initializeTestHarness,
} from './mcp-test-harness';
export type { ComparisonScreenshotResult, McpTestHarness } from './mcp-test-harness';

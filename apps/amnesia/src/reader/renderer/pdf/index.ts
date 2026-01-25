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
  createPipelineTimer,
  PipelineTimerBuilder,
  // Classification telemetry (Phase 5)
  trackClassification,
  trackRenderByContentType,
  trackJpegExtraction,
  trackVectorOptimization,
  trackCacheAccessByContentType,
  getClassificationStats,
} from './pdf-telemetry';
export type {
  TelemetryMetrics,
  TelemetryStats,
  PipelineTiming,
  PipelineStats,
  PipelineStageStats,
  // Classification telemetry types (Phase 5)
  ClassificationMetrics,
  ClassificationStats,
} from './pdf-telemetry';

// Feature flags for optimization control
export {
  FeatureFlagsManager,
  getFeatureFlags,
  isFeatureEnabled,
  setFeatureFlag,
  resetFeatureFlags,
} from './feature-flags';
export type {
  FeatureFlagDefinitions,
  ResolvedFeatureFlags,
  CapabilityDetection,
} from './feature-flags';

// Benchmark suite for performance testing
export {
  BenchmarkSuite,
  getBenchmarkSuite,
  resetBenchmarkSuite,
} from './benchmark-suite';
export type {
  BenchmarkConfig,
  BenchmarkResult,
  SuiteResults,
  BenchmarkComparison,
  IterationResult,
} from './benchmark-suite';

// Coordinate debugger for PDF rendering diagnostics
export {
  CoordinateDebugger,
  getCoordinateDebugger,
  resetCoordinateDebugger,
} from './coordinate-debugger';
export type {
  CoordinateSnapshot,
  ValidationResult,
  SnapshotFilter,
  OperationType,
  ZoomInputs,
  ZoomOutputs,
  PanInputs,
  PanOutputs,
  VisibilityInputs,
  VisibilityOutputs,
  ConstraintInputs,
  ConstraintOutputs,
  TileInputs,
  TileOutputs,
  // Render pipeline types (for tracing zoom bump)
  RenderRequestInputs,
  RenderCompleteInputs,
  CanvasUpdateInputs,
  TransformApplyInputs,
  CssStretchChangeInputs,
} from './coordinate-debugger';

// SVG text layer for vector-crisp text rendering
export { PdfSvgTextLayer } from './pdf-svg-text-layer';
export type { SvgTextLayerConfig, SvgTextSelection, SvgTextLayerFetcher } from './pdf-svg-text-layer';

// Tile rendering infrastructure (CATiledLayer-style)
export { TileRenderEngine, TILE_SIZE, getTileSize } from './tile-render-engine';
export type { TileCoordinate, TileScale, TileRenderRequest, PageLayout as TilePageLayout, Rect } from './tile-render-engine';

export { TileCacheManager, getTileCacheManager } from './tile-cache-manager';
export type { PageMetadata, CachedTileData, CachedPageClassification } from './tile-cache-manager';

// Tile integrity checker (diagnostic tool for tile rendering failures)
export { TileIntegrityChecker, getTileIntegrityChecker, resetTileIntegrityChecker } from './tile-integrity-checker';
export type { TileRequest, TileResult, TileMapReport, RetryConfig } from './tile-integrity-checker';

// Progressive zoom infrastructure (Phase 2: Multi-Resolution Zoom)
export {
  SCALE_TIERS,
  getTargetScaleTier,
  getExactTargetScale,
  roundScaleForCache,
  EXACT_SCALE_PRECISION,
  getProgressiveScales,
  getIntermediateScale,
  getCssScaleFactor,
  getAdaptiveTileSize,

  ProgressiveTileRenderer,
  getProgressiveTileRenderer,
  resetProgressiveTileRenderer,
} from './progressive-tile-renderer';
export type { ScaleTier, ProgressiveTileResult, ProgressivePhaseConfig, ExactScaleResult } from './progressive-tile-renderer';

// Zoom Scale Service (unified source of truth - amnesia-aqv)
// Replaces: ZoomOrchestrator, ZoomStateMachine, ZoomStateManager, ScaleStateManager
export {
  ZoomScaleService,
  createZoomScaleService,
  getZoomScaleService,
  clearZoomScaleService,
} from './zoom-scale-service';
export type {
  GesturePhase,
  RenderMode as ZoomRenderMode,
  ZoomScaleServiceConfig,
  ZoomScaleSnapshot,
  ScaleResult,
  TileParams,
} from './zoom-scale-service';

export { RenderCoordinator, getRenderCoordinator, resetRenderCoordinator } from './render-coordinator';
export type { RenderRequest, RenderResult, RenderMode, RenderPriority } from './render-coordinator';

// WASM renderer types
export type { TileRenderResult } from './wasm-renderer';

// Mode-specific strategies
export { PaginatedStrategy, getPaginatedStrategy } from './paginated-strategy';
export { ScrollStrategy, getScrollStrategy } from './scroll-strategy';
export type { PrioritizedTile, SpeedZone, SpeedZoneConfig } from './scroll-strategy';
export {
  GridStrategy,
  getGridStrategy,
  getThumbnailRippleOrder,
  groupPagesByPriority,
  type ThumbnailPriority,
  type ThumbnailPriorityPage,
} from './grid-strategy';

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

// Worker Pool (Phase 3: Multi-Worker Architecture)
export {
  WorkerPoolManager,
  getWorkerPool,
  getWorkerPoolSync,
  destroyWorkerPool,
  resetWorkerPool,
  setWorkerPoolPluginPath,
  prewarmWorkerPool,
  isWorkerPoolReady,
} from './worker-pool-manager';
export type {
  WorkerPoolConfig,
  WorkerPoolStats,
  LoadBalancingStrategy,
} from './worker-pool-manager';

export {
  PooledMuPDFBridge,
  setPooledBridgePluginPath,
  destroyPooledBridge,
} from './pooled-mupdf-bridge';

// IndexedDB thumbnail persistence (Phase 4: Grid Mode Optimization)
export {
  ThumbnailIdbCache,
  getThumbnailIdbCache,
  resetThumbnailIdbCache,
  generateDocumentHash,
  imageToWebPBlob,
  blobToImageBitmap,
} from './thumbnail-idb-cache';
export type { ThumbnailEntry } from './thumbnail-idb-cache';

// Content-Type Detection (Phase 5: Content-Type Detection)
export {
  PDFContentType,
  ImageFilter,
  CLASSIFICATION_THRESHOLDS,
  parseImageFilter,
  isDirectExtractableFilter,
  getRenderStrategy,
  // Vector scale optimization (Phase 5.9)
  getOptimizedRenderParams,
  shouldApplyVectorOptimization,
  getVectorScaleTransform,
  calculateVectorOptimizationSavings,
  VECTOR_OPTIMIZATION_MIN_SCALE,
} from './content-type-classifier';
export type {
  PageImageInfo,
  OperatorCounts,
  PageClassification,
  RenderStrategy,
  OptimizedRenderParams,
} from './content-type-classifier';

// Adaptive Quality (Phase 5: Adaptive Quality During Interaction)
export {
  AdaptiveQualityManager,
  getAdaptiveQualityManager,
  resetAdaptiveQualityManager,
} from './adaptive-quality';
export type {
  QualityState,
  AdaptiveQualityConfig,
} from './adaptive-quality';

// WebGL Compositor (Phase 7: GPU-Accelerated Compositing)
export {
  WebGLCompositor,
  getWebGLCompositor,
  resetWebGLCompositor,
} from './webgl-compositor';
export type {
  TileTexture,
  CompositorConfig,
  TileRenderInfo,
  CameraTransform,
} from './webgl-compositor';

// Device Profiler (Performance optimization)
export {
  getDeviceProfile,
  getDeviceProfileSync,
  type DeviceProfile,
  type DeviceTier,
} from './device-profiler';

// Performance Config (Tier-based settings)
export {
  getPerformanceConfig,
  getCurrentTier,
  getAllTierConfigs,
  getConfigForTier,
  type PerformanceConfig,
} from './performance-config';

// Lifecycle Telemetry (Unified telemetry service)
export {
  getLifecycleTelemetry,
  resetLifecycleTelemetry,
  type LifecycleTelemetryService,
  type TelemetryStats as LifecycleTelemetryStats,
} from './lifecycle-telemetry';

// Stress Test Harness (Automated testing)
export {
  StressTestHarness,
  getStressTestHarness,
  DEFAULT_QUALITY_FLOORS,
  type QualityFloor,
  type StressTestResult,
  type StressTestReport,
} from './stress-test-harness';

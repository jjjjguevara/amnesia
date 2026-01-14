/**
 * PDF Infinite Canvas
 *
 * Implements an infinite canvas for PDF viewing with proper pan and zoom.
 * Uses CSS transforms for GPU-accelerated rendering.
 *
 * Architecture:
 * - Pages are positioned at fixed coordinates on a virtual canvas
 * - A camera tracks viewport position and zoom
 * - CSS transform is applied to canvas container for smooth pan/zoom
 * - Page elements never resize - only the viewport moves
 */

import { PdfPageElement, type PageRenderData, type PageHighlight, type ReadingMode } from './pdf-page-element';
import {
  type Camera,
  type Point,
  type CameraConstraints,
  createCamera,
  panCamera,
  zoomCameraToPoint,
  getCameraTransform,
  getVisibleBounds,
  fitBoxInView,
  centerOnPoint,
  lerpCamera,
  // Unified coordinate space functions (V4 Architecture)
  panCameraUnified,
  getVisibleBoundsUnified,
} from './pdf-canvas-camera';
import { getCoordinateDebugger, type SnapshotFilter } from './coordinate-debugger';
import { SpatialPrefetcher } from './spatial-prefetcher';
import { initializeCanvasPool, getCanvasPool } from './pdf-canvas-pool';
import type { PdfTextLayer as TextLayerData, PdfRenderOptions } from '../types';
import type { TileCoordinate, TileRenderEngine } from './tile-render-engine';
import { getTileEngine, TILE_SIZE, getTileSize } from './tile-render-engine';
import type { RenderCoordinator, RenderMode, RenderPriority } from './render-coordinator';
import { getTelemetry } from './pdf-telemetry';
import { isFeatureEnabled } from './feature-flags';
import { getTileCacheManager } from './tile-cache-manager';
import {
  getTargetScaleTier,
  getProgressiveTileRenderer,
  type ScaleTier,
} from './progressive-tile-renderer';
import { ZoomTransformLayer, type ZoomPhase } from './zoom-transform-layer';
import { ZoomStateMachine } from './zoom-state-machine';
import { getRenderSessionManager } from './render-session';

export interface PageLayout {
  /** Page number (1-indexed) */
  page: number;
  /** X position on canvas */
  x: number;
  /** Y position on canvas */
  y: number;
  /** Page width on canvas (at 100% zoom) */
  width: number;
  /** Page height on canvas (at 100% zoom) */
  height: number;
}

/**
 * Display modes for the PDF canvas:
 * - paginated: Fit multiple pages in view, no pan, keyboard navigation
 * - horizontal-scroll: Single row, fixed height, horizontal pan only, unlimited zoom in
 * - vertical-scroll: Single column, fixed width, vertical pan only, unlimited zoom in
 * - auto-grid: Dynamic columns based on zoom, always fits viewport width
 * - canvas: Free pan/zoom, fixed columns (8-12)
 */
export type DisplayMode = 'paginated' | 'horizontal-scroll' | 'vertical-scroll' | 'auto-grid' | 'canvas';

export interface InfiniteCanvasConfig {
  /** Display mode */
  displayMode: DisplayMode;
  /** Gap between pages */
  gap: number;
  /** Padding around content */
  padding: number;
  /** Minimum zoom level */
  minZoom: number;
  /** Maximum zoom level */
  maxZoom: number;
  /** Page width (PDF units) */
  pageWidth: number;
  /** Page height (PDF units) */
  pageHeight: number;
  /** Scale factor for rendering (affects render quality) */
  renderScale: number;
  /** Pixel ratio for HiDPI */
  pixelRatio: number;
  /** Reading mode (dark/light/device) */
  readingMode: ReadingMode;
  /** Fixed columns for canvas mode (default: 10) */
  canvasColumns: number;
  /** Internal: current layout type */
  layoutMode: 'vertical' | 'horizontal' | 'grid';
  /** Internal: pages per row */
  pagesPerRow: number;
}

/**
 * Result of dual-resolution page image fetch
 */
export interface DualResPageResult {
  /** The blob to display immediately (may be lower resolution) */
  initial: Blob;
  /** Scale of the initial blob */
  initialScale: number;
  /** Whether initial is at full requested quality */
  isFullQuality: boolean;
  /** Promise that resolves with full quality blob (only if initial was lower quality) */
  upgradePromise?: Promise<Blob>;
}

export interface PageDataProvider {
  getPageImage(page: number, options: PdfRenderOptions): Promise<Blob>;
  getPageTextLayer(page: number): Promise<TextLayerData>;
  /** Optional: Notify provider of current page (for linear prefetching) */
  notifyPageChange?(page: number): void;
  /** Optional: Prefetch specific pages (for spatial prefetching) */
  prefetchPages?(pages: number[]): Promise<void>;
  /** Optional: Get page image with dual-resolution (thumbnail first, upgrade later) */
  getPageImageDualRes?(page: number, options: PdfRenderOptions): Promise<DualResPageResult>;
  /** Optional: Render a tile (256x256 region) of a page */
  renderTile?(tile: TileCoordinate): Promise<Blob>;
  /** Optional: Get the render coordinator for tile-based rendering */
  getRenderCoordinator?(): RenderCoordinator;
  /** Optional: Check if tile rendering is available */
  isTileRenderingAvailable?(): boolean;
  /** Optional: Suspend thumbnail generation during user interaction */
  suspendThumbnailGeneration?(): void;
  /** Optional: Resume thumbnail generation after interaction ends */
  resumeThumbnailGeneration?(): void;
  /**
   * Get the document ID for this provider.
   * Required for cross-document isolation in global singletons like RenderCoordinator.
   */
  getDocumentId?(): string | null;
}

// Note: pixelRatio is intentionally set to 1 here as a fallback.
// The actual runtime value should be passed via config or set in constructor.
// This avoids capturing window.devicePixelRatio at module load time when it may be incorrect.
const DEFAULT_CONFIG: InfiniteCanvasConfig = {
  displayMode: 'auto-grid',
  gap: 16,
  padding: 24,
  minZoom: 0.1,
  maxZoom: 16, // Allow high zoom for detailed viewing
  pageWidth: 612,
  pageHeight: 792,
  renderScale: 1.5,
  pixelRatio: 1, // Fallback only - runtime value should override this
  readingMode: 'device',
  canvasColumns: 10,
  layoutMode: 'vertical',
  pagesPerRow: 1,
};

// Base page size in canvas units (at 100% zoom)
const BASE_PAGE_WIDTH = 400;

// Minimum visible page width to trigger column recalculation
const MIN_VISIBLE_PAGE_WIDTH = 150;

/**
 * Infinite canvas for PDF viewing with pan and zoom
 */
export class PdfInfiniteCanvas {
  private container: HTMLElement;
  private viewport: HTMLDivElement;
  private canvas: HTMLDivElement;
  private provider: PageDataProvider;
  private config: InfiniteCanvasConfig;

  // Camera state
  private camera: Camera;
  private cameraConstraints: CameraConstraints;

  // Dynamic layout state
  private currentColumns = 1;
  private lastLayoutZoom = 1;

  // Page state
  private pageCount = 0;
  private pageLayouts: Map<number, PageLayout> = new Map();
  private pageElements: Map<number, PdfPageElement> = new Map();
  private canvasBounds = { width: 0, height: 0 };

  // Layout constants for O(1) page visibility calculation
  private layoutBaseWidth = 400;
  private layoutBaseHeight = 518; // Will be recalculated based on aspect ratio
  private layoutPadding = 24;
  private layoutGap = 16;

  // Rendering
  private visiblePages: Set<number> = new Set();
  private renderQueue: number[] = [];
  private isRendering = false;
  private renderVersion = 0;

  // Priority rendering - immediate neighbors get rendered first
  private priorityRenderQueue: number[] = [];

  // Image cache
  private readonly PAGE_CACHE_SIZE = 100;
  private pageImageCache: Map<number, Blob> = new Map();
  private pageCacheScales: Map<number, number> = new Map();
  private cacheOrder: number[] = [];

  // Track which pages were rendered with tiles (vs full-page)
  // Used to force re-render when crossing the tiling threshold
  private pageWasTiled: Map<number, boolean> = new Map();

  // Zoom-dependent re-rendering
  private zoomRerenderTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly ZOOM_RERENDER_DEBOUNCE = 100; // ms to wait after zoom stops (reduced from 150ms)

  // Scroll-specific re-rendering (much shorter debounce for responsiveness)
  private scrollRerenderTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly SCROLL_RERENDER_DEBOUNCE = 32; // ms - ~2 frames for batching scroll events
  // Throttle tracking for inertia scroll - allows periodic renders during continuous motion
  private lastScrollRenderTime = 0;
  private readonly INERTIA_RENDER_THROTTLE = 16; // ms - every frame during inertia (60 FPS tile updates)
  // Snapshot for scroll re-rendering - captures camera AND layout params at schedule time
  // so tile visibility is calculated based on where user was, not where camera moved to,
  // and layout params don't change during the debounce window
  private scrollRenderSnapshot: {
    camera: Camera;
    layoutMode: 'vertical' | 'horizontal' | 'grid';
    pagesPerRow: number;
    cellWidth: number;
    cellHeight: number;
    padding: number;
  } | null = null;

  // Snapshot for zoom re-rendering - captures camera AND layout params at schedule time
  // CRITICAL: Same pattern as scroll - during rapid zoom gestures, the camera moves
  // significantly between schedule and render (100ms+ debounce in ZoomTransformLayer).
  // Using current camera at render time causes tiles to be calculated for wrong viewport.
  private zoomRenderSnapshot: {
    camera: Camera;
    layoutMode: 'vertical' | 'horizontal' | 'grid';
    pagesPerRow: number;
    cellWidth: number;
    cellHeight: number;
    padding: number;
  } | null = null;

  // FOCAL POINT FIX: Track the last zoom gesture focal point for consistent rendering
  // This must be passed to ZoomTransformLayer even when CSS transforms are disabled,
  // because the layer's internal calculations depend on knowing the zoom origin.
  private lastZoomFocalPoint: Point = { x: 0, y: 0 };

  private readonly MIN_EFFECTIVE_RATIO = 2.0; // Minimum buffer pixels per screen pixel (Retina)
  private pendingImageRequests: Map<number, Promise<Blob>> = new Map();

  // Gesture state
  private isPanning = false;
  private lastPointerPosition: Point | null = null;
  private panStartCamera: Camera | null = null;

  // ZOOM STATE MACHINE: Centralized zoom state management to prevent bypass paths.
  // Replaces distributed flags (isZoomGestureActive, cooldowns, etc.) with a
  // single source of truth. All render paths check zoomStateMachine.canRender().
  private zoomStateMachine!: ZoomStateMachine;

  // UNIFIED COORDINATE SPACE (Phase 2): Controls whether we use the new coordinate system.
  // When true:
  // - Page elements are sized to their final displayed dimensions (zoom × layout)
  // - Camera transform is translate-only (no scale)
  // - Camera x/y are in screen pixels (not divided by zoom)
  // When false (default):
  // - Legacy mode with scale transform
  // - cssStretch mechanism (removed but could be added back if needed)
  //
  // Reads from feature flag 'useUnifiedCoordinateSpace'.
  private useUnifiedCoordinateSpace = isFeatureEnabled('useUnifiedCoordinateSpace');

  // Document ID for cross-document isolation in global singletons.
  // Cached from provider.getDocumentId() to include in render requests.
  private documentId: string | null = null;

  // Session ID captured at queue time for selective abort.
  // This prevents race conditions where session changes between queue and render execution.
  private pendingSessionId: number | undefined = undefined;

  // Inertia scrolling state
  private velocity: Point = { x: 0, y: 0 };
  private lastWheelTime = 0;
  private inertiaAnimationFrame: number | null = null;
  private scheduleInertiaTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly INERTIA_DECAY = 0.92; // Velocity multiplier per frame
  private readonly INERTIA_MIN_VELOCITY = 0.5; // Stop when velocity below this
  private readonly INERTIA_START_THRESHOLD = 3; // Only start inertia if velocity exceeds this (fling detection)
  private readonly VELOCITY_SCALE = 0.15; // Scale factor for velocity tracking

  // Thumbnail suspension - prevents background thumbnail generation from competing with interactive rendering
  private thumbnailSuspensionResumeTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly THUMBNAIL_SUSPENSION_RESUME_DELAY = 300; // ms after last interaction before resuming

  // Cached viewport rect - updated on resize, avoids layout thrashing
  private cachedViewportRect: DOMRect | null = null;
  private pendingVisiblePagesUpdate = false;

  // Deferred initial view setup - waits for viewport to have valid dimensions
  private initialViewSetupPending = false;
  private resizeObserver: ResizeObserver | null = null;

  // Animation
  private animationFrame: number | null = null;

  // Callbacks
  private onPageChangeCallback?: (page: number) => void;
  private onZoomChangeCallback?: (zoom: number) => void;
  private onSelectionCallback?: (page: number, text: string, rects: DOMRect[]) => void;
  private onHighlightClickCallback?: (annotationId: string, position: { x: number; y: number }) => void;

  // Page update debounce during scroll
  private pageUpdateTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastReportedPage = 0;

  // Spatial prefetcher for grid-based modes (auto-grid, canvas)
  private spatialPrefetcher = new SpatialPrefetcher();

  // Tile rendering infrastructure (CATiledLayer-style)
  private tileEngine: TileRenderEngine | null = null;
  private renderCoordinator: RenderCoordinator | null = null;
  private useTiledRendering = false;
  private tileZoomThreshold = 2.0; // Use tiles when zoom > 2x

  // Progressive zoom state (Phase 2: Multi-Resolution Zoom)
  private zoomFinalRenderTimeout: ReturnType<typeof setTimeout> | null = null;
  private currentRenderScale: ScaleTier = 4; // Track current tile render scale
  private readonly ZOOM_INTERMEDIATE_DELAY = 16; // ms before intermediate render (single frame)
  private readonly ZOOM_FINAL_DELAY = 100; // ms before final quality render (reduced for responsiveness)
  private zoomTransformLayer: ZoomTransformLayer | null = null;

  // Scale tracking state (Phase E: Scale Lock Mechanism)
  // Prevents concurrent scale updates during rapid zoom by versioning zoom sequences
  // Each zoom gesture (from either ZoomTransformLayer or progressive zoom) increments scaleVersion
  // Stale renders from previous gestures are rejected by checking version match
  private scaleVersion = 0;

  // Input-to-visual latency tracking (Performance Debug)
  // Tracks the most recent input event ID for latency measurement
  private pendingInputLatencyId: number | null = null;

  constructor(
    container: HTMLElement,
    provider: PageDataProvider,
    config: Partial<InfiniteCanvasConfig> = {}
  ) {
    this.container = container;
    this.provider = provider;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Ensure pixelRatio uses runtime window.devicePixelRatio if not explicitly overridden
    // This handles cases where the passed config also captured an incorrect value at module load
    if (this.config.pixelRatio === 1 && window.devicePixelRatio > 1) {
      this.config.pixelRatio = window.devicePixelRatio;
    }

    // Initialize camera at 100% zoom
    this.camera = createCamera(1);

    this.cameraConstraints = {
      minZoom: this.config.minZoom,
      maxZoom: this.config.maxZoom,
      constrainToBounds: true,
    };

    // Create viewport (clips content, handles overflow)
    this.viewport = document.createElement('div');
    this.viewport.className = 'pdf-infinite-viewport';
    this.viewport.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
      touch-action: none;
    `;
    this.container.appendChild(this.viewport);

    // Create canvas (transformed container for all pages)
    this.canvas = document.createElement('div');
    this.canvas.className = 'pdf-infinite-canvas';
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
      will-change: transform;
    `;
    this.viewport.appendChild(this.canvas);

    // Setup event listeners
    this.setupPointerEvents();
    this.setupWheelEvents();
    this.setupKeyboardEvents();
    this.setupDoubleClickHandler();

    // Initialize canvas worker pool for off-main-thread image processing
    // Fire-and-forget, workers will be ready by first render
    initializeCanvasPool().catch(err => {
      console.warn('[PdfInfiniteCanvas] Failed to initialize canvas pool:', err);
    });

    // Initialize tile rendering if provider supports it
    if (this.provider.isTileRenderingAvailable?.()) {
      this.useTiledRendering = true;
      this.renderCoordinator = this.provider.getRenderCoordinator?.() ?? null;
      this.tileEngine = getTileEngine();
      // Cache documentId for cross-document isolation in render requests
      this.documentId = this.provider.getDocumentId?.() ?? null;
      console.log(`[PdfInfiniteCanvas] Tile rendering enabled, documentId=${this.documentId}`);
    }

    // Initialize ZoomTransformLayer for progressive zoom rendering.
    // Note: We disable ZoomTransformLayer's CSS transform application because
    // our camera system already handles instant zoom feedback. ZoomTransformLayer
    // still manages timing/phase scheduling, quality gap calculations (cssStretch),
    // and progressive render coordination.
    if (isFeatureEnabled('useMultiResZoom')) {
      this.zoomTransformLayer = new ZoomTransformLayer(this.canvas, {
        pixelRatio: this.config.pixelRatio,
        intermediateDelay: this.ZOOM_INTERMEDIATE_DELAY,
        finalDelay: this.ZOOM_FINAL_DELAY,
        disableCssTransforms: true, // Camera handles CSS transforms
      });

      // Wire render callback to our render system
      this.zoomTransformLayer.setRenderCallback((scale: ScaleTier, phase: ZoomPhase) => {
        this.handleZoomRenderPhase(scale, phase);
      });

      // Wire zoom change callback for telemetry
      // Note: Actual zoom change tracking happens in the zoom handlers
      // This is just for additional metrics from ZoomTransformLayer
      this.zoomTransformLayer.setZoomChangeCallback((_zoom: number) => {
        // ZoomTransformLayer notifies us of zoom changes it processes
        // Main tracking happens in the wheel/gesture handlers
      });

      console.log('[PdfInfiniteCanvas] ZoomTransformLayer initialized');
    }

    // Initialize ZoomStateMachine for centralized zoom state management.
    // This replaces distributed flags with a single source of truth.
    // All render paths check zoomStateMachine.canRender() before executing.
    this.zoomStateMachine = new ZoomStateMachine(
      this.renderCoordinator,
      this.config.pixelRatio
    );

    // Wire render callback - state machine triggers render when settling completes
    this.zoomStateMachine.onRenderPhase = (phase, zoom) => {
      console.log(`[PdfInfiniteCanvas] ZoomStateMachine triggered ${phase} render at zoom=${zoom.toFixed(2)}`);
      // Get scale tier for this zoom level
      const { tier: scale } = getTargetScaleTier(zoom, this.config.pixelRatio);
      this.handleZoomRenderPhase(scale, phase);
    };

    // Wire zoom start callback - unified coordinate space handles zoom without cssStretch
    this.zoomStateMachine.onZoomStart = () => {
      // UNIFIED COORDINATE SPACE: No freeze needed
      // Page elements are sized to final dimensions via handleZoomChange()
      console.log('[PdfInfiniteCanvas] Zoom gesture started');
    };

    console.log('[PdfInfiniteCanvas] ZoomStateMachine initialized');

    // Setup ResizeObserver to handle deferred initial view setup
    // This catches the case where viewport dimensions aren't ready during initialize()
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const { width, height } = entry.contentRect;

      // If initial view setup is pending and viewport now has valid dimensions
      if (this.initialViewSetupPending && width > 0 && height > 0) {
        console.log(`[PdfInfiniteCanvas] ResizeObserver: Viewport ready (${width}x${height}), completing initial view setup`);
        this.initialViewSetupPending = false;
        this.completeInitialViewSetup();
      }

      // Always update cached rect on resize
      this.cachedViewportRect = this.viewport.getBoundingClientRect();
      this.cameraConstraints.viewport = { width, height };
    });
    this.resizeObserver.observe(this.viewport);

    // PHASE 0: Expose CoordinateDebugger to window for MCP/console access
    // This enables debugging coordinate math during V4 unified mode development
    (window as any).pdfCoordinateDebugger = getCoordinateDebugger();

    // Quick inspection methods for debugging
    (window as any).pdfDebug = {
      getSnapshots: (filter?: SnapshotFilter) =>
        getCoordinateDebugger().getSnapshots(filter),
      getFailures: () => getCoordinateDebugger().getValidationFailures(),
      exportTrace: () => getCoordinateDebugger().exportToJSON(),
      getSummary: () => getCoordinateDebugger().getSummary(),
      getCurrentState: () => ({
        camera: this.camera,
        unifiedMode: this.useUnifiedCoordinateSpace,
        pageCount: this.pageElements.size,
        canvasBounds: this.canvasBounds,
        viewportRect: this.getViewportRect(),
      }),
      clearSnapshots: () => getCoordinateDebugger().clear(),
      setEnabled: (enabled: boolean) => getCoordinateDebugger().setEnabled(enabled),
    };

    console.log('[PdfInfiniteCanvas] CoordinateDebugger exposed at window.pdfCoordinateDebugger and window.pdfDebug');
  }

  /**
   * Initialize with page count
   */
  initialize(pageCount: number): void {
    this.pageCount = pageCount;

    // Late initialization of tile rendering - check again now that document is loaded.
    // The constructor check happens before document load when wasmDocumentId is null.
    // By the time initialize() is called, the document is loaded and WASM is ready.
    const hasIsTileAvailable = typeof this.provider.isTileRenderingAvailable === 'function';
    const tileAvailable = this.provider.isTileRenderingAvailable?.() ?? false;
    console.log(`[PdfInfiniteCanvas] initialize() - useTiledRendering=${this.useTiledRendering}, hasIsTileAvailable=${hasIsTileAvailable}, tileAvailable=${tileAvailable}`);

    if (!this.useTiledRendering && tileAvailable) {
      this.useTiledRendering = true;
      this.renderCoordinator = this.provider.getRenderCoordinator?.() ?? null;
      this.tileEngine = getTileEngine();
      // Cache documentId for cross-document isolation in render requests
      this.documentId = this.provider.getDocumentId?.() ?? null;
      console.log(`[PdfInfiniteCanvas] Tile rendering enabled (late init), documentId=${this.documentId}`);
    }

    // Ensure documentId is up-to-date (may have changed since constructor)
    if (!this.documentId && this.provider.getDocumentId) {
      this.documentId = this.provider.getDocumentId();
    }

    // Initialize layout based on display mode
    this.initializeDisplayMode();

    this.calculatePageLayouts();
    this.updateCanvasSize();

    // Store viewport size for constraints
    const viewportRect = this.viewport.getBoundingClientRect();
    this.cameraConstraints.viewport = {
      width: viewportRect.width,
      height: viewportRect.height,
    };

    // Initial view setup based on mode
    // ASPECT RATIO FIX: Check if viewport has valid dimensions before setting up initial view.
    // During Obsidian startup, the flex layout may not be computed yet, causing viewportRect
    // to have 0 height. This leads to incorrect zoom calculations that cut off page bottoms.
    if (viewportRect.width > 0 && viewportRect.height > 0) {
      this.setupInitialView();
    } else {
      console.log(`[PdfInfiniteCanvas] Viewport not ready (${viewportRect.width}x${viewportRect.height}), deferring initial view setup`);
      this.initialViewSetupPending = true;
    }
  }

  /**
   * Update page dimensions after document load.
   * Should be called when tile engine has actual PDF dimensions available.
   * This recalculates layouts to match the actual PDF aspect ratio.
   */
  updatePageDimensions(): void {
    if (!this.tileEngine) return;

    const dims = this.tileEngine.pageDimensions.get(1);
    if (!dims) return;

    // Skip if dimensions already match
    if (this.config.pageWidth === dims.width && this.config.pageHeight === dims.height) {
      return;
    }

    console.log(`[PdfInfiniteCanvas] Updating page dimensions: ${dims.width}x${dims.height}`);

    // Update config
    this.config.pageWidth = dims.width;
    this.config.pageHeight = dims.height;

    // Recalculate display mode columns (affects paginated mode)
    this.initializeDisplayMode();

    // Recalculate all page layouts
    this.calculatePageLayouts();
    this.updateCanvasSize();

    // Update page element dimensions to match new layout
    for (const [page, element] of this.pageElements) {
      const layout = this.pageLayouts.get(page);
      if (layout) {
        // UNIFIED COORDINATE SPACE: Dimensions are scaled by current zoom
        if (this.useUnifiedCoordinateSpace) {
          const zoom = this.camera.z;
          element.setFinalDimensions(layout.width * zoom, layout.height * zoom, zoom);
          const el = element.getElement();
          el.style.left = `${layout.x * zoom}px`;
          el.style.top = `${layout.y * zoom}px`;
        } else {
          element.setDimensions(layout.width, layout.height);
        }
      }
    }

    // Re-setup view to maintain proper fit
    // ASPECT RATIO FIX: Check if viewport has valid dimensions before setting up view.
    const viewportRect = this.viewport.getBoundingClientRect();
    if (viewportRect.width > 0 && viewportRect.height > 0) {
      this.setupInitialView();
    } else {
      console.log(`[PdfInfiniteCanvas] updatePageDimensions: Viewport not ready (${viewportRect.width}x${viewportRect.height}), deferring view setup`);
      this.initialViewSetupPending = true;
    }
  }

  /**
   * Initialize layout settings based on display mode
   */
  private initializeDisplayMode(): void {
    const { displayMode } = this.config;

    switch (displayMode) {
      case 'paginated':
        // Fit as many pages as possible, calculate at runtime
        this.currentColumns = this.calculatePaginatedColumns();
        this.config.layoutMode = 'grid';
        this.config.pagesPerRow = this.currentColumns;
        break;

      case 'horizontal-scroll':
        // Single row, all pages
        this.currentColumns = this.pageCount;
        this.config.layoutMode = 'horizontal';
        this.config.pagesPerRow = this.pageCount;
        break;

      case 'vertical-scroll':
        // Single column
        this.currentColumns = 1;
        this.config.layoutMode = 'vertical';
        this.config.pagesPerRow = 1;
        break;

      case 'auto-grid':
        // Dynamic columns based on zoom (starts with 1)
        this.currentColumns = 1;
        this.config.layoutMode = 'vertical';
        this.config.pagesPerRow = 1;
        break;

      case 'canvas':
        // Fixed columns (8-12)
        this.currentColumns = this.config.canvasColumns;
        this.config.layoutMode = 'grid';
        this.config.pagesPerRow = this.currentColumns;
        break;
    }
  }

  /**
   * Calculate columns for paginated mode (fit as many as possible)
   */
  private calculatePaginatedColumns(): number {
    const viewportRect = this.viewport.getBoundingClientRect();
    if (viewportRect.width === 0 || viewportRect.height === 0) return 1;

    const { gap, padding } = this.config;

    // Get actual PDF dimensions from tile engine if available
    let { pageWidth, pageHeight } = this.config;
    if (this.tileEngine) {
      const dims = this.tileEngine.pageDimensions.get(1);
      if (dims) {
        pageWidth = dims.width;
        pageHeight = dims.height;
      }
    }
    const aspectRatio = pageWidth / pageHeight;

    // Calculate how many pages fit both horizontally and vertically
    const availableWidth = viewportRect.width - padding * 2;
    const availableHeight = viewportRect.height - padding * 2;

    // Try fitting with page height matching available height
    const fitHeight = availableHeight;
    const fitWidth = fitHeight * aspectRatio;

    // How many columns fit?
    const cols = Math.max(1, Math.floor((availableWidth + gap) / (fitWidth + gap)));

    // How many rows fit?
    const rows = Math.max(1, Math.floor((availableHeight + gap) / (fitHeight + gap)));

    // For paginated, we want to show cols * rows pages
    // Store this info for later
    return Math.min(cols, this.pageCount);
  }

  /**
   * Setup initial view based on display mode
   */
  private setupInitialView(): void {
    const { displayMode } = this.config;

    switch (displayMode) {
      case 'paginated':
        // Fit all visible pages in view
        this.fitPaginatedView();
        break;

      case 'horizontal-scroll':
        // Fit page height to viewport, start at page 1
        this.setupHorizontalScrollView();
        break;

      case 'vertical-scroll':
        // Fit page width to viewport, start at page 1
        this.setupVerticalScrollView();
        break;

      case 'auto-grid':
      case 'canvas':
        // Fit first page, then user can zoom out
        this.fitPageInView(1, false);
        break;
    }

    this.constrainCameraPosition();
    this.applyTransform();
  }

  /**
   * Complete deferred initial view setup.
   * Called by ResizeObserver when viewport dimensions become valid.
   */
  private completeInitialViewSetup(): void {
    // Recalculate layouts with proper viewport dimensions
    this.initializeDisplayMode();
    this.calculatePageLayouts();
    this.updateCanvasSize();

    // Update page element dimensions
    for (const [page, element] of this.pageElements) {
      const layout = this.pageLayouts.get(page);
      if (layout) {
        // UNIFIED COORDINATE SPACE: Dimensions are scaled by current zoom
        if (this.useUnifiedCoordinateSpace) {
          const zoom = this.camera.z;
          element.setFinalDimensions(layout.width * zoom, layout.height * zoom, zoom);
          const el = element.getElement();
          el.style.left = `${layout.x * zoom}px`;
          el.style.top = `${layout.y * zoom}px`;
        } else {
          element.setDimensions(layout.width, layout.height);
        }
      }
    }

    // Now setup the initial view with valid viewport dimensions
    this.setupInitialView();
    this.updateVisiblePages();
  }

  /**
   * Setup horizontal scroll view - fit page height to viewport
   */
  private setupHorizontalScrollView(): void {
    const viewportRect = this.viewport.getBoundingClientRect();
    const layout = this.pageLayouts.get(1);
    if (!layout || viewportRect.height === 0) return;

    const { padding } = this.config;
    const availableHeight = viewportRect.height - padding * 2;

    // Calculate zoom to fit page height
    const zoom = availableHeight / layout.height;

    // Position camera to show first page, centered vertically
    this.camera = {
      x: padding / zoom, // Start at left edge with padding
      y: viewportRect.height / (2 * zoom) - layout.height / 2,
      z: zoom,
    };
  }

  /**
   * Setup vertical scroll view - fit page width to viewport
   */
  private setupVerticalScrollView(): void {
    const viewportRect = this.viewport.getBoundingClientRect();
    const layout = this.pageLayouts.get(1);
    if (!layout || viewportRect.width === 0) return;

    const { padding } = this.config;
    const availableWidth = viewportRect.width - padding * 2;

    // Calculate zoom to fit page width
    const zoom = availableWidth / layout.width;

    // Position camera to show first page, centered horizontally
    this.camera = {
      x: viewportRect.width / (2 * zoom) - layout.width / 2,
      y: padding / zoom, // Start at top edge with padding
      z: zoom,
    };
  }

  /**
   * Fit paginated view to show all visible pages
   */
  private fitPaginatedView(): void {
    const viewportRect = this.viewport.getBoundingClientRect();
    if (viewportRect.width === 0) return;

    // Fit the entire visible grid in view
    const camera = fitBoxInView(
      { x: 0, y: 0, width: this.canvasBounds.width, height: this.canvasBounds.height },
      viewportRect.width,
      viewportRect.height,
      this.config.padding,
      this.cameraConstraints
    );

    // For paginated, we want to see full pages, so calculate zoom to fit
    const cols = this.currentColumns;
    const pageLayout = this.pageLayouts.get(1);
    if (!pageLayout) return;

    const rows = Math.ceil(Math.min(this.pageCount, cols * 3) / cols); // Show up to 3 rows
    const contentWidth = cols * pageLayout.width + (cols - 1) * this.config.gap;
    const contentHeight = rows * pageLayout.height + (rows - 1) * this.config.gap;

    const zoomX = (viewportRect.width - this.config.padding * 2) / contentWidth;
    const zoomY = (viewportRect.height - this.config.padding * 2) / contentHeight;
    const zoom = Math.min(zoomX, zoomY, 1); // Don't zoom in past 100%

    this.camera = {
      x: viewportRect.width / (2 * zoom) - contentWidth / 2,
      y: this.config.padding / zoom,
      z: zoom,
    };
  }

  /**
   * Calculate static page layouts
   * Pages are positioned once and never move
   *
   * PERF FIX: Now uses per-page dimensions instead of page 1's aspect ratio for all.
   * This fixes incorrect display of PDFs with mixed page sizes (e.g., landscape inserts).
   */
  private calculatePageLayouts(): void {
    this.pageLayouts.clear();

    const { gap, padding, layoutMode, pagesPerRow } = this.config;

    // Get page 1 dimensions as fallback for pages without explicit dimensions
    let { pageWidth: defaultWidth, pageHeight: defaultHeight } = this.config;
    if (this.tileEngine) {
      const dims = this.tileEngine.pageDimensions.get(1);
      if (dims) {
        defaultWidth = dims.width;
        defaultHeight = dims.height;
        // Update config to keep everything consistent
        this.config.pageWidth = defaultWidth;
        this.config.pageHeight = defaultHeight;
      }
    }

    // Calculate base width (all pages share same width for alignment)
    // Heights vary based on individual page aspect ratios
    const baseWidth = 400; // Canvas units at 100% zoom

    // Calculate fallback height from page 1 (used for layout constants)
    const defaultAspectRatio = defaultWidth / defaultHeight;
    const defaultBaseHeight = baseWidth / defaultAspectRatio;

    // Store layout constants for O(1) visible page calculation
    // Note: layoutBaseHeight is now approximate (average), used for fast estimates only
    this.layoutBaseWidth = baseWidth;
    this.layoutBaseHeight = defaultBaseHeight;
    this.layoutPadding = padding;
    this.layoutGap = gap;

    let x = padding;
    let y = padding;
    let row = 0;
    let col = 0;
    let maxRowHeight = 0;

    for (let page = 1; page <= this.pageCount; page++) {
      // Get per-page dimensions for correct aspect ratio
      let pageW = defaultWidth;
      let pageH = defaultHeight;
      if (this.tileEngine) {
        const pageDims = this.tileEngine.pageDimensions.get(page);
        if (pageDims) {
          pageW = pageDims.width;
          pageH = pageDims.height;
        }
      }

      // Calculate this page's height based on its individual aspect ratio
      const pageAspectRatio = pageW / pageH;
      const pageHeight = baseWidth / pageAspectRatio;

      this.pageLayouts.set(page, {
        page,
        x,
        y,
        width: baseWidth,
        height: pageHeight, // Per-page height, not uniform
      });

      maxRowHeight = Math.max(maxRowHeight, pageHeight);

      if (layoutMode === 'vertical') {
        // Vertical: stack pages vertically, using THIS page's height
        y += pageHeight + gap;
      } else if (layoutMode === 'horizontal') {
        // Horizontal: pages in a row
        x += baseWidth + gap;
      } else {
        // Grid: wrap to new row after pagesPerRow
        col++;
        if (col >= pagesPerRow) {
          col = 0;
          row++;
          x = padding;
          y += maxRowHeight + gap;
          maxRowHeight = 0;
        } else {
          x += baseWidth + gap;
        }
      }
    }

    // Calculate canvas bounds
    // For horizontal/grid modes, find max page height for bounds calculation
    let maxPageHeight = defaultBaseHeight;
    for (const layout of this.pageLayouts.values()) {
      maxPageHeight = Math.max(maxPageHeight, layout.height);
    }

    const lastLayout = this.pageLayouts.get(this.pageCount);
    if (lastLayout) {
      if (layoutMode === 'vertical') {
        this.canvasBounds = {
          width: baseWidth + padding * 2,
          height: lastLayout.y + lastLayout.height + padding,
        };
      } else if (layoutMode === 'horizontal') {
        this.canvasBounds = {
          width: lastLayout.x + lastLayout.width + padding,
          height: maxPageHeight + padding * 2, // Use tallest page for horizontal scroll
        };
      } else {
        // Grid - calculate actual height from last row
        // Last row may have variable heights, so use lastLayout position + height
        this.canvasBounds = {
          width: pagesPerRow * baseWidth + (pagesPerRow - 1) * gap + padding * 2,
          height: lastLayout.y + maxPageHeight + padding, // Use actual position + max height
        };
      }
    }

    // Update constraints
    this.cameraConstraints.bounds = this.canvasBounds;
  }

  /**
   * Update canvas element size
   */
  private updateCanvasSize(): void {
    this.canvas.style.width = `${this.canvasBounds.width}px`;
    this.canvas.style.height = `${this.canvasBounds.height}px`;
  }

  /**
   * Calculate optimal columns based on display mode and zoom level
   */
  private calculateOptimalColumns(): number {
    const { displayMode } = this.config;

    switch (displayMode) {
      case 'paginated':
        // Recalculate based on current viewport
        return this.calculatePaginatedColumns();

      case 'horizontal-scroll':
        // Always single row
        return this.pageCount;

      case 'vertical-scroll':
        // Always single column
        return 1;

      case 'auto-grid': {
        // Dynamic columns that fit in viewport at current zoom
        const viewportRect = this.viewport.getBoundingClientRect();
        if (viewportRect.width === 0) return 1;

        const { gap, padding } = this.config;
        const zoom = this.camera.z;

        // Available screen space for pages (excluding padding)
        const availableScreenWidth = viewportRect.width - padding * 2 * zoom;

        // Each page takes (BASE_PAGE_WIDTH * zoom) screen pixels
        const pageScreenWidth = BASE_PAGE_WIDTH * zoom;
        const gapScreenWidth = gap * zoom;

        // Calculate columns that fit
        const cols = Math.floor((availableScreenWidth + gapScreenWidth) / (pageScreenWidth + gapScreenWidth));

        return Math.max(1, Math.min(cols, this.pageCount));
      }

      case 'canvas':
        // Fixed columns
        return this.config.canvasColumns;

      default:
        return 1;
    }
  }

  /**
   * Check if layout needs to be recalculated based on zoom change
   */
  private shouldRelayout(): boolean {
    const { displayMode } = this.config;

    // Only auto-grid dynamically relayouts based on zoom
    if (displayMode !== 'auto-grid') {
      return false;
    }

    const optimalCols = this.calculateOptimalColumns();
    return optimalCols !== this.currentColumns;
  }

  /**
   * Relayout pages with new column count
   * @param focusPoint Optional screen point to keep stationary (e.g., cursor position)
   */
  private relayoutPages(focusPoint?: Point): void {
    const newColumns = this.calculateOptimalColumns();
    if (newColumns === this.currentColumns) return;

    const viewportRect = this.viewport.getBoundingClientRect();

    // Find the page and relative position under the focus point BEFORE relayout
    let focusPage: number | null = null;
    let relativeOffset: Point | null = null;

    if (focusPoint) {
      // Convert screen point to canvas coordinates
      const canvasPoint = {
        x: focusPoint.x / this.camera.z - this.camera.x,
        y: focusPoint.y / this.camera.z - this.camera.y,
      };

      // Find which page contains this point
      for (const [page, layout] of this.pageLayouts) {
        if (
          canvasPoint.x >= layout.x &&
          canvasPoint.x <= layout.x + layout.width &&
          canvasPoint.y >= layout.y &&
          canvasPoint.y <= layout.y + layout.height
        ) {
          focusPage = page;
          // Calculate relative position within the page (0-1 normalized)
          relativeOffset = {
            x: (canvasPoint.x - layout.x) / layout.width,
            y: (canvasPoint.y - layout.y) / layout.height,
          };
          break;
        }
      }

      // If point is not directly on a page, find the closest page
      if (!focusPage) {
        let minDist = Infinity;
        for (const [page, layout] of this.pageLayouts) {
          const pageCenterX = layout.x + layout.width / 2;
          const pageCenterY = layout.y + layout.height / 2;
          const dist = Math.hypot(canvasPoint.x - pageCenterX, canvasPoint.y - pageCenterY);
          if (dist < minDist) {
            minDist = dist;
            focusPage = page;
            relativeOffset = { x: 0.5, y: 0.5 }; // Center of page
          }
        }
      }
    }

    this.currentColumns = newColumns;
    this.lastLayoutZoom = this.camera.z;

    // Update pagesPerRow and layout mode
    this.config.pagesPerRow = newColumns;
    if (newColumns > 1) {
      this.config.layoutMode = 'grid';
    } else {
      this.config.layoutMode = 'vertical';
    }

    // Recalculate all page positions
    this.calculatePageLayouts();
    this.updateCanvasSize();

    // Reposition existing page elements
    for (const [page, element] of this.pageElements) {
      const layout = this.pageLayouts.get(page);
      if (layout) {
        const el = element.getElement();
        el.style.left = `${layout.x}px`;
        el.style.top = `${layout.y}px`;
      }
    }

    // Update camera constraints with new bounds
    this.cameraConstraints.bounds = this.canvasBounds;
    this.cameraConstraints.viewport = {
      width: viewportRect.width,
      height: viewportRect.height,
    };

    // If we have a focus point, adjust camera so the same page position is under it
    if (focusPage && relativeOffset && focusPoint) {
      const newLayout = this.pageLayouts.get(focusPage);
      if (newLayout) {
        // Calculate the canvas position that should be under the focus point
        const targetCanvasX = newLayout.x + relativeOffset.x * newLayout.width;
        const targetCanvasY = newLayout.y + relativeOffset.y * newLayout.height;

        // Adjust camera so this canvas point is at the focus screen point
        // Screen formula: screenX = (canvasX + camera.x) * camera.z
        // So: camera.x = screenX / camera.z - canvasX
        this.camera = {
          x: focusPoint.x / this.camera.z - targetCanvasX,
          y: focusPoint.y / this.camera.z - targetCanvasY,
          z: this.camera.z,
        };
      }
    }

    // Apply constraints
    this.constrainCameraPosition();
  }

  /**
   * Constrain camera position based on display mode
   *
   * HIGH ZOOM PAN FIX: At zoom > 1.5, allow free panning in all modes so users
   * can inspect any part of the page. Without this, vertical-scroll and auto-grid
   * modes lock horizontal position, making it impossible to pan at 16x zoom.
   */
  private constrainCameraPosition(): void {
    const viewportRect = this.viewport.getBoundingClientRect();
    if (viewportRect.width === 0 || viewportRect.height === 0) return;

    // PHASE 0: Capture camera state before constraint for debugging
    const cameraBefore = { ...this.camera };

    const { z } = this.camera;
    let { x, y } = this.camera;

    const vpWidth = viewportRect.width;
    const vpHeight = viewportRect.height;

    // UNIFIED COORDINATE SPACE FIX:
    // In unified mode, canvasBounds is already zoomed (screen pixels).
    // In legacy mode, canvasBounds is base size (content coordinates at zoom=1).
    if (this.useUnifiedCoordinateSpace) {
      // UNIFIED MODE: canvasBounds is zoomed, camera is screen pixels
      const contentWidth = this.canvasBounds.width;   // Already zoomed
      const contentHeight = this.canvasBounds.height; // Already zoomed

      // Camera x/y are screen pixel offsets (how much to translate)
      // Transform: translate(-x, -y) moves content left/up by x/y pixels
      //
      // Constraint logic:
      // - camera.x = 0 means left edge of content is at left edge of viewport
      // - camera.x = contentWidth - vpWidth means right edge of content is at right edge of viewport
      // - We want content to always fill the viewport when possible

      if (contentWidth <= vpWidth) {
        // Content fits in viewport - center it
        // With transform translate(-x, -y), positive x shifts content LEFT
        // To center: we want (vpWidth - contentWidth)/2 gap on left, so x = -(vpWidth - contentWidth)/2
        x = (contentWidth - vpWidth) / 2;
      } else {
        // Content larger than viewport - constrain to edges
        const minX = 0;  // Left edge visible
        const maxX = contentWidth - vpWidth;  // Right edge visible
        x = Math.max(minX, Math.min(maxX, x));
      }

      if (contentHeight <= vpHeight) {
        // Content fits in viewport - center it vertically
        y = (contentHeight - vpHeight) / 2;
      } else {
        // Content larger than viewport - constrain to edges
        const minY = 0;  // Top edge visible
        const maxY = contentHeight - vpHeight;  // Bottom edge visible
        y = Math.max(minY, Math.min(maxY, y));
      }

      this.camera = { x, y, z };

      // PHASE 0: Record constraint for unified mode
      const constrained = cameraBefore.x !== x || cameraBefore.y !== y;
      getCoordinateDebugger().recordConstraint(
        {
          cameraBefore,
          canvasBounds: { ...this.canvasBounds },
          viewportWidth: vpWidth,
          viewportHeight: vpHeight,
          unifiedMode: true,
        },
        {
          cameraAfter: { ...this.camera },
          constrained,
          constraintType: constrained
            ? (cameraBefore.x !== x && cameraBefore.y !== y ? 'both' : cameraBefore.x !== x ? 'x' : 'y')
            : 'none',
        }
      );
      return;
    }

    // LEGACY MODE: canvasBounds is base size, camera is content coordinates
    const contentWidth = this.canvasBounds.width;
    const contentHeight = this.canvasBounds.height;

    const contentScreenWidth = contentWidth * z;
    const contentScreenHeight = contentHeight * z;
    const { displayMode } = this.config;

    // HIGH ZOOM PAN FIX: At high zoom, allow free panning regardless of display mode.
    // This matches the allowFreePan logic in handleWheel. Without this, the constraints
    // would snap the camera back, overriding user pan attempts at 16x zoom.
    const useFreePanConstraints = z > 1.5;

    if (useFreePanConstraints) {
      // Free panning mode - only constrain to keep content visible
      if (contentScreenWidth <= vpWidth) {
        x = vpWidth / (2 * z) - contentWidth / 2;
      } else {
        const minX = vpWidth / z - contentWidth;
        const maxX = 0;
        x = Math.max(minX, Math.min(maxX, x));
      }

      if (contentScreenHeight <= vpHeight) {
        y = vpHeight / (2 * z) - contentHeight / 2;
      } else {
        const minY = vpHeight / z - contentHeight;
        const maxY = 0;
        y = Math.max(minY, Math.min(maxY, y));
      }
    } else {
      // Normal mode - apply display-mode-specific constraints
      switch (displayMode) {
        case 'paginated':
          // No panning allowed - content is always centered and fixed
          x = vpWidth / (2 * z) - contentWidth / 2;
          y = vpHeight / (2 * z) - contentHeight / 2;
          break;

        case 'horizontal-scroll':
          // Fixed vertical (page height), horizontal panning allowed
          // Center vertically
          y = vpHeight / (2 * z) - contentHeight / 2;

          // Horizontal: constrain to content bounds
          if (contentScreenWidth <= vpWidth) {
            x = vpWidth / (2 * z) - contentWidth / 2;
          } else {
            const minX = vpWidth / z - contentWidth;
            const maxX = 0;
            x = Math.max(minX, Math.min(maxX, x));
          }
          break;

        case 'vertical-scroll':
          // Fixed horizontal (page width), vertical panning allowed
          // Center horizontally
          x = vpWidth / (2 * z) - contentWidth / 2;

          // Vertical: constrain to content bounds
          if (contentScreenHeight <= vpHeight) {
            y = vpHeight / (2 * z) - contentHeight / 2;
          } else {
            const minY = vpHeight / z - contentHeight;
            const maxY = 0;
            y = Math.max(minY, Math.min(maxY, y));
          }
          break;

        case 'auto-grid':
          // Grid always fits width, center horizontally, vertical pan allowed
          x = vpWidth / (2 * z) - contentWidth / 2;

          if (contentScreenHeight <= vpHeight) {
            y = vpHeight / (2 * z) - contentHeight / 2;
          } else {
            const minY = vpHeight / z - contentHeight;
            const maxY = 0;
            y = Math.max(minY, Math.min(maxY, y));
          }
          break;

        case 'canvas':
          // Free panning, but constrain to keep content visible
          if (contentScreenWidth <= vpWidth) {
            x = vpWidth / (2 * z) - contentWidth / 2;
          } else {
            const minX = vpWidth / z - contentWidth;
            const maxX = 0;
            x = Math.max(minX, Math.min(maxX, x));
          }

          if (contentScreenHeight <= vpHeight) {
            y = vpHeight / (2 * z) - contentHeight / 2;
          } else {
            const minY = vpHeight / z - contentHeight;
            const maxY = 0;
            y = Math.max(minY, Math.min(maxY, y));
          }
          break;
      }
    }

    this.camera = { x, y, z };

    // PHASE 0: Record constraint for legacy mode
    const constrained = cameraBefore.x !== x || cameraBefore.y !== y;
    getCoordinateDebugger().recordConstraint(
      {
        cameraBefore,
        canvasBounds: { ...this.canvasBounds },
        viewportWidth: vpWidth,
        viewportHeight: vpHeight,
        unifiedMode: false,
      },
      {
        cameraAfter: { ...this.camera },
        constrained,
        constraintType: constrained
          ? (cameraBefore.x !== x && cameraBefore.y !== y ? 'both' : cameraBefore.x !== x ? 'x' : 'y')
          : 'none',
      }
    );
  }

  /**
   * Get zoom constraints for current display mode
   */
  private getZoomConstraints(): { minZoom: number; maxZoom: number } {
    const viewportRect = this.viewport.getBoundingClientRect();
    const layout = this.pageLayouts.get(1);
    const { displayMode, padding } = this.config;

    let minZoom = this.config.minZoom;
    let maxZoom = this.config.maxZoom;

    if (!layout || viewportRect.width === 0 || viewportRect.height === 0) {
      return { minZoom, maxZoom };
    }

    switch (displayMode) {
      case 'paginated': {
        // Paginated mode: fit page to viewport at minZoom, allow zoom in up to maxZoom
        const availableHeightP = viewportRect.height - padding * 2;
        const availableWidthP = viewportRect.width - padding * 2;
        // Fit to page (min of fit-width and fit-height)
        const fitWidthZoom = availableWidthP / layout.width;
        const fitHeightZoom = availableHeightP / layout.height;
        minZoom = Math.min(fitWidthZoom, fitHeightZoom);
        // Allow zooming in up to config maxZoom
        break;
      }

      case 'horizontal-scroll': {
        // Min zoom = fit page height, allow zoom in up to maxZoom
        const availableHeight = viewportRect.height - padding * 2;
        minZoom = Math.max(this.config.minZoom, availableHeight / layout.height);
        break;
      }

      case 'vertical-scroll': {
        // Min zoom = fit page height (so you can see whole page when zoomed out)
        // Max zoom = renderer's max zoom
        const availableHeightV = viewportRect.height - padding * 2;
        minZoom = Math.max(this.config.minZoom, availableHeightV / layout.height);
        break;
      }

      case 'auto-grid':
        // Allow zoom out (more columns), unlimited zoom in
        // No special constraints beyond config
        break;

      case 'canvas':
        // Free zoom, no special constraints
        break;
    }

    return { minZoom, maxZoom };
  }

  /**
   * Apply camera transform to canvas
   *
   * In unified coordinate space (Phase 2), uses translate-only transform.
   * In legacy mode, uses scale + translate transform.
   */
  private applyTransform(): void {
    this.canvas.style.transform = getCameraTransform(this.camera, this.useUnifiedCoordinateSpace);
  }

  /**
   * Update visible pages based on camera position
   *
   * PERFORMANCE OPTIMIZATION: Uses O(1) page range calculation instead of O(N) iteration.
   * For a 945-page PDF, this reduces per-frame work from ~11,000 bounds checks to ~20.
   *
   * Key optimization: Uses 3-tier buffer system to eliminate blank pages:
   * 1. Core visible zone (no buffer): Pages actively in viewport
   * 2. Render buffer (800px): Pages that should be rendered immediately
   * 3. Element creation buffer (1600px): Pages that should have DOM elements ready
   * 4. Keep buffer (2400px): Pages to retain (prevents thrashing during fast scroll)
   */

  // ============================================================================
  // PHASE 1: UNIFIED COORDINATE SPACE VISIBILITY HELPER
  // ============================================================================

  /**
   * Get visible bounds using the appropriate calculation for the current coordinate space mode.
   *
   * UNIFIED MODE (V4 Architecture):
   * - Pages are sized to final zoomed dimensions
   * - Camera x/y are in screen pixels
   * - Visible bounds = camera position + viewport dimensions
   * - No zoom scaling in visibility calculation
   *
   * LEGACY MODE:
   * - Pages are at base size, camera scales via CSS transform
   * - Camera x/y are in content coordinates (divided by zoom)
   * - Visible bounds = viewport / zoom (in content coordinates)
   *
   * @param camera The camera state to use (may be a snapshot)
   * @param width Viewport width in pixels
   * @param height Viewport height in pixels
   * @returns Visible bounds in the appropriate coordinate space
   */
  private getVisibleBoundsForMode(
    camera: Camera,
    width: number,
    height: number
  ): { x: number; y: number; width: number; height: number } {
    if (this.useUnifiedCoordinateSpace) {
      return getVisibleBoundsUnified(camera, width, height);
    }
    return getVisibleBounds(camera, width, height);
  }

  // ============================================================================
  // PHASE 2: UNIFIED COORDINATE SPACE PAN HELPER
  // ============================================================================

  /**
   * Pan the camera using the appropriate calculation for the current coordinate space mode.
   *
   * UNIFIED MODE (V4 Architecture):
   * - Camera x/y are in screen pixels
   * - Delta is applied directly (no zoom scaling)
   * - Sign convention: positive dx moves viewport right (camera.x increases)
   *
   * LEGACY MODE:
   * - Camera x/y are in content coordinates (scaled by 1/zoom)
   * - Delta is divided by zoom for consistent movement feel
   * - Sign convention: same as panCamera()
   *
   * @param dx Delta X in screen pixels
   * @param dy Delta Y in screen pixels
   * @param invertSign Whether to invert the delta signs (for drag vs scroll)
   */
  private panWithMode(dx: number, dy: number, invertSign = false): void {
    // Guard against invalid camera zoom (prevents Infinity/NaN from panCamera division)
    if (this.camera.z <= 0 || !isFinite(this.camera.z)) {
      console.warn('[PdfInfiniteCanvas] Invalid camera zoom, skipping pan:', this.camera.z);
      return;
    }

    const sign = invertSign ? -1 : 1;
    const effectiveDx = sign * dx;
    const effectiveDy = sign * dy;

    if (this.useUnifiedCoordinateSpace) {
      this.camera = panCameraUnified(this.camera, effectiveDx, effectiveDy);
    } else {
      // Legacy mode - use effectiveDx/Dy consistently (panCamera divides by zoom internally)
      this.camera = panCamera(this.camera, effectiveDx, effectiveDy);
    }

    // Record pan operation for debugging
    getCoordinateDebugger().recordPan(
      { dx: effectiveDx, dy: effectiveDy, invertSign, unifiedMode: this.useUnifiedCoordinateSpace },
      { camera: { ...this.camera } }
    );
  }

  private updateVisiblePages(): void {
    // ZOOM STATE GUARD: Block ALL visible page updates during zoom gestures.
    // This is the SINGLE CHOKE POINT that all code paths flow through:
    // - handleWheel scroll path (scheduleVisiblePagesUpdate → RAF → here)
    // - Direct calls (inertia animation, resize, display mode change)
    //
    // By guarding HERE instead of in triggerTilePrefetch(), we block ALL
    // render paths during 'zooming' and 'settling' phases. The triggerTilePrefetch
    // guard was bypassed by scroll events during zoom gestures.
    if (!this.zoomStateMachine.canRender()) {
      console.log(`[PdfInfiniteCanvas] updateVisiblePages blocked - state: ${this.zoomStateMachine.getCurrentState()}`);
      return;
    }

    // PERF FIX: Use cached viewport rect to avoid layout thrashing during scroll.
    // getBoundingClientRect() forces a layout reflow which causes scroll jank.
    const viewportRect = this.getViewportRect();
    // PHASE 1: Use mode-aware visibility calculation (V4 Architecture)
    const visibleBounds = this.getVisibleBoundsForMode(
      this.camera,
      viewportRect.width,
      viewportRect.height
    );

    const newVisiblePages = new Set<number>();
    const newRenderPages = new Set<number>();

    // 3-tier buffer system (in canvas units, adjusted for zoom)
    // Buffers scale inversely with zoom but have MINIMUM FLOORS to ensure
    // smooth scrolling at high zoom. Without floors, 16x zoom gives only
    // 75px render buffer, causing placeholders during momentum scroll.
    //
    // Buffer zones:
    // - renderBuffer: Tiles to render immediately (priority queue)
    // - elementBuffer: DOM elements to have ready (faster tile attach)
    // - keepBuffer: Elements to retain (prevents thrashing on scroll-back)
    //
    // Minimum floors ALIGNED TO TILE BOUNDARIES (256px tile size):
    // - MIN_RENDER_BUFFER = 256px = 1 complete tile
    // - MIN_ELEMENT_BUFFER = 512px = 2 complete tiles
    // - MIN_KEEP_BUFFER = 768px = 3 complete tiles
    //
    // Minimum floors kick in at 1200/256 ≈ 4.7x zoom (above tileZoomThreshold of 2.0x).
    // This ensures buffers always cover at least N complete tiles at high zoom.
    const { renderBuffer, elementBuffer, keepBuffer } = this.calculateBufferSizes(this.camera.z);

    // O(1) page range calculation based on layout mode
    const { layoutMode, pagesPerRow } = this.config;
    const cellWidth = this.layoutBaseWidth + this.layoutGap;
    const cellHeight = this.layoutBaseHeight + this.layoutGap;
    const padding = this.layoutPadding;

    // Calculate page ranges for element buffer (largest zone)
    const elementPages = this.calculatePagesInBounds(
      visibleBounds.x - elementBuffer,
      visibleBounds.y - elementBuffer,
      visibleBounds.width + elementBuffer * 2,
      visibleBounds.height + elementBuffer * 2,
      layoutMode,
      pagesPerRow,
      cellWidth,
      cellHeight,
      padding
    );

    // Calculate page ranges for render buffer
    const renderPages = this.calculatePagesInBounds(
      visibleBounds.x - renderBuffer,
      visibleBounds.y - renderBuffer,
      visibleBounds.width + renderBuffer * 2,
      visibleBounds.height + renderBuffer * 2,
      layoutMode,
      pagesPerRow,
      cellWidth,
      cellHeight,
      padding
    );

    // Populate sets from calculated ranges
    for (const page of renderPages) {
      newVisiblePages.add(page);
      newRenderPages.add(page);
    }
    for (const page of elementPages) {
      if (!newRenderPages.has(page)) {
        newRenderPages.add(page);
      }
    }

    // PHASE 0: Record visibility calculation for debugging
    getCoordinateDebugger().recordVisibility(
      {
        camera: this.camera,
        viewportWidth: viewportRect.width,
        viewportHeight: viewportRect.height,
        unifiedMode: this.useUnifiedCoordinateSpace,
      },
      {
        visibleBounds,
        pageCount: newVisiblePages.size,
      }
    );

    // Create elements for all pages in element zone
    for (const page of newRenderPages) {
      if (!this.pageElements.has(page)) {
        this.createPageElement(page);
      }
    }

    // Remove elements for pages outside keep buffer - only iterate existing elements (small set)
    const keepPages = this.calculatePagesInBounds(
      visibleBounds.x - keepBuffer,
      visibleBounds.y - keepBuffer,
      visibleBounds.width + keepBuffer * 2,
      visibleBounds.height + keepBuffer * 2,
      layoutMode,
      pagesPerRow,
      cellWidth,
      cellHeight,
      padding
    );
    const keepSet = new Set(keepPages);

    for (const [page, element] of this.pageElements) {
      if (!keepSet.has(page)) {
        element.destroy();
        this.pageElements.delete(page);
      }
    }

    // Identify immediate neighbors of current page for priority rendering
    const centerPage = this.getCurrentPage();
    const immediateNeighbors: number[] = [];
    for (let offset = -2; offset <= 2; offset++) {
      const neighborPage = centerPage + offset;
      if (neighborPage >= 1 && neighborPage <= this.pageCount && newRenderPages.has(neighborPage)) {
        immediateNeighbors.push(neighborPage);
      }
    }

    this.visiblePages = newVisiblePages;

    // Queue rendering with priority for immediate neighbors
    this.queueRenderWithPriority(immediateNeighbors, [...newRenderPages]);

    // Prefetch pages based on display mode:
    // - Spatial modes (auto-grid, canvas): 2D ripple prefetch based on grid distance
    // - Linear modes (paginated, vertical-scroll, horizontal-scroll): page ± N prefetch
    if (newVisiblePages.size > 0) {
      this.triggerPrefetch(centerPage);
    }

    // Tile-based prefetching when in tiled mode (strategy decides)
    if (this.useTiledRendering && this.renderCoordinator?.shouldUseTiling(this.camera.z)) {
      this.triggerTilePrefetch();
    }
  }

  /**
   * Trigger tile prefetching for visible viewport
   * Only called when in tiled rendering mode (zoom > threshold)
   *
   * NOW WIRED: Uses coordinator's strategy-based prefetching:
   * - Scroll mode: velocity-based prediction, dynamic resolution
   * - Paginated mode: current viewport only
   */
  private triggerTilePrefetch(): void {
    if (!this.renderCoordinator || !this.tileEngine) return;

    // ZOOM STATE GUARD: Skip tile prefetch during active zoom gestures.
    // ZoomStateMachine provides centralized state - canRender() returns false
    // during 'zooming' and 'settling' phases. This prevents queue saturation
    // from scale changes on every frame (s8→s12→s16).
    if (!this.zoomStateMachine.canRender()) {
      return;
    }

    // Use canvas coordinates for prefetch calculation
    const screenRect = this.getViewportRect();
    // PHASE 1: Use mode-aware visibility calculation (V4 Architecture)
    const canvasViewport = this.getVisibleBoundsForMode(this.camera, screenRect.width, screenRect.height);
    const zoom = this.camera.z;

    // OPTIMIZATION: Only check pages that could intersect viewport
    // Add buffer for prefetch (2 viewport heights ahead)
    const expandedViewport = {
      ...canvasViewport,
      y: canvasViewport.y - canvasViewport.height,
      height: canvasViewport.height * 4,
    };
    const layouts = Array.from(this.pageLayouts.values()).filter(layout =>
      layout.y + layout.height >= expandedViewport.y &&
      layout.y <= expandedViewport.y + expandedViewport.height
    );

    // Get velocity-aware tile scale with pixelRatio for crisp rendering
    // Tiles are small (256×256) so can render at high scale without OOM
    // At zoom 16x with pixelRatio 2, scale = 32 for crisp display
    const MAX_TILE_SCALE = 32;
    const rawScale = this.renderCoordinator.getTileScale(zoom, this.config.pixelRatio, this.velocity);
    const tileScale = Math.min(MAX_TILE_SCALE, rawScale);

    // Get visible tiles for current viewport with proper scale
    const visibleTiles = this.tileEngine.getVisibleTiles(canvasViewport, layouts, zoom, tileScale);

    // Queue critical tile requests (visible tiles)
    for (const tile of visibleTiles) {
      // Override scale based on velocity
      const adjustedTile = { ...tile, scale: tileScale };
      this.renderCoordinator.requestRender({
        type: 'tile' as const,
        tile: adjustedTile,
        priority: 'critical',
        documentId: this.documentId ?? undefined,
        sessionId: this.pendingSessionId,
      }).catch(() => {
        // Ignore render failures
      });
    }

    // Get prefetch tiles from strategy (velocity-based prediction)
    const prefetchTiles = this.renderCoordinator.getPrefetchTiles(
      canvasViewport,
      layouts,
      this.velocity,
      zoom
    );

    // Queue prefetch requests at lower priority
    for (const tile of prefetchTiles) {
      this.renderCoordinator.requestRender({
        type: 'tile' as const,
        tile,
        priority: 'low',
        documentId: this.documentId ?? undefined,
        sessionId: this.pendingSessionId,
      }).catch(() => {
        // Ignore prefetch failures
      });
    }
  }

  /**
   * Calculate which pages fall within given bounds using O(1) math.
   * Instead of iterating all pages, calculates row/column ranges based on grid layout.
   */
  private calculatePagesInBounds(
    boundsX: number,
    boundsY: number,
    boundsWidth: number,
    boundsHeight: number,
    layoutMode: 'vertical' | 'horizontal' | 'grid',
    pagesPerRow: number,
    cellWidth: number,
    cellHeight: number,
    padding: number
  ): number[] {
    const pages: number[] = [];

    if (layoutMode === 'vertical') {
      // Single column layout - only need to calculate row range
      const firstRow = Math.max(0, Math.floor((boundsY - padding) / cellHeight));
      const lastRow = Math.min(
        this.pageCount - 1,
        Math.ceil((boundsY + boundsHeight - padding) / cellHeight)
      );

      for (let row = firstRow; row <= lastRow; row++) {
        const page = row + 1;
        if (page >= 1 && page <= this.pageCount) {
          pages.push(page);
        }
      }
    } else if (layoutMode === 'horizontal') {
      // Single row layout - only need to calculate column range
      const firstCol = Math.max(0, Math.floor((boundsX - padding) / cellWidth));
      const lastCol = Math.min(
        this.pageCount - 1,
        Math.ceil((boundsX + boundsWidth - padding) / cellWidth)
      );

      for (let col = firstCol; col <= lastCol; col++) {
        const page = col + 1;
        if (page >= 1 && page <= this.pageCount) {
          pages.push(page);
        }
      }
    } else {
      // Grid layout - calculate both row and column ranges
      const firstRow = Math.max(0, Math.floor((boundsY - padding) / cellHeight));
      const lastRow = Math.ceil((boundsY + boundsHeight - padding) / cellHeight);
      const firstCol = Math.max(0, Math.floor((boundsX - padding) / cellWidth));
      const lastCol = Math.min(pagesPerRow - 1, Math.ceil((boundsX + boundsWidth - padding) / cellWidth));

      for (let row = firstRow; row <= lastRow; row++) {
        for (let col = firstCol; col <= lastCol; col++) {
          const page = row * pagesPerRow + col + 1;
          if (page >= 1 && page <= this.pageCount) {
            pages.push(page);
          }
        }
      }
    }

    return pages;
  }

  /**
   * Trigger prefetch based on current display mode
   *
   * NOW WIRED: Uses coordinator's strategy-based prefetching:
   * - Paginated: prefetch ±1 pages via strategy
   * - Scroll: handled by triggerTilePrefetch (velocity-based)
   * - Grid: 2D ripple prefetch via SpatialPrefetcher
   *
   * Velocity-Aware: During fast scroll, reduce prefetch radius.
   */
  private triggerPrefetch(centerPage: number): void {
    const isSpatialMode =
      this.config.displayMode === 'auto-grid' ||
      this.config.displayMode === 'canvas';

    if (isSpatialMode) {
      // Calculate scroll speed for adaptive radius
      const scrollSpeed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);

      // Adaptive radius based on scroll velocity
      const FAST_SCROLL_THRESHOLD = 10;
      const MEDIUM_SCROLL_THRESHOLD = 3;

      let prefetchRadius: number;
      if (scrollSpeed > FAST_SCROLL_THRESHOLD) {
        prefetchRadius = 1;
      } else if (scrollSpeed > MEDIUM_SCROLL_THRESHOLD) {
        prefetchRadius = 2;
      } else {
        prefetchRadius = 4;
      }

      // SPATIAL: Ripple prefetch based on grid position
      const spatialPages = this.spatialPrefetcher.getSpatialPrefetchList({
        centerPage,
        radius: prefetchRadius,
        columns: this.currentColumns,
        pageCount: this.pageCount,
      });

      // Filter out already-visible pages and queue for background render
      const pagesToPrefetch = spatialPages.filter((p: number) => !this.visiblePages.has(p));
      this.queueBackgroundPrefetch(pagesToPrefetch);

    } else if (this.renderCoordinator) {
      // STRATEGY-BASED: Use coordinator's strategy for prefetch list
      const prefetchPages = this.renderCoordinator.getPrefetchPages(centerPage, this.pageCount);
      const pagesToPrefetch = prefetchPages.filter(p => !this.visiblePages.has(p));
      this.queueBackgroundPrefetch(pagesToPrefetch);

    } else if (this.provider.notifyPageChange) {
      // FALLBACK: Standard page notification
      this.provider.notifyPageChange(centerPage);
    }
  }

  /**
   * Queue pages for background prefetch rendering
   * Renders pages at low priority to warm the cache
   */
  private queueBackgroundPrefetch(pages: number[]): void {
    for (const page of pages) {
      // Queue render to warm cache (fire and forget)
      const options: PdfRenderOptions = {
        scale: window.devicePixelRatio || 1,
      };

      // Fire and forget - we don't need the result, just warming cache
      this.provider.getPageImage(page, options).catch(() => {
        // Ignore prefetch failures
      });
    }
  }

  /**
   * Create a page element at its fixed position
   */
  private createPageElement(page: number): void {
    const layout = this.pageLayouts.get(page);
    if (!layout) return;

    const element = new PdfPageElement({
      pageNumber: page,
      pixelRatio: this.config.pixelRatio,
      enableTextAntialiasing: true,
      enableImageSmoothing: true,
      useSvgTextLayer: true, // Enable vector-crisp text at any zoom
    });

    // Set reading mode
    element.setReadingMode(this.config.readingMode);

    // Wire up callbacks
    element.setOnSelection((p, text, rects) => {
      this.onSelectionCallback?.(p, text, rects);
    });

    element.setOnHighlightClick((annotationId, position) => {
      this.onHighlightClickCallback?.(annotationId, position);
    });

    // Position at canvas coordinates (scaled by zoom in unified mode)
    const el = element.getElement();
    el.style.position = 'absolute';

    // UNIFIED COORDINATE SPACE: Position and size are scaled by current zoom
    if (this.useUnifiedCoordinateSpace) {
      const zoom = this.camera.z;
      el.style.left = `${layout.x * zoom}px`;
      el.style.top = `${layout.y * zoom}px`;
      element.setFinalDimensions(layout.width * zoom, layout.height * zoom, zoom);
    } else {
      el.style.left = `${layout.x}px`;
      el.style.top = `${layout.y}px`;
      element.setDimensions(layout.width, layout.height);
    }

    this.pageElements.set(page, element);
    this.canvas.appendChild(el);
  }

  /**
   * Queue pages for rendering with priority support
   *
   * Priority pages (immediate neighbors of current page) are rendered first
   * to eliminate blank pages during scroll/zoom.
   */
  private queueRenderWithPriority(priorityPages: number[], allPages: number[]): void {
    // ZOOM STATE GUARD: Skip page queuing during active zoom gestures.
    // ZoomStateMachine provides centralized state - canRender() returns false
    // during 'zooming' and 'settling' phases, preventing competing renders.
    if (!this.zoomStateMachine.canRender()) {
      return;
    }

    // Sort by distance from viewport center
    const viewportRect = this.viewport.getBoundingClientRect();
    const centerX = viewportRect.width / 2;
    const centerY = viewportRect.height / 2;

    const sortByDistance = (pages: number[]) => {
      return pages.sort((a, b) => {
        const layoutA = this.pageLayouts.get(a);
        const layoutB = this.pageLayouts.get(b);
        if (!layoutA || !layoutB) return 0;

        // Convert page centers to screen coordinates
        const pageACenterX = (layoutA.x + layoutA.width / 2 + this.camera.x) * this.camera.z;
        const pageACenterY = (layoutA.y + layoutA.height / 2 + this.camera.y) * this.camera.z;
        const pageBCenterX = (layoutB.x + layoutB.width / 2 + this.camera.x) * this.camera.z;
        const pageBCenterY = (layoutB.y + layoutB.height / 2 + this.camera.y) * this.camera.z;

        const distA = Math.hypot(pageACenterX - centerX, pageACenterY - centerY);
        const distB = Math.hypot(pageBCenterX - centerX, pageBCenterY - centerY);

        return distA - distB;
      });
    };

    // Clear priority queue and add sorted priority pages
    this.priorityRenderQueue = [];
    const sortedPriority = sortByDistance([...priorityPages]);
    for (const page of sortedPriority) {
      if (!this.priorityRenderQueue.includes(page) && !this.renderQueue.includes(page)) {
        this.priorityRenderQueue.push(page);
      }
    }

    // Add remaining pages to regular queue
    const remainingPages = allPages.filter(p => !priorityPages.includes(p));
    const sortedRemaining = sortByDistance(remainingPages);
    for (const page of sortedRemaining) {
      if (!this.renderQueue.includes(page) && !this.priorityRenderQueue.includes(page)) {
        this.renderQueue.push(page);
      }
    }

    this.processRenderQueue();
  }

  /**
   * Queue pages for rendering (legacy method, uses priority queue internally)
   */
  private queueRender(pages: number[]): void {
    this.queueRenderWithPriority([], pages);
  }

  /**
   * Process render queue with concurrent rendering and priority support
   *
   * Performance optimization: Renders multiple pages in parallel instead of
   * sequentially. Priority pages (immediate neighbors) are rendered first
   * with higher concurrency (5 slots) to eliminate blank pages during scrolling.
   * Uses streaming approach where new renders start as soon as slots become
   * available (no convoy effect).
   */
  private async processRenderQueue(): Promise<void> {
    const hasWork = this.priorityRenderQueue.length > 0 || this.renderQueue.length > 0;
    // DEBUG: Log render queue processing
    console.log(`[PdfInfiniteCanvas] processRenderQueue: hasWork=${hasWork}, isRendering=${this.isRendering}, priorityQueue=${this.priorityRenderQueue.length}, regularQueue=${this.renderQueue.length}`);
    if (this.isRendering || !hasWork) return;

    this.isRendering = true;
    const currentVersion = ++this.renderVersion;

    // Scale concurrent renders with worker pool (2x workers, capped at 12)
    const pool = getCanvasPool();
    const CONCURRENT_RENDERS = Math.min(pool.workerCount * 2 || 5, 12);
    const activeRenders = new Map<number, Promise<void>>();

    const getNextPage = (): number | null => {
      // Helper to check if page needs rendering (not rendered OR needs zoom rerender)
      const needsRender = (page: number, element: PdfPageElement): boolean => {
        if (!element.getIsRendered()) return true;
        // Also render if zoom changed and cached scale is insufficient
        return this.needsZoomRerender(page);
      };

      // Priority queue first (immediate neighbors)
      while (this.priorityRenderQueue.length > 0) {
        const page = this.priorityRenderQueue.shift()!;
        const element = this.pageElements.get(page);
        // Render if not rendered OR if zoom changed requiring higher resolution
        if (element && needsRender(page, element) && !activeRenders.has(page)) {
          return page;
        }
      }

      // Then regular queue
      while (this.renderQueue.length > 0) {
        const page = this.renderQueue.shift()!;
        const element = this.pageElements.get(page);
        if (element && needsRender(page, element) && !activeRenders.has(page)) {
          return page;
        }
      }

      return null;
    };

    const startNextRender = (): void => {
      while (activeRenders.size < CONCURRENT_RENDERS && this.renderVersion === currentVersion) {
        const page = getNextPage();
        if (page === null) break;

        const element = this.pageElements.get(page);
        if (!element) continue;

        // Start render and track it
        const renderPromise = this.renderPage(page, element, currentVersion)
          .finally(() => {
            activeRenders.delete(page);
            // Start next render as soon as slot becomes available (streaming)
            if (this.renderVersion === currentVersion) {
              startNextRender();
            }
          });

        activeRenders.set(page, renderPromise);
      }
    };

    // Start initial batch of renders
    startNextRender();

    // Wait for all active renders to complete
    while (activeRenders.size > 0 && this.renderVersion === currentVersion) {
      await Promise.race(activeRenders.values());
    }

    this.isRendering = false;

    // Clear scroll render snapshot after all renders complete
    // This ensures the snapshot is only used for the render batch it was created for
    this.scrollRenderSnapshot = null;
  }

  /**
   * Render a single page with dual-resolution strategy.
   *
   * Implementation of "never show blank pages":
   * 1. If dual-res API is available, use it to get best cached version immediately
   * 2. Display whatever we have (even if low-res thumbnail)
   * 3. When upgrade completes, re-render with higher quality
   */
  private async renderPage(
    page: number,
    element: PdfPageElement,
    version: number
  ): Promise<void> {
    if (this.renderVersion !== version) return;

    // CRITICAL FIX: Use consistent zoom from snapshot (same pattern as visible pages calculation)
    // This ensures zoom for tile calculations matches the viewport from which tiles were determined.
    // Priority: state machine snapshot > scroll snapshot > current camera
    const effectiveCamera = this.zoomStateMachine.getZoomSnapshot()?.camera ??
                            this.scrollRenderSnapshot?.camera ??
                            this.camera;
    const zoom = effectiveCamera.z;
    const layout = this.pageLayouts.get(page);

    // Tiling decision: use tiles at high zoom for crisp rendering
    // - Tiles can render at scale 32 (zoom 16x * pixelRatio 2) without OOM
    // - Full pages cap at scale 8 to avoid memory issues
    // - Coordinate conversion now properly handles canvas→PDF units
    const shouldTile = this.tileEngine &&
                       this.renderCoordinator &&
                       layout &&
                       zoom > 4.0;

    // DEBUG: Log render path decision

    if (shouldTile) {
      await this.renderPageTiled(page, element, layout, zoom, version);
    } else {
      await this.renderPageFull(page, element, version);
    }
  }

  /**
   * Render a page using tile-based rendering (CATiledLayer-style)
   * Used when zoom > threshold for crisp rendering at high magnification
   */
  private async renderPageTiled(
    page: number,
    element: PdfPageElement,
    layout: PageLayout,
    zoom: number,
    version: number
  ): Promise<void> {
    if (this.renderVersion !== version) return;

    // ZOOM STATE GUARD: Don't render during zoom gestures.
    // This prevents queued renders from executing while zooming.
    if (!this.zoomStateMachine.canRender()) {
      console.log(`[PdfInfiniteCanvas] Skipping tiled render for page ${page} - zoom gesture active`);
      return;
    }

    element.showLoading();

    try {
      // TILE SCALE FIX: Use getTargetScaleTier to get a VALID scale tier.
      //
      // Before: tileScale = Math.ceil(zoom * pixelRatio) produced arbitrary scales
      // like 7, 9, 11 which don't exist in SCALE_TIERS = [2,3,4,6,8,12,16,24,32].
      // This caused every tile to miss cache (looking for "s7" but cache has "s6" or "s8").
      //
      // Now: getTargetScaleTier returns the nearest valid tier, ensuring cache hits.
      const { tier: tileScale } = getTargetScaleTier(zoom, this.config.pixelRatio);

      // At high zoom (>4x), only render VISIBLE tiles (viewport-clipped)
      // At lower zoom, render all tiles for the page (for smooth panning)
      //
      // EXCEPTION: During mode transitions (full-page → tiled), render ALL tiles
      // to avoid viewport-only rendering which adds a translate offset that causes
      // visual "jumps" when the zoom gesture ends.
      let tiles: TileCoordinate[];

      // Check if we're transitioning rendering modes
      const wasTiled = this.pageWasTiled.get(page) ?? false;
      const shouldBeTiled = zoom > 4.0;
      const isModeTransition = wasTiled !== shouldBeTiled;

      // UNIFIED COORDINATE SPACE: Mode transitions are handled by resizing page elements
      // to their final dimensions. No cssStretch compensation needed.
      //
      // Only force full-page tiles during mode transitions to ensure smooth visual handoff
      const forceFullPageTiles = isModeTransition;

      if (zoom > 4.0 && !forceFullPageTiles) {
        // CRITICAL: Use camera snapshot if available (from scroll rerender)
        // This ensures we calculate visibility based on where the user was when scroll/zoom
        // rerender was scheduled, not where the camera has moved to during debounce.
        // This fixes the "0 visible tiles" issue during continuous scroll/zoom.
        // Priority: state machine snapshot > scroll snapshot > current camera
        const effectiveCamera = this.zoomStateMachine.getZoomSnapshot()?.camera ??
                                this.scrollRenderSnapshot?.camera ??
                                this.camera;

        // Get viewport in WORLD coordinates (not screen coordinates!)
        const screenRect = this.getViewportRect();
        // PHASE 1: Use mode-aware visibility calculation (V4 Architecture)
        const viewport = this.getVisibleBoundsForMode(effectiveCamera, screenRect.width, screenRect.height);

        tiles = this.tileEngine!.getVisibleTiles(viewport, [layout], zoom, tileScale);
      } else {
        // At normal zoom OR during mode transition, get all tiles for smooth transition
        if (forceFullPageTiles && zoom > 4.0) {
          console.log(`[PdfInfiniteCanvas] Page ${page}: Forcing full-page tiles (modeTransition=${isModeTransition})`);
        }
        tiles = this.tileEngine!.getPageTileGrid(page, tileScale);
      }

      if (tiles.length === 0) {
        // No tiles calculated - check if page is actually in viewport
        if (zoom > 4.0) {
          // VISIBILITY CHECK FIX: Use CURRENT camera, not snapshot!
          //
          // Pages are queued by updateVisiblePages() which uses this.camera.
          // If we check visibility against the snapshot camera here, pages that
          // were visible when queued may not overlap the snapshot viewport,
          // causing "Page X never rendered" errors.
          //
          // The snapshot is useful for tile COORDINATE calculations (stability),
          // but visibility must match the queuing logic (current camera).
          const screenRect = this.getViewportRect();
          // PHASE 1: Use mode-aware visibility calculation (V4 Architecture)
          const viewport = this.getVisibleBoundsForMode(this.camera, screenRect.width, screenRect.height);
          const overlaps = this.rectsOverlap(viewport, layout);
          if (!overlaps) {
            // Page is not visible - but only skip if it has content to preserve
            // BLANK PAGE FIX: If page was never rendered, fall back to full-page render
            // to prevent pages staying blank forever
            if (element.getIsRendered()) {
              element.hideLoading();
              return;
            }
            // Page has no content yet - must render something
            console.warn(`[PdfInfiniteCanvas] Page ${page} never rendered, forcing full render despite not overlapping viewport`);
            await this.renderPageFull(page, element, version);
            return;
          }
        }
        // Page is in viewport but no tiles - dimensions may not be set. Fall back to full-page.
        console.warn(`[PdfInfiniteCanvas] No tiles for page ${page}, falling back to full render`);
        await this.renderPageFull(page, element, version);
        return;
      }

      // Request tiles through coordinator (handles caching, deduplication)
      const tilePromises = tiles.map(tile =>
        this.renderCoordinator!.requestRender({
          type: 'tile' as const,
          tile,
          priority: this.getTilePriority(tile, layout),
          documentId: this.documentId ?? undefined,
          sessionId: this.pendingSessionId,
        })
      );

      const results = await Promise.all(tilePromises);

      // BLANK PAGE FIX: If version changed but page has no content, still render what we have.
      // A stale tiled render or fallback to full-page is better than a blank page.
      const versionStale = this.renderVersion !== version;
      const mustShowSomething = !element.getIsRendered();

      if (versionStale && !mustShowSomething) {
        // CLEANUP: Close all ImageBitmaps before returning to prevent GPU memory leak
        for (const result of results) {
          if (result.success && result.data instanceof ImageBitmap) {
            result.data.close();
          }
        }
        return;
      }

      if (versionStale && mustShowSomething) {
        // Version changed but page has no content - fall back to full-page render
        // Close tile bitmaps first, then render full page
        for (const result of results) {
          if (result.success && result.data instanceof ImageBitmap) {
            result.data.close();
          }
        }
        console.warn(`[PdfInfiniteCanvas] Version stale but page ${page} has no content, forcing full render`);
        await this.renderPageFull(page, element, this.renderVersion);
        return;
      }

      // Collect successful tile data for rendering
      // Include cssStretch for fallback tiles to enable proper CSS sizing
      const tileImages: Array<{ tile: typeof tiles[0]; bitmap: ImageBitmap; cssStretch?: number }> = [];

      for (let i = 0; i < tiles.length; i++) {
        const result = results[i];
        if (result.success && result.data instanceof ImageBitmap) {
          // Runtime check ensures type safety (RenderCoordinator decodes Blobs off main thread)
          // Extract cssStretch from fallback results for proper CSS sizing
          tileImages.push({
            tile: tiles[i],
            bitmap: result.data,
            cssStretch: result.cssStretch, // May be undefined for exact-scale tiles
          });
        }
      }

      // Get text layer (non-blocking)
      let textLayerData: TextLayerData | undefined;
      try {
        textLayerData = await this.provider.getPageTextLayer(page);
      } catch {
        // Text layer is optional
      }

      // BLANK PAGE FIX: Apply same pattern - if version stale but page blank, still render
      if (this.renderVersion !== version && element.getIsRendered()) {
        // CLEANUP: Close all collected ImageBitmaps before returning
        for (const { bitmap } of tileImages) {
          bitmap.close();
        }
        return;
      }

      // Get PDF native dimensions for coordinate transform
      // Tiles are rendered in PDF coordinate space, but layout may be scaled
      const pdfDimensions = this.tileEngine!.pageDimensions.get(page);

      // Guard: If all tiles failed to produce ImageBitmaps, fall back to full-page rendering
      // Use current render version to ensure we render something
      if (tileImages.length === 0) {
        console.warn(`[PdfInfiniteCanvas] All ${tiles.length} tiles failed to produce ImageBitmaps, falling back to full render`);
        await this.renderPageFull(page, element, this.renderVersion);
        return;
      }

      // UNIFIED COORDINATE SPACE: cssStretch is no longer needed.
      // Tiles are rendered at exact DPR resolution and positioned within
      // page elements that are sized to their final zoomed dimensions.
      // The old cssStretch mechanism has been removed.

      // Render tiles to element with PDF dimensions for correct positioning
      await element.renderTiles(tileImages, textLayerData, zoom, pdfDimensions);
      element.hideLoading();

      // STUCK TILE FIX: Track that this page was rendered with tiles
      // Used by needsZoomRerender to detect mode changes
      this.pageWasTiled.set(page, true);
      // Also update cache scale to the tile scale for quality tracking
      const actualTileScale = tileImages[0]?.tile.scale ?? zoom;
      this.pageCacheScales.set(page, actualTileScale);

      // Track visual completion for input-to-visual latency measurement
      if (this.pendingInputLatencyId !== null) {
        getTelemetry().trackVisualComplete(this.pendingInputLatencyId);
        this.pendingInputLatencyId = null;
      }

    } catch (error) {
      if (!this.isAbortError(error)) {
        console.error(`[PdfInfiniteCanvas] Tiled render failed for page ${page}:`, error);
        // Fall back to full-page rendering
        await this.renderPageFull(page, element, version);
      } else {
        element.hideLoading();
      }
    }
  }

  /**
   * Get tile priority based on distance from viewport center
   */
  private getTilePriority(
    tile: TileCoordinate,
    layout: PageLayout
  ): RenderPriority {
    // Use canvas coordinates for priority calculation
    const screenRect = this.getViewportRect();
    // PHASE 1: Use mode-aware visibility calculation (V4 Architecture)
    const viewport = this.getVisibleBoundsForMode(this.camera, screenRect.width, screenRect.height);
    const viewportCenterX = viewport.x + viewport.width / 2;
    const viewportCenterY = viewport.y + viewport.height / 2;

    // Calculate tile center in canvas coordinates
    const tileX = layout.x + tile.tileX * TILE_SIZE;
    const tileY = layout.y + tile.tileY * TILE_SIZE;
    const tileCenterX = tileX + TILE_SIZE / 2;
    const tileCenterY = tileY + TILE_SIZE / 2;

    // Distance from viewport center
    const distance = Math.sqrt(
      Math.pow(tileCenterX - viewportCenterX, 2) +
      Math.pow(tileCenterY - viewportCenterY, 2)
    );

    // Priority based on distance
    if (distance < viewport.width / 4) return 'critical';
    if (distance < viewport.width / 2) return 'high';
    if (distance < viewport.width) return 'medium';
    return 'low';
  }

  /**
   * Render a page using full-page rendering (original path)
   */
  private async renderPageFull(
    page: number,
    element: PdfPageElement,
    version: number
  ): Promise<void> {
    if (this.renderVersion !== version) return;

    element.showLoading();

    // Calculate zoom-aware render scale for sharp text at current zoom
    // Cap at max useful scale to avoid fetching unnecessarily large images
    const zoomAwareScale = this.getZoomAwareRenderScale();
    const maxScale = this.getMaxUsefulScale();
    // zoomAwareScale * pixelRatio = desired scale for HiDPI quality
    // maxScale = absolute max (2048px / pageWidth) to avoid wasteful fetches
    const targetScale = Math.min(zoomAwareScale * this.config.pixelRatio, maxScale);

    try {
      // Use dual-resolution if provider supports it (preferred path)
      if (this.provider.getPageImageDualRes) {
        const result = await this.provider.getPageImageDualRes(page, {
          scale: targetScale,
          dpi: 150,
          format: 'png',
        });

        // BLANK PAGE FIX: If version changed but page has no content, still show what we have.
        // A stale render is better than a blank page. The next render will overwrite it.
        const versionStale = this.renderVersion !== version;
        const mustShowSomething = !element.getIsRendered();

        if (versionStale && !mustShowSomething) {
          // Page has content and version is stale - skip safely
          return;
        }

        // Get text layer (non-blocking) - skip if version stale to avoid delay
        let textLayerData: TextLayerData | undefined;
        if (!versionStale) {
          try {
            textLayerData = await this.provider.getPageTextLayer(page);
          } catch {
            // Text layer is optional
          }
        }

        // Another version check for text layer await, but still show if page is blank
        if (this.renderVersion !== version && element.getIsRendered()) return;

        // Display initial (may be thumbnail or full quality)
        await element.render({ imageBlob: result.initial, textLayerData }, zoomAwareScale);
        element.hideLoading();

        // Track visual completion for input-to-visual latency measurement
        if (this.pendingInputLatencyId !== null) {
          getTelemetry().trackVisualComplete(this.pendingInputLatencyId);
          this.pendingInputLatencyId = null;
        }

        // Update local cache with initial
        this.pageImageCache.set(page, result.initial);
        this.pageCacheScales.set(page, result.initialScale);
        this.updateCacheOrder(page);

        // STUCK TILE FIX: Mark page as NOT tiled (full-page render)
        this.pageWasTiled.set(page, false);

        // If not full quality, wait for upgrade and re-render
        if (!result.isFullQuality && result.upgradePromise) {
          result.upgradePromise.then(async (fullBlob) => {
            // Only upgrade if still visible and same render version
            if (this.renderVersion !== version || !this.visiblePages.has(page)) {
              return;
            }

            // Re-render with full quality
            await element.render({ imageBlob: fullBlob, textLayerData }, zoomAwareScale);

            // Update cache with full quality
            this.pageImageCache.set(page, fullBlob);
            this.pageCacheScales.set(page, targetScale);
            this.updateCacheOrder(page);
          }).catch((err) => {
            // Upgrade failed, but we already have something displayed
            if (!this.isAbortError(err)) {
              console.warn(`[PdfInfiniteCanvas] Upgrade failed for page ${page}:`, err);
            }
          });
        }
      } else {
        // Fallback: use original single-resolution path
        const imageBlob = await this.getCachedPageImage(page);

        // BLANK PAGE FIX: Same pattern - show stale content if page has no content
        const versionStale = this.renderVersion !== version;
        const mustShowSomething = !element.getIsRendered();

        if (versionStale && !mustShowSomething) return;

        let textLayerData: TextLayerData | undefined;
        if (!versionStale) {
          try {
            textLayerData = await this.provider.getPageTextLayer(page);
          } catch {
            // Text layer is optional
          }
        }

        if (this.renderVersion !== version && element.getIsRendered()) return;

        await element.render({ imageBlob, textLayerData }, zoomAwareScale);
        element.hideLoading();

        // STUCK TILE FIX: Mark page as NOT tiled (full-page render)
        this.pageWasTiled.set(page, false);

        // Track visual completion for input-to-visual latency measurement
        if (this.pendingInputLatencyId !== null) {
          getTelemetry().trackVisualComplete(this.pendingInputLatencyId);
          this.pendingInputLatencyId = null;
        }
      }
    } catch (error) {
      if (!this.isAbortError(error)) {
        console.error(`Failed to render page ${page}:`, error);
      }
      element.hideLoading();
    }
  }

  /**
   * Calculate the render scale needed for current zoom level.
   *
   * At high zoom, we need to render at higher resolution to maintain
   * crisp text (Retina quality = 2x buffer pixels per screen pixel).
   *
   * Formula: effectiveRatio = bufferPixels / screenPixels
   *        = (renderScale * pixelRatio) / cssZoom
   *
   * For effectiveRatio >= MIN_EFFECTIVE_RATIO:
   *   renderScale >= cssZoom * MIN_EFFECTIVE_RATIO / pixelRatio
   */

  /**
   * Calculate buffer zone sizes for a given zoom level.
   *
   * Buffer sizes scale inversely with zoom (larger buffers at lower zoom for
   * more pages, smaller at high zoom where tiles dominate) but have MINIMUM
   * FLOORS aligned to tile boundaries (256px) to ensure smooth scrolling.
   *
   * @param zoom - The camera zoom level
   * @returns Object with renderBuffer, elementBuffer, and keepBuffer in CSS pixels
   */
  private calculateBufferSizes(zoom: number): {
    renderBuffer: number;
    elementBuffer: number;
    keepBuffer: number;
  } {
    // Minimum floors ALIGNED TO TILE BOUNDARIES (256px tile size)
    // This ensures buffers always cover at least N complete tiles at high zoom
    const MIN_RENDER_BUFFER = 256;   // 1 complete tile
    const MIN_ELEMENT_BUFFER = 512;  // 2 complete tiles
    const MIN_KEEP_BUFFER = 768;     // 3 complete tiles

    return {
      renderBuffer: Math.max(MIN_RENDER_BUFFER, 1200 / zoom),
      elementBuffer: Math.max(MIN_ELEMENT_BUFFER, 2400 / zoom),
      keepBuffer: Math.max(MIN_KEEP_BUFFER, 3600 / zoom),
    };
  }

  private getZoomAwareRenderScale(zoom?: number): number {
    // This returns a scale that will be multiplied by pixelRatio by callers
    // MIN_EFFECTIVE_RATIO ensures minimum quality (2x) even at low zoom
    // The result × pixelRatio gives the actual render scale needed
    // Use snapshot zoom if available and no zoom provided (matches render path)
    const effectiveZoom = zoom ??
                          this.zoomStateMachine.getZoomSnapshot()?.camera.z ??
                          this.scrollRenderSnapshot?.camera.z ??
                          this.camera.z;
    const minRequired = (effectiveZoom * this.MIN_EFFECTIVE_RATIO) / this.config.pixelRatio;
    return Math.max(this.config.renderScale, minRequired);
  }

  /**
   * Get maximum useful render scale based on display requirements.
   *
   * Enables true retina quality at maximum zoom (16x):
   * - At zoom 16x with pixelRatio 2: idealScale = 32 for crisp text
   * - Adaptive tile sizing reduces tile size at extreme zoom (useAdaptiveTileSize: true)
   * - Full-page rendering is disabled above tileZoomThreshold (2.0x)
   *
   * Memory note: At scale 32 with adaptive tile sizing enabled:
   * - zoom >16x uses 64px CSS tiles → 2048×2048 pixels = 16MB RGBA per tile
   * - zoom 8-16x uses 128px CSS tiles → 4096×4096 pixels = 64MB RGBA per tile
   * - zoom 2-8x uses 256px CSS tiles → at these lower zooms, scale is lower
   *
   * Without adaptive sizing (useAdaptiveTileSize: false), 256px tiles at scale 32
   * would use 256MB per tile - this is why adaptive sizing is enabled by default.
   */
  private getMaxUsefulScale(zoomOverride?: number): number {
    // Use snapshot zoom if available and no zoom provided (matches render path)
    const zoom = zoomOverride ??
                 this.zoomStateMachine.getZoomSnapshot()?.camera.z ??
                 this.scrollRenderSnapshot?.camera.z ??
                 this.camera.z;
    const pixelRatio = this.config.pixelRatio;

    // Target scale for crisp rendering: zoom × pixelRatio
    // At zoom 16x with DPR 2: idealScale = 32
    const idealScale = zoom * pixelRatio;

    // Cap at 32x to enable true retina quality at maximum zoom (16x on 2x DPR)
    // This matches SCALE_TIERS max in progressive-tile-renderer.ts
    // Memory is managed by tiled rendering (only visible tiles rendered)
    const MAX_SCALE = 32.0;

    return Math.min(idealScale, MAX_SCALE);
  }

  /**
   * Check if a page needs re-rendering due to zoom level change.
   *
   * A page needs re-rendering if:
   * 1. Its cached scale would result in less than MIN_EFFECTIVE_RATIO buffer pixels per screen pixel
   * 2. The rendering MODE changes (tiled → full-page or vice versa)
   *
   * STUCK TILE FIX: Previously only checked quality (zoom-in), not mode changes (zoom-out).
   * This caused pages rendered with tiles at high zoom to remain as stuck tiles when
   * zooming out below the tiling threshold.
   */
  private needsZoomRerender(page: number): boolean {
    const cachedScale = this.pageCacheScales.get(page);
    if (!cachedScale) return true; // Not cached, needs render

    // STUCK TILE FIX: Check if rendering mode should change
    // Tiling threshold is zoom > 4.0 (see renderPage)
    const TILING_THRESHOLD = 4.0;
    // CRITICAL FIX: Use consistent zoom from snapshot (same pattern as other render calculations)
    // Priority: state machine snapshot > scroll snapshot > current camera
    const effectiveCamera = this.zoomStateMachine.getZoomSnapshot()?.camera ??
                            this.scrollRenderSnapshot?.camera ??
                            this.camera;
    const currentZoom = effectiveCamera.z;
    const wasTiled = this.pageWasTiled.get(page) ?? false;
    const shouldBeTiled = currentZoom > TILING_THRESHOLD;

    // Force re-render if mode changes (tiled ↔ full-page)
    if (wasTiled !== shouldBeTiled) {
      console.log(`[PdfInfiniteCanvas] Mode change for page ${page}: wasTiled=${wasTiled}, shouldBeTiled=${shouldBeTiled}, zoom=${currentZoom.toFixed(2)}`);
      return true;
    }

    // Calculate effective ratio at current zoom
    const effectiveRatio = cachedScale / currentZoom;
    return effectiveRatio < this.MIN_EFFECTIVE_RATIO;
  }

  /**
   * Schedule re-rendering of visible pages that need higher resolution.
   *
   * Debounced to avoid excessive re-renders during continuous zoom gestures.
   *
   * With useMultiResZoom enabled (Phase 2), uses progressive rendering:
   * - Phase 0 (instant): CSS transform applies existing tiles scaled (handled elsewhere)
   * - Phase 1 (50ms): Render at intermediate scale (faster, less blurry)
   * - Phase 2 (200ms): Render at final target scale (full quality)
   */
  private scheduleZoomRerender(): void {
    // CRITICAL: Snapshot camera AND layout params NOW, before any debounce
    // Same pattern as scheduleScrollRerender() - during rapid zoom, the camera.z changes
    // significantly between schedule and render (100ms+ debounce). By snapshotting NOW,
    // we ensure tiles are calculated based on where the user actually triggered zoom,
    // not where the camera moved to during the debounce window.
    this.zoomRenderSnapshot = {
      camera: { ...this.camera },
      layoutMode: this.config.layoutMode,
      pagesPerRow: this.config.pagesPerRow,
      cellWidth: this.layoutBaseWidth + this.layoutGap,
      cellHeight: this.layoutBaseHeight + this.layoutGap,
      padding: this.layoutPadding,
    };

    // Delegate to ZoomTransformLayer if available (centralized progressive rendering)
    if (this.zoomTransformLayer) {
      // FOCAL POINT FIX: Pass the focal point to ZoomTransformLayer
      // Even though disableCssTransforms=true, the layer needs the focal point
      // for internal calculations to maintain coordinate consistency
      this.zoomTransformLayer.onZoomGesture(this.camera.z, this.lastZoomFocalPoint);
      return;
    }

    // Fallback: manual timeout management
    // Clear existing timeouts
    if (this.zoomRerenderTimeout) {
      clearTimeout(this.zoomRerenderTimeout);
    }
    if (this.zoomFinalRenderTimeout) {
      clearTimeout(this.zoomFinalRenderTimeout);
    }

    // Calculate target scale for final quality
    const targetScale = this.getZoomAwareRenderScale() * this.config.pixelRatio;

    // Check if progressive zoom is enabled
    if (isFeatureEnabled('useMultiResZoom') && targetScale > this.currentRenderScale) {
      // Progressive rendering: intermediate quality first, then final
      this.scheduleProgressiveZoomRender(targetScale);
    } else {
      // Standard single-phase rendering with version tracking
      // Increment version to invalidate any stale renders from previous gestures
      const currentScaleVersion = ++this.scaleVersion;
      this.zoomRerenderTimeout = setTimeout(() => {
        // Check if this zoom sequence is still valid before rendering
        if (this.scaleVersion !== currentScaleVersion) {
          console.log(`[PdfInfiniteCanvas] Skipping stale fallback render (version ${currentScaleVersion} != ${this.scaleVersion})`);
          return;
        }
        this.renderZoomPhase('final', targetScale, currentScaleVersion);
      }, this.ZOOM_RERENDER_DEBOUNCE);
    }
  }

  /**
   * Schedule progressive zoom rendering phases.
   *
   * Phase 1 (intermediate): Quick render at lower scale for immediate improvement
   * Phase 2 (final): Full quality render at target scale
   *
   * Uses scale versioning to prevent concurrent updates during rapid zoom.
   * Only the most recent zoom sequence can update the render scale.
   */
  private scheduleProgressiveZoomRender(targetScale: number): void {
    // Increment scale version to invalidate any pending updates from previous zoom gestures
    const currentScaleVersion = ++this.scaleVersion;

    const { tier: targetTier } = getTargetScaleTier(this.camera.z, this.config.pixelRatio);

    // Calculate intermediate scale (roughly halfway between current and target)
    const intermediateTier = this.getIntermediateScaleTier(this.currentRenderScale, targetTier);

    // Phase 1: Intermediate quality (50ms)
    if (intermediateTier !== targetTier && intermediateTier > this.currentRenderScale) {
      this.zoomRerenderTimeout = setTimeout(() => {
        // Check if this zoom sequence is still valid
        if (this.scaleVersion !== currentScaleVersion) {
          console.log(`[PdfInfiniteCanvas] Skipping stale intermediate render (version ${currentScaleVersion} != ${this.scaleVersion})`);
          return;
        }
        console.log(`[PdfInfiniteCanvas] Progressive zoom: intermediate render at scale ${intermediateTier}`);
        this.renderZoomPhase('intermediate', intermediateTier, currentScaleVersion);
      }, this.ZOOM_INTERMEDIATE_DELAY);
    }

    // Phase 2: Final quality (200ms)
    this.zoomFinalRenderTimeout = setTimeout(() => {
      // Check if this zoom sequence is still valid
      if (this.scaleVersion !== currentScaleVersion) {
        console.log(`[PdfInfiniteCanvas] Skipping stale final render (version ${currentScaleVersion} != ${this.scaleVersion})`);
        return;
      }
      console.log(`[PdfInfiniteCanvas] Progressive zoom: final render at scale ${targetTier}`);
      this.renderZoomPhase('final', targetTier, currentScaleVersion);
    }, this.ZOOM_FINAL_DELAY);
  }

  /**
   * Get intermediate scale tier for progressive rendering.
   * Returns a scale tier roughly halfway between current and target.
   */
  private getIntermediateScaleTier(current: number, target: ScaleTier): ScaleTier {
    const tiers: ScaleTier[] = [2, 4, 8, 16, 32];

    // Find tiers between current and target
    const validTiers = tiers.filter(t => t > current && t < target);

    if (validTiers.length === 0) {
      return target;
    }

    // Return the middle tier
    return validTiers[Math.floor(validTiers.length / 2)];
  }

  /**
   * Execute a zoom render phase (intermediate or final).
   *
   * @param phase The render phase ('intermediate' or 'final')
   * @param scale The target scale for this phase
   * @param scaleVersion Optional version to validate this update is still current
   */
  private renderZoomPhase(
    phase: 'intermediate' | 'final',
    scale: number,
    scaleVersion?: number
  ): void {
    // If version provided, validate this update is still current
    if (scaleVersion !== undefined && scaleVersion !== this.scaleVersion) {
      console.log(`[PdfInfiniteCanvas] Ignoring stale ${phase} render (version mismatch)`);
      return;
    }

    // GUARD: Check state machine to ensure we're not in a zoom gesture.
    // This is defense-in-depth - the state machine's onRenderPhase callback should
    // only fire when state is 'rendering', but this guards against legacy code paths.
    if (!this.zoomStateMachine.canRender()) {
      console.log(`[PdfInfiniteCanvas] Skipping ${phase} render - zoom gesture active (state: ${this.zoomStateMachine.getCurrentState()})`);
      return;
    }

    // CRITICAL FIX: Use zoom snapshot if available (same pattern as scroll)
    // During rapid zoom gestures, this.visiblePages reflects the CURRENT camera position,
    // not where the camera WAS when the zoom was scheduled. Using the snapshot ensures
    // we render tiles for the correct viewport position.
    //
    // Priority: ZoomStateMachine snapshot > scrollRenderSnapshot > current camera
    const zoomSnapshot = this.zoomStateMachine.getZoomSnapshot();
    const effectiveCamera = zoomSnapshot?.camera ??
                            this.scrollRenderSnapshot?.camera ??
                            this.camera;

    // Calculate visible pages from snapshot if available, otherwise use current
    let visiblePagesForRender: Set<number>;
    if (zoomSnapshot) {
      // Use state machine snapshot to calculate visible pages (mirrors scroll behavior)
      // Layout info is taken from current state since it doesn't change during zoom
      const viewportRect = this.getViewportRect();
      // PHASE 1: Use mode-aware visibility calculation (V4 Architecture)
      const snapshotBounds = this.getVisibleBoundsForMode(effectiveCamera, viewportRect.width, viewportRect.height);
      const { renderBuffer } = this.calculateBufferSizes(effectiveCamera.z);

      visiblePagesForRender = new Set(this.calculatePagesInBounds(
        snapshotBounds.x - renderBuffer,
        snapshotBounds.y - renderBuffer,
        snapshotBounds.width + renderBuffer * 2,
        snapshotBounds.height + renderBuffer * 2,
        this.config.layoutMode,
        this.config.pagesPerRow,
        this.layoutBaseWidth + this.layoutGap,  // cellWidth
        this.layoutBaseHeight + this.layoutGap, // cellHeight
        this.layoutPadding
      ));
    } else {
      // Fallback to current visible pages
      visiblePagesForRender = this.visiblePages;
    }

    // Find pages that need re-rendering
    const pagesToRerender: number[] = [];
    for (const page of visiblePagesForRender) {
      if (this.needsZoomRerender(page)) {
        pagesToRerender.push(page);
      }
    }

    if (pagesToRerender.length > 0) {
      console.log(
        `[PdfInfiniteCanvas] ${phase} render: ${pagesToRerender.length} pages at zoom ${effectiveCamera.z.toFixed(2)}, scale ${scale}${zoomSnapshot ? ' (using state machine snapshot)' : ''}`
      );

      // CRITICAL FIX: Ensure page elements exist before queuing for render.
      // During zoom gestures, updateVisiblePages() is blocked by canRender() guard,
      // so page elements are NOT created for newly visible pages. If the user zooms
      // to a different part of the document, the visible pages from the snapshot
      // won't have elements, causing processRenderQueue to skip them (no element = no render).
      //
      // Solution: Create elements here for any page that doesn't have one yet.
      for (const pageNum of pagesToRerender) {
        if (!this.pageElements.has(pageNum)) {
          console.log(`[PdfInfiniteCanvas] Creating missing element for page ${pageNum} (zoom render path)`);
          this.createPageElement(pageNum);
        }
      }

      // Mark pages as needing re-render (clear rendered state)
      for (const pageNum of pagesToRerender) {
        const element = this.pageElements.get(pageNum);
        if (element) {
          element.clearRendered();
        }
      }

      // Queue for re-render
      this.queueRender(pagesToRerender);
    }

    // Update current render scale if this was a successful render
    // Only update if:
    // 1. This is a final render, OR
    // 2. This is an intermediate render that improves quality (higher scale)
    // AND the scale version is still current (prevents race conditions)
    //
    // Note: We require scaleVersion to be provided and match current version
    // to prevent race conditions from stale renders
    if (scaleVersion !== undefined && scaleVersion === this.scaleVersion) {
      if (phase === 'final' || (phase === 'intermediate' && scale > this.currentRenderScale)) {
        this.currentRenderScale = scale as ScaleTier;
        getTelemetry().trackCustomMetric('zoomScaleUpgrade', scale);
      }
    } else if (scaleVersion === undefined) {
      // Fallback for legacy calls without version tracking
      // This should not happen in normal operation - log for debugging
      console.warn('[PdfInfiniteCanvas] renderZoomPhase called without scaleVersion - scale update skipped for safety');
    }

    // RACE CONDITION FIX: Do NOT clear zoomRenderSnapshot here!
    //
    // The queued renders are async - by the time renderPageTiled() runs,
    // clearing the snapshot would cause it to fall back to this.camera,
    // which has moved since the snapshot was taken. This causes:
    //   "Page X never rendered, forcing full render despite not overlapping viewport"
    //
    // Instead, let the next zoom gesture overwrite the snapshot naturally.
    // The snapshot will be overwritten in scheduleZoomRerender() when a new
    // zoom gesture starts, so stale data won't persist.
  }

  // UNIFIED COORDINATE SPACE: freezeCssStretch() and unfreezeCssStretch() have been removed.
  // The cssStretch compensation mechanism is no longer needed because page elements are
  // sized to their final zoomed dimensions. See handleZoomChange() below.

  /**
   * Handle zoom changes in unified coordinate space.
   *
   * UNIFIED COORDINATE SPACE ARCHITECTURE:
   * This method is the core of the new zoom handling. Instead of using camera scale
   * transforms and cssStretch compensation, page elements are resized to their final
   * displayed dimensions at each zoom level.
   *
   * Key steps:
   * 1. Resize all page elements to their final zoomed dimensions
   * 2. Adjust camera position to maintain the focal point
   * 3. Schedule tile rendering at the new zoom level
   *
   * Benefits:
   * - No visual jumps during zoom transitions (no cssStretch mismatch)
   * - Simpler coordinate system (one space, no compensation)
   * - Tiles positioned exactly without scaling transforms
   *
   * @param newZoom - Target zoom level
   * @param focalPoint - Screen coordinates of zoom center (e.g., pinch midpoint)
   *
   * TODO(Phase 2): This method is Phase 1 scaffolding. It will be integrated with
   * gesture handlers in Phase 2 when the camera transform is simplified to translate-only.
   * Current zoom handling uses the old cssStretch-based approach in gesture handlers.
   */
  private handleZoomChange(newZoom: number, focalPoint: Point): void {
    const oldZoom = this.camera.z;

    // Guard: No change
    if (Math.abs(newZoom - oldZoom) < 0.001) {
      return;
    }

    console.log(`[PdfInfiniteCanvas] handleZoomChange: ${oldZoom.toFixed(2)} → ${newZoom.toFixed(2)}, focalPoint=(${focalPoint.x.toFixed(0)}, ${focalPoint.y.toFixed(0)})`);

    // Step 1: Resize all page elements to their final zoomed dimensions
    for (const [page, element] of this.pageElements) {
      const layout = this.pageLayouts.get(page);
      if (layout) {
        // Final dimensions = base layout × zoom
        const finalWidth = layout.width * newZoom;
        const finalHeight = layout.height * newZoom;
        element.setFinalDimensions(finalWidth, finalHeight, newZoom);

        // Update element position to match zoomed layout
        // In unified coordinate space, layout positions also scale with zoom
        const elem = element.getElement();
        elem.style.left = `${layout.x * newZoom}px`;
        elem.style.top = `${layout.y * newZoom}px`;
      }
    }

    // Step 2: Update canvas bounds to match zoomed content
    this.canvasBounds = {
      width: this.canvasBounds.width * (newZoom / oldZoom),
      height: this.canvasBounds.height * (newZoom / oldZoom),
    };
    this.canvas.style.width = `${this.canvasBounds.width}px`;
    this.canvas.style.height = `${this.canvasBounds.height}px`;

    // Step 3: Adjust camera position to maintain focal point
    //
    // UNIFIED COORDINATE SPACE DOCUMENTATION:
    // - focalPoint: Screen coordinates (pixels from viewport top-left)
    // - camera.x/y: Screen/pixel coordinates (position in unified canvas space)
    // - camera.z: Zoom level (1 = 100%, 16 = 1600%)
    //
    // In unified space:
    // - Transform is translate-only: translate(-camera.x, -camera.y)
    // - Canvas position = screen position + camera position
    // - Pages are at (layout.x * zoom, layout.y * zoom) in canvas space
    //
    // Goal: Keep the content under focalPoint stationary during zoom
    // 1. Find the canvas position at the focal point (screen + camera)
    // 2. Find the "logical" position (canvas / zoom = 100% zoom equivalent)
    // 3. After zoom, that logical position is at a new canvas position
    // 4. Adjust camera so the new canvas position maps to the same screen position

    const zoomRatio = newZoom / oldZoom;

    // Step 3a: Find canvas position at focal point (in OLD coordinate system)
    // In unified space: canvasPos = screenPos + camera
    const focalCanvasOld = {
      x: focalPoint.x + this.camera.x,
      y: focalPoint.y + this.camera.y,
    };

    // Step 3b: Convert to logical position (100% zoom equivalent)
    // This is the position relative to content at zoom=1
    const focalLogical = {
      x: focalCanvasOld.x / oldZoom,
      y: focalCanvasOld.y / oldZoom,
    };

    // Step 3c: Find new canvas position at new zoom
    // In unified space, the same logical position is now at canvas = logical * newZoom
    const focalCanvasNew = {
      x: focalLogical.x * newZoom,
      y: focalLogical.y * newZoom,
    };

    // Step 3d: Calculate new camera to keep focal point stationary
    // We want: focalCanvasNew = focalPoint + newCamera
    // So: newCamera = focalCanvasNew - focalPoint
    const newCameraX = focalCanvasNew.x - focalPoint.x;
    const newCameraY = focalCanvasNew.y - focalPoint.y;

    // Step 3e: Validate focal point stability (drift detection)
    // Verify the math: screenPos should equal focalPoint
    // screenPos = canvasPos - camera = focalCanvasNew - newCamera
    const verifyScreenX = focalCanvasNew.x - newCameraX;
    const verifyScreenY = focalCanvasNew.y - newCameraY;
    const driftX = Math.abs(verifyScreenX - focalPoint.x);
    const driftY = Math.abs(verifyScreenY - focalPoint.y);
    const maxDrift = Math.max(driftX, driftY);

    // Log drift for debugging - should be zero in unified space
    if (maxDrift > 0.001) {
      console.warn(`[PdfInfiniteCanvas] Focal point drift detected: ${maxDrift.toFixed(4)}px (expected 0)`);
    }

    this.camera.x = newCameraX;
    this.camera.y = newCameraY;
    this.camera.z = newZoom;

    // Step 4: Apply camera transform and constrain position
    this.constrainCameraPosition();
    this.applyTransform();

    // Step 5: Schedule tile rendering at new zoom level
    this.scheduleZoomRerender();

    // Notify callbacks
    this.onZoomChangeCallback?.(newZoom);

    console.log(`[PdfInfiniteCanvas] handleZoomChange complete: camera=(${this.camera.x.toFixed(1)}, ${this.camera.y.toFixed(1)}, ${this.camera.z.toFixed(2)})`);
  }

  /**
   * Handle zoom render phase callback from ZoomTransformLayer.
   * Adapts the ZoomTransformLayer's scale/phase format to our existing render system.
   *
   * Phase semantics:
   * - 'immediate': CSS transform only (instant, no render needed - camera handles this)
   *                Also increments scaleVersion to mark a new zoom sequence
   * - 'intermediate': First progressive render after 50ms
   * - 'final': Full quality render after 200ms
   */
  private handleZoomRenderPhase(scale: ScaleTier, phase: ZoomPhase): void {
    console.log(`[PdfInfiniteCanvas] handleZoomRenderPhase: scale=${scale}, phase=${phase}, scaleVersion=${this.scaleVersion}`);

    // Immediate phase uses CSS transform only - no render needed
    // Our camera system already handles the visual zoom transform
    // However, we increment scaleVersion to mark the start of a new zoom sequence
    if (phase === 'immediate') {
      this.scaleVersion++;
      console.log('[PdfInfiniteCanvas] handleZoomRenderPhase: immediate phase, returning');
      return;
    }

    // Map ZoomPhase to our internal phase format
    const internalPhase: 'intermediate' | 'final' = phase === 'final' ? 'final' : 'intermediate';
    console.log(`[PdfInfiniteCanvas] handleZoomRenderPhase: calling renderZoomPhase with ${internalPhase}, ${scale}, ${this.scaleVersion}`);

    // Delegate to existing render logic with current scale version
    // NOTE: renderZoomPhase handles the ZOOM DRIFT FIX (CSS transitions) internally
    this.renderZoomPhase(internalPhase, scale, this.scaleVersion);

    // Notify ZoomTransformLayer that scale was rendered (for quality tracking)
    this.zoomTransformLayer?.onScaleRendered(scale);

    // Final phase completes the zoom gesture - reset animation state and state machine
    if (phase === 'final') {
      this.zoomTransformLayer?.onZoomGestureEnd();

      // Notify state machine that render is complete
      // This clears the snapshot and transitions back to 'idle'
      this.zoomStateMachine.completeRenderPhase();
    }
  }

  /**
   * Schedule re-render for scroll events at high zoom.
   * Uses a much shorter debounce than zoom to maintain responsiveness during scroll.
   *
   * Unlike scheduleZoomRerender (150ms debounce for zoom gestures),
   * this fires after ~2 frames (32ms) to render tiles continuously during scroll.
   */
  private scheduleScrollRerender(): void {
    // Clear existing timeout
    if (this.scrollRerenderTimeout) {
      clearTimeout(this.scrollRerenderTimeout);
    }

    // CRITICAL: Snapshot camera AND layout params NOW, not when debounce fires
    // During fast scroll, the camera moves 100s of pixels between schedule and render.
    // If we use the current camera at render time, it may have moved past all page layouts,
    // resulting in "0 visible tiles". By snapshotting at schedule time, we ensure
    // tile visibility is calculated based on where the user actually is.
    // Layout params are also snapshotted to prevent race conditions if layout changes during debounce.
    this.scrollRenderSnapshot = {
      camera: { ...this.camera },
      layoutMode: this.config.layoutMode,
      pagesPerRow: this.config.pagesPerRow,
      cellWidth: this.layoutBaseWidth + this.layoutGap,
      cellHeight: this.layoutBaseHeight + this.layoutGap,
      padding: this.layoutPadding,
    };

    this.scrollRerenderTimeout = setTimeout(() => {
      // GUARD: Viewport may be destroyed during the 32ms debounce (component unmount, tab close)
      if (!this.viewport || !this.viewport.isConnected) {
        this.scrollRenderSnapshot = null;
        return;
      }

      // ZOOM STATE GUARD: Don't render during zoom gestures.
      // ZoomStateMachine provides centralized state - canRender() returns false
      // during 'zooming' and 'settling' phases.
      if (!this.zoomStateMachine.canRender()) {
        console.log('[PdfInfiniteCanvas] Skipping scroll rerender - zoom in progress');
        return;
      }

      // CRITICAL FIX: Calculate visible pages from SNAPSHOT, not current state
      // During fast scroll, this.visiblePages reflects where the camera IS now,
      // not where it WAS when the render was scheduled.
      const snapshot = this.scrollRenderSnapshot;
      if (!snapshot) return;

      // PERF FIX: Use cached viewport rect to avoid layout thrashing during scroll
      const viewportRect = this.getViewportRect();
      // PHASE 1: Use mode-aware visibility calculation (V4 Architecture)
      const snapshotBounds = this.getVisibleBoundsForMode(snapshot.camera, viewportRect.width, viewportRect.height);

      // Use SNAPSHOTTED layout parameters to prevent race conditions
      const { layoutMode, pagesPerRow, cellWidth, cellHeight, padding } = snapshot;
      // Use consistent buffer calculation with minimum floors (same as updateVisiblePages)
      const { renderBuffer } = this.calculateBufferSizes(snapshot.camera.z);

      // Calculate pages that were visible at snapshot time
      const snapshotVisiblePages = this.calculatePagesInBounds(
        snapshotBounds.x - renderBuffer,
        snapshotBounds.y - renderBuffer,
        snapshotBounds.width + renderBuffer * 2,
        snapshotBounds.height + renderBuffer * 2,
        layoutMode,
        pagesPerRow,
        cellWidth,
        cellHeight,
        padding
      );

      // Find pages that need re-rendering at current zoom
      // ADJACENT TILE FIX: At high zoom in tiled mode, always re-render visible pages
      // to composite newly visible tiles as the user pans. Without this, tiles are
      // requested via triggerTilePrefetch() but never composited to the page canvas.
      const TILING_THRESHOLD = 4.0;
      const inTiledMode = snapshot.camera.z > TILING_THRESHOLD && this.useTiledRendering;

      const pagesToRerender: number[] = [];
      for (const page of snapshotVisiblePages) {
        // Re-render if zoom quality changed OR if in tiled mode (need new tiles)
        if (this.needsZoomRerender(page) || inTiledMode) {
          pagesToRerender.push(page);
        }
      }

      if (pagesToRerender.length > 0) {
        // Create a new render session for this scroll event
        // This enables selective abort - we keep recent sessions but abort old ones
        const session = getRenderSessionManager().createSession(
          snapshot.camera,
          this.documentId ?? '',
          'scroll'
        );
        // Capture sessionId at queue time to prevent race conditions
        this.pendingSessionId = session.sessionId;

        // PHASE 2 FIX: Use selective abort with adaptive keepRecent based on tile scale.
        // - Blanket abort (abortAllPending): Destroys cache every 32ms, ~40% hit rate
        // - No abort: Queue saturates with 100+ stale requests, 400ms+ wait
        // - Selective abort: Keep recent sessions (varies by scale), abort older ones
        // At high scale (16+), tiles take ~200ms to render, so we need more tolerance.
        // Use scale (zoom × pixelRatio) for accurate timing on high-DPI displays.
        const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 2;
        const tileScale = snapshot.camera.z * pixelRatio;
        const keepRecent = this.renderCoordinator?.getAdaptiveKeepRecent(tileScale) ?? 2;
        this.renderCoordinator?.abortStaleSessions(keepRecent);

        // Mark pages as needing re-render
        for (const page of pagesToRerender) {
          const element = this.pageElements.get(page);
          if (element) {
            element.clearRendered();
          }
        }

        // Queue for re-render
        this.queueRender(pagesToRerender);
      }

      // NOTE: Do NOT clear snapshot here! The renders are queued but execute asynchronously.
      // renderPageTiled needs the snapshot to calculate visible tiles. If we clear it now,
      // the snapshot will be null when renderPageTiled runs, causing it to use the current
      // camera position (which may have moved during pan). The snapshot will be overwritten
      // by the next scroll event anyway, so it's safe to leave it.
    }, this.SCROLL_RERENDER_DEBOUNCE);
  }

  /**
   * Update cache order for LRU eviction
   */
  private updateCacheOrder(page: number): void {
    const idx = this.cacheOrder.indexOf(page);
    if (idx > -1) this.cacheOrder.splice(idx, 1);
    this.cacheOrder.push(page);

    // Evict old entries
    while (this.cacheOrder.length > this.PAGE_CACHE_SIZE) {
      const old = this.cacheOrder.shift()!;
      this.pageImageCache.delete(old);
      this.pageCacheScales.delete(old);
    }
  }

  /**
   * Get cached page image or fetch from server
   */
  private async getCachedPageImage(page: number): Promise<Blob> {
    // Use zoom-aware scale for sharp rendering at current zoom
    const targetScale = this.getZoomAwareRenderScale() * this.config.pixelRatio;

    // Check cache
    if (this.pageImageCache.has(page)) {
      const cachedScale = this.pageCacheScales.get(page) ?? 0;
      if (cachedScale >= targetScale * 0.8) {
        // Update LRU
        const idx = this.cacheOrder.indexOf(page);
        if (idx > -1) {
          this.cacheOrder.splice(idx, 1);
          this.cacheOrder.push(page);
        }
        return this.pageImageCache.get(page)!;
      }
    }

    // Check for pending request
    const pending = this.pendingImageRequests.get(page);
    if (pending) return pending;

    // Fetch page at target scale (provider handles DPI-aware scaling)
    const fetchScale = Math.max(targetScale, 1.5);
    const promise = (async () => {
      try {
        const blob = await this.provider.getPageImage(page, {
          scale: fetchScale,
          dpi: 150,
          format: 'png',
        });

        this.pageImageCache.set(page, blob);
        this.pageCacheScales.set(page, fetchScale);

        // Update LRU
        const idx = this.cacheOrder.indexOf(page);
        if (idx > -1) this.cacheOrder.splice(idx, 1);
        this.cacheOrder.push(page);

        // Evict old entries
        while (this.cacheOrder.length > this.PAGE_CACHE_SIZE) {
          const old = this.cacheOrder.shift()!;
          this.pageImageCache.delete(old);
          this.pageCacheScales.delete(old);
        }

        return blob;
      } finally {
        this.pendingImageRequests.delete(page);
      }
    })();

    this.pendingImageRequests.set(page, promise);
    return promise;
  }

  /**
   * Check if error is an abort error
   */
  private isAbortError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    const str = String(error);
    return str.includes('aborted') || str.includes('AbortError');
  }

  // ========== Gesture Handling ==========

  /**
   * Setup pointer events for pan
   */
  private setupPointerEvents(): void {
    this.viewport.addEventListener('pointerdown', this.handlePointerDown.bind(this));
    this.viewport.addEventListener('pointermove', this.handlePointerMove.bind(this));
    this.viewport.addEventListener('pointerup', this.handlePointerUp.bind(this));
    this.viewport.addEventListener('pointercancel', this.handlePointerUp.bind(this));
    this.viewport.addEventListener('pointerleave', this.handlePointerUp.bind(this));
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return; // Left button only

    // No panning in paginated mode
    if (this.config.displayMode === 'paginated') return;

    // Stop any ongoing inertia animation
    this.stopInertia();

    this.isPanning = true;
    this.lastPointerPosition = { x: e.clientX, y: e.clientY };
    this.panStartCamera = { ...this.camera };
    this.viewport.setPointerCapture(e.pointerId);
    this.viewport.style.cursor = 'grabbing';
    // Disable text selection during pan to prevent accidental selection
    this.viewport.style.userSelect = 'none';
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.isPanning || !this.lastPointerPosition) return;

    let dx = e.clientX - this.lastPointerPosition.x;
    let dy = e.clientY - this.lastPointerPosition.y;

    // Restrict panning based on display mode
    switch (this.config.displayMode) {
      case 'horizontal-scroll':
        // Only horizontal panning
        dy = 0;
        break;

      case 'vertical-scroll':
      case 'auto-grid':
        // Only vertical panning
        dx = 0;
        break;

      case 'canvas':
        // Free panning
        break;
    }

    // PHASE 2: Use mode-aware pan calculation (V4 Architecture)
    // Inverted signs for drag: moving cursor right should pan content left
    this.panWithMode(dx, dy, true);

    // Apply position constraints during panning
    this.constrainCameraPosition();

    this.applyTransform();
    // Use scheduled update to throttle to animation frame - prevents queue explosion
    // during fast scroll (was calling updateVisiblePages 60+ times/sec directly)
    this.scheduleVisiblePagesUpdate();

    // Update page counter during scroll (debounced)
    this.debouncedPageUpdate();

    this.lastPointerPosition = { x: e.clientX, y: e.clientY };
  }

  /**
   * Debounced page update during scrolling - updates every 100ms max
   */
  private debouncedPageUpdate(): void {
    const currentPage = this.getCurrentPage();

    // Only update if page actually changed
    if (currentPage !== this.lastReportedPage) {
      this.lastReportedPage = currentPage;

      // Clear any pending timeout
      if (this.pageUpdateTimeout) {
        clearTimeout(this.pageUpdateTimeout);
      }

      // Immediately notify of page change
      this.onPageChangeCallback?.(currentPage);
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.isPanning) return;

    this.isPanning = false;
    this.lastPointerPosition = null;
    this.panStartCamera = null;
    this.viewport.releasePointerCapture(e.pointerId);
    this.viewport.style.cursor = '';
    // Re-enable text selection after pan completes
    this.viewport.style.userSelect = '';

    // Update current page based on what's visible
    this.updateCurrentPage();
  }

  /**
   * Setup wheel events for zoom
   */
  private setupWheelEvents(): void {
    this.viewport.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });

    // Safari-specific gesture events for pinch-to-zoom
    // These are non-standard but needed for proper Safari support
    this.viewport.addEventListener('gesturestart', this.handleGestureStart.bind(this) as EventListener);
    this.viewport.addEventListener('gesturechange', this.handleGestureChange.bind(this) as EventListener);
    this.viewport.addEventListener('gestureend', this.handleGestureEnd.bind(this) as EventListener);
  }

  // Safari gesture state
  private gestureStartZoom = 1;

  private handleGestureStart(e: Event & { scale?: number }): void {
    e.preventDefault();
    this.stopInertia();
    this.gestureStartZoom = this.camera.z;
  }

  private handleGestureChange(e: Event & { scale?: number; clientX?: number; clientY?: number }): void {
    e.preventDefault();
    if (typeof e.scale !== 'number') return;

    const rect = this.viewport.getBoundingClientRect();
    const point: Point = {
      x: (e.clientX ?? rect.width / 2) - rect.left,
      y: (e.clientY ?? rect.height / 2) - rect.top,
    };

    // Calculate target zoom based on gesture scale
    const targetZoom = this.gestureStartZoom * e.scale;
    const delta = 1 - targetZoom / this.camera.z;
    this.zoomAtPoint(point, delta);
  }

  private handleGestureEnd(e: Event): void {
    e.preventDefault();
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();

    // PERF FIX: Suspend thumbnail generation during interaction
    this.suspendThumbnailsDuringInteraction();

    // Use cached rect to avoid layout thrashing
    const rect = this.getViewportRect();
    const point: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    // Detect zoom gesture:
    // - ctrlKey: Browsers send wheel events with ctrlKey=true for pinch-to-zoom
    // - metaKey: Cmd+scroll for explicit zoom
    // Note: Safari uses separate gesture events (handled by handleGestureChange)
    const isZoomGesture = e.ctrlKey || e.metaKey;

    // Track input event for input-to-visual latency measurement
    this.pendingInputLatencyId = getTelemetry().trackInputEvent(isZoomGesture ? 'zoom' : 'scroll');

    if (isZoomGesture) {
      // Zoom gesture (pinch or Cmd+scroll)
      this.stopInertia();
      // ZOOM SENSITIVITY: 0.012 gives ~12 wheel events from 1x to 16x
      // Formula: newZoom = oldZoom * (1 - delta), delta = deltaY * 0.012
      // At deltaY=-50: delta=-0.6, factor=1.6, so 1.6^7 ≈ 26 (reaches 16x in ~6-7 events)
      // This balances responsiveness with controllability.
      // Previous: 0.04 was too aggressive (3 events to max), 0.01 was too slow (14 events)
      const delta = e.deltaY * 0.012;
      this.zoomAtPoint(point, delta);
    } else {
      // Pan gesture - direct 1:1 mapping for responsive scrolling
      // The panCamera function handles zoom-adjusted movement
      let deltaX = e.deltaX;
      let deltaY = e.deltaY;

      // HIGH ZOOM PAN FIX: At high zoom (> 1.5x), allow free panning regardless
      // of display mode. User needs to pan both directions to see full page.
      const allowFreePan = this.camera.z > 1.5;

      if (!allowFreePan) {
        switch (this.config.displayMode) {
          case 'paginated':
            // No panning in paginated mode
            return;

          case 'horizontal-scroll':
            // Only horizontal panning allowed
            // Use deltaY for horizontal scroll if deltaX is 0 (mouse wheel)
            if (Math.abs(deltaX) < 1 && Math.abs(deltaY) > 1) {
              deltaX = deltaY;
            }
            deltaY = 0;
            break;

          case 'vertical-scroll':
          case 'auto-grid':
            // Only vertical panning allowed
            deltaX = 0;
            break;

          case 'canvas':
            // Free panning - use both deltas
            break;
        }
      }
      // At high zoom (allowFreePan=true), use both deltas for free panning

      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;

      // Track velocity for adaptive rendering decisions
      const now = performance.now();
      const dt = Math.max(1, now - this.lastWheelTime);
      this.velocity = {
        x: deltaX / dt * 16, // Normalize to ~60fps frame time
        y: deltaY / dt * 16,
      };
      this.lastWheelTime = now;

      // PHASE 2: Use mode-aware pan calculation (V4 Architecture)
      // Direct signs for wheel: scrolling down should move content up
      this.panWithMode(deltaX, deltaY, false);

      this.constrainCameraPosition();

      // Apply transform immediately for responsive feedback
      this.applyTransform();

      // Defer visible pages update to next frame to keep scroll smooth
      this.scheduleVisiblePagesUpdate();

      // Update page counter during wheel scroll
      this.debouncedPageUpdate();

      // CRITICAL: Schedule re-render at correct scale when scrolling at high zoom
      // Uses shorter debounce (32ms) than zoom (150ms) for responsive scroll rendering
      if (this.camera.z > this.tileZoomThreshold) {
        this.scheduleScrollRerender();
      }
    }
  }

  /**
   * Schedule visible pages update for next animation frame
   * Coalesces multiple updates into one to avoid thrashing
   */
  private scheduleVisiblePagesUpdate(): void {
    if (this.pendingVisiblePagesUpdate) return;

    this.pendingVisiblePagesUpdate = true;
    requestAnimationFrame(() => {
      this.pendingVisiblePagesUpdate = false;
      this.updateVisiblePages();
    });
  }

  /**
   * Stop inertia animation
   */
  private stopInertia(): void {
    if (this.inertiaAnimationFrame !== null) {
      cancelAnimationFrame(this.inertiaAnimationFrame);
      this.inertiaAnimationFrame = null;
    }
    if (this.scheduleInertiaTimeout !== null) {
      clearTimeout(this.scheduleInertiaTimeout);
      this.scheduleInertiaTimeout = null;
    }
    this.velocity = { x: 0, y: 0 };
  }

  /**
   * Suspend thumbnail generation during user interaction.
   *
   * PERF FIX: Thumbnail generation competes with interactive rendering for
   * worker pool resources. Suspending during scroll/zoom ensures interactive
   * tile renders get priority, reducing input-to-visual latency.
   *
   * Automatically schedules resume after interaction ends (debounced).
   */
  private suspendThumbnailsDuringInteraction(): void {
    // Suspend immediately
    this.provider.suspendThumbnailGeneration?.();

    // Clear any pending resume
    if (this.thumbnailSuspensionResumeTimeout !== null) {
      clearTimeout(this.thumbnailSuspensionResumeTimeout);
    }

    // Schedule resume after interaction ends
    this.thumbnailSuspensionResumeTimeout = setTimeout(() => {
      this.thumbnailSuspensionResumeTimeout = null;
      this.provider.resumeThumbnailGeneration?.();
    }, this.THUMBNAIL_SUSPENSION_RESUME_DELAY);
  }

  /**
   * Schedule inertia animation to start after wheel events stop
   */
  private scheduleInertia(): void {
    // Clear any pending scheduled inertia
    if (this.scheduleInertiaTimeout !== null) {
      clearTimeout(this.scheduleInertiaTimeout);
    }

    // Use a small timeout to detect when wheel events stop
    this.scheduleInertiaTimeout = setTimeout(() => {
      this.scheduleInertiaTimeout = null;
      const timeSinceLastWheel = performance.now() - this.lastWheelTime;
      if (timeSinceLastWheel >= 50) {
        // Wheel events have stopped, start inertia if velocity is high enough (fling)
        this.startInertia();
      }
    }, 60);
  }

  /**
   * Start inertia animation (only for fling gestures)
   */
  private startInertia(): void {
    const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);

    // Only start inertia for fast fling gestures, not slow precise scrolls
    if (speed < this.INERTIA_START_THRESHOLD) {
      return;
    }

    let lastFrameTime = performance.now();

    const animate = () => {
      const now = performance.now();
      const frameTime = now - lastFrameTime;
      lastFrameTime = now;

      // Track scroll frame for telemetry
      const currentSpeed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
      getTelemetry().trackScrollFrame(currentSpeed, frameTime);

      // PHASE 2: Use mode-aware pan calculation (V4 Architecture)
      // Direct signs for inertia: continues momentum in scroll direction
      this.panWithMode(this.velocity.x, this.velocity.y, false);

      this.constrainCameraPosition();
      this.applyTransform();
      this.updateVisiblePages();

      // Update page counter during inertia
      this.debouncedPageUpdate();

      // CRITICAL FIX: Schedule tile re-render during inertia at high zoom
      // Without this, tiles stay at stale scale during momentum scroll,
      // causing blur and placeholders.
      //
      // NOTE: We use THROTTLE (not debounce) during inertia because:
      // - RAF runs at ~16ms, debounce is 32ms
      // - Pure debounce would constantly reset, never firing during motion
      // - Throttle allows periodic renders (every 50ms = 20 FPS tile updates)
      //   while camera snapshot ensures correct visibility calculation
      if (this.camera.z > this.tileZoomThreshold) {
        const now = performance.now();
        if (now - this.lastScrollRenderTime >= this.INERTIA_RENDER_THROTTLE) {
          this.scheduleScrollRerender();
          this.lastScrollRenderTime = now;
        }
      }

      // Decay velocity
      this.velocity = {
        x: this.velocity.x * this.INERTIA_DECAY,
        y: this.velocity.y * this.INERTIA_DECAY,
      };

      // Continue or stop
      const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
      if (speed > this.INERTIA_MIN_VELOCITY) {
        this.inertiaAnimationFrame = requestAnimationFrame(animate);
      } else {
        this.inertiaAnimationFrame = null;
        this.updateCurrentPage();
      }
    };

    this.inertiaAnimationFrame = requestAnimationFrame(animate);
  }

  /**
   * Zoom at a specific point
   */
  private zoomAtPoint(point: Point, delta: number): void {
    // FOCAL POINT FIX: Track the focal point for ZoomTransformLayer
    // This ensures the zoom origin is consistent throughout the render pipeline,
    // preventing focus drift when ZoomTransformLayer calculates its transforms.
    this.lastZoomFocalPoint = point;

    // NOTE: Old flag-based zoom blocking has been replaced by ZoomStateMachine.
    // The state machine provides centralized blocking via canRender() and handles:
    // - 150ms gesture end detection (via gestureEndTimer)
    // - 200ms settling period before rendering (via settlingTimer)
    // - Automatic abort of pending renders when gesture starts
    // - Callback to trigger re-render when settling completes

    const oldZoom = this.camera.z;

    // PERF FIX: Suspend thumbnail generation during zoom interaction
    this.suspendThumbnailsDuringInteraction();

    // Get mode-specific zoom constraints
    const { minZoom, maxZoom } = this.getZoomConstraints();
    const constraints: CameraConstraints = {
      ...this.cameraConstraints,
      minZoom,
      maxZoom,
    };

    this.camera = zoomCameraToPoint(this.camera, point, delta, constraints);

    if (this.camera.z !== oldZoom) {
      // Track zoom change for telemetry
      getTelemetry().trackZoomChange(oldZoom, this.camera.z);

      // CRITICAL FIX: Apply position constraints BEFORE capturing snapshot.
      // Previously, the snapshot was captured with unconstrained camera position,
      // but the displayed camera was constrained. This caused tiles to be rendered
      // for a position that didn't match what the user sees ("shifted zoom landing").
      //
      // By constraining first, the snapshot matches the actual displayed position,
      // ensuring tiles are rendered for the correct viewport.
      this.constrainCameraPosition();

      // STATE MACHINE: Notify ZoomStateMachine of zoom change.
      // This replaces the old flag-based approach with centralized state management.
      // The state machine will:
      // - Block all render paths via canRender()
      // - Abort pending renders on first zoom event
      // - Start 150ms gesture end detection timer
      // - After gesture ends + 200ms settling, trigger re-render callback
      //
      // NOTE: Snapshot now captures the CONSTRAINED camera position (matches display)
      if (this.zoomStateMachine.getCurrentState() === 'idle') {
        this.zoomStateMachine.startZoomGesture(
          this.camera.z,
          point,
          { ...this.camera }
        );
      } else {
        this.zoomStateMachine.updateZoomGesture(
          this.camera.z,
          point,
          { ...this.camera }
        );
      }

      // NOTE: Removed abortAllPending() call - the ZoomStateMachine now handles this.
      // The state machine aborts pending renders in startZoomGesture() when transitioning
      // from 'idle' to 'zooming'. During the zooming state, canRender() guards prevent
      // new renders from being queued, so there's nothing to abort on subsequent events.

      // NOTE: Cache eviction moved to handleZoomRenderPhase() final phase.
      // Evicting during zoom gesture caused cache misses → fallback tiles → cssStretch drift.
      // Now we evict AFTER the gesture completes when all tiles are rendered at target scale.

      // Check if we need to relayout (only for auto-grid mode)
      // Pass the focus point so the page under cursor stays stationary
      if (this.shouldRelayout()) {
        this.relayoutPages(point);
      }

      // UNIFIED COORDINATE SPACE: Resize page elements to final zoomed dimensions.
      // In unified mode, pages are sized to their final display size (no CSS scaling),
      // which eliminates cssStretch-related visual jumps during zoom transitions.
      if (this.useUnifiedCoordinateSpace) {
        const newZoom = this.camera.z;
        for (const [page, element] of this.pageElements) {
          const layout = this.pageLayouts.get(page);
          if (layout) {
            // Final dimensions = base layout × zoom
            const finalWidth = layout.width * newZoom;
            const finalHeight = layout.height * newZoom;
            element.setFinalDimensions(finalWidth, finalHeight, newZoom);

            // Update element position to match zoomed layout
            const elem = element.getElement();
            elem.style.left = `${layout.x * newZoom}px`;
            elem.style.top = `${layout.y * newZoom}px`;
          }
        }

        // Update canvas bounds to match zoomed content
        const zoomRatioForBounds = newZoom / oldZoom;
        this.canvasBounds = {
          width: this.canvasBounds.width * zoomRatioForBounds,
          height: this.canvasBounds.height * zoomRatioForBounds,
        };
        this.canvas.style.width = `${this.canvasBounds.width}px`;
        this.canvas.style.height = `${this.canvasBounds.height}px`;
      }

      this.applyTransform();

      // NOTE: Previously cleared page canvases on large zoom changes (> 2x) to prevent
      // showing shifted content. However, clearing causes pages to DISAPPEAR entirely
      // until new tiles render (50-200ms+), which is poor UX.
      //
      // NEW BEHAVIOR: Keep old tiles visible during zoom. The camera CSS transform
      // scales existing content immediately (GPU-accelerated), providing instant
      // visual feedback. Old tiles may appear stretched/compressed until fresh tiles
      // arrive, but this is far better than blank pages.
      //
      // This matches iOS/macOS behavior: show degraded content while rendering,
      // rather than showing nothing.

      // PHASE 0: Record zoom operation for debugging
      getCoordinateDebugger().recordZoom(
        {
          point,
          delta,
          cameraBefore: { x: this.camera.x, y: this.camera.y, z: oldZoom },
          unifiedMode: this.useUnifiedCoordinateSpace,
        },
        {
          cameraAfter: { ...this.camera },
          pagesResized: this.pageElements.size,
          canvasBoundsAfter: { ...this.canvasBounds },
        }
      );

      // Throttle to animation frame to prevent queue explosion during fast pinch/zoom
      this.scheduleVisiblePagesUpdate();

      // NOTE: Removed scheduleZoomRerender() call - the ZoomStateMachine now handles
      // zoom re-rendering via its onRenderPhase callback, which triggers after the
      // gesture ends (150ms) and settling period (200ms).

      this.onZoomChangeCallback?.(this.camera.z);
    }
  }

  /**
   * Setup keyboard events
   */
  private setupKeyboardEvents(): void {
    this.viewport.tabIndex = 0;
    this.viewport.addEventListener('keydown', this.handleKeyDown.bind(this));
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const isCtrl = e.ctrlKey || e.metaKey;

    if (isCtrl && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      this.zoomIn();
    } else if (isCtrl && e.key === '-') {
      e.preventDefault();
      this.zoomOut();
    } else if (isCtrl && e.key === '0') {
      e.preventDefault();
      this.resetZoom();
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      this.nextPage();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      this.prevPage();
    }
  }

  /**
   * Setup double-click handler for focusing on a page
   */
  private setupDoubleClickHandler(): void {
    this.viewport.addEventListener('dblclick', this.handleDoubleClick.bind(this));
  }

  private handleDoubleClick(e: MouseEvent): void {
    // Only handle in auto-grid and canvas modes
    if (this.config.displayMode !== 'auto-grid' && this.config.displayMode !== 'canvas') {
      return;
    }

    const rect = this.viewport.getBoundingClientRect();
    const screenPoint: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    // Convert screen point to canvas coordinates
    const canvasPoint = {
      x: screenPoint.x / this.camera.z - this.camera.x,
      y: screenPoint.y / this.camera.z - this.camera.y,
    };

    // Find which page was clicked
    let clickedPage: number | null = null;
    for (const [page, layout] of this.pageLayouts) {
      if (
        canvasPoint.x >= layout.x &&
        canvasPoint.x <= layout.x + layout.width &&
        canvasPoint.y >= layout.y &&
        canvasPoint.y <= layout.y + layout.height
      ) {
        clickedPage = page;
        break;
      }
    }

    if (clickedPage) {
      // Fit the clicked page in view with animation
      this.fitPageInView(clickedPage, true);
      this.onPageChangeCallback?.(clickedPage);
    }
  }

  // ========== Public API ==========

  /**
   * Get current zoom level
   */
  getZoom(): number {
    return this.camera.z;
  }

  /**
   * Set zoom level
   */
  setZoom(zoom: number): void {
    const viewportRect = this.viewport.getBoundingClientRect();
    const center: Point = {
      x: viewportRect.width / 2,
      y: viewportRect.height / 2,
    };

    // Calculate delta to reach target zoom
    const delta = 1 - zoom / this.camera.z;
    this.zoomAtPoint(center, delta);
  }

  /**
   * Zoom in
   */
  zoomIn(): void {
    this.setZoom(this.camera.z * 1.25);
  }

  /**
   * Zoom out
   */
  zoomOut(): void {
    this.setZoom(this.camera.z * 0.8);
  }

  /**
   * Reset zoom to 100%
   */
  resetZoom(): void {
    this.setZoom(1);
  }

  /**
   * Fit the current page to the viewport
   */
  fitToPage(): void {
    const currentPage = this.getCurrentPage();
    this.fitPageInView(currentPage, true);
  }

  /**
   * Fit page width to viewport (useful for reading)
   */
  fitToWidth(): void {
    const layout = this.pageLayouts.get(1);
    if (!layout) return;

    const viewportRect = this.viewport.getBoundingClientRect();
    const { padding } = this.config;
    const availableWidth = viewportRect.width - padding * 2;

    // Calculate zoom to fit page width
    const zoom = availableWidth / layout.width;

    // Position camera to show current page
    const currentPage = this.getCurrentPage();
    const currentLayout = this.pageLayouts.get(currentPage);
    if (currentLayout) {
      this.camera = {
        x: padding / zoom,
        y: viewportRect.height / (2 * zoom) - currentLayout.y - currentLayout.height / 2,
        z: zoom,
      };
      this.applyTransform();
      this.updateVisiblePages();
    }
  }

  /**
   * Fit page in view
   */
  fitPageInView(page: number, animate = true): void {
    const layout = this.pageLayouts.get(page);
    if (!layout) return;

    const viewportRect = this.viewport.getBoundingClientRect();
    const targetCamera = fitBoxInView(
      { x: layout.x, y: layout.y, width: layout.width, height: layout.height },
      viewportRect.width,
      viewportRect.height,
      this.config.padding,
      this.cameraConstraints
    );

    if (animate) {
      this.animateTo(targetCamera);
    } else {
      this.camera = targetCamera;
      this.applyTransform();
      this.updateVisiblePages();
    }
  }

  /**
   * Go to a specific page
   */
  goToPage(page: number): void {
    page = Math.max(1, Math.min(page, this.pageCount));
    // Abort stale renders - we're jumping to a new page so old requests are obsolete
    this.renderCoordinator?.abortAllPending();
    this.fitPageInView(page, true);
    this.onPageChangeCallback?.(page);
  }

  /**
   * Next page
   */
  nextPage(): void {
    const current = this.getCurrentPage();
    if (current < this.pageCount) {
      this.goToPage(current + 1);
    }
  }

  /**
   * Previous page
   */
  prevPage(): void {
    const current = this.getCurrentPage();
    if (current > 1) {
      this.goToPage(current - 1);
    }
  }

  /**
   * Get current page (based on what's most visible)
   *
   * PERFORMANCE OPTIMIZATION: Uses O(1) calculation instead of O(N) iteration.
   * Calculates page directly from camera position using grid layout formulas.
   */
  getCurrentPage(): number {
    const viewportRect = this.viewport.getBoundingClientRect();
    const centerX = viewportRect.width / 2;
    const centerY = viewportRect.height / 2;

    // Convert screen center to canvas coordinates
    // Formula: screenToCanvas(screen, camera) = screen / zoom - camera
    const canvasCenterX = centerX / this.camera.z - this.camera.x;
    const canvasCenterY = centerY / this.camera.z - this.camera.y;

    const { layoutMode, pagesPerRow } = this.config;
    const cellWidth = this.layoutBaseWidth + this.layoutGap;
    const cellHeight = this.layoutBaseHeight + this.layoutGap;
    const padding = this.layoutPadding;

    let page: number;

    if (layoutMode === 'vertical') {
      // Single column - calculate row from Y position
      const row = Math.round((canvasCenterY - padding - this.layoutBaseHeight / 2) / cellHeight);
      page = Math.max(1, Math.min(this.pageCount, row + 1));
    } else if (layoutMode === 'horizontal') {
      // Single row - calculate column from X position
      const col = Math.round((canvasCenterX - padding - this.layoutBaseWidth / 2) / cellWidth);
      page = Math.max(1, Math.min(this.pageCount, col + 1));
    } else {
      // Grid layout - calculate both row and column
      const row = Math.round((canvasCenterY - padding - this.layoutBaseHeight / 2) / cellHeight);
      const col = Math.round((canvasCenterX - padding - this.layoutBaseWidth / 2) / cellWidth);
      const clampedCol = Math.max(0, Math.min(pagesPerRow - 1, col));
      const clampedRow = Math.max(0, row);
      page = clampedRow * pagesPerRow + clampedCol + 1;
      page = Math.max(1, Math.min(this.pageCount, page));
    }

    return page;
  }

  /**
   * Update current page and notify
   */
  private updateCurrentPage(): void {
    const page = this.getCurrentPage();
    this.onPageChangeCallback?.(page);
  }

  /**
   * Animate camera to target
   */
  private animateTo(target: Camera, duration = 300): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }

    const start = { ...this.camera };
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      this.camera = lerpCamera(start, target, progress);
      this.applyTransform();
      this.updateVisiblePages();

      if (progress < 1) {
        this.animationFrame = requestAnimationFrame(animate);
      } else {
        this.animationFrame = null;
        this.onZoomChangeCallback?.(this.camera.z);
      }
    };

    this.animationFrame = requestAnimationFrame(animate);
  }

  /**
   * Set reading mode
   */
  setReadingMode(mode: ReadingMode): void {
    this.config.readingMode = mode;
    for (const element of this.pageElements.values()) {
      element.setReadingMode(mode);
    }
  }

  /**
   * Set highlights for a page
   */
  setHighlightsForPage(page: number, highlights: PageHighlight[]): void {
    const element = this.pageElements.get(page);
    if (element) {
      element.setHighlights(highlights);
    }
  }

  /**
   * Set callbacks
   */
  setOnPageChange(callback: (page: number) => void): void {
    this.onPageChangeCallback = callback;
  }

  setOnZoomChange(callback: (zoom: number) => void): void {
    this.onZoomChangeCallback = callback;
  }

  setOnSelection(callback: (page: number, text: string, rects: DOMRect[]) => void): void {
    this.onSelectionCallback = callback;
  }

  setOnHighlightClick(callback: (annotationId: string, position: { x: number; y: number }) => void): void {
    this.onHighlightClickCallback = callback;
  }

  /**
   * Handle resize
   */
  handleResize(): void {
    // Update cached viewport rect
    this.cachedViewportRect = this.viewport.getBoundingClientRect();
    this.cameraConstraints.viewport = {
      width: this.cachedViewportRect.width,
      height: this.cachedViewportRect.height,
    };
    this.updateVisiblePages();
  }

  /**
   * Get viewport rect (cached to avoid layout thrashing)
   */
  private getViewportRect(): DOMRect {
    if (!this.cachedViewportRect) {
      this.cachedViewportRect = this.viewport.getBoundingClientRect();
    }
    return this.cachedViewportRect;
  }

  /**
   * Check if two rectangles overlap
   */
  private rectsOverlap(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number }
  ): boolean {
    return !(
      a.x + a.width < b.x ||
      b.x + b.width < a.x ||
      a.y + a.height < b.y ||
      b.y + b.height < a.y
    );
  }

  /**
   * Get page count
   */
  getPageCount(): number {
    return this.pageCount;
  }

  /**
   * Get current display mode
   */
  getDisplayMode(): DisplayMode {
    return this.config.displayMode;
  }

  /**
   * Set display mode
   */
  setDisplayMode(mode: DisplayMode): void {
    if (this.config.displayMode === mode) return;

    const currentPage = this.getCurrentPage();

    // Notify render coordinator of mode change (for cache management)
    if (this.renderCoordinator) {
      const coordinatorMode = this.getCoordinatorMode(mode);
      this.renderCoordinator.setMode(coordinatorMode);
    }

    this.config.displayMode = mode;

    // Initialize layout based on new mode
    this.initializeDisplayMode();

    // Recalculate layouts
    this.calculatePageLayouts();
    this.updateCanvasSize();

    // Update constraints
    this.cameraConstraints.bounds = this.canvasBounds;
    const viewportRect = this.viewport.getBoundingClientRect();
    this.cameraConstraints.viewport = {
      width: viewportRect.width,
      height: viewportRect.height,
    };

    // Clear and recreate elements
    for (const element of this.pageElements.values()) {
      element.destroy();
    }
    this.pageElements.clear();
    this.renderQueue = [];
    this.renderVersion++;

    // Setup initial view for new mode
    this.setupInitialView();

    // Center on current page
    this.fitPageInView(currentPage, false);

    // Apply constraints
    this.constrainCameraPosition();
    this.applyTransform();
    this.updateVisiblePages();
  }

  /**
   * Map display mode to render coordinator mode
   */
  private getCoordinatorMode(displayMode: DisplayMode): RenderMode {
    switch (displayMode) {
      case 'paginated':
        return 'paginated';
      case 'vertical-scroll':
      case 'horizontal-scroll':
        return 'scroll';
      case 'auto-grid':
      case 'canvas':
        return 'grid';
      default:
        return 'paginated';
    }
  }

  /**
   * Update layout mode (internal, use setDisplayMode for user-facing mode changes)
   */
  setLayoutMode(mode: 'vertical' | 'horizontal' | 'grid', pagesPerRow = 1): void {
    // Clear any pending scroll rerender to prevent stale layout params from being used
    if (this.scrollRerenderTimeout) {
      clearTimeout(this.scrollRerenderTimeout);
      this.scrollRerenderTimeout = null;
      this.scrollRenderSnapshot = null;
    }

    const currentPage = this.getCurrentPage();

    this.config.layoutMode = mode;

    // Update columns based on layout mode
    if (mode === 'horizontal') {
      this.currentColumns = this.pageCount;
      this.config.pagesPerRow = this.pageCount;
    } else if (mode === 'grid') {
      this.currentColumns = pagesPerRow;
      this.config.pagesPerRow = pagesPerRow;
    } else {
      this.currentColumns = 1;
      this.config.pagesPerRow = 1;
    }

    // Recalculate layouts
    this.calculatePageLayouts();
    this.updateCanvasSize();

    // Update constraints
    this.cameraConstraints.bounds = this.canvasBounds;
    const viewportRect = this.viewport.getBoundingClientRect();
    this.cameraConstraints.viewport = {
      width: viewportRect.width,
      height: viewportRect.height,
    };

    // Clear and recreate elements
    for (const element of this.pageElements.values()) {
      element.destroy();
    }
    this.pageElements.clear();
    this.renderQueue = [];
    this.renderVersion++;

    // Center on current page
    this.fitPageInView(currentPage, false);

    // Apply constraints
    this.constrainCameraPosition();
    this.applyTransform();
    this.updateVisiblePages();
  }

  /**
   * Clear caches
   */
  clearCache(): void {
    this.pageImageCache.clear();
    this.pageCacheScales.clear();
    this.cacheOrder = [];
    this.pageWasTiled.clear();
  }

  /**
   * Destroy canvas
   */
  destroy(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }

    // Cleanup ResizeObserver
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Stop inertia animation
    this.stopInertia();

    // Clear zoom re-render timeouts
    if (this.zoomRerenderTimeout) {
      clearTimeout(this.zoomRerenderTimeout);
      this.zoomRerenderTimeout = null;
    }
    if (this.zoomFinalRenderTimeout) {
      clearTimeout(this.zoomFinalRenderTimeout);
      this.zoomFinalRenderTimeout = null;
    }

    // Clear scroll re-render timeout and snapshot
    if (this.scrollRerenderTimeout) {
      clearTimeout(this.scrollRerenderTimeout);
      this.scrollRerenderTimeout = null;
    }
    this.scrollRenderSnapshot = null;
    this.zoomRenderSnapshot = null;

    // Clear thumbnail suspension timeout and ensure resumed
    if (this.thumbnailSuspensionResumeTimeout) {
      clearTimeout(this.thumbnailSuspensionResumeTimeout);
      this.thumbnailSuspensionResumeTimeout = null;
    }
    // Ensure thumbnails are resumed on destroy
    this.provider.resumeThumbnailGeneration?.();

    // Destroy ZoomStateMachine
    if (this.zoomStateMachine) {
      this.zoomStateMachine.destroy();
    }

    // Destroy ZoomTransformLayer
    if (this.zoomTransformLayer) {
      this.zoomTransformLayer.destroy();
      this.zoomTransformLayer = null;
    }

    // UNIFIED COORDINATE SPACE: No cssStretch state to clear

    // Reset scale tracking state
    this.scaleVersion = 0;
    this.currentRenderScale = 4;

    for (const element of this.pageElements.values()) {
      element.destroy();
    }
    this.pageElements.clear();
    this.clearCache();
    this.viewport.remove();
  }
}

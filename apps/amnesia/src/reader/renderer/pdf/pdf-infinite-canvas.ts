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

import { PdfPageElement, type PageRenderData, type PageHighlight, type ReadingMode, type TransformSnapshot, type RenderResult } from './pdf-page-element';
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
  screenToCanvas, // FOCAL-POINT-RADIAL: Convert screen focal point to canvas coordinates
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
import { getDevicePixelRatio } from './dpr-utils';
import {
  getTargetScaleTier,
  getExactTargetScale,
  getProgressiveTileRenderer,
  GPU_SAFE_MAX_SCALE,
  type ScaleTier,
} from './progressive-tile-renderer';
import { ZoomTransformLayer, type ZoomPhase } from './zoom-transform-layer';
// NOTE: ZoomStateMachine, ZoomStateManager, ScaleStateManager removed (amnesia-aqv refactor)
// All state now managed by ZoomScaleService
import {
  ZoomScaleService,
  createZoomScaleService,
  clearZoomScaleService,
  type GesturePhase,
  type RenderMode as ZoomRenderMode,
} from './zoom-scale-service';
import { getRenderSessionManager } from './render-session';
import { getTileIntegrityChecker, type TileRequest } from './tile-integrity-checker';
import { getScrollStrategy } from './scroll-strategy';
// amnesia-aqv Phase 0: Diagnostic overlay for mode transition tracking
import { getTileDiagnosticOverlay, type ModeTransitionEvent } from './tile-diagnostic-overlay';
// Diagnostic trackers for T2HR and focal-point analysis
import { getT2HRTracker, type TileRequestSource } from './t2hr-tracker';
import { getFocalPointTracker } from './focal-point-tracker';
// Tile corruption diagnostics (amnesia-26v)
import { diagnoseModeTransition, isDiagnosticsEnabled } from './tile-corruption-diagnostics';
// amnesia-aqv: Gesture correlation for tile lifecycle tracing
import { getTileLifecycleTracer, generateGestureId } from './tile-lifecycle-tracer';

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
  maxZoom: 32, // Allow very high zoom for detailed viewing (amnesia-pi0)
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

  // amnesia-aqv FIX: Per-canvas page dimensions map.
  // The shared TileEngine singleton gets overwritten when multiple documents are open,
  // causing page elements to receive wrong dimensions from OTHER documents.
  // This local copy captures the correct dimensions for THIS document at initialization time.
  private localPageDimensions: Map<number, { width: number; height: number }> = new Map();

  // Layout constants for O(1) page visibility calculation
  private layoutBaseWidth = 400;
  private layoutBaseHeight = 518; // Will be recalculated based on aspect ratio
  private layoutPadding = 24;
  private layoutGap = 16;

  // Rendering
  private visiblePages: Set<number> = new Set();
  private renderQueue: number[] = [];
  private isRendering = false;
  // NOTE: renderVersion removed (amnesia-l0r) - now using ZoomStateManager.getEpoch()

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

  // MODE TRANSITION LOGIC CONSOLIDATED (amnesia-wbp)
  // All mode transition logic now lives in ScaleStateManager:
  // - Thresholds: RENDER_MODE_THRESHOLDS.ADAPTIVE_TO_TILED (4.0), MAX_TILED_ZOOM (64.0)
  // - Hysteresis: 10% multiplicative (e.g., 4.0 * 1.1 = 4.4 for upward transition)
  // - Gesture-aware: committedRenderMode (stable during gesture), pendingRenderMode (current)
  // MIGRATION (amnesia-d9f): Use zoomScaleService.getRenderMode() for ALL mode decisions.
  // ScaleStateManager is deprecated for mode decisions - only used for focal point/quality.
  //
  // Local tracking: lastExecutedRenderMode tracks what mode we've executed (for transition detection).
  // 'adaptive' is treated as 'full-page' for rendering purposes (both use full-page render).
  private lastExecutedRenderMode: 'full-page' | 'tiled' = 'full-page';

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

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTURE CORRELATION (amnesia-aqv)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Tracks the current gesture ID for correlating tile requests with arrivals.
  // Used to implement the "Hybrid Guard" pattern:
  // 1. Tiles from a previous gesture are discarded (prevents stale overwrites)
  // 2. Within the same gesture, monotonicity is enforced (scale can only go UP)
  //
  // This solves the scale regression bug where scale-4 fallback tiles overwrote
  // scale-32 high-res content during zoom-out transitions.
  //
  // A new gestureId is generated when:
  // - A scroll gesture starts (first scroll event after idle)
  // - A zoom gesture starts (idle -> active transition in ZoomScaleService)
  private currentGestureId: string = generateGestureId();



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

  // amnesia-e4i: Cumulative pan distance tracking for queue clearing
  // Tracks how far the viewport has moved since last queue clear.
  // When cumulative distance exceeds viewport size, clear stale tile queue.
  private cumulativePanDistance = 0;
  private lastQueueClearPosition: Point = { x: 0, y: 0 };

  // NAVIGATION RECOVERY FIX: Track "cold" pages that were outside keep buffer.
  // When pages scroll back into view after being evicted, they need forced re-render
  // because Chromium's tile manager may have dropped their GPU textures even though
  // our isRendered flag is still true. Without this, pages appear blank after
  // high-zoom pan followed by zoom-out scroll.
  private coldPages: Set<number> = new Set();
  // Track last known keep buffer pages for cold detection
  private lastKeepBufferPages: Set<number> = new Set();

  // ZOOM SCALE SERVICE (amnesia-aqv): Unified service - single source of truth for:
  // - Zoom state and gesture phase (idle, active, settling, rendering)
  // - Epoch counter (incremented on zoom change, mode change, invalidation)
  // - Scale and cssStretch (derived from zoom, never stored)
  // - Render mode (full-page, adaptive, tiled) with hysteresis
  // - Rebound detection for trackpad gesture artifacts
  // - Focal point for tile priority ordering
  // Replaces: ZoomOrchestrator, ZoomStateMachine, ZoomStateManager, ScaleStateManager
  private zoomScaleService!: ZoomScaleService;

  // UNIFIED COORDINATE SPACE (Phase 2): Controls whether we use the new coordinate system.
  // When true:
  // - Page elements are sized to their final displayed dimensions (zoom × layout)
  // - Camera transform is translate-only (no scale)
  // - Camera x/y are in screen pixels (not divided by zoom)
  // When false (default):
  // - Legacy mode with scale transform
  // - cssStretch mechanism (removed but could be added back if needed)
  //
  // Unified coordinate space is disabled - use legacy mode where container
  // stays at base size and camera transform handles zoom.
  private useUnifiedCoordinateSpace: boolean = false;

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
  
  // amnesia-xc0: Page refresh debouncing for onTileReady callback
  // Prevents excessive re-composites when many tiles finish in quick succession
  private pendingPageRefresh: Map<number, ReturnType<typeof setTimeout>> = new Map();
  
  // amnesia-e4i.1: Global rate limiting for composite operations
  // Prevents renderer overload from rapid tile completions across multiple pages
  private lastGlobalCompositeTime = 0;
  private globalCompositeCount = 0;
  private readonly GLOBAL_COMPOSITE_INTERVAL_MS = 250; // Max 4 composites/second globally
  private readonly MAX_COMPOSITES_PER_INTERVAL = 2; // Max 2 composites per interval

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
    // REVERTED (amnesia-aev): Viewport containment removed as part of CVV revert.
    // The LLM Council determined that while viewport containment itself doesn't break
    // coordinates, the overall CVV approach (with content-visibility on pages) is
    // incompatible with getBoundingClientRect()-based tile positioning.
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
    // GPU LAYER PROMOTION: will-change + backface-visibility ensure the canvas
    // is promoted to its own compositing layer for smooth 60fps zoom/pan.
    //
    // TILE MEMORY FIX (amnesia-aev): Add `contain: layout style` to create a
    // stacking context boundary. This helps Chromium's compositor bound its
    // tile calculations to this subtree, reducing memory pressure at high zoom.
    // Unlike `contain: paint` (which clips content) or `contain: size` (which
    // breaks auto-sizing), `layout style` preserves coordinate accuracy while
    // providing isolation benefits.
    this.canvas = document.createElement('div');
    this.canvas.className = 'pdf-infinite-canvas';
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
      will-change: transform;
      backface-visibility: hidden;
      contain: layout style;
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
      
      // amnesia-xc0: Register onTileReady callback to trigger epoch-gated re-composite
      // when tiles finish rendering in the background.
      // 
      // This fixes the "nudge bug" where tiles render but don't display until user pans.
      // The epoch parameter enables validation that tiles are compatible with the
      // current canvas render state before drawing them.
      if (this.renderCoordinator) {
        this.renderCoordinator.onTileReady = (page: number, priority: import('./render-coordinator').RenderPriority, scaleEpoch: number) => {
          this.schedulePageRefresh(page, priority, scaleEpoch);
        };
      }
    }

    // Initialize ZoomTransformLayer for progressive zoom rendering.
    // CSS transforms are enabled for smooth 60fps zoom feedback.
    // The camera system applies transforms via getCameraTransform() using translate3d
    // for GPU compositing. ZoomTransformLayer manages timing/phase scheduling
    // and progressive render coordination.
    if (isFeatureEnabled('useMultiResZoom')) {
      this.zoomTransformLayer = new ZoomTransformLayer(this.canvas, {
        pixelRatio: this.config.pixelRatio,
        intermediateDelay: this.ZOOM_INTERMEDIATE_DELAY,
        finalDelay: this.ZOOM_FINAL_DELAY,
        disableCssTransforms: false, // CSS transforms enabled for smooth zoom
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

    }

    // Initialize ZoomScaleService (amnesia-aqv): Single source of truth for all zoom/scale state.
    // Replaces: ZoomOrchestrator, ZoomStateMachine, ZoomStateManager, ScaleStateManager
    const docId = this.provider.getDocumentId?.() ?? 'default';
    this.documentId = docId;
    
    this.zoomScaleService = createZoomScaleService({
      pixelRatio: this.config.pixelRatio,
      minZoom: this.config.minZoom,
      maxZoom: this.config.maxZoom,
      initialZoom: this.camera.z,
      initialPosition: { x: this.camera.x, y: this.camera.y },
      gestureEndDelay: 300,
      settlingDelay: 200,
    });

    // Wire ZoomScaleService callbacks - this is now the ONLY state machine
    this.zoomScaleService.onGestureStart = () => {
      // amnesia-aqv: Generate new gestureId for zoom gestures
      const oldGestureId = this.currentGestureId;
      this.currentGestureId = generateGestureId();
      getTileLifecycleTracer().emit({
        type: 'gesture.started',
        gestureId: this.currentGestureId,
        metadata: { trigger: 'zoom', previousGestureId: oldGestureId },
      });
      console.log(`[GESTURE] New zoom gesture: ${this.currentGestureId.slice(0, 12)} (was ${oldGestureId.slice(0, 12)})`);

      getTelemetry().trackGestureStart(this.camera);
    };

    this.zoomScaleService.onGestureEnd = () => {
      const cameraBefore = { ...this.camera };

      // amnesia-aqv: Log gesture end (gestureId stays the same until next gesture starts)
      getTileLifecycleTracer().emit({
        type: 'gesture.ended',
        gestureId: this.currentGestureId,
        metadata: { trigger: 'zoom', zoom: this.camera.z },
      });

      // Clear focal point after gesture ends
      this.zoomScaleService.setFocalPoint(null, 'idle');

      // Telemetry: Track gesture end
      getTelemetry().trackGestureEnd(
        this.camera,
        this.zoomScaleService.isAtMaxZoom(),
        this.zoomScaleService.isAtMinZoom()
      );

      // MODE TRANSITION: Check and execute mode transition based on current zoom
      this.checkAndExecuteModeTransition();

      // Apply HARD constraints now that gesture has ended (amnesia-u9l)
      // This snaps the camera back to valid bounds if soft constraints allowed overscroll
      this.constrainCameraPositionPreservingFocalPoint(/* soft */ false);

      // Sync position change with ZoomScaleService
      this.zoomScaleService.syncFromCamera(this.camera);

      // Propagate constrained position to CSS transform
      this.applyTransform();

      // Telemetry: Track the transform event
      getTelemetry().trackTransformEvent('gesture-end', cameraBefore, this.camera, true);
    };

    this.zoomScaleService.onSettlingComplete = (scale, zoom) => {
      // Calculate the ACTUAL max achievable scale (capped by tile pixel limits)
      // This is the scale tiles will actually be rendered at, not the ideal scale
      // MEMORY FIX (amnesia-e4i): Reduced from 8192 to 4096 to prevent 256MB tiles
      const MAX_TILE_PIXELS = 8192; // amnesia-aqv: Match progressive-tile-renderer.ts
      const tileSize = getTileSize(zoom);
      const maxAchievableScale = Math.min(scale, Math.floor(MAX_TILE_PIXELS / tileSize));
      
      // Start T2HR measurement for diagnostics
      // targetScale = max achievable, NOT the ideal scale from ZoomScaleService
      const t2hrTracker = getT2HRTracker();
      t2hrTracker.startMeasurement({
        targetZoom: zoom,
        targetScale: maxAchievableScale, // Use capped scale, not ideal
        focalPoint: this.zoomScaleService.getFocalPoint(),
      });
      
      this.handleZoomRenderPhase(scale as ScaleTier, 'final');
    };

    // amnesia-aqv.1: Speculative rendering during settling phase
    // Start intermediate renders early to reduce perceived settling time
    this.zoomScaleService.onSettlingProgress = (_elapsedMs, _isAtBoundary) => {
      // Get current scale for intermediate render
      const { scale } = this.zoomScaleService.getScale();

      // Use intermediate phase - this renders visible tiles at lower priority
      // The final phase will complete these renders or upgrade them
      this.handleZoomRenderPhase(scale as ScaleTier, 'intermediate');
    };

    this.zoomScaleService.onRenderModeChange = (_mode) => {
      // Render mode changed - no action needed, mode transitions handled elsewhere
    };

    // amnesia-x6q: Set up focal-point-aware cache eviction with gesture awareness
    // amnesia-aqv: Updated to use ZoomScaleService
    // amnesia-x6q Phase 3-4: Added gesture type and zoom direction awareness
    const cacheManager = getTileCacheManager();
    cacheManager.setPriorityFunction((page, tileX, tileY) => {
      const focalPoint = this.zoomScaleService.getFocalPoint();
      const gestureType = this.zoomScaleService.getActiveGestureType();
      const zoomDirection = this.zoomScaleService.getZoomDirection();
      const currentPage = Math.min(...this.visiblePages) || 1;
      
      // amnesia-x6q Phase 3: During pan gestures, preserve visible tiles
      // Lower priority value = more important = evicted last
      if (gestureType === 'pan') {
        // During pan: prioritize by page visibility only
        // Visible pages get priority 0-1, buffer pages get 2, distant pages get 3
        if (this.visiblePages.has(page)) {
          return 0; // critical: currently visible
        }
        const pageDistance = Math.abs(page - currentPage);
        if (pageDistance <= 2) {
          return 1; // high: within 2 pages of current
        }
        return 3; // low: distant pages can be evicted
      }
      
      // amnesia-x6q Phase 4: Adjust strategy based on zoom direction
      if (gestureType === 'zoom') {
        if (zoomDirection === 'in') {
          // Zooming in: aggressively protect focal point, evict distant pages
          if (!focalPoint) {
            // No focal point - use page distance with wider eviction
            const pageDistance = Math.abs(page - currentPage);
            if (pageDistance === 0) return 0;
            if (pageDistance <= 1) return 1;
            return 3; // More aggressive: distant pages get low priority
          }
        } else if (zoomDirection === 'out') {
          // Zooming out: preserve high-quality cache for current region
          // Don't aggressively evict - user may zoom back in
          if (this.visiblePages.has(page)) {
            return 0; // critical: visible pages
          }
          const pageDistance = Math.abs(page - currentPage);
          if (pageDistance <= 3) {
            return 1; // high: nearby pages (wider buffer for zoom-out)
          }
          return 2; // medium: allow eviction but not aggressive
        }
      }
      
      // Default: focal-point-based priority
      if (!focalPoint) {
        return Math.abs(page - currentPage);
      }
      
      // Get actual page layout for correct canvas coordinates
      const layout = this.pageLayouts.get(page);
      if (!layout) {
        return Math.abs(page - currentPage);
      }
      
      // Calculate distance from focal point to tile center
      const { scale } = this.zoomScaleService.getScale();
      const tileSize = 256; // CSS pixels
      const tileX_canvas = layout.x + (tileX + 0.5) * (tileSize / scale);
      const tileY_canvas = layout.y + (tileY + 0.5) * (tileSize / scale);
      const distance = Math.sqrt(
        (tileX_canvas - focalPoint.x) ** 2 + (tileY_canvas - focalPoint.y) ** 2
      );
      // Radial priority zones (in CSS pixels)
      if (distance < tileSize) return 0;      // critical: 1 tile radius
      if (distance < tileSize * 2) return 1;  // high: 2 tile radius
      if (distance < tileSize * 4) return 2;  // medium: 4 tile radius
      return 3;                               // low: beyond 4 tiles
    });

    // Setup ResizeObserver to handle deferred initial view setup
    // This catches the case where viewport dimensions aren't ready during initialize()
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const { width, height } = entry.contentRect;

      // If initial view setup is pending and viewport now has valid dimensions
      if (this.initialViewSetupPending && width > 0 && height > 0) {
        this.initialViewSetupPending = false;
        this.completeInitialViewSetup();
      }

      // ZERO-VIEWPORT-FIX (2026-01-22): Only update cache with valid dimensions.
      // During layout transitions or rapid zoom gestures, getBoundingClientRect()
      // can temporarily return 0x0 dimensions. If we cache these, all tile
      // generation fails until the next valid resize event.
      const newRect = this.viewport.getBoundingClientRect();
      if (newRect.width > 0 && newRect.height > 0) {
        this.cachedViewportRect = newRect;
        this.cameraConstraints.viewport = { width: newRect.width, height: newRect.height };
      } else {
        console.warn(`[PdfInfiniteCanvas] ResizeObserver: Ignoring 0x0 viewport rect`);
      }
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

  }

  /**
   * Initialize with page count
   */
  initialize(pageCount: number): void {
    this.pageCount = pageCount;

    // Late initialization of tile rendering - check again now that document is loaded.
    // The constructor check happens before document load when wasmDocumentId is null.
    // By the time initialize() is called, the document is loaded and WASM is ready.
    const tileAvailable = this.provider.isTileRenderingAvailable?.() ?? false;

    if (!this.useTiledRendering && tileAvailable) {
      this.useTiledRendering = true;
      this.renderCoordinator = this.provider.getRenderCoordinator?.() ?? null;
      this.tileEngine = getTileEngine();
      // Cache documentId for cross-document isolation in render requests
      this.documentId = this.provider.getDocumentId?.() ?? null;
    }

    // Ensure documentId is up-to-date (may have changed since constructor)
    if (!this.documentId && this.provider.getDocumentId) {
      this.documentId = this.provider.getDocumentId();
    }

    // amnesia-aqv FIX: Copy page dimensions from TileEngine to local map.
    // The TileEngine is a singleton shared across all documents. When multiple PDFs
    // are open, dimensions get overwritten. By copying NOW (at initialization time),
    // we capture the correct dimensions for THIS document before another document
    // overwrites the shared TileEngine.
    if (this.tileEngine && this.tileEngine.pageDimensions.size > 0) {
      for (const [page, dims] of this.tileEngine.pageDimensions.entries()) {
        this.localPageDimensions.set(page, { ...dims });
      }
      console.log(`[PdfInfiniteCanvas] Copied ${this.localPageDimensions.size} page dimensions to local map for doc ${this.documentId?.slice(0, 15)}`);
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

    // CRITICAL: Cache viewport rect for visibility calculations
    // Without this, getViewportRect() returns null on first render, causing blank pages
    this.cachedViewportRect = viewportRect;

    // Initial view setup based on mode
    // ASPECT RATIO FIX: Check if viewport has valid dimensions before setting up initial view.
    // During Obsidian startup, the flex layout may not be computed yet, causing viewportRect
    // to have 0 height. This leads to incorrect zoom calculations that cut off page bottoms.
    if (viewportRect.width > 0 && viewportRect.height > 0) {
      this.setupInitialView();
      this.updateVisiblePages(); // CRITICAL: Create page elements for initial view
    } else {
      this.initialViewSetupPending = true;
    }
  }

  /**
   * Update page dimensions after document load.
   * Should be called when tile engine has actual PDF dimensions available.
   * This recalculates layouts to match the actual PDF aspect ratio.
   */
  updatePageDimensions(): void {
    // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
    const dims = this.localPageDimensions.get(1) ?? this.tileEngine?.pageDimensions.get(1);
    if (!dims) return;

    // Skip if dimensions already match
    if (this.config.pageWidth === dims.width && this.config.pageHeight === dims.height) {
      return;
    }

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
    // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
    let { pageWidth, pageHeight } = this.config;
    const dims = this.localPageDimensions.get(1) ?? this.tileEngine?.pageDimensions.get(1);
    if (dims) {
      pageWidth = dims.width;
      pageHeight = dims.height;
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
    // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
    let { pageWidth: defaultWidth, pageHeight: defaultHeight } = this.config;
    const dims = this.localPageDimensions.get(1) ?? this.tileEngine?.pageDimensions.get(1);
    if (dims) {
      defaultWidth = dims.width;
      defaultHeight = dims.height;
      // Update config to keep everything consistent
      this.config.pageWidth = defaultWidth;
      this.config.pageHeight = defaultHeight;
    }

    // PDF DIMENSION UNIFICATION (2026-01-23):
    // Use PDF native dimensions directly instead of normalizing to baseWidth=400.
    // This eliminates the coordinate mismatch that caused:
    // - Buffer/CSS ratio of 17.64 instead of 16
    // - Right-side clipping
    // - Visual zoom of 29× instead of 32× at zoom=32
    //
    // Now: Layout dimensions = PDF dimensions. No normalization.
    // Canvas buffer = PDF × renderScale, CSS = PDF × zoom.

    // Store layout constants for O(1) visible page calculation
    // Using page 1's dimensions as reference for fast estimates
    this.layoutBaseWidth = defaultWidth; // PDF native width (e.g., 441)
    this.layoutBaseHeight = defaultHeight; // PDF native height (e.g., 666)
    this.layoutPadding = padding;
    this.layoutGap = gap;

    let x = padding;
    let y = padding;
    let row = 0;
    let col = 0;
    let maxRowHeight = 0;

    for (let page = 1; page <= this.pageCount; page++) {
      // Get PDF native dimensions for this page
      // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
      let pageW = defaultWidth;
      let pageH = defaultHeight;
      const pageDims = this.localPageDimensions.get(page) ?? this.tileEngine?.pageDimensions.get(page);
      if (pageDims) {
        pageW = pageDims.width;
        pageH = pageDims.height;
      }

      // PDF DIMENSION UNIFICATION: Use PDF native dimensions directly
      // No normalization - layout width/height = PDF width/height
      this.pageLayouts.set(page, {
        page,
        x,
        y,
        width: pageW,   // PDF native width (e.g., 441)
        height: pageH,  // PDF native height (e.g., 666)
      });

      maxRowHeight = Math.max(maxRowHeight, pageH);

      if (layoutMode === 'vertical') {
        // Vertical: stack pages vertically, using THIS page's height
        y += pageH + gap;
      } else if (layoutMode === 'horizontal') {
        // Horizontal: pages in a row
        x += pageW + gap;
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
          x += pageW + gap;
        }
      }
    }

    // Calculate canvas bounds
    // For horizontal/grid modes, find max page width and height for bounds calculation
    let maxPageWidth = defaultWidth;
    let maxPageHeight = defaultHeight;
    for (const layout of this.pageLayouts.values()) {
      maxPageWidth = Math.max(maxPageWidth, layout.width);
      maxPageHeight = Math.max(maxPageHeight, layout.height);
    }

    const lastLayout = this.pageLayouts.get(this.pageCount);
    if (lastLayout) {
      if (layoutMode === 'vertical') {
        this.canvasBounds = {
          width: maxPageWidth + padding * 2, // Use widest page for vertical scroll
          height: lastLayout.y + lastLayout.height + padding,
        };
      } else if (layoutMode === 'horizontal') {
        this.canvasBounds = {
          width: lastLayout.x + lastLayout.width + padding,
          height: maxPageHeight + padding * 2, // Use tallest page for horizontal scroll
        };
      } else {
        // Grid - calculate actual width and height
        this.canvasBounds = {
          width: pagesPerRow * maxPageWidth + (pagesPerRow - 1) * gap + padding * 2,
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
   * Constrain camera position based on display mode.
   *
   * USAGE GUIDANCE (amnesia-ao7):
   * - Use this for general positioning (initial load, resize, display mode changes)
   * - For zoom gestures, use constrainCameraPositionPreservingFocalPoint() instead
   *
   * This function applies display-mode-specific centering logic which can override
   * focal point calculations. During zoom gestures, the focal point must be preserved.
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
      // FOCAL POINT FIX: When content fits in viewport, don't snap to center!
      // Instead, allow the camera to stay at its current position as long as
      // content remains fully visible. This preserves the focal point during zoom.
      const xBefore = x;
      if (contentScreenWidth <= vpWidth) {
        // Content fits - calculate the range where content stays fully visible
        // At center: x = vpWidth / (2 * z) - contentWidth / 2
        // The "slack" is how much extra space we have on each side
        const centerX = vpWidth / (2 * z) - contentWidth / 2;
        const slackX = (vpWidth - contentScreenWidth) / (2 * z);
        // Allow camera anywhere within [centerX - slackX, centerX + slackX]
        // This preserves focal point while keeping content fully visible
        const minX = centerX - slackX;
        const maxX = centerX + slackX;
        x = Math.max(minX, Math.min(maxX, x));
      } else {
        const minX = vpWidth / z - contentWidth;
        const maxX = 0;
        x = Math.max(minX, Math.min(maxX, x));
      }

      if (contentScreenHeight <= vpHeight) {
        // Content fits - calculate the range where content stays fully visible
        const centerY = vpHeight / (2 * z) - contentHeight / 2;
        const slackY = (vpHeight - contentScreenHeight) / (2 * z);
        const minY = centerY - slackY;
        const maxY = centerY + slackY;
        y = Math.max(minY, Math.min(maxY, y));
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
          // FOCAL POINT FIX: When content fits, use clamp instead of snap-to-center
          if (contentScreenWidth <= vpWidth) {
            const centerX = vpWidth / (2 * z) - contentWidth / 2;
            const slackX = (vpWidth - contentScreenWidth) / (2 * z);
            const minXCanvas = centerX - slackX;
            const maxXCanvas = centerX + slackX;
            x = Math.max(minXCanvas, Math.min(maxXCanvas, x));
          } else {
            const minX = vpWidth / z - contentWidth;
            const maxX = 0;
            x = Math.max(minX, Math.min(maxX, x));
          }

          if (contentScreenHeight <= vpHeight) {
            const centerY = vpHeight / (2 * z) - contentHeight / 2;
            const slackY = (vpHeight - contentScreenHeight) / (2 * z);
            const minYCanvas = centerY - slackY;
            const maxYCanvas = centerY + slackY;
            y = Math.max(minYCanvas, Math.min(maxYCanvas, y));
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
   * Constrain camera position while preserving focal point during zoom gestures.
   *
   * UNIFIED CONSTRAINT LOGIC (amnesia-u9l):
   * - Soft mode (during gesture): Allow 30% overscroll with rubber-band resistance
   * - Hard mode (gesture ended): Snap to valid bounds immediately
   *
   * This constraint NEVER applies centering logic that could override the
   * focal-point-preserving position calculated by zoomCameraToPoint().
   *
   * @param soft If true, allow rubber-band overscroll (30% resistance)
   */
  private constrainCameraPositionPreservingFocalPoint(soft: boolean = false): void {
    const viewportRect = this.viewport.getBoundingClientRect();
    if (viewportRect.width === 0 || viewportRect.height === 0) return;

    const { z } = this.camera;
    let { x, y } = this.camera;

    const vpWidth = viewportRect.width;
    const vpHeight = viewportRect.height;

    // UNIFIED CONSTRAINT (amnesia-u9l): Single formula regardless of fits/exceeds state
    // Soft mode: rubber-band with 30% resistance
    // Hard mode: strict clamping
    const resistance = 0.3;
    const softClamp = (value: number, min: number, max: number): number => {
      if (!soft) {
        // Hard constraint
        return Math.max(min, Math.min(max, value));
      }
      // Soft constraint: rubber-band effect
      if (value < min) {
        const undershoot = min - value;
        return min - undershoot * resistance;
      }
      if (value > max) {
        const overshoot = value - max;
        return max + overshoot * resistance;
      }
      return value;
    };

    // UNIFIED MODE: Use unified coordinate bounds
    if (this.useUnifiedCoordinateSpace) {
      const contentWidth = this.canvasBounds.width;
      const contentHeight = this.canvasBounds.height;

      // UNIFIED CONSTRAINT: Single formula for all zoom states (amnesia-u9l)
      // Calculate bounds - same formula whether content fits or exceeds
      const minX = Math.min(0, contentWidth - vpWidth);
      const maxX = Math.max(0, contentWidth - vpWidth);
      x = softClamp(x, minX, maxX);

      const minY = Math.min(0, contentHeight - vpHeight);
      const maxY = Math.max(0, contentHeight - vpHeight);
      y = softClamp(y, minY, maxY);

      this.camera = { x, y, z };
      return;
    }

    // LEGACY MODE: Use content coordinate bounds
    const contentWidth = this.canvasBounds.width;
    const contentHeight = this.canvasBounds.height;
    const contentScreenWidth = contentWidth * z;
    const contentScreenHeight = contentHeight * z;

    // UNIFIED CONSTRAINT: Single formula for all zoom states (amnesia-u9l)
    // Calculate the valid pan range in content coordinates
    // - When content exceeds viewport: can pan from 0 to (vpWidth/z - contentWidth)
    // - When content fits: reverse range, but softClamp handles either direction
    const xEdgeRight = vpWidth / z - contentWidth;
    const minX = Math.min(0, xEdgeRight);
    const maxX = Math.max(0, xEdgeRight);
    x = softClamp(x, minX, maxX);

    const yEdgeBottom = vpHeight / z - contentHeight;
    const minY = Math.min(0, yEdgeBottom);
    const maxY = Math.max(0, yEdgeBottom);
    y = softClamp(y, minY, maxY);

    const cameraBefore = { ...this.camera };
    this.camera = { x, y, z };

    // Telemetry: Track constraint event (amnesia-hem investigation)
    const constrained = cameraBefore.x !== x || cameraBefore.y !== y;
    if (constrained) {
      getTelemetry().trackConstraintEvent(
        soft ? 'soft' : 'hard',
        cameraBefore,
        this.camera,
        'constrainCameraPositionPreservingFocalPoint'
      );
    }
  }


  /**
   * Check if mode transition is needed and execute it (amnesia-wbp).
   * Uses ScaleStateManager's effective mode (gesture-aware) as source of truth.
   * 'adaptive' mode is treated as 'full-page' for rendering purposes.
   */
  private checkAndExecuteModeTransition(): void {
    // MIGRATION (amnesia-d9f): Use ZoomScaleService for mode decisions
    const effectiveMode = this.zoomScaleService.getRenderMode();
    // Map 'adaptive' to 'full-page' for rendering - both use full-page rendering
    const targetMode: 'full-page' | 'tiled' = effectiveMode === 'tiled' ? 'tiled' : 'full-page';

    if (targetMode !== this.lastExecutedRenderMode) {
      this.executeModeTransition(targetMode);
    }
  }

  /**
   * Execute a pending mode transition (full-page ↔ tiled).
   * Called either immediately (if no gesture active) or when gesture ends (amnesia-z8v).
   *
   * @param targetMode The mode to transition to
   */
  private executeModeTransition(targetMode: 'full-page' | 'tiled'): void {
    const oldMode = this.lastExecutedRenderMode;
    if (oldMode === targetMode) {
      return;
    }

    this.lastExecutedRenderMode = targetMode;
    // MIGRATION (amnesia-d9f): Use ZoomScaleService for epoch
    const newEpoch = this.zoomScaleService.incrementEpoch();

    // amnesia-aqv Phase 0: Record mode transition event for diagnostic tracking
    const transitionStartTime = performance.now();
    const modeTransitionEvent: ModeTransitionEvent = {
      timestamp: transitionStartTime,
      fromMode: oldMode,
      toMode: targetMode,
      trigger: oldMode === 'tiled' ? 'zoom-out' : 'zoom-in',
      snapshotCreated: false, // Updated below if using snapshot approach
      snapshotCoverage: 0,
      snapshotRejectionReason: null,
      blankDurationMs: 0, // Will be measured when render completes
      pagesAffected: Array.from(this.visiblePages),
      zoom: this.camera.z,
      epoch: newEpoch,
    };
    
    try {
      getTileDiagnosticOverlay().recordModeTransition(modeTransitionEvent);
    } catch {
      // Overlay may not be initialized
    }

    // IMMEDIATE CSS RESET: When transitioning tiled→full-page, immediately reset
    // canvas CSS for visible pages. This prevents the old viewport-only content
    // (which was positioned/sized for a small region) from being displayed clipped
    // while waiting for the new full-page render to complete.
    if (oldMode === 'tiled' && targetMode === 'full-page') {
      for (const pageNum of this.visiblePages) {
        const element = this.pageElements.get(pageNum);
        if (element) {
          // ═══════════════════════════════════════════════════════════════════════════
          // OVERLAY CANVAS ATOMIC SWAP (amnesia-aqv Phase 1)
          // ═══════════════════════════════════════════════════════════════════════════
          // Use overlay canvas pattern instead of snapshot pattern.
          // This keeps the main canvas visible (with current content) while
          // rendering new full-page content to an overlay canvas. When the overlay
          // render completes, we do an atomic swap - no blank flash.
          //
          // The old prepareForFullPageRender() approach failed because:
          // 1. Snapshot coverage check fails (<95% for viewport-only canvas)
          // 2. Buffer clearing happens due to aspect mismatch (>5%)
          // 3. Result: blank page for 50-200ms
          //
          // The overlay pattern eliminates this by never hiding/clearing the main canvas.
          element.prepareForFullPageRenderWithOverlay(newEpoch);
          
          // Clear the pageWasTiled flag for proper subsequent render flow
          this.pageWasTiled.set(pageNum, false);
        }
      }
      // FIX (2026-01-20): Queue full-page renders after mode transition
      // Without this, pages stay on stretched snapshot because no renders are requested.
      // FIX (2026-01-21): Use force=true to bypass canRender() guard during settling phase.
      this.queueRender([...this.visiblePages], /* force */ true);
    }

    // SYMMETRIC MODE TRANSITION: When transitioning full-page→tiled,
    // prepare pages for viewport-only tile rendering.
    if (oldMode === 'full-page' && targetMode === 'tiled') {
      for (const pageNum of this.visiblePages) {
        const element = this.pageElements.get(pageNum);
        if (element) {
          element.prepareForTiledRender();
        }
      }
      // FIX (2026-01-20): Queue tile renders after mode transition
      // This was MISSING - pages were prepared but tiles were never requested.
      // Result: pages stayed on stretched transition snapshot forever.
      // FIX (2026-01-21): Use force=true to bypass canRender() guard during settling phase.
      this.queueRender([...this.visiblePages], /* force */ true);
    }
    // NOTE: pendingModeTransition removed (amnesia-wbp) - ScaleStateManager tracks this now
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
    const transform = getCameraTransform(this.camera);
    this.canvas.style.transform = transform;

    // INV-3 COHERENCE CHECK: Verify CSS transform matches camera state numerically
    // Browser normalizes CSS values (rounds floats), so we must parse and compare with tolerance
    // This detects async gaps or stale transform values that could cause visual glitches
    const actualCss = this.canvas.style.transform;
    const parsed = this.parseTransform(actualCss);
    if (parsed) {
      // FIX (2026-01-22): Use adaptive tolerance based on coordinate magnitude.
      // Browser floating-point rounding causes ~0.01px error per ~1000px of coordinate value.
      // At y > 13000, this can cause 0.02-0.04px differences, triggering false violations.
      const BASE_TOLERANCE = 0.01; // Base tolerance for small coordinates
      const RELATIVE_TOLERANCE = 0.00001; // 0.001% relative tolerance for large coordinates

      const getAdaptiveTolerance = (expected: number): number => {
        const relativeTol = Math.abs(expected) * RELATIVE_TOLERANCE;
        return Math.max(BASE_TOLERANCE, relativeTol);
      };

      const scaleTolerance = getAdaptiveTolerance(this.camera.z);
      const xTolerance = getAdaptiveTolerance(this.camera.x);
      const yTolerance = getAdaptiveTolerance(this.camera.y);

      const scaleMatch = Math.abs(parsed.scale - this.camera.z) < scaleTolerance;
      const xMatch = Math.abs(parsed.x - this.camera.x) < xTolerance;
      const yMatch = Math.abs(parsed.y - this.camera.y) < yTolerance;
      if (!scaleMatch || !xMatch || !yMatch) {
        // Explicit string format to avoid Object truncation in MCP console capture
        console.error(`[INV-3-VIOLATION] Transform coherence failed: ` +
          `expected=(x=${this.camera.x.toFixed(4)}, y=${this.camera.y.toFixed(4)}, z=${this.camera.z.toFixed(4)}) ` +
          `actual=(x=${parsed.x.toFixed(4)}, y=${parsed.y.toFixed(4)}, z=${parsed.scale.toFixed(4)}) ` +
          `diff=(x=${(parsed.x - this.camera.x).toFixed(4)}, y=${(parsed.y - this.camera.y).toFixed(4)}, z=${(parsed.scale - this.camera.z).toFixed(4)}) ` +
          `tolerance=(x=${xTolerance.toFixed(4)}, y=${yTolerance.toFixed(4)}, z=${scaleTolerance.toFixed(4)})`);
      }
    }

    // DRIFT DIAGNOSTIC removed - too verbose for production use
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

    // amnesia-e4i: Track cumulative pan distance and clear queue when threshold exceeded.
    // At high zoom, the tile queue fills with requests from previous pan positions.
    // These stale tiles block critical tiles for the current viewport.
    // Solution: Clear queue when viewport moves more than viewport-size distance.
    if (this.camera.z > this.tileZoomThreshold && this.renderCoordinator) {
      const panDistanceX = Math.abs(this.camera.x - this.lastQueueClearPosition.x);
      const panDistanceY = Math.abs(this.camera.y - this.lastQueueClearPosition.y);
      this.cumulativePanDistance = Math.sqrt(panDistanceX * panDistanceX + panDistanceY * panDistanceY);
      
      // Threshold: half viewport size (adjusted for zoom)
      // At zoom Z, the viewport covers (screenSize/Z) content units
      // We want to clear when user has panned half a viewport
      const viewportRect = this.getViewportRect();
      const contentViewportSize = Math.min(viewportRect.width, viewportRect.height) / this.camera.z;
      const clearThreshold = contentViewportSize * 0.5;
      
      if (this.cumulativePanDistance > clearThreshold) {
        const queueBefore = this.renderCoordinator.getQueueSize();
        if (queueBefore > 50) { // Only clear if queue is actually backed up
          this.renderCoordinator.abortAllPending();
        }
        // Reset tracking position
        this.lastQueueClearPosition = { x: this.camera.x, y: this.camera.y };
        this.cumulativePanDistance = 0;
      }
    }
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
    //
    // MIGRATION (amnesia-d9f): Using ZoomScaleService as primary, zoomStateMachine as backup.
    // Once migration is complete, zoomStateMachine will be removed.
    if (!this.zoomScaleService.canRender()) {
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

    // UNIT FIX (amnesia-aqv): Convert screen-pixel buffers to canvas units.
    // calculateBufferSizes() returns buffers in SCREEN pixels, but visibleBounds
    // is in CANVAS coordinates. At zoom 32x, using 64px buffer directly creates
    // a 64-unit expansion (should be 2 units = 64/32).
    // This fix aligns with the same conversion in tile-render-engine (line 3540).
    const zoom = this.camera.z;
    const renderBufferCanvas = renderBuffer / zoom;
    const elementBufferCanvas = elementBuffer / zoom;

    // O(1) page range calculation based on layout mode
    const { layoutMode, pagesPerRow } = this.config;
    const cellWidth = this.layoutBaseWidth + this.layoutGap;
    const cellHeight = this.layoutBaseHeight + this.layoutGap;
    const padding = this.layoutPadding;

    // Calculate page ranges for element buffer (largest zone)
    const elementPages = this.calculatePagesInBounds(
      visibleBounds.x - elementBufferCanvas,
      visibleBounds.y - elementBufferCanvas,
      visibleBounds.width + elementBufferCanvas * 2,
      visibleBounds.height + elementBufferCanvas * 2,
      layoutMode,
      pagesPerRow,
      cellWidth,
      cellHeight,
      padding
    );

    // Calculate page ranges for render buffer
    const renderPages = this.calculatePagesInBounds(
      visibleBounds.x - renderBufferCanvas,
      visibleBounds.y - renderBufferCanvas,
      visibleBounds.width + renderBufferCanvas * 2,
      visibleBounds.height + renderBufferCanvas * 2,
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

    // MEMORY PRESSURE FIX: At high zoom, limit total page elements to prevent
    // Chromium tile manager memory exhaustion. Each page element at scale 64
    // creates ~64MB GPU textures. With 6+ elements, we exceed 256MB limit.
    const maxPageElements = this.camera.z > 16 ? 3 : this.camera.z > 8 ? 6 : 12;
    
    // Create elements for pages in element zone, respecting limit
    // Prioritize visible pages over buffer pages
    const sortedPages = [...newRenderPages].sort((a, b) => {
      const aVisible = newVisiblePages.has(a) ? 0 : 1;
      const bVisible = newVisiblePages.has(b) ? 0 : 1;
      return aVisible - bVisible;
    });
    
    for (const page of sortedPages) {
      if (this.pageElements.size >= maxPageElements) break;
      if (!this.pageElements.has(page)) {
        this.createPageElement(page);
      }
    }

    // Remove elements for pages outside keep buffer - only iterate existing elements (small set)
    // UNIT FIX (amnesia-aqv): Convert keepBuffer to canvas units (same as renderBuffer/elementBuffer)
    const keepBufferCanvas = keepBuffer / zoom;
    const keepPages = this.calculatePagesInBounds(
      visibleBounds.x - keepBufferCanvas,
      visibleBounds.y - keepBufferCanvas,
      visibleBounds.width + keepBufferCanvas * 2,
      visibleBounds.height + keepBufferCanvas * 2,
      layoutMode,
      pagesPerRow,
      cellWidth,
      cellHeight,
      padding
    );
    const keepSet = new Set(keepPages);

    // NAVIGATION RECOVERY FIX: Track cold pages (pages that left the keep buffer).
    // When pages return to visibility after being cold, force re-render to recover
    // from Chromium tile manager memory eviction.
    for (const page of this.lastKeepBufferPages) {
      if (!keepSet.has(page)) {
        this.coldPages.add(page);
      }
    }
    this.lastKeepBufferPages = keepSet;

    // Identify pages that were cold and are now visible - force their re-render
    const rewarmedPages: number[] = [];
    for (const page of newVisiblePages) {
      if (this.coldPages.has(page)) {
        rewarmedPages.push(page);
        this.coldPages.delete(page);
        // Clear isRendered flag to force re-render
        const element = this.pageElements.get(page);
        if (element) {
          element.clearRendered();
        }
      }
    }

    for (const [page, element] of this.pageElements) {
      if (!keepSet.has(page)) {
        element.destroy();
        this.pageElements.delete(page);
      }
    }

    // MEMORY PRESSURE FIX: If we still have too many elements, evict furthest from center
    if (this.pageElements.size > maxPageElements) {
      const centerPage = this.getCurrentPage();
      const sortedByDistance = [...this.pageElements.entries()]
        .filter(([p]) => !newVisiblePages.has(p)) // Don't evict visible pages
        .sort((a, b) => Math.abs(b[0] - centerPage) - Math.abs(a[0] - centerPage));
      
      while (this.pageElements.size > maxPageElements && sortedByDistance.length > 0) {
        const [page, element] = sortedByDistance.shift()!;
        element.destroy();
        this.pageElements.delete(page);
        this.coldPages.add(page); // Mark as cold for recovery when visible again
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
    // Add rewarmed pages to priority queue for immediate re-render
    for (const page of rewarmedPages) {
      if (!immediateNeighbors.includes(page)) {
        immediateNeighbors.push(page);
      }
    }

    this.visiblePages = newVisiblePages;

    // Queue rendering with priority for immediate neighbors (includes rewarmed pages)
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

    // amnesia-e4i FIX: Skip prefetch when processRenderQueue is actively rendering pages.
    // renderPageTiled already handles visible tiles for each page. If we also prefetch
    // here, we queue the SAME tiles twice, causing 2x the queue usage.
    // 
    // With 2 pages × 50 tiles × 2 paths = 200 tiles → 400 with intermediate+final render.
    // This overwhelms the 400-tile queue limit.
    //
    // Solution: Only prefetch when NOT actively rendering. The render cycle will handle
    // visible tiles, and prefetch can add lookahead tiles AFTER the render settles.
    if (this.isRendering) {
      return;
    }

    // amnesia-rwe: REVISED ZOOM STATE GUARD
    // Per requirements: "Maximum high res tiles should be prefetched when the gesture starts"
    // 
    // Previous behavior: Block ALL prefetch during 'active' and 'settling'
    // Problem: Tiles only requested ~500ms AFTER gesture ends
    // 
    // New behavior:
    // - 'settling': Allow full prefetch (zoom is stable, user stopped)
    // - 'active': Allow limited prefetch (focal-priority tiles only)
    // - 'idle'/'rendering': Allow full prefetch (unchanged)
    //
    // The semaphore policy already has safeguards for 'active' phase:
    // - maxQueueSize: 50, maxTilesPerPage: 30, dropBehavior: 'aggressive'
    const currentGesturePhase = this.zoomScaleService.getGesturePhase();
    const isActiveZoom = currentGesturePhase === 'active';
    
    // Note: 'settling' now allows prefetch (zoom stable, just waiting for timer)

    // Use canvas coordinates for prefetch calculation
    const screenRect = this.getViewportRect();

    // ZERO-VIEWPORT-GUARD (2026-01-22): Skip prefetch if viewport has invalid dimensions.
    // This can happen during layout transitions or before initial DOM layout completes.
    if (!screenRect || screenRect.width <= 0 || screenRect.height <= 0) {
      console.warn(`[PdfInfiniteCanvas] triggerTilePrefetch: Skipping - invalid viewport ${screenRect?.width}x${screenRect?.height}`);
      return;
    }

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
    // ADAPTIVE TILE SIZE: With useAdaptiveTileSize feature flag:
    // - zoom <= 16: 512px tiles → max scale 16 (8192/512)
    // amnesia-aqv FIX: With MAX_TILE_PIXELS=8192 and 128px tiles, max scale is 64.
    // - zoom <= 4:  512px tiles → max scale 16 (8192/512)
    // - zoom <= 16: 256px tiles → max scale 32 (8192/256)
    // - zoom > 16:  128px tiles → max scale 64 (8192/128)
    const MAX_TILE_SCALE = 64; // amnesia-aqv: Increased to support Retina at max zoom
    const MAX_TILE_PIXELS = 8192; // amnesia-aqv: Match progressive-tile-renderer.ts
    const tileSize = getTileSize(zoom); // Returns 512, 256, or 128 based on zoom
    const maxScaleForTileSize = Math.floor(MAX_TILE_PIXELS / tileSize);
    const rawScale = this.renderCoordinator.getTileScale(zoom, this.config.pixelRatio, this.velocity);
    const tileScale = Math.min(MAX_TILE_SCALE, maxScaleForTileSize, rawScale);

    if (rawScale > tileScale) {
      console.warn(`[PdfInfiniteCanvas] Capping tile scale from ${rawScale} to ${tileScale} (tileSize=${tileSize}px, max pixels=${MAX_TILE_PIXELS})`);
    }

    // Get visible tiles for current viewport with proper scale
    // NOTE: Bleed buffer removed (amnesia-aqv) - it was causing excessive tile requests
    // that overwhelmed the render queue. The fallback tile system provides adequate
    // coverage during pan by showing lower-resolution cached tiles.
    let visibleTiles = this.tileEngine.getVisibleTiles(canvasViewport, layouts, zoom, tileScale);

    // amnesia-e4i FIX: Apply maxTilesPerPage limit to prevent queue saturation.
    // This was MISSING - triggerTilePrefetch was bypassing the limit that renderPageTiled enforces.
    // At 32x zoom, getVisibleTiles can return 400+ tiles per page, flooding the queue with 8000+ tiles.
    // Group tiles by page and limit each page's contribution.
    const maxTilesPerPage = this.renderCoordinator?.getMaxTilesPerPage() ?? 0;
    if (maxTilesPerPage > 0 && visibleTiles.length > maxTilesPerPage) {
      // Group tiles by page
      const tilesByPage = new Map<number, typeof visibleTiles>();
      for (const tile of visibleTiles) {
        const pageTiles = tilesByPage.get(tile.page) || [];
        pageTiles.push(tile);
        tilesByPage.set(tile.page, pageTiles);
      }
      
      // For each page, keep only the closest tiles to viewport center
      const viewportCenterX = canvasViewport.x + canvasViewport.width / 2;
      const viewportCenterY = canvasViewport.y + canvasViewport.height / 2;
      const pdfTileSize = getTileSize(zoom) / tileScale;
      
      const limitedTiles: typeof visibleTiles = [];
      for (const [page, pageTiles] of tilesByPage) {
        if (pageTiles.length <= maxTilesPerPage) {
          limitedTiles.push(...pageTiles);
        } else {
          // Sort by distance from viewport center, keep closest
          const layout = this.pageLayouts.get(page);
          if (layout) {
            pageTiles.sort((a, b) => {
              const aCenterX = layout.x + (a.tileX + 0.5) * pdfTileSize;
              const aCenterY = layout.y + (a.tileY + 0.5) * pdfTileSize;
              const bCenterX = layout.x + (b.tileX + 0.5) * pdfTileSize;
              const bCenterY = layout.y + (b.tileY + 0.5) * pdfTileSize;
              const aDist = Math.hypot(aCenterX - viewportCenterX, aCenterY - viewportCenterY);
              const bDist = Math.hypot(bCenterX - viewportCenterX, bCenterY - viewportCenterY);
              return aDist - bDist;
            });
          }
          limitedTiles.push(...pageTiles.slice(0, maxTilesPerPage));
          console.warn(`[PREFETCH-LIMIT] page=${page} zoom=${zoom.toFixed(2)}: Limiting from ${pageTiles.length} to ${maxTilesPerPage} tiles`);
        }
      }
      visibleTiles = limitedTiles;
    }

    // INV-6 FIX (2026-01-23): Capture scale snapshot BEFORE tile batch.
    // All tiles in this batch MUST use the same epoch to prevent mixed-scale corruption.
    // amnesia-aqv: Use ZoomScaleService snapshot
    const scaleSnapshot = this.zoomScaleService.captureSnapshot();

    // Queue tile requests with FOCAL-POINT PRIORITY (amnesia-aqv fix)
    // Previously all tiles were hardcoded to 'critical', bypassing the focal center
    // prioritization. Now tiles near the focal point (during zoom) or viewport center
    // (during scroll) get higher priority, ensuring users see sharp content where
    // they're looking first.
    
    // Calculate priority distribution for focal-point tracking
    const priorityDistribution = { critical: 0, high: 0, medium: 0, low: 0 };
    const tilePriorities: Map<string, RenderPriority> = new Map();
    
    for (const tile of visibleTiles) {
      const layout = this.pageLayouts.get(tile.page);
      const priority = layout ? this.getTilePriority(tile, layout) : 'critical';
      priorityDistribution[priority]++;
      tilePriorities.set(`${tile.page}-${tile.tileX}-${tile.tileY}`, priority);
    }
    
    // Record priority distribution for focal-point analysis
    const focalTracker = getFocalPointTracker();
    focalTracker.startGesture(priorityDistribution);
    
    // amnesia-rwe: During active zoom, only queue focal-priority tiles (critical/high)
    // This fulfills the requirement: "Maximum high res tiles should be prefetched when gesture starts"
    // without overwhelming the queue. The semaphore policy limits active-phase queue to 50.
    let tilesToQueue = visibleTiles;
    if (isActiveZoom) {
      tilesToQueue = visibleTiles.filter(tile => {
        const key = `${tile.page}-${tile.tileX}-${tile.tileY}`;
        const priority = tilePriorities.get(key);
        return priority === 'critical' || priority === 'high';
      });
    }
    
    // T2HR v2: Track tile requests by source
    // Determine source based on gesture phase:
    // - 'active' or 'settling' → zoom-initiated (tiles should be ready by zoom end)
    // - 'idle' or 'rendering' → pan/scroll-initiated
    const t2hrTracker = getT2HRTracker();
    const gesturePhase = this.zoomScaleService.getGesturePhase();
    const t2hrSource: TileRequestSource = (gesturePhase === 'active' || gesturePhase === 'settling')
      ? 'zoom'
      : (Math.abs(this.velocity.y) > 0.1 ? 'scroll' : 'pan');
    
    // amnesia-aqv Phase 1C: Immediately composite fallback tiles BEFORE queueing high-res renders.
    // This provides instant visual feedback (blurry but visible) while high-res tiles load.
    // Fire-and-forget - don't wait for completion to avoid blocking the render queue.
    this.compositeFallbackTilesImmediately(
      tilesToQueue.map(t => ({ ...t, scale: tileScale })),
      tileScale,
      scaleSnapshot.epoch
    ).catch(err => {
      console.warn('[FALLBACK-COMPOSITE] Error compositing fallback tiles:', err);
    });
    
    for (const tile of tilesToQueue) {
      // Use consistent scale for all tiles in this batch
      const actualScale = tileScale;
      
      // Calculate actual cssStretch: how much tile will be stretched on screen
      // For crisp display at zoom Z with DPR D, we need scale Z*D
      // If we render at tileScale S, cssStretch = (Z*D) / S
      // cssStretch=1.0 means perfectly sharp, >1 means blurry (stretched)
      const neededScaleForCrispness = zoom * this.config.pixelRatio;
      const tileCssStretch = neededScaleForCrispness / actualScale;

      // Get pre-calculated priority
      const priority = tilePriorities.get(`${tile.page}-${tile.tileX}-${tile.tileY}`) ?? 'critical';
      
      // T2HR v2: Track tile request at REQUEST time (before render)
      const tileKey = `${tile.page}-${tile.tileX}-${tile.tileY}-s${actualScale}`;
      t2hrTracker.onTileRequested({
        tileKey,
        page: tile.page,
        tileX: tile.tileX,
        tileY: tile.tileY,
        source: t2hrSource,
        targetScale: actualScale,
        priority,
      });

      const adjustedTile = { ...tile, scale: actualScale };
      this.renderCoordinator.requestRender({
        type: 'tile' as const,
        tile: adjustedTile,
        priority,
        documentId: this.documentId ?? undefined,
        sessionId: this.pendingSessionId,
        // Pass cssStretch for display compensation
        cssStretch: tileCssStretch,
        // INV-6: Attach epoch for display-time validation
        scaleEpoch: scaleSnapshot.epoch,
        renderParamsId: scaleSnapshot.snapshotId,
        // Debug info
        zoom: zoom,
        requestedScale: tileScale,
        // amnesia-aqv: Gesture correlation for hybrid guard
        gestureId: this.currentGestureId,
      }).catch(() => {
        // Ignore render failures
      });
    }

    // amnesia-rwe: Skip prefetch during active zoom (low priority tiles compete with critical)
    // Prefetch is velocity-based prediction which doesn't apply during zoom gestures
    if (!isActiveZoom) {
      // Get prefetch tiles from strategy (velocity-based prediction)
      let prefetchTiles = this.renderCoordinator.getPrefetchTiles(
        canvasViewport,
        layouts,
        this.velocity,
        zoom
      );

      // amnesia-e4i FIX: Limit prefetch tiles to prevent queue saturation
      // At high zoom, prefetch can request hundreds of tiles that overflow the queue
      const maxPrefetchTiles = Math.max(50, maxTilesPerPage);
      if (prefetchTiles.length > maxPrefetchTiles) {
        console.warn(`[PREFETCH-LIMIT] Limiting prefetch from ${prefetchTiles.length} to ${maxPrefetchTiles} tiles`);
        prefetchTiles = prefetchTiles.slice(0, maxPrefetchTiles);
      }

      // Queue prefetch requests at lower priority
      for (const tile of prefetchTiles) {
        this.renderCoordinator.requestRender({
          type: 'tile' as const,
          tile,
          priority: 'low',
          documentId: this.documentId ?? undefined,
          sessionId: this.pendingSessionId,
          // INV-6: Attach epoch for display-time validation (same batch)
          scaleEpoch: scaleSnapshot.epoch,
          renderParamsId: scaleSnapshot.snapshotId,
          // Debug info
          zoom: zoom,
          requestedScale: tileScale,
          // amnesia-aqv: Gesture correlation for hybrid guard
          gestureId: this.currentGestureId,
        }).catch(() => {
          // Ignore prefetch failures
        });
      }
    }
  }

  // ============================================================================
  // FOCAL-POINT PREDICTIVE PREFETCH (amnesia-aqv Phase 3+)
  // ============================================================================
  // When a zoom gesture starts, predict the target zoom level and prefetch
  // high-resolution tiles around the focal point BEFORE we reach that zoom.
  // This ensures tiles are already cached when the user reaches high zoom.
  // ============================================================================

  /**
   * Prefetch high-resolution tiles around a focal point for predicted zoom level.
   * Called at zoom gesture start to preemptively render tiles we'll need.
   * 
   * @param focalPoint Focal point in screen coordinates
   * @param currentZoom Current zoom level
   * @param isZoomingIn Whether the gesture is zooming in (true) or out (false)
   */
  private prefetchFocalPointTiles(
    focalPoint: Point,
    currentZoom: number,
    isZoomingIn: boolean
  ): void {
    // Only prefetch when zooming in and already at moderate zoom
    if (!isZoomingIn || currentZoom < 4) return;
    if (!this.renderCoordinator || !this.tileEngine) return;

    // Predict target zoom levels to prefetch
    // If at 8x, prefetch for 16x and 32x
    // If at 16x, prefetch for 32x
    const targetZooms: number[] = [];
    if (currentZoom >= 4 && currentZoom < 16) targetZooms.push(16);
    if (currentZoom >= 8) targetZooms.push(32);
    
    if (targetZooms.length === 0) return;

    // Convert focal point to canvas coordinates
    const focalCanvas = screenToCanvas(focalPoint, this.camera);
    
    // Find which page the focal point is on
    let focalPage: number | null = null;
    let focalLayout: PageLayout | null = null;
    
    for (const [page, layout] of this.pageLayouts) {
      if (focalCanvas.x >= layout.x && focalCanvas.x <= layout.x + layout.width &&
          focalCanvas.y >= layout.y && focalCanvas.y <= layout.y + layout.height) {
        focalPage = page;
        focalLayout = layout;
        break;
      }
    }
    
    if (!focalPage || !focalLayout) return;

    // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
    const pdfDims = this.localPageDimensions.get(focalPage) ?? this.tileEngine?.pageDimensions.get(focalPage);
    if (!pdfDims) return;

    // Get epoch for tile requests
    const epoch = this.zoomScaleService.getEpoch();

    // For each target zoom, generate tiles around the focal point
    for (const targetZoom of targetZooms) {
      const pixelRatio = this.config.pixelRatio;
      const targetScale = Math.min(32, Math.ceil(targetZoom * pixelRatio));
      const tileSize = getTileSize(targetZoom);
      const pdfTileSize = tileSize / targetScale;

      // Convert focal point to PDF coordinates relative to page
      const focalPdfX = (focalCanvas.x - focalLayout.x) * (pdfDims.width / focalLayout.width);
      const focalPdfY = (focalCanvas.y - focalLayout.y) * (pdfDims.height / focalLayout.height);

      // Calculate tile indices at focal point
      const focalTileX = Math.floor(focalPdfX / pdfTileSize);
      const focalTileY = Math.floor(focalPdfY / pdfTileSize);

      // Calculate tile grid bounds
      const maxTileX = Math.ceil(pdfDims.width / pdfTileSize) - 1;
      const maxTileY = Math.ceil(pdfDims.height / pdfTileSize) - 1;

      // Generate tiles in a 5x5 grid around focal point (25 tiles)
      // This covers approximately the visible viewport at high zoom
      const radius = 2;
      const tiles: TileCoordinate[] = [];

      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const tileX = focalTileX + dx;
          const tileY = focalTileY + dy;

          // Skip out-of-bounds tiles
          if (tileX < 0 || tileX > maxTileX || tileY < 0 || tileY > maxTileY) continue;

          tiles.push({
            page: focalPage,
            tileX,
            tileY,
            scale: targetScale,
            tileSize,
          });
        }
      }

      // Sort by distance from focal tile (center first)
      tiles.sort((a, b) => {
        const aDist = Math.abs(a.tileX - focalTileX) + Math.abs(a.tileY - focalTileY);
        const bDist = Math.abs(b.tileX - focalTileX) + Math.abs(b.tileY - focalTileY);
        return aDist - bDist;
      });

      // Queue tiles at high priority (but not critical, to not block current render)
      for (const tile of tiles) {
        this.renderCoordinator.requestRender({
          type: 'tile' as const,
          tile,
          priority: 'high', // High priority but not critical
          documentId: this.documentId ?? undefined,
          sessionId: this.pendingSessionId,
          scaleEpoch: epoch,
          zoom: targetZoom,
          requestedScale: targetScale,
          // amnesia-aqv: Gesture correlation for hybrid guard
          gestureId: this.currentGestureId,
        }).catch(() => {
          // Ignore prefetch failures
        });
      }
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
      // OVERLAP FIX (amnesia-aqv): For a page at row R to overlap with bounds:
      // - Page starts at: padding + R * cellHeight
      // - Page ends at: padding + R * cellHeight + pageHeight (= padding + (R+1) * cellHeight - gap)
      // 
      // firstRow: floor((boundsY - padding) / cellHeight) - includes pages whose bottom > boundsY
      // lastRow: floor((boundsY + boundsHeight - padding) / cellHeight) - only pages whose top < boundsBottom
      //
      // Previous bug: Using ceil() for lastRow included pages whose top was ABOVE boundsBottom,
      // causing pages to be queued but fail the tile overlap check in TileRenderEngine.
      const firstRow = Math.max(0, Math.floor((boundsY - padding) / cellHeight));
      const lastRow = Math.min(
        this.pageCount - 1,
        Math.floor((boundsY + boundsHeight - padding) / cellHeight)
      );

      for (let row = firstRow; row <= lastRow; row++) {
        const page = row + 1;
        if (page >= 1 && page <= this.pageCount) {
          pages.push(page);
        }
      }
    } else if (layoutMode === 'horizontal') {
      // Single row layout - only need to calculate column range
      // OVERLAP FIX (amnesia-aqv): Same fix for horizontal mode
      const firstCol = Math.max(0, Math.floor((boundsX - padding) / cellWidth));
      const lastCol = Math.min(
        this.pageCount - 1,
        Math.floor((boundsX + boundsWidth - padding) / cellWidth)
      );

      for (let col = firstCol; col <= lastCol; col++) {
        const page = col + 1;
        if (page >= 1 && page <= this.pageCount) {
          pages.push(page);
        }
      }
    } else {
      // Grid layout - calculate both row and column ranges
      // OVERLAP FIX (amnesia-aqv): Same fix for grid mode
      const firstRow = Math.max(0, Math.floor((boundsY - padding) / cellHeight));
      const lastRow = Math.floor((boundsY + boundsHeight - padding) / cellHeight);
      const firstCol = Math.max(0, Math.floor((boundsX - padding) / cellWidth));
      const lastCol = Math.min(pagesPerRow - 1, Math.floor((boundsX + boundsWidth - padding) / cellWidth));

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
        scale: getDevicePixelRatio(),
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

    // Get native PDF dimensions for this page (used as fallback in renderTiles)
    // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
    // This prevents cross-document dimension contamination when multiple PDFs are open.
    const pdfDimensions = this.localPageDimensions.get(page) ?? this.tileEngine?.pageDimensions.get(page);

    const element = new PdfPageElement({
      pageNumber: page,
      pixelRatio: this.config.pixelRatio,
      maxZoom: this.config.maxZoom,
      enableTextAntialiasing: true,
      enableImageSmoothing: true,
      useSvgTextLayer: true, // Enable vector-crisp text at any zoom
      pdfDimensions: pdfDimensions, // Pass PDF dimensions for tile coordinate fallback
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
   *
   * @param force - If true, bypass the canRender() guard. Used for mode transitions
   *                which MUST queue renders even during 'settling' state, otherwise
   *                pages will show stale snapshot content indefinitely.
   */
  private queueRenderWithPriority(priorityPages: number[], allPages: number[], force = false): void {
    // ZOOM STATE GUARD: Skip page queuing during active zoom gestures.
    // ZoomScaleService provides centralized state - canRender() returns false
    // during 'active' and 'settling' phases, preventing competing renders.
    //
    // EXCEPTION: Mode transitions (force=true) MUST queue renders even during settling.
    // BUG FIX (2026-01-21): Without this, pages were silently dropped from queue during
    // tiled→full-page transitions because executeModeTransition runs at gesture end
    // while state is still 'settling'. Result: pages stayed on stale snapshots forever.
    if (!force && !this.zoomScaleService.canRender()) {
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
   * amnesia-xc0: Schedule a debounced page refresh when tiles finish rendering.
   * 
   * This is called by the onTileReady callback when tiles complete in the background.
   * It debounces multiple tile completions within 50ms to avoid excessive re-composites.
   * 
   * IMPORTANT: This does NOT call triggerTilePrefetch() because that would add more
   * tiles to the already-saturated queue. Instead, it calls compositeCachedTilesForPage()
   * which ONLY composites tiles that are already in cache - no new render requests.
   * 
   * @param page - Page number to refresh
   * @param priority - Priority of the completed tile (for logging)
   */
  private schedulePageRefresh(page: number, priority: import('./render-coordinator').RenderPriority, tileEpoch: number): void {
    // amnesia-e4i.1: Global rate limiting - check if we're within the composite interval
    const now = performance.now();
    const timeSinceLastComposite = now - this.lastGlobalCompositeTime;
    
    if (timeSinceLastComposite < this.GLOBAL_COMPOSITE_INTERVAL_MS) {
      // Within the rate limit interval - check composite count
      if (this.globalCompositeCount >= this.MAX_COMPOSITES_PER_INTERVAL) {
        // Already hit the limit for this interval, skip silently
        return;
      }
    } else {
      // New interval, reset counter
      this.globalCompositeCount = 0;
    }
    
    // Cancel any existing scheduled refresh for this page
    const existingTimeout = this.pendingPageRefresh.get(page);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    
    // Schedule a new refresh with 150ms debounce (increased from 50ms for amnesia-e4i.1)
    // Capture tileEpoch at schedule time (not execution time) to maintain epoch consistency
    const timeout = setTimeout(() => {
      this.pendingPageRefresh.delete(page);
      
      // Only refresh if the page is still visible
      if (!this.visiblePages.has(page)) {
        return;
      }
      
      // amnesia-e4i.1: Re-check global rate limit at execution time
      const execNow = performance.now();
      const execTimeSince = execNow - this.lastGlobalCompositeTime;
      if (execTimeSince < this.GLOBAL_COMPOSITE_INTERVAL_MS && 
          this.globalCompositeCount >= this.MAX_COMPOSITES_PER_INTERVAL) {
        // Rate limit exceeded at execution time, reschedule
        this.schedulePageRefresh(page, priority, tileEpoch);
        return;
      }
      
      // Update global rate limit tracking
      if (execTimeSince >= this.GLOBAL_COMPOSITE_INTERVAL_MS) {
        this.globalCompositeCount = 0;
      }
      this.lastGlobalCompositeTime = execNow;
      this.globalCompositeCount++;
      
      // Composite ONLY cached tiles - do NOT add new render requests to the queue!
      // triggerTilePrefetch would add all visible tiles (cached AND non-cached) to the queue,
      // making the saturated queue problem worse. compositeCachedTilesForPage only reads
      // from cache and composites what's already rendered.
      if (this.useTiledRendering && this.renderCoordinator?.shouldUseTiling(this.camera.z)) {
        this.compositeCachedTilesForPage(page, tileEpoch).catch(err => {
          console.warn(`[PAGE-REFRESH] page=${page}: Failed to composite cached tiles:`, err);
        });
      }
    }, 150); // Increased from 50ms to 150ms for amnesia-e4i.1
    
    this.pendingPageRefresh.set(page, timeout);
  }
  
  /**
   * amnesia-xc0: Composite ONLY cached tiles for a page without requesting new renders.
   * 
   * This is the key to fixing the nudge bug without making the queue saturation worse.
   * It reads tiles directly from cache and composites them to the canvas, without
   * going through the render queue (semaphore).
   * 
   * EPOCH VALIDATION: The tileEpoch parameter gates compositing. If the tile epoch
   * doesn't match the canvas render state epoch, tiles are skipped (zoom changed).
   * 
   * COVERAGE THRESHOLD: Only composite if we have at least 25% of viewport tiles.
   * This avoids visual artifacts from very sparse partial updates.
   * 
   * @param page - Page number to composite
   * @param tileEpoch - The epoch when the completed tile was requested
   */
  private async compositeCachedTilesForPage(page: number, tileEpoch: number): Promise<void> {
    if (!this.tileEngine || !this.renderCoordinator) return;
    
    const element = this.pageElements.get(page);
    const layout = this.pageLayouts.get(page);
    if (!element || !layout) return;
    
    const zoom = this.camera.z;
    const screenRect = this.getViewportRect();
    if (!screenRect || screenRect.width <= 0 || screenRect.height <= 0) return;
    
    const cacheManager = getTileCacheManager();
    const tileScale = this.renderCoordinator.getTileScale(zoom, this.config.pixelRatio, this.velocity);
    
    // MEMORY FIX (amnesia-aqv): Query only VIEWPORT region, not full page.
    // At 32x zoom, querying the full page returns thousands of tiles causing GPU crash.
    // We query viewport + buffer to handle slight camera drift during async operations.
    const pageDims = this.tileEngine.getPageDimensions(page);
    if (!pageDims) return;
    
    // FIX (amnesia-aqv): Calculate viewport region correctly in PDF-local coordinates.
    // Previous code used screenRect.left/zoom which is always 0, giving wrong coordinates.
    //
    // Correct approach:
    // 1. Get viewport bounds in CONTENT/WORLD coordinates using camera
    // 2. Calculate intersection with page layout rectangle
    // 3. Convert intersection to PDF-local coordinates (relative to page origin)
    
    // Step 1: Get viewport in content coordinates
    const worldViewport = this.getVisibleBoundsForMode(this.camera, screenRect.width, screenRect.height);
    
    // Step 2: Calculate intersection between viewport and page layout
    const intersectLeft = Math.max(worldViewport.x, layout.x);
    const intersectTop = Math.max(worldViewport.y, layout.y);
    const intersectRight = Math.min(worldViewport.x + worldViewport.width, layout.x + layout.width);
    const intersectBottom = Math.min(worldViewport.y + worldViewport.height, layout.y + layout.height);
    
    // Check if there's any intersection
    if (intersectRight <= intersectLeft || intersectBottom <= intersectTop) {
      // Page is not visible in viewport - no tiles to composite
      return;
    }
    
    // Step 3: Convert to PDF-local coordinates (subtract page layout origin)
    const viewportPdfX = intersectLeft - layout.x;
    const viewportPdfY = intersectTop - layout.y;
    const viewportPdfWidth = intersectRight - intersectLeft;
    const viewportPdfHeight = intersectBottom - intersectTop;
    
    // amnesia-5ec FIX: Query region must match CANVAS bounds, not viewport bounds.
    //
    // BUG: At high zoom, the screen viewport is larger than the canvas (which is sized
    // to the page container element). Query used viewport bounds, but canvas was smaller:
    // - viewport: 59x86 PDF units (from camera intersection)
    // - canvas: 27x42 PDF units (from container / zoom)
    // Tiles at PDF X=220 were fetched but canvas only covered [191, 218], causing
    // "All 60 tiles out of bounds" error.
    //
    // FIX: Cap query region to what canvas can actually display.
    // Canvas PDF coverage = container size / zoom (not tileScale!)
    // This ensures every tile returned will fit within the canvas bounds.
    const containerWidth = element?.getCurrentWidth?.() || 441;
    const containerHeight = element?.getCurrentHeight?.() || 666;

    // Canvas PDF coverage (what the canvas can actually display)
    const canvasPdfWidth = containerWidth / zoom;
    const canvasPdfHeight = containerHeight / zoom;

    const queryRegion = {
      x: Math.max(0, viewportPdfX),
      y: Math.max(0, viewportPdfY),
      width: Math.min(canvasPdfWidth, pageDims.width - viewportPdfX, viewportPdfWidth),
      height: Math.min(canvasPdfHeight, pageDims.height - viewportPdfY, viewportPdfHeight),
    };
    
    const spatialResults = cacheManager.getBestAvailableSpatial(page, queryRegion, tileScale);
    
    console.log(`[compositeCachedTiles] page=${page} scale=${tileScale} queryRegion=(${queryRegion.x.toFixed(0)},${queryRegion.y.toFixed(0)} ${queryRegion.width.toFixed(0)}x${queryRegion.height.toFixed(0)}) results=${spatialResults.length}`);
    
    // Filter to only tiles at acceptable quality (cssStretch <= 2.0)
    // and create bitmaps for them
    const cachedTileImages: Array<{
      tile: TileCoordinate;
      bitmap: ImageBitmap;
    }> = [];
    
    // MEMORY FIX (amnesia-aqv): Limit how many tiles we composite at once
    // Creating too many ImageBitmaps simultaneously causes GPU memory exhaustion
    const MAX_TILES_TO_COMPOSITE = 100;
    let processedCount = 0;
    
    // amnesia-aqv DIAGNOSTIC: Track why tiles are filtered
    let skippedCssStretch = 0;
    let skippedNoData = 0;
    let skippedBitmapFail = 0;
    
    for (const result of spatialResults) {
      if (processedCount >= MAX_TILES_TO_COMPOSITE) break;
      
      // Only accept high-quality tiles (within 2x stretch)
      if (result.cssStretch > 2.0) {
        skippedCssStretch++;
        continue;
      }
      
      try {
        // MEMORY FIX (amnesia-aqv): Look up data from cache using cacheKey
        // The spatial index no longer stores data directly to avoid memory duplication
        const data = cacheManager.getCachedDataByKey(result.cacheKey);
        if (!data) {
          skippedNoData++;
          continue; // Data may have been evicted from cache
        }
        
        const bitmap = await cacheManager.createBitmapFromData(data);
        if (bitmap) {
          cachedTileImages.push({
            tile: result.tile,
            bitmap,
          });
          processedCount++;
        } else {
          skippedBitmapFail++;
        }
      } catch (err) {
        skippedBitmapFail++;
        console.warn(`[compositeCachedTilesForPage] Failed to create bitmap for tile:`, err);
      }
    }
    
    // Log filter stats if significant filtering occurred
    if (skippedCssStretch > 0 || skippedNoData > 0 || skippedBitmapFail > 0) {
      console.log(`[compositeCachedTiles] page=${page}: filtered ${skippedCssStretch} cssStretch, ${skippedNoData} noData, ${skippedBitmapFail} bitmapFail, kept ${cachedTileImages.length}/${spatialResults.length}`);
    }
    
    if (cachedTileImages.length === 0) {
      return;
    }

    // amnesia-aqv FIX: Manage render state based on zoom level.
    // At LOW zoom (< 8x): Page fits in viewport, offset should be (0,0)
    // At HIGH zoom (>= 8x): Only part of page visible, use viewport offset
    const isHighZoom = zoom >= 8;
    const renderStateEpoch = this.zoomScaleService.getEpoch();

    // CRITICAL FIX (amnesia-aev): Check if scale changed significantly.
    // BUG: When zooming from 32x to 1x, isHighZoom=false and lastRenderState exists,
    // so establishMinimalRenderState was skipped. This left the old high-scale render
    // state (tileScale=64), causing a 16x scale mismatch rejection loop.
    const currentCanvasScale = element.getLastRenderStateTileScale?.() ?? 0;
    const scaleChanged = currentCanvasScale > 0 &&
      Math.max(tileScale / currentCanvasScale, currentCanvasScale / tileScale) > 2;

    if (isHighZoom) {
      // At high zoom, always call establishMinimalRenderState with viewport offset
      // It internally checks if scale/offset changed and only reinitializes when needed
      const viewportOffset = { x: viewportPdfX, y: viewportPdfY };
      element.establishMinimalRenderState(zoom, pageDims, renderStateEpoch, tileScale, viewportOffset);
    } else if (element.getLastRenderStateEpoch?.() === null || scaleChanged) {
      // At low zoom, establish if not set OR if scale changed significantly
      if (scaleChanged) {
        console.log(`[compositeCachedTiles] page=${page}: Scale change detected (${currentCanvasScale}→${tileScale}), reinitializing render state`);
      }
      element.establishMinimalRenderState(zoom, pageDims, renderStateEpoch, tileScale, { x: 0, y: 0 });
    }

    // amnesia-aqv FIX: Check scale compatibility before compositing.
    //
    // BUG: If canvas was rendered at scale 4 and we try to composite scale-64 tiles,
    // they get shrunk 16x and positions are wrong. This causes blurry/blank output.
    //
    // The canvas needs to be re-rendered at the target scale before we can composite
    // tiles at that scale. Skip compositing if scale mismatch is > 4x.
    const canvasScale = element.getLastRenderStateTileScale?.() ?? 0;
    const scaleMismatch = canvasScale > 0 ? Math.max(tileScale / canvasScale, canvasScale / tileScale) : Infinity;

    if (scaleMismatch > 4) {
      console.log(`[compositeCachedTiles] page=${page}: SKIP - scale mismatch ${scaleMismatch.toFixed(1)}x ` +
        `(canvas=${canvasScale}, tiles=${tileScale}). Canvas needs re-render.`);
      // Close bitmaps to prevent memory leak
      for (const { bitmap } of cachedTileImages) {
        bitmap.close();
      }
      return;
    }

    // SPATIAL INDEX FIX: Use CURRENT epoch, not the stale tileEpoch.
    //
    // The original tileEpoch was captured when the tile render was requested, but
    // by the time spatial index compositing runs, many renders may have completed
    // and the epoch has advanced significantly.
    //
    // Spatial index tiles are safe to composite because:
    // 1. They're filtered by tileScale (matching current zoom)
    // 2. Their positions are calculated from tile.tileX/tileY (absolute PDF coordinates)
    // 3. The spatial index only returns tiles at the correct scale
    //
    // We use the element's current render state epoch to ensure the canvas hasn't
    // been completely invalidated since we started this composite operation.
    const currentEpoch = element.getLastRenderStateEpoch?.() ?? tileEpoch;
    element.addTilesToExistingCanvas(cachedTileImages, currentEpoch);
  }

  /**
   * amnesia-aqv Phase 1C: Immediately composite fallback tiles for visible tiles.
   * 
   * This is called BEFORE queueing high-res renders to provide instant visual feedback.
   * Instead of showing blank areas while high-res tiles render, we show scaled-up
   * lower-resolution tiles from the cache (Google Maps-style fallback).
   * 
   * Key differences from compositeCachedTilesForPage():
   * - Called proactively BEFORE renders, not reactively after
   * - No coverage threshold - show ANY available fallbacks immediately
   * - Accepts higher cssStretch (up to 4x) since it's temporary
   * - Grouped by page for efficient compositing
   * 
   * @param tiles - The tiles being requested (at target scale)
   * @param targetScale - The target scale for these tiles
   * @param epoch - Current scale epoch for validation
   */
  private async compositeFallbackTilesImmediately(
    tiles: TileCoordinate[],
    targetScale: number,
    epoch: number
  ): Promise<void> {
    if (tiles.length === 0) return;
    
    const cacheManager = getTileCacheManager();
    const zoom = this.camera.z;
    
    // Group tiles by page for efficient compositing
    const tilesByPage = new Map<number, TileCoordinate[]>();
    for (const tile of tiles) {
      const pageTiles = tilesByPage.get(tile.page) || [];
      pageTiles.push(tile);
      tilesByPage.set(tile.page, pageTiles);
    }
    
    // Process each page
    for (const [page, pageTiles] of tilesByPage) {
      const element = this.pageElements.get(page);
      const layout = this.pageLayouts.get(page);
      if (!element || !layout) continue;
      
      const fallbackTileImages: Array<{
        tile: TileCoordinate;
        bitmap: ImageBitmap;
        cssStretch?: number;
      }> = [];
      
      for (const tile of pageTiles) {
        // Check if we already have exact-scale tile
        const exactCached = await cacheManager.get(tile);
        if (exactCached) {
          // Already have high-res - no fallback needed
          exactCached.close();
          continue;
        }
        
        // Try to find a fallback at any scale
        const fallback = await cacheManager.getBestAvailableBitmap(tile);
        if (fallback) {
          // Accept higher stretch for immediate fallback (up to 4x)
          // This is temporary - high-res will overdraw soon
          const MAX_FALLBACK_STRETCH = 4.0;
          if (fallback.cssStretch <= MAX_FALLBACK_STRETCH) {
            fallbackTileImages.push({
              tile: fallback.fallbackTile ?? tile,
              bitmap: fallback.bitmap,
              cssStretch: fallback.cssStretch,
            });
          } else {
            // Stretch too large - would look bad, skip
            fallback.bitmap.close();
          }
        }
      }
      
      if (fallbackTileImages.length === 0) continue;

      // Get PDF dimensions for proper tile positioning
      const pdfDimensions = this.tileEngine?.getPageDimensions(page);

      // amnesia-aqv FIX: Manage render state based on zoom level.
      const isHighZoom = zoom >= 8;
      const pdfDims = this.tileEngine?.getPageDimensions(page);
      
      if (!pdfDims && element.getLastRenderStateEpoch?.() === null) {
        console.log(`[compositeFallbackTiles] page=${page}: Skipping - no lastRenderState and no pdfDims`);
        fallbackTileImages.forEach(({ bitmap }) => bitmap.close());
        continue;
      }
      
      if (pdfDims) {
        if (isHighZoom) {
          // At high zoom, always update render state with viewport offset
          const screenRect = this.getViewportRect();
          const worldViewport = this.getVisibleBoundsForMode(this.camera, screenRect.width, screenRect.height);
          const intersectLeft = Math.max(worldViewport.x, layout.x);
          const intersectTop = Math.max(worldViewport.y, layout.y);
          const viewportOffset = { x: intersectLeft - layout.x, y: intersectTop - layout.y };
          element.establishMinimalRenderState(zoom, pdfDims, epoch, targetScale, viewportOffset);
        } else if (element.getLastRenderStateEpoch?.() === null) {
          // At low zoom, only establish if not set, with offset (0,0)
          console.log(`[compositeFallbackTiles] page=${page}: Establishing minimal render state (low zoom)`);
          element.establishMinimalRenderState(zoom, pdfDims, epoch, targetScale, { x: 0, y: 0 });
        }
      }

      // Composite fallback tiles immediately (fire-and-forget)
      // Note: Using addTilesToExistingCanvas for additive compositing
      // so high-res tiles can overdraw later without clearing
      const success = element.addTilesToExistingCanvas(fallbackTileImages, epoch);
      
      if (!success) {
        // Epoch mismatch - close bitmaps
        fallbackTileImages.forEach(({ bitmap }) => bitmap.close());
      }
    }
  }

  /**
   * Queue pages for rendering (legacy method, uses priority queue internally)
   * @param force - If true, bypass the canRender() guard (for mode transitions)
   */
  private queueRender(pages: number[], force = false): void {
    this.queueRenderWithPriority([], pages, force);
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
    if (this.isRendering || !hasWork) return;

    this.isRendering = true;
    // MIGRATION (amnesia-d9f): Use ZoomScaleService for epoch
    const currentVersion = this.zoomScaleService.incrementEpoch();

    // Scale concurrent renders with worker pool (2x workers, capped at 12)
    const pool = getCanvasPool();
    const CONCURRENT_RENDERS = Math.min(pool.workerCount * 2 || 5, 12);
    const activeRenders = new Map<number, Promise<void>>();

    const getNextPage = (): number | null => {
      // Helper to check if page needs rendering (not rendered OR needs zoom rerender)
      const needsRender = (page: number, element: PdfPageElement): boolean => {
        if (!element.getIsRendered()) return true;
        // OVERLAY FIX (amnesia-aqv): Always render if overlay mode is active.
        // The overlay pattern prepares a canvas for atomic swap during mode transitions.
        // Even if the page is "rendered", we need to render fresh content to the overlay
        // and then commit the swap.
        if (element.isRenderingToOverlay()) return true;
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
      while (activeRenders.size < CONCURRENT_RENDERS && this.zoomScaleService.getEpoch() === currentVersion) {
        const page = getNextPage();
        if (page === null) break;

        const element = this.pageElements.get(page);
        if (!element) continue;

        // Start render and track it
        const renderPromise = this.renderPage(page, element, currentVersion)
          .finally(() => {
            activeRenders.delete(page);
            // Start next render as soon as slot becomes available (streaming)
            if (this.zoomScaleService.getEpoch() === currentVersion) {
              startNextRender();
            }
          });

        activeRenders.set(page, renderPromise);
      }
    };

    // Start initial batch of renders
    startNextRender();

    // Wait for all active renders to complete
    while (activeRenders.size > 0 && this.zoomScaleService.getEpoch() === currentVersion) {
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
    // CATiledLayer ARCHITECTURE (amnesia-aqv): Removed epoch-based early return.
    // We ALWAYS render what we have - a "stale" render is still valuable content.
    // Progressive display shows best available, then upgrades when better content arrives.
    // The old pattern `if (epoch !== version) return;` caused high-res tile starvation
    // because high-res tiles (100-500ms render) were always rejected as "stale".

    // STALE CAMERA FIX (2026-01-22): Always use current camera for render decisions.
    // Snapshot-based approach caused corrupted content when camera moved between
    // page queue time and render time.
    const zoom = this.camera.z;
    const layout = this.pageLayouts.get(page);

    // Tiling decision: use tiles at high zoom for crisp rendering (amnesia-wbp consolidated)
    // MIGRATION (amnesia-d9f): Use ZoomScaleService for mode decisions instead of ScaleStateManager.
    // ZoomScaleService provides unified state with:
    // - Hysteresis (10% multiplicative to prevent flapping)
    // - Gesture awareness (via gesture phase)
    // - MAX_TILED_ZOOM upper bound (64x)
    const shouldTileByZoom = this.zoomScaleService.getRenderMode() === 'tiled';
    const shouldTile = this.tileEngine &&
                       this.renderCoordinator &&
                       layout &&
                       shouldTileByZoom;

    // MODE TRANSITION FIX (2026-01-21): During mode transition from full-page to tiled,
    // use FULL-PAGE rendering at the target scale first. This ensures:
    // 1. Complete page coverage (no blank areas)
    // 2. Full-page render gets cached as fallback for subsequent tiled renders
    // 3. Mode transition is seamless
    //
    // Without this, mode transition tries tiled rendering with partial tiles,
    // causing blank areas when tiles fail during continuous zoom.
    const wasTiled = this.pageWasTiled.get(page) ?? false;
    const isModeTransitionToTiled = !wasTiled && shouldTile;

    if (isModeTransitionToTiled) {
      // HIGH-ZOOM BYPASS (amnesia-d9f): At high zoom (>8x), skip full-page transition render.
      //
      // PROBLEM: Full-page renders are capped at 4096px (MuPDF limitation), producing
      // scale ~5 images for a 792px page. When transitioning to tiled mode at zoom 32,
      // the canvas buffer gets sized for scale 5 (3166×4096) instead of scale 32 (14112×21312).
      // Subsequent tile renders at scale 32 are drawn to this undersized buffer, causing
      // corruption (tiles don't fit, content overflows container).
      //
      // FIX: At high zoom, go directly to tiled rendering. The tile system handles
      // canvas sizing correctly based on tileScale (which CAN be 32). Use a cached
      // full-page fallback as base layer, or show blank areas briefly until tiles arrive.
      //
      // The original mode transition logic was designed for low zoom transitions
      // (1x → 4x) where full-page scale 5 is HIGHER than tile scale. At high zoom,
      // the relationship inverts: tile scale 32 >> full-page scale 5.
      const skipFullPageTransition = zoom > 8;
      
      if (skipFullPageTransition) {
        this.pageWasTiled.set(page, true);
        // Don't return - fall through to tiled render below
      } else {
        // Render full-page first to establish a base layer
        await this.renderPageFull(page, element, version);
        // Mark as tiled so subsequent renders use tiled mode (not another full-page)
        // This prevents infinite full-page render loop
        this.pageWasTiled.set(page, true);
        return;
      }
    }

    // TILED → FULL-PAGE TRANSITION FIX (2026-01-21):
    // When transitioning from tiled to full-page mode, we need to:
    // 1. Clear the pageWasTiled flag so next zoom-in uses proper full-page → tiled transition
    //
    // NOTE: DO NOT call resetCanvas() here! Per Two-Track Pipeline architecture,
    // we must always show some content (even stretched/low-res) during transitions.
    // renderPageFull() will handle the canvas correctly via prepareForFullPageRender().
    const isModeTransitionToFullPage = wasTiled && !shouldTile;
    
    // TILE CORRUPTION DIAGNOSTICS (amnesia-26v): Log mode transitions
    if (isDiagnosticsEnabled() && (isModeTransitionToFullPage || isModeTransitionToTiled)) {
      const transitionType = isModeTransitionToTiled ? 'to-viewport-only' : 'to-full-page';
      console.warn(`[TILE-CORRUPTION-DIAG] Mode transition: ${transitionType}`, {
        page,
        zoom: zoom.toFixed(2),
        threshold: this.tileZoomThreshold,
        wasTiled,
        shouldTile,
        recommendation: 'Invalidate cached tiles and abort in-flight requests',
      });
    }
    
    // =========================================================================
    // MODE TRANSITION INVALIDATION (amnesia-584)
    // =========================================================================
    // CATiledLayer Principle: When crossing render mode thresholds, coordinate
    // systems change fundamentally. Tiles from one mode are incompatible with
    // the other mode's coordinate calculations.
    //
    // Full-page mode: canvasOffset = (0, 0), canvas sized to full PDF
    // Viewport-only mode: canvasOffset = (tileBoundsX, tileBoundsY), canvas sized to visible tiles
    //
    // If we composite full-page mode tiles in viewport-only mode (or vice versa),
    // the tiles appear at completely wrong positions because the coordinate
    // origin has shifted.
    //
    // FIX: On mode transition, clear the tile cache for this page and abort
    // any in-flight tile requests. This forces a fresh render in the new mode
    // with correct coordinates.
    if (isModeTransitionToFullPage || isModeTransitionToTiled) {
      const transitionType = isModeTransitionToTiled ? 'full-page → tiled' : 'tiled → full-page';
      console.warn(`[MODE-TRANSITION-INVALIDATE] page=${page}: Invalidating tiles for ${transitionType} transition`);
      
      // 1. Clear cached tiles for this page to prevent stale tiles
      // from being composited with wrong coordinate assumptions
      try {
        const evictedCount = getTileCacheManager().evictTilesForPage(page);
        if (evictedCount > 0) {
          console.log(`[MODE-TRANSITION-INVALIDATE] Evicted ${evictedCount} cached tiles for page ${page}`);
        }
      } catch (e) {
        console.warn(`[MODE-TRANSITION-INVALIDATE] Failed to evict page ${page} tiles:`, e);
      }
      
      // 2. Abort in-flight tile requests - rely on epoch validation to filter stale tiles
      // The epoch counter increments on mode transitions, so tiles from the old mode
      // will be filtered out by the epoch validation in renderTiles()
      
      // 3. Reset the page element's canvas state to ensure clean rendering
      // This clears internal tracking (lastCanvasOffsetX/Y, lastTileBoundsX/Y)
      // which prevents content preservation from using old-mode content
      if (element) {
        element.resetCanvas();
      }
    }
    // =========================================================================
    
    if (isModeTransitionToFullPage) {
      // Clear the tiled flag so subsequent zoom-in uses proper transition
      this.pageWasTiled.set(page, false);
    }

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
    // CATiledLayer ARCHITECTURE (amnesia-aqv): Removed epoch-based early return.
    // Tiles are NEVER rejected based on "staleness" - we always show best available.
    // High-res tiles take 100-500ms to render; rejecting them caused permanent
    // fallback to low-res scale-4 content at high zoom (32x).

    // ZOOM STATE GUARD: Don't render during zoom gestures.
    // This prevents queued renders from executing while zooming.
    if (!this.zoomScaleService.canRender()) {
      return;
    }

    element.showLoading();

    // TRANSFORM SNAPSHOT FIX: Capture all transform-relevant values at REQUEST time.
    // 
    // Tiles take 100-300ms to render in workers. During this time, zoom may change,
    // causing container dimensions to change. If we calculate transforms at DISPLAY
    // time using current dimensions, the result will be wrong for tiles rendered
    // for the previous dimensions → visual drift (focal point shifts ±5-10px).
    //
    // Solution: Create a TransformSnapshot capturing:
    // - Container dimensions at request time
    // - pdfToElementScale at request time (for positioning calculations)
    // - epoch (via ZoomStateManager.getEpoch()) for detecting stale tiles
    //
    // Use these snapshot values at DISPLAY time instead of current values.
    
    const containerWidth = element.getCurrentWidth();
    const containerHeight = element.getCurrentHeight();
    
    // Get PDF dimensions for pdfToElementScale calculation
    // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
    const pdfDims = this.localPageDimensions.get(page) ?? this.tileEngine?.pageDimensions.get(page);
    const pdfWidth = pdfDims?.width ?? containerWidth;
    // amnesia-5ec FIX: pdfToElementScale is the BASE scale (no zoom).
    //
    // COORDINATE SPACE AWARENESS:
    // - Unified mode: containerWidth = layout.width × zoom → divide by zoom to get base
    // - Legacy mode: containerWidth = layout.width (NOT zoomed) → use directly
    //
    // PREVIOUS BUG: Always dividing by zoom assumed unified mode, but in legacy mode
    // containerWidth is already the base width. This caused pdfToElementScale to be
    // 1/zoom of the correct value (0.0313 instead of 1.0 at zoom 32), triggering
    // STALE-SNAPSHOT warnings with 96.9% divergence.
    //
    // The camera transform applies scale(zoom) to the entire canvas, so CSS should
    // use the BASE scale (no zoom) - camera handles visual magnification.
    const pdfToElementScale = this.useUnifiedCoordinateSpace
      ? containerWidth / pdfWidth / zoom  // unified: containerWidth is zoomed
      : containerWidth / pdfWidth;         // legacy: containerWidth is base
    
    const transformSnapshot: TransformSnapshot = {
      containerWidth,
      containerHeight,
      pdfToElementScale,
      epoch: version, // From ZoomStateManager.getEpoch() - incremented on zoom changes
    };

    try {
      // Check if we're transitioning rendering modes (amnesia-wbp consolidated)
      // MIGRATION (amnesia-d9f): Use ZoomScaleService for mode decisions, replacing ScaleStateManager.
      // This ensures consistent mode throughout the render pipeline.
      const wasTiled = this.pageWasTiled.get(page) ?? false;
      const shouldBeTiled = this.zoomScaleService.getRenderMode() === 'tiled';
      const isModeTransition = wasTiled !== shouldBeTiled;

      // VIEWPORT-ONLY CANVAS FIX (2026-01-21): Match canvas to tiles, not full page.
      //
      // PROBLEM: Full-page canvas + viewport-only tiles = blank areas outside viewport.
      // SOLUTION: Size canvas to match actual tiles, expand viewport for tile calculation
      // so panning reveals pre-rendered areas without blank flash.
      //
      // Canvas = tile bounds (sized to match tiles we have)
      // Tiles = viewport + margin (pre-render for panning)
      const forceFullPageTiles = false;

      // ADAPTIVE SCALE TIER FIX: Use higher scale for viewport-only tiles, lower for full-page.
      //
      // At zoom 16x with viewport-only rendering:
      // - Only ~12 tiles visible (small viewport region)
      // - Can safely use scale 32 for crisp text → cssStretch = 1.0
      //
      // At zoom 16x with full-page tiles (mode transition):
      // - ~1950 tiles for entire page at scale 32 → OOM risk!
      // - Keep scale 8 → cssStretch = 4.0 (acceptable for brief transition)
      //
      // Before: tileScale = Math.ceil(zoom * pixelRatio) produced arbitrary scales
      // like 7, 9, 11 which don't exist in SCALE_TIERS = [2,3,4,6,8,12,16,24,32].
      // This caused every tile to miss cache (looking for "s7" but cache has "s6" or "s8").
      //
      // Now: getTargetScaleTier returns the nearest valid tier, ensuring cache hits.
      // Pass maxZoom only for viewport-only tiles (safe for high scale).
      //
      // SCALE MISMATCH FIX (amnesia-d9f): When useExactScaleRendering is enabled,
      // use exact scale (zoom * pixelRatio) to match what the orchestrator calculates.
      // This ensures consistent scale throughout the entire render pipeline.
      const useHighQualityScale = shouldBeTiled && !forceFullPageTiles;
      let rawTileScale: number;
      if (isFeatureEnabled('useExactScaleRendering')) {
        // Exact scale mode: use precise zoom * pixelRatio
        // FIX (amnesia-d9f): Pass maxZoom to ensure proper scale cap (32 instead of 16)
        const { scale } = getExactTargetScale(zoom, this.config.pixelRatio, this.config.maxZoom);
        rawTileScale = scale;
      } else {
        // Tier mode: quantize to valid ScaleTier
        const { tier } = useHighQualityScale
          ? getTargetScaleTier(zoom, this.config.pixelRatio, this.config.maxZoom)
          : getTargetScaleTier(zoom, this.config.pixelRatio, this.config.maxZoom);
        rawTileScale = tier;
      }

      // TILE PIXEL CAP: With 512px fixed tile size (CACHE FIX), scale 32 produces
      // 16384px tiles which exceed GPU limits. Cap scale so tile pixels ≤ 4096.
      // MEMORY FIX (amnesia-e4i): Reduced from 8192 to 4096 to prevent 256MB tiles.
      const MAX_TILE_PIXELS = 8192; // amnesia-aqv: Match progressive-tile-renderer.ts
      const tileSize = getTileSize(zoom);
      const maxScaleForTileSize = Math.floor(MAX_TILE_PIXELS / tileSize);
      const tileScale = Math.min(rawTileScale, maxScaleForTileSize);

      if (rawTileScale > tileScale) {
        console.warn(`[PdfInfiniteCanvas] renderPageTiled: Capping tile scale from ${rawTileScale} to ${tileScale} (tileSize=${tileSize}px, max pixels=${MAX_TILE_PIXELS})`);
      }

      // NOTE: Progressive tile scale was attempted but caused instability during pan.
      // Keeping the code path simple: always render at target scale.
      // The fallback mechanism in render-coordinator.ts handles cold cache by
      // returning lower-scale cached tiles when available.

      // TILE GRID SCALE FIX (amnesia-e4i): ALWAYS use quantized scale for tile GRID calculation.
      //
      // BUG: When useExactScaleRendering=true, the code used exact scale (e.g., 13.08) for
      // both tile grid AND render. But the cache key uses QUANTIZED scale (e.g., 12).
      // This caused tile coordinate mismatch:
      // - Tile (4,8) at scale 13.08 covers PDF region A (tileSize=39.14)
      // - Tile (4,8) at scale 12 covers PDF region B (tileSize=42.67)
      // - Tile rendered for region A gets cached under scale 12 key
      // - Later request for (4,8) at scale 12 expects region B, gets region A content
      // - Result: tiles appear at wrong positions, causing visual corruption during pan
      //
      // FIX: The tile GRID (tileX, tileY coordinates) MUST always use quantized scale
      // so coordinates align with cache keys. The "exact scale" feature should only
      // affect RENDER RESOLUTION (how many pixels the tile has), not the grid.
      //
      // For render resolution: store renderScale separately, pass to render callback
      // For tile grid: always use gridScale (quantized)
      const { tier: gridScale } = getTargetScaleTier(zoom, this.config.pixelRatio, this.config.maxZoom);
      const gridTileScale = Math.min(gridScale, maxScaleForTileSize);
      
      // amnesia-rwe: Clear stale-scale tiles when scale changes significantly.
      // This prevents queue buildup when zooming rapidly (1x → 32x), where tiles
      // from intermediate scales (4, 8, 16, 24) would fill the queue and prevent
      // high-res tiles from rendering quickly.
      const lastRenderScale = this.pageCacheScales.get(page);
      if (lastRenderScale !== undefined && this.renderCoordinator) {
        const scaleRatio = Math.max(gridTileScale / lastRenderScale, lastRenderScale / gridTileScale);
        if (scaleRatio > 2) {
          this.renderCoordinator.abortStaleScaleTiles(gridTileScale, lastRenderScale);
        }
      }
      
      // MID-ZOOM DIAGNOSTIC: Log all scale calculations at mid-zoom levels (4-32x)
      // This captures the amnesia-d9f mid-zoom blank tile bug
      if (zoom >= 4) {
        const idealScale = zoom * this.config.pixelRatio;
        console.warn(`[MID-ZOOM-DIAG] page=${page}:`, {
          zoom: zoom.toFixed(2),
          pixelRatio: this.config.pixelRatio,
          idealScale: idealScale.toFixed(2),
          rawTileScale,
          gridTileScale,  // NEW: The scale used for tile GRID (always quantized)
          finalTileScale: tileScale,  // The scale used for tile RENDER
          wasCapped: rawTileScale > tileScale,
          cssStretch: (idealScale / tileScale).toFixed(2) + 'x',
          containerDims: `${element.getCurrentWidth()}x${element.getCurrentHeight()}`,
          cameraZ: this.camera.z.toFixed(2),
        });
      }

      // At high zoom (>4x), only render VISIBLE tiles (viewport-clipped)
      // At lower zoom, render all tiles for the page (for smooth panning)
      //
      // EXCEPTION: During mode transitions (full-page → tiled), render ALL tiles
      // to avoid viewport-only rendering which adds a translate offset that causes
      // visual "jumps" when the zoom gesture ends.
      let tiles: TileCoordinate[];

      // RENDER SEQUENCE ID: Unique ID to correlate all logs for this render attempt
      const renderSeqId = `r${performance.now().toFixed(0)}-p${page}`;

      // === TILE-DEBUG-MARKER === (unconditional log to trace tile generation)
      console.error(`[TILE-GEN-DEBUG] ${renderSeqId} zoom=${zoom.toFixed(2)} shouldBeTiled=${shouldBeTiled} forceFullPageTiles=${forceFullPageTiles} wasTiled=${wasTiled} isModeTransition=${isModeTransition}`);

      // STALE PAGE CHECK (2026-01-22): Verify page is STILL visible before rendering.
      // Pages are queued at time T1, but render executes at time T2.
      // If user scrolled between T1 and T2, this page may no longer be visible.
      // Rendering it would waste resources and could cause visual glitches.
      {
        const checkScreenRect = this.getViewportRect();
        const currentViewport = this.getVisibleBoundsForMode(this.camera, checkScreenRect.width, checkScreenRect.height);
        const { renderBuffer: checkBuffer } = this.calculateBufferSizes(zoom);
        const expandedViewportCheck = {
          x: currentViewport.x - checkBuffer,
          y: currentViewport.y - checkBuffer,
          width: currentViewport.width + 2 * checkBuffer,
          height: currentViewport.height + 2 * checkBuffer,
        };

        const overlaps = this.rectsOverlap(expandedViewportCheck, layout);

        // DETAILED DEBUG: Log ALL values for comparison with tile engine
        console.error(`[STALE-PAGE-CHECK-DETAIL] ${renderSeqId}:`, {
          camera: `y=${this.camera.y.toFixed(1)}, z=${this.camera.z.toFixed(4)}`,
          screenRect: `${checkScreenRect.width.toFixed(0)}x${checkScreenRect.height.toFixed(0)}`,
          currentViewport: `y=${currentViewport.y.toFixed(1)}, h=${currentViewport.height.toFixed(1)}`,
          checkBuffer,
          expandedViewportCheck: `y=${expandedViewportCheck.y.toFixed(1)}-${(expandedViewportCheck.y + expandedViewportCheck.height).toFixed(1)}`,
          layout: `y=${layout.y.toFixed(1)}-${(layout.y + layout.height).toFixed(1)}`,
          overlaps,
          zoomParam: zoom.toFixed(4),
        });

        if (!overlaps) {
          // BLANK-PAGE-FIX (2026-01-22): Never skip pages that have no content.
          // If we skip a page that was never rendered, it stays blank forever.
          // Only skip stale pages if they already have content to display.
          const hasExistingContent = element.hasRenderedContent();
          if (hasExistingContent) {
            console.error(`[STALE-PAGE-SKIP] ${renderSeqId} no longer visible (has content), skipping render!`);
            element.hideLoading();
            return;
          } else {
            console.warn(`[STALE-PAGE-FORCE-RENDER] ${renderSeqId} would be skipped but has NO CONTENT - rendering anyway!`);
            // Continue to render - page needs content
          }
        }
      }

      // STALE CAMERA FIX (2026-01-22): ALWAYS use current camera for viewport calculation.
      //
      // The previous snapshot-based approach caused severe bugs:
      // - Viewport calculated from stale camera position (e.g., y=10049)
      // - Layout from current page (e.g., y=2981)
      // - NO OVERLAP because viewport and layout in completely different positions
      // - Result: blank pages, corrupted/fragmented content
      //
      // The original intent was to fix "0 visible tiles during continuous scroll",
      // but the cure was worse than the disease. Always use current camera - if tiles
      // occasionally miss during very fast scroll, that's better than corrupted content.
      //
      // NOTE: The page being rendered was already determined earlier in the pipeline.
      // Using current camera ensures tile calculation matches what user actually sees.
      const effectiveCamera = this.camera;

      // Get viewport in WORLD coordinates (not screen coordinates!)
      const screenRect = this.getViewportRect();
      // PHASE 1: Use mode-aware visibility calculation (V4 Architecture)
      const viewport = this.getVisibleBoundsForMode(effectiveCamera, screenRect.width, screenRect.height);

      if (shouldBeTiled) {
        // VIEWPORT EXPANSION FIX (2026-01-22): Use ABSOLUTE renderBuffer instead of fractional margin.
        //
        // BUG FIX: Pages are queued in updateVisiblePages() using calculateBufferSizes().renderBuffer
        // (256px at high zoom). But tile calculation was using VIEWPORT_MARGIN (fraction of viewport).
        // At zoom 13.99x with viewport 132x196, fractional margin = ~66px, but renderBuffer = 256px.
        // This caused pages queued with 256px buffer to fail overlap check with 66px expansion.
        //
        // FIX: Use the same renderBuffer value for tile calculation as for page queuing.
        // This ensures pages that were queued can always generate tiles.
        //
        // UNIT FIX (amnesia-d9f): renderBuffer is in SCREEN pixels, but viewport is in
        // CANVAS coordinates. At high zoom, adding 256 screen pixels to a 33-unit-wide
        // viewport creates a 545-unit-wide expanded viewport (16x too large!).
        // Convert renderBuffer to canvas units by dividing by zoom.
        const { renderBuffer } = this.calculateBufferSizes(zoom);
        const renderBufferCanvas = renderBuffer / zoom;
        const expandedViewport = {
          x: viewport.x - renderBufferCanvas,
          y: viewport.y - renderBufferCanvas,
          width: viewport.width + 2 * renderBufferCanvas,
          height: viewport.height + 2 * renderBufferCanvas,
        };

        // DETAILED DEBUG: Log values BEFORE tile engine call for comparison with stale check
        const preCallOverlap = this.rectsOverlap(expandedViewport, layout);
        console.error(`[TILE-ENGINE-PRE-CALL] ${renderSeqId}:`, {
          camera: `y=${effectiveCamera.y.toFixed(1)}, z=${effectiveCamera.z.toFixed(4)}`,
          screenRect: `${screenRect.width.toFixed(0)}x${screenRect.height.toFixed(0)}`,
          viewport: `y=${viewport.y.toFixed(1)}, h=${viewport.height.toFixed(1)}`,
          renderBuffer,
          expandedViewport: `y=${expandedViewport.y.toFixed(1)}-${(expandedViewport.y + expandedViewport.height).toFixed(1)}`,
          layout: `y=${layout.y.toFixed(1)}-${(layout.y + layout.height).toFixed(1)}`,
          preCallOverlap,
          zoomParam: zoom.toFixed(4),
        });

        // TILE GENERATION STRATEGY (amnesia-d9f + amnesia-e4i):
        //
        // DYNAMIC THRESHOLD based on gesture state:
        // - During active gestures: Low threshold (2-4x) = viewport-only almost always
        // - During settling: Medium threshold (4-8x)
        // - During rendering/idle: Higher threshold (8-16x)
        //
        // This prevents queue overflow during active gestures while allowing
        // full-page rendering when the user is idle (for smooth panning).
        //
        // The key insight: viewport-only during gestures is FINE because:
        // 1. Tiles become stale in milliseconds anyway
        // 2. Fallback tiles provide acceptable visual quality
        // 3. Queue overflow causes WORSE visual artifacts than viewport-only
        const useViewportOnlyTiles = this.renderCoordinator?.shouldUseViewportOnlyTiles(zoom) ?? (zoom > 16);
        
        if (useViewportOnlyTiles) {
          // Viewport-only: get tiles that intersect the expanded viewport
          // GRID SCALE FIX (amnesia-e4i): Use gridTileScale for tile GRID calculation
          tiles = this.tileEngine!.getVisibleTiles(expandedViewport, [layout], zoom, gridTileScale);
        } else {
          // Full-page: get all tiles for the page
          // GRID SCALE FIX (amnesia-e4i): Use gridTileScale for tile GRID calculation
          tiles = this.tileEngine!.getPageTileGrid(page, gridTileScale, zoom);
        }
        
        // amnesia-e4i FIX: Enforce maxTilesPerPage limit to prevent queue overflow.
        // At high zoom (e.g., 16x with scale 32), a single page can require 4704 tiles.
        // This floods the queue and causes most tiles to be dropped.
        // Limit to the most important tiles (center of viewport first).
        //
        // DIRECT FIX: Apply zoom-based limit here instead of relying on render coordinator,
        // because the coordinator's currentZoom may not be updated at the time of render.
        //
        // amnesia-aqv Phase 3 FIX: INCREASED limits to allow full viewport coverage.
        // Previous limit of 50 at 32x caused only 24% coverage - tiles were limited
        // before they could even be queued. Now matches render-coordinator limits.
        const coordinatorLimit = this.renderCoordinator?.getMaxTilesPerPage() ?? 0;
        const zoomBasedLimit = zoom >= 32 ? 150 : zoom >= 16 ? 150 : zoom >= 8 ? 200 : Infinity;
        const maxTilesPerPage = coordinatorLimit > 0 ? Math.min(coordinatorLimit, zoomBasedLimit) : zoomBasedLimit;
        
        // Ensure we have a sensible limit (use 200 as fallback if Infinity)
        const effectiveLimit = Number.isFinite(maxTilesPerPage) ? maxTilesPerPage : 200;
        
        if (effectiveLimit > 0 && tiles.length > effectiveLimit) {
          console.warn(`[TILE-LIMIT] page=${page} zoom=${zoom.toFixed(2)}: Limiting from ${tiles.length} to ${effectiveLimit} tiles (zoom-based limit)`);
          // Sort tiles by distance from viewport center, keep closest
          const viewportCenterX = viewport.x + viewport.width / 2;
          const viewportCenterY = viewport.y + viewport.height / 2;
          const pdfTileSize = getTileSize(zoom) / gridTileScale;
          tiles.sort((a, b) => {
            const aCenterX = layout.x + (a.tileX + 0.5) * pdfTileSize;
            const aCenterY = layout.y + (a.tileY + 0.5) * pdfTileSize;
            const bCenterX = layout.x + (b.tileX + 0.5) * pdfTileSize;
            const bCenterY = layout.y + (b.tileY + 0.5) * pdfTileSize;
            const aDist = Math.hypot(aCenterX - viewportCenterX, aCenterY - viewportCenterY);
            const bDist = Math.hypot(bCenterX - viewportCenterX, bCenterY - viewportCenterY);
            return aDist - bDist;
          });
          tiles = tiles.slice(0, effectiveLimit);
        }

      } else {
        // Non-tiled path (zoom below threshold)
        // TILE-SIZE-MISMATCH-FIX: Pass zoom parameter to ensure consistent tile sizing.
        // GRID SCALE FIX (amnesia-e4i): Use gridTileScale for tile GRID calculation
        tiles = this.tileEngine!.getPageTileGrid(page, gridTileScale, zoom);
      }

      // VIEWPORT-ONLY FIX (amnesia-d9f 2026-01-23): Capture expected tile bounds at REQUEST time.
      //
      // PROBLEM: In viewport-only mode, tile bounds are recalculated from tiles at RENDER time.
      // But if user pans during tile render, tiles arrive for OLD viewport position while
      // CSS is calculated for CURRENT position → tiles drawn at wrong positions → corruption.
      //
      // SOLUTION: Calculate expected tile bounds NOW (at request time) using the SAME
      // algorithm as renderTiles(), and store in transformSnapshot. At render time,
      // use these snapshot bounds instead of recalculating.
      //
      // This ensures CSS positioning matches the tiles, regardless of camera movement.
      //
      // NOTE: zoom > 16 matches the useViewportOnlyTiles condition inside the shouldBeTiled block.
      // We use the condition directly since useViewportOnlyTiles is out of scope here.
      const isViewportOnlyMode = zoom > 16;
      if (isViewportOnlyMode && tiles.length > 0) {
        const actualTileSize = getTileSize(zoom);
        const pdfTileSize = actualTileSize / tileScale;
        
        // Same calculation as renderTiles() - find tile bounds in PDF coordinates
        let minTileX = Infinity, minTileY = Infinity, maxTileX = -Infinity, maxTileY = -Infinity;
        for (const tile of tiles) {
          minTileX = Math.min(minTileX, tile.tileX);
          minTileY = Math.min(minTileY, tile.tileY);
          maxTileX = Math.max(maxTileX, tile.tileX);
          maxTileY = Math.max(maxTileY, tile.tileY);
        }
        
        // Get PDF dimensions for clamping
        // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
        const pdfDims = this.localPageDimensions.get(page) ?? this.tileEngine?.pageDimensions.get(page);
        const pdfWidthForBounds = pdfDims?.width ?? containerWidth;
        const pdfHeightForBounds = pdfDims?.height ?? containerHeight;
        
        // Calculate and clamp bounds (same logic as renderTiles)
        const rawBoundsX = minTileX * pdfTileSize;
        const rawBoundsY = minTileY * pdfTileSize;
        const boundsX = Math.max(0, Math.min(rawBoundsX, pdfWidthForBounds));
        const boundsY = Math.max(0, Math.min(rawBoundsY, pdfHeightForBounds));
        const boundsWidth = Math.max(0, Math.min((maxTileX - minTileX + 1) * pdfTileSize, pdfWidthForBounds - boundsX));
        const boundsHeight = Math.max(0, Math.min((maxTileY - minTileY + 1) * pdfTileSize, pdfHeightForBounds - boundsY));
        
        // Add expected tile bounds to snapshot
        transformSnapshot.expectedTileBounds = {
          x: boundsX,
          y: boundsY,
          width: boundsWidth,
          height: boundsHeight,
        };
        
        // amnesia-0ej FIX: Capture canvas offset at request time for coordinate consistency.
        // In viewport-only mode, the canvas offset equals the tile bounds origin.
        // This ensures tiles are positioned correctly even if viewport moves during render.
        transformSnapshot.canvasOffsetX = boundsX;
        transformSnapshot.canvasOffsetY = boundsY;
        
        // TWO-TRACK FIX: Pre-set canvas CSS NOW in Interaction Track.
        // This respects the Two-Track Pipeline (balancing-forces.md Section 3):
        // - Don't wait for tiles to arrive (Refinement Track)
        // - Set CSS immediately for correct visual feedback
        // This prevents the 44x56px bug where CSS was calculated from incomplete tiles.
        element.presetViewportOnlyCss(
          transformSnapshot.expectedTileBounds!,
          transformSnapshot.pdfToElementScale
        );
        transformSnapshot.cssPreset = true;
        
        console.log(`[TransformSnapshot] EXPECTED-BOUNDS page=${page}: bounds=${boundsX.toFixed(1)},${boundsY.toFixed(1)} ${boundsWidth.toFixed(1)}x${boundsHeight.toFixed(1)}, tiles=[${minTileX}-${maxTileX}]x[${minTileY}-${maxTileY}], pdfTileSize=${pdfTileSize.toFixed(1)}`);
      } else {
        // amnesia-0ej FIX: In full-page mode, canvas offset is always (0,0)
        transformSnapshot.canvasOffsetX = 0;
        transformSnapshot.canvasOffsetY = 0;
      }
      
      // amnesia-e4i FIX (2026-01-25): Record requested tile count for accurate coverage calculation.
      // At high zoom, tiles are limited to prevent queue overflow. The coverage check in
      // pdf-page-element.ts needs to know this expected count to avoid false positives.
      // Without this, coverage calculation uses tile bounding box (e.g., 63×48 = 3024) when
      // only 100 tiles were intentionally sent, resulting in 3.3% "coverage" = false positive.
      transformSnapshot.requestedTileCount = tiles.length;

      if (tiles.length === 0) {
        // No tiles calculated - check if page is actually in viewport
        if (shouldBeTiled) {
          // VISIBILITY CHECK CONSISTENCY FIX: Use SNAPSHOT camera (effectiveCamera)
          // for visibility check, matching the camera used for tile calculation above.
          //
          // Previously used this.camera (current), which caused a race condition:
          // - Tiles calculated at line 2303 using effectiveCamera (snapshot)
          // - If tiles.length === 0, visibility checked with this.camera (current)
          // - Camera could have moved during async render, causing mismatch
          //
          // Using effectiveCamera ensures:
          // 1. Tiles and visibility use same camera state
          // 2. Pages visible in snapshot get fallback render (not skipped)
          // 3. No race condition between tile calculation and visibility check
          const screenRect = this.getViewportRect();
          // PHASE 1: Use mode-aware visibility calculation (V4 Architecture)
          const viewport = this.getVisibleBoundsForMode(effectiveCamera, screenRect.width, screenRect.height);
          const overlaps = this.rectsOverlap(viewport, layout);
          if (!overlaps) {
            // Page is not visible - skip it regardless of render state.
            // FIX (2026-01-22): Don't force render pages outside viewport!
            // The old logic forced full-page renders for never-rendered pages even when
            // they weren't visible, causing blank flashes and wasted GPU work during pan.
            // Pages will be re-queued and rendered when they scroll into view.
            element.hideLoading();
            return;
          }
        }
        // Page is in viewport but no tiles - dimensions may not be set. Fall back to full-page.
        console.warn(`[PdfInfiniteCanvas] No tiles for page ${page}, falling back to full render`);
        await this.renderPageFull(page, element, version);
        return;
      }

      // TILE INTEGRITY: Record all tile requests before rendering
      const integrityChecker = getTileIntegrityChecker();
      integrityChecker.recordBatchRequest(
        renderSeqId,
        page,
        tiles.map(t => ({ tileX: t.tileX, tileY: t.tileY, scale: t.scale }))
      );

      // INV-6 FIX (2026-01-23): Capture scale snapshot BEFORE tile batch.
      // All tiles in this batch MUST use the same epoch to prevent mixed-scale corruption.
      // amnesia-aqv: Use ZoomScaleService snapshot
      const scaleSnapshot = this.zoomScaleService.captureSnapshot();

      // amnesia-aqv.1 FIX: PARTIAL-WAIT STREAMING MODE for high zoom (>= 16x)
      // 
      // PROBLEM: At max zoom, Promise.all waits for ALL 100 tiles (~12.5 seconds).
      // User sees nothing until all tiles complete.
      //
      // SOLUTION: At high zoom, use partial-wait streaming mode:
      // 1. Request all tiles (fire and forget for non-critical ones)
      // 2. Wait for FIRST N critical tiles to complete (~1-2 seconds)
      // 3. Composite those tiles (establishes render state for streaming)
      // 4. Return immediately - rest of tiles composite via onTileReady callback
      //
      // This reduces perceived T2HR from ~12s to ~1.5s (first critical batch).
      const useStreamingMode = zoom >= 16;
      
      // amnesia-aqv: Scale CRITICAL_BATCH_SIZE with viewport tile count
      // PROBLEM: Fixed 12 tiles = only 10% coverage at 32x (120 tiles needed)
      // SOLUTION: Use percentage-based sizing for 50% viewport coverage
      // This ensures users see half the viewport quickly, regardless of zoom level
      const MIN_CRITICAL_BATCH = 12;
      const MAX_CRITICAL_BATCH = 60; // Don't wait forever - cap at 60 tiles
      const CRITICAL_PERCENTAGE = 0.5; // Aim for 50% coverage
      const CRITICAL_BATCH_SIZE = Math.min(
        MAX_CRITICAL_BATCH,
        Math.max(MIN_CRITICAL_BATCH, Math.floor(tiles.length * CRITICAL_PERCENTAGE))
      );
      console.log(`[CRITICAL-BATCH] page=${page}: ${tiles.length} tiles, critical batch size=${CRITICAL_BATCH_SIZE} (${(CRITICAL_BATCH_SIZE / tiles.length * 100).toFixed(0)}% coverage), zoom=${zoom.toFixed(2)}, useStreamingMode=${useStreamingMode}`);
      
      if (useStreamingMode && tiles.length > CRITICAL_BATCH_SIZE) {
        console.log(`[STREAMING-RENDER] page=${page} zoom=${zoom.toFixed(2)}: Using partial-wait streaming for ${tiles.length} tiles, epoch=${scaleSnapshot.epoch}`);
        const streamingStartTime = performance.now();
        
        // amnesia-aqv: Pre-render fallback for newly visible pages
        // PROBLEM: When zooming to high zoom on a page that wasn't previously rendered,
        // there's no cached fallback to show during tile loading. User sees blank canvas.
        // SOLUTION: Fire off a fallback render before tiles load.
        //
        // FIX (2026-01-27): Use ADAPTIVE fallback scale based on target zoom.
        // Previously used fixed FALLBACK_SCALE=4, which at zoom 32 means 8× stretching.
        // Now: use scale that gives max 4× stretch for acceptable quality.
        //
        // Target scale = zoom × DPR (e.g., 32 × 2 = 64)
        // For 4× max stretch: fallback scale = target / 4
        // Capped at 16 to avoid excessive fallback render time.
        const cacheManager = getTileCacheManager();
        const targetScale = tileScale; // Already computed above
        const adaptiveFallbackScale = Math.min(16, Math.max(4, Math.ceil(targetScale / 4)));
        
        // Check for available fallbacks from highest to lowest scale
        const hasScale16 = cacheManager.hasFullPage(page, 16);
        const hasScale8 = cacheManager.hasFullPage(page, 8);
        const hasScale4 = cacheManager.hasFullPage(page, 4);
        const hasScale2 = cacheManager.hasFullPage(page, 2);
        const hasScale1 = cacheManager.hasFullPage(page, 1);
        
        // Use the BEST available fallback (highest scale up to adaptive target)
        let bestAvailableFallbackScale = 0;
        if (hasScale16 && 16 <= adaptiveFallbackScale) bestAvailableFallbackScale = 16;
        else if (hasScale8 && 8 <= adaptiveFallbackScale) bestAvailableFallbackScale = 8;
        else if (hasScale16) bestAvailableFallbackScale = 16; // Accept any available
        else if (hasScale8) bestAvailableFallbackScale = 8;
        else if (hasScale4) bestAvailableFallbackScale = 4;
        else if (hasScale2) bestAvailableFallbackScale = 2;
        else if (hasScale1) bestAvailableFallbackScale = 1;
        
        const hasFallback = bestAvailableFallbackScale > 0;
        const FALLBACK_SCALE = hasFallback ? bestAvailableFallbackScale : adaptiveFallbackScale;
        console.log(`[FALLBACK-CHECK] page=${page}: target=${targetScale}, adaptive=${adaptiveFallbackScale}, best available=${bestAvailableFallbackScale}, using=${FALLBACK_SCALE}`);
        
        // amnesia-aqv FIX: Render fallback IMMEDIATELY as placeholder
        // PROBLEM: User sees nothing for 2-3 seconds while waiting for critical batch
        // SOLUTION: Always render available fallback FIRST, then start tile rendering
        // This gives users something to see within ~100ms instead of waiting 2-3s
        
        // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
        const pdfDims = this.localPageDimensions.get(page) ?? this.tileEngine?.pageDimensions.get(page);
        
        if (hasFallback && pdfDims) {
          // TWO-TRACK FIX: Check if high-res tiles are already on the canvas.
          // compositeCachedTilesForPage may have already drawn high-res tiles from the spatial index.
          // Don't overwrite them with a low-res fallback!
          const lastRenderScale = element.getLastRenderStateEpoch?.() !== null ? 
            (element as any).lastRenderState?.tileScale : null;
          
          // Skip fallback if canvas already has content at a good scale (within 2x of target)
          if (lastRenderScale && lastRenderScale >= tileScale * 0.5) {
            console.log(`[FALLBACK-IMMEDIATE] page=${page}: SKIPPED - canvas already has scale ${lastRenderScale} content (target=${tileScale})`);
          } else {
            // Fallback already cached - render it immediately!
            console.log(`[FALLBACK-IMMEDIATE] page=${page}: Cached fallback found, rendering as placeholder (lastScale=${lastRenderScale}, target=${tileScale})`);
            try {
              await element.renderTiles(
                [], // No tiles yet - just base layer from cache
                undefined,
                zoom,
                pdfDims,
                transformSnapshot,
                scaleSnapshot.epoch,
                false,
                this.currentGestureId // amnesia-aqv: pass gestureId
              );
              element.hideLoading();
              console.log(`[FALLBACK-IMMEDIATE] page=${page}: Placeholder rendered from cache, now starting tile rendering`);
            } catch (e) {
              console.warn(`[FALLBACK-IMMEDIATE] page=${page}: Failed to render cached placeholder:`, e);
            }
          }
        } else if (this.renderCoordinator && pdfDims) {
          // No cached fallback - render one quickly
          console.log(`[FALLBACK-PRERENDER] page=${page}: No cached fallback, triggering scale-${FALLBACK_SCALE} pre-render`);
          
          const FALLBACK_TIMEOUT_MS = 200; // Wait up to 200ms for fallback
          const fallbackStartTime = performance.now();
          const fallbackRequest = this.renderCoordinator.requestRender({
            type: 'page' as const,
            page,
            scale: FALLBACK_SCALE,
            priority: 'critical', // CRITICAL priority - we need this ASAP
            documentId: this.documentId ?? undefined,
            sessionId: this.pendingSessionId,
          });
          
          // Wait for fallback with timeout - don't block forever
          const timeoutPromise = new Promise<null>(resolve => 
            setTimeout(() => resolve(null), FALLBACK_TIMEOUT_MS)
          );
          
          const fallbackResult = await Promise.race([fallbackRequest, timeoutPromise]);
          const fallbackTime = performance.now() - fallbackStartTime;
          
          if (fallbackResult && fallbackResult.success) {
            // TWO-TRACK FIX: Check if high-res tiles are already on the canvas.
            const lastRenderScalePrerender = element.getLastRenderStateEpoch?.() !== null ? 
              (element as any).lastRenderState?.tileScale : null;
            
            if (lastRenderScalePrerender && lastRenderScalePrerender >= tileScale * 0.5) {
              console.log(`[FALLBACK-PRERENDER] page=${page}: SKIPPED - canvas already has scale ${lastRenderScalePrerender} content (target=${tileScale})`);
              if (fallbackResult.data instanceof ImageBitmap) {
                fallbackResult.data.close();
              }
            } else {
              console.log(`[FALLBACK-PRERENDER] page=${page}: Scale-${FALLBACK_SCALE} fallback ready in ${fallbackTime.toFixed(0)}ms, rendering as placeholder`);
              
              try {
                await element.renderTiles(
                  [], // No tiles yet - just base layer from cache
                  undefined,
                  zoom,
                  pdfDims,
                  transformSnapshot,
                  scaleSnapshot.epoch,
                  false,
                  this.currentGestureId // amnesia-aqv: pass gestureId
                );
                element.hideLoading();
                console.log(`[FALLBACK-PRERENDER] page=${page}: Placeholder rendered, now starting tile rendering`);
              } catch (e) {
                console.warn(`[FALLBACK-PRERENDER] page=${page}: Failed to render placeholder:`, e);
              }
              if (fallbackResult.data instanceof ImageBitmap) {
                fallbackResult.data.close();
              }
            }
          } else {
            console.log(`[FALLBACK-PRERENDER] page=${page}: Fallback timed out after ${FALLBACK_TIMEOUT_MS}ms, proceeding with tiles`);
            
            // amnesia-aqv FIX: Establish minimal render state so tiles can be composited.
            // Without lastRenderState, tiles complete but addTilesToExistingCanvas rejects them.
            // This creates a minimal state using existing canvas dimensions.
            if (pdfDims) {
              // amnesia-aqv FIX: Calculate viewport offset for proper tile positioning.
              const layout = this.pageLayouts.get(page);
              if (layout) {
                const screenRect = this.getViewportRect();
                const worldViewport = this.getVisibleBoundsForMode(this.camera, screenRect.width, screenRect.height);
                const intersectLeft = Math.max(worldViewport.x, layout.x);
                const intersectTop = Math.max(worldViewport.y, layout.y);
                const viewportPdfX = intersectLeft - layout.x;
                const viewportPdfY = intersectTop - layout.y;
                const viewportOffset = { x: viewportPdfX, y: viewportPdfY };
                element.establishMinimalRenderState(zoom, pdfDims, scaleSnapshot.epoch, tileScale, viewportOffset);
              } else {
                element.establishMinimalRenderState(zoom, pdfDims, scaleSnapshot.epoch, tileScale);
              }
            }
          }
        }
        
        // Split tiles: critical batch + background (rest)
        const criticalTiles = tiles.slice(0, CRITICAL_BATCH_SIZE);
        const backgroundTiles = tiles.slice(CRITICAL_BATCH_SIZE);
        
        // Step 1: Queue critical tiles FIRST (they get priority in the semaphore)
        // This ensures critical tiles get permits before background/prefetch tiles
        // amnesia-aqv: Use forceFreshRender to skip fallback path for critical batch.
        // This ensures users see high-res tiles for the visible viewport, not blurry fallbacks.
        const criticalPromises = criticalTiles.map(tile =>
          this.renderCoordinator!.requestRender({
            type: 'tile' as const,
            tile,
            priority: 'critical',
            documentId: this.documentId ?? undefined,
            sessionId: this.pendingSessionId,
            scaleEpoch: scaleSnapshot.epoch,
            renderParamsId: scaleSnapshot.snapshotId,
            forceFreshRender: true, // Skip fallback - wait for actual high-res renders
            // amnesia-aqv: Gesture correlation for hybrid guard
            gestureId: this.currentGestureId,
          })
        );
        
        // Step 2: Fire background tile requests (don't wait)
        // The onTileReady callback handles compositing as these complete
        backgroundTiles.forEach(tile => {
          this.renderCoordinator!.requestRender({
            type: 'tile' as const,
            tile,
            priority: 'medium', // Lower priority for background
            documentId: this.documentId ?? undefined,
            sessionId: this.pendingSessionId,
            scaleEpoch: scaleSnapshot.epoch,
            renderParamsId: scaleSnapshot.snapshotId,
            // amnesia-aqv: Gesture correlation for hybrid guard
            gestureId: this.currentGestureId,
          }).catch(() => {
            // Silently handle errors - streaming compositing will fill gaps
          });
        });
        
        const criticalResults = await Promise.all(criticalPromises);
        const criticalTime = performance.now() - streamingStartTime;
        
        // Step 3: Process critical batch results (establishes render state)
        const criticalTileImages: Array<{
          tile: typeof tiles[0];
          bitmap: ImageBitmap;
          cssStretch?: number;
          scaleEpoch?: number;
          renderParamsId?: string;
        }> = [];
        
        for (let i = 0; i < criticalTiles.length; i++) {
          const result = criticalResults[i];
          if (result.success && result.data instanceof ImageBitmap) {
            const tileForCompositing = result.fallbackTile ?? criticalTiles[i];
            criticalTileImages.push({
              tile: tileForCompositing,
              bitmap: result.data,
              cssStretch: result.cssStretch,
              scaleEpoch: result.scaleEpoch,
              renderParamsId: result.renderParamsId,
            });
          }
        }
        
        // amnesia-aqv DIAGNOSTIC: Check if tiles are at correct scale
        const scaleDistribution = new Map<number, number>();
        for (const result of criticalResults) {
          if (result.success && result.actualScale !== undefined) {
            scaleDistribution.set(result.actualScale, (scaleDistribution.get(result.actualScale) ?? 0) + 1);
          }
        }
        const scaleInfo = [...scaleDistribution.entries()].map(([s, c]) => `${s}:${c}`).join(', ');
        console.log(`[STREAMING-RENDER] page=${page}: Critical batch ${criticalTileImages.length}/${CRITICAL_BATCH_SIZE} tiles in ${criticalTime.toFixed(0)}ms, scales=[${scaleInfo}], ${backgroundTiles.length} rendering in background`);
        
        // Step 4: If we have critical tiles, render them (establishes render state)
        if (criticalTileImages.length > 0) {
          // Get PDF dimensions for renderTiles
          // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
          const pdfDims = this.localPageDimensions.get(page) ?? this.tileEngine?.pageDimensions.get(page);

          console.log(`[STREAMING-RENDER] page=${page}: Calling renderTiles with ${criticalTileImages.length} tiles, pdfDims=${pdfDims?.width}x${pdfDims?.height}`);

          // Use the normal tile rendering path for critical batch
          const renderResult = await element.renderTiles(
            criticalTileImages,
            undefined, // textLayerData - not needed for streaming
            zoom,
            pdfDims, // pdfDimensions
            transformSnapshot,
            scaleSnapshot.epoch, // currentEpoch
            false, // forceFullPage
            this.currentGestureId // amnesia-aqv: pass gestureId
          );

          // STALE-TILE RECOVERY (amnesia-aqv): Two-Track Pipeline recovery mechanism.
          // When tiles are filtered as stale (camera drifted too far during render),
          // trigger recovery by requesting fresh tiles for current camera position.
          // The fallback layer provides visual coverage while recovery tiles arrive.
          if (!renderResult.success && renderResult.reason === 'stale-tiles-filtered') {
            console.warn(`[STALE-TILE-RECOVERY] page=${page}: Initiating recovery (${JSON.stringify(renderResult.context)})`);

            // Take fresh camera snapshot (current position, not stale snapshot)
            const freshCamera = { ...this.camera };
            const freshZoom = freshCamera.z;
            const freshScaleSnapshot = this.zoomScaleService.captureSnapshot();

            // Re-calculate visible tiles for current position
            const freshScreenRect = this.getViewportRect();
            const freshViewport = this.getVisibleBoundsForMode(freshCamera, freshScreenRect.width, freshScreenRect.height);
            const { renderBuffer: freshRenderBuffer } = this.calculateBufferSizes(freshZoom);
            const freshRenderBufferCanvas = freshRenderBuffer / freshZoom;
            const freshExpandedViewport = {
              x: freshViewport.x - freshRenderBufferCanvas,
              y: freshViewport.y - freshRenderBufferCanvas,
              width: freshViewport.width + 2 * freshRenderBufferCanvas,
              height: freshViewport.height + 2 * freshRenderBufferCanvas,
            };

            // Get fresh tiles for current position
            const freshTiles = this.tileEngine!.getVisibleTiles(freshExpandedViewport, [layout], freshZoom, gridTileScale);
            const freshCriticalTiles = freshTiles.slice(0, CRITICAL_BATCH_SIZE);

            console.log(`[STALE-TILE-RECOVERY] page=${page}: Requesting ${freshCriticalTiles.length} fresh tiles for current position`);

            // Fire and forget - tiles will composite via onTileReady callback
            // Don't await - we want to return immediately with fallback displayed
            freshCriticalTiles.forEach(tile => {
              this.renderCoordinator!.requestRender({
                type: 'tile' as const,
                tile,
                priority: 'critical',
                documentId: this.documentId ?? undefined,
                sessionId: this.pendingSessionId,
                scaleEpoch: freshScaleSnapshot.epoch,
                renderParamsId: freshScaleSnapshot.snapshotId,
                forceFreshRender: true, // Skip fallback - get high-res tiles
                gestureId: this.currentGestureId,
              }).catch(() => {
                // Silently handle errors - streaming compositing will fill gaps
              });
            });
          } else {
            console.log(`[STREAMING-RENDER] page=${page}: renderTiles completed - ${renderResult.tilesDrawn} tiles drawn`);
          }

          element.hideLoading();
        } else {
          // amnesia-aqv FIX: No critical tiles succeeded - STILL establish render state.
          //
          // BUG: When critical batch is empty, this code path returned immediately
          // without calling renderTiles. This left lastRenderState=null.
          // When background tiles completed later, addTilesToExistingCanvas rejected
          // them with "REJECTED - no lastRenderState".
          //
          // FIX: Call renderTiles with empty array to establish lastRenderState.
          // This allows background tiles to composite via addTilesToExistingCanvas.
          // The fallback base layer (if cached) will be drawn, providing visual content
          // while high-res tiles arrive in the background.
          console.warn(`[STREAMING-RENDER] page=${page}: No critical tiles succeeded, establishing render state for background compositing`);
          
          const pdfDims = this.localPageDimensions.get(page) ?? this.tileEngine?.pageDimensions.get(page);
          if (pdfDims) {
            const establishResult = await element.renderTiles(
              [], // No tiles - just establish render state with base layer fallback
              undefined,
              zoom,
              pdfDims,
              transformSnapshot,
              scaleSnapshot.epoch,
              false,
              this.currentGestureId
            );
            console.log(`[STREAMING-RENDER] page=${page}: Render state established (success=${establishResult.success}), background tiles will composite`);
          } else {
            console.error(`[STREAMING-RENDER] page=${page}: CRITICAL - no pdfDims available, cannot establish render state!`);
          }
          element.hideLoading();
        }
        
        // Return immediately - background tiles will composite via onTileReady
        return;
      }

      // BLOCKING MODE: Original behavior for lower zoom levels
      // Request tiles through coordinator (handles caching, deduplication)
      const tilePromises = tiles.map(tile =>
        this.renderCoordinator!.requestRender({
          type: 'tile' as const,
          tile,
          priority: this.getTilePriority(tile, layout),
          documentId: this.documentId ?? undefined,
          sessionId: this.pendingSessionId,
          // INV-6: Attach epoch for display-time validation
          scaleEpoch: scaleSnapshot.epoch,
          renderParamsId: scaleSnapshot.snapshotId,
          // amnesia-aqv: Gesture correlation for hybrid guard
          gestureId: this.currentGestureId,
        })
      );

      const results = await Promise.all(tilePromises);

      // CATiledLayer ARCHITECTURE: Epoch-based tile rejection REMOVED
      //
      // The old approach discarded tiles when epoch changed during render:
      // - Tiles took 100-500ms to render
      // - Epoch incremented 40+ times during zoom gesture
      // - Tiles were discarded as "stale" even though they were at correct position/scale
      // - Result: high-res tiles never displayed, permanent low-res fallback
      //
      // New approach: Accept ALL rendered tiles regardless of epoch.
      // The spatial index validates tile position/scale, not temporal epoch.
      // Progressive display shows best available while better content arrives.
      //
      // Diagnostic logging for debugging (no rejection):
      const currentEpoch = this.zoomScaleService.getEpoch();
      if (currentEpoch !== version && zoom >= 4) {
        const successCount = results.filter(r => r.success && r.data instanceof ImageBitmap).length;
        console.log(`[CATiledLayer] page=${page} zoom=${zoom.toFixed(2)}: epoch ${version}→${currentEpoch}, ` +
          `${successCount}/${tiles.length} tiles successful - ACCEPTING ALL (no epoch rejection)`);
      }

      // Collect successful tile data for rendering
      // Include cssStretch for fallback tiles to enable proper CSS sizing
      // INV-6: Include scaleEpoch/renderParamsId for display-time validation
      const tileImages: Array<{
        tile: typeof tiles[0];
        bitmap: ImageBitmap;
        cssStretch?: number;
        scaleEpoch?: number;
        renderParamsId?: string;
      }> = [];
      let failedCount = 0;
      let rejectedFallbackCount = 0;

      for (let i = 0; i < tiles.length; i++) {
        const result = results[i];
        if (result.success && result.data instanceof ImageBitmap) {
          // FALLBACK SCALE TOLERANCE (2026-01-22): Accept scaled fallback tiles within limits.
          //
          // BUG: When tile requests are aborted/dropped, the fallback mechanism returns
          // cached tiles at ANY available scale (e.g., scale 2 when scale 12 was requested).
          // The cssStretch field indicates the scale ratio (e.g., 6.0 means 6x stretch needed).
          //
          // ORIGINAL FIX: Rejected ANY fallback with cssStretch != 1.0 to prevent corruption.
          //
          // PROBLEM: At mid-zoom (4-10x), tile request drops are common due to rapid scroll.
          // Rejecting all fallbacks causes BLANK GAPS which are worse than blurry content.
          //
          // NEW FIX (amnesia-d9f): Accept fallback tiles up to 8x stretch.
          // - White gaps in text are far worse than slightly blurry areas
          // - The exact-scale tiles will arrive shortly and overdraw the blurry fallback
          // - 8x stretch is visible blur but still readable, gaps are not
          //
          // REGRESSION FIX (amnesia-e4i): Dynamic stretch limit based on zoom level.
          // At zoom 32x with only scale 2 cached, cssStretch would be 16x.
          // The 8x limit rejected ALL tiles, causing blank pages during pan.
          // Solution: At very high zoom, accept even blurry content - blank is worse.
          const cssStretch = result.cssStretch ?? 1.0;
          // At zoom 32x+ accept up to 32x stretch, at zoom 16x+ accept 16x, else 8x
          const MAX_FALLBACK_STRETCH = zoom >= 32 ? 32.0 : zoom >= 16 ? 16.0 : 8.0;
          const isStretchTooLarge = cssStretch > MAX_FALLBACK_STRETCH;

          if (isStretchTooLarge) {
            // Reject only extremely stretched fallbacks (> 8x)
            result.data.close();
            rejectedFallbackCount++;
            console.warn(`[FALLBACK-REJECT] page=${page} tile=(${tiles[i].tileX},${tiles[i].tileY}): ` +
              `rejecting fallback with cssStretch=${cssStretch.toFixed(2)} (exceeds ${MAX_FALLBACK_STRETCH}x limit)`);
            continue;
          }

          // Log when using scaled fallback (not exact scale)
          if (cssStretch > 1.01) {
            console.log(`[FALLBACK-ACCEPT] page=${page} tile=(${tiles[i].tileX},${tiles[i].tileY}): ` +
              `using ${cssStretch.toFixed(1)}x stretched fallback (better than gap)`);
          }

          // Runtime check ensures type safety (RenderCoordinator decodes Blobs off main thread)
          // Extract cssStretch from fallback results for proper CSS sizing
          // INV-6: Include scaleEpoch/renderParamsId for display-time validation
          //
          // amnesia-e4i CRITICAL FIX: Use fallbackTile for positioning when available!
          // When a fallback tile is used, its coordinates (tileX, tileY, tileSize) map to
          // the actual PDF region in the bitmap. Using the original request tile's coordinates
          // would position the content at the WRONG location, causing visual corruption.
          const tileForCompositing = result.fallbackTile ?? tiles[i];
          
          // Log when fallback tile coordinates differ (indicates the fix is working)
          if (result.fallbackTile && (
            result.fallbackTile.tileX !== tiles[i].tileX ||
            result.fallbackTile.tileY !== tiles[i].tileY ||
            result.fallbackTile.tileSize !== tiles[i].tileSize
          )) {
            console.log(`[amnesia-e4i] Using fallbackTile for compositing: ` +
              `requested (${tiles[i].tileX},${tiles[i].tileY})/ts${tiles[i].tileSize} → ` +
              `actual (${result.fallbackTile.tileX},${result.fallbackTile.tileY})/ts${result.fallbackTile.tileSize}`);
          }
          
          tileImages.push({
            tile: tileForCompositing,
            bitmap: result.data,
            cssStretch: result.cssStretch, // May be undefined for exact-scale tiles
            scaleEpoch: result.scaleEpoch,
            renderParamsId: result.renderParamsId,
          });
        } else {
          failedCount++;
        }
      }

      // Track rejected fallbacks separately from failed tiles for diagnostics
      if (rejectedFallbackCount > 0 && zoom >= 4) {
        console.warn(`[FALLBACK-REJECT-SUMMARY] page=${page} zoom=${zoom.toFixed(2)}: ` +
          `rejected ${rejectedFallbackCount} fallback tiles due to scale mismatch`);
      }

      // DIAGNOSTIC: Log tile collection results (expanded range for debugging amnesia-d9f)
      // Always log when there are failures, regardless of zoom level
      if (failedCount > 0 || rejectedFallbackCount > 0) {
        const tileXs = tileImages.map(t => t.tile.tileX);
        const tileYs = tileImages.map(t => t.tile.tileY);
        // Log failed tile details with error messages
        const failedTiles: string[] = [];
        const errorCounts: Record<string, number> = {};
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (!result.success || !(result.data instanceof ImageBitmap)) {
            const tile = tiles[i];
            const errorMsg = result.error || (result.success ? 'no-bitmap' : 'unknown');
            failedTiles.push(`(${tile.tileX},${tile.tileY}):${errorMsg}`);
            errorCounts[errorMsg] = (errorCounts[errorMsg] || 0) + 1;
          }
        }
        console.error(`[TileCollection] page=${page} zoom=${zoom.toFixed(2)}: ${tileImages.length}/${tiles.length} tiles (${failedCount} failed, ${rejectedFallbackCount} rejected)`, {
          xRange: tileImages.length > 0 ? `${Math.min(...tileXs)}-${Math.max(...tileXs)}` : 'none',
          yRange: tileImages.length > 0 ? `${Math.min(...tileYs)}-${Math.max(...tileYs)}` : 'none',
          forceFullPage: forceFullPageTiles,
          epoch: version,
          currentEpoch: this.zoomScaleService.getEpoch(),
          errorCounts: Object.keys(errorCounts).length > 0 ? JSON.stringify(errorCounts) : 'none',
          failedTiles: failedTiles.slice(0, 10).join(', ') + (failedTiles.length > 10 ? `... (${failedTiles.length} total)` : ''),
        });
      }

      // TILE INTEGRITY CHECK: Record results and detect failures
      // (reuse integrityChecker from above)
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const tile = tiles[i];
        const success = result.success && result.data instanceof ImageBitmap;
        const error = !result.success ? (result.error || 'unknown') : undefined;
        integrityChecker.recordResult(page, tile.tileX, tile.tileY, tile.scale, success, error, result.cssStretch);
      }

      // Generate integrity report and trigger retries if needed
      const expectedTiles = tiles.map(t => ({ tileX: t.tileX, tileY: t.tileY, scale: t.scale }));
      const integrityReport = integrityChecker.generateReport(renderSeqId, page, zoom, expectedTiles);

      // If significant failures, schedule a retry for missing tiles AFTER initial render completes
      // This ensures the user sees something immediately while we fill in gaps
      if (!integrityReport.isComplete && integrityReport.missing.length > 0 && zoom >= 4) {
        console.warn(`[TILE-INTEGRITY-ALERT] page=${page} zoom=${zoom.toFixed(2)}: ` +
          `${(integrityReport.coverage * 100).toFixed(1)}% coverage, ${integrityReport.missing.length} tiles missing`);

        // Schedule retry for missing tiles (non-blocking)
        // Uses a short delay to avoid overwhelming the render queue
        const missingTileCount = integrityReport.missing.length;
        if (missingTileCount <= 50) { // Only retry reasonable number of tiles
          setTimeout(() => {
            this.retryMissingTiles(page, integrityReport.missing, zoom, tileScale, version);
          }, 200); // 200ms delay to let current render complete
        } else {
          console.warn(`[TILE-RETRY-SKIP] page=${page}: Too many missing tiles (${missingTileCount}), skipping retry`);
        }
      }

      // Get text layer (non-blocking)
      let textLayerData: TextLayerData | undefined;
      try {
        textLayerData = await this.provider.getPageTextLayer(page);
      } catch {
        // Text layer is optional
      }

      // CATiledLayer ARCHITECTURE (amnesia-aqv): REMOVED epoch-based tile discard.
      // This was the PRIMARY cause of high-res tile starvation at zoom 32x.
      // Tiles that took 100-500ms to render were ALWAYS discarded because
      // epoch changed 40+ times during the render (one per zoom event).
      // 
      // Now we ALWAYS display tiles regardless of epoch. Progressive display
      // shows whatever we have, then upgrades when better content arrives.
      // "Stale" tiles are still VALID content - they just might be at wrong zoom level.

      // Get PDF native dimensions for coordinate transform
      // Tiles are rendered in PDF coordinate space, but layout may be scaled
      // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
      const pdfDimensions = this.localPageDimensions.get(page) ?? this.tileEngine?.pageDimensions.get(page);

      // Guard: If all tiles failed to produce ImageBitmaps, fall back to full-page rendering
      // Use current render version to ensure we render something
      if (tileImages.length === 0) {
        console.warn(`[PdfInfiniteCanvas] All ${tiles.length} tiles failed to produce ImageBitmaps, falling back to full render`);
        await this.renderPageFull(page, element, this.zoomScaleService.getEpoch());
        return;
      }

      // HIGH-ZOOM SPARSE COVERAGE FIX (2026-01-23): Fall back to full-page when tile
      // coverage is extremely low AND no cached fallback exists.
      //
      // At very high zoom (32x+), the visible viewport is tiny compared to the page.
      // We request 1000+ tiles for the full page, but only visible tiles have high priority.
      // Most off-screen tiles timeout or are dropped, leaving sparse coverage.
      //
      // Without a cached full-page fallback, the canvas would be mostly blank with only
      // a few tile-sized regions of content. This looks broken.
      //
      // FIX: If coverage < 10%, check for cached fallback. If none exists, force full-page
      // render at a lower scale. This ensures users always see complete page content.
      const coverageRatio = tileImages.length / tiles.length;
      const EXTREME_SPARSE_THRESHOLD = 0.10; // 10% coverage

      if (coverageRatio < EXTREME_SPARSE_THRESHOLD) {
        // Check if cached fallback exists
        const cacheManager = getTileCacheManager();
        const fallbackExists = await cacheManager.getBestAvailableFullPage(page, tileScale);

        if (!fallbackExists) {
          console.warn(`[SPARSE-COVERAGE-FALLBACK] page=${page} zoom=${zoom.toFixed(2)}: ` +
            `Only ${tileImages.length}/${tiles.length} tiles (${(coverageRatio * 100).toFixed(1)}%) with no cached fallback. ` +
            `Falling back to full-page render.`);

          // Close the sparse tiles we have
          for (const { bitmap } of tileImages) {
            bitmap.close();
          }

          // Render full page
          await this.renderPageFull(page, element, this.zoomScaleService.getEpoch());
          return;
        } else {
          console.log(`[SPARSE-COVERAGE-OK] page=${page}: ${(coverageRatio * 100).toFixed(1)}% coverage, ` +
            `but cached fallback exists at scale ${fallbackExists.actualScale}`);
        }
      }

      // UNIFIED COORDINATE SPACE: cssStretch is no longer needed.
      // Tiles are rendered at exact DPR resolution and positioned within
      // page elements that are sized to their final zoomed dimensions.
      // The old cssStretch mechanism has been removed.

      // Render tiles to element with PDF dimensions for correct positioning
      // TRANSFORM SNAPSHOT FIX: Pass TransformSnapshot captured at request time
      // This ensures CSS positioning uses request-time dimensions, not current dimensions
      // EPOCH VALIDATION: Pass current epoch for validation in renderTiles.
      // If zoom changed since tile request (version !== transformSnapshot.epoch),
      // renderTiles will fall back to current dimensions instead of stale snapshot.
      // FORCE FULL PAGE FIX: Pass forceFullPageTiles to prevent incorrect viewport-only
      // canvas sizing when some tiles are aborted during continuous zoom.
      // amnesia-aqv: Pass gestureId for hybrid guard tile lifecycle correlation
      const blockingRenderResult = await element.renderTiles(tileImages, textLayerData, zoom, pdfDimensions, transformSnapshot, this.zoomScaleService.getEpoch(), forceFullPageTiles, this.currentGestureId);

      // STALE-TILE RECOVERY (amnesia-aqv): Handle stale tiles in blocking mode.
      // Less common at lower zoom levels, but still possible during rapid pan.
      if (!blockingRenderResult.success && blockingRenderResult.reason === 'stale-tiles-filtered') {
        console.warn(`[BLOCKING-RENDER] page=${page}: Stale tiles detected, scheduling recovery via scroll rerender`);
        // In blocking mode, trigger a scroll rerender to refresh tiles
        this.scheduleScrollRerender();
      } else {
        console.log(`[BLOCKING-RENDER] page=${page}: renderTiles completed - ${blockingRenderResult.tilesDrawn} tiles drawn`);
      }

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
   * Get tile priority based on distance from focal point (during zoom) or viewport center (during scroll).
   *
   * FOCAL-POINT-RADIAL PRIORITY FIX: During zoom gestures, tiles closest to the zoom
   * focal point should render first. This ensures users see sharp content at their
   * zoom target immediately, with quality radiating outward.
   *
   * During scroll (no zoom gesture active), we fall back to viewport center priority
   * for optimal scroll experience.
   */
  private getTilePriority(
    tile: TileCoordinate,
    layout: PageLayout
  ): RenderPriority {
    // Use canvas coordinates for priority calculation
    const screenRect = this.getViewportRect();
    // PHASE 1: Use mode-aware visibility calculation (V4 Architecture)
    const viewport = this.getVisibleBoundsForMode(this.camera, screenRect.width, screenRect.height);

    // FOCAL-POINT-RADIAL PRIORITY: Use zoom focal point if available, else viewport center.
    // During zoom gestures, the focal point is where the user is zooming (cursor/pinch center).
    // Prioritizing tiles near the focal point means users see sharpness at their zoom target first.
    // amnesia-aqv: Use ZoomScaleService instead of deprecated ZoomStateMachine
    const zoomSnapshot = this.zoomScaleService.getZoomSnapshot();
    let priorityCenterX: number;
    let priorityCenterY: number;

    if (zoomSnapshot && this.zoomScaleService.isZoomActive()) {
      // ZOOM GESTURE ACTIVE: Use focal point in canvas coordinates
      // Convert screen focal point to canvas coordinates
      const focalCanvas = screenToCanvas(zoomSnapshot.focalPoint, zoomSnapshot.camera);
      priorityCenterX = focalCanvas.x;
      priorityCenterY = focalCanvas.y;
      // console.log(`[FOCAL-RADIAL] Using zoom focal point: (${priorityCenterX.toFixed(0)}, ${priorityCenterY.toFixed(0)})`);
    } else {
      // NO ZOOM: Use viewport center for scroll-optimized priority
      priorityCenterX = viewport.x + viewport.width / 2;
      priorityCenterY = viewport.y + viewport.height / 2;
    }

    // Calculate tile center in canvas coordinates
    // amnesia-rwe FIX: Convert tile indices to canvas coordinates correctly.
    //
    // Tile coordinate system:
    // - tile.tileX, tile.tileY: Grid indices
    // - tile.tileSize: CSS tile size (e.g., 128px at high zoom)
    // - tile.scale: Render scale (e.g., 64)
    // - PDF tile size = tileSize / scale (e.g., 128/64 = 2 PDF units)
    //
    // To convert tile index to canvas position:
    // 1. Get PDF position: tileX * pdfTileSize
    // 2. Convert to canvas: pdfPos * (layout.width / pdfWidth)
    //
    // SIMPLIFICATION: At zoom Z, canvas coords scale with zoom.
    // A tile covers (tileSize/scale) PDF units, which is (tileSize/scale * zoom) canvas units.
    // Since scale ≈ zoom * DPR for crisp rendering, canvas tile size ≈ tileSize / DPR.
    // But for focal priority, we just need relative distances, so we can use a simpler approach:
    // 
    // The tile grid covers the entire page. Tile (0,0) is at layout origin.
    // Tile (tileX, tileY) is at (tileX/totalTilesX, tileY/totalTilesY) fraction of the page.
    const actualTileSize = tile.tileSize ?? TILE_SIZE;
    const pdfTileSize = actualTileSize / tile.scale;
    
    // Get page dimensions to calculate total tiles
    // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
    const pdfDims = this.localPageDimensions.get(tile.page) ?? this.tileEngine?.pageDimensions.get(tile.page);
    const pdfWidth = pdfDims?.width ?? layout.width;
    const pdfHeight = pdfDims?.height ?? layout.height;
    
    // Convert PDF tile position to canvas position
    // pdfPos = tileIndex * pdfTileSize
    // canvasPos = layout.origin + pdfPos * (layout.size / pdfSize)
    const pdfX = tile.tileX * pdfTileSize;
    const pdfY = tile.tileY * pdfTileSize;
    const canvasScaleX = layout.width / pdfWidth;
    const canvasScaleY = layout.height / pdfHeight;
    
    const tileX = layout.x + pdfX * canvasScaleX;
    const tileY = layout.y + pdfY * canvasScaleY;
    const tileCenterX = tileX + (pdfTileSize * canvasScaleX) / 2;
    const tileCenterY = tileY + (pdfTileSize * canvasScaleY) / 2;

    // Distance from priority center (focal point or viewport center)
    const distance = Math.sqrt(
      Math.pow(tileCenterX - priorityCenterX, 2) +
      Math.pow(tileCenterY - priorityCenterY, 2)
    );

    // ============================================================================
    // amnesia-aqv Phase 3A: Velocity-boosted priority
    // ============================================================================
    // Tiles in the scroll direction get priority boost because the user is
    // moving toward them. This prevents "chasing" where we render tiles the
    // user just left while the destination tiles wait in queue.
    //
    // Implementation: Check if tile is in the direction of scroll velocity.
    // If so, tighten the distance thresholds for higher priority.
    // ============================================================================
    
    let velocityBoost = false;
    const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
    
    if (speed > 1) {
      // Vector from viewport center to tile center
      const toTileX = tileCenterX - priorityCenterX;
      const toTileY = tileCenterY - priorityCenterY;
      
      // Dot product with velocity direction
      // Positive = tile is in direction of scroll (user moving toward it)
      const dot = toTileX * this.velocity.x + toTileY * this.velocity.y;
      velocityBoost = dot > 0;
    }

    // Priority based on distance, with velocity boost
    // At high zoom (scale >= 16), use tighter thresholds to prioritize center
    const isHighZoom = tile.scale >= 16;
    const criticalRadius = isHighZoom ? viewport.width / 6 : viewport.width / 4;
    const highRadius = isHighZoom ? viewport.width / 3 : viewport.width / 2;
    const mediumRadius = isHighZoom ? viewport.width / 1.5 : viewport.width;
    
    // With velocity boost: shift thresholds to make tiles in scroll direction higher priority
    const boostFactor = velocityBoost ? 1.5 : 1.0;
    
    if (distance < criticalRadius * boostFactor) return 'critical';
    if (distance < highRadius * boostFactor) return 'high';
    if (distance < mediumRadius * boostFactor) return 'medium';
    return 'low';
  }

  /**
   * Retry rendering missing tiles for a page.
   * Called after initial render completes to fill in gaps.
   * Non-blocking - failures are logged but don't break anything.
   */
  private async retryMissingTiles(
    page: number,
    missingTiles: TileRequest[],
    zoom: number,
    tileScale: number,
    originalVersion: number
  ): Promise<void> {
    // Don't retry if zoom changed (tiles would be wrong scale anyway)
    if (this.zoomScaleService.getEpoch() !== originalVersion) {
      console.log(`[TILE-RETRY-SKIP] page=${page}: Epoch changed (${originalVersion} → ${this.zoomScaleService.getEpoch()}), skipping retry`);
      return;
    }

    const element = this.pageElements.get(page);
    if (!element) {
      console.log(`[TILE-RETRY-SKIP] page=${page}: Page element not found`);
      return;
    }

    console.log(`[TILE-RETRY] page=${page}: Retrying ${missingTiles.length} missing tiles at scale ${tileScale}`);

    try {
      // Convert missing tile requests to TileCoordinate format
      // amnesia-e4i FIX: Include tileSize so render uses matching size
      const tileSize = getTileSize(zoom);
      const retryTiles: TileCoordinate[] = missingTiles.map(t => ({
        page: t.page,
        tileX: t.tileX,
        tileY: t.tileY,
        scale: t.scale as any, // TileScale
        tileSize,
      }));

      // Request retry tiles with boosted priority
      const layout = this.pageLayouts.get(page);
      if (!layout) return;

      // INV-6 FIX (2026-01-23): Capture scale snapshot for retry batch.
      // amnesia-aqv: Use ZoomScaleService snapshot
      const scaleSnapshot = this.zoomScaleService.captureSnapshot();

      const retryPromises = retryTiles.map(tile =>
        this.renderCoordinator!.requestRender({
          type: 'tile' as const,
          tile,
          priority: 'critical', // Boosted priority for retries
          documentId: this.documentId ?? undefined,
          sessionId: this.pendingSessionId,
          // INV-6: Attach epoch for display-time validation
          scaleEpoch: scaleSnapshot.epoch,
          renderParamsId: scaleSnapshot.snapshotId,
          // amnesia-aqv: Gesture correlation for hybrid guard
          gestureId: this.currentGestureId,
        })
      );

      const retryResults = await Promise.all(retryPromises);

      // Check results
      const successCount = retryResults.filter(r => r.success && r.data instanceof ImageBitmap).length;
      const failCount = retryResults.length - successCount;

      console.log(`[TILE-RETRY-RESULT] page=${page}: ${successCount}/${retryResults.length} retry tiles succeeded, ${failCount} still failed`);

      // If we got some successful tiles, update the page element
      if (successCount > 0) {
        const retryTileImages = retryResults
          .map((result, i) => {
            if (result.success && result.data instanceof ImageBitmap) {
              return {
                tile: retryTiles[i],
                bitmap: result.data,
                cssStretch: result.cssStretch,
              };
            }
            return null;
          })
          .filter((t): t is NonNullable<typeof t> => t !== null);

        // Get dimensions for rendering
        // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
        const pdfDimensions = this.localPageDimensions.get(page) ?? this.tileEngine?.pageDimensions.get(page);

        // Use element's addRetryTiles method if available, otherwise log
        if (typeof (element as any).addRetryTiles === 'function') {
          await (element as any).addRetryTiles(retryTileImages, zoom, pdfDimensions);
        } else {
          // For now, just log that we would update - full implementation needs addRetryTiles on PdfPageElement
          console.log(`[TILE-RETRY] page=${page}: Got ${successCount} retry tiles (addRetryTiles not implemented yet)`);
          // Clean up bitmaps
          for (const { bitmap } of retryTileImages) {
            bitmap.close();
          }
        }
      }
    } catch (e) {
      console.error(`[TILE-RETRY-ERROR] page=${page}:`, e);
    }
  }

  /**
   * Render a page using full-page rendering (original path)
   */
  private async renderPageFull(
    page: number,
    element: PdfPageElement,
    version: number
  ): Promise<void> {
    // CATiledLayer ARCHITECTURE (amnesia-aqv): Removed epoch-based early return.
    // Full-page renders are valuable fallback content - never reject them as "stale".
    // Progressive display will upgrade when higher-quality content arrives.

    element.showLoading();

    // PAGE SCALE STABILITY FIX: Immediately reset canvas CSS to container size
    // before async operations start. This prevents the stretched/clipped appearance
    // that occurs when old viewport-only tile CSS settings interact with new camera zoom.
    //
    // OVERLAY FIX (amnesia-aqv): Skip if already in overlay mode. When executeModeTransition
    // calls prepareForFullPageRenderWithOverlay(), it sets up the overlay canvas for atomic
    // swap. Calling prepareForFullPageRender() here would reset that state and switch back
    // to snapshot mode, defeating the purpose of the overlay pattern.
    if (!element.isRenderingToOverlay()) {
      element.prepareForFullPageRender();
    }

    // Calculate zoom-aware render scale for sharp text at current zoom
    // Cap at max useful scale to avoid fetching unnecessarily large images
    const zoomAwareScale = this.getZoomAwareRenderScale();
    const maxScale = this.getMaxUsefulScale();
    // zoomAwareScale * pixelRatio = desired scale for HiDPI quality
    // maxScale = absolute max (2048px / pageWidth) to avoid wasteful fetches
    let targetScale = Math.min(zoomAwareScale * this.config.pixelRatio, maxScale);

    // FULL-PAGE FALLBACK SAFETY CAP: At extreme zoom (>4x), full-page rendering
    // may be called as fallback when all tiles fail. Tiles typically fail due to
    // memory constraints at high scales. To prevent the same failure, cap scale
    // such that the largest dimension doesn't exceed 4096 pixels.
    //
    // Example: At 32x zoom on 612×792 PDF:
    // - Uncapped: 612×32=19584 × 792×32=25344 pixels (496MP, impossible)
    // - Capped: max dimension 4096 → scale = 4096/792 ≈ 5.17 (produces 3166×4096, feasible)
    //
    // This ensures full-page fallback produces SOMETHING rather than failing silently.
    const MAX_FULL_PAGE_DIMENSION = 4096; // MuPDF's internal cap
    // amnesia-aqv FIX: Use localPageDimensions first (per-document), then tileEngine (shared singleton)
    const pageDims = this.localPageDimensions.get(page) ?? this.tileEngine?.pageDimensions.get(page);
    const pageWidth = pageDims?.width ?? 612;
    const pageHeight = pageDims?.height ?? 792;
    const maxPageDim = Math.max(pageWidth, pageHeight);
    const safeMaxScale = MAX_FULL_PAGE_DIMENSION / maxPageDim;

    if (targetScale > safeMaxScale) {
      console.warn(`[PdfInfiniteCanvas] renderPageFull: Capping scale from ${targetScale.toFixed(2)} to ${safeMaxScale.toFixed(2)} (max dimension ${maxPageDim}×${targetScale.toFixed(0)}=${Math.round(maxPageDim * targetScale)}px exceeds ${MAX_FULL_PAGE_DIMENSION}px)`);
      targetScale = safeMaxScale;
    }

    try {
      // Use dual-resolution if provider supports it (preferred path)
      if (this.provider.getPageImageDualRes) {
        const result = await this.provider.getPageImageDualRes(page, {
          scale: targetScale,
          dpi: 150,
          format: 'png',
        });

        // CATiledLayer ARCHITECTURE (amnesia-aqv): REMOVED epoch-based render rejection.
        // Full-page renders are ALWAYS valuable - even "stale" content is better than blank.
        // The old pattern discarded valid renders if epoch changed during the async fetch,
        // which happened constantly during zoom gestures (40+ epoch changes per gesture).
        //
        // Now we ALWAYS render what we fetched. Progressive display handles showing
        // best available content and upgrading when better content arrives.

        // Get text layer (non-blocking)
        let textLayerData: TextLayerData | undefined;
        try {
          textLayerData = await this.provider.getPageTextLayer(page);
        } catch {
          // Text layer is optional
        }

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
            if (this.zoomScaleService.getEpoch() !== version || !this.visiblePages.has(page)) {
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

        // CATiledLayer ARCHITECTURE (amnesia-aqv): REMOVED epoch-based render rejection.
        // Same as dual-res path - we ALWAYS render fetched content.

        let textLayerData: TextLayerData | undefined;
        try {
          textLayerData = await this.provider.getPageTextLayer(page);
        } catch {
          // Text layer is optional
        }

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

      // BLANK PAGE FIX: prepareForFullPageRender() set canvas opacity=0.
      // If render fails, we MUST show the canvas to avoid blank pages.
      // Even stale/failed content is better than a completely hidden canvas.
      element.showCanvas();
      console.warn(`[PdfInfiniteCanvas] renderPageFull failed, restoring canvas visibility for page ${page}`);
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
    // amnesia-rwe: At extreme zoom (>16x), minimize buffers to reduce tile count.
    // At 32x zoom with 128px tiles, even a small buffer creates many tiles.
    // The visible viewport at 32x is tiny in PDF space, so we don't need large buffers.
    //
    // Previous: MIN_RENDER_BUFFER=256 → 256/2=128 tiles for 256×256 screen area
    // New: At high zoom, use much smaller buffers
    
    if (zoom > 16) {
      // High zoom: minimize buffers
      // At 32x zoom, 64px buffer = 2 PDF units = 1 tile at 128px/scale64
      return {
        renderBuffer: 64,    // ~1 tile worth of buffer
        elementBuffer: 128,  // ~2 tiles
        keepBuffer: 192,     // ~3 tiles
      };
    }
    
    // Normal zoom: use original buffer sizes
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
    // STALE CAMERA FIX (2026-01-22): Always use current camera, not stale snapshots
    const effectiveZoom = zoom ?? this.camera.z;
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
    // STALE CAMERA FIX (2026-01-22): Always use current camera, not stale snapshots
    const zoom = zoomOverride ?? this.camera.z;
    const pixelRatio = this.config.pixelRatio;

    // Target scale for crisp rendering: zoom × pixelRatio
    // At zoom 32x with DPR 2: idealScale = 64
    const idealScale = zoom * pixelRatio;

    // amnesia-aqv FIX: Use GPU_SAFE_MAX_SCALE (64) instead of hardcoded 32.
    // At zoom 32 with DPR 2, we need scale 64 for crisp rendering.
    // Previous cap of 32 caused 2x blur at max zoom.
    // Memory is managed by tiled rendering (only visible tiles rendered).
    return Math.min(idealScale, GPU_SAFE_MAX_SCALE);
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

    // STUCK TILE FIX: Check if rendering mode should change (amnesia-wbp consolidated)
    // MIGRATION (amnesia-d9f): Use ZoomScaleService for mode decisions, replacing ScaleStateManager.
    const currentZoom = this.camera.z;
    const wasTiled = this.pageWasTiled.get(page) ?? false;
    const shouldBeTiled = this.zoomScaleService.getRenderMode() === 'tiled';

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
      // The layer needs the focal point for coordinate consistency in progressive renders
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

    // SCALE MISMATCH FIX (amnesia-d9f): Respect useExactScaleRendering flag
    // In exact mode, skip intermediate progressive rendering since we always render at exact scale.
    if (isFeatureEnabled('useExactScaleRendering')) {
      // FIX (amnesia-d9f): Pass maxZoom to ensure proper scale cap
      const { scale } = getExactTargetScale(this.camera.z, this.config.pixelRatio, this.config.maxZoom);
      // Direct final render at exact scale (no intermediate)
      this.zoomFinalRenderTimeout = setTimeout(() => {
        if (this.scaleVersion !== currentScaleVersion) {
          console.log(`[PdfInfiniteCanvas] Skipping stale exact-mode render (version ${currentScaleVersion} != ${this.scaleVersion})`);
          return;
        }
        console.log(`[PdfInfiniteCanvas] Exact-mode zoom: final render at scale ${scale}`);
        this.renderZoomPhase('final', scale, currentScaleVersion);
      }, this.ZOOM_FINAL_DELAY);
      return;
    }

    // Tier-based progressive rendering (legacy mode)
    // FIX (2026-01-23): Pass maxZoom to prevent scale jumps at zoom boundaries
    const { tier: targetTier } = getTargetScaleTier(this.camera.z, this.config.pixelRatio, this.config.maxZoom);

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
    // This is defense-in-depth - the onSettlingComplete callback should
    // only fire when phase is 'idle' or 'rendering', but this guards against legacy code paths.
    if (!this.zoomScaleService.canRender()) {
      console.log(`[PdfInfiniteCanvas] Skipping ${phase} render - zoom gesture active (phase: ${this.zoomScaleService.getGesturePhase()})`);
      return;
    }

    // STALE VISIBLE PAGES FIX (2026-01-22): Refresh visiblePages before rendering.
    // During zoom gestures, updateVisiblePages() is blocked (canRender() returns false).
    // This means visiblePages contains the set from BEFORE the gesture started.
    // If the user zoomed/panned to a different part of the document, pages that are now
    // visible won't be in visiblePages, and pages that scrolled out will still be there.
    //
    // Now that canRender() returns true (state is 'rendering'), we can safely refresh
    // visiblePages to reflect the current camera position. This ensures:
    // 1. Newly visible pages get rendered
    // 2. Pages that scrolled out don't waste render cycles
    // 3. Page elements are created for new visible pages
    //
    // Note: updateVisiblePages() will queue pages for render, but queueRenderWithPriority()
    // handles duplicates, so the subsequent queueRender() call is safe.
    console.log(`[PdfInfiniteCanvas] renderZoomPhase: Refreshing visiblePages before ${phase} render`);
    this.updateVisiblePages();

    const visiblePagesForRender = this.visiblePages;

    // Find pages that need re-rendering
    const pagesToRerender: number[] = [];
    for (const page of visiblePagesForRender) {
      if (this.needsZoomRerender(page)) {
        pagesToRerender.push(page);
      }
    }

    if (pagesToRerender.length > 0) {
      console.log(
        `[PdfInfiniteCanvas] ${phase} render: ${pagesToRerender.length} pages at zoom ${this.camera.z.toFixed(2)}, scale ${scale}`
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
   * NOTE: This method was Phase 1 scaffolding. The cssStretch-based approach has been
   * replaced with the unified coordinate space architecture (amnesia-c7w removed cssStretch
   * tracking). This method is now fully integrated with gesture handlers via zoomAtPoint().
   */
  private handleZoomChange(newZoom: number, focalPoint: Point): void {
    const oldZoom = this.camera.z;

    // Guard: No change
    if (Math.abs(newZoom - oldZoom) < 0.001) {
      return;
    }

    console.log(`[PdfInfiniteCanvas] handleZoomChange: ${oldZoom.toFixed(2)} → ${newZoom.toFixed(2)}, focalPoint=(${focalPoint.x.toFixed(0)}, ${focalPoint.y.toFixed(0)})`);

    // amnesia-rwe: Clear stale tile queue on major zoom changes (>2x ratio).
    // Without this, zooming from 1x → 32x floods the queue with 300+ stale tiles
    // from intermediate scales, causing critical high-res tiles to wait 100+ seconds.
    const majorZoomRatio = Math.max(newZoom / oldZoom, oldZoom / newZoom);
    if (majorZoomRatio > 2 && this.renderCoordinator) {
      console.log(`[amnesia-rwe] Major zoom change: ${oldZoom.toFixed(2)} → ${newZoom.toFixed(2)} (${majorZoomRatio.toFixed(1)}x ratio), clearing tile queue`);
      this.renderCoordinator.abortAllPending();
      // amnesia-e4i: Reset pan distance tracking after zoom-triggered queue clear
      this.lastQueueClearPosition = { x: this.camera.x, y: this.camera.y };
      this.cumulativePanDistance = 0;
    }

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

    // amnesia-e4i: Update render coordinator's zoom for policy decisions
    this.renderCoordinator?.setCurrentZoom(newZoom);

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

    // amnesia-aqv: Notify ZoomScaleService that scale was rendered.
    // This keeps the unified state machine's renderScale in sync with actual rendered content.
    this.zoomScaleService.onScaleRendered(scale);

    // Final phase completes the zoom gesture - reset animation state and state machine
    if (phase === 'final') {
      this.zoomTransformLayer?.onZoomGestureEnd();

      // amnesia-aqv: Notify ZoomScaleService that render is complete.
      // This clears the snapshot and transitions back to 'idle'.
      this.zoomScaleService.completeRenderPhase();
      
      // amnesia-e4i: Process retry queue for any tiles that were dropped during gesture
      // Schedule with small delay to let current render batch settle
      setTimeout(() => {
        this.renderCoordinator?.processRetryQueue().catch(err => {
          console.warn('[PdfInfiniteCanvas] Retry queue processing failed:', err);
        });
      }, 100);
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
    // amnesia-aqv: Detect new scroll gesture start
    // If no pending timeout, this is the FIRST scroll event in a new gesture
    const isNewGesture = this.scrollRerenderTimeout === null;
    if (isNewGesture) {
      const oldGestureId = this.currentGestureId;
      this.currentGestureId = generateGestureId();
      getTileLifecycleTracer().emit({
        type: 'gesture.started',
        gestureId: this.currentGestureId,
        metadata: { trigger: 'scroll', previousGestureId: oldGestureId },
      });
      console.log(`[GESTURE] New scroll gesture: ${this.currentGestureId.slice(0, 12)} (was ${oldGestureId.slice(0, 12)})`);
    }

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

    // TRACE: Log snapshot capture
    console.warn(`[SCROLL-SNAPSHOT-CAPTURE] camera.y=${this.camera.y.toFixed(1)}, z=${this.camera.z.toFixed(2)}, ts=${performance.now().toFixed(0)}`);

    this.scrollRerenderTimeout = setTimeout(() => {
      // GUARD: Viewport may be destroyed during the 32ms debounce (component unmount, tab close)
      if (!this.viewport || !this.viewport.isConnected) {
        this.scrollRenderSnapshot = null;
        return;
      }

      // ZOOM STATE GUARD: Don't render during zoom gestures.
      // ZoomScaleService provides centralized state - canRender() returns false
      // during 'active' and 'settling' phases.
      if (!this.zoomScaleService.canRender()) {
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

      // TRACE: Log snapshot vs current camera at debounce fire time
      console.warn(`[SCROLL-DEBOUNCE-FIRE] snapshot.camera.y=${snapshot.camera.y.toFixed(1)}, current.camera.y=${this.camera.y.toFixed(1)}, deltaY=${(this.camera.y - snapshot.camera.y).toFixed(1)}, snapshot.z=${snapshot.camera.z.toFixed(2)}, current.z=${this.camera.z.toFixed(2)}, snapshotBounds.y=${snapshotBounds.y.toFixed(1)}, ts=${performance.now().toFixed(0)}`);

      // Use SNAPSHOTTED layout parameters to prevent race conditions
      const { layoutMode, pagesPerRow, cellWidth, cellHeight, padding } = snapshot;
      // Use consistent buffer calculation with minimum floors (same as updateVisiblePages)
      const { renderBuffer } = this.calculateBufferSizes(snapshot.camera.z);
      // UNIT FIX (amnesia-aqv): Convert screen-pixel buffer to canvas units
      const renderBufferCanvas = renderBuffer / snapshot.camera.z;

      // Calculate pages that were visible at snapshot time
      const snapshotVisiblePages = this.calculatePagesInBounds(
        snapshotBounds.x - renderBufferCanvas,
        snapshotBounds.y - renderBufferCanvas,
        snapshotBounds.width + renderBufferCanvas * 2,
        snapshotBounds.height + renderBufferCanvas * 2,
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
      // MIGRATION (amnesia-d9f): Use ZoomScaleService for mode decisions, replacing ScaleStateManager.
      const inTiledMode = this.zoomScaleService.getRenderMode() === 'tiled' && this.useTiledRendering;

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

        // amnesia-aqv Phase 1D: Cancel tiles that are now completely off-viewport.
        // This frees permits for tiles the user can actually see.
        // Only triggers when queue is saturated (>75% full).
        if (this.renderCoordinator && inTiledMode) {
          this.renderCoordinator.cancelOffViewportTiles(
            snapshotBounds,
            this.pageLayouts,
            snapshot.camera.z
          );
          
          // amnesia-aqv Phase 1E: Process retry queue during scroll gestures.
          // This helps fill in gaps from dropped tiles while actively panning.
          // Uses smaller batch size (3) and relaxed saturation threshold (0.8).
          // Fire-and-forget to avoid blocking render queue.
          this.renderCoordinator.processRetryQueue(snapshotBounds, true).catch(() => {
            // Ignore errors - best effort retry during scroll
          });
          
          // amnesia-aqv Phase 2B+2C: Spatial-aware eviction with viewport prediction.
          // When cache is >70% full at high zoom, proactively evict tiles that are
          // moving away from the predicted scroll direction. This combines spatial
          // proximity with momentum-based prediction to keep cache primed for the
          // direction the user is scrolling.
          if (tileScale >= 16) {
            const cacheStats = getTileCacheManager().getStats();
            const cacheUtilization = cacheStats.l2Count / 360; // L2 max = 360
            if (cacheUtilization > 0.7) {
              // Phase 2C: Use predicted viewport (200ms ahead) for smarter eviction
              // Convert velocity from canvas units to pixels/second
              const scrollStrategy = getScrollStrategy();
              const velocity = {
                x: this.velocity.x * 60, // ~60fps tracking
                y: this.velocity.y * 60,
              };
              
              // Predict where viewport will be in 200ms
              const predictedBounds = scrollStrategy.getPredictedViewport(
                snapshotBounds,
                velocity,
                200 // 200ms ahead
              );
              
              // Find predicted center page from page layouts
              const predictedCenterPage = scrollStrategy.getPredictedCenterPage(
                snapshotBounds,
                velocity,
                Array.from(this.pageLayouts.values()),
                200
              ) ?? (Math.min(...this.visiblePages) || 1);
              
              // Calculate focal tile from PREDICTED viewport center
              const predictedCenterX = predictedBounds.x + predictedBounds.width / 2;
              const predictedCenterY = predictedBounds.y + predictedBounds.height / 2;
              const pageLayout = this.pageLayouts.get(predictedCenterPage);
              
              let focalTile: { tileX: number; tileY: number } | null = null;
              if (pageLayout) {
                // Convert predicted center to tile indices
                const tileSize = 128; // CSS tile size at high zoom
                const relX = predictedCenterX - pageLayout.x;
                const relY = predictedCenterY - pageLayout.y;
                focalTile = {
                  tileX: Math.floor(relX / tileSize),
                  tileY: Math.floor(relY / tileSize),
                };
              }
              
              // Evict ~15% of cache, prioritizing tiles moving away from prediction
              const evictTarget = Math.floor(cacheStats.l2Count * 0.15);
              getTileCacheManager().evictByDistanceAndRecency(predictedCenterPage, focalTile, evictTarget);
            }
          }
        }

        // Mark pages as needing re-render
        for (const page of pagesToRerender) {
          const element = this.pageElements.get(page);
          if (element) {
            element.clearRendered();
          }
        }

        // TRACE: Log which pages are being queued from snapshot calculation
        console.warn(`[SCROLL-QUEUE-PAGES] pages=${pagesToRerender.join(',')}, snapshotBounds.y=${snapshotBounds.y.toFixed(1)}, currentCamera.y=${this.camera.y.toFixed(1)}, currentViewport.y=${(-this.camera.y).toFixed(1)}`);

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
    
    // amnesia-x6q Phase 3: Track pan gesture for quality preservation
    this.zoomScaleService.setActiveGestureType('pan');
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

    // amnesia-x6q Phase 3: Clear pan gesture type
    this.zoomScaleService.setActiveGestureType('none');

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

  private handleGestureStart(e: Event & { scale?: number; clientX?: number; clientY?: number }): void {
    e.preventDefault();
    this.stopInertia();
    this.gestureStartZoom = this.camera.z;
    
    // FIX (amnesia-d9f): Signal gesture start to ZoomScaleService BEFORE gesturechange fires.
    // This prevents the first gesturechange event from being filtered by rebound detection,
    // which checks if gesturePhase !== 'active'. Without this, starting a new zoom gesture
    // shortly after hitting max zoom would filter the first event.
    this.zoomScaleService.signalOngoingActivity();
    
    console.warn(`[GESTURE-START-DEBUG] gestureStartZoom=${this.gestureStartZoom.toFixed(2)}, gesturePhase=${this.zoomScaleService.getGesturePhase()}`);
    
    // amnesia-aqv Phase 3+: Start focal-point predictive prefetch
    // Get focal point from gesture event or fall back to viewport center
    const rect = this.viewport.getBoundingClientRect();
    const focalPoint: Point = {
      x: (e.clientX ?? rect.width / 2) - rect.left,
      y: (e.clientY ?? rect.height / 2) - rect.top,
    };
    
    // Assume zooming in (most common case) - prefetch will filter if not needed
    this.prefetchFocalPointTiles(focalPoint, this.camera.z, true);
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
    const isZoomOut = delta > 0;
    const isZoomIn = delta < 0;

    // DEBUG (amnesia-d9f): Log Safari gesture events to trace the "hard stop" issue
    console.warn(`[SAFARI-GESTURE-DEBUG] gestureScale=${e.scale.toFixed(3)}, gestureStartZoom=${this.gestureStartZoom.toFixed(2)}, targetZoom=${targetZoom.toFixed(2)}, currentZoom=${this.camera.z.toFixed(2)}, delta=${delta.toFixed(4)}`);

    // FIX (amnesia-7bg): Add rebound detection for Safari gesture events
    // Same logic as handleWheel() - filter rebound events to prevent focal point drift
    // MIGRATION (amnesia-d9f): Using ZoomScaleService for rebound detection
    const reboundOut = this.zoomScaleService.isReboundZoomOut(600);
    const reboundIn = this.zoomScaleService.isReboundZoomIn(600);
    const gesturePhase = this.zoomScaleService.getGesturePhase();
    
    // DEBUG (amnesia-d9f): Log rebound check details
    if (isZoomOut || isZoomIn) {
      console.warn(`[REBOUND-CHECK-DEBUG] isZoomOut=${isZoomOut}, isZoomIn=${isZoomIn}, reboundOut=${reboundOut}, reboundIn=${reboundIn}, gesturePhase=${gesturePhase}`);
    }
    
    if (isZoomOut && reboundOut) {
      console.warn('[PdfInfiniteCanvas] Safari: Filtered rebound zoom-out gesture (was at maxZoom)');
      this.zoomScaleService.signalOngoingActivity();
      getTelemetry().trackReboundFilter('zoom-out', 0, true, false, true);
      return;
    }

    if (isZoomIn && reboundIn) {
      console.warn('[PdfInfiniteCanvas] Safari: Filtered rebound zoom-in gesture (was at minZoom)');
      this.zoomScaleService.signalOngoingActivity();
      getTelemetry().trackReboundFilter('zoom-in', 0, false, true, true);
      return;
    }

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

      // REBOUND DETECTION (amnesia-5so): Filter spurious zoom events from trackpad inertia.
      // After hitting max zoom, trackpads send "rebound" zoom-out events that cause drift.
      // We detect this by checking if we're in the rebound window after a gesture ended
      // at a zoom boundary, and filter out opposing zoom events.
      const delta = e.deltaY * 0.012;
      const isZoomIn = delta < 0;
      const isZoomOut = delta > 0;

      // DEBUG (amnesia-d9f): Log ALL zoom events to trace the "hard stop" issue
      console.warn(`[WHEEL-ZOOM-DEBUG] deltaY=${e.deltaY.toFixed(2)}, delta=${delta.toFixed(4)}, isZoomIn=${isZoomIn}, isZoomOut=${isZoomOut}, camera.z=${this.camera.z.toFixed(2)}, ctrlKey=${e.ctrlKey}`);

      // MIGRATION (amnesia-d9f): Using ZoomScaleService for rebound detection
      if (isZoomOut && this.zoomScaleService.isReboundZoomOut(600)) {
        // Rebound zoom-out after hitting max zoom - ignore to prevent drift
        console.warn('[PdfInfiniteCanvas] Filtered rebound zoom-out event (was at maxZoom)');
        this.zoomScaleService.signalOngoingActivity();
        getTelemetry().trackReboundFilter('zoom-out', 0, true, false, true);
        return;
      }

      if (isZoomIn && this.zoomScaleService.isReboundZoomIn(600)) {
        // Rebound zoom-in after hitting min zoom - ignore to prevent drift
        console.warn('[PdfInfiniteCanvas] Filtered rebound zoom-in event (was at minZoom)');
        this.zoomScaleService.signalOngoingActivity();
        getTelemetry().trackReboundFilter('zoom-in', 0, false, true, true);
        return;
      }

      // ZOOM SENSITIVITY: 0.012 gives ~12 wheel events from 1x to 16x
      // Formula: newZoom = oldZoom * (1 - delta), delta = deltaY * 0.012
      // At deltaY=-50: delta=-0.6, factor=1.6, so 1.6^7 ≈ 26 (reaches 16x in ~6-7 events)
      // This balances responsiveness with controllability.
      // Previous: 0.04 was too aggressive (3 events to max), 0.01 was too slow (14 events)
      this.zoomAtPoint(point, delta);
      
      // amnesia-aqv Phase 3+: Trigger focal-point predictive prefetch on zoom-in
      // Only trigger occasionally to avoid flooding the queue
      if (isZoomIn && this.camera.z >= 4 && Math.random() < 0.1) {
        this.prefetchFocalPointTiles(point, this.camera.z, true);
      }
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
      
      // NAVIGATION RECOVERY: Check for blank visible pages after interaction ends.
      // This catches cases where Chromium evicted GPU textures but our isRendered
      // flag is still true. Schedule after a short delay to let renders settle.
      setTimeout(() => this.recoverBlankPages(), 200);
    }, this.THUMBNAIL_SUSPENSION_RESUME_DELAY);
  }

  /**
   * NAVIGATION RECOVERY: Detect and recover blank visible pages.
   * 
   * Chromium's tile manager may evict GPU textures when memory is pressured
   * (e.g., during high-zoom pan). Our JavaScript isRendered flag doesn't know
   * about this eviction. This method:
   * 1. Checks each visible page for actual content
   * 2. Forces re-render if canvas appears blank despite isRendered=true
   * 
   * Called after interaction ends and periodically during idle.
   */
  private recoverBlankPages(): void {
    // Don't recover during active gestures
    if (!this.zoomScaleService.canRender()) return;
    
    const blankPages: number[] = [];
    
    for (const page of this.visiblePages) {
      const element = this.pageElements.get(page);
      if (!element) continue;
      
      // Check if page claims to be rendered but has no actual content
      // hasRenderedContent() checks both isRendered AND canvas dimensions
      const claimsRendered = element.getIsRendered();
      const hasContent = element.hasRenderedContent();
      
      if (claimsRendered && !hasContent) {
        blankPages.push(page);
        element.clearRendered();
        console.log(`[BLANK-RECOVERY] Page ${page} appears blank despite isRendered=true - forcing re-render`);
      }
    }
    
    if (blankPages.length > 0) {
      // Force immediate re-render of blank pages
      this.queueRenderWithPriority(blankPages, blankPages, true);
    }
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
    // GESTURE ACTIVITY FIX: ALWAYS signal activity first - at the START of every zoom event.
    // This prevents premature gesture-end timer expiration during rapid zoom gestures.
    //
    // Previously, signalOngoingActivity() was only called in the else branch (when zoom
    // doesn't change, e.g., at max zoom limit). However, if gesture events come in bursts
    // with >150ms gaps while zooming, the timer could fire mid-gesture.
    //
    // By signaling at the START, every gesture event resets the timer, ensuring:
    // - Continuous pinch gestures are tracked as single gestures
    // - Timer only fires after actual gesture end (no events for 150ms)
    // MIGRATION (amnesia-d9f): Using ZoomScaleService
    this.zoomScaleService.signalOngoingActivity();

    // FOCAL POINT FIX: Track the focal point for ZoomTransformLayer
    // This ensures the zoom origin is consistent throughout the render pipeline,
    // preventing focus drift when ZoomTransformLayer calculates its transforms.
    this.lastZoomFocalPoint = point;

    // SCALE STATE MANAGER: Set focal point for radial tile priority (Phase 6)
    // Tiles closer to focal point get higher priority during zoom gestures.
    // COORDINATE FIX: Convert viewport coordinates to canvas coordinates.
    // The focal point from gesture handlers is in viewport-relative coords,
    // but tile positions in getTileScale/getTilePriority are in canvas coords.
    const canvasFocalPoint: Point = {
      x: point.x + this.camera.x,
      y: point.y + this.camera.y,
    };
    // amnesia-aqv: Use ZoomScaleService for focal point tracking
    this.zoomScaleService.setFocalPoint(canvasFocalPoint, 'zoom');

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

    // DEBUG (amnesia-d9f): Log zoom constraints to diagnose "hard stop" issue
    const rawNewZoom = this.camera.z * (1 - delta);
    const clampedZoom = Math.min(Math.max(rawNewZoom, minZoom), maxZoom);
    const wasClamped = Math.abs(rawNewZoom - clampedZoom) > 0.001;
    if (wasClamped || this.camera.z > 4) {
      console.warn(`[ZOOM-CONSTRAINT-DEBUG] oldZoom=${this.camera.z.toFixed(2)}, delta=${delta.toFixed(4)}, rawNewZoom=${rawNewZoom.toFixed(2)}, constraints=[${minZoom.toFixed(2)}, ${maxZoom.toFixed(2)}], clamped=${wasClamped}`);
    }

    this.camera = zoomCameraToPoint(this.camera, point, delta, constraints);

      // amnesia-aqv: ZoomScaleService is now the single source of truth for zoom state.
      // This replaces both zoomStateManager and zoomStateMachine.
      this.zoomScaleService.onZoomGesture(this.camera.z, point, this.camera);

    if (this.camera.z !== oldZoom) {
      // amnesia-rwe: Clear stale tile queue on major zoom changes (>2x ratio).
      // Without this, zooming from 1x → 32x floods the queue with 300+ stale tiles
      // from intermediate scales, causing critical high-res tiles to wait 100+ seconds.
      const zoomChangeRatio = Math.max(this.camera.z / oldZoom, oldZoom / this.camera.z);
      if (zoomChangeRatio > 2 && this.renderCoordinator) {
        console.log(`[amnesia-rwe] Major zoom change in zoomAtPoint: ${oldZoom.toFixed(2)} → ${this.camera.z.toFixed(2)} (${zoomChangeRatio.toFixed(1)}x ratio), clearing tile queue`);
        this.renderCoordinator.abortAllPending();
      }

      // STALE SNAPSHOT FIX (2026-01-22): Clear scrollRenderSnapshot when zoom changes.
      // The scroll snapshot captures camera position at scroll time, but during zoom
      // the camera.y changes dramatically (focal point preservation). If we don't clear
      // the snapshot, render calculations use stale camera positions causing NO OVERLAP
      // errors where viewport y-coordinate is completely wrong for the current zoom level.
      if (this.scrollRenderSnapshot) {
        console.log('[ZOOM-SNAPSHOT-CLEAR] Clearing stale scrollRenderSnapshot due to zoom change');
        this.scrollRenderSnapshot = null;
      }
      if (this.scrollRerenderTimeout) {
        clearTimeout(this.scrollRerenderTimeout);
        this.scrollRerenderTimeout = null;
      }

      // Track zoom change for telemetry
      getTelemetry().trackZoomChange(oldZoom, this.camera.z);

      // amnesia-e4i FIX: Update render coordinator's zoom for policy decisions.
      // Without this, maxTilesPerPage stays at 300 even at 32x zoom where it should be 150.
      this.renderCoordinator?.setCurrentZoom(this.camera.z);

      // FOCAL POINT PRESERVATION + SOFT CONSTRAINTS (amnesia-u9l):
      // During gesture: apply SOFT constraints (rubber-band effect allows overscroll)
      // After gesture: apply HARD constraints (snap back to valid bounds)
      //
      // The zoomCameraToPoint() function calculates a camera position that preserves
      // the focal point (cursor/pinch center stays at same content position).
      // Soft constraints allow slight overscroll during gesture for natural feel,
      // then the gesture-end handler will apply hard constraints to snap back.
      const isGestureActive = this.zoomScaleService.isGestureActive();
      this.constrainCameraPositionPreservingFocalPoint(/* soft */ isGestureActive);

      // ZOOM SCALE SERVICE: Already notified via onZoomGesture() above.
      // The service handles:
      // - Block all render paths via canRender()
      // - Epoch increment on zoom change
      // - Gesture timing (300ms inactivity detection)
      // - Settling period before final render
      //
      // DRIFT FIX (amnesia-3of): Epoch increments on EVERY zoom change.
      // This invalidates in-flight tiles rendered at old zoom levels.
      console.log(`[PdfInfiniteCanvas] Zoom change: epoch=${this.zoomScaleService.getEpoch()}, zoom=${this.camera.z.toFixed(3)}`);

      // Log gesture state for debugging
      const currentPhase = this.zoomScaleService.getGesturePhase();

      // MODE TRANSITION FIX with HYSTERESIS: executeModeTransition() increments epoch when zoom crosses threshold.
      // MODE TRANSITION (amnesia-wbp consolidated): Use ScaleStateManager for mode decisions.
      // ScaleStateManager provides:
      // - Hysteresis (10% multiplicative to prevent flapping at threshold)
      // - Gesture awareness (committedRenderMode during active gesture = stable, no mid-gesture transitions)
      // - MAX_TILED_ZOOM upper bound (64x)
      //
      // During active gesture, getEffectiveRenderMode() returns committedRenderMode,
      // so checkAndExecuteModeTransition() won't trigger transitions mid-gesture.
      // This achieves the same deferred behavior as the old pendingModeTransition pattern.
      if (!isGestureActive) {
        this.checkAndExecuteModeTransition();
      }

      // amnesia-aqv: ZoomScaleService.onZoomGesture() is already called above.
      // Render abort is handled by ZoomScaleService via canRender() guards and epoch validation.

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

      // ═══════════════════════════════════════════════════════════════════════════
      // POSITION TRACKING DIAGNOSTIC (2026-01-22): Verify focal point preservation
      // Track screen position of a reference canvas point to detect drift
      // ═══════════════════════════════════════════════════════════════════════════
      const visiblePageNums = Array.from(this.visiblePages);
      if (visiblePageNums.length > 0) {
        const refPage = visiblePageNums[Math.floor(visiblePageNums.length / 2)]; // Middle visible page
        const refLayout = this.pageLayouts.get(refPage);
        const refElement = this.pageElements.get(refPage);

        if (refLayout && refElement) {
          // Reference point: center of the page in canvas coordinates
          const refCanvasX = refLayout.x + refLayout.width / 2;
          const refCanvasY = refLayout.y + refLayout.height / 2;

          // Calculate expected screen position using camera math
          const expectedScreenX = (refCanvasX + this.camera.x) * this.camera.z;
          const expectedScreenY = (refCanvasY + this.camera.y) * this.camera.z;

          // Get actual DOM position of page element center
          const pageElem = refElement.getElement();
          const pageRect = pageElem.getBoundingClientRect();
          const viewportRect = this.viewport.getBoundingClientRect();
          const actualScreenX = pageRect.left + pageRect.width / 2 - viewportRect.left;
          const actualScreenY = pageRect.top + pageRect.height / 2 - viewportRect.top;

          // Calculate position error
          const errorX = actualScreenX - expectedScreenX;
          const errorY = actualScreenY - expectedScreenY;
          const errorMagnitude = Math.hypot(errorX, errorY);

          // Log significant errors (> 5 screen pixels)
          if (errorMagnitude > 5) {
            console.error(`[POSITION-DRIFT] page=${refPage} zoom=${this.camera.z.toFixed(2)}: ` +
              `expected=(${expectedScreenX.toFixed(1)}, ${expectedScreenY.toFixed(1)}), ` +
              `actual=(${actualScreenX.toFixed(1)}, ${actualScreenY.toFixed(1)}), ` +
              `error=(${errorX.toFixed(1)}, ${errorY.toFixed(1)}), magnitude=${errorMagnitude.toFixed(1)}px`);
          }

          // Also track tile canvas position within page element via DOM query
          const tileCanvas = pageElem.querySelector('canvas.pdf-page-canvas') as HTMLCanvasElement | null;
          if (tileCanvas) {
            const tileTransform = tileCanvas.style.transform || 'none';
            const tileCssWidth = parseFloat(tileCanvas.style.width) || 0;
            const tileCssHeight = parseFloat(tileCanvas.style.height) || 0;
            const containerWidth = refLayout.width;
            const containerHeight = refLayout.height;

            // Warn if tile doesn't cover full page (indicates viewport-only rendering)
            const widthCoverage = tileCssWidth / containerWidth;
            const heightCoverage = tileCssHeight / containerHeight;
            if (widthCoverage < 0.95 || heightCoverage < 0.95) {
              console.warn(`[TILE-COVERAGE] page=${refPage}: tile=${tileCssWidth.toFixed(0)}x${tileCssHeight.toFixed(0)} ` +
                `covers ${(widthCoverage*100).toFixed(0)}%x${(heightCoverage*100).toFixed(0)}% of container ` +
                `${containerWidth.toFixed(0)}x${containerHeight.toFixed(0)}, transform="${tileTransform}"`);
            }
          }
        }
      }

      // TILE SHIFTING FIX (2026-01-22): Reset page canvas CSS to full-page mode.
      //
      // In viewport-only tiled mode, each page canvas has a translate(cssOffsetX, cssOffsetY)
      // transform positioning the tile region within the page. When camera zoom changes,
      // this offset becomes stale (calculated for old viewport) and causes tiles to
      // appear "shifted away" from the focal point.
      //
      // FIX: Reset canvas CSS to full-page mode:
      // - Clear the translate offset → canvas starts at (0,0) within page element
      // - Size canvas CSS to fill container → existing buffer stretches to fill
      // - DON'T clear content → stretched pixels are better than blank
      // - Let camera transform handle all positioning via parent scale/translate
      //
      // This produces degraded (stretched) quality during zoom, but tiles are
      // correctly positioned. New tiles render after gesture ends at correct zoom.
      for (const [, element] of this.pageElements) {
        element.resetCssForZoomChange();
      }

      // NOTE: The above replaces the old approach of clearing canvases entirely.
      // Clearing caused pages to DISAPPEAR until new tiles render (50-200ms+).
      // Now we keep old pixels visible (stretched) - degraded but not blank.

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
    // NOTE: Removed else branch that called signalOngoingActivity().
    // Activity is now signaled at the START of zoomAtPoint() unconditionally,
    // which handles both cases (zoom changed and zoom clamped at limit).
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
   * Get current camera state (for stress testing)
   */
  getCamera(): Camera {
    return { ...this.camera };
  }

  /**
   * Get current gesture ID for tile correlation (amnesia-aqv)
   *
   * Used by the render pipeline to tag tile requests with the gesture that
   * initiated them. When tiles arrive, the hybrid guard checks:
   * 1. gestureId match (reject stale tiles from previous gestures)
   * 2. monotonicity within same gesture (scale can only go UP)
   */
  getCurrentGestureId(): string {
    return this.currentGestureId;
  }

  /**
   * Set camera position and zoom (for stress testing)
   */
  setCamera(x: number, y: number, zoom: number): void {
    this.camera = { x, y, z: zoom };
    this.applyTransform();
    this.updateVisiblePages();
  }

  /**
   * Get container element (for stress testing - synthetic events)
   */
  getContainer(): HTMLElement {
    return this.container;
  }

  /**
   * Get diagnostic state for stress testing
   * Returns coverage percentage and CSS stretch factor
   */
  getDiagnosticState(): { coverage: number; cssStretch: number } | null {
    // Coverage: ratio of rendered visible pages to expected visible pages
    // Use a simpler calculation that avoids over/underestimation
    const visibleCount = this.visiblePages.size;
    
    // For stress testing, we care about "are visible pages rendered?"
    // If at least 1 page is expected visible and we have pages rendered, that's good
    // Coverage = 100% means all expected pages are rendered
    const expectedVisible = this.calculateExpectedVisiblePages();
    
    // Cap coverage at 100% - having more visible than expected is fine
    const coverage = expectedVisible > 0 
      ? Math.min(100, (visibleCount / expectedVisible) * 100) 
      : (visibleCount > 0 ? 100 : 0);

    // Calculate CSS stretch from getTargetScaleTier result
    // A value > 1 means tiles are being stretched (blurry)
    const tierResult = getTargetScaleTier(this.camera.z, this.config.pixelRatio);
    const cssStretch = tierResult.cssStretch;

    return { coverage, cssStretch };
  }

  /**
   * Get comprehensive diagnostic state for live testing
   * Captures all relevant state for debugging zoom-out blank issues
   */
  getFullDiagnosticState(): {
    timestamp: number;
    zoom: number;
    camera: { x: number; y: number; z: number };
    phase: string;
    canRender: boolean;
    visiblePages: number[];
    visibleCount: number;
    expectedVisible: number;
    coverage: number;
    cssStretch: number;
    targetScaleTier: number;
    renderMode: string;
    epoch: number;
    renderQueueSize: number;
    priorityQueueSize: number;
    isRendering: boolean;
    l1CacheSize: number;
    l2CacheSize: number;
    pageElements: number;
  } {
    const zss = this.zoomScaleService;
    const phase = zss?.getGesturePhase() ?? 'unknown';
    const canRender = zss?.canRender() ?? false;
    const epoch = zss?.getEpoch() ?? 0;
    const renderMode = zss?.getRenderMode() ?? 'unknown';
    
    const tierResult = getTargetScaleTier(this.camera.z, this.config.pixelRatio);
    const visibleCount = this.visiblePages.size;
    const expectedVisible = this.calculateExpectedVisiblePages();
    const coverage = expectedVisible > 0 
      ? Math.min(100, (visibleCount / expectedVisible) * 100) 
      : (visibleCount > 0 ? 100 : 0);

    // Get cache sizes from local state
    const l1Size = this.pageImageCache.size;
    const l2Size = 0; // Tile cache size not easily accessible

    return {
      timestamp: performance.now(),
      zoom: this.camera.z,
      camera: { ...this.camera },
      phase,
      canRender,
      visiblePages: Array.from(this.visiblePages),
      visibleCount,
      expectedVisible,
      coverage,
      cssStretch: tierResult.cssStretch,
      targetScaleTier: tierResult.tier,
      renderMode,
      epoch,
      renderQueueSize: this.renderQueue.length,
      priorityQueueSize: this.priorityRenderQueue.length,
      isRendering: this.isRendering,
      l1CacheSize: l1Size,
      l2CacheSize: l2Size,
      pageElements: this.pageElements.size,
    };
  }

  /**
   * Get zoom scale service (for stress testing - gesture phase detection)
   */
  getZoomScaleService(): ZoomScaleService | null {
    return this.zoomScaleService ?? null;
  }

  /**
   * Calculate expected number of visible pages (for coverage calculation)
   * Uses the actual visible bounds to determine how many pages should fit.
   */
  private calculateExpectedVisiblePages(): number {
    const viewportRect = this.getViewportRect();
    if (!viewportRect || viewportRect.width === 0 || viewportRect.height === 0) return 0;

    const zoom = this.camera.z;
    const visibleWidth = viewportRect.width / zoom;
    const visibleHeight = viewportRect.height / zoom;

    const { layoutMode, pagesPerRow } = this.config;
    const cellWidth = this.layoutBaseWidth + this.layoutGap;
    const cellHeight = this.layoutBaseHeight + this.layoutGap;

    // Use floor instead of ceil to avoid overestimating
    // A partially visible page at the edge counts as visible
    if (layoutMode === 'vertical') {
      // In vertical mode, count how many pages fit vertically
      const count = Math.floor(visibleHeight / cellHeight) + 1;
      return Math.min(count, this.pageCount);
    } else if (layoutMode === 'horizontal') {
      // In horizontal mode, count how many pages fit horizontally
      const count = Math.floor(visibleWidth / cellWidth) + 1;
      return Math.min(count, this.pageCount);
    } else {
      // Grid layout - count rows and columns that fit
      // Use more conservative estimates to avoid overestimation
      const visibleCols = Math.max(1, Math.floor(visibleWidth / cellWidth) + 1);
      const visibleRows = Math.max(1, Math.floor(visibleHeight / cellHeight) + 1);
      // Cap by actual pages per row and total page count
      const cols = Math.min(visibleCols, pagesPerRow);
      return Math.min(cols * visibleRows, this.pageCount);
    }
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
    // ZERO-VIEWPORT-FIX (2026-01-22): Only update cache with valid dimensions
    const newRect = this.viewport.getBoundingClientRect();
    if (newRect.width > 0 && newRect.height > 0) {
      this.cachedViewportRect = newRect;
      this.cameraConstraints.viewport = {
        width: newRect.width,
        height: newRect.height,
      };
      this.updateVisiblePages();
    } else {
      console.warn(`[PdfInfiniteCanvas] handleResize: Ignoring 0x0 viewport rect`);
    }
  }

  /**
   * Get viewport rect (cached to avoid layout thrashing)
   *
   * ZERO-VIEWPORT-FIX (2026-01-22): If cached rect has 0 dimensions,
   * refresh from DOM. This handles edge cases where the cache was set
   * before the viewport had valid dimensions.
   */
  private getViewportRect(): DOMRect {
    // Always refresh if cache is empty or has invalid dimensions
    if (!this.cachedViewportRect ||
        this.cachedViewportRect.width <= 0 ||
        this.cachedViewportRect.height <= 0) {
      const freshRect = this.viewport.getBoundingClientRect();
      if (freshRect.width > 0 && freshRect.height > 0) {
        this.cachedViewportRect = freshRect;
      }
      // If still invalid, return current cache (may be null) - caller must handle
    }
    return this.cachedViewportRect!;
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
   * Parse CSS transform string to extract scale and translate values
   * Handles: scale(z) translate3d(x, y, 0) format
   */
  private parseTransform(css: string): { x: number; y: number; scale: number } | null {
    // Match scale(z) translate3d(x, y, z) format
    const scaleMatch = css.match(/scale\(([^)]+)\)/);
    const translateMatch = css.match(/translate3d\(([^,]+)px,\s*([^,]+)px/);

    if (!scaleMatch || !translateMatch) {
      return null;
    }

    return {
      scale: parseFloat(scaleMatch[1]),
      x: parseFloat(translateMatch[1]),
      y: parseFloat(translateMatch[2])
    };
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
    // MIGRATION (amnesia-d9f): Use ZoomScaleService for epoch
    this.zoomScaleService.incrementEpoch();

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
    // MIGRATION (amnesia-d9f): Use ZoomScaleService for epoch
    this.zoomScaleService.incrementEpoch();

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

    // amnesia-aqv: ZoomScaleService is destroyed via its own lifecycle management.
    // The old ZoomStateMachine, ZoomStateManager, and ScaleStateManager have been removed.

    // amnesia-x6q: Clear priority function to prevent memory leak
    getTileCacheManager().setPriorityFunction(null);

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

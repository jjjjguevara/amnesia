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
} from './pdf-canvas-camera';
import { SpatialPrefetcher } from './spatial-prefetcher';
import { initializeCanvasPool, getCanvasPool } from './pdf-canvas-pool';
import type { PdfTextLayer as TextLayerData, PdfRenderOptions } from '../types';
import type { TileCoordinate, TileRenderEngine } from './tile-render-engine';
import { getTileEngine, TILE_SIZE } from './tile-render-engine';
import type { RenderCoordinator, RenderMode, RenderPriority } from './render-coordinator';
import { getTelemetry } from './pdf-telemetry';

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

  // Zoom-dependent re-rendering
  private zoomRerenderTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly ZOOM_RERENDER_DEBOUNCE = 150; // ms to wait after zoom stops

  // Scroll-specific re-rendering (much shorter debounce for responsiveness)
  private scrollRerenderTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly SCROLL_RERENDER_DEBOUNCE = 32; // ms - ~2 frames for smooth scroll rendering
  // Camera snapshot for scroll re-rendering - captures camera at schedule time
  // so tile visibility is calculated based on where user was, not where camera moved to
  private scrollRenderCameraSnapshot: Camera | null = null;
  private readonly MIN_EFFECTIVE_RATIO = 2.0; // Minimum buffer pixels per screen pixel (Retina)
  private pendingImageRequests: Map<number, Promise<Blob>> = new Map();

  // Gesture state
  private isPanning = false;
  private lastPointerPosition: Point | null = null;
  private panStartCamera: Camera | null = null;

  // Inertia scrolling state
  private velocity: Point = { x: 0, y: 0 };
  private lastWheelTime = 0;
  private inertiaAnimationFrame: number | null = null;
  private scheduleInertiaTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly INERTIA_DECAY = 0.92; // Velocity multiplier per frame
  private readonly INERTIA_MIN_VELOCITY = 0.5; // Stop when velocity below this
  private readonly INERTIA_START_THRESHOLD = 3; // Only start inertia if velocity exceeds this (fling detection)
  private readonly VELOCITY_SCALE = 0.15; // Scale factor for velocity tracking

  // Cached viewport rect - updated on resize, avoids layout thrashing
  private cachedViewportRect: DOMRect | null = null;
  private pendingVisiblePagesUpdate = false;

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
      console.log('[PdfInfiniteCanvas] Tile rendering enabled');
    }
  }

  /**
   * Initialize with page count
   */
  initialize(pageCount: number): void {
    this.pageCount = pageCount;

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
    this.setupInitialView();
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
        element.setDimensions(layout.width, layout.height);
      }
    }

    // Re-setup view to maintain proper fit
    this.setupInitialView();
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
   */
  private calculatePageLayouts(): void {
    this.pageLayouts.clear();

    const { gap, padding, layoutMode, pagesPerRow } = this.config;

    // Get actual PDF dimensions from tile engine if available (page 1 as reference)
    // This ensures layout matches actual PDF aspect ratio, not hardcoded defaults
    let { pageWidth, pageHeight } = this.config;
    if (this.tileEngine) {
      const dims = this.tileEngine.pageDimensions.get(1);
      if (dims) {
        pageWidth = dims.width;
        pageHeight = dims.height;
        // Update config to keep everything consistent
        this.config.pageWidth = pageWidth;
        this.config.pageHeight = pageHeight;
      }
    }

    // Calculate base page dimensions (at 100% zoom on canvas)
    // Use a reasonable base size that looks good
    const baseWidth = 400; // Canvas units at 100% zoom
    const aspectRatio = pageWidth / pageHeight;
    const baseHeight = baseWidth / aspectRatio;

    // Store layout constants for O(1) visible page calculation
    this.layoutBaseWidth = baseWidth;
    this.layoutBaseHeight = baseHeight;
    this.layoutPadding = padding;
    this.layoutGap = gap;

    let x = padding;
    let y = padding;
    let row = 0;
    let col = 0;
    let maxRowHeight = 0;

    for (let page = 1; page <= this.pageCount; page++) {
      this.pageLayouts.set(page, {
        page,
        x,
        y,
        width: baseWidth,
        height: baseHeight,
      });

      maxRowHeight = Math.max(maxRowHeight, baseHeight);

      if (layoutMode === 'vertical') {
        // Vertical: stack pages vertically
        y += baseHeight + gap;
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
          height: baseHeight + padding * 2,
        };
      } else {
        // Grid
        const numRows = Math.ceil(this.pageCount / pagesPerRow);
        this.canvasBounds = {
          width: pagesPerRow * baseWidth + (pagesPerRow - 1) * gap + padding * 2,
          height: numRows * baseHeight + (numRows - 1) * gap + padding * 2,
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
   */
  private constrainCameraPosition(): void {
    const viewportRect = this.viewport.getBoundingClientRect();
    if (viewportRect.width === 0 || viewportRect.height === 0) return;

    const { z } = this.camera;
    let { x, y } = this.camera;

    const contentWidth = this.canvasBounds.width;
    const contentHeight = this.canvasBounds.height;
    const vpWidth = viewportRect.width;
    const vpHeight = viewportRect.height;

    const contentScreenWidth = contentWidth * z;
    const contentScreenHeight = contentHeight * z;
    const { displayMode } = this.config;

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

    this.camera = { x, y, z };
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
   */
  private applyTransform(): void {
    this.canvas.style.transform = getCameraTransform(this.camera);
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
  private updateVisiblePages(): void {
    const viewportRect = this.viewport.getBoundingClientRect();
    const visibleBounds = getVisibleBounds(
      this.camera,
      viewportRect.width,
      viewportRect.height
    );

    const newVisiblePages = new Set<number>();
    const newRenderPages = new Set<number>();

    // 3-tier buffer system (in canvas units, adjusted for zoom)
    // Increased buffers to reduce blank pages during scroll:
    // - renderBuffer: ~2.5 pages ahead/behind for immediate rendering
    // - elementBuffer: ~5 pages for DOM element readiness
    // - keepBuffer: ~7.5 pages to prevent thrashing during fast scroll
    const renderBuffer = 1200 / this.camera.z;      // Pages to render immediately
    const elementBuffer = 2400 / this.camera.z;     // Pages to have DOM elements ready
    const keepBuffer = 3600 / this.camera.z;        // Pages to retain in DOM

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

    // Use canvas coordinates for prefetch calculation
    const screenRect = this.getViewportRect();
    const canvasViewport = getVisibleBounds(this.camera, screenRect.width, screenRect.height);
    const layouts = Array.from(this.pageLayouts.values());
    const zoom = this.camera.z;

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

    // Position at fixed canvas coordinates
    const el = element.getElement();
    el.style.position = 'absolute';
    el.style.left = `${layout.x}px`;
    el.style.top = `${layout.y}px`;

    // Set fixed dimensions (never change)
    element.setDimensions(layout.width, layout.height);

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
    if (this.isRendering || !hasWork) return;

    this.isRendering = true;
    const currentVersion = ++this.renderVersion;

    // Scale concurrent renders with worker pool (2x workers, capped at 12)
    const pool = getCanvasPool();
    const CONCURRENT_RENDERS = Math.min(pool.workerCount * 2 || 5, 12);
    const activeRenders = new Map<number, Promise<void>>();

    const getNextPage = (): number | null => {
      // Priority queue first (immediate neighbors)
      while (this.priorityRenderQueue.length > 0) {
        const page = this.priorityRenderQueue.shift()!;
        const element = this.pageElements.get(page);
        // Only skip if already rendered, not if just not visible (we want to pre-render)
        if (element && !element.getIsRendered() && !activeRenders.has(page)) {
          return page;
        }
      }

      // Then regular queue
      while (this.renderQueue.length > 0) {
        const page = this.renderQueue.shift()!;
        const element = this.pageElements.get(page);
        if (element && !element.getIsRendered() && !activeRenders.has(page)) {
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

    // Clear scroll camera snapshot after all renders complete
    // This ensures the snapshot is only used for the render batch it was created for
    this.scrollRenderCameraSnapshot = null;
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

    const zoom = this.camera.z;
    const layout = this.pageLayouts.get(page);

    // Tiling decision: use tiles at high zoom for crisp rendering
    // - Tiles can render at scale 32 (zoom 16x * pixelRatio 2) without OOM
    // - Full pages cap at scale 8 to avoid memory issues
    // - Coordinate conversion now properly handles canvas→PDF units
    const shouldTile = this.tileEngine &&
                       this.renderCoordinator &&
                       layout &&
                       zoom > 4.0;

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

    element.showLoading();

    try {
      // Scale: zoom * pixelRatio for crisp rendering
      // Tiles are small (256×256) so can render at high scale without OOM
      // At zoom 16x with pixelRatio 2, scale = 32 for crisp display
      const MAX_TILE_SCALE = 32;
      const tileScale = Math.min(MAX_TILE_SCALE, Math.max(1, Math.ceil(zoom * this.config.pixelRatio)));

      // At high zoom (>4x), only render VISIBLE tiles (viewport-clipped)
      // At lower zoom, render all tiles for the page (for smooth panning)
      let tiles: TileCoordinate[];
      if (zoom > 4.0) {
        // CRITICAL: Use camera snapshot if available (from scroll rerender)
        // This ensures we calculate visibility based on where the user was when scroll
        // rerender was scheduled, not where the camera has moved to during debounce.
        // This fixes the "0 visible tiles" issue during continuous scroll.
        const effectiveCamera = this.scrollRenderCameraSnapshot ?? this.camera;

        // Get viewport in WORLD coordinates (not screen coordinates!)
        const screenRect = this.getViewportRect();
        const viewport = getVisibleBounds(effectiveCamera, screenRect.width, screenRect.height);
        tiles = this.tileEngine!.getVisibleTiles(viewport, [layout], zoom, tileScale);
        const totalTiles = this.tileEngine!.getPageTileGrid(page, tileScale).length;
        console.log(`[PdfInfiniteCanvas] High zoom ${zoom.toFixed(1)}x: rendering ${tiles.length} visible tiles (vs ${totalTiles} total for page)${this.scrollRenderCameraSnapshot ? ' [using camera snapshot]' : ''}`);
      } else {
        // At normal zoom, get all tiles for smooth pan/zoom
        tiles = this.tileEngine!.getPageTileGrid(page, tileScale);
      }

      if (tiles.length === 0) {
        // No tiles calculated - check if page is actually in viewport
        if (zoom > 4.0) {
          // At high zoom, if page doesn't overlap viewport, skip rendering
          // This preserves any existing canvas content from previous renders
          const effectiveCamera = this.scrollRenderCameraSnapshot ?? this.camera;
          const screenRect = this.getViewportRect();
          const viewport = getVisibleBounds(effectiveCamera, screenRect.width, screenRect.height);
          const overlaps = this.rectsOverlap(viewport, layout);
          if (!overlaps) {
            // Page is not visible - keep existing content, don't clear canvas
            element.hideLoading();
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
        })
      );

      const results = await Promise.all(tilePromises);

      if (this.renderVersion !== version) return;

      // Collect successful tile data for rendering
      const tileImages: Array<{ tile: typeof tiles[0]; bitmap: ImageBitmap }> = [];

      for (let i = 0; i < tiles.length; i++) {
        const result = results[i];
        if (result.success && result.data) {
          let bitmap: ImageBitmap;
          if (result.data instanceof ImageBitmap) {
            bitmap = result.data;
          } else {
            // Convert Blob to ImageBitmap
            bitmap = await createImageBitmap(result.data as Blob);
          }
          tileImages.push({ tile: tiles[i], bitmap });
        }
      }

      // Get text layer (non-blocking)
      let textLayerData: TextLayerData | undefined;
      try {
        textLayerData = await this.provider.getPageTextLayer(page);
      } catch {
        // Text layer is optional
      }

      if (this.renderVersion !== version) return;

      // Get PDF native dimensions for coordinate transform
      // Tiles are rendered in PDF coordinate space, but layout may be scaled
      const pdfDimensions = this.tileEngine!.pageDimensions.get(page);

      // Render tiles to element with PDF dimensions for correct positioning
      await element.renderTiles(tileImages, textLayerData, zoom, pdfDimensions);
      element.hideLoading();

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
    const viewport = getVisibleBounds(this.camera, screenRect.width, screenRect.height);
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

        if (this.renderVersion !== version) return;

        // Get text layer (non-blocking)
        let textLayerData: TextLayerData | undefined;
        try {
          textLayerData = await this.provider.getPageTextLayer(page);
        } catch {
          // Text layer is optional
        }

        if (this.renderVersion !== version) return;

        // Display initial (may be thumbnail or full quality)
        await element.render({ imageBlob: result.initial, textLayerData }, zoomAwareScale);
        element.hideLoading();

        // Update local cache with initial
        this.pageImageCache.set(page, result.initial);
        this.pageCacheScales.set(page, result.initialScale);
        this.updateCacheOrder(page);

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
        if (this.renderVersion !== version) return;

        let textLayerData: TextLayerData | undefined;
        try {
          textLayerData = await this.provider.getPageTextLayer(page);
        } catch {
          // Text layer is optional
        }

        if (this.renderVersion !== version) return;

        await element.render({ imageBlob, textLayerData }, zoomAwareScale);
        element.hideLoading();
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
  private getZoomAwareRenderScale(): number {
    const minRequired = (this.camera.z * this.MIN_EFFECTIVE_RATIO) / this.config.pixelRatio;
    return Math.max(this.config.renderScale, minRequired);
  }

  /**
   * Get maximum useful render scale based on display requirements.
   *
   * Balances quality vs memory usage:
   * - 8x scale gives crisp rendering up to zoom 4x with 2x DPR
   * - Higher scales cause memory issues and crashes
   */
  private getMaxUsefulScale(): number {
    const zoom = this.camera.z;
    const pixelRatio = this.config.pixelRatio;

    // Target scale for crisp rendering
    const idealScale = zoom * pixelRatio;

    // Cap at 16x for HiDPI + high zoom scenarios
    // At zoom 8x with pixelRatio 2: idealScale = 16, now achievable
    // This enables sharp full-page rendering matching tile quality
    const MAX_SCALE = 16.0;

    return Math.min(idealScale, MAX_SCALE);
  }

  /**
   * Check if a page needs re-rendering due to zoom level change.
   *
   * A page needs re-rendering if its cached scale would result in
   * less than MIN_EFFECTIVE_RATIO buffer pixels per screen pixel.
   */
  private needsZoomRerender(page: number): boolean {
    const cachedScale = this.pageCacheScales.get(page);
    if (!cachedScale) return true; // Not cached, needs render

    // Calculate effective ratio at current zoom
    const effectiveRatio = cachedScale / this.camera.z;
    return effectiveRatio < this.MIN_EFFECTIVE_RATIO;
  }

  /**
   * Schedule re-rendering of visible pages that need higher resolution.
   *
   * Debounced to avoid excessive re-renders during continuous zoom gestures.
   */
  private scheduleZoomRerender(): void {
    // Clear existing timeout
    if (this.zoomRerenderTimeout) {
      clearTimeout(this.zoomRerenderTimeout);
    }

    this.zoomRerenderTimeout = setTimeout(() => {
      // Find pages that need re-rendering
      const pagesToRerender: number[] = [];
      for (const page of this.visiblePages) {
        if (this.needsZoomRerender(page)) {
          pagesToRerender.push(page);
        }
      }

      if (pagesToRerender.length > 0) {
        console.log(`[PdfInfiniteCanvas] Re-rendering ${pagesToRerender.length} pages for zoom ${this.camera.z.toFixed(2)}`);

        // Mark pages as needing re-render (clear rendered state)
        for (const page of pagesToRerender) {
          const element = this.pageElements.get(page);
          if (element) {
            element.clearRendered();
          }
        }

        // Queue for re-render
        this.queueRender(pagesToRerender);
      }
    }, this.ZOOM_RERENDER_DEBOUNCE);
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

    // CRITICAL: Snapshot camera NOW, not when debounce fires
    // During fast scroll, the camera moves 100s of pixels between schedule and render.
    // If we use the current camera at render time, it may have moved past all page layouts,
    // resulting in "0 visible tiles". By snapshotting at schedule time, we ensure
    // tile visibility is calculated based on where the user actually is.
    this.scrollRenderCameraSnapshot = { ...this.camera };

    this.scrollRerenderTimeout = setTimeout(() => {
      // Find pages that need re-rendering at current zoom
      const pagesToRerender: number[] = [];
      for (const page of this.visiblePages) {
        if (this.needsZoomRerender(page)) {
          pagesToRerender.push(page);
        }
      }

      if (pagesToRerender.length > 0) {
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

    // Fetch from server
    // Note: HybridPdfProvider.renderPage() handles DPI-aware scaling internally
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

    this.camera = panCamera(this.camera, -dx, -dy);

    // Apply position constraints during panning
    this.constrainCameraPosition();

    this.applyTransform();
    this.updateVisiblePages();

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

    if (isZoomGesture) {
      // Zoom gesture (pinch or Cmd+scroll)
      this.stopInertia();
      const delta = e.deltaY * 0.01;
      this.zoomAtPoint(point, delta);
    } else {
      // Pan gesture - direct 1:1 mapping for responsive scrolling
      // The panCamera function handles zoom-adjusted movement
      let deltaX = e.deltaX;
      let deltaY = e.deltaY;

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

      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;

      // Track velocity for adaptive rendering decisions
      const now = performance.now();
      const dt = Math.max(1, now - this.lastWheelTime);
      this.velocity = {
        x: deltaX / dt * 16, // Normalize to ~60fps frame time
        y: deltaY / dt * 16,
      };
      this.lastWheelTime = now;

      // Apply direct pan - panCamera handles zoom-adjusted movement
      this.camera = panCamera(this.camera, deltaX, deltaY);
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

      // Apply velocity
      this.camera = panCamera(this.camera, this.velocity.x, this.velocity.y);
      this.constrainCameraPosition();
      this.applyTransform();
      this.updateVisiblePages();

      // Update page counter during inertia
      this.debouncedPageUpdate();

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
    const oldZoom = this.camera.z;

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

      // Check if we need to relayout (only for auto-grid mode)
      // Pass the focus point so the page under cursor stays stationary
      if (this.shouldRelayout()) {
        this.relayoutPages(point);
      }

      // Apply position constraints
      this.constrainCameraPosition();

      this.applyTransform();
      this.updateVisiblePages();

      // Schedule re-render if zoom increased beyond cached resolution
      this.scheduleZoomRerender();

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
  }

  /**
   * Destroy canvas
   */
  destroy(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }

    // Stop inertia animation
    this.stopInertia();

    // Clear zoom re-render timeout
    if (this.zoomRerenderTimeout) {
      clearTimeout(this.zoomRerenderTimeout);
      this.zoomRerenderTimeout = null;
    }

    // Clear scroll re-render timeout and camera snapshot
    if (this.scrollRerenderTimeout) {
      clearTimeout(this.scrollRerenderTimeout);
      this.scrollRerenderTimeout = null;
    }
    this.scrollRenderCameraSnapshot = null;

    for (const element of this.pageElements.values()) {
      element.destroy();
    }
    this.pageElements.clear();
    this.clearCache();
    this.viewport.remove();
  }
}

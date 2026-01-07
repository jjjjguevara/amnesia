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
import type { PdfTextLayer as TextLayerData, PdfRenderOptions } from '../types';

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
}

const DEFAULT_CONFIG: InfiniteCanvasConfig = {
  displayMode: 'auto-grid',
  gap: 16,
  padding: 24,
  minZoom: 0.1,
  maxZoom: 10,
  pageWidth: 612,
  pageHeight: 792,
  renderScale: 1.5,
  pixelRatio: window.devicePixelRatio ?? 1,
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

  // Rendering
  private visiblePages: Set<number> = new Set();
  private renderQueue: number[] = [];
  private isRendering = false;
  private renderVersion = 0;

  // Image cache
  private readonly PAGE_CACHE_SIZE = 100;
  private pageImageCache: Map<number, Blob> = new Map();
  private pageCacheScales: Map<number, number> = new Map();
  private cacheOrder: number[] = [];
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

  // Animation
  private animationFrame: number | null = null;

  // Callbacks
  private onPageChangeCallback?: (page: number) => void;
  private onZoomChangeCallback?: (zoom: number) => void;
  private onSelectionCallback?: (page: number, text: string, rects: DOMRect[]) => void;
  private onHighlightClickCallback?: (annotationId: string, position: { x: number; y: number }) => void;

  // Spatial prefetcher for grid-based modes (auto-grid, canvas)
  private spatialPrefetcher = new SpatialPrefetcher();

  constructor(
    container: HTMLElement,
    provider: PageDataProvider,
    config: Partial<InfiniteCanvasConfig> = {}
  ) {
    this.container = container;
    this.provider = provider;
    this.config = { ...DEFAULT_CONFIG, ...config };

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
      user-select: none;
      -webkit-user-select: none;
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

    const { gap, padding, pageWidth, pageHeight } = this.config;
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

    const { gap, padding, pageWidth, pageHeight, layoutMode, pagesPerRow } = this.config;

    // Calculate base page dimensions (at 100% zoom on canvas)
    // Use a reasonable base size that looks good
    const baseWidth = 400; // Canvas units at 100% zoom
    const aspectRatio = pageWidth / pageHeight;
    const baseHeight = baseWidth / aspectRatio;

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
      case 'paginated':
        // No zoom allowed in paginated mode
        minZoom = this.camera.z;
        maxZoom = this.camera.z;
        break;

      case 'horizontal-scroll':
        // Min zoom = fit page height, unlimited zoom in
        const availableHeight = viewportRect.height - padding * 2;
        minZoom = Math.max(this.config.minZoom, availableHeight / layout.height);
        break;

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
   */
  private updateVisiblePages(): void {
    const viewportRect = this.viewport.getBoundingClientRect();
    const visibleBounds = getVisibleBounds(
      this.camera,
      viewportRect.width,
      viewportRect.height
    );

    const newVisiblePages = new Set<number>();
    const buffer = 200 / this.camera.z; // Buffer in canvas units

    for (const [page, layout] of this.pageLayouts) {
      // Check if page intersects visible bounds (with buffer)
      const isVisible =
        layout.x + layout.width > visibleBounds.x - buffer &&
        layout.x < visibleBounds.x + visibleBounds.width + buffer &&
        layout.y + layout.height > visibleBounds.y - buffer &&
        layout.y < visibleBounds.y + visibleBounds.height + buffer;

      if (isVisible) {
        newVisiblePages.add(page);
      }
    }

    // Create elements for newly visible pages
    for (const page of newVisiblePages) {
      if (!this.pageElements.has(page)) {
        this.createPageElement(page);
      }
    }

    // Remove elements for pages no longer visible (with larger buffer to prevent thrashing)
    const keepBuffer = 500 / this.camera.z;
    for (const [page, element] of this.pageElements) {
      const layout = this.pageLayouts.get(page);
      if (!layout) continue;

      const shouldKeep =
        layout.x + layout.width > visibleBounds.x - keepBuffer &&
        layout.x < visibleBounds.x + visibleBounds.width + keepBuffer &&
        layout.y + layout.height > visibleBounds.y - keepBuffer &&
        layout.y < visibleBounds.y + visibleBounds.height + keepBuffer;

      if (!shouldKeep) {
        element.destroy();
        this.pageElements.delete(page);
      }
    }

    this.visiblePages = newVisiblePages;

    // Queue visible pages for rendering
    this.queueRender([...newVisiblePages]);

    // Prefetch pages based on display mode:
    // - Spatial modes (auto-grid, canvas): 2D ripple prefetch based on grid distance
    // - Linear modes (paginated, vertical-scroll, horizontal-scroll): page ± N prefetch
    if (newVisiblePages.size > 0) {
      const centerPage = this.getCurrentPage();
      this.triggerPrefetch(centerPage);
    }
  }

  /**
   * Trigger prefetch based on current display mode
   * - Spatial modes use 2D ripple prefetch (SpatialPrefetcher)
   * - Linear modes use linear page ± N prefetch (via notifyPageChange)
   */
  private triggerPrefetch(centerPage: number): void {
    const isSpatialMode =
      this.config.displayMode === 'auto-grid' ||
      this.config.displayMode === 'canvas';

    if (isSpatialMode && this.provider.prefetchPages) {
      // SPATIAL: Ripple prefetch based on grid position
      const spatialPages = this.spatialPrefetcher.getSpatialPrefetchList({
        centerPage,
        radius: 3,
        columns: this.currentColumns,
        pageCount: this.pageCount,
      });

      // Filter out already-visible pages (they're already loading/loaded)
      const pagesToPrefetch = spatialPages.filter((p: number) => !this.visiblePages.has(p));

      if (pagesToPrefetch.length > 0) {
        // Background prefetch - don't await, let it run async
        this.provider.prefetchPages(pagesToPrefetch).catch(err => {
          console.warn('[PdfInfiniteCanvas] Spatial prefetch failed:', err);
        });
      }
    } else if (this.provider.notifyPageChange) {
      // LINEAR: Standard page ± N prefetch via provider
      this.provider.notifyPageChange(centerPage);
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
   * Queue pages for rendering
   */
  private queueRender(pages: number[]): void {
    // Sort by distance from viewport center
    const viewportRect = this.viewport.getBoundingClientRect();
    const centerX = viewportRect.width / 2;
    const centerY = viewportRect.height / 2;

    const sorted = pages.sort((a, b) => {
      const layoutA = this.pageLayouts.get(a)!;
      const layoutB = this.pageLayouts.get(b)!;

      // Convert page centers to screen coordinates
      const pageACenterX = (layoutA.x + layoutA.width / 2 + this.camera.x) * this.camera.z;
      const pageACenterY = (layoutA.y + layoutA.height / 2 + this.camera.y) * this.camera.z;
      const pageBCenterX = (layoutB.x + layoutB.width / 2 + this.camera.x) * this.camera.z;
      const pageBCenterY = (layoutB.y + layoutB.height / 2 + this.camera.y) * this.camera.z;

      const distA = Math.hypot(pageACenterX - centerX, pageACenterY - centerY);
      const distB = Math.hypot(pageBCenterX - centerX, pageBCenterY - centerY);

      return distA - distB;
    });

    // Add to queue, avoiding duplicates
    for (const page of sorted) {
      if (!this.renderQueue.includes(page)) {
        this.renderQueue.push(page);
      }
    }

    this.processRenderQueue();
  }

  /**
   * Process render queue
   */
  private async processRenderQueue(): Promise<void> {
    if (this.isRendering || this.renderQueue.length === 0) return;

    this.isRendering = true;
    const currentVersion = ++this.renderVersion;

    while (this.renderQueue.length > 0 && this.renderVersion === currentVersion) {
      const page = this.renderQueue.shift()!;

      // Skip if page no longer visible
      if (!this.visiblePages.has(page)) continue;

      const element = this.pageElements.get(page);
      if (!element || element.getIsRendered()) continue;

      await this.renderPage(page, element, currentVersion);
    }

    this.isRendering = false;
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

    element.showLoading();

    try {
      // Use dual-resolution if provider supports it (preferred path)
      if (this.provider.getPageImageDualRes) {
        const result = await this.provider.getPageImageDualRes(page, {
          scale: this.config.renderScale * this.config.pixelRatio,
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
        await element.render({ imageBlob: result.initial, textLayerData }, this.config.renderScale);
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
            await element.render({ imageBlob: fullBlob, textLayerData }, this.config.renderScale);

            // Update cache with full quality
            this.pageImageCache.set(page, fullBlob);
            this.pageCacheScales.set(page, this.config.renderScale * this.config.pixelRatio);
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

        await element.render({ imageBlob, textLayerData }, this.config.renderScale);
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
    const targetScale = this.config.renderScale * this.config.pixelRatio;

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

    this.lastPointerPosition = { x: e.clientX, y: e.clientY };
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.isPanning) return;

    this.isPanning = false;
    this.lastPointerPosition = null;
    this.panStartCamera = null;
    this.viewport.releasePointerCapture(e.pointerId);
    this.viewport.style.cursor = '';

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

    const rect = this.viewport.getBoundingClientRect();
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

      // Apply direct pan - panCamera handles zoom-adjusted movement
      this.camera = panCamera(this.camera, deltaX, deltaY);
      this.constrainCameraPosition();
      this.applyTransform();
      this.updateVisiblePages();
    }
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

    const animate = () => {
      // Apply velocity
      this.camera = panCamera(this.camera, this.velocity.x, this.velocity.y);
      this.constrainCameraPosition();
      this.applyTransform();
      this.updateVisiblePages();

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
      // Check if we need to relayout (only for auto-grid mode)
      // Pass the focus point so the page under cursor stays stationary
      if (this.shouldRelayout()) {
        this.relayoutPages(point);
      }

      // Apply position constraints
      this.constrainCameraPosition();

      this.applyTransform();
      this.updateVisiblePages();
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
   */
  getCurrentPage(): number {
    const viewportRect = this.viewport.getBoundingClientRect();
    const centerX = viewportRect.width / 2;
    const centerY = viewportRect.height / 2;

    let closestPage = 1;
    let closestDistance = Infinity;

    for (const [page, layout] of this.pageLayouts) {
      const pageCenterX = (layout.x + layout.width / 2 + this.camera.x) * this.camera.z;
      const pageCenterY = (layout.y + layout.height / 2 + this.camera.y) * this.camera.z;
      const distance = Math.hypot(pageCenterX - centerX, pageCenterY - centerY);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestPage = page;
      }
    }

    return closestPage;
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
    const viewportRect = this.viewport.getBoundingClientRect();
    this.cameraConstraints.viewport = {
      width: viewportRect.width,
      height: viewportRect.height,
    };
    this.updateVisiblePages();
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

    for (const element of this.pageElements.values()) {
      element.destroy();
    }
    this.pageElements.clear();
    this.clearCache();
    this.viewport.remove();
  }
}

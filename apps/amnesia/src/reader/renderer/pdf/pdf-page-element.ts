/**
 * PDF Page Element
 *
 * Self-contained element for rendering a single PDF page.
 * Includes canvas layer, text layer, and annotation layer.
 * Multiple instances can be created for multi-page display.
 */

import type { PdfTextLayer as TextLayerData, PdfTextLayerData } from '../types';
import type { HighlightColor } from '../types';
import { extractAsMarkdown, extractAsPlainText, prepareCopyData } from './smart-copy';
import { DarkModeRenderer } from './dark-mode-renderer';
import { MobileReflowRenderer, type ReflowConfig } from './mobile-reflow';
import { PdfSvgTextLayer, type SvgTextLayerConfig } from './pdf-svg-text-layer';
import { getCanvasPool } from './pdf-canvas-pool';
import { getTelemetry } from './pdf-telemetry';
import { TILE_SIZE, getTileSize, type TileCoordinate } from './tile-render-engine';
import { getTargetScaleTier, getExactTargetScale } from './progressive-tile-renderer';
import { isFeatureEnabled } from './feature-flags';
import { getCoordinateDebugger } from './coordinate-debugger';
import { getTileCacheManager, validateTileBatchCompliance } from './tile-cache-manager';
import { getScaleStateManager } from './scale-state-manager';
import { getTileDiagnosticOverlay } from './tile-diagnostic-overlay';

export type ReadingMode = 'device' | 'light' | 'sepia' | 'dark' | 'night';
export type RenderMode = 'page' | 'reflow';

export interface PageRenderData {
  imageBlob: Blob;
  textLayerData?: TextLayerData;
}

export interface PdfPageElementConfig {
  /** Page number (1-indexed) */
  pageNumber: number;
  /** Pixel ratio for HiDPI */
  pixelRatio?: number;
  /** Maximum zoom level used to cap scale tier */
  maxZoom?: number;
  /** Enable text layer anti-aliasing */
  enableTextAntialiasing?: boolean;
  /** Enable image smoothing */
  enableImageSmoothing?: boolean;
  /** Use SVG text layer for vector-crisp text at any zoom (default: true) */
  useSvgTextLayer?: boolean;
  /** Debug mode for SVG text layer (makes text visible) */
  debugTextLayer?: boolean;
  /**
   * Native PDF page dimensions in points (e.g., 612×792 for letter).
   * Used as fallback for tile coordinate calculations when pdfDimensions
   * is not provided to renderTiles(). This prevents coordinate system
   * mismatch when CSS pixel dimensions are used by mistake.
   */
  pdfDimensions?: { width: number; height: number };
}

export interface PageHighlight {
  id: string;
  annotationId: string;
  color: HighlightColor;
  rects: Array<{ x: number; y: number; width: number; height: number }>;
}

/**
 * Transform snapshot for consistent tile positioning.
 * 
 * Problem: During tile rendering, container dimensions can change mid-render
 * (due to zoom gestures completing). This causes CSS positioning calculations
 * to use CURRENT dimensions instead of dimensions at tile REQUEST time,
 * leading to visual drift (focal point shifts ±5-10px).
 * 
 * Solution: Capture all transform-relevant values at REQUEST time and use
 * these snapshot values at DISPLAY time.
 * 
 * @property containerWidth - Container width at request time
 * @property containerHeight - Container height at request time
 * @property pdfToElementScale - Scale from PDF to element coordinates at request time
 * @property epoch - Zoom epoch for validating tile staleness
 * 
 * VIEWPORT-ONLY FIX (amnesia-d9f 2026-01-23):
 * Added expectedTileBounds to capture tile coverage area at REQUEST time.
 * In viewport-only mode at high zoom, tiles are requested for a specific viewport.
 * If panning occurs during render, the tiles received correspond to the ORIGINAL
 * viewport, but CSS would be calculated for the CURRENT viewport → corruption.
 * By capturing bounds at request time, we ensure CSS matches the tiles.
 */
export interface TransformSnapshot {
  /** Container width at tile request time */
  containerWidth: number;
  /** Container height at tile request time */
  containerHeight: number;
  /** Scale from PDF to element coordinates: containerWidth / pdfWidth */
  pdfToElementScale: number;
  /** Zoom epoch from ZoomStateManager - used to detect stale tiles */
  epoch: number;
  
  /**
   * Expected tile bounds in PDF coordinates at request time.
   * Only set for viewport-only rendering (high zoom).
   * When present, CSS positioning uses these bounds instead of
   * recalculating from the tiles array.
   */
  expectedTileBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Individual PDF page element with all layers
 */
export class PdfPageElement {
  // DIAGNOSTIC: Global render sequence counter to track render ordering
  private static renderSequence = 0;

  // CONCURRENT RENDER FIX (2026-01-21): Track the latest render sequence per-instance.
  // When multiple concurrent renderTiles() calls race, only the LATEST one should write
  // to the main canvas. Stale renders are discarded to prevent corruption.
  private latestRenderSeq = 0;

  private container: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private textLayerEl: HTMLDivElement;
  private annotationLayerEl: HTMLDivElement;
  private reflowLayerEl: HTMLDivElement;

  // Reusable offscreen canvas for tile compositing (reduces GC pressure)
  // Created lazily and resized as needed instead of new canvas per render
  private offscreenCanvas: HTMLCanvasElement | null = null;
  private offscreenCtx: CanvasRenderingContext2D | null = null;

  // Track last canvas offset and size to detect viewport changes
  // When offset OR size changes, content preservation would stretch incorrectly
  private lastCanvasOffsetX = 0;
  private lastCanvasOffsetY = 0;
  private lastCanvasWidth = 0;
  private lastCanvasHeight = 0;

  // Track last tile bounds to detect content changes during panning
  // PANNING FIX (2026-01-21): When using full-page canvas (isViewportOnly=false),
  // canvasOffsetX/Y are always (0,0) but the ACTUAL tiles rendered can change.
  // We track tile bounds separately to detect when content changes during pan.
  private lastTileBoundsX = 0;
  private lastTileBoundsY = 0;
  private lastTileBoundsWidth = 0;
  private lastTileBoundsHeight = 0;
  // SCALE CHANGE FIX (2026-01-21): Track the tile scale to detect zoom changes.
  // When scale changes, old content at the wrong scale must NOT be preserved,
  // even if the viewport area is similar. Mixed-scale content causes corruption.
  private lastTileScale = 0;

  // ZOOM RESET TRACKING: Track when resetCssForZoomChange() was last called.
  // This helps detect race conditions where stale renders overwrite the reset CSS.
  private lastZoomResetTime = 0;

  // DOUBLE-BUFFERING: Snapshot element for smooth mode transitions
  // During full-page→tiled transitions, we capture the current canvas as an image
  // and display it while new tiles render. This eliminates the "blank flash" that
  // occurs when the canvas is hidden during mode transitions.
  // PERF FIX: Use canvas instead of img for transition snapshot.
  // drawImage() is a fast GPU copy (~1ms) vs toDataURL() which is CPU-bound (~100ms+).
  private transitionSnapshot: HTMLCanvasElement | null = null;

  // amnesia-2t8 (H8): Epoch at which mode transition was initiated.
  // The transition snapshot should only be cleared when tiles with epoch >= transitionEpoch arrive.
  // This prevents stale tiles (from pre-transition renders) from prematurely clearing the snapshot.
  private transitionEpoch: number | null = null;

  private config: Required<PdfPageElementConfig>;
  private currentWidth = 0;
  private currentHeight = 0;

  // Native PDF dimensions in points (e.g., 612×792 for letter).
  // Used as fallback for tile coordinate calculations when pdfDimensions
  // parameter is not provided to renderTiles().
  private storedPdfDimensions: { width: number; height: number } | null = null;
  private isRendered = false;
  private currentReadingMode: ReadingMode = 'light';
  private currentRenderMode: RenderMode = 'page';

  // Text layer data for smart copy
  private textLayerData: PdfTextLayerData | null = null;

  // Current zoom level for tile rendering decisions
  private currentZoom = 1.0;

  // Smart copy enabled (converts to Markdown on copy)
  private smartCopyEnabled = true;

  // Dark mode renderer for smart dark mode (preserves images)
  private darkModeRenderer: DarkModeRenderer | null = null;
  private useSmartDarkMode = false;
  // Track if smart dark mode needs to be reapplied after renders
  private smartDarkModeApplied = false;

  // Use HSL lightness inversion instead of CSS filters (experimental)
  // This preserves anti-aliasing better but is computationally more expensive
  private useHslDarkMode = false;

  // Mobile reflow renderer
  private reflowRenderer: MobileReflowRenderer | null = null;

  // SVG text layer for vector-crisp text rendering at any zoom level
  private svgTextLayer: PdfSvgTextLayer | null = null;
  private useSvgTextLayer = true;

  // UNIFIED COORDINATE SPACE: Final zoomed dimensions
  // In the new architecture, page elements are sized to their final displayed dimensions
  // rather than relying on camera scale transforms. This eliminates cssStretch compensation.
  private finalWidth: number = 0;
  private finalHeight: number = 0;

  // Callbacks
  private onSelectionCallback?: (page: number, text: string, rects: DOMRect[]) => void;
  private onHighlightClickCallback?: (annotationId: string, position: { x: number; y: number }) => void;

  constructor(config: PdfPageElementConfig) {
    // Determine pixelRatio at runtime to handle cases where passed config captured incorrect value
    let pixelRatio = config.pixelRatio ?? window.devicePixelRatio ?? 1;
    if (pixelRatio === 1 && window.devicePixelRatio > 1) {
      pixelRatio = window.devicePixelRatio;
    }

    this.config = {
      pageNumber: config.pageNumber,
      pixelRatio,
      maxZoom: config.maxZoom ?? 32,
      enableTextAntialiasing: config.enableTextAntialiasing ?? true,
      enableImageSmoothing: config.enableImageSmoothing ?? true,
      useSvgTextLayer: config.useSvgTextLayer ?? true,
      debugTextLayer: config.debugTextLayer ?? false,
      // Note: pdfDimensions is stored separately in storedPdfDimensions
      pdfDimensions: config.pdfDimensions ?? { width: 0, height: 0 }, // Default empty, real value in storedPdfDimensions
    };

    // Store PDF dimensions for tile coordinate fallback
    if (config.pdfDimensions) {
      this.storedPdfDimensions = { ...config.pdfDimensions };
    }

    // Set SVG text layer preference
    this.useSvgTextLayer = this.config.useSvgTextLayer;

    // Create container
    this.container = document.createElement('div');
    this.container.className = 'pdf-page-element';
    this.container.dataset.page = String(config.pageNumber);
    // OVERFLOW FIX (2026-01-22): Use both overflow:hidden AND clip-path for robust clipping.
    // Some browsers don't properly clip transformed content with just overflow:hidden.
    // clip-path: inset(0) creates a clipping region exactly matching the element bounds,
    // which reliably clips all content including GPU-composited transformed children.
    this.container.style.cssText = `
      position: relative;
      background: transparent;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      overflow: hidden;
      clip-path: inset(0);
      flex-shrink: 0;
    `;

    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pdf-page-canvas';
    // GPU COMPOSITING: Add will-change and translateZ(0) for GPU layer promotion.
    // This ensures individual page canvases are composited on the GPU during zoom,
    // preventing expensive software compositing and enabling 60fps performance.
    this.canvas.style.cssText = `
      display: block;
      width: 100%;
      height: 100%;
      will-change: transform;
      transform: translateZ(0);
    `;
    this.container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context');
    }
    this.ctx = ctx;

    // Create text layer
    this.textLayerEl = document.createElement('div');
    this.textLayerEl.className = 'pdf-page-text-layer';
    this.textLayerEl.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
      opacity: 0.2;
      line-height: 1;
      pointer-events: auto;
      user-select: text;
      -webkit-user-select: text;
    `;
    this.container.appendChild(this.textLayerEl);

    // Create annotation layer
    this.annotationLayerEl = document.createElement('div');
    this.annotationLayerEl.className = 'pdf-page-annotation-layer';
    this.annotationLayerEl.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
    `;
    this.container.appendChild(this.annotationLayerEl);

    // Create reflow layer (hidden by default)
    this.reflowLayerEl = document.createElement('div');
    this.reflowLayerEl.className = 'pdf-page-reflow-layer';
    this.reflowLayerEl.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      overflow-y: auto;
      display: none;
      background: white;
    `;
    this.container.appendChild(this.reflowLayerEl);

    // Create SVG text layer for vector-crisp text rendering
    // This is above the HTML text layer (z-index 3) for proper selection
    if (this.useSvgTextLayer) {
      this.svgTextLayer = new PdfSvgTextLayer(this.container, {
        debug: this.config.debugTextLayer,
      });
      // Hide HTML text layer when using SVG
      this.textLayerEl.style.display = 'none';
    }

    // Setup selection listener
    this.setupSelectionListener();

    // Setup copy handler for smart copy
    this.setupCopyHandler();
  }

  /**
   * Get the DOM element
   */
  getElement(): HTMLDivElement {
    return this.container;
  }

  /**
   * Enable or disable CSS transitions on the canvas transform.
   * Used to smoothly animate mode transitions.
   *
   * @param enabled - Whether to enable smooth transitions
   */
  enableTransition(enabled: boolean): void {
    if (enabled) {
      this.canvas.style.transition = 'transform 200ms ease-out';
    } else {
      this.canvas.style.transition = '';
    }
  }

  /**
   * Get page number
   */
  getPageNumber(): number {
    return this.config.pageNumber;
  }

  /**
   * Check if page is rendered
   */
  getIsRendered(): boolean {
    return this.isRendered;
  }

  /**
   * Check if page has actual rendered content.
   * BLANK-PAGE-FIX (2026-01-22): Used by STALE-PAGE-CHECK to avoid skipping
   * pages that have never been rendered. A page with no content should always
   * be rendered, even if it's technically "out of view" by current calculations.
   *
   * Returns true if:
   * - isRendered flag is true AND
   * - Canvas has been resized from default 300x150 (indicates actual rendering)
   */
  hasRenderedContent(): boolean {
    // Default HTML canvas is 300x150 - if we see this, canvas was never rendered
    const hasRealCanvasContent = this.canvas.width > 300 && this.canvas.height > 150;
    return this.isRendered && hasRealCanvasContent;
  }

  /**
   * Get current container width.
   * DRIFT FIX: Used to capture snapshot at tile request time.
   */
  getCurrentWidth(): number {
    return this.currentWidth;
  }

  /**
   * Get current container height.
   * DRIFT FIX: Used to capture snapshot at tile request time.
   */
  getCurrentHeight(): number {
    return this.currentHeight;
  }

  /**
   * Clear the rendered flag without clearing the canvas.
   * Used for zoom-dependent re-rendering where we want to keep
   * the current content visible while fetching higher resolution.
   */
  clearRendered(): void {
    this.isRendered = false;
  }

  /**
   * Reset canvas CSS to full-page mode during zoom changes.
   *
   * CRITICAL FIX FOR TILE SHIFTING (2026-01-22):
   * In viewport-only tiled mode, the canvas has a translate(cssOffsetX, cssOffsetY)
   * transform that positions the tile region within the page element. When the camera
   * zoom changes but tiles aren't re-rendered (during gesture), this offset becomes
   * stale because it was calculated for the old viewport/zoom position.
   *
   * The focal point preservation in zoomCameraToPoint() adjusts camera.x/y to keep
   * content stationary, but the stale cssOffset doesn't account for this change.
   * Result: tiles appear to "shift away" from the focal point during zoom.
   *
   * FIX: Reset canvas CSS to full-page mode (no offset, fill container).
   * - Clear the translate offset so canvas starts at (0, 0) within page element
   * - Size canvas CSS to match container so existing buffer content fills the page
   * - Don't clear content - let existing pixels stretch to fill (degraded but visible)
   * - Camera transform handles all positioning via parent scale(z) translate(x, y)
   */
  resetCssForZoomChange(): void {
    // 2026-01-22 FIX v3: Reset CSS AND clear buffer on aspect mismatch.
    //
    // PROBLEM: In viewport-only mode, canvas BUFFER is sized to tile bounds
    // (e.g., 7056x7680 = near-square when viewing specific area at high zoom).
    // When CSS is reset to container dimensions (400x604 = portrait), the
    // browser stretches the near-square buffer to fit portrait CSS.
    // This causes MASSIVE visual corruption (scattered text fragments).
    //
    // FIX: Check for aspect ratio mismatch between buffer and target CSS.
    // If mismatch > 5%, clear the buffer to prevent stretch corruption.
    // The page will briefly show blank, but new tiles will render quickly.

    // 2026-01-24 FIX: Skip unrendered pages entirely.
    // Pages that have never been rendered have default 300x150 canvas dimensions.
    // Resetting CSS for these causes visible blank flash during zoom-out.
    // Instead, leave them untouched - they'll get proper CSS when first rendered.
    const isUnrenderedCanvas = this.canvas.width === 300 && this.canvas.height === 150;
    if (isUnrenderedCanvas) {
      // Don't log spam - just skip silently
      return;
    }

    const prevCss = {
      width: this.canvas.style.width,
      height: this.canvas.style.height,
      transform: this.canvas.style.transform,
    };

    const prevBuffer = {
      width: this.canvas.width,
      height: this.canvas.height,
    };

    // Check for aspect ratio mismatch
    const bufferAspect = prevBuffer.width / prevBuffer.height;
    const targetAspect = this.currentWidth / this.currentHeight;
    const aspectMismatch = Math.abs(bufferAspect - targetAspect) / targetAspect;

    // Reset to container dimensions for full page coverage
    this.canvas.style.width = `${this.currentWidth}px`;
    this.canvas.style.height = `${this.currentHeight}px`;
    this.canvas.style.transform = 'translateZ(0)'; // GPU layer, no offset
    this.canvas.style.transformOrigin = '0 0';

    // If aspect mismatch > 5%, clear the buffer to prevent stretch corruption
    if (aspectMismatch > 0.05) {
      console.warn(`[ZOOM-CSS-RESET] page=${this.config.pageNumber}: ` +
        `CLEARING buffer due to aspect mismatch! ` +
        `buffer=${prevBuffer.width}x${prevBuffer.height} (aspect=${bufferAspect.toFixed(3)}), ` +
        `target=${this.currentWidth}x${this.currentHeight} (aspect=${targetAspect.toFixed(3)}), ` +
        `mismatch=${(aspectMismatch * 100).toFixed(1)}%`);

      // Clear the canvas to prevent corrupted stretch
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      console.log(`[ZOOM-CSS-RESET] page=${this.config.pageNumber}: ` +
        `Reset CSS from ${prevCss.width}x${prevCss.height} (transform="${prevCss.transform}") ` +
        `to ${this.currentWidth}x${this.currentHeight} (full container), ` +
        `aspect mismatch=${(aspectMismatch * 100).toFixed(1)}% (OK)`);
    }

    // Track reset time for race condition detection
    this.lastZoomResetTime = performance.now();
  }

  /**
   * @deprecated Use resetCssForZoomChange() instead.
   * Keeping for backward compatibility during migration.
   */
  resetTransformForZoomChange(): void {
    this.resetCssForZoomChange();
  }

  /**
   * Reset canvas state for mode transition (tiled → full-page).
   *
   * When transitioning from tiled rendering back to full-page mode,
   * we need to reset the viewport-specific state that was used for
   * tile positioning. Without this, leftover state can cause incorrect
   * positioning or content preservation in the next render.
   */
  resetCanvas(): void {
    // Clear canvas content
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Reset viewport tracking state used by tiled rendering
    // These track the last canvas offset/size for progressive rendering
    this.lastCanvasOffsetX = 0;
    this.lastCanvasOffsetY = 0;
    this.lastCanvasWidth = 0;
    this.lastCanvasHeight = 0;

    // Reset tile bounds tracking (PANNING FIX 2026-01-21)
    this.lastTileBoundsX = 0;
    this.lastTileBoundsY = 0;
    this.lastTileBoundsWidth = 0;
    this.lastTileBoundsHeight = 0;

    // Reset canvas transform (in case tiled rendering set one)
    this.canvas.style.transform = '';

    // Mark as needing re-render
    this.isRendered = false;

    console.log(`[RESET-CANVAS] page=${this.config.pageNumber}: Cleared viewport state for mode transition`);
  }

  /**
   * Set dimensions and show immediate placeholder
   *
   * This ensures the page NEVER appears blank - as soon as dimensions
   * are set, a styled placeholder is displayed. This eliminates the
   * flash of empty content during scrolling.
   *
   * @deprecated Use setFinalDimensions() in unified coordinate space architecture.
   * This method will be removed once Phase 2 is complete.
   */
  setDimensions(width: number, height: number): void {
    // H1 FIX: Round dimensions to integers for pixel-perfect alignment.
    // This ensures container and canvas dimensions match exactly.
    const roundedWidth = Math.round(width);
    const roundedHeight = Math.round(height);

    this.currentWidth = roundedWidth;
    this.currentHeight = roundedHeight;

    this.container.style.width = `${roundedWidth}px`;
    this.container.style.height = `${roundedHeight}px`;

    // Update SVG text layer dimensions for proper scaling
    if (this.svgTextLayer) {
      this.svgTextLayer.setDimensions(width, height);
    }

    // CRITICAL: Show placeholder immediately after dimensions are set
    // This prevents blank pages during scroll/zoom
    if (!this.isRendered) {
      this.showPlaceholder();
    }
  }

  /**
   * Set final zoomed dimensions for unified coordinate space.
   *
   * UNIFIED COORDINATE SPACE ARCHITECTURE:
   * In the new architecture, page elements are sized to their **final displayed dimensions**
   * at the current zoom level. This eliminates the need for camera scale transforms and
   * the cssStretch compensation mechanism that caused visual jumps.
   *
   * Key principle: Page element DOM size = final screen size / camera.z
   * When camera.z = zoom (unified space), DOM size = layout.width * zoom.
   *
   * @param finalWidth - Width in pixels at current zoom (layout.width * zoom)
   * @param finalHeight - Height in pixels at current zoom (layout.height * zoom)
   * @param zoom - Current zoom level (stored for tile rendering calculations)
   */
  setFinalDimensions(finalWidth: number, finalHeight: number, zoom: number): void {
    // H1 FIX: Round dimensions to integers for pixel-perfect alignment.
    // This ensures container and canvas dimensions match exactly.
    const roundedWidth = Math.round(finalWidth);
    const roundedHeight = Math.round(finalHeight);

    this.finalWidth = roundedWidth;
    this.finalHeight = roundedHeight;
    this.currentZoom = zoom;

    // Set DOM element size to final zoomed dimensions
    this.container.style.width = `${roundedWidth}px`;
    this.container.style.height = `${roundedHeight}px`;

    // Update internal tracking (currentWidth/Height used by rendering)
    this.currentWidth = roundedWidth;
    this.currentHeight = roundedHeight;

    // Update SVG text layer dimensions for proper scaling
    if (this.svgTextLayer) {
      this.svgTextLayer.setDimensions(finalWidth, finalHeight);
    }

    // Resize canvas buffer to match final dimensions (with DPR scaling for sharpness)
    // This ensures the canvas can hold high-res content for the new zoom level
    // Use window.devicePixelRatio directly to handle DPR changes at runtime (e.g., moving window between displays)
    const dpr = window.devicePixelRatio || this.config.pixelRatio;
    const bufferWidth = Math.ceil(finalWidth * dpr);
    const bufferHeight = Math.ceil(finalHeight * dpr);

    // ALWAYS update canvas CSS to match final dimensions
    // BUG FIX: Previously this was inside needsBufferResize block, causing canvas CSS
    // to retain old dimensions when buffer size matched but final size changed.
    // This caused content rendered at high zoom to appear stretched/oversized at low zoom.
    this.canvas.style.width = `${Math.round(finalWidth)}px`;
    this.canvas.style.height = `${Math.round(finalHeight)}px`;

    // Only resize buffer and clear if dimensions actually changed (avoid clearing content unnecessarily)
    const needsBufferResize = this.canvas.width !== bufferWidth || this.canvas.height !== bufferHeight;
    if (needsBufferResize) {
      this.canvas.width = bufferWidth;
      this.canvas.height = bufferHeight;

      // Clear any existing tile content - only needed when buffer actually resizes
      // This prevents unnecessary clearing during small zoom adjustments
      this.clearTileCanvases();
    }

    // Show placeholder immediately if not yet rendered
    if (!this.isRendered) {
      this.showPlaceholder();
    }

    console.log(`[PdfPageElement] setFinalDimensions: page=${this.config.pageNumber}, finalSize=${finalWidth.toFixed(0)}x${finalHeight.toFixed(0)}, buffer=${bufferWidth}x${bufferHeight}, zoom=${zoom.toFixed(2)}`);
  }

  /**
   * Get the final width (in unified coordinate space).
   */
  getFinalWidth(): number {
    return this.finalWidth;
  }

  /**
   * Get the final height (in unified coordinate space).
   */
  getFinalHeight(): number {
    return this.finalHeight;
  }

  /**
   * Set native PDF page dimensions in points.
   * Used as fallback for tile coordinate calculations when pdfDimensions
   * parameter is not provided to renderTiles().
   */
  setPdfDimensions(width: number, height: number): void {
    this.storedPdfDimensions = { width, height };
  }

  /**
   * Clear all tile canvases.
   * Called when zoom changes in unified coordinate space to remove stale tiles.
   */
  clearTileCanvases(): void {
    // Note: tileCanvases map is used in renderTiles() but currently canvases are
    // created inline within that method. This method provides the interface for
    // future optimization where we track tile canvases separately.
    // For now, clear the main canvas which holds composited tiles.
    if (this.offscreenCanvas) {
      this.offscreenCtx?.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // NOTE: Don't reset canvas transform here to avoid visual jumps.
    // renderTiles() will set the correct transform when it renders new content.
    // Resetting transform here would cause a brief flash at wrong position/scale
    // before the next render completes.

    // Mark as needing re-render
    this.isRendered = false;
  }

  /**
   * Show placeholder content while loading.
   *
   * PERFORMANCE: Uses CSS-only placeholder instead of canvas drawing.
   * Previous implementation drew 25+ roundRect operations per page, causing
   * 160ms+ main thread blocking during fast scroll with 20+ new pages.
   * CSS background is GPU-accelerated and non-blocking.
   */
  private showPlaceholder(): void {
    if (this.currentWidth <= 0 || this.currentHeight <= 0) return;

    // Transparent placeholder - cleaner loading experience
    // The canvas is transparent, showing the viewport background
    this.canvas.style.background = 'transparent';
    this.canvas.style.backgroundSize = '';
    this.canvas.style.backgroundPosition = '';
    this.canvas.style.backgroundRepeat = '';

    // Set canvas size for proper display (minimal operation)
    // H1 FIX: Use Math.round() for CSS dimensions to match integer canvas buffer dimensions.
    this.canvas.style.width = `${Math.round(this.currentWidth)}px`;
    this.canvas.style.height = `${Math.round(this.currentHeight)}px`;
  }

  /**
   * Update for zoom changes
   *
   * Updates dimensions and text layer positioning for the current zoom level.
   * Used in tiled rendering mode where zoom affects tile resolution.
   *
   * @param zoom - Current zoom level
   * @param width - Display width in pixels
   * @param height - Display height in pixels
   *
   * @deprecated Use setFinalDimensions() in unified coordinate space architecture.
   * This method will be removed once Phase 2 is complete.
   */
  updateForZoom(zoom: number, width: number, height: number): void {
    this.currentZoom = zoom;
    this.setDimensions(width, height);

    // Update SVG text layer for zoom changes
    if (this.svgTextLayer) {
      this.svgTextLayer.updateForZoom(zoom, width, height);
    }
  }

  /**
   * Get current zoom level
   */
  getZoom(): number {
    return this.currentZoom;
  }

  /**
   * Clear placeholder styles when real content is rendered
   */
  private clearPlaceholder(): void {
    this.canvas.style.background = '';
    this.canvas.style.backgroundSize = '';
    this.canvas.style.backgroundPosition = '';
    this.canvas.style.backgroundRepeat = '';
  }

  /**
   * Render page content
   */
  async render(data: PageRenderData, scale: number): Promise<void> {
    const startTime = performance.now();
    const telemetry = getTelemetry();

    // Render canvas
    await this.renderCanvas(data.imageBlob);

    // Render text layer if available
    if (data.textLayerData) {
      this.renderTextLayer(data.textLayerData, scale);
    }

    this.isRendered = true;

    // Show canvas after render (may have been hidden during mode transition)
    this.showCanvas();

    // DOUBLE-BUFFERING: Remove transition snapshot now that new content is displayed.
    // This completes the atomic swap - old content (snapshot) is replaced by new content (canvas).
    // amnesia-2t8 (H8): Pass current epoch to gate snapshot clearing
    const scaleManagerForClear = getScaleStateManager('default');
    const currentEpochForClear = scaleManagerForClear?.getEpoch();
    this.clearTransitionSnapshot(currentEpochForClear);

    // Track render time and scale
    const renderTime = performance.now() - startTime;
    telemetry.trackRenderTime(renderTime, 'page');
    telemetry.trackRenderScale(scale, 'page');

    // Apply reading mode styles now that we have content
    // This enables canvas-based dark mode for better quality
    this.applyReadingModeStyles();
  }

  /**
   * Render page using tile-based rendering (CATiledLayer-style)
   * Used for high-zoom scenarios where tiles provide crisper rendering
   *
   * @param tiles Array of tile coordinates and their rendered bitmaps
   * @param textLayerData Optional text layer data for text selection
   * @param zoom Current zoom level
   * @param pdfDimensions Native PDF page dimensions (tiles are in this coordinate space)
   */
  async renderTiles(
    // INV-6: Include scaleEpoch/renderParamsId for display-time validation
    tiles: Array<{
      tile: TileCoordinate;
      bitmap: ImageBitmap;
      cssStretch?: number;
      scaleEpoch?: number;
      renderParamsId?: string;
    }>,
    textLayerData: TextLayerData | undefined,
    zoom: number,
    pdfDimensions?: { width: number; height: number },
    /**
     * DRIFT FIX: Transform snapshot captured at tile REQUEST time.
     *
     * Tiles take 100-300ms to render in workers. During this time, zoom may change,
     * causing container dimensions to change. Using current dimensions at DISPLAY time
     * (for fitScale, pdfToElementScale calculations) when tiles were rendered for
     * REQUEST time dimensions causes visual drift.
     *
     * Solution: Capture all transform-relevant values at REQUEST time (TransformSnapshot)
     * and use those values at DISPLAY time.
     *
     * The epoch field allows validation: if current epoch !== snapshot.epoch,
     * the zoom has changed since request and tiles may be stale.
     */
    transformSnapshot?: TransformSnapshot,
    /**
     * EPOCH VALIDATION: Current render epoch from the caller (pdf-infinite-canvas.renderVersion).
     *
     * When provided, validates that transformSnapshot.epoch matches currentEpoch.
     * If mismatch detected (zoom changed since tile request), falls back to current
     * dimensions instead of potentially stale snapshot dimensions.
     */
    currentEpoch?: number,
    /**
     * FORCE FULL PAGE FIX: When true, always use full-page canvas sizing regardless
     * of how many tiles were actually received.
     *
     * During mode transition (full-page → tiled), getPageTileGrid() generates ALL
     * tiles for the page. However, continuous zooming causes epoch changes that
     * abort some tile renders. Only partial tiles reach renderTiles(), causing the
     * isViewportOnly check to incorrectly size the canvas smaller than the full page.
     *
     * When forceFullPage=true (set during mode transition), we skip the isViewportOnly
     * check and always use full-page dimensions, preventing blank areas.
     */
    forceFullPage?: boolean
  ): Promise<void> {
    const startTime = performance.now();
    const telemetry = getTelemetry();

    // === TILE-RECEIVE-DEBUG === Log what tiles renderTiles actually receives
    const renderSeq = ++PdfPageElement.renderSequence;
    // CONCURRENT RENDER FIX: Track this as the latest render for this page instance.
    // Any older render that hasn't completed yet will be discarded before canvas write.
    this.latestRenderSeq = renderSeq;
    console.log(`[RENDER-SEQ] page=${this.config.pageNumber} seq=${renderSeq} STARTED (latestRenderSeq=${this.latestRenderSeq})`);
    if (zoom >= 4 && tiles.length > 0) {
      const tileXs = tiles.map(t => t.tile.tileX);
      const tileYs = tiles.map(t => t.tile.tileY);
      const minX = Math.min(...tileXs), maxX = Math.max(...tileXs);
      const minY = Math.min(...tileYs), maxY = Math.max(...tileYs);
      // MULTI-SCALE DIAGNOSTIC (amnesia-hfc update): Track if tiles have different scales
      // Now allows mixed scales when cssStretch compensates for per-tile quality variation
      const uniqueScales = [...new Set(tiles.map(t => t.tile.scale))];
      const scaleInfo = uniqueScales.length > 1
        ? `MULTI-SCALE=[${uniqueScales.join(',')}]`
        : `scale=${uniqueScales[0]}`;
      console.error(`[TILE-RECEIVE] seq=${renderSeq} page=${this.config.pageNumber} zoom=${zoom.toFixed(2)} tiles=${tiles.length}: X=[${minX}-${maxX}], Y=[${minY}-${maxY}], ${scaleInfo}, forceFullPage=${forceFullPage}`);

      // INV-6a (amnesia-hfc): Scale × cssStretch = consistent visual scale
      // Mixed scales are allowed when using per-tile quality variation.
      // Verify: each tile's visualScale (scale × cssStretch) should be consistent.
      if (uniqueScales.length > 1) {
        // MULTI-SCALE FIX (amnesia-d9f): Mixed scales are now handled correctly!
        // The tile drawing loop uses consistent tileScale for positioning and stretches
        // individual tiles to fill the correct visual area. This allows tiles at different
        // render scales to composite correctly.
        //
        // Log for diagnostic purposes but this is no longer a bug condition.
        console.log(`[MULTI-SCALE-INFO] page=${this.config.pageNumber}: Compositing tiles at scales [${uniqueScales.join(', ')}] → target tileScale (handled via stretch compensation)`);
      }

      // TILE COMPLIANCE VALIDATION (amnesia-e4i): Check tiles at compositing time
      // This catches tiles that were cached with wrong scale/coordinates before they
      // cause visual corruption during rendering.
      if (isFeatureEnabled('useTileComplianceValidation')) {
        // The "expected" scale at this zoom level
        const { tier: expectedGridScale } = getTargetScaleTier(
          zoom,
          this.config.pixelRatio ?? window.devicePixelRatio,
          this.config.maxZoom ?? 32
        );
        
        const complianceResult = validateTileBatchCompliance(
          tiles.map(t => t.tile),
          expectedGridScale,
          zoom,
          `PdfPageElement.renderTiles(page=${this.config.pageNumber}, seq=${renderSeq})`
        );

        if (complianceResult.violations > 0) {
          console.error(
            `[TILE-COMPLIANCE-AT-COMPOSITE] page=${this.config.pageNumber} seq=${renderSeq}: ` +
            `${complianceResult.violations}/${tiles.length} non-compliant tiles will be composited`,
            {
              zoom: zoom.toFixed(2),
              expectedGridScale,
              actualScales: uniqueScales,
              violationTypes: complianceResult.details.flatMap(d => d.violations.map(v => v.split(':')[0])),
            }
          );
        }
      }

      // SCALE EPOCH VALIDATION (INV-6: Scale/Layout Atomicity)
      // Check if tiles have stale scaleEpoch values from ScaleStateManager
      // INV-6 FIX (2026-01-23): Read scaleEpoch from tile result object, not tile coordinate
      const scaleManager = getScaleStateManager('default');
      if (scaleManager) {
        const currentScaleEpoch = scaleManager.getEpoch();
        const staleTiles = tiles.filter(t => {
          // scaleEpoch is passed through from RenderResult (attached at request time)
          const tileEpoch = (t as { scaleEpoch?: number }).scaleEpoch;
          return tileEpoch !== undefined && !scaleManager.validateEpoch(tileEpoch);
        });

        if (staleTiles.length > 0) {
          const staleEpochs = [...new Set(staleTiles.map(t => (t as { scaleEpoch?: number }).scaleEpoch))];
          console.warn(`[SCALE-EPOCH-STALE] page=${this.config.pageNumber}: ${staleTiles.length}/${tiles.length} tiles have stale epochs [${staleEpochs.join(',')}], current=${currentScaleEpoch}`);
          
          // Record epoch mismatches for diagnostic overlay (amnesia-e4i debugging)
          for (const epoch of staleEpochs) {
            if (epoch !== undefined) {
              try {
                getTileDiagnosticOverlay().recordEpochMismatch(epoch);
              } catch { /* overlay may not be initialized */ }
            }
          }

          // INV-6 ENFORCEMENT: Filter out stale tiles to prevent mixed-scale corruption
          // Stale tiles were rendered at a different scale than current - displaying them
          // would cause dimension mismatches (the 11.380 vs 11.381 bug)
          const filteredTiles = tiles.filter(t => {
            const tileEpoch = (t as { scaleEpoch?: number }).scaleEpoch;
            return tileEpoch === undefined || scaleManager.validateEpoch(tileEpoch);
          });

          if (filteredTiles.length < tiles.length) {
            console.warn(`[SCALE-EPOCH-FILTER] page=${this.config.pageNumber}: Filtered ${tiles.length - filteredTiles.length} stale tiles, ${filteredTiles.length} remaining`);
            // Replace tiles array with filtered version
            tiles = filteredTiles;
          }
        }
      }
    }

    // DRIFT FIX: Use snapshot values (captured at request time) for CSS calculations.
    // The container may have resized during the 100-300ms render window.
    // Using current dimensions would cause position/size mismatch → visual drift.
    const usedSnapshot = transformSnapshot !== undefined;

    // EPOCH VALIDATION: Check if zoom has changed since tile request
    // If snapshot.epoch !== currentEpoch, the zoom level has changed during the
    // 100-300ms render window. In this case, the snapshot dimensions are stale
    // and we should fall back to current dimensions to prevent coordinate drift.
    const snapshotEpoch = transformSnapshot?.epoch ?? -1;
    const epochValid = currentEpoch === undefined ||
                       snapshotEpoch === -1 ||
                       snapshotEpoch === currentEpoch;

    // Use snapshot dimensions only if epoch is valid (no zoom change since request)
    // Fall back to current dimensions if epoch mismatch detected
    let effectiveWidth: number;
    let effectiveHeight: number;

    if (usedSnapshot && epochValid) {
      // Epoch matches - safe to use snapshot dimensions
      effectiveWidth = transformSnapshot!.containerWidth;
      effectiveHeight = transformSnapshot!.containerHeight;
    } else if (usedSnapshot && !epochValid) {
      // EPOCH MISMATCH FIX (2026-01-21): Previously used "graceful degradation" which kept
      // old canvas content visible when stale tiles arrived. This caused severe corruption:
      // - Old tiled content had transforms for OLD zoom/position
      // - New CSS was set for CURRENT zoom/position
      // - Result: content at wrong scale/position → mixed-resolution corruption
      //
      // NEW BEHAVIOR: Discard stale tiles entirely. Let the render system handle it:
      // 1. Close bitmaps to free memory
      // 2. Reset canvas CSS to match container (prevents overflow)
      // 3. Return early - canvas will be refreshed by subsequent render
      //
      // The brief blank is better than corrupted content.
      console.log(`[PDFPageElement] Discarding stale tiles (epoch mismatch): snapshot.epoch=${snapshotEpoch}, currentEpoch=${currentEpoch}`);
      // Close all bitmaps to prevent memory leak
      for (const { bitmap } of tiles) {
        bitmap.close();
      }

      // OVERFLOW FIX (2026-01-22): Reset canvas CSS to match container dimensions.
      // During rapid zoom-out, tiles rendered at high zoom arrive late with stale epoch.
      // The canvas retains its old CSS dimensions (sized for high-zoom tile bounds),
      // while the container has already been resized for the new lower zoom.
      // Result: canvas overflows container → content escapes page bounds.
      //
      // Fix: Reset canvas CSS to 100% of container, clear positioning transform.
      // This ensures the existing canvas content scales to fit the container while
      // waiting for fresh tiles at the current zoom level.
      this.canvas.style.width = `${this.currentWidth}px`;
      this.canvas.style.height = `${this.currentHeight}px`;
      this.canvas.style.transform = 'translateZ(0)'; // Reset to initial (GPU layer promotion only)
      this.canvas.style.transformOrigin = '0 0';
      console.log(`[OVERFLOW-FIX] page=${this.config.pageNumber}: Reset canvas CSS to container size ${this.currentWidth}x${this.currentHeight}`);

      return;
    } else {
      // No snapshot provided - use current dimensions
      effectiveWidth = this.currentWidth;
      effectiveHeight = this.currentHeight;
    }

    const dimMismatch = usedSnapshot && Math.abs(transformSnapshot!.containerWidth - this.currentWidth) > 1;
    console.log(`[TransformSnapshot] DISPLAY page=${this.config.pageNumber}: zoom=${zoom.toFixed(2)}, snapshot=${usedSnapshot ? `${transformSnapshot!.containerWidth.toFixed(0)}x${transformSnapshot!.containerHeight.toFixed(0)}, epoch=${snapshotEpoch}` : 'none'}, current=${this.currentWidth.toFixed(0)}x${this.currentHeight.toFixed(0)}, epochValid=${epochValid}, MISMATCH=${dimMismatch}`);

    // Guard: Return early if no tiles (prevents -Infinity in bounding box calculation)
    if (tiles.length === 0) {
      console.warn(`[PdfPageElement] renderTiles called with 0 tiles, skipping render`);
      return;
    }

    // Clear CSS placeholder before drawing actual content
    this.clearPlaceholder();

    // Get PDF dimensions for coordinate calculations.
    // CRITICAL: Use storedPdfDimensions (native PDF points, e.g., 612×792) as fallback,
    // NOT currentWidth/Height (CSS pixels, e.g., 400×518). Using CSS pixels as PDF
    // coordinates breaks tile calculations because tile coordinates are in PDF space.
    const pdfWidth = pdfDimensions?.width ?? this.storedPdfDimensions?.width ?? this.currentWidth;
    const pdfHeight = pdfDimensions?.height ?? this.storedPdfDimensions?.height ?? this.currentHeight;

    // Debug: Log when falling back to stored or CSS dimensions
    if (!pdfDimensions) {
      const source = this.storedPdfDimensions ? 'storedPdfDimensions' : 'currentWidth/Height (WARNING: CSS pixels!)';
      console.warn(`[PdfPageElement] renderTiles page=${this.config.pageNumber}: pdfDimensions not provided, using ${source}: ${pdfWidth}x${pdfHeight}`);
    }

    // Get tile scale from first tile (all tiles in a render have same scale)
    // Fall back to calculated scale if no tiles
    // SCALE MISMATCH FIX (amnesia-d9f): Respect useExactScaleRendering flag
    let fallbackTileScale: number;
    if (isFeatureEnabled('useExactScaleRendering')) {
      // FIX (amnesia-d9f): Pass maxZoom to ensure proper scale cap
      const { scale } = getExactTargetScale(zoom, this.config.pixelRatio, this.config.maxZoom);
      fallbackTileScale = scale;
    } else {
      const { tier } = getTargetScaleTier(zoom, this.config.pixelRatio, this.config.maxZoom);
      fallbackTileScale = tier;
    }
    const tileScale = tiles.length > 0 ? tiles[0].tile.scale : fallbackTileScale;

    // Calculate bounding box of tiles being rendered
    // This allows viewport-only rendering: canvas sized to visible tiles, not full page
    // TILE SIZE FIX: Use getTileSize() to match adaptive tile sizing in tile calculations.
    // When useAdaptiveTileSize is enabled, tiles are 512px, not 256px (TILE_SIZE constant).
    const actualTileSize = getTileSize(zoom);
    const pdfTileSize = actualTileSize / tileScale;

    // DEFENSIVE BOUNDS CHECK: Filter out tiles with invalid indices before processing.
    // This catches tiles generated with mismatched tile sizes (e.g., 256px vs 512px grid).
    // Tiles with indices beyond page bounds would cause blank areas and rendering issues.
    const maxValidTileX = Math.ceil(pdfWidth / pdfTileSize);
    const maxValidTileY = Math.ceil(pdfHeight / pdfTileSize);
    const originalTileCount = tiles.length;
    const validTiles = tiles.filter(({ tile }) => {
      const isValid = tile.tileX >= 0 && tile.tileX < maxValidTileX &&
                      tile.tileY >= 0 && tile.tileY < maxValidTileY;
      if (!isValid) {
        console.warn(`[PdfPageElement] FILTERED invalid tile: page=${this.config.pageNumber}, ` +
          `tile=(${tile.tileX},${tile.tileY}), scale=${tile.scale}, ` +
          `maxValid=(${maxValidTileX},${maxValidTileY}), pdfTileSize=${pdfTileSize.toFixed(1)}, ` +
          `pdfSize=${pdfWidth.toFixed(1)}x${pdfHeight.toFixed(1)}`);
      }
      return isValid;
    });

    if (validTiles.length < originalTileCount) {
      console.warn(`[PdfPageElement] Filtered ${originalTileCount - validTiles.length}/${originalTileCount} invalid tiles`);
    }

    // Use filtered tiles for the rest of processing
    tiles = validTiles;

    let minTileX = Infinity, minTileY = Infinity, maxTileX = -Infinity, maxTileY = -Infinity;
    for (const { tile } of tiles) {
      minTileX = Math.min(minTileX, tile.tileX);
      minTileY = Math.min(minTileY, tile.tileY);
      maxTileX = Math.max(maxTileX, tile.tileX);
      maxTileY = Math.max(maxTileY, tile.tileY);
    }

    // Calculate tile bounding box in PDF coordinates
    // CRITICAL FIX: Clamp bounds to page dimensions to prevent negative canvas sizes at high zoom.
    // At 16x zoom, tile coordinates can exceed page bounds (e.g., tileBoundsY=1312 > pdfHeight=666),
    // which caused pdfHeight - tileBoundsY to go negative → canvas height -20672 → blank tiles.
    const rawTileBoundsX = minTileX * pdfTileSize;
    const rawTileBoundsY = minTileY * pdfTileSize;
    const tileBoundsX = Math.max(0, Math.min(rawTileBoundsX, pdfWidth));
    const tileBoundsY = Math.max(0, Math.min(rawTileBoundsY, pdfHeight));
    const tileBoundsWidth = Math.max(0, Math.min((maxTileX - minTileX + 1) * pdfTileSize, pdfWidth - tileBoundsX));
    const tileBoundsHeight = Math.max(0, Math.min((maxTileY - minTileY + 1) * pdfTileSize, pdfHeight - tileBoundsY));

    // BLANK-AREA-DEBUG: Only log when there's a potential issue (bounds clamping or zero dimensions)
    const boundsIssue = rawTileBoundsY > pdfHeight || tileBoundsWidth <= 0 || tileBoundsHeight <= 0;
    if (boundsIssue) {
      console.warn(`[BLANK-AREA-DEBUG] page=${this.config.pageNumber}: tiles=${tiles.length}, tileIndices=[${minTileX}-${maxTileX}, ${minTileY}-${maxTileY}], ` +
        `pdfTileSize=${pdfTileSize.toFixed(1)}, scale=${tileScale}, rawBounds=(${rawTileBoundsX.toFixed(1)},${rawTileBoundsY.toFixed(1)}), ` +
        `clampedBounds=(${tileBoundsX.toFixed(1)},${tileBoundsY.toFixed(1)} ${tileBoundsWidth.toFixed(1)}x${tileBoundsHeight.toFixed(1)}), ` +
        `pdfSize=${pdfWidth.toFixed(1)}x${pdfHeight.toFixed(1)}, container=${this.currentWidth.toFixed(1)}x${this.currentHeight.toFixed(1)}`);
    }

    // Guard: If all tiles are outside page bounds (zero-size result), fall back to full page dimensions.
    // This can happen at extreme zoom levels when tile coordinates are calculated for regions
    // completely outside the visible page. Instead of returning (which leaves the page blank),
    // we reset bounds to cover the full page so at least something renders.
    let adjustedTileBoundsX = tileBoundsX;
    let adjustedTileBoundsY = tileBoundsY;
    let adjustedTileBoundsWidth = tileBoundsWidth;
    let adjustedTileBoundsHeight = tileBoundsHeight;
    let useContainerDimensionsDirectly = false;

    if (tileBoundsWidth <= 0 || tileBoundsHeight <= 0) {
      console.warn(`[PdfPageElement] Invalid tile bounds ${tileBoundsWidth.toFixed(1)}x${tileBoundsHeight.toFixed(1)} (tiles outside page), using container dimensions directly`);
      adjustedTileBoundsX = 0;
      adjustedTileBoundsY = 0;
      adjustedTileBoundsWidth = pdfWidth;
      adjustedTileBoundsHeight = pdfHeight;
      // Flag to use container dimensions directly in CSS sizing to avoid 1px rounding mismatch
      useContainerDimensionsDirectly = true;
    }

    // Check if we're rendering full page or viewport-only
    // FORCE FULL PAGE FIX: When forceFullPage=true (during mode transition), always
    // use full-page sizing even if received tiles don't cover the full page.
    // This prevents blank areas when some tiles are aborted during continuous zoom.
    const tilesNotCoveringFullPage = minTileX > 0 || minTileY > 0 ||
                           (maxTileX + 1) * pdfTileSize < pdfWidth - pdfTileSize ||
                           (maxTileY + 1) * pdfTileSize < pdfHeight - pdfTileSize;

    // 2026-01-22 FIX: DISABLE VIEWPORT-ONLY RENDERING FOR LOW/MID ZOOM
    // Viewport-only mode has fundamental coordinate transformation bugs that cause:
    // - Buffer/CSS aspect ratio mismatches
    // - Tiles drawn to wrong positions
    // - Scattered/overlapping text fragments
    //
    // However, at HIGH ZOOM (>16x), we MUST use viewport-only because:
    // - Full-page canvas at zoom 32 = 14112×21312 pixels = 300MP
    // - Safari limit: 67MP, Chrome limit: 268MP
    // - Canvas allocation silently fails, causing blank pages
    //
    // At high zoom, each tile is 256×256 CSS = 8192×8192 buffer (within limits).
    // Viewport-only sizes the canvas to tile bounds, not full page.
    //
    // amnesia-d9f: Keep viewport-only ONLY at high zoom where it's required.
    const HIGH_ZOOM_THRESHOLD = 16;
    const isHighZoom = zoom >= HIGH_ZOOM_THRESHOLD;
    const isViewportOnly = isHighZoom && tilesNotCoveringFullPage && !forceFullPage;

    if (forceFullPage && tilesNotCoveringFullPage) {
      console.log(`[PdfPageElement] forceFullPage=true but only got partial tiles (${tiles.length}), using full-page canvas sizing`);
    }

    // VIEWPORT-ONLY FIX (amnesia-d9f 2026-01-23): Use SNAPSHOT bounds when available.
    //
    // PROBLEM: At high zoom, tiles are requested for a specific viewport. By the time
    // tiles complete, user may have panned. If we calculate bounds from the tiles that
    // arrived, we get bounds for the OLD position. But CSS would be calculated using
    // current dimensions → mismatch → corruption.
    //
    // SOLUTION: When transformSnapshot.expectedTileBounds is set, use those bounds
    // instead of recalculating from tiles. The snapshot captures bounds at REQUEST time,
    // ensuring canvas sizing and CSS positioning are consistent with the tiles.
    //
    // IMPORTANT: We still need to track where actual tiles are (minTileX, etc.) for
    // drawing them at the correct position WITHIN the canvas. But the canvas itself
    // is sized and positioned according to snapshot bounds.
    const hasSnapshotBounds = transformSnapshot?.expectedTileBounds !== undefined;
    let effectiveBoundsX = adjustedTileBoundsX;
    let effectiveBoundsY = adjustedTileBoundsY;
    let effectiveBoundsWidth = adjustedTileBoundsWidth;
    let effectiveBoundsHeight = adjustedTileBoundsHeight;
    
    if (hasSnapshotBounds && isViewportOnly) {
      const snapBounds = transformSnapshot!.expectedTileBounds!;
      effectiveBoundsX = snapBounds.x;
      effectiveBoundsY = snapBounds.y;
      effectiveBoundsWidth = snapBounds.width;
      effectiveBoundsHeight = snapBounds.height;
      
      // Log when snapshot differs from tile-derived bounds (indicates pan during render)
      const boundsDrift = Math.abs(snapBounds.x - adjustedTileBoundsX) > 1 ||
                          Math.abs(snapBounds.y - adjustedTileBoundsY) > 1;
      if (boundsDrift) {
        console.log(`[SNAPSHOT-BOUNDS] page=${this.config.pageNumber}: using snapshot bounds ` +
          `(${snapBounds.x.toFixed(1)},${snapBounds.y.toFixed(1)} ${snapBounds.width.toFixed(1)}x${snapBounds.height.toFixed(1)}) ` +
          `instead of tile-derived (${adjustedTileBoundsX.toFixed(1)},${adjustedTileBoundsY.toFixed(1)} ` +
          `${adjustedTileBoundsWidth.toFixed(1)}x${adjustedTileBoundsHeight.toFixed(1)}) - PAN DETECTED`);
      }
    }

    // CRITICAL FIX FOR VIEWPORT-ONLY RENDERING:
    // When rendering only visible tiles, size canvas to tile bounds, not full page.
    // This prevents huge canvases with sparse content at high zoom.
    let canvasWidth: number, canvasHeight: number;
    let canvasOffsetX = 0, canvasOffsetY = 0;

    if (isViewportOnly && tiles.length > 0 && effectiveBoundsWidth > 0 && effectiveBoundsHeight > 0) {
      // Viewport-only: canvas sized to EFFECTIVE bounds (snapshot if available, else tile-derived)
      // ASPECT RATIO FIX (2026-01-23): Derive height from width to preserve exact aspect ratio
      const boundsAspect = effectiveBoundsWidth / effectiveBoundsHeight;
      canvasWidth = Math.ceil(effectiveBoundsWidth * tileScale);
      canvasHeight = Math.round(canvasWidth / boundsAspect);
      canvasOffsetX = effectiveBoundsX;  // PDF coordinate offset
      canvasOffsetY = effectiveBoundsY;
      // ASPECT RATIO DIAGNOSTIC: Track buffer vs PDF bounds aspect ratio
      const bufferAspect = canvasWidth / canvasHeight;
      const pdfPageAspect = pdfWidth / pdfHeight;
      console.log(`[PdfPageElement] Viewport-only render: effectiveBounds=${effectiveBoundsX.toFixed(1)},${effectiveBoundsY.toFixed(1)} ${effectiveBoundsWidth.toFixed(1)}x${effectiveBoundsHeight.toFixed(1)}, canvas=${canvasWidth}x${canvasHeight}, bufferAspect=${bufferAspect.toFixed(4)}, boundsAspect=${boundsAspect.toFixed(4)}, pdfAspect=${pdfPageAspect.toFixed(4)}, usingSnapshot=${hasSnapshotBounds}`);
    } else {
      // Full page: canvas sized to full PDF dimensions
      // ASPECT RATIO FIX (2026-01-23): Derive height from width to preserve exact aspect ratio.
      // Previously, Math.ceil() was applied independently to width and height, causing
      // aspect ratio drift (e.g., 0.6622 vs 0.6624). This caused right-side text clipping
      // during mode transitions when source and destination had mismatched aspects.
      const pdfAspect = pdfWidth / pdfHeight;
      canvasWidth = Math.ceil(pdfWidth * tileScale);
      canvasHeight = Math.round(canvasWidth / pdfAspect);
    }

    // DOUBLE-BUFFERING: Use offscreen canvas to prevent blank flash during resize
    // When canvas dimensions change, resizing clears content. By drawing to an
    // offscreen buffer first, we can update the visible canvas atomically.
    const needsResize = this.canvas.width !== canvasWidth || this.canvas.height !== canvasHeight;

    // CONCURRENT RENDER FIX (2026-01-21): Use LOCAL offscreen canvas for each render.
    //
    // BUG: The shared class-member offscreenCanvas caused corruption when multiple
    // concurrent renderTiles() calls interleaved:
    //   1. Render A starts, resizes offscreen to 4896x6336, draws tiles
    //   2. Render B starts, resizes offscreen to 3166x4096, clears content
    //   3. Render A continues, draws its offscreen (now 3166x4096!) to main canvas
    //   → Content from Render A is stretched/corrupted
    //
    // FIX: Create a LOCAL offscreen canvas for each render. This eliminates sharing
    // and ensures each render has its own isolated compositing buffer.
    // GC handles cleanup automatically. Performance impact is minimal since
    // OffscreenCanvas creation is fast (~0.1ms).
    //
    // NOTE: The old reusable offscreen (this.offscreenCanvas) is still available
    // for non-tile operations. We just don't use it here anymore.
    const localOffscreen = document.createElement('canvas');
    localOffscreen.width = canvasWidth;
    localOffscreen.height = canvasHeight;
    const offCtx = localOffscreen.getContext('2d')!;

    // PROGRESSIVE RENDERING FIX (2026-01-21): Instead of clearing the canvas,
    // PRESERVE existing content and draw tiles on top. This ensures:
    // 1. Base layer (full-page render from lower zoom) remains visible
    // 2. High-res tiles are drawn on top for crisp rendering
    // 3. If some tiles fail, existing content prevents blank areas
    //
    // This mimics iOS CATiledLayer behavior where lower-res content shows
    // while higher-res tiles load progressively.
    //
    // VIEWPORT MODE CHANGE FIX (2026-01-21): Do NOT preserve content when
    // canvas offset OR size changes (e.g., full-page → viewport-only mode, or panning).
    // Stretching old content to fit new dimensions causes visual corruption.
    //
    // FIX (2026-01-21 v2): Also check SIZE change, not just offset change.
    // During panning, the offset might stay similar but the viewport SIZE changes
    // (e.g., different tile coverage). Stretching 800x1000 content to fit 750x980
    // causes distortion even when offset is similar.
    //
    // PANNING FIX (2026-01-21 v3): Also check TILE BOUNDS change, not just canvas offset.
    // When using full-page canvas (isViewportOnly=false), canvasOffsetX/Y are always (0,0)
    // but the ACTUAL tiles being rendered can change during panning. If we preserve
    // old content while rendering different tiles, old content from previous viewport
    // position shows through → overlapping/corrupted text.
    const offsetChanged =
      Math.abs(canvasOffsetX - this.lastCanvasOffsetX) > 1 ||
      Math.abs(canvasOffsetY - this.lastCanvasOffsetY) > 1;

    // SIZE CHANGE FIX: Detect when canvas dimensions change significantly
    const sizeChanged =
      Math.abs(this.lastCanvasWidth - canvasWidth) > 2 ||
      Math.abs(this.lastCanvasHeight - canvasHeight) > 2;

    // TILE BOUNDS CHANGE FIX (2026-01-21): Detect when actual tile coverage changes
    // This catches panning with full-page canvas where offset stays (0,0) but
    // tile content is completely different (e.g., panning from left to middle of page).
    // Use tileBoundsX/Y (PDF coordinates where tiles start) as the ground truth.
    const tileBoundsChanged =
      Math.abs(tileBoundsX - this.lastTileBoundsX) > 1 ||
      Math.abs(tileBoundsY - this.lastTileBoundsY) > 1 ||
      Math.abs(tileBoundsWidth - this.lastTileBoundsWidth) > 1 ||
      Math.abs(tileBoundsHeight - this.lastTileBoundsHeight) > 1;

    // SCALE CHANGE FIX (2026-01-21): Detect when tile scale changes (zoom change).
    // Even if viewport area is similar, different scales mean different pixel densities.
    // Preserving old content at s6 when rendering at s8 causes mixed-resolution corruption.
    const scaleChanged = this.lastTileScale !== 0 && this.lastTileScale !== tileScale;

    // INCOMPLETE COVERAGE FIX (2026-01-22): Detect when we have too few tiles.
    // When many tiles are dropped from the render queue, we get sparse coverage.
    // Preserving old content with sparse new tiles causes mixed old/new corruption.
    //
    // Calculate expected tile count for full canvas coverage:
    // NOTE: pdfTileSize * tileScale = (TILE_SIZE / tileScale) * tileScale = TILE_SIZE (256)
    const tileSizePixels = pdfTileSize * tileScale; // Should equal TILE_SIZE (256)
    const expectedTileCountX = Math.ceil(canvasWidth / tileSizePixels);
    const expectedTileCountY = Math.ceil(canvasHeight / tileSizePixels);
    const expectedTileCount = expectedTileCountX * expectedTileCountY;
    const actualTileCount = tiles.length;
    const coveragePercent = expectedTileCount > 0 ? (actualTileCount / expectedTileCount * 100) : 100;

    // BUG FIX (2026-01-22): Use 95% threshold instead of 50%.
    // At mid-zoom (6x), even 7 missing tiles out of 176 (4% failure) creates visible white gaps.
    // The 50% threshold was too lenient - ANY missing tiles at mid-zoom cause corruption.
    // 95% threshold triggers fallback when more than 5% of tiles are missing.
    const COVERAGE_THRESHOLD = 0.95;
    const hasIncompleteCoverage = actualTileCount < expectedTileCount * COVERAGE_THRESHOLD;

    // Always log coverage calculation at mid-zoom for debugging
    if (zoom >= 4) {
      console.error(`[COVERAGE-CALC] page=${this.config.pageNumber}: canvas=${canvasWidth}x${canvasHeight}, tileSizePixels=${tileSizePixels.toFixed(1)}, expected=${expectedTileCountX}x${expectedTileCountY}=${expectedTileCount}, actual=${actualTileCount}, coverage=${coveragePercent.toFixed(1)}%, incomplete=${hasIncompleteCoverage}`);
    }

    if (hasIncompleteCoverage && zoom >= 4) {
      console.warn(`[INCOMPLETE-COVERAGE] page=${this.config.pageNumber}: only ${actualTileCount}/${expectedTileCount} tiles (${coveragePercent.toFixed(0)}%), clearing canvas`);
    }

    // Don't preserve content if offset, size, tile bounds, scale changed, OR coverage is incomplete
    const shouldPreserveContent = !offsetChanged && !sizeChanged && !tileBoundsChanged && !scaleChanged && !hasIncompleteCoverage;

    if (offsetChanged || sizeChanged || tileBoundsChanged || scaleChanged || hasIncompleteCoverage) {
      console.log(`[VIEWPORT-CHANGE] page=${this.config.pageNumber}: ` +
        `offset: (${this.lastCanvasOffsetX.toFixed(0)},${this.lastCanvasOffsetY.toFixed(0)}) → (${canvasOffsetX.toFixed(0)},${canvasOffsetY.toFixed(0)}) [changed=${offsetChanged}], ` +
        `size: ${this.canvas.width}x${this.canvas.height} → ${canvasWidth}x${canvasHeight} [changed=${sizeChanged}], ` +
        `tileBounds: (${this.lastTileBoundsX.toFixed(0)},${this.lastTileBoundsY.toFixed(0)} ${this.lastTileBoundsWidth.toFixed(0)}x${this.lastTileBoundsHeight.toFixed(0)}) → (${tileBoundsX.toFixed(0)},${tileBoundsY.toFixed(0)} ${tileBoundsWidth.toFixed(0)}x${tileBoundsHeight.toFixed(0)}) [changed=${tileBoundsChanged}], ` +
        `scale: ${this.lastTileScale} → ${tileScale} [changed=${scaleChanged}], ` +
        `coverage: ${actualTileCount}/${expectedTileCount} [incomplete=${hasIncompleteCoverage}] - clearing canvas`);
    }

    // PROGRESSIVE RENDERING: Copy existing content to preserve base layer
    // With local offscreen canvas (CONCURRENT RENDER FIX), we always start fresh.
    // Copy existing main canvas content ONLY if:
    // 1. shouldPreserveContent=true (viewport hasn't changed)
    // 2. Canvas dimensions match (no stretching)
    // 3. Page was previously rendered
    //
    // LAST-RESORT FALLBACK (2026-01-22): When hasIncompleteCoverage is true, we may have
    // no cached full-page render to use as fallback. In this case, preserving old canvas
    // content (even if at wrong scale) is MUCH better than showing blank areas.
    // The tiles that DO arrive will overdraw the stale content with sharp new content.
    //
    // NOTE: Check canvas dimensions > 300 (default canvas is 300x150) to ensure we have real content.
    //
    // VIEWPORT-ONLY CORRUPTION FIX (amnesia-d9f 2026-01-23): In viewport-only mode,
    // do NOT preserve old content when viewport position changed. At high zoom, the
    // viewport shifts with every pan gesture. If we preserve old content from a DIFFERENT
    // viewport position, it gets mixed with new tiles at the CURRENT position → corruption.
    //
    // Only preserve when BOTH conditions are met:
    // 1. Incomplete coverage (need fallback)
    // 2. Viewport hasn't changed significantly (content is still at correct position)
    //
    // In viewport-only mode, even 1px offset change means content is misaligned.
    //
    // PAN CORRUPTION FIX (amnesia-e4i 2026-01-23): NEVER preserve old content when tile
    // bounds changed during pan. Old content from different viewport position will get
    // mixed with new tiles, causing overlapping/corrupted text. This was the root cause
    // of the pan corruption bug - incomplete coverage triggered "last resort" fallback
    // which preserved stale canvas content from previous pan position.
    //
    // Better to show blank gaps temporarily than corrupted overlapping content.
    const hasRealCanvasContent = this.canvas.width > 300 && this.canvas.height > 150;
    const viewportPositionUnchanged = !offsetChanged && !tileBoundsChanged;
    // CRITICAL: Scale must also match - preserving content at wrong scale causes stretching
    const preserveAsLastResort = hasIncompleteCoverage && hasRealCanvasContent && viewportPositionUnchanged && !scaleChanged;

    console.log(`[PRESERVE-CHECK] page=${this.config.pageNumber}: shouldPreserve=${shouldPreserveContent}, preserveAsLastResort=${preserveAsLastResort}, hasIncompleteCoverage=${hasIncompleteCoverage}, isRendered=${this.isRendered}, canvas=${this.canvas.width}x${this.canvas.height}, hasRealContent=${hasRealCanvasContent}`);

    if ((shouldPreserveContent || preserveAsLastResort) && hasRealCanvasContent) {
      try {
        // Scale old content to fit new canvas dimensions if they differ
        // This creates a blurry base layer, but better than blank
        offCtx.drawImage(this.canvas, 0, 0, this.canvas.width, this.canvas.height, 0, 0, canvasWidth, canvasHeight);
        if (preserveAsLastResort && !shouldPreserveContent) {
          console.log(`[LAST-RESORT-FALLBACK] page=${this.config.pageNumber}: preserving old canvas (${this.canvas.width}x${this.canvas.height}) as base for new render (${canvasWidth}x${canvasHeight}) due to incomplete coverage`);
        }
      } catch {
        // Ignore errors (e.g., if canvas is tainted or empty)
        // Local canvas starts transparent, so tiles will draw on clean slate
      }
    }
    // Otherwise: localOffscreen starts transparent (clean slate for new content)

    // Update tracked offset, size, and tile bounds for next render
    this.lastCanvasOffsetX = canvasOffsetX;
    this.lastCanvasOffsetY = canvasOffsetY;
    this.lastCanvasWidth = canvasWidth;
    this.lastCanvasHeight = canvasHeight;
    // PANNING FIX: Track tile bounds to detect content changes during panning
    this.lastTileBoundsX = tileBoundsX;
    this.lastTileBoundsY = tileBoundsY;
    this.lastTileBoundsWidth = tileBoundsWidth;
    this.lastTileBoundsHeight = tileBoundsHeight;
    // SCALE CHANGE FIX: Track tile scale to detect zoom changes
    this.lastTileScale = tileScale;

    // Configure offscreen context
    offCtx.imageSmoothingEnabled = true;
    offCtx.imageSmoothingQuality = 'high';

    // BASE LAYER FALLBACK FIX (2026-01-21): Draw a cached full-page render as base layer
    // to fill gaps when tiles fail or don't cover the full page.
    //
    // The original condition checked tile INDICES, not actual success count.
    // When many tiles fail but remaining tiles still span the full index range,
    // there are gaps in the rendered grid.
    //
    // CONDITION: Draw base layer when:
    // 1. forceFullPage is true (mode transition - need complete coverage), OR
    // 2. Tiles don't cover full page by indices AND we're in full-page mode
    //
    // NOTE: We intentionally do NOT always draw base layer because:
    // - Cached base layer may be at different scale/position than current tiles
    // - Drawing misaligned base layer causes grey strips and visual artifacts
    // - When tiles succeed, they should fully cover the canvas
    //
    // In viewport-only mode (isViewportOnly=true), canvas is sized to tile bounds,
    // so drawing a full-page fallback stretched to this small canvas doesn't make sense.
    // INCOMPLETE COVERAGE FIX (2026-01-22): Also draw base layer when tile coverage is sparse.
    // The original tilesNotCoveringFullPage checks tile INDEX range, not actual tile count.
    // When 61/165 tiles fail, indices still span the full page but there are gaps.
    // hasIncompleteCoverage (< 50% of expected tiles) catches this case.
    const shouldDrawBaseLayer = forceFullPage || (tilesNotCoveringFullPage && !isViewportOnly) || hasIncompleteCoverage;
    console.log(`[BASE-LAYER-DEBUG] page=${this.config.pageNumber}: shouldDrawBaseLayer=${shouldDrawBaseLayer}, tilesNotCoveringFullPage=${tilesNotCoveringFullPage}, isViewportOnly=${isViewportOnly}, forceFullPage=${forceFullPage}, hasIncompleteCoverage=${hasIncompleteCoverage}`);
    if (shouldDrawBaseLayer) {
      try {
        const cacheManager = getTileCacheManager();
        console.log(`[BASE-LAYER-DEBUG] page=${this.config.pageNumber}: fetching cached full-page at scale ${tileScale}...`);
        const fallback = await cacheManager.getBestAvailableFullPageBitmap(
          this.config.pageNumber,
          tileScale
        );
        console.log(`[BASE-LAYER-DEBUG] page=${this.config.pageNumber}: fallback result = ${fallback ? `found at scale ${fallback.actualScale}` : 'null (not cached)'}`);
        if (fallback) {
          // BASE LAYER SCALE MISMATCH FIX (2026-01-21): Reject fallback at wrong scale.
          //
          // BUG: When base layer fallback is at significantly different scale (e.g., scale 2
          // when current zoom needs scale 8), it gets stretched to fit the canvas. This creates
          // a blurry/wrong-scale base layer. If some tiles fail, this low-res content shows
          // through, causing visual corruption (mix of sharp tiles + blurry fallback).
          //
          // FIX: Only use fallback if cssStretch is close to 1.0 (within 50%).
          // Better to have blank areas than corrupted mixed-scale content.
          //
          // INCOMPLETE COVERAGE FIX (2026-01-22): Relax stretch limit when tiles are sparse.
          // When hasIncompleteCoverage is true (< 95% tiles), the alternative is blank areas.
          // A blurry upscaled base layer is MUCH better than seeing gaps. The tiles
          // that DO arrive will render sharply on top, giving acceptable visual quality.
          //
          // BUG FIX (2026-01-22): Increased from 4.0x to 8.0x.
          // At 6x zoom with 164% base render, cssStretch=6.0x which was being rejected.
          // Even an 8x blurry base is far better than white gaps in text.
          //
          // HIGH-ZOOM FIX (2026-01-23): At very high zoom (e.g., 32×), tile coverage is
          // always incomplete because the viewport is tiny compared to the full-page canvas.
          // If the best cached fallback is at scale 1-2, cssStretch can be 8-16×.
          // At high zoom, ANY fallback is better than blank canvas.
          // Use dynamic limit: max(8, tileScale) to scale with zoom level.
          const baseMaxStretch = 1.5;
          const incompleteMaxStretch = Math.max(8.0, tileScale); // Scale with zoom - at scale 16, allow 16× stretch
          const maxAllowedStretch = hasIncompleteCoverage ? incompleteMaxStretch : baseMaxStretch;
          const isStretchTooLarge = fallback.cssStretch > maxAllowedStretch;

          if (isStretchTooLarge) {
            console.warn(`[BASE-LAYER-REJECT] page=${this.config.pageNumber}: rejecting fallback with ` +
              `cssStretch=${fallback.cssStretch.toFixed(2)}x (max allowed: ${maxAllowedStretch}x, ` +
              `mode=${hasIncompleteCoverage ? 'incomplete-coverage' : 'normal'}). ` +
              `Actual scale ${fallback.actualScale}, requested ${tileScale}`);
            fallback.bitmap.close();
          } else {
            // Draw fallback at correct scale to cover the full canvas
            // The fallback might be at a lower scale, so we stretch it to fit
            offCtx.drawImage(fallback.bitmap, 0, 0, canvasWidth, canvasHeight);
            fallback.bitmap.close();
            console.log(`[BASE-LAYER-FALLBACK] page=${this.config.pageNumber}: using cached full-page at scale ${fallback.actualScale} (requested ${tileScale}), stretch=${fallback.cssStretch.toFixed(2)}x, mode=${hasIncompleteCoverage ? 'incomplete-coverage' : 'normal'}`);
          }
        }
      } catch (e) {
        // Fallback fetch failed - continue without base layer
        console.warn(`[BASE-LAYER-FALLBACK] page=${this.config.pageNumber}: failed to get cached full-page:`, e);
      }
    }

    // Draw each tile at its correct position (1:1 with tile resolution)
    // Each tile covers (TILE_SIZE / tileScale) PDF points and is TILE_SIZE pixels
    // For viewport-only rendering, positions are relative to canvasOffsetX/Y
    let tilesDrawn = 0;
    let tilesSkippedOutOfBounds = 0;

    // amnesia-e4i PAN DIAGNOSTIC: Log critical compositing parameters once per render
    const compositeParams = {
      page: this.config.pageNumber,
      zoom: zoom.toFixed(2),
      tileScale,
      canvasSize: `${canvasWidth}x${canvasHeight}`,
      canvasOffset: `(${canvasOffsetX.toFixed(1)}, ${canvasOffsetY.toFixed(1)})`,
      pdfTileSize: pdfTileSize.toFixed(2),
      isViewportOnly,
      tileCount: tiles.length,
      tileBounds: `(${tileBoundsX.toFixed(1)}, ${tileBoundsY.toFixed(1)}) ${tileBoundsWidth.toFixed(1)}x${tileBoundsHeight.toFixed(1)}`,
      hasSnapshotBounds,
    };
    console.log(`[COMPOSITE-START] page=${this.config.pageNumber}`, compositeParams);

    // Update diagnostic overlay with live data
    try {
      const idealScale = zoom * this.config.pixelRatio;
      const uniqueScales = [...new Set(tiles.map(t => t.tile.scale))];
      getTileDiagnosticOverlay().update({
        zoom,
        tileScale,
        requestedScale: idealScale,
        pixelRatio: this.config.pixelRatio,
        renderMode: isViewportOnly ? 'tiled' : 'tiled',
        scaleMismatch: uniqueScales.length > 1 || Math.abs(tileScale - idealScale) > 2,
        lastTileCoords: tiles.slice(0, 5).map(t => ({
          page: t.tile.page,
          x: t.tile.tileX,
          y: t.tile.tileY,
          scale: t.tile.scale,
        })),
      });
    } catch { /* ignore if overlay not initialized */ }

    // amnesia-e4i: Build set of tile positions that have target-scale tiles
    // A target-scale tile has cssStretch close to 1.0 (within tolerance)
    // We'll skip drawing fallback tiles if a target-scale tile exists for the same position
    const TARGET_STRETCH_TOLERANCE = 0.1;
    const targetScalePositions = new Set<string>();
    for (const { tile, cssStretch } of tiles) {
      const effectiveStretch = cssStretch ?? (tileScale / tile.scale);
      if (Math.abs(effectiveStretch - 1.0) <= TARGET_STRETCH_TOLERANCE) {
        targetScalePositions.add(`${tile.tileX},${tile.tileY}`);
      }
    }
    
    let fallbacksSkipped = 0;
    
    for (const { tile, bitmap, cssStretch } of tiles) {
      // 2026-01-24 FIX: Skip oversized bitmaps (likely corrupted full-page data stored as tiles)
      // A tile bitmap should be at most (tileSize * 4 * 2) per dimension to account for high-DPI
      const tileSizeForValidation = tile.tileSize ?? actualTileSize;
      const MAX_TILE_DIM = tileSizeForValidation * 4 * 2; // e.g., 256 * 4 * 2 = 2048
      if (bitmap.width > MAX_TILE_DIM || bitmap.height > MAX_TILE_DIM) {
        console.error(`[TILE-SKIP-OVERSIZED] page=${this.config.pageNumber} tile(${tile.tileX},${tile.tileY}): ` +
          `bitmap ${bitmap.width}x${bitmap.height} exceeds max ${MAX_TILE_DIM}. Skipping corrupted tile.`);
        bitmap.close();
        continue;
      }
      
      // amnesia-e4i: Skip fallback tiles if target-scale tile exists for this position
      const tilePositionKey = `${tile.tileX},${tile.tileY}`;
      const effectiveStretch = cssStretch ?? (tileScale / tile.scale);
      const isFallbackTile = Math.abs(effectiveStretch - 1.0) > TARGET_STRETCH_TOLERANCE;
      
      if (isFallbackTile && targetScalePositions.has(tilePositionKey)) {
        // Skip this fallback - we have a better tile for this position
        fallbacksSkipped++;
        continue;
      }
      
      // MULTI-SCALE FIX (amnesia-d9f): Use CONSISTENT target scale for ALL tile positions.
      //
      // BUG: When tiles arrive at different scales (e.g., scale 6 and scale 16), using
      // tile.scale for positioning causes tiles to appear at different visual sizes:
      // - Scale-6 tile: position = pdfPos * 6
      // - Scale-16 tile: position = pdfPos * 16
      // Result: tiles overlap/gap incorrectly, causing visual corruption.
      //
      // FIX: Use the target tileScale (from first tile or calculated) for ALL positioning.
      // If a tile was rendered at a different scale, use cssStretch to scale its bitmap
      // to fill the correct visual area on canvas.
      //
      // cssStretch = tileScale / tile.scale
      // - tile.scale < tileScale: cssStretch > 1 (stretch lower-res tile up)
      // - tile.scale = tileScale: cssStretch = 1 (no adjustment)
      // - tile.scale > tileScale: cssStretch < 1 (shrink higher-res tile down)
      const tileStretch = cssStretch ?? (tileScale / tile.scale);

      // Position in PDF coordinates (absolute page position)
      // MULTI-SCALE FIX (amnesia-e4i): Use TILE'S OWN SCALE for position calculation!
      //
      // BUG: Previously used pdfTileSize (from tileScale) for ALL tiles. But tile indices
      // (tileX, tileY) are generated based on EACH tile's own scale, not tileScale!
      //
      // Example at scale 8: pdfTileSize = 256/8 = 32, tile (5,3) covers PDF (160, 96)
      // Example at scale 12: pdfTileSize = 256/12 = 21.33, tile (5,3) covers PDF (106.67, 64)
      //
      // If we use scale-12's pdfTileSize (21.33) to position a scale-8 tile (5,3):
      // - tilePdfX = 5 * 21.33 = 106.67 (WRONG! Should be 5 * 32 = 160)
      // - Tile content from region (160-192) gets placed at (106.67-128)
      // - Result: tiles appear at wrong positions, causing overlapping/gaps
      //
      // FIX: Calculate each tile's PDF position using its own scale AND tileSize.
      //
      // amnesia-e4i CRITICAL FIX: Use tile.tileSize (if set) instead of actualTileSize!
      // The tile.tileSize is the CSS pixel size that was used when the tile was created.
      // actualTileSize is based on CURRENT zoom, which may differ from when tile was cached.
      //
      // Example: Tile cached at zoom=16 (tileSize=512), now rendering at zoom=17
      // - actualTileSize = getTileSize(17) = 256 (WRONG for this tile!)
      // - tile.tileSize = 512 (CORRECT - the size used when tile was created)
      //
      // Without this fix, tile (5,3) at scale=16 would be positioned at:
      // - tilePdfTileSize = 256/16 = 16
      // - tilePdfX = 5 * 16 = 80 (WRONG! Should be 5 * 32 = 160)
      const tileTileSize = tile.tileSize ?? actualTileSize;
      const tilePdfTileSize = tileTileSize / tile.scale;
      const tilePdfX = tile.tileX * tilePdfTileSize;
      const tilePdfY = tile.tileY * tilePdfTileSize;

      // Canvas position: Convert PDF position to canvas pixels at TARGET scale
      // All tiles render to canvas at tileScale, regardless of their source scale.
      // The cssStretch/drawImage handles the visual scaling of the bitmap content.
      const canvasX = Math.round((tilePdfX - canvasOffsetX) * tileScale);
      const canvasY = Math.round((tilePdfY - canvasOffsetY) * tileScale);

      // OUT-OF-BOUNDS SAFETY CHECK (Council-validated 2026-01-21):
      // With the coordinate clamping fix in tile-render-engine.ts, this check
      // should rarely trigger. If it does, it's a regression indicator.
      //
      // Keep as defensive check but treat triggers as potential bugs.
      if (canvasX >= canvasWidth || canvasY >= canvasHeight || canvasX < -4096 || canvasY < -4096) {
        // REGRESSION INDICATOR: Should not trigger after clamping fix
        if (tilesSkippedOutOfBounds === 0) {
          console.warn(
            `[PdfPageElement] OUT-OF-BOUNDS TILE DETECTED - coordinate clamping regression?`,
            {
              page: this.config.pageNumber,
              tile: { x: tile.tileX, y: tile.tileY, scale: tile.scale },
              tilePdf: { x: tilePdfX.toFixed(1), y: tilePdfY.toFixed(1) },
              canvasOffset: { x: canvasOffsetX.toFixed(1), y: canvasOffsetY.toFixed(1) },
              canvasPos: { x: canvasX, y: canvasY },
              canvasSize: { w: canvasWidth, h: canvasHeight },
              pdfSize: { w: pdfWidth.toFixed(1), h: pdfHeight.toFixed(1) },
              zoom: this.currentZoom,
            }
          );
        }
        bitmap.close();
        tilesSkippedOutOfBounds++;
        continue;
      }

      // Calculate target draw size using TILE'S OWN SCALE (not tileScale)
      // This determines how large the tile SHOULD appear on canvas at target scale
      // MULTI-SCALE FIX (amnesia-e4i): Use tile's own scale for next position too
      const nextPdfX = (tile.tileX + 1) * tilePdfTileSize;
      const nextPdfY = (tile.tileY + 1) * tilePdfTileSize;
      const nextCanvasX = Math.round((Math.min(nextPdfX, pdfWidth) - canvasOffsetX) * tileScale);
      const nextCanvasY = Math.round((Math.min(nextPdfY, pdfHeight) - canvasOffsetY) * tileScale);

      // Draw size: target area this tile should cover at tileScale
      const drawWidth = nextCanvasX - canvasX;
      const drawHeight = nextCanvasY - canvasY;

      // Skip tiles with zero size (can happen at page edges)
      if (drawWidth <= 0 || drawHeight <= 0) {
        bitmap.close();
        continue;
      }

      // MULTI-SCALE FIX (amnesia-d9f): Draw bitmap with stretch compensation.
      //
      // The tile bitmap may be at a different scale than tileScale:
      // - If tile.scale < tileScale: bitmap is lower-res, needs upscaling (stretch > 1)
      // - If tile.scale = tileScale: bitmap is at target res, no scaling needed
      // - If tile.scale > tileScale: bitmap is higher-res, needs downscaling (stretch < 1)
      //
      // drawImage() handles the scaling: we draw the full bitmap into the target area.
      // Browser scales bitmap.width×bitmap.height → drawWidth×drawHeight

      // amnesia-e4i PAN DIAGNOSTIC: Log first 3 tiles per render to diagnose positioning
      if (tilesDrawn < 3) {
        console.log(`[TILE-DRAW-DETAIL] page=${this.config.pageNumber} tile#${tilesDrawn}:`, {
          coord: `(${tile.tileX}, ${tile.tileY})`,
          tileScale: tile.scale,
          targetScale: tileScale,
          tilePdfTileSize: tilePdfTileSize.toFixed(2),
          targetPdfTileSize: pdfTileSize.toFixed(2),
          cssStretch: tileStretch.toFixed(2),
          pdfPos: `(${tilePdfX.toFixed(1)}, ${tilePdfY.toFixed(1)})`,
          canvasPos: `(${canvasX}, ${canvasY})`,
          drawSize: `${drawWidth}x${drawHeight}`,
          bitmapSize: `${bitmap.width}x${bitmap.height}`,
          canvasOffset: `(${canvasOffsetX.toFixed(1)}, ${canvasOffsetY.toFixed(1)})`,
        });
      }

      offCtx.drawImage(
        bitmap,
        0, 0, bitmap.width, bitmap.height,  // Source: full bitmap
        canvasX, canvasY, drawWidth, drawHeight  // Dest: target area at tileScale
      );

      // COORDINATE DEBUG: Log first 3 tiles to trace positioning (with scale info)
      if (tilesDrawn < 3) {
        const scaleInfo = tile.scale !== tileScale 
          ? `, tileScale=${tile.scale}→${tileScale} (stretch=${tileStretch.toFixed(2)})`
          : '';
        console.log(`[TILE-COORD-DEBUG] page=${this.config.pageNumber}, tile(${tile.tileX},${tile.tileY}): pdfPos=(${tilePdfX.toFixed(0)},${tilePdfY.toFixed(0)}), canvasPos=(${canvasX},${canvasY}), size=${drawWidth}x${drawHeight}, bmpSize=${bitmap.width}x${bitmap.height}${scaleInfo}`);
      }

      // Close bitmap to free memory - we own it (created fresh from cache)
      bitmap.close();
      tilesDrawn++;
    }

    // DEBUG: Log tiles drawn with render sequence
    const skipInfo = [
      tilesSkippedOutOfBounds > 0 ? `${tilesSkippedOutOfBounds} OOB` : '',
      fallbacksSkipped > 0 ? `${fallbacksSkipped} fallbacks replaced` : '',
    ].filter(Boolean).join(', ');
    
    if (skipInfo) {
      console.error(`[TILE-DRAW] seq=${renderSeq} page=${this.config.pageNumber} Drew ${tilesDrawn}/${tiles.length} tiles, canvas=${canvasWidth}x${canvasHeight} (${skipInfo}), forceFullPage=${!isViewportOnly}`);
    } else {
      console.error(`[TILE-DRAW] seq=${renderSeq} page=${this.config.pageNumber} Drew ${tilesDrawn} tiles, canvas=${canvasWidth}x${canvasHeight}, forceFullPage=${!isViewportOnly}`);
    }

    // ALL-TILES-OUT-OF-BOUNDS FIX: If all tiles were skipped, throw an error
    // to trigger fallback to full-page rendering in the caller.
    // This can happen at extreme zoom when tile coordinates are calculated for
    // regions entirely outside the visible page.
    if (tilesDrawn === 0 && tiles.length > 0) {
      throw new Error(`[PdfPageElement] All ${tiles.length} tiles were out of bounds (skipped ${tilesSkippedOutOfBounds}). Need full-page fallback.`);
    }

    // ==========================================================================
    // CONCURRENT RENDER GATE #1: Check BEFORE modifying main canvas
    // ==========================================================================
    // This is the FIRST gate. We've drawn tiles to localOffscreen buffer,
    // but haven't touched the main canvas yet. If a newer render has started,
    // discard this render NOW before we corrupt the canvas buffer/CSS.
    if (renderSeq !== this.latestRenderSeq) {
      console.warn(`[RENDER-SEQ] page=${this.config.pageNumber} seq=${renderSeq} DISCARDED-EARLY ` +
        `(latestRenderSeq=${this.latestRenderSeq}) - stale before canvas update`);
      return;
    }

    // Now atomically update the visible canvas
    // Resize main canvas if needed (this clears it, but we immediately redraw)
    //
    // PAN DIAGNOSTIC: Track canvas state changes during panning
    // The stretch bug often occurs when canvas buffer is resized but CSS hasn't updated yet
    const prevBuffer = { w: this.canvas.width, h: this.canvas.height };
    const prevCss = {
      w: parseFloat(this.canvas.style.width) || 0,
      h: parseFloat(this.canvas.style.height) || 0,
      transform: this.canvas.style.transform || 'none',
    };

    if (needsResize) {
      this.canvas.width = canvasWidth;
      this.canvas.height = canvasHeight;

      // PAN DIAGNOSTIC: Log buffer resize with previous state
      console.log(`[PAN-DIAG] seq=${renderSeq} page=${this.config.pageNumber}: BUFFER RESIZE ` +
        `prev=${prevBuffer.w}x${prevBuffer.h} → new=${canvasWidth}x${canvasHeight}, ` +
        `prevCss=${prevCss.w}x${prevCss.h}, prevTransform="${prevCss.transform}"`);
    }

    // CSS display size and positioning
    // For viewport-only rendering, canvas covers only visible tiles and is positioned at offset
    // For full-page rendering, canvas covers the entire page

    // UNIFIED COORDINATE SPACE: Simplified tile positioning
    // In unified space, page elements are already at their final zoomed size.
    // Tiles are positioned exactly without CSS scale transforms.
    // NOTE: Unified space is disabled - use legacy mode.
    const useUnifiedSpace: boolean = false;

    // CONCURRENT RENDER FIX (amnesia-d9f 2026-01-23): Compute CSS values but DON'T apply yet.
    // The CSS application must happen AFTER the concurrency gate to prevent
    // race conditions where concurrent renders overwrite each other's CSS transforms.
    // These variables are set in both UNIFIED and LEGACY branches.
    let pendingCssWidth = 0;
    let pendingCssHeight = 0;
    let pendingCssTransform = '';
    let pendingCssTransformOrigin = '';
    let pendingCssOffsetX = 0;
    let pendingCssOffsetY = 0;

    if (useUnifiedSpace) {
      // UNIFIED: Direct tile positioning without cssStretch
      // Canvas covers visible tiles and is positioned at exact offset
      const dpr = window.devicePixelRatio || 2;

      // In unified space:
      // - Page is at final size (this.finalWidth × this.finalHeight or currentWidth × currentHeight)
      // - Canvas buffer size = tile bounds in pixels
      // - CSS size = buffer / dpr for sharp rendering
      // - Position = tile bounds offset scaled to page element coordinates

      // Calculate position in page element coordinates
      // Note: In unified space, page element is sized to zoom * PDF dimensions
      // So we scale from PDF coordinates to page element coordinates
      // TRANSFORM SNAPSHOT FIX: Use pdfToElementScale from snapshot when available.
      const pageToElementScale = transformSnapshot?.pdfToElementScale ?? (effectiveWidth / pdfWidth);
      const elementOffsetX = canvasOffsetX * pageToElementScale;
      const elementOffsetY = canvasOffsetY * pageToElementScale;

      // CSS size for sharp rendering (buffer / dpr)
      const cssWidth = canvasWidth / dpr;
      const cssHeight = canvasHeight / dpr;

      // The tile bounds in element coordinates (use adjusted bounds for invalid tile edge case)
      let elementBoundsWidth = adjustedTileBoundsWidth * pageToElementScale;
      let elementBoundsHeight = adjustedTileBoundsHeight * pageToElementScale;

      // DIMENSION MATCH FIX: When bounds were invalid, use container dimensions directly.
      if (useContainerDimensionsDirectly) {
        elementBoundsWidth = this.currentWidth;
        elementBoundsHeight = this.currentHeight;
      }

      // Scale to fit CSS-sized canvas into element bounds
      // PAGE SCALE STABILITY FIX (Remediation Plan 2026-01-19):
      // UNIFIED mode: Canvas CSS size = tile bounds in element coordinates, NO scale transform.
      // The high-res buffer provides crisp pixels when camera zooms.

      // CONCURRENT RENDER FIX: Store CSS values for application after gate
      pendingCssWidth = Math.round(elementBoundsWidth);
      pendingCssHeight = Math.round(elementBoundsHeight);
      pendingCssTransform = `translate(${elementOffsetX}px, ${elementOffsetY}px)`; // NO scale
      pendingCssTransformOrigin = '0 0';
      pendingCssOffsetX = elementOffsetX;
      pendingCssOffsetY = elementOffsetY;

      console.log(`[STABILITY-FIX] UNIFIED buffer=${canvasWidth}×${canvasHeight}, css=${elementBoundsWidth.toFixed(1)}×${elementBoundsHeight.toFixed(1)}, offset=${elementOffsetX.toFixed(1)},${elementOffsetY.toFixed(1)} (snapshot: ${usedSnapshot}) (PENDING - after gate)`);
    } else {
      // LEGACY: Direct tile positioning (cssStretch tracking removed - amnesia-c7w)
      const coordDebugger = getCoordinateDebugger();

      if (isViewportOnly) {
      // VIEWPORT-ONLY: Canvas covers only visible tiles, positioned at offset
      //
      // PAGE SCALE STABILITY FIX (Remediation Plan 2026-01-19):
      // Eliminate fitScale CSS transform entirely. The camera transform is the ONLY zoom mechanism.
      //
      // Strategy:
      // 1. Canvas CSS size = tile bounds in page coordinates (FIXED relative to container)
      // 2. Canvas buffer = high resolution (provides crisp pixels when camera zooms)
      // 3. Transform = translate only (position within container, NO scale)
      // 4. Camera transform handles ALL visual zoom magnification
      //
      // This eliminates the "two transforms fighting" problem that caused focal point drift.

      // Calculate the tile bounds in page element coordinates
      // TRANSFORM SNAPSHOT FIX: Use pdfToElementScale from snapshot when available.
      // The snapshot captures this value at tile REQUEST time.
      // Using current dimensions (which may have changed during render) causes position mismatch.
      // Fall back to calculation from effectiveWidth for backwards compatibility.
      //
      // STALE SNAPSHOT GUARD (2026-01-23): Detect when snapshot is stale due to layout change.
      // This happens when container dimensions change between tile request and render
      // (e.g., PDF Dimension Unification changed from baseWidth=400 to native 441).
      // A stale snapshot causes buffer/CSS aspect mismatch → visual corruption.
      const snapshotPdfToElementScale = transformSnapshot?.pdfToElementScale;
      const currentPdfToElementScale = effectiveWidth / pdfWidth;

      // Check for significant divergence (>5% indicates stale snapshot)
      const scaleDivergence = snapshotPdfToElementScale !== undefined
        ? Math.abs(snapshotPdfToElementScale - currentPdfToElementScale) / currentPdfToElementScale
        : 0;
      const isSnapshotStale = scaleDivergence > 0.01;

      if (isSnapshotStale) {
        console.warn(`[STALE-SNAPSHOT] page=${this.config.pageNumber}: ` +
          `snapshot.pdfToElementScale=${snapshotPdfToElementScale?.toFixed(4)}, ` +
          `current=${currentPdfToElementScale.toFixed(4)}, ` +
          `divergence=${(scaleDivergence * 100).toFixed(1)}% - using current dimensions`);
      }

      // Use current dimensions when snapshot is stale to prevent buffer/CSS aspect mismatch
      const pdfToElementScale = isSnapshotStale ? currentPdfToElementScale : (snapshotPdfToElementScale ?? currentPdfToElementScale);
      
      // 2026-01-24 FIX: Use effectiveBounds for CSS sizing to match canvas sizing.
      // PROBLEM: Canvas is sized from effectiveBounds (snapshot when available), but CSS was
      // sized from adjustedTileBounds (derived from tiles). When these differ (pan during render),
      // we get aspect ratio mismatch → visual corruption.
      // FIX: Use effectiveBounds for BOTH canvas AND CSS sizing for consistency.
      let layoutBoundsWidth = effectiveBoundsWidth * pdfToElementScale;
      let layoutBoundsHeight = effectiveBoundsHeight * pdfToElementScale;

      // DIMENSION MATCH FIX: When bounds were invalid (useContainerDimensionsDirectly=true),
      // use container dimensions directly to avoid 1px mismatch from PDF aspect ratio calculation.
      if (useContainerDimensionsDirectly) {
        layoutBoundsWidth = this.currentWidth;
        layoutBoundsHeight = this.currentHeight;
      }

      // Position within page element coordinate system
      const cssOffsetX = canvasOffsetX * pdfToElementScale;
      const cssOffsetY = canvasOffsetY * pdfToElementScale;

      // NOTE: OVERFLOW-SAFEGUARD REMOVED (2026-01-22)
      // The previous safeguard clamped CSS dimensions to container bounds to prevent
      // content from visually escaping the page during rapid zoom transitions.
      //
      // PROBLEM: This created a BUFFER-CSS ASPECT RATIO MISMATCH:
      // - Canvas buffer sized to tile bounds (e.g., 7056x9728)
      // - CSS clamped to smaller size (e.g., 400x551 instead of 400x604)
      // - Browser stretches buffer to fit CSS → visual corruption (scattered text)
      //
      // FIX: Remove the safeguard. The container element has overflow:hidden which
      // naturally clips any overflow. Let buffer and CSS maintain consistent aspect ratios.
      //
      // If overflow becomes an issue, the fix should clamp tile bounds EARLIER
      // (before buffer sizing) so both buffer AND CSS use the same clamped values.

      // Canvas CSS size = tile bounds in page coordinates (FIXED, no fitScale)
      // The high-res buffer provides oversampling for crisp rendering when camera zooms
      // H1 FIX: Use Math.round() for CSS dimensions to match integer canvas buffer dimensions.
      // CONCURRENT RENDER FIX: Store values for application after gate, don't apply directly
      pendingCssWidth = Math.round(layoutBoundsWidth);
      pendingCssHeight = Math.round(layoutBoundsHeight);

      // BUFFER-CSS ASPECT TRACKING: Log whenever buffer and CSS aspects diverge significantly
      // This helps diagnose stretching issues during mode transitions
      const cssLayoutAspect = layoutBoundsWidth / layoutBoundsHeight;
      const bufferAspectForCss = canvasWidth / canvasHeight;
      const aspectDivergence = Math.abs(cssLayoutAspect - bufferAspectForCss) / cssLayoutAspect;

      // ASPECT DIVERGENCE ABORT GUARD (2026-01-23): Abort render when aspect divergence is severe.
      // Severe divergence (>10%) indicates corrupted coordinate calculation that will produce
      // visually broken output (scattered text fragments). Better to show nothing than corruption.
      const SEVERE_DIVERGENCE_THRESHOLD = 0.02; // 2%
      if (aspectDivergence > SEVERE_DIVERGENCE_THRESHOLD) {
        console.error(`[ASPECT-ABORT] page=${this.config.pageNumber}: ` +
          `buffer=${canvasWidth}x${canvasHeight} (aspect=${bufferAspectForCss.toFixed(4)}), ` +
          `css=${layoutBoundsWidth.toFixed(0)}x${layoutBoundsHeight.toFixed(0)} (aspect=${cssLayoutAspect.toFixed(4)}), ` +
          `divergence=${(aspectDivergence * 100).toFixed(1)}% EXCEEDS ${SEVERE_DIVERGENCE_THRESHOLD * 100}% - ABORTING RENDER`);
        // Close all bitmaps to prevent memory leak
        for (const { bitmap } of tiles) {
          bitmap.close();
        }
        return;
      }

      if (aspectDivergence > 0.01) {
        console.warn(`[BUFFER-CSS-DIVERGENCE] page=${this.config.pageNumber}: buffer=${canvasWidth}x${canvasHeight} (aspect=${bufferAspectForCss.toFixed(4)}), css=${layoutBoundsWidth.toFixed(0)}x${layoutBoundsHeight.toFixed(0)} (aspect=${cssLayoutAspect.toFixed(4)}), divergence=${(aspectDivergence * 100).toFixed(1)}%`);
      }

      // Transform = translate only (NO scale) - camera handles all zoom
      // CONCURRENT RENDER FIX: Store for application after gate
      pendingCssTransform = `translate(${cssOffsetX}px, ${cssOffsetY}px)`;
      pendingCssTransformOrigin = '0 0';
      pendingCssOffsetX = cssOffsetX;
      pendingCssOffsetY = cssOffsetY;

      // RACE CONDITION DETECTION: Check if this render is overwriting a recent zoom reset
      const timeSinceReset = performance.now() - this.lastZoomResetTime;
      if (this.lastZoomResetTime > 0 && timeSinceReset < 500) {
        console.warn(`[ZOOM-RESET-OVERWRITE] page=${this.config.pageNumber}: ` +
          `Render overwriting zoom reset! timeSinceReset=${timeSinceReset.toFixed(0)}ms, ` +
          `newTransform="${pendingCssTransform}" (epoch valid: ${epochValid})`);
      }

      // NOTE: CSS is now applied AFTER the concurrency gate - see below

      // PAN DIAGNOSTIC: Log CSS update with prev state comparison
      // If prevCss differs significantly from new CSS, this is a viewport change during pan
      const cssSizeChanged = Math.abs(prevCss.w - layoutBoundsWidth) > 1 || Math.abs(prevCss.h - layoutBoundsHeight) > 1;
      const cssOffsetChanged = prevCss.transform !== pendingCssTransform;
      if (cssSizeChanged || cssOffsetChanged) {
        console.log(`[PAN-DIAG] seq=${renderSeq} page=${this.config.pageNumber}: CSS PENDING ` +
          `prevCss=${prevCss.w}x${prevCss.h} → new=${layoutBoundsWidth.toFixed(1)}x${layoutBoundsHeight.toFixed(1)}, ` +
          `buffer=${canvasWidth}x${canvasHeight}, sizeChanged=${cssSizeChanged}, offsetChanged=${cssOffsetChanged}`);
      }

      console.log(`[STABILITY-FIX] VIEWPORT page=${this.config.pageNumber}: cssSize=${layoutBoundsWidth.toFixed(1)}x${layoutBoundsHeight.toFixed(1)}, offset=${cssOffsetX.toFixed(1)},${cssOffsetY.toFixed(1)}, transform="${pendingCssTransform}" (PENDING - after gate)`);

      // MID-ZOOM BUFFER/CSS DIAGNOSTIC: Track buffer-to-CSS ratio at mid-zoom
      if (zoom >= 4) {
        const bufferToCssX = canvasWidth / layoutBoundsWidth;
        const bufferToCssY = canvasHeight / layoutBoundsHeight;
        console.warn(`[MID-ZOOM-CSS-DIAG] VIEWPORT page=${this.config.pageNumber}:`, {
          zoom: zoom.toFixed(2),
          tileScale,
          canvasBuffer: `${canvasWidth}x${canvasHeight}`,
          canvasCss: `${layoutBoundsWidth.toFixed(0)}x${layoutBoundsHeight.toFixed(0)}`,
          bufferToCss: `${bufferToCssX.toFixed(3)}x${bufferToCssY.toFixed(3)}`,
          expectedBufCss: (tileScale / zoom).toFixed(3),
          pdfToElementScale: pdfToElementScale.toFixed(3),
        });
      }
    } else {
      // FULL-PAGE: PDF DIMENSION UNIFICATION (2026-01-23)
      //
      // Architecture:
      // - Canvas buffer = pdfWidth × tileScale (e.g., 441 × 16 = 7056)
      // - Canvas CSS = pdfWidth × zoom (e.g., 441 × 32 = 14112)
      // - Browser stretches buffer to CSS: 7056 → 14112 (2× stretch)
      //
      // This is correct! At zoom=32 with tileScale=16:
      // - Buffer/CSS = tileScale/zoom = 16/32 = 0.5
      // - Each buffer pixel displays at 2× size (zoom/tileScale)
      // - Visual result = correct 32× zoom
      //
      // ARCHITECTURE NOTE (amnesia-d9f): The camera system applies scale(zoom) transform
      // to the entire canvas container. Page elements and their canvases should be at
      // BASE size (not zoomed), and the camera transform handles visual magnification.
      //
      // Canvas CSS = base PDF dimensions (not zoomed!)
      // Canvas buffer = PDF dimensions × tileScale (for crisp pixels)
      // Camera transform = scale(zoom) (handles visual zoom)
      const finalWidth = useContainerDimensionsDirectly ? this.currentWidth : pdfWidth;
      const finalHeight = useContainerDimensionsDirectly ? this.currentHeight : pdfHeight;

      // CONCURRENT RENDER FIX: Store CSS values for application after gate
      // Canvas CSS fills container (which is now PDF dimensions × zoom)
      pendingCssWidth = Math.round(finalWidth);
      pendingCssHeight = Math.round(finalHeight);

      // No transform needed - browser handles buffer → CSS scaling
      pendingCssTransform = '';
      pendingCssTransformOrigin = '';
      pendingCssOffsetX = 0;
      pendingCssOffsetY = 0;

      // Verify camera-based architecture is working correctly:
      // - Canvas CSS = base PDF dimensions (camera scale() handles visual zoom)
      // - Buffer = PDF dimensions × tileScale (for crisp pixels)
      // - Buffer/CSS ratio = tileScale (NOT tileScale/zoom, since camera scales CSS)
      const expectedCssWidth = pdfWidth;  // Base size - camera handles zoom
      const dimensionMatch = Math.abs(finalWidth - expectedCssWidth) < 1;
      console.log(`[PDF-CAMERA] FULLPAGE page=${this.config.pageNumber}: ` +
        `cssSize=${finalWidth.toFixed(1)}x${finalHeight.toFixed(1)}, ` +
        `buffer=${canvasWidth}x${canvasHeight}, ` +
        `pdfDims=${pdfWidth.toFixed(1)}x${pdfHeight.toFixed(1)}, ` +
        `zoom=${zoom.toFixed(2)}, tileScale=${tileScale}, ` +
        `dimensionMatch=${dimensionMatch}`);

      // Diagnostic: Buffer/CSS ratio should be tileScale (camera handles zoom separately)
      if (zoom >= 4) {
        const bufferToCssX = canvasWidth / finalWidth;
        const expectedRatio = tileScale;  // Camera scales by zoom, so buffer/css = tileScale
        const ratioMatch = Math.abs(bufferToCssX - expectedRatio) < 0.1;
        console.log(`[PDF-CAMERA-DIAG] page=${this.config.pageNumber}: ` +
          `bufferToCss=${bufferToCssX.toFixed(2)}, ` +
          `expected=${expectedRatio}, ` +
          `match=${ratioMatch}, ` +
          `visualScale=${(tileScale * zoom / tileScale).toFixed(2)}x`);
      }

      // NOTE: coordDebugger.recordTransformApply will be called after gate
    }
    } // End of LEGACY else block

    // ==========================================================================
    // CONCURRENT RENDER GATE (2026-01-21): Check if this render is still valid
    // ==========================================================================
    // At this point, we've drawn all tiles to the local offscreen buffer BUT
    // CSS transforms have NOT been applied yet (amnesia-d9f fix).
    //
    // Writing stale content to the main canvas causes visual corruption:
    // - Tiles at wrong positions (old camera vs new camera)
    // - Mixed scales (old zoom vs new zoom)
    // - CSS transform mismatch (dimensions changed mid-render)
    //
    // FIX: Compare this render's sequence number to the latest.
    // If they differ, discard this render - the newer one will complete correctly.
    if (renderSeq !== this.latestRenderSeq) {
      console.warn(`[RENDER-SEQ] page=${this.config.pageNumber} seq=${renderSeq} DISCARDED (latestRenderSeq=${this.latestRenderSeq}) - ` +
        `stale render would corrupt canvas. Tiles drawn to offscreen but NOT committed.`);
      // Don't commit to main canvas - just return
      // The localOffscreen buffer is garbage collected automatically
      return;
    }
    console.log(`[RENDER-SEQ] page=${this.config.pageNumber} seq=${renderSeq} COMMITTING to main canvas (latestRenderSeq=${this.latestRenderSeq})`);

    // ==========================================================================
    // CONCURRENT RENDER FIX (amnesia-d9f 2026-01-23): Apply CSS AFTER gate passes
    // ==========================================================================
    // CSS was computed earlier but NOT applied. Now that we've passed the concurrency
    // gate, we're guaranteed this is the latest render. Safe to apply CSS.
    //
    // This fixes the race condition where:
    // 1. Render A sets CSS to (184, 112)
    // 2. Render B sets CSS to (192, 104) - overwrites A
    // 3. Render A passes gate, commits tiles
    // 4. DOM has B's CSS with A's tiles → corruption
    //
    // With this fix:
    // 1. Render A computes CSS (184, 112) but doesn't apply
    // 2. Render B computes CSS (192, 104) but doesn't apply  
    // 3. Render A passes gate, applies CSS (184, 112), commits tiles
    // 4. Render B fails gate (A incremented latestRenderSeq), discarded
    // 5. DOM has A's CSS with A's tiles → correct
    if (pendingCssWidth > 0 && pendingCssHeight > 0) {
      this.canvas.style.width = `${pendingCssWidth}px`;
      this.canvas.style.height = `${pendingCssHeight}px`;
      this.canvas.style.transform = pendingCssTransform;
      this.canvas.style.transformOrigin = pendingCssTransformOrigin;

      // Record transform application for debugging (now that it's actually applied)
      const coordDebugger = getCoordinateDebugger();
      coordDebugger.recordTransformApply({
        page: this.config.pageNumber,
        transform: pendingCssTransform,
        cssStretch: 1,
        fitScale: 1,
        offsetX: pendingCssOffsetX,
        offsetY: pendingCssOffsetY,
      });

      console.log(`[CSS-APPLIED-AFTER-GATE] page=${this.config.pageNumber} seq=${renderSeq}: ` +
        `size=${pendingCssWidth}x${pendingCssHeight}, transform="${pendingCssTransform}"`);
    }

    // Copy offscreen buffer to visible canvas in one operation
    // CONCURRENT RENDER FIX: Use localOffscreen instead of this.offscreenCanvas
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(localOffscreen, 0, 0);

    // Render text layer if available
    if (textLayerData) {
      this.renderTextLayer(textLayerData, zoom);
    }

    this.isRendered = true;

    // Show canvas after render (may have been hidden during mode transition)
    this.showCanvas();

    // DOUBLE-BUFFERING: Remove transition snapshot now that new content is displayed.
    // This completes the atomic swap - old content (snapshot) is replaced by new content (canvas).
    // amnesia-2t8 (H8): Extract scaleEpoch from tiles to gate snapshot clearing
    // Use the maximum epoch from the tiles (most recent)
    // INV-6 FIX (2026-01-23): Read scaleEpoch directly from tile result, not from tile.tile
    //
    // amnesia-e4i FIX (2026-01-23): Only clear snapshot when we have COMPLETE coverage.
    // When tiles are dropped from the render queue (queue overflow at mid-zoom),
    // we get incomplete coverage (<95%). Keeping the snapshot visible underneath
    // provides a blurry-but-complete fallback instead of blank regions.
    // The snapshot will be cleared when a subsequent render achieves full coverage.
    const tileEpochs = tiles
      .map(t => t.scaleEpoch)
      .filter((e): e is number => e !== undefined);
    const maxTileEpoch = tileEpochs.length > 0 ? Math.max(...tileEpochs) : undefined;
    
    if (!hasIncompleteCoverage) {
      this.clearTransitionSnapshot(maxTileEpoch);
    } else {
      console.log(`[SNAPSHOT-KEPT] page=${this.config.pageNumber}: keeping transition snapshot as fallback (coverage=${coveragePercent.toFixed(1)}% < 95%)`);
    }

    // Track render time and scale
    const renderTime = performance.now() - startTime;
    telemetry.trackRenderTime(renderTime, 'tile');

    // Track render scale (use first tile's scale as representative)
    if (tiles.length > 0) {
      telemetry.trackRenderScale(tiles[0].tile.scale, 'tile');
    }

    // Apply reading mode styles now that we have content
    this.applyReadingModeStyles();
  }

  /**
   * Render canvas from image blob
   *
   * Canvas Buffer Strategy:
   * - Canvas is sized to display size × DPR (capped at 2048px for performance)
   * - High-res image from server is drawn scaled to fit canvas buffer
   * - Browser handles high-quality downsampling during drawImage
   * - This prevents massive 20+ megapixel canvases that cause:
   *   - Slow rendering (250ms+ per page)
   *   - GPU memory exhaustion
   *   - Limited page virtualization
   *
   * Performance optimization: Uses worker pool for image decoding when available.
   * This moves createImageBitmap off the main thread for smoother scrolling.
   */
  private async renderCanvas(imageBlob: Blob): Promise<void> {
    // Clear CSS placeholder before drawing actual content
    this.clearPlaceholder();

    const pool = getCanvasPool();

    try {
      // Try to use worker pool for off-main-thread image decoding
      if (pool.isAvailable()) {
        const result = await pool.processImage(
          imageBlob,
          this.currentWidth,
          this.currentHeight,
          this.config.pageNumber
        );

        // Use the actual image dimensions for sharp rendering
        // The request scale cap in pdf-infinite-canvas ensures we don't fetch
        // unnecessarily large images, so use whatever resolution we receive
        this.canvas.width = result.naturalWidth;
        this.canvas.height = result.naturalHeight;

        // DIMENSION MATCH FIX: Use container dimensions directly for canvas CSS.
        // Previously we derived CSS from buffer aspect ratio, but MuPDF's dimension
        // capping (4096px max) creates slight aspect ratio differences:
        // - PDF aspect: 612/792 = 0.7727
        // - Buffer aspect: 3166/4096 = 0.7729
        //
        // This 0.02% difference causes Math.round to produce different values:
        // - Container: Math.round(400/0.7727) = 518
        // - Canvas: Math.round(400/0.7729) = 517
        //
        // The 1px gap causes visible clipping at the bottom of pages.
        //
        // FIX: Use container dimensions directly. The browser will scale the buffer
        // to fit the CSS dimensions. The <0.2% aspect ratio distortion is imperceptible,
        // but the 1px gap was very visible.
        const cssWidth = Math.round(this.currentWidth);
        const cssHeight = Math.round(this.currentHeight);
        const bufferAspectRatio = result.naturalWidth / result.naturalHeight;

        this.canvas.style.width = `${cssWidth}px`;
        this.canvas.style.height = `${cssHeight}px`;
        this.canvas.style.transform = ''; // NO scale transform - camera handles all zoom
        this.canvas.style.transformOrigin = '0 0';

        console.log(`[DIMENSION-MATCH-FIX] renderCanvas: canvasCss=${cssWidth}x${cssHeight}, containerCss=${this.currentWidth}x${this.currentHeight} (buffer ${result.naturalWidth}x${result.naturalHeight}, aspect=${bufferAspectRatio.toFixed(4)})`);

        // Reset transform and draw at native resolution
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';

        this.ctx.clearRect(0, 0, result.naturalWidth, result.naturalHeight);
        this.ctx.drawImage(result.imageBitmap, 0, 0);

        // Close the ImageBitmap to free memory
        result.imageBitmap.close();
        return;
      }
    } catch (error) {
      console.warn('[PdfPageElement] Worker pool failed, falling back:', error);
    }

    // Fallback: main thread rendering
    await this.renderCanvasFallback(imageBlob);
  }

  /**
   * Fallback canvas rendering on main thread
   * Used when worker pool is not available
   */
  private async renderCanvasFallback(imageBlob: Blob): Promise<void> {
    const imageUrl = URL.createObjectURL(imageBlob);
    const image = new Image();

    return new Promise((resolve, reject) => {
      image.onload = () => {
        try {
          // Use actual image dimensions for sharp rendering
          // Request scale capping ensures we don't fetch unnecessarily large images
          this.canvas.width = image.naturalWidth;
          this.canvas.height = image.naturalHeight;

          // DIMENSION MATCH FIX: Use container dimensions directly for canvas CSS.
          // See renderCanvas() for full explanation of why this is needed.
          const cssWidth = Math.round(this.currentWidth);
          const cssHeight = Math.round(this.currentHeight);
          const bufferAspectRatio = image.naturalWidth / image.naturalHeight;

          this.canvas.style.width = `${cssWidth}px`;
          this.canvas.style.height = `${cssHeight}px`;
          this.canvas.style.transform = ''; // NO scale transform - camera handles all zoom
          this.canvas.style.transformOrigin = '0 0';

          console.log(`[DIMENSION-MATCH-FIX] renderCanvasFallback: canvasCss=${cssWidth}x${cssHeight}, containerCss=${this.currentWidth}x${this.currentHeight} (buffer ${image.naturalWidth}x${image.naturalHeight}, aspect=${bufferAspectRatio.toFixed(4)})`);

          // Reset transform and draw at native resolution
          this.ctx.setTransform(1, 0, 0, 1, 0, 0);
          this.ctx.imageSmoothingEnabled = true;
          this.ctx.imageSmoothingQuality = 'high';

          this.ctx.clearRect(0, 0, image.naturalWidth, image.naturalHeight);
          this.ctx.drawImage(image, 0, 0);

          URL.revokeObjectURL(imageUrl);
          resolve();
        } catch (error) {
          URL.revokeObjectURL(imageUrl);
          reject(error);
        }
      };

      image.onerror = () => {
        URL.revokeObjectURL(imageUrl);
        reject(new Error('Failed to load page image'));
      };

      image.src = imageUrl;
    });
  }

  /**
   * Render text layer for selection
   * Uses SVG text layer for vector-crisp rendering when available,
   * falls back to HTML text layer otherwise.
   */
  private renderTextLayer(data: TextLayerData, scale: number): void {
    // Store text layer data for smart copy
    this.textLayerData = data;

    if (!data.items || data.items.length === 0) return;

    // Use SVG text layer if available (vector-crisp at any zoom)
    if (this.svgTextLayer) {
      this.svgTextLayer.renderFromTextData(data, this.currentWidth, this.currentHeight, scale);
      return;
    }

    // Fallback: HTML text layer
    this.textLayerEl.innerHTML = '';

    // Use page dimensions from data instead of hardcoded values
    const pageWidth = data.width || 612;  // Fallback to US Letter
    const pageHeight = data.height || 792;

    for (const item of data.items) {
      if (!item.text || item.text.trim() === '') continue;

      const span = document.createElement('span');
      span.textContent = item.text;

      // Position based on text item coordinates
      // Scale from PDF coordinates to display coordinates
      const left = (item.x / pageWidth) * this.currentWidth;
      const top = (item.y / pageHeight) * this.currentHeight;
      const fontSize = Math.max(8, (item.height / pageHeight) * this.currentHeight);

      span.style.cssText = `
        position: absolute;
        left: ${left}px;
        top: ${top}px;
        font-size: ${fontSize}px;
        font-family: sans-serif;
        white-space: pre;
        transform-origin: 0 0;
        color: transparent;
      `;

      this.textLayerEl.appendChild(span);
    }
  }

  /**
   * Setup selection listener
   */
  private setupSelectionListener(): void {
    this.textLayerEl.addEventListener('mouseup', () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const text = selection.toString().trim();
      if (!text) return;

      const rects = this.getSelectionRects();
      if (rects.length > 0 && this.onSelectionCallback) {
        this.onSelectionCallback(this.config.pageNumber, text, rects);
      }
    });
  }

  /**
   * Get selection rects relative to container
   */
  private getSelectionRects(): DOMRect[] {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return [];

    const range = selection.getRangeAt(0);
    const clientRects = range.getClientRects();
    const containerRect = this.container.getBoundingClientRect();

    const rects: DOMRect[] = [];
    for (let i = 0; i < clientRects.length; i++) {
      const rect = clientRects[i];
      rects.push(new DOMRect(
        rect.left - containerRect.left,
        rect.top - containerRect.top,
        rect.width,
        rect.height
      ));
    }

    return rects;
  }

  /**
   * Set selection callback
   */
  setOnSelection(callback: (page: number, text: string, rects: DOMRect[]) => void): void {
    this.onSelectionCallback = callback;
  }

  /**
   * Setup copy handler for smart copy
   * Intercepts Ctrl+C/Cmd+C to provide Markdown-formatted text
   */
  private setupCopyHandler(): void {
    this.container.addEventListener('copy', (event: ClipboardEvent) => {
      if (!this.smartCopyEnabled || !this.textLayerData) return;

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const selectedText = selection.toString().trim();
      if (!selectedText) return;

      // Prevent default copy behavior
      event.preventDefault();

      // For now, use the selected text directly as the primary content
      // The smart copy with formatting detection is available via getTextAsMarkdown()
      // when the selection spans the entire visible text and charPositions are available
      const plainText = selectedText;

      // Try to get markdown if we have the full data with charPositions
      let markdown = selectedText;
      if (this.textLayerData.items.some(item => item.charPositions && item.charPositions.length > 0)) {
        // We have char positions - use full markdown extraction
        // Note: This gives formatted output for the visible items
        markdown = extractAsMarkdown(this.textLayerData);
      }

      // Simple HTML escaping for selected text
      const html = selectedText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');

      // Set clipboard data with multiple formats
      if (event.clipboardData) {
        event.clipboardData.setData('text/plain', plainText);
        event.clipboardData.setData('text/markdown', markdown);
        event.clipboardData.setData('text/html', html);
      }
    });
  }

  /**
   * Enable or disable smart copy
   */
  setSmartCopyEnabled(enabled: boolean): void {
    this.smartCopyEnabled = enabled;
  }

  /**
   * Get the current text layer data as Markdown
   */
  getTextAsMarkdown(): string {
    if (!this.textLayerData) return '';
    return extractAsMarkdown(this.textLayerData);
  }

  /**
   * Get the current text layer data as plain text
   */
  getTextAsPlainText(): string {
    if (!this.textLayerData) return '';
    return extractAsPlainText(this.textLayerData);
  }

  /**
   * Set highlights for this page
   */
  setHighlights(highlights: PageHighlight[]): void {
    this.annotationLayerEl.innerHTML = '';

    for (const highlight of highlights) {
      for (const rect of highlight.rects) {
        const el = document.createElement('div');
        el.className = 'pdf-highlight';
        el.dataset.annotationId = highlight.annotationId;

        // Scale rect from normalized (0-1) to display coordinates
        const left = rect.x * this.currentWidth;
        const top = rect.y * this.currentHeight;
        const width = rect.width * this.currentWidth;
        const height = rect.height * this.currentHeight;

        el.style.cssText = `
          position: absolute;
          left: ${left}px;
          top: ${top}px;
          width: ${width}px;
          height: ${height}px;
          background: ${this.getHighlightColor(highlight.color)};
          pointer-events: auto;
          cursor: pointer;
          mix-blend-mode: multiply;
        `;

        el.addEventListener('click', (e) => {
          if (this.onHighlightClickCallback) {
            this.onHighlightClickCallback(highlight.annotationId, {
              x: e.clientX,
              y: e.clientY,
            });
          }
        });

        this.annotationLayerEl.appendChild(el);
      }
    }
  }

  /**
   * Set highlight click callback
   */
  setOnHighlightClick(callback: (annotationId: string, position: { x: number; y: number }) => void): void {
    this.onHighlightClickCallback = callback;
  }

  /**
   * Get highlight color CSS value
   */
  private getHighlightColor(color: HighlightColor): string {
    const colors: Record<HighlightColor, string> = {
      yellow: 'rgba(255, 235, 59, 0.4)',
      green: 'rgba(76, 175, 80, 0.4)',
      blue: 'rgba(33, 150, 243, 0.4)',
      pink: 'rgba(233, 30, 99, 0.4)',
      purple: 'rgba(156, 39, 176, 0.4)',
      orange: 'rgba(255, 152, 0, 0.4)',
    };
    return colors[color] || colors.yellow;
  }

  /**
   * Set reading mode (applies CSS filters for theme)
   */
  setReadingMode(mode: ReadingMode): void {
    this.currentReadingMode = mode;
    this.applyReadingModeStyles();
  }

  /**
   * Apply reading mode styles to container and canvas
   *
   * Supports two dark mode implementations:
   * 1. CSS filters (default): Fast, slightly degrades sharpness measurements
   * 2. HSL lightness inversion: Preserves anti-aliasing, requires canvas manipulation
   *
   * HSL mode can be enabled with setHslDarkMode(true).
   */
  private applyReadingModeStyles(): void {
    // Handle reflow mode separately
    if (this.currentRenderMode === 'reflow') {
      this.applyReflowReadingMode();
      return;
    }

    // Check if we need dark mode
    const needsDark = this.currentReadingMode === 'dark' ||
                      this.currentReadingMode === 'night' ||
                      (this.currentReadingMode === 'device' && document.body.classList.contains('theme-dark'));

    // Use HSL lightness inversion if enabled and dark mode is needed
    if (this.useHslDarkMode && needsDark && this.isRendered) {
      this.applyHslDarkModeInternal();
      return;
    }

    // Default: CSS filter approach
    switch (this.currentReadingMode) {
      case 'device':
        // Match Obsidian theme - detect from body class
        const isDark = document.body.classList.contains('theme-dark');
        if (isDark) {
          this.canvas.style.filter = 'invert(0.9) hue-rotate(180deg)';
          this.container.style.background = '#1e1e1e';
        } else {
          this.canvas.style.filter = 'none';
          this.container.style.background = 'white';
        }
        break;
      case 'light':
        // Pure light mode - slight brightness boost
        this.canvas.style.filter = 'brightness(1.02)';
        this.container.style.background = 'white';
        break;
      case 'sepia':
        // Warm sepia tone - easy on eyes
        this.canvas.style.filter = 'sepia(0.25) brightness(0.98)';
        this.container.style.background = '#f4ecd8';
        break;
      case 'dark':
        // Inverted colors for dark mode
        this.canvas.style.filter = 'invert(0.9) hue-rotate(180deg)';
        this.container.style.background = '#1e1e1e';
        break;
      case 'night':
        // Dark with warm tint - reduced blue light
        this.canvas.style.filter = 'invert(0.85) hue-rotate(180deg) sepia(0.2)';
        this.container.style.background = '#1a1a1a';
        break;
      default:
        // Fallback to light
        this.canvas.style.filter = 'none';
        this.container.style.background = 'white';
        break;
    }
  }

  /**
   * Apply HSL lightness inversion dark mode to canvas
   * This method preserves anti-aliasing better than CSS filters
   */
  private applyHslDarkModeInternal(): void {
    if (!this.darkModeRenderer) {
      this.darkModeRenderer = new DarkModeRenderer();
    }

    // Remove any CSS filter first
    this.canvas.style.filter = 'none';
    this.container.style.background = this.currentReadingMode === 'night' ? '#1a1a1a' : '#1e1e1e';

    // Apply HSL lightness inversion
    const success = this.darkModeRenderer.applyHslDarkMode(this.canvas);
    if (!success) {
      // Fallback to CSS filter if HSL processing fails
      this.canvas.style.filter = 'invert(0.9) hue-rotate(180deg)';
    }
  }

  /**
   * Enable or disable smart dark mode
   * When enabled, dark/night modes will preserve images from inversion
   */
  setSmartDarkMode(enabled: boolean): void {
    this.useSmartDarkMode = enabled;
    if (enabled && !this.darkModeRenderer) {
      this.darkModeRenderer = new DarkModeRenderer({
        preserveImages: true,
        imageSensitivity: 0.3,
      });
    }
    // Re-apply current reading mode with new setting
    if (this.currentReadingMode === 'dark' || this.currentReadingMode === 'night') {
      this.applyReadingModeStyles();
    }
  }

  /**
   * Enable or disable HSL lightness inversion for dark mode
   *
   * When enabled, uses canvas-based HSL lightness inversion instead of CSS filters.
   * This approach:
   * - Preserves anti-aliasing better (no sharpness degradation from CSS filters)
   * - Maintains hue and saturation (colors stay recognizable)
   * - Is more computationally expensive (processes every pixel)
   *
   * CSS filters are faster but can slightly degrade sharpness measurement.
   * HSL inversion maintains sharpness but requires canvas manipulation.
   */
  setHslDarkMode(enabled: boolean): void {
    this.useHslDarkMode = enabled;
    if (enabled && !this.darkModeRenderer) {
      this.darkModeRenderer = new DarkModeRenderer();
    }
    // Re-apply current reading mode with new setting
    if (this.currentReadingMode === 'dark' || this.currentReadingMode === 'night' ||
        (this.currentReadingMode === 'device' && document.body.classList.contains('theme-dark'))) {
      this.applyReadingModeStyles();
    }
  }

  /**
   * Check if HSL dark mode is enabled
   */
  isHslDarkModeEnabled(): boolean {
    return this.useHslDarkMode;
  }

  /**
   * Apply smart dark mode to the current canvas
   * Returns immediately for CSS mode, or waits for canvas processing
   */
  async applySmartDarkMode(): Promise<void> {
    if (!this.darkModeRenderer || !this.useSmartDarkMode) return;

    // Apply dark mode with image preservation
    const success = this.darkModeRenderer.applyCanvasDarkMode(this.canvas);
    this.container.style.background = '#1e1e1e';

    if (success) {
      this.canvas.style.filter = 'none'; // Remove CSS filter since we processed canvas
      this.smartDarkModeApplied = true;
    } else {
      // CSS fallback was applied by the renderer
      this.smartDarkModeApplied = false;
    }
  }

  /**
   * Remove smart dark mode from the current canvas
   * Note: This doesn't restore the original image; it just clears the flag.
   * A re-render is required to get the original light-mode appearance.
   */
  removeSmartDarkMode(): void {
    this.smartDarkModeApplied = false;
    this.canvas.style.filter = '';
    this.container.style.background = 'white';
  }

  /**
   * Check if the current page likely contains images
   * Useful for deciding between CSS and canvas dark mode
   */
  async hasImages(blob: Blob): Promise<boolean> {
    if (!this.darkModeRenderer) {
      this.darkModeRenderer = new DarkModeRenderer();
    }
    return this.darkModeRenderer.detectImages(blob);
  }

  /**
   * Set render mode (page view or reflow view)
   */
  setRenderMode(mode: RenderMode): void {
    if (this.currentRenderMode === mode) return;

    this.currentRenderMode = mode;

    if (mode === 'reflow') {
      // Show reflow layer, hide canvas layers
      this.canvas.style.display = 'none';
      this.textLayerEl.style.display = 'none';
      this.reflowLayerEl.style.display = 'block';

      // Render reflow content if we have text data
      if (this.textLayerData) {
        this.renderReflow();
      }
    } else {
      // Show canvas layers, hide reflow layer
      this.canvas.style.display = 'block';
      this.textLayerEl.style.display = 'block';
      this.reflowLayerEl.style.display = 'none';
    }

    // Apply reading mode styles to the appropriate layer
    this.applyReadingModeStyles();
  }

  /**
   * Get current render mode
   */
  getRenderMode(): RenderMode {
    return this.currentRenderMode;
  }

  /**
   * Configure reflow renderer settings
   */
  setReflowConfig(config: ReflowConfig): void {
    if (!this.reflowRenderer) {
      this.reflowRenderer = new MobileReflowRenderer(config);
    } else {
      this.reflowRenderer.setConfig(config);
    }

    // Re-render if in reflow mode
    if (this.currentRenderMode === 'reflow' && this.textLayerData) {
      this.renderReflow();
    }
  }

  /**
   * Render content in reflow mode
   */
  private renderReflow(): void {
    if (!this.textLayerData) {
      this.reflowLayerEl.innerHTML = '<div class="reflow-empty">No text content available</div>';
      return;
    }

    // Create renderer if needed
    if (!this.reflowRenderer) {
      this.reflowRenderer = new MobileReflowRenderer();
    }

    // Inject styles if not already present
    this.injectReflowStyles();

    // Render the reflowed content
    this.reflowLayerEl.innerHTML = this.reflowRenderer.renderPage(this.textLayerData);

    // Apply reading mode to reflow content
    this.applyReflowReadingMode();
  }

  /**
   * Inject reflow CSS styles into the container
   */
  private injectReflowStyles(): void {
    const styleId = 'pdf-reflow-styles';
    if (this.container.querySelector(`#${styleId}`)) return;

    if (!this.reflowRenderer) {
      this.reflowRenderer = new MobileReflowRenderer();
    }

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = this.reflowRenderer.getStyles();
    this.container.appendChild(style);
  }

  /**
   * Apply reading mode to reflow layer
   */
  private applyReflowReadingMode(): void {
    switch (this.currentReadingMode) {
      case 'device':
        const isDark = document.body.classList.contains('theme-dark');
        if (isDark) {
          this.reflowLayerEl.style.background = '#1e1e1e';
          this.reflowLayerEl.style.color = '#e0e0e0';
        } else {
          this.reflowLayerEl.style.background = 'white';
          this.reflowLayerEl.style.color = '#333';
        }
        break;
      case 'light':
        this.reflowLayerEl.style.background = 'white';
        this.reflowLayerEl.style.color = '#333';
        break;
      case 'sepia':
        this.reflowLayerEl.style.background = '#f4ecd8';
        this.reflowLayerEl.style.color = '#5b4636';
        break;
      case 'dark':
        this.reflowLayerEl.style.background = '#1e1e1e';
        this.reflowLayerEl.style.color = '#e0e0e0';
        break;
      case 'night':
        this.reflowLayerEl.style.background = '#1a1a1a';
        this.reflowLayerEl.style.color = '#c9b99a';
        break;
      default:
        this.reflowLayerEl.style.background = 'white';
        this.reflowLayerEl.style.color = '#333';
        break;
    }
  }

  /**
   * Get the reflowed HTML content (for external use)
   */
  getReflowedHtml(): string {
    if (!this.textLayerData) return '';

    if (!this.reflowRenderer) {
      this.reflowRenderer = new MobileReflowRenderer();
    }

    return this.reflowRenderer.renderPage(this.textLayerData);
  }

  /**
   * Show loading state
   * Note: Placeholder is already shown by setDimensions(), so we just add
   * the loading class for CSS-based loading indicators (e.g., spinner overlay)
   */
  showLoading(): void {
    this.container.classList.add('pdf-page-loading');
    // The placeholder is already drawn by setDimensions() - no need to redraw
    // This prevents flickering during the render cycle
  }

  /**
   * Hide loading state
   */
  hideLoading(): void {
    this.container.classList.remove('pdf-page-loading');
  }

  /**
   * Prepare for full-page rendering by resetting canvas CSS to container size.
   *
   * PAGE SCALE STABILITY FIX: During mode transitions (tiled → full-page),
   * the old viewport-only canvas has CSS size = tile bounds and transform = translate(offset).
   * This causes visual jarring when camera zoom changes during the async render wait.
   *
   * By immediately resetting CSS to container size and clearing transform,
   * we ensure the canvas displays at correct proportions while waiting for the new render.
   */
  prepareForFullPageRender(): void {
    // EARLY EXIT FOR UNRENDERED PAGES (2026-01-24):
    // If the canvas has never been rendered (default 300x150), skip all transition logic.
    // These pages just need a fresh render, not a mode transition.
    // This prevents the "blink" effect where we hide a never-rendered canvas.
    const isUnrenderedCanvas = this.canvas.width === 300 && this.canvas.height === 150;
    if (isUnrenderedCanvas) {
      console.log(`[SKIP-TRANSITION] page=${this.config.pageNumber}: Canvas never rendered (300x150), skipping mode transition`);
      // Just ensure loading state is shown - the render will happen naturally
      this.showLoading();
      return;
    }

    // GOLDEN FRAME LOG (Protocol C): Capture all dimension-related values for hypothesis debugging
    // This log is critical for diagnosing dimension mismatches during mode transitions
    const containerRect = this.container.getBoundingClientRect();
    const goldenFrameLog = {
      mode: 'tiled→full-page transition',
      page: this.config.pageNumber,
      camera: { zoom: this.currentZoom },
      // CSS dimensions from state (may be floats, rounded at source since H1 fix)
      cssWidth: this.currentWidth,
      cssHeight: this.currentHeight,
      // Container measurements (Protocol C recommended)
      containerBoundingRect: { w: containerRect.width, h: containerRect.height },
      containerOffset: { w: this.container.offsetWidth, h: this.container.offsetHeight },
      // Canvas buffer dimensions (integers via Math.ceil in renderTiles)
      canvasBuffer: { w: this.canvas.width, h: this.canvas.height },
      // Parsed CSS style dimensions
      canvasCss: {
        w: parseFloat(this.canvas.style.width) || this.currentWidth,
        h: parseFloat(this.canvas.style.height) || this.currentHeight,
      },
      // PDF coordinate system (native PDF points, e.g., 612×792)
      storedPdfDimensions: this.storedPdfDimensions,
      // Snapshot canvas dimensions (if exists)
      snapshotCanvas: this.transitionSnapshot
        ? { w: this.transitionSnapshot.width, h: this.transitionSnapshot.height }
        : null,
      // Delta between buffer and CSS (H1 hypothesis target - should be 0 after fix)
      heightDelta: this.canvas.height - (parseFloat(this.canvas.style.height) || this.currentHeight),
    };
    console.log('[GOLDEN-FRAME]', goldenFrameLog);

    // amnesia-2t8 (H8): Record the epoch at which this transition starts.
    // The transition snapshot should only be cleared when tiles with epoch >= this value arrive.
    const scaleManager = getScaleStateManager('default');
    if (scaleManager) {
      this.transitionEpoch = scaleManager.getEpoch();
      console.log(`[TRANSITION-EPOCH] prepareForFullPageRender: page=${this.config.pageNumber}, transitionEpoch=${this.transitionEpoch}`);
    }

    // MODE TRANSITION FIX (amnesia-8jm): Use double-buffering for tiled→full-page transition.
    // The old viewport-only canvas buffer contains a small region of the page.
    // Instead of hiding with opacity:0 (which shows blank), we capture a snapshot
    // at the current CSS size/position, then change the canvas dimensions.
    // The snapshot stays visible until new render completes.

    // DOUBLE-BUFFERING: Capture current canvas content as a snapshot
    // This is the same approach used in prepareForTiledRender() for consistency
    if (this.canvas.width > 0 && this.canvas.height > 0) {
      if (!this.transitionSnapshot) {
        this.transitionSnapshot = document.createElement('canvas');
        this.transitionSnapshot.className = 'pdf-transition-snapshot';
        this.transitionSnapshot.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          pointer-events: none;
          z-index: 5;
        `;
      }

      // MODE TRANSITION STRETCH FIX: Don't copy viewport-only dimensions from tiled mode.
      // In tiled mode, canvas CSS size covers only visible tiles (e.g., 334px instead of 517px).
      // Copying these dimensions causes the snapshot to appear stretched when transitioning
      // to full-page mode where the container expects full page dimensions.
      //
      // Solution: Size the snapshot to match FULL page dimensions (currentWidth × currentHeight).
      // The tiled content (which may be partial) is positioned at its original offset within
      // the full-page-sized snapshot, preserving correct aspect ratio and position.

      // Get the original tiled canvas position (translate transform)
      const tiledTransform = this.canvas.style.transform;
      const tiledWidth = parseFloat(this.canvas.style.width) || this.currentWidth;
      const tiledHeight = parseFloat(this.canvas.style.height) || this.currentHeight;

      // Extract translate offset from tiled transform (if any)
      let offsetX = 0, offsetY = 0;
      const translateMatch = tiledTransform.match(/translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/);
      if (translateMatch) {
        offsetX = parseFloat(translateMatch[1]);
        offsetY = parseFloat(translateMatch[2]);
      }

      // Size snapshot to FULL page dimensions (not viewport-only)
      // H1 FIX: Use Math.round() for CSS dimensions to match integer canvas buffer dimensions.
      // This eliminates the 0.353px mismatch (e.g., 517.647 → 518) that causes mode transition stretch.
      this.transitionSnapshot.style.width = `${Math.round(this.currentWidth)}px`;
      this.transitionSnapshot.style.height = `${Math.round(this.currentHeight)}px`;
      this.transitionSnapshot.style.transform = '';
      this.transitionSnapshot.style.transformOrigin = '0 0';

      // Copy canvas content to snapshot at the correct position
      // Use full page buffer size to maintain aspect ratio
      const dpr = window.devicePixelRatio || 2;
      this.transitionSnapshot.width = Math.round(this.currentWidth * dpr);
      this.transitionSnapshot.height = Math.round(this.currentHeight * dpr);
      const snapshotCtx = this.transitionSnapshot.getContext('2d');
      if (snapshotCtx) {
        // Clear snapshot (transparent background)
        snapshotCtx.clearRect(0, 0, this.transitionSnapshot.width, this.transitionSnapshot.height);

        // Calculate where to draw the tiled content in the full-page snapshot
        // The tiled canvas covered a region starting at (offsetX, offsetY) in page coordinates
        // We need to draw it at the same relative position in the full-page snapshot
        const scaleX = this.transitionSnapshot.width / this.currentWidth;
        const scaleY = this.transitionSnapshot.height / this.currentHeight;
        const drawX = offsetX * scaleX;
        const drawY = offsetY * scaleY;

        // Calculate destination dimensions using CSS-to-buffer scaling
        // This ensures the tiled content is drawn at the correct size in the snapshot
        const drawWidth = tiledWidth * scaleX;
        const drawHeight = tiledHeight * scaleY;

        // H3 DIAGNOSTIC: Log aspect ratio info during mode transitions
        // The destination aspect should match the source CSS aspect (not buffer aspect)
        // because drawImage scales the source to fit the destination
        const sourceAspect = this.canvas.width / this.canvas.height;
        const destAspect = drawWidth / drawHeight;
        const cssAspect = tiledWidth / tiledHeight;
        console.log(`[H3-DIAG] Mode transition: srcBuf=${this.canvas.width}x${this.canvas.height} (aspect=${sourceAspect.toFixed(4)}), dest=${drawWidth.toFixed(0)}x${drawHeight.toFixed(0)} (aspect=${destAspect.toFixed(4)}), css=${tiledWidth.toFixed(0)}x${tiledHeight.toFixed(0)} (aspect=${cssAspect.toFixed(4)})`);

        // NOTE: Uninitialized canvas check (300x150) is now handled at function entry with early return.

        // COVERAGE CHECK (2026-01-21): Skip snapshot if tiled content doesn't cover most of the page.
        // During tiled→full-page transition, the tiled canvas may cover only a small viewport region
        // (e.g., 99px of a 518px page). Drawing this partial content in a full-page snapshot
        // causes blank areas and mismatched resolutions.
        //
        // Check: If tiled dimensions are less than 70% of full-page dimensions, skip snapshot.
        // This prevents the "scattered tiles at wrong resolutions" bug during zoom-out gestures.
        const widthCoverage = tiledWidth / this.currentWidth;
        const heightCoverage = tiledHeight / this.currentHeight;
        const minCoverage = Math.min(widthCoverage, heightCoverage);
        // STRICT COVERAGE (2026-01-21): Require 95% coverage to avoid visible blank gaps.
        // At 72.6% coverage, 27% of the page appears blank - unacceptable.
        // Better to show loading state than corrupted partial content.
        const coverageThreshold = 0.95;
        
        // Also check aspect ratio compatibility as a secondary filter
        const aspectRatioDiff = Math.abs(sourceAspect - cssAspect) / cssAspect;
        const aspectRatioCompatible = aspectRatioDiff < 0.05;
        
        // Must pass BOTH checks: sufficient coverage AND compatible aspect ratio
        const snapshotUsable = minCoverage >= coverageThreshold && aspectRatioCompatible;

        if (!snapshotUsable) {
          console.warn(`[SNAPSHOT-SKIP] page=${this.config.pageNumber}: Skipping snapshot (insufficient coverage or aspect mismatch). ` +
            `coverage=${(minCoverage * 100).toFixed(1)}% (threshold=${coverageThreshold * 100}%), ` +
            `tiled=${tiledWidth.toFixed(0)}x${tiledHeight.toFixed(0)}, fullPage=${this.currentWidth}x${this.currentHeight}, ` +
            `aspectDiff=${(aspectRatioDiff * 100).toFixed(1)}%`);
          // FIX (2026-01-24): Don't append blank snapshot - remove any existing one and let loading show
          if (this.transitionSnapshot?.parentElement) {
            this.transitionSnapshot.remove();
          }
          // Don't add the snapshot to container - fall through to hide canvas and show loading
        } else {
          // Draw the tiled content at its original position within the full-page snapshot
          snapshotCtx.drawImage(this.canvas, drawX, drawY, drawWidth, drawHeight);
          console.log(`[SNAPSHOT-USED] page=${this.config.pageNumber}: coverage=${(minCoverage * 100).toFixed(1)}%, ` +
            `tiled=${tiledWidth.toFixed(0)}x${tiledHeight.toFixed(0)}, fullPage=${this.currentWidth}x${this.currentHeight}`);

          // Insert snapshot into container ONLY if snapshot is usable
          if (!this.transitionSnapshot.parentElement) {
            this.container.appendChild(this.transitionSnapshot);
          }
          console.log(`[MODE-TRANSITION] Captured snapshot for tiled→full-page transition, page=${this.config.pageNumber}, tiled=${tiledWidth.toFixed(0)}x${tiledHeight.toFixed(0)} at (${offsetX},${offsetY}), fullPage=${this.currentWidth}x${this.currentHeight.toFixed(0)}`);
        }
      }
    }

    // Now hide the canvas and reset its CSS for full-page mode
    // H1 FIX: Use Math.round() for CSS dimensions to match integer canvas buffer dimensions.
    this.canvas.style.opacity = '0';
    this.canvas.style.width = `${Math.round(this.currentWidth)}px`;
    this.canvas.style.height = `${Math.round(this.currentHeight)}px`;
    this.canvas.style.transform = '';
    this.canvas.style.transformOrigin = '0 0';

    // Clear the isRendered flag so the page shows loading state
    this.isRendered = false;

    // Show loading indicator (behind snapshot)
    this.showLoading();

    console.log(`[STABILITY-FIX] prepareForFullPageRender: page=${this.config.pageNumber}, cssSize=${this.currentWidth}x${this.currentHeight} (snapshot visible until render completes)`);
  }

  /**
   * Prepare the canvas for tiled rendering (full-page → tiled transition).
   *
   * When transitioning from full-page to tiled mode, the canvas needs to be
   * reset so that incoming tiles can set their own viewport-only transforms.
   * Without this, the canvas CSS remains configured for full-page mode while
   * tiles render for viewport-only regions → tile clipping.
   *
   * DOUBLE-BUFFERING: Instead of hiding the canvas (which causes blank transitions),
   * we capture the current content as a snapshot image. This keeps the old content
   * visible while new tiles render, then the snapshot is removed when tiles are ready.
   *
   * This is the symmetric counterpart to prepareForFullPageRender() which
   * handles the tiled→full-page transition.
   */
  prepareForTiledRender(): void {
    // GOLDEN FRAME LOG (Protocol C): Capture dimensions at full-page→tiled transition
    const containerRect = this.container.getBoundingClientRect();
    const goldenFrameLog = {
      mode: 'full-page→tiled transition',
      page: this.config.pageNumber,
      camera: { zoom: this.currentZoom },
      cssWidth: this.currentWidth,
      cssHeight: this.currentHeight,
      containerBoundingRect: { w: containerRect.width, h: containerRect.height },
      containerOffset: { w: this.container.offsetWidth, h: this.container.offsetHeight },
      canvasBuffer: { w: this.canvas.width, h: this.canvas.height },
      canvasCss: {
        w: parseFloat(this.canvas.style.width) || this.currentWidth,
        h: parseFloat(this.canvas.style.height) || this.currentHeight,
      },
      storedPdfDimensions: this.storedPdfDimensions,
      snapshotCanvas: this.transitionSnapshot
        ? { w: this.transitionSnapshot.width, h: this.transitionSnapshot.height }
        : null,
      heightDelta: this.canvas.height - (parseFloat(this.canvas.style.height) || this.currentHeight),
    };
    console.log('[GOLDEN-FRAME]', goldenFrameLog);

    // amnesia-2t8 (H8): Record the epoch at which this transition starts.
    // The transition snapshot should only be cleared when tiles with epoch >= this value arrive.
    const scaleManager = getScaleStateManager('default');
    if (scaleManager) {
      this.transitionEpoch = scaleManager.getEpoch();
      console.log(`[TRANSITION-EPOCH] prepareForTiledRender: page=${this.config.pageNumber}, transitionEpoch=${this.transitionEpoch}`);
    }

    // DOUBLE-BUFFERING: Capture current canvas content as a snapshot canvas.
    // This keeps old content visible while new tiles render, eliminating blank flash.
    // The snapshot will be removed in renderTiles() when new content is ready.
    //
    // PERF FIX: Use drawImage() instead of toDataURL() for 100x speedup.
    // toDataURL() forces synchronous PNG encoding (100ms+), while drawImage()
    // is a fast GPU copy (~1ms). This eliminates jank during mode transitions.
    const startTime = performance.now();
    try {
      // Only create snapshot if canvas has content (removed isRendered check - race condition)
      if (this.canvas.width > 0 && this.canvas.height > 0) {
        // Create or reuse snapshot canvas element
        if (!this.transitionSnapshot) {
          this.transitionSnapshot = document.createElement('canvas');
          this.transitionSnapshot.className = 'pdf-transition-snapshot';
          this.transitionSnapshot.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            pointer-events: none;
            z-index: 5;
          `;
        }

        // FAST SNAPSHOT: Use drawImage for GPU-accelerated copy
        // This is ~100x faster than toDataURL() which does CPU PNG encoding
        this.transitionSnapshot.width = this.canvas.width;
        this.transitionSnapshot.height = this.canvas.height;
        const ctx = this.transitionSnapshot.getContext('2d');
        if (ctx) {
          ctx.drawImage(this.canvas, 0, 0);
        }

        // Match canvas CSS dimensions and transform
        this.transitionSnapshot.style.width = this.canvas.style.width;
        this.transitionSnapshot.style.height = this.canvas.style.height;
        this.transitionSnapshot.style.transform = this.canvas.style.transform || '';
        this.transitionSnapshot.style.transformOrigin = this.canvas.style.transformOrigin || '0 0';

        // Add to container if not already present
        if (!this.transitionSnapshot.parentElement) {
          this.container.appendChild(this.transitionSnapshot);
        }

        const elapsed = performance.now() - startTime;
        console.log(`[DOUBLE-BUFFER] Created transition snapshot: page=${this.config.pageNumber}, size=${this.canvas.width}x${this.canvas.height}, time=${elapsed.toFixed(1)}ms`);
      }
    } catch (e) {
      // Snapshot creation failed (e.g., tainted canvas) - fall back to hiding
      console.warn(`[DOUBLE-BUFFER] Snapshot creation failed: ${e}, falling back to hide`);
      this.canvas.style.opacity = '0';
    }

    // Reset transform to base state (tiles will set their own transforms)
    this.canvas.style.transform = '';
    this.canvas.style.transformOrigin = '0 0';

    // Mark as needing re-render
    this.isRendered = false;

    // Note: We don't hide the canvas anymore - the snapshot covers it
    // We also don't show loading indicator since snapshot provides visual continuity

    console.log(`[STABILITY-FIX] prepareForTiledRender: page=${this.config.pageNumber} (snapshot preserves old content)`);
  }

  /**
   * Remove the transition snapshot after new content is rendered.
   * Called by renderTiles() when tiles are successfully composited.
   *
   * amnesia-2t8 (H8): Only clears snapshot if tileEpoch >= transitionEpoch.
   * This prevents stale tiles (from pre-transition renders) from prematurely clearing the snapshot.
   *
   * @param tileEpoch The epoch of the tiles being rendered (from scaleEpoch)
   */
  private clearTransitionSnapshot(tileEpoch?: number): void {
    if (!this.transitionSnapshot) {
      return;
    }

    // amnesia-2t8 (H8): Gate snapshot clearing on epoch match
    // Only clear if the tile epoch >= the epoch at which transition started
    if (this.transitionEpoch !== null && tileEpoch !== undefined) {
      if (tileEpoch < this.transitionEpoch) {
        console.log(`[EPOCH-GATE] Keeping snapshot: page=${this.config.pageNumber}, tileEpoch=${tileEpoch} < transitionEpoch=${this.transitionEpoch}`);
        return; // Don't clear - these are stale pre-transition tiles
      }
      console.log(`[EPOCH-GATE] Clearing snapshot: page=${this.config.pageNumber}, tileEpoch=${tileEpoch} >= transitionEpoch=${this.transitionEpoch}`);
    }

    // Clear the snapshot and reset transitionEpoch
    this.transitionSnapshot.remove();
    this.transitionEpoch = null;
    console.log(`[DOUBLE-BUFFER] Removed transition snapshot: page=${this.config.pageNumber}`);
  }

  /**
   * Show the canvas after render completes
   */
  showCanvas(): void {
    this.canvas.style.opacity = '1';
  }

  /**
   * Clear rendered content
   */
  clear(): void {
    this.ctx.clearRect(0, 0, this.currentWidth, this.currentHeight);
    this.textLayerEl.innerHTML = '';
    this.annotationLayerEl.innerHTML = '';
    this.reflowLayerEl.innerHTML = '';
    this.isRendered = false;
    this.smartDarkModeApplied = false;

    // Clear SVG text layer
    if (this.svgTextLayer) {
      this.svgTextLayer.clear();
    }
  }

  /**
   * Destroy element
   */
  destroy(): void {
    this.clear();

    // Destroy SVG text layer
    if (this.svgTextLayer) {
      this.svgTextLayer.destroy();
      this.svgTextLayer = null;
    }

    // Release offscreen canvas to free GPU memory
    if (this.offscreenCanvas) {
      // Set dimensions to 0 to release GPU resources
      this.offscreenCanvas.width = 0;
      this.offscreenCanvas.height = 0;
      this.offscreenCanvas = null;
      this.offscreenCtx = null;
    }

    // Clean up transition snapshot
    if (this.transitionSnapshot) {
      this.transitionSnapshot.remove();
      this.transitionSnapshot = null;
    }

    this.container.remove();
  }

  /**
   * Get selection from SVG text layer (if using SVG)
   */
  getSvgSelection(): { text: string; page: number; rects: DOMRect[] } | null {
    return this.svgTextLayer?.getSelection() ?? null;
  }

  /**
   * Toggle SVG text layer debug mode
   */
  setTextLayerDebug(debug: boolean): void {
    if (this.svgTextLayer) {
      this.svgTextLayer.setDebug(debug);
    }
  }
}

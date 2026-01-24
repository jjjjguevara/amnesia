/**
 * PDF Gesture Handler
 *
 * Handles gestures for PDF viewing:
 * - Pinch-to-zoom (trackpad and touch)
 * - Ctrl/Cmd+scroll zoom
 * - Pan/drag when zoomed in
 */

export interface GestureCallbacks {
  /** Called when zoom changes */
  onZoom: (scale: number, centerX: number, centerY: number) => void;
  /** Called for pan/drag movements (optional) */
  onPan?: (deltaX: number, deltaY: number) => void;
  /** Get current scale */
  getScale: () => number;
}

export interface GestureHandlerConfig {
  /** Minimum zoom scale. Default: 0.1 */
  minScale?: number;
  /** Maximum zoom scale. Default: 16.0 */
  maxScale?: number;
  /** Zoom sensitivity for wheel events. Default: 0.002 */
  wheelSensitivity?: number;
  /** Zoom sensitivity for pinch gestures. Default: 1.0 */
  pinchSensitivity?: number;
  /** Enable smooth zoom animation. Default: true */
  smoothZoom?: boolean;
  /** Enable zoom gestures. Default: true */
  enableZoom?: boolean;
  /** Display mode - affects zoom behavior */
  displayMode?: 'paginated' | 'scrolled';
}

const DEFAULT_CONFIG: Required<GestureHandlerConfig> = {
  minScale: 0.1,
  maxScale: 16.0, // Match infinite canvas maxZoom for high zoom capability
  wheelSensitivity: 0.002,
  pinchSensitivity: 1.0,
  smoothZoom: true,
  enableZoom: true,
  displayMode: 'scrolled',
};

/**
 * Gesture handler for PDF zoom and pan
 */
export class PdfGestureHandler {
  private container: HTMLElement;
  private callbacks: GestureCallbacks;
  private config: Required<GestureHandlerConfig>;

  // Touch state
  private initialPinchDistance: number = 0;
  private initialScale: number = 1;
  private isPinching: boolean = false;
  private lastTouchCenter: { x: number; y: number } | null = null;

  // Bound event handlers
  private boundWheelHandler: (e: WheelEvent) => void;
  private boundTouchStartHandler: (e: TouchEvent) => void;
  private boundTouchMoveHandler: (e: TouchEvent) => void;
  private boundTouchEndHandler: (e: TouchEvent) => void;
  private boundKeyDownHandler: (e: KeyboardEvent) => void;

  constructor(
    container: HTMLElement,
    callbacks: GestureCallbacks,
    config?: GestureHandlerConfig
  ) {
    this.container = container;
    this.callbacks = callbacks;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Bind handlers
    this.boundWheelHandler = this.handleWheel.bind(this);
    this.boundTouchStartHandler = this.handleTouchStart.bind(this);
    this.boundTouchMoveHandler = this.handleTouchMove.bind(this);
    this.boundTouchEndHandler = this.handleTouchEnd.bind(this);
    this.boundKeyDownHandler = this.handleKeyDown.bind(this);

    this.setupEventListeners();
  }

  /**
   * Set up event listeners
   */
  private setupEventListeners(): void {
    // Wheel events for trackpad pinch and Ctrl+scroll
    this.container.addEventListener('wheel', this.boundWheelHandler, { passive: false });

    // Touch events for mobile pinch-to-zoom
    this.container.addEventListener('touchstart', this.boundTouchStartHandler, { passive: false });
    this.container.addEventListener('touchmove', this.boundTouchMoveHandler, { passive: false });
    this.container.addEventListener('touchend', this.boundTouchEndHandler, { passive: true });
    this.container.addEventListener('touchcancel', this.boundTouchEndHandler, { passive: true });

    // Keyboard events for zoom shortcuts
    document.addEventListener('keydown', this.boundKeyDownHandler);

    // Enable touch gestures
    this.container.style.touchAction = 'pan-x pan-y';
  }

  /**
   * Handle wheel events (trackpad pinch and Ctrl/Cmd+scroll)
   */
  private handleWheel(e: WheelEvent): void {
    // In paginated mode, don't allow zoom gestures
    if (this.config.displayMode === 'paginated' || !this.config.enableZoom) {
      return; // Let native behavior handle it (or nothing)
    }

    // Check for zoom gesture (Ctrl/Cmd+scroll or trackpad pinch)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();

      const currentScale = this.callbacks.getScale();
      const delta = -e.deltaY * this.config.wheelSensitivity;
      const zoomFactor = Math.exp(delta);
      let newScale = currentScale * zoomFactor;

      // Clamp scale
      newScale = Math.max(this.config.minScale, Math.min(this.config.maxScale, newScale));

      // Get cursor position relative to container
      const rect = this.container.getBoundingClientRect();
      const centerX = e.clientX - rect.left;
      const centerY = e.clientY - rect.top;

      this.callbacks.onZoom(newScale, centerX, centerY);
    }
    // Otherwise, let native scroll handle it
  }

  /**
   * Handle touch start for pinch gestures
   */
  private handleTouchStart(e: TouchEvent): void {
    // In paginated mode, don't allow pinch-to-zoom
    if (this.config.displayMode === 'paginated' || !this.config.enableZoom) {
      return;
    }

    if (e.touches.length === 2) {
      e.preventDefault();
      this.isPinching = true;
      this.initialPinchDistance = this.getTouchDistance(e.touches[0], e.touches[1]);
      this.initialScale = this.callbacks.getScale();
      this.lastTouchCenter = this.getTouchCenter(e.touches[0], e.touches[1]);
    }
  }

  /**
   * Handle touch move for pinch zoom
   */
  private handleTouchMove(e: TouchEvent): void {
    if (!this.isPinching || e.touches.length !== 2) {
      return;
    }

    e.preventDefault();

    const currentDistance = this.getTouchDistance(e.touches[0], e.touches[1]);
    const scale = (currentDistance / this.initialPinchDistance) * this.initialScale;
    const clampedScale = Math.max(
      this.config.minScale,
      Math.min(this.config.maxScale, scale * this.config.pinchSensitivity)
    );

    const center = this.getTouchCenter(e.touches[0], e.touches[1]);
    const rect = this.container.getBoundingClientRect();

    this.callbacks.onZoom(
      clampedScale,
      center.x - rect.left,
      center.y - rect.top
    );

    // Handle pan during pinch
    if (this.lastTouchCenter && this.callbacks.onPan) {
      const deltaX = center.x - this.lastTouchCenter.x;
      const deltaY = center.y - this.lastTouchCenter.y;
      this.callbacks.onPan(deltaX, deltaY);
    }

    this.lastTouchCenter = center;
  }

  /**
   * Handle touch end
   */
  private handleTouchEnd(e: TouchEvent): void {
    if (e.touches.length < 2) {
      this.isPinching = false;
      this.lastTouchCenter = null;
    }
  }

  /**
   * Handle keyboard shortcuts for zoom
   */
  private handleKeyDown(e: KeyboardEvent): void {
    // Only handle if container is focused or no specific element has focus
    if (!this.isContainerFocused() && document.activeElement?.tagName !== 'BODY') {
      return;
    }

    const isCtrlOrCmd = e.ctrlKey || e.metaKey;

    if (isCtrlOrCmd) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        this.zoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        this.zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        this.resetZoom();
      }
    }
  }

  /**
   * Check if container or its children are focused
   */
  private isContainerFocused(): boolean {
    const activeElement = document.activeElement;
    return this.container.contains(activeElement) || activeElement === document.body;
  }

  /**
   * Calculate distance between two touch points
   */
  private getTouchDistance(touch1: Touch, touch2: Touch): number {
    const dx = touch2.clientX - touch1.clientX;
    const dy = touch2.clientY - touch1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Get center point between two touches
   */
  private getTouchCenter(touch1: Touch, touch2: Touch): { x: number; y: number } {
    return {
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2,
    };
  }

  /**
   * Zoom in by fixed step
   */
  zoomIn(step: number = 0.25): void {
    const currentScale = this.callbacks.getScale();
    const newScale = Math.min(this.config.maxScale, currentScale + step);
    const rect = this.container.getBoundingClientRect();
    this.callbacks.onZoom(newScale, rect.width / 2, rect.height / 2);
  }

  /**
   * Zoom out by fixed step
   */
  zoomOut(step: number = 0.25): void {
    const currentScale = this.callbacks.getScale();
    const newScale = Math.max(this.config.minScale, currentScale - step);
    const rect = this.container.getBoundingClientRect();
    this.callbacks.onZoom(newScale, rect.width / 2, rect.height / 2);
  }

  /**
   * Reset to default zoom (100%)
   */
  resetZoom(): void {
    const rect = this.container.getBoundingClientRect();
    this.callbacks.onZoom(1.0, rect.width / 2, rect.height / 2);
  }

  /**
   * Fit to width
   */
  fitToWidth(pageWidth: number): void {
    const rect = this.container.getBoundingClientRect();
    const padding = 40; // Account for padding
    const scale = (rect.width - padding) / pageWidth;
    const clampedScale = Math.max(
      this.config.minScale,
      Math.min(this.config.maxScale, scale)
    );
    this.callbacks.onZoom(clampedScale, rect.width / 2, rect.height / 2);
  }

  /**
   * Fit to height
   */
  fitToHeight(pageHeight: number): void {
    const rect = this.container.getBoundingClientRect();
    const padding = 40;
    const scale = (rect.height - padding) / pageHeight;
    const clampedScale = Math.max(
      this.config.minScale,
      Math.min(this.config.maxScale, scale)
    );
    this.callbacks.onZoom(clampedScale, rect.width / 2, rect.height / 2);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<GestureHandlerConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * Set display mode (paginated disables zoom gestures)
   */
  setDisplayMode(mode: 'paginated' | 'scrolled'): void {
    this.config.displayMode = mode;
  }

  /**
   * Enable or disable zoom gestures
   */
  setZoomEnabled(enabled: boolean): void {
    this.config.enableZoom = enabled;
  }

  /**
   * Clean up event listeners
   */
  destroy(): void {
    this.container.removeEventListener('wheel', this.boundWheelHandler);
    this.container.removeEventListener('touchstart', this.boundTouchStartHandler);
    this.container.removeEventListener('touchmove', this.boundTouchMoveHandler);
    this.container.removeEventListener('touchend', this.boundTouchEndHandler);
    this.container.removeEventListener('touchcancel', this.boundTouchEndHandler);
    document.removeEventListener('keydown', this.boundKeyDownHandler);
  }
}

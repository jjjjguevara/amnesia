/**
 * PDF Region Selection
 *
 * Allows users to draw rectangular regions on PDF pages.
 * Used for selecting areas in scanned PDFs for OCR or annotation.
 */

import type { PdfRect } from '../document-renderer';
import { getDevicePixelRatio } from './dpr-utils';

/**
 * Region selection event data
 */
export interface RegionSelectionData {
  /** Page number (1-based) */
  page: number;
  /** Selected region in normalized coordinates (0-1) */
  rect: PdfRect;
  /** Region in display coordinates */
  displayRect: { x: number; y: number; width: number; height: number };
  /** Position for popup (center-top of region) */
  position: { x: number; y: number };
}

/**
 * Region selection callback
 */
export type RegionSelectionCallback = (selection: RegionSelectionData) => void;

export interface RegionSelectionConfig {
  /** Minimum size in pixels for a valid selection */
  minSize?: number;
  /** Selection color */
  color?: string;
  /** Border color */
  borderColor?: string;
  /** Whether selection is enabled */
  enabled?: boolean;
}

const DEFAULT_CONFIG: Required<RegionSelectionConfig> = {
  minSize: 10,
  color: 'rgba(59, 130, 246, 0.2)',
  borderColor: 'rgba(59, 130, 246, 0.8)',
  enabled: true,
};

/**
 * Region Selection Handler for PDF pages
 */
export class PdfRegionSelection {
  private container: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: Required<RegionSelectionConfig>;

  // Selection state
  private isSelecting = false;
  private startPoint: { x: number; y: number } | null = null;
  private currentRect: { x: number; y: number; width: number; height: number } | null =
    null;

  // Page info
  private currentPage = 1;
  private displayWidth = 0;
  private displayHeight = 0;

  // Callback
  private onSelection?: RegionSelectionCallback;

  constructor(parent: HTMLElement, config?: RegionSelectionConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.container = document.createElement('div');
    this.container.className = 'pdf-region-selection-container';
    this.container.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      pointer-events: ${this.config.enabled ? 'auto' : 'none'};
      cursor: crosshair;
      z-index: 10;
    `;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pdf-region-selection-canvas';
    this.canvas.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
    `;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context for region selection');
    }
    this.ctx = ctx;

    this.container.appendChild(this.canvas);
    parent.appendChild(this.container);

    this.setupEventListeners();
  }

  /**
   * Set up mouse/touch event listeners
   */
  private setupEventListeners(): void {
    // Mouse events
    this.container.addEventListener('mousedown', this.handleMouseDown.bind(this));
    this.container.addEventListener('mousemove', this.handleMouseMove.bind(this));
    this.container.addEventListener('mouseup', this.handleMouseUp.bind(this));
    this.container.addEventListener('mouseleave', this.handleMouseUp.bind(this));

    // Touch events
    this.container.addEventListener('touchstart', this.handleTouchStart.bind(this));
    this.container.addEventListener('touchmove', this.handleTouchMove.bind(this));
    this.container.addEventListener('touchend', this.handleTouchEnd.bind(this));
  }

  /**
   * Handle mouse down - start selection
   */
  private handleMouseDown(e: MouseEvent): void {
    if (!this.config.enabled) return;

    e.preventDefault();
    e.stopPropagation();

    const point = this.getRelativePoint(e.clientX, e.clientY);
    this.startSelection(point);
  }

  /**
   * Handle mouse move - update selection
   */
  private handleMouseMove(e: MouseEvent): void {
    if (!this.isSelecting || !this.startPoint) return;

    const point = this.getRelativePoint(e.clientX, e.clientY);
    this.updateSelection(point);
  }

  /**
   * Handle mouse up - complete selection
   */
  private handleMouseUp(e: MouseEvent): void {
    if (!this.isSelecting) return;

    const point = this.getRelativePoint(e.clientX, e.clientY);
    this.completeSelection(point);
  }

  /**
   * Handle touch start
   */
  private handleTouchStart(e: TouchEvent): void {
    if (!this.config.enabled || e.touches.length !== 1) return;

    e.preventDefault();

    const touch = e.touches[0];
    const point = this.getRelativePoint(touch.clientX, touch.clientY);
    this.startSelection(point);
  }

  /**
   * Handle touch move
   */
  private handleTouchMove(e: TouchEvent): void {
    if (!this.isSelecting || !this.startPoint || e.touches.length !== 1) return;

    e.preventDefault();

    const touch = e.touches[0];
    const point = this.getRelativePoint(touch.clientX, touch.clientY);
    this.updateSelection(point);
  }

  /**
   * Handle touch end
   */
  private handleTouchEnd(e: TouchEvent): void {
    if (!this.isSelecting) return;

    if (this.currentRect) {
      // Use the last known position from currentRect
      this.completeSelection({
        x: this.currentRect.x + this.currentRect.width,
        y: this.currentRect.y + this.currentRect.height,
      });
    } else {
      this.cancelSelection();
    }
  }

  /**
   * Get point relative to container
   */
  private getRelativePoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.container.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  /**
   * Start a new selection
   */
  private startSelection(point: { x: number; y: number }): void {
    this.isSelecting = true;
    this.startPoint = point;
    this.currentRect = null;
    this.clear();
  }

  /**
   * Update selection rectangle
   */
  private updateSelection(point: { x: number; y: number }): void {
    if (!this.startPoint) return;

    // Calculate rectangle
    const x = Math.min(this.startPoint.x, point.x);
    const y = Math.min(this.startPoint.y, point.y);
    const width = Math.abs(point.x - this.startPoint.x);
    const height = Math.abs(point.y - this.startPoint.y);

    this.currentRect = { x, y, width, height };
    this.draw();
  }

  /**
   * Complete selection and emit event
   */
  private completeSelection(point: { x: number; y: number }): void {
    if (!this.startPoint) {
      this.cancelSelection();
      return;
    }

    this.updateSelection(point);

    // Check minimum size
    if (
      !this.currentRect ||
      this.currentRect.width < this.config.minSize ||
      this.currentRect.height < this.config.minSize
    ) {
      this.cancelSelection();
      return;
    }

    // Emit selection event
    if (this.onSelection && this.displayWidth && this.displayHeight) {
      const normalizedRect: PdfRect = {
        x: this.currentRect.x / this.displayWidth,
        y: this.currentRect.y / this.displayHeight,
        width: this.currentRect.width / this.displayWidth,
        height: this.currentRect.height / this.displayHeight,
      };

      // Calculate popup position (center-top of selection)
      const containerRect = this.container.getBoundingClientRect();
      const position = {
        x: containerRect.left + this.currentRect.x + this.currentRect.width / 2,
        y: containerRect.top + this.currentRect.y,
      };

      this.onSelection({
        page: this.currentPage,
        rect: normalizedRect,
        displayRect: { ...this.currentRect },
        position,
      });
    }

    // Reset state but keep the rectangle visible
    this.isSelecting = false;
    this.startPoint = null;
  }

  /**
   * Cancel current selection
   */
  private cancelSelection(): void {
    this.isSelecting = false;
    this.startPoint = null;
    this.currentRect = null;
    this.clear();
  }

  /**
   * Draw the selection rectangle
   */
  private draw(): void {
    this.clear();

    if (!this.currentRect) return;

    const { x, y, width, height } = this.currentRect;

    // Draw fill
    this.ctx.fillStyle = this.config.color;
    this.ctx.fillRect(x, y, width, height);

    // Draw border
    this.ctx.strokeStyle = this.config.borderColor;
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([5, 3]);
    this.ctx.strokeRect(x, y, width, height);
  }

  /**
   * Clear the canvas
   */
  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Clear selection and reset state
   */
  clearSelection(): void {
    this.cancelSelection();
  }

  /**
   * Update display dimensions
   */
  setDimensions(width: number, height: number): void {
    this.displayWidth = width;
    this.displayHeight = height;

    // Update canvas size for HiDPI
    const dpr = getDevicePixelRatio();
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Set current page
   */
  setPage(page: number): void {
    this.currentPage = page;
    this.cancelSelection();
  }

  /**
   * Enable or disable selection
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.container.style.pointerEvents = enabled ? 'auto' : 'none';
    if (!enabled) {
      this.cancelSelection();
    }
  }

  /**
   * Check if selection is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Set selection callback
   */
  setOnSelection(callback: RegionSelectionCallback): void {
    this.onSelection = callback;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RegionSelectionConfig>): void {
    Object.assign(this.config, config);
    if (config.enabled !== undefined) {
      this.setEnabled(config.enabled);
    }
  }

  /**
   * Get container element
   */
  getContainer(): HTMLDivElement {
    return this.container;
  }

  /**
   * Highlight a specific region temporarily
   */
  highlightRegion(rect: PdfRect, duration = 2000): void {
    if (!this.displayWidth || !this.displayHeight) return;

    // Convert normalized to display coordinates
    const displayRect = {
      x: rect.x * this.displayWidth,
      y: rect.y * this.displayHeight,
      width: rect.width * this.displayWidth,
      height: rect.height * this.displayHeight,
    };

    this.currentRect = displayRect;
    this.draw();

    // Clear after duration
    setTimeout(() => {
      if (
        this.currentRect &&
        this.currentRect.x === displayRect.x &&
        this.currentRect.y === displayRect.y
      ) {
        this.clear();
        this.currentRect = null;
      }
    }, duration);
  }

  /**
   * Destroy the selection handler
   */
  destroy(): void {
    this.container.remove();
  }
}

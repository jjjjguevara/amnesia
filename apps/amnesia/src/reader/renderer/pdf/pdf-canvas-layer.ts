/**
 * PDF Canvas Layer
 *
 * Manages canvas element for page rendering with HiDPI support.
 * Handles rotation and scaling transformations.
 *
 * amnesia-4a8: H7 fix - Now reads DPR fresh on each resize to handle display switching.
 */

import { getDevicePixelRatio } from './dpr-utils';

export interface CanvasLayerConfig {
  /** Device pixel ratio override (if not provided, uses current window DPR) */
  pixelRatio?: number;
}

export class PdfCanvasLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Optional DPR override from config. If undefined, uses fresh window DPR. */
  private pixelRatioOverride?: number;

  // Current state
  private currentWidth = 0;
  private currentHeight = 0;
  private currentRotation = 0;

  constructor(container: HTMLElement, config?: CanvasLayerConfig) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pdf-canvas-layer';
    this.canvas.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    `;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context');
    }
    this.ctx = ctx;

    // amnesia-4a8: Store override only if explicitly provided, otherwise read fresh on resize
    this.pixelRatioOverride = config?.pixelRatio;

    container.appendChild(this.canvas);
  }

  /**
   * Get current DPR - uses override if set, otherwise reads fresh from window.
   * This handles display switching (e.g., moving window between Retina and non-Retina displays).
   */
  private getDpr(): number {
    return this.pixelRatioOverride ?? getDevicePixelRatio();
  }

  /**
   * Resize canvas to fit container with HiDPI support
   */
  resize(width: number, height: number): void {
    this.currentWidth = width;
    this.currentHeight = height;

    // amnesia-4a8: Read fresh DPR on each resize to handle display switching
    const dpr = this.getDpr();

    // Set actual size in memory (scaled for HiDPI)
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);

    // Set display size (CSS pixels)
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    // Scale context to handle HiDPI
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Render page image from blob
   *
   * @param imageBlob - The page image blob from the server
   * @param maxWidth - Maximum width available for display (container width minus margins)
   * @param maxHeight - Maximum height available for display (container height minus margins)
   * @param rotation - Rotation in degrees (0, 90, 180, 270)
   */
  async renderPage(
    imageBlob: Blob,
    maxWidth: number,
    maxHeight: number,
    rotation: number = 0
  ): Promise<void> {
    this.currentRotation = rotation;

    // Create image from blob
    const imageUrl = URL.createObjectURL(imageBlob);
    const image = new Image();

    return new Promise((resolve, reject) => {
      image.onload = () => {
        try {
          // Get the actual image dimensions from the server-rendered image
          // Note: The server already applies rotation, so the image dimensions
          // reflect the rotated page (e.g., portrait becomes landscape at 90°)
          const imageWidth = image.naturalWidth;
          const imageHeight = image.naturalHeight;

          // Calculate aspect-ratio-preserving display dimensions
          // The image should fit within maxWidth x maxHeight while preserving aspect ratio
          const imageAspect = imageWidth / imageHeight;
          const containerAspect = maxWidth / maxHeight;

          let displayWidth: number;
          let displayHeight: number;

          if (imageAspect > containerAspect) {
            // Image is wider than container - fit to width
            displayWidth = maxWidth;
            displayHeight = maxWidth / imageAspect;
          } else {
            // Image is taller than container - fit to height
            displayHeight = maxHeight;
            displayWidth = maxHeight * imageAspect;
          }

          // Resize canvas to match calculated dimensions
          this.resize(displayWidth, displayHeight);

          // Clear canvas
          this.ctx.clearRect(0, 0, displayWidth, displayHeight);

          // Draw image directly - server already applied rotation
          this.ctx.drawImage(image, 0, 0, displayWidth, displayHeight);

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
   * Clear the canvas
   */
  clear(): void {
    this.ctx.clearRect(0, 0, this.currentWidth, this.currentHeight);
  }

  /**
   * Get canvas element
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Get current dimensions
   */
  getDimensions(): { width: number; height: number } {
    return {
      width: this.currentWidth,
      height: this.currentHeight,
    };
  }

  /**
   * Get current rotation
   */
  getRotation(): number {
    return this.currentRotation;
  }

  /**
   * Convert page coordinates to canvas coordinates
   */
  pageToCanvas(x: number, y: number): { x: number; y: number } {
    const rotation = this.currentRotation;
    const width = this.currentWidth;
    const height = this.currentHeight;

    switch (rotation) {
      case 90:
        return { x: y, y: width - x };
      case 180:
        return { x: width - x, y: height - y };
      case 270:
        return { x: height - y, y: x };
      default:
        return { x, y };
    }
  }

  /**
   * Convert canvas coordinates to page coordinates
   */
  canvasToPage(x: number, y: number): { x: number; y: number } {
    const rotation = this.currentRotation;
    const width = this.currentWidth;
    const height = this.currentHeight;

    switch (rotation) {
      case 90:
        return { x: width - y, y: x };
      case 180:
        return { x: width - x, y: height - y };
      case 270:
        return { x: y, y: height - x };
      default:
        return { x, y };
    }
  }

  /**
   * Destroy the layer
   */
  destroy(): void {
    this.canvas.remove();
  }
}

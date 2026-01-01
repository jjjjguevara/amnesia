/**
 * PDF Canvas Layer
 *
 * Manages canvas element for page rendering with HiDPI support.
 * Handles rotation and scaling transformations.
 */

export interface CanvasLayerConfig {
  /** Device pixel ratio for HiDPI displays */
  pixelRatio?: number;
}

export class PdfCanvasLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private devicePixelRatio: number;

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

    this.devicePixelRatio = config?.pixelRatio ?? window.devicePixelRatio ?? 1;

    container.appendChild(this.canvas);
  }

  /**
   * Resize canvas to fit container with HiDPI support
   */
  resize(width: number, height: number): void {
    this.currentWidth = width;
    this.currentHeight = height;

    // Set actual size in memory (scaled for HiDPI)
    this.canvas.width = Math.floor(width * this.devicePixelRatio);
    this.canvas.height = Math.floor(height * this.devicePixelRatio);

    // Set display size (CSS pixels)
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    // Scale context to handle HiDPI
    this.ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
  }

  /**
   * Render page image from blob
   */
  async renderPage(
    imageBlob: Blob,
    pageWidth: number,
    pageHeight: number,
    rotation: number = 0
  ): Promise<void> {
    this.currentRotation = rotation;

    // Create image from blob
    const imageUrl = URL.createObjectURL(imageBlob);
    const image = new Image();

    return new Promise((resolve, reject) => {
      image.onload = () => {
        try {
          // Calculate dimensions based on rotation
          const isRotated = rotation === 90 || rotation === 270;
          const displayWidth = isRotated ? pageHeight : pageWidth;
          const displayHeight = isRotated ? pageWidth : pageHeight;

          // Resize canvas to match page dimensions
          this.resize(displayWidth, displayHeight);

          // Clear canvas
          this.ctx.clearRect(0, 0, displayWidth, displayHeight);

          // Apply rotation transform
          this.ctx.save();
          if (rotation !== 0) {
            this.ctx.translate(displayWidth / 2, displayHeight / 2);
            this.ctx.rotate((rotation * Math.PI) / 180);
            this.ctx.translate(-pageWidth / 2, -pageHeight / 2);
          }

          // Draw image
          this.ctx.drawImage(image, 0, 0, pageWidth, pageHeight);

          this.ctx.restore();

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

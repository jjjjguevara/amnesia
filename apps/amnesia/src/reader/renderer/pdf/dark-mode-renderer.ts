/**
 * Dark Mode Renderer
 *
 * Smart dark mode for PDFs that inverts text/background while preserving images.
 * Uses heuristics to detect image regions and avoid inverting them.
 *
 * Approaches:
 * 1. CSS filter: Quick apply/remove with `filter: invert(1) hue-rotate(180deg)`
 * 2. Canvas processing: Selective inversion for better image preservation
 *
 * @example
 * ```typescript
 * import { DarkModeRenderer } from './dark-mode-renderer';
 *
 * const renderer = new DarkModeRenderer();
 * renderer.applyDarkMode(canvas);
 * renderer.removeDarkMode(canvas);
 * ```
 */

/**
 * Dark mode configuration
 */
export interface DarkModeConfig {
  /** Background color in dark mode (default: #1e1e1e) */
  backgroundColor?: string;
  /** Text color in dark mode (default: #e0e0e0) */
  textColor?: string;
  /** Whether to preserve images from inversion (default: true) */
  preserveImages?: boolean;
  /** Image detection sensitivity 0-1 (default: 0.3) */
  imageSensitivity?: number;
}

const DEFAULT_CONFIG: Required<DarkModeConfig> = {
  backgroundColor: '#1e1e1e',
  textColor: '#e0e0e0',
  preserveImages: true,
  imageSensitivity: 0.3,
};

/**
 * CSS variables for dark mode theming
 */
export const DARK_MODE_CSS_VARS = {
  '--pdf-bg-color': '#1e1e1e',
  '--pdf-text-color': '#e0e0e0',
  '--pdf-highlight-color': '#4a4a00',
  '--pdf-link-color': '#6db3f2',
};

/**
 * Dark mode renderer for PDF pages
 */
export class DarkModeRenderer {
  private config: Required<DarkModeConfig>;

  constructor(config: DarkModeConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Apply CSS-based dark mode to an element
   * Fast and simple, but inverts everything including images
   */
  applyCssDarkMode(element: HTMLElement): void {
    element.style.filter = 'invert(1) hue-rotate(180deg)';
    element.style.backgroundColor = this.config.backgroundColor;
  }

  /**
   * Remove CSS-based dark mode from an element
   */
  removeCssDarkMode(element: HTMLElement): void {
    element.style.filter = '';
    element.style.backgroundColor = '';
  }

  /**
   * Apply dark mode to a canvas with optional image preservation
   * Slower but preserves images by detecting high-variance regions
   * @returns true if successful, false if failed (falls back to CSS filter)
   */
  applyCanvasDarkMode(canvas: HTMLCanvasElement): boolean {
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    try {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      if (this.config.preserveImages) {
        // Process with image preservation
        this.invertWithImagePreservation(data, canvas.width, canvas.height);
      } else {
        // Simple inversion
        this.simpleInvert(data);
      }

      ctx.putImageData(imageData, 0, 0);
      return true;
    } catch (error) {
      console.error('[DarkModeRenderer] Failed to apply canvas dark mode:', error);
      // Fall back to CSS filter if canvas processing fails
      canvas.style.filter = 'invert(1) hue-rotate(180deg)';
      return false;
    }
  }

  /**
   * Process a rendered page blob for dark mode
   * Returns a new blob with dark mode applied
   */
  async processPageBlob(blob: Blob): Promise<Blob> {
    // Create image from blob
    const imageBitmap = await createImageBitmap(blob);

    try {
      // Create canvas
      const canvas = document.createElement('canvas');
      canvas.width = imageBitmap.width;
      canvas.height = imageBitmap.height;

      // willReadFrequently optimization: we'll call getImageData in applyCanvasDarkMode
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        throw new Error('Failed to get 2D context');
      }

      // Draw image
      ctx.drawImage(imageBitmap, 0, 0);

      // Apply dark mode (will use getImageData)
      this.applyCanvasDarkMode(canvas);

      // Convert back to blob
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((newBlob) => {
          if (newBlob) {
            resolve(newBlob);
          } else {
            reject(new Error('Failed to create blob from canvas'));
          }
        }, 'image/png');
      });
    } finally {
      // Always close the ImageBitmap to prevent memory leaks
      imageBitmap.close();
    }
  }

  /**
   * Simple color inversion
   */
  private simpleInvert(data: Uint8ClampedArray): void {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i];         // R
      data[i + 1] = 255 - data[i + 1]; // G
      data[i + 2] = 255 - data[i + 2]; // B
      // Alpha unchanged
    }
  }

  /**
   * HSL Lightness Inversion - Inverts only the lightness component
   *
   * This approach preserves:
   * - Anti-aliasing (each pixel processed individually)
   * - Hue and saturation (colors stay recognizable)
   * - Smooth gradients (no block-based artifacts)
   *
   * The algorithm:
   * 1. Convert RGB to HSL
   * 2. Invert L: L_new = 1 - L_old
   * 3. Convert back to RGB
   *
   * This is superior to simple RGB inversion because it maintains
   * color relationships while reversing perceived brightness.
   */
  private hslLightnessInvert(data: Uint8ClampedArray): void {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;

      // Convert RGB to HSL
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;

      // Skip fully transparent pixels
      if (data[i + 3] === 0) continue;

      // Invert lightness
      const newL = 1 - l;

      // If achromatic (grayscale), simplified calculation
      if (max === min) {
        const gray = Math.round(newL * 255);
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
        continue;
      }

      // Calculate hue and saturation
      const d = max - min;
      const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

      let h: number;
      if (max === r) {
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      } else if (max === g) {
        h = ((b - r) / d + 2) / 6;
      } else {
        h = ((r - g) / d + 4) / 6;
      }

      // Convert back to RGB with inverted lightness
      const newRgb = this.hslToRgb(h, s, newL);
      data[i] = Math.round(newRgb.r * 255);
      data[i + 1] = Math.round(newRgb.g * 255);
      data[i + 2] = Math.round(newRgb.b * 255);
      // Alpha unchanged
    }
  }

  /**
   * Convert HSL to RGB
   * @param h Hue (0-1)
   * @param s Saturation (0-1)
   * @param l Lightness (0-1)
   */
  private hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    if (s === 0) {
      // Achromatic
      return { r: l, g: l, b: l };
    }

    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    return {
      r: hue2rgb(p, q, h + 1/3),
      g: hue2rgb(p, q, h),
      b: hue2rgb(p, q, h - 1/3),
    };
  }

  /**
   * Apply HSL lightness inversion dark mode to canvas
   * This is the recommended approach for dark mode as it:
   * - Preserves anti-aliasing and text sharpness
   * - Maintains color relationships
   * - Avoids block-based artifacts from variance detection
   *
   * @returns true if successful, false if failed
   */
  applyHslDarkMode(canvas: HTMLCanvasElement): boolean {
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    try {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      this.hslLightnessInvert(imageData.data);
      ctx.putImageData(imageData, 0, 0);
      return true;
    } catch (error) {
      console.error('[DarkModeRenderer] Failed to apply HSL dark mode:', error);
      // Fall back to CSS filter
      canvas.style.filter = 'invert(0.9) hue-rotate(180deg)';
      return false;
    }
  }

  /**
   * Invert colors while preserving image regions
   * Uses local variance detection to identify photos/diagrams
   */
  private invertWithImagePreservation(
    data: Uint8ClampedArray,
    width: number,
    height: number
  ): void {
    // Calculate local variance map using a sliding window
    const blockSize = 8; // 8x8 pixel blocks
    const varianceMap = this.calculateVarianceMap(data, width, height, blockSize);

    // Determine threshold for image detection
    const threshold = this.config.imageSensitivity;

    // Invert pixels that are NOT in high-variance (image) regions
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const blockX = Math.floor(x / blockSize);
        const blockY = Math.floor(y / blockSize);
        const blocksPerRow = Math.ceil(width / blockSize);
        const blockIdx = blockY * blocksPerRow + blockX;

        const variance = varianceMap[blockIdx] ?? 0;
        const isImage = variance > threshold;

        const pixelIdx = (y * width + x) * 4;

        if (!isImage) {
          // Invert non-image pixels
          data[pixelIdx] = 255 - data[pixelIdx];         // R
          data[pixelIdx + 1] = 255 - data[pixelIdx + 1]; // G
          data[pixelIdx + 2] = 255 - data[pixelIdx + 2]; // B
        }
        // Images are left unchanged
      }
    }
  }

  /**
   * Calculate variance map for image detection
   * Higher variance indicates photo/diagram regions
   * Uses Welford's online algorithm for single-pass variance calculation
   */
  private calculateVarianceMap(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    blockSize: number
  ): Float32Array {
    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const varianceMap = new Float32Array(blocksX * blocksY);

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        const startX = bx * blockSize;
        const startY = by * blockSize;
        const endX = Math.min(startX + blockSize, width);
        const endY = Math.min(startY + blockSize, height);

        // Single-pass variance using Welford's algorithm
        let count = 0;
        let mean = 0;
        let m2 = 0;

        for (let y = startY; y < endY; y++) {
          for (let x = startX; x < endX; x++) {
            const idx = (y * width + x) * 4;
            // Use luminance formula
            const luminance = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];

            count++;
            const delta = luminance - mean;
            mean += delta / count;
            const delta2 = luminance - mean;
            m2 += delta * delta2;
          }
        }

        const variance = count > 0 ? m2 / count : 0;
        // Normalize variance to 0-1 range
        const normalizedVariance = Math.min(1, variance / 2500);

        varianceMap[by * blocksX + bx] = normalizedVariance;
      }
    }

    return varianceMap;
  }

  /**
   * Check if a page likely contains images
   * Can be used to decide between CSS or canvas processing
   */
  async detectImages(blob: Blob): Promise<boolean> {
    const imageBitmap = await createImageBitmap(blob);

    try {
      const canvas = document.createElement('canvas');
      // Use smaller size for faster detection
      const scale = Math.min(1, 200 / Math.max(imageBitmap.width, imageBitmap.height));
      canvas.width = Math.floor(imageBitmap.width * scale);
      canvas.height = Math.floor(imageBitmap.height * scale);

      // willReadFrequently optimization: we call getImageData for variance analysis
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;

      ctx.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Calculate overall variance
      const varianceMap = this.calculateVarianceMap(
        imageData.data,
        canvas.width,
        canvas.height,
        8
      );

      // Check if any blocks have high variance (indicating images)
      const highVarianceCount = varianceMap.filter((v) => v > this.config.imageSensitivity).length;
      const highVarianceRatio = highVarianceCount / varianceMap.length;

      // If more than 10% of blocks are high-variance, likely has images
      return highVarianceRatio > 0.1;
    } finally {
      // Always close the ImageBitmap to prevent memory leaks
      imageBitmap.close();
    }
  }
}

/**
 * Get CSS class for dark mode
 */
export function getDarkModeCss(): string {
  return `
    .pdf-dark-mode {
      filter: invert(1) hue-rotate(180deg);
      background-color: ${DEFAULT_CONFIG.backgroundColor};
    }

    .pdf-dark-mode .pdf-preserve-colors {
      filter: invert(1) hue-rotate(180deg);
    }

    .pdf-page-element.pdf-dark-mode {
      background-color: ${DEFAULT_CONFIG.backgroundColor} !important;
    }
  `;
}

/**
 * Apply Obsidian-themed dark mode to container
 */
export function applyObsidianDarkMode(container: HTMLElement): void {
  container.style.setProperty('--pdf-bg-color', '#1e1e1e');
  container.style.setProperty('--pdf-text-color', '#dcddde');
  container.style.setProperty('--pdf-highlight-color', '#e9c46a22');
  container.style.setProperty('--pdf-link-color', '#7f6df2');
}

/**
 * Create a dark mode renderer with Obsidian theme colors
 */
export function createObsidianDarkModeRenderer(): DarkModeRenderer {
  return new DarkModeRenderer({
    backgroundColor: '#1e1e1e',
    textColor: '#dcddde',
    preserveImages: true,
    imageSensitivity: 0.3,
  });
}

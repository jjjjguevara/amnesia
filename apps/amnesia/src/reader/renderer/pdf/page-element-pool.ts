/**
 * Page Element Pool
 *
 * Recycles PDF page elements to reduce DOM operations and improve performance.
 * Instead of creating and destroying elements during scroll, elements are
 * acquired from the pool and released back for reuse.
 *
 * Benefits:
 * - Reduces GC pressure by reusing objects
 * - Reduces DOM manipulation overhead
 * - Faster element acquisition vs creation
 */

import { PdfPageElement, type ReadingMode, type TextLayerMode } from './pdf-page-element';
import type { SvgTextLayerFetcher } from './pdf-svg-text-layer';

export interface PageElementPoolConfig {
  /** Maximum elements to keep in pool. Default: 20 */
  maxPoolSize?: number;
  /** Pixel ratio for HiDPI displays */
  pixelRatio?: number;
  /** Enable text anti-aliasing */
  enableTextAntialiasing?: boolean;
  /** Enable image smoothing */
  enableImageSmoothing?: boolean;
  /** Text layer rendering mode. Default: 'svg' */
  textLayerMode?: TextLayerMode;
  /** PDF identifier (required for SVG text layer mode) */
  pdfId?: string;
  /** Function to fetch SVG text layer (required for SVG text layer mode) */
  svgTextLayerFetcher?: SvgTextLayerFetcher;
}

export interface PoolStats {
  /** Number of elements currently in pool */
  poolSize: number;
  /** Maximum pool capacity */
  maxPoolSize: number;
  /** Total elements acquired from pool */
  acquireCount: number;
  /** Total elements released to pool */
  releaseCount: number;
  /** Elements created (pool was empty) */
  createCount: number;
}

/**
 * Pool for recycling PDF page elements
 */
export class PageElementPool {
  private pool: PdfPageElement[] = [];
  private maxPoolSize: number;
  private config: PageElementPoolConfig;

  // Statistics
  private acquireCount = 0;
  private releaseCount = 0;
  private createCount = 0;

  constructor(config: PageElementPoolConfig = {}) {
    this.maxPoolSize = config.maxPoolSize ?? 20;
    this.config = config;
  }

  /**
   * Acquire an element from the pool
   * Creates a new element if pool is empty
   */
  acquire(pageNumber: number): PdfPageElement {
    this.acquireCount++;

    if (this.pool.length > 0) {
      // Reuse element from pool
      const element = this.pool.pop()!;
      element.reset(pageNumber);
      return element;
    }

    // Pool is empty, create new element
    this.createCount++;
    return new PdfPageElement({
      pageNumber,
      pixelRatio: this.config.pixelRatio,
      enableTextAntialiasing: this.config.enableTextAntialiasing,
      enableImageSmoothing: this.config.enableImageSmoothing,
      textLayerMode: this.config.textLayerMode,
      pdfId: this.config.pdfId,
      svgTextLayerFetcher: this.config.svgTextLayerFetcher,
    });
  }

  /**
   * Release an element back to the pool
   * Element is destroyed if pool is at capacity
   */
  release(element: PdfPageElement): void {
    this.releaseCount++;

    // Clear element state for reuse
    element.clear();

    if (this.pool.length < this.maxPoolSize) {
      // Return to pool for reuse
      this.pool.push(element);
    } else {
      // Pool is full, destroy the element
      element.destroy();
    }
  }

  /**
   * Pre-populate the pool with elements
   * Useful for initial load to avoid creation during scroll
   */
  prewarm(count: number): void {
    const toCreate = Math.min(count, this.maxPoolSize - this.pool.length);

    for (let i = 0; i < toCreate; i++) {
      this.createCount++;
      const element = new PdfPageElement({
        pageNumber: 0, // Placeholder page number
        pixelRatio: this.config.pixelRatio,
        enableTextAntialiasing: this.config.enableTextAntialiasing,
        enableImageSmoothing: this.config.enableImageSmoothing,
        textLayerMode: this.config.textLayerMode,
        pdfId: this.config.pdfId,
        svgTextLayerFetcher: this.config.svgTextLayerFetcher,
      });
      element.clear(); // Ensure clean state
      this.pool.push(element);
    }
  }

  /**
   * Update configuration for new elements
   */
  updateConfig(config: Partial<PageElementPoolConfig>): void {
    if (config.maxPoolSize !== undefined) {
      this.maxPoolSize = config.maxPoolSize;
      // Trim pool if new size is smaller
      while (this.pool.length > this.maxPoolSize) {
        const element = this.pool.pop()!;
        element.destroy();
      }
    }
    if (config.pixelRatio !== undefined) {
      this.config.pixelRatio = config.pixelRatio;
    }
    if (config.enableTextAntialiasing !== undefined) {
      this.config.enableTextAntialiasing = config.enableTextAntialiasing;
    }
    if (config.enableImageSmoothing !== undefined) {
      this.config.enableImageSmoothing = config.enableImageSmoothing;
    }
    if (config.textLayerMode !== undefined) {
      this.config.textLayerMode = config.textLayerMode;
    }
    if (config.pdfId !== undefined) {
      this.config.pdfId = config.pdfId;
    }
    if (config.svgTextLayerFetcher !== undefined) {
      this.config.svgTextLayerFetcher = config.svgTextLayerFetcher;
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    return {
      poolSize: this.pool.length,
      maxPoolSize: this.maxPoolSize,
      acquireCount: this.acquireCount,
      releaseCount: this.releaseCount,
      createCount: this.createCount,
    };
  }

  /**
   * Clear the pool and destroy all elements
   */
  clear(): void {
    for (const element of this.pool) {
      element.destroy();
    }
    this.pool = [];
  }

  /**
   * Destroy the pool
   */
  destroy(): void {
    this.clear();
    this.acquireCount = 0;
    this.releaseCount = 0;
    this.createCount = 0;
  }
}

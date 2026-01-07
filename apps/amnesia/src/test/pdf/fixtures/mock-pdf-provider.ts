/**
 * Mock PDF provider for testing
 */

import type { PdfContentProvider, PdfDocumentInfo, PageRenderResult } from '../../../reader/renderer/types';
import { createMinimalTextLayer, createLargeTextLayer } from './test-text-layer-data';

export interface MockPdfProviderConfig {
  /** Number of pages in the mock PDF */
  pageCount?: number;
  /** Simulated render delay in ms */
  renderDelay?: number;
  /** Whether to include text layer data */
  includeTextLayer?: boolean;
  /** Number of text items per page (for virtualization testing) */
  textItemsPerPage?: number;
  /** Simulate render failures for these page numbers */
  failPages?: number[];
}

/**
 * Create a mock page image blob
 */
function createMockImageBlob(): Blob {
  // Create a minimal valid PNG (1x1 white pixel)
  const pngData = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 dimension
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
    0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0xff, 0x00,
    0x05, 0xfe, 0x02, 0xfe, 0xa3, 0x51, 0x90, 0x4c,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND chunk
    0xae, 0x42, 0x60, 0x82,
  ]);
  return new Blob([pngData], { type: 'image/png' });
}

/**
 * Mock PDF provider for unit testing
 */
export class MockPdfProvider implements PdfContentProvider {
  private config: Required<MockPdfProviderConfig>;
  private renderCount = 0;
  private prefetchedPages = new Set<number>();

  constructor(config: MockPdfProviderConfig = {}) {
    this.config = {
      pageCount: config.pageCount ?? 100,
      renderDelay: config.renderDelay ?? 0,
      includeTextLayer: config.includeTextLayer ?? true,
      textItemsPerPage: config.textItemsPerPage ?? 50,
      failPages: config.failPages ?? [],
    };
  }

  async getDocumentInfo(): Promise<PdfDocumentInfo> {
    return {
      pageCount: this.config.pageCount,
      title: 'Mock PDF Document',
      author: 'Test Author',
      pageWidth: 612,
      pageHeight: 792,
    };
  }

  async renderPage(page: number, scale: number): Promise<PageRenderResult> {
    // Simulate render delay
    if (this.config.renderDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.renderDelay));
    }

    // Simulate failures
    if (this.config.failPages.includes(page)) {
      throw new Error(`Simulated render failure for page ${page}`);
    }

    this.renderCount++;

    const result: PageRenderResult = {
      imageBlob: createMockImageBlob(),
      width: Math.floor(612 * scale),
      height: Math.floor(792 * scale),
    };

    if (this.config.includeTextLayer) {
      result.textLayer =
        this.config.textItemsPerPage > 50
          ? createLargeTextLayer(this.config.textItemsPerPage)
          : createMinimalTextLayer();
    }

    return result;
  }

  async prefetchPage(page: number): Promise<void> {
    this.prefetchedPages.add(page);
    // Simulate prefetch (just marks as prefetched)
    if (this.config.renderDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.renderDelay / 2));
    }
  }

  /**
   * Notify page change (for adaptive prefetching)
   * This method is checked for via duck-typing in pdf-renderer.ts
   */
  notifyPageChange(page: number): void {
    // In a real implementation, this would notify the AdaptivePrefetcher
    // For testing, we just track that it was called
  }

  // Test helper methods

  getRenderCount(): number {
    return this.renderCount;
  }

  getPrefetchedPages(): Set<number> {
    return new Set(this.prefetchedPages);
  }

  wasPrefetched(page: number): boolean {
    return this.prefetchedPages.has(page);
  }

  reset(): void {
    this.renderCount = 0;
    this.prefetchedPages.clear();
  }
}

/**
 * Create a mock provider with default settings
 */
export function createMockProvider(config?: MockPdfProviderConfig): MockPdfProvider {
  return new MockPdfProvider(config);
}

/**
 * Create a mock provider that simulates a large document
 */
export function createLargeDocumentProvider(): MockPdfProvider {
  return new MockPdfProvider({
    pageCount: 500,
    textItemsPerPage: 200,
  });
}

/**
 * Create a mock provider with slow rendering (for testing loading states)
 */
export function createSlowProvider(): MockPdfProvider {
  return new MockPdfProvider({
    renderDelay: 100,
  });
}

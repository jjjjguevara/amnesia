/**
 * Hybrid PDF Provider
 *
 * Switches between server-based rendering and PDF.js fallback.
 * Uses server when available for better performance, falls back to
 * PDF.js for offline use or when server is unavailable.
 *
 * @example
 * ```typescript
 * import { HybridPdfProvider } from './hybrid-pdf-provider';
 *
 * const provider = new HybridPdfProvider({
 *   serverBaseUrl: 'http://localhost:3000',
 *   preferServer: true,
 * });
 *
 * await provider.loadDocument(pdfData);
 * const pageImage = await provider.renderPage(1, { scale: 1.5 });
 * ```
 */

import { ApiClient, getApiClient } from '../api-client';
import { PdfJsProvider } from './pdfjs-provider';
import type {
  ParsedPdf,
  PdfTextLayerData,
  PdfRenderOptions,
  PdfSearchResult,
} from '../types';

export type PdfProviderMode = 'server' | 'pdfjs' | 'auto';

export interface HybridPdfProviderConfig {
  /** Server base URL */
  serverBaseUrl?: string;
  /** Preferred provider mode */
  preferMode?: PdfProviderMode;
  /** Timeout for server health check in ms */
  healthCheckTimeout?: number;
  /** Device ID for server requests */
  deviceId?: string;
}

export interface HybridPdfProviderStatus {
  activeMode: 'server' | 'pdfjs';
  serverAvailable: boolean;
  documentId: string | null;
  pageCount: number;
}

/**
 * Hybrid PDF provider that uses server when available, PDF.js as fallback
 */
export class HybridPdfProvider {
  private config: Required<HybridPdfProviderConfig>;
  private apiClient: ApiClient | null = null;
  private pdfjsProvider: PdfJsProvider;
  private activeMode: 'server' | 'pdfjs' = 'pdfjs';
  private serverAvailable: boolean = false;
  private documentId: string | null = null;
  private parsedPdf: ParsedPdf | null = null;
  private pdfData: ArrayBuffer | null = null;

  constructor(config: HybridPdfProviderConfig = {}) {
    this.config = {
      serverBaseUrl: config.serverBaseUrl ?? '',
      preferMode: config.preferMode ?? 'auto',
      healthCheckTimeout: config.healthCheckTimeout ?? 5000,
      deviceId: config.deviceId ?? 'hybrid-provider',
    };

    this.pdfjsProvider = new PdfJsProvider();
  }

  /**
   * Get current provider status
   */
  getStatus(): HybridPdfProviderStatus {
    return {
      activeMode: this.activeMode,
      serverAvailable: this.serverAvailable,
      documentId: this.documentId,
      pageCount: this.parsedPdf?.pageCount ?? 0,
    };
  }

  /**
   * Check if server is available
   */
  async checkServerHealth(): Promise<boolean> {
    if (!this.config.serverBaseUrl) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.healthCheckTimeout
      );

      const response = await fetch(`${this.config.serverBaseUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);
      this.serverAvailable = response.ok;
      return this.serverAvailable;
    } catch {
      this.serverAvailable = false;
      return false;
    }
  }

  /**
   * Initialize the appropriate provider based on configuration and availability
   */
  async initialize(): Promise<void> {
    if (this.config.preferMode === 'pdfjs') {
      this.activeMode = 'pdfjs';
      return;
    }

    if (this.config.preferMode === 'server') {
      if (await this.checkServerHealth()) {
        this.activeMode = 'server';
        this.apiClient = getApiClient();
      } else {
        console.warn('Server not available, falling back to PDF.js');
        this.activeMode = 'pdfjs';
      }
      return;
    }

    // Auto mode: try server first, fall back to PDF.js
    if (this.config.serverBaseUrl && await this.checkServerHealth()) {
      this.activeMode = 'server';
      this.apiClient = getApiClient();
    } else {
      this.activeMode = 'pdfjs';
    }
  }

  /**
   * Load a PDF document from ArrayBuffer
   */
  async loadDocument(data: ArrayBuffer, documentId?: string): Promise<ParsedPdf> {
    this.pdfData = data;

    if (this.activeMode === 'server' && this.apiClient) {
      try {
        this.parsedPdf = await this.apiClient.uploadPdf(data, documentId);
        this.documentId = this.parsedPdf.id;
        return this.parsedPdf;
      } catch (error) {
        console.warn('Server upload failed, falling back to PDF.js:', error);
        this.activeMode = 'pdfjs';
      }
    }

    // Use PDF.js
    this.parsedPdf = await this.pdfjsProvider.loadDocument(data, documentId);
    this.documentId = this.parsedPdf.id;
    return this.parsedPdf;
  }

  /**
   * Load a PDF document from URL (server mode only)
   */
  async loadDocumentFromId(pdfId: string): Promise<ParsedPdf> {
    if (this.activeMode === 'server' && this.apiClient) {
      this.parsedPdf = await this.apiClient.getPdf(pdfId);
      this.documentId = pdfId;
      return this.parsedPdf;
    }

    throw new Error('loadDocumentFromId requires server mode');
  }

  /**
   * Render a page to a blob
   */
  async renderPage(pageNumber: number, options?: PdfRenderOptions): Promise<Blob> {
    if (this.activeMode === 'server' && this.apiClient && this.documentId) {
      try {
        return await this.apiClient.getPdfPage(this.documentId, pageNumber, options);
      } catch (error) {
        console.warn('Server render failed, falling back to PDF.js:', error);
        await this.switchToPdfJs();
      }
    }

    return this.pdfjsProvider.renderPage(pageNumber, options);
  }

  /**
   * Render page directly to a canvas element
   */
  async renderPageToCanvas(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    options?: PdfRenderOptions
  ): Promise<void> {
    if (this.activeMode === 'server' && this.apiClient && this.documentId) {
      try {
        const blob = await this.apiClient.getPdfPage(this.documentId, pageNumber, options);
        const img = await this.blobToImage(blob);

        const ctx = canvas.getContext('2d')!;
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        return;
      } catch (error) {
        console.warn('Server render failed, falling back to PDF.js:', error);
        await this.switchToPdfJs();
      }
    }

    return this.pdfjsProvider.renderPageToCanvas(pageNumber, canvas, options);
  }

  /**
   * Get text layer for a page
   */
  async getTextLayer(pageNumber: number): Promise<PdfTextLayerData> {
    if (this.activeMode === 'server' && this.apiClient && this.documentId) {
      try {
        return await this.apiClient.getPdfTextLayer(this.documentId, pageNumber);
      } catch (error) {
        console.warn('Server text layer failed, falling back to PDF.js:', error);
        await this.switchToPdfJs();
      }
    }

    return this.pdfjsProvider.getTextLayer(pageNumber);
  }

  /**
   * Get page dimensions
   */
  async getPageDimensions(pageNumber: number): Promise<{ width: number; height: number }> {
    if (this.activeMode === 'pdfjs') {
      return this.pdfjsProvider.getPageDimensions(pageNumber);
    }

    // For server mode, we'd need to extract this from the page render
    // For now, use PDF.js if available
    if (this.pdfData) {
      return this.pdfjsProvider.getPageDimensions(pageNumber);
    }

    throw new Error('Cannot get page dimensions without document data');
  }

  /**
   * Search for text
   */
  async search(query: string, limit: number = 50): Promise<PdfSearchResult[]> {
    if (this.activeMode === 'server' && this.apiClient && this.documentId) {
      try {
        return await this.apiClient.searchPdf(this.documentId, query, limit);
      } catch (error) {
        console.warn('Server search failed, falling back to PDF.js:', error);
        await this.switchToPdfJs();
      }
    }

    return this.pdfjsProvider.search(query, limit);
  }

  /**
   * Get page count
   */
  getPageCount(): number {
    return this.parsedPdf?.pageCount ?? 0;
  }

  /**
   * Get parsed PDF metadata
   */
  getParsedPdf(): ParsedPdf | null {
    return this.parsedPdf;
  }

  /**
   * Force switch to a specific mode
   */
  async switchMode(mode: 'server' | 'pdfjs'): Promise<void> {
    if (mode === 'server') {
      if (!await this.checkServerHealth()) {
        throw new Error('Server is not available');
      }
      this.activeMode = 'server';
      this.apiClient = getApiClient();

      // Re-upload document if we have it
      if (this.pdfData && this.documentId) {
        await this.loadDocument(this.pdfData, this.documentId);
      }
    } else {
      await this.switchToPdfJs();
    }
  }

  /**
   * Destroy the provider and release resources
   */
  async destroy(): Promise<void> {
    await this.pdfjsProvider.destroy();

    if (this.activeMode === 'server' && this.apiClient && this.documentId) {
      try {
        await this.apiClient.deletePdf(this.documentId);
      } catch {
        // Ignore cleanup errors
      }
    }

    this.documentId = null;
    this.parsedPdf = null;
    this.pdfData = null;
    this.apiClient = null;
  }

  // Private methods

  private async switchToPdfJs(): Promise<void> {
    if (this.activeMode === 'pdfjs') return;

    this.activeMode = 'pdfjs';

    // Load document into PDF.js if we have the data
    if (this.pdfData && !this.pdfjsProvider.getStatus().isLoaded) {
      await this.pdfjsProvider.loadDocument(this.pdfData, this.documentId ?? undefined);
    }
  }

  private blobToImage(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(img.src);
        resolve(img);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }
}

/**
 * Create a hybrid provider with default configuration
 */
export function createHybridPdfProvider(
  config?: HybridPdfProviderConfig
): HybridPdfProvider {
  return new HybridPdfProvider(config);
}

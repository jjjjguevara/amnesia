/**
 * EPUB Renderer Module
 *
 * Provides EPUB rendering capabilities using MuPDF WASM backend.
 *
 * Components:
 * - MuPDFEpubBridge: Low-level bridge to MuPDF worker for EPUB operations
 * - MuPDFEpubContentProvider: ContentProvider implementation for Shadow DOM
 *
 * This module is part of the EPUB migration from pub-rs to unified MuPDF WASM.
 */

// Bridge
export {
  MuPDFEpubBridge,
  getSharedMuPDFEpubBridge,
  destroySharedMuPDFEpubBridge,
  type EpubMetadata,
  type EpubSpineItem,
  type ParsedEpub,
  type EpubChapterContent,
  type EpubSearchResult,
  type FixedLayoutPageDimensions,
} from './mupdf-epub-bridge';

// Content Provider
export {
  MuPDFEpubContentProvider,
  getSharedMuPDFEpubContentProvider,
  destroySharedMuPDFEpubContentProvider,
} from './mupdf-epub-content-provider';

// Search (Stage 3)
export {
  MuPDFEpubSearch,
  getMuPDFEpubSearch,
  clearMuPDFEpubSearch,
  createHybridSearchProvider,
  type MuPDFSearchResult,
  type MuPDFSearchOptions,
  type SearchProvider,
} from './mupdf-epub-search';

// Format Detection (Stage 4)
export {
  EpubFormatDetector,
  getEpubFormatDetector,
  isFixedLayoutEpub,
  getEpubFormatInfo,
  type EpubLayoutType,
  type EpubFormatInfo,
  type DetectionOptions,
} from './epub-format-detector';

// Fixed-Layout Renderer (Stage 4)
export {
  FixedLayoutEpubRenderer,
  type FixedLayoutRendererConfig,
  type PageRenderOptions,
  type RenderedPage,
  type FixedLayoutRendererEvents,
} from './fixed-layout-epub-renderer';

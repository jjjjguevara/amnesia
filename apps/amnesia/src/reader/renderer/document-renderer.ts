/**
 * DocumentRenderer Interface
 *
 * Unified abstraction for rendering EPUB and PDF documents.
 * Both EpubRenderer and PdfRenderer implement this interface,
 * enabling format-agnostic UI code.
 */

import type { TocEntry, HighlightColor, RendererEvents } from './types';

// ============================================================================
// Document Types
// ============================================================================

/**
 * Supported document formats
 */
export type DocumentFormat = 'epub' | 'pdf';

/**
 * Unified document metadata
 */
export interface DocumentMetadata {
  id: string;
  title: string;
  author?: string;
  creators?: Array<{ name: string; role?: string }>;
  publisher?: string;
  language: string;
  description?: string;
  /** For EPUB: cover image href; For PDF: first page thumbnail */
  coverHref?: string;
  /** For PDF: page count; For EPUB: undefined */
  pageCount?: number;
}

/**
 * Parsed document structure
 */
export interface ParsedDocument {
  format: DocumentFormat;
  id: string;
  metadata: DocumentMetadata;
  toc: TocEntry[];
  /** For EPUB: spine item count; For PDF: page count */
  itemCount: number;
  /** For PDF: whether text layer is available */
  hasTextLayer?: boolean;
}

// ============================================================================
// Location & Navigation Types
// ============================================================================

/**
 * Unified document location
 * Works for both EPUB and PDF documents
 */
export interface DocumentLocation {
  /**
   * Format-specific locator string
   * - For EPUB: CFI string (e.g., "epubcfi(/6/4!/4/2/1:42)")
   * - For PDF: page reference (e.g., "page:5")
   */
  locator: string;

  /** Progress percentage through document (0-100) */
  percentage: number;

  /**
   * Position index
   * - For EPUB: spine index (0-based)
   * - For PDF: page number (1-indexed)
   */
  position: number;

  /** Total positions (spine length or page count) */
  totalPositions: number;

  /** Human-readable label (chapter name or page label) */
  displayLabel?: string;

  /** For paginated display: current page within section/spread */
  pageInSection?: number;

  /** For paginated display: total pages in section/spread */
  totalPagesInSection?: number;
}

/**
 * Navigation target - where to navigate
 */
export type DocumentNavigationTarget =
  | { type: 'locator'; locator: string }
  | { type: 'percentage'; percentage: number }
  | { type: 'position'; position: number }
  | { type: 'href'; href: string; hash?: string };

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Display mode
 */
export type DocumentDisplayMode = 'paginated' | 'scrolled';

/**
 * Page layout for paginated mode
 */
export type DocumentPageLayout = 'single' | 'dual' | 'auto';

/**
 * Unified renderer configuration
 */
export interface DocumentRendererConfig {
  /** Display mode: paginated or scrolled */
  mode: DocumentDisplayMode;
  /** Page layout for paginated mode */
  pageLayout: DocumentPageLayout;
  /** Theme preset */
  theme: string;
  /** Font size in pixels (EPUB only) */
  fontSize?: number;
  /** Font family (EPUB only) */
  fontFamily?: string;
  /** Line height multiplier (EPUB only) */
  lineHeight?: number;
  /** Text alignment (EPUB only) */
  textAlign?: 'left' | 'justify' | 'right';
  /** Margin around content */
  margin?: number;
  /** Scale factor for PDF (1.0 = 100%) */
  scale?: number;
  /** Rotation for PDF (0, 90, 180, 270) */
  rotation?: number;
}

// ============================================================================
// Selection & Annotation Types
// ============================================================================

/**
 * Unified selector for document annotations
 */
export type DocumentSelector = EpubSelector | PdfSelector;

/**
 * EPUB-specific selector
 */
export interface EpubSelector {
  format: 'epub';
  cfi: string;
  textQuote?: {
    exact: string;
    prefix?: string;
    suffix?: string;
  };
  position?: {
    start: number;
    end: number;
  };
}

/**
 * PDF-specific selector
 */
export interface PdfSelector {
  format: 'pdf';
  /** Page number (1-indexed) */
  page: number;
  /** For text selections */
  textQuote?: {
    exact: string;
    prefix?: string;
    suffix?: string;
  };
  /** For region selections (scanned PDFs) */
  rect?: PdfRect;
  /** Text position (character offsets in page text) */
  position?: {
    start: number;
    end: number;
  };
}

/**
 * Normalized rectangle on PDF page (0-1 coordinates)
 */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Selection event data
 */
export interface DocumentSelectionEvent {
  /** Selected text */
  text: string;
  /** Document selector for creating annotations */
  selector: DocumentSelector;
  /** Position for showing popup */
  position: { x: number; y: number };
  /** DOM range (if available, for EPUB) */
  range?: Range;
  /** Pre-computed selection rects (for PDF where Range isn't available) */
  rects?: Array<{ x: number; y: number; width: number; height: number }>;
}

/**
 * Region selection event (for scanned PDFs)
 */
export interface RegionSelectionEvent {
  /** Page number (1-indexed) */
  page: number;
  /** Selected region */
  rect: PdfRect;
  /** Position for showing popup */
  position: { x: number; y: number };
}

// ============================================================================
// Search Types
// ============================================================================

/**
 * Search options
 */
export interface DocumentSearchOptions {
  /** Maximum results to return */
  limit?: number;
  /** Case-sensitive search */
  caseSensitive?: boolean;
  /** Whole word matching */
  wholeWord?: boolean;
}

/**
 * Search result
 */
export interface DocumentSearchResult {
  /** Text that matched */
  text: string;
  /** Context before match */
  prefix?: string;
  /** Context after match */
  suffix?: string;
  /** Location for navigation */
  location: DocumentLocation;
  /** Selector for highlighting */
  selector: DocumentSelector;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Events emitted by DocumentRenderer
 */
export interface DocumentRendererEvents {
  /** Location changed (navigation, scroll, page turn) */
  relocated: DocumentLocation;
  /** Content rendered/loaded */
  rendered: { position: number };
  /** User selected text */
  selected: DocumentSelectionEvent;
  /** User selected a region (PDF only, for scanned documents) */
  regionSelected: RegionSelectionEvent;
  /** Highlight clicked */
  highlightClicked: { annotationId: string; position: { x: number; y: number } };
  /** Link clicked */
  linkClicked: { href: string; external: boolean };
  /** Loading state changed */
  loading: boolean;
  /** Error occurred */
  error: Error;
  /** Zoom level changed (PDF only) */
  zoomed: number;
}

/**
 * Event listener type
 */
export type DocumentRendererEventListener<K extends keyof DocumentRendererEvents> = (
  data: DocumentRendererEvents[K]
) => void;

// ============================================================================
// Rendered Highlight Types
// ============================================================================

/**
 * Highlight to render
 */
export interface RenderedDocumentHighlight {
  id: string;
  annotationId: string;
  color: HighlightColor;
  selector: DocumentSelector;
}

// ============================================================================
// DocumentRenderer Interface
// ============================================================================

/**
 * Unified interface for rendering EPUB and PDF documents
 *
 * Both EpubRenderer and PdfRenderer implement this interface,
 * enabling format-agnostic UI code.
 */
export interface DocumentRenderer {
  // --------------------------------
  // Properties
  // --------------------------------

  /** Renderer type identifier */
  readonly type: DocumentFormat;

  // --------------------------------
  // Lifecycle Methods
  // --------------------------------

  /**
   * Load document by ID from server
   * @param documentId - Document ID
   */
  load(documentId: string): Promise<void>;

  /**
   * Load document from raw bytes
   * @param data - Document bytes
   * @param filename - Optional filename
   */
  loadFromBytes(data: ArrayBuffer, filename?: string): Promise<void>;

  /**
   * Clean up renderer resources
   */
  destroy(): void;

  // --------------------------------
  // Navigation Methods
  // --------------------------------

  /**
   * Display content at a specific location
   * @param target - Navigation target
   */
  display(target: DocumentNavigationTarget): Promise<void>;

  /**
   * Navigate forward (next page/chapter)
   */
  next(): Promise<void>;

  /**
   * Navigate backward (previous page/chapter)
   */
  prev(): Promise<void>;

  /**
   * Get current reading location
   */
  getLocation(): DocumentLocation | null;

  // --------------------------------
  // Document Info Methods
  // --------------------------------

  /**
   * Get document metadata
   */
  getMetadata(): DocumentMetadata | null;

  /**
   * Get table of contents
   */
  getToc(): TocEntry[];

  // --------------------------------
  // Configuration Methods
  // --------------------------------

  /**
   * Update renderer configuration
   * @param config - Partial configuration to update
   */
  updateConfig(config: Partial<DocumentRendererConfig>): void;

  /**
   * Get current configuration
   */
  getConfig(): DocumentRendererConfig;

  // --------------------------------
  // Highlight Methods
  // --------------------------------

  /**
   * Add a highlight to the document
   * @param selector - Document selector
   * @param color - Highlight color
   * @returns Highlight ID
   */
  addHighlight(selector: DocumentSelector, color: HighlightColor): string;

  /**
   * Remove a highlight
   * @param highlightId - Highlight ID to remove
   */
  removeHighlight(highlightId: string): void;

  /**
   * Update highlight color
   * @param highlightId - Highlight ID
   * @param color - New color
   */
  updateHighlightColor(highlightId: string, color: HighlightColor): void;

  /**
   * Get all currently rendered highlights
   */
  getHighlights(): RenderedDocumentHighlight[];

  /**
   * Re-render highlights (after content change)
   */
  refreshHighlights(): void;

  // --------------------------------
  // Search Methods
  // --------------------------------

  /**
   * Search document content
   * @param query - Search query
   * @param options - Search options
   */
  search(query: string, options?: DocumentSearchOptions): Promise<DocumentSearchResult[]>;

  // --------------------------------
  // Event Methods
  // --------------------------------

  /**
   * Subscribe to renderer events
   * @param event - Event name
   * @param callback - Event handler
   * @returns Unsubscribe function
   */
  on<K extends keyof DocumentRendererEvents>(
    event: K,
    callback: DocumentRendererEventListener<K>
  ): () => void;

  /**
   * Unsubscribe from renderer events
   * @param event - Event name
   * @param callback - Event handler
   */
  off<K extends keyof DocumentRendererEvents>(
    event: K,
    callback: DocumentRendererEventListener<K>
  ): void;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Detect document format from filename
 */
export function detectDocumentFormat(filename: string): DocumentFormat {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  return 'epub'; // Default to EPUB for .epub and other formats
}

/**
 * Check if a location is for PDF
 */
export function isPdfLocation(location: DocumentLocation): boolean {
  return location.locator.startsWith('page:');
}

/**
 * Check if a selector is for PDF
 */
export function isPdfSelector(selector: DocumentSelector): selector is PdfSelector {
  return selector.format === 'pdf';
}

/**
 * Create a PDF page locator string
 */
export function createPdfLocator(page: number): string {
  return `page:${page}`;
}

/**
 * Parse a PDF page locator string
 */
export function parsePdfLocator(locator: string): number | null {
  if (locator.startsWith('page:')) {
    const page = parseInt(locator.slice(5), 10);
    return isNaN(page) ? null : page;
  }
  return null;
}

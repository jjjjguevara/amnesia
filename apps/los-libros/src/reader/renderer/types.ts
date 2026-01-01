/**
 * Renderer Types
 *
 * Core type definitions for the custom EPUB renderer that replaces epub.js.
 */

// ============================================================================
// Book and Content Types
// ============================================================================

/**
 * Parsed book metadata from the server
 */
export interface BookMetadata {
  id: string;
  title: string;
  creators: Creator[];
  publisher?: string;
  language: string;
  identifier?: string;
  description?: string;
  coverHref?: string;
}

export interface Creator {
  name: string;
  role?: string;
  sortAs?: string;
}

/**
 * Table of contents entry
 */
export interface TocEntry {
  id: string;
  label: string;
  href: string;
  children: TocEntry[];
}

/**
 * Spine item (reading order)
 */
export interface SpineItem {
  id: string;
  href: string;
  linear: boolean;
  mediaType: string;
}

/**
 * Full book structure returned by server
 */
export interface ParsedBook {
  id: string;
  metadata: BookMetadata;
  toc: TocEntry[];
  spine: SpineItem[];
}

/**
 * Chapter content returned by server
 */
export interface ChapterContent {
  html: string;
  href: string;
  spineIndex: number;
  highlights?: RenderedHighlight[];
}

// ============================================================================
// Renderer Configuration
// ============================================================================

/**
 * Display mode for the renderer
 */
export type DisplayMode = 'paginated' | 'scrolled';

/**
 * Column layout
 */
export type ColumnLayout = 'single' | 'dual' | 'auto';

/**
 * Theme preset names
 */
export type ThemePreset = 'system' | 'light' | 'dark' | 'sepia' | 'night' | 'paper' | 'forest' | 'custom';

/**
 * Renderer configuration options
 */
export interface RendererConfig {
  /** Display mode: paginated or scrolled */
  mode: DisplayMode;
  /** Column layout for paginated mode */
  columns: ColumnLayout;
  /** Font size in pixels */
  fontSize: number;
  /** Font family */
  fontFamily: string;
  /** Line height multiplier */
  lineHeight: number;
  /** Text alignment */
  textAlign: 'left' | 'justify' | 'right';
  /** Theme preset or custom colors */
  theme: ThemePreset;
  /** Custom theme colors (used when theme is 'custom') */
  customColors?: ThemeColors;
  /** Margin/padding around content */
  margin: number;
  /** Gap between columns in dual mode */
  columnGap: number;
}

/**
 * Theme color values
 */
export interface ThemeColors {
  background: string;
  foreground: string;
  linkColor: string;
  highlightColor: string;
}

/**
 * Default renderer configuration
 */
export const DEFAULT_RENDERER_CONFIG: RendererConfig = {
  mode: 'paginated',
  columns: 'auto',
  fontSize: 16,
  fontFamily: 'Georgia, serif',
  lineHeight: 1.6,
  textAlign: 'justify',
  theme: 'system',
  margin: 40,
  columnGap: 60,
};

// ============================================================================
// Location and Navigation
// ============================================================================

/**
 * Reading location with multiple selectors for robust positioning
 * Follows the Readium Locator model for reliable position restoration
 */
export interface ReadingLocation {
  /** EPUB CFI (canonical fragment identifier) */
  cfi?: string;
  /** Spine index (0-based) */
  spineIndex: number;
  /** Href of the current chapter */
  href: string;
  /** Reading progress as percentage (0-100) - book-wide */
  percentage: number;
  /** Page number within chapter (for paginated mode) */
  pageInChapter?: number;
  /** Total pages in chapter (for paginated mode) */
  totalPagesInChapter?: number;
  /** Estimated page number in entire book */
  pageInBook?: number;
  /** Estimated total pages in entire book */
  totalPagesInBook?: number;
  /** Total number of chapters (spine items) */
  totalChapters?: number;
  /** Scroll position (for scrolled mode) */
  scrollY?: number;

  /**
   * Text context for fuzzy position matching (Readium Locator model)
   * Used as fallback when CFI fails (e.g., after content edits or reflow)
   */
  text?: {
    /** First ~100 chars of visible text at this position */
    highlight: string;
    /** ~32 chars before the visible text for disambiguation */
    before?: string;
    /** ~32 chars after the visible text for disambiguation */
    after?: string;
  };

  /**
   * Progression within the current chapter (0-1)
   * More stable than book-wide percentage for mode switching
   */
  progressionInChapter?: number;
}

/**
 * Navigation target - where to go
 */
export type NavigationTarget =
  | { type: 'cfi'; cfi: string }
  | { type: 'href'; href: string; hash?: string }
  | { type: 'percentage'; percentage: number }
  | { type: 'spine'; spineIndex: number; offset?: number }
  | { type: 'page'; pageNumber: number };

// ============================================================================
// Annotations and Highlights
// ============================================================================

/**
 * Highlight colors available
 */
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple' | 'orange';

/**
 * Annotation type
 */
export type AnnotationType = 'highlight' | 'underline' | 'note' | 'bookmark';

/**
 * Multi-selector for robust text anchoring
 */
export interface TextSelector {
  /** EPUB CFI fragment selector */
  cfi?: string;
  /** Text quote with context */
  textQuote?: {
    exact: string;
    prefix?: string;
    suffix?: string;
  };
  /** Character position in chapter */
  textPosition?: {
    start: number;
    end: number;
  };
  /** Reading progress percentage */
  progression?: number;
}

/**
 * Annotation stored and synced
 */
export interface Annotation {
  id: string;
  bookId: string;
  type: AnnotationType;
  color?: HighlightColor;
  selector: TextSelector;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
  deviceId: string;
}

/**
 * Highlight rendered in the chapter (from server)
 */
export interface RenderedHighlight {
  id: string;
  annotationId: string;
  color: HighlightColor;
  rects: DOMRect[];
}

/**
 * W3C-aligned selector for robust highlight anchoring
 * Used for storage and re-anchoring highlights across sessions
 */
export interface HighlightSelector {
  /** Primary selector using EPUB CFI */
  primary: {
    type: 'CfiSelector';
    cfi: string;
  };
  /** Fallback using text quote with context */
  fallback: {
    type: 'TextQuoteSelector';
    exact: string;
    prefix?: string;  // ~32 chars before for disambiguation
    suffix?: string;  // ~32 chars after for disambiguation
  };
  /** Position fallback (character offsets in chapter) */
  position?: {
    type: 'TextPositionSelector';
    start: number;
    end: number;
  };
}

/**
 * Anchor result from re-anchoring a selector to DOM
 */
export interface AnchorResult {
  range: Range | null;
  status: 'exact' | 'fuzzy' | 'orphaned';
  confidence: number;  // 0-1 confidence in the match
}

/**
 * Runtime-computed highlight for rendering
 * Created by re-anchoring stored selectors to current DOM state
 */
export interface AnchoredHighlight {
  id: string;
  annotationId: string;
  color: HighlightColor;
  range: Range;
  rects: DOMRect[];
  status: 'anchored' | 'fuzzy' | 'orphaned';
}

// ============================================================================
// Sync Types
// ============================================================================

/**
 * Sync status
 */
export interface SyncStatus {
  lastSync?: Date;
  version: number;
  pendingChanges: number;
  inProgress: boolean;
  error?: string;
}

/**
 * Sync operation for offline queue
 */
export interface SyncOperation {
  id: string;
  operationType: 'create' | 'update' | 'delete';
  entityType: 'annotation' | 'progress' | 'bookmark';
  entityId: string;
  payload?: unknown;
  baseVersion: number;
  deviceId: string;
  timestamp: Date;
}

/**
 * Conflict from server
 */
export interface SyncConflict {
  entityType: string;
  entityId: string;
  localData: unknown;
  serverData: unknown;
  resolution: 'local_wins' | 'server_wins' | 'merge' | 'manual';
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Events emitted by the renderer
 */
export interface RendererEvents {
  /** Location changed (navigation, scroll, page turn) */
  relocated: ReadingLocation;
  /** Chapter loaded and rendered */
  rendered: { spineIndex: number; href: string };
  /** User selected text */
  selected: {
    text: string;
    cfi: string;
    range: Range;
    position: { x: number; y: number };
    /** Spine index of the selection */
    spineIndex?: number;
    /** Text quote with context for robust anchoring */
    selector?: TextSelector;
  };
  /** Highlight clicked */
  highlightClicked: {
    annotationId: string;
    position: { x: number; y: number };
  };
  /** Link clicked */
  linkClicked: { href: string; external: boolean };
  /** Loading state changed */
  loading: boolean;
  /** Error occurred */
  error: Error;
}

/**
 * Event listener type
 */
export type RendererEventListener<K extends keyof RendererEvents> = (
  data: RendererEvents[K]
) => void;

// ============================================================================
// PDF Types
// ============================================================================

/**
 * Parsed PDF document from server
 */
export interface ParsedPdf {
  id: string;
  metadata: PdfMetadata;
  toc: TocEntry[];
  pageCount: number;
  pageLabels?: string[];
  hasTextLayer: boolean;
  orientation: 'portrait' | 'landscape' | 'mixed';
}

/**
 * PDF metadata
 */
export interface PdfMetadata {
  title: string;
  author?: string;
  subject?: string;
  keywords: string[];
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
}

/**
 * PDF text layer for a page
 */
export interface PdfTextLayer {
  page: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

/** Alias for PdfTextLayer to avoid conflicts with class exports */
export type PdfTextLayerData = PdfTextLayer;

/**
 * Text item on a PDF page
 */
export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  charPositions?: PdfCharPosition[];
}

/**
 * Character position for precise text selection
 */
export interface PdfCharPosition {
  char: string;
  x: number;
  width: number;
}

/**
 * PDF page dimensions
 */
export interface PdfPageDimensions {
  width: number;
  height: number;
}

/**
 * PDF search result
 */
export interface PdfSearchResult {
  page: number;
  text: string;
  prefix?: string;
  suffix?: string;
  position?: { x: number; y: number };
}

/**
 * PDF selector for annotations
 */
export interface PdfSelector {
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
 * Normalized position on PDF page (0-1 coordinates)
 */
export interface PdfPosition {
  x: number;
  y: number;
}

/**
 * PDF render request options
 */
export interface PdfRenderOptions {
  scale?: number;
  rotation?: number;
  format?: 'png' | 'jpeg' | 'webp';
}

/**
 * Region selection event (for scanned PDFs)
 */
export interface RegionSelectionEvent {
  page: number;
  rect: PdfRect;
  position: { x: number; y: number };
}

// ============================================================================
// Server API Types
// ============================================================================

/**
 * Server response wrapper
 */
export interface ApiResponse<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Reading progress on server
 */
export interface ReadingProgress {
  bookId: string;
  deviceId: string;
  cfi?: string;
  percentage: number;
  chapterIndex: number;
  updatedAt: Date;
}

/**
 * Push request for sync
 */
export interface PushRequest {
  deviceId: string;
  bookId: string;
  operations: SyncOperation[];
  lastKnownVersion: number;
}

/**
 * Push response from server
 */
export interface PushResponse {
  success: boolean;
  version: number;
  conflicts: SyncConflict[];
  acceptedCount: number;
}

/**
 * Pull request for sync
 */
export interface PullRequest {
  deviceId: string;
  bookId: string;
  sinceVersion: number;
}

/**
 * Pull response from server
 */
export interface PullResponse {
  operations: SyncOperation[];
  currentVersion: number;
  hasMore: boolean;
}

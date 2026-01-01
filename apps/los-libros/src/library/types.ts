/**
 * Book model for Los Libros
 */
export interface Book {
  id: string;
  title: string;
  author?: string;

  // File information
  localPath?: string;    // Path in vault
  serverId?: string;     // ID on server
  coverUrl?: string;

  // Reading state
  status: BookStatus;
  progress: number;      // 0-100
  currentCfi?: string;   // EPUB CFI position

  // Metadata
  isbn?: string;
  publisher?: string;
  publishedDate?: string;
  description?: string;
  language?: string;
  formats: BookFormat[];

  // Timestamps
  addedAt: Date;
  lastRead?: Date;
  completedAt?: Date;

  // Stats
  highlightCount: number;
  readingSessions: number;
}

export type BookStatus = 'to-read' | 'reading' | 'completed' | 'archived';

export type BookFormat = 'epub' | 'pdf' | 'mobi';

/**
 * W3C-aligned selector for robust highlight anchoring
 */
export interface HighlightSelector {
  primary: {
    type: 'CfiSelector';
    cfi: string;
  };
  fallback: {
    type: 'TextQuoteSelector';
    exact: string;
    prefix?: string;
    suffix?: string;
  };
  position?: {
    type: 'TextPositionSelector';
    start: number;
    end: number;
  };
}

/**
 * Highlight model
 */
export interface Highlight {
  id: string;
  bookId: string;

  // Content
  text: string;
  annotation?: string;
  color: HighlightColor;
  type?: 'highlight' | 'underline';
  tags?: string[];

  // Position (legacy - kept for backward compatibility)
  cfi: string;
  chapter?: string;
  pagePercent?: number;

  // NEW: Robust anchoring for re-anchoring across reflows
  spineIndex: number;           // Chapter index in spine
  selector: HighlightSelector;  // W3C multi-selector

  // State
  locked?: boolean;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Sync
  synced: boolean;
  atomicNotePath?: string;

  // Linked note
  noteId?: string;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple' | 'orange';

/**
 * Reading progress
 */
export interface ReadingProgress {
  bookId: string;
  percent: number;
  cfi: string;
  page?: number;
  totalPages?: number;
  lastRead: Date;
}

/**
 * Readium Locator - Industry standard for EPUB position persistence
 *
 * This model provides robust position restoration that survives:
 * - Reflow (font size, window size changes)
 * - Minor content edits
 * - Different reading systems
 *
 * @see https://github.com/readium/architecture/tree/master/models/locators
 */
export interface ReadiumLocator {
  /** Resource path within the EPUB (chapter file) */
  href: string;
  /** MIME type of the resource */
  type: string;
  /** Optional chapter title for display */
  title?: string;
  /** Position within the resource */
  locations: {
    /** Full EPUB CFI with element path and character offset */
    cfi: string;
    /** Progress within the chapter (0-1) */
    progression: number;
    /** Optional position in 1024-byte list (for sorting) */
    position?: number;
    /** Total positions in the book (for calculating overall progress) */
    totalPositions?: number;
  };
  /** Text context for fuzzy matching fallback */
  text: {
    /** First visible text (up to 100 chars) for fallback matching */
    highlight: string;
    /** Text before the position (up to 32 chars) */
    before?: string;
    /** Text after the position (up to 32 chars) */
    after?: string;
  };
}

/**
 * Library index (stored in data.json)
 */
export interface LibraryIndex {
  version: number;
  library: Record<string, BookIndexEntry>;
  syncQueue: SyncQueueItem[];
}

export interface BookIndexEntry {
  title: string;
  author?: string;
  localPath?: string;
  serverId?: string;
  lastRead?: string;
  progress: number;
  highlights: string[];
}

export interface SyncQueueItem {
  type: 'progress' | 'highlight';
  bookId: string;
  data: unknown;
  timestamp: Date;
}

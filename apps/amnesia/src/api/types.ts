/**
 * Amnesia Public API - Type Definitions
 * @module api/types
 */

import type { Readable } from 'svelte/store';

// ============================================================================
// Core Types
// ============================================================================

/**
 * Disposable resource that can be cleaned up
 */
export interface Disposable {
  dispose(): void;
}

/**
 * Security capabilities for API access
 */
export type Capability =
  | 'read-state'
  | 'write-annotations'
  | 'write-bookmarks'
  | 'write-library'
  | 'admin';

// ============================================================================
// Book & Library Types
// ============================================================================

/**
 * Reading status of a book
 */
export type ReadingStatus = 'to-read' | 'reading' | 'completed' | 'archived' | 'unread';

/**
 * Book metadata
 */
export interface Book {
  id: string;
  title: string;
  author: string;
  localPath: string;
  coverPath?: string;
  progress: number;
  status: ReadingStatus;
  lastRead?: string;
  dateAdded: string;
  metadata?: BookMetadata;
}

/**
 * Extended book metadata
 */
export interface BookMetadata {
  isbn?: string;
  publisher?: string;
  publishDate?: string;
  language?: string;
  description?: string;
  subjects?: string[];
  series?: string;
  seriesIndex?: number;
  tags?: string[];
}

/**
 * Query options for filtering books
 */
export interface BookQueryOptions {
  /** Filter by author (partial match, case-insensitive) */
  author?: string;
  /** Filter by tag (exact match) */
  tag?: string;
  /** Filter by multiple tags (all must match) */
  tags?: string[];
  /** Filter by series name */
  series?: string;
  /** Filter by reading status */
  status?: ReadingStatus | ReadingStatus[];
  /** Filter by language */
  language?: string;
  /** Filter by publisher */
  publisher?: string;
  /** Filter by date added range */
  addedAfter?: Date | string;
  addedBefore?: Date | string;
  /** Filter by last read range */
  readAfter?: Date | string;
  readBefore?: Date | string;
  /** Filter by progress range */
  minProgress?: number;
  maxProgress?: number;
  /** Text search in title/author/description */
  textSearch?: string;
  /** Sort field */
  sortBy?: 'title' | 'author' | 'dateAdded' | 'lastRead' | 'progress' | 'series';
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
  /** Pagination offset */
  offset?: number;
  /** Pagination limit */
  limit?: number;
}

/**
 * Library statistics
 */
export interface LibraryStats {
  totalBooks: number;
  byStatus: Record<ReadingStatus, number>;
  byLanguage: Record<string, number>;
  bySeries: Record<string, number>;
  averageProgress: number;
  recentlyAdded: number; // Last 7 days
  recentlyRead: number; // Last 7 days
  completedThisMonth: number;
  uniqueAuthors: number;
  uniqueTags: number;
}

/**
 * Library state
 */
export interface LibraryState {
  books: Book[];
  loading: boolean;
  error: string | null;
  selectedBookId: string | null;
}

// ============================================================================
// Reader Types
// ============================================================================

/**
 * Display mode for the reader
 */
export type DisplayMode = 'paginated' | 'scrolled';

/**
 * Text direction
 */
export type TextDirection = 'ltr' | 'rtl' | 'auto';

/**
 * Reader configuration
 */
export interface NavigatorConfig {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  textAlign: 'left' | 'justify' | 'right';
  theme: 'light' | 'dark' | 'sepia';
  displayMode: DisplayMode;
  columnCount: 1 | 2 | 'auto';
  margins: number;
  textDirection: TextDirection;
}

/**
 * Spine item from EPUB
 */
export interface SpineItem {
  href: string;
  id: string;
  index: number;
  title?: string;
}

/**
 * EPUB CFI location
 */
export interface Locator {
  href: string;
  type: string;
  title?: string;
  locations: {
    cfi: string;
    progression?: number;
    totalProgression?: number;
    position?: number;
  };
  text?: {
    before?: string;
    highlight?: string;
    after?: string;
  };
}

/**
 * Reader state
 */
export interface ReaderState {
  location: Locator | null;
  config: NavigatorConfig;
  bookId: string | null;
  spine: SpineItem[];
  currentSpineIndex: number;
  totalPages: number;
  currentPage: number;
  loading: boolean;
}

/**
 * Navigation target
 */
export type NavigationTarget =
  | { type: 'cfi'; cfi: string }
  | { type: 'href'; href: string }
  | { type: 'spine'; index: number }
  | { type: 'progression'; value: number }
  | { type: 'page'; page: number };

/**
 * Pending text selection
 */
export interface PendingSelection {
  text: string;
  cfi: string;
  range: Range;
  spineIndex: number;
}

// ============================================================================
// Highlight Types
// ============================================================================

/**
 * Available highlight colors
 */
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple' | 'orange';

/**
 * Highlight data
 */
export interface Highlight {
  id: string;
  bookId: string;
  text: string;
  cfi: string;
  color: HighlightColor;
  annotation?: string;
  chapter?: string;
  pagePercent?: number;
  spineIndex?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Highlight state
 */
export interface HighlightState {
  highlights: Record<string, Highlight[]>;
  loading: boolean;
  error: string | null;
}

// ============================================================================
// Bookmark Types
// ============================================================================

/**
 * Bookmark data
 */
export interface Bookmark {
  id: string;
  bookId: string;
  cfi: string;
  title?: string;
  note?: string;
  chapter?: string;
  createdAt: string;
}

/**
 * Bookmark state
 */
export interface BookmarkState {
  bookmarks: Record<string, Bookmark[]>;
  loading: boolean;
  error: string | null;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Text selector for selections
 */
export interface TextSelector {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Library scan result
 */
export interface ScanResult {
  added: number;
  updated: number;
  removed: number;
  errors: string[];
}

/**
 * Complete event map for typed events
 */
export interface ReaderEventMap {
  // Navigation events
  'relocated': { location: Locator; direction?: 'forward' | 'backward' };
  'page-turn': { from: number; to: number; spineIndex: number };
  'chapter-visible': { spineIndex: number; visible: boolean };

  // Content events
  'rendered': { spineIndex: number; href: string };
  'text-selected': {
    text: string;
    cfi: string;
    range: Range;
    selector: TextSelector;
    spineIndex: number;
  };
  'link-clicked': { href: string; external: boolean };

  // Highlight events
  'highlight-created': { highlight: Highlight };
  'highlight-updated': { highlight: Highlight };
  'highlight-deleted': { bookId: string; highlightId: string };
  'highlight-clicked': { highlight: Highlight; position: { x: number; y: number } };

  // State events
  'loading': { loading: boolean };
  'error': { error: Error };
  'config-changed': { config: NavigatorConfig };
  'resize': { width: number; height: number };

  // Library events
  'book-added': { book: Book };
  'book-updated': { book: Book };
  'book-deleted': { bookId: string };
  'library-scanned': { result: ScanResult };
  'progress-updated': { bookId: string; progress: number; cfi?: string };

  // Lifecycle events
  'book-opened': { bookId: string; book: Book };
  'book-closed': { bookId: string };
}

/**
 * Hook context types
 */
export interface HookContexts {
  onBeforePageTurn: {
    currentPage: number;
    nextPage: number;
    direction: 'forward' | 'backward';
  };
  onBeforeHighlightCreate: {
    text: string;
    color: HighlightColor;
    cfi: string;
  };
  onBeforeBookClose: {
    bookId: string;
    hasUnsavedChanges: boolean;
  };
  onBeforeNavigate: {
    target: NavigationTarget;
    currentLocation: Locator | null;
  };
}

/**
 * Hook map for typed hooks
 */
export type HookMap = {
  [K in keyof HookContexts]: (context: HookContexts[K]) => Promise<boolean>;
};

// ============================================================================
// UI Extension Types
// ============================================================================

/**
 * Reader context passed to UI callbacks
 */
export interface ReaderContext {
  bookId: string;
  currentLocation: Locator | null;
  selection: PendingSelection | null;
}

/**
 * Toolbar item registration
 */
export interface ToolbarItem {
  id: string;
  icon: string;
  label: string;
  onClick: (context: ReaderContext) => void;
  position?: 'left' | 'right';
  priority?: number;
}

/**
 * Sidebar view registration
 */
export interface SidebarView {
  id: string;
  title: string;
  icon?: string;
  mount: (container: HTMLElement) => () => void;
}

/**
 * Selection context for context menu
 */
export interface SelectionContext {
  text: string;
  cfi: string;
  range: Range;
  hasSelection: boolean;
}

/**
 * Context menu item registration
 */
export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  condition?: (ctx: SelectionContext) => boolean;
  action: (ctx: SelectionContext) => void;
}

// ============================================================================
// API Interface Types
// ============================================================================

/**
 * Events API
 */
export interface EventsAPI {
  on<K extends keyof ReaderEventMap>(
    event: K,
    handler: (data: ReaderEventMap[K]) => void
  ): Disposable;

  off<K extends keyof ReaderEventMap>(
    event: K,
    handler: (data: ReaderEventMap[K]) => void
  ): void;

  once<K extends keyof ReaderEventMap>(
    event: K,
    handler: (data: ReaderEventMap[K]) => void
  ): Disposable;
}

/**
 * Hooks API
 */
export interface HooksAPI {
  register<K extends keyof HookMap>(
    hook: K,
    handler: HookMap[K]
  ): Disposable;
}

/**
 * Reader commands
 */
export interface ReaderCommands {
  goTo(target: NavigationTarget): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  updateConfig(config: Partial<NavigatorConfig>): void;
  getVisibleText(): string | null;
  getCfiForRange(range: Range): string | null;
}

/**
 * Library commands
 */
export interface LibraryCommands {
  getBook(bookId: string): Book | null;
  search(query: string): Book[];
  filterByStatus(status: ReadingStatus): Book[];
  updateProgress(bookId: string, progress: number, cfi?: string): Promise<void>;
  scan(folder?: string): Promise<ScanResult>;

  // Advanced Query Methods
  /** Query books with flexible filtering, sorting, and pagination */
  queryBooks(options: BookQueryOptions): Book[];
  /** Get books by a specific author (partial match) */
  getBooksByAuthor(author: string): Book[];
  /** Get books with a specific tag */
  getBooksWithTag(tag: string): Book[];
  /** Get books in a series */
  getBooksInSeries(series: string): Book[];
  /** Get books by language */
  getBooksByLanguage(language: string): Book[];
  /** Get books modified since a date */
  getBooksModifiedSince(since: Date | string): Book[];

  // Aggregation Methods
  /** Get all unique authors in the library */
  getAuthors(): string[];
  /** Get all unique tags in the library */
  getTags(): string[];
  /** Get all unique series in the library */
  getSeries(): Array<{ name: string; bookCount: number }>;
  /** Get all unique languages in the library */
  getLanguages(): string[];
  /** Get library statistics */
  getLibraryStats(): LibraryStats;
}

/**
 * Highlight commands
 */
export interface HighlightCommands {
  create(
    bookId: string,
    text: string,
    cfi: string,
    color: HighlightColor,
    annotation?: string
  ): Promise<Highlight>;
  update(highlightId: string, updates: Partial<Highlight>): Promise<Highlight>;
  delete(bookId: string, highlightId: string): Promise<void>;
  getHighlights(bookId: string): Highlight[];
  searchHighlights(query: string, bookId?: string): Highlight[];
}

/**
 * Bookmark commands
 */
export interface BookmarkCommands {
  create(bookId: string, cfi: string, title?: string, note?: string): Promise<Bookmark>;
  update(bookmarkId: string, updates: Partial<Bookmark>): Promise<Bookmark>;
  delete(bookId: string, bookmarkId: string): Promise<void>;
  getBookmarks(bookId: string): Bookmark[];
}

/**
 * Toolbar registration API
 */
export interface ToolbarAPI {
  register(item: ToolbarItem): Disposable;
  unregister(id: string): void;
  getItems(): ToolbarItem[];
}

/**
 * Sidebar registration API
 */
export interface SidebarAPI {
  register(view: SidebarView): Disposable;
  unregister(id: string): void;
  getViews(): SidebarView[];
}

/**
 * Context menu registration API
 */
export interface ContextMenuAPI {
  register(item: ContextMenuItem): Disposable;
  unregister(id: string): void;
  getItems(): ContextMenuItem[];
}

/**
 * UI extension APIs
 */
export interface UIAPI {
  toolbar: ToolbarAPI;
  sidebar: SidebarAPI;
  contextMenu: ContextMenuAPI;
}

/**
 * State stores (read-only Svelte stores)
 */
export interface StateAPI {
  reader: Readable<ReaderState>;
  library: Readable<LibraryState>;
  highlights: Readable<HighlightState>;
  bookmarks: Readable<BookmarkState>;
}

/**
 * Command APIs
 */
export interface CommandsAPI {
  reader: ReaderCommands;
  library: LibraryCommands;
  highlights: HighlightCommands;
  bookmarks: BookmarkCommands;
}

/**
 * Main Amnesia API interface
 */
export interface AmnesiaAPI {
  /** API version */
  readonly version: string;

  /** Reactive state stores */
  state: StateAPI;

  /** Command methods */
  commands: CommandsAPI;

  /** Event system */
  events: EventsAPI;

  /** Hook system */
  hooks: HooksAPI;

  /** UI extension points */
  ui: UIAPI;

  /**
   * Connect with specific capabilities
   * @param pluginId - Unique plugin identifier
   * @param capabilities - Required capabilities
   * @returns Scoped API with permission checks
   */
  connect(pluginId: string, capabilities: Capability[]): Promise<AmnesiaAPI>;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Permission denied error
 */
export class PermissionError extends Error {
  constructor(
    public readonly required: Capability,
    public readonly operation: string
  ) {
    super(`Permission denied: '${required}' required for '${operation}'`);
    this.name = 'PermissionError';
  }
}

/**
 * Validation error
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: Array<{
      path: (string | number)[];
      message: string;
      code: string;
    }>
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ============================================================================
// Global Declaration
// ============================================================================

declare global {
  interface Window {
    Amnesia: AmnesiaAPI;
  }
}

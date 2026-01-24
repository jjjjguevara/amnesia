/**
 * HUD Context Detector
 *
 * Detects contextual information from the current view to provide
 * relevant information in the HUD. Watches for:
 * - Active leaf changes
 * - Book note views (frontmatter with type: 'book')
 * - Reader views (EPUB/PDF open)
 * - Configured folders
 */

import type { App, TFile, WorkspaceLeaf, EventRef } from 'obsidian';
import type { LibrosSettings } from '../../settings/settings';
import { READER_VIEW_TYPE } from '../../reader/reader-view';

/**
 * Detected context types
 */
export type ContextType =
  | 'book-note'      // Viewing a book note in markdown
  | 'reader'         // Viewing a book in the reader
  | 'highlight-note' // Viewing a highlight note
  | 'author-index'   // Viewing an author index
  | 'series-index'   // Viewing a series index
  | 'library-folder' // In a library-related folder
  | 'none';          // No relevant context

/**
 * Book context information
 */
export interface BookContext {
  type: 'book';
  bookId?: string;
  calibreId?: number;
  title?: string;
  author?: string;
  series?: string;
  bookPath?: string;
  notePath?: string;
  /** File format detected from the reader (pdf or epub) */
  fileFormat?: 'pdf' | 'epub';
}

/**
 * Highlight context information
 */
export interface HighlightContext {
  type: 'highlight';
  highlightId?: string;
  bookId?: string;
  bookTitle?: string;
  color?: string;
}

/**
 * Author context information
 */
export interface AuthorContext {
  type: 'author';
  authorName: string;
}

/**
 * Series context information
 */
export interface SeriesContext {
  type: 'series';
  seriesName: string;
}

/**
 * No context detected
 */
export interface NoContext {
  type: 'none';
}

/**
 * Union of all context types
 */
export type HUDContext =
  | BookContext
  | HighlightContext
  | AuthorContext
  | SeriesContext
  | NoContext;

/**
 * Context change event
 */
export interface ContextChangeEvent {
  previous: HUDContext;
  current: HUDContext;
  source: 'leaf-change' | 'file-change' | 'reader-change';
}

/**
 * Context detection configuration
 */
export interface ContextDetectorConfig {
  /** Check book note folders */
  bookNoteFolders: string[];
  /** Check highlight folders */
  highlightFolders: string[];
  /** Check author index folders */
  authorFolders: string[];
  /** Check series index folders */
  seriesFolders: string[];
  /** Debounce delay for context changes (ms) */
  debounceDelay: number;
}

/**
 * Context Detector class
 */
export class ContextDetector {
  private app: App;
  private getSettings: () => LibrosSettings;
  private currentContext: HUDContext = { type: 'none' };
  private subscribers = new Set<(event: ContextChangeEvent) => void>();
  private eventRefs: EventRef[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceDelay = 100; // ms

  constructor(app: App, getSettings: () => LibrosSettings) {
    this.app = app;
    this.getSettings = getSettings;
  }

  /**
   * Start watching for context changes
   */
  start(): void {
    // Watch for active leaf changes
    const leafRef = this.app.workspace.on('active-leaf-change', (leaf) => {
      this.handleLeafChange(leaf);
    });
    this.eventRefs.push(leafRef);

    // Watch for file open events
    const fileRef = this.app.workspace.on('file-open', (file) => {
      this.handleFileOpen(file);
    });
    this.eventRefs.push(fileRef);

    // Initial detection
    this.detectContext('leaf-change');
  }

  /**
   * Stop watching for context changes
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    for (const ref of this.eventRefs) {
      this.app.workspace.offref(ref);
    }
    this.eventRefs = [];
    this.subscribers.clear();
  }

  /**
   * Subscribe to context changes
   */
  subscribe(callback: (event: ContextChangeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /**
   * Get current context
   */
  getCurrentContext(): HUDContext {
    return this.currentContext;
  }

  /**
   * Force context re-detection
   */
  refresh(): void {
    this.detectContext('leaf-change');
  }

  /**
   * Handle active leaf change
   */
  private handleLeafChange(leaf: WorkspaceLeaf | null): void {
    this.debouncedDetect('leaf-change');
  }

  /**
   * Handle file open
   */
  private handleFileOpen(file: TFile | null): void {
    this.debouncedDetect('file-change');
  }

  /**
   * Debounced context detection
   */
  private debouncedDetect(source: 'leaf-change' | 'file-change' | 'reader-change'): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.detectContext(source);
    }, this.debounceDelay);
  }

  /**
   * Detect context from current state
   */
  private detectContext(source: 'leaf-change' | 'file-change' | 'reader-change'): void {
    const previous = this.currentContext;
    const current = this.detectCurrentContext();

    // Only notify if context changed
    if (!this.isContextEqual(previous, current)) {
      this.currentContext = current;
      this.notifySubscribers({ previous, current, source });
    }
  }

  /**
   * Detect context from current active view
   */
  private detectCurrentContext(): HUDContext {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (!activeLeaf) {
      return this.detectFromReaderLeaves();
    }

    const view = activeLeaf.view;
    const viewType = view.getViewType();

    // Check if it's our reader view
    if (viewType === READER_VIEW_TYPE) {
      return this.detectReaderContext(view);
    }

    // Check if it's the book sidebar (associated with a reader)
    if (viewType === 'amnesia-book-sidebar') {
      return this.detectSidebarContext(view);
    }

    // Check if it's a markdown view
    if (viewType === 'markdown') {
      return this.detectMarkdownContext(view);
    }

    // If active leaf is not reader or markdown (e.g., sidebar panel),
    // check if there are any open reader leaves
    return this.detectFromReaderLeaves();
  }

  /**
   * Detect context from sidebar view
   * The sidebar is associated with a specific reader/book
   */
  private detectSidebarContext(view: any): HUDContext {
    // Try to get book path from sidebar's Svelte component context
    const component = view.component;
    if (component?.$$.ctx) {
      const ctx = component.$$.ctx;
      // Look for book path in context (typically at index 2 based on component structure)
      for (let i = 0; i < Math.min(ctx.length, 10); i++) {
        const val = ctx[i];
        if (typeof val === 'string' && (val.includes('.epub') || val.includes('.pdf'))) {
          const title = this.extractBookTitle(val);
          // Detect format from path
          const lowerPath = val.toLowerCase();
          const fileFormat: 'pdf' | 'epub' | undefined = lowerPath.endsWith('.pdf')
            ? 'pdf'
            : lowerPath.endsWith('.epub')
              ? 'epub'
              : undefined;
          return {
            type: 'book',
            bookPath: val,
            title,
            fileFormat,
          };
        }
      }
    }

    // Fallback to checking reader leaves
    return this.detectFromReaderLeaves();
  }

  /**
   * Check if there are any open reader leaves and extract context from them
   */
  private detectFromReaderLeaves(): HUDContext {
    const readerLeaves = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE);
    if (readerLeaves.length === 0) {
      return { type: 'none' };
    }

    // Get context from the most recently accessed reader leaf
    // (usually the first one in the list is the most recently focused)
    for (const leaf of readerLeaves) {
      const context = this.detectReaderContext(leaf.view);
      if (context.type === 'book') {
        return context;
      }
    }

    return { type: 'none' };
  }

  /**
   * Detect context from reader view
   */
  private detectReaderContext(view: any): HUDContext {
    // Access reader view properties
    const bookPath = view.bookPath || view.state?.bookPath;
    const stateTitle = view.bookTitle || view.state?.bookTitle;

    if (bookPath) {
      // Try to extract a better title from the path
      const title = this.extractBookTitle(bookPath, stateTitle);

      // Extract file format from component context or path
      const fileFormat = this.detectFileFormat(view, bookPath);

      return {
        type: 'book',
        bookPath,
        title,
        fileFormat,
      };
    }

    return { type: 'none' };
  }

  /**
   * Detect file format from reader view component or path
   */
  private detectFileFormat(view: any, bookPath: string): 'pdf' | 'epub' | undefined {
    // Try to get format from Svelte component context
    try {
      const component = view.component;
      if (component?.$$.ctx) {
        const ctx = component.$$.ctx;
        // Look for format type in context (typically at index 3)
        for (let i = 0; i < Math.min(ctx.length, 10); i++) {
          const val = ctx[i];
          if (val && typeof val === 'object' && 'type' in val) {
            const formatType = val.type;
            if (formatType === 'pdf' || formatType === 'epub') {
              return formatType;
            }
          }
        }
      }
    } catch {
      // Ignore errors accessing component context
    }

    // Fallback to path-based detection
    const lowerPath = bookPath.toLowerCase();
    if (lowerPath.endsWith('.pdf')) {
      return 'pdf';
    } else if (lowerPath.endsWith('.epub')) {
      return 'epub';
    }

    return undefined;
  }

  /**
   * Extract book title from path and state title
   * Calibre library structure: Library/Author/Title (ID)/filename
   */
  private extractBookTitle(bookPath: string, stateTitle?: string): string {
    const pathParts = bookPath.split('/');
    const fileName = pathParts[pathParts.length - 1] || '';

    // Remove Calibre ID suffix like "(207)" from filename
    const cleanFileName = fileName.replace(/\s*\(\d+\)\s*$/, '').trim();

    // If state title exists and looks like a proper title (not just author names),
    // prefer it. Author names typically have commas for multiple authors.
    if (stateTitle) {
      // Check if stateTitle looks more like a title than authors
      // Titles with years (e.g., "Bears Without Fear 2013") are likely titles
      // Files starting with same words as folder might be titles
      const hasYear = /\d{4}/.test(stateTitle);
      const hasMultipleCommas = (stateTitle.match(/,/g) || []).length >= 2;

      if (hasYear || !hasMultipleCommas) {
        // Clean up state title - remove Calibre ID if present
        return stateTitle.replace(/\s*\(\d+\)\s*$/, '').trim();
      }
    }

    // Try extracting from folder name (parent directory)
    // Calibre format: "Publisher, Title-Suffix" or "Author Name"
    const folderName = pathParts[pathParts.length - 2] || '';
    if (folderName && folderName !== 'Unknown') {
      const commaIndex = folderName.indexOf(',');
      if (commaIndex > 0) {
        // Format: "Publisher, Title-Suffix"
        let title = folderName.slice(commaIndex + 1).trim();
        // Remove publisher suffix if present
        const dashIndex = title.lastIndexOf('-');
        if (dashIndex > 0 && dashIndex > title.length - 20) {
          title = title.slice(0, dashIndex).trim();
        }
        return title;
      }
    }

    // Fall back to cleaned filename
    return cleanFileName || stateTitle || 'Unknown Book';
  }

  /**
   * Detect context from markdown view
   */
  private detectMarkdownContext(view: any): HUDContext {
    const file = view.file as TFile | undefined;
    if (!file) {
      return { type: 'none' };
    }

    const settings = this.getSettings();
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;

    // Check for book note
    if (frontmatter?.type === 'book') {
      return {
        type: 'book',
        bookId: frontmatter.bookId || frontmatter.calibreId?.toString(),
        calibreId: frontmatter.calibreId,
        title: frontmatter.title || file.basename,
        author: frontmatter.author || frontmatter.authors?.[0],
        series: frontmatter.series,
        bookPath: frontmatter.epubPath || frontmatter.pdfPath || frontmatter.calibrePath,
        notePath: file.path,
      };
    }

    // Check for highlight note
    if (frontmatter?.type === 'highlight' || frontmatter?.highlightId) {
      return {
        type: 'highlight',
        highlightId: frontmatter.highlightId,
        bookId: frontmatter.bookId,
        bookTitle: frontmatter.bookTitle,
        color: frontmatter.color,
      };
    }

    // Check for author index (by folder)
    if (this.isInFolder(file.path, settings.calibreAuthorIndexFolder)) {
      return {
        type: 'author',
        authorName: file.basename,
      };
    }

    // Check for series index (by folder)
    if (this.isInFolder(file.path, settings.calibreSeriesIndexFolder)) {
      return {
        type: 'series',
        seriesName: file.basename,
      };
    }

    // Check if in any book-related folder
    const bookFolders = [
      settings.calibreBookNotesFolder,
      settings.bookNoteFolder,
      settings.notesFolder,
    ];

    for (const folder of bookFolders) {
      if (folder && this.isInFolder(file.path, folder)) {
        // In a book folder but not a specific book note
        // Try to extract info from frontmatter or file name
        if (frontmatter?.calibreId || frontmatter?.bookId) {
          return {
            type: 'book',
            bookId: frontmatter.bookId || frontmatter.calibreId?.toString(),
            calibreId: frontmatter.calibreId,
            title: frontmatter.title || file.basename,
            notePath: file.path,
          };
        }
      }
    }

    return { type: 'none' };
  }

  /**
   * Check if a path is within a folder
   */
  private isInFolder(filePath: string, folderPath: string): boolean {
    if (!folderPath) return false;
    const normalizedFolder = folderPath.replace(/^\/+|\/+$/g, '');
    return filePath.startsWith(normalizedFolder + '/');
  }

  /**
   * Compare two contexts for equality
   */
  private isContextEqual(a: HUDContext, b: HUDContext): boolean {
    if (a.type !== b.type) return false;

    switch (a.type) {
      case 'book':
        const bookB = b as BookContext;
        return a.bookId === bookB.bookId &&
               a.bookPath === bookB.bookPath &&
               a.notePath === bookB.notePath;

      case 'highlight':
        const highlightB = b as HighlightContext;
        return a.highlightId === highlightB.highlightId;

      case 'author':
        const authorB = b as AuthorContext;
        return a.authorName === authorB.authorName;

      case 'series':
        const seriesB = b as SeriesContext;
        return a.seriesName === seriesB.seriesName;

      case 'none':
        return true;

      default:
        return false;
    }
  }

  /**
   * Notify subscribers of context change
   */
  private notifySubscribers(event: ContextChangeEvent): void {
    for (const callback of this.subscribers) {
      try {
        callback(event);
      } catch (e) {
        console.error('[ContextDetector] Subscriber error:', e);
      }
    }
  }
}

/**
 * Create a context detector instance
 */
export function createContextDetector(
  app: App,
  getSettings: () => LibrosSettings
): ContextDetector {
  return new ContextDetector(app, getSettings);
}

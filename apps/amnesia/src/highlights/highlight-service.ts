/**
 * Highlight service for CRUD operations
 */
import { App } from 'obsidian';
import { v4 as uuidv4 } from 'uuid';
import { Store } from '../helpers/store';
import { HighlightState, HighlightAction, PendingSelection } from './highlight-store';
import { NoteGenerator } from '../templates/note-generator';
import type { Highlight, HighlightColor, HighlightSelector, Book } from '../library/types';

interface HighlightIndex {
  version: number;
  highlights: Record<string, Highlight[]>; // bookId -> highlights
}

const HIGHLIGHT_INDEX_VERSION = 1;

export class HighlightService {
  private index: HighlightIndex;

  constructor(
    private app: App,
    private store: Store<HighlightState, HighlightAction>,
    private loadData: () => Promise<unknown>,
    private saveData: (data: unknown) => Promise<void>,
    private noteGenerator?: NoteGenerator
  ) {
    this.index = {
      version: HIGHLIGHT_INDEX_VERSION,
      highlights: {},
    };
  }

  /**
   * Initialize the highlight service
   */
  async initialize(): Promise<void> {
    await this.loadIndex();
  }

  /**
   * Load the highlight index from plugin data
   */
  private async loadIndex(): Promise<void> {
    try {
      const data = await this.loadData() as { highlightIndex?: HighlightIndex };
      if (data?.highlightIndex) {
        this.index = data.highlightIndex;

        // Restore highlights to store, converting date strings back to Date objects
        for (const [bookId, highlights] of Object.entries(this.index.highlights)) {
          const restoredHighlights = highlights.map(h => ({
            ...h,
            createdAt: new Date(h.createdAt),
            updatedAt: new Date(h.updatedAt),
          }));
          this.store.dispatch({
            type: 'SET_HIGHLIGHTS',
            payload: { bookId, highlights: restoredHighlights },
          });
        }
      }
    } catch (e) {
      console.warn('Failed to load highlight index:', e);
    }
  }

  /**
   * Save the highlight index to plugin data
   */
  private async saveIndex(): Promise<void> {
    try {
      const data = await this.loadData() as Record<string, unknown> | null;
      console.log('[Amnesia] Saving highlight index, current data keys:', data ? Object.keys(data) : 'none');
      await this.saveData({
        ...data,
        highlightIndex: this.index,
      });
      console.log('[Amnesia] Highlight index saved successfully');
    } catch (e) {
      console.error('[Amnesia] Failed to save highlight index:', e);
    }
  }

  /**
   * Get highlights for a book
   */
  getHighlights(bookId: string): Highlight[] {
    return this.store.getValue().highlights[bookId] || [];
  }

  /**
   * Get the underlying store for reactive subscriptions
   */
  getStore(): Store<HighlightState, HighlightAction> {
    return this.store;
  }

  /**
   * Create a new highlight
   */
  async createHighlight(
    bookId: string,
    text: string,
    cfi: string,
    color: HighlightColor = 'yellow',
    options?: {
      chapter?: string;
      pagePercent?: number;
      annotation?: string;
      // NEW: Robust anchoring fields
      spineIndex?: number;
      textQuote?: {
        exact: string;
        prefix?: string;
        suffix?: string;
      };
      textPosition?: {
        start: number;
        end: number;
      };
    }
  ): Promise<Highlight> {
    const now = new Date();

    // Build the W3C-aligned selector for robust re-anchoring
    const selector: HighlightSelector = {
      primary: { type: 'CfiSelector', cfi },
      fallback: {
        type: 'TextQuoteSelector',
        exact: options?.textQuote?.exact ?? text,
        prefix: options?.textQuote?.prefix,
        suffix: options?.textQuote?.suffix,
      },
      ...(options?.textPosition && {
        position: {
          type: 'TextPositionSelector',
          start: options.textPosition.start,
          end: options.textPosition.end,
        },
      }),
    };

    const highlight: Highlight = {
      id: uuidv4(),
      bookId,
      text,
      cfi,
      color,
      chapter: options?.chapter,
      pagePercent: options?.pagePercent,
      annotation: options?.annotation,
      // NEW: Robust anchoring
      spineIndex: options?.spineIndex ?? 0,
      selector,
      createdAt: now,
      updatedAt: now,
      synced: false,
    };

    // Update index
    if (!this.index.highlights[bookId]) {
      this.index.highlights[bookId] = [];
    }
    this.index.highlights[bookId].push(highlight);
    console.log('[Amnesia] Saving highlight to index:', { bookId, highlightId: highlight.id });
    await this.saveIndex();
    console.log('[Amnesia] Highlight saved to index, total for book:', this.index.highlights[bookId].length);

    // Update store
    this.store.dispatch({ type: 'ADD_HIGHLIGHT', payload: highlight });

    return highlight;
  }

  /**
   * Create a highlight from pending selection
   */
  async createFromSelection(
    selection: PendingSelection,
    color: HighlightColor = 'yellow',
    annotation?: string
  ): Promise<Highlight> {
    return this.createHighlight(
      selection.bookId,
      selection.text,
      selection.cfi,
      color,
      {
        chapter: selection.chapter,
        pagePercent: selection.pagePercent,
        annotation,
      }
    );
  }

  /**
   * Add a pre-built highlight object directly
   * Used when the caller has already constructed the Highlight
   */
  async addHighlight(highlight: Highlight): Promise<void> {
    const bookId = highlight.bookId;

    if (!highlight.id || !bookId || !highlight.text || !highlight.cfi) {
      console.error('[HighlightService] Invalid highlight - missing required fields', highlight);
      throw new Error('Invalid highlight: missing required fields');
    }

    if (!this.index.highlights[bookId]) {
      this.index.highlights[bookId] = [];
    }

    this.index.highlights[bookId].push(highlight);
    console.log('[HighlightService] addHighlight', { bookId, id: highlight.id });

    await this.saveIndex();
    this.store.dispatch({ type: 'ADD_HIGHLIGHT', payload: highlight });
  }

  /**
   * Update a highlight
   */
  async updateHighlight(
    bookId: string,
    highlightId: string,
    updates: Partial<Pick<Highlight, 'color' | 'annotation'>>
  ): Promise<Highlight | undefined> {
    const highlights = this.getHighlights(bookId);
    const highlight = highlights.find(h => h.id === highlightId);

    if (!highlight) {
      return undefined;
    }

    const updatedHighlight: Highlight = {
      ...highlight,
      ...updates,
      updatedAt: new Date(),
      synced: false,
    };

    // Update index
    const indexHighlights = this.index.highlights[bookId] || [];
    const indexIdx = indexHighlights.findIndex(h => h.id === highlightId);
    if (indexIdx >= 0) {
      indexHighlights[indexIdx] = updatedHighlight;
      await this.saveIndex();
    }

    // Update store
    this.store.dispatch({ type: 'UPDATE_HIGHLIGHT', payload: updatedHighlight });

    return updatedHighlight;
  }

  /**
   * Delete a highlight
   */
  async deleteHighlight(bookId: string, highlightId: string): Promise<boolean> {
    const highlights = this.getHighlights(bookId);
    const highlight = highlights.find(h => h.id === highlightId);

    if (!highlight) {
      return false;
    }

    // Update index
    if (this.index.highlights[bookId]) {
      this.index.highlights[bookId] = this.index.highlights[bookId].filter(
        h => h.id !== highlightId
      );
      await this.saveIndex();
    }

    // Update store
    this.store.dispatch({
      type: 'REMOVE_HIGHLIGHT',
      payload: { bookId, highlightId },
    });

    return true;
  }

  /**
   * Generate atomic note for a highlight
   */
  async generateHighlightNote(book: Book, highlight: Highlight): Promise<void> {
    if (!this.noteGenerator) {
      console.warn('Note generator not available');
      return;
    }

    const file = await this.noteGenerator.generateHighlightNote(book, highlight);

    // Update highlight with note path
    await this.updateHighlight(book.id, highlight.id, {
      ...highlight,
    });

    // Store the atomic note path
    const updatedHighlight = this.getHighlights(book.id).find(h => h.id === highlight.id);
    if (updatedHighlight) {
      updatedHighlight.atomicNotePath = file.path;

      // Save to index
      const indexHighlights = this.index.highlights[book.id] || [];
      const indexIdx = indexHighlights.findIndex(h => h.id === highlight.id);
      if (indexIdx >= 0) {
        indexHighlights[indexIdx].atomicNotePath = file.path;
        await this.saveIndex();
      }
    }
  }

  /**
   * Set pending selection (from text selection in reader)
   */
  setPendingSelection(selection: PendingSelection | null): void {
    this.store.dispatch({ type: 'SET_PENDING_SELECTION', payload: selection });
  }

  /**
   * Get pending selection
   */
  getPendingSelection(): PendingSelection | null {
    return this.store.getValue().pendingSelection;
  }

  /**
   * Search highlights across all books
   */
  searchHighlights(query: string): Highlight[] {
    const allHighlights = this.store.getValue().highlights;
    const results: Highlight[] = [];
    const q = query.toLowerCase();

    for (const highlights of Object.values(allHighlights)) {
      for (const h of highlights) {
        if (
          h.text.toLowerCase().includes(q) ||
          h.annotation?.toLowerCase().includes(q)
        ) {
          results.push(h);
        }
      }
    }

    return results;
  }

  /**
   * Get highlight count for a book
   */
  getHighlightCount(bookId: string): number {
    return this.getHighlights(bookId).length;
  }

  /**
   * Update note generator reference
   */
  setNoteGenerator(noteGenerator: NoteGenerator): void {
    this.noteGenerator = noteGenerator;
  }

  // ==========================================================================
  // Advanced Query API
  // ==========================================================================

  /**
   * Query options for filtering and sorting highlights
   */
  queryHighlights(options: HighlightQueryOptions): Highlight[] {
    let results: Highlight[] = [];

    // Get source highlights
    if (options.bookId) {
      results = [...(this.store.getValue().highlights[options.bookId] || [])];
    } else {
      // All books
      for (const highlights of Object.values(this.store.getValue().highlights)) {
        results.push(...highlights);
      }
    }

    // Filter by color
    if (options.color) {
      const colors = Array.isArray(options.color) ? options.color : [options.color];
      results = results.filter(h => colors.includes(h.color));
    }

    // Filter by has annotation
    if (options.hasAnnotation !== undefined) {
      results = results.filter(h =>
        options.hasAnnotation ? !!h.annotation : !h.annotation
      );
    }

    // Filter by chapter
    if (options.chapter) {
      results = results.filter(h =>
        h.chapter?.toLowerCase().includes(options.chapter!.toLowerCase())
      );
    }

    // Filter by date range
    if (options.dateRange) {
      const { start, end } = options.dateRange;
      results = results.filter(h => {
        const created = new Date(h.createdAt);
        return (!start || created >= start) && (!end || created <= end);
      });
    }

    // Filter by text search
    if (options.textSearch) {
      const q = options.textSearch.toLowerCase();
      results = results.filter(h =>
        h.text.toLowerCase().includes(q) ||
        h.annotation?.toLowerCase().includes(q)
      );
    }

    // Sort
    if (options.sortBy) {
      const order = options.sortOrder === 'desc' ? -1 : 1;

      results.sort((a, b) => {
        switch (options.sortBy) {
          case 'date':
            return order * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          case 'position':
            return order * ((a.pagePercent || 0) - (b.pagePercent || 0));
          case 'color':
            return order * a.color.localeCompare(b.color);
          case 'chapter':
            return order * (a.chapter || '').localeCompare(b.chapter || '');
          default:
            return 0;
        }
      });
    }

    // Pagination
    if (options.offset !== undefined || options.limit !== undefined) {
      const offset = options.offset || 0;
      const limit = options.limit || results.length;
      results = results.slice(offset, offset + limit);
    }

    return results;
  }

  /**
   * Get highlights by color
   */
  getHighlightsByColor(bookId: string, color: HighlightColor): Highlight[] {
    return this.queryHighlights({ bookId, color });
  }

  /**
   * Get highlights by chapter
   */
  getHighlightsByChapter(bookId: string, chapter: string): Highlight[] {
    return this.queryHighlights({ bookId, chapter });
  }

  /**
   * Get highlights by date range
   */
  getHighlightsByDateRange(
    start: Date,
    end: Date,
    bookId?: string
  ): Highlight[] {
    return this.queryHighlights({ bookId, dateRange: { start, end } });
  }

  /**
   * Get recent highlights (sorted by creation date, descending)
   */
  getRecentHighlights(limit: number, bookId?: string): Highlight[] {
    return this.queryHighlights({
      bookId,
      sortBy: 'date',
      sortOrder: 'desc',
      limit,
    });
  }

  /**
   * Get highlights with annotations
   */
  getAnnotatedHighlights(bookId?: string): Highlight[] {
    return this.queryHighlights({ bookId, hasAnnotation: true });
  }

  /**
   * Get highlight statistics
   */
  getHighlightStats(bookId?: string): HighlightStats {
    const highlights = bookId
      ? this.getHighlights(bookId)
      : Object.values(this.store.getValue().highlights).flat();

    const countByColor: Record<HighlightColor, number> = {
      yellow: 0,
      green: 0,
      blue: 0,
      pink: 0,
      purple: 0,
      orange: 0,
    };

    const countByChapter: Record<string, number> = {};
    const countByBook: Record<string, number> = {};
    let annotatedCount = 0;

    for (const h of highlights) {
      // Count by color
      countByColor[h.color] = (countByColor[h.color] || 0) + 1;

      // Count by chapter
      const chapter = h.chapter || 'Unknown';
      countByChapter[chapter] = (countByChapter[chapter] || 0) + 1;

      // Count by book
      countByBook[h.bookId] = (countByBook[h.bookId] || 0) + 1;

      // Count annotated
      if (h.annotation) {
        annotatedCount++;
      }
    }

    // Recent activity (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentActivity: Array<{ date: string; count: number }> = [];
    const activityMap = new Map<string, number>();

    for (const h of highlights) {
      const created = new Date(h.createdAt);
      if (created >= thirtyDaysAgo) {
        const dateStr = created.toISOString().split('T')[0];
        activityMap.set(dateStr, (activityMap.get(dateStr) || 0) + 1);
      }
    }

    for (const [date, count] of activityMap) {
      recentActivity.push({ date, count });
    }
    recentActivity.sort((a, b) => a.date.localeCompare(b.date));

    return {
      totalCount: highlights.length,
      annotatedCount,
      countByColor,
      countByChapter,
      countByBook,
      recentActivity,
    };
  }

  /**
   * Export highlights to various formats
   */
  exportHighlights(
    bookId: string,
    format: 'markdown' | 'json' | 'csv',
    options?: { includeAnnotations?: boolean; groupByChapter?: boolean }
  ): string {
    const highlights = this.getHighlights(bookId);
    const includeAnnotations = options?.includeAnnotations ?? true;
    const groupByChapter = options?.groupByChapter ?? false;

    switch (format) {
      case 'json':
        return JSON.stringify(highlights, null, 2);

      case 'csv': {
        const headers = ['Text', 'Color', 'Chapter', 'Created', 'Annotation'];
        const rows = highlights.map(h => [
          `"${h.text.replace(/"/g, '""')}"`,
          h.color,
          h.chapter || '',
          new Date(h.createdAt).toISOString(),
          includeAnnotations ? `"${(h.annotation || '').replace(/"/g, '""')}"` : '',
        ]);
        return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      }

      case 'markdown':
      default: {
        if (groupByChapter) {
          const byChapter = new Map<string, Highlight[]>();
          for (const h of highlights) {
            const chapter = h.chapter || 'Unknown Chapter';
            if (!byChapter.has(chapter)) {
              byChapter.set(chapter, []);
            }
            byChapter.get(chapter)!.push(h);
          }

          let md = '';
          for (const [chapter, chapterHighlights] of byChapter) {
            md += `## ${chapter}\n\n`;
            for (const h of chapterHighlights) {
              md += `> ${h.text}\n`;
              if (includeAnnotations && h.annotation) {
                md += `\n**Note:** ${h.annotation}\n`;
              }
              md += `\n*— ${h.color} highlight*\n\n`;
            }
          }
          return md;
        } else {
          let md = '';
          for (const h of highlights) {
            md += `> ${h.text}\n`;
            if (includeAnnotations && h.annotation) {
              md += `\n**Note:** ${h.annotation}\n`;
            }
            md += `\n*— ${h.chapter || 'Unknown'} | ${h.color}*\n\n---\n\n`;
          }
          return md;
        }
      }
    }
  }

  /**
   * Export all highlights
   */
  exportAllHighlights(format: 'markdown' | 'json' | 'csv'): string {
    const allHighlights = Object.values(this.store.getValue().highlights).flat();

    switch (format) {
      case 'json':
        return JSON.stringify(allHighlights, null, 2);

      case 'csv': {
        const headers = ['BookId', 'Text', 'Color', 'Chapter', 'Created', 'Annotation'];
        const rows = allHighlights.map(h => [
          h.bookId,
          `"${h.text.replace(/"/g, '""')}"`,
          h.color,
          h.chapter || '',
          new Date(h.createdAt).toISOString(),
          `"${(h.annotation || '').replace(/"/g, '""')}"`,
        ]);
        return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      }

      case 'markdown':
      default: {
        let md = '# All Highlights\n\n';
        for (const h of allHighlights) {
          md += `> ${h.text}\n`;
          if (h.annotation) {
            md += `\n**Note:** ${h.annotation}\n`;
          }
          md += `\n*— ${h.chapter || 'Unknown'} | ${h.color} | Book: ${h.bookId}*\n\n---\n\n`;
        }
        return md;
      }
    }
  }

  /**
   * Batch update multiple highlights
   */
  async batchUpdateHighlights(
    updates: Array<{ bookId: string; highlightId: string; changes: Partial<Highlight> }>
  ): Promise<Highlight[]> {
    const results: Highlight[] = [];

    for (const update of updates) {
      const highlight = await this.updateHighlight(
        update.bookId,
        update.highlightId,
        update.changes as Highlight
      );
      if (highlight) {
        results.push(highlight);
      }
    }

    return results;
  }

  /**
   * Batch delete multiple highlights
   */
  async batchDeleteHighlights(
    items: Array<{ bookId: string; highlightId: string }>
  ): Promise<number> {
    let deleted = 0;

    for (const item of items) {
      const success = await this.deleteHighlight(item.bookId, item.highlightId);
      if (success) {
        deleted++;
      }
    }

    return deleted;
  }
}

// ==========================================================================
// Types
// ==========================================================================

/**
 * Options for querying highlights
 */
export interface HighlightQueryOptions {
  /** Filter by book ID */
  bookId?: string;
  /** Filter by color (single or multiple) */
  color?: HighlightColor | HighlightColor[];
  /** Filter by whether highlight has an annotation */
  hasAnnotation?: boolean;
  /** Filter by chapter (partial match) */
  chapter?: string;
  /** Filter by creation date range */
  dateRange?: { start?: Date; end?: Date };
  /** Text search in highlight text and annotations */
  textSearch?: string;
  /** Sort by field */
  sortBy?: 'date' | 'position' | 'color' | 'chapter';
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
  /** Pagination: number of items to skip */
  offset?: number;
  /** Pagination: maximum number of items to return */
  limit?: number;
}

/**
 * Highlight statistics
 */
export interface HighlightStats {
  /** Total number of highlights */
  totalCount: number;
  /** Number of highlights with annotations */
  annotatedCount: number;
  /** Count by color */
  countByColor: Record<HighlightColor, number>;
  /** Count by chapter */
  countByChapter: Record<string, number>;
  /** Count by book */
  countByBook: Record<string, number>;
  /** Recent activity (last 30 days) */
  recentActivity: Array<{ date: string; count: number }>;
}

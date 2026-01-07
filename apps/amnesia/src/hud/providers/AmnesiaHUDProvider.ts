/**
 * Amnesia HUD Provider
 *
 * Adapter that connects Amnesia's domain services to the HUD interface.
 * Subscribes to stores and computes derived data for the HUD.
 * Includes dynamic context detection for contextual HUD information.
 *
 * When used with Doc Doctor's HUD:
 * - Provides status bar content via getStatusBarContent()
 * - Provides tab UI via mount() using the Renderer Pattern
 * - Data methods (getReadingStats, etc.) are available for custom rendering
 *
 * The Renderer Pattern (mount() method) enables cross-plugin Svelte component
 * rendering by delegating instantiation to Amnesia's bundled runtime, avoiding
 * conflicts with Doc Doctor's separate Svelte runtime.
 */

import { writable, derived, type Readable, type Writable } from 'svelte/store';
import type AmnesiaPlugin from '../../main';
import type { Book } from '../../library/types';
import type { ServerState, ServerStatus } from '../../server/server-manager';
import type {
  HUDContentProvider,
  HUDTab,
  StatusBarContent,
  StatusBarColor,
  ReadingStats,
  SeriesInfo,
  DocDoctorHUDContext,
  DocDoctorStatusBarContent,
  ComponentHandle,
  MountFunction,
} from '../types';
import {
  ContextDetector,
  createContextDetector,
  type HUDContext,
  type ContextChangeEvent,
} from '../context/context-detector';
import { createHUDStore } from '../state/hud-store';

// Tab components for cross-plugin mounting (Renderer Pattern)
// These are imported here so they're instantiated in Amnesia's bundle context
import ReadingTab from '../components/tabs/ReadingTab.svelte';
import LibraryTab from '../components/tabs/LibraryTab.svelte';
import StatsTab from '../components/tabs/StatsTab.svelte';
import ServerTab from '../components/tabs/ServerTab.svelte';
import SeriesTab from '../components/tabs/SeriesTab.svelte';

// Map of tab IDs to component classes
const TAB_COMPONENTS: Record<string, typeof ReadingTab> = {
  reading: ReadingTab,
  library: LibraryTab,
  stats: StatsTab,
  server: ServerTab,
  series: SeriesTab,
};

export class AmnesiaHUDProvider implements HUDContentProvider {
  readonly id = 'amnesia-reading';
  readonly displayName = 'Reading';
  readonly icon = 'book-open';
  readonly priority = 100;

  /**
   * Determines if Amnesia should be the active HUD provider.
   * Returns true when user is in a reading-related context.
   *
   * This is called by Doc Doctor's registry to decide which provider to show.
   */
  isActiveForContext(context: DocDoctorHUDContext): boolean {
    // Active when viewing EPUB files
    if (context.fileExtension === 'epub') {
      return true;
    }

    // Active when viewing PDF files
    if (context.fileExtension === 'pdf') {
      return true;
    }

    // Active when in the Amnesia reader view
    if (context.leafType === 'amnesia-reader') {
      return true;
    }

    // Active when viewing a book note (check frontmatter metadata)
    if (context.metadata?.['amnesia-book-id'] || context.metadata?.['calibre-id']) {
      return true;
    }

    // Not active for general markdown editing or other contexts
    return false;
  }

  private plugin: AmnesiaPlugin;
  private subscribers = new Set<() => void>();
  private unsubscribes: (() => void)[] = [];
  private cachedStats: ReadingStats | null = null;

  // Context detection
  private contextDetector: ContextDetector;
  private currentContext: HUDContext = { type: 'none' };
  private contextSubscribers = new Set<(context: HUDContext) => void>();

  // Reactive stores for Doc Doctor compatibility
  private primaryTextStore: Writable<string> = writable('');
  private indicatorColorStore: Writable<'green' | 'yellow' | 'red' | 'blue' | 'muted'> = writable('muted');
  private secondaryBadgeStore: Writable<{ text: string; variant: 'warning' | 'info' | 'success' } | null> = writable(null);
  private tooltipStore: Writable<string> = writable('');

  constructor(plugin: AmnesiaPlugin) {
    this.plugin = plugin;

    // Initialize context detector
    this.contextDetector = createContextDetector(
      plugin.app,
      () => plugin.settings
    );

    this.setupSubscriptions();
    this.setupContextDetection();

    // Initialize status bar content
    this.updateStatusBarStores();
  }

  /**
   * Set up context detection
   */
  private setupContextDetection(): void {
    const contextUnsub = this.contextDetector.subscribe((event) => {
      this.currentContext = event.current;
      this.notifyContextSubscribers(event.current);
      this.notifySubscribers(); // Also trigger general update
    });
    this.unsubscribes.push(contextUnsub);

    // Start detection
    this.contextDetector.start();
  }

  // ===========================================================================
  // Subscription Management
  // ===========================================================================

  private setupSubscriptions(): void {
    // Subscribe to library changes
    const libraryUnsub = this.plugin.libraryStore.subscribe(() => {
      this.cachedStats = null; // Invalidate cache
      this.notifySubscribers();
    });
    this.unsubscribes.push(libraryUnsub);

    // Subscribe to highlight changes
    const highlightUnsub = this.plugin.highlightStore.subscribe(() => {
      this.cachedStats = null; // Invalidate cache
      this.notifySubscribers();
    });
    this.unsubscribes.push(highlightUnsub);

    // Subscribe to server status changes
    if (this.plugin.serverManager) {
      const serverUnsub = this.plugin.serverManager.on(() => {
        this.notifySubscribers();
      });
      this.unsubscribes.push(serverUnsub);
    }
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notifySubscribers(): void {
    // Update reactive stores for Doc Doctor status bar
    this.updateStatusBarStores();

    for (const cb of this.subscribers) {
      try {
        cb();
      } catch (e) {
        console.error('[AmnesiaHUDProvider] Subscriber error:', e);
      }
    }
  }

  /**
   * Update the reactive stores used by Doc Doctor's status bar
   */
  private updateStatusBarStores(): void {
    const stats = this.getReadingStats();
    const serverStatus = this.getServerStatusInfo();
    const context = this.currentContext;

    // Build primary text - context-aware
    let primaryText = '';
    if (context.type === 'book') {
      const title = context.title || 'Book';
      const shortTitle = title.length > 20 ? title.slice(0, 20) + '…' : title;
      primaryText = `📖 ${shortTitle} | ${stats.totalHighlights} hl`;
    } else if (context.type === 'author') {
      primaryText = `👤 ${context.authorName} | ${stats.totalHighlights} hl`;
    } else if (context.type === 'series') {
      primaryText = `📚 ${context.seriesName} | ${stats.totalHighlights} hl`;
    } else if (context.type === 'highlight') {
      primaryText = `✨ Highlight | ${stats.totalHighlights} hl`;
    } else {
      primaryText = `${stats.currentlyReading} reading | ${stats.totalHighlights} hl`;
    }

    // Determine indicator color
    const healthColor = this.calculateHealthColor(stats.lastReadDate);
    let indicatorColor: 'green' | 'yellow' | 'red' | 'blue' | 'muted';
    if (healthColor === 'green') indicatorColor = 'green';
    else if (healthColor === 'yellow') indicatorColor = 'yellow';
    else if (healthColor === 'red') indicatorColor = 'red';
    else indicatorColor = 'muted';

    // Server status badge
    let badge: { text: string; variant: 'warning' | 'info' | 'success' } | null = null;
    if (serverStatus.status === 'running') {
      badge = { text: '● Server', variant: 'success' };
    } else if (serverStatus.status === 'error') {
      badge = { text: '⚠ Server', variant: 'warning' };
    }

    // Update stores
    this.primaryTextStore.set(primaryText);
    this.indicatorColorStore.set(indicatorColor);
    this.secondaryBadgeStore.set(badge);
    this.tooltipStore.set(this.generateTooltip(stats));
  }

  private notifyContextSubscribers(context: HUDContext): void {
    for (const cb of this.contextSubscribers) {
      try {
        cb(context);
      } catch (e) {
        console.error('[AmnesiaHUDProvider] Context subscriber error:', e);
      }
    }
  }

  /**
   * Get current detected context
   */
  getCurrentContext(): HUDContext {
    return this.currentContext;
  }

  /**
   * Subscribe to context changes
   */
  subscribeToContext(callback: (context: HUDContext) => void): () => void {
    this.contextSubscribers.add(callback);
    // Immediately call with current context
    callback(this.currentContext);
    return () => this.contextSubscribers.delete(callback);
  }

  // ===========================================================================
  // HUD Content Provider Interface
  // ===========================================================================

  getTabs(): HUDTab[] {
    const stats = this.getReadingStats();
    const serverStatus = this.getServerStatusInfo();
    const seriesCount = this.getActiveSeries().length;

    // Return tab definitions (components will be set by the HUD)
    return [
      {
        id: 'reading',
        label: 'READING',
        icon: 'book-open',
        badge: stats.currentlyReading > 0 ? stats.currentlyReading : undefined,
        component: null as any, // Will be set by HUD
      },
      {
        id: 'library',
        label: 'LIBRARY',
        icon: 'library',
        component: null as any,
      },
      {
        id: 'stats',
        label: 'STATS',
        icon: 'bar-chart-2',
        badge: stats.totalHighlights > 0 ? stats.totalHighlights : undefined,
        component: null as any,
      },
      {
        id: 'server',
        label: 'SERVER',
        icon: 'server',
        badge: serverStatus.indicator,
        component: null as any,
      },
      {
        id: 'series',
        label: 'SERIES',
        icon: 'layers',
        badge: seriesCount > 0 ? seriesCount : undefined,
        component: null as any,
      },
    ];
  }

  /**
   * Returns status bar content using Svelte stores (Doc Doctor compatible).
   * This is the primary interface used by Doc Doctor's dynamic status bar.
   */
  getStatusBarContent(): DocDoctorStatusBarContent {
    return {
      primaryText: this.primaryTextStore,
      indicatorColor: this.indicatorColorStore,
      secondaryBadge: this.secondaryBadgeStore,
      tooltip: this.tooltipStore,
    };
  }

  /**
   * Returns legacy status bar content (plain values).
   * Used by Amnesia's standalone HUD when Doc Doctor is not available.
   */
  getLegacyStatusBarContent(): StatusBarContent {
    const stats = this.getReadingStats();
    const serverStatus = this.getServerStatusInfo();
    const context = this.currentContext;

    // Determine health color based on last read date
    const healthColor = this.calculateHealthColor(stats.lastReadDate);

    // Build status text - context-aware
    const parts: string[] = [];

    // Show context-specific info if available
    if (context.type === 'book') {
      // Show current book info
      const title = context.title || 'Book';
      const shortTitle = title.length > 20 ? title.slice(0, 20) + '…' : title;
      parts.push(`📖 ${shortTitle}`);
    } else if (context.type === 'author') {
      parts.push(`👤 ${context.authorName}`);
    } else if (context.type === 'series') {
      parts.push(`📚 ${context.seriesName}`);
    } else if (context.type === 'highlight') {
      parts.push(`✨ Highlight`);
    } else {
      // Default: show reading stats
      parts.push(`${stats.currentlyReading} reading`);
    }

    parts.push(`${stats.totalHighlights} hl`);

    return {
      icon: 'book-open',
      text: parts.join(' | '),
      color: healthColor,
      tooltip: this.generateTooltip(stats),
      serverStatus: {
        indicator: serverStatus.indicator,
        color: serverStatus.color,
      },
    };
  }

  /**
   * Returns footer content for Doc Doctor HUD.
   * Required by HUDContentProvider interface.
   */
  getFooterContent(): { statsLine: Readable<string>; actions?: any[] } {
    const stats = this.getReadingStats();
    const statsLineStore = derived(
      [this.primaryTextStore],
      () => `${stats.totalBooks} books · ${stats.totalHighlights} highlights`
    );

    return {
      statsLine: statsLineStore,
      actions: [
        {
          id: 'open-library',
          label: 'Library',
          onClick: () => {
            // Open library view
            this.plugin.app.workspace.trigger('amnesia:open-library');
          },
        },
      ],
    };
  }

  /**
   * Returns compact view component for a tab.
   *
   * @deprecated Use mount() instead for cross-plugin component rendering.
   * This method is kept for backwards compatibility but returns null.
   * The mount() method properly handles cross-bundle Svelte runtime conflicts.
   */
  getCompactViewComponent(_tabId: string): { component: any; props: any } | null {
    // Deprecated: Use mount() instead
    return null;
  }

  /**
   * Returns detail view component for a detail type.
   *
   * @deprecated Use mount() for cross-plugin component rendering.
   */
  getDetailViewComponent(_detailType: string): any {
    return null;
  }

  onActivate(): void {
    console.log('[AmnesiaHUDProvider] Activated');
  }

  onDeactivate(): void {
    console.log('[AmnesiaHUDProvider] Deactivated');
  }

  // ===========================================================================
  // Cross-Plugin Component Mounting (Renderer Pattern)
  // ===========================================================================

  /**
   * Mount a tab's content into a container element.
   *
   * This is the key method for cross-plugin component rendering.
   * It instantiates Svelte components using Amnesia's bundled runtime,
   * avoiding runtime conflicts with Doc Doctor's Svelte runtime.
   *
   * The DOM acts as the framework-agnostic bridge between plugins.
   */
  mount(target: HTMLElement, props: Record<string, any>): ComponentHandle {
    const tabId = props.tabId || 'reading';

    // Get the component class for this tab
    const ComponentClass = TAB_COMPONENTS[tabId];
    if (!ComponentClass) {
      console.warn(`[AmnesiaHUDProvider] Unknown tab: ${tabId}`);
      target.innerHTML = `<div class="hud-empty">Unknown tab: ${tabId}</div>`;
      return {
        update: () => {},
        destroy: () => {},
      };
    }

    // Create a dedicated store for this mounted component
    // This isolates state management for cross-plugin rendering
    const store = createHUDStore();

    // CRITICAL: Component instantiation happens HERE, in Amnesia's bundle context
    // This uses Amnesia's bundled Svelte runtime, avoiding cross-bundle conflicts
    const component = new ComponentClass({
      target,
      props: {
        provider: this,
        store,
        ...props,
      },
    });

    console.log(`[AmnesiaHUDProvider] Mounted ${tabId} tab`);

    // Return handle for Doc Doctor to control the component's lifecycle
    return {
      update: (newProps: Record<string, any>) => {
        component.$set(newProps);
      },
      destroy: () => {
        console.log(`[AmnesiaHUDProvider] Destroying ${tabId} tab`);
        component.$destroy();
      },
    };
  }

  destroy(): void {
    // Stop context detection
    this.contextDetector.stop();
    this.contextSubscribers.clear();

    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.subscribers.clear();
    this.cachedStats = null;
  }

  // ===========================================================================
  // Data Access Methods
  // ===========================================================================

  getReadingStats(): ReadingStats {
    if (this.cachedStats) {
      return this.cachedStats;
    }

    const libraryState = this.plugin.libraryStore.getValue();
    const highlightState = this.plugin.highlightStore.getValue();
    const books = libraryState.books || [];

    // Count books by status
    const currentlyReading = books.filter(b => b.status === 'reading').length;
    const completedBooks = books.filter(b => b.status === 'completed').length;
    const toReadBooks = books.filter(b => b.status === 'to-read').length;

    // Count highlights
    const allHighlights = Object.values(highlightState.highlights).flat();
    const totalHighlights = allHighlights.length;

    // Count by color
    const highlightsByColor: Record<string, number> = {};
    for (const h of allHighlights) {
      const color = h.color || 'yellow';
      highlightsByColor[color] = (highlightsByColor[color] || 0) + 1;
    }

    // Calculate recent activity (last 7 days)
    const recentActivity = this.calculateRecentActivity(allHighlights);

    // Find last read date
    const lastReadDate = this.getLastReadDate(books);

    this.cachedStats = {
      currentlyReading,
      totalBooks: books.length,
      completedBooks,
      toReadBooks,
      totalHighlights,
      highlightsByColor,
      recentActivity,
      lastReadDate,
    };

    return this.cachedStats;
  }

  getReadingBooks(): Book[] {
    const libraryState = this.plugin.libraryStore.getValue();
    return (libraryState.books || [])
      .filter(b => b.status === 'reading')
      .sort((a, b) => {
        const aTime = a.lastRead?.getTime() || 0;
        const bTime = b.lastRead?.getTime() || 0;
        return bTime - aTime;
      });
  }

  getRecentBooks(limit = 5): Book[] {
    const libraryState = this.plugin.libraryStore.getValue();
    return (libraryState.books || [])
      .filter(b => b.lastRead)
      .sort((a, b) => {
        const aTime = a.lastRead?.getTime() || 0;
        const bTime = b.lastRead?.getTime() || 0;
        return bTime - aTime;
      })
      .slice(0, limit);
  }

  getRecentlyAddedBooks(limit = 5): Book[] {
    const libraryState = this.plugin.libraryStore.getValue();
    return (libraryState.books || [])
      .sort((a, b) => {
        const aTime = new Date(a.addedAt).getTime() || 0;
        const bTime = new Date(b.addedAt).getTime() || 0;
        return bTime - aTime;
      })
      .slice(0, limit);
  }

  getCompletedBooks(limit = 5): Book[] {
    const libraryState = this.plugin.libraryStore.getValue();
    return (libraryState.books || [])
      .filter(b => b.status === 'completed')
      .sort((a, b) => {
        const aTime = a.completedAt?.getTime() || 0;
        const bTime = b.completedAt?.getTime() || 0;
        return bTime - aTime;
      })
      .slice(0, limit);
  }

  getBook(bookId: string): Book | undefined {
    const libraryState = this.plugin.libraryStore.getValue();
    return libraryState.books.find(b => b.id === bookId);
  }

  getHighlights(bookId: string): any[] {
    const highlightState = this.plugin.highlightStore.getValue();
    return highlightState.highlights[bookId] || [];
  }

  getHighlightStats(bookId?: string): {
    total: number;
    byColor: Record<string, number>;
    withNotes: number;
  } {
    const highlightState = this.plugin.highlightStore.getValue();
    let highlights = bookId
      ? highlightState.highlights[bookId] || []
      : Object.values(highlightState.highlights).flat();

    const byColor: Record<string, number> = {};
    let withNotes = 0;

    for (const h of highlights) {
      const color = h.color || 'yellow';
      byColor[color] = (byColor[color] || 0) + 1;
      if (h.annotation) {
        withNotes++;
      }
    }

    return {
      total: highlights.length,
      byColor,
      withNotes,
    };
  }

  getActiveSeries(): SeriesInfo[] {
    // Note: The library store uses simple Book type without series data.
    // Series info would need to be extracted from UnifiedBook or Calibre metadata.
    // For now, we extract unique authors as a proxy for series grouping.
    const libraryState = this.plugin.libraryStore.getValue();
    const books = libraryState.books || [];

    // Group books by author
    const authorBooks = new Map<string, typeof books>();
    for (const book of books) {
      const author = book.author || 'Unknown Author';
      if (!authorBooks.has(author)) {
        authorBooks.set(author, []);
      }
      authorBooks.get(author)!.push(book);
    }

    // Convert to SeriesInfo (treating authors as "series" for now)
    const seriesInfo: SeriesInfo[] = [];
    for (const [author, authorBookList] of authorBooks) {
      if (authorBookList.length > 1) {
        // Only show authors with multiple books
        const readBooks = authorBookList.filter(b => b.status === 'completed').length;
        const currentBook = authorBookList.find(b => b.status === 'reading');

        seriesInfo.push({
          name: author,
          author: author,
          totalBooks: authorBookList.length,
          ownedBooks: authorBookList.length,
          readBooks,
          currentBook: currentBook?.title,
          progress: Math.round((readBooks / authorBookList.length) * 100),
        });
      }
    }

    // Sort by most books, then alphabetically
    return seriesInfo.sort((a, b) => {
      if (b.totalBooks !== a.totalBooks) return b.totalBooks - a.totalBooks;
      return a.name.localeCompare(b.name);
    });
  }

  getBooksBySeries(seriesName: string): Book[] {
    // Note: Currently using author name as series proxy
    const libraryState = this.plugin.libraryStore.getValue();
    return (libraryState.books || []).filter(b => b.author === seriesName);
  }

  getBooksByAuthor(authorName: string): Book[] {
    const libraryState = this.plugin.libraryStore.getValue();
    return (libraryState.books || [])
      .filter(b => b.author === authorName)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  getServerStatusInfo(): {
    status: ServerStatus;
    indicator: string;
    color: StatusBarColor;
    port?: number;
    uptime?: number;
    lastError?: string;
  } {
    if (!this.plugin.serverManager) {
      return {
        status: 'stopped',
        indicator: '○',
        color: 'gray',
      };
    }

    const state: ServerState = this.plugin.serverManager.getState();

    let indicator: string;
    let color: StatusBarColor;

    switch (state.status) {
      case 'running':
        indicator = '●';
        color = 'green';
        break;
      case 'starting':
      case 'stopping':
      case 'restarting':
        indicator = '◐';
        color = 'yellow';
        break;
      case 'error':
        indicator = '⚠';
        color = 'red';
        break;
      default:
        indicator = '○';
        color = 'gray';
    }

    return {
      status: state.status,
      indicator,
      color,
      port: state.port,
      uptime: state.uptime,
      lastError: state.lastError,
    };
  }

  // ===========================================================================
  // Book Action Methods
  // ===========================================================================

  /**
   * Open a book in the reader
   */
  async openBook(bookId: string): Promise<void> {
    const book = this.getBook(bookId);
    if (!book || !book.localPath) {
      console.warn('[AmnesiaHUDProvider] Cannot open book: no local path', bookId);
      return;
    }
    await this.plugin.openBook(book.localPath);
  }

  /**
   * Open a book's note file in the vault
   */
  async openBookNote(bookId: string): Promise<void> {
    const book = this.getBook(bookId);
    if (!book) {
      console.warn('[AmnesiaHUDProvider] Cannot open note: book not found', bookId);
      return;
    }

    // Try to find the note path from settings or generate one
    const noteFolder = this.plugin.settings.calibreBookNotesFolder || 'Books';
    const notePath = `${noteFolder}/${book.title}.md`;

    // Check if note exists
    const noteFile = this.plugin.app.vault.getAbstractFileByPath(notePath);
    if (noteFile) {
      await this.plugin.app.workspace.openLinkText(notePath, '', false);
    } else {
      // Note doesn't exist - could optionally create it
      console.warn('[AmnesiaHUDProvider] Book note not found:', notePath);
    }
  }

  // ===========================================================================
  // Server Control Methods
  // ===========================================================================

  async startServer(): Promise<boolean> {
    if (!this.plugin.serverManager) return false;
    return this.plugin.serverManager.start();
  }

  async stopServer(): Promise<void> {
    if (!this.plugin.serverManager) return;
    return this.plugin.serverManager.stop();
  }

  async restartServer(): Promise<boolean> {
    if (!this.plugin.serverManager) return false;
    return this.plugin.serverManager.restart();
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  private calculateHealthColor(lastReadDate: Date | null): StatusBarColor {
    if (!lastReadDate) {
      return 'gray';
    }

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
    const lastReadTime = lastReadDate.getTime();

    if (lastReadTime > oneDayAgo) {
      return 'green'; // Read today
    } else if (lastReadTime > threeDaysAgo) {
      return 'yellow'; // Read within 3 days
    } else {
      return 'gray'; // Inactive
    }
  }

  private getLastReadDate(books: Book[]): Date | null {
    let lastRead: Date | null = null;

    for (const book of books) {
      if (book.lastRead) {
        const date = book.lastRead instanceof Date
          ? book.lastRead
          : new Date(book.lastRead);
        if (!lastRead || date.getTime() > lastRead.getTime()) {
          lastRead = date;
        }
      }
    }

    return lastRead;
  }

  private calculateRecentActivity(highlights: any[]): number[] {
    const now = new Date();
    const activity: number[] = [0, 0, 0, 0, 0, 0, 0]; // Last 7 days

    for (const h of highlights) {
      if (!h.createdAt) continue;
      const created = h.createdAt instanceof Date
        ? h.createdAt
        : new Date(h.createdAt);
      const daysAgo = Math.floor(
        (now.getTime() - created.getTime()) / (24 * 60 * 60 * 1000)
      );
      if (daysAgo >= 0 && daysAgo < 7) {
        activity[6 - daysAgo]++;
      }
    }

    return activity;
  }

  private generateTooltip(stats: ReadingStats): string {
    const lines: string[] = [
      'Amnesia Reading Activity',
      '━'.repeat(24),
      `Currently reading: ${stats.currentlyReading} books`,
      `Total highlights: ${stats.totalHighlights}`,
    ];

    if (stats.lastReadDate) {
      const diff = Date.now() - stats.lastReadDate.getTime();
      const hours = Math.floor(diff / (60 * 60 * 1000));
      if (hours < 1) {
        lines.push('Last read: Just now');
      } else if (hours < 24) {
        lines.push(`Last read: ${hours} hour${hours === 1 ? '' : 's'} ago`);
      } else {
        const days = Math.floor(hours / 24);
        lines.push(`Last read: ${days} day${days === 1 ? '' : 's'} ago`);
      }
    } else {
      lines.push('Last read: Never');
    }

    lines.push('', 'Click to open HUD');

    return lines.join('\n');
  }

  // ===========================================================================
  // Formatting Utilities
  // ===========================================================================

  formatRelativeTime(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  }

  formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }
}

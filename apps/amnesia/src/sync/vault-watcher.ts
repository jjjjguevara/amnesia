/**
 * Vault Watcher
 *
 * Watches Obsidian vault for changes to highlight/note files
 * and triggers sync when modifications are detected.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import { TFile, type App, type TAbstractFile, type EventRef } from 'obsidian';
import { HighlightParser, type ParsedHighlight, type ParsedNote } from './highlight-parser';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for vault watcher
 */
export interface VaultWatcherOptions {
  /** Debounce delay for file changes (ms) */
  debounceDelay: number;
  /** File patterns to watch (glob-like) */
  watchPatterns?: string[];
  /** File patterns to ignore */
  ignorePatterns?: string[];
}

/**
 * Default watcher options
 */
export const DEFAULT_WATCHER_OPTIONS: VaultWatcherOptions = {
  debounceDelay: 2000,
  watchPatterns: ['**/*.md'],
  ignorePatterns: ['.obsidian/**', '.trash/**'],
};

/**
 * Vault change event
 */
export interface VaultChangeEvent {
  /** The file that changed */
  file: TFile;
  /** Type of change */
  changeType: 'create' | 'modify' | 'delete' | 'rename';
  /** Old path (for renames) */
  oldPath?: string;
  /** Whether file was deleted */
  deleted: boolean;
  /** Parsed highlights from the file (if applicable) */
  parsedHighlights?: ParsedHighlight[];
  /** Parsed notes from the file (if applicable) */
  parsedNotes?: ParsedNote[];
  /** File content (if available) */
  content?: string;
}

/**
 * Listener type for change events
 */
export type VaultChangeListener = (event: VaultChangeEvent) => void;

// ============================================================================
// Vault Watcher
// ============================================================================

/**
 * Watches vault for changes to highlight/note files
 */
export class VaultWatcher {
  private app: App;
  private parser: HighlightParser;
  private options: VaultWatcherOptions;
  private listeners: Map<string, Set<VaultChangeListener>> = new Map();
  private eventRefs: EventRef[] = [];
  private pendingChanges: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;

  constructor(
    app: App,
    parser: HighlightParser,
    options: Partial<VaultWatcherOptions> = {}
  ) {
    this.app = app;
    this.parser = parser;
    this.options = { ...DEFAULT_WATCHER_OPTIONS, ...options };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start watching the vault
   */
  start(): void {
    if (this.isRunning) return;

    // Watch for file modifications
    this.eventRefs.push(
      this.app.vault.on('modify', this.handleModify.bind(this))
    );

    // Watch for file creation
    this.eventRefs.push(
      this.app.vault.on('create', this.handleCreate.bind(this))
    );

    // Watch for file deletion
    this.eventRefs.push(
      this.app.vault.on('delete', this.handleDelete.bind(this))
    );

    // Watch for file rename
    this.eventRefs.push(
      this.app.vault.on('rename', this.handleRename.bind(this))
    );

    this.isRunning = true;
    console.log('[VaultWatcher] Started watching vault');
  }

  /**
   * Stop watching the vault
   */
  stop(): void {
    if (!this.isRunning) return;

    // Remove all event listeners
    this.eventRefs.forEach((ref) => this.app.vault.offref(ref));
    this.eventRefs = [];

    // Clear pending changes
    this.pendingChanges.forEach((timeout) => clearTimeout(timeout));
    this.pendingChanges.clear();

    this.isRunning = false;
    console.log('[VaultWatcher] Stopped watching vault');
  }

  /**
   * Update debounce delay
   */
  setDebounceDelay(delay: number): void {
    this.options.debounceDelay = delay;
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  /**
   * Register a change listener
   */
  on(event: 'change', listener: VaultChangeListener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  /**
   * Emit an event to all listeners
   */
  private emit(event: string, data: VaultChangeEvent): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach((listener) => listener(data));
    }
  }

  // ==========================================================================
  // File Event Handlers
  // ==========================================================================

  /**
   * Handle file modification
   */
  private handleModify(file: TAbstractFile): void {
    // CRITICAL FIX: Properly check for TFile (not TFolder)
    if (!(file instanceof TFile)) return;
    if (!this.shouldWatch(file)) return;

    this.debounceChange(file, 'modify');
  }

  /**
   * Handle file creation
   */
  private handleCreate(file: TAbstractFile): void {
    // CRITICAL FIX: Properly check for TFile (not TFolder)
    if (!(file instanceof TFile)) return;
    if (!this.shouldWatch(file)) return;

    this.debounceChange(file, 'create');
  }

  /**
   * Handle file deletion
   */
  private handleDelete(file: TAbstractFile): void {
    // For deleted files, emit immediately (no debounce)
    const event: VaultChangeEvent = {
      file: file as TFile,
      changeType: 'delete',
      deleted: true,
    };
    this.emit('change', event);
  }

  /**
   * Handle file rename
   */
  private handleRename(file: TAbstractFile, oldPath: string): void {
    // CRITICAL FIX: Properly check for TFile (not TFolder)
    if (!(file instanceof TFile)) return;
    if (!this.shouldWatch(file)) return;

    const event: VaultChangeEvent = {
      file,
      changeType: 'rename',
      oldPath,
      deleted: false,
    };
    this.emit('change', event);
  }

  /**
   * Debounce file changes to avoid rapid-fire events
   */
  private debounceChange(file: TFile, changeType: 'create' | 'modify'): void {
    const path = file.path;

    // Clear existing timeout for this file
    if (this.pendingChanges.has(path)) {
      clearTimeout(this.pendingChanges.get(path)!);
    }

    // Set new timeout
    const timeout = setTimeout(async () => {
      this.pendingChanges.delete(path);
      await this.processChange(file, changeType);
    }, this.options.debounceDelay);

    this.pendingChanges.set(path, timeout);
  }

  /**
   * Process a debounced change
   */
  private async processChange(
    file: TFile,
    changeType: 'create' | 'modify'
  ): Promise<void> {
    try {
      // Read file content
      const content = await this.app.vault.read(file);

      // Parse highlights and notes from content
      const parsedHighlights = this.parser.parseHighlightsFromContent(content);
      const parsedNotes = this.parser.parseNotesFromContent(content);

      // Only emit if we found relevant content
      if (parsedHighlights.length > 0 || parsedNotes.length > 0) {
        const event: VaultChangeEvent = {
          file,
          changeType,
          deleted: false,
          parsedHighlights,
          parsedNotes,
          content,
        };
        this.emit('change', event);
      }
    } catch (error) {
      console.error(`[VaultWatcher] Error processing ${file.path}:`, error);
    }
  }

  // ==========================================================================
  // Filtering
  // ==========================================================================

  /**
   * Check if a file should be watched
   */
  private shouldWatch(file: TFile): boolean {
    const path = file.path;

    // Check ignore patterns
    for (const pattern of this.options.ignorePatterns || []) {
      if (this.matchPattern(path, pattern)) {
        return false;
      }
    }

    // Only watch markdown files by default
    if (!path.endsWith('.md')) {
      return false;
    }

    // Check watch patterns if specified
    if (this.options.watchPatterns && this.options.watchPatterns.length > 0) {
      for (const pattern of this.options.watchPatterns) {
        if (this.matchPattern(path, pattern)) {
          return true;
        }
      }
      return false;
    }

    return true;
  }

  /**
   * Simple glob-like pattern matching
   */
  private matchPattern(path: string, pattern: string): boolean {
    // Convert glob to regex
    const regexStr = pattern
      .replace(/\*\*/g, '<<<GLOBSTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<GLOBSTAR>>>/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(path);
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  /**
   * Check if watcher is running
   */
  isWatching(): boolean {
    return this.isRunning;
  }

  /**
   * Get number of pending changes
   */
  getPendingCount(): number {
    return this.pendingChanges.size;
  }

  /**
   * Force flush all pending changes
   */
  async flushPending(): Promise<void> {
    const pending = Array.from(this.pendingChanges.entries());
    this.pendingChanges.forEach((timeout) => clearTimeout(timeout));
    this.pendingChanges.clear();

    for (const [path] of pending) {
      const file = this.app.vault.getAbstractFileByPath(path);
      // CRITICAL FIX: Properly check for TFile (not TFolder)
      if (file && file instanceof TFile) {
        await this.processChange(file, 'modify');
      }
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a vault watcher instance
 */
export function createVaultWatcher(
  app: App,
  parser: HighlightParser,
  options?: Partial<VaultWatcherOptions>
): VaultWatcher {
  return new VaultWatcher(app, parser, options);
}

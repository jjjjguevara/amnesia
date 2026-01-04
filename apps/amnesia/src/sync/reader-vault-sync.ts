/**
 * Reader ↔ Vault Sync Orchestrator
 *
 * Manages bidirectional synchronization between the in-reader highlights/notes
 * and Obsidian vault notes. Supports multiple sync modes including unilateral options.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import { TFile, type App, type EventRef } from 'obsidian';
import type { Highlight, HighlightColor } from '../library/types';
import type { HighlightAction, HighlightState } from '../highlights/highlight-store';
import type { InlineModeSettings } from '../settings/settings';
import { VaultWatcher, type VaultChangeEvent } from './vault-watcher';
import { HighlightParser, type ParsedHighlight, type ParsedNote } from './highlight-parser';
import { ConflictResolver, type SyncConflict, type ConflictResolution } from './conflict-resolver';

// ============================================================================
// Types
// ============================================================================

/**
 * Sync mode for Reader ↔ Vault synchronization
 */
export type ReaderVaultSyncMode =
  | 'bidirectional'      // Changes sync both directions
  | 'reader-to-vault'    // Reader changes → vault only
  | 'vault-to-reader'    // Vault changes → reader only
  | 'manual';            // User triggers sync explicitly

/**
 * Settings for Reader ↔ Vault sync
 */
export interface ReaderVaultSyncSettings {
  /** Sync mode for highlights */
  highlightSyncMode: ReaderVaultSyncMode;
  /** Sync mode for notes/annotations */
  noteSyncMode: ReaderVaultSyncMode;
  /** Append-only vault: deletions in reader don't delete vault notes */
  appendOnlyVault: boolean;
  /** Preserve reader highlights: deletions in vault don't delete reader highlights */
  preserveReaderHighlights: boolean;
  /** Debounce delay for vault changes (ms) */
  debounceDelay: number;
  /** Auto-sync on highlight create/update/delete */
  autoSync: boolean;
  /** Inline mode settings (section markers) */
  inlineMode?: InlineModeSettings;
  /** Auto-regenerate hub files when highlights change */
  autoRegenerateHub: boolean;
  /** Debounce delay for hub regeneration (ms) - to batch multiple rapid changes */
  hubRegenerateDelay: number;
}

/**
 * Default sync settings
 */
export const DEFAULT_READER_VAULT_SYNC_SETTINGS: ReaderVaultSyncSettings = {
  highlightSyncMode: 'bidirectional',
  noteSyncMode: 'bidirectional',
  appendOnlyVault: false,
  preserveReaderHighlights: false,
  debounceDelay: 2000,
  autoSync: true,
  autoRegenerateHub: false, // Off by default - user can enable
  hubRegenerateDelay: 5000, // 5 seconds to batch rapid changes
};

/**
 * Callback type for hub regeneration
 */
export type HubRegenerateCallback = (bookId: string) => Promise<void>;

/**
 * Callback type for atomic note creation
 * Returns the created note path, or null if creation failed
 */
export type AtomicNoteCreateCallback = (
  bookId: string,
  highlight: Highlight
) => Promise<string | null>;

/**
 * Sync direction for a single operation
 */
export type SyncDirection = 'reader-to-vault' | 'vault-to-reader';

/**
 * Sync trigger source
 */
export type SyncTrigger =
  | 'highlight-created'
  | 'highlight-updated'
  | 'highlight-deleted'
  | 'vault-modified'
  | 'vault-deleted'
  | 'manual';

/**
 * Sync operation result
 */
export interface SyncOperationResult {
  success: boolean;
  direction: SyncDirection;
  trigger: SyncTrigger;
  itemsProcessed: number;
  itemsSkipped: number;
  conflicts: SyncConflict[];
  errors: Error[];
}

/**
 * Event emitted by the sync orchestrator
 */
export interface ReaderVaultSyncEvent {
  type: 'sync-start' | 'sync-complete' | 'conflict-detected' | 'error';
  data: {
    trigger?: SyncTrigger;
    result?: SyncOperationResult;
    conflict?: SyncConflict;
    error?: Error;
  };
}

/**
 * Listener type for sync events
 */
export type SyncEventListener = (event: ReaderVaultSyncEvent) => void;

// ============================================================================
// Sync Orchestrator
// ============================================================================

/**
 * Orchestrates bidirectional sync between reader highlights and vault notes
 */
export class ReaderVaultSyncOrchestrator {
  private app: App;
  private settings: ReaderVaultSyncSettings;
  private vaultWatcher: VaultWatcher;
  private highlightParser: HighlightParser;
  private conflictResolver: ConflictResolver;
  private listeners: Set<SyncEventListener> = new Set();
  private eventRefs: EventRef[] = [];
  private isSyncing = false;
  private pendingSync: Map<string, SyncTrigger> = new Map();

  // Highlight state access (provided by plugin)
  private getHighlightState: () => HighlightState;
  private dispatchHighlightAction: (action: HighlightAction) => void;

  // Hub regeneration support
  private hubRegenerateCallback: HubRegenerateCallback | null = null;
  private pendingHubRegeneration: Map<string, NodeJS.Timeout> = new Map();

  // Atomic note creation support
  private atomicNoteCreateCallback: AtomicNoteCreateCallback | null = null;

  constructor(
    app: App,
    settings: ReaderVaultSyncSettings,
    getHighlightState: () => HighlightState,
    dispatchHighlightAction: (action: HighlightAction) => void
  ) {
    this.app = app;
    this.settings = settings;
    this.getHighlightState = getHighlightState;
    this.dispatchHighlightAction = dispatchHighlightAction;

    this.highlightParser = new HighlightParser();
    this.conflictResolver = new ConflictResolver(app);
    this.vaultWatcher = new VaultWatcher(app, this.highlightParser, {
      debounceDelay: settings.debounceDelay,
    });
  }

  /**
   * Set the callback for hub file regeneration
   * This should be called by the plugin to wire up HighlightGenerator
   */
  setHubRegenerateCallback(callback: HubRegenerateCallback): void {
    this.hubRegenerateCallback = callback;
  }

  /**
   * Set the callback for atomic note creation
   * This should be called by the plugin to wire up HighlightGenerator
   */
  setAtomicNoteCreateCallback(callback: AtomicNoteCreateCallback): void {
    this.atomicNoteCreateCallback = callback;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start the sync orchestrator
   */
  start(): void {
    // Set up vault watcher
    this.vaultWatcher.on('change', this.handleVaultChange.bind(this));
    this.vaultWatcher.start();

    console.log('[ReaderVaultSync] Started');
  }

  /**
   * Scan a folder for existing atomic notes and load them into the highlight store
   * This is used on startup or when opening a book to load existing vault highlights
   */
  async scanAndLoadHighlightsFromFolder(folderPath: string, bookId: string): Promise<number> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      console.log(`[ReaderVaultSync] Folder not found: ${folderPath}`);
      return 0;
    }

    let loadedCount = 0;
    const existingHighlights = this.getHighlightState().highlights[bookId] || [];
    const existingIds = new Set(existingHighlights.map(h => h.id));

    // Get all markdown files in the folder
    const files = this.app.vault.getMarkdownFiles().filter(
      f => f.path.startsWith(folderPath)
    );

    console.log(`[ReaderVaultSync] Scanning ${files.length} files in ${folderPath}`);

    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const parsed = this.highlightParser.parseHighlightsFromContent(content);

        for (const parsedHighlight of parsed) {
          // Skip if already exists
          if (existingIds.has(parsedHighlight.id)) {
            continue;
          }

          // Convert to Highlight and add to store
          const highlight = this.convertParsedToHighlight(parsedHighlight, bookId, file.path);

          this.dispatchHighlightAction({
            type: 'ADD_HIGHLIGHT',
            payload: highlight,
          });

          existingIds.add(highlight.id);
          loadedCount++;
        }
      } catch (error) {
        console.warn(`[ReaderVaultSync] Error parsing ${file.path}:`, error);
      }
    }

    if (loadedCount > 0) {
      console.log(`[ReaderVaultSync] Loaded ${loadedCount} highlights from vault into store`);
    }

    return loadedCount;
  }

  /**
   * Convert a parsed highlight to a Highlight object
   */
  private convertParsedToHighlight(
    parsed: ParsedHighlight,
    bookId: string,
    filePath: string
  ): Highlight {
    const frontmatter = parsed.frontmatter || {};

    return {
      id: parsed.id,
      bookId: (frontmatter.bookId as string) || bookId,
      text: parsed.text,
      cfi: (frontmatter.cfi as string) || '',
      color: (parsed.color || 'yellow') as Highlight['color'],
      chapter: frontmatter.chapter as string | undefined,
      pagePercent: frontmatter.pagePercent as number | undefined,
      createdAt: parsed.updatedAt || new Date(),
      updatedAt: parsed.updatedAt || new Date(),
      synced: true,
      annotation: parsed.annotation,
      atomicNotePath: filePath,
      spineIndex: (frontmatter.spineIndex as number) || 0,
      selector: {
        primary: {
          type: 'CfiSelector',
          cfi: (frontmatter.cfi as string) || '',
        },
        fallback: {
          type: 'TextQuoteSelector',
          exact: parsed.text,
        },
      },
    };
  }

  /**
   * Stop the sync orchestrator
   */
  stop(): void {
    this.vaultWatcher.stop();
    this.eventRefs.forEach((ref) => this.app.vault.offref(ref));
    this.eventRefs = [];
    this.listeners.clear();

    // Clear pending hub regenerations
    this.pendingHubRegeneration.forEach((timeout) => clearTimeout(timeout));
    this.pendingHubRegeneration.clear();

    console.log('[ReaderVaultSync] Stopped');
  }

  /**
   * Update settings
   */
  updateSettings(settings: Partial<ReaderVaultSyncSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.vaultWatcher.setDebounceDelay(this.settings.debounceDelay);
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  /**
   * Register an event listener
   */
  on(listener: SyncEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Emit an event to all listeners
   */
  private emit(event: ReaderVaultSyncEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }

  // ==========================================================================
  // Reader → Vault Sync
  // ==========================================================================

  /**
   * Handle highlight created in reader
   */
  async onHighlightCreated(highlight: Highlight): Promise<void> {
    if (!this.settings.autoSync) return;
    if (this.settings.highlightSyncMode === 'vault-to-reader') return;
    if (this.settings.highlightSyncMode === 'manual') return;

    await this.syncHighlightToVault(highlight, 'highlight-created');
  }

  /**
   * Handle highlight updated in reader
   */
  async onHighlightUpdated(highlight: Highlight): Promise<void> {
    if (!this.settings.autoSync) return;
    if (this.settings.highlightSyncMode === 'vault-to-reader') return;
    if (this.settings.highlightSyncMode === 'manual') return;

    await this.syncHighlightToVault(highlight, 'highlight-updated');
  }

  /**
   * Handle highlight deleted in reader
   * @param bookId The book ID
   * @param highlightId The highlight ID
   * @param atomicNotePath Optional path to the atomic note file (must be passed since highlight is already removed from store)
   */
  async onHighlightDeleted(bookId: string, highlightId: string, atomicNotePath?: string): Promise<void> {
    if (!this.settings.autoSync) return;
    if (this.settings.highlightSyncMode === 'vault-to-reader') return;
    if (this.settings.highlightSyncMode === 'manual') return;
    if (this.settings.appendOnlyVault) {
      console.log(`[ReaderVaultSync] Append-only mode: not deleting vault note for ${highlightId}`);
      // Still regenerate hub to mark as tombstone
      if (this.settings.autoRegenerateHub) {
        this.scheduleHubRegeneration(bookId);
      }
      return;
    }

    await this.deleteHighlightFromVaultByPath(bookId, highlightId, atomicNotePath);

    // Schedule hub regeneration to remove the deleted highlight
    if (this.settings.autoRegenerateHub) {
      this.scheduleHubRegeneration(bookId);
    }
  }

  /**
   * Sync a single highlight to vault
   */
  private async syncHighlightToVault(
    highlight: Highlight,
    trigger: SyncTrigger
  ): Promise<SyncOperationResult> {
    const result: SyncOperationResult = {
      success: true,
      direction: 'reader-to-vault',
      trigger,
      itemsProcessed: 0,
      itemsSkipped: 0,
      conflicts: [],
      errors: [],
    };

    try {
      this.emit({ type: 'sync-start', data: { trigger } });

      // Check if inline mode is enabled
      if (this.settings.inlineMode?.inlineHighlights) {
        await this.syncHighlightInline(highlight);
      } else if (highlight.atomicNotePath) {
        // Atomic note exists - sync to it
        await this.syncHighlightAtomic(highlight);
      } else if (this.atomicNoteCreateCallback && highlight.bookId) {
        // Atomic note doesn't exist - create it
        console.log(`[ReaderVaultSync] Creating atomic note for highlight ${highlight.id}`);
        const notePath = await this.atomicNoteCreateCallback(highlight.bookId, highlight);
        if (notePath) {
          // Update the highlight with the new path
          highlight.atomicNotePath = notePath;
          // Dispatch update to store
          this.dispatchHighlightAction({
            type: 'UPDATE_HIGHLIGHT',
            payload: { ...highlight, atomicNotePath: notePath },
          });
          console.log(`[ReaderVaultSync] Atomic note created at: ${notePath}`);
        }
      }

      result.itemsProcessed = 1;

      // Schedule hub regeneration if enabled
      if (this.settings.autoRegenerateHub && highlight.bookId) {
        this.scheduleHubRegeneration(highlight.bookId);
      }
    } catch (error) {
      result.success = false;
      result.errors.push(error as Error);
      this.emit({ type: 'error', data: { error: error as Error } });
    }

    this.emit({ type: 'sync-complete', data: { result, trigger } });
    return result;
  }

  /**
   * Schedule hub file regeneration with debouncing
   * Multiple rapid changes will be batched into a single regeneration
   */
  private scheduleHubRegeneration(bookId: string): void {
    if (!this.hubRegenerateCallback) {
      console.log(`[ReaderVaultSync] Hub regeneration not configured, skipping for book ${bookId}`);
      return;
    }

    // Clear existing timeout for this book
    if (this.pendingHubRegeneration.has(bookId)) {
      clearTimeout(this.pendingHubRegeneration.get(bookId)!);
    }

    // Schedule regeneration after delay
    const timeout = setTimeout(async () => {
      this.pendingHubRegeneration.delete(bookId);
      try {
        console.log(`[ReaderVaultSync] Regenerating hub file for book ${bookId}`);
        await this.hubRegenerateCallback!(bookId);
        console.log(`[ReaderVaultSync] Hub file regenerated for book ${bookId}`);
      } catch (error) {
        console.error(`[ReaderVaultSync] Failed to regenerate hub for book ${bookId}:`, error);
        this.emit({ type: 'error', data: { error: error as Error } });
      }
    }, this.settings.hubRegenerateDelay);

    this.pendingHubRegeneration.set(bookId, timeout);
  }

  /**
   * Sync highlight to inline section in book note
   */
  private async syncHighlightInline(highlight: Highlight): Promise<void> {
    // This would integrate with unified-note-generator's inline methods
    // For now, log the intention
    console.log(`[ReaderVaultSync] Would sync highlight ${highlight.id} inline to book note`);
  }

  /**
   * Sync highlight to atomic note file
   */
  private async syncHighlightAtomic(highlight: Highlight): Promise<void> {
    if (!highlight.atomicNotePath) return;

    const file = this.app.vault.getAbstractFileByPath(highlight.atomicNotePath);
    // CRITICAL FIX: Properly check for TFile (not TFolder)
    if (!file || !(file instanceof TFile)) {
      // File doesn't exist - would need to create it
      console.log(`[ReaderVaultSync] Would create atomic note at ${highlight.atomicNotePath}`);
      return;
    }

    // Update frontmatter only (safe update)
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.text = highlight.text;
      frontmatter.annotation = highlight.annotation;
      frontmatter.color = highlight.color;
      frontmatter.updatedAt = highlight.updatedAt.toISOString();
      frontmatter.amnesia_highlight_id = highlight.id;
    });
  }

  /**
   * Delete highlight from vault
   */
  private async deleteHighlightFromVault(
    bookId: string,
    highlightId: string
  ): Promise<void> {
    // Check append-only mode
    if (this.settings.appendOnlyVault) {
      console.log(`[ReaderVaultSync] Append-only mode: not deleting vault note for ${highlightId}`);
      return;
    }

    // Find the highlight in the store to get its file path
    const state = this.getHighlightState();
    const highlights = state.highlights[bookId] || [];
    const highlight = highlights.find(h => h.id === highlightId);

    if (!highlight) {
      console.log(`[ReaderVaultSync] Highlight ${highlightId} not found in store, cannot delete from vault`);
      return;
    }

    // Handle atomic note deletion
    if (highlight.atomicNotePath) {
      const file = this.app.vault.getAbstractFileByPath(highlight.atomicNotePath);
      if (file instanceof TFile) {
        await this.app.vault.delete(file);
        console.log(`[ReaderVaultSync] Deleted atomic note: ${highlight.atomicNotePath}`);
      } else {
        console.log(`[ReaderVaultSync] Atomic note not found: ${highlight.atomicNotePath}`);
      }
      return;
    }

    // Handle inline mode: tombstone the highlight in the managed section
    // Note: For inline mode, we'd need to find the book note file based on bookId
    // This requires looking up the book's note path from the library or calibre store
    // For now, log that inline deletion is not yet implemented
    if (this.settings.inlineMode?.inlineHighlights) {
      console.log(`[ReaderVaultSync] Inline mode deletion not yet implemented for highlight ${highlightId}`);
      // TODO: Implement finding the book note path from bookId
      // Then call: await this.tombstoneInlineHighlight(bookNoteFile, highlightId);
    }
  }

  /**
   * Delete highlight from vault by path (used when highlight is already removed from store)
   */
  private async deleteHighlightFromVaultByPath(
    bookId: string,
    highlightId: string,
    atomicNotePath?: string
  ): Promise<void> {
    // Check append-only mode
    if (this.settings.appendOnlyVault) {
      console.log(`[ReaderVaultSync] Append-only mode: not deleting vault note for ${highlightId}`);
      return;
    }

    // Handle atomic note deletion if path is provided
    if (atomicNotePath) {
      const file = this.app.vault.getAbstractFileByPath(atomicNotePath);
      if (file instanceof TFile) {
        await this.app.vault.delete(file);
        console.log(`[ReaderVaultSync] Deleted atomic note: ${atomicNotePath}`);
      } else {
        console.log(`[ReaderVaultSync] Atomic note not found: ${atomicNotePath}`);
      }
      return;
    }

    // If no path provided, try to find from store (fallback)
    const state = this.getHighlightState();
    const highlights = state.highlights[bookId] || [];
    const highlight = highlights.find(h => h.id === highlightId);

    if (highlight?.atomicNotePath) {
      const file = this.app.vault.getAbstractFileByPath(highlight.atomicNotePath);
      if (file instanceof TFile) {
        await this.app.vault.delete(file);
        console.log(`[ReaderVaultSync] Deleted atomic note: ${highlight.atomicNotePath}`);
      }
      return;
    }

    // Handle inline mode: tombstone the highlight
    if (this.settings.inlineMode?.inlineHighlights) {
      console.log(`[ReaderVaultSync] Inline mode deletion not yet implemented for highlight ${highlightId}`);
    }
  }

  /**
   * Tombstone an inline highlight by adding :deleted marker
   */
  private async tombstoneInlineHighlight(file: TFile, highlightId: string): Promise<void> {
    const content = await this.app.vault.read(file);

    // Replace the highlight marker with tombstone marker
    // Example: `%% amnesia:hl-abc123 %%` → `%% amnesia:hl-abc123:deleted %%`
    const markerPattern = new RegExp(`(%%\\s*amnesia:${highlightId})\\s*%%`, 'g');
    const newContent = content.replace(markerPattern, '$1:deleted %%');

    if (newContent !== content) {
      await this.app.vault.modify(file, newContent);
      console.log(`[ReaderVaultSync] Tombstoned inline highlight ${highlightId} in ${file.path}`);
    }
  }

  // ==========================================================================
  // Vault → Reader Sync
  // ==========================================================================

  /**
   * Handle vault file change
   */
  private async handleVaultChange(event: VaultChangeEvent): Promise<void> {
    if (this.settings.highlightSyncMode === 'reader-to-vault') return;
    if (this.settings.highlightSyncMode === 'manual') return;

    const trigger: SyncTrigger = event.deleted ? 'vault-deleted' : 'vault-modified';

    // Debounce by file path
    this.pendingSync.set(event.file.path, trigger);

    // Process after debounce
    setTimeout(() => {
      if (this.pendingSync.has(event.file.path)) {
        this.pendingSync.delete(event.file.path);
        this.syncVaultChangeToReader(event, trigger);
      }
    }, this.settings.debounceDelay);
  }

  /**
   * Sync vault change to reader highlights
   */
  private async syncVaultChangeToReader(
    event: VaultChangeEvent,
    trigger: SyncTrigger
  ): Promise<SyncOperationResult> {
    const result: SyncOperationResult = {
      success: true,
      direction: 'vault-to-reader',
      trigger,
      itemsProcessed: 0,
      itemsSkipped: 0,
      conflicts: [],
      errors: [],
    };

    try {
      this.emit({ type: 'sync-start', data: { trigger } });

      if (event.deleted) {
        if (this.settings.preserveReaderHighlights) {
          console.log(`[ReaderVaultSync] Preserve mode: not deleting reader highlight`);
          result.itemsSkipped = 1;
        } else {
          await this.handleVaultDeletion(event);
          result.itemsProcessed = 1;
        }
      } else {
        await this.handleVaultModification(event, result);
      }
    } catch (error) {
      result.success = false;
      result.errors.push(error as Error);
      this.emit({ type: 'error', data: { error: error as Error } });
    }

    this.emit({ type: 'sync-complete', data: { result, trigger } });
    return result;
  }

  /**
   * Handle vault file deletion
   */
  private async handleVaultDeletion(event: VaultChangeEvent): Promise<void> {
    // Find highlights linked to this file
    const state = this.getHighlightState();

    for (const [bookId, highlights] of Object.entries(state.highlights)) {
      for (const highlight of highlights) {
        if (highlight.atomicNotePath === event.file.path) {
          // Delete from reader
          this.dispatchHighlightAction({
            type: 'REMOVE_HIGHLIGHT',
            payload: { bookId, highlightId: highlight.id },
          });
          console.log(`[ReaderVaultSync] Deleted reader highlight ${highlight.id} due to vault deletion`);
        }
      }
    }
  }

  /**
   * Handle vault file modification
   */
  private async handleVaultModification(
    event: VaultChangeEvent,
    result: SyncOperationResult
  ): Promise<void> {
    // Parse highlights from the file
    const parsedHighlights = event.parsedHighlights || [];

    if (parsedHighlights.length === 0) {
      result.itemsSkipped = 1;
      return;
    }

    const state = this.getHighlightState();

    console.log(`[ReaderVaultSync] Processing ${parsedHighlights.length} parsed highlights from vault`);

    // First pass: process tombstoned highlights (deletions) immediately
    // This prevents conflicts from blocking deletion processing
    for (const parsed of parsedHighlights) {
      if (!parsed.deleted) continue;

      // Find corresponding reader highlight
      let bookId: string | undefined;
      for (const [bId, highlights] of Object.entries(state.highlights)) {
        if (highlights.find((h) => h.id === parsed.id)) {
          bookId = bId;
          break;
        }
      }

      if (!bookId) {
        console.log(`[ReaderVaultSync] Tombstoned highlight ${parsed.id} not in reader - skipping`);
        result.itemsSkipped++;
        continue;
      }

      console.log(`[ReaderVaultSync] Detected tombstoned highlight ${parsed.id} - removing from reader`);
      this.dispatchHighlightAction({
        type: 'REMOVE_HIGHLIGHT',
        payload: { bookId, highlightId: parsed.id },
      });
      result.itemsProcessed++;
    }

    // Second pass: process updates and conflicts for non-deleted highlights
    for (const parsed of parsedHighlights) {
      if (parsed.deleted) continue; // Already processed above

      console.log(`[ReaderVaultSync] Parsed highlight: ${parsed.id}, deleted: ${parsed.deleted}`);

      // Find corresponding reader highlight
      let readerHighlight: Highlight | undefined;
      let bookId: string | undefined;

      for (const [bId, highlights] of Object.entries(state.highlights)) {
        const found = highlights.find((h) => h.id === parsed.id);
        if (found) {
          readerHighlight = found;
          bookId = bId;
          break;
        }
      }

      if (!readerHighlight || !bookId) {
        // New highlight from vault - would need book context
        console.log(`[ReaderVaultSync] Unknown highlight ${parsed.id} in vault - skipping`);
        result.itemsSkipped++;
        continue;
      }

      // Check for conflicts
      const conflict = this.detectConflict(readerHighlight, parsed);

      if (conflict) {
        result.conflicts.push(conflict);
        this.emit({ type: 'conflict-detected', data: { conflict } });

        // Resolve conflict
        const resolution = await this.conflictResolver.resolve(conflict);
        await this.applyResolution(resolution, readerHighlight, parsed, bookId);
      } else {
        // No conflict - apply vault changes to reader
        await this.applyVaultChangesToReader(readerHighlight, parsed, bookId);
      }

      result.itemsProcessed++;
    }
  }

  /**
   * Detect conflict between reader and vault versions
   */
  private detectConflict(
    readerHighlight: Highlight,
    vaultHighlight: ParsedHighlight
  ): SyncConflict | null {
    // Compare timestamps to detect concurrent modifications
    const readerUpdated = new Date(readerHighlight.updatedAt).getTime();
    const vaultUpdated = vaultHighlight.updatedAt
      ? new Date(vaultHighlight.updatedAt).getTime()
      : 0;

    // If vault was updated after reader AND content differs, it's a conflict
    const textDiffers = readerHighlight.text !== vaultHighlight.text;
    const annotationDiffers = readerHighlight.annotation !== vaultHighlight.annotation;

    if (textDiffers || annotationDiffers) {
      // Check if both sides have been modified since last sync
      // For now, any difference is treated as potential conflict
      return {
        id: `conflict-${readerHighlight.id}-${Date.now()}`,
        highlightId: readerHighlight.id,
        type: textDiffers ? 'text' : 'annotation',
        readerValue: textDiffers ? readerHighlight.text : readerHighlight.annotation,
        vaultValue: textDiffers ? vaultHighlight.text : vaultHighlight.annotation,
        readerTimestamp: readerHighlight.updatedAt,
        vaultTimestamp: vaultHighlight.updatedAt || new Date(),
      };
    }

    return null;
  }

  /**
   * Apply conflict resolution
   */
  private async applyResolution(
    resolution: ConflictResolution,
    readerHighlight: Highlight,
    vaultHighlight: ParsedHighlight,
    bookId: string
  ): Promise<void> {
    switch (resolution.choice) {
      case 'keep-reader':
        // Sync reader version back to vault
        await this.syncHighlightToVault(readerHighlight, 'highlight-updated');
        break;

      case 'keep-vault':
        // Apply vault version to reader
        await this.applyVaultChangesToReader(readerHighlight, vaultHighlight, bookId);
        break;

      case 'merge':
        if (resolution.mergedValue !== undefined) {
          // Apply merged value to both
          const updated: Highlight = {
            ...readerHighlight,
            [resolution.conflict.type === 'text' ? 'text' : 'annotation']: resolution.mergedValue,
            updatedAt: new Date(),
          };
          this.dispatchHighlightAction({ type: 'UPDATE_HIGHLIGHT', payload: updated });
          await this.syncHighlightToVault(updated, 'highlight-updated');
        }
        break;
    }
  }

  /**
   * Apply vault changes to reader highlight
   */
  private async applyVaultChangesToReader(
    readerHighlight: Highlight,
    vaultHighlight: ParsedHighlight,
    bookId: string
  ): Promise<void> {
    const updated: Highlight = {
      ...readerHighlight,
      annotation: vaultHighlight.annotation ?? readerHighlight.annotation,
      color: (vaultHighlight.color as HighlightColor) ?? readerHighlight.color,
      updatedAt: new Date(),
    };

    // Note: We don't update text from vault - text comes from the source document
    // Annotation/notes can be edited in vault and synced back

    this.dispatchHighlightAction({ type: 'UPDATE_HIGHLIGHT', payload: updated });
    console.log(`[ReaderVaultSync] Updated reader highlight ${readerHighlight.id} from vault`);
  }

  // ==========================================================================
  // Manual Sync
  // ==========================================================================

  /**
   * Trigger manual sync for a book
   */
  async syncBook(bookId: string): Promise<SyncOperationResult> {
    const result: SyncOperationResult = {
      success: true,
      direction: 'reader-to-vault',
      trigger: 'manual',
      itemsProcessed: 0,
      itemsSkipped: 0,
      conflicts: [],
      errors: [],
    };

    if (this.isSyncing) {
      result.success = false;
      result.errors.push(new Error('Sync already in progress'));
      return result;
    }

    this.isSyncing = true;

    try {
      this.emit({ type: 'sync-start', data: { trigger: 'manual' } });

      const state = this.getHighlightState();
      const highlights = state.highlights[bookId] || [];

      for (const highlight of highlights) {
        try {
          await this.syncHighlightToVault(highlight, 'manual');
          result.itemsProcessed++;
        } catch (error) {
          result.errors.push(error as Error);
        }
      }
    } finally {
      this.isSyncing = false;
      this.emit({ type: 'sync-complete', data: { result, trigger: 'manual' } });
    }

    return result;
  }

  /**
   * Trigger full bidirectional sync
   */
  async syncAll(): Promise<SyncOperationResult> {
    const result: SyncOperationResult = {
      success: true,
      direction: 'reader-to-vault',
      trigger: 'manual',
      itemsProcessed: 0,
      itemsSkipped: 0,
      conflicts: [],
      errors: [],
    };

    if (this.isSyncing) {
      result.success = false;
      result.errors.push(new Error('Sync already in progress'));
      return result;
    }

    this.isSyncing = true;

    try {
      this.emit({ type: 'sync-start', data: { trigger: 'manual' } });

      const state = this.getHighlightState();

      for (const [bookId, highlights] of Object.entries(state.highlights)) {
        for (const highlight of highlights) {
          try {
            await this.syncHighlightToVault(highlight, 'manual');
            result.itemsProcessed++;
          } catch (error) {
            result.errors.push(error as Error);
          }
        }
      }
    } finally {
      this.isSyncing = false;
      this.emit({ type: 'sync-complete', data: { result, trigger: 'manual' } });
    }

    return result;
  }

  // ==========================================================================
  // State Queries
  // ==========================================================================

  /**
   * Check if sync is in progress
   */
  isSyncInProgress(): boolean {
    return this.isSyncing;
  }

  /**
   * Get current sync settings
   */
  getSettings(): ReaderVaultSyncSettings {
    return { ...this.settings };
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a Reader ↔ Vault sync orchestrator
 */
export function createReaderVaultSync(
  app: App,
  settings: Partial<ReaderVaultSyncSettings>,
  getHighlightState: () => HighlightState,
  dispatchHighlightAction: (action: HighlightAction) => void
): ReaderVaultSyncOrchestrator {
  return new ReaderVaultSyncOrchestrator(
    app,
    { ...DEFAULT_READER_VAULT_SYNC_SETTINGS, ...settings },
    getHighlightState,
    dispatchHighlightAction
  );
}

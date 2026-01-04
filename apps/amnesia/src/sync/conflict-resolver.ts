/**
 * Conflict Resolver
 *
 * Handles conflicts between Reader and Vault versions of highlights/notes.
 * Provides UI for user choice when automatic resolution isn't possible.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import { App, Modal, Setting } from 'obsidian';

// ============================================================================
// Types
// ============================================================================

/**
 * Type of conflict
 */
export type ConflictType = 'text' | 'annotation' | 'color' | 'deletion';

/**
 * A sync conflict between reader and vault versions
 */
export interface SyncConflict {
  /** Unique conflict ID */
  id: string;
  /** ID of the highlight/note with conflict */
  highlightId: string;
  /** Type of conflict */
  type: ConflictType;
  /** Value from reader */
  readerValue: unknown;
  /** Value from vault */
  vaultValue: unknown;
  /** Reader modification timestamp */
  readerTimestamp: Date;
  /** Vault modification timestamp */
  vaultTimestamp: Date;
  /** Book title (for display) */
  bookTitle?: string;
}

/**
 * Resolution choice
 */
export type ResolutionChoice = 'keep-reader' | 'keep-vault' | 'merge' | 'skip';

/**
 * Resolution strategy
 */
export type ResolutionStrategy =
  | 'reader-wins'      // Always prefer reader version
  | 'vault-wins'       // Always prefer vault version
  | 'last-write-wins'  // Prefer most recently modified
  | 'ask-user';        // Show modal for each conflict

/**
 * Conflict resolution result
 */
export interface ConflictResolution {
  /** The conflict that was resolved */
  conflict: SyncConflict;
  /** Resolution choice */
  choice: ResolutionChoice;
  /** Merged value (if merge was chosen) */
  mergedValue?: unknown;
  /** Strategy that was applied */
  strategy: ResolutionStrategy;
  /** Whether resolution was automatic or manual */
  automatic: boolean;
}

/**
 * Resolver options
 */
export interface ConflictResolverOptions {
  /** Default resolution strategy */
  defaultStrategy: ResolutionStrategy;
  /** Show notification on auto-resolution */
  notifyOnAutoResolve: boolean;
}

/**
 * Default resolver options
 */
const DEFAULT_RESOLVER_OPTIONS: ConflictResolverOptions = {
  defaultStrategy: 'ask-user',
  notifyOnAutoResolve: false,
};

// ============================================================================
// Conflict Resolver
// ============================================================================

/**
 * Resolves conflicts between Reader and Vault versions
 */
export class ConflictResolver {
  private app: App;
  private options: ConflictResolverOptions;
  private pendingResolutions: Map<string, (resolution: ConflictResolution) => void> = new Map();

  constructor(app: App, options?: Partial<ConflictResolverOptions>) {
    this.app = app;
    this.options = { ...DEFAULT_RESOLVER_OPTIONS, ...options };
  }

  /**
   * Update resolver options
   */
  setOptions(options: Partial<ConflictResolverOptions>): void {
    this.options = { ...this.options, ...options };
  }

  // ==========================================================================
  // Resolution Methods
  // ==========================================================================

  /**
   * Resolve a conflict
   */
  async resolve(conflict: SyncConflict): Promise<ConflictResolution> {
    const strategy = this.options.defaultStrategy;

    switch (strategy) {
      case 'reader-wins':
        return this.autoResolve(conflict, 'keep-reader', strategy);

      case 'vault-wins':
        return this.autoResolve(conflict, 'keep-vault', strategy);

      case 'last-write-wins':
        return this.resolveByTimestamp(conflict);

      case 'ask-user':
      default:
        return this.askUser(conflict);
    }
  }

  /**
   * Auto-resolve with specified choice
   */
  private autoResolve(
    conflict: SyncConflict,
    choice: ResolutionChoice,
    strategy: ResolutionStrategy
  ): ConflictResolution {
    if (this.options.notifyOnAutoResolve) {
      console.log(
        `[ConflictResolver] Auto-resolved conflict for ${conflict.highlightId} using ${strategy}`
      );
    }

    return {
      conflict,
      choice,
      strategy,
      automatic: true,
    };
  }

  /**
   * Resolve by comparing timestamps
   */
  private resolveByTimestamp(conflict: SyncConflict): ConflictResolution {
    const readerTime = new Date(conflict.readerTimestamp).getTime();
    const vaultTime = new Date(conflict.vaultTimestamp).getTime();

    const choice: ResolutionChoice = readerTime >= vaultTime ? 'keep-reader' : 'keep-vault';

    return {
      conflict,
      choice,
      strategy: 'last-write-wins',
      automatic: true,
    };
  }

  /**
   * Ask user for resolution via modal
   */
  private askUser(conflict: SyncConflict): Promise<ConflictResolution> {
    return new Promise((resolve) => {
      const modal = new ConflictResolutionModal(
        this.app,
        conflict,
        (resolution) => {
          resolve(resolution);
        }
      );
      modal.open();
    });
  }

  // ==========================================================================
  // Batch Resolution
  // ==========================================================================

  /**
   * Resolve multiple conflicts
   */
  async resolveAll(
    conflicts: SyncConflict[],
    options?: { batchStrategy?: ResolutionStrategy }
  ): Promise<ConflictResolution[]> {
    const results: ConflictResolution[] = [];

    // If batch strategy provided, use it for all
    if (options?.batchStrategy && options.batchStrategy !== 'ask-user') {
      for (const conflict of conflicts) {
        const choice: ResolutionChoice =
          options.batchStrategy === 'reader-wins' ? 'keep-reader' :
          options.batchStrategy === 'vault-wins' ? 'keep-vault' :
          'keep-reader'; // last-write-wins fallback

        results.push(this.autoResolve(conflict, choice, options.batchStrategy));
      }
      return results;
    }

    // Otherwise, resolve each individually
    for (const conflict of conflicts) {
      results.push(await this.resolve(conflict));
    }

    return results;
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Check if values are different (conflict detection helper)
   */
  static valuesConflict(a: unknown, b: unknown): boolean {
    if (a === b) return false;
    if (a === undefined || a === null) return b !== undefined && b !== null;
    if (b === undefined || b === null) return true;
    if (typeof a !== typeof b) return true;

    if (typeof a === 'string') {
      // Normalize strings for comparison
      return a.trim() !== (b as string).trim();
    }

    return JSON.stringify(a) !== JSON.stringify(b);
  }

  /**
   * Get a human-readable description of a conflict
   */
  static describeConflict(conflict: SyncConflict): string {
    const typeDescriptions: Record<ConflictType, string> = {
      text: 'Highlight text was edited',
      annotation: 'Annotation was modified',
      color: 'Highlight color was changed',
      deletion: 'Item was deleted on one side',
    };

    return typeDescriptions[conflict.type] || 'Unknown conflict';
  }
}

// ============================================================================
// Conflict Resolution Modal
// ============================================================================

/**
 * Modal for user to resolve a conflict
 */
class ConflictResolutionModal extends Modal {
  private conflict: SyncConflict;
  private onResolve: (resolution: ConflictResolution) => void;

  constructor(
    app: App,
    conflict: SyncConflict,
    onResolve: (resolution: ConflictResolution) => void
  ) {
    super(app);
    this.conflict = conflict;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('amnesia-conflict-modal');

    // Title
    contentEl.createEl('h2', { text: 'Sync Conflict' });

    // Description
    contentEl.createEl('p', {
      text: ConflictResolver.describeConflict(this.conflict),
      cls: 'setting-item-description',
    });

    if (this.conflict.bookTitle) {
      contentEl.createEl('p', {
        text: `Book: ${this.conflict.bookTitle}`,
        cls: 'setting-item-description',
      });
    }

    // Comparison section
    const comparisonEl = contentEl.createDiv({ cls: 'amnesia-conflict-comparison' });

    // Reader version
    const readerSection = comparisonEl.createDiv({ cls: 'amnesia-conflict-section' });
    readerSection.createEl('h4', { text: 'Reader Version' });
    readerSection.createEl('p', {
      text: this.formatValue(this.conflict.readerValue),
      cls: 'amnesia-conflict-value',
    });
    readerSection.createEl('small', {
      text: `Modified: ${this.formatDate(this.conflict.readerTimestamp)}`,
    });

    // Vault version
    const vaultSection = comparisonEl.createDiv({ cls: 'amnesia-conflict-section' });
    vaultSection.createEl('h4', { text: 'Vault Version' });
    vaultSection.createEl('p', {
      text: this.formatValue(this.conflict.vaultValue),
      cls: 'amnesia-conflict-value',
    });
    vaultSection.createEl('small', {
      text: `Modified: ${this.formatDate(this.conflict.vaultTimestamp)}`,
    });

    // Actions
    const actionsEl = contentEl.createDiv({ cls: 'amnesia-conflict-actions' });

    new Setting(actionsEl)
      .addButton((btn) =>
        btn
          .setButtonText('Keep Reader')
          .setCta()
          .onClick(() => this.resolveWith('keep-reader'))
      )
      .addButton((btn) =>
        btn
          .setButtonText('Keep Vault')
          .onClick(() => this.resolveWith('keep-vault'))
      )
      .addButton((btn) =>
        btn
          .setButtonText('Skip')
          .onClick(() => this.resolveWith('skip'))
      );

    // Add styles
    this.addStyles();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private resolveWith(choice: ResolutionChoice): void {
    this.onResolve({
      conflict: this.conflict,
      choice,
      strategy: 'ask-user',
      automatic: false,
    });
    this.close();
  }

  private formatValue(value: unknown): string {
    if (value === undefined || value === null) {
      return '(empty)';
    }
    if (typeof value === 'string') {
      return value.length > 200 ? value.slice(0, 200) + '...' : value;
    }
    return String(value);
  }

  private formatDate(date: Date): string {
    return new Date(date).toLocaleString();
  }

  private addStyles(): void {
    const styleEl = this.contentEl.createEl('style');
    styleEl.textContent = `
      .amnesia-conflict-modal {
        padding: 20px;
      }
      .amnesia-conflict-comparison {
        display: flex;
        gap: 20px;
        margin: 20px 0;
      }
      .amnesia-conflict-section {
        flex: 1;
        padding: 15px;
        background: var(--background-secondary);
        border-radius: 8px;
      }
      .amnesia-conflict-section h4 {
        margin-top: 0;
        margin-bottom: 10px;
      }
      .amnesia-conflict-value {
        font-family: var(--font-monospace);
        font-size: 0.9em;
        padding: 10px;
        background: var(--background-primary);
        border-radius: 4px;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 150px;
        overflow-y: auto;
      }
      .amnesia-conflict-actions {
        margin-top: 20px;
        display: flex;
        justify-content: flex-end;
      }
      .amnesia-conflict-actions .setting-item {
        border: none;
        padding: 0;
      }
    `;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a conflict resolver instance
 */
export function createConflictResolver(
  app: App,
  options?: Partial<ConflictResolverOptions>
): ConflictResolver {
  return new ConflictResolver(app, options);
}

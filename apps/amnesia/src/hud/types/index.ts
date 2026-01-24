/**
 * Amnesia HUD Type Definitions
 *
 * Core types for the Heads-Up Display system.
 */

import type { SvelteComponent } from 'svelte';

// =============================================================================
// Tab Types
// =============================================================================

export type TabName = 'reading' | 'library' | 'stats' | 'server' | 'series';

export interface HUDTab {
  id: TabName;
  label: string;
  icon?: string;
  badge?: number | string;
  component: typeof SvelteComponent;
}

// =============================================================================
// Detail View Types
// =============================================================================

export type DetailViewState =
  | { type: 'book'; id: string; title?: string; bookId?: string }
  | { type: 'highlights'; id: string; title?: string; bookId?: string; filter?: HighlightFilter }
  | { type: 'series'; id: string; title?: string; seriesName?: string }
  | { type: 'author'; id: string; title?: string; authorName?: string }
  | { type: 'server-logs'; id?: string; title?: string };

export interface HighlightFilter {
  color?: string;
  hasAnnotation?: boolean;
  chapter?: string;
}

// =============================================================================
// HUD State
// =============================================================================

export interface AmnesiaHUDState {
  isOpen: boolean;
  isPinned: boolean;
  activeTab: TabName;
  detailView: DetailViewState | null;
  viewHistory: DetailViewState[];
  position: { x: number; y: number } | null;
}

export const initialHUDState: AmnesiaHUDState = {
  isOpen: false,
  isPinned: false,
  activeTab: 'reading',
  detailView: null,
  viewHistory: [],
  position: null,
};

// =============================================================================
// HUD Actions
// =============================================================================

export type AmnesiaHUDAction =
  | { type: 'TOGGLE_HUD' }
  | { type: 'OPEN_HUD' }
  | { type: 'CLOSE_HUD' }
  | { type: 'PIN_HUD'; payload: boolean }
  | { type: 'SET_ACTIVE_TAB'; payload: TabName }
  | { type: 'PUSH_DETAIL_VIEW'; payload: DetailViewState }
  | { type: 'POP_DETAIL_VIEW' }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'SET_POSITION'; payload: { x: number; y: number } | null }
  | { type: 'RESTORE_STATE'; payload: Partial<AmnesiaHUDState> };

// =============================================================================
// Status Bar Types
// =============================================================================

import type { Readable } from 'svelte/store';

export type StatusBarColor = 'green' | 'yellow' | 'red' | 'gray' | 'blue';

/**
 * Simple status bar content (used internally by Amnesia standalone HUD)
 */
export interface StatusBarContent {
  icon: string;
  text?: string;
  color?: StatusBarColor;
  badge?: number;
  tooltip?: string;
  serverStatus?: {
    indicator: string;
    color: StatusBarColor;
  };
}

/**
 * Doc Doctor-compatible status bar content (uses Svelte stores for reactivity)
 * Required for Doc Doctor's dynamic status bar to work.
 */
export interface DocDoctorStatusBarContent {
  /** Primary text (e.g., "4 Projects" or "| 17 hl") - shown after titleText if provided */
  primaryText: Readable<string>;

  /** Health/status indicator color */
  indicatorColor: Readable<'green' | 'yellow' | 'red' | 'blue' | 'muted'>;

  /** Secondary badge (e.g., "3 at-risk" or "45% complete") */
  secondaryBadge?: Readable<{ text: string; variant: 'warning' | 'info' | 'success' } | null>;

  /** Tooltip text on hover */
  tooltip: Readable<string>;

  /** File format badge (e.g., "PDF", "EPUB") - styled like Obsidian's .nav-file-tag */
  formatBadge?: Readable<string | null>;

  /** Title text for ticker animation (e.g., book title) - scrolls on hover, Amnesia only */
  titleText?: Readable<string | null>;
}

// =============================================================================
// Doc Doctor HUD Context (for registry integration)
// =============================================================================

/**
 * Context passed to providers for activation decisions.
 * Compatible with Doc Doctor's HUDContext interface.
 *
 * Note: This is different from Amnesia's internal HUDContext (in context-detector.ts)
 * which tracks book/highlight/author/series context for display purposes.
 */
export interface DocDoctorHUDContext {
  /** Currently active file path (if any) */
  activeFile: string | null;

  /** File extension of active file */
  fileExtension: string | null;

  /** Current workspace leaf type */
  leafType: string;

  /** Custom metadata from other plugins */
  metadata: Record<string, unknown>;
}

// =============================================================================
// Cross-Plugin Component Mounting (Renderer Pattern)
// =============================================================================

/**
 * Handle returned by a provider's mount() function.
 * Allows the host (Doc Doctor) to control the lifecycle of a cross-plugin component.
 *
 * This pattern enables component sharing across independently bundled plugins
 * by delegating instantiation to the provider's Svelte runtime.
 */
export interface ComponentHandle {
  /**
   * Update the mounted component's props.
   * Called when the host needs to pass new data to the component.
   */
  update(props: Record<string, any>): void;

  /**
   * Destroy the mounted component.
   * MUST be called when switching tabs or closing the HUD to prevent memory leaks.
   */
  destroy(): void;
}

/**
 * Function signature for mounting cross-plugin components.
 *
 * @param target - DOM element to mount the component into
 * @param props - Initial props to pass to the component (includes tabId)
 * @returns Handle for lifecycle control
 */
export type MountFunction = (
  target: HTMLElement,
  props: Record<string, any>
) => ComponentHandle;

// =============================================================================
// Provider Interface
// =============================================================================

export interface HUDContentProvider {
  /** Unique identifier: "{plugin-id}-{content-type}" */
  readonly id: string;

  /** Display name shown in UI */
  readonly displayName: string;

  /** Icon identifier (Obsidian icon name) */
  readonly icon: string;

  /** Priority for ordering (higher = earlier) */
  readonly priority: number;

  /**
   * Determines if this provider should be active for the given context.
   * Used by Doc Doctor registry to decide which provider to show.
   */
  isActiveForContext(context: DocDoctorHUDContext): boolean;

  /** Get tabs for compact view */
  getTabs(): HUDTab[];

  /**
   * Mount a tab's content into a container element.
   *
   * This is the PREFERRED method for cross-plugin component rendering.
   * The provider instantiates its own Svelte component using its bundled runtime,
   * avoiding runtime conflicts between independently bundled plugins.
   *
   * @param target - DOM element to mount into
   * @param props - Props including `tabId` to determine which tab to render
   * @returns ComponentHandle for lifecycle control
   */
  mount?: MountFunction;

  /**
   * Get status bar content (Doc Doctor compatible - uses Svelte stores).
   * This is the primary interface for Doc Doctor's dynamic status bar.
   */
  getStatusBarContent(): DocDoctorStatusBarContent;

  /**
   * Get legacy status bar content (plain values).
   * Used by Amnesia's standalone HUD when Doc Doctor is not available.
   */
  getLegacyStatusBarContent?(): StatusBarContent;

  /** Lifecycle: called when provider becomes active */
  onActivate?(): void;

  /** Lifecycle: called when provider becomes inactive */
  onDeactivate?(): void;

  /** Subscribe to provider updates */
  subscribe(callback: () => void): () => void;

  /** Cleanup resources */
  destroy(): void;
}

// =============================================================================
// Server Status Types (from ServerManager)
// =============================================================================

export type ServerStatusType =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'
  | 'restarting';

export interface ServerStatusInfo {
  status: ServerStatusType;
  indicator: string;
  color: StatusBarColor;
  port?: number;
  uptime?: number;
  lastError?: string;
}

// =============================================================================
// Reading Stats Types
// =============================================================================

export interface ReadingStats {
  currentlyReading: number;
  totalBooks: number;
  completedBooks: number;
  toReadBooks: number;
  totalHighlights: number;
  highlightsByColor: Record<string, number>;
  recentActivity: number[]; // Last 7 days activity counts
  lastReadDate: Date | null;
}

export interface SeriesInfo {
  name: string;
  author?: string;
  totalBooks: number;
  ownedBooks: number;
  readBooks: number;
  currentBook?: string;
  progress: number; // 0-100
}

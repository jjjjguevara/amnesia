/**
 * Navigator Interface
 *
 * Unified interface for paginated and scrolled navigation modes.
 * Implements the Readium Locator model for position tracking.
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

import type { ThemeColors } from '../renderer/types';

// ============================================================================
// Locator Model (Readium-compatible)
// ============================================================================

/**
 * Position within a document
 * Based on the Readium Locator Model for robust position tracking
 */
export interface Locator {
  /** Spine item href (e.g., "chapter1.xhtml") */
  href: string;

  /** Position information */
  locations: {
    /** Progress within the current resource (0.0 - 1.0) */
    progression: number;

    /** EPUB Canonical Fragment Identifier */
    cfi?: string;

    /** Total progression through entire book (0.0 - 1.0) */
    totalProgression?: number;

    /** Position index (e.g., page number or spine index) */
    position?: number;

    /** Fragment identifier (anchor) */
    fragment?: string;
  };

  /** Text context for fuzzy anchoring */
  text?: {
    /** Text before the position */
    before?: string;

    /** Highlighted/selected text */
    highlight?: string;

    /** Text after the position */
    after?: string;
  };

  /** Display title (e.g., chapter name) */
  title?: string;
}

/**
 * Navigation target options
 */
export type NavigationTarget =
  | { type: 'locator'; locator: Locator }
  | { type: 'href'; href: string; fragment?: string }
  | { type: 'cfi'; cfi: string }
  | { type: 'progression'; progression: number }
  | { type: 'position'; position: number };

/**
 * Navigation options
 */
export interface NavigationOptions {
  /** Skip animation for instant navigation */
  instant?: boolean;

  /** Direction hint for animation */
  direction?: 'forward' | 'backward';

  /** Don't update history */
  skipHistory?: boolean;
}

// ============================================================================
// Navigator Configuration
// ============================================================================

/**
 * Navigator display configuration
 */
export interface NavigatorConfig {
  /** Display mode */
  mode: 'paginated' | 'scrolled';

  /** Column layout for paginated mode */
  columns: 'single' | 'dual' | 'auto';

  /** Font size in pixels */
  fontSize: number;

  /** Font family */
  fontFamily: string;

  /** Line height multiplier */
  lineHeight: number;

  /** Text alignment */
  textAlign: 'left' | 'justify' | 'right';

  /** Margin around content in pixels */
  margin: number;

  /** Gap between columns in pixels */
  columnGap: number;

  /** Theme colors */
  theme: ThemeColors;

  /** Scroll speed multiplier for scrolled mode */
  scrollSpeed?: number;

  /** Enable momentum scrolling */
  momentumScrolling?: boolean;

  /** Snap to page boundaries in paginated mode */
  pageSnap?: boolean;
}

// ============================================================================
// Navigator Events
// ============================================================================

/**
 * Events emitted by navigators
 */
export interface NavigatorEvents {
  /** Position changed */
  relocated: Locator;

  /** Content rendered */
  rendered: { spineIndex: number };

  /** Loading state changed */
  loading: boolean;

  /** Error occurred */
  error: Error;

  /** Page turn animation started */
  pageAnimationStart: { direction: 'forward' | 'backward' };

  /** Page turn animation ended */
  pageAnimationEnd: { direction: 'forward' | 'backward' };

  /** Scroll position changed (scrolled mode) */
  scroll: { scrollTop: number; scrollHeight: number };

  /** Viewport resized */
  resize: { width: number; height: number };

  /** Chapter visibility changed */
  chapterVisible: { spineIndex: number; visible: boolean };
}

export type NavigatorEventListener<K extends keyof NavigatorEvents> = (
  data: NavigatorEvents[K]
) => void;

// ============================================================================
// Pagination Info
// ============================================================================

/**
 * Pagination information for display
 */
export interface PaginationInfo {
  /** Current page (1-indexed) */
  currentPage: number;

  /** Total pages in current chapter/spread */
  totalPages: number;

  /** Current spine index (0-indexed) */
  spineIndex: number;

  /** Total spine items */
  totalSpineItems: number;

  /** Overall book progression (0.0 - 1.0) */
  bookProgression: number;

  /** Chapter title if available */
  chapterTitle?: string;
}

// ============================================================================
// Navigator Interface
// ============================================================================

/**
 * Navigator interface
 *
 * Handles content display and navigation for a specific mode.
 * Both PaginatedNavigator and ScrolledNavigator implement this interface.
 */
export interface Navigator {
  // --------------------------------
  // Properties
  // --------------------------------

  /** Current display mode */
  readonly mode: 'paginated' | 'scrolled';

  /** Whether the navigator is ready */
  readonly isReady: boolean;

  // --------------------------------
  // Lifecycle Methods
  // --------------------------------

  /**
   * Initialize the navigator with content
   * @param container - Shadow DOM content container
   * @param config - Navigator configuration
   */
  initialize(container: HTMLElement, config: NavigatorConfig): Promise<void>;

  /**
   * Load spine content
   * @param spineItems - Array of spine item hrefs
   * @param initialLocator - Optional initial position
   * @param cachedElements - Optional pre-parsed chapter elements for faster mode switching
   */
  loadContent(
    spineItems: SpineItemContent[],
    initialLocator?: Locator,
    cachedElements?: Map<number, HTMLElement>
  ): Promise<void>;

  /**
   * Destroy the navigator and clean up resources
   */
  destroy(): void;

  // --------------------------------
  // Navigation Methods
  // --------------------------------

  /**
   * Navigate to a specific location
   * @param target - Navigation target
   * @param options - Navigation options
   */
  goTo(target: NavigationTarget, options?: NavigationOptions): Promise<boolean>;

  /**
   * Navigate forward (next page or scroll distance)
   */
  next(): Promise<boolean>;

  /**
   * Navigate backward (previous page or scroll distance)
   */
  prev(): Promise<boolean>;

  /**
   * Navigate to next chapter
   */
  nextChapter(): Promise<boolean>;

  /**
   * Navigate to previous chapter
   */
  prevChapter(): Promise<boolean>;

  // --------------------------------
  // Position Methods
  // --------------------------------

  /**
   * Get current location as a Locator
   */
  getCurrentLocation(): Locator | null;

  /**
   * Get current pagination info for display
   */
  getPaginationInfo(): PaginationInfo | null;

  /**
   * Check if a locator is currently visible
   */
  isLocatorVisible(locator: Locator): boolean;

  // --------------------------------
  // Configuration Methods
  // --------------------------------

  /**
   * Update navigator configuration
   * @param config - Partial configuration to update
   */
  updateConfig(config: Partial<NavigatorConfig>): void;

  /**
   * Get current configuration
   */
  getConfig(): NavigatorConfig;

  // --------------------------------
  // Content Methods
  // --------------------------------

  /**
   * Get the DOM range for a CFI
   * @param cfi - EPUB CFI string
   */
  getCfiRange(cfi: string): Range | null;

  /**
   * Generate CFI for a DOM range
   * @param range - DOM Range
   */
  getRangeCfi(range: Range): string | null;

  /**
   * Get visible text content
   */
  getVisibleText(): string;

  /**
   * Get the content container element
   */
  getContentContainer(): HTMLElement;

  // --------------------------------
  // Event Methods
  // --------------------------------

  /**
   * Subscribe to navigator events
   * @param event - Event name
   * @param callback - Event handler
   * @returns Unsubscribe function
   */
  on<K extends keyof NavigatorEvents>(
    event: K,
    callback: NavigatorEventListener<K>
  ): () => void;

  /**
   * Unsubscribe from navigator events
   * @param event - Event name
   * @param callback - Event handler
   */
  off<K extends keyof NavigatorEvents>(
    event: K,
    callback: NavigatorEventListener<K>
  ): void;

  // --------------------------------
  // Layout Methods
  // --------------------------------

  /**
   * Recalculate layout (e.g., after resize)
   */
  reflow(): Promise<void>;

  /**
   * Get the current column width (paginated mode)
   */
  getColumnWidth(): number;

  /**
   * Get viewport dimensions
   */
  getViewportDimensions(): { width: number; height: number };
}

// ============================================================================
// Spine Content
// ============================================================================

/**
 * Content for a spine item
 */
export interface SpineItemContent {
  /** Spine index */
  index: number;

  /** Spine item href */
  href: string;

  /** HTML content */
  html: string;

  /** Book CSS to apply */
  css?: string;

  /** Linear (should be included in reading order) */
  linear: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create an empty locator for a spine href
 */
export function createLocator(href: string, spineIndex?: number): Locator {
  return {
    href,
    locations: {
      progression: 0,
      position: spineIndex,
    },
  };
}

/**
 * Check if two locators reference the same position
 */
export function locatorsEqual(a: Locator, b: Locator): boolean {
  // Same href and close progression
  if (a.href !== b.href) return false;

  const progressionDiff = Math.abs(
    (a.locations.progression ?? 0) - (b.locations.progression ?? 0)
  );

  return progressionDiff < 0.001;
}

/**
 * Merge locator with partial updates
 */
export function mergeLocator(base: Locator, updates: Partial<Locator>): Locator {
  return {
    ...base,
    ...updates,
    locations: {
      ...base.locations,
      ...updates.locations,
    },
    text: updates.text ?? base.text,
  };
}

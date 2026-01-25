/**
 * Page Analytics Service
 *
 * Tracks user engagement patterns with PDF pages to inform rendering decisions.
 * This data enables:
 * - Overlay canvas lifecycle management (keep-alive for frequently visited pages)
 * - Prefetch priority prediction (predict next page based on patterns)
 * - Render quality decisions (higher quality for long-dwelling pages)
 *
 * Related issues:
 * - amnesia-aqv: Overlay canvas lifecycle depends on page dwell time
 * - amnesia-3wf: Full implementation of engagement tracking
 *
 * Current state: STUB - Basic interface for Phase 1 integration
 * Full implementation deferred to amnesia-3wf
 */

// ============================================================
// Types
// ============================================================

/**
 * Page engagement metrics
 */
export interface PageEngagement {
  /** Page number (1-indexed) */
  pageNum: number;
  /** Total time spent viewing this page (ms) */
  totalDwellTimeMs: number;
  /** Number of times page has been visited */
  visitCount: number;
  /** Last visit timestamp */
  lastVisitTimestamp: number;
  /** Average dwell time per visit (ms) */
  avgDwellTimeMs: number;
  /** Whether user has created annotations on this page */
  hasAnnotations: boolean;
}

/**
 * Navigation event types
 */
export type NavigationType = 
  | 'scroll'      // Natural scroll navigation
  | 'jump'        // Direct jump (TOC, link, page number)
  | 'search'      // Search result navigation
  | 'annotation'; // Annotation/highlight click

/**
 * Page navigation event
 */
export interface NavigationEvent {
  timestamp: number;
  fromPage: number;
  toPage: number;
  type: NavigationType;
}

/**
 * Reading session summary
 */
export interface ReadingSession {
  startTimestamp: number;
  endTimestamp: number | null;
  pagesViewed: Set<number>;
  totalDwellTimeMs: number;
  navigationEvents: NavigationEvent[];
}

/**
 * Prefetch recommendation based on engagement patterns
 */
export interface PrefetchRecommendation {
  /** Pages recommended for prefetch, in priority order */
  pages: number[];
  /** Confidence score (0-1) */
  confidence: number;
  /** Reason for recommendation */
  reason: string;
}

/**
 * Overlay lifecycle recommendation
 */
export interface OverlayLifecycleHint {
  /** Whether to keep overlay canvas alive after mode transition */
  keepAlive: boolean;
  /** Recommended TTL in ms (0 = immediate cleanup) */
  ttlMs: number;
  /** Reason for recommendation */
  reason: string;
}

// ============================================================
// Constants
// ============================================================

/**
 * Dwell time thresholds for engagement classification
 */
export const DWELL_THRESHOLDS = {
  /** Minimum dwell time to count as a "view" (ms) */
  MIN_VIEW_MS: 500,
  /** Threshold for "high engagement" page (ms) */
  HIGH_ENGAGEMENT_MS: 5000,
  /** Threshold for "very high engagement" page (ms) */
  VERY_HIGH_ENGAGEMENT_MS: 15000,
} as const;

/**
 * Default overlay lifecycle settings
 */
export const OVERLAY_LIFECYCLE_DEFAULTS = {
  /** Default TTL for overlay canvas (ms) */
  DEFAULT_TTL_MS: 5000,
  /** TTL for high-engagement pages (ms) */
  HIGH_ENGAGEMENT_TTL_MS: 30000,
  /** Max overlays to keep alive */
  MAX_KEEP_ALIVE: 3,
} as const;

// ============================================================
// Service Interface
// ============================================================

/**
 * Page Analytics Service interface
 *
 * Implementations can range from a simple stub to a full ML-based
 * prediction system with persistent storage.
 */
export interface IPageAnalyticsService {
  // ─────────────────────────────────────────────────────────────
  // Event Recording
  // ─────────────────────────────────────────────────────────────

  /**
   * Record page entry (user navigated to this page)
   */
  recordPageEntry(pageNum: number): void;

  /**
   * Record page exit (user navigated away from this page)
   */
  recordPageExit(pageNum: number): void;

  /**
   * Record a navigation event
   */
  recordNavigation(event: NavigationEvent): void;

  /**
   * Record that user created an annotation on a page
   */
  recordAnnotation(pageNum: number): void;

  // ─────────────────────────────────────────────────────────────
  // Engagement Queries
  // ─────────────────────────────────────────────────────────────

  /**
   * Get engagement metrics for a specific page
   */
  getPageEngagement(pageNum: number): PageEngagement | null;

  /**
   * Get all pages with engagement data
   */
  getAllEngagement(): Map<number, PageEngagement>;

  /**
   * Check if a page is considered "high engagement"
   */
  isHighEngagement(pageNum: number): boolean;

  // ─────────────────────────────────────────────────────────────
  // Recommendations
  // ─────────────────────────────────────────────────────────────

  /**
   * Get prefetch recommendations based on current page and history
   */
  getPrefetchRecommendation(currentPage: number): PrefetchRecommendation;

  /**
   * Get overlay lifecycle hint for a page
   * Used to decide whether to keep overlay canvas alive after mode transition
   */
  getOverlayLifecycleHint(pageNum: number): OverlayLifecycleHint;

  // ─────────────────────────────────────────────────────────────
  // Session Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Start a new reading session
   */
  startSession(): void;

  /**
   * End current reading session
   */
  endSession(): void;

  /**
   * Get current session summary
   */
  getCurrentSession(): ReadingSession | null;

  /**
   * Clear all analytics data
   */
  clear(): void;
}

// ============================================================
// Stub Implementation
// ============================================================

/**
 * Stub implementation of PageAnalyticsService
 *
 * Provides sensible defaults without actual tracking.
 * Used for Phase 1 integration until full implementation (amnesia-3wf).
 */
class PageAnalyticsServiceStub implements IPageAnalyticsService {
  private currentPage: number | null = null;
  private pageEntryTime: number | null = null;
  private engagement: Map<number, PageEngagement> = new Map();
  private currentSession: ReadingSession | null = null;

  // ─────────────────────────────────────────────────────────────
  // Event Recording
  // ─────────────────────────────────────────────────────────────

  recordPageEntry(pageNum: number): void {
    // Exit previous page if any
    if (this.currentPage !== null && this.currentPage !== pageNum) {
      this.recordPageExit(this.currentPage);
    }

    this.currentPage = pageNum;
    this.pageEntryTime = performance.now();

    // Update session
    if (this.currentSession) {
      this.currentSession.pagesViewed.add(pageNum);
    }

    // Initialize engagement if needed
    if (!this.engagement.has(pageNum)) {
      this.engagement.set(pageNum, {
        pageNum,
        totalDwellTimeMs: 0,
        visitCount: 0,
        lastVisitTimestamp: Date.now(),
        avgDwellTimeMs: 0,
        hasAnnotations: false,
      });
    }

    const engagement = this.engagement.get(pageNum)!;
    engagement.visitCount++;
    engagement.lastVisitTimestamp = Date.now();
  }

  recordPageExit(pageNum: number): void {
    if (this.currentPage !== pageNum || this.pageEntryTime === null) {
      return;
    }

    const dwellTime = performance.now() - this.pageEntryTime;

    // Only count as view if above minimum threshold
    if (dwellTime >= DWELL_THRESHOLDS.MIN_VIEW_MS) {
      const engagement = this.engagement.get(pageNum);
      if (engagement) {
        engagement.totalDwellTimeMs += dwellTime;
        engagement.avgDwellTimeMs = engagement.totalDwellTimeMs / engagement.visitCount;
      }

      // Update session
      if (this.currentSession) {
        this.currentSession.totalDwellTimeMs += dwellTime;
      }
    }

    this.currentPage = null;
    this.pageEntryTime = null;
  }

  recordNavigation(event: NavigationEvent): void {
    if (this.currentSession) {
      this.currentSession.navigationEvents.push(event);
    }
  }

  recordAnnotation(pageNum: number): void {
    const engagement = this.engagement.get(pageNum);
    if (engagement) {
      engagement.hasAnnotations = true;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Engagement Queries
  // ─────────────────────────────────────────────────────────────

  getPageEngagement(pageNum: number): PageEngagement | null {
    return this.engagement.get(pageNum) ?? null;
  }

  getAllEngagement(): Map<number, PageEngagement> {
    return new Map(this.engagement);
  }

  isHighEngagement(pageNum: number): boolean {
    const engagement = this.engagement.get(pageNum);
    if (!engagement) return false;
    return engagement.totalDwellTimeMs >= DWELL_THRESHOLDS.HIGH_ENGAGEMENT_MS;
  }

  // ─────────────────────────────────────────────────────────────
  // Recommendations
  // ─────────────────────────────────────────────────────────────

  getPrefetchRecommendation(currentPage: number): PrefetchRecommendation {
    // Stub: Simple linear prediction (next 2 pages)
    return {
      pages: [currentPage + 1, currentPage + 2],
      confidence: 0.6,
      reason: 'Stub: Linear prediction (next 2 pages)',
    };
  }

  getOverlayLifecycleHint(pageNum: number): OverlayLifecycleHint {
    const engagement = this.engagement.get(pageNum);

    // Default: short-lived overlay
    if (!engagement) {
      return {
        keepAlive: false,
        ttlMs: OVERLAY_LIFECYCLE_DEFAULTS.DEFAULT_TTL_MS,
        reason: 'No engagement data - using default TTL',
      };
    }

    // High engagement: keep alive longer
    if (engagement.totalDwellTimeMs >= DWELL_THRESHOLDS.VERY_HIGH_ENGAGEMENT_MS) {
      return {
        keepAlive: true,
        ttlMs: OVERLAY_LIFECYCLE_DEFAULTS.HIGH_ENGAGEMENT_TTL_MS,
        reason: `Very high engagement (${(engagement.totalDwellTimeMs / 1000).toFixed(1)}s dwell time)`,
      };
    }

    if (engagement.totalDwellTimeMs >= DWELL_THRESHOLDS.HIGH_ENGAGEMENT_MS) {
      return {
        keepAlive: true,
        ttlMs: OVERLAY_LIFECYCLE_DEFAULTS.DEFAULT_TTL_MS * 2,
        reason: `High engagement (${(engagement.totalDwellTimeMs / 1000).toFixed(1)}s dwell time)`,
      };
    }

    // Has annotations: keep alive
    if (engagement.hasAnnotations) {
      return {
        keepAlive: true,
        ttlMs: OVERLAY_LIFECYCLE_DEFAULTS.HIGH_ENGAGEMENT_TTL_MS,
        reason: 'Page has user annotations',
      };
    }

    // Default
    return {
      keepAlive: false,
      ttlMs: OVERLAY_LIFECYCLE_DEFAULTS.DEFAULT_TTL_MS,
      reason: 'Standard engagement - using default TTL',
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Session Management
  // ─────────────────────────────────────────────────────────────

  startSession(): void {
    // End previous session if any
    if (this.currentSession) {
      this.endSession();
    }

    this.currentSession = {
      startTimestamp: Date.now(),
      endTimestamp: null,
      pagesViewed: new Set(),
      totalDwellTimeMs: 0,
      navigationEvents: [],
    };
  }

  endSession(): void {
    // Exit current page
    if (this.currentPage !== null) {
      this.recordPageExit(this.currentPage);
    }

    if (this.currentSession) {
      this.currentSession.endTimestamp = Date.now();
    }

    this.currentSession = null;
  }

  getCurrentSession(): ReadingSession | null {
    return this.currentSession;
  }

  clear(): void {
    this.engagement.clear();
    this.currentPage = null;
    this.pageEntryTime = null;
    this.currentSession = null;
  }
}

// ============================================================
// Singleton Instance
// ============================================================

let instance: IPageAnalyticsService | null = null;

/**
 * Get the Page Analytics Service instance
 *
 * Returns stub implementation for now; will be replaced with
 * full implementation in amnesia-3wf.
 */
export function getPageAnalyticsService(): IPageAnalyticsService {
  if (!instance) {
    instance = new PageAnalyticsServiceStub();
    console.log('[PageAnalytics] Service initialized (stub implementation)');
  }
  return instance;
}

/**
 * Reset the service instance (for testing)
 */
export function resetPageAnalyticsService(): void {
  if (instance) {
    instance.clear();
  }
  instance = null;
}

// ============================================================
// Window Exposure (for debugging)
// ============================================================

if (typeof window !== 'undefined') {
  (window as any).pageAnalytics = {
    get: getPageAnalyticsService,
    reset: resetPageAnalyticsService,
  };
}

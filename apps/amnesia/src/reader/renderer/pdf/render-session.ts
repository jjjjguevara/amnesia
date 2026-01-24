/**
 * Render Session Manager
 *
 * Manages render sessions to enable selective abort of stale requests.
 * Each session represents a batch of render requests triggered by a single user action
 * (scroll, zoom, resize, or initial load).
 *
 * Sessions are numbered monotonically and used to determine which pending requests
 * are "stale" (from old sessions that the user has scrolled/zoomed past).
 *
 * This solves the abort tradeoff:
 * - WITH blanket abort: Cache is destroyed every 32ms, ~40% hit rate
 * - WITHOUT abort: Queue saturates with 100+ stale requests, 400ms+ wait
 * - WITH selective abort: Keep recent sessions (high hit rate), abort old (no saturation)
 */

export interface CameraSnapshot {
  x: number;
  y: number;
  z: number;
}

export interface RenderSession {
  readonly sessionId: number;
  readonly timestamp: number;
  readonly camera: CameraSnapshot;
  readonly documentId: string;
  readonly triggerType: 'scroll' | 'zoom' | 'resize' | 'initial';
}

export class RenderSessionManager {
  // Use modulo to prevent unbounded growth (10000 sessions = ~5 min at 32ms interval)
  private static readonly MAX_SESSION_ID = 10000;
  private sessionCounter = 0;
  private currentSession: RenderSession | null = null;

  /**
   * Create a new render session with the current camera state.
   * Call this at the start of each render cycle (scroll, zoom, etc.)
   */
  createSession(
    camera: CameraSnapshot,
    documentId: string,
    trigger: 'scroll' | 'zoom' | 'resize' | 'initial'
  ): RenderSession {
    // Use modulo to prevent unbounded counter growth
    this.sessionCounter = (this.sessionCounter + 1) % RenderSessionManager.MAX_SESSION_ID;
    this.currentSession = {
      sessionId: this.sessionCounter,
      timestamp: performance.now(),
      camera: { ...camera }, // Freeze camera state
      documentId,
      triggerType: trigger,
    };
    return this.currentSession;
  }

  /**
   * Get the current session ID (monotonic counter).
   * Used to determine stale session threshold.
   */
  getCurrentSessionId(): number {
    return this.sessionCounter;
  }

  /**
   * Get the current session object.
   */
  getCurrentSession(): RenderSession | null {
    return this.currentSession;
  }

  /**
   * Reset session tracking (e.g., on document change).
   */
  reset(): void {
    this.sessionCounter = 0;
    this.currentSession = null;
  }
}

// Singleton instance for shared access
let sessionManagerInstance: RenderSessionManager | null = null;

export function getRenderSessionManager(): RenderSessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new RenderSessionManager();
  }
  return sessionManagerInstance;
}

export function resetRenderSessionManager(): void {
  sessionManagerInstance?.reset();
  sessionManagerInstance = null;
}

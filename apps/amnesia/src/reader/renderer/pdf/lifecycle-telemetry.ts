/**
 * Lifecycle Telemetry Service
 * 
 * Unified service for tracking tile rendering lifecycle events:
 * - Tile lifecycle: request → render → cache → evict
 * - Phase transitions: idle → active → settling → rendering → idle
 * - Fallback usage, drops, retries
 * 
 * Supports JSON export for analysis and debugging.
 * Enabled via settings/flag, always on during stress tests.
 * 
 * @module lifecycle-telemetry
 */

import type { GesturePhase } from './zoom-scale-service';

/**
 * Tile lifecycle event types
 */
export type TileEventType = 
  | 'request'        // Tile requested from coordinator
  | 'render-start'   // Render started in worker
  | 'render-complete'// Render completed successfully
  | 'render-error'   // Render failed
  | 'cache-store'    // Stored in cache (L1 or L2)
  | 'cache-hit'      // Retrieved from cache
  | 'cache-evict'    // Evicted from cache
  | 'fallback-used'  // Fallback tile used instead of target
  | 'drop'           // Dropped from queue
  | 'retry-queue'    // Added to retry queue
  | 'retry-attempt'  // Retry attempted
  | 'retry-success'  // Retry succeeded
  | 'retry-expired'  // Retry entry expired (TTL)
  | 'abort';         // Render aborted

/**
 * Cache level for eviction/store events
 */
export type CacheLevel = 'L1' | 'L2' | 'L3';

/**
 * Eviction reason
 */
export type EvictionReason = 
  | 'lru'            // LRU capacity exceeded
  | 'memory-pressure'// Memory pressure triggered
  | 'zoom-change'    // Zoom change invalidated scale
  | 'mode-transition'// Display mode changed
  | 'document-switch'// Document changed
  | 'manual';        // Manual clear

/**
 * Tile lifecycle event
 */
export interface TileLifecycleEvent {
  /** Event timestamp (performance.now()) */
  timestamp: number;
  /** Event type */
  type: TileEventType;
  /** Tile identifier (e.g., "p1-t2x3-s16-ts256") */
  tileKey: string;
  /** Page number */
  page: number;
  /** Tile coordinates */
  tile?: { x: number; y: number };
  /** Scale tier */
  scale?: number;
  /** Tile size in pixels */
  tileSize?: number;
  /** Additional event-specific details */
  details: Record<string, unknown>;
}

/**
 * Phase transition event
 */
export interface PhaseEvent {
  /** Event timestamp */
  timestamp: number;
  /** Phase transitioned from */
  from: GesturePhase;
  /** Phase transitioned to */
  to: GesturePhase;
  /** Duration in previous phase (ms) */
  duration: number;
  /** What triggered the transition */
  trigger: string;
  /** Current zoom at transition */
  zoom?: number;
  /** Current scale at transition */
  scale?: number;
}

/**
 * Eviction event with details
 */
export interface EvictionEvent {
  /** Event timestamp */
  timestamp: number;
  /** Tile key evicted */
  tileKey: string;
  /** Cache level */
  cacheLevel: CacheLevel;
  /** Reason for eviction */
  reason: EvictionReason;
  /** Scale of evicted tile */
  scale?: number;
  /** Memory freed (bytes) */
  bytesFeed?: number;
}

/**
 * Fallback usage event
 */
export interface FallbackEvent {
  /** Event timestamp */
  timestamp: number;
  /** Requested tile key */
  requestedTile: string;
  /** Fallback tile key used */
  fallbackTile: string;
  /** Requested scale */
  requestedScale: number;
  /** Fallback scale */
  fallbackScale: number;
  /** CSS stretch factor applied */
  cssStretch: number;
  /** Reason fallback was needed */
  reason: 'not-cached' | 'render-pending' | 'render-failed';
}

/**
 * Mode transition event for tracking visual continuity (amnesia-aqv Phase 0.3)
 */
export interface ModeTransitionEvent {
  /** Event timestamp */
  timestamp: number;
  /** Mode before transition */
  fromMode: 'full-page' | 'tiled';
  /** Mode after transition */
  toMode: 'full-page' | 'tiled';
  /** What triggered the transition */
  trigger: string;
  /** Whether a snapshot was created for continuity */
  snapshotCreated: boolean;
  /** Coverage percentage of snapshot (0-100) */
  snapshotCoverage: number;
  /** Reason snapshot was rejected (if applicable) */
  snapshotRejectionReason: string | null;
  /** Duration of blank page (ms) - 0 = no blank */
  blankDurationMs: number;
  /** Pages affected by transition */
  pagesAffected: number[];
  /** Zoom level at transition */
  zoom: number;
  /** Epoch at transition */
  epoch: number;
}

/**
 * Aggregated statistics
 */
export interface TelemetryStats {
  /** Total events recorded */
  totalEvents: number;
  /** Events by type */
  eventsByType: Record<TileEventType, number>;
  /** Phase transitions count */
  phaseTransitions: number;
  /** Average time in each phase (ms) */
  avgPhaseDuration: Record<GesturePhase, number>;
  /** Cache hit rates */
  cacheHitRate: {
    l1: number;
    l2: number;
    overall: number;
  };
  /** Evictions by reason */
  evictionsByReason: Record<EvictionReason, number>;
  /** Fallback usage rate */
  fallbackUsageRate: number;
  /** Drop rate */
  dropRate: number;
  /** Retry success rate */
  retrySuccessRate: number;
  /** Average render time (ms) */
  avgRenderTime: number;
  /** Recording duration (ms) */
  recordingDuration: number;
  
  // amnesia-aqv Phase 0.3: Mode transition stats
  /** Total mode transitions recorded */
  modeTransitionCount: number;
  /** Count of transitions with blank duration > 16ms */
  blankTransitionCount: number;
  /** Average blank duration during transitions (ms) */
  avgBlankDurationMs: number;
  /** Maximum blank duration observed (ms) */
  maxBlankDurationMs: number;
}

/**
 * Telemetry configuration
 */
export interface TelemetryConfig {
  /** Whether telemetry is enabled */
  enabled: boolean;
  /** Maximum events to keep in memory */
  maxEvents: number;
  /** Maximum phase events to keep */
  maxPhaseEvents: number;
  /** Whether to log events to console */
  logToConsole: boolean;
  /** Log level (0=none, 1=summary, 2=important, 3=all) */
  logLevel: 0 | 1 | 2 | 3;
  /** Auto-export interval (ms, 0=disabled) */
  autoExportIntervalMs: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: TelemetryConfig = {
  enabled: false,  // Disabled by default, enabled via settings
  maxEvents: 10000,
  maxPhaseEvents: 500,
  logToConsole: false,
  logLevel: 1,
  autoExportIntervalMs: 0,
};

/**
 * Lifecycle Telemetry Service
 */
class LifecycleTelemetryService {
  private config: TelemetryConfig;
  private events: TileLifecycleEvent[] = [];
  private phaseEvents: PhaseEvent[] = [];
  private evictionEvents: EvictionEvent[] = [];
  private fallbackEvents: FallbackEvent[] = [];
  
  // amnesia-aqv Phase 0.3: Mode transition tracking
  private modeTransitionEvents: ModeTransitionEvent[] = [];
  private static readonly MAX_MODE_TRANSITIONS = 100;
  
  // Tracking state
  private lastPhaseChangeTime: number = performance.now();
  private currentPhase: GesturePhase = 'idle';
  private recordingStartTime: number = performance.now();
  
  // Render timing tracking
  private renderStartTimes: Map<string, number> = new Map();
  private renderTimes: number[] = [];
  
  // Cache hit tracking
  private cacheAccesses = { l1Hits: 0, l1Misses: 0, l2Hits: 0, l2Misses: 0 };
  
  // Drop/retry tracking
  private dropCount = 0;
  private retryAttempts = 0;
  private retrySuccesses = 0;
  private fallbackCount = 0;
  private totalTileRequests = 0;
  
  // Auto-export timer
  private autoExportTimer: ReturnType<typeof setInterval> | null = null;
  
  constructor(config?: Partial<TelemetryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.recordingStartTime = performance.now();
  }
  
  /**
   * Enable/disable telemetry
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    console.log(`[LifecycleTelemetry] ${enabled ? 'Enabled' : 'Disabled'}`);
    
    if (enabled) {
      this.recordingStartTime = performance.now();
    }
  }
  
  /**
   * Check if enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
  
  /**
   * Update configuration
   */
  updateConfig(config: Partial<TelemetryConfig>): void {
    this.config = { ...this.config, ...config };
    
    // Handle auto-export timer
    if (this.autoExportTimer) {
      clearInterval(this.autoExportTimer);
      this.autoExportTimer = null;
    }
    
    if (this.config.autoExportIntervalMs > 0 && this.config.enabled) {
      this.autoExportTimer = setInterval(
        () => this.exportToConsole(),
        this.config.autoExportIntervalMs
      );
    }
  }
  
  // ===== EVENT RECORDING METHODS =====
  
  /**
   * Record a tile lifecycle event
   */
  recordTileEvent(
    type: TileEventType,
    tileKey: string,
    details: Record<string, unknown> = {}
  ): void {
    if (!this.config.enabled) return;
    
    // Parse tile key for metadata
    const parsed = this.parseTileKey(tileKey);
    
    const event: TileLifecycleEvent = {
      timestamp: performance.now(),
      type,
      tileKey,
      page: parsed.page,
      tile: parsed.tile,
      scale: parsed.scale,
      tileSize: parsed.tileSize,
      details,
    };
    
    this.events.push(event);
    this.trimEvents();
    
    // Update counters
    if (type === 'request') {
      this.totalTileRequests++;
    } else if (type === 'drop') {
      this.dropCount++;
    } else if (type === 'retry-attempt') {
      this.retryAttempts++;
    } else if (type === 'retry-success') {
      this.retrySuccesses++;
    } else if (type === 'render-start') {
      this.renderStartTimes.set(tileKey, event.timestamp);
    } else if (type === 'render-complete') {
      const startTime = this.renderStartTimes.get(tileKey);
      if (startTime) {
        this.renderTimes.push(event.timestamp - startTime);
        this.renderStartTimes.delete(tileKey);
        // Keep only last 100 render times
        if (this.renderTimes.length > 100) {
          this.renderTimes.shift();
        }
      }
    }
    
    // Log if configured
    if (this.config.logToConsole && this.config.logLevel >= 3) {
      console.log(`[Telemetry] ${type}: ${tileKey}`, details);
    }
  }
  
  /**
   * Record phase transition
   */
  recordPhaseTransition(
    from: GesturePhase,
    to: GesturePhase,
    trigger: string,
    zoom?: number,
    scale?: number
  ): void {
    if (!this.config.enabled) return;
    
    const now = performance.now();
    const duration = now - this.lastPhaseChangeTime;
    
    const event: PhaseEvent = {
      timestamp: now,
      from,
      to,
      duration,
      trigger,
      zoom,
      scale,
    };
    
    this.phaseEvents.push(event);
    this.lastPhaseChangeTime = now;
    this.currentPhase = to;
    
    // Trim if needed
    while (this.phaseEvents.length > this.config.maxPhaseEvents) {
      this.phaseEvents.shift();
    }
    
    // Log phase transitions (important)
    if (this.config.logToConsole && this.config.logLevel >= 2) {
      const durationStr = duration < 1000 ? `${duration.toFixed(0)}ms` : `${(duration / 1000).toFixed(1)}s`;
      console.log(`[Telemetry] Phase: ${from} → ${to} (was ${durationStr}, trigger: ${trigger})`);
    }
  }
  
  /**
   * Record cache eviction
   */
  recordEviction(
    tileKey: string,
    cacheLevel: CacheLevel,
    reason: EvictionReason,
    scale?: number,
    bytesFreed?: number
  ): void {
    if (!this.config.enabled) return;
    
    const event: EvictionEvent = {
      timestamp: performance.now(),
      tileKey,
      cacheLevel,
      reason,
      scale,
      bytesFeed: bytesFreed,
    };
    
    this.evictionEvents.push(event);
    
    // Keep only last 1000 evictions
    while (this.evictionEvents.length > 1000) {
      this.evictionEvents.shift();
    }
    
    if (this.config.logToConsole && this.config.logLevel >= 3) {
      console.log(`[Telemetry] Evict ${cacheLevel}: ${tileKey} (${reason})`);
    }
  }
  
  /**
   * Record fallback tile usage
   */
  recordFallbackUsed(
    requestedTile: string,
    fallbackTile: string,
    requestedScale: number,
    fallbackScale: number,
    cssStretch: number,
    reason: FallbackEvent['reason']
  ): void {
    if (!this.config.enabled) return;
    
    const event: FallbackEvent = {
      timestamp: performance.now(),
      requestedTile,
      fallbackTile,
      requestedScale,
      fallbackScale,
      cssStretch,
      reason,
    };
    
    this.fallbackEvents.push(event);
    this.fallbackCount++;
    
    // Keep only last 500 fallbacks
    while (this.fallbackEvents.length > 500) {
      this.fallbackEvents.shift();
    }
    
    if (this.config.logToConsole && this.config.logLevel >= 2) {
      console.log(`[Telemetry] Fallback: ${requestedTile} → ${fallbackTile} (stretch: ${cssStretch.toFixed(2)})`);
    }
  }
  
  /**
   * Record cache access (for hit rate calculation)
   */
  recordCacheAccess(level: 'L1' | 'L2', hit: boolean): void {
    if (!this.config.enabled) return;
    
    if (level === 'L1') {
      if (hit) this.cacheAccesses.l1Hits++;
      else this.cacheAccesses.l1Misses++;
    } else {
      if (hit) this.cacheAccesses.l2Hits++;
      else this.cacheAccesses.l2Misses++;
    }
  }
  
  /**
   * Record a mode transition event (amnesia-aqv Phase 0.3)
   * Tracks tiled↔full-page transitions for visual continuity analysis.
   */
  recordModeTransition(event: ModeTransitionEvent): void {
    if (!this.config.enabled) return;
    
    this.modeTransitionEvents.push(event);
    
    // Limit history to prevent memory leaks
    while (this.modeTransitionEvents.length > LifecycleTelemetryService.MAX_MODE_TRANSITIONS) {
      this.modeTransitionEvents.shift();
    }
    
    // Log with severity based on blank duration
    if (event.blankDurationMs > 16) {
      console.warn(`[Telemetry] Mode transition blank: ${event.fromMode}→${event.toMode}, ` +
        `blankMs=${event.blankDurationMs.toFixed(0)}, pages=[${event.pagesAffected.join(',')}]`);
    } else if (this.config.logToConsole && this.config.logLevel >= 2) {
      console.log(`[Telemetry] Mode transition: ${event.fromMode}→${event.toMode}, ` +
        `coverage=${event.snapshotCoverage.toFixed(1)}%`);
    }
  }
  
  /**
   * Get mode transition events (amnesia-aqv Phase 0.3)
   */
  getModeTransitionEvents(limit = 50): ModeTransitionEvent[] {
    return this.modeTransitionEvents.slice(-limit);
  }
  
  // ===== QUERY METHODS =====
  
  /**
   * Get aggregated statistics
   */
  getStats(): TelemetryStats {
    const eventsByType: Record<TileEventType, number> = {
      'request': 0, 'render-start': 0, 'render-complete': 0, 'render-error': 0,
      'cache-store': 0, 'cache-hit': 0, 'cache-evict': 0, 'fallback-used': 0,
      'drop': 0, 'retry-queue': 0, 'retry-attempt': 0, 'retry-success': 0,
      'retry-expired': 0, 'abort': 0,
    };
    
    for (const event of this.events) {
      eventsByType[event.type]++;
    }
    
    // Calculate average phase durations
    const phaseDurations: Record<GesturePhase, number[]> = {
      idle: [], active: [], settling: [], rendering: [],
    };
    
    for (const pe of this.phaseEvents) {
      if (pe.from in phaseDurations) {
        phaseDurations[pe.from].push(pe.duration);
      }
    }
    
    const avgPhaseDuration: Record<GesturePhase, number> = {
      idle: 0, active: 0, settling: 0, rendering: 0,
    };
    
    for (const phase of Object.keys(phaseDurations) as GesturePhase[]) {
      const durations = phaseDurations[phase];
      if (durations.length > 0) {
        avgPhaseDuration[phase] = durations.reduce((a, b) => a + b, 0) / durations.length;
      }
    }
    
    // Calculate evictions by reason
    const evictionsByReason: Record<EvictionReason, number> = {
      'lru': 0, 'memory-pressure': 0, 'zoom-change': 0,
      'mode-transition': 0, 'document-switch': 0, 'manual': 0,
    };
    
    for (const ev of this.evictionEvents) {
      evictionsByReason[ev.reason]++;
    }
    
    // Calculate cache hit rates
    const l1Total = this.cacheAccesses.l1Hits + this.cacheAccesses.l1Misses;
    const l2Total = this.cacheAccesses.l2Hits + this.cacheAccesses.l2Misses;
    const overallHits = this.cacheAccesses.l1Hits + this.cacheAccesses.l2Hits;
    const overallTotal = l1Total + l2Total;
    
    // amnesia-aqv Phase 0.3: Calculate mode transition stats
    const blankTransitions = this.modeTransitionEvents.filter(e => e.blankDurationMs > 16);
    const blankDurations = this.modeTransitionEvents.map(e => e.blankDurationMs);
    const avgBlankDurationMs = blankDurations.length > 0
      ? blankDurations.reduce((a, b) => a + b, 0) / blankDurations.length
      : 0;
    const maxBlankDurationMs = blankDurations.length > 0
      ? Math.max(...blankDurations)
      : 0;
    
    return {
      totalEvents: this.events.length,
      eventsByType,
      phaseTransitions: this.phaseEvents.length,
      avgPhaseDuration,
      cacheHitRate: {
        l1: l1Total > 0 ? this.cacheAccesses.l1Hits / l1Total : 0,
        l2: l2Total > 0 ? this.cacheAccesses.l2Hits / l2Total : 0,
        overall: overallTotal > 0 ? overallHits / overallTotal : 0,
      },
      evictionsByReason,
      fallbackUsageRate: this.totalTileRequests > 0 
        ? this.fallbackCount / this.totalTileRequests : 0,
      dropRate: this.totalTileRequests > 0 
        ? this.dropCount / this.totalTileRequests : 0,
      retrySuccessRate: this.retryAttempts > 0 
        ? this.retrySuccesses / this.retryAttempts : 0,
      avgRenderTime: this.renderTimes.length > 0 
        ? this.renderTimes.reduce((a, b) => a + b, 0) / this.renderTimes.length : 0,
      recordingDuration: performance.now() - this.recordingStartTime,
      // amnesia-aqv Phase 0.3: Mode transition stats
      modeTransitionCount: this.modeTransitionEvents.length,
      blankTransitionCount: blankTransitions.length,
      avgBlankDurationMs,
      maxBlankDurationMs,
    };
  }
  
  /**
   * Get recent events of a specific type
   */
  getEventsByType(type: TileEventType, limit = 100): TileLifecycleEvent[] {
    return this.events
      .filter(e => e.type === type)
      .slice(-limit);
  }
  
  /**
   * Get events for a specific page
   */
  getEventsForPage(page: number, limit = 100): TileLifecycleEvent[] {
    return this.events
      .filter(e => e.page === page)
      .slice(-limit);
  }
  
  /**
   * Get phase events
   */
  getPhaseEvents(limit = 100): PhaseEvent[] {
    return this.phaseEvents.slice(-limit);
  }
  
  /**
   * Get eviction events
   */
  getEvictionEvents(limit = 100): EvictionEvent[] {
    return this.evictionEvents.slice(-limit);
  }
  
  /**
   * Get fallback events
   */
  getFallbackEvents(limit = 100): FallbackEvent[] {
    return this.fallbackEvents.slice(-limit);
  }
  
  // ===== EXPORT METHODS =====
  
  /**
   * Export all telemetry data as JSON
   */
  exportAsJSON(): string {
    const stats = this.getStats();
    
    const exportData = {
      meta: {
        exportTime: new Date().toISOString(),
        recordingDurationMs: stats.recordingDuration,
        enabled: this.config.enabled,
      },
      stats,
      events: {
        tile: this.events,
        phase: this.phaseEvents,
        eviction: this.evictionEvents,
        fallback: this.fallbackEvents,
      },
      config: this.config,
    };
    
    return JSON.stringify(exportData, null, 2);
  }
  
  /**
   * Export to console (summary only)
   */
  exportToConsole(): void {
    const stats = this.getStats();
    
    console.group('[LifecycleTelemetry] Summary');
    console.log('Events:', stats.totalEvents);
    console.log('Events by type:', stats.eventsByType);
    console.log('Phase transitions:', stats.phaseTransitions);
    console.log('Avg phase durations:', stats.avgPhaseDuration);
    console.log('Cache hit rates:', stats.cacheHitRate);
    console.log('Fallback rate:', (stats.fallbackUsageRate * 100).toFixed(1) + '%');
    console.log('Drop rate:', (stats.dropRate * 100).toFixed(1) + '%');
    console.log('Retry success rate:', (stats.retrySuccessRate * 100).toFixed(1) + '%');
    console.log('Avg render time:', stats.avgRenderTime.toFixed(1) + 'ms');
    console.groupEnd();
  }
  
  /**
   * Export to file (in vault)
   * Returns the file path or null if failed
   */
  async exportToFile(vaultPath: string, filename?: string): Promise<string | null> {
    try {
      const fs = require('fs');
      const path = require('path');
      
      // Create reports directory
      const reportsDir = path.join(vaultPath, '.obsidian', 'plugins', 'amnesia', 'reports');
      if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
      }
      
      // Generate filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const finalFilename = filename ?? `telemetry-${timestamp}.json`;
      const filePath = path.join(reportsDir, finalFilename);
      
      // Write file
      const json = this.exportAsJSON();
      fs.writeFileSync(filePath, json, 'utf8');
      
      console.log(`[LifecycleTelemetry] Exported to: ${filePath}`);
      return filePath;
    } catch (e) {
      console.error('[LifecycleTelemetry] Export failed:', e);
      return null;
    }
  }
  
  // ===== UTILITY METHODS =====
  
  /**
   * Clear all recorded data
   */
  clear(): void {
    this.events = [];
    this.phaseEvents = [];
    this.evictionEvents = [];
    this.fallbackEvents = [];
    this.modeTransitionEvents = [];  // amnesia-aqv Phase 0.3
    this.renderStartTimes.clear();
    this.renderTimes = [];
    this.cacheAccesses = { l1Hits: 0, l1Misses: 0, l2Hits: 0, l2Misses: 0 };
    this.dropCount = 0;
    this.retryAttempts = 0;
    this.retrySuccesses = 0;
    this.fallbackCount = 0;
    this.totalTileRequests = 0;
    this.recordingStartTime = performance.now();
    this.lastPhaseChangeTime = performance.now();
    
    console.log('[LifecycleTelemetry] Cleared');
  }
  
  /**
   * Parse tile key into components
   */
  private parseTileKey(tileKey: string): {
    page: number;
    tile?: { x: number; y: number };
    scale?: number;
    tileSize?: number;
  } {
    // Format: "docId-p1-t2x3-s16-ts256" or "p1-t2x3-s16"
    const pageMatch = tileKey.match(/p(\d+)/);
    const tileMatch = tileKey.match(/t(\d+)x(\d+)/);
    const scaleMatch = tileKey.match(/s(\d+)/);
    const tileSizeMatch = tileKey.match(/ts(\d+)/);
    
    return {
      page: pageMatch ? parseInt(pageMatch[1]) : 0,
      tile: tileMatch ? { x: parseInt(tileMatch[1]), y: parseInt(tileMatch[2]) } : undefined,
      scale: scaleMatch ? parseInt(scaleMatch[1]) : undefined,
      tileSize: tileSizeMatch ? parseInt(tileSizeMatch[1]) : undefined,
    };
  }
  
  /**
   * Trim events to max size
   */
  private trimEvents(): void {
    while (this.events.length > this.config.maxEvents) {
      this.events.shift();
    }
  }
  
  /**
   * Destroy service
   */
  destroy(): void {
    if (this.autoExportTimer) {
      clearInterval(this.autoExportTimer);
      this.autoExportTimer = null;
    }
    this.clear();
  }
}

// Singleton instance
let telemetryInstance: LifecycleTelemetryService | null = null;

/**
 * Get the lifecycle telemetry service instance
 */
export function getLifecycleTelemetry(): LifecycleTelemetryService {
  if (!telemetryInstance) {
    telemetryInstance = new LifecycleTelemetryService();
  }
  return telemetryInstance;
}

/**
 * Reset the telemetry service (for testing)
 */
export function resetLifecycleTelemetry(): void {
  if (telemetryInstance) {
    telemetryInstance.destroy();
    telemetryInstance = null;
  }
}

// Expose to window for debugging
if (typeof window !== 'undefined') {
  (window as unknown as { lifecycleTelemetry: LifecycleTelemetryService }).lifecycleTelemetry = getLifecycleTelemetry();
}

// Export service type
export type { LifecycleTelemetryService };

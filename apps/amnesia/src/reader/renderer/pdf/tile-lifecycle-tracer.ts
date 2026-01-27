/**
 * Tile Lifecycle Tracer (amnesia-aqv)
 *
 * Event-based tracing for tile rendering lifecycle to debug race conditions
 * between async tile rendering and gesture state changes.
 *
 * Key events traced:
 * - tile.requested: Tile render queued
 * - tile.composited: Tile successfully drawn to canvas
 * - tile.rejected: Tile discarded (stale gesture, scale regression)
 * - scale.regression: Lower-res tile attempted to overwrite higher-res
 * - gesture.started: New scroll/zoom gesture began
 * - gesture.ended: Gesture completed
 */

export type TileEventType =
  | 'tile.requested'
  | 'tile.composited'
  | 'tile.rejected'
  | 'scale.regression'
  | 'gesture.started'
  | 'gesture.ended';

export interface TileEvent {
  type: TileEventType;
  timestamp: number;
  gestureId: string;
  page?: number;
  tileCoord?: { x: number; y: number };
  scale?: number;
  oldScale?: number; // for scale.regression events
  reason?: string;
  metadata?: Record<string, unknown>;
}

type EventListener = (event: TileEvent) => void;

/**
 * Circular buffer for storing recent tile lifecycle events.
 * Keeps the last N events in memory for debugging without unbounded growth.
 */
class CircularBuffer<T> {
  private buffer: T[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  toArray(): T[] {
    if (this.count === 0) return [];
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    // Buffer is full, need to reorder from oldest to newest
    return [
      ...this.buffer.slice(this.head),
      ...this.buffer.slice(0, this.head),
    ];
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  /**
   * Get events matching a filter predicate.
   */
  filter(predicate: (item: T) => boolean): T[] {
    return this.toArray().filter(predicate);
  }
}

/**
 * TileLifecycleTracer - Singleton for tracking tile rendering events.
 *
 * Usage:
 *   const tracer = getTileLifecycleTracer();
 *   tracer.emit({ type: 'tile.requested', gestureId, page, scale });
 *   tracer.getEvents(); // Recent events
 *   tracer.getScaleRegressions(); // Scale regression events
 */
class TileLifecycleTracer {
  private events: CircularBuffer<TileEvent>;
  private listeners: Set<EventListener> = new Set();
  private enabled = true;

  // Statistics
  private stats = {
    totalRequested: 0,
    totalComposited: 0,
    totalRejected: 0,
    scaleRegressions: 0,
    gestureCount: 0,
  };

  constructor(bufferSize = 1000) {
    this.events = new CircularBuffer(bufferSize);
  }

  /**
   * Emit a tile lifecycle event.
   */
  emit(event: Omit<TileEvent, 'timestamp'>): void {
    if (!this.enabled) return;

    const fullEvent: TileEvent = {
      ...event,
      timestamp: performance.now(),
    };

    this.events.push(fullEvent);
    this.updateStats(fullEvent);

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(fullEvent);
      } catch (err) {
        console.warn('[TileLifecycleTracer] Listener error:', err);
      }
    }

    // Log significant events
    if (fullEvent.type === 'tile.rejected' || fullEvent.type === 'scale.regression') {
      console.warn(
        `[TILE-LIFECYCLE] ${fullEvent.type}: page=${fullEvent.page} scale=${fullEvent.scale} reason=${fullEvent.reason} gestureId=${fullEvent.gestureId?.slice(0, 8)}`
      );
    }
  }

  private updateStats(event: TileEvent): void {
    switch (event.type) {
      case 'tile.requested':
        this.stats.totalRequested++;
        break;
      case 'tile.composited':
        this.stats.totalComposited++;
        break;
      case 'tile.rejected':
        this.stats.totalRejected++;
        break;
      case 'scale.regression':
        this.stats.scaleRegressions++;
        break;
      case 'gesture.started':
        this.stats.gestureCount++;
        break;
    }
  }

  /**
   * Get all recent events.
   */
  getEvents(): TileEvent[] {
    return this.events.toArray();
  }

  /**
   * Get events for a specific page.
   */
  getEventsForPage(page: number): TileEvent[] {
    return this.events.filter((e) => e.page === page);
  }

  /**
   * Get all scale regression events.
   */
  getScaleRegressions(): TileEvent[] {
    return this.events.filter((e) => e.type === 'scale.regression');
  }

  /**
   * Get events by gesture ID.
   */
  getEventsByGesture(gestureId: string): TileEvent[] {
    return this.events.filter((e) => e.gestureId === gestureId);
  }

  /**
   * Get rejected tile events.
   */
  getRejectedTiles(): TileEvent[] {
    return this.events.filter((e) => e.type === 'tile.rejected');
  }

  /**
   * Get statistics summary.
   */
  getStats(): typeof this.stats & { bufferSize: number; rejectionRate: string } {
    const total = this.stats.totalRequested;
    const rejected = this.stats.totalRejected;
    return {
      ...this.stats,
      bufferSize: this.events.size,
      rejectionRate: total > 0 ? `${((rejected / total) * 100).toFixed(1)}%` : '0%',
    };
  }

  /**
   * Add an event listener.
   */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Clear all events and reset stats.
   */
  clear(): void {
    this.events.clear();
    this.stats = {
      totalRequested: 0,
      totalComposited: 0,
      totalRejected: 0,
      scaleRegressions: 0,
      gestureCount: 0,
    };
  }

  /**
   * Enable/disable tracing.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

// Singleton instance
let instance: TileLifecycleTracer | null = null;

/**
 * Get the singleton TileLifecycleTracer instance.
 */
export function getTileLifecycleTracer(): TileLifecycleTracer {
  if (!instance) {
    instance = new TileLifecycleTracer();
  }
  return instance;
}

/**
 * Generate a unique gesture ID.
 * Uses timestamp + random suffix for uniqueness.
 */
export function generateGestureId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `g-${timestamp}-${random}`;
}

// Expose for debugging via window
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).tileLifecycleTracer = {
    getTracer: getTileLifecycleTracer,
    getEvents: () => getTileLifecycleTracer().getEvents(),
    getStats: () => getTileLifecycleTracer().getStats(),
    getRejections: () => getTileLifecycleTracer().getRejectedTiles(),
    getScaleRegressions: () => getTileLifecycleTracer().getScaleRegressions(),
    clear: () => getTileLifecycleTracer().clear(),
  };
}

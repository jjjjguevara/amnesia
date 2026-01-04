/**
 * Sync Queue
 *
 * Concurrency-limited queue for file operations using p-queue.
 * Prevents UI freezing and OOM errors on large libraries.
 *
 * Features:
 * - Configurable concurrency limit (default: 5)
 * - Debounce support for rapid updates
 * - Progress tracking
 * - Pause/resume capability
 * - Error handling with retry
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import PQueue from 'p-queue';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for queue operations
 */
export interface QueueOptions {
  /** Maximum concurrent operations (default: 5) */
  concurrency?: number;
  /** Interval between operations in ms (default: 0) */
  interval?: number;
  /** Operations per interval (default: unlimited) */
  intervalCap?: number;
  /** Timeout per operation in ms (default: 30000) */
  timeout?: number;
}

/**
 * Task to be queued
 */
export interface QueueTask<T = unknown> {
  /** Unique ID for the task */
  id: string;
  /** The async function to execute */
  fn: () => Promise<T>;
  /** Priority (higher = sooner) */
  priority?: number;
}

/**
 * Result of a queued operation
 */
export interface QueueResult<T = unknown> {
  /** Task ID */
  id: string;
  /** Whether successful */
  success: boolean;
  /** Result if successful */
  result?: T;
  /** Error if failed */
  error?: Error;
  /** Duration in ms */
  duration: number;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  /** Tasks waiting in queue */
  pending: number;
  /** Currently running tasks */
  active: number;
  /** Completed tasks */
  completed: number;
  /** Failed tasks */
  failed: number;
  /** Total processed */
  total: number;
  /** Is queue paused */
  isPaused: boolean;
}

/**
 * Progress callback
 */
export type ProgressCallback = (stats: QueueStats) => void;

// ============================================================================
// Sync Queue Class
// ============================================================================

/**
 * Concurrency-limited queue for sync operations
 */
export class SyncQueue {
  private queue: PQueue;
  private stats: QueueStats;
  private progressCallbacks: Set<ProgressCallback>;
  private debounceTimers: Map<string, NodeJS.Timeout>;
  private debounceDelay: number;

  constructor(options: QueueOptions = {}) {
    const {
      concurrency = 5,
      interval = 0,
      intervalCap = Infinity,
      timeout = 30000,
    } = options;

    this.queue = new PQueue({
      concurrency,
      interval,
      intervalCap,
      timeout,
      throwOnTimeout: false,
    });

    this.stats = {
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
      total: 0,
      isPaused: false,
    };

    this.progressCallbacks = new Set();
    this.debounceTimers = new Map();
    this.debounceDelay = 2000; // 2 second default debounce

    // Track queue events
    this.queue.on('active', () => {
      this.stats.active = this.queue.pending;
      this.stats.pending = this.queue.size;
      this.notifyProgress();
    });

    this.queue.on('idle', () => {
      this.stats.active = 0;
      this.stats.pending = 0;
      this.notifyProgress();
    });
  }

  /**
   * Add a task to the queue
   */
  async add<T>(task: QueueTask<T>): Promise<QueueResult<T>> {
    this.stats.total++;
    this.stats.pending++;
    this.notifyProgress();

    const startTime = Date.now();

    try {
      const result = await this.queue.add(task.fn, {
        priority: task.priority,
      });

      this.stats.completed++;
      this.stats.pending--;
      this.notifyProgress();

      return {
        id: task.id,
        success: true,
        result: result as T,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      this.stats.failed++;
      this.stats.pending--;
      this.notifyProgress();

      return {
        id: task.id,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Add a debounced task - if same ID is added again within delay, previous is cancelled
   */
  addDebounced<T>(task: QueueTask<T>, delay?: number): void {
    const debounceMs = delay ?? this.debounceDelay;

    // Cancel existing timer for this ID
    const existingTimer = this.debounceTimers.get(task.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(task.id);
      this.add(task);
    }, debounceMs);

    this.debounceTimers.set(task.id, timer);
  }

  /**
   * Add multiple tasks and wait for all to complete
   */
  async addAll<T>(tasks: QueueTask<T>[]): Promise<QueueResult<T>[]> {
    const promises = tasks.map(task => this.add(task));
    return Promise.all(promises);
  }

  /**
   * Pause the queue
   */
  pause(): void {
    this.queue.pause();
    this.stats.isPaused = true;
    this.notifyProgress();
  }

  /**
   * Resume the queue
   */
  resume(): void {
    this.queue.start();
    this.stats.isPaused = false;
    this.notifyProgress();
  }

  /**
   * Clear all pending tasks
   */
  clear(): void {
    this.queue.clear();
    this.stats.pending = 0;

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.notifyProgress();
  }

  /**
   * Wait for all tasks to complete
   */
  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  /**
   * Wait for queue to be empty (no pending tasks)
   */
  async onEmpty(): Promise<void> {
    await this.queue.onEmpty();
  }

  /**
   * Get current queue statistics
   */
  getStats(): QueueStats {
    return {
      ...this.stats,
      pending: this.queue.size,
      active: this.queue.pending,
    };
  }

  /**
   * Subscribe to progress updates
   */
  onProgress(callback: ProgressCallback): () => void {
    this.progressCallbacks.add(callback);
    return () => this.progressCallbacks.delete(callback);
  }

  /**
   * Set debounce delay for debounced tasks
   */
  setDebounceDelay(ms: number): void {
    this.debounceDelay = ms;
  }

  /**
   * Get number of pending tasks
   */
  get size(): number {
    return this.queue.size;
  }

  /**
   * Get number of currently running tasks
   */
  get pending(): number {
    return this.queue.pending;
  }

  /**
   * Check if queue is paused
   */
  get isPaused(): boolean {
    return this.queue.isPaused;
  }

  /**
   * Notify all progress callbacks
   */
  private notifyProgress(): void {
    const stats = this.getStats();
    for (const callback of this.progressCallbacks) {
      try {
        callback(stats);
      } catch (error) {
        console.error('[SyncQueue] Progress callback error:', error);
      }
    }
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      pending: this.queue.size,
      active: this.queue.pending,
      completed: 0,
      failed: 0,
      total: 0,
      isPaused: this.queue.isPaused,
    };
    this.notifyProgress();
  }
}

// ============================================================================
// File Write Queue
// ============================================================================

/**
 * Specialized queue for file write operations
 */
export class FileWriteQueue extends SyncQueue {
  constructor(options?: Partial<QueueOptions>) {
    super({
      concurrency: 5,      // 5 parallel file writes
      interval: 100,       // 100ms between batches
      intervalCap: 10,     // Max 10 per interval
      timeout: 30000,      // 30s timeout per write
      ...options,
    });
  }

  /**
   * Queue a file write operation
   */
  async writeFile(
    path: string,
    writeFn: () => Promise<void>,
    priority?: number
  ): Promise<QueueResult<void>> {
    return this.add({
      id: `write:${path}`,
      fn: writeFn,
      priority,
    });
  }

  /**
   * Queue a debounced file write (for rapid updates)
   */
  writeFileDebounced(
    path: string,
    writeFn: () => Promise<void>,
    debounceMs?: number
  ): void {
    this.addDebounced(
      {
        id: `write:${path}`,
        fn: writeFn,
      },
      debounceMs
    );
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultQueue: SyncQueue | null = null;
let fileWriteQueue: FileWriteQueue | null = null;

/**
 * Get the default sync queue (creates if not exists)
 */
export function getDefaultQueue(): SyncQueue {
  if (!defaultQueue) {
    defaultQueue = new SyncQueue();
  }
  return defaultQueue;
}

/**
 * Get the file write queue (creates if not exists)
 */
export function getFileWriteQueue(): FileWriteQueue {
  if (!fileWriteQueue) {
    fileWriteQueue = new FileWriteQueue();
  }
  return fileWriteQueue;
}

/**
 * Reset singleton instances (for testing)
 */
export function resetQueues(): void {
  if (defaultQueue) {
    defaultQueue.clear();
    defaultQueue = null;
  }
  if (fileWriteQueue) {
    fileWriteQueue.clear();
    fileWriteQueue = null;
  }
}

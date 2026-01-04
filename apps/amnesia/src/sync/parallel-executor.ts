/**
 * Parallel Executor
 *
 * Manages parallel execution of sync operations with:
 * - Configurable concurrency limits
 * - Priority queuing
 * - Rate limiting integration
 * - Progress tracking
 * - Error handling with retries
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type { RateLimiter } from './rate-limiter';

// ============================================================================
// Types
// ============================================================================

/**
 * Task priority levels
 */
export type TaskPriority = 'high' | 'normal' | 'low';

/**
 * Task status
 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * A task to be executed
 */
export interface Task<T = unknown> {
  /** Unique task ID */
  id: string;
  /** Task priority */
  priority: TaskPriority;
  /** The async function to execute */
  execute: () => Promise<T>;
  /** Retry count */
  retries: number;
  /** Maximum retries */
  maxRetries: number;
  /** Retry delay in ms */
  retryDelay: number;
  /** Task status */
  status: TaskStatus;
  /** Task metadata */
  metadata?: Record<string, unknown>;
  /** Created timestamp */
  createdAt: Date;
  /** Started timestamp */
  startedAt?: Date;
  /** Completed timestamp */
  completedAt?: Date;
  /** Result if completed */
  result?: T;
  /** Error if failed */
  error?: Error;
}

/**
 * Task result
 */
export interface TaskResult<T = unknown> {
  /** Task ID */
  id: string;
  /** Was successful */
  success: boolean;
  /** Result data */
  data?: T;
  /** Error if failed */
  error?: Error;
  /** Duration in ms */
  duration: number;
  /** Retry count used */
  retries: number;
}

/**
 * Batch result
 */
export interface BatchResult<T = unknown> {
  /** Total tasks */
  total: number;
  /** Completed tasks */
  completed: number;
  /** Failed tasks */
  failed: number;
  /** Individual results */
  results: TaskResult<T>[];
  /** Total duration in ms */
  duration: number;
  /** Average task duration */
  avgDuration: number;
  /** Tasks per second */
  throughput: number;
}

/**
 * Executor progress
 */
export interface ExecutorProgress {
  /** Total tasks */
  total: number;
  /** Completed tasks */
  completed: number;
  /** Failed tasks */
  failed: number;
  /** Running tasks */
  running: number;
  /** Pending tasks */
  pending: number;
  /** Percentage complete */
  percentage: number;
  /** Current task IDs being executed */
  currentTasks: string[];
  /** Estimated time remaining (seconds) */
  eta?: number;
}

/**
 * Executor configuration
 */
export interface ParallelExecutorConfig {
  /** Maximum concurrent tasks */
  concurrency: number;
  /** Default max retries */
  maxRetries: number;
  /** Default retry delay in ms */
  retryDelay: number;
  /** Retry backoff multiplier */
  retryBackoff: number;
  /** Task timeout in ms (0 = no timeout) */
  taskTimeout: number;
  /** Enable priority queuing */
  enablePriority: boolean;
  /** Rate limiter (optional) */
  rateLimiter?: RateLimiter;
  /** Enable debug logging */
  debug: boolean;
}

// Re-export RateLimiter for convenience
export type { RateLimiter } from './rate-limiter';

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_EXECUTOR_CONFIG: ParallelExecutorConfig = {
  concurrency: 5,
  maxRetries: 3,
  retryDelay: 1000,
  retryBackoff: 2,
  taskTimeout: 30000,
  enablePriority: true,
  debug: false,
};

// ============================================================================
// Parallel Executor Implementation
// ============================================================================

/**
 * Executes tasks in parallel with concurrency control
 */
export class ParallelExecutor<T = unknown> {
  private config: ParallelExecutorConfig;
  private queue: Task<T>[] = [];
  private running = new Map<string, Task<T>>();
  private completed: TaskResult<T>[] = [];
  private abortController: AbortController | null = null;
  private isPaused = false;
  private startTime = 0;
  private progressCallback?: (progress: ExecutorProgress) => void;

  constructor(config: Partial<ParallelExecutorConfig> = {}) {
    this.config = { ...DEFAULT_EXECUTOR_CONFIG, ...config };
  }

  // ==========================================================================
  // Task Management
  // ==========================================================================

  /**
   * Add a task to the queue
   */
  addTask(
    id: string,
    execute: () => Promise<T>,
    options: {
      priority?: TaskPriority;
      maxRetries?: number;
      retryDelay?: number;
      metadata?: Record<string, unknown>;
    } = {}
  ): Task<T> {
    const task: Task<T> = {
      id,
      priority: options.priority || 'normal',
      execute,
      retries: 0,
      maxRetries: options.maxRetries ?? this.config.maxRetries,
      retryDelay: options.retryDelay ?? this.config.retryDelay,
      status: 'pending',
      metadata: options.metadata,
      createdAt: new Date(),
    };

    this.insertByPriority(task);
    return task;
  }

  /**
   * Add multiple tasks
   */
  addTasks(
    tasks: Array<{
      id: string;
      execute: () => Promise<T>;
      priority?: TaskPriority;
      metadata?: Record<string, unknown>;
    }>
  ): Task<T>[] {
    return tasks.map((t) =>
      this.addTask(t.id, t.execute, {
        priority: t.priority,
        metadata: t.metadata,
      })
    );
  }

  /**
   * Cancel a specific task
   */
  cancelTask(id: string): boolean {
    // Check queue
    const queueIndex = this.queue.findIndex((t) => t.id === id);
    if (queueIndex !== -1) {
      this.queue[queueIndex].status = 'cancelled';
      this.queue.splice(queueIndex, 1);
      return true;
    }

    // Can't cancel running tasks directly
    return false;
  }

  /**
   * Clear all pending tasks
   */
  clearQueue(): void {
    this.queue = [];
  }

  // ==========================================================================
  // Execution
  // ==========================================================================

  /**
   * Execute all queued tasks
   */
  async execute(
    onProgress?: (progress: ExecutorProgress) => void
  ): Promise<BatchResult<T>> {
    this.progressCallback = onProgress;
    this.abortController = new AbortController();
    this.completed = [];
    this.startTime = performance.now();

    // Process queue until empty or aborted
    while (
      (this.queue.length > 0 || this.running.size > 0) &&
      !this.abortController.signal.aborted
    ) {
      // Wait if paused
      if (this.isPaused) {
        await this.sleep(100);
        continue;
      }

      // Fill up to concurrency limit
      while (
        this.running.size < this.config.concurrency &&
        this.queue.length > 0 &&
        !this.abortController.signal.aborted
      ) {
        const task = this.queue.shift()!;
        this.executeTask(task);
      }

      // Wait for at least one task to complete
      if (this.running.size > 0) {
        await this.waitForAny();
      }

      this.emitProgress();
    }

    const duration = performance.now() - this.startTime;
    const completed = this.completed.filter((r) => r.success).length;
    const failed = this.completed.filter((r) => !r.success).length;

    return {
      total: this.completed.length,
      completed,
      failed,
      results: this.completed,
      duration,
      avgDuration: this.completed.length > 0 ? duration / this.completed.length : 0,
      throughput: this.completed.length > 0 ? (this.completed.length / duration) * 1000 : 0,
    };
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: Task<T>): Promise<void> {
    task.status = 'running';
    task.startedAt = new Date();
    this.running.set(task.id, task);

    try {
      // Acquire rate limit token if configured
      if (this.config.rateLimiter) {
        await this.config.rateLimiter.acquire();
      }

      // Execute with timeout
      const result = await this.executeWithTimeout(task);

      // Success
      task.status = 'completed';
      task.completedAt = new Date();
      task.result = result;

      this.completed.push({
        id: task.id,
        success: true,
        data: result,
        duration: task.completedAt.getTime() - task.startedAt!.getTime(),
        retries: task.retries,
      });
    } catch (error) {
      // Handle failure
      task.error = error as Error;

      if (task.retries < task.maxRetries) {
        // Retry
        task.retries++;
        task.status = 'pending';
        task.retryDelay *= this.config.retryBackoff;

        if (this.config.debug) {
          console.log(
            `[ParallelExecutor] Task ${task.id} failed, retrying (${task.retries}/${task.maxRetries})`
          );
        }

        // Wait before retry
        await this.sleep(task.retryDelay);

        // Re-queue with high priority for retry
        task.priority = 'high';
        this.insertByPriority(task);
      } else {
        // Max retries exceeded
        task.status = 'failed';
        task.completedAt = new Date();

        this.completed.push({
          id: task.id,
          success: false,
          error: error as Error,
          duration: task.completedAt.getTime() - task.startedAt!.getTime(),
          retries: task.retries,
        });

        if (this.config.debug) {
          console.error(
            `[ParallelExecutor] Task ${task.id} failed permanently:`,
            error
          );
        }
      }
    } finally {
      this.running.delete(task.id);

      // Release rate limit token
      if (this.config.rateLimiter) {
        this.config.rateLimiter.release();
      }
    }
  }

  /**
   * Execute task with timeout
   */
  private async executeWithTimeout(task: Task<T>): Promise<T> {
    if (this.config.taskTimeout === 0) {
      return task.execute();
    }

    return Promise.race([
      task.execute(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Task ${task.id} timed out after ${this.config.taskTimeout}ms`));
        }, this.config.taskTimeout);
      }),
    ]);
  }

  // ==========================================================================
  // Control Methods
  // ==========================================================================

  /**
   * Pause execution
   */
  pause(): void {
    this.isPaused = true;
  }

  /**
   * Resume execution
   */
  resume(): void {
    this.isPaused = false;
  }

  /**
   * Cancel all execution
   */
  cancel(): void {
    this.abortController?.abort();
    this.clearQueue();
  }

  /**
   * Check if executor is running
   */
  isRunning(): boolean {
    return this.running.size > 0 || this.queue.length > 0;
  }

  /**
   * Check if executor is paused
   */
  isExecutorPaused(): boolean {
    return this.isPaused;
  }

  /**
   * Get current progress
   */
  getProgress(): ExecutorProgress {
    const total = this.completed.length + this.running.size + this.queue.length;
    const completed = this.completed.filter((r) => r.success).length;
    const failed = this.completed.filter((r) => !r.success).length;

    // Calculate ETA based on average task duration
    let eta: number | undefined;
    if (this.completed.length > 0 && this.queue.length > 0) {
      const avgDuration =
        this.completed.reduce((sum, r) => sum + r.duration, 0) /
        this.completed.length;
      eta = ((this.queue.length + this.running.size) * avgDuration) / 1000;
    }

    return {
      total,
      completed,
      failed,
      running: this.running.size,
      pending: this.queue.length,
      percentage: total > 0 ? Math.round((this.completed.length / total) * 100) : 0,
      currentTasks: Array.from(this.running.keys()),
      eta,
    };
  }

  // ==========================================================================
  // Static Helpers
  // ==========================================================================

  /**
   * Execute a batch of functions with concurrency control
   */
  static async map<I, O>(
    items: I[],
    fn: (item: I, index: number) => Promise<O>,
    options: {
      concurrency?: number;
      onProgress?: (progress: ExecutorProgress) => void;
    } = {}
  ): Promise<BatchResult<O>> {
    const executor = new ParallelExecutor<O>({
      concurrency: options.concurrency || 5,
    });

    items.forEach((item, index) => {
      executor.addTask(`item-${index}`, () => fn(item, index));
    });

    return executor.execute(options.onProgress);
  }

  /**
   * Execute functions in parallel and return results
   */
  static async all<T>(
    fns: Array<() => Promise<T>>,
    concurrency = 5
  ): Promise<T[]> {
    const executor = new ParallelExecutor<T>({ concurrency });

    fns.forEach((fn, index) => {
      executor.addTask(`task-${index}`, fn);
    });

    const result = await executor.execute();
    return result.results
      .filter((r) => r.success)
      .map((r) => r.data as T);
  }

  /**
   * Execute with retry and return first successful result
   */
  static async race<T>(
    fns: Array<() => Promise<T>>,
    options: { maxRetries?: number; retryDelay?: number } = {}
  ): Promise<T | undefined> {
    const executor = new ParallelExecutor<T>({
      concurrency: fns.length,
      maxRetries: options.maxRetries || 0,
      retryDelay: options.retryDelay || 1000,
    });

    fns.forEach((fn, index) => {
      executor.addTask(`race-${index}`, fn);
    });

    const result = await executor.execute();
    const successful = result.results.find((r) => r.success);
    return successful?.data;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Insert task maintaining priority order
   */
  private insertByPriority(task: Task<T>): void {
    if (!this.config.enablePriority) {
      this.queue.push(task);
      return;
    }

    const priorityOrder: Record<TaskPriority, number> = {
      high: 0,
      normal: 1,
      low: 2,
    };

    const taskPriority = priorityOrder[task.priority];
    let insertIndex = this.queue.length;

    for (let i = 0; i < this.queue.length; i++) {
      if (priorityOrder[this.queue[i].priority] > taskPriority) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, task);
  }

  /**
   * Wait for any running task to complete
   */
  private async waitForAny(): Promise<void> {
    // Simple polling - in production could use more sophisticated coordination
    while (this.running.size >= this.config.concurrency) {
      await this.sleep(10);
    }
  }

  /**
   * Emit progress update
   */
  private emitProgress(): void {
    if (this.progressCallback) {
      this.progressCallback(this.getProgress());
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Execute functions in parallel with concurrency control
 */
export async function parallelMap<I, O>(
  items: I[],
  fn: (item: I, index: number) => Promise<O>,
  concurrency = 5
): Promise<O[]> {
  const result = await ParallelExecutor.map(items, fn, { concurrency });
  return result.results
    .filter((r) => r.success)
    .map((r) => r.data as O);
}

/**
 * Execute all functions in parallel
 */
export async function parallelAll<T>(
  fns: Array<() => Promise<T>>,
  concurrency = 5
): Promise<T[]> {
  return ParallelExecutor.all(fns, concurrency);
}

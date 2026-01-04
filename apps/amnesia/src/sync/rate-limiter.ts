/**
 * Rate Limiter
 *
 * Token bucket rate limiter for controlling request rates to servers.
 * Prevents overwhelming servers during sync operations.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Rate limiter interface (matches ParallelExecutor expectation)
 */
export interface RateLimiter {
  acquire(): Promise<void>;
  release(): void;
  getAvailableTokens(): number;
}

/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
  /** Maximum tokens (requests) per interval */
  tokensPerInterval: number;
  /** Interval duration in ms */
  interval: number;
  /** Maximum burst size (tokens that can accumulate) */
  maxBurst: number;
  /** Fair queuing (FIFO) vs greedy */
  fairQueuing: boolean;
  /** Enable debug logging */
  debug: boolean;
}

/**
 * Rate limiter statistics
 */
export interface RateLimiterStats {
  /** Total requests made */
  totalRequests: number;
  /** Requests that waited */
  waitedRequests: number;
  /** Total wait time in ms */
  totalWaitTime: number;
  /** Average wait time in ms */
  avgWaitTime: number;
  /** Current available tokens */
  availableTokens: number;
  /** Pending requests in queue */
  pendingRequests: number;
  /** Requests per second (recent) */
  requestsPerSecond: number;
}

/**
 * Pending request in queue
 */
interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timestamp: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_RATE_CONFIG: RateLimiterConfig = {
  tokensPerInterval: 10,
  interval: 1000,
  maxBurst: 20,
  fairQueuing: true,
  debug: false,
};

// ============================================================================
// Token Bucket Rate Limiter
// ============================================================================

/**
 * Token bucket rate limiter implementation
 */
export class TokenBucketRateLimiter {
  private config: RateLimiterConfig;
  private tokens: number;
  private lastRefill: number;
  private queue: PendingRequest[] = [];
  private processing = false;
  private stats = {
    totalRequests: 0,
    waitedRequests: 0,
    totalWaitTime: 0,
    recentRequests: [] as number[],
  };

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_CONFIG, ...config };
    this.tokens = this.config.maxBurst;
    this.lastRefill = Date.now();
  }

  // ==========================================================================
  // Core Methods
  // ==========================================================================

  /**
   * Acquire a token (wait if necessary)
   */
  async acquire(): Promise<void> {
    this.stats.totalRequests++;
    this.stats.recentRequests.push(Date.now());

    // Clean old requests from recent list (keep last 10 seconds)
    const cutoff = Date.now() - 10000;
    this.stats.recentRequests = this.stats.recentRequests.filter(
      (t) => t > cutoff
    );

    // Refill tokens
    this.refillTokens();

    // Try to consume immediately
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }

    // Need to wait - add to queue
    this.stats.waitedRequests++;
    const waitStart = Date.now();

    return new Promise((resolve, reject) => {
      this.queue.push({
        resolve: () => {
          this.stats.totalWaitTime += Date.now() - waitStart;
          resolve();
        },
        reject,
        timestamp: Date.now(),
      });

      // Start processing queue if not already
      this.processQueue();
    });
  }

  /**
   * Release a token (optional, for explicit release patterns)
   */
  release(): void {
    // Token bucket doesn't require explicit release
    // But we could add tokens back if needed
  }

  /**
   * Try to acquire without waiting
   */
  tryAcquire(): boolean {
    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens--;
      this.stats.totalRequests++;
      return true;
    }

    return false;
  }

  /**
   * Get current available tokens
   */
  getAvailableTokens(): number {
    this.refillTokens();
    return Math.floor(this.tokens);
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  /**
   * Update rate limit configuration
   */
  configure(config: Partial<RateLimiterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set requests per second limit
   */
  setRate(requestsPerSecond: number): void {
    this.config.tokensPerInterval = requestsPerSecond;
    this.config.interval = 1000;
  }

  /**
   * Reset the limiter
   */
  reset(): void {
    this.tokens = this.config.maxBurst;
    this.lastRefill = Date.now();

    // Reject all pending requests
    for (const pending of this.queue) {
      pending.reject(new Error('Rate limiter reset'));
    }
    this.queue = [];
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  /**
   * Get rate limiter statistics
   */
  getStats(): RateLimiterStats {
    this.refillTokens();

    const avgWaitTime =
      this.stats.waitedRequests > 0
        ? this.stats.totalWaitTime / this.stats.waitedRequests
        : 0;

    // Calculate recent requests per second
    const now = Date.now();
    const recentWindow = 5000; // 5 second window
    const recentCount = this.stats.recentRequests.filter(
      (t) => t > now - recentWindow
    ).length;
    const requestsPerSecond = (recentCount / recentWindow) * 1000;

    return {
      totalRequests: this.stats.totalRequests,
      waitedRequests: this.stats.waitedRequests,
      totalWaitTime: this.stats.totalWaitTime,
      avgWaitTime,
      availableTokens: Math.floor(this.tokens),
      pendingRequests: this.queue.length,
      requestsPerSecond,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      waitedRequests: 0,
      totalWaitTime: 0,
      recentRequests: [],
    };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;

    if (elapsed > 0) {
      const tokensToAdd =
        (elapsed / this.config.interval) * this.config.tokensPerInterval;
      this.tokens = Math.min(this.config.maxBurst, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  /**
   * Process the waiting queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      this.refillTokens();

      if (this.tokens >= 1) {
        // Consume token and resolve oldest request
        this.tokens--;
        const pending = this.queue.shift()!;
        pending.resolve();
      } else {
        // Calculate wait time until next token
        const waitTime = Math.ceil(
          (this.config.interval / this.config.tokensPerInterval) *
            (1 - this.tokens)
        );
        await this.sleep(Math.max(1, waitTime));
      }
    }

    this.processing = false;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Sliding Window Rate Limiter
// ============================================================================

/**
 * Sliding window rate limiter for smoother rate limiting
 */
export class SlidingWindowRateLimiter {
  private windowSize: number;
  private maxRequests: number;
  private requests: number[] = [];
  private queue: PendingRequest[] = [];
  private processing = false;
  private debug: boolean;

  constructor(options: {
    windowSize?: number;
    maxRequests?: number;
    debug?: boolean;
  } = {}) {
    this.windowSize = options.windowSize || 1000;
    this.maxRequests = options.maxRequests || 10;
    this.debug = options.debug || false;
  }

  /**
   * Acquire permission to make a request
   */
  async acquire(): Promise<void> {
    this.cleanOldRequests();

    if (this.requests.length < this.maxRequests) {
      this.requests.push(Date.now());
      return;
    }

    // Need to wait
    return new Promise((resolve, reject) => {
      this.queue.push({
        resolve: () => {
          this.requests.push(Date.now());
          resolve();
        },
        reject,
        timestamp: Date.now(),
      });

      this.processQueue();
    });
  }

  /**
   * Release (no-op for sliding window)
   */
  release(): void {
    // No-op - sliding window doesn't need explicit release
  }

  /**
   * Get available request slots
   */
  getAvailableTokens(): number {
    this.cleanOldRequests();
    return Math.max(0, this.maxRequests - this.requests.length);
  }

  /**
   * Clean requests outside the window
   */
  private cleanOldRequests(): void {
    const cutoff = Date.now() - this.windowSize;
    this.requests = this.requests.filter((t) => t > cutoff);
  }

  /**
   * Process waiting queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      this.cleanOldRequests();

      if (this.requests.length < this.maxRequests) {
        const pending = this.queue.shift()!;
        pending.resolve();
      } else {
        // Wait until oldest request expires
        const oldestRequest = this.requests[0];
        const waitTime = oldestRequest + this.windowSize - Date.now();
        await this.sleep(Math.max(1, waitTime));
      }
    }

    this.processing = false;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Adaptive Rate Limiter
// ============================================================================

/**
 * Adaptive rate limiter that adjusts based on server responses
 */
export class AdaptiveRateLimiter {
  private baseRate: number;
  private currentRate: number;
  private minRate: number;
  private maxRate: number;
  private limiter: TokenBucketRateLimiter;
  private consecutiveSuccesses = 0;
  private consecutiveFailures = 0;
  private debug: boolean;

  constructor(options: {
    baseRate?: number;
    minRate?: number;
    maxRate?: number;
    debug?: boolean;
  } = {}) {
    this.baseRate = options.baseRate || 10;
    this.currentRate = this.baseRate;
    this.minRate = options.minRate || 1;
    this.maxRate = options.maxRate || 50;
    this.debug = options.debug || false;

    this.limiter = new TokenBucketRateLimiter({
      tokensPerInterval: this.currentRate,
      interval: 1000,
      maxBurst: this.currentRate * 2,
    });
  }

  /**
   * Acquire a token
   */
  async acquire(): Promise<void> {
    return this.limiter.acquire();
  }

  /**
   * Release a token
   */
  release(): void {
    this.limiter.release();
  }

  /**
   * Get available tokens
   */
  getAvailableTokens(): number {
    return this.limiter.getAvailableTokens();
  }

  /**
   * Report a successful request
   */
  reportSuccess(): void {
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;

    // Increase rate after 10 consecutive successes
    if (this.consecutiveSuccesses >= 10 && this.currentRate < this.maxRate) {
      this.currentRate = Math.min(this.maxRate, this.currentRate * 1.2);
      this.updateLimiter();
      this.consecutiveSuccesses = 0;

      if (this.debug) {
        console.log(`[AdaptiveRateLimiter] Increased rate to ${this.currentRate}`);
      }
    }
  }

  /**
   * Report a failed request (rate limit hit or error)
   */
  reportFailure(isRateLimited = false): void {
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;

    // Decrease rate on failures
    if (isRateLimited || this.consecutiveFailures >= 3) {
      this.currentRate = Math.max(this.minRate, this.currentRate * 0.5);
      this.updateLimiter();
      this.consecutiveFailures = 0;

      if (this.debug) {
        console.log(`[AdaptiveRateLimiter] Decreased rate to ${this.currentRate}`);
      }
    }
  }

  /**
   * Reset to base rate
   */
  reset(): void {
    this.currentRate = this.baseRate;
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures = 0;
    this.updateLimiter();
  }

  /**
   * Get current rate
   */
  getCurrentRate(): number {
    return this.currentRate;
  }

  /**
   * Update the underlying limiter
   */
  private updateLimiter(): void {
    this.limiter.configure({
      tokensPerInterval: this.currentRate,
      maxBurst: this.currentRate * 2,
    });
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a rate limiter with requests per second limit
 */
export function createRateLimiter(
  requestsPerSecond: number,
  options: Partial<RateLimiterConfig> = {}
): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter({
    tokensPerInterval: requestsPerSecond,
    interval: 1000,
    maxBurst: requestsPerSecond * 2,
    ...options,
  });
}

/**
 * Create an adaptive rate limiter
 */
export function createAdaptiveRateLimiter(
  baseRate: number,
  options: { minRate?: number; maxRate?: number; debug?: boolean } = {}
): AdaptiveRateLimiter {
  return new AdaptiveRateLimiter({
    baseRate,
    ...options,
  });
}

/**
 * Create a no-op rate limiter (for testing or when rate limiting is disabled)
 */
export function createNoOpRateLimiter(): {
  acquire: () => Promise<void>;
  release: () => void;
  getAvailableTokens: () => number;
} {
  return {
    acquire: async () => {},
    release: () => {},
    getAvailableTokens: () => Infinity,
  };
}

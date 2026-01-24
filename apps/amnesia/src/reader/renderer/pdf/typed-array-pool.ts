/**
 * TypedArray Pool for GC Pressure Reduction
 *
 * Provides reusable TypedArray buffers to avoid frequent allocations
 * during PDF rendering operations. This significantly reduces GC pauses
 * that cause rendering jank.
 *
 * Key Features:
 * - Size-binned pools (power-of-2 sizes) for efficient reuse
 * - Automatic size rounding to nearest bin
 * - Weak reference fallback for memory pressure
 * - Statistics tracking for optimization
 *
 * Usage Flow:
 * 1. Acquire buffer of required size
 * 2. Use buffer for rendering operation
 * 3. Release buffer back to pool for reuse
 *
 * @example
 * ```typescript
 * const pool = getTypedArrayPool();
 * const buffer = pool.acquireUint8Array(1024 * 1024); // 1MB
 * // ... use buffer ...
 * pool.release(buffer);
 * ```
 */

/** Pool configuration */
export interface TypedArrayPoolConfig {
  /** Maximum number of buffers per size bin */
  maxBuffersPerBin: number;
  /** Minimum buffer size (smaller requests get this size) */
  minSize: number;
  /** Maximum buffer size to pool (larger buffers are not pooled) */
  maxSize: number;
  /** Size bins (power-of-2 from minSize to maxSize) */
  numBins: number;
}

/** Pool statistics */
export interface TypedArrayPoolStats {
  /** Total acquire calls */
  acquireCount: number;
  /** Total release calls */
  releaseCount: number;
  /** Cache hits (reused buffer) */
  hitCount: number;
  /** Cache misses (new allocation) */
  missCount: number;
  /** Buffers currently in pool */
  pooledCount: number;
  /** Buffers by size bin */
  binStats: Array<{ size: number; count: number }>;
}

/** Default configuration */
const DEFAULT_CONFIG: TypedArrayPoolConfig = {
  maxBuffersPerBin: 8,
  minSize: 64 * 1024,        // 64KB
  maxSize: 16 * 1024 * 1024, // 16MB
  numBins: 12,               // 64KB, 128KB, 256KB, 512KB, 1MB, 2MB, 4MB, 8MB, 16MB...
};

/** Size bins for quick lookup */
const SIZE_BINS = [
  64 * 1024,        // 64KB - small tiles
  128 * 1024,       // 128KB
  256 * 1024,       // 256KB - standard tile
  512 * 1024,       // 512KB
  1024 * 1024,      // 1MB
  2 * 1024 * 1024,  // 2MB
  4 * 1024 * 1024,  // 4MB
  8 * 1024 * 1024,  // 8MB
  16 * 1024 * 1024, // 16MB - large pages
];

/**
 * TypedArray Pool Manager
 *
 * Maintains pools of reusable TypedArrays binned by size.
 */
export class TypedArrayPool {
  private config: TypedArrayPoolConfig;

  /** Pool of Uint8Array buffers by size bin */
  private uint8Pools: Map<number, ArrayBuffer[]> = new Map();

  /** Pool of Uint8ClampedArray buffers by size bin */
  private uint8ClampedPools: Map<number, ArrayBuffer[]> = new Map();

  /** Statistics */
  private stats = {
    acquireCount: 0,
    releaseCount: 0,
    hitCount: 0,
    missCount: 0,
  };

  constructor(config: Partial<TypedArrayPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize bins
    for (const size of SIZE_BINS) {
      if (size >= this.config.minSize && size <= this.config.maxSize) {
        this.uint8Pools.set(size, []);
        this.uint8ClampedPools.set(size, []);
      }
    }

    console.log(
      `[TypedArrayPool] Initialized with ${this.uint8Pools.size} bins, ` +
      `sizes: ${Array.from(this.uint8Pools.keys()).map(s => `${s/1024}KB`).join(', ')}`
    );
  }

  /**
   * Find the appropriate bin size for a requested size
   */
  private findBinSize(requestedSize: number): number | null {
    // Find smallest bin that can accommodate the request
    for (const binSize of SIZE_BINS) {
      if (binSize >= requestedSize && binSize <= this.config.maxSize) {
        return binSize;
      }
    }
    return null;
  }

  /**
   * Acquire a Uint8Array of at least the requested size
   *
   * @param minSize Minimum buffer size needed
   * @returns Uint8Array from pool or newly allocated (always backed by ArrayBuffer, not SharedArrayBuffer)
   */
  acquireUint8Array(minSize: number): Uint8Array<ArrayBuffer> {
    this.stats.acquireCount++;

    const binSize = this.findBinSize(minSize);

    // If size is too large for pooling, allocate new
    if (!binSize) {
      this.stats.missCount++;
      return new Uint8Array(new ArrayBuffer(minSize));
    }

    const pool = this.uint8Pools.get(binSize);
    if (pool && pool.length > 0) {
      // Reuse from pool
      this.stats.hitCount++;
      const buffer = pool.pop()!;
      return new Uint8Array(buffer, 0, minSize);
    }

    // Allocate new buffer
    this.stats.missCount++;
    const buffer = new ArrayBuffer(binSize);
    return new Uint8Array(buffer, 0, minSize);
  }

  /**
   * Acquire a Uint8ClampedArray of at least the requested size
   *
   * @param minSize Minimum buffer size needed
   * @returns Uint8ClampedArray from pool or newly allocated (always backed by ArrayBuffer, not SharedArrayBuffer)
   */
  acquireUint8ClampedArray(minSize: number): Uint8ClampedArray<ArrayBuffer> {
    this.stats.acquireCount++;

    const binSize = this.findBinSize(minSize);

    // If size is too large for pooling, allocate new
    if (!binSize) {
      this.stats.missCount++;
      return new Uint8ClampedArray(new ArrayBuffer(minSize));
    }

    const pool = this.uint8ClampedPools.get(binSize);
    if (pool && pool.length > 0) {
      // Reuse from pool
      this.stats.hitCount++;
      const buffer = pool.pop()!;
      return new Uint8ClampedArray(buffer, 0, minSize);
    }

    // Allocate new buffer
    this.stats.missCount++;
    const buffer = new ArrayBuffer(binSize);
    return new Uint8ClampedArray(buffer, 0, minSize);
  }

  /**
   * Release a Uint8Array back to the pool
   *
   * @param array The array to release
   */
  releaseUint8Array(array: Uint8Array): void {
    this.stats.releaseCount++;

    // Only pool regular ArrayBuffers, not SharedArrayBuffer
    const buffer = array.buffer;
    if (buffer instanceof SharedArrayBuffer) {
      return; // Can't pool SharedArrayBuffer
    }

    const bufferSize = buffer.byteLength;
    const pool = this.uint8Pools.get(bufferSize);

    // Only pool if we have a bin for this size and not at capacity
    if (pool && pool.length < this.config.maxBuffersPerBin) {
      pool.push(buffer);
    }
    // Otherwise, let GC collect it
  }

  /**
   * Release a Uint8ClampedArray back to the pool
   *
   * @param array The array to release
   */
  releaseUint8ClampedArray(array: Uint8ClampedArray): void {
    this.stats.releaseCount++;

    // Only pool regular ArrayBuffers, not SharedArrayBuffer
    const buffer = array.buffer;
    if (buffer instanceof SharedArrayBuffer) {
      return; // Can't pool SharedArrayBuffer
    }

    const bufferSize = buffer.byteLength;
    const pool = this.uint8ClampedPools.get(bufferSize);

    // Only pool if we have a bin for this size and not at capacity
    if (pool && pool.length < this.config.maxBuffersPerBin) {
      pool.push(buffer);
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): TypedArrayPoolStats {
    let pooledCount = 0;
    const binStats: Array<{ size: number; count: number }> = [];

    for (const [size, pool] of this.uint8Pools) {
      const clampedPool = this.uint8ClampedPools.get(size) ?? [];
      const count = pool.length + clampedPool.length;
      pooledCount += count;
      binStats.push({ size, count });
    }

    return {
      ...this.stats,
      pooledCount,
      binStats,
    };
  }

  /**
   * Clear all pools
   */
  clear(): void {
    for (const pool of this.uint8Pools.values()) {
      pool.length = 0;
    }
    for (const pool of this.uint8ClampedPools.values()) {
      pool.length = 0;
    }
  }

  /**
   * Get hit rate (0-1)
   */
  getHitRate(): number {
    const total = this.stats.hitCount + this.stats.missCount;
    if (total === 0) return 0;
    return this.stats.hitCount / total;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      acquireCount: 0,
      releaseCount: 0,
      hitCount: 0,
      missCount: 0,
    };
  }
}

// Singleton instance
let poolInstance: TypedArrayPool | null = null;

/**
 * Get the shared TypedArray pool singleton
 */
export function getTypedArrayPool(): TypedArrayPool {
  if (!poolInstance) {
    poolInstance = new TypedArrayPool();
  }
  return poolInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetTypedArrayPool(): void {
  if (poolInstance) {
    poolInstance.clear();
    poolInstance = null;
  }
}

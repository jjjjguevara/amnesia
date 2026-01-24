/**
 * SharedArrayBuffer Pool for Zero-Copy Tile Transfer
 *
 * Provides a pool of pre-allocated SharedArrayBuffer instances for transferring
 * rendered tile data between workers and the main thread without copying.
 *
 * Key Features:
 * - Pre-allocated slots to avoid runtime allocation overhead
 * - Atomics-based status tracking for thread-safe acquire/release
 * - Multiple size tiers for different tile sizes
 * - Automatic fallback to regular ArrayBuffer if SAB unavailable
 *
 * Usage Flow:
 * 1. Main thread creates pool and passes SAB references to workers
 * 2. Worker acquires slot, renders directly into SAB
 * 3. Worker notifies main thread with slot index
 * 4. Main thread reads data directly from SAB (zero-copy)
 * 5. Main thread releases slot back to pool
 *
 * @example
 * ```typescript
 * const pool = getSharedBufferPool();
 * const slot = pool.acquire(256 * 256 * 4); // RGBA tile
 * // ... render into slot.buffer ...
 * pool.release(slot.index);
 * ```
 */

import { getFeatureFlags } from './feature-flags';

/** Slot status values for Atomics operations */
const SLOT_FREE = 0;
const SLOT_ACQUIRED = 1;

/** Size tiers for different tile dimensions (in bytes, RGBA format) */
export const BUFFER_SIZE_TIERS = {
  /** 256x256 tile = 256KB */
  TILE_256: 256 * 256 * 4,
  /** 512x512 tile = 1MB */
  TILE_512: 512 * 512 * 4,
  /** 1024x1024 tile = 4MB */
  TILE_1024: 1024 * 1024 * 4,
  /** Full page at low res (1024x1408) ~5.7MB */
  PAGE_LOW: 1024 * 1408 * 4,
  /** Full page at high res (2048x2816) ~23MB */
  PAGE_HIGH: 2048 * 2816 * 4,
} as const;

/** Acquired buffer slot information */
export interface BufferSlot {
  /** Slot index for release */
  index: number;
  /** SharedArrayBuffer (or ArrayBuffer fallback) */
  buffer: SharedArrayBuffer | ArrayBuffer;
  /** Uint8Array view for data access */
  view: Uint8Array;
  /** Actual usable size in bytes */
  size: number;
  /** Whether this is a SharedArrayBuffer (true) or fallback (false) */
  isShared: boolean;
}

/** Pool configuration */
export interface SharedBufferPoolConfig {
  /** Number of slots per size tier */
  slotsPerTier: number;
  /** Which size tiers to enable */
  enabledTiers: (keyof typeof BUFFER_SIZE_TIERS)[];
}

/** Default configuration */
const DEFAULT_CONFIG: SharedBufferPoolConfig = {
  slotsPerTier: 8,
  enabledTiers: ['TILE_256', 'TILE_512', 'PAGE_LOW'],
};

/**
 * SharedArrayBuffer Pool Manager
 *
 * Manages a pool of pre-allocated SharedArrayBuffer instances for zero-copy
 * data transfer between workers and main thread.
 */
export class SharedBufferPool {
  private config: SharedBufferPoolConfig;
  private isAvailable: boolean;

  /** Pool of buffers organized by size tier */
  private pools: Map<number, SharedArrayBuffer[]> = new Map();

  /** Status arrays for each tier (Atomics-compatible) */
  private statusArrays: Map<number, Int32Array> = new Map();

  /** Fallback regular ArrayBuffers when SAB unavailable */
  private fallbackBuffers: Map<number, ArrayBuffer[]> = new Map();
  private fallbackStatus: Map<number, boolean[]> = new Map();

  /** Statistics */
  private stats = {
    acquireCount: 0,
    releaseCount: 0,
    fallbackCount: 0,
    waitCount: 0,
  };

  constructor(config: Partial<SharedBufferPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.isAvailable = this.checkAvailability();
    this.initializePools();
  }

  /**
   * Check if SharedArrayBuffer is available
   */
  private checkAvailability(): boolean {
    const flags = getFeatureFlags();
    const resolved = flags.resolveFlags();
    return resolved.useSharedArrayBuffer;
  }

  /**
   * Initialize buffer pools for each enabled tier
   */
  private initializePools(): void {
    for (const tierName of this.config.enabledTiers) {
      const size = BUFFER_SIZE_TIERS[tierName];
      this.initializeTier(size);
    }

    console.log(
      `[SharedBufferPool] Initialized: SAB=${this.isAvailable}, ` +
        `tiers=${this.config.enabledTiers.join(',')}, ` +
        `slots=${this.config.slotsPerTier}/tier`
    );
  }

  /**
   * Initialize a single size tier
   */
  private initializeTier(size: number): void {
    const slotCount = this.config.slotsPerTier;

    if (this.isAvailable) {
      // Create SharedArrayBuffer pool
      const buffers: SharedArrayBuffer[] = [];
      for (let i = 0; i < slotCount; i++) {
        buffers.push(new SharedArrayBuffer(size));
      }
      this.pools.set(size, buffers);

      // Create status array using SharedArrayBuffer for Atomics
      const statusBuffer = new SharedArrayBuffer(slotCount * Int32Array.BYTES_PER_ELEMENT);
      const statusArray = new Int32Array(statusBuffer);
      // All slots start as FREE (0)
      this.statusArrays.set(size, statusArray);
    } else {
      // Fallback: regular ArrayBuffer pool
      const buffers: ArrayBuffer[] = [];
      const status: boolean[] = [];
      for (let i = 0; i < slotCount; i++) {
        buffers.push(new ArrayBuffer(size));
        status.push(false); // false = free
      }
      this.fallbackBuffers.set(size, buffers);
      this.fallbackStatus.set(size, status);
    }
  }

  /**
   * Find the appropriate tier for a requested size
   */
  private findTierSize(requestedSize: number): number | null {
    const sortedSizes = Array.from(this.pools.keys())
      .concat(Array.from(this.fallbackBuffers.keys()))
      .filter((v, i, a) => a.indexOf(v) === i) // unique
      .sort((a, b) => a - b);

    for (const size of sortedSizes) {
      if (size >= requestedSize) {
        return size;
      }
    }
    return null;
  }

  /**
   * Acquire a buffer slot for rendering
   *
   * @param minSize Minimum buffer size needed in bytes
   * @returns BufferSlot or null if no slots available
   */
  acquire(minSize: number): BufferSlot | null {
    const tierSize = this.findTierSize(minSize);
    if (tierSize === null) {
      console.warn(`[SharedBufferPool] No tier large enough for ${minSize} bytes`);
      return null;
    }

    this.stats.acquireCount++;

    if (this.isAvailable) {
      return this.acquireShared(tierSize);
    } else {
      return this.acquireFallback(tierSize);
    }
  }

  /**
   * Acquire from SharedArrayBuffer pool using Atomics
   */
  private acquireShared(tierSize: number): BufferSlot | null {
    const buffers = this.pools.get(tierSize);
    const statusArray = this.statusArrays.get(tierSize);

    if (!buffers || !statusArray) return null;

    // Try to find and atomically acquire a free slot
    for (let i = 0; i < buffers.length; i++) {
      // Atomically compare-and-swap: if FREE, set to ACQUIRED
      const oldValue = Atomics.compareExchange(statusArray, i, SLOT_FREE, SLOT_ACQUIRED);

      if (oldValue === SLOT_FREE) {
        // Successfully acquired
        const buffer = buffers[i];
        return {
          index: i,
          buffer,
          view: new Uint8Array(buffer),
          size: tierSize,
          isShared: true,
        };
      }
    }

    // No free slots - track for metrics
    this.stats.waitCount++;
    console.warn(`[SharedBufferPool] No free slots for tier ${tierSize}`);
    return null;
  }

  /**
   * Acquire from fallback ArrayBuffer pool
   */
  private acquireFallback(tierSize: number): BufferSlot | null {
    const buffers = this.fallbackBuffers.get(tierSize);
    const status = this.fallbackStatus.get(tierSize);

    if (!buffers || !status) return null;

    this.stats.fallbackCount++;

    for (let i = 0; i < buffers.length; i++) {
      if (!status[i]) {
        status[i] = true; // Mark as acquired
        const buffer = buffers[i];
        return {
          index: i,
          buffer,
          view: new Uint8Array(buffer),
          size: tierSize,
          isShared: false,
        };
      }
    }

    console.warn(`[SharedBufferPool] No free fallback slots for tier ${tierSize}`);
    return null;
  }

  /**
   * Release a buffer slot back to the pool
   *
   * @param slot The slot to release (or just index and size)
   */
  release(slot: BufferSlot | { index: number; size: number; isShared: boolean }): void {
    this.stats.releaseCount++;

    if (slot.isShared) {
      this.releaseShared(slot.index, slot.size);
    } else {
      this.releaseFallback(slot.index, slot.size);
    }
  }

  /**
   * Release SharedArrayBuffer slot using Atomics
   */
  private releaseShared(index: number, tierSize: number): void {
    const statusArray = this.statusArrays.get(tierSize);
    if (!statusArray) {
      console.error(`[SharedBufferPool] Unknown tier ${tierSize} for release`);
      return;
    }

    // Atomically set slot to FREE
    Atomics.store(statusArray, index, SLOT_FREE);
  }

  /**
   * Release fallback ArrayBuffer slot
   */
  private releaseFallback(index: number, tierSize: number): void {
    const status = this.fallbackStatus.get(tierSize);
    if (!status) {
      console.error(`[SharedBufferPool] Unknown fallback tier ${tierSize}`);
      return;
    }

    status[index] = false;
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    acquireCount: number;
    releaseCount: number;
    fallbackCount: number;
    waitCount: number;
    isSharedAvailable: boolean;
    tierStats: { size: number; free: number; total: number }[];
  } {
    const tierStats: { size: number; free: number; total: number }[] = [];

    if (this.isAvailable) {
      for (const [size, statusArray] of this.statusArrays) {
        let free = 0;
        for (let i = 0; i < statusArray.length; i++) {
          if (Atomics.load(statusArray, i) === SLOT_FREE) {
            free++;
          }
        }
        tierStats.push({ size, free, total: statusArray.length });
      }
    } else {
      for (const [size, status] of this.fallbackStatus) {
        const free = status.filter((s) => !s).length;
        tierStats.push({ size, free, total: status.length });
      }
    }

    return {
      ...this.stats,
      isSharedAvailable: this.isAvailable,
      tierStats,
    };
  }

  /**
   * Get the SharedArrayBuffer references for passing to workers
   * Workers need these references to write directly into shared memory
   */
  getBufferReferences(): Map<number, SharedArrayBuffer[]> | null {
    if (!this.isAvailable) return null;
    return new Map(this.pools);
  }

  /**
   * Get status array references for workers to use Atomics
   */
  getStatusReferences(): Map<number, Int32Array> | null {
    if (!this.isAvailable) return null;
    return new Map(this.statusArrays);
  }

  /**
   * Check if SharedArrayBuffer is being used
   */
  isSharedArrayBufferEnabled(): boolean {
    return this.isAvailable;
  }

  /**
   * Reset pool (for testing)
   */
  reset(): void {
    // Release all slots
    if (this.isAvailable) {
      for (const statusArray of this.statusArrays.values()) {
        for (let i = 0; i < statusArray.length; i++) {
          Atomics.store(statusArray, i, SLOT_FREE);
        }
      }
    } else {
      for (const status of this.fallbackStatus.values()) {
        status.fill(false);
      }
    }

    this.stats = {
      acquireCount: 0,
      releaseCount: 0,
      fallbackCount: 0,
      waitCount: 0,
    };
  }

  /**
   * Destroy pool and release all memory
   */
  destroy(): void {
    this.pools.clear();
    this.statusArrays.clear();
    this.fallbackBuffers.clear();
    this.fallbackStatus.clear();
  }
}

// Singleton instance
let poolInstance: SharedBufferPool | null = null;

/**
 * Get the shared buffer pool singleton
 */
export function getSharedBufferPool(): SharedBufferPool {
  if (!poolInstance) {
    poolInstance = new SharedBufferPool();
  }
  return poolInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetSharedBufferPool(): void {
  if (poolInstance) {
    poolInstance.destroy();
    poolInstance = null;
  }
}

/**
 * Check if SharedArrayBuffer pool is available
 */
export function isSharedBufferPoolAvailable(): boolean {
  return getSharedBufferPool().isSharedArrayBufferEnabled();
}

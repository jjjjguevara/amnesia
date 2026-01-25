/**
 * Performance Configuration Module
 * 
 * Maps device tiers to rendering parameters for optimal performance.
 * Auto-configures based on detected device capabilities, with support
 * for manual overrides via settings.
 * 
 * @module performance-config
 */

import { getDeviceTier, getDeviceProfileSync, type DeviceTier, type DeviceProfile } from './device-profiler';
import type { ScaleTier } from './progressive-tile-renderer';

/**
 * Performance configuration for a device tier
 */
export interface PerformanceConfig {
  /** Maximum scale tier (affects rendering quality at high zoom) */
  maxScaleTier: ScaleTier;
  
  /** L1 cache size (hot tiles, ImageBitmaps) */
  l1CacheSize: number;
  
  /** L2 cache size (prefetch tiles, ArrayBuffers) */
  l2CacheSize: number;
  
  /** L2 cache memory limit in MB */
  l2CacheMB: number;
  
  /** Maximum concurrent tile renders */
  maxConcurrentRenders: number;
  
  /** Prefetch radius (pages ahead/behind to prefetch) */
  prefetchRadius: number;
  
  /** Retry queue maximum size */
  retryQueueSize: number;
  
  /** Worker pool size */
  workerCount: number;
  
  /** Semaphore queue limit (max pending requests) */
  semaphoreQueueLimit: number;
  
  /** Enable WebGL compositing if available */
  enableWebGLCompositing: boolean;
  
  /** Enable content-type detection and optimization */
  enableContentTypeDetection: boolean;
  
  /** Quality settings */
  quality: {
    /** Minimum quality factor during fast gestures (0-1) */
    minQualityDuringGesture: number;
    /** Quality upgrade delay after gesture ends (ms) */
    qualityUpgradeDelayMs: number;
    /** Target FPS for quality adaptation */
    targetFps: number;
  };
  
  /** Timing settings */
  timing: {
    /** Settling delay after gesture ends (ms) */
    settlingDelayMs: number;
    /** Debounce for scroll renders (ms) */
    scrollDebounceMs: number;
    /** Phase watchdog timeout (ms) */
    phaseWatchdogMs: number;
  };
}

/**
 * Tier-based performance configurations
 */
const TIER_CONFIGS: Record<DeviceTier, PerformanceConfig> = {
  low: {
    maxScaleTier: 8 as ScaleTier,
    l1CacheSize: 100,
    l2CacheSize: 180,
    l2CacheMB: 180,
    maxConcurrentRenders: 2,
    prefetchRadius: 1,
    retryQueueSize: 50,
    workerCount: 1,
    semaphoreQueueLimit: 200,
    enableWebGLCompositing: false,
    enableContentTypeDetection: true,
    quality: {
      minQualityDuringGesture: 0.25,
      qualityUpgradeDelayMs: 300,
      targetFps: 30,
    },
    timing: {
      settlingDelayMs: 200,
      scrollDebounceMs: 50,
      phaseWatchdogMs: 5000,
    },
  },
  
  medium: {
    maxScaleTier: 16 as ScaleTier,
    l1CacheSize: 200,
    l2CacheSize: 360,
    l2CacheMB: 360,
    maxConcurrentRenders: 4,
    prefetchRadius: 2,
    retryQueueSize: 100,
    workerCount: 2,
    semaphoreQueueLimit: 300,
    enableWebGLCompositing: true,
    enableContentTypeDetection: true,
    quality: {
      minQualityDuringGesture: 0.35,
      qualityUpgradeDelayMs: 250,
      targetFps: 45,
    },
    timing: {
      settlingDelayMs: 150,
      scrollDebounceMs: 40,
      phaseWatchdogMs: 4000,
    },
  },
  
  high: {
    maxScaleTier: 32 as ScaleTier,
    l1CacheSize: 300,
    l2CacheSize: 540,
    l2CacheMB: 540,
    maxConcurrentRenders: 6,
    prefetchRadius: 3,
    retryQueueSize: 150,
    workerCount: 3,
    semaphoreQueueLimit: 400,
    enableWebGLCompositing: true,
    enableContentTypeDetection: true,
    quality: {
      minQualityDuringGesture: 0.5,
      qualityUpgradeDelayMs: 200,
      targetFps: 55,
    },
    timing: {
      settlingDelayMs: 100,
      scrollDebounceMs: 32,
      phaseWatchdogMs: 3000,
    },
  },
  
  extreme: {
    maxScaleTier: 64 as ScaleTier,
    l1CacheSize: 500,
    l2CacheSize: 900,
    l2CacheMB: 900,
    maxConcurrentRenders: 8,
    prefetchRadius: 4,
    retryQueueSize: 200,
    workerCount: 4,
    semaphoreQueueLimit: 500,
    enableWebGLCompositing: true,
    enableContentTypeDetection: true,
    quality: {
      minQualityDuringGesture: 0.65,
      qualityUpgradeDelayMs: 150,
      targetFps: 60,
    },
    timing: {
      settlingDelayMs: 80,
      scrollDebounceMs: 24,
      phaseWatchdogMs: 3000,
    },
  },
};

/**
 * Current configuration state
 */
let currentConfig: PerformanceConfig | null = null;
let currentTier: DeviceTier | null = null;
let configOverrides: Partial<PerformanceConfig> = {};
let configListeners: Array<(config: PerformanceConfig, tier: DeviceTier) => void> = [];

/**
 * Get the current performance configuration
 * Auto-initializes based on device tier if not already initialized
 */
export function getPerformanceConfig(): PerformanceConfig {
  if (!currentConfig) {
    initializeConfig();
  }
  return currentConfig!;
}

/**
 * Get current device tier
 */
export function getCurrentTier(): DeviceTier {
  if (!currentTier) {
    currentTier = getDeviceTier();
  }
  return currentTier;
}

/**
 * Initialize or re-initialize configuration based on device tier
 */
export function initializeConfig(forceTier?: DeviceTier): void {
  const tier = forceTier ?? getDeviceTier();
  currentTier = tier;
  
  // Start with tier defaults
  const baseConfig = { ...TIER_CONFIGS[tier] };
  
  // Apply any overrides
  currentConfig = applyOverrides(baseConfig, configOverrides);
  
  // Notify listeners
  notifyListeners();
  
  // Log configuration
  const profile = getDeviceProfileSync();
  console.log(`[PerformanceConfig] Initialized for tier '${tier}':`, {
    device: {
      memory: `${profile.memory.totalGB}GB`,
      cpu: `${profile.cpu.cores} cores`,
      gpu: profile.gpu.renderer,
    },
    config: {
      maxScale: currentConfig.maxScaleTier,
      caches: `L1:${currentConfig.l1CacheSize}, L2:${currentConfig.l2CacheSize}`,
      workers: currentConfig.workerCount,
      concurrent: currentConfig.maxConcurrentRenders,
    },
  });
}

/**
 * Apply partial overrides to a configuration
 */
function applyOverrides(
  base: PerformanceConfig, 
  overrides: Partial<PerformanceConfig>
): PerformanceConfig {
  const result = { ...base };
  
  // Apply top-level overrides
  for (const key of Object.keys(overrides) as Array<keyof PerformanceConfig>) {
    if (overrides[key] !== undefined) {
      if (typeof overrides[key] === 'object' && overrides[key] !== null) {
        // Merge nested objects
        (result[key] as Record<string, unknown>) = {
          ...(base[key] as Record<string, unknown>),
          ...(overrides[key] as Record<string, unknown>),
        };
      } else {
        // Direct assignment for primitives
        (result[key] as unknown) = overrides[key];
      }
    }
  }
  
  return result;
}

/**
 * Set configuration overrides
 * These persist across tier changes until cleared
 */
export function setConfigOverrides(overrides: Partial<PerformanceConfig>): void {
  configOverrides = { ...configOverrides, ...overrides };
  
  if (currentConfig) {
    // Re-apply overrides to current config
    const tier = currentTier ?? getDeviceTier();
    currentConfig = applyOverrides(TIER_CONFIGS[tier], configOverrides);
    notifyListeners();
  }
  
  console.log('[PerformanceConfig] Overrides applied:', overrides);
}

/**
 * Clear all configuration overrides
 */
export function clearConfigOverrides(): void {
  configOverrides = {};
  
  if (currentTier) {
    currentConfig = { ...TIER_CONFIGS[currentTier] };
    notifyListeners();
  }
  
  console.log('[PerformanceConfig] Overrides cleared');
}

/**
 * Get current overrides
 */
export function getConfigOverrides(): Partial<PerformanceConfig> {
  return { ...configOverrides };
}

/**
 * Force a specific tier (for testing or user preference)
 */
export function forceTier(tier: DeviceTier): void {
  initializeConfig(tier);
}

/**
 * Reset to auto-detected tier
 */
export function resetToAutoTier(): void {
  currentTier = null;
  initializeConfig();
}

/**
 * Add a configuration change listener
 */
export function addConfigListener(
  listener: (config: PerformanceConfig, tier: DeviceTier) => void
): () => void {
  configListeners.push(listener);
  
  // Return unsubscribe function
  return () => {
    const index = configListeners.indexOf(listener);
    if (index >= 0) {
      configListeners.splice(index, 1);
    }
  };
}

/**
 * Notify all listeners of configuration change
 */
function notifyListeners(): void {
  if (!currentConfig || !currentTier) return;
  
  for (const listener of configListeners) {
    try {
      listener(currentConfig, currentTier);
    } catch (e) {
      console.error('[PerformanceConfig] Listener error:', e);
    }
  }
}

/**
 * Get configuration for a specific tier (without setting it)
 */
export function getConfigForTier(tier: DeviceTier): PerformanceConfig {
  return { ...TIER_CONFIGS[tier] };
}

/**
 * Get all tier configurations
 */
export function getAllTierConfigs(): Record<DeviceTier, PerformanceConfig> {
  return {
    low: { ...TIER_CONFIGS.low },
    medium: { ...TIER_CONFIGS.medium },
    high: { ...TIER_CONFIGS.high },
    extreme: { ...TIER_CONFIGS.extreme },
  };
}

/**
 * Compare current config to another tier's config
 */
export function compareToTier(tier: DeviceTier): Record<string, { current: unknown; other: unknown }> {
  const current = getPerformanceConfig();
  const other = TIER_CONFIGS[tier];
  const differences: Record<string, { current: unknown; other: unknown }> = {};
  
  for (const key of Object.keys(current) as Array<keyof PerformanceConfig>) {
    if (typeof current[key] !== 'object') {
      if (current[key] !== other[key]) {
        differences[key] = { current: current[key], other: other[key] };
      }
    }
  }
  
  return differences;
}

/**
 * Validate that current config is appropriate for device
 */
export function validateConfig(): { valid: boolean; warnings: string[] } {
  const profile = getDeviceProfileSync();
  const config = getPerformanceConfig();
  const warnings: string[] = [];
  
  // Check memory vs cache size
  const estimatedCacheMemoryMB = 
    (config.l1CacheSize * 0.5) + // ~0.5MB per L1 tile (ImageBitmap)
    (config.l2CacheSize * 0.3);  // ~0.3MB per L2 tile (compressed)
  
  if (estimatedCacheMemoryMB > profile.memory.totalGB * 1024 * 0.1) {
    warnings.push(`Cache size (${estimatedCacheMemoryMB.toFixed(0)}MB) may be too large for ${profile.memory.totalGB}GB RAM`);
  }
  
  // Check worker count vs CPU cores
  if (config.workerCount > profile.cpu.cores) {
    warnings.push(`Worker count (${config.workerCount}) exceeds CPU cores (${profile.cpu.cores})`);
  }
  
  // Check max scale vs GPU limits
  const maxTilePixels = config.maxScaleTier * 256; // Assuming 256px tiles
  if (maxTilePixels > profile.gpu.maxTextureSize) {
    warnings.push(`Max tile size (${maxTilePixels}px) exceeds GPU max texture (${profile.gpu.maxTextureSize}px)`);
  }
  
  // Check WebGL availability
  if (config.enableWebGLCompositing && !profile.gpu.hasWebGL2) {
    warnings.push('WebGL compositing enabled but WebGL2 not available');
  }
  
  return {
    valid: warnings.length === 0,
    warnings,
  };
}

/**
 * Export configuration as JSON (for debugging/logging)
 */
export function exportConfigAsJSON(): string {
  const profile = getDeviceProfileSync();
  const config = getPerformanceConfig();
  
  return JSON.stringify({
    device: {
      tier: currentTier,
      memory: profile.memory,
      cpu: profile.cpu,
      gpu: {
        renderer: profile.gpu.renderer,
        maxTextureSize: profile.gpu.maxTextureSize,
        hasWebGL2: profile.gpu.hasWebGL2,
      },
    },
    config,
    overrides: configOverrides,
    validation: validateConfig(),
    timestamp: new Date().toISOString(),
  }, null, 2);
}

// Singleton accessor
let performanceConfigInstance: {
  getConfig: typeof getPerformanceConfig;
  getTier: typeof getCurrentTier;
  setOverrides: typeof setConfigOverrides;
  clearOverrides: typeof clearConfigOverrides;
  forceTier: typeof forceTier;
  resetTier: typeof resetToAutoTier;
  addListener: typeof addConfigListener;
  validate: typeof validateConfig;
  export: typeof exportConfigAsJSON;
} | null = null;

export function getPerformanceConfigManager() {
  if (!performanceConfigInstance) {
    performanceConfigInstance = {
      getConfig: getPerformanceConfig,
      getTier: getCurrentTier,
      setOverrides: setConfigOverrides,
      clearOverrides: clearConfigOverrides,
      forceTier: forceTier,
      resetTier: resetToAutoTier,
      addListener: addConfigListener,
      validate: validateConfig,
      export: exportConfigAsJSON,
    };
  }
  return performanceConfigInstance;
}

// Expose to window for debugging
if (typeof window !== 'undefined') {
  (window as unknown as { performanceConfig: ReturnType<typeof getPerformanceConfigManager> }).performanceConfig = getPerformanceConfigManager();
}

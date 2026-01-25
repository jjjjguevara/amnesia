/**
 * Device Profiler Module
 * 
 * Detects actual system capabilities using Electron/Node.js APIs,
 * bypassing browser privacy restrictions (e.g., navigator.deviceMemory capped at 8GB).
 * 
 * Uses:
 * - os.totalmem() for actual RAM (not capped)
 * - os.cpus() for CPU info
 * - WebGL for GPU capabilities
 * - process.getSystemMemoryInfo() for Electron-specific memory info
 * 
 * @module device-profiler
 */

// Electron process extensions (not in standard Node.js types)
interface ElectronProcess {
  getSystemMemoryInfo?: () => { total: number; free: number };
  getHeapStatistics?: () => { 
    totalHeapSize: number;
    totalHeapSizeExecutable: number;
    totalPhysicalSize: number;
    totalAvailableSize: number;
    usedHeapSize: number;
    heapSizeLimit: number;
    mallocedMemory: number;
    peakMallocedMemory: number;
    doesZapGarbage: boolean;
  };
  versions?: {
    electron?: string;
    chrome?: string;
    node?: string;
  };
}

// Cast process to include Electron extensions
const electronProcess = (typeof process !== 'undefined' ? process : null) as (NodeJS.Process & ElectronProcess) | null;

/** Device performance tier */
export type DeviceTier = 'low' | 'medium' | 'high' | 'extreme';

/** Memory information */
export interface MemoryInfo {
  /** Total system RAM in GB */
  totalGB: number;
  /** Free system RAM in GB */
  freeGB: number;
  /** V8 heap size limit in MB */
  heapLimitMB: number;
  /** Detection source */
  source: 'os.totalmem' | 'process.getSystemMemoryInfo' | 'navigator.deviceMemory' | 'fallback';
}

/** CPU information */
export interface CpuInfo {
  /** Number of logical cores */
  cores: number;
  /** CPU model name */
  model: string;
  /** CPU speed in MHz */
  speedMHz: number;
  /** Whether this is Apple Silicon */
  isAppleSilicon: boolean;
  /** Architecture (arm64, x64, etc.) */
  arch: string;
}

/** GPU information from WebGL */
export interface GpuInfo {
  /** GPU vendor */
  vendor: string;
  /** GPU renderer name */
  renderer: string;
  /** Maximum texture dimension */
  maxTextureSize: number;
  /** Maximum viewport dimensions */
  maxViewportDims: [number, number];
  /** Whether WebGL2 is supported */
  hasWebGL2: boolean;
  /** Whether OffscreenCanvas is supported */
  hasOffscreenCanvas: boolean;
}

/** Canvas rendering limits */
export interface CanvasLimits {
  /** Maximum canvas dimension (typically 16384 or 32768) */
  maxDimension: number;
  /** Maximum canvas area in pixels */
  maxArea: number;
  /** Whether large canvases are supported */
  supportsLargeCanvas: boolean;
}

/** Complete device profile */
export interface DeviceProfile {
  /** Computed performance tier */
  tier: DeviceTier;
  /** Memory capabilities */
  memory: MemoryInfo;
  /** CPU capabilities */
  cpu: CpuInfo;
  /** GPU capabilities */
  gpu: GpuInfo;
  /** Canvas limits */
  canvas: CanvasLimits;
  /** Platform info */
  platform: {
    os: string;
    arch: string;
    isElectron: boolean;
    electronVersion: string | null;
    chromeVersion: string | null;
  };
  /** Timestamp when profile was generated */
  timestamp: number;
}

// Singleton cache
let cachedProfile: DeviceProfile | null = null;
let profilePromise: Promise<DeviceProfile> | null = null;

/**
 * Tier thresholds for classification
 */
const TIER_THRESHOLDS = {
  extreme: { minMemoryGB: 16, minCores: 6 },
  high: { minMemoryGB: 8, minCores: 4 },
  medium: { minMemoryGB: 4, minCores: 2 },
  // Below medium = low
} as const;

/**
 * Calculate performance tier based on memory and CPU
 */
function calculateTier(memoryGB: number, cores: number): DeviceTier {
  if (memoryGB >= TIER_THRESHOLDS.extreme.minMemoryGB && 
      cores >= TIER_THRESHOLDS.extreme.minCores) {
    return 'extreme';
  }
  if (memoryGB >= TIER_THRESHOLDS.high.minMemoryGB && 
      cores >= TIER_THRESHOLDS.high.minCores) {
    return 'high';
  }
  if (memoryGB >= TIER_THRESHOLDS.medium.minMemoryGB && 
      cores >= TIER_THRESHOLDS.medium.minCores) {
    return 'medium';
  }
  return 'low';
}

/**
 * Detect memory using best available API
 */
function detectMemory(): MemoryInfo {
  let totalGB = 4; // Conservative fallback
  let freeGB = 1;
  let heapLimitMB = 2048;
  let source: MemoryInfo['source'] = 'fallback';

  // Try Node.js os module first (most accurate)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os');
    if (os && typeof os.totalmem === 'function') {
      totalGB = os.totalmem() / (1024 * 1024 * 1024);
      freeGB = os.freemem() / (1024 * 1024 * 1024);
      source = 'os.totalmem';
    }
  } catch {
    // Not in Node.js environment
  }

  // Try Electron process API as backup
  if (source === 'fallback') {
    try {
      if (electronProcess?.getSystemMemoryInfo) {
        const sysMemory = electronProcess.getSystemMemoryInfo();
        totalGB = sysMemory.total / (1024 * 1024); // Electron returns KB
        freeGB = sysMemory.free / (1024 * 1024);
        source = 'process.getSystemMemoryInfo';
      }
    } catch {
      // Not in Electron
    }
  }

  // Fall back to navigator.deviceMemory (capped at 8GB)
  if (source === 'fallback') {
    try {
      const nav = navigator as Navigator & { deviceMemory?: number };
      if (nav.deviceMemory) {
        totalGB = nav.deviceMemory;
        freeGB = totalGB * 0.5; // Estimate
        source = 'navigator.deviceMemory';
      }
    } catch {
      // Not available
    }
  }

  // Get V8 heap limit
  try {
    if (electronProcess?.getHeapStatistics) {
      const heap = electronProcess.getHeapStatistics();
      heapLimitMB = heap.heapSizeLimit / (1024 * 1024);
    } else if (typeof performance !== 'undefined' && (performance as unknown as { memory?: { jsHeapSizeLimit: number } }).memory) {
      const perfMemory = (performance as unknown as { memory: { jsHeapSizeLimit: number } }).memory;
      heapLimitMB = perfMemory.jsHeapSizeLimit / (1024 * 1024);
    }
  } catch {
    // Use default
  }

  return {
    totalGB: Math.round(totalGB * 100) / 100,
    freeGB: Math.round(freeGB * 100) / 100,
    heapLimitMB: Math.round(heapLimitMB),
    source,
  };
}

/**
 * Detect CPU capabilities
 */
function detectCpu(): CpuInfo {
  let cores = 4; // Conservative fallback
  let model = 'Unknown';
  let speedMHz = 2000;
  let arch = 'x64';
  let isAppleSilicon = false;

  // Try Node.js os module
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os');
    if (os && typeof os.cpus === 'function') {
      const cpus = os.cpus();
      if (cpus && cpus.length > 0) {
        cores = cpus.length;
        model = cpus[0].model || 'Unknown';
        speedMHz = cpus[0].speed || 2000;
      }
      if (typeof os.arch === 'function') {
        arch = os.arch();
      }
    }
  } catch {
    // Not in Node.js environment
  }

  // Fall back to navigator.hardwareConcurrency
  if (cores === 4 && typeof navigator !== 'undefined') {
    cores = navigator.hardwareConcurrency || 4;
  }

  // Detect Apple Silicon
  isAppleSilicon = 
    model.toLowerCase().includes('apple') ||
    (arch === 'arm64' && typeof navigator !== 'undefined' && 
     navigator.platform?.toLowerCase().includes('mac'));

  return {
    cores,
    model,
    speedMHz,
    isAppleSilicon,
    arch,
  };
}

/**
 * Detect GPU capabilities via WebGL
 */
function detectGpu(): GpuInfo {
  const defaults: GpuInfo = {
    vendor: 'Unknown',
    renderer: 'Unknown',
    maxTextureSize: 4096,
    maxViewportDims: [4096, 4096],
    hasWebGL2: false,
    hasOffscreenCanvas: false,
  };

  try {
    // Check OffscreenCanvas support
    defaults.hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';

    // Create canvas for WebGL detection
    const canvas = document.createElement('canvas');
    
    // Try WebGL2 first
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = 
      canvas.getContext('webgl2');
    
    if (gl) {
      defaults.hasWebGL2 = true;
    } else {
      gl = canvas.getContext('webgl') || 
           canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
    }

    if (gl) {
      // Get debug info for unmasked vendor/renderer
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        defaults.vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || 'Unknown';
        defaults.renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'Unknown';
      } else {
        defaults.vendor = gl.getParameter(gl.VENDOR) || 'Unknown';
        defaults.renderer = gl.getParameter(gl.RENDERER) || 'Unknown';
      }

      defaults.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
      
      const viewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      if (viewportDims && viewportDims.length >= 2) {
        defaults.maxViewportDims = [viewportDims[0], viewportDims[1]];
      }
    }
  } catch {
    // WebGL not available
  }

  return defaults;
}

/**
 * Detect canvas limits
 */
function detectCanvasLimits(gpu: GpuInfo): CanvasLimits {
  // Default to GPU max texture size
  let maxDimension = gpu.maxTextureSize;
  let maxArea = maxDimension * maxDimension;
  let supportsLargeCanvas = false;

  try {
    // Test large canvas support
    const testCanvas = document.createElement('canvas');
    testCanvas.width = 16384;
    testCanvas.height = 16384;
    const ctx = testCanvas.getContext('2d');
    
    if (ctx && testCanvas.width === 16384 && testCanvas.height === 16384) {
      maxDimension = Math.max(maxDimension, 16384);
      supportsLargeCanvas = true;
    }
    
    // Clean up
    testCanvas.width = 1;
    testCanvas.height = 1;
  } catch {
    // Large canvas not supported
  }

  // Platform-specific limits
  // Safari: ~67 million pixels (8192x8192)
  // Chrome: ~268 million pixels (16384x16384)
  // Firefox: ~500 million pixels
  const isSafari = typeof navigator !== 'undefined' && 
    /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  
  if (isSafari) {
    maxArea = 67_108_864; // 8192 * 8192
    maxDimension = Math.min(maxDimension, 8192);
  } else {
    maxArea = 268_435_456; // 16384 * 16384
  }

  return {
    maxDimension,
    maxArea,
    supportsLargeCanvas,
  };
}

/**
 * Detect platform information
 */
function detectPlatform(): DeviceProfile['platform'] {
  let os = 'unknown';
  let arch = 'unknown';
  let isElectron = false;
  let electronVersion: string | null = null;
  let chromeVersion: string | null = null;

  try {
    // Try Node.js os module
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const osModule = require('os');
    if (osModule) {
      os = osModule.platform?.() || 'unknown';
      arch = osModule.arch?.() || 'unknown';
    }
  } catch {
    // Fall back to navigator
    if (typeof navigator !== 'undefined') {
      const platform = navigator.platform?.toLowerCase() || '';
      if (platform.includes('mac')) os = 'darwin';
      else if (platform.includes('win')) os = 'win32';
      else if (platform.includes('linux')) os = 'linux';
    }
  }

  // Check for Electron
  try {
    if (electronProcess?.versions) {
      electronVersion = electronProcess.versions.electron || null;
      chromeVersion = electronProcess.versions.chrome || null;
      isElectron = !!electronVersion;
    }
  } catch {
    // Not in Electron
  }

  return {
    os,
    arch,
    isElectron,
    electronVersion,
    chromeVersion,
  };
}

/**
 * Generate a complete device profile
 * @returns DeviceProfile with all detected capabilities
 */
export function generateDeviceProfile(): DeviceProfile {
  const memory = detectMemory();
  const cpu = detectCpu();
  const gpu = detectGpu();
  const canvas = detectCanvasLimits(gpu);
  const platform = detectPlatform();
  const tier = calculateTier(memory.totalGB, cpu.cores);

  const profile: DeviceProfile = {
    tier,
    memory,
    cpu,
    gpu,
    canvas,
    platform,
    timestamp: Date.now(),
  };

  // Log profile summary
  console.log(`[DeviceProfiler] Profile generated:`, {
    tier,
    memory: `${memory.totalGB.toFixed(1)}GB (${memory.source})`,
    cpu: `${cpu.cores} cores, ${cpu.model}`,
    gpu: gpu.renderer,
    canvas: `${canvas.maxDimension}px max`,
  });

  return profile;
}

/**
 * Get cached device profile (sync)
 * Returns null if not yet generated
 */
export function getCachedProfile(): DeviceProfile | null {
  return cachedProfile;
}

/**
 * Get device profile (async with caching)
 * Generates profile on first call, returns cached thereafter
 */
export async function getDeviceProfile(): Promise<DeviceProfile> {
  if (cachedProfile) {
    return cachedProfile;
  }

  if (profilePromise) {
    return profilePromise;
  }

  profilePromise = new Promise((resolve) => {
    // Use setTimeout to ensure DOM is ready for WebGL detection
    setTimeout(() => {
      cachedProfile = generateDeviceProfile();
      resolve(cachedProfile);
    }, 0);
  });

  return profilePromise;
}

/**
 * Get device profile synchronously
 * Generates immediately if not cached
 */
export function getDeviceProfileSync(): DeviceProfile {
  if (!cachedProfile) {
    cachedProfile = generateDeviceProfile();
  }
  return cachedProfile;
}

/**
 * Get just the performance tier (sync)
 */
export function getDeviceTier(): DeviceTier {
  return getDeviceProfileSync().tier;
}

/**
 * Reset the profile cache (for testing)
 */
export function resetProfileCache(): void {
  cachedProfile = null;
  profilePromise = null;
}

/**
 * Check if device meets minimum requirements for a tier
 */
export function meetsTierRequirements(targetTier: DeviceTier): boolean {
  const profile = getDeviceProfileSync();
  const tierOrder: DeviceTier[] = ['low', 'medium', 'high', 'extreme'];
  const currentIndex = tierOrder.indexOf(profile.tier);
  const targetIndex = tierOrder.indexOf(targetTier);
  return currentIndex >= targetIndex;
}

// Export singleton accessor
let deviceProfilerInstance: {
  getProfile: typeof getDeviceProfile;
  getProfileSync: typeof getDeviceProfileSync;
  getCached: typeof getCachedProfile;
  getTier: typeof getDeviceTier;
  meetsTier: typeof meetsTierRequirements;
  reset: typeof resetProfileCache;
} | null = null;

export function getDeviceProfiler() {
  if (!deviceProfilerInstance) {
    deviceProfilerInstance = {
      getProfile: getDeviceProfile,
      getProfileSync: getDeviceProfileSync,
      getCached: getCachedProfile,
      getTier: getDeviceTier,
      meetsTier: meetsTierRequirements,
      reset: resetProfileCache,
    };
  }
  return deviceProfilerInstance;
}

// Expose to window for debugging
if (typeof window !== 'undefined') {
  (window as unknown as { deviceProfiler: ReturnType<typeof getDeviceProfiler> }).deviceProfiler = getDeviceProfiler();
}

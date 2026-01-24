/**
 * System Profiler
 *
 * Detects hardware capabilities at startup to inform performance recommendations.
 * Classifies devices into tiers (low/mid/high) for automatic preset suggestions.
 *
 * Detection capabilities:
 * - CPU cores (navigator.hardwareConcurrency)
 * - Memory estimate (navigator.deviceMemory)
 * - GPU tier (WebGL renderer string analysis)
 * - Platform detection (mobile vs desktop)
 * - Battery status (when available)
 *
 * @example
 * ```typescript
 * const profiler = getSystemProfiler();
 * const profile = profiler.getProfile();
 *
 * console.log('Device tier:', profile.tier);
 * console.log('Recommended preset:', profile.recommendedPreset);
 * console.log('CPU cores:', profile.cpu.cores);
 * ```
 */

import type { PdfPerformancePreset } from '../../../settings/settings';

/**
 * Device tier classification
 */
export type DeviceTier = 'low' | 'mid' | 'high';

/**
 * CPU profile
 */
export interface CpuProfile {
  /** Number of logical processors */
  cores: number;
  /** Estimated performance tier based on core count */
  tier: DeviceTier;
}

/**
 * Memory profile
 */
export interface MemoryProfile {
  /** Device memory in GB (approximate, from navigator.deviceMemory) */
  deviceMemoryGB: number | null;
  /** JS heap size limit in bytes (if available) */
  jsHeapSizeLimit: number | null;
  /** Estimated tier based on memory */
  tier: DeviceTier;
}

/**
 * GPU profile
 */
export interface GpuProfile {
  /** WebGL vendor string */
  vendor: string;
  /** WebGL renderer string */
  renderer: string;
  /** Detected GPU family */
  family: 'integrated' | 'discrete' | 'unknown';
  /** GPU tier based on renderer analysis */
  tier: DeviceTier;
  /** Whether WebGL 2 is supported */
  webgl2Supported: boolean;
}

/**
 * Platform profile
 */
export interface PlatformProfile {
  /** Operating system family */
  os: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'unknown';
  /** Whether running on mobile device */
  isMobile: boolean;
  /** Device pixel ratio */
  devicePixelRatio: number;
  /** Screen dimensions */
  screen: {
    width: number;
    height: number;
  };
}

/**
 * Battery profile
 */
export interface BatteryProfile {
  /** Whether battery API is available */
  available: boolean;
  /** Whether device is charging */
  charging: boolean | null;
  /** Battery level (0-1) */
  level: number | null;
  /** Whether battery is low (<20%) */
  isLow: boolean;
}

/**
 * Complete system profile
 */
export interface SystemProfile {
  /** Overall device tier */
  tier: DeviceTier;
  /** Recommended performance preset based on hardware */
  recommendedPreset: PdfPerformancePreset;
  /** CPU profile */
  cpu: CpuProfile;
  /** Memory profile */
  memory: MemoryProfile;
  /** GPU profile */
  gpu: GpuProfile;
  /** Platform profile */
  platform: PlatformProfile;
  /** Battery profile */
  battery: BatteryProfile;
  /** Profile generation timestamp */
  timestamp: number;
  /** Confidence score (0-1) based on available data */
  confidence: number;
}

/**
 * Known GPU renderer patterns for tier classification
 */
const GPU_PATTERNS = {
  high: [
    /NVIDIA.*RTX/i,
    /NVIDIA.*GTX\s*(10[6-9]|[2-9]\d)/i,
    /AMD.*RX\s*(5[6-9]|6|7)/i,
    /Apple.*M[1-4]/i,
    /Intel.*Arc/i,
  ],
  mid: [
    /NVIDIA.*GTX\s*(9|10[0-5])/i,
    /AMD.*RX\s*(4|5[0-5])/i,
    /Intel.*Iris/i,
    /Apple.*A1[4-7]/i,
  ],
  low: [
    /Intel.*HD/i,
    /Intel.*UHD/i,
    /Mali/i,
    /Adreno/i,
    /PowerVR/i,
  ],
};

/**
 * System Profiler class
 */
export class SystemProfiler {
  private cachedProfile: SystemProfile | null = null;
  private batteryManager: BatteryManager | null = null;
  private batteryListenerCleanups: Set<() => void> = new Set();

  /**
   * Get the system profile, generating it if not cached
   */
  async getProfile(): Promise<SystemProfile> {
    if (this.cachedProfile) {
      return this.cachedProfile;
    }

    const cpu = this.profileCpu();
    const memory = this.profileMemory();
    const gpu = this.profileGpu();
    const platform = this.profilePlatform();
    const battery = await this.profileBattery();

    // Calculate overall tier (weighted average)
    const tierScores: Record<DeviceTier, number> = { low: 0, mid: 1, high: 2 };
    const weights = { cpu: 0.3, memory: 0.3, gpu: 0.25, platform: 0.15 };

    let totalScore =
      tierScores[cpu.tier] * weights.cpu +
      tierScores[memory.tier] * weights.memory +
      tierScores[gpu.tier] * weights.gpu +
      (platform.isMobile ? 0 : 1) * weights.platform;

    // Adjust for mobile
    if (platform.isMobile) {
      totalScore *= 0.8; // Mobile devices get penalized slightly
    }

    const tier: DeviceTier =
      totalScore < 0.7 ? 'low' : totalScore < 1.4 ? 'mid' : 'high';

    // Recommend preset based on tier
    const recommendedPreset = this.getRecommendedPreset(tier, battery);

    // Calculate confidence based on available data
    let dataPoints = 0;
    let availablePoints = 0;

    if (cpu.cores > 0) availablePoints++;
    dataPoints++;

    if (memory.deviceMemoryGB !== null) availablePoints++;
    dataPoints++;

    if (gpu.renderer !== 'unknown') availablePoints++;
    dataPoints++;

    if (battery.available) availablePoints++;
    dataPoints++;

    const confidence = availablePoints / dataPoints;

    this.cachedProfile = {
      tier,
      recommendedPreset,
      cpu,
      memory,
      gpu,
      platform,
      battery,
      timestamp: Date.now(),
      confidence,
    };

    return this.cachedProfile;
  }

  /**
   * Get cached profile synchronously (may return null if not yet profiled)
   */
  getCachedProfile(): SystemProfile | null {
    return this.cachedProfile;
  }

  /**
   * Force re-profiling on next access
   */
  invalidateCache(): void {
    this.cachedProfile = null;
    // Clean up all battery listeners to prevent memory leaks
    this.batteryListenerCleanups.forEach((cleanup) => cleanup());
    this.batteryListenerCleanups.clear();
  }

  /**
   * Dispose of the profiler and clean up resources
   */
  dispose(): void {
    this.invalidateCache();
    this.batteryManager = null;
  }

  /**
   * Profile CPU capabilities
   */
  private profileCpu(): CpuProfile {
    const cores = navigator.hardwareConcurrency || 4;

    let tier: DeviceTier;
    if (cores <= 2) {
      tier = 'low';
    } else if (cores <= 6) {
      tier = 'mid';
    } else {
      tier = 'high';
    }

    return { cores, tier };
  }

  /**
   * Profile memory capabilities
   */
  private profileMemory(): MemoryProfile {
    // navigator.deviceMemory is approximate (Chrome only)
    const deviceMemoryGB =
      'deviceMemory' in navigator ? (navigator as Navigator & { deviceMemory: number }).deviceMemory : null;

    // Performance.memory is non-standard (Chrome only)
    const perf = performance as Performance & {
      memory?: { jsHeapSizeLimit: number };
    };
    const jsHeapSizeLimit = perf.memory?.jsHeapSizeLimit ?? null;

    let tier: DeviceTier;
    if (deviceMemoryGB !== null) {
      if (deviceMemoryGB <= 2) {
        tier = 'low';
      } else if (deviceMemoryGB <= 8) {
        tier = 'mid';
      } else {
        tier = 'high';
      }
    } else if (jsHeapSizeLimit !== null) {
      // Estimate from JS heap limit (typically 1-4GB)
      const heapGB = jsHeapSizeLimit / (1024 * 1024 * 1024);
      if (heapGB <= 1) {
        tier = 'low';
      } else if (heapGB <= 2) {
        tier = 'mid';
      } else {
        tier = 'high';
      }
    } else {
      // Default to mid if unknown
      tier = 'mid';
    }

    return { deviceMemoryGB, jsHeapSizeLimit, tier };
  }

  /**
   * Profile GPU capabilities
   */
  private profileGpu(): GpuProfile {
    let vendor = 'unknown';
    let renderer = 'unknown';
    let webgl2Supported = false;

    try {
      // Try WebGL 2 first
      const canvas = document.createElement('canvas');
      let gl: WebGLRenderingContext | WebGL2RenderingContext | null =
        canvas.getContext('webgl2');

      if (gl) {
        webgl2Supported = true;
      } else {
        gl = canvas.getContext('webgl');
      }

      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || 'unknown';
          renderer =
            gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'unknown';
        }
      }
    } catch {
      // WebGL not available
    }

    // Detect GPU family
    let family: GpuProfile['family'] = 'unknown';
    const rendererLower = renderer.toLowerCase();

    if (
      rendererLower.includes('nvidia') ||
      rendererLower.includes('amd') ||
      rendererLower.includes('radeon')
    ) {
      // Check if it's a mobile variant
      if (
        rendererLower.includes('mobile') ||
        rendererLower.includes('max-q')
      ) {
        family = 'integrated';
      } else {
        family = 'discrete';
      }
    } else if (
      rendererLower.includes('intel') ||
      rendererLower.includes('apple') ||
      rendererLower.includes('mali') ||
      rendererLower.includes('adreno')
    ) {
      family = 'integrated';
    }

    // Classify tier based on renderer string
    // Priority: high > mid > low (higher tiers override lower)
    let tier: DeviceTier = 'mid'; // Default for unknown GPUs

    // Check low-tier patterns first (baseline)
    for (const pattern of GPU_PATTERNS.low) {
      if (pattern.test(renderer)) {
        tier = 'low';
        break;
      }
    }

    // Mid-tier patterns can upgrade from low
    for (const pattern of GPU_PATTERNS.mid) {
      if (pattern.test(renderer)) {
        tier = 'mid';
        break;
      }
    }

    // High-tier patterns always win
    for (const pattern of GPU_PATTERNS.high) {
      if (pattern.test(renderer)) {
        tier = 'high';
        break;
      }
    }

    // Apple Silicon special case - always high tier
    // (Redundant with GPU_PATTERNS.high but explicit for clarity)
    if (/Apple.*M[1-4]/i.test(renderer)) {
      tier = 'high';
      family = 'integrated'; // Apple Silicon is technically integrated
    }

    return { vendor, renderer, family, tier, webgl2Supported };
  }

  /**
   * Profile platform characteristics
   */
  private profilePlatform(): PlatformProfile {
    let os: PlatformProfile['os'] = 'unknown';
    const ua = navigator.userAgent.toLowerCase();

    if (ua.includes('win')) {
      os = 'windows';
    } else if (ua.includes('mac')) {
      os = 'macos';
    } else if (ua.includes('linux')) {
      os = 'linux';
    } else if (ua.includes('iphone') || ua.includes('ipad')) {
      os = 'ios';
    } else if (ua.includes('android')) {
      os = 'android';
    }

    const isMobile =
      /android|iphone|ipad|ipod|mobile/i.test(ua) ||
      ('maxTouchPoints' in navigator && navigator.maxTouchPoints > 0);

    return {
      os,
      isMobile,
      devicePixelRatio: window.devicePixelRatio || 1,
      screen: {
        width: window.screen.width,
        height: window.screen.height,
      },
    };
  }

  /**
   * Profile battery status
   *
   * NOTE: The Battery Status API is deprecated and has limited browser support:
   * - Chrome: Supported (may be removed in future)
   * - Firefox: Removed in version 72 (2020)
   * - Safari: Never supported
   *
   * When unavailable, we return a default profile with available=false.
   * Consider alternative heuristics like mobile detection or user preferences
   * for power-saving recommendations.
   */
  private async profileBattery(): Promise<BatteryProfile> {
    const defaultProfile: BatteryProfile = {
      available: false,
      charging: null,
      level: null,
      isLow: false,
    };

    try {
      if ('getBattery' in navigator) {
        const battery = await (
          navigator as Navigator & { getBattery: () => Promise<BatteryManager> }
        ).getBattery();
        this.batteryManager = battery;

        return {
          available: true,
          charging: battery.charging,
          level: battery.level,
          isLow: battery.level !== null && battery.level < 0.2 && !battery.charging,
        };
      }
    } catch {
      // Battery API not available or blocked
    }

    return defaultProfile;
  }

  /**
   * Get recommended preset based on hardware tier and battery
   */
  private getRecommendedPreset(
    tier: DeviceTier,
    battery: BatteryProfile
  ): PdfPerformancePreset {
    // If battery is low, recommend memory saver
    if (battery.isLow) {
      return 'memory-saver';
    }

    switch (tier) {
      case 'low':
        return 'memory-saver';
      case 'mid':
        return 'balanced';
      case 'high':
        return 'performance';
    }
  }

  /**
   * Get a formatted summary for debugging
   */
  getSummary(): string {
    const profile = this.cachedProfile;
    if (!profile) {
      return '[SystemProfiler] No profile available. Call getProfile() first.';
    }

    return [
      '[System Profile]',
      `  Overall Tier: ${profile.tier}`,
      `  Recommended Preset: ${profile.recommendedPreset}`,
      `  Confidence: ${(profile.confidence * 100).toFixed(0)}%`,
      '',
      '  CPU:',
      `    Cores: ${profile.cpu.cores}`,
      `    Tier: ${profile.cpu.tier}`,
      '',
      '  Memory:',
      `    Device Memory: ${profile.memory.deviceMemoryGB ?? 'unknown'} GB`,
      `    Heap Limit: ${profile.memory.jsHeapSizeLimit ? (profile.memory.jsHeapSizeLimit / 1024 / 1024 / 1024).toFixed(1) + ' GB' : 'unknown'}`,
      `    Tier: ${profile.memory.tier}`,
      '',
      '  GPU:',
      `    Vendor: ${profile.gpu.vendor}`,
      `    Renderer: ${profile.gpu.renderer}`,
      `    Family: ${profile.gpu.family}`,
      `    Tier: ${profile.gpu.tier}`,
      `    WebGL 2: ${profile.gpu.webgl2Supported ? 'yes' : 'no'}`,
      '',
      '  Platform:',
      `    OS: ${profile.platform.os}`,
      `    Mobile: ${profile.platform.isMobile ? 'yes' : 'no'}`,
      `    Pixel Ratio: ${profile.platform.devicePixelRatio}`,
      `    Screen: ${profile.platform.screen.width}x${profile.platform.screen.height}`,
      '',
      '  Battery:',
      `    Available: ${profile.battery.available ? 'yes' : 'no'}`,
      profile.battery.available
        ? `    Charging: ${profile.battery.charging ? 'yes' : 'no'}`
        : '',
      profile.battery.available
        ? `    Level: ${profile.battery.level !== null ? (profile.battery.level * 100).toFixed(0) + '%' : 'unknown'}`
        : '',
      profile.battery.isLow ? '    ⚠️ Low battery detected' : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Subscribe to battery changes (if available)
   *
   * Returns an unsubscribe function. Listeners are automatically cleaned up
   * when invalidateCache() or dispose() is called.
   */
  onBatteryChange(callback: (battery: BatteryProfile) => void): () => void {
    if (!this.batteryManager) {
      return () => {};
    }

    const handler = () => {
      const battery = this.batteryManager!;
      callback({
        available: true,
        charging: battery.charging,
        level: battery.level,
        isLow: battery.level !== null && battery.level < 0.2 && !battery.charging,
      });
    };

    this.batteryManager.addEventListener('chargingchange', handler);
    this.batteryManager.addEventListener('levelchange', handler);

    const cleanup = () => {
      if (this.batteryManager) {
        this.batteryManager.removeEventListener('chargingchange', handler);
        this.batteryManager.removeEventListener('levelchange', handler);
      }
      this.batteryListenerCleanups.delete(cleanup);
    };

    this.batteryListenerCleanups.add(cleanup);
    return cleanup;
  }
}

// ==========================================================================
// Battery Manager Type (not in standard lib.dom.d.ts)
// ==========================================================================

interface BatteryManager extends EventTarget {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
}

// ==========================================================================
// Singleton Instance
// ==========================================================================

let instance: SystemProfiler | null = null;

/**
 * Get the shared system profiler instance
 */
export function getSystemProfiler(): SystemProfiler {
  if (!instance) {
    instance = new SystemProfiler();
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetSystemProfiler(): void {
  instance = null;
}

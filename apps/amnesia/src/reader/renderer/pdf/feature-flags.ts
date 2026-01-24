/**
 * Feature Flags for PDF Rendering Optimizations
 *
 * Provides a centralized system for controlling experimental features
 * with automatic capability detection and safe rollback.
 *
 * Features:
 * - Auto-detection of SharedArrayBuffer, SIMD, WebGL support
 * - Runtime toggling via settings or DevTools
 * - Feature-specific telemetry tracking
 * - Safe defaults with fallbacks
 *
 * @example
 * ```typescript
 * const flags = getFeatureFlags();
 * if (flags.isEnabled('useRawRGBA')) {
 *   // Use raw RGBA transfer path
 * }
 * ```
 */

/** Feature flag definitions with their default values */
export interface FeatureFlagDefinitions {
  /** Use raw RGBA transfer instead of PNG encode/decode */
  useRawRGBA: 'auto' | boolean;
  /** Use SharedArrayBuffer for zero-copy transfer */
  useSharedArrayBuffer: 'auto' | boolean;
  /** Use multi-resolution zoom (CSS transform + progressive) */
  useMultiResZoom: boolean;
  /** Number of workers in the pool (1-4, or 'auto' for CPU-based) */
  workerCount: 'auto' | number;
  /** Use IndexedDB for persistent thumbnail cache */
  useThumbnailCache: boolean;
  /** Enable detailed performance telemetry */
  enableTelemetry: boolean;
  /** Enable per-stage pipeline timing */
  enablePipelineTelemetry: boolean;
  /** Use adaptive tile sizing based on zoom level */
  useAdaptiveTileSize: boolean;
  /**
   * Enable content-type detection for PDFs (Phase 5).
   *
   * When enabled, pages are classified by content type before rendering:
   * - SCANNED_JPEG: Direct JPEG extraction (60-80% faster)
   * - VECTOR_HEAVY: Reduced scale rendering with CSS upscale (30-50% faster)
   * - TEXT_HEAVY: Aggressive caching
   * - MIXED/COMPLEX: Standard rendering
   *
   * 'auto' enables in Electron (where MuPDF WASM is available)
   */
  useContentTypeDetection: 'auto' | boolean;
  /** Enable WebGL compositing ('auto' enables when WebGL2 available) */
  useWebGLCompositing: 'auto' | boolean;
  /**
   * Use MuPDF WASM for EPUB parsing instead of pub-rs.
   *
   * When enabled, EPUBs are parsed using the same MuPDF WASM infrastructure
   * as PDFs, providing:
   * - Unified codebase for both formats
   * - Fixed-layout EPUB support (comic books, manga)
   * - Potentially faster parsing for complex EPUBs
   *
   * 'auto' enables in Electron where MuPDF WASM is reliable.
   */
  useMuPDFEpub: 'auto' | boolean;

  /**
   * Route full-page renders through RenderCoordinator.
   *
   * When enabled:
   * - Full-page renders use the same concurrency control as tiles (semaphore)
   * - Request deduplication prevents duplicate renders of same page
   * - Full-page cache integration via TileCacheManager
   * - Unified priority handling across display modes
   *
   * Benefits:
   * - Better first-page load in paginated/scroll modes
   * - No resource contention between full-page and tile renders
   * - Consistent cache behavior across all render types
   *
   * Default: true (infrastructure is already built but dormant)
   */
  useCoordinatorForFullPage: boolean;

  /**
   * Use exact target scale for tile rendering instead of quantized tiers.
   *
   * When enabled:
   * - Tiles are rendered at zoom × pixelRatio (exact scale)
   * - cssStretch is always 1.0 (no visual jumps on quality transitions)
   * - Page canvas uses transform compensation to fit in DOM
   * - Cache keys use precision-rounded exact scales
   *
   * Benefits:
   * - Eliminates "visual bumps" when cssStretch changes
   * - Crisp rendering at all zoom levels
   * - Simpler coordinate math (no cssStretch compensation)
   *
   * Default: false (experimental - needs testing)
   */
  useExactScaleRendering: boolean;

  /**
   * Use centralized ZoomStateManager for zoom state management.
   *
   * When enabled:
   * - Single source of truth for zoom level (ZoomStateManager)
   * - Epoch-based tile validation (stale tiles are discarded)
   * - CSS always owns positioning (no authority handoff issues)
   * - Eliminates the "two-stage zoom bug" where tiles render with
   *   snapshot zoom while CSS shows live zoom
   *
   * Benefits:
   * - Fixes focal point shift during zoom gestures
   * - Simpler zoom state model (no 6 different zoom locations)
   * - Stale tiles from previous zoom levels are automatically discarded
   *
   * Default: true (fixes two-stage zoom bug)
   */
  useZoomStateManager: boolean;

  /**
   * Enable debug tile rendering for visual debugging of tile composition.
   *
   * When enabled:
   * - Tiles are replaced with colored SVG placeholders
   * - Each tile shows: coordinates (x,y), scale, timestamp
   * - Color coding: different hues for different scales
   * - Helps debug multi-scale composition issues (amnesia-d9f)
   *
   * Default: false (debug only)
   */
  useDebugTiles: boolean;

  /**
   * Enable tile compliance validation (amnesia-e4i).
   *
   * When enabled:
   * - Tiles are validated at cache SET time for scale/grid consistency
   * - Tiles are validated at composite time for position correctness
   * - Violations are logged with full stack traces for debugging
   * - Statistics available via window.getTileComplianceStats()
   *
   * This helps diagnose visual corruption bugs where tiles appear at
   * wrong positions during zoom+pan operations.
   *
   * Default: true (diagnostic mode for debugging tile corruption)
   */
  useTileComplianceValidation: boolean;
}

/** Runtime-resolved flag values (all booleans or numbers) */
export interface ResolvedFeatureFlags {
  useRawRGBA: boolean;
  useSharedArrayBuffer: boolean;
  useMultiResZoom: boolean;
  workerCount: number;
  useThumbnailCache: boolean;
  enableTelemetry: boolean;
  enablePipelineTelemetry: boolean;
  useAdaptiveTileSize: boolean;
  useContentTypeDetection: boolean;
  useWebGLCompositing: boolean;
  useMuPDFEpub: boolean;
  useCoordinatorForFullPage: boolean;
  useExactScaleRendering: boolean;
  useZoomStateManager: boolean;
  useDebugTiles: boolean;
  useTileComplianceValidation: boolean;
}

/** Capability detection results */
export interface CapabilityDetection {
  hasSharedArrayBuffer: boolean;
  hasCrossOriginIsolation: boolean;
  hasWebGL2: boolean;
  hasOffscreenCanvas: boolean;
  cpuCores: number;
  deviceMemoryGB: number | null;
  isElectron: boolean;
  chromeVersion: number | null;
}

/**
 * Safe default capabilities used before async detection completes.
 * Conservative values ensure system works without blocking.
 */
const SAFE_DEFAULT_CAPABILITIES: CapabilityDetection = {
  hasSharedArrayBuffer: false,
  hasCrossOriginIsolation: false,
  hasWebGL2: false, // Conservative - assume not available until detected
  hasOffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  cpuCores: navigator.hardwareConcurrency || 4,
  deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
  isElectron:
    typeof process !== 'undefined' &&
    process.versions != null &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).versions.electron != null,
  chromeVersion: (() => {
    const match = navigator.userAgent.match(/Chrome\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  })(),
};

/** Default flag values */
const DEFAULT_FLAGS: FeatureFlagDefinitions = {
  useRawRGBA: 'auto',
  useSharedArrayBuffer: 'auto',
  useMultiResZoom: true,
  workerCount: 'auto',
  useThumbnailCache: true,
  enableTelemetry: true,
  enablePipelineTelemetry: true,
  useAdaptiveTileSize: true, // Phase 2 enabled
  useContentTypeDetection: 'auto', // Phase 5: auto-enables in Electron
  useWebGLCompositing: 'auto', // Phase 7: auto-enables when WebGL2 available
  useMuPDFEpub: 'auto', // EPUB Migration: auto-enables in Electron
  useCoordinatorForFullPage: true, // Full-page coordinator routing: enabled - infrastructure already built
  useExactScaleRendering: true, // Hybrid Virtualized: enabled to eliminate zoom quantization jumps
  useZoomStateManager: true, // Centralized zoom: enabled to fix two-stage zoom bug
  useDebugTiles: false, // Debug: disabled by default, enable for tile composition debugging
  useTileComplianceValidation: true, // amnesia-e4i: enabled to diagnose tile corruption
};

/**
 * Feature Flags Manager
 *
 * Provides capability detection, flag resolution, and runtime toggling.
 */
export class FeatureFlagsManager {
  private flags: FeatureFlagDefinitions;
  private capabilities: CapabilityDetection | null = null;
  private overrides: Partial<FeatureFlagDefinitions> = {};
  private listeners: Set<(flags: ResolvedFeatureFlags) => void> = new Set();

  // Async detection state
  private detectionPromise: Promise<void> | null = null;
  private detectionComplete = false;
  private detectionStartTime: number | null = null;

  constructor(initialFlags?: Partial<FeatureFlagDefinitions>) {
    this.flags = { ...DEFAULT_FLAGS, ...initialFlags };
    // Start background detection (non-blocking)
    this.startBackgroundDetection();
  }

  /**
   * Start capability detection in background (non-blocking)
   */
  private startBackgroundDetection(timeout: number = 3000): void {
    if (this.detectionPromise) return; // Already started

    this.detectionPromise = this.detectCapabilitiesAsync(timeout);

    // Safety net: ensure state is always set even if something unexpected happens
    // (detectCapabilitiesAsync has internal try-catch, so this rarely triggers)
    this.detectionPromise.finally(() => {
      if (!this.detectionComplete) {
        console.warn('[FeatureFlags] Detection completed without setting state - using safe defaults');
        this.capabilities = SAFE_DEFAULT_CAPABILITIES;
        this.detectionComplete = true;
        this.notifyListeners();
      }
    });
  }

  /**
   * Async capability detection with timeout fallback
   */
  private async detectCapabilitiesAsync(timeout: number): Promise<void> {
    this.detectionStartTime = performance.now();

    try {
      // Race detection against timeout
      const capabilities = await Promise.race([
        this.runCapabilityDetection(),
        this.createTimeoutPromise(timeout),
      ]);

      if (capabilities) {
        // Detection succeeded
        this.capabilities = capabilities;
        this.detectionComplete = true;
        const elapsed = performance.now() - this.detectionStartTime;
        console.log('[FeatureFlags] Detection completed in', elapsed.toFixed(1), 'ms');
        this.notifyListeners(); // Notify of capability upgrade
      } else {
        // Timeout occurred
        console.warn('[FeatureFlags] Detection timed out after', timeout, 'ms - using safe defaults');
        this.capabilities = SAFE_DEFAULT_CAPABILITIES;
        this.detectionComplete = true;
        this.notifyListeners();
      }
    } catch (error) {
      console.error('[FeatureFlags] Detection failed:', error);
      this.capabilities = SAFE_DEFAULT_CAPABILITIES;
      this.detectionComplete = true;
      this.notifyListeners(); // Notify subscribers even on error
    }
  }

  /**
   * Run actual capability detection (potentially blocking code isolated here)
   */
  private async runCapabilityDetection(): Promise<CapabilityDetection> {
    // Check SharedArrayBuffer availability
    const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
    const hasCrossOriginIsolation =
      typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

    // Check WebGL2 support - this is the potentially blocking operation
    let hasWebGL2 = false;
    try {
      const canvas = document.createElement('canvas');
      hasWebGL2 = !!canvas.getContext('webgl2');
    } catch {
      hasWebGL2 = false;
    }

    // Check OffscreenCanvas support
    const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';

    // Get CPU cores
    const cpuCores = navigator.hardwareConcurrency || 4;

    // Get device memory (Chrome only)
    const nav = navigator as Navigator & { deviceMemory?: number };
    const deviceMemoryGB = nav.deviceMemory ?? null;

    // Detect Electron
    const isElectron =
      typeof process !== 'undefined' &&
      process.versions != null &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).versions.electron != null;

    // Parse Chrome version
    let chromeVersion: number | null = null;
    const match = navigator.userAgent.match(/Chrome\/(\d+)/);
    if (match) {
      chromeVersion = parseInt(match[1], 10);
    }

    return {
      hasSharedArrayBuffer,
      hasCrossOriginIsolation,
      hasWebGL2,
      hasOffscreenCanvas,
      cpuCores,
      deviceMemoryGB,
      isElectron,
      chromeVersion,
    };
  }

  /**
   * Create a timeout promise that resolves to null after specified duration
   */
  private createTimeoutPromise(ms: number): Promise<null> {
    return new Promise((resolve) => setTimeout(() => resolve(null), ms));
  }

  /**
   * Explicitly initialize and wait for detection to complete
   * @param timeout Maximum time to wait for detection (ms)
   */
  async initialize(timeout: number = 3000): Promise<void> {
    if (this.detectionComplete) return;

    if (!this.detectionPromise) {
      this.startBackgroundDetection(timeout);
    }

    await this.detectionPromise;
  }

  /**
   * Check if capability detection has completed
   */
  isDetectionComplete(): boolean {
    return this.detectionComplete;
  }

  /**
   * Wait for detection to complete (with optional timeout)
   * @param timeout Maximum time to wait (ms)
   * @returns true if detection completed, false if timed out
   */
  async waitForDetection(timeout?: number): Promise<boolean> {
    if (this.detectionComplete) return true;

    if (timeout) {
      try {
        await Promise.race([
          this.detectionPromise || Promise.resolve(),
          this.createTimeoutPromise(timeout),
        ]);
        return this.detectionComplete;
      } catch {
        return false;
      }
    } else {
      await this.detectionPromise;
      return this.detectionComplete;
    }
  }

  /**
   * Get capability detection results
   * Returns safe defaults if detection hasn't completed yet
   */
  getCapabilities(): CapabilityDetection {
    return this.capabilities ?? SAFE_DEFAULT_CAPABILITIES;
  }

  /**
   * Resolve 'auto' values based on capabilities
   */
  resolveFlags(): ResolvedFeatureFlags {
    const caps = this.getCapabilities();
    const merged = { ...this.flags, ...this.overrides };

    return {
      useRawRGBA: this.resolveAuto(
        merged.useRawRGBA,
        // Raw RGBA requires Electron/Chrome 90+ for efficient ImageData handling
        caps.isElectron && (caps.chromeVersion ?? 0) >= 90
      ),

      useSharedArrayBuffer: this.resolveAuto(
        merged.useSharedArrayBuffer,
        // SharedArrayBuffer: In Electron, available without COOP/COEP headers
        // In browsers, requires cross-origin isolation
        caps.hasSharedArrayBuffer && (caps.isElectron || caps.hasCrossOriginIsolation)
      ),

      useMultiResZoom: merged.useMultiResZoom,

      workerCount: this.resolveWorkerCount(merged.workerCount, caps),

      useThumbnailCache: merged.useThumbnailCache,
      enableTelemetry: merged.enableTelemetry,
      enablePipelineTelemetry: merged.enablePipelineTelemetry,
      useAdaptiveTileSize: merged.useAdaptiveTileSize,

      useContentTypeDetection: this.resolveAuto(
        merged.useContentTypeDetection,
        // Content-type detection requires Electron for MuPDF WASM access
        caps.isElectron
      ),

      useWebGLCompositing: this.resolveAuto(
        merged.useWebGLCompositing,
        // WebGL compositing requires WebGL2 support
        caps.hasWebGL2
      ),

      useMuPDFEpub: this.resolveAuto(
        merged.useMuPDFEpub,
        // MuPDF EPUB requires Electron where MuPDF WASM is reliable
        caps.isElectron
      ),

      useCoordinatorForFullPage: merged.useCoordinatorForFullPage,
      useExactScaleRendering: merged.useExactScaleRendering,
      useZoomStateManager: merged.useZoomStateManager,
      useDebugTiles: merged.useDebugTiles,
      useTileComplianceValidation: merged.useTileComplianceValidation,
    };
  }

  /**
   * Resolve 'auto' to boolean based on capability check
   */
  private resolveAuto(value: 'auto' | boolean, autoResult: boolean): boolean {
    if (value === 'auto') {
      return autoResult;
    }
    return value;
  }

  /**
   * Resolve worker count based on CPU cores and memory
   */
  private resolveWorkerCount(
    value: 'auto' | number,
    caps: CapabilityDetection
  ): number {
    if (typeof value === 'number') {
      return Math.max(1, Math.min(4, value));
    }

    // Auto: Scale based on CPU cores and memory
    // - 1 worker for <=2 cores
    // - 2 workers for 4 cores
    // - 3-4 workers for 6+ cores (if memory allows)

    const coreCount = caps.cpuCores;
    const memoryGB = caps.deviceMemoryGB ?? 4;

    if (coreCount <= 2) return 1;
    if (coreCount <= 4) return 2;
    if (memoryGB < 4) return 2;
    if (coreCount <= 6) return 3;
    return 4;
  }

  /**
   * Check if a specific feature is enabled
   */
  isEnabled<K extends keyof ResolvedFeatureFlags>(
    flag: K
  ): ResolvedFeatureFlags[K] {
    return this.resolveFlags()[flag];
  }

  /**
   * Override a flag at runtime
   */
  setFlag<K extends keyof FeatureFlagDefinitions>(
    flag: K,
    value: FeatureFlagDefinitions[K]
  ): void {
    this.overrides[flag] = value;
    this.notifyListeners();
    console.log(`[FeatureFlags] Set ${flag} = ${value}`);
  }

  /**
   * Reset a flag to its default value
   */
  resetFlag<K extends keyof FeatureFlagDefinitions>(flag: K): void {
    delete this.overrides[flag];
    this.notifyListeners();
    console.log(`[FeatureFlags] Reset ${flag} to default`);
  }

  /**
   * Reset all overrides
   */
  resetAll(): void {
    this.overrides = {};
    this.notifyListeners();
    console.log('[FeatureFlags] Reset all flags to defaults');
  }

  /**
   * Get all current overrides
   */
  getOverrides(): Partial<FeatureFlagDefinitions> {
    return { ...this.overrides };
  }

  /**
   * Subscribe to flag changes
   */
  subscribe(listener: (flags: ResolvedFeatureFlags) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notify all listeners of flag changes
   */
  private notifyListeners(): void {
    const resolved = this.resolveFlags();
    for (const listener of this.listeners) {
      try {
        listener(resolved);
      } catch (e) {
        console.error('[FeatureFlags] Listener error:', e);
      }
    }
  }

  /**
   * Export flags as JSON for debugging/persistence
   */
  toJSON(): {
    defaults: FeatureFlagDefinitions;
    overrides: Partial<FeatureFlagDefinitions>;
    resolved: ResolvedFeatureFlags;
    capabilities: CapabilityDetection;
  } {
    return {
      defaults: DEFAULT_FLAGS,
      overrides: this.overrides,
      resolved: this.resolveFlags(),
      capabilities: this.getCapabilities(),
    };
  }

  /**
   * Import flags from JSON
   */
  fromJSON(data: { overrides?: Partial<FeatureFlagDefinitions> }): void {
    if (data.overrides) {
      this.overrides = { ...data.overrides };
      this.notifyListeners();
    }
  }

  /**
   * Get a formatted summary string
   */
  getSummary(): string {
    const resolved = this.resolveFlags();
    const caps = this.getCapabilities();

    return [
      `[Feature Flags]`,
      `  Capabilities:`,
      `    SharedArrayBuffer: ${caps.hasSharedArrayBuffer} (isolated: ${caps.hasCrossOriginIsolation})`,
      `    WebGL2: ${caps.hasWebGL2}`,
      `    OffscreenCanvas: ${caps.hasOffscreenCanvas}`,
      `    CPU Cores: ${caps.cpuCores}`,
      `    Device Memory: ${caps.deviceMemoryGB ?? 'unknown'}GB`,
      `    Electron: ${caps.isElectron}`,
      `    Chrome: v${caps.chromeVersion ?? 'unknown'}`,
      `  Resolved Flags:`,
      `    useRawRGBA: ${resolved.useRawRGBA}`,
      `    useSharedArrayBuffer: ${resolved.useSharedArrayBuffer}`,
      `    useMultiResZoom: ${resolved.useMultiResZoom}`,
      `    workerCount: ${resolved.workerCount}`,
      `    useThumbnailCache: ${resolved.useThumbnailCache}`,
      `    enableTelemetry: ${resolved.enableTelemetry}`,
      `    enablePipelineTelemetry: ${resolved.enablePipelineTelemetry}`,
      `    useAdaptiveTileSize: ${resolved.useAdaptiveTileSize}`,
      `    useContentTypeDetection: ${resolved.useContentTypeDetection}`,
      `    useWebGLCompositing: ${resolved.useWebGLCompositing}`,
      `    useMuPDFEpub: ${resolved.useMuPDFEpub}`,
      `    useCoordinatorForFullPage: ${resolved.useCoordinatorForFullPage}`,
      `    useExactScaleRendering: ${resolved.useExactScaleRendering}`,
      `    useZoomStateManager: ${resolved.useZoomStateManager}`,
    ].join('\n');
  }

  /**
   * Expose to window for DevTools access
   */
  exposeToWindow(): void {
    (globalThis as Record<string, unknown>).pdfFeatureFlags = this;
  }
}

// Singleton instance
let flagsInstance: FeatureFlagsManager | null = null;

/**
 * Get the shared feature flags instance
 */
export function getFeatureFlags(): FeatureFlagsManager {
  if (!flagsInstance) {
    flagsInstance = new FeatureFlagsManager();
    flagsInstance.exposeToWindow();
  }
  return flagsInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetFeatureFlags(): void {
  flagsInstance = null;
}

/**
 * Initialize feature flags and wait for capability detection
 * @param timeout Maximum time to wait for detection (ms)
 */
export async function initializeFeatureFlags(timeout: number = 3000): Promise<void> {
  const flags = getFeatureFlags();
  await flags.initialize(timeout);
}

/**
 * Convenience function to check if a feature is enabled
 */
export function isFeatureEnabled<K extends keyof ResolvedFeatureFlags>(
  flag: K
): ResolvedFeatureFlags[K] {
  return getFeatureFlags().isEnabled(flag);
}

/**
 * Convenience function to set a feature flag
 */
export function setFeatureFlag<K extends keyof FeatureFlagDefinitions>(
  flag: K,
  value: FeatureFlagDefinitions[K]
): void {
  getFeatureFlags().setFlag(flag, value);
}

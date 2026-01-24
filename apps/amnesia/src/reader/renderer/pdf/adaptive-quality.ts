/**
 * Adaptive Quality Manager
 *
 * Centralized quality management for PDF rendering that dynamically adjusts
 * render quality based on user interaction state (scrolling, zooming, idle).
 *
 * Phase 5: Adaptive Quality During Interaction
 * Goal: Smooth 60 FPS scroll at high zoom with quality restoration on idle.
 *
 * Key Features:
 * - Velocity tracking for scroll/zoom interactions
 * - Quality factor calculation based on speed zones
 * - Auto-upgrade to full quality when idle
 * - Debounced quality restoration to prevent thrashing
 *
 * Quality Factors:
 * - 1.0: Full quality (stationary/idle)
 * - 0.9: Slow scroll (slight reduction)
 * - 0.75: Medium scroll
 * - 0.5: Fast scroll
 * - 0.35: Very fast scroll/fling
 *
 * @example
 * ```typescript
 * const qualityManager = getAdaptiveQualityManager();
 *
 * // During scroll events
 * qualityManager.recordScrollVelocity(velocityX, velocityY);
 *
 * // When rendering
 * const quality = qualityManager.getCurrentQuality();
 * const scale = baseScale * quality;
 * ```
 */

import type { SpeedZone, ScrollVelocity } from './scroll-strategy';
import { getTelemetry } from './pdf-telemetry';

// ============================================================================
// Types
// ============================================================================

export interface QualityState {
  /** Current quality factor (0.35-1.0) */
  quality: number;
  /** Current speed zone */
  speedZone: SpeedZone;
  /** Whether currently in interaction (scroll/zoom) */
  isInteracting: boolean;
  /** Time since last interaction (ms) */
  idleTime: number;
  /** Whether quality upgrade is pending */
  upgradeScheduled: boolean;
}

export interface AdaptiveQualityConfig {
  /** Time in ms before starting quality upgrade after idle (default: 100ms) */
  idleUpgradeDelay: number;
  /** Time in ms to wait before considering user idle (default: 50ms) */
  idleThreshold: number;
  /** Enable smooth transitions between quality levels */
  smoothTransitions: boolean;
  /** Speed zone quality mappings */
  speedZoneQualities: Record<SpeedZone, number>;
  /** Speed thresholds (px/s) for zone transitions */
  speedThresholds: {
    slow: number;
    medium: number;
    fast: number;
    veryFast: number;
  };
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: AdaptiveQualityConfig = {
  idleUpgradeDelay: 200, // Start upgrade 200ms after idle
  idleThreshold: 250, // Consider idle after 250ms of no input (was 50ms - too aggressive)
  smoothTransitions: true,
  speedZoneQualities: {
    stationary: 1.0,
    slow: 0.9,
    medium: 0.75,
    fast: 0.5,
    veryFast: 0.35,
  },
  speedThresholds: {
    slow: 50,
    medium: 200,
    fast: 500,
    veryFast: 1000,
  },
};

// ============================================================================
// Adaptive Quality Manager
// ============================================================================

/**
 * Manages adaptive quality based on interaction velocity.
 *
 * Usage pattern:
 * 1. Record velocity during scroll/zoom events
 * 2. Query current quality when rendering
 * 3. Quality automatically upgrades when user becomes idle
 */
export class AdaptiveQualityManager {
  private config: AdaptiveQualityConfig;

  // Velocity tracking
  private currentVelocity: ScrollVelocity = { x: 0, y: 0 };
  private lastInteractionTime = 0;
  private velocityHistory: Array<{ velocity: ScrollVelocity; time: number }> = [];
  private readonly VELOCITY_HISTORY_SIZE = 10;

  // Quality state
  private currentQuality = 1.0;
  private currentSpeedZone: SpeedZone = 'stationary';
  private isInteracting = false;

  // Upgrade scheduling
  private upgradeTimeout: ReturnType<typeof setTimeout> | null = null;
  private upgradeScheduled = false;
  private onQualityUpgrade: (() => void) | null = null;

  constructor(config: Partial<AdaptiveQualityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Record scroll velocity during scroll events.
   * Call this on every scroll event to track user interaction.
   */
  recordScrollVelocity(velocityX: number, velocityY: number): void {
    const now = performance.now();

    this.currentVelocity = { x: velocityX, y: velocityY };
    this.lastInteractionTime = now;
    this.isInteracting = true;

    // Track velocity history for smoothing
    this.velocityHistory.push({ velocity: { x: velocityX, y: velocityY }, time: now });
    if (this.velocityHistory.length > this.VELOCITY_HISTORY_SIZE) {
      this.velocityHistory.shift();
    }

    // Calculate smoothed velocity
    const smoothedVelocity = this.getSmoothedVelocity();

    // Update quality based on speed
    this.updateQualityFromVelocity(smoothedVelocity);

    // Cancel pending upgrade
    this.cancelUpgrade();

    // Schedule idle detection
    this.scheduleIdleCheck();
  }

  /**
   * Record zoom interaction.
   * Call this during pinch-zoom or scroll-wheel zoom.
   */
  recordZoomInteraction(): void {
    const now = performance.now();
    this.lastInteractionTime = now;
    this.isInteracting = true;

    // During zoom, use medium-fast quality reduction
    this.currentSpeedZone = 'medium';
    this.currentQuality = this.config.speedZoneQualities.medium;

    // Cancel pending upgrade
    this.cancelUpgrade();

    // Schedule idle detection
    this.scheduleIdleCheck();
  }

  /**
   * Get current quality factor (0.35-1.0).
   * Use this when determining render scale.
   */
  getCurrentQuality(): number {
    return this.currentQuality;
  }

  /**
   * Get current speed zone.
   */
  getCurrentSpeedZone(): SpeedZone {
    return this.currentSpeedZone;
  }

  /**
   * Get full quality state for debugging/telemetry.
   */
  getState(): QualityState {
    const now = performance.now();
    return {
      quality: this.currentQuality,
      speedZone: this.currentSpeedZone,
      isInteracting: this.isInteracting,
      idleTime: this.lastInteractionTime > 0 ? now - this.lastInteractionTime : 0,
      upgradeScheduled: this.upgradeScheduled,
    };
  }

  /**
   * Set callback for quality upgrade events.
   * Called when quality is upgraded after idle.
   */
  setUpgradeCallback(callback: () => void): void {
    this.onQualityUpgrade = callback;
  }

  /**
   * Force quality to full (used when interaction ends).
   */
  forceFullQuality(): void {
    if (this.currentQuality < 1.0) {
      this.currentQuality = 1.0;
      this.currentSpeedZone = 'stationary';
      this.onQualityUpgrade?.();

      getTelemetry().trackCustomMetric('qualityUpgrade', 1.0);
      console.log('[AdaptiveQuality] Forced full quality');
    }
  }

  /**
   * Reset state (for document changes).
   */
  reset(): void {
    this.currentVelocity = { x: 0, y: 0 };
    this.lastInteractionTime = 0;
    this.velocityHistory = [];
    this.currentQuality = 1.0;
    this.currentSpeedZone = 'stationary';
    this.isInteracting = false;
    this.cancelUpgrade();

    // Clear idle check timeout to prevent memory leaks
    if (this.idleCheckTimeout) {
      clearTimeout(this.idleCheckTimeout);
      this.idleCheckTimeout = null;
    }
  }

  /**
   * Update configuration.
   */
  configure(config: Partial<AdaptiveQualityConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Get smoothed velocity from history (reduces jitter).
   */
  private getSmoothedVelocity(): ScrollVelocity {
    if (this.velocityHistory.length === 0) {
      return this.currentVelocity;
    }

    // Exponential weighted average (recent values weighted more)
    let totalWeight = 0;
    let weightedX = 0;
    let weightedY = 0;

    for (let i = 0; i < this.velocityHistory.length; i++) {
      const weight = Math.pow(2, i); // Exponential weighting
      const { velocity } = this.velocityHistory[i];
      weightedX += velocity.x * weight;
      weightedY += velocity.y * weight;
      totalWeight += weight;
    }

    return {
      x: weightedX / totalWeight,
      y: weightedY / totalWeight,
    };
  }

  /**
   * Determine speed zone from velocity.
   */
  private getSpeedZone(velocity: ScrollVelocity): SpeedZone {
    const speed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2);
    const { speedThresholds } = this.config;

    if (speed >= speedThresholds.veryFast) return 'veryFast';
    if (speed >= speedThresholds.fast) return 'fast';
    if (speed >= speedThresholds.medium) return 'medium';
    if (speed >= speedThresholds.slow) return 'slow';
    return 'stationary';
  }

  /**
   * Update quality based on velocity.
   */
  private updateQualityFromVelocity(velocity: ScrollVelocity): void {
    const newZone = this.getSpeedZone(velocity);
    const newQuality = this.config.speedZoneQualities[newZone];

    // Track zone changes for telemetry
    if (newZone !== this.currentSpeedZone) {
      // Get threshold for zone (stationary has threshold 0)
      const thresholdValue = newZone === 'stationary'
        ? 0
        : this.config.speedThresholds[newZone as keyof typeof this.config.speedThresholds] ?? 0;
      getTelemetry().trackCustomMetric('speedZoneChange', thresholdValue);
    }

    // Only decrease quality immediately; increases happen on idle
    if (newQuality < this.currentQuality) {
      this.currentQuality = newQuality;
      this.currentSpeedZone = newZone;
    } else if (newZone !== this.currentSpeedZone && newQuality >= this.currentQuality) {
      // Update zone but keep current (lower) quality until idle
      this.currentSpeedZone = newZone;
    }
  }

  /**
   * Schedule idle check after interaction stops.
   */
  private idleCheckTimeout: ReturnType<typeof setTimeout> | null = null;

  private scheduleIdleCheck(): void {
    if (this.idleCheckTimeout) {
      clearTimeout(this.idleCheckTimeout);
    }

    this.idleCheckTimeout = setTimeout(() => {
      this.checkIdle();
    }, this.config.idleThreshold);
  }

  /**
   * Check if user is idle and schedule quality upgrade.
   */
  private checkIdle(): void {
    const now = performance.now();
    const idleTime = now - this.lastInteractionTime;

    if (idleTime >= this.config.idleThreshold) {
      this.isInteracting = false;

      // If quality is reduced, schedule upgrade
      if (this.currentQuality < 1.0 && !this.upgradeScheduled) {
        this.scheduleUpgrade();
      }
    }
  }

  /**
   * Schedule quality upgrade after idle delay.
   */
  private scheduleUpgrade(): void {
    this.upgradeScheduled = true;

    this.upgradeTimeout = setTimeout(() => {
      // Double-check still idle
      const idleTime = performance.now() - this.lastInteractionTime;
      if (idleTime >= this.config.idleThreshold && this.currentQuality < 1.0) {
        const previousQuality = this.currentQuality;
        this.currentQuality = 1.0;
        this.currentSpeedZone = 'stationary';
        this.upgradeScheduled = false;

        getTelemetry().trackCustomMetric('qualityUpgrade', 1.0);
        console.log(`[AdaptiveQuality] Quality upgraded: ${previousQuality.toFixed(2)} → 1.0 (idle ${idleTime.toFixed(0)}ms)`);

        this.onQualityUpgrade?.();
      }
      this.upgradeScheduled = false;
    }, this.config.idleUpgradeDelay);
  }

  /**
   * Cancel pending quality upgrade.
   */
  private cancelUpgrade(): void {
    if (this.upgradeTimeout) {
      clearTimeout(this.upgradeTimeout);
      this.upgradeTimeout = null;
    }
    this.upgradeScheduled = false;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: AdaptiveQualityManager | null = null;

/**
 * Get the shared AdaptiveQualityManager instance.
 */
export function getAdaptiveQualityManager(): AdaptiveQualityManager {
  if (!instance) {
    instance = new AdaptiveQualityManager();
  }
  return instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetAdaptiveQualityManager(): void {
  if (instance) {
    instance.reset();
  }
  instance = null;
}

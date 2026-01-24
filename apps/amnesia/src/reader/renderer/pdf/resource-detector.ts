/**
 * Resource Capacity Detector
 *
 * Unified module for system profiling, runtime monitoring, and adaptive
 * performance recommendations. Coordinates the detection components and
 * provides a simple API for integration.
 *
 * Components:
 * - SystemProfiler: Hardware detection at startup
 * - RuntimeMonitor: Live metrics tracking (FPS, memory, thermal)
 * - RecommendationEngine: Rule-based decision matrix
 * - PromptManager: User notification and consent handling
 * - PreferenceStore: User preference persistence
 *
 * @example
 * ```typescript
 * import { initializeResourceDetector } from './resource-detector';
 *
 * // Initialize with Obsidian app during plugin load
 * const detector = await initializeResourceDetector(app);
 *
 * // Set document info when opening a PDF
 * detector.setDocumentInfo({ pageCount: 500, fileSizeMB: 150 });
 *
 * // Start monitoring
 * detector.start();
 *
 * // Get system profile
 * const profile = detector.getSystemProfile();
 *
 * // Stop and cleanup
 * detector.stop();
 * ```
 */

import { App } from 'obsidian';

// Re-export all components
export {
  getSystemProfiler,
  resetSystemProfiler,
  type SystemProfiler,
  type SystemProfile,
  type DeviceTier,
  type CpuProfile,
  type MemoryProfile,
  type GpuProfile,
  type PlatformProfile,
  type BatteryProfile,
} from './system-profiler';

export {
  getRuntimeMonitor,
  resetRuntimeMonitor,
  type RuntimeMonitor,
  type RuntimeMetrics,
  type FpsMetrics,
  type MemoryMetrics as RuntimeMemoryMetrics,
  type ThermalMetrics,
  type LongTaskMetrics,
  type RuntimeAlert,
  type AlertSeverity,
  type AlertType,
  type MonitorConfig,
} from './runtime-monitor';

export {
  getRecommendationEngine,
  resetRecommendationEngine,
  type RecommendationEngine,
  type Recommendation,
  type RecommendationAction,
  type RecommendationSeverity,
  type DocumentInfo,
  type Rule,
  type RuleContext,
} from './recommendation-engine';

export {
  getPromptManager,
  resetPromptManager,
  type PromptManager,
  type UserAction,
  type UserActionType,
  type PromptConfig,
} from './prompt-manager';

export {
  getPreferenceStore,
  initializePreferenceStore,
  resetPreferenceStore,
  type PreferenceStore,
  type StoredPreferences,
  type SuppressionType,
  type SuppressionEntry,
} from './preference-store';

// Internal imports for initialization
import { getSystemProfiler } from './system-profiler';
import { getRuntimeMonitor } from './runtime-monitor';
import { getRecommendationEngine, type DocumentInfo } from './recommendation-engine';
import { getPromptManager } from './prompt-manager';
import { getPreferenceStore, type StoredPreferences } from './preference-store';
import { getTelemetry } from './pdf-telemetry';

/**
 * Resource Detector facade
 */
export interface ResourceDetector {
  /** Get the system profile (cached) */
  getSystemProfile(): ReturnType<ReturnType<typeof getSystemProfiler>['getCachedProfile']>;
  /** Get current runtime metrics */
  getRuntimeMetrics(): ReturnType<ReturnType<typeof getRuntimeMonitor>['getMetrics']>;
  /** Set document info for context-aware recommendations */
  setDocumentInfo(info: DocumentInfo | null): void;
  /** Update zoom level for recommendations */
  updateZoomLevel(zoom: number): void;
  /** Start monitoring and recommendations */
  start(): void;
  /** Stop monitoring and recommendations */
  stop(): void;
  /** Get a combined summary for debugging */
  getSummary(): string;
}

/**
 * Initialize the resource detector system
 *
 * @param app Obsidian app reference
 * @param savedPreferences Previously saved preferences (from plugin settings)
 */
export async function initializeResourceDetector(
  app: App,
  savedPreferences?: Partial<StoredPreferences>
): Promise<ResourceDetector> {
  // Initialize preference store
  const preferenceStore = getPreferenceStore();
  if (savedPreferences) {
    preferenceStore.load(savedPreferences);
  }

  // Initialize system profiler
  const profiler = getSystemProfiler();
  const systemProfile = await profiler.getProfile();

  // Initialize prompt manager
  const promptManager = getPromptManager();
  promptManager.initialize(app);

  // Initialize recommendation engine
  const recommendationEngine = getRecommendationEngine();

  // Initialize runtime monitor
  const runtimeMonitor = getRuntimeMonitor();

  // Wire up recommendation engine to prompt manager
  recommendationEngine.onRecommendation((rec) => {
    promptManager.showRecommendation(rec);
  });

  // Track initialization
  getTelemetry().trackCustomMetric('resourceDetectorInitialized', 1);
  getTelemetry().trackCustomMetric(`deviceTier_${systemProfile.tier}`, 1);

  return {
    getSystemProfile() {
      return profiler.getCachedProfile();
    },

    getRuntimeMetrics() {
      return runtimeMonitor.getMetrics();
    },

    setDocumentInfo(info) {
      recommendationEngine.setDocumentInfo(info);
    },

    updateZoomLevel(zoom) {
      recommendationEngine.updateZoomLevel(zoom);
    },

    start() {
      runtimeMonitor.start();
      recommendationEngine.startAutoEvaluation();
    },

    stop() {
      runtimeMonitor.stop();
      recommendationEngine.stopAutoEvaluation();
    },

    getSummary() {
      return [
        profiler.getSummary(),
        '',
        runtimeMonitor.getSummary(),
        '',
        recommendationEngine.getSummary(),
        '',
        promptManager.getSummary(),
        '',
        preferenceStore.getSummary(),
      ].join('\n');
    },
  };
}

/**
 * Reset all resource detector components (for testing)
 */
export function resetResourceDetector(): void {
  resetPreferenceStore();
  resetPromptManager();
  resetRecommendationEngine();
  resetRuntimeMonitor();
  resetSystemProfiler();
}

// Import reset functions
import { resetSystemProfiler } from './system-profiler';
import { resetRuntimeMonitor } from './runtime-monitor';
import { resetRecommendationEngine } from './recommendation-engine';
import { resetPromptManager } from './prompt-manager';
import { resetPreferenceStore } from './preference-store';

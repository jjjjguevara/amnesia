/**
 * Recommendation Engine
 *
 * Analyzes system profile and runtime metrics to generate performance recommendations.
 * Uses a rule-based decision matrix to suggest preset changes, cache cleanup,
 * or other optimizations.
 *
 * Rules are evaluated in priority order and can trigger actions or suggestions
 * based on current conditions.
 *
 * @example
 * ```typescript
 * const engine = getRecommendationEngine();
 *
 * // Initialize with document info
 * engine.setDocumentInfo({ pageCount: 500, fileSizeMB: 150 });
 *
 * // Evaluate rules based on current state
 * const recommendations = await engine.evaluate();
 *
 * // Subscribe to automatic recommendations
 * const unsubscribe = engine.onRecommendation((rec) => {
 *   console.log('Recommendation:', rec.title);
 *   console.log('Action:', rec.action);
 * });
 * ```
 */

import type { PdfPerformancePreset } from '../../../settings/settings';
import { getSystemProfiler, type SystemProfile, type DeviceTier } from './system-profiler';
import { getRuntimeMonitor, type RuntimeMetrics, type RuntimeAlert } from './runtime-monitor';
import { getPerformanceSettingsManager } from './performance-settings-manager';
import { getTelemetry } from './pdf-telemetry';

/**
 * Recommendation severity
 */
export type RecommendationSeverity = 'info' | 'warning' | 'critical';

/**
 * Recommendation action types
 */
export type RecommendationAction =
  | { type: 'suggest-preset'; preset: PdfPerformancePreset }
  | { type: 'auto-apply-preset'; preset: PdfPerformancePreset }
  | { type: 'reduce-workers'; targetCount: number }
  | { type: 'clear-cache'; tier: 'l1' | 'l2' | 'all' }
  | { type: 'cap-zoom'; maxZoom: number }
  | { type: 'reduce-quality'; targetQuality: number }
  | { type: 'info-only' };

/**
 * Performance recommendation
 */
export interface Recommendation {
  /** Unique rule ID */
  ruleId: string;
  /** Human-readable title */
  title: string;
  /** Detailed description */
  description: string;
  /** Severity level */
  severity: RecommendationSeverity;
  /** Recommended action */
  action: RecommendationAction;
  /** Whether user should be prompted */
  requiresUserConsent: boolean;
  /** Timestamp when generated */
  timestamp: number;
  /** Conditions that triggered this recommendation */
  triggers: string[];
}

/**
 * Document information for context-aware recommendations
 */
export interface DocumentInfo {
  /** Number of pages in the document */
  pageCount: number;
  /** File size in MB */
  fileSizeMB: number;
  /** Whether document has heavy images */
  hasHeavyImages?: boolean;
  /** Current zoom level */
  currentZoom?: number;
}

/**
 * Rule evaluation context
 */
export interface RuleContext {
  /** System profile */
  system: SystemProfile;
  /** Runtime metrics */
  runtime: RuntimeMetrics;
  /** Document info */
  document: DocumentInfo | null;
  /** Current preset */
  currentPreset: PdfPerformancePreset;
  /** Recent alerts */
  recentAlerts: RuntimeAlert[];
}

/**
 * Rule definition
 */
export interface Rule {
  /** Unique rule ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Rule priority (lower = higher priority) */
  priority: number;
  /** Whether this rule is enabled */
  enabled: boolean;
  /** Cooldown between triggering (ms) */
  cooldownMs: number;
  /** Evaluate the rule and return a recommendation if triggered */
  evaluate: (context: RuleContext) => Recommendation | null;
}

/**
 * Recommendation callback type
 */
export type RecommendationCallback = (recommendation: Recommendation) => void;

// ==========================================================================
// Built-in Rules
// ==========================================================================

const RULES: Rule[] = [
  // Rule 1: Low-end device + large PDF
  {
    id: 'low-end-large-pdf',
    name: 'Low-end device with large PDF',
    priority: 1,
    enabled: true,
    cooldownMs: 60000, // 1 minute
    evaluate: (ctx) => {
      if (
        ctx.system.tier === 'low' &&
        ctx.document &&
        ctx.document.pageCount >= 500 &&
        ctx.currentPreset !== 'memory-saver'
      ) {
        return {
          ruleId: 'low-end-large-pdf',
          title: 'Large PDF on limited device',
          description: `This ${ctx.document.pageCount}-page PDF may cause performance issues on your device. Consider switching to Memory Saver mode for smoother scrolling.`,
          severity: 'warning',
          action: { type: 'suggest-preset', preset: 'memory-saver' },
          requiresUserConsent: true,
          timestamp: Date.now(),
          triggers: [
            `Device tier: ${ctx.system.tier}`,
            `Page count: ${ctx.document.pageCount}`,
          ],
        };
      }
      return null;
    },
  },

  // Rule 2: High zoom + high DPI + low memory
  {
    id: 'high-zoom-low-memory',
    name: 'High zoom with limited memory',
    priority: 2,
    enabled: true,
    cooldownMs: 30000,
    evaluate: (ctx) => {
      const isHighZoom = (ctx.document?.currentZoom ?? 1) >= 8;
      const isHighDpi = ctx.system.platform.devicePixelRatio >= 2;
      const isLowMemory = ctx.system.memory.tier === 'low';

      if (isHighZoom && isHighDpi && isLowMemory) {
        return {
          ruleId: 'high-zoom-low-memory',
          title: 'High zoom may cause memory issues',
          description:
            'Zooming to 8x or higher on a high-DPI display with limited memory may cause slowdowns. Consider reducing zoom or switching to Memory Saver mode.',
          severity: 'warning',
          action: { type: 'cap-zoom', maxZoom: 6 },
          requiresUserConsent: true,
          timestamp: Date.now(),
          triggers: [
            `Zoom: ${ctx.document?.currentZoom ?? 'unknown'}x`,
            `DPI: ${ctx.system.platform.devicePixelRatio}x`,
            `Memory tier: ${ctx.system.memory.tier}`,
          ],
        };
      }
      return null;
    },
  },

  // Rule 3: Low battery
  {
    id: 'low-battery',
    name: 'Low battery detected',
    priority: 3,
    enabled: true,
    cooldownMs: 300000, // 5 minutes
    evaluate: (ctx) => {
      if (
        ctx.system.battery.isLow &&
        ctx.currentPreset !== 'memory-saver'
      ) {
        return {
          ruleId: 'low-battery',
          title: 'Battery is low',
          description:
            'Your battery is below 20%. Switching to Memory Saver mode can extend battery life by reducing CPU and GPU usage.',
          severity: 'info',
          action: { type: 'suggest-preset', preset: 'memory-saver' },
          requiresUserConsent: true,
          timestamp: Date.now(),
          triggers: [
            `Battery: ${((ctx.system.battery.level ?? 0) * 100).toFixed(0)}%`,
            `Charging: ${ctx.system.battery.charging ? 'yes' : 'no'}`,
          ],
        };
      }
      return null;
    },
  },

  // Rule 4: Thermal throttling detected
  {
    id: 'thermal-throttling',
    name: 'Thermal throttling detected',
    priority: 1, // High priority
    enabled: true,
    cooldownMs: 60000,
    evaluate: (ctx) => {
      if (
        ctx.runtime.thermal.isThrottled &&
        ctx.runtime.thermal.confidence > 0.7
      ) {
        const currentSettings = getPerformanceSettingsManager().getSettings();
        const currentWorkers = currentSettings.resolvedWorkerCount;

        if (currentWorkers > 1) {
          return {
            ruleId: 'thermal-throttling',
            title: 'Device is overheating',
            description:
              'Thermal throttling detected. Reducing worker count can help cool down your device and improve stability.',
            severity: 'warning',
            action: {
              type: 'reduce-workers',
              targetCount: Math.max(1, currentWorkers - 1),
            },
            requiresUserConsent: true,
            timestamp: Date.now(),
            triggers: [
              `Throttled: yes`,
              `Confidence: ${(ctx.runtime.thermal.confidence * 100).toFixed(0)}%`,
              `Frame trend: ${ctx.runtime.thermal.frameTimeTrend.toFixed(2)}ms/frame`,
            ],
          };
        }
      }
      return null;
    },
  },

  // Rule 5: Critical memory pressure
  {
    id: 'critical-memory-pressure',
    name: 'Critical memory pressure',
    priority: 0, // Highest priority
    enabled: true,
    cooldownMs: 10000, // Short cooldown for critical issues
    evaluate: (ctx) => {
      if (ctx.runtime.memory.pressure === 'critical') {
        return {
          ruleId: 'critical-memory-pressure',
          title: 'Memory critically low',
          description:
            'Memory pressure is critical. Clearing tile cache to prevent crashes.',
          severity: 'critical',
          action: { type: 'clear-cache', tier: 'all' },
          requiresUserConsent: false, // Auto-apply to prevent crash
          timestamp: Date.now(),
          triggers: [
            `Memory pressure: ${ctx.runtime.memory.pressure}`,
            `Heap usage: ${((ctx.runtime.memory.heapUsagePercent ?? 0) * 100).toFixed(0)}%`,
          ],
        };
      }
      return null;
    },
  },

  // Rule 6: Sustained low FPS
  {
    id: 'sustained-low-fps',
    name: 'Sustained low FPS',
    priority: 2,
    enabled: true,
    cooldownMs: 30000,
    evaluate: (ctx) => {
      const lowFpsAlerts = ctx.recentAlerts.filter(
        (a) => a.type === 'low-fps' && a.severity === 'critical'
      );

      // 3+ critical FPS alerts in recent history
      if (lowFpsAlerts.length >= 3 && ctx.currentPreset !== 'memory-saver') {
        return {
          ruleId: 'sustained-low-fps',
          title: 'Performance issues detected',
          description:
            'Sustained low frame rate detected. Consider switching to Memory Saver mode or reducing worker count.',
          severity: 'warning',
          action: { type: 'suggest-preset', preset: 'memory-saver' },
          requiresUserConsent: true,
          timestamp: Date.now(),
          triggers: [
            `Low FPS alerts: ${lowFpsAlerts.length}`,
            `Average FPS: ${ctx.runtime.fps.average.toFixed(0)}`,
          ],
        };
      }
      return null;
    },
  },
];

/**
 * Recommendation Engine class
 */
export class RecommendationEngine {
  private rules: Rule[] = [...RULES];
  private documentInfo: DocumentInfo | null = null;
  private recentAlerts: RuntimeAlert[] = [];
  private alertUnsubscribe: (() => void) | null = null;
  private lastTriggered: Map<string, number> = new Map();
  private recommendationCallbacks: Set<RecommendationCallback> = new Set();
  private isAutoEvaluating = false;
  private isEvaluating = false; // Guard against concurrent evaluations
  private autoEvaluateIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Sort rules by priority
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Set document information for context-aware recommendations
   */
  setDocumentInfo(info: DocumentInfo | null): void {
    this.documentInfo = info;
  }

  /**
   * Update document zoom level
   */
  updateZoomLevel(zoom: number): void {
    if (this.documentInfo) {
      // Clone to maintain immutability
      this.documentInfo = { ...this.documentInfo, currentZoom: zoom };
    }
  }

  /**
   * Start automatic evaluation on a timer
   */
  startAutoEvaluation(intervalMs = 5000): void {
    if (this.isAutoEvaluating) return;

    this.isAutoEvaluating = true;

    // Subscribe to runtime alerts
    const monitor = getRuntimeMonitor();
    this.alertUnsubscribe = monitor.onAlert((alert) => {
      this.recentAlerts.push(alert);
      // Keep last 20 alerts
      if (this.recentAlerts.length > 20) {
        this.recentAlerts.shift();
      }
    });

    // Periodic evaluation with guard against concurrent evaluations
    this.autoEvaluateIntervalId = setInterval(async () => {
      if (this.isEvaluating) return; // Skip if already evaluating

      this.isEvaluating = true;
      try {
        const recommendations = await this.evaluate();
        for (const rec of recommendations) {
          this.notifyRecommendation(rec);
        }
      } finally {
        this.isEvaluating = false;
      }
    }, intervalMs);

    getTelemetry().trackCustomMetric('recommendationEngineStarted', 1);
  }

  /**
   * Stop automatic evaluation
   */
  stopAutoEvaluation(): void {
    if (!this.isAutoEvaluating) return;

    this.isAutoEvaluating = false;
    this.isEvaluating = false;

    if (this.alertUnsubscribe) {
      this.alertUnsubscribe();
      this.alertUnsubscribe = null;
    }

    if (this.autoEvaluateIntervalId) {
      clearInterval(this.autoEvaluateIntervalId);
      this.autoEvaluateIntervalId = null;
    }

    // Clear transient state (but not callbacks - subscribers manage their own cleanup)
    this.recentAlerts = [];

    getTelemetry().trackCustomMetric('recommendationEngineStopped', 1);
  }

  /**
   * Evaluate all rules and return triggered recommendations
   */
  async evaluate(): Promise<Recommendation[]> {
    const context = await this.buildContext();
    const recommendations: Recommendation[] = [];

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      // Check cooldown
      const lastTriggered = this.lastTriggered.get(rule.id);
      if (lastTriggered && Date.now() - lastTriggered < rule.cooldownMs) {
        continue;
      }

      try {
        const recommendation = rule.evaluate(context);
        if (recommendation) {
          this.lastTriggered.set(rule.id, Date.now());
          recommendations.push(recommendation);

          // Track in telemetry
          getTelemetry().trackCustomMetric(`recommendation_${rule.id}`, 1);
        }
      } catch (e) {
        console.error(`[RecommendationEngine] Rule ${rule.id} error:`, e);
      }
    }

    return recommendations;
  }

  /**
   * Subscribe to recommendations
   */
  onRecommendation(callback: RecommendationCallback): () => void {
    this.recommendationCallbacks.add(callback);
    return () => this.recommendationCallbacks.delete(callback);
  }

  /**
   * Enable or disable a rule
   */
  setRuleEnabled(ruleId: string, enabled: boolean): void {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (rule) {
      rule.enabled = enabled;
    }
  }

  /**
   * Get all rules
   */
  getRules(): Rule[] {
    return [...this.rules];
  }

  /**
   * Reset cooldowns (for testing)
   */
  resetCooldowns(): void {
    this.lastTriggered.clear();
  }

  /**
   * Get a formatted summary for debugging
   */
  getSummary(): string {
    const enabledRules = this.rules.filter((r) => r.enabled);
    const triggeredRecently = Array.from(this.lastTriggered.entries())
      .filter(([, time]) => Date.now() - time < 60000)
      .map(([id]) => id);

    return [
      '[Recommendation Engine]',
      `  Auto-evaluating: ${this.isAutoEvaluating ? 'yes' : 'no'}`,
      `  Document: ${this.documentInfo ? `${this.documentInfo.pageCount} pages, ${this.documentInfo.fileSizeMB}MB` : 'none'}`,
      `  Recent alerts: ${this.recentAlerts.length}`,
      '',
      '  Rules:',
      ...enabledRules.map(
        (r) =>
          `    ${r.id}: ${triggeredRecently.includes(r.id) ? 'triggered recently' : 'ready'}`
      ),
    ].join('\n');
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async buildContext(): Promise<RuleContext> {
    const profiler = getSystemProfiler();
    const monitor = getRuntimeMonitor();
    const settingsManager = getPerformanceSettingsManager();

    const system = await profiler.getProfile();
    const runtime = monitor.getMetrics();
    const currentPreset = settingsManager.getPreset();

    return {
      system,
      runtime,
      document: this.documentInfo,
      currentPreset,
      recentAlerts: [...this.recentAlerts],
    };
  }

  private notifyRecommendation(recommendation: Recommendation): void {
    for (const callback of this.recommendationCallbacks) {
      try {
        callback(recommendation);
      } catch (e) {
        console.error('[RecommendationEngine] Callback error:', e);
      }
    }
  }
}

// ==========================================================================
// Singleton Instance
// ==========================================================================

let instance: RecommendationEngine | null = null;

/**
 * Get the shared recommendation engine instance
 */
export function getRecommendationEngine(): RecommendationEngine {
  if (!instance) {
    instance = new RecommendationEngine();
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetRecommendationEngine(): void {
  if (instance) {
    instance.stopAutoEvaluation();
  }
  instance = null;
}

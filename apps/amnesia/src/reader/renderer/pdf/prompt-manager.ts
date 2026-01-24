/**
 * Prompt Manager
 *
 * Displays performance recommendations to users via Obsidian Notice or Modal.
 * Handles user responses (accept, dismiss, never show) and integrates with
 * the preference store for persistence.
 *
 * Design principles:
 * - Non-intrusive: Info-level recommendations use Notice (auto-dismiss)
 * - User agency: Warning/Critical recommendations require explicit action
 * - No auto-apply: Actions are suggestions except for critical safety issues
 * - Respect preferences: Never show suppressed recommendations
 *
 * @example
 * ```typescript
 * const promptManager = getPromptManager();
 *
 * // Initialize with Obsidian app reference
 * promptManager.initialize(app);
 *
 * // Show a recommendation
 * promptManager.showRecommendation(recommendation);
 *
 * // Subscribe to user actions
 * promptManager.onAction((action) => {
 *   if (action.type === 'accepted') {
 *     applyRecommendation(action.recommendation);
 *   }
 * });
 * ```
 */

import { Notice, Modal, App, Setting } from 'obsidian';
import {
  type Recommendation,
  type RecommendationAction,
} from './recommendation-engine';
import {
  getPreferenceStore,
  type SuppressionType,
} from './preference-store';
import { getPerformanceSettingsManager } from './performance-settings-manager';
import { getTelemetry } from './pdf-telemetry';

/**
 * User action types
 */
export type UserActionType = 'accepted' | 'dismissed' | 'suppressed';

/**
 * User action event
 */
export interface UserAction {
  /** Action type */
  type: UserActionType;
  /** The recommendation this action is for */
  recommendation: Recommendation;
  /** Suppression type if suppressed */
  suppressionType?: SuppressionType;
  /** Timestamp */
  timestamp: number;
}

/**
 * Action callback type
 */
export type ActionCallback = (action: UserAction) => void;

/**
 * Prompt configuration
 */
export interface PromptConfig {
  /** Duration for info notices (ms) */
  infoNoticeDuration: number;
  /** Duration for warning notices (ms) */
  warningNoticeDuration: number;
  /** Whether to show the onboarding prompt for first-time users */
  showOnboarding: boolean;
  /** Maximum concurrent prompts */
  maxConcurrentPrompts: number;
}

const DEFAULT_CONFIG: PromptConfig = {
  infoNoticeDuration: 8000,
  warningNoticeDuration: 0, // 0 = no auto-dismiss
  showOnboarding: true,
  maxConcurrentPrompts: 2,
};

/**
 * Recommendation Modal
 */
class RecommendationModal extends Modal {
  private recommendation: Recommendation;
  private onAction: (
    type: UserActionType,
    suppressionType?: SuppressionType
  ) => void;
  private actionTaken = false;
  private listeners: Array<{
    element: HTMLElement;
    type: string;
    handler: EventListener;
  }> = [];

  constructor(
    app: App,
    recommendation: Recommendation,
    onAction: (type: UserActionType, suppressionType?: SuppressionType) => void
  ) {
    super(app);
    this.recommendation = recommendation;
    this.onAction = onAction;
  }

  onOpen(): void {
    const { contentEl } = this;
    const rec = this.recommendation;

    // Title
    contentEl.createEl('h2', { text: rec.title });

    // Severity badge
    const severityClass = `amnesia-severity-${rec.severity}`;
    contentEl.createEl('span', {
      text: rec.severity.toUpperCase(),
      cls: ['amnesia-severity-badge', severityClass],
    });

    // Description
    contentEl.createEl('p', {
      text: rec.description,
      cls: 'amnesia-recommendation-description',
    });

    // Triggers (what caused this recommendation)
    if (rec.triggers.length > 0) {
      const triggerEl = contentEl.createEl('div', {
        cls: 'amnesia-recommendation-triggers',
      });
      triggerEl.createEl('strong', { text: 'Detected conditions:' });
      const triggerList = triggerEl.createEl('ul');
      for (const trigger of rec.triggers) {
        triggerList.createEl('li', { text: trigger });
      }
    }

    // Action description
    const actionDesc = this.getActionDescription(rec.action);
    if (actionDesc) {
      contentEl.createEl('p', {
        text: `Suggested action: ${actionDesc}`,
        cls: 'amnesia-recommendation-action',
      });
    }

    // Buttons
    const buttonContainer = contentEl.createEl('div', {
      cls: 'amnesia-recommendation-buttons',
    });

    // Apply button (primary) - modals are only shown for consent-required actions
    const applyBtn = buttonContainer.createEl('button', {
      text: 'Apply',
      cls: 'mod-cta',
    });
    const applyHandler = () => {
      this.actionTaken = true;
      this.onAction('accepted');
      this.close();
    };
    applyBtn.addEventListener('click', applyHandler);
    this.listeners.push({ element: applyBtn, type: 'click', handler: applyHandler });

    // Dismiss button
    const dismissBtn = buttonContainer.createEl('button', {
      text: 'Dismiss',
    });
    const dismissHandler = () => {
      this.actionTaken = true;
      this.onAction('dismissed');
      this.close();
    };
    dismissBtn.addEventListener('click', dismissHandler);
    this.listeners.push({ element: dismissBtn, type: 'click', handler: dismissHandler });

    // "Don't show again" options
    const suppressContainer = contentEl.createEl('div', {
      cls: 'amnesia-recommendation-suppress',
    });

    new Setting(suppressContainer)
      .setName("Don't show this again")
      .addDropdown((dropdown) => {
        dropdown
          .addOption('', 'Show again')
          .addOption('session', 'Hide for this session')
          .addOption('temporary', 'Hide for 24 hours')
          .addOption('never', 'Never show again')
          .onChange((value) => {
            if (value) {
              this.actionTaken = true;
              this.onAction('suppressed', value as SuppressionType);
              this.close();
            }
          });
      });
  }

  onClose(): void {
    // Clean up event listeners to prevent memory leaks
    for (const { element, type, handler } of this.listeners) {
      element.removeEventListener(type, handler);
    }
    this.listeners = [];

    // If user closed via X button without taking action, treat as dismiss
    if (!this.actionTaken) {
      this.onAction('dismissed');
    }

    const { contentEl } = this;
    contentEl.empty();
  }

  private getActionDescription(action: RecommendationAction): string {
    switch (action.type) {
      case 'suggest-preset':
        return `Switch to "${action.preset}" performance preset`;
      case 'auto-apply-preset':
        return `Automatically switch to "${action.preset}" preset`;
      case 'reduce-workers':
        return `Reduce worker count to ${action.targetCount}`;
      case 'clear-cache':
        return `Clear ${action.tier === 'all' ? 'all' : action.tier} tile cache`;
      case 'cap-zoom':
        return `Limit maximum zoom to ${action.maxZoom}x`;
      case 'reduce-quality':
        return `Reduce rendering quality to ${action.targetQuality}%`;
      case 'info-only':
        return '';
    }
  }
}

/**
 * Prompt Manager class
 */
export class PromptManager {
  private app: App | null = null;
  private config: PromptConfig;
  private actionCallbacks: Set<ActionCallback> = new Set();
  private activePrompts: Set<string> = new Set();

  constructor(config: Partial<PromptConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize with Obsidian app reference
   */
  initialize(app: App): void {
    this.app = app;
  }

  /**
   * Show a recommendation to the user
   */
  showRecommendation(recommendation: Recommendation): void {
    if (!this.app) {
      console.warn('[PromptManager] Not initialized with app reference');
      return;
    }

    // Check if suppressed
    const store = getPreferenceStore();
    if (store.isRuleSuppressed(recommendation.ruleId)) {
      return;
    }

    // Check concurrent prompt limit
    if (this.activePrompts.size >= this.config.maxConcurrentPrompts) {
      // Queue or skip based on severity
      if (recommendation.severity !== 'critical') {
        return;
      }
    }

    this.activePrompts.add(recommendation.ruleId);

    // Choose display method based on severity and consent requirement
    if (!recommendation.requiresUserConsent) {
      // Auto-apply without user interaction (critical safety actions only)
      this.applyAction(recommendation.action);
      this.activePrompts.delete(recommendation.ruleId);
      // Show brief notice to inform user
      this.showNotice(recommendation);
    } else if (recommendation.severity === 'info') {
      // Info-level with consent: show dismissible notice
      this.showNotice(recommendation);
    } else {
      // Warning/Critical with consent: show modal for explicit approval
      this.showModal(recommendation);
    }

    getTelemetry().trackCustomMetric('promptShown', 1);
  }

  /**
   * Apply a recommendation action
   */
  applyAction(action: RecommendationAction): void {
    const settingsManager = getPerformanceSettingsManager();

    switch (action.type) {
      case 'suggest-preset':
      case 'auto-apply-preset':
        if (action.preset !== 'custom') {
          settingsManager.applyPreset(action.preset);
          getPreferenceStore().recordPresetApplication(
            action.preset,
            'recommendation'
          );
        }
        break;

      case 'reduce-workers':
        settingsManager.updateSetting('workerCount', action.targetCount);
        break;

      case 'clear-cache':
        // This would need to be wired to TileCacheManager
        // For now, track the intent
        getTelemetry().trackCustomMetric('cacheCleared', 1);
        break;

      case 'cap-zoom':
        // This would need to be wired to InfiniteCanvas
        // For now, track the intent
        getTelemetry().trackCustomMetric('zoomCapped', 1);
        break;

      case 'reduce-quality':
        settingsManager.updateSetting('fastScrollQuality', action.targetQuality / 100);
        break;

      case 'info-only':
        // No action needed
        break;
    }

    getTelemetry().trackCustomMetric('actionApplied', 1);
  }

  /**
   * Subscribe to user actions
   */
  onAction(callback: ActionCallback): () => void {
    this.actionCallbacks.add(callback);
    return () => this.actionCallbacks.delete(callback);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PromptConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Cleanup all resources (call on plugin unload)
   */
  destroy(): void {
    this.actionCallbacks.clear();
    this.activePrompts.clear();
    this.app = null;
  }

  /**
   * Get a formatted summary for debugging
   */
  getSummary(): string {
    return [
      '[Prompt Manager]',
      `  Initialized: ${this.app ? 'yes' : 'no'}`,
      `  Active Prompts: ${this.activePrompts.size}`,
      `  Action Subscribers: ${this.actionCallbacks.size}`,
    ].join('\n');
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private showNotice(recommendation: Recommendation): void {
    const duration =
      recommendation.severity === 'info'
        ? this.config.infoNoticeDuration
        : this.config.warningNoticeDuration;

    const notice = new Notice(
      `${recommendation.title}\n${recommendation.description}`,
      duration
    );

    // Track dismissal when notice closes
    setTimeout(() => {
      this.activePrompts.delete(recommendation.ruleId);
    }, duration || 10000);

    this.notifyAction({
      type: 'dismissed',
      recommendation,
      timestamp: Date.now(),
    });
  }

  private showModal(recommendation: Recommendation): void {
    if (!this.app) return;

    const modal = new RecommendationModal(
      this.app,
      recommendation,
      (type, suppressionType) => {
        this.handleModalAction(recommendation, type, suppressionType);
      }
    );

    modal.open();
  }

  private handleModalAction(
    recommendation: Recommendation,
    type: UserActionType,
    suppressionType?: SuppressionType
  ): void {
    this.activePrompts.delete(recommendation.ruleId);
    const store = getPreferenceStore();

    switch (type) {
      case 'accepted':
        this.applyAction(recommendation.action);
        this.notifyAction({
          type: 'accepted',
          recommendation,
          timestamp: Date.now(),
        });
        break;

      case 'dismissed':
        store.recordDismissal();
        this.notifyAction({
          type: 'dismissed',
          recommendation,
          timestamp: Date.now(),
        });
        break;

      case 'suppressed':
        if (suppressionType) {
          store.suppressRule(recommendation.ruleId, suppressionType);
        }
        this.notifyAction({
          type: 'suppressed',
          recommendation,
          suppressionType,
          timestamp: Date.now(),
        });
        break;
    }

    getTelemetry().trackCustomMetric(`prompt_${type}`, 1);
  }

  private notifyAction(action: UserAction): void {
    for (const callback of this.actionCallbacks) {
      try {
        callback(action);
      } catch (e) {
        console.error('[PromptManager] Action callback error:', e);
      }
    }
  }
}

// ==========================================================================
// Singleton Instance
// ==========================================================================

let instance: PromptManager | null = null;

/**
 * Get the shared prompt manager instance
 */
export function getPromptManager(): PromptManager {
  if (!instance) {
    instance = new PromptManager();
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetPromptManager(): void {
  instance = null;
}

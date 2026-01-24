/**
 * Preference Store
 *
 * Persists user preferences for performance recommendations.
 * Stores dismissed recommendations, "never show again" settings,
 * and applied presets history.
 *
 * @example
 * ```typescript
 * const store = getPreferenceStore();
 *
 * // Check if recommendation should be shown
 * if (!store.isRuleSuppressed('low-battery')) {
 *   showRecommendation();
 * }
 *
 * // Mark as "never show again"
 * store.suppressRule('low-battery', 'never');
 *
 * // Temporarily dismiss (24 hours)
 * store.suppressRule('high-zoom-low-memory', 'temporary');
 * ```
 */

/**
 * Suppression type
 */
export type SuppressionType = 'never' | 'temporary' | 'session';

/**
 * Suppression entry
 */
export interface SuppressionEntry {
  /** When the suppression was created */
  timestamp: number;
  /** Type of suppression */
  type: SuppressionType;
  /** Expiration timestamp (null for 'never') */
  expiresAt: number | null;
}

/**
 * Stored preferences
 */
export interface StoredPreferences {
  /** Suppressed rule IDs */
  suppressedRules: Record<string, SuppressionEntry>;
  /** Applied preset history (for analytics) */
  presetHistory: Array<{
    preset: string;
    appliedAt: number;
    source: 'user' | 'recommendation';
  }>;
  /** Last recommendation dismissed */
  lastDismissedAt: number | null;
  /** User has seen onboarding for recommendations */
  seenOnboarding: boolean;
}

/**
 * Default preferences
 */
const DEFAULT_PREFERENCES: StoredPreferences = {
  suppressedRules: {},
  presetHistory: [],
  lastDismissedAt: null,
  seenOnboarding: false,
};

/**
 * Suppression durations
 */
const SUPPRESSION_DURATIONS: Record<SuppressionType, number | null> = {
  never: null,
  temporary: 24 * 60 * 60 * 1000, // 24 hours
  session: null, // Cleared on next session (handled separately)
};

/**
 * Preference Store callback for persistence
 */
export type PersistCallback = (preferences: StoredPreferences) => Promise<void>;

/**
 * Preference Store class
 */
export class PreferenceStore {
  private preferences: StoredPreferences;
  private persistCallback: PersistCallback | null = null;
  private sessionSuppressions: Set<string> = new Set();

  constructor(initialPreferences?: Partial<StoredPreferences>) {
    this.preferences = { ...DEFAULT_PREFERENCES, ...initialPreferences };
  }

  /**
   * Set the persistence callback
   * Called whenever preferences change
   */
  setPersistCallback(callback: PersistCallback | null): void {
    this.persistCallback = callback;
  }

  /**
   * Load preferences from external source
   */
  load(preferences: Partial<StoredPreferences>): void {
    this.preferences = { ...DEFAULT_PREFERENCES, ...preferences };
    // Clean up expired suppressions on load
    this.cleanupExpiredSuppressions();
  }

  /**
   * Get all preferences (for serialization)
   */
  getPreferences(): StoredPreferences {
    return { ...this.preferences };
  }

  /**
   * Check if a rule is suppressed
   */
  isRuleSuppressed(ruleId: string): boolean {
    // Check session suppressions first
    if (this.sessionSuppressions.has(ruleId)) {
      return true;
    }

    const entry = this.preferences.suppressedRules[ruleId];
    if (!entry) {
      return false;
    }

    // Check if temporary suppression has expired
    if (entry.type === 'temporary' && entry.expiresAt !== null) {
      if (Date.now() > entry.expiresAt) {
        // Expired - remove and return false
        delete this.preferences.suppressedRules[ruleId];
        this.persist();
        return false;
      }
    }

    return true;
  }

  /**
   * Suppress a rule
   */
  suppressRule(ruleId: string, type: SuppressionType): void {
    if (type === 'session') {
      // Session suppressions are not persisted
      this.sessionSuppressions.add(ruleId);
      return;
    }

    const duration = SUPPRESSION_DURATIONS[type];
    const expiresAt = duration !== null ? Date.now() + duration : null;

    this.preferences.suppressedRules[ruleId] = {
      timestamp: Date.now(),
      type,
      expiresAt,
    };

    this.persist();
  }

  /**
   * Unsuppress a rule
   */
  unsuppressRule(ruleId: string): void {
    this.sessionSuppressions.delete(ruleId);
    delete this.preferences.suppressedRules[ruleId];
    this.persist();
  }

  /**
   * Get all suppressed rules
   */
  getSuppressedRules(): string[] {
    this.cleanupExpiredSuppressions();
    return [
      ...Object.keys(this.preferences.suppressedRules),
      ...this.sessionSuppressions,
    ];
  }

  /**
   * Record a preset application
   */
  recordPresetApplication(
    preset: string,
    source: 'user' | 'recommendation'
  ): void {
    this.preferences.presetHistory.push({
      preset,
      appliedAt: Date.now(),
      source,
    });

    // Keep only last 50 entries
    if (this.preferences.presetHistory.length > 50) {
      this.preferences.presetHistory = this.preferences.presetHistory.slice(-50);
    }

    this.persist();
  }

  /**
   * Get preset history
   */
  getPresetHistory(): StoredPreferences['presetHistory'] {
    return [...this.preferences.presetHistory];
  }

  /**
   * Record recommendation dismissal
   */
  recordDismissal(): void {
    this.preferences.lastDismissedAt = Date.now();
    this.persist();
  }

  /**
   * Check if onboarding has been seen
   */
  hasSeenOnboarding(): boolean {
    return this.preferences.seenOnboarding;
  }

  /**
   * Mark onboarding as seen
   */
  markOnboardingSeen(): void {
    this.preferences.seenOnboarding = true;
    this.persist();
  }

  /**
   * Clear all suppressions
   */
  clearSuppressions(): void {
    this.preferences.suppressedRules = {};
    this.sessionSuppressions.clear();
    this.persist();
  }

  /**
   * Clear all preferences (reset to defaults)
   */
  reset(): void {
    this.preferences = { ...DEFAULT_PREFERENCES };
    this.sessionSuppressions.clear();
    this.persist();
  }

  /**
   * Get a formatted summary for debugging
   */
  getSummary(): string {
    const suppressed = this.getSuppressedRules();
    const recentPresets = this.preferences.presetHistory.slice(-5);

    return [
      '[Preference Store]',
      `  Suppressed Rules: ${suppressed.length}`,
      suppressed.length > 0 ? `    ${suppressed.join(', ')}` : '',
      `  Onboarding Seen: ${this.preferences.seenOnboarding ? 'yes' : 'no'}`,
      `  Last Dismissed: ${this.preferences.lastDismissedAt ? new Date(this.preferences.lastDismissedAt).toISOString() : 'never'}`,
      '',
      '  Recent Presets:',
      ...recentPresets.map(
        (p) =>
          `    ${p.preset} (${p.source}) at ${new Date(p.appliedAt).toISOString()}`
      ),
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private cleanupExpiredSuppressions(): void {
    const now = Date.now();
    let changed = false;

    for (const [ruleId, entry] of Object.entries(
      this.preferences.suppressedRules
    )) {
      if (entry.type === 'temporary' && entry.expiresAt !== null) {
        if (now > entry.expiresAt) {
          delete this.preferences.suppressedRules[ruleId];
          changed = true;
        }
      }
    }

    if (changed) {
      this.persist();
    }
  }

  private async persist(): Promise<void> {
    if (this.persistCallback) {
      try {
        await this.persistCallback(this.preferences);
      } catch (e) {
        console.error('[PreferenceStore] Persist error:', e);
      }
    }
  }
}

// ==========================================================================
// Singleton Instance
// ==========================================================================

let instance: PreferenceStore | null = null;

/**
 * Get the shared preference store instance
 */
export function getPreferenceStore(): PreferenceStore {
  if (!instance) {
    instance = new PreferenceStore();
  }
  return instance;
}

/**
 * Initialize the preference store with saved data
 */
export function initializePreferenceStore(
  preferences: Partial<StoredPreferences>
): void {
  const store = getPreferenceStore();
  store.load(preferences);
}

/**
 * Reset the singleton (for testing)
 */
export function resetPreferenceStore(): void {
  instance = null;
}

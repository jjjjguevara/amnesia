/**
 * Performance Settings Manager
 *
 * Manages PDF tile renderer performance settings with hot-reload capability.
 * Provides a subscriber pattern for components to react to settings changes
 * without requiring a restart.
 *
 * Features:
 * - Preset-based configuration (Balanced, Performance, Memory Saver, Quality)
 * - Hot-reload: Changes apply immediately without restart
 * - Subscriber pattern for reactive updates
 * - Automatic switch to 'custom' when individual settings are modified
 *
 * @example
 * ```typescript
 * const manager = getPerformanceSettingsManager();
 *
 * // Subscribe to changes
 * const unsubscribe = manager.subscribe((settings) => {
 *   console.log('Settings changed:', settings);
 *   // Apply new settings to component
 * });
 *
 * // Apply a preset
 * manager.applyPreset('performance');
 *
 * // Modify individual setting (auto-switches to 'custom')
 * manager.updateSetting('l1CacheSizeMB', 75);
 *
 * // Cleanup
 * unsubscribe();
 * ```
 */

import {
  type PdfPerformancePreset,
  type PdfTilePerformanceSettings,
  PDF_PERFORMANCE_PRESETS,
} from '../../../settings/settings';
import { getTelemetry } from './pdf-telemetry';

/**
 * Resolved performance settings with computed values
 */
export interface ResolvedPerformanceSettings extends PdfTilePerformanceSettings {
  /** Current preset name */
  preset: PdfPerformancePreset;
  /** Computed worker count (resolves 'auto' to actual number) */
  resolvedWorkerCount: number;
  /** L1 cache size in bytes */
  l1CacheSizeBytes: number;
  /** L2 cache size in bytes */
  l2CacheSizeBytes: number;
}

/**
 * Settings change event
 */
export interface SettingsChangeEvent {
  /** Previous settings */
  previous: ResolvedPerformanceSettings;
  /** New settings */
  current: ResolvedPerformanceSettings;
  /** Which fields changed */
  changedFields: (keyof PdfTilePerformanceSettings)[];
  /** Source of the change */
  source: 'preset' | 'individual' | 'external';
}

/**
 * Listener callback type
 */
export type SettingsListener = (
  settings: ResolvedPerformanceSettings,
  event?: SettingsChangeEvent
) => void;

/**
 * Performance Settings Manager
 *
 * Central manager for PDF tile renderer performance settings.
 * Implements subscriber pattern for hot-reload capability.
 */
export class PerformanceSettingsManager {
  private currentPreset: PdfPerformancePreset = 'balanced';
  private currentSettings: PdfTilePerformanceSettings;
  private listeners: Set<SettingsListener> = new Set();
  private cpuCores: number;

  constructor(initialPreset?: PdfPerformancePreset, initialSettings?: PdfTilePerformanceSettings) {
    // Detect CPU cores for auto worker count
    this.cpuCores = navigator.hardwareConcurrency || 4;

    // Initialize with preset or defaults
    this.currentPreset = initialPreset ?? 'balanced';
    this.currentSettings = initialSettings ?? { ...PDF_PERFORMANCE_PRESETS.balanced };
  }

  /**
   * Get current resolved settings
   */
  getSettings(): ResolvedPerformanceSettings {
    return this.resolveSettings();
  }

  /**
   * Get current preset name
   */
  getPreset(): PdfPerformancePreset {
    return this.currentPreset;
  }

  /**
   * Apply a preset configuration
   *
   * @param preset Preset to apply
   */
  applyPreset(preset: Exclude<PdfPerformancePreset, 'custom'>): void {
    const previous = this.resolveSettings();
    const presetSettings = PDF_PERFORMANCE_PRESETS[preset];

    this.currentPreset = preset;
    this.currentSettings = { ...presetSettings };

    const current = this.resolveSettings();
    const changedFields = this.getChangedFields(previous, current);

    this.notifyListeners(current, {
      previous,
      current,
      changedFields,
      source: 'preset',
    });

    // Track telemetry - record that a preset was applied (count)
    getTelemetry().trackCustomMetric(`performancePreset_${preset}`, 1);
  }

  /**
   * Update an individual setting
   *
   * Automatically switches to 'custom' preset if currently on a standard preset.
   *
   * @param key Setting key to update
   * @param value New value
   */
  updateSetting<K extends keyof PdfTilePerformanceSettings>(
    key: K,
    value: PdfTilePerformanceSettings[K]
  ): void {
    const previous = this.resolveSettings();

    // Switch to custom if on a standard preset
    if (this.currentPreset !== 'custom') {
      this.currentPreset = 'custom';
    }

    this.currentSettings[key] = value;

    const current = this.resolveSettings();

    this.notifyListeners(current, {
      previous,
      current,
      changedFields: [key],
      source: 'individual',
    });

    // Track telemetry - record that a setting was changed (count)
    getTelemetry().trackCustomMetric(`performanceSetting_${key}`, 1);
  }

  /**
   * Update multiple settings at once
   *
   * @param updates Partial settings to update
   */
  updateSettings(updates: Partial<PdfTilePerformanceSettings>): void {
    const previous = this.resolveSettings();

    // Switch to custom if on a standard preset
    if (this.currentPreset !== 'custom') {
      this.currentPreset = 'custom';
    }

    this.currentSettings = { ...this.currentSettings, ...updates };

    const current = this.resolveSettings();
    const changedFields = Object.keys(updates) as (keyof PdfTilePerformanceSettings)[];

    this.notifyListeners(current, {
      previous,
      current,
      changedFields,
      source: 'individual',
    });
  }

  /**
   * Load settings from external source (e.g., plugin settings)
   *
   * @param preset Preset name
   * @param settings Settings values
   */
  loadFromExternal(preset: PdfPerformancePreset, settings: PdfTilePerformanceSettings): void {
    const previous = this.resolveSettings();

    this.currentPreset = preset;
    this.currentSettings = { ...settings };

    const current = this.resolveSettings();
    const changedFields = this.getChangedFields(previous, current);

    if (changedFields.length > 0) {
      this.notifyListeners(current, {
        previous,
        current,
        changedFields,
        source: 'external',
      });
    }
  }

  /**
   * Subscribe to settings changes
   *
   * @param listener Callback to invoke on changes
   * @returns Unsubscribe function
   * @throws If listener throws during initial invocation
   */
  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);

    // Immediately invoke with current settings
    try {
      listener(this.resolveSettings());
    } catch (e) {
      // Remove listener on initialization failure to prevent memory leak
      this.listeners.delete(listener);
      console.error('[PerformanceSettings] Listener error on subscribe:', e);
      throw e; // Propagate error to caller
    }

    return () => this.listeners.delete(listener);
  }

  /**
   * Check if a preset is currently active (not custom)
   */
  isPresetActive(): boolean {
    return this.currentPreset !== 'custom';
  }


  /**
   * Get fields that require a plugin restart to take effect
   *
   * These settings cannot be hot-reloaded because they require
   * reinitializing WASM workers or other non-restartable resources.
   */
  getRestartRequiredFields(): (keyof PdfTilePerformanceSettings)[] {
    // Worker count cannot be changed at runtime because workers are
    // initialized once with WASM state and in-flight renders would be lost
    return ['workerCount'];
  }

  /**
   * Check if any of the changed fields require a restart
   *
   * @param changedFields Fields that were modified
   * @returns True if any field requires restart
   */
  isRestartRequired(changedFields: (keyof PdfTilePerformanceSettings)[]): boolean {
    const restartFields = this.getRestartRequiredFields();
    return changedFields.some((f) => restartFields.includes(f));
  }

  /**
   * Get the raw settings (for serialization)
   */
  getRawSettings(): { preset: PdfPerformancePreset; settings: PdfTilePerformanceSettings } {
    return {
      preset: this.currentPreset,
      settings: { ...this.currentSettings },
    };
  }

  /**
   * Get available presets
   */
  getAvailablePresets(): PdfPerformancePreset[] {
    return ['balanced', 'performance', 'memory-saver', 'quality', 'custom'];
  }

  /**
   * Get preset configuration by name
   */
  getPresetConfig(preset: Exclude<PdfPerformancePreset, 'custom'>): PdfTilePerformanceSettings {
    return { ...PDF_PERFORMANCE_PRESETS[preset] };
  }

  /**
   * Resolve settings with computed values
   */
  private resolveSettings(): ResolvedPerformanceSettings {
    const settings = this.currentSettings;

    // Resolve auto worker count
    let resolvedWorkerCount = settings.workerCount;
    if (settings.workerCount === 0) {
      // Auto: use CPU cores - 1 (leave one for main thread), capped at 4
      resolvedWorkerCount = Math.min(4, Math.max(1, this.cpuCores - 1));
    }

    return {
      ...settings,
      preset: this.currentPreset,
      resolvedWorkerCount,
      l1CacheSizeBytes: settings.l1CacheSizeMB * 1024 * 1024,
      l2CacheSizeBytes: settings.l2CacheSizeMB * 1024 * 1024,
    };
  }

  /**
   * Get fields that changed between two settings objects
   */
  private getChangedFields(
    prev: ResolvedPerformanceSettings,
    curr: ResolvedPerformanceSettings
  ): (keyof PdfTilePerformanceSettings)[] {
    const fields: (keyof PdfTilePerformanceSettings)[] = [
      'l1CacheSizeMB',
      'l2CacheSizeMB',
      'workerCount',
      'scrollDebounceMsOverride',
      'zoomDebounceMs',
      'prefetchViewports',
      'maxTileScale',
      'fastScrollQuality',
      'enableProgressiveZoom',
      'enableHybridRendering',
    ];

    return fields.filter((key) => prev[key] !== curr[key]);
  }

  /**
   * Notify all listeners of settings changes
   */
  private notifyListeners(settings: ResolvedPerformanceSettings, event: SettingsChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(settings, event);
      } catch (e) {
        console.error('[PerformanceSettings] Listener error:', e);
      }
    }
  }

  /**
   * Get a formatted summary for debugging
   */
  getSummary(): string {
    const settings = this.resolveSettings();
    return [
      `[Performance Settings]`,
      `  Preset: ${settings.preset}`,
      `  L1 Cache: ${settings.l1CacheSizeMB}MB`,
      `  L2 Cache: ${settings.l2CacheSizeMB}MB`,
      `  Workers: ${settings.workerCount === 0 ? 'auto' : settings.workerCount} (resolved: ${settings.resolvedWorkerCount})`,
      `  Scroll Debounce: ${settings.scrollDebounceMsOverride}ms`,
      `  Zoom Debounce: ${settings.zoomDebounceMs}ms`,
      `  Prefetch Viewports: ${settings.prefetchViewports}`,
      `  Max Tile Scale: ${settings.maxTileScale}`,
      `  Fast Scroll Quality: ${(settings.fastScrollQuality * 100).toFixed(0)}%`,
      `  Progressive Zoom: ${settings.enableProgressiveZoom ? 'enabled' : 'disabled'}`,
      `  Hybrid Rendering: ${settings.enableHybridRendering ? 'enabled' : 'disabled'}`,
    ].join('\n');
  }
}

// ==========================================================================
// Singleton Instance
// ==========================================================================

let instance: PerformanceSettingsManager | null = null;

/**
 * Get the shared performance settings manager instance
 */
export function getPerformanceSettingsManager(): PerformanceSettingsManager {
  if (!instance) {
    instance = new PerformanceSettingsManager();
  }
  return instance;
}

/**
 * Initialize the manager with plugin settings
 *
 * Call this during plugin initialization to sync with saved settings.
 */
export function initializePerformanceSettings(
  preset: PdfPerformancePreset,
  settings: PdfTilePerformanceSettings
): void {
  const manager = getPerformanceSettingsManager();
  manager.loadFromExternal(preset, settings);
}

/**
 * Reset the singleton (for testing)
 */
export function resetPerformanceSettingsManager(): void {
  instance = null;
}

/**
 * Doc Doctor Detection Utilities
 *
 * Utilities for detecting if Doc Doctor is available and has HUD support.
 */

import type { App } from 'obsidian';

/**
 * Check if Doc Doctor plugin is available with HUD support
 */
export function isDocDoctorAvailable(app: App): boolean {
  try {
    const plugins = (app as any).plugins;
    if (!plugins) return false;

    const docDoctor = plugins.plugins?.['doc-doctor'];
    if (!docDoctor) return false;

    // Check if Doc Doctor has HUD registry (check both property names for compatibility)
    const registry = docDoctor.hudRegistry || docDoctor.hudProviderRegistry;
    return Boolean(
      registry &&
      typeof registry.register === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * Get the Doc Doctor HUD registry if available
 */
export function getDocDoctorRegistry(app: App): any | null {
  try {
    const docDoctor = (app as any).plugins?.plugins?.['doc-doctor'];
    // Check both property names for compatibility
    const registry = docDoctor?.hudRegistry || docDoctor?.hudProviderRegistry;
    if (!registry) return null;
    return registry;
  } catch {
    return null;
  }
}

/**
 * Check if Doc Doctor is currently enabled
 */
export function isDocDoctorEnabled(app: App): boolean {
  try {
    const plugins = (app as any).plugins;
    if (!plugins) return false;
    return Boolean(plugins.enabledPlugins?.has('doc-doctor'));
  } catch {
    return false;
  }
}

/**
 * Subscribe to Doc Doctor HUD ready event.
 * This event is emitted when Doc Doctor's HUD system is initialized or reloaded.
 * Returns an unsubscribe function.
 */
export function onDocDoctorHUDReady(callback: (registry: any) => void): () => void {
  const handler = (event: CustomEvent) => {
    const registry = event.detail?.registry;
    if (registry) {
      callback(registry);
    }
  };

  window.addEventListener('doc-doctor:hud-ready', handler as EventListener);

  return () => {
    window.removeEventListener('doc-doctor:hud-ready', handler as EventListener);
  };
}

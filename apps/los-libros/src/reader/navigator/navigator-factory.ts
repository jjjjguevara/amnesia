/**
 * Navigator Factory
 *
 * Creates the appropriate navigator instance based on display mode.
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

import type { Navigator, NavigatorConfig } from './navigator-interface';
import { PaginatedNavigator } from './paginated-navigator';
import { ScrolledNavigator } from './scrolled-navigator';

/**
 * Default navigator configuration
 */
export const DEFAULT_NAVIGATOR_CONFIG: NavigatorConfig = {
  mode: 'paginated',
  columns: 'auto',
  fontSize: 16,
  fontFamily: 'Georgia, serif',
  lineHeight: 1.6,
  textAlign: 'justify',
  margin: 40,
  columnGap: 60,
  theme: {
    background: '#ffffff',
    foreground: '#1a1a1a',
    linkColor: '#0066cc',
    highlightColor: 'rgba(255, 255, 0, 0.3)',
  },
  pageSnap: true,
  momentumScrolling: true,
  scrollSpeed: 1.0,
};

/**
 * Create a navigator instance for the specified mode
 *
 * @param mode - Display mode ('paginated' or 'scrolled')
 * @returns Navigator instance
 */
export function createNavigator(mode: 'paginated' | 'scrolled' = 'paginated'): Navigator {
  switch (mode) {
    case 'paginated':
      return new PaginatedNavigator();

    case 'scrolled':
      return new ScrolledNavigator();

    default:
      throw new Error(`Unknown navigator mode: ${mode}`);
  }
}

/**
 * Check if a mode switch requires creating a new navigator
 * Some configuration changes can be handled by the existing navigator
 */
export function requiresNewNavigator(
  currentMode: 'paginated' | 'scrolled',
  newMode: 'paginated' | 'scrolled'
): boolean {
  return currentMode !== newMode;
}

/**
 * Get default configuration for a specific mode
 */
export function getDefaultConfigForMode(mode: 'paginated' | 'scrolled'): NavigatorConfig {
  const config = { ...DEFAULT_NAVIGATOR_CONFIG };
  config.mode = mode;

  if (mode === 'scrolled') {
    // Scrolled mode specific defaults
    config.columns = 'single';
    config.pageSnap = false;
  }

  return config;
}

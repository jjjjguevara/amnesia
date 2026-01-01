/**
 * Navigator Module
 *
 * Exports for the dual navigator system.
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

// Types and interfaces
export type {
  Navigator,
  NavigatorConfig,
  NavigatorEvents,
  NavigatorEventListener,
  NavigationTarget,
  NavigationOptions,
  Locator,
  PaginationInfo,
  SpineItemContent,
} from './navigator-interface';

// Helper functions
export {
  createLocator,
  locatorsEqual,
  mergeLocator,
} from './navigator-interface';

// Factory
export {
  createNavigator,
  requiresNewNavigator,
  getDefaultConfigForMode,
  DEFAULT_NAVIGATOR_CONFIG,
} from './navigator-factory';

// Navigator implementations
export { PaginatedNavigator } from './paginated-navigator';
export { ScrolledNavigator } from './scrolled-navigator';

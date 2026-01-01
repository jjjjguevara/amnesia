/**
 * EPUB Renderer V2
 *
 * New Shadow DOM-based renderer architecture.
 * This module exports all components of the V2 architecture for easy integration.
 *
 * Key improvements over V1 (iframe-based):
 * - No RAF throttling
 * - Events bubble naturally
 * - ~15MB memory savings
 * - Zero sub-pixel drift
 * - CSS isolation via Shadow DOM
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

// Shadow DOM View
export { ShadowDOMView, isShadowDOMSupported, isCSSHighlightSupported } from '../shadow-dom-view';

// Shadow DOM Renderer
export { ShadowDOMRenderer } from '../shadow-dom-renderer';

// Navigator System
export {
  // Types
  type Navigator,
  type NavigatorConfig,
  type NavigatorEvents,
  type NavigatorEventListener,
  type NavigationTarget,
  type NavigationOptions,
  type Locator,
  type PaginationInfo,
  type SpineItemContent,

  // Helper functions
  createLocator,
  locatorsEqual,
  mergeLocator,

  // Factory
  createNavigator,
  requiresNewNavigator,
  getDefaultConfigForMode,
  DEFAULT_NAVIGATOR_CONFIG,

  // Implementations
  PaginatedNavigator,
  ScrolledNavigator,
} from '../navigator';

// Locator System
export {
  // Locator service
  rangeToLocator,
  viewportToLocator,
  anchorToDOM,
  anchorLocators,
  reanchorLocators,
  type AnchorResult,

  // Fuzzy anchor
  fuzzyAnchor,
  fuzzyAnchorBatch,
  levenshteinDistance,
  similarity,
  type FuzzyMatchResult,
  type TextSelector,
} from '../locator';

// Adapter for backward compatibility
export {
  RendererAdapter,
  createRenderer,
  isShadowDOMRenderer,
  USE_SHADOW_DOM_RENDERER,
} from '../renderer-adapter';

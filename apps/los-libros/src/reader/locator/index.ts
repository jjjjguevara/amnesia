/**
 * Locator Module
 *
 * Exports for the locator system.
 *
 * @see docs/plans/epub-renderer-v2-architecture.md
 */

// Locator service
export {
  rangeToLocator,
  viewportToLocator,
  anchorToDOM,
  anchorLocators,
  reanchorLocators,
  type AnchorResult,
} from './locator-service';

// Fuzzy anchor
export {
  fuzzyAnchor,
  fuzzyAnchorBatch,
  levenshteinDistance,
  similarity,
  type FuzzyMatchResult,
  type TextSelector,
} from './fuzzy-anchor';

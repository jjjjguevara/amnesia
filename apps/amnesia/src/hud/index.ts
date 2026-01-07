/**
 * Amnesia HUD - Public Exports
 *
 * Heads-Up Display for quick access to reading stats, progress tracking,
 * and library insights from the Obsidian status bar.
 */

// Types
export * from './types';

// State
export { createHUDStore, hudReducer, HUDActions } from './state/hud-store';

// Provider
export { AmnesiaHUDProvider } from './providers/AmnesiaHUDProvider';

// Context Detection
export {
  ContextDetector,
  createContextDetector,
  type HUDContext,
  type BookContext,
  type HighlightContext,
  type AuthorContext,
  type SeriesContext,
  type NoContext,
  type ContextType,
  type ContextChangeEvent,
} from './context/context-detector';

// Integration
export { AmnesiaHUD } from './integration/standalone';
export { isDocDoctorAvailable, getDocDoctorRegistry, isDocDoctorEnabled, onDocDoctorHUDReady } from './integration/detection';

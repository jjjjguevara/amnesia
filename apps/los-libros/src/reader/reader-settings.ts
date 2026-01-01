/**
 * Reader Settings
 *
 * Comprehensive settings for the EPUB reader including display,
 * typography, navigation, and gesture configuration.
 */

/**
 * Theme presets for the reader
 * Colors are customizable via CSS variables
 */
export type ThemePreset =
  | 'system'  // Inherit from Obsidian's current theme
  | 'light'   // White background, dark text
  | 'dark'    // Dark background, light text
  | 'sepia'   // Warm paper tone
  | 'night'   // Pure black, amber text (OLED friendly)
  | 'paper'   // Off-white, high contrast
  | 'forest'; // Green-tinted, easy on eyes

/**
 * Page turn animation styles
 */
export type PageAnimation = 'none' | 'slide' | 'curl';

/**
 * Reading direction
 */
export type ReadingDirection = 'ltr' | 'rtl' | 'auto';

/**
 * Text alignment options
 */
export type TextAlignment = 'left' | 'justify' | 'right' | 'center';

/**
 * Scale/fit mode
 */
export type ScaleMode = 'page-fit' | 'width-fill';

/**
 * Column layout
 */
export type ColumnLayout = 'single' | 'dual' | 'auto';

/**
 * Tap zone actions
 */
export type TapZoneAction =
  | 'prev-page'
  | 'next-page'
  | 'toggle-ui'
  | 'bookmark'
  | 'show-toolbar'
  | 'show-progress'
  | 'none';

/**
 * Tap zone configuration
 */
export interface TapZoneConfig {
  left: TapZoneAction;
  right: TapZoneAction;
  center: TapZoneAction;
  top: TapZoneAction;
  bottom: TapZoneAction;
}

/**
 * Custom theme definition
 */
export interface CustomTheme {
  name: string;
  background: string;
  text: string;
  link?: string;
  selection?: string;
}

/**
 * Margin configuration
 */
export interface MarginConfig {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Auto-scroll settings
 */
export interface AutoScrollConfig {
  enabled: boolean;
  /** Speed 1-10 (words per minute equivalent) */
  speed: number;
}

/**
 * Highlighting behavior settings
 */
export interface HighlightConfig {
  /** Instant highlighting: create highlight on selection with last used color */
  instantHighlight: boolean;
  /** Show popup on selecting existing highlight */
  showPopupOnExisting: boolean;
  /** Last used highlight color */
  lastUsedColor: string;
  /** Last used highlight type */
  lastUsedType: 'highlight' | 'underline';
  /** Auto-copy highlighted text to clipboard */
  autoCopyToClipboard: boolean;
  /** Confirm before deleting highlights */
  confirmDelete: boolean;
}

/**
 * Full reader settings interface
 */
export interface ReaderSettings {
  // Display
  /** Brightness level 0-100 */
  brightness: number;
  /** Active theme preset */
  theme: ThemePreset;
  /** Optional custom theme (overrides preset) */
  customTheme?: CustomTheme;
  /** User-saved custom themes */
  savedThemes: CustomTheme[];

  // Layout
  /** Paginated or scrolled reading mode */
  flow: 'paginated' | 'scrolled';
  /** Page turn animation */
  pageAnimation: PageAnimation;
  /** Page scaling mode */
  scale: ScaleMode;
  /** Preserve zoom level between pages */
  preserveZoom: boolean;
  /** Column layout */
  columns: ColumnLayout;
  /** Two-page spreads (book view) */
  spreads: boolean;

  // Typography
  /** Font size in pixels */
  fontSize: number;
  /** Font family */
  fontFamily: string;
  /** Line height multiplier */
  lineHeight: number;
  /** Text alignment */
  textAlign: TextAlignment;
  /** Page margins in pixels */
  margins: MarginConfig;
  /** Letter spacing (-2 to 10) */
  letterSpacing: number;
  /** Word spacing (-2 to 10) */
  wordSpacing: number;

  // Reading
  /** Text direction */
  direction: ReadingDirection;
  /** Auto-scroll configuration */
  autoScroll: AutoScrollConfig;

  // Navigation
  /** Tap zone configuration */
  tapZones: TapZoneConfig;

  // Gestures
  /** Long press duration in ms */
  longPressDuration: number;
  /** Enable haptic feedback */
  hapticFeedback: boolean;
  /** Enable instant highlight mode on long press */
  instantHighlightMode: boolean;
  /** Default highlight color for instant mode */
  defaultHighlightColor: string;

  // Highlighting
  /** Highlighting behavior configuration */
  highlighting: HighlightConfig;

  // UI
  /** Show page numbers */
  showPageNumbers: boolean;
  /** Show chapter title in toolbar */
  showChapterTitle: boolean;
  /** Show reading progress percentage */
  showProgress: boolean;
  /** Auto-hide toolbar after inactivity (ms, 0 = never) */
  toolbarAutoHide: number;
}

/**
 * Default reader settings
 */
export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  // Display
  brightness: 100,
  theme: 'system',
  customTheme: undefined,
  savedThemes: [],

  // Layout
  flow: 'paginated',
  pageAnimation: 'slide',
  scale: 'page-fit',
  preserveZoom: false,
  columns: 'auto',
  spreads: true,

  // Typography
  fontSize: 18,
  fontFamily: 'serif',
  lineHeight: 1.5,
  textAlign: 'justify',
  margins: { top: 40, bottom: 40, left: 40, right: 40 },
  letterSpacing: 0,
  wordSpacing: 0,

  // Reading
  direction: 'auto',
  autoScroll: { enabled: false, speed: 5 },

  // Navigation
  tapZones: {
    left: 'prev-page',
    right: 'next-page',
    center: 'toggle-ui',
    top: 'show-toolbar',
    bottom: 'show-progress',
  },

  // Gestures
  longPressDuration: 500,
  hapticFeedback: true,
  instantHighlightMode: true,
  defaultHighlightColor: 'yellow',

  // Highlighting
  highlighting: {
    instantHighlight: false,
    showPopupOnExisting: true,
    lastUsedColor: 'yellow',
    lastUsedType: 'highlight',
    autoCopyToClipboard: false,
    confirmDelete: true,
  },

  // UI
  showPageNumbers: true,
  showChapterTitle: true,
  showProgress: true,
  toolbarAutoHide: 3000,
};

/**
 * Theme color definitions (CSS variable names)
 */
export const THEME_CSS_VARS: Record<ThemePreset, { bg: string; text: string }> = {
  system: {
    bg: '--background-primary',
    text: '--text-normal',
  },
  light: {
    bg: '--los-libros-reader-bg-light',
    text: '--los-libros-reader-text-light',
  },
  dark: {
    bg: '--los-libros-reader-bg-dark',
    text: '--los-libros-reader-text-dark',
  },
  sepia: {
    bg: '--los-libros-reader-bg-sepia',
    text: '--los-libros-reader-text-sepia',
  },
  night: {
    bg: '--los-libros-reader-bg-night',
    text: '--los-libros-reader-text-night',
  },
  paper: {
    bg: '--los-libros-reader-bg-paper',
    text: '--los-libros-reader-text-paper',
  },
  forest: {
    bg: '--los-libros-reader-bg-forest',
    text: '--los-libros-reader-text-forest',
  },
};

/**
 * Default theme colors (fallbacks if CSS vars not set)
 */
export const DEFAULT_THEME_COLORS: Record<ThemePreset, { bg: string; text: string }> = {
  system: { bg: '#ffffff', text: '#333333' }, // Will be overridden by getObsidianThemeColors()
  light: { bg: '#ffffff', text: '#333333' },
  dark: { bg: '#1e1e1e', text: '#e0e0e0' },
  sepia: { bg: '#f4ecd8', text: '#5b4636' },
  night: { bg: '#000000', text: '#ffcc66' },
  paper: { bg: '#f5f5f0', text: '#1a1a1a' },
  forest: { bg: '#1a2e1a', text: '#a8d8a8' },
};

/**
 * Check if Obsidian is currently in dark mode
 */
export function isObsidianDarkMode(): boolean {
  if (typeof document === 'undefined') return false;
  return document.body.classList.contains('theme-dark');
}

/**
 * Get theme colors from Obsidian's current theme
 * Reads CSS variables directly from Obsidian's styles
 */
export function getObsidianThemeColors(): { bg: string; text: string; link: string; selection: string } {
  if (typeof document === 'undefined') {
    return { bg: '#ffffff', text: '#333333', link: '#0066cc', selection: 'rgba(0, 102, 204, 0.3)' };
  }

  const style = getComputedStyle(document.body);

  // Read Obsidian's CSS variables
  const bg = style.getPropertyValue('--background-primary').trim() || '#ffffff';
  const text = style.getPropertyValue('--text-normal').trim() || '#333333';
  const link = style.getPropertyValue('--text-accent').trim() || '#0066cc';
  const selection = style.getPropertyValue('--text-selection').trim() || 'rgba(0, 102, 204, 0.3)';

  return { bg, text, link, selection };
}

/**
 * Base font families (always available)
 */
export const BASE_FONT_FAMILIES: { value: string; label: string }[] = [
  { value: 'serif', label: 'Serif (Default)' },
  { value: 'sans-serif', label: 'Sans Serif' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Palatino, serif', label: 'Palatino' },
  { value: '"Times New Roman", serif', label: 'Times New Roman' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: 'Helvetica, sans-serif', label: 'Helvetica' },
  { value: '"Open Sans", sans-serif', label: 'Open Sans' },
  { value: 'monospace', label: 'Monospace' },
  { value: '"OpenDyslexic", sans-serif', label: 'OpenDyslexic' },
];

/**
 * Get font families including Obsidian's configured fonts
 */
export function getFontFamilies(): { value: string; label: string }[] {
  const fonts = [...BASE_FONT_FAMILIES];

  if (typeof document === 'undefined') {
    return fonts;
  }

  const style = getComputedStyle(document.body);

  // Try to get Obsidian's configured text font
  const obsidianTextFont = style.getPropertyValue('--font-text').trim();
  if (obsidianTextFont && obsidianTextFont !== 'inherit') {
    // Extract the first font from the font stack
    const firstFont = obsidianTextFont.split(',')[0].trim().replace(/['"]/g, '');
    if (firstFont && !fonts.some(f => f.label === `${firstFont} (Obsidian)`)) {
      fonts.unshift({
        value: obsidianTextFont,
        label: `${firstFont} (Obsidian)`,
      });
    }
  }

  // Try to get Obsidian's configured monospace font
  const obsidianMonoFont = style.getPropertyValue('--font-monospace').trim();
  if (obsidianMonoFont && obsidianMonoFont !== 'inherit' && obsidianMonoFont !== 'monospace') {
    const firstFont = obsidianMonoFont.split(',')[0].trim().replace(/['"]/g, '');
    if (firstFont && !fonts.some(f => f.value === obsidianMonoFont)) {
      // Insert after monospace entry
      const monoIndex = fonts.findIndex(f => f.value === 'monospace');
      fonts.splice(monoIndex + 1, 0, {
        value: obsidianMonoFont,
        label: `${firstFont} (Obsidian Mono)`,
      });
    }
  }

  // Try to get any custom interface font
  const interfaceFont = style.getPropertyValue('--font-interface').trim();
  if (interfaceFont && interfaceFont !== 'inherit' && interfaceFont !== obsidianTextFont) {
    const firstFont = interfaceFont.split(',')[0].trim().replace(/['"]/g, '');
    if (firstFont && !fonts.some(f => f.label.includes(firstFont))) {
      fonts.splice(1, 0, {
        value: interfaceFont,
        label: `${firstFont} (Interface)`,
      });
    }
  }

  return fonts;
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use getFontFamilies() instead
 */
export const FONT_FAMILIES = BASE_FONT_FAMILIES;

/**
 * Get theme colors from CSS variables with fallback
 */
export function getThemeColors(theme: ThemePreset): { bg: string; text: string } {
  if (typeof document === 'undefined') {
    return DEFAULT_THEME_COLORS[theme];
  }

  const root = document.documentElement;
  const style = getComputedStyle(root);
  const vars = THEME_CSS_VARS[theme];

  const bg = style.getPropertyValue(vars.bg).trim() || DEFAULT_THEME_COLORS[theme].bg;
  const text = style.getPropertyValue(vars.text).trim() || DEFAULT_THEME_COLORS[theme].text;

  return { bg, text };
}

/**
 * Merge partial settings with defaults
 */
export function mergeReaderSettings(
  partial: Partial<ReaderSettings>
): ReaderSettings {
  return {
    ...DEFAULT_READER_SETTINGS,
    ...partial,
    margins: { ...DEFAULT_READER_SETTINGS.margins, ...partial.margins },
    autoScroll: { ...DEFAULT_READER_SETTINGS.autoScroll, ...partial.autoScroll },
    tapZones: { ...DEFAULT_READER_SETTINGS.tapZones, ...partial.tapZones },
    highlighting: { ...DEFAULT_READER_SETTINGS.highlighting, ...partial.highlighting },
  };
}

/**
 * Validate and clamp settings values
 */
export function validateReaderSettings(settings: ReaderSettings): ReaderSettings {
  return {
    ...settings,
    brightness: Math.max(0, Math.min(100, settings.brightness)),
    fontSize: Math.max(10, Math.min(40, settings.fontSize)),
    lineHeight: Math.max(1.0, Math.min(3.0, settings.lineHeight)),
    letterSpacing: Math.max(-2, Math.min(10, settings.letterSpacing)),
    wordSpacing: Math.max(-2, Math.min(10, settings.wordSpacing)),
    longPressDuration: Math.max(200, Math.min(1500, settings.longPressDuration)),
    toolbarAutoHide: Math.max(0, Math.min(30000, settings.toolbarAutoHide)),
    autoScroll: {
      ...settings.autoScroll,
      speed: Math.max(1, Math.min(10, settings.autoScroll.speed)),
    },
    margins: {
      top: Math.max(0, Math.min(100, settings.margins.top)),
      bottom: Math.max(0, Math.min(100, settings.margins.bottom)),
      left: Math.max(0, Math.min(100, settings.margins.left)),
      right: Math.max(0, Math.min(100, settings.margins.right)),
    },
  };
}

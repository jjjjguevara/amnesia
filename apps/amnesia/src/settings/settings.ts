/**
 * Amnesia plugin settings
 */
import { DEFAULT_BOOK_NOTE_TEMPLATE, DEFAULT_HIGHLIGHT_NOTE_TEMPLATE, DEFAULT_TEMPLATE_SETTINGS } from '../templates/default-templates';
import type { SyncDirection, ConflictResolution, SyncableField } from '../calibre/calibre-types';
import type { TemplateSettings } from '../templates/template-types';
import type { BookSettingsRecord } from '../reader/book-settings-store';
import type { TabName } from '../hud/types';

// ==========================================================================
// File System Architecture Settings Types
// ==========================================================================

/**
 * Advanced cache configuration for tiered caching (L1 memory + L2 IndexedDB)
 */
export interface AdvancedCacheSettings {
  /** L1 (memory) cache max size in bytes. Default: 50MB */
  l1MaxSizeBytes: number;
  /** L1 max entries. Default: 500 */
  l1MaxEntries: number;
  /** Enable L2 (IndexedDB) persistent cache. Default: true */
  l2Enabled: boolean;
  /** L2 cache max size in bytes. Default: 500MB */
  l2MaxSizeBytes: number;
  /** L2 max entries. Default: 5000 */
  l2MaxEntries: number;
  /** Promote L2 entries to L1 on access. Default: true */
  promoteOnAccess: boolean;
  /** Write through to L2 on L1 writes. Default: true */
  writeThrough: boolean;
}

/**
 * Offline mode settings for downloading books for offline reading
 */
export interface OfflineSettings {
  /** Enable offline mode. Default: false */
  enabled: boolean;
  /** Max concurrent downloads. Default: 3 */
  concurrentDownloads: number;
  /** Number of retry attempts for failed downloads. Default: 3 */
  retryCount: number;
  /** Delay between retries in ms. Default: 1000 */
  retryDelay: number;
  /** Storage quota warning threshold (0-1). Default: 0.9 */
  quotaWarningThreshold: number;
}

/**
 * Network monitoring settings
 */
export interface NetworkSettings {
  /** Enable network monitoring. Default: true */
  enabled: boolean;
  /** Health check interval in ms. Default: 30000 */
  checkInterval: number;
  /** Health check timeout in ms. Default: 5000 */
  checkTimeout: number;
  /** Failed checks before marking offline. Default: 3 */
  failureThreshold: number;
}

/**
 * Deduplication settings for content-based storage optimization
 */
export interface DeduplicationSettings {
  /** Enable content deduplication. Default: false */
  enabled: boolean;
  /** Hash algorithm for content fingerprinting. Default: 'SHA-256' */
  algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512';
  /** Minimum file size for deduplication in bytes. Default: 1024 */
  minSize: number;
}

/**
 * Custom OPDS feed configuration
 */
export interface OPDSFeedConfig {
  /** Unique feed ID */
  id: string;
  /** Display name */
  name: string;
  /** Root feed URL */
  url: string;
  /** Is feed enabled */
  enabled: boolean;
  /** Requires authentication */
  requiresAuth: boolean;
  /** Username for auth (if required) */
  username?: string;
  /** Password for auth (if required) */
  password?: string;
}

/**
 * OPDS integration settings
 */
export interface OPDSSettings {
  /** Custom OPDS feed sources */
  customFeeds: OPDSFeedConfig[];
  /** Enable feed caching. Default: true */
  cacheFeeds: boolean;
  /** Feed cache duration in ms. Default: 3600000 (1 hour) */
  cacheDuration: number;
  /** Request timeout in ms. Default: 10000 */
  timeout: number;
}

/**
 * Asset extraction and export settings
 */
export interface AssetSettings {
  /** Generate thumbnails for images. Default: true */
  generateThumbnails: boolean;
  /** Max thumbnail dimension in pixels. Default: 200 */
  thumbnailMaxSize: number;
  /** Vault folder for exported assets. Default: 'Assets/Books' */
  exportFolder: string;
}

// ==========================================================================
// Field Alias System Types
// ==========================================================================

/**
 * Field alias configuration for mapping multiple frontmatter keys to a single Calibre field
 */
export interface FieldAlias {
  /** The canonical Calibre field name (e.g., 'title', 'authors', 'rating') */
  canonicalField: string;
  /** Alternative frontmatter keys that map to this field */
  aliases: string[];
  /** Primary key to use when writing to frontmatter (default: first alias) */
  primaryObsidianKey?: string;
}

/**
 * Per-book template settings for custom note structures
 */
export interface PerBookTemplateSettings {
  /** Enable per-book template overrides via frontmatter flag */
  enabled: boolean;
  /** Frontmatter key that marks a note as using custom template */
  frontmatterFlag: string;
  /** Whether to respect existing note structure when syncing */
  respectStructure: boolean;
}

/**
 * Inline mode settings for embedding highlights/notes in book notes
 */
export interface InlineModeSettings {
  /** Enable inline highlights (embed in book note instead of separate files) */
  inlineHighlights: boolean;
  /** Enable inline notes (embed in book note instead of separate files) */
  inlineNotes: boolean;
  /** Section ID for inline highlights */
  highlightsSectionId: string;
  /** Section ID for inline notes */
  notesSectionId: string;
}

// ==========================================================================
// Reader ↔ Vault Sync Settings Types
// ==========================================================================

/**
 * Sync mode for Reader ↔ Vault synchronization
 */
export type ReaderVaultSyncMode =
  | 'bidirectional'      // Changes sync both directions
  | 'reader-to-vault'    // Reader changes → vault only
  | 'vault-to-reader'    // Vault changes → reader only
  | 'manual';            // User triggers sync explicitly

/**
 * Conflict resolution strategy for Reader ↔ Vault sync
 */
export type ReaderVaultConflictStrategy =
  | 'reader-wins'        // Always prefer reader version
  | 'vault-wins'         // Always prefer vault version
  | 'last-write-wins'    // Prefer most recently modified
  | 'ask-user';          // Show modal for each conflict

/**
 * Reader ↔ Vault sync settings
 */
export interface ReaderVaultSyncSettings {
  /** Enable Reader ↔ Vault sync */
  enabled: boolean;
  /** Sync mode for highlights */
  highlightSyncMode: ReaderVaultSyncMode;
  /** Sync mode for notes/annotations */
  noteSyncMode: ReaderVaultSyncMode;
  /** Default conflict resolution strategy */
  conflictStrategy: ReaderVaultConflictStrategy;
  /** Append-only vault: deletions in reader don't delete vault notes */
  appendOnlyVault: boolean;
  /** Preserve reader highlights: deletions in vault don't delete reader highlights */
  preserveReaderHighlights: boolean;
  /** Debounce delay for vault changes (ms) */
  debounceDelay: number;
  /** Auto-sync on highlight create/update/delete */
  autoSync: boolean;
  /** Auto-regenerate hub files when highlights change */
  autoRegenerateHub: boolean;
  /** Debounce delay for hub regeneration (ms) - to batch multiple rapid changes */
  hubRegenerateDelay: number;
}

// ==========================================================================
// Unified Sync Architecture Settings Types
// ==========================================================================

/**
 * Conflict resolution strategy for unified sync
 */
export type UnifiedConflictStrategy =
  | 'last-write-wins'
  | 'prefer-local'
  | 'prefer-remote'
  | 'merge'
  | 'ask-user';

/**
 * Default sync mode
 */
export type UnifiedSyncMode = 'incremental' | 'full' | 'custom';

/**
 * Unified sync architecture settings
 */
export interface UnifiedSyncSettings {
  /** Enable unified sync engine. Default: false */
  enabled: boolean;

  /** Default sync mode. Default: 'incremental' */
  defaultMode: UnifiedSyncMode;

  /** Default conflict resolution strategy. Default: 'last-write-wins' */
  defaultConflictStrategy: UnifiedConflictStrategy;

  /** Maximum concurrent operations. Default: 5 */
  concurrency: number;

  /** Checkpoint interval (items processed before saving). Default: 100 */
  checkpointInterval: number;

  /** Enable cross-session resume. Default: true */
  enableResume: boolean;

  /** Rate limit: max requests per second. Default: 10 */
  rateLimit: number;

  /** Show resume notification on startup. Default: true */
  showResumeNotification: boolean;

  /** Enabled adapters. Default: all */
  enabledAdapters: {
    calibre: boolean;
    server: boolean;
    file: boolean;
  };

  /** Parallel cover downloads. Default: true */
  parallelCoverDownloads: boolean;

  /** Cover download concurrency. Default: 5 */
  coverDownloadConcurrency: number;

  /** Batch note generation. Default: true */
  batchNoteGeneration: boolean;

  /** Note generation batch size. Default: 50 */
  noteGenerationBatchSize: number;
}

// ==========================================================================
// HUD Settings Types
// ==========================================================================

/**
 * Status bar metric options for HUD
 */
export type HudStatusBarMetric = 'reading-count' | 'highlight-count' | 'today-highlights' | 'streak';

/**
 * HUD settings for the Heads-Up Display
 */
export interface HudSettings {
  /** Enable HUD. Default: true */
  enabled: boolean;
  /** Default tab when opening HUD. Default: 'reading' */
  defaultTab: TabName;
  /** Status bar metrics to display. Default: ['reading-count', 'highlight-count'] */
  statusBarMetrics: HudStatusBarMetric[];
  /** Show server status in status bar. Default: true */
  showServerStatus: boolean;
  /** Tab visibility configuration */
  tabVisibility: {
    reading: boolean;
    library: boolean;
    stats: boolean;
    server: boolean;
    series: boolean;
  };
  /** Compact view width in pixels. Default: 400 */
  compactViewWidth: number;
  /** Auto-close HUD after inactivity (ms, 0 = never). Default: 0 */
  autoCloseDelay: number;
  /** Remember last open tab. Default: true */
  rememberLastTab: boolean;
  /** Show badges on tabs. Default: true */
  showBadges: boolean;
  /** Use Doc Doctor integration when available. Default: true */
  useDocDoctorIntegration: boolean;
}

// ==========================================================================
// Server Management Settings Types
// ==========================================================================

/**
 * Server management settings for bundled amnesia-server
 */
export interface ServerManagementSettings {
  /** Port for the server to listen on. Default: 3000 */
  port: number;
  /** Auto-start server when plugin loads. Default: true */
  autoStart: boolean;
  /** Maximum restart attempts before giving up. Default: 3 */
  maxRestartAttempts: number;
  /** Delay between restart attempts in ms. Default: 2000 */
  restartDelay: number;
  /** Health check interval in ms. Default: 30000 */
  healthCheckInterval: number;
  /** Health check timeout in ms. Default: 5000 */
  healthCheckTimeout: number;
  /** Show notices for server events. Default: true */
  showNotices: boolean;
  /** Use external server instead of bundled. Default: false */
  useExternalServer: boolean;
  /** External server URL (when useExternalServer is true) */
  externalServerUrl: string;
}

// ==========================================================================
// PDF Renderer Settings Types
// ==========================================================================

/**
 * PDF rendering mode preference
 * Note: 'pdfjs' has been deprecated. All modes now use server-based rendering.
 */
export type PdfProviderMode = 'auto' | 'server';

/**
 * PDF page layout options
 */
export type PdfPageLayout = 'single' | 'dual' | 'book';

/**
 * OCR provider options for scanned PDFs
 */
export type PdfOcrProvider = 'tesseract' | 'ollama';

/**
 * PDF reading mode themes (like Google Scholar PDF Reader)
 * - device: Match Obsidian's theme
 * - light: White background
 * - sepia: Warm yellowish tint (easy on eyes)
 * - dark: Inverted colors for dark mode
 * - night: Dark with warm tint (reduced blue light)
 */
export type PdfReadingMode = 'device' | 'light' | 'sepia' | 'dark' | 'night';

/**
 * PDF display mode:
 * - paginated: Fit multiple pages in view, no pan, keyboard navigation
 * - horizontal-scroll: Single row, fixed height, horizontal pan only
 * - vertical-scroll: Single column, fixed width, vertical pan only
 * - auto-grid: Dynamic columns based on zoom, always fits viewport width (default)
 * - canvas: Free pan/zoom, fixed columns (8-12)
 */
export type PdfDisplayMode = 'paginated' | 'horizontal-scroll' | 'vertical-scroll' | 'auto-grid' | 'canvas';

/**
 * PDF scroll direction for scrolled mode (legacy, use displayMode instead)
 * @deprecated Use displayMode: 'horizontal-scroll' or 'vertical-scroll' instead
 */
export type PdfScrollDirection = 'vertical' | 'horizontal';

/**
 * PDF render DPI options for server-side rendering
 */
export type PdfRenderDpi = 72 | 96 | 150 | 200 | 300;

/**
 * PDF image output format
 */
export type PdfImageFormat = 'png' | 'jpeg' | 'webp';

/**
 * PDF performance preset names
 */
export type PdfPerformancePreset = 'balanced' | 'performance' | 'memory-saver' | 'quality' | 'custom';

/**
 * PDF tile rendering performance settings
 * These settings control the WASM-based tile renderer performance characteristics.
 * Used by performance presets and can be individually customized.
 */
export interface PdfTilePerformanceSettings {
  /** L1 (memory) cache max size in MB. Default: 50 */
  l1CacheSizeMB: number;
  /** L2 (IndexedDB) cache max size in MB. Default: 200 */
  l2CacheSizeMB: number;
  /** Number of WASM workers (0 = auto based on CPU cores). Default: 0 */
  workerCount: number;
  /** Scroll render debounce in ms. Lower = more responsive. Default: 32 */
  scrollDebounceMsOverride: number;
  /** Zoom render debounce in ms. Lower = faster zoom response. Default: 150 */
  zoomDebounceMs: number;
  /** Number of viewports to prefetch during scroll (1-4). Default: 2 */
  prefetchViewports: number;
  /** Maximum tile scale for high-zoom rendering. Default: 32 */
  maxTileScale: number;
  /** Quality reduction during fast scroll (0.0-1.0). Default: 0.5 */
  fastScrollQuality: number;
  /** Enable progressive multi-resolution zoom. Default: true */
  enableProgressiveZoom: boolean;
  /** Enable hybrid rendering (full-page at low zoom, tiles at high zoom). Default: true */
  enableHybridRendering: boolean;
}

/**
 * Default tile performance settings for each preset
 */
export const PDF_PERFORMANCE_PRESETS: Record<Exclude<PdfPerformancePreset, 'custom'>, PdfTilePerformanceSettings> = {
  balanced: {
    l1CacheSizeMB: 50,
    l2CacheSizeMB: 200,
    workerCount: 0, // auto
    scrollDebounceMsOverride: 32,
    zoomDebounceMs: 150,
    prefetchViewports: 2,
    maxTileScale: 32,
    fastScrollQuality: 0.5,
    enableProgressiveZoom: true,
    enableHybridRendering: true,
  },
  performance: {
    l1CacheSizeMB: 100,
    l2CacheSizeMB: 300,
    workerCount: 4,
    scrollDebounceMsOverride: 16,
    zoomDebounceMs: 50,
    prefetchViewports: 3,
    maxTileScale: 32,
    fastScrollQuality: 0.75,
    enableProgressiveZoom: true,
    enableHybridRendering: true,
  },
  'memory-saver': {
    l1CacheSizeMB: 30,
    l2CacheSizeMB: 100,
    workerCount: 1,
    scrollDebounceMsOverride: 64,
    zoomDebounceMs: 250,
    prefetchViewports: 1,
    maxTileScale: 16,
    fastScrollQuality: 0.5,
    enableProgressiveZoom: false,
    enableHybridRendering: true,
  },
  quality: {
    l1CacheSizeMB: 80,
    l2CacheSizeMB: 250,
    workerCount: 0, // auto
    scrollDebounceMsOverride: 50,
    zoomDebounceMs: 200,
    prefetchViewports: 2,
    maxTileScale: 32,
    fastScrollQuality: 0.9,
    enableProgressiveZoom: true,
    enableHybridRendering: true,
  },
};

/**
 * PDF renderer settings
 */
export interface PdfSettings {
  /** Default zoom scale (1.0 = 100%). Default: 1.5 */
  scale: number;
  /** Page rotation in degrees. Default: 0 */
  rotation: 0 | 90 | 180 | 270;
  /** Preferred rendering mode. Default: 'auto' */
  preferMode: PdfProviderMode;
  /** Page layout mode. Default: 'single' */
  pageLayout: PdfPageLayout;
  /** Display mode for viewing PDFs. Default: 'auto-grid' */
  displayMode: PdfDisplayMode;
  /** @deprecated Scroll direction for scrolled mode. Use displayMode instead. */
  scrollDirection: PdfScrollDirection;
  /** Enable OCR for scanned PDFs. Default: false */
  enableOcr: boolean;
  /** OCR provider to use. Default: 'tesseract' */
  ocrProvider: PdfOcrProvider;
  /** Show text layer for selection. Default: true */
  showTextLayer: boolean;
  /** Enable region selection for OCR. Default: true */
  enableRegionSelection: boolean;
  /** Reading mode theme. Default: 'device' */
  readingMode: PdfReadingMode;

  // ==========================================================================
  // PDF Optimization Settings
  // ==========================================================================

  /** Render DPI for server-side rendering. Higher = sharper but slower. Default: 150 */
  renderDpi: PdfRenderDpi;
  /** Number of pages to preload ahead of current page. Default: 2 */
  pagePreloadCount: number;
  /** Enable rendered page caching. Default: true */
  enablePageCache: boolean;
  /** Maximum number of pages to keep in cache. Default: 10 */
  pageCacheSize: number;
  /** Image format for rendered pages. Default: 'png' */
  imageFormat: PdfImageFormat;
  /** Image quality for lossy formats (jpeg/webp). 1-100. Default: 85 */
  imageQuality: number;
  /** Enable text layer anti-aliasing. Default: true */
  enableTextAntialiasing: boolean;
  /** Enable image smoothing/interpolation. Default: true */
  enableImageSmoothing: boolean;

  // ==========================================================================
  // Performance Settings
  // ==========================================================================

  /** Enable batch page requests for faster loading. Default: true */
  enableBatchRequests: boolean;
  /** Maximum pages per batch request. Default: 5 */
  batchSize: number;
  /** Memory budget for page cache in MB. Default: 200 */
  memoryBudgetMB: number;

  // ==========================================================================
  // Advanced Performance Settings
  // ==========================================================================

  /** Text layer rendering mode. Default: 'virtualized' */
  textLayerMode: 'full' | 'virtualized' | 'disabled';
  /** Prefetch strategy for loading adjacent pages. Default: 'adaptive' */
  prefetchStrategy: 'none' | 'fixed' | 'adaptive';
  /** Enable DOM element pooling for page recycling. Default: true */
  enableDomPooling: boolean;
  /** Use IntersectionObserver for visibility detection. Default: true */
  useIntersectionObserver: boolean;

  // ==========================================================================
  // Virtualization Performance Settings
  // ==========================================================================

  /** Render debounce delay in milliseconds. Lower = more responsive, higher = less server load. Default: 150 */
  renderDebounceMs: number;
  /** Minimum creation buffer in pixels. Pages are created when this close to viewport. Default: 150 */
  minCreationBuffer: number;
  /** Minimum destruction buffer in pixels. Pages are kept alive when this far from viewport. Default: 300 */
  minDestructionBuffer: number;

  // ==========================================================================
  // Tile Rendering Settings (CATiledLayer-style optimization)
  // ==========================================================================

  /** Enable tiled rendering for large documents. Default: true */
  enableTiledRendering: boolean;
  /** Tile size in pixels (256 = finer granularity, 512 = fewer tiles). Default: 256 */
  tileSize: 256 | 512;
  /** Number of viewports to prefetch ahead during scroll (1-4). Default: 2 */
  scrollPrefetchViewports: number;
  /** Fast scroll velocity threshold for switching to low-res tiles (px/s). Default: 500 */
  fastScrollThreshold: number;

  // ==========================================================================
  // Performance Presets (WASM Tile Renderer)
  // ==========================================================================

  /** Selected performance preset. Default: 'balanced' */
  performancePreset: PdfPerformancePreset;
  /** Custom tile performance settings (used when preset is 'custom'). */
  tilePerformance: PdfTilePerformanceSettings;
}

// ==========================================================================
// Doc Doctor Integration Settings Types
// ==========================================================================

/**
 * Conflict resolution strategy for Doc Doctor sync
 */
export type DocDoctorConflictStrategy =
  | 'amnesia-wins'    // Amnesia highlight data takes priority
  | 'dd-wins'         // Doc Doctor stub data takes priority
  | 'newest-wins'     // Most recently modified wins
  | 'manual';         // Ask user for each conflict

/**
 * Doc Doctor integration settings
 */
export interface DocDoctorSyncSettings {
  /** Enable Doc Doctor integration. Default: true */
  enabled: boolean;
  /** Auto-sync highlights to Doc Doctor stubs. Default: false */
  autoSyncHighlights: boolean;
  /** Sync on highlight creation. Default: true */
  syncOnCreate: boolean;
  /** Propagate stub resolutions to highlight annotations. Default: true */
  propagateResolutions: boolean;
  /** Default conflict resolution strategy. Default: 'newest-wins' */
  conflictStrategy: DocDoctorConflictStrategy;
}

export interface LibrosSettings {
  // Server connection
  serverUrl: string;
  serverEnabled: boolean;

  // Local library
  localBooksFolder: string;

  // Reading preferences
  defaultFontSize: number;
  defaultTheme: 'system' | 'light' | 'dark' | 'sepia';
  paginated: boolean;

  // Sync settings
  syncProgress: boolean;
  syncHighlights: boolean;
  syncInterval: number; // in minutes, 0 = manual only

  // Highlight settings
  highlightFolder: string;
  highlightTemplate: string;
  atomicHighlights: boolean; // Each highlight as separate file

  // Book note settings
  bookNoteFolder: string;
  bookNoteTemplate: string;
  autoCreateBookNotes: boolean;

  // Cache settings
  maxCachedBooks: number;
  maxCacheSize: number; // in MB

  // ==========================================================================
  // Calibre Integration
  // ==========================================================================

  // Connection
  calibreEnabled: boolean;
  calibreLibraryPath: string;              // e.g., /Users/.../Libros
  calibreContentServerUrl: string;         // e.g., http://localhost:8080
  calibreContentServerEnabled: boolean;
  calibreContentServerUsername: string;    // Optional authentication
  calibreContentServerPassword: string;

  // Sync
  calibreSyncDirection: SyncDirection;
  calibreConflictResolution: ConflictResolution;
  calibreSyncableFields: SyncableField[];

  // Folders (vault paths for generated notes)
  calibreBookNotesFolder: string;          // Florilegios
  calibreAuthorIndexFolder: string;        // Autores
  calibreSeriesIndexFolder: string;        // Series
  calibreShelfIndexFolder: string;         // Estanterias
  calibreHighlightsFolder: string;         // Subrayados
  calibreBaseFilesFolder: string;          // Indices
  calibreCoversFolder: string;             // Attachments/covers

  // ==========================================================================
  // Template Settings
  // ==========================================================================
  templates: TemplateSettings;
  templatesFolder: string;                 // Vault folder for custom templates

  // ==========================================================================
  // Note Generation Settings
  // ==========================================================================
  notesFolder: string;                     // Where book notes are created
  noteUpdateMode: 'never' | 'frontmatter' | 'full';  // How to update existing notes

  // Frontmatter Mapping (for metadata sync)
  frontmatterMapping: {
    author?: string;
    series?: string;
    bookshelves?: string;
    rating?: string;
    progress?: string;
  };

  // Wikilink formatting
  wikilinkAuthors: boolean;
  wikilinkSeries: boolean;
  wikilinkBookshelves: boolean;

  // ==========================================================================
  // Per-Book Settings Storage
  // ==========================================================================
  perBookSettings: Record<string, BookSettingsRecord>;

  // ==========================================================================
  // File System Architecture Settings
  // ==========================================================================

  /** Advanced tiered cache configuration */
  advancedCache: AdvancedCacheSettings;

  /** Offline mode and download settings */
  offline: OfflineSettings;

  /** Network monitoring configuration */
  network: NetworkSettings;

  /** Content deduplication settings */
  deduplication: DeduplicationSettings;

  /** OPDS feed integration settings */
  opds: OPDSSettings;

  /** Asset extraction and export settings */
  assets: AssetSettings;

  // ==========================================================================
  // Unified Sync Architecture Settings
  // ==========================================================================

  /** Unified sync engine configuration */
  unifiedSync: UnifiedSyncSettings;

  // ==========================================================================
  // Field Alias & Template Override Settings
  // ==========================================================================

  /** Field alias mappings for frontmatter flexibility */
  fieldAliases: FieldAlias[];

  /** Per-book template override settings */
  perBookTemplates: PerBookTemplateSettings;

  /** Inline mode settings for embedding in book notes */
  inlineMode: InlineModeSettings;

  /** Reader ↔ Vault sync settings */
  readerVaultSync: ReaderVaultSyncSettings;

  // ==========================================================================
  // PDF Renderer Settings
  // ==========================================================================

  /** PDF rendering configuration */
  pdf: PdfSettings;

  // ==========================================================================
  // Server Management Settings
  // ==========================================================================

  /** Server management configuration */
  serverManagement: ServerManagementSettings;

  // ==========================================================================
  // HUD Settings
  // ==========================================================================

  /** HUD configuration */
  hud: HudSettings;

  // ==========================================================================
  // Doc Doctor Integration Settings
  // ==========================================================================

  /** Doc Doctor sync configuration */
  docDoctorSync: DocDoctorSyncSettings;
}

export const DEFAULT_SETTINGS: LibrosSettings = {
  // Server connection
  serverUrl: '',
  serverEnabled: false,

  // Local library
  localBooksFolder: 'Books',

  // Reading preferences
  defaultFontSize: 16,
  defaultTheme: 'system',
  paginated: true,

  // Sync settings
  syncProgress: true,
  syncHighlights: true,
  syncInterval: 0,

  // Highlight settings
  highlightFolder: 'Highlights',
  highlightTemplate: DEFAULT_HIGHLIGHT_NOTE_TEMPLATE,
  atomicHighlights: true,

  // Book note settings
  bookNoteFolder: 'Books',
  bookNoteTemplate: DEFAULT_BOOK_NOTE_TEMPLATE,
  autoCreateBookNotes: true,

  // Cache settings
  maxCachedBooks: 10,
  maxCacheSize: 200,

  // Calibre Integration
  calibreEnabled: false,
  calibreLibraryPath: '',
  calibreContentServerUrl: 'http://localhost:8080',
  calibreContentServerEnabled: false,
  calibreContentServerUsername: '',
  calibreContentServerPassword: '',

  // Sync
  calibreSyncDirection: 'bidirectional',
  calibreConflictResolution: 'last-write',
  calibreSyncableFields: ['status', 'rating', 'tags', 'progress'],

  // Folders (vault paths for generated notes)
  calibreBookNotesFolder: 'Library/Books',
  calibreAuthorIndexFolder: 'Library/Authors',
  calibreSeriesIndexFolder: 'Library/Series',
  calibreShelfIndexFolder: 'Library/Shelves',
  calibreHighlightsFolder: 'Library/Highlights',
  calibreBaseFilesFolder: 'Library/Indices',
  calibreCoversFolder: 'Attachments/covers',

  // Template Settings
  templates: DEFAULT_TEMPLATE_SETTINGS,
  templatesFolder: 'Templates/Amnesia',

  // Note Generation Settings
  notesFolder: 'Books',
  noteUpdateMode: 'frontmatter',
  frontmatterMapping: {
    author: 'author',
    series: 'series',
    bookshelves: 'bookshelves',
    rating: 'rating',
    progress: 'progress',
  },
  wikilinkAuthors: true,
  wikilinkSeries: true,
  wikilinkBookshelves: true,

  // Per-Book Settings Storage
  perBookSettings: {},

  // ==========================================================================
  // File System Architecture Settings Defaults
  // ==========================================================================

  // Advanced Cache
  advancedCache: {
    l1MaxSizeBytes: 50 * 1024 * 1024,    // 50MB
    l1MaxEntries: 500,
    l2Enabled: true,
    l2MaxSizeBytes: 500 * 1024 * 1024,   // 500MB
    l2MaxEntries: 5000,
    promoteOnAccess: true,
    writeThrough: true,
  },

  // Offline Mode
  offline: {
    enabled: false,
    concurrentDownloads: 3,
    retryCount: 3,
    retryDelay: 1000,
    quotaWarningThreshold: 0.9,
  },

  // Network Monitoring
  network: {
    enabled: true,
    checkInterval: 30000,    // 30 seconds
    checkTimeout: 5000,      // 5 seconds
    failureThreshold: 3,
  },

  // Deduplication
  deduplication: {
    enabled: false,
    algorithm: 'SHA-256',
    minSize: 1024,           // 1KB minimum
  },

  // OPDS Feeds
  opds: {
    customFeeds: [],
    cacheFeeds: true,
    cacheDuration: 3600000,  // 1 hour
    timeout: 10000,          // 10 seconds
  },

  // Asset Settings
  assets: {
    generateThumbnails: true,
    thumbnailMaxSize: 200,
    exportFolder: 'Assets/Books',
  },

  // ==========================================================================
  // Unified Sync Architecture Settings Defaults
  // ==========================================================================

  unifiedSync: {
    enabled: false,
    defaultMode: 'incremental',
    defaultConflictStrategy: 'last-write-wins',
    concurrency: 5,
    checkpointInterval: 100,
    enableResume: true,
    rateLimit: 10,
    showResumeNotification: true,
    enabledAdapters: {
      calibre: true,
      server: true,
      file: true,
    },
    parallelCoverDownloads: true,
    coverDownloadConcurrency: 5,
    batchNoteGeneration: true,
    noteGenerationBatchSize: 50,
  },

  // ==========================================================================
  // Field Alias & Template Override Settings Defaults
  // ==========================================================================

  // Field Aliases
  fieldAliases: [
    { canonicalField: 'title', aliases: ['title', 'título', 'book_name', 'book'] },
    { canonicalField: 'authors', aliases: ['authors', 'author', 'creator', 'escritor'] },
    { canonicalField: 'tags', aliases: ['tags', 'keywords', 'keyterms', 'bookshelves'] },
    { canonicalField: 'rating', aliases: ['rating', 'stars', 'score', 'valoración'] },
    { canonicalField: 'series', aliases: ['series', 'serie', 'saga'] },
    { canonicalField: 'publisher', aliases: ['publisher', 'editorial'] },
    { canonicalField: 'progress', aliases: ['progress', 'percent', 'reading_progress'] },
  ],

  // Per-Book Template Overrides
  perBookTemplates: {
    enabled: true,
    frontmatterFlag: 'customTemplate',
    respectStructure: true,
  },

  // Inline Mode
  inlineMode: {
    inlineHighlights: false,
    inlineNotes: false,
    highlightsSectionId: 'HIGHLIGHTS',
    notesSectionId: 'NOTES',
  },

  // Reader ↔ Vault Sync
  readerVaultSync: {
    enabled: false,
    highlightSyncMode: 'bidirectional',
    noteSyncMode: 'bidirectional',
    conflictStrategy: 'last-write-wins',
    appendOnlyVault: false,
    preserveReaderHighlights: false,
    debounceDelay: 2000,
    autoSync: true,
    autoRegenerateHub: false, // Off by default - can cause extra file writes
    hubRegenerateDelay: 5000, // 5 seconds to batch rapid highlight changes
  },

  // ==========================================================================
  // PDF Renderer Settings Defaults
  // ==========================================================================

  pdf: {
    scale: 1.5,              // 150% zoom for comfortable reading
    rotation: 0,             // No rotation
    preferMode: 'auto',      // Server-based rendering (PDF.js deprecated)
    pageLayout: 'single',    // Single page view
    displayMode: 'auto-grid', // auto-grid, paginated, horizontal-scroll, vertical-scroll, canvas
    scrollDirection: 'vertical', // @deprecated - use displayMode instead
    enableOcr: false,        // OCR disabled by default
    ocrProvider: 'tesseract', // Default OCR provider
    showTextLayer: true,     // Enable text selection
    enableRegionSelection: true, // Enable manual region selection for OCR
    readingMode: 'device',   // Follow system/device theme

    // PDF Optimization Settings
    renderDpi: 150,          // Good balance of quality and performance
    pagePreloadCount: 2,     // Preload 2 pages ahead
    enablePageCache: true,   // Cache rendered pages
    pageCacheSize: 10,       // Keep 10 pages in cache
    imageFormat: 'jpeg',     // JPEG: ~1-2MB vs PNG: ~25MB per page (10-20x smaller, faster decode)
    imageQuality: 90,        // High quality JPEG - visually indistinguishable from PNG
    enableTextAntialiasing: true,     // Smooth text edges
    enableImageSmoothing: true,       // Smooth image interpolation

    // Performance Settings
    enableBatchRequests: true,  // Batch page requests for faster loading
    batchSize: 5,               // Request 5 pages at a time
    memoryBudgetMB: 200,        // 200MB default memory budget for cache

    // Advanced Performance Settings
    textLayerMode: 'virtualized',     // Only render visible text spans
    prefetchStrategy: 'adaptive',     // Adaptive prefetching based on scroll behavior
    enableDomPooling: true,           // Recycle page DOM elements
    useIntersectionObserver: true,    // Use browser-native visibility detection

    // Virtualization Performance Settings
    renderDebounceMs: 50,             // Delay before rendering pages during scroll (ms) - lower = more responsive
    minCreationBuffer: 300,           // Minimum buffer for creating page elements (px) - ~1 page height
    minDestructionBuffer: 600,        // Minimum buffer for keeping page elements (px) - prevents flicker

    // Tile Rendering Settings (CATiledLayer-style optimization)
    enableTiledRendering: true,       // Enable tiled rendering for large documents
    tileSize: 256,                    // 256px tiles for finer granularity (matches Preview.app)
    scrollPrefetchViewports: 2,       // Prefetch 2 viewports ahead during scroll
    fastScrollThreshold: 500,         // Switch to low-res tiles when scrolling > 500px/s

    // Performance Presets (WASM Tile Renderer)
    performancePreset: 'balanced',    // Default to balanced preset
    tilePerformance: PDF_PERFORMANCE_PRESETS.balanced,  // Use balanced preset values
  },

  // ==========================================================================
  // Server Management Settings Defaults
  // ==========================================================================

  serverManagement: {
    port: 3000,                   // Default port
    autoStart: true,              // Auto-start when plugin loads
    maxRestartAttempts: 3,        // Max restart attempts
    restartDelay: 2000,           // 2 seconds between restarts
    healthCheckInterval: 30000,   // Check health every 30 seconds
    healthCheckTimeout: 5000,     // 5 second timeout for health checks
    showNotices: true,            // Show UI notices for server events
    useExternalServer: false,     // Use bundled server by default
    externalServerUrl: '',        // External server URL (when useExternalServer)
  },

  // ==========================================================================
  // HUD Settings Defaults
  // ==========================================================================

  hud: {
    enabled: true,                // HUD enabled by default
    defaultTab: 'reading',        // Start on Reading tab
    statusBarMetrics: ['reading-count', 'highlight-count'],
    showServerStatus: true,       // Show server status indicator
    tabVisibility: {
      reading: true,
      library: true,
      stats: true,
      server: true,
      series: true,
    },
    compactViewWidth: 400,        // 400px width
    autoCloseDelay: 0,            // Never auto-close
    rememberLastTab: true,        // Remember last open tab
    showBadges: true,             // Show badges on tabs
    useDocDoctorIntegration: true, // Use Doc Doctor when available
  },

  // ==========================================================================
  // Doc Doctor Integration Settings Defaults
  // ==========================================================================

  docDoctorSync: {
    enabled: true,                  // Enable Doc Doctor integration by default
    autoSyncHighlights: false,      // Don't auto-sync by default (user opt-in)
    syncOnCreate: true,             // Sync when highlight is created (if autoSync enabled)
    propagateResolutions: true,     // Update highlight when stub is resolved
    conflictStrategy: 'newest-wins', // Default conflict strategy
  },
};

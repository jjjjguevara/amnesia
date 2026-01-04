import { Plugin, WorkspaceLeaf, setIcon, Notice, TFile } from 'obsidian';
import type { SyncProgress } from './calibre/calibre-types';
import { AmnesiaSettingTab } from './settings/settings-tab/settings-tab';
import { LibrosSettings, DEFAULT_SETTINGS } from './settings/settings';
import { LibraryView, LIBRARY_VIEW_TYPE } from './library/library-view';
import { ReaderView, READER_VIEW_TYPE } from './reader/reader-view';
// REMOVED: Old HighlightsView - using in-reader NotebookSidebar instead
// import { HighlightsView, HIGHLIGHTS_VIEW_TYPE } from './highlights/highlights-view';
import { OPDSView, OPDS_VIEW_TYPE } from './opds/opds-view';
import { ImagesView, IMAGES_VIEW_TYPE } from './images/images-view';
import { BookSidebarView, BOOK_SIDEBAR_VIEW_TYPE } from './sidebar/sidebar-view';
import { CacheStatsView, CACHE_STATS_VIEW_TYPE } from './cache/cache-stats-view';
import { OfflineBooksView, OFFLINE_BOOKS_VIEW_TYPE } from './offline/offline-books-view';
import { sidebarStore } from './sidebar/sidebar.store';
import { Store } from './helpers/store';
import { libraryReducer, LibraryState, LibraryAction } from './library/library-reducer';
import { LibraryService } from './library/library-service';
import { NoteGenerator } from './templates/note-generator';
import { UnifiedNoteGenerator } from './templates/unified-note-generator';
import { HighlightService } from './highlights/highlight-service';
import { highlightReducer, HighlightState, HighlightAction, initialHighlightState } from './highlights/highlight-store';
import { BookmarkService } from './bookmarks/bookmark-service';
import { CalibreService } from './calibre/calibre-service';
import { BookNoteGenerator, HighlightGenerator, IndexGenerator } from './generators';
import { OPDSSyncService } from './opds/opds-sync';
import { Migrator, BackupService, LinkUpdater } from './migration';
import { RegenerateConfirmModal, addRegenerateModalStyles } from './modals/RegenerateConfirmModal';
import { BookSettingsStore, createBookSettingsStore } from './reader/book-settings-store';

// Public API
import { createAPI, type AmnesiaAPI, AmnesiaAPIImpl } from './api';

// File System Architecture Services
import { TieredCache, type TieredCacheConfig } from './cache/tiered-cache';
import { OfflineManager, type OfflineManagerConfig } from './offline/offline-manager';
import { NetworkMonitor, type NetworkMonitorConfig } from './offline/network-monitor';
import { DeduplicationManager, type DedupManagerConfig, InMemoryDedupStorage } from './dedup/deduplication-manager';
import { AssetExtractor } from './assets/asset-extractor';
import { OPDSFeedClient, type OPDSClientConfig } from './api/opds-feed-client';

// Unified Sync Architecture
import { UnifiedSyncEngine, type SyncConfig, type SyncProgress as UnifiedSyncProgress } from './sync';
import { CalibreBidirectionalSync, createCalibreBidirectionalSync } from './sync/metadata';

// Reader ↔ Vault Sync
import {
	ReaderVaultSyncOrchestrator,
	createReaderVaultSync,
	type ReaderVaultSyncSettings,
	DEFAULT_READER_VAULT_SYNC_SETTINGS,
} from './sync/reader-vault-sync';

export default class AmnesiaPlugin extends Plugin {
	settings: LibrosSettings;
	libraryStore: Store<LibraryState, LibraryAction>;
	highlightStore: Store<HighlightState, HighlightAction>;
	libraryService: LibraryService;
	highlightService: HighlightService;
	bookmarkService: BookmarkService;
	noteGenerator: NoteGenerator;
	unifiedNoteGenerator: UnifiedNoteGenerator;
	calibreService: CalibreService;

	// New Phase 5-7 services
	bookNoteGenerator: BookNoteGenerator;
	highlightGenerator: HighlightGenerator;
	indexGenerator: IndexGenerator;
	opdsSyncService: OPDSSyncService;
	migrator: Migrator;
	backupService: BackupService;
	linkUpdater: LinkUpdater;

	// Per-book settings
	bookSettingsStore: BookSettingsStore;

	// File System Architecture Services
	tieredCache: TieredCache | null = null;
	offlineManager: OfflineManager | null = null;
	networkMonitor: NetworkMonitor | null = null;
	deduplicationManager: DeduplicationManager | null = null;
	assetExtractor: AssetExtractor | null = null;
	opdsFeedClient: OPDSFeedClient | null = null;

	// Unified Sync Architecture
	syncEngine: UnifiedSyncEngine | null = null;
	private syncEngineUnsubscribes: (() => void)[] = [];

	// Calibre Bidirectional Metadata Sync
	calibreMetadataSync: CalibreBidirectionalSync | null = null;

	// Reader ↔ Vault Sync
	readerVaultSync: ReaderVaultSyncOrchestrator | null = null;
	private readerVaultSyncUnsubscribes: (() => void)[] = [];

	// Public API
	api: AmnesiaAPIImpl;

	private statusBarItem: HTMLElement | null = null;
	private calibreStoreUnsubscribe: (() => void) | null = null;
	private networkStatusUnsubscribe: (() => void) | null = null;
	private offlineProgressUnsubscribe: (() => void) | null = null;
	private networkStatusBarItem: HTMLElement | null = null;


	async onload() {
		console.log('Loading Amnesia plugin');

		// Load settings
		await this.loadSettings();

		// Initialize library store
		this.libraryStore = new Store<LibraryState, LibraryAction>(
			{ books: [], loading: false, error: null, selectedBookId: null },
			libraryReducer
		);

		// Initialize highlight store
		this.highlightStore = new Store<HighlightState, HighlightAction>(
			initialHighlightState,
			highlightReducer
		);

		// Initialize library service
		this.libraryService = new LibraryService(
			this.app,
			this.libraryStore,
			() => this.loadData(),
			(data) => this.saveData(data)
		);

		// Initialize note generator (legacy)
		this.noteGenerator = new NoteGenerator(this.app, {
			bookNotesFolder: this.settings.bookNoteFolder,
			highlightsFolder: this.settings.highlightFolder,
			bookNoteTemplate: this.settings.bookNoteTemplate,
			highlightNoteTemplate: this.settings.highlightTemplate,
		});

		// Initialize unified note generator (new template system)
		this.unifiedNoteGenerator = new UnifiedNoteGenerator(
			this.app,
			this.settings.templates
		);

		// Initialize Phase 5-7 services
		this.bookNoteGenerator = new BookNoteGenerator(
			this.app,
			this.settings.templates,
			() => this.settings.templates
		);

		this.highlightGenerator = new HighlightGenerator(
			this.app,
			this.settings.templates,
			() => this.settings.templates
		);

		this.indexGenerator = new IndexGenerator(
			this.app,
			this.settings.templates,
			() => this.settings.templates
		);

		this.opdsSyncService = new OPDSSyncService(this.app);

		this.migrator = new Migrator(this.app);
		this.backupService = new BackupService(this.app);
		this.linkUpdater = new LinkUpdater(this.app);

		// Initialize highlight service
		this.highlightService = new HighlightService(
			this.app,
			this.highlightStore,
			() => this.loadData(),
			(data) => this.saveData(data),
			this.noteGenerator
		);

		// Initialize bookmark service
		this.bookmarkService = new BookmarkService(
			this.app,
			() => this.loadData(),
			(data) => this.saveData(data)
		);

		// Initialize per-book settings store
		const savedData = await this.loadData();
		this.bookSettingsStore = createBookSettingsStore(
			savedData?.perBookSettings || null,
			async (data) => {
				const existing = await this.loadData() || {};
				await this.saveData({ ...existing, perBookSettings: data });
			}
		);

		// Initialize Calibre service
		this.calibreService = new CalibreService(
			this.app,
			() => this.settings
		);

		// Add status bar item for Calibre sync
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass('amnesia-status-bar');
		this.updateStatusBar();

		// Subscribe to Calibre store for status updates
		this.calibreStoreUnsubscribe = this.calibreService.getStore().subscribe(() => {
			this.updateStatusBar();
		});

		// Initialize Calibre Bidirectional Metadata Sync
		this.calibreMetadataSync = createCalibreBidirectionalSync(
			this.app,
			this.calibreService,
			undefined, // Use default schema mapping
		);
		// Set field aliases from settings
		this.calibreMetadataSync.setFieldAliases(this.settings.fieldAliases);

		// ==========================================================================
		// Initialize File System Architecture Services
		// ==========================================================================

		// 1. Network Monitor (foundation - others depend on network status)
		if (this.settings.network.enabled) {
			this.networkMonitor = new NetworkMonitor({
				serverUrl: this.settings.serverUrl || '/api/health',
				checkInterval: this.settings.network.checkInterval,
				checkTimeout: this.settings.network.checkTimeout,
				failureThreshold: this.settings.network.failureThreshold,
				autoCheck: true,
				latencyThresholds: {
					excellent: 50,
					good: 150,
					fair: 300,
					poor: 1000,
				},
			});

			// Add network status bar item
			this.networkStatusBarItem = this.addStatusBarItem();
			this.networkStatusBarItem.addClass('amnesia-network-status');

			// Subscribe to network state changes
			this.networkStatusUnsubscribe = this.networkMonitor.on('state-change', (data) => {
				this.updateNetworkStatusBar();
				if (data.state.status === 'offline') {
					new Notice('Network connection lost');
				} else if (data.previous.status === 'offline' && data.state.status === 'online') {
					new Notice('Network connection restored');
				}
			});
		}

		// 2. Tiered Cache (needs network monitor for offline detection)
		// Note: Will be fully initialized in onLayoutReady when library service is ready
		this.tieredCache = new TieredCache(
			// Remote provider - placeholder, will be configured properly in onLayoutReady
			{
				getResource: async (_bookId: string, _href: string) => new Uint8Array(0),
				getMimeType: (_bookId: string, _href: string) => 'application/octet-stream',
			},
			{
				l1: {
					maxSizeBytes: this.settings.advancedCache.l1MaxSizeBytes,
					maxEntries: this.settings.advancedCache.l1MaxEntries,
				},
				l2: {
					maxSizeBytes: this.settings.advancedCache.l2MaxSizeBytes,
					maxEntries: this.settings.advancedCache.l2MaxEntries,
				},
				enableL2: this.settings.advancedCache.l2Enabled,
				promoteOnAccess: this.settings.advancedCache.promoteOnAccess,
				writeThrough: this.settings.advancedCache.writeThrough,
			}
		);

		// 3. Offline Manager - deferred to onLayoutReady (needs IndexedDBStore)

		// 4. Deduplication Manager (if enabled)
		if (this.settings.deduplication.enabled) {
			const dedupStorage = new InMemoryDedupStorage();
			this.deduplicationManager = new DeduplicationManager(
				dedupStorage,
				{
					algorithm: this.settings.deduplication.algorithm,
					minSize: this.settings.deduplication.minSize,
					maxEntries: 10000,
					debug: false,
				}
			);
		}

		// 5. Asset Extractor (needs cache)
		// Note: Will be initialized with proper provider in onLayoutReady

		// 6. OPDS Feed Client
		this.opdsFeedClient = new OPDSFeedClient({
			timeout: this.settings.opds.timeout,
			enableCache: this.settings.opds.cacheFeeds,
			cacheTTL: this.settings.opds.cacheDuration,
			userAgent: 'Amnesia/1.0 OPDS-Client',
		});

		// Load custom OPDS feeds from settings
		for (const feed of this.settings.opds.customFeeds) {
			if (feed.enabled) {
				this.opdsFeedClient.addSource({
					name: feed.name,
					url: feed.url,
					authRequired: feed.requiresAuth,
					username: feed.username,
					enabled: feed.enabled,
				});
			}
		}

		// Initialize public API
		this.api = createAPI({
			libraryService: this.libraryService,
			highlightService: this.highlightService,
			bookmarkService: this.bookmarkService,
			libraryStore: this.libraryStore,
			highlightStore: this.highlightStore,
			// File System Architecture Services
			tieredCache: this.tieredCache,
			offlineManager: this.offlineManager,
			networkMonitor: this.networkMonitor,
			deduplicationManager: this.deduplicationManager,
			assetExtractor: this.assetExtractor,
			opdsFeedClient: this.opdsFeedClient,
		});

		// Expose API globally for Templater/QuickAdd
		(window as any).Amnesia = this.api;

		// Register views
		this.registerView(
			LIBRARY_VIEW_TYPE,
			(leaf) => new LibraryView(leaf, this)
		);

		this.registerView(
			READER_VIEW_TYPE,
			(leaf) => {
				const view = new ReaderView(leaf, this);
				// Patch setState to handle both file and bookPath
				const originalSetState = view.setState.bind(view);
				view.setState = async function(state: any, result: any) {
					// Convert file to bookPath if needed
					if (state?.file && !state?.bookPath) {
						state = { ...state, bookPath: state.file };
					}
					return originalSetState(state, result);
				};
				return view;
			}
		);

		// REMOVED: Old HighlightsView - now using in-reader NotebookSidebar instead

		this.registerView(
			OPDS_VIEW_TYPE,
			(leaf) => new OPDSView(leaf, this)
		);

		this.registerView(
			IMAGES_VIEW_TYPE,
			(leaf) => new ImagesView(leaf, this)
		);

		this.registerView(
			BOOK_SIDEBAR_VIEW_TYPE,
			(leaf) => new BookSidebarView(leaf, this)
		);

		this.registerView(
			CACHE_STATS_VIEW_TYPE,
			(leaf) => new CacheStatsView(leaf, this)
		);

		this.registerView(
			OFFLINE_BOOKS_VIEW_TYPE,
			(leaf) => new OfflineBooksView(leaf, this)
		);

		// Add ribbon icon
		this.addRibbonIcon('book-open', 'Amnesia', () => {
			this.activateLibraryView();
		});

		// Add commands
		this.addCommand({
			id: 'open-library',
			name: 'Open Library',
			callback: () => {
				this.activateLibraryView();
			}
		});

		this.addCommand({
			id: 'sync-library',
			name: 'Sync Library',
			callback: async () => {
				await this.libraryService.scan(this.settings.localBooksFolder);
			}
		});

		this.addCommand({
			id: 'open-book-notebook',
			name: 'Open Book Notebook',
			callback: () => {
				this.activateBookSidebar();
			}
		});

		this.addCommand({
			id: 'browse-opds',
			name: 'Browse OPDS Catalog',
			callback: () => {
				this.activateOPDSView();
			}
		});

		// Cache management commands
		this.addCommand({
			id: 'view-cache-stats',
			name: 'View Cache Statistics',
			callback: () => {
				this.activateCacheStatsView();
			}
		});

		this.addCommand({
			id: 'clear-cache',
			name: 'Clear Cache',
			callback: async () => {
				if (!this.tieredCache) {
					new Notice('Cache not available');
					return;
				}
				try {
					await this.tieredCache.clear();
					new Notice('Cache cleared successfully');
				} catch (e) {
					new Notice(`Failed to clear cache: ${e}`);
				}
			}
		});

		// Offline commands
		this.addCommand({
			id: 'view-offline-books',
			name: 'View Offline Books',
			callback: () => {
				this.activateOfflineBooksView();
			}
		});

		this.addCommand({
			id: 'toggle-offline-mode',
			name: 'Toggle Offline Mode',
			callback: async () => {
				if (!this.networkMonitor) {
					new Notice('Network monitor not available');
					return;
				}
				const isOfflineMode = this.networkMonitor.isOfflineMode();
				if (isOfflineMode) {
					// Disable offline mode and check connection
					this.networkMonitor.setOfflineMode(false);
					new Notice('Offline mode disabled');
					await this.networkMonitor.checkServerHealth();
				} else {
					// Enable offline mode
					this.networkMonitor.setOfflineMode(true);
					new Notice('Offline mode enabled');
				}
			}
		});

		// Calibre commands
		this.addCommand({
			id: 'calibre-sync',
			name: 'Calibre: Full Library Sync',
			callback: async () => {
				if (!this.settings.calibreEnabled) {
					console.warn('Calibre integration is not enabled');
					return;
				}
				await this.calibreService.fullSync();
			}
		});

		this.addCommand({
			id: 'calibre-connect',
			name: 'Calibre: Connect to Library',
			callback: async () => {
				if (!this.settings.calibreEnabled) {
					console.warn('Calibre integration is not enabled');
					return;
				}
				await this.calibreService.connect();
			}
		});

		this.addCommand({
			id: 'calibre-metadata-sync',
			name: 'Calibre: Sync Metadata (Bidirectional)',
			callback: async () => {
				if (!this.settings.calibreEnabled) {
					new Notice('Calibre integration is not enabled');
					return;
				}
				if (!this.calibreMetadataSync) {
					new Notice('Metadata sync is not initialized');
					return;
				}
				new Notice('Starting metadata sync...');
				try {
					const result = await this.calibreMetadataSync.fullBidirectionalSync();
					new Notice(
						`Metadata sync complete: ${result.succeeded} succeeded, ${result.failed} failed, ${result.conflicts.manualRequired} conflicts`
					);
					if (result.conflicts.manualRequired > 0) {
						console.log('[MetadataSync] Conflicts require manual resolution:', result.results.filter(r => r.conflicts.length > 0));
					}
				} catch (error) {
					console.error('[MetadataSync] Error:', error);
					new Notice(`Metadata sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
				}
			}
		});

		// Sync only the active note
		this.addCommand({
			id: 'calibre-sync-active-note',
			name: 'Calibre: Sync Active Note Only',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return false;

				// Check if file has calibreId in frontmatter
				const cache = this.app.metadataCache.getFileCache(activeFile);
				const calibreId = cache?.frontmatter?.calibreId || cache?.frontmatter?.calibre_id;
				if (!calibreId) return false;

				if (!checking) {
					this.syncActiveNote(activeFile, calibreId);
				}
				return true;
			}
		});

		this.addCommand({
			id: 'calibre-test-write',
			name: 'Calibre: Test Write API (Update Rating)',
			callback: async () => {
				if (!this.settings.calibreEnabled) {
					new Notice('Calibre integration is not enabled');
					return;
				}

				const contentServer = this.calibreService.getContentServer();
				if (!contentServer) {
					new Notice('Connect to Calibre Content Server first (not local database)');
					return;
				}

				// Get first book from library
				const books = this.calibreService.getStore().getValue().books;
				if (books.length === 0) {
					new Notice('No books in library. Run Calibre sync first.');
					return;
				}

				const testBook = books[0];
				const currentRating = testBook.rating || 0;
				const newRating = currentRating >= 8 ? 2 : currentRating + 2;

				new Notice(`Testing: Updating "${testBook.title}" rating from ${currentRating} to ${newRating}...`);
				console.log(`[CalibreTest] Book: ${testBook.title} (ID: ${testBook.id})`);
				console.log(`[CalibreTest] Current rating: ${currentRating}, New rating: ${newRating}`);

				// Enable verbose logging
				contentServer.setVerbose(true);

				try {
					const result = await contentServer.setRating(testBook.id, newRating / 2, 'stars');

					if (result.success) {
						new Notice(`✓ Rating updated to ${newRating}! Check Calibre and re-sync to verify.`);
						console.log('[CalibreTest] SUCCESS - Rating updated in Calibre');
					} else {
						new Notice(`✗ Failed: ${result.error}`);
						console.error('[CalibreTest] FAILED:', result.error);
					}
				} catch (error) {
					new Notice(`✗ Error: ${error instanceof Error ? error.message : 'Unknown'}`);
					console.error('[CalibreTest] ERROR:', error);
				}
			}
		});

		this.addCommand({
			id: 'calibre-verbose-toggle',
			name: 'Calibre: Toggle Verbose Logging',
			callback: () => {
				const contentServer = this.calibreService.getContentServer();
				if (!contentServer) {
					new Notice('Connect to Calibre Content Server first');
					return;
				}

				// Toggle verbose mode (we'll need to track state)
				const currentState = (contentServer as any).verbose || false;
				contentServer.setVerbose(!currentState);
				new Notice(`Calibre API verbose logging: ${!currentState ? 'ON' : 'OFF'}`);
				console.log(`[CalibreAPI] Verbose logging ${!currentState ? 'enabled' : 'disabled'}`);
			}
		});

		// Unified Sync commands
		this.addCommand({
			id: 'unified-sync-full',
			name: 'Unified Sync: Full Library Sync',
			callback: async () => {
				if (!this.syncEngine) {
					new Notice('Unified Sync is not enabled');
					return;
				}
				new Notice('Starting full sync...');
				try {
					const result = await this.syncEngine.fullSync();
					new Notice(`Sync complete: ${result.stats.succeeded} items processed`);
				} catch (error) {
					new Notice(`Sync failed: ${error}`);
				}
			}
		});

		this.addCommand({
			id: 'unified-sync-incremental',
			name: 'Unified Sync: Incremental Sync (Catch-Up)',
			callback: async () => {
				if (!this.syncEngine) {
					new Notice('Unified Sync is not enabled');
					return;
				}
				new Notice('Starting incremental sync...');
				try {
					const result = await this.syncEngine.incrementalSync();
					new Notice(`Sync complete: ${result.stats.succeeded} changes processed`);
				} catch (error) {
					new Notice(`Sync failed: ${error}`);
				}
			}
		});

		this.addCommand({
			id: 'unified-sync-cancel',
			name: 'Unified Sync: Cancel Active Sync',
			callback: async () => {
				if (!this.syncEngine) {
					new Notice('Unified Sync is not enabled');
					return;
				}
				await this.syncEngine.cancel();
				new Notice('Sync cancelled');
			}
		});

		this.addCommand({
			id: 'unified-sync-status',
			name: 'Unified Sync: Show Status',
			callback: () => {
				if (!this.syncEngine) {
					new Notice('Unified Sync is not enabled');
					return;
				}
				const status = this.syncEngine.getStatus();
				const progress = this.syncEngine.getProgress();
				console.log('Unified Sync Status:', { status, progress });
				new Notice(`Sync Status: ${status} (${progress?.percentage || 0}%)`);
			}
		});

		this.addCommand({
			id: 'unified-sync-resume',
			name: 'Unified Sync: Resume Incomplete Sync',
			callback: async () => {
				if (!this.syncEngine) {
					new Notice('Unified Sync is not enabled');
					return;
				}
				const result = await this.syncEngine.resumeIfIncomplete();
				if (result) {
					new Notice(`Resumed and completed sync: ${result.stats.succeeded} items`);
				} else {
					new Notice('No incomplete sync to resume');
				}
			}
		});

		// Reader ↔ Vault Sync commands
		this.addCommand({
			id: 'reader-vault-sync-book',
			name: 'Reader ↔ Vault: Sync Current Book Highlights',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return false;

				const cache = this.app.metadataCache.getFileCache(activeFile);
				const bookId = cache?.frontmatter?.bookId || cache?.frontmatter?.calibreId;

				if (checking) return !!bookId;

				if (bookId && this.readerVaultSync) {
					this.readerVaultSync.syncBook(String(bookId)).then(result => {
						if (result.success) {
							new Notice(`Synced ${result.itemsProcessed} highlights`);
						} else {
							new Notice(`Sync failed: ${result.errors[0]?.message || 'Unknown error'}`);
						}
					});
				}
				return true;
			}
		});

		this.addCommand({
			id: 'reader-vault-sync-all',
			name: 'Reader ↔ Vault: Sync All Highlights',
			callback: async () => {
				if (!this.readerVaultSync) {
					new Notice('Reader ↔ Vault Sync is not initialized');
					return;
				}
				new Notice('Starting full highlight sync...');
				const result = await this.readerVaultSync.syncAll();
				if (result.success) {
					new Notice(`Synced ${result.itemsProcessed} highlights`);
				} else {
					new Notice(`Sync completed with ${result.errors.length} errors`);
				}
			}
		});

		this.addCommand({
			id: 'reader-vault-sync-status',
			name: 'Reader ↔ Vault: Show Sync Status',
			callback: () => {
				if (!this.readerVaultSync) {
					new Notice('Reader ↔ Vault Sync is not initialized');
					return;
				}
				const isSyncing = this.readerVaultSync.isSyncInProgress();
				const settings = this.readerVaultSync.getSettings();
				console.log('Reader ↔ Vault Sync Status:', {
					isSyncing,
					settings,
				});
				new Notice(isSyncing ? 'Sync in progress...' : `Sync idle (mode: ${settings.highlightSyncMode})`);
			}
		});

		// Migration commands
		this.addCommand({
			id: 'create-backup',
			name: 'Create Backup of Library',
			callback: async () => {
				new Notice('Creating backup...');
				try {
					const files = this.app.vault.getMarkdownFiles()
						.filter(f => f.path.startsWith('Biblioteca/'))
						.map(f => f.path);
					const result = await this.backupService.createBackup(files, 'Manual backup');
					new Notice(`Backup created: ${result.files.length} files`);
				} catch (e) {
					new Notice(`Backup failed: ${e}`);
				}
			}
		});

		this.addCommand({
			id: 'list-backups',
			name: 'List Backups',
			callback: async () => {
				const backups = await this.backupService.listBackups();
				if (backups.length === 0) {
					new Notice('No backups found');
				} else {
					new Notice(`Found ${backups.length} backups. Check console for details.`);
					console.log('Amnesia Backups:', backups);
				}
			}
		});

		// Register file extension handler for EPUB files
		this.registerExtensions(['epub'], READER_VIEW_TYPE);


		// Command to open book from current note
		this.addCommand({
			id: 'open-book-from-note',
			name: 'Open Book in Reader',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return false;

				// Check if it's a book note
				const cache = this.app.metadataCache.getFileCache(activeFile);
				const isBookNote = cache?.frontmatter?.type === 'book' &&
					(cache?.frontmatter?.epubPath || cache?.frontmatter?.calibreId);

				if (checking) return isBookNote;

				if (isBookNote) {
					this.openBookFromNote(activeFile);
				}
				return true;
			}
		});

		// Command to open book images from current note
		this.addCommand({
			id: 'open-book-images',
			name: 'Browse Book Images',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return false;

				// Check if it's a book note
				const cache = this.app.metadataCache.getFileCache(activeFile);
				const isBookNote = cache?.frontmatter?.type === 'book' &&
					(cache?.frontmatter?.epubPath || cache?.frontmatter?.calibreId);

				if (checking) return isBookNote;

				if (isBookNote) {
					this.openBookImagesFromNote(activeFile);
				}
				return true;
			}
		});

		// Command to regenerate book note from template
		this.addCommand({
			id: 'regenerate-book-note',
			name: 'Regenerate current book note from template',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return false;

				// Check if it's a book note
				const cache = this.app.metadataCache.getFileCache(activeFile);
				const isBookNote = cache?.frontmatter?.type === 'book' &&
					(cache?.frontmatter?.epubPath || cache?.frontmatter?.calibreId);

				if (checking) return isBookNote;

				if (isBookNote) {
					this.regenerateBookNote(activeFile);
				}
				return true;
			}
		});

		// Add modal styles
		addRegenerateModalStyles(document);

		// Add settings tab
		this.addSettingTab(new AmnesiaSettingTab(this.app, this));

		// Initialize services on layout ready (or immediately if already ready)
		const initializeServices = async () => {
			// Configure library scanner with server settings if enabled
			if (this.settings.serverEnabled && this.settings.serverUrl) {
				const { getDeviceId } = await import('./reader/renderer');
				const deviceId = getDeviceId();
				this.libraryService.scanner.setServerConfig(this.settings.serverUrl, deviceId);
			}

			await this.libraryService.initialize(this.settings.localBooksFolder);
			await this.highlightService.initialize();
			await this.bookmarkService.initialize();

			// Auto-connect to Calibre if enabled
			if (this.settings.calibreEnabled && this.settings.calibreLibraryPath) {
				try {
					await this.calibreService.connect();
					// Scan books after connecting to populate the library
					await this.calibreService.scan();
					console.log('Calibre library connected');
				} catch (error) {
					console.warn('Failed to connect to Calibre library:', error);
				}
			}

			// Initialize Unified Sync Engine if enabled
			if (this.settings.unifiedSync.enabled) {
				await this.initializeUnifiedSyncEngine();
			}

			// Initialize Reader ↔ Vault Sync (if enabled)
			if (this.settings.readerVaultSync?.enabled) {
				try {
					console.log('[Amnesia] Initializing Reader ↔ Vault Sync...');
					await this.initializeReaderVaultSync();
					console.log('[Amnesia] Reader ↔ Vault Sync initialized successfully');
				} catch (error) {
					console.error('[Amnesia] Failed to initialize Reader ↔ Vault Sync:', error);
				}
			} else {
				console.log('[Amnesia] Reader ↔ Vault Sync disabled in settings');
			}
		};

		// Check if layout is already ready (e.g., during hot reload)
		if (this.app.workspace.layoutReady) {
			console.log('[Amnesia] Layout already ready, initializing services immediately');
			// CRITICAL: Must await to ensure Reader ↔ Vault Sync initializes on hot reload
			await initializeServices();
		} else {
			console.log('[Amnesia] Waiting for layout ready');
			this.app.workspace.onLayoutReady(initializeServices);
		}

		console.log('Amnesia plugin loaded');
	}

	onunload() {
		console.log('Unloading Amnesia plugin');

		// ==========================================================================
		// Cleanup Unified Sync Architecture
		// ==========================================================================
		for (const unsubscribe of this.syncEngineUnsubscribes) {
			unsubscribe();
		}
		this.syncEngineUnsubscribes = [];

		if (this.syncEngine) {
			this.syncEngine.destroy();
			this.syncEngine = null;
		}

		// ==========================================================================
		// Cleanup Reader ↔ Vault Sync
		// ==========================================================================
		for (const unsubscribe of this.readerVaultSyncUnsubscribes) {
			unsubscribe();
		}
		this.readerVaultSyncUnsubscribes = [];

		if (this.readerVaultSync) {
			this.readerVaultSync.stop();
			this.readerVaultSync = null;
		}

		// ==========================================================================
		// Cleanup File System Architecture Services (reverse order of initialization)
		// ==========================================================================

		// 6. OPDS Feed Client cleanup
		// No explicit cleanup needed - stateless client

		// 5. Asset Extractor cleanup
		if (this.assetExtractor) {
			this.assetExtractor.destroy();
			this.assetExtractor = null;
		}

		// 4. Deduplication Manager cleanup
		if (this.deduplicationManager) {
			// No explicit cleanup needed - in-memory storage
			this.deduplicationManager = null;
		}

		// 3. Offline Manager cleanup
		if (this.offlineProgressUnsubscribe) {
			this.offlineProgressUnsubscribe();
			this.offlineProgressUnsubscribe = null;
		}
		if (this.offlineManager) {
			// Note: OfflineManager uses AbortController for cleanup, no explicit dispose needed
			this.offlineManager = null;
		}

		// 2. Tiered Cache cleanup
		if (this.tieredCache) {
			this.tieredCache.close();
			this.tieredCache = null;
		}

		// 1. Network Monitor cleanup
		if (this.networkStatusUnsubscribe) {
			this.networkStatusUnsubscribe();
			this.networkStatusUnsubscribe = null;
		}
		if (this.networkMonitor) {
			this.networkMonitor.stop();
			this.networkMonitor = null;
		}

		// ==========================================================================
		// Cleanup existing services
		// ==========================================================================

		this.libraryService.stopWatching();
		this.calibreService.disconnect();
		if (this.calibreStoreUnsubscribe) {
			this.calibreStoreUnsubscribe();
		}

		// Clean up API
		if (this.api) {
			this.api.dispose();
		}
		delete (window as any).Amnesia;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		// Load existing data to preserve non-settings data (like highlightIndex)
		const existingData = await this.loadData() || {};
		// Merge settings with existing data, preserving highlightIndex
		await this.saveData({
			...existingData,
			...this.settings,
		});
		// Update unified note generator when templates change
		if (this.unifiedNoteGenerator) {
			this.unifiedNoteGenerator.setTemplates(this.settings.templates);
		}
		// Update field aliases for Calibre metadata sync
		if (this.calibreMetadataSync) {
			this.calibreMetadataSync.setFieldAliases(this.settings.fieldAliases);
		}
	}

	async activateLibraryView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(LIBRARY_VIEW_TYPE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: LIBRARY_VIEW_TYPE, active: true });
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async activateBookSidebar(bookId?: string, bookPath?: string, bookTitle?: string) {
		const { workspace } = this.app;

		// Update the sidebar store with current book info
		if (bookId) {
			sidebarStore.setActiveBook(bookId, bookPath, bookTitle);
		}

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(BOOK_SIDEBAR_VIEW_TYPE);

		if (leaves.length > 0) {
			// Find existing leaves, prefer left sidebar
			const leftLeaves = leaves.filter(l => l.getRoot() === workspace.leftSplit);
			const rightLeaves = leaves.filter(l => l.getRoot() === workspace.rightSplit);

			if (leftLeaves.length > 0) {
				// Prefer left sidebar if one exists
				leaf = leftLeaves[0];
			} else if (rightLeaves.length > 0) {
				// Use right sidebar if only right exists
				leaf = rightLeaves[0];
			} else {
				// Use any existing leaf
				leaf = leaves[0];
			}
		} else {
			// No existing sidebar - create on LEFT (preferred)
			leaf = workspace.getLeftLeaf(false);
			await leaf?.setViewState({ type: BOOK_SIDEBAR_VIEW_TYPE, active: true });
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async activateOPDSView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(OPDS_VIEW_TYPE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf('tab');
			await leaf?.setViewState({ type: OPDS_VIEW_TYPE, active: true });
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async activateCacheStatsView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(CACHE_STATS_VIEW_TYPE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf('tab');
			await leaf?.setViewState({ type: CACHE_STATS_VIEW_TYPE, active: true });
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async activateOfflineBooksView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(OFFLINE_BOOKS_VIEW_TYPE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf('tab');
			await leaf?.setViewState({ type: OFFLINE_BOOKS_VIEW_TYPE, active: true });
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async openBook(bookPath: string) {
		const { workspace } = this.app;

		// Find the book in the library (vault books)
		const vaultBook = this.libraryStore.getValue().books.find(
			b => b.localPath === bookPath
		);

		// Find the book in Calibre library if not in vault
		const calibreBook = this.calibreService?.getStore().getValue().books.find(
			b => b.epubPath === bookPath
		);

		// Get book title from either source
		const bookTitle = vaultBook?.title || calibreBook?.title;

		// Auto-create book note if enabled and note doesn't exist
		if (vaultBook && this.settings.autoCreateBookNotes) {
			try {
				if (!this.noteGenerator.bookNoteExists(vaultBook)) {
					await this.noteGenerator.generateBookNote(vaultBook);
				}
			} catch (e) {
				console.warn('Failed to create book note:', e);
			}
		}

		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({
			type: READER_VIEW_TYPE,
			state: { bookPath, bookTitle }
		});

		workspace.revealLeaf(leaf);
	}

	/**
	 * Open a book from its note file
	 * Reads the epubPath or calibrePath from frontmatter
	 */
	async openBookFromNote(noteFile: TFile) {
		const { workspace, metadataCache } = this.app;

		// Get frontmatter
		const cache = metadataCache.getFileCache(noteFile);
		const frontmatter = cache?.frontmatter;

		if (!frontmatter) {
			new Notice('No frontmatter found in book note');
			return;
		}

		// Try to find the EPUB path
		let epubPath = frontmatter.epubPath || frontmatter.calibrePath;
		let bookTitle = frontmatter.title;

		if (!epubPath) {
			// Try to find in Calibre store by calibreId
			if (frontmatter.calibreId) {
				const calibreBooks = this.calibreService.getStore().getValue().books;
				const calibreBook = calibreBooks.find(b => b.id === frontmatter.calibreId);
				if (calibreBook) {
					epubPath = calibreBook.epubPath;
					bookTitle = bookTitle || calibreBook.title;
				}
			}
		}

		if (!epubPath) {
			new Notice('No EPUB path found in book note');
			return;
		}

		// Open the reader
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({
			type: READER_VIEW_TYPE,
			state: { bookPath: epubPath, bookTitle }
		});

		workspace.revealLeaf(leaf);
	}

	/**
	 * Open book images from its note file
	 * Reads the epubPath or calibrePath from frontmatter
	 */
	async openBookImagesFromNote(noteFile: TFile) {
		const { metadataCache } = this.app;

		// Get frontmatter
		const cache = metadataCache.getFileCache(noteFile);
		const frontmatter = cache?.frontmatter;

		if (!frontmatter) {
			new Notice('No frontmatter found in book note');
			return;
		}

		// Try to find the EPUB path
		let epubPath = frontmatter.epubPath || frontmatter.calibrePath;
		let bookTitle = frontmatter.title;

		if (!epubPath) {
			// Try to find in Calibre store by calibreId
			if (frontmatter.calibreId) {
				const calibreBooks = this.calibreService.getStore().getValue().books;
				const calibreBook = calibreBooks.find(b => b.id === frontmatter.calibreId);
				if (calibreBook) {
					epubPath = calibreBook.epubPath;
					bookTitle = bookTitle || calibreBook.title;
				}
			}
		}

		if (!epubPath) {
			new Notice('No EPUB path found in book note');
			return;
		}

		// Open the images view
		await this.openBookImages(epubPath, bookTitle);
	}

	/**
	 * Regenerate a book note from template
	 */
	async regenerateBookNote(noteFile: TFile): Promise<void> {
		const { metadataCache } = this.app;

		// Get frontmatter
		const cache = metadataCache.getFileCache(noteFile);
		const frontmatter = cache?.frontmatter;

		if (!frontmatter) {
			new Notice('No frontmatter found in book note');
			return;
		}

		const bookTitle = frontmatter.title || noteFile.basename;

		// Show confirmation modal
		const modal = new RegenerateConfirmModal(this.app, bookTitle, noteFile.path);
		const result = await modal.openAndWait();

		if (!result.confirmed) {
			return;
		}

		try {
			// Find the book data and convert to UnifiedBook format
			let calibreBook = null;
			let vaultBook = null;

			// Try to find in Calibre store by calibreId
			if (frontmatter.calibreId) {
				const calibreBooks = this.calibreService.getStore().getValue().books;
				calibreBook = calibreBooks.find(b => b.id === frontmatter.calibreId);
			}

			// Try to find in library store by epubPath
			if (frontmatter.epubPath) {
				const vaultBooks = this.libraryStore.getValue().books;
				vaultBook = vaultBooks.find(b => b.localPath === frontmatter.epubPath);
			}

			if (!calibreBook && !vaultBook) {
				new Notice('Could not find book data for regeneration');
				return;
			}

			// Convert to UnifiedBook format (required by generateBookNote)
			const unifiedBook = this.convertToUnifiedBook(calibreBook, vaultBook);

			if (result.preserveUserContent) {
				// The unified note generator already handles persisted content via renderWithPersist
				// It reads the existing file and preserves {% persist %} blocks
				const genResult = await this.unifiedNoteGenerator.generateBookNote(unifiedBook, []);

				if (genResult.success) {
					new Notice(`Regenerated note for "${bookTitle}" with user content preserved`);
				} else {
					new Notice(`Failed to regenerate: ${genResult.error}`);
				}
			} else {
				// Full regeneration - delete existing file first to prevent content preservation
				await this.app.vault.delete(noteFile);
				const genResult = await this.unifiedNoteGenerator.generateBookNote(unifiedBook, []);

				if (genResult.success) {
					new Notice(`Fully regenerated note for "${bookTitle}"`);
				} else {
					new Notice(`Failed to regenerate: ${genResult.error}`);
				}
			}
		} catch (error) {
			console.error('Failed to regenerate book note:', error);
			new Notice(`Failed to regenerate note: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Convert Calibre/Vault book to UnifiedBook format
	 */
	private convertToUnifiedBook(
		calibreBook: any | null,
		vaultBook: any | null
	): import('./types/unified-book').UnifiedBook {
		const book = calibreBook || vaultBook;
		if (!book) {
			throw new Error('No book data available');
		}

		// Build unified book structure
		const authors = calibreBook?.authors?.map((a: any) => ({
			name: typeof a === 'string' ? a : a.name,
		})) || (vaultBook?.author ? [{ name: vaultBook.author }] : []);

		const tags = calibreBook?.tags?.map((t: any) => typeof t === 'string' ? t : t.name) || [];

		// Build sources array
		const sources: import('./types/book-source').BookSource[] = [];
		const now = new Date();

		if (calibreBook) {
			sources.push({
				type: 'calibre-local',
				libraryPath: calibreBook.libraryPath || '',
				calibreId: calibreBook.id,
				epubPath: calibreBook.epubPath || '',
				lastModified: calibreBook.lastModified || now,
				calibreUuid: calibreBook.uuid,
				addedAt: now,
				lastVerified: now,
				priority: 1,
			});
		}

		if (vaultBook?.localPath) {
			sources.push({
				type: 'vault-copy',
				vaultPath: vaultBook.localPath,
				copiedAt: now,
				addedAt: now,
				lastVerified: now,
				priority: 0,
			});
		}

		// Build formats array
		const formats: import('./types/unified-book').BookFormat[] = [];
		if (calibreBook?.epubPath) {
			formats.push({
				type: 'epub',
				path: calibreBook.epubPath,
			});
		}
		if (vaultBook?.localPath) {
			const ext = vaultBook.localPath.split('.').pop()?.toLowerCase();
			if (ext === 'epub' || ext === 'pdf') {
				formats.push({
					type: ext as 'epub' | 'pdf',
					path: vaultBook.localPath,
				});
			}
		}

		return {
			id: calibreBook?.uuid || vaultBook?.id || `book-${Date.now()}`,
			calibreUuid: calibreBook?.uuid,
			title: book.title || 'Untitled',
			authors,
			series: calibreBook?.series ? {
				name: calibreBook.series.name || calibreBook.series,
				index: calibreBook.seriesIndex,
			} : undefined,
			publisher: calibreBook?.publisher,
			publishedDate: calibreBook?.pubdate,
			description: calibreBook?.description,
			tags,
			rating: calibreBook?.rating || undefined,
			sources,
			formats,
			status: 'to-read',
			progress: 0,
			addedAt: new Date(),
		};
	}

	/**
	 * Open a book by Calibre ID
	 */
	async openBookByCalibreId(calibreId: number) {
		const { workspace } = this.app;
		const calibreBooks = this.calibreService.getStore().getValue().books;
		const book = calibreBooks.find(b => b.id === calibreId);

		if (!book || !book.epubPath) {
			new Notice(`Book with Calibre ID ${calibreId} not found`);
			return;
		}

		// Open with title for proper view header display
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({
			type: READER_VIEW_TYPE,
			state: { bookPath: book.epubPath, bookTitle: book.title }
		});

		workspace.revealLeaf(leaf);
	}

	/**
	 * Update the status bar item based on Calibre sync state
	 */
	private updateStatusBar(): void {
		if (!this.statusBarItem) return;

		const state = this.calibreService.getStore().getValue();
		const { syncInProgress, syncProgress, connected, books } = state;

		// Clear previous content
		this.statusBarItem.empty();

		// Create icon container
		const iconEl = this.statusBarItem.createSpan({ cls: 'status-bar-item-icon' });
		setIcon(iconEl, 'library');

		// Determine what to show
		if (syncInProgress) {
			// Show sync progress
			const { currentItem, totalItems, percentage, phase } = syncProgress;
			let text = '';

			if (phase === 'scanning') {
				text = 'Scanning...';
			} else if (phase === 'generating-notes' || phase === 'copying-covers') {
				text = `${currentItem}/${totalItems} (${percentage}%)`;
			} else if (phase === 'generating-indexes') {
				text = `Indexes (${percentage}%)`;
			} else {
				text = `${percentage}%`;
			}

			this.statusBarItem.createSpan({ text, cls: 'status-bar-item-segment' });
			this.statusBarItem.addClass('syncing');
		} else if (connected) {
			// Show book count when connected and not syncing
			const bookCount = books.length;
			if (bookCount > 0) {
				this.statusBarItem.createSpan({
					text: `${bookCount} books`,
					cls: 'status-bar-item-segment'
				});
			} else {
				this.statusBarItem.createSpan({
					text: 'Connected',
					cls: 'status-bar-item-segment'
				});
			}
			this.statusBarItem.removeClass('syncing');
		} else if (this.settings.calibreEnabled) {
			// Calibre enabled but not connected
			this.statusBarItem.createSpan({
				text: 'Not connected',
				cls: 'status-bar-item-segment'
			});
			this.statusBarItem.removeClass('syncing');
		} else {
			// Calibre not enabled - hide status bar
			this.statusBarItem.hide();
			return;
		}

		this.statusBarItem.show();
	}

	/**
	 * Update the network status bar item
	 */
	private updateNetworkStatusBar(): void {
		if (!this.networkStatusBarItem) return;

		// Clear previous content
		this.networkStatusBarItem.empty();

		// Get network state if monitor is available
		const networkState = this.networkMonitor?.getState();

		// Create icon container
		const iconEl = this.networkStatusBarItem.createSpan({ cls: 'status-bar-item-icon' });

		if (!networkState) {
			// Network monitor not enabled
			this.networkStatusBarItem.hide();
			return;
		}

		// Determine icon based on status
		if (networkState.status === 'offline') {
			setIcon(iconEl, 'wifi-off');
			this.networkStatusBarItem.addClass('offline');
			this.networkStatusBarItem.removeClass('degraded');
		} else if (networkState.quality === 'poor' || networkState.quality === 'fair') {
			setIcon(iconEl, 'wifi');
			this.networkStatusBarItem.addClass('degraded');
			this.networkStatusBarItem.removeClass('offline');
		} else {
			setIcon(iconEl, 'wifi');
			this.networkStatusBarItem.removeClass('offline');
			this.networkStatusBarItem.removeClass('degraded');
		}

		this.networkStatusBarItem.show();
	}

	/**
	 * Open the Images view for a book
	 */
	async openBookImages(bookPath: string, bookTitle?: string) {
		const { workspace } = this.app;

		// Get book title from library if not provided
		if (!bookTitle) {
			const vaultBook = this.libraryStore.getValue().books.find(
				b => b.localPath === bookPath
			);
			const calibreBook = this.calibreService?.getStore().getValue().books.find(
				b => b.epubPath === bookPath
			);
			bookTitle = vaultBook?.title || calibreBook?.title;
		}

		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({
			type: IMAGES_VIEW_TYPE,
			state: { bookPath, bookTitle }
		});

		workspace.revealLeaf(leaf);
	}

	/**
	 * Load atomic highlights from vault for a specific book
	 * Scans the book's atomic notes folder and loads any highlights not yet in the store
	 * @param bookId The book ID (Calibre UUID or vault book ID)
	 * @param bookTitle The book title (used to find the atomic notes folder)
	 * @returns Number of highlights loaded from vault
	 */
	async loadAtomicHighlightsFromVault(bookId: string, bookTitle: string): Promise<number> {
		if (!this.readerVaultSync) {
			console.log('[Amnesia] Reader vault sync not available, skipping atomic highlight scan');
			return 0;
		}

		// Get the atomic folder path from template settings
		const templateSettings = this.settings.templates;
		const baseFolder = templateSettings?.atomicHighlight?.folder || 'Biblioteca/Florilegios';
		const atomicFolder = `${baseFolder}/${bookTitle}/atomic`;

		console.log(`[Amnesia] Scanning for atomic highlights in: ${atomicFolder}`);

		return this.readerVaultSync.scanAndLoadHighlightsFromFolder(atomicFolder, bookId);
	}

	// ==========================================================================
	// Single Note Sync
	// ==========================================================================

	/**
	 * Sync only the active note with Calibre (bidirectional)
	 */
	private async syncActiveNote(file: TFile, calibreId: number): Promise<void> {
		const contentServer = this.calibreService.getContentServer();
		if (!contentServer) {
			new Notice('Connect to Calibre Content Server first');
			return;
		}

		contentServer.setVerbose(true);
		new Notice(`Syncing: ${file.basename}...`);

		try {
			// Get current frontmatter from Obsidian
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter || {};

			// Get current metadata from Calibre
			const calibreBook = await contentServer.getBookMetadata(calibreId);

			console.log('='.repeat(60));
			console.log(`[SingleSync] Syncing: ${file.basename} (Calibre ID: ${calibreId})`);
			console.log('='.repeat(60));
			console.log('[SingleSync] Obsidian frontmatter:', {
				rating: fm.rating,
				tags: fm.tags,
				status: fm.status
			});
			console.log('[SingleSync] Calibre metadata:', {
				rating: calibreBook.rating,
				tags: calibreBook.tags
			});

			// Determine sync direction based on lastSync timestamp
			const lastSync = fm.lastSync ? new Date(fm.lastSync) : new Date(0);
			const calibreModified = calibreBook.last_modified ? new Date(calibreBook.last_modified) : new Date(0);

			// For now, push Obsidian → Calibre (can be made bidirectional later)
			const changes: Record<string, unknown> = {};

			// Convert Obsidian rating (1-5 stars) to Calibre (0-10)
			if (fm.rating !== undefined) {
				const calibreRating = Math.round(fm.rating * 2);
				if (calibreRating !== calibreBook.rating) {
					changes.rating = calibreRating;
					console.log(`[SingleSync] Rating: ${fm.rating}★ → ${calibreRating} (Calibre scale)`);
				}
			}

			// Sync tags (strip wiki-links if present)
			if (fm.tags && Array.isArray(fm.tags)) {
				const cleanTags = fm.tags.map((t: string) =>
					t.replace(/\[\[.*\|?(.*?)\]\]/g, '$1').trim()
				);
				const tagsChanged = JSON.stringify(cleanTags.sort()) !== JSON.stringify((calibreBook.tags || []).sort());
				if (tagsChanged) {
					changes.tags = cleanTags;
					console.log(`[SingleSync] Tags: ${JSON.stringify(cleanTags)}`);
				}
			}

			if (Object.keys(changes).length === 0) {
				console.log('[SingleSync] No changes to sync');
				new Notice('No changes to sync');
				return;
			}

			console.log('[SingleSync] Pushing changes to Calibre:', JSON.stringify(changes, null, 2));

			const result = await contentServer.setFields(calibreId, changes);

			if (result.success) {
				console.log('[SingleSync] SUCCESS - Calibre updated');
				console.log('[SingleSync] New values:', result.updatedMetadata);

				// Update lastSync in frontmatter
				await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
					frontmatter.lastSync = new Date().toISOString();
				});

				new Notice(`Synced: ${Object.keys(changes).join(', ')}`);
			} else {
				console.error('[SingleSync] FAILED:', result.error);
				new Notice(`Sync failed: ${result.error}`);
			}
		} catch (error) {
			console.error('[SingleSync] Error:', error);
			new Notice(`Sync error: ${error instanceof Error ? error.message : 'Unknown'}`);
		}
	}

	// ==========================================================================
	// Unified Sync Engine
	// ==========================================================================

	/**
	 * Initialize the Unified Sync Engine with adapters
	 */
	private async initializeUnifiedSyncEngine(): Promise<void> {
		const syncSettings = this.settings.unifiedSync;

		// Build sync config from settings
		const config: Partial<SyncConfig> = {
			defaultMode: syncSettings.defaultMode,
			defaultConflictStrategy: syncSettings.defaultConflictStrategy,
			concurrency: syncSettings.concurrency,
			enableResume: syncSettings.enableResume,
			checkpointInterval: syncSettings.checkpointInterval,
			rateLimit: syncSettings.rateLimit,
		};

		// Create the sync engine
		this.syncEngine = new UnifiedSyncEngine(
			this.app,
			() => this.settings,
			{ config }
		);

		// Register adapters based on settings
		if (syncSettings.enabledAdapters.calibre && this.calibreService) {
			const { CalibreSyncAdapter } = await import('./sync/adapters/calibre-adapter');
			const calibreAdapter = new CalibreSyncAdapter(
				this.app,
				this.calibreService,
				() => this.settings
			);
			this.syncEngine.registerAdapter(calibreAdapter);
		}

		// Note: ServerSyncAdapter and FileSyncAdapter would be registered here
		// when AmnesiaClient and ChunkedUploader are available
		// Currently these are placeholders for future implementation

		// Subscribe to sync engine events
		const progressUnsub = this.syncEngine.on('progress', (progress: UnifiedSyncProgress) => {
			console.log('Sync progress:', progress);
			// Could update a status bar or progress modal here
		});
		this.syncEngineUnsubscribes.push(progressUnsub);

		const errorUnsub = this.syncEngine.on('error', (data) => {
			console.error('Sync error:', data.error);
			new Notice(`Sync error: ${data.error.message}`);
		});
		this.syncEngineUnsubscribes.push(errorUnsub);

		const completeUnsub = this.syncEngine.on('complete', (data) => {
			console.log('Sync complete:', data.session);
			if (data.session.errorItems > 0) {
				new Notice(`Sync complete with ${data.session.errorItems} errors`);
			}
		});
		this.syncEngineUnsubscribes.push(completeUnsub);

		// Check for incomplete syncs to resume
		if (syncSettings.enableResume && syncSettings.showResumeNotification) {
			const hasResumable = await this.syncEngine.hasResumableSync();
			if (hasResumable) {
				new Notice('An incomplete sync was detected. Use "Unified Sync: Resume" to continue.');
			}
		}

		console.log('Unified Sync Engine initialized');
	}

	// ==========================================================================
	// Reader ↔ Vault Sync
	// ==========================================================================

	/**
	 * Initialize the Reader ↔ Vault Sync Orchestrator
	 */
	private async initializeReaderVaultSync(): Promise<void> {
		// Build sync settings from plugin settings
		const syncSettings: Partial<ReaderVaultSyncSettings> = {
			highlightSyncMode: this.settings.readerVaultSync?.highlightSyncMode ?? 'bidirectional',
			noteSyncMode: this.settings.readerVaultSync?.noteSyncMode ?? 'bidirectional',
			appendOnlyVault: this.settings.readerVaultSync?.appendOnlyVault ?? false,
			preserveReaderHighlights: this.settings.readerVaultSync?.preserveReaderHighlights ?? false,
			debounceDelay: this.settings.readerVaultSync?.debounceDelay ?? 2000,
			autoSync: this.settings.readerVaultSync?.autoSync ?? true,
			autoRegenerateHub: this.settings.readerVaultSync?.autoRegenerateHub ?? false,
			hubRegenerateDelay: this.settings.readerVaultSync?.hubRegenerateDelay ?? 5000,
		};

		// Create the sync orchestrator
		this.readerVaultSync = createReaderVaultSync(
			this.app,
			syncSettings,
			() => this.highlightStore.getValue(),
			(action) => this.highlightStore.dispatch(action)
		);

		// Wire up hub regeneration callback if highlightGenerator is available
		if (this.highlightGenerator) {
			this.readerVaultSync.setHubRegenerateCallback(async (bookId: string) => {
				// Find the book in Calibre store by ID, UUID, or epubPath
				const calibreBooks = this.calibreService.getStore().getValue().books;
				let calibreBook = calibreBooks.find(b =>
					b.uuid === bookId || String(b.id) === bookId
				);

				// If not found by UUID, try to find by epubPath from the current reader view
				if (!calibreBook) {
					const readerLeaves = this.app.workspace.getLeavesOfType('amnesia-reader');
					for (const leaf of readerLeaves) {
						const view = leaf.view as ReaderView;
						if (view?.bookPath) {
							calibreBook = calibreBooks.find(b => b.epubPath === view.bookPath);
							if (calibreBook) {
								console.log(`[ReaderVaultSync] Found book by epubPath: ${calibreBook.uuid}`);
								break;
							}
						}
					}
				}

				if (!calibreBook) {
					console.warn(`[ReaderVaultSync] Could not find book ${bookId} for hub regeneration`);
					return;
				}

				// Get highlights for this book - try both the provided bookId and the Calibre UUID
				const highlightState = this.highlightStore.getValue();
				let highlights = highlightState.highlights[bookId] || [];

				// Also check for highlights under the Calibre UUID if different
				if (calibreBook.uuid !== bookId) {
					const calibreHighlights = highlightState.highlights[calibreBook.uuid] || [];
					highlights = [...highlights, ...calibreHighlights];
				}

				// Convert to UnifiedBook format
				const unifiedBook = this.convertToUnifiedBook(calibreBook, null);

				// Regenerate hub file using generateHighlights
				await this.highlightGenerator.generateHighlights(unifiedBook, highlights, {
					generateHub: true,
					generateAtomic: false, // Only regenerate hub, not atomic notes
				});
			});

			// Wire up atomic note creation callback
			this.readerVaultSync.setAtomicNoteCreateCallback(async (bookId: string, highlight) => {
				// Find the book in Calibre store
				const calibreBooks = this.calibreService.getStore().getValue().books;
				let calibreBook = calibreBooks.find(b =>
					b.uuid === bookId || String(b.id) === bookId
				);

				// If not found by UUID, try to find by epubPath from the current reader view
				if (!calibreBook) {
					const readerLeaves = this.app.workspace.getLeavesOfType('amnesia-reader');
					for (const leaf of readerLeaves) {
						const view = leaf.view as ReaderView;
						if (view?.bookPath) {
							calibreBook = calibreBooks.find(b => b.epubPath === view.bookPath);
							if (calibreBook) break;
						}
					}
				}

				if (!calibreBook) {
					console.warn(`[ReaderVaultSync] Could not find book ${bookId} for atomic note creation`);
					return null;
				}

				// Convert to UnifiedBook format
				const unifiedBook = this.convertToUnifiedBook(calibreBook, null);

				// Generate atomic note for this single highlight
				const result = await this.highlightGenerator.generateHighlights(unifiedBook, [highlight], {
					generateHub: false,
					generateAtomic: true,
				});

				// Return the path if created
				if (result.atomicPathMap.size > 0) {
					return result.atomicPathMap.get(highlight.id) || null;
				}

				return null;
			});
		}

		// Subscribe to sync events
		const syncEventUnsub = this.readerVaultSync.on((event) => {
			switch (event.type) {
				case 'sync-start':
					console.log('[ReaderVaultSync] Sync started:', event.data.trigger);
					break;
				case 'sync-complete':
					console.log('[ReaderVaultSync] Sync complete:', event.data.result);
					break;
				case 'conflict-detected':
					console.log('[ReaderVaultSync] Conflict detected:', event.data.conflict);
					new Notice('Sync conflict detected - review in console');
					break;
				case 'error':
					console.error('[ReaderVaultSync] Error:', event.data.error);
					new Notice(`Sync error: ${event.data.error?.message}`);
					break;
			}
		});
		this.readerVaultSyncUnsubscribes.push(syncEventUnsub);

		// Wire up highlight service events to sync orchestrator
		// Subscribe to highlight store changes and detect new/updated/deleted highlights
		// Store highlight data (including atomicNotePath) so we can pass it when detecting deletions
		let previousHighlights: Record<string, Map<string, { atomicNotePath?: string }>> = {};

		const highlightStoreUnsub = this.highlightStore.subscribe((state) => {
			if (!this.readerVaultSync) return;

			// Track changes per book
			for (const [bookId, highlights] of Object.entries(state.highlights)) {
				const currentMap = new Map<string, { atomicNotePath?: string }>(
					highlights.map(h => [h.id, { atomicNotePath: h.atomicNotePath }])
				);
				const previousMap = previousHighlights[bookId] || new Map();

				// Detect new highlights
				for (const highlight of highlights) {
					if (!previousMap.has(highlight.id)) {
						this.readerVaultSync.onHighlightCreated(highlight);
					}
				}

				// Detect deleted highlights - pass the atomicNotePath we stored
				for (const [previousId, data] of previousMap) {
					if (!currentMap.has(previousId)) {
						this.readerVaultSync.onHighlightDeleted(bookId, previousId, data.atomicNotePath);
					}
				}

				previousHighlights[bookId] = currentMap;
			}

			// Clean up removed books
			for (const bookId of Object.keys(previousHighlights)) {
				if (!(bookId in state.highlights)) {
					delete previousHighlights[bookId];
				}
			}
		});
		this.readerVaultSyncUnsubscribes.push(highlightStoreUnsub);

		// Start the sync orchestrator
		this.readerVaultSync.start();

		console.log('Reader ↔ Vault Sync initialized');
	}
}

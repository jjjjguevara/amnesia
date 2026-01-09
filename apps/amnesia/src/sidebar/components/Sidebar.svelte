<script lang="ts">
  /**
   * Book Sidebar
   *
   * Main sidebar component for viewing book highlights, bookmarks, notes, and images.
   * Uses Doc Doctor-style ViewModeSwitcher with expandable tab selector.
   * Uses Obsidian CSS variables for theming.
   */
  import { onMount, onDestroy } from 'svelte';
  import type AmnesiaPlugin from '../../main';
  import type { Highlight, HighlightColor } from '../../library/types';
  import type { Bookmark, ReadingNote } from '../../bookmarks/bookmark-types';
  import { sidebarStore, type SidebarTab } from '../sidebar.store';
  import ViewModeSwitcher from './ViewModeSwitcher.svelte';
  import ControlsBar from './ControlsBar.svelte';
  import HighlightsTab from './HighlightsTab.svelte';
  import BookmarksTab from './BookmarksTab.svelte';
  import NotesTab from './NotesTab.svelte';
  import ImagesTab, { type BookImage } from './ImagesTab.svelte';
  import TocTab from './TocTab.svelte';
  import SearchTab from './SearchTab.svelte';
  import ImageLightbox from '../../reader/components/ImageLightbox.svelte';
  import type { TocEntry, SpineItem } from '../../reader/renderer/types';
  import type { Locator } from '../../reader/navigator/navigator-interface';
  import type { TocExpandedState } from './toc/types';
  import { getSearchIndex, type SearchResult } from '../../reader/search-index';
  import {
    Search,
    X,
    BookOpen,
  } from 'lucide-svelte';

  export let plugin: AmnesiaPlugin;

  let activeTab: SidebarTab = 'highlights';
  let searchQuery = '';
  let showSearch = false;
  let activeBookId: string | null = null;
  let activeBookPath: string | null = null;
  let activeBookTitle: string | null = null;

  // Data for current book
  let highlights: Highlight[] = [];
  let bookmarks: Bookmark[] = [];
  let notes: ReadingNote[] = [];
  let bookImages: BookImage[] = [];
  let imagesLoading = false;
  let imagesLoadedForBook: string | null = null;

  // Lightbox state
  let lightboxOpen = false;
  let lightboxStartIndex = 0;

  // ToC state
  let toc: TocEntry[] = [];
  let spineItems: SpineItem[] = [];
  let currentLocator: Locator | null = null;
  let tocExpandedState: TocExpandedState = [];
  let currentChapter: string | null = null;

  // Search state
  let searchResults: Map<string, SearchResult[]> = new Map();
  let searchLoading = false;
  let searchIndexReady = false;
  let searchIndexProgress = 0;
  let searchIndexTotal = 0;

  // Subscribe to sidebar store
  const unsubscribeSidebar = sidebarStore.subscribe(state => {
    activeTab = state.activeTab;
    searchQuery = state.searchQuery;
    showSearch = state.showSearch;

    // Check if book changed
    const bookChanged = activeBookId !== state.activeBookId;

    activeBookId = state.activeBookId;
    activeBookPath = state.activeBookPath;
    activeBookTitle = state.activeBookTitle;

    // Load data for the active book
    if (activeBookId) {
      loadBookData(activeBookId);
      // Reset images loaded flag when book changes to force re-extraction
      if (bookChanged) {
        imagesLoadedForBook = null;
        bookImages = [];
      }
    } else {
      clearData();
    }
  });

  // Subscribe to highlight service for live updates
  // Set up once in onMount - persists for component lifetime
  let unsubscribeHighlights: (() => void) | null = null;

  onMount(() => {
    // Subscribe to highlight store once on mount
    // The subscription reads activeBookId fresh from sidebarStore each time
    if (plugin.highlightService) {
      const store = plugin.highlightService.getStore();
      unsubscribeHighlights = store.subscribe((state) => {
        // Read activeBookId fresh from store to avoid stale closure
        const bookId = sidebarStore.getValue().activeBookId;
        if (bookId) {
          highlights = state.highlights[bookId] || [];
        }
      });
    }
  });

  function loadBookData(bookId: string) {
    // Load highlights synchronously for immediate display
    if (plugin.highlightService) {
      highlights = plugin.highlightService.getHighlights(bookId);
    }
    if (plugin.bookmarkService) {
      const artifacts = plugin.bookmarkService.getBookArtifacts(bookId);
      bookmarks = artifacts.bookmarks;
      notes = artifacts.notes;
    }
  }

  function clearData() {
    highlights = [];
    bookmarks = [];
    notes = [];
    bookImages = [];
    imagesLoadedForBook = null;
    toc = [];
    spineItems = [];
    currentLocator = null;
    tocExpandedState = [];
    currentChapter = null;
  }

  function getTocCount(entries: TocEntry[]): number {
    let count = entries.length;
    for (const entry of entries) {
      count += getTocCount(entry.children);
    }
    return count;
  }

  // Extract images when images tab is selected
  $: if (activeTab === 'images' && activeBookId && imagesLoadedForBook !== activeBookId) {
    extractBookImages();
  }

  async function extractBookImages(retryCount = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 500;

    if (!activeBookPath) {
      bookImages = [];
      return;
    }

    imagesLoading = true;
    const currentBookId = activeBookId;

    try {
      // Find the reader view for this book and get images from its provider
      const leaves = plugin.app.workspace.getLeavesOfType('amnesia-reader');
      let readerView: any = null;

      for (const leaf of leaves) {
        const view = leaf.view as any;
        if (view.bookPath === activeBookPath || view.getState?.()?.bookPath === activeBookPath) {
          readerView = view;
          break;
        }
      }

      if (!readerView) {
        console.warn('[Sidebar] No reader view found for image extraction');
        // Retry if reader view not found yet
        if (retryCount < MAX_RETRIES) {
          setTimeout(() => extractBookImages(retryCount + 1), RETRY_DELAY);
          return;
        }
        bookImages = [];
        imagesLoading = false;
        return;
      }

      // Get images from the reader's provider
      const imageItems: BookImage[] = await readerView.getBookImages();

      // Only update if we're still on the same book
      if (currentBookId === activeBookId) {
        // If no images found and we haven't exhausted retries, try again
        // (provider might not be ready yet)
        if (imageItems.length === 0 && retryCount < MAX_RETRIES) {
          console.log(`[Sidebar] No images found, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
          setTimeout(() => extractBookImages(retryCount + 1), RETRY_DELAY);
          return;
        }

        bookImages = imageItems;
        imagesLoadedForBook = currentBookId;
      }
    } catch (e) {
      console.error('Failed to extract images:', e);
      // Retry on error
      if (retryCount < MAX_RETRIES) {
        setTimeout(() => extractBookImages(retryCount + 1), RETRY_DELAY);
        return;
      }
      bookImages = [];
    }

    imagesLoading = false;
  }

  function handleSearchInput(event: Event) {
    const target = event.target as HTMLInputElement;
    sidebarStore.setSearchQuery(target.value);
  }

  function clearSearch() {
    sidebarStore.clearSearch();
  }

  function navigateToCfi(cfi: string, text?: string, color?: HighlightColor) {
    if (!activeBookPath) {
      return;
    }
    // Find the reader view and navigate
    const leaves = plugin.app.workspace.getLeavesOfType('amnesia-reader');
    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view.bookPath === activeBookPath || view.getState?.()?.bookPath === activeBookPath) {
        // Use text-based navigation for better accuracy
        if (text) {
          view.navigateToHighlight?.(cfi, text, color);
        } else {
          view.navigateToCfi?.(cfi);
        }
        plugin.app.workspace.revealLeaf(leaf);
        return;
      }
    }
  }

  function deleteHighlight(id: string) {
    if (!activeBookId || !plugin.highlightService) return;
    plugin.highlightService.deleteHighlight(activeBookId, id);
    highlights = plugin.highlightService.getHighlights(activeBookId);

    // Also remove from renderer overlay
    const leaves = plugin.app.workspace.getLeavesOfType('amnesia-reader');
    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view.bookPath === activeBookPath) {
        view.removeHighlight?.(id);
        break;
      }
    }
  }

  function deleteBookmark(id: string) {
    if (!activeBookId || !plugin.bookmarkService) return;
    plugin.bookmarkService.deleteBookmark(activeBookId, id);
    const artifacts = plugin.bookmarkService.getBookArtifacts(activeBookId);
    bookmarks = artifacts.bookmarks;
  }

  function updateBookmark(id: string, name: string) {
    if (!activeBookId || !plugin.bookmarkService) return;
    plugin.bookmarkService.updateBookmark({ id, name });
    const artifacts = plugin.bookmarkService.getBookArtifacts(activeBookId);
    bookmarks = artifacts.bookmarks;
  }

  // Track current bookmark index for prev/next navigation
  let currentBookmarkIndex = -1;

  function navigateToNextBookmark() {
    if (!activeBookPath || bookmarks.length < 2) return;
    const sorted = [...bookmarks].sort((a, b) => (a.pagePercent || 0) - (b.pagePercent || 0));
    currentBookmarkIndex = (currentBookmarkIndex + 1) % sorted.length;
    navigateToCfi(sorted[currentBookmarkIndex].cfi);
  }

  function navigateToPrevBookmark() {
    if (!activeBookPath || bookmarks.length < 2) return;
    const sorted = [...bookmarks].sort((a, b) => (a.pagePercent || 0) - (b.pagePercent || 0));
    currentBookmarkIndex = currentBookmarkIndex <= 0 ? sorted.length - 1 : currentBookmarkIndex - 1;
    navigateToCfi(sorted[currentBookmarkIndex].cfi);
  }

  function deleteNote(id: string) {
    if (!activeBookId || !plugin.bookmarkService) return;
    plugin.bookmarkService.deleteNote(activeBookId, id);
    const artifacts = plugin.bookmarkService.getBookArtifacts(activeBookId);
    notes = artifacts.notes;
  }

  function updateNote(id: string, content: string, tags: string[]) {
    if (!activeBookId || !plugin.bookmarkService) return;
    plugin.bookmarkService.updateNote({ id, content, tags });
    const artifacts = plugin.bookmarkService.getBookArtifacts(activeBookId);
    notes = artifacts.notes;
  }

  function openImagesGallery() {
    if (!activeBookPath) return;
    plugin.openImagesView(activeBookPath, activeBookTitle || 'Book Images');
  }

  function navigateToImage(spineIndex: number, imageHref: string) {
    if (!activeBookPath) return;

    // Find the reader view and navigate to the chapter containing the image
    const leaves = plugin.app.workspace.getLeavesOfType('amnesia-reader');
    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view.bookPath === activeBookPath || view.getState?.()?.bookPath === activeBookPath) {
        // Navigate to the spine index (chapter) containing the image
        view.navigateToChapter?.(spineIndex);
        plugin.app.workspace.revealLeaf(leaf);
        return;
      }
    }
  }

  function handleOpenLightbox(index: number, images: BookImage[]) {
    lightboxStartIndex = index;
    lightboxOpen = true;
  }

  function closeLightbox() {
    lightboxOpen = false;
  }

  function navigateToTocEntry(href: string) {
    if (!activeBookPath) return;

    // Find the reader view and navigate
    const leaves = plugin.app.workspace.getLeavesOfType('amnesia-reader');
    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view.bookPath === activeBookPath || view.getState?.()?.bookPath === activeBookPath) {
        view.navigateToHref?.(href);
        plugin.app.workspace.revealLeaf(leaf);
        return;
      }
    }
  }

  // Method to update ToC from reader
  export function setToc(entries: TocEntry[], spine?: SpineItem[], initialExpandedState?: TocExpandedState) {
    toc = entries;
    if (spine) {
      spineItems = spine;
    }
    if (initialExpandedState) {
      tocExpandedState = initialExpandedState;
    }
  }

  export function setCurrentChapter(chapter: string | null) {
    currentChapter = chapter;
  }

  // Method to update current location from reader (for progress tracking)
  export function updateLocation(locator: Locator) {
    currentLocator = locator;
    // Also update currentChapter for backward compatibility
    if (locator.href) {
      currentChapter = locator.href;
    }
  }

  // Handle save of TOC expanded state
  function handleSaveTocExpandedState(state: TocExpandedState) {
    tocExpandedState = state;
    // Save to book settings if we have an active book
    if (activeBookId && plugin.bookSettingsStore) {
      plugin.bookSettingsStore.updateBookSettings(activeBookId, {
        tocExpandedState: state,
      });
    }
  }

  // Search methods
  function handleSearch(query: string) {
    const searchIndex = getSearchIndex();
    if (!searchIndex.ready) return;

    searchLoading = true;
    // Use setTimeout to allow UI to update
    setTimeout(() => {
      searchResults = searchIndex.searchGrouped(query);
      searchLoading = false;
    }, 0);
  }

  function clearSearchResults() {
    searchResults = new Map();
  }

  function navigateToSearchResult(spineIndex: number, text: string) {
    if (!activeBookPath) return;

    // Find the reader view and navigate
    const leaves = plugin.app.workspace.getLeavesOfType('amnesia-reader');
    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view.bookPath === activeBookPath || view.getState?.()?.bookPath === activeBookPath) {
        // Navigate to the chapter and then find the text
        view.navigateToChapterAndText?.(spineIndex, text);
        plugin.app.workspace.revealLeaf(leaf);
        return;
      }
    }
  }

  // Export methods to update search index state from reader
  export function updateSearchIndexState(ready: boolean, progress: number, total: number) {
    searchIndexReady = ready;
    searchIndexProgress = progress;
    searchIndexTotal = total;
  }

  // Calculate total search results count
  $: totalSearchResults = Array.from(searchResults.values()).reduce((sum, arr) => sum + arr.length, 0);

  function handleExportData() {
    // Export notes functionality - can be implemented later
    console.log('Export notes requested');
  }

  function handleToggleFilter() {
    // Filter by highlight color - can be implemented later
    console.log('Toggle filter requested');
  }

  onDestroy(() => {
    unsubscribeSidebar();
    if (unsubscribeHighlights) {
      unsubscribeHighlights();
    }
  });

  // Filter items by search query
  $: filteredHighlights = searchQuery
    ? highlights.filter(h =>
        h.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
        h.annotation?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        h.chapter?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : highlights;

  $: filteredBookmarks = searchQuery
    ? bookmarks.filter(b =>
        b.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        b.chapter?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : bookmarks;

  $: filteredNotes = searchQuery
    ? notes.filter(n =>
        n.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
        n.chapter?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        n.tags?.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : notes;

  $: hasActiveBook = !!activeBookId;
</script>

<div class="book-sidebar">
  <!-- Header row: ViewModeSwitcher + Controls (right-aligned) -->
  <div class="sidebar-header">
    <ViewModeSwitcher
      searchResultsCount={totalSearchResults}
      tocCount={getTocCount(toc)}
      highlightsCount={highlights.length}
      bookmarksCount={bookmarks.length}
      notesCount={notes.length}
    />
    {#if activeBookTitle}
      <div class="book-title-inline">
        <span class="book-title">{activeBookTitle}</span>
      </div>
    {/if}
    {#if hasActiveBook && activeTab !== 'search'}
      <div class="header-controls">
        <ControlsBar
          {activeTab}
          {showSearch}
          {hasActiveBook}
          on:exportData={handleExportData}
          on:toggleFilter={handleToggleFilter}
        />
      </div>
    {/if}
  </div>

  <!-- Expanded panels (filter search for highlights/bookmarks/notes) -->
  {#if showSearch && hasActiveBook && activeTab !== 'search'}
    <div class="expanded-panel search-row">
      <div class="search-input-container global-search-input-container">
        <input
          type="search"
          enterkeyhint="search"
          spellcheck="false"
          placeholder="Filter {activeTab}..."
          value={searchQuery}
          on:input={handleSearchInput}
        />
        {#if searchQuery}
          <div class="search-input-clear-button" on:click={clearSearch} on:keydown={(e) => e.key === 'Enter' && clearSearch()} role="button" tabindex="0" aria-label="Clear search"></div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Content -->
  <div class="sidebar-content">
    {#if !activeBookId}
      <div class="empty-state">
        <BookOpen size={48} strokeWidth={1} />
        <p>No book selected</p>
        <p class="hint">Open a book to view its highlights, bookmarks, and notes</p>
      </div>
    {:else if activeTab === 'search'}
      <SearchTab
        results={searchResults}
        loading={searchLoading}
        indexReady={searchIndexReady}
        indexProgress={searchIndexProgress}
        indexTotal={searchIndexTotal}
        on:search={(e) => handleSearch(e.detail.query)}
        on:navigate={(e) => navigateToSearchResult(e.detail.spineIndex, e.detail.text)}
        on:clear={clearSearchResults}
      />
    {:else if activeTab === 'toc'}
      <TocTab
        {toc}
        {spineItems}
        currentLocator={currentLocator}
        initialExpandedState={tocExpandedState}
        onSaveExpandedState={handleSaveTocExpandedState}
        on:navigate={(e) => navigateToTocEntry(e.detail.href)}
      />
    {:else if activeTab === 'highlights'}
      <HighlightsTab
        highlights={filteredHighlights}
        on:navigate={(e) => navigateToCfi(e.detail.cfi, e.detail.text, e.detail.color)}
        on:delete={(e) => deleteHighlight(e.detail.id)}
      />
    {:else if activeTab === 'bookmarks'}
      <BookmarksTab
        bookmarks={filteredBookmarks}
        on:navigate={(e) => navigateToCfi(e.detail.cfi)}
        on:delete={(e) => deleteBookmark(e.detail.id)}
        on:update={(e) => updateBookmark(e.detail.id, e.detail.name)}
        on:navigatePrev={navigateToPrevBookmark}
        on:navigateNext={navigateToNextBookmark}
      />
    {:else if activeTab === 'notes'}
      <NotesTab
        notes={filteredNotes}
        on:navigate={(e) => navigateToCfi(e.detail.cfi)}
        on:delete={(e) => deleteNote(e.detail.id)}
        on:update={(e) => updateNote(e.detail.id, e.detail.content, e.detail.tags)}
      />
    {:else if activeTab === 'images'}
      <ImagesTab
        images={bookImages}
        loading={imagesLoading}
        on:navigate={(e) => navigateToImage(e.detail.spineIndex, e.detail.imageHref)}
        on:openLightbox={(e) => handleOpenLightbox(e.detail.index, e.detail.images)}
      />
    {/if}
  </div>
</div>

<!-- Image Lightbox -->
<ImageLightbox
  images={bookImages}
  startIndex={lightboxStartIndex}
  open={lightboxOpen}
  on:close={closeLightbox}
/>

<style>
  .book-sidebar {
    height: 100%;
    display: flex;
    flex-direction: column;
    /* No background - inherit from Obsidian's default leaf styling */
    color: var(--text-normal);
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    padding: 0 8px;
    margin: 0;
    gap: 8px;
    height: 32px;
    flex-shrink: 0;
    position: relative;
    z-index: 10;
  }

  .header-controls {
    margin-left: auto;
    display: flex;
    align-items: center;
  }

  /* Book title styles are in global styles.css for :has() selector support */
  .book-title {
    font-size: var(--font-ui-small);
    font-weight: 500;
    color: var(--text-muted);
  }

  .controls-row {
    padding: 0 6px 4px;
    flex-shrink: 0;
  }

  /* Expanded panel inherits from Obsidian's .search-row class */
  .expanded-panel {
    padding-left: 6px;
    padding-right: 6px;
  }

  .sidebar-content {
    flex: 1;
    overflow-y: auto;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 48px 24px;
    color: var(--text-muted);
  }

  .empty-state p {
    margin: 8px 0 0;
    font-size: var(--font-ui-small);
  }

  .empty-state .hint {
    font-size: var(--font-ui-smaller);
    opacity: 0.7;
    max-width: 200px;
  }
</style>

<script lang="ts">
  /**
   * Search Tab Component
   *
   * Full-text search for book content, replicating Obsidian's search UI exactly.
   * Uses Obsidian's native CSS classes for perfect visual integration.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type { SearchResult } from '../../reader/search-index';

  export let results: Map<string, SearchResult[]> = new Map();
  export let loading = false;
  export let indexReady = false;
  export let indexProgress = 0;
  export let indexTotal = 0;

  const dispatch = createEventDispatcher<{
    search: { query: string };
    navigate: { spineIndex: number; text: string };
    clear: void;
  }>();

  let query = '';
  let expandedChapters = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Search options
  let matchCase = false;
  let showSettings = false;
  let collapseResults = false;
  let showMoreContext = false;

  // Sort options
  type SortOption = 'occurrence' | 'alphabetical' | 'alphabeticalReverse';
  let sortBy: SortOption = 'occurrence';

  // Auto-expand all chapters with results
  $: if (results.size > 0 && !collapseResults) {
    expandedChapters = new Set(results.keys());
  } else if (collapseResults) {
    expandedChapters = new Set();
  }

  $: totalResults = Array.from(results.values()).reduce((sum, arr) => sum + arr.length, 0);

  // Sort results based on sort option
  $: sortedResults = sortResults(results, sortBy);

  function sortResults(resultsMap: Map<string, SearchResult[]>, sort: SortOption): [string, SearchResult[]][] {
    const entries = Array.from(resultsMap.entries());
    switch (sort) {
      case 'alphabetical':
        return entries.sort((a, b) => a[0].localeCompare(b[0]));
      case 'alphabeticalReverse':
        return entries.sort((a, b) => b[0].localeCompare(a[0]));
      default: // occurrence order
        return entries;
    }
  }

  function handleInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (query.trim().length >= 2) {
        dispatch('search', { query: query.trim() });
      } else if (query.trim().length === 0) {
        dispatch('clear');
      }
    }, 300);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (query.trim().length >= 2) {
        dispatch('search', { query: query.trim() });
      }
    }
  }

  function clearSearch() {
    query = '';
    dispatch('clear');
  }

  function toggleChapter(chapter: string) {
    if (expandedChapters.has(chapter)) {
      expandedChapters.delete(chapter);
    } else {
      expandedChapters.add(chapter);
    }
    expandedChapters = expandedChapters;
  }

  function navigateToResult(result: SearchResult) {
    dispatch('navigate', { spineIndex: result.spineIndex, text: result.text });
  }

  function toggleMatchCase() {
    matchCase = !matchCase;
  }

  function toggleSettings() {
    showSettings = !showSettings;
  }

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });
</script>

<div class="search-tab">
  <!-- Search row (matches Obsidian's .search-row) -->
  <div class="search-row">
    <div class="search-input-container global-search-input-container">
      <input
        enterkeyhint="search"
        type="search"
        spellcheck="false"
        placeholder="Search in book..."
        bind:value={query}
        on:input={handleInput}
        on:keydown={handleKeydown}
        disabled={!indexReady}
      />
      {#if query}
        <div
          class="search-input-clear-button"
          aria-label="Clear search"
          on:click={clearSearch}
          on:keydown={(e) => e.key === 'Enter' && clearSearch()}
          role="button"
          tabindex="0"
        ></div>
      {/if}
      <div
        class="input-right-decorator clickable-icon"
        class:is-active={matchCase}
        aria-label="Match case"
        on:click={toggleMatchCase}
        on:keydown={(e) => e.key === 'Enter' && toggleMatchCase()}
        role="button"
        tabindex="0"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon uppercase-lowercase-a">
          <path d="M10.5 14L4.5 14"></path>
          <path d="M12.5 18L7.5 6"></path>
          <path d="M3 18L7.5 6"></path>
          <path d="M15.9526 10.8322C15.9526 10.8322 16.6259 10 18.3832 10C20.1406 9.99999 20.9986 11.0587 20.9986 11.9682V16.7018C20.9986 17.1624 21.2815 17.7461 21.7151 18"></path>
          <path d="M20.7151 13.5C18.7151 13.5 15.7151 14.2837 15.7151 16C15.7151 17.7163 17.5908 18.2909 18.7151 18C19.5635 17.7804 20.5265 17.3116 20.889 16.6199"></path>
        </svg>
      </div>
    </div>
    <div
      class="clickable-icon"
      class:is-active={showSettings}
      aria-label="Search settings"
      on:click={toggleSettings}
      on:keydown={(e) => e.key === 'Enter' && toggleSettings()}
      role="button"
      tabindex="0"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-sliders-horizontal">
        <path d="M10 5H3"></path>
        <path d="M12 19H3"></path>
        <path d="M14 3v4"></path>
        <path d="M16 17v4"></path>
        <path d="M21 12h-9"></path>
        <path d="M21 19h-5"></path>
        <path d="M21 5h-7"></path>
        <path d="M8 10v4"></path>
        <path d="M8 12H3"></path>
      </svg>
    </div>
  </div>

  <!-- Index progress indicator -->
  {#if !indexReady && indexTotal > 0}
    <div class="search-info-container">
      <div class="search-info-text">
        Indexing book... {indexProgress}/{indexTotal}
      </div>
      <div class="search-progress-bar">
        <div class="search-progress-fill" style="width: {(indexProgress / indexTotal) * 100}%"></div>
      </div>
    </div>
  {:else if !indexReady}
    <div class="search-info-container">
      <div class="search-info-text">Open a book to enable search</div>
    </div>
  {/if}

  <!-- Search params (settings panel) -->
  {#if showSettings}
    <div class="search-params">
      <div class="setting-item mod-toggle">
        <div class="setting-item-info">
          <div class="setting-item-name">Collapse results</div>
          <div class="setting-item-description"></div>
        </div>
        <div class="setting-item-control">
          <label class="checkbox-container" tabindex="0">
            <input type="checkbox" tabindex="0" bind:checked={collapseResults} />
          </label>
        </div>
      </div>
      <div class="setting-item mod-toggle">
        <div class="setting-item-info">
          <div class="setting-item-name">Show more context</div>
          <div class="setting-item-description"></div>
        </div>
        <div class="setting-item-control">
          <label class="checkbox-container" tabindex="0">
            <input type="checkbox" tabindex="0" bind:checked={showMoreContext} />
          </label>
        </div>
      </div>
    </div>
  {/if}

  <!-- Search results info bar -->
  {#if totalResults > 0}
    <div class="search-results-info">
      <div class="clickable-icon search-results-result-count">
        <span>{totalResults} {totalResults === 1 ? 'result' : 'results'}</span>
      </div>
      <select class="dropdown" bind:value={sortBy}>
        <option value="occurrence">Chapter order</option>
        <option value="alphabetical">Chapter name (A to Z)</option>
        <option value="alphabeticalReverse">Chapter name (Z to A)</option>
      </select>
    </div>
  {/if}

  <!-- Search result container -->
  <div class="search-result-container mod-global-search">
    {#if loading}
      <div class="search-empty-state">
        <div class="los-libros-spinner"></div>
        Searching...
      </div>
    {:else if query.length >= 2 && results.size === 0}
      <div class="search-empty-state">No matches found.</div>
    {:else if results.size > 0}
      <div class="search-results-children">
        {#each sortedResults as [chapter, chapterResults] (chapter)}
          <div class="tree-item search-result" class:is-collapsed={!expandedChapters.has(chapter)}>
            <div
              class="tree-item-self search-result-file-title is-clickable"
              on:click={() => toggleChapter(chapter)}
              on:keydown={(e) => e.key === 'Enter' && toggleChapter(chapter)}
              role="button"
              tabindex="0"
            >
              <div class="tree-item-icon collapse-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon right-triangle">
                  <path d="M3 8L12 17L21 8"></path>
                </svg>
              </div>
              <div class="tree-item-inner">{chapter}</div>
              <div class="tree-item-flair-outer">
                <span class="tree-item-flair">{chapterResults.length}</span>
              </div>
            </div>

            {#if expandedChapters.has(chapter)}
              <div class="search-result-file-matches">
                {#each chapterResults as result (result.id)}
                  <div
                    class="search-result-file-match tappable"
                    role="button"
                    tabindex="0"
                    on:click={() => navigateToResult(result)}
                    on:keydown={(e) => e.key === 'Enter' && navigateToResult(result)}
                  >
                    <span class="search-result-file-match-text">
                      {#if showMoreContext}
                        {result.contextBefore.slice(-60)}<span class="search-result-file-matched-text">{result.text}</span>{result.contextAfter.slice(0, 60)}
                      {:else}
                        {result.contextBefore}<span class="search-result-file-matched-text">{result.text}</span>{result.contextAfter}
                      {/if}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else if !indexReady}
      <!-- Empty state when index not ready - already shown above -->
    {:else}
      <div class="search-empty-state">
        Enter a search term to find text in the book.
      </div>
    {/if}
  </div>
</div>

<style>
  .search-tab {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  /*
   * Obsidian Native Classes - NO custom styling
   * These classes inherit from Obsidian's CSS:
   * .search-row, .search-input-container, .global-search-input-container,
   * .search-input-clear-button, .input-right-decorator, .clickable-icon
   */

  /* Only add is-active state for our toggle */
  .input-right-decorator.is-active,
  .clickable-icon.is-active {
    color: var(--interactive-accent);
  }

  /* Disabled input state */
  .search-input-container input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Search info container - custom element */
  .search-info-container {
    padding: 4px 8px;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .search-info-text {
    margin-bottom: 4px;
  }

  .search-progress-bar {
    height: 3px;
    background: var(--background-modifier-border);
    border-radius: 2px;
    overflow: hidden;
  }

  .search-progress-fill {
    height: 100%;
    background: var(--interactive-accent);
    transition: width 0.2s ease;
  }

  /* Search params (settings) - custom element */
  .search-params {
    padding: 4px 8px;
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .setting-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
  }

  .setting-item-name {
    font-size: var(--font-ui-small);
    color: var(--text-normal);
  }

  /* Search results info bar - custom element */
  .search-results-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .search-results-result-count {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .dropdown {
    font-size: var(--font-ui-smaller);
    padding: 2px 4px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-primary);
    color: var(--text-normal);
  }

  /* Search result container */
  .search-result-container {
    flex: 1;
    overflow-y: auto;
  }

  .search-results-children {
    padding: 4px 0;
  }

  .search-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
    gap: 8px;
  }

  /* Tree item styles (matching Obsidian) */
  .tree-item.is-collapsed .collapse-icon {
    transform: rotate(-90deg);
  }

  .collapse-icon {
    transition: transform 100ms ease-in-out;
  }

  .collapse-icon .svg-icon {
    width: 18px;
    height: 18px;
  }

  /* Search result file match */
  .search-result-file-match {
    padding: 4px 8px 4px 32px;
    cursor: pointer;
    font-size: var(--font-ui-small);
    line-height: 1.4;
  }

  .search-result-file-match:hover {
    background: var(--background-modifier-hover);
  }

  .search-result-file-match-text {
    color: var(--text-muted);
  }

  .search-result-file-matched-text {
    color: var(--text-normal);
    font-weight: 600;
    background: var(--text-highlight-bg);
    padding: 0 2px;
    border-radius: 2px;
  }

  /* Spinner */
  .los-libros-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--background-modifier-border);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>

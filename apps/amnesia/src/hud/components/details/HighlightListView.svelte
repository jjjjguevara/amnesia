<script lang="ts">
  /**
   * Highlight List View
   *
   * Filterable and sortable list of highlights for a book.
   * Features:
   * - Filter by color
   * - Filter by has note
   * - Sort by date, color, position
   * - Truncated text preview
   */

  import { createEventDispatcher } from 'svelte';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';
  import type { DetailViewState } from '../../types/index';

  export let provider: AmnesiaHUDProvider;
  export let bookId: string;

  const dispatch = createEventDispatcher<{
    navigate: DetailViewState;
  }>();

  // Filter and sort state
  let colorFilter: string | null = null;
  let notesOnlyFilter = false;
  let sortBy: 'date' | 'color' | 'position' = 'date';
  let sortDesc = true;

  // Get highlights
  $: allHighlights = provider.getHighlights(bookId);

  // Apply filters
  $: filteredHighlights = allHighlights.filter(h => {
    if (colorFilter && h.color !== colorFilter) return false;
    if (notesOnlyFilter && !h.annotation) return false;
    return true;
  });

  // Apply sorting
  $: sortedHighlights = [...filteredHighlights].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'date':
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        cmp = aTime - bTime;
        break;
      case 'color':
        cmp = (a.color || 'yellow').localeCompare(b.color || 'yellow');
        break;
      case 'position':
        cmp = (a.position || 0) - (b.position || 0);
        break;
    }
    return sortDesc ? -cmp : cmp;
  });

  // Available colors from highlights
  $: availableColors = [...new Set(allHighlights.map(h => h.color || 'yellow'))];

  // Color labels
  const colorLabels: Record<string, string> = {
    yellow: 'Yellow',
    red: 'Red',
    green: 'Green',
    blue: 'Blue',
    purple: 'Purple',
    orange: 'Orange',
  };

  function toggleColorFilter(color: string) {
    colorFilter = colorFilter === color ? null : color;
  }

  function toggleSort(field: 'date' | 'color' | 'position') {
    if (sortBy === field) {
      sortDesc = !sortDesc;
    } else {
      sortBy = field;
      sortDesc = true;
    }
  }

  function truncateText(text: string, maxLength = 120): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength).trim() + '...';
  }

  function formatDate(date: Date | string | undefined): string {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }
</script>

<div class="highlight-list">
  <!-- Filters -->
  <div class="filters">
    <!-- Color filters -->
    <div class="filter-row">
      <span class="filter-label">Color:</span>
      <div class="color-filters">
        <button
          class="color-btn all"
          class:active={colorFilter === null}
          on:click={() => colorFilter = null}
        >
          All
        </button>
        {#each availableColors as color}
          <button
            class="color-btn color-{color}"
            class:active={colorFilter === color}
            on:click={() => toggleColorFilter(color)}
            title={colorLabels[color] || color}
          >
            <span class="color-dot"></span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Notes filter -->
    <div class="filter-row">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={notesOnlyFilter} />
        <span>With notes only</span>
      </label>
    </div>

    <!-- Sort options -->
    <div class="filter-row">
      <span class="filter-label">Sort:</span>
      <div class="sort-btns">
        <button
          class="sort-btn"
          class:active={sortBy === 'date'}
          on:click={() => toggleSort('date')}
        >
          Date {sortBy === 'date' ? (sortDesc ? '↓' : '↑') : ''}
        </button>
        <button
          class="sort-btn"
          class:active={sortBy === 'position'}
          on:click={() => toggleSort('position')}
        >
          Position {sortBy === 'position' ? (sortDesc ? '↓' : '↑') : ''}
        </button>
        <button
          class="sort-btn"
          class:active={sortBy === 'color'}
          on:click={() => toggleSort('color')}
        >
          Color {sortBy === 'color' ? (sortDesc ? '↓' : '↑') : ''}
        </button>
      </div>
    </div>
  </div>

  <!-- Results count -->
  <div class="results-count">
    {sortedHighlights.length} of {allHighlights.length} highlights
  </div>

  <!-- Highlight list -->
  <div class="highlights">
    {#if sortedHighlights.length === 0}
      <div class="empty-state">
        {#if allHighlights.length === 0}
          No highlights in this book yet
        {:else}
          No highlights match the current filters
        {/if}
      </div>
    {:else}
      {#each sortedHighlights as highlight (highlight.id)}
        <div class="highlight-item color-{highlight.color || 'yellow'}">
          <div class="highlight-color-bar"></div>
          <div class="highlight-content">
            <div class="highlight-text">
              "{truncateText(highlight.text)}"
            </div>
            {#if highlight.annotation}
              <div class="highlight-note">
                💬 {truncateText(highlight.annotation, 80)}
              </div>
            {/if}
            <div class="highlight-meta">
              {#if highlight.chapter}
                <span class="chapter">{highlight.chapter}</span>
              {/if}
              {#if highlight.createdAt}
                <span class="date">{formatDate(highlight.createdAt)}</span>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .highlight-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-3);
  }

  .filters {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-2);
    padding: var(--size-4-2);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
  }

  .filter-row {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
  }

  .filter-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    min-width: 40px;
  }

  .color-filters {
    display: flex;
    gap: var(--size-4-1);
    flex-wrap: wrap;
  }

  .color-btn {
    padding: var(--size-4-1) var(--size-4-2);
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .color-btn:not(.all) {
    padding: var(--size-4-1);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .color-btn.active {
    border-color: var(--interactive-accent);
    background: var(--background-modifier-hover);
  }

  .color-btn .color-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }

  .color-yellow .color-dot { background: #f9d71c; }
  .color-red .color-dot { background: #e74c3c; }
  .color-green .color-dot { background: #2ecc71; }
  .color-blue .color-dot { background: #3498db; }
  .color-purple .color-dot { background: #9b59b6; }
  .color-orange .color-dot { background: #e67e22; }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: var(--size-4-1);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    cursor: pointer;
  }

  .checkbox-label input {
    margin: 0;
  }

  .sort-btns {
    display: flex;
    gap: var(--size-4-1);
  }

  .sort-btn {
    padding: var(--size-4-1) var(--size-4-2);
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .sort-btn.active {
    border-color: var(--interactive-accent);
    color: var(--text-normal);
  }

  .results-count {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }

  .highlights {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-2);
  }

  .empty-state {
    text-align: center;
    padding: var(--size-4-4);
    color: var(--text-muted);
    font-style: italic;
  }

  .highlight-item {
    display: flex;
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    overflow: hidden;
  }

  .highlight-color-bar {
    width: 4px;
    flex-shrink: 0;
  }

  .color-yellow .highlight-color-bar { background: #f9d71c; }
  .color-red .highlight-color-bar { background: #e74c3c; }
  .color-green .highlight-color-bar { background: #2ecc71; }
  .color-blue .highlight-color-bar { background: #3498db; }
  .color-purple .highlight-color-bar { background: #9b59b6; }
  .color-orange .highlight-color-bar { background: #e67e22; }

  .highlight-content {
    flex: 1;
    padding: var(--size-4-2) var(--size-4-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
  }

  .highlight-text {
    font-size: var(--font-ui-small);
    color: var(--text-normal);
    line-height: 1.4;
  }

  .highlight-note {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    padding-left: var(--size-4-2);
    border-left: 2px solid var(--background-modifier-border);
  }

  .highlight-meta {
    display: flex;
    gap: var(--size-4-2);
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }

  .chapter {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }
</style>

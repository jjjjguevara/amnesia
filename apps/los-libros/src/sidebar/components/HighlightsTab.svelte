<script lang="ts">
  /**
   * Highlights Tab Component
   *
   * Displays book highlights grouped by chapter using Obsidian's tree-item pattern.
   */
  import { createEventDispatcher } from 'svelte';
  import type { Highlight, HighlightColor } from '../../library/types';
  import { Trash2 } from 'lucide-svelte';

  export let highlights: Highlight[] = [];

  const dispatch = createEventDispatcher<{
    navigate: { cfi: string; text: string };
    delete: { id: string };
  }>();

  let expandedChapters = new Set<string>();

  // Group highlights by chapter
  $: highlightsByChapter = groupByChapter(highlights);

  // Auto-expand all chapters on load for easier navigation
  $: {
    const allChapters = new Set(highlightsByChapter.keys());
    if (allChapters.size > 0 && expandedChapters.size === 0) {
      expandedChapters = allChapters;
    }
  }

  function groupByChapter(items: Highlight[]): Map<string, Highlight[]> {
    const grouped = new Map<string, Highlight[]>();
    for (const item of items) {
      // Use chapter name, or fall back to page percentage, or "Beginning"
      let chapter = item.chapter;
      if (!chapter || chapter.trim() === '') {
        if (item.pagePercent && item.pagePercent > 0) {
          chapter = `Page ${Math.round(item.pagePercent)}%`;
        } else {
          chapter = 'Beginning';
        }
      }
      if (!grouped.has(chapter)) {
        grouped.set(chapter, []);
      }
      grouped.get(chapter)!.push(item);
    }
    return grouped;
  }

  function toggleChapter(chapter: string) {
    if (expandedChapters.has(chapter)) {
      expandedChapters.delete(chapter);
    } else {
      expandedChapters.add(chapter);
    }
    expandedChapters = expandedChapters;
  }

  function getHighlightColor(color: HighlightColor): string {
    const colors: Record<HighlightColor, string> = {
      yellow: '#fef3c7',
      green: '#d1fae5',
      blue: '#dbeafe',
      pink: '#fce7f3',
      purple: '#ede9fe',
    };
    return colors[color];
  }

  function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  }

  function formatDate(date: Date): string {
    return new Date(date).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }
</script>

<div class="highlights-tab">
  {#if highlights.length === 0}
    <div class="search-empty-state">
      <div class="search-empty-state-message">No highlights yet</div>
      <div class="search-empty-state-hint">Select text while reading to create highlights</div>
    </div>
  {:else}
    <div class="search-results-children">
      {#each [...highlightsByChapter] as [chapter, chapterHighlights] (chapter)}
        <div class="tree-item search-result" class:is-collapsed={!expandedChapters.has(chapter)}>
          <div
            class="tree-item-self search-result-file-title is-clickable"
            on:click={() => toggleChapter(chapter)}
            on:keydown={(e) => e.key === 'Enter' && toggleChapter(chapter)}
            role="button"
            tabindex="0"
          >
            <div class="tree-item-icon collapse-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon right-triangle"><path d="M3 8L12 17L21 8"></path></svg>
            </div>
            <div class="tree-item-inner">{chapter}</div>
            <div class="tree-item-flair-outer">
              <span class="tree-item-flair">{chapterHighlights.length}</span>
            </div>
          </div>

          {#if expandedChapters.has(chapter)}
            <div class="search-result-file-matches">
              {#each chapterHighlights as highlight (highlight.id)}
                <div
                  class="search-result-file-match tappable los-libros-highlight-match"
                  style="border-left: 3px solid {getHighlightColor(highlight.color)};"
                  role="button"
                  tabindex="0"
                  on:click={() => dispatch('navigate', { cfi: highlight.cfi, text: highlight.text })}
                  on:keydown={(e) => e.key === 'Enter' && dispatch('navigate', { cfi: highlight.cfi, text: highlight.text })}
                >
                  <div class="los-libros-highlight-text">
                    "{truncateText(highlight.text, 120)}"
                  </div>
                  {#if highlight.annotation}
                    <div class="los-libros-highlight-note">{truncateText(highlight.annotation, 80)}</div>
                  {/if}
                  <div class="los-libros-highlight-footer">
                    <span class="los-libros-highlight-date">{formatDate(highlight.createdAt)}</span>
                    <button
                      class="los-libros-delete-btn clickable-icon"
                      on:click|stopPropagation={() => dispatch('delete', { id: highlight.id })}
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .highlights-tab {
    display: flex;
    flex-direction: column;
  }

  /* Empty state - matches Obsidian search empty state */
  .search-empty-state {
    text-align: center;
    padding: 32px 16px;
    color: var(--text-muted);
  }

  .search-empty-state-message {
    font-size: var(--font-ui-medium);
    margin-bottom: 4px;
  }

  .search-empty-state-hint {
    font-size: var(--font-ui-smaller);
    opacity: 0.7;
  }

  /* Container styling */
  .search-results-children {
    padding: 8px 16px;
  }

  /* Card list container - override Obsidian defaults */
  .search-result-file-matches {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0;
    margin: 0 !important;
  }

  /* Tree item spacing - match Obsidian search results */
  .tree-item.search-result {
    margin-bottom: 4px;
  }

  /* Tree item collapse icon rotation */
  .tree-item.is-collapsed .collapse-icon {
    transform: rotate(-90deg);
  }

  .collapse-icon {
    transition: transform 100ms ease-in-out;
  }

  /* Highlight card styling - override Obsidian defaults */
  .los-libros-highlight-match {
    display: flex !important;
    flex-direction: column !important;
    gap: 4px !important;
    padding: 10px 12px !important;
    border-radius: 8px;
    margin: 0;
  }

  .los-libros-highlight-text {
    font-size: var(--font-ui-small);
    line-height: 1.4;
    color: var(--text-normal);
    margin: 0;
  }

  .los-libros-highlight-note {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin: 0;
    padding-left: 6px;
    border-left: 2px solid var(--background-modifier-border);
  }

  .los-libros-highlight-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0;
  }

  .los-libros-highlight-date {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .los-libros-delete-btn {
    opacity: 0;
    transition: opacity 0.1s;
  }

  .los-libros-highlight-match:hover .los-libros-delete-btn {
    opacity: 1;
  }

  .los-libros-delete-btn:hover {
    color: var(--text-error);
  }
</style>

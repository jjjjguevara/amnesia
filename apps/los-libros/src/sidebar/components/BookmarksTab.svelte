<script lang="ts">
  /**
   * Bookmarks Tab Component
   *
   * Displays book bookmarks grouped by chapter using Obsidian's tree-item pattern.
   * Features: inline editing, prev/next navigation, delete.
   */
  import { createEventDispatcher } from 'svelte';
  import type { Bookmark } from '../../bookmarks/bookmark-types';
  import { Trash2, Bookmark as BookmarkIcon, ChevronUp, ChevronDown, Pencil, Check, X } from 'lucide-svelte';

  export let bookmarks: Bookmark[] = [];

  const dispatch = createEventDispatcher<{
    navigate: { cfi: string };
    delete: { id: string };
    update: { id: string; name: string };
    navigatePrev: void;
    navigateNext: void;
  }>();

  let expandedChapters = new Set<string>();
  let editingId: string | null = null;
  let editingName = '';

  $: bookmarksByChapter = groupByChapter(bookmarks);
  $: sortedBookmarks = [...bookmarks].sort((a, b) => {
    // Sort by page percent for prev/next navigation
    return (a.pagePercent || 0) - (b.pagePercent || 0);
  });

  // Auto-expand all chapters on load
  $: {
    const allChapters = new Set(bookmarksByChapter.keys());
    if (allChapters.size > 0 && expandedChapters.size === 0) {
      expandedChapters = allChapters;
    }
  }

  function groupByChapter(items: Bookmark[]): Map<string, Bookmark[]> {
    const grouped = new Map<string, Bookmark[]>();
    for (const item of items) {
      let chapter = item.chapter;
      if (!chapter || chapter.trim() === '') {
        if (item.pagePercent && item.pagePercent > 0) {
          chapter = `Page ${Math.round(item.pagePercent)}%`;
        } else {
          chapter = 'Beginning';
        }
      }
      if (!grouped.has(chapter)) grouped.set(chapter, []);
      grouped.get(chapter)!.push(item);
    }
    return grouped;
  }

  function toggleChapter(chapter: string) {
    if (expandedChapters.has(chapter)) expandedChapters.delete(chapter);
    else expandedChapters.add(chapter);
    expandedChapters = expandedChapters;
  }

  function formatDate(date: Date): string {
    return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function startEditing(bookmark: Bookmark, e: Event) {
    e.stopPropagation();
    editingId = bookmark.id;
    editingName = bookmark.name || '';
  }

  function saveEdit(e: Event) {
    e.stopPropagation();
    if (editingId) {
      dispatch('update', { id: editingId, name: editingName });
      editingId = null;
      editingName = '';
    }
  }

  function cancelEdit(e: Event) {
    e.stopPropagation();
    editingId = null;
    editingName = '';
  }

  function handleEditKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      saveEdit(e);
    } else if (e.key === 'Escape') {
      cancelEdit(e);
    }
  }

  function navigatePrev() {
    dispatch('navigatePrev');
  }

  function navigateNext() {
    dispatch('navigateNext');
  }
</script>

<div class="bookmarks-tab">
  {#if bookmarks.length === 0}
    <div class="search-empty-state">
      <div class="search-empty-state-message">No bookmarks yet</div>
      <div class="search-empty-state-hint">Tap the bookmark icon while reading</div>
    </div>
  {:else}
    <!-- Navigation controls -->
    <div class="bookmarks-nav-bar">
      <button
        class="nav-btn clickable-icon"
        on:click={navigatePrev}
        title="Previous bookmark"
        disabled={bookmarks.length < 2}
      >
        <ChevronUp size={16} />
      </button>
      <span class="nav-count">{bookmarks.length} bookmarks</span>
      <button
        class="nav-btn clickable-icon"
        on:click={navigateNext}
        title="Next bookmark"
        disabled={bookmarks.length < 2}
      >
        <ChevronDown size={16} />
      </button>
    </div>

    <div class="search-results-children">
      {#each [...bookmarksByChapter] as [chapter, chapterBookmarks] (chapter)}
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
              <span class="tree-item-flair">{chapterBookmarks.length}</span>
            </div>
          </div>

          {#if expandedChapters.has(chapter)}
            <div class="search-result-file-matches">
              {#each chapterBookmarks as bookmark (bookmark.id)}
                <div
                  class="search-result-file-match tappable los-libros-bookmark-match"
                  role="button"
                  tabindex="0"
                  on:click={() => editingId !== bookmark.id && dispatch('navigate', { cfi: bookmark.cfi })}
                  on:keydown={(e) => e.key === 'Enter' && editingId !== bookmark.id && dispatch('navigate', { cfi: bookmark.cfi })}
                >
                  <div class="los-libros-bookmark-title">
                    <BookmarkIcon size={12} />
                    {#if editingId === bookmark.id}
                      <input
                        type="text"
                        class="inline-edit-input"
                        bind:value={editingName}
                        on:keydown={handleEditKeydown}
                        on:click|stopPropagation
                        placeholder="Bookmark name..."
                        autofocus
                      />
                      <button class="inline-edit-btn save" on:click={saveEdit} title="Save">
                        <Check size={12} />
                      </button>
                      <button class="inline-edit-btn cancel" on:click={cancelEdit} title="Cancel">
                        <X size={12} />
                      </button>
                    {:else}
                      <span class="bookmark-name" on:dblclick={(e) => startEditing(bookmark, e)}>
                        {bookmark.name || 'Unnamed bookmark'}
                      </span>
                    {/if}
                  </div>
                  <div class="los-libros-bookmark-footer">
                    <span class="los-libros-bookmark-date">{formatDate(bookmark.createdAt)}</span>
                    <div class="bookmark-actions">
                      {#if editingId !== bookmark.id}
                        <button
                          class="los-libros-action-btn clickable-icon"
                          on:click|stopPropagation={(e) => startEditing(bookmark, e)}
                          title="Edit name"
                        >
                          <Pencil size={12} />
                        </button>
                      {/if}
                      <button
                        class="los-libros-delete-btn clickable-icon"
                        on:click|stopPropagation={() => dispatch('delete', { id: bookmark.id })}
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
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
  .bookmarks-tab {
    display: flex;
    flex-direction: column;
  }

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

  .bookmarks-nav-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--background-modifier-border);
    margin-bottom: 4px;
  }

  .nav-btn {
    padding: 4px;
    border-radius: var(--radius-s);
  }

  .nav-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .nav-count {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .tree-item.is-collapsed .collapse-icon {
    transform: rotate(-90deg);
  }

  .collapse-icon {
    transition: transform 100ms ease-in-out;
  }

  .los-libros-bookmark-match {
    padding: 8px 10px;
    border-radius: var(--radius-s);
    margin: 2px 0;
    border-left: 3px solid var(--interactive-accent);
  }

  .los-libros-bookmark-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--font-ui-small);
    font-weight: 500;
    color: var(--text-normal);
  }

  .bookmark-name {
    flex: 1;
    cursor: text;
  }

  .bookmark-name:hover {
    text-decoration: underline;
    text-decoration-style: dotted;
  }

  .inline-edit-input {
    flex: 1;
    padding: 2px 6px;
    border: 1px solid var(--interactive-accent);
    border-radius: var(--radius-s);
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    outline: none;
  }

  .inline-edit-btn {
    padding: 2px;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: var(--radius-s);
  }

  .inline-edit-btn.save {
    color: var(--text-success, #4ade80);
  }

  .inline-edit-btn.cancel {
    color: var(--text-error);
  }

  .inline-edit-btn:hover {
    background: var(--background-modifier-hover);
  }

  .los-libros-bookmark-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }

  .los-libros-bookmark-date {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .bookmark-actions {
    display: flex;
    gap: 4px;
  }

  .los-libros-action-btn,
  .los-libros-delete-btn {
    opacity: 0;
    transition: opacity 0.1s;
  }

  .los-libros-bookmark-match:hover .los-libros-action-btn,
  .los-libros-bookmark-match:hover .los-libros-delete-btn {
    opacity: 1;
  }

  .los-libros-delete-btn:hover {
    color: var(--text-error);
  }
</style>

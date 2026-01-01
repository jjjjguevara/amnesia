<script lang="ts">
  /**
   * Notes Tab Component
   *
   * Displays reading notes grouped by chapter using Obsidian's tree-item pattern.
   * Features: inline editing, linked highlights display.
   */
  import { createEventDispatcher } from 'svelte';
  import type { ReadingNote } from '../../bookmarks/bookmark-types';
  import { Trash2, StickyNote, Pencil, Check, X } from 'lucide-svelte';

  export let notes: ReadingNote[] = [];

  const dispatch = createEventDispatcher<{
    navigate: { cfi: string };
    delete: { id: string };
    update: { id: string; content: string; tags: string[] };
  }>();

  let expandedChapters = new Set<string>();
  let editingId: string | null = null;
  let editingContent = '';
  let editingTags = '';

  $: notesByChapter = groupByChapter(notes);

  // Auto-expand all chapters on load
  $: {
    const allChapters = new Set(notesByChapter.keys());
    if (allChapters.size > 0 && expandedChapters.size === 0) {
      expandedChapters = allChapters;
    }
  }

  function groupByChapter(items: ReadingNote[]): Map<string, ReadingNote[]> {
    const grouped = new Map<string, ReadingNote[]>();
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

  function truncateText(text: string, max: number): string {
    return text.length <= max ? text : text.slice(0, max) + '...';
  }

  function formatDate(date: Date): string {
    return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function startEditing(note: ReadingNote, e: Event) {
    e.stopPropagation();
    editingId = note.id;
    editingContent = note.content;
    editingTags = (note.tags || []).join(', ');
  }

  function saveEdit(e: Event) {
    e.stopPropagation();
    if (editingId) {
      const tags = editingTags
        .split(',')
        .map(t => t.trim().replace(/^#/, ''))
        .filter(t => t.length > 0);
      dispatch('update', { id: editingId, content: editingContent, tags });
      editingId = null;
      editingContent = '';
      editingTags = '';
    }
  }

  function cancelEdit(e: Event) {
    e.stopPropagation();
    editingId = null;
    editingContent = '';
    editingTags = '';
  }

  function handleEditKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      cancelEdit(e);
    }
    // Allow Enter for newlines in textarea, use Ctrl/Cmd+Enter to save
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      saveEdit(e);
    }
  }
</script>

<div class="notes-tab">
  {#if notes.length === 0}
    <div class="search-empty-state">
      <div class="search-empty-state-message">No notes yet</div>
      <div class="search-empty-state-hint">Add notes from the highlight popup</div>
    </div>
  {:else}
    <div class="search-results-children">
      {#each [...notesByChapter] as [chapter, chapterNotes] (chapter)}
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
              <span class="tree-item-flair">{chapterNotes.length}</span>
            </div>
          </div>

          {#if expandedChapters.has(chapter)}
            <div class="search-result-file-matches">
              {#each chapterNotes as note (note.id)}
                <div
                  class="search-result-file-match tappable los-libros-note-match"
                  role="button"
                  tabindex="0"
                  on:click={() => editingId !== note.id && dispatch('navigate', { cfi: note.cfi })}
                  on:keydown={(e) => e.key === 'Enter' && editingId !== note.id && dispatch('navigate', { cfi: note.cfi })}
                >
                  {#if editingId === note.id}
                    <!-- Edit mode -->
                    <div class="note-edit-form" on:click|stopPropagation>
                      <textarea
                        class="note-edit-textarea"
                        bind:value={editingContent}
                        on:keydown={handleEditKeydown}
                        placeholder="Note content..."
                        rows="3"
                      />
                      <input
                        type="text"
                        class="note-edit-tags"
                        bind:value={editingTags}
                        placeholder="Tags (comma separated)"
                      />
                      <div class="note-edit-actions">
                        <span class="note-edit-hint">Ctrl+Enter to save</span>
                        <button class="inline-edit-btn save" on:click={saveEdit} title="Save">
                          <Check size={14} /> Save
                        </button>
                        <button class="inline-edit-btn cancel" on:click={cancelEdit} title="Cancel">
                          <X size={14} /> Cancel
                        </button>
                      </div>
                    </div>
                  {:else}
                    <!-- View mode -->
                    <div class="los-libros-note-title">
                      <StickyNote size={12} />
                      <span>{truncateText(note.content, 120)}</span>
                    </div>
                    {#if note.tags && note.tags.length > 0}
                      <div class="los-libros-note-tags">
                        {#each note.tags as tag}<span class="los-libros-tag">#{tag}</span>{/each}
                      </div>
                    {/if}
                    <div class="los-libros-note-footer">
                      <span class="los-libros-note-date">{formatDate(note.createdAt)}</span>
                      <div class="note-actions">
                        <button
                          class="los-libros-action-btn clickable-icon"
                          on:click|stopPropagation={(e) => startEditing(note, e)}
                          title="Edit note"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          class="los-libros-delete-btn clickable-icon"
                          on:click|stopPropagation={() => dispatch('delete', { id: note.id })}
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  {/if}
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
  .notes-tab {
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

  .tree-item.is-collapsed .collapse-icon {
    transform: rotate(-90deg);
  }

  .collapse-icon {
    transition: transform 100ms ease-in-out;
  }

  .los-libros-note-match {
    padding: 8px 10px;
    border-radius: var(--radius-s);
    margin: 2px 0;
    border-left: 3px solid var(--text-accent);
  }

  .los-libros-note-title {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: var(--font-ui-small);
    line-height: 1.4;
    color: var(--text-normal);
  }

  .los-libros-note-title :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
  }

  .los-libros-note-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }

  .los-libros-tag {
    font-size: var(--font-ui-smaller);
    padding: 1px 6px;
    background: var(--background-modifier-border);
    border-radius: 4px;
    color: var(--text-muted);
  }

  .los-libros-note-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 6px;
  }

  .los-libros-note-date {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .note-actions {
    display: flex;
    gap: 4px;
  }

  .los-libros-action-btn,
  .los-libros-delete-btn {
    opacity: 0;
    transition: opacity 0.1s;
  }

  .los-libros-note-match:hover .los-libros-action-btn,
  .los-libros-note-match:hover .los-libros-delete-btn {
    opacity: 1;
  }

  .los-libros-delete-btn:hover {
    color: var(--text-error);
  }

  /* Edit form styles */
  .note-edit-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .note-edit-textarea {
    width: 100%;
    padding: 8px;
    border: 1px solid var(--interactive-accent);
    border-radius: var(--radius-s);
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    font-family: inherit;
    resize: vertical;
    min-height: 60px;
  }

  .note-edit-textarea:focus {
    outline: none;
    box-shadow: 0 0 0 2px var(--interactive-accent-hover);
  }

  .note-edit-tags {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-smaller);
  }

  .note-edit-tags:focus {
    outline: none;
    border-color: var(--interactive-accent);
  }

  .note-edit-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-end;
  }

  .note-edit-hint {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin-right: auto;
  }

  .inline-edit-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: none;
    border-radius: var(--radius-s);
    cursor: pointer;
    font-size: var(--font-ui-smaller);
  }

  .inline-edit-btn.save {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .inline-edit-btn.save:hover {
    filter: brightness(1.1);
  }

  .inline-edit-btn.cancel {
    background: var(--background-modifier-border);
    color: var(--text-muted);
  }

  .inline-edit-btn.cancel:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }
</style>

<script lang="ts">
  /**
   * Author Bibliography View
   *
   * Shows all books by an author with:
   * - Author summary stats
   * - Book list grouped by series
   * - Quick navigation to individual books
   */

  import { createEventDispatcher } from 'svelte';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';
  import type { DetailViewState } from '../../types/index';
  import type { Book } from '../../../library/types';
  import ProgressBar from '../charts/ProgressBar.svelte';

  export let provider: AmnesiaHUDProvider;
  export let authorName: string;

  const dispatch = createEventDispatcher<{
    navigate: DetailViewState;
  }>();

  // Get all books by author using the provider
  $: authorBooks = provider.getBooksByAuthor(authorName);

  // Calculate stats
  $: totalBooks = authorBooks.length;
  $: completedBooks = authorBooks.filter(b => b.status === 'completed').length;
  $: totalHighlights = authorBooks.reduce((sum, book) => {
    return sum + provider.getHighlights(book.id).length;
  }, 0);
  $: completionRate = totalBooks > 0 ? Math.round((completedBooks / totalBooks) * 100) : 0;

  function navigateToBook(book: Book) {
    dispatch('navigate', {
      type: 'book',
      id: book.id,
      title: book.title,
    });
  }

  function getStatusIcon(status: string): string {
    switch (status) {
      case 'completed': return '✓';
      case 'reading': return '📖';
      default: return '○';
    }
  }
</script>

<div class="author-detail">
  <!-- Author Header -->
  <div class="author-header">
    <div class="author-icon">👤</div>
    <div class="author-info">
      <h2 class="author-name">{authorName}</h2>
      <div class="author-meta">
        {totalBooks} book{totalBooks !== 1 ? 's' : ''} in library
      </div>
    </div>
  </div>

  <!-- Stats -->
  <div class="section">
    <h3 class="section-title">Reading Stats</h3>
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-value">{completedBooks}</span>
        <span class="stat-label">Completed</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{totalBooks - completedBooks}</span>
        <span class="stat-label">To Read</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{totalHighlights}</span>
        <span class="stat-label">Highlights</span>
      </div>
    </div>
    <div class="completion-bar">
      <ProgressBar percent={completionRate} width={30} showPercent />
    </div>
  </div>

  <!-- Books -->
  <div class="section">
    <h3 class="section-title">Books</h3>
    {#if authorBooks.length === 0}
      <div class="empty-state">
        <p>No books by this author in your library.</p>
      </div>
    {:else}
      <div class="book-list">
        {#each authorBooks as book}
          <button
            class="book-item"
            on:click={() => navigateToBook(book)}
          >
            <span class="book-title">{book.title}</span>
            <span class="book-status status-{book.status || 'to-read'}">
              {getStatusIcon(book.status || 'to-read')}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .author-detail {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-4);
  }

  .author-header {
    display: flex;
    gap: var(--size-4-3);
  }

  .author-icon {
    font-size: 32px;
    flex-shrink: 0;
  }

  .author-info {
    flex: 1;
    min-width: 0;
  }

  .author-name {
    margin: 0;
    font-size: var(--font-ui-medium);
    font-weight: 600;
    line-height: 1.3;
  }

  .author-meta {
    font-size: var(--font-ui-small);
    color: var(--text-muted);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-2);
  }

  .section-title {
    margin: 0;
    font-size: var(--font-ui-small);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--size-4-2);
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--size-4-2);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
  }

  .stat-value {
    font-size: var(--font-ui-medium);
    font-weight: 600;
    color: var(--text-normal);
  }

  .stat-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }

  .completion-bar {
    padding: var(--size-4-2) 0;
  }

  .empty-state {
    text-align: center;
    padding: var(--size-4-4);
    color: var(--text-muted);
  }

  .empty-state p {
    margin: 0;
  }

  .book-groups {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-3);
  }

  .book-group {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
  }

  .group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--size-4-2);
    background: var(--background-modifier-hover);
    border: none;
    border-radius: var(--radius-s);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.15s ease;
  }

  .group-header:not(.standalone):hover {
    background: var(--background-modifier-active-hover);
  }

  .group-header.standalone {
    cursor: default;
    background: var(--background-secondary);
  }

  .series-name {
    font-size: var(--font-ui-small);
    font-weight: 500;
    color: var(--text-normal);
  }

  .book-count {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }

  .book-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
    padding-left: var(--size-4-3);
  }

  .book-item {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    padding: var(--size-4-2) var(--size-4-3);
    background: var(--background-secondary);
    border: none;
    border-radius: var(--radius-s);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.15s ease;
  }

  .book-item:hover {
    background: var(--background-modifier-hover);
  }

  .book-index {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    min-width: 30px;
    font-family: var(--font-monospace);
  }

  .book-title {
    flex: 1;
    font-size: var(--font-ui-small);
    color: var(--text-normal);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .book-status {
    font-size: var(--font-ui-small);
  }

  .status-completed { color: var(--color-green); }
  .status-reading { color: var(--color-blue); }
  .status-to-read { color: var(--text-faint); }
</style>

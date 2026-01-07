<script lang="ts">
  /**
   * Series Detail View
   *
   * Shows all books in a series with:
   * - Overall series progress
   * - Book list with reading status
   * - Quick navigation to individual books
   */

  import { createEventDispatcher } from 'svelte';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';
  import type { DetailViewState } from '../../types/index';
  import type { Book } from '../../../library/types';
  import ProgressBar from '../charts/ProgressBar.svelte';

  export let provider: AmnesiaHUDProvider;
  export let seriesName: string;

  const dispatch = createEventDispatcher<{
    navigate: DetailViewState;
  }>();

  // Get all books in series/by author using the provider
  $: seriesBooks = provider.getBooksBySeries(seriesName);

  // Calculate series progress
  $: totalBooks = seriesBooks.length;
  $: completedBooks = seriesBooks.filter(b => b.status === 'completed').length;
  $: readingBooks = seriesBooks.filter(b => b.status === 'reading').length;
  $: seriesProgress = totalBooks > 0 ? Math.round((completedBooks / totalBooks) * 100) : 0;

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

  function getStatusClass(status: string): string {
    switch (status) {
      case 'completed': return 'completed';
      case 'reading': return 'reading';
      default: return 'to-read';
    }
  }
</script>

<div class="series-detail">
  <!-- Series Header -->
  <div class="series-header">
    <div class="series-icon">📚</div>
    <div class="series-info">
      <h2 class="series-title">{seriesName}</h2>
      <div class="series-meta">
        {totalBooks} book{totalBooks !== 1 ? 's' : ''} in series
      </div>
    </div>
  </div>

  <!-- Series Progress -->
  <div class="section">
    <h3 class="section-title">Progress</h3>
    <div class="progress-row">
      <ProgressBar percent={seriesProgress} width={30} showPercent />
    </div>
    <div class="progress-stats">
      <div class="stat">
        <span class="stat-value completed">{completedBooks}</span>
        <span class="stat-label">Completed</span>
      </div>
      <div class="stat">
        <span class="stat-value reading">{readingBooks}</span>
        <span class="stat-label">Reading</span>
      </div>
      <div class="stat">
        <span class="stat-value to-read">{totalBooks - completedBooks - readingBooks}</span>
        <span class="stat-label">To Read</span>
      </div>
    </div>
  </div>

  <!-- Book List -->
  <div class="section">
    <h3 class="section-title">Books</h3>
    {#if seriesBooks.length === 0}
      <div class="empty-state">
        <p>No books found in this series.</p>
        <p class="hint">Books will appear here when they have series metadata.</p>
      </div>
    {:else}
      <div class="book-list">
        {#each seriesBooks.sort((a, b) => a.title.localeCompare(b.title)) as book, idx}
          <button
            class="book-item"
            on:click={() => navigateToBook(book)}
          >
            <span class="book-index">
              #{idx + 1}
            </span>
            <span class="book-title">{book.title}</span>
            <span class="book-status {getStatusClass(book.status || 'to-read')}">
              {getStatusIcon(book.status || 'to-read')}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .series-detail {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-4);
  }

  .series-header {
    display: flex;
    gap: var(--size-4-3);
  }

  .series-icon {
    font-size: 32px;
    flex-shrink: 0;
  }

  .series-info {
    flex: 1;
    min-width: 0;
  }

  .series-title {
    margin: 0;
    font-size: var(--font-ui-medium);
    font-weight: 600;
    line-height: 1.3;
  }

  .series-meta {
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

  .progress-row {
    padding: var(--size-4-2) 0;
  }

  .progress-stats {
    display: flex;
    gap: var(--size-4-4);
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .stat-value {
    font-size: var(--font-ui-medium);
    font-weight: 600;
  }

  .stat-value.completed { color: var(--color-green); }
  .stat-value.reading { color: var(--color-blue); }
  .stat-value.to-read { color: var(--text-muted); }

  .stat-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }

  .empty-state {
    text-align: center;
    padding: var(--size-4-4);
    color: var(--text-muted);
  }

  .empty-state p {
    margin: 0;
  }

  .empty-state .hint {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    margin-top: var(--size-4-2);
  }

  .book-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
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

  .book-status.completed { color: var(--color-green); }
  .book-status.reading { color: var(--color-blue); }
  .book-status.to-read { color: var(--text-faint); }
</style>

<script lang="ts">
  /**
   * Book Detail View
   *
   * Shows detailed book information including:
   * - Cover and metadata
   * - Reading progress
   * - Highlight summary
   * - Quick actions
   */

  import { createEventDispatcher } from 'svelte';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';
  import type { DetailViewState } from '../../types/index';
  import ProgressBar from '../charts/ProgressBar.svelte';

  export let provider: AmnesiaHUDProvider;
  export let bookId: string;

  const dispatch = createEventDispatcher<{
    navigate: DetailViewState;
  }>();

  // Get book data
  $: book = provider.getBook(bookId);
  $: highlights = provider.getHighlights(bookId);
  $: highlightStats = provider.getHighlightStats(bookId);

  // Format dates
  function formatDate(date: Date | string | undefined): string {
    if (!date) return 'Unknown';
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  // Navigate to highlights
  function viewHighlights() {
    dispatch('navigate', {
      type: 'highlights',
      id: bookId,
      title: `Highlights: ${book?.title || 'Book'}`,
    });
  }

  // Navigate to author
  function viewAuthor() {
    if (book?.author) {
      dispatch('navigate', {
        type: 'author',
        id: book.author,
        title: book.author,
      });
    }
  }

  // Color labels for highlight stats
  const colorLabels: Record<string, string> = {
    yellow: 'Yellow',
    red: 'Red',
    green: 'Green',
    blue: 'Blue',
    purple: 'Purple',
    orange: 'Orange',
  };

  // Open book in reader
  async function openBookInReader() {
    await provider.openBook(bookId);
  }

  // Open book note
  async function openBookNote() {
    await provider.openBookNote(bookId);
  }
</script>

{#if book}
  <div class="book-detail">
    <!-- Book Header -->
    <div class="book-header">
      <div class="book-icon">📖</div>
      <div class="book-info">
        <h2 class="book-title">{book.title}</h2>
        {#if book.author}
          <button class="author-link" on:click={viewAuthor}>
            by {book.author}
          </button>
        {/if}
      </div>
    </div>

    <!-- Reading Progress -->
    <div class="section">
      <h3 class="section-title">Progress</h3>
      <div class="progress-row">
        <ProgressBar percent={book.progress || 0} width={30} showPercent />
      </div>
      <div class="progress-meta">
        <span class="status-badge status-{book.status || 'to-read'}">
          {book.status === 'reading' ? 'Reading' :
           book.status === 'completed' ? 'Completed' : 'To Read'}
        </span>
        {#if book.lastRead}
          <span class="last-read">
            Last read: {provider.formatRelativeTime(
              book.lastRead instanceof Date ? book.lastRead : new Date(book.lastRead)
            )}
          </span>
        {/if}
      </div>
    </div>

    <!-- Highlights Summary -->
    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Highlights</h3>
        {#if highlightStats.total > 0}
          <button class="view-all-btn" on:click={viewHighlights}>
            View All →
          </button>
        {/if}
      </div>

      {#if highlightStats.total > 0}
        <div class="highlight-stats">
          <div class="stat-row">
            <span class="stat-label">Total</span>
            <span class="stat-value">{highlightStats.total}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">With Notes</span>
            <span class="stat-value">{highlightStats.withNotes}</span>
          </div>
        </div>

        <!-- Color breakdown -->
        {#if Object.keys(highlightStats.byColor).length > 0}
          <div class="color-breakdown">
            {#each Object.entries(highlightStats.byColor) as [color, count]}
              <div class="color-chip color-{color}">
                <span class="color-dot"></span>
                <span class="color-count">{count}</span>
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        <div class="empty-state">No highlights yet</div>
      {/if}
    </div>

    <!-- Metadata -->
    <div class="section">
      <h3 class="section-title">Details</h3>
      <div class="metadata-grid">
        {#if book.publisher}
          <div class="meta-item">
            <span class="meta-label">Publisher</span>
            <span class="meta-value">{book.publisher}</span>
          </div>
        {/if}
        {#if book.publishedDate}
          <div class="meta-item">
            <span class="meta-label">Published</span>
            <span class="meta-value">{formatDate(book.publishedDate)}</span>
          </div>
        {/if}
        {#if book.addedAt}
          <div class="meta-item">
            <span class="meta-label">Added</span>
            <span class="meta-value">{formatDate(book.addedAt)}</span>
          </div>
        {/if}
        {#if book.formats && book.formats.length > 0}
          <div class="meta-item">
            <span class="meta-label">Format</span>
            <span class="meta-value">{book.formats[0].toUpperCase()}</span>
          </div>
        {/if}
      </div>
    </div>

    <!-- Actions -->
    <div class="actions">
      <button class="action-btn primary" on:click={openBookInReader} title="Open book in reader">
        📖 Open Book
      </button>
      <button class="action-btn" on:click={openBookNote} title="Open book note">
        📝 Open Note
      </button>
    </div>
  </div>
{:else}
  <div class="not-found">
    <span class="not-found-icon">📚</span>
    <span>Book not found</span>
  </div>
{/if}

<style>
  .book-detail {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-4);
  }

  .book-header {
    display: flex;
    gap: var(--size-4-3);
  }

  .book-icon {
    font-size: 32px;
    flex-shrink: 0;
  }

  .book-info {
    flex: 1;
    min-width: 0;
  }

  .book-title {
    margin: 0;
    font-size: var(--font-ui-medium);
    font-weight: 600;
    line-height: 1.3;
  }

  .author-link,
  .series-link {
    display: block;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-accent);
    font-size: var(--font-ui-small);
    text-align: left;
    cursor: pointer;
  }

  .author-link:hover,
  .series-link:hover {
    text-decoration: underline;
  }

  .series-link {
    color: var(--text-muted);
    font-style: italic;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-2);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .section-title {
    margin: 0;
    font-size: var(--font-ui-small);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .view-all-btn {
    padding: var(--size-4-1) var(--size-4-2);
    background: transparent;
    border: none;
    color: var(--text-accent);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
  }

  .view-all-btn:hover {
    text-decoration: underline;
  }

  .progress-row {
    padding: var(--size-4-2) 0;
  }

  .progress-meta {
    display: flex;
    gap: var(--size-4-2);
    align-items: center;
    flex-wrap: wrap;
  }

  .status-badge {
    padding: var(--size-4-1) var(--size-4-2);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    font-weight: 500;
  }

  .status-reading {
    background: var(--color-green-rgb, 76, 175, 80);
    background: rgba(76, 175, 80, 0.2);
    color: var(--color-green);
  }

  .status-completed {
    background: rgba(33, 150, 243, 0.2);
    color: var(--color-blue);
  }

  .status-to-read {
    background: var(--background-modifier-hover);
    color: var(--text-muted);
  }

  .last-read {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }

  .highlight-stats {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
  }

  .stat-row {
    display: flex;
    justify-content: space-between;
    font-size: var(--font-ui-small);
  }

  .stat-label {
    color: var(--text-muted);
  }

  .stat-value {
    font-weight: 500;
  }

  .color-breakdown {
    display: flex;
    gap: var(--size-4-2);
    flex-wrap: wrap;
    margin-top: var(--size-4-2);
  }

  .color-chip {
    display: flex;
    align-items: center;
    gap: var(--size-4-1);
    padding: var(--size-4-1) var(--size-4-2);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
  }

  .color-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .color-yellow .color-dot { background: #f9d71c; }
  .color-red .color-dot { background: #e74c3c; }
  .color-green .color-dot { background: #2ecc71; }
  .color-blue .color-dot { background: #3498db; }
  .color-purple .color-dot { background: #9b59b6; }
  .color-orange .color-dot { background: #e67e22; }

  .color-count {
    font-weight: 500;
  }

  .empty-state {
    color: var(--text-faint);
    font-size: var(--font-ui-small);
    font-style: italic;
  }

  .metadata-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--size-4-2);
  }

  .meta-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .meta-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }

  .meta-value {
    font-size: var(--font-ui-small);
    color: var(--text-normal);
  }

  .actions {
    display: flex;
    gap: var(--size-4-2);
    padding-top: var(--size-4-2);
    border-top: 1px solid var(--background-modifier-border);
  }

  .action-btn {
    flex: 1;
    padding: var(--size-4-2);
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .action-btn:hover {
    background: var(--background-modifier-hover);
  }

  .action-btn.primary {
    background: var(--interactive-accent);
    border-color: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .action-btn.primary:hover {
    background: var(--interactive-accent-hover);
  }

  .not-found {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--size-4-2);
    padding: var(--size-4-4);
    color: var(--text-muted);
  }

  .not-found-icon {
    font-size: 32px;
  }
</style>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Store } from '../../../helpers/store';
  import type { AmnesiaHUDState, AmnesiaHUDAction } from '../../types/index';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';
  import type { Book } from '../../../library/types';

  export let provider: AmnesiaHUDProvider;
  export let store: Store<AmnesiaHUDState, AmnesiaHUDAction>;

  let stats = provider.getReadingStats();
  let recentlyAdded: Book[] = [];
  let unsubscribe: (() => void) | null = null;

  onMount(() => {
    loadData();
    unsubscribe = provider.subscribe(() => {
      loadData();
    });
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });

  function loadData() {
    stats = provider.getReadingStats();
    recentlyAdded = provider.getRecentlyAddedBooks(5);
  }

  function handleBookClick(book: Book) {
    store.dispatch({
      type: 'PUSH_DETAIL_VIEW',
      payload: { type: 'book', id: book.id, title: book.title },
    });
  }

  // Count by format (mock for now)
  $: epubCount = stats.totalBooks; // TODO: Filter by format
  $: pdfCount = 0;
</script>

<div class="library-tab">
  <!-- Library Stats Section -->
  <section class="hud-section">
    <h3 class="hud-section-title">Library Stats</h3>
    <div class="stats-grid">
      <div class="stat-item">
        <span class="stat-value">{stats.totalBooks}</span>
        <span class="stat-label">Total books</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{stats.toReadBooks}</span>
        <span class="stat-label">To read</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{stats.currentlyReading}</span>
        <span class="stat-label">Reading</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{stats.completedBooks}</span>
        <span class="stat-label">Completed</span>
      </div>
    </div>
  </section>

  <!-- Recently Added Section -->
  <section class="hud-section">
    <h3 class="hud-section-title">Recently Added (7 days)</h3>
    {#if recentlyAdded.length === 0}
      <p class="hud-empty-state">No new books</p>
    {:else}
      <div class="book-list">
        {#each recentlyAdded as book (book.id)}
          <div class="book-item" on:click={() => handleBookClick(book)}>
            <span class="book-icon">🆕</span>
            <div class="book-info">
              <span class="book-title">{book.title}</span>
              <span class="book-meta">
                Added: {provider.formatRelativeTime(new Date(book.addedAt))}
              </span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- Storage Section -->
  <section class="hud-section">
    <h3 class="hud-section-title">Storage</h3>
    <div class="storage-info">
      <div class="format-counts">
        <span>EPUB: {epubCount}</span>
        <span>PDF: {pdfCount}</span>
      </div>
    </div>
  </section>
</div>

<style>
  .library-tab {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-4);
  }

  .hud-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-2);
  }

  .hud-section-title {
    margin: 0;
    font-size: var(--font-ui-small);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .hud-empty-state {
    margin: 0;
    padding: var(--size-4-3);
    color: var(--text-muted);
    font-style: italic;
    text-align: center;
    background: var(--background-secondary);
    border-radius: var(--radius-s);
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--size-4-2);
  }

  .stat-item {
    display: flex;
    flex-direction: column;
    align-items: center;
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
    color: var(--text-muted);
  }

  .book-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-2);
  }

  .book-item {
    display: flex;
    align-items: flex-start;
    gap: var(--size-4-2);
    padding: var(--size-4-2);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    cursor: pointer;
  }

  .book-item:hover {
    background: var(--background-modifier-hover);
  }

  .book-icon {
    font-size: 16px;
  }

  .book-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .book-title {
    font-size: var(--font-ui-small);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .book-meta {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .storage-info {
    padding: var(--size-4-2);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
  }

  .format-counts {
    display: flex;
    gap: var(--size-4-4);
    font-family: var(--font-monospace);
    font-size: var(--font-ui-small);
  }
</style>

<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import type { Store } from '../../../helpers/store';
  import type { AmnesiaHUDState, AmnesiaHUDAction, DetailViewState } from '../../types/index';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';
  import type { Book } from '../../../library/types';
  import type { HUDContext } from '../../context/context-detector';
  import ProgressBar from '../charts/ProgressBar.svelte';
  import ActivitySparkline from '../charts/ActivitySparkline.svelte';
  import BookCard from '../shared/BookCard.svelte';

  export let provider: AmnesiaHUDProvider;
  export let store: Store<AmnesiaHUDState, AmnesiaHUDAction>;

  const dispatch = createEventDispatcher<{
    close: void;
    navigate: DetailViewState;
  }>();

  let readingBooks: Book[] = [];
  let recentlyFinished: Book[] = [];
  let recentActivity: number[] = [];
  let unsubscribe: (() => void) | null = null;
  let contextUnsubscribe: (() => void) | null = null;

  // Context state - will be updated reactively
  let context: HUDContext = { type: 'none' };

  onMount(() => {
    // Get initial context
    if (provider?.getCurrentContext) {
      context = provider.getCurrentContext();
    }
    loadData();
    unsubscribe = provider.subscribe(() => {
      loadData();
    });
    // Subscribe to context changes
    contextUnsubscribe = provider.subscribeToContext((newContext) => {
      context = newContext;
    });
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
    if (contextUnsubscribe) contextUnsubscribe();
  });

  // Context helpers
  $: hasContext = context.type !== 'none';
  $: isBookContext = context.type === 'book';

  function loadData() {
    readingBooks = provider.getReadingBooks();
    recentlyFinished = provider.getCompletedBooks(3);
    const stats = provider.getReadingStats();
    recentActivity = stats.recentActivity;
  }

  function handleBookClick(book: Book) {
    store.dispatch({
      type: 'PUSH_DETAIL_VIEW',
      payload: { type: 'book', id: book.id, title: book.title },
    });
  }

  function handleResumeBook(book: Book) {
    // TODO: Open book in reader
    console.log('[HUD] Resume book:', book.title);
  }

  // Calculate average pages per day from activity
  $: avgPagesPerDay = recentActivity.length > 0
    ? (recentActivity.reduce((a, b) => a + b, 0) / recentActivity.length).toFixed(1)
    : '0';
</script>

<div class="reading-tab">
  <!-- Context Panel - direct provider access -->
  {#if provider?.getCurrentContext?.()?.type === 'book'}
    {@const ctx = provider.getCurrentContext()}
    <div class="context-panel">
      <div class="context-header">
        <span class="context-icon">📖</span>
        <span class="context-label">Current Context</span>
      </div>
      <div class="context-content">
        <div class="context-title">{ctx.title || 'Unknown Book'}</div>
        {#if ctx.author}
          <div class="context-meta">by {ctx.author}</div>
        {/if}
        <div class="context-actions">
          <button class="action-btn">View Details</button>
          <button class="action-btn secondary">Open Reader</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Currently Reading Section -->
  <section class="hud-section">
    <h3 class="hud-section-title">Currently Reading</h3>
    {#if readingBooks.length === 0}
      <p class="hud-empty-state">No books in progress</p>
    {:else}
      <div class="book-list">
        {#each readingBooks as book (book.id)}
          <BookCard
            {book}
            on:click={() => handleBookClick(book)}
            on:resume={() => handleResumeBook(book)}
          />
        {/each}
      </div>
    {/if}
  </section>

  <!-- Recent Activity Section -->
  <section class="hud-section">
    <h3 class="hud-section-title">Recent Activity</h3>
    <div class="activity-row">
      <ActivitySparkline values={recentActivity} />
      <span class="activity-label">Last 7 days</span>
    </div>
    <div class="activity-stats">
      <span class="stat">Highlights/day: {avgPagesPerDay} avg</span>
    </div>
  </section>

  <!-- Recently Finished Section -->
  {#if recentlyFinished.length > 0}
    <section class="hud-section">
      <h3 class="hud-section-title">Recently Finished</h3>
      <div class="finished-list">
        {#each recentlyFinished as book (book.id)}
          <div class="finished-item" on:click={() => handleBookClick(book)}>
            <span class="finished-icon">✓</span>
            <span class="finished-title">{book.title}</span>
            <span class="finished-date">
              {book.completedAt ? provider.formatRelativeTime(new Date(book.completedAt)) : ''}
            </span>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .reading-tab {
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

  .book-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-2);
  }

  .activity-row {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
  }

  .activity-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .activity-stats {
    font-family: var(--font-monospace);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .finished-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
  }

  .finished-item {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    padding: var(--size-4-1) 0;
    cursor: pointer;
    font-size: var(--font-ui-small);
  }

  .finished-item:hover {
    color: var(--text-accent);
  }

  .finished-icon {
    color: var(--color-green);
  }

  .finished-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .finished-date {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  /* Context Panel Styles */
  .context-panel {
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    padding: var(--size-4-2);
    margin-bottom: var(--size-4-2);
  }

  .context-header {
    display: flex;
    align-items: center;
    gap: var(--size-4-1);
    margin-bottom: var(--size-4-2);
    padding-bottom: var(--size-4-1);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .context-icon {
    font-size: 14px;
  }

  .context-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .context-content {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
  }

  .context-title {
    font-size: var(--font-ui-small);
    font-weight: 600;
    color: var(--text-normal);
  }

  .context-meta {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .context-actions {
    display: flex;
    gap: var(--size-4-2);
    margin-top: var(--size-4-1);
  }

  .action-btn {
    flex: 1;
    padding: var(--size-4-1) var(--size-4-2);
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
  }

  .action-btn:hover {
    background: var(--interactive-accent-hover);
  }

  .action-btn.secondary {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }
</style>

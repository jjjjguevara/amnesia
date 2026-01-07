<script lang="ts">
  /**
   * Context Panel
   *
   * Displays contextual information based on what the user is currently viewing:
   * - Book note: Show book details, highlights, open reader
   * - Reader: Show current book, progress, add highlight
   * - Author: Show author's books in library
   * - Series: Show series progress
   */

  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import type { AmnesiaHUDProvider } from '../providers/AmnesiaHUDProvider';
  import type { HUDContext, BookContext, HighlightContext, AuthorContext, SeriesContext } from '../context/context-detector';
  import type { DetailViewState } from '../types/index';

  export let provider: AmnesiaHUDProvider;

  const dispatch = createEventDispatcher<{
    navigate: DetailViewState;
  }>();

  // Initialize with current context immediately (not in onMount)
  // This ensures hasContext is correct on first render
  let context: HUDContext = provider?.getCurrentContext?.() ?? { type: 'none' };
  let unsubscribe: (() => void) | null = null;

  console.log('[ContextPanel] Initial context:', context);

  onMount(() => {
    // Subscribe for future updates
    unsubscribe = provider.subscribeToContext((newContext) => {
      context = newContext;
    });
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });

  function navigateToBook(bookContext: BookContext) {
    const bookId = bookContext.bookId || bookContext.calibreId?.toString() || '';
    if (bookId) {
      dispatch('navigate', {
        type: 'book',
        id: bookId,
        title: bookContext.title || 'Book',
      });
    }
  }

  function navigateToAuthor(authorContext: AuthorContext) {
    dispatch('navigate', {
      type: 'author',
      id: authorContext.authorName,
      title: authorContext.authorName,
    });
  }

  function navigateToSeries(seriesContext: SeriesContext) {
    dispatch('navigate', {
      type: 'series',
      id: seriesContext.seriesName,
      title: seriesContext.seriesName,
    });
  }

  function getContextIcon(type: string): string {
    switch (type) {
      case 'book': return '📖';
      case 'highlight': return '✨';
      case 'author': return '👤';
      case 'series': return '📚';
      default: return '📍';
    }
  }

  // Type guards for context
  $: isBookContext = context.type === 'book';
  $: isHighlightContext = context.type === 'highlight';
  $: isAuthorContext = context.type === 'author';
  $: isSeriesContext = context.type === 'series';
  $: hasContext = context.type !== 'none';

  // Typed context accessors (avoid 'as' in template)
  $: bookCtx = isBookContext ? (context as BookContext) : null;
  $: hlCtx = isHighlightContext ? (context as HighlightContext) : null;
  $: authCtx = isAuthorContext ? (context as AuthorContext) : null;
  $: seriesCtx = isSeriesContext ? (context as SeriesContext) : null;
</script>

{#if hasContext}
  <div class="context-panel">
    <div class="context-header">
      <span class="context-icon">{getContextIcon(context.type)}</span>
      <span class="context-label">Current Context</span>
    </div>

    {#if isBookContext && bookCtx}
      <div class="context-content">
        <div class="context-title">{bookCtx.title || 'Unknown Book'}</div>
        {#if bookCtx.author}
          <div class="context-meta">by {bookCtx.author}</div>
        {/if}
        {#if bookCtx.series}
          <div class="context-meta series">📚 {bookCtx.series}</div>
        {/if}
        <div class="context-actions">
          <button class="action-btn" on:click={() => navigateToBook(bookCtx)}>
            View Details
          </button>
          {#if bookCtx.bookPath}
            <button class="action-btn secondary">
              Open Reader
            </button>
          {/if}
        </div>
      </div>
    {:else if isHighlightContext && hlCtx}
      <div class="context-content">
        <div class="context-title">Highlight</div>
        {#if hlCtx.bookTitle}
          <div class="context-meta">from {hlCtx.bookTitle}</div>
        {/if}
        {#if hlCtx.color}
          <div class="context-meta">
            <span class="color-dot" style="background: var(--color-{hlCtx.color}, {hlCtx.color})"></span>
            {hlCtx.color}
          </div>
        {/if}
      </div>
    {:else if isAuthorContext && authCtx}
      <div class="context-content">
        <div class="context-title">{authCtx.authorName}</div>
        <div class="context-meta">Author</div>
        <div class="context-actions">
          <button class="action-btn" on:click={() => navigateToAuthor(authCtx)}>
            View Bibliography
          </button>
        </div>
      </div>
    {:else if isSeriesContext && seriesCtx}
      <div class="context-content">
        <div class="context-title">{seriesCtx.seriesName}</div>
        <div class="context-meta">Series</div>
        <div class="context-actions">
          <button class="action-btn" on:click={() => navigateToSeries(seriesCtx)}>
            View Series
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
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
    line-height: 1.3;
  }

  .context-meta {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: var(--size-4-1);
  }

  .context-meta.series {
    color: var(--text-accent);
  }

  .color-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
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
    transition: background-color 0.15s ease;
  }

  .action-btn:hover {
    background: var(--interactive-accent-hover);
  }

  .action-btn.secondary {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .action-btn.secondary:hover {
    background: var(--background-modifier-active-hover);
  }
</style>

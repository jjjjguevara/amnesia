<script lang="ts">
  /**
   * Detail View Router
   *
   * Handles navigation stack for detail views within the HUD.
   * Routes to appropriate detail component based on view type.
   */

  import { createEventDispatcher } from 'svelte';
  import type { Store } from '../../../helpers/store';
  import type { AmnesiaHUDState, AmnesiaHUDAction, DetailViewState } from '../../types/index';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';
  import { HUDActions } from '../../state/hud-store';
  import BookDetailView from './BookDetailView.svelte';
  import HighlightListView from './HighlightListView.svelte';
  import SeriesDetailView from './SeriesDetailView.svelte';
  import AuthorBibView from './AuthorBibView.svelte';
  import ServerLogsView from './ServerLogsView.svelte';

  export let store: Store<AmnesiaHUDState, AmnesiaHUDAction>;
  export let provider: AmnesiaHUDProvider;
  export let detailView: DetailViewState;

  const dispatch = createEventDispatcher<{
    back: void;
    navigate: DetailViewState;
  }>();

  // Get view history for back navigation
  $: state = store.getValue();
  $: canGoBack = state.viewHistory.length > 0;

  function handleBack() {
    store.dispatch(HUDActions.popDetailView());
    dispatch('back');
  }

  function handleNavigate(event: CustomEvent<DetailViewState>) {
    store.dispatch(HUDActions.pushDetailView(event.detail));
    dispatch('navigate', event.detail);
  }

  // Get title based on view type
  function getViewTitle(view: DetailViewState): string {
    switch (view.type) {
      case 'book':
        return view.title || 'Book Details';
      case 'highlights':
        return view.title || 'Highlights';
      case 'series':
        return view.title || 'Series';
      case 'author':
        return view.title || 'Author';
      case 'server-logs':
        return 'Server Logs';
      default:
        return 'Details';
    }
  }
</script>

<div class="detail-view">
  <!-- Header with back button -->
  <div class="detail-header">
    <button class="back-btn" on:click={handleBack} title="Go back (Escape)">
      ← Back
    </button>
    <span class="detail-title">{getViewTitle(detailView)}</span>
  </div>

  <!-- Content area -->
  <div class="detail-content">
    {#if detailView.type === 'book'}
      <BookDetailView
        {provider}
        bookId={detailView.id}
        on:navigate={handleNavigate}
      />
    {:else if detailView.type === 'highlights'}
      <HighlightListView
        {provider}
        bookId={detailView.id}
        on:navigate={handleNavigate}
      />
    {:else if detailView.type === 'series'}
      <SeriesDetailView
        {provider}
        seriesName={detailView.id}
        on:navigate={handleNavigate}
      />
    {:else if detailView.type === 'author'}
      <AuthorBibView
        {provider}
        authorName={detailView.id}
        on:navigate={handleNavigate}
      />
    {:else if detailView.type === 'server-logs'}
      <ServerLogsView {provider} />
    {:else}
      <div class="unknown-view">Unknown view type: {detailView.type}</div>
    {/if}
  </div>
</div>

<style>
  .detail-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    padding: var(--size-4-2) var(--size-4-3);
    border-bottom: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
  }

  .back-btn {
    padding: var(--size-4-1) var(--size-4-2);
    background: transparent;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .back-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .detail-title {
    font-weight: 600;
    font-size: var(--font-ui-small);
    color: var(--text-normal);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-content {
    flex: 1;
    overflow-y: auto;
    padding: var(--size-4-3);
  }

  .unknown-view {
    color: var(--text-muted);
    text-align: center;
    padding: var(--size-4-4);
  }
</style>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Store } from '../../../helpers/store';
  import type { AmnesiaHUDState, AmnesiaHUDAction, SeriesInfo } from '../../types/index';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';
  import ProgressBar from '../charts/ProgressBar.svelte';

  export let provider: AmnesiaHUDProvider;
  export let store: Store<AmnesiaHUDState, AmnesiaHUDAction>;

  let activeSeries: SeriesInfo[] = [];
  let completedSeries: SeriesInfo[] = [];
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
    const allSeries = provider.getActiveSeries();
    activeSeries = allSeries.filter(s => s.progress < 100);
    completedSeries = allSeries.filter(s => s.progress >= 100);
  }

  function handleSeriesClick(series: SeriesInfo) {
    store.dispatch({
      type: 'PUSH_DETAIL_VIEW',
      payload: { type: 'series', id: series.name, title: series.name },
    });
  }

  function handleContinueSeries(series: SeriesInfo) {
    // TODO: Open current book in reader
    console.log('[HUD] Continue series:', series.name);
  }
</script>

<div class="series-tab">
  <!-- Active Series Section -->
  <section class="hud-section">
    <h3 class="hud-section-title">Active Series ({activeSeries.length})</h3>
    {#if activeSeries.length === 0}
      <div class="empty-state">
        <p class="empty-message">No series in progress</p>
        <p class="empty-hint">
          Series are detected from book metadata (e.g., via Calibre).
        </p>
      </div>
    {:else}
      <div class="series-list">
        {#each activeSeries as series (series.name)}
          <div class="series-card" on:click={() => handleSeriesClick(series)}>
            <div class="series-header">
              <span class="series-icon">📚</span>
              <div class="series-info">
                <span class="series-name">{series.name}</span>
                {#if series.author}
                  <span class="series-author">{series.author}</span>
                {/if}
              </div>
            </div>
            <div class="series-progress">
              <span class="progress-text">
                Progress: {series.readBooks}/{series.totalBooks} books ({series.progress}%)
              </span>
              <ProgressBar percent={series.progress} />
            </div>
            {#if series.currentBook}
              <div class="current-book">
                Currently: {series.currentBook}
              </div>
            {/if}
            <button
              class="continue-btn"
              on:click|stopPropagation={() => handleContinueSeries(series)}
            >
              Continue Series →
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- Completed Series Section -->
  {#if completedSeries.length > 0}
    <section class="hud-section">
      <h3 class="hud-section-title">Completed Series ({completedSeries.length})</h3>
      <div class="completed-list">
        {#each completedSeries as series (series.name)}
          <div class="completed-item" on:click={() => handleSeriesClick(series)}>
            <span class="completed-icon">✓</span>
            <span class="completed-name">{series.name}</span>
            <span class="completed-count">({series.readBooks}/{series.totalBooks})</span>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .series-tab {
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

  .empty-state {
    padding: var(--size-4-4);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    text-align: center;
  }

  .empty-message {
    margin: 0 0 var(--size-4-2) 0;
    color: var(--text-muted);
    font-style: italic;
  }

  .empty-hint {
    margin: 0;
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }

  .series-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-2);
  }

  .series-card {
    padding: var(--size-4-3);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .series-card:hover {
    background: var(--background-modifier-hover);
  }

  .series-header {
    display: flex;
    align-items: flex-start;
    gap: var(--size-4-2);
    margin-bottom: var(--size-4-2);
  }

  .series-icon {
    font-size: 20px;
  }

  .series-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .series-name {
    font-weight: 600;
  }

  .series-author {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .series-progress {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
    margin-bottom: var(--size-4-2);
  }

  .progress-text {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .current-book {
    margin-bottom: var(--size-4-2);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .continue-btn {
    display: inline-block;
    padding: var(--size-4-1) var(--size-4-2);
    background: var(--interactive-accent);
    border: none;
    border-radius: var(--radius-s);
    color: var(--text-on-accent);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .continue-btn:hover {
    background: var(--interactive-accent-hover);
  }

  .completed-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
  }

  .completed-item {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    padding: var(--size-4-1) 0;
    cursor: pointer;
    font-size: var(--font-ui-small);
  }

  .completed-item:hover {
    color: var(--text-accent);
  }

  .completed-icon {
    color: var(--color-green);
  }

  .completed-name {
    flex: 1;
  }

  .completed-count {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }
</style>

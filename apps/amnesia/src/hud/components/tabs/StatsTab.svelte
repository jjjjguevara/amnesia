<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Store } from '../../../helpers/store';
  import type { AmnesiaHUDState, AmnesiaHUDAction } from '../../types/index';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';
  import ActivitySparkline from '../charts/ActivitySparkline.svelte';

  export let provider: AmnesiaHUDProvider;
  export let store: Store<AmnesiaHUDState, AmnesiaHUDAction>;

  let highlightStats = provider.getHighlightStats();
  let readingStats = provider.getReadingStats();
  let unsubscribe: (() => void) | null = null;

  // Color configuration
  const colorConfig: Record<string, { name: string; cssVar: string }> = {
    yellow: { name: 'Yellow', cssVar: 'var(--color-yellow)' },
    green: { name: 'Green', cssVar: 'var(--color-green)' },
    blue: { name: 'Blue', cssVar: 'var(--color-blue)' },
    pink: { name: 'Pink', cssVar: 'var(--color-pink)' },
    purple: { name: 'Purple', cssVar: 'var(--color-purple)' },
    orange: { name: 'Orange', cssVar: 'var(--color-orange)' },
  };

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
    highlightStats = provider.getHighlightStats();
    readingStats = provider.getReadingStats();
  }

  function handleColorClick(color: string) {
    store.dispatch({
      type: 'PUSH_DETAIL_VIEW',
      payload: { type: 'highlights', id: 'all', title: `${color} Highlights`, filter: { color } },
    });
  }

  // Calculate percentages for bar chart
  $: colorBars = Object.entries(highlightStats.byColor)
    .map(([color, count]) => ({
      color,
      count,
      percent: highlightStats.total > 0
        ? Math.round((count / highlightStats.total) * 100)
        : 0,
      config: colorConfig[color] || { name: color, cssVar: 'var(--text-muted)' },
    }))
    .sort((a, b) => b.count - a.count);

  // Notes with annotations percentage
  $: annotatedPercent = highlightStats.total > 0
    ? Math.round((highlightStats.withNotes / highlightStats.total) * 100)
    : 0;
</script>

<div class="stats-tab">
  <!-- Highlights Section -->
  <section class="hud-section">
    <h3 class="hud-section-title">Highlights</h3>
    <div class="total-count">
      Total: <strong>{highlightStats.total}</strong> highlights
    </div>

    <!-- Color Distribution -->
    <div class="color-section">
      <span class="subsection-title">By Color:</span>
      <div class="color-bars">
        {#each colorBars as bar (bar.color)}
          <button
            class="color-bar-row"
            on:click={() => handleColorClick(bar.color)}
          >
            <div class="color-bar">
              <div
                class="color-bar-fill"
                style="width: {bar.percent}%; background: {bar.config.cssVar};"
              ></div>
            </div>
            <span class="color-label">{bar.config.name}</span>
            <span class="color-count">{bar.count} ({bar.percent}%)</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Annotation Stats -->
    <div class="annotation-stats">
      <span>With notes: {highlightStats.withNotes} ({annotatedPercent}%)</span>
    </div>
  </section>

  <!-- Activity Section -->
  <section class="hud-section">
    <h3 class="hud-section-title">Activity (30 days)</h3>
    <div class="activity-row">
      <span class="activity-label">Highlights created:</span>
      <ActivitySparkline values={readingStats.recentActivity} />
    </div>
  </section>
</div>

<style>
  .stats-tab {
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

  .total-count {
    font-family: var(--font-monospace);
    font-size: var(--font-ui-small);
  }

  .subsection-title {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .color-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-2);
  }

  .color-bars {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
  }

  .color-bar-row {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    padding: var(--size-4-1) 0;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    width: 100%;
  }

  .color-bar-row:hover {
    background: var(--background-modifier-hover);
    border-radius: var(--radius-s);
  }

  .color-bar {
    flex: 1;
    height: 8px;
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    overflow: hidden;
  }

  .color-bar-fill {
    height: 100%;
    border-radius: var(--radius-s);
    transition: width 0.3s ease;
  }

  .color-label {
    width: 60px;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .color-count {
    width: 70px;
    font-family: var(--font-monospace);
    font-size: var(--font-ui-smaller);
    text-align: right;
  }

  .annotation-stats {
    font-family: var(--font-monospace);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
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
</style>

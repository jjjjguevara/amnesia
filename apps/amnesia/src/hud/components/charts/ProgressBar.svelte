<script lang="ts">
  /**
   * ASCII-style Progress Bar Component
   *
   * Renders a progress bar using block characters for a TUI aesthetic.
   */

  export let percent: number = 0;
  export let width: number = 20;
  export let showPercent: boolean = true;
  export let useAscii: boolean = true;

  // Clamp percent to 0-100
  $: clampedPercent = Math.max(0, Math.min(100, percent));
  $: filledCount = Math.floor((clampedPercent / 100) * width);
  $: emptyCount = width - filledCount;

  // ASCII representation
  $: asciiBar = useAscii
    ? `[${'█'.repeat(filledCount)}${'░'.repeat(emptyCount)}]`
    : '';
</script>

{#if useAscii}
  <span class="progress-bar ascii" title="{clampedPercent}%">
    <span class="progress-text">{asciiBar}</span>
    {#if showPercent}
      <span class="progress-percent">{clampedPercent}%</span>
    {/if}
  </span>
{:else}
  <div class="progress-bar visual">
    <div class="progress-track">
      <div class="progress-fill" style="width: {clampedPercent}%;"></div>
    </div>
    {#if showPercent}
      <span class="progress-percent">{clampedPercent}%</span>
    {/if}
  </div>
{/if}

<style>
  .progress-bar {
    display: inline-flex;
    align-items: center;
    gap: var(--size-4-2);
  }

  .progress-bar.ascii {
    font-family: var(--font-monospace);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .progress-text {
    letter-spacing: -1px;
  }

  .progress-percent {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    min-width: 32px;
  }

  .progress-bar.visual {
    width: 100%;
  }

  .progress-track {
    flex: 1;
    height: 6px;
    background: var(--background-modifier-border);
    border-radius: var(--radius-s);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--interactive-accent);
    border-radius: var(--radius-s);
    transition: width 0.3s ease;
  }
</style>

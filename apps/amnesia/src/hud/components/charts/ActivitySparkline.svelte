<script lang="ts">
  /**
   * ASCII-style Activity Sparkline Component
   *
   * Renders activity data as a sparkline using block characters.
   */

  export let values: number[] = [];

  // Block characters for different heights (8 levels)
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

  function renderSparkline(data: number[]): string {
    if (data.length === 0) return '';

    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min;

    return data
      .map((v) => {
        if (range === 0) {
          // All values are the same
          return max > 0 ? blocks[4] : blocks[0];
        }
        const normalized = (v - min) / range;
        const index = Math.floor(normalized * (blocks.length - 1));
        return blocks[index];
      })
      .join('');
  }

  $: sparkline = renderSparkline(values);
  $: total = values.reduce((a, b) => a + b, 0);
  $: peak = Math.max(...values, 0);
</script>

<span class="sparkline" title="Total: {total}, Peak: {peak}">
  {sparkline}
</span>

<style>
  .sparkline {
    font-family: var(--font-monospace);
    font-size: var(--font-ui-small);
    letter-spacing: 0;
    color: var(--text-accent);
    cursor: default;
  }
</style>

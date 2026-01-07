<script lang="ts">
  /**
   * Server Logs View
   *
   * Filterable log viewer for server events:
   * - Filter by log level
   * - Auto-scroll to latest
   * - Clear logs
   * - Export logs
   */

  import { onMount, onDestroy } from 'svelte';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';

  export let provider: AmnesiaHUDProvider;

  // Log entry type
  interface LogEntry {
    id: string;
    timestamp: Date;
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
    details?: string;
  }

  // State
  let logs: LogEntry[] = [];
  let levelFilter: string = 'all';
  let autoScroll = true;
  let logContainer: HTMLElement;

  // Sample logs for demonstration (in real impl, would come from server manager)
  function generateSampleLogs(): LogEntry[] {
    const now = Date.now();
    return [
      { id: '1', timestamp: new Date(now - 60000), level: 'info', message: 'Server started on port 3000' },
      { id: '2', timestamp: new Date(now - 55000), level: 'info', message: 'Health check endpoint ready' },
      { id: '3', timestamp: new Date(now - 45000), level: 'debug', message: 'Initializing PDF cache' },
      { id: '4', timestamp: new Date(now - 30000), level: 'info', message: 'Connected to S3 storage' },
      { id: '5', timestamp: new Date(now - 15000), level: 'warn', message: 'Cache size approaching limit', details: 'Current: 450MB / 500MB' },
      { id: '6', timestamp: new Date(now - 5000), level: 'info', message: 'Request: GET /api/pdf/render' },
    ];
  }

  // Filter logs by level
  $: filteredLogs = logs.filter(log => {
    if (levelFilter === 'all') return true;
    return log.level === levelFilter;
  });

  // Level counts for badges
  $: levelCounts = {
    all: logs.length,
    error: logs.filter(l => l.level === 'error').length,
    warn: logs.filter(l => l.level === 'warn').length,
    info: logs.filter(l => l.level === 'info').length,
    debug: logs.filter(l => l.level === 'debug').length,
  };

  function formatTime(date: Date): string {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function getLevelIcon(level: string): string {
    switch (level) {
      case 'error': return '✕';
      case 'warn': return '⚠';
      case 'info': return 'ℹ';
      case 'debug': return '⚙';
      default: return '•';
    }
  }

  function clearLogs() {
    logs = [];
  }

  function exportLogs() {
    const content = logs
      .map(l => `[${formatTime(l.timestamp)}] [${l.level.toUpperCase()}] ${l.message}${l.details ? '\n  ' + l.details : ''}`)
      .join('\n');

    // Copy to clipboard
    navigator.clipboard.writeText(content).then(() => {
      // Could show a toast notification here
      console.log('Logs copied to clipboard');
    });
  }

  function scrollToBottom() {
    if (logContainer && autoScroll) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  // Auto-scroll when new logs are added
  $: if (filteredLogs.length > 0) {
    setTimeout(scrollToBottom, 0);
  }

  onMount(() => {
    // Load sample logs
    logs = generateSampleLogs();

    // In real implementation, would subscribe to server events
    // serverManager.on('log', (entry) => { logs = [...logs, entry]; });
  });
</script>

<div class="server-logs">
  <!-- Toolbar -->
  <div class="toolbar">
    <!-- Level filters -->
    <div class="level-filters">
      <button
        class="level-btn"
        class:active={levelFilter === 'all'}
        on:click={() => levelFilter = 'all'}
      >
        All <span class="badge">{levelCounts.all}</span>
      </button>
      <button
        class="level-btn level-error"
        class:active={levelFilter === 'error'}
        on:click={() => levelFilter = 'error'}
      >
        Errors <span class="badge">{levelCounts.error}</span>
      </button>
      <button
        class="level-btn level-warn"
        class:active={levelFilter === 'warn'}
        on:click={() => levelFilter = 'warn'}
      >
        Warnings <span class="badge">{levelCounts.warn}</span>
      </button>
    </div>

    <!-- Actions -->
    <div class="toolbar-actions">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={autoScroll} />
        <span>Auto-scroll</span>
      </label>
      <button class="action-btn" on:click={exportLogs} title="Copy logs to clipboard">
        📋
      </button>
      <button class="action-btn" on:click={clearLogs} title="Clear logs">
        🗑️
      </button>
    </div>
  </div>

  <!-- Log list -->
  <div class="log-container" bind:this={logContainer}>
    {#if filteredLogs.length === 0}
      <div class="empty-state">
        {#if logs.length === 0}
          No logs yet
        {:else}
          No logs match the current filter
        {/if}
      </div>
    {:else}
      {#each filteredLogs as log (log.id)}
        <div class="log-entry level-{log.level}">
          <span class="log-time">{formatTime(log.timestamp)}</span>
          <span class="log-level">{getLevelIcon(log.level)}</span>
          <div class="log-content">
            <span class="log-message">{log.message}</span>
            {#if log.details}
              <span class="log-details">{log.details}</span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <!-- Status bar -->
  <div class="status-bar">
    <span class="log-count">
      {filteredLogs.length} of {logs.length} entries
    </span>
    <span class="server-status">
      Server: {provider.getServerStatusInfo().status}
    </span>
  </div>
</div>

<style>
  .server-logs {
    display: flex;
    flex-direction: column;
    height: 300px;
  }

  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--size-4-2);
    padding: var(--size-4-2);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    margin-bottom: var(--size-4-2);
    flex-wrap: wrap;
  }

  .level-filters {
    display: flex;
    gap: var(--size-4-1);
  }

  .level-btn {
    display: flex;
    align-items: center;
    gap: var(--size-4-1);
    padding: var(--size-4-1) var(--size-4-2);
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .level-btn.active {
    border-color: var(--interactive-accent);
    color: var(--text-normal);
  }

  .level-btn.level-error.active { border-color: var(--color-red); }
  .level-btn.level-warn.active { border-color: var(--color-orange); }

  .level-btn .badge {
    padding: 0 var(--size-4-1);
    background: var(--background-modifier-hover);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
  }

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: var(--size-4-1);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    cursor: pointer;
  }

  .checkbox-label input {
    margin: 0;
  }

  .action-btn {
    padding: var(--size-4-1);
    background: transparent;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    font-size: 12px;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .action-btn:hover {
    background: var(--background-modifier-hover);
  }

  .log-container {
    flex: 1;
    overflow-y: auto;
    font-family: var(--font-monospace);
    font-size: var(--font-ui-smaller);
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-faint);
    font-family: var(--font-text);
    font-style: italic;
  }

  .log-entry {
    display: flex;
    gap: var(--size-4-2);
    padding: var(--size-4-1) var(--size-4-2);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .log-entry:last-child {
    border-bottom: none;
  }

  .log-entry.level-error {
    background: rgba(235, 87, 87, 0.1);
  }

  .log-entry.level-warn {
    background: rgba(242, 201, 76, 0.1);
  }

  .log-time {
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .log-level {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
  }

  .level-error .log-level { color: var(--color-red); }
  .level-warn .log-level { color: var(--color-orange); }
  .level-info .log-level { color: var(--color-blue); }
  .level-debug .log-level { color: var(--text-faint); }

  .log-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .log-message {
    color: var(--text-normal);
    word-break: break-word;
  }

  .log-details {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    padding-left: var(--size-4-2);
  }

  .status-bar {
    display: flex;
    justify-content: space-between;
    padding: var(--size-4-1) var(--size-4-2);
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    margin-top: var(--size-4-2);
  }
</style>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { setIcon } from 'obsidian';
  import type { Store } from '../../../helpers/store';
  import type { AmnesiaHUDState, AmnesiaHUDAction, ServerStatusType } from '../../types/index';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';

  export let provider: AmnesiaHUDProvider;
  export let store: Store<AmnesiaHUDState, AmnesiaHUDAction>;

  let serverStatus = provider.getServerStatusInfo();
  let isLoading = false;
  let unsubscribe: (() => void) | null = null;

  // Status display configuration
  const statusConfig: Record<ServerStatusType, { label: string; class: string }> = {
    running: { label: 'Server Running', class: 'status-running' },
    starting: { label: 'Server Starting...', class: 'status-pending' },
    stopping: { label: 'Server Stopping...', class: 'status-pending' },
    restarting: { label: 'Server Restarting...', class: 'status-pending' },
    stopped: { label: 'Server Stopped', class: 'status-stopped' },
    error: { label: 'Server Error', class: 'status-error' },
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
    serverStatus = provider.getServerStatusInfo();
    isLoading = false;
  }

  async function handleStart() {
    isLoading = true;
    await provider.startServer();
  }

  async function handleStop() {
    isLoading = true;
    await provider.stopServer();
  }

  async function handleRestart() {
    isLoading = true;
    await provider.restartServer();
  }

  function handleViewLogs() {
    store.dispatch({
      type: 'PUSH_DETAIL_VIEW',
      payload: { type: 'server-logs' },
    });
  }

  $: statusDisplay = statusConfig[serverStatus.status] || statusConfig.stopped;
  $: isRunning = serverStatus.status === 'running';
  $: isPending = ['starting', 'stopping', 'restarting'].includes(serverStatus.status);
  $: canStart = serverStatus.status === 'stopped' || serverStatus.status === 'error';
  $: canStop = serverStatus.status === 'running';

  function setActionIcon(el: HTMLElement, iconName: string) {
    if (el) {
      setIcon(el, iconName);
    }
  }
</script>

<div class="server-tab">
  <!-- Status Section -->
  <section class="hud-section">
    <h3 class="hud-section-title">Status</h3>
    <div class="status-card {statusDisplay.class}">
      <div class="status-header">
        <span class="status-indicator">{serverStatus.indicator}</span>
        <span class="status-label">{statusDisplay.label}</span>
      </div>
      {#if isRunning}
        <div class="status-details">
          <div class="detail-row">
            <span class="detail-label">Port:</span>
            <span class="detail-value">{serverStatus.port}</span>
          </div>
          {#if serverStatus.uptime !== undefined}
            <div class="detail-row">
              <span class="detail-label">Uptime:</span>
              <span class="detail-value">{provider.formatUptime(serverStatus.uptime)}</span>
            </div>
          {/if}
        </div>
      {/if}
      {#if serverStatus.lastError}
        <div class="error-message">
          Error: {serverStatus.lastError}
        </div>
      {/if}
      <div class="status-actions">
        {#if canStart}
          <button
            class="action-btn primary"
            on:click={handleStart}
            disabled={isLoading}
          >
            <span class="action-icon" use:setActionIcon={'play'}></span>
            Start
          </button>
        {/if}
        {#if canStop}
          <button
            class="action-btn"
            on:click={handleStop}
            disabled={isLoading}
          >
            <span class="action-icon" use:setActionIcon={'square'}></span>
            Stop
          </button>
          <button
            class="action-btn"
            on:click={handleRestart}
            disabled={isLoading}
          >
            <span class="action-icon" use:setActionIcon={'refresh-cw'}></span>
            Restart
          </button>
        {/if}
        {#if isPending}
          <span class="pending-indicator">...</span>
        {/if}
      </div>
    </div>
  </section>

  <!-- Quick Actions Section -->
  <section class="hud-section">
    <h3 class="hud-section-title">Quick Actions</h3>
    <div class="quick-actions">
      <button class="quick-action-btn" on:click={handleViewLogs}>
        <span class="action-icon" use:setActionIcon={'file-text'}></span>
        View Logs
      </button>
    </div>
  </section>

  <!-- Keyboard Shortcuts -->
  <section class="hud-section">
    <h3 class="hud-section-title">Keyboard Shortcuts</h3>
    <div class="shortcuts-list">
      <div class="shortcut-item">
        <kbd>Ctrl+Shift+S</kbd>
        <span>Start/Stop Server</span>
      </div>
      <div class="shortcut-item">
        <kbd>Ctrl+Shift+R</kbd>
        <span>Restart Server</span>
      </div>
    </div>
  </section>
</div>

<style>
  .server-tab {
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

  .status-card {
    padding: var(--size-4-3);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    border-left: 3px solid transparent;
  }

  .status-card.status-running {
    border-left-color: var(--color-green);
  }

  .status-card.status-pending {
    border-left-color: var(--color-yellow);
  }

  .status-card.status-stopped {
    border-left-color: var(--text-muted);
  }

  .status-card.status-error {
    border-left-color: var(--color-red);
  }

  .status-header {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    margin-bottom: var(--size-4-2);
  }

  .status-indicator {
    font-size: 16px;
  }

  .status-label {
    font-weight: 600;
  }

  .status-details {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
    margin-bottom: var(--size-4-2);
    font-family: var(--font-monospace);
    font-size: var(--font-ui-smaller);
  }

  .detail-row {
    display: flex;
    gap: var(--size-4-2);
  }

  .detail-label {
    color: var(--text-muted);
    min-width: 60px;
  }

  .detail-value {
    color: var(--text-normal);
  }

  .error-message {
    margin-bottom: var(--size-4-2);
    padding: var(--size-4-2);
    background: var(--background-modifier-error);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-error);
  }

  .status-actions {
    display: flex;
    gap: var(--size-4-2);
    margin-top: var(--size-4-2);
  }

  .action-btn {
    display: flex;
    align-items: center;
    gap: var(--size-4-1);
    padding: var(--size-4-1) var(--size-4-2);
    background: var(--background-modifier-border);
    border: none;
    border-radius: var(--radius-s);
    cursor: pointer;
    font-size: var(--font-ui-smaller);
    transition: background-color 0.15s ease;
  }

  .action-btn:hover:not(:disabled) {
    background: var(--background-modifier-hover);
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-btn.primary {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .action-btn.primary:hover:not(:disabled) {
    background: var(--interactive-accent-hover);
  }

  .action-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
  }

  .action-icon :global(svg) {
    width: 14px;
    height: 14px;
  }

  .pending-indicator {
    color: var(--text-muted);
  }

  .quick-actions {
    display: flex;
    gap: var(--size-4-2);
  }

  .quick-action-btn {
    display: flex;
    align-items: center;
    gap: var(--size-4-1);
    padding: var(--size-4-2);
    background: var(--background-secondary);
    border: none;
    border-radius: var(--radius-s);
    cursor: pointer;
    font-size: var(--font-ui-smaller);
    transition: background-color 0.15s ease;
  }

  .quick-action-btn:hover {
    background: var(--background-modifier-hover);
  }

  .shortcuts-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
  }

  .shortcut-item {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    font-size: var(--font-ui-smaller);
  }

  .shortcut-item kbd {
    padding: 2px 6px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    font-family: var(--font-monospace);
    font-size: 10px;
  }
</style>

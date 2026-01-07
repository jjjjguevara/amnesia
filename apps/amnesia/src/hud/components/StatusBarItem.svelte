<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { setIcon } from 'obsidian';
  import type { AmnesiaHUDProvider } from '../providers/AmnesiaHUDProvider';
  import type { StatusBarContent } from '../types/index';

  export let provider: AmnesiaHUDProvider;
  export let showServerStatus = true;

  const dispatch = createEventDispatcher<{
    click: void;
    contextmenu: MouseEvent;
  }>();

  let containerEl: HTMLElement;
  let iconEl: HTMLElement;
  let statusContent: StatusBarContent;
  let unsubscribe: (() => void) | null = null;

  // Initial content - use legacy method for standalone HUD
  statusContent = provider.getLegacyStatusBarContent();

  onMount(() => {
    // Set icon
    if (iconEl) {
      setIcon(iconEl, statusContent.icon);
    }

    // Subscribe to updates
    unsubscribe = provider.subscribe(() => {
      statusContent = provider.getLegacyStatusBarContent();
    });
  });

  onDestroy(() => {
    if (unsubscribe) {
      unsubscribe();
    }
  });

  function handleClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    dispatch('click');
  }

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    dispatch('contextmenu', event);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dispatch('click');
    }
  }

  // Color class mapping
  $: colorClass = `hud-status-${statusContent.color || 'gray'}`;
  $: serverColorClass = statusContent.serverStatus
    ? `hud-server-${statusContent.serverStatus.color}`
    : '';
</script>

<div
  class="amnesia-hud-status-bar"
  bind:this={containerEl}
  on:click={handleClick}
  on:contextmenu={handleContextMenu}
  on:keydown={handleKeydown}
  role="button"
  tabindex="0"
  title={statusContent.tooltip || 'Click to open Amnesia HUD'}
>
  <span class="hud-icon {colorClass}" bind:this={iconEl}></span>
  {#if statusContent.text}
    <span class="hud-text">{statusContent.text}</span>
  {/if}
  {#if showServerStatus && statusContent.serverStatus}
    <span class="hud-server-status {serverColorClass}">
      {statusContent.serverStatus.indicator} Server
    </span>
  {/if}
</div>

<style>
  .amnesia-hud-status-bar {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    cursor: pointer;
    font-family: var(--font-monospace);
    font-size: var(--font-ui-smaller);
    padding: 0 var(--size-4-2);
    border-radius: var(--radius-s);
    transition: background-color 0.15s ease;
  }

  .amnesia-hud-status-bar:hover {
    background-color: var(--background-modifier-hover);
  }

  .amnesia-hud-status-bar:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .hud-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
  }

  .hud-icon :global(svg) {
    width: 14px;
    height: 14px;
  }

  .hud-text {
    color: var(--text-muted);
  }

  .hud-server-status {
    margin-left: var(--size-4-1);
    font-size: var(--font-ui-smaller);
  }

  /* Status colors */
  .hud-status-green {
    color: var(--color-green);
  }

  .hud-status-yellow {
    color: var(--color-yellow);
  }

  .hud-status-red {
    color: var(--color-red);
  }

  .hud-status-gray {
    color: var(--text-muted);
  }

  /* Server status colors */
  .hud-server-green {
    color: var(--color-green);
  }

  .hud-server-yellow {
    color: var(--color-yellow);
  }

  .hud-server-red {
    color: var(--color-red);
  }

  .hud-server-gray {
    color: var(--text-muted);
  }
</style>

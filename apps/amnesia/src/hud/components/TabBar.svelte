<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { setIcon } from 'obsidian';
  import type { TabName } from '../types/index';

  interface TabConfig {
    id: TabName;
    label: string;
    icon: string;
    badge?: number | string;
  }

  export let tabs: TabConfig[] = [];
  export let activeTab: TabName = 'reading';

  const dispatch = createEventDispatcher<{
    selectTab: { tab: TabName };
  }>();

  function handleTabClick(tab: TabName) {
    dispatch('selectTab', { tab });
  }

  function handleKeydown(event: KeyboardEvent, tab: TabName) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleTabClick(tab);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      navigateTabs(event.key === 'ArrowRight' ? 1 : -1);
    }
  }

  function navigateTabs(direction: number) {
    const currentIndex = tabs.findIndex(t => t.id === activeTab);
    const newIndex = (currentIndex + direction + tabs.length) % tabs.length;
    handleTabClick(tabs[newIndex].id);
  }

  function setTabIcon(el: HTMLElement, iconName: string) {
    if (el) {
      setIcon(el, iconName);
    }
  }
</script>

<div class="hud-tab-bar" role="tablist">
  {#each tabs as tab (tab.id)}
    <button
      class="hud-tab"
      class:is-active={activeTab === tab.id}
      role="tab"
      aria-selected={activeTab === tab.id}
      tabindex={activeTab === tab.id ? 0 : -1}
      on:click={() => handleTabClick(tab.id)}
      on:keydown={(e) => handleKeydown(e, tab.id)}
    >
      <span class="hud-tab-icon" use:setTabIcon={tab.icon}></span>
      <span class="hud-tab-label">{tab.label}</span>
      {#if tab.badge !== undefined}
        <span class="hud-tab-badge" class:is-indicator={typeof tab.badge === 'string' && tab.badge.length === 1}>
          {tab.badge}
        </span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .hud-tab-bar {
    display: flex;
    gap: 2px;
    padding: var(--size-4-2);
    background: var(--background-secondary);
    border-bottom: 1px solid var(--background-modifier-border);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .hud-tab-bar::-webkit-scrollbar {
    display: none;
  }

  .hud-tab {
    display: flex;
    align-items: center;
    gap: var(--size-4-1);
    padding: var(--size-4-1) var(--size-4-2);
    background: transparent;
    border: none;
    border-radius: var(--radius-s);
    color: var(--text-muted);
    font-family: var(--font-monospace);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .hud-tab:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .hud-tab.is-active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .hud-tab:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .hud-tab-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
  }

  .hud-tab-icon :global(svg) {
    width: 14px;
    height: 14px;
  }

  .hud-tab-label {
    font-weight: 500;
  }

  .hud-tab-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    background: var(--background-modifier-border);
    border-radius: var(--radius-s);
    font-size: 10px;
    font-weight: 600;
  }

  .hud-tab.is-active .hud-tab-badge {
    background: rgba(255, 255, 255, 0.2);
  }

  .hud-tab-badge.is-indicator {
    min-width: 16px;
    width: 16px;
    padding: 0;
    font-size: 11px;
  }
</style>

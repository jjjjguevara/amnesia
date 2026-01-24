<script lang="ts">
  /**
   * ToC Entry Item Component
   *
   * Recursive component for rendering individual ToC entries with progress tracking.
   */
  import { createEventDispatcher } from 'svelte';
  import { slide } from 'svelte/transition';
  import type { TocEntryWithProgress } from './toc/types';
  import { ChevronRight, ChevronDown } from 'lucide-svelte';

  export let entry: TocEntryWithProgress;
  export let expandedItems: Set<string>;
  export let level: number = 0;

  const dispatch = createEventDispatcher<{
    navigate: { href: string };
    toggle: { id: string };
  }>();

  $: hasChildren = entry.children && entry.children.length > 0;
  $: isExpanded = expandedItems.has(entry.id);
  $: isCurrent = entry.isCurrent;
  $: isAncestor = entry.isAncestorOfCurrent;

  function handleClick() {
    dispatch('navigate', { href: entry.href });
  }

  function handleToggle(e: Event) {
    e.stopPropagation();
    dispatch('toggle', { id: entry.id });
  }

  function handleKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        handleClick();
        break;
      case 'ArrowRight':
        // Expand if collapsed and has children
        if (hasChildren && !isExpanded) {
          e.preventDefault();
          dispatch('toggle', { id: entry.id });
        }
        break;
      case 'ArrowLeft':
        // Collapse if expanded and has children
        if (hasChildren && isExpanded) {
          e.preventDefault();
          dispatch('toggle', { id: entry.id });
        }
        break;
    }
  }
</script>

<div class="toc-entry" style="--level: {level}">
  <div
    class="toc-entry-self"
    class:is-current={isCurrent}
    class:is-ancestor={isAncestor}
    class:has-children={hasChildren}
    role="treeitem"
    tabindex="0"
    aria-expanded={hasChildren ? isExpanded : undefined}
    on:click={handleClick}
    on:keydown={handleKeydown}
  >
    {#if hasChildren}
      <button
        class="toc-expand-btn"
        on:click={handleToggle}
        aria-label={isExpanded ? 'Collapse' : 'Expand'}
        tabindex="-1"
      >
        {#if isExpanded}
          <ChevronDown size={14} />
        {:else}
          <ChevronRight size={14} />
        {/if}
      </button>
    {:else}
      <span class="toc-spacer"></span>
    {/if}
    <div class="toc-entry-content">
      <span class="toc-entry-label">{entry.label}</span>
    </div>
  </div>

  {#if hasChildren && isExpanded}
    <div class="toc-children" transition:slide={{ duration: 200 }}>
      {#each entry.children as child (child.id)}
        <svelte:self
          entry={child}
          {expandedItems}
          level={level + 1}
          on:navigate
          on:toggle
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .toc-entry {
    position: relative;
  }

  .toc-entry-self {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    padding-left: calc(8px + var(--level) * 16px);
    border-radius: var(--radius-s);
    cursor: pointer;
    transition: background 0.1s;
  }

  .toc-entry-self:hover {
    background: var(--background-modifier-hover);
  }

  .toc-entry-self:focus-visible {
    outline: 2px solid var(--interactive-accent);
    outline-offset: -2px;
  }

  .toc-entry-self.is-current {
    background: var(--background-modifier-active-hover);
    border-left: 3px solid var(--interactive-accent);
    padding-left: calc(5px + var(--level) * 16px);
  }

  .toc-entry-self.is-current .toc-entry-label {
    color: var(--interactive-accent);
    font-weight: 500;
  }

  .toc-entry-self.is-ancestor .toc-entry-label {
    font-weight: 500;
  }

  .toc-expand-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-s);
    flex-shrink: 0;
  }

  .toc-expand-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .toc-spacer {
    width: 18px;
    flex-shrink: 0;
  }

  .toc-entry-content {
    flex: 1;
    min-width: 0;
  }

  .toc-entry-label {
    font-size: var(--font-ui-small);
    line-height: 1.3;
    color: var(--text-normal);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .toc-children {
    position: relative;
  }

  .toc-children::before {
    content: '';
    position: absolute;
    left: calc(16px + var(--level) * 16px);
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--background-modifier-border);
  }
</style>

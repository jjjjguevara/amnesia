<script lang="ts">
  /**
   * Table of Contents Tab Component
   *
   * Displays book table of contents with progress tracking, expand/collapse controls.
   * Features: hierarchical nesting, per-chapter progress bars, book progress bar,
   * keyboard navigation, state persistence.
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import type { TocEntry, SpineItem } from '../../reader/renderer/types';
  import type { Locator } from '../../reader/navigator/navigator-interface';
  import type { TocEntryWithProgress, BookProgress, TocExpandedState } from './toc/types';
  import { TocProgressCalculator } from './toc/TocProgressCalculator';
  import { TocExpandedStateManager } from './toc/TocExpandedState';
  import { List, ChevronsDownUp, ChevronsUpDown } from 'lucide-svelte';
  import TocEntryItem from './TocEntryItem.svelte';

  export let toc: TocEntry[] = [];
  export let spineItems: SpineItem[] = [];
  export let currentLocator: Locator | null = null;
  export let initialExpandedState: TocExpandedState = [];
  export let onSaveExpandedState: ((state: TocExpandedState) => void) | null = null;

  const dispatch = createEventDispatcher<{
    navigate: { href: string };
  }>();

  // Initialize calculator when spine items change
  let calculator: TocProgressCalculator | null = null;
  $: if (spineItems.length > 0) {
    calculator = new TocProgressCalculator(spineItems);
  }

  // Initialize expanded state manager
  let expandedStateManager: TocExpandedStateManager;
  let expandedItems = new Set<string>(initialExpandedState);

  onMount(() => {
    expandedStateManager = new TocExpandedStateManager(
      initialExpandedState,
      (state) => {
        expandedItems = new Set(state);
        onSaveExpandedState?.(state);
      }
    );
  });

  // Compute enhanced TOC with progress
  let enhancedToc: TocEntryWithProgress[] = [];
  let bookProgress: BookProgress = {
    currentSpineIndex: 0,
    currentHref: '',
    currentChapterProgress: 0,
    totalProgression: 0,
    chaptersRead: 0,
    totalChapters: 0,
    percentComplete: 0,
  };

  $: if (calculator && toc.length > 0) {
    enhancedToc = calculator.enhanceTocWithProgress(toc, currentLocator);
    bookProgress = calculator.calculateBookProgress(currentLocator);

    // Auto-expand to current chapter when locator changes
    if (expandedStateManager && currentLocator) {
      expandedStateManager.expandToCurrent(enhancedToc);
    }
  }

  function toggleExpand(id: string) {
    if (expandedStateManager) {
      expandedStateManager.toggle(id);
    } else {
      // Fallback for before onMount
      if (expandedItems.has(id)) {
        expandedItems.delete(id);
      } else {
        expandedItems.add(id);
      }
      expandedItems = expandedItems;
    }
  }

  function handleNavigate(href: string) {
    dispatch('navigate', { href });
  }

  function expandAll() {
    if (expandedStateManager && enhancedToc.length > 0) {
      expandedStateManager.expandAll(enhancedToc);
    }
  }

  function collapseAll() {
    if (expandedStateManager) {
      expandedStateManager.collapseAll();
    }
  }

  function getTotalCount(entries: TocEntry[]): number {
    let count = entries.length;
    for (const entry of entries) {
      count += getTotalCount(entry.children);
    }
    return count;
  }
</script>

<div class="toc-tab">
  {#if toc.length === 0}
    <div class="search-empty-state">
      <List size={32} strokeWidth={1.5} />
      <div class="search-empty-state-message">No table of contents</div>
      <div class="search-empty-state-hint">This book doesn't have a ToC</div>
    </div>
  {:else}
    <div class="toc-header">
      <div class="toc-header-top">
        <span class="toc-count">{getTotalCount(toc)} chapters</span>
        <div class="toc-header-actions">
          <button
            class="toc-header-btn"
            on:click={expandAll}
            title="Expand All"
            aria-label="Expand all sections"
          >
            <ChevronsUpDown size={14} />
          </button>
          <button
            class="toc-header-btn"
            on:click={collapseAll}
            title="Collapse All"
            aria-label="Collapse all sections"
          >
            <ChevronsDownUp size={14} />
          </button>
        </div>
      </div>
    </div>

    <div class="toc-tree" role="tree">
      {#each enhancedToc as entry (entry.id)}
        <TocEntryItem
          {entry}
          {expandedItems}
          level={0}
          on:navigate={(e) => handleNavigate(e.detail.href)}
          on:toggle={(e) => toggleExpand(e.detail.id)}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .toc-tab {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .search-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 32px 16px;
    color: var(--text-muted);
    gap: 8px;
  }

  .search-empty-state-message {
    font-size: var(--font-ui-medium);
  }

  .search-empty-state-hint {
    font-size: var(--font-ui-smaller);
    opacity: 0.7;
  }

  .toc-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .toc-header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .toc-count {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .toc-header-actions {
    display: flex;
    gap: 2px;
  }

  .toc-header-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-s);
    transition: background 0.1s, color 0.1s;
  }

  .toc-header-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .toc-tree {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }
</style>

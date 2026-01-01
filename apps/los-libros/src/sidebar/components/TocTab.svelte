<script lang="ts">
  /**
   * Table of Contents Tab Component
   *
   * Displays book table of contents using Obsidian's tree-item pattern.
   * Features: hierarchical nesting, current chapter highlighting, navigation.
   */
  import { createEventDispatcher } from 'svelte';
  import type { TocEntry } from '../../reader/renderer/types';
  import { List } from 'lucide-svelte';
  import TocEntryItem from './TocEntryItem.svelte';

  export let toc: TocEntry[] = [];
  export let currentChapter: string | null = null;

  const dispatch = createEventDispatcher<{
    navigate: { href: string };
  }>();

  let expandedItems = new Set<string>();

  // Auto-expand items that contain the current chapter on initial load
  $: if (currentChapter && expandedItems.size === 0) {
    expandToCurrentChapter(toc, currentChapter);
  }

  function expandToCurrentChapter(entries: TocEntry[], target: string): boolean {
    for (const entry of entries) {
      const isCurrent = isCurrentEntry(entry, target);
      const childContains = entry.children.length > 0 && expandToCurrentChapter(entry.children, target);

      if (isCurrent || childContains) {
        expandedItems.add(entry.id);
        expandedItems = expandedItems;
        return true;
      }
    }
    return false;
  }

  function isCurrentEntry(entry: TocEntry, chapter: string | null): boolean {
    if (!chapter) return false;
    const entryPath = entry.href.split('#')[0];
    const currentPath = chapter.split('#')[0];
    return entryPath === currentPath ||
           currentPath.endsWith(entryPath) ||
           entryPath.endsWith(currentPath);
  }

  function toggleExpand(id: string) {
    if (expandedItems.has(id)) {
      expandedItems.delete(id);
    } else {
      expandedItems.add(id);
    }
    expandedItems = expandedItems;
  }

  function handleNavigate(href: string) {
    dispatch('navigate', { href });
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
      <span class="toc-count">{getTotalCount(toc)} chapters</span>
    </div>

    <div class="toc-tree">
      {#each toc as entry (entry.id)}
        <TocEntryItem
          {entry}
          {currentChapter}
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
    align-items: center;
    padding: 6px 8px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .toc-count {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .toc-tree {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }
</style>

<script lang="ts">
  /**
   * View Mode Switcher
   *
   * Expandable tab selector with draggable slider.
   * Collapses to show only active icon, expands on hover to show all tabs.
   * Pattern adopted from Doc Doctor plugin.
   */
  import { onMount, onDestroy } from 'svelte';
  import { sidebarStore, type SidebarTab } from '../sidebar.store';
  import {
    Highlighter,
    BookmarkIcon,
    StickyNote,
    Image,
    List,
    Search,
  } from 'lucide-svelte';

  export let highlightsCount = 0;
  export let bookmarksCount = 0;
  export let notesCount = 0;
  export let tocCount = 0;
  export let searchResultsCount = 0;

  // Expansion state
  let isExpanded = false;
  let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
  let collapseTimeout: ReturnType<typeof setTimeout> | null = null;

  // Slider state
  let isDragging = false;
  let isHovering = false;
  let isPressing = false;
  let dragStartX = 0;
  let dragStartIndex = 0;

  // View mode definitions
  const viewModes: { mode: SidebarTab; label: string; icon: typeof Highlighter }[] = [
    { mode: 'search', label: 'Search', icon: Search },
    { mode: 'toc', label: 'Contents', icon: List },
    { mode: 'highlights', label: 'Highlights', icon: Highlighter },
    { mode: 'bookmarks', label: 'Bookmarks', icon: BookmarkIcon },
    { mode: 'notes', label: 'Notes', icon: StickyNote },
    { mode: 'images', label: 'Images', icon: Image },
  ];

  // Subscribe to store for current tab
  let currentTab: SidebarTab = 'highlights';
  const unsubscribe = sidebarStore.subscribe(state => {
    currentTab = state.activeTab;
  });

  // Calculate slider position
  $: currentIndex = viewModes.findIndex(v => v.mode === currentTab);
  $: sliderPosition = currentIndex * 26; // 26px per tab

  onMount(() => {
    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);
  });

  onDestroy(() => {
    document.removeEventListener('mousemove', handleGlobalMouseMove);
    document.removeEventListener('mouseup', handleGlobalMouseUp);
    if (hoverTimeout) clearTimeout(hoverTimeout);
    if (collapseTimeout) clearTimeout(collapseTimeout);
    unsubscribe();
  });

  const setViewMode = (mode: SidebarTab) => {
    sidebarStore.setTab(mode);
    isExpanded = false;
  };

  const handleMouseEnter = () => {
    if (collapseTimeout) {
      clearTimeout(collapseTimeout);
      collapseTimeout = null;
    }
    hoverTimeout = setTimeout(() => {
      isExpanded = true;
    }, 100);
  };

  const handleMouseLeave = () => {
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
    if (!isDragging) {
      collapseTimeout = setTimeout(() => {
        isExpanded = false;
      }, 200);
    }
  };

  const handleSliderMouseDown = (e: MouseEvent) => {
    if (!isExpanded) return;
    e.preventDefault();
    isDragging = true;
    isPressing = true;
    dragStartX = e.clientX;
    dragStartIndex = currentIndex;
  };

  const handleGlobalMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;

    const deltaX = e.clientX - dragStartX;
    const tabWidth = 26;
    const newIndex = Math.round((dragStartIndex * tabWidth + deltaX) / tabWidth);
    const clampedIndex = Math.max(0, Math.min(viewModes.length - 1, newIndex));

    if (clampedIndex !== currentIndex) {
      const targetMode = viewModes[clampedIndex].mode;
      sidebarStore.setTab(targetMode);
    }
  };

  const handleGlobalMouseUp = () => {
    if (isDragging) {
      isDragging = false;
      isPressing = false;
      collapseTimeout = setTimeout(() => {
        isExpanded = false;
      }, 300);
    }
  };

  const handleTabClick = (mode: SidebarTab) => {
    if (!isDragging) {
      setViewMode(mode);
    }
  };

  const handleSliderEnter = () => {
    isHovering = true;
  };

  const handleSliderLeave = () => {
    isHovering = false;
  };

  $: currentMode = viewModes[currentIndex];

  // Get badge count for a mode (TOC excluded - too crowded)
  function getBadgeCount(mode: SidebarTab): number {
    switch (mode) {
      case 'search': return searchResultsCount;
      case 'highlights': return highlightsCount;
      case 'bookmarks': return bookmarksCount;
      case 'notes': return notesCount;
      default: return 0;
    }
  }
</script>

<div
  class="view-mode-switcher"
  class:expanded={isExpanded}
  on:mouseenter={handleMouseEnter}
  on:mouseleave={handleMouseLeave}
  role="group"
  aria-label="View mode selector"
>
  {#if isExpanded}
    <!-- Expanded: show all tabs with sliding glass indicator -->
    <div class="tabs-track">
      {#each viewModes as viewMode, index (viewMode.mode)}
        <button
          class="tab-icon"
          class:active={index === currentIndex}
          on:click={() => handleTabClick(viewMode.mode)}
          aria-label={viewMode.label}
        >
          <svelte:component this={viewMode.icon} size={16} />
          {#if getBadgeCount(viewMode.mode) > 0}
            <span class="badge">{getBadgeCount(viewMode.mode)}</span>
          {/if}
        </button>
      {/each}

      <!-- Solid slider overlay -->
      <div
        class="slider"
        class:dragging={isDragging}
        class:hovering={isHovering}
        class:pressing={isPressing}
        style="transform: translateX({sliderPosition}px);"
        on:mousedown={handleSliderMouseDown}
        on:mouseenter={handleSliderEnter}
        on:mouseleave={handleSliderLeave}
        role="presentation"
      ></div>
    </div>
  {:else}
    <!-- Collapsed: show only active tab -->
    <button
      class="collapsed-tab"
      aria-label={currentMode.label}
    >
      <svelte:component this={currentMode.icon} size={16} />
      {#if getBadgeCount(currentMode.mode) > 0}
        <span class="badge">{getBadgeCount(currentMode.mode)}</span>
      {/if}
    </button>
  {/if}
</div>

<style>
  .view-mode-switcher {
    position: relative;
    display: inline-flex;
    align-items: center;
    background: var(--background-modifier-border);
    border-radius: 6px;
    padding: 3px;
    transition: all 0.2s ease;
  }

  /* Collapsed state */
  .collapsed-tab {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none !important;
    background: var(--background-primary);
    color: var(--icon-color, var(--text-muted));
    cursor: pointer;
    border-radius: 4px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
    outline: none !important;
    padding: 0;
    margin: 0;
  }

  .collapsed-tab:hover {
    color: var(--icon-color-hover, var(--text-normal));
  }

  .collapsed-tab:focus,
  .collapsed-tab:focus-visible {
    outline: none !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
  }

  /* Expanded track */
  .tabs-track {
    position: relative;
    display: flex;
    align-items: center;
  }

  .tab-icon {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none !important;
    background: transparent !important;
    color: var(--text-faint);
    cursor: pointer;
    transition: color 0.15s ease;
    z-index: 1;
    outline: none !important;
    -webkit-appearance: none;
    appearance: none;
    padding: 0;
    margin: 0;
    box-shadow: none !important;
  }

  .tab-icon:hover {
    color: var(--text-muted);
    background: transparent !important;
  }

  .tab-icon:focus,
  .tab-icon:focus-visible {
    outline: none !important;
    box-shadow: none !important;
    background: transparent !important;
  }

  .tab-icon.active {
    color: var(--icon-color-hover, var(--text-normal));
    z-index: 3;
  }

  /* Solid slider */
  .slider {
    position: absolute;
    left: 0;
    top: 0;
    width: 26px;
    height: 26px;
    background: var(--background-primary);
    border-radius: 4px;
    cursor: grab;
    transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                box-shadow 0.15s ease;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
    z-index: 2;
    pointer-events: auto;
  }

  .slider:hover,
  .slider.hovering {
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2),
                0 0 8px rgba(var(--interactive-accent-rgb, 66, 133, 244), 0.3);
  }

  .slider.pressing {
    cursor: grabbing;
    box-shadow: 0 3px 8px rgba(0, 0, 0, 0.25),
                0 0 12px rgba(var(--interactive-accent-rgb, 66, 133, 244), 0.4);
  }

  .slider.dragging {
    cursor: grabbing;
    transition: box-shadow 0.1s ease;
  }

  .badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 12px;
    height: 12px;
    font-size: 8px;
    font-weight: 600;
    line-height: 12px;
    text-align: center;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-radius: 6px;
    padding: 0 2px;
    z-index: 4;
  }
</style>

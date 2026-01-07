<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { computePosition, flip, shift, offset } from '@floating-ui/dom';
  import type { Store } from '../../helpers/store';
  import type { AmnesiaHUDState, AmnesiaHUDAction, TabName, DetailViewState } from '../types/index';
  import type { AmnesiaHUDProvider } from '../providers/AmnesiaHUDProvider';
  import TabBar from './TabBar.svelte';
  import DetailView from './details/DetailView.svelte';

  // Tab components
  import ReadingTab from './tabs/ReadingTab.svelte';
  import LibraryTab from './tabs/LibraryTab.svelte';
  import StatsTab from './tabs/StatsTab.svelte';
  import ServerTab from './tabs/ServerTab.svelte';
  import SeriesTab from './tabs/SeriesTab.svelte';

  export let store: Store<AmnesiaHUDState, AmnesiaHUDAction>;
  export let provider: AmnesiaHUDProvider;
  export let referenceEl: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{
    close: void;
  }>();

  let panelEl: HTMLElement;
  let state: AmnesiaHUDState;
  let unsubscribeStore: (() => void) | null = null;

  // Tab configuration
  $: tabs = [
    { id: 'reading' as TabName, label: 'READING', icon: 'book-open', badge: provider.getReadingStats().currentlyReading || undefined },
    { id: 'library' as TabName, label: 'LIBRARY', icon: 'library', badge: undefined },
    { id: 'stats' as TabName, label: 'STATS', icon: 'bar-chart-2', badge: provider.getReadingStats().totalHighlights || undefined },
    { id: 'server' as TabName, label: 'SERVER', icon: 'server', badge: provider.getServerStatusInfo().indicator },
    { id: 'series' as TabName, label: 'SERIES', icon: 'layers', badge: provider.getActiveSeries().length || undefined },
  ];

  // Tab component mapping
  const tabComponents: Record<TabName, any> = {
    reading: ReadingTab,
    library: LibraryTab,
    stats: StatsTab,
    server: ServerTab,
    series: SeriesTab,
  };

  onMount(() => {
    // Subscribe to store
    unsubscribeStore = store.subscribe((s) => {
      state = s;
    });

    // Position panel
    updatePosition();

    // Add click outside listener
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    if (unsubscribeStore) {
      unsubscribeStore();
    }
    document.removeEventListener('mousedown', handleClickOutside);
    document.removeEventListener('keydown', handleKeydown);
  });

  async function updatePosition() {
    if (!referenceEl || !panelEl) return;

    const { x, y } = await computePosition(referenceEl, panelEl, {
      placement: 'top-start',
      middleware: [
        offset(8),
        flip({
          fallbackPlacements: ['top-end', 'bottom-start', 'bottom-end'],
        }),
        shift({ padding: 8 }),
      ],
    });

    panelEl.style.left = `${x}px`;
    panelEl.style.top = `${y}px`;
  }

  function handleClickOutside(event: MouseEvent) {
    if (!state?.isPinned && panelEl && !panelEl.contains(event.target as Node)) {
      // Check if click was on the status bar item
      if (referenceEl && referenceEl.contains(event.target as Node)) {
        return; // Let the status bar handle this
      }
      dispatch('close');
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    // Escape - close or go back
    if (event.key === 'Escape') {
      if (state?.detailView) {
        // Go back from detail view
        store.dispatch({ type: 'POP_DETAIL_VIEW' });
      } else {
        dispatch('close');
      }
      return;
    }

    // Ctrl+P - toggle pin
    if (event.ctrlKey && event.key === 'p') {
      event.preventDefault();
      handlePinToggle();
      return;
    }

    // Ctrl+Shift+S - start/stop server
    if (event.ctrlKey && event.shiftKey && event.key === 'S') {
      event.preventDefault();
      const serverStatus = provider.getServerStatusInfo();
      if (serverStatus.status === 'running') {
        provider.stopServer();
      } else if (serverStatus.status === 'stopped' || serverStatus.status === 'error') {
        provider.startServer();
      }
      return;
    }

    // Ctrl+Shift+R - restart server
    if (event.ctrlKey && event.shiftKey && event.key === 'R') {
      event.preventDefault();
      const serverStatus = provider.getServerStatusInfo();
      if (serverStatus.status === 'running') {
        provider.restartServer();
      }
      return;
    }

    // Tab navigation (left/right arrows or Tab when in tab mode)
    if (!state?.detailView) {
      const tabIds: TabName[] = ['reading', 'library', 'stats', 'server', 'series'];
      const currentIndex = tabIds.indexOf(state?.activeTab || 'reading');

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        const newIndex = currentIndex > 0 ? currentIndex - 1 : tabIds.length - 1;
        store.dispatch({ type: 'SET_ACTIVE_TAB', payload: tabIds[newIndex] });
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        const newIndex = currentIndex < tabIds.length - 1 ? currentIndex + 1 : 0;
        store.dispatch({ type: 'SET_ACTIVE_TAB', payload: tabIds[newIndex] });
      }
    }
  }

  function handleTabSelect(event: CustomEvent<{ tab: TabName }>) {
    store.dispatch({ type: 'SET_ACTIVE_TAB', payload: event.detail.tab });
  }

  function handlePinToggle() {
    store.dispatch({ type: 'PIN_HUD', payload: !state?.isPinned });
  }

  $: activeTab = state?.activeTab || 'reading';
  $: isPinned = state?.isPinned || false;
  $: detailView = state?.detailView;
  $: CurrentTabComponent = tabComponents[activeTab];

  function handleNavigate(event: CustomEvent<DetailViewState>) {
    store.dispatch({ type: 'PUSH_DETAIL_VIEW', payload: event.detail });
  }
</script>

<div
  class="amnesia-hud-compact-view"
  bind:this={panelEl}
  role="dialog"
  aria-label="Amnesia HUD"
>
  {#if detailView}
    <!-- Detail View Mode -->
    <DetailView
      {store}
      {provider}
      {detailView}
      on:back={() => {}}
      on:navigate={handleNavigate}
    />
  {:else}
    <!-- Tab View Mode -->
    <div class="hud-header">
      <TabBar {tabs} {activeTab} on:selectTab={handleTabSelect} />
      <button
        class="hud-pin-btn"
        class:is-pinned={isPinned}
        on:click={handlePinToggle}
        title={isPinned ? 'Unpin HUD' : 'Pin HUD'}
      >
        {isPinned ? '📌' : '📍'}
      </button>
    </div>

    <div class="hud-content">
      <svelte:component
        this={CurrentTabComponent}
        {provider}
        {store}
        on:close={() => dispatch('close')}
        on:navigate={handleNavigate}
      />
    </div>
  {/if}
</div>

<style>
  .amnesia-hud-compact-view {
    position: fixed;
    width: 400px;
    max-height: 600px;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    box-shadow: var(--shadow-s);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .hud-header {
    display: flex;
    align-items: stretch;
  }

  .hud-header :global(.hud-tab-bar) {
    flex: 1;
  }

  .hud-pin-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    background: var(--background-secondary);
    border: none;
    border-bottom: 1px solid var(--background-modifier-border);
    border-left: 1px solid var(--background-modifier-border);
    cursor: pointer;
    opacity: 0.5;
    transition: opacity 0.15s ease;
  }

  .hud-pin-btn:hover {
    opacity: 1;
  }

  .hud-pin-btn.is-pinned {
    opacity: 1;
    background: var(--background-modifier-hover);
  }

  .hud-content {
    flex: 1;
    overflow-y: auto;
    padding: var(--size-4-3);
  }
</style>

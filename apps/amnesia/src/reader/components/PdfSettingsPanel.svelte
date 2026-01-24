<script lang="ts">
  /**
   * PdfSettingsPanel
   *
   * PDF-specific settings panel with reading modes, zoom, rotation,
   * and display controls.
   */
  import { createEventDispatcher } from 'svelte';
  import { setIcon } from 'obsidian';
  import {
    ZoomIn,
    ZoomOut,
    RotateCw,
    RotateCcw,
    Maximize,
    ArrowLeftRight,
    Printer,
    Sun,
    Moon,
    Monitor,
    Sunset,
    Coffee,
    BookOpen,
    ScrollText,
  } from 'lucide-svelte';
  import type { PdfSettings, PdfPageLayout, PdfReadingMode, PdfDisplayMode } from '../../settings/settings';

  export let settings: PdfSettings;
  export let visible = false;
  export let currentPage = 1;
  export let totalPages = 0;

  const dispatch = createEventDispatcher<{
    change: { settings: Partial<PdfSettings> };
    zoomIn: void;
    zoomOut: void;
    fitWidth: void;
    fitPage: void;
    rotateCw: void;
    rotateCcw: void;
    print: void;
    close: void;
  }>();

  // Collapsible sections
  let expandedSections: Record<string, boolean> = {
    displayMode: true,
    readingMode: true,
    zoom: true,
    rotation: false,
    layout: false,
  };

  $: currentReadingMode = settings.readingMode;
  $: currentDisplayMode = settings.displayMode;
  $: scalePercent = Math.round(settings.scale * 100);

  function toggleSection(section: string) {
    expandedSections[section] = !expandedSections[section];
    expandedSections = expandedSections;
  }

  function handleReadingModeChange(mode: PdfReadingMode) {
    dispatch('change', { settings: { readingMode: mode } });
  }

  function handleDisplayModeChange(mode: PdfDisplayMode) {
    dispatch('change', { settings: { displayMode: mode } });
  }

  function handleScaleChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const scale = parseFloat(target.value);
    dispatch('change', { settings: { scale } });
  }

  function handleScalePreset(preset: number) {
    dispatch('change', { settings: { scale: preset / 100 } });
  }

  function handleLayoutChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    dispatch('change', { settings: { pageLayout: target.value as PdfPageLayout } });
  }

  function setIconEl(node: HTMLElement, icon: string) {
    setIcon(node, icon);
  }

  function handleClose() {
    dispatch('close');
  }
</script>

{#if visible}
  <div class="graph-controls pdf-settings" data-ignore-swipe="true">
    <div class="clickable-icon graph-controls-button mod-close" aria-label="Close" on:click={handleClose} on:keydown={(e) => e.key === 'Enter' && handleClose()} role="button" tabindex="0">
      <span use:setIconEl={'x'}></span>
    </div>

    <!-- Display Mode Section -->
    <div class="tree-item graph-control-section">
      <div class="tree-item-self mod-collapsible" class:is-collapsed={!expandedSections.displayMode} on:click={() => toggleSection('displayMode')} on:keydown={(e) => e.key === 'Enter' && toggleSection('displayMode')} role="button" tabindex="0">
        <div class="tree-item-icon collapse-icon">
          <span use:setIconEl={'right-triangle'}></span>
        </div>
        <div class="tree-item-inner">
          <header class="graph-control-section-header">Display Mode</header>
        </div>
      </div>

      {#if expandedSections.displayMode}
        <div class="tree-item-children">
          <div class="display-mode-buttons">
            <button class="mode-btn" class:active={currentDisplayMode === 'paginated'} on:click={() => handleDisplayModeChange('paginated')} title="Paginated (Horizontal)">
              <BookOpen size={18} />
              <span>Paginated</span>
            </button>
            <button class="mode-btn" class:active={currentDisplayMode === 'scrolled'} on:click={() => handleDisplayModeChange('scrolled')} title="Scrolled (Vertical)">
              <ScrollText size={18} />
              <span>Scrolled</span>
            </button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Reading Mode Section -->
    <div class="tree-item graph-control-section">
      <div class="tree-item-self mod-collapsible" class:is-collapsed={!expandedSections.readingMode} on:click={() => toggleSection('readingMode')} on:keydown={(e) => e.key === 'Enter' && toggleSection('readingMode')} role="button" tabindex="0">
        <div class="tree-item-icon collapse-icon">
          <span use:setIconEl={'right-triangle'}></span>
        </div>
        <div class="tree-item-inner">
          <header class="graph-control-section-header">Reading Mode</header>
        </div>
      </div>

      {#if expandedSections.readingMode}
        <div class="tree-item-children">
          <div class="reading-mode-buttons">
            <button class="mode-btn" class:active={currentReadingMode === 'device'} on:click={() => handleReadingModeChange('device')} title="Match Obsidian theme">
              <Monitor size={16} />
              <span>Device</span>
            </button>
            <button class="mode-btn" class:active={currentReadingMode === 'light'} on:click={() => handleReadingModeChange('light')} title="White background">
              <Sun size={16} />
              <span>Light</span>
            </button>
            <button class="mode-btn" class:active={currentReadingMode === 'sepia'} on:click={() => handleReadingModeChange('sepia')} title="Warm sepia tone">
              <Coffee size={16} />
              <span>Sepia</span>
            </button>
            <button class="mode-btn" class:active={currentReadingMode === 'dark'} on:click={() => handleReadingModeChange('dark')} title="Inverted colors">
              <Moon size={16} />
              <span>Dark</span>
            </button>
            <button class="mode-btn" class:active={currentReadingMode === 'night'} on:click={() => handleReadingModeChange('night')} title="Dark with warm tint">
              <Sunset size={16} />
              <span>Night</span>
            </button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Zoom Section -->
    <div class="tree-item graph-control-section">
      <div class="tree-item-self mod-collapsible" class:is-collapsed={!expandedSections.zoom} on:click={() => toggleSection('zoom')} on:keydown={(e) => e.key === 'Enter' && toggleSection('zoom')} role="button" tabindex="0">
        <div class="tree-item-icon collapse-icon">
          <span use:setIconEl={'right-triangle'}></span>
        </div>
        <div class="tree-item-inner">
          <header class="graph-control-section-header">Zoom</header>
        </div>
      </div>

      {#if expandedSections.zoom}
        <div class="tree-item-children">
          <div class="zoom-controls">
            <button class="zoom-btn" on:click={() => dispatch('zoomOut')} title="Zoom out">
              <ZoomOut size={18} />
            </button>
            <div class="zoom-value">{scalePercent}%</div>
            <button class="zoom-btn" on:click={() => dispatch('zoomIn')} title="Zoom in">
              <ZoomIn size={18} />
            </button>
          </div>

          <div class="setting-item mod-slider">
            <div class="setting-item-control" style="width: 100%;">
              <input class="slider" type="range" min="0.1" max="32" step="0.1" value={settings.scale} on:input={handleScaleChange} data-ignore-swipe="true" />
            </div>
          </div>

          <div class="fit-buttons">
            <button class="fit-btn" on:click={() => dispatch('fitWidth')} title="Fit to width">
              <ArrowLeftRight size={16} />
              <span>Fit Width</span>
            </button>
            <button class="fit-btn" on:click={() => dispatch('fitPage')} title="Fit to page">
              <Maximize size={16} />
              <span>Fit Page</span>
            </button>
          </div>

          <div class="zoom-presets">
            {#each [50, 75, 100, 150, 200, 400, 800, 1600] as preset}
              <button class="preset-btn" class:active={scalePercent === preset} on:click={() => handleScalePreset(preset)}>
                {preset}%
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <!-- Rotation Section -->
    <div class="tree-item graph-control-section">
      <div class="tree-item-self mod-collapsible" class:is-collapsed={!expandedSections.rotation} on:click={() => toggleSection('rotation')} on:keydown={(e) => e.key === 'Enter' && toggleSection('rotation')} role="button" tabindex="0">
        <div class="tree-item-icon collapse-icon">
          <span use:setIconEl={'right-triangle'}></span>
        </div>
        <div class="tree-item-inner">
          <header class="graph-control-section-header">Rotation</header>
        </div>
      </div>

      {#if expandedSections.rotation}
        <div class="tree-item-children">
          <div class="rotation-controls">
            <button class="rotate-btn" on:click={() => dispatch('rotateCcw')} title="Rotate counter-clockwise">
              <RotateCcw size={20} />
            </button>
            <div class="rotation-value">{settings.rotation}°</div>
            <button class="rotate-btn" on:click={() => dispatch('rotateCw')} title="Rotate clockwise">
              <RotateCw size={20} />
            </button>
          </div>

          <div class="rotation-presets">
            {#each [0, 90, 180, 270] as preset}
              <button class="preset-btn" class:active={settings.rotation === preset} on:click={() => dispatch('change', { settings: { rotation: preset } })}>
                {preset}°
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <!-- Layout Section -->
    <div class="tree-item graph-control-section">
      <div class="tree-item-self mod-collapsible" class:is-collapsed={!expandedSections.layout} on:click={() => toggleSection('layout')} on:keydown={(e) => e.key === 'Enter' && toggleSection('layout')} role="button" tabindex="0">
        <div class="tree-item-icon collapse-icon">
          <span use:setIconEl={'right-triangle'}></span>
        </div>
        <div class="tree-item-inner">
          <header class="graph-control-section-header">Layout</header>
        </div>
      </div>

      {#if expandedSections.layout}
        <div class="tree-item-children">
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Page Layout</div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" value={settings.pageLayout} on:change={handleLayoutChange}>
                <option value="single">Single Page</option>
                <option value="dual">Two Pages</option>
                <option value="book">Book Spread</option>
              </select>
            </div>
          </div>

          <div class="setting-item">
            <button class="print-btn" on:click={() => dispatch('print')}>
              <Printer size={18} />
              <span>Print PDF</span>
            </button>
          </div>
        </div>
      {/if}
    </div>

    {#if totalPages > 0}
      <div class="page-info">
        Page {currentPage} of {totalPages}
      </div>
    {/if}
  </div>
{/if}

<style>
  .pdf-settings {
    position: relative !important;
    width: 100% !important;
    height: 100%;
    max-height: 100%;
    overflow-y: auto;
    padding: 12px;
    box-sizing: border-box;
  }

  .display-mode-buttons {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    padding: 8px 0;
  }

  .reading-mode-buttons {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding: 8px 0;
  }

  .reading-mode-buttons .mode-btn {
    padding: 8px 4px;
    font-size: 0.7rem;
  }

  .mode-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px 8px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    cursor: pointer;
    transition: all 0.15s ease;
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .mode-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .mode-btn.active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-color: var(--interactive-accent);
  }

  .zoom-controls,
  .rotation-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 8px 0;
  }

  .zoom-btn,
  .rotate-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    cursor: pointer;
    transition: all 0.15s ease;
    color: var(--text-muted);
  }

  .zoom-btn:hover,
  .rotate-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .zoom-value,
  .rotation-value {
    font-size: 1rem;
    font-weight: 600;
    min-width: 50px;
    text-align: center;
    color: var(--text-normal);
  }

  .fit-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding: 8px 0;
  }

  .fit-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 12px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    cursor: pointer;
    transition: all 0.15s ease;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .fit-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .zoom-presets,
  .rotation-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 0;
  }

  .preset-btn {
    padding: 6px 10px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    cursor: pointer;
    transition: all 0.15s ease;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .preset-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .preset-btn.active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-color: var(--interactive-accent);
  }

  .print-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 10px 16px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    cursor: pointer;
    transition: all 0.15s ease;
    color: var(--text-normal);
    font-size: 0.9rem;
  }

  .print-btn:hover {
    background: var(--background-modifier-hover);
  }

  .page-info {
    padding: 12px;
    text-align: center;
    font-size: 0.8rem;
    color: var(--text-muted);
    border-top: 1px solid var(--background-modifier-border);
    margin-top: 12px;
  }

  .collapse-icon {
    transition: transform 0.2s ease;
  }

  .tree-item-self:not(.is-collapsed) .collapse-icon {
    transform: rotate(90deg);
  }
</style>

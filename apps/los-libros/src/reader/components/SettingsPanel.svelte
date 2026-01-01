<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { setIcon } from 'obsidian';
  import {
    type ReaderSettings,
    type ThemePreset,
    type TapZoneAction,
    type PageAnimation,
    getFontFamilies,
    getThemeColors,
  } from '../reader-settings';
  import { HapticFeedback } from '../../utils/haptics';

  export let settings: ReaderSettings;
  export let visible = false;
  export let isFullScreen = false;

  // Font families (includes Obsidian's configured fonts)
  let fontFamilies: { value: string; label: string }[] = [];

  onMount(() => {
    fontFamilies = getFontFamilies();
  });

  const dispatch = createEventDispatcher<{
    change: { settings: Partial<ReaderSettings> };
    close: void;
    fullscreenToggle: void;
  }>();

  // Collapsible sections state
  let expandedSections: Record<string, boolean> = {
    display: true,
    typography: false,
    navigation: false,
    gestures: false,
    highlights: false,
  };

  // Theme options
  const themes: { value: ThemePreset; label: string }[] = [
    { value: 'system', label: 'System (Obsidian)' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'sepia', label: 'Sepia' },
    { value: 'night', label: 'Night' },
    { value: 'paper', label: 'Paper' },
    { value: 'forest', label: 'Forest' },
  ];

  // Tap zone action options
  const tapZoneActions: { value: TapZoneAction; label: string }[] = [
    { value: 'prev-page', label: 'Previous Page' },
    { value: 'next-page', label: 'Next Page' },
    { value: 'toggle-ui', label: 'Toggle UI' },
    { value: 'bookmark', label: 'Bookmark' },
    { value: 'none', label: 'None' },
  ];

  function toggleSection(event: MouseEvent, section: string) {
    event.stopPropagation();
    event.preventDefault();
    expandedSections[section] = !expandedSections[section];
    expandedSections = expandedSections;
  }

  function handleChange(changes: Partial<ReaderSettings>) {
    HapticFeedback.light();
    dispatch('change', { settings: changes });
  }

  function handleThemeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    handleChange({ theme: target.value as ThemePreset });
  }

  function handleBrightnessChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const value = parseInt(target.value, 10);
    handleChange({ brightness: value });
  }

  function handleFontSizeChange(delta: number): void {
    let newSize = settings.fontSize + delta;
    if (newSize < 10) newSize = 10;
    if (newSize > 40) newSize = 40;
    handleChange({ fontSize: newSize });
  }

  function handleColumnsChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    handleChange({ columns: target.value as 'single' | 'dual' | 'auto' });
  }

  function handleFlowChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    handleChange({ flow: target.value as 'paginated' | 'scrolled' });
    // Close settings panel when switching reading mode to show the mode change
    dispatch('close');
  }

  function handlePageAnimationChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    handleChange({ pageAnimation: target.value as PageAnimation });
  }

  function handleTextAlignChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    handleChange({ textAlign: target.value as 'left' | 'justify' });
  }

  function handleLineHeightChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const value = parseFloat(target.value);
    handleChange({ lineHeight: value });
  }

  function handleFontFamilyChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    handleChange({ fontFamily: target.value });
  }

  function handleMarginChange(side: 'top' | 'bottom' | 'left' | 'right', event: Event) {
    const target = event.target as HTMLInputElement;
    const value = parseInt(target.value, 10);
    handleChange({
      margins: { ...settings.margins, [side]: value }
    });
  }

  function handleUnifiedMarginChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const value = parseInt(target.value, 10);
    // Apply same margin value to all sides (renderer only supports single margin)
    handleChange({
      margins: { top: value, bottom: value, left: value, right: value }
    });
  }

  function handleFullscreenToggle() {
    HapticFeedback.light();
    dispatch('fullscreenToggle');
  }

  function handleTapZoneChange(zone: 'left' | 'center' | 'right', event: Event) {
    const target = event.target as HTMLSelectElement;
    handleChange({
      tapZones: { ...settings.tapZones, [zone]: target.value as TapZoneAction }
    });
  }

  function handleAutoScrollSpeedChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const value = parseInt(target.value, 10);
    handleChange({ autoScroll: { ...settings.autoScroll, speed: value } });
  }

  function handleLongPressDurationChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const value = parseInt(target.value, 10);
    handleChange({ longPressDuration: value });
  }

  function handleHapticFeedbackChange(event: Event) {
    const target = event.target as HTMLInputElement;
    handleChange({ hapticFeedback: target.checked });
  }

  function handleInstantHighlightModeChange(event: Event) {
    const target = event.target as HTMLInputElement;
    handleChange({ instantHighlightMode: target.checked });
  }

  function handleHighlightingInstantChange(event: Event) {
    const target = event.target as HTMLInputElement;
    handleChange({ highlighting: { ...settings.highlighting, instantHighlight: target.checked } });
  }

  function handleHighlightingPopupChange(event: Event) {
    const target = event.target as HTMLInputElement;
    handleChange({ highlighting: { ...settings.highlighting, showPopupOnExisting: target.checked } });
  }

  function handleHighlightingCopyChange(event: Event) {
    const target = event.target as HTMLInputElement;
    handleChange({ highlighting: { ...settings.highlighting, autoCopyToClipboard: target.checked } });
  }

  function handleHighlightingDeleteChange(event: Event) {
    const target = event.target as HTMLInputElement;
    handleChange({ highlighting: { ...settings.highlighting, confirmDelete: target.checked } });
  }

  function handleHighlightColorChange(color: string) {
    handleChange({ highlighting: { ...settings.highlighting, lastUsedColor: color } });
  }

  function setIconEl(node: HTMLElement, icon: string) {
    setIcon(node, icon);
  }

  function handleClose(event: MouseEvent) {
    event.stopPropagation();
    dispatch('close');
  }
</script>

{#if visible}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="graph-controls los-libros-settings" on:click|stopPropagation data-ignore-swipe="true">
    <div class="clickable-icon graph-controls-button mod-close" aria-label="Close" on:click={handleClose}>
      <span use:setIconEl={'x'}></span>
    </div>

    <!-- Display Section -->
    <div class="tree-item graph-control-section mod-display">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <div
        class="tree-item-self mod-collapsible"
        class:is-collapsed={!expandedSections.display}
        on:click={(e) => toggleSection(e, 'display')}
      >
        <div class="tree-item-icon collapse-icon">
          <span use:setIconEl={'right-triangle'}></span>
        </div>
        <div class="tree-item-inner">
          <header class="graph-control-section-header">Display</header>
        </div>
      </div>

      {#if expandedSections.display}
        <div class="tree-item-children">
          <!-- Brightness -->
          <div class="setting-item mod-slider">
            <div class="setting-item-info">
              <div class="setting-item-name">Brightness</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <input
                class="slider"
                type="range"
                min="20"
                max="100"
                value={settings.brightness}
                on:input={handleBrightnessChange}
                on:click|stopPropagation
                data-ignore-swipe="true"
              />
            </div>
          </div>

          <!-- Theme -->
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Theme</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" value={settings.theme} on:change|stopPropagation={handleThemeChange}>
                {#each themes as theme}
                  <option value={theme.value}>{theme.label}</option>
                {/each}
              </select>
            </div>
          </div>

          <!-- Columns -->
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Columns</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" value={settings.columns} on:change|stopPropagation={handleColumnsChange}>
                <option value="single">Single</option>
                <option value="dual">Dual</option>
                <option value="auto">Auto</option>
              </select>
            </div>
          </div>

          <!-- Reading Mode -->
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Reading Mode</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" value={settings.flow} on:change|stopPropagation={handleFlowChange}>
                <option value="paginated">Paginated</option>
                <option value="scrolled">Scrolled</option>
              </select>
            </div>
          </div>

          <!-- Page Animation -->
          {#if settings.flow === 'paginated'}
            <div class="setting-item">
              <div class="setting-item-info">
                <div class="setting-item-name">Page Animation</div>
                <div class="setting-item-description"></div>
              </div>
              <div class="setting-item-control">
                <select class="dropdown" value={settings.pageAnimation} on:change|stopPropagation={handlePageAnimationChange}>
                  <option value="none">None</option>
                  <option value="slide">Slide</option>
                  <option value="curl">Curl</option>
                </select>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Typography Section -->
    <div class="tree-item graph-control-section mod-typography">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <div
        class="tree-item-self mod-collapsible"
        class:is-collapsed={!expandedSections.typography}
        on:click={(e) => toggleSection(e, 'typography')}
      >
        <div class="tree-item-icon collapse-icon">
          <span use:setIconEl={'right-triangle'}></span>
        </div>
        <div class="tree-item-inner">
          <header class="graph-control-section-header">Typography</header>
        </div>
      </div>

      {#if expandedSections.typography}
        <div class="tree-item-children">
          <!-- Font Size -->
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Font Size</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control" style="display: flex; align-items: center; gap: 8px;">
              <button class="clickable-icon" on:click|stopPropagation={() => handleFontSizeChange(-2)} disabled={settings.fontSize <= 10}>
                <span use:setIconEl={'minus'}></span>
              </button>
              <span style="min-width: 40px; text-align: center;">{settings.fontSize}px</span>
              <button class="clickable-icon" on:click|stopPropagation={() => handleFontSizeChange(2)} disabled={settings.fontSize >= 40}>
                <span use:setIconEl={'plus'}></span>
              </button>
            </div>
          </div>

          <!-- Font Family -->
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Font Family</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" value={settings.fontFamily} on:change|stopPropagation={handleFontFamilyChange}>
                {#each fontFamilies as font}
                  <option value={font.value}>{font.label}</option>
                {/each}
              </select>
            </div>
          </div>

          <!-- Line Height -->
          <div class="setting-item mod-slider">
            <div class="setting-item-info">
              <div class="setting-item-name">Line Height</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <input
                class="slider"
                type="range"
                min="1.0"
                max="2.5"
                step="0.1"
                value={settings.lineHeight}
                on:input|stopPropagation={handleLineHeightChange}
                data-ignore-swipe="true"
              />
            </div>
          </div>

          <!-- Text Alignment -->
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Text Alignment</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" value={settings.textAlign} on:change|stopPropagation={handleTextAlignChange}>
                <option value="left">Left</option>
                <option value="justify">Justify</option>
              </select>
            </div>
          </div>

          <!-- Margins (single value - applies to all sides) -->
          <div class="setting-item mod-slider">
            <div class="setting-item-info">
              <div class="setting-item-name">Margins</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control" style="display: flex; align-items: center; gap: 8px;">
              <input
                class="slider"
                type="range"
                min="0"
                max="60"
                step="5"
                value={settings.margins.left}
                on:input|stopPropagation={handleUnifiedMarginChange}
                data-ignore-swipe="true"
              />
              <span style="min-width: 40px; text-align: right;">{settings.margins.left}px</span>
            </div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Navigation Section -->
    <div class="tree-item graph-control-section mod-navigation">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <div
        class="tree-item-self mod-collapsible"
        class:is-collapsed={!expandedSections.navigation}
        on:click={(e) => toggleSection(e, 'navigation')}
      >
        <div class="tree-item-icon collapse-icon">
          <span use:setIconEl={'right-triangle'}></span>
        </div>
        <div class="tree-item-inner">
          <header class="graph-control-section-header">Navigation</header>
        </div>
      </div>

      {#if expandedSections.navigation}
        <div class="tree-item-children">
          <!-- Tap Zones -->
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Left tap zone</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" value={settings.tapZones.left} on:change|stopPropagation={(e) => handleTapZoneChange('left', e)}>
                {#each tapZoneActions as action}
                  <option value={action.value}>{action.label}</option>
                {/each}
              </select>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Center tap zone</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" value={settings.tapZones.center} on:change|stopPropagation={(e) => handleTapZoneChange('center', e)}>
                {#each tapZoneActions as action}
                  <option value={action.value}>{action.label}</option>
                {/each}
              </select>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Right tap zone</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" value={settings.tapZones.right} on:change|stopPropagation={(e) => handleTapZoneChange('right', e)}>
                {#each tapZoneActions as action}
                  <option value={action.value}>{action.label}</option>
                {/each}
              </select>
            </div>
          </div>

          <!-- Auto-scroll Speed -->
          <div class="setting-item mod-slider">
            <div class="setting-item-info">
              <div class="setting-item-name">Auto-scroll speed</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <input
                class="slider"
                type="range"
                min="1"
                max="10"
                value={settings.autoScroll?.speed ?? 5}
                on:input|stopPropagation={handleAutoScrollSpeedChange}
                data-ignore-swipe="true"
              />
            </div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Gestures Section -->
    <div class="tree-item graph-control-section mod-gestures">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <div
        class="tree-item-self mod-collapsible"
        class:is-collapsed={!expandedSections.gestures}
        on:click={(e) => toggleSection(e, 'gestures')}
      >
        <div class="tree-item-icon collapse-icon">
          <span use:setIconEl={'right-triangle'}></span>
        </div>
        <div class="tree-item-inner">
          <header class="graph-control-section-header">Gestures</header>
        </div>
      </div>

      {#if expandedSections.gestures}
        <div class="tree-item-children">
          <!-- Haptic Feedback -->
          <div class="setting-item mod-toggle">
            <div class="setting-item-info">
              <div class="setting-item-name">Haptic feedback</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <label class="checkbox-container" class:is-enabled={settings.hapticFeedback} tabindex="0">
                <input type="checkbox" checked={settings.hapticFeedback} on:change|stopPropagation={handleHapticFeedbackChange} tabindex="0" />
              </label>
            </div>
          </div>

          <!-- Instant Highlight -->
          <div class="setting-item mod-toggle">
            <div class="setting-item-info">
              <div class="setting-item-name">Instant highlight (long press)</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <label class="checkbox-container" class:is-enabled={settings.instantHighlightMode} tabindex="0">
                <input type="checkbox" checked={settings.instantHighlightMode} on:change|stopPropagation={handleInstantHighlightModeChange} tabindex="0" />
              </label>
            </div>
          </div>

          <!-- Long Press Duration -->
          <div class="setting-item mod-slider">
            <div class="setting-item-info">
              <div class="setting-item-name">Long press duration</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <input
                class="slider"
                type="range"
                min="200"
                max="1000"
                step="50"
                value={settings.longPressDuration}
                on:input|stopPropagation={handleLongPressDurationChange}
                data-ignore-swipe="true"
              />
            </div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Highlights Section -->
    <div class="tree-item graph-control-section mod-highlights">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <div
        class="tree-item-self mod-collapsible"
        class:is-collapsed={!expandedSections.highlights}
        on:click={(e) => toggleSection(e, 'highlights')}
      >
        <div class="tree-item-icon collapse-icon">
          <span use:setIconEl={'right-triangle'}></span>
        </div>
        <div class="tree-item-inner">
          <header class="graph-control-section-header">Highlights</header>
        </div>
      </div>

      {#if expandedSections.highlights}
        <div class="tree-item-children">
          <!-- Instant Highlight Mode -->
          <div class="setting-item mod-toggle">
            <div class="setting-item-info">
              <div class="setting-item-name">Instant highlight</div>
              <div class="setting-item-description">Create highlight on selection</div>
            </div>
            <div class="setting-item-control">
              <label class="checkbox-container" class:is-enabled={settings.highlighting?.instantHighlight ?? false} tabindex="0">
                <input type="checkbox" checked={settings.highlighting?.instantHighlight ?? false} on:change|stopPropagation={handleHighlightingInstantChange} tabindex="0" />
              </label>
            </div>
          </div>

          <!-- Show Popup on Existing -->
          <div class="setting-item mod-toggle">
            <div class="setting-item-info">
              <div class="setting-item-name">Show popup on existing</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <label class="checkbox-container" class:is-enabled={settings.highlighting?.showPopupOnExisting ?? true} tabindex="0">
                <input type="checkbox" checked={settings.highlighting?.showPopupOnExisting ?? true} on:change|stopPropagation={handleHighlightingPopupChange} tabindex="0" />
              </label>
            </div>
          </div>

          <!-- Auto-copy to Clipboard -->
          <div class="setting-item mod-toggle">
            <div class="setting-item-info">
              <div class="setting-item-name">Auto-copy to clipboard</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <label class="checkbox-container" class:is-enabled={settings.highlighting?.autoCopyToClipboard ?? false} tabindex="0">
                <input type="checkbox" checked={settings.highlighting?.autoCopyToClipboard ?? false} on:change|stopPropagation={handleHighlightingCopyChange} tabindex="0" />
              </label>
            </div>
          </div>

          <!-- Confirm Delete -->
          <div class="setting-item mod-toggle">
            <div class="setting-item-info">
              <div class="setting-item-name">Confirm before delete</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control">
              <label class="checkbox-container" class:is-enabled={settings.highlighting?.confirmDelete ?? true} tabindex="0">
                <input type="checkbox" checked={settings.highlighting?.confirmDelete ?? true} on:change|stopPropagation={handleHighlightingDeleteChange} tabindex="0" />
              </label>
            </div>
          </div>

          <!-- Default Highlight Color -->
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Default color</div>
              <div class="setting-item-description"></div>
            </div>
            <div class="setting-item-control" style="display: flex; gap: 6px;">
              {#each ['yellow', 'green', 'blue', 'pink', 'purple'] as color}
                <button
                  class="los-libros-color-btn"
                  class:is-active={(settings.highlighting?.lastUsedColor ?? 'yellow') === color}
                  style="background-color: {color === 'yellow' ? '#fef3c7' : color === 'green' ? '#d1fae5' : color === 'blue' ? '#dbeafe' : color === 'pink' ? '#fce7f3' : '#ede9fe'};"
                  on:click|stopPropagation={() => handleHighlightColorChange(color)}
                  title={color}
                ></button>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Override Obsidian's default graph-controls absolute positioning */
  .los-libros-settings {
    position: relative !important;
    width: 100% !important;
    height: 100%;
    max-height: 100%;
    overflow-y: auto;
    padding: 12px;
    box-sizing: border-box;
  }

  .los-libros-color-btn {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
    transition: transform 0.1s ease;
  }

  .los-libros-color-btn:hover {
    transform: scale(1.1);
  }

  .los-libros-color-btn.is-active {
    border-color: var(--text-normal);
  }

  /* Collapse icon rotation animation */
  .collapse-icon {
    transition: transform 0.2s ease;
  }

  .tree-item-self:not(.is-collapsed) .collapse-icon {
    transform: rotate(90deg);
  }
</style>

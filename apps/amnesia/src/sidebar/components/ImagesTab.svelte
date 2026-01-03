<script lang="ts">
  /**
   * Images Tab Component
   *
   * Displays book images with Obsidian Bases-style view configuration.
   * Supports Cards and List layouts with customizable settings.
   */
  import { createEventDispatcher } from 'svelte';
  import { setIcon } from 'obsidian';
  import {
    Image,
    LayoutGrid,
    List,
    ChevronLeft,
    MoreHorizontal,
    X,
    Settings2,
    ArrowUpDown,
  } from 'lucide-svelte';

  export interface BookImage {
    id: string;
    href: string;
    blobUrl: string;
    spineIndex: number;
    spineHref: string;
    /** Original EPUB path for the image (e.g., 'images/cover.jpg') */
    originalHref?: string;
    alt?: string;
    title?: string;
    width?: number;
    height?: number;
    fileSize?: number; // File size in bytes
  }

  export let images: BookImage[] = [];
  export let loading = false;

  const dispatch = createEventDispatcher<{
    navigate: { spineIndex: number; imageHref: string };
  }>();

  // View configuration state
  let showConfigPanel = false;
  let showSortMenu = false;
  let layout: 'cards' | 'list' = 'cards';
  let cardSize = 100; // 50-400 (matches Bases behavior)
  let imageFit: 'cover' | 'contain' | 'fill' = 'cover';
  let aspectRatio = 1; // 0.5 - 2.0 (height/width ratio)
  let showTitles = true;
  let sortBy: 'appearance' | 'name-asc' | 'name-desc' | 'resolution-asc' | 'resolution-desc' | 'filesize-asc' | 'filesize-desc' = 'appearance';

  // Sort options with labels
  const sortOptions = [
    { value: 'appearance', label: 'Appearance' },
    { value: 'name-asc', label: 'Name (A-Z)' },
    { value: 'name-desc', label: 'Name (Z-A)' },
    { value: 'resolution-asc', label: 'Resolution (small)' },
    { value: 'resolution-desc', label: 'Resolution (large)' },
    { value: 'filesize-asc', label: 'File size (small)' },
    { value: 'filesize-desc', label: 'File size (large)' },
  ] as const;

  $: currentSortLabel = sortOptions.find(o => o.value === sortBy)?.label || 'Sort';

  function toggleSortMenu() {
    showSortMenu = !showSortMenu;
    if (showSortMenu) showConfigPanel = false;
  }

  function closeSortMenu() {
    showSortMenu = false;
  }

  function selectSort(value: typeof sortBy) {
    sortBy = value;
    showSortMenu = false;
  }

  // Computed aspect ratio for CSS (inverted so higher slider = taller cards)
  // CSS aspect-ratio is width/height, so we use 1/aspectRatio
  $: aspectRatioValue = (1 / aspectRatio).toFixed(2);

  // Sorted images based on sort selection
  $: sortedImages = sortImages(images, sortBy);

  function sortImages(imgs: BookImage[], sort: typeof sortBy): BookImage[] {
    if (sort === 'appearance') {
      return imgs; // Original order from EPUB
    }

    const sorted = [...imgs];
    switch (sort) {
      case 'name-asc':
        sorted.sort((a, b) => {
          const nameA = getImageTitle(a, 0).toLowerCase();
          const nameB = getImageTitle(b, 0).toLowerCase();
          return nameA.localeCompare(nameB);
        });
        break;
      case 'name-desc':
        sorted.sort((a, b) => {
          const nameA = getImageTitle(a, 0).toLowerCase();
          const nameB = getImageTitle(b, 0).toLowerCase();
          return nameB.localeCompare(nameA);
        });
        break;
      case 'resolution-asc':
        sorted.sort((a, b) => {
          const resA = (a.width || 0) * (a.height || 0);
          const resB = (b.width || 0) * (b.height || 0);
          return resA - resB;
        });
        break;
      case 'resolution-desc':
        sorted.sort((a, b) => {
          const resA = (a.width || 0) * (a.height || 0);
          const resB = (b.width || 0) * (b.height || 0);
          return resB - resA;
        });
        break;
      case 'filesize-asc':
        sorted.sort((a, b) => {
          const sizeA = a.fileSize || 0;
          const sizeB = b.fileSize || 0;
          return sizeA - sizeB;
        });
        break;
      case 'filesize-desc':
        sorted.sort((a, b) => {
          const sizeA = a.fileSize || 0;
          const sizeB = b.fileSize || 0;
          return sizeB - sizeA;
        });
        break;
    }
    return sorted;
  }

  function handleImageClick(image: BookImage, index: number) {
    dispatch('navigate', { spineIndex: image.spineIndex, imageHref: image.href });
  }

  function toggleConfigPanel() {
    showConfigPanel = !showConfigPanel;
    if (showConfigPanel) showSortMenu = false;
  }

  function closeConfigPanel() {
    showConfigPanel = false;
  }

  function getImageTitle(image: BookImage, index: number): string {
    // Priority: title > alt > originalHref filename > spineHref derived > "Image N"
    if (image.title) return image.title;
    if (image.alt) return image.alt;

    // Try to extract filename from original EPUB path
    if (image.originalHref && !image.originalHref.startsWith('blob:')) {
      const filename = image.originalHref.split('/').pop() || '';
      const cleanName = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      if (cleanName) return cleanName;
    }

    // Try to derive from spineHref (chapter name)
    if (image.spineHref) {
      const chapterName = image.spineHref.split('/').pop() || '';
      const cleanChapter = chapterName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      if (cleanChapter && cleanChapter.length < 30) {
        return `${cleanChapter} - Image`;
      }
    }

    // Final fallback: numbered image
    return `Image ${index + 1}`;
  }

  function setIconEl(node: HTMLElement, icon: string) {
    setIcon(node, icon);
  }
</script>

<div class="images-tab">
  {#if loading}
    <div class="images-empty-state">
      <div class="amnesia-spinner"></div>
      <div class="images-empty-message">Loading images...</div>
    </div>
  {:else if images.length === 0}
    <div class="images-empty-state">
      <Image size={32} strokeWidth={1.5} />
      <div class="images-empty-message">No images found</div>
      <div class="images-empty-hint">This book doesn't contain images</div>
    </div>
  {:else}
    <!-- Toolbar with Bases-style view selector -->
    <div class="images-toolbar">
      <button
        class="text-icon-button"
        on:click={toggleConfigPanel}
        aria-label="Configure view"
      >
        <span class="text-button-icon">
          {#if layout === 'cards'}
            <LayoutGrid size={16} />
          {:else}
            <List size={16} />
          {/if}
        </span>
        <span class="text-button-label">{images.length} images</span>
        <span class="text-button-icon mod-aux">
          <span use:setIconEl={'chevrons-up-down'}></span>
        </span>
      </button>

      <div class="toolbar-spacer"></div>

      <!-- Sort button (right-aligned) -->
      <button
        class="text-icon-button"
        on:click={toggleSortMenu}
        aria-label="Sort images"
      >
        <span class="text-button-icon">
          <ArrowUpDown size={16} />
        </span>
        <span class="text-button-label">Sort</span>
      </button>
    </div>

    <!-- Sort Menu -->
    {#if showSortMenu}
      <div class="menu images-sort-menu">
        <div class="menu-scroll">
          {#each sortOptions as option}
            <div
              class="menu-item"
              class:is-selected={sortBy === option.value}
              on:click={() => selectSort(option.value)}
              on:keypress={(e) => e.key === 'Enter' && selectSort(option.value)}
              role="menuitem"
              tabindex="0"
            >
              <span class="menu-item-icon">
                {#if sortBy === option.value}
                  <span use:setIconEl={'check'}></span>
                {/if}
              </span>
              <span class="menu-item-title">{option.label}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Configure View Panel (Bases-style) -->
    {#if showConfigPanel}
      <div class="menu images-config-menu">
        <div class="modal-header">
          <div class="modal-title">Configure view</div>
          <div class="modal-close-button clickable-icon" on:click={closeConfigPanel} on:keypress={(e) => e.key === 'Enter' && closeConfigPanel()} role="button" tabindex="0">
            <X size={16} />
          </div>
        </div>
        <div class="menu-scroll">
          <!-- Layout -->
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Layout</div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" bind:value={layout}>
                <option value="cards">Cards</option>
                <option value="list">List</option>
              </select>
            </div>
          </div>

          <!-- Sort -->
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">Sort</div>
            </div>
            <div class="setting-item-control">
              <select class="dropdown" bind:value={sortBy}>
                <option value="appearance">Appearance</option>
                <option value="name-asc">Name (A-Z)</option>
                <option value="name-desc">Name (Z-A)</option>
                <option value="resolution-asc">Resolution (small)</option>
                <option value="resolution-desc">Resolution (large)</option>
                <option value="filesize-asc">File size (small)</option>
                <option value="filesize-desc">File size (large)</option>
              </select>
            </div>
          </div>

          {#if layout === 'cards'}
            <!-- Card Size -->
            <div class="setting-item">
              <div class="setting-item-info">
                <div class="setting-item-name">Card size</div>
              </div>
              <div class="setting-item-control">
                <input
                  type="range"
                  class="slider"
                  min="50"
                  max="400"
                  step="10"
                  bind:value={cardSize}
                />
              </div>
            </div>

            <!-- Image Fit -->
            <div class="setting-item">
              <div class="setting-item-info">
                <div class="setting-item-name">Image fit</div>
              </div>
              <div class="setting-item-control">
                <select class="dropdown" bind:value={imageFit}>
                  <option value="cover">Cover</option>
                  <option value="contain">Contain</option>
                  <option value="fill">Fill</option>
                </select>
              </div>
            </div>

            <!-- Aspect Ratio -->
            <div class="setting-item">
              <div class="setting-item-info">
                <div class="setting-item-name">Aspect ratio</div>
              </div>
              <div class="setting-item-control">
                <input
                  type="range"
                  class="slider"
                  min="0.5"
                  max="2"
                  step="0.1"
                  bind:value={aspectRatio}
                />
              </div>
            </div>

            <!-- Show Titles -->
            <div class="setting-item mod-toggle">
              <div class="setting-item-info">
                <div class="setting-item-name">Show titles</div>
              </div>
              <div class="setting-item-control">
                <label class="checkbox-container" class:is-enabled={showTitles}>
                  <input type="checkbox" bind:checked={showTitles} />
                </label>
              </div>
            </div>
          {:else}
            <!-- List Thumbnail Size -->
            <div class="setting-item">
              <div class="setting-item-info">
                <div class="setting-item-name">Thumbnail size</div>
              </div>
              <div class="setting-item-control">
                <input
                  type="range"
                  class="slider"
                  min="32"
                  max="120"
                  step="8"
                  bind:value={cardSize}
                />
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Images Content -->
    <div class="images-content">
      {#if layout === 'cards'}
        <!-- Cards Layout -->
        <div
          class="images-cards-grid"
          style="--card-size: {cardSize}px; --aspect-ratio: {aspectRatioValue}; --image-fit: {imageFit};"
        >
          {#each sortedImages as image, index (image.id)}
            <button
              class="images-card"
              class:has-title={showTitles}
              on:click={() => handleImageClick(image, index)}
              title={getImageTitle(image, index)}
            >
              <div class="images-card-cover">
                <img
                  src={image.blobUrl}
                  alt={image.alt || ''}
                  loading="lazy"
                  draggable="false"
                />
              </div>
              {#if showTitles}
                <div class="images-card-label">
                  <span class="images-card-title">{getImageTitle(image, index)}</span>
                </div>
              {/if}
            </button>
          {/each}
        </div>
      {:else}
        <!-- List Layout -->
        <div class="images-list" style="--thumb-size: {cardSize}px;">
          {#each sortedImages as image, index (image.id)}
            <button
              class="images-list-item"
              on:click={() => handleImageClick(image, index)}
            >
              <div class="images-list-thumb">
                <img
                  src={image.blobUrl}
                  alt={image.alt || ''}
                  loading="lazy"
                  draggable="false"
                />
              </div>
              <div class="images-list-info">
                <span class="images-list-title">{getImageTitle(image, index)}</span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .images-tab {
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
  }

  /* Empty state */
  .images-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 32px 16px;
    color: var(--text-muted);
    gap: 8px;
  }

  .images-empty-message {
    font-size: var(--font-ui-medium);
  }

  .images-empty-hint {
    font-size: var(--font-ui-smaller);
    opacity: 0.7;
  }

  /* Toolbar - Bases style */
  .images-toolbar {
    display: flex;
    align-items: center;
    padding: 6px 8px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
    gap: 4px;
  }

  .toolbar-spacer {
    flex: 1;
  }

  .text-icon-button {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: none;
    background: var(--background-modifier-border);
    border-radius: 4px;
    color: var(--text-normal);
    cursor: pointer;
    font-size: var(--font-ui-small);
  }

  .text-icon-button:hover {
    background: var(--background-modifier-hover);
  }

  .text-button-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }

  .text-button-icon.mod-aux {
    opacity: 0.5;
  }

  .text-button-label {
    color: var(--text-normal);
  }

  /* Configure Panel - Bases style menu */
  .images-config-menu {
    position: absolute;
    top: 40px;
    left: 8px;
    z-index: 100;
    min-width: 220px;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    box-shadow: var(--shadow-s);
  }

  /* Sort Menu - Right aligned */
  .images-sort-menu {
    position: absolute;
    top: 40px;
    right: 8px;
    z-index: 100;
    min-width: 160px;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    box-shadow: var(--shadow-s);
  }

  .images-sort-menu .menu-scroll {
    padding: 4px;
  }

  .images-sort-menu .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-ui-small);
    color: var(--text-normal);
  }

  .images-sort-menu .menu-item:hover {
    background: var(--background-modifier-hover);
  }

  .images-sort-menu .menu-item.is-selected {
    background: var(--background-modifier-hover);
    color: var(--text-accent);
  }

  .images-sort-menu .menu-item-icon {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-accent);
  }

  .images-sort-menu .menu-item-title {
    flex: 1;
  }

  .images-config-menu .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .images-config-menu .modal-title {
    font-size: var(--font-ui-small);
    font-weight: 600;
    color: var(--text-normal);
  }

  .images-config-menu .modal-close-button {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border-radius: 4px;
    color: var(--text-muted);
  }

  .images-config-menu .modal-close-button:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .images-config-menu .menu-scroll {
    padding: 8px;
    max-height: 300px;
    overflow-y: auto;
  }

  .images-config-menu .setting-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 4px;
    min-height: 32px;
  }

  .images-config-menu .setting-item-info {
    flex: 1;
  }

  .images-config-menu .setting-item-name {
    font-size: var(--font-ui-small);
    color: var(--text-normal);
  }

  .images-config-menu .setting-item-control {
    flex-shrink: 0;
  }

  .images-config-menu .dropdown {
    padding: 4px 24px 4px 8px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    cursor: pointer;
  }

  .images-config-menu .slider {
    width: 80px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--background-modifier-border);
    border-radius: 2px;
    cursor: pointer;
  }

  .images-config-menu .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--interactive-accent);
    cursor: grab;
    border: 2px solid var(--background-primary);
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  }

  .images-config-menu .checkbox-container {
    width: 34px;
    height: 20px;
    border-radius: 10px;
    background: var(--background-modifier-border);
    position: relative;
    cursor: pointer;
    transition: background 0.2s;
  }

  .images-config-menu .checkbox-container.is-enabled {
    background: var(--interactive-accent);
  }

  .images-config-menu .checkbox-container input {
    opacity: 0;
    width: 100%;
    height: 100%;
    position: absolute;
    cursor: pointer;
  }

  .images-config-menu .checkbox-container::after {
    content: '';
    position: absolute;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    top: 2px;
    left: 2px;
    transition: transform 0.2s;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  }

  .images-config-menu .checkbox-container.is-enabled::after {
    transform: translateX(14px);
  }

  /* Images Content */
  .images-content {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  /* Cards Grid - Bases style */
  .images-cards-grid {
    display: grid;
    /* Cards have minimum size but grow to fill row (like Bases) */
    grid-template-columns: repeat(auto-fill, minmax(var(--card-size), 1fr));
    gap: 8px;
    align-content: start;
  }

  .images-card {
    position: relative;
    display: block; /* Block for proper aspect-ratio support */
    width: 100%; /* Fill grid cell */
    height: auto; /* Let aspect-ratio control height */
    padding: 0;
    border: none;
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    background: var(--background-secondary);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    /* Apply aspect-ratio to the entire card for proper height control */
    aspect-ratio: var(--aspect-ratio);
  }

  .images-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .images-card:focus-visible {
    outline: 2px solid var(--interactive-accent);
    outline-offset: 2px;
  }

  .images-card-cover {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--background-modifier-border);
  }

  .images-card-cover img {
    width: 100%;
    height: 100%;
    object-fit: var(--image-fit);
    display: block;
  }

  .images-card-label {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 6px 8px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
    /* Ensure text is readable over any image */
  }

  .images-card-title {
    font-size: var(--font-ui-smaller);
    color: white;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  }

  /* List Layout */
  .images-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .images-list-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px;
    border: none;
    background: transparent;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    width: 100%;
  }

  .images-list-item:hover {
    background: var(--background-modifier-hover);
  }

  .images-list-item:focus-visible {
    outline: 2px solid var(--interactive-accent);
    outline-offset: -2px;
  }

  .images-list-thumb {
    width: var(--thumb-size);
    height: var(--thumb-size);
    flex-shrink: 0;
    border-radius: 4px;
    overflow: hidden;
    background: var(--background-modifier-border);
  }

  .images-list-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .images-list-info {
    flex: 1;
    min-width: 0;
  }

  .images-list-title {
    font-size: var(--font-ui-small);
    color: var(--text-normal);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Spinner */
  .amnesia-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--background-modifier-border);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>

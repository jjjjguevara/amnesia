<script lang="ts">
  /**
   * Images Tab Component
   *
   * Displays book images as an inline scrollable grid with adjustable thumbnail size.
   * Clicking a thumbnail navigates to the image location in the book content.
   */
  import { createEventDispatcher } from 'svelte';
  import { Image } from 'lucide-svelte';

  export interface BookImage {
    id: string;
    href: string;
    blobUrl: string;
    spineIndex: number;
    spineHref: string;
    width?: number;
    height?: number;
  }

  export let images: BookImage[] = [];
  export let loading = false;

  const dispatch = createEventDispatcher<{
    navigate: { spineIndex: number; imageHref: string };
    openLightbox: { index: number; images: BookImage[] };
  }>();

  // Thumbnail size slider (60-200px)
  let thumbnailSize = 100;

  function handleImageClick(image: BookImage, index: number) {
    dispatch('navigate', { spineIndex: image.spineIndex, imageHref: image.href });
  }

  function handleImageDoubleClick(index: number) {
    dispatch('openLightbox', { index, images });
  }
</script>

<div class="images-tab">
  {#if loading}
    <div class="search-empty-state">
      <div class="los-libros-spinner"></div>
      <div class="search-empty-state-message">Loading images...</div>
    </div>
  {:else if images.length === 0}
    <div class="search-empty-state">
      <Image size={32} strokeWidth={1.5} />
      <div class="search-empty-state-message">No images found</div>
      <div class="search-empty-state-hint">This book doesn't contain images</div>
    </div>
  {:else}
    <div class="images-header">
      <span class="images-count">{images.length} {images.length === 1 ? 'image' : 'images'}</span>
      <div class="size-slider">
        <input
          type="range"
          min="60"
          max="200"
          bind:value={thumbnailSize}
          class="slider"
        />
      </div>
    </div>

    <div class="images-grid" style="--thumb-size: {thumbnailSize}px">
      {#each images as image, index (image.id)}
        <button
          class="image-thumb"
          on:click={() => handleImageClick(image, index)}
          on:dblclick={() => handleImageDoubleClick(index)}
          title={image.href.split('/').pop() || 'Image'}
        >
          <img
            src={image.blobUrl}
            alt=""
            loading="lazy"
            draggable="false"
          />
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .images-tab {
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

  .images-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 4px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .images-count {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .size-slider {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .slider {
    width: 80px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--background-modifier-border);
    border-radius: 2px;
    cursor: pointer;
  }

  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--interactive-accent);
    cursor: grab;
  }

  .slider::-webkit-slider-thumb:active {
    cursor: grabbing;
  }

  .slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--interactive-accent);
    border: none;
    cursor: grab;
  }

  .images-grid {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--thumb-size), 1fr));
    gap: 6px;
    align-content: start;
  }

  .image-thumb {
    aspect-ratio: 1;
    padding: 0;
    border: none;
    border-radius: var(--radius-s);
    overflow: hidden;
    cursor: pointer;
    background: var(--background-secondary);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }

  .image-thumb:hover {
    transform: scale(1.03);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  .image-thumb:focus-visible {
    outline: 2px solid var(--interactive-accent);
    outline-offset: 2px;
  }

  .image-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* Spinner */
  .los-libros-spinner {
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

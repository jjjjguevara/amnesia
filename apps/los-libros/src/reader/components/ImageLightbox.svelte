<script lang="ts">
  /**
   * Image Lightbox Component
   *
   * Fullscreen image viewer with keyboard and touch navigation.
   * - Arrow keys: prev/next
   * - Escape: close
   * - Swipe left/right: prev/next on touch devices
   * - Click outside image: dismiss
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut, Download } from 'lucide-svelte';

  export interface LightboxImage {
    id: string;
    href: string;
    blobUrl: string;
    width?: number;
    height?: number;
  }

  export let images: LightboxImage[] = [];
  export let startIndex = 0;
  export let open = false;

  const dispatch = createEventDispatcher<{
    close: void;
    navigate: { index: number };
  }>();

  let currentIndex = startIndex;
  let zoom = 1;

  // Touch handling
  let touchStartX = 0;
  let touchStartY = 0;
  let touchDeltaX = 0;
  let isSwiping = false;
  const SWIPE_THRESHOLD = 50;

  $: currentImage = images[currentIndex];
  $: canGoPrev = currentIndex > 0;
  $: canGoNext = currentIndex < images.length - 1;

  // Reset index when startIndex changes
  $: if (open) {
    currentIndex = startIndex;
    zoom = 1;
  }

  function close() {
    dispatch('close');
  }

  function prev() {
    if (canGoPrev) {
      currentIndex--;
      zoom = 1;
      dispatch('navigate', { index: currentIndex });
    }
  }

  function next() {
    if (canGoNext) {
      currentIndex++;
      zoom = 1;
      dispatch('navigate', { index: currentIndex });
    }
  }

  function zoomIn() {
    zoom = Math.min(zoom + 0.5, 5);
  }

  function zoomOut() {
    zoom = Math.max(zoom - 0.5, 0.5);
  }

  function resetZoom() {
    zoom = 1;
  }

  async function downloadImage() {
    if (!currentImage) return;
    try {
      const response = await fetch(currentImage.blobUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = currentImage.href.split('/').pop() || `image-${currentImage.id}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to download image:', e);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;

    switch (e.key) {
      case 'Escape':
        close();
        break;
      case 'ArrowLeft':
        prev();
        break;
      case 'ArrowRight':
        next();
        break;
      case '+':
      case '=':
        zoomIn();
        break;
      case '-':
        zoomOut();
        break;
      case '0':
        resetZoom();
        break;
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    // Only close if clicking the backdrop, not the image or controls
    if (e.target === e.currentTarget) {
      close();
    }
  }

  function handleTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchDeltaX = 0;
    isSwiping = false;
  }

  function handleTouchMove(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    const deltaX = e.touches[0].clientX - touchStartX;
    const deltaY = e.touches[0].clientY - touchStartY;

    // Only track horizontal swipes
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      isSwiping = true;
      touchDeltaX = deltaX;
      e.preventDefault();
    }
  }

  function handleTouchEnd() {
    if (!isSwiping) return;

    if (touchDeltaX > SWIPE_THRESHOLD && canGoPrev) {
      prev();
    } else if (touchDeltaX < -SWIPE_THRESHOLD && canGoNext) {
      next();
    }

    touchDeltaX = 0;
    isSwiping = false;
  }

  onMount(() => {
    document.body.style.overflow = 'hidden';
  });

  onDestroy(() => {
    document.body.style.overflow = '';
  });
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open && currentImage}
  <div
    class="lightbox-backdrop"
    on:click={handleBackdropClick}
    on:touchstart={handleTouchStart}
    on:touchmove={handleTouchMove}
    on:touchend={handleTouchEnd}
    role="dialog"
    aria-modal="true"
    aria-label="Image lightbox"
  >
    <!-- Controls bar -->
    <div class="lightbox-controls">
      <button
        class="control-btn"
        on:click={prev}
        disabled={!canGoPrev}
        aria-label="Previous image"
      >
        <ChevronLeft size={24} />
      </button>

      <span class="image-counter">
        {currentIndex + 1} / {images.length}
      </span>

      <button
        class="control-btn"
        on:click={next}
        disabled={!canGoNext}
        aria-label="Next image"
      >
        <ChevronRight size={24} />
      </button>

      <div class="controls-spacer"></div>

      <button
        class="control-btn"
        on:click={zoomOut}
        disabled={zoom <= 0.5}
        aria-label="Zoom out"
      >
        <ZoomOut size={20} />
      </button>

      <span class="zoom-level">{Math.round(zoom * 100)}%</span>

      <button
        class="control-btn"
        on:click={zoomIn}
        disabled={zoom >= 5}
        aria-label="Zoom in"
      >
        <ZoomIn size={20} />
      </button>

      <button
        class="control-btn"
        on:click={downloadImage}
        aria-label="Download image"
      >
        <Download size={20} />
      </button>

      <button
        class="control-btn close-btn"
        on:click={close}
        aria-label="Close lightbox"
      >
        <X size={24} />
      </button>
    </div>

    <!-- Image container -->
    <div class="lightbox-content" on:click|stopPropagation>
      <img
        src={currentImage.blobUrl}
        alt={currentImage.href.split('/').pop() || 'Image'}
        style="transform: scale({zoom}); translate: {isSwiping ? touchDeltaX : 0}px"
        draggable="false"
      />
    </div>

    <!-- Image info -->
    <div class="lightbox-info">
      <span class="image-filename">{currentImage.href.split('/').pop()}</span>
      {#if currentImage.width && currentImage.height}
        <span class="image-dimensions">{currentImage.width} x {currentImage.height}</span>
      {/if}
    </div>

    <!-- Swipe indicator (for touch) -->
    {#if isSwiping && Math.abs(touchDeltaX) > 20}
      <div class="swipe-indicator" class:left={touchDeltaX > 0} class:right={touchDeltaX < 0}>
        {#if touchDeltaX > 0}
          <ChevronLeft size={32} />
        {:else}
          <ChevronRight size={32} />
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .lightbox-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.95);
    z-index: 10000;
    display: flex;
    flex-direction: column;
    user-select: none;
  }

  .lightbox-controls {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    gap: 8px;
    background: rgba(0, 0, 0, 0.5);
    flex-shrink: 0;
  }

  .control-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .control-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
  }

  .control-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .close-btn {
    background: rgba(255, 100, 100, 0.2);
  }

  .close-btn:hover {
    background: rgba(255, 100, 100, 0.4);
  }

  .image-counter,
  .zoom-level {
    color: white;
    font-size: 0.875rem;
    padding: 0 8px;
    min-width: 60px;
    text-align: center;
  }

  .controls-spacer {
    flex: 1;
  }

  .lightbox-content {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 16px;
  }

  .lightbox-content img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    transition: transform 0.2s ease;
    pointer-events: none;
  }

  .lightbox-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: rgba(0, 0, 0, 0.5);
    color: white;
    font-size: 0.875rem;
    flex-shrink: 0;
  }

  .image-filename {
    opacity: 0.9;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 70%;
  }

  .image-dimensions {
    opacity: 0.6;
    font-size: 0.8rem;
  }

  .swipe-indicator {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    padding: 16px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 50%;
    color: white;
    pointer-events: none;
    opacity: 0.8;
  }

  .swipe-indicator.left {
    left: 16px;
  }

  .swipe-indicator.right {
    right: 16px;
  }

  /* Responsive adjustments */
  @media (max-width: 600px) {
    .lightbox-controls {
      flex-wrap: wrap;
      justify-content: center;
      gap: 6px;
      padding: 8px;
    }

    .controls-spacer {
      display: none;
    }

    .control-btn {
      width: 32px;
      height: 32px;
    }

    .image-counter,
    .zoom-level {
      font-size: 0.75rem;
      min-width: 50px;
    }
  }
</style>

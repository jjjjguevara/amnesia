<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type AmnesiaPlugin from '../../main';
  import { loadBook, isAbsolutePath } from '../../reader/book-loader';
  import { X, Download, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, Image, FolderOutput, Copy } from 'lucide-svelte';
  import { Notice } from 'obsidian';

  // Server-dependent feature - ApiClient was removed
  // This view requires server infrastructure to extract images from EPUBs
  type ApiClient = null;
  const createApiClient = (_config: unknown): ApiClient => null;

  export let plugin: AmnesiaPlugin;
  export let bookPath: string;
  export let bookTitle: string = '';

  interface BookImage {
    id: string;
    href: string;
    mediaType: string;
    blobUrl: string;
    width?: number;
    height?: number;
  }

  let loading = true;
  let error: string | null = null;
  let images: BookImage[] = [];
  let serverBookId: string | null = null;
  let apiClient: ApiClient | null = null;

  // Lightbox state
  let lightboxOpen = false;
  let lightboxIndex = 0;
  let lightboxZoom = 1;

  // Filter state
  let filterType: 'all' | 'cover' | 'illustrations' | 'inline' = 'all';
  let sortBy: 'original' | 'size' | 'type' = 'original';

  $: currentImage = lightboxOpen && images.length > 0 ? images[lightboxIndex] : null;

  $: filteredImages = images.filter(img => {
    if (filterType === 'all') return true;
    if (filterType === 'cover') return img.href.toLowerCase().includes('cover');
    if (filterType === 'illustrations') {
      return !img.href.toLowerCase().includes('cover') &&
             (img.width && img.height && img.width > 200 && img.height > 200);
    }
    return true;
  }).sort((a, b) => {
    if (sortBy === 'size') {
      const sizeA = (a.width || 0) * (a.height || 0);
      const sizeB = (b.width || 0) * (b.height || 0);
      return sizeB - sizeA;
    }
    if (sortBy === 'type') {
      return a.mediaType.localeCompare(b.mediaType);
    }
    return 0;
  });

  onMount(async () => {
    if (!bookPath) {
      error = 'No book path provided';
      loading = false;
      return;
    }

    // Check server configuration
    const settings = plugin.settings;
    if (!settings.serverUrl) {
      error = 'Amnesia server not configured. Please set the server URL in settings.';
      loading = false;
      return;
    }

    try {
      // Create API client
      const { getDeviceId } = await import('../../reader/renderer');
      const deviceId = getDeviceId();
      apiClient = createApiClient({ baseUrl: settings.serverUrl, deviceId });

      // Check if server is available
      const serverAvailable = await apiClient.healthCheck();
      if (!serverAvailable) {
        error = 'Amnesia server is not available. Please start the server.';
        loading = false;
        return;
      }

      // Load the EPUB book data
      const vaultBooks = plugin.libraryStore.getValue().books;
      const calibreBooks = plugin.calibreService?.getStore().getValue().books ?? [];

      const loadedBook = await loadBook(
        plugin.app,
        bookPath,
        vaultBooks,
        calibreBooks
      );

      // Set book title if not provided
      if (!bookTitle) {
        bookTitle = loadedBook.metadata.title;
      }

      // Upload to server and get book info
      const filename = bookPath.split('/').pop() || 'book.epub';
      const parsedBook = await apiClient.uploadBook(loadedBook.arrayBuffer, filename);
      serverBookId = parsedBook.id;

      // Extract images from resources
      await extractImages(parsedBook);

      loading = false;
    } catch (e) {
      console.error('Failed to load book for images:', e);
      error = e instanceof Error ? e.message : 'Failed to load book';
      loading = false;
    }
  });

  onDestroy(() => {
    // Clean up blob URLs
    images.forEach(img => {
      if (img.blobUrl) {
        URL.revokeObjectURL(img.blobUrl);
      }
    });
  });

  async function extractImages(parsedBook: any) {
    if (!apiClient || !serverBookId) {
      console.warn('No API client or book ID available');
      return;
    }

    const imageItems: BookImage[] = [];

    // Get spine items to find image resources
    // The server provides resources through the book metadata
    // We need to iterate through resources and find images
    try {
      // Get chapter content to find image references
      for (const spineItem of parsedBook.spine) {
        try {
          const content = await apiClient.getChapter(serverBookId, spineItem.href);
          // Parse HTML to find images
          const parser = new DOMParser();
          const doc = parser.parseFromString(content.html, 'text/html');
          const imgElements = doc.querySelectorAll('img');

          for (const img of Array.from(imgElements)) {
            const src = img.getAttribute('src') || img.getAttribute('data-src');
            if (src) {
              // Check if we already have this image
              const existingImage = imageItems.find(i => i.href === src);
              if (!existingImage) {
                try {
                  // Get the image as data URL from server
                  const dataUrl = await apiClient.getResourceAsDataUrl(serverBookId, src);

                  // Determine media type from data URL or extension
                  let mediaType = 'image/unknown';
                  if (dataUrl.startsWith('data:')) {
                    const match = dataUrl.match(/^data:([^;]+);/);
                    if (match) {
                      mediaType = match[1];
                    }
                  } else {
                    const ext = src.split('.').pop()?.toLowerCase();
                    if (ext === 'jpg' || ext === 'jpeg') mediaType = 'image/jpeg';
                    else if (ext === 'png') mediaType = 'image/png';
                    else if (ext === 'gif') mediaType = 'image/gif';
                    else if (ext === 'svg') mediaType = 'image/svg+xml';
                    else if (ext === 'webp') mediaType = 'image/webp';
                  }

                  // Get dimensions
                  const dimensions = await getImageDimensions(dataUrl);

                  imageItems.push({
                    id: `img-${imageItems.length}`,
                    href: src,
                    mediaType,
                    blobUrl: dataUrl,
                    width: dimensions.width,
                    height: dimensions.height
                  });
                } catch (e) {
                  console.warn(`Failed to load image ${src}:`, e);
                }
              }
            }
          }
        } catch (e) {
          console.warn(`Failed to process chapter ${spineItem.href}:`, e);
        }
      }

      // Also check for cover image
      if (parsedBook.metadata.coverHref) {
        const existingCover = imageItems.find(i => i.href === parsedBook.metadata.coverHref);
        if (!existingCover) {
          try {
            const coverUrl = await apiClient.getResourceAsDataUrl(serverBookId, parsedBook.metadata.coverHref);
            const dimensions = await getImageDimensions(coverUrl);
            imageItems.unshift({
              id: 'cover',
              href: parsedBook.metadata.coverHref,
              mediaType: 'image/jpeg',
              blobUrl: coverUrl,
              width: dimensions.width,
              height: dimensions.height
            });
          } catch (e) {
            console.warn('Failed to load cover image:', e);
          }
        }
      }
    } catch (e) {
      console.error('Failed to extract images:', e);
    }

    images = imageItems;
    console.log(`Extracted ${images.length} images from EPUB`);
  }

  function getImageDimensions(url: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      const img = document.createElement('img');
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        resolve({ width: 0, height: 0 });
      };
      img.src = url;
    });
  }

  function openLightbox(index: number) {
    lightboxIndex = index;
    lightboxZoom = 1;
    lightboxOpen = true;
    // Prevent body scroll
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightboxOpen = false;
    document.body.style.overflow = '';
  }

  function nextImage() {
    if (lightboxIndex < filteredImages.length - 1) {
      lightboxIndex++;
      lightboxZoom = 1;
    }
  }

  function prevImage() {
    if (lightboxIndex > 0) {
      lightboxIndex--;
      lightboxZoom = 1;
    }
  }

  function zoomIn() {
    lightboxZoom = Math.min(lightboxZoom + 0.25, 4);
  }

  function zoomOut() {
    lightboxZoom = Math.max(lightboxZoom - 0.25, 0.25);
  }

  async function downloadImage(image: BookImage) {
    try {
      const response = await fetch(image.blobUrl);
      const blob = await response.blob();

      // Create download link
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);

      // Extract filename from href
      const filename = image.href.split('/').pop() || `image-${image.id}`;
      a.download = filename;

      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error('Failed to download image:', e);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!lightboxOpen) return;

    switch (e.key) {
      case 'Escape':
        closeLightbox();
        break;
      case 'ArrowLeft':
        prevImage();
        break;
      case 'ArrowRight':
        nextImage();
        break;
      case '+':
      case '=':
        zoomIn();
        break;
      case '-':
        zoomOut();
        break;
    }
  }

  // Export image to vault
  async function exportToVault(image: BookImage) {
    try {
      // Get export folder from settings or use default
      const exportFolder = plugin.settings.assets?.exportFolder || 'Assets/Books';
      const sanitizedTitle = (bookTitle || 'book').replace(/[\\/:*?"<>|]/g, '_');
      const folderPath = `${exportFolder}/${sanitizedTitle}`;

      // Ensure folder exists
      const vault = plugin.app.vault;
      if (!await vault.adapter.exists(folderPath)) {
        await vault.createFolder(folderPath);
      }

      // Extract filename and ensure unique
      let filename = image.href.split('/').pop() || `image-${image.id}`;
      let filePath = `${folderPath}/${filename}`;

      // Check if file exists and append number if needed
      let counter = 1;
      const baseName = filename.replace(/\.[^.]+$/, '');
      const ext = filename.match(/\.[^.]+$/)?.[0] || '.png';
      while (await vault.adapter.exists(filePath)) {
        filename = `${baseName}_${counter}${ext}`;
        filePath = `${folderPath}/${filename}`;
        counter++;
      }

      // Convert data URL to binary
      const response = await fetch(image.blobUrl);
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();

      // Save to vault
      await vault.createBinary(filePath, arrayBuffer);
      new Notice(`Exported: ${filename}`);
    } catch (e) {
      console.error('Failed to export image:', e);
      new Notice(`Failed to export image: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }

  // Export all images to vault
  async function exportAllToVault() {
    if (filteredImages.length === 0) return;

    const exportFolder = plugin.settings.assets?.exportFolder || 'Assets/Books';
    const sanitizedTitle = (bookTitle || 'book').replace(/[\\/:*?"<>|]/g, '_');
    const folderPath = `${exportFolder}/${sanitizedTitle}`;

    try {
      // Ensure folder exists
      const vault = plugin.app.vault;
      if (!await vault.adapter.exists(folderPath)) {
        await vault.createFolder(folderPath);
      }

      let exported = 0;
      let failed = 0;

      for (const image of filteredImages) {
        try {
          let filename = image.href.split('/').pop() || `image-${image.id}`;
          let filePath = `${folderPath}/${filename}`;

          // Check if file exists and append number if needed
          let counter = 1;
          const baseName = filename.replace(/\.[^.]+$/, '');
          const ext = filename.match(/\.[^.]+$/)?.[0] || '.png';
          while (await vault.adapter.exists(filePath)) {
            filename = `${baseName}_${counter}${ext}`;
            filePath = `${folderPath}/${filename}`;
            counter++;
          }

          const response = await fetch(image.blobUrl);
          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          await vault.createBinary(filePath, arrayBuffer);
          exported++;
        } catch (e) {
          console.warn(`Failed to export ${image.href}:`, e);
          failed++;
        }
      }

      if (failed > 0) {
        new Notice(`Exported ${exported} images, ${failed} failed`);
      } else {
        new Notice(`Exported ${exported} images to ${folderPath}`);
      }
    } catch (e) {
      console.error('Failed to export images:', e);
      new Notice(`Failed to export images: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }

  // Copy image to clipboard
  async function copyToClipboard(image: BookImage) {
    try {
      const response = await fetch(image.blobUrl);
      const blob = await response.blob();

      // Use clipboard API
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);

      new Notice('Image copied to clipboard');
    } catch (e) {
      console.error('Failed to copy image:', e);
      new Notice(`Failed to copy: ${e instanceof Error ? e.message : 'Clipboard access denied'}`);
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="amnesia-images">
  {#if loading}
    <div class="amnesia-images-loading">
      <div class="amnesia-spinner"></div>
      <span>Loading images...</span>
    </div>
  {:else if error}
    <div class="amnesia-images-error">
      <span>Error: {error}</span>
    </div>
  {:else if images.length === 0}
    <div class="amnesia-images-empty">
      <Image size={48} />
      <span>No images found in this book</span>
    </div>
  {:else}
    <div class="amnesia-images-toolbar">
      <div class="images-count">
        {filteredImages.length} {filteredImages.length === 1 ? 'image' : 'images'}
      </div>
      <div class="images-filters">
        <select bind:value={filterType} class="images-filter-select">
          <option value="all">All Images</option>
          <option value="cover">Covers</option>
          <option value="illustrations">Illustrations</option>
        </select>
        <select bind:value={sortBy} class="images-filter-select">
          <option value="original">Original Order</option>
          <option value="size">By Size</option>
          <option value="type">By Type</option>
        </select>
        <button
          class="images-export-all"
          on:click={exportAllToVault}
          title="Export all images to vault"
          disabled={filteredImages.length === 0}
        >
          <FolderOutput size={16} />
          <span>Export All</span>
        </button>
      </div>
    </div>

    <div class="amnesia-images-grid">
      {#each filteredImages as image, index}
        <div
          class="image-card"
          on:click={() => openLightbox(index)}
          on:keypress={(e) => e.key === 'Enter' && openLightbox(index)}
          role="button"
          tabindex="0"
        >
          <img
            src={image.blobUrl}
            alt={image.href}
            loading="lazy"
          />
          <div class="image-info">
            <span class="image-type">{image.mediaType.split('/')[1]?.toUpperCase()}</span>
            {#if image.width && image.height}
              <span class="image-dimensions">{image.width}×{image.height}</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if lightboxOpen && currentImage}
  <div
    class="amnesia-lightbox"
    on:click={closeLightbox}
    role="dialog"
    aria-modal="true"
  >
    <div class="lightbox-controls" on:click|stopPropagation>
      <button on:click={prevImage} disabled={lightboxIndex === 0}>
        <ChevronLeft size={24} />
      </button>
      <span class="lightbox-counter">{lightboxIndex + 1} / {filteredImages.length}</span>
      <button on:click={nextImage} disabled={lightboxIndex === filteredImages.length - 1}>
        <ChevronRight size={24} />
      </button>
      <div class="lightbox-spacer"></div>
      <button on:click={zoomOut} disabled={lightboxZoom <= 0.25}>
        <ZoomOut size={20} />
      </button>
      <span class="zoom-level">{Math.round(lightboxZoom * 100)}%</span>
      <button on:click={zoomIn} disabled={lightboxZoom >= 4}>
        <ZoomIn size={20} />
      </button>
      <button on:click={() => downloadImage(currentImage)} title="Download">
        <Download size={20} />
      </button>
      <button on:click={() => exportToVault(currentImage)} title="Export to Vault">
        <FolderOutput size={20} />
      </button>
      <button on:click={() => copyToClipboard(currentImage)} title="Copy to Clipboard">
        <Copy size={20} />
      </button>
      <button on:click={closeLightbox} title="Close">
        <X size={24} />
      </button>
    </div>

    <div class="lightbox-image-container" on:click|stopPropagation>
      <img
        src={currentImage.blobUrl}
        alt={currentImage.href}
        style="transform: scale({lightboxZoom})"
        draggable="false"
      />
    </div>

    <div class="lightbox-info">
      <span>{currentImage.href.split('/').pop()}</span>
      {#if currentImage.width && currentImage.height}
        <span class="lightbox-dimensions">{currentImage.width} × {currentImage.height}</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .amnesia-images {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--background-primary);
  }

  .amnesia-images-loading,
  .amnesia-images-error,
  .amnesia-images-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 16px;
    color: var(--text-muted);
  }

  .amnesia-images-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .images-count {
    font-weight: 500;
    color: var(--text-normal);
  }

  .images-filters {
    display: flex;
    gap: 8px;
  }

  .images-filter-select {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: 0.875rem;
  }

  .images-export-all {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 4px;
    border: 1px solid var(--background-modifier-border);
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    font-size: 0.875rem;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .images-export-all:hover:not(:disabled) {
    opacity: 0.9;
  }

  .images-export-all:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .amnesia-images-grid {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 16px;
    align-content: start;
  }

  .image-card {
    position: relative;
    aspect-ratio: 1;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    background: var(--background-secondary);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }

  .image-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .image-card img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .image-info {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 6px 8px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.7rem;
    color: white;
  }

  .image-type {
    background: rgba(255, 255, 255, 0.2);
    padding: 2px 6px;
    border-radius: 4px;
  }

  /* Lightbox styles */
  .amnesia-lightbox {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.95);
    z-index: 10000;
    display: flex;
    flex-direction: column;
  }

  .lightbox-controls {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    gap: 8px;
    background: rgba(0, 0, 0, 0.5);
  }

  .lightbox-controls button {
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
    transition: background 0.2s;
  }

  .lightbox-controls button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
  }

  .lightbox-controls button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .lightbox-counter,
  .zoom-level {
    color: white;
    font-size: 0.875rem;
    padding: 0 8px;
  }

  .lightbox-spacer {
    flex: 1;
  }

  .lightbox-image-container {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 16px;
  }

  .lightbox-image-container img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    transition: transform 0.2s ease;
  }

  .lightbox-info {
    padding: 12px 16px;
    background: rgba(0, 0, 0, 0.5);
    color: white;
    font-size: 0.875rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .lightbox-dimensions {
    color: rgba(255, 255, 255, 0.7);
  }

  /* Spinner */
  .amnesia-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--background-secondary);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Responsive */
  @media (max-width: 600px) {
    .amnesia-images-grid {
      grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
      gap: 8px;
      padding: 8px;
    }

    .lightbox-controls {
      flex-wrap: wrap;
      justify-content: center;
    }
  }
</style>

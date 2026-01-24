<script lang="ts">
  /**
   * ServerReaderContainer
   *
   * EPUB reader component that uses the custom Rust server renderer
   * instead of epub.js. Requires amnesia-server to be running.
   */
  import { onMount, onDestroy, tick, createEventDispatcher } from 'svelte';
  import { Platform, setIcon } from 'obsidian';
  import type AmnesiaPlugin from '../../main';
  import type { HighlightColor, Highlight } from '../../library/types';
  import type { PendingSelection } from '../../highlights/highlight-store';
  import type { CalibreBookFull } from '../../calibre/calibre-types';
  import { loadBook, isAbsolutePath, getCalibreBookNotePath, type LoadedBook, type BookFormat } from '../book-loader';
  import HighlightPopup from '../../highlights/components/HighlightPopup.svelte';
  import Portal from '../../components/Portal.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import PdfSettingsPanel from './PdfSettingsPanel.svelte';
  import ProgressSlider from './ProgressSlider.svelte';
  import NotebookSidebar from './NotebookSidebar.svelte';
  import ImageLightbox, { type LightboxImage } from './ImageLightbox.svelte';
  import { sidebarStore, type SidebarTab } from '../../sidebar/sidebar.store';
  import { BOOK_SIDEBAR_VIEW_TYPE } from '../../sidebar/sidebar-view';
  import { getSearchIndex, clearSearchIndex } from '../search-index';
  import type { Bookmark, ReadingNote } from '../../bookmarks/bookmark-types';
  import {
    type ReaderSettings,
    type ThemePreset,
    type TapZoneAction,
    getThemeColors,
    DEFAULT_READER_SETTINGS,
  } from '../reader-settings';
  import {
    type PerBookSettings,
    extractPerBookSettings,
    mergePerBookSettings,
  } from '../book-settings-store';

  // Helper to get margin value (handles both number and object formats)
  function getMarginValue(margins: number | { left: number; right: number; top: number; bottom: number }): number {
    return typeof margins === 'number' ? margins : margins.left;
  }

  // Svelte action to set Obsidian icons
  function setIconEl(node: HTMLElement, icon: string) {
    setIcon(node, icon);
  }
  import { HapticFeedback } from '../../utils';
  import {
    Settings,
    Bookmark as BookmarkIcon,
    BookmarkCheck,
    List,
    X,
    Maximize2,
    Minimize2,
    Image,
    ExternalLink,
    Info,
    MoreVertical,
    ChevronLeft,
    ChevronRight,
    Highlighter,
    StickyNote,
    Columns,
    AlignJustify,
    // PDF-specific icons
    ZoomIn,
    ZoomOut,
    // Scroll direction icons
    ArrowDownUp,
    ArrowLeftRight,
    BookOpen,
    Scroll,
    // Display mode icons
    Grid,
    Move,
    LayoutGrid,
    Maximize,
    ChevronDown,
  } from 'lucide-svelte';

  // Import renderer infrastructure
  import {
    getDeviceId,
    HighlightOverlay,
    // Unified document provider (replaces HybridPdfProvider)
    HybridDocumentProvider,
    createHybridDocumentProvider,
    // MuPDF EPUB provider (WASM-only)
    getSharedMuPDFEpubContentProvider,
    type ReadingLocation,
    type ParsedBook,
    type TocEntry,
    type RendererConfig,
    type ContentProvider,
  } from '../renderer';

  // Import PDF renderer for PDF file support
  import {
    PdfRenderer,
    type PdfRendererConfig,
  } from '../renderer/pdf';

  // Import the Shadow DOM renderer
  import { ShadowDOMRenderer } from '../shadow-dom-renderer';

  // Import reader mode for Source/Live toggle
  import {
    type ReaderMode,
    type ReaderModeConfig,
    DEFAULT_MODE_CONFIG,
    toggleMode as toggleReaderMode,
    getEffectiveSettings,
    MODE_METADATA,
  } from '../modes';

  // Import Doc Doctor types for knowledge gap creation
  import type { StubType } from '../../integrations/doc-doctor-bridge';

  /**
   * Resolve chapter name from spine item using multiple matching strategies.
   * Falls back to cleaned-up filename or page percentage if no ToC match found.
   */
  function resolveChapterName(
    spineItem: { href: string } | undefined,
    toc: TocEntry[],
    pagePercent?: number
  ): string {
    if (!spineItem) return '';

    const spineHref = spineItem.href;
    let entry: TocEntry | undefined;

    // Helper to search ToC recursively (for nested chapters)
    function findInToc(entries: TocEntry[], matcher: (e: TocEntry) => boolean): TocEntry | undefined {
      for (const e of entries) {
        if (matcher(e)) return e;
        if (e.children?.length) {
          const found = findInToc(e.children, matcher);
          if (found) return found;
        }
      }
      return undefined;
    }

    // Strategy 1: Exact match
    entry = findInToc(toc, t => t.href === spineHref);

    // Strategy 2: Spine ends with ToC href (ToC may have relative path)
    if (!entry) {
      entry = findInToc(toc, t => spineHref.endsWith(t.href));
    }

    // Strategy 3: ToC ends with spine href (spine may have relative path)
    if (!entry) {
      entry = findInToc(toc, t => t.href.endsWith(spineHref));
    }

    // Strategy 4: Filename match (ignore directories and anchors)
    if (!entry) {
      const spineFilename = spineHref.split('/').pop()?.split('#')[0];
      if (spineFilename) {
        entry = findInToc(toc, t => {
          const tocFilename = t.href.split('/').pop()?.split('#')[0];
          return tocFilename === spineFilename;
        });
      }
    }

    // Strategy 5: Partial path match (either contains the other)
    if (!entry) {
      entry = findInToc(toc, t =>
        spineHref.includes(t.href.replace(/#.*$/, '')) ||
        t.href.replace(/#.*$/, '').includes(spineHref)
      );
    }

    if (entry) {
      return entry.label;
    }

    // Fallback 1: Clean up the filename as chapter name
    const filename = spineHref.split('/').pop() || '';
    const cleanedName = filename
      .replace(/\.(x?html?|xml)$/i, '')  // Remove extension
      .replace(/[-_]/g, ' ')             // Replace dashes/underscores with spaces
      .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
      .replace(/^\d+\s*/, '')            // Remove leading numbers
      .replace(/^(ch(apter)?|pt|part|section)\s*/i, '') // Remove common prefixes
      .trim();

    if (cleanedName && cleanedName.length > 2) {
      // Capitalize first letter
      return cleanedName.charAt(0).toUpperCase() + cleanedName.slice(1);
    }

    // Fallback 2: Use page percentage
    if (typeof pagePercent === 'number' && pagePercent > 0) {
      return `Page ${Math.round(pagePercent)}%`;
    }

    return '';
  }

  import type { ReaderView } from '../reader-view';

  export let plugin: AmnesiaPlugin;
  export let bookPath: string;
  export let bookTitle: string = '';
  export let _activeLeafTrigger: number = 0;
  export let view: ReaderView | undefined = undefined;

  /**
   * Called when this reader's leaf becomes active.
   * Updates the sidebar to reflect this book's content.
   */
  export function onBecameActive(): void {
    if (!book || !plugin) return;

    // Check if sidebar is open
    const sidebarLeaves = plugin.app.workspace.getLeavesOfType('amnesia-book-sidebar');
    if (sidebarLeaves.length === 0) return;

    // Update sidebar store with this book's info
    const activeBookId = highlightBookId || (isCalibreBook ? calibreBook?.uuid : null) || bookPath;
    sidebarStore.setActiveBook(activeBookId, bookPath, bookTitle);

    // Update ToC
    updateSidebarToc();
  }

  /**
   * Navigate to a CFI location - exposed for external calls from reader-view
   */
  export function navigateToCfi(cfi: string): void {
    renderer?.display({ type: 'cfi', cfi });
  }

  /**
   * Remove a highlight from the overlay - exposed for external calls
   */
  export function removeHighlightFromOverlay(highlightId: string): void {
    renderer?.removeHighlight(highlightId);
    // Also update local state to stay in sync
    bookHighlights = bookHighlights.filter(h => h.id !== highlightId);
  }

  /**
   * Navigate to a highlight by CFI then precise text location.
   * Uses ShadowDOMRenderer's navigateToHighlight for Shadow DOM architecture,
   * falls back to iframe-based navigation for legacy renderer.
   */
  export async function navigateToHighlight(cfi: string, text: string, color?: HighlightColor): Promise<void> {
    // Check if renderer is ShadowDOMRenderer (has navigateToHighlight method)
    const shadowRenderer = renderer as unknown as ShadowDOMRenderer;
    if (typeof shadowRenderer.navigateToHighlight === 'function') {
      await shadowRenderer.navigateToHighlight(cfi, text, color);
      return;
    }

    // Legacy fallback: Check if text is already visible before any navigation
    const iframe = renderer?.getIframe?.();
    const doc = iframe?.contentDocument;
    if (doc) {
      // Use more text for accurate matching (100 chars instead of 30)
      const searchText = text.slice(0, 100);
      const spineIndex = getSpineIndexFromCfi(cfi);
      const chapterElement = spineIndex !== null ? getChapterElement(doc, spineIndex) : null;
      const range = findTextRange(doc, searchText, chapterElement);

      if (range) {
        const rect = range.getBoundingClientRect();
        const MARGIN = 50;
        const mode = renderer?.getMode?.() || 'paginated';

        if (mode === 'paginated') {
          const viewportWidth = iframe.clientWidth || 800;
          if (rect.left >= -MARGIN && rect.right <= viewportWidth + MARGIN) {
            // Already visible - do nothing at all
            console.log('[navigateToHighlight] Already visible, skipping navigation');
            return;
          }
        } else {
          const viewportHeight = iframe.clientHeight || 600;
          if (rect.top >= -MARGIN && rect.bottom <= viewportHeight + MARGIN) {
            // Already visible - do nothing at all
            console.log('[navigateToHighlight] Already visible, skipping navigation');
            return;
          }
        }
      }
    }

    // Only navigate if not visible
    await navigateToHighlightText(text, cfi);
  }

  /**
   * Navigate to a ToC entry or internal link by href.
   * Delegates to ShadowDOMRenderer for proper navigation with pulse animation.
   */
  export function navigateToHref(href: string): void {
    if (!renderer) return;

    // Check if renderer is ShadowDOMRenderer (has navigateToHref method)
    const shadowRenderer = renderer as unknown as ShadowDOMRenderer;
    if (typeof shadowRenderer.navigateToHref === 'function') {
      shadowRenderer.navigateToHref(href);
    }
  }

  /**
   * Navigate to a specific chapter by spine index.
   */
  export function navigateToChapter(spineIndex: number): void {
    if (!renderer || !book) return;
    if (spineIndex >= 0 && spineIndex < book.spine.length) {
      renderer.display({ type: 'spine', spineIndex });
    }
  }

  /**
   * BookImage interface for sidebar image extraction
   */
  interface BookImage {
    id: string;
    href: string;
    blobUrl: string;
    spineIndex: number;
    spineHref: string;
    width?: number;
    height?: number;
    fileSize?: number; // File size in bytes
  }

  /**
   * Get file size from a blob URL
   */
  async function getBlobSize(blobUrl: string): Promise<number | undefined> {
    try {
      const response = await fetch(blobUrl);
      const blob = await response.blob();
      return blob.size;
    } catch {
      return undefined;
    }
  }

  /**
   * Get image dimensions from a blob URL
   */
  async function getImageDimensions(blobUrl: string): Promise<{ width: number; height: number } | undefined> {
    return new Promise((resolve) => {
      // Use document.createElement to avoid conflict with lucide-svelte's Image import
      const img = document.createElement('img');
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(undefined);
      img.src = blobUrl;
    });
  }

  /**
   * Extract all images from the book using the current provider.
   * This allows the sidebar to access images without requiring a server connection.
   */
  export async function getBookImages(): Promise<BookImage[]> {
    if (!book || !providerAdapter) {
      console.log('[Reader] getBookImages: no book or provider', { hasBook: !!book, hasProvider: !!providerAdapter });
      return [];
    }

    const imageItems: BookImage[] = [];
    const seenHrefs = new Set<string>();

    // Add cover image first if available
    if (book.metadata.coverHref) {
      try {
        const coverUrl = await providerAdapter.getResourceAsDataUrl(book.id, book.metadata.coverHref);
        imageItems.push({
          id: 'cover',
          href: book.metadata.coverHref,
          blobUrl: coverUrl,
          spineIndex: 0,
          spineHref: book.spine[0]?.href || '',
        });
        seenHrefs.add(book.metadata.coverHref);
      } catch (e) {
        console.warn('[Reader] Failed to load cover image:', e);
      }
    }

    // Extract images from each spine item
    for (let spineIndex = 0; spineIndex < book.spine.length; spineIndex++) {
      const spineItem = book.spine[spineIndex];
      try {
        const content = await providerAdapter.getChapter(book.id, spineItem.href);
        const parser = new DOMParser();
        const doc = parser.parseFromString(content.html, 'text/html');

        // Find all img elements
        const imgElements = doc.querySelectorAll('img');
        for (const img of Array.from(imgElements)) {
          const src = img.getAttribute('src') || img.getAttribute('data-src');
          if (src && !seenHrefs.has(src)) {
            seenHrefs.add(src);
            // Extract alt and title attributes for better labeling
            const alt = img.getAttribute('alt') || undefined;
            const title = img.getAttribute('title') || undefined;
            // Try to get figure caption if image is inside a <figure>
            let figCaption: string | undefined;
            const figure = img.closest('figure');
            if (figure) {
              const caption = figure.querySelector('figcaption');
              if (caption?.textContent) {
                figCaption = caption.textContent.trim();
              }
            }
            // The src should already be a blob URL from the provider
            imageItems.push({
              id: `img-${imageItems.length}`,
              href: src,
              blobUrl: src, // Already resolved to blob URL by provider
              spineIndex,
              spineHref: spineItem.href,
              alt: figCaption || alt, // Prefer figure caption over alt
              title: title,
            });
          }
        }

        // Also check for SVG image elements with xlink:href
        const svgImages = doc.querySelectorAll('image');
        for (const img of Array.from(svgImages)) {
          const href = img.getAttribute('xlink:href') || img.getAttribute('href');
          if (href && !seenHrefs.has(href)) {
            seenHrefs.add(href);
            // SVG images can have title child elements
            const titleEl = img.querySelector('title');
            imageItems.push({
              id: `img-${imageItems.length}`,
              href: href,
              blobUrl: href, // Already resolved to blob URL by provider
              spineIndex,
              spineHref: spineItem.href,
              title: titleEl?.textContent?.trim() || undefined,
            });
          }
        }
      } catch (e) {
        console.warn(`[Reader] Failed to process chapter ${spineItem.href}:`, e);
      }
    }

    // Fetch file sizes and dimensions in parallel (batched to avoid overwhelming)
    const BATCH_SIZE = 10;
    for (let i = 0; i < imageItems.length; i += BATCH_SIZE) {
      const batch = imageItems.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (item) => {
        const [fileSize, dimensions] = await Promise.all([
          getBlobSize(item.blobUrl),
          getImageDimensions(item.blobUrl),
        ]);
        item.fileSize = fileSize;
        if (dimensions) {
          item.width = dimensions.width;
          item.height = dimensions.height;
        }
      }));
    }

    console.log(`[Reader] getBookImages: extracted ${imageItems.length} images`);
    return imageItems;
  }

  /**
   * Navigate to a chapter and then find specific text within it.
   * Used for search result navigation.
   */
  export async function navigateToChapterAndText(spineIndex: number, text: string): Promise<void> {
    if (!renderer || !book) return;
    if (spineIndex < 0 || spineIndex >= book.spine.length) return;

    // Navigate to the chapter first
    await renderer.display({ type: 'spine', spineIndex });

    // Wait for content to load and then find the text
    const searchText = text.slice(0, 50);
    let attempts = 0;
    const maxAttempts = 10;

    const tryFindText = async (): Promise<void> => {
      const iframe = renderer?.getIframe?.();
      const doc = iframe?.contentDocument;
      const mode = renderer?.getMode?.() || 'paginated';

      if (doc && iframe) {
        const range = findTextRange(doc, searchText);
        if (range) {
          if (mode === 'scrolled') {
            navigateToTextRangeScrolled(range, doc);
          } else {
            navigateToTextRange(range, iframe);
          }

          // Add highlight blink effect to the found text
          try {
            const mark = doc.createElement('mark');
            mark.className = 'epub-link-target';
            mark.style.cssText = 'background: var(--text-highlight-bg); padding: 0 2px;';
            range.surroundContents(mark);
            setTimeout(() => {
              mark.classList.remove('epub-link-target');
              const parent = mark.parentNode;
              if (parent) {
                parent.replaceChild(doc.createTextNode(mark.textContent || ''), mark);
              }
            }, 1500);
          } catch {
            // Range may span multiple elements, ignore
          }
          return;
        }
      }

      attempts++;
      if (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 150));
        await tryFindText();
      }
    };

    await new Promise(r => requestAnimationFrame(r));
    await tryFindText();
  }

  /**
   * Navigate to text in scrolled mode using chapter-relative positioning.
   * Uses a retry approach to handle content loading during scroll.
   */
  function navigateToTextRangeScrolled(range: Range, doc: Document): void {
    const scrollContainer = doc.scrollingElement || doc.documentElement;
    const viewportHeight = scrollContainer.clientHeight;
    const MARGIN = 100; // Margin for "in view" detection

    // Find the chapter element containing this range
    const chapterElement = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element).closest('.epub-chapter')
      : range.commonAncestorContainer.parentElement?.closest('.epub-chapter');

    if (!chapterElement) {
      return;
    }

    // Function to calculate and scroll to target
    const scrollToTarget = (attempt: number) => {
      // Re-get the rect each time as positions change during content load
      const rect = range.getBoundingClientRect();
      const currentScrollTop = scrollContainer.scrollTop;

      // Check if already in view
      if (rect.top >= MARGIN && rect.bottom <= viewportHeight - MARGIN) {
        renderer?.reanchorHighlights?.();
        return;
      }

      // Calculate document-relative position
      const documentTop = rect.top + currentScrollTop;
      const targetScrollTop = documentTop - (viewportHeight / 2) + (rect.height / 2);

      // Use instant scroll for retries, smooth for first attempt
      scrollContainer.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: attempt === 0 ? 'smooth' : 'auto',
      });

      // Retry if this isn't the last attempt
      if (attempt < 3) {
        // Wait for scroll + potential content reflow, then check again
        const delay = attempt === 0 ? 800 : 200; // Longer wait for smooth scroll
        setTimeout(() => scrollToTarget(attempt + 1), delay);
      } else {
        // Final reanchor
        renderer?.reanchorHighlights?.();
      }
    };

    // Start the scroll sequence
    scrollToTarget(0);
  }

  /**
   * Get the current transform offset from the content container.
   * Returns the X offset (positive value) from translate3d(-Xpx, 0, 0).
   */
  function getTransformOffset(doc: Document): number {
    const container = doc.getElementById('content-container');
    if (!container) return 0;

    const transform = container.style.transform;
    const match = transform.match(/translate3d\((-?\d+(?:\.\d+)?)px/);
    if (!match) return 0;

    // Transform is negative (e.g., -1208), return as positive offset
    return Math.abs(parseFloat(match[1]));
  }

  /**
   * Calculate the logical position of an element from its visual position and current transform.
   * This is stable regardless of chapter windowing because:
   * - visualPosition is where the element appears on screen
   * - transformOffset is how much the container has been shifted
   * - logicalPosition = visualPosition + transformOffset
   */
  function calculateLogicalPosition(visualLeft: number, transformOffset: number): number {
    return visualLeft + transformOffset;
  }

  function navigateToTextRange(range: Range, iframe: HTMLIFrameElement): void {
    const doc = iframe.contentDocument;
    if (!doc) return;

    const rect = range.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) return;

    const paginator = renderer?.getPaginator?.();
    if (!paginator) return;

    const pageWidth = paginator.getPageWidth();
    if (pageWidth <= 0) return;

    // Check if already visible
    const viewportWidth = iframe.clientWidth || 800;
    const MARGIN = 50;
    if (rect.left >= -MARGIN && rect.right <= viewportWidth + MARGIN) {
      console.warn('[navigateToHighlight] Text already visible');
      return;
    }

    // Calculate logical position from visual position and current transform
    // This approach is stable regardless of chapter windowing
    const transformOffset = getTransformOffset(doc);
    const logicalPosition = calculateLogicalPosition(rect.left, transformOffset);
    const page = Math.floor(logicalPosition / pageWidth);

    console.warn('[navigateToHighlight] goToPage: ' + JSON.stringify({
      visualLeft: rect.left.toFixed(0),
      transformOffset,
      logicalPosition: logicalPosition.toFixed(0),
      pageWidth,
      page
    }));

    // Use paginator.goToPage() with instant=true for highlight navigation
    paginator.goToPage(page, true);

    // Refresh highlights after navigation
    setTimeout(() => refreshHighlightOverlay(), 50);
  }

  // Navigation state for highlight navigation
  let highlightNavigationInProgress = false;

  /**
   * Navigate to highlight text.
   * Improved approach: Ensure chapter is loaded, wait for DOM ready, use full text search.
   */
  async function navigateToHighlightText(text: string, cfi: string): Promise<void> {
    const MARGIN = 50;
    const MAX_RETRIES = 10;
    const RETRY_DELAY = 100;
    highlightNavigationInProgress = true;

    try {
      const spineIndex = getSpineIndexFromCfi(cfi);

      // Step 1: CFI navigation to load the chapter
      await renderer?.display({ type: 'cfi', cfi }, { instant: true });

      // Step 2: Wait for chapter DOM to be ready
      const iframe = renderer?.getIframe?.();
      const doc = iframe?.contentDocument;
      if (!doc) return;

      // Wait for chapter element to exist and have content
      let chapterElement: Element | null = null;
      for (let i = 0; i < MAX_RETRIES; i++) {
        chapterElement = spineIndex !== null ? getChapterElement(doc, spineIndex) : doc.body;
        if (chapterElement && chapterElement.textContent && chapterElement.textContent.length > 100) {
          break;
        }
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      }

      if (!chapterElement) {
        console.warn('[navigateToHighlight] Chapter element not ready after retries');
        return;
      }

      // Step 3: Find the text with retry logic
      // Use up to 100 characters for more accurate matching
      const searchText = text.slice(0, 100);
      let range: Range | null = null;

      for (let i = 0; i < MAX_RETRIES; i++) {
        range = findTextRange(doc, searchText, chapterElement);
        if (range) break;

        // Try with shorter text as fallback
        if (i === MAX_RETRIES / 2) {
          range = findTextRange(doc, text.slice(0, 50), chapterElement);
          if (range) break;
        }

        await new Promise(r => setTimeout(r, RETRY_DELAY));
      }

      if (!range) {
        console.warn('[navigateToHighlight] Text not found after retries');
        return;
      }

      const mode = renderer?.getMode?.() || 'paginated';

      // Step 4: Navigate based on mode
      if (mode === 'scrolled') {
        const rect = range.getBoundingClientRect();
        const viewportHeight = iframe.clientHeight || 600;
        if (rect.top < -MARGIN || rect.bottom > viewportHeight + MARGIN) {
          navigateToTextRangeScrolled(range, doc);
        }
      } else {
        // Paginated mode - use scroll-based navigation now
        const paginator = renderer?.getPaginator?.();
        if (!paginator) return;

        const rect = range.getBoundingClientRect();
        const viewportWidth = iframe.clientWidth || 800;

        // Check if already visible
        if (rect.left >= -MARGIN && rect.right <= viewportWidth + MARGIN) {
          refreshHighlightOverlay();
          return;
        }

        // Get scroll container for accurate position calculation
        const scrollContainer = (paginator as any).getScrollContainer?.() as HTMLElement | null;
        if (!scrollContainer) return;

        const pageWidth = paginator.getPageWidth();
        const currentScroll = scrollContainer.scrollLeft;
        const maxScroll = scrollContainer.scrollWidth - scrollContainer.clientWidth;

        // Calculate target scroll position to bring text into view
        const scrollOffset = rect.left - MARGIN;
        const rawTargetScroll = currentScroll + scrollOffset; // Uncapped
        const targetScroll = Math.min(rawTargetScroll, maxScroll); // Capped for actual navigation

        // Snap to page boundary
        const targetPage = Math.round(targetScroll / pageWidth);
        const pageInfo = paginator.getCurrentPage();
        const clampedPage = Math.max(0, Math.min(targetPage, pageInfo.total - 1));

        // Check if text is beyond scrollable region (use raw uncapped value)
        if (rawTargetScroll > maxScroll) {
          // Re-load chapters with the target chapter at the START of the window
          // This gives more scroll room for content within the chapter
          if (spineIndex !== null && renderer && (renderer as any).loadChaptersStartingFrom) {
            await (renderer as any).loadChaptersStartingFrom(spineIndex);
            // Wait for layout to settle
            await new Promise(r => setTimeout(r, 200));

            // Re-find the chapter element after re-windowing
            const newChapterElement = getChapterElement(doc, spineIndex);
            if (newChapterElement) {
              // Re-find the text
              const newRange = findTextRange(doc, text.slice(0, 100), newChapterElement);
              if (newRange) {
                const newRect = newRange.getBoundingClientRect();
                const newCurrentScroll = scrollContainer.scrollLeft;
                const newScrollOffset = newRect.left - MARGIN;
                const newTargetScroll = newCurrentScroll + newScrollOffset;
                const newPageWidth = paginator.getPageWidth();
                const newPage = Math.round(newTargetScroll / newPageWidth);
                const newPageInfo = paginator.getCurrentPage();
                const finalPage = Math.max(0, Math.min(newPage, newPageInfo.total - 1));
                // Instant navigation for highlight click - no animation
                paginator.goToPage(finalPage, true);
              } else {
                paginator.goToPage(clampedPage, true);
              }
            } else {
              paginator.goToPage(clampedPage, true);
            }
          } else {
            // Fallback: just go to last available page
            paginator.goToPage(clampedPage, true);
          }
        } else if (clampedPage !== pageInfo.current) {
          // Instant navigation for highlight click - no animation
          paginator.goToPage(clampedPage, true);
        }
      }

      // Short wait for layout to settle (no animation, so no 350ms wait needed)
      await new Promise(r => setTimeout(r, 50));
      refreshHighlightOverlay();

    } catch (e) {
      console.error('[navigateToHighlight] Error:', e);
    } finally {
      highlightNavigationInProgress = false;
    }
  }

  /**
   * Legacy function for backward compatibility - redirects to new approach
   */
  function waitForTextAndNavigate(text: string, attempt: number, cfi?: string): void {
    if (cfi) {
      navigateToHighlightText(text, cfi);
    } else {
      console.warn('[navigateToHighlight] No CFI provided, cannot navigate');
    }
  }

  /**
   * Refresh highlight overlay after navigation completes.
   * Triggers re-anchoring of highlights to their text ranges.
   */
  function refreshHighlightOverlay(): void {
    if (renderer && bookHighlights.length > 0) {
      renderer.setStoredHighlights(bookHighlights);
    }
  }

  /**
   * Wait for text to appear after CFI navigation, then scroll to it (scroll mode).
   * Simpler than waitForTextAndNavigate since we don't need to wait for transforms.
   */
  function waitForTextAndScrollNavigate(text: string, attempt: number, cfi?: string): void {
    const MAX_ATTEMPTS = 40; // 2 seconds max wait

    if (attempt >= MAX_ATTEMPTS) {
      console.warn('[navigateToHighlight] Scroll: gave up after', attempt, 'attempts');
      return;
    }

    const iframe = renderer?.getIframe?.();
    const doc = iframe?.contentDocument;
    if (!doc) {
      setTimeout(() => waitForTextAndScrollNavigate(text, attempt + 1, cfi), 50);
      return;
    }

    // Get chapter element from CFI for scoped search
    const spineIndex = cfi ? getSpineIndexFromCfi(cfi) : null;
    const chapterElement = spineIndex !== null ? getChapterElement(doc, spineIndex) : null;

    // Search for text within the specific chapter (or whole document if no CFI)
    const searchText = text.slice(0, 50);
    const range = findTextRange(doc, searchText, chapterElement);
    if (!range) {
      // Text not found yet, chapter might still be loading
      setTimeout(() => waitForTextAndScrollNavigate(text, attempt + 1, cfi), 50);
      return;
    }

    const rect = range.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) {
      // Range exists but not rendered yet
      setTimeout(() => waitForTextAndScrollNavigate(text, attempt + 1, cfi), 50);
      return;
    }

    // Check if text is already visible after CFI navigation
    const viewportHeight = iframe.clientHeight || 600;
    const MARGIN = 50;
    if (rect.top >= -MARGIN && rect.bottom <= viewportHeight + MARGIN) {
      console.warn('[navigateToHighlight] Scroll mode: text visible after CFI nav');
      return;
    }

    // Text found and rendered but not visible, scroll to it
    console.warn('[navigateToHighlight] Scroll mode: found text, scrolling');
    navigateToTextRangeScrolled(range, doc);
  }

  /**
   * Parse CFI to get spine index
   * CFI format: epubcfi(/6/22!/4/2/1:0) where 22/2-1 = spine index 10
   */
  function getSpineIndexFromCfi(cfi: string): number | null {
    const match = cfi.match(/epubcfi\(\/6\/(\d+)/);
    if (!match) return null;
    return Math.floor(parseInt(match[1], 10) / 2) - 1;
  }

  /**
   * Get the chapter element for a given spine index
   */
  function getChapterElement(doc: Document, spineIndex: number): Element | null {
    return doc.querySelector(`.epub-chapter[data-chapter-index="${spineIndex}"]`);
  }

  /**
   * Find a text string in the document (or within a specific root element) and return a Range.
   * Handles text that spans multiple nodes (e.g., with footnote markers in <sup> elements).
   */
  function findTextRange(doc: Document, searchText: string, root?: Element | null): Range | null {
    const searchRoot = root || doc.body;

    // First, find the position in the combined textContent
    const fullText = searchRoot.textContent || '';
    const textIndex = fullText.indexOf(searchText);

    if (textIndex === -1) {
      return null;
    }

    // Now walk text nodes to find the actual node positions
    const walker = doc.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, null);
    const range = doc.createRange();

    let charCount = 0;
    let foundStart = false;
    let foundEnd = false;
    const startOffset = textIndex;
    const endOffset = textIndex + searchText.length;

    let node: Text | null;
    while ((node = walker.nextNode() as Text)) {
      const nodeLength = node.textContent?.length || 0;
      const nodeEnd = charCount + nodeLength;

      // Find start position
      if (!foundStart && startOffset >= charCount && startOffset < nodeEnd) {
        try {
          range.setStart(node, startOffset - charCount);
          foundStart = true;
        } catch (e) {
          return null;
        }
      }

      // Find end position
      if (!foundEnd && endOffset >= charCount && endOffset <= nodeEnd) {
        try {
          range.setEnd(node, endOffset - charCount);
          foundEnd = true;
          break;
        } catch (e) {
          return null;
        }
      }

      charCount = nodeEnd;
    }

    if (foundStart && foundEnd) {
      return range;
    }

    return null;
  }

  const dispatch = createEventDispatcher<{
    titleResolved: { title: string };
  }>();

  // DOM references
  let container: HTMLElement;
  let rendererContainer: HTMLElement;

  // Renderer instances
  let renderer: ShadowDOMRenderer | PdfRenderer | null = null;
  let pdfProvider: HybridDocumentProvider | null = null;
  // ContentProvider is the common interface for MuPDFEpubContentProvider
  let providerAdapter: ContentProvider | null = null;

  // Format detection - determined after loading book via book-loader
  let detectedFormat: BookFormat = 'epub';
  let loadedBookData: LoadedBook | null = null;
  $: isPdf = detectedFormat === 'pdf';

  // Book state
  let book: ParsedBook | null = null;
  let bookId: string = '';
  let toc: TocEntry[] = [];
  let isCalibreBook = false;
  let calibreBook: CalibreBookFull | undefined;

  // UI state
  let loading = true;
  let error: string | null = null;
  let progress = 0;
  let currentChapter = '';
  let showSettings = false;
  let showBottomNav = true;
  let isFullScreen = false;
  let showMoreMenu = false;
  let showBookInfo = false;
  let showNotebook = false;
  let notebookTab: 'highlights' | 'bookmarks' | 'notes' | 'images' = 'highlights';
  let showDisplayModeDropdown = false;

  // PDF-specific settings (derived from plugin settings)
  $: pdfSettings = plugin.settings.pdf;

  // PDF state tracking
  let pdfCurrentPage = 1;
  let pdfTotalPages = 0;
  let pdfCurrentZoom = 1; // Live zoom level from camera (updated via 'zoomed' event)

  // Image lightbox state
  let lightboxOpen = false;
  let lightboxImages: LightboxImage[] = [];
  let lightboxStartIndex = 0;

  // Auto-scroll state
  let isAutoScrolling = false;

  // Auto-save interval
  let autoSaveInterval: ReturnType<typeof setInterval> | null = null;
  const AUTO_SAVE_INTERVAL_MS = 30000; // 30 seconds

  // Wheel debounce timer for PDF navigation
  let wheelDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Highlight state
  let showHighlightPopup = false;
  let highlightPopupPosition = { x: 0, y: 0 };
  let pendingSelection: PendingSelection | null = null;
  let highlightPopupMode: 'new' | 'existing' = 'new';
  let selectedExistingHighlight: Highlight | null = null;
  let bookHighlights: Highlight[] = [];
  let bookBookmarks: Bookmark[] = [];
  let bookNotes: ReadingNote[] = [];
  let highlightBookId: string = ''; // The actual book ID used for highlights/bookmarks (Calibre UUID or vault book ID)

  // Track last cursor/touch position for popup positioning (works for both mouse and touch)
  let lastPointerPosition = { x: 0, y: 0 };

  // Flag to ignore clicks immediately after showing popup (prevents click-through from selection)
  let ignoreNextContainerClick = false;

  // Doc Doctor integration state
  $: docDoctorConnected = plugin.docDoctorBridge?.isConnected() ?? false;

  // Source/Live reader mode (M4 foundation)
  let readerModeConfig: ReaderModeConfig = { ...DEFAULT_MODE_CONFIG };
  $: effectiveSettings = getEffectiveSettings(readerModeConfig);
  $: currentModeLabel = MODE_METADATA[readerModeConfig.mode].label;

  // Debug: track popup state changes
  $: console.log('[Svelte Reactive] Popup state: showHighlightPopup=' + showHighlightPopup + ', hasPending=' + !!pendingSelection + ', hasExisting=' + !!selectedExistingHighlight + ', loading=' + loading);

  // Reader settings
  let readerSettings: ReaderSettings = {
    ...DEFAULT_READER_SETTINGS,
    fontSize: plugin.settings.defaultFontSize,
    theme: plugin.settings.defaultTheme as ThemePreset,
    flow: plugin.settings.paginated ? 'paginated' : 'scrolled',
  };

  // Page tracking
  let totalPages = 0;
  let currentPage = 0;

  // Mobile detection
  const isMobile = Platform.isMobile;

  // Handle tab activation
  $: if (_activeLeafTrigger && renderer) {
    // Renderer handles resize automatically
  }

  // Subscribe to Calibre store to update calibreBook when data becomes available
  let calibreStoreUnsubscribe: (() => void) | null = null;

  $: if (isCalibreBook && !calibreBook && bookPath && plugin.calibreService) {
    // Set up subscription if not already done
    if (!calibreStoreUnsubscribe) {
      const store = plugin.calibreService.getStore();
      calibreStoreUnsubscribe = store.subscribe((state) => {
        if (state.books && state.books.length > 0 && !calibreBook) {
          const found = state.books.find(b => b.epubPath === bookPath);
          if (found) {
            calibreBook = found;
          }
        }
      });
    }
  }

  /**
   * Update the sidebar with the book's ToC and spine items
   */
  function updateSidebarToc(): void {
    if (!plugin || !book) return;

    // Use toc variable if set, otherwise fall back to book.toc
    const tocData = toc || book.toc || [];
    if (tocData.length === 0) {
      console.log('[ServerReader] updateSidebarToc: No ToC data available');
      return;
    }

    // Get initial expanded state from book settings
    let initialExpandedState: string[] = [];
    if (plugin.bookSettingsStore && highlightBookId) {
      const bookSettings = plugin.bookSettingsStore.getBookSettings(highlightBookId);
      initialExpandedState = bookSettings?.tocExpandedState ?? [];
    }

    // Find the sidebar view and update its ToC
    const leaves = plugin.app.workspace.getLeavesOfType('amnesia-book-sidebar');
    if (leaves.length === 0) {
      console.log('[ServerReader] updateSidebarToc: No sidebar leaves found');
      return;
    }

    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view.setToc) {
        console.log('[ServerReader] updateSidebarToc: Passing', tocData.length, 'entries to sidebar');
        view.setToc(tocData, book.spine, initialExpandedState);
      }
    }
  }

  /**
   * Build the search index for the current book in the background.
   * Updates sidebar with progress.
   */
  async function buildSearchIndex(): Promise<void> {
    console.log('[Reader] buildSearchIndex called', { hasBook: !!book, hasProvider: !!providerAdapter });
    if (!book || !providerAdapter) {
      console.log('[Reader] buildSearchIndex early return - missing book or provider');
      return;
    }

    const searchIndex = getSearchIndex();
    console.log('[Reader] searchIndex.building:', searchIndex.building);
    if (searchIndex.building) return;

    const spineLength = book.spine.length;

    // Find sidebar to update progress
    const getSidebarView = (): any => {
      const leaves = plugin.app.workspace.getLeavesOfType('amnesia-book-sidebar');
      for (const leaf of leaves) {
        return leaf.view as any;
      }
      return null;
    };

    console.log('[Reader] Starting search index build for', spineLength, 'chapters');
    try {
      await searchIndex.build(
        async (spineIndex: number) => {
          const spineItem = book!.spine[spineIndex];
          const content = await providerAdapter!.getChapter(bookId, spineItem.href);

          // Resolve chapter name
          const chapterName = resolveChapterName(spineItem, toc);

          return {
            html: content.html,
            chapter: chapterName || `Chapter ${spineIndex + 1}`,
            href: spineItem.href,
          };
        },
        spineLength,
        (current, total) => {
          // Update sidebar with progress
          if (current === 1 || current % 10 === 0 || current === total) {
            console.log(`[Reader] Search index progress: ${current}/${total}`);
          }
          const sidebar = getSidebarView();
          if (sidebar?.updateSearchIndexState) {
            sidebar.updateSearchIndexState(false, current, total);
          }
        }
      );

      console.log('[Reader] Search index build complete');
      // Index ready - update sidebar
      const sidebar = getSidebarView();
      if (sidebar?.updateSearchIndexState) {
        sidebar.updateSearchIndexState(true, spineLength, spineLength);
      }
    } catch (e) {
      console.error('[Reader] Failed to build search index:', e);
    }
  }

  onMount(async () => {
    if (!bookPath) {
      error = 'No book path provided';
      loading = false;
      return;
    }

    isCalibreBook = isAbsolutePath(bookPath);

    try {
      // Initialize device ID for reading position sync
      const deviceId = getDeviceId();
      console.log('[Reader] Device ID:', deviceId);

      // Initialize MuPDF EPUB provider (WASM-only, no server)
      try {
        providerAdapter = await getSharedMuPDFEpubContentProvider();
        console.log('[ServerReader] Successfully initialized MuPDF EPUB provider');
      } catch (err) {
        console.error('[ServerReader] Failed to initialize MuPDF EPUB provider:', err);
        error = 'Failed to initialize EPUB provider. Please ensure WebAssembly is supported.';
        loading = false;
        return;
      }

      // Wait for container to be ready
      await tick();
      let attempts = 0;
      while ((!rendererContainer || rendererContainer.clientWidth < 100) && attempts < 50) {
        await new Promise(r => requestAnimationFrame(r));
        attempts++;
      }

      if (!rendererContainer) {
        error = 'Reader container not ready';
        loading = false;
        return;
      }

      // =========================================================================
      // EARLY BOOK LOADING - Detect format before branching
      // =========================================================================
      // Load book data early to detect format (PDF vs EPUB)
      // This handles Calibre directories that contain PDF files
      const calibreBooks = plugin.calibreService?.getStore().getValue().books;
      const vaultBooks = plugin.libraryStore.getValue().books;

      try {
        loadedBookData = await loadBook(plugin.app, bookPath, vaultBooks, calibreBooks);
        detectedFormat = loadedBookData.format;
        console.log('[ServerReader] Book loaded, format detected:', detectedFormat, 'path:', loadedBookData.metadata.filePath);
      } catch (e) {
        error = `Failed to load book: ${e instanceof Error ? e.message : String(e)}`;
        loading = false;
        return;
      }

      // =========================================================================
      // PDF PATH - Separate initialization for PDF files
      // =========================================================================
      // Check detectedFormat directly (not isPdf) since Svelte reactivity is async
      if (detectedFormat === 'pdf') {
        console.log('[ServerReader] Detected PDF file, using PDF renderer');

        // Log the PDF settings being used
        console.log('[ServerReader] PDF Settings from plugin:', {
          renderDpi: plugin.settings.pdf?.renderDpi,
          scale: plugin.settings.pdf?.scale,
          imageFormat: plugin.settings.pdf?.imageFormat,
          imageQuality: plugin.settings.pdf?.imageQuality,
          displayMode: plugin.settings.pdf?.displayMode,
        });

        // Create unified document provider (replaces HybridPdfProvider)
        pdfProvider = createHybridDocumentProvider({
          serverBaseUrl: plugin.settings.serverEnabled ? plugin.settings.serverUrl : undefined,
          preferMode: plugin.settings.pdf?.preferMode ?? 'auto',
          deviceId: getDeviceId(),
          enableCache: plugin.settings.pdf?.enablePageCache ?? true,
          enablePrefetch: (plugin.settings.pdf?.pagePreloadCount ?? 2) > 0,
          prefetchCount: plugin.settings.pdf?.pagePreloadCount ?? 2,
        });

        // Initialize provider (check server health)
        await pdfProvider.initialize();

        // Use already loaded book data (from early loading above)
        const pdfData = loadedBookData!.arrayBuffer;
        const filename = loadedBookData!.metadata.filePath.split('/').pop() || 'document.pdf';

        // Load document into provider first
        let parsedDocument;
        try {
          parsedDocument = await pdfProvider.loadDocument(pdfData, filename);
          console.log('[ServerReader] PDF loaded into provider:', { id: parsedDocument.id, pageCount: parsedDocument.itemCount });
          
          // Set document info for Resource Detector (Phase R2.2)
          // Note: start() is called later after renderer creation to avoid race condition
          if (plugin.resourceDetector) {
            const fileSizeMB = pdfData.byteLength / (1024 * 1024);
            plugin.resourceDetector.setDocumentInfo({
              pageCount: parsedDocument.itemCount,
              fileSizeMB,
            });
          }
        } catch (e) {
          error = `Failed to parse PDF: ${e instanceof Error ? e.message : String(e)}`;
          loading = false;
          return;
        }

        // Create PdfContentProvider adapter from HybridDocumentProvider
        const pdfContentProvider = pdfProvider.createPdfContentAdapter();

        // Create PDF renderer config with all optimization settings
        const pdfRendererConfig: PdfRendererConfig = {
          mode: plugin.settings.pdf?.displayMode ?? 'paginated',
          theme: plugin.settings.defaultTheme as 'light' | 'dark' | 'sepia' | 'system',
          scale: plugin.settings.pdf?.scale ?? 1.5,
          rotation: plugin.settings.pdf?.rotation ?? 0,
          scrollDirection: plugin.settings.pdf?.scrollDirection ?? 'vertical',
          // Optimization settings
          renderDpi: plugin.settings.pdf?.renderDpi ?? 150,
          pagePreloadCount: plugin.settings.pdf?.pagePreloadCount ?? 2,
          enablePageCache: plugin.settings.pdf?.enablePageCache ?? true,
          pageCacheSize: plugin.settings.pdf?.pageCacheSize ?? 10,
          imageFormat: plugin.settings.pdf?.imageFormat ?? 'png',
          imageQuality: plugin.settings.pdf?.imageQuality ?? 85,
          enableTextAntialiasing: plugin.settings.pdf?.enableTextAntialiasing ?? true,
          enableImageSmoothing: plugin.settings.pdf?.enableImageSmoothing ?? true,
          // Advanced performance settings
          enableDomPooling: plugin.settings.pdf?.enableDomPooling ?? true,
          useIntersectionObserver: plugin.settings.pdf?.useIntersectionObserver ?? true,
          textLayerMode: plugin.settings.pdf?.textLayerMode ?? 'full',
          // Virtualization performance settings
          renderDebounceMs: plugin.settings.pdf?.renderDebounceMs ?? 150,
          minCreationBuffer: plugin.settings.pdf?.minCreationBuffer ?? 150,
          minDestructionBuffer: plugin.settings.pdf?.minDestructionBuffer ?? 300,
        };

        // Create PDF renderer with the adapter
        renderer = new PdfRenderer(rendererContainer, pdfContentProvider, pdfRendererConfig);

        // Set up PDF event handlers
        renderer.on('error', handleError);
        renderer.on('loading', (isLoading: boolean) => { loading = isLoading; });
        renderer.on('relocated', (location: any) => {
          if (location.position !== undefined && location.totalPositions !== undefined) {
            currentPage = location.position;
            totalPages = location.totalPositions;
            progress = Math.round((location.position / location.totalPositions) * 100);
            currentChapter = `Page ${location.position} of ${location.totalPositions}`;
            // Update PDF-specific state for settings panel
            pdfCurrentPage = location.position;
            pdfTotalPages = location.totalPositions;
          }
        });
        renderer.on('selected', handleSelected);
        renderer.on('highlightClicked', handleHighlightClicked);
        renderer.on('zoomed', (zoom: number) => {
          pdfCurrentZoom = zoom;
        });

        // Load PDF document into renderer (document already loaded in provider)
        try {
          await (renderer as PdfRenderer).load(parsedDocument.id);

          // Get ToC from PDF outline (convert TocEntry format recursively)
          // document-worker.TocEntry: { title, page, level, children }
          // renderer.TocEntry: { id, label, href, children }
          type DocTocEntry = { title: string; page: number; level: number; children: DocTocEntry[] };
          const convertToc = (entries: DocTocEntry[], prefix = 'toc'): TocEntry[] => {
            return entries.map((entry, idx) => ({
              id: `${prefix}-${idx}-p${entry.page}`,
              label: entry.title,
              href: `#page=${entry.page}`,
              children: entry.children ? convertToc(entry.children, `${prefix}-${idx}`) : [],
            }));
          };
          toc = convertToc((parsedDocument.toc || []) as unknown as DocTocEntry[]);
          totalPages = parsedDocument.itemCount;

          // Set book title from PDF metadata or filename
          if (!bookTitle) {
            bookTitle = parsedDocument.metadata?.title || filename.replace('.pdf', '');
            dispatch('titleResolved', { title: bookTitle });
          }

          // Set bookId for highlights
          bookId = parsedDocument.id;
          highlightBookId = bookId;

          // Load existing highlights for this PDF
          bookHighlights = plugin.highlightService.getHighlights(highlightBookId);

          // Update PDF page tracking
          pdfTotalPages = totalPages;
          pdfCurrentPage = 1;
          // Get actual zoom from renderer (may differ from settings if view was restored)
          pdfCurrentZoom = (renderer as PdfRenderer).getZoom?.() ?? pdfSettings.scale;

          // Update sidebar store with current book info (same as EPUB path)
          sidebarStore.setActiveBook(highlightBookId, bookPath, bookTitle);

          // Update sidebar with ToC (call after setting toc variable)
          updateSidebarToc();

          // Apply initial reading mode (theme)
          if (plugin.settings.pdf.readingMode) {
            // Use tick to ensure DOM is ready
            tick().then(() => applyPdfReadingMode(plugin.settings.pdf.readingMode));
          }

          loading = false;
          console.log('[ServerReader] PDF loaded successfully:', { bookId, pageCount: totalPages });
          
          // Start Resource Detector monitoring after successful PDF render (Phase R2.2)
          if (plugin.resourceDetector) {
            plugin.resourceDetector.start();
          }
        } catch (e) {
          error = `Failed to render PDF: ${e instanceof Error ? e.message : String(e)}`;
          loading = false;
        }

        return; // Exit early - PDF initialization complete
      }

      // =========================================================================
      // EPUB PATH - Existing EPUB initialization (below)
      // =========================================================================

      // Book data already loaded in early loading section above
      // Use loadedBookData instead of calling loadBook again
      const loadedBook = loadedBookData!;

      // Resolve book metadata
      if (isCalibreBook) {
        calibreBook = calibreBooks?.find(b => b.epubPath === bookPath || b.calibrePath === bookPath);
        if (calibreBook && !bookTitle) {
          bookTitle = calibreBook.title;
          dispatch('titleResolved', { title: bookTitle });
        }
      } else {
        const vaultBook = vaultBooks.find(b => b.localPath === bookPath);
        if (vaultBook && !bookTitle) {
          bookTitle = vaultBook.title;
          dispatch('titleResolved', { title: bookTitle });
        }
      }

      // Get highlightBookId EARLY - needed for per-book settings BEFORE renderer creation
      // This prevents loading chapters in wrong mode then switching (which reloads all chapters)
      highlightBookId = loadedBook.metadata.bookId || '';
      console.log('[ServerReader] Got highlightBookId early:', highlightBookId);

      // Load per-book settings BEFORE creating renderer
      // This ensures the correct mode is used from the start, avoiding expensive mode switches
      if (highlightBookId && plugin.bookSettingsStore) {
        const savedSettings = plugin.bookSettingsStore.getReaderSettings(highlightBookId, readerSettings);
        readerSettings = savedSettings;
        console.log('[ServerReader] Loaded per-book settings BEFORE renderer:', { mode: readerSettings.flow });
      }

      // Create renderer with config (now using correct per-book settings)
      const rendererConfig: Partial<RendererConfig> = {
        mode: readerSettings.flow === 'paginated' ? 'paginated' : 'scrolled',
        fontSize: readerSettings.fontSize,
        fontFamily: readerSettings.fontFamily || 'Georgia, serif',
        lineHeight: readerSettings.lineHeight || 1.6,
        theme: readerSettings.theme,
        columns: readerSettings.columns || 'auto',
        margin: getMarginValue(readerSettings.margins),
      };

      // Create Shadow DOM renderer
      console.log('[ServerReader] Using Shadow DOM Renderer');
      renderer = new ShadowDOMRenderer(rendererContainer, providerAdapter!, rendererConfig);

      // Set up event handlers
      renderer.on('relocated', handleRelocated);
      renderer.on('rendered', handleRendered);
      renderer.on('selected', handleSelected);
      renderer.on('highlightClicked', handleHighlightClicked);
      renderer.on('linkClicked', handleLinkClicked);
      renderer.on('error', handleError);
      renderer.on('loading', (isLoading) => { loading = isLoading; });
      renderer.on('imageClicked', handleImageClicked);

      // Load book via provider (uses server or WASM depending on availability)
      // Pass the filename from the path for better book ID generation
      const filename = loadedBook.metadata.epubPath.split('/').pop() || 'book.epub';
      book = await providerAdapter!.uploadBook(loadedBook.arrayBuffer, filename);
      bookId = book.id;
      toc = book.toc;

      // Set title from book metadata if not already set from vault/calibre
      if (!bookTitle && book.metadata?.title) {
        bookTitle = book.metadata.title;
        dispatch('titleResolved', { title: bookTitle });
        console.log('[ServerReader] Title set from book metadata:', bookTitle);
      }

      // CRITICAL: Use the file path as highlightBookId for consistent highlight storage/lookup.
      // The highlight service stores highlights under file paths, not internal metadata IDs.
      // For Calibre books: Use the actual file path (loadedBook.metadata.filePath)
      // For vault books: Use bookPath
      // This ensures highlights created in this session match the storage key used by main.ts
      const filePath = loadedBook.metadata.filePath || bookPath;
      if (filePath && filePath !== highlightBookId) {
        console.log('[ServerReader] Using file path for highlightBookId:', filePath);
        highlightBookId = filePath;
      }

      // Load book in renderer
      await renderer.load(bookId);

      // highlightBookId was already set early (before renderer creation)
      console.log('[ServerReader] Book loaded', {
        highlightBookId,
        isCalibreBook,
        calibreUuid: calibreBook?.uuid,
        metadataBookId: loadedBook.metadata.bookId,
        bookId
      });

      // Update sidebar store with current book info so sidebar knows which book is open
      sidebarStore.setActiveBook(highlightBookId || null, bookPath, bookTitle);

      // Per-book settings were already loaded BEFORE renderer creation (no mode switch needed)

      // Load saved position
      let savedCfi: string | undefined;
      if (isCalibreBook && calibreBook) {
        // Load from plugin data where saveProgress stores it
        const pluginData = await plugin.loadData() as Record<string, any> | null;
        const calibreProgress = pluginData?.calibreProgress?.[calibreBook.uuid];
        if (calibreProgress) {
          savedCfi = calibreProgress.currentCfi;
          progress = calibreProgress.progress || 0;
        }
        console.log('[ServerReader] Calibre book position:', { uuid: calibreBook.uuid, savedCfi, progress });
      } else {
        const vaultBook = vaultBooks.find(b => b.localPath === bookPath);
        savedCfi = vaultBook?.currentCfi;
        progress = vaultBook?.progress || 0;
        console.log('[ServerReader] Vault book position:', {
          bookPath,
          foundBook: !!vaultBook,
          savedCfi,
          progress,
          vaultBooksCount: vaultBooks.length
        });
      }

      // Display at saved position (use instant scroll for initial load)
      // Use percentage for accurate position restoration (CFI only saves chapter, not position within)
      console.log('[ServerReader] Displaying at position:', { savedCfi, progress });
      if (progress > 0) {
        // Use percentage-based navigation for accurate restoration
        await renderer.display({ type: 'percentage', percentage: progress }, { instant: true });
      } else if (savedCfi) {
        // Fallback to CFI if no progress saved
        await renderer.display({ type: 'cfi', cfi: savedCfi }, { instant: true });
      } else {
        await renderer.display(undefined, { instant: true });
      }

      // Load highlights, bookmarks, and notes
      if (highlightBookId) {
        // First, scan vault for any atomic highlights not yet in the store
        if (bookTitle && plugin.loadAtomicHighlightsFromVault) {
          const loaded = await plugin.loadAtomicHighlightsFromVault(highlightBookId, bookTitle);
          if (loaded > 0) {
            console.log(`[ServerReader] Loaded ${loaded} highlights from vault`);
          }
        }

        // Load highlights and bookmarks data
        if (plugin.highlightService) {
          bookHighlights = plugin.highlightService.getHighlights(highlightBookId);
        }
        if (plugin.bookmarkService) {
          const artifacts = plugin.bookmarkService.getBookArtifacts(highlightBookId);
          bookBookmarks = artifacts.bookmarks;
          bookNotes = artifacts.notes;
        }

        // Pass highlights to renderer after layout is stable
        console.warn('[ServerReader] About to set highlights:', {
          count: bookHighlights.length,
          mode: readerSettings.flow,
          hasRenderer: !!renderer
        });
        if (bookHighlights.length > 0) {
          // Wait for layout stability after display()
          // Multiple rAF calls ensure we're past any pending layout/scroll updates
          await new Promise(r => requestAnimationFrame(r));
          await new Promise(r => requestAnimationFrame(r));
          await new Promise(r => setTimeout(r, 200));
          // Force browser to process any pending scroll events
          await new Promise(r => requestAnimationFrame(r));
          console.warn('[ServerReader] Calling setStoredHighlights now');
          renderer?.setStoredHighlights(bookHighlights);
        }
      }

      // Set up auto-save interval
      autoSaveInterval = setInterval(() => {
        saveProgress();
      }, AUTO_SAVE_INTERVAL_MS);

      // Set up beforeunload handler
      window.addEventListener('beforeunload', saveProgress);

      loading = false;

      // Update sidebar with ToC
      updateSidebarToc();

      // Also update ToC when sidebar opens (in case it wasn't open when book loaded)
      const layoutChangeRef = plugin.app.workspace.on('layout-change', () => {
        // Debounce: only call if sidebar exists and book is loaded
        if (book) {
          updateSidebarToc();
        }
      });
      // Store reference for cleanup
      (window as any).__amnesiaLayoutChangeRef = layoutChangeRef;

      // Build search index in background (non-blocking)
      buildSearchIndex();
    } catch (e) {
      console.error('Failed to load book:', e);
      error = e instanceof Error ? e.message : String(e);
      loading = false;
    }
  });

  onDestroy(() => {
    document.body.classList.remove('amnesia-fullscreen-mode');

    // Clear search index
    clearSearchIndex();

    // Save final progress
    saveProgress();

    // Save final settings (clear pending and save immediately)
    if (saveSettingsTimeout) {
      clearTimeout(saveSettingsTimeout);
      saveSettingsTimeout = null;
    }
    if (highlightBookId && plugin.bookSettingsStore) {
      const perBook = extractPerBookSettings(readerSettings);
      plugin.bookSettingsStore.saveBookSettings(highlightBookId, perBook);
    }

    // Clean up auto-save interval
    if (autoSaveInterval) {
      clearInterval(autoSaveInterval);
      autoSaveInterval = null;
    }

    // Clean up debounced progress save
    if (saveProgressTimeout) {
      clearTimeout(saveProgressTimeout);
      saveProgressTimeout = null;
    }

    // Remove beforeunload handler
    window.removeEventListener('beforeunload', saveProgress);

    // Clean up layout change listener
    const layoutChangeRef = (window as any).__amnesiaLayoutChangeRef;
    if (layoutChangeRef) {
      plugin.app.workspace.offref(layoutChangeRef);
      delete (window as any).__amnesiaLayoutChangeRef;
    }

    // Clean up auto-scroll
    stopAutoScroll();

    // Clean up wheel debounce timer
    if (wheelDebounceTimer) {
      clearTimeout(wheelDebounceTimer);
      wheelDebounceTimer = null;
    }

    // Clean up Calibre store subscription
    calibreStoreUnsubscribe?.();

    // Clean up
    renderer?.destroy();
    pdfProvider?.destroy?.(); // PDF provider cleanup if available
    // EPUB provider cleanup (MuPDFEpubContentProvider has caches that need clearing)
    if (providerAdapter && 'destroy' in providerAdapter) {
      (providerAdapter as { destroy: () => void }).destroy();
    }

    // Stop Resource Detector monitoring (Phase R2.2)
    if (plugin.resourceDetector) {
      plugin.resourceDetector.stop();
    }
  });

  // Event handlers
  function handleRelocated(location: ReadingLocation) {
    progress = location.percentage;

    // Use book-wide page numbers if available, otherwise fall back to chapter-relative
    currentPage = location.pageInBook ?? location.pageInChapter ?? 0;
    totalPages = location.totalPagesInBook ?? location.totalPagesInChapter ?? 0;

    // Find current chapter using robust matching
    if (book) {
      const spineItem = book.spine[location.spineIndex];
      currentChapter = resolveChapterName(spineItem, toc, progress);
    }

    // Update sidebar with current location for TOC progress tracking
    updateSidebarLocation(location);

    // Close highlight popup on scroll/navigation to prevent stale positioning
    if (showHighlightPopup) {
      closePopup();
    }

    // Trigger debounced progress save on each page turn
    debouncedSaveProgress();
  }

  /**
   * Update sidebar with current location for TOC progress tracking
   */
  function updateSidebarLocation(location: ReadingLocation): void {
    if (!plugin || !book) return;

    // Create a Locator from ReadingLocation for the sidebar
    const locator = {
      href: location.href,
      locations: {
        progression: location.progressionInChapter ?? location.percentage / 100,
        totalProgression: location.percentage / 100,
        position: location.spineIndex,
        cfi: location.cfi,
      },
      title: currentChapter,
    };

    // Find the sidebar view and update its location
    const leaves = plugin.app.workspace.getLeavesOfType('amnesia-book-sidebar');
    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view.updateLocation) {
        view.updateLocation(locator);
      }
    }
  }

  function handleRendered(data: { spineIndex: number; href: string }) {
    // Chapter rendered
    console.log('[Rendered]', data.href);

    // Re-anchor highlights after chapter render (new system uses setStoredHighlights)
    if (renderer && bookHighlights.length > 0) {
      setTimeout(() => {
        renderer?.setStoredHighlights(bookHighlights);
      }, 100);
    }
  }

  function handleSelected(data: {
    text: string;
    cfi: string;
    range?: Range;
    position: { x: number; y: number };
    spineIndex?: number;
    selector?: { textQuote?: { exact: string; prefix?: string; suffix?: string }; textPosition?: { start: number; end: number } };
    rects?: Array<{ x: number; y: number; width: number; height: number }>;
  }) {
    console.log('[ServerReader] handleSelected called', { textLength: data.text?.length, position: data.position });
    // Use highlightBookId which is set consistently for both Calibre and vault books
    const activeBookId = highlightBookId;
    if (!activeBookId || !data.text) {
      console.log('[ServerReader] handleSelected early return - no bookId or text', { activeBookId, hasText: !!data.text, highlightBookId, bookId });
      return;
    }

    // Capture selection rects for immediate highlight rendering
    // PDF provides pre-computed rects, EPUB provides a Range object
    let rectsJson: Array<{ x: number; y: number; width: number; height: number }>;
    if (data.rects) {
      // PDF: use pre-computed rects directly
      rectsJson = data.rects;
    } else if (data.range) {
      // EPUB: compute rects from Range
      const selectionRects = HighlightOverlay.getRectsFromRange(data.range);
      rectsJson = selectionRects.map(r => ({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }));
    } else {
      // No rects available - use empty array
      rectsJson = [];
    }

    // Set up pending selection for highlight popup with robust anchoring data
    pendingSelection = {
      bookId: activeBookId,
      text: data.text,
      cfi: data.cfi,
      chapter: currentChapter,
      pagePercent: progress,
      rects: rectsJson,
      // NEW: Robust anchoring fields
      spineIndex: data.spineIndex,
      textQuote: data.selector?.textQuote,
      textPosition: data.selector?.textPosition,
    };

    // Use the position from the selection event (already translated from iframe coordinates)
    highlightPopupPosition = {
      x: data.position.x,
      y: data.position.y + 10, // Small offset below selection
    };

    console.log('[ServerReader] Popup position: x=' + highlightPopupPosition.x + ', y=' + highlightPopupPosition.y + ' (from selection: x=' + data.position.x + ', y=' + data.position.y + ')');

    // Set flag to ignore the click event that follows the selection
    ignoreNextContainerClick = true;
    setTimeout(() => { ignoreNextContainerClick = false; }, 100);

    showHighlightPopup = true;
    highlightPopupMode = 'new';
    selectedExistingHighlight = null;

    if (readerSettings.hapticFeedback) {
      HapticFeedback.light();
    }
  }

  function handleHighlightClicked(data: { annotationId: string; position: { x: number; y: number } }) {
    // Find the highlight in bookHighlights by its ID
    const highlight = bookHighlights.find(h => h.id === data.annotationId);
    if (!highlight) {
      console.warn('[Reader] Clicked highlight not found:', data.annotationId);
      return;
    }

    // Set flag to ignore the click event that follows
    ignoreNextContainerClick = true;
    setTimeout(() => { ignoreNextContainerClick = false; }, 100);

    // Show popup in 'existing' mode for the clicked highlight
    // Use the position from the event (translated from iframe coords)
    selectedExistingHighlight = highlight;
    highlightPopupMode = 'existing';
    highlightPopupPosition = {
      x: data.position.x,
      y: data.position.y + 10,
    };
    pendingSelection = null;
    showHighlightPopup = true;

    console.log('[ServerReader] Highlight clicked, popup at: x=' + highlightPopupPosition.x + ', y=' + highlightPopupPosition.y);

    if (readerSettings.hapticFeedback) {
      HapticFeedback.light();
    }
  }

  function handleError(err: Error) {
    console.error('[Reader Error]', err);
    error = err.message;
  }

  function handleLinkClicked(data: { href: string; external: boolean }) {
    if (data.external) {
      // Open external links in the default browser
      window.open(data.href, '_blank', 'noopener,noreferrer');
    }
    // Internal links are handled by the renderer itself (navigation + pulse animation)
  }

  /**
   * Handle image click from the content renderer.
   * Opens the lightbox with all book images, starting at the clicked image.
   */
  async function handleImageClicked(data: { src: string; blobUrl: string; alt?: string; spineIndex: number }) {
    // Get all book images
    const allImages = await getBookImages();

    if (allImages.length === 0) {
      // Fallback: just show the clicked image
      const clickedImage: LightboxImage = {
        id: `content-image-${data.spineIndex}-${Date.now()}`,
        href: data.src,
        blobUrl: data.blobUrl || data.src,
      };
      lightboxImages = [clickedImage];
      lightboxStartIndex = 0;
      lightboxOpen = true;
      return;
    }

    // Convert BookImage[] to LightboxImage[]
    lightboxImages = allImages.map(img => ({
      id: img.id,
      href: img.href,
      blobUrl: img.blobUrl,
      width: img.width,
      height: img.height,
    }));

    // Find the index of the clicked image by matching blobUrl or href
    let clickedIndex = lightboxImages.findIndex(img =>
      img.blobUrl === data.blobUrl || img.blobUrl === data.src || img.href === data.src
    );

    // If not found by URL, try to find by spine index (approximate match)
    if (clickedIndex === -1) {
      clickedIndex = allImages.findIndex(img => img.spineIndex === data.spineIndex);
    }

    // Default to first image if not found
    lightboxStartIndex = Math.max(0, clickedIndex);
    lightboxOpen = true;
  }

  /**
   * Close the image lightbox
   */
  function closeLightbox() {
    lightboxOpen = false;
    lightboxImages = [];
    lightboxStartIndex = 0;
  }

  // Navigation
  function prevPage() {
    renderer?.prev();
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  function nextPage() {
    renderer?.next();
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  function goToChapter(entry: TocEntry) {
    renderer?.display({ type: 'href', href: entry.href });
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  function handleSeek(event: CustomEvent<{ percent: number }>) {
    renderer?.display({ type: 'percentage', percentage: event.detail.percent });
    if (readerSettings.hapticFeedback) HapticFeedback.medium();
  }

  function handleProgressClick(event: MouseEvent) {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percent = (x / rect.width) * 100;
    renderer?.display({ type: 'percentage', percentage: percent });
    if (readerSettings.hapticFeedback) HapticFeedback.medium();
  }

  // Settings
  let saveSettingsTimeout: number | null = null;
  const SETTINGS_SAVE_DELAY_MS = 500;

  // Debounced save of per-book settings
  function debouncedSaveSettings() {
    if (saveSettingsTimeout) {
      clearTimeout(saveSettingsTimeout);
    }
    saveSettingsTimeout = window.setTimeout(async () => {
      if (highlightBookId && plugin.bookSettingsStore) {
        const perBook = extractPerBookSettings(readerSettings);
        await plugin.bookSettingsStore.saveBookSettings(highlightBookId, perBook);
      }
    }, SETTINGS_SAVE_DELAY_MS);
  }

  // Debounced save of reading progress (triggered on page turns)
  let saveProgressTimeout: number | null = null;
  const PROGRESS_SAVE_DELAY_MS = 2000; // Save progress 2 seconds after navigation stops

  function debouncedSaveProgress() {
    if (saveProgressTimeout) {
      clearTimeout(saveProgressTimeout);
    }
    saveProgressTimeout = window.setTimeout(() => {
      saveProgress();
    }, PROGRESS_SAVE_DELAY_MS);
  }

  // Track if a significant layout change is in progress
  let layoutChangeInProgress = false;

  async function handleSettingsChange(event: CustomEvent<{ settings: Partial<ReaderSettings> }>) {
    const changes = event.detail.settings;
    const previousFlow = readerSettings.flow;

    // Check if this is a significant layout change that requires position preservation
    const isModeChange = changes.flow !== undefined && changes.flow !== previousFlow;
    const isLayoutChange = isModeChange ||
      changes.fontSize !== undefined ||
      changes.margins !== undefined ||
      changes.columns !== undefined ||
      changes.lineHeight !== undefined;

    // Save current position before any layout changes
    let savedCfi: string | undefined;
    if (isLayoutChange && renderer) {
      const location = renderer.getLocation();
      savedCfi = location?.cfi;
      console.log('[Settings] Saving position before layout change:', savedCfi);
    }

    // Show loading indicator for mode changes
    if (isModeChange) {
      loading = true;
      layoutChangeInProgress = true;
    }

    try {
      // Properly merge margins if they're being updated
      if (changes.margins) {
        readerSettings = {
          ...readerSettings,
          ...changes,
          margins: { ...readerSettings.margins, ...changes.margins }
        };
      } else {
        readerSettings = { ...readerSettings, ...changes };
      }

      // Apply to renderer - include all configurable settings
      // Note: Renderer currently only supports single margin value
      // Using horizontal margin (left) for column padding
      if (renderer) {
        await renderer.updateConfig({
          mode: readerSettings.flow === 'paginated' ? 'paginated' : 'scrolled',
          fontSize: readerSettings.fontSize,
          fontFamily: readerSettings.fontFamily,
          lineHeight: readerSettings.lineHeight,
          textAlign: readerSettings.textAlign,
          theme: readerSettings.theme,
          columns: readerSettings.columns,
          margin: getMarginValue(readerSettings.margins),
        });

        // Restore position after layout changes
        if (savedCfi) {
          // Short wait for layout to settle before navigating (reduced for faster UX)
          await new Promise(r => setTimeout(r, isModeChange ? 100 : 50));

          try {
            await renderer.display({ type: 'cfi', cfi: savedCfi }, { instant: true });
            console.log('[Settings] Restored position to:', savedCfi);
          } catch (e) {
            console.warn('[Settings] Failed to restore position:', e);
          }

          // Refresh highlights after position restore (async, don't block)
          if (bookHighlights.length > 0) {
            requestAnimationFrame(() => {
              renderer?.setStoredHighlights(bookHighlights);
            });
          }
        }
      }
    } catch (e) {
      console.error('[Settings] Error during settings change:', e);
    } finally {
      // Always hide loading indicator, even if an error occurred
      if (isModeChange) {
        loading = false;
        layoutChangeInProgress = false;
      }
    }

    // Apply brightness filter to container
    if (changes.brightness !== undefined && rendererContainer) {
      const brightness = changes.brightness / 100;
      rendererContainer.style.filter = brightness < 1 ? `brightness(${brightness})` : '';
    }

    if (readerSettings.hapticFeedback) HapticFeedback.light();

    // Save settings with debounce
    debouncedSaveSettings();
  }

  // Highlights
  async function handleCreateHighlight(event: CustomEvent<{ color: HighlightColor; annotation?: string; tags?: string[]; type?: 'highlight' | 'underline'; category?: StubType }>) {
    if (!pendingSelection) return;

    // Clear text selection IMMEDIATELY when user clicks to create highlight
    // This prevents overlay overlap with selection and gives immediate visual feedback
    renderer?.clearSelection();

    const now = new Date();

    // Build W3C-aligned selector for robust re-anchoring
    const selector = {
      primary: { type: 'CfiSelector' as const, cfi: pendingSelection.cfi },
      fallback: {
        type: 'TextQuoteSelector' as const,
        exact: pendingSelection.textQuote?.exact ?? pendingSelection.text,
        prefix: pendingSelection.textQuote?.prefix,
        suffix: pendingSelection.textQuote?.suffix,
      },
      ...(pendingSelection.textPosition && {
        position: {
          type: 'TextPositionSelector' as const,
          start: pendingSelection.textPosition.start,
          end: pendingSelection.textPosition.end,
        },
      }),
    };

    const highlight: Highlight = {
      id: `hl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      bookId: pendingSelection.bookId,
      text: pendingSelection.text,
      cfi: pendingSelection.cfi,
      color: event.detail.color,
      chapter: pendingSelection.chapter,
      pagePercent: pendingSelection.pagePercent,
      createdAt: now,
      updatedAt: now,
      synced: false,
      annotation: event.detail.annotation,
      tags: event.detail.tags,
      type: event.detail.type || 'highlight',
      // NEW: Robust anchoring fields
      spineIndex: pendingSelection.spineIndex ?? 0,
      selector,
    };

    // Save locally
    plugin.highlightService?.addHighlight(highlight);
    bookHighlights = [...bookHighlights, highlight];

    // Update stored highlights for re-anchoring
    renderer?.setStoredHighlights(bookHighlights);

    // Add to renderer overlay for immediate display
    if (renderer && pendingSelection.rects && pendingSelection.rects.length > 0) {
      renderer.addHighlight(highlight.id, highlight.id, event.detail.color, pendingSelection.rects);
    }

    closePopup();

    if (readerSettings.hapticFeedback) HapticFeedback.success();
  }

  async function handleDeleteHighlight(event?: CustomEvent<{ id: string }>) {
    const highlightId = event?.detail?.id || selectedExistingHighlight?.id;
    if (!highlightId) return;

    plugin.highlightService?.deleteHighlight(highlightId);
    bookHighlights = bookHighlights.filter(h => h.id !== highlightId);

    // Remove from renderer overlay
    renderer?.removeHighlight(highlightId);

    closePopup();

    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  async function handleCreateKnowledgeGap(event: CustomEvent<{ stubType: StubType; text: string; color: HighlightColor }>) {
    const { stubType, text } = event.detail;
    const bridge = plugin.docDoctorBridge;

    if (!bridge?.isConnected() || !loadedBook) {
      console.warn('[ServerReader] Cannot create knowledge gap: Doc Doctor not connected');
      return;
    }

    try {
      // Get the book note path for linking
      const notePath = getCalibreBookNotePath(loadedBook.metadata, plugin);

      if (notePath) {
        // Create stub in Doc Doctor
        await bridge.createStub({
          type: stubType,
          description: text.slice(0, 200),
          filePath: notePath,
          source: {
            plugin: 'amnesia',
          },
        });

        console.log('[ServerReader] Created knowledge gap stub:', stubType);
      }
    } catch (error) {
      console.error('[ServerReader] Failed to create knowledge gap:', error);
    }

    // Note: The highlight is created by the 'highlight' event that HighlightPopup
    // also dispatches when creating a knowledge gap. No need to create it here.
  }

  async function handleUpdateHighlight(event: CustomEvent<{ id: string; color?: HighlightColor; annotation?: string; tags?: string[]; locked?: boolean }>) {
    const { id, ...updates } = event.detail;

    // Find and update the highlight
    const highlightIndex = bookHighlights.findIndex(h => h.id === id);
    if (highlightIndex === -1) return;

    const updatedHighlight = {
      ...bookHighlights[highlightIndex],
      ...updates,
      updatedAt: new Date(),
      synced: false,
    };

    // Update locally
    bookHighlights[highlightIndex] = updatedHighlight;
    bookHighlights = [...bookHighlights]; // Trigger reactivity

    plugin.highlightService?.updateHighlight(highlightBookId, id, updates);

    // Update overlay if color changed
    if (updates.color && renderer) {
      renderer.updateHighlightColor(id, updates.color);
    }

    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  function handleBookmarkFromPopup(event: CustomEvent<{ name?: string }>) {
    // Create a bookmark at current position
    const name = event.detail.name || currentChapter || `Page ${currentPage + 1}`;
    // For now, just provide haptic feedback - full bookmark system can be implemented later
    if (readerSettings.hapticFeedback) HapticFeedback.success();
    closePopup();
  }

  function handleCopyText(event: CustomEvent<{ text: string }>) {
    navigator.clipboard.writeText(event.detail.text).then(() => {
      if (readerSettings.hapticFeedback) HapticFeedback.success();
    }).catch(() => {});
    closePopup();
  }

  function handleCopyLink(event: CustomEvent<{ cfi: string; bookId: string }>) {
    // Create a link to this position in the book
    const link = `obsidian://amnesia?book=${encodeURIComponent(event.detail.bookId)}&cfi=${encodeURIComponent(event.detail.cfi)}`;
    navigator.clipboard.writeText(link).then(() => {
      if (readerSettings.hapticFeedback) HapticFeedback.success();
    }).catch(() => {});
    closePopup();
  }

  function getAllTags(): string[] {
    // Collect all unique tags from book highlights
    const tagSet = new Set<string>();
    bookHighlights.forEach(h => {
      h.tags?.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }

  function closePopup() {
    console.log('[closePopup] Called from:', new Error().stack);
    showHighlightPopup = false;
    pendingSelection = null;
    selectedExistingHighlight = null;
  }

  // Progress saving
  function saveProgress() {
    if (!renderer) return;

    const location = renderer.getLocation();
    if (!location) return;

    const cfi = location.cfi;
    const progressVal = location.percentage;

    console.log('[ServerReader] Saving progress:', { cfi, progress: progressVal, isCalibreBook });

    if (isCalibreBook && calibreBook) {
      // Save to plugin data for Calibre books
      plugin.loadData().then((data: Record<string, any>) => {
        data = data || {};
        data.calibreProgress = data.calibreProgress || {};
        data.calibreProgress[calibreBook!.uuid] = {
          progress: progressVal,
          currentCfi: cfi,
          updatedAt: new Date().toISOString(),
        };
        plugin.saveData(data);
        console.log('[ServerReader] Saved Calibre progress:', { uuid: calibreBook!.uuid, cfi });
      });
    } else {
      // Save to library store for vault books
      const vaultBook = plugin.libraryStore.getValue().books.find(b => b.localPath === bookPath);
      if (vaultBook) {
        plugin.libraryService?.updateProgress(vaultBook.id, progressVal, cfi);
        console.log('[ServerReader] Saved vault book progress:', { id: vaultBook.id, cfi });
      }
    }
  }

  // UI toggles
  function toggleFullScreen() {
    const readerElement = container?.closest('.amnesia-reader');
    if (!readerElement) return;

    const isCurrentlyFullscreen = document.fullscreenElement != null;

    if (!isCurrentlyFullscreen) {
      readerElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }

    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  // Open book images gallery
  function openImagesGallery() {
    if (!bookPath) return;
    // Create new leaf with images view
    plugin.openBookImages(bookPath, bookTitle);
    showMoreMenu = false;
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  // Open in Calibre
  function openInCalibre() {
    if (!isCalibreBook || !calibreBook) return;

    const calibreUrl = `calibre://show-book/${encodeURIComponent(plugin.settings.calibreLibraryPath)}/${calibreBook.calibreId}`;
    window.open(calibreUrl, '_blank');
    showMoreMenu = false;
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  // Toggle bookmark at current position
  async function toggleBookmark() {
    if (!renderer || !highlightBookId || !plugin.bookmarkService) {
      if (readerSettings.hapticFeedback) HapticFeedback.error();
      return;
    }

    const location = renderer.getLocation();
    if (!location) {
      if (readerSettings.hapticFeedback) HapticFeedback.error();
      return;
    }

    try {
      const result = await plugin.bookmarkService.toggleBookmark({
        bookId: highlightBookId,
        cfi: location.cfi,
        name: currentChapter || `Page ${currentPage + 1}`,
        chapter: currentChapter,
        pagePercent: Math.round(progress),
      });

      // Refresh bookmarks list
      bookBookmarks = plugin.bookmarkService.getBookmarks(highlightBookId);

      if (result.created) {
        if (readerSettings.hapticFeedback) HapticFeedback.success();
      } else {
        if (readerSettings.hapticFeedback) HapticFeedback.light();
      }
    } catch (e) {
      console.error('Failed to toggle bookmark:', e);
      if (readerSettings.hapticFeedback) HapticFeedback.error();
    }
  }

  // Check if current position has a bookmark
  $: hasBookmarkAtCurrentPosition = (() => {
    if (!renderer || !highlightBookId || !plugin.bookmarkService) return false;
    const location = renderer.getLocation();
    if (!location) return false;
    return plugin.bookmarkService.hasBookmarkAtCfi(highlightBookId, location.cfi);
  })();

  // Show book info
  function toggleBookInfo() {
    showBookInfo = !showBookInfo;
    showMoreMenu = false;
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  // Open book sidebar (new Obsidian ItemView)
  async function openBookSidebar(tab?: SidebarTab) {
    // Use highlightBookId, calibre UUID, or bookPath as fallback for active book ID
    const activeBookId = highlightBookId || (isCalibreBook ? calibreBook?.uuid : null) || bookPath;
    console.log('[ServerReader] openBookSidebar:', { tab, activeBookId, bookPath, bookTitle, hasBook: !!book, hasToc: !!book?.toc });

    if (tab) {
      sidebarStore.setTab(tab);
    }
    sidebarStore.setActiveBook(activeBookId, bookPath, bookTitle);
    await plugin.activateBookSidebar(activeBookId, bookPath, bookTitle);

    // Update sidebar with ToC data after it's opened
    // Use setTimeout to ensure sidebar component is mounted
    setTimeout(() => {
      updateSidebarToc();
    }, 100);

    showMoreMenu = false;
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  // Legacy: Toggle in-reader notebook sidebar (kept for fallback)
  function toggleNotebook() {
    showNotebook = !showNotebook;
    showSettings = false;
    showBookInfo = false;
    showMoreMenu = false;
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  // Legacy: Open in-reader notebook sidebar to a specific tab (kept for fallback)
  function openNotebookTab(tab: 'highlights' | 'bookmarks' | 'notes' | 'images') {
    notebookTab = tab;
    showNotebook = true;
    showSettings = false;
    showBookInfo = false;
    showMoreMenu = false;
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  // Handle notebook sidebar navigation
  function handleNotebookNavigate(event: CustomEvent<{ cfi: string; text?: string }>) {
    const { cfi, text } = event.detail;
    // Use text-based navigation for highlights (works with Shadow DOM)
    if (text) {
      navigateToHighlight(cfi, text);
    } else {
      // Fallback to CFI for bookmarks/notes
      renderer?.display({ type: 'cfi', cfi });
    }
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  // Handle bookmark deletion from sidebar
  async function handleDeleteBookmarkFromSidebar(event: CustomEvent<{ id: string }>) {
    if (!plugin.bookmarkService || !highlightBookId) return;
    try {
      await plugin.bookmarkService.deleteBookmark(highlightBookId, event.detail.id);
      bookBookmarks = plugin.bookmarkService.getBookmarks(highlightBookId);
      if (readerSettings.hapticFeedback) HapticFeedback.light();
    } catch (e) {
      console.error('Failed to delete bookmark:', e);
    }
  }

  // Handle note deletion from sidebar
  async function handleDeleteNoteFromSidebar(event: CustomEvent<{ id: string }>) {
    if (!plugin.bookmarkService || !highlightBookId) return;
    try {
      await plugin.bookmarkService.deleteNote(highlightBookId, event.detail.id);
      bookNotes = plugin.bookmarkService.getNotes(highlightBookId);
      if (readerSettings.hapticFeedback) HapticFeedback.light();
    } catch (e) {
      console.error('Failed to delete note:', e);
    }
  }

  // Handle highlight deletion from sidebar
  async function handleDeleteHighlightFromSidebar(event: CustomEvent<{ id: string }>) {
    if (!plugin.highlightService || !highlightBookId) return;
    const highlightId = event.detail.id;

    try {
      // Delete from service
      await plugin.highlightService.deleteHighlight(highlightBookId, highlightId);

      // Update local array (triggers sidebar reactivity)
      bookHighlights = bookHighlights.filter(h => h.id !== highlightId);

      // Remove from renderer overlay immediately
      renderer?.removeHighlight(highlightId);

      if (readerSettings.hapticFeedback) HapticFeedback.light();
    } catch (e) {
      console.error('Failed to delete highlight:', e);
    }
  }

  // Auto-scroll toggle
  function toggleAutoScroll() {
    isAutoScrolling = !isAutoScrolling;
    if (isAutoScrolling) {
      startAutoScroll();
    } else {
      stopAutoScroll();
    }
    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  let autoScrollInterval: ReturnType<typeof setInterval> | null = null;

  function startAutoScroll() {
    if (autoScrollInterval) clearInterval(autoScrollInterval);
    const speed = readerSettings.autoScroll?.speed ?? 5;
    const delay = Math.max(500, 3000 - (speed * 250));
    autoScrollInterval = setInterval(() => {
      if (renderer && isAutoScrolling) {
        renderer.next();
      }
    }, delay);
  }

  function stopAutoScroll() {
    if (autoScrollInterval) {
      clearInterval(autoScrollInterval);
      autoScrollInterval = null;
    }
    isAutoScrolling = false;
  }

  // Quick toggle between scrolled and paginated modes
  async function toggleReadingMode() {
    const newMode = readerSettings.flow === 'paginated' ? 'scrolled' : 'paginated';
    console.log('[ServerReader] Toggling reading mode:', readerSettings.flow, '→', newMode);

    // Dispatch settings change to use existing handler
    const event = new CustomEvent('settingschange', {
      detail: { settings: { flow: newMode } }
    });
    await handleSettingsChange(event as CustomEvent<{ settings: Partial<ReaderSettings> }>);

    if (readerSettings.hapticFeedback) HapticFeedback.medium();
  }

  /**
   * Toggle Source/Live mode (Cmd/Ctrl+E)
   * Foundation for analytical vs immersive reading modes
   */
  function toggleSourceLiveMode() {
    const previousMode = readerModeConfig.mode;
    readerModeConfig = toggleReaderMode(readerModeConfig);
    console.log('[ServerReader] Source/Live mode toggle:', previousMode, '→', readerModeConfig.mode);

    // TODO: Apply effective settings to renderer when feature is fully implemented
    // For now, just update the state which triggers reactivity

    if (readerSettings.hapticFeedback) HapticFeedback.light();
  }

  // ==========================================================================
  // PDF-specific handlers
  // ==========================================================================

  function handlePdfSettingsChange(event: CustomEvent<{ settings: Partial<import('../../settings/settings').PdfSettings> }>) {
    const changes = event.detail.settings;
    plugin.settings.pdf = { ...plugin.settings.pdf, ...changes };
    plugin.saveSettings();

    // Update local reactive state
    pdfSettings = { ...pdfSettings, ...changes };

    // Apply changes to the PDF renderer
    if (isPdf && renderer) {
      const pdfRenderer = renderer as PdfRenderer;
      if (changes.scale !== undefined) {
        pdfRenderer.setScale(changes.scale);
      }
      if (changes.rotation !== undefined) {
        pdfRenderer.setRotation(changes.rotation);
      }
      if (changes.displayMode !== undefined) {
        pdfRenderer.setDisplayMode(changes.displayMode);
      }
      if (changes.readingMode !== undefined) {
        // Map PdfReadingMode to theme and apply CSS styling
        applyPdfReadingMode(changes.readingMode);
      }
    }
  }

  function applyPdfReadingMode(mode: import('../../settings/settings').PdfReadingMode) {
    if (!isPdf || !renderer) return;

    const pdfRenderer = renderer as PdfRenderer;
    pdfRenderer.setReadingMode(mode);

    // Also add class to container for additional styling hooks
    const pdfContainer = rendererContainer?.querySelector('.pdf-page-container');
    if (pdfContainer) {
      pdfContainer.classList.remove('reading-mode-device', 'reading-mode-light', 'reading-mode-sepia', 'reading-mode-dark', 'reading-mode-night');
      pdfContainer.classList.add(`reading-mode-${mode}`);
    }
  }

  function handlePdfZoomIn() {
    if (!isPdf || !renderer) return;
    // Use logarithmic zoom steps for better UX at high zoom levels
    // Read from pdfCurrentZoom (live camera state) not settings
    const currentScale = pdfCurrentZoom;
    const step = currentScale < 2 ? 0.25 : currentScale < 8 ? 0.5 : 1;
    const newScale = Math.min(currentScale + step, 32);
    handlePdfSettingsChange({ detail: { settings: { scale: newScale } } } as CustomEvent);
  }

  function handlePdfZoomOut() {
    if (!isPdf || !renderer) return;
    // Use logarithmic zoom steps for better UX at high zoom levels
    // Read from pdfCurrentZoom (live camera state) not settings
    const currentScale = pdfCurrentZoom;
    const step = currentScale <= 2 ? 0.25 : currentScale <= 8 ? 0.5 : 1;
    const newScale = Math.max(currentScale - step, 0.1);
    handlePdfSettingsChange({ detail: { settings: { scale: newScale } } } as CustomEvent);
  }

  // Page input state
  let pageInputValue = '';
  let isPageInputEditing = false;
  let pageInputEl: HTMLInputElement;

  function handlePageCountClick() {
    isPageInputEditing = true;
    pageInputValue = String(pdfCurrentPage);
    // Focus the input after it renders
    tick().then(() => pageInputEl?.focus());
  }

  function handlePdfPageInputBlur() {
    isPageInputEditing = false;
    pageInputValue = '';
  }

  function handlePdfPageInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      const targetPage = parseInt(pageInputValue, 10);
      if (!isNaN(targetPage) && targetPage >= 1 && targetPage <= pdfTotalPages) {
        // Navigate to the page (position is 1-indexed in our display)
        renderer?.display({ type: 'position', position: targetPage });
        // Update page count immediately
        pdfCurrentPage = targetPage;
        if (readerSettings.hapticFeedback) HapticFeedback.medium();
      }
      // Blur the input after navigation
      (event.target as HTMLInputElement)?.blur();
    } else if (event.key === 'Escape') {
      (event.target as HTMLInputElement)?.blur();
    }
  }

  function handlePdfFitWidth() {
    if (!isPdf || !renderer) return;
    const pdfRenderer = renderer as PdfRenderer;
    pdfRenderer.fitToWidth();
  }

  function handlePdfFitPage() {
    if (!isPdf || !renderer) return;
    const pdfRenderer = renderer as PdfRenderer;
    pdfRenderer.fitToPage();
  }

  function handlePdfRotateCw() {
    if (!isPdf || !renderer) return;
    const pdfRenderer = renderer as PdfRenderer;
    pdfRenderer.rotateClockwise();
    // Get the new rotation from the renderer (it's the source of truth)
    const newRotation = (pdfRenderer.getConfig().rotation ?? 0) as 0 | 90 | 180 | 270;
    plugin.settings.pdf.rotation = newRotation;
    plugin.saveSettings();
  }

  function handlePdfRotateCcw() {
    if (!isPdf || !renderer) return;
    const pdfRenderer = renderer as PdfRenderer;
    pdfRenderer.rotateCounterClockwise();
    // Get the new rotation from the renderer (it's the source of truth)
    const newRotation = (pdfRenderer.getConfig().rotation ?? 0) as 0 | 90 | 180 | 270;
    plugin.settings.pdf.rotation = newRotation;
    plugin.saveSettings();
  }

  /**
   * Set PDF display mode (5 modes)
   */
  function handlePdfDisplayModeChange(mode: import('../../settings/settings').PdfDisplayMode) {
    if (!isPdf || !renderer) return;
    const pdfRenderer = renderer as PdfRenderer;

    pdfSettings = { ...pdfSettings, displayMode: mode };
    plugin.settings.pdf.displayMode = mode;
    plugin.saveSettings();

    // Update renderer display mode
    pdfRenderer.setDisplayMode(mode);
  }

  /**
   * Cycle through display modes: paginated -> vertical-scroll -> horizontal-scroll -> auto-grid -> canvas -> paginated
   */
  function handlePdfModeToggle() {
    if (!isPdf || !renderer) return;

    const modes: import('../../settings/settings').PdfDisplayMode[] = [
      'paginated',
      'vertical-scroll',
      'horizontal-scroll',
      'auto-grid',
      'canvas',
    ];
    const currentIndex = modes.indexOf(pdfSettings.displayMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    handlePdfDisplayModeChange(modes[nextIndex]);
  }

  /** @deprecated Use handlePdfDisplayModeChange instead */
  function handlePdfScrollDirectionToggle() {
    if (!isPdf || !renderer) return;
    // Convert scroll direction toggle to display mode change
    if (pdfSettings.displayMode === 'vertical-scroll') {
      handlePdfDisplayModeChange('horizontal-scroll');
    } else if (pdfSettings.displayMode === 'horizontal-scroll') {
      handlePdfDisplayModeChange('vertical-scroll');
    } else {
      // Default to vertical-scroll if not in a scroll mode
      handlePdfDisplayModeChange('vertical-scroll');
    }
  }

  function handlePdfPrint() {
    if (!isPdf) return;
    // Open print dialog for the PDF
    // This is a best-effort approach - actual printing depends on browser support
    window.print();
  }

  function handleSpeedChange(event: CustomEvent<{ speed: number }>) {
    readerSettings = {
      ...readerSettings,
      autoScroll: { ...readerSettings.autoScroll, speed: event.detail.speed }
    };
    if (isAutoScrolling) {
      startAutoScroll(); // Restart with new speed
    }
  }

  // Keyboard handling
  function handleKeydown(event: KeyboardEvent) {
    // Skip if typing in an input or textarea
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;

    // Skip if this reader's leaf is not the active leaf (prevents event leaking to other panes)
    if (view && plugin.app.workspace.activeLeaf !== view.leaf) return;

    // Skip if lightbox is open (let lightbox handle its own navigation)
    if (lightboxOpen) return;

    // Skip navigation keys if any modal/popup is open (let them handle their own events)
    const isNavigationKey = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' '].includes(event.key);
    if (isNavigationKey && (showSettings || showNotebook || showHighlightPopup || showBookInfo || showMoreMenu)) return;

    // Skip if this is a repeat event (key held down)
    if (event.repeat) return;

    console.log('[Svelte] handleKeydown:', event.key, 'target:', event.target?.constructor?.name);

    switch (event.key) {
      case 'ArrowLeft':
      case 'PageUp':
        event.preventDefault();
        console.log('[Svelte] Calling prevPage()');
        prevPage();
        break;
      case 'ArrowRight':
      case 'PageDown':
        event.preventDefault();
        console.log('[Svelte] Calling nextPage()');
        nextPage();
        break;
      case ' ':
        event.preventDefault();
        event.shiftKey ? prevPage() : nextPage();
        break;
      case 'Escape':
        showSettings = false;
        showNotebook = false;
        showHighlightPopup = false;
        break;
      case 't':
      case 'T':
        if (!event.metaKey && !event.ctrlKey) {
          openBookSidebar('toc');
        }
        break;
      case 's':
      case 'S':
        if (!event.metaKey && !event.ctrlKey) {
          showSettings = !showSettings;
        }
        break;
      case 'f':
      case 'F':
        if (!event.metaKey && !event.ctrlKey) {
          toggleFullScreen();
        }
        break;
      case 'm':
      case 'M':
        if (!event.metaKey && !event.ctrlKey && !loading) {
          toggleReadingMode();
        }
        break;
      case 'e':
      case 'E':
        // Cmd/Ctrl+E: Toggle Source/Live mode (matches Obsidian's pattern)
        if ((event.metaKey || event.ctrlKey) && !loading) {
          event.preventDefault();
          toggleSourceLiveMode();
        }
        break;
    }
  }

  // Wheel/trackpad scroll handling for PDF navigation
  // Debounce to prevent multiple page turns from single scroll gesture
  const WHEEL_DEBOUNCE_MS = 150;

  function handleWheel(event: WheelEvent) {
    // Only handle wheel events for PDFs in paginated mode
    if (!isPdf || !renderer) return;

    const pdfRenderer = renderer as PdfRenderer;
    const displayMode = pdfRenderer.getDisplayMode();

    // Only intercept wheel events for paginated mode
    // All scroll-based modes should let the infinite canvas handle wheel events natively
    if (displayMode !== 'paginated') return;

    // Paginated mode: prevent default and navigate pages
    event.preventDefault();

    // Debounce to prevent multiple rapid page turns
    if (wheelDebounceTimer) return;

    // Determine scroll direction (both deltaY for vertical scroll and deltaX for horizontal)
    const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;

    if (delta > 0) {
      nextPage();
    } else if (delta < 0) {
      prevPage();
    }

    // Set debounce timer
    wheelDebounceTimer = setTimeout(() => {
      wheelDebounceTimer = null;
    }, WHEEL_DEBOUNCE_MS);
  }

  // Pointer tracking for popup positioning (works with both mouse and touch)
  function handlePointerMove(event: MouseEvent) {
    lastPointerPosition = { x: event.clientX, y: event.clientY };
  }

  function handleTouchMove(event: TouchEvent) {
    if (event.touches.length > 0) {
      const touch = event.touches[0];
      lastPointerPosition = { x: touch.clientX, y: touch.clientY };
    }
  }

  function handlePointerUp(event: MouseEvent) {
    // Update position on mouseup for accurate popup placement
    lastPointerPosition = { x: event.clientX, y: event.clientY };
  }

  function handleTouchEnd(event: TouchEvent) {
    // Use changedTouches for touchend (touches array is empty at this point)
    if (event.changedTouches.length > 0) {
      const touch = event.changedTouches[0];
      lastPointerPosition = { x: touch.clientX, y: touch.clientY };
    }
  }

  // Execute a tap zone action
  function executeTapAction(action: TapZoneAction) {
    switch (action) {
      case 'prev-page':
        prevPage();
        break;
      case 'next-page':
        nextPage();
        break;
      case 'toggle-ui':
        showBottomNav = !showBottomNav;
        break;
      case 'bookmark':
        // TODO: Implement bookmark action
        if (readerSettings.hapticFeedback) HapticFeedback.medium();
        break;
      case 'none':
        // Do nothing
        break;
    }
  }

  // Container click handling
  function handleContainerClick(event: MouseEvent) {
    // Ignore click that immediately follows a selection (prevents closing the popup we just opened)
    if (ignoreNextContainerClick) {
      console.log('[handleContainerClick] Ignoring click after selection');
      return;
    }

    // Close any open menus/panels
    if (showSettings || showMoreMenu || showBookInfo || showNotebook || showDisplayModeDropdown) {
      showSettings = false;
      showMoreMenu = false;
      showBookInfo = false;
      showNotebook = false;
      showDisplayModeDropdown = false;
      return;
    }

    if (showHighlightPopup) {
      closePopup();
      return;
    }

    // Tap zones for paginated mode
    if (readerSettings.flow === 'paginated') {
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const width = rect.width;

      if (x < width / 3) {
        executeTapAction(readerSettings.tapZones.left);
      } else if (x > (width * 2) / 3) {
        executeTapAction(readerSettings.tapZones.right);
      } else {
        executeTapAction(readerSettings.tapZones.center);
      }
    }
  }
</script>

<svelte:window
  on:keydown={handleKeydown}
  on:mousemove={handlePointerMove}
  on:touchmove={handleTouchMove}
  on:mouseup={handlePointerUp}
  on:touchend={handleTouchEnd}
/>

<div
  class="amnesia-reader server-reader"
  bind:this={container}
  on:click={handleContainerClick}
  on:wheel={handleWheel}
>
  <!-- Renderer container - always rendered and visible so paginator can calculate dimensions -->
  <div class="renderer-container" bind:this={rendererContainer}></div>

  {#if loading}
    <div class="reader-loading-overlay">
      <div class="loading-spinner"></div>
      <p>{layoutChangeInProgress ? 'Applying changes...' : 'Loading book...'}</p>
    </div>
  {:else if error}
    <div class="reader-error">
      <div class="error-icon">⚠️</div>
      <h3>Unable to load book</h3>
      <p>{error}</p>
      {#if !plugin.settings.serverEnabled}
        <p class="error-hint">
          Enable the Amnesia server in plugin settings to use the reader.
        </p>
      {/if}
    </div>
  {:else}
    <!-- Top Bar with Controls -->
    <div class="reader-topbar" class:hidden={!showBottomNav}>
      <div class="topbar-left">
        <button class="icon-button" on:click|stopPropagation={() => openBookSidebar('toc')} title="Table of Contents (T)">
          <List size={20} />
        </button>
        {#if isPdf}
          {#if isPageInputEditing}
            <input
              bind:this={pageInputEl}
              type="text"
              class="page-input"
              value={pageInputValue}
              on:blur={handlePdfPageInputBlur}
              on:input={(e) => pageInputValue = e.currentTarget.value}
              on:keydown={handlePdfPageInputKeydown}
              on:click|stopPropagation
              inputmode="numeric"
              pattern="[0-9]*"
            />
            <span class="page-label">/ {pdfTotalPages}</span>
          {:else}
            <button class="page-count-btn" on:click|stopPropagation={handlePageCountClick} title="Click to go to page">
              Page {pdfCurrentPage} of {pdfTotalPages}
            </button>
          {/if}
        {:else}
          <span class="chapter-title">{currentChapter || bookTitle}</span>
        {/if}
      </div>
      <div class="topbar-center">
        {#if isPdf}
          <!-- PDF-specific controls: Zoom and Rotate -->
          <button class="icon-button" on:click|stopPropagation={handlePdfZoomOut} title="Zoom out (-)">
            <ZoomOut size={18} />
          </button>
          <span class="zoom-display">{Math.round(pdfCurrentZoom * 100)}%</span>
          <button class="icon-button" on:click|stopPropagation={handlePdfZoomIn} title="Zoom in (+)">
            <ZoomIn size={18} />
          </button>
          <button class="icon-button" on:click|stopPropagation={handlePdfRotateCw} title="Rotate clockwise (R)">
            <span use:setIconEl={'rotate-cw'}></span>
          </button>
          <!-- Separator between zoom/rotate and mode controls -->
          <span class="toolbar-separator"></span>
          <!-- Fit to page button -->
          <button class="icon-button" on:click|stopPropagation={handlePdfFitPage} title="Fit to page">
            <Maximize size={18} />
          </button>
          <!-- Display mode dropdown -->
          <div class="display-mode-dropdown-container">
            <button
              class="icon-button mode-toggle"
              on:click|stopPropagation={() => { showDisplayModeDropdown = !showDisplayModeDropdown; showMoreMenu = false; }}
              title="Display mode: {pdfSettings.displayMode}"
            >
              {#if pdfSettings.displayMode === 'paginated'}
                <BookOpen size={18} />
              {:else if pdfSettings.displayMode === 'horizontal-scroll'}
                <ArrowLeftRight size={18} />
              {:else if pdfSettings.displayMode === 'vertical-scroll'}
                <ArrowDownUp size={18} />
              {:else if pdfSettings.displayMode === 'auto-grid'}
                <LayoutGrid size={18} />
              {:else if pdfSettings.displayMode === 'canvas'}
                <Move size={18} />
              {:else}
                <LayoutGrid size={18} />
              {/if}
              <ChevronDown size={12} class="dropdown-chevron" />
            </button>
            {#if showDisplayModeDropdown}
              <div class="display-mode-dropdown" on:click|stopPropagation>
                <button
                  class="dropdown-item"
                  class:active={pdfSettings.displayMode === 'paginated'}
                  on:click={() => { handlePdfDisplayModeChange('paginated'); showDisplayModeDropdown = false; }}
                >
                  <BookOpen size={16} />
                  <span>Paginated</span>
                </button>
                <button
                  class="dropdown-item"
                  class:active={pdfSettings.displayMode === 'vertical-scroll'}
                  on:click={() => { handlePdfDisplayModeChange('vertical-scroll'); showDisplayModeDropdown = false; }}
                >
                  <ArrowDownUp size={16} />
                  <span>Vertical Scroll</span>
                </button>
                <button
                  class="dropdown-item"
                  class:active={pdfSettings.displayMode === 'horizontal-scroll'}
                  on:click={() => { handlePdfDisplayModeChange('horizontal-scroll'); showDisplayModeDropdown = false; }}
                >
                  <ArrowLeftRight size={16} />
                  <span>Horizontal Scroll</span>
                </button>
                <button
                  class="dropdown-item"
                  class:active={pdfSettings.displayMode === 'auto-grid'}
                  on:click={() => { handlePdfDisplayModeChange('auto-grid'); showDisplayModeDropdown = false; }}
                >
                  <LayoutGrid size={16} />
                  <span>Auto Grid</span>
                </button>
                <button
                  class="dropdown-item"
                  class:active={pdfSettings.displayMode === 'canvas'}
                  on:click={() => { handlePdfDisplayModeChange('canvas'); showDisplayModeDropdown = false; }}
                >
                  <Move size={16} />
                  <span>Free Canvas</span>
                </button>
              </div>
            {/if}
          </div>
        {:else}
          <!-- EPUB-specific controls: Font size and Mode toggle -->
          <button class="icon-button font-btn" on:click|stopPropagation={() => { readerSettings = {...readerSettings, fontSize: Math.max(10, readerSettings.fontSize - 2)}; renderer?.updateConfig({ fontSize: readerSettings.fontSize }); debouncedSaveSettings(); }} title="Decrease font size">
            A-
          </button>
          <span class="font-size-display">{readerSettings.fontSize}</span>
          <button class="icon-button font-btn" on:click|stopPropagation={() => { readerSettings = {...readerSettings, fontSize: Math.min(40, readerSettings.fontSize + 2)}; renderer?.updateConfig({ fontSize: readerSettings.fontSize }); debouncedSaveSettings(); }} title="Increase font size">
            A+
          </button>
          <!-- Mode toggle -->
          <button
            class="icon-button mode-toggle"
            on:click|stopPropagation={toggleReadingMode}
            title={readerSettings.flow === 'paginated' ? 'Switch to Scrolled mode (M)' : 'Switch to Paginated mode (M)'}
            disabled={loading}
          >
            {#if readerSettings.flow === 'paginated'}
              <Columns size={18} />
            {:else}
              <AlignJustify size={18} />
            {/if}
          </button>
        {/if}
      </div>
      <div class="topbar-right">
        <button class="icon-button" on:click|stopPropagation={toggleBookmark} title="Bookmark" class:active={hasBookmarkAtCurrentPosition}>
          {#if hasBookmarkAtCurrentPosition}
            <BookmarkCheck size={20} />
          {:else}
            <BookmarkIcon size={20} />
          {/if}
        </button>
        <button class="icon-button" on:click|stopPropagation={() => openBookSidebar('highlights')} title="Notebook">
          <Highlighter size={20} />
        </button>
        <button class="icon-button" on:click|stopPropagation={() => { showSettings = !showSettings; showMoreMenu = false; showNotebook = false; }} title="Settings (S)">
          <Settings size={20} />
        </button>
        <button class="icon-button" on:click|stopPropagation={() => { showMoreMenu = !showMoreMenu; showSettings = false; showNotebook = false; }} title="More options">
          <MoreVertical size={20} />
        </button>
      </div>
    </div>

    <!-- More menu dropdown -->
    {#if showMoreMenu}
      <div class="more-menu" on:click|stopPropagation>
        <button class="menu-item" on:click={() => openBookSidebar('highlights')}>
          <Highlighter size={18} />
          <span>Highlights</span>
          {#if bookHighlights.length > 0}
            <span class="menu-badge">{bookHighlights.length}</span>
          {/if}
        </button>
        <button class="menu-item" on:click={() => openBookSidebar('bookmarks')}>
          <BookmarkIcon size={18} />
          <span>Bookmarks</span>
          {#if bookBookmarks.length > 0}
            <span class="menu-badge">{bookBookmarks.length}</span>
          {/if}
        </button>
        <button class="menu-item" on:click={() => openBookSidebar('notes')}>
          <StickyNote size={18} />
          <span>Notes</span>
          {#if bookNotes.length > 0}
            <span class="menu-badge">{bookNotes.length}</span>
          {/if}
        </button>
        <button class="menu-item" on:click={() => openBookSidebar('images')}>
          <Image size={18} />
          <span>Images</span>
        </button>
        <div class="menu-divider"></div>
        {#if isCalibreBook && calibreBook}
          <button class="menu-item" on:click={openInCalibre}>
            <ExternalLink size={18} />
            <span>Open in Calibre</span>
          </button>
        {/if}
        <button class="menu-item" on:click={toggleBookInfo}>
          <Info size={18} />
          <span>Book Info</span>
        </button>
        <div class="menu-divider"></div>
        <button class="menu-item" on:click|stopPropagation={toggleFullScreen}>
          {#if isFullScreen}
            <Minimize2 size={18} />
            <span>Exit Fullscreen</span>
          {:else}
            <Maximize2 size={18} />
            <span>Fullscreen (F)</span>
          {/if}
        </button>
      </div>
    {/if}

    <!-- Full-width Progress Bar at Bottom -->
    <div class="reader-progress-bar" class:hidden={!showBottomNav}>
      <div class="progress-nav">
        <button class="nav-btn" on:click|stopPropagation={prevPage} aria-label="Previous page">
          <ChevronLeft size={20} />
        </button>
        <div class="progress-track-wrapper" on:click|stopPropagation={handleProgressClick}>
          <div class="progress-track">
            <div class="progress-fill" style="width: {progress}%"></div>
          </div>
          <span class="progress-info">
            {#if totalPages > 0}
              Page {currentPage + 1} of {totalPages} · {Math.round(progress)}%
            {:else}
              {Math.round(progress)}%
            {/if}
          </span>
        </div>
        <button class="nav-btn" on:click|stopPropagation={nextPage} aria-label="Next page">
          <ChevronRight size={20} />
        </button>
      </div>
    </div>

    <!-- Sidebar click-away overlay -->
    {#if showSettings || showBookInfo || showNotebook}
      <div
        class="sidebar-overlay"
        on:click={() => { showSettings = false; showBookInfo = false; showNotebook = false; }}
        on:keydown={(e) => e.key === 'Escape' && (showSettings = false, showBookInfo = false, showNotebook = false)}
        role="button"
        tabindex="-1"
        aria-label="Close sidebar"
      />
    {/if}

    <!-- Settings Panel (conditional: PDF vs EPUB) -->
    {#if showSettings}
      <div class="sidebar settings-sidebar" on:click|stopPropagation>
        {#if isPdf}
          <PdfSettingsPanel
            settings={pdfSettings}
            visible={true}
            currentPage={pdfCurrentPage}
            totalPages={pdfTotalPages}
            on:change={handlePdfSettingsChange}
            on:zoomIn={handlePdfZoomIn}
            on:zoomOut={handlePdfZoomOut}
            on:fitWidth={handlePdfFitWidth}
            on:fitPage={handlePdfFitPage}
            on:rotateCw={handlePdfRotateCw}
            on:rotateCcw={handlePdfRotateCcw}
            on:print={handlePdfPrint}
            on:close={() => showSettings = false}
          />
        {:else}
          <SettingsPanel
            settings={readerSettings}
            visible={true}
            {isFullScreen}
            on:change={handleSettingsChange}
            on:close={() => showSettings = false}
            on:fullscreenToggle={toggleFullScreen}
          />
        {/if}
      </div>
    {/if}

    <!-- Book Info Panel -->
    {#if showBookInfo && book}
      <div class="sidebar info-sidebar" on:click|stopPropagation>
        <div class="sidebar-header">
          <h3>Book Info</h3>
          <button class="icon-button" on:click={() => showBookInfo = false}>
            <X size={20} />
          </button>
        </div>
        <div class="book-info-content">
          {#if book.metadata.coverHref}
            <div class="book-cover">
              <img src="{plugin.settings.serverUrl}/api/v1/books/{bookId}/resources/{encodeURIComponent(book.metadata.coverHref)}" alt="Cover" />
            </div>
          {/if}
          <div class="book-meta">
            <h2 class="book-title">{book.metadata.title}</h2>
            {#if book.metadata.creators && book.metadata.creators.length > 0}
              <p class="book-author">{book.metadata.creators.map(c => c.name).join(', ')}</p>
            {/if}
            {#if book.metadata.publisher}
              <p class="book-field"><strong>Publisher:</strong> {book.metadata.publisher}</p>
            {/if}
            {#if book.metadata.language}
              <p class="book-field"><strong>Language:</strong> {book.metadata.language}</p>
            {/if}
            {#if book.metadata.identifier}
              <p class="book-field"><strong>Identifier:</strong> {book.metadata.identifier}</p>
            {/if}
            {#if book.metadata.description}
              <div class="book-description">
                <strong>Description:</strong>
                <p>{@html book.metadata.description}</p>
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <!-- Notebook Sidebar -->
    {#if showNotebook}
      <div class="sidebar notebook-sidebar-container" on:click|stopPropagation>
        <NotebookSidebar
          highlights={bookHighlights}
          bookmarks={bookBookmarks}
          notes={bookNotes}
          {bookPath}
          {bookTitle}
          initialTab={notebookTab}
          on:close={() => showNotebook = false}
          on:navigateTo={handleNotebookNavigate}
          on:deleteHighlight={handleDeleteHighlightFromSidebar}
          on:deleteBookmark={handleDeleteBookmarkFromSidebar}
          on:deleteNote={handleDeleteNoteFromSidebar}
          on:openImages={openImagesGallery}
        />
      </div>
    {/if}

  {/if}
</div>

<!-- Highlight Popup rendered via Portal to document.body to escape all stacking contexts -->
{#if showHighlightPopup && (pendingSelection || selectedExistingHighlight)}
  <Portal>
    <!-- Click-away overlay: clicking outside popup closes it -->
    <div
      style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 999998; background: transparent; pointer-events: auto;"
      on:click={closePopup}
      on:keydown={(e) => e.key === 'Escape' && closePopup()}
      role="button"
      tabindex="-1"
      aria-label="Close popup"
    />
    <HighlightPopup
      mode={highlightPopupMode}
      selection={pendingSelection}
      existingHighlight={selectedExistingHighlight}
      position={highlightPopupPosition}
      existingTags={getAllTags()}
      {docDoctorConnected}
      on:highlight={handleCreateHighlight}
      on:updateHighlight={handleUpdateHighlight}
      on:deleteHighlight={handleDeleteHighlight}
      on:bookmark={handleBookmarkFromPopup}
      on:copyText={handleCopyText}
      on:copyLink={handleCopyLink}
      on:createKnowledgeGap={handleCreateKnowledgeGap}
      on:close={closePopup}
    />
  </Portal>
{/if}

<!-- Image Lightbox for content images -->
{#if lightboxOpen && lightboxImages.length > 0}
  <ImageLightbox
    images={lightboxImages}
    startIndex={lightboxStartIndex}
    open={lightboxOpen}
    on:close={closeLightbox}
  />
{/if}

<style>
  /* Hide Obsidian's view header - our topbar replaces it */
  :global(.workspace-leaf-content:has(.amnesia-reader-view) > .view-header) {
    display: none !important;
  }

  /* Make view-content fill the entire leaf without gaps */
  :global(.workspace-leaf-content:has(.amnesia-reader-view)) {
    padding: 0 !important;
  }

  :global(.workspace-leaf-content:has(.amnesia-reader-view) > .view-content) {
    height: 100% !important;
    padding: 0 !important;
    position: relative !important;
  }

  .amnesia-reader.server-reader {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--background-primary);
    overflow: hidden;
  }

  .reader-loading-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    color: var(--text-muted);
    background: var(--background-primary);
    z-index: 50;
  }

  .reader-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 1rem;
    color: var(--text-muted);
  }

  .reader-error {
    text-align: center;
    padding: 2rem;
  }

  .error-icon {
    font-size: 3rem;
  }

  .error-hint {
    font-size: 0.875rem;
    color: var(--text-faint);
    margin-top: 1rem;
  }

  .loading-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--background-modifier-border);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Top Bar - Obsidian-style with glass transparency */
  .reader-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 12px;
    background: linear-gradient(
      to bottom,
      rgba(0, 0, 0, 0.7) 0%,
      rgba(0, 0, 0, 0.5) 100%
    );
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    transition: opacity 0.2s, transform 0.2s;
    z-index: 10;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 36px;
  }

  .reader-topbar.hidden {
    opacity: 0;
    pointer-events: none;
  }

  .topbar-left {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }

  .topbar-center {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 8px;
  }

  .font-btn {
    font-weight: 600;
    font-size: 0.7rem;
    min-width: 26px;
  }

  .mode-toggle {
    margin-left: 4px;
    padding: 4px 6px;
    border-radius: 4px;
    transition: background-color 0.15s, opacity 0.15s;
  }

  .mode-toggle:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .mode-toggle:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
  }

  .font-size-display,
  .zoom-display {
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.5);
    min-width: 32px;
    text-align: center;
  }

  /* Page count text (default state - clickable but looks like text) */
  .page-count-btn {
    background: none !important;
    border: none !important;
    box-shadow: none !important;
    outline: none !important;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.75rem;
    padding: 0;
    margin: 0;
    cursor: text;
    white-space: nowrap;
  }

  .page-count-btn:hover {
    color: rgba(255, 255, 255, 0.85);
  }

  /* Page input for PDF navigation (edit mode) */
  .page-label {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.75rem;
    white-space: nowrap;
  }

  .page-input {
    width: 28px;
    padding: 0;
    margin: 0;
    border: none !important;
    box-shadow: none !important;
    outline: none !important;
    background: transparent !important;
    color: rgba(255, 255, 255, 0.9);
    font-size: 0.75rem;
    text-align: center;
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .chapter-title {
    font-size: 0.8rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 180px;
    opacity: 0.85;
  }

  /* Full-width Progress Bar - Obsidian-style with glass transparency */
  .reader-progress-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 8px 16px;
    background: linear-gradient(
      to top,
      rgba(0, 0, 0, 0.7) 0%,
      rgba(0, 0, 0, 0.5) 100%
    );
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    transition: opacity 0.2s, transform 0.2s;
    z-index: 10;
  }

  .reader-progress-bar.hidden {
    opacity: 0;
    pointer-events: none;
  }

  .progress-nav {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .nav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
    outline: none !important;
    padding: 6px;
    border-radius: 4px;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.85);
    transition: color 0.15s, background-color 0.15s;
    flex-shrink: 0;
  }

  .nav-btn:hover {
    background: rgba(255, 255, 255, 0.12) !important;
    color: #fff;
  }

  .nav-btn:focus {
    outline: none !important;
    box-shadow: none !important;
  }

  .progress-track-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
  }

  .progress-track {
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--interactive-accent);
    border-radius: 2px;
    transition: width 0.2s ease;
  }

  .progress-info {
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.5);
    text-align: center;
  }

  /* More menu dropdown - glass transparency */
  .more-menu {
    position: absolute;
    top: 40px;
    right: 12px;
    background: linear-gradient(
      135deg,
      rgba(20, 20, 20, 0.95) 0%,
      rgba(12, 12, 12, 0.92) 100%
    );
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    z-index: 200;
    min-width: 170px;
    padding: 4px 0;
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.8rem;
    text-align: left;
    transition: background 0.1s, color 0.1s;
  }

  .menu-item:hover {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.95);
  }

  .menu-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.08);
    margin: 4px 0;
  }

  .menu-badge {
    margin-left: auto;
    font-size: 0.65rem;
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.6);
    padding: 2px 6px;
    border-radius: 10px;
  }

  .icon-button {
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
    outline: none !important;
    padding: 6px;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.85);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.15s, background-color 0.15s;
  }

  .icon-button:hover {
    background: rgba(255, 255, 255, 0.12) !important;
    color: #fff;
  }

  .icon-button:focus {
    outline: none !important;
    box-shadow: none !important;
  }

  .icon-button.active {
    background: var(--interactive-accent) !important;
    color: var(--text-on-accent);
  }

  .toolbar-separator {
    width: 1px;
    height: 16px;
    background: rgba(255, 255, 255, 0.12);
    margin: 0 6px;
  }

  /* Display mode dropdown */
  .display-mode-dropdown-container {
    position: relative;
  }

  .display-mode-dropdown-container .mode-toggle {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .display-mode-dropdown-container :global(.dropdown-chevron) {
    opacity: 0.6;
    margin-left: 2px;
  }

  .display-mode-dropdown {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 4px;
    min-width: 150px;
    background: linear-gradient(
      135deg,
      rgba(20, 20, 20, 0.95) 0%,
      rgba(12, 12, 12, 0.92) 100%
    );
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    padding: 4px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    z-index: 200;
    animation: fadeIn 0.15s ease-out;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s, color 0.1s;
  }

  .dropdown-item:hover {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.95);
  }

  .dropdown-item.active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }

  .renderer-container {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .sidebar {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 280px;
    background: var(--background-secondary);
    border-right: 1px solid var(--background-modifier-border);
    z-index: 100;
    display: flex;
    flex-direction: column;
    animation: slideIn 0.2s ease-out;
  }

  .toc-sidebar {
    left: 0;
  }

  .settings-sidebar,
  .info-sidebar,
  .notebook-sidebar-container {
    right: 0;
    border-right: none;
    border-left: 1px solid var(--background-modifier-border);
  }

  .notebook-sidebar-container {
    width: 350px;
    max-width: 90vw;
  }

  @keyframes slideIn {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(0);
    }
  }

  .settings-sidebar,
  .info-sidebar,
  .notebook-sidebar-container {
    animation-name: slideInRight;
  }

  @keyframes slideInRight {
    from {
      transform: translateX(100%);
    }
    to {
      transform: translateX(0);
    }
  }

  /* Book info panel */
  .book-info-content {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
  }

  .book-cover {
    text-align: center;
    margin-bottom: 1rem;
  }

  .book-cover img {
    max-width: 100%;
    max-height: 200px;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }

  .book-meta {
    font-size: 0.875rem;
  }

  .book-title {
    font-size: 1.1rem;
    margin: 0 0 0.5rem 0;
    line-height: 1.3;
  }

  .book-author {
    color: var(--text-muted);
    margin: 0 0 1rem 0;
  }

  .book-field {
    margin: 0.5rem 0;
    color: var(--text-normal);
  }

  .book-field strong {
    color: var(--text-muted);
  }

  .book-description {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--background-modifier-border);
  }

  .book-description p {
    margin: 0.5rem 0 0 0;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .sidebar-header h3 {
    margin: 0;
    font-size: 1rem;
  }

  .toc-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
  }

  .toc-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.75rem 1rem;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-normal);
    font-size: 0.875rem;
  }

  .toc-item:hover {
    background: var(--background-modifier-hover);
  }

  /* Highlight popup click-away overlay - must escape all stacking contexts */
  .amnesia-popup-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 999998; /* Just below popup z-index of 999999 */
    background: transparent;
    cursor: default;
    pointer-events: auto;
  }

  /* Sidebar click-away overlay */
  .sidebar-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 99;
    background: rgba(0, 0, 0, 0.3);
    cursor: default;
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>

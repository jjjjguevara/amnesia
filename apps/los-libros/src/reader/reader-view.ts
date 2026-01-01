import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import type LosLibrosPlugin from '../main';
import ReaderComponent from './components/ServerReaderContainer.svelte';

export const READER_VIEW_TYPE = 'los-libros-reader';

interface ReaderViewState extends Record<string, unknown> {
  bookPath?: string;
  bookTitle?: string;
  file?: string; // Obsidian passes this when opening via registerExtensions
}

export class ReaderView extends ItemView {
  plugin: LosLibrosPlugin;
  component: ReaderComponent | null = null;
  bookPath: string = '';
  bookTitle: string = '';

  constructor(leaf: WorkspaceLeaf, plugin: LosLibrosPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return READER_VIEW_TYPE;
  }

  getDisplayText(): string {
    // Show book title if available, otherwise filename without extension
    if (this.bookTitle) {
      return this.bookTitle;
    }
    if (this.bookPath && typeof this.bookPath === 'string') {
      const filename = this.bookPath.split('/').pop() ?? 'Reader';
      // Remove .epub or .pdf extension
      return filename.replace(/\.(epub|pdf)$/i, '');
    }
    return 'Reader';
  }

  getIcon(): string {
    return 'book-open';
  }

  /**
   * Check if this view can handle the given file extension
   */
  canAcceptExtension(extension: string): boolean {
    return extension === 'epub' || extension === 'pdf';
  }

  /**
   * Called by Obsidian when opening a file with this view type
   */
  async onLoadFile(file: TFile): Promise<void> {
    this.bookPath = file.path;
    this.bookTitle = await this.resolveBookTitle();
    await this.renderReader();
    this.updateViewHeader();
  }

  async setState(state: ReaderViewState, result: { history: boolean }): Promise<void> {
    console.log('[ReaderView] setState called with:', JSON.stringify(state));
    // Handle both bookPath (our state) and file (Obsidian's state when opening via registerExtensions)
    this.bookPath = state.bookPath || state.file || '';
    console.log('[ReaderView] bookPath set to:', this.bookPath);
    this.bookTitle = state.bookTitle || '';

    // Try to get book title from library if not provided
    if (!this.bookTitle && this.bookPath) {
      this.bookTitle = await this.resolveBookTitle();
    }

    await this.renderReader();
    await super.setState(state, result);

    // Update the leaf title (trigger re-render of tab header)
    this.app.workspace.requestSaveLayout();

    // Force update the view header DOM element
    this.updateViewHeader();
  }

  getState(): ReaderViewState {
    return { bookPath: this.bookPath, bookTitle: this.bookTitle };
  }

  /**
   * Force update the view header title in the DOM
   * Obsidian caches the header and doesn't re-query getDisplayText() automatically
   */
  private updateViewHeader(): void {
    const title = this.getDisplayText();

    // Update the view header title element directly
    const headerTitleEl = this.containerEl.parentElement?.querySelector('.view-header-title');
    if (headerTitleEl) {
      headerTitleEl.textContent = title;
    }

    // Also update tab header if accessible (using any cast as tabHeaderEl is not in public API)
    const leaf = this.leaf as any;
    if (leaf?.tabHeaderEl) {
      const tabTitleEl = leaf.tabHeaderEl.querySelector('.workspace-tab-header-inner-title');
      if (tabTitleEl) {
        tabTitleEl.textContent = title;
      }
    }
  }

  /**
   * Resolve book title from library stores
   */
  private async resolveBookTitle(): Promise<string> {
    // Check Calibre books first
    const calibreState = this.plugin.calibreService?.getStore().getValue();
    const calibreBook = calibreState?.books.find(b => b.epubPath === this.bookPath);
    if (calibreBook) {
      return calibreBook.title;
    }

    // Check vault books
    const vaultBooks = this.plugin.libraryStore.getValue().books;
    const vaultBook = vaultBooks.find(b => b.localPath === this.bookPath);
    if (vaultBook) {
      return vaultBook.title;
    }

    return '';
  }

  async onOpen(): Promise<void> {
    console.log('[ReaderView] onOpen called, bookPath:', this.bookPath);
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('los-libros-reader-view');

    // setState will be called by Obsidian with the file path
    // Just render if we already have a bookPath (e.g. from restored state)
    if (this.bookPath) {
      console.log('[ReaderView] onOpen: Rendering with existing bookPath');
      await this.renderReader();
    } else {
      console.log('[ReaderView] onOpen: No bookPath yet, waiting for setState');
    }

    // Register for active leaf change to handle visibility
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf === this.leaf && this.component) {
          // Trigger a resize event to fix display issues when tab becomes active
          this.component.$set({ _activeLeafTrigger: Date.now() });
        }
      })
    );
  }

  async renderReader(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();

    if (this.component) {
      this.component.$destroy();
    }

    this.component = new ReaderComponent({
      target: container,
      props: {
        plugin: this.plugin,
        bookPath: this.bookPath,
        bookTitle: this.bookTitle
      }
    });

    // Listen for title resolution from the component
    this.component.$on('titleResolved', (event: CustomEvent<{ title: string }>) => {
      if (event.detail.title && event.detail.title !== this.bookTitle) {
        this.bookTitle = event.detail.title;
        // Trigger layout save to update tab header
        this.app.workspace.requestSaveLayout();
        // Force update the view header DOM element
        this.updateViewHeader();
      }
    });
  }

  async onClose(): Promise<void> {
    if (this.component) {
      this.component.$destroy();
      this.component = null;
    }
  }

  /**
   * Navigate to a CFI location in the book
   * Called by the global sidebar to navigate to highlights/bookmarks
   */
  navigateToCfi(cfi: string): void {
    if (this.component) {
      (this.component as any).navigateToCfi(cfi);
    }
  }

  /**
   * Remove a highlight from the overlay
   * Called by the global sidebar when deleting a highlight
   */
  removeHighlight(highlightId: string): void {
    if (this.component) {
      (this.component as any).removeHighlightFromOverlay(highlightId);
    }
  }

  /**
   * Navigate to a highlight using CFI and text for precise location
   * Called by the global sidebar for accurate highlight navigation
   */
  navigateToHighlight(cfi: string, text: string): void {
    if (this.component) {
      (this.component as any).navigateToHighlight(cfi, text);
    }
  }

  /**
   * Navigate to an href (internal link or ToC entry)
   * Called by the sidebar for ToC navigation
   */
  navigateToHref(href: string): void {
    if (this.component) {
      (this.component as any).navigateToHref(href);
    }
  }

  /**
   * Navigate to a specific chapter by spine index
   * Called by the sidebar for image navigation
   */
  navigateToChapter(spineIndex: number): void {
    if (this.component) {
      (this.component as any).navigateToChapter(spineIndex);
    }
  }

  /**
   * Navigate to a chapter and then find specific text
   * Called by the sidebar for search result navigation
   */
  navigateToChapterAndText(spineIndex: number, text: string): void {
    if (this.component) {
      (this.component as any).navigateToChapterAndText(spineIndex, text);
    }
  }

  /**
   * Set book title and update display
   */
  setBookTitle(title: string): void {
    this.bookTitle = title;
    // Trigger layout save to update tab header
    this.app.workspace.requestSaveLayout();
    // Force update the view header DOM element
    this.updateViewHeader();
  }

  /**
   * Set book path and render the reader
   * Called when opening an EPUB file via registerExtensions
   */
  async setBookPath(path: string): Promise<void> {
    if (this.bookPath) return; // Already set

    this.bookPath = path;
    this.bookTitle = await this.resolveBookTitle();
    await this.renderReader();
    this.updateViewHeader();
    // Trigger layout save to persist the state
    this.app.workspace.requestSaveLayout();
  }
}

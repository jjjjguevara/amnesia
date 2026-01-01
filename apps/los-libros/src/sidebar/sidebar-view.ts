/**
 * Book Sidebar View
 *
 * Obsidian ItemView for the book sidebar.
 * Based on Doc Doctor sidebar pattern.
 */
import { ItemView, WorkspaceLeaf } from 'obsidian';
import type LosLibrosPlugin from '../main';
import Sidebar from './components/Sidebar.svelte';
import type { TocEntry } from '../reader/renderer/types';

export const BOOK_SIDEBAR_VIEW_TYPE = 'los-libros-book-sidebar';

export class BookSidebarView extends ItemView {
  component: Sidebar | undefined;
  icon = 'book-open';

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: LosLibrosPlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return BOOK_SIDEBAR_VIEW_TYPE;
  }

  getDisplayText() {
    return 'Book Notebook';
  }

  async onOpen() {
    this.contentEl.addClass('los-libros-book-sidebar');
    this.component = new Sidebar({
      target: this.contentEl,
      props: {
        plugin: this.plugin,
      },
    });
  }

  async onClose() {
    this.component?.$destroy();
  }

  /**
   * Update the sidebar with the book's Table of Contents.
   */
  setToc(entries: TocEntry[]): void {
    if (this.component && typeof (this.component as any).setToc === 'function') {
      (this.component as any).setToc(entries);
    }
  }

  /**
   * Update the current chapter indicator.
   */
  setCurrentChapter(chapter: string | null): void {
    if (this.component && typeof (this.component as any).setCurrentChapter === 'function') {
      (this.component as any).setCurrentChapter(chapter);
    }
  }

  /**
   * Update the search index state for the UI.
   */
  updateSearchIndexState(ready: boolean, progress: number, total: number): void {
    if (this.component && typeof (this.component as any).updateSearchIndexState === 'function') {
      (this.component as any).updateSearchIndexState(ready, progress, total);
    }
  }
}

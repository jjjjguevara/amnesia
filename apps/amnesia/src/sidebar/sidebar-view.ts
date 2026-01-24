/**
 * Book Sidebar View
 *
 * Obsidian ItemView for the book sidebar.
 * Based on Doc Doctor sidebar pattern.
 */
import { ItemView, WorkspaceLeaf } from 'obsidian';
import type AmnesiaPlugin from '../main';
import Sidebar from './components/Sidebar.svelte';
import type { TocEntry } from '../reader/renderer/types';
import type { Locator } from '../reader/navigator/navigator-interface';

export const BOOK_SIDEBAR_VIEW_TYPE = 'amnesia-book-sidebar';

export class BookSidebarView extends ItemView {
  component: Sidebar | undefined;
  icon = 'book-open';

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: AmnesiaPlugin,
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
    this.contentEl.addClass('amnesia-book-sidebar');
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
  setToc(entries: TocEntry[], spine?: any[], initialExpandedState?: string[]): void {
    if (this.component && typeof (this.component as any).setToc === 'function') {
      (this.component as any).setToc(entries, spine, initialExpandedState);
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

  /**
   * Update the current reading location for progress tracking.
   */
  updateLocation(locator: Locator): void {
    if (this.component && typeof (this.component as any).updateLocation === 'function') {
      (this.component as any).updateLocation(locator);
    }
  }
}

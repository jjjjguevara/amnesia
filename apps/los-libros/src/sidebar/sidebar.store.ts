/**
 * Sidebar Store
 *
 * State management for the book sidebar view.
 * Tracks active tab, current book, and search state.
 */
import { writable, derived, get } from 'svelte/store';

export type SidebarTab = 'highlights' | 'bookmarks' | 'notes' | 'images' | 'toc' | 'search';

interface SidebarState {
  activeTab: SidebarTab;
  activeBookId: string | null;
  activeBookPath: string | null;
  activeBookTitle: string | null;
  searchQuery: string;
  showSearch: boolean;
}

const initialState: SidebarState = {
  activeTab: 'highlights',
  activeBookId: null,
  activeBookPath: null,
  activeBookTitle: null,
  searchQuery: '',
  showSearch: false,
};

function createSidebarStore() {
  const { subscribe, update, set } = writable<SidebarState>(initialState);

  return {
    subscribe,

    setTab: (tab: SidebarTab) => update(s => ({ ...s, activeTab: tab })),

    setActiveBook: (bookId: string | null, bookPath?: string | null, bookTitle?: string | null) =>
      update(s => ({
        ...s,
        activeBookId: bookId,
        activeBookPath: bookPath ?? null,
        activeBookTitle: bookTitle ?? null,
      })),

    setSearchQuery: (query: string) => update(s => ({ ...s, searchQuery: query })),

    toggleSearch: () => update(s => ({ ...s, showSearch: !s.showSearch })),

    clearSearch: () => update(s => ({ ...s, searchQuery: '', showSearch: false })),

    reset: () => set(initialState),

    getValue: () => get({ subscribe }),
  };
}

export const sidebarStore = createSidebarStore();

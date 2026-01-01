/**
 * Per-Book Settings Store
 *
 * Stores and retrieves reader settings on a per-book basis.
 * Settings are saved in the plugin's data.json file.
 */

import type { ReaderSettings } from './reader-settings';
import { DEFAULT_READER_SETTINGS } from './reader-settings';

/**
 * Subset of reader settings that are stored per-book
 */
export interface PerBookSettings {
  // EPUB settings
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  theme: string;
  flow: 'paginated' | 'scrolled';
  spreads: boolean;
  columns: string;
  textAlign: string;
  margins: number; // Simplified - UI uses single margin value
  brightness: number;
  pageAnimation?: 'none' | 'slide' | 'curl';

  // PDF-specific settings
  pdfScale?: number; // Zoom level (1.0 = 100%)
  pdfRotation?: 0 | 90 | 180 | 270;
  pdfPageLayout?: 'single' | 'dual' | 'book-spread';
  pdfRegionSelectionEnabled?: boolean; // For scanned PDFs
}

/**
 * Full book settings record
 */
export interface BookSettingsRecord {
  bookId: string;
  lastModified: string;
  settings: PerBookSettings;
}

/**
 * Storage format for all book settings
 */
export interface BookSettingsStorage {
  version: number;
  books: Record<string, BookSettingsRecord>;
}

const STORAGE_KEY = 'perBookSettings';

/**
 * Extract per-book settings from full reader settings
 */
export function extractPerBookSettings(settings: ReaderSettings): PerBookSettings {
  // Handle margins - could be object or number depending on how settings were set
  const marginsValue = typeof settings.margins === 'number'
    ? settings.margins
    : (settings.margins as any)?.top ?? 40;

  return {
    // EPUB settings
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    lineHeight: settings.lineHeight,
    theme: settings.theme,
    flow: settings.flow,
    spreads: settings.spreads,
    columns: settings.columns,
    textAlign: settings.textAlign,
    margins: marginsValue,
    brightness: settings.brightness,
    pageAnimation: settings.pageAnimation,
    // PDF settings (with defaults)
    pdfScale: (settings as any).pdfScale ?? 1.5,
    pdfRotation: (settings as any).pdfRotation ?? 0,
    pdfPageLayout: (settings as any).pdfPageLayout ?? 'single',
    pdfRegionSelectionEnabled: (settings as any).pdfRegionSelectionEnabled ?? false,
  };
}

/**
 * Merge per-book settings into full reader settings
 */
export function mergePerBookSettings(
  base: ReaderSettings,
  perBook: Partial<PerBookSettings>
): ReaderSettings {
  // Convert perBook.margins (number) back to margins object format
  let margins = base.margins;
  if (perBook.margins !== undefined) {
    const m = perBook.margins;
    margins = { top: m, bottom: m, left: m, right: m };
  }

  return {
    ...base,
    ...perBook,
    margins,
  } as ReaderSettings;
}

/**
 * Book Settings Store class
 */
export class BookSettingsStore {
  private storage: BookSettingsStorage;
  private saveCallback: (data: BookSettingsStorage) => Promise<void>;

  constructor(
    initialData: BookSettingsStorage | Record<string, BookSettingsRecord> | null,
    saveCallback: (data: BookSettingsStorage) => Promise<void>
  ) {
    // Handle both new format { version, books } and legacy format { bookId: record }
    if (initialData && 'version' in initialData && 'books' in initialData) {
      // New format
      const data = initialData as BookSettingsStorage;
      this.storage = {
        version: data.version ?? 1,
        books: data.books ?? {},
      };
    } else if (initialData && typeof initialData === 'object') {
      // Legacy format - convert flat object to new format
      const books: Record<string, BookSettingsRecord> = {};
      for (const [key, value] of Object.entries(initialData)) {
        if (value && typeof value === 'object' && 'settings' in value) {
          books[key] = value as BookSettingsRecord;
        }
      }
      this.storage = { version: 1, books };
    } else {
      this.storage = { version: 1, books: {} };
    }
    this.saveCallback = saveCallback;
  }

  /**
   * Get settings for a specific book
   */
  getBookSettings(bookId: string): PerBookSettings | null {
    if (!this.storage?.books) return null;
    const record = this.storage.books[bookId];
    return record?.settings || null;
  }

  /**
   * Get full reader settings for a book, merged with defaults
   */
  getReaderSettings(bookId: string, defaults: ReaderSettings): ReaderSettings {
    const perBook = this.getBookSettings(bookId);
    if (!perBook) {
      return defaults;
    }
    return mergePerBookSettings(defaults, perBook);
  }

  /**
   * Save settings for a specific book
   */
  async saveBookSettings(bookId: string, settings: PerBookSettings): Promise<void> {
    this.storage.books[bookId] = {
      bookId,
      lastModified: new Date().toISOString(),
      settings,
    };
    await this.saveCallback(this.storage);
  }

  /**
   * Update specific settings for a book
   */
  async updateBookSettings(
    bookId: string,
    updates: Partial<PerBookSettings>
  ): Promise<void> {
    const existing = this.getBookSettings(bookId);
    const newSettings = existing
      ? { ...existing, ...updates }
      : { ...extractPerBookSettings(DEFAULT_READER_SETTINGS), ...updates };
    await this.saveBookSettings(bookId, newSettings);
  }

  /**
   * Delete settings for a specific book
   */
  async deleteBookSettings(bookId: string): Promise<void> {
    delete this.storage.books[bookId];
    await this.saveCallback(this.storage);
  }

  /**
   * Check if a book has custom settings
   */
  hasBookSettings(bookId: string): boolean {
    return bookId in this.storage.books;
  }

  /**
   * Get all book IDs with custom settings
   */
  getAllBookIds(): string[] {
    return Object.keys(this.storage.books);
  }

  /**
   * Clear all book settings
   */
  async clearAll(): Promise<void> {
    this.storage.books = {};
    await this.saveCallback(this.storage);
  }

  /**
   * Get raw storage data
   */
  getStorageData(): BookSettingsStorage {
    return this.storage;
  }
}

/**
 * Create a book settings store
 */
export function createBookSettingsStore(
  initialData: BookSettingsStorage | null,
  saveCallback: (data: BookSettingsStorage) => Promise<void>
): BookSettingsStore {
  return new BookSettingsStore(initialData, saveCallback);
}

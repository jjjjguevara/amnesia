# Amnesia Public API v1.0 Specification

## 1. Overview & Philosophy

Amnesia exposes a comprehensive public API following the **Headless Engine Paradigm**:

- **Core Engine**: Singleton services (LibraryService, HighlightService) with zero DOM dependency
- **Reactive State**: All state exposed as Svelte `readable()` stores for framework-agnostic reactivity
- **Command-Based Mutations**: No direct state manipulation; all writes via `api.commands.*` methods
- **Event-Driven**: Rich event system with typed payloads and hook middleware
- **Security**: Capability-based permissions with input validation

### Design Principles

1. **Backwards Compatibility**: Semantic versioning with deprecation warnings
2. **Type Safety**: Full TypeScript coverage with runtime Zod validation
3. **Framework Agnostic**: DOM-based UI injection, no framework lock-in
4. **Resource Management**: Disposable pattern for all registrations
5. **Performance**: Event throttling, lazy activation, minimal overhead

### Architecture Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                      External Plugins                            │
├─────────────────────────────────────────────────────────────────┤
│                      Amnesia Public API                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │  State   │  │ Commands │  │  Events  │  │    UI    │         │
│  │ (Svelte) │  │  (Async) │  │ (Typed)  │  │(Registry)│         │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘         │
├───────┼─────────────┼─────────────┼─────────────┼───────────────┤
│       │             │             │             │                │
│  ┌────▼─────────────▼─────────────▼─────────────▼────┐          │
│  │              Headless Core Engine                  │          │
│  │  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │          │
│  │  │LibraryStore │  │HighlightSvc │  │ Navigator │  │          │
│  │  └─────────────┘  └─────────────┘  └───────────┘  │          │
│  └───────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. API Access Patterns

### Pattern 1: Plugin Developers

```typescript
// In your plugin's onload()
const amnesiaPlugin = this.app.plugins.plugins['amnesia'];
if (!amnesiaPlugin) {
  console.error('Amnesia not installed');
  return;
}

const api = amnesiaPlugin.api as AmnesiaAPI;
console.log('API version:', api.version);
```

### Pattern 2: Templater/QuickAdd Scripts

```typescript
// Direct global access
const api = window.Amnesia;

// Get current book
import { get } from 'svelte/store';
const books = get(api.state.library).books;
const currentBook = books.find(b => b.status === 'reading');

// Use in template
return currentBook?.title || 'No active book';
```

### Pattern 3: Capability-Based Handshake

```typescript
// Request specific capabilities
const api = await window.Amnesia.connect('my-plugin-id', [
  'read-state',
  'write-annotations'
]);

// API methods validate permissions at runtime
try {
  await api.commands.highlights.create(...); // Allowed
  await api.commands.library.deleteAllBooks(); // Throws PermissionError
} catch (e) {
  if (e instanceof PermissionError) {
    console.error('Insufficient permissions:', e.required);
  }
}
```

### The `reset()` Pattern

Following the ExcalidrawAutomate pattern, always reset before scripts:

```typescript
const api = window.Amnesia;
api.reset(); // Reset to defaults

// Now run your automation
const highlights = api.commands.highlights.getHighlights(bookId);
```

---

## 3. Core APIs - Full Specification

### 3.1 Reader API

#### State: `api.state.reader`

Reactive Svelte store exposing current reading state.

**Type**: `Readable<ReaderState>`

**Properties**:
| Property | Type | Description |
|----------|------|-------------|
| `currentLocation` | `Locator \| null` | Readium locator with CFI, progression, text context |
| `paginationInfo` | `PaginationInfo \| null` | Current/total pages, chapter info, book progression |
| `config` | `NavigatorConfig` | Display settings (mode, fontSize, theme, etc.) |
| `isReady` | `boolean` | Whether navigator is initialized |
| `loading` | `boolean` | Loading state |

**Usage**:

```typescript
import { get } from 'svelte/store';

// One-time read
const location = get(api.state.reader).currentLocation;

// Reactive subscription
const unsubscribe = api.state.reader.subscribe(state => {
  console.log('Current page:', state.paginationInfo?.currentPage);
  console.log('Book progress:', state.paginationInfo?.bookProgression);
  console.log('CFI:', state.currentLocation?.locations.cfi);
});

// Cleanup
unsubscribe();
```

#### Commands: `api.commands.reader`

##### `goTo(target, options?): Promise<boolean>`

Navigate to a specific location in the book.

**Parameters**:
- `target: NavigationTarget` - One of:
  - `{ type: 'locator', locator: Locator }` - Navigate to Readium locator
  - `{ type: 'cfi', cfi: string }` - Navigate to EPUB CFI
  - `{ type: 'href', href: string, fragment?: string }` - Navigate to chapter
  - `{ type: 'progression', progression: number }` - Navigate to percentage (0-1)
  - `{ type: 'position', position: number }` - Navigate to spine index
- `options?: NavigationOptions` - Optional settings:
  - `instant?: boolean` - Skip page turn animation
  - `direction?: 'forward' | 'backward'` - Animation direction hint
  - `skipHistory?: boolean` - Don't add to navigation history

**Returns**: `Promise<boolean>` - `true` if navigation succeeded

**Examples**:

```typescript
// Navigate to saved CFI
const book = api.commands.library.getBook(bookId);
if (book?.currentCfi) {
  await api.commands.reader.goTo({ type: 'cfi', cfi: book.currentCfi });
}

// Navigate to 50% of book
await api.commands.reader.goTo({
  type: 'progression',
  progression: 0.5
});

// Navigate to chapter by href
await api.commands.reader.goTo({
  type: 'href',
  href: 'chapter3.xhtml',
  fragment: 'section-2'
});

// Navigate instantly (no animation)
await api.commands.reader.goTo(
  { type: 'position', position: 10 },
  { instant: true }
);
```

##### `next(): Promise<boolean>`

Navigate forward (next page in paginated mode, scroll distance in scrolled mode).

**Returns**: `Promise<boolean>` - `true` if navigated (not at end)

##### `prev(): Promise<boolean>`

Navigate backward (previous page in paginated mode, scroll distance in scrolled mode).

**Returns**: `Promise<boolean>` - `true` if navigated (not at start)

##### `nextChapter(): Promise<boolean>`

Navigate to the next chapter (spine item).

##### `prevChapter(): Promise<boolean>`

Navigate to the previous chapter.

##### `updateConfig(config): void`

Update reader display configuration.

**Parameters**:
- `config: Partial<NavigatorConfig>` - Partial configuration to update

**Example**:

```typescript
// Increase font size
api.commands.reader.updateConfig({ fontSize: 18 });

// Switch to dark theme
api.commands.reader.updateConfig({
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    linkColor: '#569cd6',
    highlightColor: '#ffeb3b'
  }
});

// Switch to scrolled mode
api.commands.reader.updateConfig({ mode: 'scrolled' });
```

##### `getVisibleText(): string`

Extract currently visible text content (useful for AI/summarization).

##### `getCfiForRange(range): string | null`

Generate EPUB CFI for a DOM Range.

##### `getRangeForCfi(cfi): Range | null`

Get DOM Range for an EPUB CFI.

---

### 3.2 Library API

#### State: `api.state.library`

**Type**: `Readable<LibraryState>`

**Properties**:
| Property | Type | Description |
|----------|------|-------------|
| `books` | `Book[]` | All books in library |
| `selectedBookId` | `string \| null` | Currently selected book |
| `loading` | `boolean` | Scan in progress |
| `error` | `string \| null` | Last error message |

**Usage**:

```typescript
// Get all reading books
const reading = get(api.state.library).books.filter(
  b => b.status === 'reading'
);

// Subscribe to library changes
api.state.library.subscribe(state => {
  console.log('Total books:', state.books.length);
  console.log('Currently reading:', state.books.filter(b => b.status === 'reading').length);
});
```

#### Commands: `api.commands.library`

##### `getBook(id): Book | undefined`

Get a book by ID.

##### `search(query): Book[]`

Search books by title or author.

##### `filterByStatus(status): Book[]`

Filter books by reading status.

**Parameters**:
- `status: 'to-read' | 'reading' | 'completed' | 'archived'`

##### `getRecentBooks(limit?): Book[]`

Get recently read books.

**Parameters**:
- `limit?: number` - Maximum number of books (default: 10)

##### `updateProgress(bookId, progress, cfi?): Promise<void>`

Update reading progress for a book.

**Parameters**:
- `bookId: string` - Book ID
- `progress: number` - Progress percentage (0-100)
- `cfi?: string` - Optional EPUB CFI

##### `updateStatus(bookId, status): Promise<void>`

Update book reading status.

##### `scan(folderPath): Promise<ScanResult>`

Scan a vault folder for EPUB/PDF files.

**Returns**: `Promise<ScanResult>` with `books` and `errors`

#### Advanced Query Methods (v0.3.0+)

##### `queryBooks(options): Book[]`

Query books with flexible filtering, sorting, and pagination.

**Parameters**:
- `options: BookQueryOptions` - Query configuration:
  - `author?: string` - Filter by author (partial match, case-insensitive)
  - `tag?: string` - Filter by tag (exact match)
  - `tags?: string[]` - Filter by multiple tags (all must match)
  - `series?: string` - Filter by series name
  - `status?: ReadingStatus | ReadingStatus[]` - Filter by reading status
  - `language?: string` - Filter by language
  - `publisher?: string` - Filter by publisher
  - `addedAfter?: Date | string` - Filter by date added
  - `addedBefore?: Date | string` - Filter by date added
  - `readAfter?: Date | string` - Filter by last read date
  - `readBefore?: Date | string` - Filter by last read date
  - `minProgress?: number` - Minimum progress (0-100)
  - `maxProgress?: number` - Maximum progress (0-100)
  - `textSearch?: string` - Text search in title/author/description
  - `sortBy?: 'title' | 'author' | 'dateAdded' | 'lastRead' | 'progress' | 'series'`
  - `sortOrder?: 'asc' | 'desc'`
  - `offset?: number` - Pagination offset
  - `limit?: number` - Pagination limit

**Examples**:

```typescript
// Get unfinished books by a specific author
const books = api.commands.library.queryBooks({
  author: 'Brandon Sanderson',
  status: 'reading',
  sortBy: 'progress',
  sortOrder: 'desc'
});

// Find books read in the last 30 days
const recentlyRead = api.commands.library.queryBooks({
  readAfter: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  sortBy: 'lastRead',
  sortOrder: 'desc'
});

// Paginated search with text filter
const searchResults = api.commands.library.queryBooks({
  textSearch: 'fantasy',
  limit: 20,
  offset: 0
});
```

##### `getBooksByAuthor(author): Book[]`

Get books by a specific author (partial match).

##### `getBooksWithTag(tag): Book[]`

Get books with a specific tag.

##### `getBooksInSeries(series): Book[]`

Get all books in a series, sorted by series index.

##### `getBooksByLanguage(language): Book[]`

Get books by language code.

##### `getBooksModifiedSince(since): Book[]`

Get books modified (read or added) since a date.

#### Aggregation Methods (v0.3.0+)

##### `getAuthors(): string[]`

Get all unique authors in the library (sorted alphabetically).

##### `getTags(): string[]`

Get all unique tags in the library (sorted alphabetically).

##### `getSeries(): Array<{ name: string; bookCount: number }>`

Get all unique series with book counts.

##### `getLanguages(): string[]`

Get all unique languages in the library.

##### `getLibraryStats(): LibraryStats`

Get comprehensive library statistics.

**Returns**:
```typescript
interface LibraryStats {
  totalBooks: number;
  byStatus: Record<ReadingStatus, number>;
  byLanguage: Record<string, number>;
  bySeries: Record<string, number>;
  averageProgress: number;
  recentlyAdded: number;   // Last 7 days
  recentlyRead: number;    // Last 7 days
  completedThisMonth: number;
  uniqueAuthors: number;
  uniqueTags: number;
}
```

**Example**:

```typescript
const stats = api.commands.library.getLibraryStats();
console.log(`Library: ${stats.totalBooks} books by ${stats.uniqueAuthors} authors`);
console.log(`Currently reading: ${stats.byStatus.reading}`);
console.log(`Average progress: ${Math.round(stats.averageProgress)}%`);
```

---

### 3.3 Highlights API

#### State: `api.state.highlights`

**Type**: `Readable<HighlightState>`

**Properties**:
| Property | Type | Description |
|----------|------|-------------|
| `highlights` | `Record<string, Highlight[]>` | Highlights by bookId |
| `pendingSelection` | `PendingSelection \| null` | Current text selection |
| `loading` | `boolean` | Operation in progress |
| `error` | `string \| null` | Last error message |

#### Commands: `api.commands.highlights`

##### `create(bookId, text, cfi, color, options?): Promise<Highlight>`

Create a new highlight.

**Parameters**:
- `bookId: string` - Book ID
- `text: string` - Selected text
- `cfi: string` - EPUB CFI
- `color: HighlightColor` - `'yellow' | 'green' | 'blue' | 'pink' | 'purple' | 'orange'`
- `options?: CreateHighlightOptions` - Additional options:
  - `chapter?: string` - Chapter title
  - `pagePercent?: number` - Page percentage
  - `annotation?: string` - User note
  - `spineIndex?: number` - Chapter index
  - `textQuote?: { exact, prefix, suffix }` - Text quote selector
  - `textPosition?: { start, end }` - Character offsets

**Example**:

```typescript
// Create from pending selection
const selection = get(api.state.highlights).pendingSelection;
if (selection) {
  const highlight = await api.commands.highlights.create(
    selection.bookId,
    selection.text,
    selection.cfi,
    'yellow',
    { annotation: 'Important insight!' }
  );
  console.log('Highlight created:', highlight.id);
}

// Create with full W3C selector for robust re-anchoring
const highlight = await api.commands.highlights.create(
  bookId,
  'This is important text',
  'epubcfi(/6/4!/4/2,/1:0,/1:20)',
  'yellow',
  {
    spineIndex: 5,
    textQuote: {
      exact: 'This is important text',
      prefix: 'preceding text ',
      suffix: ' following text'
    },
    textPosition: { start: 1234, end: 1256 }
  }
);
```

##### `update(bookId, highlightId, updates): Promise<Highlight | undefined>`

Update an existing highlight.

##### `delete(bookId, highlightId): Promise<boolean>`

Delete a highlight.

##### `getHighlights(bookId): Highlight[]`

Get all highlights for a book.

##### `searchHighlights(query): Highlight[]`

Search highlights across all books.

##### `getHighlightCount(bookId): number`

Get highlight count for a book.

---

## 4. Extended APIs

### 4.1 Calibre Content Server API (v0.3.0+)

Full bidirectional sync with Calibre Content Server for metadata and reading progress.

#### Connection

```typescript
// Connect to Content Server (from plugin settings or manually)
await api.calibre.connect('http://localhost:8080', 'MyLibrary');

// Check connection status
const isConnected = api.calibre.isConnected();
```

#### Read Operations

##### `getBooks(): Promise<CalibreBook[]>`

Get all books from Calibre library with metadata.

##### `getBookMetadata(bookId: number): Promise<CalibreMetadata>`

Get detailed metadata for a specific book.

**Returns**:
```typescript
interface CalibreMetadata {
  id: number;
  title: string;
  authors: string[];
  rating: number;        // 0-10 scale
  tags: string[];
  series?: string;
  series_index?: number;
  pubdate?: string;
  publisher?: string;
  identifiers: Record<string, string>;
  comments?: string;
  languages: string[];
  last_modified: string;
  // ... and more
}
```

##### `getBookCover(bookId: number): Promise<string>`

Get book cover as base64 data URL.

##### `searchBooks(query: string): Promise<CalibreBook[]>`

Search books in Calibre library.

#### Write Operations (requires `--enable-local-write` on server)

##### `setFields(bookId, changes): Promise<SetFieldsResult>`

Update metadata fields on a Calibre book.

**Parameters**:
- `bookId: number` - Calibre book ID
- `changes: Record<string, unknown>` - Fields to update

**Supported Fields**:
- `rating: number` (0-10 scale, use `rating * 2` to convert from 5-star)
- `tags: string[]`
- `series: string`
- `series_index: number`
- `publisher: string`
- `comments: string`
- `#custom_column: value` (custom columns with `#` prefix)

**Example**:

```typescript
// Update rating (convert 5-star to 10-point)
await api.calibre.setFields(966, {
  rating: 8,  // 4 stars * 2
  tags: ['fantasy', 'epic', 'favorites']
});

// Update series information
await api.calibre.setFields(123, {
  series: 'The Stormlight Archive',
  series_index: 1
});
```

**Returns**:
```typescript
interface SetFieldsResult {
  success: boolean;
  error?: string;
  updatedMetadata?: Record<string, unknown>;
}
```

#### Sync Commands

##### `syncLibrary(): Promise<SyncResult>`

Full bidirectional sync between Obsidian notes and Calibre metadata.

##### `syncActiveNote(): Promise<void>`

Sync only the currently active note (faster for single-book updates).

**Usage**: Command palette → "Calibre: Sync Active Note Only"

#### Rating Conversion

Calibre uses a 0-10 rating scale while Obsidian typically uses 1-5 stars:

```typescript
// Obsidian → Calibre
const calibreRating = obsidianRating * 2;

// Calibre → Obsidian
const obsidianRating = Math.round(calibreRating / 2);
```

#### Server Setup

```bash
# Start Calibre Content Server with write access
calibre-server --enable-local-write ~/Books

# With verbose logging
calibre-server --log /dev/stdout --access-log /dev/stdout --enable-local-write ~/Books
```

## 5. Stub APIs (v1.0 Placeholders)

These APIs have minimal interfaces in v1.0 and will be fully implemented in future versions.

### 5.1 OPDS API (`api.opds`)

```typescript
interface OPDSAPI {
  browse(catalogUrl: string): Promise<void>;  // Browse catalog
  download(bookId: string): Promise<void>;    // Download book
}
```

### 5.2 Bookmarks API (`api.bookmarks`)

```typescript
interface BookmarkAPI {
  create(bookId, cfi, name): Promise<Bookmark>;
  delete(bookId, bookmarkId): Promise<void>;
  getBookmarks(bookId): Bookmark[];
}
```

### 5.3 Navigation API (`api.navigation`)

```typescript
interface NavigationAPI {
  getTOC(): TocEntry[];
  navigateToChapter(index): Promise<void>;
}
```

### 5.4 Templates API (`api.templates`)

```typescript
interface TemplateAPI {
  generate(type, data): Promise<string>;
  setTemplate(type, template): void;
}
```

---

## 6. State Management Patterns

### 6.1 Redux-to-Svelte Bridge

Amnesia uses a custom bridge to expose Redux state as Svelte reactive stores.

**Internal Implementation**:

```typescript
import { readable } from 'svelte/store';
import type { Store } from './helpers/store';

function createReactiveSelector<T>(
  store: Store<any, any>,
  selector: (state: any) => T
): Readable<T> {
  const initialValue = selector(store.getValue());

  return readable(initialValue, (set) => {
    const unsubscribe = store.subscribe(() => {
      const nextValue = selector(store.getValue());
      set(nextValue);
    });
    return unsubscribe;
  });
}
```

### 6.2 Command-Based Mutations

All state changes go through command methods that dispatch Redux actions:

```typescript
class HighlightCommandsImpl {
  constructor(private service: HighlightService) {}

  async create(
    bookId: string,
    text: string,
    cfi: string,
    color: HighlightColor,
    options?: CreateHighlightOptions
  ): Promise<Highlight> {
    // 1. Validate inputs (Zod schema)
    const validated = CreateHighlightSchema.parse({
      bookId, text, cfi, color, ...options
    });

    // 2. Dispatch to service (which dispatches Redux action)
    return this.service.createHighlight(
      validated.bookId,
      validated.text,
      validated.cfi,
      validated.color,
      validated
    );
  }
}
```

---

## 7. Examples

### Example 1: Auto-Save Progress Script

```typescript
// Templater script to save current position
const api = window.Amnesia;
import { get } from 'svelte/store';

const reader = get(api.state.reader);
if (!reader.currentLocation) {
  return 'No book open';
}

const library = get(api.state.library);
const currentBook = library.books.find(b => b.status === 'reading');

if (currentBook && reader.currentLocation.locations.cfi) {
  await api.commands.library.updateProgress(
    currentBook.id,
    Math.round((reader.paginationInfo?.bookProgression || 0) * 100),
    reader.currentLocation.locations.cfi
  );
  return `Saved progress: ${Math.round((reader.paginationInfo?.bookProgression || 0) * 100)}%`;
}

return 'No active book';
```

### Example 2: Highlight Export Plugin

```typescript
// Export all highlights to a Markdown file
class HighlightExporter extends Plugin {
  async onload() {
    const api = this.app.plugins.plugins['amnesia']?.api;
    if (!api) return;

    this.addCommand({
      id: 'export-highlights',
      name: 'Export Highlights',
      callback: async () => {
        const library = get(api.state.library);
        const highlights = get(api.state.highlights);

        let markdown = '# Highlights Export\n\n';

        for (const book of library.books) {
          const bookHighlights = highlights.highlights[book.id] || [];
          if (bookHighlights.length === 0) continue;

          markdown += `## ${book.title}\n\n`;
          markdown += `*by ${book.author || 'Unknown'}*\n\n`;

          bookHighlights.forEach(h => {
            markdown += `- "${h.text}"\n`;
            if (h.annotation) {
              markdown += `  - *${h.annotation}*\n`;
            }
            markdown += '\n';
          });
        }

        await this.app.vault.create('Highlights Export.md', markdown);
        new Notice(`Exported highlights`);
      }
    });
  }
}
```

### Example 3: Reading Session Tracker

```typescript
// Track reading sessions with event listeners
const api = window.Amnesia;

let sessionStart: Date | null = null;
let pagesRead = 0;

// Listen to page turns
const disposable = api.events.on('page-turn', (event) => {
  if (!sessionStart) {
    sessionStart = new Date();
  }
  pagesRead++;

  const duration = Date.now() - sessionStart.getTime();
  const minutes = Math.floor(duration / 60000);

  console.log(`Session: ${minutes} min, ${pagesRead} pages`);
});

// Listen to book close
api.events.on('book-closed', () => {
  if (sessionStart) {
    const duration = Date.now() - sessionStart.getTime();
    const minutes = Math.floor(duration / 60000);
    new Notice(`Reading session: ${minutes} min, ${pagesRead} pages`);

    sessionStart = null;
    pagesRead = 0;
  }
});

// Cleanup when plugin unloads
this.register(() => disposable.dispose());
```

### Example 4: AI Summarizer UI Extension

```typescript
// Add AI summary button to reader toolbar
const api = this.app.plugins.plugins['amnesia']?.api;

const disposable = api.ui.toolbar.register({
  id: 'ai-summarize',
  icon: 'sparkles',
  label: 'AI Summary',
  onClick: async (ctx) => {
    const text = api.commands.reader.getVisibleText();
    if (!text) {
      new Notice('No visible text');
      return;
    }

    // Call your AI service
    const summary = await summarizeWithAI(text);
    new Notice(summary, 10000);
  }
});

this.register(() => disposable.dispose());
```

---

## 8. Version History

### v0.3.0 (January 2026)

- **Calibre Content Server API**: Full bidirectional sync with read/write operations
  - `setFields()` for updating Calibre metadata from Obsidian
  - Single-note sync command for faster updates
  - Rating conversion (5-star ↔ 10-point scale)
- **Advanced Query API**: Flexible book filtering with `queryBooks()`
  - Filter by author, tags, series, language, dates, progress
  - Sorting and pagination support
- **Aggregation Methods**: Library statistics and metadata aggregation
  - `getAuthors()`, `getTags()`, `getSeries()`, `getLanguages()`
  - `getLibraryStats()` for comprehensive statistics
- **Conflict Detection**: Bidirectional sync with conflict resolution

### v0.2.2 (January 2026)

- Restructured settings UI with 5 tabs (Library, Reading, Sync, Notes, Advanced)
- Liquid template integration for note generation
- Metadata mapping settings

### v1.0.0 (Initial Release)

- Core APIs: Reader, Library, Highlights
- Reactive state via Svelte stores
- Typed event system (25+ events)
- Hook middleware with cancellation
- Capability-based security
- UI extension points (toolbar, sidebar, context menu)
- Stub APIs: OPDS, Bookmarks, Navigation, Templates

### Future Roadmap

| Version | Features |
|---------|----------|
| v0.4.0 | Full Bookmarks API, Reading Notes |
| v0.5.0 | Full Navigation API (TOC, search) |
| v0.6.0 | Full Templates API |
| v1.0.0 | Full OPDS API, stable release |
| v1.1.0 | Dataview integration helpers |
| v1.2.0 | Templater helper namespace |

---

## 9. Type Reference

See the complete TypeScript definitions in:
- [`types/AmnesiaAPI.d.ts`](./types/AmnesiaAPI.d.ts)

Import types in your plugin:

```typescript
import type {
  AmnesiaAPI,
  Book,
  Highlight,
  Locator,
  ReaderState,
  BookQueryOptions,
  LibraryStats,
  Disposable
} from 'amnesia/api';
```

---

## 10. Contributing

The Amnesia API is open for contributions. See the main repository for:
- Issue tracking
- Pull request guidelines
- Development setup

---

*Amnesia API Specification v0.3.0*
*Last updated: January 2026*

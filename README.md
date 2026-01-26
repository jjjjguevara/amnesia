# Amnesia

> **Version 0.3.0**

**Amnesia** is a self-hosted ebook reader ecosystem for Obsidian, consisting of a Rust-based server and an Obsidian plugin. Part of the **DD** (Doc Doctor) + **LL** (Amnesia) suite.

## Features

- **EPUB & PDF support** — Full rendering for both formats with text selection
- **File-first architecture** — S3-compatible storage (MinIO, Cloudflare R2) as source of truth
- **Calibre bidirectional sync** — Full metadata sync with Calibre Content Server (read/write)
- **Local-first with optional sync** — Works 100% offline
- **Shared highlights system** — Integration with Doc Doctor
- **Liquid/Nunjucks templates** — Advanced templating for note generation
- **iPad optimized** — Performance-tuned for Obsidian mobile
- **OCR for scanned PDFs** — Tesseract and Ollama vision model support
- **Public API** — Fully typed API with advanced query and aggregation methods

## Project Structure

```
amnesia/
├── apps/
│   ├── amnesia-server/     # Rust server (Axum, S3, OPDS)
│   └── amnesia/            # Obsidian plugin (Svelte, Epub.js)
│       └── src/
│           ├── api/           # Public API (v0.2.0)
│           │   ├── events/    # Event emitter & hooks
│           │   ├── facades/   # Domain APIs (library, reader, highlights)
│           │   ├── ui/        # UI extension points
│           │   ├── security/  # Capabilities & validation
│           │   └── helpers/   # Templater integration
│           ├── reader/        # EPUB/PDF rendering
│           ├── library/       # Book management
│           ├── highlights/    # Annotation system
│           └── bookmarks/     # Bookmark system
├── packages/
│   └── shared-types/          # Shared TypeScript types
├── docs/
│   └── specifications/
│       └── API/               # API documentation
├── docker-compose.yml         # Local development setup
└── pnpm-workspace.yaml
```

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm 8+
- Rust (for server development)
- Docker (for local S3/MinIO)
- pdfium library (for PDF support, see [pdfium-render docs](https://crates.io/crates/pdfium-render))
- Tesseract (optional, for OCR)

### Development Setup

1. **Clone and install dependencies:**
   ```bash
   cd amnesia
   pnpm install
   ```

2. **Start local infrastructure:**
   ```bash
   docker-compose up -d minio minio-setup
   ```

3. **Start the server (development):**
   ```bash
   cd apps/amnesia-server
   cargo run
   ```

4. **Start the plugin (development):**
   ```bash
   cd apps/amnesia
   pnpm dev
   ```

5. **Access services:**
   - MinIO Console: http://localhost:9001 (admin/password123)
   - Server API: http://localhost:3000/health
   - Plugin: Symlink or copy to your Obsidian vault's plugins folder

### Adding Books

1. Open MinIO Console at http://localhost:9001
2. Navigate to the `library` bucket
3. Upload books following Calibre structure:
   ```
   Author Name/
   └── Book Title/
       ├── Book Title.epub
       ├── metadata.opf (optional)
       └── cover.jpg (optional)
   ```

## Architecture

### Server (Rust/Axum)

- **OPDS Catalog** — Generate OPDS 1.2/2.0 feeds from S3
- **EPUB Parser** — Metadata, TOC, and chapter extraction
- **PDF Parser** — pdfium-render for rendering and text extraction
- **OCR Service** — Tesseract and Ollama providers for scanned documents
- **Progress Sync** — Multi-device reading progress
- **Calibre Scanner** — Parse metadata.opf files
- **S3 Native** — Direct S3 API support (MinIO, R2, B2, AWS)

### Plugin (Svelte/TypeScript)

- **OPDS Client** — Browse any OPDS catalog
- **EPUB Renderer** — Full-featured EPUB rendering with highlights
- **PDF Renderer** — Server-based rendering with PDF.js fallback
- **Unified Reader** — DocumentRenderer interface for both formats
- **Liquid Templates** — Customizable note generation
- **Doc Doctor Integration** — Shared highlights system

### Paginated EPUB Rendering

The plugin uses a sophisticated multi-column CSS layout system for paginated reading:

- **Shadow DOM Isolation** — Each book renders in an isolated Shadow DOM to prevent CSS conflicts
- **Per-Chapter Columns** — Each chapter is a CSS multi-column container, enabling virtualization
- **Content-Based Measurement** — Column counts are determined by actual content positions, not container width
- **Chapter Windowing** — Only 5-7 chapters loaded at a time (±2-3 from current position)
- **Transform-Based Navigation** — Horizontal scrolling via CSS `translate3d` for 60fps animations
- **Accurate Column Calculation** — Uses `N * columnWidth + (N-1) * gap` formula for precise alignment

## Public API

Amnesia exposes a fully-typed public API for external plugins, Templater scripts, and automation workflows.

> **Full API documentation**: [`docs/specifications/API/`](docs/specifications/API/)

### API Access

The API is available via two access points:

```typescript
// From another Obsidian plugin
const api = app.plugins.plugins['amnesia'].api;

// From Templater, QuickAdd, or DataviewJS
const api = window.Amnesia;
```

### Core Features

| Domain | State Store | Commands |
|--------|-------------|----------|
| **Reader** | Location, pagination, config | `goTo()`, `next()`, `prev()`, `updateConfig()` |
| **Library** | Books, loading state | `getBook()`, `search()`, `queryBooks()`, `getLibraryStats()` |
| **Highlights** | Highlights by book | `create()`, `update()`, `delete()`, `getHighlights()` |
| **Bookmarks** | Bookmarks by book | `create()`, `update()`, `delete()`, `getBookmarks()` |
| **Calibre** | Connection state | `connect()`, `setFields()`, `syncLibrary()`, `syncActiveNote()` |

### Example Usage

```typescript
const api = window.Amnesia;

// Subscribe to reactive state (Svelte stores)
api.state.library.subscribe(state => {
  console.log('Books:', state.books.length);
});

// Listen to events
const disposable = api.events.on('page-turn', ({ from, to }) => {
  console.log(`Turned from page ${from} to ${to}`);
});

// Connect with capabilities for write access
const scopedApi = await api.connect('my-plugin', ['write-annotations']);
await scopedApi.commands.highlights.create(
  bookId,
  'Selected text',
  cfiLocation,
  'yellow',
  'My annotation'
);

// Clean up
disposable.dispose();
```

### Events System

25+ typed events for navigation, content, highlights, and library changes:

```typescript
// Navigation events
api.events.on('relocated', ({ location }) => { ... });
api.events.on('page-turn', ({ from, to, spineIndex }) => { ... });

// Content events
api.events.on('text-selected', ({ text, cfi, selector }) => { ... });
api.events.on('link-clicked', ({ href, external }) => { ... });

// Highlight events
api.events.on('highlight-created', ({ highlight }) => { ... });

// Library events
api.events.on('progress-updated', ({ bookId, progress }) => { ... });
```

### Hook System

Middleware-style hooks with cancellation support:

```typescript
api.hooks.register('onBeforePageTurn', async (context) => {
  console.log(`About to turn from ${context.currentPage} to ${context.nextPage}`);
  return true; // Allow navigation (return false to cancel)
});

api.hooks.register('onBeforeHighlightCreate', async (context) => {
  // Validate or transform highlight before creation
  return context.text.length > 10; // Only allow highlights > 10 chars
});
```

### UI Extension Points

Register custom toolbar buttons, sidebar views, and context menu items:

```typescript
// Add a toolbar button
api.ui.toolbar.register({
  id: 'my-button',
  icon: 'star',
  label: 'My Action',
  onClick: (context) => {
    console.log('Current book:', context.bookId);
  }
});

// Add a sidebar view
api.ui.sidebar.register({
  id: 'my-view',
  title: 'My Panel',
  icon: 'layout-list',
  mount: (container) => {
    container.innerHTML = '<h3>Custom Content</h3>';
    return () => container.innerHTML = ''; // Cleanup function
  }
});

// Add context menu items
api.ui.contextMenu.register({
  id: 'copy-quote',
  label: 'Copy as Quote',
  condition: (ctx) => ctx.hasSelection,
  action: (ctx) => navigator.clipboard.writeText(`> ${ctx.text}`)
});
```

### Security Model

Capability-based permissions protect sensitive operations:

| Capability | Allows |
|------------|--------|
| `read-state` | Read all state stores |
| `write-annotations` | Create/update/delete highlights |
| `write-bookmarks` | Create/update/delete bookmarks |
| `write-library` | Update progress, scan library |
| `admin` | Full access (includes all above) |

```typescript
// Request specific capabilities
const api = await window.Amnesia.connect('my-plugin', [
  'read-state',
  'write-annotations'
]);

// Operations without required capability will throw PermissionError
```

### Templater Helpers

Convenient helpers for Templater scripts:

```typescript
const ll = window.Amnesia.helpers;

// Get current book and location
const book = ll.getCurrentBook();
const location = ll.getCurrentLocation();
const selection = ll.getCurrentSelection();

// Get highlights for a book
const highlights = ll.getHighlights(bookId);
const randomHighlight = ll.getRandomHighlight();

// Format citations
const citation = ll.formatCitation('apa');
```

### API Documentation

| Document | Description |
|----------|-------------|
| [`api-v1.0.md`](docs/specifications/API/api-v1.0.md) | Complete API reference |
| [`events.md`](docs/specifications/API/events.md) | Event catalog with payloads |
| [`security.md`](docs/specifications/API/security.md) | Capability model |
| [`ui-extensibility.md`](docs/specifications/API/ui-extensibility.md) | UI extension points |
| [`expansion-points.md`](docs/specifications/API/expansion-points.md) | Future integrations |

## PDF Support

Amnesia provides comprehensive PDF rendering with feature parity to EPUB:

### Server-Side Rendering (pdfium-render)

- **High-quality page rendering** — Native PDF rendering via pdfium library
- **Text layer extraction** — Character-level positions for precise text selection
- **Metadata parsing** — Title, author, subject, keywords from PDF info
- **Table of contents** — Automatic extraction from PDF bookmarks/outline
- **Full-text search** — Search across all pages with context snippets
- **Page caching** — LRU cache for rendered pages and text layers

### Client-Side Features

- **Display modes** — Paginated (single/dual page) and continuous scroll
- **Text selection** — Select and highlight text with invisible text layer overlay
- **Annotations** — Highlights, notes, and bookmarks with PDF-specific selectors
- **Region selection** — Rectangle drawing for scanned PDFs without text layer
- **Zoom & rotation** — Configurable scale and page rotation

### OCR Integration

For scanned PDFs without embedded text:

```bash
# Enable Tesseract OCR (requires tesseract installed)
cargo build --features ocr-tesseract

# Or use Ollama vision models
OLLAMA_URL=http://localhost:11434 cargo run
```

Supported OCR providers:
- **Tesseract** — Local OCR engine, fast and accurate
- **Ollama** — Vision models (llava, bakllava) for complex layouts

### Offline Fallback (PDF.js)

When the server is unavailable, the plugin automatically falls back to client-side rendering:

- **Hybrid provider** — Seamless switching between server and PDF.js
- **Lazy loading** — PDF.js loaded only when needed
- **Full feature support** — Text selection, search, and annotations work offline

### PDF API Endpoints

```
POST   /api/v1/pdf                      Upload PDF
GET    /api/v1/pdf/:id                  Get metadata
DELETE /api/v1/pdf/:id                  Delete PDF
GET    /api/v1/pdf/:id/pages/:page      Rendered page image
GET    /api/v1/pdf/:id/pages/:page/text Text layer JSON
GET    /api/v1/pdf/:id/search           Full-text search
POST   /api/v1/pdf/:id/pages/:page/ocr  OCR region extraction
GET    /api/v1/pdf/:id/ocr/providers    List available OCR providers
```

### PDF Annotation Selectors

PDF annotations use normalized coordinates (0-1) for resolution independence:

```typescript
// Text-based selector (for PDFs with text layer)
{ type: 'PdfTextQuote', page: 5, exact: 'highlighted text', prefix: '...', suffix: '...' }

// Region selector (for scanned PDFs)
{ type: 'PdfRegion', page: 5, rect: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 } }

// Page position selector
{ type: 'PdfPage', page: 5, position: { x: 0.5, y: 0.3 } }
```

## Configuration

### Server Environment Variables

```bash
SERVER_HOST=0.0.0.0
SERVER_PORT=3000
S3_PROVIDER=minio           # minio, r2, s3, b2
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=library
S3_ACCESS_KEY=admin
S3_SECRET_KEY=password
DATABASE_URL=sqlite:./libros.db
```

### Plugin Settings

Configure in Obsidian Settings → Amnesia:

- **Server URL** — Your Amnesia server instance
- **Books Folder** — Local vault folder for EPUBs
- **Sync Settings** — Progress and highlight sync options
- **Templates** — Liquid templates for book notes and highlights

## Roadmap

### Completed

- [x] **Phase 0:** Server infrastructure (S3, OPDS, Docker)
- [x] **Phase 1:** Plugin MVP (reader, library, progress)
- [x] **Phase 2:** Highlights & Doc Doctor integration
- [x] **Phase 3:** PDF support (server rendering, text layer, annotations)
- [x] **Phase 4:** OCR integration (Tesseract, Ollama)
- [x] **Phase 5:** PDF.js offline fallback
- [x] **Phase 6:** Public API v1.0 (events, hooks, UI extensions, security)
- [x] **Phase 7:** Calibre bidirectional sync (metadata read/write, conflict detection)
- [x] **Phase 8:** Advanced query API (filtering, aggregation, statistics)

### In Progress

- [ ] **Phase 9:** Intelligence layer (Smart Connections, LLM)

### Planned API Expansions

The following integrations are designed but not yet implemented. See [`expansion-points.md`](docs/specifications/API/expansion-points.md) for full specifications.

| Integration | Priority | Description |
|-------------|----------|-------------|
| Shadow Notes | High | Markdown sidecar files for vault-wide search |
| Templater Helpers | High | Extended helper functions for templates |
| Dataview Integration | Medium | Reading dashboards and statistics queries |
| QuickAdd Macros | Medium | Capture macros for highlights and notes |
| Reading Statistics | Medium | Analytics, streaks, and reading goals |
| Collections & Tags | Medium | Organize books into collections |
| OPDS Browser | Low | Browse and download from OPDS catalogs |
| PDF Annotations | Low | Import/export PDF native annotations |

## Related Projects

- **[Doc Doctor](/Users/josueguevara/Documents/Builds/doc-doctor)** — AI-powered document analysis

## License

Amnesia is licensed under the GNU Affero General Public License v3.0. See `LICENSE` for full terms.

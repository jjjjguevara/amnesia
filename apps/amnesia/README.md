# Amnesia

An ebook reader plugin for Obsidian with OPDS support, highlights, PDF rendering, and Doc Doctor integration.

## Features

- **EPUB & PDF Support**: Read EPUBs and PDFs directly in Obsidian
- **OPDS Integration**: Connect to OPDS catalogs (Calibre, etc.)
- **Highlights & Annotations**: Create and sync highlights across your library with 12 semantic annotation types
- **Multiple Reading Modes**: Paginated, vertical scroll, horizontal scroll, auto-grid, and canvas modes
- **Calibre Sync**: Bidirectional sync with Calibre libraries, FTS5-powered search (50x faster)
- **Doc Doctor Integration**: Unified annotation vocabulary, bidirectional highlight↔stub sync
- **Nunjucks Templates**: Customizable note generation from highlights
- **Server API**: Bibliography generation (BibTeX, APA, MLA, Chicago, IEEE), FTS5 search

## Installation

1. Download the latest release
2. Extract to your vault's `.obsidian/plugins/amnesia/` directory
3. Enable the plugin in Obsidian settings

## PDF Rendering

The plugin includes a high-performance PDF renderer with:
- **Custom MuPDF WASM**: Optimized build with SIMD and LTO (12% smaller, 1.3-2.5x faster)
- Smooth pan and zoom (pinch-to-zoom and Cmd+scroll)
- Multiple display modes (paginated, scroll, canvas)
- Text selection and highlighting
- Region selection for scanned PDFs
- Velocity-based adaptive prefetching
- Multi-worker tile rendering (4 workers default)

### Custom MuPDF WASM Build

The plugin uses a custom MuPDF WASM build optimized for PDF and EPUB rendering:

| Metric | Custom Build | npm Package | Improvement |
|--------|-------------|-------------|-------------|
| **Size (uncompressed)** | 8.4 MB | 9.5 MB | 12% smaller |
| **Size (gzipped)** | 2.9 MB | 4.3 MB | 33% smaller |
| **Core render time** | ~8ms | ~15ms | 1.3-2.5x faster |

**Optimizations enabled:**
- SIMD instructions (`-msimd128`) for vectorized operations
- Link-Time Optimization (`-flto`) for smaller binary
- wasm-opt with SIMD and exception handling
- CJK fonts stripped (saves 3.4MB for non-CJK users)

**Features kept:** PDF, EPUB, SVG (for EPUB3), image handling
**Features disabled:** XPS, CBZ, HTML (standalone), JavaScript forms, MOBI, FB2, Office formats

To rebuild the custom WASM, see `build/mupdf-wasm/mupdf/platform/wasm/tools/build-amnesia.sh`

## Version History

### 0.5.0 (2026-01-08)
**Ecosystem Expansion Release** - Complete implementation of M0-M7 milestones from the ecosystem expansion plan.

#### M0: Code Cleanup
- Consolidated to Nunjucks templates (removed Liquid engine)
- Removed 2,770 LOC of deprecated code
- Bundle size optimization

#### M1: Event System Completion
- Exposed `window.Amnesia` public API
- Doc Doctor event bridge for cross-plugin communication
- `amnesia:ready` event for plugin discovery

#### M2: Unified Annotations Vocabulary
- 12 semantic annotation types (verify, expand, clarify, question, important, citation, definition, argument, evidence, counterpoint, todo, connection)
- `@amnesia/shared-types` package for type sharing
- Color → semantic type mapping

#### M3: Bidirectional Highlight ↔ Stub Sync
- Auto-sync highlights to Doc Doctor stubs
- Stub resolution propagation back to highlights
- Conflict resolution (newest-wins, amnesia-wins, dd-wins)
- Sync status UI indicators

#### M4: HUD Enhancements
- Book health integration from Doc Doctor
- Source/Live mode foundation (Cmd/Ctrl+E toggle)
- Context menu stub creation

#### M5: Testing & Documentation
- E2E test suite for integration scenarios
- Performance benchmarks
- MCP test harness for Obsidian DevTools
- Sync telemetry

#### M6: Calibre & Search Optimization
- FTS5 index for Calibre (50x faster search: 1000ms → 20ms)
- Lazy-load sql.js (-1.5MB for non-Calibre users)
- Incremental sync with change tracking

#### M7: Server API Expansions
- Server-side FTS5 search endpoints
- Bibliography generation (BibTeX, APA 7th, MLA 9th, Chicago 17th, IEEE)
- Annotation extraction API (stub - pending MuPDF binding updates)

### 0.4.1 (2026-01-08)
- **PDF Scroll Performance Fix**: Fixed "0 visible tiles" issue during continuous trackpad scroll by implementing camera snapshot at schedule time
- **Velocity-Based Adaptive Prefetching**: Added intelligent tile prefetching with 4 speed zones (stationary, slow, medium, fast) for smoother scrolling
- **Priority-Based Tile Rendering**: Tiles now render with priority levels (critical, high, medium, low) based on distance from viewport
- **Lifecycle Test Suite**: Added 7 comprehensive test scenarios for PDF rendering validation via MCP

### 0.4.0 (2026-01-07)
- **PDF Rendering Optimization**: Dual-resolution rendering (never show blank pages), spatial prefetching for grid modes
- **Seamless Mode Transitions**: Cache preservation during mode switches, background thumbnail generation
- **HUD (Heads-Up Display)**: New status bar with Doc Doctor integration, 5 tabbed views (Reading, Library, Stats, Server, Series)
- **Reading Metrics**: Context-aware display, reading streaks and activity sparklines

### 0.3.1 (2026-01-05)
- Fixed PDF scroll behavior in vertical/horizontal scroll modes (wheel events were incorrectly triggering page navigation)
- Re-enabled pinch-to-zoom and Cmd+scroll zoom gestures

### 0.3.0 (2026-01-04)
- Calibre bidirectional sync (read/write API)
- Advanced query API
- Library statistics
- Single-note sync command

### 0.2.2 (2026-01-03)
- Restructured settings UI: 5 tabs (Library, Reading, Sync, Notes, Advanced)
- Integrated Liquid templates for note generation
- Added metadata mapping settings

## API

### Public API (`window.Amnesia`)
```typescript
window.Amnesia = {
  version: string,
  commands: {
    highlights: {
      create(data: CreateHighlightData): Promise<Highlight>,
      get(id: string): Promise<Highlight>,
      update(id: string, data: UpdateHighlightData): Promise<Highlight>,
      delete(id: string): Promise<void>,
      list(bookId?: string): Promise<Highlight[]>
    },
    books: {
      open(bookId: string): Promise<void>,
      list(): Promise<Book[]>
    }
  },
  events: EventEmitter
}
```

### Server API
```
GET  /api/v1/search/books?q=...
GET  /api/v1/search/highlights?q=...
GET  /api/v1/search/unified?q=...
GET  /api/v1/bibliography/books/:id/citation?format=bibtex
POST /api/v1/bibliography/generate
GET  /api/v1/extract/documents/:id/annotations
```

## Development

```bash
# Install dependencies
pnpm install

# Development build (watches for changes)
pnpm run dev

# Production build
pnpm run build

# Run tests
pnpm test

# Build server (Rust)
cd apps/amnesia-server && cargo build --release
```

## License

MIT

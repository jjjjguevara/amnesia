# Los Libros

**Los Libros** is a self-hosted ebook reader ecosystem for Obsidian, consisting of a Rust-based server and an Obsidian plugin. Part of the **DD** (Doc Doctor) + **LL** (Los Libros) suite.

## Features

- **EPUB & PDF support** — Full rendering for both formats with text selection
- **File-first architecture** — S3-compatible storage (MinIO, Cloudflare R2) as source of truth
- **Calibre-compatible** — Uses Calibre's folder structure, no migration needed
- **Local-first with optional sync** — Works 100% offline
- **Shared highlights system** — Integration with Doc Doctor
- **BookFusion-style templates** — Liquid templating for customization
- **iPad optimized** — Performance-tuned for Obsidian mobile
- **OCR for scanned PDFs** — Tesseract and Ollama vision model support

## Project Structure

```
los-libros/
├── apps/
│   ├── los-libros-server/     # Rust server (Axum, S3, OPDS)
│   └── los-libros/            # Obsidian plugin (Svelte, Epub.js)
├── packages/
│   └── shared-types/          # Shared TypeScript types
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
   cd los-libros
   pnpm install
   ```

2. **Start local infrastructure:**
   ```bash
   docker-compose up -d minio minio-setup
   ```

3. **Start the server (development):**
   ```bash
   cd apps/los-libros-server
   cargo run
   ```

4. **Start the plugin (development):**
   ```bash
   cd apps/los-libros
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

## PDF Support

Los Libros provides comprehensive PDF rendering with feature parity to EPUB:

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

Configure in Obsidian Settings → Los Libros:

- **Server URL** — Your Los Libros server instance
- **Books Folder** — Local vault folder for EPUBs
- **Sync Settings** — Progress and highlight sync options
- **Templates** — Liquid templates for book notes and highlights

## Roadmap

- [x] **Phase 0:** Server infrastructure (S3, OPDS, Docker)
- [x] **Phase 1:** Plugin MVP (reader, library, progress)
- [x] **Phase 2:** Highlights & Doc Doctor integration
- [x] **Phase 3:** PDF support (server rendering, text layer, annotations)
- [x] **Phase 4:** OCR integration (Tesseract, Ollama)
- [x] **Phase 5:** PDF.js offline fallback
- [ ] **Phase 6:** Intelligence layer (Smart Connections, LLM)

## Related Projects

- **[Doc Doctor](/Users/josueguevara/Documents/Builds/doc-doctor)** — AI-powered document analysis

## License

MIT

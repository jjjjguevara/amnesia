# Research Prompt: PDF Parsing Server Issue

## Project Context

**Amnesia** is an Obsidian plugin for reading EPUB and PDF books directly within Obsidian. Users can:
- Read books from their Obsidian vault
- Read books from a Calibre library
- Create highlights and annotations
- Sync reading progress to markdown notes

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Obsidian (Electron)                  │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Amnesia Plugin (TypeScript)          │  │
│  │                                                   │  │
│  │  - EPUB rendering (epub.js, works fine)           │  │
│  │  - PDF rendering (needs parsed page data)         │  │
│  │  - Highlight management                           │  │
│  │  - Reading progress sync                          │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                            │
                            │ HTTP API
                            ▼
┌─────────────────────────────────────────────────────────┐
│              amnesia-server (Rust + Axum)               │
│                                                         │
│  - Receives PDF binary data from plugin                 │
│  - Parses PDF to extract:                               │
│      • Page count and dimensions                        │
│      • Text content per page (for search/highlights)    │
│      • Image positions (future: for rendering)          │
│  - Returns structured JSON to plugin                    │
│  - Caches parsed results for subsequent requests        │
└─────────────────────────────────────────────────────────┘
```

### Why Server-Side PDF Parsing?

1. **Text extraction**: Need accurate text positions for highlighting and search
2. **Page structure**: Need page dimensions and count for navigation
3. **Performance**: Parse once, cache results, serve to multiple sessions
4. **Future features**: OCR support, image extraction, thumbnail generation

---

## The Problem

**Only the first PDF uploaded to the server parses successfully. Every subsequent PDF hangs indefinitely.**

### Reproduction Steps

1. Start the server fresh
2. Upload any PDF → **Success** (parses in ~8ms)
3. Upload a different PDF → **Hangs forever** (no response until 120s timeout)
4. Upload the same PDF from step 2 → **Hangs forever**
5. Restart server → First PDF works again, then hangs on second

### Observed Behavior

| Attempt | PDF | Result |
|---------|-----|--------|
| 1st after restart | Any PDF | Success, ~8ms |
| 2nd | Any PDF | Hang, 120s timeout |
| 3rd | Any PDF | Hang, 120s timeout |
| After restart | Any PDF | Success again |

The issue is **not** related to:
- PDF file size (tiny 123KB and large 65MB both exhibit same behavior)
- PDF complexity (simple text PDFs and complex image PDFs same behavior)
- Specific PDF files (the same PDF works if it's first, hangs if second)

---

## Technical Stack

### Server (Rust)

```toml
[dependencies]
pdfium-render = { version = "0.8", features = ["thread_safe"] }
tokio = { version = "1", features = ["full"] }
axum = { version = "0.7", features = ["multipart"] }
```

- **pdfium-render**: Rust bindings to Google's PDFium library
- **libpdfium.dylib**: Pre-built PDFium binary (v145.0.7606.0, arm64 macOS)
- **tokio**: Async runtime, using `spawn_blocking` for CPU-bound PDF parsing

### Parsing Flow

```
HTTP Request (PDF bytes)
       │
       ▼
 axum handler
       │
       ▼
 tokio::spawn_blocking  ←── CPU-bound work off async runtime
       │
       ▼
 pdfium-render::Pdfium::load_pdf_from_byte_slice()
       │
       ▼
 Iterate pages, extract text
       │
       ▼
 Return ParsedPdf struct
```

### Relevant Code Pattern

```rust
// Initialize pdfium once
let pdfium = Pdfium::new(
    Pdfium::bind_to_library("libpdfium.dylib")?
);

// Parse a PDF
let document = pdfium.load_pdf_from_byte_slice(data, None)?;
let page_count = document.pages().len();

for page in document.pages().iter() {
    let text = page.text().map(|t| t.all()).unwrap_or_default();
    // ... collect page data
}
// document dropped here (should release resources)
```

---

## Diagnostic Data

### Server Logs

```
# Server start
INFO: Starting Los Libros Server v0.1.0
INFO: Los Libros Server listening on 0.0.0.0:3000

# First PDF - works
WARN: PDF 'Book A' not found in cache
INFO: PDF uploaded: 'Book A' with 305 pages    ← Success

# Second PDF - hangs (no output for 120 seconds)
WARN: PDF 'Book B' not found in cache
# ... complete silence, no further logs ...
# Eventually times out after 120 seconds
```

### Key Observation

The hang occurs **inside** the pdfium-render/libpdfium code. No Rust log statements execute after the `load_pdf_from_byte_slice` call on the second PDF. The blocking thread never returns.

---

## What We've Tried

1. **Thread-local PDFium instances**: Store separate `Pdfium` instance per thread using `thread_local!` macro → Same behavior

2. **Limiting concurrent parses**: Added semaphore to allow only 1-2 concurrent parses → Same behavior (but prevents server from becoming completely unresponsive)

3. **Reducing cache size**: Limited parsed document cache to 1 entry → Same behavior

4. **Increased timeouts**: Extended from 30s to 120s → Doesn't fix hang, just delays error response

---

## Environment

- **OS**: macOS Darwin 25.3.0 (Apple Silicon, arm64)
- **Rust**: 1.91.1
- **PDFium binary**: libpdfium.dylib v145.0.7606.0 (pre-built for arm64)

---

## Research Questions

1. Is this a known issue with PDFium or pdfium-render when processing multiple documents?

2. What is the correct way to handle multiple sequential PDF documents with PDFium in a long-running server process?

3. Are there alternative PDF parsing libraries for Rust that handle multiple documents reliably in a server context?

4. How do other projects (in any language) solve PDFium's multi-document issues in server environments?

5. What debugging approaches could help identify exactly where PDFium is hanging?

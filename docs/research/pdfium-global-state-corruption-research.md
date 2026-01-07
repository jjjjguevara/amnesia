# PDFium Global State Corruption - Research Prompt

## Executive Summary

We have a critical bug where **only the first PDF document works** in our Rust-based PDF parsing server. All subsequent PDF parsing attempts hang indefinitely until timeout (120 seconds). This appears to be related to PDFium's global C state management.

---

## Tech Stack

| Component | Version | Details |
|-----------|---------|---------|
| **pdfium-render** | 0.8.37 | Rust bindings with `thread_safe` feature enabled |
| **libpdfium.dylib** | 145.0.7606.0 | Pre-built binary for arm64 macOS |
| **Rust** | 1.91.1 | Stable toolchain |
| **tokio** | 1.x | Async runtime with `full` features |
| **Platform** | macOS Darwin 25.3.0 | Apple Silicon (arm64) |
| **Server Framework** | axum 0.7 | Async web server |

### Cargo.toml Dependencies

```toml
pdfium-render = { version = "0.8", features = ["thread_safe"] }
tokio = { version = "1", features = ["full"] }
axum = { version = "0.7", features = ["multipart"] }
```

---

## Observed Behavior

### Test Sequence

1. **Start fresh server** → Server initializes successfully
2. **Upload PDF #1** (any size) → **SUCCESS** in ~8ms parse time
3. **Upload PDF #2** (any PDF, even the same one) → **HANGS INDEFINITELY**
4. Server eventually returns timeout error after 120 seconds
5. **Restart server** → First PDF works again, pattern repeats

### Diagnostic Evidence

```
# Server log - First PDF works
INFO amnesia_server::routes::pdf: PDF uploaded: 'Bears Without Fear' with 305 pages

# Server log - Second PDF hangs (no log output until timeout)
WARN amnesia_server::routes::pdf: PDF 'Tao Fourier Transform 2013' not found in cache
# ... 120 seconds of silence ...
ERROR: PDF parsing timed out after 120 seconds
```

### Performance Data

| PDF | Size | Pages | First Load | Second Load |
|-----|------|-------|------------|-------------|
| Bears Without Fear | 3.5 MB | 305 | 8ms | HANG |
| Tao Fourier | 123 KB | 5 | 8ms (when first) | HANG |
| Nietzsche | ~1 MB | ~100 | 7ms (when first) | HANG |

---

## Current Implementation

### Parser Initialization (parser.rs)

```rust
use pdfium_render::prelude::*;
use std::cell::RefCell;
use std::sync::Arc;

thread_local! {
    static THREAD_PDFIUM: RefCell<Option<Arc<Pdfium>>> = const { RefCell::new(None) };
}

fn get_pdfium() -> Result<Arc<Pdfium>, PdfParseError> {
    THREAD_PDFIUM.with(|cell| {
        let mut opt = cell.borrow_mut();
        if let Some(ref pdfium) = *opt {
            return Ok(Arc::clone(pdfium));
        }

        let lib_path = std::env::current_dir()
            .map(|p| p.join("libpdfium.dylib"))
            .unwrap_or_else(|_| PathBuf::from("libpdfium.dylib"));

        let bindings = Pdfium::bind_to_library(
            Pdfium::pdfium_platform_library_name_at_path(&lib_path)
        ).map_err(|e| PdfParseError::LoadError(format!("Failed to bind PDFium: {}", e)))?;

        let pdfium = Arc::new(Pdfium::new(bindings));
        *opt = Some(Arc::clone(&pdfium));
        Ok(pdfium)
    })
}
```

### PDF Parsing (parser.rs)

```rust
pub fn parse_pdf(data: &[u8], filename: &str) -> Result<ParsedPdf, PdfParseError> {
    let pdfium = get_pdfium()?;

    let document = pdfium
        .load_pdf_from_byte_slice(data, None)
        .map_err(|e| PdfParseError::LoadError(format!("Failed to load PDF: {}", e)))?;

    let page_count = document.pages().len() as u32;
    let mut pages = Vec::with_capacity(page_count as usize);

    for (index, page) in document.pages().iter().enumerate() {
        let width = page.width().value as f32;
        let height = page.height().value as f32;

        let text = page
            .text()
            .map(|t| t.all())
            .unwrap_or_default();

        pages.push(ParsedPage {
            page_number: index as u32 + 1,
            width,
            height,
            text_content: text,
            images: vec![],
        });
    }

    Ok(ParsedPdf {
        filename: filename.to_string(),
        page_count,
        pages,
    })
}
```

### Cache with Semaphore (cache.rs)

```rust
const PARSE_TIMEOUT_SECS: u64 = 120;
const DEFAULT_CONCURRENT_PARSES: usize = 2;

pub struct PdfCache {
    cache: Arc<RwLock<LruCache<String, CachedPdf>>>,
    parser_cache: Arc<RwLock<LruCache<String, ParsedPdf>>>,
    parse_semaphore: Arc<Semaphore>,
}

pub async fn load_from_bytes(&self, data: &[u8], filename: &str) -> Result<ParsedPdf, PdfParseError> {
    // Acquire semaphore permit to limit concurrent parses
    let _permit = self.parse_semaphore.acquire().await
        .map_err(|e| PdfParseError::LoadError(format!("Failed to acquire parse permit: {}", e)))?;

    let data_copy = data.to_vec();
    let filename_copy = filename.to_string();

    let result = tokio::time::timeout(
        Duration::from_secs(PARSE_TIMEOUT_SECS),
        tokio::task::spawn_blocking(move || {
            parse_pdf(&data_copy, &filename_copy)
        })
    ).await;

    match result {
        Ok(Ok(parsed)) => parsed,
        Ok(Err(e)) => Err(PdfParseError::LoadError(format!("Parse task failed: {}", e))),
        Err(_) => Err(PdfParseError::Timeout(PARSE_TIMEOUT_SECS)),
    }
}
```

---

## Approaches Tried (All Failed)

### 1. Thread-Local PDFium Instance

**Hypothesis**: Each blocking thread should have its own PDFium instance to avoid shared state.

**Implementation**: Used `thread_local!` macro to store `Arc<Pdfium>` per thread.

**Result**: **FAILED** - Same behavior. First PDF works, second hangs.

### 2. Single-Document Parser Cache

**Hypothesis**: Caching parsed documents might keep PDFium in a bad state.

**Implementation**: Reduced `DEFAULT_PARSER_CACHE_SIZE` to 1.

**Result**: **FAILED** - Same behavior.

### 3. Parse Semaphore

**Hypothesis**: Concurrent parsing might cause conflicts.

**Implementation**: Added `Semaphore` to limit to 2 concurrent parses.

**Result**: **PARTIAL** - Prevents server from becoming completely unresponsive, but doesn't fix the core issue. The semaphore just ensures we don't exhaust all blocking threads.

### 4. Increased Timeout

**Hypothesis**: Complex PDFs need more time.

**Implementation**: Increased from 30s to 120s.

**Result**: **FAILED** - The hang is indefinite, not a performance issue.

---

## Web Research Findings

### go-pdfium Solution (Subprocess Isolation)

The Go library `go-pdfium` solved this exact problem by spawning **separate worker processes**:

> "By design, pdfium has a lot of global state, and you can only run one instance of it in a process. go-pdfium overcomes this limitation by running workers in a separate process."

This suggests:
- PDFium's `FPDF_InitLibrary()` creates global state that persists
- Document operations may corrupt this global state
- The only reliable solution is process isolation

### pdfium-render Thread Safety

From the crate documentation:
- The `thread_safe` feature enables `Send + Sync` on types
- However, this is for **Rust's memory model**, not PDFium's internal C state
- PDFium itself uses global variables that are not thread-safe

### Alternative Libraries

| Library | Language | Approach | Performance |
|---------|----------|----------|-------------|
| **MuPDF** | C (with bindings) | Process-safe, no global state | 2-3x faster than PDFium |
| **pdf.js** | JavaScript | V8 isolates provide process safety | Slower, but stable |
| **Poppler** | C++ | Global state issues similar to PDFium | Not recommended |

---

## Questions for Further Research

1. **Does pdfium-render have a document cleanup/close method** that properly releases global state?

2. **Is there a way to call `FPDF_DestroyLibrary()` and `FPDF_InitLibrary()`** between documents?

3. **Would using `std::process::Command`** to spawn a child process for each PDF parse be viable?

4. **Are there Rust bindings for MuPDF** that would be more reliable?

5. **Could we use WebAssembly** with pdf.js for server-side parsing with proper isolation?

---

## Potential Solutions to Investigate

### A. Subprocess Isolation (go-pdfium approach)

Create a separate binary that handles PDF parsing, communicate via stdin/stdout or IPC:

```
Main Server Process
    │
    ├── PDF Request arrives
    │
    └── spawn child process ──► pdf-parser binary
                                    │
                                    ├── Initialize PDFium
                                    ├── Parse single PDF
                                    ├── Output JSON result
                                    └── Exit (clean shutdown)
```

**Pros**: Guaranteed clean state per document
**Cons**: Process spawn overhead (~50-100ms per parse)

### B. Worker Pool with Process Recycling

Maintain a pool of worker processes, recycle each after N documents:

```rust
struct WorkerPool {
    workers: Vec<Child>,
    max_docs_per_worker: usize,
    current_counts: Vec<usize>,
}
```

**Pros**: Amortizes spawn overhead
**Cons**: Complex to implement, may still have issues if N > 1

### C. Switch to MuPDF

Replace pdfium-render with mupdf bindings:

```rust
// mupdf-rs crate
use mupdf::Document;

fn parse_pdf(data: &[u8]) -> Result<ParsedPdf> {
    let doc = Document::from_bytes(data)?;
    // ... extract pages
}
```

**Pros**: Faster, no global state issues
**Cons**: Different API, potential licensing considerations (AGPL)

### D. pdf.js with Deno/Node subprocess

Use pdf.js in a JavaScript runtime for parsing:

```typescript
// pdf-worker.ts
import * as pdfjsLib from 'pdfjs-dist';

const data = await Deno.readAll(Deno.stdin);
const pdf = await pdfjsLib.getDocument({ data }).promise;
// ... extract and output JSON
```

**Pros**: Battle-tested library, isolation via V8
**Cons**: JavaScript overhead, additional runtime dependency

---

## Reproduction Steps

```bash
# 1. Build and start server
cd apps/amnesia-server
cargo build --release
./target/release/amnesia-server

# 2. Upload first PDF (should work)
curl -X POST "http://localhost:3000/pdf/test.pdf/upload" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"/path/to/any.pdf"
# Returns: {"filename":"test.pdf","page_count":N,...}

# 3. Upload second PDF (will hang)
curl -X POST "http://localhost:3000/pdf/test2.pdf/upload" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"/path/to/another.pdf"
# Hangs for 120 seconds, then times out

# 4. Restart server, repeat - same behavior
```

---

## Success Criteria for Solution

1. **Reliability**: Parse 100 PDFs sequentially without failure
2. **Performance**: First page visible within 2 seconds for <10MB PDFs
3. **Concurrency**: Support at least 4 simultaneous PDF uploads
4. **Memory**: No memory leaks over extended operation
5. **Simplicity**: Minimal architectural complexity

---

## Additional Research Findings

### MuPDF as Alternative

The [`mupdf` crate](https://crates.io/crates/mupdf) (v0.5.0) provides safe Rust bindings to MuPDF:
- **License**: AGPL-3.0 (important consideration)
- **Downloads**: 31,531/month, 169,085 all-time
- **Last Updated**: ~8 months ago
- **Repository**: [messense/mupdf-rs](https://github.com/messense/mupdf-rs)

MuPDF is reportedly 2-3x faster than PDFium and doesn't have global state issues.

### pdf_oxide - New High-Performance Option

[`pdf_oxide`](https://docs.rs/crate/pdf_oxide/latest) claims 47.9x faster PDF text extraction:
- Benchmarks: 103 PDFs in 5.43 seconds vs 259.94 seconds for PyMuPDF4LLM
- Worth investigating for text extraction use cases

### PDFium Document Lifecycle (from official docs)

Per [PDFium documentation](https://pdfium.googlesource.com/pdfium/+/HEAD/docs/getting-started.md):
- You **don't need to reinitialize** the library between documents
- Use `FPDF_CloseDocument()` to close one document, then `FPDF_LoadDocument()` for the next
- Only call `FPDF_DestroyLibrary()` when completely finished

However, this doesn't match our observed behavior where the second document hangs.

### Tokio Subprocess Pattern

[Tokio's process module](https://docs.rs/tokio/latest/tokio/process/index.html) provides async subprocess management:

```rust
use tokio::process::Command;
use tokio::io::{AsyncWriteExt, AsyncBufReadExt, BufReader};

async fn parse_pdf_subprocess(data: &[u8]) -> Result<ParsedPdf, Error> {
    let mut child = Command::new("./pdf-parser")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)  // Clean up zombie processes
        .spawn()?;

    // Write PDF data to stdin
    child.stdin.take().unwrap().write_all(data).await?;

    // Read JSON result from stdout
    let stdout = child.stdout.take().unwrap();
    let result: ParsedPdf = serde_json::from_reader(stdout)?;

    child.wait().await?;
    Ok(result)
}
```

### Worker Pool Crates

- [`workerpool`](https://docs.rs/workerpool) - Maintains stdin/stdout state for subprocess pools
- [`workpool`](https://docs.rs/workpool/latest/workpool/) - Parallel processing with worker/reducer pattern

---

## Appendix: Server Logs During Hang

```
2026-01-06T07:29:32.726Z INFO  amnesia_server: Starting Los Libros Server v0.1.0
2026-01-06T07:29:33.157Z INFO  amnesia_server: Los Libros Server listening on 0.0.0.0:3000

# First PDF - Success
2026-01-06T07:29:48.153Z WARN  routes::pdf: PDF 'Tao Fourier' not found in cache
2026-01-06T07:29:48.183Z INFO  routes::pdf: PDF uploaded: 'Tao Fourier' with 5 pages

# Second PDF - Hangs (no log output for 120 seconds)
2026-01-06T07:30:15.XXX WARN  routes::pdf: PDF 'Bears' not found in cache
# ... silence ...
# Eventually: ERROR: PDF parsing timed out after 120 seconds
```

The complete absence of log output during the hang indicates the blocking thread is stuck inside pdfium-render or libpdfium code, never returning to Rust code that could log progress.

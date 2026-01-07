# My Research Findings: PDFium Hang Issue

## Executive Summary

The issue appears to be related to **how pdfium-render's internal mutex interacts with tokio's spawn_blocking thread pool**, combined with PDFium's inherent thread-safety limitations.

---

## Key Findings

### 1. pdfium-render Thread Safety Architecture

**Source**: [pdfium-render README](https://github.com/ajrcarey/pdfium-render)

> "pdfium-render achieves thread safety by locking access to Pdfium behind a mutex; each thread must acquire exclusive access to this mutex in order to make any call to Pdfium. This has the effect of sequencing all calls to Pdfium as if they were single-threaded."

**Implication**: All PDFium operations are serialized through a single mutex, regardless of which thread they run on.

### 2. Official Axum Example Pattern

**Source**: [axum_once_cell.rs example](https://github.com/ajrcarey/pdfium-render/blob/master/examples/axum_once_cell.rs)

The official example uses:
```rust
static PDFIUM: OnceCell<Mutex<Pdfium>> = OnceCell::const_new();
```

Key patterns:
- Wrap Pdfium in an **explicit** `Mutex`
- Use **scoped access** to drop the mutex guard before returning
- Does NOT use `spawn_blocking`

**Our implementation differs**: We use `thread_local!` and `spawn_blocking`, which may interact poorly with pdfium-render's internal mutex.

### 3. PDFium Is NOT Thread-Safe

**Source**: [PDFium thread safety discussion](https://groups.google.com/g/pdfium/c/HeZSsM_KEUk)

> "PDFium currently is not thread safe."
> "Pdfium is not thread safe and uses global variables, hence no parallel call to pdfium is safe."

**PDFium developers explicitly recommend**:
> "If you are trying to render multiple documents, you can just run multiple PDFium processes instead. That's what we do for PDFium's corpus tests."

### 4. tokio::spawn_blocking + Mutex Deadlock Risk

**Source**: [Turso blog on Tokio deadlocks](https://turso.tech/blog/how-to-deadlock-tokio-application-in-rust-with-just-a-single-mutex)

> "If Tokio suspends your task at an .await while the task is holding the lock, some other task may be scheduled to run on the same thread, and this other task may also try to lock that mutex, which would result in a deadlock."

**Specific spawn_blocking risk**:
> "If your spawn_blocking task cannot complete until some other spawn_blocking task completes, then this can cause a deadlock given enough concurrency."

### 5. Relevant Closed Issues

**[Issue #225](https://github.com/ajrcarey/pdfium-render/issues/225)**: "Pages iteration hangs indefinitely on specific PDFs"
- Root cause: Memory leak **in Pdfium itself** (not pdfium-render)
- Testing with `FPDF_LoadPage()` directly produced the same hang
- Resolution: Report upstream to Chromium/PDFium

**[Issue #233](https://github.com/ajrcarey/pdfium-render/issues/233)**: "How can I manipulate multiple PDF documents at the same time?"
- Confirmed: Multiple documents CAN be opened from one Pdfium instance
- Lifetime constraints are intentional for memory safety

**[Issue #214](https://github.com/ajrcarey/pdfium-render/issues/214)**: "Many calls to PdfPageText::search() hangs process"
- Root cause: Empty strings passed to search()
- Fixed in library with defensive guards

### 6. PDFium Memory Leak When Rendering

**Source**: [PDFium bug #669](https://groups.google.com/g/pdfium-bugs/c/KO4Id_s4w-c)

> "Memory is only released when the document is released, not before. This leak also only appears when rendering pages."
> "Whenever FPDF_RenderPageBitmap/_Start is used, memory is allocated and not released when the bitmap is destroyed and the page closed."

**Suggested workaround**: "Can't you just call FPDF_CloseDocument() and reopen it again to simulate purging the cache?"

### 7. `sync` Feature Warning

**Source**: [pdfium-render docs](https://docs.rs/pdfium-render/latest/pdfium_render/)

> "The `sync` feature provides implementations of the Send and Sync traits for the Pdfium and PdfDocument structs... although those instances are not guaranteed to be thread-safe. **Use entirely at your own risk.**"

---

## Alternative Libraries Discovered

### Pure Rust Options (No FFI Issues)

| Library | Downloads/month | Text Extraction | Page Dimensions | Notes |
|---------|-----------------|-----------------|-----------------|-------|
| [pdf_oxide](https://crates.io/crates/pdf_oxide) | New | Yes | Unknown | Claims 47.9x faster than PyMuPDF4LLM |
| [lopdf](https://github.com/J-F-Liu/lopdf) | 817K | Limited | Yes | Low-level manipulation |
| [pdf-extract](https://github.com/jrmuizel/pdf-extract) | Moderate | Yes | No | Simple text extraction |
| [pdf-rs](https://github.com/pdf-rs/pdf) | Moderate | Yes | Yes | Pure Rust parser |

### MuPDF (Different C Library)

**Source**: [mupdf crate](https://crates.io/crates/mupdf)

- Version: 0.5.0
- Downloads: 31K/month
- **License: AGPL-3.0** (important consideration)
- Reportedly 2-3x faster than PDFium
- No known global state issues

### go-pdfium Subprocess Pattern

**Source**: [go-pdfium README](https://github.com/klippa-app/go-pdfium)

> "By design, pdfium has a lot of global state, and you can only run one instance of it in a process. go-pdfium overcomes this limitation by running workers in a separate process."

---

## Potential Root Causes for Our Issue

### Hypothesis A: spawn_blocking Thread Pool Exhaustion

Our pattern:
1. Request 1 → spawn_blocking → Thread A → acquires pdfium-render mutex → works
2. Request 2 → spawn_blocking → Thread B → tries to acquire mutex → **blocks**
3. If Thread A's mutex release doesn't propagate correctly to Thread B...

**Problem**: pdfium-render's mutex might be tied to Thread A's thread-local state, and Thread B can never acquire it.

### Hypothesis B: PDFium Internal Global State Corruption

Based on Issue #225 findings:
- PDFium itself (not pdfium-render) can have bugs that cause hangs
- Memory leaks in PDFium can consume all RAM and cause hangs
- Some PDFs trigger this, but ANY PDF might trigger it under certain conditions

### Hypothesis C: thread_local! + Mutex Interaction

Our `thread_local!` pattern creates a separate Pdfium instance per thread. But if pdfium-render's `thread_safe` feature uses a **global** mutex, we might have:
- Thread A: Has Pdfium instance A, uses global mutex
- Thread B: Tries to create Pdfium instance B, blocked on global mutex that Thread A holds

---

## Recommended Next Steps

1. **Remove `thread_local!`** - Use the official `OnceCell<Mutex<Pdfium>>` pattern from the axum example

2. **Don't use `spawn_blocking`** - Process PDFs on the main thread with explicit mutex guards (like the example)

3. **Test with minimal reproduction** - Create a simple axum server that just loads 2 PDFs sequentially to isolate the issue

4. **Consider subprocess isolation** - If the above doesn't work, the go-pdfium approach of separate processes may be necessary

5. **Evaluate pure Rust alternatives** - pdf_oxide or pdf-rs might avoid the entire FFI complexity

---

## Sources

- [pdfium-render GitHub](https://github.com/ajrcarey/pdfium-render)
- [PDFium Thread Safety Discussion](https://groups.google.com/g/pdfium/c/HeZSsM_KEUk)
- [Turso: How to Deadlock Tokio with a Single Mutex](https://turso.tech/blog/how-to-deadlock-tokio-application-in-rust-with-just-a-single-mutex)
- [Tokio: Shared State](https://tokio.rs/tokio/tutorial/shared-state)
- [go-pdfium README](https://github.com/klippa-app/go-pdfium)
- [mupdf crate](https://crates.io/crates/mupdf)
- [pdf_oxide crate](https://crates.io/crates/pdf_oxide)
- [PDFium Bug #669: Memory Leak](https://groups.google.com/g/pdfium-bugs/c/KO4Id_s4w-c)

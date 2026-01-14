# EPUB Migration Plan: MuPDF WASM Consolidation

## Executive Summary

Migrate EPUB rendering infrastructure from pub-rs to a unified MuPDF WASM-based architecture using a **hybrid approach**:
- **MuPDF**: EPUB parsing, text extraction, TOC, search, fixed-layout pixmap rendering
- **Shadow DOM**: Visual rendering for reflowable content (preserves current UX)

**Goals**: Full feature parity, fixed-layout EPUB support (new), ~1,500 lines code reduction

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        EPUB Document                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   MuPDF WASM (mupdf-worker.ts)                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐  │
│  │  Parse EPUB     │  │ Extract Content │  │ Render Pixmaps │  │
│  │  (ZIP/OPF/NCX)  │  │ (HTML/Text/TOC) │  │ (Fixed-layout) │  │
│  └─────────────────┘  └─────────────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┴─────────────────┐
            ▼                                   ▼
┌───────────────────────┐          ┌───────────────────────┐
│   Reflowable EPUB     │          │  Fixed-Layout EPUB    │
│  (Shadow DOM Render)  │          │  (Pixmap/Tile Render) │
│                       │          │                       │
│  ┌─────────────────┐  │          │  ┌─────────────────┐  │
│  │ Navigator       │  │          │  │ PDF Tile Engine │  │
│  │ (Paginated/     │  │          │  │ (reuse existing)│  │
│  │  Scrolled)      │  │          │  └─────────────────┘  │
│  └─────────────────┘  │          │                       │
│                       │          │  ┌─────────────────┐  │
│  ┌─────────────────┐  │          │  │ 3-Tier Cache    │  │
│  │ CSS Highlights  │  │          │  │ (L1/L2/L3)      │  │
│  └─────────────────┘  │          │  └─────────────────┘  │
└───────────────────────┘          └───────────────────────┘
```

---

## Implementation Stages

### Stage 1: MuPDF EPUB Bridge (Week 1)

**Files to Create:**
- `src/reader/renderer/epub/mupdf-epub-bridge.ts` - Bridge to MuPDF worker for EPUB operations
- `src/reader/renderer/epub/mupdf-epub-content-provider.ts` - ContentProvider implementation using MuPDF

**Files to Modify:**
- `src/reader/renderer/pdf/mupdf-worker.ts` - Add EPUB message types
- `src/reader/renderer/pdf/mupdf-bridge.ts` - Add EPUB methods

**Quality Gate:**
- [ ] Unit test: MuPDF can open EPUB and return metadata
- [ ] Unit test: Chapter HTML extraction works
- [ ] Unit test: TOC extraction matches current output
- Code review with `feature-dev:code-reviewer` agent

### Stage 2: Reflowable EPUB Integration (Week 2)

**Files to Modify:**
- `src/reader/shadow-dom-renderer.ts` - Swap ContentProvider to MuPDF-based
- `src/reader/renderer/hybrid-document-provider.ts` - Add EPUB format handling
- `src/reader/renderer/cfi-utils.ts` - Implement MuPDF-based CFI (or keep current if MuPDF lacks support)

**Quality Gate:**
- [ ] E2E test: Open reflowable EPUB, navigate chapters
- [ ] E2E test: Typography settings apply correctly
- [ ] E2E test: Theme changes work
- [ ] E2E test: Highlights can be created and persist
- Code review with `feature-dev:code-reviewer` agent

### Stage 3: Search Migration (Week 3)

**Files to Create:**
- `src/reader/renderer/epub/mupdf-epub-search.ts` - MuPDF-powered search

**Files to Modify:**
- `src/reader/search-index.ts` - Use MuPDF search instead of custom indexing

**Quality Gate:**
- [ ] Performance test: Search 800 pages <1000ms
- [ ] E2E test: Search results navigate correctly
- Code review with `feature-dev:code-reviewer` agent

### Stage 4: Fixed-Layout EPUB Support (Week 4-5) - NEW FEATURE

**Files to Create:**
- `src/reader/renderer/epub/fixed-layout-epub-renderer.ts` - Pixmap-based renderer (reuse PDF tile infrastructure)
- `src/reader/renderer/epub/epub-format-detector.ts` - Detect reflowable vs fixed-layout

**Files to Modify:**
- `src/reader/reader-view.ts` - Route fixed-layout EPUBs to pixmap renderer
- `src/reader/components/ServerReaderContainer.svelte` - Add fixed-layout mode support

**Quality Gate:**
- [ ] E2E test: Open fixed-layout EPUB (comic book)
- [ ] E2E test: Zoom/pan works like PDF
- [ ] Performance test: Tile render <50ms at 2x scale
- Code review with `feature-dev:code-reviewer` agent

### Stage 5: Cleanup & Polish (Week 6)

**Files to Delete:**
- `src/reader/renderer/renderer.ts` (legacy iframe-based, 3,764 lines)
- `src/reader/renderer/api-client.ts` (server-based, 150 lines)

**Dependencies to Remove:**
- `epub-cfi-resolver` from package.json

**Quality Gate:**
- [ ] Full regression test on all features
- [ ] Memory profiling: <50MB for 100 chapters
- [ ] Performance audit meets all benchmarks
- Code review with `feature-dev:code-reviewer` agent

---

## Critical Files Summary

| Action | File | Lines | Reason |
|--------|------|-------|--------|
| CREATE | `src/reader/renderer/epub/mupdf-epub-bridge.ts` | ~400 | MuPDF EPUB bridge |
| CREATE | `src/reader/renderer/epub/mupdf-epub-content-provider.ts` | ~300 | ContentProvider impl |
| CREATE | `src/reader/renderer/epub/fixed-layout-epub-renderer.ts` | ~600 | Fixed-layout support |
| CREATE | `src/reader/renderer/epub/epub-format-detector.ts` | ~100 | Format detection |
| CREATE | `src/reader/renderer/epub/mupdf-epub-search.ts` | ~200 | Search integration |
| MODIFY | `src/reader/renderer/pdf/mupdf-worker.ts` | +200 | EPUB messages |
| MODIFY | `src/reader/shadow-dom-renderer.ts` | +100 | New provider |
| MODIFY | `src/reader/renderer/hybrid-document-provider.ts` | +150 | EPUB handling |
| DELETE | `src/reader/renderer/renderer.ts` | -3764 | Legacy code |
| DELETE | `src/reader/renderer/api-client.ts` | -150 | Unused |

**Net change**: ~1,600 lines added, ~3,914 lines removed = **-2,314 lines**

---

## Success Criteria

- [ ] All 7 themes render correctly
- [ ] All typography controls functional
- [ ] Highlights work with CFI anchoring
- [ ] TOC navigation accurate
- [ ] Search returns correct results
- [ ] Per-book settings override globals
- [ ] Fixed-layout EPUBs render as tiles
- [ ] Open EPUB <500ms
- [ ] Page turn <16ms (60 FPS)
- [ ] Memory <50MB for 100 chapters
- [ ] Legacy code deleted (~3,900 lines)
- [ ] epub-cfi-resolver dependency removed

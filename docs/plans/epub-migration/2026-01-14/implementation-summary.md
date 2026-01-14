# EPUB Migration Implementation Summary

**Date**: 2026-01-14
**Version**: 0.5.1
**Status**: Stages 1-4 Complete, Stage 5 Deferred

---

## Executive Summary

Implemented a hybrid MuPDF WASM-based EPUB architecture that provides:
- **MuPDF backend** for EPUB parsing, text extraction, TOC, and search
- **Shadow DOM rendering** for reflowable content (preserves current UX)
- **Fixed-layout EPUB support** (NEW) for comics, manga, children's books
- **Feature flag** (`useMuPDFEpub`) for gradual rollout

---

## Completed Work

### Stage 1: MuPDF EPUB Bridge

**Files Created:**
- `src/reader/renderer/epub/mupdf-epub-bridge.ts` (~600 lines)
  - Bridge to MuPDF worker for EPUB operations
  - Document lifecycle (open, close, cache)
  - Chapter HTML/text extraction
  - Search via MuPDF native search
  - Fixed-layout detection and rendering

- `src/reader/renderer/epub/mupdf-epub-content-provider.ts` (~300 lines)
  - ContentProvider implementation using MuPDF
  - Compatible with existing Shadow DOM renderer

### Stage 2: Reflowable EPUB Integration

**Files Modified:**
- `src/reader/components/ServerReaderContainer.svelte`
  - Added conditional provider selection via feature flag
  - Cleanup in `onDestroy` for EPUB provider

- `src/reader/renderer/pdf/feature-flags.ts`
  - Added `useMuPDFEpub: 'auto' | boolean` flag

### Stage 3: Search Migration

**Files Created:**
- `src/reader/renderer/epub/mupdf-epub-search.ts` (~330 lines)
  - `MuPDFEpubSearch` class with search/searchGrouped methods
  - `SearchProvider` interface for unified API
  - `createHybridSearchProvider()` factory with fallback support
  - Chapter-aware results with context

### Stage 4: Fixed-Layout EPUB Support (NEW FEATURE)

**Files Created:**
- `src/reader/renderer/epub/epub-format-detector.ts` (~245 lines)
  - `EpubFormatDetector` class
  - Multi-method detection:
    - MuPDF native detection (`isFixedLayout` property)
    - Viewport meta tags
    - CSS fixed dimensions (order-independent parsing)
    - SVG viewBox detection
    - Image-only content heuristics
  - `isFixedLayoutEpub()` and `getEpubFormatInfo()` helpers

- `src/reader/renderer/epub/fixed-layout-epub-renderer.ts` (~420 lines)
  - Canvas-based pixmap renderer
  - Scale/zoom support (0.25x - 8x)
  - Event emission with proper cleanup
  - Safe HTML handling via DOMParser (XSS prevention)
  - GPU resource cleanup in destroy()

**Files Modified:**
- `src/reader/renderer/epub/mupdf-epub-bridge.ts`
  - Added `pageDimensions?: FixedLayoutPageDimensions` to `ParsedEpub`
  - Added `pageCount?: number` to `FixedLayoutPageDimensions`

**Code Review Fixes Applied:**
1. Memory leak in `destroy()` - canvas cleanup before removal
2. Memory leak in `renderHtmlToCanvas()` - proper DOM cleanup on error
3. CSS parsing - order-independent dimension extraction
4. Event emission - clone listeners before iteration
5. XSS prevention - use DOMParser instead of innerHTML

### Export Updates

**Files Modified:**
- `src/reader/renderer/epub/index.ts` - Added all Stage 3 & 4 exports
- `src/reader/renderer/index.ts` - Added all Stage 3 & 4 exports

---

## Deferred Work (Stage 5)

### Legacy Code Cleanup

The following cleanup items are **deferred** because the legacy code is still actively used:

| Component | Lines | Status | Blocking Dependencies |
|-----------|-------|--------|----------------------|
| `renderer.ts` | 3,764 | **Still used** | auto-scroll.ts, reader-adapter.ts, index.ts exports |
| `api-client.ts` | 776 | **Still used** | hybrid-document-provider.ts, hybrid-provider.ts, reader-adapter.ts, sync-manager.ts |
| `epub-cfi-resolver` | N/A | **Still used** | cfi-utils.ts for CFI generation/resolution |

### Why Deferred

The MuPDF EPUB integration is implemented as a **parallel/hybrid approach**:
- Feature flag enables conditional provider selection
- Legacy code serves as fallback and remains primary implementation
- Full replacement requires additional work:
  1. Migrate all `ApiClient` usages to new providers
  2. Implement MuPDF-based CFI generation (replace epub-cfi-resolver)
  3. Update reader-adapter to use new providers

### Future Cleanup Tasks

1. **Phase 1: ApiClient Migration**
   - Update `hybrid-document-provider.ts` to not require ApiClient
   - Update `hybrid-provider.ts` to use MuPDF provider
   - Update `sync-manager.ts` for new provider interface

2. **Phase 2: CFI Migration**
   - Implement MuPDF-based CFI generation in `cfi-utils.ts`
   - Remove `epub-cfi-resolver` dependency
   - Test CFI compatibility with existing highlights

3. **Phase 3: Legacy Removal**
   - Delete `renderer.ts` (3,764 lines)
   - Delete `api-client.ts` (776 lines)
   - Update all imports and exports

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     EPUB Rendering System                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────┐    ┌─────────────────────┐         │
│  │   Feature Flag      │    │   Format Detection   │         │
│  │   useMuPDFEpub      │───►│   epub-format-       │         │
│  │   'auto' | boolean  │    │   detector.ts        │         │
│  └─────────────────────┘    └──────────┬──────────┘         │
│                                        │                     │
│            ┌───────────────────────────┼───────────────────┐ │
│            │                           │                   │ │
│            ▼                           ▼                   │ │
│  ┌─────────────────────┐    ┌─────────────────────┐       │ │
│  │   MuPDF Provider    │    │   Legacy Provider   │       │ │
│  │   (NEW)             │    │   (Fallback)        │       │ │
│  │                     │    │                     │       │ │
│  │ mupdf-epub-bridge   │    │ WasmBookProvider    │       │ │
│  │ mupdf-epub-content- │    │ renderer.ts         │       │ │
│  │   provider          │    │ api-client.ts       │       │ │
│  └──────────┬──────────┘    └─────────────────────┘       │ │
│             │                                              │ │
│             ▼                                              │ │
│  ┌─────────────────────────────────────────────────────┐  │ │
│  │              Rendering Output                        │  │ │
│  ├─────────────────────┬───────────────────────────────┤  │ │
│  │   Reflowable EPUB   │   Fixed-Layout EPUB           │  │ │
│  │   Shadow DOM +      │   Canvas + Pixmap             │  │ │
│  │   CSS Multi-Column  │   (fixed-layout-epub-         │  │ │
│  │                     │    renderer.ts)               │  │ │
│  └─────────────────────┴───────────────────────────────┘  │ │
│                                                            │ │
└────────────────────────────────────────────────────────────┘ │
```

---

## File Summary

| Action | File | Lines |
|--------|------|-------|
| CREATE | `epub/mupdf-epub-bridge.ts` | ~600 |
| CREATE | `epub/mupdf-epub-content-provider.ts` | ~300 |
| CREATE | `epub/mupdf-epub-search.ts` | ~330 |
| CREATE | `epub/epub-format-detector.ts` | ~245 |
| CREATE | `epub/fixed-layout-epub-renderer.ts` | ~420 |
| MODIFY | `epub/index.ts` | +30 |
| MODIFY | `renderer/index.ts` | +25 |
| MODIFY | `pdf/feature-flags.ts` | +5 |
| MODIFY | `components/ServerReaderContainer.svelte` | +50 |

**Total Lines Added**: ~2,005
**Legacy Lines (Deferred Deletion)**: ~4,540

---

## Testing Checklist

### Manual Testing Protocol

1. **Open EPUB via Amnesia**
   - Navigate to book note
   - Use "Amnesia: Open book" command
   - Verify leaf type is `amnesia-reader`

2. **Test with Feature Flag Enabled**
   ```javascript
   // Via MCP console
   window.Amnesia.settings.featureFlags.useMuPDFEpub = true;
   ```

3. **Verify Features**
   - [ ] EPUB opens successfully
   - [ ] TOC navigation works
   - [ ] Search returns results
   - [ ] Typography settings apply
   - [ ] Theme changes work
   - [ ] Highlights can be created

4. **Test Fixed-Layout Detection**
   - Open a comic book EPUB
   - Verify `isFixedLayoutEpub()` returns true
   - Check canvas-based rendering activates

---

## Risk Assessment

| Risk | Mitigation | Status |
|------|------------|--------|
| MuPDF EPUB parsing differs from current | Compare HTML output, normalization | Monitored |
| CFI generation compatibility | Keep epub-cfi-resolver as fallback | Active |
| Fixed-layout detection accuracy | Multi-method detection with confidence | Implemented |
| Performance regression | Feature flag for A/B testing | Available |

---

## Next Steps

1. **Enable Feature Flag** - Test with `useMuPDFEpub: true` in production
2. **Monitor Telemetry** - Track EPUB load times and search performance
3. **User Feedback** - Collect issues with MuPDF provider
4. **Plan Phase 2** - ApiClient migration for full legacy removal

---

## References

- Plan file: `/docs/plans/eager-orbiting-mango.md`
- Spec file: `/docs/specifications/epub-renderer-spec.json` (to be created)
- CLAUDE.md: Updated with "EPUB MuPDF Integration" section

# CLAUDE.md - Amnesia Development Guide

> **Purpose**: This document provides Claude Code with the essential context to work effectively on the Amnesia codebase. It captures architectural decisions, critical patterns, common pitfalls, and debugging workflows.

## Project Overview

**Amnesia** is an Obsidian plugin ecosystem for reading EPUBs and PDFs. It consists of:

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Plugin** | TypeScript + Svelte | Obsidian integration, UI, rendering |
| **Server** | Rust + Axum | Document processing, sync, OPDS feeds |
| **Shared Types** | TypeScript | Cross-ecosystem type consistency |

**Monorepo Structure**: pnpm workspaces at `apps/amnesia`, `apps/amnesia-server`, `packages/shared-types`

---

## Axiological Alignment

This project adheres to the **Axiological Foundations of Software Engineering**. Key principles guiding development:

### Cognitive Ergonomics
- Prefer simple, explicit solutions over clever abstractions
- Automate mechanical tasks (builds, deploys, tests)
- Developer experience is a first-class metric

### Quantified Quality
- Quality floors via performance budgets and resource ceilings
- Instrumentation before deployment (telemetry, metrics)
- Planner-Executor Separation: LLMs may propose, deterministic code executes

### Principled Disconnection (Symploké)
- Bounded contexts: Reader, Sync, Calibre, Library are separate domains
- Format unification via `DocumentRenderer` interface, not monolithic code
- Each service owns its state and exposes clear APIs

### Lifecycle Budgeting
- Budget for conception, validation, release, AND maintenance
- Explicit deprecation paths for features
- No infinite polish—ship what meets quality floors

### Governed Execution
- Capability-based API security (`read-state`, `write-annotations`, etc.)
- Auditable provenance for state changes
- Immutable releases via git tags

---

## Directory Structure

```
amnesia/
├── apps/
│   ├── amnesia/                    # Obsidian plugin (TypeScript/Svelte)
│   │   ├── src/
│   │   │   ├── main.ts             # Plugin entry, service initialization
│   │   │   ├── api/                # Public API v1.0 (facades, events, security)
│   │   │   ├── reader/             # Document rendering
│   │   │   │   ├── navigator/      # EPUB pagination (CSS multi-column)
│   │   │   │   ├── renderer/       # DocumentRenderer interface
│   │   │   │   │   ├── pdf/        # PDF rendering (MuPDF WASM)
│   │   │   │   │   └── epub/       # EPUB rendering (Shadow DOM)
│   │   │   │   └── components/     # Svelte UI components
│   │   │   ├── library/            # Book discovery, metadata
│   │   │   ├── highlights/         # 12 semantic annotation types
│   │   │   ├── calibre/            # Calibre sync (bidirectional)
│   │   │   ├── sync/               # Unified sync engine (adapters)
│   │   │   ├── hud/                # Heads-Up Display (reading stats)
│   │   │   ├── opds/               # OPDS catalog browser
│   │   │   ├── offline/            # Offline mode, caching
│   │   │   ├── settings/           # 5-tab settings UI
│   │   │   ├── templates/          # Nunjucks note generation
│   │   │   ├── test/               # Vitest + MCP harness
│   │   │   └── wasm/               # Custom WASM builds
│   │   │       └── mupdf/          # MuPDF WASM (SIMD+LTO optimized)
│   │   ├── esbuild.config.mjs      # Build config
│   │   └── vitest.config.ts        # Test config
│   │
│   └── amnesia-server/             # Rust backend (Axum)
│       ├── src/
│       │   ├── library/            # Book discovery
│       │   ├── pdf/                # MuPDF parsing
│       │   ├── opds/               # OPDS feed generation
│       │   ├── bibliography/       # Citation formatting
│       │   └── main.rs             # Server entry
│       └── Cargo.toml
│
├── packages/
│   └── shared-types/               # @amnesia/shared-types
│       └── src/
│           ├── annotations.ts      # 12 semantic types
│           ├── highlight.ts        # Highlight union types
│           └── book.ts             # Book metadata
│
├── pnpm-workspace.yaml
└── docker-compose.yml              # MinIO, Postgres for dev
```

---

## Critical Architecture Patterns

### 1. Redux-like Store Pattern

**Location**: `src/helpers/store.ts`

All major features use this pattern for predictable state management:

```typescript
// Reducer function (pure, no side effects)
function libraryReducer(state: LibraryState, action: LibraryAction): LibraryState {
  switch (action.type) {
    case 'LOAD_BOOKS': return { ...state, books: action.books };
    case 'ADD_BOOK': return { ...state, books: [...state.books, action.book] };
    // Always return new object, never mutate
  }
}

// Store wraps Svelte writable contract
const store = new Store<LibraryState, LibraryAction>(initialState, libraryReducer);
store.dispatch({ type: 'ADD_BOOK', book });
```

**Used By**: Library, Highlights, HUD, Settings, Sync

### 2. Document Abstraction

**Location**: `src/reader/renderer/document-renderer.ts`

Format-agnostic interface enabling unified UI code:

```typescript
interface DocumentRenderer {
  parse(buffer: ArrayBuffer): Promise<ParsedDocument>;
  render(target: HTMLElement): void;
  navigate(target: DocumentNavigationTarget): Promise<void>;
  search(query: string): SearchResult[];
  createHighlight(selection: Selection): Highlight;
}
```

**Implementations**: `EpubRenderer`, `PdfRenderer`

### 3. Adapter Pattern for Sync

**Location**: `src/sync/`

Unified sync engine with pluggable backends:

```
UnifiedSyncEngine
    ├── CalibreAdapter (Calibre Content Server)
    ├── ServerAdapter (amnesia-server)
    └── FileAdapter (local file system)
```

Each adapter implements the same interface, enabling multi-source sync with conflict resolution.

### 4. Capability-Based API Security

**Location**: `src/api/security/`

External plugins access Amnesia via capabilities:

```typescript
type Capability = 'read-state' | 'write-annotations' | 'write-bookmarks' | 'write-library' | 'admin';

// API checks capability before allowing operation
if (!hasCapability(caps, 'write-annotations')) {
  throw new PermissionError('Missing capability: write-annotations');
}
```

---

## PDF Rendering Pipeline

This is the most performance-critical code path. Understanding it is essential for any PDF-related work.

### Pipeline Overview

```
User Input (wheel, pinch, keyboard)
    ↓
Camera Update (immediate GPU transform)
    ↓
Debounce (32ms scroll, 150ms zoom)
    ↓
Camera Snapshot ← CRITICAL: Capture at debounce time, NOT render time
    ↓
Visibility Calculation (which tiles are visible)
    ↓
Tile Queue (priority: critical → high → medium → low)
    ↓
Render Coordinator (deduplication, concurrency limits)
    ↓
MuPDF Worker Pool (WASM rendering, max 4 workers)
    ↓
3-Tier Cache (L1 memory → L2 IndexedDB → L3 cold)
    ↓
Canvas Display (GPU-accelerated composite)
```

### Key Files

| File | Purpose |
|------|---------|
| `pdf-infinite-canvas.ts` | Main canvas with pan/zoom, camera management |
| `render-coordinator.ts` | Request deduplication, concurrency control |
| `scroll-strategy.ts` | Velocity-based prefetching, speed zones |
| `tile-cache-manager.ts` | 3-tier cache with LRU eviction |
| `tile-render-engine.ts` | Tile rendering orchestration |
| `mupdf-worker.ts` | Web Worker for MuPDF WASM |
| `document-worker.ts` | Unified document worker (PDF + EPUB) |
| `src/wasm/mupdf/` | Custom MuPDF WASM build (SIMD+LTO) |

### Camera Snapshot Pattern

**This is the most important optimization pattern in the codebase.**

```typescript
// WRONG: Using current camera in debounced render
scheduleRender() {
  debounce(() => {
    const visibleTiles = this.calculateVisible(this.camera); // Camera moved!
  }, 32);
}

// CORRECT: Snapshot camera at schedule time
scheduleRender() {
  const cameraSnapshot = { ...this.camera }; // Capture NOW
  debounce(() => {
    const visibleTiles = this.calculateVisible(cameraSnapshot); // Use snapshot
  }, 32);
}
```

**Why**: During fast scroll, camera moves 100+ pixels during the 32ms debounce. Using current camera position causes "0 visible tiles" because you're calculating visibility for a position the user scrolled past.

### Velocity-Based Prefetching

| Zone | Velocity (px/s) | Lookahead | Quality | Use Case |
|------|-----------------|-----------|---------|----------|
| stationary | <50 | 1.0x viewport | 100% | Reading |
| slow | 50-200 | 2.0x viewport | 90% | Browsing |
| medium | 200-500 | 3.0x viewport | 75% | Scrolling |
| fast | 500-1000 | 5.0x viewport | 50% | Fast flick |
| veryFast | >1000 | 8.0x viewport | 35% | Aggressive fling |

### Tiling Strategy

```
Zoom Level    Strategy         Rationale
< 1.5x        Full page        Few pixels, fast render
1.5x - 4x     Conditional      Depends on page size
> 4x          Always tile      Visible area is tiny fraction of page
```

Tile size: 256×256 CSS pixels, scaled by `zoom × pixelRatio` for crisp rendering.

### Custom MuPDF WASM Build

The plugin uses a custom MuPDF WASM build with SIMD and LTO optimizations for faster PDF rendering.

#### Build Location

```
build/mupdf-wasm/mupdf/platform/wasm/tools/build-amnesia.sh
```

#### Performance Metrics

| Metric | Custom Build | npm Package | Improvement |
|--------|-------------|-------------|-------------|
| WASM size (uncompressed) | 8.4 MB | 9.5 MB | **12% smaller** |
| WASM size (gzipped) | 2.9 MB | 4.3 MB | **33% smaller** |
| Core render time | ~8ms | ~15ms | **1.3-2.5x faster** |
| Worker init | 142ms | 400-800ms | **60-75% faster** |

#### Build Configuration

```bash
# Feature flags (Makefile)
FEATURES="brotli=no mujs=no extract=no xps=no html=no"

# Compile defines
DEFINES="-DTOFU -DTOFU_CJK -DFZ_ENABLE_HYPHEN=0"

# Performance flags
PERF_FLAGS="-msimd128 -flto"
```

**Features kept:**
- `FZ_ENABLE_PDF=1` - Core PDF rendering
- `FZ_ENABLE_EPUB=1` - EPUB support (engine consolidation)
- `FZ_ENABLE_SVG=1` - SVG for EPUB3
- `FZ_ENABLE_IMG=1` - Image handling

**Features disabled:**
- XPS, CBZ, HTML (standalone), JavaScript forms
- MOBI, FB2, TXT, Office formats
- CJK fonts (saves 3.4MB DroidSansFallback)
- OCR/DOCX/ODT output

#### Rebuilding the WASM

```bash
# Prerequisites
# 1. Emscripten 3.1.50+
# 2. wasm-opt (binaryen)

cd build/mupdf-wasm/mupdf/platform/wasm/tools
./build-amnesia.sh

# Output files in dist/:
# - mupdf-wasm.wasm (8.4 MB)
# - mupdf-wasm.js
# - mupdf.js
# - mupdf.d.ts
```

#### Integration in esbuild

The custom WASM requires matching JavaScript glue code. The esbuild config uses an alias to redirect the `mupdf` import:

```javascript
// esbuild.config.mjs
alias: fs.existsSync("src/wasm/mupdf/mupdf.js") ? {
  "mupdf": "./src/wasm/mupdf/mupdf.js",
} : {},
```

**Critical**: The JavaScript glue (`mupdf.js`) must match the WASM build. Using npm's JavaScript with a custom WASM will cause silent worker initialization failure.

#### Files

| File | Purpose |
|------|---------|
| `src/wasm/mupdf/mupdf-wasm-simd.wasm` | Custom WASM binary |
| `src/wasm/mupdf/mupdf.js` | JavaScript API (matches WASM) |
| `src/wasm/mupdf/mupdf-wasm.js` | Emscripten glue code |
| `src/wasm/mupdf/mupdf.d.ts` | TypeScript definitions |

#### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Worker READY timeout | JS/WASM mismatch | Ensure esbuild alias points to custom mupdf.js |
| WASM compile error | Missing SIMD support | Check browser supports WebAssembly SIMD |
| "locateFile called" error | WASM binary not sent | Verify INIT_WASM message includes wasmBinary |
| Silent worker hang | Exception in instantiateWasm | Check console for WASM instantiation errors |

---

## EPUB Pagination

### The `scrollWidth` Trap

**Problem**: `scrollWidth` returns container width, NOT content extent.

```typescript
// WRONG: This returns container width, not actual content width
const columns = Math.ceil(element.scrollWidth / columnWidth);
// When container is 14000px with column-width: 586px,
// scrollWidth returns 14000px, NOT actual content extent
```

**Solution**: Measure actual content positions:

```typescript
// CORRECT: Count unique column positions of rendered elements
function measureActualColumnCount(chapterEl: HTMLElement, containerWidth: number): number {
  const elements = chapterEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
  const chapterRect = chapterEl.getBoundingClientRect();
  const columnPositions = new Set<number>();

  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    const relativeLeft = rect.left - chapterRect.left;
    const columnIndex = Math.round(relativeLeft / containerWidth);
    columnPositions.add(columnIndex);
  }

  return Math.max(1, columnPositions.size);
}
```

### Two-Phase Column Measurement

**Phase 1**: Let browser flow content naturally:
```typescript
chapterEl.style.columnWidth = '586px';
chapterEl.style.width = '10000px'; // Large buffer
```

**Phase 2**: After DOM insertion, measure and lock:
```typescript
requestAnimationFrame(() => {
  const actualColumns = measureActualColumnCount(chapterEl, containerWidth);
  chapterEl.style.columnWidth = '';  // Remove
  chapterEl.style.columnCount = String(actualColumns);  // Lock
  chapterEl.style.width = calculateWidth(actualColumns);
});
```

### Column Width Formula

For N columns with gap between them:
```
width = N × columnWidth + (N - 1) × gap
Example: 5 columns, 586px width, 60px gap
width = 5 × 586 + 4 × 60 = 3170px
```

---

## EPUB MuPDF Integration (v0.5.1)

The EPUB rendering system uses a hybrid approach where MuPDF WASM handles parsing/extraction while Shadow DOM handles visual rendering for reflowable content.

### Architecture

```
EPUB File (ArrayBuffer)
    ↓
MuPDF EPUB Bridge (mupdf-epub-bridge.ts)
    ↓
┌─────────────────────────────────────────┐
│  MuPDF Operations:                      │
│  - Parse EPUB structure                 │
│  - Extract metadata, TOC, spine         │
│  - Get chapter HTML/text                │
│  - Search full text                     │
│  - Detect fixed-layout vs reflowable    │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│  Rendering (based on format):           │
│  ├─ Reflowable: Shadow DOM + CSS cols   │
│  └─ Fixed-layout: Canvas pixmap tiles   │
└─────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `epub/mupdf-epub-bridge.ts` | Bridge to MuPDF worker for EPUB operations |
| `epub/mupdf-epub-content-provider.ts` | ContentProvider using MuPDF |
| `epub/mupdf-epub-search.ts` | MuPDF-powered full-text search |
| `epub/epub-format-detector.ts` | Detect reflowable vs fixed-layout |
| `epub/fixed-layout-epub-renderer.ts` | Canvas renderer for comics/manga |

### Feature Flag

The MuPDF EPUB integration is controlled by the `useMuPDFEpub` feature flag:

```typescript
// In feature-flags.ts
useMuPDFEpub: 'auto' | boolean  // 'auto' uses MuPDF when available
```

When enabled:
- EPUB parsing uses MuPDF WASM instead of legacy server/iframe approach
- Search uses native MuPDF text search (faster, no index building)
- Fixed-layout EPUBs render as pixmaps like PDFs

### Fixed-Layout Detection

Fixed-layout EPUBs (comics, manga, children's books) are detected via:
1. OPF metadata: `rendition:layout="pre-paginated"`
2. Viewport meta tags with fixed dimensions
3. CSS with fixed width/height on body
4. SVG root with viewBox
5. Image-only content heuristics

### Integration Points

```typescript
// ServerReaderContainer.svelte - conditional provider selection
const useMuPDF = featureFlags.useMuPDFEpub === true ||
  (featureFlags.useMuPDFEpub === 'auto' && typeof MuPDFEpubContentProvider !== 'undefined');

if (useMuPDF && format === 'epub') {
  provider = await getSharedMuPDFEpubContentProvider();
} else {
  provider = new WasmBookProvider(); // Legacy fallback
}
```

### Migration Status

| Component | Status | Notes |
|-----------|--------|-------|
| MuPDF Bridge | ✅ Complete | Parsing, TOC, search |
| Content Provider | ✅ Complete | Shadow DOM integration |
| Search | ✅ Complete | Hybrid provider with fallback |
| Format Detection | ✅ Complete | Multi-method detection |
| Fixed-Layout Renderer | ✅ Complete | Canvas + placeholder |
| Legacy Cleanup | ⏳ Deferred | Dependencies still used |

---

## Build & Deployment

### Build Commands

```bash
cd apps/amnesia

# Full build (plugin + server binary if Rust available)
npm run build

# Plugin only (skip server)
npm run build:no-server

# Server only
npm run build:server-only

# Watch mode for development
npm run dev
```

### Output Location

Build output goes to: `apps/amnesia/temp/vault/.obsidian/plugins/amnesia/main.js`

### Test Vault Deployment

**CRITICAL**: Always copy to the test vault before testing.

```bash
# Copy to test vault (integration testing with doc-doctor)
cp apps/amnesia/temp/vault/.obsidian/plugins/amnesia/main.js \
   "/Users/josueguevara/Library/Mobile Documents/iCloud~md~obsidian/Documents/test/.obsidian/plugins/amnesia/main.js"

# Copy to M vault (isolated testing)
cp apps/amnesia/temp/vault/.obsidian/plugins/amnesia/main.js \
   "/Users/josueguevara/Library/Mobile Documents/iCloud~md~obsidian/Documents/M/.obsidian/plugins/amnesia/main.js"
```

**When to use which vault**:
- `test` vault: Integration testing with doc-doctor, multi-plugin scenarios
- `M` vault: Only on mature beta releases, isolated testing, performance benchmarks

### Deployment Checklist

1. [ ] Run `npm run build` in `apps/amnesia/`
2. [ ] Copy `main.js` to appropriate test vault
3. [ ] Connect to Obsidian via MCP: `obsidian_connect()`
4. [ ] Reload plugin: `obsidian_reload_plugin({ pluginId: 'amnesia' })`
5. [ ] Verify feature flags are enabled (if testing experimental features)
6. [ ] Run lifecycle tests via MCP harness
7. [ ] Check console logs for errors

---

## MCP Debugging (Comprehensive)

The Obsidian DevTools MCP server is essential for live debugging. These are the most common operations.

### Connection

```javascript
// Always connect first
mcp__obsidian-devtools__obsidian_connect()

// Get vault info
mcp__obsidian-devtools__obsidian_get_vault_info()

// Reload plugin after code changes
mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })
```

### Accessing the Reader

The reader is nested in Svelte component context:

```javascript
// Get reader and navigator
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  if (leaves.length === 0) return { error: 'No reader open' };

  const view = leaves[0].view;
  const component = view.component;
  const ctx = component.$$.ctx;

  // Reader is typically at index 3 in Svelte context
  const reader = ctx[3];
  const navigator = reader?.navigator;

  return {
    reader,
    navigator,
    currentPosition: navigator?.currentColumn,
    currentChapter: navigator?.currentSpineIndex
  };
})();
```

### PDF Lifecycle Tests

> Verify the loaded reader used is Amnesia and not Obsidian's default PDF reader.

```javascript
// Run specific lifecycle test
await window.pdfLifecycleTests.runTest('scrollStress');
await window.pdfLifecycleTests.runTest('zoomTransitions');
await window.pdfLifecycleTests.runTest('tileCache');
await window.pdfLifecycleTests.runTest('prefetchStrategy');

// Get telemetry after test
const telemetry = window.pdfLifecycleTests.getTelemetry();
console.log('Render count:', telemetry.renderCount);
console.log('Cache hits:', telemetry.cacheHits);
console.log('Cache misses:', telemetry.cacheMisses);

// Capture comparison screenshot for visual regression
await window.pdfLifecycleTests.captureComparisonScreenshot(18, 16);
```

### Live CSS Manipulation

Test CSS fixes before modifying code:

```javascript
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  const view = leaves[0].view;
  const contentEl = view.contentEl;

  // Find Shadow DOM (EPUB rendering)
  let shadowRoot = null;
  for (const el of contentEl.querySelectorAll('*')) {
    if (el.shadowRoot) {
      shadowRoot = el.shadowRoot;
      break;
    }
  }

  if (!shadowRoot) return { error: 'No Shadow DOM found' };

  // Manipulate EPUB chapter elements
  const chapters = shadowRoot.querySelectorAll('.epub-chapter');
  for (const ch of chapters) {
    ch.style.columnGap = '80px';  // Test new gap value
  }

  return { chaptersModified: chapters.length };
})();
```

### Navigation Testing

```javascript
(async function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  const view = leaves[0].view;
  const ctx = view.component.$$.ctx;
  const nav = ctx[3].navigator;

  // Navigate to specific position
  await nav.goTo({ type: 'position', position: 50 });  // 50% through book

  // Test next/prev navigation
  for (let i = 0; i < 10; i++) {
    await nav.next();
    await new Promise(r => setTimeout(r, 100));  // Wait for render
  }

  return {
    currentColumn: nav.currentColumn,
    currentSpineIndex: nav.currentSpineIndex,
    totalColumns: nav.totalColumns
  };
})();
```

### Console Log Monitoring

```javascript
// Get recent errors
mcp__obsidian-devtools__obsidian_get_console_logs({ level: 'error', limit: 20 })

// Get all logs since timestamp
mcp__obsidian-devtools__obsidian_get_console_logs({
  level: 'all',
  limit: 50,
  since: Date.now() - 60000  // Last minute
})

// Clear logs and start fresh
mcp__obsidian-devtools__obsidian_clear_console_logs()
```

### Performance Measurement

```javascript
// Measure render performance
mcp__obsidian-devtools__obsidian_measure_render_performance({
  selector: '.pdf-canvas-container',
  scroll_distance: 800,
  test_duration_ms: 1000
})

// Measure FPS during scroll
mcp__obsidian-devtools__obsidian_measure_fps({
  trigger_scroll: true,
  scroll_distance: 500,
  test_duration_ms: 1000
})

// Capture screenshot for visual comparison
mcp__obsidian-devtools__obsidian_capture_screenshot({
  format: 'png',
  outputPath: '/tmp/amnesia-debug.png'
})
```

---

## PDF Performance Testing (CRITICAL)

> ⚠️ **WARNING**: This section documents hard-learned lessons from failed debugging sessions. Read carefully before any PDF performance work.

### Opening PDFs with Amnesia (NOT Obsidian Default)

**CRITICAL**: Obsidian has a built-in PDF viewer. If you open a PDF the wrong way, you're testing Obsidian's viewer, NOT Amnesia.

#### Correct Method: Use Amnesia Command

```javascript
// Via MCP - trigger Amnesia's command
mcp__obsidian-devtools__obsidian_trigger_command({
  commandId: 'amnesia:open-book'
})

// Or use the command palette in Obsidian:
// Cmd+P → "Amnesia: Open book"
```

#### Verify You're Using Amnesia Reader

```javascript
// Check leaf type - MUST be 'amnesia-reader', NOT 'pdf'
(function() {
  const amnesiaLeaves = app.workspace.getLeavesOfType('amnesia-reader');
  const obsidianPdfLeaves = app.workspace.getLeavesOfType('pdf');

  return {
    amnesiaReaderOpen: amnesiaLeaves.length > 0,  // Should be TRUE
    obsidianPdfOpen: obsidianPdfLeaves.length > 0, // Should be FALSE
    warning: obsidianPdfLeaves.length > 0
      ? '⚠️ WRONG VIEWER! Close Obsidian PDF and use Amnesia command'
      : null
  };
})();
```

#### Wrong Methods (DO NOT USE)

| Method | Why It's Wrong |
|--------|----------------|
| Double-click PDF in file explorer | Opens Obsidian's default PDF viewer |
| `app.workspace.openLinkText('file.pdf')` | Opens Obsidian's default PDF viewer |
| Drag-and-drop PDF | Opens Obsidian's default PDF viewer |
| `obsidian_trigger_command({ commandId: 'app:open-file' })` | Opens with default handler |

### Synthetic Testing Does NOT Work

> ⚠️ **WARNING**: JavaScript-based performance tests DO NOT capture real user experience.

#### What Synthetic Tests Measure vs Reality

| Synthetic Test | What It Actually Measures | What User Experiences |
|----------------|---------------------------|----------------------|
| `requestAnimationFrame` FPS | JS callback timing | Input-to-visual latency |
| `performance.now()` deltas | Code execution time | Perceived smoothness |
| Programmatic `setZoom(8)` | Direct function call | Gesture recognition + debounce + render |
| Injected wheel events | Synthetic event dispatch | Real trackpad physics |

#### Why 60 FPS Can Still Feel Sluggish

```
Synthetic test reports: 60 FPS ✓
User experience: Sluggish, laggy

What's happening:
1. User moves trackpad at t=0ms
2. Browser processes gesture at t=8ms
3. Debounce waits until t=40ms
4. Tile render queued at t=42ms
5. Worker processes at t=150ms (queue wait)
6. Tile displayed at t=200ms

RAF measures: 60 callbacks/second ✓
User perceives: 200ms input lag ✗
```

### Correct Performance Testing Protocol

#### 1. Manual Testing with Real Hardware

**There is no substitute for actual trackpad/mouse interaction.**

```
Test Protocol:
1. Open PDF with Amnesia command (verify leaf type)
2. Use actual trackpad to scroll down 3 pages
3. Pinch-zoom to 8x with real gesture
4. Pan around with trackpad
5. Pinch-zoom to 16x
6. FEEL the responsiveness - is it smooth or sluggish?
```

#### 2. Screen Recording for Evidence

```bash
# Record screen while testing (macOS)
# Use QuickTime Player → File → New Screen Recording
# Analyze frame-by-frame to measure actual latency
```

#### 3. Console Warnings (After Manual Test)

```javascript
// AFTER manual interaction, check for performance warnings
mcp__obsidian-devtools__obsidian_get_console_logs({
  level: 'warn',
  limit: 50
})

// Look for:
// - "[Perf] Input latency: Xms"
// - "[Perf] X consecutive cache misses"
// - "[Perf] Tile waited Xms for permit"
```

#### 4. Telemetry Review (After Manual Test)

```javascript
// Get telemetry AFTER real interaction
(function() {
  const t = window.Amnesia?.telemetry?.metrics;
  if (!t) return { error: 'No telemetry' };

  return {
    cacheHitRate: t.cacheL1Hits / (t.cacheL1Hits + t.cacheL1Misses) * 100,
    avgRenderTime: t.renderTimes?.length
      ? t.renderTimes.reduce((a,b) => a+b) / t.renderTimes.length
      : 'N/A',
    // These numbers are only meaningful after REAL interaction
  };
})();
```

### What NOT To Do

| ❌ Don't | ✅ Do Instead |
|----------|---------------|
| Trust synthetic FPS tests | Test with real trackpad gestures |
| Assume code changes work | Manually verify each change |
| Make multiple changes at once | Change one variable, test, repeat |
| Skip manual testing | Always scroll/zoom with real input |
| Use programmatic zoom for perf testing | Use pinch gestures on trackpad |
| Open PDF by double-clicking | Use `Amnesia: Open book` command |
| Rely on console.log absence | Check for actual smoothness |

### Display Mode Testing Matrix

Amnesia has 5 display modes with different rendering paths. Test ALL of them:

| Mode | Command/Setting | Key Behavior to Test |
|------|-----------------|---------------------|
| `paginated` | Settings → Display → Paginated | Page turn latency |
| `vertical-scroll` | Settings → Display → Vertical | Scroll smoothness |
| `horizontal-scroll` | Settings → Display → Horizontal | Horizontal pan |
| `canvas` | Settings → Display → Canvas | Free pan/zoom |
| `auto-grid` | Settings → Display → Grid | Thumbnail + zoom |

```javascript
// Switch display mode for testing
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  if (leaves.length === 0) return { error: 'No Amnesia reader open' };

  // Access PDF settings through the view
  const view = leaves[0].view;
  // Mode switching depends on UI - use Settings panel manually
  return { instruction: 'Use Settings panel to switch display mode' };
})();
```

### Performance Debugging Checklist

Before claiming a performance fix works:

- [ ] Opened PDF with `Amnesia: Open book` command (not double-click)
- [ ] Verified leaf type is `amnesia-reader` (not `pdf`)
- [ ] Tested with real trackpad scroll (not synthetic events)
- [ ] Tested with real pinch-zoom gesture (not programmatic)
- [ ] Tested in ALL 5 display modes
- [ ] Checked console for `[Perf]` warnings after interaction
- [ ] Compared before/after with screen recording if possible
- [ ] Changes tested ONE AT A TIME, not batched

---

## Common Pitfalls (Anti-Patterns)

### PDF Rendering

| Symptom | Cause | Fix |
|---------|-------|-----|
| "0 visible tiles during scroll" | Using current camera in debounced render | Capture camera snapshot at debounce time |
| Blank pages at high zoom | Full-page rendering at zoom >4x | Use tiling, not full-page rendering |
| Blurry text at high zoom | Scale cap below zoom×pixelRatio | Minimum scale = zoom × pixelRatio |
| Synthetic wheel events zoom instead of scroll | Browser interprets synthetic as zoom gesture | Use actual trackpad or MCP lifecycle tests |

### EPUB Pagination

| Symptom | Cause | Fix |
|---------|-------|-----|
| Blank pages when navigating | Column count over-estimation | Measure actual content, not container |
| Content missing margins | Absolute positioning ignores padding | Explicitly offset by margin value |
| Transform drift over time | Column offsets don't match layout | Two-phase measurement with RAF |
| Wrong scrollWidth value | scrollWidth returns container, not content | Measure element bounding rects |

### State Management

| Symptom | Cause | Fix |
|---------|-------|-----|
| Stale UI after state change | Direct mutation in reducer | Return new object: `{ ...state, field }` |
| Memory leak | Missing unsubscribe cleanup | Store unsubscriber, call on destroy |
| Circular dependency crash | ServiceA ↔ ServiceB | Extract common deps to separate module |

### Sync

| Symptom | Cause | Fix |
|---------|-------|-----|
| Infinite sync loops | Not updating checkpoint timestamp | Always save checkpoint before exit |
| Lost data on conflict | Naive last-write-wins | Use field-level change tracking |
| Hash mismatches | Different serialization order | Normalize data before hashing |

---

## Testing

### Test Configuration

**Location**: `apps/amnesia/vitest.config.ts`

```typescript
{
  environment: 'jsdom',
  include: ['src/test/**/*.test.ts'],
  testTimeout: 300000,  // 5 min for integration tests
  hookTimeout: 60000,
  globals: true,
  alias: { 'obsidian': 'src/test/mocks/obsidian.ts' }
}
```

### Running Tests

```bash
cd apps/amnesia

# Run all tests
npm test

# Watch mode
npm run test:watch

# Run specific test file
npm test -- src/test/pdf/unit/adaptive-prefetcher.test.ts

# Run benchmarks
npm run test:bench
```

### Test Patterns

1. **Unit tests**: Pure function testing (reducers, calculations)
2. **Integration tests**: Multi-service workflows with mocked Obsidian
3. **E2E tests**: Full sync workflows with test vault fixtures
4. **MCP tests**: Live Obsidian testing via DevTools

---

## TypeScript Paths

```json
{
  "@/*": "src/*",
  "@shared/*": "../../packages/shared-types/src/*",
  "@sync": "src/sync",
  "@test": "src/test"
}
```

---

## Feature Flags

**Location**: `src/reader/renderer/pdf/feature-flags.ts`

```typescript
interface FeatureFlags {
  // PDF Rendering
  enableDualResolution: boolean;      // Low-res instant, high-res background
  enableAdaptivePrefetch: boolean;    // Velocity-based lookahead
  enableTileCaching: boolean;         // 3-tier L1/L2/L3 cache
  enableProgressiveRenderer: boolean; // Multi-tier rendering quality
  enableWorkerPool: boolean;          // Multi-worker tile rendering

  // EPUB Rendering (v0.5.1)
  useMuPDFEpub: 'auto' | boolean;     // MuPDF-based EPUB parsing/search
}
```

Enable via settings or programmatically for A/B testing.

---

## Collaboration Guidelines

### Before Making Changes

1. **Read this document** - Understand the architectural decisions
2. **Understand camera snapshots** - Essential for any PDF work
3. **Test with MCP harness** - Use `window.pdfLifecycleTests` before committing
4. **Deploy to test vault** - Never skip the copy step
5. **Check console for errors** - MCP logs reveal issues quickly

### Code Review Checklist

- [ ] Types exported from `@amnesia/shared-types` if cross-ecosystem
- [ ] Error handling uses custom error classes
- [ ] State changes are immutable (no direct mutations)
- [ ] Async operations have proper error handling
- [ ] Cleanup handlers registered for subscriptions/observers
- [ ] Feature flags used for experimental code
- [ ] Tests cover happy path + error cases
- [ ] No unnecessary complexity (avoid over-engineering)

### Naming Conventions

| Pattern | Example | Use For |
|---------|---------|---------|
| `*Service` | `LibraryService` | Domain services with business logic |
| `*Manager` | `TileCacheManager` | Resource lifecycle management |
| `*Store` | `HudStore` | Redux-like state containers |
| `*Adapter` | `CalibreAdapter` | Data source abstractions |
| `*Provider` | `HybridPdfProvider` | Factory/supplier patterns |
| `*Renderer` | `PdfRenderer` | Document rendering implementations |

---

## Doc Doctor Integration

Amnesia integrates with Doc Doctor via:

**Location**: `src/integrations/doc-doctor-bridge.ts`

```typescript
class DocDoctorBridge {
  // Bidirectional highlight sync
  syncHighlightsToDocDoctor();    // Export highlights as stubs
  syncStubsToHighlights();        // Import stubs as highlights

  // Shared HUD
  registerHUDProvider();          // Hook into Doc Doctor HUD
  notifyHighlightCreated(event);  // Trigger Doc Doctor reactions
}
```

**Shared Types**: `@amnesia/shared-types` used by both plugins for:
- 12 semantic annotation types
- Highlight union types
- Book metadata
- Reading progress

---

## Quick Reference

### Key Entry Points

| File | Purpose |
|------|---------|
| `src/main.ts` | Plugin initialization, service wiring |
| `src/api/index.ts` | Public API surface (`window.Amnesia`) |
| `src/reader/reader-view.ts` | Reader UI container |
| `src/reader/renderer/document-renderer.ts` | Format abstraction interface |
| `src/sync/unified-sync-engine.ts` | Multi-adapter sync orchestration |

### Build Output

| Path | Purpose |
|------|---------|
| `temp/vault/.obsidian/plugins/amnesia/main.js` | Bundled plugin |
| `temp/vault/.obsidian/plugins/amnesia/*.wasm` | WASM modules |
| `temp/vault/.obsidian/plugins/amnesia/server/` | Rust binary (if built) |

### Commands

```bash
npm run build           # Full build
npm run dev            # Watch mode
npm test               # Run tests
npm run test:watch     # Watch tests
npm run test:bench     # Run benchmarks
```

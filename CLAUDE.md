# CLAUDE.md - Amnesia Development Guide

## Project Overview

**Amnesia** is an Obsidian plugin for reading EPUBs and PDFs with annotations, sync, and OPDS support.

| Component | Stack | Location |
|-----------|-------|----------|
| Plugin | TypeScript + Svelte | `apps/amnesia/` |
| Server | Rust + Axum | `apps/amnesia-server/` |
| Shared Types | TypeScript | `packages/shared-types/` |

---

## Axiological Alignment

This project follows the **Axiological Foundations of Software Engineering**:

- **Cognitive Ergonomics**: Prefer simple, explicit solutions over clever abstractions
- **Quantified Quality**: Performance budgets, instrumentation before deployment
- **Bounded Contexts**: Reader, Sync, Calibre, Library are separate domains
- **Lifecycle Budgeting**: Ship what meets quality floors; no infinite polish
- **Governed Execution**: Capability-based API security, auditable state changes

---

## Architecture (Quick Reference)

### Entry Point
`src/main.ts` → `AmnesiaPlugin` class initializes WASM workers, stores, services, views, and public API.

### Key Directories
```
src/
├── main.ts                      # Plugin initialization
├── api/                         # Public API (window.Amnesia)
├── reader/
│   ├── renderer/
│   │   ├── pdf/                 # PDF: MuPDF WASM, tiling, camera
│   │   ├── epub/                # EPUB: MuPDF parser + Shadow DOM
│   │   └── document-renderer.ts # Unified interface
│   └── navigator/               # EPUB pagination (CSS columns)
├── library/                     # Book metadata, discovery
├── highlights/                  # 12 semantic annotation types
├── sync/                        # Adapters: Calibre, Server, File
├── helpers/store.ts             # Redux-like state pattern
└── wasm/mupdf/                  # Custom MuPDF WASM (SIMD+LTO)
```

### Core Interfaces
| Interface | Location | Purpose |
|-----------|----------|---------|
| `DocumentRenderer` | `reader/renderer/document-renderer.ts` | Format-agnostic rendering |
| `ContentProvider` | `reader/renderer/content-provider.ts` | Chapter/content delivery |
| `SyncAdapter` | `sync/sync-adapter.ts` | Pluggable sync backends |

### State Management
Redux-like pattern via `helpers/store.ts`. All stores use immutable updates:
```typescript
// Always return new object, never mutate
case 'ADD_BOOK': return { ...state, books: [...state.books, action.book] };
```

---

## Critical Patterns

### Camera Snapshot (PDF Rendering)
**CRITICAL**: Capture camera state at debounce time, NOT render time:
```typescript
// WRONG: Camera moved during debounce
debounce(() => calculateVisible(this.camera), 32);

// CORRECT: Snapshot at schedule time
const snapshot = { ...this.camera };
debounce(() => calculateVisible(snapshot), 32);
```

### EPUB Column Measurement
**Problem**: `scrollWidth` returns container width, not content extent.
**Solution**: Measure actual element positions (see `navigator/column-utils.ts`).

### Tiling Strategy
- Zoom <1.5x: Full page rendering
- Zoom >4x: Always tile (256×256 CSS pixels)
- Velocity-based prefetching in `scroll-strategy.ts`

---

## Build & Deploy

```bash
cd apps/amnesia

npm run build              # Full build
npm run build:no-server    # Plugin only
npm run dev                # Watch mode
npm test                   # Run tests
```

**Output**: `temp/vault/.obsidian/plugins/amnesia/main.js`

### Deploy to Test Vault
```bash
cp temp/vault/.obsidian/plugins/amnesia/main.js \
   "/Users/josueguevara/Library/Mobile Documents/iCloud~md~obsidian/Documents/test/.obsidian/plugins/amnesia/main.js"
```

---

## MCP Debugging (Essentials)

```javascript
// Connect and reload
mcp__obsidian-devtools__obsidian_connect()
mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })

// Get console errors
mcp__obsidian-devtools__obsidian_get_console_logs({ level: 'error', limit: 20 })

// Run PDF lifecycle test
await window.pdfLifecycleTests.runTest('scrollStress');

// Access reader via Svelte context
const view = app.workspace.getLeavesOfType('amnesia-reader')[0].view;
const reader = view.component.$$.ctx[3];
```

**Open PDFs correctly**: Use `Amnesia: Open book` command (Cmd+P), NOT double-click (opens Obsidian's viewer).

---

## Performance Testing

> **Synthetic tests DO NOT capture real user experience.** Always test with actual trackpad gestures.

**Protocol**:
1. Open PDF with `Amnesia: Open book` command
2. Verify leaf type is `amnesia-reader` (not `pdf`)
3. Scroll/zoom with real trackpad gestures
4. FEEL the responsiveness - synthetic FPS means nothing
5. Test ALL display modes: paginated, vertical-scroll, horizontal-scroll, canvas, auto-grid

---

## Common Pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| "0 visible tiles during scroll" | Using current camera in debounced render | Use camera snapshot |
| Blank EPUB pages | Column count over-estimation | Measure actual content positions |
| Stale UI after state change | Direct mutation in reducer | Return new object |
| PDF opened in wrong viewer | Double-clicked file | Use `Amnesia: Open book` command |

---

## Issue Tracking (bd/beads)

This project uses **bd** for persistent issue tracking across sessions.

**IMPORTANT:**
**NEVER assign or defer work to the user.**
**NEVER defer work, instead block the issue and add any finding as a blocking dependecy.**
**ALWAYS resolve all issues in the same session unless instructed otherwise or if the blocking issues require external validation.**
**NEVER assume work is optional or can be deferred. If the issue exists, it must be resolved.**

### Essential Workflow
```bash
bd ready                              # Find available work
bd update <id> --status=in_progress   # Claim it
# ... do the work ...
bd close <id>                         # Complete it
bd ready                              # See what's unblocked
```

### Session Close Protocol (CRITICAL)
```bash
git status && git add <files> && bd sync && git commit -m "..." && bd sync && git push
```

**Work is NOT done until `git push` succeeds.**

### When to Use What
| Use bd | Use TodoWrite |
|--------|---------------|
| Multi-session work | Single-session execution |
| Work with dependencies | Simple linear tasks |
| Discovered work during impl | Pre-planned steps |

### Quick Reference
```bash
bd create "Title" --type=task --priority=1    # Create issue
bd q "Quick capture"                          # Quick capture (outputs ID)
bd show <id>                                  # View details
bd dep add <issue> <depends-on>               # Add dependency
bd graph <id>                                 # Visual dependency graph
bd sync                                       # Sync with git
```

**Status**: open, in_progress, blocked, deferred, closed
**Priority**: 0 (critical) → 4 (backlog) — never use "high/medium/low"
**Types**: task, bug, feature, epic, chore

For complete bd reference: `bd --help` or `bd <command> --help`

---

## Key Files by Domain

| Domain | Essential Files |
|--------|-----------------|
| Plugin core | `main.ts`, `helpers/store.ts` |
| PDF rendering | `pdf/pdf-infinite-canvas.ts`, `pdf/render-coordinator.ts`, `pdf/mupdf-worker.ts` |
| EPUB rendering | `shadow-dom-renderer.ts`, `epub/mupdf-epub-bridge.ts` |
| State | `library/library-reducer.ts`, `highlights/highlight-store.ts` |
| Sync | `sync/unified-sync-engine.ts`, `sync/sync-adapter.ts` |
| Public API | `api/index.ts` |
| Custom WASM | `wasm/mupdf/` (SIMD+LTO build, 33% smaller than npm) |

---

## Code Review Checklist

- [ ] State changes are immutable
- [ ] Cleanup handlers registered for subscriptions
- [ ] Error handling uses custom error classes
- [ ] No over-engineering (avoid premature abstractions)
- [ ] Types exported from `@amnesia/shared-types` if cross-ecosystem

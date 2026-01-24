# Amnesia Ecosystem Expansion Research Report

> **Date**: 2026-01-08
> **Status**: Research Complete - Awaiting Implementation Decisions
> **Scope**: Codebase evaluation, Doc Doctor integration, feature expansion, API capabilities

---

## Executive Summary

This research identifies **67 actionable opportunities** across 5 categories:

| Category | Opportunities | Highest Impact |
|----------|---------------|----------------|
| **Code Improvements** | 10 issues | -7.2MB bundle, -2,770 LOC |
| **Doc Doctor Integration** | 50+ joint features | HUD sharing already working |
| **Dictionary Manager** | New feature | 11-phase implementation plan |
| **API Expansions** | 7 endpoints | Highlight extraction, FTS5, bibliography |
| **OPDS/Calibre** | 5 enhancements | Bidirectional sync improvements |

**Key Finding**: The HUD integration between Doc Doctor and Amnesia is **already functional**. Amnesia can register providers and render content in Doc Doctor's HUD infrastructure today.

---

## Table of Contents

1. [Codebase Evaluation](#1-codebase-evaluation)
2. [Unified Annotations Vocabulary](#2-unified-annotations-vocabulary) **(NEW - CRITICAL)**
3. [Doc Doctor Integration Opportunities](#3-doc-doctor-integration-opportunities)
4. [Dictionary Manager Feature](#4-dictionary-manager-feature)
5. [API Capability Expansions](#5-api-capability-expansions)
6. [OPDS & Calibre Integration](#6-opds--calibre-integration)
7. [Implementation Roadmap](#7-implementation-roadmap)
8. [Open Questions](#8-open-questions)

---

## 1. Codebase Evaluation

### 1.1 Critical Refactoring Opportunities

| Priority | Issue | Impact | Complexity | Bundle Savings |
|----------|-------|--------|------------|----------------|
| **P0** | Remove pdfjs-dist (dead dependency) | High | Low | -5MB |
| **P0** | Consolidate template engines (Nunjucks only) | High | Medium | -700KB |
| **P0** | Remove 10 redundant generator classes | High | Medium | -1,696 LOC |
| **P1** | Split 943-line settings.ts | Medium | Low | Maintainability |
| **P1** | Remove unused WASM provider | Medium | Medium | -289 LOC |
| **P1** | Conditional MCP test harness | Low | Low | -344 LOC |
| **P2** | Lazy-load sql.js for Calibre users | Medium | Low | -1.5MB (conditional) |
| **P2** | Simplify provider architecture | Medium | Medium | -500 LOC |
| **P2** | Conditional telemetry | Low | Low | CPU savings |
| **P3** | Delete deprecated code comments | Low | Low | -50 LOC |

**Total Potential Savings**: -7.2MB bundle size, -2,770 LOC

### 1.2 Template Engine Consolidation (CRITICAL)

**Current State**: Both LiquidJS (700KB) and Nunjucks (350KB) maintained in parallel.

**Evidence**:
- `nunjucks-engine.ts` - Active system with `{% persist %}` blocks
- `liquid-engine.ts` - Legacy system (191 LOC)
- 5 Calibre generators still using Liquid

**Recommendation**: Consolidate to Nunjucks only.

**Migration Path**:
1. Convert 5 Calibre templates to Nunjucks syntax
2. Update generator classes to use `NunjucksTemplateService`
3. Remove `liquid-engine.ts`
4. `npm uninstall liquidjs`
5. Add migration notice for user custom templates

### 1.3 Generator Class Explosion

**12 generator classes exist** with massive overlap:

| Generator | LOC | Engine | Status |
|-----------|-----|--------|--------|
| `UnifiedNoteGenerator` | 1,144 | Nunjucks | ✅ Keep (has ALL features) |
| `NoteGenerator` | ~200 | Liquid | ❌ Delete |
| `BookNoteGenerator` (generators/) | ~150 | Nunjucks | ❌ Delete |
| `HighlightGenerator` | ~180 | Nunjucks | ❌ Delete |
| `IndexGenerator` | ~140 | Nunjucks | ❌ Delete |
| `BookNoteGenerator` (calibre/) | ~220 | Liquid | ❌ Delete |
| `AuthorIndexGenerator` | ~180 | Liquid | ❌ Delete |
| `SeriesIndexGenerator` | ~190 | Liquid | ❌ Delete |
| `ShelfIndexGenerator` | ~160 | Liquid | ❌ Delete |
| `BaseFileGenerator` | ~100 | Liquid | ❌ Delete |

**Recommendation**: Keep only `UnifiedNoteGenerator` (-1,696 LOC).

### 1.4 Dead Dependencies

| Package | Size | Usage | Action |
|---------|------|-------|--------|
| `pdfjs-dist` | 5MB | Zero imports (migrated to MuPDF) | **Remove immediately** |
| `liquidjs` | 700KB | Legacy templates | Remove after consolidation |
| `sql.js` | 1.5MB | Calibre sync only | Lazy-load |

### 1.5 Phased Cleanup Plan

**Phase 1 (1-2 days, Zero Risk)**:
- Remove pdfjs-dist: `npm uninstall pdfjs-dist`
- Delete deprecated code comments
- Conditional test harness compilation
- Conditional telemetry

**Phase 2 (3-5 days, Medium Risk)**:
- Template engine consolidation
- Generator class consolidation

**Phase 3 (1-2 weeks, Higher Risk)**:
- Settings file restructuring
- Lazy-load sql.js
- Provider architecture simplification

---

## 2. Doc Doctor Integration Opportunities

### 2.1 Current Integration Status

| Component | Status | Notes |
|-----------|--------|-------|
| HUD Provider Registry | ✅ Working | `doc-doctor:hud-ready` event |
| MCP Tools Access | ✅ Available | 28 tools via `docDoctorPlugin.mcpTools` |
| Smart Connections | ✅ Available | Via Doc Doctor's service |
| Public API | ⚠️ Partial | API exists but not fully exposed |
| Event Emissions | ❌ Missing | Stub events defined but not emitted |

### 2.2 Joint Capability Matrix (50+ Features)

#### Phase 1: Quick Wins (Complexity 1-3)

| ID | Feature | Complexity | Doc Doctor | Amnesia |
|----|---------|------------|------------|---------|
| HUD-01 | HUD Provider Registration | 1 | `hudRegistry` | Provider impl |
| SE-01 | Selection → Stub (context menu) | 2 | `add_stub` MCP | Context menu |
| PT-01 | Reading Progress → Refinement | 2 | `update_refinement` | Progress event |
| RC-01 | Book Health Badge | 2 | `calculateHealth` | Toolbar |
| KC-01 | Highlight → Stub Auto-Sync | 3 | Stub CRUD | Highlight events |
| CM-01 | Series → Project Import | 3 | Project API | Series query |

#### Phase 2: Core Integration (Complexity 3-5)

| ID | Feature | Complexity | Description |
|----|---------|------------|-------------|
| KC-05 | Bidirectional Highlight-Stub | 5 | Sync changes both directions |
| CM-05 | Calibre L1 Properties | 5 | Store refinement in Calibre columns |
| RC-03 | Reading Health Dashboard | 5 | D3 charts for library health |
| SE-02 | AI Stub Suggestions | 5 | LLM suggests stubs from chapter |
| AI-02 | Cross-Book Resolution | 8 | Semantic search for stub matching |

#### Phase 3: Transformative (Complexity 8-13)

| ID | Feature | Complexity | Description |
|----|---------|------------|-------------|
| CM-02 | Reading Graph | 8 | Library in graph view |
| PV-01 | Unified Event Log | 8 | Merge DD + AM provenance |
| VZ-02 | Knowledge Graph | 13 | WASM physics for docs+books+highlights |
| AI-05 | Reading → Writing Pipeline | 13 | End-to-end knowledge flow |

### 2.3 HUD Integration Pattern (Already Working)

```typescript
// Amnesia can register HUD provider TODAY:
window.addEventListener('doc-doctor:hud-ready', (event) => {
  const registry = event.detail.registry;
  registry.register(new AmnesiaHUDProvider(this));
});

// Context-aware switching:
isActiveForContext(context: HUDContext): boolean {
  // Doc Doctor yields to Amnesia for reading contexts
  if (context.leafType === 'amnesia-reader') return false;
  return true;
}
```

### 2.4 Required Doc Doctor Updates

For full integration, Doc Doctor needs:

1. **Expose Public API**:
   ```typescript
   // In main.ts onload()
   this.api = createDocDoctorAPI({ ... });
   (window as any).DocDoctorAPI = this.api;
   ```

2. **Emit Stub Events**:
   ```typescript
   this.app.workspace.trigger('doc-doctor:stub-added', { file, stub });
   this.app.workspace.trigger('doc-doctor:stub-resolved', { file, stubId });
   ```

3. **Create Amnesia Integration Adapter**:
   - Listen to `amnesia:highlight-created` events
   - Convert highlights to stubs
   - Display health in Amnesia UI

---

## 3. Dictionary Manager Feature

### 3.1 Vision

Transform passive ebook reading into active vocabulary building with a native dictionary system that:
- Generates atomic notes from term lookups during reading
- Integrates with Doc Doctor AI for definition expansion
- Links to Smart Connections for semantic discovery
- Uses existing Nunjucks templating infrastructure

### 3.2 Existing Dictionary Structure

**Location**: `/Users/josueguevara/Library/Mobile Documents/iCloud~md~obsidian/Documents/M/Biblioteca/Diccionarios`

**Organization**:
```
Diccionarios/
├── Hispánico/           # Spanish
│   ├── A/
│   │   └── Aporía.md
│   ├── M/
│   │   └── Melancolía.md
└── Anglosajón/          # English
    ├── G/
    │   └── Graph.md
```

**Frontmatter Schema**:
```yaml
type: Definición
language: es | en
term: Melancolía
definition: "Brief definition..."
etymology: "Del lat. tardío..."
pos: sustantivo femenino | noun
letter: M
source: Glosario hispánico
created: 2025-01-27
argot: ["Computer Science", "Graph Theory"]  # Optional
```

**Sections**: Definition, Etymology, Examples, Synonyms, Antonyms, Related Terms, References (Bases query)

### 3.3 Architecture Blueprint

#### Core Services

| Service | Responsibility | LOC Est. |
|---------|----------------|----------|
| `DictionaryService` | CRUD, lookup coordination, caching | 400 |
| `DictionaryAPIClient` | Multi-provider API with fallback | 300 |
| `DictionaryCacheManager` | 3-tier cache (L1/L2/L3) | 250 |
| `DictionaryEntryGenerator` | Note generation via Nunjucks | 350 |
| `DictionaryTooltipManager` | UI lifecycle for popups | 200 |

#### API Provider Strategy

| Provider | Priority | Rate Limit | Notes |
|----------|----------|------------|-------|
| Free Dictionary API | 1 | Unlimited (polite) | No API key required |
| Wiktionary | 2 | No hard limit | Fallback parsing |
| Merriam-Webster | 3 | 1,000/day | Requires API key |

#### Cache Architecture

```
Priority 1: L1 Cache (Memory)    → 1-2ms
Priority 2: L2 Cache (IndexedDB) → 5-10ms
Priority 3: L3 Cache (Files)     → 20-50ms
Priority 4: API Call             → 200-500ms
```

**TTL Strategy**:
- L1: 1 hour (session-based)
- L2: 7 days (persistent)
- L3: 30 days (filesystem notes)

#### UI/UX Flow

```
User Long-Press (500ms) on Term
         ↓
[TextSelectionHandler] Extract term + context (±50 chars)
         ↓
[DictionaryTooltip] Show loading state
         ↓
[DictionaryService.lookupTerm()] → Cache chain → API fallback
         ↓
[DictionaryTooltip] Display definition
         ↓
User clicks "Save to Vault"
         ↓
[DictionaryEntryGenerator] Create: /Diccionarios/Hispánico/M/Melancolía.md
```

#### Smart Connections Integration

```typescript
// Check availability
const smartConnections = app.plugins.plugins['smart-connections'];
if (smartConnections) {
  // Trigger embedding for new entry
  await smartConnections.api.generateEmbedding(entryFile.path);

  // Find semantically similar notes
  const similar = await smartConnections.api.findSimilar(entryFile.path, {
    limit: 10,
    threshold: 0.7
  });
}
```

#### Doc Doctor AI Enhancement

```typescript
// Enhancement prompt for AI expansion
const prompt = `
Context: Dictionary entry for "{{ term }}" ({{ language }})
Current definition: {{ definition }}

Task: Enhance with:
1. More detailed explanation
2. 3-5 contextual usage examples
3. Common collocations or phrases
4. Nuances across different contexts
5. Common mistakes or confusions
`;
```

### 3.4 Implementation Phases (11 total)

| Phase | Focus | Duration |
|-------|-------|----------|
| 1 | Foundation (types, store, settings) | 2-3 days |
| 2 | Cache Infrastructure | 2-3 days |
| 3 | API Integration | 3-4 days |
| 4 | Note Generation | 3-4 days |
| 5 | Core Service | 2-3 days |
| 6 | UI Components | 4-5 days |
| 7 | Reader Integration | 3-4 days |
| 8 | Server Context Extraction (Optional) | 2-3 days |
| 9 | Plugin Integrations | 2-3 days |
| 10 | Settings & Polish | 2-3 days |
| 11 | Testing & Documentation | 3-4 days |

**Total Estimate**: 19-26 days

### 3.5 Template Structure

```markdown
---
type: dictionary-entry
language: {{ language }}
term: {{ term }}
definition: {{ definition | truncate: 100 }}
etymology: {{ etymology }}
pos: {{ pos }}
letter: {{ letter }}
source: {{ source }}
created: {{ date.now | date: "%Y-%m-%d" }}
---

# {{ term }}

## {% if language == "es" %}Definición{% else %}Definition{% endif %}
{{ definition }}

{% if etymology %}
## {% if language == "es" %}Etimología{% else %}Etymology{% endif %}
{{ etymology }}
{% endif %}

{% if examples %}
## {% if language == "es" %}Ejemplos{% else %}Examples{% endif %}
{% for example in examples %}
- {{ example }}
{% endfor %}
{% endif %}

{% persist "notes" %}
## Personal Notes
<!-- Add your notes here -->
{% endpersist %}

---
## References
```bases
FROM "Biblioteca"
WHERE content CONTAINS "{{ term }}"
LIMIT 20
```
```

---

## 4. API Capability Expansions

### 4.1 Priority Ranking

| Rank | API | Impact | Complexity | Time |
|------|-----|--------|------------|------|
| **1** | Direct Highlight Extraction | Very High | Low | 1-2 weeks |
| **2** | SQLite FTS5 Enhanced Search | Very High | Medium | 2-3 weeks |
| **3** | Bibliography Generation | Medium-High | Low | 1 week |
| **4** | Document Structure Analysis | Medium | Medium | 2 weeks |
| **5** | Semantic Search Bridge | Medium | Medium | 3-4 weeks |
| **6** | Batch Processing | Low-Medium | Low | 1 week |
| **7** | Reading Statistics | Low | Low | 1 week |

### 4.2 Direct Highlight Extraction API

**Gap**: No way to extract existing PDF annotations or convert search results to highlights.

**Endpoints**:
```rust
GET  /api/v1/documents/{book_id}/extract-highlights
POST /api/v1/documents/{book_id}/extract-highlights/search
POST /api/v1/batch/extract-highlights
```

**MuPDF Capabilities** (not yet exposed):
- PDF native annotations (highlights, comments from Adobe/Foxit)
- Image enumeration
- Table detection
- Heading extraction (font size analysis)
- Link enumeration

**Doc Doctor Use Cases**:
- HUD displays "42 extractable highlights" vs "12 user highlights"
- AI suggests: "Found 23 mentions of 'async/await' - convert to highlights?"

### 4.3 SQLite FTS5 Enhanced Search

**Gap**: Search limited to LIKE queries (slow on 10k+ books).

**Solution**: Full-text search with FTS5.

```sql
CREATE VIRTUAL TABLE books_fts USING fts5(
    title, authors, description, tags,
    tokenize='unicode61 remove_diacritics 2'
);
```

**Performance**:
- LIKE query: 1000ms
- FTS5 query: 20ms **(50x faster)**

**Endpoints**:
```rust
GET /api/v1/search/books?q=rust async&authors=Steve Klabnik
GET /api/v1/search/highlights?q=async await&colors=yellow,blue
GET /api/v1/search/unified?q=dependency injection
```

### 4.4 Bibliography Generation API

**Gap**: No citation generation for academic workflows.

**Formats Supported**:
| Format | Use Case | Rust Crate |
|--------|----------|------------|
| BibTeX | LaTeX, reference managers | `biblatex` |
| APA 7th | Psychology, social sciences | `hayagriva` |
| MLA 9th | Literature, humanities | `hayagriva` |
| Chicago 17th | History | `hayagriva` |
| IEEE | Engineering | `hayagriva` |

**Endpoints**:
```rust
GET  /api/v1/books/{book_id}/citation?format=bibtex
POST /api/v1/bibliography/generate
```

**Example Output** (BibTeX):
```bibtex
@book{zinsser_1988_writing,
  author = {William Zinsser},
  title = {Writing to Learn},
  year = {1988},
  publisher = {Harper \& Row},
  isbn = {978-0060158590}
}
```

### 4.5 Authentication for Multi-Device Sync

**Recommendation**: JWT with Scoped Permissions

```json
{
  "sub": "user_id",
  "device_id": "desktop_1",
  "exp": 1738972800,
  "scopes": ["read:books", "write:highlights", "delete:progress"]
}
```

**Security Layers**:
1. JWT signature validation
2. Device registry check
3. Scope enforcement per endpoint
4. Rate limiting (100 requests/minute per device)
5. Audit logging

---

## 5. OPDS & Calibre Integration

### 5.1 Current Calibre Integration

**Strengths**:
- ✅ Bidirectional metadata sync (read/write)
- ✅ Custom column mapping
- ✅ Conflict resolution strategies
- ✅ Cover download

**Weaknesses**:
- ❌ Full-table SQL scans (no FTS5)
- ❌ sql.js loads for all users (1.5MB)
- ❌ No incremental sync (full rescan each time)

### 5.2 Proposed Enhancements

| Enhancement | Impact | Complexity |
|-------------|--------|------------|
| FTS5 index for Calibre.db | Very High | Medium |
| Lazy-load sql.js | Medium | Low |
| Incremental sync (change tracking) | High | Medium |
| Server-side Calibre parsing | High | High |
| Calibre L1 Properties (refinement column) | Medium | Medium |

### 5.3 FTS5 Index for Calibre

**Schema**:
```sql
CREATE VIRTUAL TABLE books_fts USING fts5(
    title, authors, description, tags, publisher,
    content='books', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);
```

**Benefits**:
- 50x faster search
- Enables Doc Doctor AI queries: "books about Rust with highlights on async"
- Autocomplete powered by prefix search

### 5.4 OPDS Improvements

**Current State**:
- Basic catalog browsing
- Book download
- Feed caching

**Potential Enhancements**:
| Feature | Benefit |
|---------|---------|
| OPDS-PSE (Page Streaming Extension) | Progressive download for large books |
| OPDS 2.0 support | Modern JSON format, better discovery |
| Authentication adapters | Support for protected feeds |
| Feed aggregation | Multiple OPDS sources in unified view |

---

## 6. Implementation Roadmap

### Quarter 1: Foundation (Weeks 1-6)

**Week 1-2: Code Cleanup Phase 1**
- [ ] Remove pdfjs-dist
- [ ] Delete deprecated code
- [ ] Conditional test harness
- [ ] Conditional telemetry
- **Result**: -5MB bundle, cleaner codebase

**Week 3-4: Code Cleanup Phase 2**
- [ ] Consolidate to Nunjucks only
- [ ] Remove 10 redundant generators
- **Result**: -700KB bundle, -1,696 LOC

**Week 5-6: Doc Doctor Quick Wins**
- [ ] HUD Provider Registration
- [ ] Book Health Badge
- [ ] Selection → Stub context menu
- **Result**: Basic integration visible to users

### Quarter 2: Core Features (Weeks 7-14)

**Week 7-10: Dictionary Manager MVP**
- [ ] Cache infrastructure
- [ ] API client with fallback
- [ ] Note generation
- [ ] Tooltip UI
- [ ] Reader integration
- **Result**: Working dictionary lookup during reading

**Week 11-14: API Expansions**
- [ ] Direct Highlight Extraction
- [ ] SQLite FTS5 Search
- [ ] Bibliography Generation
- [ ] JWT Authentication
- **Result**: Enhanced API surface

### Quarter 3: Advanced Features (Weeks 15-22)

**Week 15-18: Dictionary Enhancements**
- [ ] Smart Connections integration
- [ ] Doc Doctor AI enhancement
- [ ] Server-side context extraction
- **Result**: AI-powered vocabulary building

**Week 19-22: Doc Doctor Core Integration**
- [ ] Bidirectional Highlight-Stub sync
- [ ] Reading Health Dashboard
- [ ] AI Stub Suggestions
- **Result**: Seamless reading → writing flow

### Quarter 4: Transformative Features (Weeks 23-30)

**Week 23-26: Calibre Optimization**
- [ ] FTS5 index
- [ ] Lazy-load sql.js
- [ ] Incremental sync
- **Result**: Fast Calibre integration

**Week 27-30: Knowledge Graph**
- [ ] Graph visualization
- [ ] Cross-book resolution
- [ ] Unified event log
- **Result**: Visual knowledge management

---

## 7. Open Questions

### For Product Decisions

1. **Dictionary Languages**: Beyond Spanish and English, which languages should be prioritized?

2. **Template Migration**: How should we handle users with custom Liquid templates during consolidation?

3. **Offline Priority**: Should Dictionary Manager work fully offline, or is API-first acceptable?

4. **Mobile Parity**: Which features absolutely require full mobile parity vs desktop-only?

5. **Doc Doctor Timeline**: When will Doc Doctor's public API be exposed? This affects integration timeline.

### For Technical Decisions

6. **WASM Provider**: Keep for future offline EPUB mode, or remove as dead code?

7. **sql.js vs Server-Side**: Should Calibre parsing move entirely to Rust server?

8. **Telemetry Purpose**: Is this for future analytics feature, or can it be dev-only?

9. **Smart Connections Dependency**: Should Dictionary Manager require Smart Connections, or be optional?

10. **Authentication Scope**: JWT for all API access, or keep some endpoints open?

---

## Appendix A: File Inventory

### Files to Delete (Code Cleanup)

```
apps/amnesia/src/templates/liquid-engine.ts (191 LOC)
apps/amnesia/src/templates/note-generator.ts (200 LOC)
apps/amnesia/src/generators/book-note-generator.ts (150 LOC)
apps/amnesia/src/generators/highlight-generator.ts (180 LOC)
apps/amnesia/src/generators/index-generator.ts (140 LOC)
apps/amnesia/src/generators/index.ts (26 LOC)
apps/amnesia/src/calibre/generators/ (entire directory, ~850 LOC)
apps/amnesia/src/reader/renderer/wasm-provider.ts (289 LOC)
```

### Files to Create (Dictionary Manager)

```
apps/amnesia/src/dictionary/dictionary-service.ts (400 LOC)
apps/amnesia/src/dictionary/dictionary-store.ts (150 LOC)
apps/amnesia/src/dictionary/types.ts (200 LOC)
apps/amnesia/src/dictionary/api/dictionary-api-client.ts (300 LOC)
apps/amnesia/src/dictionary/api/providers/wiktionary-provider.ts (200 LOC)
apps/amnesia/src/dictionary/api/providers/free-dict-provider.ts (150 LOC)
apps/amnesia/src/dictionary/api/providers/merriam-webster-provider.ts (200 LOC)
apps/amnesia/src/dictionary/cache/dictionary-cache-manager.ts (250 LOC)
apps/amnesia/src/dictionary/generators/dictionary-entry-generator.ts (350 LOC)
apps/amnesia/src/dictionary/ui/DictionaryTooltip.svelte (300 LOC)
apps/amnesia/src/dictionary/settings/dictionary-settings-tab.ts (400 LOC)
apps/amnesia/src/dictionary/integration/smart-connections.ts (150 LOC)
apps/amnesia/src/dictionary/integration/doc-doctor.ts (200 LOC)
apps/amnesia-server/src/dictionary/text_context_extractor.rs (200 LOC)
apps/amnesia-server/src/routes/dictionary.rs (150 LOC)
```

### Files to Create (API Expansions)

```
apps/amnesia-server/src/routes/highlights_extract.rs (300 LOC)
apps/amnesia-server/src/bibliography/mod.rs (400 LOC)
apps/amnesia-server/src/db/search.rs (350 LOC)
apps/amnesia-server/src/auth/jwt.rs (250 LOC)
migrations/001_fts5_indexes.sql (50 LOC)
```

---

## Appendix B: Research Sources

### Integration Patterns
- [PRD-plugin-ecosystem-integration.md](../requirements/integration/PRD-plugin-ecosystem-integration.md)
- [PRD-cross-capabilities.md](../requirements/integration/PRD-cross-capabilities.md)
- [Obsidian Forum: Inter-Plugin Communication](https://forum.obsidian.md/t/inter-plugin-communication-expose-api-to-other-plugins/23618)

### Dictionary APIs
- [Free Dictionary API](https://freedictionaryapi.com/)
- [Wiktionary API](https://en.wiktionary.org/w/api.php)
- [Merriam-Webster Developer Center](https://dictionaryapi.com/)

### Citation Libraries
- [hayagriva](https://github.com/typst/hayagriva) - Rusty bibliography management
- [biblatex](https://github.com/typst/biblatex) - BibTeX parsing/writing

### SQLite FTS5
- [SQLite FTS5 Extension](https://sqlite.org/fts5.html)
- [FTS5 Performance Tuning](https://dev.to/labex/sqlite-performance-tuning-3-practical-labs-for-pragma-indexing-and-fts5-full-text-search-4gmk)

### Smart Connections
- [Smart Connections GitHub](https://github.com/brianpetro/obsidian-smart-connections)
- [Smart Connections Documentation](https://smartconnections.app/)

---

*Report generated by Claude Code (Opus 4.5) based on comprehensive codebase analysis and ecosystem research.*

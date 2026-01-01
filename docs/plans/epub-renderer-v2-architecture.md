# Los Libros EPUB Reader: Complete Architectural Redesign (Option 4)

## Executive Summary

Replace iframe-based renderer with Shadow DOM + Dual Navigator system to eliminate RAF throttling, event bubbling issues, and sub-pixel drift while achieving industry-standard position tracking.

---

## Current Architecture Problems

| Problem | Symptom | Root Cause |
|---------|---------|------------|
| RAF throttling | Mode switch hangs, initialization delays 100-300ms | Browsers throttle RAF in iframes |
| Event bubbling | Hotkeys don't work while reading | Events don't bubble out of iframes |
| Memory overhead | Large books lag (~15MB extra per book) | Iframe is heavy DOM object |
| Sub-pixel drift | Column misalignment after many page turns | Separate document context rounding |
| Code complexity | Renderer.ts is 37,133 tokens | Monolithic file structure |

---

## Target Architecture: 5 Layers

```
┌──────────────────────────────────────────────────────────────────┐
│ Layer 1: Shadow DOM Foundation                                    │
│  └── contentEl.attachShadow({ mode: 'open' })                    │
│       ├── <style> (base + sanitized EPUB CSS)                    │
│       └── <div id="navigator-mount">                             │
├──────────────────────────────────────────────────────────────────┤
│ Layer 2: Streamer (WASM Parser - Enhance Existing)               │
│  ├── Parse EPUB ZIP container                                    │
│  ├── Generate WebPublicationManifest (JSON)                      │
│  └── Provide chapter content as sanitized HTML                   │
├──────────────────────────────────────────────────────────────────┤
│ Layer 3: Dual Navigator System                                    │
│  ├── PaginatedNavigator                                          │
│  │    ├── CSS Columns (integer-forced widths)                    │
│  │    ├── translate3d for page turns                             │
│  │    └── CSS scroll-snap for native gestures                    │
│  └── ScrolledNavigator                                           │
│       ├── TanStack Virtual / Custom virtualizer                  │
│       ├── Spine-level virtualization                             │
│       └── ResizeObserver for height measurement                  │
├──────────────────────────────────────────────────────────────────┤
│ Layer 4: Locator Model (State Management)                         │
│  ├── CFI generation/parsing (even/odd indexing)                  │
│  ├── Fuzzy anchoring (Levenshtein distance)                      │
│  └── Multi-selector fallback chain                               │
├──────────────────────────────────────────────────────────────────┤
│ Layer 5: CSS Custom Highlight API                                 │
│  └── Works in Shadow DOM, no coordinate transformation           │
└──────────────────────────────────────────────────────────────────┘
```

---

## New File Structure

```
apps/los-libros/src/reader/
├── reader-view.ts                    # MODIFY: Use Shadow DOM
├── shadow-dom-view.ts                # NEW: Shadow root setup
├── streamer/                         # NEW: Layer 2
│   ├── wasm-streamer.ts
│   ├── manifest.ts
│   └── sanitizer.ts
├── navigator/                        # NEW: Layer 3
│   ├── navigator-interface.ts
│   ├── navigator-factory.ts
│   ├── paginated-navigator.ts
│   ├── scrolled-navigator.ts
│   └── virtual-scroller.ts
├── locator/                          # NEW: Layer 4
│   ├── locator-service.ts
│   ├── cfi-parser.ts
│   ├── fuzzy-anchor.ts
│   └── types.ts
├── highlights/                       # ENHANCE: Layer 5
│   └── css-highlight-renderer.ts
└── renderer/                         # LEGACY (remove after migration)
    ├── renderer.ts                   # → Split into navigators
    ├── paginator.ts                  # → paginated-navigator.ts
    ├── scroller.ts                   # → scrolled-navigator.ts
    └── overlay.ts                    # → DELETE (CSS highlights replace)
```

---

## Implementation Phases

### Phase 1: Shadow DOM Foundation (Week 1)
**Goal:** Replace iframe with Shadow DOM, verify CSS isolation

**Files:**
- `apps/los-libros/src/reader/shadow-dom-view.ts` (NEW)
- `apps/los-libros/src/reader/reader-view.ts` (MODIFY)

**Tasks:**
1. Create ShadowDOMView class with base setup
2. Modify ReaderView to initialize Shadow DOM
3. Test CSS isolation (book styles don't leak)
4. Verify hotkeys work without forwarding
5. Benchmark: expect ~15MB memory savings

**Success Criteria:**
- [ ] Book renders in Shadow DOM
- [ ] CSS fully isolated
- [ ] Keyboard navigation works
- [ ] No performance regression

---

### Phase 2: Streamer Enhancement (Week 2)
**Goal:** Structured WebPublicationManifest output

**Files:**
- `apps/los-libros/src/reader/streamer/wasm-streamer.ts` (NEW)
- `apps/los-libros/src/reader/streamer/manifest.ts` (NEW)
- `apps/los-libros/src/reader/streamer/sanitizer.ts` (NEW)

**Tasks:**
1. Define WebPublicationManifest interface
2. Create wasm-streamer wrapper for existing parser
3. Implement HTML sanitization (strip scripts, dangerous CSS)
4. Add IndexedDB caching for parsed manifests
5. Keep server fallback for files >10MB

**Success Criteria:**
- [ ] Manifest cached in IndexedDB
- [ ] Initial load <1s for cached books
- [ ] HTML sanitized (no scripts)

---

### Phase 3: Paginated Navigator (Weeks 3-4)
**Goal:** Zero sub-pixel drift, smooth animations

**Files:**
- `apps/los-libros/src/reader/navigator/navigator-interface.ts` (NEW)
- `apps/los-libros/src/reader/navigator/paginated-navigator.ts` (NEW)
- `apps/los-libros/src/reader/navigator/navigator-factory.ts` (NEW)

**Key Algorithm - Sub-Pixel Prevention:**
```typescript
// Force integer widths at every step
const integerWidth = Math.floor(rect.width);
const columnWidth = Math.floor((integerWidth - gaps) / columns);
const exactViewportWidth = columnWidth * columns + gaps;
// Result: Zero drift because all dimensions are exact integers
```

**Tasks:**
1. Implement Navigator interface
2. Create PaginatedNavigator with integer-forced column widths
3. Use CSS scroll-snap for native gesture handling
4. Migrate gesture code from existing paginator.ts
5. Add anchor system for position tracking

**Success Criteria:**
- [ ] Zero drift across 100+ page turns
- [ ] Smooth 60fps animations
- [ ] Accurate position restoration after resize
- [ ] Page turn latency <50ms

---

### Phase 4: Scrolled Navigator (Weeks 5-6)
**Goal:** Virtual scrolling for constant memory usage

**Files:**
- `apps/los-libros/src/reader/navigator/scrolled-navigator.ts` (NEW)
- `apps/los-libros/src/reader/navigator/virtual-scroller.ts` (NEW)

**Tasks:**
1. Create ScrolledNavigator with spine-level virtualization
2. Implement virtual scroller (TanStack Virtual or custom)
3. Add ResizeObserver for dynamic height measurement
4. Test with large books (1000+ chapters)
5. Benchmark memory usage (should be constant)

**Success Criteria:**
- [ ] Constant memory regardless of book size
- [ ] Smooth 60fps scrolling
- [ ] Fast chapter loading (<100ms)
- [ ] No layout jumps during virtualization

---

### Phase 5: Locator System (Weeks 7-8)
**Goal:** Industry-standard position persistence

**Files:**
- `apps/los-libros/src/reader/locator/locator-service.ts` (NEW)
- `apps/los-libros/src/reader/locator/cfi-parser.ts` (NEW)
- `apps/los-libros/src/reader/locator/fuzzy-anchor.ts` (NEW)
- `apps/los-libros/src/reader/locator/types.ts` (NEW)

**Locator Interface:**
```typescript
interface Locator {
  href: string;           // Spine item href
  locations: {
    progression: number;  // 0.0 - 1.0 within resource
    cfi?: string;         // Canonical Fragment Identifier
  };
  text?: {
    before?: string;      // Context for fuzzy matching
    highlight?: string;
    after?: string;
  };
}
```

**Anchoring Strategy:**
1. Try CFI (exact DOM path)
2. Try text context search (exact match)
3. Try fuzzy search (Levenshtein ≤10% threshold)
4. Fallback to progression

**Success Criteria:**
- [ ] Positions survive font size changes
- [ ] Highlights restore after book updates (95%+ success)
- [ ] Re-anchoring <100ms per highlight

---

### Phase 6: CSS Highlight Integration (Week 9)
**Goal:** Replace SVG overlay with CSS Custom Highlight API

**Files:**
- `apps/los-libros/src/reader/highlights/css-highlight-renderer.ts` (ENHANCE)

**Tasks:**
1. Enhance for Shadow DOM context
2. Integrate with LocatorService for re-anchoring
3. Remove SVG overlay dependency
4. Test highlight movement during animations

**Success Criteria:**
- [ ] Highlights move atomically with text
- [ ] No coordinate transformation needed
- [ ] 5x faster rendering vs SVG

---

### Phase 7: Integration & Cleanup (Weeks 10-11)
**Goal:** Connect all layers, remove legacy code

**Tasks:**
1. Update reader-view.ts to orchestrate new components
2. Delete legacy files: renderer.ts, paginator.ts, scroller.ts, overlay.ts
3. Migrate all settings to NavigatorConfig
4. Comprehensive regression testing
5. Performance benchmarking

**Files to Delete:**
- `apps/los-libros/src/reader/renderer/renderer.ts`
- `apps/los-libros/src/reader/renderer/paginator.ts`
- `apps/los-libros/src/reader/renderer/scroller.ts`
- `apps/los-libros/src/reader/renderer/overlay.ts`

---

## Performance Targets

| Metric | Current | Target |
|--------|---------|--------|
| Initial Load | 2-3s | <1s |
| Page Turn | 150ms | <50ms |
| Scroll FPS | 30fps | 60fps |
| Highlight Render | 50ms (SVG) | <10ms (CSS) |
| Re-anchor 100 Highlights | 1000ms | <500ms |
| Memory (iframe overhead) | 15MB | 0MB |

---

## What's Reusable

**Keep As-Is:**
- DocumentRenderer interface (format-agnostic design)
- HighlightAnchor (re-anchoring logic)
- CSSHighlightManager (already modern)
- ApiClient (caching, preloading)
- Annotation data model (W3C compliant)
- Sidebar tabs (clean UI components)

**Migrate Logic:**
- paginator.ts → paginated-navigator.ts
- scroller.ts → scrolled-navigator.ts
- cfi-utils.ts → locator/cfi-parser.ts

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| WASM parser performance | Medium | Server fallback for >10MB files |
| Fuzzy anchoring false positives | Medium | 10% Levenshtein threshold + context matching |
| Shadow DOM event quirks | Low | Comprehensive event testing |

**Eliminated Risks (due to prototype status):**
- ~~CSS Highlight API support~~ → Require Chromium (guaranteed)
- ~~Migration complexity~~ → Direct replacement, no migration

---

## Decisions Made

| Question | Decision | Rationale |
|----------|----------|-----------|
| Server Dependency | **Hybrid** | WASM for <10MB, server fallback for larger |
| CSS Highlight Fallback | **Require Chromium** | Obsidian uses Chromium, simplifies code |
| Migration Strategy | **Direct Replacement** | Prototype status, no migration concerns |
| Backward Compatibility | **Breaking Changes OK** | Delete old code as we replace it |

**Key Simplifications:**
- No feature flags needed
- No data migration code
- Delete legacy code immediately when replacing
- No backward compatibility layer

---

## Timeline Summary

| Phase | Duration | Key Deliverable |
|-------|----------|-----------------|
| 1. Shadow DOM | 1 week | iframe → Shadow DOM |
| 2. Streamer | 1 week | WASM parser + caching |
| 3. Paginated Navigator | 2 weeks | Zero drift pagination |
| 4. Scrolled Navigator | 2 weeks | Virtual scrolling |
| 5. Locator System | 2 weeks | CFI + fuzzy anchoring |
| 6. CSS Highlights | 1 week | Replace SVG overlay |
| 7. Integration | 2 weeks | Remove legacy, testing |
| **Total** | **11 weeks** | Complete redesign |

---

## Comprehensive Benchmarking System

### Performance Targets & Measurement

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| Initial Load (cold) | <1000ms | `performance.mark()` from `openBook()` to first paint |
| Initial Load (cached) | <500ms | Same, with IndexedDB-cached manifest |
| Page Turn Latency | <50ms | RAF timestamp diff during `next()`/`prev()` |
| Mode Switch Latency | <200ms | Time from mode change to stable render |
| Highlight Render (100 highlights) | <100ms | Batch `CSS.highlights.set()` timing |
| Re-anchor 100 Highlights | <500ms | `LocatorService.anchorToDOM()` loop |
| Scroll FPS (Scrolled mode) | 60fps | Frame drop rate during scroll |
| Memory Baseline | <50MB | Heap snapshot after book load |
| Memory After 30min Reading | <100MB | Heap snapshot after simulated reading |
| Memory per Additional Book | <30MB | Delta between 1 and 2 books open |

### Benchmark Script Structure

**File:** `apps/los-libros/src/testing/benchmark.ts`

```typescript
interface BenchmarkResult {
  metric: string;
  value: number;
  unit: string;
  target: number;
  pass: boolean;
  percentOfTarget: number;
}

interface BenchmarkReport {
  timestamp: Date;
  environment: {
    platform: string;
    obsidianVersion: string;
    nodeVersion: string;
    memoryTotal: number;
  };
  results: BenchmarkResult[];
  overallPass: boolean;
}

class BenchmarkSuite {
  private results: BenchmarkResult[] = [];

  // === TIMING BENCHMARKS ===

  async measureInitialLoad(bookPath: string, cached: boolean): Promise<BenchmarkResult> {
    // Clear cache if testing cold load
    if (!cached) {
      await this.clearIndexedDBCache();
    }

    performance.mark('load-start');
    await this.reader.openBook(bookPath);
    performance.mark('load-end');

    const measure = performance.measure('initial-load', 'load-start', 'load-end');
    const target = cached ? 500 : 1000;

    return {
      metric: cached ? 'Initial Load (cached)' : 'Initial Load (cold)',
      value: measure.duration,
      unit: 'ms',
      target,
      pass: measure.duration <= target,
      percentOfTarget: (measure.duration / target) * 100
    };
  }

  async measurePageTurnLatency(iterations: number = 20): Promise<BenchmarkResult> {
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await this.navigator.next();
      const end = performance.now();
      latencies.push(end - start);

      // Wait for animations to settle
      await this.waitForIdleFrame();
    }

    // Use P95 to exclude outliers
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];

    return {
      metric: 'Page Turn Latency (P95)',
      value: p95,
      unit: 'ms',
      target: 50,
      pass: p95 <= 50,
      percentOfTarget: (p95 / 50) * 100
    };
  }

  async measureModeSwitchLatency(): Promise<BenchmarkResult> {
    // Ensure we're in paginated mode
    await this.navigator.setMode('paginated');
    await this.waitForStableRender();

    performance.mark('mode-switch-start');
    await this.navigator.setMode('scrolled');
    await this.waitForStableRender();
    performance.mark('mode-switch-end');

    const measure = performance.measure('mode-switch', 'mode-switch-start', 'mode-switch-end');

    return {
      metric: 'Mode Switch Latency',
      value: measure.duration,
      unit: 'ms',
      target: 200,
      pass: measure.duration <= 200,
      percentOfTarget: (measure.duration / 200) * 100
    };
  }

  // === HIGHLIGHT BENCHMARKS ===

  async measureHighlightRender(count: number = 100): Promise<BenchmarkResult> {
    // Generate test highlights
    const highlights = this.generateTestHighlights(count);

    performance.mark('highlight-start');
    for (const hl of highlights) {
      this.highlightRenderer.add(hl.id, hl.range, hl.color);
    }
    performance.mark('highlight-end');

    const measure = performance.measure('highlight-render', 'highlight-start', 'highlight-end');

    // Cleanup
    for (const hl of highlights) {
      this.highlightRenderer.remove(hl.id);
    }

    return {
      metric: `Highlight Render (${count})`,
      value: measure.duration,
      unit: 'ms',
      target: 100,
      pass: measure.duration <= 100,
      percentOfTarget: (measure.duration / 100) * 100
    };
  }

  async measureReanchorHighlights(count: number = 100): Promise<BenchmarkResult> {
    // Create locators from current DOM
    const locators = await this.generateLocators(count);

    // Simulate content change (font size)
    await this.navigator.setFontSize(this.navigator.getFontSize() + 2);
    await this.waitForStableRender();

    // Re-anchor
    performance.mark('reanchor-start');
    let successCount = 0;
    for (const locator of locators) {
      const range = await LocatorService.anchorToDOM(locator, this.shadowRoot);
      if (range) successCount++;
    }
    performance.mark('reanchor-end');

    const measure = performance.measure('reanchor', 'reanchor-start', 'reanchor-end');

    return {
      metric: `Re-anchor ${count} Highlights`,
      value: measure.duration,
      unit: 'ms',
      target: 500,
      pass: measure.duration <= 500 && successCount >= count * 0.95,
      percentOfTarget: (measure.duration / 500) * 100
    };
  }

  // === SCROLL FPS BENCHMARK ===

  async measureScrollFPS(): Promise<BenchmarkResult> {
    await this.navigator.setMode('scrolled');
    await this.waitForStableRender();

    const frameTimings: number[] = [];
    let lastFrameTime = performance.now();
    let frameCount = 0;

    // Simulate 3 seconds of scrolling
    const scrollDuration = 3000;
    const startTime = performance.now();

    const recordFrame = () => {
      const now = performance.now();
      frameTimings.push(now - lastFrameTime);
      lastFrameTime = now;
      frameCount++;

      if (now - startTime < scrollDuration) {
        // Simulate scroll
        this.shadowRoot.scrollTop += 5;
        requestAnimationFrame(recordFrame);
      }
    };

    await new Promise<void>(resolve => {
      requestAnimationFrame(recordFrame);
      setTimeout(resolve, scrollDuration + 100);
    });

    // Calculate frame drops (frames > 16.67ms are drops at 60fps)
    const droppedFrames = frameTimings.filter(t => t > 16.67).length;
    const dropRate = (droppedFrames / frameTimings.length) * 100;
    const effectiveFPS = 1000 / (frameTimings.reduce((a, b) => a + b, 0) / frameTimings.length);

    return {
      metric: 'Scroll FPS',
      value: effectiveFPS,
      unit: 'fps',
      target: 60,
      pass: effectiveFPS >= 55 && dropRate < 5,
      percentOfTarget: (effectiveFPS / 60) * 100
    };
  }

  // === MEMORY BENCHMARKS ===

  async measureMemoryBaseline(): Promise<BenchmarkResult> {
    // Force GC if available
    if ((window as any).gc) {
      (window as any).gc();
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    const memory = (performance as any).memory;
    const usedHeapMB = memory.usedJSHeapSize / (1024 * 1024);

    return {
      metric: 'Memory Baseline',
      value: usedHeapMB,
      unit: 'MB',
      target: 50,
      pass: usedHeapMB <= 50,
      percentOfTarget: (usedHeapMB / 50) * 100
    };
  }

  async measureMemoryLeak(durationMinutes: number = 5): Promise<BenchmarkResult> {
    const initialMemory = (performance as any).memory.usedJSHeapSize;

    // Simulate reading: navigate, highlight, mode switch
    for (let i = 0; i < durationMinutes * 60; i++) {
      await this.navigator.next();
      if (i % 10 === 0) {
        // Create and remove highlight every 10 pages
        const hl = this.createTestHighlight();
        this.highlightRenderer.add(hl.id, hl.range, hl.color);
        await new Promise(resolve => setTimeout(resolve, 100));
        this.highlightRenderer.remove(hl.id);
      }
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1 page per second
    }

    // Force GC
    if ((window as any).gc) {
      (window as any).gc();
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    const finalMemory = (performance as any).memory.usedJSHeapSize;
    const leakMB = (finalMemory - initialMemory) / (1024 * 1024);
    const leakPerMinute = leakMB / durationMinutes;

    return {
      metric: 'Memory Leak Rate',
      value: leakPerMinute,
      unit: 'MB/min',
      target: 1, // Less than 1MB/min leak is acceptable
      pass: leakPerMinute <= 1,
      percentOfTarget: (leakPerMinute / 1) * 100
    };
  }

  // === RUNNER ===

  async runFullSuite(bookPath: string): Promise<BenchmarkReport> {
    console.log('Starting benchmark suite...');

    this.results = [];

    // Open test book
    await this.reader.openBook(bookPath);

    // Run all benchmarks
    this.results.push(await this.measureInitialLoad(bookPath, false));
    this.results.push(await this.measureInitialLoad(bookPath, true));
    this.results.push(await this.measurePageTurnLatency());
    this.results.push(await this.measureModeSwitchLatency());
    this.results.push(await this.measureHighlightRender(100));
    this.results.push(await this.measureReanchorHighlights(100));
    this.results.push(await this.measureScrollFPS());
    this.results.push(await this.measureMemoryBaseline());

    // Generate report
    const report: BenchmarkReport = {
      timestamp: new Date(),
      environment: {
        platform: navigator.platform,
        obsidianVersion: (window as any).app?.version || 'unknown',
        nodeVersion: process.versions?.node || 'unknown',
        memoryTotal: (performance as any).memory?.jsHeapSizeLimit / (1024 * 1024) || 0
      },
      results: this.results,
      overallPass: this.results.every(r => r.pass)
    };

    // Log results
    console.table(this.results.map(r => ({
      Metric: r.metric,
      Value: `${r.value.toFixed(2)} ${r.unit}`,
      Target: `${r.target} ${r.unit}`,
      Status: r.pass ? 'PASS' : 'FAIL',
      '%': `${r.percentOfTarget.toFixed(1)}%`
    })));

    return report;
  }

  // === UTILITIES ===

  private async waitForIdleFrame(): Promise<void> {
    return new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  private async waitForStableRender(): Promise<void> {
    return new Promise(resolve => {
      let lastScrollHeight = 0;
      const check = () => {
        const currentHeight = this.shadowRoot.scrollHeight;
        if (currentHeight === lastScrollHeight) {
          resolve();
        } else {
          lastScrollHeight = currentHeight;
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
  }
}
```

### Benchmark CLI Command

**File:** `apps/los-libros/src/commands/run-benchmarks.ts`

```typescript
import { Notice, Plugin } from 'obsidian';

export function registerBenchmarkCommand(plugin: Plugin): void {
  plugin.addCommand({
    id: 'run-benchmark-suite',
    name: 'Run Benchmark Suite',
    callback: async () => {
      new Notice('Starting benchmark suite...');

      // Find an EPUB in vault for testing
      const testBooks = plugin.app.vault.getFiles()
        .filter(f => f.extension === 'epub')
        .sort((a, b) => a.stat.size - b.stat.size); // Start with smallest

      if (testBooks.length === 0) {
        new Notice('No EPUB files found in vault for benchmarking');
        return;
      }

      const benchmark = new BenchmarkSuite(plugin);
      const report = await benchmark.runFullSuite(testBooks[0].path);

      // Save report to vault
      const reportPath = `los-libros-benchmark-${Date.now()}.json`;
      await plugin.app.vault.create(reportPath, JSON.stringify(report, null, 2));

      new Notice(
        report.overallPass
          ? 'Benchmark passed! Report saved.'
          : 'Benchmark failed. Check console for details.'
      );
    }
  });
}
```

### Test Corpus

For consistent benchmarking, use these book categories:

| Category | Size | Chapter Count | Purpose |
|----------|------|---------------|---------|
| Small | <1MB | 5-10 | Fast iteration |
| Medium | 5-10MB | 50-100 | Typical use case |
| Large | 20-50MB | 200+ | Stress testing |
| Huge | >100MB | 500+ | Edge case (omnibus) |

---

## E2E Testing Strategy (Obsidian DevTools MCP)

### Overview

Use the Obsidian DevTools MCP server to:
1. Execute JS in Obsidian renderer context
2. Capture screenshots for visual regression
3. Monitor console for errors
4. Inspect plugin state via store values
5. Trigger commands programmatically

### Test Categories

1. **Lifecycle Tests** - Shadow DOM creation, memory cleanup
2. **Navigation Tests** - Page turns, sub-pixel drift verification
3. **Highlight Tests** - CSS Custom Highlight API, persistence after resize
4. **Position Persistence** - CFI generation/resolution, fuzzy anchoring
5. **Visual Regression** - Screenshot comparison for UI states

### Test Runner Configuration

```javascript
// test/e2e/jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 60000, // E2E tests can be slow
  setupFilesAfterEnv: ['./setup.ts'],
  testMatch: ['**/*.test.ts'],
  reporters: [
    'default',
    ['jest-html-reporter', {
      pageTitle: 'Los Libros E2E Test Report',
      outputPath: 'test/reports/e2e-report.html',
      includeFailureMsg: true,
      includeConsoleLog: true
    }]
  ]
};
```

### Test Execution Scripts

```json
{
  "scripts": {
    "test:e2e": "jest --config test/e2e/jest.config.js",
    "test:e2e:watch": "jest --config test/e2e/jest.config.js --watch",
    "test:benchmark": "ts-node test/benchmark/run.ts",
    "test:visual": "jest --config test/e2e/jest.config.js --testPathPattern=visual"
  }
}
```

---

*Generated: 2025-12-31*
*Plan Version: 1.0*

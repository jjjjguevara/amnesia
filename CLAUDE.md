# CLAUDE.md - Amnesia Development Guide

> This document captures learnings, patterns, and best practices from debugging sessions with Claude Code.

## Project Overview

Amnesia is an Obsidian plugin for reading EPUBs and PDFs. The plugin uses:
- **Svelte** for UI components
- **Shadow DOM** for isolated EPUB rendering
- **CSS Multi-Column Layout** for paginated reading
- **Transform-based navigation** for smooth page turns

## Key Files

| File | Purpose |
|------|---------|
| `apps/amnesia/src/reader/navigator/paginated-navigator.ts` | Core pagination logic, column calculation, navigation |
| `apps/amnesia/src/reader/shadow-dom-renderer.ts` | Shadow DOM content loading, mode switching |
| `apps/amnesia/src/reader/shadow-dom-view.ts` | Container management, CSS variables |
| `apps/amnesia/src/main.ts` | Plugin entry point, service initialization |
| `apps/amnesia/src/settings/settings.ts` | Plugin settings interface and defaults |
| `apps/amnesia/src/settings/settings-tab/` | Tabbed settings UI (Library, Reading, Sync, Notes, Advanced) |
| `apps/amnesia/src/settings/templates-settings-tab.ts` | Liquid template configuration for note generation |

## Build & Deploy

```bash
# Build the plugin
npm run build

# The built file goes to:
# apps/amnesia/temp/vault/.obsidian/plugins/amnesia/main.js

# IMPORTANT: Copy to actual vault for testing
cp apps/amnesia/temp/vault/.obsidian/plugins/amnesia/main.js \
   "/path/to/your/vault/.obsidian/plugins/amnesia/main.js"
```

## Obsidian DevTools MCP Usage

The Obsidian DevTools MCP server is essential for live debugging:

### Connection

```javascript
// Always connect first
mcp__obsidian-devtools__obsidian_connect()

// Get vault info to find the correct plugin path
mcp__obsidian-devtools__obsidian_get_vault_info()
```

### Accessing the Reader

```javascript
// The reader is nested in Svelte component context
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  const view = leaves[0]?.view;
  const component = view.component;
  const ctx = component.$$.ctx;

  // Reader is typically at index 3 in Svelte context
  const reader = ctx[3];
  const navigator = reader?.navigator;

  return { navigator, reader };
})();
```

### Live CSS Manipulation

Test fixes on the DOM before modifying code:

```javascript
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  const view = leaves[0].view;
  const contentEl = view.contentEl;

  // Find Shadow DOM
  let shadowRoot = null;
  for (const el of contentEl.querySelectorAll('*')) {
    if (el.shadowRoot) {
      shadowRoot = el.shadowRoot;
      break;
    }
  }

  // Manipulate elements
  const chapters = shadowRoot.querySelectorAll('.epub-chapter');
  for (const ch of chapters) {
    ch.style.someProperty = 'newValue';
  }
})();
```

### Navigation Testing

```javascript
(async function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  const view = leaves[0].view;
  const ctx = view.component.$$.ctx;
  const nav = ctx[3].navigator;

  // Navigate to specific chapter
  await nav.goTo({ type: 'position', position: 50 });

  // Test next/prev
  await nav.next();
  await nav.prev();

  return {
    currentColumn: nav.currentColumn,
    currentSpineIndex: nav.currentSpineIndex
  };
})();
```

### Checking Console Logs

```javascript
mcp__obsidian-devtools__obsidian_get_console_logs({ level: 'error', limit: 20 })
mcp__obsidian-devtools__obsidian_get_console_logs({ level: 'all', limit: 50 })
```

### Reloading Plugin

```javascript
mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })
```

## CSS Multi-Column Layout Pitfalls

### The `scrollWidth` Trap

**Problem**: `scrollWidth` returns the container width, NOT the content extent.

```javascript
// WRONG: This returns container width, not content width
const columns = Math.ceil(element.scrollWidth / columnWidth);

// When you set width to 14000px with column-width: 586px,
// scrollWidth returns 14000px, NOT the actual content extent
```

**Solution**: Measure actual content positions:

```javascript
// CORRECT: Count unique column positions of content elements
function measureActualColumnCount(chapterEl, containerWidth) {
  const elements = chapterEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
  const chapterRect = chapterEl.getBoundingClientRect();
  const columnPositions = new Set();

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

### Column Width Formula

For N columns with gap between them:

```javascript
width = N * columnWidth + (N - 1) * gap
// Example: 5 columns, 586px width, 60px gap
// width = 5 * 586 + 4 * 60 = 2930 + 240 = 3170px
```

### Absolute Positioning and Padding

**Problem**: Absolutely positioned elements ignore container padding.

```css
/* Container has padding: 40px */
.container {
  padding: 40px 0px;
}

/* Child with top: 0 is at container's top edge, NOT after padding */
.chapter {
  position: absolute;
  top: 0; /* This ignores the 40px padding! */
}
```

**Solution**: Explicitly offset by the margin:

```javascript
chapterEl.style.top = `${effectiveMargin}px`;
```

### Two-Phase Column Measurement

The correct approach for measuring columns:

**Phase 1**: Use `column-width` to let browser flow content naturally:
```javascript
chapterEl.style.columnWidth = '586px';
chapterEl.style.width = '10000px'; // Large width as buffer
```

**Phase 2**: After DOM insertion, measure actual content and lock with `column-count`:
```javascript
requestAnimationFrame(() => {
  const actualColumns = measureActualColumnCount(chapterEl, containerWidth);
  chapterEl.style.columnWidth = ''; // Remove
  chapterEl.style.columnCount = String(actualColumns);
  chapterEl.style.width = calculateWidth(actualColumns);
});
```

## Debugging Patterns

### Symptom: Blank Pages When Navigating

**Cause**: Column count over-estimation creates gaps between chapters.

**Diagnosis**:
1. Check chapter widths - are they much larger than content needs?
2. Compare CSS `column-count` vs actual content columns
3. Look for gaps between chapter positions

```javascript
// Diagnostic: Check chapter column counts
const chapters = shadowRoot.querySelectorAll('.epub-chapter');
for (const ch of chapters) {
  const style = getComputedStyle(ch);
  const cssColumns = parseInt(style.columnCount);
  const actualColumns = measureActualColumnCount(ch, 646);
  console.log(`CSS: ${cssColumns}, Actual: ${actualColumns}, Ratio: ${cssColumns/actualColumns}`);
}
```

### Symptom: Content Missing Top/Bottom Margin

**Cause**: Absolute positioning ignores container padding.

**Diagnosis**:
1. Check chapter `top` value - is it 0?
2. Check container padding values
3. Check chapter height calculation

### Symptom: Transform Drift

**Cause**: Column offsets not matching actual layout.

**Diagnosis**:
```javascript
// Check transform vs expected position
const pageWidth = 646;
const expectedTransform = -(currentColumn * pageWidth);
const actualTransform = parseFloat(container.style.transform.match(/-?\d+/)[0]);
const drift = actualTransform - expectedTransform;
console.log(`Drift: ${drift}px`);
```

## Code Patterns

### Safe Chapter Element Access

```javascript
const chapterEl = this.chapterElements.get(index);
if (!chapterEl) return;
```

### Consistent Dimension Calculation

```javascript
// Always use integer dimensions to prevent sub-pixel drift
const { width, height } = this.getIntegerDimensions();

private getIntegerDimensions(): { width: number; height: number } {
  const rect = this.container.parentElement.getBoundingClientRect();
  return {
    width: Math.floor(rect.width),
    height: Math.floor(rect.height),
  };
}
```

### Animation Lock Pattern

```javascript
if (this.isAnimating) {
  // Queue update for later
  this.pendingUpdates.set(index, value);
  return;
}

// Apply update immediately
this.applyUpdate(index, value);
```

## Common Mistakes

### 1. Deploying to Wrong Location

Build output goes to `temp/vault/` but Obsidian loads from your actual vault's plugins folder. Always copy after build.

### 2. Using `column-width` Without Measurement

Setting `column-width` lets the browser decide column count, but you must measure the actual result before assuming a specific count.

### 3. Trusting `scrollWidth`

`scrollWidth` returns the element's box width, not how far content actually extends. For multi-column layouts, this is especially misleading.

### 4. Forgetting `requestAnimationFrame`

DOM measurements after modifications must wait for a frame:

```javascript
// WRONG: Measuring immediately
element.style.width = '1000px';
const width = element.scrollWidth; // May return old value

// CORRECT: Wait for frame
element.style.width = '1000px';
requestAnimationFrame(() => {
  const width = element.scrollWidth;
});
```

### 5. Not Checking Element Connection

```javascript
requestAnimationFrame(() => {
  if (!chapterEl.isConnected) return; // Element was removed
  // Safe to proceed
});
```

## Performance Considerations

### Chapter Virtualization

Only 5-7 chapters are loaded at any time:
- Current chapter
- ±2-3 chapters in each direction

Chapters outside this window become placeholders.

### Layout Batching

During animations, layout updates are queued and applied after animation completes to prevent jank.

### Column Measurement Caching

Once a chapter's column count is accurately measured, it's cached in `accurateColumnCounts` to avoid re-measurement.

## Testing Checklist

Before deploying pagination changes:

- [ ] Navigate forward 50+ pages - no blank pages
- [ ] Navigate backward 30+ pages - no drift
- [ ] Jump via ToC, then navigate - position accurate
- [ ] Switch reading mode (scrolled/paginated) - no errors
- [ ] Resize window - layout recalculates correctly
- [ ] Check margins in both modes match

## Collaboration Tips

### When Describing Bugs

Be specific about the visual symptom:
- "Text drifts right" vs "Transform value is wrong"
- "Blank pages at chapter end" vs "Column count mismatch"

### When Testing Fixes

1. First test with live CSS manipulation
2. Verify the fix works visually
3. Only then modify the TypeScript code
4. Build, copy to vault, reload plugin
5. Test again to confirm

### Using Screenshots

Obsidian DevTools can capture screenshots:
```javascript
mcp__obsidian-devtools__obsidian_capture_screenshot({ format: 'png' })
```

## Version History

| Version | Change |
|---------|--------|
| 0.4.0 (2026-01-07) | **PDF Rendering Optimization & HUD Feature**: Dual-resolution rendering (never show blank pages), spatial prefetching for grid modes, seamless mode transitions with cache preservation, background thumbnail generation. New HUD (Heads-Up Display) with Doc Doctor integration: status bar metrics, 5 tabbed views (Reading, Library, Stats, Server, Series), context-aware display, reading streaks and activity sparklines |
| 0.3.1 (2026-01-06) | Fixed PDF scroll/zoom in vertical-scroll and horizontal-scroll modes: resolved parent wheel handler conflict that caused unintended page navigation during scroll gestures |
| 0.3.0 (2026-01-04) | Calibre bidirectional sync (read/write API), advanced query API, library statistics, single-note sync command |
| 0.2.2 (2026-01-03) | Restructured settings UI: 5 tabs (Library, Reading, Sync, Notes, Advanced), integrated Liquid templates for note generation, added metadata mapping settings |
| 0.2.1 (2026-01-02) | Fixed column count over-estimation (4x → accurate), fixed vertical margins |

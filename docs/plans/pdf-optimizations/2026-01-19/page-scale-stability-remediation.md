# Page Scale Stability: Root-Cause Remediation Plan

> **Date**: 2026-01-19
> **Status**: Ready for Implementation
> **Council Verdict**: H1 + H3 confirmed as root cause (eliminate fitScale)

---

## Executive Summary

**Root Cause**: The `fitScale` CSS transform is applied AFTER tiles render, using CURRENT container dimensions. This creates a race condition where tiles rendered for one state are displayed with transforms calculated for a different state.

**The Fix**: Eliminate `fitScale` CSS transform entirely. Tiles should have:
- HIGH resolution buffers (for sharpness)
- FIXED CSS display size (matching page container)
- NO CSS scale transform

The camera transform is the ONLY zoom mechanism.

---

## Architecture: Before vs After

### BEFORE (Broken)

```
┌─────────────────────────────────────────────────────────────┐
│ Page Container: Variable size (changes with zoom)           │
│                                                              │
│   Tile Buffer: 3584×1680 pixels (high resolution)           │
│   CSS Transform: scale(0.22) ← fitScale (VARIABLE!)         │
│                                                              │
│   Camera Transform: scale(4) translate(x, y)                │
│                                                              │
│   Final Visual = Camera × fitScale × Buffer                 │
│   Two transforms fighting → DRIFT                           │
└─────────────────────────────────────────────────────────────┘
```

### AFTER (Fixed)

```
┌─────────────────────────────────────────────────────────────┐
│ Page Container: FIXED size (400×518 CSS pixels, ALWAYS)     │
│                                                              │
│   Tile Canvas: CSS width/height = page container size       │
│   Tile Buffer: High resolution (zoom × pixelRatio)          │
│   CSS Transform: NONE (or translate only for position)      │
│                                                              │
│   Camera Transform: scale(zoom) translate(x, y)             │
│                                                              │
│   Final Visual = Camera × Fixed Container                   │
│   Single transform → NO DRIFT                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Tasks

### Task 1: Remove fitScale from Canvas Transform

**File**: `src/reader/renderer/pdf/pdf-page-element.ts`
**Location**: `displayTiledPageTiles()` method (around line 798)

**Current Code (REMOVE)**:
```typescript
const fitScale = pdfToElementScale * dpr / expectedTileScale;
this.canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${fitScale})`;
```

**New Code**:
```typescript
// NO fitScale - canvas displays at fixed CSS size
// Position only (if needed for tile alignment)
this.canvas.style.transform = `translate(${translateX}px, ${translateY}px)`;
// Or: this.canvas.style.transform = 'none';
```

### Task 2: Set Fixed CSS Dimensions on Tile Canvas

**File**: `src/reader/renderer/pdf/pdf-page-element.ts`
**Location**: `renderTiles()` method

**Add after canvas creation**:
```typescript
// Canvas CSS size = page container size (FIXED, regardless of zoom)
const pageLogicalWidth = this.currentWidth;   // e.g., 400px
const pageLogicalHeight = this.currentHeight; // e.g., 518px

this.canvas.style.width = `${pageLogicalWidth}px`;
this.canvas.style.height = `${pageLogicalHeight}px`;

// Canvas buffer resolution = high (for sharpness)
// This is already correct: canvasWidth = tileBoundsWidth * tileScale
```

### Task 3: Ensure Page Container Never Resizes

**File**: `src/reader/renderer/pdf/pdf-page-element.ts`
**Location**: `setFinalDimensions()` method

**Current Code (REVIEW)**:
```typescript
setFinalDimensions(layout, newZoom) {
  const finalWidth = layout.width * newZoom;   // Container CHANGES with zoom!
  this.element.style.width = `${finalWidth}px`;
}
```

**New Code**:
```typescript
setFinalDimensions(layout, newZoom) {
  // Container size is FIXED at base dimensions
  // Camera transform handles visual zoom
  const baseWidth = layout.width;   // NO zoom multiplication
  const baseHeight = layout.height;

  this.element.style.width = `${baseWidth}px`;
  this.element.style.height = `${baseHeight}px`;

  // Store for reference
  this.currentWidth = baseWidth;
  this.currentHeight = baseHeight;
}
```

### Task 4: Verify Camera Transform is Sole Zoom Mechanism

**File**: `src/reader/renderer/pdf/pdf-infinite-canvas.ts`
**Location**: `applyTransform()` method

**Verify this is the ONLY place zoom is applied visually**:
```typescript
applyTransform() {
  const transform = `scale(${this.camera.z}) translate(${this.camera.x}px, ${this.camera.y}px)`;
  this.canvas.style.transform = transform;
  // This should be the ONLY CSS transform that includes scale
}
```

### Task 5: Remove TransformSnapshot Code (Revert Earlier Changes)

**Files**: `pdf-page-element.ts`, `pdf-infinite-canvas.ts`

Remove the TransformSnapshot code added in the incorrect earlier implementation:
- Remove `TransformSnapshot` interface
- Remove `getCurrentWidth()` / `getCurrentHeight()` methods (if not needed elsewhere)
- Remove snapshot capture in `pdf-infinite-canvas.ts`
- Remove snapshot parameter from `renderTiles()`

This code was trying to fix the symptom (timing mismatch) rather than the cause (fitScale existence).

---

## Code Changes Summary

| File | Change | Lines (approx) |
|------|--------|----------------|
| `pdf-page-element.ts` | Remove fitScale from transform | ~5 lines removed |
| `pdf-page-element.ts` | Add fixed CSS width/height to canvas | ~5 lines added |
| `pdf-page-element.ts` | Fix setFinalDimensions (no zoom mult) | ~5 lines changed |
| `pdf-page-element.ts` | Remove TransformSnapshot code | ~30 lines removed |
| `pdf-infinite-canvas.ts` | Remove snapshot capture code | ~20 lines removed |

**Net change**: ~50 lines removed (simplification)

---

## Verification Protocol

### Build & Deploy

```bash
cd apps/amnesia && npm run build:no-server

# Deploy to test vault
cp temp/vault/.obsidian/plugins/amnesia/main.js \
   "/Users/josueguevara/Library/Mobile Documents/iCloud~md~obsidian/Documents/test/.obsidian/plugins/amnesia/main.js"
```

### MCP Test

```javascript
mcp__obsidian-devtools__obsidian_connect()
mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })
mcp__obsidian-devtools__obsidian_trigger_command({ commandId: 'amnesia:open-book' })
```

### Manual Testing (CRITICAL)

1. Open PDF with Amnesia (verify leaf type is `amnesia-reader`)
2. **Zoom from 1x to 8x with real trackpad pinch gesture**
3. **Watch the page content during zoom**:
   - Content should NEVER stretch/shrink
   - Only sharpness/resolution should change
   - Camera magnification should be smooth
4. **Hold zoom at 8x for 2-3 seconds**
5. **Release gesture** - content should NOT jump/drift
6. Repeat zoom in/out 5 times

### Success Criteria

- [ ] Page content never stretches during zoom
- [ ] Page container size stays constant (inspect element)
- [ ] No `scale()` in tile canvas transform (only translate if any)
- [ ] Camera transform is the only `scale()` applied
- [ ] Tiles get sharper at high zoom (resolution increases)
- [ ] No visual jumps when tiles complete rendering

---

## Rollback Plan

If the fix causes regressions:

1. Revert the fitScale removal
2. Revert setFinalDimensions changes
3. Keep the TransformSnapshot code as potential future mitigation

However, based on Council analysis, the fix is architecturally correct and should resolve the issue cleanly.

---

## Council Rationale

From the LLM Council verdict:

> **H1 (Post-Render Transformation)**: The fitScale is calculated at DISPLAY time using CURRENT container dimensions. If the container resized during the 100-300ms render window, the fitScale is wrong.

> **H3 (Two Transforms Fighting)**: Camera transform applies `scale(zoom)`. Then fitScale applies another `scale(0.22)`. These compose multiplicatively. If either changes independently, the visual result changes unexpectedly.

> **The Solution**: Eliminate the second transform. Tiles display at fixed CSS size (matching page container). Camera transform is the ONLY zoom mechanism. This is the standard pattern used by Google Maps, PDF.js, and other high-quality pan/zoom implementations.

---

## Files to Modify

1. `src/reader/renderer/pdf/pdf-page-element.ts` (main changes)
2. `src/reader/renderer/pdf/pdf-infinite-canvas.ts` (cleanup)

---

## Implementation Order

1. First: Remove fitScale from canvas transform (Task 1)
2. Second: Add fixed CSS dimensions to canvas (Task 2)
3. Third: Fix setFinalDimensions if needed (Task 3)
4. Fourth: Verify camera is sole zoom mechanism (Task 4)
5. Fifth: Remove TransformSnapshot code (Task 5)
6. Build, deploy, test with real gestures

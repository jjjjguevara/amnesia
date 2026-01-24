# PdfDimensions Coordinate System Mismatch + Container Sync Fix

> **Session Date:** 2026-01-20 (updated 2026-01-21)
> **Related Hypotheses:** Related to H1 (integer/float), but distinct coordinate system issue
> **Invariant Violated:** INV-4 (Coordinate Reversibility), INV-5 (Mode Transition Continuity)

## Bug Description

**Symptom:** At high zoom levels (>4x, tiled mode), console shows:
```
[PdfPageElement] Skipping render: invalid tile bounds 612.0x0.0 (tiles outside page)
```

Pages appear blank/stretched at high zoom levels because tiles are being skipped.

## Root Cause Analysis

The `renderTiles()` method uses a fallback for `pdfDimensions`:

```typescript
// WRONG: Falls back to CSS pixels when PDF dimensions unknown
const pdfWidth = pdfDimensions?.width ?? this.currentWidth;
const pdfHeight = pdfDimensions?.height ?? this.currentHeight;
```

**The Problem:**
- `pdfDimensions` = PDF coordinate space (e.g., 612×792 points for letter size)
- `this.currentWidth/Height` = CSS pixel dimensions (e.g., 400×518 pixels)

When `pdfDimensions` is undefined, CSS pixels (400×518) are used as PDF coordinates. Tile calculations in PDF space (e.g., tile at x=500, y=700) then exceed the "page height" of 518px, causing tiles to be rejected as "outside page."

## Fix Applied

### 1. Added `pdfDimensions` to PdfPageElementConfig

```typescript
export interface PdfPageElementConfig {
  // ... existing properties ...
  pdfDimensions?: { width: number; height: number };
}
```

### 2. Added storedPdfDimensions private property

```typescript
private storedPdfDimensions: { width: number; height: number } | null = null;
```

### 3. Updated renderTiles() fallback

```typescript
// CORRECT: Use stored PDF dimensions (native PDF points) as fallback
const pdfWidth = pdfDimensions?.width ?? this.storedPdfDimensions?.width ?? this.currentWidth;
const pdfHeight = pdfDimensions?.height ?? this.storedPdfDimensions?.height ?? this.currentHeight;

// Debug warning when falling back
if (!pdfDimensions) {
  const source = this.storedPdfDimensions ? 'storedPdfDimensions' : 'currentWidth/Height (WARNING: CSS pixels!)';
  console.warn(`[PdfPageElement] renderTiles: pdfDimensions not provided, using ${source}`);
}
```

### 4. Updated createPageElement() to pass PDF dimensions

```typescript
// In pdf-infinite-canvas.ts
const pdfDimensions = this.tileEngine?.pageDimensions.get(page);
const element = new PdfPageElement({
  // ...
  pdfDimensions: pdfDimensions,
});
```

## Files Modified

| File | Changes |
|------|---------|
| `pdf-page-element.ts` | Added config interface property, storedPdfDimensions property, setPdfDimensions method, updated renderTiles fallback |
| `pdf-infinite-canvas.ts` | Updated createPageElement() to pass pdfDimensions from pageDimensions Map |

## Test Results

### Console Logs After Fix
- No "invalid tile bounds" warnings
- Tile renders successful at scale 8 (s8)
- No warnings in console during zoom test

### Visual Test
- Screenshot captured: `screenshots/zoom-pdfDimensions-fix.png`
- Pages rendering (not blank)
- Needs real trackpad gesture testing by user

## Status

**REQUIRES USER VALIDATION**

Synthetic test results (2026-01-21T02:23:xx):
- No "invalid tile bounds" errors
- GOLDEN-FRAME logs show consistent dimensions: 400x518 everywhere
- Mode transitions working with double-buffering
- No dimension mismatch detected

However, per the debugging protocol:

> **REMEMBER:** Synthetic tests DO NOT capture real user experience. Always test with actual trackpad gestures.

## GOLDEN-FRAME Log Analysis

The enhanced GOLDEN-FRAME logs now capture:
- Container bounding rect and offset dimensions
- Canvas buffer and CSS dimensions
- Stored PDF dimensions (native PDF points)
- Snapshot canvas dimensions
- Height delta (should be 0 after fix)

Sample log output:
```
[GOLDEN-FRAME] {
  mode: 'tiled→full-page transition',
  page: 135,
  cssWidth: 400, cssHeight: 518,
  containerBoundingRect: { w: 400, h: 518 },
  containerOffset: { w: 400, h: 518 },
  canvasBuffer: { w: 1224, h: 1584 },
  canvasCss: { w: 400, h: 518 },
  storedPdfDimensions: { width: 612, height: 792 },
  heightDelta: 0
}
```

## Next Steps

1. [ ] User tests with real trackpad pinch-to-zoom gestures
2. [ ] Zoom from 1x → 32x → 1x
3. [ ] Verify no stretch/distortion at 4x mode boundary
4. [ ] If validated, close related bd issues
5. [ ] If still showing issues, analyze GOLDEN-FRAME logs for dimension mismatches

## Relationship to H1

This fix is **complementary** to H1 (integer vs float rounding):

- **H1** fixes CSS dimension consistency (Math.round everywhere)
- **This fix** ensures correct coordinate system (PDF points vs CSS pixels)

Both are INV-4 violations but address different aspects of coordinate handling.

---

## Second Bug: Container/Canvas Dimension Mismatch (2026-01-21)

### Symptom

User screenshots showed clipped pages at ~480% zoom with console showing:
```
[ASPECT-RATIO-FIX] renderCanvas: canvasCss=400x517, containerCss=400x518
```

A 1px mismatch between canvas CSS height (517) and container CSS height (518).

### Root Cause

The aspect ratio fix was calculating CSS dimensions from buffer aspect ratio:
```typescript
const cssHeight = Math.round(cssWidth / bufferAspectRatio);
// Buffer 3166x4096 → aspect 0.7729 → height 517
// But container was still 518
```

The code intentionally avoided updating `currentHeight` because a previous comment warned it would break tile coordinate calculations:
```typescript
// CRITICAL: Do NOT modify this.currentHeight here!
// currentHeight is used as fallback for pdfHeight in renderTiles()
```

But this was obsolete after the `storedPdfDimensions` fix - tile calculations now use native PDF points, not CSS pixels.

### Fix Applied

Updated `renderCanvas()` and `renderCanvasFallback()` to sync container dimensions:
```typescript
// Update container to match canvas (eliminates 1px gap)
this.currentWidth = cssWidth;
this.currentHeight = cssHeight;
this.container.style.width = `${cssWidth}px`;
this.container.style.height = `${cssHeight}px`;
```

### Result

Console now shows matching dimensions:
```
[ASPECT-RATIO-FIX] renderCanvas: canvasCss=400x518, containerCss=400x518
```

### Screenshots

- `screenshots/container-sync-fix-v2.png` - Page rendering correctly after fix

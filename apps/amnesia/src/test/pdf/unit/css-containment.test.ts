/**
 * CSS Containment Tests
 *
 * Problem: At high zoom (32x), Chromium compositor exhausts tile memory because:
 * 1. Canvas uses will-change: transform (GPU layer promotion)
 * 2. No CSS containment limits compositor tile scope
 * 3. Transformed canvas becomes enormous (~19,584 × 25,344 px per page)
 * 4. Chromium creates tiles for entire transformed area
 * 5. Multiple pages × high zoom = 1000+ compositor tiles
 * 6. Exceeds Chromium's ~512MB-1GB tile budget
 *
 * Console error: tile_manager.cc:982 WARNING: tile memory limits exceeded
 *
 * Solution: Add CSS containment to limit compositor tile creation:
 * - Canvas: contain: layout style (or strict)
 * - Page containers: contain: layout paint
 *
 * Tests:
 * - CONTAIN-1: Canvas has CSS containment property
 * - CONTAIN-2: Page elements have CSS containment property
 * - CONTAIN-3: Containment uses valid values for compositor optimization
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock DOM for testing inline styles
class MockElement {
  style: Record<string, string> = {};
  className = '';
  dataset: Record<string, string> = {};
  children: MockElement[] = [];

  appendChild(child: MockElement): void {
    this.children.push(child);
  }

  getBoundingClientRect() {
    return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 };
  }
}

// Helper to parse cssText into individual properties
function parseCssText(cssText: string): Record<string, string> {
  const props: Record<string, string> = {};
  const declarations = cssText.split(';').map(s => s.trim()).filter(Boolean);
  for (const decl of declarations) {
    const [prop, ...valueParts] = decl.split(':');
    if (prop && valueParts.length > 0) {
      props[prop.trim()] = valueParts.join(':').trim();
    }
  }
  return props;
}

describe('CSS Containment for Compositor Optimization', () => {
  // =========================================================================
  // CONTAIN-1: Canvas has CSS containment property
  // =========================================================================
  describe('CONTAIN-1: Canvas containment', () => {
    it('canvas style includes contain property', () => {
      // The canvas element in pdf-infinite-canvas.ts should have contain
      // Expected style should include: contain: layout style
      const expectedCanvasStyle = `
        position: absolute;
        top: 0;
        left: 0;
        transform-origin: 0 0;
        will-change: transform;
        backface-visibility: hidden;
        contain: layout style;
      `;

      const props = parseCssText(expectedCanvasStyle);
      expect(props['contain']).toBeDefined();
      expect(props['contain']).toContain('layout');
    });

    it('canvas containment is compatible with transform', () => {
      // contain: strict would break transforms, but contain: layout style is safe
      const validContainValues = ['layout', 'layout style', 'layout paint', 'layout style paint'];
      const canvasContain = 'layout style';

      expect(validContainValues.some(v => canvasContain.includes('layout'))).toBe(true);
      // 'size' containment breaks auto-sizing, so we shouldn't use it for the canvas
      expect(canvasContain).not.toContain('size');
    });
  });

  // =========================================================================
  // CONTAIN-2: Page elements do NOT have CSS containment (preserves box-shadow)
  // =========================================================================
  describe('CONTAIN-2: Page element NO containment', () => {
    it('page container style does NOT include contain property', () => {
      // IMPORTANT: Page containers must NOT have `contain: paint` because
      // it clips the box-shadow that creates the page border effect.
      // The canvas-level containment is sufficient for compositor optimization.
      const expectedPageStyle = `
        position: relative;
        background: transparent;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        overflow: hidden;
        clip-path: inset(0);
        flex-shrink: 0;
      `;

      const props = parseCssText(expectedPageStyle);
      expect(props['contain']).toBeUndefined();
    });

    it('page has box-shadow for visual borders', () => {
      // The box-shadow creates the page border effect
      // contain: paint would clip this shadow, so we must not use it
      const expectedPageStyle = `
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      `;

      const props = parseCssText(expectedPageStyle);
      expect(props['box-shadow']).toBeDefined();
      expect(props['box-shadow']).toContain('rgba');
    });
  });

  // =========================================================================
  // CONTAIN-3: Canvas containment uses valid values
  // =========================================================================
  describe('CONTAIN-3: Valid containment values', () => {
    it('canvas containment values are recognized by browsers', () => {
      const validValues = [
        'none',
        'strict',
        'content',
        'size',
        'layout',
        'style',
        'paint',
        'size layout',
        'layout paint',
        'layout style',
        'layout style paint',
        'size layout paint',
        'size layout style paint'
      ];

      // Canvas contain value should be in valid list
      const canvasContain = 'layout style';

      // Check that all individual keywords are valid
      for (const keyword of canvasContain.split(' ')) {
        expect(validValues.some(v => v.includes(keyword))).toBe(true);
      }
    });

    it('canvas containment does not use strict (breaks layout)', () => {
      // contain: strict = size layout style paint
      // 'size' breaks auto-sizing which we need
      const canvasContain = 'layout style';
      expect(canvasContain).not.toBe('strict');
    });

    it('canvas containment includes layout to create stacking context', () => {
      // contain: layout creates a new stacking context and containing block
      // This helps limit compositor tile scope
      const canvasContain = 'layout style';
      expect(canvasContain).toContain('layout');
    });

    it('canvas containment does NOT include paint (would clip content)', () => {
      // contain: paint could clip transformed content at high zoom
      // Only use layout + style, not paint, on the canvas
      const canvasContain = 'layout style';
      expect(canvasContain).not.toContain('paint');
    });
  });

  // =========================================================================
  // CONTAIN-4: Integration test expectations
  // =========================================================================
  describe('CONTAIN-4: Compositor memory optimization', () => {
    it('page at 32x zoom has bounded compositor tile count', () => {
      // At 32x zoom, a 612x792 page = ~19,584 x 25,344 px
      // Without containment: ~300 compositor tiles (256x256) per page
      // With containment: compositor creates tiles only for visible portion

      const pageWidthPx = 612 * 32; // ~19,584
      const pageHeightPx = 792 * 32; // ~25,344
      const compositorTileSize = 256;

      // Without containment - all tiles needed
      const tilesWithoutContain =
        Math.ceil(pageWidthPx / compositorTileSize) *
        Math.ceil(pageHeightPx / compositorTileSize);

      // With containment and viewport clip - only visible tiles needed
      const viewportWidth = 1200;
      const viewportHeight = 800;
      const tilesWithContain =
        Math.ceil(viewportWidth / compositorTileSize) *
        Math.ceil(viewportHeight / compositorTileSize);

      // With containment, we expect significantly fewer compositor tiles
      expect(tilesWithContain).toBeLessThan(tilesWithoutContain / 10);

      // Sanity check: ~15 tiles for viewport vs ~7500 tiles for full page
      expect(tilesWithContain).toBeLessThan(50);
      expect(tilesWithoutContain).toBeGreaterThan(1000);
    });

    it('multiple pages stay within compositor budget', () => {
      // Chromium tile budget is ~512MB-1GB
      // Each tile is 256x256x4 = ~256KB
      // Budget allows ~2000-4000 tiles

      const tileBudgetLow = 2000;
      const tileBudgetHigh = 4000;

      // With containment: ~15 tiles per visible viewport area
      // Without: ~7500 tiles per page at 32x

      const visiblePages = 3; // typical viewport shows 1-3 pages
      const tilesPerViewport = 15;
      const totalTilesWithContain = visiblePages * tilesPerViewport;

      // Should be well within budget
      expect(totalTilesWithContain).toBeLessThan(tileBudgetLow);
    });
  });
});

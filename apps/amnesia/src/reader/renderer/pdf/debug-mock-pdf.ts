/**
 * Debug Mock PDF Provider
 *
 * Creates a mock PDF document that renders debug tiles instead of actual content.
 * Used for visual debugging of tile composition, positioning, and scale handling.
 *
 * Usage:
 * 1. Enable via command: "Amnesia: Toggle Debug Tiles"
 * 2. Open any PDF - tiles will show as colored debug tiles
 * 3. Toggle off to return to normal rendering
 *
 * Features:
 * - Generates colored tiles showing coordinates, scale, timestamp
 * - Color-coded by render scale for easy identification
 * - Red dashed border when tile scale differs from target scale
 * - Corner markers for alignment verification
 */

import type { TileCoordinate } from './tile-render-engine';

// Global debug mode flag - simple and reliable
let DEBUG_TILE_MODE = false;

// Expose globally for easy console access
(window as any).__AMNESIA_DEBUG_TILES__ = {
  get enabled() { return DEBUG_TILE_MODE; },
  set enabled(v: boolean) { DEBUG_TILE_MODE = v; console.log(`[DEBUG-TILES] Mode ${v ? 'ENABLED' : 'DISABLED'}`); },
  toggle() { this.enabled = !this.enabled; return this.enabled; }
};

/**
 * Get hue value (0-360) based on tile scale for color coding.
 */
function getScaleHue(scale: number): number {
  if (scale <= 2) return 0; // Red
  if (scale <= 4) return 30; // Orange
  if (scale <= 8) return 60; // Yellow
  if (scale <= 16) return 120; // Green
  if (scale <= 32) return 240; // Blue
  return 280; // Purple
}

/**
 * Generate a debug tile as an SVG string.
 */
export function generateDebugTileSvgString(
  tile: TileCoordinate,
  tileSize: number,
  targetScale?: number
): string {
  const hue = getScaleHue(tile.scale);
  const timestamp = Date.now() % 100000;
  const isScaleMismatch = targetScale !== undefined && targetScale !== tile.scale;

  const bgColor = `hsl(${hue}, 70%, 85%)`;
  const borderColor = `hsl(${hue}, 80%, 50%)`;
  const textColor = `hsl(${hue}, 80%, 25%)`;

  const mismatchIndicator = isScaleMismatch
    ? `<rect x="2" y="2" width="${tileSize - 4}" height="${tileSize - 4}" fill="none" stroke="red" stroke-width="4" stroke-dasharray="8,4"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${tileSize}" height="${tileSize}" viewBox="0 0 ${tileSize} ${tileSize}">
  <rect width="${tileSize}" height="${tileSize}" fill="${bgColor}" stroke="${borderColor}" stroke-width="2"/>
  <pattern id="diag-${tile.tileX}-${tile.tileY}-${tile.scale}" patternUnits="userSpaceOnUse" width="20" height="20">
    <path d="M0,20 L20,0" stroke="${borderColor}" stroke-width="0.5" opacity="0.3"/>
  </pattern>
  <rect width="${tileSize}" height="${tileSize}" fill="url(#diag-${tile.tileX}-${tile.tileY}-${tile.scale})"/>
  ${mismatchIndicator}
  <text x="${tileSize / 2}" y="${tileSize * 0.3}" text-anchor="middle" font-family="monospace" font-size="16" font-weight="bold" fill="${textColor}">(${tile.tileX}, ${tile.tileY})</text>
  <text x="${tileSize / 2}" y="${tileSize * 0.5}" text-anchor="middle" font-family="monospace" font-size="14" fill="${textColor}">scale: ${tile.scale}${isScaleMismatch ? ` → ${targetScale}` : ''}</text>
  <text x="${tileSize / 2}" y="${tileSize * 0.65}" text-anchor="middle" font-family="monospace" font-size="12" fill="${textColor}">page: ${tile.page}</text>
  <text x="${tileSize / 2}" y="${tileSize * 0.8}" text-anchor="middle" font-family="monospace" font-size="10" fill="${textColor}" opacity="0.7">t: ${timestamp}</text>
  <circle cx="8" cy="8" r="4" fill="${borderColor}"/>
  <circle cx="${tileSize - 8}" cy="8" r="4" fill="${borderColor}"/>
  <circle cx="8" cy="${tileSize - 8}" r="4" fill="${borderColor}"/>
  <circle cx="${tileSize - 8}" cy="${tileSize - 8}" r="4" fill="${borderColor}"/>
</svg>`;
}

/**
 * Generate a minimal valid PDF that will trigger tile rendering.
 * This PDF has 3 pages of different sizes to test various scenarios.
 */
export function generateMockPdfBytes(): Uint8Array {
  // Minimal PDF with 3 pages
  // Page 1: 612x792 (US Letter)
  // Page 2: 595x842 (A4)
  // Page 3: 800x600 (Landscape)
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << >> >>
endobj
4 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 7 0 R /Resources << >> >>
endobj
5 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 600] /Contents 8 0 R /Resources << >> >>
endobj
6 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 100 700 Td (Page 1) Tj ET
endstream
endobj
7 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 100 750 Td (Page 2) Tj ET
endstream
endobj
8 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 100 500 Td (Page 3) Tj ET
endstream
endobj
xref
0 9
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000214 00000 n 
0000000313 00000 n 
0000000412 00000 n 
0000000506 00000 n 
0000000600 00000 n 
trailer
<< /Size 9 /Root 1 0 R >>
startxref
694
%%EOF`;

  return new TextEncoder().encode(pdf);
}

/**
 * Mock PDF provider that intercepts tile renders and returns debug tiles.
 */
export class DebugMockPdfProvider {
  private debugMode = true;
  
  constructor() {
    console.log('[DebugMockPdfProvider] Created - will intercept tile renders');
  }

  /**
   * Render a tile as a debug SVG blob.
   */
  async renderTile(
    tile: TileCoordinate,
    tileSize: number,
    targetScale?: number
  ): Promise<Blob> {
    const svg = generateDebugTileSvgString(tile, tileSize, targetScale);
    return new Blob([svg], { type: 'image/svg+xml' });
  }

  /**
   * Check if debug mode is enabled.
   */
  isDebugMode(): boolean {
    return this.debugMode;
  }

  /**
   * Toggle debug mode.
   */
  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    console.log(`[DebugMockPdfProvider] Debug mode ${enabled ? 'enabled' : 'disabled'}`);
  }
}

// Singleton instance
let debugProvider: DebugMockPdfProvider | null = null;

export function getDebugMockPdfProvider(): DebugMockPdfProvider {
  if (!debugProvider) {
    debugProvider = new DebugMockPdfProvider();
  }
  return debugProvider;
}

/**
 * Enable debug tile mode globally.
 * When enabled, ALL tile renders will return debug tiles instead of actual content.
 */
export function enableDebugTileMode(): void {
  DEBUG_TILE_MODE = true;
  console.log('[DEBUG-TILES] Mode ENABLED - reload/scroll to see debug tiles');
}

/**
 * Disable debug tile mode globally.
 */
export function disableDebugTileMode(): void {
  DEBUG_TILE_MODE = false;
  console.log('[DEBUG-TILES] Mode DISABLED - reload/scroll to see normal content');
}

/**
 * Check if debug tile mode is enabled.
 */
export function isDebugTileModeEnabled(): boolean {
  return DEBUG_TILE_MODE;
}

/**
 * Toggle debug tile mode.
 */
export function toggleDebugTileMode(): boolean {
  DEBUG_TILE_MODE = !DEBUG_TILE_MODE;
  console.log(`[DEBUG-TILES] Mode ${DEBUG_TILE_MODE ? 'ENABLED' : 'DISABLED'}`);
  return DEBUG_TILE_MODE;
}

/**
 * Debug Tile Renderer
 *
 * Generates colored PNG tiles for visual debugging of tile composition.
 * Each tile shows coordinates, scale, timestamp, and uses color coding
 * to identify tiles from different render scales.
 *
 * Enable via feature flag: useDebugTiles
 *
 * Color scheme (HSL hue based on scale):
 * - Scale 1-2: Red (0°)
 * - Scale 3-4: Orange (30°)
 * - Scale 5-8: Yellow (60°)
 * - Scale 9-16: Green (120°)
 * - Scale 17-32: Blue (240°)
 * - Scale 33+: Purple (280°)
 */

import type { TileCoordinate } from './tile-render-engine';

/** Additional debug info to stamp on tiles */
export interface DebugTileInfo {
  /** Current camera zoom level */
  zoom?: number;
  /** Epoch number for scale/layout atomicity */
  epoch?: number;
  /** Request priority (critical, high, medium, low) */
  priority?: string;
  /** Whether this is from cache fallback */
  isFallback?: boolean;
  /** CSS stretch factor applied */
  cssStretch?: number;
  /** Requested scale (may differ from actual if capped) */
  requestedScale?: number;
  /** Render mode (tiled, full-page) */
  renderMode?: string;
}

// Global counter for unique tile IDs
let tileCounter = 0;

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
 * Convert HSL to RGB hex color.
 */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Draw a digit (0-9) using THICK filled rectangles at the specified position.
 * This avoids font rendering issues with OffscreenCanvas.
 * Designed for maximum visibility even when stretched/scaled.
 */
function drawDigit(
  ctx: OffscreenCanvasRenderingContext2D,
  digit: number,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string
): void {
  // Thicker segments for better visibility
  const segThickness = height / 5; // Thick horizontal segments
  const vSegWidth = width * 0.4;   // Wide vertical segments
  const gap = segThickness * 0.15; // Small gap between segments
  
  ctx.fillStyle = color;
  
  // Segment patterns for digits 0-9
  // Segments: top, top-left, top-right, middle, bottom-left, bottom-right, bottom
  const patterns: Record<number, number[]> = {
    0: [1, 1, 1, 0, 1, 1, 1],
    1: [0, 0, 1, 0, 0, 1, 0],
    2: [1, 0, 1, 1, 1, 0, 1],
    3: [1, 0, 1, 1, 0, 1, 1],
    4: [0, 1, 1, 1, 0, 1, 0],
    5: [1, 1, 0, 1, 0, 1, 1],
    6: [1, 1, 0, 1, 1, 1, 1],
    7: [1, 0, 1, 0, 0, 1, 0],
    8: [1, 1, 1, 1, 1, 1, 1],
    9: [1, 1, 1, 1, 0, 1, 1],
  };
  
  const segs = patterns[digit] || patterns[0];
  
  // Calculate positions
  const topY = y;
  const midY = y + height / 2 - segThickness / 2;
  const bottomY = y + height - segThickness;
  const topHalfHeight = height / 2 - segThickness / 2 - gap;
  const bottomHalfHeight = height / 2 - segThickness / 2 - gap;
  
  // Horizontal segments (THICK bars)
  if (segs[0]) ctx.fillRect(x + vSegWidth * 0.3, topY, width - vSegWidth * 0.6, segThickness); // top
  if (segs[3]) ctx.fillRect(x + vSegWidth * 0.3, midY, width - vSegWidth * 0.6, segThickness); // middle
  if (segs[6]) ctx.fillRect(x + vSegWidth * 0.3, bottomY, width - vSegWidth * 0.6, segThickness); // bottom
  
  // Vertical segments (WIDE bars)
  if (segs[1]) ctx.fillRect(x, topY + segThickness + gap, vSegWidth, topHalfHeight); // top-left
  if (segs[2]) ctx.fillRect(x + width - vSegWidth, topY + segThickness + gap, vSegWidth, topHalfHeight); // top-right
  if (segs[4]) ctx.fillRect(x, midY + segThickness + gap, vSegWidth, bottomHalfHeight); // bottom-left
  if (segs[5]) ctx.fillRect(x + width - vSegWidth, midY + segThickness + gap, vSegWidth, bottomHalfHeight); // bottom-right
}

/**
 * Draw a number using 7-segment style digits.
 */
function drawNumber(
  ctx: OffscreenCanvasRenderingContext2D,
  num: number,
  centerX: number,
  y: number,
  digitWidth: number,
  digitHeight: number,
  color: string
): void {
  const str = Math.abs(Math.round(num)).toString();
  const totalWidth = str.length * (digitWidth * 1.3);
  let x = centerX - totalWidth / 2;
  
  for (const ch of str) {
    drawDigit(ctx, parseInt(ch), x, y, digitWidth, digitHeight, color);
    x += digitWidth * 1.3;
  }
}

/**
 * Generate a debug tile as a PNG blob using Canvas.
 * Uses LARGE filled rectangles and simple shapes for maximum visibility.
 *
 * @param tile Tile coordinate info
 * @param tileSize Size of the tile in pixels
 * @param targetScale The target scale (what scale SHOULD be used for positioning)
 * @param debugInfo Additional debug info to stamp on tile
 * @returns Promise<Blob> containing PNG image
 */
export async function generateDebugTileSvg(
  tile: TileCoordinate,
  tileSize: number,
  targetScale?: number,
  debugInfo?: DebugTileInfo
): Promise<Blob> {
  // Always create fresh canvas to avoid state issues
  const canvas = new OffscreenCanvas(tileSize, tileSize);
  const ctx = canvas.getContext('2d');
  
  if (!ctx) {
    throw new Error('Failed to get 2d context for debug tile');
  }
  const hue = getScaleHue(tile.scale);
  const tileId = ++tileCounter;
  const isScaleMismatch = targetScale !== undefined && targetScale !== tile.scale;
  const isRequestMismatch = debugInfo?.requestedScale !== undefined && debugInfo.requestedScale !== tile.scale;

  // Colors
  const bgColor = hslToHex(hue, 70, 85);
  const borderColor = hslToHex(hue, 80, 50);
  const darkColor = hslToHex(hue, 80, 20);

  // Clear and fill background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, tileSize, tileSize);

  // Draw diagonal lines for texture
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = Math.max(2, tileSize / 64);
  ctx.globalAlpha = 0.5;
  const spacing = tileSize / 8;
  for (let i = -tileSize; i < tileSize * 2; i += spacing) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + tileSize, tileSize);
    ctx.stroke();
  }
  ctx.globalAlpha = 1.0;

  // Thick border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = Math.max(4, tileSize / 32);
  ctx.strokeRect(2, 2, tileSize - 4, tileSize - 4);

  // Scale mismatch indicator (red dashed border)
  if (isScaleMismatch || isRequestMismatch) {
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = tileSize / 20;
    ctx.setLineDash([tileSize / 16, tileSize / 32]);
    ctx.strokeRect(tileSize / 16, tileSize / 16, tileSize - tileSize / 8, tileSize - tileSize / 8);
    ctx.setLineDash([]);
  }

  // Fallback indicator (orange triangle in corner)
  if (debugInfo?.isFallback) {
    ctx.fillStyle = '#ff8800';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(tileSize * 0.3, 0);
    ctx.lineTo(0, tileSize * 0.3);
    ctx.closePath();
    ctx.fill();
  }

  // ============================================================
  // LARGE DIGITS using filled rectangles (100% reliable rendering)
  // Each digit takes up ~1/4 of tile width for maximum visibility
  // ============================================================
  
  const bigDigitW = tileSize * 0.18;  // 18% of tile = ~92px for 512px tiles
  const bigDigitH = tileSize * 0.28;  // 28% of tile = ~143px for 512px tiles
  
  // === TOP: Tile coordinates X,Y in format "X,Y" ===
  // Draw coordinates as LARGE numbers in top portion
  const coordY = tileSize * 0.08;
  
  // X coordinate (left side)
  drawNumber(ctx, tile.tileX, tileSize * 0.25, coordY, bigDigitW, bigDigitH, darkColor);
  
  // Comma/separator (thick diagonal line between X and Y)
  ctx.fillStyle = darkColor;
  ctx.fillRect(tileSize * 0.45, coordY + bigDigitH * 0.7, bigDigitW * 0.3, bigDigitH * 0.15);
  ctx.fillRect(tileSize * 0.46, coordY + bigDigitH * 0.85, bigDigitW * 0.2, bigDigitH * 0.15);
  
  // Y coordinate (right side)  
  drawNumber(ctx, tile.tileY, tileSize * 0.70, coordY, bigDigitW, bigDigitH, darkColor);

  // === MIDDLE: SCALE - the most important number ===
  // Draw scale HUGE in the center
  const scaleY = tileSize * 0.42;
  const scaleDigitW = tileSize * 0.22;
  const scaleDigitH = tileSize * 0.35;
  const scaleColor = isScaleMismatch ? '#cc0000' : darkColor;
  
  // "S" indicator - simple filled square with S-like cutout
  ctx.fillStyle = scaleColor;
  ctx.globalAlpha = 0.3;
  ctx.fillRect(tileSize * 0.08, scaleY, scaleDigitW * 0.6, scaleDigitH);
  ctx.globalAlpha = 1.0;
  
  // Scale number (HUGE)
  drawNumber(ctx, tile.scale, tileSize * 0.55, scaleY, scaleDigitW, scaleDigitH, scaleColor);

  // === BOTTOM: Page number and zoom ===
  const bottomY = tileSize * 0.82;
  const smallDigitW = tileSize * 0.10;
  const smallDigitH = tileSize * 0.14;
  
  // Page number on left
  ctx.fillStyle = darkColor;
  ctx.globalAlpha = 0.3;
  ctx.fillRect(tileSize * 0.05, bottomY, smallDigitW * 0.4, smallDigitH);
  ctx.globalAlpha = 1.0;
  drawNumber(ctx, tile.page, tileSize * 0.22, bottomY, smallDigitW, smallDigitH, darkColor);
  
  // Zoom level on right (if available)
  if (debugInfo?.zoom !== undefined) {
    ctx.fillStyle = darkColor;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(tileSize * 0.55, bottomY, smallDigitW * 0.4, smallDigitH);
    ctx.globalAlpha = 1.0;
    drawNumber(ctx, Math.round(debugInfo.zoom), tileSize * 0.75, bottomY, smallDigitW, smallDigitH, darkColor);
  }

  // Corner markers (large circles)
  ctx.fillStyle = borderColor;
  const cornerRadius = tileSize * 0.04;
  const cornerOffset = tileSize * 0.06;
  
  ctx.beginPath();
  ctx.arc(cornerOffset, cornerOffset, cornerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(tileSize - cornerOffset, cornerOffset, cornerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cornerOffset, tileSize - cornerOffset, cornerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(tileSize - cornerOffset, tileSize - cornerOffset, cornerRadius, 0, Math.PI * 2);
  ctx.fill();

  // Center crosshair (larger, more visible)
  ctx.strokeStyle = darkColor;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = tileSize / 64;
  const crossSize = tileSize * 0.08;
  ctx.beginPath();
  ctx.moveTo(tileSize / 2 - crossSize, tileSize / 2);
  ctx.lineTo(tileSize / 2 + crossSize, tileSize / 2);
  ctx.moveTo(tileSize / 2, tileSize / 2 - crossSize);
  ctx.lineTo(tileSize / 2, tileSize / 2 + crossSize);
  ctx.stroke();
  ctx.globalAlpha = 1.0;

  // Convert to PNG blob
  return await canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Generate a debug tile as an ImageBitmap.
 *
 * @param tile Tile coordinate info
 * @param tileSize Size of the tile in pixels
 * @param targetScale The target scale for this render
 * @returns Promise resolving to ImageBitmap
 */
export async function generateDebugTileBitmap(
  tile: TileCoordinate,
  tileSize: number,
  targetScale?: number
): Promise<ImageBitmap> {
  const pngBlob = await generateDebugTileSvg(tile, tileSize, targetScale);
  return await createImageBitmap(pngBlob);
}

/**
 * Generate a debug tile and return as a Blob (for cache compatibility).
 *
 * This wraps the PNG in a way that's compatible with the tile cache system.
 *
 * @param tile Tile coordinate info
 * @param tileSize Size of the tile in pixels
 * @param targetScale The target scale for this render
 * @returns Promise resolving to PNG Blob
 */
export async function generateDebugTileBlob(
  tile: TileCoordinate,
  tileSize: number,
  targetScale?: number
): Promise<Blob> {
  // For simplicity, just return the SVG blob directly
  // Most browsers can display SVG in canvas via createImageBitmap
  return generateDebugTileSvg(tile, tileSize, targetScale);
}

/**
 * Debug Tile View
 *
 * A standalone view that renders debug tiles for visual debugging
 * of tile composition and positioning logic.
 *
 * Opens in a new tab via command: "Amnesia: Open Debug Tile Viewer"
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';

export const DEBUG_TILE_VIEW_TYPE = 'amnesia-debug-tiles';

interface TileInfo {
  x: number;
  y: number;
  scale: number;
  tileX: number;
  tileY: number;
  timestamp: number;
}

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

export class DebugTileView extends ItemView {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private tiles: TileInfo[] = [];
  
  // Simulated camera state
  private camera = { x: 0, y: 0, zoom: 1 };
  private isDragging = false;
  private lastMousePos = { x: 0, y: 0 };
  
  // Page simulation
  private pageWidth = 612; // PDF points (US Letter)
  private pageHeight = 792;
  private tileSize = 256; // CSS pixels
  
  // Target scale vs actual scale (for demonstrating the bug)
  private targetScale = 2;
  private simulateMultiScale = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return DEBUG_TILE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Debug Tile Viewer';
  }

  getIcon(): string {
    return 'grid';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('debug-tile-view');

    // Add styles
    const style = container.createEl('style');
    style.textContent = `
      .debug-tile-view {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #1a1a1a;
      }
      .debug-tile-controls {
        display: flex;
        gap: 10px;
        padding: 10px;
        background: #2a2a2a;
        border-bottom: 1px solid #444;
        flex-wrap: wrap;
        align-items: center;
      }
      .debug-tile-controls label {
        color: #ccc;
        font-size: 12px;
      }
      .debug-tile-controls input, .debug-tile-controls select {
        background: #333;
        border: 1px solid #555;
        color: #fff;
        padding: 4px 8px;
        border-radius: 4px;
      }
      .debug-tile-controls button {
        background: #4a4a4a;
        border: 1px solid #666;
        color: #fff;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
      }
      .debug-tile-controls button:hover {
        background: #5a5a5a;
      }
      .debug-tile-canvas-container {
        flex: 1;
        overflow: hidden;
        position: relative;
      }
      .debug-tile-canvas {
        position: absolute;
        top: 0;
        left: 0;
      }
      .debug-tile-info {
        position: absolute;
        bottom: 10px;
        left: 10px;
        background: rgba(0,0,0,0.8);
        color: #fff;
        padding: 8px 12px;
        border-radius: 4px;
        font-family: monospace;
        font-size: 11px;
        pointer-events: none;
      }
    `;

    // Controls
    const controls = container.createDiv({ cls: 'debug-tile-controls' });
    
    // Zoom control
    const zoomLabel = controls.createEl('label');
    zoomLabel.textContent = 'Zoom: ';
    const zoomInput = controls.createEl('input', { type: 'range' });
    zoomInput.min = '0.5';
    zoomInput.max = '32';
    zoomInput.step = '0.5';
    zoomInput.value = '1';
    const zoomValue = controls.createEl('span');
    zoomValue.textContent = '1×';
    zoomInput.addEventListener('input', () => {
      this.camera.zoom = parseFloat(zoomInput.value);
      zoomValue.textContent = `${this.camera.zoom}×`;
      this.render();
    });

    // Target scale control
    const scaleLabel = controls.createEl('label');
    scaleLabel.textContent = ' Target Scale: ';
    const scaleSelect = controls.createEl('select');
    [1, 2, 4, 8, 16, 32].forEach(s => {
      const opt = scaleSelect.createEl('option');
      opt.value = String(s);
      opt.textContent = String(s);
      if (s === 2) opt.selected = true;
    });
    scaleSelect.addEventListener('change', () => {
      this.targetScale = parseInt(scaleSelect.value);
      this.render();
    });

    // Multi-scale bug simulation toggle
    const bugLabel = controls.createEl('label');
    bugLabel.textContent = ' Simulate Multi-Scale Bug: ';
    const bugCheckbox = controls.createEl('input', { type: 'checkbox' });
    bugCheckbox.addEventListener('change', () => {
      this.simulateMultiScale = bugCheckbox.checked;
      this.render();
    });

    // Reset button
    const resetBtn = controls.createEl('button');
    resetBtn.textContent = 'Reset View';
    resetBtn.addEventListener('click', () => {
      this.camera = { x: 0, y: 0, zoom: 1 };
      zoomInput.value = '1';
      zoomValue.textContent = '1×';
      this.render();
    });

    // Canvas container
    const canvasContainer = container.createDiv({ cls: 'debug-tile-canvas-container' });
    
    this.canvas = canvasContainer.createEl('canvas', { cls: 'debug-tile-canvas' });
    this.ctx = this.canvas.getContext('2d');

    // Info overlay
    const info = canvasContainer.createDiv({ cls: 'debug-tile-info' });
    info.id = 'debug-tile-info';

    // Setup event handlers
    this.setupEventHandlers(canvasContainer, info);

    // Initial render
    this.resizeCanvas();
    this.render();

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
      this.render();
    });
    resizeObserver.observe(canvasContainer);
  }

  private setupEventHandlers(container: HTMLElement, info: HTMLElement): void {
    // Mouse wheel for zoom
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.camera.zoom = Math.max(0.5, Math.min(32, this.camera.zoom * delta));
      
      // Update zoom slider
      const slider = this.containerEl.querySelector('input[type="range"]') as HTMLInputElement;
      if (slider) {
        slider.value = String(this.camera.zoom);
        const span = slider.nextElementSibling as HTMLElement;
        if (span) span.textContent = `${this.camera.zoom.toFixed(1)}×`;
      }
      
      this.render();
    });

    // Mouse drag for pan
    container.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.lastMousePos = { x: e.clientX, y: e.clientY };
    });

    container.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.lastMousePos.x;
        const dy = e.clientY - this.lastMousePos.y;
        this.camera.x += dx / this.camera.zoom;
        this.camera.y += dy / this.camera.zoom;
        this.lastMousePos = { x: e.clientX, y: e.clientY };
        this.render();
      }

      // Update info
      const rect = this.canvas!.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      const worldX = (canvasX / this.camera.zoom) - this.camera.x;
      const worldY = (canvasY / this.camera.zoom) - this.camera.y;
      const tileX = Math.floor(worldX / (this.tileSize / this.targetScale));
      const tileY = Math.floor(worldY / (this.tileSize / this.targetScale));
      
      info.innerHTML = `
        Camera: (${this.camera.x.toFixed(0)}, ${this.camera.y.toFixed(0)}) zoom=${this.camera.zoom.toFixed(2)}×<br>
        World: (${worldX.toFixed(0)}, ${worldY.toFixed(0)})<br>
        Tile: (${tileX}, ${tileY}) @ scale ${this.targetScale}<br>
        Target Scale: ${this.targetScale}, Multi-Scale Bug: ${this.simulateMultiScale ? 'ON' : 'OFF'}
      `;
    });

    container.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    container.addEventListener('mouseleave', () => {
      this.isDragging = false;
    });
  }

  private resizeCanvas(): void {
    if (!this.canvas) return;
    const container = this.canvas.parentElement;
    if (!container) return;
    
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = container.clientWidth * dpr;
    this.canvas.height = container.clientHeight * dpr;
    this.canvas.style.width = `${container.clientWidth}px`;
    this.canvas.style.height = `${container.clientHeight}px`;
    this.ctx?.scale(dpr, dpr);
  }

  private render(): void {
    if (!this.ctx || !this.canvas) return;

    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;

    // Clear
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Apply camera transform
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(this.camera.zoom, this.camera.zoom);
    ctx.translate(this.camera.x, this.camera.y);

    // Calculate visible tile range
    const pdfTileSize = this.tileSize / this.targetScale;
    const tilesX = Math.ceil(this.pageWidth / pdfTileSize);
    const tilesY = Math.ceil(this.pageHeight / pdfTileSize);

    // Draw tiles
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        // Simulate multi-scale bug: some tiles at different scale
        let tileScale = this.targetScale;
        if (this.simulateMultiScale) {
          // Every other tile at half scale (simulating stale cached tiles)
          if ((tx + ty) % 3 === 0) {
            tileScale = Math.max(1, this.targetScale / 2);
          }
        }

        this.drawDebugTile(ctx, tx, ty, tileScale, pdfTileSize);
      }
    }

    // Draw page boundary
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 / this.camera.zoom;
    ctx.strokeRect(0, 0, this.pageWidth, this.pageHeight);

    ctx.restore();
  }

  private drawDebugTile(
    ctx: CanvasRenderingContext2D,
    tileX: number,
    tileY: number,
    tileScale: number,
    pdfTileSize: number
  ): void {
    const hue = getScaleHue(tileScale);
    const isScaleMismatch = tileScale !== this.targetScale;

    // Calculate position using TARGET scale (correct behavior)
    // vs using TILE scale (buggy behavior when simulateMultiScale is on)
    let x: number, y: number, w: number, h: number;
    
    if (this.simulateMultiScale && isScaleMismatch) {
      // BUG SIMULATION: Position using tile's own scale (causes misalignment)
      const buggyPdfTileSize = this.tileSize / tileScale;
      x = tileX * buggyPdfTileSize;
      y = tileY * buggyPdfTileSize;
      w = buggyPdfTileSize;
      h = buggyPdfTileSize;
    } else {
      // CORRECT: Position using target scale
      x = tileX * pdfTileSize;
      y = tileY * pdfTileSize;
      w = pdfTileSize;
      h = pdfTileSize;
    }

    // Background
    ctx.fillStyle = `hsl(${hue}, 70%, 85%)`;
    ctx.fillRect(x, y, w, h);

    // Border
    ctx.strokeStyle = `hsl(${hue}, 80%, 50%)`;
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.strokeRect(x, y, w, h);

    // Diagonal pattern
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = `hsl(${hue}, 80%, 50%)`;
    ctx.lineWidth = 0.5 / this.camera.zoom;
    ctx.globalAlpha = 0.3;
    for (let i = -h; i < w; i += 10 / this.camera.zoom) {
      ctx.beginPath();
      ctx.moveTo(x + i, y);
      ctx.lineTo(x + i + h, y + h);
      ctx.stroke();
    }
    ctx.restore();

    // Scale mismatch indicator
    if (isScaleMismatch) {
      ctx.save();
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 3 / this.camera.zoom;
      ctx.setLineDash([5 / this.camera.zoom, 3 / this.camera.zoom]);
      ctx.strokeRect(x + 2/this.camera.zoom, y + 2/this.camera.zoom, w - 4/this.camera.zoom, h - 4/this.camera.zoom);
      ctx.restore();
    }

    // Text (only if zoomed in enough to read)
    if (this.camera.zoom > 0.5) {
      const fontSize = Math.max(8, 12 / this.camera.zoom);
      ctx.fillStyle = `hsl(${hue}, 80%, 25%)`;
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      const centerX = x + w / 2;
      const centerY = y + h / 2;
      
      ctx.fillText(`(${tileX},${tileY})`, centerX, centerY - fontSize);
      ctx.font = `${fontSize * 0.9}px monospace`;
      ctx.fillText(`s:${tileScale}${isScaleMismatch ? `→${this.targetScale}` : ''}`, centerX, centerY + fontSize * 0.5);
    }

    // Corner dots
    const dotSize = 3 / this.camera.zoom;
    ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
    ctx.beginPath();
    ctx.arc(x + dotSize * 2, y + dotSize * 2, dotSize, 0, Math.PI * 2);
    ctx.arc(x + w - dotSize * 2, y + dotSize * 2, dotSize, 0, Math.PI * 2);
    ctx.arc(x + dotSize * 2, y + h - dotSize * 2, dotSize, 0, Math.PI * 2);
    ctx.arc(x + w - dotSize * 2, y + h - dotSize * 2, dotSize, 0, Math.PI * 2);
    ctx.fill();
  }

  async onClose(): Promise<void> {
    // Cleanup
  }
}

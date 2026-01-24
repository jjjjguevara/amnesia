/**
 * WebGL Compositor
 *
 * GPU-accelerated tile compositing using WebGL2 for improved scroll performance.
 * Uploads tile bitmaps as GPU textures and composites them in a single batched draw.
 *
 * Phase 7: WebGL Compositing
 * Goal: 20-30% FPS improvement over Canvas2D drawImage calls
 *
 * Features:
 * - WebGL2 context for efficient GPU operations
 * - Texture cache for tile bitmaps
 * - Batched draw calls for all visible tiles
 * - Automatic fallback to Canvas2D if WebGL2 unavailable
 * - Memory-efficient texture management
 *
 * @example
 * ```typescript
 * const compositor = new WebGLCompositor(canvas);
 * if (compositor.isAvailable()) {
 *   compositor.uploadTile(tile, bitmap);
 *   compositor.render(visibleTiles, transform);
 * }
 * ```
 */

import { getTelemetry } from './pdf-telemetry';

// ============================================================================
// Types
// ============================================================================

export interface TileTexture {
  /** WebGL texture handle */
  texture: WebGLTexture;
  /** Tile page number */
  page: number;
  /** Tile X coordinate */
  tileX: number;
  /** Tile Y coordinate */
  tileY: number;
  /** Tile scale */
  scale: number;
  /** Texture width */
  width: number;
  /** Texture height */
  height: number;
  /** Last access timestamp for LRU eviction */
  lastAccess: number;
}

export interface CompositorConfig {
  /** Maximum textures to cache (default: 100) */
  maxTextures: number;
  /** Enable debug logging */
  debug: boolean;
}

export interface TileRenderInfo {
  /** Tile page number */
  page: number;
  /** Tile X coordinate in grid */
  tileX: number;
  /** Tile Y coordinate in grid */
  tileY: number;
  /** Tile scale */
  scale: number;
  /** Destination X in canvas coords */
  destX: number;
  /** Destination Y in canvas coords */
  destY: number;
  /** Destination width */
  destWidth: number;
  /** Destination height */
  destHeight: number;
}

export interface CameraTransform {
  /** Camera X position */
  x: number;
  /** Camera Y position */
  y: number;
  /** Camera zoom level */
  z: number;
}

// ============================================================================
// Shaders
// ============================================================================

const VERTEX_SHADER = `#version 300 es
precision highp float;

// Vertex attributes
in vec2 a_position;
in vec2 a_texCoord;

// Uniforms
uniform vec2 u_resolution;
uniform vec2 u_translation;
uniform float u_scale;

// Varyings
out vec2 v_texCoord;

void main() {
  // Apply camera transform: translate then scale
  vec2 position = (a_position + u_translation) * u_scale;

  // Convert from pixel coords to clip space (-1 to 1)
  vec2 clipSpace = ((position / u_resolution) * 2.0) - 1.0;

  // Flip Y axis (WebGL has Y up, we want Y down)
  gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);

  v_texCoord = a_texCoord;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 outColor;

uniform sampler2D u_texture;

void main() {
  outColor = texture(u_texture, v_texCoord);
}
`;

// ============================================================================
// WebGL Compositor Class
// ============================================================================

export class WebGLCompositor {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private config: CompositorConfig;

  // Shader uniform/attribute locations
  private positionLocation: number = -1;
  private texCoordLocation: number = -1;
  private resolutionLocation: WebGLUniformLocation | null = null;
  private translationLocation: WebGLUniformLocation | null = null;
  private scaleLocation: WebGLUniformLocation | null = null;
  private textureLocation: WebGLUniformLocation | null = null;

  // Buffers
  private positionBuffer: WebGLBuffer | null = null;
  private texCoordBuffer: WebGLBuffer | null = null;

  // Texture cache
  private textureCache: Map<string, TileTexture> = new Map();
  private textureAccessOrder: string[] = [];

  // State
  private isInitialized = false;
  private fallbackToCanvas2D = false;
  private contextLost = false;

  // Event listener references for cleanup
  private handleContextLost: ((e: Event) => void) | null = null;
  private handleContextRestored: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, config: Partial<CompositorConfig> = {}) {
    this.canvas = canvas;
    this.config = {
      maxTextures: config.maxTextures ?? 100,
      debug: config.debug ?? false,
    };

    this.initialize();
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Check if WebGL2 is available and initialized
   */
  isAvailable(): boolean {
    return this.isInitialized && !this.fallbackToCanvas2D && !this.contextLost;
  }

  /**
   * Upload a tile bitmap as a GPU texture
   */
  uploadTile(
    page: number,
    tileX: number,
    tileY: number,
    scale: number,
    bitmap: ImageBitmap
  ): boolean {
    if (!this.isAvailable()) return false;

    const key = this.getTileKey(page, tileX, tileY, scale);

    // Check if already cached
    if (this.textureCache.has(key)) {
      // Update access time
      const existing = this.textureCache.get(key)!;
      existing.lastAccess = performance.now();
      this.updateAccessOrder(key);
      return true;
    }

    // Evict oldest if at capacity
    if (this.textureCache.size >= this.config.maxTextures) {
      this.evictOldest();
    }

    // Create texture
    const texture = this.createTexture(bitmap);
    if (!texture) return false;

    this.textureCache.set(key, {
      texture,
      page,
      tileX,
      tileY,
      scale,
      width: bitmap.width,
      height: bitmap.height,
      lastAccess: performance.now(),
    });

    this.textureAccessOrder.push(key);

    if (this.config.debug) {
      console.log(`[WebGLCompositor] Uploaded tile ${key}, cache size: ${this.textureCache.size}`);
    }

    return true;
  }

  /**
   * Check if a tile is in the texture cache
   */
  hasTile(page: number, tileX: number, tileY: number, scale: number): boolean {
    const key = this.getTileKey(page, tileX, tileY, scale);
    return this.textureCache.has(key);
  }

  /**
   * Render all tiles with camera transform
   */
  render(tiles: TileRenderInfo[], camera: CameraTransform): void {
    if (!this.isAvailable() || !this.gl) return;

    const gl = this.gl;
    const startTime = performance.now();

    // Set viewport
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // Clear
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Use program
    gl.useProgram(this.program);

    // Set uniforms
    gl.uniform2f(this.resolutionLocation, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.translationLocation, -camera.x, -camera.y);
    gl.uniform1f(this.scaleLocation, camera.z);

    // Enable blending for transparency
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let tilesRendered = 0;

    // Render each tile
    for (const tile of tiles) {
      const key = this.getTileKey(tile.page, tile.tileX, tile.tileY, tile.scale);
      const cached = this.textureCache.get(key);

      if (!cached) continue;

      // Update access time
      cached.lastAccess = performance.now();

      // Bind texture
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cached.texture);
      gl.uniform1i(this.textureLocation, 0);

      // Set up quad vertices for this tile
      this.setQuadVertices(tile.destX, tile.destY, tile.destWidth, tile.destHeight);

      // Draw
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      tilesRendered++;
    }

    const renderTime = performance.now() - startTime;
    getTelemetry().trackCustomMetric('webglRenderTime', renderTime);
    getTelemetry().trackCustomMetric('webglTilesRendered', tilesRendered);

    if (this.config.debug && tilesRendered > 0) {
      console.log(`[WebGLCompositor] Rendered ${tilesRendered} tiles in ${renderTime.toFixed(2)}ms`);
    }
  }

  /**
   * Clear the texture cache
   */
  clearCache(): void {
    if (!this.gl) return;

    for (const cached of this.textureCache.values()) {
      this.gl.deleteTexture(cached.texture);
    }

    this.textureCache.clear();
    this.textureAccessOrder = [];

    if (this.config.debug) {
      console.log('[WebGLCompositor] Cache cleared');
    }
  }

  /**
   * Remove a specific tile from cache
   */
  removeTile(page: number, tileX: number, tileY: number, scale: number): void {
    const key = this.getTileKey(page, tileX, tileY, scale);
    const cached = this.textureCache.get(key);

    if (cached && this.gl) {
      this.gl.deleteTexture(cached.texture);
      this.textureCache.delete(key);
      this.textureAccessOrder = this.textureAccessOrder.filter(k => k !== key);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): { textureCount: number; maxTextures: number; isWebGL: boolean } {
    return {
      textureCount: this.textureCache.size,
      maxTextures: this.config.maxTextures,
      isWebGL: this.isAvailable(),
    };
  }

  /**
   * Update canvas size (call after resize)
   */
  resize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Destroy compositor and release resources
   */
  destroy(): void {
    this.clearCache();

    // Remove context loss event listeners
    if (this.handleContextLost) {
      this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
      this.handleContextLost = null;
    }
    if (this.handleContextRestored) {
      this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
      this.handleContextRestored = null;
    }

    if (this.gl) {
      if (this.positionBuffer) this.gl.deleteBuffer(this.positionBuffer);
      if (this.texCoordBuffer) this.gl.deleteBuffer(this.texCoordBuffer);
      if (this.program) this.gl.deleteProgram(this.program);
    }

    this.gl = null;
    this.program = null;
    this.isInitialized = false;
    this.contextLost = false;

    if (this.config.debug) {
      console.log('[WebGLCompositor] Destroyed');
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private initialize(): void {
    try {
      // Set up context loss handlers before getting context
      this.handleContextLost = (e: Event) => {
        e.preventDefault(); // Prevents default behavior that discards context
        this.contextLost = true;
        // Clear texture cache - textures are invalid after context loss
        this.textureCache.clear();
        this.textureAccessOrder = [];
        console.warn('[WebGLCompositor] Context lost - falling back to Canvas2D until restored');
        getTelemetry().trackCustomMetric('webglContextLost', 1);
      };

      this.handleContextRestored = () => {
        console.log('[WebGLCompositor] Context restored - reinitializing');
        this.contextLost = false;
        // Reinitialize shaders and buffers
        this.reinitializeAfterContextRestore();
        getTelemetry().trackCustomMetric('webglContextRestored', 1);
      };

      this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
      this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);

      // Try to get WebGL2 context
      this.gl = this.canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        depth: false,
        preserveDrawingBuffer: false,
        premultipliedAlpha: false,
      });

      if (!this.gl) {
        console.warn('[WebGLCompositor] WebGL2 not available, falling back to Canvas2D');
        this.fallbackToCanvas2D = true;
        return;
      }

      // Compile shaders
      const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, VERTEX_SHADER);
      const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

      if (!vertexShader || !fragmentShader) {
        console.warn('[WebGLCompositor] Shader compilation failed, falling back to Canvas2D');
        this.fallbackToCanvas2D = true;
        return;
      }

      // Create program
      this.program = this.createProgram(vertexShader, fragmentShader);
      if (!this.program) {
        console.warn('[WebGLCompositor] Program creation failed, falling back to Canvas2D');
        this.fallbackToCanvas2D = true;
        return;
      }

      // Get locations
      this.positionLocation = this.gl.getAttribLocation(this.program, 'a_position');
      this.texCoordLocation = this.gl.getAttribLocation(this.program, 'a_texCoord');
      this.resolutionLocation = this.gl.getUniformLocation(this.program, 'u_resolution');
      this.translationLocation = this.gl.getUniformLocation(this.program, 'u_translation');
      this.scaleLocation = this.gl.getUniformLocation(this.program, 'u_scale');
      this.textureLocation = this.gl.getUniformLocation(this.program, 'u_texture');

      // Create buffers
      this.positionBuffer = this.gl.createBuffer();
      this.texCoordBuffer = this.gl.createBuffer();

      // Set up texture coordinates (static)
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.texCoordBuffer);
      this.gl.bufferData(
        this.gl.ARRAY_BUFFER,
        new Float32Array([
          0, 0,
          1, 0,
          0, 1,
          0, 1,
          1, 0,
          1, 1,
        ]),
        this.gl.STATIC_DRAW
      );

      // Enable vertex attributes
      this.gl.enableVertexAttribArray(this.positionLocation);
      this.gl.enableVertexAttribArray(this.texCoordLocation);

      // Set up texCoord attribute (doesn't change)
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.texCoordBuffer);
      this.gl.vertexAttribPointer(this.texCoordLocation, 2, this.gl.FLOAT, false, 0, 0);

      this.isInitialized = true;
      console.log('[WebGLCompositor] Initialized successfully');

    } catch (error) {
      console.warn('[WebGLCompositor] Initialization failed:', error);
      this.fallbackToCanvas2D = true;
    }
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    if (!this.gl) return null;

    const shader = this.gl.createShader(type);
    if (!shader) return null;

    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error('[WebGLCompositor] Shader compile error:', this.gl.getShaderInfoLog(shader));
      this.gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  private createProgram(vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram | null {
    if (!this.gl) return null;

    const program = this.gl.createProgram();
    if (!program) return null;

    this.gl.attachShader(program, vertexShader);
    this.gl.attachShader(program, fragmentShader);
    this.gl.linkProgram(program);

    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      console.error('[WebGLCompositor] Program link error:', this.gl.getProgramInfoLog(program));
      this.gl.deleteProgram(program);
      // Delete shaders on failure too
      this.gl.deleteShader(vertexShader);
      this.gl.deleteShader(fragmentShader);
      return null;
    }

    // Delete shaders after successful link - program contains compiled code
    // This frees GPU memory while keeping the program functional
    this.gl.deleteShader(vertexShader);
    this.gl.deleteShader(fragmentShader);

    return program;
  }

  private createTexture(bitmap: ImageBitmap): WebGLTexture | null {
    if (!this.gl) return null;

    const texture = this.gl.createTexture();
    if (!texture) return null;

    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);

    // Set texture parameters
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);

    // Upload bitmap
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      bitmap
    );

    return texture;
  }

  private setQuadVertices(x: number, y: number, width: number, height: number): void {
    if (!this.gl || !this.positionBuffer) return;

    // Set up position attribute for this quad
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([
        x, y,
        x + width, y,
        x, y + height,
        x, y + height,
        x + width, y,
        x + width, y + height,
      ]),
      this.gl.DYNAMIC_DRAW
    );
    this.gl.vertexAttribPointer(this.positionLocation, 2, this.gl.FLOAT, false, 0, 0);
  }

  private getTileKey(page: number, tileX: number, tileY: number, scale: number): string {
    return `${page}-${tileX}-${tileY}-s${scale}`;
  }

  private updateAccessOrder(key: string): void {
    const index = this.textureAccessOrder.indexOf(key);
    if (index > -1) {
      this.textureAccessOrder.splice(index, 1);
    }
    this.textureAccessOrder.push(key);
  }

  private evictOldest(): void {
    if (this.textureAccessOrder.length === 0 || !this.gl) return;

    // Remove oldest (first in array)
    const oldestKey = this.textureAccessOrder.shift();
    if (oldestKey) {
      const cached = this.textureCache.get(oldestKey);
      if (cached) {
        this.gl.deleteTexture(cached.texture);
        this.textureCache.delete(oldestKey);
      }
    }
  }

  /**
   * Reinitialize WebGL resources after context restoration
   * Called when GPU context is recovered after loss
   */
  private reinitializeAfterContextRestore(): void {
    if (!this.gl) {
      console.warn('[WebGLCompositor] Cannot reinitialize - no GL context');
      return;
    }

    try {
      // Recompile shaders
      const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, VERTEX_SHADER);
      const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

      if (!vertexShader || !fragmentShader) {
        console.error('[WebGLCompositor] Failed to recompile shaders after context restore');
        this.fallbackToCanvas2D = true;
        return;
      }

      // Recreate program
      this.program = this.createProgram(vertexShader, fragmentShader);
      if (!this.program) {
        console.error('[WebGLCompositor] Failed to recreate program after context restore');
        this.fallbackToCanvas2D = true;
        return;
      }

      // Re-get locations
      this.positionLocation = this.gl.getAttribLocation(this.program, 'a_position');
      this.texCoordLocation = this.gl.getAttribLocation(this.program, 'a_texCoord');
      this.resolutionLocation = this.gl.getUniformLocation(this.program, 'u_resolution');
      this.translationLocation = this.gl.getUniformLocation(this.program, 'u_translation');
      this.scaleLocation = this.gl.getUniformLocation(this.program, 'u_scale');
      this.textureLocation = this.gl.getUniformLocation(this.program, 'u_texture');

      // Recreate buffers
      this.positionBuffer = this.gl.createBuffer();
      this.texCoordBuffer = this.gl.createBuffer();

      // Set up texture coordinates
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.texCoordBuffer);
      this.gl.bufferData(
        this.gl.ARRAY_BUFFER,
        new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
        this.gl.STATIC_DRAW
      );

      // Re-enable vertex attributes
      this.gl.enableVertexAttribArray(this.positionLocation);
      this.gl.enableVertexAttribArray(this.texCoordLocation);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.texCoordBuffer);
      this.gl.vertexAttribPointer(this.texCoordLocation, 2, this.gl.FLOAT, false, 0, 0);

      console.log('[WebGLCompositor] Successfully reinitialized after context restore');
    } catch (error) {
      console.error('[WebGLCompositor] Reinitialize failed:', error);
      this.fallbackToCanvas2D = true;
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let compositorInstance: WebGLCompositor | null = null;

/**
 * Get or create the WebGL compositor for a canvas
 */
export function getWebGLCompositor(canvas: HTMLCanvasElement): WebGLCompositor {
  if (!compositorInstance || compositorInstance['canvas'] !== canvas) {
    if (compositorInstance) {
      compositorInstance.destroy();
    }
    compositorInstance = new WebGLCompositor(canvas);
  }
  return compositorInstance;
}

/**
 * Reset the compositor (for testing)
 */
export function resetWebGLCompositor(): void {
  if (compositorInstance) {
    compositorInstance.destroy();
    compositorInstance = null;
  }
}

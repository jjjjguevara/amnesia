/**
 * PDF SVG Text Layer
 *
 * Renders text layer using SVG for crisp text at any zoom level.
 * The server generates SVG with transparent text elements positioned
 * to match the PDF layout, enabling text selection at all zoom levels.
 *
 * Key benefits over HTML text layer:
 * - Vector rendering: text stays crisp at 16x zoom
 * - Simpler positioning: SVG viewBox handles coordinate transformation
 * - Better text selection: native SVG text elements
 */

/** Function to fetch SVG text layer from server */
export type SvgTextLayerFetcher = (pdfId: string, page: number) => Promise<string>;

export interface SvgTextLayerConfig {
  /** Show text layer for debugging (makes text visible) */
  debug?: boolean;
}

export interface SvgTextSelection {
  text: string;
  page: number;
  rects: DOMRect[];
}

export class PdfSvgTextLayer {
  private container: HTMLDivElement;
  private svgContainer: HTMLDivElement;
  private config: SvgTextLayerConfig;
  private currentSvg: SVGSVGElement | null = null;
  private currentPage = 0;
  // Store viewBox aspect ratio for dimension adjustments
  private viewBoxAspectRatio: number | null = null;

  constructor(parent: HTMLElement, config?: SvgTextLayerConfig) {
    this.config = config ?? {};

    // Outer container for positioning
    // z-index: 3 ensures SVG layer is above text layer (1) and annotation layer (2)
    this.container = document.createElement('div');
    this.container.className = 'pdf-svg-text-layer-container';
    this.container.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      pointer-events: auto;
      z-index: 3;
      user-select: text;
      -webkit-user-select: text;
    `;

    // Inner container for the SVG - uses flexbox to center SVG when aspect ratio differs
    this.svgContainer = document.createElement('div');
    this.svgContainer.className = 'pdf-svg-text-layer';
    this.svgContainer.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: text;
      -webkit-user-select: text;
    `;

    this.container.appendChild(this.svgContainer);
    parent.appendChild(this.container);
  }

  /**
   * Render SVG text layer by fetching from server
   *
   * @param pdfId - The PDF identifier
   * @param page - Page number (1-indexed)
   * @param width - Display width in pixels
   * @param height - Display height in pixels
   * @param fetcher - Function to fetch SVG text layer
   */
  async render(
    pdfId: string,
    page: number,
    width: number,
    height: number,
    fetcher: SvgTextLayerFetcher
  ): Promise<void> {
    try {
      this.currentPage = page;

      // Fetch SVG from server
      const svgText = await fetcher(pdfId, page);

      // Parse SVG
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');

      // Check for parsing errors
      const parseError = svgDoc.querySelector('parsererror');
      if (parseError) {
        console.error('[PdfSvgTextLayer] SVG parse error:', parseError.textContent);
        return;
      }

      const svg = svgDoc.documentElement as unknown as SVGSVGElement;

      // Parse viewBox to get original aspect ratio for proper scaling
      const viewBox = svg.getAttribute('viewBox');
      let adjustedWidth = width;
      let adjustedHeight = height;

      if (viewBox) {
        const parts = viewBox.split(/\s+/).map(Number);
        if (parts.length === 4) {
          const [, , vbWidth, vbHeight] = parts;
          if (vbWidth > 0 && vbHeight > 0) {
            const svgAspect = vbWidth / vbHeight;
            const containerAspect = width / height;
            this.viewBoxAspectRatio = svgAspect;

            // Adjust dimensions to match viewBox aspect ratio for pixel-perfect text alignment
            if (Math.abs(svgAspect - containerAspect) > 0.005) {
              if (containerAspect > svgAspect) {
                // Container is wider than SVG - use height and adjust width
                adjustedWidth = height * svgAspect;
              } else {
                // Container is taller than SVG - use width and adjust height
                adjustedHeight = width / svgAspect;
              }
            }
          }
        }
      }

      // Set SVG dimensions with aspect-ratio-adjusted values
      svg.setAttribute('width', `${adjustedWidth}px`);
      svg.setAttribute('height', `${adjustedHeight}px`);
      // Use 'xMidYMid meet' for uniform scaling that preserves aspect ratio
      // This ensures text remains crisp and properly positioned
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

      // Style SVG - DO NOT use width/height 100% as it overrides attribute values
      // and causes non-uniform scaling. Use adjusted pixel dimensions from attributes.
      // geometricPrecision forces vector-based scaling for crisp edges at any zoom
      svg.style.cssText = `
        display: block;
        overflow: visible;
        max-width: 100%;
        max-height: 100%;
        shape-rendering: geometricPrecision;
        text-rendering: geometricPrecision;
      `;

      // Apply debug mode if enabled (makes text visible)
      if (this.config.debug) {
        const style = svg.querySelector('style');
        if (style) {
          style.textContent = style.textContent?.replace(
            'fill: transparent',
            'fill: rgba(0, 0, 255, 0.3)'
          ) ?? '';
        }
      }

      // Clear and insert new SVG
      this.clear();
      this.svgContainer.appendChild(svg);
      this.currentSvg = svg;
    } catch (error) {
      console.error('[PdfSvgTextLayer] Failed to render:', error);
      // Re-throw so caller can fall back to HTML text layer
      throw error;
    }
  }

  /**
   * Get current text selection
   */
  getSelection(): SvgTextSelection | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return null;
    }

    const text = selection.toString().trim();
    if (!text) {
      return null;
    }

    return {
      text,
      page: this.currentPage,
      rects: this.getSelectionRects(),
    };
  }

  /**
   * Get selection rects relative to container
   */
  getSelectionRects(): DOMRect[] {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return [];
    }

    const range = selection.getRangeAt(0);
    const clientRects = range.getClientRects();
    if (clientRects.length === 0) {
      return [];
    }

    const containerRect = this.container.getBoundingClientRect();
    const result: DOMRect[] = [];

    // Merge adjacent rects on same line
    let currentRect: DOMRect | null = null;

    for (let i = 0; i < clientRects.length; i++) {
      const rect = clientRects[i];

      // Skip tiny rects
      if (rect.width < 1 || rect.height < 1) continue;

      // Convert to container coordinates
      const relX = rect.left - containerRect.left;
      const relY = rect.top - containerRect.top;

      if (currentRect && Math.abs(currentRect.y - relY) < 2) {
        // Same line - extend current rect
        const newRight = Math.max(currentRect.x + currentRect.width, relX + rect.width);
        const newLeft = Math.min(currentRect.x, relX);
        currentRect = new DOMRect(newLeft, currentRect.y, newRight - newLeft, currentRect.height);
      } else {
        // New line
        if (currentRect) {
          result.push(currentRect);
        }
        currentRect = new DOMRect(relX, relY, rect.width, rect.height);
      }
    }

    if (currentRect) {
      result.push(currentRect);
    }

    return result;
  }

  /**
   * Update dimensions (called when container resizes)
   * Uses stored viewBox aspect ratio for proper scaling
   */
  setDimensions(width: number, height: number): void {
    if (this.currentSvg) {
      let adjustedWidth = width;
      let adjustedHeight = height;

      // Use stored viewBox aspect ratio if available for consistent scaling
      if (this.viewBoxAspectRatio !== null) {
        const containerAspect = width / height;
        if (Math.abs(this.viewBoxAspectRatio - containerAspect) > 0.005) {
          if (containerAspect > this.viewBoxAspectRatio) {
            // Container is wider - use height and adjust width
            adjustedWidth = height * this.viewBoxAspectRatio;
          } else {
            // Container is taller - use width and adjust height
            adjustedHeight = width / this.viewBoxAspectRatio;
          }
        }
      }

      this.currentSvg.setAttribute('width', `${adjustedWidth}px`);
      this.currentSvg.setAttribute('height', `${adjustedHeight}px`);
    }
  }

  /**
   * Clear the text layer
   */
  clear(): void {
    this.svgContainer.innerHTML = '';
    this.currentSvg = null;
  }

  /**
   * Get current page number
   */
  getPage(): number {
    return this.currentPage;
  }

  /**
   * Get container element
   */
  getContainer(): HTMLDivElement {
    return this.container;
  }

  /**
   * Toggle debug mode (makes text visible)
   */
  setDebug(debug: boolean): void {
    this.config.debug = debug;

    if (this.currentSvg) {
      const style = this.currentSvg.querySelector('style');
      if (style) {
        if (debug) {
          style.textContent = style.textContent?.replace(
            'fill: transparent',
            'fill: rgba(0, 0, 255, 0.3)'
          ) ?? '';
        } else {
          style.textContent = style.textContent?.replace(
            'fill: rgba(0, 0, 255, 0.3)',
            'fill: transparent'
          ) ?? '';
        }
      }
    }
  }

  /**
   * Destroy the layer
   */
  destroy(): void {
    this.clear();
    this.container.remove();
  }
}

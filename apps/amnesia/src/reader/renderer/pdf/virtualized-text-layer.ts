/**
 * Virtualized Text Layer
 *
 * Only renders text spans that are visible in the viewport.
 * Uses IntersectionObserver and spatial indexing for efficient updates.
 *
 * Benefits:
 * - Reduces DOM node count for pages with many text items
 * - Faster initial render (only visible text)
 * - Lower memory usage
 */

import type { PdfTextLayer as TextLayerData, PdfTextItem } from '../types';

export type TextLayerMode = 'full' | 'virtualized' | 'disabled';

export interface VirtualizedTextLayerConfig {
  /** Text layer rendering mode. Default: 'virtualized' */
  mode?: TextLayerMode;
  /** Buffer around viewport (in pixels) for pre-rendering. Default: 100 */
  bufferPx?: number;
  /** Minimum items to trigger virtualization. Default: 50 */
  virtualizationThreshold?: number;
  /** Debug mode - show text layer. Default: false */
  debug?: boolean;
}

interface PositionedTextItem extends PdfTextItem {
  index: number;
  displayX: number;
  displayY: number;
  displayWidth: number;
  displayHeight: number;
  fontSize: number;
}

/**
 * Virtualized text layer for PDF pages
 */
export class VirtualizedTextLayer {
  private container: HTMLDivElement;
  private textContainer: HTMLDivElement;
  private config: Required<VirtualizedTextLayerConfig>;

  // Text data
  private textItems: PdfTextItem[] = [];
  private positionedItems: PositionedTextItem[] = [];
  private renderedIndices: Set<number> = new Set();

  // Display state
  private displayWidth = 0;
  private displayHeight = 0;
  private pageWidth = 612;
  private pageHeight = 792;
  private rotation = 0;

  // Virtualization
  private observer: IntersectionObserver | null = null;
  private scrollContainer: HTMLElement | null = null;
  private scrollListener: (() => void) | null = null;
  private isVirtualized = false;

  constructor(parent: HTMLElement, config: VirtualizedTextLayerConfig = {}) {
    this.config = {
      mode: config.mode ?? 'virtualized',
      bufferPx: config.bufferPx ?? 100,
      virtualizationThreshold: config.virtualizationThreshold ?? 50,
      debug: config.debug ?? false,
    };

    // Create container
    this.container = document.createElement('div');
    this.container.className = 'pdf-virtualized-text-layer-container';
    this.container.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      pointer-events: auto;
    `;

    // Create text container
    this.textContainer = document.createElement('div');
    this.textContainer.className = 'pdf-virtualized-text-layer';
    this.textContainer.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
      opacity: ${this.config.debug ? '0.3' : '0.001'};
      line-height: 1.0;
      user-select: text;
      -webkit-user-select: text;
    `;

    this.container.appendChild(this.textContainer);
    parent.appendChild(this.container);

    // Find scroll container for intersection observer
    this.findScrollContainer(parent);
  }

  /**
   * Find the scrollable ancestor for intersection observer root
   */
  private findScrollContainer(element: HTMLElement): void {
    let current: HTMLElement | null = element;
    while (current) {
      const style = getComputedStyle(current);
      if (style.overflow === 'auto' || style.overflow === 'scroll' ||
          style.overflowY === 'auto' || style.overflowY === 'scroll') {
        this.scrollContainer = current;
        break;
      }
      current = current.parentElement;
    }
  }

  /**
   * Set text layer data and render
   */
  render(
    textLayer: TextLayerData,
    scale: number,
    rotation: number,
    displayWidth: number,
    displayHeight: number
  ): void {
    this.clear();

    if (this.config.mode === 'disabled') {
      return;
    }

    this.textItems = textLayer.items;
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.pageWidth = textLayer.width;
    this.pageHeight = textLayer.height;
    this.rotation = rotation;

    // Pre-calculate positions for all items
    this.positionedItems = this.calculatePositions(textLayer.items, scale, rotation, displayWidth, displayHeight);

    // Decide whether to virtualize based on item count
    const shouldVirtualize =
      this.config.mode === 'virtualized' &&
      this.positionedItems.length >= this.config.virtualizationThreshold;

    if (shouldVirtualize) {
      this.isVirtualized = true;
      this.setupVirtualization();
      this.renderVisibleItems();
    } else {
      this.isVirtualized = false;
      this.renderAllItems();
    }
  }

  /**
   * Pre-calculate display positions for all text items
   */
  private calculatePositions(
    items: PdfTextItem[],
    scale: number,
    rotation: number,
    displayWidth: number,
    displayHeight: number
  ): PositionedTextItem[] {
    const isRotated = rotation === 90 || rotation === 270;
    const scaleX = displayWidth / (isRotated ? this.pageHeight : this.pageWidth);
    const scaleY = displayHeight / (isRotated ? this.pageWidth : this.pageHeight);

    return items.map((item, index) => {
      const pos = this.transformPosition(
        item.x, item.y, item.width, item.height,
        rotation, scaleX, scaleY, displayWidth, displayHeight
      );

      return {
        ...item,
        index,
        displayX: pos.x,
        displayY: pos.y,
        displayWidth: pos.width,
        displayHeight: pos.height,
        fontSize: item.fontSize * Math.min(scaleX, scaleY),
      };
    });
  }

  /**
   * Transform position based on rotation
   */
  private transformPosition(
    x: number, y: number, width: number, height: number,
    rotation: number, scaleX: number, scaleY: number,
    displayWidth: number, displayHeight: number
  ): { x: number; y: number; width: number; height: number } {
    const scaledX = x * scaleX;
    const scaledY = y * scaleY;
    const scaledWidth = width * scaleX;
    const scaledHeight = height * scaleY;

    switch (rotation) {
      case 90:
        return {
          x: displayWidth - scaledY - scaledHeight,
          y: scaledX,
          width: scaledHeight,
          height: scaledWidth,
        };
      case 180:
        return {
          x: displayWidth - scaledX - scaledWidth,
          y: displayHeight - scaledY - scaledHeight,
          width: scaledWidth,
          height: scaledHeight,
        };
      case 270:
        return {
          x: scaledY,
          y: displayHeight - scaledX - scaledWidth,
          width: scaledHeight,
          height: scaledWidth,
        };
      default:
        return {
          x: scaledX,
          y: scaledY,
          width: scaledWidth,
          height: scaledHeight,
        };
    }
  }

  /**
   * Setup virtualization with scroll listener
   */
  private setupVirtualization(): void {
    if (!this.scrollContainer) {
      // Fallback: render all if no scroll container found
      this.renderAllItems();
      return;
    }

    // Use scroll listener for virtualization updates
    // Store reference so we can remove it in destroy()
    this.scrollListener = () => {
      requestAnimationFrame(() => this.renderVisibleItems());
    };

    this.scrollContainer.addEventListener('scroll', this.scrollListener, { passive: true });
  }

  /**
   * Render only items visible in viewport
   */
  private renderVisibleItems(): void {
    const containerRect = this.container.getBoundingClientRect();
    const viewportTop = -this.config.bufferPx;
    const viewportBottom = containerRect.height + this.config.bufferPx;
    const viewportLeft = -this.config.bufferPx;
    const viewportRight = containerRect.width + this.config.bufferPx;

    const fragment = document.createDocumentFragment();
    const newlyVisible: number[] = [];

    for (const item of this.positionedItems) {
      // Skip empty text
      if (!item.text.trim()) continue;

      // Check if item overlaps viewport
      const isVisible =
        item.displayX < viewportRight &&
        item.displayX + item.displayWidth > viewportLeft &&
        item.displayY < viewportBottom &&
        item.displayY + item.displayHeight > viewportTop;

      if (isVisible && !this.renderedIndices.has(item.index)) {
        const span = this.createTextSpan(item);
        fragment.appendChild(span);
        this.renderedIndices.add(item.index);
        newlyVisible.push(item.index);
      }
    }

    if (fragment.childNodes.length > 0) {
      this.textContainer.appendChild(fragment);
    }

    // Remove items that are far from viewport (optional cleanup)
    // Only do this periodically to avoid thrashing
    if (this.renderedIndices.size > this.positionedItems.length * 0.8) {
      this.cleanupDistantItems(viewportTop, viewportBottom, viewportLeft, viewportRight);
    }
  }

  /**
   * Remove items that are far from viewport
   */
  private cleanupDistantItems(
    viewportTop: number, viewportBottom: number,
    viewportLeft: number, viewportRight: number
  ): void {
    const bufferMultiplier = 3; // Keep items within 3x buffer
    const cleanupTop = viewportTop - this.config.bufferPx * bufferMultiplier;
    const cleanupBottom = viewportBottom + this.config.bufferPx * bufferMultiplier;
    const cleanupLeft = viewportLeft - this.config.bufferPx * bufferMultiplier;
    const cleanupRight = viewportRight + this.config.bufferPx * bufferMultiplier;

    const spans = this.textContainer.querySelectorAll('span[data-idx]');
    for (const span of spans) {
      const idx = parseInt(span.getAttribute('data-idx') || '-1', 10);
      if (idx < 0) continue;

      const item = this.positionedItems[idx];
      if (!item) continue;

      const isFarAway =
        item.displayX > cleanupRight ||
        item.displayX + item.displayWidth < cleanupLeft ||
        item.displayY > cleanupBottom ||
        item.displayY + item.displayHeight < cleanupTop;

      if (isFarAway) {
        span.remove();
        this.renderedIndices.delete(idx);
      }
    }
  }

  /**
   * Render all items (non-virtualized mode)
   */
  private renderAllItems(): void {
    const fragment = document.createDocumentFragment();

    for (const item of this.positionedItems) {
      if (!item.text.trim()) continue;
      const span = this.createTextSpan(item);
      fragment.appendChild(span);
      this.renderedIndices.add(item.index);
    }

    this.textContainer.appendChild(fragment);
  }

  /**
   * Create a text span element
   */
  private createTextSpan(item: PositionedTextItem): HTMLSpanElement {
    const span = document.createElement('span');
    span.textContent = item.text;
    span.setAttribute('data-idx', String(item.index));

    const transform = this.getTransformForRotation(this.rotation);

    span.style.cssText = `
      position: absolute;
      left: ${item.displayX}px;
      top: ${item.displayY}px;
      width: ${item.displayWidth}px;
      height: ${item.displayHeight}px;
      font-size: ${item.fontSize}px;
      font-family: sans-serif;
      white-space: pre;
      transform-origin: 0 0;
      ${transform ? `transform: ${transform};` : ''}
    `;

    return span;
  }

  /**
   * Get CSS transform for rotation
   */
  private getTransformForRotation(rotation: number): string {
    switch (rotation) {
      case 90:
        return 'rotate(-90deg) translateX(-100%)';
      case 180:
        return 'rotate(180deg)';
      case 270:
        return 'rotate(90deg) translateY(-100%)';
      default:
        return '';
    }
  }

  /**
   * Get full text content
   */
  getFullText(): string {
    return this.textItems.map(item => item.text).join(' ');
  }

  /**
   * Get selection info
   */
  getSelection(): { text: string; prefix: string; suffix: string } | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;

    const text = selection.toString().trim();
    if (!text) return null;

    const fullText = this.getFullText();
    const startIndex = fullText.indexOf(text);

    if (startIndex === -1) {
      return { text, prefix: '', suffix: '' };
    }

    const prefixStart = Math.max(0, startIndex - 32);
    const suffixEnd = Math.min(fullText.length, startIndex + text.length + 32);

    return {
      text,
      prefix: fullText.slice(prefixStart, startIndex),
      suffix: fullText.slice(startIndex + text.length, suffixEnd),
    };
  }

  /**
   * Get selection rects relative to container
   */
  getSelectionRects(): DOMRect[] {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return [];

    const range = selection.getRangeAt(0);
    const clientRects = range.getClientRects();
    if (clientRects.length === 0) return [];

    const containerRect = this.container.getBoundingClientRect();
    const result: DOMRect[] = [];

    for (let i = 0; i < clientRects.length; i++) {
      const rect = clientRects[i];
      if (rect.width < 1 || rect.height < 1) continue;

      result.push(new DOMRect(
        rect.left - containerRect.left,
        rect.top - containerRect.top,
        rect.width,
        rect.height
      ));
    }

    return result;
  }

  /**
   * Update mode at runtime
   */
  setMode(mode: TextLayerMode): void {
    if (mode === this.config.mode) return;
    this.config.mode = mode;
    // Would need to re-render with stored data
  }

  /**
   * Set debug visibility
   */
  setDebug(debug: boolean): void {
    this.config.debug = debug;
    this.textContainer.style.opacity = debug ? '0.3' : '0.001';
  }

  /**
   * Get container element
   */
  getContainer(): HTMLDivElement {
    return this.container;
  }

  /**
   * Get stats for debugging
   */
  getStats(): {
    totalItems: number;
    renderedItems: number;
    mode: TextLayerMode;
    rotation: number;
    isVirtualized: boolean;
  } {
    return {
      totalItems: this.positionedItems.length,
      renderedItems: this.renderedIndices.size,
      mode: this.config.mode,
      rotation: this.rotation,
      isVirtualized: this.isVirtualized,
    };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<VirtualizedTextLayerConfig>): void {
    if (config.mode !== undefined) {
      this.config.mode = config.mode;
    }
    if (config.bufferPx !== undefined) {
      this.config.bufferPx = config.bufferPx;
    }
    if (config.virtualizationThreshold !== undefined) {
      this.config.virtualizationThreshold = config.virtualizationThreshold;
    }
    if (config.debug !== undefined) {
      this.config.debug = config.debug;
      this.textContainer.style.opacity = config.debug ? '0.3' : '0.001';
    }
  }

  /**
   * Clear the text layer
   */
  clear(): void {
    this.textContainer.innerHTML = '';
    this.textItems = [];
    this.positionedItems = [];
    this.renderedIndices.clear();
    this.isVirtualized = false;
  }

  /**
   * Destroy the layer
   */
  destroy(): void {
    this.clear();

    // Remove scroll listener to prevent memory leak
    if (this.scrollListener && this.scrollContainer) {
      this.scrollContainer.removeEventListener('scroll', this.scrollListener);
      this.scrollListener = null;
    }

    this.observer?.disconnect();
    this.observer = null;
    this.scrollContainer = null;
    this.container.remove();
  }
}

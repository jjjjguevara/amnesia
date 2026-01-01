/**
 * PDF Text Layer
 *
 * Renders invisible text layer overlay for text selection.
 * Positions text items to match the canvas rendering.
 */

import type { PdfTextLayer as TextLayerData, PdfTextItem } from '../types';

export interface TextLayerConfig {
  /** Show text layer for debugging */
  debug?: boolean;
}

export interface TextSelection {
  text: string;
  prefix: string;
  suffix: string;
  startIndex: number;
  endIndex: number;
  page: number;
}

export class PdfTextLayer {
  private container: HTMLDivElement;
  private textContainer: HTMLDivElement;
  private config: TextLayerConfig;

  // Current state
  private currentPage = 0;
  private currentScale = 1.0;
  private currentRotation = 0;
  private pageWidth = 0;
  private pageHeight = 0;
  private textItems: PdfTextItem[] = [];

  constructor(parent: HTMLElement, config?: TextLayerConfig) {
    this.config = config ?? {};

    this.container = document.createElement('div');
    this.container.className = 'pdf-text-layer-container';
    this.container.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      pointer-events: auto;
    `;

    this.textContainer = document.createElement('div');
    this.textContainer.className = 'pdf-text-layer';
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
  }

  /**
   * Render text layer from server data
   */
  render(
    textLayer: TextLayerData,
    scale: number,
    rotation: number,
    displayWidth: number,
    displayHeight: number
  ): void {
    this.clear();

    this.currentPage = textLayer.page;
    this.currentScale = scale;
    this.currentRotation = rotation;
    this.pageWidth = textLayer.width;
    this.pageHeight = textLayer.height;
    this.textItems = textLayer.items;

    // Calculate scale factors
    const isRotated = rotation === 90 || rotation === 270;
    const scaleX = displayWidth / (isRotated ? textLayer.height : textLayer.width);
    const scaleY = displayHeight / (isRotated ? textLayer.width : textLayer.height);

    // Create text spans for each item
    for (const item of textLayer.items) {
      if (!item.text.trim()) continue;

      const span = document.createElement('span');
      span.textContent = item.text;

      // Calculate transformed position
      const pos = this.transformPosition(
        item.x,
        item.y,
        item.width,
        item.height,
        rotation,
        scaleX,
        scaleY,
        displayWidth,
        displayHeight
      );

      span.style.cssText = `
        position: absolute;
        left: ${pos.x}px;
        top: ${pos.y}px;
        width: ${pos.width}px;
        height: ${pos.height}px;
        font-size: ${item.fontSize * Math.min(scaleX, scaleY)}px;
        font-family: sans-serif;
        white-space: pre;
        transform-origin: 0 0;
        ${pos.transform ? `transform: ${pos.transform};` : ''}
      `;

      this.textContainer.appendChild(span);
    }
  }

  /**
   * Transform text item position based on rotation and scale
   */
  private transformPosition(
    x: number,
    y: number,
    width: number,
    height: number,
    rotation: number,
    scaleX: number,
    scaleY: number,
    displayWidth: number,
    displayHeight: number
  ): { x: number; y: number; width: number; height: number; transform?: string } {
    // Scale to display size
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
          transform: 'rotate(-90deg) translateX(-100%)',
        };
      case 180:
        return {
          x: displayWidth - scaledX - scaledWidth,
          y: displayHeight - scaledY - scaledHeight,
          width: scaledWidth,
          height: scaledHeight,
          transform: 'rotate(180deg)',
        };
      case 270:
        return {
          x: scaledY,
          y: displayHeight - scaledX - scaledWidth,
          width: scaledHeight,
          height: scaledWidth,
          transform: 'rotate(90deg) translateY(-100%)',
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
   * Get current text selection
   */
  getSelection(): TextSelection | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return null;
    }

    const text = selection.toString();
    if (!text.trim()) {
      return null;
    }

    // Get all text content for context
    const fullText = this.getFullText();
    const selectedText = text;

    // Find the selection in the full text
    const startIndex = fullText.indexOf(selectedText);
    if (startIndex === -1) {
      return {
        text: selectedText,
        prefix: '',
        suffix: '',
        startIndex: 0,
        endIndex: selectedText.length,
        page: this.currentPage,
      };
    }

    // Extract context (32 chars before and after)
    const prefixStart = Math.max(0, startIndex - 32);
    const suffixEnd = Math.min(fullText.length, startIndex + selectedText.length + 32);

    return {
      text: selectedText,
      prefix: fullText.slice(prefixStart, startIndex),
      suffix: fullText.slice(startIndex + selectedText.length, suffixEnd),
      startIndex,
      endIndex: startIndex + selectedText.length,
      page: this.currentPage,
    };
  }

  /**
   * Get all text content as a single string
   */
  getFullText(): string {
    return this.textItems.map((item) => item.text).join(' ');
  }

  /**
   * Get selection bounding rect relative to container
   */
  getSelectionRect(): DOMRect | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    if (rects.length === 0) {
      return null;
    }

    // Get bounding rect of all selection rects
    const containerRect = this.container.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const rect of rects) {
      minX = Math.min(minX, rect.left - containerRect.left);
      minY = Math.min(minY, rect.top - containerRect.top);
      maxX = Math.max(maxX, rect.right - containerRect.left);
      maxY = Math.max(maxY, rect.bottom - containerRect.top);
    }

    return new DOMRect(minX, minY, maxX - minX, maxY - minY);
  }

  /**
   * Clear text layer
   */
  clear(): void {
    this.textContainer.innerHTML = '';
    this.textItems = [];
  }

  /**
   * Get current page
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
   * Update visibility (for debugging)
   */
  setDebug(debug: boolean): void {
    this.config.debug = debug;
    this.textContainer.style.opacity = debug ? '0.3' : '0.001';
  }

  /**
   * Destroy the layer
   */
  destroy(): void {
    this.container.remove();
  }
}

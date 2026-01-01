/**
 * Selection Handler
 *
 * Handles text selection within the EPUB content iframe.
 * Detects selections and extracts position/context information.
 */

import type { RendererConfig, TextSelector } from './types';

/**
 * Selection data passed to callback
 */
export interface SelectionData {
  text: string;
  range: Range;
  position: { x: number; y: number };
  selector: TextSelector;
}

/**
 * Selection callback type
 */
export type SelectionCallback = (selection: SelectionData) => void;

/**
 * Text Selection Handler
 *
 * Works with both regular documents and Shadow DOM.
 * For Shadow DOM, listens on the shadow root for events
 * but uses window.getSelection() for the selection API.
 */
export class SelectionHandler {
  private doc: Document;
  private eventTarget: EventTarget; // Shadow root or document
  private config: RendererConfig;
  private onSelection: SelectionCallback;

  // Selection state
  private lastSelection: Selection | null = null;
  private selectionTimeout: number | null = null;

  // Track actual pointer position for accurate popup placement
  private lastPointerPosition = { x: 0, y: 0 };

  // Bound event handlers for cleanup
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundTouchEnd: (e: TouchEvent) => void;
  private boundSelectionChange: () => void;

  constructor(
    doc: Document,
    config: RendererConfig,
    onSelection: SelectionCallback,
    shadowRoot?: ShadowRoot
  ) {
    this.doc = doc;
    this.eventTarget = shadowRoot || doc;
    this.config = config;
    this.onSelection = onSelection;

    // Bind handlers for proper cleanup
    this.boundMouseMove = (e: MouseEvent) => {
      this.lastPointerPosition = { x: e.clientX, y: e.clientY };
    };
    this.boundMouseUp = (e: MouseEvent) => {
      this.lastPointerPosition = { x: e.clientX, y: e.clientY };
      this.handleSelectionEnd();
    };
    this.boundTouchEnd = (e: TouchEvent) => {
      if (e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        this.lastPointerPosition = { x: touch.clientX, y: touch.clientY };
      }
      setTimeout(() => this.handleSelectionEnd(), 100);
    };
    this.boundSelectionChange = () => {
      if (this.selectionTimeout) {
        clearTimeout(this.selectionTimeout);
      }
      this.selectionTimeout = window.setTimeout(() => {
        this.handleSelectionChange();
      }, 200);
    };

    this.setupEventListeners();
  }

  /**
   * Set up event listeners for selection
   */
  private setupEventListeners(): void {
    // For Shadow DOM, listen on the shadow root for mouse/touch events
    // These events bubble up within the shadow DOM
    this.eventTarget.addEventListener('mousemove', this.boundMouseMove as EventListener);
    this.eventTarget.addEventListener('mouseup', this.boundMouseUp as EventListener);
    this.eventTarget.addEventListener('touchend', this.boundTouchEnd as EventListener);

    // Selection change event is always on document
    this.doc.addEventListener('selectionchange', this.boundSelectionChange);
  }

  /**
   * Handle end of selection (mouseup/touchend)
   */
  private handleSelectionEnd(): void {
    console.log('[SelectionHandler] handleSelectionEnd called');
    // Use window.getSelection() which works with both regular DOM and Shadow DOM
    const selection = window.getSelection();
    if (!selection) {
      console.log('[SelectionHandler] No selection');
      return;
    }

    // Check text content instead of isCollapsed - Shadow DOM has quirks where
    // isCollapsed can be true even when text is selected
    const text = selection.toString().trim();
    if (!text) {
      console.log('[SelectionHandler] Empty text or collapsed');
      return;
    }

    console.log('[SelectionHandler] Processing selection:', text.substring(0, 50));
    this.processSelection(selection);
  }

  /**
   * Handle selection change events
   */
  private handleSelectionChange(): void {
    const selection = window.getSelection();
    if (!selection) {
      this.lastSelection = null;
      return;
    }

    // Check text content instead of isCollapsed for Shadow DOM compatibility
    const text = selection.toString().trim();
    if (!text) {
      this.lastSelection = null;
      return;
    }

    this.lastSelection = selection;
  }

  /**
   * Process and report a selection
   */
  private processSelection(selection: Selection): void {
    const text = selection.toString().trim();
    if (!text) return;

    const range = selection.getRangeAt(0);
    if (!range) return;

    // Get position for popup
    const position = this.getSelectionPosition(range);

    // Build selector
    const selector = this.buildSelector(range, text);

    // Report selection
    this.onSelection({
      text,
      range: range.cloneRange(),
      position,
      selector,
    });
  }

  /**
   * Get position for selection popup - uses actual pointer position for accuracy
   * Returns position relative to the iframe document - the renderer will translate to viewport coords
   */
  private getSelectionPosition(range: Range): { x: number; y: number } {
    // Use the actual pointer position captured on mouseup/touchend
    // This gives us the exact position where the user released, like a context menu
    return { ...this.lastPointerPosition };
  }

  /**
   * Build a multi-selector for the selection
   */
  private buildSelector(range: Range, text: string): TextSelector {
    const selector: TextSelector = {};

    // Text quote selector with context
    selector.textQuote = this.buildTextQuote(range, text);

    // Text position selector
    selector.textPosition = this.buildTextPosition(range);

    // CFI will be added by the renderer

    return selector;
  }

  /**
   * Build text quote selector with prefix/suffix context
   */
  private buildTextQuote(
    range: Range,
    text: string
  ): { exact: string; prefix?: string; suffix?: string } {
    const contextLength = 32;

    // Get prefix (text before selection)
    const prefix = this.getTextBefore(range, contextLength);

    // Get suffix (text after selection)
    const suffix = this.getTextAfter(range, contextLength);

    return {
      exact: text,
      prefix: prefix || undefined,
      suffix: suffix || undefined,
    };
  }

  /**
   * Get text before the range
   */
  private getTextBefore(range: Range, maxLength: number): string {
    try {
      const container = range.startContainer;
      if (container.nodeType !== Node.TEXT_NODE) {
        return '';
      }

      const textContent = container.textContent || '';
      const start = Math.max(0, range.startOffset - maxLength);
      return textContent.substring(start, range.startOffset);
    } catch {
      return '';
    }
  }

  /**
   * Get text after the range
   */
  private getTextAfter(range: Range, maxLength: number): string {
    try {
      const container = range.endContainer;
      if (container.nodeType !== Node.TEXT_NODE) {
        return '';
      }

      const textContent = container.textContent || '';
      const end = Math.min(textContent.length, range.endOffset + maxLength);
      return textContent.substring(range.endOffset, end);
    } catch {
      return '';
    }
  }

  /**
   * Build text position selector
   */
  private buildTextPosition(range: Range): { start: number; end: number } {
    // Calculate character offset from start of document
    const walker = this.doc.createTreeWalker(
      this.doc.body,
      NodeFilter.SHOW_TEXT,
      null
    );

    let charCount = 0;
    let startOffset = 0;
    let endOffset = 0;
    let foundStart = false;
    let foundEnd = false;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const nodeLength = node.textContent?.length || 0;

      if (!foundStart && node === range.startContainer) {
        startOffset = charCount + range.startOffset;
        foundStart = true;
      }

      if (!foundEnd && node === range.endContainer) {
        endOffset = charCount + range.endOffset;
        foundEnd = true;
        break;
      }

      charCount += nodeLength;
    }

    return { start: startOffset, end: endOffset };
  }

  /**
   * Clear current selection
   */
  clearSelection(): void {
    const selection = this.doc.getSelection();
    selection?.removeAllRanges();
    this.lastSelection = null;
  }

  /**
   * Get current selection text
   */
  getCurrentSelection(): string | null {
    const selection = this.doc.getSelection();
    if (!selection || selection.isCollapsed) {
      return null;
    }
    return selection.toString().trim() || null;
  }

  /**
   * Select a range programmatically
   */
  selectRange(range: Range): void {
    const selection = this.doc.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  /**
   * Create a range from text position selector
   */
  createRangeFromPosition(
    start: number,
    end: number
  ): Range | null {
    const range = this.doc.createRange();
    const walker = this.doc.createTreeWalker(
      this.doc.body,
      NodeFilter.SHOW_TEXT,
      null
    );

    let charCount = 0;
    let foundStart = false;
    let foundEnd = false;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const nodeLength = node.textContent?.length || 0;
      const nodeEnd = charCount + nodeLength;

      if (!foundStart && start >= charCount && start <= nodeEnd) {
        range.setStart(node, start - charCount);
        foundStart = true;
      }

      if (!foundEnd && end >= charCount && end <= nodeEnd) {
        range.setEnd(node, end - charCount);
        foundEnd = true;
        break;
      }

      charCount = nodeEnd;
    }

    if (foundStart && foundEnd) {
      return range;
    }

    return null;
  }

  /**
   * Find and select text using text quote selector
   */
  findAndSelectText(
    exact: string,
    prefix?: string,
    suffix?: string
  ): boolean {
    const body = this.doc.body;
    const textContent = body.textContent || '';

    // Build search pattern
    let searchIndex = -1;

    if (prefix && suffix) {
      // Search with context
      const pattern = prefix + exact + suffix;
      const patternIndex = textContent.indexOf(pattern);
      if (patternIndex !== -1) {
        searchIndex = patternIndex + prefix.length;
      }
    }

    if (searchIndex === -1) {
      // Fallback: search just for exact text
      searchIndex = textContent.indexOf(exact);
    }

    if (searchIndex === -1) {
      return false;
    }

    // Create range from position
    const range = this.createRangeFromPosition(
      searchIndex,
      searchIndex + exact.length
    );

    if (range) {
      this.selectRange(range);
      return true;
    }

    return false;
  }

  /**
   * Update configuration
   */
  updateConfig(config: RendererConfig): void {
    this.config = config;
  }

  /**
   * Destroy the handler
   */
  destroy(): void {
    if (this.selectionTimeout) {
      clearTimeout(this.selectionTimeout);
    }

    // Remove event listeners
    this.eventTarget.removeEventListener('mousemove', this.boundMouseMove as EventListener);
    this.eventTarget.removeEventListener('mouseup', this.boundMouseUp as EventListener);
    this.eventTarget.removeEventListener('touchend', this.boundTouchEnd as EventListener);
    this.doc.removeEventListener('selectionchange', this.boundSelectionChange);
  }
}

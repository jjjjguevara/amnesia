/**
 * Test fixtures for PDF text layer data
 */

import type { PdfTextLayer } from '../../../reader/renderer/types';

/**
 * Create a minimal text layer with a few items
 */
export function createMinimalTextLayer(): PdfTextLayer {
  return {
    items: [
      { text: 'Hello', x: 72, y: 72, width: 50, height: 12 },
      { text: 'World', x: 130, y: 72, width: 50, height: 12 },
    ],
    width: 612,
    height: 792,
  };
}

/**
 * Create a text layer with many items (for virtualization testing)
 */
export function createLargeTextLayer(itemCount: number = 200): PdfTextLayer {
  const items: PdfTextLayer['items'] = [];
  const wordsPerLine = 10;
  const lineHeight = 14;
  const wordWidth = 50;
  const margin = 72;

  for (let i = 0; i < itemCount; i++) {
    const lineIndex = Math.floor(i / wordsPerLine);
    const wordIndex = i % wordsPerLine;

    items.push({
      text: `word${i}`,
      x: margin + wordIndex * (wordWidth + 5),
      y: margin + lineIndex * lineHeight,
      width: wordWidth,
      height: 12,
    });
  }

  return {
    items,
    width: 612,
    height: 792,
  };
}

/**
 * Create an empty text layer
 */
export function createEmptyTextLayer(): PdfTextLayer {
  return {
    items: [],
    width: 612,
    height: 792,
  };
}

/**
 * Create a text layer simulating a scanned page (no text)
 */
export function createScannedPageTextLayer(): PdfTextLayer {
  return {
    items: [],
    width: 612,
    height: 792,
  };
}

/**
 * Create a text layer with multi-line paragraphs
 */
export function createParagraphTextLayer(): PdfTextLayer {
  const paragraph = `Lorem ipsum dolor sit amet, consectetur adipiscing elit.
Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.`;

  const words = paragraph.split(/\s+/);
  const items: PdfTextLayer['items'] = [];

  let x = 72;
  let y = 72;
  const lineWidth = 500;
  const wordSpacing = 5;
  const lineHeight = 14;

  for (const word of words) {
    const wordWidth = word.length * 6; // Approximate width

    if (x + wordWidth > lineWidth + 72) {
      x = 72;
      y += lineHeight;
    }

    items.push({
      text: word,
      x,
      y,
      width: wordWidth,
      height: 12,
    });

    x += wordWidth + wordSpacing;
  }

  return {
    items,
    width: 612,
    height: 792,
  };
}

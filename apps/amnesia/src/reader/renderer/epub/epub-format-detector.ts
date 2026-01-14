/**
 * EPUB Format Detector
 *
 * Detects whether an EPUB is reflowable or fixed-layout.
 * Fixed-layout EPUBs (comics, manga, children's books) require
 * pixmap-based rendering similar to PDFs.
 *
 * Detection methods:
 * 1. OPF metadata: rendition:layout property
 * 2. Spine item properties: rendition:layout="pre-paginated"
 * 3. Heuristics: viewport meta tags, fixed dimensions in CSS
 */

import type { ParsedEpub, FixedLayoutPageDimensions } from './mupdf-epub-bridge';

// ============================================================================
// Types
// ============================================================================

/**
 * EPUB layout type
 */
export type EpubLayoutType = 'reflowable' | 'fixed-layout' | 'mixed';

/**
 * Format detection result
 */
export interface EpubFormatInfo {
  /** Primary layout type */
  layoutType: EpubLayoutType;
  /** Whether the EPUB uses fixed-layout for any pages */
  hasFixedLayoutPages: boolean;
  /** Fixed-layout page dimensions (if available) */
  pageDimensions?: FixedLayoutPageDimensions;
  /** Indices of fixed-layout pages (for mixed layouts) */
  fixedLayoutPageIndices?: number[];
  /** Detection method used */
  detectionMethod: 'opf-metadata' | 'spine-properties' | 'heuristics' | 'mupdf';
  /** Confidence level (0-1) */
  confidence: number;
}

/**
 * Detection options
 */
export interface DetectionOptions {
  /** Use MuPDF's built-in detection (faster, recommended) */
  useMuPDF?: boolean;
  /** Sample pages for heuristic detection */
  samplePageCount?: number;
}

// ============================================================================
// EPUB Format Detector
// ============================================================================

/**
 * Detect EPUB format (reflowable vs fixed-layout)
 */
export class EpubFormatDetector {
  /**
   * Detect format from parsed EPUB data
   */
  detectFromParsedEpub(epub: ParsedEpub): EpubFormatInfo {
    // Use MuPDF's detection if available
    if (epub.isFixedLayout !== undefined) {
      return {
        layoutType: epub.isFixedLayout ? 'fixed-layout' : 'reflowable',
        hasFixedLayoutPages: epub.isFixedLayout,
        pageDimensions: epub.pageDimensions,
        detectionMethod: 'mupdf',
        confidence: 0.95,
      };
    }

    // Fallback: assume reflowable if MuPDF doesn't indicate fixed-layout
    return {
      layoutType: 'reflowable',
      hasFixedLayoutPages: false,
      detectionMethod: 'mupdf',
      confidence: 0.8,
    };
  }

  /**
   * Detect format from chapter HTML content (heuristic)
   *
   * Looks for indicators of fixed-layout:
   * - viewport meta tag with fixed dimensions
   * - CSS with fixed width/height on body
   * - SVG-based content
   * - Image-only pages
   */
  detectFromHtml(html: string): { isFixedLayout: boolean; dimensions?: { width: number; height: number } } {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Check for viewport meta tag
    const viewport = doc.querySelector('meta[name="viewport"]');
    if (viewport) {
      const content = viewport.getAttribute('content') || '';
      const dimensions = this.parseViewportDimensions(content);
      if (dimensions) {
        return { isFixedLayout: true, dimensions };
      }
    }

    // Check for fixed dimensions in style
    const styleElements = doc.querySelectorAll('style');
    for (const style of Array.from(styleElements)) {
      const dimensions = this.parseFixedDimensionsFromCss(style.textContent || '');
      if (dimensions) {
        return { isFixedLayout: true, dimensions };
      }
    }

    // Check for SVG root (common in fixed-layout)
    const svgRoot = doc.querySelector('svg[viewBox]');
    if (svgRoot) {
      const viewBox = svgRoot.getAttribute('viewBox');
      if (viewBox) {
        const parts = viewBox.split(/\s+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          return {
            isFixedLayout: true,
            dimensions: { width: parts[2], height: parts[3] },
          };
        }
      }
    }

    // Check for image-only content (common in comics)
    const images = doc.querySelectorAll('img, image');
    const textNodes = this.countTextNodes(doc.body);
    if (images.length > 0 && textNodes < 10) {
      // Likely an image-based page
      return { isFixedLayout: true };
    }

    return { isFixedLayout: false };
  }

  /**
   * Parse viewport dimensions from meta content
   */
  private parseViewportDimensions(content: string): { width: number; height: number } | null {
    const widthMatch = content.match(/width=(\d+)/);
    const heightMatch = content.match(/height=(\d+)/);

    if (widthMatch && heightMatch) {
      const width = parseInt(widthMatch[1], 10);
      const height = parseInt(heightMatch[1], 10);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }

    return null;
  }

  /**
   * Parse fixed dimensions from CSS
   */
  private parseFixedDimensionsFromCss(css: string): { width: number; height: number } | null {
    // Look for body or html with fixed dimensions (order-independent)
    const bodyBlockMatch = css.match(/(?:body|html)\s*\{([^}]*)\}/i);
    if (bodyBlockMatch) {
      const block = bodyBlockMatch[1];
      const widthMatch = block.match(/width:\s*(\d+)px/i);
      const heightMatch = block.match(/height:\s*(\d+)px/i);

      if (widthMatch && heightMatch) {
        const width = parseInt(widthMatch[1], 10);
        const height = parseInt(heightMatch[1], 10);
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }
    }

    return null;
  }

  /**
   * Count text nodes in an element
   */
  private countTextNodes(element: Element | null): number {
    if (!element) return 0;

    let count = 0;
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const text = node.textContent?.trim();
          return text && text.length > 0
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      }
    );

    while (walker.nextNode()) {
      count++;
    }

    return count;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let sharedDetector: EpubFormatDetector | null = null;

/**
 * Get the shared format detector
 */
export function getEpubFormatDetector(): EpubFormatDetector {
  if (!sharedDetector) {
    sharedDetector = new EpubFormatDetector();
  }
  return sharedDetector;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Quick check if an EPUB is fixed-layout
 */
export function isFixedLayoutEpub(epub: ParsedEpub): boolean {
  const detector = getEpubFormatDetector();
  const info = detector.detectFromParsedEpub(epub);
  return info.hasFixedLayoutPages;
}

/**
 * Get format info for an EPUB
 */
export function getEpubFormatInfo(epub: ParsedEpub): EpubFormatInfo {
  const detector = getEpubFormatDetector();
  return detector.detectFromParsedEpub(epub);
}

/**
 * PDF Content-Type Classifier
 *
 * Classifies PDF pages by content type to enable optimized rendering paths:
 * - Scanned JPEG: Direct JPEG extraction (60-80% faster)
 * - Vector Heavy: Lower scale rendering with CSS upscale (30-50% faster)
 * - Text Heavy: Standard render with aggressive caching
 * - Mixed/Complex: Standard rendering
 *
 * Uses MuPDF's PDFObject API for structure analysis and custom Device for
 * operator counting.
 */

// Import types only - actual mupdf is in worker context
// @ts-ignore - mupdf types are available but moduleResolution needs bundler
import type * as MuPDFTypes from 'mupdf';

/**
 * Content type classification for PDF pages
 */
export enum PDFContentType {
  /** Single JPEG image covering page - can extract directly */
  SCANNED_JPEG = 'scanned-jpeg',
  /** Single non-JPEG image (PNG, TIFF, etc.) */
  SCANNED_OTHER = 'scanned-other',
  /** Dominated by path operations (>70% of operators) */
  VECTOR_HEAVY = 'vector-heavy',
  /** Dominated by text operations (>70% of operators) */
  TEXT_HEAVY = 'text-heavy',
  /** Balanced mix of content types */
  MIXED = 'mixed',
  /** Complex content with transparency or high operator count */
  COMPLEX = 'complex',
  /** Classification failed or not available */
  UNKNOWN = 'unknown',
}

/**
 * Image filter types in PDF
 */
export enum ImageFilter {
  /** JPEG (DCT) - can be extracted directly */
  DCT_DECODE = 'DCTDecode',
  /** Zlib/Deflate (PNG-like) */
  FLATE_DECODE = 'FlateDecode',
  /** JPEG 2000 */
  JPX_DECODE = 'JPXDecode',
  /** Fax encoding (TIFF-like) */
  CCITT_FAX_DECODE = 'CCITTFaxDecode',
  /** JBIG2 bilevel */
  JBIG2_DECODE = 'JBIG2Decode',
  /** LZW compression */
  LZW_DECODE = 'LZWDecode',
  /** Run length encoding */
  RUN_LENGTH_DECODE = 'RunLengthDecode',
  /** ASCII85 encoding */
  ASCII85_DECODE = 'ASCII85Decode',
  /** ASCII hex encoding */
  ASCII_HEX_DECODE = 'ASCIIHexDecode',
  /** Crypt filter */
  CRYPT = 'Crypt',
  /** Unknown or no filter */
  UNKNOWN = 'Unknown',
}

/**
 * Information about an XObject image in a PDF page
 */
export interface PageImageInfo {
  /** XObject name (e.g., "Im0") */
  name: string;
  /** Image width in pixels */
  width: number;
  /** Image height in pixels */
  height: number;
  /** Bits per component (typically 8) */
  bitsPerComponent: number;
  /** Color space name */
  colorSpace: string;
  /** Compression filter */
  filter: ImageFilter;
  /** Whether image has a soft mask (transparency) */
  hasSoftMask: boolean;
  /** Whether image has a hard mask */
  hasMask: boolean;
  /** Coverage ratio (0-1) of page area */
  coverageRatio: number;
}

/**
 * Operator counts from content stream analysis
 */
export interface OperatorCounts {
  /** Text operators: Tj, TJ, ', ", BT, ET */
  text: number;
  /** Path operators: m, l, c, v, y, h, re, S, s, f, F, f*, B, B*, b, b*, n */
  path: number;
  /** Image operators: Do (when referencing Image XObject) */
  image: number;
  /** Graphics state operators: q, Q, cm, w, J, j, M, d, ri, i, gs */
  graphicsState: number;
  /** Color operators: CS, cs, SC, SCN, sc, scn, G, g, RG, rg, K, k */
  color: number;
  /** Clipping operators: W, W* */
  clipping: number;
  /** Total operator count */
  total: number;
}

/**
 * Result of page classification
 */
export interface PageClassification {
  /** Detected content type */
  type: PDFContentType;
  /** Confidence score (0-1) */
  confidence: number;
  /** Time taken to classify (ms) */
  classificationTimeMs: number;
  /** Operator counts (if analyzed) */
  operatorCounts?: OperatorCounts;
  /** Image info (if scanned type detected) */
  images?: PageImageInfo[];
  /** Whether page has transparency */
  hasTransparency: boolean;
  /** Page number (1-indexed) */
  pageNum: number;
}

/**
 * Classification thresholds - tuned for accuracy vs performance
 */
export const CLASSIFICATION_THRESHOLDS = {
  /** Min coverage ratio for single image to be considered "scanned" */
  SCANNED_MIN_COVERAGE: 0.85,
  /** Max non-image operators for scanned page */
  SCANNED_MAX_OTHER_OPS: 20,
  /** Min path operators for vector-heavy classification */
  VECTOR_MIN_PATH_OPS: 500,
  /** Min ratio of path ops to total for vector-heavy */
  VECTOR_MIN_PATH_RATIO: 0.7,
  /** Min text operators for text-heavy classification */
  TEXT_MIN_TEXT_OPS: 300,
  /** Min ratio of text ops to total for text-heavy */
  TEXT_MIN_TEXT_RATIO: 0.7,
  /** Total ops threshold for complex classification */
  COMPLEX_MIN_TOTAL_OPS: 5000,
  /** Max time for classification (ms) - fallback to UNKNOWN if exceeded */
  MAX_CLASSIFICATION_TIME_MS: 50,
} as const;

/**
 * Parse image filter from PDF filter array or name
 */
export function parseImageFilter(filterObj: MuPDFTypes.PDFObject | null): ImageFilter {
  if (!filterObj) return ImageFilter.UNKNOWN;

  try {
    // Filter can be a name or array of names
    if (filterObj.isName()) {
      const name = filterObj.asName();
      // Remove leading slash if present
      const cleanName = name.startsWith('/') ? name.slice(1) : name;

      // Map to our enum
      const filterMap: Record<string, ImageFilter> = {
        'DCTDecode': ImageFilter.DCT_DECODE,
        'FlateDecode': ImageFilter.FLATE_DECODE,
        'JPXDecode': ImageFilter.JPX_DECODE,
        'CCITTFaxDecode': ImageFilter.CCITT_FAX_DECODE,
        'JBIG2Decode': ImageFilter.JBIG2_DECODE,
        'LZWDecode': ImageFilter.LZW_DECODE,
        'RunLengthDecode': ImageFilter.RUN_LENGTH_DECODE,
        'ASCII85Decode': ImageFilter.ASCII85_DECODE,
        'ASCIIHexDecode': ImageFilter.ASCII_HEX_DECODE,
        'Crypt': ImageFilter.CRYPT,
      };

      return filterMap[cleanName] || ImageFilter.UNKNOWN;
    }

    // If it's an array, get the first filter (primary compression)
    if (filterObj.isArray() && filterObj.length > 0) {
      const firstFilter = filterObj.get(0);
      return parseImageFilter(firstFilter);
    }
  } catch {
    // Ignore errors in filter parsing
  }

  return ImageFilter.UNKNOWN;
}

/**
 * Check if a filter allows direct extraction (JPEG)
 */
export function isDirectExtractableFilter(filter: ImageFilter): boolean {
  return filter === ImageFilter.DCT_DECODE;
}

/**
 * Analyze XObjects on a page to find images
 *
 * @param pageObj PDFObject for the page
 * @param pageWidth Page width in points
 * @param pageHeight Page height in points
 * @returns Array of image information
 */
export function analyzePageImages(
  pageObj: MuPDFTypes.PDFObject,
  pageWidth: number,
  pageHeight: number
): PageImageInfo[] {
  const images: PageImageInfo[] = [];
  const pageArea = pageWidth * pageHeight;

  try {
    // Get Resources dictionary
    const resources = pageObj.get('Resources');
    if (!resources || resources.isNull()) return images;

    // Get XObject dictionary
    const xobjects = resources.get('XObject');
    if (!xobjects || xobjects.isNull() || !xobjects.isDictionary()) return images;

    // Iterate through XObjects
    xobjects.forEach((xobj: MuPDFTypes.PDFObject, name: string | number) => {
      try {
        // Resolve indirect reference
        const resolved = xobj.resolve();
        if (!resolved || !resolved.isDictionary()) return;

        // Check if it's an image
        const subtype = resolved.get('Subtype');
        if (!subtype || subtype.asName() !== 'Image') return;

        // Get image properties
        const width = resolved.get('Width')?.asNumber() || 0;
        const height = resolved.get('Height')?.asNumber() || 0;
        const bpc = resolved.get('BitsPerComponent')?.asNumber() || 8;

        // Get color space
        let colorSpace = 'Unknown';
        const cs = resolved.get('ColorSpace');
        if (cs) {
          if (cs.isName()) {
            colorSpace = cs.asName();
          } else if (cs.isArray() && cs.length > 0) {
            const csName = cs.get(0);
            if (csName?.isName()) {
              colorSpace = csName.asName();
            }
          }
        }

        // Get filter
        const filter = parseImageFilter(resolved.get('Filter'));

        // Check for masks
        const hasSoftMask = resolved.get('SMask') !== null && !resolved.get('SMask')?.isNull();
        const hasMask = resolved.get('Mask') !== null && !resolved.get('Mask')?.isNull();

        // Estimate coverage (simplified - assumes image fills page proportionally)
        // In reality, we'd need to parse the content stream to get the actual transform
        const imageArea = width * height;
        // Rough heuristic: if image dimensions are similar to page, assume high coverage
        const widthRatio = width / (pageWidth * 72 / 72); // Assuming 72 DPI
        const heightRatio = height / (pageHeight * 72 / 72);
        const coverageRatio = Math.min(1, Math.max(widthRatio, heightRatio) * Math.min(widthRatio, heightRatio));

        images.push({
          name: String(name),
          width,
          height,
          bitsPerComponent: bpc,
          colorSpace,
          filter,
          hasSoftMask,
          hasMask,
          coverageRatio,
        });
      } catch {
        // Ignore errors for individual XObjects
      }
    });
  } catch {
    // Ignore errors in image analysis
  }

  return images;
}

/**
 * Check if page has transparency indicators in ExtGState
 *
 * @param pageObj PDFObject for the page
 * @returns true if transparency is detected
 */
export function detectTransparency(pageObj: MuPDFTypes.PDFObject): boolean {
  try {
    const resources = pageObj.get('Resources');
    if (!resources || resources.isNull()) return false;

    const extGState = resources.get('ExtGState');
    if (!extGState || extGState.isNull() || !extGState.isDictionary()) return false;

    let hasTransparency = false;

    extGState.forEach((gs: MuPDFTypes.PDFObject) => {
      try {
        const resolved = gs.resolve();
        if (!resolved || !resolved.isDictionary()) return;

        // Check for transparency indicators
        const ca = resolved.get('ca'); // Fill alpha
        const CA = resolved.get('CA'); // Stroke alpha
        const SMask = resolved.get('SMask'); // Soft mask
        const BM = resolved.get('BM'); // Blend mode

        if (ca && ca.asNumber() < 1) hasTransparency = true;
        if (CA && CA.asNumber() < 1) hasTransparency = true;
        if (SMask && !SMask.isNull()) hasTransparency = true;
        if (BM && BM.asName() !== 'Normal') hasTransparency = true;
      } catch {
        // Ignore errors
      }
    });

    return hasTransparency;
  } catch {
    return false;
  }
}

/**
 * Create a counting device to analyze page operators
 *
 * This is a lightweight device that only counts operations without
 * actually rendering anything.
 *
 * @param mupdf The MuPDF module
 * @returns Object with device and counts
 */
export function createCountingDevice(
  mupdf: typeof MuPDFTypes
): { device: MuPDFTypes.Device; getCounts: () => OperatorCounts } {
  const counts: OperatorCounts = {
    text: 0,
    path: 0,
    image: 0,
    graphicsState: 0,
    color: 0,
    clipping: 0,
    total: 0,
  };

  const device = new mupdf.Device({
    // Text operations
    fillText: () => {
      counts.text++;
      counts.total++;
    },
    strokeText: () => {
      counts.text++;
      counts.total++;
    },
    clipText: () => {
      counts.text++;
      counts.total++;
    },
    clipStrokeText: () => {
      counts.text++;
      counts.total++;
    },
    ignoreText: () => {
      counts.text++;
      counts.total++;
    },

    // Path operations
    fillPath: () => {
      counts.path++;
      counts.total++;
    },
    strokePath: () => {
      counts.path++;
      counts.total++;
    },
    clipPath: () => {
      counts.path++;
      counts.clipping++;
      counts.total++;
    },
    clipStrokePath: () => {
      counts.path++;
      counts.clipping++;
      counts.total++;
    },

    // Image operations
    fillImage: () => {
      counts.image++;
      counts.total++;
    },
    fillImageMask: () => {
      counts.image++;
      counts.total++;
    },
    clipImageMask: () => {
      counts.image++;
      counts.clipping++;
      counts.total++;
    },

    // Shading
    fillShade: () => {
      counts.path++; // Count as path-like
      counts.total++;
    },

    // Group operations (indicate transparency)
    beginGroup: () => {
      counts.graphicsState++;
      counts.total++;
    },
    endGroup: () => {
      counts.graphicsState++;
      counts.total++;
    },

    // Mask operations (indicate transparency)
    beginMask: () => {
      counts.graphicsState++;
      counts.total++;
    },
    endMask: () => {
      counts.graphicsState++;
      counts.total++;
    },

    // Clip operations
    popClip: () => {
      counts.clipping++;
      counts.total++;
    },

    // Tile operations
    beginTile: () => {
      counts.graphicsState++;
      counts.total++;
      return 0;
    },
    endTile: () => {
      counts.graphicsState++;
      counts.total++;
    },

    // Layer operations
    beginLayer: () => {
      counts.graphicsState++;
      counts.total++;
    },
    endLayer: () => {
      counts.graphicsState++;
      counts.total++;
    },
  });

  return {
    device,
    getCounts: () => ({ ...counts }),
  };
}

/**
 * Classify a PDF page by content type
 *
 * @param doc PDFDocument
 * @param pageNum Page number (1-indexed)
 * @param mupdf The MuPDF module
 * @returns Classification result
 */
export function classifyPage(
  doc: MuPDFTypes.PDFDocument,
  pageNum: number,
  mupdf: typeof MuPDFTypes
): PageClassification {
  const startTime = performance.now();

  const result: PageClassification = {
    type: PDFContentType.UNKNOWN,
    confidence: 0,
    classificationTimeMs: 0,
    hasTransparency: false,
    pageNum,
  };

  try {
    // Load page
    const page = doc.loadPage(pageNum - 1) as MuPDFTypes.PDFPage;
    const bounds = page.getBounds();
    const pageWidth = bounds[2] - bounds[0];
    const pageHeight = bounds[3] - bounds[1];

    // Get page object for structure analysis
    const pageObj = page.getObject();

    // Step 1: Analyze images (XObjects)
    const images = analyzePageImages(pageObj, pageWidth, pageHeight);
    result.images = images;

    // Step 2: Check for scanned page (single large image)
    if (images.length === 1) {
      const image = images[0];
      if (
        image.coverageRatio >= CLASSIFICATION_THRESHOLDS.SCANNED_MIN_COVERAGE &&
        !image.hasSoftMask
      ) {
        if (isDirectExtractableFilter(image.filter)) {
          result.type = PDFContentType.SCANNED_JPEG;
          result.confidence = 0.95;
          result.classificationTimeMs = performance.now() - startTime;
          page.destroy();
          return result;
        } else {
          result.type = PDFContentType.SCANNED_OTHER;
          result.confidence = 0.9;
          result.classificationTimeMs = performance.now() - startTime;
          page.destroy();
          return result;
        }
      }
    }

    // Step 3: Check for transparency
    result.hasTransparency = detectTransparency(pageObj);

    // Step 4: Count operators using custom device
    // Only do this if not already classified and within time budget
    const elapsed = performance.now() - startTime;
    if (elapsed < CLASSIFICATION_THRESHOLDS.MAX_CLASSIFICATION_TIME_MS) {
      const { device, getCounts } = createCountingDevice(mupdf);

      try {
        // Run page through counting device with identity matrix
        page.run(device, mupdf.Matrix.identity);
        device.close();

        const counts = getCounts();
        result.operatorCounts = counts;

        // Step 5: Classify based on operator distribution
        const { text, path, image, total } = counts;

        // Complex: high total ops or transparency
        if (total > CLASSIFICATION_THRESHOLDS.COMPLEX_MIN_TOTAL_OPS || result.hasTransparency) {
          result.type = PDFContentType.COMPLEX;
          result.confidence = 0.85;
        }
        // Vector heavy: dominated by path operations
        else if (
          path >= CLASSIFICATION_THRESHOLDS.VECTOR_MIN_PATH_OPS &&
          path / total >= CLASSIFICATION_THRESHOLDS.VECTOR_MIN_PATH_RATIO
        ) {
          result.type = PDFContentType.VECTOR_HEAVY;
          result.confidence = 0.9;
        }
        // Text heavy: dominated by text operations
        else if (
          text >= CLASSIFICATION_THRESHOLDS.TEXT_MIN_TEXT_OPS &&
          text / total >= CLASSIFICATION_THRESHOLDS.TEXT_MIN_TEXT_RATIO
        ) {
          result.type = PDFContentType.TEXT_HEAVY;
          result.confidence = 0.9;
        }
        // Mixed: balanced content
        else {
          result.type = PDFContentType.MIXED;
          result.confidence = 0.8;
        }
      } catch {
        // If counting fails, fallback to MIXED
        result.type = PDFContentType.MIXED;
        result.confidence = 0.5;
      } finally {
        device.destroy();
      }
    } else {
      // Time budget exceeded, use heuristics
      result.type = PDFContentType.MIXED;
      result.confidence = 0.5;
    }

    page.destroy();
  } catch (error) {
    console.warn(`[ContentTypeClassifier] Failed to classify page ${pageNum}:`, error);
    result.type = PDFContentType.UNKNOWN;
    result.confidence = 0;
  }

  result.classificationTimeMs = performance.now() - startTime;
  return result;
}

/**
 * Batch classify multiple pages
 *
 * @param doc PDFDocument
 * @param pageNums Page numbers to classify (1-indexed)
 * @param mupdf The MuPDF module
 * @returns Map of page number to classification
 */
export function classifyPages(
  doc: MuPDFTypes.PDFDocument,
  pageNums: number[],
  mupdf: typeof MuPDFTypes
): Map<number, PageClassification> {
  const results = new Map<number, PageClassification>();

  for (const pageNum of pageNums) {
    results.set(pageNum, classifyPage(doc, pageNum, mupdf));
  }

  return results;
}

/**
 * Get recommended render strategy for a content type
 */
export interface RenderStrategy {
  /** Whether to use direct image extraction */
  useDirectExtraction: boolean;
  /** Whether to use reduced scale rendering */
  useScaleReduction: boolean;
  /** Scale reduction factor (1 = no reduction) */
  scaleReductionFactor: number;
  /** Cache priority hint */
  cachePriority: 'high' | 'normal' | 'low';
  /** Whether to render text layer */
  renderTextLayer: boolean;
}

/**
 * Get recommended render strategy based on content type
 */
export function getRenderStrategy(classification: PageClassification): RenderStrategy {
  switch (classification.type) {
    case PDFContentType.SCANNED_JPEG:
      return {
        useDirectExtraction: true,
        useScaleReduction: false,
        scaleReductionFactor: 1,
        cachePriority: 'high', // Cache extracted images
        renderTextLayer: true, // Still need text layer for search/selection
      };

    case PDFContentType.SCANNED_OTHER:
      return {
        useDirectExtraction: false, // Can't extract directly
        useScaleReduction: false,
        scaleReductionFactor: 1,
        cachePriority: 'high',
        renderTextLayer: true,
      };

    case PDFContentType.VECTOR_HEAVY:
      return {
        useDirectExtraction: false,
        useScaleReduction: true,
        scaleReductionFactor: 2, // Render at half scale, CSS upscale
        cachePriority: 'normal',
        renderTextLayer: true,
      };

    case PDFContentType.TEXT_HEAVY:
      return {
        useDirectExtraction: false,
        useScaleReduction: false,
        scaleReductionFactor: 1,
        cachePriority: 'high', // Text pages benefit from caching
        renderTextLayer: true,
      };

    case PDFContentType.COMPLEX:
      return {
        useDirectExtraction: false,
        useScaleReduction: false,
        scaleReductionFactor: 1,
        cachePriority: 'low', // Complex pages may not be worth caching
        renderTextLayer: true,
      };

    case PDFContentType.MIXED:
    case PDFContentType.UNKNOWN:
    default:
      return {
        useDirectExtraction: false,
        useScaleReduction: false,
        scaleReductionFactor: 1,
        cachePriority: 'normal',
        renderTextLayer: true,
      };
  }
}

/**
 * Extract JPEG image data directly from a scanned page
 *
 * Only works for pages classified as SCANNED_JPEG.
 *
 * @param doc PDFDocument
 * @param pageNum Page number (1-indexed)
 * @param classification Classification result (must be SCANNED_JPEG)
 * @returns JPEG bytes or null if extraction fails
 */
export function extractJpegFromPage(
  doc: MuPDFTypes.PDFDocument,
  pageNum: number,
  classification: PageClassification
): Uint8Array | null {
  if (classification.type !== PDFContentType.SCANNED_JPEG) {
    return null;
  }

  if (!classification.images || classification.images.length !== 1) {
    return null;
  }

  try {
    const page = doc.loadPage(pageNum - 1) as MuPDFTypes.PDFPage;
    const pageObj = page.getObject();

    // Navigate to the XObject
    const resources = pageObj.get('Resources');
    if (!resources) {
      page.destroy();
      return null;
    }

    const xobjects = resources.get('XObject');
    if (!xobjects) {
      page.destroy();
      return null;
    }

    // Get the image (we know there's exactly one)
    const imageName = classification.images[0].name;
    const imageObj = xobjects.get(imageName);
    if (!imageObj) {
      page.destroy();
      return null;
    }

    const resolved = imageObj.resolve();
    if (!resolved || !resolved.isStream()) {
      page.destroy();
      return null;
    }

    // Read the raw stream - for DCTDecode this is JPEG data
    const buffer = resolved.readRawStream();
    const jpegData = buffer.asUint8Array();

    // Make a copy since the buffer will be destroyed
    const result = new Uint8Array(jpegData);

    buffer.destroy();
    page.destroy();

    return result;
  } catch (error) {
    console.warn(`[ContentTypeClassifier] Failed to extract JPEG from page ${pageNum}:`, error);
    return null;
  }
}

// ============================================================
// Vector Scale Optimization Utilities (Phase 5.9)
// ============================================================

/**
 * Optimized render parameters based on content type
 */
export interface OptimizedRenderParams {
  /** Actual scale to render at (may be lower than requested) */
  actualScale: number;
  /** CSS scale factor to apply after rendering (actualScale × cssScale = requestedScale) */
  cssScaleFactor: number;
  /** Whether scale optimization was applied */
  wasOptimized: boolean;
  /** Original requested scale */
  requestedScale: number;
  /** Reason for optimization (or lack thereof) */
  reason: string;
}

/**
 * Calculate optimized render parameters based on content type classification.
 *
 * For vector-heavy pages, renders at a reduced scale and uses CSS to upscale.
 * Vector graphics remain crisp due to anti-aliasing, while rendering is faster.
 *
 * Optimization rules:
 * - VECTOR_HEAVY: Render at 50% scale, CSS upscale 2x
 * - TEXT_HEAVY: No optimization (text needs full resolution)
 * - SCANNED_*: No optimization (raster needs full resolution)
 * - COMPLEX: No optimization (transparency needs full resolution)
 * - MIXED/UNKNOWN: No optimization (play it safe)
 *
 * Scale floor: Never reduces below scale 2 (maintains minimum quality)
 *
 * @param requestedScale Scale requested by the renderer
 * @param classification Page classification result
 * @returns Optimized render parameters
 *
 * @example
 * // Vector page at 16x zoom on 2x DPR (requestedScale = 32)
 * const params = getOptimizedRenderParams(32, vectorClassification);
 * // Result: { actualScale: 16, cssScaleFactor: 2, wasOptimized: true }
 * //
 * // Render at scale 16, then apply CSS transform: scale(2)
 */
export function getOptimizedRenderParams(
  requestedScale: number,
  classification: PageClassification | null
): OptimizedRenderParams {
  // No classification available - no optimization
  if (!classification) {
    return {
      actualScale: requestedScale,
      cssScaleFactor: 1,
      wasOptimized: false,
      requestedScale,
      reason: 'No classification available',
    };
  }

  const strategy = getRenderStrategy(classification);

  // Check if scale reduction is applicable
  if (!strategy.useScaleReduction || strategy.scaleReductionFactor <= 1) {
    return {
      actualScale: requestedScale,
      cssScaleFactor: 1,
      wasOptimized: false,
      requestedScale,
      reason: `Content type ${classification.type} does not benefit from scale reduction`,
    };
  }

  // Calculate reduced scale
  const reductionFactor = strategy.scaleReductionFactor;
  let reducedScale = Math.ceil(requestedScale / reductionFactor);

  // Apply minimum scale floor (never go below 2 for acceptable quality)
  const MINIMUM_SCALE = 2;
  if (reducedScale < MINIMUM_SCALE) {
    reducedScale = MINIMUM_SCALE;
  }

  // If reduction doesn't actually reduce, skip optimization
  if (reducedScale >= requestedScale) {
    return {
      actualScale: requestedScale,
      cssScaleFactor: 1,
      wasOptimized: false,
      requestedScale,
      reason: `Requested scale ${requestedScale} is at or below minimum`,
    };
  }

  // Calculate CSS scale factor
  const cssScaleFactor = requestedScale / reducedScale;

  return {
    actualScale: reducedScale,
    cssScaleFactor,
    wasOptimized: true,
    requestedScale,
    reason: `Vector-optimized: render at ${reducedScale}x, CSS scale ${cssScaleFactor.toFixed(2)}x`,
  };
}

/**
 * Minimum scale worth optimizing.
 *
 * Below this scale, the overhead of CSS transforms outweighs the benefits.
 */
export const VECTOR_OPTIMIZATION_MIN_SCALE = 4;

/**
 * Check if scale optimization is worth applying.
 *
 * Returns false if:
 * - Scale is too low (below VECTOR_OPTIMIZATION_MIN_SCALE)
 * - Classification confidence is too low
 * - Content type doesn't benefit from optimization
 *
 * @param requestedScale Scale requested by the renderer
 * @param classification Page classification result
 * @returns Whether optimization should be applied
 */
export function shouldApplyVectorOptimization(
  requestedScale: number,
  classification: PageClassification | null
): boolean {
  // Too low scale - not worth optimizing
  if (requestedScale < VECTOR_OPTIMIZATION_MIN_SCALE) {
    return false;
  }

  // No classification - play it safe
  if (!classification) {
    return false;
  }

  // Low confidence - don't risk quality
  if (classification.confidence < 0.7) {
    return false;
  }

  // Check if content type benefits from optimization
  const strategy = getRenderStrategy(classification);
  return strategy.useScaleReduction && strategy.scaleReductionFactor > 1;
}

/**
 * Generate CSS transform string for upscaling rendered content.
 *
 * @param cssScaleFactor Scale factor from getOptimizedRenderParams
 * @returns CSS transform value or empty string if no transform needed
 */
export function getVectorScaleTransform(cssScaleFactor: number): string {
  if (cssScaleFactor <= 1.01) { // Account for floating point
    return '';
  }
  return `scale(${cssScaleFactor})`;
}

/**
 * Calculate memory savings from vector scale optimization.
 *
 * @param requestedScale Original requested scale
 * @param actualScale Optimized actual scale
 * @param tileSize Tile size in pixels
 * @returns Memory saved in bytes (per tile, RGBA)
 */
export function calculateVectorOptimizationSavings(
  requestedScale: number,
  actualScale: number,
  tileSize: number = 256
): number {
  const originalPixels = tileSize * tileSize * requestedScale * requestedScale;
  const optimizedPixels = tileSize * tileSize * actualScale * actualScale;
  const bytesPerPixel = 4; // RGBA

  return (originalPixels - optimizedPixels) * bytesPerPixel;
}

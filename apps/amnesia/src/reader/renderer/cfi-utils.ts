/**
 * CFI Utilities (Simplified)
 *
 * Provides basic EPUB CFI (Canonical Fragment Identifier) handling.
 * Full CFI generation/resolution has been replaced with TextQuote-based anchoring
 * which is more reliable across EPUB implementations.
 *
 * A spine-only CFI has the format:
 *   epubcfi(/6/{spinePosition}!/4/1:0)
 *
 * Where:
 * - /6 is the package document root
 * - /{spinePosition} is the even-numbered spine position (spine index * 2 + 2)
 * - ! marks the document boundary
 * - /4/1:0 is a minimal placeholder (actual position determined via TextQuote)
 *
 * @see https://www.w3.org/TR/epub-33/#sec-epubcfi
 */

/**
 * Result of CFI resolution
 */
export interface CfiResolution {
  node: Node;
  offset: number;
}

/**
 * Generate a spine-only EPUB CFI for a position in a chapter.
 *
 * Note: This returns a minimal CFI with spine position only.
 * Actual position anchoring is handled by TextQuote selectors which
 * are more reliable across different EPUB implementations.
 *
 * @param spineIndex - The 0-based spine index of the chapter
 * @param _node - Unused (kept for API compatibility)
 * @param _offset - Unused (kept for API compatibility)
 * @returns A spine-only CFI string like epubcfi(/6/4!/4/1:0)
 */
export function generateFullCfi(
  spineIndex: number,
  _node?: Node,
  _offset: number = 0
): string {
  // Spine position uses EPUB CFI even-numbering: (index + 1) * 2
  const spinePosition = (spineIndex + 1) * 2;

  // Return minimal CFI with spine position only
  // Actual position anchoring uses TextQuote selectors
  return `epubcfi(/6/${spinePosition}!/4/1:0)`;
}

/**
 * Parse the spine index from a CFI string
 *
 * @param cfi - The CFI string to parse
 * @returns The 0-based spine index, or null if parsing fails
 */
export function getSpineIndexFromCfi(cfi: string): number | null {
  try {
    // Match /6/{number} at the start of the CFI
    const match = cfi.match(/epubcfi\(\/6\/(\d+)/);
    if (!match) return null;

    // Convert back from CFI position to 0-based index
    const spinePosition = parseInt(match[1], 10);
    return (spinePosition / 2) - 1;
  } catch {
    return null;
  }
}

/**
 * Resolve a CFI to a DOM position within a document.
 *
 * Note: This always returns null to trigger TextQuote fallback.
 * TextQuote-based anchoring is more reliable across EPUB implementations
 * and handles DOM structure differences better than CFI resolution.
 *
 * @param _doc - The document (unused)
 * @param _cfi - The CFI string (unused)
 * @returns Always returns null to trigger TextQuote fallback
 */
export async function resolveCfi(
  _doc: Document,
  _cfi: string
): Promise<CfiResolution | null> {
  // Return null to trigger TextQuote fallback chain
  // TextQuote selectors are stored alongside CFI and provide
  // more reliable re-anchoring across EPUB implementations
  return null;
}

/**
 * Create a CFI from the first visible text node in a document.
 *
 * Note: Returns a spine-only CFI. The actual position is stored
 * in a TextQuote selector for reliable re-anchoring.
 *
 * @param _doc - The document (unused)
 * @param spineIndex - The spine index of the chapter
 * @param _viewportRect - The visible viewport (unused)
 * @returns A spine-only CFI string
 */
export function generateCfiFromVisibleText(
  _doc: Document,
  spineIndex: number,
  _viewportRect: { left: number; top: number; width: number; height: number }
): string | null {
  // Return spine-only CFI - actual position tracked via TextQuote
  return generateFullCfi(spineIndex);
}

/**
 * Validate a CFI string format (basic check only)
 *
 * @param cfi - The CFI string to validate
 * @returns true if the CFI has valid format
 */
export function isValidCfi(cfi: string): boolean {
  if (!cfi || typeof cfi !== 'string') return false;

  // Basic format check - starts with epubcfi( and ends with )
  if (!cfi.startsWith('epubcfi(') || !cfi.endsWith(')')) {
    return false;
  }

  // Check for spine position marker
  return /\/6\/\d+/.test(cfi);
}

/**
 * Compare two CFI strings to determine their order.
 *
 * Note: Only compares spine positions since intra-document
 * CFI paths are no longer generated.
 *
 * @param a - First CFI string
 * @param b - Second CFI string
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function compareCfi(a: string, b: string): number {
  const spineA = getSpineIndexFromCfi(a);
  const spineB = getSpineIndexFromCfi(b);

  if (spineA === null || spineB === null) {
    return 0;
  }

  return spineA - spineB;
}

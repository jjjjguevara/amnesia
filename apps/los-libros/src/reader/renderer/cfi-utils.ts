/**
 * CFI Utilities
 *
 * Provides proper EPUB CFI (Canonical Fragment Identifier) generation and resolution.
 * Uses epub-cfi-resolver for the heavy lifting.
 *
 * A full CFI has the format:
 *   epubcfi(/6/{spinePosition}!{documentPath}:{characterOffset})
 *
 * Where:
 * - /6 is the package document root
 * - /{spinePosition} is the even-numbered spine position (spine index * 2 + 2)
 * - ! marks the document boundary
 * - {documentPath} is the path within the XHTML document
 * - :{characterOffset} is the character offset within a text node
 *
 * @see https://www.w3.org/TR/epub-33/#sec-epubcfi
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const CFI = require('epub-cfi-resolver');

/**
 * Result of CFI resolution
 */
export interface CfiResolution {
  node: Node;
  offset: number;
}

/**
 * Generate a full EPUB CFI for a position in a chapter
 *
 * @param spineIndex - The 0-based spine index of the chapter
 * @param node - The DOM node (typically a text node) for the position
 * @param offset - The character offset within the node
 * @returns A complete CFI string like epubcfi(/6/4!/4/2/1:42)
 */
export function generateFullCfi(
  spineIndex: number,
  node: Node,
  offset: number = 0
): string {
  // Spine position uses EPUB CFI even-numbering: (index + 1) * 2
  const spinePosition = (spineIndex + 1) * 2;

  // Generate the intra-document path using epub-cfi-resolver
  // CFI.generate returns epubcfi(...), so we need to extract the inner path
  const intraDocCfi = CFI.generate(node, offset) as string;

  // Extract the path from epubcfi(...)
  const innerPath = intraDocCfi.replace(/^epubcfi\(/, '').replace(/\)$/, '');

  // Combine with spine position
  // Format: epubcfi(/6/{spinePosition}!{innerPath})
  return `epubcfi(/6/${spinePosition}!${innerPath})`;
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
 * Resolve a CFI to a DOM position within a document
 *
 * @param doc - The document to resolve the CFI in
 * @param cfi - The CFI string to resolve
 * @returns The resolved node and offset, or null if resolution fails
 */
export async function resolveCfi(
  doc: Document,
  cfi: string
): Promise<CfiResolution | null> {
  try {
    // Parse the CFI
    const parsed = new CFI(cfi);

    // Resolve in the document
    // epub-cfi-resolver's resolve method handles the intra-document part
    const result = await parsed.resolveLast(doc);

    if (!result || !result.node) {
      return null;
    }

    return {
      node: result.node,
      offset: result.offset || 0,
    };
  } catch (error) {
    console.error('[CFI] Resolution failed:', error);
    return null;
  }
}

/**
 * Create a CFI from the first visible text node in a document
 *
 * @param doc - The document to search
 * @param spineIndex - The spine index of the chapter
 * @param viewportRect - The visible viewport rectangle
 * @returns A CFI string, or null if no visible text found
 */
export function generateCfiFromVisibleText(
  doc: Document,
  spineIndex: number,
  viewportRect: { left: number; top: number; width: number; height: number }
): string | null {
  // Walk through text nodes to find the first visible one
  const walker = doc.createTreeWalker(
    doc.body || doc.documentElement,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        // Skip empty text nodes
        if (!node.textContent || node.textContent.trim().length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const range = doc.createRange();
    range.selectNodeContents(node);

    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      // Check if this rect is within the viewport
      if (
        rect.left >= viewportRect.left &&
        rect.left < viewportRect.left + viewportRect.width &&
        rect.top >= viewportRect.top &&
        rect.top < viewportRect.top + viewportRect.height
      ) {
        // Found a visible text node - generate CFI
        // Calculate approximate character offset based on position
        const textNode = node as Text;
        const charOffset = estimateCharacterOffset(
          textNode,
          viewportRect.left,
          doc
        );

        return generateFullCfi(spineIndex, textNode, charOffset);
      }
    }
  }

  return null;
}

/**
 * Estimate the character offset at a given x position within a text node
 */
function estimateCharacterOffset(
  textNode: Text,
  targetX: number,
  doc: Document
): number {
  const text = textNode.textContent || '';
  if (text.length === 0) return 0;

  const range = doc.createRange();

  // Binary search for the character at targetX
  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    range.setStart(textNode, 0);
    range.setEnd(textNode, mid);

    const rect = range.getBoundingClientRect();
    if (rect.right < targetX) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

/**
 * Validate a CFI string format
 */
export function isValidCfi(cfi: string): boolean {
  if (!cfi || typeof cfi !== 'string') return false;

  try {
    // Basic format check
    if (!cfi.startsWith('epubcfi(') || !cfi.endsWith(')')) {
      return false;
    }

    // Try to parse it
    new CFI(cfi);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare two CFI strings to determine their order
 *
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function compareCfi(a: string, b: string): number {
  try {
    // First compare spine positions
    const spineA = getSpineIndexFromCfi(a);
    const spineB = getSpineIndexFromCfi(b);

    if (spineA !== null && spineB !== null && spineA !== spineB) {
      return spineA - spineB;
    }

    // Same spine, use epub-cfi-resolver's comparison
    return CFI.compare(a, b);
  } catch {
    return 0;
  }
}

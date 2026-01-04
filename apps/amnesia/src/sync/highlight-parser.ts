/**
 * Highlight Parser
 *
 * Parses highlights and notes from vault markdown files.
 * Supports both inline format (with markers) and atomic note format.
 *
 * Markers:
 * - Inline ID: `%% amnesia:hl-abc123 %%`
 * - Deleted/Tombstone: `%% amnesia:hl-abc123:deleted %%`
 * - Section markers: `<!-- AMNESIA:HIGHLIGHTS:START -->` / `<!-- AMNESIA:HIGHLIGHTS:END -->`
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed highlight from vault content
 */
export interface ParsedHighlight {
  /** Highlight ID (from marker) */
  id: string;
  /** Highlight text content */
  text: string;
  /** User annotation/note */
  annotation?: string;
  /** Highlight color */
  color?: string;
  /** Whether the highlight is tombstoned (deleted) */
  deleted: boolean;
  /** Source (inline in book note or atomic file) */
  source: 'inline' | 'atomic';
  /** Line number in file (for inline) */
  lineNumber?: number;
  /** Updated timestamp from frontmatter */
  updatedAt?: Date;
  /** Any frontmatter fields */
  frontmatter?: Record<string, unknown>;
}

/**
 * Parsed note/annotation from vault content
 */
export interface ParsedNote {
  /** Note ID */
  id: string;
  /** Note content */
  content: string;
  /** Whether the note is deleted */
  deleted: boolean;
  /** Source format */
  source: 'inline' | 'atomic';
  /** Line number in file */
  lineNumber?: number;
  /** Linked highlight ID (if any) */
  linkedHighlightId?: string;
  /** Frontmatter fields */
  frontmatter?: Record<string, unknown>;
}

/**
 * Parser options
 */
export interface ParserOptions {
  /** Section ID for highlights (default: HIGHLIGHTS) */
  highlightsSectionId?: string;
  /** Section ID for notes (default: NOTES) */
  notesSectionId?: string;
}

/**
 * Default parser options
 */
const DEFAULT_PARSER_OPTIONS: Required<ParserOptions> = {
  highlightsSectionId: 'HIGHLIGHTS',
  notesSectionId: 'NOTES',
};

// ============================================================================
// Regex Patterns
// ============================================================================

/**
 * Match inline highlight ID marker
 * Example: `%% amnesia:hl-abc123 %%` or `%% amnesia:hl-abc123:deleted %%`
 */
const HIGHLIGHT_ID_PATTERN = /%%\s*amnesia:(hl-[\w-]+)(?::deleted)?\s*%%/g;

/**
 * Match deleted/tombstone marker
 */
const TOMBSTONE_PATTERN = /%%\s*amnesia:(hl-[\w-]+):deleted\s*%%/;

/**
 * Match note ID marker
 */
const NOTE_ID_PATTERN = /%%\s*amnesia:(note-[\w-]+)(?::deleted)?\s*%%/g;

/**
 * Match blockquote highlight (common format)
 * Example: `> This is a highlight text %% amnesia:hl-abc123 %%`
 */
const BLOCKQUOTE_HIGHLIGHT_PATTERN = /^>\s*(.+?)\s*%%\s*amnesia:(hl-[\w-]+)(?::deleted)?\s*%%/gm;

/**
 * Match section markers
 */
const SECTION_START_PATTERN = (id: string) =>
  new RegExp(`<!--\\s*AMNESIA:${id}:START\\s*-->`, 'i');
const SECTION_END_PATTERN = (id: string) =>
  new RegExp(`<!--\\s*AMNESIA:${id}:END\\s*-->`, 'i');

/**
 * YAML frontmatter pattern
 */
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---/;

// ============================================================================
// Highlight Parser
// ============================================================================

/**
 * Parses highlights and notes from vault markdown content
 */
export class HighlightParser {
  private options: Required<ParserOptions>;

  constructor(options?: ParserOptions) {
    this.options = { ...DEFAULT_PARSER_OPTIONS, ...options };
  }

  /**
   * Update parser options
   */
  setOptions(options: Partial<ParserOptions>): void {
    this.options = { ...this.options, ...options };
  }

  // ==========================================================================
  // Content Parsing
  // ==========================================================================

  /**
   * Parse highlights from file content
   */
  parseHighlightsFromContent(content: string): ParsedHighlight[] {
    const highlights: ParsedHighlight[] = [];

    // First, check if this is an atomic note
    // Supports multiple formats:
    // - amnesia_highlight_id (legacy)
    // - highlightId (current template format)
    // - type: highlight with bookId (alternative format)
    const frontmatter = this.parseFrontmatter(content);
    const highlightId = frontmatter?.amnesia_highlight_id || frontmatter?.highlightId;
    const isHighlightType = frontmatter?.type === 'highlight' || frontmatter?.type === 'atomic-highlight';

    if (highlightId || (isHighlightType && frontmatter?.bookId)) {
      const atomicHighlight = this.parseAtomicHighlight(content, frontmatter!);
      if (atomicHighlight) {
        highlights.push(atomicHighlight);
      }
      return highlights;
    }

    // Check for section-based highlights
    const sectionContent = this.extractSection(
      content,
      this.options.highlightsSectionId
    );

    if (sectionContent) {
      // Parse highlights from managed section
      highlights.push(...this.parseInlineHighlights(sectionContent, 'inline'));
    } else {
      // Scan entire content for highlight markers
      highlights.push(...this.parseInlineHighlights(content, 'inline'));
    }

    return highlights;
  }

  /**
   * Parse notes from file content
   */
  parseNotesFromContent(content: string): ParsedNote[] {
    const notes: ParsedNote[] = [];

    // First, check if this is an atomic note file
    const frontmatter = this.parseFrontmatter(content);
    if (frontmatter?.amnesia_note_id) {
      const atomicNote = this.parseAtomicNote(content, frontmatter);
      if (atomicNote) {
        notes.push(atomicNote);
      }
      return notes;
    }

    // Check for section-based notes
    const sectionContent = this.extractSection(
      content,
      this.options.notesSectionId
    );

    if (sectionContent) {
      notes.push(...this.parseInlineNotes(sectionContent));
    }

    return notes;
  }

  // ==========================================================================
  // Inline Parsing
  // ==========================================================================

  /**
   * Parse inline highlights from content
   */
  private parseInlineHighlights(
    content: string,
    source: 'inline' | 'atomic'
  ): ParsedHighlight[] {
    const highlights: ParsedHighlight[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for blockquote format: `> text %% amnesia:id %%`
      const blockquoteMatch = line.match(
        /^>\s*(.+?)\s*%%\s*amnesia:(hl-[\w-]+)(?::deleted)?\s*%%/
      );

      if (blockquoteMatch) {
        const [, text, id] = blockquoteMatch;
        const isDeleted = TOMBSTONE_PATTERN.test(line);

        // Look for annotation on next line (if it's a continuation)
        let annotation: string | undefined;
        if (i + 1 < lines.length && lines[i + 1].startsWith('>')) {
          const nextLine = lines[i + 1].replace(/^>\s*/, '');
          if (!nextLine.includes('amnesia:')) {
            annotation = nextLine;
          }
        }

        highlights.push({
          id,
          text: this.cleanHighlightText(text),
          annotation,
          deleted: isDeleted,
          source,
          lineNumber: i + 1,
        });
        continue;
      }

      // Check for plain ID marker anywhere in line
      const idMatch = line.match(/%%\s*amnesia:(hl-[\w-]+)(?::deleted)?\s*%%/);
      if (idMatch) {
        const [fullMatch, id] = idMatch;
        const isDeleted = TOMBSTONE_PATTERN.test(line);
        const text = line.replace(fullMatch, '').trim();

        // Clean up markdown formatting
        const cleanText = this.cleanHighlightText(text);

        if (cleanText) {
          highlights.push({
            id,
            text: cleanText,
            deleted: isDeleted,
            source,
            lineNumber: i + 1,
          });
        }
      }
    }

    return highlights;
  }

  /**
   * Parse inline notes from content
   */
  private parseInlineNotes(content: string): ParsedNote[] {
    const notes: ParsedNote[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const idMatch = line.match(/%%\s*amnesia:(note-[\w-]+)(?::deleted)?\s*%%/);
      if (idMatch) {
        const [fullMatch, id] = idMatch;
        const isDeleted = line.includes(':deleted');
        const noteContent = line.replace(fullMatch, '').trim();

        if (noteContent) {
          notes.push({
            id,
            content: noteContent,
            deleted: isDeleted,
            source: 'inline',
            lineNumber: i + 1,
          });
        }
      }
    }

    return notes;
  }

  // ==========================================================================
  // Atomic Note Parsing
  // ==========================================================================

  /**
   * Parse atomic highlight from file
   * Supports multiple frontmatter formats:
   * - amnesia_highlight_id (legacy)
   * - highlightId (current template format)
   * - type: highlight with bookId (generated by unified-note-generator)
   */
  private parseAtomicHighlight(
    content: string,
    frontmatter: Record<string, unknown>
  ): ParsedHighlight | null {
    // Get ID from various possible field names
    let id = (frontmatter.amnesia_highlight_id || frontmatter.highlightId) as string;

    // If no explicit ID, generate one from bookId + cfi for type: highlight notes
    if (!id && frontmatter.type === 'highlight' && frontmatter.bookId) {
      // Clean bookId (remove quotes if present)
      const bookId = this.cleanYamlString(frontmatter.bookId as string);
      const cfi = this.cleanYamlString(frontmatter.cfi as string);

      if (cfi) {
        // Create a simple hash-based ID from CFI
        id = `hl-${bookId.slice(0, 8)}-${this.simpleHash(cfi)}`;
      } else {
        // Fallback: extract text and use it for hash
        const body = content.replace(FRONTMATTER_PATTERN, '').trim();
        const text = (frontmatter.text as string) || this.extractQuoteFromBody(body);
        if (text) {
          id = `hl-${bookId.slice(0, 8)}-${this.simpleHash(text)}`;
        }
      }
    }

    if (!id) return null;

    // Extract body content (after frontmatter)
    const body = content.replace(FRONTMATTER_PATTERN, '').trim();

    // Look for text in frontmatter or body (supports blockquote format)
    const text = (frontmatter.text as string) || this.extractQuoteFromBody(body);

    if (!text) return null;

    return {
      id,
      text,
      annotation: (frontmatter.annotation || frontmatter.note) as string | undefined,
      color: frontmatter.color as string | undefined,
      deleted: (frontmatter.deleted as boolean) ?? false,
      source: 'atomic',
      updatedAt: frontmatter.updatedAt
        ? new Date(frontmatter.updatedAt as string)
        : frontmatter.created
          ? new Date(frontmatter.created as string)
          : undefined,
      frontmatter,
    };
  }

  /**
   * Simple hash function for generating IDs
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).slice(0, 8);
  }

  /**
   * Clean a YAML string value by removing surrounding quotes
   */
  private cleanYamlString(value: string | undefined | null): string {
    if (!value) return '';
    let cleaned = String(value).trim();
    // Remove surrounding quotes (single or double)
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))
    ) {
      cleaned = cleaned.slice(1, -1);
    }
    return cleaned;
  }

  /**
   * Parse atomic note from file
   */
  private parseAtomicNote(
    content: string,
    frontmatter: Record<string, unknown>
  ): ParsedNote | null {
    const id = frontmatter.amnesia_note_id as string;
    if (!id) return null;

    const body = content.replace(FRONTMATTER_PATTERN, '').trim();

    return {
      id,
      content: (frontmatter.content as string) || body,
      deleted: (frontmatter.deleted as boolean) ?? false,
      source: 'atomic',
      linkedHighlightId: frontmatter.linkedHighlightId as string | undefined,
      frontmatter,
    };
  }

  // ==========================================================================
  // Section Extraction
  // ==========================================================================

  /**
   * Extract content between section markers
   */
  extractSection(content: string, sectionId: string): string | null {
    const startPattern = SECTION_START_PATTERN(sectionId);
    const endPattern = SECTION_END_PATTERN(sectionId);

    const startMatch = content.match(startPattern);
    if (!startMatch) return null;

    const startIndex = startMatch.index! + startMatch[0].length;
    const endMatch = content.slice(startIndex).match(endPattern);

    if (!endMatch) {
      // No end marker - return content from start to end of file
      return content.slice(startIndex).trim();
    }

    return content.slice(startIndex, startIndex + endMatch.index!).trim();
  }

  /**
   * Check if content has a specific section
   */
  hasSection(content: string, sectionId: string): boolean {
    return SECTION_START_PATTERN(sectionId).test(content);
  }

  // ==========================================================================
  // Frontmatter Parsing
  // ==========================================================================

  /**
   * Parse YAML frontmatter from content
   */
  parseFrontmatter(content: string): Record<string, unknown> | null {
    const match = content.match(FRONTMATTER_PATTERN);
    if (!match) return null;

    try {
      const yaml = match[1];
      return this.parseSimpleYaml(yaml);
    } catch {
      return null;
    }
  }

  /**
   * Simple YAML parser for frontmatter
   * Note: For complex YAML, use a proper library like js-yaml
   */
  private parseSimpleYaml(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = yaml.split('\n');

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.slice(0, colonIndex).trim();
      let value: unknown = line.slice(colonIndex + 1).trim();

      // Parse value types
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (value === 'null' || value === '') value = null;
      else if (!isNaN(Number(value))) value = Number(value);
      else if (typeof value === 'string' && (value.startsWith('"') || value.startsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (key) {
        result[key] = value;
      }
    }

    return result;
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Clean highlight text from markdown formatting
   */
  private cleanHighlightText(text: string): string {
    return (
      text
        // Remove blockquote prefix
        .replace(/^>\s*/, '')
        // Remove strikethrough
        .replace(/~~(.+?)~~/g, '$1')
        // Remove bold
        .replace(/\*\*(.+?)\*\*/g, '$1')
        // Remove italic
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/_(.+?)_/g, '$1')
        // Remove inline code
        .replace(/`(.+?)`/g, '$1')
        // Clean up whitespace
        .trim()
    );
  }

  /**
   * Extract quoted text from body content
   */
  private extractQuoteFromBody(body: string): string | null {
    // Look for blockquote
    const quoteMatch = body.match(/^>\s*(.+?)$/m);
    if (quoteMatch) {
      return this.cleanHighlightText(quoteMatch[1]);
    }

    // Return first non-empty line
    const firstLine = body.split('\n').find((line) => line.trim());
    return firstLine ? firstLine.trim() : null;
  }

  // ==========================================================================
  // ID Extraction
  // ==========================================================================

  /**
   * Extract all highlight IDs from content
   */
  extractHighlightIds(content: string): string[] {
    const ids: string[] = [];
    let match: RegExpExecArray | null;

    const pattern = new RegExp(HIGHLIGHT_ID_PATTERN);
    while ((match = pattern.exec(content)) !== null) {
      ids.push(match[1]);
    }

    return [...new Set(ids)];
  }

  /**
   * Extract all note IDs from content
   */
  extractNoteIds(content: string): string[] {
    const ids: string[] = [];
    let match: RegExpExecArray | null;

    const pattern = new RegExp(NOTE_ID_PATTERN);
    while ((match = pattern.exec(content)) !== null) {
      ids.push(match[1]);
    }

    return [...new Set(ids)];
  }

  /**
   * Check if content contains a specific highlight ID
   */
  containsHighlightId(content: string, id: string): boolean {
    return content.includes(`amnesia:${id}`);
  }

  /**
   * Check if a highlight is tombstoned in content
   */
  isHighlightTombstoned(content: string, id: string): boolean {
    return content.includes(`amnesia:${id}:deleted`);
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a highlight parser instance
 */
export function createHighlightParser(options?: ParserOptions): HighlightParser {
  return new HighlightParser(options);
}

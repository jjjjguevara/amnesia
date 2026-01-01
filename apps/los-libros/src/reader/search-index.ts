/**
 * Search Index for EPUB books
 *
 * Builds a searchable index from book content when opened.
 * Provides fast text search with chapter context.
 */

export interface SearchResult {
  id: string;
  spineIndex: number;
  spineHref: string;
  chapter: string;
  text: string;
  matchStart: number;
  matchEnd: number;
  contextBefore: string;
  contextAfter: string;
}

export interface ChapterIndex {
  spineIndex: number;
  spineHref: string;
  chapter: string;
  text: string;
  // Store paragraph boundaries for better context extraction
  paragraphs: { start: number; end: number; text: string }[];
}

export class SearchIndex {
  private chapters: ChapterIndex[] = [];
  private isBuilding = false;
  private isReady = false;

  /**
   * Check if the index is ready for searching
   */
  get ready(): boolean {
    return this.isReady;
  }

  /**
   * Check if the index is currently being built
   */
  get building(): boolean {
    return this.isBuilding;
  }

  /**
   * Build the search index from book content
   */
  async build(
    getChapterContent: (spineIndex: number) => Promise<{ html: string; chapter: string; href: string }>,
    spineLength: number,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    if (this.isBuilding) return;

    this.isBuilding = true;
    this.isReady = false;
    this.chapters = [];

    try {
      for (let i = 0; i < spineLength; i++) {
        try {
          const content = await getChapterContent(i);
          const textContent = this.extractText(content.html);
          const paragraphs = this.extractParagraphs(content.html);

          this.chapters.push({
            spineIndex: i,
            spineHref: content.href,
            chapter: content.chapter || `Chapter ${i + 1}`,
            text: textContent,
            paragraphs,
          });

          onProgress?.(i + 1, spineLength);
        } catch (e) {
          console.warn(`Failed to index chapter ${i}:`, e);
        }
      }

      this.isReady = true;
    } finally {
      this.isBuilding = false;
    }
  }

  /**
   * Search the index for a query string
   */
  search(query: string, maxResults = 100): SearchResult[] {
    if (!this.isReady || !query.trim()) return [];

    const results: SearchResult[] = [];
    const normalizedQuery = query.toLowerCase().trim();
    const contextLength = 50;

    for (const chapter of this.chapters) {
      const lowerText = chapter.text.toLowerCase();
      let pos = 0;

      while (pos < lowerText.length && results.length < maxResults) {
        const matchIndex = lowerText.indexOf(normalizedQuery, pos);
        if (matchIndex === -1) break;

        // Extract context
        const contextStart = Math.max(0, matchIndex - contextLength);
        const contextEnd = Math.min(chapter.text.length, matchIndex + query.length + contextLength);

        const contextBefore = chapter.text.slice(contextStart, matchIndex);
        const matchText = chapter.text.slice(matchIndex, matchIndex + query.length);
        const contextAfter = chapter.text.slice(matchIndex + query.length, contextEnd);

        results.push({
          id: `${chapter.spineIndex}-${matchIndex}`,
          spineIndex: chapter.spineIndex,
          spineHref: chapter.spineHref,
          chapter: chapter.chapter,
          text: matchText,
          matchStart: matchIndex,
          matchEnd: matchIndex + query.length,
          contextBefore: (contextStart > 0 ? '...' : '') + contextBefore,
          contextAfter: contextAfter + (contextEnd < chapter.text.length ? '...' : ''),
        });

        pos = matchIndex + 1;
      }
    }

    return results;
  }

  /**
   * Get search results grouped by chapter
   */
  searchGrouped(query: string, maxResults = 100): Map<string, SearchResult[]> {
    const results = this.search(query, maxResults);
    const grouped = new Map<string, SearchResult[]>();

    for (const result of results) {
      const key = result.chapter;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(result);
    }

    return grouped;
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.chapters = [];
    this.isReady = false;
  }

  /**
   * Extract plain text from HTML
   */
  private extractText(html: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Remove script and style elements
    doc.querySelectorAll('script, style, noscript').forEach(el => el.remove());

    // Get text content
    const text = doc.body?.textContent || '';

    // Normalize whitespace
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Extract paragraphs with their positions
   */
  private extractParagraphs(html: string): { start: number; end: number; text: string }[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const paragraphs: { start: number; end: number; text: string }[] = [];

    // Remove script and style elements
    doc.querySelectorAll('script, style, noscript').forEach(el => el.remove());

    // Get all text-containing elements
    const elements = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, div');
    let currentPos = 0;

    for (const el of Array.from(elements)) {
      const text = el.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (text.length > 0) {
        paragraphs.push({
          start: currentPos,
          end: currentPos + text.length,
          text,
        });
        currentPos += text.length + 1; // +1 for space between paragraphs
      }
    }

    return paragraphs;
  }
}

// Singleton instance for the current book
let currentIndex: SearchIndex | null = null;

export function getSearchIndex(): SearchIndex {
  if (!currentIndex) {
    currentIndex = new SearchIndex();
  }
  return currentIndex;
}

export function clearSearchIndex(): void {
  if (currentIndex) {
    currentIndex.clear();
    currentIndex = null;
  }
}

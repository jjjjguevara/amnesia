/**
 * Section Manager
 *
 * Utilities for managing marked sections in markdown files.
 * Supports:
 * - Updating content between section markers
 * - Tombstone pattern for deleted items
 * - ID-based content tracking
 * - Append-only operations
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

// ============================================================================
// Types
// ============================================================================

/**
 * A managed section in a markdown file
 */
export interface ManagedSection {
  /** Section identifier (e.g., "HIGHLIGHTS", "NOTES") */
  id: string;
  /** Content between the markers */
  content: string;
  /** Start position in the file */
  startIndex: number;
  /** End position in the file */
  endIndex: number;
}

/**
 * An item tracked by ID in content
 */
export interface TrackedItem {
  /** Unique identifier */
  id: string;
  /** Full line/block containing the item */
  content: string;
  /** Whether the item has been marked as deleted (tombstone) */
  isDeleted: boolean;
  /** Line number in the file (1-based) */
  lineNumber: number;
}

/**
 * Result of a section update operation
 */
export interface SectionUpdateResult {
  /** Updated file content */
  content: string;
  /** Whether any changes were made */
  changed: boolean;
  /** Items that were added */
  added: string[];
  /** Items that were updated */
  updated: string[];
  /** Items that were tombstoned */
  tombstoned: string[];
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Marker format for managed sections
 * Example: <!-- AMNESIA:HIGHLIGHTS:START -->
 */
const SECTION_START_MARKER = (id: string) => `<!-- AMNESIA:${id}:START -->`;
const SECTION_END_MARKER = (id: string) => `<!-- AMNESIA:${id}:END -->`;

/**
 * Marker format for tracked items
 * Example: %% amnesia:hl-abc123 %%
 */
const ITEM_ID_PATTERN = /%% amnesia:([a-zA-Z0-9-_]+) %%/g;
const ITEM_DELETED_PATTERN = /%% amnesia:([a-zA-Z0-9-_]+):deleted %%/g;

/**
 * Create an item ID marker
 */
export function createItemMarker(id: string): string {
  return `%% amnesia:${id} %%`;
}

/**
 * Create a deleted item marker (tombstone)
 */
export function createTombstoneMarker(id: string): string {
  return `%% amnesia:${id}:deleted %%`;
}

// ============================================================================
// Section Operations
// ============================================================================

/**
 * Extract a managed section from content
 */
export function extractSection(content: string, sectionId: string): ManagedSection | null {
  const startMarker = SECTION_START_MARKER(sectionId);
  const endMarker = SECTION_END_MARKER(sectionId);

  const startIndex = content.indexOf(startMarker);
  if (startIndex === -1) return null;

  const endIndex = content.indexOf(endMarker, startIndex);
  if (endIndex === -1) return null;

  const contentStart = startIndex + startMarker.length;
  const sectionContent = content.slice(contentStart, endIndex).trim();

  return {
    id: sectionId,
    content: sectionContent,
    startIndex,
    endIndex: endIndex + endMarker.length,
  };
}

/**
 * Update content within a managed section
 */
export function updateSection(
  content: string,
  sectionId: string,
  newContent: string
): string {
  const startMarker = SECTION_START_MARKER(sectionId);
  const endMarker = SECTION_END_MARKER(sectionId);

  const regex = new RegExp(
    escapeRegex(startMarker) + '[\\s\\S]*?' + escapeRegex(endMarker),
    'g'
  );

  if (regex.test(content)) {
    // Replace existing section
    return content.replace(
      regex,
      `${startMarker}\n${newContent}\n${endMarker}`
    );
  } else {
    // Section doesn't exist - append at end
    return content + `\n\n${startMarker}\n${newContent}\n${endMarker}`;
  }
}

/**
 * Append content to a managed section (without replacing existing content)
 */
export function appendToSection(
  content: string,
  sectionId: string,
  newContent: string
): string {
  const section = extractSection(content, sectionId);

  if (section) {
    // Append to existing section
    const updatedSectionContent = section.content
      ? `${section.content}\n\n${newContent}`
      : newContent;

    return updateSection(content, sectionId, updatedSectionContent);
  } else {
    // Create new section
    const startMarker = SECTION_START_MARKER(sectionId);
    const endMarker = SECTION_END_MARKER(sectionId);
    return content + `\n\n${startMarker}\n${newContent}\n${endMarker}`;
  }
}

/**
 * Remove a managed section entirely
 */
export function removeSection(content: string, sectionId: string): string {
  const startMarker = SECTION_START_MARKER(sectionId);
  const endMarker = SECTION_END_MARKER(sectionId);

  const regex = new RegExp(
    escapeRegex(startMarker) + '[\\s\\S]*?' + escapeRegex(endMarker),
    'g'
  );

  return content.replace(regex, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Check if a section exists in content
 */
export function hasSection(content: string, sectionId: string): boolean {
  return extractSection(content, sectionId) !== null;
}

// ============================================================================
// Item Tracking Operations
// ============================================================================

/**
 * Extract all tracked items from content
 */
export function extractTrackedItems(content: string): TrackedItem[] {
  const items: TrackedItem[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for deleted items
    const deletedMatches = [...line.matchAll(new RegExp(ITEM_DELETED_PATTERN.source, 'g'))];
    for (const match of deletedMatches) {
      items.push({
        id: match[1],
        content: line,
        isDeleted: true,
        lineNumber: i + 1,
      });
    }

    // Check for active items (only if not already matched as deleted)
    if (deletedMatches.length === 0) {
      const activeMatches = [...line.matchAll(new RegExp(ITEM_ID_PATTERN.source, 'g'))];
      for (const match of activeMatches) {
        items.push({
          id: match[1],
          content: line,
          isDeleted: false,
          lineNumber: i + 1,
        });
      }
    }
  }

  return items;
}

/**
 * Get IDs of all tracked items (excluding deleted)
 */
export function getTrackedIds(content: string): Set<string> {
  const items = extractTrackedItems(content);
  return new Set(items.filter(i => !i.isDeleted).map(i => i.id));
}

/**
 * Check if an item ID exists in content (excluding deleted)
 */
export function hasItemId(content: string, id: string): boolean {
  return getTrackedIds(content).has(id);
}

/**
 * Mark an item as deleted (tombstone pattern)
 */
export function tombstoneItem(content: string, id: string): string {
  const marker = createItemMarker(id);
  const tombstone = createTombstoneMarker(id);

  // Replace the marker with tombstone
  let updated = content.replace(marker, tombstone);

  // Also add strikethrough to the content if it's a blockquote
  const lines = updated.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(tombstone) && lines[i].startsWith('>')) {
      // Add strikethrough to the quote content
      const parts = lines[i].split(tombstone);
      if (parts[0].startsWith('>')) {
        const quoteContent = parts[0].slice(1).trim();
        if (!quoteContent.startsWith('~~')) {
          lines[i] = `> ~~${quoteContent}~~ ${tombstone}`;
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Remove tombstoned items from content
 */
export function removeTombstones(content: string): string {
  const lines = content.split('\n');
  const filtered = lines.filter(line => {
    const deletedMatches = [...line.matchAll(new RegExp(ITEM_DELETED_PATTERN.source, 'g'))];
    return deletedMatches.length === 0;
  });

  return filtered.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ============================================================================
// Sync Operations
// ============================================================================

/**
 * Sync items to a section with deduplication
 *
 * @param content - File content
 * @param sectionId - Section to update
 * @param items - Items to sync (id -> rendered content)
 * @param options - Sync options
 */
export function syncItemsToSection(
  content: string,
  sectionId: string,
  items: Map<string, string>,
  options: {
    /** Whether to tombstone items not in the new set */
    tombstoneRemoved?: boolean;
    /** Whether to append only (never remove) */
    appendOnly?: boolean;
  } = {}
): SectionUpdateResult {
  const { tombstoneRemoved = false, appendOnly = true } = options;

  const section = extractSection(content, sectionId);
  const existingIds = section ? getTrackedIds(section.content) : new Set<string>();
  const existingItems = section ? extractTrackedItems(section.content) : [];

  const added: string[] = [];
  const updated: string[] = [];
  const tombstoned: string[] = [];

  let newSectionContent = section?.content || '';

  // Add new items
  for (const [id, itemContent] of items) {
    if (!existingIds.has(id)) {
      // New item - append
      newSectionContent = newSectionContent
        ? `${newSectionContent}\n\n${itemContent}`
        : itemContent;
      added.push(id);
    }
  }

  // Handle removed items
  if (!appendOnly && tombstoneRemoved) {
    for (const existingItem of existingItems) {
      if (!existingItem.isDeleted && !items.has(existingItem.id)) {
        // Item was removed from source - tombstone it
        newSectionContent = tombstoneItem(newSectionContent, existingItem.id);
        tombstoned.push(existingItem.id);
      }
    }
  }

  const updatedContent = updateSection(content, sectionId, newSectionContent.trim());

  return {
    content: updatedContent,
    changed: added.length > 0 || updated.length > 0 || tombstoned.length > 0,
    added,
    updated,
    tombstoned,
  };
}

// ============================================================================
// Frontmatter Operations
// ============================================================================

/**
 * Extract frontmatter from content
 */
export function extractFrontmatter(content: string): {
  frontmatter: string;
  body: string;
  hasFrontmatter: boolean;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);

  if (match) {
    return {
      frontmatter: match[1],
      body: content.slice(match[0].length),
      hasFrontmatter: true,
    };
  }

  return {
    frontmatter: '',
    body: content,
    hasFrontmatter: false,
  };
}

/**
 * Get a value from frontmatter
 */
export function getFrontmatterValue(content: string, key: string): string | null {
  const { frontmatter, hasFrontmatter } = extractFrontmatter(content);

  if (!hasFrontmatter) return null;

  // Simple YAML value extraction (handles basic cases)
  const regex = new RegExp(`^${escapeRegex(key)}:\\s*["']?(.+?)["']?$`, 'm');
  const match = frontmatter.match(regex);

  return match ? match[1].trim() : null;
}

/**
 * Get an array value from frontmatter
 */
export function getFrontmatterArray(content: string, key: string): string[] {
  const { frontmatter, hasFrontmatter } = extractFrontmatter(content);

  if (!hasFrontmatter) return [];

  // Find the key and extract array items
  const keyIndex = frontmatter.indexOf(`${key}:`);
  if (keyIndex === -1) return [];

  const lines = frontmatter.slice(keyIndex).split('\n');
  const items: string[] = [];

  // Skip the key line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^\s+-\s+/)) {
      // Array item
      const value = line.replace(/^\s+-\s+["']?(.+?)["']?\s*$/, '$1');
      items.push(value);
    } else if (!line.match(/^\s+/)) {
      // New key - stop
      break;
    }
  }

  return items;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create section markers for a given ID
 */
export function createSectionMarkers(sectionId: string): {
  start: string;
  end: string;
} {
  return {
    start: SECTION_START_MARKER(sectionId),
    end: SECTION_END_MARKER(sectionId),
  };
}

/**
 * Wrap content in section markers
 */
export function wrapInSection(sectionId: string, content: string): string {
  const { start, end } = createSectionMarkers(sectionId);
  return `${start}\n${content}\n${end}`;
}

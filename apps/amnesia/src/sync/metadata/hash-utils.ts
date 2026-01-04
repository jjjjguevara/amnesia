/**
 * Hash Utilities
 *
 * Utilities for computing content hashes for Smart Skip optimization.
 * Stores sync hash in frontmatter to skip unchanged files during sync.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Data that contributes to the sync hash
 */
export interface HashableData {
  /** Calibre book ID */
  calibreId?: number;
  /** Book metadata fields */
  metadata?: Record<string, unknown>;
  /** Highlight IDs */
  highlightIds?: string[];
  /** Note IDs */
  noteIds?: string[];
  /** Last modified timestamp from source */
  lastModified?: Date | string;
}

/**
 * Sync hash stored in frontmatter
 */
export interface SyncHash {
  /** The hash value */
  hash: string;
  /** When the hash was computed */
  computedAt: string;
  /** Version of hash algorithm */
  version: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Current hash algorithm version
 * Increment when changing hash computation logic
 */
const HASH_VERSION = 1;

/**
 * Frontmatter key for sync hash
 */
export const SYNC_HASH_KEY = 'amnesia_sync_hash';

// ============================================================================
// Hash Functions
// ============================================================================

/**
 * Compute a fast hash using djb2 algorithm
 * Not cryptographic, but fast for change detection
 */
export function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  // Convert to unsigned 32-bit integer and then to hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute a longer hash by combining multiple djb2 passes
 */
export function computeHash(data: string): string {
  // Split into chunks and hash each
  const chunk1 = djb2Hash(data);
  const chunk2 = djb2Hash(data.split('').reverse().join(''));
  const chunk3 = djb2Hash(data + chunk1);

  return `${chunk1}${chunk2.slice(0, 4)}`;
}

/**
 * Compute sync hash from hashable data
 */
export function computeSyncHash(data: HashableData): SyncHash {
  // Normalize and serialize the data
  const normalized = normalizeHashData(data);
  const serialized = JSON.stringify(normalized, Object.keys(normalized).sort());

  return {
    hash: computeHash(serialized),
    computedAt: new Date().toISOString(),
    version: HASH_VERSION,
  };
}

/**
 * Normalize data for consistent hashing
 */
function normalizeHashData(data: HashableData): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (data.calibreId !== undefined) {
    result.calibreId = data.calibreId;
  }

  if (data.metadata) {
    // Sort metadata keys for consistent ordering
    const sortedMetadata: Record<string, unknown> = {};
    for (const key of Object.keys(data.metadata).sort()) {
      sortedMetadata[key] = normalizeValue(data.metadata[key]);
    }
    result.metadata = sortedMetadata;
  }

  if (data.highlightIds && data.highlightIds.length > 0) {
    result.highlightIds = [...data.highlightIds].sort();
  }

  if (data.noteIds && data.noteIds.length > 0) {
    result.noteIds = [...data.noteIds].sort();
  }

  if (data.lastModified) {
    const date = data.lastModified instanceof Date
      ? data.lastModified
      : new Date(data.lastModified);
    result.lastModified = date.toISOString();
  }

  return result;
}

/**
 * Normalize a value for consistent hashing
 */
function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }

  return value;
}

// ============================================================================
// Comparison Functions
// ============================================================================

/**
 * Check if stored hash matches computed hash
 */
export function hashMatches(stored: SyncHash | string | undefined, computed: SyncHash): boolean {
  if (!stored) {
    return false;
  }

  // Handle legacy string-only hash
  if (typeof stored === 'string') {
    return stored === computed.hash;
  }

  // Version mismatch means we should re-sync
  if (stored.version !== computed.version) {
    return false;
  }

  return stored.hash === computed.hash;
}

/**
 * Check if a file needs syncing based on hash
 */
export function needsSync(
  frontmatterHash: SyncHash | string | undefined,
  sourceData: HashableData
): boolean {
  const computedHash = computeSyncHash(sourceData);
  return !hashMatches(frontmatterHash, computedHash);
}

// ============================================================================
// Frontmatter Helpers
// ============================================================================

/**
 * Extract sync hash from frontmatter
 */
export function extractSyncHash(frontmatter: Record<string, unknown>): SyncHash | string | undefined {
  const value = frontmatter[SYNC_HASH_KEY];

  if (!value) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.hash === 'string') {
      return {
        hash: obj.hash,
        computedAt: typeof obj.computedAt === 'string' ? obj.computedAt : new Date().toISOString(),
        version: typeof obj.version === 'number' ? obj.version : 1,
      };
    }
  }

  return undefined;
}

/**
 * Format sync hash for frontmatter storage
 * Returns simple string for compactness
 */
export function formatSyncHashForFrontmatter(hash: SyncHash): string {
  // Store as simple string with version prefix
  return `v${hash.version}:${hash.hash}`;
}

/**
 * Parse sync hash from frontmatter string format
 */
export function parseSyncHashFromFrontmatter(value: string): SyncHash | undefined {
  const match = value.match(/^v(\d+):([a-f0-9]+)$/);
  if (!match) {
    // Legacy format without version
    if (/^[a-f0-9]+$/.test(value)) {
      return {
        hash: value,
        computedAt: '',
        version: 1,
      };
    }
    return undefined;
  }

  return {
    hash: match[2],
    computedAt: '',
    version: parseInt(match[1], 10),
  };
}

// ============================================================================
// Book-Specific Hash Helpers
// ============================================================================

/**
 * Compute hash for a book's sync-relevant data
 */
export function computeBookSyncHash(book: {
  calibreId?: number;
  title?: string;
  authors?: string[];
  rating?: number;
  tags?: string[];
  series?: { name: string; index?: number };
  progress?: number;
  highlights?: Array<{ id: string }>;
  notes?: Array<{ id: string }>;
  lastModified?: Date | string;
}): SyncHash {
  return computeSyncHash({
    calibreId: book.calibreId,
    metadata: {
      title: book.title,
      authors: book.authors,
      rating: book.rating,
      tags: book.tags,
      series: book.series,
      progress: book.progress,
    },
    highlightIds: book.highlights?.map(h => h.id),
    noteIds: book.notes?.map(n => n.id),
    lastModified: book.lastModified,
  });
}

/**
 * Quick check if a book needs syncing
 */
export function bookNeedsSync(
  frontmatter: Record<string, unknown>,
  book: {
    calibreId?: number;
    title?: string;
    authors?: string[];
    rating?: number;
    tags?: string[];
    series?: { name: string; index?: number };
    progress?: number;
    highlights?: Array<{ id: string }>;
    notes?: Array<{ id: string }>;
    lastModified?: Date | string;
  }
): boolean {
  const storedHash = extractSyncHash(frontmatter);
  const computedHash = computeBookSyncHash(book);
  return !hashMatches(storedHash, computedHash);
}

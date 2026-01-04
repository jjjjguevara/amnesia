/**
 * Field Alias Resolver
 *
 * Handles resolution of field aliases for frontmatter mapping.
 * Maps multiple frontmatter keys to a single canonical Calibre field.
 *
 * @example
 * // User might have 'author', 'authors', or 'creator' in their frontmatter
 * // All resolve to the canonical 'authors' field for Calibre sync
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type { FieldAlias } from '../../settings/settings';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of resolving a frontmatter key
 */
export interface ResolvedField {
  /** The canonical Calibre field name */
  canonicalField: string;
  /** The original key that was matched */
  matchedAlias: string;
  /** The primary key to use when writing back */
  primaryKey: string;
}

/**
 * Options for alias resolution
 */
export interface ResolverOptions {
  /** Whether to perform case-insensitive matching. Default: true */
  caseInsensitive?: boolean;
  /** Whether to trim whitespace from keys. Default: true */
  trimWhitespace?: boolean;
}

// ============================================================================
// Field Alias Resolver Class
// ============================================================================

/**
 * Resolves field aliases for bidirectional frontmatter ↔ Calibre sync.
 *
 * @example
 * const resolver = new FieldAliasResolver([
 *   { canonicalField: 'authors', aliases: ['authors', 'author', 'creator'] }
 * ]);
 *
 * resolver.resolveToCanonical('Author'); // → 'authors'
 * resolver.getPrimaryKey('authors'); // → 'authors'
 */
export class FieldAliasResolver {
  private aliasToCanonical: Map<string, FieldAlias>;
  private canonicalToAlias: Map<string, FieldAlias>;
  private options: Required<ResolverOptions>;

  constructor(aliases: FieldAlias[], options?: ResolverOptions) {
    this.aliasToCanonical = new Map();
    this.canonicalToAlias = new Map();
    this.options = {
      caseInsensitive: options?.caseInsensitive ?? true,
      trimWhitespace: options?.trimWhitespace ?? true,
    };

    this.buildMaps(aliases);
  }

  /**
   * Build lookup maps from alias configurations
   */
  private buildMaps(aliases: FieldAlias[]): void {
    for (const alias of aliases) {
      // Map canonical field
      const canonicalKey = this.normalizeKey(alias.canonicalField);
      this.canonicalToAlias.set(canonicalKey, alias);

      // Map each alias to the canonical field
      for (const aliasKey of alias.aliases) {
        const normalizedAlias = this.normalizeKey(aliasKey);
        this.aliasToCanonical.set(normalizedAlias, alias);
      }
    }
  }

  /**
   * Normalize a key for consistent lookup
   */
  private normalizeKey(key: string): string {
    let normalized = key;
    if (this.options.trimWhitespace) {
      normalized = normalized.trim();
    }
    if (this.options.caseInsensitive) {
      normalized = normalized.toLowerCase();
    }
    return normalized;
  }

  /**
   * Resolve a frontmatter key to its canonical Calibre field
   *
   * @param obsidianKey - The key found in frontmatter
   * @returns The canonical field name, or null if not found
   */
  resolveToCanonical(obsidianKey: string): string | null {
    const normalized = this.normalizeKey(obsidianKey);
    const alias = this.aliasToCanonical.get(normalized);
    return alias?.canonicalField ?? null;
  }

  /**
   * Resolve a frontmatter key with full details
   *
   * @param obsidianKey - The key found in frontmatter
   * @returns Full resolution details, or null if not found
   */
  resolve(obsidianKey: string): ResolvedField | null {
    const normalized = this.normalizeKey(obsidianKey);
    const alias = this.aliasToCanonical.get(normalized);

    if (!alias) {
      return null;
    }

    return {
      canonicalField: alias.canonicalField,
      matchedAlias: obsidianKey,
      primaryKey: alias.primaryObsidianKey ?? alias.aliases[0],
    };
  }

  /**
   * Get the primary frontmatter key for a canonical field
   *
   * @param canonicalField - The Calibre field name
   * @returns The primary key to use when writing, or null if not found
   */
  getPrimaryKey(canonicalField: string): string | null {
    const normalized = this.normalizeKey(canonicalField);
    const alias = this.canonicalToAlias.get(normalized);

    if (!alias) {
      return null;
    }

    return alias.primaryObsidianKey ?? alias.aliases[0];
  }

  /**
   * Get all aliases for a canonical field
   *
   * @param canonicalField - The Calibre field name
   * @returns Array of all aliases, or empty array if not found
   */
  getAllAliases(canonicalField: string): string[] {
    const normalized = this.normalizeKey(canonicalField);
    const alias = this.canonicalToAlias.get(normalized);
    return alias?.aliases ?? [];
  }

  /**
   * Check if a key is a known alias
   */
  isKnownAlias(key: string): boolean {
    const normalized = this.normalizeKey(key);
    return this.aliasToCanonical.has(normalized);
  }

  /**
   * Check if a field is a canonical field
   */
  isCanonicalField(field: string): boolean {
    const normalized = this.normalizeKey(field);
    return this.canonicalToAlias.has(normalized);
  }

  /**
   * Get all canonical fields
   */
  getCanonicalFields(): string[] {
    return Array.from(this.canonicalToAlias.values()).map(a => a.canonicalField);
  }
}

// ============================================================================
// Frontmatter Helpers
// ============================================================================

/**
 * Find a value in frontmatter using alias resolution
 *
 * @param frontmatter - The frontmatter object
 * @param canonicalField - The canonical field to find
 * @param resolver - The alias resolver
 * @returns The value and the key it was found under, or null
 */
export function findAliasedValue(
  frontmatter: Record<string, unknown>,
  canonicalField: string,
  resolver: FieldAliasResolver
): { value: unknown; key: string } | null {
  const aliases = resolver.getAllAliases(canonicalField);

  // Check each alias in order
  for (const alias of aliases) {
    if (alias in frontmatter) {
      return { value: frontmatter[alias], key: alias };
    }
  }

  // Also check the canonical field itself
  if (canonicalField in frontmatter) {
    return { value: frontmatter[canonicalField], key: canonicalField };
  }

  return null;
}

/**
 * Set a value in frontmatter using the primary alias
 *
 * @param frontmatter - The frontmatter object (mutated)
 * @param canonicalField - The canonical field to set
 * @param value - The value to set
 * @param resolver - The alias resolver
 * @returns The key that was used
 */
export function setAliasedValue(
  frontmatter: Record<string, unknown>,
  canonicalField: string,
  value: unknown,
  resolver: FieldAliasResolver
): string {
  const primaryKey = resolver.getPrimaryKey(canonicalField) ?? canonicalField;
  frontmatter[primaryKey] = value;
  return primaryKey;
}

/**
 * Clean up redundant alias keys after setting a value
 * Removes all aliases except the primary key
 *
 * @param frontmatter - The frontmatter object (mutated)
 * @param canonicalField - The canonical field to clean
 * @param resolver - The alias resolver
 * @returns Array of keys that were removed
 */
export function cleanupAliasKeys(
  frontmatter: Record<string, unknown>,
  canonicalField: string,
  resolver: FieldAliasResolver
): string[] {
  const primaryKey = resolver.getPrimaryKey(canonicalField);
  const allAliases = resolver.getAllAliases(canonicalField);
  const removed: string[] = [];

  for (const alias of allAliases) {
    // Skip the primary key
    if (alias === primaryKey) {
      continue;
    }

    // Remove other aliases if they exist
    if (alias in frontmatter) {
      delete frontmatter[alias];
      removed.push(alias);
    }
  }

  return removed;
}

/**
 * Migrate frontmatter to use primary alias keys
 *
 * @param frontmatter - The frontmatter object (mutated)
 * @param resolver - The alias resolver
 * @returns Object with migration details
 */
export function migrateFrontmatterAliases(
  frontmatter: Record<string, unknown>,
  resolver: FieldAliasResolver
): { migratedFields: string[]; removedKeys: string[] } {
  const migratedFields: string[] = [];
  const removedKeys: string[] = [];

  for (const canonicalField of resolver.getCanonicalFields()) {
    const found = findAliasedValue(frontmatter, canonicalField, resolver);

    if (found) {
      const primaryKey = resolver.getPrimaryKey(canonicalField);

      // If found under non-primary key, migrate
      if (primaryKey && found.key !== primaryKey) {
        frontmatter[primaryKey] = found.value;
        delete frontmatter[found.key];
        migratedFields.push(canonicalField);
        removedKeys.push(found.key);
      }

      // Clean up any other duplicate aliases
      const cleaned = cleanupAliasKeys(frontmatter, canonicalField, resolver);
      removedKeys.push(...cleaned);
    }
  }

  return { migratedFields, removedKeys };
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a resolver from settings
 */
export function createAliasResolver(
  aliases: FieldAlias[],
  options?: ResolverOptions
): FieldAliasResolver {
  return new FieldAliasResolver(aliases, options);
}

/**
 * Create a resolver with default aliases
 */
export function createDefaultAliasResolver(): FieldAliasResolver {
  const defaultAliases: FieldAlias[] = [
    { canonicalField: 'title', aliases: ['title', 'título', 'book_name', 'book'] },
    { canonicalField: 'authors', aliases: ['authors', 'author', 'creator', 'escritor'] },
    { canonicalField: 'tags', aliases: ['tags', 'keywords', 'keyterms', 'bookshelves'] },
    { canonicalField: 'rating', aliases: ['rating', 'stars', 'score', 'valoración'] },
    { canonicalField: 'series', aliases: ['series', 'serie', 'saga'] },
    { canonicalField: 'publisher', aliases: ['publisher', 'editorial'] },
    { canonicalField: 'progress', aliases: ['progress', 'percent', 'reading_progress'] },
  ];

  return new FieldAliasResolver(defaultAliases);
}

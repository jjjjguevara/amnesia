/**
 * Field Mapping Schema
 *
 * Defines mappings between Calibre fields and Obsidian frontmatter/body.
 * Supports transformers for complex field conversions.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type {
  CalibreSchemaMapping,
  FieldMappingConfig,
  TransformerFunction,
  SyncDirection,
  FieldConflictStrategy,
} from './types';
import {
  FieldAliasResolver,
  findAliasedValue,
  setAliasedValue,
  cleanupAliasKeys,
  createDefaultAliasResolver,
} from './alias-resolver';
import type { FieldAlias } from '../../settings/settings';

// ============================================================================
// Default Schema Mapping
// ============================================================================

/**
 * Default Calibre ↔ Obsidian field mapping schema
 */
export const DEFAULT_SCHEMA_MAPPING: CalibreSchemaMapping = {
  standardFields: {
    // Identity fields (Calibre authoritative)
    title: {
      obsidianPath: 'frontmatter.title',
      direction: 'calibre-wins',
      type: 'string',
      required: true,
    },
    authors: {
      obsidianPath: 'frontmatter.author',
      direction: 'calibre-wins',
      type: 'array',
      transformer: 'wikilink',
    },
    series: {
      obsidianPath: 'frontmatter.series',
      direction: 'calibre-wins',
      type: 'string',
      transformer: 'wikilink',
    },
    series_index: {
      obsidianPath: 'frontmatter.seriesIndex',
      direction: 'calibre-wins',
      type: 'number',
    },
    publisher: {
      obsidianPath: 'frontmatter.publisher',
      direction: 'calibre-wins',
      type: 'string',
    },
    pubdate: {
      obsidianPath: 'frontmatter.publishedDate',
      direction: 'calibre-wins',
      type: 'date',
      transformer: 'date',
    },
    comments: {
      obsidianPath: 'body.description',
      direction: 'calibre-wins',
      type: 'string',
    },
    uuid: {
      obsidianPath: 'frontmatter.calibreUuid',
      direction: 'calibre-wins',
      type: 'string',
    },
    identifiers: {
      obsidianPath: 'frontmatter.identifiers',
      direction: 'calibre-wins',
      type: 'object',
    },

    // Bidirectional fields (user can edit in either)
    rating: {
      obsidianPath: 'frontmatter.rating',
      direction: 'bidirectional',
      type: 'number',
      conflictStrategy: 'ask-user',
      validator: 'rating',
      transformer: 'rating',
    },
    tags: {
      obsidianPath: 'frontmatter.bookshelves',
      direction: 'bidirectional',
      type: 'array',
      conflictStrategy: 'merge-union',
      transformer: 'lowercase',
    },

    // Cover (special handling)
    cover: {
      obsidianPath: 'frontmatter.cover',
      direction: 'calibre-wins',
      type: 'string',
      transformer: 'coverPath',
    },
  },

  customColumns: {
    // Common custom columns (can be extended by user)
    '#read_date': {
      obsidianPath: 'frontmatter.completedAt',
      direction: 'bidirectional',
      type: 'date',
      transformer: 'date',
    },
    '#read_count': {
      obsidianPath: 'frontmatter.timesRead',
      direction: 'bidirectional',
      type: 'number',
    },
    '#my_notes': {
      obsidianPath: 'body.calibreNotes',
      direction: 'bidirectional',
      type: 'string',
    },
    '#status': {
      obsidianPath: 'frontmatter.status',
      direction: 'bidirectional',
      type: 'string',
    },
  },

  obsidianOnlyFields: [
    'progress',
    'currentCfi',
    'highlights',
    'notes',
    'bookmarks',
    'lastReadAt',
  ],

  transformers: {},
};

// ============================================================================
// Built-in Transformers
// ============================================================================

/**
 * Transform value to wikilink format
 */
export const wikilinkTransformer: TransformerFunction = (
  value,
  direction,
  metadata
) => {
  if (direction === 'toObsidian') {
    if (Array.isArray(value)) {
      const folder = metadata?.folder || '';
      return value.map((v) =>
        folder ? `[[${folder}/${v}|${v}]]` : `[[${v}]]`
      );
    }
    if (typeof value === 'string') {
      const folder = metadata?.folder || '';
      return folder ? `[[${folder}/${value}|${value}]]` : `[[${value}]]`;
    }
  }

  if (direction === 'toCalibre') {
    if (Array.isArray(value)) {
      return value.map((v) => extractFromWikilink(v));
    }
    if (typeof value === 'string') {
      return extractFromWikilink(value);
    }
  }

  return value;
};

/**
 * Extract text from wikilink format
 */
function extractFromWikilink(text: string): string {
  // Match [[folder/name|display]] or [[name]]
  const match = text.match(/\[\[(?:[^|]+\|)?([^\]]+)\]\]/);
  return match ? match[1] : text;
}

/**
 * Transform date values
 */
export const dateTransformer: TransformerFunction = (value, direction) => {
  if (direction === 'toObsidian') {
    if (value instanceof Date) {
      return value.toISOString().split('T')[0];
    }
    if (typeof value === 'string') {
      const date = new Date(value);
      return isNaN(date.getTime()) ? value : date.toISOString().split('T')[0];
    }
  }

  if (direction === 'toCalibre') {
    if (typeof value === 'string') {
      return new Date(value);
    }
  }

  return value;
};

/**
 * Transform rating values (Calibre uses 0-10, Obsidian uses 0-5)
 */
export const ratingTransformer: TransformerFunction = (value, direction) => {
  if (typeof value !== 'number') return value;

  if (direction === 'toObsidian') {
    // Calibre 0-10 → Obsidian 0-5
    return Math.round(value / 2);
  }

  if (direction === 'toCalibre') {
    // Obsidian 0-5 → Calibre 0-10
    return value * 2;
  }

  return value;
};

/**
 * Transform to lowercase
 */
export const lowercaseTransformer: TransformerFunction = (value) => {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.toLowerCase() : v));
  }
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  return value;
};

/**
 * Transform cover path
 */
export const coverPathTransformer: TransformerFunction = (
  value,
  direction,
  metadata
) => {
  if (direction === 'toObsidian' && typeof value === 'string') {
    const coversFolder = (metadata?.coversFolder as string) || 'Portadas';
    const title = (metadata?.title as string) || 'cover';
    const sanitizedTitle = title
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    return `${coversFolder}/${sanitizedTitle}.jpg`;
  }
  return value;
};

/**
 * Registry of built-in transformers
 */
export const BUILT_IN_TRANSFORMERS: Record<string, TransformerFunction> = {
  wikilink: wikilinkTransformer,
  date: dateTransformer,
  rating: ratingTransformer,
  lowercase: lowercaseTransformer,
  coverPath: coverPathTransformer,
};

// ============================================================================
// Field Mapping Manager
// ============================================================================

/**
 * Manages field mappings between Calibre and Obsidian
 */
export class FieldMappingManager {
  private schema: CalibreSchemaMapping;
  private transformers: Map<string, TransformerFunction>;
  private aliasResolver: FieldAliasResolver;

  constructor(
    schema: Partial<CalibreSchemaMapping> = {},
    fieldAliases?: FieldAlias[]
  ) {
    this.schema = {
      ...DEFAULT_SCHEMA_MAPPING,
      ...schema,
      standardFields: {
        ...DEFAULT_SCHEMA_MAPPING.standardFields,
        ...schema.standardFields,
      },
      customColumns: {
        ...DEFAULT_SCHEMA_MAPPING.customColumns,
        ...schema.customColumns,
      },
    };

    this.transformers = new Map(Object.entries(BUILT_IN_TRANSFORMERS));

    // Add custom transformers
    if (schema.transformers) {
      for (const [name, fn] of Object.entries(schema.transformers)) {
        this.transformers.set(name, fn);
      }
    }

    // Initialize alias resolver
    this.aliasResolver = fieldAliases
      ? new FieldAliasResolver(fieldAliases)
      : createDefaultAliasResolver();
  }

  /**
   * Update the alias resolver with new aliases
   */
  setAliases(fieldAliases: FieldAlias[]): void {
    this.aliasResolver = new FieldAliasResolver(fieldAliases);
  }

  /**
   * Get the alias resolver
   */
  getAliasResolver(): FieldAliasResolver {
    return this.aliasResolver;
  }

  /**
   * Get mapping config for a Calibre field
   */
  getCalibreFieldMapping(field: string): FieldMappingConfig | null {
    if (field in this.schema.standardFields) {
      return this.schema.standardFields[field];
    }
    if (field in this.schema.customColumns) {
      return this.schema.customColumns[field];
    }
    return null;
  }

  /**
   * Get mapping config for an Obsidian path
   */
  getObsidianPathMapping(path: string): { field: string; config: FieldMappingConfig } | null {
    for (const [field, config] of Object.entries(this.schema.standardFields)) {
      if (config.obsidianPath === path) {
        return { field, config };
      }
    }
    for (const [field, config] of Object.entries(this.schema.customColumns)) {
      if (config.obsidianPath === path) {
        return { field, config };
      }
    }
    return null;
  }

  /**
   * Get all fields with a specific sync direction
   */
  getFieldsByDirection(direction: SyncDirection): string[] {
    const fields: string[] = [];

    for (const [field, config] of Object.entries(this.schema.standardFields)) {
      if (config.direction === direction) {
        fields.push(field);
      }
    }
    for (const [field, config] of Object.entries(this.schema.customColumns)) {
      if (config.direction === direction) {
        fields.push(field);
      }
    }

    return fields;
  }

  /**
   * Get all bidirectional fields
   */
  getBidirectionalFields(): string[] {
    return this.getFieldsByDirection('bidirectional');
  }

  /**
   * Transform value for sync direction
   */
  transformValue(
    field: string,
    value: unknown,
    direction: 'toCalibre' | 'toObsidian',
    metadata?: Record<string, unknown>
  ): unknown {
    const mapping = this.getCalibreFieldMapping(field);
    if (!mapping?.transformer) {
      return value;
    }

    const transformer = this.transformers.get(mapping.transformer);
    if (!transformer) {
      console.warn(`Transformer not found: ${mapping.transformer}`);
      return value;
    }

    return transformer(value, direction, metadata);
  }

  /**
   * Check if field is Obsidian-only
   */
  isObsidianOnly(field: string): boolean {
    return this.schema.obsidianOnlyFields.includes(field);
  }

  /**
   * Register a custom transformer
   */
  registerTransformer(name: string, fn: TransformerFunction): void {
    this.transformers.set(name, fn);
  }

  /**
   * Add a custom column mapping
   */
  addCustomColumn(column: string, config: FieldMappingConfig): void {
    this.schema.customColumns[column] = config;
  }

  /**
   * Get all field mappings
   */
  getAllMappings(): Record<string, FieldMappingConfig> {
    return {
      ...this.schema.standardFields,
      ...this.schema.customColumns,
    };
  }

  /**
   * Get conflict strategy for a field
   */
  getConflictStrategy(field: string): FieldConflictStrategy {
    const mapping = this.getCalibreFieldMapping(field);
    return mapping?.conflictStrategy || 'last-write-wins';
  }

  /**
   * Export schema as JSON (for settings)
   */
  exportSchema(): CalibreSchemaMapping {
    return { ...this.schema };
  }

  // ==========================================================================
  // Alias-Aware Frontmatter Operations
  // ==========================================================================

  /**
   * Read a value from frontmatter using alias resolution
   *
   * Checks all aliases for a canonical field and returns the first found value.
   */
  readFromFrontmatter(
    frontmatter: Record<string, unknown>,
    canonicalField: string
  ): { value: unknown; key: string } | null {
    return findAliasedValue(frontmatter, canonicalField, this.aliasResolver);
  }

  /**
   * Write a value to frontmatter using the primary alias
   *
   * Uses the primary alias key for the canonical field.
   */
  writeToFrontmatter(
    frontmatter: Record<string, unknown>,
    canonicalField: string,
    value: unknown
  ): string {
    return setAliasedValue(frontmatter, canonicalField, value, this.aliasResolver);
  }

  /**
   * Clean up redundant alias keys in frontmatter
   *
   * Removes all aliases except the primary key for each field.
   */
  cleanupFrontmatterAliases(
    frontmatter: Record<string, unknown>,
    canonicalField: string
  ): string[] {
    return cleanupAliasKeys(frontmatter, canonicalField, this.aliasResolver);
  }

  /**
   * Get frontmatter key for a canonical field
   *
   * Returns the primary alias or the canonical field itself.
   */
  getFrontmatterKey(canonicalField: string): string {
    return this.aliasResolver.getPrimaryKey(canonicalField) || canonicalField;
  }

  /**
   * Check if a frontmatter key is a known alias
   */
  isKnownFrontmatterKey(key: string): boolean {
    return this.aliasResolver.isKnownAlias(key);
  }

  /**
   * Get all aliases for a canonical field
   */
  getFieldAliases(canonicalField: string): string[] {
    return this.aliasResolver.getAllAliases(canonicalField);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse Obsidian path to get location type and key
 */
export function parseObsidianPath(path: string): {
  location: 'frontmatter' | 'body';
  key: string;
} {
  const parts = path.split('.');
  const location = parts[0] as 'frontmatter' | 'body';
  const key = parts.slice(1).join('.');
  return { location, key };
}

/**
 * Get value from nested object using dot notation
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Set value in nested object using dot notation
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * Create default field mapping manager
 */
export function createFieldMappingManager(
  customSchema?: Partial<CalibreSchemaMapping>,
  fieldAliases?: FieldAlias[]
): FieldMappingManager {
  return new FieldMappingManager(customSchema, fieldAliases);
}

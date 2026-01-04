/**
 * Liquid Template Service
 *
 * Provides Liquid template support for custom rendering of book metadata
 * in Obsidian notes. Supports template registration, field definitions,
 * and custom filters.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type {
  BookMetadata,
  TemplateContext,
  FieldDefinition,
  FieldType,
  Highlight,
  BookNote,
} from './types';

// ============================================================================
// Template Engine (Simplified Liquid-like Implementation)
// ============================================================================

/**
 * Token types for template parsing
 */
type TokenType = 'text' | 'output' | 'tag';

interface Token {
  type: TokenType;
  value: string;
  raw: string;
}

/**
 * Parse a Liquid template into tokens
 */
function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let remaining = template;

  while (remaining.length > 0) {
    // Check for output tag {{ ... }}
    const outputMatch = remaining.match(/^\{\{(.+?)\}\}/s);
    if (outputMatch) {
      tokens.push({
        type: 'output',
        value: outputMatch[1].trim(),
        raw: outputMatch[0],
      });
      remaining = remaining.slice(outputMatch[0].length);
      continue;
    }

    // Check for control tag {% ... %}
    const tagMatch = remaining.match(/^\{%(.+?)%\}/s);
    if (tagMatch) {
      tokens.push({
        type: 'tag',
        value: tagMatch[1].trim(),
        raw: tagMatch[0],
      });
      remaining = remaining.slice(tagMatch[0].length);
      continue;
    }

    // Find next tag
    const nextTag = remaining.search(/\{\{|\{%/);
    if (nextTag === -1) {
      // No more tags, rest is text
      tokens.push({
        type: 'text',
        value: remaining,
        raw: remaining,
      });
      break;
    } else if (nextTag > 0) {
      // Text before next tag
      tokens.push({
        type: 'text',
        value: remaining.slice(0, nextTag),
        raw: remaining.slice(0, nextTag),
      });
      remaining = remaining.slice(nextTag);
    }
  }

  return tokens;
}

/**
 * Resolve a variable path like "book.title" or "book.series.name"
 */
function resolveVariable(path: string, context: Record<string, unknown>): unknown {
  const parts = path.split('.');
  let current: unknown = context;

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
 * Built-in filters for Liquid templates
 */
type FilterFunction = (value: unknown, ...args: string[]) => unknown;

const BUILT_IN_FILTERS: Record<string, FilterFunction> = {
  // String filters
  upcase: (value) => String(value).toUpperCase(),
  downcase: (value) => String(value).toLowerCase(),
  capitalize: (value) => {
    const str = String(value);
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  },
  strip: (value) => String(value).trim(),
  truncate: (value, length = '50') => {
    const str = String(value);
    const len = parseInt(length, 10);
    if (str.length <= len) return str;
    return str.slice(0, len) + '...';
  },
  replace: (value, search, replace) => String(value).replace(new RegExp(search, 'g'), replace),
  remove: (value, substr) => String(value).replace(new RegExp(substr, 'g'), ''),
  append: (value, suffix) => String(value) + suffix,
  prepend: (value, prefix) => prefix + String(value),
  split: (value, delimiter = ' ') => String(value).split(delimiter),
  escape: (value) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),

  // Array filters
  join: (value, delimiter = ', ') => {
    if (!Array.isArray(value)) return String(value);
    return value.join(delimiter);
  },
  first: (value) => {
    if (Array.isArray(value)) return value[0];
    return value;
  },
  last: (value) => {
    if (Array.isArray(value)) return value[value.length - 1];
    return value;
  },
  size: (value) => {
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'string') return value.length;
    return 0;
  },
  sort: (value) => {
    if (!Array.isArray(value)) return value;
    return [...value].sort();
  },
  reverse: (value) => {
    if (!Array.isArray(value)) return value;
    return [...value].reverse();
  },
  uniq: (value) => {
    if (!Array.isArray(value)) return value;
    return [...new Set(value)];
  },
  compact: (value) => {
    if (!Array.isArray(value)) return value;
    return value.filter((v) => v !== null && v !== undefined && v !== '');
  },
  map: (value, property) => {
    if (!Array.isArray(value)) return value;
    return value.map((item) => {
      if (typeof item === 'object' && item !== null) {
        return (item as Record<string, unknown>)[property];
      }
      return item;
    });
  },

  // Number filters
  plus: (value, num) => Number(value) + Number(num),
  minus: (value, num) => Number(value) - Number(num),
  times: (value, num) => Number(value) * Number(num),
  divided_by: (value, num) => Math.floor(Number(value) / Number(num)),
  modulo: (value, num) => Number(value) % Number(num),
  round: (value, digits = '0') => {
    const d = parseInt(digits, 10);
    return Number(Number(value).toFixed(d));
  },
  floor: (value) => Math.floor(Number(value)),
  ceil: (value) => Math.ceil(Number(value)),
  abs: (value) => Math.abs(Number(value)),

  // Date filters
  date: (value, format = '%Y-%m-%d') => {
    const date = value instanceof Date ? value : new Date(String(value));
    if (isNaN(date.getTime())) return String(value);

    return format
      .replace(/%Y/g, String(date.getFullYear()))
      .replace(/%m/g, String(date.getMonth() + 1).padStart(2, '0'))
      .replace(/%d/g, String(date.getDate()).padStart(2, '0'))
      .replace(/%H/g, String(date.getHours()).padStart(2, '0'))
      .replace(/%M/g, String(date.getMinutes()).padStart(2, '0'))
      .replace(/%S/g, String(date.getSeconds()).padStart(2, '0'))
      .replace(/%b/g, date.toLocaleString('en', { month: 'short' }))
      .replace(/%B/g, date.toLocaleString('en', { month: 'long' }));
  },

  // Default filter
  default: (value, defaultValue) => {
    if (value === null || value === undefined || value === '' || value === false) {
      return defaultValue;
    }
    return value;
  },
};

/**
 * Apply filters to a value
 */
function applyFilters(
  value: unknown,
  filterChain: string,
  customFilters: Record<string, FilterFunction>
): unknown {
  const filters = { ...BUILT_IN_FILTERS, ...customFilters };
  let result = value;

  // Parse filter chain: "filter1: arg1, arg2 | filter2: arg"
  const filterParts = filterChain.split('|').map((f) => f.trim());

  for (const filterPart of filterParts) {
    if (!filterPart) continue;

    // Parse filter name and arguments
    const colonIndex = filterPart.indexOf(':');
    let filterName: string;
    let args: string[] = [];

    if (colonIndex === -1) {
      filterName = filterPart.trim();
    } else {
      filterName = filterPart.slice(0, colonIndex).trim();
      const argsStr = filterPart.slice(colonIndex + 1).trim();
      // Split by comma, but respect quoted strings
      args = argsStr.match(/(?:[^,"]|"[^"]*")+/g)?.map((a) => a.trim().replace(/^"|"$/g, '')) || [];
    }

    const filter = filters[filterName];
    if (filter) {
      result = filter(result, ...args);
    }
  }

  return result;
}

/**
 * Evaluate an expression (variable with optional filters)
 */
function evaluateExpression(
  expression: string,
  context: Record<string, unknown>,
  customFilters: Record<string, FilterFunction>
): unknown {
  // Split by | to separate variable from filters
  const pipeIndex = expression.indexOf('|');
  let varPath: string;
  let filterChain = '';

  if (pipeIndex === -1) {
    varPath = expression.trim();
  } else {
    varPath = expression.slice(0, pipeIndex).trim();
    filterChain = expression.slice(pipeIndex + 1);
  }

  // Resolve variable
  let value = resolveVariable(varPath, context);

  // Apply filters
  if (filterChain) {
    value = applyFilters(value, filterChain, customFilters);
  }

  return value;
}

/**
 * Evaluate a condition for if/unless tags
 */
function evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
  // Handle comparison operators
  const comparisons = [
    { op: '==', fn: (a: unknown, b: unknown) => a === b },
    { op: '!=', fn: (a: unknown, b: unknown) => a !== b },
    { op: '>=', fn: (a: unknown, b: unknown) => Number(a) >= Number(b) },
    { op: '<=', fn: (a: unknown, b: unknown) => Number(a) <= Number(b) },
    { op: '>', fn: (a: unknown, b: unknown) => Number(a) > Number(b) },
    { op: '<', fn: (a: unknown, b: unknown) => Number(a) < Number(b) },
    { op: 'contains', fn: (a: unknown, b: unknown) => String(a).includes(String(b)) },
  ];

  for (const { op, fn } of comparisons) {
    const parts = condition.split(new RegExp(`\\s+${op}\\s+`));
    if (parts.length === 2) {
      const left = evaluateExpression(parts[0], context, {});
      const right = parts[1].trim().replace(/^['"]|['"]$/g, '');
      return fn(left, right);
    }
  }

  // Simple truthy check
  const value = resolveVariable(condition.trim(), context);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  return Boolean(value);
}

// ============================================================================
// Template Rendering Engine
// ============================================================================

/**
 * Render a Liquid template with context
 */
function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  customFilters: Record<string, FilterFunction> = {}
): string {
  const tokens = tokenize(template);
  let output = '';
  let i = 0;

  // Stack for nested blocks (if/for)
  const blockStack: Array<{
    type: 'if' | 'for' | 'unless';
    active: boolean;
    loopVar?: string;
    loopItems?: unknown[];
    loopIndex?: number;
    startIndex: number;
  }> = [];

  while (i < tokens.length) {
    const token = tokens[i];

    // Check if we're in an inactive block
    const currentBlock = blockStack[blockStack.length - 1];
    const isActive = !currentBlock || currentBlock.active;

    if (token.type === 'text') {
      if (isActive) {
        output += token.value;
      }
      i++;
      continue;
    }

    if (token.type === 'output') {
      if (isActive) {
        const value = evaluateExpression(token.value, context, customFilters);
        output += value !== undefined && value !== null ? String(value) : '';
      }
      i++;
      continue;
    }

    // Handle control tags
    const tagValue = token.value;

    // IF tag
    if (tagValue.startsWith('if ')) {
      const condition = tagValue.slice(3).trim();
      const active = isActive && evaluateCondition(condition, context);
      blockStack.push({ type: 'if', active, startIndex: i });
      i++;
      continue;
    }

    // UNLESS tag
    if (tagValue.startsWith('unless ')) {
      const condition = tagValue.slice(7).trim();
      const active = isActive && !evaluateCondition(condition, context);
      blockStack.push({ type: 'unless', active, startIndex: i });
      i++;
      continue;
    }

    // ELSIF tag
    if (tagValue.startsWith('elsif ')) {
      const block = blockStack[blockStack.length - 1];
      if (block && block.type === 'if') {
        if (!block.active && isActive) {
          const condition = tagValue.slice(6).trim();
          block.active = evaluateCondition(condition, context);
        } else {
          block.active = false;
        }
      }
      i++;
      continue;
    }

    // ELSE tag
    if (tagValue === 'else') {
      const block = blockStack[blockStack.length - 1];
      if (block && (block.type === 'if' || block.type === 'unless')) {
        // Only activate if parent is active and this block wasn't
        const parentActive = blockStack.length <= 1 || blockStack[blockStack.length - 2].active;
        block.active = parentActive && !block.active;
      }
      i++;
      continue;
    }

    // ENDIF tag
    if (tagValue === 'endif' || tagValue === 'endunless') {
      blockStack.pop();
      i++;
      continue;
    }

    // FOR tag
    if (tagValue.startsWith('for ')) {
      // Parse: for item in collection
      const match = tagValue.match(/^for\s+(\w+)\s+in\s+(.+)$/);
      if (match && isActive) {
        const [, loopVar, collectionExpr] = match;
        const collection = evaluateExpression(collectionExpr.trim(), context, customFilters);
        const items = Array.isArray(collection) ? collection : [];

        if (items.length > 0) {
          blockStack.push({
            type: 'for',
            active: true,
            loopVar,
            loopItems: items,
            loopIndex: 0,
            startIndex: i,
          });
          // Set loop variable in context
          (context as Record<string, unknown>)[loopVar] = items[0];
          (context as Record<string, unknown>)['forloop'] = {
            index: 1,
            index0: 0,
            first: true,
            last: items.length === 1,
            length: items.length,
          };
        } else {
          blockStack.push({ type: 'for', active: false, startIndex: i });
        }
      } else {
        blockStack.push({ type: 'for', active: false, startIndex: i });
      }
      i++;
      continue;
    }

    // ENDFOR tag
    if (tagValue === 'endfor') {
      const block = blockStack[blockStack.length - 1];
      if (block && block.type === 'for' && block.active && block.loopItems) {
        const nextIndex = (block.loopIndex || 0) + 1;
        if (nextIndex < block.loopItems.length) {
          // Continue loop
          block.loopIndex = nextIndex;
          (context as Record<string, unknown>)[block.loopVar!] = block.loopItems[nextIndex];
          (context as Record<string, unknown>)['forloop'] = {
            index: nextIndex + 1,
            index0: nextIndex,
            first: false,
            last: nextIndex === block.loopItems.length - 1,
            length: block.loopItems.length,
          };
          i = block.startIndex + 1; // Jump back to start of loop
          continue;
        }
      }
      blockStack.pop();
      i++;
      continue;
    }

    // Unrecognized tag, skip
    i++;
  }

  return output;
}

// ============================================================================
// Field Definitions
// ============================================================================

/**
 * Available fields for templates
 */
const FIELD_DEFINITIONS: FieldDefinition[] = [
  // Identity fields
  { name: 'book.title', label: 'Title', type: 'string', description: 'Book title', example: 'The Great Gatsby', isArray: false },
  { name: 'book.authors', label: 'Authors', type: 'array', description: 'List of authors', example: ['F. Scott Fitzgerald'], isArray: true },
  { name: 'book.bookId', label: 'Book ID', type: 'string', description: 'Unique book identifier', example: 'abc123', isArray: false },
  { name: 'book.calibreId', label: 'Calibre ID', type: 'number', description: 'Calibre database ID', example: 42, isArray: false },
  { name: 'book.uuid', label: 'UUID', type: 'string', description: 'Calibre UUID', example: 'abc-123-def', isArray: false },

  // Reading state
  { name: 'book.progress', label: 'Progress', type: 'number', description: 'Reading progress (0-100)', example: 75, isArray: false },
  { name: 'book.currentCfi', label: 'Current CFI', type: 'string', description: 'Current reading position', example: 'epubcfi(/6/4!/4)', isArray: false },
  { name: 'book.status', label: 'Status', type: 'string', description: 'Reading status', example: 'reading', isArray: false },
  { name: 'book.lastReadAt', label: 'Last Read', type: 'date', description: 'When last read', example: new Date(), isArray: false },

  // User metadata
  { name: 'book.rating', label: 'Rating', type: 'number', description: 'User rating (0-5)', example: 4, isArray: false },
  { name: 'book.tags', label: 'Tags', type: 'array', description: 'User tags', example: ['fiction', 'classic'], isArray: true },
  { name: 'book.bookshelves', label: 'Bookshelves', type: 'array', description: 'Bookshelf assignments', example: ['favorites'], isArray: true },

  // Calibre metadata
  { name: 'book.series.name', label: 'Series Name', type: 'string', description: 'Series name', example: 'The Expanse', isArray: false },
  { name: 'book.series.index', label: 'Series Index', type: 'number', description: 'Position in series', example: 3, isArray: false },
  { name: 'book.publisher', label: 'Publisher', type: 'string', description: 'Publisher name', example: 'Penguin', isArray: false },
  { name: 'book.publishedDate', label: 'Published Date', type: 'string', description: 'Publication date', example: '2020-01-15', isArray: false },
  { name: 'book.description', label: 'Description', type: 'string', description: 'Book description/blurb', example: 'A story about...', isArray: false },

  // Annotations
  { name: 'book.highlights', label: 'Highlights', type: 'array', description: 'List of highlights', example: [], isArray: true },
  { name: 'book.notes', label: 'Notes', type: 'array', description: 'List of notes', example: [], isArray: true },
  { name: 'book.bookmarks', label: 'Bookmarks', type: 'array', description: 'List of bookmarks', example: [], isArray: true },

  // Highlight fields (for use in loops)
  { name: 'highlight.text', label: 'Highlight Text', type: 'string', description: 'Highlighted text', example: 'Important quote', isArray: false },
  { name: 'highlight.note', label: 'Highlight Note', type: 'string', description: 'Note attached to highlight', example: 'Review this', isArray: false },
  { name: 'highlight.color', label: 'Highlight Color', type: 'string', description: 'Highlight color', example: 'yellow', isArray: false },
  { name: 'highlight.chapter', label: 'Highlight Chapter', type: 'string', description: 'Chapter name', example: 'Chapter 1', isArray: false },
  { name: 'highlight.createdAt', label: 'Highlight Date', type: 'date', description: 'When created', example: new Date(), isArray: false },

  // Settings
  { name: 'settings.authorsFolder', label: 'Authors Folder', type: 'string', description: 'Folder for author notes', example: 'Autores', isArray: false },
  { name: 'settings.seriesFolder', label: 'Series Folder', type: 'string', description: 'Folder for series notes', example: 'Series', isArray: false },
  { name: 'settings.bookshelvesFolder', label: 'Bookshelves Folder', type: 'string', description: 'Folder for bookshelf notes', example: 'Estanterias', isArray: false },

  // Calibre-specific
  { name: 'calibre.id', label: 'Calibre ID', type: 'number', description: 'Calibre database ID', example: 42, isArray: false },
  { name: 'calibre.formats', label: 'Formats', type: 'array', description: 'Available file formats', example: ['EPUB', 'PDF'], isArray: true },
  { name: 'calibre.coverPath', label: 'Cover Path', type: 'string', description: 'Path to cover image', example: 'covers/book.jpg', isArray: false },
];

// ============================================================================
// Liquid Template Service
// ============================================================================

/**
 * Default book note template
 */
const DEFAULT_BOOK_TEMPLATE = `---
title: {{ book.title }}
author: {{ book.authors | join: ", " }}
{% if book.rating %}rating: {{ book.rating }}{% endif %}
{% if book.series %}
series: "[[{{ settings.seriesFolder }}/{{ book.series.name }}|{{ book.series.name }}]]"
seriesIndex: {{ book.series.index }}
{% endif %}
{% if book.tags.size > 0 %}
bookshelves:
{% for tag in book.tags %}
  - "[[{{ settings.bookshelvesFolder }}/{{ tag }}|{{ tag }}]]"
{% endfor %}
{% endif %}
progress: {{ book.progress | default: 0 }}%
status: {{ book.status | default: "unread" }}
{% if book.lastReadAt %}lastRead: {{ book.lastReadAt | date: "%Y-%m-%d" }}{% endif %}
calibreId: {{ book.calibreId }}
---

# {{ book.title }}

{% if book.description %}
## Description

{{ book.description }}
{% endif %}

{% if book.highlights.size > 0 %}
## Highlights

{% for h in book.highlights %}
> {{ h.text }}
{% if h.note %}> — *{{ h.note }}*{% endif %} ({{ h.createdAt | date: "%b %d, %Y" }})

{% endfor %}
{% endif %}

{% if book.notes.size > 0 %}
## Notes

{% for n in book.notes %}
### {{ n.chapter | default: "General" }}

{{ n.content }}

{% endfor %}
{% endif %}
`;

/**
 * Service for rendering book metadata using Liquid templates
 */
export class LiquidTemplateService {
  private templates: Map<string, string>;
  private customFilters: Record<string, FilterFunction>;

  constructor() {
    this.templates = new Map();
    this.customFilters = {};

    // Register default template
    this.registerTemplate('default', DEFAULT_BOOK_TEMPLATE);

    // Register custom filters for Obsidian
    this.registerFilter('wikilink', (value, folder) => {
      const text = String(value);
      if (folder) {
        return `[[${folder}/${text}|${text}]]`;
      }
      return `[[${text}]]`;
    });

    this.registerFilter('slugify', (value) => {
      return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    });

    this.registerFilter('stars', (value) => {
      const rating = Math.round(Number(value));
      return '★'.repeat(rating) + '☆'.repeat(5 - rating);
    });
  }

  // ==========================================================================
  // Template Management
  // ==========================================================================

  /**
   * Register a named template
   */
  registerTemplate(name: string, template: string): void {
    this.templates.set(name, template);
  }

  /**
   * Get a registered template
   */
  getTemplate(name: string): string | null {
    return this.templates.get(name) || null;
  }

  /**
   * Delete a registered template
   */
  deleteTemplate(name: string): boolean {
    return this.templates.delete(name);
  }

  /**
   * List all registered template names
   */
  listTemplates(): string[] {
    return Array.from(this.templates.keys());
  }

  // ==========================================================================
  // Custom Filters
  // ==========================================================================

  /**
   * Register a custom filter
   */
  registerFilter(name: string, fn: FilterFunction): void {
    this.customFilters[name] = fn;
  }

  /**
   * Get all available filters (built-in + custom)
   */
  getAvailableFilters(): string[] {
    return [...Object.keys(BUILT_IN_FILTERS), ...Object.keys(this.customFilters)];
  }

  // ==========================================================================
  // Rendering
  // ==========================================================================

  /**
   * Render a book note using a template
   */
  renderBookNote(book: BookMetadata, templateName?: string): string {
    const template = templateName
      ? this.templates.get(templateName) || DEFAULT_BOOK_TEMPLATE
      : DEFAULT_BOOK_TEMPLATE;

    const context = this.buildContext(book);
    return renderTemplate(template, context as unknown as Record<string, unknown>, this.customFilters);
  }

  /**
   * Render with custom template string
   */
  renderWithTemplate(book: BookMetadata, template: string): string {
    const context = this.buildContext(book);
    return renderTemplate(template, context as unknown as Record<string, unknown>, this.customFilters);
  }

  /**
   * Render a single field
   */
  renderField(field: string, value: unknown, template?: string): string {
    if (!template) {
      // Default rendering based on type
      if (Array.isArray(value)) {
        return value.map(String).join(', ');
      }
      if (value instanceof Date) {
        return value.toISOString().split('T')[0];
      }
      return String(value ?? '');
    }

    const context = { value };
    return renderTemplate(template, context, this.customFilters);
  }

  /**
   * Render highlights section
   */
  renderHighlights(highlights: Highlight[], template?: string): string {
    const defaultTemplate = `{% for h in highlights %}
> {{ h.text }}
{% if h.note %}> — *{{ h.note }}*{% endif %}

{% endfor %}`;

    return renderTemplate(template || defaultTemplate, { highlights }, this.customFilters);
  }

  /**
   * Render notes section
   */
  renderNotes(notes: BookNote[], template?: string): string {
    const defaultTemplate = `{% for n in notes %}
### {{ n.chapter | default: "Note" }}

{{ n.content }}

{% endfor %}`;

    return renderTemplate(template || defaultTemplate, { notes }, this.customFilters);
  }

  // ==========================================================================
  // Schema Access
  // ==========================================================================

  /**
   * Get available fields for template editor
   */
  getAvailableFields(): FieldDefinition[] {
    return [...FIELD_DEFINITIONS];
  }

  /**
   * Get field type by name
   */
  getFieldType(field: string): FieldType | null {
    const def = FIELD_DEFINITIONS.find((f) => f.name === field);
    return def?.type || null;
  }

  /**
   * Get field definition
   */
  getFieldDefinition(field: string): FieldDefinition | null {
    return FIELD_DEFINITIONS.find((f) => f.name === field) || null;
  }

  // ==========================================================================
  // Context Building
  // ==========================================================================

  /**
   * Build template context from book metadata
   * @deprecated Use NunjucksTemplateService instead
   */
  private buildContext(book: BookMetadata): TemplateContext {
    return {
      book,
      highlights: book.highlights || [],
      notes: book.notes || [],
      calibre: book.calibreId
        ? {
            id: book.calibreId,
            formats: [], // Would be populated from Calibre
            coverPath: undefined,
          }
        : undefined,
      settings: {
        authorsFolder: 'Authors',
        seriesFolder: 'Series',
        bookshelvesFolder: 'Shelves',
      },
      helpers: {
        formatDate: (date: Date, format: string) => {
          return String(BUILT_IN_FILTERS.date(date, format));
        },
        wikilink: (text: string, folder?: string) => {
          if (folder) {
            return `[[${folder}/${text}|${text}]]`;
          }
          return `[[${text}]]`;
        },
        slugify: (text: string) => {
          return text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
        },
      },
    };
  }

  // ==========================================================================
  // Template Validation
  // ==========================================================================

  /**
   * Validate a template for syntax errors
   */
  validateTemplate(template: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    try {
      // Check for balanced tags
      const ifCount = (template.match(/\{%\s*if\s/g) || []).length;
      const endifCount = (template.match(/\{%\s*endif\s*%\}/g) || []).length;
      if (ifCount !== endifCount) {
        errors.push(`Unbalanced if/endif: ${ifCount} if, ${endifCount} endif`);
      }

      const forCount = (template.match(/\{%\s*for\s/g) || []).length;
      const endforCount = (template.match(/\{%\s*endfor\s*%\}/g) || []).length;
      if (forCount !== endforCount) {
        errors.push(`Unbalanced for/endfor: ${forCount} for, ${endforCount} endfor`);
      }

      const unlessCount = (template.match(/\{%\s*unless\s/g) || []).length;
      const endunlessCount = (template.match(/\{%\s*endunless\s*%\}/g) || []).length;
      if (unlessCount !== endunlessCount) {
        errors.push(`Unbalanced unless/endunless: ${unlessCount} unless, ${endunlessCount} endunless`);
      }

      // Try to tokenize
      tokenize(template);

      // Try a test render with mock data
      const mockBook: BookMetadata = {
        bookId: 'test',
        title: 'Test Book',
        authors: ['Test Author'],
        progress: 50,
        status: 'reading',
        highlights: [],
        notes: [],
        bookmarks: [],
        tags: ['test'],
        bookshelves: [],
        timestamps: {},
      };

      this.renderWithTemplate(mockBook, template);
    } catch (e) {
      errors.push(`Parse error: ${e instanceof Error ? e.message : String(e)}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new Liquid template service instance
 */
export function createLiquidTemplateService(): LiquidTemplateService {
  return new LiquidTemplateService();
}

/**
 * Export default template for reference
 */
export { DEFAULT_BOOK_TEMPLATE };

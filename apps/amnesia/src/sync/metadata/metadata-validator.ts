/**
 * Metadata Validator
 *
 * Validates book metadata with field-level rules and cross-field consistency checks.
 * Provides auto-fix suggestions for common issues.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type {
  BookMetadata,
  ValidationResult,
  ConsistencyResult,
  ValidationIssue,
  Highlight,
  FieldType,
} from './types';

// ============================================================================
// Validation Rules
// ============================================================================

/**
 * Validation rule for a field
 */
export interface ValidationRule {
  /** Field type */
  type: FieldType;
  /** Minimum value (for numbers) */
  min?: number;
  /** Maximum value (for numbers) */
  max?: number;
  /** Regex pattern (for strings) */
  pattern?: RegExp;
  /** Is field required */
  required?: boolean;
  /** Default value */
  default?: unknown;
  /** Maximum array items */
  maxItems?: number;
  /** Custom validator function */
  validator?: (value: unknown) => boolean;
  /** Error message */
  errorMessage?: string;
}

/**
 * Built-in validation rules
 */
export const VALIDATION_RULES: Record<string, ValidationRule> = {
  progress: {
    type: 'number',
    min: 0,
    max: 100,
    required: false,
    default: 0,
    errorMessage: 'Progress must be between 0 and 100',
  },
  rating: {
    type: 'number',
    min: 0,
    max: 5,
    required: false,
    default: null,
    errorMessage: 'Rating must be between 0 and 5',
  },
  currentCfi: {
    type: 'string',
    pattern: /^epubcfi\(.+\)$/,
    required: false,
    errorMessage: 'CFI must be in epubcfi() format',
  },
  title: {
    type: 'string',
    required: true,
    errorMessage: 'Title is required',
  },
  authors: {
    type: 'array',
    required: false,
    maxItems: 100,
    errorMessage: 'Authors must be an array',
  },
  tags: {
    type: 'array',
    required: false,
    maxItems: 1000,
    errorMessage: 'Tags must be an array',
  },
  highlights: {
    type: 'array',
    required: false,
    maxItems: 10000,
    validator: (value) => {
      if (!Array.isArray(value)) return false;
      return value.every((h) => h && typeof h.cfiRange === 'string' && typeof h.text === 'string');
    },
    errorMessage: 'Highlights must have cfiRange and text',
  },
  status: {
    type: 'string',
    validator: (value) =>
      ['unread', 'reading', 'completed', 'abandoned', 'on-hold'].includes(value as string),
    default: 'unread',
    errorMessage: 'Invalid reading status',
  },
};

// ============================================================================
// Metadata Validator
// ============================================================================

/**
 * Validates book metadata
 */
export class MetadataValidator {
  private rules: Map<string, ValidationRule>;

  constructor(customRules?: Record<string, ValidationRule>) {
    this.rules = new Map(Object.entries(VALIDATION_RULES));

    if (customRules) {
      for (const [field, rule] of Object.entries(customRules)) {
        this.rules.set(field, rule);
      }
    }
  }

  // ==========================================================================
  // Field Validation
  // ==========================================================================

  /**
   * Validate a single field value
   */
  validateField(field: string, value: unknown): ValidationResult {
    const rule = this.rules.get(field);

    if (!rule) {
      // No rule defined, accept any value
      return { valid: true };
    }

    // Check required
    if (rule.required && (value === null || value === undefined || value === '')) {
      return {
        valid: false,
        error: rule.errorMessage || `${field} is required`,
        suggestion: rule.default,
      };
    }

    // Allow null/undefined for optional fields
    if (value === null || value === undefined) {
      return { valid: true };
    }

    // Type checking
    if (!this.checkType(value, rule.type)) {
      return {
        valid: false,
        error: rule.errorMessage || `${field} must be of type ${rule.type}`,
        suggestion: rule.default,
      };
    }

    // Range checking for numbers
    if (rule.type === 'number' && typeof value === 'number') {
      if (rule.min !== undefined && value < rule.min) {
        return {
          valid: false,
          error: rule.errorMessage || `${field} must be at least ${rule.min}`,
          suggestion: rule.min,
        };
      }
      if (rule.max !== undefined && value > rule.max) {
        return {
          valid: false,
          error: rule.errorMessage || `${field} must be at most ${rule.max}`,
          suggestion: rule.max,
        };
      }
    }

    // Pattern checking for strings
    if (rule.type === 'string' && typeof value === 'string' && rule.pattern) {
      if (!rule.pattern.test(value)) {
        return {
          valid: false,
          error: rule.errorMessage || `${field} has invalid format`,
        };
      }
    }

    // Array length checking
    if (rule.type === 'array' && Array.isArray(value)) {
      if (rule.maxItems !== undefined && value.length > rule.maxItems) {
        return {
          valid: false,
          error: rule.errorMessage || `${field} has too many items (max: ${rule.maxItems})`,
          suggestion: value.slice(0, rule.maxItems),
        };
      }
    }

    // Custom validator
    if (rule.validator && !rule.validator(value)) {
      return {
        valid: false,
        error: rule.errorMessage || `${field} failed validation`,
        suggestion: rule.default,
      };
    }

    return { valid: true };
  }

  /**
   * Check if value matches expected type
   */
  private checkType(value: unknown, type: FieldType): boolean {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'date':
        return value instanceof Date || (typeof value === 'string' && !isNaN(Date.parse(value)));
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      default:
        return true;
    }
  }

  // ==========================================================================
  // Cross-Field Validation
  // ==========================================================================

  /**
   * Check consistency across fields
   */
  validateConsistency(metadata: BookMetadata): ConsistencyResult {
    const issues: ValidationIssue[] = [];

    // Check progress-CFI consistency
    if (!this.checkProgressConsistency(metadata.progress, metadata.currentCfi)) {
      issues.push({
        field: 'progress',
        issue: 'inconsistent',
        currentValue: metadata.progress,
        expectedValue: undefined,
        autoFixable: false,
      });
    }

    // Check highlight ranges
    if (!this.checkHighlightRanges(metadata.highlights)) {
      issues.push({
        field: 'highlights',
        issue: 'invalid-format',
        currentValue: metadata.highlights.length,
        autoFixable: true,
      });
    }

    // Check timestamp order
    if (!this.checkTimestampOrder(metadata.timestamps)) {
      issues.push({
        field: 'timestamps',
        issue: 'inconsistent',
        currentValue: metadata.timestamps,
        autoFixable: true,
      });
    }

    // Check for empty required fields
    if (!metadata.title || metadata.title.trim() === '') {
      issues.push({
        field: 'title',
        issue: 'empty-value',
        currentValue: metadata.title,
        autoFixable: false,
      });
    }

    // Check status matches progress
    if (metadata.progress === 100 && metadata.status !== 'completed') {
      issues.push({
        field: 'status',
        issue: 'inconsistent',
        currentValue: metadata.status,
        expectedValue: 'completed',
        autoFixable: true,
      });
    }

    return {
      consistent: issues.length === 0,
      issues,
    };
  }

  /**
   * Check if progress and CFI are consistent
   *
   * For example, 100% progress should have CFI near end of book
   */
  checkProgressConsistency(progress: number, cfi?: string): boolean {
    if (progress === undefined || cfi === undefined) {
      return true; // Can't check without both values
    }

    // Basic sanity check: if progress is 100%, CFI should exist
    if (progress === 100 && !cfi) {
      return false;
    }

    // If progress is 0, CFI should be at beginning or not set
    // This is a soft check - we can't fully validate CFI position without book content
    return true;
  }

  /**
   * Check if highlight CFI ranges are valid
   */
  checkHighlightRanges(highlights: Highlight[]): boolean {
    if (!highlights || !Array.isArray(highlights)) {
      return true;
    }

    for (const highlight of highlights) {
      if (!highlight.cfiRange) {
        return false;
      }

      // Check CFI format (basic check)
      if (!highlight.cfiRange.startsWith('epubcfi(')) {
        // Allow simple CFI paths too
        if (!highlight.cfiRange.match(/^\/\d+/)) {
          return false;
        }
      }

      // Check required fields
      if (!highlight.text || highlight.text.trim() === '') {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if timestamps are in logical order
   */
  checkTimestampOrder(timestamps: BookMetadata['timestamps']): boolean {
    if (!timestamps) {
      return true;
    }

    // All timestamps should be in the past
    const now = new Date();
    for (const [, value] of Object.entries(timestamps)) {
      if (value instanceof Date && value > now) {
        return false;
      }
    }

    return true;
  }

  // ==========================================================================
  // Auto-Fix
  // ==========================================================================

  /**
   * Auto-fix common issues in metadata
   */
  autoFixIssues(
    metadata: BookMetadata,
    issues: ValidationIssue[]
  ): BookMetadata {
    const fixed = { ...metadata };

    for (const issue of issues) {
      if (!issue.autoFixable) {
        continue;
      }

      switch (issue.field) {
        case 'progress':
          if (issue.issue === 'out-of-range') {
            fixed.progress = Math.max(0, Math.min(100, metadata.progress));
          }
          break;

        case 'rating':
          if (issue.issue === 'out-of-range') {
            if (metadata.rating !== undefined) {
              if (metadata.rating < 0) {
                fixed.rating = undefined;
              } else if (metadata.rating > 5) {
                fixed.rating = 5;
              }
            }
          }
          break;

        case 'highlights':
          if (issue.issue === 'invalid-format') {
            fixed.highlights = metadata.highlights.filter(
              (h) => h.cfiRange && h.text && h.text.trim() !== ''
            );
          }
          break;

        case 'status':
          if (issue.issue === 'inconsistent' && issue.expectedValue) {
            fixed.status = issue.expectedValue as BookMetadata['status'];
          }
          break;

        case 'timestamps':
          if (issue.issue === 'inconsistent') {
            const now = new Date();
            fixed.timestamps = { ...metadata.timestamps };
            for (const [key, value] of Object.entries(fixed.timestamps)) {
              if (value instanceof Date && value > now) {
                (fixed.timestamps as Record<string, Date>)[key] = now;
              }
            }
          }
          break;
      }
    }

    return fixed;
  }

  // ==========================================================================
  // Full Validation
  // ==========================================================================

  /**
   * Validate entire metadata object
   */
  validateMetadata(metadata: BookMetadata): {
    valid: boolean;
    fieldErrors: Record<string, ValidationResult>;
    consistency: ConsistencyResult;
  } {
    const fieldErrors: Record<string, ValidationResult> = {};
    let allValid = true;

    // Validate each field
    for (const [field] of this.rules) {
      const value = (metadata as unknown as Record<string, unknown>)[field];
      const result = this.validateField(field, value);
      if (!result.valid) {
        fieldErrors[field] = result;
        allValid = false;
      }
    }

    // Check consistency
    const consistency = this.validateConsistency(metadata);
    if (!consistency.consistent) {
      allValid = false;
    }

    return {
      valid: allValid,
      fieldErrors,
      consistency,
    };
  }

  /**
   * Register a custom validation rule
   */
  registerRule(field: string, rule: ValidationRule): void {
    this.rules.set(field, rule);
  }

  /**
   * Get validation rule for a field
   */
  getRule(field: string): ValidationRule | undefined {
    return this.rules.get(field);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a metadata validator with optional custom rules
 */
export function createMetadataValidator(
  customRules?: Record<string, ValidationRule>
): MetadataValidator {
  return new MetadataValidator(customRules);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sanitize metadata for storage
 *
 * Removes invalid values and applies defaults
 */
export function sanitizeMetadata(metadata: Partial<BookMetadata>): Partial<BookMetadata> {
  const sanitized: Partial<BookMetadata> = { ...metadata };

  // Clamp progress
  if (sanitized.progress !== undefined) {
    sanitized.progress = Math.max(0, Math.min(100, sanitized.progress));
  }

  // Clamp rating
  if (sanitized.rating !== undefined) {
    if (sanitized.rating < 0 || sanitized.rating > 5) {
      sanitized.rating = undefined;
    }
  }

  // Filter invalid highlights
  if (sanitized.highlights) {
    sanitized.highlights = sanitized.highlights.filter(
      (h) => h.cfiRange && h.text && h.text.trim() !== ''
    );
  }

  // Ensure arrays are arrays
  if (sanitized.tags && !Array.isArray(sanitized.tags)) {
    sanitized.tags = [];
  }
  if (sanitized.authors && !Array.isArray(sanitized.authors)) {
    sanitized.authors = [];
  }
  if (sanitized.bookshelves && !Array.isArray(sanitized.bookshelves)) {
    sanitized.bookshelves = [];
  }

  return sanitized;
}

/**
 * Merge two metadata objects with validation
 */
export function mergeMetadata(
  base: BookMetadata,
  updates: Partial<BookMetadata>,
  validator?: MetadataValidator
): BookMetadata {
  const merged = {
    ...base,
    ...updates,
    timestamps: {
      ...base.timestamps,
      ...updates.timestamps,
    },
  };

  if (validator) {
    const { consistency } = validator.validateMetadata(merged);
    if (!consistency.consistent) {
      const autoFixableIssues = consistency.issues.filter((i) => i.autoFixable);
      return validator.autoFixIssues(merged, autoFixableIssues);
    }
  }

  return merged;
}

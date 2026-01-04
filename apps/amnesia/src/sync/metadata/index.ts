/**
 * Metadata Sync Module
 *
 * Exports all metadata synchronization functionality including:
 * - Field mapping between Calibre and Obsidian
 * - Metadata validation and auto-fix
 * - Recovery service for preserving metadata on book removal
 * - Calibre bidirectional sync
 * - Liquid template rendering
 * - Core metadata sync service
 */

// Types
export * from './types';

// Field mapping
export {
  DEFAULT_SCHEMA_MAPPING,
  BUILT_IN_TRANSFORMERS,
  FieldMappingManager,
  createFieldMappingManager,
  parseObsidianPath,
  getNestedValue,
  setNestedValue,
  wikilinkTransformer,
  dateTransformer,
  ratingTransformer,
  lowercaseTransformer,
  coverPathTransformer,
} from './field-mapping';

// Metadata validator
export {
  VALIDATION_RULES,
  MetadataValidator,
  createMetadataValidator,
  sanitizeMetadata,
  mergeMetadata,
  type ValidationRule,
} from './metadata-validator';

// Recovery service
export {
  MetadataRecoveryService,
  createRecoveryService,
} from './recovery-service';

// Calibre bidirectional sync
export {
  CalibreBidirectionalSync,
  createCalibreBidirectionalSync,
} from './calibre-bidirectional';

// Liquid template service
export {
  LiquidTemplateService,
  createLiquidTemplateService,
  DEFAULT_BOOK_TEMPLATE,
} from './liquid-template-service';

// Metadata sync service
export {
  MetadataSyncService,
  createMetadataSyncService,
  type MetadataStore,
  type CalibreClient,
  type CalibreBook,
  type ObsidianNote,
  type ObsidianVault,
  type ServerClient,
  type MetadataSyncServiceConfig,
  type MetadataSyncEvent,
} from './metadata-sync-service';

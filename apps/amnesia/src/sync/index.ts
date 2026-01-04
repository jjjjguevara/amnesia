/**
 * Unified Sync Module
 *
 * Exports all sync-related functionality.
 */

// Core types
export * from './types';

// Adapter interface and base class
export * from './sync-adapter';

// Concrete adapters
export * from './adapters';

// Checkpoint manager
export * from './checkpoint-manager';

// Delta tracking and change detection
export * from './delta-tracker';
export * from './manifest-differ';

// Parallel execution and rate limiting
export * from './parallel-executor';
export * from './rate-limiter';

// Storage
export * from './storage';

// Metadata sync
export * from './metadata';

// Conflict resolution
export * from './conflict-resolution-manager';

// Main engine
export { UnifiedSyncEngine, type EngineInitOptions } from './unified-sync-engine';

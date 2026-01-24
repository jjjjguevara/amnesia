/**
 * Re-export ZoomOrchestrator as ZoomStateMachine for compatibility.
 *
 * @deprecated ZoomOrchestrator/ZoomStateMachine is deprecated.
 * Use ZoomStateManager for new code (amnesia-l0r tracks full migration).
 *
 * Note: The actual implementation is in zoom-orchestrator.ts.
 * This file exists to maintain backward compatibility with existing imports.
 * New code should use ZoomStateManager directly.
 */

export { ZoomOrchestrator as ZoomStateMachine } from './zoom-orchestrator';

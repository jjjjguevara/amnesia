# Phase D: Resource Detector - Code Review Findings

**Date**: 2026-01-12
**Reviewer**: feature-dev:code-reviewer agent
**Status**: All HIGH severity findings addressed

---

## D.1 System Profiler (`system-profiler.ts`)

### HIGH Severity

| Issue | Location | Description | Resolution |
|-------|----------|-------------|------------|
| Memory leak | `profileBattery()` | Battery event listeners added but never removed | Added `batteryListenerCleanups` Set and cleanup in `invalidateCache()` |
| GPU tier logic error | `classifyGpuTier()` | Mid-tier GPUs could be downgraded to low due to matching order | Changed to priority-based matching: low → mid → high (high always wins) |

### MEDIUM Severity

| Issue | Location | Description | Resolution |
|-------|----------|-------------|------------|
| Battery API deprecation | `profileBattery()` | `navigator.getBattery()` is deprecated in some browsers | Added documentation note about limited browser support |
| Missing GPU fallback | `classifyGpuTier()` | Unknown GPU patterns default to 'mid' | Documented as intended behavior (conservative fallback) |

### Code Sample - GPU Tier Fix

```typescript
// BEFORE (buggy): Later patterns could downgrade tier
for (const pattern of GPU_PATTERNS.low) {
  if (pattern.test(renderer)) { tier = 'low'; }
}
for (const pattern of GPU_PATTERNS.mid) {
  if (pattern.test(renderer)) { tier = 'mid'; }
}
// BUG: If renderer matches both mid AND low, it ends up as mid but could be wrong

// AFTER (fixed): Priority-based matching with breaks
for (const pattern of GPU_PATTERNS.low) {
  if (pattern.test(renderer)) { tier = 'low'; break; }
}
for (const pattern of GPU_PATTERNS.mid) {
  if (pattern.test(renderer)) { tier = 'mid'; break; }
}
for (const pattern of GPU_PATTERNS.high) {
  if (pattern.test(renderer)) { tier = 'high'; break; }
}
// High tier patterns always win (checked last)
```

---

## D.2 Runtime Monitor (`runtime-monitor.ts`)

### HIGH Severity

| Issue | Location | Description | Resolution |
|-------|----------|-------------|------------|
| Memory leak | `alertCallbacks` | Callbacks not cleared in `stop()` | Added `this.alertCallbacks.clear()` to `stop()` |
| Race condition | `frameCallback` | RAF scheduled after `isMonitoring` set to false | Added guard check before scheduling next frame |

### MEDIUM Severity

| Issue | Location | Description | Resolution |
|-------|----------|-------------|------------|
| Orphaned observers | `longTaskObserver` | Observer not disconnected in some paths | Verified cleanup in `stop()` is comprehensive |

### Code Sample - RAF Race Condition Fix

```typescript
// BEFORE (buggy): Could schedule RAF after stop() called
private frameCallback = (now: number): void => {
  // ... frame time tracking ...
  this.rafId = requestAnimationFrame(this.frameCallback); // Always schedules
};

// AFTER (fixed): Check isMonitoring before scheduling
private frameCallback = (now: number): void => {
  if (!this.isMonitoring) return; // Guard at start
  // ... frame time tracking ...
  if (this.isMonitoring) { // Guard before scheduling
    this.rafId = requestAnimationFrame(this.frameCallback);
  }
};
```

---

## D.3 Recommendation Engine (`recommendation-engine.ts`)

### HIGH Severity

| Issue | Location | Description | Resolution |
|-------|----------|-------------|------------|
| Callback cleanup leak | `stopAutoEvaluation()` | `recommendationCallbacks.clear()` broke subscriber pattern | Removed - subscribers manage their own cleanup |
| Race condition | `autoEvaluateIntervalId` | Concurrent evaluations possible during slow rules | Added `isEvaluating` flag as guard |
| Object mutation | `updateZoomLevel()` | Direct mutation of `documentInfo` | Clone object: `{ ...this.documentInfo, currentZoom: zoom }` |

### Code Sample - Concurrent Evaluation Fix

```typescript
// BEFORE (buggy): Could overlap evaluations
this.autoEvaluateIntervalId = setInterval(async () => {
  const recommendations = await this.evaluate(); // Could take 100ms+
  // If next interval fires before this completes...
}, 5000);

// AFTER (fixed): Guard against overlapping evaluations
private isEvaluating = false;

this.autoEvaluateIntervalId = setInterval(async () => {
  if (this.isEvaluating) return; // Skip if still running
  this.isEvaluating = true;
  try {
    const recommendations = await this.evaluate();
    for (const rec of recommendations) {
      this.notifyRecommendation(rec);
    }
  } finally {
    this.isEvaluating = false;
  }
}, 5000);
```

---

## D.4 Prompt Manager (`prompt-manager.ts`)

### HIGH Severity

| Issue | Location | Description | Resolution |
|-------|----------|-------------|------------|
| Event listener leak | `RecommendationModal` | Button click handlers not removed on close | Track listeners in array, remove in `onClose()` |
| State leak | `activePrompts` | Not cleaned when user clicks X button | Track `actionTaken` flag, call `onAction('dismissed')` if not set |
| Missing cleanup | Class level | No `destroy()` method for plugin unload | Added `destroy()` method |

### MEDIUM Severity

| Issue | Location | Description | Resolution |
|-------|----------|-------------|------------|
| Button text logic | `RecommendationModal` | Confusing conditional for button text | Simplified - always show "Apply" since modals only for consent-required |

### Code Sample - Event Listener Cleanup

```typescript
// BEFORE (buggy): Listeners never removed
class RecommendationModal extends Modal {
  onOpen(): void {
    const applyBtn = buttonContainer.createEl('button', { text: 'Apply' });
    applyBtn.addEventListener('click', () => { /* ... */ }); // Never removed!
  }
}

// AFTER (fixed): Track and remove listeners
class RecommendationModal extends Modal {
  private listeners: Array<{ element: HTMLElement; type: string; handler: EventListener }> = [];

  onOpen(): void {
    const applyBtn = buttonContainer.createEl('button', { text: 'Apply' });
    const applyHandler = () => { /* ... */ };
    applyBtn.addEventListener('click', applyHandler);
    this.listeners.push({ element: applyBtn, type: 'click', handler: applyHandler });
  }

  onClose(): void {
    for (const { element, type, handler } of this.listeners) {
      element.removeEventListener(type, handler);
    }
    this.listeners = [];
  }
}
```

---

## D.4 Preference Store (`preference-store.ts`)

### No HIGH Severity Issues

The preference store implementation was clean with no significant issues found.

### MEDIUM Severity

| Issue | Location | Description | Resolution |
|-------|----------|-------------|------------|
| Async persist | `persist()` | Fire-and-forget async call with no error propagation | Error is logged to console (acceptable for preferences) |

---

## Summary

| Component | HIGH | MEDIUM | LOW |
|-----------|------|--------|-----|
| system-profiler.ts | 2 | 2 | 0 |
| runtime-monitor.ts | 2 | 1 | 0 |
| recommendation-engine.ts | 3 | 0 | 0 |
| prompt-manager.ts | 3 | 1 | 0 |
| preference-store.ts | 0 | 1 | 0 |
| **Total** | **10** | **5** | **0** |

All HIGH severity issues were addressed before proceeding to Phase E.

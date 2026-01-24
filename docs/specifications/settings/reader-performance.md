# Reader Performance Settings Specification

**Version**: 1.0
**Created**: 2026-01-12
**Status**: Implemented

## Overview

This document specifies the PDF reader performance settings system, including presets, individual parameters, and their effects on rendering behavior.

## Performance Presets

Four preset configurations optimize the tile-based renderer for different use cases:

| Preset | Target Use Case | Memory | Responsiveness |
|--------|----------------|--------|----------------|
| **Balanced** | General use (default) | Medium | Good |
| **Performance** | High-end devices, large PDFs | High | Best |
| **Memory Saver** | Low-end devices, limited RAM | Low | Acceptable |
| **Quality** | Best visual fidelity | Medium-High | Good |

### Preset Values

| Setting | Balanced | Performance | Memory Saver | Quality |
|---------|----------|-------------|--------------|---------|
| L1 Cache (MB) | 50 | 100 | 30 | 80 |
| L2 Cache (MB) | 200 | 300 | 100 | 250 |
| Worker Count | auto | 4 | 1 | auto |
| Scroll Debounce (ms) | 32 | 16 | 64 | 50 |
| Zoom Debounce (ms) | 150 | 50 | 250 | 200 |
| Prefetch Viewports | 2 | 3 | 1 | 2 |
| Max Tile Scale | 32 | 32 | 16 | 32 |
| Fast Scroll Quality | 50% | 75% | 50% | 90% |
| Progressive Zoom | Yes | Yes | No | Yes |
| Hybrid Rendering | Yes | Yes | Yes | Yes |

## Individual Settings

### Cache Settings

#### L1 Cache Size (MB)
- **Type**: `number`
- **Range**: 20-150 MB
- **Default**: 50 MB
- **Effect**: Controls memory cache for hot tiles. Higher values reduce re-renders but increase RAM usage.
- **Hot-reload**: Yes

#### L2 Cache Size (MB)
- **Type**: `number`
- **Range**: 50-500 MB
- **Default**: 200 MB
- **Effect**: Controls IndexedDB cache for warm tiles. Higher values reduce network requests but increase disk usage.
- **Hot-reload**: Yes

### Worker Settings

#### Worker Count
- **Type**: `number`
- **Range**: 0-4 (0 = auto)
- **Default**: 0 (auto)
- **Effect**: Number of WASM workers for parallel rendering. Auto uses CPU cores - 1, capped at 4.
- **Hot-reload**: No (applies on next document load)

### Timing Settings

#### Scroll Debounce (ms)
- **Type**: `number`
- **Range**: 8-100 ms
- **Default**: 32 ms
- **Effect**: Delay before re-rendering during scroll. Lower = more responsive but more CPU usage.
- **Hot-reload**: Yes

#### Zoom Debounce (ms)
- **Type**: `number`
- **Range**: 25-300 ms
- **Default**: 150 ms
- **Effect**: Delay before final quality render after zoom gesture ends.
- **Hot-reload**: Yes

### Prefetch Settings

#### Prefetch Viewports
- **Type**: `number`
- **Range**: 1-4
- **Default**: 2
- **Effect**: Number of viewports to prefetch ahead during scroll. Higher = smoother scroll but more memory.
- **Hot-reload**: Yes

### Quality Settings

#### Max Tile Scale
- **Type**: `number`
- **Range**: 8-32
- **Default**: 32
- **Effect**: Maximum rendering scale for high-zoom tiles. Lower values save memory at extreme zoom.
- **Hot-reload**: Yes

#### Fast Scroll Quality
- **Type**: `number` (0.0-1.0)
- **Range**: 25-100%
- **Default**: 50%
- **Effect**: Quality reduction during fast scrolling. Lower = smoother scroll, higher = better quality.
- **Hot-reload**: Yes

### Feature Toggles

#### Progressive Zoom
- **Type**: `boolean`
- **Default**: true
- **Effect**: Enables multi-resolution zoom for instant visual feedback during pinch/scroll zoom.
- **Hot-reload**: Yes

#### Hybrid Rendering
- **Type**: `boolean`
- **Default**: true
- **Effect**: Uses full-page rendering at low zoom (<1.5x), tile-based at high zoom. Reduces render calls.
- **Hot-reload**: Yes

## TypeScript Interfaces

```typescript
// settings.ts
export type PdfPerformancePreset = 'balanced' | 'performance' | 'memory-saver' | 'quality' | 'custom';

export interface PdfTilePerformanceSettings {
  l1CacheSizeMB: number;
  l2CacheSizeMB: number;
  workerCount: number;
  scrollDebounceMsOverride: number;
  zoomDebounceMs: number;
  prefetchViewports: number;
  maxTileScale: number;
  fastScrollQuality: number;
  enableProgressiveZoom: boolean;
  enableHybridRendering: boolean;
}
```

## Implementation Files

| File | Purpose |
|------|---------|
| `settings/settings.ts` | Type definitions, preset constants |
| `reader/renderer/pdf/performance-settings-manager.ts` | Hot-reload manager with subscriber pattern |
| `settings/settings-tab/pdf-settings.ts` | Settings UI (preset selector, custom sliders) |
| `reader/renderer/pdf/tile-cache-manager.ts` | Cache limit updates |

## Settings Manager API

```typescript
import { getPerformanceSettingsManager } from './performance-settings-manager';

const manager = getPerformanceSettingsManager();

// Subscribe to changes (immediate callback with current settings)
const unsubscribe = manager.subscribe((settings, event) => {
  console.log('Preset:', settings.preset);
  console.log('L1 Cache:', settings.l1CacheSizeMB, 'MB');
  console.log('Resolved Workers:', settings.resolvedWorkerCount);
});

// Apply a preset
manager.applyPreset('performance');

// Update individual setting (auto-switches to 'custom')
manager.updateSetting('l1CacheSizeMB', 75);

// Get current settings
const current = manager.getSettings();

// Cleanup
unsubscribe();
```

## UI Location

Settings > Amnesia > PDF > Performance Presets

The UI shows:
1. Preset dropdown (Balanced, Performance, Memory Saver, Quality, Custom)
2. When "Custom" is selected, individual sliders and toggles appear

## Benchmarks

Expected performance for each preset on a 500-page PDF:

| Metric | Balanced | Performance | Memory Saver | Quality |
|--------|----------|-------------|--------------|---------|
| Scroll FPS | 55-60 | 60 | 45-55 | 55-60 |
| Zoom Response | <200ms | <100ms | <400ms | <250ms |
| Memory Usage | ~500MB | ~800MB | ~300MB | ~600MB |
| First Tile | <150ms | <100ms | <200ms | <150ms |

## Migration

Settings are automatically migrated from older versions:
- New installations default to "Balanced" preset
- Existing installations preserve custom values under "Custom" preset

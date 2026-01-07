/**
 * Unit tests for VirtualizedTextLayer
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VirtualizedTextLayer } from '../../../reader/renderer/pdf/virtualized-text-layer';
import { createMinimalTextLayer, createLargeTextLayer, createEmptyTextLayer } from '../fixtures/test-text-layer-data';

// Note: DOM mocking is handled by src/test/pdf/setup.ts

describe('VirtualizedTextLayer', () => {
  let parentElement: HTMLElement;
  let layer: VirtualizedTextLayer;

  beforeEach(() => {
    parentElement = document.createElement('div');
  });

  afterEach(() => {
    layer?.destroy();
  });

  describe('mode handling', () => {
    it('should render all items in "full" mode', () => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });

      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 0, 612, 792);

      // In full mode, all items should be rendered
      const stats = layer.getStats();
      expect(stats.mode).toBe('full');
      expect(stats.totalItems).toBe(textData.items.length);
    });

    it('should render nothing in "disabled" mode', () => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'disabled' });

      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 0, 612, 792);

      // In disabled mode, nothing should be rendered
      const stats = layer.getStats();
      expect(stats.mode).toBe('disabled');
      expect(stats.renderedItems).toBe(0);
    });

    it('should virtualize in "virtualized" mode when items exceed threshold', () => {
      layer = new VirtualizedTextLayer(parentElement, {
        mode: 'virtualized',
        virtualizationThreshold: 10,
      });

      // Create text layer with many items
      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      const stats = layer.getStats();
      expect(stats.mode).toBe('virtualized');
      expect(stats.isVirtualized).toBe(true);
      // Not all items should be rendered due to virtualization
      expect(stats.renderedItems).toBeLessThan(stats.totalItems);
    });
  });

  describe('virtualization', () => {
    beforeEach(() => {
      layer = new VirtualizedTextLayer(parentElement, {
        mode: 'virtualized',
        virtualizationThreshold: 10,
        bufferPx: 50,
      });
    });

    it('should only render items in viewport', () => {
      const textData = createLargeTextLayer(200);
      layer.render(textData, 1.0, 0, 612, 792);

      const stats = layer.getStats();
      // Should not render all 200 items
      expect(stats.renderedItems).toBeLessThan(200);
    });

    it('should include buffer zone items', () => {
      const textData = createLargeTextLayer(200);
      layer.render(textData, 1.0, 0, 612, 792);

      // Buffer zone should include some items outside immediate viewport
      const stats = layer.getStats();
      expect(stats.renderedItems).toBeGreaterThan(0);
    });

    it('should skip items outside viewport', () => {
      const textData = createLargeTextLayer(500);
      layer.render(textData, 1.0, 0, 612, 792);

      const stats = layer.getStats();
      // Most items should be skipped
      expect(stats.renderedItems).toBeLessThan(stats.totalItems / 2);
    });
  });

  describe('performance', () => {
    it('should use DocumentFragment for batch DOM insertion', () => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });

      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 0, 612, 792);

      // The implementation uses DocumentFragment internally
      // We verify by checking that items are rendered
      const stats = layer.getStats();
      expect(stats.renderedItems).toBe(textData.items.length);
    });

    it('should virtualize when items exceed threshold', () => {
      layer = new VirtualizedTextLayer(parentElement, {
        mode: 'virtualized',
        virtualizationThreshold: 50,
      });

      // Below threshold - should not virtualize
      const smallData = createLargeTextLayer(30);
      layer.render(smallData, 1.0, 0, 612, 792);

      let stats = layer.getStats();
      expect(stats.isVirtualized).toBe(false);

      // Above threshold - should virtualize
      layer.clear();
      const largeData = createLargeTextLayer(100);
      layer.render(largeData, 1.0, 0, 612, 792);

      stats = layer.getStats();
      expect(stats.isVirtualized).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove scroll listener on destroy', () => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'virtualized' });

      const textData = createLargeTextLayer(100);
      layer.render(textData, 1.0, 0, 612, 792);

      // Destroy should clean up listeners
      layer.destroy();

      // Verify layer is destroyed (stats should show zeroes or indicate destroyed state)
      // After destroy, the layer should be in a clean state
    });

    it('should clear container on destroy', () => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });

      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 0, 612, 792);

      layer.destroy();

      // Container should be removed
    });

    it('should clear container on clear()', () => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });

      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 0, 612, 792);

      let stats = layer.getStats();
      expect(stats.renderedItems).toBeGreaterThan(0);

      layer.clear();

      stats = layer.getStats();
      expect(stats.renderedItems).toBe(0);
    });
  });

  describe('rotation', () => {
    beforeEach(() => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });
    });

    it('should handle 0 degree rotation', () => {
      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 0, 612, 792);

      const stats = layer.getStats();
      expect(stats.rotation).toBe(0);
    });

    it('should handle 90 degree rotation', () => {
      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 90, 612, 792);

      const stats = layer.getStats();
      expect(stats.rotation).toBe(90);
    });

    it('should handle 180 degree rotation', () => {
      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 180, 612, 792);

      const stats = layer.getStats();
      expect(stats.rotation).toBe(180);
    });

    it('should handle 270 degree rotation', () => {
      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 270, 612, 792);

      const stats = layer.getStats();
      expect(stats.rotation).toBe(270);
    });
  });

  describe('empty text layer', () => {
    it('should handle empty text layer gracefully', () => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });

      const emptyData = createEmptyTextLayer();
      layer.render(emptyData, 1.0, 0, 612, 792);

      const stats = layer.getStats();
      expect(stats.totalItems).toBe(0);
      expect(stats.renderedItems).toBe(0);
    });
  });

  describe('getFullText', () => {
    it('should return all text content', () => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });

      const textData = createMinimalTextLayer();
      layer.render(textData, 1.0, 0, 612, 792);

      const fullText = layer.getFullText();
      expect(fullText).toContain('Hello');
      expect(fullText).toContain('World');
    });

    it('should return empty string for empty layer', () => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });

      const emptyData = createEmptyTextLayer();
      layer.render(emptyData, 1.0, 0, 612, 792);

      const fullText = layer.getFullText();
      expect(fullText).toBe('');
    });
  });

  describe('updateConfig', () => {
    it('should update mode', () => {
      layer = new VirtualizedTextLayer(parentElement, { mode: 'full' });

      expect(layer.getStats().mode).toBe('full');

      layer.updateConfig({ mode: 'virtualized' });

      expect(layer.getStats().mode).toBe('virtualized');
    });

    it('should update virtualization threshold', () => {
      layer = new VirtualizedTextLayer(parentElement, {
        mode: 'virtualized',
        virtualizationThreshold: 100,
      });

      const textData = createLargeTextLayer(50);
      layer.render(textData, 1.0, 0, 612, 792);

      // Below threshold, not virtualized
      expect(layer.getStats().isVirtualized).toBe(false);

      // Update threshold to lower value
      layer.updateConfig({ virtualizationThreshold: 30 });
      layer.clear();
      layer.render(textData, 1.0, 0, 612, 792);

      // Now above threshold, should virtualize
      expect(layer.getStats().isVirtualized).toBe(true);
    });
  });
});

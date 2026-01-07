/**
 * Unit tests for SpatialPrefetcher
 */

import { describe, it, expect } from 'vitest';
import { SpatialPrefetcher, spatialPrefetcher } from '../../../reader/renderer/pdf/spatial-prefetcher';

describe('SpatialPrefetcher', () => {
  let prefetcher: SpatialPrefetcher;

  beforeEach(() => {
    prefetcher = new SpatialPrefetcher();
  });

  describe('getGridPosition', () => {
    it('should calculate correct position for first page', () => {
      const pos = prefetcher.getGridPosition(1, 5);
      expect(pos.row).toBe(0);
      expect(pos.col).toBe(0);
    });

    it('should calculate correct position for last column', () => {
      const pos = prefetcher.getGridPosition(5, 5);
      expect(pos.row).toBe(0);
      expect(pos.col).toBe(4);
    });

    it('should calculate correct position for second row start', () => {
      const pos = prefetcher.getGridPosition(6, 5);
      expect(pos.row).toBe(1);
      expect(pos.col).toBe(0);
    });

    it('should calculate correct position for middle of grid', () => {
      // In a 5-column grid, page 15 is at row 2 (0-indexed), col 4
      // Pages: 1-5 (row 0), 6-10 (row 1), 11-15 (row 2)
      const pos = prefetcher.getGridPosition(15, 5);
      expect(pos.row).toBe(2);
      expect(pos.col).toBe(4);
    });

    it('should handle single column grid', () => {
      const pos = prefetcher.getGridPosition(5, 1);
      expect(pos.row).toBe(4);
      expect(pos.col).toBe(0);
    });
  });

  describe('getPageFromPosition', () => {
    it('should convert position back to page number', () => {
      expect(prefetcher.getPageFromPosition({ row: 0, col: 0 }, 5)).toBe(1);
      expect(prefetcher.getPageFromPosition({ row: 0, col: 4 }, 5)).toBe(5);
      expect(prefetcher.getPageFromPosition({ row: 1, col: 0 }, 5)).toBe(6);
      expect(prefetcher.getPageFromPosition({ row: 2, col: 4 }, 5)).toBe(15);
    });

    it('should be inverse of getGridPosition', () => {
      for (let page = 1; page <= 25; page++) {
        const pos = prefetcher.getGridPosition(page, 5);
        const roundTrip = prefetcher.getPageFromPosition(pos, 5);
        expect(roundTrip).toBe(page);
      }
    });
  });

  describe('calculateDistance', () => {
    it('should calculate Manhattan distance correctly', () => {
      const from = { row: 2, col: 2 };

      // Same position
      expect(prefetcher.calculateDistance(from, { row: 2, col: 2 }, 'manhattan')).toBe(0);

      // Cardinal directions (distance 1)
      expect(prefetcher.calculateDistance(from, { row: 1, col: 2 }, 'manhattan')).toBe(1); // Up
      expect(prefetcher.calculateDistance(from, { row: 3, col: 2 }, 'manhattan')).toBe(1); // Down
      expect(prefetcher.calculateDistance(from, { row: 2, col: 1 }, 'manhattan')).toBe(1); // Left
      expect(prefetcher.calculateDistance(from, { row: 2, col: 3 }, 'manhattan')).toBe(1); // Right

      // Diagonal (distance 2 in Manhattan)
      expect(prefetcher.calculateDistance(from, { row: 1, col: 1 }, 'manhattan')).toBe(2);
      expect(prefetcher.calculateDistance(from, { row: 3, col: 3 }, 'manhattan')).toBe(2);

      // Further away
      expect(prefetcher.calculateDistance(from, { row: 0, col: 0 }, 'manhattan')).toBe(4);
    });

    it('should calculate Euclidean distance correctly', () => {
      const from = { row: 0, col: 0 };

      // Same position
      expect(prefetcher.calculateDistance(from, { row: 0, col: 0 }, 'euclidean')).toBe(0);

      // Unit distances
      expect(prefetcher.calculateDistance(from, { row: 0, col: 1 }, 'euclidean')).toBe(1);
      expect(prefetcher.calculateDistance(from, { row: 1, col: 0 }, 'euclidean')).toBe(1);

      // Diagonal (sqrt(2) ≈ 1.414)
      expect(prefetcher.calculateDistance(from, { row: 1, col: 1 }, 'euclidean')).toBeCloseTo(Math.sqrt(2));

      // 3-4-5 triangle
      expect(prefetcher.calculateDistance(from, { row: 3, col: 4 }, 'euclidean')).toBe(5);
    });
  });

  describe('getPriorityForDistance', () => {
    it('should return high priority for distance 0 and 1', () => {
      expect(prefetcher.getPriorityForDistance(0)).toBe('high');
      expect(prefetcher.getPriorityForDistance(1)).toBe('high');
    });

    it('should return medium priority for distance 2 and 3', () => {
      expect(prefetcher.getPriorityForDistance(2)).toBe('medium');
      expect(prefetcher.getPriorityForDistance(3)).toBe('medium');
    });

    it('should return low priority for distance 4+', () => {
      expect(prefetcher.getPriorityForDistance(4)).toBe('low');
      expect(prefetcher.getPriorityForDistance(5)).toBe('low');
      expect(prefetcher.getPriorityForDistance(10)).toBe('low');
    });
  });

  describe('getImmediateNeighbors', () => {
    it('should return all 4 neighbors for center page', () => {
      // Page 8 in 5-column grid: row 1, col 2
      // Neighbors: 3 (above), 13 (below), 7 (left), 9 (right)
      const neighbors = prefetcher.getImmediateNeighbors(8, 5, 25);
      expect(neighbors).toHaveLength(4);
      expect(neighbors).toContain(3);  // Above
      expect(neighbors).toContain(13); // Below
      expect(neighbors).toContain(7);  // Left
      expect(neighbors).toContain(9);  // Right
    });

    it('should handle corner page (top-left)', () => {
      // Page 1: only right (2) and below (6)
      const neighbors = prefetcher.getImmediateNeighbors(1, 5, 25);
      expect(neighbors).toHaveLength(2);
      expect(neighbors).toContain(2);  // Right
      expect(neighbors).toContain(6);  // Below
    });

    it('should handle corner page (top-right)', () => {
      // Page 5: only left (4) and below (10)
      const neighbors = prefetcher.getImmediateNeighbors(5, 5, 25);
      expect(neighbors).toHaveLength(2);
      expect(neighbors).toContain(4);  // Left
      expect(neighbors).toContain(10); // Below
    });

    it('should handle edge page (left edge)', () => {
      // Page 6: above (1), right (7), below (11)
      const neighbors = prefetcher.getImmediateNeighbors(6, 5, 25);
      expect(neighbors).toHaveLength(3);
      expect(neighbors).toContain(1);  // Above
      expect(neighbors).toContain(7);  // Right
      expect(neighbors).toContain(11); // Below
    });

    it('should handle last row', () => {
      // Page 23 in 5-column grid (row 4, col 2): above (18), left (22), right (24)
      // Below would be page 28 which exceeds pageCount
      const neighbors = prefetcher.getImmediateNeighbors(23, 5, 25);
      expect(neighbors).toHaveLength(3);
      expect(neighbors).toContain(18); // Above
      expect(neighbors).toContain(22); // Left
      expect(neighbors).toContain(24); // Right
    });

    it('should handle incomplete last row', () => {
      // Page 23 with only 23 pages total
      const neighbors = prefetcher.getImmediateNeighbors(23, 5, 23);
      expect(neighbors).toHaveLength(2);
      expect(neighbors).toContain(18); // Above
      expect(neighbors).toContain(22); // Left
      // No right (would be 24 > 23) and no below (would be 28 > 23)
    });

    it('should handle single column grid', () => {
      // In single column, neighbors are only above and below
      const neighbors = prefetcher.getImmediateNeighbors(5, 1, 10);
      expect(neighbors).toHaveLength(2);
      expect(neighbors).toContain(4); // Above
      expect(neighbors).toContain(6); // Below
    });
  });

  describe('getSpatialPrefetchList', () => {
    it('should return empty for empty document', () => {
      const result = prefetcher.getSpatialPrefetchList({
        centerPage: 1,
        radius: 2,
        columns: 5,
        pageCount: 0,
      });
      expect(result).toHaveLength(0);
    });

    it('should return empty for zero columns', () => {
      const result = prefetcher.getSpatialPrefetchList({
        centerPage: 1,
        radius: 2,
        columns: 0,
        pageCount: 25,
      });
      expect(result).toHaveLength(0);
    });

    it('should not include center page in results', () => {
      const result = prefetcher.getSpatialPrefetchList({
        centerPage: 15,
        radius: 2,
        columns: 5,
        pageCount: 25,
      });
      expect(result).not.toContain(15);
    });

    it('should return neighbors sorted by distance', () => {
      // 5-column grid, center=8 (row 1, col 2)
      const result = prefetcher.getSpatialPrefetchList({
        centerPage: 8,
        radius: 2,
        columns: 5,
        pageCount: 25,
      });

      // Distance 1 neighbors should come first
      const distance1 = [3, 7, 9, 13];
      const first4 = result.slice(0, 4);
      for (const page of distance1) {
        expect(first4).toContain(page);
      }

      // Distance 2 neighbors should come after
      const distance2 = [2, 4, 6, 10, 12, 14, 18]; // includes corner diagonals
      const rest = result.slice(4);
      for (const page of distance2) {
        if (page <= 25) {
          expect(rest).toContain(page);
        }
      }
    });

    it('should respect radius limit', () => {
      const radius1 = prefetcher.getSpatialPrefetchList({
        centerPage: 8,
        radius: 1,
        columns: 5,
        pageCount: 25,
      });

      const radius2 = prefetcher.getSpatialPrefetchList({
        centerPage: 8,
        radius: 2,
        columns: 5,
        pageCount: 25,
      });

      expect(radius1.length).toBeLessThan(radius2.length);
      expect(radius1).toHaveLength(4); // Only 4 cardinal neighbors at distance 1
    });

    it('should clamp center page to valid range', () => {
      // Center page beyond pageCount should be clamped
      const result = prefetcher.getSpatialPrefetchList({
        centerPage: 100,
        radius: 1,
        columns: 5,
        pageCount: 25,
      });

      // Should have neighbors of page 25 (last page)
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain(20); // Above page 25
      expect(result).toContain(24); // Left of page 25
    });
  });

  describe('getSpatialPrefetchResults', () => {
    it('should include priority information', () => {
      const results = prefetcher.getSpatialPrefetchResults({
        centerPage: 8,
        radius: 3,
        columns: 5,
        pageCount: 25,
      });

      // Check that priorities are assigned correctly
      const highPriority = results.filter(r => r.priority === 'high');
      const mediumPriority = results.filter(r => r.priority === 'medium');

      // Distance 1 should be high priority
      expect(highPriority.every(r => r.distance <= 1)).toBe(true);

      // Distance 2-3 should be medium priority
      expect(mediumPriority.every(r => r.distance >= 2 && r.distance <= 3)).toBe(true);
    });

    it('should include row and column information', () => {
      const results = prefetcher.getSpatialPrefetchResults({
        centerPage: 15,
        radius: 1,
        columns: 5,
        pageCount: 25,
      });

      for (const result of results) {
        // Verify row/col matches page
        const expectedPos = prefetcher.getGridPosition(result.page, 5);
        expect(result.row).toBe(expectedPos.row);
        expect(result.col).toBe(expectedPos.col);
      }
    });
  });

  describe('getPagesByDistanceRing', () => {
    it('should organize pages by distance rings', () => {
      const rings = prefetcher.getPagesByDistanceRing(8, 2, 5, 25);

      // Ring 1 (distance 1) - cardinal neighbors
      const ring1 = rings.get(1) ?? [];
      expect(ring1).toContain(3);  // Above
      expect(ring1).toContain(7);  // Left
      expect(ring1).toContain(9);  // Right
      expect(ring1).toContain(13); // Below

      // Ring 2 (distance 2) - includes diagonals
      const ring2 = rings.get(2) ?? [];
      expect(ring2.length).toBeGreaterThan(0);
    });

    it('should not include ring 0 (center page)', () => {
      const rings = prefetcher.getPagesByDistanceRing(8, 2, 5, 25);
      expect(rings.has(0)).toBe(false);
    });
  });

  describe('singleton instance', () => {
    it('should export a working singleton', () => {
      const result = spatialPrefetcher.getSpatialPrefetchList({
        centerPage: 8,
        radius: 1,
        columns: 5,
        pageCount: 25,
      });
      expect(result).toHaveLength(4);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle typical PDF with 100 pages in 5-column grid', () => {
      const result = prefetcher.getSpatialPrefetchList({
        centerPage: 50,
        radius: 2,
        columns: 5,
        pageCount: 100,
      });

      // Page 50 is at row 9, col 4
      // With radius 2, should have at least 8 neighbors (4 cardinal + 4 diagonal)
      expect(result.length).toBeGreaterThanOrEqual(8);
    });

    it('should handle auto-grid with varying column counts', () => {
      // Simulate zoom change: columns go from 3 to 7
      const result3col = prefetcher.getSpatialPrefetchList({
        centerPage: 15,
        radius: 2,
        columns: 3,
        pageCount: 50,
      });

      const result7col = prefetcher.getSpatialPrefetchList({
        centerPage: 15,
        radius: 2,
        columns: 7,
        pageCount: 50,
      });

      // Different column counts should produce different neighbors
      // In 3-col: page 15 is row 4, col 2
      // In 7-col: page 15 is row 2, col 1
      expect(result3col).not.toEqual(result7col);
    });

    it('should handle canvas mode with 10 columns', () => {
      const result = prefetcher.getSpatialPrefetchList({
        centerPage: 55,
        radius: 3,
        columns: 10,
        pageCount: 200,
      });

      // Page 55 in 10-column grid: row 5, col 4
      // With radius 3, should have many neighbors
      expect(result.length).toBeGreaterThan(12);
    });
  });
});

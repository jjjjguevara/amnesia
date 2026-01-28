/**
 * Circuit Breaker Pattern Tests
 *
 * Problem: When tiles are repeatedly rejected (epoch mismatch, scale mismatch),
 * system enters infinite retry loop with no mechanism to detect deadlock and fallback.
 *
 * Solution: Circuit breaker pattern tracks consecutive rejections and:
 * 1. Trips after threshold rejections (10 by default)
 * 2. Triggers fallback to lower-scale tiles when tripped
 * 3. Resets on successful composite
 *
 * Tests:
 * - CB-1: Circuit breaker trips after threshold rejections
 * - CB-2: Tripped circuit triggers fallback behavior
 * - CB-3: Successful composite resets failure count
 * - CB-4: Different rejection reasons are tracked
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  TileCircuitBreaker,
  createTileCircuitBreaker,
  type CircuitBreakerConfig,
} from '@/reader/renderer/pdf/tile-cache-manager';

describe('Circuit Breaker Pattern', () => {
  let circuitBreaker: TileCircuitBreaker;

  beforeEach(() => {
    circuitBreaker = createTileCircuitBreaker();
  });

  afterEach(() => {
    circuitBreaker.reset();
  });

  // =========================================================================
  // CB-1: Circuit breaker trips after threshold rejections
  // =========================================================================
  describe('CB-1: Circuit trips after threshold rejections', () => {
    it('trips after 10 consecutive rejections (default threshold)', () => {
      for (let i = 0; i < 10; i++) {
        expect(circuitBreaker.isTripped()).toBe(false);
        circuitBreaker.recordRejection('epoch_expired');
      }
      expect(circuitBreaker.isTripped()).toBe(true);
    });

    it('does not trip before reaching threshold', () => {
      for (let i = 0; i < 9; i++) {
        circuitBreaker.recordRejection('epoch_expired');
      }
      expect(circuitBreaker.isTripped()).toBe(false);
    });

    it('respects custom threshold from config', () => {
      const customBreaker = createTileCircuitBreaker({ threshold: 5 });
      for (let i = 0; i < 5; i++) {
        customBreaker.recordRejection('scale_mismatch');
      }
      expect(customBreaker.isTripped()).toBe(true);
    });

    it('getConsecutiveFailures returns current count', () => {
      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);
      circuitBreaker.recordRejection('epoch_expired');
      expect(circuitBreaker.getConsecutiveFailures()).toBe(1);
      circuitBreaker.recordRejection('epoch_expired');
      expect(circuitBreaker.getConsecutiveFailures()).toBe(2);
    });
  });

  // =========================================================================
  // CB-2: Tripped circuit triggers fallback behavior
  // =========================================================================
  describe('CB-2: Fallback behavior when tripped', () => {
    it('shouldUseFallback returns true when tripped', () => {
      for (let i = 0; i < 10; i++) {
        circuitBreaker.recordRejection('epoch_expired');
      }
      expect(circuitBreaker.shouldUseFallback()).toBe(true);
    });

    it('shouldUseFallback returns false when not tripped', () => {
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordRejection('epoch_expired');
      }
      expect(circuitBreaker.shouldUseFallback()).toBe(false);
    });

    it('getFallbackScaleReduction returns factor when tripped', () => {
      for (let i = 0; i < 10; i++) {
        circuitBreaker.recordRejection('epoch_expired');
      }
      // Default fallback is 2x reduction (e.g., scale 32 → scale 16)
      expect(circuitBreaker.getFallbackScaleReduction()).toBe(2);
    });

    it('getFallbackScaleReduction returns 1 (no reduction) when not tripped', () => {
      expect(circuitBreaker.getFallbackScaleReduction()).toBe(1);
    });
  });

  // =========================================================================
  // CB-3: Successful composite resets failure count
  // =========================================================================
  describe('CB-3: Reset on success', () => {
    it('recordSuccess resets consecutive failure count', () => {
      for (let i = 0; i < 9; i++) {
        circuitBreaker.recordRejection('epoch_expired');
      }
      expect(circuitBreaker.getConsecutiveFailures()).toBe(9);

      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);
    });

    it('success after trip resets circuit to closed state', () => {
      for (let i = 0; i < 10; i++) {
        circuitBreaker.recordRejection('epoch_expired');
      }
      expect(circuitBreaker.isTripped()).toBe(true);

      circuitBreaker.recordSuccess();
      expect(circuitBreaker.isTripped()).toBe(false);
    });

    it('manual reset clears all state', () => {
      for (let i = 0; i < 10; i++) {
        circuitBreaker.recordRejection('scale_mismatch');
      }
      expect(circuitBreaker.isTripped()).toBe(true);

      circuitBreaker.reset();
      expect(circuitBreaker.isTripped()).toBe(false);
      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);
    });
  });

  // =========================================================================
  // CB-4: Different rejection reasons are tracked
  // =========================================================================
  describe('CB-4: Rejection reason tracking', () => {
    it('tracks rejection reasons', () => {
      circuitBreaker.recordRejection('epoch_expired');
      circuitBreaker.recordRejection('epoch_expired');
      circuitBreaker.recordRejection('scale_mismatch');

      const stats = circuitBreaker.getStats();
      expect(stats.rejectionsByReason['epoch_expired']).toBe(2);
      expect(stats.rejectionsByReason['scale_mismatch']).toBe(1);
    });

    it('getStats returns total rejections and successes', () => {
      circuitBreaker.recordRejection('epoch_expired');
      circuitBreaker.recordRejection('scale_mismatch');
      circuitBreaker.recordSuccess();
      circuitBreaker.recordRejection('epoch_expired');

      const stats = circuitBreaker.getStats();
      expect(stats.totalRejections).toBe(3);
      expect(stats.totalSuccesses).toBe(1);
    });

    it('mixed rejection reasons still trigger trip at threshold', () => {
      // 5 epoch_expired + 5 scale_mismatch = 10 total
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordRejection('epoch_expired');
      }
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordRejection('scale_mismatch');
      }
      expect(circuitBreaker.isTripped()).toBe(true);
    });
  });

  // =========================================================================
  // CB-5: Integration with cache manager
  // =========================================================================
  describe('CB-5: Circuit breaker state accessor', () => {
    it('provides state summary for debugging', () => {
      circuitBreaker.recordRejection('epoch_expired');
      const state = circuitBreaker.getState();

      expect(state).toHaveProperty('isTripped');
      expect(state).toHaveProperty('consecutiveFailures');
      expect(state).toHaveProperty('threshold');
      expect(state.consecutiveFailures).toBe(1);
    });
  });
});

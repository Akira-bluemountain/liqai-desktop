import { describe, it, expect } from 'vitest';
import {
  priceToTick,
  tickToPrice,
  alignTickFloor,
  alignTickCeil,
  clampTick,
  MIN_TICK,
  MAX_TICK,
} from '../src/ticks.js';

describe('ticks', () => {
  describe('priceToTick', () => {
    it('converts price 1 to tick 0', () => {
      expect(priceToTick(1)).toBe(0);
    });

    it('is monotonically increasing', () => {
      expect(priceToTick(100)).toBeLessThan(priceToTick(200));
      expect(priceToTick(1000)).toBeLessThan(priceToTick(2000));
    });

    it('rejects non-positive prices', () => {
      expect(() => priceToTick(0)).toThrow();
      expect(() => priceToTick(-1)).toThrow();
      expect(() => priceToTick(NaN)).toThrow();
      expect(() => priceToTick(Infinity)).toThrow();
    });
  });

  describe('tickToPrice', () => {
    it('round-trips priceToTick (approximately)', () => {
      for (const p of [0.001, 1, 100, 1000, 1e6]) {
        const tick = priceToTick(p);
        const roundtrip = tickToPrice(tick);
        // Floor introduces ≤ 0.01% error (1.0001^1 ≈ 1.0001).
        expect(roundtrip).toBeLessThanOrEqual(p);
        expect(roundtrip).toBeGreaterThan(p * 0.9999);
      }
    });

    it('rejects non-integer ticks', () => {
      expect(() => tickToPrice(1.5)).toThrow();
    });

    it('rejects out-of-range ticks', () => {
      expect(() => tickToPrice(MIN_TICK - 1)).toThrow();
      expect(() => tickToPrice(MAX_TICK + 1)).toThrow();
    });
  });

  describe('align', () => {
    it('floor aligns positive and negative ticks', () => {
      expect(alignTickFloor(100, 60)).toBe(60);
      expect(alignTickFloor(-100, 60)).toBe(-120);
      expect(alignTickFloor(60, 60)).toBe(60);
    });

    it('ceil aligns positive and negative ticks', () => {
      expect(alignTickCeil(100, 60)).toBe(120);
      expect(alignTickCeil(-100, 60)).toBe(-60);
      expect(alignTickCeil(60, 60)).toBe(60);
    });

    it('rejects non-positive spacing', () => {
      expect(() => alignTickFloor(100, 0)).toThrow();
      expect(() => alignTickCeil(100, -1)).toThrow();
    });
  });

  describe('clampTick', () => {
    it('clamps to the Uniswap V3 tick bounds', () => {
      expect(clampTick(MIN_TICK - 100)).toBe(MIN_TICK);
      expect(clampTick(MAX_TICK + 100)).toBe(MAX_TICK);
      expect(clampTick(0)).toBe(0);
    });
  });
});

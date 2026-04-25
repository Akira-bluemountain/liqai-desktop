import { describe, it, expect } from 'vitest';
import { calculateSweetSpot, assertRangeSafeForExecution } from '../src/range-calculator.js';
import { SweetSpotResultSchema } from '../src/schemas.js';

/** Generate a synthetic price series with target volatility. */
function syntheticPrices(
  basePrice: number,
  count: number,
  stepVol: number,
  seed = 1,
): number[] {
  // Deterministic pseudo-random for reproducible tests.
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  const out: number[] = [basePrice];
  for (let i = 1; i < count; i++) {
    const drift = stepVol * rand() * 2;
    out.push(out[i - 1]! * (1 + drift));
  }
  return out;
}

describe('calculateSweetSpot', () => {
  it('produces a validated result for well-formed input', () => {
    const prices = syntheticPrices(2000, 200, 0.01);
    const result = calculateSweetSpot({
      prices,
      currentPrice: 2000,
      feeTier: 500,
      holdingPeriodDays: 7,
    });

    // Must pass the schema (already run internally but double-check).
    expect(() => SweetSpotResultSchema.parse(result)).not.toThrow();
    expect(result.tickLower).toBeLessThan(result.tickUpper);
    expect(result.priceLower).toBeLessThan(result.priceUpper);
    expect(result.priceLower).toBeLessThan(2000);
    expect(result.priceUpper).toBeGreaterThan(2000);
    expect(result.volatility).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(result.expectedApr).toBeGreaterThanOrEqual(10);
    expect(result.expectedApr).toBeLessThanOrEqual(500);
  });

  it('aligns ticks to the fee-tier spacing', () => {
    const prices = syntheticPrices(2000, 200, 0.01);
    // 500 fee tier → spacing 10
    const r500 = calculateSweetSpot({
      prices,
      currentPrice: 2000,
      feeTier: 500,
      holdingPeriodDays: 7,
    });
    expect(r500.tickLower % 10).toBe(0);
    expect(r500.tickUpper % 10).toBe(0);

    // 3000 fee tier → spacing 60
    const r3000 = calculateSweetSpot({
      prices,
      currentPrice: 2000,
      feeTier: 3000,
      holdingPeriodDays: 7,
    });
    expect(r3000.tickLower % 60).toBe(0);
    expect(r3000.tickUpper % 60).toBe(0);
  });

  it('rejects too-few price points', () => {
    expect(() =>
      calculateSweetSpot({
        prices: [100, 101, 102], // < 10 required
        currentPrice: 101,
        feeTier: 500,
      }),
    ).toThrow();
  });

  it('rejects negative or zero prices', () => {
    expect(() =>
      calculateSweetSpot({
        prices: new Array(20).fill(0),
        currentPrice: 2000,
        feeTier: 500,
      }),
    ).toThrow();

    const prices = new Array(20).fill(100);
    prices[5] = -1;
    expect(() =>
      calculateSweetSpot({
        prices,
        currentPrice: 100,
        feeTier: 500,
      }),
    ).toThrow();
  });

  it('rejects non-whitelisted fee tiers', () => {
    const prices = syntheticPrices(2000, 200, 0.01);
    expect(() =>
      calculateSweetSpot({
        prices,
        currentPrice: 2000,
        feeTier: 777, // not a valid Uniswap V3 fee tier
        holdingPeriodDays: 7,
      }),
    ).toThrow();
  });

  it('rejects absurd holding periods', () => {
    const prices = syntheticPrices(2000, 200, 0.01);
    expect(() =>
      calculateSweetSpot({
        prices,
        currentPrice: 2000,
        feeTier: 500,
        holdingPeriodDays: 9999, // > 365 cap
      }),
    ).toThrow();
  });

  it('rejects non-positive currentPrice', () => {
    const prices = syntheticPrices(2000, 200, 0.01);
    expect(() =>
      calculateSweetSpot({
        prices,
        currentPrice: -100,
        feeTier: 500,
      }),
    ).toThrow();
  });

  it('rejects oversized price arrays (memory DoS guard)', () => {
    const prices = new Array(200_000).fill(2000);
    expect(() =>
      calculateSweetSpot({
        prices,
        currentPrice: 2000,
        feeTier: 500,
      }),
    ).toThrow();
  });
});

describe('assertRangeSafeForExecution', () => {
  const baseRange = {
    tickLower: 69_000,
    tickUpper: 76_000,
    priceLower: 1900,
    priceUpper: 2100,
    expectedApr: 80,
    confidence: 75,
    volatility: 0.3,
  };

  it('passes for a range bracketing the current price', () => {
    expect(() => assertRangeSafeForExecution(baseRange, 2000)).not.toThrow();
  });

  it('rejects when current price is below the range', () => {
    expect(() => assertRangeSafeForExecution(baseRange, 1000)).toThrow(/bracket/);
  });

  it('rejects when current price is above the range', () => {
    expect(() => assertRangeSafeForExecution(baseRange, 3000)).toThrow(/bracket/);
  });

  it('rejects dust-width ranges (<0.1%)', () => {
    const dust = { ...baseRange, priceLower: 1999.9, priceUpper: 2000.1 };
    expect(() => assertRangeSafeForExecution(dust, 2000)).toThrow(/narrow/);
  });

  it('rejects over-wide ranges (>180%)', () => {
    const wide = { ...baseRange, priceLower: 100, priceUpper: 6000 };
    expect(() => assertRangeSafeForExecution(wide, 2000)).toThrow(/wide/);
  });

  it('rejects invalid current price', () => {
    expect(() => assertRangeSafeForExecution(baseRange, 0)).toThrow();
    expect(() => assertRangeSafeForExecution(baseRange, -100)).toThrow();
    expect(() => assertRangeSafeForExecution(baseRange, NaN)).toThrow();
  });
});

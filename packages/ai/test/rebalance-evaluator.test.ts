import { describe, it, expect } from 'vitest';
import { evaluateRebalance } from '../src/rebalance-evaluator.js';

/** Synthetic price series oscillating around 2000 with tiny noise (no trigger). */
function quietSeries(n: number, center = 2000): { prices: number[]; timestamps: number[] } {
  const prices: number[] = [];
  const timestamps: number[] = [];
  const now = 1_700_000_000;
  for (let i = 0; i < n; i++) {
    const noise = Math.sin(i / 3) * 1; // ±0.05% oscillation
    prices.push(center + noise);
    timestamps.push(now + i * 60); // 1-minute candles
  }
  return { prices, timestamps };
}

const inRange = {
  tickLower: 69_000,
  tickUpper: 76_000,
  priceLower: 1900,
  priceUpper: 2100,
};

describe('evaluateRebalance', () => {
  it('returns no-rebalance for a quiet series within range', () => {
    const { prices, timestamps } = quietSeries(30);
    const result = evaluateRebalance({
      currentPrice: 2000,
      ...inRange,
      recentPrices: prices,
      timestamps,
    });
    expect(result.shouldRebalance).toBe(false);
    expect(result.trigger).toBeNull();
  });

  it('triggers range_exit with 99% confidence when price is above range', () => {
    const { prices, timestamps } = quietSeries(30, 2200);
    const result = evaluateRebalance({
      currentPrice: 2200,
      ...inRange,
      recentPrices: prices,
      timestamps,
    });
    expect(result.shouldRebalance).toBe(true);
    expect(result.trigger).toBe('range_exit');
    expect(result.confidence).toBe(99);
    expect(result.newRange).toBeDefined();
  });

  it('triggers range_exit with 99% confidence when price is below range', () => {
    const { prices, timestamps } = quietSeries(30, 1800);
    const result = evaluateRebalance({
      currentPrice: 1800,
      ...inRange,
      recentPrices: prices,
      timestamps,
    });
    expect(result.shouldRebalance).toBe(true);
    expect(result.trigger).toBe('range_exit');
    expect(result.confidence).toBe(99);
  });

  it('triggers boundary alert at 95% upper', () => {
    const { prices, timestamps } = quietSeries(30, 2090);
    // Current price at priceLower + 0.95 * rangeSize = 1900 + 0.95*200 = 2090
    const result = evaluateRebalance({
      currentPrice: 2090,
      ...inRange,
      recentPrices: prices,
      timestamps,
    });
    expect(result.shouldRebalance).toBe(true);
    expect(result.trigger).toBe('range_exit');
    expect(result.confidence).toBeGreaterThanOrEqual(90);
  });

  it('detects 5-minute spike (>=3%)', () => {
    const prices: number[] = [];
    const timestamps: number[] = [];
    const now = 1_700_000_000;
    for (let i = 0; i < 20; i++) {
      prices.push(2000);
      timestamps.push(now + i * 60);
    }
    // Most recent price is +3.5% vs. 5 min ago.
    prices[prices.length - 1] = 2070;
    const result = evaluateRebalance({
      currentPrice: 2070,
      ...inRange,
      recentPrices: prices,
      timestamps,
    });
    expect(result.shouldRebalance).toBe(true);
    expect(['spike', 'range_exit']).toContain(result.trigger);
  });

  it('detects 5-minute crash (>=5%)', () => {
    const prices: number[] = [];
    const timestamps: number[] = [];
    const now = 1_700_000_000;
    for (let i = 0; i < 20; i++) {
      prices.push(2000);
      timestamps.push(now + i * 60);
    }
    prices[prices.length - 1] = 1880; // -6%
    const result = evaluateRebalance({
      currentPrice: 1880,
      ...inRange,
      recentPrices: prices,
      timestamps,
    });
    expect(result.shouldRebalance).toBe(true);
    expect(['dip', 'range_exit']).toContain(result.trigger);
  });

  it('rejects input with mismatched price/timestamp array lengths', () => {
    expect(() =>
      evaluateRebalance({
        currentPrice: 2000,
        ...inRange,
        recentPrices: [2000, 2001, 2002],
        timestamps: [1, 2],
      }),
    ).toThrow();
  });

  it('rejects tickLower >= tickUpper in input (defence in depth)', () => {
    const { prices, timestamps } = quietSeries(30);
    expect(() =>
      evaluateRebalance({
        currentPrice: 2000,
        tickLower: 80_000,
        tickUpper: 80_000,
        priceLower: 1900,
        priceUpper: 2100,
        recentPrices: prices,
        timestamps,
      }),
    ).toThrow();
  });

  it('rejects priceLower >= priceUpper in input', () => {
    const { prices, timestamps } = quietSeries(30);
    expect(() =>
      evaluateRebalance({
        currentPrice: 2000,
        tickLower: 69_000,
        tickUpper: 76_000,
        priceLower: 2100,
        priceUpper: 1900,
        recentPrices: prices,
        timestamps,
      }),
    ).toThrow();
  });

  it('rejects non-positive prices (malicious RPC data)', () => {
    const { prices, timestamps } = quietSeries(30);
    const poisoned = [...prices];
    poisoned[5] = 0;
    expect(() =>
      evaluateRebalance({
        currentPrice: 2000,
        ...inRange,
        recentPrices: poisoned,
        timestamps,
      }),
    ).toThrow();
  });

  // Wick detection regression tests (2026-04-17): the evaluator used to
  // fire `wick` on tiny-body / tiny-tail noise, causing ~4 rebalances per day
  // on calm hourly ETH data. Thresholds are now MIN_BODY=0.5%, MIN_WICK=1.5%,
  // WICK/BODY ratio 2.5× — these tests lock in the new bounds.

  it('does NOT fire wick on noise-level candles (tiny body + tiny tail)', () => {
    // 27 flat candles + last 3 with ~$2 moves on a $2000 price (0.1%).
    const prices: number[] = [];
    const timestamps: number[] = [];
    const now = 1_700_000_000;
    for (let i = 0; i < 27; i++) {
      prices.push(2000);
      timestamps.push(now + i * 60);
    }
    // last 3 candles: open 2000, high 2003, low 1999, close 2001
    // body = 1, upperWick = 2, lowerWick = 1 — all below 0.5% / 1.5%
    prices.push(2000, 2003, 2001);
    timestamps.push(now + 27 * 60, now + 28 * 60, now + 29 * 60);
    const result = evaluateRebalance({
      currentPrice: 2001,
      ...inRange,
      recentPrices: prices,
      timestamps,
    });
    expect(result.shouldRebalance).toBe(false);
    expect(result.trigger).toBeNull();
  });

  it('fires wick on a genuinely outsized tail', () => {
    // body = 15 (0.75% of 2000), upper wick = 45 → ratio 3.0 ≥ 2.5 ✓,
    // wick 45 ≥ 1.5% × 2015 = 30.2 ✓.
    const prices: number[] = [];
    const timestamps: number[] = [];
    const now = 1_700_000_000;
    for (let i = 0; i < 27; i++) {
      prices.push(2000);
      timestamps.push(now + i * 60);
    }
    // last 3 candles: open=2000, high=2060 (wick 45), close=2015
    prices.push(2000, 2060, 2015);
    timestamps.push(now + 27 * 60, now + 28 * 60, now + 29 * 60);
    const result = evaluateRebalance({
      currentPrice: 2015,
      ...inRange,
      recentPrices: prices,
      timestamps,
    });
    expect(result.shouldRebalance).toBe(true);
    // May be spike-then-wick in priority; both are acceptable.
    expect(['wick', 'spike']).toContain(result.trigger);
  });

  it('does NOT fire wick when body is large but wick is only 2× body (ratio < 2.5)', () => {
    const prices: number[] = [];
    const timestamps: number[] = [];
    const now = 1_700_000_000;
    for (let i = 0; i < 27; i++) {
      prices.push(2000);
      timestamps.push(now + i * 60);
    }
    // body 20 (1% of price), wick 40 (2% of price) → ratio 2.0 → below 2.5.
    // But wick itself meets MIN_WICK_PCT=1.5% — so we still filter out via ratio.
    prices.push(2000, 2040, 2020);
    timestamps.push(now + 27 * 60, now + 28 * 60, now + 29 * 60);
    const result = evaluateRebalance({
      currentPrice: 2020,
      ...inRange,
      recentPrices: prices,
      timestamps,
    });
    // Wick itself should not fire. (A 5-minute spike trigger from 2000→2020 is
    // only 1%, below the 3% threshold, so nothing else fires either.)
    expect(result.trigger).not.toBe('wick');
  });
});

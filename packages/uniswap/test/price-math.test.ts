import { describe, it, expect } from 'vitest';
import {
  sqrtPriceX96ToPrice,
  computePositionAmounts,
  withSlippage,
} from '../src/price-math.js';

describe('sqrtPriceX96ToPrice', () => {
  it('returns approximately 1 for sqrtPrice representing price=1 (equal decimals)', () => {
    // sqrtPriceX96 = 1 * 2^96 = 79228162514264337593543950336
    const sqrt = 2n ** 96n;
    const p = sqrtPriceX96ToPrice(sqrt, 18, 18);
    expect(p).toBeCloseTo(1, 10);
  });

  it('adjusts for decimal difference (USDC/WETH style)', () => {
    // A sqrtPrice of ~2e15 (approximate real mainnet USDC/WETH value) with
    // token0=USDC (6 dec), token1=WETH (18 dec) should give a sensible
    // price in the ~0.000x range (because it's ETH per USDC).
    const sqrt = 2_000_000_000_000_000n; // arbitrary mainnet-ish value
    const p = sqrtPriceX96ToPrice(sqrt, 6, 18);
    expect(p).toBeGreaterThan(0);
    expect(Number.isFinite(p)).toBe(true);
  });

  it('rejects non-positive sqrtPriceX96', () => {
    expect(() => sqrtPriceX96ToPrice(0n, 18, 18)).toThrow();
    expect(() => sqrtPriceX96ToPrice(-1n, 18, 18)).toThrow();
  });

  it('rejects non-integer decimals', () => {
    expect(() => sqrtPriceX96ToPrice(2n ** 96n, 1.5, 18)).toThrow();
  });

  it('rejects absurd decimals (defence against malicious token)', () => {
    expect(() => sqrtPriceX96ToPrice(2n ** 96n, -1, 18)).toThrow();
    expect(() => sqrtPriceX96ToPrice(2n ** 96n, 100, 18)).toThrow();
  });
});

describe('withSlippage', () => {
  it('reduces amount by the given basis points', () => {
    expect(withSlippage(10_000n, 50)).toBe(9_950n); // 0.5%
    expect(withSlippage(10_000n, 100)).toBe(9_900n); // 1%
    expect(withSlippage(10_000n, 0)).toBe(10_000n);
  });

  it('rejects out-of-range slippage', () => {
    expect(() => withSlippage(100n, -1)).toThrow();
    expect(() => withSlippage(100n, 10_001)).toThrow();
    expect(() => withSlippage(100n, 1.5)).toThrow();
  });
});

describe('computePositionAmounts', () => {
  it('is fully token0-sided when price is below range', () => {
    const res = computePositionAmounts({
      liquidity: 1_000_000n,
      sqrtPriceX96: 2n ** 96n, // price ≈ 1
      tickLower: 10_000,
      tickUpper: 20_000,
    });
    expect(res.amount1).toBe(0);
    expect(res.amount0).toBeGreaterThan(0);
  });

  it('is fully token1-sided when price is above range', () => {
    const res = computePositionAmounts({
      liquidity: 1_000_000n,
      sqrtPriceX96: 2n ** 96n, // price ≈ 1
      tickLower: -20_000,
      tickUpper: -10_000,
    });
    expect(res.amount0).toBe(0);
    expect(res.amount1).toBeGreaterThan(0);
  });

  it('rejects invalid tick order', () => {
    expect(() =>
      computePositionAmounts({
        liquidity: 1n,
        sqrtPriceX96: 2n ** 96n,
        tickLower: 100,
        tickUpper: 100,
      }),
    ).toThrow();
  });
});

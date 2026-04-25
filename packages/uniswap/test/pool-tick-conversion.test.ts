import { describe, it, expect } from 'vitest';
import {
  usdPerAssetToPoolRawPrice,
  poolRawPriceToUsdPerAsset,
  rawPriceToTick,
  usdRangeToPoolTickRange,
  usdPerAssetToSqrtPriceX96,
} from '../src/pool-tick-conversion.js';

// USDC mainnet decimals = 6, WETH mainnet decimals = 18.
const USDC_DEC = 6;
const WETH_DEC = 18;

describe('usdPerAssetToPoolRawPrice', () => {
  it('converts $3500/ETH to ~2.857e8 raw (token1/token0)', () => {
    const raw = usdPerAssetToPoolRawPrice(3500, USDC_DEC, WETH_DEC);
    expect(raw).toBeCloseTo(1e12 / 3500, 0);
  });

  it('round-trips with poolRawPriceToUsdPerAsset', () => {
    const usd = 4250.123;
    const raw = usdPerAssetToPoolRawPrice(usd, USDC_DEC, WETH_DEC);
    const back = poolRawPriceToUsdPerAsset(raw, USDC_DEC, WETH_DEC);
    expect(back).toBeCloseTo(usd, 6);
  });

  it('rejects non-positive prices', () => {
    expect(() => usdPerAssetToPoolRawPrice(0, USDC_DEC, WETH_DEC)).toThrow();
    expect(() => usdPerAssetToPoolRawPrice(-1, USDC_DEC, WETH_DEC)).toThrow();
    expect(() => usdPerAssetToPoolRawPrice(NaN, USDC_DEC, WETH_DEC)).toThrow();
  });

  it('rejects implausible decimals', () => {
    expect(() => usdPerAssetToPoolRawPrice(3500, -1, WETH_DEC)).toThrow();
    expect(() => usdPerAssetToPoolRawPrice(3500, USDC_DEC, 31)).toThrow();
    expect(() => usdPerAssetToPoolRawPrice(3500, 1.5, WETH_DEC)).toThrow();
  });
});

describe('rawPriceToTick', () => {
  it('rawPriceToTick(1) === 0', () => {
    expect(rawPriceToTick(1)).toBe(0);
  });

  it('rawPriceToTick is monotonic', () => {
    expect(rawPriceToTick(2)).toBeGreaterThan(rawPriceToTick(1));
    expect(rawPriceToTick(100)).toBeGreaterThan(rawPriceToTick(50));
  });

  it('USD/ETH=3500 → tick around 195000 (mainnet USDC/WETH range)', () => {
    const raw = usdPerAssetToPoolRawPrice(3500, USDC_DEC, WETH_DEC);
    const tick = rawPriceToTick(raw);
    // Known mainnet USDC/WETH ticks at ~$3500/ETH cluster around 194-196k.
    expect(tick).toBeGreaterThan(190_000);
    expect(tick).toBeLessThan(200_000);
  });
});

describe('usdRangeToPoolTickRange', () => {
  it('produces strictly increasing tick range', () => {
    const { tickLower, tickUpper } = usdRangeToPoolTickRange({
      usdLower: 3300,
      usdUpper: 3700,
      decimals0Stable: USDC_DEC,
      decimals1Asset: WETH_DEC,
      feeTier: 500,
    });
    expect(tickLower).toBeLessThan(tickUpper);
  });

  it('aligns to fee-tier spacing (500 → spacing 10)', () => {
    const { tickLower, tickUpper } = usdRangeToPoolTickRange({
      usdLower: 3300,
      usdUpper: 3700,
      decimals0Stable: USDC_DEC,
      decimals1Asset: WETH_DEC,
      feeTier: 500,
    });
    expect(tickLower % 10).toBe(0);
    expect(tickUpper % 10).toBe(0);
  });

  it('aligns to fee-tier spacing (3000 → spacing 60)', () => {
    const { tickLower, tickUpper } = usdRangeToPoolTickRange({
      usdLower: 2000,
      usdUpper: 5000,
      decimals0Stable: USDC_DEC,
      decimals1Asset: WETH_DEC,
      feeTier: 3000,
    });
    expect(tickLower % 60).toBe(0);
    expect(tickUpper % 60).toBe(0);
  });

  it('inverts: low USD bound contains the higher tick', () => {
    // Sanity: as ETH/USD rises, raw WETH/USDC falls, and tick falls.
    // So usdLower = $3300 (cheap ETH) → token1 expensive in raw → high tick.
    const range = usdRangeToPoolTickRange({
      usdLower: 3300,
      usdUpper: 3700,
      decimals0Stable: USDC_DEC,
      decimals1Asset: WETH_DEC,
      feeTier: 500,
    });
    const tickAt3500 = rawPriceToTick(usdPerAssetToPoolRawPrice(3500, USDC_DEC, WETH_DEC));
    // Current price ($3500) should fall WITHIN the range.
    expect(tickAt3500).toBeGreaterThanOrEqual(range.tickLower);
    expect(tickAt3500).toBeLessThanOrEqual(range.tickUpper);
  });

  it('rejects usdLower >= usdUpper', () => {
    expect(() =>
      usdRangeToPoolTickRange({
        usdLower: 3700,
        usdUpper: 3300,
        decimals0Stable: USDC_DEC,
        decimals1Asset: WETH_DEC,
        feeTier: 500,
      }),
    ).toThrow();
    expect(() =>
      usdRangeToPoolTickRange({
        usdLower: 3500,
        usdUpper: 3500,
        decimals0Stable: USDC_DEC,
        decimals1Asset: WETH_DEC,
        feeTier: 500,
      }),
    ).toThrow();
  });

  it('rejects unknown fee tier', () => {
    expect(() =>
      usdRangeToPoolTickRange({
        usdLower: 3300,
        usdUpper: 3700,
        decimals0Stable: USDC_DEC,
        decimals1Asset: WETH_DEC,
        feeTier: 999,
      }),
    ).toThrow();
  });
});

describe('usdPerAssetToSqrtPriceX96', () => {
  it('produces a positive bigint of plausible mainnet magnitude', () => {
    const sqrtPriceX96 = usdPerAssetToSqrtPriceX96(3500, USDC_DEC, WETH_DEC);
    expect(typeof sqrtPriceX96).toBe('bigint');
    expect(sqrtPriceX96).toBeGreaterThan(0n);
    // For $3500/ETH on USDC/WETH:
    //   raw = 10^12 / 3500 ≈ 2.857e8
    //   sqrt(raw) ≈ 16906
    //   sqrtPriceX96 = sqrt(raw) * 2^96 ≈ 1.34e33
    expect(sqrtPriceX96).toBeGreaterThan(10n ** 32n);
    expect(sqrtPriceX96).toBeLessThan(10n ** 34n);
  });
});

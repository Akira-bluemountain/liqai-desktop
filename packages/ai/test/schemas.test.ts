import { describe, it, expect } from 'vitest';
import {
  SweetSpotResultSchema,
  MAX_REASONABLE_APR,
  MAX_REASONABLE_VOL,
  MAX_TICK_WIDTH,
} from '../src/schemas.js';

describe('SweetSpotResultSchema', () => {
  const valid = {
    tickLower: 69_000,
    tickUpper: 76_000,
    priceLower: 1000,
    priceUpper: 2000,
    expectedApr: 80,
    confidence: 75,
    volatility: 0.3,
  };

  it('accepts a well-formed result', () => {
    expect(() => SweetSpotResultSchema.parse(valid)).not.toThrow();
  });

  it('rejects infinite or NaN fields', () => {
    expect(() =>
      SweetSpotResultSchema.parse({ ...valid, priceLower: Number.POSITIVE_INFINITY }),
    ).toThrow();
    expect(() => SweetSpotResultSchema.parse({ ...valid, volatility: NaN })).toThrow();
  });

  it('rejects non-integer ticks', () => {
    expect(() => SweetSpotResultSchema.parse({ ...valid, tickLower: 69_000.5 })).toThrow();
  });

  it('rejects negative prices', () => {
    expect(() => SweetSpotResultSchema.parse({ ...valid, priceLower: -100 })).toThrow();
    expect(() => SweetSpotResultSchema.parse({ ...valid, priceUpper: 0 })).toThrow();
  });

  it('rejects tickLower >= tickUpper (attacker-controlled malformed output)', () => {
    expect(() =>
      SweetSpotResultSchema.parse({ ...valid, tickLower: 76_000, tickUpper: 76_000 }),
    ).toThrow();
    expect(() =>
      SweetSpotResultSchema.parse({ ...valid, tickLower: 80_000, tickUpper: 76_000 }),
    ).toThrow();
  });

  it('rejects priceLower >= priceUpper', () => {
    expect(() =>
      SweetSpotResultSchema.parse({ ...valid, priceLower: 2000, priceUpper: 2000 }),
    ).toThrow();
  });

  it('rejects absurd APR values (sanity cap)', () => {
    expect(() =>
      SweetSpotResultSchema.parse({ ...valid, expectedApr: MAX_REASONABLE_APR + 1 }),
    ).toThrow();
  });

  it('rejects absurd volatility values (sanity cap)', () => {
    expect(() =>
      SweetSpotResultSchema.parse({ ...valid, volatility: MAX_REASONABLE_VOL + 1 }),
    ).toThrow();
  });

  it('rejects tick widths exceeding MAX_TICK_WIDTH', () => {
    expect(() =>
      SweetSpotResultSchema.parse({
        ...valid,
        tickLower: -MAX_TICK_WIDTH,
        tickUpper: MAX_TICK_WIDTH,
      }),
    ).toThrow();
  });

  it('rejects confidence outside [0, 100]', () => {
    expect(() => SweetSpotResultSchema.parse({ ...valid, confidence: -1 })).toThrow();
    expect(() => SweetSpotResultSchema.parse({ ...valid, confidence: 101 })).toThrow();
  });

  it('rejects extra fields via strict mode? (current schema permissive — documented)', () => {
    // Zod default strips unknown keys. This test documents that behaviour.
    const r = SweetSpotResultSchema.parse({ ...valid, extra: 'ignored' } as unknown);
    expect((r as { extra?: unknown }).extra).toBeUndefined();
  });
});

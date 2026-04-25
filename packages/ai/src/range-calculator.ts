/**
 * Bollinger Band based LP range calculator.
 *
 * TypeScript port of packages/ai-engine/app/services/range_calculator.py
 * (v1 Python implementation).
 *
 * Algorithm:
 *   1. Compute log returns from historical prices: r_t = ln(P_t / P_{t-1})
 *   2. Compute standard deviation of log returns (realised volatility per step)
 *   3. Annualise: σ = σ_step * sqrt(steps_per_year)
 *   4. Compute range bounds: P ± k · σ · sqrt(T/365)
 *   5. Map prices → ticks → aligned ticks (floor lower, ceil upper)
 *   6. Estimate APR from fee rate / range concentration
 *
 * SECURITY (docs/security-v2.md):
 *   - All inputs validated via RangeInputSchema.
 *   - Output is validated via SweetSpotResultSchema before being returned.
 *   - Caller MUST additionally run assertRangeSafeForExecution() before
 *     constructing any transaction.
 */

import {
  RangeInputSchema,
  SweetSpotResultSchema,
  type ValidatedRangeInput,
  type ValidatedSweetSpot,
} from './schemas.js';
import {
  TICK_SPACING,
  FEE_RATE,
  type FeeTier,
} from './types.js';
import {
  priceToTick,
  tickToPrice,
  alignTickFloor,
  alignTickCeil,
  clampTick,
} from './ticks.js';

/** Compute the (sample) standard deviation of a non-empty finite series. */
function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Compute log returns: r_i = ln(P_{i+1} / P_i). */
function logReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const curr = prices[i];
    if (prev === undefined || curr === undefined) continue;
    if (prev <= 0 || curr <= 0) {
      throw new Error('logReturns: prices must be strictly positive');
    }
    out.push(Math.log(curr / prev));
  }
  return out;
}

/**
 * Main entry point: compute the optimal LP range using Bollinger Band method.
 *
 * @param input Unvalidated input. Will be validated against RangeInputSchema.
 * @returns A validated SweetSpotResult. Caller must additionally run
 *          assertRangeSafeForExecution() before turning into a transaction.
 * @throws ZodError on invalid input, Error on numerical failures.
 */
export function calculateSweetSpot(input: unknown): ValidatedSweetSpot {
  // 1. Validate input (throws ZodError on failure)
  const parsed: ValidatedRangeInput = RangeInputSchema.parse(input);

  // 2. Log returns + realised volatility per-step
  const returns = logReturns(parsed.prices);
  const stepVol = stddev(returns);

  // 3. Annualise. We assume the caller is passing a series that spans
  //    `holdingPeriodDays` (i.e. len(prices)/holdingPeriodDays steps per day).
  //    This preserves the v1 behaviour for back-compat.
  const dataPointsPerDay = Math.max(
    1,
    parsed.prices.length / Math.max(1, parsed.holdingPeriodDays),
  );
  const annualisedVol = stepVol * Math.sqrt(dataPointsPerDay * 365);

  // 4. Range bounds around current price.
  const rangeWidth =
    parsed.k * annualisedVol * Math.sqrt(parsed.holdingPeriodDays / 365);
  const upperPrice = parsed.currentPrice * (1 + rangeWidth);
  // Clamp lower price to 1% of current (guards against absurd σ).
  const lowerPrice = Math.max(
    parsed.currentPrice * (1 - rangeWidth),
    parsed.currentPrice * 0.01,
  );

  // 5. Convert to ticks and align to the pool's tick spacing.
  const feeTier = parsed.feeTier as FeeTier;
  const spacing = TICK_SPACING[feeTier];
  const rawLower = priceToTick(lowerPrice);
  const rawUpper = priceToTick(upperPrice);
  let tickLower = clampTick(alignTickFloor(rawLower, spacing));
  let tickUpper = clampTick(alignTickCeil(rawUpper, spacing));

  // Guarantee tickLower < tickUpper (at least one spacing apart).
  if (tickLower >= tickUpper) {
    tickUpper = clampTick(tickLower + spacing);
    if (tickLower >= tickUpper) {
      // Happens only at MAX_TICK boundary; shift lower down.
      tickLower = clampTick(tickUpper - spacing);
    }
  }

  const alignedLower = tickToPrice(tickLower);
  const alignedUpper = tickToPrice(tickUpper);

  // 6. APR estimate (simplified: concentration × fee rate × days/year).
  const feeRate = FEE_RATE[feeTier];
  const concentrationFactor = 1 / Math.max(rangeWidth, 0.01);
  const rawApr = concentrationFactor * feeRate * 365 * 100;
  const expectedApr = Math.min(Math.max(rawApr, 10), 500);

  // Confidence: stable volatility + sufficient data.
  const absReturns = returns.map((r) => Math.abs(r));
  const volStability =
    1 - Math.min(1, stddev(absReturns) / Math.max(stepVol, 1e-10));
  const dataSufficiency = Math.min(1, parsed.prices.length / 1000);
  const confidence = (volStability * 0.6 + dataSufficiency * 0.4) * 100;

  // 7. Validate output before returning. Fails loud if numerical quirks
  //    produce an unsafe result (this is the last defence line inside AI).
  return SweetSpotResultSchema.parse({
    tickLower,
    tickUpper,
    priceLower: Number(alignedLower.toFixed(8)),
    priceUpper: Number(alignedUpper.toFixed(8)),
    expectedApr: Number(expectedApr.toFixed(4)),
    confidence: Number(confidence.toFixed(2)),
    volatility: Number(annualisedVol.toFixed(6)),
  });
}

// Re-export for callers importing from this module directly.
export { assertRangeSafeForExecution } from './schemas.js';

/**
 * Zod schemas for validating every AI engine input and output.
 *
 * SECURITY (docs/security-v2.md S3.4 + S4.1):
 * AI output MUST be validated against these schemas BEFORE being used to
 * construct any on-chain transaction. This is the final defence against
 * malformed / malicious AI results being turned into tx parameters.
 */

import { z } from 'zod';

/** Absolute cap on tick width (prevents absurd ranges). Value derived from
 *  Uniswap V3's MIN/MAX tick (-887272, 887272). A full-range spread is
 *  1,774,544 ticks — we cap at half of that for safety. */
export const MAX_TICK_WIDTH = 887_272;

/** Maximum reasonable APR estimate (sanity cap, prevents UI confusion). */
export const MAX_REASONABLE_APR = 1000;

/** Maximum reasonable annualised volatility (500%). Anything higher indicates
 *  garbage input. */
export const MAX_REASONABLE_VOL = 5.0;

const FEE_TIERS = [100, 500, 3000, 10_000] as const;

/** Schema for a positive finite number. */
const positiveFinite = z
  .number()
  .finite('must be finite')
  .positive('must be > 0');

/** Schema for SweetSpotResult. Used to validate AI output before tx building. */
export const SweetSpotResultSchema = z
  .object({
    tickLower: z.number().int().finite(),
    tickUpper: z.number().int().finite(),
    priceLower: positiveFinite,
    priceUpper: positiveFinite,
    expectedApr: z
      .number()
      .finite()
      .nonnegative()
      .max(MAX_REASONABLE_APR, `expectedApr exceeds ${MAX_REASONABLE_APR}% sanity cap`),
    confidence: z.number().min(0).max(100),
    volatility: z
      .number()
      .finite()
      .nonnegative()
      .max(MAX_REASONABLE_VOL, `volatility exceeds ${MAX_REASONABLE_VOL * 100}% sanity cap`),
  })
  .refine((v) => v.tickLower < v.tickUpper, {
    message: 'tickLower must be strictly less than tickUpper',
    path: ['tickUpper'],
  })
  .refine((v) => v.priceLower < v.priceUpper, {
    message: 'priceLower must be strictly less than priceUpper',
    path: ['priceUpper'],
  })
  .refine((v) => v.tickUpper - v.tickLower <= MAX_TICK_WIDTH, {
    message: `tick width exceeds safety cap (${MAX_TICK_WIDTH})`,
    path: ['tickUpper'],
  });

export type ValidatedSweetSpot = z.infer<typeof SweetSpotResultSchema>;

/** Input schema for range calculation. */
export const RangeInputSchema = z.object({
  prices: z
    .array(positiveFinite)
    .min(10, 'at least 10 price data points required')
    .max(100_000, 'too many price points (bounded for safety)'),
  currentPrice: positiveFinite,
  feeTier: z
    .number()
    .int()
    .refine((v) => (FEE_TIERS as readonly number[]).includes(v), {
      message: `feeTier must be one of ${FEE_TIERS.join(', ')}`,
    }),
  holdingPeriodDays: z.number().positive().max(365).default(7),
  k: z.number().positive().max(10).default(1.5),
});

export type ValidatedRangeInput = z.infer<typeof RangeInputSchema>;

/** Assert that an AI-produced range is within safe bounds RELATIVE to the
 *  current market price. This is the last line of defence before the range
 *  is turned into a transaction.
 *
 *  Rejects ranges where:
 *   - the current price is not even between lower and upper (AI mis-centered)
 *   - the range is narrower than 0.1% of current price (dust range)
 *   - the range spans more than ±90% of current price (useless wide range)
 *
 * @throws Error if the range fails safety checks.
 */
export function assertRangeSafeForExecution(
  range: ValidatedSweetSpot,
  currentPrice: number,
): void {
  if (!(Number.isFinite(currentPrice) && currentPrice > 0)) {
    throw new Error('assertRangeSafeForExecution: invalid currentPrice');
  }

  // The range must bracket the current price (otherwise the LP would be
  // single-sided and earn nothing until price re-enters).
  if (currentPrice < range.priceLower || currentPrice > range.priceUpper) {
    throw new Error(
      `range does not bracket current price (current=${currentPrice}, ` +
        `range=[${range.priceLower}, ${range.priceUpper}])`,
    );
  }

  const relativeWidth = (range.priceUpper - range.priceLower) / currentPrice;
  if (relativeWidth < 0.001) {
    throw new Error(
      `range too narrow (${(relativeWidth * 100).toFixed(4)}% of current price)`,
    );
  }
  if (relativeWidth > 1.8) {
    throw new Error(
      `range too wide (${(relativeWidth * 100).toFixed(2)}% of current price)`,
    );
  }
}

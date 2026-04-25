/**
 * Rebalance trigger evaluator.
 *
 * TypeScript port of packages/ai-engine/app/services/rebalance_evaluator.py
 * (v1 Python implementation).
 *
 * Triggers (in priority order by confidence):
 *   1. Range exit full:    price outside [priceLower, priceUpper]  (conf 99%)
 *   2. Crash / surge:      |Δ5min| ≥ 5%                             (conf 95%)
 *   3. Range exit boundary:price at 95% of range boundary           (conf 90%)
 *   4. Spike / dip:        |Δ5min| ≥ 3%                             (conf 85%)
 *   5. Wick:               candle wick > 2× body                    (conf 75%)
 *
 * SECURITY: The result is a RECOMMENDATION only. The caller must validate the
 * new range via assertRangeSafeForExecution() before building any transaction.
 */

import { z } from 'zod';
import { calculateSweetSpot } from './range-calculator.js';
import type {
  RebalanceEvalInput,
  RebalanceEvalResult,
  RebalanceTrigger,
  SweetSpotResult,
} from './types.js';

const finite = z.number().finite();

/** Input schema for rebalance evaluation. */
const RebalanceEvalInputSchema = z
  .object({
    currentPrice: finite.positive(),
    tickLower: z.number().int().finite(),
    tickUpper: z.number().int().finite(),
    priceLower: finite.positive(),
    priceUpper: finite.positive(),
    recentPrices: z
      .array(finite.positive())
      .min(3, 'need at least 3 recent prices for wick detection')
      .max(10_000),
    timestamps: z.array(finite.nonnegative()).min(3).max(10_000),
  })
  .refine((v) => v.tickLower < v.tickUpper, {
    message: 'tickLower must be strictly less than tickUpper',
    path: ['tickUpper'],
  })
  .refine((v) => v.priceLower < v.priceUpper, {
    message: 'priceLower must be strictly less than priceUpper',
    path: ['priceUpper'],
  })
  .refine((v) => v.recentPrices.length === v.timestamps.length, {
    message: 'recentPrices and timestamps must have equal length',
    path: ['timestamps'],
  });

interface Trigger {
  readonly trigger: RebalanceTrigger;
  readonly confidence: number;
  readonly reason: string;
}

/** Find the first index whose timestamp ≥ target. Returns 0 if none. */
function findTimeIndex(timestamps: readonly number[], target: number): number {
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    if (ts !== undefined && ts >= target) return i;
  }
  return 0;
}

/**
 * Evaluate rebalance trigger conditions.
 *
 * @param input Unvalidated input. Will be validated against the input schema.
 * @param feeTier Fee tier to use when calculating the new range (default 3000).
 * @returns RebalanceEvalResult. If shouldRebalance is true, `newRange`
 *          contains the AI-proposed range. Callers MUST validate with
 *          assertRangeSafeForExecution() before using.
 */
export function evaluateRebalance(
  input: unknown,
  feeTier: 100 | 500 | 3000 | 10_000 = 3000,
): RebalanceEvalResult {
  const parsed = RebalanceEvalInputSchema.parse(input);
  const triggers: Trigger[] = [];

  // ── Trigger 1 & 3: Range exit ────────────────────────────────────
  const rangeSize = parsed.priceUpper - parsed.priceLower;
  if (rangeSize > 0) {
    if (
      parsed.currentPrice > parsed.priceUpper ||
      parsed.currentPrice < parsed.priceLower
    ) {
      triggers.push({
        trigger: 'range_exit',
        confidence: 99,
        reason:
          `Price (${parsed.currentPrice.toFixed(4)}) outside ` +
          `[${parsed.priceLower.toFixed(4)}, ${parsed.priceUpper.toFixed(4)}]`,
      });
    } else {
      const upperBoundary = parsed.priceLower + rangeSize * 0.95;
      const lowerBoundary = parsed.priceLower + rangeSize * 0.05;
      if (parsed.currentPrice >= upperBoundary) {
        triggers.push({
          trigger: 'range_exit',
          confidence: 90,
          reason: `Price (${parsed.currentPrice.toFixed(4)}) at upper 95% boundary`,
        });
      } else if (parsed.currentPrice <= lowerBoundary) {
        triggers.push({
          trigger: 'range_exit',
          confidence: 90,
          reason: `Price (${parsed.currentPrice.toFixed(4)}) at lower 5% boundary`,
        });
      }
    }
  }

  // ── Trigger 2 & 4: Spike / dip over 5 min ────────────────────────
  if (parsed.timestamps.length >= 5) {
    const lastTs = parsed.timestamps[parsed.timestamps.length - 1];
    if (lastTs !== undefined) {
      const fiveMinAgo = lastTs - 300;
      const idx = findTimeIndex(parsed.timestamps, fiveMinAgo);
      const refPrice = parsed.recentPrices[idx];
      if (refPrice !== undefined && refPrice > 0) {
        const change = (parsed.currentPrice - refPrice) / refPrice;
        const absChange = Math.abs(change);
        if (absChange >= 0.05) {
          triggers.push({
            trigger: change >= 0 ? 'spike' : 'dip',
            confidence: 95,
            reason: `Crash/surge ${(change * 100).toFixed(2)}% in 5 minutes`,
          });
        } else if (absChange >= 0.03) {
          triggers.push({
            trigger: change >= 0 ? 'spike' : 'dip',
            confidence: 85,
            reason: `${change >= 0 ? 'Spike' : 'Dip'} ${(change * 100).toFixed(2)}% in 5 minutes`,
          });
        }
      }
    }
  }

  // ── Trigger 5: Wick detection (last 3 candles) ───────────────────
  // A "long wick" is a meaningful candle body with a tail at least 2.5× the
  // body. The original implementation only checked `body > 0 && wick > 2*body`,
  // which fires constantly on flat hourly data: tiny body 1¢, tiny wick 3¢
  // satisfies the ratio but isn't a real signal. We now require:
  //   - body is at least MIN_BODY_PCT of current price (real candle, not noise)
  //   - wick is at least MIN_WICK_PCT of current price (meaningful tail)
  //   - wick > WICK_BODY_RATIO × body (long-wick shape)
  //
  // Tuning history (2026-04-17): after observing 4 wick rebalances in ~26h
  // with MIN_BODY=0.3%, MIN_WICK=1.0%, WICK_RATIO=2.0 — the signal fired on
  // normal volatile-but-trending hours, not just genuine wicks. Tightened
  // thresholds so wick only fires on truly outsized tails. Cooldown in
  // useRebalanceBot provides the second line of defence.
  const MIN_BODY_PCT = 0.005; // 0.5% of price
  const MIN_WICK_PCT = 0.015; // 1.5% of price
  const WICK_BODY_RATIO = 2.5;
  if (parsed.recentPrices.length >= 3 && parsed.currentPrice > 0) {
    const n = parsed.recentPrices.length;
    const last3 = parsed.recentPrices.slice(n - 3, n);
    const open = last3[0]!;
    const close = last3[last3.length - 1]!;
    const high = Math.max(...last3);
    const low = Math.min(...last3);
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const minBodyAbs = parsed.currentPrice * MIN_BODY_PCT;
    const minWickAbs = parsed.currentPrice * MIN_WICK_PCT;
    const longUpperWick =
      upperWick >= minWickAbs && upperWick > body * WICK_BODY_RATIO;
    const longLowerWick =
      lowerWick >= minWickAbs && lowerWick > body * WICK_BODY_RATIO;
    if (body >= minBodyAbs && (longUpperWick || longLowerWick)) {
      triggers.push({
        trigger: 'wick',
        confidence: 75,
        reason:
          `Long wick (body=${body.toFixed(4)}, ` +
          `up=${upperWick.toFixed(4)}, down=${lowerWick.toFixed(4)}, ` +
          `min body ${minBodyAbs.toFixed(2)} / wick ${minWickAbs.toFixed(2)})`,
      });
    }
  }

  if (triggers.length === 0) {
    return {
      shouldRebalance: false,
      trigger: null,
      confidence: 0,
      reason: 'No rebalance triggers detected',
    };
  }

  // Pick the highest confidence trigger.
  const best = triggers.reduce((a, b) => (b.confidence > a.confidence ? b : a));

  // Compute the proposed new range. Errors here are converted to a "no
  // rebalance" recommendation rather than throwing — the AI should never
  // force a rebalance with invalid parameters.
  let newRange: SweetSpotResult | undefined;
  try {
    newRange = calculateSweetSpot({
      prices: parsed.recentPrices,
      currentPrice: parsed.currentPrice,
      feeTier,
      holdingPeriodDays: 7,
    });
  } catch (err) {
    return {
      shouldRebalance: false,
      trigger: null,
      confidence: 0,
      reason:
        'Trigger fired but new range calculation failed: ' +
        (err instanceof Error ? err.message : 'unknown'),
    };
  }

  return {
    shouldRebalance: true,
    trigger: best.trigger,
    confidence: best.confidence,
    reason: best.reason,
    newRange,
  };
}

// Export the input schema for callers that want to validate ahead of time.
export { RebalanceEvalInputSchema };
export type { RebalanceEvalInput };

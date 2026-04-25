/**
 * Shared types for the LiqAI AI engine.
 *
 * Security note: every type crossing a trust boundary (e.g., RPC → AI, AI → tx builder)
 * must have a matching Zod schema. See schemas.ts.
 */

/** Uniswap V3 fee tier (basis points / 10000). */
export type FeeTier = 100 | 500 | 3000 | 10000;

/** Tick spacing per fee tier (Uniswap V3 canonical). */
export const TICK_SPACING: Record<FeeTier, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

/** Decimal fee rate per fee tier (e.g., 500 → 0.0005). */
export const FEE_RATE: Record<FeeTier, number> = {
  100: 0.0001,
  500: 0.0005,
  3000: 0.003,
  10000: 0.01,
};

/** Result of an optimal-range calculation (AI sweet-spot output). */
export interface SweetSpotResult {
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly priceLower: number;
  readonly priceUpper: number;
  readonly expectedApr: number;
  readonly confidence: number;
  /** Annualised volatility used to derive the range. */
  readonly volatility: number;
}

/** Input for the rebalance trigger evaluator. */
export interface RebalanceEvalInput {
  readonly currentPrice: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly priceLower: number;
  readonly priceUpper: number;
  /** Ordered oldest → newest. */
  readonly recentPrices: readonly number[];
  /** Unix seconds, same ordering as recentPrices. */
  readonly timestamps: readonly number[];
}

/** The trigger that caused a rebalance recommendation. */
export type RebalanceTrigger =
  | 'range_exit'
  | 'spike'
  | 'dip'
  | 'wick'
  | 'scheduled';

export interface RebalanceEvalResult {
  readonly shouldRebalance: boolean;
  readonly trigger: RebalanceTrigger | null;
  readonly confidence: number;
  readonly reason: string;
  readonly newRange?: SweetSpotResult;
}

/** Configuration for range calculation. Defaults are conservative. */
export interface RangeConfig {
  /** Holding period in days (default 7). */
  readonly holdingPeriodDays: number;
  /** Bollinger multiplier (default 1.5 ≈ 87% price capture). */
  readonly k: number;
}

export const DEFAULT_RANGE_CONFIG: RangeConfig = {
  holdingPeriodDays: 7,
  k: 1.5,
};

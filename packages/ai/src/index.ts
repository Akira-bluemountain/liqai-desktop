/**
 * @liqai/ai — LP range optimisation and rebalance triggers.
 *
 * Public API surface. Everything below is safe to import from the
 * desktop app. Internal helpers are not re-exported.
 */

export { calculateSweetSpot } from './range-calculator.js';
export { evaluateRebalance } from './rebalance-evaluator.js';
export {
  SweetSpotResultSchema,
  RangeInputSchema,
  assertRangeSafeForExecution,
  MAX_TICK_WIDTH,
  MAX_REASONABLE_APR,
  MAX_REASONABLE_VOL,
} from './schemas.js';
export {
  priceToTick,
  tickToPrice,
  alignTickFloor,
  alignTickCeil,
  clampTick,
  MIN_TICK,
  MAX_TICK,
} from './ticks.js';
export {
  TICK_SPACING,
  FEE_RATE,
  DEFAULT_RANGE_CONFIG,
  type FeeTier,
  type SweetSpotResult,
  type RebalanceEvalInput,
  type RebalanceEvalResult,
  type RebalanceTrigger,
  type RangeConfig,
} from './types.js';
export {
  CoinGeckoProvider,
  MemoryPriceCache,
  PriceFetcher,
  type PriceProvider,
  type PriceCache,
  type PriceSeries,
  type FetchOptions,
} from './price-fetcher.js';

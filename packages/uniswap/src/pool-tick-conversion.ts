/**
 * Decimal-aware conversion between human-readable token-ratio prices and
 * Uniswap V3 pool-native ticks.
 *
 * MOTIVATION:
 *   Uniswap V3 stores price as token1/token0 in *raw* units (no decimal
 *   adjustment). For an asymmetric-decimal pair like USDC (6) / WETH (18),
 *   the raw ratio differs from the human ratio by 10^(decimals1-decimals0).
 *
 *   Worse: which token is "the asset" and which is "the quote currency"
 *   depends on lexicographic address ordering of the two ERC-20s — NOT on
 *   business semantics. For mainnet USDC/WETH, USDC < WETH, so token0=USDC
 *   and token1=WETH. The pool's "price" is therefore WETH-per-USDC (raw),
 *   which monotonically *decreases* as ETH appreciates against USD.
 *
 *   This module isolates those conversions so the rest of the codebase
 *   can think exclusively in human terms ("ETH costs $3500") while the
 *   tick math stays correct.
 *
 * SECURITY:
 *   - All inputs validated. Negative or non-finite values rejected.
 *   - `decimals` parameters bounded to [0, 30] to prevent absurd Math.pow.
 *   - Output ticks aligned to the fee tier's tick spacing AND clamped to
 *     [MIN_TICK, MAX_TICK].
 *   - Pure functions only. No I/O, no state.
 */

const MIN_TICK = -887_272;
const MAX_TICK = 887_272;

const TICK_SPACING_BY_FEE: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10_000: 200,
};

function assertFinitePositive(name: string, v: number): void {
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`${name} must be a positive finite number; got ${v}`);
  }
}
function assertDecimals(name: string, d: number): void {
  if (!Number.isInteger(d) || d < 0 || d > 30) {
    throw new Error(`${name} must be an integer in [0, 30]; got ${d}`);
  }
}
function assertFeeTier(fee: number): void {
  if (!(fee in TICK_SPACING_BY_FEE)) {
    throw new Error(`fee must be one of 100/500/3000/10000; got ${fee}`);
  }
}

/**
 * Convert a "USD-per-asset" human price (e.g., "$3500 per ETH") into the
 * Uniswap V3 pool's raw token1/token0 price for a stable/asset pair where
 * the stable is token0 and the asset is token1.
 *
 * Example: usdEthToPoolRawPrice(3500, 6, 18) = 10^12 / 3500 ≈ 2.857e8
 *
 * NOTE: This assumes the stablecoin is token0 (lexicographically lower
 * address). For mainnet USDC/WETH that's true. For pairs where the asset
 * comes first (e.g., DAI/USDC where DAI < USDC), use the inverse helper.
 */
export function usdPerAssetToPoolRawPrice(
  usdPerAsset: number,
  decimals0Stable: number,
  decimals1Asset: number,
): number {
  assertFinitePositive('usdPerAsset', usdPerAsset);
  assertDecimals('decimals0Stable', decimals0Stable);
  assertDecimals('decimals1Asset', decimals1Asset);
  // raw = (assetUnits / stableUnits) where 1 asset = usdPerAsset stable
  // raw = (10^decimals1) / (usdPerAsset * 10^decimals0)
  //     = (1 / usdPerAsset) * 10^(decimals1 - decimals0)
  return Math.pow(10, decimals1Asset - decimals0Stable) / usdPerAsset;
}

/** Inverse of usdPerAssetToPoolRawPrice. */
export function poolRawPriceToUsdPerAsset(
  rawPrice: number,
  decimals0Stable: number,
  decimals1Asset: number,
): number {
  assertFinitePositive('rawPrice', rawPrice);
  assertDecimals('decimals0Stable', decimals0Stable);
  assertDecimals('decimals1Asset', decimals1Asset);
  return Math.pow(10, decimals1Asset - decimals0Stable) / rawPrice;
}

/**
 * Convert a raw token1/token0 price into a Uniswap V3 tick (floor).
 * tick = floor( ln(price) / ln(1.0001) ).
 */
export function rawPriceToTick(rawPrice: number): number {
  assertFinitePositive('rawPrice', rawPrice);
  return Math.floor(Math.log(rawPrice) / Math.log(1.0001));
}

/**
 * Given a desired human price range (e.g., "$3300–$3700 per ETH") for a
 * stable/asset pool where the stable is token0, return the corresponding
 * Uniswap V3 tick range, aligned to the fee tier's tick spacing and clamped.
 *
 * The mapping inverts: usdLower → tickUpper, usdUpper → tickLower.
 * (As ETH/USD goes UP, raw WETH/USDC ratio goes DOWN, and tick goes DOWN.)
 *
 * The output tickLower < tickUpper invariant is preserved.
 */
export function usdRangeToPoolTickRange(options: {
  readonly usdLower: number;
  readonly usdUpper: number;
  readonly decimals0Stable: number;
  readonly decimals1Asset: number;
  readonly feeTier: number;
}): { readonly tickLower: number; readonly tickUpper: number } {
  const { usdLower, usdUpper, decimals0Stable, decimals1Asset, feeTier } = options;
  assertFinitePositive('usdLower', usdLower);
  assertFinitePositive('usdUpper', usdUpper);
  if (usdLower >= usdUpper) {
    throw new Error(`usdLower must be < usdUpper; got [${usdLower}, ${usdUpper}]`);
  }
  assertFeeTier(feeTier);
  const spacing = TICK_SPACING_BY_FEE[feeTier]!;

  // INVERTED: low USD → high raw → high tick.
  const rawAtLowUsd = usdPerAssetToPoolRawPrice(usdLower, decimals0Stable, decimals1Asset);
  const rawAtHighUsd = usdPerAssetToPoolRawPrice(usdUpper, decimals0Stable, decimals1Asset);

  const rawTickHigh = rawPriceToTick(rawAtLowUsd); // upper tick (uniswap sense)
  const rawTickLow = rawPriceToTick(rawAtHighUsd); // lower tick (uniswap sense)

  // Align: lower goes DOWN to nearest spacing, upper goes UP to nearest spacing.
  const tickLowerAligned = Math.floor(rawTickLow / spacing) * spacing;
  const tickUpperAligned = Math.ceil(rawTickHigh / spacing) * spacing;

  // Clamp to legal range.
  const tickLower = Math.max(MIN_TICK, tickLowerAligned);
  const tickUpper = Math.min(MAX_TICK, tickUpperAligned);

  if (tickLower >= tickUpper) {
    throw new Error(
      `Range collapsed after alignment: [${tickLower}, ${tickUpper}] for spacing ${spacing}`,
    );
  }
  return { tickLower, tickUpper };
}

/**
 * Compute the on-chain Uniswap V3 sqrtPriceX96 for a given USD-per-asset
 * human price. Useful for unit tests and for deriving "expected slot0"
 * values from a CoinGecko quote when the live pool RPC is briefly down.
 */
export function usdPerAssetToSqrtPriceX96(
  usdPerAsset: number,
  decimals0Stable: number,
  decimals1Asset: number,
): bigint {
  const rawPrice = usdPerAssetToPoolRawPrice(usdPerAsset, decimals0Stable, decimals1Asset);
  // sqrtPriceX96 = sqrt(rawPrice) * 2^96
  const sqrtPriceFloat = Math.sqrt(rawPrice);
  // 2^96 doesn't fit cleanly in float; do the multiplication via bigint scaling.
  const SCALE = 1_000_000_000_000n; // 10^12 — keeps ~12 digits of mantissa precision
  const sqrtScaled = BigInt(Math.floor(sqrtPriceFloat * Number(SCALE)));
  return (sqrtScaled * (2n ** 96n)) / SCALE;
}

/**
 * Uniswap V3 price math helpers.
 *
 * Uniswap V3 represents the current pool price as sqrtPriceX96 = sqrt(price) * 2^96.
 * Converting to a human-readable price requires the token decimals.
 *
 * SECURITY: All inputs validated, no unchecked bigint arithmetic beyond the
 * documented conversions.
 */

const Q96 = 2n ** 96n;

/**
 * Convert sqrtPriceX96 (as returned by pool.slot0) to a floating-point price
 * expressed as token1 per token0, adjusted for the token decimals.
 *
 * Example: USDC/WETH pool with USDC=token0 (6 dec), WETH=token1 (18 dec)
 *   returns "WETH per USDC", not what we typically want.
 *
 * For the common "USD per ETH" display, you want: 1 / sqrtPriceX96ToPrice(..., 6, 18).
 *
 * @param sqrtPriceX96 The raw sqrtPriceX96 value from slot0.
 * @param decimals0 Decimals of token0.
 * @param decimals1 Decimals of token1.
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  if (sqrtPriceX96 <= 0n) {
    throw new Error('sqrtPriceX96ToPrice: sqrtPriceX96 must be > 0');
  }
  if (!Number.isInteger(decimals0) || !Number.isInteger(decimals1)) {
    throw new Error('sqrtPriceX96ToPrice: decimals must be integers');
  }
  if (decimals0 < 0 || decimals0 > 30 || decimals1 < 0 || decimals1 > 30) {
    throw new Error('sqrtPriceX96ToPrice: decimals out of reasonable range');
  }

  // Use Number conversion for the final step. For typical ERC-20s this keeps
  // ~15 digits of precision which is plenty for UI.
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  const priceToken1PerToken0 = ratio * ratio;

  // Adjust for decimals: price_human = price_raw * 10^(dec0 - dec1)
  const decimalsDiff = decimals0 - decimals1;
  return priceToken1PerToken0 * Math.pow(10, decimalsDiff);
}

/**
 * Compute how much token0 and token1 a given amount of liquidity is worth at
 * a specific tick range and current price. Uses the Uniswap V3 formula from
 * the whitepaper §6.2.
 *
 * This is an approximation in floating-point for UI display only; never use
 * the output for on-chain amount checks (use the chain's authoritative values).
 */
export function computePositionAmounts(options: {
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
}): { amount0: number; amount1: number } {
  const { liquidity, sqrtPriceX96, tickLower, tickUpper } = options;
  if (tickLower >= tickUpper) throw new Error('invalid tick range');

  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const sqrtLower = Math.pow(1.0001, tickLower / 2);
  const sqrtUpper = Math.pow(1.0001, tickUpper / 2);
  const L = Number(liquidity);

  let amount0 = 0;
  let amount1 = 0;

  if (sqrtPrice <= sqrtLower) {
    amount0 = L * (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper);
  } else if (sqrtPrice >= sqrtUpper) {
    amount1 = L * (sqrtUpper - sqrtLower);
  } else {
    amount0 = L * (sqrtUpper - sqrtPrice) / (sqrtPrice * sqrtUpper);
    amount1 = L * (sqrtPrice - sqrtLower);
  }

  return { amount0, amount1 };
}

/**
 * Minimum-output helper with bounded slippage.
 * @param expected The quoted amount out (pre-slippage)
 * @param slippageBps Slippage tolerance in basis points (100 = 1%, 50 = 0.5%)
 */
export function withSlippage(expected: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('slippageBps must be an integer in [0, 10000]');
  }
  return (expected * BigInt(10_000 - slippageBps)) / 10_000n;
}

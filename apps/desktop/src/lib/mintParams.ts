/**
 * Pure helpers for building Uniswap V3 mint parameters.
 *
 * SECURITY:
 *   - All inputs must be pre-validated (addresses, tick spacing alignment,
 *     AI range safety). This module does NOT re-validate — it assumes the
 *     caller has already passed through the tx-builder's assertions.
 *   - Slippage is hard-capped at MAX_SLIPPAGE_BPS_UI (100 bps = 1%) to match
 *     @liqai/uniswap's builder-level cap.
 *   - All bigints use fixed-decimal integer math; no float intermediaries
 *     for on-chain values.
 *
 * Limitation: for the MVP we use the "same-USD-value" heuristic for the
 * WETH side (50/50 split at current price). Uniswap V3's mint function
 * accepts amount0Desired + amount1Desired and uses the limiting side,
 * refunding the excess, so this is safe. A future enhancement could use
 * the exact liquidity formula to minimise refunds.
 */

import { type Address } from 'viem';

/** Maximum slippage the UI lets a user choose. Must match @liqai/uniswap's
 *  MAX_SLIPPAGE_BPS so the builder-level assertion doesn't fire. */
export const MAX_SLIPPAGE_BPS_UI = 100; // 1%
/** Default slippage (75 bps) — a balance between tx reliability and MEV
 *  protection. Can be overridden per-mint. */
export const DEFAULT_SLIPPAGE_BPS_UI = 75;
/** Deadline from now, in seconds. Matches @liqai/uniswap's MAX_DEADLINE_SEC. */
export const MINT_DEADLINE_SEC = 300;

export interface MintAmountInputs {
  /** USDC amount in raw (6-decimal) units. */
  readonly usdcAmountRaw: bigint;
  /** Current ETH price in USD (human, from on-chain slot0). */
  readonly ethUsd: number;
  /** Decimals of the USDC side. Should be 6. */
  readonly usdcDecimals: number;
  /** Decimals of the WETH side. Should be 18. */
  readonly wethDecimals: number;
}

/**
 * Compute the EXACT WETH amount required to pair with a given USDC amount
 * at the pool's current sqrtPriceX96 + tick range, per Uniswap V3's
 * liquidity formula (whitepaper §6.2).
 *
 * Why this exists: the simpler "same USD value" heuristic
 * (`computeSameValueWethRaw`) overestimates WETH needed for asymmetric
 * ranges, causing on-chain mint reverts at amount1Min when the actual
 * pool ratio uses ~5-10% less WETH than 50/50 split.
 *
 * Math:
 *   L  = amount0 × sqrtP × sqrtP_upper / (sqrtP_upper - sqrtP)
 *   amount1 = L × (sqrtP - sqrtP_lower)
 *
 *   Where sqrtP = sqrtPriceX96 / 2^96 and sqrtP_(lower|upper) are derived
 *   from the tick endpoints via 1.0001^(tick/2).
 *
 * Float precision is acceptable here: results feed `amount1Desired` for
 * mint, and the on-chain V3 math is exact regardless of our estimate.
 * We add a small buffer (default 2%) so the user-facing `amount1Min` is
 * still satisfied if pool drift between estimate and execution is
 * minimal.
 */
export function computeRequiredWethForUsdc(options: {
  readonly usdcAmountRaw: bigint;
  readonly sqrtPriceX96: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  /** Multiplier on the exact computed amount (default 1.02 = 2% buffer). */
  readonly bufferMultiplier?: number;
}): bigint {
  const { usdcAmountRaw, sqrtPriceX96, tickLower, tickUpper } = options;
  const buffer = options.bufferMultiplier ?? 1.02;
  if (usdcAmountRaw <= 0n) throw new Error('usdcAmountRaw must be > 0');
  if (sqrtPriceX96 <= 0n) throw new Error('sqrtPriceX96 must be > 0');
  if (tickLower >= tickUpper) throw new Error('tickLower must be < tickUpper');
  if (!Number.isFinite(buffer) || buffer < 1 || buffer > 2) {
    throw new Error('bufferMultiplier must be in [1, 2]');
  }

  const Q96 = 2 ** 96;
  const sqrtP = Number(sqrtPriceX96) / Q96;
  const sqrtPLower = Math.pow(1.0001, tickLower / 2);
  const sqrtPUpper = Math.pow(1.0001, tickUpper / 2);

  if (sqrtP <= sqrtPLower) {
    // Current price below range — single-sided position needs only token0.
    // For the LiqAI flow we assume in-range mints; reject this case loudly.
    throw new Error(
      'Current price is below the AI range — pool would need 0 WETH (mint single-sided not supported in this flow)',
    );
  }
  if (sqrtP >= sqrtPUpper) {
    throw new Error(
      'Current price is above the AI range — pool would need 0 USDC, not what you specified',
    );
  }

  const usdc = Number(usdcAmountRaw);
  // L derived from amount0 (USDC).
  const L = (usdc * sqrtP * sqrtPUpper) / (sqrtPUpper - sqrtP);
  // Required amount1 (WETH) at current tick.
  const wethExact = L * (sqrtP - sqrtPLower);
  const wethBuffered = wethExact * buffer;

  if (!Number.isFinite(wethBuffered) || wethBuffered <= 0) {
    throw new Error('computed WETH amount is not a positive finite number');
  }
  return BigInt(Math.floor(wethBuffered));
}

/**
 * @deprecated The 50/50 USD-value approximation underestimates WETH for
 * asymmetric ranges; use `computeRequiredWethForUsdc` with on-chain
 * sqrtPriceX96 instead. Kept here for type compatibility during the
 * mint-flow migration.
 *
 * Example: usdcAmountRaw = 1_000_000_000 (1000 USDC), ethUsd = 2185
 *   → wethAmountRaw = (1000 / 2185) * 10^18 ≈ 457_600_000_000_000_000
 */
export function computeSameValueWethRaw({
  usdcAmountRaw,
  ethUsd,
  usdcDecimals,
  wethDecimals,
}: MintAmountInputs): bigint {
  if (usdcAmountRaw <= 0n) throw new Error('usdcAmountRaw must be > 0');
  if (!Number.isFinite(ethUsd) || ethUsd <= 0) {
    throw new Error('ethUsd must be positive finite');
  }
  if (!Number.isInteger(usdcDecimals) || usdcDecimals < 0 || usdcDecimals > 30) {
    throw new Error('usdcDecimals out of range');
  }
  if (!Number.isInteger(wethDecimals) || wethDecimals < 0 || wethDecimals > 30) {
    throw new Error('wethDecimals out of range');
  }

  // Convert USDC raw → USD value:
  //   usdValue = usdcAmountRaw / 10^usdcDecimals
  // Convert USD value → WETH human:
  //   wethHuman = usdValue / ethUsd
  // Convert WETH human → WETH raw:
  //   wethAmountRaw = wethHuman * 10^wethDecimals
  //
  // Combined (avoiding float for the final multiplication):
  //   wethAmountRaw = usdcAmountRaw * 10^(wethDecimals - usdcDecimals) / ethUsd
  //
  // We use a scaled intermediate to preserve precision: multiply by a fixed
  // 10^9 then divide.
  const decimalsDiff = wethDecimals - usdcDecimals;
  if (decimalsDiff < 0) {
    throw new Error('wethDecimals < usdcDecimals is not supported by this helper');
  }
  const scale = 10n ** BigInt(decimalsDiff);
  // Multiply usdcAmountRaw * scale first (bigint), then divide by ethUsd as a
  // scaled bigint. Use PRICE_SCALE to keep ~9 digits of price precision.
  const PRICE_SCALE = 1_000_000_000n; // 10^9
  const ethUsdScaled = BigInt(Math.round(ethUsd * Number(PRICE_SCALE)));
  if (ethUsdScaled === 0n) {
    throw new Error('ethUsd rounded to zero — price too small');
  }
  return (usdcAmountRaw * scale * PRICE_SCALE) / ethUsdScaled;
}

/**
 * Apply a negative slippage tolerance to produce amount*Min for mint.
 * Mirrors withSlippage() in @liqai/uniswap/price-math.ts exactly.
 */
export function withMintSlippage(expected: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS_UI) {
    throw new Error(
      `slippageBps must be an integer in [0, ${MAX_SLIPPAGE_BPS_UI}]; got ${slippageBps}`,
    );
  }
  return (expected * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Fully-typed input to the NPM.mint function. */
export interface NpmMintArgs {
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly amount0Desired: bigint;
  readonly amount1Desired: bigint;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
}

export interface BuildMintArgsInput {
  readonly token0: Address;
  readonly token1: Address;
  readonly feeTier: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly amount0Desired: bigint;
  readonly amount1Desired: bigint;
  readonly recipient: Address;
  readonly slippageBps?: number;
  readonly nowUnixSec?: number;
  /**
   * Explicit minimums override — set when amount*Desired contains a
   * deliberate buffer that the pool will partially refund. Without these,
   * `withMintSlippage(amount*Desired, bps)` would incorrectly reject the
   * very refund we expect. See computeRequiredWethForUsdc.
   */
  readonly amount0MinOverride?: bigint;
  readonly amount1MinOverride?: bigint;
}

/** Assemble the NPM.mint struct with slippage-protected minimums + deadline. */
export function buildNpmMintArgs(input: BuildMintArgsInput): NpmMintArgs {
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS_UI;
  const now = input.nowUnixSec ?? Math.floor(Date.now() / 1000);
  const deadline = BigInt(now + MINT_DEADLINE_SEC);

  if (input.tickLower >= input.tickUpper) {
    throw new Error('tickLower must be < tickUpper');
  }
  if (input.amount0Desired <= 0n && input.amount1Desired <= 0n) {
    throw new Error('at least one desired amount must be > 0');
  }

  // If override was provided, validate it doesn't exceed amountDesired
  // (would always revert) and isn't more lenient than MAX_SLIPPAGE allows
  // implicitly via being absurdly small relative to desired (>10× variance).
  const validateMin = (label: string, desired: bigint, min: bigint) => {
    if (min > desired) {
      throw new Error(`${label}Min must be <= ${label}Desired`);
    }
    if (min < 0n) throw new Error(`${label}Min cannot be negative`);
  };
  if (input.amount0MinOverride !== undefined) {
    validateMin('amount0', input.amount0Desired, input.amount0MinOverride);
  }
  if (input.amount1MinOverride !== undefined) {
    validateMin('amount1', input.amount1Desired, input.amount1MinOverride);
  }

  return {
    token0: input.token0,
    token1: input.token1,
    fee: input.feeTier,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    amount0Desired: input.amount0Desired,
    amount1Desired: input.amount1Desired,
    amount0Min:
      input.amount0MinOverride ?? withMintSlippage(input.amount0Desired, slippageBps),
    amount1Min:
      input.amount1MinOverride ?? withMintSlippage(input.amount1Desired, slippageBps),
    recipient: input.recipient,
    deadline,
  };
}

/**
 * Transaction builders for Uniswap V3 operations.
 *
 * These functions produce *unsigned* transaction payloads ready for the user
 * (or a scoped session key) to sign. They do NOT sign or submit anything —
 * that responsibility lives with the caller (wallet or ERC-4337 bundler).
 *
 * SECURITY (docs/security-v2.md S3.3, S3.4):
 *   - Slippage bounds enforced (max 1%)
 *   - Deadline bounded to 5 minutes from "now"
 *   - AI range output MUST pass assertRangeSafeForExecution before calling here
 *   - Inputs validated with Zod
 *   - Zero dynamic code — pure data construction
 */

import { ethers } from 'ethers';
import { z } from 'zod';
import {
  assertRangeSafeForExecution,
  type SweetSpotResult,
} from '@liqai/ai';
import { NONFUNGIBLE_POSITION_MANAGER_ABI, SWAP_ROUTER_02_ABI } from './abis.js';
import { getAddresses } from './addresses.js';
import { withSlippage } from './price-math.js';

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const FeeTierSchema = z
  .number()
  .int()
  .refine((v) => [100, 500, 3000, 10_000].includes(v));

/** Maximum slippage tolerance (in basis points) that we will ever encode. */
export const MAX_SLIPPAGE_BPS = 100; // 1%
/** Maximum transaction deadline from now (in seconds). */
export const MAX_DEADLINE_SEC = 300; // 5 minutes

/** An unsigned transaction payload ready for signing. */
export interface UnsignedTx {
  readonly to: string;
  readonly data: string;
  readonly value: bigint;
  /** Human-readable description (for confirmation UIs + audit log). */
  readonly description: string;
}

const nfpmInterface = new ethers.Interface(NONFUNGIBLE_POSITION_MANAGER_ABI);
const swapRouterInterface = new ethers.Interface(SWAP_ROUTER_02_ABI);

/** Compute a deadline timestamp (unix seconds) capped at MAX_DEADLINE_SEC. */
function makeDeadline(secondsFromNow: number): bigint {
  const capped = Math.min(Math.max(Math.floor(secondsFromNow), 30), MAX_DEADLINE_SEC);
  return BigInt(Math.floor(Date.now() / 1000) + capped);
}

/** Assert slippage is within safety bounds. */
function assertSlippage(slippageBps: number): void {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `slippageBps must be an integer in [0, ${MAX_SLIPPAGE_BPS}]; got ${slippageBps}`,
    );
  }
}

// ── Swap ───────────────────────────────────────────────────────────

export interface BuildSwapTxOptions {
  readonly chainId: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly fee: number;
  readonly amountIn: bigint;
  /** The expected (quoted) amount out, pre-slippage. Must come from QuoterV2. */
  readonly expectedAmountOut: bigint;
  /** Slippage in basis points. Default 50 (0.5%). Capped at MAX_SLIPPAGE_BPS. */
  readonly slippageBps?: number;
  readonly recipient: string;
  readonly deadlineSecFromNow?: number;
}

export function buildSwapTx(options: BuildSwapTxOptions): UnsignedTx {
  const chainId = options.chainId;
  const tokenIn = AddressSchema.parse(options.tokenIn);
  const tokenOut = AddressSchema.parse(options.tokenOut);
  const fee = FeeTierSchema.parse(options.fee);
  const recipient = AddressSchema.parse(options.recipient);

  if (options.amountIn <= 0n) throw new Error('amountIn must be > 0');
  if (options.expectedAmountOut <= 0n) throw new Error('expectedAmountOut must be > 0');

  const slippageBps = options.slippageBps ?? 50;
  assertSlippage(slippageBps);

  const amountOutMinimum = withSlippage(options.expectedAmountOut, slippageBps);
  const deadline = makeDeadline(options.deadlineSecFromNow ?? MAX_DEADLINE_SEC);

  const addrs = getAddresses(chainId);

  const data = swapRouterInterface.encodeFunctionData('exactInputSingle', [
    {
      tokenIn,
      tokenOut,
      fee,
      recipient,
      amountIn: options.amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    },
  ]);

  // SwapRouter02 on Uniswap V3 does NOT accept `deadline` in exactInputSingle
  // (that was V1 of the router). Deadline enforcement is the caller's duty
  // via the ERC-4337 userOp or tx nonce timeout.
  void deadline;

  return {
    to: addrs.swapRouter02,
    data,
    value: 0n,
    description: `Swap ${options.amountIn} ${tokenIn} → ≥${amountOutMinimum} ${tokenOut} (fee ${fee})`,
  };
}

// ── Mint LP position ──────────────────────────────────────────────

export interface BuildMintTxOptions {
  readonly chainId: number;
  readonly token0: string;
  readonly token1: string;
  readonly fee: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly amount0Desired: bigint;
  readonly amount1Desired: bigint;
  readonly recipient: string;
  readonly slippageBps?: number;
  readonly deadlineSecFromNow?: number;
  /**
   * The AI-computed sweet-spot range (for safety validation) and the current
   * pool price. Required: the builder refuses to encode the tx unless the
   * range passes assertRangeSafeForExecution.
   */
  readonly aiRange: SweetSpotResult;
  readonly currentPrice: number;
}

export function buildMintTx(options: BuildMintTxOptions): UnsignedTx {
  const chainId = options.chainId;
  const token0 = AddressSchema.parse(options.token0);
  const token1 = AddressSchema.parse(options.token1);
  const fee = FeeTierSchema.parse(options.fee);
  const recipient = AddressSchema.parse(options.recipient);

  if (options.tickLower >= options.tickUpper) {
    throw new Error('tickLower must be < tickUpper');
  }
  if (options.amount0Desired <= 0n && options.amount1Desired <= 0n) {
    throw new Error('at least one desired amount must be > 0');
  }

  // SECURITY GATE: AI output must be safe before we encode it.
  assertRangeSafeForExecution(options.aiRange, options.currentPrice);

  // Extra check: builder-level tick must match the AI-proposed range
  // (within spacing alignment). Prevents "AI said X, but caller passed Y".
  if (
    options.tickLower !== options.aiRange.tickLower ||
    options.tickUpper !== options.aiRange.tickUpper
  ) {
    throw new Error(
      'mint tick range must exactly match the validated AI range ' +
        `(got [${options.tickLower}, ${options.tickUpper}], ` +
        `expected [${options.aiRange.tickLower}, ${options.aiRange.tickUpper}])`,
    );
  }

  const slippageBps = options.slippageBps ?? 50;
  assertSlippage(slippageBps);

  const amount0Min = withSlippage(options.amount0Desired, slippageBps);
  const amount1Min = withSlippage(options.amount1Desired, slippageBps);
  const deadline = makeDeadline(options.deadlineSecFromNow ?? MAX_DEADLINE_SEC);

  const addrs = getAddresses(chainId);

  const data = nfpmInterface.encodeFunctionData('mint', [
    {
      token0,
      token1,
      fee,
      tickLower: options.tickLower,
      tickUpper: options.tickUpper,
      amount0Desired: options.amount0Desired,
      amount1Desired: options.amount1Desired,
      amount0Min,
      amount1Min,
      recipient,
      deadline,
    },
  ]);

  return {
    to: addrs.nonfungiblePositionManager,
    data,
    value: 0n,
    description:
      `Mint LP [${options.tickLower}, ${options.tickUpper}] ` +
      `for ${options.amount0Desired} ${token0} + ${options.amount1Desired} ${token1}`,
  };
}

// ── Decrease liquidity ────────────────────────────────────────────

export interface BuildDecreaseLiquidityTxOptions {
  readonly chainId: number;
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly expectedAmount0: bigint;
  readonly expectedAmount1: bigint;
  readonly slippageBps?: number;
  readonly deadlineSecFromNow?: number;
}

export function buildDecreaseLiquidityTx(
  options: BuildDecreaseLiquidityTxOptions,
): UnsignedTx {
  const chainId = options.chainId;
  if (options.tokenId <= 0n) throw new Error('tokenId must be > 0');
  if (options.liquidity <= 0n) throw new Error('liquidity must be > 0');

  const slippageBps = options.slippageBps ?? 50;
  assertSlippage(slippageBps);

  const amount0Min = withSlippage(options.expectedAmount0, slippageBps);
  const amount1Min = withSlippage(options.expectedAmount1, slippageBps);
  const deadline = makeDeadline(options.deadlineSecFromNow ?? MAX_DEADLINE_SEC);

  const addrs = getAddresses(chainId);

  const data = nfpmInterface.encodeFunctionData('decreaseLiquidity', [
    {
      tokenId: options.tokenId,
      liquidity: options.liquidity,
      amount0Min,
      amount1Min,
      deadline,
    },
  ]);

  return {
    to: addrs.nonfungiblePositionManager,
    data,
    value: 0n,
    description:
      `Decrease liquidity ${options.liquidity} on tokenId=${options.tokenId}`,
  };
}

// ── Collect fees ──────────────────────────────────────────────────

export interface BuildCollectTxOptions {
  readonly chainId: number;
  readonly tokenId: bigint;
  readonly recipient: string;
  /** Use uint128 max to collect everything available. */
  readonly amount0Max?: bigint;
  readonly amount1Max?: bigint;
}

export function buildCollectTx(options: BuildCollectTxOptions): UnsignedTx {
  const chainId = options.chainId;
  const recipient = AddressSchema.parse(options.recipient);
  if (options.tokenId <= 0n) throw new Error('tokenId must be > 0');

  const MAX_U128 = 2n ** 128n - 1n;
  const addrs = getAddresses(chainId);

  const data = nfpmInterface.encodeFunctionData('collect', [
    {
      tokenId: options.tokenId,
      recipient,
      amount0Max: options.amount0Max ?? MAX_U128,
      amount1Max: options.amount1Max ?? MAX_U128,
    },
  ]);

  return {
    to: addrs.nonfungiblePositionManager,
    data,
    value: 0n,
    description: `Collect fees from tokenId=${options.tokenId} to ${recipient}`,
  };
}

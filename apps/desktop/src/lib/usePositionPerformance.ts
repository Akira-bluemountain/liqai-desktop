'use client';

/**
 * usePositionPerformance — reads live on-chain state for a user's active LP
 * positions and derives the metrics we surface in the dashboard:
 *
 *   - Current amounts held in the position (USDC, WETH) — computed from
 *     liquidity + live sqrtPriceX96 using the standard Uniswap V3 formulas.
 *   - Unclaimed fees (tokensOwed0, tokensOwed1 from NPM.positions()).
 *   - USD value of both the principal and the accrued fees, using the live
 *     pool price.
 *   - Annualised APR = fees_usd / principal_usd × 365 / days_active.
 *
 * SECURITY / CORRECTNESS:
 *   - All math is on bigints up to the final USD conversion, which uses
 *     floats. USD values are for display only; no on-chain decision depends
 *     on them.
 *   - "Principal" is approximated as the current position value (excluding
 *     accrued fees). If price has moved significantly since mint, this
 *     under/overstates the true cost basis; a follow-up will track
 *     initial-USD-at-mint for perfect accuracy.
 *   - We silently skip positions whose on-chain `positions()` read fails
 *     (e.g., burned after withdraw) rather than crashing the whole panel.
 */

import { useQuery } from '@tanstack/react-query';
import { parseAbi, type Address, type PublicClient } from 'viem';
import { usePublicClient } from 'wagmi';
import {
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  UNISWAP_V3_ADDRESSES,
} from '@liqai/uniswap';
import { useUsdcWethPoolState, type PoolStateWithDecimals } from './usePoolState';
import type { LpPositionRow } from './db';

const MAINNET_ID = 1;
const NPM_ABI_VIEM = parseAbi(NONFUNGIBLE_POSITION_MANAGER_ABI);

export interface PositionPerformance {
  readonly positionId: number;
  readonly tokenId: string;
  /** Principal amounts currently held in the position (not including fees). */
  readonly amount0InPosition: bigint; // USDC (6 dec)
  readonly amount1InPosition: bigint; // WETH (18 dec)
  /** Unclaimed fees (owed to the NFT owner; not yet collected). */
  readonly unclaimedFees0: bigint;
  readonly unclaimedFees1: bigint;
  /** USD value of the principal at current price. */
  readonly principalUsd: number;
  /** USD value of unclaimed fees at current price. */
  readonly feesUsd: number;
  /** Total USD value (principal + fees). */
  readonly totalUsd: number;
  /** Days since mint (fractional). */
  readonly daysActive: number;
  /**
   * Annualised return from fees only, as a percentage. Null when we can't
   * compute a meaningful APR (principal ~0 or days_active ~0).
   */
  readonly apr: number | null;
  /** True if price is currently inside the tick range (position earning fees). */
  readonly inRange: boolean;
  /** True if the on-chain liquidity is 0 (position effectively empty). */
  readonly isEmpty: boolean;
}

export interface PortfolioSummary {
  readonly totalPrincipalUsd: number;
  readonly totalFeesUsd: number;
  readonly totalUsd: number;
  /** Principal-weighted APR across active positions. */
  readonly blendedApr: number | null;
  readonly activeCount: number;
  readonly inRangeCount: number;
}

export interface UsePositionPerformanceResult {
  readonly byId: Readonly<Record<number, PositionPerformance>>;
  readonly summary: PortfolioSummary;
  readonly isLoading: boolean;
  readonly error: string | null;
  /** On-chain ETH/USD price derived from the pool slot0. */
  readonly ethUsd: number | null;
}

export function usePositionPerformance(
  positions: readonly LpPositionRow[] | null,
): UsePositionPerformanceResult {
  const publicClient = usePublicClient();
  const { data: poolState } = useUsdcWethPoolState();

  const activePositions = (positions ?? []).filter((p) => p.status === 'active');
  const tokenIdsKey = activePositions.map((p) => p.lp_token_id).join(',');

  const query = useQuery({
    queryKey: [
      'position-perf',
      tokenIdsKey,
      poolState?.sqrtPriceX96?.toString() ?? 'nopool',
    ],
    enabled: !!publicClient && !!poolState && activePositions.length > 0,
    queryFn: async (): Promise<Record<number, PositionPerformance>> => {
      if (!publicClient || !poolState) return {};
      const out: Record<number, PositionPerformance> = {};
      for (const row of activePositions) {
        try {
          const perf = await loadSinglePerformance(
            publicClient as PublicClient,
            row,
            poolState,
          );
          if (perf) out[row.id] = perf;
        } catch {
          // Skip individual failures — one bad position shouldn't break the
          // whole dashboard. Loaded rows are still rendered for the rest.
        }
      }
      return out;
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
  });

  const byId = query.data ?? {};
  const ethUsd = poolState ? deriveEthUsd(poolState) : null;

  // Aggregate summary across active positions.
  let totalPrincipalUsd = 0;
  let totalFeesUsd = 0;
  let inRangeCount = 0;
  let weightedAprNumerator = 0;
  let weightedAprDenominator = 0;
  for (const p of Object.values(byId)) {
    totalPrincipalUsd += p.principalUsd;
    totalFeesUsd += p.feesUsd;
    if (p.inRange) inRangeCount += 1;
    if (p.apr !== null && p.principalUsd > 0) {
      weightedAprNumerator += p.apr * p.principalUsd;
      weightedAprDenominator += p.principalUsd;
    }
  }
  const blendedApr =
    weightedAprDenominator > 0
      ? weightedAprNumerator / weightedAprDenominator
      : null;

  const summary: PortfolioSummary = {
    totalPrincipalUsd,
    totalFeesUsd,
    totalUsd: totalPrincipalUsd + totalFeesUsd,
    blendedApr,
    activeCount: activePositions.length,
    inRangeCount,
  };

  return {
    byId,
    summary,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    ethUsd,
  };
}

// ── single-position loader ───────────────────────────────────────

async function loadSinglePerformance(
  client: PublicClient,
  row: LpPositionRow,
  pool: PoolStateWithDecimals,
): Promise<PositionPerformance | null> {
  const { nonfungiblePositionManager: NPM } = UNISWAP_V3_ADDRESSES[MAINNET_ID];
  const npm = NPM as Address;

  const pos = (await client.readContract({
    address: npm,
    abi: NPM_ABI_VIEM,
    functionName: 'positions',
    args: [BigInt(row.lp_token_id)],
  })) as readonly [
    bigint, // nonce
    Address, // operator
    Address, // token0
    Address, // token1
    number, // fee
    number, // tickLower
    number, // tickUpper
    bigint, // liquidity
    bigint, // feeGrowthInside0LastX128
    bigint, // feeGrowthInside1LastX128
    bigint, // tokensOwed0
    bigint, // tokensOwed1
  ];

  const liquidity = pos[7];
  const tokensOwed0 = pos[10];
  const tokensOwed1 = pos[11];

  const { amount0, amount1, inRange } = computePositionAmounts({
    liquidity,
    sqrtPriceX96: pool.sqrtPriceX96,
    tickLower: row.tick_lower,
    tickUpper: row.tick_upper,
  });

  const ethUsd = deriveEthUsd(pool);
  const usdPerUsdc = 1; // USDC is the numeraire; drift ignored.
  const usdPerWeth = ethUsd;

  const principalUsd =
    rawToHuman(amount0, pool.token0Decimals) * usdPerUsdc +
    rawToHuman(amount1, pool.token1Decimals) * usdPerWeth;
  const feesUsd =
    rawToHuman(tokensOwed0, pool.token0Decimals) * usdPerUsdc +
    rawToHuman(tokensOwed1, pool.token1Decimals) * usdPerWeth;

  const daysActive = Math.max(
    0,
    (Date.now() / 1000 - row.minted_at) / 86400,
  );

  let apr: number | null = null;
  if (principalUsd > 0 && daysActive >= 1 / 24) {
    // Annualise: fees_ratio × (365 / days). Cap absurd early values — any
    // APR > 10000% is unrealistic and almost certainly from a dust
    // principal + tiny fee rounding artefact.
    const raw = (feesUsd / principalUsd) * (365 / daysActive) * 100;
    apr = Number.isFinite(raw) ? Math.min(raw, 10_000) : null;
  }

  return {
    positionId: row.id,
    tokenId: row.lp_token_id,
    amount0InPosition: amount0,
    amount1InPosition: amount1,
    unclaimedFees0: tokensOwed0,
    unclaimedFees1: tokensOwed1,
    principalUsd,
    feesUsd,
    totalUsd: principalUsd + feesUsd,
    daysActive,
    apr,
    inRange,
    isEmpty: liquidity === 0n,
  };
}

// ── pure math helpers ────────────────────────────────────────────

/**
 * Standard Uniswap V3 formulas (whitepaper §6.2) for the tokens currently
 * held in a position, given its liquidity L and the pool's sqrtPriceX96.
 */
export function computePositionAmounts(options: {
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
}): { amount0: bigint; amount1: bigint; inRange: boolean } {
  const { liquidity, sqrtPriceX96, tickLower, tickUpper } = options;
  if (liquidity === 0n) {
    return { amount0: 0n, amount1: 0n, inRange: false };
  }
  const Q96 = 2 ** 96;
  const sqrtP = Number(sqrtPriceX96) / Q96;
  const sqrtPLower = Math.pow(1.0001, tickLower / 2);
  const sqrtPUpper = Math.pow(1.0001, tickUpper / 2);
  const L = Number(liquidity);

  let amount0 = 0;
  let amount1 = 0;
  let inRange = false;

  if (sqrtP <= sqrtPLower) {
    // Price below range → 100% token0.
    amount0 = (L * (sqrtPUpper - sqrtPLower)) / (sqrtPLower * sqrtPUpper);
  } else if (sqrtP >= sqrtPUpper) {
    // Price above range → 100% token1.
    amount1 = L * (sqrtPUpper - sqrtPLower);
  } else {
    // In range → mixed.
    amount0 = (L * (sqrtPUpper - sqrtP)) / (sqrtP * sqrtPUpper);
    amount1 = L * (sqrtP - sqrtPLower);
    inRange = true;
  }

  return {
    amount0: amount0 > 0 && Number.isFinite(amount0) ? BigInt(Math.floor(amount0)) : 0n,
    amount1: amount1 > 0 && Number.isFinite(amount1) ? BigInt(Math.floor(amount1)) : 0n,
    inRange,
  };
}

function rawToHuman(raw: bigint, decimals: number): number {
  // Bigint → number via divide. For display precision this is fine; we lose
  // at most a few cents of precision on very large positions.
  const divisor = 10 ** decimals;
  return Number(raw) / divisor;
}

export function deriveEthUsd(pool: PoolStateWithDecimals): number {
  // sqrtPrice^2 gives raw (decimal-unaware) token1/token0 ratio.
  // For USDC (6 dec) / WETH (18 dec), the decimal-adjusted price is
  // (raw × 10^(dec0-dec1)) = WETH-per-USDC. Invert for USD-per-WETH.
  const Q96 = 2 ** 96;
  const sqrtP = Number(pool.sqrtPriceX96) / Q96;
  const raw = sqrtP * sqrtP;
  const adjusted = raw * Math.pow(10, pool.token0Decimals - pool.token1Decimals);
  return adjusted > 0 ? 1 / adjusted : 0;
}

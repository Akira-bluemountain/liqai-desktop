'use client';

/**
 * useAprMetrics — derives three complementary APR numbers for a single LP
 * position, feeding the three-tier dashboard display:
 *
 *   1. Theoretical APR  — "what THIS range can earn today"
 *                         Based on pool 24h fees × my liquidity share.
 *                         Forward-looking, needs the Uniswap subgraph.
 *
 *   2. Realized 24h APR — "what THIS position has actually earned over the
 *                         last 24 hours" (rolls over range changes).
 *                         Backward-looking, computed from local fee_snapshots.
 *
 *   3. Realized lifetime APR — "since this NFT was minted".
 *                              Already computed by usePositionPerformance.
 *
 * Each number can independently be null if it can't be computed yet
 * (subgraph down, fewer than 2 snapshots, etc). Consumers render "—" or
 * "gathering data…" in those cases.
 */

import { useQuery } from '@tanstack/react-query';
import { parseAbi, type Address, type PublicClient } from 'viem';
import { usePublicClient } from 'wagmi';
import {
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  UNISWAP_V3_ADDRESSES,
} from '@liqai/uniswap';
import { useUsdcWethPoolState } from './usePoolState';
import type { LpPositionRow } from './db';
import {
  computeRealizedApr,
  type RealizedAprResult,
} from './feeSnapshots';
import {
  fetchPoolMetrics,
  computeTheoreticalApr,
  type PoolMetrics,
} from './uniswapSubgraph';

const MAINNET_ID = 1;
const NPM_ABI_VIEM = parseAbi(NONFUNGIBLE_POSITION_MANAGER_ABI);

export interface AprMetrics {
  readonly theoretical: {
    readonly aprPct: number | null;
    readonly sharePct: number;
    readonly fees24hUsd: number;
    readonly volume24hUsd: number;
    readonly source: 'subgraph' | 'unavailable';
  };
  readonly realized24h: RealizedAprResult;
  readonly realizedLifetime: {
    readonly aprPct: number | null;
    readonly daysActive: number;
  };
}

const EMPTY_REALIZED: RealizedAprResult = {
  feesUsdInWindow: 0,
  avgPositionValueUsd: 0,
  observedHours: 0,
  aprPct: null,
  snapshotCount: 0,
};

/**
 * Compute the three APR numbers for a single active position.
 *
 * @param position The lp_positions row. Pass null to no-op (e.g., no active
 *                 position).
 * @param lifetimeAprPct Pre-computed lifetime APR from
 *                 usePositionPerformance (avoids duplicate on-chain reads).
 * @param lifetimeDaysActive Days since mint.
 * @param positionValueUsd Current USD value of the principal.
 */
export function useAprMetrics(options: {
  readonly position: LpPositionRow | null;
  readonly lifetimeAprPct: number | null;
  readonly lifetimeDaysActive: number;
  readonly positionValueUsd: number;
}): { metrics: AprMetrics | null; isLoading: boolean } {
  const publicClient = usePublicClient();
  const { data: poolState } = useUsdcWethPoolState();
  const { position, lifetimeAprPct, lifetimeDaysActive, positionValueUsd } =
    options;

  const query = useQuery({
    queryKey: [
      'apr-metrics',
      position?.id ?? 'none',
      position?.pool_address ?? 'none',
      poolState?.sqrtPriceX96?.toString() ?? 'nopool',
      // bucket by hour so the subgraph isn't hammered — still responsive
      // enough for a dashboard that refreshes every 10s from other signals.
      Math.floor(Date.now() / 3_600_000),
    ],
    enabled:
      !!publicClient && !!poolState && !!position && position.status === 'active',
    queryFn: async (): Promise<AprMetrics> => {
      if (!publicClient || !poolState || !position) {
        throw new Error('disabled');
      }

      // ── (2) realized 24h (local, always works if we have snapshots) ──
      const realized24h = await computeRealizedApr(
        position,
        {
          token0Decimals: poolState.token0Decimals,
          token1Decimals: poolState.token1Decimals,
        },
        24,
      );

      // ── (1) theoretical (external, best-effort) ──
      let theoreticalAprPct: number | null = null;
      let sharePct = 0;
      let fees24hUsd = 0;
      let volume24hUsd = 0;
      let source: 'subgraph' | 'unavailable' = 'unavailable';
      try {
        const metrics = await fetchPoolMetrics(position.pool_address);
        if (metrics) {
          // Read current on-chain liquidity for this NFT.
          const { nonfungiblePositionManager: NPM } =
            UNISWAP_V3_ADDRESSES[MAINNET_ID];
          const pos = (await (publicClient as PublicClient).readContract({
            address: NPM as Address,
            abi: NPM_ABI_VIEM,
            functionName: 'positions',
            args: [BigInt(position.lp_token_id)],
          })) as readonly unknown[];
          const myLiquidity = pos[7] as bigint;
          const theo = computeTheoreticalApr({
            metrics,
            myLiquidity,
            myPositionUsd: positionValueUsd,
          });
          theoreticalAprPct = theo.aprPct;
          sharePct = theo.sharePct;
          fees24hUsd = metrics.fees24hUsd;
          volume24hUsd = metrics.volume24hUsd;
          source = 'subgraph';
        }
      } catch {
        // leave as unavailable
      }

      return {
        theoretical: {
          aprPct: theoreticalAprPct,
          sharePct,
          fees24hUsd,
          volume24hUsd,
          source,
        },
        realized24h,
        realizedLifetime: {
          aprPct: lifetimeAprPct,
          daysActive: lifetimeDaysActive,
        },
      };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  return {
    metrics: query.data ?? null,
    isLoading: query.isLoading,
  };
}

// Re-export so consumers can type against the raw types without importing
// from three files.
export type { PoolMetrics };
export const emptyRealizedApr = EMPTY_REALIZED;

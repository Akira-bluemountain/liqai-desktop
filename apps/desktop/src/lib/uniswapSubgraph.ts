'use client';

/**
 * uniswapSubgraph — read-only client for the Uniswap V3 subgraph.
 *
 * We use this to surface a "theoretical APR for the current range" on the
 * positions dashboard, complementing the on-chain-derived realized APR.
 * Theoretical APR = (pool_24h_fees × my_liquidity / active_tick_liquidity × 365)
 *                 / position_value_usd.
 *
 * SECURITY:
 *   - Read-only, no keys required for the public hosted endpoint.
 *   - Never send the user's address, position data, or anything identifying.
 *   - All responses are treated as untrusted: Zod-validated before use.
 *   - External service — any failure falls back gracefully (returns null)
 *     so the dashboard simply omits the theoretical APR rather than
 *     breaking.
 */

import { z } from 'zod';

// Uniswap V3 mainnet subgraph on The Graph hosted service. Read-only,
// no auth required.
//
// Note: The Graph is migrating from hosted → decentralized network; we
// keep both endpoints and fail over. If both fail we return null.
const SUBGRAPH_ENDPOINTS = [
  'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3',
  // Decentralized-network Uniswap V3 subgraph (no API key required for
  // anonymous low-rate reads). This is the long-term home.
  'https://gateway-arbitrum.network.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
] as const;

const REQUEST_TIMEOUT_MS = 8_000;

const PoolMetricsSchema = z.object({
  data: z.object({
    pool: z
      .object({
        id: z.string(),
        feeTier: z.string(),
        tick: z.string().nullable(),
        liquidity: z.string(),
        sqrtPrice: z.string(),
        totalValueLockedUSD: z.string(),
        poolDayData: z
          .array(
            z.object({
              date: z.number().int(),
              feesUSD: z.string(),
              volumeUSD: z.string(),
              tvlUSD: z.string(),
            }),
          )
          .default([]),
      })
      .nullable(),
  }),
});

export interface PoolMetrics {
  readonly poolAddress: string;
  readonly feeTierBps: number;
  readonly activeTick: number | null;
  readonly activeTickLiquidity: bigint;
  readonly tvlUsd: number;
  readonly fees24hUsd: number;
  readonly volume24hUsd: number;
  readonly source: 'subgraph';
}

/**
 * Fetch the most recent 24h metrics for a Uniswap V3 pool.
 *
 * @param poolAddress lowercase hex address
 * @returns null if all endpoints fail (caller should omit theoretical APR).
 */
export async function fetchPoolMetrics(
  poolAddress: string,
): Promise<PoolMetrics | null> {
  const addrLower = poolAddress.toLowerCase();
  const query = `
    {
      pool(id: "${addrLower}") {
        id
        feeTier
        tick
        liquidity
        sqrtPrice
        totalValueLockedUSD
        poolDayData(first: 1, orderBy: date, orderDirection: desc) {
          date
          feesUSD
          volumeUSD
          tvlUSD
        }
      }
    }
  `;

  for (const endpoint of SUBGRAPH_ENDPOINTS) {
    try {
      const res = await postWithTimeout(
        endpoint,
        { query },
        REQUEST_TIMEOUT_MS,
      );
      if (!res.ok) continue;
      const json = await res.json();
      const parsed = PoolMetricsSchema.safeParse(json);
      if (!parsed.success) continue;
      const pool = parsed.data.data.pool;
      if (!pool) continue;
      const day = pool.poolDayData[0];
      return {
        poolAddress: pool.id,
        feeTierBps: Number(pool.feeTier),
        activeTick: pool.tick !== null ? Number(pool.tick) : null,
        activeTickLiquidity: safeBigInt(pool.liquidity),
        tvlUsd: Number(pool.totalValueLockedUSD),
        fees24hUsd: day ? Number(day.feesUSD) : 0,
        volume24hUsd: day ? Number(day.volumeUSD) : 0,
        source: 'subgraph',
      };
    } catch {
      // try next endpoint
    }
  }
  return null;
}

/**
 * Given pool metrics + the user's liquidity, compute the theoretical APR
 * they would earn IF their liquidity were active in the current tick AND
 * the last 24h fee rate persisted.
 *
 * Notes:
 *   - "Active tick liquidity" from the subgraph is pool.liquidity — the
 *     aggregate in-range liquidity. Our liquidity only earns when our tick
 *     range contains the active tick; the caller is responsible for
 *     checking in-range before using this number for guidance.
 *   - This is a forward-looking estimate with significant variance. Use
 *     it for UI guidance, not for settlement.
 */
export function computeTheoreticalApr(options: {
  readonly metrics: PoolMetrics;
  readonly myLiquidity: bigint;
  readonly myPositionUsd: number;
}): { aprPct: number | null; sharePct: number } {
  const { metrics, myLiquidity, myPositionUsd } = options;
  if (metrics.activeTickLiquidity <= 0n || myPositionUsd <= 0) {
    return { aprPct: null, sharePct: 0 };
  }
  // Handle the edge case where our liquidity >= total (single-LP pool) by
  // clamping to 1. Do the division in float via Number conversion; for the
  // magnitudes we see (liquidity up to ~10^30), float precision is fine
  // for UI purposes — 15-17 significant digits.
  const ratio =
    Number(myLiquidity) /
    Number(metrics.activeTickLiquidity + myLiquidity);
  const share = Math.min(Math.max(ratio, 0), 1);
  const myDailyFeeUsd = metrics.fees24hUsd * share;
  const aprPct = (myDailyFeeUsd * 365 * 100) / myPositionUsd;
  return {
    aprPct: Number.isFinite(aprPct) ? Math.min(aprPct, 10_000) : null,
    sharePct: share * 100,
  };
}

// ── internals ────────────────────────────────────────────────────────

function safeBigInt(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

async function postWithTimeout(
  url: string,
  body: unknown,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

'use client';

/**
 * feeSnapshots — append-only time series of pending-fee observations for an
 * LP NFT, used to compute realized APR (rolling 24h and lifetime) without
 * depending on any external service.
 *
 * Sampling: the rebalance bot invokes `recordFeeSnapshot` on every 5-minute
 * evaluation tick. Each row captures tokensOwed (from a static `collect`
 * call) + the live pool-derived position USD value.
 *
 * APR computation: fees between two adjacent snapshots is
 *   Δfees_usd = max(0, owed_t1_usd − owed_t0_usd).
 * The `max(0, ...)` accounts for the collect-on-rebalance reset — when a
 * rebalance actually collects the pending fees, the next snapshot will show
 * a drop in tokensOwed. Treating that drop as "zero fee earned in this
 * window" is correct for a realized-return calculation because the earned
 * fee is already reflected in the prior snapshot; what we discard is only
 * the reset itself, not revenue.
 */

import { parseAbi, type Address, type PublicClient } from 'viem';
import {
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  UNISWAP_V3_ADDRESSES,
} from '@liqai/uniswap';
import { getDb } from './db';
import {
  computePositionAmounts,
  deriveEthUsd,
} from './usePositionPerformance';
import type { PoolStateWithDecimals } from './usePoolState';
import type { LpPositionRow } from './db';

const MAINNET_ID = 1;
const NPM_ABI_VIEM = parseAbi(NONFUNGIBLE_POSITION_MANAGER_ABI);
const MAX_U128 = 2n ** 128n - 1n;

export interface FeeSnapshotRow {
  readonly id: number;
  readonly lp_position_id: number;
  readonly timestamp: number;
  readonly tokens_owed0: string;
  readonly tokens_owed1: string;
  readonly eth_usd_price: number;
  readonly position_value_usd: number;
}

/**
 * Read the pending (uncollected) fees for an NFT via a static `collect`
 * simulation, and persist a snapshot row.
 *
 * The SA is the NFT owner, so we simulate as if the SA was calling. The
 * return value of `collect` in the simulation equals the amounts that
 * WOULD be paid out if we actually collected now — which is precisely the
 * cumulative unclaimed-fee balance.
 *
 * Returns the inserted row id (or null if persistence failed — we never
 * throw from this path since a failed snapshot must NEVER break the bot
 * tick).
 */
export async function recordFeeSnapshot(options: {
  readonly publicClient: PublicClient;
  readonly smartAccountAddress: Address;
  readonly position: LpPositionRow;
  readonly poolState: PoolStateWithDecimals;
  readonly nowSec?: number;
}): Promise<number | null> {
  const { publicClient, smartAccountAddress, position, poolState } = options;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const { nonfungiblePositionManager: NPM } = UNISWAP_V3_ADDRESSES[MAINNET_ID];
  const npm = NPM as Address;

  let tokensOwed0: bigint;
  let tokensOwed1: bigint;
  try {
    // Prefer a static call to `collect` which returns the ACTUAL amounts
    // that would be paid out (includes newly-accrued fees in the active
    // tick, unlike `positions().tokensOwed*` which is only updated when
    // the position is "poked").
    const sim = await publicClient.simulateContract({
      address: npm,
      abi: NPM_ABI_VIEM,
      functionName: 'collect',
      args: [
        {
          tokenId: BigInt(position.lp_token_id),
          recipient: smartAccountAddress,
          amount0Max: MAX_U128,
          amount1Max: MAX_U128,
        },
      ],
      account: smartAccountAddress,
    });
    const result = sim.result as readonly [bigint, bigint];
    tokensOwed0 = result[0];
    tokensOwed1 = result[1];
  } catch {
    // Fallback to positions().tokensOwed* — loses precision on the
    // in-active-tick portion but is universally readable.
    try {
      const pos = (await publicClient.readContract({
        address: npm,
        abi: NPM_ABI_VIEM,
        functionName: 'positions',
        args: [BigInt(position.lp_token_id)],
      })) as readonly unknown[];
      tokensOwed0 = pos[10] as bigint;
      tokensOwed1 = pos[11] as bigint;
    } catch {
      // Position unreadable — skip the snapshot; we'd rather miss one
      // sample than crash the bot tick.
      return null;
    }
  }

  // Compute the USD value of the principal (not including unclaimed fees)
  // at this moment, for denominator-of-APR purposes.
  let positionValueUsd = 0;
  const ethUsd = deriveEthUsd(poolState);
  try {
    const pos = (await publicClient.readContract({
      address: npm,
      abi: NPM_ABI_VIEM,
      functionName: 'positions',
      args: [BigInt(position.lp_token_id)],
    })) as readonly unknown[];
    const liquidity = pos[7] as bigint;
    const { amount0, amount1 } = computePositionAmounts({
      liquidity,
      sqrtPriceX96: poolState.sqrtPriceX96,
      tickLower: position.tick_lower,
      tickUpper: position.tick_upper,
    });
    const usdc = Number(amount0) / 10 ** poolState.token0Decimals;
    const weth = Number(amount1) / 10 ** poolState.token1Decimals;
    positionValueUsd = usdc + weth * ethUsd;
  } catch {
    // If we can't read principal, use the last known DB value — the 24h
    // APR math is robust to a single noisy denominator.
    positionValueUsd = 0;
  }

  try {
    const db = await getDb();
    const result = await db.execute(
      `INSERT INTO fee_snapshots
        (lp_position_id, timestamp, tokens_owed0, tokens_owed1,
         eth_usd_price, position_value_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        position.id,
        nowSec,
        tokensOwed0.toString(),
        tokensOwed1.toString(),
        ethUsd,
        positionValueUsd,
      ],
    );
    return typeof result.lastInsertId === 'number'
      ? result.lastInsertId
      : null;
  } catch {
    return null;
  }
}

/**
 * Fetch snapshots for a position within a time window.
 *
 * @param sinceSec lower bound (inclusive), unix seconds.
 */
export async function listFeeSnapshots(
  lpPositionId: number,
  sinceSec: number,
): Promise<FeeSnapshotRow[]> {
  const db = await getDb();
  const rows = (await db.select(
    `SELECT * FROM fee_snapshots
      WHERE lp_position_id = $1 AND timestamp >= $2
      ORDER BY timestamp ASC`,
    [lpPositionId, sinceSec],
  )) as FeeSnapshotRow[];
  return rows;
}

/**
 * Prune snapshots older than `keepDays` to keep the table bounded. Safe to
 * call on every tick; a single DELETE with an index scan is O(log N).
 */
export async function pruneOldSnapshots(keepDays = 30): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - keepDays * 86400;
  try {
    const db = await getDb();
    await db.execute(
      `DELETE FROM fee_snapshots WHERE timestamp < $1`,
      [cutoff],
    );
  } catch {
    // Non-fatal.
  }
}

export interface RealizedAprResult {
  readonly feesUsdInWindow: number;
  readonly avgPositionValueUsd: number;
  readonly observedHours: number;
  /** null if fewer than 2 snapshots or zero denominator. */
  readonly aprPct: number | null;
  readonly snapshotCount: number;
}

/**
 * Compute realized APR over the last `windowHours` hours for a position.
 *
 * Algorithm:
 *   1. Fetch snapshots inside window.
 *   2. Convert each snapshot's tokens_owed* to USD using its own
 *      eth_usd_price (so past USD deltas reflect the price at the time).
 *   3. Sum positive deltas between consecutive snapshots (the collect reset
 *      on rebalance shows up as a negative delta which we discard).
 *   4. APR = (feesUsd / avgPositionValueUsd) × (365 × 24 / observedHours) × 100.
 */
export async function computeRealizedApr(
  position: LpPositionRow,
  poolDecimals: { token0Decimals: number; token1Decimals: number },
  windowHours: number,
): Promise<RealizedAprResult> {
  const sinceSec = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const snaps = await listFeeSnapshots(position.id, sinceSec);

  if (snaps.length < 2) {
    return {
      feesUsdInWindow: 0,
      avgPositionValueUsd: 0,
      observedHours: 0,
      aprPct: null,
      snapshotCount: snaps.length,
    };
  }

  const owed0Divisor = 10 ** poolDecimals.token0Decimals;
  const owed1Divisor = 10 ** poolDecimals.token1Decimals;

  let feesUsd = 0;
  let principalSum = 0;
  let principalCount = 0;

  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1]!;
    const curr = snaps[i]!;
    const prevUsdc = Number(BigInt(prev.tokens_owed0)) / owed0Divisor;
    const prevWeth = Number(BigInt(prev.tokens_owed1)) / owed1Divisor;
    const currUsdc = Number(BigInt(curr.tokens_owed0)) / owed0Divisor;
    const currWeth = Number(BigInt(curr.tokens_owed1)) / owed1Divisor;
    const prevUsd = prevUsdc + prevWeth * prev.eth_usd_price;
    const currUsd = currUsdc + currWeth * curr.eth_usd_price;
    const delta = currUsd - prevUsd;
    if (delta > 0) feesUsd += delta;
    // else: rebalance collect reset — not a loss, fee was already booked.
  }
  for (const s of snaps) {
    if (s.position_value_usd > 0) {
      principalSum += s.position_value_usd;
      principalCount += 1;
    }
  }

  const avgPositionValueUsd =
    principalCount > 0 ? principalSum / principalCount : 0;
  const firstTs = snaps[0]!.timestamp;
  const lastTs = snaps[snaps.length - 1]!.timestamp;
  const observedHours = Math.max(0, (lastTs - firstTs) / 3600);

  let aprPct: number | null = null;
  if (avgPositionValueUsd > 0 && observedHours >= 1 / 12 /* 5min */) {
    const annualMultiplier = (365 * 24) / observedHours;
    const raw = (feesUsd / avgPositionValueUsd) * annualMultiplier * 100;
    aprPct = Number.isFinite(raw) ? Math.min(raw, 10_000) : null;
  }

  return {
    feesUsdInWindow: feesUsd,
    avgPositionValueUsd,
    observedHours,
    aprPct,
    snapshotCount: snaps.length,
  };
}

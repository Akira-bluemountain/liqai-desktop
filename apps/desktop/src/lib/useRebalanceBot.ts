'use client';

/**
 * useRebalanceBot — the local rebalance loop for LiqAI. Runs periodically
 * (while the desktop app is open), and on each tick:
 *
 *   1. Checks the user has exactly one `active` LP position.
 *   2. Reads the pool's live sqrtPriceX96 and the CoinGecko price history.
 *   3. Asks @liqai/ai's evaluateRebalance whether the current range is stale.
 *   4. If so (and the user has enabled auto-rebalance and cached their
 *      passphrase), decrypts the session key and calls executeRebalance.
 *
 * The user can also trigger a rebalance manually via `triggerManual()` —
 * the same flow skips the AI gate and forces a rebalance to the latest AI
 * range.
 *
 * SECURITY:
 *   - The passphrase lives only in React state during the bot's lifetime.
 *     It is never persisted, never logged, and is cleared when the bot
 *     panel unmounts or the user clicks "Stop".
 *   - Before each execution, we re-read the live pool state; no cached
 *     sqrtPriceX96 from an earlier tick is ever used.
 *   - We hold a mutex so only one rebalance userOp is in flight per tick;
 *     the next tick is skipped until the current one resolves.
 *   - The session key's on-chain policies (callPolicy + rateLimit +
 *     timestamp) are the enforcement of last resort — even with a leaked
 *     passphrase, an attacker cannot exceed those bounds.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useChainId, usePublicClient } from 'wagmi';
import { parseAbi, type Address, type PublicClient } from 'viem';
import { CoinGeckoProvider, evaluateRebalance, calculateSweetSpot } from '@liqai/ai';
import {
  sqrtPriceX96ToPrice,
  usdRangeToPoolTickRange,
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  UNISWAP_V3_ADDRESSES,
} from '@liqai/uniswap';
import { useKernelAccount } from './useKernelAccount';
import {
  useUsdcWethPoolState,
  readPoolState,
  type PoolStateWithDecimals,
} from './usePoolState';
import {
  listLpPositionsForOwner,
  getSmartAccountByOwner,
  type LpPositionRow,
} from './db';
import {
  fetchActiveSessionKey,
  loadSessionKeyClient,
  type StoredSessionKey,
} from './sessionKeyLoad';
import { decryptString, stringToBlob } from './sessionKeyCrypto';
import {
  executeRebalance,
  type RebalanceExecutionResult,
  type RebalanceTrigger,
} from './rebalanceExecutor';
import {
  computePositionAmounts,
  deriveEthUsd,
} from './usePositionPerformance';
import { recordFeeSnapshot, pruneOldSnapshots } from './feeSnapshots';
import { debugWarn } from './debugLog';

const MAINNET_ID = 1;
const DEFAULT_TICK_INTERVAL_MS = 5 * 60_000; // 5 min
const HISTORY_DAYS = 7;
const BOT_FEE_TIER = 500; // USDC/WETH 0.05%
const EVAL_HISTORY_MAX = 8; // keep last N evaluations in memory

/** Seconds before a session key's validUntil to start warning the user
 *  about impending expiry. 7 days gives comfortable time to install a
 *  replacement without interrupting automation. */
export const SESSION_KEY_EXPIRY_WARNING_SECONDS = 7 * 24 * 60 * 60;

/**
 * Minimum seconds since the current position's mint before a trigger at the
 * given confidence may fire a rebalance. Higher confidence = shorter cooldown
 * (or none, for unambiguous range-exit signals). The mint time of the active
 * position equals the time of the last rebalance, since a rebalance mints a
 * fresh NFT.
 *
 * Rationale (2026-04-17): wick and spike/dip 3% triggers fired on the same
 * 3-hour CoinGecko window repeatedly, producing rebalances every ~1-3h. At
 * ≤$50 position size on mainnet, gas cost far exceeds fee revenue. The
 * cooldown adds a coarse "don't re-trigger the same signal until a fresh
 * window of data has arrived" gate.
 */
function cooldownSecondsForConfidence(confidence: number): number {
  if (confidence >= 99) return 0; // range_exit full — urgent, no cooldown
  if (confidence >= 95) return 15 * 60; // crash/surge 5% — 15 min
  if (confidence >= 90) return 60 * 60; // boundary 95% — 1 hour
  if (confidence >= 85) return 2 * 60 * 60; // spike/dip 3% — 2 hours
  return 6 * 60 * 60; // wick and lower — 6 hours
}

/**
 * Empirical gas consumption for the 2-phase rebalance. Phase 1 is 400-600k
 * (decrease + collect), phase 2 is 800k-1M (approve×2 + mint). The first
 * rebalance on a fresh session key adds ~500k for the ENABLE-mode validator
 * install. 1.8M is a comfortable upper bound that rarely over-estimates by
 * more than 2× — erring high is fine here because a low gate would let
 * too many marginal rebalances through.
 */
const REBALANCE_GAS_UNITS_ESTIMATE = 1_800_000n;

/**
 * Maximum fraction of a position's USD value we'll spend on a single
 * rebalance's gas. Above this, low-confidence triggers (wick, spike/dip,
 * boundary) are suppressed. range_exit (confidence 99) still fires
 * regardless — a position outside its range is already earning nothing,
 * so overpaying for gas is still better than earning zero fees.
 */
const MAX_GAS_COST_PCT_OF_POSITION = 0.02; // 2%

const NPM_ABI_VIEM_GATING = parseAbi(NONFUNGIBLE_POSITION_MANAGER_ABI);

/**
 * Read current position value (amounts in position + unclaimed fees),
 * converted to USD using the live pool price. Used only for gas-economics
 * gating — no on-chain action depends on this value.
 */
async function readPositionValueUsd(
  client: PublicClient,
  position: LpPositionRow,
  pool: PoolStateWithDecimals,
): Promise<number> {
  const { nonfungiblePositionManager: NPM } = UNISWAP_V3_ADDRESSES[MAINNET_ID];
  const pos = (await client.readContract({
    address: NPM as Address,
    abi: NPM_ABI_VIEM_GATING,
    functionName: 'positions',
    args: [BigInt(position.lp_token_id)],
  })) as readonly unknown[];
  const liquidity = pos[7] as bigint;
  const tokensOwed0 = pos[10] as bigint;
  const tokensOwed1 = pos[11] as bigint;
  const { amount0, amount1 } = computePositionAmounts({
    liquidity,
    sqrtPriceX96: pool.sqrtPriceX96,
    tickLower: position.tick_lower,
    tickUpper: position.tick_upper,
  });
  const ethUsd = deriveEthUsd(pool);
  const usdc = Number(amount0 + tokensOwed0) / 10 ** pool.token0Decimals;
  const weth = Number(amount1 + tokensOwed1) / 10 ** pool.token1Decimals;
  return usdc + weth * ethUsd;
}

/**
 * Estimate the USD gas cost of the next rebalance userOp using the current
 * mainnet gas price.
 */
async function estimateRebalanceGasCostUsd(
  client: PublicClient,
  ethUsd: number,
): Promise<number> {
  const gasPriceWei = await client.getGasPrice();
  const gasCostWei = gasPriceWei * REBALANCE_GAS_UNITS_ESTIMATE;
  const gasCostEth = Number(gasCostWei) / 1e18;
  return gasCostEth * ethUsd;
}

export type EvalOutcome = 'idle' | 'no_trigger' | 'triggered' | 'error';

export interface EvalHistoryEntry {
  readonly at: number; // ms epoch
  readonly outcome: EvalOutcome;
  readonly reason: string;
}

export interface BotStatus {
  /** True when the timer is active. */
  readonly running: boolean;
  /** True while an evaluateRebalance tick is running (CoinGecko fetch etc.). */
  readonly evaluating: boolean;
  /** True while a rebalance userOp is in flight. */
  readonly executing: boolean;
  /** Last tick's evaluateRebalance result summary (trigger + reason). */
  readonly lastEvalReason: string | null;
  /** Last tick's outcome as a human string. */
  readonly lastEvalAt: number | null;
  /** Planned wall-clock for the next tick (ms epoch); null when stopped. */
  readonly nextEvalAt: number | null;
  /** Interval between ticks in milliseconds. */
  readonly tickIntervalMs: number;
  /** Monotonic counter: total ticks since Start. */
  readonly evalCount: number;
  /** Monotonic counter: rebalances triggered since Start. */
  readonly rebalanceCount: number;
  /** Most-recent-first ring buffer of evaluation outcomes. */
  readonly history: readonly EvalHistoryEntry[];
  /** Error from the last tick or execution, cleared on next success. */
  readonly error: string | null;
  /** True only if a session key was found for the current SA. */
  readonly hasSessionKey: boolean;
  /** True when all inputs (SA, position, session key, passphrase) are set. */
  readonly canExecute: boolean;
  /** The current active LP position (if any). */
  readonly activePosition: LpPositionRow | null;
  /** Loaded session key metadata. */
  readonly sessionKey: StoredSessionKey | null;
  /** Last successful rebalance result (cleared on explicit reset). */
  readonly lastResult: RebalanceExecutionResult | null;
}

export interface UseRebalanceBotResult {
  readonly status: BotStatus;
  /**
   * Verify the passphrase against the stored ciphertext, and cache it in
   * memory only if decryption succeeds. Throws a user-facing error if the
   * passphrase is wrong. This is the preferred entry point (over
   * setPassphrase) because it fails fast on typos.
   */
  readonly verifyAndSetPassphrase: (pw: string) => Promise<void>;
  /** Cache the passphrase WITHOUT verification. Prefer verifyAndSetPassphrase. */
  readonly setPassphrase: (pw: string) => void;
  /** Clear the in-memory passphrase (on panel unmount or Stop). */
  readonly clearPassphrase: () => void;
  /** True iff a passphrase is currently cached. */
  readonly hasPassphrase: boolean;
  /** Enable the periodic tick. */
  readonly start: () => void;
  /** Disable the periodic tick; does NOT clear the passphrase. */
  readonly stop: () => void;
  /** Force a rebalance right now (respects session key rate limit). */
  readonly triggerManual: () => Promise<RebalanceExecutionResult>;
  /** Re-fetch DB state (session key + positions). */
  readonly refresh: () => Promise<void>;
}

export function useRebalanceBot(): UseRebalanceBotResult {
  const { address: eoaAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { address: saAddress } = useKernelAccount();
  const { data: poolState } = useUsdcWethPoolState();

  const [running, setRunning] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [lastEvalReason, setLastEvalReason] = useState<string | null>(null);
  const [lastEvalAt, setLastEvalAt] = useState<number | null>(null);
  const [nextEvalAt, setNextEvalAt] = useState<number | null>(null);
  const [evalCount, setEvalCount] = useState(0);
  const [rebalanceCount, setRebalanceCount] = useState(0);
  const [history, setHistory] = useState<EvalHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activePosition, setActivePosition] = useState<LpPositionRow | null>(
    null,
  );
  const [sessionKey, setSessionKey] = useState<StoredSessionKey | null>(null);
  const [lastResult, setLastResult] = useState<RebalanceExecutionResult | null>(
    null,
  );

  // Passphrase lives in a ref so we don't re-render the whole panel on
  // every keystroke, AND so the tick callback always sees the latest value
  // without depending on passphrase in its deps array.
  const passphraseRef = useRef<string | null>(null);
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const setPassphrase = useCallback((pw: string) => {
    passphraseRef.current = pw && pw.length > 0 ? pw : null;
    setHasPassphrase(pw.length > 0);
  }, []);
  const clearPassphrase = useCallback(() => {
    passphraseRef.current = null;
    setHasPassphrase(false);
  }, []);

  // Verify the passphrase by attempting to decrypt the stored ciphertext.
  // Fails fast on typo instead of waiting until the rebalance triggers the
  // actual execution path.
  const verifyAndSetPassphrase = useCallback(
    async (pw: string) => {
      if (pw.length < 8) {
        throw new Error('Passphrase must be at least 8 characters');
      }
      const sk = sessionKey;
      if (!sk) {
        throw new Error(
          'No active session key found — install one first in the panel above',
        );
      }
      // Attempt decryption; AES-GCM throws a generic error on bad key/tampered
      // ciphertext. We surface that verbatim so the user knows to check.
      const blob = stringToBlob(sk.ciphertext);
      await decryptString(blob, pw);
      // If we got here, decryption succeeded → the passphrase is correct.
      passphraseRef.current = pw;
      setHasPassphrase(true);
    },
    [sessionKey],
  );

  // Mutex: only one execution in flight at a time.
  const executingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!eoaAddress || chainId !== MAINNET_ID || !saAddress) {
      setActivePosition(null);
      setSessionKey(null);
      return;
    }
    try {
      const positions = await listLpPositionsForOwner(chainId, eoaAddress);
      const active = positions.find((p) => p.status === 'active') ?? null;
      setActivePosition(active);
      const sk = await fetchActiveSessionKey(saAddress);
      setSessionKey(sk);
    } catch (err) {
      debugWarn('[LiqAI] bot refresh failed:', err);
    }
  }, [eoaAddress, chainId, saAddress]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const doExecute = useCallback(
    async (trigger: RebalanceTrigger): Promise<RebalanceExecutionResult> => {
      if (!publicClient) throw new Error('No public RPC client');
      if (!isConnected || chainId !== MAINNET_ID) {
        throw new Error('Wallet not connected to mainnet');
      }
      if (!eoaAddress) throw new Error('No EOA address');
      if (!saAddress) throw new Error('Smart Account address not yet derived');
      const pw = passphraseRef.current;
      if (!pw) throw new Error('Passphrase not set — enter it in the panel first');

      // Re-read the authoritative active position from SQLite right before
      // executing. The hook's `activePosition` state can be stale if the
      // user minted or withdrew in another panel between bot start and this
      // trigger — acting on a stale (now-closed) tokenId previously caused
      // the rebalance executor to try decreaseLiquidity on a dead NFT,
      // surfacing as an opaque AA23 validator revert. Always source from DB.
      const freshPositions = await listLpPositionsForOwner(chainId, eoaAddress);
      const freshActive = freshPositions.find((p) => p.status === 'active');
      if (!freshActive) {
        throw new Error(
          'No active LP position to rebalance. Mint a position first, then retry.',
        );
      }
      // Also refresh the session key row — user may have rotated it.
      const sk = await fetchActiveSessionKey(saAddress);
      if (!sk) {
        throw new Error(
          'No active session key found — install one in the panel above first.',
        );
      }

      // Mirror fresh values into React state so the UI stays in sync.
      setActivePosition(freshActive);
      setSessionKey(sk);

      const sa = await getSmartAccountByOwner(chainId, eoaAddress);
      if (!sa) throw new Error('Smart Account DB row missing');

      // Re-read pool state right before executing — we never act on cached
      // sqrtPriceX96 from an earlier tick.
      const live = await readPoolState(publicClient as PublicClient);
      if (!live) throw new Error('Pool state unavailable');

      // Compute the new range from the current AI sweet spot.
      const provider = new CoinGeckoProvider();
      const series = await provider.fetchHistoricalPrices('ETH', HISTORY_DAYS);
      const currentEthUsd = series.prices[series.prices.length - 1];
      if (typeof currentEthUsd !== 'number' || currentEthUsd <= 0) {
        throw new Error('CoinGecko current ETH price invalid');
      }
      const sweet = calculateSweetSpot({
        prices: series.prices,
        currentPrice: currentEthUsd,
        feeTier: BOT_FEE_TIER,
        holdingPeriodDays: HISTORY_DAYS,
        k: 1.5,
      });
      const newTicks = usdRangeToPoolTickRange({
        usdLower: sweet.priceLower,
        usdUpper: sweet.priceUpper,
        decimals0Stable: live.token0Decimals,
        decimals1Asset: live.token1Decimals,
        feeTier: live.fee,
      });

      // Size the new position against the SA's ACTUAL post-collect balance.
      // executeRebalance reads the balance right after phase 1 completes,
      // so we don't have to estimate here — just load the session key and
      // dispatch. The executor scales USDC down if WETH is the limiting
      // side, so asymmetric collected amounts are handled transparently.

      const loaded = await loadSessionKeyClient({
        publicClient: publicClient as PublicClient,
        sessionKey: sk,
        passphrase: pw,
      });

      setExecuting(true);
      try {
        const result = await executeRebalance({
          sessionClient: loaded,
          publicClient: publicClient as PublicClient,
          ownerEoaAddress: eoaAddress as Address,
          smartAccountId: sa.id,
          lpPositionDbId: freshActive.id,
          oldTokenId: BigInt(freshActive.lp_token_id),
          oldLiquidity: BigInt(freshActive.liquidity),
          oldTickLower: freshActive.tick_lower,
          oldTickUpper: freshActive.tick_upper,
          poolAddress: live.poolAddress,
          token0: live.token0,
          token1: live.token1,
          feeTier: live.fee,
          newTickLower: newTicks.tickLower,
          newTickUpper: newTicks.tickUpper,
          sqrtPriceX96: live.sqrtPriceX96,
          trigger,
        });
        setLastResult(result);
        setError(null);
        await refresh();
        return result;
      } finally {
        setExecuting(false);
      }
    },
    // activePosition and sessionKey are read fresh from the DB inside the
    // callback, so we deliberately omit them from the deps to avoid re-creating
    // doExecute on every refresh and cascading into the tick's registration
    // cycle.
    [publicClient, isConnected, chainId, eoaAddress, saAddress, refresh],
  );

  const triggerManual = useCallback(async () => {
    if (executingRef.current) {
      throw new Error('A rebalance is already in flight');
    }
    executingRef.current = true;
    try {
      return await doExecute('manual');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      executingRef.current = false;
    }
  }, [doExecute]);

  // Record an evaluation outcome in history + the public status fields.
  const recordEvaluation = useCallback(
    (outcome: EvalOutcome, reason: string) => {
      const now = Date.now();
      setLastEvalReason(reason);
      setLastEvalAt(now);
      setEvalCount((c) => c + 1);
      setHistory((prev) =>
        [{ at: now, outcome, reason }, ...prev].slice(0, EVAL_HISTORY_MAX),
      );
    },
    [],
  );

  // Mirror reactive state into refs so the tick effect does NOT re-register
  // on every `poolState` refetch (which happens every 30 s via the
  // useUsdcWethPoolState query). Prior bug: `poolState` in the deps array
  // caused clearInterval + setInterval on every refresh, and the new
  // interval fires an immediate `tick()` — evaluations ended up running
  // roughly every 30 s instead of every 5 min, and rare transient triggers
  // caused real rebalances (real gas cost). The fix: the tick effect only
  // depends on `running`; everything else is read through refs.
  const tickDepsRef = useRef({
    activePosition,
    sessionKey,
    poolState,
    doExecute,
    recordEvaluation,
    eoaAddress,
    saAddress,
    publicClient,
  });
  useEffect(() => {
    tickDepsRef.current = {
      activePosition,
      sessionKey,
      poolState,
      doExecute,
      recordEvaluation,
      eoaAddress,
      saAddress,
      publicClient,
    };
  });

  // Periodic tick — registered exactly once per Start (one setInterval).
  useEffect(() => {
    if (!running) {
      setNextEvalAt(null);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (executingRef.current) return; // skip — previous tick still running
      const {
        poolState,
        doExecute,
        recordEvaluation,
        eoaAddress: tickEoa,
        saAddress: tickSa,
        publicClient,
      } = tickDepsRef.current;
      setEvaluating(true);
      setNextEvalAt(Date.now() + DEFAULT_TICK_INTERVAL_MS);
      try {
        // Always re-read the active position + session key from SQLite on
        // each tick. A prior implementation read from React state via
        // tickDepsRef, which went stale if the user minted or withdrew in
        // another panel. Evaluating a now-closed position would then miss
        // triggers or attempt rebalance of a dead NFT.
        if (!tickEoa || !tickSa) {
          recordEvaluation('idle', 'Wallet or Smart Account not yet derived');
          return;
        }
        const freshPositions = await listLpPositionsForOwner(
          MAINNET_ID,
          tickEoa,
        );
        const activePosition =
          freshPositions.find((p) => p.status === 'active') ?? null;
        const sessionKey = await fetchActiveSessionKey(tickSa);
        setActivePosition(activePosition);
        setSessionKey(sessionKey);
        if (!activePosition) {
          recordEvaluation('idle', 'No active LP position — bot idle');
          return;
        }
        if (!sessionKey) {
          recordEvaluation('idle', 'No active session key — bot idle');
          return;
        }
        if (!passphraseRef.current) {
          recordEvaluation('idle', 'Passphrase not set — bot paused');
          return;
        }
        // Pre-flight expiry check: if the session key has expired (or will
        // expire within the next tick window) we stop the bot entirely rather
        // than let the user discover the failure via a cryptic AA-layer
        // error. The user then installs a fresh key and restarts the bot.
        const nowSecExpiry = Math.floor(Date.now() / 1000);
        if (sessionKey.validUntil <= nowSecExpiry) {
          recordEvaluation(
            'error',
            `Session key expired at ${new Date(sessionKey.validUntil * 1000).toLocaleString()} — ` +
              `bot stopped automatically. Install a fresh session key to resume automation.`,
          );
          setError('Session key expired — install a new one to resume.');
          // Stop the periodic tick; keeps the current passphrase in memory so
          // a restart is cheap once a new key is installed.
          setRunning(false);
          return;
        }

        // Gather AI inputs for evaluateRebalance.
        const provider = new CoinGeckoProvider();
        const series = await provider.fetchHistoricalPrices('ETH', HISTORY_DAYS);
        if (series.prices.length < 10) {
          recordEvaluation('error', 'Insufficient price history from CoinGecko');
          return;
        }
        const currentEthUsd = series.prices[series.prices.length - 1];
        if (typeof currentEthUsd !== 'number' || currentEthUsd <= 0) {
          recordEvaluation('error', 'CoinGecko current price invalid');
          return;
        }

        const { usdc } = UNISWAP_V3_ADDRESSES[MAINNET_ID];
        if (
          poolState &&
          poolState.token0.toLowerCase() !== (usdc as string).toLowerCase()
        ) {
          recordEvaluation('error', 'Unexpected pool orientation — bot bailing');
          return;
        }
        if (!poolState) {
          recordEvaluation('idle', 'Pool state not loaded yet — waiting');
          return;
        }

        // Fee snapshot — record a row for this tick regardless of what the
        // AI decides next. These are the raw samples that drive the 24h
        // rolling realized APR on the positions dashboard. Any failure is
        // swallowed inside recordFeeSnapshot — we NEVER want a telemetry
        // write to break a rebalance evaluation.
        if (publicClient && tickSa) {
          void recordFeeSnapshot({
            publicClient: publicClient as PublicClient,
            smartAccountAddress: tickSa,
            position: activePosition,
            poolState,
          });
          // Opportunistically prune once per tick; this is a bounded DELETE
          // with no per-row work so it's effectively free.
          void pruneOldSnapshots();
        }

        const priceBounds = deriveUsdPriceBoundsFromTicks({
          tickLower: activePosition.tick_lower,
          tickUpper: activePosition.tick_upper,
          decimals0: poolState.token0Decimals,
          decimals1: poolState.token1Decimals,
        });

        const evalRes = evaluateRebalance(
          {
            currentPrice: currentEthUsd,
            tickLower: activePosition.tick_lower,
            tickUpper: activePosition.tick_upper,
            priceLower: priceBounds.usdLower,
            priceUpper: priceBounds.usdUpper,
            recentPrices: series.prices,
            timestamps: series.timestamps,
          },
          BOT_FEE_TIER,
        );

        const rangeSummary =
          `ETH $${currentEthUsd.toFixed(2)} · ` +
          `range $${priceBounds.usdLower.toFixed(0)}–$${priceBounds.usdUpper.toFixed(0)}`;

        if (evalRes.shouldRebalance && evalRes.trigger) {
          // Confidence-based cooldown: the active position's minted_at is the
          // time of the previous rebalance (each rebalance mints a fresh NFT).
          // For low-confidence signals (wick, spike/dip 3%), skip if we just
          // rebalanced — the same 3-hour CoinGecko window can keep re-firing
          // the same signal and burn gas for no real positional benefit.
          const cooldownSec = cooldownSecondsForConfidence(evalRes.confidence);
          const nowSec = Math.floor(Date.now() / 1000);
          const secSinceMint = nowSec - activePosition.minted_at;
          if (cooldownSec > 0 && secSinceMint < cooldownSec) {
            const remaining = Math.max(0, cooldownSec - secSinceMint);
            recordEvaluation(
              'no_trigger',
              `Cooldown: ${evalRes.trigger} (conf ${evalRes.confidence}%) suppressed — ` +
                `need ${cooldownSec}s since last rebalance, elapsed ${secSinceMint}s, ` +
                `${remaining}s remaining. ${rangeSummary}`,
            );
            return;
          }

          // Gas-aware economic gate: for low-confidence triggers, don't fire
          // if the estimated gas cost exceeds MAX_GAS_COST_PCT_OF_POSITION of
          // the position's current USD value. range_exit (confidence=99)
          // always fires — a position fully out of range earns $0 in fees so
          // even a 20%-of-value gas bill is the right trade.
          //
          // This is the economic defence that makes small-lot automation
          // viable: prior runs showed rebalances costing $5-15 on a $50
          // position, i.e. 10-30% of value per trigger. With a 2% cap a
          // $50 position only fires if gas is under $1 — which on mainnet
          // means the bot effectively waits for low-gas windows or stays
          // idle on small lots rather than bleeding gas.
          if (evalRes.confidence < 99 && publicClient) {
            try {
              const ethUsd = deriveEthUsd(poolState);
              const [gasCostUsd, positionValueUsd] = await Promise.all([
                estimateRebalanceGasCostUsd(
                  publicClient as PublicClient,
                  ethUsd,
                ),
                readPositionValueUsd(
                  publicClient as PublicClient,
                  activePosition,
                  poolState,
                ),
              ]);
              const maxGasUsd = positionValueUsd * MAX_GAS_COST_PCT_OF_POSITION;
              if (gasCostUsd > maxGasUsd) {
                recordEvaluation(
                  'no_trigger',
                  `Gas gate: ${evalRes.trigger} (conf ${evalRes.confidence}%) suppressed — ` +
                    `est. gas $${gasCostUsd.toFixed(2)} > ` +
                    `${(MAX_GAS_COST_PCT_OF_POSITION * 100).toFixed(0)}% of position ` +
                    `$${positionValueUsd.toFixed(2)} ($${maxGasUsd.toFixed(2)} cap). ` +
                    rangeSummary,
                );
                return;
              }
            } catch (gasErr) {
              // Don't block on gas estimation failures — log and continue.
              // The alternative is risking a stuck automation on a flaky RPC.
              debugWarn('[LiqAI bot] gas-aware gate failed, proceeding:', gasErr);
            }
          }

          recordEvaluation(
            'triggered',
            `Rebalance triggered (${evalRes.trigger}) — ${evalRes.reason}. ${rangeSummary}`,
          );
          if (!executingRef.current) {
            executingRef.current = true;
            try {
              await doExecute(evalRes.trigger);
              setRebalanceCount((c) => c + 1);
            } finally {
              executingRef.current = false;
            }
          }
        } else {
          recordEvaluation(
            'no_trigger',
            `In range, no action needed. ${rangeSummary}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        tickDepsRef.current.recordEvaluation('error', `Tick failed: ${msg}`);
      } finally {
        setEvaluating(false);
        if (!cancelled) {
          setNextEvalAt(Date.now() + DEFAULT_TICK_INTERVAL_MS);
        }
      }
    };

    // Fire immediately, then every DEFAULT_TICK_INTERVAL_MS.
    tick();
    const handle = setInterval(tick, DEFAULT_TICK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // ONLY re-register on start/stop; everything else is read through the ref above.
  }, [running]);

  const start = useCallback(() => {
    setError(null);
    // Reset the ephemeral session counters so "since Start" is meaningful.
    setEvalCount(0);
    setRebalanceCount(0);
    setHistory([]);
    setRunning(true);
  }, []);
  const stop = useCallback(() => {
    setRunning(false);
    setNextEvalAt(null);
  }, []);

  const canExecute =
    !!activePosition &&
    !!sessionKey &&
    hasPassphrase &&
    !!saAddress &&
    isConnected &&
    chainId === MAINNET_ID;

  return {
    status: {
      running,
      evaluating,
      executing,
      lastEvalReason,
      lastEvalAt,
      nextEvalAt,
      tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
      evalCount,
      rebalanceCount,
      history,
      error,
      hasSessionKey: !!sessionKey,
      canExecute,
      activePosition,
      sessionKey,
      lastResult,
    },
    verifyAndSetPassphrase,
    setPassphrase,
    clearPassphrase,
    hasPassphrase,
    start,
    stop,
    triggerManual,
    refresh,
  };
}

// ── helpers ───────────────────────────────────────────────────────

/**
 * Derive human USD-per-ETH price bounds from a stored tick range for a
 * stable/asset pool (stable=token0). Inverts the tick→sqrtPrice direction
 * to recover the USD endpoints.
 *
 * Assumes the tick-range inverts USD direction (see usdRangeToPoolTickRange):
 *   tickLower ↔ usdUpper
 *   tickUpper ↔ usdLower
 */
function deriveUsdPriceBoundsFromTicks(options: {
  tickLower: number;
  tickUpper: number;
  decimals0: number; // stable (USDC) decimals
  decimals1: number; // asset (WETH) decimals
}): { usdLower: number; usdUpper: number } {
  const { tickLower, tickUpper, decimals0, decimals1 } = options;
  const rawAtLower = Math.pow(1.0001, tickLower);
  const rawAtUpper = Math.pow(1.0001, tickUpper);
  // rawPrice = token1/token0 at that tick (decimal-unaware). For a
  // stable=token0 pool, USD-per-asset = 1 / (rawPrice × 10^(dec0-dec1))
  // after decimal-adjusting. sqrtPriceX96ToPrice does the decimal
  // adjustment; here we replicate: adjustedPrice = rawPrice × 10^(dec0-dec1)
  const dec = decimals0 - decimals1;
  const adjustedAtLower = rawAtLower * Math.pow(10, dec);
  const adjustedAtUpper = rawAtUpper * Math.pow(10, dec);
  // USD-per-ETH = 1 / adjustedPrice (WETH-per-USDC → USD-per-WETH).
  const usdAtLower = 1 / adjustedAtLower;
  const usdAtUpper = 1 / adjustedAtUpper;
  // Inverted direction: lower tick yields larger USD.
  const usdLower = Math.min(usdAtLower, usdAtUpper);
  const usdUpper = Math.max(usdAtLower, usdAtUpper);
  return { usdLower, usdUpper };
}

// Suppress unused symbol warning for the silently-referenced helper for
// future calibration imports; drop if not needed.
void sqrtPriceX96ToPrice;

'use client';

/**
 * executeRebalance — closes an existing Uniswap V3 LP position and re-opens
 * one at the AI's new recommended range, all in a SINGLE userOp signed by
 * the autonomous session key (no EOA wallet prompt).
 *
 * Sequence (batched so it's atomic and cheap):
 *   1. NPM.decreaseLiquidity({ tokenId, liquidity=ALL, min=0, deadline })
 *   2. NPM.collect({ tokenId, recipient=SA, amountMax=u128.max })
 *   3. USDC.approve(NPM, newAmount0Desired)
 *   4. WETH.approve(NPM, newAmount1Desired)
 *   5. NPM.mint({ ... new range ... })
 *
 * After inclusion:
 *   - Close the old lp_positions row (status='closed').
 *   - Insert the new lp_positions row from IncreaseLiquidity event.
 *   - Append rebalance_history row (old + new ticks).
 *   - Audit trail: rebalance_executed.
 *
 * SECURITY:
 *   - Session key can only sign calls that match the installed permission
 *     policy: NPM mint/decrease/collect + USDC/WETH approve(spender=NPM).
 *     Any deviation from this sequence reverts at the permission validator,
 *     not at the contract, so the blast radius is tightly bounded.
 *   - amount*Min = 0 on decrease is acceptable because we're moving the
 *     user's own funds within their own SA.
 *   - The new mint amount1Min uses the asymmetric buffer pattern from
 *     mintExecutor.ts — otherwise the pool's partial-refund would trip
 *     slippage.
 *   - Rebalance happens only when `evaluateRebalance` says so; no time-based
 *     "always rebalance" loop.
 */

import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  ERC20_ABI,
  UNISWAP_V3_ADDRESSES,
} from '@liqai/uniswap';
import {
  buildNpmMintArgs,
  computeRequiredWethForUsdc,
  DEFAULT_SLIPPAGE_BPS_UI,
} from './mintParams';
import { writeAudit, getDb, insertLpPosition } from './db';
import { ENTRYPOINT, KERNEL_VERSION } from './zerodev';
import { debugLog } from './debugLog';
import { assertCallsSafe } from './sessionKeyGuard';
import type { LoadedSessionKeyClient } from './sessionKeyLoad';

const MAINNET_ID = 1;
const NPM_ABI_VIEM = parseAbi(NONFUNGIBLE_POSITION_MANAGER_ABI);
const ERC20_ABI_VIEM = parseAbi(ERC20_ABI);
const MAX_U128 = 2n ** 128n - 1n;
const REBALANCE_DEADLINE_SEC = 300;

export type RebalanceTrigger =
  | 'range_exit'
  | 'spike'
  | 'dip'
  | 'wick'
  | 'scheduled'
  | 'manual';

export interface RebalanceExecutionInput {
  readonly sessionClient: LoadedSessionKeyClient;
  /** Read client used to fetch the SA's actual post-collect token balances. */
  readonly publicClient: PublicClient;
  readonly ownerEoaAddress: Address;
  readonly smartAccountId: number;
  readonly lpPositionDbId: number;
  readonly oldTokenId: bigint;
  readonly oldLiquidity: bigint;
  readonly oldTickLower: number;
  readonly oldTickUpper: number;
  readonly poolAddress: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly feeTier: number;
  readonly newTickLower: number;
  readonly newTickUpper: number;
  /** Live pool sqrtPriceX96 from slot0 — used to size the WETH side. */
  readonly sqrtPriceX96: bigint;
  readonly trigger: RebalanceTrigger;
  /** Optional: override default slippage. */
  readonly slippageBps?: number;
}

export interface RebalanceExecutionResult {
  readonly userOpHash: Hex;
  readonly txHash: Hex;
  readonly newTokenId: bigint;
  readonly newLiquidity: bigint;
  readonly collectedAmount0: bigint;
  readonly collectedAmount1: bigint;
  readonly mintedAmount0: bigint;
  readonly mintedAmount1: bigint;
  readonly newLpPositionDbId: number;
  readonly rebalanceHistoryId: number;
}

/**
 * Close existing position and open a new one at the AI's new range,
 * atomically via a session-key-signed userOp.
 */
export async function executeRebalance(
  input: RebalanceExecutionInput,
): Promise<RebalanceExecutionResult> {
  const { nonfungiblePositionManager: NPM } = UNISWAP_V3_ADDRESSES[MAINNET_ID];
  const npmAddress = NPM as Address;
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS_UI;
  const deadline = BigInt(
    Math.floor(Date.now() / 1000) + REBALANCE_DEADLINE_SEC,
  );
  if (input.newTickLower >= input.newTickUpper) {
    throw new Error('newTickLower must be < newTickUpper');
  }
  if (input.oldLiquidity <= 0n) {
    throw new Error('Old position has no liquidity to rebalance');
  }

  // Check on-chain liquidity of the old position. If phase 1 of a previous
  // attempt already pulled it out (and phase 2 then failed), skip phase 1
  // and go straight to the mint. This lets the user recover without losing
  // the position or having to manually intervene.
  const onchainPos = (await input.publicClient.readContract({
    address: npmAddress,
    abi: NPM_ABI_VIEM,
    functionName: 'positions',
    args: [input.oldTokenId],
  })) as readonly unknown[];
  // positions() returns a 12-field tuple; index 7 is liquidity (uint128).
  const onchainLiquidity = onchainPos[7] as bigint;
  const skipPhase1 = onchainLiquidity === 0n;
  if (skipPhase1) {
    debugLog(
      '[LiqAI rebalance] On-chain liquidity=0 — skipping phase 1 (recovering from prior partial rebalance)',
      { oldTokenId: input.oldTokenId.toString() },
    );
  }

  // Phase 1: Pull liquidity out of the old position (decrease + collect).
  // Phase 2: Approve + mint the new range. Phase 2 amounts are computed
  // AFTER phase 1 by reading the SA's actual USDC+WETH balance, so we never
  // try to pull more than was actually collected.
  //
  // Why two userOps (not one 5-call batch)?
  //   - On the FIRST use of a session key, the userOp carries the permission
  //     validator's enable data alongside the batch. Some validator versions
  //     reject large enable+batch combinations with AA23. Splitting keeps
  //     the enable userOp small; phase 2 runs against the already-enabled
  //     validator.
  //   - Critical correctness gain: phase 2 uses the ACTUAL post-collect
  //     balances. Sizing ahead of time (via approxUsdcFromLiquidity) diverges
  //     from reality by a few percent due to pool price drift + accumulated
  //     fees, and if amount0Desired > SA balance, NPM.mint's transferFrom
  //     reverts at execution time.
  //   - Each userOp still enjoys the full policy enforcement.
  //   - Cost: ~2× bundler fees (still <$1 on mainnet at typical gas).
  const phase1Calls: Array<{ to: Address; data: Hex; value: bigint }> = [
    {
      to: npmAddress,
      data: encodeFunctionData({
        abi: NPM_ABI_VIEM,
        functionName: 'decreaseLiquidity',
        args: [
          {
            tokenId: input.oldTokenId,
            liquidity: input.oldLiquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline,
          },
        ],
      }),
      value: 0n,
    },
    {
      to: npmAddress,
      data: encodeFunctionData({
        abi: NPM_ABI_VIEM,
        functionName: 'collect',
        args: [
          {
            tokenId: input.oldTokenId,
            recipient: input.sessionClient.smartAccountAddress,
            amount0Max: MAX_U128,
            amount1Max: MAX_U128,
          },
        ],
      }),
      value: 0n,
    },
  ];

  // ── Phase 1: decrease + collect ──────────────────────────────────
  // Skipped if a prior attempt already drained the old NFT (recovery path).
  let phase1Hash: Hex | null = null;
  let phase1Receipt: Awaited<
    ReturnType<typeof input.sessionClient.client.waitForUserOperationReceipt>
  > | null = null;
  if (!skipPhase1) {
    debugLog('[LiqAI rebalance] Phase 1: decrease + collect', {
      tokenId: input.oldTokenId.toString(),
      liquidity: input.oldLiquidity.toString(),
      sessionKey: input.sessionClient.sessionKeyAddress,
    });
    // Phase 1 gas: this userOp includes the first-use permission-validator
    // install (enable signature verification + module install + policy data
    // store) on top of the actual call execution. Pimlico reports OOG as
    // "AA23 reverted (or OOG)" indistinguishably from a real revert, so we
    // massively over-provision verification gas. Unused gas is refunded.
    phase1Hash = await sendWithDiagnostics(
      input.sessionClient.client,
      phase1Calls,
      'phase1',
      {
        callGasLimit: 1_000_000n,
        verificationGasLimit: 2_500_000n,
        preVerificationGas: 300_000n,
      },
      input.sessionClient.smartAccountAddress,
    );
    phase1Receipt = await input.sessionClient.client.waitForUserOperationReceipt(
      {
        hash: phase1Hash,
      },
    );
    if (!phase1Receipt.success) {
      throw new Error(
        `Rebalance phase 1 (decrease+collect) reverted on-chain (tx=${phase1Receipt.receipt.transactionHash})`,
      );
    }
  }

  // ── Between phases: read SA's actual balances ───────────────────
  // This is the critical correctness step. Rather than trusting our ahead-
  // of-time estimate (which can drift from reality by a few %), we read
  // what was ACTUALLY collected and size the mint against that.
  const [saUsdcBalance, saWethBalance] = await Promise.all([
    input.publicClient.readContract({
      address: input.token0,
      abi: ERC20_ABI_VIEM,
      functionName: 'balanceOf',
      args: [input.sessionClient.smartAccountAddress],
    }) as Promise<bigint>,
    input.publicClient.readContract({
      address: input.token1,
      abi: ERC20_ABI_VIEM,
      functionName: 'balanceOf',
      args: [input.sessionClient.smartAccountAddress],
    }) as Promise<bigint>,
  ]);

  // Leave a tiny headroom (0.1%) below the balance so any rounding in the
  // ERC20 transferFrom path can't trip a "balance: x, needed: x+1" scenario
  // with fee-on-transfer quirks. USDC + WETH don't have fee-on-transfer on
  // mainnet, but the headroom is effectively free.
  const usdcAvailable = (saUsdcBalance * 999n) / 1000n;
  if (usdcAvailable <= 0n) {
    throw new Error(
      `Phase 1 collected ${saUsdcBalance} USDC raw but that's below the 0.1% headroom threshold; cannot mint`,
    );
  }

  // Size WETH requirement against the AI's new range using the LIVE pool
  // price. If the required WETH exceeds what we actually have, scale the
  // USDC side down proportionally so we use the available WETH fully.
  let usdcToUse = usdcAvailable;
  let wethRequired = computeRequiredWethForUsdc({
    usdcAmountRaw: usdcToUse,
    sqrtPriceX96: input.sqrtPriceX96,
    tickLower: input.newTickLower,
    tickUpper: input.newTickUpper,
    bufferMultiplier: 1.02,
  });
  if (wethRequired > saWethBalance) {
    // Scale USDC down: wethBalance / wethRequired = ratio, apply to USDC.
    // Use 0.995 safety factor so the buffer still holds after rescale.
    const scaled =
      (usdcToUse * ((saWethBalance * 995n) / 1000n)) / wethRequired;
    if (scaled <= 0n) {
      throw new Error(
        `SA has ${saWethBalance} WETH raw but mint needs ${wethRequired}; cannot rescale to a positive USDC amount`,
      );
    }
    usdcToUse = scaled;
    wethRequired = computeRequiredWethForUsdc({
      usdcAmountRaw: usdcToUse,
      sqrtPriceX96: input.sqrtPriceX96,
      tickLower: input.newTickLower,
      tickUpper: input.newTickUpper,
      bufferMultiplier: 1.02,
    });
  }
  const wethAvailable = (saWethBalance * 999n) / 1000n;
  const wethAmountRaw = wethRequired > wethAvailable ? wethAvailable : wethRequired;

  // Asymmetric mins — same pattern as mintExecutor.ts.
  const usdcMinTight = (usdcToUse * BigInt(10_000 - slippageBps)) / 10_000n;
  const wethMinFloor = (wethAmountRaw * 88n) / 100n;

  const mintArgs = buildNpmMintArgs({
    token0: input.token0,
    token1: input.token1,
    feeTier: input.feeTier,
    tickLower: input.newTickLower,
    tickUpper: input.newTickUpper,
    amount0Desired: usdcToUse,
    amount1Desired: wethAmountRaw,
    recipient: input.sessionClient.smartAccountAddress,
    slippageBps,
    amount0MinOverride: usdcMinTight,
    amount1MinOverride: wethMinFloor,
  });

  const phase2Calls: Array<{ to: Address; data: Hex; value: bigint }> = [
    {
      to: input.token0,
      data: encodeFunctionData({
        abi: ERC20_ABI_VIEM,
        functionName: 'approve',
        args: [npmAddress, usdcToUse],
      }),
      value: 0n,
    },
    {
      to: input.token1,
      data: encodeFunctionData({
        abi: ERC20_ABI_VIEM,
        functionName: 'approve',
        args: [npmAddress, wethAmountRaw],
      }),
      value: 0n,
    },
    {
      to: npmAddress,
      data: encodeFunctionData({
        abi: NPM_ABI_VIEM,
        functionName: 'mint',
        args: [mintArgs],
      }),
      value: 0n,
    },
  ];

  // ── Phase 2: approve × 2 + mint ──────────────────────────────────
  //
  // Gas sizing depends on whether this is the FIRST use of the session key:
  //   - Normal flow: phase 1 already ran with ENABLE mode and installed the
  //     permission validator. Phase 2 runs with DEFAULT mode → cheap
  //     verification (~400-800k).
  //   - Recovery flow (skipPhase1=true): the previous attempt drained the
  //     old NFT but failed to mint, AND phase 2 is now being attempted with
  //     a fresh session key. The validator is NOT yet installed; phase 2
  //     userOp must include ENABLE-mode install data + run all 3 calls in
  //     a single batch. This needs the same elevated verification budget
  //     as a normal phase 1 (~2.5M) — otherwise Pimlico's simulator runs
  //     out and reports "AA23 reverted (or OOG)" as a generic validation
  //     revert.
  const phase2NeedsEnableInstall = skipPhase1;
  const phase2Gas = phase2NeedsEnableInstall
    ? {
        callGasLimit: 1_500_000n,
        verificationGasLimit: 2_500_000n,
        preVerificationGas: 300_000n,
      }
    : {
        callGasLimit: 1_200_000n,
        verificationGasLimit: 800_000n,
        preVerificationGas: 200_000n,
      };
  debugLog('[LiqAI rebalance] Phase 2: approve + mint', {
    tickLower: input.newTickLower,
    tickUpper: input.newTickUpper,
    saUsdcBalance: saUsdcBalance.toString(),
    saWethBalance: saWethBalance.toString(),
    usdcToUse: usdcToUse.toString(),
    wethAmountRaw: wethAmountRaw.toString(),
    phase2NeedsEnableInstall,
    phase2Gas,
  });
  const phase2Hash = await sendWithDiagnostics(
    input.sessionClient.client,
    phase2Calls,
    'phase2',
    phase2Gas,
    input.sessionClient.smartAccountAddress,
  );
  const receipt = await input.sessionClient.client.waitForUserOperationReceipt({
    hash: phase2Hash,
  });
  if (!receipt.success) {
    const phase1Note = phase1Receipt
      ? `Phase 1 (decrease+collect) already completed successfully in tx=${phase1Receipt.receipt.transactionHash}; `
      : 'Phase 1 was skipped because the old NFT was already drained by a prior attempt; ';
    throw new Error(
      `Rebalance phase 2 (approve+mint) reverted on-chain (tx=${receipt.receipt.transactionHash}). ` +
        phase1Note +
        `tokens are safe inside your SA. Click "Rebalance now" again to retry just the mint step.`,
    );
  }

  // Parse events — Collect from phase 1 (if we ran it), IncreaseLiquidity
  // from phase 2. When skipPhase1 is true the collected amounts come from
  // a prior run and aren't available in this userOp's logs.
  const collect = phase1Receipt
    ? parseCollectEvent(phase1Receipt.logs, input.oldTokenId)
    : null;
  const increase = parseIncreaseLiquidityEvent(
    receipt.logs,
    input.oldTokenId, // exclude old tokenId — the new one differs
  );
  if (!increase) {
    throw new Error(
      `Rebalance tx succeeded but IncreaseLiquidity for the new position was not found ` +
        `(tx=${receipt.receipt.transactionHash})`,
    );
  }

  // ── DB writes ──────────────────────────────────────────────────
  const db = await getDb();
  const nowSec = Math.floor(Date.now() / 1000);

  // Close the old row.
  await db.execute(
    `UPDATE lp_positions SET status = 'closed', closed_at = $1 WHERE id = $2`,
    [nowSec, input.lpPositionDbId],
  );

  // Insert the new row.
  const newLpPositionDbId = await insertLpPosition({
    smart_account_id: input.smartAccountId,
    chain_id: MAINNET_ID,
    lp_token_id: increase.tokenId.toString(),
    pool_address: input.poolAddress,
    token0_address: input.token0,
    token1_address: input.token1,
    fee_tier: input.feeTier,
    tick_lower: input.newTickLower,
    tick_upper: input.newTickUpper,
    liquidity: increase.liquidity.toString(),
    minted_at: nowSec,
    status: 'active',
  });

  // Rebalance history row.
  const rebalanceRes = await db.execute(
    `INSERT INTO rebalance_history
      (lp_position_id, trigger, old_tick_lower, old_tick_upper,
       new_tick_lower, new_tick_upper, executed_at, tx_hash,
       initiated_by, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.lpPositionDbId,
      mapTriggerForDb(input.trigger),
      input.oldTickLower,
      input.oldTickUpper,
      input.newTickLower,
      input.newTickUpper,
      nowSec,
      receipt.receipt.transactionHash,
      'session_key',
      `Old tokenId=${input.oldTokenId.toString()} → new tokenId=${increase.tokenId.toString()}`,
    ],
  );
  if (typeof rebalanceRes.lastInsertId !== 'number') {
    throw new Error('rebalance_history insert did not return lastInsertId');
  }

  // Phase 4.4: record a structured summary of every inner call that
  // made up this rebalance. Each entry is `{ target, fn, keyArg }` — just
  // enough for an auditor to verify post-hoc that every call's recipient
  // was the SA and every approve was capped. The raw callData is NOT
  // logged (it's reconstructable from tx_hash + chain block data).
  const innerCalls = summariseRebalanceCalls({
    phase1: phase1Calls,
    phase2: phase2Calls,
    sa: input.sessionClient.smartAccountAddress,
  });

  await writeAudit({
    action: 'rebalance_executed',
    actor_address: input.ownerEoaAddress,
    chain_id: MAINNET_ID,
    target_address: npmAddress,
    tx_hash: receipt.receipt.transactionHash,
    description:
      `Rebalance(${input.trigger}) via session key ${input.sessionClient.sessionKeyAddress}: ` +
      `oldTokenId=${input.oldTokenId.toString()} [${input.oldTickLower},${input.oldTickUpper}] → ` +
      `newTokenId=${increase.tokenId.toString()} [${input.newTickLower},${input.newTickUpper}]`,
    metadata: {
      oldTokenId: input.oldTokenId.toString(),
      newTokenId: increase.tokenId.toString(),
      collectedAmount0: collect?.amount0.toString() ?? 'unknown',
      collectedAmount1: collect?.amount1.toString() ?? 'unknown',
      mintedAmount0: increase.amount0.toString(),
      mintedAmount1: increase.amount1.toString(),
      entryPoint: ENTRYPOINT.address,
      kernelVersion: KERNEL_VERSION,
      innerCalls,
    },
  });

  return {
    userOpHash: phase2Hash,
    txHash: receipt.receipt.transactionHash,
    newTokenId: increase.tokenId,
    newLiquidity: increase.liquidity,
    collectedAmount0: collect?.amount0 ?? 0n,
    collectedAmount1: collect?.amount1 ?? 0n,
    mintedAmount0: increase.amount0,
    mintedAmount1: increase.amount1,
    newLpPositionDbId,
    rebalanceHistoryId: rebalanceRes.lastInsertId,
  };
}

// ── helpers ───────────────────────────────────────────────────────

/**
 * Wrap sendUserOperation with verbose diagnostic logging that surfaces the
 * revert selector on AA23 failures. The session-key + permission-validator
 * combination raises custom errors that don't decode via the standard
 * viem error path; we log enough context to debug from the browser console.
 */
async function sendWithDiagnostics(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  calls: Array<{ to: Address; data: Hex; value: bigint }>,
  phaseLabel: string,
  gas: {
    callGasLimit: bigint;
    verificationGasLimit: bigint;
    preVerificationGas: bigint;
  },
  /** Expected recipient for every mint/collect in this batch. The
   *  session-key guard rejects any call that does not pay out to this
   *  address. */
  sa: Address,
): Promise<Hex> {
  // Off-chain second line of defence (Phase 4.1). Mirrors the on-chain
  // CallPolicy rules. A client-side bug OR a compromised binary would
  // have to bypass this BEFORE the userOp is even signed.
  assertCallsSafe(calls, sa);
  try {
    return (await client.sendUserOperation({
      calls,
      ...gas,
    })) as Hex;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const selectorMatch = msg.match(/0x[a-fA-F0-9]{8}/g);
    // eslint-disable-next-line no-console
    console.error(
      `[LiqAI rebalance ${phaseLabel}] sendUserOperation failed.`,
      {
        callsCount: calls.length,
        callTargets: calls.map((c) => c.to),
        gas,
        errorMessage: msg,
        revertSelectors: selectorMatch,
      },
    );
    throw new Error(
      `Rebalance ${phaseLabel} failed: ${msg}` +
        (selectorMatch
          ? `\n\nRevert selector(s): ${selectorMatch.slice(0, 3).join(', ')}\n` +
            `If this is 0x5c494fad or similar permission-validator error, the ` +
            `session key's on-chain policies rejected this call sequence. ` +
            `Most common causes: (1) policy doesn't include the selector, ` +
            `(2) ParamRule mismatch (e.g., approve spender != NPM), ` +
            `(3) rate limit exceeded.`
          : ''),
    );
  }
}

// The SQL CHECK constraint on rebalance_history.trigger only allows these values.
function mapTriggerForDb(t: RebalanceTrigger): string {
  // All RebalanceTrigger values are in the SQL allow-list already.
  return t;
}

/**
 * Summarise the inner calls of a rebalance for audit-log metadata.
 *
 * For each call we capture:
 *   - which phase it belonged to (context for post-hoc review)
 *   - target contract (NPM / USDC / WETH / unknown)
 *   - decoded function name
 *   - the one "key" argument an auditor cares about: recipient for
 *     mint/collect, amount for approve. decreaseLiquidity has no
 *     security-interesting arg beyond tokenId.
 *
 * The audit_log metadata Zod schema rejects values shaped like private
 * keys (32-byte hex strings), so we stringify amounts and addresses are
 * 20 bytes — safe.
 */
function summariseRebalanceCalls(input: {
  phase1: ReadonlyArray<{ to: Address; data: Hex; value: bigint }>;
  phase2: ReadonlyArray<{ to: Address; data: Hex; value: bigint }>;
  sa: Address;
}): Array<{
  phase: 'phase1' | 'phase2';
  target: string;
  fn: string;
  keyArg?: string;
}> {
  const out: Array<{
    phase: 'phase1' | 'phase2';
    target: string;
    fn: string;
    keyArg?: string;
  }> = [];
  const decodeOne = (
    phase: 'phase1' | 'phase2',
    call: { to: Address; data: Hex; value: bigint },
  ): void => {
    try {
      const decoded = decodeFunctionData({
        abi: NPM_ABI_VIEM,
        data: call.data,
      });
      if (decoded.functionName === 'mint' || decoded.functionName === 'collect') {
        const params = (decoded.args as readonly unknown[])[0] as {
          recipient?: Address;
        };
        out.push({
          phase,
          target: call.to,
          fn: decoded.functionName,
          keyArg: `recipient=${params.recipient ?? 'unknown'}`,
        });
        return;
      }
      if (decoded.functionName === 'decreaseLiquidity') {
        out.push({ phase, target: call.to, fn: 'decreaseLiquidity' });
        return;
      }
    } catch {
      // fall through to ERC20 attempt
    }
    try {
      const decoded = decodeFunctionData({
        abi: ERC20_ABI_VIEM,
        data: call.data,
      });
      if (decoded.functionName === 'approve') {
        const [spender, amount] = decoded.args as readonly [Address, bigint];
        out.push({
          phase,
          target: call.to,
          fn: 'approve',
          keyArg: `spender=${spender} amount=${amount.toString()}`,
        });
        return;
      }
    } catch {
      // unknown
    }
    out.push({
      phase,
      target: call.to,
      fn: 'unknown',
      keyArg: `data.selector=${call.data.slice(0, 10)}`,
    });
  };
  for (const c of input.phase1) decodeOne('phase1', c);
  for (const c of input.phase2) decodeOne('phase2', c);
  return out;
}

interface ParsedCollect {
  readonly amount0: bigint;
  readonly amount1: bigint;
}
function parseCollectEvent(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  expectedTokenId: bigint,
): ParsedCollect | null {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: NPM_ABI_VIEM,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'Collect') continue;
      const args = decoded.args as unknown as {
        tokenId: bigint;
        amount0: bigint;
        amount1: bigint;
      };
      if (args.tokenId !== expectedTokenId) continue;
      return { amount0: args.amount0, amount1: args.amount1 };
    } catch {
      continue;
    }
  }
  return null;
}

interface ParsedIncrease {
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly amount0: bigint;
  readonly amount1: bigint;
}
function parseIncreaseLiquidityEvent(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  excludeTokenId: bigint,
): ParsedIncrease | null {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: NPM_ABI_VIEM,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'IncreaseLiquidity') continue;
      const args = decoded.args as unknown as {
        tokenId: bigint;
        liquidity: bigint;
        amount0: bigint;
        amount1: bigint;
      };
      // The old tokenId ALSO emits IncreaseLiquidity(0) sometimes on burn
      // paths; skip that. We want the freshly-minted token.
      if (args.tokenId === excludeTokenId) continue;
      if (args.liquidity === 0n) continue;
      return {
        tokenId: args.tokenId,
        liquidity: args.liquidity,
        amount0: args.amount0,
        amount1: args.amount1,
      };
    } catch {
      continue;
    }
  }
  return null;
}

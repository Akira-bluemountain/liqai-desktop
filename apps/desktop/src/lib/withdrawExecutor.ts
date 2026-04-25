'use client';

/**
 * executeWithdraw — burns 100% of a Uniswap V3 LP position's liquidity
 * and collects the resulting USDC + WETH into the user's Smart Account.
 *
 * Sequence (batched into a single userOp so the user signs once):
 *   1. NPM.decreaseLiquidity({ tokenId, liquidity, amount*Min: 0, deadline })
 *   2. NPM.collect({ tokenId, recipient: SA, amount*Max: uint128.max })
 *
 * After inclusion:
 *   - Parse the Collect event for actual amounts received.
 *   - Mark the lp_positions row as `closed` with closed_at = now.
 *   - Append `lp_position_withdrawn` audit entry.
 *
 * SECURITY:
 *   - Only the user's own Kernel SA can call this — the SA is the NFT
 *     owner, and NPM enforces ownership.
 *   - amount*Min = 0 (no slippage protection) is acceptable here because
 *     the user is withdrawing their OWN deposited value. Worst-case MEV
 *     manipulation at the moment of inclusion skims a small amount; for
 *     MVP this is preferred over the complexity of live pool-state
 *     quoting with slippage. A future iteration adds a pre-flight quote.
 *   - WETH is NOT auto-unwrapped to ETH here — we leave it as ERC-20 in
 *     the SA. The user can unwrap + transfer to their EOA in a separate
 *     step. Unwrap-in-same-userOp is a nice UX improvement for later.
 */

import {
  decodeEventLog,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  UNISWAP_V3_ADDRESSES,
} from '@liqai/uniswap';
import { writeAudit, getDb } from './db';
import type { KernelClient } from './useKernelClient';

const MAINNET_ID = 1;
const NPM_ABI_VIEM = parseAbi(NONFUNGIBLE_POSITION_MANAGER_ABI);
const MAX_U128 = 2n ** 128n - 1n;
const WITHDRAW_DEADLINE_SEC = 300;

export interface WithdrawExecutionInput {
  readonly kernelClient: KernelClient;
  /** Read client used to fetch the NFT's actual on-chain liquidity. */
  readonly publicClient: PublicClient;
  readonly eoaAddress: Address;
  readonly smartAccountAddress: Address;
  readonly lpPositionDbId: number;
  readonly tokenId: bigint;
  /**
   * Liquidity amount recorded locally at mint time. We use this as a fallback
   * only; the actual on-chain liquidity is re-read inside this function so
   * stuck states (where a prior rebalance partially drained the NFT) are
   * handled correctly.
   */
  readonly liquidity: bigint;
}

export interface WithdrawExecutionResult {
  readonly userOpHash: Hex;
  readonly txHash: Hex;
  readonly amount0Collected: bigint;
  readonly amount1Collected: bigint;
}

export async function executeWithdraw(
  input: WithdrawExecutionInput,
): Promise<WithdrawExecutionResult> {
  const { nonfungiblePositionManager: NPM } = UNISWAP_V3_ADDRESSES[MAINNET_ID];
  const npmAddress = NPM as Address;
  const deadline = BigInt(
    Math.floor(Date.now() / 1000) + WITHDRAW_DEADLINE_SEC,
  );

  // Re-read on-chain liquidity rather than trusting the mint-time DB value.
  // Stuck-NFT case: a prior rebalance attempt decreased liquidity but its
  // mint phase failed, leaving the DB liquidity > 0 while on-chain it is 0.
  // Blindly calling decreaseLiquidity with the stale amount would revert.
  const onchainPos = (await input.publicClient.readContract({
    address: npmAddress,
    abi: NPM_ABI_VIEM,
    functionName: 'positions',
    args: [input.tokenId],
  })) as readonly unknown[];
  const onchainLiquidity = onchainPos[7] as bigint;
  const tokensOwed0 = onchainPos[10] as bigint;
  const tokensOwed1 = onchainPos[11] as bigint;

  // Nothing to do on-chain: the NFT is empty AND has no unclaimed fees. We
  // still close the local DB row so the UI stops showing a ghost entry.
  if (onchainLiquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) {
    const db = await getDb();
    const nowSec = Math.floor(Date.now() / 1000);
    await db.execute(
      `UPDATE lp_positions SET status = 'closed', closed_at = $1 WHERE id = $2`,
      [nowSec, input.lpPositionDbId],
    );
    // Soft-close: no on-chain action so tx_hash is genuinely absent. The
    // audit-log schema treats tx_hash as optional, so we simply omit it
    // rather than shoehorning a placeholder like '0x' which would fail the
    // TxHashSchema regex (must be 0x + 64 hex chars).
    await writeAudit({
      action: 'lp_position_withdrawn',
      actor_address: input.eoaAddress,
      chain_id: MAINNET_ID,
      target_address: npmAddress,
      description:
        `Soft-closed empty LP tokenId=${input.tokenId.toString()} (on-chain liquidity=0, no unclaimed fees). ` +
        `No userOp sent.`,
      metadata: {
        tokenId: input.tokenId.toString(),
        liquidityBurned: '0',
        softClose: true,
      },
    });
    return {
      userOpHash: '0x' as Hex,
      txHash: '0x' as Hex,
      amount0Collected: 0n,
      amount1Collected: 0n,
    };
  }

  // Build calls dynamically: decreaseLiquidity only when the NFT actually
  // has liquidity on-chain. collect always runs so any residual tokensOwed
  // are swept regardless.
  const calls: Array<{ to: Address; data: Hex; value: bigint }> = [];
  if (onchainLiquidity > 0n) {
    calls.push({
      to: npmAddress,
      data: encodeFunctionData({
        abi: NPM_ABI_VIEM,
        functionName: 'decreaseLiquidity',
        args: [
          {
            tokenId: input.tokenId,
            liquidity: onchainLiquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline,
          },
        ],
      }),
      value: 0n,
    });
  }
  calls.push({
    to: npmAddress,
    data: encodeFunctionData({
      abi: NPM_ABI_VIEM,
      functionName: 'collect',
      args: [
        {
          tokenId: input.tokenId,
          recipient: input.smartAccountAddress,
          amount0Max: MAX_U128,
          amount1Max: MAX_U128,
        },
      ],
    }),
    value: 0n,
  });

  const userOpHash = await input.kernelClient.sendUserOperation({ calls });
  const receipt = await input.kernelClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });
  if (!receipt.success) {
    throw new Error(
      `Withdraw userOp reverted on-chain (tx=${receipt.receipt.transactionHash})`,
    );
  }

  // Parse Collect event to discover the actual amounts returned.
  const parsed = parseCollectEvent(receipt.logs, input.tokenId);

  // Update DB: mark position as closed.
  const db = await getDb();
  const nowSec = Math.floor(Date.now() / 1000);
  await db.execute(
    `UPDATE lp_positions SET status = 'closed', closed_at = $1 WHERE id = $2`,
    [nowSec, input.lpPositionDbId],
  );

  await writeAudit({
    action: 'lp_position_withdrawn',
    actor_address: input.eoaAddress,
    chain_id: MAINNET_ID,
    target_address: npmAddress,
    tx_hash: receipt.receipt.transactionHash,
    description:
      `Withdrew LP tokenId=${input.tokenId.toString()} ` +
      `(on-chain liquidity=${onchainLiquidity.toString()}) — ` +
      (parsed
        ? `collected amount0=${parsed.amount0.toString()} amount1=${parsed.amount1.toString()}`
        : `Collect event not found in logs (see tx for actual amounts)`),
    metadata: {
      tokenId: input.tokenId.toString(),
      liquidityBurned: onchainLiquidity.toString(),
    },
  });

  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    amount0Collected: parsed?.amount0 ?? 0n,
    amount1Collected: parsed?.amount1 ?? 0n,
  };
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
        recipient: Address;
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

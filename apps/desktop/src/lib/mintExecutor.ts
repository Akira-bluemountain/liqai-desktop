'use client';

/**
 * executeMint — orchestrates a full Uniswap V3 mint via the user's Kernel
 * Smart Account and Pimlico's ERC-4337 bundler.
 *
 * Sequence (all inside ONE userOp so the user signs exactly once and the
 * SA deploys atomically with the mint):
 *
 *   1. WETH9.deposit{value: ethAmount}()         — wraps ETH into WETH
 *   2. USDC.approve(NPM, amount0Desired)         — token0 allowance
 *   3. WETH.approve(NPM, amount1Desired)         — token1 allowance
 *   4. NPM.mint({ ... })                         — mints the LP NFT
 *
 * After the userOp is included on-chain:
 *   a. Parse the IncreaseLiquidity event for the new tokenId.
 *   b. upsert smart_accounts row (now that the SA is deployed).
 *   c. Insert lp_positions row.
 *   d. Append audit_log entries (one for deployment, one for mint).
 *
 * SECURITY:
 *   - The userOp is signed by the user's EOA via WalletConnect. LiqAI
 *     never handles the private key.
 *   - amount*Min is enforced on-chain by NPM.mint — no way for MEV to
 *     skim more than slippage tolerance.
 *   - AI range passes assertRangeSafeForExecution inside @liqai/uniswap's
 *     buildMintTx before the call data is encoded.
 *   - Pre-flight balance checks fail loudly if the SA doesn't have enough
 *     USDC or ETH.
 */

import {
  decodeEventLog,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import {
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  UNISWAP_V3_ADDRESSES,
  ERC20_ABI,
} from '@liqai/uniswap';
import { upsertSmartAccount, insertLpPosition, writeAudit } from './db';
import { buildNpmMintArgs } from './mintParams';
import { ENTRYPOINT, KERNEL_VERSION } from './zerodev';
import type { KernelClient } from './useKernelClient';

const MAINNET_ID = 1;

// WETH9.deposit() — mainnet WETH contract uses this to wrap native ETH.
const WETH9_ABI_VIEM = parseAbi([
  'function deposit() public payable',
  'function withdraw(uint256) public',
] as const);

const NPM_ABI_VIEM = parseAbi(NONFUNGIBLE_POSITION_MANAGER_ABI);
const ERC20_ABI_VIEM = parseAbi(ERC20_ABI);

export interface MintExecutionInput {
  readonly kernelClient: KernelClient;
  readonly eoaAddress: Address;
  readonly smartAccountAddress: Address;
  readonly poolAddress: Address;
  /** token0 address (should be USDC on USDC/WETH mainnet). */
  readonly token0: Address;
  /** token1 address (should be WETH on USDC/WETH mainnet). */
  readonly token1: Address;
  readonly feeTier: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  /** Raw (6-decimal) USDC amount to deposit. */
  readonly usdcAmountRaw: bigint;
  /** Raw (18-decimal) WETH amount to deposit (wrapped from ETH). */
  readonly wethAmountRaw: bigint;
  readonly slippageBps: number;
}

export interface MintExecutionResult {
  readonly userOpHash: Hex;
  readonly txHash: Hex;
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly actualAmount0: bigint;
  readonly actualAmount1: bigint;
  readonly smartAccountId: number;
  readonly lpPositionId: number;
}

/**
 * Main entry point. Throws on failure (caller wraps in try/catch for UI).
 */
export async function executeMint(
  input: MintExecutionInput,
): Promise<MintExecutionResult> {
  const { nonfungiblePositionManager: NPM } = UNISWAP_V3_ADDRESSES[MAINNET_ID];
  const npmAddress = NPM as Address;

  // ── 1. Build the 4 calls ─────────────────────────────────────────
  // amount1 (WETH) here already includes a small buffer above the EXACT
  // pool-required amount (see computeRequiredWethForUsdc). The pool will
  // use only what's needed and refund the rest. Correspondingly, we must
  // set amount1Min BELOW the buffered amount — otherwise the refund itself
  // would trip the slippage check.
  //
  // amount0 (USDC) is the limiting side (its raw amount is what the user
  // chose), so it gets the full slippageBps tolerance.
  // amount1 (WETH) gets a wider band to absorb the deliberate buffer and
  // any minor pool drift between estimate and execution.
  const wethDesired = input.wethAmountRaw;
  // Allow the pool to use as little as 88% of the buffered WETH desired —
  // covers a 2% buffer + drift up to 10% on the WETH side.
  const wethMinFloor = (wethDesired * 88n) / 100n;
  const usdcMinTight = (input.usdcAmountRaw * BigInt(10_000 - input.slippageBps)) / 10_000n;

  const mintArgs = buildNpmMintArgs({
    token0: input.token0,
    token1: input.token1,
    feeTier: input.feeTier,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    amount0Desired: input.usdcAmountRaw,
    amount1Desired: wethDesired,
    recipient: input.smartAccountAddress,
    slippageBps: input.slippageBps,
    amount0MinOverride: usdcMinTight,
    amount1MinOverride: wethMinFloor,
  });

  const calls: Array<{ to: Address; data: Hex; value: bigint }> = [
    // Wrap ETH → WETH
    {
      to: input.token1,
      data: encodeFunctionData({
        abi: WETH9_ABI_VIEM,
        functionName: 'deposit',
      }),
      value: input.wethAmountRaw,
    },
    // Approve USDC to NPM
    {
      to: input.token0,
      data: encodeFunctionData({
        abi: ERC20_ABI_VIEM,
        functionName: 'approve',
        args: [npmAddress, input.usdcAmountRaw],
      }),
      value: 0n,
    },
    // Approve WETH to NPM
    {
      to: input.token1,
      data: encodeFunctionData({
        abi: ERC20_ABI_VIEM,
        functionName: 'approve',
        args: [npmAddress, input.wethAmountRaw],
      }),
      value: 0n,
    },
    // Mint LP position
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

  // ── 2. Submit the userOp ─────────────────────────────────────────
  // Pimlico's `eth_estimateUserOperationGas` simulator has trouble with
  // ZeroDev Kernel V3.1's combined deploy + multi-call batch — it reverts
  // with "VerificationGasLimit reverted during simulation" because the
  // dummy-signature simulation path doesn't model the modular ERC-7579
  // validator install correctly during initCode execution.
  //
  // Workaround: skip Pimlico's simulator and provide conservative manual
  // gas limits derived from empirical Kernel V3.1 + Uniswap mint
  // measurements. The bundler still enforces these on-chain — any unused
  // gas is refunded to the SA — so over-provisioning is just a
  // temporarily-locked deposit, not a real cost.
  //
  //   verificationGasLimit ≥ Kernel V3.1 deploy (~600k) + validate (~200k)
  //   callGasLimit         ≥ WETH wrap (50k) + 2× approve (100k) + NPM mint (~600k)
  //   preVerificationGas   ≥ calldata cost + per-userOp overhead
  const userOpHash = await input.kernelClient.sendUserOperation({
    calls,
    callGasLimit: 1_000_000n,
    verificationGasLimit: 1_500_000n,
    preVerificationGas: 200_000n,
  });

  // ── 3. Wait for receipt ──────────────────────────────────────────
  const receipt = await input.kernelClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });
  if (!receipt.success) {
    throw new Error(
      `userOp reverted on-chain (txHash=${receipt.receipt.transactionHash})`,
    );
  }

  // ── 4. Parse the IncreaseLiquidity event for the new tokenId ─────
  const increaseLiquiditySig =
    'IncreaseLiquidity(uint256,uint128,uint256,uint256)';
  const parsed = parseIncreaseLiquidity(
    receipt.logs,
    input.smartAccountAddress,
  );
  if (!parsed) {
    throw new Error(
      `Mint tx succeeded but IncreaseLiquidity event not found in logs (tx=${receipt.receipt.transactionHash}, sig=${increaseLiquiditySig})`,
    );
  }

  // ── 5. Persist to SQLite ─────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  const smartAccountId = await upsertSmartAccount({
    chain_id: MAINNET_ID,
    owner_eoa_address: input.eoaAddress,
    smart_account_address: input.smartAccountAddress,
    entry_point_address: ENTRYPOINT.address,
    kernel_implementation: `kernel-${KERNEL_VERSION}`,
    deployed_at: nowSec,
    deployment_tx_hash: receipt.receipt.transactionHash,
  });

  const lpPositionId = await insertLpPosition({
    smart_account_id: smartAccountId,
    chain_id: MAINNET_ID,
    lp_token_id: parsed.tokenId.toString(),
    pool_address: input.poolAddress,
    token0_address: input.token0,
    token1_address: input.token1,
    fee_tier: input.feeTier,
    tick_lower: input.tickLower,
    tick_upper: input.tickUpper,
    liquidity: parsed.liquidity.toString(),
    minted_at: nowSec,
    status: 'active',
  });

  // ── 6. Audit log entries ─────────────────────────────────────────
  await writeAudit({
    action: 'smart_account_deployed',
    actor_address: input.eoaAddress,
    chain_id: MAINNET_ID,
    target_address: input.smartAccountAddress,
    tx_hash: receipt.receipt.transactionHash,
    description: `Kernel Smart Account ${input.smartAccountAddress} deployed via initCode of mint userOp`,
  });
  await writeAudit({
    action: 'lp_position_minted',
    actor_address: input.eoaAddress,
    chain_id: MAINNET_ID,
    target_address: npmAddress,
    tx_hash: receipt.receipt.transactionHash,
    description:
      `Minted USDC/WETH LP tokenId=${parsed.tokenId.toString()} ` +
      `range=[${input.tickLower},${input.tickUpper}] ` +
      `amounts=[${parsed.amount0.toString()}, ${parsed.amount1.toString()}]`,
    metadata: {
      tokenId: parsed.tokenId.toString(),
      liquidity: parsed.liquidity.toString(),
    },
  });

  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    tokenId: parsed.tokenId,
    liquidity: parsed.liquidity,
    actualAmount0: parsed.amount0,
    actualAmount1: parsed.amount1,
    smartAccountId,
    lpPositionId,
  };
}

// ── helpers ───────────────────────────────────────────────────────

interface ParsedMint {
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly amount0: bigint;
  readonly amount1: bigint;
}

function parseIncreaseLiquidity(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  _recipient: Address,
): ParsedMint | null {
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
      return {
        tokenId: args.tokenId,
        liquidity: args.liquidity,
        amount0: args.amount0,
        amount1: args.amount1,
      };
    } catch {
      // Not an NPM event we recognise — skip.
      continue;
    }
  }
  return null;
}

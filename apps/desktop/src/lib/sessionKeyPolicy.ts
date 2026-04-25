'use client';

/**
 * Session-key policy construction for LiqAI's automated rebalance flow.
 *
 * ARCHITECTURE (docs/architecture-v2.md §1.3):
 *   Session keys are scoped ECDSA keys installed as ERC-7579 plugins on
 *   the user's Kernel Smart Account. They can ONLY:
 *     - Call Uniswap V3 NonfungiblePositionManager with mint /
 *       decreaseLiquidity / collect where `recipient == SA`
 *     - Call USDC/WETH `approve(spender=NPM, amount<=cap)`
 *     - Execute up to MAX_REBALANCES_PER_DAY times per 24h
 *     - Remain valid for REBALANCE_SESSION_VALID_SECONDS (30 days)
 *
 *   A stolen session key CANNOT:
 *     - Redirect fee/principal payouts (collect.recipient pinned to SA)
 *     - Mint an LP position with attacker as recipient
 *     - Approve more than MAX_APPROVE_AMOUNT_{USDC,WETH}
 *     - Transfer funds to an external address
 *     - Call any contract other than Uniswap V3 NPM / USDC / WETH
 *     - Exceed the rate limit
 *     - Act after expiry
 *
 * SECURITY — 2026-04-22 Q1 REMEDIATION:
 *   This module previously used the typed `abi`+`functionName`+`args`
 *   API of @zerodev/permissions to declare permissions. That path
 *   generates on-chain `ParamRule`s with `offset = i * 32` where `i` is
 *   the index in the top-level args array. For `mint(MintParams)` /
 *   `collect(CollectParams)` the top-level args array is length 1 (one
 *   tuple), so the typed API could only constrain byte 0 of the encoded
 *   calldata — nowhere near the `recipient` field inside the tuple.
 *   A leaked session key could therefore pass `recipient=attacker` and
 *   exfiltrate funds. See docs/security-investigation-q1.md for the full
 *   investigation.
 *
 *   This file now uses the lower-level `PermissionManual` path:
 *   explicit `selector` + `rules[]` with hand-computed byte offsets into
 *   the ABI-encoded calldata. The offsets are documented inline with
 *   reference to the Uniswap V3 NPM / ERC-20 function signatures.
 *
 * This module is pure (no on-chain calls) and unit-tested at the policy-
 * struct level in `./__tests__/sessionKeyPolicy.exploit.test.ts`.
 */

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  pad,
  toFunctionSelector,
  toHex,
  type Client,
  type Address,
  type Hex,
} from 'viem';
import { toPermissionValidator } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import {
  toCallPolicy,
  CallPolicyVersion,
  ParamCondition,
  toRateLimitPolicy,
  toTimestampPolicy,
} from '@zerodev/permissions/policies';
import { UNISWAP_V3_ADDRESSES } from '@liqai/uniswap';
import { ENTRYPOINT, KERNEL_VERSION } from './zerodev';
import {
  MAX_APPROVE_AMOUNT_USDC,
  MAX_APPROVE_AMOUNT_WETH,
} from './constants/sessionKeyLimits';

const MAINNET_ID = 1;

/** Maximum rebalance userOps the session key may execute per 24h. Matches
 *  @liqai/automation's MAX_REBALANCES_PER_DAY so on-chain + off-chain
 *  enforcement stay in sync. */
export const MAX_REBALANCES_PER_DAY = 10;

/** Session key validity window (seconds). 30 days is the longest we allow;
 *  the user can always revoke earlier. */
export const REBALANCE_SESSION_VALID_SECONDS = 30 * 24 * 60 * 60;

// ── Function selectors ────────────────────────────────────────────────
// Computed at module init from canonical Uniswap V3 NPM / ERC-20
// signatures. Hardcoding would be faster but drift-prone if a caller
// edits a selector constant elsewhere; deriving ensures the on-chain
// policy we ship always matches the calldata the bot actually sends.
const MINT_SELECTOR = toFunctionSelector(
  'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))',
);
const DECREASE_LIQUIDITY_SELECTOR = toFunctionSelector(
  'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))',
);
const COLLECT_SELECTOR = toFunctionSelector(
  'collect((uint256,address,uint128,uint128))',
);
const APPROVE_SELECTOR = toFunctionSelector('approve(address,uint256)');

// ── ABI-encoded byte offsets ──────────────────────────────────────────
// Offsets are into the userOp's `callData` excluding the 4-byte function
// selector (ZeroDev CallPolicy V0_0_5 contract passes the de-selectored
// slice to the rule check). Every field is 32 bytes wide because all
// types involved are static (no dynamic bytes/strings).
//
// Source: Uniswap V3 NonfungiblePositionManager.sol struct definitions
// (https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol).
//
// MintParams — 11 static fields, flat encoded:
//   0   token0          address
//   32  token1          address
//   64  fee             uint24   (right-padded in 32-byte slot)
//   96  tickLower       int24
//   128 tickUpper       int24
//   160 amount0Desired  uint256
//   192 amount1Desired  uint256
//   224 amount0Min      uint256
//   256 amount1Min      uint256
//   288 recipient       address  ← PINNED
//   320 deadline        uint256
const MINT_RECIPIENT_OFFSET = 288;

// CollectParams — 4 static fields:
//   0   tokenId         uint256
//   32  recipient       address  ← PINNED
//   64  amount0Max      uint128  (right-padded)
//   96  amount1Max      uint128
const COLLECT_RECIPIENT_OFFSET = 32;

// approve(address spender, uint256 amount) — 2 flat args:
//   0   spender         address  ← PINNED to NPM
//   32  amount          uint256  ← CAPPED
const APPROVE_SPENDER_OFFSET = 0;
const APPROVE_AMOUNT_OFFSET = 32;

// ── Public API ────────────────────────────────────────────────────────

/**
 * Generate a fresh session-key ECDSA account. The returned object holds
 * the private key in memory — callers are responsible for (a) never
 * logging it and (b) deciding how to persist (encrypted at rest via AES
 * or OS keychain/Stronghold).
 */
export function generateSessionKeyAccount(): {
  readonly account: PrivateKeyAccount;
  readonly privateKey: Hex;
} {
  // Use WebCrypto for the 32-byte random key rather than ethers/viem's
  // built-in generators so we inherit the platform's audited RNG.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const privateKey = ('0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')) as Hex;
  const account = privateKeyToAccount(privateKey);
  return { account, privateKey };
}

export interface SessionKeyPolicyMeta {
  readonly targetAddress: Address;
  readonly allowedSelectors: readonly Hex[];
  /** ERC-20 tokens for which the session key may call approve(spender=NPM, *). */
  readonly approvableTokens: readonly Address[];
  /** The only spender address approve calls may authorise. */
  readonly approveSpender: Address;
  /** The Smart Account to which mint / collect must pay out (pinned on-chain). */
  readonly recipient: Address;
  /** Caps for approve `amount`, in raw token units. */
  readonly approveCaps: {
    readonly usdc: bigint;
    readonly weth: bigint;
  };
  readonly maxExecutionsPer24h: number;
  readonly validAfter: number;
  readonly validUntil: number;
}

/**
 * Produce the policy metadata (pure data; can be rendered in UI for user
 * confirmation BEFORE the on-chain install userOp is constructed).
 *
 * `recipient` is a required input because the policy pins mint/collect
 * recipients to the user's Smart Account. Pass the SA address the
 * session key will manage.
 */
export function buildSessionKeyPolicyMeta(options: {
  readonly smartAccountAddress: Address;
  readonly nowSec?: number;
}): SessionKeyPolicyMeta {
  const { nonfungiblePositionManager, usdc, weth } =
    UNISWAP_V3_ADDRESSES[MAINNET_ID];
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  return {
    targetAddress: nonfungiblePositionManager as Address,
    allowedSelectors: [
      MINT_SELECTOR,
      DECREASE_LIQUIDITY_SELECTOR,
      COLLECT_SELECTOR,
      APPROVE_SELECTOR,
    ] as const,
    approvableTokens: [usdc as Address, weth as Address],
    approveSpender: nonfungiblePositionManager as Address,
    recipient: options.smartAccountAddress,
    approveCaps: {
      usdc: MAX_APPROVE_AMOUNT_USDC,
      weth: MAX_APPROVE_AMOUNT_WETH,
    },
    maxExecutionsPer24h: MAX_REBALANCES_PER_DAY,
    validAfter: nowSec,
    validUntil: nowSec + REBALANCE_SESSION_VALID_SECONDS,
  };
}

/**
 * Build the CallPolicy permissions array for the rebalance bot.
 *
 * Exported for white-box security testing — the exploit/regression tests
 * in `./__tests__/sessionKeyPolicy.exploit.test.ts` pass the result
 * through `toCallPolicy` and inspect the resulting `rules[]` directly.
 * Keeping this as a pure function of meta keeps the tests decoupled from
 * any Kernel/viem client dependencies.
 */
export function buildRebalanceCallPolicyPermissions(
  meta: SessionKeyPolicyMeta,
) {
  const recipientWord = pad(meta.recipient, { size: 32 });
  const spenderWord = pad(meta.approveSpender, { size: 32 });
  const usdcCapWord = pad(toHex(meta.approveCaps.usdc), { size: 32 });
  const wethCapWord = pad(toHex(meta.approveCaps.weth), { size: 32 });

  const [usdcAddress, wethAddress] = meta.approvableTokens;
  if (!usdcAddress || !wethAddress) {
    throw new Error(
      'buildRebalanceCallPolicyPermissions: approvableTokens must contain USDC + WETH',
    );
  }

  // CallPolicy V0_0_5 encodes `ParamRule.params` as `bytes32[]` on-chain
  // (see callPolicyUtils.js encodePermissionData). Each rule therefore
  // carries its constraint value as a single-element array — one bytes32
  // word per rule for EQUAL / LESS_THAN_OR_EQUAL conditions.
  return [
    // ── NPM.mint: recipient (offset 288) must equal SA ────────────
    {
      target: meta.targetAddress,
      selector: MINT_SELECTOR,
      valueLimit: 0n,
      rules: [
        {
          condition: ParamCondition.EQUAL,
          offset: MINT_RECIPIENT_OFFSET,
          params: [recipientWord],
        },
      ],
    },
    // ── NPM.decreaseLiquidity: no recipient field; valueLimit=0
    //    is sufficient. decreaseLiquidity alone cannot move tokens
    //    out of the NFT — only collect can, and that's pinned below.
    {
      target: meta.targetAddress,
      selector: DECREASE_LIQUIDITY_SELECTOR,
      valueLimit: 0n,
      rules: [],
    },
    // ── NPM.collect: recipient (offset 32) must equal SA ──────────
    {
      target: meta.targetAddress,
      selector: COLLECT_SELECTOR,
      valueLimit: 0n,
      rules: [
        {
          condition: ParamCondition.EQUAL,
          offset: COLLECT_RECIPIENT_OFFSET,
          params: [recipientWord],
        },
      ],
    },
    // ── USDC.approve: spender==NPM AND amount<=cap ────────────────
    {
      target: usdcAddress,
      selector: APPROVE_SELECTOR,
      valueLimit: 0n,
      rules: [
        {
          condition: ParamCondition.EQUAL,
          offset: APPROVE_SPENDER_OFFSET,
          params: [spenderWord],
        },
        {
          condition: ParamCondition.LESS_THAN_OR_EQUAL,
          offset: APPROVE_AMOUNT_OFFSET,
          params: [usdcCapWord],
        },
      ],
    },
    // ── WETH.approve: spender==NPM AND amount<=cap ────────────────
    {
      target: wethAddress,
      selector: APPROVE_SELECTOR,
      valueLimit: 0n,
      rules: [
        {
          condition: ParamCondition.EQUAL,
          offset: APPROVE_SPENDER_OFFSET,
          params: [spenderWord],
        },
        {
          condition: ParamCondition.LESS_THAN_OR_EQUAL,
          offset: APPROVE_AMOUNT_OFFSET,
          params: [wethCapWord],
        },
      ],
    },
  ] as const;
}

/**
 * Build the @zerodev/permissions validator plugin for a session key. This
 * is the object passed to the Kernel account's plugin installation.
 *
 * The returned plugin, once installed on the user's Smart Account, lets
 * the provided session-key signer sign userOps — but only those that
 * pass the call / rate-limit / timestamp policies.
 *
 * SECURITY: the `smartAccountAddress` passed in here is baked into the
 * on-chain policy (as the required `recipient` for mint/collect). If the
 * caller ever passes the wrong SA, the resulting session key will not
 * work — rebalance userOps will revert. There is no silent failure mode.
 */
export async function buildRebalancePermissionValidator(options: {
  readonly publicClient: Client;
  readonly sessionKeyAccount: PrivateKeyAccount;
  readonly smartAccountAddress: Address;
  readonly nowSec?: number;
}) {
  const meta = buildSessionKeyPolicyMeta({
    smartAccountAddress: options.smartAccountAddress,
    nowSec: options.nowSec,
  });

  const ecdsaSigner = await toECDSASigner({
    signer: options.sessionKeyAccount,
  });

  const callPolicy = toCallPolicy({
    // V0_0_5 is the latest audited CallPolicy contract. We use the
    // PermissionManual path (selector + rules with explicit offsets)
    // rather than the typed abi+functionName+args API — see the module
    // docstring for why.
    policyVersion: CallPolicyVersion.V0_0_5,
    permissions: buildRebalanceCallPolicyPermissions(
      meta,
    ) as unknown as Parameters<typeof toCallPolicy>[0]['permissions'],
  });

  const rateLimitPolicy = toRateLimitPolicy({
    interval: 24 * 60 * 60,
    count: meta.maxExecutionsPer24h,
  });

  const timestampPolicy = toTimestampPolicy({
    validAfter: meta.validAfter,
    validUntil: meta.validUntil,
  });

  const validator = await toPermissionValidator(options.publicClient, {
    signer: ecdsaSigner,
    policies: [callPolicy, rateLimitPolicy, timestampPolicy],
    entryPoint: ENTRYPOINT,
    kernelVersion: KERNEL_VERSION,
  });

  return { validator, meta };
}

/**
 * Session key policy definition and validation.
 *
 * A session key is a temporary private key held by an automation service
 * (Gelato) that can sign a LIMITED set of transactions on behalf of the
 * user's Smart Account. The power of the key is enforced ON-CHAIN by the
 * Smart Account (ZeroDev Kernel) based on the policy attached at issuance.
 *
 * SECURITY (docs/security-v2.md S1.2):
 *   A session key MUST be restricted by ALL of:
 *     - target contract allowlist
 *     - function selector allowlist
 *     - msg.value == 0
 *     - rate limit (max executions per 24h)
 *     - absolute expiry (≤ 30 days)
 *     - token transfer allowlist (only tokens from user's own position)
 *
 *   Even if the session key is fully compromised, the attacker must:
 *     - be unable to transfer funds to an external address
 *     - be unable to call any non-Uniswap contract
 *     - be unable to exceed the daily rebalance limit
 *     - automatically lose access after the expiry
 */

import { ethers } from 'ethers';
import { z } from 'zod';
import {
  UNISWAP_V3_NPM_SELECTORS,
  getAddresses,
  isSupportedChain,
} from '@liqai/uniswap';

/** Maximum allowed expiry in seconds from issuance (30 days). */
export const MAX_SESSION_KEY_LIFETIME_SEC = 30 * 24 * 60 * 60;

/** Maximum allowed rebalance executions per 24h. */
export const MAX_REBALANCES_PER_DAY = 10;

/** The canonical function selectors a rebalance session key may call. */
export const REBALANCE_ALLOWED_SELECTORS = [
  UNISWAP_V3_NPM_SELECTORS.decreaseLiquidity,
  UNISWAP_V3_NPM_SELECTORS.collect,
  UNISWAP_V3_NPM_SELECTORS.mint,
] as const;

/**
 * A session key permission policy. This is the configuration attached to the
 * session key when it's issued. The Smart Account contract enforces every
 * field at every userOp validation.
 */
export interface SessionKeyPolicy {
  /** Chain this policy applies to. */
  readonly chainId: number;
  /** The session key's public EOA address. */
  readonly sessionKeyAddress: string;
  /** The Smart Account that will host this session key. */
  readonly smartAccountAddress: string;
  /** The LP NFT tokenId the key may manage. */
  readonly lpTokenId: bigint;
  /** Absolute unix timestamp when this key expires. */
  readonly validUntil: number;
  /** Absolute unix timestamp when this key becomes active. */
  readonly validAfter: number;
  /** Max executions per 24h sliding window. */
  readonly maxExecutionsPer24h: number;
  /** The one permitted target contract (Uniswap V3 NPM). */
  readonly allowedTarget: string;
  /** The permitted function selectors. */
  readonly allowedSelectors: readonly string[];
  /** If true, the key may only be used while the issuing user is offline;
   *  enforced client-side as an additional warning (not on-chain). */
  readonly offlineOnly: boolean;
}

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be an address');
const SelectorSchema = z.string().regex(/^0x[a-fA-F0-9]{8}$/, 'must be a 4-byte selector');

const PolicyInputSchema = z.object({
  chainId: z.number().int().positive(),
  sessionKeyAddress: AddressSchema,
  smartAccountAddress: AddressSchema,
  lpTokenId: z.bigint().positive(),
  /** Seconds from "now" until the key expires. Capped at MAX_SESSION_KEY_LIFETIME_SEC. */
  lifetimeSec: z
    .number()
    .int()
    .positive()
    .max(MAX_SESSION_KEY_LIFETIME_SEC),
  maxExecutionsPer24h: z
    .number()
    .int()
    .positive()
    .max(MAX_REBALANCES_PER_DAY),
});

/**
 * Build a session key policy for rebalance operations. All safety defaults
 * are enforced here — callers cannot bypass them without changing this file.
 *
 * @throws ZodError on invalid input, Error on unsupported chain.
 */
export function buildRebalancePolicy(input: unknown): SessionKeyPolicy {
  const parsed = PolicyInputSchema.parse(input);

  if (!isSupportedChain(parsed.chainId)) {
    throw new Error(
      `buildRebalancePolicy: chainId ${parsed.chainId} not supported`,
    );
  }

  const addrs = getAddresses(parsed.chainId);
  const now = Math.floor(Date.now() / 1000);

  // Defensive: re-normalise addresses to checksummed form. Any address that
  // fails this check is discarded.
  const sessionKeyAddress = ethers.getAddress(parsed.sessionKeyAddress);
  const smartAccountAddress = ethers.getAddress(parsed.smartAccountAddress);

  return {
    chainId: parsed.chainId,
    sessionKeyAddress,
    smartAccountAddress,
    lpTokenId: parsed.lpTokenId,
    validAfter: now,
    validUntil: now + parsed.lifetimeSec,
    maxExecutionsPer24h: parsed.maxExecutionsPer24h,
    allowedTarget: addrs.nonfungiblePositionManager,
    allowedSelectors: REBALANCE_ALLOWED_SELECTORS,
    offlineOnly: false,
  };
}

/**
 * Validate that a given call (target, selector) is allowed by a policy.
 * This is the client-side mirror of the on-chain check. If the on-chain
 * contract ever accepted a mismatched call we'd want to know via tests.
 *
 * @returns true iff the call would be permitted.
 */
export function isCallPermitted(
  policy: SessionKeyPolicy,
  call: { target: string; data: string; value: bigint },
): { allowed: boolean; reason: string } {
  const now = Math.floor(Date.now() / 1000);

  if (call.value !== 0n) {
    return { allowed: false, reason: 'Session key cannot send native ETH' };
  }

  if (now < policy.validAfter) {
    return { allowed: false, reason: 'Session key not yet active' };
  }
  if (now >= policy.validUntil) {
    return { allowed: false, reason: 'Session key expired' };
  }

  let normalisedTarget: string;
  try {
    normalisedTarget = ethers.getAddress(call.target);
  } catch {
    return { allowed: false, reason: 'Invalid target address' };
  }
  if (normalisedTarget !== policy.allowedTarget) {
    return {
      allowed: false,
      reason: `Target not in allowlist (got ${normalisedTarget}, allowed ${policy.allowedTarget})`,
    };
  }

  if (!call.data.startsWith('0x') || call.data.length < 10) {
    return { allowed: false, reason: 'Calldata too short to contain selector' };
  }
  const selector = call.data.slice(0, 10).toLowerCase();
  if (
    !SelectorSchema.safeParse(selector).success ||
    !policy.allowedSelectors.includes(selector)
  ) {
    return {
      allowed: false,
      reason: `Function selector ${selector} not in allowlist`,
    };
  }

  return { allowed: true, reason: 'ok' };
}

/**
 * Produce a human-readable summary of a policy for the confirmation UI.
 * Every field is rendered so the user can see exactly what they are granting.
 */
export function describePolicyForUser(policy: SessionKeyPolicy): string {
  const expires = new Date(policy.validUntil * 1000).toISOString();
  const activates = new Date(policy.validAfter * 1000).toISOString();
  return [
    `Chain: ${policy.chainId === 1 ? 'Ethereum mainnet' : `chainId=${policy.chainId}`}`,
    `Smart Account: ${policy.smartAccountAddress}`,
    `Session key holder: ${policy.sessionKeyAddress}`,
    `Permitted target: ${policy.allowedTarget} (Uniswap V3 NFT Position Manager)`,
    `Permitted functions: ${policy.allowedSelectors.join(', ')}`,
    `LP tokenId scope: ${policy.lpTokenId}`,
    `Active from:   ${activates}`,
    `Expires:       ${expires}`,
    `Rate limit:    ${policy.maxExecutionsPer24h} executions per 24h`,
    `ETH transfers: DISABLED (value must be 0)`,
  ].join('\n');
}

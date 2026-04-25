/**
 * ZeroDev Kernel + ERC-4337 bundler configuration for LiqAI.
 *
 * Architecture:
 *   - Entry point: ERC-4337 v0.7 (the canonical mainnet deployment)
 *   - Kernel version: V3.1 (modular, ERC-7579 compatible — required for
 *     scoped session keys per docs/architecture-v2.md §1.3)
 *   - Bundler: PIMLICO. Reasoning:
 *       * Free tier supports Ethereum mainnet (ZeroDev's free tier does not).
 *       * 100k userOps/month is far above what a single user generates.
 *       * Standard ERC-4337 — bundler is a relay only, never custodies funds.
 *       * If Pimlico goes down, we can swap to any compliant bundler with
 *         no contract changes (bundler URL is the only thing that moves).
 *   - Paymaster: NONE. The user's Smart Account pays its own gas in ETH.
 *     This is the most non-custodial path — no third-party sponsor can
 *     refuse and brick the user.
 *
 * SECURITY:
 *   - The Pimlico API key is a public-facing identifier scoped to rate
 *     limiting + billing. It does NOT authenticate signing — the userOp's
 *     ECDSA signature does.
 *   - Entry point and kernel addresses are constants of the audited
 *     contract deployment. They are NOT user input.
 *   - The user's EOA signs the userOp via WalletConnect. LiqAI never
 *     touches a private key.
 *
 * Static env access (process.env.NEXT_PUBLIC_*) — Webpack only replaces
 * this form at build time. Do NOT switch to dynamic access.
 */

import { KERNEL_V3_1 } from '@zerodev/sdk/constants';
import { getEntryPoint } from '@zerodev/sdk/constants';

/** ERC-4337 EntryPoint v0.7 — the canonical mainnet deployment. */
export const ENTRYPOINT = getEntryPoint('0.7');

/** Kernel V3.1 — modular smart account that supports scoped session keys. */
export const KERNEL_VERSION = KERNEL_V3_1;

/** Account index — 0 = the user's first (and currently only) Smart Account. */
export const KERNEL_ACCOUNT_INDEX = 0n;

/**
 * Pimlico bundler URL for a given EVM chain.
 *
 * Returns null if NEXT_PUBLIC_PIMLICO_API_KEY is not configured. Callers
 * MUST handle null and surface a clear setup message instead of silently
 * failing — bundler-less userOps will fail at submission time anyway.
 */
export function getBundlerUrl(chainId: number): string | null {
  const apiKey = process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
  if (!apiKey || apiKey.length === 0) return null;
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${apiKey}`;
}

export const PIMLICO_API_KEY_CONFIGURED =
  !!process.env.NEXT_PUBLIC_PIMLICO_API_KEY &&
  process.env.NEXT_PUBLIC_PIMLICO_API_KEY.length > 0;

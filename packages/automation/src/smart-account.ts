/**
 * Smart Account (ERC-4337 / ZeroDev Kernel) interface definitions.
 *
 * The actual Kernel SDK integration happens at the Tauri app layer because
 * it needs wallet connectivity. This module provides the pure types and
 * helpers used everywhere.
 *
 * SECURITY:
 *   - No private keys are ever passed to or stored by this module.
 *   - All signing happens via the user's wallet (for the account itself) or
 *     via the scoped session key (for automated rebalances).
 */

import { ethers } from 'ethers';

/**
 * A reference to a user's deployed Smart Account.
 * The user's EOA is the owner that bootstrapped the account.
 */
export interface SmartAccount {
  readonly chainId: number;
  readonly ownerEoaAddress: string;
  readonly smartAccountAddress: string;
  readonly entryPointAddress: string;
  readonly deployedAt: number;
  readonly kernelImplementation: string;
}

/**
 * Opaque interface to be implemented at the app layer using the ZeroDev SDK.
 * Defined here so that pure logic can depend on it without pulling in the SDK.
 */
export interface SmartAccountClient {
  /** Returns the deployed Smart Account for the current EOA, deploying it
   *  on the first call. */
  ensureDeployed(): Promise<SmartAccount>;

  /**
   * Attach a scoped session key module to the Smart Account.
   * This is the operation that actually grants the limited key its power.
   *
   * Returns the transaction hash of the on-chain grant.
   */
  installSessionKey(options: {
    readonly sessionKeyAddress: string;
    readonly allowedTarget: string;
    readonly allowedSelectors: readonly string[];
    readonly validAfter: number;
    readonly validUntil: number;
    readonly maxExecutionsPer24h: number;
  }): Promise<string>;

  /** Revoke a previously-installed session key. Irreversible. */
  revokeSessionKey(sessionKeyAddress: string): Promise<string>;

  /** Execute a userOp via the Smart Account (user-signed path). */
  executeUserOp(options: {
    readonly to: string;
    readonly data: string;
    readonly value: bigint;
  }): Promise<string>;
}

/**
 * Derive a deterministic session key EOA from a user-provided seed material
 * that the app stores encrypted at rest. This is used only for session keys,
 * NEVER for the Smart Account owner.
 *
 * NOTE: Randomness source MUST be a crypto-secure RNG. For the in-tree
 * implementation we use ethers.Wallet.createRandom which uses crypto.randomBytes.
 */
export function generateSessionKey(): {
  readonly address: string;
  readonly privateKey: string;
} {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

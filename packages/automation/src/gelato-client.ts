/**
 * Gelato Automate client.
 *
 * Registers a 24/7 automated task with Gelato that:
 *   1. Polls an off-chain resolver (our local AI) for "should rebalance?" signal
 *   2. If yes, executes a pre-signed userOp via the session key on the
 *      user's Smart Account
 *
 * NOTE: This is a thin client interface. The actual Gelato SDK integration
 * is performed at the application layer (Tauri app) using the user's wallet.
 * This module only provides the types and pure payload builders.
 *
 * SECURITY:
 *   - No private keys are ever passed to or stored by this module.
 *   - The task payload is fully reproducible from the (policy, tokenId)
 *     pair; any tampering is visible to the user in the audit log.
 */

import { ethers } from 'ethers';
import { z } from 'zod';
import type { SessionKeyPolicy } from './session-key-policy.js';

/** Gelato canonical contract addresses per chain. Reference: https://docs.gelato.network */
export const GELATO_AUTOMATE_ADDRESSES = {
  1: '0x2A6C106ae13B558BB9E2Ec64Bd2f1f7BEFF3A5E0', // mainnet (example — verify at integration time)
} as const;

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be an address');

/** A description of the off-chain condition resolver. */
export interface ResolverConfig {
  /** URL of an HTTPS endpoint that returns {shouldExecute: boolean, execPayload?: string}.
   *  Must be reachable to Gelato. For local-only MVP this is not used —
   *  we rely on on-chain-readable conditions instead. */
  readonly resolverUrl?: string;
  /** Alternatively, a contract address + calldata for an on-chain resolver. */
  readonly resolverContract?: string;
  readonly resolverData?: string;
}

export interface RebalanceTaskSpec {
  readonly chainId: number;
  readonly policy: SessionKeyPolicy;
  readonly resolver: ResolverConfig;
  /** Optional maximum gas price (wei). Task skipped when exceeded. */
  readonly maxFeePerGasWei?: bigint;
  /** Human-readable label for UI / audit. */
  readonly label: string;
}

/** Validated task spec (produced from unsanitised input). */
export function validateTaskSpec(raw: unknown): RebalanceTaskSpec {
  const schema = z.object({
    chainId: z.number().int().positive(),
    policy: z.custom<SessionKeyPolicy>(
      (v) => v !== null && typeof v === 'object',
      'policy must be a SessionKeyPolicy',
    ),
    resolver: z
      .object({
        resolverUrl: z.string().url().startsWith('https://').optional(),
        resolverContract: AddressSchema.optional(),
        resolverData: z
          .string()
          .regex(/^0x[a-fA-F0-9]*$/)
          .optional(),
      })
      .refine(
        (r) =>
          r.resolverUrl !== undefined ||
          (r.resolverContract !== undefined && r.resolverData !== undefined),
        { message: 'either resolverUrl or (resolverContract + resolverData) is required' },
      ),
    maxFeePerGasWei: z.bigint().positive().optional(),
    label: z.string().min(1).max(120),
  });
  return schema.parse(raw);
}

/** The task record our app keeps locally. Mirrors the Gelato API response. */
export interface RegisteredTask {
  readonly taskId: string;
  readonly chainId: number;
  readonly sessionKeyAddress: string;
  readonly smartAccountAddress: string;
  readonly lpTokenId: bigint;
  readonly resolverUrl?: string;
  readonly resolverContract?: string;
  readonly registeredAt: number;
  readonly expiresAt: number;
  readonly label: string;
}

/** Opaque interface implemented at the Tauri/app layer. */
export interface GelatoClient {
  registerTask(spec: RebalanceTaskSpec): Promise<RegisteredTask>;
  cancelTask(taskId: string): Promise<void>;
  listTasks(smartAccountAddress: string): Promise<readonly RegisteredTask[]>;
}

/**
 * Test-oriented in-memory stub client. Useful for unit tests and for UI
 * development without hitting the real Gelato API.
 */
export class InMemoryGelatoClient implements GelatoClient {
  private readonly tasks = new Map<string, RegisteredTask>();

  async registerTask(spec: RebalanceTaskSpec): Promise<RegisteredTask> {
    const v = validateTaskSpec(spec);
    // Derive a deterministic task id so repeated registrations are idempotent
    // in test environments. Production Gelato returns a real id.
    const idSource = `${v.policy.smartAccountAddress}:${v.policy.lpTokenId}:${v.policy.validUntil}`;
    const taskId = ethers.keccak256(ethers.toUtf8Bytes(idSource));

    const record: RegisteredTask = {
      taskId,
      chainId: v.chainId,
      sessionKeyAddress: v.policy.sessionKeyAddress,
      smartAccountAddress: v.policy.smartAccountAddress,
      lpTokenId: v.policy.lpTokenId,
      resolverUrl: v.resolver.resolverUrl,
      resolverContract: v.resolver.resolverContract,
      registeredAt: Math.floor(Date.now() / 1000),
      expiresAt: v.policy.validUntil,
      label: v.label,
    };
    this.tasks.set(taskId, record);
    return record;
  }

  async cancelTask(taskId: string): Promise<void> {
    if (!this.tasks.has(taskId)) {
      throw new Error(`cancelTask: taskId ${taskId} not found`);
    }
    this.tasks.delete(taskId);
  }

  async listTasks(smartAccountAddress: string): Promise<readonly RegisteredTask[]> {
    const key = smartAccountAddress.toLowerCase();
    return Array.from(this.tasks.values()).filter(
      (t) => t.smartAccountAddress.toLowerCase() === key,
    );
  }
}

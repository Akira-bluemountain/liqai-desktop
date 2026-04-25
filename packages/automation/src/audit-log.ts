/**
 * Local audit log for every signing operation.
 *
 * SECURITY (docs/security-v2.md S5.3):
 *   Every action that constructs or submits a transaction MUST be recorded.
 *   The log is append-only. It never contains signing material (private
 *   keys, raw signatures), only public action metadata.
 */

import { z } from 'zod';

/** Categories of audited events. */
export type AuditAction =
  | 'smart_account:deployed'
  | 'session_key:created'
  | 'session_key:revoked'
  | 'lp_position:minted'
  | 'lp_position:rebalanced'
  | 'lp_position:closed'
  | 'swap:executed'
  | 'gelato_task:registered'
  | 'gelato_task:cancelled';

export interface AuditEvent {
  /** Unix seconds. */
  readonly timestamp: number;
  readonly action: AuditAction;
  /** The EOA or smart account that authorised the action. */
  readonly actorAddress: string;
  /** Chain on which the action occurred (if applicable). */
  readonly chainId?: number;
  /** Target contract address (if applicable). */
  readonly targetAddress?: string;
  /** Public transaction hash once broadcast. */
  readonly txHash?: string;
  /** Human-readable summary for display. */
  readonly description: string;
  /** Non-sensitive details. MUST NOT contain any key material. */
  readonly metadata?: Record<string, string | number | boolean>;
}

/** Schema to validate events before logging — forbids accidental key leakage. */
const AuditEventSchema = z.object({
  timestamp: z.number().int().positive(),
  action: z.string(),
  actorAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.number().int().positive().optional(),
  targetAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  txHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .optional(),
  description: z.string().min(1).max(500),
  metadata: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .refine(
      (m) => {
        if (!m) return true;
        for (const [k, v] of Object.entries(m)) {
          // Forbid keys that look like secret material
          if (/priv|secret|mnemonic|seed|signature/i.test(k)) return false;
          if (typeof v === 'string' && /^0x[a-fA-F0-9]{64}$/.test(v) && k !== 'txHash') {
            // Looks like a 32-byte hex; likely a private key or raw signature
            return false;
          }
        }
        return true;
      },
      { message: 'metadata may not contain keys or signatures' },
    ),
});

/** Storage backend for audit events. */
export interface AuditLogStorage {
  append(event: AuditEvent): Promise<void>;
  list(options?: {
    readonly limit?: number;
    readonly actorAddress?: string;
    readonly since?: number;
  }): Promise<readonly AuditEvent[]>;
}

/** In-memory audit log (for tests). Production uses SQLite. */
export class MemoryAuditLog implements AuditLogStorage {
  private readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    AuditEventSchema.parse(event);
    this.events.push(event);
  }

  async list(options: {
    limit?: number;
    actorAddress?: string;
    since?: number;
  } = {}): Promise<readonly AuditEvent[]> {
    let results = [...this.events];
    if (options.actorAddress) {
      const key = options.actorAddress.toLowerCase();
      results = results.filter((e) => e.actorAddress.toLowerCase() === key);
    }
    if (options.since !== undefined) {
      const since = options.since;
      results = results.filter((e) => e.timestamp >= since);
    }
    results.sort((a, b) => b.timestamp - a.timestamp); // newest first
    if (options.limit !== undefined) {
      results = results.slice(0, options.limit);
    }
    return results;
  }
}

/**
 * Convenience wrapper to build a timestamped event with defaults.
 */
export function makeEvent(
  action: AuditAction,
  params: Omit<AuditEvent, 'timestamp' | 'action'>,
): AuditEvent {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    action,
    ...params,
  };
}

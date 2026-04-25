'use client';

/**
 * LiqAI local SQLite persistence layer.
 *
 * All reads/writes go through this module. The underlying driver is
 * @tauri-apps/plugin-sql, which runs in the Rust side of Tauri and
 * provides a bounded, audited sqlite binding.
 *
 * SECURITY (docs/security-v2.md S5):
 *   - Parametrised queries ONLY. Never interpolate user input into SQL.
 *   - Zod schemas validate every row before insert/update.
 *   - `audit_log` has BEFORE UPDATE / BEFORE DELETE triggers that abort
 *     any mutation, enforcing append-only at the DB level (see
 *     001_initial.sql). The JS layer mirrors this by refusing to expose
 *     an update/delete path.
 *   - The DB is per-user, stored in Tauri's App data dir. Never transmitted.
 *
 * Connection strategy:
 *   - Lazy singleton. First call to `getDb()` loads the migrated DB; subsequent
 *     calls reuse the handle. Dev-mode hot-reload is handled by caching on
 *     `globalThis` so `Database.load()` is not called repeatedly (each call
 *     opens a new connection which leaks on hot reload).
 */

import Database from '@tauri-apps/plugin-sql';
import { z } from 'zod';

const DB_URL = 'sqlite:liqai.db';

declare global {
  // eslint-disable-next-line no-var
  var __liqaiDb: Database | undefined;
}

export async function getDb(): Promise<Database> {
  if (!globalThis.__liqaiDb) {
    const db = await Database.load(DB_URL);
    // PRAGMAs must be set per-connection, outside any transaction. The
    // migration file can't do this because tauri-plugin-sql wraps each
    // migration in a transaction.
    try {
      await db.execute('PRAGMA foreign_keys = ON');
    } catch {
      // Non-fatal: FK enforcement is a nice-to-have, not a safety guard.
    }
    globalThis.__liqaiDb = db;
  }
  return globalThis.__liqaiDb;
}

// ── Zod row schemas ──────────────────────────────────────────────────

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 20-byte address');
const TxHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte hash');
const ChainIdSchema = z.number().int().positive();
const UnixSecondsSchema = z.number().int().nonnegative();

export const SmartAccountRowSchema = z.object({
  chain_id: ChainIdSchema,
  owner_eoa_address: AddressSchema,
  smart_account_address: AddressSchema,
  entry_point_address: AddressSchema,
  kernel_implementation: z.string().min(1),
  deployed_at: UnixSecondsSchema,
  deployment_tx_hash: TxHashSchema,
});
export type SmartAccountRow = z.infer<typeof SmartAccountRowSchema>;

export const LpPositionInsertSchema = z.object({
  smart_account_id: z.number().int().positive(),
  chain_id: ChainIdSchema,
  lp_token_id: z.string().regex(/^\d+$/, 'uint256 as decimal string'),
  pool_address: AddressSchema,
  token0_address: AddressSchema,
  token1_address: AddressSchema,
  fee_tier: z.number().int().refine((v) => [100, 500, 3000, 10_000].includes(v)),
  tick_lower: z.number().int(),
  tick_upper: z.number().int(),
  liquidity: z.string().regex(/^\d+$/, 'uint128 as decimal string'),
  minted_at: UnixSecondsSchema,
  status: z.enum(['active', 'closed', 'pending']).default('active'),
});
export type LpPositionInsert = z.infer<typeof LpPositionInsertSchema>;

/**
 * Audit-log entry schema. Metadata values MUST NOT contain anything that
 * looks like a private key (0x-prefixed 32 bytes) — the schema rejects
 * entries that do. This mirrors the in-memory audit log guard in
 * @liqai/automation.
 *
 * 2026-04-23 Phase-5 Stage-1 β-incident update: the 32-byte-hex shape is
 * also the shape of a keccak256 hash. Phase 4.4 added `policyHash` (a
 * keccak256 of the canonical policy JSON) to the install-audit metadata,
 * and the previous shape-only check blocked every post-Phase-4.4 install
 * — L187 writeAudit threw, leaving the L151 session_keys row orphaned.
 *
 * Fix: key-name allow-list. Fields in METADATA_HASH_FIELDS are known
 * deterministic public hashes and are NOT rejected by shape. Every entry
 * here MUST be reviewed: a new 64-hex-looking field must be explicitly
 * added to this list, so reviewers see it. Do not relax the default
 * shape check for other keys — the private-key-leak guard is load-bearing
 * for the @liqai/automation in-memory audit log too.
 */
const SECRET_SHAPE = /^0x[a-fA-F0-9]{64}$/;
const METADATA_HASH_FIELDS: ReadonlySet<string> = new Set([
  // keccak256 of the canonical session-key policy JSON, recorded on install.
  // Phase 4.4 (Q1 remediation). Public value — derived from code, not secret.
  'policyHash',
]);
function valueLooksSecret(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  return SECRET_SHAPE.test(v);
}
function metadataIsSafe(meta: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(meta)) {
    if (METADATA_HASH_FIELDS.has(key)) continue;
    if (valueLooksSecret(val)) return false;
  }
  return true;
}

export const AuditLogInsertSchema = z
  .object({
    action: z.string().min(1).max(64),
    actor_address: AddressSchema,
    chain_id: ChainIdSchema.optional(),
    target_address: AddressSchema.optional(),
    tx_hash: TxHashSchema.optional(),
    description: z.string().min(1).max(1024),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => !v.metadata || metadataIsSafe(v.metadata), {
    message: 'audit_log metadata may not contain values shaped like private keys',
    path: ['metadata'],
  });
export type AuditLogInsert = z.infer<typeof AuditLogInsertSchema>;

// ── Smart accounts ──────────────────────────────────────────────────

/**
 * Insert or ignore a deployed Smart Account row (one per chain+EOA).
 * Returns the row ID.
 */
export async function upsertSmartAccount(input: SmartAccountRow): Promise<number> {
  const parsed = SmartAccountRowSchema.parse(input);
  const db = await getDb();
  // SQLite's UPSERT via ON CONFLICT — keeps the original deployment_tx_hash
  // if the row already exists (we never want to overwrite audit-relevant data).
  await db.execute(
    `INSERT INTO smart_accounts
      (chain_id, owner_eoa_address, smart_account_address, entry_point_address,
       kernel_implementation, deployed_at, deployment_tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain_id, owner_eoa_address) DO NOTHING`,
    [
      parsed.chain_id,
      parsed.owner_eoa_address,
      parsed.smart_account_address,
      parsed.entry_point_address,
      parsed.kernel_implementation,
      parsed.deployed_at,
      parsed.deployment_tx_hash,
    ],
  );
  const rows = (await db.select(
    'SELECT id FROM smart_accounts WHERE chain_id = $1 AND owner_eoa_address = $2',
    [parsed.chain_id, parsed.owner_eoa_address],
  )) as Array<{ id: number }>;
  if (rows.length === 0) {
    throw new Error('upsertSmartAccount: row lookup after insert returned empty');
  }
  return rows[0]!.id;
}

export async function getSmartAccountByOwner(
  chainId: number,
  ownerEoaAddress: string,
): Promise<(SmartAccountRow & { id: number }) | null> {
  const db = await getDb();
  const rows = (await db.select(
    `SELECT id, chain_id, owner_eoa_address, smart_account_address,
            entry_point_address, kernel_implementation, deployed_at,
            deployment_tx_hash
       FROM smart_accounts
      WHERE chain_id = $1 AND owner_eoa_address = $2
      LIMIT 1`,
    [chainId, ownerEoaAddress],
  )) as Array<SmartAccountRow & { id: number }>;
  return rows[0] ?? null;
}

// ── LP positions ────────────────────────────────────────────────────

export async function insertLpPosition(input: LpPositionInsert): Promise<number> {
  const parsed = LpPositionInsertSchema.parse(input);
  const db = await getDb();
  const res = await db.execute(
    `INSERT INTO lp_positions
      (smart_account_id, chain_id, lp_token_id, pool_address, token0_address,
       token1_address, fee_tier, tick_lower, tick_upper, liquidity, minted_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      parsed.smart_account_id,
      parsed.chain_id,
      parsed.lp_token_id,
      parsed.pool_address,
      parsed.token0_address,
      parsed.token1_address,
      parsed.fee_tier,
      parsed.tick_lower,
      parsed.tick_upper,
      parsed.liquidity,
      parsed.minted_at,
      parsed.status,
    ],
  );
  if (typeof res.lastInsertId !== 'number') {
    throw new Error('insertLpPosition: lastInsertId missing');
  }
  return res.lastInsertId;
}

export interface LpPositionRow extends LpPositionInsert {
  readonly id: number;
  readonly closed_at: number | null;
}

export async function listLpPositionsForSmartAccount(
  smartAccountId: number,
): Promise<LpPositionRow[]> {
  const db = await getDb();
  const rows = (await db.select(
    `SELECT id, smart_account_id, chain_id, lp_token_id, pool_address,
            token0_address, token1_address, fee_tier, tick_lower, tick_upper,
            liquidity, minted_at, closed_at, status
       FROM lp_positions
      WHERE smart_account_id = $1
      ORDER BY minted_at DESC`,
    [smartAccountId],
  )) as LpPositionRow[];
  return rows;
}

/**
 * List all LP positions owned by an EOA's Smart Account (across the lifetime
 * of this install). Convenience wrapper around listLpPositionsForSmartAccount
 * that accepts the human-friendly "owner + chain" identifier.
 */
export async function listLpPositionsForOwner(
  chainId: number,
  ownerEoaAddress: string,
): Promise<LpPositionRow[]> {
  const sa = await getSmartAccountByOwner(chainId, ownerEoaAddress);
  if (!sa) return [];
  return listLpPositionsForSmartAccount(sa.id);
}

// ── Audit log (append-only) ─────────────────────────────────────────

export async function writeAudit(entry: AuditLogInsert): Promise<void> {
  const parsed = AuditLogInsertSchema.parse(entry);
  const db = await getDb();
  const metadataJson = parsed.metadata
    ? JSON.stringify(parsed.metadata)
    : null;
  await db.execute(
    `INSERT INTO audit_log
      (timestamp, action, actor_address, chain_id, target_address, tx_hash,
       description, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      Math.floor(Date.now() / 1000),
      parsed.action,
      parsed.actor_address,
      parsed.chain_id ?? null,
      parsed.target_address ?? null,
      parsed.tx_hash ?? null,
      parsed.description,
      metadataJson,
    ],
  );
}

export interface AuditLogRow {
  readonly id: number;
  readonly timestamp: number;
  readonly action: string;
  readonly actor_address: string;
  readonly chain_id: number | null;
  readonly target_address: string | null;
  readonly tx_hash: string | null;
  readonly description: string;
  readonly metadata_json: string | null;
}

export async function recentAudit(limit = 50): Promise<AuditLogRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('recentAudit: limit must be an integer in [1, 1000]');
  }
  const db = await getDb();
  return (await db.select(
    `SELECT id, timestamp, action, actor_address, chain_id, target_address,
            tx_hash, description, metadata_json
       FROM audit_log
      ORDER BY timestamp DESC, id DESC
      LIMIT $1`,
    [limit],
  )) as AuditLogRow[];
}

// ── App settings (singleton row) ────────────────────────────────────

export interface AppSettingsRow {
  readonly default_slippage_bps: number;
  readonly default_deadline_sec: number;
  readonly rpc_url_ethereum: string | null;
  readonly coingecko_api_key: string | null;
  readonly gelato_api_key: string | null;
  readonly zerodev_project_id: string | null;
  readonly telemetry_opt_in: 0 | 1;
  readonly updated_at: number;
}

export async function getAppSettings(): Promise<AppSettingsRow> {
  const db = await getDb();
  const rows = (await db.select(
    `SELECT default_slippage_bps, default_deadline_sec, rpc_url_ethereum,
            coingecko_api_key, gelato_api_key, zerodev_project_id,
            telemetry_opt_in, updated_at
       FROM app_settings WHERE id = 1`,
  )) as AppSettingsRow[];
  if (rows.length === 0) {
    throw new Error('app_settings singleton row missing');
  }
  return rows[0]!;
}

const UpdatableSettingsSchema = z.object({
  default_slippage_bps: z.number().int().min(0).max(1000).optional(),
  default_deadline_sec: z.number().int().min(30).max(3600).optional(),
  rpc_url_ethereum: z.string().url().nullable().optional(),
  coingecko_api_key: z.string().min(1).nullable().optional(),
  telemetry_opt_in: z.union([z.literal(0), z.literal(1)]).optional(),
});
export type UpdatableSettings = z.infer<typeof UpdatableSettingsSchema>;

export async function updateAppSettings(patch: UpdatableSettings): Promise<void> {
  const parsed = UpdatableSettingsSchema.parse(patch);
  const keys = Object.keys(parsed) as Array<keyof typeof parsed>;
  if (keys.length === 0) return;
  // Build the SET clause dynamically — keys are strictly typed and come from
  // a Zod schema, so they cannot be attacker-controlled.
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const k of keys) {
    setClauses.push(`${k} = $${i++}`);
    values.push((parsed as Record<string, unknown>)[k]);
  }
  setClauses.push(`updated_at = $${i++}`);
  values.push(Math.floor(Date.now() / 1000));
  const db = await getDb();
  await db.execute(
    `UPDATE app_settings SET ${setClauses.join(', ')} WHERE id = 1`,
    values,
  );
}

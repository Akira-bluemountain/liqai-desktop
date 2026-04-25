/**
 * auditMetadata.test — regression coverage for the Phase-5 Stage-1
 * β-incident (2026-04-23).
 *
 * Background: Phase 4.4 added `policyHash` (keccak256 = 32-byte hex) to
 * the install-audit metadata. The pre-existing `valueLooksSecret` filter
 * matched that shape and made AuditLogInsertSchema.parse() throw on every
 * post-Phase-4.4 install attempt, creating orphan session_keys rows.
 *
 * These tests lock in:
 *   1. The exact sessionKeyInstall metadata shape used at the throwing
 *      call-site (db.ts L187) parses cleanly — proves the fix.
 *   2. The defence against private-key-shaped leaks is NOT weakened for
 *      unknown fields — a raw 32-byte hex under a non-allow-listed key
 *      still rejects.
 *   3. The allow-list honours its key-name semantics: same value shape,
 *      allowed field name → accept; different field name → reject.
 *
 * These are pure-function tests against the exported Zod schema — they
 * do NOT touch SQLite, so they run in Node without the Tauri plugin.
 */

import { describe, it, expect } from 'vitest';
import { AuditLogInsertSchema } from '../db';

const SA_ADDRESS = '0x135A384fD401E041167F1bE8bee312d7A6899A5F';
const EOA_ADDRESS = '0x74Af9eB9432e1E25f32164259f05ED26a86e86db';
const SESSION_KEY_ADDRESS = '0x1234567890AbcdEF1234567890aBcdef12345678';
const NPM_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const POLICY_HASH =
  '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const EXAMPLE_PRIVATE_KEY_SHAPE =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

describe('AuditLogInsertSchema — Phase 4.4 metadata compatibility', () => {
  it('accepts the exact metadata shape used by installSessionKey', () => {
    // This payload mirrors sessionKeyInstall.ts L187-L203 verbatim. Before
    // the 2026-04-23 fix this threw with "audit_log metadata may not
    // contain values shaped like private keys".
    const payload = {
      action: 'session_key_installed',
      actor_address: EOA_ADDRESS,
      chain_id: 1,
      target_address: NPM_ADDRESS,
      description:
        `Session key ${SESSION_KEY_ADDRESS} enabled on SA ` +
        `${SA_ADDRESS} (target=Uniswap NPM, 10 ops/24h, expires ` +
        `2026-05-23T03:16:00.000Z, policyHash=${POLICY_HASH.slice(0, 10)}…)`,
      metadata: {
        sessionKeyAddress: SESSION_KEY_ADDRESS,
        validUntil: 1748059200,
        policyHash: POLICY_HASH,
        policyVersion: 'Q1-fix-2026-04-22',
      },
    };
    expect(() => AuditLogInsertSchema.parse(payload)).not.toThrow();
  });

  it('still rejects a 32-byte-hex value in a non-allow-listed metadata field', () => {
    // The private-key leak guard must remain load-bearing for arbitrary
    // fields. A field called "privateKey" (or any name not in the allow-
    // list) with a 32-byte-hex value still trips valueLooksSecret.
    const payload = {
      action: 'session_key_installed',
      actor_address: EOA_ADDRESS,
      description: 'regression probe — private key in unknown field',
      metadata: {
        sessionKeyAddress: SESSION_KEY_ADDRESS,
        privateKey: EXAMPLE_PRIVATE_KEY_SHAPE,
      },
    };
    expect(() => AuditLogInsertSchema.parse(payload)).toThrow(
      /private keys/,
    );
  });

  it('allow-list is keyed by field name, not value — same hex under "secret" is rejected', () => {
    // The allow-list waives the shape check only for specific field
    // names. The very same 32-byte-hex value, placed under a different
    // (unvetted) key, is still rejected. This guarantees reviewers must
    // explicitly add a key to the allow-list in db.ts for it to bypass.
    const sharedValue = POLICY_HASH;

    const allowed = {
      action: 'session_key_installed',
      actor_address: EOA_ADDRESS,
      description: 'allowed via policyHash field name',
      metadata: { policyHash: sharedValue },
    };
    expect(() => AuditLogInsertSchema.parse(allowed)).not.toThrow();

    const rejected = {
      action: 'session_key_installed',
      actor_address: EOA_ADDRESS,
      description: 'rejected because field name is not on allow-list',
      metadata: { secret: sharedValue },
    };
    expect(() => AuditLogInsertSchema.parse(rejected)).toThrow(/private keys/);
  });

  it('accepts metadata without any 32-byte-hex fields (common case)', () => {
    // Baseline: a typical lp_position_minted audit has only addresses,
    // numbers, and short tx-hash-ish strings in metadata. This should
    // not regress.
    const payload = {
      action: 'lp_position_minted',
      actor_address: EOA_ADDRESS,
      chain_id: 1,
      description: 'Minted USDC/WETH LP tokenId=1266755',
      metadata: {
        tokenId: '1266755',
        liquidity: '20366333253956',
        amount0: '50000000',
        amount1: '20698000000000000',
      },
    };
    expect(() => AuditLogInsertSchema.parse(payload)).not.toThrow();
  });
});

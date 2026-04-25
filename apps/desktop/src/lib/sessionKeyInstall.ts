'use client';

/**
 * installSessionKey — orchestrates the off-chain "enable" of a scope-
 * limited session key on the user's deployed Kernel Smart Account.
 *
 * Architecture (ZeroDev permissions module):
 *   1. Build a Kernel account that has BOTH the user's main ECDSA validator
 *      (sudo) AND the new permission validator (regular).
 *   2. `serializePermissionAccount` produces a portable string that includes
 *      an ENABLE SIGNATURE from the sudo validator authorising the
 *      permission validator to act on the SA.
 *   3. The actual on-chain plugin install happens lazily on first use of
 *      the session key — so this step is FREE (no gas).
 *   4. We encrypt-at-rest the (privateKey, serialized) pair using the user's
 *      passphrase and store in SQLite.
 *
 * SECURITY:
 *   - The enable signature is signed by the user's wallet via WalletConnect
 *     — LiqAI never sees the EOA private key.
 *   - The session key private key is generated locally with
 *     crypto.getRandomValues, immediately AES-GCM encrypted with a PBKDF2-
 *     derived key from a passphrase the user enters, and persisted only as
 *     ciphertext.
 *   - On revoke, the ciphertext is removed from local storage. To also
 *     prevent the on-chain enable from being reused we rely on the
 *     timestamp policy (30-day expiry) and rate-limit policy (10 ops / 24h),
 *     both of which the Kernel SA enforces independently of the local key.
 */

import { type PrivateKeyAccount } from 'viem/accounts';
import {
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
} from 'viem';
import { createKernelAccount } from '@zerodev/sdk';
import { serializePermissionAccount } from '@zerodev/permissions';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { ENTRYPOINT, KERNEL_VERSION, KERNEL_ACCOUNT_INDEX } from './zerodev';
import {
  buildRebalanceCallPolicyPermissions,
  buildRebalancePermissionValidator,
  buildSessionKeyPolicyMeta,
  type SessionKeyPolicyMeta,
} from './sessionKeyPolicy';
import { encryptString, blobToString } from './sessionKeyCrypto';
import { evaluatePassphrase } from './passphraseStrength';
import { getDb, writeAudit } from './db';

const MAINNET_ID = 1;

export interface InstallSessionKeyInput {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  readonly sessionKeyAccount: PrivateKeyAccount;
  readonly sessionKeyPrivateKey: `0x${string}`;
  readonly passphrase: string;
  readonly smartAccountId: number;
  readonly eoaAddress: Address;
  readonly smartAccountAddress: Address;
}

export interface InstallSessionKeyResult {
  readonly sessionKeyAddress: Address;
  readonly meta: SessionKeyPolicyMeta;
  readonly dbRowId: number;
  /** Local ciphertext handle — opaque pointer the loader uses to fetch + decrypt. */
  readonly storageHandle: string;
}

/**
 * Install (enable) a session key by creating a permission-validator-bearing
 * Kernel account, asking the user to sign the enable hash, then encrypting
 * + storing everything locally.
 */
export async function installSessionKey(
  input: InstallSessionKeyInput,
): Promise<InstallSessionKeyResult> {
  // 0. Passphrase strength gate (Phase 4.3). The session-key private key
  //    is AES-GCM encrypted with a PBKDF2-derived key from this passphrase;
  //    weak passphrases enable offline brute-force attacks that bypass the
  //    rate-limit / timestamp on-chain enforcement. Reject anything below
  //    the 60-bit entropy floor — that's roughly diceware-5.
  const strength = evaluatePassphrase(input.passphrase);
  if (!strength.ok) {
    throw new Error(
      `Passphrase rejected: ${strength.message}` +
        (strength.suggestion ? ` ${strength.suggestion}` : ''),
    );
  }

  // 1. Build the permission validator using the session key as signer.
  //    The SA address is baked into the on-chain policy (as the pinned
  //    recipient for mint/collect) — this is the Q1 remediation. A key
  //    issued for SA_A cannot operate on SA_B; attempting to would
  //    on-chain revert on the recipient EQUAL rule.
  const { validator: permissionValidator, meta } =
    await buildRebalancePermissionValidator({
      publicClient: input.publicClient,
      sessionKeyAccount: input.sessionKeyAccount,
      smartAccountAddress: input.smartAccountAddress,
    });

  // 2. Build the SUDO validator using the user's EOA (will be asked to
  //    sign the enable hash).
  const sudoValidator = await signerToEcdsaValidator(input.publicClient, {
    signer: input.walletClient,
    entryPoint: ENTRYPOINT,
    kernelVersion: KERNEL_VERSION,
  });

  // 3. Construct a Kernel account with BOTH plugins. The "regular" slot is
  //    the new permission validator — the sudo slot signs the enable hash
  //    inside serializePermissionAccount.
  const sessionKernelAccount = await createKernelAccount(input.publicClient, {
    plugins: {
      sudo: sudoValidator,
      regular: permissionValidator,
    },
    entryPoint: ENTRYPOINT,
    kernelVersion: KERNEL_VERSION,
    index: KERNEL_ACCOUNT_INDEX,
  });

  // 4. Serialize. THIS triggers a wallet signature request to the user's
  //    EOA via WalletConnect — they sign an EIP-712 enable-permissions
  //    typed-data structure. No on-chain transaction, no gas.
  const serialized = await serializePermissionAccount(sessionKernelAccount);

  // 5. Encrypt private key + serialized config with the user's passphrase
  //    and persist atomically.
  const payload = JSON.stringify({
    privateKey: input.sessionKeyPrivateKey,
    serialized,
    sessionKeyAddress: input.sessionKeyAccount.address,
    createdAt: Math.floor(Date.now() / 1000),
  });
  const ciphertext = blobToString(
    await encryptString(payload, input.passphrase),
  );

  const db = await getDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const result = await db.execute(
    `INSERT INTO session_keys
      (smart_account_id, session_key_address, stronghold_handle,
       allowed_target_address, allowed_selectors_json, lp_token_id,
       valid_after, valid_until, max_executions_per_24h, created_at,
       install_tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.smartAccountId,
      input.sessionKeyAccount.address,
      ciphertext,
      meta.targetAddress,
      JSON.stringify(meta.allowedSelectors),
      // No tokenId binding for now — session key may operate on any of the
      // user's positions. (LP NFT-id-bound policies ship in a follow-up.)
      '',
      meta.validAfter,
      meta.validUntil,
      meta.maxExecutionsPer24h,
      nowSec,
      // No on-chain install tx — the enable happens lazily on first use.
      // We mark with a sentinel so the schema's NOT NULL is satisfied.
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    ],
  );
  if (typeof result.lastInsertId !== 'number') {
    throw new Error('session_keys insert did not return lastInsertId');
  }
  const sessionKeyRowId = result.lastInsertId;

  // Phase 4.4: compute a deterministic hash over the policy structure
  // (selectors, offsets, caps, recipient) so audit-log readers can spot
  // any issuance whose on-chain rules diverge from the current code.
  // Different hashes for the same user = either a code change or a
  // tampered install path. Stable hash across installs by the same build.
  //
  // 2026-04-23 Phase-5 Stage-1 β-incident follow-up: the writeAudit call
  // below can throw (e.g., Zod metadata validation rejects). Before the
  // fix, such a throw left the session_keys row above as an ORPHAN — UI
  // showed "Install success" (because the row was created), but there
  // was no audit entry, so no policyHash trail. Diagnostic detected it
  // as SCENARIO_B_AUDIT_REGRESSION.
  //
  // Tauri's @tauri-apps/plugin-sql doesn't expose a JS-level transaction
  // primitive, so we use a compensating DELETE: if writeAudit throws,
  // delete the session_keys row we just inserted, then re-throw. The
  // invariant this protects: "every session_keys row has a matching
  // audit_log session_key_installed entry".
  try {
    const policyHash = computePolicyHash(input.smartAccountAddress);
    await writeAudit({
      action: 'session_key_installed',
      actor_address: input.eoaAddress,
      chain_id: MAINNET_ID,
      target_address: meta.targetAddress,
      description:
        `Session key ${input.sessionKeyAccount.address} enabled on SA ` +
        `${input.smartAccountAddress} (target=Uniswap NPM, ` +
        `${meta.maxExecutionsPer24h} ops/24h, expires ` +
        `${new Date(meta.validUntil * 1000).toISOString()}, ` +
        `policyHash=${policyHash.slice(0, 10)}…)`,
      metadata: {
        sessionKeyAddress: input.sessionKeyAccount.address,
        validUntil: meta.validUntil,
        policyHash,
        policyVersion: 'Q1-fix-2026-04-22',
      },
    });
  } catch (auditErr) {
    try {
      await db.execute(`DELETE FROM session_keys WHERE id = $1`, [
        sessionKeyRowId,
      ]);
    } catch (rollbackErr) {
      // Compensation itself failed — the row is now a genuine orphan and
      // phase5:session-diagnostic will flag it. Surface both errors so
      // the operator has the full picture.
      throw new Error(
        `Install failed at writeAudit: ${String(auditErr)}. ` +
          `Compensating DELETE also failed: ${String(rollbackErr)}. ` +
          `session_keys row id=${sessionKeyRowId} is now orphaned — revoke it ` +
          `via the UI before retrying.`,
      );
    }
    throw auditErr;
  }

  return {
    sessionKeyAddress: input.sessionKeyAccount.address,
    meta,
    dbRowId: sessionKeyRowId,
    storageHandle: ciphertext.slice(0, 32) + '…', // opaque preview
  };
}

/**
 * Compute a deterministic hash over the session-key policy for a given
 * Smart Account. This is the fingerprint the audit log records, so that
 * any future policy regression (e.g., recipient pin removed) shows up as
 * a different hash for new installs.
 *
 * Implementation: serialise the policy permissions array (selector,
 * valueLimit, rules with {condition, offset, params}) into a stable JSON
 * form, then keccak256 it. BigInts are coerced to decimal strings so the
 * JSON is portable.
 */
export function computePolicyHash(saAddress: Address): Hex {
  const meta = buildSessionKeyPolicyMeta({
    smartAccountAddress: saAddress,
    // Use a fixed timestamp so the hash is only a function of the
    // policy structure, not install-time. validAfter/validUntil are
    // audited separately via the description line.
    nowSec: 0,
  });
  const perms = buildRebalanceCallPolicyPermissions(meta);
  const canonical = JSON.stringify(perms, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  return keccak256(stringToHex(canonical));
}

/**
 * Mark a session key as revoked locally. The on-chain plugin remains
 * installed but cannot act because:
 *   - The key's private material is no longer accessible (we removed it
 *     from local storage),
 *   - Even if the cleartext key was leaked to an attacker, the timestamp
 *     and rate-limit policies still bound its blast radius.
 *
 * For full on-chain disable, the user can send an `uninstallModule`
 * userOp from their main wallet (UI helper ships in a follow-up).
 */
export async function revokeSessionKey(options: {
  readonly db: Awaited<ReturnType<typeof getDb>>;
  readonly sessionKeyDbId: number;
  readonly eoaAddress: Address;
  readonly sessionKeyAddress: Address;
}): Promise<void> {
  const { db, sessionKeyDbId, eoaAddress, sessionKeyAddress } = options;
  const nowSec = Math.floor(Date.now() / 1000);
  await db.execute(
    `UPDATE session_keys
        SET revoked_at = $1, stronghold_handle = ''
      WHERE id = $2`,
    [nowSec, sessionKeyDbId],
  );
  await writeAudit({
    action: 'session_key_revoked',
    actor_address: eoaAddress,
    description:
      `Session key ${sessionKeyAddress} revoked locally. Encrypted key ` +
      `material erased; on-chain plugin remains but cannot act without it.`,
  });
}

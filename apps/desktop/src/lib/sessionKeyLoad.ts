'use client';

/**
 * loadSessionKeyClient — decrypts the locally stored session-key ciphertext,
 * rebuilds the ZeroDev permission Kernel account from the serialized blob,
 * and returns a Kernel account client that can send scope-limited userOps
 * autonomously (no EOA wallet signature required).
 *
 * Callers:
 *   - rebalanceExecutor.ts (main production use)
 *   - SessionKeyPanel "Dry-run" button (future)
 *
 * SECURITY:
 *   - Decrypted private key exists in JS memory only for the lifetime of the
 *     returned client; caller should NOT persist it.
 *   - Every userOp this client signs is subject to the on-chain permission
 *     validator's callPolicy + rateLimitPolicy + timestampPolicy. A compromise
 *     of the passphrase alone is bounded by those policies.
 *   - The passphrase is never logged. Decryption errors are wrapped with a
 *     generic message so we don't leak "wrong passphrase" vs "tampered
 *     ciphertext".
 */

import { http, parseAbi, type PublicClient, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createKernelAccountClient } from '@zerodev/sdk';
import { deserializePermissionAccount } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import {
  ENTRYPOINT,
  KERNEL_VERSION,
  getBundlerUrl,
  PIMLICO_API_KEY_CONFIGURED,
} from './zerodev';
import { decryptString, stringToBlob } from './sessionKeyCrypto';
import { getDb } from './db';
import { debugLog, debugWarn } from './debugLog';

const MAINNET_ID = 1;

export interface StoredSessionKey {
  readonly id: number;
  readonly smartAccountId: number;
  readonly sessionKeyAddress: Address;
  readonly smartAccountAddress: Address;
  readonly allowedTargetAddress: Address;
  readonly validAfter: number;
  readonly validUntil: number;
  readonly maxExecutionsPer24h: number;
  readonly createdAt: number;
  readonly ciphertext: string;
  readonly revokedAt: number | null;
}

interface SessionKeyRowRaw {
  id: number;
  smart_account_id: number;
  session_key_address: string;
  stronghold_handle: string;
  allowed_target_address: string;
  valid_after: number;
  valid_until: number;
  max_executions_per_24h: number;
  created_at: number;
  revoked_at: number | null;
  smart_account_address: string;
}

/**
 * Fetch the single currently-active (non-revoked, non-expired) session key
 * for the given smart account. Returns null if none.
 */
export async function fetchActiveSessionKey(
  smartAccountAddress: Address,
): Promise<StoredSessionKey | null> {
  const db = await getDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = (await db.select(
    `SELECT sk.id, sk.smart_account_id, sk.session_key_address,
            sk.stronghold_handle, sk.allowed_target_address,
            sk.valid_after, sk.valid_until, sk.max_executions_per_24h,
            sk.created_at, sk.revoked_at,
            sa.smart_account_address
       FROM session_keys sk
       JOIN smart_accounts sa ON sa.id = sk.smart_account_id
      WHERE sa.smart_account_address = $1
        AND sk.revoked_at IS NULL
        AND sk.valid_until > $2
        AND sk.stronghold_handle != ''
      ORDER BY sk.created_at DESC
      LIMIT 1`,
    [smartAccountAddress, nowSec],
  )) as SessionKeyRowRaw[];
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    smartAccountId: row.smart_account_id,
    sessionKeyAddress: row.session_key_address as Address,
    smartAccountAddress: row.smart_account_address as Address,
    allowedTargetAddress: row.allowed_target_address as Address,
    validAfter: row.valid_after,
    validUntil: row.valid_until,
    maxExecutionsPer24h: row.max_executions_per_24h,
    createdAt: row.created_at,
    ciphertext: row.stronghold_handle,
    revokedAt: row.revoked_at,
  };
}

export interface LoadedSessionKeyClient {
  readonly sessionKeyAddress: Address;
  readonly smartAccountAddress: Address;
  readonly client: Awaited<ReturnType<typeof buildClient>>;
}

/**
 * Build an autonomous Kernel client from a stored session key row. The
 * returned client signs userOps with the session key's ECDSA signer; the
 * on-chain permission validator enforces scope.
 */
export async function loadSessionKeyClient(options: {
  readonly publicClient: PublicClient;
  readonly sessionKey: StoredSessionKey;
  readonly passphrase: string;
}): Promise<LoadedSessionKeyClient> {
  if (!PIMLICO_API_KEY_CONFIGURED) {
    throw new Error(
      'Pimlico API key missing — set NEXT_PUBLIC_PIMLICO_API_KEY in apps/desktop/.env.local',
    );
  }
  const bundlerUrl = getBundlerUrl(MAINNET_ID);
  if (!bundlerUrl) throw new Error('Pimlico bundler URL not configured');

  const nowSec = Math.floor(Date.now() / 1000);
  if (options.sessionKey.validUntil <= nowSec) {
    throw new Error(
      `Session key ${options.sessionKey.sessionKeyAddress} expired at ` +
        `${new Date(options.sessionKey.validUntil * 1000).toISOString()}`,
    );
  }

  // 1. Decrypt the stored JSON blob.
  const blob = stringToBlob(options.sessionKey.ciphertext);
  const plaintext = await decryptString(blob, options.passphrase);
  const parsed = JSON.parse(plaintext) as {
    privateKey: `0x${string}`;
    serialized: string;
    sessionKeyAddress: string;
  };
  if (
    parsed.sessionKeyAddress.toLowerCase() !==
    options.sessionKey.sessionKeyAddress.toLowerCase()
  ) {
    throw new Error(
      'Decrypted session key address does not match DB row — ciphertext / DB mismatch',
    );
  }

  // 2. Build the ECDSA signer from the private key.
  const sessionKeyAccount = privateKeyToAccount(parsed.privateKey);
  const ecdsaSigner = await toECDSASigner({ signer: sessionKeyAccount });

  // 2.5. Before deserializing, reconcile the stored `isPreInstalled` flag
  //      with on-chain reality. When a session key is first installed, the
  //      serialized blob records `isPreInstalled: false` (it lazily installs
  //      on first use via ENABLE-mode userOp). But once that first use
  //      happens, the validator IS installed — and subsequent userOps must
  //      use DEFAULT nonce mode, not ENABLE mode.
  //
  //      The ZeroDev SDK has a runtime `isEnabled()` check, but it's only
  //      queried AFTER nonce computation in some code paths, so stale
  //      isPreInstalled leaks through as "Invalid Smart Account nonce" on
  //      the 2nd and later rebalance.
  //
  //      Fix: parse the blob, query Kernel.permissionConfig() for the
  //      permission id, and if the signer contract matches, flip
  //      isPreInstalled=true + clear enableSignature before deserializing.
  const reconciledSerialized = await reconcilePreInstalled({
    publicClient: options.publicClient,
    serialized: parsed.serialized,
    smartAccountAddress: options.sessionKey.smartAccountAddress,
  });

  // 3. Deserialize the permission account (reconstructs sudo + regular
  //    plugins with the enable signature previously collected from the EOA).
  const account = await deserializePermissionAccount(
    options.publicClient,
    ENTRYPOINT,
    KERNEL_VERSION,
    reconciledSerialized,
    ecdsaSigner,
  );

  const client = await buildClient({
    publicClient: options.publicClient,
    account,
    bundlerUrl,
  });

  return {
    sessionKeyAddress: options.sessionKey.sessionKeyAddress,
    smartAccountAddress: options.sessionKey.smartAccountAddress,
    client,
  };
}

// ABI fragment for Kernel V3.1 permissionConfig(bytes4) lookup. Returns a
// tuple whose `signer` field is non-zero when the permission is installed.
// NOTE: policyData is bytes22[] (packed [policy_flag:2 + policy_addr:20]),
// NOT bytes. Prior version used `bytes` which silently mis-decoded and made
// this whole check fall back to "not installed" — caused ENABLE-mode nonce
// to be reused on 2nd+ session-key use and AA23 revert.
const KERNEL_PERMISSION_CONFIG_ABI = parseAbi([
  'struct PermissionConfig { bytes2 permissionFlag; address signer; bytes22[] policyData; }',
  'function permissionConfig(bytes4 pId) view returns (PermissionConfig)',
] as const);

/**
 * Parse the serialized permission-account blob, query the Kernel's
 * `permissionConfig(permissionId)` on-chain, and — if the permission is
 * already installed — return a new blob with `isPreInstalled: true` and
 * `enableSignature: undefined` so subsequent userOps use DEFAULT nonce mode.
 *
 * Returns the original blob unchanged if:
 *   - The permission is NOT installed (first use — we still need enable data).
 *   - The on-chain read fails (conservative: better to re-send enable data
 *     than to block the user on a transient RPC hiccup).
 *   - The blob doesn't contain the expected `permissionId` shape (older
 *     SDK versions stored it differently; don't crash, just defer to SDK).
 */
async function reconcilePreInstalled(options: {
  publicClient: PublicClient;
  serialized: string;
  smartAccountAddress: Address;
}): Promise<string> {
  try {
    // The blob is base64(JSON(...)) per @zerodev/permissions utils.js.
    const jsonString = atob(options.serialized);
    const parsed = JSON.parse(jsonString) as {
      isPreInstalled?: boolean;
      enableSignature?: string;
      permissionParams?: { permissionId?: string };
    };

    debugLog('[LiqAI sessionKeyLoad] blob top-level keys:', Object.keys(parsed));
    debugLog('[LiqAI sessionKeyLoad] permissionParams:', parsed.permissionParams);

    // Short-circuit: already marked pre-installed, nothing to do.
    if (parsed.isPreInstalled === true) {
      debugLog('[LiqAI sessionKeyLoad] blob already isPreInstalled=true');
      return options.serialized;
    }

    const permissionId = parsed.permissionParams?.permissionId;
    if (!permissionId || typeof permissionId !== 'string') {
      debugWarn(
        '[LiqAI sessionKeyLoad] no permissionId in blob, cannot reconcile',
      );
      return options.serialized;
    }

    // Query the Kernel. If the permission is installed, `signer` is the
    // deployed ECDSA signer contract (non-zero).
    const cfg = (await options.publicClient.readContract({
      address: options.smartAccountAddress,
      abi: KERNEL_PERMISSION_CONFIG_ABI,
      functionName: 'permissionConfig',
      args: [permissionId as `0x${string}`],
    })) as {
      signer: Address;
      permissionFlag: `0x${string}`;
      policyData: readonly `0x${string}`[];
    };

    const isInstalled =
      cfg.signer &&
      cfg.signer.toLowerCase() !==
        '0x0000000000000000000000000000000000000000';

    debugLog(
      `[LiqAI sessionKeyLoad] reconcilePreInstalled — ` +
        `permissionId=${permissionId} ` +
        `onchainSigner=${cfg.signer} ` +
        `isInstalled=${isInstalled} ` +
        `priorIsPreInstalled=${parsed.isPreInstalled} ` +
        `policyDataLen=${cfg.policyData?.length ?? 0}`,
    );

    if (!isInstalled) return options.serialized;

    // Flip flags so the SDK uses DEFAULT mode + no enable data.
    parsed.isPreInstalled = true;
    parsed.enableSignature = undefined;
    const updatedJson = JSON.stringify(parsed);
    return btoa(updatedJson);
  } catch (err) {
    // Any parsing / RPC error → fall back to the original blob.
    debugWarn(
      '[LiqAI sessionKeyLoad] reconcilePreInstalled failed, using original blob:',
      err,
    );
    return options.serialized;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildClient(opts: {
  publicClient: PublicClient;
  // Typed as `any` because ZeroDev's deserialised account type is deeply
  // generic and doesn't add safety at this boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  account: any;
  bundlerUrl: string;
}) {
  const { publicClient, account, bundlerUrl } = opts;
  return createKernelAccountClient({
    account,
    chain: mainnet,
    bundlerTransport: http(bundlerUrl),
    client: publicClient,
    // Gas-price selection with a real fallback chain:
    //   1. pimlico_getUserOperationGasPrice (preferred — tuned for 4337).
    //   2. publicClient.estimateFeesPerGas (EIP-1559 from the node).
    //   3. publicClient.getGasPrice (legacy eth_gasPrice, always supported).
    // Previously this fell through to hardcoded 1 gwei if estimateFeesPerGas
    // returned undefined on either field — on current mainnet (2-20 gwei
    // typical) that's 50×+ too low, causing the bundler to silently drop the
    // userOp or leave it pending forever. The new chain throws loud if even
    // the legacy call fails, which surfaces the RPC problem instead of
    // shipping a doomed userOp.
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        try {
          const tiers = (await bundlerClient.request({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            method: 'pimlico_getUserOperationGasPrice' as any,
            params: [],
          })) as {
            standard: {
              maxFeePerGas: `0x${string}`;
              maxPriorityFeePerGas: `0x${string}`;
            };
          };
          return {
            maxFeePerGas: BigInt(tiers.standard.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(tiers.standard.maxPriorityFeePerGas),
          };
        } catch (pimlicoErr) {
          debugWarn(
            '[LiqAI sessionKeyLoad] pimlico gas-price failed, falling back to EIP-1559 estimate:',
            pimlicoErr,
          );
          let maxFeePerGas: bigint | undefined;
          let maxPriorityFeePerGas: bigint | undefined;
          try {
            const fees = await publicClient.estimateFeesPerGas();
            maxFeePerGas = fees.maxFeePerGas;
            maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
          } catch (eip1559Err) {
            debugWarn(
              '[LiqAI sessionKeyLoad] EIP-1559 estimate failed, using eth_gasPrice:',
              eip1559Err,
            );
          }
          if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
            // Final fallback: eth_gasPrice returns the node's legacy gas price.
            // We set priority fee to min(gas_price, 2 gwei) as a safe baseline;
            // maxFeePerGas = gas_price × 1.5 so the userOp still gets mined if
            // the next block's base fee drifts up slightly.
            const legacyGasPrice = await publicClient.getGasPrice();
            const priorityCap = 2_000_000_000n; // 2 gwei
            maxPriorityFeePerGas =
              legacyGasPrice < priorityCap ? legacyGasPrice : priorityCap;
            maxFeePerGas = (legacyGasPrice * 3n) / 2n;
          }
          return { maxFeePerGas, maxPriorityFeePerGas };
        }
      },
    },
  });
}

'use client';

/**
 * SessionKeyPanel — lets the user generate, review, and (eventually)
 * install a scope-limited session key on their Kernel Smart Account.
 *
 * The session key enables 24/7 automated rebalance without the user
 * signing every transaction. The scope is strict:
 *   - Target allow-list: Uniswap V3 NonfungiblePositionManager ONLY
 *   - Selector allow-list: mint / decreaseLiquidity / collect ONLY
 *   - Rate limit: 10 rebalances per 24h
 *   - Expiry: 30 days (user can revoke earlier)
 *   - No ETH transfer ability (valueLimit = 0 on every call)
 *
 * CURRENT PHASE (B-3a): Generation + full policy preview. The private
 * key stays in component state only — we intentionally do NOT persist
 * to disk yet. Install-on-chain and AES-encrypted persistence come in
 * B-3b, once the user has a deployed Smart Account to install onto.
 *
 * SECURITY:
 *   - The session-key private key is never rendered or logged.
 *   - Generation uses crypto.getRandomValues (platform-audited RNG).
 *   - Policy values shown in the UI are the exact values that will be
 *     installed on-chain — no UI/on-chain divergence.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi';
import {
  type Account,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { UNISWAP_V3_ADDRESSES } from '@liqai/uniswap';
import { useIsMounted } from '../lib/useIsMounted';
import { useKernelAccount } from '../lib/useKernelAccount';
import {
  buildRebalancePermissionValidator,
  generateSessionKeyAccount,
  MAX_REBALANCES_PER_DAY,
  REBALANCE_SESSION_VALID_SECONDS,
  type SessionKeyPolicyMeta,
} from '../lib/sessionKeyPolicy';
import { installSessionKey, revokeSessionKey } from '../lib/sessionKeyInstall';
import {
  evaluatePassphrase,
  MIN_PASSPHRASE_ENTROPY_BITS,
} from '../lib/passphraseStrength';
import { getDb, getSmartAccountByOwner } from '../lib/db';
import { SESSION_KEY_EXPIRY_WARNING_SECONDS } from '../lib/useRebalanceBot';

const MAINNET_ID = 1;

interface DraftSessionKey {
  readonly address: Address;
  readonly privateKey: Hex;
  readonly meta: SessionKeyPolicyMeta;
  readonly validatorOk: boolean;
}

interface InstalledKeyRow {
  readonly id: number;
  readonly session_key_address: Address;
  readonly valid_after: number;
  readonly valid_until: number;
  readonly max_executions_per_24h: number;
  readonly created_at: number;
  readonly revoked_at: number | null;
}

export function SessionKeyPanel() {
  const mounted = useIsMounted();
  const { address: eoaAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { isDeployed: saDeployed, address: saAddress } = useKernelAccount();

  const [draft, setDraft] = useState<DraftSessionKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<InstalledKeyRow[]>([]);
  const [passphraseOpen, setPassphraseOpen] = useState(false);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<number | null>(null);

  // Preview the policy's static parameters. The dynamic field (recipient
  // pinned to the user's SA) is shown elsewhere when the SA is known.
  const previewNpmAddress = UNISWAP_V3_ADDRESSES[MAINNET_ID].nonfungiblePositionManager as Address;

  const refreshInstalled = useCallback(async () => {
    if (!eoaAddress || chainId !== MAINNET_ID) return;
    try {
      const sa = await getSmartAccountByOwner(chainId, eoaAddress);
      if (!sa) {
        setInstalled([]);
        return;
      }
      const db = await getDb();
      const rows = (await db.select(
        `SELECT id, session_key_address, valid_after, valid_until,
                max_executions_per_24h, created_at, revoked_at
           FROM session_keys
          WHERE smart_account_id = $1
          ORDER BY created_at DESC`,
        [sa.id],
      )) as InstalledKeyRow[];
      setInstalled(rows);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[LiqAI] session_keys load failed:', err);
    }
  }, [eoaAddress, chainId]);

  useEffect(() => {
    if (!mounted) return;
    refreshInstalled();
    const handle = setInterval(refreshInstalled, 10_000);
    return () => clearInterval(handle);
  }, [mounted, refreshInstalled]);

  const handleInstall = useCallback(
    async (passphrase: string) => {
      if (!draft || !publicClient || !walletClient || !walletClient.account || !eoaAddress || !saAddress) {
        setError('Wallet or Smart Account client not ready');
        return;
      }
      if (!saDeployed) {
        setError('Smart Account is not deployed yet — mint a position first');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const sa = await getSmartAccountByOwner(MAINNET_ID, eoaAddress);
        if (!sa) {
          throw new Error(
            'Smart Account row not found in local DB — mint a position first to register it',
          );
        }
        const { privateKeyToAccount } = await import('viem/accounts');
        const account = privateKeyToAccount(draft.privateKey);
        await installSessionKey({
          publicClient: publicClient as PublicClient,
          walletClient: walletClient as WalletClient<Transport, Chain, Account>,
          sessionKeyAccount: account,
          sessionKeyPrivateKey: draft.privateKey,
          passphrase,
          smartAccountId: sa.id,
          eoaAddress: eoaAddress as Address,
          smartAccountAddress: saAddress,
        });
        setDraft(null);
        setPassphraseOpen(false);
        await refreshInstalled();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error('[LiqAI] session key install failed:', err);
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [draft, publicClient, walletClient, eoaAddress, saAddress, saDeployed, refreshInstalled],
  );

  const handleRevoke = useCallback(
    async (row: InstalledKeyRow) => {
      // Tauri's WebView blocks native window.confirm(), so we use a
      // two-click inline confirmation instead: first click arms, second
      // click commits. The caller has already confirmed by the time we
      // reach this handler.
      if (!eoaAddress) return;
      try {
        const db = await getDb();
        await revokeSessionKey({
          db,
          sessionKeyDbId: row.id,
          eoaAddress: eoaAddress as Address,
          sessionKeyAddress: row.session_key_address,
        });
        setConfirmingRevokeId(null);
        await refreshInstalled();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[LiqAI] revoke failed:', err);
        setError(
          `Revoke failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [eoaAddress, refreshInstalled],
  );

  const handleGenerate = useCallback(async () => {
    if (!publicClient) {
      setError('Public RPC client not ready');
      return;
    }
    if (!saAddress) {
      // Post-Q1, the SA address is baked into the on-chain policy as the
      // pinned recipient. We cannot generate a session key before the SA
      // is derived from the connected EOA.
      setError('Smart Account address not yet derived — connect wallet first');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { account, privateKey } = generateSessionKeyAccount();
      // Build the validator eagerly so we fail fast if the policies don't
      // produce valid plugin data. This hits the publicClient for plugin
      // address lookups but sends no tx.
      const { meta } = await buildRebalancePermissionValidator({
        publicClient: publicClient as unknown as Client,
        sessionKeyAccount: account,
        smartAccountAddress: saAddress,
      });
      setDraft({
        address: account.address,
        privateKey,
        meta,
        validatorOk: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // eslint-disable-next-line no-console
      console.error('[LiqAI] session key generation failed:', err);
    } finally {
      setBusy(false);
    }
  }, [publicClient, saAddress]);

  const handleClear = useCallback(() => {
    // Best-effort scrub of the private key string from React state.
    setDraft(null);
    setError(null);
  }, []);

  if (!mounted || !isConnected || chainId !== MAINNET_ID) return null;

  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 20,
        marginTop: 16,
      }}
    >
      <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 12 }}>
        Automated rebalance (session key)
      </h3>

      <Banner kind="info">
        <strong>What is a session key?</strong> A fresh ECDSA key separate from your
        main wallet, installed on your Smart Account with <em>hard-coded, on-chain
          limits</em>. A keeper network (Gelato) uses it to rebalance 24/7 without
        your involvement. Even if fully stolen, the attacker <strong>cannot</strong>{' '}
        move your funds — only trigger the exact LP-management calls below.
      </Banner>

      <h4 style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 16, marginBottom: 8 }}>
        Policy (what the key can do)
      </h4>
      <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        <Row label="Target contract" value={previewNpmAddress} mono />
        <Row label="Allowed functions" value="mint · decreaseLiquidity · collect" />
        <Row label="Value limit per call" value="0 ETH (no transfers possible)" />
        <Row
          label="Rate limit"
          value={`max ${MAX_REBALANCES_PER_DAY} executions / 24h`}
        />
        <Row
          label="Expires in"
          value={`${Math.floor(REBALANCE_SESSION_VALID_SECONDS / 86400)} days (auto)`}
        />
      </div>

      {!draft && (
        <div style={{ marginTop: 20 }}>
          <button
            onClick={handleGenerate}
            disabled={busy}
            style={primaryButtonStyle(busy)}
          >
            {busy ? 'Generating…' : 'Generate session key'}
          </button>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8 }}>
            This creates a fresh ECDSA key locally. Nothing is sent on-chain until you
            click "Install on Smart Account" below.
          </p>
        </div>
      )}

      {draft && (
        <div
          style={{
            marginTop: 20,
            padding: 16,
            background: 'var(--bg-elevated)',
            borderRadius: 8,
            border: '1px solid var(--border)',
          }}
        >
          <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            Generated session key (in memory)
          </h4>
          <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
            <Row label="Key address" value={draft.address} mono />
            <Row
              label="Valid from"
              value={new Date(draft.meta.validAfter * 1000).toLocaleString()}
            />
            <Row
              label="Valid until"
              value={new Date(draft.meta.validUntil * 1000).toLocaleString()}
            />
          </div>

          <Banner kind="warn">
            <strong>⚠ Not yet persisted.</strong> This key lives in memory only. Click
            <em>Install on Smart Account</em> to persist it (encrypted with your
            passphrase via AES-GCM) and authorise it on-chain via an off-chain
            signature from your wallet.
          </Banner>

          {!saDeployed && (
            <Banner kind="warn">
              Your Smart Account is not deployed yet. Session-key installation
              requires a deployed SA (deployment happens automatically with your
              first mint — see the AI-managed LP position panel above).
            </Banner>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={handleClear} style={secondaryButtonStyle}>
              Discard
            </button>
            <button
              onClick={() => setPassphraseOpen(true)}
              disabled={!saDeployed || busy}
              title={!saDeployed ? 'Requires deployed Smart Account' : 'Install + persist'}
              style={primaryButtonStyle(!saDeployed || busy)}
            >
              {busy ? 'Installing…' : 'Install on Smart Account'}
            </button>
          </div>
        </div>
      )}

      {installed.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h4 style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
            Installed session keys
          </h4>
          <div style={{ display: 'grid', gap: 10 }}>
            {installed.map((row) => {
              const nowSec = Date.now() / 1000;
              const isExpired = nowSec > row.valid_until;
              const isRevoked = row.revoked_at !== null;
              const isExpiringSoon =
                !isExpired &&
                !isRevoked &&
                row.valid_until - nowSec < SESSION_KEY_EXPIRY_WARNING_SECONDS;
              const status = isRevoked ? 'revoked' : isExpired ? 'expired' : 'active';
              const secondsToExpiry = Math.max(0, row.valid_until - nowSec);
              const daysToExpiry = Math.floor(secondsToExpiry / 86400);
              return (
                <div
                  key={row.id}
                  style={{
                    padding: 12,
                    background: 'var(--bg-elevated)',
                    border: `1px solid ${isExpiringSoon ? 'rgba(251,191,36,0.5)' : 'var(--border)'}`,
                    borderRadius: 8,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <code style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: "'SF Mono', Menlo, Consolas, monospace", wordBreak: 'break-all' }}>
                      {row.session_key_address}
                    </code>
                    <StatusBadge status={status} />
                  </div>
                  {isExpiringSoon && (
                    <Banner kind="warn">
                      <strong>⚠ Expires in {daysToExpiry} day{daysToExpiry === 1 ? '' : 's'}.</strong>{' '}
                      Generate and install a replacement session key before this one
                      expires to keep automation running without interruption. Once a
                      key expires the local bot stops itself automatically.
                    </Banner>
                  )}
                  <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    <Row label="Installed" value={new Date(row.created_at * 1000).toLocaleString()} />
                    <Row label="Expires" value={new Date(row.valid_until * 1000).toLocaleString()} />
                    <Row label="Rate limit" value={`${row.max_executions_per_24h}/24h`} />
                  </div>
                  {!isRevoked && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10, alignItems: 'center' }}>
                      {confirmingRevokeId === row.id ? (
                        <>
                          <span style={{ fontSize: 11, color: 'var(--danger)', marginRight: 4 }}>
                            Delete encrypted key material from local storage?
                          </span>
                          <button
                            onClick={() => setConfirmingRevokeId(null)}
                            style={{
                              padding: '6px 12px',
                              background: 'transparent',
                              color: 'var(--text-secondary)',
                              border: '1px solid var(--border)',
                              borderRadius: 6,
                              fontSize: 12,
                              cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleRevoke(row)}
                            style={{
                              padding: '6px 12px',
                              background: 'var(--danger)',
                              color: '#0b0d12',
                              border: 'none',
                              borderRadius: 6,
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            Confirm revoke
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setConfirmingRevokeId(row.id)}
                          style={{
                            padding: '6px 12px',
                            background: 'var(--danger)',
                            color: '#0b0d12',
                            border: 'none',
                            borderRadius: 6,
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {passphraseOpen && draft && (
        <PassphraseModal
          onCancel={() => setPassphraseOpen(false)}
          onConfirm={handleInstall}
          busy={busy}
        />
      )}

      {error && (
        <Banner kind="error">
          <strong>Generation failed:</strong> {error}
        </Banner>
      )}

      {saAddress && (
        <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 16 }}>
          Install target: <code>{saAddress}</code> ·{' '}
          {saDeployed ? 'deployed ✓' : 'counterfactual (not deployed yet)'}
        </p>
      )}
    </section>
  );
}

// — visual primitives —

function PassphraseModal({
  onCancel,
  onConfirm,
  busy,
}: {
  onCancel: () => void;
  onConfirm: (passphrase: string) => void;
  busy: boolean;
}) {
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  // Phase 4.3: real-time entropy evaluation. Memoised so typing each
  // character doesn't re-initialise the zxcvbn dictionaries.
  const strength = useMemo(
    () => (pass1.length > 0 ? evaluatePassphrase(pass1) : null),
    [pass1],
  );

  const submit = () => {
    setLocalError(null);
    if (!strength || !strength.ok) {
      setLocalError(
        strength
          ? `${strength.message}${strength.suggestion ? ' ' + strength.suggestion : ''}`
          : 'Enter a passphrase.',
      );
      return;
    }
    if (pass1 !== pass2) {
      setLocalError('Passphrases do not match');
      return;
    }
    onConfirm(pass1);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={busy ? undefined : onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.6)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: 28,
          maxWidth: 460,
          width: '90%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
          Set passphrase to encrypt session key
        </h2>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
          Your session key&apos;s private material will be AES-GCM encrypted with a key
          derived from this passphrase (PBKDF2, 200k iterations). You&apos;ll need to
          enter it again whenever the local rebalance bot starts. Forgetting it means
          you must regenerate the session key — your funds remain safe regardless.
        </p>

        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
          Passphrase (≥ {MIN_PASSPHRASE_ENTROPY_BITS} bits entropy — try diceware 5 words or 12+ mixed chars)
        </label>
        <input
          type="password"
          value={pass1}
          onChange={(e) => {
            setPass1(e.target.value);
            setLocalError(null);
          }}
          disabled={busy}
          style={inputStyle}
          autoFocus
        />
        {strength && <StrengthMeter strength={strength} />}
        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', margin: '12px 0 4px' }}>
          Confirm passphrase
        </label>
        <input
          type="password"
          value={pass2}
          onChange={(e) => {
            setPass2(e.target.value);
            setLocalError(null);
          }}
          disabled={busy}
          style={inputStyle}
        />
        {localError && (
          <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{localError}</p>
        )}

        <Banner kind="info">
          After clicking <strong>Confirm</strong>, your wallet will pop up requesting an
          off-chain signature (no gas) authorising the session key. This is the only
          on-wallet step.
        </Banner>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onCancel} disabled={busy} style={secondaryButtonStyle}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy} style={primaryButtonStyle(busy)}>
            {busy ? 'Encrypting + signing…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StrengthMeter({
  strength,
}: {
  strength: ReturnType<typeof evaluatePassphrase>;
}) {
  // 5 discrete bars. Colour ladders from danger → warning → accent.
  const bars = 5;
  const filled = strength.ok
    ? bars
    : strength.label === 'fair'
    ? 3
    : strength.label === 'weak'
    ? 2
    : 1;
  const colourFor = (label: typeof strength.label): string =>
    label === 'excellent' || label === 'strong'
      ? 'var(--accent)'
      : label === 'fair'
      ? '#fbbf24'
      : 'var(--danger)';
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 3 }}>
        {Array.from({ length: bars }, (_, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background:
                i < filled ? colourFor(strength.label) : 'rgba(148,163,184,0.2)',
              transition: 'background 120ms ease',
            }}
          />
        ))}
      </div>
      <div
        style={{
          fontSize: 11,
          color: strength.ok ? 'var(--text-secondary)' : 'var(--danger)',
          marginTop: 4,
        }}
      >
        {strength.message}
        {strength.suggestion && (
          <span style={{ display: 'block', marginTop: 2, color: 'var(--text-secondary)' }}>
            Hint: {strength.suggestion}
          </span>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: 'active' | 'expired' | 'revoked' }) {
  const colors = {
    active: { bg: 'rgba(94,234,212,0.12)', border: 'rgba(94,234,212,0.3)', fg: 'var(--accent)' },
    expired: { bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.3)', fg: '#fbbf24' },
    revoked: { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.3)', fg: '#94a3b8' },
  }[status];
  return (
    <span
      style={{
        fontSize: 10,
        padding: '2px 8px',
        borderRadius: 999,
        background: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.border}`,
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {status}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontSize: 14,
  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  boxSizing: 'border-box',
};

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: 'var(--text-primary)',
          fontFamily: mono ? "'SF Mono', Menlo, Consolas, monospace" : 'inherit',
          wordBreak: mono ? 'break-all' : 'normal',
          textAlign: 'right',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Banner({
  children,
  kind,
}: {
  children: React.ReactNode;
  kind: 'info' | 'warn' | 'error';
}) {
  const colors = {
    info: { bg: 'rgba(96,165,250,0.08)', border: 'rgba(96,165,250,0.3)', fg: '#60a5fa' },
    warn: { bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.3)', fg: '#fbbf24' },
    error: { bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)', fg: 'var(--danger)' },
  }[kind];
  return (
    <div
      style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.fg,
        borderRadius: 8,
        padding: 12,
        fontSize: 12,
        lineHeight: 1.6,
        marginTop: 12,
      }}
    >
      {children}
    </div>
  );
}

const primaryButtonStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '10px 18px',
  background: disabled ? 'var(--bg-elevated)' : 'var(--accent)',
  color: disabled ? 'var(--text-secondary)' : '#0b0d12',
  border: 'none',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
});

const secondaryButtonStyle: React.CSSProperties = {
  padding: '10px 18px',
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  borderRadius: 8,
  fontSize: 13,
  cursor: 'pointer',
};

'use client';

/**
 * GelatoAutomatePanel — 24/7 automated-rebalance registration shell.
 *
 * Gelato Automate is a decentralised keeper network. Once the user has:
 *   1. A deployed Kernel Smart Account (from the first mint),
 *   2. An installed scoped session key (Phase B-3b),
 * this panel registers a Gelato task that periodically polls an AI
 * resolver, and when a rebalance trigger fires, uses the session key to
 * execute `decreaseLiquidity → collect → mint` on the user's SA — with
 * ZERO user involvement.
 *
 * CURRENT PHASE (B-3c shell):
 *   - Shows the exact task parameters that will be registered
 *   - Registration + cancellation UI is stubbed (disabled until session
 *     key install ships)
 *   - This makes the full automation model transparent and auditable
 *     before any transaction is constructed.
 *
 * SECURITY:
 *   - Gelato cannot exceed the session key's on-chain scope. Even a
 *     compromised Gelato executor can ONLY call NPM.decreaseLiquidity /
 *     collect / mint, and at most MAX_REBALANCES_PER_DAY times in 24h.
 *   - The task fee is paid from the SA's own ETH balance. If the SA runs
 *     out of ETH, Gelato stops calling — not a security issue, just a
 *     liveness concern the user handles by topping up.
 */

import { useAccount, useChainId } from 'wagmi';
import { useIsMounted } from '../lib/useIsMounted';
import { useKernelAccount } from '../lib/useKernelAccount';
import { MAX_REBALANCES_PER_DAY } from '../lib/sessionKeyPolicy';

const MAINNET_ID = 1;

/**
 * Gelato Automate canonical mainnet address (Ops v2.1). Fixed audited
 * contract — NOT a user input. Verified at
 * https://docs.gelato.network/developer-services/automate/contract-addresses
 */
const GELATO_AUTOMATE_MAINNET = '0x2A6C106ae13B558BB9E2Ec64Bd2f1f7BEFF3A5E0';

/** How often the keeper polls the AI resolver (and potentially rebalances). */
const DEFAULT_POLL_INTERVAL_SEC = 3 * 60 * 60; // every 3 hours

export function GelatoAutomatePanel() {
  const mounted = useIsMounted();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { isDeployed: saDeployed, address: saAddress } = useKernelAccount();

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
        24/7 automation (Gelato Automate)
      </h3>

      <Banner kind="info">
        <strong>How it works.</strong> Gelato is a public, decentralised keeper network
        (like Chainlink Automation but ERC-4337-native). Keepers call your AI resolver
        on a schedule; when a rebalance trigger fires, they use your <em>scoped
          session key</em> to execute <code>decreaseLiquidity → collect → mint</code>{' '}
        on your Smart Account. They cannot do anything else — the session-key policy
        enforces this on-chain.
      </Banner>

      <h4 style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 16, marginBottom: 8 }}>
        Task parameters (what will be registered)
      </h4>
      <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        <Row label="Gelato Automate contract" value={GELATO_AUTOMATE_MAINNET} mono />
        <Row
          label="Execution target (your SA)"
          value={saAddress ?? '(not yet derived)'}
          mono
        />
        <Row
          label="Poll interval"
          value={`every ${DEFAULT_POLL_INTERVAL_SEC / 3600}h (~${Math.floor((24 * 3600) / DEFAULT_POLL_INTERVAL_SEC)}× per day)`}
        />
        <Row
          label="Execution cap"
          value={`≤${MAX_REBALANCES_PER_DAY} real rebalances / 24h (enforced by session key)`}
        />
        <Row label="Fee currency" value="ETH from your Smart Account" />
        <Row label="Resolver" value="AI evaluator (IPFS-hosted W3F, Phase B-3d)" />
      </div>

      <Banner kind="info">
        <strong>Execution decision</strong> is made by <em>your local AI config</em>{' '}
        (published to IPFS on activation). Gelato keepers execute the decision; they
        don't make it. If you disagree with a rebalance, revoke the session key to
        stop automation instantly.
      </Banner>

      {!saDeployed && (
        <Banner kind="warn">
          Your Smart Account is not deployed yet. Gelato task registration requires
          a deployed SA with an installed session key. Both will be available after
          your first LP mint.
        </Banner>
      )}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
        <button
          disabled
          title="Ships in Phase B-3d after session-key install lands"
          style={primaryButtonStyle(true)}
        >
          Activate automation (coming in B-3d)
        </button>
      </div>
    </section>
  );
}

// — visual primitives —

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

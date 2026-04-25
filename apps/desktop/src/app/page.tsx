'use client';

/**
 * LiqAI home screen.
 *
 * Phase: Task B — wallet connection wiring.
 *
 * SECURITY:
 *   - The ConnectControl is the ONLY place that opens a wallet modal.
 *   - Nothing on this page reads or stores private keys.
 *   - All signing happens via the user's wallet, initiated only on explicit
 *     button clicks.
 *   - We bypass Reown's AppKit modal entirely (see WalletConnectQR.tsx).
 */

import { useAccount } from 'wagmi';
import { ConnectControl } from '../components/WalletConnectQR';
import { WalletStatus } from '../components/WalletStatus';
import { SmartAccountStatus } from '../components/SmartAccountStatus';
import { MintPositionPreview } from '../components/MintPositionPreview';
import { SessionKeyPanel } from '../components/SessionKeyPanel';
import { RebalanceBotPanel } from '../components/RebalanceBotPanel';
import { GelatoAutomatePanel } from '../components/GelatoAutomatePanel';
import { PositionsDashboard } from '../components/PositionsDashboard';
import { AuditRecorder } from '../components/AuditRecorder';
import { ActivityLog } from '../components/ActivityLog';
import { useIsMounted } from '../lib/useIsMounted';

function EnvDiagnostic() {
  const wcId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  const loaded = wcId && wcId !== 'liqai-dev-placeholder';
  return (
    <div
      style={{
        background: loaded ? 'rgba(94,234,212,0.08)' : 'rgba(248,113,113,0.1)',
        border: loaded
          ? '1px solid rgba(94,234,212,0.3)'
          : '1px solid rgba(248,113,113,0.3)',
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 12,
        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
        color: loaded ? 'var(--accent)' : 'var(--danger)',
        marginBottom: 16,
      }}
    >
      {loaded
        ? `✓ WalletConnect Project ID loaded (${wcId.slice(0, 6)}…${wcId.slice(-4)})`
        : '✗ WalletConnect Project ID NOT loaded — check apps/desktop/.env.local and restart npm run tauri:dev'}
    </div>
  );
}

export default function HomePage() {
  const mounted = useIsMounted();
  const { isConnected: rawIsConnected } = useAccount();
  // Treat as "not connected" until we've mounted on the client. This makes
  // the first client render match the static export (which always renders
  // as disconnected), preventing React hydration mismatches when WC restores
  // a session from localStorage.
  const isConnected = mounted && rawIsConnected;

  return (
    <main className="container">
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 40,
        }}
      >
        <div>
          <h1 style={{ fontSize: 40, fontWeight: 600, letterSpacing: '-0.02em' }}>
            LiqAI
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 6 }}>
            AI-optimised Uniswap V3 LP management. Your keys. Your funds.
          </p>
        </div>
        <ConnectControl />
      </header>

      <EnvDiagnostic />

      {!isConnected && (
        <section
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 24,
            marginBottom: 24,
          }}
        >
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>Non-custodial by design</h2>
          <ul style={{ color: 'var(--text-secondary)', paddingLeft: 20, marginBottom: 16 }}>
            <li>Your USDC never leaves your wallet and Smart Account.</li>
            <li>LiqAI holds no keys and cannot move your funds.</li>
            <li>
              Automation runs via a scope-limited session key, expires automatically,
              and can be revoked anytime in the app.
            </li>
            <li>All AI computations run on your machine; no cloud database.</li>
          </ul>
        </section>
      )}

      <AuditRecorder />

      {isConnected && <WalletStatus />}
      {isConnected && <SmartAccountStatus />}
      {isConnected && <MintPositionPreview />}
      {isConnected && <PositionsDashboard />}
      {isConnected && <SessionKeyPanel />}
      {isConnected && <RebalanceBotPanel />}
      {isConnected && <GelatoAutomatePanel />}
      {isConnected && <ActivityLog />}

      {isConnected && (
        <section
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 24,
            marginTop: 16,
          }}
        >
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>Next steps</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 12 }}>
            Wallet connection is live. The following features are implemented in the
            next phases:
          </p>
          <ul
            style={{
              color: 'var(--text-secondary)',
              paddingLeft: 20,
              fontSize: 13,
              lineHeight: 1.9,
            }}
          >
            <li>Deploy your ERC-4337 Smart Account (ZeroDev Kernel)</li>
            <li>Create an AI-managed Uniswap V3 LP position (USDC deposit → LP NFT)</li>
            <li>Grant a scope-limited session key for 24/7 automated rebalance</li>
            <li>Register the Gelato Automate task</li>
            <li>Dashboard showing positions, rebalance history, and audit log</li>
          </ul>
        </section>
      )}

      <footer
        style={{
          marginTop: 48,
          color: 'var(--text-secondary)',
          fontSize: 12,
          borderTop: '1px solid var(--border)',
          paddingTop: 16,
        }}
      >
        v0.1.0 · non-custodial · mainnet only · no server-side state
      </footer>
    </main>
  );
}

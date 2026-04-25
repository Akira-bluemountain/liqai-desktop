'use client';

/**
 * PositionsDashboard — lists every LP position the user has minted
 * through LiqAI, read from the local SQLite `lp_positions` table.
 *
 * This panel is the ground-truth view of what the user currently owns
 * inside their Smart Account. It does NOT re-derive state from the
 * chain yet (that ships in B-4b with the withdraw / fees-collected
 * overlay). For now, the data shown is what we recorded locally at
 * mint time, plus an Etherscan link to the live NFT.
 *
 * SECURITY:
 *   - Read-only. No transactions.
 *   - Token IDs are rendered as text; there's no eval / innerHTML path.
 */

import { useCallback, useEffect, useState } from 'react';
import { type Address, type PublicClient } from 'viem';
import { useAccount, useChainId, usePublicClient } from 'wagmi';
import {
  listLpPositionsForOwner,
  type LpPositionRow,
} from '../lib/db';
import { useIsMounted } from '../lib/useIsMounted';
import { useKernelAccount } from '../lib/useKernelAccount';
import { useKernelClient } from '../lib/useKernelClient';
import {
  usePositionPerformance,
  type PortfolioSummary,
  type PositionPerformance,
} from '../lib/usePositionPerformance';
import { useAprMetrics } from '../lib/useAprMetrics';
import { WithdrawConfirmModal } from './WithdrawConfirmModal';
import type { WithdrawExecutionInput } from '../lib/withdrawExecutor';

const MAINNET_ID = 1;
const REFRESH_INTERVAL_MS = 10_000;
const NPM_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

export function PositionsDashboard() {
  const mounted = useIsMounted();
  const { address: eoaAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { address: saAddress } = useKernelAccount();
  const { isReady: kernelReady, getClient } = useKernelClient();
  const [positions, setPositions] = useState<LpPositionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawInput, setWithdrawInput] = useState<WithdrawExecutionInput | null>(null);
  const performance = usePositionPerformance(positions);

  const refresh = useCallback(async () => {
    if (!eoaAddress || chainId !== MAINNET_ID) {
      setPositions([]);
      return;
    }
    try {
      const rows = await listLpPositionsForOwner(chainId, eoaAddress);
      setPositions(rows);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[LiqAI] positions load failed:', err);
      setError(msg);
    }
  }, [eoaAddress, chainId]);

  useEffect(() => {
    if (!mounted) return;
    refresh();
    const handle = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [mounted, refresh]);

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
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <h3 style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
          Your LP positions
        </h3>
        <button
          onClick={refresh}
          style={refreshButtonStyle}
          aria-label="Refresh positions"
        >
          ↻
        </button>
      </div>

      {error && (
        <Banner kind="error">Failed to load positions: {error}</Banner>
      )}

      {positions && positions.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '12px 0' }}>
          You haven&apos;t minted any AI-managed LP positions yet. Use the{' '}
          <em>AI-managed LP position</em> panel above to create one.
        </p>
      )}

      {positions &&
        positions.length > 0 &&
        performance.summary.activeCount > 0 && (
          <PortfolioSummaryCard
            summary={performance.summary}
            ethUsd={performance.ethUsd}
            isLoading={performance.isLoading}
          />
        )}

      {positions && positions.length > 0 && (
        <div style={{ display: 'grid', gap: 12 }}>
          {positions.map((p) => (
            <PositionCard
              key={p.id}
              position={p}
              performance={performance.byId[p.id]}
              canWithdraw={kernelReady && !!eoaAddress && !!saAddress}
              onWithdraw={async () => {
                if (!kernelReady || !eoaAddress || !saAddress || !publicClient) return;
                try {
                  const client = await getClient();
                  setWithdrawInput({
                    kernelClient: client,
                    publicClient: publicClient as PublicClient,
                    eoaAddress: eoaAddress as Address,
                    smartAccountAddress: saAddress,
                    lpPositionDbId: p.id,
                    tokenId: BigInt(p.lp_token_id),
                    liquidity: BigInt(p.liquidity),
                  });
                  setWithdrawOpen(true);
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error('[LiqAI] withdraw prep failed:', err);
                  alert(err instanceof Error ? err.message : String(err));
                }
              }}
            />
          ))}
        </div>
      )}

      <WithdrawConfirmModal
        open={withdrawOpen}
        input={withdrawInput}
        onClose={() => {
          setWithdrawOpen(false);
          setWithdrawInput(null);
        }}
        onSuccess={() => {
          refresh();
        }}
      />
    </section>
  );
}

function PortfolioSummaryCard({
  summary,
  ethUsd,
  isLoading,
}: {
  summary: PortfolioSummary;
  ethUsd: number | null;
  isLoading: boolean;
}) {
  return (
    <div
      style={{
        background:
          'linear-gradient(135deg, rgba(94,234,212,0.08) 0%, rgba(94,234,212,0.03) 100%)',
        border: '1px solid rgba(94,234,212,0.3)',
        borderRadius: 10,
        padding: 16,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Metric
          label="Total value"
          value={`$${summary.totalUsd.toFixed(2)}`}
          sub={`principal $${summary.totalPrincipalUsd.toFixed(2)} + fees $${summary.totalFeesUsd.toFixed(4)}`}
          emphasis
        />
        <Metric
          label="Blended APR"
          value={
            summary.blendedApr === null
              ? isLoading
                ? '…'
                : '—'
              : `${summary.blendedApr.toFixed(2)}%`
          }
          sub="from unclaimed fees, annualised"
          positive={summary.blendedApr !== null && summary.blendedApr > 0}
        />
        <Metric
          label="Active positions"
          value={`${summary.activeCount}`}
          sub={`${summary.inRangeCount} in range · ${summary.activeCount - summary.inRangeCount} out`}
        />
        <Metric
          label="ETH / USD"
          value={ethUsd !== null ? `$${ethUsd.toFixed(2)}` : '—'}
          sub="on-chain (pool slot0)"
        />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  emphasis,
  positive,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
  positive?: boolean;
}) {
  return (
    <div style={{ minWidth: 140 }}>
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: emphasis ? 22 : 18,
          fontWeight: 600,
          color: positive ? 'var(--accent)' : 'var(--text-primary)',
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--text-secondary)',
            marginTop: 2,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function PositionCard({
  position,
  performance,
  canWithdraw,
  onWithdraw,
}: {
  position: LpPositionRow;
  performance: PositionPerformance | undefined;
  canWithdraw: boolean;
  onWithdraw: () => void;
}) {
  const mintedDate = new Date(position.minted_at * 1000).toLocaleDateString();
  const feeTierPct = position.fee_tier / 10_000;
  const nftUrl = `https://etherscan.io/token/${NPM_ADDRESS}?a=${position.lp_token_id}`;
  const isClosed = position.status === 'closed';
  const { metrics: apr } = useAprMetrics({
    position: isClosed ? null : position,
    lifetimeAprPct: performance?.apr ?? null,
    lifetimeDaysActive: performance?.daysActive ?? 0,
    positionValueUsd: performance?.totalUsd ?? 0,
  });

  return (
    <div
      style={{
        padding: 14,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <code
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-primary)',
              fontFamily: "'SF Mono', Menlo, Consolas, monospace",
            }}
          >
            #{position.lp_token_id}
          </code>
          <StatusBadge status={position.status} />
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {mintedDate}
        </span>
      </div>

      <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
        <Row label="Pool" value={`USDC/WETH ${feeTierPct}%`} />
        <Row
          label="Tick range"
          value={`[${position.tick_lower}, ${position.tick_upper}]`}
          mono
        />
        {!isClosed && performance && (
          <>
            <Row
              label="Current value"
              value={`$${performance.totalUsd.toFixed(2)} USD`}
            />
            <Row
              label="Unclaimed fees"
              value={
                performance.feesUsd > 0.005
                  ? `$${performance.feesUsd.toFixed(4)} USD`
                  : '< $0.01'
              }
            />
            <AprTriptych metrics={apr} inRange={performance.inRange} />
            <Row
              label="Range status"
              value={
                performance.isEmpty
                  ? '⚠ empty (liquidity=0) — use Withdraw to clean up'
                  : performance.inRange
                  ? '✓ in range (earning fees)'
                  : '⚠ out of range'
              }
            />
            <Row
              label="Days active"
              value={performance.daysActive.toFixed(2)}
            />
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <a
          href={nftUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={linkButtonStyle}
        >
          View NFT on Etherscan ↗
        </a>
        <button
          onClick={onWithdraw}
          disabled={!canWithdraw || isClosed}
          title={
            isClosed
              ? 'Position already closed'
              : canWithdraw
              ? 'Close this position and return USDC + WETH to your Smart Account'
              : 'Wallet or Smart Account client not ready'
          }
          style={canWithdraw && !isClosed ? withdrawButtonStyle : stubButtonStyle}
        >
          {isClosed ? 'Closed' : 'Withdraw'}
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: LpPositionRow['status'] }) {
  const colors = {
    active: { bg: 'rgba(94,234,212,0.12)', border: 'rgba(94,234,212,0.3)', fg: 'var(--accent)' },
    pending: { bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.3)', fg: '#fbbf24' },
    closed: { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.3)', fg: '#94a3b8' },
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

function AprTriptych({
  metrics,
  inRange,
}: {
  metrics: ReturnType<typeof useAprMetrics>['metrics'];
  inRange: boolean;
}) {
  // Three numbers. Each is independently displayable — if one source is
  // unavailable, the others still render. `gathering data…` for the 24h
  // realized row is expected on day 1 (needs at least 2 snapshots = ≥5 min
  // after bot start).
  const theoretical = metrics?.theoretical.aprPct ?? null;
  const realized24h = metrics?.realized24h.aprPct ?? null;
  const realizedLifetime = metrics?.realizedLifetime.aprPct ?? null;
  const observedHours = metrics?.realized24h.observedHours ?? 0;
  const snapshotCount = metrics?.realized24h.snapshotCount ?? 0;
  const sharePct = metrics?.theoretical.sharePct ?? 0;
  const poolFees24h = metrics?.theoretical.fees24hUsd ?? 0;
  const source = metrics?.theoretical.source ?? 'unavailable';

  return (
    <div
      style={{
        marginTop: 6,
        marginBottom: 6,
        padding: '8px 10px',
        background: 'rgba(94,234,212,0.04)',
        border: '1px solid rgba(94,234,212,0.18)',
        borderRadius: 6,
        display: 'grid',
        gap: 4,
      }}
    >
      <AprRow
        label="Real-time APR (theoretical)"
        value={
          source === 'unavailable'
            ? 'subgraph unavailable'
            : theoretical === null
            ? 'computing…'
            : `${theoretical.toFixed(2)}%`
        }
        sub={
          source === 'subgraph' && theoretical !== null
            ? `pool 24h fees $${poolFees24h.toLocaleString(undefined, { maximumFractionDigits: 0 })} · your share ${sharePct.toFixed(4)}%${inRange ? '' : ' (out of range — not earning)'}`
            : undefined
        }
      />
      <AprRow
        label="24h realized APR (rolling)"
        value={
          realized24h === null
            ? snapshotCount < 2
              ? `gathering data (${snapshotCount}/2 samples)`
              : 'computing…'
            : `${realized24h.toFixed(2)}%`
        }
        sub={
          realized24h !== null
            ? `observed ${observedHours.toFixed(1)}h · ${snapshotCount} samples`
            : undefined
        }
      />
      <AprRow
        label="Lifetime APR (since mint)"
        value={
          realizedLifetime === null
            ? 'gathering data…'
            : `${realizedLifetime.toFixed(2)}%`
        }
      />
    </div>
  );
}

function AprRow({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 12,
        fontSize: 12,
      }}
    >
      <span style={{ color: 'var(--text-secondary)', flex: '0 0 auto' }}>
        {label}
      </span>
      <span
        style={{
          color: 'var(--text-primary)',
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          fontWeight: 500,
          textAlign: 'right',
        }}
      >
        {value}
        {sub && (
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-secondary)',
              fontWeight: 400,
              marginTop: 1,
            }}
          >
            {sub}
          </div>
        )}
      </span>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
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

function Banner({ children, kind }: { children: React.ReactNode; kind: 'error' }) {
  const colors =
    kind === 'error'
      ? { bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)', fg: 'var(--danger)' }
      : { bg: 'transparent', border: 'transparent', fg: 'inherit' };
  return (
    <div
      style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.fg,
        borderRadius: 8,
        padding: 12,
        fontSize: 12,
        marginTop: 8,
      }}
    >
      {children}
    </div>
  );
}

const refreshButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  borderRadius: 6,
  width: 28,
  height: 28,
  cursor: 'pointer',
  fontSize: 14,
};

const linkButtonStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  borderRadius: 6,
  fontSize: 12,
  textDecoration: 'none',
};

const stubButtonStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  borderRadius: 6,
  fontSize: 12,
  cursor: 'not-allowed',
  opacity: 0.5,
};

const withdrawButtonStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: 'var(--danger)',
  border: 'none',
  color: '#0b0d12',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

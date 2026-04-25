'use client';

/**
 * RebalanceBotPanel — the local rebalance bot UI.
 *
 * Allows the user to:
 *   - Unlock the session key by entering their passphrase (cached in-memory only)
 *   - Start / stop the periodic AI evaluation loop
 *   - Trigger a manual rebalance right now
 *   - View the last evaluation reason and most recent rebalance result
 *
 * SECURITY:
 *   - The passphrase <input> uses type="password", autoComplete="off", and
 *     lives only in local state/ref; never logged, never persisted.
 *   - All rebalance userOps are signed by the session key (not the user's
 *     wallet), scoped on-chain by the callPolicy/rateLimit/timestamp
 *     validators installed in SessionKeyPanel. This panel never touches
 *     the main wallet.
 */

import { useCallback, useEffect, useState } from 'react';
import { formatEther } from 'viem';
import { useAccount, useChainId } from 'wagmi';
import { useIsMounted } from '../lib/useIsMounted';
import { useKernelAccount } from '../lib/useKernelAccount';
import { useRebalanceBot } from '../lib/useRebalanceBot';

const MAINNET_ID = 1;

/** SA ETH balance below which we refuse to start the bot. Each rebalance
 *  costs ~0.002 ETH at typical gas prices; 0.005 ETH gives a buffer for
 *  2-3 rebalances plus the recovery path's elevated verification gas. */
const MIN_SA_ETH_FOR_BOT_WEI = 5_000_000_000_000_000n; // 0.005 ETH
/** Threshold at which we display an amber warning but still allow the user
 *  to proceed (they may top up between now and the first rebalance). */
const LOW_SA_ETH_WARNING_WEI = 15_000_000_000_000_000n; // 0.015 ETH

export function RebalanceBotPanel() {
  const mounted = useIsMounted();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const bot = useRebalanceBot();
  const { ethBalanceWei: saEthBalanceWei } = useKernelAccount();
  const [passphraseInput, setPassphraseInput] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  // `now` ticks every second so the countdown redraws live without forcing
  // the heavy hook-level tick to fire more often than it needs to.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!bot.status.running) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [bot.status.running]);

  // Clear in-memory passphrase when the panel unmounts (user navigates away
  // or closes app, React still runs cleanup before GC).
  useEffect(() => {
    return () => bot.clearPassphrase();
    // bot.clearPassphrase is stable across renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [unlockBusy, setUnlockBusy] = useState(false);
  const handleUnlock = useCallback(async () => {
    if (passphraseInput.length < 8) {
      setManualError('Passphrase must be at least 8 characters');
      return;
    }
    setUnlockBusy(true);
    setManualError(null);
    try {
      // verifyAndSetPassphrase actually decrypts the stored ciphertext; if
      // the passphrase is wrong, it throws here (before any userOp is ever
      // attempted).
      await bot.verifyAndSetPassphrase(passphraseInput);
      setPassphraseInput(''); // clear the input after successful unlock
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setManualError(
        msg.includes('Decryption failed')
          ? 'Wrong passphrase. Use the exact passphrase you set when installing this session key.'
          : msg,
      );
    } finally {
      setUnlockBusy(false);
    }
  }, [passphraseInput, bot]);

  const handleManual = useCallback(async () => {
    setManualBusy(true);
    setManualError(null);
    try {
      await bot.triggerManual();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setManualError(msg);
    } finally {
      setManualBusy(false);
    }
  }, [bot]);

  if (!mounted || !isConnected || chainId !== MAINNET_ID) return null;

  const { status } = bot;

  const saEthBelowMin =
    saEthBalanceWei !== null && saEthBalanceWei < MIN_SA_ETH_FOR_BOT_WEI;
  const saEthLowWarn =
    saEthBalanceWei !== null &&
    saEthBalanceWei < LOW_SA_ETH_WARNING_WEI &&
    !saEthBelowMin;

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
          Rebalance bot (local)
        </h3>
        <StatusDot
          running={status.running}
          evaluating={status.evaluating}
          executing={status.executing}
        />
      </div>

      <Banner kind="info">
        This bot runs on <em>your machine</em> while the app is open. It reads
        ETH/USD from CoinGecko, evaluates the AI rebalance conditions every 5
        minutes, and — if triggered — closes + re-opens your LP position at the
        new AI range using your installed session key. No third-party keeper
        involved.
      </Banner>

      {status.running && (
        <RunningStatsBar status={status} now={now} />
      )}

      <div style={{ display: 'grid', gap: 6, fontSize: 13, marginTop: 16 }}>
        <Row
          label="Active LP position"
          value={
            status.activePosition
              ? `#${status.activePosition.lp_token_id} ` +
                `[${status.activePosition.tick_lower}, ${status.activePosition.tick_upper}]`
              : '—'
          }
          mono={!!status.activePosition}
        />
        <Row
          label="Session key"
          value={
            status.sessionKey
              ? `${status.sessionKey.sessionKeyAddress.slice(0, 8)}… (expires ${new Date(
                  status.sessionKey.validUntil * 1000,
                ).toLocaleDateString()})`
              : '— (install one in the panel above)'
          }
          mono={!!status.sessionKey}
        />
        <Row
          label="Passphrase"
          value={bot.hasPassphrase ? '✓ unlocked (in memory)' : '— locked'}
        />
        <Row
          label="Last evaluation"
          value={
            status.lastEvalAt
              ? new Date(status.lastEvalAt).toLocaleTimeString()
              : '—'
          }
        />
      </div>

      {status.lastEvalReason && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            background: 'var(--bg-elevated)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--text-secondary)',
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          }}
        >
          {status.lastEvalReason}
        </div>
      )}

      {status.history.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h4 style={subHeadStyle}>Recent evaluations</h4>
          <div
            style={{
              display: 'grid',
              gap: 4,
              fontSize: 11,
              maxHeight: 200,
              overflowY: 'auto',
            }}
          >
            {status.history.map((h, i) => (
              <HistoryRow key={`${h.at}-${i}`} entry={h} />
            ))}
          </div>
        </div>
      )}

      {status.error && (
        <Banner kind="error">Bot error: {status.error}</Banner>
      )}

      {saEthBelowMin && (
        <Banner kind="error">
          <strong>Smart Account is out of gas ETH.</strong> Current balance:{' '}
          {formatEther(saEthBalanceWei!).slice(0, 8)} ETH. The bot needs at least
          0.005 ETH in the SA to cover rebalance userOps; without it rebalances
          will silently fail partway through. Top up the SA from the funding
          panel before starting the bot.
        </Banner>
      )}
      {saEthLowWarn && (
        <Banner kind="warn">
          <strong>Low SA gas balance.</strong>{' '}
          {formatEther(saEthBalanceWei!).slice(0, 8)} ETH — enough for ~2
          rebalances at current gas prices. Top up soon to avoid interruption.
        </Banner>
      )}

      {/* Unlock form */}
      {!bot.hasPassphrase && status.hasSessionKey && (
        <div style={{ marginTop: 16 }}>
          <h4 style={subHeadStyle}>Unlock session key</h4>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="password"
              autoComplete="off"
              placeholder="Passphrase (≥ 8 chars)"
              value={passphraseInput}
              onChange={(e) => setPassphraseInput(e.target.value)}
              style={inputStyle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleUnlock();
              }}
            />
            <button
              onClick={handleUnlock}
              disabled={passphraseInput.length < 8 || unlockBusy}
              style={primaryButtonStyle(passphraseInput.length < 8 || unlockBusy)}
            >
              {unlockBusy ? 'Verifying…' : 'Unlock'}
            </button>
          </div>
          <p style={mutedNoteStyle}>
            The passphrase is the one you set when installing the session key.
            It stays in memory only — we never store it on disk. Clear by
            clicking <em>Stop</em>.
          </p>
        </div>
      )}

      {/* Control buttons */}
      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        {!status.running && (
          <button
            onClick={bot.start}
            disabled={!status.canExecute || saEthBelowMin}
            title={
              saEthBelowMin
                ? 'Smart Account has < 0.005 ETH for gas — top up first'
                : status.canExecute
                ? 'Start periodic AI evaluation every 5 minutes'
                : 'Need: active position + session key + unlocked passphrase'
            }
            style={primaryButtonStyle(!status.canExecute || saEthBelowMin)}
          >
            Start bot
          </button>
        )}
        {status.running && (
          <button
            onClick={bot.stop}
            style={dangerButtonStyle}
          >
            Stop bot
          </button>
        )}
        <button
          onClick={handleManual}
          disabled={!status.canExecute || manualBusy || status.executing}
          title={
            status.canExecute
              ? 'Skip the AI gate and rebalance to the current AI range immediately'
              : 'Need: active position + session key + unlocked passphrase'
          }
          style={secondaryButtonStyle(
            !status.canExecute || manualBusy || status.executing,
          )}
        >
          {manualBusy || status.executing ? 'Rebalancing…' : 'Rebalance now'}
        </button>
        {bot.hasPassphrase && !status.running && (
          <button
            onClick={() => bot.clearPassphrase()}
            style={secondaryButtonStyle(false)}
            title="Forget the cached passphrase (forces re-unlock)"
          >
            Forget passphrase
          </button>
        )}
      </div>

      {manualError && <Banner kind="error">Manual trigger failed: {manualError}</Banner>}

      {status.lastResult && (
        <div style={{ marginTop: 16 }}>
          <h4 style={subHeadStyle}>Last rebalance</h4>
          <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <Row
              label="New tokenId"
              value={`#${status.lastResult.newTokenId.toString()}`}
              mono
            />
            <Row
              label="Tx"
              value={
                <a
                  href={`https://etherscan.io/tx/${status.lastResult.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent)' }}
                >
                  {status.lastResult.txHash.slice(0, 10)}…{status.lastResult.txHash.slice(-6)} ↗
                </a>
              }
            />
          </div>
        </div>
      )}
    </section>
  );
}

function StatusDot({
  running,
  evaluating,
  executing,
}: {
  running: boolean;
  evaluating: boolean;
  executing: boolean;
}) {
  // Priority: executing (rebalance in flight) > evaluating (tick running) >
  // running (idle between ticks) > stopped.
  const { color, label } = executing
    ? { color: '#f87171', label: 'rebalancing' }
    : evaluating
    ? { color: '#fbbf24', label: 'evaluating' }
    : running
    ? { color: 'var(--accent)', label: 'running' }
    : { color: '#94a3b8', label: 'stopped' };
  const live = running || evaluating || executing;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: color,
          boxShadow: live ? `0 0 8px ${color}` : undefined,
          animation: evaluating || executing ? 'pulse 1.2s infinite' : undefined,
        }}
      />
      <span
        style={{
          fontSize: 10,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

function HistoryRow({
  entry,
}: {
  entry: ReturnType<typeof useRebalanceBot>['status']['history'][number];
}) {
  const t = new Date(entry.at).toLocaleTimeString();
  const color =
    entry.outcome === 'triggered'
      ? '#fbbf24'
      : entry.outcome === 'error'
      ? 'var(--danger)'
      : entry.outcome === 'idle'
      ? '#94a3b8'
      : 'var(--accent)';
  const iconChar =
    entry.outcome === 'triggered'
      ? '⚡'
      : entry.outcome === 'error'
      ? '✗'
      : entry.outcome === 'idle'
      ? '·'
      : '✓';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto auto 1fr',
        gap: 8,
        alignItems: 'baseline',
        padding: '4px 8px',
        background: 'var(--bg-elevated)',
        borderRadius: 4,
        borderLeft: `2px solid ${color}`,
      }}
    >
      <span
        style={{
          color,
          fontWeight: 600,
          width: 14,
          textAlign: 'center',
        }}
      >
        {iconChar}
      </span>
      <span
        style={{
          color: 'var(--text-secondary)',
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          whiteSpace: 'nowrap',
        }}
      >
        {t}
      </span>
      <span
        style={{
          color: 'var(--text-primary)',
          lineHeight: 1.4,
        }}
      >
        {entry.reason}
      </span>
    </div>
  );
}

function RunningStatsBar({
  status,
  now,
}: {
  status: ReturnType<typeof useRebalanceBot>['status'];
  now: number;
}) {
  const secondsUntilNext =
    status.nextEvalAt && status.nextEvalAt > now
      ? Math.max(0, Math.round((status.nextEvalAt - now) / 1000))
      : 0;
  const mmss = (s: number) => {
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}:${ss.toString().padStart(2, '0')}`;
  };
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
        gap: 12,
        marginTop: 12,
        padding: 12,
        background:
          'linear-gradient(135deg, rgba(94,234,212,0.05), rgba(94,234,212,0.02))',
        border: '1px solid rgba(94,234,212,0.25)',
        borderRadius: 8,
      }}
    >
      <StatChip
        label="Next check"
        value={
          status.evaluating
            ? 'checking now…'
            : secondsUntilNext > 0
            ? `in ${mmss(secondsUntilNext)}`
            : 'due'
        }
      />
      <StatChip
        label="Evaluations"
        value={`${status.evalCount}`}
        sub="since Start"
      />
      <StatChip
        label="Rebalances"
        value={`${status.rebalanceCount}`}
        sub={`limit 10/24h on-chain`}
      />
      <StatChip
        label="Interval"
        value={`${Math.round(status.tickIntervalMs / 60_000)} min`}
        sub="AI eval cadence"
      />
    </div>
  );
}

function StatChip({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--text-primary)',
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 1 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        alignItems: 'center',
      }}
    >
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span
        style={{
          color: 'var(--text-primary)',
          fontFamily: mono ? "'SF Mono', Menlo, Consolas, monospace" : 'inherit',
          textAlign: 'right',
          wordBreak: mono ? 'break-all' : 'normal',
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
  const colors =
    kind === 'error'
      ? {
          bg: 'rgba(248,113,113,0.1)',
          border: 'rgba(248,113,113,0.3)',
          fg: 'var(--danger)',
        }
      : kind === 'warn'
      ? {
          bg: 'rgba(251,191,36,0.08)',
          border: 'rgba(251,191,36,0.3)',
          fg: '#fbbf24',
        }
      : {
          bg: 'rgba(94,234,212,0.05)',
          border: 'rgba(94,234,212,0.2)',
          fg: 'var(--text-primary)',
        };
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
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

const subHeadStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 8,
};

const mutedNoteStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-secondary)',
  marginTop: 6,
  lineHeight: 1.5,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 10px',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 13,
  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
};

const primaryButtonStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  background: disabled ? 'var(--bg-elevated)' : 'var(--accent)',
  color: disabled ? 'var(--text-secondary)' : '#0b0d12',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
});

const secondaryButtonStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  background: 'transparent',
  color: disabled ? 'var(--text-secondary)' : 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 13,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
});

const dangerButtonStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--danger)',
  color: '#0b0d12',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

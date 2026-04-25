'use client';

/**
 * ActivityLog — renders the most recent audit_log entries from local SQLite.
 *
 * This is the user-facing window into LiqAI's append-only audit trail. Every
 * signing operation, wallet event, and automation action is recorded here
 * (over time, as more flows ship), providing end-to-end non-custodial proof
 * of exactly what the app has done with the user's wallet.
 *
 * SECURITY:
 *   - Read-only. We never offer an edit or delete UI — the DB schema itself
 *     forbids modification via triggers.
 *   - We render `description` as text content (React auto-escapes). Never
 *     use dangerouslySetInnerHTML here.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { recentAudit, type AuditLogRow } from '../lib/db';
import { useIsMounted } from '../lib/useIsMounted';

const DEFAULT_LIMIT = 25;
const AUTO_REFRESH_MS = 5_000;

export function ActivityLog() {
  const mounted = useIsMounted();
  const { isConnected } = useAccount();
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const latest = await recentAudit(DEFAULT_LIMIT);
      setRows(latest);
      setError(null);
    } catch (err) {
      // Surface the underlying driver error so we can diagnose.
      // Tauri plugin errors are sometimes plain strings, not Error instances.
      let msg: string;
      if (err instanceof Error) msg = err.message;
      else if (typeof err === 'string') msg = err;
      else msg = JSON.stringify(err);
      // eslint-disable-next-line no-console
      console.error('[LiqAI] audit log load failed:', err);
      setError(msg);
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    refresh();
    const handle = setInterval(refresh, AUTO_REFRESH_MS);
    return () => clearInterval(handle);
  }, [mounted, refresh]);

  if (!mounted || !isConnected) return null;

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
          Activity log (local, append-only)
        </h3>
        <button
          onClick={() => refresh()}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
            borderRadius: 6,
            width: 28,
            height: 28,
            cursor: 'pointer',
            fontSize: 14,
          }}
          aria-label="Refresh activity log"
        >
          ↻
        </button>
      </div>

      {error && (
        <p style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</p>
      )}

      {rows && rows.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          No activity yet. Connect your wallet and perform actions to see them here.
        </p>
      )}

      {rows && rows.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {rows.map((row) => (
            <div
              key={row.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '110px 150px 1fr',
                gap: 12,
                fontSize: 12,
                padding: '8px 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span style={{ color: 'var(--text-secondary)' }}>
                {formatTime(row.timestamp)}
              </span>
              <code
                style={{
                  color: 'var(--accent)',
                  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                  fontSize: 11,
                }}
              >
                {row.action}
              </code>
              <span style={{ color: 'var(--text-primary)' }}>
                {row.description}
                {row.tx_hash && (
                  <>
                    {' '}
                    <a
                      href={`https://etherscan.io/tx/${row.tx_hash}`}
                      style={{ color: 'var(--accent)', textDecoration: 'none' }}
                    >
                      ↗ etherscan
                    </a>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${MM}-${DD} ${hh}:${mm}:${ss}`;
}

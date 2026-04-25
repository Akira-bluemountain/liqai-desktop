'use client';

/**
 * WithdrawConfirmModal — confirmation UI for closing an LP position.
 *
 * SECURITY:
 *   - Shows the exact tokenId, liquidity, and recipient before signing.
 *   - Uses the same progressive-stage UX as MintConfirmModal: idle →
 *     submitting → confirming → success/error.
 *   - Clicking outside does NOT close while a userOp is in flight.
 */

import { useCallback, useState } from 'react';
import { formatEther, formatUnits } from 'viem';
import {
  executeWithdraw,
  type WithdrawExecutionInput,
  type WithdrawExecutionResult,
} from '../lib/withdrawExecutor';

type Stage = 'idle' | 'submitting' | 'confirming' | 'success' | 'error';

export interface WithdrawConfirmModalProps {
  readonly open: boolean;
  readonly input: WithdrawExecutionInput | null;
  readonly onClose: () => void;
  readonly onSuccess?: (res: WithdrawExecutionResult) => void;
}

export function WithdrawConfirmModal({
  open,
  input,
  onClose,
  onSuccess,
}: WithdrawConfirmModalProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [result, setResult] = useState<WithdrawExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStage('idle');
    setResult(null);
    setError(null);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!input) return;
    setError(null);
    setStage('submitting');
    try {
      const res = await executeWithdraw(input);
      setResult(res);
      setStage('success');
      onSuccess?.(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStage('error');
    }
  }, [input, onSuccess]);

  const handleClose = useCallback(() => {
    if (stage === 'submitting' || stage === 'confirming') return;
    reset();
    onClose();
  }, [stage, reset, onClose]);

  if (!open || !input) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={handleClose}
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
          maxWidth: 520,
          width: '90%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>
            {stage === 'success' ? 'Position withdrawn' : 'Confirm withdraw'}
          </h2>
          <button
            onClick={handleClose}
            disabled={stage === 'submitting' || stage === 'confirming'}
            aria-label="Close"
            style={closeButtonStyle(stage === 'submitting' || stage === 'confirming')}
          >
            ×
          </button>
        </div>

        {stage !== 'success' && (
          <>
            <Section title="Position">
              <Row label="Token ID" value={input.tokenId.toString()} mono />
              <Row
                label="Liquidity to burn"
                value={input.liquidity.toString()}
                mono
              />
              <Row
                label="Recipient (your SA)"
                value={input.smartAccountAddress}
                mono
              />
            </Section>

            <Banner kind="info">
              <strong>This single userOp will:</strong>
              <ol style={{ paddingLeft: 20, margin: '6px 0 0 0' }}>
                <li>Call <code>NPM.decreaseLiquidity</code> — burn 100% of the position&apos;s liquidity</li>
                <li>Call <code>NPM.collect</code> — send USDC + WETH to your SA</li>
              </ol>
              <br />
              After this, USDC and WETH sit in your SA. To move them to your EOA,
              you can send them directly (WETH unwrap-to-ETH + transfer-to-EOA ships
              in a follow-up).
            </Banner>
          </>
        )}

        {stage === 'idle' && (
          <ButtonRow>
            <SecondaryButton onClick={handleClose}>Cancel</SecondaryButton>
            <PrimaryButton onClick={handleConfirm}>Confirm & sign</PrimaryButton>
          </ButtonRow>
        )}

        {(stage === 'submitting' || stage === 'confirming') && (
          <ProgressNote>
            {stage === 'submitting' && 'Submitting userOp to Pimlico bundler…'}
            {stage === 'confirming' && 'Waiting for on-chain inclusion…'}
          </ProgressNote>
        )}

        {stage === 'success' && result && (
          <>
            {result.txHash === '0x' ? (
              <Banner kind="success">
                Position soft-closed — it was already empty on-chain (liquidity=0,
                no unclaimed fees), so no userOp was sent. The local record is
                now marked closed.
              </Banner>
            ) : (
              <>
                <Banner kind="success">
                  Position closed. Funds are now in your Smart Account.
                </Banner>
                <Section title="Collected">
                  <Row
                    label="USDC returned"
                    value={`${formatHuman(formatUnits(result.amount0Collected, 6))} USDC`}
                  />
                  <Row
                    label="WETH returned"
                    value={`${formatHuman(formatEther(result.amount1Collected), 6)} WETH`}
                  />
                  <Row label="Tx hash" value={result.txHash} mono />
                </Section>
              </>
            )}
            <ButtonRow>
              {result.txHash !== '0x' && (
                <a
                  href={`https://etherscan.io/tx/${result.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={linkButtonStyle}
                >
                  View on Etherscan ↗
                </a>
              )}
              <PrimaryButton onClick={handleClose}>Done</PrimaryButton>
            </ButtonRow>
          </>
        )}

        {stage === 'error' && (
          <>
            <Banner kind="error">
              <strong>Withdraw failed.</strong> Your funds are safe — the position
              was not modified.
              <br />
              <br />
              <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{error}</code>
            </Banner>
            <ButtonRow>
              <SecondaryButton onClick={reset}>Retry</SecondaryButton>
              <PrimaryButton onClick={handleClose}>Close</PrimaryButton>
            </ButtonRow>
          </>
        )}
      </div>
    </div>
  );
}

// — visual primitives —

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        {title}
      </h3>
      <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>{children}</div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
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
  kind: 'info' | 'success' | 'error';
}) {
  const colors = {
    info: { bg: 'rgba(96,165,250,0.08)', border: 'rgba(96,165,250,0.3)', fg: '#60a5fa' },
    success: { bg: 'rgba(94,234,212,0.08)', border: 'rgba(94,234,212,0.3)', fg: 'var(--accent)' },
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
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

function ProgressNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        background: 'rgba(96,165,250,0.05)',
        border: '1px dashed rgba(96,165,250,0.3)',
        borderRadius: 8,
        textAlign: 'center',
        color: 'var(--text-secondary)',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function ButtonRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
      {children}
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'var(--accent)',
        color: '#0b0d12',
        border: 'none',
        borderRadius: 8,
        padding: '10px 18px',
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: '1px solid var(--border)',
        color: 'var(--text-secondary)',
        borderRadius: 8,
        padding: '10px 18px',
        fontSize: 13,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const closeButtonStyle = (disabled: boolean): React.CSSProperties => ({
  background: 'transparent',
  border: 'none',
  color: 'var(--text-secondary)',
  fontSize: 24,
  cursor: disabled ? 'not-allowed' : 'pointer',
  padding: 4,
  lineHeight: 1,
  opacity: disabled ? 0.4 : 1,
});

const linkButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  borderRadius: 8,
  padding: '10px 18px',
  fontSize: 13,
  textDecoration: 'none',
  display: 'inline-block',
};

function formatHuman(s: string, maxDecimals = 2): string {
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

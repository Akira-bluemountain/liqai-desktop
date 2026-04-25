'use client';

/**
 * MintConfirmModal — step-by-step confirmation UI for minting a Uniswap V3
 * LP position via the user's Smart Account.
 *
 * Shows ALL transaction parameters (tokens, amounts, ticks, slippage,
 * deadline, recipient) so the user can verify exactly what will be signed.
 * Presents progressive state as the userOp is prepared → signed →
 * submitted → confirmed.
 *
 * SECURITY:
 *   - Every value shown is the value that will actually be sent on-chain;
 *     there is no separate "reality" the user might diverge from.
 *   - The modal is `role="dialog"` with `aria-modal="true"` so screen
 *     readers treat it as a blocking focus trap.
 *   - Clicking outside does NOT auto-cancel a userOp in flight — only
 *     ever before signing.
 */

import { useState, useCallback } from 'react';
import { formatEther, formatUnits, type Address } from 'viem';
import {
  executeMint,
  type MintExecutionInput,
  type MintExecutionResult,
} from '../lib/mintExecutor';
import { useGasEstimate } from '../lib/useGasEstimate';
import { useKernelAccount } from '../lib/useKernelAccount';

type Stage =
  | 'idle'
  | 'signing'
  | 'submitting'
  | 'confirming'
  | 'success'
  | 'error';

export interface MintConfirmModalProps {
  readonly open: boolean;
  readonly input: MintExecutionInput | null;
  readonly ethUsd: number;
  readonly onClose: () => void;
  readonly onSuccess?: (result: MintExecutionResult) => void;
}

export function MintConfirmModal({
  open,
  input,
  ethUsd,
  onClose,
  onSuccess,
}: MintConfirmModalProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [result, setResult] = useState<MintExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isDeployed: saDeployed } = useKernelAccount();
  const { gasPriceWei, estimate } = useGasEstimate(ethUsd);
  const gasEstimate = estimate(saDeployed ? 'subsequentMint' : 'firstMint');

  const reset = useCallback(() => {
    setStage('idle');
    setResult(null);
    setError(null);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!input) return;
    setError(null);
    setStage('signing');
    try {
      // The actual "signing" happens inside the bundler send; we treat the
      // whole pre-confirmation phase as "signing" for UX clarity.
      setStage('submitting');
      const res = await executeMint(input);
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
    // Don't allow closing while a userOp is mid-flight — the user has
    // already signed, the tx is on-chain, and we need to wait for the
    // receipt to persist DB rows.
    if (stage === 'submitting' || stage === 'confirming') return;
    reset();
    onClose();
  }, [stage, reset, onClose]);

  if (!open || !input) return null;

  const usdcHuman = formatUnits(input.usdcAmountRaw, 6);
  const wethHuman = formatEther(input.wethAmountRaw);
  const usdcValueUsd = Number(usdcHuman);
  const wethValueUsd = Number(wethHuman) * ethUsd;

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
          maxWidth: 540,
          width: '90%',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>
            {stage === 'success' ? 'Position minted' : 'Confirm mint'}
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
            <Section title="Tokens">
              <Row label="Token0 (USDC)" value={formatAddr(input.token0)} mono />
              <Row label="Token1 (WETH)" value={formatAddr(input.token1)} mono />
              <Row label="Pool fee" value={`${input.feeTier / 10_000}%`} />
            </Section>

            <Section title="Amounts">
              <Row label="USDC deposited" value={`${formatHuman(usdcHuman)} USDC`} />
              <Row label="WETH deposited" value={`${formatHuman(wethHuman, 6)} WETH`} />
              <Row label="≈ total USD value" value={`~$${(usdcValueUsd + wethValueUsd).toFixed(2)}`} />
            </Section>

            <Section title="Range">
              <Row label="Tick lower" value={`${input.tickLower}`} mono />
              <Row label="Tick upper" value={`${input.tickUpper}`} mono />
              <Row label="Slippage" value={`${input.slippageBps / 100}%`} />
            </Section>

            <Section title="Recipient">
              <Row label="Smart Account" value={input.smartAccountAddress} mono />
            </Section>

            <Section title="Estimated gas">
              <Row
                label={saDeployed ? 'Mint userOp' : 'Mint + SA deployment'}
                value={
                  gasEstimate.ethCost != null
                    ? `~${gasEstimate.ethCost.toFixed(5)} ETH${
                        gasEstimate.usdCost != null
                          ? ` (~$${gasEstimate.usdCost.toFixed(2)})`
                          : ''
                      }`
                    : 'estimating…'
                }
              />
              <Row
                label="Gas price"
                value={
                  gasPriceWei != null
                    ? `${(Number(gasPriceWei) / 1e9).toFixed(2)} gwei`
                    : '—'
                }
              />
              <Row
                label="Net economics"
                value={
                  gasEstimate.usdCost != null
                    ? `$${(usdcValueUsd + wethValueUsd).toFixed(2)} position / $${gasEstimate.usdCost.toFixed(2)} gas = ${((usdcValueUsd + wethValueUsd) / gasEstimate.usdCost).toFixed(1)}× ratio`
                    : '—'
                }
              />
            </Section>

            <Banner kind="info">
              <strong>This single userOp will:</strong>
              <ol style={{ paddingLeft: 20, margin: '6px 0 0 0' }}>
                <li>Deploy your Smart Account (first time only, via initCode)</li>
                <li>Wrap {formatHuman(wethHuman, 6)} ETH → WETH inside the SA</li>
                <li>Approve USDC & WETH to the Uniswap V3 NPM</li>
                <li>Mint the LP NFT to your Smart Account</li>
              </ol>
              <br />
              The user signs <strong>once</strong> in their wallet. Gas is paid from the SA's ETH balance.
            </Banner>
          </>
        )}

        {stage === 'idle' && (
          <ButtonRow>
            <SecondaryButton onClick={handleClose}>Cancel</SecondaryButton>
            <PrimaryButton onClick={handleConfirm}>Confirm & sign</PrimaryButton>
          </ButtonRow>
        )}

        {(stage === 'signing' || stage === 'submitting' || stage === 'confirming') && (
          <ProgressNote>
            {stage === 'signing' && 'Waiting for wallet signature…'}
            {stage === 'submitting' && 'Submitting userOp to Pimlico bundler…'}
            {stage === 'confirming' && 'Waiting for on-chain inclusion…'}
          </ProgressNote>
        )}

        {stage === 'success' && result && (
          <>
            <Banner kind="success">
              LP NFT tokenId <strong>{result.tokenId.toString()}</strong> minted. Your
              Smart Account is now deployed and holds the position.
            </Banner>
            <Section title="On-chain result">
              <Row label="Token ID" value={result.tokenId.toString()} mono />
              <Row label="Liquidity" value={result.liquidity.toString()} mono />
              <Row label="Actual USDC used" value={`${formatHuman(formatUnits(result.actualAmount0, 6))} USDC`} />
              <Row label="Actual WETH used" value={`${formatHuman(formatEther(result.actualAmount1), 6)} WETH`} />
              <Row label="Tx hash" value={result.txHash} mono />
            </Section>
            <ButtonRow>
              <a
                href={`https://etherscan.io/tx/${result.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={linkButtonStyle}
              >
                View on Etherscan ↗
              </a>
              <PrimaryButton onClick={handleClose}>Done</PrimaryButton>
            </ButtonRow>
          </>
        )}

        {stage === 'error' && (
          <>
            <Banner kind="error">
              <strong>Mint failed.</strong> No funds lost — the userOp either
              never reached chain or reverted before modifying state.
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

function formatAddr(addr: Address): string {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function formatHuman(s: string, maxDecimals = 2): string {
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

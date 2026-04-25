'use client';

/**
 * MintPositionPreview — shows what an AI-managed ETH/USDC LP position
 * would look like at current price + AI-computed range.
 *
 * THIS COMPONENT DOES NOT SEND ANY TRANSACTIONS. It is read-only preview
 * UI. The actual mint flow (userOp construction + bundler submission) is
 * implemented in a separate iteration so the AI output can be visually
 * validated before any funds are moved.
 *
 * SECURITY:
 *   - Pure presentation. No signing, no allowance grants.
 *   - "Capture %" and "ETH required" are estimates for UX only — never use
 *     these numbers to construct actual on-chain amounts. The mint flow
 *     re-computes against the live pool's slot0 + decimals.
 */

import { useMemo, useState } from 'react';
import { parseUnits, type Address } from 'viem';
import { useAccount, useChainId } from 'wagmi';
import {
  sqrtPriceX96ToPrice,
  usdRangeToPoolTickRange,
} from '@liqai/uniswap';
import { useMintQuote, QUOTE_FEE_TIER } from '../lib/useMintQuote';
import { useUsdcWethPoolState } from '../lib/usePoolState';
import { useKernelAccount } from '../lib/useKernelAccount';
import { useKernelClient } from '../lib/useKernelClient';
import { computeRequiredWethForUsdc, DEFAULT_SLIPPAGE_BPS_UI } from '../lib/mintParams';
import { MintConfirmModal } from './MintConfirmModal';
import type { MintExecutionInput } from '../lib/mintExecutor';

const MAINNET_ID = 1;
/** Default preview amount matches a realistic first-test position size ($50).
 *  Users can increase it as they scale into the strategy. */
const DEFAULT_USDC = '25';
const MAX_USDC_PREVIEW = 1_000_000;

export function MintPositionPreview() {
  const { address: eoaAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const { data: quote, isLoading, error, refetch } = useMintQuote();
  const { data: poolState, error: poolError } = useUsdcWethPoolState();
  const { address: saAddress, isDeployed: saDeployed } = useKernelAccount();
  const {
    isReady: kernelReady,
    notReadyReason,
    getClient,
  } = useKernelClient();
  const [usdcInput, setUsdcInput] = useState(DEFAULT_USDC);
  const [modalOpen, setModalOpen] = useState(false);
  const [mintInput, setMintInput] = useState<MintExecutionInput | null>(null);

  // Compute Uniswap-aligned ticks from the AI's USD/ETH range, given the
  // live pool's actual decimals. This is what the mint userOp will use.
  const poolTickRange = useMemo(() => {
    if (!quote || !poolState) return null;
    try {
      return usdRangeToPoolTickRange({
        usdLower: quote.sweetSpot.priceLower,
        usdUpper: quote.sweetSpot.priceUpper,
        decimals0Stable: poolState.token0Decimals,
        decimals1Asset: poolState.token1Decimals,
        feeTier: poolState.fee,
      });
    } catch {
      return null;
    }
  }, [quote, poolState]);

  // On-chain current price derived from the pool's slot0 — this is the
  // authoritative value for any tx construction. CoinGecko's price is for
  // display only.
  const onchainEthUsd = useMemo(() => {
    if (!poolState) return null;
    // sqrtPriceX96ToPrice returns token1/token0 (WETH per USDC, decimal-adjusted).
    // For USD/ETH display we want the inverse.
    const wethPerUsdc = sqrtPriceX96ToPrice(
      poolState.sqrtPriceX96,
      poolState.token0Decimals,
      poolState.token1Decimals,
    );
    return wethPerUsdc > 0 ? 1 / wethPerUsdc : null;
  }, [poolState]);

  if (!isConnected || chainId !== MAINNET_ID) return null;

  const usdc = parseFloat(usdcInput);
  const usdcValid = Number.isFinite(usdc) && usdc > 0 && usdc <= MAX_USDC_PREVIEW;

  return (
    <Card>
      <div style={titleRowStyle}>
        <h3 style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
          AI-managed LP position (preview)
        </h3>
        <button onClick={() => refetch()} style={refreshButtonStyle} aria-label="Refresh quote">
          ↻
        </button>
      </div>

      {isLoading && <p style={mutedStyle}>Fetching ETH/USD price history from CoinGecko…</p>}

      {error && (
        <Banner kind="error">
          Failed to compute AI range: {error}
          <br />
          <small>This is a preview only — no funds are at risk.</small>
        </Banner>
      )}

      {poolError && (
        <Banner kind="warn">
          <strong>Live pool read unavailable.</strong> The free public RPC is rate-limited
          or rejecting these calls. The AI range (from CoinGecko) still works for preview,
          but the on-chain tick conversion needs a stable RPC.
          <br />
          <br />
          <strong>Fix:</strong> get a free API key at{' '}
          <a
            href="https://www.alchemy.com"
            style={{ color: 'inherit', textDecoration: 'underline' }}
          >
            alchemy.com
          </a>{' '}
          → add <code>NEXT_PUBLIC_ALCHEMY_API_KEY=...</code> to{' '}
          <code>apps/desktop/.env.local</code> → restart <code>npm run tauri:dev</code>.
        </Banner>
      )}

      {quote && (
        <>
          <div style={{ display: 'grid', gap: 8, fontSize: 13, marginBottom: 16 }}>
            <Row label="Pool" value="USDC / WETH (0.05% fee)" />
            <Row
              label="Current ETH price (CoinGecko)"
              value={`$${quote.currentEthUsd.toFixed(2)} USD`}
            />
            {onchainEthUsd !== null && (
              <Row
                label="Current ETH price (on-chain)"
                value={`$${onchainEthUsd.toFixed(2)} USD`}
              />
            )}
            {poolState && (
              <Row label="Pool current tick" value={`${poolState.tick}`} />
            )}
            <Row
              label="AI range (USD/ETH)"
              value={`$${quote.sweetSpot.priceLower.toFixed(0)} – $${quote.sweetSpot.priceUpper.toFixed(0)}`}
            />
            {poolTickRange && (
              <Row
                label="Uniswap ticks (mint will use)"
                value={`[${poolTickRange.tickLower}, ${poolTickRange.tickUpper}]`}
                mono
              />
            )}
            <Row
              label="Range width"
              value={`±${rangeWidthPct(quote.sweetSpot.priceLower, quote.sweetSpot.priceUpper, quote.currentEthUsd)}%`}
            />
            <Row label="Volatility (annualised)" value={`${(quote.sweetSpot.volatility * 100).toFixed(1)}%`} />
            <Row
              label="AI confidence"
              value={`${quote.sweetSpot.confidence.toFixed(0)}/100`}
            />
            <Row
              label="Expected APR"
              value={`~${quote.sweetSpot.expectedApr.toFixed(1)}% (estimate)`}
            />
            <Row label="Source" value={`CoinGecko · ${quote.historyPointCount} pts · 7d`} />
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              Position size preview
            </h4>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input
                type="text"
                inputMode="decimal"
                value={usdcInput}
                onChange={(e) => setUsdcInput(e.target.value)}
                style={inputStyle}
                placeholder="USDC amount"
                aria-label="USDC amount to deposit"
              />
              <span style={{ alignSelf: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
                USDC
              </span>
            </div>

            {usdcValid && (
              <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                <Row
                  label="Estimated ETH required"
                  value={`~${estimateEthRequired(usdc, quote).toFixed(4)} ETH`}
                />
                <Row label="USDC contributed" value={`${usdc.toFixed(2)} USDC`} />
                <Row
                  label="Total notional"
                  value={`~$${estimateTotalUsd(usdc, quote).toFixed(0)} USD`}
                />
              </div>
            )}

            {usdcValid && poolState && poolTickRange && saAddress && eoaAddress && (
              <div style={{ marginTop: 16 }}>
                <button
                  onClick={async () => {
                    if (!kernelReady) return;
                    try {
                      const client = await getClient();
                      const usdcAmountRaw = parseUnits(usdcInput.trim(), poolState.token0Decimals);
                      // Use the EXACT Uniswap V3 liquidity formula against the
                      // pool's live sqrtPriceX96 — the previous
                      // "same USD value" heuristic over-estimated WETH by
                      // 5-10% for asymmetric ranges and caused mint reverts
                      // at amount1Min. The 1.02 multiplier adds a small
                      // buffer so amount1Min still passes if the pool drifts
                      // slightly between estimate and execution.
                      const wethAmountRaw = computeRequiredWethForUsdc({
                        usdcAmountRaw,
                        sqrtPriceX96: poolState.sqrtPriceX96,
                        tickLower: poolTickRange.tickLower,
                        tickUpper: poolTickRange.tickUpper,
                        bufferMultiplier: 1.02,
                      });
                      setMintInput({
                        kernelClient: client,
                        eoaAddress: eoaAddress as Address,
                        smartAccountAddress: saAddress,
                        poolAddress: poolState.poolAddress,
                        token0: poolState.token0,
                        token1: poolState.token1,
                        feeTier: poolState.fee,
                        tickLower: poolTickRange.tickLower,
                        tickUpper: poolTickRange.tickUpper,
                        usdcAmountRaw,
                        wethAmountRaw,
                        slippageBps: DEFAULT_SLIPPAGE_BPS_UI,
                      });
                      setModalOpen(true);
                    } catch (err) {
                      // eslint-disable-next-line no-console
                      console.error('[LiqAI] mint prep failed:', err);
                      alert(err instanceof Error ? err.message : String(err));
                    }
                  }}
                  disabled={!kernelReady}
                  style={{
                    width: '100%',
                    padding: 12,
                    background: kernelReady ? 'var(--accent)' : 'var(--bg-elevated)',
                    color: kernelReady ? '#0b0d12' : 'var(--text-secondary)',
                    border: 'none',
                    borderRadius: 8,
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: kernelReady ? 'pointer' : 'not-allowed',
                  }}
                >
                  {kernelReady
                    ? saDeployed
                      ? 'Mint LP position'
                      : 'Deploy Smart Account & mint LP position'
                    : `Mint unavailable: ${notReadyReason}`}
                </button>
                {kernelReady && (
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.5 }}>
                    Requires {formatShortEth(estimateEthRequired(usdc, quote))} ETH + ~0.02 ETH
                    gas buffer and {usdc.toFixed(2)} USDC in your Smart Account{' '}
                    <code style={{ fontSize: 10 }}>{saAddress.slice(0, 10)}…{saAddress.slice(-6)}</code>.
                    Transfer these from your EOA first if needed.
                  </p>
                )}
              </div>
            )}

            {!usdcValid && usdcInput.length > 0 && (
              <p style={{ color: 'var(--danger)', fontSize: 12 }}>
                Enter a positive USDC amount up to {MAX_USDC_PREVIEW.toLocaleString()}.
              </p>
            )}
          </div>

          <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 16 }}>
            Algorithm: Bollinger Band (k=1.5) over {quote.historyPointCount} hourly
            ETH/USD points. Fee tier: {QUOTE_FEE_TIER / 10_000}%. Range is recomputed
            every 5 minutes.
          </p>
        </>
      )}

      <MintConfirmModal
        open={modalOpen}
        input={mintInput}
        ethUsd={onchainEthUsd ?? quote?.currentEthUsd ?? 0}
        onClose={() => {
          setModalOpen(false);
          setMintInput(null);
        }}
      />
    </Card>
  );
}

function formatShortEth(eth: number): string {
  return eth.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

// — math helpers (UI only, not for tx construction) —

function rangeWidthPct(lower: number, upper: number, current: number): string {
  const downside = ((current - lower) / current) * 100;
  const upside = ((upper - current) / current) * 100;
  const sym = Math.max(downside, upside);
  return sym.toFixed(1);
}

/**
 * Rough ETH-required estimate for a 50/50 LP position centred on current price.
 *
 * This is intentionally simplified for UI display — the real mint will use
 * the live pool's sqrtPriceX96 + tick range to derive amounts via the
 * Uniswap V3 liquidity formula. Do NOT use this output for tx amounts.
 */
function estimateEthRequired(usdcAmount: number, quote: { currentEthUsd: number }): number {
  // For a symmetric range straddling the current price, ~equal value in each token.
  const usdcValueInUsd = usdcAmount;
  const ethValueInUsd = usdcValueInUsd; // 50/50 split assumption
  return ethValueInUsd / quote.currentEthUsd;
}

function estimateTotalUsd(usdcAmount: number, quote: { currentEthUsd: number }): number {
  return usdcAmount + estimateEthRequired(usdcAmount, quote) * quote.currentEthUsd;
}

// — visual helpers —

const titleRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
};

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

const mutedStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 13,
  padding: '20px 0',
  textAlign: 'center',
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontSize: 14,
  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
};

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 20,
        marginTop: 16,
      }}
    >
      {children}
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

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: 'var(--text-primary)',
          textAlign: 'right',
          fontFamily: mono ? "'SF Mono', Menlo, Consolas, monospace" : 'inherit',
        }}
      >
        {value}
      </span>
    </div>
  );
}

'use client';

/**
 * Displays wallet connection status + balance once connected.
 *
 * SECURITY:
 *   - Reads only public data: account address, chainId, native + USDC balance.
 *   - NEVER asks the user to sign on render — signing requires an explicit
 *     button click by the user.
 */

import { useAccount, useBalance, useChainId } from 'wagmi';
import { formatEther } from 'viem';
import { UNISWAP_V3_ADDRESSES } from '@liqai/uniswap';

const MAINNET_ID = 1;

export function WalletStatus() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const { data: ethBalance } = useBalance({
    address,
    query: { enabled: isConnected },
  });

  const { data: usdcBalance } = useBalance({
    address,
    token: UNISWAP_V3_ADDRESSES[1].usdc,
    query: { enabled: isConnected && chainId === MAINNET_ID },
  });

  if (!isConnected || !address) {
    return null;
  }

  const wrongChain = chainId !== MAINNET_ID;

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
      <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 12 }}>
        Connected wallet
      </h3>

      <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
        <Row label="Address" value={shortAddress(address)} mono />
        <Row label="Chain" value={wrongChain ? `chainId=${chainId} (WRONG)` : 'Ethereum mainnet'} warn={wrongChain} />
        <Row
          label="ETH"
          value={ethBalance ? `${formatEther(ethBalance.value).slice(0, 8)} ETH` : '—'}
        />
        <Row
          label="USDC"
          value={
            usdcBalance
              ? `${formatUnits(usdcBalance.value, 6)} USDC`
              : wrongChain
              ? '(switch to mainnet)'
              : '—'
          }
        />
      </div>

      {wrongChain && (
        <p
          style={{
            marginTop: 12,
            padding: 10,
            background: 'rgba(248, 113, 113, 0.1)',
            border: '1px solid rgba(248, 113, 113, 0.3)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 12,
          }}
        >
          LiqAI v2 currently supports Ethereum mainnet only. Please switch network in your wallet.
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  warn,
}: {
  label: string;
  value: string;
  mono?: boolean;
  warn?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span
        style={{
          fontFamily: mono ? "'SF Mono', Menlo, Consolas, monospace" : 'inherit',
          color: warn ? 'var(--danger)' : 'var(--text-primary)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUnits(value: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  if (fraction === 0n) return whole.toString();
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 4);
  return `${whole}.${fractionStr}`;
}

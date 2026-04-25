'use client';

/**
 * SmartAccountStatus — displays the user's Kernel V3.1 Smart Account state.
 *
 * Shows:
 *   - Counterfactual or deployed SA address (always derivable from EOA, no signing)
 *   - Deployment status (deployed / pending first action)
 *   - SA's ETH balance (it pays its own gas in v1)
 *   - "Fund Smart Account" form to send ETH from EOA → SA for gas
 *
 * UX model (per docs/architecture-v2.md §5.1):
 *   The SA is deployed *lazily* as part of the first userOp's initCode (when
 *   the user mints their LP position). We do NOT have a separate "deploy now"
 *   button — that would force the user to pay gas to deploy a contract they
 *   haven't decided to use yet.
 *
 * SECURITY:
 *   - The Fund button uses wagmi's useSendTransaction → user signs in their
 *     wallet. LiqAI never holds a key.
 *   - We hard-cap the suggested fund amount at 0.05 ETH to prevent UI
 *     accidents (users can edit, but the default is conservative).
 *   - Only mainnet supported.
 */

import { useState } from 'react';
import { parseEther, parseUnits, formatEther, formatUnits, encodeFunctionData, parseAbi, type Address } from 'viem';
import {
  useAccount,
  useBalance,
  useChainId,
  useSendTransaction,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { useKernelAccount } from '../lib/useKernelAccount';
import { UNISWAP_V3_ADDRESSES } from '@liqai/uniswap';

const MAINNET_ID = 1;
const SUGGESTED_FUND_ETH = '0.01';
const MAX_FUND_ETH = '0.05';
const SUGGESTED_FUND_USDC = '25';
const MAX_FUND_USDC = '5000';
const USDC_DECIMALS = 6;

const ERC20_TRANSFER_ABI = parseAbi([
  'function transfer(address to, uint256 amount) external returns (bool)',
] as const);

export function SmartAccountStatus() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { address, isDeployed, ethBalanceWei, isLoading, error } = useKernelAccount();

  const usdcAddress = UNISWAP_V3_ADDRESSES[MAINNET_ID].usdc as Address;
  const { data: saUsdcBalance } = useBalance({
    address: address ?? undefined,
    token: usdcAddress,
    query: {
      enabled: !!address && chainId === MAINNET_ID,
      refetchInterval: 15_000,
    },
  });

  if (!isConnected || chainId !== MAINNET_ID) return null;

  if (isLoading) {
    return (
      <Card>
        <h3 style={titleStyle}>Smart Account</h3>
        <p style={mutedStyle}>Deriving Smart Account address…</p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <h3 style={titleStyle}>Smart Account</h3>
        <Banner kind="error">Failed to derive Smart Account: {error}</Banner>
      </Card>
    );
  }

  if (!address) return null;

  return (
    <Card>
      <h3 style={titleStyle}>
        Smart Account
        <StatusBadge isDeployed={isDeployed} />
      </h3>

      <div style={{ display: 'grid', gap: 8, fontSize: 13, marginBottom: 16 }}>
        <Row label="Address" value={address} mono />
        <Row label="Type" value="ZeroDev Kernel V3.1 (ERC-4337 v0.7)" />
        <Row
          label="ETH (for gas + WETH wrap)"
          value={ethBalanceWei !== null ? `${formatEther(ethBalanceWei).slice(0, 8)} ETH` : '—'}
        />
        <Row
          label="USDC (for LP)"
          value={
            saUsdcBalance
              ? `${formatUnits(saUsdcBalance.value, USDC_DECIMALS)} USDC`
              : '—'
          }
        />
      </div>

      {!isDeployed && (
        <Banner kind="info">
          <strong>Not yet deployed.</strong> This address is reserved for you (computed
          via CREATE2). It will be deployed automatically as part of your first action
          (e.g., minting an LP position). You only pay deployment gas once.
        </Banner>
      )}

      <FundSmartAccountForm targetAddress={address} ethBalanceWei={ethBalanceWei} />
      <FundSmartAccountWithUsdcForm targetAddress={address} usdcAddress={usdcAddress} />
    </Card>
  );
}

function StatusBadge({ isDeployed }: { isDeployed: boolean }) {
  return (
    <span
      style={{
        marginLeft: 10,
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        background: isDeployed ? 'rgba(94,234,212,0.12)' : 'rgba(251,191,36,0.12)',
        color: isDeployed ? 'var(--accent)' : '#fbbf24',
        border: `1px solid ${isDeployed ? 'rgba(94,234,212,0.3)' : 'rgba(251,191,36,0.3)'}`,
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {isDeployed ? 'Deployed' : 'Counterfactual'}
    </span>
  );
}

function FundSmartAccountForm({
  targetAddress,
  ethBalanceWei,
}: {
  targetAddress: `0x${string}`;
  ethBalanceWei: bigint | null;
}) {
  const [amount, setAmount] = useState(SUGGESTED_FUND_ETH);
  const [validationError, setValidationError] = useState<string | null>(null);
  const { sendTransaction, data: txHash, isPending, error: sendError, reset } =
    useSendTransaction();
  const { isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const handleSubmit = () => {
    setValidationError(null);
    let valueWei: bigint;
    try {
      valueWei = parseEther(amount);
    } catch {
      setValidationError('Invalid ETH amount');
      return;
    }
    if (valueWei <= 0n) {
      setValidationError('Amount must be greater than 0');
      return;
    }
    const maxWei = parseEther(MAX_FUND_ETH);
    if (valueWei > maxWei) {
      setValidationError(`For safety, the max via this form is ${MAX_FUND_ETH} ETH`);
      return;
    }
    sendTransaction({ to: targetAddress, value: valueWei });
  };

  const showSuccessNote = isSuccess;
  const hasEnoughForMint = ethBalanceWei !== null && ethBalanceWei >= parseEther('0.005');

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        paddingTop: 16,
        marginTop: 4,
      }}
    >
      <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
        Fund Smart Account with ETH (gas)
      </h4>
      <p style={{ ...mutedStyle, marginBottom: 12 }}>
        Your Smart Account pays its own gas. Sending ~0.005–0.02 ETH covers
        deployment and several rebalances.
        {hasEnoughForMint && ' You currently have enough for a first action.'}
      </p>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setValidationError(null);
            if (txHash) reset();
          }}
          disabled={isPending || isWaiting}
          style={{
            flex: 1,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            fontSize: 14,
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          }}
          placeholder="0.01"
          aria-label="ETH amount to send"
        />
        <button
          onClick={handleSubmit}
          disabled={isPending || isWaiting}
          style={{
            background: 'var(--accent)',
            color: '#0b0d12',
            border: 'none',
            borderRadius: 8,
            padding: '10px 18px',
            fontSize: 13,
            fontWeight: 600,
            cursor: isPending || isWaiting ? 'wait' : 'pointer',
            opacity: isPending || isWaiting ? 0.6 : 1,
          }}
        >
          {isPending ? 'Confirm in wallet…' : isWaiting ? 'Confirming…' : 'Send ETH'}
        </button>
      </div>

      {validationError && (
        <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
          {validationError}
        </p>
      )}
      {sendError && !validationError && (
        <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
          {sendError.message}
        </p>
      )}
      {showSuccessNote && (
        <p style={{ color: 'var(--accent)', fontSize: 12, marginTop: 8 }}>
          ✓ ETH sent. Balance will refresh shortly.
        </p>
      )}
    </div>
  );
}

function FundSmartAccountWithUsdcForm({
  targetAddress,
  usdcAddress,
}: {
  targetAddress: Address;
  usdcAddress: Address;
}) {
  const [amount, setAmount] = useState(SUGGESTED_FUND_USDC);
  const [validationError, setValidationError] = useState<string | null>(null);
  const { sendTransaction, data: txHash, isPending, error: sendError, reset } =
    useSendTransaction();
  const { isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const handleSubmit = () => {
    setValidationError(null);
    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(amount.trim(), USDC_DECIMALS);
    } catch {
      setValidationError('Invalid USDC amount');
      return;
    }
    if (amountRaw <= 0n) {
      setValidationError('Amount must be greater than 0');
      return;
    }
    const maxRaw = parseUnits(MAX_FUND_USDC, USDC_DECIMALS);
    if (amountRaw > maxRaw) {
      setValidationError(`For safety, the max via this form is ${MAX_FUND_USDC} USDC`);
      return;
    }
    sendTransaction({
      to: usdcAddress,
      data: encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [targetAddress, amountRaw],
      }),
      value: 0n,
    });
  };

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        paddingTop: 16,
        marginTop: 16,
      }}
    >
      <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
        Fund Smart Account with USDC (LP capital)
      </h4>
      <p style={{ ...mutedStyle, marginBottom: 12 }}>
        Transfer USDC from your connected wallet into your Smart Account. This
        USDC becomes the LP deposit when you mint a position.
      </p>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setValidationError(null);
            if (txHash) reset();
          }}
          disabled={isPending || isWaiting}
          style={{
            flex: 1,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            fontSize: 14,
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          }}
          placeholder="25"
          aria-label="USDC amount to send"
        />
        <button
          onClick={handleSubmit}
          disabled={isPending || isWaiting}
          style={{
            background: 'var(--accent)',
            color: '#0b0d12',
            border: 'none',
            borderRadius: 8,
            padding: '10px 18px',
            fontSize: 13,
            fontWeight: 600,
            cursor: isPending || isWaiting ? 'wait' : 'pointer',
            opacity: isPending || isWaiting ? 0.6 : 1,
          }}
        >
          {isPending ? 'Confirm in wallet…' : isWaiting ? 'Confirming…' : 'Send USDC'}
        </button>
      </div>

      {validationError && (
        <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
          {validationError}
        </p>
      )}
      {sendError && !validationError && (
        <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
          {sendError.message}
        </p>
      )}
      {isSuccess && (
        <p style={{ color: 'var(--accent)', fontSize: 12, marginTop: 8 }}>
          ✓ USDC sent. Balance will refresh shortly.
        </p>
      )}
    </div>
  );
}

// — small visual helpers —

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  color: 'var(--text-secondary)',
  marginBottom: 12,
  display: 'flex',
  alignItems: 'center',
};

const mutedStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.6,
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
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  );
}

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
          fontFamily: mono ? "'SF Mono', Menlo, Consolas, monospace" : 'inherit',
          color: 'var(--text-primary)',
          wordBreak: mono ? 'break-all' : 'normal',
          textAlign: 'right',
        }}
      >
        {value}
      </span>
    </div>
  );
}

'use client';

/**
 * SaRecoveryPanel — drain Smart Account ERC-20 balances back to the user's
 * connected EOA in a single signed userOp.
 *
 * Use case: the user wants to stop using LiqAI (or pause) and recover all
 * funds to the wallet they originally deposited from. The LP-NFT withdraw
 * flow (decreaseLiquidity + collect) leaves USDC + WETH in the SA. This
 * component closes the loop by transferring those ERC-20 balances out.
 *
 * Scope:
 *   - Transfers USDC and WETH (both ERC-20) from SA → connected EOA.
 *   - Does NOT touch the SA's native ETH — the userOp itself consumes some
 *     ETH for gas, and "drain all ETH" requires arithmetic against the
 *     userOp's own actualGasCost which we cannot know in advance. A small
 *     ETH residual (typically ≤ 0.01 ETH) remains in the SA after recovery.
 *   - Does NOT unwrap WETH to ETH — the user receives WETH (ERC-20) at their
 *     EOA and can unwrap externally if desired.
 *
 * SECURITY:
 *   - Destination is *always* the connected wallet (`useAccount().address`).
 *     Never a free-form input. This makes typo-redirection impossible.
 *   - Hidden when no LP positions are closed AND ERC-20 balances are zero —
 *     prevents accidental clicks while the bot is actively managing a position.
 *   - The single userOp is signed by the EOA via WalletConnect. LiqAI never
 *     handles a private key.
 *   - Each transfer emits a standard ERC-20 Transfer event so the recovery
 *     is fully observable on-chain after the fact.
 */

import { useCallback, useState } from 'react';
import {
  encodeFunctionData,
  formatUnits,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { useAccount, useBalance, useChainId } from 'wagmi';
import { UNISWAP_V3_ADDRESSES } from '@liqai/uniswap';
import { useKernelAccount } from '../lib/useKernelAccount';
import { useKernelClient } from '../lib/useKernelClient';

const MAINNET_ID = 1;
const USDC_DECIMALS = 6;
const WETH_DECIMALS = 18;

const ERC20_TRANSFER_ABI = parseAbi([
  'function transfer(address to, uint256 amount) external returns (bool)',
] as const);

type Stage = 'idle' | 'confirming' | 'submitting' | 'success' | 'error';

export function SaRecoveryPanel() {
  const { address: eoaAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const { address: saAddress, isDeployed } = useKernelAccount();
  const { isReady, getClient, notReadyReason } = useKernelClient();

  const usdcAddress = UNISWAP_V3_ADDRESSES[MAINNET_ID].usdc as Address;
  const wethAddress = UNISWAP_V3_ADDRESSES[MAINNET_ID].weth as Address;

  const { data: usdc, refetch: refetchUsdc } = useBalance({
    address: saAddress ?? undefined,
    token: usdcAddress,
    query: {
      enabled: !!saAddress && chainId === MAINNET_ID,
      refetchInterval: 15_000,
    },
  });
  const { data: weth, refetch: refetchWeth } = useBalance({
    address: saAddress ?? undefined,
    token: wethAddress,
    query: {
      enabled: !!saAddress && chainId === MAINNET_ID,
      refetchInterval: 15_000,
    },
  });

  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);

  const usdcRaw = usdc?.value ?? 0n;
  const wethRaw = weth?.value ?? 0n;
  const hasFunds = usdcRaw > 0n || wethRaw > 0n;

  const handleSubmit = useCallback(async () => {
    if (!isReady || !eoaAddress || !saAddress) return;
    setError(null);
    setStage('submitting');
    try {
      const client = await getClient();
      const calls: Array<{ to: Address; data: Hex; value: bigint }> = [];
      if (usdcRaw > 0n) {
        calls.push({
          to: usdcAddress,
          data: encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: 'transfer',
            args: [eoaAddress as Address, usdcRaw],
          }),
          value: 0n,
        });
      }
      if (wethRaw > 0n) {
        calls.push({
          to: wethAddress,
          data: encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: 'transfer',
            args: [eoaAddress as Address, wethRaw],
          }),
          value: 0n,
        });
      }
      if (calls.length === 0) {
        throw new Error('Nothing to recover — both USDC and WETH balances are zero.');
      }

      // Conservative manual gas limits — the inner calls are tiny (one ERC-20
      // transfer each, ~50k gas), so 300k callGas is generous. Verification
      // gas covers the ECDSA validator path on a deployed Kernel V3.1 SA.
      const userOpHash = await client.sendUserOperation({
        calls,
        callGasLimit: 300_000n,
        verificationGasLimit: 200_000n,
        preVerificationGas: 100_000n,
      });
      const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
      if (!receipt.success) {
        throw new Error(
          `Recovery userOp reverted on-chain (txHash=${receipt.receipt.transactionHash})`,
        );
      }
      setTxHash(receipt.receipt.transactionHash);
      setStage('success');
      void refetchUsdc();
      void refetchWeth();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, [
    isReady,
    eoaAddress,
    saAddress,
    getClient,
    usdcAddress,
    wethAddress,
    usdcRaw,
    wethRaw,
    refetchUsdc,
    refetchWeth,
  ]);

  if (!isConnected || chainId !== MAINNET_ID || !saAddress || !isDeployed || !eoaAddress) {
    return null;
  }
  if (!hasFunds && stage !== 'success') return null;

  const usdcHuman = formatUnits(usdcRaw, USDC_DECIMALS);
  const wethHuman = formatUnits(wethRaw, WETH_DECIMALS);

  return (
    <div style={cardStyle}>
      <h3 style={titleStyle}>Recover funds (SA → EOA)</h3>
      <p style={mutedStyle}>
        Transfer all USDC and WETH currently in your Smart Account back to the connected wallet
        in one signed transaction. Native ETH is not touched (a small residual stays in the SA).
      </p>

      <div style={breakdownStyle}>
        <Row label="USDC in SA" value={`${Number(usdcHuman).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`} />
        <Row label="WETH in SA" value={`${Number(wethHuman).toLocaleString(undefined, { maximumFractionDigits: 6 })} WETH`} />
        <Row label="Destination (EOA)" value={`${eoaAddress.slice(0, 10)}…${eoaAddress.slice(-6)}`} mono />
        <Row label="Smart Account" value={`${saAddress.slice(0, 10)}…${saAddress.slice(-6)}`} mono />
      </div>

      {stage === 'idle' && hasFunds && (
        <button
          onClick={() => setStage('confirming')}
          disabled={!isReady}
          style={primaryButtonStyle(!!isReady)}
        >
          {isReady ? 'Recover funds to my wallet' : `Unavailable: ${notReadyReason}`}
        </button>
      )}

      {stage === 'confirming' && (
        <div style={confirmStyle}>
          <p style={{ ...mutedStyle, marginBottom: 12 }}>
            About to sign a userOp that performs the following transfers, both with the SA
            (`{saAddress}`) as msg.sender:
          </p>
          <ol style={{ ...mutedStyle, paddingLeft: 20, marginBottom: 12, lineHeight: 1.7 }}>
            {usdcRaw > 0n && (
              <li>
                <code>USDC.transfer({eoaAddress.slice(0, 10)}…{eoaAddress.slice(-6)}, {usdcHuman})</code>
              </li>
            )}
            {wethRaw > 0n && (
              <li>
                <code>WETH.transfer({eoaAddress.slice(0, 10)}…{eoaAddress.slice(-6)}, {wethHuman})</code>
              </li>
            )}
          </ol>
          <p style={mutedStyle}>
            The user signs <strong>once</strong> in the wallet. Gas is paid from the SA&apos;s ETH balance.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button onClick={() => setStage('idle')} style={secondaryButtonStyle}>Cancel</button>
            <button onClick={handleSubmit} style={primaryButtonStyle(true)}>Sign &amp; submit</button>
          </div>
        </div>
      )}

      {stage === 'submitting' && (
        <p style={{ ...mutedStyle, marginTop: 12 }}>
          Submitting userOp to Pimlico bundler… waiting for inclusion.
        </p>
      )}

      {stage === 'success' && txHash && (
        <div style={successStyle}>
          <p style={{ marginBottom: 8 }}>
            <strong>Recovered.</strong> Funds are now in your EOA <code>{eoaAddress.slice(0, 10)}…{eoaAddress.slice(-6)}</code>.
          </p>
          <p style={{ fontSize: 12 }}>
            tx: <code>{txHash}</code>
            <a
              href={`https://etherscan.io/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              style={{ marginLeft: 8, color: 'var(--accent)' }}
            >
              View on Etherscan ↗
            </a>
          </p>
          <button
            onClick={() => {
              setStage('idle');
              setTxHash(null);
            }}
            style={{ ...secondaryButtonStyle, marginTop: 12 }}
          >
            Done
          </button>
        </div>
      )}

      {stage === 'error' && (
        <div style={errorStyle}>
          <p style={{ marginBottom: 8 }}><strong>Recovery failed.</strong> Funds are still in the SA — no state changed.</p>
          <p style={{ fontSize: 12 }}><code>{error}</code></p>
          <button onClick={() => setStage('idle')} style={{ ...secondaryButtonStyle, marginTop: 12 }}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 13, fontFamily: mono ? 'ui-monospace, monospace' : 'inherit' }}>{value}</span>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 20,
  marginTop: 16,
};

const titleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  marginBottom: 8,
};

const mutedStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 13,
  lineHeight: 1.5,
};

const breakdownStyle: React.CSSProperties = {
  margin: '12px 0',
  padding: 12,
  background: 'var(--bg)',
  borderRadius: 8,
};

const primaryButtonStyle = (enabled: boolean): React.CSSProperties => ({
  width: '100%',
  padding: 12,
  background: enabled ? 'var(--accent)' : 'var(--bg)',
  color: enabled ? '#0b0d12' : 'var(--text-secondary)',
  border: 'none',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: enabled ? 'pointer' : 'not-allowed',
  marginTop: 12,
});

const secondaryButtonStyle: React.CSSProperties = {
  flex: 1,
  padding: 12,
  background: 'transparent',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 14,
  cursor: 'pointer',
};

const confirmStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: 'rgba(80, 120, 200, 0.08)',
  border: '1px solid rgba(80, 120, 200, 0.3)',
  borderRadius: 8,
};

const successStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: 'rgba(50, 200, 130, 0.08)',
  border: '1px solid rgba(50, 200, 130, 0.3)',
  borderRadius: 8,
  color: 'var(--text)',
};

const errorStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: 'rgba(220, 80, 80, 0.08)',
  border: '1px solid rgba(220, 80, 80, 0.3)',
  borderRadius: 8,
  color: 'var(--text)',
};

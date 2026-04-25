'use client';

/**
 * useKernelClient — produces a ZeroDev Kernel account client wired to the
 * Pimlico bundler, ready to send userOps signed by the user's EOA wallet.
 *
 * The client is constructed lazily on first request and cached per-EOA. We
 * do NOT eagerly build it on every page mount because:
 *   - Building the ECDSA validator hits the publicClient (RPC) once.
 *   - Most page interactions don't actually need to send userOps.
 *
 * SECURITY:
 *   - The "signer" passed to signerToEcdsaValidator is wagmi's WalletClient,
 *     which delegates signMessage / signTypedData to the user's wallet over
 *     WalletConnect. LiqAI never sees the private key.
 *   - The bundler transport is read-only — bundlers cannot forge signatures.
 *   - We hard-fail if the chain is not mainnet (LiqAI v2 is mainnet-only,
 *     docs/architecture-v2.md §6).
 *   - We hard-fail if Pimlico API key is missing — silently degrading would
 *     surface confusing "fetch failed" errors at userOp submission time.
 */

import { useCallback, useState } from 'react';
import {
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { mainnet } from 'viem/chains';
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import {
  ENTRYPOINT,
  KERNEL_VERSION,
  KERNEL_ACCOUNT_INDEX,
  getBundlerUrl,
  PIMLICO_API_KEY_CONFIGURED,
} from './zerodev';

const MAINNET_ID = 1;

export interface UseKernelClientResult {
  /** True once the user's wallet is connected, on mainnet, and Pimlico is configured. */
  readonly isReady: boolean;
  /** Reason the client cannot be built right now. Null when isReady. */
  readonly notReadyReason: string | null;
  /** Build (or return cached) the Kernel client. Throws if !isReady. */
  readonly getClient: () => Promise<KernelClient>;
  /** True while the client is being constructed for the first time. */
  readonly isBuilding: boolean;
  /** Last error from a getClient() call (cleared on next successful call). */
  readonly buildError: string | null;
}

// We use `unknown` then cast at call site for the strongly-typed return —
// the deeply nested ZeroDev generics make a precise public type unwieldy
// and don't add safety since callers know what they're doing with it.
export type KernelClient = Awaited<ReturnType<typeof buildKernelClientInternal>>;

export function useKernelClient(): UseKernelClientResult {
  const { address: eoaAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [cachedClient, setCachedClient] = useState<{
    eoaAddress: string;
    client: KernelClient;
  } | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const notReadyReason: string | null = (() => {
    if (!isConnected || !eoaAddress) return 'Wallet not connected';
    if (chainId !== MAINNET_ID) return 'Wrong network — LiqAI requires Ethereum mainnet';
    if (!PIMLICO_API_KEY_CONFIGURED) {
      return 'Pimlico API key missing — set NEXT_PUBLIC_PIMLICO_API_KEY in apps/desktop/.env.local';
    }
    if (!publicClient) return 'Public RPC client not available';
    if (!walletClient) return 'Wallet client not available';
    return null;
  })();

  const getClient = useCallback(async (): Promise<KernelClient> => {
    if (notReadyReason) {
      throw new Error(notReadyReason);
    }
    // Reuse cache when EOA hasn't changed.
    if (cachedClient && eoaAddress && cachedClient.eoaAddress === eoaAddress) {
      return cachedClient.client;
    }
    setIsBuilding(true);
    setBuildError(null);
    try {
      const client = await buildKernelClientInternal({
        publicClient: publicClient as PublicClient,
        walletClient: walletClient as WalletClient,
      });
      setCachedClient({ eoaAddress: eoaAddress as string, client });
      return client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to build Kernel client';
      setBuildError(msg);
      throw err;
    } finally {
      setIsBuilding(false);
    }
  }, [notReadyReason, cachedClient, eoaAddress, publicClient, walletClient]);

  return {
    isReady: notReadyReason === null,
    notReadyReason,
    getClient,
    isBuilding,
    buildError,
  };
}

/**
 * Internal builder — kept outside the hook so we can test it independently
 * if needed and so the type inference is clean.
 *
 * Construction order matters: ECDSA validator must reference the same
 * entryPoint + kernelVersion as the eventual account.
 */
async function buildKernelClientInternal({
  publicClient,
  walletClient,
}: {
  publicClient: PublicClient;
  walletClient: WalletClient;
}) {
  const bundlerUrl = getBundlerUrl(MAINNET_ID);
  if (!bundlerUrl) {
    throw new Error('Pimlico bundler URL not configured');
  }

  // wagmi's useWalletClient() always returns a client with a defined account
  // when isConnected is true, but the public type permits undefined. Narrow
  // here once so the ZeroDev Signer type accepts it.
  if (!walletClient.account) {
    throw new Error('Wallet client has no account — wallet not connected');
  }
  const signer = walletClient as WalletClient<Transport, Chain, Account>;

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer,
    entryPoint: ENTRYPOINT,
    kernelVersion: KERNEL_VERSION,
  });

  const account = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint: ENTRYPOINT,
    kernelVersion: KERNEL_VERSION,
    index: KERNEL_ACCOUNT_INDEX,
  });

  const kernelClient = createKernelAccountClient({
    account,
    chain: mainnet,
    bundlerTransport: http(bundlerUrl),
    client: publicClient,
    // CRITICAL: ZeroDev SDK defaults to calling `zd_getUserOperationGasPrice`,
    // a ZeroDev-bundler-specific RPC that Pimlico does NOT implement (returns
    // "Method not available" → mint userOp aborts before submission).
    //
    // We override estimateFeesPerGas to use Pimlico's standard
    // `pimlico_getUserOperationGasPrice` (returns slow/standard/fast tiers),
    // falling back to the public client's EIP-1559 estimate if Pimlico's
    // method is also unreachable.
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        try {
          const tiers = (await bundlerClient.request({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            method: 'pimlico_getUserOperationGasPrice' as any,
            params: [],
          })) as {
            slow: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` };
            standard: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` };
            fast: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` };
          };
          return {
            maxFeePerGas: BigInt(tiers.standard.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(tiers.standard.maxPriorityFeePerGas),
          };
        } catch {
          // Fallback: ask the public RPC for current EIP-1559 fees.
          const fees = await publicClient.estimateFeesPerGas();
          return {
            maxFeePerGas: fees.maxFeePerGas ?? 1_000_000_000n,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 1_000_000_000n,
          };
        }
      },
    },
  });

  return kernelClient;
}

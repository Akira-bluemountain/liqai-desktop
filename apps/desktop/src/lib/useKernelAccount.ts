'use client';

/**
 * useKernelAccount — derives the user's Kernel Smart Account state from
 * the currently-connected EOA.
 *
 * What this hook does (read-only, NO signing, NO gas):
 *   1. Computes the counterfactual Kernel V3.1 address via CREATE2 math
 *      using the connected EOA as the ECDSA validator owner.
 *   2. Queries on-chain bytecode to determine if that address is already
 *      deployed.
 *   3. Reads the SA's native ETH balance (it pays its own gas in v1).
 *
 * What this hook does NOT do:
 *   - It NEVER triggers a deployment. Kernel deployment happens lazily as
 *     part of the first userOp's initCode (when the user mints their LP
 *     position). This is the standard ERC-4337 pattern and avoids any
 *     "deploy a contract for $5 then never use it" cliff.
 *   - It NEVER asks the user to sign anything.
 *
 * SECURITY:
 *   - All inputs to getKernelAddressFromECDSA come from wagmi's connected
 *     account state — no user-controlled strings. The factory and
 *     implementation addresses are constants of the audited Kernel deployment.
 *   - Bytecode check uses the same publicClient as wagmi (no extra trust).
 */

import { useEffect, useState } from 'react';
import type { Address, PublicClient } from 'viem';
import { useAccount, useChainId, usePublicClient, useBalance } from 'wagmi';
import { getKernelAddressFromECDSA } from '@zerodev/ecdsa-validator';
import { ENTRYPOINT, KERNEL_VERSION, KERNEL_ACCOUNT_INDEX } from './zerodev';

export interface KernelAccountState {
  /** Counterfactual or deployed Smart Account address. Null while loading or no EOA. */
  readonly address: Address | null;
  /** True once on-chain bytecode lookup confirms the SA is deployed. */
  readonly isDeployed: boolean;
  /** Native ETH balance of the Smart Account, in wei. */
  readonly ethBalanceWei: bigint | null;
  /** True while computing the counterfactual address. */
  readonly isLoading: boolean;
  /** Set if address derivation or bytecode check failed. */
  readonly error: string | null;
}

const MAINNET_ID = 1;

export function useKernelAccount(): KernelAccountState {
  const { address: eoaAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();

  const [address, setAddress] = useState<Address | null>(null);
  const [isDeployed, setIsDeployed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: derive counterfactual address whenever EOA changes.
  useEffect(() => {
    if (!isConnected || !eoaAddress || !publicClient || chainId !== MAINNET_ID) {
      setAddress(null);
      setIsDeployed(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getKernelAddressFromECDSA({
      entryPoint: ENTRYPOINT,
      kernelVersion: KERNEL_VERSION,
      eoaAddress,
      index: KERNEL_ACCOUNT_INDEX,
      publicClient: publicClient as PublicClient,
    })
      .then((derivedAddress) => {
        if (cancelled) return;
        setAddress(derivedAddress);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to derive Smart Account address',
        );
        setAddress(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [eoaAddress, isConnected, chainId, publicClient]);

  // Step 2: check deployment status (eth_getCode) once we have an address.
  useEffect(() => {
    if (!address || !publicClient) {
      setIsDeployed(false);
      return;
    }
    let cancelled = false;
    publicClient
      .getCode({ address })
      .then((code) => {
        if (cancelled) return;
        // An undeployed account returns undefined or "0x"; deployed has bytecode.
        setIsDeployed(!!code && code !== '0x');
      })
      .catch(() => {
        if (!cancelled) setIsDeployed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, publicClient]);

  // Step 3: balance of the SA address (works for counterfactual too — balance
  // can be sent before deployment).
  const { data: balanceData } = useBalance({
    address: address ?? undefined,
    query: { enabled: !!address && chainId === MAINNET_ID, refetchInterval: 15_000 },
  });

  return {
    address,
    isDeployed,
    ethBalanceWei: balanceData ? balanceData.value : null,
    isLoading,
    error,
  };
}

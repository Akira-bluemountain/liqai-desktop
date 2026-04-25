'use client';

/**
 * useGasEstimate — reads current mainnet gas price and converts a given
 * gas amount to an ETH + USD cost estimate.
 *
 * This is a heuristic-based estimator — the actual on-chain gas consumed
 * may differ by ±30%. Use it for UX framing ("will this cost $5 or $50?")
 * not for economic decisions.
 *
 * The gas ESTIMATES below are derived from empirical Kernel V3.1 + Uniswap
 * V3 measurements. If we observe systematic drift we can adjust the
 * constants without changing callers.
 */

import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { type PublicClient } from 'viem';

const MAINNET_ID = 1;

/** Gas amounts (units) for the key LiqAI operations. First mint is the
 *  most expensive because it includes Kernel SA deployment via initCode. */
export const GAS_ESTIMATES = {
  firstMint: 900_000n, // SA deploy + WETH wrap + 2 approves + NPM.mint
  subsequentMint: 500_000n,
  withdraw: 250_000n, // decreaseLiquidity + collect
  installSessionKey: 200_000n, // enable plugin
} as const;

export type OperationKind = keyof typeof GAS_ESTIMATES;

export interface GasEstimateResult {
  readonly gasPriceWei: bigint | null;
  readonly ethUsd: number | null;
  readonly isLoading: boolean;
  readonly estimate: (op: OperationKind) => { ethCost: number | null; usdCost: number | null };
}

export function useGasEstimate(ethUsd: number | null): GasEstimateResult {
  const publicClient = usePublicClient();

  const query = useQuery({
    queryKey: ['gas-price', 'mainnet'],
    enabled: !!publicClient,
    queryFn: async (): Promise<bigint> => {
      if (!publicClient) throw new Error('no public client');
      return await (publicClient as PublicClient).getGasPrice();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const gasPriceWei = query.data ?? null;

  const estimate = (op: OperationKind) => {
    if (gasPriceWei == null) return { ethCost: null, usdCost: null };
    const weiCost = GAS_ESTIMATES[op] * gasPriceWei;
    const ethCost = Number(weiCost) / 1e18;
    const usdCost = ethUsd != null ? ethCost * ethUsd : null;
    return { ethCost, usdCost };
  };

  // Silence the "MAINNET_ID never read" lint by referring to it once. LiqAI
  // v2 is mainnet-only so we don't branch on chainId, but we pin the
  // intent here so future multi-chain work can wire it up.
  void MAINNET_ID;

  return {
    gasPriceWei,
    ethUsd,
    isLoading: query.isLoading,
    estimate,
  };
}

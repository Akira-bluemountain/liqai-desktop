'use client';

/**
 * usePoolState — reads the USDC/WETH 0.05% pool's live state (slot0,
 * decimals) via the viem publicClient that wagmi already configures.
 *
 * Why viem (not ethers) here:
 *   We initially used ethers to reuse @liqai/uniswap's tested helpers, but
 *   ethers v6's request batching + cached connection state interacted badly
 *   with free public RPCs (Cloudflare / llamarpc) — the very first
 *   factory.getPool() call returned a generic CALL_EXCEPTION even though
 *   the same URL works fine for wagmi's publicClient. Using viem here
 *   eliminates the parallel HTTP stack and inherits any retry / rate-limit
 *   handling wagmi already has configured.
 *
 * SECURITY:
 *   - All addresses read are well-known mainnet contracts (Uniswap V3
 *     Factory, USDC/WETH ERC-20s). No user-controlled values flow into
 *     the call data.
 *   - Decimals returned by token contracts are bounds-checked (0–30) to
 *     catch malicious or buggy ERC-20s.
 */

import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { parseAbi, type Address, type PublicClient } from 'viem';
import {
  FACTORY_ABI,
  POOL_ABI,
  ERC20_ABI,
  UNISWAP_V3_ADDRESSES,
} from '@liqai/uniswap';

// @liqai/uniswap exposes ABIs in human-readable (ethers) string form. viem
// needs the JSON ABI form, so we parse once at module init.
const FACTORY_ABI_VIEM = parseAbi(FACTORY_ABI);
const POOL_ABI_VIEM = parseAbi(POOL_ABI);
const ERC20_ABI_VIEM = parseAbi(ERC20_ABI);

const MAINNET_ID = 1;
const FEE_TIER = 500; // USDC/WETH 0.05%
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export interface PoolStateWithDecimals {
  readonly poolAddress: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
}

export interface UsePoolStateResult {
  readonly data: PoolStateWithDecimals | undefined;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export async function readPoolState(
  client: PublicClient,
): Promise<PoolStateWithDecimals> {
  const { factory, usdc, weth } = UNISWAP_V3_ADDRESSES[MAINNET_ID];

  const poolAddress = (await client.readContract({
    address: factory as Address,
    abi: FACTORY_ABI_VIEM,
    functionName: 'getPool',
    args: [usdc as Address, weth as Address, FEE_TIER],
  })) as Address;

  if (
    !poolAddress ||
    poolAddress.toLowerCase() === ZERO_ADDRESS
  ) {
    throw new Error('Uniswap V3 Factory returned zero address for USDC/WETH/500');
  }

  const [slot0, liquidity, token0, token1, fee, tickSpacing] = await Promise.all([
    client.readContract({
      address: poolAddress,
      abi: POOL_ABI_VIEM,
      functionName: 'slot0',
    }) as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
    client.readContract({
      address: poolAddress,
      abi: POOL_ABI_VIEM,
      functionName: 'liquidity',
    }) as Promise<bigint>,
    client.readContract({
      address: poolAddress,
      abi: POOL_ABI_VIEM,
      functionName: 'token0',
    }) as Promise<Address>,
    client.readContract({
      address: poolAddress,
      abi: POOL_ABI_VIEM,
      functionName: 'token1',
    }) as Promise<Address>,
    client.readContract({
      address: poolAddress,
      abi: POOL_ABI_VIEM,
      functionName: 'fee',
    }) as Promise<number>,
    client.readContract({
      address: poolAddress,
      abi: POOL_ABI_VIEM,
      functionName: 'tickSpacing',
    }) as Promise<number>,
  ]);

  const sqrtPriceX96 = slot0[0];
  const currentTick = Number(slot0[1]);
  if (sqrtPriceX96 <= 0n) {
    throw new Error('Pool slot0 returned non-positive sqrtPriceX96');
  }

  const [token0Decimals, token1Decimals] = await Promise.all([
    readErc20Decimals(client, token0),
    readErc20Decimals(client, token1),
  ]);

  return {
    poolAddress,
    token0,
    token1,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    sqrtPriceX96,
    tick: currentTick,
    liquidity,
    token0Decimals,
    token1Decimals,
  };
}

async function readErc20Decimals(
  client: PublicClient,
  tokenAddress: Address,
): Promise<number> {
  const raw = (await client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI_VIEM,
    functionName: 'decimals',
  })) as number | bigint;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 30) {
    throw new Error(`Implausible decimals from ${tokenAddress}: ${String(raw)}`);
  }
  return n;
}

export function useUsdcWethPoolState(): UsePoolStateResult {
  const publicClient = usePublicClient();

  const query = useQuery({
    queryKey: ['pool-state', 'mainnet', 'USDC-WETH', FEE_TIER],
    enabled: !!publicClient,
    queryFn: async (): Promise<PoolStateWithDecimals> => {
      if (!publicClient) {
        throw new Error('No public client available');
      }
      return readPoolState(publicClient as PublicClient);
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 2,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
  };
}

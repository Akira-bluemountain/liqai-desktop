/**
 * Read-only pool state fetcher.
 *
 * Reads current state of a Uniswap V3 pool via a user-provided JSON-RPC
 * Provider. All inputs are validated with Zod before being used.
 */

import { ethers } from 'ethers';
import { z } from 'zod';
import { FACTORY_ABI, POOL_ABI, ERC20_ABI } from './abis.js';
import { getAddresses } from './addresses.js';

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be an address');
const FeeTierSchema = z
  .number()
  .int()
  .refine((v) => [100, 500, 3000, 10_000].includes(v), {
    message: 'fee must be one of 100, 500, 3000, 10000',
  });

export interface PoolState {
  readonly poolAddress: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
}

// Narrow type for ethers.Contract — ethers v6 returns `any`-like proxies,
// so we declare the exact shapes we call to regain type safety.
interface FactoryContract {
  getPool(tokenA: string, tokenB: string, fee: number): Promise<string>;
}
interface PoolContract {
  slot0(): Promise<{ sqrtPriceX96: bigint; tick: bigint }>;
  liquidity(): Promise<bigint>;
  token0(): Promise<string>;
  token1(): Promise<string>;
  fee(): Promise<bigint>;
  tickSpacing(): Promise<bigint>;
}
interface ERC20Contract {
  decimals(): Promise<bigint>;
}

/**
 * Resolve a Uniswap V3 pool address via the factory.
 */
export async function getPoolAddress(options: {
  readonly provider: ethers.Provider;
  readonly chainId: number;
  readonly tokenA: string;
  readonly tokenB: string;
  readonly fee: number;
}): Promise<string> {
  const chainId = options.chainId;
  const tokenA = AddressSchema.parse(options.tokenA);
  const tokenB = AddressSchema.parse(options.tokenB);
  const fee = FeeTierSchema.parse(options.fee);

  const addrs = getAddresses(chainId);
  const factory = new ethers.Contract(
    addrs.factory,
    FACTORY_ABI,
    options.provider,
  ) as unknown as FactoryContract;
  const poolAddress = await factory.getPool(tokenA, tokenB, fee);
  if (poolAddress === ethers.ZeroAddress) {
    throw new Error(
      `No pool found for tokens (${tokenA}, ${tokenB}) at fee ${fee}`,
    );
  }
  return poolAddress;
}

/**
 * Fetch the state of a Uniswap V3 pool.
 */
export async function getPoolState(options: {
  readonly provider: ethers.Provider;
  readonly poolAddress: string;
}): Promise<PoolState> {
  const poolAddress = AddressSchema.parse(options.poolAddress);
  const pool = new ethers.Contract(
    poolAddress,
    POOL_ABI,
    options.provider,
  ) as unknown as PoolContract;

  const [slot0, liquidity, token0, token1, fee, tickSpacing] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    pool.token0(),
    pool.token1(),
    pool.fee(),
    pool.tickSpacing(),
  ]);

  const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
  if (sqrtPriceX96 <= 0n) {
    throw new Error('Pool slot0 returned non-positive sqrtPriceX96');
  }

  return {
    poolAddress,
    token0,
    token1,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    sqrtPriceX96,
    tick: Number(slot0.tick),
    liquidity: BigInt(liquidity),
  };
}

/** Fetch ERC-20 token decimals. Throws if result is not a plausible value. */
export async function getTokenDecimals(
  provider: ethers.Provider,
  tokenAddress: string,
): Promise<number> {
  const address = AddressSchema.parse(tokenAddress);
  const token = new ethers.Contract(
    address,
    ERC20_ABI,
    provider,
  ) as unknown as ERC20Contract;
  const raw = await token.decimals();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 30) {
    throw new Error(`Implausible token decimals from ${address}: ${String(raw)}`);
  }
  return n;
}

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import type { SweetSpotResult } from '@liqai/ai';
import {
  buildSwapTx,
  buildMintTx,
  buildDecreaseLiquidityTx,
  buildCollectTx,
  MAX_SLIPPAGE_BPS,
} from '../src/tx-builder.js';
import { UNISWAP_V3_ADDRESSES } from '../src/addresses.js';

const MAINNET = 1;
const USDC = UNISWAP_V3_ADDRESSES[1].usdc;
const WETH = UNISWAP_V3_ADDRESSES[1].weth;
const OWNER = '0x1111111111111111111111111111111111111111';

const validAiRange: SweetSpotResult = {
  tickLower: 69_000,
  tickUpper: 76_000,
  priceLower: 1900,
  priceUpper: 2100,
  expectedApr: 80,
  confidence: 75,
  volatility: 0.3,
};

describe('buildSwapTx', () => {
  it('encodes a swap with slippage protection', () => {
    const tx = buildSwapTx({
      chainId: MAINNET,
      tokenIn: USDC,
      tokenOut: WETH,
      fee: 500,
      amountIn: 1_000_000n, // 1 USDC
      expectedAmountOut: 500_000_000_000_000n, // 0.0005 WETH quote
      slippageBps: 50,
      recipient: OWNER,
    });
    expect(tx.to).toBe(UNISWAP_V3_ADDRESSES[1].swapRouter02);
    expect(tx.value).toBe(0n);
    expect(tx.data).toMatch(/^0x[a-fA-F0-9]+$/);
  });

  it('rejects excessive slippage', () => {
    expect(() =>
      buildSwapTx({
        chainId: MAINNET,
        tokenIn: USDC,
        tokenOut: WETH,
        fee: 500,
        amountIn: 1n,
        expectedAmountOut: 1n,
        slippageBps: MAX_SLIPPAGE_BPS + 1,
        recipient: OWNER,
      }),
    ).toThrow(/slippageBps/);
  });

  it('rejects zero/negative amounts', () => {
    expect(() =>
      buildSwapTx({
        chainId: MAINNET,
        tokenIn: USDC,
        tokenOut: WETH,
        fee: 500,
        amountIn: 0n,
        expectedAmountOut: 1n,
        recipient: OWNER,
      }),
    ).toThrow();
  });

  it('rejects malformed addresses', () => {
    expect(() =>
      buildSwapTx({
        chainId: MAINNET,
        tokenIn: 'not-an-address',
        tokenOut: WETH,
        fee: 500,
        amountIn: 1n,
        expectedAmountOut: 1n,
        recipient: OWNER,
      }),
    ).toThrow();
  });

  it('rejects non-whitelisted fee tiers', () => {
    expect(() =>
      buildSwapTx({
        chainId: MAINNET,
        tokenIn: USDC,
        tokenOut: WETH,
        fee: 999 as 500,
        amountIn: 1n,
        expectedAmountOut: 1n,
        recipient: OWNER,
      }),
    ).toThrow();
  });

  it('rejects unsupported chains', () => {
    expect(() =>
      buildSwapTx({
        chainId: 137, // Polygon not supported in MVP
        tokenIn: USDC,
        tokenOut: WETH,
        fee: 500,
        amountIn: 1n,
        expectedAmountOut: 1n,
        recipient: OWNER,
      }),
    ).toThrow();
  });
});

describe('buildMintTx', () => {
  it('encodes a mint tx when AI range is safe', () => {
    const tx = buildMintTx({
      chainId: MAINNET,
      token0: USDC,
      token1: WETH,
      fee: 500,
      tickLower: validAiRange.tickLower,
      tickUpper: validAiRange.tickUpper,
      amount0Desired: 1_000_000n,
      amount1Desired: 500_000_000_000_000n,
      recipient: OWNER,
      aiRange: validAiRange,
      currentPrice: 2000,
    });
    expect(tx.to).toBe(UNISWAP_V3_ADDRESSES[1].nonfungiblePositionManager);
    expect(tx.value).toBe(0n);
  });

  it('refuses to encode when tick range does not match AI output (defence against tampering)', () => {
    expect(() =>
      buildMintTx({
        chainId: MAINNET,
        token0: USDC,
        token1: WETH,
        fee: 500,
        tickLower: 10_000, // MISMATCH
        tickUpper: 20_000, // MISMATCH
        amount0Desired: 1_000_000n,
        amount1Desired: 500_000_000_000_000n,
        recipient: OWNER,
        aiRange: validAiRange,
        currentPrice: 2000,
      }),
    ).toThrow(/exactly match the validated AI range/);
  });

  it('refuses to encode when AI range does not bracket current price', () => {
    expect(() =>
      buildMintTx({
        chainId: MAINNET,
        token0: USDC,
        token1: WETH,
        fee: 500,
        tickLower: validAiRange.tickLower,
        tickUpper: validAiRange.tickUpper,
        amount0Desired: 1_000_000n,
        amount1Desired: 500_000_000_000_000n,
        recipient: OWNER,
        aiRange: validAiRange,
        currentPrice: 100, // way below range
      }),
    ).toThrow(/bracket/);
  });

  it('rejects both zero amounts', () => {
    expect(() =>
      buildMintTx({
        chainId: MAINNET,
        token0: USDC,
        token1: WETH,
        fee: 500,
        tickLower: validAiRange.tickLower,
        tickUpper: validAiRange.tickUpper,
        amount0Desired: 0n,
        amount1Desired: 0n,
        recipient: OWNER,
        aiRange: validAiRange,
        currentPrice: 2000,
      }),
    ).toThrow();
  });
});

describe('buildDecreaseLiquidityTx', () => {
  it('encodes a decrease liquidity tx', () => {
    const tx = buildDecreaseLiquidityTx({
      chainId: MAINNET,
      tokenId: 12_345n,
      liquidity: 1_000_000n,
      expectedAmount0: 500_000n,
      expectedAmount1: 250_000_000_000_000n,
      slippageBps: 50,
    });
    expect(tx.to).toBe(UNISWAP_V3_ADDRESSES[1].nonfungiblePositionManager);
    // Data should contain the function selector 0x0c49ccbe
    expect(tx.data.toLowerCase().startsWith('0x0c49ccbe')).toBe(true);
  });

  it('rejects zero tokenId or liquidity', () => {
    const base = {
      chainId: MAINNET,
      expectedAmount0: 1n,
      expectedAmount1: 1n,
    };
    expect(() =>
      buildDecreaseLiquidityTx({ ...base, tokenId: 0n, liquidity: 1n }),
    ).toThrow();
    expect(() =>
      buildDecreaseLiquidityTx({ ...base, tokenId: 1n, liquidity: 0n }),
    ).toThrow();
  });
});

describe('buildCollectTx', () => {
  it('encodes a collect-all tx by default', () => {
    const tx = buildCollectTx({
      chainId: MAINNET,
      tokenId: 12_345n,
      recipient: OWNER,
    });
    expect(tx.to).toBe(UNISWAP_V3_ADDRESSES[1].nonfungiblePositionManager);
    // Should contain 0xfc6f7865 (collect selector)
    expect(tx.data.toLowerCase().startsWith('0xfc6f7865')).toBe(true);
  });

  it('rejects zero tokenId', () => {
    expect(() =>
      buildCollectTx({
        chainId: MAINNET,
        tokenId: 0n,
        recipient: OWNER,
      }),
    ).toThrow();
  });

  it('rejects invalid recipient', () => {
    expect(() =>
      buildCollectTx({
        chainId: MAINNET,
        tokenId: 1n,
        recipient: 'not-an-address',
      }),
    ).toThrow();
  });
});

describe('ethers ABI interop (guards against regex-based address spoofing)', () => {
  it('ethers.getAddress normalises to checksummed', () => {
    expect(ethers.getAddress(USDC.toLowerCase())).toBe(USDC);
  });
});

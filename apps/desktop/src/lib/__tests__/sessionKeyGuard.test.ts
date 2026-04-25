/**
 * Tests for the off-chain pre-validation guard (Phase 4.1).
 *
 * The guard runs immediately before each session-key userOp is submitted.
 * Its job is to reject any call sequence that would be rejected on-chain,
 * so we catch the failure locally (no gas burn) AND we double-guard
 * against a client-side bug or a tampered binary.
 *
 * These tests cover:
 *   - Reject (3): mint / collect / approve with attacker-shaped args.
 *   - Allow (3): mint / collect / approve + decrease with recipient=SA.
 *   - Reject (3): ETH value != 0, unknown target, unknown selector.
 */

import { describe, it, expect } from 'vitest';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import {
  assertCallsSafe,
  SessionKeyGuardError,
} from '../sessionKeyGuard';
import {
  MAX_APPROVE_AMOUNT_USDC,
  MAX_APPROVE_AMOUNT_WETH,
} from '../constants/sessionKeyLimits';

// ── Fixtures ──────────────────────────────────────────────────────────
const NPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as Address;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address;
const SA = '0x135A384fD401E041167F1bE8bee312d7A6899A5F' as Address;
const ATTACKER = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Address;

const NPM_ABI = parseAbi([
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256,uint256)',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256,uint256)',
]);
const ERC20_ABI = parseAbi(['function approve(address,uint256) returns (bool)']);

// ── Helpers for building well-formed calldata ────────────────────────
function mintData(recipient: Address): Hex {
  return encodeFunctionData({
    abi: NPM_ABI,
    functionName: 'mint',
    args: [
      {
        token0: USDC,
        token1: WETH,
        fee: 500,
        tickLower: 197000,
        tickUpper: 199000,
        amount0Desired: 10n ** 9n,
        amount1Desired: 10n ** 17n,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient,
        deadline: 0n,
      },
    ],
  });
}

function collectData(recipient: Address): Hex {
  return encodeFunctionData({
    abi: NPM_ABI,
    functionName: 'collect',
    args: [
      {
        tokenId: 1234n,
        recipient,
        amount0Max: 2n ** 128n - 1n,
        amount1Max: 2n ** 128n - 1n,
      },
    ],
  });
}

function decreaseData(): Hex {
  return encodeFunctionData({
    abi: NPM_ABI,
    functionName: 'decreaseLiquidity',
    args: [
      {
        tokenId: 1234n,
        liquidity: 1_000_000n,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: 0n,
      },
    ],
  });
}

function approveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

// ── Reject tests: Q1-style attacks must throw ────────────────────────
describe('assertCallsSafe — rejects Q1 attack patterns', () => {
  it('rejects mint with recipient=attacker', () => {
    const calls = [
      { to: NPM, data: mintData(ATTACKER), value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).toThrow(SessionKeyGuardError);
    try {
      assertCallsSafe(calls, SA);
    } catch (err) {
      expect((err as Error).message).toMatch(/mint\.recipient/i);
    }
  });

  it('rejects collect with recipient=attacker', () => {
    const calls = [
      { to: NPM, data: collectData(ATTACKER), value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).toThrow(SessionKeyGuardError);
    try {
      assertCallsSafe(calls, SA);
    } catch (err) {
      expect((err as Error).message).toMatch(/collect\.recipient/i);
    }
  });

  it('rejects USDC.approve with MaxUint256 (exceeds cap)', () => {
    const calls = [
      { to: USDC, data: approveData(NPM, 2n ** 256n - 1n), value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).toThrow(SessionKeyGuardError);
    try {
      assertCallsSafe(calls, SA);
    } catch (err) {
      expect((err as Error).message).toMatch(/exceeds cap/i);
    }
  });

  it('rejects USDC.approve with spender != NPM', () => {
    const calls = [
      { to: USDC, data: approveData(ATTACKER, 100n), value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).toThrow(SessionKeyGuardError);
    try {
      assertCallsSafe(calls, SA);
    } catch (err) {
      expect((err as Error).message).toMatch(/spender/i);
    }
  });

  it('rejects call with value > 0 (native ETH transfer)', () => {
    const calls = [
      { to: NPM, data: collectData(SA), value: 1n },
    ];
    expect(() => assertCallsSafe(calls, SA)).toThrow(
      /MUST NOT transfer native ETH/,
    );
  });

  it('rejects call to unallowed target', () => {
    const calls = [
      { to: ATTACKER, data: '0x00' as Hex, value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).toThrow(/not in allowlist/);
  });
});

// ── Allow tests: legitimate bot operations must pass ─────────────────
describe('assertCallsSafe — allows legitimate rebalance operations', () => {
  it('allows mint with recipient=SA', () => {
    const calls = [
      { to: NPM, data: mintData(SA), value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).not.toThrow();
  });

  it('allows collect with recipient=SA', () => {
    const calls = [
      { to: NPM, data: collectData(SA), value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).not.toThrow();
  });

  it('allows decreaseLiquidity (no recipient field)', () => {
    const calls = [
      { to: NPM, data: decreaseData(), value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).not.toThrow();
  });

  it('allows approve within cap (USDC=1000, WETH=0.1)', () => {
    const calls = [
      { to: USDC, data: approveData(NPM, 1000n * 10n ** 6n), value: 0n },
      { to: WETH, data: approveData(NPM, 10n ** 17n), value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).not.toThrow();
  });

  it('allows a full phase-2 batch (approve USDC + approve WETH + mint)', () => {
    const calls = [
      { to: USDC, data: approveData(NPM, 100n * 10n ** 6n), value: 0n },
      { to: WETH, data: approveData(NPM, 10n ** 16n), value: 0n },
      { to: NPM, data: mintData(SA), value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).not.toThrow();
  });

  it('allows exact cap (boundary test)', () => {
    const calls = [
      { to: USDC, data: approveData(NPM, MAX_APPROVE_AMOUNT_USDC), value: 0n },
      { to: WETH, data: approveData(NPM, MAX_APPROVE_AMOUNT_WETH), value: 0n },
    ];
    expect(() => assertCallsSafe(calls, SA)).not.toThrow();
  });
});

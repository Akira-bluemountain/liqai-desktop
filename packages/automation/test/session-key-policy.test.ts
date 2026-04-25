import { describe, it, expect } from 'vitest';
import {
  buildRebalancePolicy,
  isCallPermitted,
  describePolicyForUser,
  REBALANCE_ALLOWED_SELECTORS,
  MAX_SESSION_KEY_LIFETIME_SEC,
  MAX_REBALANCES_PER_DAY,
} from '../src/session-key-policy.js';
import { UNISWAP_V3_NPM_SELECTORS, UNISWAP_V3_ADDRESSES } from '@liqai/uniswap';

const SESSION_KEY = '0x1111111111111111111111111111111111111111';
const SMART_ACCOUNT = '0x2222222222222222222222222222222222222222';
const MAINNET = 1;

const baseInput = {
  chainId: MAINNET,
  sessionKeyAddress: SESSION_KEY,
  smartAccountAddress: SMART_ACCOUNT,
  lpTokenId: 42n,
  lifetimeSec: 7 * 24 * 60 * 60, // 7 days
  maxExecutionsPer24h: 5,
};

describe('buildRebalancePolicy', () => {
  it('produces a well-formed policy with safe defaults', () => {
    const policy = buildRebalancePolicy(baseInput);
    expect(policy.chainId).toBe(MAINNET);
    expect(policy.allowedTarget).toBe(
      UNISWAP_V3_ADDRESSES[1].nonfungiblePositionManager,
    );
    expect(policy.allowedSelectors).toEqual([...REBALANCE_ALLOWED_SELECTORS]);
    expect(policy.maxExecutionsPer24h).toBe(5);
    expect(policy.validUntil).toBeGreaterThan(policy.validAfter);
    expect(policy.lpTokenId).toBe(42n);
  });

  it('rejects unsupported chains (prevents session keys on wrong chain)', () => {
    expect(() =>
      buildRebalancePolicy({ ...baseInput, chainId: 137 }),
    ).toThrow(/not supported/);
  });

  it('rejects lifetimes exceeding the hard cap', () => {
    expect(() =>
      buildRebalancePolicy({
        ...baseInput,
        lifetimeSec: MAX_SESSION_KEY_LIFETIME_SEC + 1,
      }),
    ).toThrow();
  });

  it('rejects rate limits above the global cap', () => {
    expect(() =>
      buildRebalancePolicy({
        ...baseInput,
        maxExecutionsPer24h: MAX_REBALANCES_PER_DAY + 1,
      }),
    ).toThrow();
  });

  it('rejects zero or negative lifetimes', () => {
    expect(() =>
      buildRebalancePolicy({ ...baseInput, lifetimeSec: 0 }),
    ).toThrow();
    expect(() =>
      buildRebalancePolicy({ ...baseInput, lifetimeSec: -1 }),
    ).toThrow();
  });

  it('rejects malformed addresses', () => {
    expect(() =>
      buildRebalancePolicy({
        ...baseInput,
        sessionKeyAddress: 'not-an-address',
      }),
    ).toThrow();
    expect(() =>
      buildRebalancePolicy({
        ...baseInput,
        smartAccountAddress: '0x12',
      }),
    ).toThrow();
  });

  it('rejects non-positive tokenId', () => {
    expect(() =>
      buildRebalancePolicy({ ...baseInput, lpTokenId: 0n }),
    ).toThrow();
  });
});

describe('isCallPermitted', () => {
  const policy = buildRebalancePolicy(baseInput);
  const npmAddress = UNISWAP_V3_ADDRESSES[1].nonfungiblePositionManager;

  it('permits a call to NPM with a whitelisted selector', () => {
    const result = isCallPermitted(policy, {
      target: npmAddress,
      data: UNISWAP_V3_NPM_SELECTORS.decreaseLiquidity + '00'.repeat(32),
      value: 0n,
    });
    expect(result.allowed).toBe(true);
  });

  it('REJECTS a call that sends ETH (no native value allowed)', () => {
    const result = isCallPermitted(policy, {
      target: npmAddress,
      data: UNISWAP_V3_NPM_SELECTORS.decreaseLiquidity + '00'.repeat(32),
      value: 1n,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/ETH/);
  });

  it('REJECTS a call to a non-whitelisted target (attacker-controlled contract)', () => {
    const result = isCallPermitted(policy, {
      // All-lowercase is valid, not-checksummed — ethers accepts it.
      target: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      data: UNISWAP_V3_NPM_SELECTORS.decreaseLiquidity + '00'.repeat(32),
      value: 0n,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/allowlist/);
  });

  it('REJECTS a call with a non-whitelisted selector (e.g. approve)', () => {
    // 0x095ea7b3 = approve(address,uint256) — NOT allowed
    const result = isCallPermitted(policy, {
      target: npmAddress,
      data: '0x095ea7b3' + '00'.repeat(32),
      value: 0n,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/selector/);
  });

  it('REJECTS a call with calldata too short to contain a selector', () => {
    const result = isCallPermitted(policy, {
      target: npmAddress,
      data: '0x00',
      value: 0n,
    });
    expect(result.allowed).toBe(false);
  });

  it('REJECTS a call to an invalid address format (prevents type confusion)', () => {
    const result = isCallPermitted(policy, {
      target: 'not-an-address',
      data: UNISWAP_V3_NPM_SELECTORS.decreaseLiquidity + '00'.repeat(32),
      value: 0n,
    });
    expect(result.allowed).toBe(false);
  });

  it('REJECTS a call before validAfter and after validUntil', () => {
    // Construct a policy that is already expired
    const expired = {
      ...policy,
      validAfter: 100,
      validUntil: 200, // well in the past
    };
    const result = isCallPermitted(expired, {
      target: npmAddress,
      data: UNISWAP_V3_NPM_SELECTORS.decreaseLiquidity + '00'.repeat(32),
      value: 0n,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/expired/);

    const future = {
      ...policy,
      validAfter: Math.floor(Date.now() / 1000) + 3600,
      validUntil: Math.floor(Date.now() / 1000) + 7200,
    };
    const r2 = isCallPermitted(future, {
      target: npmAddress,
      data: UNISWAP_V3_NPM_SELECTORS.decreaseLiquidity + '00'.repeat(32),
      value: 0n,
    });
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toMatch(/not yet active/);
  });
});

describe('describePolicyForUser', () => {
  it('includes all safety-relevant fields for UI confirmation', () => {
    const policy = buildRebalancePolicy(baseInput);
    const summary = describePolicyForUser(policy);
    expect(summary).toMatch(/Smart Account:/);
    expect(summary).toMatch(/Permitted target:/);
    expect(summary).toMatch(/Permitted functions:/);
    expect(summary).toMatch(/Rate limit:/);
    expect(summary).toMatch(/ETH transfers: DISABLED/);
    expect(summary).toMatch(/Expires:/);
  });
});

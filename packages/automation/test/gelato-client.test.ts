import { describe, it, expect } from 'vitest';
import {
  InMemoryGelatoClient,
  validateTaskSpec,
} from '../src/gelato-client.js';
import { buildRebalancePolicy } from '../src/session-key-policy.js';

const baseInput = {
  chainId: 1,
  sessionKeyAddress: '0x1111111111111111111111111111111111111111',
  smartAccountAddress: '0x2222222222222222222222222222222222222222',
  lpTokenId: 42n,
  lifetimeSec: 7 * 24 * 60 * 60,
  maxExecutionsPer24h: 5,
};

describe('validateTaskSpec', () => {
  it('accepts a well-formed spec with resolverUrl', () => {
    const policy = buildRebalancePolicy(baseInput);
    const spec = validateTaskSpec({
      chainId: 1,
      policy,
      resolver: { resolverUrl: 'https://resolver.example.com/foo' },
      label: 'LP rebalance',
    });
    expect(spec.policy.sessionKeyAddress).toBe(policy.sessionKeyAddress);
  });

  it('REJECTS http:// resolver URLs (must be HTTPS)', () => {
    const policy = buildRebalancePolicy(baseInput);
    expect(() =>
      validateTaskSpec({
        chainId: 1,
        policy,
        resolver: { resolverUrl: 'http://resolver.example.com' },
        label: 'x',
      }),
    ).toThrow();
  });

  it('REJECTS a spec with neither URL nor on-chain resolver', () => {
    const policy = buildRebalancePolicy(baseInput);
    expect(() =>
      validateTaskSpec({
        chainId: 1,
        policy,
        resolver: {},
        label: 'x',
      }),
    ).toThrow();
  });

  it('accepts an on-chain resolver', () => {
    const policy = buildRebalancePolicy(baseInput);
    const spec = validateTaskSpec({
      chainId: 1,
      policy,
      resolver: {
        resolverContract: '0x3333333333333333333333333333333333333333',
        resolverData: '0x12345678',
      },
      label: 'x',
    });
    expect(spec.resolver.resolverContract).toBeDefined();
  });

  it('REJECTS a malformed resolver contract address', () => {
    const policy = buildRebalancePolicy(baseInput);
    expect(() =>
      validateTaskSpec({
        chainId: 1,
        policy,
        resolver: { resolverContract: 'not-addr', resolverData: '0x12' },
        label: 'x',
      }),
    ).toThrow();
  });

  it('REJECTS resolver data not starting with 0x', () => {
    const policy = buildRebalancePolicy(baseInput);
    expect(() =>
      validateTaskSpec({
        chainId: 1,
        policy,
        resolver: {
          resolverContract: '0x3333333333333333333333333333333333333333',
          resolverData: 'invalid',
        },
        label: 'x',
      }),
    ).toThrow();
  });

  it('REJECTS overlong label (UI DoS guard)', () => {
    const policy = buildRebalancePolicy(baseInput);
    expect(() =>
      validateTaskSpec({
        chainId: 1,
        policy,
        resolver: { resolverUrl: 'https://r.example' },
        label: 'x'.repeat(500),
      }),
    ).toThrow();
  });
});

describe('InMemoryGelatoClient', () => {
  it('registers and lists tasks', async () => {
    const client = new InMemoryGelatoClient();
    const policy = buildRebalancePolicy(baseInput);
    const task = await client.registerTask({
      chainId: 1,
      policy,
      resolver: { resolverUrl: 'https://r.example' },
      label: 'My LP',
    });
    expect(task.taskId).toMatch(/^0x[a-f0-9]{64}$/);
    expect(task.smartAccountAddress).toBe(policy.smartAccountAddress);

    const listed = await client.listTasks(policy.smartAccountAddress);
    expect(listed).toHaveLength(1);
  });

  it('cancels tasks', async () => {
    const client = new InMemoryGelatoClient();
    const policy = buildRebalancePolicy(baseInput);
    const task = await client.registerTask({
      chainId: 1,
      policy,
      resolver: { resolverUrl: 'https://r.example' },
      label: 'x',
    });
    await client.cancelTask(task.taskId);
    const listed = await client.listTasks(policy.smartAccountAddress);
    expect(listed).toHaveLength(0);
  });

  it('throws when cancelling a non-existent task', async () => {
    const client = new InMemoryGelatoClient();
    await expect(
      client.cancelTask(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ),
    ).rejects.toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { MemoryRateLimiter } from '../src/rate-limiter.js';

const KEY = '0x1111111111111111111111111111111111111111';

describe('MemoryRateLimiter', () => {
  it('starts at zero', async () => {
    const rl = new MemoryRateLimiter();
    expect(await rl.countPast24h(KEY)).toBe(0);
    expect(await rl.canExecute(KEY, 5)).toBe(true);
  });

  it('counts executions within the 24h window', async () => {
    const rl = new MemoryRateLimiter();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 3; i++) {
      await rl.record({
        timestamp: now,
        action: 'rebalance',
        sessionKeyAddress: KEY,
      });
    }
    expect(await rl.countPast24h(KEY)).toBe(3);
    expect(await rl.canExecute(KEY, 5)).toBe(true);
    expect(await rl.canExecute(KEY, 3)).toBe(false);
  });

  it('excludes events older than 24h', async () => {
    const rl = new MemoryRateLimiter();
    const now = Math.floor(Date.now() / 1000);
    await rl.record({
      timestamp: now - 25 * 60 * 60, // 25h ago
      action: 'rebalance',
      sessionKeyAddress: KEY,
    });
    await rl.record({
      timestamp: now,
      action: 'rebalance',
      sessionKeyAddress: KEY,
    });
    expect(await rl.countPast24h(KEY)).toBe(1);
  });

  it('tracks different session keys separately', async () => {
    const rl = new MemoryRateLimiter();
    const other = '0x2222222222222222222222222222222222222222';
    const now = Math.floor(Date.now() / 1000);
    await rl.record({
      timestamp: now,
      action: 'rebalance',
      sessionKeyAddress: KEY,
    });
    await rl.record({
      timestamp: now,
      action: 'rebalance',
      sessionKeyAddress: other,
    });
    expect(await rl.countPast24h(KEY)).toBe(1);
    expect(await rl.countPast24h(other)).toBe(1);
  });
});

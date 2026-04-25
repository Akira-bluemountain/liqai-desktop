import { describe, it, expect } from 'vitest';
import { MemoryAuditLog, makeEvent, type AuditEvent } from '../src/audit-log.js';

const ADDR = '0x1111111111111111111111111111111111111111';

describe('MemoryAuditLog', () => {
  it('appends and lists events', async () => {
    const log = new MemoryAuditLog();
    await log.append(
      makeEvent('session_key:created', {
        actorAddress: ADDR,
        chainId: 1,
        description: 'Created rebalance session key',
      }),
    );
    const events = await log.list();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('session_key:created');
  });

  it('filters by actorAddress', async () => {
    const log = new MemoryAuditLog();
    await log.append(makeEvent('smart_account:deployed', {
      actorAddress: ADDR,
      description: 'A',
    }));
    await log.append(makeEvent('smart_account:deployed', {
      actorAddress: '0x2222222222222222222222222222222222222222',
      description: 'B',
    }));
    const filtered = await log.list({ actorAddress: ADDR });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.description).toBe('A');
  });

  it('REJECTS an event with a private-key-like value in metadata', async () => {
    const log = new MemoryAuditLog();
    const event: AuditEvent = {
      timestamp: Math.floor(Date.now() / 1000),
      action: 'session_key:created',
      actorAddress: ADDR,
      description: 'leak attempt',
      // A random 32-byte hex that is NOT a txHash; the schema must reject.
      metadata: { secretValue: '0x' + 'a'.repeat(64) },
    };
    await expect(log.append(event)).rejects.toThrow();
  });

  it('REJECTS an event with metadata keys hinting at secret material', async () => {
    const log = new MemoryAuditLog();
    const event: AuditEvent = {
      timestamp: Math.floor(Date.now() / 1000),
      action: 'session_key:created',
      actorAddress: ADDR,
      description: 'x',
      metadata: { privateKey: 'obviously-not-this' },
    };
    await expect(log.append(event)).rejects.toThrow();
  });

  it('accepts a valid txHash field', async () => {
    const log = new MemoryAuditLog();
    const event: AuditEvent = {
      timestamp: Math.floor(Date.now() / 1000),
      action: 'lp_position:minted',
      actorAddress: ADDR,
      description: 'Mint tx submitted',
      txHash: '0x' + 'b'.repeat(64),
    };
    await expect(log.append(event)).resolves.not.toThrow();
  });

  it('REJECTS events with malformed actor address', async () => {
    const log = new MemoryAuditLog();
    const event: AuditEvent = {
      timestamp: Math.floor(Date.now() / 1000),
      action: 'session_key:created',
      actorAddress: 'not-an-address',
      description: 'x',
    };
    await expect(log.append(event)).rejects.toThrow();
  });

  it('REJECTS events with empty or overlong description', async () => {
    const log = new MemoryAuditLog();
    await expect(
      log.append({
        timestamp: Math.floor(Date.now() / 1000),
        action: 'smart_account:deployed',
        actorAddress: ADDR,
        description: '',
      }),
    ).rejects.toThrow();

    await expect(
      log.append({
        timestamp: Math.floor(Date.now() / 1000),
        action: 'smart_account:deployed',
        actorAddress: ADDR,
        description: 'x'.repeat(501),
      }),
    ).rejects.toThrow();
  });
});

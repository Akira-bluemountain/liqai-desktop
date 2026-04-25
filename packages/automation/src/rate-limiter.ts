/**
 * Client-side rate limiter for session key executions.
 *
 * The on-chain Smart Account enforces the authoritative rate limit. This
 * client-side mirror protects against accidentally queuing too many tasks
 * in Gelato (which would waste gas on reverts).
 *
 * SECURITY NOTE:
 *   This limiter is NOT sufficient by itself — the attacker could bypass
 *   it by running a modified client. It exists purely as a defence against
 *   our own bugs. The true enforcement is in the session key module policy.
 */

export interface ExecutionRecord {
  readonly timestamp: number;
  readonly action: string;
  readonly sessionKeyAddress: string;
}

export interface RateLimiter {
  /** Record that an execution was requested. */
  record(entry: ExecutionRecord): Promise<void>;
  /** Count executions by a given session key in the last 24h. */
  countPast24h(sessionKeyAddress: string): Promise<number>;
  /** Check whether another execution would exceed the limit. */
  canExecute(sessionKeyAddress: string, maxPer24h: number): Promise<boolean>;
}

/**
 * In-memory rate limiter. Good enough for unit tests and short-lived
 * processes. Production app uses SQLite-backed implementation.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly records: ExecutionRecord[] = [];

  async record(entry: ExecutionRecord): Promise<void> {
    this.records.push(entry);
    this.prune();
  }

  async countPast24h(sessionKeyAddress: string): Promise<number> {
    this.prune();
    const key = sessionKeyAddress.toLowerCase();
    return this.records.filter((r) => r.sessionKeyAddress.toLowerCase() === key)
      .length;
  }

  async canExecute(
    sessionKeyAddress: string,
    maxPer24h: number,
  ): Promise<boolean> {
    const count = await this.countPast24h(sessionKeyAddress);
    return count < maxPer24h;
  }

  /** Drop records older than 24h. */
  private prune(): void {
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    // In-place filter (preserving readonly shape externally).
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record && record.timestamp < cutoff) {
        this.records.splice(i, 1);
      }
    }
  }
}

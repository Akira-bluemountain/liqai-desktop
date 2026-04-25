/**
 * @liqai/automation — Smart Account + session key + Gelato automation client.
 *
 * This package holds all logic for non-custodial 24/7 automation. The key
 * insight is: the user's wallet signs the session key *grant*, and from that
 * moment Gelato can trigger rebalances within the scoped permissions until
 * the session key expires. LiqAI itself never holds any signing key.
 */

export {
  buildRebalancePolicy,
  isCallPermitted,
  describePolicyForUser,
  REBALANCE_ALLOWED_SELECTORS,
  MAX_SESSION_KEY_LIFETIME_SEC,
  MAX_REBALANCES_PER_DAY,
  type SessionKeyPolicy,
} from './session-key-policy.js';

export {
  MemoryRateLimiter,
  type RateLimiter,
  type ExecutionRecord,
} from './rate-limiter.js';

export {
  MemoryAuditLog,
  makeEvent,
  type AuditEvent,
  type AuditAction,
  type AuditLogStorage,
} from './audit-log.js';

export {
  InMemoryGelatoClient,
  validateTaskSpec,
  GELATO_AUTOMATE_ADDRESSES,
  type GelatoClient,
  type RebalanceTaskSpec,
  type RegisteredTask,
  type ResolverConfig,
} from './gelato-client.js';

export {
  generateSessionKey,
  type SmartAccount,
  type SmartAccountClient,
} from './smart-account.js';

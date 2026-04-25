/**
 * Centralised debug logging. Calls are no-ops in production bundles unless
 * NEXT_PUBLIC_LIQAI_DEBUG=true is set at build time.
 *
 * Why this exists: the session-key load path, rebalance executor, and bot
 * tick previously logged permission IDs, signer addresses, bundler gas
 * params, and other internal state via `console.info`. That's fine during
 * development but leaks surface area to anyone who opens DevTools in a
 * shipped build. Errors (`console.error`) still log unconditionally —
 * users need to see those to report issues.
 */

// process.env access is statically inlined by Next.js at build time. The
// typeof guard keeps this file safe to import from non-Next contexts too.
export const DEBUG_LOGS_ENABLED =
  typeof process !== 'undefined' &&
  process.env?.NEXT_PUBLIC_LIQAI_DEBUG === 'true';

export function debugLog(...args: unknown[]): void {
  if (DEBUG_LOGS_ENABLED) {
    // eslint-disable-next-line no-console
    console.info(...args);
  }
}

export function debugWarn(...args: unknown[]): void {
  if (DEBUG_LOGS_ENABLED) {
    // eslint-disable-next-line no-console
    console.warn(...args);
  }
}

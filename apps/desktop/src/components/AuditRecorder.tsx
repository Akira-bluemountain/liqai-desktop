'use client';

/**
 * AuditRecorder — watches wallet state and writes audit-log entries for
 * user-visible security events.
 *
 * Events currently recorded:
 *   - `wallet_connected` / `wallet_disconnected`: any change in the EOA
 *     address connected to the app.
 *
 * Future events (added as flows ship):
 *   - `smart_account_deployed`
 *   - `lp_position_minted`
 *   - `session_key_installed` / `_revoked`
 *   - `gelato_task_registered`
 *
 * This component renders nothing. Mount it once at the app shell.
 *
 * SECURITY:
 *   - Writes go through writeAudit() which validates inputs and rejects
 *     anything shaped like a private key.
 *   - Never writes on every render — only on actual state transitions.
 *   - Writes are best-effort: DB errors are logged to console but never
 *     surfaced to users or interrupt flows.
 */

import { useEffect, useRef } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { writeAudit } from '../lib/db';
import { useIsMounted } from '../lib/useIsMounted';

export function AuditRecorder() {
  const mounted = useIsMounted();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const lastSeenAddress = useRef<string | null>(null);

  useEffect(() => {
    if (!mounted) return;
    const current = isConnected && address ? address : null;
    const previous = lastSeenAddress.current;
    if (current === previous) return;

    // On first mount with an already-connected wallet we want to record a
    // `session_resumed` (not a fresh `wallet_connected`) so the audit log
    // accurately distinguishes an actual user action from a page reload.
    // We detect this by checking whether `previous` is the initial null.
    const isInitialMount = previous === null && current !== null;

    if (current) {
      writeAudit({
        action: isInitialMount ? 'session_resumed' : 'wallet_connected',
        actor_address: current,
        chain_id: chainId,
        description: isInitialMount
          ? `Session resumed for EOA ${current} on chain ${chainId}`
          : `EOA ${current} connected on chain ${chainId}`,
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[LiqAI] audit write failed:', err);
      });
    } else if (previous) {
      writeAudit({
        action: 'wallet_disconnected',
        actor_address: previous,
        description: `EOA ${previous} disconnected`,
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[LiqAI] audit write failed:', err);
      });
    }
    lastSeenAddress.current = current;
  }, [mounted, address, isConnected, chainId]);

  return null;
}

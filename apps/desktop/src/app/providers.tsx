'use client';

/**
 * Root-level providers for the LiqAI desktop app.
 *
 *   - WagmiProvider      → wallet / chain state
 *   - QueryClientProvider→ data fetching cache
 *
 * SECURITY: No secrets are passed through providers. The config module is
 * the single source of chain/RPC truth.
 *
 * NOTE: We intentionally do NOT use RainbowKit or Reown's AppKit modal.
 * See src/config/wagmi.ts for the reasoning.
 */

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig } from '../config/wagmi';

/**
 * Patterns of WalletConnect transient errors that we intentionally
 * swallow to prevent Next.js's dev overlay from showing a red screen.
 */
const TRANSIENT_WALLET_ERROR_PATTERNS = [
  /connection interrupted while trying to subscribe/i,
  /connection request reset/i,
  /user rejected/i,
  /request expired/i,
  /proposal expired/i,
  /websocket connection/i,
  /no matching key/i,
];

function isTransientWalletError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
      ? err
      : err && typeof err === 'object' && 'message' in err
      ? String((err as { message: unknown }).message)
      : '';
  return TRANSIENT_WALLET_ERROR_PATTERNS.some((rx) => rx.test(msg));
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            retry: 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  useEffect(() => {
    // Capture phase + stopImmediatePropagation so we run BEFORE Next.js's
    // dev overlay listener (which registers at module init in bubble phase)
    // and prevent it from receiving the event at all.
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isTransientWalletError(event.reason)) {
        // eslint-disable-next-line no-console
        console.warn('[LiqAI] Swallowed transient wallet error:', event.reason);
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const onError = (event: ErrorEvent) => {
      if (isTransientWalletError(event.error ?? event.message)) {
        // eslint-disable-next-line no-console
        console.warn('[LiqAI] Swallowed transient wallet error:', event.error);
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection, { capture: true });
    window.addEventListener('error', onError, { capture: true });
    return () => {
      window.removeEventListener('unhandledrejection', onUnhandledRejection, { capture: true });
      window.removeEventListener('error', onError, { capture: true });
    };
  }, []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

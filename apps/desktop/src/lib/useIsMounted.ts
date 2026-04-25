'use client';

import { useEffect, useState } from 'react';

/**
 * Returns true only after the component has mounted on the client.
 *
 * Use this to gate rendering of any UI that depends on browser-only state
 * (wagmi wallet connection, localStorage, window, etc.) so that the
 * server-rendered (or statically exported) HTML matches the first client
 * render — preventing React hydration mismatches.
 *
 * Pattern:
 *   const mounted = useIsMounted();
 *   if (!mounted) return <PlaceholderMatchingSSR />;
 *   return <ClientOnlyUI />;
 */
export function useIsMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

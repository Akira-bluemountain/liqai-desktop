'use client';

/**
 * WalletConnectQR — LiqAI's own QR-only connection UI.
 *
 * Why not Reown's AppKit modal / RainbowKit?
 *   In a Tauri WebView, Reown's modal renders a wallet-button grid
 *   ("MetaMask / SafePal / Trust / ..."). Clicking any of those tries to
 *   deep-link to that wallet's universal link on the SAME machine. On a
 *   desktop running Tauri that fails (no browser extension, no mobile
 *   wallet on the Mac), and the modal then closes. WalletConnect's
 *   EthereumProvider watches for modal state changes:
 *
 *     subscribeState(h => {
 *       !h.open && !this.signer.session && (
 *         this.signer.abortPairingAttempt(),
 *         reject(new Error("Connection request reset. Please try again."))
 *       )
 *     })
 *
 *   so the moment the modal closes, the pairing is aborted with that
 *   confusing error.
 *
 * This component avoids the problem entirely by:
 *   - Using walletConnect({ showQrModal: false }) in wagmi config
 *   - Listening for the `display_uri` event directly from the connector
 *   - Rendering the QR ourselves
 *   - Keeping our dialog open until the user explicitly cancels or the
 *     session is established
 *
 * SECURITY:
 *   - No private keys handled here.
 *   - The WalletConnect URI contains the pairing topic and a symmetric
 *     key for the relay session. It's short-lived and only useful to a
 *     wallet that scans it. Safe to display on screen.
 */

import { useEffect, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { useIsMounted } from '../lib/useIsMounted';

type ViewState = 'idle' | 'awaiting-uri' | 'showing-qr' | 'connecting' | 'error';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function WalletConnectQR({ open, onClose }: Props) {
  const { connect, connectors, isPending } = useConnect();
  const { isConnected } = useAccount();
  const [uri, setUri] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const wcConnector = connectors.find((c) => c.id === 'walletConnect');

  // Kick off a connection attempt when the dialog opens.
  useEffect(() => {
    if (!open) {
      // Reset on close
      setUri(null);
      setQrDataUrl(null);
      setView('idle');
      setErrorMessage(null);
      return;
    }
    if (isConnected) {
      onClose();
      return;
    }
    if (!wcConnector) {
      setErrorMessage('WalletConnect connector not found in wagmi config');
      setView('error');
      return;
    }

    setView('awaiting-uri');
    setErrorMessage(null);

    // Listen for the URI from the connector provider
    let cancelled = false;

    type WcProvider = {
      on: (event: 'display_uri', handler: (uri: string) => void) => void;
      off: (event: 'display_uri', handler: (uri: string) => void) => void;
    };

    const getProviderAndListen = async (): Promise<(() => void) | undefined> => {
      try {
        const provider = (await (
          wcConnector as { getProvider: () => Promise<WcProvider> }
        ).getProvider()) as WcProvider;
        if (cancelled) return undefined;
        const handler = (newUri: string) => {
          if (cancelled) return;
          setUri(newUri);
          setView('showing-qr');
        };
        provider.on('display_uri', handler);
        return () => provider.off('display_uri', handler);
      } catch (err) {
        if (cancelled) return undefined;
        setErrorMessage(err instanceof Error ? err.message : 'Failed to init');
        setView('error');
        return undefined;
      }
    };
    const listenerCleanupPromise = getProviderAndListen();

    // Initiate connection — this is what generates the URI
    connect(
      { connector: wcConnector },
      {
        onError: (err) => {
          if (cancelled) return;
          // Swallow known transient errors silently
          const msg = err.message ?? String(err);
          if (/connection request reset|user rejected/i.test(msg)) {
            // User cancelled — just close
            onClose();
            return;
          }
          setErrorMessage(msg);
          setView('error');
        },
        onSuccess: () => {
          if (cancelled) return;
          setView('connecting');
          // Dialog will close itself via useEffect watching isConnected
          onClose();
        },
      },
    );

    return () => {
      cancelled = true;
      listenerCleanupPromise.then((cleanup) => cleanup?.());
    };
  }, [open, isConnected, wcConnector, connect, onClose]);

  // Generate QR data URL when URI is available
  useEffect(() => {
    if (!uri) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(uri, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: {
        dark: '#0b0d12',
        light: '#ffffff',
      },
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMessage(
            'Failed to render QR code: ' +
              (err instanceof Error ? err.message : String(err)),
          );
          setView('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  const handleCancel = useCallback(() => {
    onClose();
  }, [onClose]);

  const copyUri = useCallback(() => {
    if (!uri) return;
    navigator.clipboard
      .writeText(uri)
      .then(() => {
        // eslint-disable-next-line no-console
        console.info('[LiqAI] WC URI copied to clipboard');
      })
      .catch(() => {
        // ignore
      });
  }, [uri]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={handleCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.6)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: 32,
          maxWidth: 460,
          width: '90%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>Scan with your wallet</h2>
          <button
            onClick={handleCancel}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: 24,
              cursor: 'pointer',
              padding: 4,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {view === 'awaiting-uri' && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)' }}>
            Generating connection code…
          </div>
        )}

        {view === 'showing-qr' && qrDataUrl && (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                background: '#fff',
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrDataUrl} alt="WalletConnect QR code" width={320} height={320} />
            </div>
            <ol
              style={{
                color: 'var(--text-secondary)',
                fontSize: 13,
                lineHeight: 1.7,
                paddingLeft: 20,
                marginBottom: 16,
              }}
            >
              <li>
                Open <strong>MetaMask Mobile</strong>, <strong>Rainbow</strong>, or any
                WalletConnect-compatible wallet on your phone.
              </li>
              <li>Make sure the wallet is on <strong>Ethereum mainnet</strong>.</li>
              <li>Use the wallet's scan feature to scan this QR code.</li>
              <li>Approve the connection on your phone.</li>
            </ol>
            <button
              onClick={copyUri}
              style={{
                width: '100%',
                padding: 10,
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--text-secondary)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Copy connection URI instead
            </button>
          </>
        )}

        {view === 'error' && (
          <div>
            <p
              style={{
                color: 'var(--danger)',
                background: 'rgba(248, 113, 113, 0.1)',
                border: '1px solid rgba(248, 113, 113, 0.3)',
                borderRadius: 8,
                padding: 12,
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {errorMessage ?? 'Unknown error'}
            </p>
            <button
              onClick={handleCancel}
              style={{
                width: '100%',
                padding: 10,
                background: 'var(--accent)',
                color: '#0b0d12',
                border: 'none',
                borderRadius: 8,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
        )}

        {isPending && view !== 'error' && (
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center', marginTop: 12 }}>
            Waiting for wallet…
          </p>
        )}
      </div>
    </div>
  );
}

/** Small helper — shows "Connect Wallet" button or "Connected: 0x…" with disconnect. */
export function ConnectControl() {
  const mounted = useIsMounted();
  const { address, isConnected: rawIsConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);

  // Until we've mounted, render the disconnected-state UI to match the
  // static export's HTML and avoid React hydration mismatch when WC
  // restores a session from localStorage.
  const isConnected = mounted && rawIsConnected;

  if (isConnected && address) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code
          style={{
            background: 'var(--bg-elevated)',
            padding: '6px 10px',
            borderRadius: 8,
            fontSize: 12,
          }}
        >
          {address.slice(0, 6)}…{address.slice(-4)}
        </code>
        <button
          onClick={() => disconnect()}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
            padding: '6px 12px',
            borderRadius: 8,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          background: 'var(--accent)',
          color: '#0b0d12',
          border: 'none',
          borderRadius: 8,
          padding: '10px 20px',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Connect Wallet
      </button>
      <WalletConnectQR open={open} onClose={() => setOpen(false)} />
    </>
  );
}

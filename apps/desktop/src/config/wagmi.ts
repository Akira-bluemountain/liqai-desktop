/**
 * Wagmi configuration for LiqAI.
 *
 * Architecture (docs/security-v2.md + docs/architecture-v2.md):
 *   - Non-custodial: the user's private key never leaves their wallet.
 *   - Single connection path: WalletConnect v2 with a QR code scanned by a
 *     mobile / hardware wallet. There is NO "click-a-wallet-icon-to-
 *     deep-link" path because Tauri's WebView has no extension API and
 *     cannot cleanly deep-link to mobile wallet universal links on the
 *     same machine.
 *   - Ethereum mainnet ONLY.
 *
 * IMPORTANT: We use wagmi's walletConnect connector directly and set
 * showQrModal=false so that Reown's AppKit modal is never opened. The
 * Reown modal, in a Tauri environment, shows a wallet-button grid that
 * tries to deep-link into individual wallets; clicking those buttons
 * triggers "Connection request reset" because the dApp modal closes
 * before the pairing completes (see
 * @walletconnect/ethereum-provider/src/index.ts lines around
 * `subscribeState(h => !h.open && !this.signer.session && ...)`).
 *
 * Our own QR component (<WalletConnectQR />) listens for display_uri
 * directly and owns the full UX.
 *
 * IMPORTANT — env var access must be STATIC (process.env.NEXT_PUBLIC_FOO),
 * NEVER dynamic (process.env[name]). Webpack only replaces the static form.
 */

import { createConfig, http } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { walletConnect } from 'wagmi/connectors';

/** WalletConnect Cloud project id (free at https://cloud.walletconnect.com). */
const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID &&
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID.length > 0
    ? process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
    : 'liqai-dev-placeholder';

if (walletConnectProjectId === 'liqai-dev-placeholder') {
  // eslint-disable-next-line no-console
  console.warn(
    '[LiqAI] No NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID configured. ' +
      'WalletConnect will fail. Set a real id from https://cloud.walletconnect.com ' +
      'in apps/desktop/.env.local and restart.',
  );
}

const alchemyApiKey =
  process.env.NEXT_PUBLIC_ALCHEMY_API_KEY &&
  process.env.NEXT_PUBLIC_ALCHEMY_API_KEY.length > 0
    ? process.env.NEXT_PUBLIC_ALCHEMY_API_KEY
    : '';

const mainnetRpcUrl = alchemyApiKey
  ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
  // Ankr's public mainnet RPC handles arbitrary eth_call well (including
  // Uniswap V3 pool reads). Cloudflare returned "Internal error" for
  // factory.getPool; llamarpc had batching issues. No API key required,
  // rate-limited but fine for single-user desktop dev.
  : 'https://rpc.ankr.com/eth';

/** Exported so non-wagmi paths (ethers provider for @liqai/uniswap helpers,
 * Tauri Rust side, etc.) can use the SAME RPC endpoint and inherit any
 * future fallback / failover logic added here. */
export const MAINNET_RPC_URL = mainnetRpcUrl;

export const WALLET_CONNECT_PROJECT_ID = walletConnectProjectId;

/**
 * Single connector: WalletConnect v2. No injected/extension connectors
 * because Tauri's WebView cannot host browser extensions.
 *
 * `showQrModal: false` is CRITICAL — it disables Reown's built-in modal
 * (which misbehaves in Tauri, see docstring above) and exposes the
 * `display_uri` event so we render the QR ourselves.
 */
export const wagmiConfig = createConfig({
  chains: [mainnet],
  connectors: [
    walletConnect({
      projectId: walletConnectProjectId,
      showQrModal: false,
      metadata: {
        name: 'LiqAI',
        description: 'Non-custodial AI-powered Uniswap V3 LP management',
        url: 'https://liqai.app',
        icons: ['https://liqai.app/icon.png'],
      },
    }),
  ],
  transports: {
    [mainnet.id]: http(mainnetRpcUrl),
  },
  ssr: false,
});

export { mainnet };

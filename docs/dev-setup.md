# LiqAI v2 — Developer Setup

## Prerequisites

### 1. Node.js & npm
- Node.js **20 or later**
- npm **10 or later**

Verify:
```bash
node --version   # v20.x or higher
npm --version    # 10.x or higher
```

### 2. Rust toolchain (required for Tauri)

Install via [rustup](https://rustup.rs/):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Verify
cargo --version   # cargo 1.77+
rustc --version   # rustc 1.77+
```

### 3. Platform-specific Tauri dependencies

**macOS**:
- Xcode Command Line Tools: `xcode-select --install`
- (No other dependencies needed)

**Windows**:
- [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (usually pre-installed on Win10+)
- [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

**Linux**:
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
  build-essential \
  curl wget file \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

### 4. External API keys

Create [.env.example](../.env.example) based on these and populate your own values:

| Variable | Source | Notes |
|----------|--------|-------|
| `NEXT_PUBLIC_ALCHEMY_API_KEY` | https://alchemy.com | Ethereum RPC |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | https://cloud.walletconnect.com | Wallet integration |
| `NEXT_PUBLIC_ZERODEV_PROJECT_ID` | https://dashboard.zerodev.app | Smart Account (Kernel) |
| `NEXT_PUBLIC_GELATO_API_KEY` | https://app.gelato.network | 24/7 automation |
| `NEXT_PUBLIC_COINGECKO_API_KEY` | (optional) https://coingecko.com | Higher rate limits |

**Security note**: None of these are signing keys. They are scoped API keys for reading/registering tasks. Do not commit your `.env` file.

---

## Install & verify

```bash
cd /path/to/liqai
npm install

# Verify every package builds + tests pass
cd packages/ai && npx vitest run && npx tsc -p tsconfig.json
cd ../uniswap && npx vitest run && npx tsc -p tsconfig.json
cd ../automation && npx vitest run && npx tsc -p tsconfig.json
```

Expected: **119/119 tests passing**.

---

## Run the desktop app (dev mode)

```bash
cd apps/desktop
npm run tauri:dev
```

This will:
1. Start the Next.js dev server on `http://localhost:3000`
2. Compile the Rust backend (first run takes several minutes)
3. Launch a Tauri WebView window pointing at the dev server
4. Auto-reload the UI on code changes

On first run, Tauri may prompt for permissions (keychain access on macOS) to initialise Stronghold.

---

## Build for production

```bash
cd apps/desktop
npm run tauri:build
```

Output:
- macOS: `src-tauri/target/release/bundle/dmg/LiqAI_0.1.0_*.dmg`
- Windows: `src-tauri/target/release/bundle/msi/LiqAI_0.1.0_*.msi`
- Linux: `src-tauri/target/release/bundle/{deb,appimage}/LiqAI_0.1.0_*.{deb,AppImage}`

**For public distribution**, binaries MUST be code-signed. Local builds are for testing only. See [SECURITY.md](../docs/security-v2.md) §S2.4.

---

## Package layout quick reference

```
apps/desktop/
├── src/                    # Next.js frontend (React)
├── src-tauri/
│   ├── src/                # Rust backend (sandboxed)
│   ├── migrations/         # SQLite schema
│   ├── capabilities/       # Tauri IPC allowlist
│   └── tauri.conf.json     # App + CSP config
│
packages/
├── ai/                     # Range optimisation, rebalance triggers
├── uniswap/                # Tx builders for Uniswap V3 NPM
└── automation/             # Smart Account, session keys, Gelato
```

Each package is an independent npm workspace with its own tests.

---

## Common troubleshooting

### "cargo not found"
You haven't installed Rust yet. Go back to Prerequisites §2.

### "failed to run custom build command for `openssl-sys`" (Linux)
Install OpenSSL development headers: `sudo apt install libssl-dev pkg-config`

### Tauri window is blank / stuck on splash
Check the browser DevTools in the Tauri window (right-click → Inspect Element). A CSP violation is the most common cause — inspect the Console for a `Refused to ...` message and update [tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json) `security.csp`.

### "Module not found: '@liqai/ai'"
You need to build the internal packages first:
```bash
cd packages/ai && npx tsc
cd ../uniswap && npx tsc
cd ../automation && npx tsc
```
Then re-run the dev server.

---

## Running only the AI/Uniswap/Automation tests without Tauri

If you're iterating on the pure-TS logic and don't need to launch the app:

```bash
cd packages/ai && npx vitest --watch
```

All three packages are independent — you can work on them without installing Rust.

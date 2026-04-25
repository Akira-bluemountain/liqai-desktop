# LiqAI v2 Architecture — Non-Custodial Local-First

**Status**: Design document for the rearchitecture from SaaS Vault to local desktop application.

**Date**: 2026-04-13

---

## 1. Core Principles

### 1.1 Non-Custodial by Design
- **LiqAI never holds user funds.** Users retain 100% custody of their USDC, WETH, and LP NFTs at all times.
- **No operator private key exists.** The backend / cloud component has no signing capability.
- **No shared Vault contract.** Each user owns their own Uniswap V3 LP positions directly.

### 1.2 User-Owned Smart Accounts
- Each user controls a **Smart Account** (ERC-4337 / Kernel by ZeroDev) funded from their own EOA wallet.
- The Smart Account owns the Uniswap V3 LP NFT.
- The Smart Account can delegate **scoped session keys** for automation.

### 1.3 Scoped Session Keys for Automation
- To enable 24/7 rebalance without user presence, a **session key** is granted to Gelato's automation network.
- The session key is **cryptographically restricted** to only:
  - Call Uniswap V3 `NonfungiblePositionManager` (and nothing else)
  - Call specific functions (`decreaseLiquidity`, `collect`, `mint`)
  - Operate on the user's own LP NFT (via `tokenId` whitelist)
  - Execute at most N times per day
  - Remain valid for a limited period (e.g., 30 days, renewable)
- **Even if the session key is fully compromised, the attacker cannot:**
  - Transfer user funds to an external address
  - Interact with any contract other than Uniswap V3 NPM
  - Access the user's main EOA wallet
  - Exceed the per-day rebalance limit

### 1.4 Local-First Execution
- AI computation runs entirely on the user's machine.
- All sensitive data (position history, keys, audit logs) stays in local SQLite.
- No telemetry. No cloud database. No shared state.

### 1.5 Defense in Depth
- On-chain: Session key policy enforcement
- App layer: Rate limits, input validation, sanity bounds on every tick/price
- UI layer: Explicit user confirmation for session key creation with full scope display
- Supply chain: Pinned dependencies, reproducible builds, code signing

---

## 2. System Topology

```
┌─────────────────────────────────────────────────────────────┐
│                      User's Machine                         │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  LiqAI Desktop App (Tauri)                           │   │
│  │  ┌───────────────┐  ┌──────────────┐  ┌───────────┐  │   │
│  │  │ Next.js UI    │→ │ AI Engine    │→ │ SQLite    │  │   │
│  │  │ (React)       │  │ (TypeScript) │  │ (local)   │  │   │
│  │  └───────┬───────┘  └──────────────┘  └───────────┘  │   │
│  │          │                                           │   │
│  │          ↓ (Rust backend, sandboxed)                 │   │
│  │  ┌───────────────────────────────────────────────┐   │   │
│  │  │ Tauri Core (signing flows, RPC, file I/O)     │   │   │
│  │  └───────────┬───────────────────┬───────────────┘   │   │
│  └──────────────┼───────────────────┼───────────────────┘   │
│                 ↓                   ↓                       │
│     ┌────────────────────┐  ┌────────────────────┐          │
│     │ MetaMask / WC v2   │  │ JSON-RPC (public)  │          │
│     │ (user's wallet)    │  │ e.g., Alchemy      │          │
│     └────────────────────┘  └────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
                 │                   │
                 ↓                   ↓
┌────────────────────────────────────────────────────────────┐
│                    Ethereum Mainnet                        │
│                                                            │
│  User's EOA ──owns──→ User's Smart Account (Kernel)        │
│                             │                              │
│                             ├─ owns LP NFT                 │
│                             │                              │
│                             └─ grants session key ──┐      │
│                                                     ↓      │
│                                              Gelato Task   │
│                                                     ↓      │
│                                     Uniswap V3 NPM         │
└────────────────────────────────────────────────────────────┘
                                                     ↑
                 ┌───────────────────────────────────┘
                 │
┌────────────────┴────────────────┐
│     Gelato Automate Network     │
│  (24/7 keeper bots, no keys     │
│   held by LiqAI developer)      │
└─────────────────────────────────┘
```

---

## 3. Trust Model

### 3.1 What the user trusts
- **The LiqAI app binary** (verified via code signing)
- **Their own wallet** (MetaMask)
- **Ethereum + Uniswap V3 contracts** (immutable, widely audited)
- **Kernel Smart Account contracts** (audited by ZeroDev)
- **Gelato's automation network** (for availability only — not custody)

### 3.2 What the user does NOT trust
- ❌ The LiqAI developer's servers (there are none holding state)
- ❌ Any single operator or admin key (none exist)
- ❌ A shared Vault contract (none exists)
- ❌ Custodial services (the app is fully non-custodial)

### 3.3 Threat Model

| Attacker | Capability | Mitigation |
|----------|-----------|-----------|
| LiqAI app supply chain attacker (malicious update) | Could inject code into distributed binary | Code signing, reproducible builds, pinned dependencies, open source |
| Gelato keeper network compromise | Could trigger rebalance | Session key policy restricts to whitelisted functions + NPM contract only |
| Session key theft | Could call permitted functions | Scope policy: specific function selectors, rate limits, expiry, amount caps |
| RPC provider compromise | Could serve false price data | Client-side price validation, fallback RPC endpoints, slippage limits |
| Phishing of user's EOA | Could drain user's wallet directly | Out of scope (same as all Web3 apps) |
| Malicious local app (stolen PC) | Could access local SQLite, trigger user-approved ops | OS-level account protection, wallet password still required for signing |

---

## 4. Key Architectural Decisions

### 4.1 Why Tauri (not Electron)
- 10–30 MB bundle vs 150 MB+ → lower install friction, faster auto-updates
- Rust backend with explicit permission allowlist → reduces RCE blast radius
- Native OS integration (secure credential storage via keychain)
- First-class security posture (CSP enabled, isolated IPC by default)

### 4.2 Why ZeroDev Kernel (not Safe / Biconomy)
- ERC-7579 modular architecture — clean session key module
- Native policy-based session keys (function selector, target address, value, rate limits)
- Good Gelato integration and docs
- Active development, production-ready

### 4.3 Why Gelato Automate (not Chainlink Automation)
- ERC-4337 + session key native support
- Off-chain condition resolvers (AI can post arbitrary conditions)
- More flexible execution model

### 4.4 Why TypeScript AI engine (not Python sidecar)
- Single-language codebase → easier maintenance
- Smaller bundle (no Python runtime)
- Algorithm is light (Bollinger Band is ~100 lines of math)
- Future LSTM: ONNX.js for inference without Python

### 4.5 Why local SQLite (not remote DB)
- User data never leaves their machine
- No network dependency for app functionality
- Trivial backup (single file)

---

## 5. Data Flow Examples

### 5.1 First-time setup
```
1. User downloads + installs LiqAI Desktop
2. App launches, generates local database
3. User connects MetaMask via WalletConnect v2
4. User clicks "Create AI-managed position"
5. App deploys user's Kernel Smart Account (user signs deployment tx)
6. User approves USDC spending to Smart Account (signs tx)
7. App mints Uniswap V3 LP NFT via Smart Account (user signs)
8. App shows session key scope, user confirms → creates session key (user signs)
9. App registers Gelato task with session key (user signs)
10. 24/7 automation is now active
```

### 5.2 Automated rebalance (24/7)
```
1. Gelato keeper polls AI resolver endpoint (local or IPFS)
2. AI determines rebalance condition is met (range exit / spike / etc.)
3. Keeper constructs rebalance userOp using session key
4. Session key signs (within its policy limits)
5. Kernel Smart Account executes userOp
6. Uniswap V3 NPM decreases liquidity + mints new position
7. Result observable in app next time user opens it
```

### 5.3 User-initiated withdrawal
```
1. User opens app, sees current position
2. User clicks "Withdraw 50%"
3. App constructs decreaseLiquidity + collect tx
4. User's EOA signs the tx (via MetaMask)
5. LP NFT is partially burned, USDC + WETH returned to user's EOA
6. LiqAI never touches the funds
```

---

## 6. Non-Goals

- ❌ Building a custodial service — explicitly rejected
- ❌ Holding any user funds on LiqAI-operated infrastructure
- ❌ Running any server that can sign user transactions
- ❌ Tracking users across sessions / collecting analytics
- ❌ Building a mobile app in the initial phase (desktop only)
- ❌ Supporting chains other than Ethereum mainnet in the initial phase

---

## 7. Migration from v1

The v1 SaaS architecture (`LiqAIVault`, `PendingPool`, `PositionManager`) remains deployed on Ethereum mainnet but is **abandoned**:
- Vault addresses: see [packages/contracts/mainnet-addresses.json](../packages/contracts/mainnet-addresses.json)
- These contracts are not deleted from chain (impossible) but are no longer referenced by the app.
- If funds are ever discovered in the old Vault, users can still call `emergencyWithdraw()` via Etherscan directly.

The v1 code is preserved in the repository under `packages/contracts/`, `packages/backend/`, and `packages/ai-engine/` for historical reference. It will be moved to an `archive/` directory once the v2 structure is complete.

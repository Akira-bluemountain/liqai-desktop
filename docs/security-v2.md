# LiqAI v2 — Security Model

**Status**: User-facing security model overview for the v2 non-custodial desktop app.
**Audience**: users, security researchers, contributors evaluating the trust model.

This document describes what LiqAI v2 promises to its users with respect to custody, signing, and validation. It is intentionally non-exhaustive; deeper technical detail (audit-grade specifications, regression test suites, internal runbooks) is maintained internally and shared on request via the [responsible disclosure channel](../SECURITY.md).

---

## S1. Custody promise

**LiqAI holds no signing keys.** This is the central, load-bearing invariant of v2:

- The user's funds live in their own ECDSA wallet (MetaMask / WalletConnect) and the ZeroDev Kernel Smart Account (SA) deterministically derived from that wallet.
- All on-chain actions are signed either by the user's wallet (sudo operations: deploy, mint, withdraw, session-key install / revoke) or by a session key that the wallet itself has authorised (rebalance loop only).
- LiqAI as a project, as a build, and as a process **never sees a private key**. There is no operator-side key, no escrow, no backend signing service.

This is enforced at the source-code level (`process.env.OPERATOR_PRIVATE_KEY` is a forbidden pattern), at the architecture level (no LiqAI-controlled service that could hold a key), and at the audit-log level (every signing operation is locally recorded for review).

---

## S2. Storage promise

**All state is local.**

- LiqAI uses local SQLite as its only persistence layer.
- No remote database, no telemetry endpoint, no analytics collection.
- The session key's private material is AES-GCM encrypted at rest with a PBKDF2-derived key from a user-supplied passphrase.
- The passphrase is held only in user memory + (optionally) the user's password manager. LiqAI never logs, stores, or transmits the passphrase.

---

## S3. Validation at boundaries

Inputs and outputs at every trust boundary are validated:

- **AI output → on-chain transaction**: AI-suggested LP ranges are bounded-checked (sanity bounds on tick range, slippage, deadline, position size) before being constructed into a transaction.
- **External APIs → application state**: data from price oracles, RPCs, and indexer services is shape-validated with strict schemas before use.
- **User input → wallet signature**: typed-data structures are validated and displayed in human-readable form before signing.

A session key call that violates the on-chain permission policy is also rejected by an off-chain pre-signing guard *before* it reaches the bundler — defence in depth.

---

## S4. Session-key promises

Session keys exist to enable 24/7 automated rebalancing without prompting the user for a wallet signature on every action. They are designed to be **scope-limited, rate-limited, and time-limited**:

| Constraint | Mechanism |
|---|---|
| Target allow-list | Only the Uniswap V3 NPM and the two pool tokens (USDC, WETH) on mainnet |
| Selector allow-list | Only `mint`, `decreaseLiquidity`, `collect`, `approve` |
| Recipient pin | LP tokens must be directed to the user's own Smart Account |
| Approve amount cap | Hard-coded maximums on token approvals |
| Rate limit | Maximum 10 executions per 24 hours |
| Expiry | 30-day automatic expiry; user can revoke earlier |
| 1:1 SA bind | Each session key is constructed against a specific Smart Account address; cross-SA replay is structurally impossible |

A stolen session key (which would require both the local AES-GCM ciphertext AND the user's passphrase) is bounded by all of the above. It cannot direct funds to an attacker, cannot make unbounded approvals, cannot operate beyond the rate limit or expiry, and cannot be replayed against a different SA.

Each constraint is enforced **on-chain** by the audited session-key policy contract AND **off-chain** by a pre-signing guard. Both layers are required to pass before any session-key operation reaches the bundler.

---

## S5. Smart contracts

**LiqAI uses only audited primitives.** The v2 MVP introduces no custom smart contracts of its own:

- ZeroDev Kernel v3.1 (Smart Account)
- ERC-4337 v0.7 EntryPoint
- Uniswap V3 NonfungiblePositionManager (canonical mainnet deployment)
- Gelato Automate (planned for v0.2 fully-on-chain automation)

Custom v2 contracts are explicitly out of scope. If a future feature requires custom code, it will be audited externally before any release that exercises it on mainnet.

---

## S6. Distribution promise

- Binaries are distributed via [GitHub Releases](https://github.com/Akira-bluemountain/liqai-desktop/releases) with SHA-256 checksums.
- The current beta build is **ad-hoc signed** (no Apple Developer ID notarisation). Users approve first-launch via Right-Click → Open per the [User Guide](USER-GUIDE.md).
- Release artefacts are produced from CI on a public, version-pinned workflow.
- Code-signing with a Developer ID and notarisation is planned for the v0.2 line.

---

## S7. Disclosure

For vulnerability reports, please use the channel in [SECURITY.md](../SECURITY.md). Responsible disclosure is appreciated; a coordinated public disclosure window will be agreed on a per-incident basis. The [Security Changelog](CHANGELOG-security.md) records every incident and its remediation.

---

## Out of scope (intentionally)

- Custodial alternatives. v2 is designed around the "no operator key" invariant; custodial features are not a planned addition.
- Non-Ethereum chains. v0.1 is mainnet-only; Base / Arbitrum support is planned for v0.2.
- Ledger / hardware wallet support. Possible in a later release; current beta supports MetaMask / WalletConnect.
- Cloud automation. The bot loop runs locally on the user's PC and requires 24/7 uptime. A planned v0.2 path delegates the loop to Gelato Automate to remove this requirement.

---

## Acknowledgements

Architectural review and security analysis: Anthropic Claude Opus 4.7.
External audit: pending pre-public-release.

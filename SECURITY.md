# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in LiqAI, **please do not open a public GitHub issue**. Use one of the channels below for responsible disclosure.

### Preferred channel

Email the project maintainer:

- **Address**: see the GitHub profile of [@Akira-bluemountain](https://github.com/Akira-bluemountain) for the current contact email
- **Subject prefix**: `[LiqAI Security]`

Please include:

- A clear description of the issue and its impact
- Reproduction steps (or PoC, if available)
- Affected version (commit hash or release tag)
- Your suggested severity (Critical / High / Medium / Low / Informational)
- Whether you wish to be credited in the public changelog (and under what name)

### Response timeline

- **Acknowledgement**: within 72 hours
- **Initial assessment + severity classification**: within 7 days
- **Remediation status update**: within 14 days, or sooner if Critical / High
- **Public disclosure**: coordinated with the reporter; default 90-day window after fix lands, may be shorter for issues already known to the broader community

### Scope

In scope:

- The desktop application (`apps/desktop/`)
- The local TypeScript packages (`packages/ai`, `packages/automation`, `packages/uniswap`)
- Build / release pipeline (`.github/workflows/`)
- Documentation that materially affects security posture

Out of scope (please do not report):

- Vulnerabilities in upstream dependencies (ZeroDev Kernel, Uniswap V3 contracts, viem, wagmi, Tauri, etc.) that do not affect LiqAI's integration. Report those upstream.
- Self-XSS in user-supplied input that requires the user to paste attacker code into a console
- Theoretical issues in mainnet Ethereum, ERC-4337 EntryPoint, or other layer-1 primitives
- Findings that require physical access to the user's device + bypass of OS-level disk encryption
- Brute-forcing a user's passphrase that is below the published 60-bit entropy floor (the floor exists; reports of "weak passphrases can be brute-forced" are not vulnerabilities)

### Safe harbour

We will not pursue legal action against researchers who:

- Make a good-faith effort to follow this policy
- Avoid privacy violations, data destruction, and service disruption
- Do not exfiltrate or retain more data than necessary to demonstrate the issue
- Give us reasonable time to respond before any public disclosure

### Bounty

LiqAI is a free, non-commercial open-source project. **No monetary bounty programme exists.** We will publicly credit reporters in the [Security Changelog](docs/CHANGELOG-security.md) (with consent) and respond promptly.

For high-impact findings, we may offer a non-cash thank-you gift (e.g., a project sticker pack); this is not a bounty and is at the maintainer's discretion.

---

## Security model overview

For a description of LiqAI's security promises (custody, storage, validation, session-key constraints), see [docs/security-v2.md](docs/security-v2.md).

For the historical record of security incidents and their remediation, see [docs/CHANGELOG-security.md](docs/CHANGELOG-security.md).

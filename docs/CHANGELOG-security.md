# LiqAI Security Changelog

A public, chronological record of security issues discovered in LiqAI and how they were remediated.

## About this document

### Purpose

We publish this file because users of a non-custodial wallet-adjacent tool have a right to see how we handle security. Independent reviewers and auditors get a clear chain of custody for the security posture across releases. Future contributors avoid re-introducing fixed vulnerabilities.

### Scope

- LiqAI v2 (non-custodial desktop app, 2026-04-13 onwards) and later.
- Out of scope: upstream vulnerabilities in audited dependencies (ZeroDev Kernel, Uniswap V3 contracts, viem) that do not affect LiqAI's integration.

### Update policy

- One entry per incident, identified as `LIQAI-SEC-YYYY-NNN`.
- Entries are added when an incident is **discovered**, not when it is resolved. Status progresses through `Discovered` → `In Progress` → `Mitigated` → `Resolved`.
- Every entry remains in the document forever. Resolved entries are not deleted.

### How to report a security issue

See [SECURITY.md](../SECURITY.md) for the disclosure process.

### Severity definitions

| Level | Definition |
|---|---|
| **Critical** | A user's funds are at immediate risk OR a core invariant is violated. |
| **High** | A user's funds are at risk under realistic attacker capability, but a second condition is required to exploit. |
| **Medium** | Degraded security posture that does not directly put funds at risk. |
| **Low** | Defensive improvements that close theoretical attack surface. |
| **Informational** | Policy, documentation, or process changes with security relevance. |

### Status labels

| Label | Meaning |
|---|---|
| **Discovered** | Identified; no remediation yet. |
| **In Progress** | Remediation started; users may still be at risk. |
| **Mitigated** | Primary attack vector closed; defence-in-depth work may still be pending. |
| **Resolved** | All planned remediation complete and validated by post-fix checks. |

---

## [LIQAI-SEC-2026-001] Session-key permission scope hardening

**Severity**: Critical
**Status**: Mitigated (Resolved pending staged-rollout validation)
**Affected versions**: LiqAI v2 pre-release builds (commits prior to the remediation landing in 2026-04-22).
**Discovery**: 2026-04-22, by external architectural review.

### Summary

A pre-release of LiqAI v2 used the high-level typed API of its session-key permission library to declare what a session key was allowed to do on Uniswap V3's NonfungiblePositionManager. That high-level API constrained the top-level call shape, but was unable to constrain fields *inside* the struct argument that several of the relevant functions take. As a result, a session key in that build could, in principle, be used to direct LP tokens to an attacker-controlled address — provided the attacker had also obtained both the encrypted local key material AND the user's passphrase (i.e., the on-disk ciphertext, which is AES-GCM encrypted with a PBKDF2-derived key, plus the passphrase used as the input to that KDF).

No LiqAI user funds were lost: at the time of discovery the only live position belonged to the project maintainer, the at-risk session key was revoked within minutes (its plaintext private key is now cryptographically unrecoverable), and no public release of the affected build had been made.

The fix replaces the high-level API with explicit policy rules that pin the recipient field inside the struct argument to the user's own Smart Account address, caps approve amounts to documented limits, and pairs each on-chain rule with an equivalent off-chain pre-signing check. A comprehensive regression test suite locks in the fixed shape.

### Public disclosure

- **First public entry of this document**: published with the v0.1.0-beta-stage1 release.
- **No prior redaction**: the at-risk session key was revoked within ~45 minutes of discovery and no public build was ever distributed with the issue, so no window existed during which a real user could have been affected.

### Credit

- **Discovery**: Anthropic Claude Opus 4.7, during an external architectural review.
- **Remediation implementation**: project maintainer (Akira-bluemountain) in collaboration with Anthropic Claude Code.

### Validation

The fix is being validated through a staged mainnet rollout. The first stage runs a $50 position for 24 hours under bot operation, with three deliberate allow-list-violation probes verifying that both the on-chain session-key policy and the off-chain pre-signing guard reject calls a stolen key would attempt. Subsequent stages scale to $100 and $200 positions before the entry transitions from `Mitigated` to `Resolved`.

Operational runbooks, regression test suites, and detailed remediation timelines are maintained internally and are available on request to security researchers via the disclosure channel in [SECURITY.md](../SECURITY.md).

---

## [LIQAI-SEC-2026-002] *(reserved for next incident)*

*No entries beyond LIQAI-SEC-2026-001 as of the creation date of this document.*

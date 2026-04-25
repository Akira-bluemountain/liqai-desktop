# On-chain proof tests — status: DEFERRED (B2 Pivot)

This directory holds the skeleton for **Full Phase 2b** of the Q1
remediation playbook: end-to-end proof that the session-key policy
rewritten in Phase 3 is actually enforced by the on-chain ZeroDev
CallPolicy V0_0_5 contract under adversarial conditions.

As of 2026-04-23 the work is **deferred**. The tests exist as
`it.skip(...)` entries so they show up in the test run output but do
not execute. See [docs/security-investigation-q1.md §8](../../../../docs/security-investigation-q1.md)
for the rationale (B2 Pivot), the five candidate attack patterns, and
the trigger conditions that would reinstate full implementation.

## Why this skeleton exists

Most of the infrastructure hurdle for on-chain tests is plumbing — anvil
subprocess management, mainnet fork setup, whale impersonation, packed
userOperation construction, Kernel v3.1 signature framing. We solved
**anvil startup** during the feasibility investigation; `helpers/anvilSetup.ts`
is a working implementation, not a placeholder. When Full Phase 2b
resumes, expansion starts from that point instead of from zero.

## What's in here

```
onchain/
├── README.md                         ← this file
├── .env.onchain.example              ← Alchemy archive URL + optional anvil path
├── deferred-patterns.test.ts         ← 5 × it.skip() — the Pattern A–E tests
└── helpers/
    ├── anvilSetup.ts                 ← WORKING: spawn + teardown of mainnet fork
    └── userOpSender.ts               ← PLACEHOLDER: Kernel-specific userOp construction
```

## Resume triggers

Full Phase 2b should be reinstated when **any** of the following become
true:

1. **LiqAI production TVL exceeds $50,000** across all users. Above that
   threshold the marginal cost of on-chain proof (~5–10 engineering
   hours) is easily justified by the reduction in tail-risk.
2. **An external security audit** requires an on-chain policy-enforcement
   proof as an artefact. Common for institutional users.
3. **Kernel upgrades to v3.2+** or beyond, with changes to
   policy-validation semantics. The existing unit/white-box tests stay
   valid but the on-chain behaviour needs a fresh proof against the
   new contracts.
4. **`allowedSelectors` expands** to include new function selectors
   (e.g., `multicall`, a new NPM method). Pattern B becomes load-
   bearing at that point — the current argument "multicall never
   appears in production calldata" no longer holds.
5. A **bug report claims session-key bypass** and we need a reproducible
   on-chain test to confirm / refute.

## How to resume (rough order)

1. Check foundry is installed (`~/.foundry/bin/anvil --version`). If
   not: `curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup`.
2. Populate `.env.onchain` (copy from example) with an Alchemy archive
   key.
3. Finish `helpers/userOpSender.ts` — the TODO list at the top of that
   file is the checklist. Rough allocation (from feasibility analysis):
   - userOp packed format + hash: 1 hour
   - 2D nonce + validator selection: 45 min
   - Session-key signature framing: 1–2 hours
   - ENABLE-mode signature composition: 1–2 hours
   - Gas estimation via `simulateHandleOp`: 30 min
   - Direct `handleOps` submission: 30 min
4. Write a smoke test that sends a trivial userOp end-to-end (no
   policy, no assertions about attack patterns). Confirm the full
   pipeline works on the fork.
5. Implement Pattern C (simplest: target allowlist rejection of DAI
   approve). This validates the pipeline AND gives a first real proof.
6. Pattern E next (cross-SA recipient pinning). Reuses Pattern C infra.
7. Pattern B (multicall). Reuses Pattern C/E infra.
8. Patterns A and D only if a resume-trigger specifically calls for
   them.
9. Update `docs/security-investigation-q1.md §8` with the results
   table as each pattern lands.
10. Flip the corresponding `it.skip` → `it` in
    `deferred-patterns.test.ts`.

## Why not just do it now

Cost/benefit analysis at B2 Pivot:
- Engineering cost: 5–10 hours of focused work with attendant
  debugging risk.
- Benefit delta over current state: marginal. The Q1 fix already has
  6 layers of defence (on-chain policy, off-chain pre-validation guard,
  compile-time rules tests, CI pre-merge grep, passphrase entropy
  floor, enhanced audit log). Phase 5's staged rollout produces the
  same operational gas data as Pattern D, and the same pass/fail
  signal as Pattern C/E under real network conditions.
- Alternative use of the same time: Phase 5 staged rollout itself
  (Sepolia 24h + mainnet small-amount 48h) has higher operational
  value per hour than isolating on-chain proof from a fork.

The short version: we stopped here because the data we'd get out of
Full Phase 2b is *also* what Phase 5 produces, and Phase 5 has to
happen anyway.

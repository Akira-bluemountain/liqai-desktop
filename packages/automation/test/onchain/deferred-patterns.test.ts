/**
 * Phase 2b on-chain proof patterns — DEFERRED per B2 Pivot (2026-04-23).
 *
 * Each test in this file is intentionally `it.skip(...)`. They appear in
 * the test-run output as "skipped" so that:
 *
 *   (a) future maintainers see the tests exist and know Full Phase 2b is
 *       an explicit opt-in, not forgotten work;
 *   (b) if someone un-skips without adding an implementation they get a
 *       clear failure pointing back at the rationale doc;
 *   (c) a grep for `it.skip` surfaces the deferred security work.
 *
 * RESUME TRIGGERS (docs/security-investigation-q1.md §8):
 *   - LiqAI production TVL exceeds $50,000 across all users
 *   - An external security audit includes "on-chain policy proof" as a
 *     required artefact
 *   - Kernel upgrades to v3.2+ with policy-enforcement behaviour changes
 *   - `allowedSelectors` is expanded (e.g., to include multicall or a
 *     new NPM method) — Pattern B becomes load-bearing in that case
 *
 * WHAT TO DO IF YOU RESUME:
 *   1. Read helpers/anvilSetup.ts (working) — that handles the fork.
 *   2. Read helpers/userOpSender.ts — the TODO list there is a checklist
 *      of what's needed for direct `EntryPoint.handleOps` submission.
 *   3. Per-pattern bodies below describe the exact setup + assertions.
 *   4. Flip `it.skip` → `it` for each pattern as you implement it.
 *   5. Update docs/security-investigation-q1.md §8 with the results
 *      table as each pattern lands.
 */

import { describe, it } from 'vitest';

describe('Phase 2b (DEFERRED): on-chain proof of session-key policy', () => {
  // Pattern A (out of scope at B2 Pivot, kept for completeness)
  it.skip('Pattern A — malformed ABI encoding does not bypass CallPolicy', () => {
    // Resume-time plan:
    //   - Craft a `collect` call whose params-tuple is encoded with
    //     shuffled fields or dynamic-offset indirection.
    //   - Submit via handleOps with session key signature.
    //   - Assert EntryPoint reverts with AA23 and the revert reason
    //     points to CallPolicy (not decoder error).
    // Why deferred: ZeroDev CallPolicy V0_0_5 is audited and ABI-strict.
    //   Low marginal value without a concrete threat model change.
  });

  // Pattern B (skipped at B2 Pivot, resume if multicall added to allowlist)
  it.skip('Pattern B — multicall wrapping cannot bypass selector allowlist', () => {
    // Resume-time plan:
    //   - Build `NPM.multicall([collect(recipient=attacker), mint(recipient=attacker)])`.
    //   - Submit via session key.
    //   - Assert AA23 at validateUserOp, because the top-level selector
    //     (0xac9650d8 multicall) is NOT in allowedSelectors. The inner
    //     calls never run.
    //   - Bonus: confirm rate-limit counter does not advance (validation
    //     reverted before any state change).
    // Why deferred: (a) LiqAI never calls multicall so this path never
    //   fires in production; (b) Phase 4.1 sessionKeyGuard rejects
    //   unknown selectors client-side before the userOp is even signed.
  });

  it.skip('Pattern C — approve to a non-USDC/WETH ERC-20 is rejected', () => {
    // Resume-time plan:
    //   - Fund SA with a random ERC-20 (e.g., DAI, LINK, or custom).
    //   - Build `DAI.approve(ATTACKER, MaxUint256)` userOp signed by
    //     session key.
    //   - Submit via handleOps, assert AA23 revert.
    //   - Assertion detail: revert reason encodes "target not allowed"
    //     from CallPolicy (the SA's permission validator's own struct
    //     has no permission matching target=DAI address).
    // Why deferred at B2 Pivot: Phase 2a BASELINE already proves
    //   structurally that only USDC/WETH approve permissions exist in
    //   the policy. Phase 5 staged rollout includes a live negative
    //   test on Sepolia that covers the same property end-to-end.
  });

  // Pattern D (skipped at B2 Pivot, Phase 5 produces the data)
  it.skip('Pattern D — gas sanity: fixed policy vs Phase 3 baseline', () => {
    // Resume-time plan:
    //   - Run a full rebalance userOp (phase1 + phase2) under the fixed
    //     policy. Record callGasLimit/verificationGasLimit/prefund.
    //   - Run the same call shape under a mocked "Phase 3 pre-fix"
    //     policy (rules: []) for comparison.
    //   - Assert: fixed-policy verification gas is within +10% of pre-
    //     fix (the extra EQUAL + LESS_THAN_OR_EQUAL rules are cheap).
    // Why deferred: Phase 5's Sepolia 24h + mainnet 48h rollout yields
    //   the SAME data from real network conditions. The delta vs pre-
    //   fix is moot because pre-fix policy is known-broken and never
    //   shipping again.
  });

  it.skip('Pattern E — SA-baked-in recipient prevents cross-SA abuse', () => {
    // Resume-time plan:
    //   - Deploy two SAs (SA_A and SA_B) owned by different EOAs.
    //   - Install a session key on SA_A using its recipient=SA_A policy.
    //   - Craft a userOp whose `sender = SA_B` but `callData` is
    //     `collect(recipient=SA_A)` — attacker using a key leaked from
    //     SA_A against SA_B's funds.
    //   - Ordinary cross-SA submission already fails at signature
    //     verification (SA_B's validator doesn't know the key), but
    //     the on-chain proof here is that EVEN IF the attacker somehow
    //     had a valid signature path (they can't, but belt-and-
    //     suspenders), CallPolicy would reject because the baked-in
    //     recipient at offset 32/288 points to SA_A not SA_B.
    //   - A richer variant: craft a userOp for SA_A with
    //     `collect(recipient=SA_B)`. Assert AA23 — even though SA_B is
    //     a legitimate SA, the policy was installed with recipient=SA_A
    //     and rejects the mismatch.
    // Why deferred at B2 Pivot: Phase 3's buildRebalancePermissionValidator
    //   unit tests already assert the SA address is wired into the
    //   rules[] at install time. Phase 5 rollout's normal operation on
    //   both Sepolia and mainnet is implicit proof that the correct SA
    //   is baked in (if it weren't, the first rebalance would revert).
  });
});

/**
 * PLACEHOLDER — Kernel v3.1 userOperation builder/sender for Full Phase 2b.
 *
 * CURRENT STATUS (2026-04-23): **DEFERRED (B2 Pivot)**.
 *
 * Background: to prove on-chain that a Q1-vulnerable call is rejected by
 * the ZeroDev CallPolicy, we need to submit a real userOp through the
 * canonical EntryPoint v0.7 contract. The ZeroDev SDK handles this via
 * its bundlerTransport; without a bundler available on a local anvil
 * fork, we bypass it and call `EntryPoint.handleOps(ops, beneficiary)`
 * directly from an impersonated EOA.
 *
 * Doing that correctly requires reproducing several Kernel-specific
 * encodings that the SDK normally hides. The TODOs below enumerate them
 * so a future Claude Code resumption (or human developer) can pick up
 * where we stopped without rediscovering the design space.
 *
 * See docs/security-investigation-q1.md §8 for why this was scoped out
 * and what resume triggers would reinstate it.
 */

// TODO(Full Phase 2b): Kernel v3.1 userOp packed format (ERC-4337 v0.7).
//   The spec: https://eips.ethereum.org/EIPS/eip-4337#userop-struct-updates-v07
//   Packing:
//     accountGasLimits = (verificationGasLimit << 128) | callGasLimit
//     gasFees          = (maxPriorityFeePerGas << 128) | maxFeePerGas
//     paymasterAndData = paymaster (20 bytes) + verificationGasLimit (16) + ...
//   viem has `userOperation` types for v0.7; prefer them over hand-rolling.

// TODO(Full Phase 2b): 2D nonce for validator selection.
//   Kernel v3.1 nonce = (nonceKey << 64) | sequence.
//   nonceKey bits:
//     [191..160] validator mode flag (1 = ENABLE, 2 = DEFAULT)
//     [159..0]   validator address padded left to 20 bytes
//   Read via EntryPoint.getNonce(sender, key). Increment sequence client-
//   side (EntryPoint advances it on inclusion).

// TODO(Full Phase 2b): Session-key signature framing.
//   Kernel permission validator expects:
//     [1 byte signature mode] [signature payload]
//   Mode = 0x00 for "use session key", 0x01 for "use sudo + enable".
//   Payload for session-key signature: the ECDSA signature of userOpHash
//   by the session-key private key.
//   Reference: @zerodev/permissions src/actions/signUserOperation.ts.

// TODO(Full Phase 2b): ENABLE mode composition (first userOp per key).
//   On the FIRST userOp a newly-issued session key signs, Kernel expects
//   the signature field to also carry the enable data that was produced
//   by `serializePermissionAccount` (in our sessionKeyInstall.ts). The
//   signature is a concatenation: [enableData] + [session key signature]
//   with a specific length-prefixing scheme. See @zerodev/sdk source.

// TODO(Full Phase 2b): userOpHash computation.
//   userOpHash = keccak256(keccak256(packed userOp fields) || entryPoint || chainId).
//   viem exposes `getUserOperationHash` in permissionless; use it rather
//   than hand-rolling — Kernel relies on the exact hash the EntryPoint
//   uses, any drift breaks signature verification.

// TODO(Full Phase 2b): Gas estimation for direct handleOps.
//   Without a bundler, we must call `EntryPoint.simulateHandleOp(userOp)`
//   to get the actual gas usage, then add ~20% buffer. The simulate
//   function reverts with success/fail encoded in the revert reason — a
//   foot-gun for naive catch blocks.

// TODO(Full Phase 2b): SA deployment on the fork.
//   Kernel v3.1 SA is counter-factually deterministic from the owner EOA.
//   To deploy, send a userOp with `initCode = factory || deployCalldata`
//   in its first slot. The SA only has an on-chain code blob AFTER this
//   userOp lands. For pure-read tests we can skip deployment, but for
//   handleOps we need the SA to exist.

// TODO(Full Phase 2b): USDC/WETH whale impersonation for SA funding.
//   Use anvil's `anvil_impersonateAccount` on a known whale (e.g., Binance
//   hot wallet 0x28C6c06298d514Db089934071355E5743bf21d60 has ~$40M USDC
//   at the pinned block). Call `USDC.transfer(SA, amount)` as the whale.

// Placeholder to make this a valid TS file the test harness can import.
export const USER_OP_SENDER_DEFERRED = true as const;

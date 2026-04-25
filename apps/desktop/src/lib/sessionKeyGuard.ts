'use client';

/**
 * sessionKeyGuard — the off-chain second line of defence for the
 * session-key rebalance flow.
 *
 * The on-chain CallPolicy (see sessionKeyPolicy.ts) is the authoritative
 * enforcement point: leaked session key + malicious call → rejected by
 * the Smart Account's permission validator during `validateUserOp`. This
 * module adds a client-side pre-flight check that runs IMMEDIATELY
 * BEFORE the userOp is signed and submitted, so that:
 *
 *   1. A bug in LiqAI (the app computing the wrong recipient, an AI
 *      output that somehow proposes a non-SA target, a future refactor
 *      that drops the recipient pin in production code) is caught
 *      locally rather than burning gas to get rejected on-chain.
 *
 *   2. A compromised LiqAI binary that somehow constructs an exfiltrating
 *      userOp must ALSO bypass this hook. Defence-in-depth: two
 *      independent checks are harder to neutralise than one.
 *
 * SECURITY:
 *   - This is NOT a replacement for the on-chain policy. If the policy
 *     is weakened, a bypass here would still allow exploitation on the
 *     next userOp that goes through. The sessionKeyPolicy.ts path must
 *     remain the authoritative enforcement.
 *   - This hook operates on the `calls` array BEFORE Kernel wraps them
 *     in `execute`/`executeBatch`. That's the natural boundary at which
 *     LiqAI can inspect the semantic intent.
 *   - Throws a plain Error on violation. Callers should surface the
 *     message to the user and abort signing — never catch-and-ignore.
 */

import {
  decodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { UNISWAP_V3_ADDRESSES } from '@liqai/uniswap';
import {
  MAX_APPROVE_AMOUNT_USDC,
  MAX_APPROVE_AMOUNT_WETH,
} from './constants/sessionKeyLimits';

const MAINNET_ID = 1;

// Minimal ABIs — only the function fragments the guard needs to decode.
// Kept local so this module is self-contained and independent of the
// larger @liqai/uniswap ABI export (which could drift).
const NPM_GUARD_ABI = parseAbi([
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256,uint256)',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256,uint256)',
]);
const ERC20_GUARD_ABI = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
]);

export interface GuardedCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

export class SessionKeyGuardError extends Error {
  constructor(message: string) {
    super(`[sessionKeyGuard] ${message}`);
    this.name = 'SessionKeyGuardError';
  }
}

/**
 * Validate every call in a pre-userOp batch against the same rules the
 * on-chain policy enforces. Throws on the first violation — callers must
 * not proceed to signing if this throws.
 *
 * Rules (kept in 1:1 correspondence with the on-chain CallPolicy):
 *   1. Every call's `value` must be 0 (no native ETH transfer).
 *   2. Target must be NPM, USDC, or WETH (the allow-listed contracts).
 *   3. NPM.mint's params.recipient must equal `sa`.
 *   4. NPM.collect's params.recipient must equal `sa`.
 *   5. NPM.decreaseLiquidity has no recipient field (valueLimit=0 is
 *      enough, same as on-chain policy).
 *   6. (USDC|WETH).approve's spender must equal NPM and amount must not
 *      exceed the configured cap.
 *   7. Any other selector on any target is rejected.
 */
export function assertCallsSafe(
  calls: ReadonlyArray<GuardedCall>,
  sa: Address,
): void {
  if (!isAddressLike(sa)) {
    throw new SessionKeyGuardError(`invalid sa address: ${sa}`);
  }
  const addrs = UNISWAP_V3_ADDRESSES[MAINNET_ID];
  const npm = addrs.nonfungiblePositionManager as Address;
  const usdc = addrs.usdc as Address;
  const weth = addrs.weth as Address;

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    assertOneCall(call, i, sa, { npm, usdc, weth });
  }
}

function assertOneCall(
  call: GuardedCall,
  index: number,
  sa: Address,
  allowed: { npm: Address; usdc: Address; weth: Address },
): void {
  if (call.value !== 0n) {
    throw new SessionKeyGuardError(
      `call[${index}] has value=${call.value} — session key MUST NOT transfer native ETH`,
    );
  }

  const to = call.to.toLowerCase() as Address;
  if (to === allowed.npm.toLowerCase()) {
    assertNpmCall(call, index, sa);
    return;
  }
  if (to === allowed.usdc.toLowerCase()) {
    assertApproveCall(call, index, 'USDC', allowed.npm, MAX_APPROVE_AMOUNT_USDC);
    return;
  }
  if (to === allowed.weth.toLowerCase()) {
    assertApproveCall(call, index, 'WETH', allowed.npm, MAX_APPROVE_AMOUNT_WETH);
    return;
  }
  throw new SessionKeyGuardError(
    `call[${index}] target=${call.to} is not in allowlist (NPM/USDC/WETH)`,
  );
}

function assertNpmCall(
  call: GuardedCall,
  index: number,
  sa: Address,
): void {
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({
      abi: NPM_GUARD_ABI,
      data: call.data,
    });
  } catch {
    throw new SessionKeyGuardError(
      `call[${index}] NPM call: could not decode as mint/collect/decreaseLiquidity — unknown selector`,
    );
  }

  switch (decoded.functionName) {
    case 'mint': {
      // mint takes a single tuple; args[0] contains the struct.
      const params = (decoded.args as readonly unknown[])[0] as {
        readonly recipient: Address;
      };
      if (!params || !isAddressLike(params.recipient)) {
        throw new SessionKeyGuardError(
          `call[${index}] NPM.mint: recipient missing or not an address`,
        );
      }
      if (params.recipient.toLowerCase() !== sa.toLowerCase()) {
        throw new SessionKeyGuardError(
          `call[${index}] NPM.mint.recipient=${params.recipient} !== SA ${sa}`,
        );
      }
      return;
    }
    case 'collect': {
      const params = (decoded.args as readonly unknown[])[0] as {
        readonly recipient: Address;
      };
      if (!params || !isAddressLike(params.recipient)) {
        throw new SessionKeyGuardError(
          `call[${index}] NPM.collect: recipient missing or not an address`,
        );
      }
      if (params.recipient.toLowerCase() !== sa.toLowerCase()) {
        throw new SessionKeyGuardError(
          `call[${index}] NPM.collect.recipient=${params.recipient} !== SA ${sa}`,
        );
      }
      return;
    }
    case 'decreaseLiquidity':
      // No recipient field; valueLimit=0 already checked.
      return;
    default:
      throw new SessionKeyGuardError(
        `call[${index}] NPM function "${decoded.functionName}" not allowed`,
      );
  }
}

function assertApproveCall(
  call: GuardedCall,
  index: number,
  tokenLabel: 'USDC' | 'WETH',
  npm: Address,
  amountCap: bigint,
): void {
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({ abi: ERC20_GUARD_ABI, data: call.data });
  } catch {
    throw new SessionKeyGuardError(
      `call[${index}] ${tokenLabel} call: could not decode as approve — unknown selector`,
    );
  }
  if (decoded.functionName !== 'approve') {
    throw new SessionKeyGuardError(
      `call[${index}] ${tokenLabel}: only approve is allowed, got ${decoded.functionName}`,
    );
  }
  const [spender, amount] = decoded.args as readonly [Address, bigint];
  if (!isAddressLike(spender) || spender.toLowerCase() !== npm.toLowerCase()) {
    throw new SessionKeyGuardError(
      `call[${index}] ${tokenLabel}.approve.spender=${spender} !== NPM ${npm}`,
    );
  }
  if (typeof amount !== 'bigint') {
    throw new SessionKeyGuardError(
      `call[${index}] ${tokenLabel}.approve.amount is not a bigint`,
    );
  }
  if (amount > amountCap) {
    throw new SessionKeyGuardError(
      `call[${index}] ${tokenLabel}.approve.amount=${amount} exceeds cap ${amountCap}`,
    );
  }
}

function isAddressLike(v: unknown): v is Address {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v);
}

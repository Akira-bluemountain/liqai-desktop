/**
 * phase5-preflight — automated Go/No-Go check before Phase 5 Stage 1.
 *
 * Verifies the six preconditions enumerated in docs/phase5-runbook.md §3.1.0:
 *
 *   1. Environment: Node ≥ 22 (for native TS), Alchemy API key readable.
 *   2. Session keys in DB: every row is revoked (revoked_at set AND ciphertext
 *      erased). No active key must exist before a new install.
 *   3. LP positions in DB: zero rows with status='active'. A lingering active
 *      row indicates a stuck NFT that needs resolution first.
 *   4. NPM on-chain: balanceOf(SA) consistent with the DB (expected: 0 NFTs).
 *   5. SA deployed on-chain + residual balances within the documented range
 *      from docs/phase5-runbook.md §3.4 (USDC, WETH, ETH).
 *   6. ETH balance clears MIN_SA_ETH_FOR_BOT_WEI (0.005 ETH) — otherwise
 *      Stage 1's first userOp cannot prefund.
 *
 * Usage:
 *   npm run phase5:preflight        (from apps/desktop)
 *   node --experimental-strip-types scripts/phase5-preflight.mts
 *
 * Exit codes:
 *   0 — all checks PASS. Proceed to Stage 1 §3.1.1.
 *   1 — one or more checks FAIL. Read the report, remediate, re-run.
 *   2 — fatal infrastructure error (RPC down, DB missing, etc).
 *
 * SECURITY: read-only. No mutations, no signatures, no contract writes.
 * The script never asks for a private key or a passphrase.
 */

import {
  createPublicClient,
  http,
  parseAbi,
  formatEther,
  formatUnits,
  type Address,
  type PublicClient,
} from 'viem';
import { mainnet } from 'viem/chains';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// ── Constants (mirrored from the runbook + production constants) ────
const SA = '0x135A384fD401E041167F1bE8bee312d7A6899A5F' as Address;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address;
const NPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as Address;

// Production constant from useRebalanceBot.ts — kept in sync manually.
const MIN_SA_ETH_FOR_BOT_WEI = 5_000_000_000_000_000n; // 0.005 ETH

// Stage 1 resource thresholds. These are **actionable** — if the SA is
// below any of them, the check tells the operator exactly how much to
// top up from the EOA. Upper bounds intentionally omitted: surplus in
// the SA is not a blocker and mid-run is normal (refuels, dust from
// prior rebalances).
//
// Stage 1 mint size is $50 USDC; add 10% buffer for slippage and any
// between-mint price drift during Phase 5. The Bot's low-SA-ETH banner
// fires at exactly MIN_SA_ETH_FOR_BOT_WEI.
const STAGE1_USDC_MIN_RAW = 55_000_000n; // $55 (Stage 1 $50 + ~10% buffer)
const STAGE1_ETH_MIN_WEI = MIN_SA_ETH_FOR_BOT_WEI;

// Tauri app data directory on macOS. Override with PHASE5_DB_PATH for
// Linux/Windows or for testing against a different DB copy.
const DEFAULT_DB_PATH = resolve(
  homedir(),
  'Library/Application Support/app.liqai.desktop/liqai.db',
);
const DB_PATH = process.env.PHASE5_DB_PATH ?? DEFAULT_DB_PATH;

const ENV_LOCAL_PATH = resolve(
  process.cwd(),
  // Script runs from apps/desktop regardless of how it was invoked.
  process.cwd().endsWith('apps/desktop') ? '.env.local' : 'apps/desktop/.env.local',
);

// ── ABIs ─────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
const NPM_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
]);

// ── Result types ─────────────────────────────────────────────────────
interface Check {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const checks: Check[] = [];
  try {
    // Environment check first — fails fast if API key is missing so we
    // don't make a confusing RPC error later.
    const env = checkEnvironment();
    checks.push(env.check);
    if (!env.check.ok || !env.alchemyUrl) {
      printReport(checks);
      process.exit(1);
    }

    const client = createPublicClient({
      chain: mainnet,
      transport: http(env.alchemyUrl),
    }) as PublicClient;

    // SA on-chain state (balances + deploy status).
    const onchain = await checkOnchainBalances(client);
    checks.push(...onchain);

    // DB state checks (require sqlite3 CLI + existing DB file).
    const db = checkDatabase();
    checks.push(...db);

    // NPM state consistency with DB.
    checks.push(await checkNpmConsistency(client, db));
  } catch (err) {
    // Any uncaught error is an infrastructure failure, not a domain
    // fail. Different exit code so callers can distinguish retry from
    // remediate.
    console.error('\n[phase5-preflight] fatal error:', err);
    process.exit(2);
  }

  printReport(checks);
  const anyFail = checks.some((c) => !c.ok);
  process.exit(anyFail ? 1 : 0);
}

// ── Check 1: Environment ─────────────────────────────────────────────
function checkEnvironment(): { check: Check; alchemyUrl: string | null } {
  const issues: string[] = [];

  const [nodeMajor] = process.versions.node.split('.').map((n) => Number(n));
  if (nodeMajor == null || nodeMajor < 22) {
    issues.push(
      `Node version ${process.versions.node} is below 22 (required for native TS execution)`,
    );
  }

  let alchemyKey: string | null = null;
  if (existsSync(ENV_LOCAL_PATH)) {
    try {
      const contents = readFileSync(ENV_LOCAL_PATH, 'utf8');
      const match = contents.match(/^NEXT_PUBLIC_ALCHEMY_API_KEY\s*=\s*(\S+)/m);
      alchemyKey = match?.[1]?.trim() ?? null;
      if (!alchemyKey) {
        issues.push(
          `NEXT_PUBLIC_ALCHEMY_API_KEY missing or empty in ${ENV_LOCAL_PATH}`,
        );
      }
    } catch (err) {
      issues.push(`Failed to read ${ENV_LOCAL_PATH}: ${String(err)}`);
    }
  } else {
    // Fall back to process.env — useful in CI / one-off testing.
    alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? null;
    if (!alchemyKey) {
      issues.push(
        `.env.local not found at ${ENV_LOCAL_PATH} and NEXT_PUBLIC_ALCHEMY_API_KEY not in process.env`,
      );
    }
  }

  if (!existsSync(DB_PATH)) {
    issues.push(
      `LiqAI local DB not found at ${DB_PATH}. Set PHASE5_DB_PATH env to override, or start LiqAI once to initialise it.`,
    );
  }

  try {
    execSync('sqlite3 -version', { stdio: 'ignore' });
  } catch {
    issues.push(
      'sqlite3 CLI not found on PATH. macOS ships it at /usr/bin/sqlite3; install otherwise.',
    );
  }

  const ok = issues.length === 0;
  const alchemyUrl = alchemyKey
    ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
    : null;

  return {
    alchemyUrl,
    check: {
      id: 'env',
      label: 'Environment (Node 22+, Alchemy key, DB file, sqlite3 CLI)',
      ok,
      detail: ok
        ? `Node ${process.versions.node}, DB at ${DB_PATH}`
        : issues.join(' | '),
    },
  };
}

// ── Check 2/6: SA on-chain balances + deploy ────────────────────────
async function checkOnchainBalances(client: PublicClient): Promise<Check[]> {
  const [code, ethBal, usdcBal, wethBal] = await Promise.all([
    client.getCode({ address: SA }),
    client.getBalance({ address: SA }),
    client.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [SA],
    }),
    client.readContract({
      address: WETH,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [SA],
    }),
  ]);

  // Deploy check — SA must be counter-factually deployed. Empty bytecode
  // means the SA was never initialised, which would require re-running
  // the "Deploy + Mint" UI step rather than Stage 1.
  const deployOk = code !== undefined && code !== '0x' && code.length > 2;
  const deployCheck: Check = {
    id: 'sa-deployed',
    label: `SA deployed on-chain (${SA})`,
    ok: deployOk,
    detail: deployOk
      ? `Bytecode present (${code.length} chars)`
      : `Bytecode missing or empty. SA is not deployed — complete "Deploy + Mint" from LiqAI UI first.`,
  };

  // ETH balance — must clear MIN_SA_ETH_FOR_BOT_WEI so Stage 1's userOps
  // can pre-fund. No upper bound: surplus is harmless and normal after
  // prior Q1 top-ups.
  const ethOk = ethBal >= STAGE1_ETH_MIN_WEI;
  const ethShortfallWei = ethOk ? 0n : STAGE1_ETH_MIN_WEI - ethBal;
  const ethCheck: Check = {
    id: 'sa-eth',
    label: `SA ETH ≥ ${formatEther(STAGE1_ETH_MIN_WEI)} (Bot prefund minimum)`,
    ok: ethOk,
    detail: ethOk
      ? `Balance ${formatEther(ethBal)} ETH (sufficient)`
      : `Balance ${formatEther(ethBal)} ETH — need ${formatEther(STAGE1_ETH_MIN_WEI)}. ` +
        `Top up ${formatEther(ethShortfallWei)} ETH from EOA before Stage 1.`,
  };

  // USDC balance — Stage 1 mints $50 worth; we require $55 so the mint
  // has a slippage buffer. If below, compute the top-up delta so the
  // operator has a one-line action.
  const usdcOk = usdcBal >= STAGE1_USDC_MIN_RAW;
  const usdcShortfall = usdcOk ? 0n : STAGE1_USDC_MIN_RAW - usdcBal;
  const usdcCheck: Check = {
    id: 'sa-usdc',
    label: `SA USDC ≥ ${formatUnits(STAGE1_USDC_MIN_RAW, 6)} (Stage 1 mint + 10% buffer)`,
    ok: usdcOk,
    detail: usdcOk
      ? `Balance ${formatUnits(usdcBal, 6)} USDC (sufficient for Stage 1)`
      : `Balance ${formatUnits(usdcBal, 6)} USDC — need ${formatUnits(
          STAGE1_USDC_MIN_RAW,
          6,
        )}. Top up ${formatUnits(usdcShortfall, 6)} USDC from EOA before Stage 1.`,
  };

  // WETH balance — informational. The Stage 1 mint wraps ETH → WETH
  // inside the userOp, so pre-existing WETH is neither required nor
  // harmful. Record for completeness.
  const wethCheck: Check = {
    id: 'sa-weth',
    label: `SA WETH balance (informational)`,
    ok: true,
    detail:
      `Balance ${formatUnits(wethBal, 18)} WETH. ` +
      `Stage 1 mint wraps fresh ETH → WETH so this balance isn't required; ` +
      `any amount present is residual from prior operations.`,
  };

  return [deployCheck, ethCheck, usdcCheck, wethCheck];
}

// ── Check 3 + 4: Database state ──────────────────────────────────────
interface DbState {
  readonly activeLpCount: number;
  readonly unrevokedSessionKeys: number;
  readonly nonErasedCiphertextRows: number;
}

interface DbCheckResult {
  readonly checks: Check[];
  readonly activeLpCount: number;
}

function checkDatabase(): Check[] & { activeLpCount?: number } {
  const checks: Check[] = [];
  let state: DbState;
  try {
    state = readDbState();
  } catch (err) {
    checks.push({
      id: 'db-read',
      label: 'Read DB state',
      ok: false,
      detail: `Could not query SQLite: ${String(err)}`,
    });
    return Object.assign(checks, { activeLpCount: -1 });
  }

  checks.push({
    id: 'lp-active',
    label: 'LP positions: no active rows',
    ok: state.activeLpCount === 0,
    detail:
      state.activeLpCount === 0
        ? 'No active rows (expected post-Q1-withdraw)'
        : `${state.activeLpCount} active row(s) found — resolve before Stage 1. ` +
          'Check LiqAI Positions Dashboard; use Withdraw for any stuck NFT.',
  });

  checks.push({
    id: 'session-keys-revoked',
    label: 'Session keys: all rows revoked',
    ok: state.unrevokedSessionKeys === 0,
    detail:
      state.unrevokedSessionKeys === 0
        ? 'No unrevoked session keys (expected)'
        : `${state.unrevokedSessionKeys} unrevoked session key(s) found. Revoke via Session Key Panel before Stage 1.`,
  });

  checks.push({
    id: 'session-keys-ciphertext-erased',
    label: 'Session keys: all ciphertexts erased (post-revoke)',
    ok: state.nonErasedCiphertextRows === 0,
    detail:
      state.nonErasedCiphertextRows === 0
        ? 'All revoked rows have stronghold_handle cleared'
        : `${state.nonErasedCiphertextRows} revoked row(s) retain ciphertext. Re-run revoke to erase.`,
  });

  return Object.assign(checks, { activeLpCount: state.activeLpCount });
}

function readDbState(): DbState {
  // Use sqlite3 CLI to read DB. Queries are read-only; no locks held.
  const run = (sql: string): string =>
    execSync(`sqlite3 "${DB_PATH}" "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
    }).trim();

  const activeLpCount = Number(
    run(`SELECT COUNT(*) FROM lp_positions WHERE status='active'`),
  );
  const unrevokedSessionKeys = Number(
    run(`SELECT COUNT(*) FROM session_keys WHERE revoked_at IS NULL`),
  );
  const nonErasedCiphertextRows = Number(
    run(
      // A revoked row should have stronghold_handle = '' (set by
      // revokeSessionKey). Anything else is a leftover.
      `SELECT COUNT(*) FROM session_keys WHERE revoked_at IS NOT NULL AND stronghold_handle != ''`,
    ),
  );

  return { activeLpCount, unrevokedSessionKeys, nonErasedCiphertextRows };
}

// ── Check 5: NPM consistency ─────────────────────────────────────────
// The real integrity concern is: does the DB claim more ACTIVE positions
// than exist on-chain? That would mean we track a position NPM doesn't
// have — a serious state bug. The reverse (on-chain > DB active) is
// normal and harmless: Uniswap V3 leaves the LP NFT in the owner's
// wallet after decreaseLiquidity + collect with liquidity=0. Those
// "dust" NFTs accumulate across mints unless the user burns them
// explicitly (which costs gas and is never automated).
async function checkNpmConsistency(
  client: PublicClient,
  dbChecks: ReturnType<typeof checkDatabase>,
): Promise<Check> {
  const activeLpCount = (dbChecks as { activeLpCount?: number }).activeLpCount ?? -1;
  let onchainCount: bigint;
  try {
    onchainCount = (await client.readContract({
      address: NPM,
      abi: NPM_ABI,
      functionName: 'balanceOf',
      args: [SA],
    })) as bigint;
  } catch (err) {
    return {
      id: 'npm-consistency',
      label: 'NPM.balanceOf(SA) readable',
      ok: false,
      detail: `RPC read failed: ${String(err)}`,
    };
  }

  // Integrity check: DB active ≤ on-chain count. Everything else is OK.
  const integrityOk = activeLpCount <= Number(onchainCount);
  const dustCount = Number(onchainCount) - activeLpCount;

  return {
    id: 'npm-consistency',
    label: 'DB active LP count ≤ on-chain NFT count (integrity)',
    ok: integrityOk,
    detail: integrityOk
      ? `On-chain NFTs ${onchainCount}; DB active ${activeLpCount}; ` +
        `${dustCount} dust NFT(s) owned by SA (closed positions with liquidity=0 — harmless, ` +
        `burning them costs gas and is not required for Stage 1).`
      : `INTEGRITY FAIL: DB active ${activeLpCount} > on-chain NFTs ${onchainCount}. ` +
        `The DB claims a position that NPM doesn't recognise. Investigate: was an NFT ` +
        `transferred out of the SA, or is the DB corrupted?`,
  };
}

// ── Reporting ────────────────────────────────────────────────────────
function printReport(checks: Check[]): void {
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;

  console.log('');
  console.log('========================================================');
  console.log('  Phase 5 Stage 1 pre-flight check');
  console.log('  Target SA: ' + SA);
  console.log('========================================================');
  console.log('');

  for (const c of checks) {
    const status = c.ok ? '  PASS' : '  FAIL';
    console.log(`${status}  [${c.id}] ${c.label}`);
    console.log(`         ${c.detail}`);
    console.log('');
  }

  console.log('--------------------------------------------------------');
  console.log(`  Result: ${pass} PASS, ${fail} FAIL`);
  if (fail === 0) {
    console.log('  GO for Stage 1. Proceed to docs/phase5-runbook.md §3.1.1.');
  } else {
    console.log(
      '  NO-GO. Remediate each FAIL above, then re-run `npm run phase5:preflight`.',
    );
  }
  console.log('========================================================');
  console.log('');
}

main();

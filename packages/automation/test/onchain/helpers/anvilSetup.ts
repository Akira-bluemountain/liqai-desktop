/**
 * Anvil mainnet fork helper — working reference implementation kept here
 * so that resuming Full Phase 2b (on-chain proof of session-key policy)
 * doesn't start from zero.
 *
 * CURRENT STATUS (2026-04-23): **DEFERRED**.
 *
 * See docs/security-investigation-q1.md §8 for the B2 Pivot rationale —
 * on-chain proof of the Q1 fix was scoped out in favour of gathering the
 * same data from Phase 5's staged rollout (Sepolia 24h + mainnet small-
 * amount 48h). This file is retained as working code, not a placeholder,
 * because the anvil + mainnet fork startup is the one part of Full Phase
 * 2b that we fully solved during the feasibility investigation.
 *
 * USAGE (when Full Phase 2b resumes):
 *
 *   import { startAnvilFork } from './anvilSetup';
 *
 *   describe('on-chain proof', async () => {
 *     const anvil = await startAnvilFork();
 *     beforeAll(() => anvil); // already started above
 *     afterAll(() => anvil.stop());
 *     // ... tests using anvil.rpcUrl
 *   });
 *
 * REQUIREMENTS:
 *   - foundry installed (anvil binary at ~/.foundry/bin/anvil, or
 *     $ANVIL_BIN pointing to a different location).
 *   - NEXT_PUBLIC_ALCHEMY_API_KEY or ALCHEMY_RPC_URL env set (archive
 *     node access is needed for fork-from-past-block).
 *   - TCP port 8545 free.
 *
 * WHY A PINNED FORK BLOCK:
 *   Mainnet state drifts. Pinning ensures reproducible USDC/WETH pool
 *   state, NPM storage, and EntryPoint state across runs. Bump only when
 *   an on-chain dependency changes (e.g., a Kernel implementation upgrade
 *   we want to test against).
 *
 * WHY NOT @viem/anvil:
 *   Extra pinned dep (~80 MB anvil bundle). Direct subprocess of the
 *   developer's installed anvil keeps us aligned with the real foundry
 *   toolchain they'll use for debugging.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Mainnet block we fork from. Chosen post-EntryPoint v0.7 deploy with
 *  stable USDC/WETH pool state. */
export const ANVIL_FORK_BLOCK = 24_939_000n;

/** Foundry default chain id. Avoids conflict with real networks. */
export const ANVIL_CHAIN_ID = 31337;

/** Hard-coded port because on-chain tests run serially (anvil is heavy;
 *  no benefit to concurrent forks). */
export const ANVIL_PORT = 8545;

const ANVIL_BIN =
  process.env.ANVIL_BIN ?? resolve(homedir(), '.foundry', 'bin', 'anvil');

export interface AnvilFork {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly forkBlock: bigint;
  readonly stop: () => Promise<void>;
}

/**
 * Start an anvil subprocess forked from mainnet. Resolves once anvil
 * responds to an eth_blockNumber call. Caller is responsible for
 * invoking `.stop()` in a try/finally or afterAll.
 */
export async function startAnvilFork(): Promise<AnvilFork> {
  if (!existsSync(ANVIL_BIN)) {
    throw new Error(
      `anvil binary not found at ${ANVIL_BIN}. Install foundry: ` +
        'curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup',
    );
  }
  const rpcForUpstream = getUpstreamRpcUrl();

  const proc = spawn(
    ANVIL_BIN,
    [
      '--fork-url', rpcForUpstream,
      '--fork-block-number', ANVIL_FORK_BLOCK.toString(),
      '--chain-id', ANVIL_CHAIN_ID.toString(),
      '--port', ANVIL_PORT.toString(),
      '--silent',
      '--auto-impersonate', // send from any `from` address without private key
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  proc.stderr?.on('data', (data: Buffer) => {
    const s = data.toString();
    if (s.trim()) process.stderr.write(`[anvil] ${s}`);
  });

  const rpcUrl = `http://127.0.0.1:${ANVIL_PORT}`;
  await waitForAnvilReady(rpcUrl, proc);
  return {
    rpcUrl,
    chainId: ANVIL_CHAIN_ID,
    forkBlock: ANVIL_FORK_BLOCK,
    stop: () => stopAnvil(proc),
  };
}

function getUpstreamRpcUrl(): string {
  if (process.env.ALCHEMY_RPC_URL) return process.env.ALCHEMY_RPC_URL;
  const key = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  if (!key) {
    throw new Error(
      'Anvil fork requires NEXT_PUBLIC_ALCHEMY_API_KEY or ALCHEMY_RPC_URL. ' +
        'See .env.onchain.example in this directory.',
    );
  }
  return `https://eth-mainnet.g.alchemy.com/v2/${key}`;
}

async function waitForAnvilReady(
  rpcUrl: string,
  proc: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`anvil exited before ready (code ${proc.exitCode})`);
    }
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_blockNumber',
          params: [],
        }),
      });
      if (res.ok) {
        const j = (await res.json()) as { result?: string };
        if (j.result) return;
      }
    } catch {
      // connection refused, try again
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill('SIGKILL');
  throw new Error('anvil did not become ready within 30s');
}

async function stopAnvil(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1_000));
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

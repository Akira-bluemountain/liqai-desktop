/**
 * phase5-session-state-diagnostic — classify the current session-key
 * install state so the Phase 5 §3.1.2 next action can be chosen
 * deterministically.
 *
 * This script was written after a real Stage-1 incident: the operator
 * believed §3.1.2 Step C (Install) had completed, but the DB showed
 * zero active session_keys and the latest audit_log install entry was
 * from the pre-Q1 key. The root question was "did install happen at
 * all, or did it silently fail?". This script answers that question
 * objectively from DB + on-chain state alone.
 *
 * Architecture:
 *   - Read-only. SELECT-only SQL. No DB writes. No on-chain writes.
 *   - Node 22 native TS (--experimental-strip-types). Zero new deps.
 *   - Mirrors phase5-preflight.mts structure so the operator can
 *     learn one pattern.
 *
 * 7 diagnostic items (per docs/phase5-runbook.md §3.1.2):
 *   DB (5):
 *     1. session_keys status classification (Installed / Revoked / Orphan)
 *     2. Last 10 audit_log entries (timeline context)
 *     3. session_key_* action chronology (full history)
 *     4. Latest session_key_installed: policyHash + policyVersion present?
 *     5. DB integrity: orphan detection (active row with no install audit)
 *   On-chain (2, lightweight per Phase 1 approval):
 *     6. SA deployed (eth_getCode)
 *     7. Latest install audit install_tx_hash = sentinel 0x000… (= lazy install honoured)
 *
 * Extra integrity checks (per Phase 2 task 2):
 *   - description policyHash prefix (first 10 chars) matches metadata_json.policyHash
 *     prefix. Mismatch flagged as tamper suspicion.
 *
 * Usage:
 *   npm run phase5:session-diagnostic     (from apps/desktop)
 *   node --experimental-strip-types scripts/phase5-session-state-diagnostic.mts
 *
 * Exit codes:
 *   0 — state confirmed & consistent with Phase 1 model (Installed, Revoked,
 *       or CLEAN = only old revoked keys). Next action is clear.
 *   1 — anomaly detected (Orphan, policyHash missing, prefix mismatch) OR
 *       VERDICT requires UI confirmation from the operator.
 *   2 — infrastructure error (RPC down, DB missing, sqlite3 missing, etc).
 *
 * SECURITY: read-only. No mutations, no signatures, no contract writes.
 */

import {
  createPublicClient,
  http,
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
const LAZY_INSTALL_SENTINEL =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const EXPECTED_POLICY_VERSION = 'Q1-fix-2026-04-22';

const DEFAULT_DB_PATH = resolve(
  homedir(),
  'Library/Application Support/app.liqai.desktop/liqai.db',
);
const DB_PATH = process.env.PHASE5_DB_PATH ?? DEFAULT_DB_PATH;

const ENV_LOCAL_PATH = resolve(
  process.cwd(),
  process.cwd().endsWith('apps/desktop') ? '.env.local' : 'apps/desktop/.env.local',
);

// ── Types ────────────────────────────────────────────────────────────
type SessionKeyStatus = 'Installed' | 'Revoked' | 'Orphan';

interface SessionKeyRow {
  readonly id: number;
  readonly session_key_address: string;
  readonly created_at: number;
  readonly revoked_at: number | null;
  readonly stronghold_handle: string;
  readonly valid_until: number;
  readonly install_audit_id: number | null;
}

interface AuditRow {
  readonly id: number;
  readonly timestamp: number;
  readonly action: string;
  readonly tx_hash: string | null;
  readonly description: string;
  readonly metadata_json: string | null;
}

interface ClassifiedKey {
  readonly row: SessionKeyRow;
  readonly status: SessionKeyStatus;
}

interface Finding {
  readonly id: string;
  readonly label: string;
  readonly level: 'INFO' | 'OK' | 'WARN' | 'FAIL';
  readonly detail: string;
}

type Verdict =
  | 'CLEAN'
  | 'INSTALLED_HEALTHY'
  | 'SCENARIO_A_GENERATED_ONLY'
  | 'SCENARIO_B_AUDIT_REGRESSION'
  | 'SCENARIO_C_SILENT_FAIL'
  | 'UNEXPECTED';

// ── Main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const findings: Finding[] = [];

  const env = checkEnvironment();
  findings.push(env.finding);
  if (env.finding.level === 'FAIL' || !env.alchemyUrl) {
    printReport(findings, 'UNEXPECTED', []);
    process.exit(2);
  }

  let keys: ClassifiedKey[];
  let recentAudit: AuditRow[];
  let skAudit: AuditRow[];
  let latestInstall: AuditRow | null;
  try {
    keys = readAndClassifySessionKeys();
    recentAudit = readRecentAudit(10);
    skAudit = readSessionKeyAudit();
    latestInstall = readLatestInstallEntry();
  } catch (err) {
    console.error('\n[phase5-session-diagnostic] fatal DB error:', err);
    process.exit(2);
  }

  // ── DB check 1: session_keys status classification ───────────────
  findings.push(buildKeyClassificationFinding(keys));

  // ── DB check 2: last 10 audit_log entries ────────────────────────
  findings.push(buildRecentAuditFinding(recentAudit));

  // ── DB check 3: session_key_* timeline ───────────────────────────
  findings.push(buildSessionKeyTimelineFinding(skAudit));

  // ── DB check 4 + integrity 1: policyHash + policyVersion + prefix match ─
  findings.push(buildLatestInstallFinding(latestInstall, keys));

  // ── DB check 5: DB integrity (orphan detection) ──────────────────
  findings.push(buildIntegrityFinding(keys));

  // ── On-chain 6: SA deployed ──────────────────────────────────────
  const client = createPublicClient({
    chain: mainnet,
    transport: http(env.alchemyUrl),
  }) as PublicClient;
  try {
    findings.push(await checkSaDeployed(client));
  } catch (err) {
    findings.push({
      id: 'sa-deployed',
      label: 'SA deployed on-chain',
      level: 'FAIL',
      detail: `RPC read failed: ${String(err)}`,
    });
  }

  // ── On-chain 7 (lightweight): install_tx_hash = lazy-install sentinel ─
  findings.push(buildLazyInstallSentinelFinding(keys));

  // ── VERDICT ──────────────────────────────────────────────────────
  const { verdict, next } = decideVerdict(keys, latestInstall);
  printReport(findings, verdict, next);

  // Exit code mapping
  if (verdict === 'INSTALLED_HEALTHY' || verdict === 'CLEAN') {
    process.exit(0);
  }
  process.exit(1);
}

// ── Env ──────────────────────────────────────────────────────────────
function checkEnvironment(): { finding: Finding; alchemyUrl: string | null } {
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
        issues.push(`NEXT_PUBLIC_ALCHEMY_API_KEY missing or empty in ${ENV_LOCAL_PATH}`);
      }
    } catch (err) {
      issues.push(`Failed to read ${ENV_LOCAL_PATH}: ${String(err)}`);
    }
  } else {
    alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? null;
    if (!alchemyKey) {
      issues.push(
        `.env.local not found at ${ENV_LOCAL_PATH} and NEXT_PUBLIC_ALCHEMY_API_KEY not in process.env`,
      );
    }
  }

  if (!existsSync(DB_PATH)) {
    issues.push(
      `LiqAI local DB not found at ${DB_PATH}. Set PHASE5_DB_PATH env to override.`,
    );
  }

  try {
    execSync('sqlite3 -version', { stdio: 'ignore' });
  } catch {
    issues.push('sqlite3 CLI not found on PATH.');
  }

  const ok = issues.length === 0;
  return {
    alchemyUrl: alchemyKey
      ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
      : null,
    finding: {
      id: 'env',
      label: 'Environment (Node 22+, Alchemy, DB, sqlite3)',
      level: ok ? 'OK' : 'FAIL',
      detail: ok
        ? `Node ${process.versions.node}, DB at ${DB_PATH}`
        : issues.join(' | '),
    },
  };
}

// ── DB reader helpers (JSON mode for multi-column safety) ───────────
function runJson<T>(sql: string): T[] {
  const out = execSync(`sqlite3 -json "${DB_PATH}" "${sql.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
  if (!out) return [];
  return JSON.parse(out) as T[];
}

function readAndClassifySessionKeys(): ClassifiedKey[] {
  // For each session_keys row, find the most recent audit_log entry
  // with action='session_key_installed' whose metadata_json or
  // description mentions the session key address. That is how the
  // Phase 1 spec ties the audit entry back to the row (no FK).
  const rows = runJson<SessionKeyRow>(
    `SELECT sk.id, sk.session_key_address, sk.created_at, sk.revoked_at,
            sk.stronghold_handle, sk.valid_until,
            (SELECT al.id FROM audit_log al
              WHERE al.action = 'session_key_installed'
                AND (al.metadata_json LIKE '%' || sk.session_key_address || '%'
                     OR al.description LIKE '%' || sk.session_key_address || '%')
              ORDER BY al.timestamp DESC LIMIT 1) AS install_audit_id
       FROM session_keys sk
      ORDER BY sk.id DESC`,
  );

  return rows.map((row) => ({ row, status: classify(row) }));
}

function classify(row: SessionKeyRow): SessionKeyStatus {
  if (row.revoked_at != null) return 'Revoked';
  if (row.stronghold_handle && row.stronghold_handle.length > 0 && row.install_audit_id != null) {
    return 'Installed';
  }
  // revoked_at NULL + (no handle OR no install audit) = Orphan.
  // Note: per Phase 1 analysis, handleGenerate writes NO row, so a row
  // existing at all means installSessionKey reached L151. Missing
  // audit entry ⇒ L187 writeAudit threw after L151 succeeded.
  return 'Orphan';
}

function readRecentAudit(limit: number): AuditRow[] {
  return runJson<AuditRow>(
    `SELECT id, timestamp, action, tx_hash, description, metadata_json
       FROM audit_log
       ORDER BY timestamp DESC, id DESC
       LIMIT ${limit}`,
  );
}

function readSessionKeyAudit(): AuditRow[] {
  return runJson<AuditRow>(
    `SELECT id, timestamp, action, tx_hash, description, metadata_json
       FROM audit_log
       WHERE action LIKE 'session_key_%'
       ORDER BY timestamp DESC, id DESC`,
  );
}

function readLatestInstallEntry(): AuditRow | null {
  const rows = runJson<AuditRow>(
    `SELECT id, timestamp, action, tx_hash, description, metadata_json
       FROM audit_log
       WHERE action = 'session_key_installed'
       ORDER BY timestamp DESC, id DESC
       LIMIT 1`,
  );
  return rows[0] ?? null;
}

// ── Finding builders ────────────────────────────────────────────────
function buildKeyClassificationFinding(keys: ClassifiedKey[]): Finding {
  if (keys.length === 0) {
    return {
      id: 'session-keys-classification',
      label: 'session_keys status classification',
      level: 'INFO',
      detail: 'No session_keys rows present. Fresh install state (expected pre-§3.1.2).',
    };
  }
  const installed = keys.filter((k) => k.status === 'Installed');
  const revoked = keys.filter((k) => k.status === 'Revoked');
  const orphan = keys.filter((k) => k.status === 'Orphan');

  const lines = keys.map((k) => {
    const ts = new Date(k.row.created_at * 1000).toISOString();
    return `    [${k.status}] id=${k.row.id} addr=${k.row.session_key_address} created=${ts} audit_id=${k.row.install_audit_id ?? 'NONE'}`;
  });

  const level: Finding['level'] = orphan.length > 0 ? 'FAIL' : 'OK';
  const header =
    `Total: ${keys.length} row(s) — ` +
    `Installed: ${installed.length}, Revoked: ${revoked.length}, Orphan: ${orphan.length}`;
  return {
    id: 'session-keys-classification',
    label: 'session_keys status classification (Installed / Revoked / Orphan)',
    level,
    detail: [header, ...lines].join('\n'),
  };
}

function buildRecentAuditFinding(rows: AuditRow[]): Finding {
  if (rows.length === 0) {
    return {
      id: 'recent-audit',
      label: 'Recent audit_log entries (last 10)',
      level: 'INFO',
      detail: 'audit_log is empty.',
    };
  }
  const lines = rows.map((r) => {
    const ts = new Date(r.timestamp * 1000).toISOString();
    const desc = r.description.replace(/\s+/g, ' ').slice(0, 80);
    return `    [${ts}] ${r.action.padEnd(28)} ${desc}`;
  });
  return {
    id: 'recent-audit',
    label: 'Recent audit_log entries (last 10)',
    level: 'INFO',
    detail: lines.join('\n'),
  };
}

function buildSessionKeyTimelineFinding(rows: AuditRow[]): Finding {
  if (rows.length === 0) {
    return {
      id: 'session-key-timeline',
      label: 'session_key_* action chronology',
      level: 'INFO',
      detail: 'No session_key_* audit entries. Nothing has been installed or revoked.',
    };
  }
  const lines = rows.map((r) => {
    const ts = new Date(r.timestamp * 1000).toISOString();
    return `    [${ts}] ${r.action.padEnd(28)} id=${r.id}`;
  });
  return {
    id: 'session-key-timeline',
    label: 'session_key_* action chronology (full history)',
    level: 'INFO',
    detail: lines.join('\n'),
  };
}

function buildLatestInstallFinding(
  row: AuditRow | null,
  keys: ClassifiedKey[],
): Finding {
  if (!row) {
    return {
      id: 'latest-install-integrity',
      label: 'Latest session_key_installed entry: policyHash + policyVersion + prefix match',
      level: 'INFO',
      detail: 'No session_key_installed entries in audit_log. Install has never succeeded.',
    };
  }
  // If the latest install entry references a key that is now Revoked
  // in session_keys, this is a historical entry — missing Phase-4.4
  // fields just means the entry pre-dates 2026-04-23. Downgrade to INFO
  // so the operator doesn't read "FAIL" as a present-tense regression.
  const referencedAddress = extractSessionKeyAddress(row);
  const referencedClass = referencedAddress
    ? keys.find(
        (k) =>
          k.row.session_key_address.toLowerCase() ===
          referencedAddress.toLowerCase(),
      )
    : undefined;
  const isHistorical =
    referencedClass !== undefined && referencedClass.status === 'Revoked';
  const ts = new Date(row.timestamp * 1000).toISOString();
  const issues: string[] = [];
  let hash: string | null = null;
  let version: string | null = null;
  if (!row.metadata_json) {
    issues.push('metadata_json is NULL (Phase 4.4 regression — writeAudit dropped metadata)');
  } else {
    try {
      const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
      hash = typeof meta.policyHash === 'string' ? meta.policyHash : null;
      version = typeof meta.policyVersion === 'string' ? meta.policyVersion : null;
      if (!hash) issues.push('metadata_json lacks policyHash field');
      if (!version) issues.push('metadata_json lacks policyVersion field');
      if (version && version !== EXPECTED_POLICY_VERSION) {
        issues.push(
          `policyVersion = "${version}" but expected "${EXPECTED_POLICY_VERSION}"`,
        );
      }
      if (hash && !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        issues.push(`policyHash malformed (expected 0x + 64 hex): "${hash}"`);
      }
    } catch (err) {
      issues.push(`metadata_json not valid JSON: ${String(err)}`);
    }
  }

  // Prefix integrity: description embeds policyHash.slice(0, 10) per
  // sessionKeyInstall.ts:197. Verify the 10-char fragment is present.
  if (hash) {
    const prefix = hash.slice(0, 10);
    if (!row.description.includes(prefix)) {
      issues.push(
        `description does not contain metadata_json policyHash prefix "${prefix}" ` +
          `— possible tamper or unrelated write path (expected description ` +
          `"…policyHash=${prefix}…)"`,
      );
    }
  }

  // Severity: OK if no issues. If issues present, FAIL only when the
  // referenced key is still Installed (live regression). If the key is
  // Revoked, downgrade to INFO with a "historical" note — the entry
  // pre-dates Phase 4.4 and doesn't describe current install integrity.
  const level: Finding['level'] =
    issues.length === 0 ? 'OK' : isHistorical ? 'INFO' : 'FAIL';
  const core =
    `id=${row.id} ts=${ts} tx_hash=${row.tx_hash ?? 'NULL'}\n` +
    `    description: ${row.description.slice(0, 140)}${row.description.length > 140 ? '…' : ''}\n` +
    `    policyHash=${hash ?? 'MISSING'}\n` +
    `    policyVersion=${version ?? 'MISSING'}`;
  const historyNote = isHistorical
    ? `\n    NOTE: this entry is for a now-Revoked session key. Missing Phase-4.4 fields here ` +
      `indicate a pre-2026-04-23 install, not a current regression.`
    : '';
  return {
    id: 'latest-install-integrity',
    label: 'Latest session_key_installed: policyHash + policyVersion + prefix match',
    level,
    detail:
      (issues.length === 0 ? core : core + '\n    ISSUES:\n      - ' + issues.join('\n      - ')) +
      historyNote,
  };
}

// Extract the sessionKeyAddress referenced by an audit entry. Looks
// first at metadata_json.sessionKeyAddress, then falls back to a
// regex scan of the description.
function extractSessionKeyAddress(row: AuditRow): string | null {
  if (row.metadata_json) {
    try {
      const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
      if (typeof meta.sessionKeyAddress === 'string') return meta.sessionKeyAddress;
    } catch {
      // fall through to regex
    }
  }
  const match = row.description.match(/0x[0-9a-fA-F]{40}/);
  return match?.[0] ?? null;
}

function buildIntegrityFinding(keys: ClassifiedKey[]): Finding {
  const orphan = keys.filter((k) => k.status === 'Orphan');
  if (orphan.length === 0) {
    return {
      id: 'db-integrity-orphan',
      label: 'DB integrity: orphan rows (session_keys row + no matching install audit)',
      level: 'OK',
      detail: 'No orphan rows detected.',
    };
  }
  const lines = orphan.map((k) => {
    const ts = new Date(k.row.created_at * 1000).toISOString();
    return `    orphan id=${k.row.id} addr=${k.row.session_key_address} created=${ts} handle_len=${k.row.stronghold_handle?.length ?? 0}`;
  });
  return {
    id: 'db-integrity-orphan',
    label: 'DB integrity: orphan rows (abnormal)',
    level: 'FAIL',
    detail:
      `${orphan.length} orphan row(s) — session_keys row exists with revoked_at NULL, ` +
      `but no matching audit_log session_key_installed entry. This is the β-regression ` +
      `signature (L187 writeAudit threw after L151 INSERT succeeded).\n` +
      lines.join('\n'),
  };
}

async function checkSaDeployed(client: PublicClient): Promise<Finding> {
  const code = await client.getCode({ address: SA });
  const deployed = code !== undefined && code !== '0x' && code.length > 2;
  return {
    id: 'sa-deployed',
    label: `SA deployed on-chain (${SA})`,
    level: deployed ? 'OK' : 'FAIL',
    detail: deployed
      ? `Bytecode present (${code!.length} chars). SA is counter-factually deployed — validator can attach on first userOp.`
      : `Bytecode missing. SA not deployed. §3.1.1 Mint is prerequisite for §3.1.2 Install.`,
  };
}

function buildLazyInstallSentinelFinding(keys: ClassifiedKey[]): Finding {
  const installed = keys.filter((k) => k.status === 'Installed');
  if (installed.length === 0) {
    return {
      id: 'lazy-install-sentinel',
      label: 'install_tx_hash = sentinel (lazy-install design)',
      level: 'INFO',
      detail: 'No Installed session_keys rows. Sentinel check N/A.',
    };
  }
  // For installed rows we expect install_tx_hash = LAZY_INSTALL_SENTINEL
  // because the on-chain plugin install happens lazily on first use.
  // Read the raw column since the classification query didn't include it.
  const rows = runJson<{ id: number; install_tx_hash: string }>(
    `SELECT id, install_tx_hash FROM session_keys WHERE id IN (${installed.map((k) => k.row.id).join(',')})`,
  );
  const bad = rows.filter((r) => r.install_tx_hash !== LAZY_INSTALL_SENTINEL);
  if (bad.length === 0) {
    return {
      id: 'lazy-install-sentinel',
      label: 'install_tx_hash = sentinel (lazy-install design)',
      level: 'OK',
      detail:
        `All ${installed.length} Installed row(s) carry the expected sentinel hash. ` +
        `The on-chain validator install will happen on the first userOp (Stage 1 rebalance #1 / ENABLE mode).`,
    };
  }
  return {
    id: 'lazy-install-sentinel',
    label: 'install_tx_hash = sentinel (lazy-install design)',
    level: 'WARN',
    detail:
      `${bad.length} Installed row(s) have a non-sentinel install_tx_hash — possible schema drift: ` +
      bad.map((b) => `id=${b.id} tx=${b.install_tx_hash}`).join(', '),
  };
}

// ── Verdict + UI prompt ─────────────────────────────────────────────
interface VerdictDecision {
  readonly verdict: Verdict;
  readonly next: string[]; // plain-text lines for operator
}

function decideVerdict(
  keys: ClassifiedKey[],
  latestInstall: AuditRow | null,
): VerdictDecision {
  const active = keys.filter((k) => k.status !== 'Revoked');
  const installed = keys.filter((k) => k.status === 'Installed');
  const orphan = keys.filter((k) => k.status === 'Orphan');
  const allRevokedOrEmpty = keys.length === 0 || keys.every((k) => k.status === 'Revoked');

  // Fresh post-revoke state + no install audit referencing a non-revoked
  // key today. Either nothing has been tried yet, or an attempt failed
  // before L151 (passphrase/wallet reject) OR L135 serialize threw
  // (still before DB write).
  if (allRevokedOrEmpty) {
    // latestInstall may be an OLD entry for a now-revoked key. Is any
    // audit install entry post-dating the latest revoke? If so, that's
    // an unusual pattern worth surfacing. Otherwise → SCENARIO_A.
    return {
      verdict: 'SCENARIO_A_GENERATED_ONLY',
      next: [
        '【要 UI 確認】SCENARIO_A_GENERATED_ONLY 暫定判定。LiqAI UI の Session Key Panel で以下の挙動/表示を確認してください:',
        '',
        '  1. "Generation failed: Smart Account address not yet derived" 赤文字',
        '      (Install target ラベルは同時表示、かつ wallet 再接続・app 再起動後も再現)',
        '      → SCENARIO_A_HOOK_REGRESSION (React hook stale closure, 2026-04-23 incident と同型)',
        '      → remediation: SessionKeyPanel.tsx handleGenerate の useCallback deps に saAddress が',
        '         含まれているか確認。他の UI-hook でも同種 regression がないか lint:hooks を実行。',
        '',
        '  2. "Install failed: …" 赤文字 (install button を押した後)',
        '      → SCENARIO_A_DOUBLE_PRIME (L135 wallet reject or L151 DB insert error)',
        '      → remediation: wallet popup で Approve、または ~/Library/Application Support/',
        '         app.liqai.desktop/ の書き込み権限を確認',
        '',
        '  3. "Passphrase rejected: …" 赤文字',
        '      → SCENARIO_A_PRIME (L91 passphrase 強度 reject)',
        '      → remediation: diceware 5 語以上 or 14 文字 mixed で再入力',
        '',
        '  4. error 表示なし、Generate ボタンクリック自体していない',
        '      → SCENARIO_A (本来の α、Install flow 未着手)',
        '      → remediation: §3.1.2 Step A → Step C を順に実行',
        '',
        '【要観察事項】',
        '  - Wallet 再接続後も同 error が再現するか (YES → hook regression 疑い強)',
        '  - アプリ再起動後も同 error が再現するか (YES → code 側 bug / NO → 一時的 RPC failure)',
        '  - "Install target: 0x…" 表示と error 表示が同時に見えるか (YES → stale closure classic signature)',
        '',
        'VERDICT 確定のためこの確認が必要。該当項目があれば Opus / architectural reviewer に報告してください。',
      ],
    };
  }

  if (orphan.length > 0 && installed.length === 0) {
    return {
      verdict: 'SCENARIO_B_AUDIT_REGRESSION',
      next: [
        `Orphan ${orphan.length} row(s) without matching audit_log installed entry.`,
        'L151 INSERT session_keys は成功したが L187 writeAudit が失敗した可能性 (β/Phase 4.4 regression)。',
        '',
        '次アクション:',
        '  1) Session Key Panel から orphan row を Revoke し ciphertext を erase',
        '  2) phase5:preflight を再実行し全 PASS 確認',
        '  3) LiqAI console log で writeAudit 失敗理由を調査 (Zod parse / SQLite error)',
        '  4) 修正後、§3.1.2 Step C を再実行',
        '  5) Phase 4.4 の integration test を追加 (L187 failure mode)',
      ],
    };
  }

  if (installed.length >= 1 && orphan.length === 0) {
    const integrityClean =
      latestInstall !== null &&
      latestInstall.metadata_json !== null &&
      /"policyHash"\s*:\s*"0x[0-9a-fA-F]{64}"/.test(latestInstall.metadata_json) &&
      /"policyVersion"\s*:\s*"Q1-fix-2026-04-22"/.test(latestInstall.metadata_json);
    return {
      verdict: integrityClean ? 'INSTALLED_HEALTHY' : 'SCENARIO_C_SILENT_FAIL',
      next: integrityClean
        ? [
            `${installed.length} Installed session key(s) present with valid policyHash + policyVersion.`,
            'Phase 4.4 integrity 維持。§3.1.3 (24h bot 運用) に進行可能。',
          ]
        : [
            'Installed row present but metadata_json integrity 不完全。',
            'policyHash または policyVersion が欠落。Phase 4.4 regression の可能性 — 調査後に再 install。',
          ],
    };
  }

  if (installed.length > 0 && orphan.length > 0) {
    return {
      verdict: 'UNEXPECTED',
      next: [
        `Mixed state: Installed=${installed.length} AND Orphan=${orphan.length}.`,
        '複数 install 試行の混在。手動調査が必要:',
        '  1) Session Key Panel を開き active key を確認',
        '  2) Orphan row を revoke',
        '  3) Installed row は保持',
        '  4) 再度この診断 script を実行',
      ],
    };
  }

  return {
    verdict: 'UNEXPECTED',
    next: [
      `Classification did not match any known scenario. active=${active.length} installed=${installed.length} orphan=${orphan.length}.`,
      '手動調査が必要。各 finding の detail を精査してください。',
    ],
  };
}

// ── Reporting ────────────────────────────────────────────────────────
function printReport(findings: Finding[], verdict: Verdict, next: string[]): void {
  console.log('');
  console.log('========================================================');
  console.log('  Phase 5 §3.1.2 session-key state diagnostic');
  console.log('  Target SA: ' + SA);
  console.log('========================================================');
  console.log('');

  for (const f of findings) {
    const tag = f.level.padStart(4);
    console.log(`  ${tag}  [${f.id}] ${f.label}`);
    for (const line of f.detail.split('\n')) {
      console.log(`         ${line}`);
    }
    console.log('');
  }

  console.log('--------------------------------------------------------');
  console.log(`  VERDICT: ${verdict}`);
  console.log('--------------------------------------------------------');
  if (next.length > 0) {
    console.log('');
    for (const line of next) console.log('  ' + line);
  }
  console.log('');
  console.log('========================================================');
  console.log('');
}

main();

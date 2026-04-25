-- LiqAI v2 local database schema
--
-- All user state is stored locally in this SQLite DB. The DB file lives in
-- the OS-specific app data directory (see tauri::api::path::app_data_dir).
--
-- SECURITY (docs/security-v2.md S5.1):
--   - Everything here is on-disk, never transmitted over the network.
--   - Private keys are NEVER stored here. Session keys that ARE stored are
--     encrypted at-rest using the OS keychain (Stronghold) + a user passphrase.
--   - All writes go through parametrised queries only.
--
-- NOTE: SQLite PRAGMAs (journal_mode, synchronous, foreign_keys) cannot be
-- set inside the transaction that wraps this migration. They are applied
-- per-connection by the JS layer (see apps/desktop/src/lib/db.ts).

-- ── Schema versioning (for future migrations) ────────────────────────────
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

-- ── User-owned Smart Accounts ────────────────────────────────────────────
-- One row per (chain, EOA) tuple. The Smart Account is derived from the EOA.
CREATE TABLE IF NOT EXISTS smart_accounts (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id                INTEGER NOT NULL,
  owner_eoa_address       TEXT    NOT NULL,
  smart_account_address   TEXT    NOT NULL,
  entry_point_address     TEXT    NOT NULL,
  kernel_implementation   TEXT    NOT NULL,
  deployed_at             INTEGER NOT NULL,  -- unix seconds
  deployment_tx_hash      TEXT    NOT NULL,
  UNIQUE (chain_id, owner_eoa_address)
);
CREATE INDEX IF NOT EXISTS idx_smart_accounts_owner
  ON smart_accounts(owner_eoa_address);

-- ── LP positions owned by the user's Smart Account ──────────────────────
CREATE TABLE IF NOT EXISTS lp_positions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  smart_account_id     INTEGER NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
  chain_id             INTEGER NOT NULL,
  lp_token_id          TEXT    NOT NULL,   -- uint256 as string
  pool_address         TEXT    NOT NULL,
  token0_address       TEXT    NOT NULL,
  token1_address       TEXT    NOT NULL,
  fee_tier             INTEGER NOT NULL,
  tick_lower           INTEGER NOT NULL,
  tick_upper           INTEGER NOT NULL,
  liquidity            TEXT    NOT NULL,   -- uint128 as string
  minted_at            INTEGER NOT NULL,
  closed_at            INTEGER,
  status               TEXT    NOT NULL CHECK (status IN ('active','closed','pending')),
  UNIQUE (chain_id, lp_token_id)
);
CREATE INDEX IF NOT EXISTS idx_lp_positions_smart_account
  ON lp_positions(smart_account_id);
CREATE INDEX IF NOT EXISTS idx_lp_positions_status
  ON lp_positions(status);

-- ── Rebalance history ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rebalance_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lp_position_id    INTEGER NOT NULL REFERENCES lp_positions(id) ON DELETE CASCADE,
  trigger           TEXT    NOT NULL CHECK (trigger IN ('range_exit','spike','dip','wick','scheduled','manual')),
  old_tick_lower    INTEGER NOT NULL,
  old_tick_upper    INTEGER NOT NULL,
  new_tick_lower    INTEGER NOT NULL,
  new_tick_upper    INTEGER NOT NULL,
  executed_at       INTEGER NOT NULL,
  tx_hash           TEXT    NOT NULL,
  initiated_by      TEXT    NOT NULL CHECK (initiated_by IN ('user','session_key','gelato')),
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_rebalance_history_position
  ON rebalance_history(lp_position_id, executed_at DESC);

-- ── Session keys + policy enforcement metadata ──────────────────────────
-- NOTE: the session key PRIVATE KEY is NOT stored in this table. It is kept
-- in Tauri's Stronghold (OS keychain) under a handle referenced by
-- `stronghold_handle`.
CREATE TABLE IF NOT EXISTS session_keys (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  smart_account_id           INTEGER NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
  session_key_address        TEXT    NOT NULL,
  stronghold_handle          TEXT    NOT NULL,
  allowed_target_address     TEXT    NOT NULL,
  allowed_selectors_json     TEXT    NOT NULL,  -- JSON array of 0x-selectors
  lp_token_id                TEXT    NOT NULL,
  valid_after                INTEGER NOT NULL,
  valid_until                INTEGER NOT NULL,
  max_executions_per_24h     INTEGER NOT NULL,
  created_at                 INTEGER NOT NULL,
  install_tx_hash            TEXT    NOT NULL,
  revoked_at                 INTEGER,
  revoke_tx_hash             TEXT,
  UNIQUE (smart_account_id, session_key_address)
);
CREATE INDEX IF NOT EXISTS idx_session_keys_smart_account
  ON session_keys(smart_account_id);

-- ── Gelato task registrations ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gelato_tasks (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key_id         INTEGER NOT NULL REFERENCES session_keys(id) ON DELETE CASCADE,
  task_id                TEXT    NOT NULL UNIQUE,
  chain_id               INTEGER NOT NULL,
  resolver_url           TEXT,
  resolver_contract      TEXT,
  resolver_data          TEXT,
  label                  TEXT    NOT NULL,
  registered_at          INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,
  cancelled_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gelato_tasks_session_key
  ON gelato_tasks(session_key_id);

-- ── Local execution log (client-side rate limiter persistence) ─────────
CREATE TABLE IF NOT EXISTS execution_log (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key_address    TEXT    NOT NULL,
  action                 TEXT    NOT NULL,
  timestamp              INTEGER NOT NULL,  -- unix seconds
  tx_hash                TEXT
);
CREATE INDEX IF NOT EXISTS idx_execution_log_session
  ON execution_log(session_key_address, timestamp DESC);

-- ── Audit log (append-only, no updates/deletes) ────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       INTEGER NOT NULL,
  action          TEXT    NOT NULL,
  actor_address   TEXT    NOT NULL,
  chain_id        INTEGER,
  target_address  TEXT,
  tx_hash         TEXT,
  description     TEXT    NOT NULL,
  metadata_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_time
  ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log(actor_address, timestamp DESC);

-- Trigger-enforced append-only: NO updates, NO deletes on audit_log.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
  BEFORE UPDATE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
  END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
  BEFORE DELETE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
  END;

-- ── App settings ──────────────────────────────────────────────────────
-- Single-row config table. Uses a CHECK constraint to enforce singleton.
CREATE TABLE IF NOT EXISTS app_settings (
  id                         INTEGER PRIMARY KEY CHECK (id = 1),
  default_slippage_bps       INTEGER NOT NULL DEFAULT 50,
  default_deadline_sec       INTEGER NOT NULL DEFAULT 300,
  rpc_url_ethereum           TEXT,
  coingecko_api_key          TEXT,
  gelato_api_key             TEXT,
  zerodev_project_id         TEXT,
  telemetry_opt_in           INTEGER NOT NULL DEFAULT 0 CHECK (telemetry_opt_in IN (0, 1)),
  updated_at                 INTEGER NOT NULL
);
INSERT OR IGNORE INTO app_settings (id, updated_at)
  VALUES (1, strftime('%s', 'now'));

-- ── Initial schema version marker ─────────────────────────────────────
INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (1, strftime('%s', 'now'));

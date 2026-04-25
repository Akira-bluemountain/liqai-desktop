-- Fee snapshots for realized APR calculation.
--
-- Each row records a point-in-time observation of the pending fees on one LP
-- NFT, obtained via a static call to NPM.collect. Snapshots are written by
-- the rebalance bot on every 5-minute evaluation tick.
--
-- Why a separate table (not derived from rebalance_history):
--   - rebalance_history only captures events, not the smooth fee accrual
--     between events. 24h rolling APR needs continuous samples.
--   - The snapshot records cumulative tokensOwed at the NFT level, so
--     realized fee over [t0, t1] is (owed_at_t1 − owed_at_t0). When a
--     rebalance collects fees the cumulative resets — the consumer code
--     handles that by summing positive deltas only.
--
-- Size budget: 288 rows/day/position × 30 days ≈ 8.6k rows. Negligible.

CREATE TABLE IF NOT EXISTS fee_snapshots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  lp_position_id       INTEGER NOT NULL REFERENCES lp_positions(id) ON DELETE CASCADE,
  timestamp            INTEGER NOT NULL,            -- unix seconds
  tokens_owed0         TEXT    NOT NULL,            -- uint128 as string (token0, typically USDC)
  tokens_owed1         TEXT    NOT NULL,            -- uint128 as string (token1, typically WETH)
  eth_usd_price        REAL    NOT NULL,            -- derived from pool slot0
  position_value_usd   REAL    NOT NULL             -- principal at this timestamp
);

CREATE INDEX IF NOT EXISTS idx_fee_snapshots_position_time
  ON fee_snapshots(lp_position_id, timestamp DESC);

INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (2, strftime('%s', 'now'));

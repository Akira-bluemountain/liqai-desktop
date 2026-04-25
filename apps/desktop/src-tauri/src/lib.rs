//! LiqAI desktop — Tauri Rust backend entrypoint.
//!
//! SECURITY (docs/security-v2.md S2.1):
//!   - Minimal surface: only the plugins the UI absolutely needs are enabled.
//!   - No custom IPC commands added unless strictly required.
//!   - SQLite migrations defined in-Rust and applied on startup.
//!   - Stronghold plugin will be added in the session-key phase.

use tauri_plugin_sql::{Migration, MigrationKind};

/// Build the migration list. This is the only way the schema can change
/// between releases; each migration is reviewed per the security policy.
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial schema (smart accounts, lp positions, session keys, audit log)",
            sql: include_str!("../migrations/001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "fee snapshots for realized APR",
            sql: include_str!("../migrations/002_fee_snapshots.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:liqai.db", migrations())
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running LiqAI");
}

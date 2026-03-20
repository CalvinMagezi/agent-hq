use anyhow::Result;
use rusqlite::Connection;
use tracing::info;

const MIGRATIONS: &[(&str, &str)] = &[
    ("001_initial", include_str!("../sql/001_initial.sql")),
    ("002_graph_links", include_str!("../sql/002_graph_links.sql")),
    ("003_memory_system", include_str!("../sql/003_memory_system.sql")),
];

pub fn run(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
            version TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    for (version, sql) in MIGRATIONS {
        let already_applied: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM schema_version WHERE version = ?1",
            [version],
            |row| row.get(0),
        )?;

        if !already_applied {
            conn.execute_batch(sql)?;
            conn.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                [version],
            )?;
            info!(version = %version, "applied migration");
        }
    }

    Ok(())
}

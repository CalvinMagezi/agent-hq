//! Plan management — sync plan files from the vault into the database.

use anyhow::Result;
use hq_db::Database;
use hq_vault::VaultClient;
use tracing::{debug, info, warn};

/// Sync plan status from vault plan files into the database.
///
/// Reads plan markdown files from `_plans/` in the vault, parses their
/// frontmatter for status information, and updates the plans table in the DB.
pub fn sync_plan_status(vault: &VaultClient, db: &Database) -> Result<()> {
    let plans_dir = vault.vault_path().join("_plans");
    if !plans_dir.exists() {
        debug!("no _plans directory, skipping plan sync");
        return Ok(());
    }

    let mut synced = 0;

    for entry in std::fs::read_dir(&plans_dir)? {
        let entry = entry?;
        let path = entry.path();

        if !path.extension().is_some_and(|ext| ext == "md") {
            continue;
        }

        let plan_id = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                warn!(plan_id = %plan_id, error = %e, "failed to read plan file");
                continue;
            }
        };

        // Parse frontmatter for plan metadata
        let (title, status) = parse_plan_frontmatter(&content, &plan_id);
        let now = chrono::Utc::now().to_rfc3339();

        // Upsert into the plans table
        if let Err(e) = db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO plans (plan_id, title, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(plan_id) DO UPDATE SET
                     status = excluded.status,
                     updated_at = excluded.updated_at",
                rusqlite::params![plan_id, title, status, now],
            )?;
            Ok(())
        }) {
            warn!(plan_id = %plan_id, error = %e, "failed to sync plan to DB");
            continue;
        }

        // Parse and sync plan steps (checklist items in the markdown body)
        if let Err(e) = sync_plan_steps(db, &plan_id, &content) {
            warn!(plan_id = %plan_id, error = %e, "failed to sync plan steps");
        }

        synced += 1;
        debug!(plan_id = %plan_id, status = %status, "synced plan");
    }

    if synced > 0 {
        info!(count = synced, "plan status sync complete");
    }

    Ok(())
}

/// Parse plan frontmatter to extract title and status.
fn parse_plan_frontmatter(content: &str, default_title: &str) -> (String, String) {
    let mut title = default_title.to_string();
    let mut status = "active".to_string();

    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("---") {
            let fm_block = &content[3..end_idx + 3];
            for line in fm_block.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("title:") {
                    title = val.trim().trim_matches('"').to_string();
                } else if let Some(val) = line.strip_prefix("status:") {
                    status = val.trim().trim_matches('"').to_string();
                }
            }
        }
    }

    // Fallback: use first heading as title
    if title == default_title {
        for line in content.lines() {
            if let Some(heading) = line.trim().strip_prefix("# ") {
                title = heading.trim().to_string();
                break;
            }
        }
    }

    (title, status)
}

/// Parse checklist items from plan markdown and sync them as plan steps.
fn sync_plan_steps(db: &Database, plan_id: &str, content: &str) -> Result<()> {
    let mut steps: Vec<(String, String)> = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();

        // Parse markdown checklist: "- [ ] Step title" or "- [x] Step title"
        if let Some(rest) = trimmed.strip_prefix("- [") {
            if rest.len() >= 2 {
                let checked = &rest[..1];
                if let Some(title) = rest[2..].strip_prefix("] ") {
                    let status = if checked == "x" || checked == "X" {
                        "completed"
                    } else {
                        "pending"
                    };
                    steps.push((title.trim().to_string(), status.to_string()));
                }
            }
        }
    }

    db.with_conn(|conn| {
        // Clear existing steps for this plan
        conn.execute("DELETE FROM plan_steps WHERE plan_id = ?1", [plan_id])?;

        for (i, (title, status)) in steps.iter().enumerate() {
            let step_id = format!("{}-step-{}", plan_id, i);
            conn.execute(
                "INSERT INTO plan_steps (step_id, plan_id, title, status, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![step_id, plan_id, title, status, i as i32],
            )?;
        }
        Ok(())
    })?;

    Ok(())
}

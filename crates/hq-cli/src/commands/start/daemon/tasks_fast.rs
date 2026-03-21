//! Fast-cycle daemon tasks (every 1 minute).

use anyhow::Result;
use std::path::Path;
use tracing::info;

use super::helpers::*;

/// Expire pending approval files older than 5 minutes.
pub async fn run_expire_approvals(vault_path: &Path) -> Result<()> {
    let pending_dir = vault_path.join("_approvals").join("pending");
    if pending_dir.exists() {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(300);
        let mut expired = 0u32;
        if let Ok(entries) = std::fs::read_dir(&pending_dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified < cutoff {
                            let _ = std::fs::remove_file(entry.path());
                            expired += 1;
                        }
                    }
                }
            }
        }
        if expired > 0 {
            info!(count = expired, "expire-approvals: removed expired approvals");
        }
    }
    Ok(())
}

/// Sync active plans — move fully-checked plans to completed/.
pub async fn run_plan_sync(vault_path: &Path) -> Result<()> {
    let plans_dir = vault_path.join("_plans").join("active");
    if plans_dir.exists() {
        let mut checked = 0u32;
        if let Ok(entries) = std::fs::read_dir(&plans_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "md") {
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        let total_steps = content.matches("- [").count();
                        let done_steps = content.matches("- [x]").count();
                        if total_steps > 0 && done_steps == total_steps {
                            let completed_dir = vault_path.join("_plans").join("completed");
                            ensure_dir(&completed_dir);
                            let dest = completed_dir.join(entry.file_name());
                            let _ = std::fs::rename(&path, &dest);
                            info!(plan = ?entry.file_name(), "plan-sync: plan completed");
                        }
                        checked += 1;
                    }
                }
            }
        }
        tracing::debug!(checked, "plan-sync: checked active plans");
    }
    Ok(())
}

/// Scan for recently modified notes (last 2 min) and mark them for embedding.
pub async fn run_embedding_on_change(vault_path: &Path) -> Result<()> {
    let notebooks_dir = vault_path.join("Notebooks");
    if notebooks_dir.exists() {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        let mut newly_modified = 0u32;
        scan_recent(&notebooks_dir, cutoff, &mut newly_modified);
        if newly_modified > 0 {
            tracing::debug!(
                count = newly_modified,
                "embedding-on-change: recently modified notes detected"
            );
        }
    }
    Ok(())
}

fn scan_recent(dir: &Path, cutoff: std::time::SystemTime, count: &mut u32) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan_recent(&path, cutoff, count);
            } else if path.extension().is_some_and(|e| e == "md") {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified > cutoff {
                            *count += 1;
                        }
                    }
                }
            }
        }
    }
}

/// Run scheduled Claude Code tasks from ~/.claude/scheduled-tasks/.
pub async fn run_claude_cron(vault_path: &Path) -> Result<()> {
    let home = dirs::home_dir().unwrap_or_default();
    let tasks_dir = home.join(".claude").join("scheduled-tasks");
    if !tasks_dir.exists() {
        return Ok(());
    }

    let now_eat_hour = current_eat_hour();
    let now_eat_minute = current_eat_minute();

    if let Ok(entries) = std::fs::read_dir(&tasks_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "md") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    process_cron_task(
                        vault_path,
                        &path,
                        &content,
                        now_eat_hour,
                        now_eat_minute,
                    );
                }
            }
        }
    }
    Ok(())
}

fn process_cron_task(
    vault_path: &Path,
    path: &Path,
    content: &str,
    now_eat_hour: u32,
    now_eat_minute: u32,
) {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return;
    }
    let Some(end_idx) = trimmed[3..].find("---") else {
        return;
    };
    let frontmatter = &trimmed[3..3 + end_idx];
    let body = trimmed[3 + end_idx + 3..].trim();
    if body.is_empty() {
        return;
    }

    for line in frontmatter.lines() {
        let line = line.trim();
        if !line.starts_with("schedule:") {
            continue;
        }
        let schedule = line["schedule:".len()..]
            .trim()
            .trim_matches('"')
            .trim_matches('\'');
        let task_name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        // Simple HH:MM matching
        if let Some((h, m)) = schedule.split_once(':') {
            if let (Ok(sh), Ok(sm)) = (h.trim().parse::<u32>(), m.trim().parse::<u32>()) {
                if sh == now_eat_hour && sm == now_eat_minute {
                    let flag = format!("claude-cron-{task_name}");
                    if !has_run_today(vault_path, &flag) {
                        info!(task = %task_name, "claude-cron-runner: firing scheduled task");
                        let body_owned = body.to_string();
                        tokio::spawn(async move {
                            let _ = tokio::process::Command::new("claude")
                                .args(["-p", &body_owned])
                                .stdout(std::process::Stdio::null())
                                .stderr(std::process::Stdio::null())
                                .stdin(std::process::Stdio::null())
                                .spawn();
                        });
                        mark_run_today(vault_path, &flag);
                    }
                }
                return;
            }
        }

        // Simple cron: */N * * * * (every N minutes)
        if schedule.starts_with("*/") {
            let parts: Vec<&str> = schedule.split_whitespace().collect();
            if let Some(interval_str) = parts.first() {
                if let Ok(interval) = interval_str[2..].parse::<u32>() {
                    if interval > 0 && now_eat_minute % interval == 0 {
                        let flag =
                            format!("claude-cron-{task_name}-{now_eat_hour}-{now_eat_minute}");
                        if !has_run_today(vault_path, &flag) {
                            info!(task = %task_name, "claude-cron-runner: firing cron task");
                            let body_owned = body.to_string();
                            tokio::spawn(async move {
                                let _ = tokio::process::Command::new("claude")
                                    .args(["-p", &body_owned])
                                    .stdout(std::process::Stdio::null())
                                    .stderr(std::process::Stdio::null())
                                    .stdin(std::process::Stdio::null())
                                    .spawn();
                            });
                            mark_run_today(vault_path, &flag);
                        }
                    }
                }
            }
        }
    }
}

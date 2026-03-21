//! Slow-cycle daemon tasks (6 hours — weekly).

use anyhow::Result;
use hq_db::Database;
use std::path::Path;
use tracing::info;

use super::helpers::*;

/// Full vault integrity check + graph link building.
pub async fn run_vault_health(vault_path: &Path, db: &Database) -> Result<()> {
    let sys_dir = vault_path.join("_system");
    ensure_dir(&sys_dir);

    let notebooks_dir = vault_path.join("Notebooks");
    let mut total_notes = 0u32;
    let mut broken_frontmatter = 0u32;
    let mut total_links = 0u32;
    let mut dead_links = 0u32;
    let mut all_note_stems: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut note_paths: Vec<std::path::PathBuf> = Vec::new();

    // Pass 1: Count notes, check frontmatter, collect stems
    if notebooks_dir.exists() {
        count_notes_and_stems(
            &notebooks_dir,
            &mut total_notes,
            &mut broken_frontmatter,
            &mut all_note_stems,
            &mut note_paths,
        );
    }

    // Pass 2: Scan wikilinks and build graph
    for path in &note_paths {
        if let Ok(content) = std::fs::read_to_string(path) {
            let path_str = path.to_string_lossy().to_string();
            let links = extract_wikilinks(&content);
            for link_target in &links {
                total_links += 1;
                let target_exists = all_note_stems.contains(&link_target.to_lowercase());
                if !target_exists {
                    dead_links += 1;
                }
                // Store in graph_links table
                let _ = db.with_conn(|conn| {
                    hq_db::search::add_graph_link(
                        conn,
                        &path_str,
                        link_target,
                        if target_exists { 1.0 } else { 0.0 },
                        "wikilink",
                    )
                });
            }
        }
    }

    let db_stats = db.with_conn(|conn| hq_db::search::get_stats(conn));
    let indexed = db_stats.as_ref().map(|s| s.fts_count).unwrap_or(0);
    let embedded = db_stats.as_ref().map(|s| s.embedding_count).unwrap_or(0);

    let now = chrono::Utc::now().to_rfc3339();
    let content = format!(
        "---\nchecked_at: {now}\ntotal_notes: {total_notes}\n\
         broken_frontmatter: {broken_frontmatter}\nindexed: {indexed}\n\
         embedded: {embedded}\ntotal_links: {total_links}\n\
         dead_links: {dead_links}\n---\n\n# Vault Health\n\nLast check: {now}\n\n\
         - **Total notes**: {total_notes}\n\
         - **Broken frontmatter**: {broken_frontmatter}\n\
         - **Indexed (FTS5)**: {indexed}\n\
         - **Embedded**: {embedded}\n\
         - **Wikilinks**: {total_links} total, {dead_links} dead\n\
         - **Link health**: {:.1}%\n",
        if total_links > 0 {
            ((total_links - dead_links) as f64 / total_links as f64) * 100.0
        } else {
            100.0
        }
    );
    std::fs::write(sys_dir.join("VAULT-HEALTH.md"), content)?;
    info!(
        total_notes,
        broken_frontmatter,
        indexed,
        embedded,
        total_links,
        dead_links,
        "vault-health: check complete"
    );
    Ok(())
}

fn count_notes_and_stems(
    dir: &Path,
    total: &mut u32,
    broken: &mut u32,
    stems: &mut std::collections::HashSet<String>,
    paths: &mut Vec<std::path::PathBuf>,
) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                count_notes_and_stems(&path, total, broken, stems, paths);
            } else if path.extension().is_some_and(|e| e == "md") {
                *total += 1;
                paths.push(path.clone());
                // Collect stem for wikilink resolution
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    stems.insert(stem.to_lowercase());
                }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let trimmed = content.trim();
                    if trimmed.starts_with("---") && trimmed[3..].find("---").is_none() {
                        *broken += 1;
                    }
                }
            }
        }
    }
}

/// Extract [[wikilink]] targets from markdown content.
fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut remaining = content;
    while let Some(start) = remaining.find("[[") {
        remaining = &remaining[start + 2..];
        if let Some(end) = remaining.find("]]") {
            let target = &remaining[..end];
            // Handle [[target|alias]] format
            let target = target.split('|').next().unwrap_or(target).trim();
            if !target.is_empty() && target.len() < 200 {
                links.push(target.to_string());
            }
            remaining = &remaining[end + 2..];
        } else {
            break;
        }
    }
    links
}

/// Archive stale threads (>7 days old).
pub async fn run_stale_thread_detector(vault_path: &Path) -> Result<()> {
    let threads_dir = vault_path.join("_threads");
    if !threads_dir.exists() {
        return Ok(());
    }

    let archive_dir = threads_dir.join("_archive");
    ensure_dir(&archive_dir);
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 86400);
    let mut archived = 0u32;

    if let Ok(entries) = std::fs::read_dir(&threads_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().is_some_and(|e| e == "md") {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified < cutoff {
                            let dest = archive_dir.join(entry.file_name());
                            let _ = std::fs::rename(&path, &dest);
                            archived += 1;
                        }
                    }
                }
            }
        }
    }
    if archived > 0 {
        info!(count = archived, "stale-thread-detector: archived stale threads");
    }
    Ok(())
}

/// Run synaptic homeostasis: tiered decay + pruning of weak memories.
/// - Tier 1: 1.5%/day decay for unconsolidated memories > 7 days old
/// - Tier 2: 5%/day accelerated decay for poorly-linked insights
/// - Tier 3: 0.5%/day protected decay for well-linked insights
/// - Prune: DELETE memories with importance <= 0.05 after 60 days
pub async fn run_memory_forgetting(vault_path: &Path, db: &hq_db::Database) -> Result<()> {
    if !has_run_today(vault_path, "memory-forgetting") {
        // Ensure memory tables exist
        if let Err(e) = hq_memory::open_memory_tables(db) {
            tracing::warn!(error = %e, "memory-forgetting: failed to init tables");
            return Ok(());
        }

        let forgetter = hq_memory::MemoryForgetter::new(db.clone(), vault_path.to_path_buf());
        match forgetter.run_cycle() {
            Ok(result) => {
                if result.decayed > 0 || result.pruned > 0 {
                    info!(
                        decayed = result.decayed,
                        pruned = result.pruned,
                        total = result.stats_after.total,
                        "memory-forgetting: synaptic homeostasis complete"
                    );
                } else {
                    tracing::debug!("memory-forgetting: nothing to decay or prune");
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "memory-forgetting: cycle failed");
            }
        }
        mark_run_today(vault_path, "memory-forgetting");
    }
    Ok(())
}

/// Extract knowledge from completed plans.
pub async fn run_plan_extraction(vault_path: &Path) -> Result<()> {
    let completed_dir = vault_path.join("_plans").join("completed");
    if !completed_dir.exists() {
        return Ok(());
    }

    let knowledge_dir = vault_path.join("_plans").join("knowledge");
    ensure_dir(&knowledge_dir);

    if let Ok(entries) = std::fs::read_dir(&completed_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "md") {
                let flag = knowledge_dir.join(format!(
                    ".extracted-{}",
                    entry.file_name().to_string_lossy()
                ));
                if !flag.exists() {
                    tracing::debug!(
                        plan = ?entry.file_name(),
                        "plan-extraction: would extract knowledge"
                    );
                    let _ = std::fs::write(&flag, "extracted");
                }
            }
        }
    }
    Ok(())
}

/// Daily vault cleanup — prune backups, reconcile stale jobs, detect stubs.
pub async fn run_vault_cleanup(vault_path: &Path) -> Result<()> {
    if !has_run_today(vault_path, "vault-cleanup") {
        let mut actions = Vec::new();

        // 1. Reconcile stale running jobs (>3 days → failed)
        let running_dir = vault_path.join("_jobs").join("running");
        let failed_dir = vault_path.join("_jobs").join("failed");
        if running_dir.exists() {
            ensure_dir(&failed_dir);
            let cutoff =
                std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 86400);
            if let Ok(entries) = std::fs::read_dir(&running_dir) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if let Ok(modified) = meta.modified() {
                            if modified < cutoff {
                                let dest = failed_dir.join(entry.file_name());
                                let _ = std::fs::rename(entry.path(), &dest);
                                actions.push(format!(
                                    "Moved stale job to failed: {}",
                                    entry.file_name().to_string_lossy()
                                ));
                            }
                        }
                    }
                }
            }
        }

        // 2. Prune old touchpoint backups (keep last 50)
        let backups_dir = vault_path.join("_system").join(".touchpoint-backups");
        if backups_dir.exists() {
            if let Ok(mut entries) = std::fs::read_dir(&backups_dir)
                .map(|e| e.flatten().collect::<Vec<_>>())
            {
                if entries.len() > 50 {
                    entries.sort_by_key(|e| {
                        e.metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .unwrap_or(std::time::UNIX_EPOCH)
                    });
                    let to_remove = entries.len() - 50;
                    for entry in entries.iter().take(to_remove) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                    if to_remove > 0 {
                        actions.push(format!("Pruned {to_remove} old touchpoint backups"));
                    }
                }
            }
        }

        // 3. Detect empty stubs (< 100 bytes, > 7 days old)
        let notebooks_dir = vault_path.join("Notebooks");
        let cutoff_stubs =
            std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 86400);
        let mut stubs = Vec::new();
        if notebooks_dir.exists() {
            find_stubs(&notebooks_dir, cutoff_stubs, &mut stubs, 50);
        }
        if !stubs.is_empty() {
            actions.push(format!("Found {} empty stub files (< 100 bytes, > 7 days old)", stubs.len()));
        }

        // Write cleanup report
        if !actions.is_empty() {
            let now = chrono::Utc::now().to_rfc3339();
            let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
            let sys_dir = vault_path.join("_system");
            let report = format!(
                "---\ndate: {today}\ngenerated_at: {now}\nactions: {}\n---\n\n\
                 # Vault Cleanup Report — {today}\n\n{}\n{}\n",
                actions.len(),
                actions
                    .iter()
                    .map(|a| format!("- {a}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                if stubs.is_empty() {
                    String::new()
                } else {
                    format!(
                        "\n## Stub Files (candidates for deletion)\n\n{}\n",
                        stubs
                            .iter()
                            .take(20)
                            .map(|p| format!("- `{}`", p.strip_prefix(vault_path).unwrap_or(p).display()))
                            .collect::<Vec<_>>()
                            .join("\n")
                    )
                }
            );
            std::fs::write(sys_dir.join("cleanup-suggestions.md"), report)?;
            info!(
                actions = actions.len(),
                stubs = stubs.len(),
                "vault-cleanup: completed"
            );
        }

        mark_run_today(vault_path, "vault-cleanup");
    }
    Ok(())
}

fn find_stubs(dir: &Path, cutoff: std::time::SystemTime, stubs: &mut Vec<std::path::PathBuf>, limit: usize) {
    if stubs.len() >= limit {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if stubs.len() >= limit {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                find_stubs(&path, cutoff, stubs, limit);
            } else if path.extension().is_some_and(|e| e == "md") {
                if let Ok(meta) = entry.metadata() {
                    let size = meta.len();
                    if size < 100 {
                        if let Ok(modified) = meta.modified() {
                            if modified < cutoff {
                                stubs.push(path);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Daily frontmatter audit — backfill tags on old notes using keyword matching.
/// Processes up to 20 notes per cycle (gradual improvement, not disruptive).
pub async fn run_frontmatter_audit(vault_path: &Path) -> Result<()> {
    if !has_run_today(vault_path, "frontmatter-audit") {
        let notebooks_dir = vault_path.join("Notebooks");
        if !notebooks_dir.exists() {
            mark_run_today(vault_path, "frontmatter-audit");
            return Ok(());
        }

        let mut untagged = Vec::new();
        find_untagged_notes(&notebooks_dir, &mut untagged, 20);

        if untagged.is_empty() {
            mark_run_today(vault_path, "frontmatter-audit");
            return Ok(());
        }

        // Reuse the same keyword→tag mapping from the tag-suggester touchpoint
        use crate::commands::start::touchpoints::tag_suggester::{PROJECT_TAGS, TOPIC_TAGS};

        let mut tagged = 0u32;
        for path in &untagged {
            if let Ok(content) = std::fs::read_to_string(path) {
                let content_lower = content.to_lowercase();
                let mut suggested: Vec<&str> = Vec::new();
                for (keyword, tag) in PROJECT_TAGS.iter().chain(TOPIC_TAGS.iter()) {
                    if content_lower.contains(keyword) && !suggested.contains(tag) {
                        suggested.push(tag);
                    }
                }
                if suggested.is_empty() {
                    continue;
                }
                suggested.truncate(5);

                // Update frontmatter
                let trimmed = content.trim();
                if trimmed.starts_with("---") {
                    if let Some(end_idx) = trimmed[3..].find("\n---") {
                        let frontmatter = &trimmed[3..3 + end_idx];
                        let body = &trimmed[3 + end_idx + 4..];
                        let tag_yaml = format!(
                            "tags:\n{}",
                            suggested
                                .iter()
                                .map(|t| format!("  - {t}"))
                                .collect::<Vec<_>>()
                                .join("\n")
                        );
                        // Replace empty tags or add
                        let new_fm = if frontmatter.contains("tags: []") {
                            frontmatter.replace("tags: []", &tag_yaml)
                        } else if !frontmatter.contains("tags:") {
                            format!("{frontmatter}\n{tag_yaml}")
                        } else {
                            continue; // Already has tags
                        };
                        let new_content = format!("---{new_fm}\n---{body}");
                        if std::fs::write(path, new_content).is_ok() {
                            tagged += 1;
                        }
                    }
                }
            }
        }

        if tagged > 0 {
            info!(
                tagged,
                total_untagged = untagged.len(),
                "frontmatter-audit: backfilled tags"
            );
        }

        mark_run_today(vault_path, "frontmatter-audit");
    }
    Ok(())
}

fn find_untagged_notes(dir: &Path, results: &mut Vec<std::path::PathBuf>, limit: usize) {
    if results.len() >= limit {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if results.len() >= limit {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                find_untagged_notes(&path, results, limit);
            } else if path.extension().is_some_and(|e| e == "md") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let trimmed = content.trim();
                    if trimmed.starts_with("---") {
                        if let Some(end_idx) = trimmed[3..].find("\n---") {
                            let fm = &trimmed[3..3 + end_idx];
                            if fm.contains("tags: []") || !fm.contains("tags:") {
                                results.push(path);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Archive completed plans older than 30 days.
pub async fn run_plan_archival(vault_path: &Path) -> Result<()> {
    let completed_dir = vault_path.join("_plans").join("completed");
    if !completed_dir.exists() {
        return Ok(());
    }

    let archive_dir = vault_path.join("_plans").join("archive");
    ensure_dir(&archive_dir);
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86400);

    if let Ok(entries) = std::fs::read_dir(&completed_dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    if modified < cutoff {
                        let dest = archive_dir.join(entry.file_name());
                        let _ = std::fs::rename(entry.path(), &dest);
                        info!(
                            plan = ?entry.file_name(),
                            "plan-archival: archived old completed plan"
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

//! Stale thread detector — reactive check on thread modification for staleness.

use anyhow::Result;
use hq_sync::{ChangeType, FileChange};
use std::path::PathBuf;

use super::{TouchPoint, TouchPointContext};

pub struct StaleThreadDetector;

#[async_trait::async_trait]
impl TouchPoint for StaleThreadDetector {
    fn name(&self) -> &str {
        "stale-thread-detector"
    }

    fn matches(&self, change: &FileChange) -> bool {
        matches!(change.change_type, ChangeType::Modified)
            && change.path.extension().is_some_and(|e| e == "md")
            && change.path.to_string_lossy().contains("_threads/")
            && !change.path.to_string_lossy().contains("_archive/")
    }

    async fn execute(&self, change: &FileChange, ctx: &TouchPointContext) -> Result<Vec<PathBuf>> {
        let content = std::fs::read_to_string(&change.path)?;

        // Parse urgency from frontmatter
        let urgency = extract_urgency(&content);
        let stale_threshold_days = match urgency.as_deref() {
            Some("high") | Some("urgent") => 1,
            Some("medium") | Some("normal") => 3,
            Some("low") => 7,
            _ => 5, // default
        };

        // Check last modification time
        let meta = std::fs::metadata(&change.path)?;
        let modified = meta.modified()?;
        let age = std::time::SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default();
        let age_days = age.as_secs() / 86400;

        if age_days < stale_threshold_days {
            return Ok(vec![]);
        }

        let thread_name = change
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");

        tracing::warn!(
            thread = thread_name,
            age_days,
            threshold = stale_threshold_days,
            urgency = urgency.as_deref().unwrap_or("default"),
            "stale-thread-detector: thread is stale"
        );

        // For very stale threads (3x threshold), auto-archive
        if age_days >= stale_threshold_days * 3 {
            let archive_dir = ctx.vault_path.join("_threads").join("_archive");
            super::super::daemon::helpers::ensure_dir(&archive_dir);
            let dest = archive_dir.join(
                change
                    .path
                    .file_name()
                    .unwrap_or_default(),
            );
            let _ = std::fs::rename(&change.path, &dest);
            tracing::info!(
                thread = thread_name,
                "stale-thread-detector: auto-archived very stale thread"
            );
        }

        Ok(vec![])
    }
}

fn extract_urgency(content: &str) -> Option<String> {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return None;
    }
    let end_idx = trimmed[3..].find("\n---")?;
    let frontmatter = &trimmed[3..3 + end_idx];

    for line in frontmatter.lines() {
        let line = line.trim();
        if line.starts_with("urgency:") {
            return Some(
                line["urgency:".len()..]
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string(),
            );
        }
    }
    None
}

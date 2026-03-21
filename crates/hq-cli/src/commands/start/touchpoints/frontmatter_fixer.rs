//! Frontmatter fixer — ensures all .md notes have valid YAML frontmatter.

use anyhow::Result;
use hq_sync::{ChangeType, FileChange};
use std::path::PathBuf;

use super::{TouchPoint, TouchPointContext};

pub struct FrontmatterFixer;

#[async_trait::async_trait]
impl TouchPoint for FrontmatterFixer {
    fn name(&self) -> &str {
        "frontmatter-fixer"
    }

    fn matches(&self, change: &FileChange) -> bool {
        matches!(change.change_type, ChangeType::Created | ChangeType::Modified)
            && change.path.extension().is_some_and(|e| e == "md")
            && !is_system_file(&change.path)
    }

    async fn execute(&self, change: &FileChange, ctx: &TouchPointContext) -> Result<Vec<PathBuf>> {
        let content = std::fs::read_to_string(&change.path)?;
        let trimmed = content.trim();

        let needs_fix = if trimmed.starts_with("---") {
            // Has frontmatter start — check for closing ---
            trimmed[3..].find("\n---").is_none()
        } else {
            // No frontmatter at all
            true
        };

        if !needs_fix {
            // Check if required fields are present
            if let Some(fm_end) = trimmed[3..].find("\n---") {
                let frontmatter = &trimmed[3..3 + fm_end];
                let missing_fields = check_missing_fields(frontmatter);
                if missing_fields.is_empty() {
                    return Ok(vec![]);
                }
                // Add missing fields
                let additions = missing_fields.join("\n");
                let new_content = format!(
                    "---{}\n{}\n---{}",
                    frontmatter,
                    additions,
                    &trimmed[3 + fm_end + 4..]
                );
                std::fs::write(&change.path, new_content)?;
                return Ok(vec![change.path.clone()]);
            }
            return Ok(vec![]);
        }

        // Build frontmatter
        let now = chrono::Utc::now().to_rfc3339();
        let note_type = guess_note_type(&change.path, ctx);

        let new_content = if trimmed.starts_with("---") {
            // Broken frontmatter (no closing) — add closing
            let fm_content = &trimmed[3..];
            format!("---\n{fm_content}\n---\n")
        } else {
            // No frontmatter at all — add complete frontmatter
            format!(
                "---\nnoteType: {note_type}\ntags: []\ncreatedAt: '{now}'\nembeddingStatus: pending\n---\n\n{content}"
            )
        };

        std::fs::write(&change.path, new_content)?;
        Ok(vec![change.path.clone()])
    }

    fn chains_to(&self) -> Option<&str> {
        Some("tag-suggester")
    }
}

fn is_system_file(path: &std::path::Path) -> bool {
    let path_str = path.to_string_lossy();
    path_str.contains("/_system/")
        || path_str.contains("/_jobs/")
        || path_str.contains("/_threads/_archive/")
        || path_str.contains("/_plans/archive/")
        || path_str.contains("/_data/")
        || path_str.contains("DAEMON-STATUS")
        || path_str.contains("HEARTBEAT")
        || path_str.contains("CRON-SCHEDULE")
}

fn check_missing_fields(frontmatter: &str) -> Vec<String> {
    let mut missing = Vec::new();
    if !frontmatter.contains("noteType:") {
        missing.push("noteType: note".to_string());
    }
    if !frontmatter.contains("createdAt:") {
        let now = chrono::Utc::now().to_rfc3339();
        missing.push(format!("createdAt: '{now}'"));
    }
    if !frontmatter.contains("embeddingStatus:") {
        missing.push("embeddingStatus: pending".to_string());
    }
    missing
}

fn guess_note_type(path: &std::path::Path, _ctx: &TouchPointContext) -> &'static str {
    let path_str = path.to_string_lossy();
    if path_str.contains("Daily Digest") || path_str.contains("Brief-") {
        "note"
    } else if path_str.contains("Retros/") {
        "retro"
    } else if path_str.contains("Claude Plans/") {
        "plan"
    } else if path_str.contains("_threads/") {
        "thread"
    } else {
        "note"
    }
}

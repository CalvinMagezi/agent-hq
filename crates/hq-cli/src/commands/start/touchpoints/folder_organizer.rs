//! Folder organizer — suggests moving misplaced files based on frontmatter metadata.

use anyhow::Result;
use hq_sync::{ChangeType, FileChange};
use std::path::PathBuf;

use super::{TouchPoint, TouchPointContext};

pub struct FolderOrganizer;

#[async_trait::async_trait]
impl TouchPoint for FolderOrganizer {
    fn name(&self) -> &str {
        "folder-organizer"
    }

    fn matches(&self, change: &FileChange) -> bool {
        matches!(change.change_type, ChangeType::Created)
            && change.path.extension().is_some_and(|e| e == "md")
            && change.path.to_string_lossy().contains("Notebooks/Inbox/")
    }

    async fn execute(&self, change: &FileChange, ctx: &TouchPointContext) -> Result<Vec<PathBuf>> {
        let content = std::fs::read_to_string(&change.path)?;
        let trimmed = content.trim();

        // Extract project from frontmatter
        if !trimmed.starts_with("---") {
            return Ok(vec![]);
        }
        let Some(end_idx) = trimmed[3..].find("\n---") else {
            return Ok(vec![]);
        };
        let frontmatter = &trimmed[3..3 + end_idx];

        // Look for project: field
        let project = frontmatter
            .lines()
            .find(|l| l.trim().starts_with("project:"))
            .map(|l| l.trim()["project:".len()..].trim().to_string());

        let Some(project) = project else {
            return Ok(vec![]);
        };

        if project.is_empty() {
            return Ok(vec![]);
        }

        // Sanitize project name — no path traversal
        let safe_project: String = project
            .chars()
            .map(|c| if c == '/' || c == '\\' || c == '.' { '_' } else { c })
            .collect();

        // Suggest moving to Notebooks/Projects/{project}/
        let target_dir = ctx
            .vault_path
            .join("Notebooks")
            .join("Projects")
            .join(&safe_project);
        let target_path = target_dir.join(
            change
                .path
                .file_name()
                .unwrap_or_default(),
        );

        // Write suggestion (don't auto-move — let user confirm)
        let suggestions_dir = ctx.vault_path.join("_system").join("organize-suggestions");
        super::super::daemon::helpers::ensure_dir(&suggestions_dir);

        let now = chrono::Utc::now().to_rfc3339();
        let rel_from = change
            .path
            .strip_prefix(&ctx.vault_path)
            .unwrap_or(&change.path);
        let rel_to = target_path
            .strip_prefix(&ctx.vault_path)
            .unwrap_or(&target_path);

        let suggestion = format!(
            "---\ndate: {now}\nstatus: pending\n---\n\n\
             # Move Suggestion\n\n\
             **From**: {}\n**To**: {}\n**Project**: {project}\n",
            rel_from.display(),
            rel_to.display()
        );

        let suggestion_file = suggestions_dir.join(format!(
            "move-{}.md",
            change
                .path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
        ));
        std::fs::write(&suggestion_file, suggestion)?;

        tracing::info!(
            from = %rel_from.display(),
            to = %rel_to.display(),
            "folder-organizer: suggested move"
        );

        Ok(vec![])
    }
}

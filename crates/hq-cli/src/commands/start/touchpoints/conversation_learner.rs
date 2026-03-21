//! Conversation learner — extracts key decisions and insights from completed threads.

use anyhow::Result;
use hq_sync::{ChangeType, FileChange};
use std::path::PathBuf;

use super::{TouchPoint, TouchPointContext};

pub struct ConversationLearner;

#[async_trait::async_trait]
impl TouchPoint for ConversationLearner {
    fn name(&self) -> &str {
        "conversation-learner"
    }

    fn matches(&self, change: &FileChange) -> bool {
        matches!(change.change_type, ChangeType::Modified)
            && change.path.extension().is_some_and(|e| e == "md")
            && change.path.to_string_lossy().contains("_threads/")
            && !change.path.to_string_lossy().contains("_archive/")
    }

    async fn execute(&self, change: &FileChange, ctx: &TouchPointContext) -> Result<Vec<PathBuf>> {
        let content = std::fs::read_to_string(&change.path)?;

        // Only process threads marked as done
        if !is_thread_complete(&content) {
            return Ok(vec![]);
        }

        // Extract learnings from the thread content
        let learnings = extract_learnings(&content);
        if learnings.is_empty() {
            return Ok(vec![]);
        }

        // Write learnings file
        let learnings_dir = ctx.vault_path.join("_system").join("learnings");
        super::super::daemon::helpers::ensure_dir(&learnings_dir);

        let thread_name = change
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");
        let now = chrono::Utc::now().to_rfc3339();
        let learning_content = format!(
            "---\nsource: {thread_name}\nextracted_at: {now}\ntype: thread-learning\n---\n\n\
             # Learnings from {thread_name}\n\n{}\n",
            learnings
                .iter()
                .map(|l| format!("- {l}"))
                .collect::<Vec<_>>()
                .join("\n")
        );

        let learning_file = learnings_dir.join(format!("learning-{thread_name}.md"));
        std::fs::write(&learning_file, learning_content)?;

        tracing::info!(
            thread = thread_name,
            count = learnings.len(),
            "conversation-learner: extracted learnings"
        );

        Ok(vec![learning_file])
    }
}

fn is_thread_complete(content: &str) -> bool {
    let lower = content.to_lowercase();
    lower.contains("status: done")
        || lower.contains("status: completed")
        || lower.contains("status: resolved")
}

fn extract_learnings(content: &str) -> Vec<String> {
    let mut learnings = Vec::new();

    // Look for decision markers
    for line in content.lines() {
        let trimmed = line.trim();
        // Explicit decision markers
        if trimmed.starts_with("**Decision**:")
            || trimmed.starts_with("Decision:")
            || trimmed.starts_with("DECISION:")
        {
            let text = trimmed
                .trim_start_matches("**Decision**:")
                .trim_start_matches("Decision:")
                .trim_start_matches("DECISION:")
                .trim();
            if !text.is_empty() {
                learnings.push(format!("[Decision] {text}"));
            }
        }
        // Action items
        if trimmed.starts_with("- [x]") {
            let text = trimmed.trim_start_matches("- [x]").trim();
            if text.len() > 10 {
                learnings.push(format!("[Completed] {text}"));
            }
        }
        // Key takeaways
        if trimmed.starts_with("**Takeaway**:")
            || trimmed.starts_with("Takeaway:")
            || trimmed.starts_with("**Lesson**:")
        {
            let text = trimmed
                .split(':')
                .skip(1)
                .collect::<Vec<_>>()
                .join(":")
                .trim()
                .to_string();
            if !text.is_empty() {
                learnings.push(format!("[Takeaway] {text}"));
            }
        }
    }

    // Cap at 10 learnings per thread
    learnings.truncate(10);
    learnings
}

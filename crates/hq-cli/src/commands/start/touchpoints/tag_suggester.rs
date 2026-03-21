//! Tag suggester — proposes tags for notes based on content heuristics.
//!
//! Uses keyword matching first (fast, no LLM needed). Queues suggestions
//! for notes that would benefit from LLM-based tagging.

use anyhow::Result;
use hq_sync::{ChangeType, FileChange};
use std::path::PathBuf;

use super::{TouchPoint, TouchPointContext};

pub struct TagSuggester;

/// Project keywords mapped to tags.
pub const PROJECT_TAGS: &[(&str, &str)] = &[
    ("kolaborate", "kolaborate"),
    ("seedsix", "seedsix"),
    ("chamuka", "chamuka"),
    ("siteseer", "siteseer"),
    ("agent-hq", "agent-hq"),
    ("ymf", "ymf"),
    ("islas", "islas"),
    ("quickset", "quickset"),
    ("sentryai", "sentryai"),
];

/// Topic keywords mapped to tags.
pub const TOPIC_TAGS: &[(&str, &str)] = &[
    ("kubernetes", "devops"),
    ("docker", "devops"),
    ("deploy", "devops"),
    ("typescript", "typescript"),
    ("react", "frontend"),
    ("nextjs", "frontend"),
    ("rust", "rust"),
    ("cargo", "rust"),
    ("python", "python"),
    ("api", "api"),
    ("database", "database"),
    ("sqlite", "database"),
    ("postgres", "database"),
    ("security", "security"),
    ("vulnerability", "security"),
    ("ai", "ai"),
    ("llm", "ai"),
    ("model", "ai"),
    ("openai", "ai"),
    ("claude", "ai"),
    ("telegram", "messaging"),
    ("discord", "messaging"),
    ("whatsapp", "messaging"),
    ("budget", "finance"),
    ("revenue", "finance"),
    ("invoice", "finance"),
];

#[async_trait::async_trait]
impl TouchPoint for TagSuggester {
    fn name(&self) -> &str {
        "tag-suggester"
    }

    fn matches(&self, change: &FileChange) -> bool {
        matches!(change.change_type, ChangeType::Created | ChangeType::Modified)
            && change.path.extension().is_some_and(|e| e == "md")
            && change
                .path
                .to_string_lossy()
                .contains("Notebooks/")
    }

    async fn execute(&self, change: &FileChange, ctx: &TouchPointContext) -> Result<Vec<PathBuf>> {
        let content = std::fs::read_to_string(&change.path)?;

        // Check if tags already exist
        if has_tags(&content) {
            return Ok(vec![]);
        }

        // Extract suggested tags from content
        let content_lower = content.to_lowercase();
        let mut suggested: Vec<&str> = Vec::new();

        for (keyword, tag) in PROJECT_TAGS.iter().chain(TOPIC_TAGS.iter()) {
            if content_lower.contains(keyword) && !suggested.contains(tag) {
                suggested.push(tag);
            }
        }

        if suggested.is_empty() {
            return Ok(vec![]);
        }

        // Cap at 5 tags
        suggested.truncate(5);

        // Update frontmatter with suggested tags
        let trimmed = content.trim();
        if trimmed.starts_with("---") {
            if let Some(end_idx) = trimmed[3..].find("\n---") {
                let frontmatter = &trimmed[3..3 + end_idx];
                let body = &trimmed[3 + end_idx + 4..];

                // Replace empty tags or add tags field
                let tag_yaml = format!(
                    "tags:\n{}",
                    suggested
                        .iter()
                        .map(|t| format!("  - {t}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                );

                let new_fm = if frontmatter.contains("tags: []")
                    || frontmatter.contains("tags:\n")
                {
                    // Replace existing empty tags
                    let mut result = String::new();
                    let mut skip_tag_items = false;
                    for line in frontmatter.lines() {
                        if line.trim().starts_with("tags:") {
                            result.push_str(&tag_yaml);
                            result.push('\n');
                            skip_tag_items = line.trim() == "tags:";
                            if !skip_tag_items {
                                // tags: [] on same line, done
                            }
                            continue;
                        }
                        if skip_tag_items && line.trim().starts_with("- ") {
                            continue; // skip existing tag items
                        }
                        skip_tag_items = false;
                        result.push_str(line);
                        result.push('\n');
                    }
                    result
                } else {
                    // Add tags field
                    format!("{frontmatter}\n{tag_yaml}\n")
                };

                let new_content = format!("---{new_fm}---{body}");
                std::fs::write(&change.path, new_content)?;
                return Ok(vec![change.path.clone()]);
            }
        }

        Ok(vec![])
    }
}

fn has_tags(content: &str) -> bool {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return false;
    }
    if let Some(end_idx) = trimmed[3..].find("\n---") {
        let frontmatter = &trimmed[3..3 + end_idx];
        // Has non-empty tags
        if frontmatter.contains("tags:") && !frontmatter.contains("tags: []") {
            // Check if there are actual tag items
            let in_tags = frontmatter.lines().any(|l| {
                let t = l.trim();
                t.starts_with("- ") && frontmatter.contains("tags:")
            });
            return in_tags;
        }
    }
    false
}

//! Size watchdog — alerts when vault files exceed size thresholds.

use anyhow::Result;
use hq_sync::{ChangeType, FileChange};
use std::path::PathBuf;

use super::{TouchPoint, TouchPointContext};

/// Warning threshold (10 KB).
const WARN_THRESHOLD: u64 = 10 * 1024;
/// Alert threshold (25 KB).
const ALERT_THRESHOLD: u64 = 25 * 1024;
/// Critical threshold (50 KB).
const CRITICAL_THRESHOLD: u64 = 50 * 1024;

pub struct SizeWatchdog;

#[async_trait::async_trait]
impl TouchPoint for SizeWatchdog {
    fn name(&self) -> &str {
        "size-watchdog"
    }

    fn matches(&self, change: &FileChange) -> bool {
        matches!(change.change_type, ChangeType::Created | ChangeType::Modified)
            && change.size > WARN_THRESHOLD
            && change.path.extension().is_some_and(|e| e == "md")
    }

    async fn execute(&self, change: &FileChange, ctx: &TouchPointContext) -> Result<Vec<PathBuf>> {
        let size_kb = change.size as f64 / 1024.0;
        let level = if change.size >= CRITICAL_THRESHOLD {
            "CRITICAL"
        } else if change.size >= ALERT_THRESHOLD {
            "ALERT"
        } else {
            "WARNING"
        };

        let rel_path = change
            .path
            .strip_prefix(&ctx.vault_path)
            .unwrap_or(&change.path);

        tracing::warn!(
            level,
            size_kb = format!("{size_kb:.1}"),
            path = %rel_path.display(),
            "size-watchdog: file exceeds threshold"
        );

        // For critical files, write an alert note
        if change.size >= CRITICAL_THRESHOLD {
            let alerts_dir = ctx.vault_path.join("_system").join("alerts");
            super::super::daemon::helpers::ensure_dir(&alerts_dir);
            let now = chrono::Utc::now();
            let alert_file = alerts_dir.join(format!(
                "large-file-{}.md",
                now.format("%Y-%m-%d-%H%M%S")
            ));
            let content = format!(
                "---\ntype: alert\nseverity: {level}\ndate: {}\n---\n\n\
                 # Large File Alert\n\n\
                 **File**: {}\n\
                 **Size**: {size_kb:.1} KB\n\
                 **Severity**: {level}\n\n\
                 Consider splitting this file or archiving old content.\n",
                now.to_rfc3339(),
                rel_path.display()
            );
            let _ = std::fs::write(&alert_file, content);
        }

        Ok(vec![])
    }
}

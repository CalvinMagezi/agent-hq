//! Stale job cleanup — move stuck running jobs to failed, delete old done jobs.

use anyhow::Result;
use hq_vault::VaultClient;
use std::time::Duration;
use tracing::{debug, info, warn};

/// Clean up stale jobs that have been in `running/` for longer than `max_age`.
/// Moves them to `failed/` with an error message.
///
/// Returns the number of jobs cleaned up.
pub fn cleanup_stale_jobs(vault: &VaultClient, max_age: Duration) -> Result<usize> {
    let running_dir = vault.vault_path().join("_jobs").join("running");
    if !running_dir.exists() {
        return Ok(0);
    }

    let failed_dir = vault.vault_path().join("_jobs").join("failed");
    std::fs::create_dir_all(&failed_dir)?;

    let mut cleaned = 0;

    for entry in std::fs::read_dir(&running_dir)? {
        let entry = entry?;
        let path = entry.path();

        if !path.extension().is_some_and(|ext| ext == "md") {
            continue;
        }

        let metadata = std::fs::metadata(&path)?;
        let modified = metadata.modified()?;
        let age = modified.elapsed().unwrap_or_default();

        if age > max_age {
            let job_id = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // Read original content and append failure info
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let updated = append_failure_info(
                &content,
                &format!(
                    "Stale job cleanup: running for {} minutes without completion",
                    age.as_secs() / 60
                ),
            );

            let dest = failed_dir.join(path.file_name().unwrap_or_default());
            std::fs::write(&dest, updated)?;
            std::fs::remove_file(&path)?;

            warn!(job_id = %job_id, age_mins = age.as_secs() / 60, "moved stale job to failed");
            cleaned += 1;
        }
    }

    if cleaned > 0 {
        info!(count = cleaned, "cleaned up stale running jobs");
    }

    Ok(cleaned)
}

/// Clean up old done jobs that are older than `max_age`.
/// Deletes the job files entirely.
///
/// Returns the number of jobs deleted.
pub fn cleanup_done_jobs(vault: &VaultClient, max_age: Duration) -> Result<usize> {
    let done_dir = vault.vault_path().join("_jobs").join("done");
    if !done_dir.exists() {
        return Ok(0);
    }

    let mut deleted = 0;

    for entry in std::fs::read_dir(&done_dir)? {
        let entry = entry?;
        let path = entry.path();

        if !path.extension().is_some_and(|ext| ext == "md") {
            continue;
        }

        let metadata = std::fs::metadata(&path)?;
        let modified = metadata.modified()?;
        let age = modified.elapsed().unwrap_or_default();

        if age > max_age {
            let job_id = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            std::fs::remove_file(&path)?;
            debug!(job_id = %job_id, age_days = age.as_secs() / 86400, "deleted old done job");
            deleted += 1;
        }
    }

    if deleted > 0 {
        info!(count = deleted, "cleaned up old done jobs");
    }

    Ok(deleted)
}

/// Append failure metadata to a job's markdown content.
fn append_failure_info(content: &str, error_msg: &str) -> String {
    // If there's frontmatter, inject status/error into it
    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("---") {
            let fm_end = end_idx + 3;
            let before_close = &content[..fm_end];
            let after = &content[fm_end..];
            return format!(
                "{}status: failed\nerror: \"{}\"\ncompleted_at: \"{}\"\n{}",
                before_close,
                error_msg,
                chrono::Utc::now().to_rfc3339(),
                after
            );
        }
    }

    // Fallback: just append to end
    format!(
        "{}\n\n---\n**Failed**: {} ({})\n",
        content,
        error_msg,
        chrono::Utc::now().to_rfc3339()
    )
}

//! Health checks — detect stuck jobs and offline workers.

use anyhow::Result;
use chrono::Utc;
use hq_vault::VaultClient;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing::{info, warn};

/// Maximum time a job can run without a heartbeat before considered stuck.
const STUCK_JOB_THRESHOLD: Duration = Duration::from_secs(30 * 60); // 30 minutes
/// Maximum time since last worker heartbeat before considered offline.
const OFFLINE_WORKER_THRESHOLD: Duration = Duration::from_secs(5 * 60); // 5 minutes

/// Health check report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthReport {
    /// Jobs that appear stuck (running too long without heartbeat).
    pub stuck_jobs: Vec<StuckJob>,
    /// Workers that appear offline (no recent heartbeat).
    pub offline_workers: Vec<OfflineWorker>,
    /// Whether the system is healthy overall.
    pub healthy: bool,
    /// Timestamp of the health check.
    pub checked_at: String,
}

/// A job that appears stuck.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StuckJob {
    pub job_id: String,
    pub running_since: String,
    pub agent: Option<String>,
}

/// A worker that appears offline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineWorker {
    pub worker_id: String,
    pub last_heartbeat: String,
}

/// Run health checks against the vault and database.
///
/// Checks for:
/// - Jobs in `running/` older than 30 minutes (stuck)
/// - Worker heartbeat files older than 5 minutes (offline)
pub fn check_health(vault: &VaultClient) -> Result<HealthReport> {
    let mut stuck_jobs = Vec::new();
    let mut offline_workers = Vec::new();

    // Check for stuck jobs in running/
    let jobs_dir = vault.vault_path().join("_jobs").join("running");
    if jobs_dir.exists() {
        for entry in std::fs::read_dir(&jobs_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "md") {
                let metadata = std::fs::metadata(&path)?;
                let modified = metadata.modified()?;
                let age = modified.elapsed().unwrap_or_default();

                if age > STUCK_JOB_THRESHOLD {
                    let job_id = path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();

                    // Try to read agent name from the file
                    let agent = std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|content| {
                            content
                                .lines()
                                .find(|line| line.starts_with("agent:"))
                                .map(|line| line.trim_start_matches("agent:").trim().to_string())
                        });

                    warn!(job_id = %job_id, age_mins = age.as_secs() / 60, "stuck job detected");
                    stuck_jobs.push(StuckJob {
                        job_id,
                        running_since: format!("{} minutes ago", age.as_secs() / 60),
                        agent,
                    });
                }
            }
        }
    }

    // Check for offline workers via heartbeat files
    let workers_dir = vault.vault_path().join("_workers");
    if workers_dir.exists() {
        for entry in std::fs::read_dir(&workers_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "md") {
                let metadata = std::fs::metadata(&path)?;
                let modified = metadata.modified()?;
                let age = modified.elapsed().unwrap_or_default();

                if age > OFFLINE_WORKER_THRESHOLD {
                    let worker_id = path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();

                    warn!(worker_id = %worker_id, age_mins = age.as_secs() / 60, "offline worker detected");
                    offline_workers.push(OfflineWorker {
                        worker_id,
                        last_heartbeat: format!("{} minutes ago", age.as_secs() / 60),
                    });
                }
            }
        }
    }

    let healthy = stuck_jobs.is_empty() && offline_workers.is_empty();
    let report = HealthReport {
        stuck_jobs,
        offline_workers,
        healthy,
        checked_at: Utc::now().to_rfc3339(),
    };

    if healthy {
        info!("health check passed");
    } else {
        warn!(
            stuck = report.stuck_jobs.len(),
            offline = report.offline_workers.len(),
            "health check found issues"
        );
    }

    Ok(report)
}

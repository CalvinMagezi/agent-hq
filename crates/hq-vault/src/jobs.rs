use anyhow::{Context, Result};
use chrono::Utc;
use hq_core::types::{Job, JobCounts, JobStatus};
use std::path::Path;
use tracing::debug;
use uuid::Uuid;

use crate::frontmatter;

const JOBS_DIR: &str = "_jobs";

/// Create a new job in the pending queue.
pub fn create_job(vault_path: &Path, instruction: &str, model_str: Option<&str>) -> Result<Job> {
    let jid = Uuid::new_v4().to_string();
    let now = Utc::now();

    let job = Job {
        id: jid.clone(),
        r#type: hq_core::types::JobType::Background,
        status: JobStatus::Pending,
        priority: 0,
        security_profile: Default::default(),
        model: model_str.map(|s| s.to_string()),
        thinking_level: None,
        agent: None,
        thread_id: None,
        instruction: instruction.to_string(),
        result: None,
        streaming_text: None,
        conversation_history: Vec::new(),
        steering_message: None,
        stats: None,
        created_at: now.to_rfc3339(),
        updated_at: None,
        trace_id: None,
        span_id: None,
        file_path: None,
    };

    let dir = vault_path.join(JOBS_DIR).join("pending");
    std::fs::create_dir_all(&dir)?;

    let filename = format!("{}.md", jid);
    let content = job_to_markdown(&job);
    std::fs::write(dir.join(&filename), content)?;

    debug!(job_id = %jid, "created pending job");
    Ok(job)
}

/// Claim a pending job by atomically renaming it to running/.
/// Returns None if the job was already claimed (ENOENT on rename).
pub fn claim_job(vault_path: &Path, jid: &str, agent_name: &str) -> Result<Option<Job>> {
    let pending_path = vault_path
        .join(JOBS_DIR)
        .join("pending")
        .join(format!("{}.md", jid));
    let running_dir = vault_path.join(JOBS_DIR).join("running");
    std::fs::create_dir_all(&running_dir)?;
    let running_path = running_dir.join(format!("{}.md", jid));

    match std::fs::rename(&pending_path, &running_path) {
        Ok(()) => {
            let raw = std::fs::read_to_string(&running_path)?;
            let (mut fm, content) = frontmatter::parse(&raw)?;
            fm.insert(
                "status".to_string(),
                serde_yaml::Value::String("running".to_string()),
            );
            fm.insert(
                "agent".to_string(),
                serde_yaml::Value::String(agent_name.to_string()),
            );
            fm.insert(
                "started_at".to_string(),
                serde_yaml::Value::String(Utc::now().to_rfc3339()),
            );
            let updated = frontmatter::serialize(&fm, &content)?;
            std::fs::write(&running_path, updated)?;

            let job = parse_job_file(&running_path, jid)?;
            debug!(job_id = %jid, agent = %agent_name, "claimed job");
            Ok(Some(job))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            debug!(job_id = %jid, "job already claimed by another agent");
            Ok(None)
        }
        Err(e) => Err(e).context("claiming job"),
    }
}

/// Complete a job (move to done/).
pub fn complete_job(vault_path: &Path, jid: &str, result_text: &str) -> Result<()> {
    move_job(vault_path, jid, "running", "done", |fm| {
        fm.insert(
            "status".to_string(),
            serde_yaml::Value::String("done".to_string()),
        );
        fm.insert(
            "completed_at".to_string(),
            serde_yaml::Value::String(Utc::now().to_rfc3339()),
        );
        fm.insert(
            "result".to_string(),
            serde_yaml::Value::String(result_text.to_string()),
        );
    })
}

/// Fail a job (move to failed/).
pub fn fail_job(vault_path: &Path, jid: &str, error_msg: &str) -> Result<()> {
    move_job(vault_path, jid, "running", "failed", |fm| {
        fm.insert(
            "status".to_string(),
            serde_yaml::Value::String("failed".to_string()),
        );
        fm.insert(
            "completed_at".to_string(),
            serde_yaml::Value::String(Utc::now().to_rfc3339()),
        );
        fm.insert(
            "error".to_string(),
            serde_yaml::Value::String(error_msg.to_string()),
        );
    })
}

/// List pending job IDs.
pub fn list_pending_jobs(vault_path: &Path) -> Result<Vec<String>> {
    list_jobs_in_dir(vault_path, "pending")
}

/// Get job counts across all statuses.
pub fn get_job_counts(vault_path: &Path) -> Result<JobCounts> {
    Ok(JobCounts {
        pending: list_jobs_in_dir(vault_path, "pending")?.len(),
        running: list_jobs_in_dir(vault_path, "running")?.len(),
        done: list_jobs_in_dir(vault_path, "done")?.len(),
        failed: list_jobs_in_dir(vault_path, "failed")?.len(),
    })
}

fn list_jobs_in_dir(vault_path: &Path, status_dir: &str) -> Result<Vec<String>> {
    let dir = vault_path.join(JOBS_DIR).join(status_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut ids = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "md") {
            if let Some(stem) = path.file_stem() {
                ids.push(stem.to_string_lossy().to_string());
            }
        }
    }
    ids.sort();
    Ok(ids)
}

fn move_job(
    vault_path: &Path,
    jid: &str,
    from: &str,
    to: &str,
    update_fm: impl FnOnce(&mut std::collections::HashMap<String, serde_yaml::Value>),
) -> Result<()> {
    let from_path = vault_path
        .join(JOBS_DIR)
        .join(from)
        .join(format!("{}.md", jid));
    let to_dir = vault_path.join(JOBS_DIR).join(to);
    std::fs::create_dir_all(&to_dir)?;
    let to_path = to_dir.join(format!("{}.md", jid));

    let raw = std::fs::read_to_string(&from_path)?;
    let (mut fm, content) = frontmatter::parse(&raw)?;
    update_fm(&mut fm);
    let updated = frontmatter::serialize(&fm, &content)?;

    std::fs::write(&to_path, &updated)?;
    std::fs::remove_file(&from_path)?;

    debug!(job_id = %jid, from = %from, to = %to, "moved job");
    Ok(())
}

fn parse_job_file(path: &Path, jid: &str) -> Result<Job> {
    let raw = std::fs::read_to_string(path)?;
    let (fm, content) = frontmatter::parse(&raw)?;

    let get_str = |key: &str| -> Option<String> {
        fm.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
    };

    Ok(Job {
        id: jid.to_string(),
        r#type: hq_core::types::JobType::Background,
        instruction: content.trim().to_string(),
        status: match get_str("status").as_deref() {
            Some("running") => JobStatus::Running,
            Some("done") => JobStatus::Done,
            Some("failed") => JobStatus::Failed,
            Some("cancelled") => JobStatus::Cancelled,
            _ => JobStatus::Pending,
        },
        priority: fm
            .get("priority")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u8,
        security_profile: Default::default(),
        model: get_str("model"),
        thinking_level: None,
        agent: get_str("agent"),
        thread_id: None,
        result: get_str("result"),
        streaming_text: None,
        conversation_history: Vec::new(),
        steering_message: None,
        stats: None,
        created_at: get_str("created_at").unwrap_or_else(|| Utc::now().to_rfc3339()),
        updated_at: None,
        trace_id: None,
        span_id: None,
        file_path: Some(path.to_path_buf()),
    })
}

fn job_to_markdown(job: &Job) -> String {
    let mut fm = std::collections::HashMap::new();
    fm.insert(
        "status".to_string(),
        serde_yaml::Value::String("pending".to_string()),
    );
    fm.insert(
        "created_at".to_string(),
        serde_yaml::Value::String(job.created_at.clone()),
    );
    fm.insert(
        "priority".to_string(),
        serde_yaml::Value::Number(serde_yaml::Number::from(job.priority as u64)),
    );
    if let Some(ref mdl) = job.model {
        fm.insert(
            "model".to_string(),
            serde_yaml::Value::String(mdl.clone()),
        );
    }

    frontmatter::serialize(&fm, &job.instruction).unwrap_or_else(|_| job.instruction.clone())
}

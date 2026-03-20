//! Task queue — submit, claim, complete, and fail tasks backed by AtomicQueue.
//!
//! Ported from `packages/vault-client/src/vaultTasks.ts`.
//! Tasks live in `_tasks/{pending,running,completed,failed}/{taskId}.md`.

use anyhow::{bail, Result};
use chrono::Utc;
use hq_core::types::{TaskRecord, TaskStatus};
use std::path::Path;
use tracing::debug;

use crate::atomic_queue::AtomicQueue;
use crate::frontmatter;

const TASKS_DIR: &str = "_tasks";

/// Task stages used by the queue.
const TASK_STAGES: [&str; 4] = ["pending", "running", "completed", "failed"];

/// Build an `AtomicQueue` rooted at `{vault_path}/_tasks`.
pub fn task_queue(vault_path: &Path) -> Result<AtomicQueue> {
    AtomicQueue::new(
        vault_path.join(TASKS_DIR),
        TASK_STAGES.iter().map(|s| s.to_string()).collect(),
        None,
    )
}

/// Submit a new task into the pending queue.
pub fn submit_task(
    vault_path: &Path,
    job_id: &str,
    task_id: &str,
    instruction: &str,
    target_harness_type: Option<&str>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let harness = target_harness_type.unwrap_or("any");

    let mut fm = std::collections::HashMap::new();
    fm.insert(
        "taskId".to_string(),
        serde_yaml::Value::String(task_id.to_string()),
    );
    fm.insert(
        "jobId".to_string(),
        serde_yaml::Value::String(job_id.to_string()),
    );
    fm.insert(
        "status".to_string(),
        serde_yaml::Value::String("pending".to_string()),
    );
    fm.insert(
        "targetHarnessType".to_string(),
        serde_yaml::Value::String(harness.to_string()),
    );
    fm.insert(
        "createdAt".to_string(),
        serde_yaml::Value::String(now),
    );

    let body = format!("# Task Instruction\n\n{}", instruction);
    let content = frontmatter::serialize(&fm, &body)?;

    let filename = format!("{}.md", task_id);
    let q = task_queue(vault_path)?;
    q.enqueue(&filename, "pending", &content)?;

    debug!(task_id = %task_id, job_id = %job_id, "submitted task");
    Ok(())
}

/// Claim a pending task by atomically renaming it to running.
/// Returns `true` if the claim succeeded, `false` if the task was already claimed.
pub fn claim_task(vault_path: &Path, task_id: &str, worker_id: &str) -> Result<bool> {
    let filename = format!("{}.md", task_id);
    let q = task_queue(vault_path)?;
    let moved = q.transition(&filename, "pending", "running")?;
    if !moved {
        return Ok(false);
    }

    // Update frontmatter in the running file
    let file_path = vault_path
        .join(TASKS_DIR)
        .join("running")
        .join(&filename);
    update_task_frontmatter(&file_path, |fm| {
        fm.insert(
            "status".to_string(),
            serde_yaml::Value::String("running".to_string()),
        );
        fm.insert(
            "claimedBy".to_string(),
            serde_yaml::Value::String(worker_id.to_string()),
        );
        fm.insert(
            "claimedAt".to_string(),
            serde_yaml::Value::String(Utc::now().to_rfc3339()),
        );
    })?;

    debug!(task_id = %task_id, worker_id = %worker_id, "claimed task");
    Ok(true)
}

/// Complete a task — move from running (or pending) to completed, recording the result.
pub fn complete_task(vault_path: &Path, task_id: &str, result: &str) -> Result<()> {
    let filename = format!("{}.md", task_id);
    let q = task_queue(vault_path)?;

    // Try running -> completed first, then pending -> completed (for direct completion)
    let moved = q.transition(&filename, "running", "completed")?
        || q.transition(&filename, "pending", "completed")?;

    if !moved {
        bail!("Task not found: {}", task_id);
    }

    let file_path = vault_path
        .join(TASKS_DIR)
        .join("completed")
        .join(&filename);
    update_task_frontmatter(&file_path, |fm| {
        fm.insert(
            "status".to_string(),
            serde_yaml::Value::String("completed".to_string()),
        );
        fm.insert(
            "result".to_string(),
            serde_yaml::Value::String(result.to_string()),
        );
        fm.insert(
            "completedAt".to_string(),
            serde_yaml::Value::String(Utc::now().to_rfc3339()),
        );
    })?;

    debug!(task_id = %task_id, "completed task");
    Ok(())
}

/// Fail a task — move from running (or pending) to failed, recording the error.
pub fn fail_task(vault_path: &Path, task_id: &str, error: &str) -> Result<()> {
    let filename = format!("{}.md", task_id);
    let q = task_queue(vault_path)?;

    let moved = q.transition(&filename, "running", "failed")?
        || q.transition(&filename, "pending", "failed")?;

    if !moved {
        bail!("Task not found: {}", task_id);
    }

    let file_path = vault_path.join(TASKS_DIR).join("failed").join(&filename);
    update_task_frontmatter(&file_path, |fm| {
        fm.insert(
            "status".to_string(),
            serde_yaml::Value::String("failed".to_string()),
        );
        fm.insert(
            "error".to_string(),
            serde_yaml::Value::String(error.to_string()),
        );
        fm.insert(
            "completedAt".to_string(),
            serde_yaml::Value::String(Utc::now().to_rfc3339()),
        );
    })?;

    debug!(task_id = %task_id, "failed task");
    Ok(())
}

/// Get a single task by ID, searching all stages.
pub fn get_task(vault_path: &Path, task_id: &str) -> Result<Option<TaskRecord>> {
    let filename = format!("{}.md", task_id);
    let q = task_queue(vault_path)?;

    match q.find(&filename) {
        Some(item) => {
            let raw = std::fs::read_to_string(&item.path)?;
            let (fm, content) = frontmatter::parse(&raw)?;
            Ok(Some(parse_task_record(&fm, &content)))
        }
        None => Ok(None),
    }
}

/// Get all tasks for a given job ID, searching all stages.
pub fn get_tasks_for_job(vault_path: &Path, job_id: &str) -> Result<Vec<TaskRecord>> {
    let q = task_queue(vault_path)?;
    let mut tasks = Vec::new();

    for stage in &TASK_STAGES {
        let items = q.list(stage)?;
        for item in items {
            match std::fs::read_to_string(&item.path) {
                Ok(raw) => {
                    if let Ok((fm, content)) = frontmatter::parse(&raw) {
                        let fm_job_id = fm
                            .get("jobId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if fm_job_id == job_id {
                            tasks.push(parse_task_record(&fm, &content));
                        }
                    }
                }
                Err(_) => continue, // Skip unreadable files
            }
        }
    }

    Ok(tasks)
}

/// List task IDs in a given stage.
pub fn list_tasks(vault_path: &Path, stage: &str) -> Result<Vec<String>> {
    let q = task_queue(vault_path)?;
    let items = q.list(stage)?;
    Ok(items
        .into_iter()
        .map(|item| {
            item.name
                .strip_suffix(".md")
                .unwrap_or(&item.name)
                .to_string()
        })
        .collect())
}

// ─── Helpers ────────────────────────────────────────────────────

/// Parse a `TaskRecord` from frontmatter + content.
fn parse_task_record(
    fm: &std::collections::HashMap<String, serde_yaml::Value>,
    content: &str,
) -> TaskRecord {
    let get_str = |key: &str| -> Option<String> {
        fm.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
    };

    let status = match get_str("status").as_deref() {
        Some("running") => TaskStatus::Running,
        Some("completed") => TaskStatus::Completed,
        Some("failed") => TaskStatus::Failed,
        Some("blocked") => TaskStatus::Blocked,
        _ => TaskStatus::Pending,
    };

    TaskRecord {
        task_id: get_str("taskId").unwrap_or_default(),
        job_id: get_str("jobId").unwrap_or_default(),
        instruction: content.trim().to_string(),
        status,
        target_harness_type: get_str("targetHarnessType"),
        result: get_str("result"),
        error: get_str("error"),
        created_at: get_str("createdAt").unwrap_or_else(|| Utc::now().to_rfc3339()),
    }
}

/// Read a task file, update its frontmatter, and write it back.
fn update_task_frontmatter(
    path: &Path,
    update_fn: impl FnOnce(&mut std::collections::HashMap<String, serde_yaml::Value>),
) -> Result<()> {
    let raw = std::fs::read_to_string(path)?;
    let (mut fm, content) = frontmatter::parse(&raw)?;
    update_fn(&mut fm);
    let updated = frontmatter::serialize(&fm, &content)?;
    std::fs::write(path, updated)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn submit_and_get_task() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();

        submit_task(vault, "job-1", "task-1", "Do something", None).unwrap();
        let task = get_task(vault, "task-1").unwrap().unwrap();
        assert_eq!(task.task_id, "task-1");
        assert_eq!(task.job_id, "job-1");
        assert_eq!(task.status, TaskStatus::Pending);
        assert!(task.instruction.contains("Do something"));
    }

    #[test]
    fn claim_and_complete() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();

        submit_task(vault, "job-1", "task-1", "Work", None).unwrap();
        assert!(claim_task(vault, "task-1", "worker-a").unwrap());
        // Second claim should fail
        assert!(!claim_task(vault, "task-1", "worker-b").unwrap());

        let task = get_task(vault, "task-1").unwrap().unwrap();
        assert_eq!(task.status, TaskStatus::Running);

        complete_task(vault, "task-1", "Done!").unwrap();
        let task = get_task(vault, "task-1").unwrap().unwrap();
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.result.as_deref(), Some("Done!"));
    }

    #[test]
    fn fail_task_records_error() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();

        submit_task(vault, "job-1", "task-2", "Work", None).unwrap();
        claim_task(vault, "task-2", "worker-a").unwrap();
        fail_task(vault, "task-2", "Something broke").unwrap();

        let task = get_task(vault, "task-2").unwrap().unwrap();
        assert_eq!(task.status, TaskStatus::Failed);
        assert_eq!(task.error.as_deref(), Some("Something broke"));
    }

    #[test]
    fn get_tasks_for_job_filters() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();

        submit_task(vault, "job-a", "t1", "A1", None).unwrap();
        submit_task(vault, "job-a", "t2", "A2", None).unwrap();
        submit_task(vault, "job-b", "t3", "B1", None).unwrap();

        let tasks = get_tasks_for_job(vault, "job-a").unwrap();
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().all(|t| t.job_id == "job-a"));
    }

    #[test]
    fn list_tasks_in_stage() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();

        submit_task(vault, "j", "t1", "X", None).unwrap();
        submit_task(vault, "j", "t2", "Y", None).unwrap();
        claim_task(vault, "t1", "w").unwrap();

        let pending = list_tasks(vault, "pending").unwrap();
        assert_eq!(pending, vec!["t2"]);

        let running = list_tasks(vault, "running").unwrap();
        assert_eq!(running, vec!["t1"]);
    }
}

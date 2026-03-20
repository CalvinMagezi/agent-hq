use anyhow::Result;
use hq_core::types::{Job, JobCounts, Note, SystemContext, TaskRecord, VaultStats};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::{jobs, notes, query, system, tasks, usage};

/// Main entry point for vault filesystem operations.
#[derive(Debug, Clone)]
pub struct VaultClient {
    vault_path: PathBuf,
}

impl VaultClient {
    pub fn new(vault_path: PathBuf) -> Result<Self> {
        if !vault_path.exists() {
            std::fs::create_dir_all(&vault_path)?;
        }
        Ok(Self { vault_path })
    }

    pub fn vault_path(&self) -> &Path {
        &self.vault_path
    }

    // --- Notes ---

    pub fn read_note(&self, rel_path: &str) -> Result<Note> {
        notes::read_note(&self.vault_path, rel_path)
    }

    pub fn write_note(&self, rel_path: &str, note: &Note) -> Result<()> {
        notes::write_note(&self.vault_path, rel_path, note)
    }

    pub fn list_notes(&self, dir: &str) -> Result<Vec<String>> {
        notes::list_notes(&self.vault_path, dir)
    }

    pub fn list_notes_recursive(&self, dir: &str) -> Result<Vec<String>> {
        notes::list_notes_recursive(&self.vault_path, dir)
    }

    pub fn note_exists(&self, rel_path: &str) -> bool {
        self.vault_path.join(rel_path).exists()
    }

    // --- Jobs ---

    pub fn create_job(&self, instruction: &str, model: Option<&str>) -> Result<Job> {
        jobs::create_job(&self.vault_path, instruction, model)
    }

    pub fn claim_job(&self, job_id: &str, agent_name: &str) -> Result<Option<Job>> {
        jobs::claim_job(&self.vault_path, job_id, agent_name)
    }

    pub fn complete_job(&self, job_id: &str, result: &str) -> Result<()> {
        jobs::complete_job(&self.vault_path, job_id, result)
    }

    pub fn fail_job(&self, job_id: &str, error: &str) -> Result<()> {
        jobs::fail_job(&self.vault_path, job_id, error)
    }

    pub fn list_pending_jobs(&self) -> Result<Vec<String>> {
        jobs::list_pending_jobs(&self.vault_path)
    }

    pub fn get_job_counts(&self) -> Result<JobCounts> {
        jobs::get_job_counts(&self.vault_path)
    }

    // --- Tasks ---

    pub fn submit_task(
        &self,
        job_id: &str,
        task_id: &str,
        instruction: &str,
        target_harness_type: Option<&str>,
    ) -> Result<()> {
        tasks::submit_task(&self.vault_path, job_id, task_id, instruction, target_harness_type)
    }

    pub fn claim_task(&self, task_id: &str, worker_id: &str) -> Result<bool> {
        tasks::claim_task(&self.vault_path, task_id, worker_id)
    }

    pub fn complete_task(&self, task_id: &str, result: &str) -> Result<()> {
        tasks::complete_task(&self.vault_path, task_id, result)
    }

    pub fn fail_task(&self, task_id: &str, error: &str) -> Result<()> {
        tasks::fail_task(&self.vault_path, task_id, error)
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskRecord>> {
        tasks::get_task(&self.vault_path, task_id)
    }

    pub fn get_tasks_for_job(&self, job_id: &str) -> Result<Vec<TaskRecord>> {
        tasks::get_tasks_for_job(&self.vault_path, job_id)
    }

    pub fn list_tasks(&self, stage: &str) -> Result<Vec<String>> {
        tasks::list_tasks(&self.vault_path, stage)
    }

    // --- Query ---

    /// Return a fluent `NoteQuery` builder scoped to `Notebooks/{folder}`.
    pub fn query(&self, folder: &str) -> query::NoteQuery {
        query::NoteQuery::new(&self.vault_path, folder)
    }

    // --- System Context ---

    pub fn get_system_context(&self) -> Result<SystemContext> {
        system::get_system_context(&self.vault_path)
    }

    pub fn read_system_file(&self, name: &str) -> Result<String> {
        system::read_system_file(&self.vault_path, name)
    }

    pub fn write_system_file(&self, name: &str, content: &str) -> Result<()> {
        system::write_system_file(&self.vault_path, name, content)
    }

    pub fn get_pinned_notes(&self) -> Result<Vec<Note>> {
        system::get_pinned_notes(&self.vault_path)
    }

    pub fn update_heartbeat(
        &self,
        worker_id: &str,
        metadata: &HashMap<String, String>,
    ) -> Result<()> {
        system::update_heartbeat(&self.vault_path, worker_id, metadata)
    }

    // --- Usage Tracking ---

    pub fn record_usage(
        &self,
        agent: &str,
        model: &str,
        prompt_tokens: u64,
        completion_tokens: u64,
        cost: f64,
        job_id: Option<&str>,
    ) -> Result<()> {
        usage::record_usage(
            &self.vault_path,
            agent,
            model,
            prompt_tokens,
            completion_tokens,
            cost,
            job_id,
        )
    }

    pub fn get_recent_activity(&self, limit: usize) -> Result<Vec<usage::ActivityEntry>> {
        usage::get_recent_activity(&self.vault_path, limit)
    }

    pub fn get_usage_summary(&self) -> Result<usage::UsageSummary> {
        usage::get_usage_summary(&self.vault_path)
    }

    // --- Stats ---

    pub fn get_stats(&self) -> Result<VaultStats> {
        let all_notes = notes::list_notes_recursive(&self.vault_path, "")?;
        let job_counts = jobs::get_job_counts(&self.vault_path)?;

        let db_path = self.vault_path.join("_data").join("vault.db");
        let db_size = std::fs::metadata(&db_path)
            .map(|m| m.len())
            .unwrap_or(0);

        Ok(VaultStats {
            total_notes: all_notes.len(),
            total_jobs: job_counts,
            vault_path: self.vault_path.clone(),
            db_size_bytes: db_size,
        })
    }
}

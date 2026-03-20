//! Interval-based task scheduler for the daemon.

use anyhow::Result;
use chrono::Utc;
use hq_vault::VaultClient;
use std::time::{Duration, Instant};
use tokio::time;
use tracing::{error, info};

/// A scheduled daemon task.
struct DaemonTask {
    /// Human-readable task name.
    name: String,
    /// How often this task should run.
    interval: Duration,
    /// When this task last ran.
    last_run: Option<Instant>,
    /// The task handler. Returns Ok(description) on success.
    handler: Box<dyn Fn() -> Result<String> + Send + Sync>,
}

/// Records the result of a task run.
struct TaskRunRecord {
    name: String,
    status: String,
    last_run: String,
}

/// The main daemon scheduler. Registers tasks and runs them on intervals.
pub struct DaemonScheduler {
    tasks: Vec<DaemonTask>,
    vault: VaultClient,
    run_records: Vec<TaskRunRecord>,
}

impl DaemonScheduler {
    /// Create a new scheduler with the given vault client.
    pub fn new(vault: VaultClient) -> Self {
        Self {
            tasks: Vec::new(),
            vault,
            run_records: Vec::new(),
        }
    }

    /// Register a new periodic task.
    pub fn register<F>(&mut self, name: &str, interval: Duration, handler: F)
    where
        F: Fn() -> Result<String> + Send + Sync + 'static,
    {
        self.tasks.push(DaemonTask {
            name: name.to_string(),
            interval,
            last_run: None,
            handler: Box::new(handler),
        });
        info!(task = %name, interval_secs = interval.as_secs(), "registered daemon task");
    }

    /// Run the main scheduler loop. Ticks every 30 seconds.
    pub async fn run(&mut self) -> Result<()> {
        info!(task_count = self.tasks.len(), "daemon scheduler starting");
        let mut interval = time::interval(Duration::from_secs(30));

        loop {
            interval.tick().await;
            self.tick();
            if let Err(e) = self.write_status() {
                error!(error = %e, "failed to write daemon status");
            }
        }
    }

    /// Execute one tick: check all tasks and fire any that are due.
    fn tick(&mut self) {
        let now = Instant::now();

        for task in &mut self.tasks {
            let should_run = match task.last_run {
                None => true,
                Some(last) => now.duration_since(last) >= task.interval,
            };

            if !should_run {
                continue;
            }

            info!(task = %task.name, "running daemon task");
            let result = (task.handler)();
            task.last_run = Some(now);

            let status = match &result {
                Ok(msg) => {
                    info!(task = %task.name, result = %msg, "task completed");
                    format!("ok: {}", msg)
                }
                Err(e) => {
                    error!(task = %task.name, error = %e, "task failed");
                    format!("error: {}", e)
                }
            };

            // Update run record
            let timestamp = Utc::now().to_rfc3339();
            if let Some(record) = self.run_records.iter_mut().find(|r| r.name == task.name) {
                record.status = status;
                record.last_run = timestamp;
            } else {
                self.run_records.push(TaskRunRecord {
                    name: task.name.clone(),
                    status,
                    last_run: timestamp,
                });
            }
        }
    }

    /// Write DAEMON-STATUS.md to the vault root with last run times.
    fn write_status(&self) -> Result<()> {
        let mut content = String::from("# Daemon Status\n\n");
        content.push_str(&format!(
            "Last updated: {}\n\n",
            Utc::now().to_rfc3339()
        ));
        content.push_str("| Task | Status | Last Run |\n");
        content.push_str("|------|--------|----------|\n");

        for record in &self.run_records {
            content.push_str(&format!(
                "| {} | {} | {} |\n",
                record.name, record.status, record.last_run
            ));
        }

        let status_path = self.vault.vault_path().join("DAEMON-STATUS.md");
        std::fs::write(&status_path, content)?;
        Ok(())
    }
}

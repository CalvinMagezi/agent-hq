//! Daemon scheduler — interval-based task execution with 30-second tick.

pub mod helpers;
pub mod tasks_fast;
pub mod tasks_periodic;
pub mod tasks_scheduled;
pub mod tasks_slow;

use anyhow::Result;
use hq_core::config::HqConfig;
use hq_db::Database;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tracing::info;

use helpers::ensure_dir;

// ─── DaemonTask definition ───────────────────────────────────

pub struct DaemonTask {
    pub name: &'static str,
    pub interval: Duration,
    pub last_run: tokio::time::Instant,
    pub run_count: u64,
    pub error_count: u64,
    pub last_error: Option<String>,
}

impl DaemonTask {
    pub fn new(name: &'static str, interval: Duration) -> Self {
        Self {
            name,
            interval,
            // Set last_run to past so all tasks fire on first tick
            last_run: tokio::time::Instant::now() - interval - Duration::from_secs(1),
            run_count: 0,
            error_count: 0,
            last_error: None,
        }
    }
}

// ─── Main daemon loop ────────────────────────────────────────

pub async fn run_daemon(
    config: &HqConfig,
    vault: Arc<hq_vault::VaultClient>,
    db: Arc<Database>,
) -> Result<()> {
    let vault_path = vault.vault_path().to_path_buf();
    let started_at = chrono::Utc::now().to_rfc3339();

    // Ensure system directories exist
    ensure_dir(&vault_path.join("_system"));
    ensure_dir(&vault_path.join("_jobs").join("pending"));
    ensure_dir(&vault_path.join("_jobs").join("running"));
    ensure_dir(&vault_path.join("_jobs").join("completed"));
    ensure_dir(&vault_path.join("_jobs").join("failed"));

    // Define all tasks with their intervals
    let mut tasks = vec![
        // Every 1 minute
        DaemonTask::new("expire-approvals", Duration::from_secs(60)),
        DaemonTask::new("plan-sync", Duration::from_secs(60)),
        // Every 5 minutes
        DaemonTask::new("heartbeat", Duration::from_secs(300)),
        DaemonTask::new("health-check", Duration::from_secs(300)),
        DaemonTask::new("browser-health", Duration::from_secs(300)),
        DaemonTask::new("proactive-check", Duration::from_secs(300)),
        // Every 15 minutes
        DaemonTask::new("news-pulse", Duration::from_secs(900)),
        // Every 30 minutes
        DaemonTask::new("memory-consolidation", Duration::from_secs(1800)),
        DaemonTask::new("embeddings", Duration::from_secs(1800)),
        DaemonTask::new("hq-inbox-scan", Duration::from_secs(1800)),
        // Every 1 hour
        DaemonTask::new("budget-reset", Duration::from_secs(3600)),
        DaemonTask::new("stale-cleanup", Duration::from_secs(3600)),
        DaemonTask::new("delegation-cleanup", Duration::from_secs(3600)),
        DaemonTask::new("daily-brief", Duration::from_secs(3600)),
        DaemonTask::new("morning-brief-audio", Duration::from_secs(3600)),
        DaemonTask::new("morning-brief-notebooklm", Duration::from_secs(3600)),
        DaemonTask::new("hq-morning-brief", Duration::from_secs(3600)),
        DaemonTask::new("model-intelligence", Duration::from_secs(3600)),
        DaemonTask::new("plan-archival", Duration::from_secs(3600)),
        // Every 6 hours
        DaemonTask::new("vault-health", Duration::from_secs(21600)),
        DaemonTask::new("stale-thread-detector", Duration::from_secs(21600)),
        // Every 24 hours
        DaemonTask::new("memory-forgetting", Duration::from_secs(86400)),
        DaemonTask::new("vault-cleanup", Duration::from_secs(86400)),
        DaemonTask::new("frontmatter-audit", Duration::from_secs(86400)),
        // Touchpoints (hourly check, self-gated by time)
        DaemonTask::new("daily-synthesis", Duration::from_secs(3600)),
        DaemonTask::new("evening-reflection", Duration::from_secs(3600)),
        // Event-driven (scan every 1 minute)
        DaemonTask::new("embedding-on-change", Duration::from_secs(60)),
        // Claude Code cron runner (every 1 minute)
        DaemonTask::new("claude-cron-runner", Duration::from_secs(60)),
    ];

    // Write initial schedule and status
    write_cron_schedule(&vault_path, &tasks);
    write_daemon_status(&vault_path, &tasks, &started_at);

    info!(
        tasks = tasks.len(),
        "daemon: scheduler running ({} tasks, 30s tick)",
        tasks.len()
    );

    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        interval.tick().await;
        let now = tokio::time::Instant::now();

        for task in &mut tasks {
            if now.duration_since(task.last_run) >= task.interval {
                task.last_run = now;
                tracing::debug!(task = task.name, "daemon: running task");
                match dispatch_task(task.name, &vault_path, &db, config).await {
                    Ok(()) => {
                        task.run_count += 1;
                    }
                    Err(e) => {
                        task.error_count += 1;
                        let err_msg = format!("{e:#}");
                        tracing::warn!(
                            task = task.name,
                            error = %err_msg,
                            "daemon: task error"
                        );
                        task.last_error = Some(err_msg);
                    }
                }
            }
        }

        write_daemon_status(&vault_path, &tasks, &started_at);
    }
}

// ─── Task dispatch ───────────────────────────────────────────

async fn dispatch_task(
    task_name: &str,
    vault_path: &Path,
    db: &Database,
    config: &HqConfig,
) -> Result<()> {
    match task_name {
        // Fast cycle (1 min)
        "expire-approvals" => tasks_fast::run_expire_approvals(vault_path).await,
        "plan-sync" => tasks_fast::run_plan_sync(vault_path).await,
        "embedding-on-change" => tasks_fast::run_embedding_on_change(vault_path).await,
        "claude-cron-runner" => tasks_fast::run_claude_cron(vault_path).await,

        // Periodic (5 min — 1 hour)
        "heartbeat" => tasks_periodic::run_heartbeat(vault_path).await,
        "health-check" => tasks_periodic::run_health_check(vault_path).await,
        "browser-health" => tasks_periodic::run_browser_health().await,
        "proactive-check" => tasks_periodic::run_proactive_check(vault_path, config).await,
        "news-pulse" => tasks_periodic::run_news_pulse(vault_path).await,
        "memory-consolidation" => tasks_periodic::run_memory_consolidation(vault_path, db).await,
        "embeddings" => tasks_periodic::run_embeddings(vault_path, db).await,
        "hq-inbox-scan" => tasks_periodic::run_inbox_scan(vault_path).await,
        "budget-reset" => tasks_periodic::run_budget_reset(vault_path).await,
        "stale-cleanup" => tasks_periodic::run_stale_cleanup(vault_path).await,
        "delegation-cleanup" => tasks_periodic::run_delegation_cleanup(vault_path).await,
        "model-intelligence" => tasks_periodic::run_model_intelligence(vault_path, config).await,

        // Scheduled (time-gated)
        "daily-brief" => tasks_scheduled::run_daily_brief(vault_path).await,
        "morning-brief-audio" => tasks_scheduled::run_morning_brief_audio(vault_path).await,
        "morning-brief-notebooklm" => {
            tasks_scheduled::run_morning_brief_notebooklm(vault_path).await
        }
        "hq-morning-brief" => tasks_scheduled::run_morning_brief_markdown(vault_path).await,
        "daily-synthesis" => tasks_scheduled::run_daily_synthesis(vault_path).await,
        "evening-reflection" => tasks_scheduled::run_evening_reflection(vault_path, db).await,

        // Slow cycle (6h — daily)
        "vault-health" => tasks_slow::run_vault_health(vault_path, db).await,
        "stale-thread-detector" => tasks_slow::run_stale_thread_detector(vault_path).await,
        "memory-forgetting" => tasks_slow::run_memory_forgetting(vault_path, db).await,
        "vault-cleanup" => tasks_slow::run_vault_cleanup(vault_path).await,
        "frontmatter-audit" => tasks_slow::run_frontmatter_audit(vault_path).await,
        "plan-archival" => tasks_slow::run_plan_archival(vault_path).await,

        unknown => {
            tracing::warn!(task = unknown, "daemon: unknown task");
            Ok(())
        }
    }
}

// ─── Status file writers ─────────────────────────────────────

fn format_interval(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86400)
    }
}

pub fn write_cron_schedule(vault_path: &Path, tasks: &[DaemonTask]) {
    let sys_dir = vault_path.join("_system");
    ensure_dir(&sys_dir);
    let now = chrono::Utc::now().to_rfc3339();
    let mut md = format!(
        "---\ngenerated_at: {now}\ntask_count: {}\nruntime: rust\n---\n\n\
         # Cron Schedule\n\nGenerated at {now}\n\n\
         | # | Task | Interval |\n|---|------|----------|\n",
        tasks.len()
    );
    for (i, t) in tasks.iter().enumerate() {
        md.push_str(&format!(
            "| {} | `{}` | {} |\n",
            i + 1,
            t.name,
            format_interval(t.interval.as_secs())
        ));
    }
    let _ = std::fs::write(sys_dir.join("CRON-SCHEDULE.md"), md);
}

pub fn write_daemon_status(vault_path: &Path, tasks: &[DaemonTask], started_at: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    let total_runs: u64 = tasks.iter().map(|t| t.run_count).sum();
    let total_errors: u64 = tasks.iter().map(|t| t.error_count).sum();
    let mut md = format!(
        "---\nstatus: running\nstarted_at: {started_at}\nlast_tick: {now}\n\
         runtime: rust\ntask_count: {}\ntotal_runs: {total_runs}\n\
         total_errors: {total_errors}\n---\n\n\
         # Daemon Status\n\nStarted: {started_at}  \n\
         Last tick: {now}  \nTasks: {} | Runs: {total_runs} | Errors: {total_errors}\n\n\
         | Task | Interval | Runs | Errors | Last Error |\n\
         |------|----------|------|--------|------------|\n",
        tasks.len(),
        tasks.len()
    );
    for t in tasks {
        let err_str = t.last_error.as_deref().unwrap_or("-");
        let err_display = if err_str.len() > 60 {
            &err_str[..60]
        } else {
            err_str
        };
        md.push_str(&format!(
            "| `{}` | {} | {} | {} | {} |\n",
            t.name,
            format_interval(t.interval.as_secs()),
            t.run_count,
            t.error_count,
            err_display
        ));
    }
    let _ = std::fs::write(vault_path.join("DAEMON-STATUS.md"), md);
}

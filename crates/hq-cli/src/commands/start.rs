use anyhow::{Context, Result};
use hq_core::config::HqConfig;
use hq_db::Database;
// LlmProvider trait imported locally where needed (run_hq_harness_stream)
use hq_vault::VaultClient;
use std::sync::Arc;
use tokio::signal;
use tracing::info;

pub async fn run(config: &HqConfig, component: &str) -> Result<()> {
    // Initialize shared services
    let vault = Arc::new(
        VaultClient::new(config.vault_path.clone())
            .context("failed to open vault")?,
    );

    let db_path = config.db_path();
    let db = Arc::new(
        Database::open(&db_path)
            .context("failed to open database")?,
    );

    info!(vault = %config.vault_path.display(), "HQ starting");

    match component {
        "all" => {
            println!("Starting all HQ components...");
            start_all(config, vault, db).await
        }
        "agent" => {
            println!("Starting agent worker...");
            start_agent(config, vault.clone(), db.clone()).await
        }
        "daemon" => {
            println!("Starting daemon...");
            start_daemon(config, vault.clone(), db.clone()).await
        }
        "relay" | "discord" => {
            println!("Starting Discord relay...");
            start_discord(config, vault.clone(), db.clone()).await
        }
        "telegram" => {
            println!("Starting Telegram relay...");
            start_telegram(config, vault.clone(), db.clone()).await
        }
        other => {
            println!("Unknown component: {other}");
            println!("Options: all, agent, daemon, relay, discord, telegram");
            Ok(())
        }
    }
}

async fn start_all(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    db: Arc<Database>,
) -> Result<()> {
    println!("  Daemon scheduler");
    println!("  Agent worker");
    if config.relay.discord_enabled {
        println!("  Discord relay");
    }
    if config.relay.telegram_enabled {
        println!("  Telegram relay");
    }
    println!("  WebSocket server on port {}", config.ws_port);
    println!();

    // Spawn daemon
    let daemon_vault = vault.clone();
    let daemon_db = db.clone();
    let daemon_config = config.clone();
    tokio::spawn(async move {
        info!("daemon: starting scheduler");
        if let Err(e) = run_daemon(&daemon_config, daemon_vault, daemon_db).await {
            tracing::error!("daemon error: {e}");
        }
    });

    // Spawn agent worker
    let agent_vault = vault.clone();
    let agent_db = db.clone();
    let agent_config = config.clone();
    tokio::spawn(async move {
        info!("agent: starting worker");
        if let Err(e) = run_agent_worker(&agent_config, agent_vault, agent_db).await {
            tracing::error!("agent error: {e}");
        }
    });

    // Spawn Discord relay
    if config.relay.discord_enabled {
        if let Some(ref token) = config.relay.discord_token {
            let token = token.clone();
            let relay_vault = vault.clone();
            let relay_db = db.clone();
            let api_key = config.openrouter_api_key.clone().unwrap_or_default();
            let model = config.default_model.clone();
            tokio::spawn(async move {
                info!("discord: starting relay");
                if let Err(e) = run_discord_relay(&token, relay_vault, relay_db, api_key, model).await {
                    tracing::error!("discord relay error: {e}");
                }
            });
        } else {
            println!("  Discord enabled but no token configured — skipping");
        }
    }

    // Spawn Telegram relay
    if config.relay.telegram_enabled {
        if let Some(ref token) = config.relay.telegram_token {
            let token = token.clone();
            let relay_vault = vault.clone();
            let relay_db = db.clone();
            let api_key = config.openrouter_api_key.clone().unwrap_or_default();
            let model = config.default_model.clone();
            tokio::spawn(async move {
                info!("telegram: starting relay");
                if let Err(e) = run_telegram_relay(&token, relay_vault, relay_db, api_key, model).await {
                    tracing::error!("telegram relay error: {e}");
                }
            });
        } else {
            println!("  Telegram enabled but no token configured — skipping");
        }
    }

    // Spawn WebSocket + Web UI server
    let ws_port = config.ws_port;
    let vault_for_ws = config.vault_path.clone();
    tokio::spawn(async move {
        info!(port = ws_port, "ws: starting server");
        // Resolve static dir relative to vault parent (repo root)
        let repo_root = vault_for_ws.parent().unwrap_or(&vault_for_ws);
        let static_dir = repo_root.join("web").join("dist");
        let static_opt = if static_dir.join("index.html").exists() {
            info!(path = %static_dir.display(), "ws: serving web UI");
            Some(static_dir)
        } else {
            None
        };
        let state = Arc::new(hq_web::WsState::new(vault_for_ws, static_opt));
        let app = hq_web::create_router(state);
        // Bind to 0.0.0.0 so Tailscale/Caddy can reach it
        let addr = std::net::SocketAddr::from(([0, 0, 0, 0], ws_port));
        if let Err(e) = axum::serve(
            tokio::net::TcpListener::bind(addr).await.unwrap(),
            app,
        ).await {
            tracing::error!("ws server error: {e}");
        }
    });

    println!("All components running. Press Ctrl+C to stop.");
    println!();

    // Wait for shutdown signal
    signal::ctrl_c().await?;
    println!("\nShutting down...");
    Ok(())
}

async fn start_agent(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    db: Arc<Database>,
) -> Result<()> {
    run_agent_worker(config, vault, db).await
}

async fn start_daemon(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    db: Arc<Database>,
) -> Result<()> {
    run_daemon(config, vault, db).await
}

async fn start_discord(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    db: Arc<Database>,
) -> Result<()> {
    let token = config.relay.discord_token.as_ref()
        .context("Discord token not configured. Set relay.discord_token in ~/.hq/config.yaml")?;
    let api_key = config.openrouter_api_key.clone().unwrap_or_default();
    run_discord_relay(token, vault, db, api_key, config.default_model.clone()).await
}

async fn start_telegram(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    db: Arc<Database>,
) -> Result<()> {
    let token = config.relay.telegram_token.as_ref()
        .context("Telegram token not configured. Set relay.telegram_token in ~/.hq/config.yaml")?;
    let api_key = config.openrouter_api_key.clone().unwrap_or_default();
    run_telegram_relay(token, vault, db, api_key, config.default_model.clone()).await
}

// ─── Component runners ──────────────────────────────────────────

// ─── Daemon scheduler (27 tasks) ───────────────────────────────

struct DaemonTask {
    name: &'static str,
    interval: std::time::Duration,
    last_run: tokio::time::Instant,
    run_count: u64,
    error_count: u64,
    last_error: Option<String>,
}

impl DaemonTask {
    fn new(name: &'static str, interval: std::time::Duration) -> Self {
        Self {
            name,
            interval,
            // Set last_run to epoch so all tasks fire on first tick
            last_run: tokio::time::Instant::now() - interval - std::time::Duration::from_secs(1),
            run_count: 0,
            error_count: 0,
            last_error: None,
        }
    }
}

fn ensure_dir(path: &std::path::Path) {
    if !path.exists() {
        let _ = std::fs::create_dir_all(path);
    }
}

/// Check if a time-gated task has already run today by looking for a flag file.
fn has_run_today(vault_path: &std::path::Path, task_name: &str) -> bool {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let flag_dir = vault_path.join("_system").join(".daemon-flags");
    let flag_file = flag_dir.join(format!("{task_name}-{today}"));
    flag_file.exists()
}

/// Mark a time-gated task as having run today.
fn mark_run_today(vault_path: &std::path::Path, task_name: &str) {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let flag_dir = vault_path.join("_system").join(".daemon-flags");
    ensure_dir(&flag_dir);
    let flag_file = flag_dir.join(format!("{task_name}-{today}"));
    let _ = std::fs::write(&flag_file, &today);
    // Clean up old flags (older than 3 days)
    if let Ok(entries) = std::fs::read_dir(&flag_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name();
            let fname_str = fname.to_string_lossy();
            if fname_str.starts_with(task_name) && !fname_str.ends_with(&today) {
                // Check if it's older than 3 days by comparing date strings
                if let Some(date_part) = fname_str.rsplit('-').collect::<Vec<_>>().get(..3) {
                    let file_date = date_part.iter().rev().copied().collect::<Vec<_>>().join("-");
                    if let Ok(fd) = chrono::NaiveDate::parse_from_str(&file_date, "%Y-%m-%d") {
                        let today_date = chrono::Utc::now().date_naive();
                        if today_date.signed_duration_since(fd).num_days() > 3 {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }
}

/// Get current hour in EAT (UTC+3).
fn current_eat_hour() -> u32 {
    use chrono::{FixedOffset, Timelike, Utc};
    let eat = FixedOffset::east_opt(3 * 3600).unwrap();
    let now = Utc::now().with_timezone(&eat);
    now.hour()
}

/// Get current minute in EAT (UTC+3).
fn current_eat_minute() -> u32 {
    use chrono::{FixedOffset, Timelike, Utc};
    let eat = FixedOffset::east_opt(3 * 3600).unwrap();
    let now = Utc::now().with_timezone(&eat);
    now.minute()
}

use chrono::Datelike;

fn write_cron_schedule(vault_path: &std::path::Path, tasks: &[DaemonTask]) {
    let sys_dir = vault_path.join("_system");
    ensure_dir(&sys_dir);
    let now = chrono::Utc::now().to_rfc3339();
    let mut md = format!(
        "---\ngenerated_at: {now}\ntask_count: {}\nruntime: rust\n---\n\n# Cron Schedule\n\nGenerated at {now}\n\n| # | Task | Interval |\n|---|------|----------|\n",
        tasks.len()
    );
    for (i, t) in tasks.iter().enumerate() {
        let interval_str = if t.interval.as_secs() < 60 {
            format!("{}s", t.interval.as_secs())
        } else if t.interval.as_secs() < 3600 {
            format!("{}m", t.interval.as_secs() / 60)
        } else if t.interval.as_secs() < 86400 {
            format!("{}h", t.interval.as_secs() / 3600)
        } else {
            format!("{}d", t.interval.as_secs() / 86400)
        };
        md.push_str(&format!("| {} | `{}` | {} |\n", i + 1, t.name, interval_str));
    }
    let _ = std::fs::write(sys_dir.join("CRON-SCHEDULE.md"), md);
}

fn write_daemon_status(vault_path: &std::path::Path, tasks: &[DaemonTask], started_at: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    let total_runs: u64 = tasks.iter().map(|t| t.run_count).sum();
    let total_errors: u64 = tasks.iter().map(|t| t.error_count).sum();
    let mut md = format!(
        "---\nstatus: running\nstarted_at: {started_at}\nlast_tick: {now}\nruntime: rust\ntask_count: {}\ntotal_runs: {total_runs}\ntotal_errors: {total_errors}\n---\n\n# Daemon Status\n\nStarted: {started_at}  \nLast tick: {now}  \nTasks: {} | Runs: {total_runs} | Errors: {total_errors}\n\n| Task | Interval | Runs | Errors | Last Error |\n|------|----------|------|--------|------------|\n",
        tasks.len(), tasks.len()
    );
    for t in tasks {
        let interval_str = if t.interval.as_secs() < 60 {
            format!("{}s", t.interval.as_secs())
        } else if t.interval.as_secs() < 3600 {
            format!("{}m", t.interval.as_secs() / 60)
        } else if t.interval.as_secs() < 86400 {
            format!("{}h", t.interval.as_secs() / 3600)
        } else {
            format!("{}d", t.interval.as_secs() / 86400)
        };
        let err_str = t.last_error.as_deref().unwrap_or("-");
        // Truncate error to 60 chars for table readability
        let err_display = if err_str.len() > 60 { &err_str[..60] } else { err_str };
        md.push_str(&format!(
            "| `{}` | {} | {} | {} | {} |\n",
            t.name, interval_str, t.run_count, t.error_count, err_display
        ));
    }
    let _ = std::fs::write(vault_path.join("DAEMON-STATUS.md"), md);
}

async fn run_daemon_task(
    task_name: &str,
    vault_path: &std::path::Path,
    db: &Database,
    config: &HqConfig,
) -> Result<()> {
    use std::path::Path;

    match task_name {
        // ── Every 1 minute ──────────────────────────────────────

        "expire-approvals" => {
            // Scan _approvals/pending/, delete any older than 5 minutes
            let pending_dir = vault_path.join("_approvals").join("pending");
            if pending_dir.exists() {
                let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(300);
                let mut expired = 0u32;
                if let Ok(entries) = std::fs::read_dir(&pending_dir) {
                    for entry in entries.flatten() {
                        if let Ok(meta) = entry.metadata() {
                            if let Ok(modified) = meta.modified() {
                                if modified < cutoff {
                                    let _ = std::fs::remove_file(entry.path());
                                    expired += 1;
                                }
                            }
                        }
                    }
                }
                if expired > 0 {
                    info!(count = expired, "expire-approvals: removed expired approvals");
                }
            }
            Ok(())
        }

        "plan-sync" => {
            // Read _plans/active/ markdown files, update their status
            let plans_dir = vault_path.join("_plans").join("active");
            if plans_dir.exists() {
                let mut checked = 0u32;
                if let Ok(entries) = std::fs::read_dir(&plans_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().map(|e| e == "md").unwrap_or(false) {
                            if let Ok(content) = std::fs::read_to_string(&path) {
                                // Check if all steps are marked done (- [x])
                                let total_steps = content.matches("- [").count();
                                let done_steps = content.matches("- [x]").count();
                                if total_steps > 0 && done_steps == total_steps {
                                    // Move to completed
                                    let completed_dir = vault_path.join("_plans").join("completed");
                                    ensure_dir(&completed_dir);
                                    let dest = completed_dir.join(entry.file_name());
                                    let _ = std::fs::rename(&path, &dest);
                                    info!(plan = ?entry.file_name(), "plan-sync: plan completed, moved to completed/");
                                }
                                checked += 1;
                            }
                        }
                    }
                }
                tracing::debug!(checked, "plan-sync: checked active plans");
            }
            Ok(())
        }

        // ── Every 5 minutes ─────────────────────────────────────

        "heartbeat" => {
            // Update _system/HEARTBEAT.md with daemon status, uptime, active components
            let sys_dir = vault_path.join("_system");
            ensure_dir(&sys_dir);
            let now = chrono::Utc::now().to_rfc3339();
            let uptime_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let content = format!(
                "---\nstatus: alive\nlast_heartbeat: {now}\nruntime: rust\n---\n\n# Heartbeat\n\nDaemon is alive.\n\n- **Last heartbeat**: {now}\n- **System uptime**: {}h {}m\n- **Components**: daemon, agent-worker\n",
                uptime_secs / 3600, (uptime_secs % 3600) / 60
            );
            std::fs::write(sys_dir.join("HEARTBEAT.md"), content)?;
            Ok(())
        }

        "health-check" => {
            // Check for stuck jobs (running > 30min), offline workers
            let running_dir = vault_path.join("_jobs").join("running");
            if running_dir.exists() {
                let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(1800);
                if let Ok(entries) = std::fs::read_dir(&running_dir) {
                    for entry in entries.flatten() {
                        if let Ok(meta) = entry.metadata() {
                            if let Ok(modified) = meta.modified() {
                                if modified < cutoff {
                                    tracing::warn!(
                                        job = ?entry.file_name(),
                                        "health-check: stuck job detected (running > 30min)"
                                    );
                                }
                            }
                        }
                    }
                }
            }
            // Check worker heartbeat
            let heartbeat_path = vault_path.join("_system").join("HEARTBEAT.md");
            if heartbeat_path.exists() {
                if let Ok(meta) = std::fs::metadata(&heartbeat_path) {
                    if let Ok(modified) = meta.modified() {
                        let age = std::time::SystemTime::now()
                            .duration_since(modified)
                            .unwrap_or_default();
                        if age > std::time::Duration::from_secs(300) {
                            tracing::warn!(
                                age_secs = age.as_secs(),
                                "health-check: heartbeat is stale (> 5min old)"
                            );
                        }
                    }
                }
            }
            Ok(())
        }

        "browser-health" => {
            // Ping http://127.0.0.1:19200/health, log if browser server is down
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()?;
            match client.get("http://127.0.0.1:19200/health").send().await {
                Ok(resp) if resp.status().is_success() => {
                    tracing::debug!("browser-health: browser server is up");
                }
                Ok(resp) => {
                    tracing::warn!(
                        status = %resp.status(),
                        "browser-health: browser server returned non-200"
                    );
                }
                Err(e) => {
                    tracing::debug!(error = %e, "browser-health: browser server is down (expected if not running)");
                }
            }
            Ok(())
        }

        // ── Every 15 minutes ────────────────────────────────────

        "news-pulse" => {
            // Fetch RSS feeds and write summary
            let sys_dir = vault_path.join("_system");
            ensure_dir(&sys_dir);
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()?;

            let feeds = [
                ("Hacker News", "https://hnrss.org/frontpage?count=10"),
                ("TechCrunch", "https://techcrunch.com/feed/"),
                ("The Guardian Tech", "https://www.theguardian.com/technology/rss"),
            ];

            let now = chrono::Utc::now().to_rfc3339();
            let mut md = format!(
                "---\nupdated_at: {now}\n---\n\n# News Pulse\n\nUpdated: {now}\n\n"
            );

            for (name, url) in &feeds {
                md.push_str(&format!("## {name}\n\n"));
                match client.get(*url).send().await {
                    Ok(resp) => {
                        if let Ok(body) = resp.text().await {
                            // Simple XML title extraction (no full XML parser needed)
                            let mut count = 0;
                            for item_chunk in body.split("<item") {
                                if count == 0 {
                                    count += 1; // skip first chunk (before first <item>)
                                    continue;
                                }
                                if count > 10 { break; }
                                // Extract <title>
                                if let Some(title_start) = item_chunk.find("<title>") {
                                    if let Some(title_end) = item_chunk[title_start..].find("</title>") {
                                        let title = &item_chunk[title_start + 7..title_start + title_end];
                                        let title = title.replace("<![CDATA[", "").replace("]]>", "");
                                        // Extract <link>
                                        let link = if let Some(ls) = item_chunk.find("<link>") {
                                            if let Some(le) = item_chunk[ls..].find("</link>") {
                                                item_chunk[ls + 6..ls + le].trim().to_string()
                                            } else { String::new() }
                                        } else { String::new() };
                                        if !link.is_empty() {
                                            md.push_str(&format!("- [{}]({})\n", title.trim(), link.trim()));
                                        } else {
                                            md.push_str(&format!("- {}\n", title.trim()));
                                        }
                                    }
                                }
                                count += 1;
                            }
                            if count <= 1 {
                                md.push_str("- *(no items parsed)*\n");
                            }
                        }
                    }
                    Err(e) => {
                        md.push_str(&format!("- *fetch error: {e}*\n"));
                    }
                }
                md.push('\n');
            }

            std::fs::write(sys_dir.join("NEWS-PULSE.md"), md)?;
            info!("news-pulse: updated NEWS-PULSE.md");
            Ok(())
        }

        // ── Every 30 minutes ────────────────────────────────────

        "memory-consolidation" => {
            // Load unconsolidated memories, call Ollama if available
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()?;
            match client.get("http://127.0.0.1:11434/api/tags").send().await {
                Ok(resp) if resp.status().is_success() => {
                    info!("memory-consolidation: Ollama is available, consolidation would run here");
                    // TODO: load unconsolidated memories from DB, cluster, synthesize
                }
                _ => {
                    tracing::debug!("memory-consolidation: Ollama not available, skipping silently");
                }
            }
            Ok(())
        }

        "embeddings" => {
            // Find notes with embeddingStatus: pending, generate embeddings
            let notebooks_dir = vault_path.join("Notebooks");
            if notebooks_dir.exists() {
                // Get already-embedded paths from DB
                let embedded_paths: Vec<String> = db.with_conn(|conn| {
                    hq_db::search::get_embedded_note_paths(conn)
                }).unwrap_or_default();

                // Walk notebooks for unembedded .md files (batch of 10)
                let mut pending = Vec::new();
                if let Ok(entries) = std::fs::read_dir(&notebooks_dir) {
                    fn walk_dir(dir: &Path, embedded: &[String], pending: &mut Vec<std::path::PathBuf>, limit: usize) {
                        if pending.len() >= limit { return; }
                        if let Ok(entries) = std::fs::read_dir(dir) {
                            for entry in entries.flatten() {
                                if pending.len() >= limit { return; }
                                let path = entry.path();
                                if path.is_dir() {
                                    walk_dir(&path, embedded, pending, limit);
                                } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                                    let path_str = path.to_string_lossy().to_string();
                                    if !embedded.contains(&path_str) {
                                        pending.push(path);
                                    }
                                }
                            }
                        }
                    }
                    let _ = entries; // consumed by walk
                    walk_dir(&notebooks_dir, &embedded_paths, &mut pending, 10);
                }

                if !pending.is_empty() {
                    info!(count = pending.len(), "embeddings: found notes needing embeddings");
                    // TODO: generate embeddings via API and store with hq_db::search::store_embedding
                }
            }
            Ok(())
        }

        "hq-inbox-scan" => {
            // Scan _jobs/pending/ for jobs, log count
            let pending_dir = vault_path.join("_jobs").join("pending");
            if pending_dir.exists() {
                let count = std::fs::read_dir(&pending_dir)
                    .map(|entries| entries.count())
                    .unwrap_or(0);
                if count > 0 {
                    info!(count, "hq-inbox-scan: pending jobs in inbox");
                } else {
                    tracing::debug!("hq-inbox-scan: inbox empty");
                }
            }
            Ok(())
        }

        // ── Every 1 hour ────────────────────────────────────────

        "budget-reset" => {
            // On 1st of month only: reset monthly budget counters
            let today = chrono::Utc::now();
            if today.day() == 1 && !has_run_today(vault_path, "budget-reset") {
                let usage_dir = vault_path.join("_usage");
                ensure_dir(&usage_dir);
                let now = today.to_rfc3339();
                let content = format!(
                    "---\nreset_at: {now}\nmonth: {}\nmonthly_spend: 0.0\nmonthly_limit: 50.0\n---\n\n# Budget\n\nMonthly budget reset on {now}\n",
                    today.format("%Y-%m")
                );
                std::fs::write(usage_dir.join("budget.md"), content)?;
                mark_run_today(vault_path, "budget-reset");
                info!("budget-reset: monthly budget counters reset");
            }
            Ok(())
        }

        "stale-cleanup" => {
            // Move jobs in _jobs/running/ older than 7 days to _jobs/failed/
            let running_dir = vault_path.join("_jobs").join("running");
            let failed_dir = vault_path.join("_jobs").join("failed");
            if running_dir.exists() {
                ensure_dir(&failed_dir);
                let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 86400);
                if let Ok(entries) = std::fs::read_dir(&running_dir) {
                    for entry in entries.flatten() {
                        if let Ok(meta) = entry.metadata() {
                            if let Ok(modified) = meta.modified() {
                                if modified < cutoff {
                                    let dest = failed_dir.join(entry.file_name());
                                    let _ = std::fs::rename(entry.path(), &dest);
                                    info!(job = ?entry.file_name(), "stale-cleanup: moved stale job to failed/");
                                }
                            }
                        }
                    }
                }
            }
            Ok(())
        }

        "delegation-cleanup" => {
            // Clean up _delegation/completed/ older than 3 days
            let completed_dir = vault_path.join("_delegation").join("completed");
            if completed_dir.exists() {
                let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 86400);
                let mut removed = 0u32;
                if let Ok(entries) = std::fs::read_dir(&completed_dir) {
                    for entry in entries.flatten() {
                        if let Ok(meta) = entry.metadata() {
                            if let Ok(modified) = meta.modified() {
                                if modified < cutoff {
                                    let _ = std::fs::remove_file(entry.path());
                                    removed += 1;
                                }
                            }
                        }
                    }
                }
                if removed > 0 {
                    info!(count = removed, "delegation-cleanup: removed old delegation files");
                }
            }
            Ok(())
        }

        "daily-brief" => {
            // At 8 PM EAT (20:00 EAT = 17:00 UTC): generate end-of-day summary
            let hour = current_eat_hour();
            if hour == 20 && !has_run_today(vault_path, "daily-brief") {
                let now = chrono::Utc::now().to_rfc3339();
                let today_str = chrono::Utc::now().format("%Y-%m-%d").to_string();
                let sys_dir = vault_path.join("_system");
                ensure_dir(&sys_dir);

                // Count today's completed jobs
                let completed_dir = vault_path.join("_jobs").join("completed");
                let completed_count = if completed_dir.exists() {
                    std::fs::read_dir(&completed_dir)
                        .map(|entries| {
                            entries.flatten().filter(|e| {
                                e.metadata().ok()
                                    .and_then(|m| m.modified().ok())
                                    .map(|t| {
                                        let dt: chrono::DateTime<chrono::Utc> = t.into();
                                        dt.format("%Y-%m-%d").to_string() == today_str
                                    })
                                    .unwrap_or(false)
                            }).count()
                        })
                        .unwrap_or(0)
                } else { 0 };

                let content = format!(
                    "---\ntype: daily-brief\ndate: {today_str}\ngenerated_at: {now}\n---\n\n# Daily Brief — {today_str}\n\n## Summary\n\n- **Completed jobs**: {completed_count}\n- **Generated at**: {now}\n\n## Activity\n\nEnd-of-day summary generated by daemon.\n"
                );
                let briefs_dir = vault_path.join("_system").join("briefs");
                ensure_dir(&briefs_dir);
                std::fs::write(briefs_dir.join(format!("daily-brief-{today_str}.md")), content)?;
                mark_run_today(vault_path, "daily-brief");
                info!("daily-brief: generated end-of-day summary");
            }
            Ok(())
        }

        "morning-brief-audio" => {
            // At 6 AM EAT (3 AM UTC): if MORNING_BRIEF_ENABLED, generate audio
            let hour = current_eat_hour();
            if hour == 6 && !has_run_today(vault_path, "morning-brief-audio") {
                if std::env::var("MORNING_BRIEF_ENABLED").unwrap_or_default() == "true" {
                    info!("morning-brief-audio: would generate audio brief via kokoro-tts or say");
                    // Check if kokoro-tts is available
                    let has_kokoro = std::process::Command::new("which")
                        .arg("kokoro-tts")
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false);
                    if has_kokoro {
                        info!("morning-brief-audio: kokoro-tts available, audio generation placeholder");
                    } else {
                        tracing::debug!("morning-brief-audio: kokoro-tts not found, would fall back to say");
                    }
                    mark_run_today(vault_path, "morning-brief-audio");
                }
            }
            Ok(())
        }

        "morning-brief-notebooklm" => {
            // At 6:30 AM EAT (3:30 AM UTC): stub for NotebookLM integration
            let hour = current_eat_hour();
            let minute = current_eat_minute();
            if hour == 6 && minute >= 30 && !has_run_today(vault_path, "morning-brief-notebooklm") {
                if std::env::var("MORNING_BRIEF_ENABLED").unwrap_or_default() == "true" {
                    info!("morning-brief-notebooklm: NotebookLM integration stub");
                    mark_run_today(vault_path, "morning-brief-notebooklm");
                }
            }
            Ok(())
        }

        "hq-morning-brief" => {
            // At 7 AM EAT (4 AM UTC): generate markdown morning brief
            let hour = current_eat_hour();
            if hour == 7 && !has_run_today(vault_path, "hq-morning-brief") {
                let now = chrono::Utc::now().to_rfc3339();
                let today_str = chrono::Utc::now().format("%Y-%m-%d").to_string();

                // Count pending jobs
                let pending_count = vault_path.join("_jobs").join("pending")
                    .read_dir().map(|e| e.count()).unwrap_or(0);

                let content = format!(
                    "---\ntype: morning-brief\ndate: {today_str}\ngenerated_at: {now}\n---\n\n# Morning Brief — {today_str}\n\n## Pending Tasks\n\n- **Pending jobs**: {pending_count}\n\n## Agenda\n\n*Check calendar for today's events.*\n\n## Recent Activity\n\n*Review DAEMON-STATUS.md for overnight activity.*\n"
                );
                let briefs_dir = vault_path.join("_system").join("briefs");
                ensure_dir(&briefs_dir);
                std::fs::write(briefs_dir.join(format!("morning-brief-{today_str}.md")), content)?;
                mark_run_today(vault_path, "hq-morning-brief");
                info!("hq-morning-brief: generated morning brief");
            }
            Ok(())
        }

        "model-intelligence" => {
            // Check OpenRouter /api/v1/models for new models, pricing changes
            if let Some(ref api_key) = config.openrouter_api_key {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(15))
                    .build()?;
                match client
                    .get("https://openrouter.ai/api/v1/models")
                    .header("Authorization", format!("Bearer {api_key}"))
                    .send()
                    .await
                {
                    Ok(resp) if resp.status().is_success() => {
                        if let Ok(body) = resp.text().await {
                            let model_count = body.matches("\"id\"").count();
                            let sys_dir = vault_path.join("_system");
                            ensure_dir(&sys_dir);
                            let now = chrono::Utc::now().to_rfc3339();
                            let content = format!(
                                "---\nupdated_at: {now}\nmodel_count: {model_count}\n---\n\n# Model Intelligence\n\nLast checked: {now}  \nModels available: {model_count}\n"
                            );
                            let _ = std::fs::write(sys_dir.join("MODEL-INTELLIGENCE.md"), content);
                            tracing::debug!(model_count, "model-intelligence: checked OpenRouter models");
                        }
                    }
                    Ok(resp) => {
                        tracing::debug!(status = %resp.status(), "model-intelligence: OpenRouter returned non-200");
                    }
                    Err(e) => {
                        tracing::debug!(error = %e, "model-intelligence: failed to reach OpenRouter");
                    }
                }
            } else {
                tracing::debug!("model-intelligence: no OpenRouter API key configured");
            }
            Ok(())
        }

        "sblu-retraining" => {
            // At 3 AM EAT (midnight UTC): placeholder for retraining
            let hour = current_eat_hour();
            if hour == 3 && !has_run_today(vault_path, "sblu-retraining") {
                info!("sblu-retraining: retraining placeholder (would run SBLU model retraining)");
                mark_run_today(vault_path, "sblu-retraining");
            }
            Ok(())
        }

        "plan-extraction" => {
            // Extract knowledge from completed plans
            let completed_dir = vault_path.join("_plans").join("completed");
            if completed_dir.exists() {
                let knowledge_dir = vault_path.join("_plans").join("knowledge");
                ensure_dir(&knowledge_dir);
                if let Ok(entries) = std::fs::read_dir(&completed_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().map(|e| e == "md").unwrap_or(false) {
                            // Check if knowledge already extracted (flag file)
                            let flag = knowledge_dir.join(format!(".extracted-{}", entry.file_name().to_string_lossy()));
                            if !flag.exists() {
                                tracing::debug!(plan = ?entry.file_name(), "plan-extraction: would extract knowledge from completed plan");
                                let _ = std::fs::write(&flag, "extracted");
                            }
                        }
                    }
                }
            }
            Ok(())
        }

        "plan-archival" => {
            // Archive completed plans older than 30 days
            let completed_dir = vault_path.join("_plans").join("completed");
            if completed_dir.exists() {
                let archive_dir = vault_path.join("_plans").join("archive");
                ensure_dir(&archive_dir);
                let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86400);
                if let Ok(entries) = std::fs::read_dir(&completed_dir) {
                    for entry in entries.flatten() {
                        if let Ok(meta) = entry.metadata() {
                            if let Ok(modified) = meta.modified() {
                                if modified < cutoff {
                                    let dest = archive_dir.join(entry.file_name());
                                    let _ = std::fs::rename(entry.path(), &dest);
                                    info!(plan = ?entry.file_name(), "plan-archival: archived old completed plan");
                                }
                            }
                        }
                    }
                }
            }
            Ok(())
        }

        // ── Every 6 hours ───────────────────────────────────────

        "vault-health" => {
            // Full vault integrity check
            let sys_dir = vault_path.join("_system");
            ensure_dir(&sys_dir);

            let notebooks_dir = vault_path.join("Notebooks");
            let mut total_notes = 0u32;
            let mut broken_frontmatter = 0u32;

            fn count_notes(dir: &Path, total: &mut u32, broken: &mut u32) {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            count_notes(&path, total, broken);
                        } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                            *total += 1;
                            // Quick frontmatter check
                            if let Ok(content) = std::fs::read_to_string(&path) {
                                let trimmed = content.trim();
                                if trimmed.starts_with("---") {
                                    if trimmed[3..].find("---").is_none() {
                                        *broken += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if notebooks_dir.exists() {
                count_notes(&notebooks_dir, &mut total_notes, &mut broken_frontmatter);
            }

            // DB stats
            let db_stats = db.with_conn(|conn| {
                hq_db::search::get_stats(conn)
            });
            let indexed = db_stats
                .as_ref()
                .map(|s| s.fts_count)
                .unwrap_or(0);
            let embedded = db_stats
                .as_ref()
                .map(|s| s.embedding_count)
                .unwrap_or(0);

            let now = chrono::Utc::now().to_rfc3339();
            let content = format!(
                "---\nchecked_at: {now}\ntotal_notes: {total_notes}\nbroken_frontmatter: {broken_frontmatter}\nindexed: {indexed}\nembedded: {embedded}\n---\n\n# Vault Health\n\nLast check: {now}\n\n- **Total notes**: {total_notes}\n- **Broken frontmatter**: {broken_frontmatter}\n- **Indexed (FTS5)**: {indexed}\n- **Embedded**: {embedded}\n"
            );
            std::fs::write(sys_dir.join("VAULT-HEALTH.md"), content)?;
            info!(total_notes, broken_frontmatter, indexed, embedded, "vault-health: integrity check complete");
            Ok(())
        }

        "stale-thread-detector" => {
            // Find threads older than 7 days with no activity, archive them
            let threads_dir = vault_path.join("_threads");
            if threads_dir.exists() {
                let archive_dir = vault_path.join("_threads").join("_archive");
                ensure_dir(&archive_dir);
                let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 86400);
                let mut archived = 0u32;
                if let Ok(entries) = std::fs::read_dir(&threads_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() && path.extension().map(|e| e == "md").unwrap_or(false) {
                            if let Ok(meta) = entry.metadata() {
                                if let Ok(modified) = meta.modified() {
                                    if modified < cutoff {
                                        let dest = archive_dir.join(entry.file_name());
                                        let _ = std::fs::rename(&path, &dest);
                                        archived += 1;
                                    }
                                }
                            }
                        }
                    }
                }
                if archived > 0 {
                    info!(count = archived, "stale-thread-detector: archived stale threads");
                }
            }
            Ok(())
        }

        // ── Every 24 hours ──────────────────────────────────────

        "memory-forgetting" => {
            // Prune weak memories below importance threshold, decay old memories
            if !has_run_today(vault_path, "memory-forgetting") {
                info!("memory-forgetting: would prune weak memories and decay old ones");
                // TODO: implement actual memory decay via hq-memory crate
                mark_run_today(vault_path, "memory-forgetting");
            }
            Ok(())
        }

        // ── Weekly ──────────────────────────────────────────────

        "team-optimizer" => {
            // Analyze team workflow results, suggest improvements (run on Mondays)
            let today = chrono::Utc::now();
            // Monday = 0 in weekday().num_days_from_monday()
            if today.weekday().num_days_from_monday() == 0
                && !has_run_today(vault_path, "team-optimizer")
            {
                info!("team-optimizer: would analyze team workflow and suggest improvements");
                mark_run_today(vault_path, "team-optimizer");
            }
            Ok(())
        }

        // ── Touchpoints (hourly, self-gated) ────────────────────

        "daily-synthesis" => {
            // At 8:30-10 PM EAT: synthesize the day's work
            let hour = current_eat_hour();
            let minute = current_eat_minute();
            if (hour == 20 && minute >= 30) || hour == 21 {
                if !has_run_today(vault_path, "daily-synthesis") {
                    let today_str = chrono::Utc::now().format("%Y-%m-%d").to_string();
                    let now = chrono::Utc::now().to_rfc3339();
                    let sys_dir = vault_path.join("_system").join("briefs");
                    ensure_dir(&sys_dir);
                    let content = format!(
                        "---\ntype: daily-synthesis\ndate: {today_str}\ngenerated_at: {now}\n---\n\n# Daily Synthesis — {today_str}\n\nSynthesis of today's work generated by daemon.\n\n*Review completed jobs, created notes, and system activity for detailed insights.*\n"
                    );
                    std::fs::write(sys_dir.join(format!("daily-synthesis-{today_str}.md")), content)?;
                    mark_run_today(vault_path, "daily-synthesis");
                    info!("daily-synthesis: generated daily synthesis");
                }
            }
            Ok(())
        }

        // ── Event-driven (via periodic scan) ────────────────────

        "embedding-on-change" => {
            // When a note is created/modified recently, mark for embedding
            // We scan Notebooks/ for files modified in the last 2 minutes
            let notebooks_dir = vault_path.join("Notebooks");
            if notebooks_dir.exists() {
                let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
                let mut newly_modified = 0u32;

                fn scan_recent(dir: &Path, cutoff: std::time::SystemTime, count: &mut u32) {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.is_dir() {
                                scan_recent(&path, cutoff, count);
                            } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                                if let Ok(meta) = entry.metadata() {
                                    if let Ok(modified) = meta.modified() {
                                        if modified > cutoff {
                                            *count += 1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                scan_recent(&notebooks_dir, cutoff, &mut newly_modified);
                if newly_modified > 0 {
                    tracing::debug!(count = newly_modified, "embedding-on-change: recently modified notes detected (will be picked up by embeddings task)");
                }
            }
            Ok(())
        }

        // ── Claude Code cron runner ─────────────────────────────

        "claude-cron-runner" => {
            // Scan ~/.claude/scheduled-tasks/ for SKILL.md files with cron expressions
            let home = dirs::home_dir().unwrap_or_default();
            let tasks_dir = home.join(".claude").join("scheduled-tasks");
            if tasks_dir.exists() {
                let now_eat_hour = current_eat_hour();
                let now_eat_minute = current_eat_minute();

                if let Ok(entries) = std::fs::read_dir(&tasks_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().map(|e| e == "md").unwrap_or(false) {
                            if let Ok(content) = std::fs::read_to_string(&path) {
                                // Look for schedule: field in frontmatter
                                let trimmed = content.trim();
                                if trimmed.starts_with("---") {
                                    if let Some(end_idx) = trimmed[3..].find("---") {
                                        let frontmatter = &trimmed[3..3 + end_idx];
                                        // Simple schedule parsing: "schedule: HH:MM" or "schedule: */N * * * *"
                                        for line in frontmatter.lines() {
                                            let line = line.trim();
                                            if line.starts_with("schedule:") {
                                                let schedule = line["schedule:".len()..].trim().trim_matches('"').trim_matches('\'');
                                                // Simple HH:MM matching
                                                if let Some((h, m)) = schedule.split_once(':') {
                                                    if let (Ok(sh), Ok(sm)) = (h.trim().parse::<u32>(), m.trim().parse::<u32>()) {
                                                        if sh == now_eat_hour && sm == now_eat_minute {
                                                            let task_name = path.file_stem()
                                                                .map(|s| s.to_string_lossy().to_string())
                                                                .unwrap_or_default();
                                                            if !has_run_today(vault_path, &format!("claude-cron-{task_name}")) {
                                                                let body = trimmed[3 + end_idx + 3..].trim();
                                                                if !body.is_empty() {
                                                                    info!(task = %task_name, "claude-cron-runner: firing scheduled task");
                                                                    // Spawn claude -p in background
                                                                    let body_owned = body.to_string();
                                                                    tokio::spawn(async move {
                                                                        let _ = tokio::process::Command::new("claude")
                                                                            .args(["-p", &body_owned])
                                                                            .stdout(std::process::Stdio::null())
                                                                            .stderr(std::process::Stdio::null())
                                                                            .stdin(std::process::Stdio::null())
                                                                            .spawn();
                                                                    });
                                                                    mark_run_today(vault_path, &format!("claude-cron-{task_name}"));
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                                // Simple cron: */N * * * * (every N minutes)
                                                else if schedule.starts_with("*/") {
                                                    let parts: Vec<&str> = schedule.split_whitespace().collect();
                                                    if let Some(interval_str) = parts.first() {
                                                        if let Ok(interval) = interval_str[2..].parse::<u32>() {
                                                            if interval > 0 && now_eat_minute % interval == 0 {
                                                                let task_name = path.file_stem()
                                                                    .map(|s| s.to_string_lossy().to_string())
                                                                    .unwrap_or_default();
                                                                let flag = format!("claude-cron-{task_name}-{now_eat_hour}-{now_eat_minute}");
                                                                if !has_run_today(vault_path, &flag) {
                                                                    let body = trimmed[3 + end_idx + 3..].trim();
                                                                    if !body.is_empty() {
                                                                        info!(task = %task_name, "claude-cron-runner: firing cron task");
                                                                        let body_owned = body.to_string();
                                                                        tokio::spawn(async move {
                                                                            let _ = tokio::process::Command::new("claude")
                                                                                .args(["-p", &body_owned])
                                                                                .stdout(std::process::Stdio::null())
                                                                                .stderr(std::process::Stdio::null())
                                                                                .stdin(std::process::Stdio::null())
                                                                                .spawn();
                                                                        });
                                                                        mark_run_today(vault_path, &flag);
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(())
        }

        unknown => {
            tracing::warn!(task = unknown, "daemon: unknown task");
            Ok(())
        }
    }
}

async fn run_daemon(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    db: Arc<Database>,
) -> Result<()> {
    use std::time::Duration;

    let vault_path = vault.vault_path().to_path_buf();
    let started_at = chrono::Utc::now().to_rfc3339();

    // Ensure system directories exist
    ensure_dir(&vault_path.join("_system"));
    ensure_dir(&vault_path.join("_jobs").join("pending"));
    ensure_dir(&vault_path.join("_jobs").join("running"));
    ensure_dir(&vault_path.join("_jobs").join("completed"));
    ensure_dir(&vault_path.join("_jobs").join("failed"));

    // Define all 27 tasks with their intervals
    let mut tasks = vec![
        // Every 1 minute
        DaemonTask::new("expire-approvals", Duration::from_secs(60)),
        DaemonTask::new("plan-sync", Duration::from_secs(60)),
        // Every 5 minutes
        DaemonTask::new("heartbeat", Duration::from_secs(300)),
        DaemonTask::new("health-check", Duration::from_secs(300)),
        DaemonTask::new("browser-health", Duration::from_secs(300)),
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
        DaemonTask::new("sblu-retraining", Duration::from_secs(3600)),
        DaemonTask::new("plan-extraction", Duration::from_secs(600)), // every 10 min as noted
        DaemonTask::new("plan-archival", Duration::from_secs(3600)),
        // Every 6 hours
        DaemonTask::new("vault-health", Duration::from_secs(21600)),
        DaemonTask::new("stale-thread-detector", Duration::from_secs(21600)),
        // Every 24 hours
        DaemonTask::new("memory-forgetting", Duration::from_secs(86400)),
        // Weekly (check hourly, self-gated to Mondays)
        DaemonTask::new("team-optimizer", Duration::from_secs(3600)),
        // Touchpoints (hourly check, self-gated by time)
        DaemonTask::new("daily-synthesis", Duration::from_secs(3600)),
        // Event-driven (scan every 1 minute)
        DaemonTask::new("embedding-on-change", Duration::from_secs(60)),
        // Claude Code cron runner (every 1 minute)
        DaemonTask::new("claude-cron-runner", Duration::from_secs(60)),
    ];

    // Write initial cron schedule
    write_cron_schedule(&vault_path, &tasks);

    // Write initial status
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
                match run_daemon_task(task.name, &vault_path, &db, config).await {
                    Ok(()) => {
                        task.run_count += 1;
                    }
                    Err(e) => {
                        task.error_count += 1;
                        let err_msg = format!("{e:#}");
                        tracing::warn!(task = task.name, error = %err_msg, "daemon: task error");
                        task.last_error = Some(err_msg);
                    }
                }
            }
        }

        // Update status file on every tick
        write_daemon_status(&vault_path, &tasks, &started_at);
    }
}

async fn run_agent_worker(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    _db: Arc<Database>,
) -> Result<()> {
    let agent_name = &config.agent.name;
    info!(agent = %agent_name, "agent: polling for jobs");

    let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        interval.tick().await;

        // Poll for pending jobs
        let pending = vault.list_pending_jobs().unwrap_or_default();
        if pending.is_empty() {
            continue;
        }

        info!(count = pending.len(), "agent: found pending jobs");

        for job_id in &pending {
            // Try to claim
            match vault.claim_job(job_id, agent_name) {
                Ok(Some(job)) => {
                    info!(job_id = %job.id, instruction = %job.instruction.chars().take(80).collect::<String>(), "agent: claimed job");

                    // For now, mark as done with a placeholder
                    // TODO: wire up AgentSession with LLM provider
                    let result = format!(
                        "Job received by Rust agent worker ({}). \
                         LLM session execution pending implementation. \
                         Instruction: {}",
                        agent_name,
                        job.instruction.chars().take(200).collect::<String>()
                    );
                    let _ = vault.complete_job(&job.id, &result);
                    info!(job_id = %job.id, "agent: completed job (stub)");
                }
                Ok(None) => {
                    // Job was claimed by another worker
                }
                Err(e) => {
                    tracing::warn!(job_id = %job_id, error = %e, "agent: failed to claim job");
                }
            }
        }
    }
}

// ─── Model alias resolution ────────────────────────────────────

fn resolve_model_alias(name: &str) -> String {
    match name.to_lowercase().as_str() {
        "sonnet" => "anthropic/claude-sonnet-4".to_string(),
        "opus" => "anthropic/claude-opus-4".to_string(),
        "haiku" => "anthropic/claude-haiku-4-5".to_string(),
        "gemini" | "flash" => "google/gemini-2.5-flash".to_string(),
        "gemini-pro" => "google/gemini-2.5-pro".to_string(),
        "gpt4" => "openai/gpt-4.1".to_string(),
        "kimi" | "k2.5" => "moonshotai/kimi-k2.5".to_string(),
        other => other.to_string(),
    }
}

fn load_system_prompt(vault: &VaultClient) -> String {
    let soul_path = vault.vault_path().join("_system").join("SOUL.md");
    if soul_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&soul_path) {
            // Strip frontmatter if present
            let trimmed = content.trim();
            if trimmed.starts_with("---") {
                if let Some(end) = trimmed[3..].find("---") {
                    let after = &trimmed[3 + end + 3..];
                    let body = after.trim();
                    if !body.is_empty() {
                        return body.to_string();
                    }
                }
            }
            if !content.trim().is_empty() {
                return content.trim().to_string();
            }
        }
    }
    "You are HQ, a helpful AI assistant. Be concise and direct.".to_string()
}

fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut remaining = text;
    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }
        // Try to split at paragraph, then newline, then space
        let search = &remaining[..max_len];
        let split_at = search.rfind("\n\n")
            .or_else(|| search.rfind('\n'))
            .or_else(|| search.rfind(' '))
            .unwrap_or(max_len);
        chunks.push(remaining[..split_at].to_string());
        remaining = remaining[split_at..].trim_start();
    }
    chunks
}

// ─── Harness helpers ───────────────────────────────────────────

/// HQ harness cheap model fallback chain.
const HQ_MODELS: &[&str] = &[
    "moonshotai/kimi-k2.5",
    "google/gemini-2.5-flash-lite",
    "minimax/minimax-m2.7",
];

/// Valid harness names for user-facing commands.
const VALID_HARNESSES: &[&str] = &[
    "hq", "claude-code", "claude", "opencode", "gemini-cli", "gemini",
    "codex-cli", "codex", "qwen-code", "qwen", "kilo-code", "kilo",
    "mistral-vibe", "vibe",
];

/// Canonical harness name (normalize aliases).
fn canonical_harness(name: &str) -> &'static str {
    match name {
        "claude" | "claude-code" => "claude-code",
        "opencode" => "opencode",
        "gemini" | "gemini-cli" => "gemini-cli",
        "codex" | "codex-cli" => "codex-cli",
        "qwen" | "qwen-code" => "qwen-code",
        "kilo" | "kilo-code" => "kilo-code",
        "vibe" | "mistral-vibe" => "mistral-vibe",
        _ => "hq",
    }
}

/// Display name for a harness (for status messages).
fn harness_display(harness: &str) -> String {
    match harness {
        "claude-code" => "claude-code (Claude CLI)".to_string(),
        "opencode" => "opencode (OpenCode CLI)".to_string(),
        "gemini-cli" => "gemini-cli (Gemini CLI)".to_string(),
        "codex-cli" => "codex-cli (Codex CLI)".to_string(),
        "qwen-code" => "qwen-code (Qwen CLI)".to_string(),
        "kilo-code" => "kilo-code (Kilo CLI)".to_string(),
        "mistral-vibe" => "mistral-vibe (Vibe CLI)".to_string(),
        "hq" => format!("hq (OpenRouter: {})", HQ_MODELS[0]),
        other => other.to_string(),
    }
}

/// Channel state with harness routing and per-harness session IDs.
#[derive(Clone)]
struct ChannelState {
    /// Chat history (only used by HQ harness for OpenRouter context).
    messages: Vec<hq_core::types::ChatMessage>,
    /// Active harness name.
    harness: String,
    /// Model override (only relevant for HQ harness).
    model_override: Option<String>,
    /// Per-harness session IDs for resume capability.
    session_ids: std::collections::HashMap<String, String>,
}

impl ChannelState {
    fn new_default() -> Self {
        Self {
            messages: vec![],
            harness: "claude-code".to_string(),
            model_override: None,
            session_ids: std::collections::HashMap::new(),
        }
    }
}

/// Extract text from an NDJSON line emitted by CLI harnesses.
///
/// Claude Code format: `{"type":"assistant","content":[{"type":"text","text":"..."}]}`
/// Also handles: `{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}`
/// And simpler: `{"text":"..."}` or `{"content":"..."}`
fn extract_text_from_ndjson(json: &serde_json::Value) -> Option<String> {
    let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

    // Claude Code: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
    // The content array is nested under "message"
    if msg_type == "assistant" {
        // Try message.content[] (Claude Code stream-json format)
        if let Some(msg) = json.get("message") {
            if let Some(content) = msg.get("content").and_then(|v| v.as_array()) {
                let mut text = String::new();
                for block in content {
                    if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                            text.push_str(t);
                        }
                    }
                }
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
        // Also try direct content[] (older format)
        if let Some(content) = json.get("content").and_then(|v| v.as_array()) {
            let mut text = String::new();
            for block in content {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                    }
                }
            }
            if !text.is_empty() {
                return Some(text);
            }
        }
    }

    // Claude Code result: {"type":"result","result":"..."}
    if msg_type == "result" {
        if let Some(t) = json.get("result").and_then(|v| v.as_str()) {
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }

    // Content block delta: {"type":"content_block_delta","delta":{"text":"..."}}
    if msg_type == "content_block_delta" {
        if let Some(delta) = json.get("delta") {
            if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                return Some(t.to_string());
            }
        }
    }

    // Codex: {"type":"message","content":"..."} or {"type":"item.completed",...}
    if msg_type == "message" {
        if let Some(t) = json.get("content").and_then(|v| v.as_str()) {
            return Some(t.to_string());
        }
    }

    // Simple text field
    if let Some(t) = json.get("text").and_then(|v| v.as_str()) {
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }

    None
}

/// Build CLI command args for a given harness.
///
/// Returns (program, args, supports_resume).
fn build_harness_command(
    harness: &str,
    prompt: &str,
    session_id: Option<&str>,
) -> (String, Vec<String>, bool) {
    match harness {
        "claude-code" => {
            let mut args = vec![
                "--dangerously-skip-permissions".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--max-turns".to_string(),
                "100".to_string(),
                "--model".to_string(),
                "opus".to_string(),
            ];
            if let Some(sid) = session_id {
                args.push("--resume".to_string());
                args.push(sid.to_string());
            }
            args.push("-p".to_string());
            args.push(prompt.to_string());
            ("claude".to_string(), args, true)
        }
        "opencode" => {
            let mut args = vec![
                "--output-format".to_string(),
                "stream-json".to_string(),
            ];
            if let Some(sid) = session_id {
                args.push("--continue".to_string());
                args.push(sid.to_string());
            }
            args.push("-p".to_string());
            args.push(prompt.to_string());
            ("opencode".to_string(), args, true)
        }
        "gemini-cli" => {
            let args = vec!["-p".to_string(), prompt.to_string()];
            ("gemini".to_string(), args, false)
        }
        "codex-cli" => {
            if let Some(sid) = session_id {
                let args = vec![
                    "exec".to_string(),
                    "resume".to_string(),
                    sid.to_string(),
                    "--json".to_string(),
                    "--full-auto".to_string(),
                    "--color".to_string(),
                    "never".to_string(),
                ];
                ("codex".to_string(), args, true)
            } else {
                let args = vec![
                    "exec".to_string(),
                    "--json".to_string(),
                    "--full-auto".to_string(),
                    "--color".to_string(),
                    "never".to_string(),
                    "-p".to_string(),
                    prompt.to_string(),
                ];
                ("codex".to_string(), args, true)
            }
        }
        "qwen-code" => {
            let mut args = vec![
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--include-partial-messages".to_string(),
                "--yolo".to_string(),
            ];
            if let Some(sid) = session_id {
                args.push("--continue".to_string());
                args.push(sid.to_string());
            }
            args.push("-p".to_string());
            args.push(prompt.to_string());
            ("qwen".to_string(), args, true)
        }
        "kilo-code" => {
            let args = vec![
                "run".to_string(),
                "--format".to_string(),
                "json".to_string(),
                "--auto".to_string(),
                prompt.to_string(),
            ];
            ("kilo".to_string(), args, false)
        }
        "mistral-vibe" => {
            let args = vec![
                "--prompt".to_string(),
                prompt.to_string(),
                "--output".to_string(),
                "streaming".to_string(),
                "--max-turns".to_string(),
                "30".to_string(),
                "--max-price".to_string(),
                "0.50".to_string(),
            ];
            ("vibe".to_string(), args, false)
        }
        _ => {
            // Should not happen; fallback to claude-code
            build_harness_command("claude-code", prompt, session_id)
        }
    }
}

/// Run a CLI harness subprocess, reading NDJSON from stdout.
///
/// Calls `on_token` with accumulated text periodically.
/// Returns (final_text, optional_session_id).
async fn run_cli_harness(
    harness: &str,
    prompt: &str,
    session_id: Option<&str>,
) -> Result<(String, Option<String>)> {
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;
    use std::process::Stdio;

    let (program, args, _supports_resume) = build_harness_command(harness, prompt, session_id);

    tracing::info!(harness, program = %program, "spawning CLI harness");

    let mut child = Command::new(&program)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context(format!("failed to spawn `{program}` — is it installed and on PATH?"))?;

    let stdout = child.stdout.take().unwrap();
    let mut reader = tokio::io::BufReader::new(stdout).lines();

    let mut accumulated = String::new();
    let mut found_session_id: Option<String> = None;

    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        // Try to parse as JSON (NDJSON)
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
            let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

            // Skip "result" if we already have text from "assistant" — avoids duplicates
            if msg_type == "result" && !accumulated.is_empty() {
                // Still extract session_id from result
                if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                    found_session_id = Some(sid.to_string());
                }
                continue;
            }

            // Extract text
            if let Some(text) = extract_text_from_ndjson(&json) {
                accumulated.push_str(&text);
            }
            // Extract session_id for resume
            if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                found_session_id = Some(sid.to_string());
            }
        } else {
            // Not JSON — treat as plain text output (e.g., gemini-cli)
            if !accumulated.is_empty() {
                accumulated.push('\n');
            }
            accumulated.push_str(&line);
        }
    }

    // Wait for process to finish
    let status = child.wait().await?;
    if !status.success() {
        // Read stderr for error context
        // (stderr was already consumed by the process, but we can note the exit code)
        if accumulated.is_empty() {
            anyhow::bail!("`{program}` exited with status {status}");
        }
        // If we got partial output, return it with a warning
        tracing::warn!(harness, status = %status, "CLI harness exited with non-zero status but produced output");
    }

    Ok((accumulated, found_session_id))
}

/// Run a CLI harness with streaming — reads NDJSON line by line and calls
/// the callback with accumulated text as it grows. This variant can be used
/// for live streaming UX when the platform supports it.
///
/// Returns (final_text, optional_session_id).
#[allow(dead_code)]
async fn run_cli_harness_streaming<F>(
    harness: &str,
    prompt: &str,
    session_id: Option<&str>,
    mut on_progress: F,
) -> Result<(String, Option<String>)>
where
    F: FnMut(&str) + Send,
{
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;
    use std::process::Stdio;

    let (program, args, _supports_resume) = build_harness_command(harness, prompt, session_id);

    tracing::info!(harness, program = %program, "spawning CLI harness (streaming)");

    let mut child = Command::new(&program)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context(format!("failed to spawn `{program}` — is it installed and on PATH?"))?;

    let stdout = child.stdout.take().unwrap();
    let mut reader = tokio::io::BufReader::new(stdout).lines();

    let mut accumulated = String::new();
    let mut found_session_id: Option<String> = None;

    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        let mut got_new_text = false;

        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
            let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

            // Skip "result" if we already have text from "assistant"
            if msg_type == "result" && !accumulated.is_empty() {
                if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                    found_session_id = Some(sid.to_string());
                }
                continue;
            }

            if let Some(text) = extract_text_from_ndjson(&json) {
                accumulated.push_str(&text);
                got_new_text = true;
            }
            if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                found_session_id = Some(sid.to_string());
            }
        } else {
            // Plain text output
            if !accumulated.is_empty() {
                accumulated.push('\n');
            }
            accumulated.push_str(&line);
            got_new_text = true;
        }

        if got_new_text {
            on_progress(&accumulated);
        }
    }

    let status = child.wait().await?;
    if !status.success() && accumulated.is_empty() {
        anyhow::bail!("`{program}` exited with status {status}");
    }

    Ok((accumulated, found_session_id))
}

/// Run the HQ harness (OpenRouter with cheap models, with fallback chain).
async fn run_hq_harness_stream(
    api_key: &str,
    messages: Vec<hq_core::types::ChatMessage>,
    model_override: Option<&str>,
) -> Result<(String, bool)> {
    use futures::StreamExt as _;
    use hq_llm::LlmProvider as _;

    // Build model list: override first, then fallback chain
    let models: Vec<String> = if let Some(ovr) = model_override {
        let resolved = resolve_model_alias(ovr);
        let mut v = vec![resolved];
        for m in HQ_MODELS {
            let s = m.to_string();
            if !v.contains(&s) {
                v.push(s);
            }
        }
        v
    } else {
        HQ_MODELS.iter().map(|s| s.to_string()).collect()
    };

    let provider = hq_llm::openrouter::OpenRouterProvider::new(api_key);

    for (i, model) in models.iter().enumerate() {
        let request = hq_llm::ChatRequest {
            model: model.clone(),
            messages: messages.clone(),
            tools: vec![],
            temperature: Some(0.7),
            max_tokens: Some(4096),
        };

        match provider.chat_stream(&request).await {
            Ok(mut stream) => {
                let mut accumulated = String::new();
                let mut stream_done = false;

                while let Some(chunk_result) = stream.next().await {
                    match chunk_result {
                        Ok(hq_llm::StreamChunk::Text(text)) => {
                            accumulated.push_str(&text);
                        }
                        Ok(hq_llm::StreamChunk::Done) => {
                            stream_done = true;
                            break;
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::warn!(model = %model, error = %e, "HQ harness stream error, trying next model");
                            break;
                        }
                    }
                }

                if !accumulated.is_empty() || stream_done {
                    return Ok((accumulated, stream_done));
                }
            }
            Err(e) => {
                tracing::warn!(model = %model, attempt = i + 1, error = %e, "HQ harness model failed");
                continue;
            }
        }
    }

    anyhow::bail!("All HQ models failed. Tried: {}", models.join(", "))
}

// ─── Discord relay ─────────────────────────────────────────────

async fn run_discord_relay(
    token: &str,
    vault: Arc<VaultClient>,
    _db: Arc<Database>,
    api_key: String,
    model: String,
) -> Result<()> {
    use serenity::prelude::*;
    use serenity::model::prelude::*;
    use serenity::model::application::{Command, CommandOptionType, Interaction};
    use serenity::builder::{
        CreateCommand, CreateCommandOption, CreateMessage, EditMessage,
    };
    use serenity::async_trait;
    use std::collections::HashMap;
    use tokio::sync::Mutex as TokioMutex;

    struct Handler {
        api_key: String,
        #[allow(dead_code)]
        default_model: String,
        system_prompt: String,
        threads: Arc<TokioMutex<HashMap<u64, ChannelState>>>,
    }

    impl Handler {
        fn make_help_text() -> String {
            [
                "**HQ Bot Commands**",
                "",
                "`!reset` / `!new` — Clear conversation history and kill running harness",
                "`!harness <name>` / `!switch <name>` — Switch harness",
                "  Harnesses: `claude-code` (default), `hq`, `opencode`, `gemini-cli`, `codex-cli`, `qwen-code`, `kilo-code`, `mistral-vibe`",
                "`!model <name>` — Set model for HQ harness (sonnet/opus/haiku/gemini/flash/gpt4 or full ID)",
                "`!status` — Show current harness, model, session info",
                "`!help` — Show this help",
                "",
                "**Slash commands:** `/reset`, `/model`, `/harness`, `/status`, `/help`",
            ]
            .join("\n")
        }
    }

    #[async_trait]
    impl EventHandler for Handler {
        async fn message(&self, ctx: Context, msg: Message) {
            // 1. Ignore bot messages
            if msg.author.bot {
                return;
            }

            // 2. Respond to DMs and channel mentions
            let bot_id = ctx.cache.current_user().id;
            let is_mention = msg.mentions.iter().any(|u| u.id == bot_id);
            let is_dm = msg.guild_id.is_none();

            if !(is_mention || is_dm) {
                return;
            }

            // 3. Strip bot mention from content
            let raw_content = msg.content
                .replace(&format!("<@{}>", bot_id), "")
                .replace(&format!("<@!{}>", bot_id), "")
                .trim()
                .to_string();
            if raw_content.is_empty() {
                return;
            }

            // Include reply-to context so the LLM knows what the user is referencing
            let content = if let Some(ref referenced) = msg.referenced_message {
                let who = if referenced.author.bot { "assistant" } else { &referenced.author.name };
                let reply_text: String = referenced.content.chars().take(500).collect();
                format!("[Replying to {who}: \"{reply_text}\"]\n\n{raw_content}")
            } else {
                raw_content
            };

            let channel_key = msg.channel_id.get();

            // 4. Handle commands BEFORE calling LLM
            let content_lower = content.to_lowercase();

            // !reset / !new
            if content_lower == "!reset" || content_lower == "!new" {
                let mut threads = self.threads.lock().await;
                threads.remove(&channel_key);
                let _ = msg.channel_id.say(&ctx.http, "Conversation reset. Session cleared.").await;
                return;
            }

            // !harness <name> / !switch <name>
            if content_lower.starts_with("!harness ") || content_lower.starts_with("!switch ") {
                let name = content.split_whitespace().nth(1).unwrap_or("claude-code").to_string();
                let canonical = canonical_harness(&name.to_lowercase());
                if !VALID_HARNESSES.contains(&name.to_lowercase().as_str()) {
                    let _ = msg.channel_id.say(
                        &ctx.http,
                        &format!(
                            "Unknown harness `{name}`. Valid: {}",
                            VALID_HARNESSES.join(", ")
                        ),
                    ).await;
                    return;
                }
                let mut threads = self.threads.lock().await;
                let state = threads.entry(channel_key).or_insert_with(ChannelState::new_default);
                state.harness = canonical.to_string();
                let _ = msg.channel_id.say(
                    &ctx.http,
                    &format!("Harness set to: **{}**", harness_display(&state.harness)),
                ).await;
                return;
            }

            // !model <name>
            if content_lower.starts_with("!model ") {
                let name = content.split_whitespace().nth(1).unwrap_or("").to_string();
                if name.is_empty() {
                    let _ = msg.channel_id.say(&ctx.http, "Usage: `!model <name>`").await;
                    return;
                }
                let resolved = resolve_model_alias(&name);
                let mut threads = self.threads.lock().await;
                let state = threads.entry(channel_key).or_insert_with(ChannelState::new_default);
                state.model_override = Some(name.clone());
                let _ = msg.channel_id.say(
                    &ctx.http,
                    &format!("Model set to: `{resolved}` (applies to HQ harness)"),
                ).await;
                return;
            }

            // !help
            if content_lower == "!help" {
                let _ = msg.channel_id.say(&ctx.http, &Self::make_help_text()).await;
                return;
            }

            // !status
            if content_lower == "!status" {
                let threads = self.threads.lock().await;
                let state = threads.get(&channel_key);
                let harness = state.map(|s| s.harness.as_str()).unwrap_or("claude-code");
                let model_str = if harness == "hq" {
                    state
                        .and_then(|s| s.model_override.as_ref())
                        .map(|m| resolve_model_alias(m))
                        .unwrap_or_else(|| HQ_MODELS[0].to_string())
                } else {
                    "N/A (CLI harness)".to_string()
                };
                let session = state
                    .and_then(|s| s.session_ids.get(&s.harness))
                    .map(|s| format!("`{}...`", &s[..s.len().min(12)]))
                    .unwrap_or_else(|| "none".to_string());
                let msg_count = state.map(|s| s.messages.len()).unwrap_or(0);
                let _ = msg.channel_id.say(
                    &ctx.http,
                    &format!(
                        "**Status**\nHarness: `{}`\nModel: `{model_str}`\nSession: {session}\nHQ thread messages: {msg_count}",
                        harness_display(harness)
                    ),
                ).await;
                return;
            }

            // 5. Chat flow — dispatch to active harness
            let typing_ctx = ctx.clone();
            let typing_channel = msg.channel_id;
            let typing_handle = tokio::spawn(async move {
                loop {
                    let _ = typing_channel.broadcast_typing(&typing_ctx.http).await;
                    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                }
            });

            // Get harness and session info
            let (harness, session_id, model_override) = {
                let threads = self.threads.lock().await;
                let state = threads.get(&channel_key);
                let h = state.map(|s| s.harness.clone()).unwrap_or_else(|| "claude-code".to_string());
                let sid = state.and_then(|s| s.session_ids.get(&s.harness).cloned());
                let mo = state.and_then(|s| s.model_override.clone());
                (h, sid, mo)
            };

            // Send "Thinking..." placeholder
            let placeholder_result = msg.channel_id
                .send_message(
                    &ctx.http,
                    CreateMessage::new().content(
                        "Thinking\u{2026} \u{258D}"
                    ),
                )
                .await;

            let mut placeholder_msg = match placeholder_result {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("discord: failed to send placeholder: {e}");
                    typing_handle.abort();
                    return;
                }
            };

            // ── Harness dispatch ──
            let result: Result<String> = match harness.as_str() {
                "hq" => {
                    // HQ harness: OpenRouter with cheap models
                    // Prepare messages with history
                    let messages_for_llm = {
                        let mut threads = self.threads.lock().await;
                        let state = threads.entry(channel_key).or_insert_with(ChannelState::new_default);
                        state.harness = "hq".to_string();

                        if state.messages.is_empty() {
                            state.messages.push(hq_core::types::ChatMessage {
                                role: hq_core::types::MessageRole::System,
                                content: self.system_prompt.clone(),
                                tool_calls: vec![],
                                tool_call_id: None,
                            });
                        }

                        state.messages.push(hq_core::types::ChatMessage {
                            role: hq_core::types::MessageRole::User,
                            content: content.clone(),
                            tool_calls: vec![],
                            tool_call_id: None,
                        });

                        // Keep history bounded (30 messages)
                        if state.messages.len() > 30 {
                            let system = state.messages[0].clone();
                            let recent: Vec<_> = state.messages[state.messages.len() - 20..].to_vec();
                            state.messages = vec![system];
                            state.messages.extend(recent);
                        }

                        state.messages.clone()
                    };

                    match run_hq_harness_stream(
                        &self.api_key,
                        messages_for_llm,
                        model_override.as_deref(),
                    ).await {
                        Ok((text, _done)) => {
                            // Store assistant response in HQ history
                            let mut threads = self.threads.lock().await;
                            if let Some(state) = threads.get_mut(&channel_key) {
                                state.messages.push(hq_core::types::ChatMessage {
                                    role: hq_core::types::MessageRole::Assistant,
                                    content: text.clone(),
                                    tool_calls: vec![],
                                    tool_call_id: None,
                                });
                            }
                            Ok(text)
                        }
                        Err(e) => Err(e),
                    }
                }

                // All CLI harnesses
                harness_name @ ("claude-code" | "opencode" | "gemini-cli" | "codex-cli"
                    | "qwen-code" | "kilo-code" | "mistral-vibe") => {
                    let harness_name_owned = harness_name.to_string();
                    let content_clone = content.clone();
                    let session_id_clone = session_id.clone();

                    // Spawn the CLI harness in a background task and collect output
                    let mut harness_handle = tokio::spawn(async move {
                        run_cli_harness(
                            &harness_name_owned,
                            &content_clone,
                            session_id_clone.as_deref(),
                        ).await
                    });

                    // Update placeholder while waiting
                    let edit_interval = std::time::Duration::from_secs(2);
                    let mut edit_ticker = tokio::time::interval(edit_interval);
                    edit_ticker.tick().await; // skip first immediate tick

                    let result = loop {
                        tokio::select! {
                            result = &mut harness_handle => {
                                match result {
                                    Ok(Ok((text, new_session_id))) => {
                                        // Store session ID if we got one
                                        if let Some(sid) = new_session_id {
                                            let mut threads = self.threads.lock().await;
                                            let state = threads.entry(channel_key)
                                                .or_insert_with(ChannelState::new_default);
                                            state.session_ids.insert(harness.clone(), sid);
                                        }
                                        break Ok(text);
                                    }
                                    Ok(Err(e)) => break Err(e),
                                    Err(e) => break Err(anyhow::anyhow!("harness task panicked: {e}")),
                                }
                            }
                            _ = edit_ticker.tick() => {
                                // Update placeholder to show it's still working
                                let dots = match (std::time::Instant::now().elapsed().as_secs() / 2) % 4 {
                                    0 => ".",
                                    1 => "..",
                                    2 => "...",
                                    _ => "",
                                };
                                let _ = placeholder_msg
                                    .edit(
                                        &ctx.http,
                                        EditMessage::new().content(
                                            &format!(
                                                "Thinking\u{2026}{} \u{258D}",
                                                dots
                                            )
                                        ),
                                    )
                                    .await;
                            }
                        }
                    };

                    result
                }

                _ => {
                    // Unknown harness — fall back to HQ
                    tracing::warn!(harness = %harness, "unknown harness, falling back to hq");
                    match run_hq_harness_stream(
                        &self.api_key,
                        vec![
                            hq_core::types::ChatMessage {
                                role: hq_core::types::MessageRole::System,
                                content: self.system_prompt.clone(),
                                tool_calls: vec![],
                                tool_call_id: None,
                            },
                            hq_core::types::ChatMessage {
                                role: hq_core::types::MessageRole::User,
                                content: content.clone(),
                                tool_calls: vec![],
                                tool_call_id: None,
                            },
                        ],
                        model_override.as_deref(),
                    ).await {
                        Ok((text, _)) => Ok(text),
                        Err(e) => Err(e),
                    }
                }
            };

            typing_handle.abort();

            // ── Deliver result ──
            match result {
                Ok(accumulated) if accumulated.is_empty() => {
                    let _ = placeholder_msg
                        .edit(&ctx.http, EditMessage::new().content("No response received."))
                        .await;
                }
                Ok(accumulated) => {
                    // Delete placeholder, wait 100ms, send final as NEW message (for push notifications)
                    let _ = placeholder_msg.delete(&ctx.http).await;
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

                    // Send final response, chunked if needed
                    let chunks = split_message(&accumulated, 2000);
                    for chunk in chunks {
                        if let Err(e) = msg.channel_id.say(&ctx.http, &chunk).await {
                            tracing::error!("discord send error: {e}");
                        }
                    }

                    // Add checkmark reaction to user's original message
                    let _ = msg.react(
                        &ctx.http,
                        ReactionType::Unicode("\u{2705}".to_string()),
                    ).await;
                }
                Err(e) => {
                    tracing::error!(harness = %harness, error = %e, "harness error");
                    let _ = placeholder_msg
                        .edit(&ctx.http, EditMessage::new().content(&format!("Error ({harness}): {e}")))
                        .await;
                }
            }
        }

        async fn interaction_create(&self, ctx: Context, interaction: Interaction) {
            use serenity::builder::{
                CreateInteractionResponse, CreateInteractionResponseMessage,
            };

            let Interaction::Command(cmd) = interaction else {
                return;
            };

            let channel_key = cmd.channel_id.get();
            let response_text = match cmd.data.name.as_str() {
                "reset" => {
                    let mut threads = self.threads.lock().await;
                    threads.remove(&channel_key);
                    "Conversation reset. Session cleared.".to_string()
                }
                "model" => {
                    let name = cmd.data.options.first()
                        .and_then(|o| match &o.value {
                            serenity::model::application::CommandDataOptionValue::String(s) => Some(s.clone()),
                            _ => None,
                        })
                        .unwrap_or_default();
                    if name.is_empty() {
                        "Usage: `/model <name>`".to_string()
                    } else {
                        let resolved = resolve_model_alias(&name);
                        let mut threads = self.threads.lock().await;
                        let state = threads.entry(channel_key).or_insert_with(ChannelState::new_default);
                        state.model_override = Some(name);
                        format!("Model set to: `{resolved}` (applies to HQ harness)")
                    }
                }
                "harness" => {
                    let name = cmd.data.options.first()
                        .and_then(|o| match &o.value {
                            serenity::model::application::CommandDataOptionValue::String(s) => Some(s.clone()),
                            _ => None,
                        })
                        .unwrap_or_default();
                    if name.is_empty() {
                        "Usage: `/harness <name>`".to_string()
                    } else {
                        let canonical = canonical_harness(&name.to_lowercase());
                        let mut threads = self.threads.lock().await;
                        let state = threads.entry(channel_key).or_insert_with(ChannelState::new_default);
                        state.harness = canonical.to_string();
                        format!("Harness set to: **{}**", harness_display(&state.harness))
                    }
                }
                "status" => {
                    let threads = self.threads.lock().await;
                    let state = threads.get(&channel_key);
                    let harness = state.map(|s| s.harness.as_str()).unwrap_or("claude-code");
                    let model_str = if harness == "hq" {
                        state
                            .and_then(|s| s.model_override.as_ref())
                            .map(|m| resolve_model_alias(m))
                            .unwrap_or_else(|| HQ_MODELS[0].to_string())
                    } else {
                        "N/A (CLI harness)".to_string()
                    };
                    let session = state
                        .and_then(|s| s.session_ids.get(&s.harness))
                        .map(|s| format!("`{}...`", &s[..s.len().min(12)]))
                        .unwrap_or_else(|| "none".to_string());
                    let msg_count = state.map(|s| s.messages.len()).unwrap_or(0);
                    format!(
                        "**Status**\nHarness: `{}`\nModel: `{model_str}`\nSession: {session}\nHQ thread messages: {msg_count}",
                        harness_display(harness)
                    )
                }
                "help" => Self::make_help_text(),
                _ => "Unknown command.".to_string(),
            };

            let builder = CreateInteractionResponse::Message(
                CreateInteractionResponseMessage::new().content(response_text),
            );
            let _ = cmd.create_response(&ctx.http, builder).await;
        }

        async fn ready(&self, ctx: Context, ready: Ready) {
            info!(user = %ready.user.name, guilds = ready.guilds.len(), "discord: connected");

            // Register slash commands
            let commands = vec![
                CreateCommand::new("reset")
                    .description("Clear conversation history and kill running harness"),
                CreateCommand::new("model")
                    .description("Set the LLM model (HQ harness only)")
                    .add_option(
                        CreateCommandOption::new(
                            CommandOptionType::String,
                            "name",
                            "Model name or alias (sonnet/opus/haiku/gemini/flash/gpt4)",
                        )
                        .required(true),
                    ),
                CreateCommand::new("harness")
                    .description("Set the active harness")
                    .add_option(
                        CreateCommandOption::new(
                            CommandOptionType::String,
                            "name",
                            "Harness name",
                        )
                        .required(true)
                        .add_string_choice("claude-code", "claude-code")
                        .add_string_choice("hq", "hq")
                        .add_string_choice("opencode", "opencode")
                        .add_string_choice("gemini-cli", "gemini-cli")
                        .add_string_choice("codex-cli", "codex-cli")
                        .add_string_choice("qwen-code", "qwen-code")
                        .add_string_choice("kilo-code", "kilo-code")
                        .add_string_choice("mistral-vibe", "mistral-vibe"),
                    ),
                CreateCommand::new("status")
                    .description("Show current harness, model, and session info"),
                CreateCommand::new("help")
                    .description("Show available commands"),
            ];

            match Command::set_global_commands(&ctx.http, commands).await {
                Ok(cmds) => info!(count = cmds.len(), "discord: registered slash commands"),
                Err(e) => tracing::error!("discord: failed to register slash commands: {e}"),
            }
        }
    }

    let system_prompt = load_system_prompt(&vault);
    info!(prompt_len = system_prompt.len(), "discord: loaded system prompt");

    let intents = GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::DIRECT_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT;

    let handler = Handler {
        api_key,
        default_model: model,
        system_prompt,
        threads: Arc::new(TokioMutex::new(HashMap::new())),
    };

    let mut client = Client::builder(token, intents)
        .event_handler(handler)
        .await
        .context("failed to create Discord client")?;

    info!("discord: connecting to gateway...");
    client.start().await.context("Discord client error")?;
    Ok(())
}

// ─── Telegram relay ────────────────────────────────────────────

async fn run_telegram_relay(
    token: &str,
    vault: Arc<VaultClient>,
    _db: Arc<Database>,
    api_key: String,
    model: String,
) -> Result<()> {
    use teloxide::prelude::*;
    use teloxide::types::{
        ChatAction, MessageId, ReactionType as TgReactionType, ReplyParameters,
    };
    use std::collections::HashMap;
    use tokio::sync::Mutex as TokioMutex;

    info!("telegram: starting bot...");

    let system_prompt = load_system_prompt(&vault);
    info!(prompt_len = system_prompt.len(), "telegram: loaded system prompt");

    let bot = Bot::new(token);
    let threads: Arc<TokioMutex<HashMap<i64, ChannelState>>> =
        Arc::new(TokioMutex::new(HashMap::new()));
    let api_key = Arc::new(api_key);
    let model = Arc::new(model);
    let system_prompt = Arc::new(system_prompt);

    teloxide::repl(bot, move |bot: Bot, msg: teloxide::types::Message| {
        let threads = threads.clone();
        let api_key = api_key.clone();
        let _model = model.clone();
        let system_prompt = system_prompt.clone();
        async move {
            let raw_text = match msg.text() {
                Some(t) => t.to_string(),
                None => return Ok(()),
            };

            // Include reply context if user is replying to a message
            // Include reply-to context so the LLM knows what the user is referencing
            let text = if let Some(reply) = msg.reply_to_message() {
                if let Some(reply_text) = reply.text() {
                    let who = reply.from.as_ref()
                        .map(|u| if u.is_bot { "assistant" } else { &u.first_name })
                        .unwrap_or("someone");
                    let quoted: String = reply_text.chars().take(500).collect();
                    format!("[Replying to {who}: \"{quoted}\"]\n\n{raw_text}")
                } else {
                    raw_text
                }
            } else {
                raw_text
            };

            let chat_key = msg.chat.id.0;
            let user_msg_id = MessageId(msg.id.0);

            // Try to add eyes reaction to acknowledge receipt
            let _ = bot
                .set_message_reaction(msg.chat.id, user_msg_id)
                .reaction(vec![TgReactionType::Emoji {
                    emoji: "\u{1F440}".to_string(),
                }])
                .await;

            // Handle commands — strip @botname suffix from Telegram commands
            let text_clean = if text.starts_with('/') {
                let parts: Vec<&str> = text.splitn(2, ' ').collect();
                let cmd = parts[0].split('@').next().unwrap_or(parts[0]);
                if parts.len() > 1 {
                    format!("{} {}", cmd, parts[1])
                } else {
                    cmd.to_string()
                }
            } else {
                text.clone()
            };
            let text_lower = text_clean.to_lowercase();

            // /reset
            if text_lower == "/reset" || text_lower == "!reset" || text_lower == "!new" {
                let mut t = threads.lock().await;
                t.remove(&chat_key);
                bot.send_message(msg.chat.id, "Conversation reset. Session cleared.").await?;
                return Ok(());
            }

            // /harness <name> or !harness <name> or !switch <name>
            if text_lower.starts_with("/harness ") || text_lower.starts_with("!harness ") || text_lower.starts_with("!switch ") {
                let name = text.split_whitespace().nth(1).unwrap_or("claude-code").to_string();
                let canonical = canonical_harness(&name.to_lowercase());
                if !VALID_HARNESSES.contains(&name.to_lowercase().as_str()) {
                    bot.send_message(
                        msg.chat.id,
                        format!("Unknown harness `{name}`. Valid: {}", VALID_HARNESSES.join(", ")),
                    ).await?;
                    return Ok(());
                }
                let mut t = threads.lock().await;
                let state = t.entry(chat_key).or_insert_with(ChannelState::new_default);
                state.harness = canonical.to_string();
                bot.send_message(msg.chat.id, format!("Harness set to: {}", harness_display(&state.harness))).await?;
                return Ok(());
            }

            // /model <name> or !model <name>
            if text_lower.starts_with("/model ") || text_lower.starts_with("!model ") {
                let name = text.split_whitespace().nth(1).unwrap_or("").to_string();
                if name.is_empty() {
                    bot.send_message(msg.chat.id, "Usage: `/model <name>`").await?;
                    return Ok(());
                }
                let resolved = resolve_model_alias(&name);
                let mut t = threads.lock().await;
                let state = t.entry(chat_key).or_insert_with(ChannelState::new_default);
                state.model_override = Some(name);
                bot.send_message(msg.chat.id, format!("Model set to: {resolved} (applies to HQ harness)")).await?;
                return Ok(());
            }

            // /help or !help
            if text_lower == "/help" || text_lower == "!help" {
                let help = [
                    "HQ Bot Commands",
                    "",
                    "/reset — Clear conversation history and kill running harness",
                    "/harness <name> — Switch harness",
                    "  Harnesses: claude-code (default), hq, opencode, gemini-cli, codex-cli, qwen-code, kilo-code, mistral-vibe",
                    "/model <name> — Set model for HQ harness (sonnet/opus/haiku/gemini/flash/gpt4 or full ID)",
                    "/status — Show current harness, model, session info",
                    "/help — Show this help",
                ].join("\n");
                bot.send_message(msg.chat.id, help).await?;
                return Ok(());
            }

            // /status or !status
            if text_lower == "/status" || text_lower == "!status" {
                let t = threads.lock().await;
                let state = t.get(&chat_key);
                let harness = state.map(|s| s.harness.as_str()).unwrap_or("claude-code");
                let model_str = if harness == "hq" {
                    state
                        .and_then(|s| s.model_override.as_ref())
                        .map(|m| resolve_model_alias(m))
                        .unwrap_or_else(|| HQ_MODELS[0].to_string())
                } else {
                    "N/A (CLI harness)".to_string()
                };
                let session = state
                    .and_then(|s| s.session_ids.get(&s.harness))
                    .map(|s| format!("{}...", &s[..s.len().min(12)]))
                    .unwrap_or_else(|| "none".to_string());
                let msg_count = state.map(|s| s.messages.len()).unwrap_or(0);
                bot.send_message(
                    msg.chat.id,
                    format!(
                        "Status\nHarness: {}\nModel: {model_str}\nSession: {session}\nHQ thread messages: {msg_count}",
                        harness_display(harness)
                    ),
                ).await?;
                return Ok(());
            }

            // ── Chat flow — dispatch to active harness ──

            // Start typing indicator (keepalive every 4s)
            let typing_bot = bot.clone();
            let typing_chat_id = msg.chat.id;
            let typing_handle = tokio::spawn(async move {
                loop {
                    let _ = typing_bot.send_chat_action(typing_chat_id, ChatAction::Typing).await;
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                }
            });

            // Get harness and session info
            let (harness, session_id, model_override) = {
                let t = threads.lock().await;
                let state = t.get(&chat_key);
                let h = state.map(|s| s.harness.clone()).unwrap_or_else(|| "claude-code".to_string());
                let sid = state.and_then(|s| s.session_ids.get(&s.harness).cloned());
                let mo = state.and_then(|s| s.model_override.clone());
                (h, sid, mo)
            };

            // Send placeholder
            let placeholder_result = bot
                .send_message(
                    msg.chat.id,
                    "Thinking\u{2026} \u{258D}".to_string(),
                )
                .await;

            let placeholder_msg = match placeholder_result {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("telegram: failed to send placeholder: {e}");
                    typing_handle.abort();
                    return Ok(());
                }
            };
            let placeholder_id = MessageId(placeholder_msg.id.0);

            // ── Harness dispatch ──
            let result: Result<String, anyhow::Error> = match harness.as_str() {
                "hq" => {
                    // HQ harness: OpenRouter with cheap models
                    let messages_for_llm = {
                        let mut t = threads.lock().await;
                        let state = t.entry(chat_key).or_insert_with(ChannelState::new_default);
                        state.harness = "hq".to_string();

                        if state.messages.is_empty() {
                            state.messages.push(hq_core::types::ChatMessage {
                                role: hq_core::types::MessageRole::System,
                                content: (*system_prompt).clone(),
                                tool_calls: vec![],
                                tool_call_id: None,
                            });
                        }

                        state.messages.push(hq_core::types::ChatMessage {
                            role: hq_core::types::MessageRole::User,
                            content: text.clone(),
                            tool_calls: vec![],
                            tool_call_id: None,
                        });

                        if state.messages.len() > 30 {
                            let system_msg = state.messages[0].clone();
                            let recent: Vec<_> = state.messages[state.messages.len() - 20..].to_vec();
                            state.messages = vec![system_msg];
                            state.messages.extend(recent);
                        }

                        state.messages.clone()
                    };

                    match run_hq_harness_stream(
                        &api_key,
                        messages_for_llm,
                        model_override.as_deref(),
                    ).await {
                        Ok((response_text, _done)) => {
                            let mut t = threads.lock().await;
                            if let Some(state) = t.get_mut(&chat_key) {
                                state.messages.push(hq_core::types::ChatMessage {
                                    role: hq_core::types::MessageRole::Assistant,
                                    content: response_text.clone(),
                                    tool_calls: vec![],
                                    tool_call_id: None,
                                });
                            }
                            Ok(response_text)
                        }
                        Err(e) => Err(e),
                    }
                }

                // All CLI harnesses
                harness_name @ ("claude-code" | "opencode" | "gemini-cli" | "codex-cli"
                    | "qwen-code" | "kilo-code" | "mistral-vibe") => {
                    let harness_name_owned = harness_name.to_string();
                    let content_clone = text.clone();
                    let session_id_clone = session_id.clone();

                    let mut harness_handle = tokio::spawn(async move {
                        run_cli_harness(
                            &harness_name_owned,
                            &content_clone,
                            session_id_clone.as_deref(),
                        ).await
                    });

                    // Update placeholder while waiting
                    let edit_interval = std::time::Duration::from_secs(3);
                    let mut edit_ticker = tokio::time::interval(edit_interval);
                    edit_ticker.tick().await;

                    let result = loop {
                        tokio::select! {
                            result = &mut harness_handle => {
                                match result {
                                    Ok(Ok((response_text, new_session_id))) => {
                                        if let Some(sid) = new_session_id {
                                            let mut t = threads.lock().await;
                                            let state = t.entry(chat_key)
                                                .or_insert_with(ChannelState::new_default);
                                            state.session_ids.insert(harness.clone(), sid);
                                        }
                                        break Ok(response_text);
                                    }
                                    Ok(Err(e)) => break Err(e),
                                    Err(e) => break Err(anyhow::anyhow!("harness task panicked: {e}")),
                                }
                            }
                            _ = edit_ticker.tick() => {
                                let _ = bot
                                    .edit_message_text(
                                        msg.chat.id,
                                        placeholder_id,
                                        "Thinking\u{2026} \u{258D}",
                                    )
                                    .await;
                            }
                        }
                    };

                    result
                }

                _ => {
                    // Unknown harness — fall back to HQ
                    tracing::warn!(harness = %harness, "unknown harness, falling back to hq");
                    match run_hq_harness_stream(
                        &api_key,
                        vec![
                            hq_core::types::ChatMessage {
                                role: hq_core::types::MessageRole::System,
                                content: (*system_prompt).clone(),
                                tool_calls: vec![],
                                tool_call_id: None,
                            },
                            hq_core::types::ChatMessage {
                                role: hq_core::types::MessageRole::User,
                                content: text.clone(),
                                tool_calls: vec![],
                                tool_call_id: None,
                            },
                        ],
                        model_override.as_deref(),
                    ).await {
                        Ok((response_text, _)) => Ok(response_text),
                        Err(e) => Err(e),
                    }
                }
            };

            typing_handle.abort();

            // ── Deliver result ──
            match result {
                Ok(accumulated) if accumulated.is_empty() => {
                    let _ = bot
                        .edit_message_text(msg.chat.id, placeholder_id, "No response received.")
                        .await;
                }
                Ok(accumulated) => {
                    // Delete placeholder, wait 100ms, send final as reply
                    let _ = bot.delete_message(msg.chat.id, placeholder_id).await;
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

                    let chunks = split_message(&accumulated, 4096);
                    for (i, chunk) in chunks.iter().enumerate() {
                        let mut req = bot.send_message(msg.chat.id, chunk.as_str());
                        if i == 0 {
                            req = req.reply_parameters(ReplyParameters::new(user_msg_id));
                        }
                        if let Err(e) = req.await {
                            tracing::error!("telegram send error: {e}");
                        }
                    }

                    // Add checkmark reaction on success
                    let _ = bot
                        .set_message_reaction(msg.chat.id, user_msg_id)
                        .reaction(vec![TgReactionType::Emoji {
                            emoji: "\u{2705}".to_string(),
                        }])
                        .await;
                }
                Err(e) => {
                    tracing::error!(harness = %harness, error = %e, "harness error");
                    let _ = bot
                        .edit_message_text(
                            msg.chat.id,
                            placeholder_id,
                            &format!("Error ({}): {e}", harness),
                        )
                        .await;
                }
            }

            Ok(())
        }
    }).await;

    Ok(())
}

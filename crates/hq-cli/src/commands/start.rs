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

    // Spawn WebSocket server
    let ws_port = config.ws_port;
    tokio::spawn(async move {
        info!(port = ws_port, "ws: starting server");
        let state = Arc::new(hq_web::WsState::new());
        let app = hq_web::create_router(state);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], ws_port));
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

async fn run_daemon(
    _config: &HqConfig,
    vault: Arc<VaultClient>,
    _db: Arc<Database>,
) -> Result<()> {
    // Write daemon status to vault
    let status_path = vault.vault_path().join("DAEMON-STATUS.md");
    let now = chrono::Utc::now().to_rfc3339();
    std::fs::write(
        &status_path,
        format!("---\nstatus: running\nstarted_at: {now}\nruntime: rust\n---\n\n# Daemon Status\n\nRunning since {now}\n"),
    )?;

    info!("daemon: scheduler running (30s tick)");

    let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        interval.tick().await;

        // Health check: look for stuck jobs
        let running_jobs = vault.list_pending_jobs().unwrap_or_default();
        if !running_jobs.is_empty() {
            info!(count = running_jobs.len(), "daemon: pending jobs detected");
        }

        // Heartbeat
        let heartbeat_path = vault.vault_path().join("_system").join("HEARTBEAT.md");
        if heartbeat_path.exists() {
            // Touch it to show daemon is alive
            let now = chrono::Utc::now().to_rfc3339();
            let _ = std::fs::write(
                vault.vault_path().join("DAEMON-STATUS.md"),
                format!("---\nstatus: running\nlast_tick: {now}\nruntime: rust\n---\n\n# Daemon Status\n\nLast tick: {now}\n"),
            );
        }
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
            let content = msg.content
                .replace(&format!("<@{}>", bot_id), "")
                .replace(&format!("<@!{}>", bot_id), "")
                .trim()
                .to_string();
            if content.is_empty() {
                return;
            }

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
                        &format!("Thinking via **{}**\u{2026} \u{258D}", harness_display(&harness))
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
                                                "Running **{}**{} \u{258D}",
                                                harness_display(&harness), dots
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
            let text = match msg.text() {
                Some(t) => t.to_string(),
                None => return Ok(()),
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
                    format!("Thinking via {}... \u{258D}", harness_display(&harness)),
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
                                        &format!("Running {}... \u{258D}", harness_display(&harness)),
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

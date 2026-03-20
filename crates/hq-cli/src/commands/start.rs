use anyhow::{Context, Result};
use hq_core::config::HqConfig;
use hq_db::Database;
use hq_llm::LlmProvider;
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
        "gpt4" => "openai/gpt-4.1".to_string(),
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
    use futures::StreamExt;

    #[derive(Clone)]
    struct ChannelState {
        messages: Vec<hq_core::types::ChatMessage>,
        harness: String,
        model_override: Option<String>,
    }

    struct Handler {
        api_key: String,
        default_model: String,
        system_prompt: String,
        threads: Arc<TokioMutex<HashMap<u64, ChannelState>>>,
    }

    impl Handler {
        fn make_help_text() -> String {
            [
                "**HQ Bot Commands**",
                "",
                "`!reset` / `!new` — Clear conversation history",
                "`!harness <name>` / `!switch <name>` — Switch harness (hq/claude/gemini/opencode/codex/auto)",
                "`!model <name>` — Set model (sonnet/opus/haiku/gemini/flash/gpt4 or full ID)",
                "`!status` — Show current harness, model, thread length",
                "`!help` — Show this help",
                "",
                "**Slash commands:** `/reset`, `/model`, `/harness`, `/status`, `/help`",
            ]
            .join("\n")
        }

        fn resolve_model(&self, state: &ChannelState) -> String {
            if let Some(ref m) = state.model_override {
                resolve_model_alias(m)
            } else {
                self.default_model.clone()
            }
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
                let _ = msg.channel_id.say(&ctx.http, "Conversation reset.").await;
                return;
            }

            // !harness <name> / !switch <name>
            if content_lower.starts_with("!harness ") || content_lower.starts_with("!switch ") {
                let name = content.split_whitespace().nth(1).unwrap_or("hq").to_string();
                let valid = ["hq", "claude", "gemini", "opencode", "codex", "auto"];
                if !valid.contains(&name.to_lowercase().as_str()) {
                    let _ = msg.channel_id.say(
                        &ctx.http,
                        &format!("Unknown harness `{name}`. Valid: {}", valid.join(", ")),
                    ).await;
                    return;
                }
                let mut threads = self.threads.lock().await;
                let state = threads.entry(channel_key).or_insert_with(|| ChannelState {
                    messages: vec![],
                    harness: "hq".to_string(),
                    model_override: None,
                });
                state.harness = name.to_lowercase();
                let _ = msg.channel_id.say(
                    &ctx.http,
                    &format!("Harness set to: {}", state.harness),
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
                let state = threads.entry(channel_key).or_insert_with(|| ChannelState {
                    messages: vec![],
                    harness: "hq".to_string(),
                    model_override: None,
                });
                state.model_override = Some(name.clone());
                let _ = msg.channel_id.say(
                    &ctx.http,
                    &format!("Model set to: {resolved}"),
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
                let harness = state.map(|s| s.harness.as_str()).unwrap_or("hq");
                let model_str = state
                    .and_then(|s| s.model_override.as_ref())
                    .map(|m| resolve_model_alias(m))
                    .unwrap_or_else(|| self.default_model.clone());
                let msg_count = state.map(|s| s.messages.len()).unwrap_or(0);
                let _ = msg.channel_id.say(
                    &ctx.http,
                    &format!(
                        "**Status**\nHarness: `{harness}`\nModel: `{model_str}`\nThread messages: {msg_count}"
                    ),
                ).await;
                return;
            }

            // 5. Chat flow — streaming with placeholder editing
            // Start typing indicator (keepalive every 8s)
            let typing_ctx = ctx.clone();
            let typing_channel = msg.channel_id;
            let typing_handle = tokio::spawn(async move {
                loop {
                    let _ = typing_channel.broadcast_typing(&typing_ctx.http).await;
                    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                }
            });

            // Prepare messages
            let (messages_for_llm, model_to_use) = {
                let mut threads = self.threads.lock().await;
                let state = threads.entry(channel_key).or_insert_with(|| ChannelState {
                    messages: vec![hq_core::types::ChatMessage {
                        role: hq_core::types::MessageRole::System,
                        content: self.system_prompt.clone(),
                        tool_calls: vec![],
                        tool_call_id: None,
                    }],
                    harness: "hq".to_string(),
                    model_override: None,
                });

                // Ensure system message exists
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

                let model = self.resolve_model(state);
                (state.messages.clone(), model)
            };

            // Send "Thinking..." placeholder
            let placeholder_result = msg.channel_id
                .send_message(&ctx.http, CreateMessage::new().content("Thinking..."))
                .await;

            let mut placeholder_msg = match placeholder_result {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("discord: failed to send placeholder: {e}");
                    typing_handle.abort();
                    return;
                }
            };

            // Call OpenRouter with streaming
            let provider = hq_llm::openrouter::OpenRouterProvider::new(&self.api_key);
            let request = hq_llm::ChatRequest {
                model: model_to_use,
                messages: messages_for_llm,
                tools: vec![],
                temperature: Some(0.7),
                max_tokens: Some(4096),
            };

            match provider.chat_stream(&request).await {
                Ok(mut stream) => {
                    let mut accumulated = String::new();
                    let mut last_edit = std::time::Instant::now();
                    let mut stream_done = false;

                    while let Some(chunk_result) = stream.next().await {
                        match chunk_result {
                            Ok(hq_llm::StreamChunk::Text(text)) => {
                                accumulated.push_str(&text);
                                // Edit placeholder every 500ms
                                if last_edit.elapsed() >= std::time::Duration::from_millis(500) {
                                    let display = if accumulated.len() > 1950 {
                                        format!("{}... \u{258D}", &accumulated[accumulated.len()-1900..])
                                    } else {
                                        format!("{} \u{258D}", &accumulated)
                                    };
                                    let _ = placeholder_msg
                                        .edit(&ctx.http, EditMessage::new().content(&display))
                                        .await;
                                    last_edit = std::time::Instant::now();
                                }
                            }
                            Ok(hq_llm::StreamChunk::Done) => {
                                stream_done = true;
                                break;
                            }
                            Ok(hq_llm::StreamChunk::Usage { .. }) => {}
                            Ok(hq_llm::StreamChunk::ToolCallDelta { .. }) => {}
                            Err(e) => {
                                tracing::error!("discord stream error: {e}");
                                let _ = placeholder_msg
                                    .edit(&ctx.http, EditMessage::new().content(&format!("Error: {e}")))
                                    .await;
                                typing_handle.abort();
                                return;
                            }
                        }
                    }

                    typing_handle.abort();

                    if accumulated.is_empty() && !stream_done {
                        let _ = placeholder_msg
                            .edit(&ctx.http, EditMessage::new().content("No response received."))
                            .await;
                        return;
                    }

                    // Delete placeholder, wait 100ms, send final as NEW message (for push notifications)
                    let _ = placeholder_msg.delete(&ctx.http).await;
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

                    // Store assistant response in history
                    {
                        let mut threads = self.threads.lock().await;
                        if let Some(state) = threads.get_mut(&channel_key) {
                            state.messages.push(hq_core::types::ChatMessage {
                                role: hq_core::types::MessageRole::Assistant,
                                content: accumulated.clone(),
                                tool_calls: vec![],
                                tool_call_id: None,
                            });
                        }
                    }

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
                    typing_handle.abort();
                    let _ = placeholder_msg
                        .edit(&ctx.http, EditMessage::new().content(&format!("Error: {e}")))
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
                    "Conversation reset.".to_string()
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
                        let state = threads.entry(channel_key).or_insert_with(|| ChannelState {
                            messages: vec![],
                            harness: "hq".to_string(),
                            model_override: None,
                        });
                        state.model_override = Some(name);
                        format!("Model set to: {resolved}")
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
                        let mut threads = self.threads.lock().await;
                        let state = threads.entry(channel_key).or_insert_with(|| ChannelState {
                            messages: vec![],
                            harness: "hq".to_string(),
                            model_override: None,
                        });
                        state.harness = name.to_lowercase();
                        format!("Harness set to: {}", state.harness)
                    }
                }
                "status" => {
                    let threads = self.threads.lock().await;
                    let state = threads.get(&channel_key);
                    let harness = state.map(|s| s.harness.as_str()).unwrap_or("hq");
                    let model_str = state
                        .and_then(|s| s.model_override.as_ref())
                        .map(|m| resolve_model_alias(m))
                        .unwrap_or_else(|| self.default_model.clone());
                    let msg_count = state.map(|s| s.messages.len()).unwrap_or(0);
                    format!("**Status**\nHarness: `{harness}`\nModel: `{model_str}`\nThread messages: {msg_count}")
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
                    .description("Clear conversation history"),
                CreateCommand::new("model")
                    .description("Set the LLM model")
                    .add_option(
                        CreateCommandOption::new(
                            CommandOptionType::String,
                            "name",
                            "Model name or alias (sonnet/opus/haiku/gemini/flash/gpt4)",
                        )
                        .required(true),
                    ),
                CreateCommand::new("harness")
                    .description("Set the harness")
                    .add_option(
                        CreateCommandOption::new(
                            CommandOptionType::String,
                            "name",
                            "Harness name",
                        )
                        .required(true)
                        .add_string_choice("hq", "hq")
                        .add_string_choice("claude", "claude")
                        .add_string_choice("gemini", "gemini")
                        .add_string_choice("opencode", "opencode")
                        .add_string_choice("codex", "codex")
                        .add_string_choice("auto", "auto"),
                    ),
                CreateCommand::new("status")
                    .description("Show current harness, model, and thread info"),
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
    use futures::StreamExt;

    #[derive(Clone)]
    struct TgChannelState {
        messages: Vec<hq_core::types::ChatMessage>,
        harness: String,
        model_override: Option<String>,
    }

    info!("telegram: starting bot...");

    let system_prompt = load_system_prompt(&vault);
    info!(prompt_len = system_prompt.len(), "telegram: loaded system prompt");

    let bot = Bot::new(token);
    let threads: Arc<TokioMutex<HashMap<i64, TgChannelState>>> =
        Arc::new(TokioMutex::new(HashMap::new()));
    let api_key = Arc::new(api_key);
    let model = Arc::new(model);
    let system_prompt = Arc::new(system_prompt);

    teloxide::repl(bot, move |bot: Bot, msg: teloxide::types::Message| {
        let threads = threads.clone();
        let api_key = api_key.clone();
        let model = model.clone();
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

            // Handle commands
            let text_lower = text.to_lowercase();

            // /reset
            if text_lower == "/reset" || text_lower == "/reset@hq_bot" || text_lower == "!reset" || text_lower == "!new" {
                let mut t = threads.lock().await;
                t.remove(&chat_key);
                bot.send_message(msg.chat.id, "Conversation reset.").await?;
                return Ok(());
            }

            // /harness <name> or !harness <name> or !switch <name>
            if text_lower.starts_with("/harness ") || text_lower.starts_with("!harness ") || text_lower.starts_with("!switch ") {
                let name = text.split_whitespace().nth(1).unwrap_or("hq").to_string();
                let valid = ["hq", "claude", "gemini", "opencode", "codex", "auto"];
                if !valid.contains(&name.to_lowercase().as_str()) {
                    bot.send_message(
                        msg.chat.id,
                        format!("Unknown harness `{name}`. Valid: {}", valid.join(", ")),
                    ).await?;
                    return Ok(());
                }
                let mut t = threads.lock().await;
                let state = t.entry(chat_key).or_insert_with(|| TgChannelState {
                    messages: vec![],
                    harness: "hq".to_string(),
                    model_override: None,
                });
                state.harness = name.to_lowercase();
                bot.send_message(msg.chat.id, format!("Harness set to: {}", state.harness)).await?;
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
                let state = t.entry(chat_key).or_insert_with(|| TgChannelState {
                    messages: vec![],
                    harness: "hq".to_string(),
                    model_override: None,
                });
                state.model_override = Some(name);
                bot.send_message(msg.chat.id, format!("Model set to: {resolved}")).await?;
                return Ok(());
            }

            // /help or !help
            if text_lower == "/help" || text_lower == "!help" || text_lower.starts_with("/help@") {
                let help = [
                    "HQ Bot Commands",
                    "",
                    "/reset — Clear conversation history",
                    "/harness <name> — Switch harness (hq/claude/gemini/opencode/codex/auto)",
                    "/model <name> — Set model (sonnet/opus/haiku/gemini/flash/gpt4 or full ID)",
                    "/status — Show current harness, model, thread length",
                    "/help — Show this help",
                ].join("\n");
                bot.send_message(msg.chat.id, help).await?;
                return Ok(());
            }

            // /status or !status
            if text_lower == "/status" || text_lower == "!status" || text_lower.starts_with("/status@") {
                let t = threads.lock().await;
                let state = t.get(&chat_key);
                let harness = state.map(|s| s.harness.as_str()).unwrap_or("hq");
                let model_str = state
                    .and_then(|s| s.model_override.as_ref())
                    .map(|m| resolve_model_alias(m))
                    .unwrap_or_else(|| (*model).clone());
                let msg_count = state.map(|s| s.messages.len()).unwrap_or(0);
                bot.send_message(
                    msg.chat.id,
                    format!("Status\nHarness: {harness}\nModel: {model_str}\nThread messages: {msg_count}"),
                ).await?;
                return Ok(());
            }

            // Chat flow — streaming with placeholder editing

            // Start typing indicator (keepalive every 4s)
            let typing_bot = bot.clone();
            let typing_chat_id = msg.chat.id;
            let typing_handle = tokio::spawn(async move {
                loop {
                    let _ = typing_bot.send_chat_action(typing_chat_id, ChatAction::Typing).await;
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                }
            });

            // Prepare messages for LLM
            let model_to_use = {
                let mut t = threads.lock().await;
                let state = t.entry(chat_key).or_insert_with(|| TgChannelState {
                    messages: vec![hq_core::types::ChatMessage {
                        role: hq_core::types::MessageRole::System,
                        content: (*system_prompt).clone(),
                        tool_calls: vec![],
                        tool_call_id: None,
                    }],
                    harness: "hq".to_string(),
                    model_override: None,
                });

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

                // Keep history bounded (30 messages)
                if state.messages.len() > 30 {
                    let system = state.messages[0].clone();
                    let recent: Vec<_> = state.messages[state.messages.len() - 20..].to_vec();
                    state.messages = vec![system];
                    state.messages.extend(recent);
                }

                let m = if let Some(ref mo) = state.model_override {
                    resolve_model_alias(mo)
                } else {
                    (*model).clone()
                };
                m
            };

            let messages_for_llm = {
                let t = threads.lock().await;
                t.get(&chat_key).map(|s| s.messages.clone()).unwrap_or_default()
            };

            // Send "Thinking... cursor" placeholder
            let placeholder_result = bot
                .send_message(msg.chat.id, "Thinking\u{2026} \u{258D}")
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

            // Call OpenRouter with streaming
            let provider = hq_llm::openrouter::OpenRouterProvider::new(&api_key);
            let request = hq_llm::ChatRequest {
                model: model_to_use,
                messages: messages_for_llm,
                tools: vec![],
                temperature: Some(0.7),
                max_tokens: Some(4096),
            };

            match provider.chat_stream(&request).await {
                Ok(mut stream) => {
                    let mut accumulated = String::new();
                    let mut last_edit = std::time::Instant::now();
                    let mut stream_done = false;

                    while let Some(chunk_result) = stream.next().await {
                        match chunk_result {
                            Ok(hq_llm::StreamChunk::Text(t)) => {
                                accumulated.push_str(&t);
                                // Edit placeholder every 500ms
                                if last_edit.elapsed() >= std::time::Duration::from_millis(500) {
                                    let display = if accumulated.len() > 4000 {
                                        format!("{}... \u{258D}", &accumulated[accumulated.len()-3900..])
                                    } else {
                                        format!("{} \u{258D}", &accumulated)
                                    };
                                    let _ = bot
                                        .edit_message_text(msg.chat.id, placeholder_id, &display)
                                        .await;
                                    last_edit = std::time::Instant::now();
                                }
                            }
                            Ok(hq_llm::StreamChunk::Done) => {
                                stream_done = true;
                                break;
                            }
                            Ok(hq_llm::StreamChunk::Usage { .. }) => {}
                            Ok(hq_llm::StreamChunk::ToolCallDelta { .. }) => {}
                            Err(e) => {
                                tracing::error!("telegram stream error: {e}");
                                let _ = bot
                                    .edit_message_text(msg.chat.id, placeholder_id, &format!("Error: {e}"))
                                    .await;
                                typing_handle.abort();
                                return Ok(());
                            }
                        }
                    }

                    typing_handle.abort();

                    if accumulated.is_empty() && !stream_done {
                        let _ = bot
                            .edit_message_text(msg.chat.id, placeholder_id, "No response received.")
                            .await;
                        return Ok(());
                    }

                    // Delete placeholder, wait 100ms, send final as reply to user message
                    let _ = bot.delete_message(msg.chat.id, placeholder_id).await;
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

                    // Store assistant response in history
                    {
                        let mut t = threads.lock().await;
                        if let Some(state) = t.get_mut(&chat_key) {
                            state.messages.push(hq_core::types::ChatMessage {
                                role: hq_core::types::MessageRole::Assistant,
                                content: accumulated.clone(),
                                tool_calls: vec![],
                                tool_call_id: None,
                            });
                        }
                    }

                    // Send final response as reply, chunked if needed
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
                    typing_handle.abort();
                    let _ = bot
                        .edit_message_text(msg.chat.id, placeholder_id, &format!("Error: {e}"))
                        .await;
                }
            }

            Ok(())
        }
    }).await;

    Ok(())
}

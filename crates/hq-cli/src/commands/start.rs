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

async fn run_discord_relay(
    token: &str,
    _vault: Arc<VaultClient>,
    _db: Arc<Database>,
    api_key: String,
    model: String,
) -> Result<()> {
    use serenity::prelude::*;
    use serenity::model::prelude::*;
    use serenity::async_trait;
    use std::collections::HashMap;
    use tokio::sync::Mutex as TokioMutex;

    struct Handler {
        api_key: String,
        model: String,
        // Per-channel conversation history
        threads: Arc<TokioMutex<HashMap<u64, Vec<hq_core::types::ChatMessage>>>>,
    }

    #[async_trait]
    impl EventHandler for Handler {
        async fn message(&self, ctx: Context, msg: Message) {
            if msg.author.bot {
                return;
            }

            let bot_id = ctx.cache.current_user().id;
            let is_mention = msg.mentions.iter().any(|u| u.id == bot_id);
            let is_dm = msg.guild_id.is_none();

            if !(is_mention || is_dm) {
                return;
            }

            let content = msg.content.replace(&format!("<@{}>", bot_id), "").trim().to_string();
            if content.is_empty() {
                return;
            }

            // Handle !reset command
            if content == "!reset" || content == "/reset" {
                let mut threads = self.threads.lock().await;
                threads.remove(&msg.channel_id.get());
                let _ = msg.channel_id.say(&ctx.http, "Conversation reset.").await;
                return;
            }

            let _ = msg.channel_id.broadcast_typing(&ctx.http).await;

            // Get or create thread history
            let channel_key = msg.channel_id.get();
            let mut threads = self.threads.lock().await;
            let history = threads.entry(channel_key).or_insert_with(|| {
                vec![hq_core::types::ChatMessage {
                    role: hq_core::types::MessageRole::System,
                    content: "You are HQ, a helpful AI assistant. Be concise and helpful.".to_string(),
                    tool_calls: vec![],
                    tool_call_id: None,
                }]
            });

            history.push(hq_core::types::ChatMessage {
                role: hq_core::types::MessageRole::User,
                content: content.clone(),
                tool_calls: vec![],
                tool_call_id: None,
            });

            // Keep history bounded
            if history.len() > 30 {
                let system = history[0].clone();
                let recent: Vec<_> = history[history.len()-20..].to_vec();
                *history = vec![system];
                history.extend(recent);
            }

            // Call OpenRouter
            let provider = hq_llm::openrouter::OpenRouterProvider::new(&self.api_key);
            let request = hq_llm::ChatRequest {
                model: self.model.clone(),
                messages: history.clone(),
                tools: vec![],
                temperature: Some(0.7),
                max_tokens: Some(2048),
            };

            match provider.chat(&request).await {
                Ok(response) => {
                    let reply = &response.message.content;
                    history.push(response.message.clone());

                    // Split for Discord's 2000 char limit
                    let chunks = split_message(reply, 2000);
                    for chunk in chunks {
                        if let Err(e) = msg.channel_id.say(&ctx.http, &chunk).await {
                            tracing::error!("discord send error: {e}");
                        }
                    }
                }
                Err(e) => {
                    let _ = msg.channel_id.say(
                        &ctx.http,
                        &format!("Error: {e}"),
                    ).await;
                }
            }

            drop(threads);
        }

        async fn ready(&self, _ctx: Context, ready: Ready) {
            info!(user = %ready.user.name, guilds = ready.guilds.len(), "discord: connected");
        }
    }

    let intents = GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::DIRECT_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT;

    let handler = Handler {
        api_key,
        model,
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

async fn run_telegram_relay(
    token: &str,
    _vault: Arc<VaultClient>,
    _db: Arc<Database>,
    api_key: String,
    model: String,
) -> Result<()> {
    use teloxide::prelude::*;
    use std::collections::HashMap;
    use tokio::sync::Mutex as TokioMutex;

    info!("telegram: starting bot...");

    let bot = Bot::new(token);
    let threads: Arc<TokioMutex<HashMap<i64, Vec<hq_core::types::ChatMessage>>>> =
        Arc::new(TokioMutex::new(HashMap::new()));
    let api_key = Arc::new(api_key);
    let model = Arc::new(model);

    teloxide::repl(bot, move |bot: Bot, msg: teloxide::types::Message| {
        let threads = threads.clone();
        let api_key = api_key.clone();
        let model = model.clone();
        async move {
            let text = match msg.text() {
                Some(t) => t.to_string(),
                None => return Ok(()),
            };

            // Handle /reset
            if text == "/reset" {
                let mut t = threads.lock().await;
                t.remove(&msg.chat.id.0);
                bot.send_message(msg.chat.id, "Conversation reset.").await?;
                return Ok(());
            }

            // Get or create thread
            let chat_key = msg.chat.id.0;
            let mut t = threads.lock().await;
            let history = t.entry(chat_key).or_insert_with(|| {
                vec![hq_core::types::ChatMessage {
                    role: hq_core::types::MessageRole::System,
                    content: "You are HQ, a helpful AI assistant. Be concise and helpful.".to_string(),
                    tool_calls: vec![],
                    tool_call_id: None,
                }]
            });

            history.push(hq_core::types::ChatMessage {
                role: hq_core::types::MessageRole::User,
                content: text.clone(),
                tool_calls: vec![],
                tool_call_id: None,
            });

            if history.len() > 30 {
                let system = history[0].clone();
                let recent: Vec<_> = history[history.len()-20..].to_vec();
                *history = vec![system];
                history.extend(recent);
            }

            let provider = hq_llm::openrouter::OpenRouterProvider::new(&api_key);
            let request = hq_llm::ChatRequest {
                model: (*model).clone(),
                messages: history.clone(),
                tools: vec![],
                temperature: Some(0.7),
                max_tokens: Some(2048),
            };

            match provider.chat(&request).await {
                Ok(response) => {
                    let reply = response.message.content.clone();
                    history.push(response.message);
                    drop(t);

                    let chunks = split_message(&reply, 4096);
                    for chunk in chunks {
                        bot.send_message(msg.chat.id, chunk).await?;
                    }
                }
                Err(e) => {
                    drop(t);
                    bot.send_message(msg.chat.id, format!("Error: {e}")).await?;
                }
            }

            Ok(())
        }
    }).await;

    Ok(())
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

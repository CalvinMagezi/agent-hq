use anyhow::{Context, Result};
use hq_core::config::HqConfig;
use hq_db::Database;
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
            tokio::spawn(async move {
                info!("discord: starting relay");
                if let Err(e) = run_discord_relay(&token, relay_vault, relay_db).await {
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
            tokio::spawn(async move {
                info!("telegram: starting relay");
                if let Err(e) = run_telegram_relay(&token, relay_vault, relay_db).await {
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
    run_discord_relay(token, vault, db).await
}

async fn start_telegram(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    db: Arc<Database>,
) -> Result<()> {
    let token = config.relay.telegram_token.as_ref()
        .context("Telegram token not configured. Set relay.telegram_token in ~/.hq/config.yaml")?;
    run_telegram_relay(token, vault, db).await
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
) -> Result<()> {
    use serenity::prelude::*;
    use serenity::model::prelude::*;
    use serenity::async_trait;

    struct Handler;

    #[async_trait]
    impl EventHandler for Handler {
        async fn message(&self, ctx: Context, msg: Message) {
            // Ignore bot messages
            if msg.author.bot {
                return;
            }

            // Respond to messages mentioning the bot or in DMs
            let bot_id = ctx.cache.current_user().id;
            let is_mention = msg.mentions.iter().any(|u| u.id == bot_id);
            let is_dm = msg.guild_id.is_none();

            if is_mention || is_dm {
                let content = msg.content.replace(&format!("<@{}>", bot_id), "").trim().to_string();
                if content.is_empty() {
                    return;
                }

                // Send typing indicator
                let _ = msg.channel_id.broadcast_typing(&ctx.http).await;

                // For now, echo back with a note about Rust migration
                let response = format!(
                    "HQ (Rust) received: `{}`\n\n*Agent session execution is being wired up. \
                     The Rust binary is running at 6MB / ~15MB RAM instead of the old 10GB.*",
                    content.chars().take(100).collect::<String>()
                );

                if let Err(e) = msg.channel_id.say(&ctx.http, &response).await {
                    tracing::error!("discord: failed to send: {e}");
                }
            }
        }

        async fn ready(&self, _ctx: Context, ready: Ready) {
            info!(user = %ready.user.name, guilds = ready.guilds.len(), "discord: connected");
        }
    }

    let intents = GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::DIRECT_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT;

    let mut client = Client::builder(token, intents)
        .event_handler(Handler)
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
) -> Result<()> {
    use teloxide::prelude::*;

    info!("telegram: starting bot...");

    let bot = Bot::new(token);

    teloxide::repl(bot, |bot: Bot, msg: teloxide::types::Message| async move {
        if let Some(text) = msg.text() {
            let response = format!(
                "HQ (Rust) received: `{}`\n\n_Agent session being wired up. \
                 Running at 6MB / ~15MB RAM._",
                text.chars().take(100).collect::<String>()
            );
            bot.send_message(msg.chat.id, response).await?;
        }
        Ok(())
    }).await;

    Ok(())
}

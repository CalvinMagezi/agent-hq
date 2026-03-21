//! `hq start` command — launches all HQ components (daemon, agent, relays, websocket).

mod agent;
pub mod common;
pub mod daemon;
pub mod harness;
pub mod relay;
pub mod touchpoints;

use anyhow::{Context, Result};
use hq_core::config::HqConfig;
use hq_db::Database;
use hq_vault::VaultClient;
use std::sync::Arc;
use tokio::signal;
use tracing::info;

pub async fn run(config: &HqConfig, component: &str) -> Result<()> {
    let vault = Arc::new(
        VaultClient::new(config.vault_path.clone()).context("failed to open vault")?,
    );

    let db_path = config.db_path();
    let db = Arc::new(Database::open(&db_path).context("failed to open database")?);

    info!(vault = %config.vault_path.display(), "HQ starting");

    match component {
        "all" => {
            println!("Starting all HQ components...");
            start_all(config, vault, db).await
        }
        "agent" => {
            println!("Starting agent worker...");
            agent::run_agent_worker(config, vault, db).await
        }
        "daemon" => {
            println!("Starting daemon...");
            daemon::run_daemon(config, vault, db).await
        }
        "relay" | "discord" => {
            println!("Starting Discord relay...");
            start_discord(config, vault, db).await
        }
        "telegram" => {
            println!("Starting Telegram relay...");
            start_telegram(config, vault, db).await
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
    println!("  Touch points engine");
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
        if let Err(e) = daemon::run_daemon(&daemon_config, daemon_vault, daemon_db).await {
            tracing::error!("daemon error: {e}");
        }
    });

    // Spawn agent worker
    let agent_vault = vault.clone();
    let agent_db = db.clone();
    let agent_config = config.clone();
    tokio::spawn(async move {
        info!("agent: starting worker");
        if let Err(e) = agent::run_agent_worker(&agent_config, agent_vault, agent_db).await {
            tracing::error!("agent error: {e}");
        }
    });

    // Spawn touch points engine (file watcher)
    let tp_vault_path = config.vault_path.clone();
    tokio::spawn(async move {
        info!("touchpoints: starting file watcher");
        match touchpoints::start_watcher(tp_vault_path).await {
            Ok(_watcher) => {
                // Keep the watcher alive by holding the handle
                // It will be dropped when this task is cancelled
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                }
            }
            Err(e) => {
                tracing::error!("touchpoints: failed to start file watcher: {e}");
            }
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
                if let Err(e) =
                    relay::run_discord_relay(&token, relay_vault, relay_db, api_key, model).await
                {
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
                if let Err(e) =
                    relay::run_telegram_relay(&token, relay_vault, relay_db, api_key, model).await
                {
                    tracing::error!("telegram relay error: {e}");
                }
            });
        } else {
            println!("  Telegram enabled but no token configured — skipping");
        }
    }

    // Spawn WhatsApp bridge (Baileys via Bun subprocess)
    {
        let wa_jid = std::env::var("WHATSAPP_OWNER_JID").ok();
        let vault_for_wa = config.vault_path.clone();
        if let Some(jid) = wa_jid {
            println!(
                "  WhatsApp relay (owner: {})",
                &jid[..jid.find('@').unwrap_or(jid.len())]
            );
            let api_key_wa = config.openrouter_api_key.clone().unwrap_or_default();
            let wa_api_url = format!("http://localhost:{}", config.ws_port);
            tokio::spawn(async move {
                info!(owner = %jid, "whatsapp: starting bridge");
                let bridge_dir = vault_for_wa
                    .parent()
                    .unwrap_or(&vault_for_wa)
                    .join("bridges")
                    .join("whatsapp");
                if !bridge_dir.join("index.ts").exists() {
                    tracing::warn!(
                        "whatsapp: bridge not found at {}",
                        bridge_dir.display()
                    );
                    return;
                }
                let mut child = tokio::process::Command::new("bun")
                    .arg("run")
                    .arg("index.ts")
                    .current_dir(&bridge_dir)
                    .env("WHATSAPP_OWNER_JID", &jid)
                    .env("VAULT_PATH", vault_for_wa.to_string_lossy().as_ref())
                    .env("HQ_API_URL", &wa_api_url)
                    .env(
                        "GROQ_API_KEY",
                        std::env::var("GROQ_API_KEY").unwrap_or_default(),
                    )
                    .env("OPENROUTER_API_KEY", &api_key_wa)
                    .stdout(std::process::Stdio::inherit())
                    .stderr(std::process::Stdio::inherit())
                    .stdin(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .spawn();
                match child {
                    Ok(mut c) => {
                        let _ = c.wait().await;
                        tracing::warn!("whatsapp: bridge process exited");
                    }
                    Err(e) => {
                        tracing::error!("whatsapp: failed to spawn bridge: {e}");
                    }
                }
            });
        }
    }

    // Spawn WebSocket + Web UI server
    let ws_port = config.ws_port;
    let vault_for_ws = config.vault_path.clone();
    tokio::spawn(async move {
        info!(port = ws_port, "ws: starting server");
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
        let addr = std::net::SocketAddr::from(([0, 0, 0, 0], ws_port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                if let Err(e) = axum::serve(listener, app).await {
                    tracing::error!("ws server error: {e}");
                }
            }
            Err(e) => {
                tracing::error!(port = ws_port, "ws: failed to bind port: {e}");
            }
        }
    });

    println!("All components running. Press Ctrl+C to stop.");
    println!();

    signal::ctrl_c().await?;
    println!("\nShutting down...");
    Ok(())
}

async fn start_discord(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    db: Arc<Database>,
) -> Result<()> {
    let token = config
        .relay
        .discord_token
        .as_ref()
        .context("Discord token not configured. Set relay.discord_token in ~/.hq/config.yaml")?;
    let api_key = config.openrouter_api_key.clone().unwrap_or_default();
    relay::run_discord_relay(token, vault, db, api_key, config.default_model.clone()).await
}

async fn start_telegram(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    db: Arc<Database>,
) -> Result<()> {
    let token = config
        .relay
        .telegram_token
        .as_ref()
        .context(
            "Telegram token not configured. Set relay.telegram_token in ~/.hq/config.yaml",
        )?;
    let api_key = config.openrouter_api_key.clone().unwrap_or_default();
    relay::run_telegram_relay(token, vault, db, api_key, config.default_model.clone()).await
}

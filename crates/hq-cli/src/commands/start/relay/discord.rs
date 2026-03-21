//! Discord relay — serenity bot with slash commands and harness dispatch.

use anyhow::{Context, Result};
use hq_db::Database;
use hq_vault::VaultClient;
use serenity::async_trait;
use serenity::builder::{CreateCommand, CreateCommandOption, CreateMessage, EditMessage};
use serenity::model::application::{Command, CommandOptionType, Interaction};
use serenity::model::prelude::*;
use serenity::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use tracing::info;

use crate::commands::start::common::*;
use crate::commands::start::harness::*;

// ─── Handler ─────────────────────────────────────────────────

struct Handler {
    api_key: String,
    #[allow(dead_code)]
    default_model: String,
    system_prompt: String,
    threads: Arc<TokioMutex<HashMap<u64, ChannelState>>>,
    skill_index: Arc<hq_tools::skills::SkillHintIndex>,
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

// ─── Event handler ───────────────────────────────────────────

#[async_trait]
impl EventHandler for Handler {
    async fn message(&self, ctx: serenity::prelude::Context, msg: Message) {
        if msg.author.bot {
            return;
        }

        let bot_id = ctx.cache.current_user().id;
        let is_mention = msg.mentions.iter().any(|u| u.id == bot_id);
        let is_dm = msg.guild_id.is_none();

        if !(is_mention || is_dm) {
            return;
        }

        // Strip bot mention from content
        let raw_content = msg
            .content
            .replace(&format!("<@{}>", bot_id), "")
            .replace(&format!("<@!{}>", bot_id), "")
            .trim()
            .to_string();
        if raw_content.is_empty() {
            return;
        }

        // Include reply-to context
        let content = if let Some(ref referenced) = msg.referenced_message {
            let who = if referenced.author.bot {
                "assistant"
            } else {
                &referenced.author.name
            };
            let reply_text: String = referenced.content.chars().take(500).collect();
            format!("[Replying to {who}: \"{reply_text}\"]\n\n{raw_content}")
        } else {
            raw_content
        };

        let channel_key = msg.channel_id.get();
        let content_lower = content.to_lowercase();

        // ── Commands ──
        if content_lower == "!reset" || content_lower == "!new" {
            let mut threads = self.threads.lock().await;
            threads.remove(&channel_key);
            let _ = msg
                .channel_id
                .say(&ctx.http, "Conversation reset. Session cleared.")
                .await;
            return;
        }

        if content_lower.starts_with("!harness ") || content_lower.starts_with("!switch ") {
            let name = content
                .split_whitespace()
                .nth(1)
                .unwrap_or("claude-code")
                .to_string();
            let canonical = canonical_harness(&name.to_lowercase());
            if !VALID_HARNESSES.contains(&name.to_lowercase().as_str()) {
                let _ = msg
                    .channel_id
                    .say(
                        &ctx.http,
                        &format!(
                            "Unknown harness `{name}`. Valid: {}",
                            VALID_HARNESSES.join(", ")
                        ),
                    )
                    .await;
                return;
            }
            let mut threads = self.threads.lock().await;
            let state = threads
                .entry(channel_key)
                .or_insert_with(ChannelState::new_default);
            state.harness = canonical.to_string();
            let _ = msg
                .channel_id
                .say(
                    &ctx.http,
                    &format!(
                        "Harness set to: **{}**",
                        harness_display(&state.harness)
                    ),
                )
                .await;
            return;
        }

        if content_lower.starts_with("!model ") {
            let name = content
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                let _ = msg.channel_id.say(&ctx.http, "Usage: `!model <name>`").await;
                return;
            }
            let resolved = resolve_model_alias(&name);
            let mut threads = self.threads.lock().await;
            let state = threads
                .entry(channel_key)
                .or_insert_with(ChannelState::new_default);
            state.model_override = Some(name.clone());
            let _ = msg
                .channel_id
                .say(
                    &ctx.http,
                    &format!("Model set to: `{resolved}` (applies to HQ harness)"),
                )
                .await;
            return;
        }

        if content_lower == "!help" {
            let _ = msg
                .channel_id
                .say(&ctx.http, &Self::make_help_text())
                .await;
            return;
        }

        if content_lower == "!status" {
            let status_text = format_status(&self.threads, channel_key).await;
            let _ = msg.channel_id.say(&ctx.http, &status_text).await;
            return;
        }

        // ── Chat flow — dispatch to active harness ──
        let typing_ctx = ctx.clone();
        let typing_channel = msg.channel_id;
        let typing_handle = tokio::spawn(async move {
            loop {
                let _ = typing_channel.broadcast_typing(&typing_ctx.http).await;
                tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            }
        });

        let (harness, session_id, model_override) = {
            let threads = self.threads.lock().await;
            let state = threads.get(&channel_key);
            let h = state
                .map(|s| s.harness.clone())
                .unwrap_or_else(|| "claude-code".to_string());
            let sid = state.and_then(|s| s.session_ids.get(&s.harness).cloned());
            let mo = state.and_then(|s| s.model_override.clone());
            (h, sid, mo)
        };

        let placeholder_result = msg
            .channel_id
            .send_message(&ctx.http, CreateMessage::new().content("Thinking\u{2026} \u{258D}"))
            .await;

        let mut placeholder_msg = match placeholder_result {
            Ok(m) => m,
            Err(e) => {
                tracing::error!("discord: failed to send placeholder: {e}");
                typing_handle.abort();
                return;
            }
        };

        let started_at = std::time::Instant::now();
        // Enrich system prompt with contextual skills for this message
        let enriched_prompt = hq_tools::skills::enrich_system_prompt(
            &self.skill_index, &self.system_prompt, &content,
        );
        let result: Result<String> = dispatch_harness(
            &harness,
            &content,
            session_id.as_deref(),
            model_override.as_deref(),
            &self.api_key,
            &enriched_prompt,
            &self.threads,
            channel_key,
            &ctx,
            &mut placeholder_msg,
            started_at,
        )
        .await;

        typing_handle.abort();

        // ── Deliver result ──
        match result {
            Ok(accumulated) if accumulated.is_empty() => {
                let _ = placeholder_msg
                    .edit(&ctx.http, EditMessage::new().content("No response received."))
                    .await;
            }
            Ok(accumulated) => {
                let _ = placeholder_msg.delete(&ctx.http).await;
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;

                let chunks = split_message(&accumulated, 2000);
                for chunk in chunks {
                    if let Err(e) = msg.channel_id.say(&ctx.http, &chunk).await {
                        tracing::error!("discord send error: {e}");
                    }
                }

                let _ = msg
                    .react(
                        &ctx.http,
                        ReactionType::Unicode("\u{2705}".to_string()),
                    )
                    .await;
            }
            Err(e) => {
                tracing::error!(harness = %harness, error = %e, "harness error");
                let _ = placeholder_msg
                    .edit(
                        &ctx.http,
                        EditMessage::new().content(&format!("Error ({harness}): {e}")),
                    )
                    .await;
            }
        }
    }

    async fn interaction_create(
        &self,
        ctx: serenity::prelude::Context,
        interaction: Interaction,
    ) {
        use serenity::builder::{CreateInteractionResponse, CreateInteractionResponseMessage};

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
                let name = cmd
                    .data
                    .options
                    .first()
                    .and_then(|o| match &o.value {
                        serenity::model::application::CommandDataOptionValue::String(s) => {
                            Some(s.clone())
                        }
                        _ => None,
                    })
                    .unwrap_or_default();
                if name.is_empty() {
                    "Usage: `/model <name>`".to_string()
                } else {
                    let resolved = resolve_model_alias(&name);
                    let mut threads = self.threads.lock().await;
                    let state = threads
                        .entry(channel_key)
                        .or_insert_with(ChannelState::new_default);
                    state.model_override = Some(name);
                    format!("Model set to: `{resolved}` (applies to HQ harness)")
                }
            }
            "harness" => {
                let name = cmd
                    .data
                    .options
                    .first()
                    .and_then(|o| match &o.value {
                        serenity::model::application::CommandDataOptionValue::String(s) => {
                            Some(s.clone())
                        }
                        _ => None,
                    })
                    .unwrap_or_default();
                if name.is_empty() {
                    "Usage: `/harness <name>`".to_string()
                } else {
                    let canonical = canonical_harness(&name.to_lowercase());
                    let mut threads = self.threads.lock().await;
                    let state = threads
                        .entry(channel_key)
                        .or_insert_with(ChannelState::new_default);
                    state.harness = canonical.to_string();
                    format!(
                        "Harness set to: **{}**",
                        harness_display(&state.harness)
                    )
                }
            }
            "status" => format_status_sync(&self.threads, channel_key),
            "help" => Self::make_help_text(),
            _ => "Unknown command.".to_string(),
        };

        let builder = CreateInteractionResponse::Message(
            CreateInteractionResponseMessage::new().content(response_text),
        );
        let _ = cmd.create_response(&ctx.http, builder).await;
    }

    async fn ready(&self, ctx: serenity::prelude::Context, ready: Ready) {
        info!(
            user = %ready.user.name,
            guilds = ready.guilds.len(),
            "discord: connected"
        );

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
                    CreateCommandOption::new(CommandOptionType::String, "name", "Harness name")
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
            CreateCommand::new("status").description("Show current harness, model, and session info"),
            CreateCommand::new("help").description("Show available commands"),
        ];

        match Command::set_global_commands(&ctx.http, commands).await {
            Ok(cmds) => info!(count = cmds.len(), "discord: registered slash commands"),
            Err(e) => tracing::error!("discord: failed to register slash commands: {e}"),
        }
    }
}

// ─── Harness dispatch (shared between message & slash commands) ──

#[allow(clippy::too_many_arguments)]
async fn dispatch_harness(
    harness: &str,
    content: &str,
    session_id: Option<&str>,
    model_override: Option<&str>,
    api_key: &str,
    system_prompt: &str,
    threads: &Arc<TokioMutex<HashMap<u64, ChannelState>>>,
    channel_key: u64,
    ctx: &serenity::prelude::Context,
    placeholder_msg: &mut Message,
    started_at: std::time::Instant,
) -> Result<String> {
    match harness {
        "hq" => {
            let messages_for_llm = {
                let mut t = threads.lock().await;
                let state = t.entry(channel_key).or_insert_with(ChannelState::new_default);
                state.harness = "hq".to_string();

                if state.messages.is_empty() {
                    state.messages.push(hq_core::types::ChatMessage {
                        role: hq_core::types::MessageRole::System,
                        content: system_prompt.to_string(),
                        tool_calls: vec![],
                        tool_call_id: None,
                    });
                }

                state.messages.push(hq_core::types::ChatMessage {
                    role: hq_core::types::MessageRole::User,
                    content: content.to_string(),
                    tool_calls: vec![],
                    tool_call_id: None,
                });

                if state.messages.len() > 30 {
                    let system = state.messages[0].clone();
                    let recent: Vec<_> = state.messages[state.messages.len() - 20..].to_vec();
                    state.messages = vec![system];
                    state.messages.extend(recent);
                }

                state.messages.clone()
            };

            match run_hq_harness_stream(api_key, messages_for_llm, model_override).await {
                Ok((text, _done)) => {
                    let mut t = threads.lock().await;
                    if let Some(state) = t.get_mut(&channel_key) {
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

        harness_name @ ("claude-code" | "opencode" | "gemini-cli" | "codex-cli" | "qwen-code"
        | "kilo-code" | "mistral-vibe") => {
            let harness_name_owned = harness_name.to_string();
            let content_clone = content.to_string();
            let session_id_clone = session_id.map(|s| s.to_string());
            let harness_clone = harness.to_string();

            let mut harness_handle = tokio::spawn(async move {
                run_cli_harness(
                    &harness_name_owned,
                    &content_clone,
                    session_id_clone.as_deref(),
                )
                .await
            });

            let edit_interval = std::time::Duration::from_secs(2);
            let mut edit_ticker = tokio::time::interval(edit_interval);
            edit_ticker.tick().await;

            // 5-minute heartbeat interval
            let heartbeat_interval = std::time::Duration::from_secs(300);
            let mut heartbeat_ticker = tokio::time::interval(heartbeat_interval);
            heartbeat_ticker.tick().await;

            let result = loop {
                tokio::select! {
                    result = &mut harness_handle => {
                        match result {
                            Ok(Ok((text, new_session_id))) => {
                                if let Some(sid) = new_session_id {
                                    let mut t = threads.lock().await;
                                    let state = t.entry(channel_key)
                                        .or_insert_with(ChannelState::new_default);
                                    state.session_ids.insert(harness_clone.clone(), sid);
                                }
                                break Ok(text);
                            }
                            Ok(Err(e)) => break Err(e),
                            Err(e) => break Err(anyhow::anyhow!("harness task panicked: {e}")),
                        }
                    }
                    _ = heartbeat_ticker.tick() => {
                        let elapsed = format_duration(started_at.elapsed());
                        let _ = placeholder_msg
                            .edit(
                                &ctx.http,
                                EditMessage::new().content(
                                    &format!("Still working\u{2026} ({elapsed} elapsed) \u{258D}")
                                ),
                            )
                            .await;
                    }
                    _ = edit_ticker.tick() => {
                        // Typing animation dots
                        let secs = started_at.elapsed().as_secs();
                        let dots = match (secs / 2) % 4 {
                            0 => ".",
                            1 => "..",
                            2 => "...",
                            _ => "",
                        };
                        let _ = placeholder_msg
                            .edit(
                                &ctx.http,
                                EditMessage::new().content(
                                    &format!("Thinking\u{2026}{dots} \u{258D}")
                                ),
                            )
                            .await;
                    }
                }
            };

            result
        }

        _ => {
            tracing::warn!(harness = %harness, "unknown harness, falling back to hq");
            match run_hq_harness_stream(
                api_key,
                vec![
                    hq_core::types::ChatMessage {
                        role: hq_core::types::MessageRole::System,
                        content: system_prompt.to_string(),
                        tool_calls: vec![],
                        tool_call_id: None,
                    },
                    hq_core::types::ChatMessage {
                        role: hq_core::types::MessageRole::User,
                        content: content.to_string(),
                        tool_calls: vec![],
                        tool_call_id: None,
                    },
                ],
                model_override,
            )
            .await
            {
                Ok((text, _)) => Ok(text),
                Err(e) => Err(e),
            }
        }
    }
}

// ─── Status helpers ──────────────────────────────────────────

async fn format_status(
    threads: &Arc<TokioMutex<HashMap<u64, ChannelState>>>,
    channel_key: u64,
) -> String {
    let threads = threads.lock().await;
    format_status_inner(&threads, channel_key)
}

fn format_status_sync(
    threads: &Arc<TokioMutex<HashMap<u64, ChannelState>>>,
    channel_key: u64,
) -> String {
    match threads.try_lock() {
        Ok(t) => format_status_inner(&t, channel_key),
        Err(_) => "Status unavailable (lock busy).".to_string(),
    }
}

fn format_status_inner(threads: &HashMap<u64, ChannelState>, channel_key: u64) -> String {
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

// ─── Public entry point ──────────────────────────────────────

pub async fn run_discord_relay(
    token: &str,
    vault: Arc<VaultClient>,
    _db: Arc<Database>,
    api_key: String,
    model: String,
) -> Result<()> {
    let system_prompt = load_system_prompt_with_env(&vault);
    info!(
        prompt_len = system_prompt.len(),
        "discord: loaded system prompt"
    );

    let skills_dir = vault.vault_path().join("skills");
    let skill_index = Arc::new(hq_tools::skills::SkillHintIndex::build(&skills_dir));

    let intents = GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::DIRECT_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT;

    let handler = Handler {
        api_key,
        default_model: model,
        system_prompt,
        threads: Arc::new(TokioMutex::new(HashMap::new())),
        skill_index,
    };

    let mut client = Client::builder(token, intents)
        .event_handler(handler)
        .await
        .context("failed to create Discord client")?;

    info!("discord: connecting to gateway...");
    client.start().await.context("Discord client error")?;
    Ok(())
}

//! Telegram relay — teloxide bot with media handling, voice transcription, harness dispatch.

use anyhow::Result;
use hq_db::Database;
use hq_vault::VaultClient;
use std::collections::HashMap;
use std::sync::Arc;
use teloxide::prelude::*;
use teloxide::types::{ChatAction, MessageId, ReactionType as TgReactionType, ReplyParameters};
use tokio::sync::Mutex as TokioMutex;
use tracing::info;

use crate::commands::start::common::*;
use crate::commands::start::harness::*;

// ─── Media handling ──────────────────────────────────────────

async fn download_file(
    bot: &Bot,
    token: &str,
    file_id: &str,
    dest: &std::path::Path,
) -> Result<std::path::PathBuf> {
    use teloxide::prelude::Requester;

    let tg_file = bot
        .get_file(file_id)
        .await
        .map_err(|e| anyhow::anyhow!("telegram get_file: {e}"))?;
    let file_path = tg_file.path;
    let url = format!("https://api.telegram.org/file/bot{token}/{file_path}");
    let bytes = reqwest::get(&url)
        .await
        .map_err(|_| anyhow::anyhow!("download file failed (id: {file_id})"))?
        .bytes()
        .await
        .map_err(|e| anyhow::anyhow!("read file bytes: {e}"))?;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(dest, &bytes)?;
    Ok(dest.to_path_buf())
}

async fn transcribe_voice_groq(audio_path: &std::path::Path, groq_api_key: &str) -> Result<String> {
    let file_bytes = tokio::fs::read(audio_path).await?;
    let file_name = audio_path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("audio.ogg")
        .to_string();

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str("audio/ogg")?;

    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-large-v3")
        .part("file", part);

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {groq_api_key}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("groq whisper request: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("groq whisper error {status}: {body}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("groq whisper parse: {e}"))?;
    Ok(json["text"].as_str().unwrap_or("").to_string())
}

async fn handle_media(
    bot: &Bot,
    msg: &teloxide::types::Message,
    text: String,
    vault_path: &std::path::Path,
    token: &str,
    groq_api_key: &str,
) -> String {
    let date_str = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let media_dir = vault_path.join("_media").join(&date_str);
    let mut augmented = text;

    // Photos
    if let Some(photos) = msg.photo() {
        if let Some(photo) = photos.last() {
            let filename = format!("photo_{}_{}.jpg", msg.id.0, photo.file.unique_id);
            let dest = media_dir.join(&filename);
            match download_file(bot, token, &photo.file.id, &dest).await {
                Ok(path) => augmented.push_str(&format!("\n[Image attached: {}]", path.display())),
                Err(e) => tracing::warn!("telegram: failed to download photo: {e}"),
            }
        }
    }

    // Documents
    if let Some(doc) = msg.document() {
        let filename = doc
            .file_name
            .clone()
            .unwrap_or_else(|| format!("doc_{}", doc.file.unique_id));
        let dest = media_dir.join(&filename);
        match download_file(bot, token, &doc.file.id, &dest).await {
            Ok(path) => {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let text_extensions = [
                    "txt", "csv", "md", "json", "yaml", "yml", "py", "ts", "js", "rs", "go",
                    "java", "c", "cpp", "h", "toml", "ini", "cfg", "sh", "bash", "zsh", "html",
                    "css", "xml", "sql", "rb", "php", "swift", "kt", "scala", "r",
                ];
                if text_extensions.contains(&ext.as_str()) {
                    match std::fs::read_to_string(&path) {
                        Ok(contents) => {
                            let truncated: String = contents.chars().take(10000).collect();
                            augmented.push_str(&format!(
                                "\n[Document: {} (saved to {})]\n```\n{}\n```",
                                filename,
                                path.display(),
                                truncated
                            ));
                        }
                        Err(_) => {
                            augmented
                                .push_str(&format!("\n[Document attached: {}]", path.display()));
                        }
                    }
                } else {
                    augmented.push_str(&format!("\n[Document attached: {}]", path.display()));
                }
            }
            Err(e) => tracing::warn!("telegram: failed to download document: {e}"),
        }
    }

    // Voice notes
    if let Some(voice) = msg.voice() {
        let filename = format!("voice_{}.ogg", msg.id.0);
        let dest = media_dir.join(&filename);
        match download_file(bot, token, &voice.file.id, &dest).await {
            Ok(path) => {
                if !groq_api_key.is_empty() {
                    match transcribe_voice_groq(&path, groq_api_key).await {
                        Ok(transcript) => {
                            augmented.push_str(&format!(
                                "\n[Voice note transcription (saved to {})]: {}",
                                path.display(),
                                transcript
                            ));
                        }
                        Err(e) => {
                            tracing::warn!("telegram: voice transcription failed: {e}");
                            augmented.push_str(&format!(
                                "\n[Voice note attached: {} (transcription failed)]",
                                path.display()
                            ));
                        }
                    }
                } else {
                    augmented.push_str(&format!(
                        "\n[Voice note attached: {} (no GROQ_API_KEY)]",
                        path.display()
                    ));
                }
            }
            Err(e) => tracing::warn!("telegram: failed to download voice: {e}"),
        }
    }

    // Videos
    if let Some(video) = msg.video() {
        let ext_owned = video
            .mime_type
            .as_ref()
            .map(|m| m.subtype().as_str().to_string())
            .unwrap_or_else(|| "mp4".to_string());
        let filename = format!("video_{}_{}.{}", msg.id.0, video.file.unique_id, ext_owned);
        let dest = media_dir.join(&filename);
        match download_file(bot, token, &video.file.id, &dest).await {
            Ok(path) => augmented.push_str(&format!("\n[Video attached: {}]", path.display())),
            Err(e) => tracing::warn!("telegram: failed to download video: {e}"),
        }
    }

    augmented
}

// ─── Public entry point ──────────────────────────────────────

pub async fn run_telegram_relay(
    token: &str,
    vault: Arc<VaultClient>,
    _db: Arc<Database>,
    api_key: String,
    model: String,
) -> Result<()> {
    info!("telegram: starting bot...");

    let system_prompt = load_system_prompt_with_env(&vault);
    info!(
        prompt_len = system_prompt.len(),
        "telegram: loaded system prompt"
    );

    let skills_dir = vault.vault_path().join("skills");
    let skill_index = Arc::new(hq_tools::skills::SkillHintIndex::build(&skills_dir));

    let vault_path = Arc::new(vault.vault_path().to_path_buf());
    let bot_token = Arc::new(token.to_string());
    let groq_key = Arc::new(std::env::var("GROQ_API_KEY").unwrap_or_default());

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
        let skill_index = skill_index.clone();
        let vault_path = vault_path.clone();
        let bot_token = bot_token.clone();
        let groq_key = groq_key.clone();
        async move {
            let raw_text = if let Some(t) = msg.text() {
                t.to_string()
            } else {
                msg.caption().map(|c| c.to_string()).unwrap_or_default()
            };

            let raw_text =
                handle_media(&bot, &msg, raw_text, &vault_path, &bot_token, &groq_key).await;

            if raw_text.is_empty() {
                return Ok(());
            }

            // Include reply context
            let text = if let Some(reply) = msg.reply_to_message() {
                if let Some(reply_text) = reply.text() {
                    let who = reply
                        .from
                        .as_ref()
                        .map(|u| {
                            if u.is_bot {
                                "assistant"
                            } else {
                                &u.first_name
                            }
                        })
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

            // Track channel presence for proactive notifications
            {
                let presence_dir = vault_path.join("_system");
                let presence_content = format!(
                    "platform: telegram\nchat_id: {chat_key}\nlast_active: {}",
                    chrono::Utc::now().to_rfc3339()
                );
                let _ = std::fs::write(presence_dir.join("CHANNEL-PRESENCE.md"), presence_content);
            }

            // Acknowledge receipt
            let _ = bot
                .set_message_reaction(msg.chat.id, user_msg_id)
                .reaction(vec![TgReactionType::Emoji {
                    emoji: "\u{1F440}".to_string(),
                }])
                .await;

            // Handle commands
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

            if text_lower == "/reset" || text_lower == "!reset" || text_lower == "!new" {
                let mut t = threads.lock().await;
                t.remove(&chat_key);
                bot.send_message(msg.chat.id, "Conversation reset. Session cleared.")
                    .await?;
                return Ok(());
            }

            if text_lower.starts_with("/harness ")
                || text_lower.starts_with("!harness ")
                || text_lower.starts_with("!switch ")
            {
                let name = text
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("claude-code")
                    .to_string();
                let canonical = canonical_harness(&name.to_lowercase());
                if !VALID_HARNESSES.contains(&name.to_lowercase().as_str()) {
                    bot.send_message(
                        msg.chat.id,
                        format!(
                            "Unknown harness `{name}`. Valid: {}",
                            VALID_HARNESSES.join(", ")
                        ),
                    )
                    .await?;
                    return Ok(());
                }
                let mut t = threads.lock().await;
                let state = t.entry(chat_key).or_insert_with(ChannelState::new_default);
                state.harness = canonical.to_string();
                bot.send_message(
                    msg.chat.id,
                    format!("Harness set to: {}", harness_display(&state.harness)),
                )
                .await?;
                return Ok(());
            }

            if text_lower.starts_with("/model ") || text_lower.starts_with("!model ") {
                let name = text
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("")
                    .to_string();
                if name.is_empty() {
                    bot.send_message(msg.chat.id, "Usage: `/model <name>`")
                        .await?;
                    return Ok(());
                }
                let resolved = resolve_model_alias(&name);
                let mut t = threads.lock().await;
                let state = t.entry(chat_key).or_insert_with(ChannelState::new_default);
                state.model_override = Some(name);
                bot.send_message(
                    msg.chat.id,
                    format!("Model set to: {resolved} (applies to HQ harness)"),
                )
                .await?;
                return Ok(());
            }

            if text_lower == "/help" || text_lower == "!help" {
                let help = [
                    "HQ Bot Commands",
                    "",
                    "/reset — Clear conversation history and kill running harness",
                    "/harness <name> — Switch harness",
                    "  Harnesses: claude-code (default), hq, opencode, gemini-cli, codex-cli, qwen-code, kilo-code, mistral-vibe",
                    "/model <name> — Set model for HQ harness",
                    "/status — Show current harness, model, session info",
                    "/help — Show this help",
                ]
                .join("\n");
                bot.send_message(msg.chat.id, help).await?;
                return Ok(());
            }

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
                )
                .await?;
                return Ok(());
            }

            // ── Chat flow — dispatch to active harness ──
            let typing_bot = bot.clone();
            let typing_chat_id = msg.chat.id;
            let typing_handle = tokio::spawn(async move {
                loop {
                    let _ = typing_bot
                        .send_chat_action(typing_chat_id, ChatAction::Typing)
                        .await;
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                }
            });

            let (harness, session_id, model_override) = {
                let t = threads.lock().await;
                let state = t.get(&chat_key);
                let h = state
                    .map(|s| s.harness.clone())
                    .unwrap_or_else(|| "claude-code".to_string());
                let sid = state.and_then(|s| s.session_ids.get(&s.harness).cloned());
                let mo = state.and_then(|s| s.model_override.clone());
                (h, sid, mo)
            };

            let placeholder_result = bot
                .send_message(msg.chat.id, "Thinking\u{2026} \u{258D}".to_string())
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
            let started_at = std::time::Instant::now();

            // ── Harness dispatch ──
            // Enrich system prompt with contextual skills for this message
            let enriched_prompt = hq_tools::skills::enrich_system_prompt(
                &skill_index, &system_prompt, &text,
            );

            let result: Result<String, anyhow::Error> = match harness.as_str() {
                "hq" => {
                    let messages_for_llm = {
                        let mut t = threads.lock().await;
                        let state =
                            t.entry(chat_key).or_insert_with(ChannelState::new_default);
                        state.harness = "hq".to_string();

                        if state.messages.is_empty() {
                            state.messages.push(hq_core::types::ChatMessage {
                                role: hq_core::types::MessageRole::System,
                                content: enriched_prompt.clone(),
                                tool_calls: vec![],
                                tool_call_id: None,
                            });
                        } else {
                            // Update system prompt with latest contextual skills
                            state.messages[0].content = enriched_prompt.clone();
                        }

                        state.messages.push(hq_core::types::ChatMessage {
                            role: hq_core::types::MessageRole::User,
                            content: text.clone(),
                            tool_calls: vec![],
                            tool_call_id: None,
                        });

                        if state.messages.len() > 30 {
                            let system_msg = state.messages[0].clone();
                            let recent: Vec<_> =
                                state.messages[state.messages.len() - 20..].to_vec();
                            state.messages = vec![system_msg];
                            state.messages.extend(recent);
                        }

                        state.messages.clone()
                    };

                    match run_hq_harness_stream(
                        &api_key,
                        messages_for_llm,
                        model_override.as_deref(),
                    )
                    .await
                    {
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
                        )
                        .await
                    });

                    let edit_interval = std::time::Duration::from_secs(3);
                    let mut edit_ticker = tokio::time::interval(edit_interval);
                    edit_ticker.tick().await;

                    // 5-minute heartbeat
                    let heartbeat_interval = std::time::Duration::from_secs(300);
                    let mut heartbeat_ticker = tokio::time::interval(heartbeat_interval);
                    heartbeat_ticker.tick().await;

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
                            _ = heartbeat_ticker.tick() => {
                                // 5-minute heartbeat notification
                                let elapsed = format_duration(started_at.elapsed());
                                let _ = bot
                                    .edit_message_text(
                                        msg.chat.id,
                                        placeholder_id,
                                        format!("Still working\u{2026} ({elapsed} elapsed) \u{258D}"),
                                    )
                                    .await;
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
                    tracing::warn!(harness = %harness, "unknown harness, falling back to hq");
                    match run_hq_harness_stream(
                        &api_key,
                        vec![
                            hq_core::types::ChatMessage {
                                role: hq_core::types::MessageRole::System,
                                content: enriched_prompt.clone(),
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
                    )
                    .await
                    {
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
    })
    .await;

    Ok(())
}

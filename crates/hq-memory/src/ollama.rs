//! Thin Ollama HTTP client — ported from vault-memory/src/ollamaClient.ts.
//!
//! Uses the local Ollama instance at http://localhost:11434.
//! Default model: qwen3.5:9b (free, local, always available).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::warn;

/// Default Ollama endpoint.
fn ollama_base() -> String {
    std::env::var("OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".into())
}

/// Default model for memory operations.
pub fn memory_model() -> String {
    std::env::var("MEMORY_MODEL").unwrap_or_else(|_| "qwen3.5:9b".into())
}

/// A chat message for the Ollama API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<OllamaChatMessage>,
    stream: bool,
}

#[derive(Deserialize)]
struct OllamaChatResponse {
    message: OllamaMessageContent,
}

#[derive(Deserialize)]
struct OllamaMessageContent {
    content: String,
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Deserialize)]
struct OllamaModel {
    name: String,
}

/// Chat with Ollama. Returns the assistant's response text.
pub async fn ollama_chat(messages: &[OllamaChatMessage], model: Option<&str>) -> Result<String> {
    let default_model = memory_model();
    let model = model.unwrap_or(&default_model).to_string();
    let client = reqwest::Client::new();

    let request = OllamaChatRequest {
        model,
        messages: messages.to_vec(),
        stream: false,
    };

    let res = client
        .post(format!("{}/api/chat", ollama_base()))
        .json(&request)
        .send()
        .await
        .context("Ollama HTTP request failed")?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!("Ollama error {status}: {body}");
    }

    let data: OllamaChatResponse = res.json().await.context("Failed to parse Ollama response")?;
    Ok(data.message.content.trim().to_string())
}

/// Generate JSON from Ollama with retry on parse failure (up to 3 attempts).
pub async fn ollama_json<T: serde::de::DeserializeOwned>(
    system_prompt: &str,
    user_prompt: &str,
    model: Option<&str>,
) -> Result<T> {
    let augmented_system = format!(
        "{system_prompt}\n\nRespond ONLY with valid JSON. No markdown fences, no explanation."
    );

    let mut messages = vec![
        OllamaChatMessage { role: "system".into(), content: augmented_system },
        OllamaChatMessage { role: "user".into(), content: user_prompt.into() },
    ];

    for attempt in 0..3 {
        let raw = ollama_chat(&messages, model).await?;

        // Strip any accidental markdown fences
        let cleaned = raw
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        match serde_json::from_str::<T>(cleaned) {
            Ok(parsed) => return Ok(parsed),
            Err(e) => {
                if attempt < 2 {
                    warn!(attempt, error = %e, "Ollama JSON parse failed, retrying");
                    messages.push(OllamaChatMessage { role: "assistant".into(), content: raw });
                    messages.push(OllamaChatMessage {
                        role: "user".into(),
                        content: "That was not valid JSON. Return ONLY the JSON object, nothing else.".into(),
                    });
                } else {
                    anyhow::bail!("Ollama failed to return valid JSON after 3 attempts: {e}");
                }
            }
        }
    }

    unreachable!()
}

/// Check if Ollama is running and the model is available.
pub async fn check_ollama_available(model: Option<&str>) -> bool {
    let default_model = memory_model();
    let model_prefix = model
        .unwrap_or(&default_model)
        .split(':')
        .next()
        .unwrap_or("");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build();

    let client = match client {
        Ok(c) => c,
        Err(_) => return false,
    };

    let res = match client.get(format!("{}/api/tags", ollama_base())).send().await {
        Ok(r) => r,
        Err(_) => return false,
    };

    if !res.status().is_success() {
        return false;
    }

    let data: OllamaTagsResponse = match res.json().await {
        Ok(d) => d,
        Err(_) => return false,
    };

    data.models.iter().any(|m| m.name.starts_with(model_prefix))
}

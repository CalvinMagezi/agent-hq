//! Image generation tool — generates images via OpenRouter API.
//!
//! Port of the TypeScript `generate_image` tool. Uses a cheapest-first model
//! fallback chain, saves output to vault/_jobs/outputs/, and returns a
//! `[FILE:]` marker for relay channels.

use anyhow::{Result, bail};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;

use crate::registry::HqTool;

const MODELS_CHEAPEST_FIRST: &[&str] = &[
    "google/gemini-2.5-flash-image",
    "google/gemini-3.1-flash-image-preview",
    "openai/gpt-5-image-mini",
];

const OR_BASE: &str = "https://openrouter.ai/api/v1";

/// Image generation via OpenRouter.
pub struct ImageGenTool {
    vault_path: PathBuf,
    http: Client,
}

impl ImageGenTool {
    pub fn new(vault_path: PathBuf) -> Self {
        Self {
            vault_path,
            http: Client::new(),
        }
    }

    async fn call_openrouter(
        &self,
        api_key: &str,
        model_id: &str,
        prompt: &str,
    ) -> Result<String> {
        let resp = self
            .http
            .post(format!("{OR_BASE}/chat/completions"))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .header("HTTP-Referer", "https://github.com/CalvinMagezi/agent-hq")
            .header("X-Title", "Agent-HQ")
            .timeout(std::time::Duration::from_secs(120))
            .json(&json!({
                "model": model_id,
                "messages": [{"role": "user", "content": prompt}],
                "modalities": ["image", "text"],
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            bail!("OpenRouter {status}: {body}");
        }

        let data: Value = resp.json().await?;
        let images = data
            .pointer("/choices/0/message/images")
            .and_then(|v| v.as_array());

        let images = match images {
            Some(imgs) if !imgs.is_empty() => imgs,
            _ => bail!("No images returned from {model_id}"),
        };

        let img = &images[0];
        // Try various response shapes
        let url = img
            .pointer("/image_url/url")
            .or_else(|| img.get("url"))
            .and_then(|v| v.as_str())
            .or_else(|| img.as_str());

        match url {
            Some(u) => Ok(u.to_string()),
            None => bail!("Could not extract image URL from OpenRouter response"),
        }
    }

    async fn save_image(&self, image_url: &str, model_id: &str) -> Result<(PathBuf, String)> {
        let (bytes, mime_type) = if image_url.starts_with("data:") {
            let comma_idx = image_url.find(',').unwrap_or(0);
            let header = &image_url[..comma_idx];
            let b64 = &image_url[comma_idx + 1..];
            use base64::Engine;
            let decoded = base64::engine::general_purpose::STANDARD.decode(b64)?;
            let mime = header
                .split(':')
                .nth(1)
                .and_then(|s| s.split(';').next())
                .unwrap_or("image/png")
                .to_string();
            (decoded, mime)
        } else {
            let resp = self
                .http
                .get(image_url)
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await?;
            let mime = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/png")
                .to_string();
            let bytes = resp.bytes().await?.to_vec();
            (bytes, mime)
        };

        let ext = mime_type
            .split('/')
            .nth(1)
            .unwrap_or("png")
            .replace("jpeg", "jpg");
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash = hex::encode(&hasher.finalize()[..4]);
        let now = chrono::Utc::now().timestamp_millis();
        let filename = format!("img-{now}-{hash}.{ext}");

        let output_dir = self.vault_path.join("_jobs").join("outputs");
        fs::create_dir_all(&output_dir).await?;
        let file_path = output_dir.join(&filename);
        fs::write(&file_path, &bytes).await?;

        Ok((file_path, model_id.to_string()))
    }
}

#[async_trait]
impl HqTool for ImageGenTool {
    fn name(&self) -> &str {
        "generate_image"
    }

    fn description(&self) -> &str {
        "Generate an image from a text prompt using AI models via OpenRouter. The image is saved to the vault and a markdown embed is returned."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "Text description of the image to generate" },
                "width": { "type": "integer", "description": "Image width in pixels (optional hint)" },
                "height": { "type": "integer", "description": "Image height in pixels (optional hint)" },
                "model": { "type": "string", "description": "Model override. Defaults to cheapest available." }
            },
            "required": ["prompt"]
        })
    }

    fn category(&self) -> &str {
        "creative"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let api_key = std::env::var("OPENROUTER_API_KEY")
            .map_err(|_| anyhow::anyhow!("OPENROUTER_API_KEY not configured"))?;

        let prompt = args
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let width = args.get("width").and_then(|v| v.as_u64());
        let height = args.get("height").and_then(|v| v.as_u64());
        let model_override = args.get("model").and_then(|v| v.as_str());

        let mut prompt_text = prompt.to_string();
        if let (Some(w), Some(h)) = (width, height) {
            prompt_text.push_str(&format!("\n\nDesired resolution: {w}x{h}"));
        }

        let models: Vec<&str> = if let Some(m) = model_override {
            vec![m]
        } else {
            MODELS_CHEAPEST_FIRST.to_vec()
        };

        let mut last_error = String::new();
        for model_id in &models {
            match self.call_openrouter(&api_key, model_id, &prompt_text).await {
                Ok(image_url) => {
                    let (file_path, model) = self.save_image(&image_url, model_id).await?;
                    let display_name = file_path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy();
                    return Ok(json!({
                        "message": format!(
                            "Image generated ({model}):\n[FILE: {} | {display_name}]",
                            file_path.display()
                        ),
                        "filePath": file_path.to_string_lossy(),
                        "model": model,
                    }));
                }
                Err(e) => {
                    last_error = e.to_string();
                    let is_transient = last_error.contains("404")
                        || last_error.contains("503")
                        || last_error.contains("429")
                        || last_error.contains("rate")
                        || last_error.contains("timeout")
                        || last_error.contains("No endpoints");
                    if !is_transient || model_override.is_some() {
                        bail!("{last_error}");
                    }
                    tracing::warn!("[imageGen] {model_id} failed ({last_error}), trying next...");
                }
            }
        }

        bail!("All image models failed. Last error: {last_error}")
    }
}

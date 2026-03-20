//! Local harness — spawn CLI coding assistants as child processes.

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};
use tracing::{debug, error, info, warn};

/// A local CLI harness that spawns coding assistants as child processes.
pub struct LocalHarness {
    /// Currently running child processes keyed by harness type.
    running: Arc<Mutex<HashMap<String, tokio::process::Child>>>,
}

impl LocalHarness {
    pub fn new() -> Self {
        Self {
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Run a harness with the given prompt and return the result text.
    ///
    /// Supported harness types: "claude-code", "hq".
    /// Applies a 10-minute timeout.
    pub async fn run(&self, harness_type: &str, prompt: &str) -> Result<String> {
        let ten_minutes = Duration::from_secs(600);

        match timeout(ten_minutes, self.spawn_and_collect(harness_type, prompt)).await {
            Ok(result) => result,
            Err(_) => {
                warn!(harness_type, "Harness timed out after 10 minutes");
                self.kill(harness_type).await;
                bail!("Harness '{harness_type}' timed out after 10 minutes")
            }
        }
    }

    /// Kill a running harness process by type.
    pub async fn kill(&self, harness_type: &str) {
        let mut running = self.running.lock().await;
        if let Some(mut child) = running.remove(harness_type) {
            info!(harness_type, "Killing harness process");
            let _ = child.kill().await;
        }
    }

    async fn spawn_and_collect(&self, harness_type: &str, prompt: &str) -> Result<String> {
        match harness_type {
            "claude-code" => self.run_claude_code(prompt).await,
            "hq" => self.run_hq(prompt).await,
            other => bail!("Unsupported harness type: {other}"),
        }
    }

    async fn run_claude_code(&self, prompt: &str) -> Result<String> {
        info!("Spawning claude-code harness");

        let mut child = Command::new("claude")
            .args([
                "--dangerously-skip-permissions",
                "--output-format",
                "stream-json",
                "--verbose",
                "--max-turns",
                "100",
                "-p",
                prompt,
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .context("Failed to spawn claude CLI")?;

        let stdout = child
            .stdout
            .take()
            .context("Failed to capture claude stdout")?;

        // Store the child so it can be killed
        {
            let mut running = self.running.lock().await;
            running.insert("claude-code".to_string(), child);
        }

        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut result_parts: Vec<String> = Vec::new();

        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }

            // Parse NDJSON — extract text from assistant content blocks
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(obj) => {
                    // Handle content_block_delta events
                    if let Some(event_type) = obj.get("type").and_then(|v| v.as_str()) {
                        match event_type {
                            "content_block_delta" => {
                                if let Some(delta) = obj.get("delta") {
                                    if let Some(text) = delta.get("text").and_then(|v| v.as_str())
                                    {
                                        result_parts.push(text.to_string());
                                    }
                                }
                            }
                            "assistant" => {
                                // Full assistant message
                                if let Some(content) =
                                    obj.get("content").and_then(|v| v.as_array())
                                {
                                    for block in content {
                                        if block.get("type").and_then(|v| v.as_str())
                                            == Some("text")
                                        {
                                            if let Some(text) =
                                                block.get("text").and_then(|v| v.as_str())
                                            {
                                                result_parts.push(text.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                            "result" => {
                                // Final result message
                                if let Some(text) =
                                    obj.get("result").and_then(|v| v.as_str())
                                {
                                    result_parts.push(text.to_string());
                                }
                            }
                            _ => {
                                debug!(event_type, "Ignoring NDJSON event");
                            }
                        }
                    }
                }
                Err(e) => {
                    debug!(%e, "Non-JSON line from claude, treating as text");
                    result_parts.push(line);
                }
            }
        }

        // Clean up
        {
            let mut running = self.running.lock().await;
            if let Some(mut child) = running.remove("claude-code") {
                let status = child.wait().await?;
                if !status.success() {
                    warn!(?status, "claude-code exited with non-zero status");
                }
            }
        }

        let result = result_parts.join("");
        if result.is_empty() {
            bail!("claude-code produced no output");
        }

        Ok(result)
    }

    async fn run_hq(&self, prompt: &str) -> Result<String> {
        info!("Spawning hq harness");

        let output = Command::new("hq")
            .args(["chat", "--non-interactive", "-m", prompt])
            .output()
            .await
            .context("Failed to spawn hq CLI")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!(%stderr, "hq harness failed");
            bail!("hq harness failed: {stderr}");
        }

        let result = String::from_utf8_lossy(&output.stdout).to_string();
        if result.trim().is_empty() {
            bail!("hq produced no output");
        }

        Ok(result)
    }
}

impl Default for LocalHarness {
    fn default() -> Self {
        Self::new()
    }
}

//! CLI harness subprocess runner with timeout protection and heartbeat notifications.

use anyhow::{Context, Result};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;
use tracing::info;

use super::builder::build_harness_command;
use super::ndjson::extract_text_from_ndjson;

// ─── Configuration ───────────────────────────────────────────

/// Configuration for harness execution with timeout and heartbeat support.
pub struct HarnessConfig {
    /// Maximum time before the harness is killed (default: 30 minutes).
    pub timeout: Duration,
    /// Interval between heartbeat notifications (default: 5 minutes).
    pub heartbeat_interval: Duration,
}

impl Default for HarnessConfig {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30 * 60),
            heartbeat_interval: Duration::from_secs(5 * 60),
        }
    }
}

// ─── Core runner ─────────────────────────────────────────────

/// Run a CLI harness subprocess, reading NDJSON from stdout.
///
/// Returns `(final_text, optional_session_id)`.
/// Protected by a configurable timeout (default 30 min).
pub async fn run_cli_harness(
    harness: &str,
    prompt: &str,
    session_id: Option<&str>,
) -> Result<(String, Option<String>)> {
    run_cli_harness_with_config(harness, prompt, session_id, &HarnessConfig::default()).await
}

/// Run a CLI harness with explicit configuration.
pub async fn run_cli_harness_with_config(
    harness: &str,
    prompt: &str,
    session_id: Option<&str>,
    config: &HarnessConfig,
) -> Result<(String, Option<String>)> {
    let (program, args, _supports_resume) = build_harness_command(harness, prompt, session_id);

    info!(harness, program = %program, "spawning CLI harness");

    let mut child = Command::new(&program)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context(format!(
            "failed to spawn `{program}` — is it installed and on PATH?"
        ))?;

    let stdout = child.stdout.take().unwrap();
    let mut reader = tokio::io::BufReader::new(stdout).lines();

    let mut accumulated = String::new();
    let mut found_session_id: Option<String> = None;
    let started = tokio::time::Instant::now();
    let deadline = tokio::time::sleep(config.timeout);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            // Timeout protection — kills runaway harnesses
            _ = &mut deadline => {
                tracing::warn!(
                    harness,
                    elapsed = ?started.elapsed(),
                    "harness timed out after {:?}, killing",
                    config.timeout
                );
                child.kill().await.ok();
                if accumulated.is_empty() {
                    anyhow::bail!(
                        "`{program}` timed out after {} with no output",
                        crate::commands::start::common::format_duration(config.timeout)
                    );
                }
                // Return partial output
                break;
            }
            line = reader.next_line() => {
                match line? {
                    Some(line) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        process_ndjson_line(&line, &mut accumulated, &mut found_session_id);
                    }
                    None => break, // EOF — process exited
                }
            }
        }
    }

    // Wait for process to finish (may already be done)
    let status = child.wait().await?;
    if !status.success() {
        if accumulated.is_empty() {
            anyhow::bail!("`{program}` exited with status {status}");
        }
        tracing::warn!(
            harness,
            status = %status,
            "CLI harness exited with non-zero status but produced output"
        );
    }

    Ok((accumulated, found_session_id))
}

// ─── Streaming variant ───────────────────────────────────────

/// Run a CLI harness with streaming — reads NDJSON line by line and calls
/// the callback with accumulated text as it grows.
///
/// Returns `(final_text, optional_session_id)`.
pub async fn run_cli_harness_streaming<F>(
    harness: &str,
    prompt: &str,
    session_id: Option<&str>,
    mut on_progress: F,
) -> Result<(String, Option<String>)>
where
    F: FnMut(&str) + Send,
{
    let config = HarnessConfig::default();
    let (program, args, _supports_resume) = build_harness_command(harness, prompt, session_id);

    info!(harness, program = %program, "spawning CLI harness (streaming)");

    let mut child = Command::new(&program)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context(format!(
            "failed to spawn `{program}` — is it installed and on PATH?"
        ))?;

    let stdout = child.stdout.take().unwrap();
    let mut reader = tokio::io::BufReader::new(stdout).lines();

    let mut accumulated = String::new();
    let mut found_session_id: Option<String> = None;
    let started = tokio::time::Instant::now();
    let deadline = tokio::time::sleep(config.timeout);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => {
                tracing::warn!(harness, "streaming harness timed out, killing");
                child.kill().await.ok();
                break;
            }
            line = reader.next_line() => {
                match line? {
                    Some(line) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        let prev_len = accumulated.len();
                        process_ndjson_line(&line, &mut accumulated, &mut found_session_id);
                        if accumulated.len() > prev_len {
                            on_progress(&accumulated);
                        }
                    }
                    None => break,
                }
            }
        }
    }

    let status = child.wait().await?;
    if !status.success() && accumulated.is_empty() {
        anyhow::bail!("`{program}` exited with status {status}");
    }

    Ok((accumulated, found_session_id))
}

// ─── Internal helpers ────────────────────────────────────────

fn process_ndjson_line(
    line: &str,
    accumulated: &mut String,
    found_session_id: &mut Option<String>,
) {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
        let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Skip "result" if we already have text from "assistant" — avoids duplicates
        if msg_type == "result" && !accumulated.is_empty() {
            if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                *found_session_id = Some(sid.to_string());
            }
            return;
        }

        if let Some(text) = extract_text_from_ndjson(&json) {
            accumulated.push_str(&text);
        }
        if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
            *found_session_id = Some(sid.to_string());
        }
    } else {
        // Not JSON — treat as plain text output (e.g., gemini-cli)
        if !accumulated.is_empty() {
            accumulated.push('\n');
        }
        accumulated.push_str(line);
    }
}

//! Shared types and helpers for the `start` command subsystem.

use hq_vault::VaultClient;
use std::collections::HashMap;
use std::path::Path;
use tracing::info;

// ─── Channel state (shared by Discord + Telegram relays) ─────

/// Per-channel conversation state with harness routing and per-harness session IDs.
#[derive(Clone)]
pub struct ChannelState {
    /// Chat history (only used by HQ harness for OpenRouter context).
    pub messages: Vec<hq_core::types::ChatMessage>,
    /// Active harness name.
    pub harness: String,
    /// Model override (only relevant for HQ harness).
    pub model_override: Option<String>,
    /// Per-harness session IDs for resume capability.
    pub session_ids: HashMap<String, String>,
}

impl ChannelState {
    pub fn new_default() -> Self {
        Self {
            messages: vec![],
            harness: "claude-code".to_string(),
            model_override: None,
            session_ids: HashMap::new(),
        }
    }
}

// ─── Model alias resolution ──────────────────────────────────

pub fn resolve_model_alias(name: &str) -> String {
    match name.to_lowercase().as_str() {
        "sonnet" => "anthropic/claude-sonnet-4".to_string(),
        "opus" => "anthropic/claude-opus-4".to_string(),
        "haiku" => "anthropic/claude-haiku-4-5".to_string(),
        "gemini" | "flash" => "google/gemini-2.5-flash".to_string(),
        "gemini-pro" => "google/gemini-2.5-pro".to_string(),
        "gpt4" => "openai/gpt-4.1".to_string(),
        "kimi" | "k2.5" => "moonshotai/kimi-k2.5".to_string(),
        other => other.to_string(),
    }
}

// ─── System prompt loader ────────────────────────────────────

pub fn load_system_prompt(vault: &VaultClient) -> String {
    let soul_path = vault.vault_path().join("_system").join("SOUL.md");
    if soul_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&soul_path) {
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

// ─── Environment discovery ──────────────────────────────────

/// Probe the runtime environment and return a context block describing it.
/// This helps the agent understand where it's running and what's available.
pub fn discover_environment() -> String {
    let mut lines = Vec::new();

    // Detect container vs bare metal
    let in_docker = Path::new("/.dockerenv").exists()
        || std::fs::read_to_string("/proc/1/cgroup")
            .map(|s| s.contains("docker") || s.contains("containerd"))
            .unwrap_or(false);

    if in_docker {
        lines.push("**Runtime**: Docker container".to_string());
    } else {
        lines.push("**Runtime**: Bare metal / local machine".to_string());
    }

    // Hostname
    if let Ok(hostname) = std::env::var("HOSTNAME") {
        lines.push(format!("**Hostname**: {hostname}"));
    }

    // Scan key directories
    let probe_dirs = [
        ("/agent", "Agent harness"),
        ("/workspace", "Workspace (mounted files)"),
        ("/app", "Application directory"),
    ];
    for (path, label) in &probe_dirs {
        if Path::new(path).is_dir() {
            // List top-level contents (max 10 entries)
            let entries: Vec<String> = std::fs::read_dir(path)
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .take(10)
                .map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if e.path().is_dir() {
                        format!("{name}/")
                    } else {
                        name
                    }
                })
                .collect();
            if !entries.is_empty() {
                lines.push(format!("**{label}** (`{path}`): {}", entries.join(", ")));
            } else {
                lines.push(format!("**{label}** (`{path}`): (empty)"));
            }
        }
    }

    // Check for vault
    if let Ok(cwd) = std::env::current_dir() {
        let vault_path = cwd.join(".vault");
        if vault_path.is_dir() {
            lines.push(format!("**Vault**: `{}`", vault_path.display()));
        }
    }

    // Check for HQ config
    if let Some(home) = dirs::home_dir() {
        let hq_config = home.join(".hq").join("config.yaml");
        if hq_config.exists() {
            lines.push(format!("**HQ Config**: `{}`", hq_config.display()));
        }
    }

    // Available CLI tools (check via `command -v` / path probe)
    let tools = ["gws", "hq-rs", "git", "node", "python3", "cargo"];
    let available: Vec<&str> = tools
        .iter()
        .filter(|t| {
            std::process::Command::new("sh")
                .args(["-c", &format!("command -v {t}")])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .copied()
        .collect();
    if !available.is_empty() {
        lines.push(format!("**CLI tools**: {}", available.join(", ")));
    }

    if lines.is_empty() {
        return String::new();
    }

    format!("\n\n---\n\n## Runtime Environment\n\n{}", lines.join("\n"))
}

/// Load system prompt from SOUL.md and append runtime environment context.
pub fn load_system_prompt_with_env(vault: &VaultClient) -> String {
    let soul = load_system_prompt(vault);
    let env_block = discover_environment();
    if env_block.is_empty() {
        soul
    } else {
        format!("{soul}{env_block}")
    }
}

// ─── Message chunking ────────────────────────────────────────

pub fn split_message(text: &str, max_len: usize) -> Vec<String> {
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
        let search = &remaining[..max_len];
        let split_at = search
            .rfind("\n\n")
            .or_else(|| search.rfind('\n'))
            .or_else(|| search.rfind(' '))
            .unwrap_or(max_len);
        chunks.push(remaining[..split_at].to_string());
        remaining = remaining[split_at..].trim_start();
    }
    chunks
}

// ─── Logging helper ──────────────────────────────────────────

/// Format a duration as a human-friendly string like "5m 23s".
pub fn format_duration(d: std::time::Duration) -> String {
    let secs = d.as_secs();
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
    }
}

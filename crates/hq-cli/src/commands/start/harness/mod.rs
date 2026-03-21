//! CLI harness subsystem — build commands, run subprocesses, parse NDJSON output.

pub mod builder;
pub mod hq;
pub mod ndjson;
pub mod runner;

pub use builder::build_harness_command;
pub use hq::{run_hq_harness_stream, HQ_MODELS};
pub use ndjson::extract_text_from_ndjson;
pub use runner::{run_cli_harness, run_cli_harness_streaming, HarnessConfig};

/// Valid harness names for user-facing commands.
pub const VALID_HARNESSES: &[&str] = &[
    "hq",
    "claude-code",
    "claude",
    "opencode",
    "gemini-cli",
    "gemini",
    "codex-cli",
    "codex",
    "qwen-code",
    "qwen",
    "kilo-code",
    "kilo",
    "mistral-vibe",
    "vibe",
];

/// Canonical harness name (normalize aliases).
pub fn canonical_harness(name: &str) -> &'static str {
    match name {
        "claude" | "claude-code" => "claude-code",
        "opencode" => "opencode",
        "gemini" | "gemini-cli" => "gemini-cli",
        "codex" | "codex-cli" => "codex-cli",
        "qwen" | "qwen-code" => "qwen-code",
        "kilo" | "kilo-code" => "kilo-code",
        "vibe" | "mistral-vibe" => "mistral-vibe",
        _ => "hq",
    }
}

/// Display name for a harness (for status messages).
pub fn harness_display(harness: &str) -> String {
    match harness {
        "claude-code" => "claude-code (Claude CLI)".to_string(),
        "opencode" => "opencode (OpenCode CLI)".to_string(),
        "gemini-cli" => "gemini-cli (Gemini CLI)".to_string(),
        "codex-cli" => "codex-cli (Codex CLI)".to_string(),
        "qwen-code" => "qwen-code (Qwen CLI)".to_string(),
        "kilo-code" => "kilo-code (Kilo CLI)".to_string(),
        "mistral-vibe" => "mistral-vibe (Vibe CLI)".to_string(),
        "hq" => format!("hq (OpenRouter: {})", HQ_MODELS[0]),
        other => other.to_string(),
    }
}

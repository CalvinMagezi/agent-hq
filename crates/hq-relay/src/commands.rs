//! Command dispatch — handles `!` prefixed commands from chat.

use crate::orchestrator::SessionOrchestrator;
use crate::thread::ThreadStore;

/// Dispatch a command and return the response text.
///
/// Supported commands:
/// - `!reset` — Reset the current thread
/// - `!model` — Show or set the active model
/// - `!help` — Show available commands
/// - `!status` — Show bot status
/// - `!sessions` — List active sessions
/// - `!harness` — Show or set the active harness
/// - `!search <query>` — Search the vault
/// - `!memory` — Show memory/context info
pub async fn dispatch_command(
    input: &str,
    chat_id: &str,
    thread_store: &mut ThreadStore,
    orchestrator: &SessionOrchestrator,
    current_model: &str,
    current_harness: &str,
) -> String {
    let parts: Vec<&str> = input.trim().splitn(2, ' ').collect();
    let cmd = parts[0].to_lowercase();
    let args = parts.get(1).copied().unwrap_or("");

    match cmd.as_str() {
        "!reset" => {
            // Reset the thread by creating a fresh one
            if let Ok(_thread) = thread_store.get_or_create(chat_id, hq_core::types::PlatformId::Web) {
                // The thread is re-created on next message if we just clear it
                format!("Thread reset. Starting fresh conversation.")
            } else {
                "Failed to reset thread.".to_string()
            }
        }

        "!model" => {
            if args.is_empty() {
                format!("Current model: **{current_model}**")
            } else {
                format!("Model switching is not yet supported via relay commands. Current: **{current_model}**")
            }
        }

        "!help" => {
            [
                "**Available Commands:**",
                "• `!reset` — Reset conversation thread",
                "• `!model [name]` — Show/set active model",
                "• `!harness [type]` — Show/set active harness",
                "• `!status` — Show bot status",
                "• `!sessions` — List active sessions",
                "• `!search <query>` — Search the vault",
                "• `!memory` — Show memory/context info",
                "• `!help` — Show this help",
            ]
            .join("\n")
        }

        "!status" => {
            let sessions = orchestrator.list_sessions().await;
            let active = sessions
                .iter()
                .filter(|s| {
                    matches!(
                        s.state,
                        crate::orchestrator::SessionState::Working
                            | crate::orchestrator::SessionState::Spawning
                    )
                })
                .count();
            let threads = thread_store
                .list_threads()
                .unwrap_or_default()
                .len();

            format!(
                "**Status:**\n• Active sessions: {active}\n• Total sessions: {}\n• Threads: {threads}\n• Model: {current_model}\n• Harness: {current_harness}",
                sessions.len()
            )
        }

        "!sessions" => {
            let sessions = orchestrator.list_sessions().await;
            if sessions.is_empty() {
                return "No sessions.".to_string();
            }
            let mut lines = vec!["**Sessions:**".to_string()];
            for s in &sessions {
                let state_str = match &s.state {
                    crate::orchestrator::SessionState::Spawning => "spawning",
                    crate::orchestrator::SessionState::Working => "working",
                    crate::orchestrator::SessionState::Done => "done",
                    crate::orchestrator::SessionState::Failed(_) => "failed",
                    crate::orchestrator::SessionState::Stuck => "stuck",
                    crate::orchestrator::SessionState::TimedOut => "timed out",
                };
                lines.push(format!(
                    "• `{}` — {} ({}) since {}",
                    &s.session_id[..8.min(s.session_id.len())],
                    state_str,
                    s.harness_type,
                    s.started_at.format("%H:%M:%S")
                ));
            }
            lines.join("\n")
        }

        "!harness" => {
            if args.is_empty() {
                format!("Current harness: **{current_harness}**")
            } else {
                let valid = ["claude-code", "hq"];
                if valid.contains(&args) {
                    let _ = thread_store.set_harness(chat_id, Some(args.to_string()));
                    format!("Harness set to **{args}**")
                } else {
                    format!(
                        "Unknown harness '{}'. Available: {}",
                        args,
                        valid.join(", ")
                    )
                }
            }
        }

        "!search" => {
            if args.is_empty() {
                "Usage: `!search <query>`".to_string()
            } else {
                format!("Vault search for '{}' is not yet implemented in relay mode.", args)
            }
        }

        "!memory" => {
            let ctx = thread_store
                .get_context(chat_id, 500)
                .unwrap_or_default();
            let msg_count = ctx.lines().count();
            format!(
                "**Memory:**\n• Thread messages in context: {msg_count}\n• Model: {current_model}\n• Harness: {current_harness}"
            )
        }

        _ => {
            format!("Unknown command: `{cmd}`. Type `!help` for available commands.")
        }
    }
}

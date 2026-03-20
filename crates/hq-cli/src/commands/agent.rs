use anyhow::Result;
use hq_core::config::HqConfig;
use hq_vault::VaultClient;
use std::process::Command as StdCommand;

/// Spawn a contextualized agent session with vault context.
pub async fn run(config: &HqConfig, harness: &str) -> Result<()> {
    let vault = VaultClient::new(config.vault_path.clone())?;
    let vault_path = &config.vault_path;

    match harness {
        "hq" => {
            // Use built-in chat
            super::chat::run(config, None).await?;
        }
        "claude" | "gemini" | "opencode" | "codex" => {
            // Read vault context
            let ctx = vault.get_system_context()?;

            // Build context string
            let pinned_snippets: String = ctx
                .pinned_notes
                .iter()
                .take(5)
                .map(|n| format!("- **{}**: {}", n.title, n.content.chars().take(300).collect::<String>()))
                .collect::<Vec<_>>()
                .join("\n");

            let context = format!(
                "# Agent-HQ: Vault Context & Governance\n\n## Identity\n{}\n\n## Memory\n{}\n\n## Preferences\n{}\n\n{}\n\n## Governance — Security Profile: STANDARD\n\nYou are operating as part of the Agent-HQ ecosystem.\n\n### Rules\n- **Never** delete files, force-push git, or run irreversible scripts without approval.\n- **Never** expose or log API keys or secrets.\n\n### Vault Path\nYour vault is at: {}\n",
                if ctx.soul.is_empty() { "You are a helpful AI assistant." } else { &ctx.soul },
                if ctx.memory.is_empty() { "(no memory yet)" } else { &ctx.memory },
                if ctx.preferences.is_empty() { "(no preferences set)" } else { &ctx.preferences },
                if pinned_snippets.is_empty() { String::new() } else { format!("## Pinned Notes\n{}", pinned_snippets) },
                vault_path.display(),
            );

            println!("Launching {} with vault context from {}", harness, vault_path.display());
            println!();

            // Inject context per harness
            let work_dir = std::env::current_dir()?;

            match harness {
                "claude" => {
                    let claude_md = work_dir.join("CLAUDE.md");
                    let existing = if claude_md.exists() {
                        std::fs::read_to_string(&claude_md)?
                    } else {
                        String::new()
                    };

                    let start_marker = "<!-- agent-hq:start -->";
                    let end_marker = "<!-- agent-hq:end -->";
                    let block = format!("{}\n{}\n{}", start_marker, context, end_marker);

                    let new_content = if existing.contains(start_marker) {
                        let _re_pattern = format!(r"{}[\s\S]*?{}", regex_escape(start_marker), regex_escape(end_marker));
                        existing.replace(
                            &find_between(&existing, start_marker, end_marker).unwrap_or_default(),
                            &block,
                        )
                    } else {
                        format!("{}\n\n{}", block, existing)
                    };

                    std::fs::write(&claude_md, &new_content)?;

                    let _ = StdCommand::new("claude")
                        .current_dir(&work_dir)
                        .status();

                    // Clean up injected block
                    if claude_md.exists() {
                        let current = std::fs::read_to_string(&claude_md)?;
                        if let Some(cleaned) = remove_block(&current, start_marker, end_marker) {
                            let trimmed = cleaned.trim();
                            if trimmed.is_empty() && existing.is_empty() {
                                let _ = std::fs::remove_file(&claude_md);
                            } else {
                                std::fs::write(&claude_md, format!("{}\n", trimmed))?;
                            }
                        }
                    }
                }
                "gemini" | "opencode" | "codex" => {
                    let agents_md = work_dir.join("AGENTS.md");
                    let existing = if agents_md.exists() {
                        std::fs::read_to_string(&agents_md)?
                    } else {
                        String::new()
                    };

                    let start_marker = "<!-- agent-hq:start -->";
                    let end_marker = "<!-- agent-hq:end -->";
                    let block = format!("{}\n{}\n{}", start_marker, context, end_marker);

                    let new_content = if existing.contains(start_marker) {
                        existing.replace(
                            &find_between(&existing, start_marker, end_marker).unwrap_or_default(),
                            &block,
                        )
                    } else {
                        format!("{}\n\n{}", block, existing)
                    };

                    std::fs::write(&agents_md, &new_content)?;

                    let _ = StdCommand::new(harness)
                        .current_dir(&work_dir)
                        .status();

                    // Clean up
                    if agents_md.exists() {
                        let current = std::fs::read_to_string(&agents_md)?;
                        if let Some(cleaned) = remove_block(&current, start_marker, end_marker) {
                            let trimmed = cleaned.trim();
                            if trimmed.is_empty() && existing.is_empty() {
                                let _ = std::fs::remove_file(&agents_md);
                            } else {
                                std::fs::write(&agents_md, format!("{}\n", trimmed))?;
                            }
                        }
                    }
                }
                _ => unreachable!(),
            }
        }
        _ => {
            println!("Unknown harness: {}", harness);
            println!("Valid: hq, claude, codex, gemini, opencode");
            std::process::exit(1);
        }
    }

    Ok(())
}

fn find_between(text: &str, start: &str, end: &str) -> Option<String> {
    let start_pos = text.find(start)?;
    let end_pos = text[start_pos..].find(end)? + start_pos + end.len();
    Some(text[start_pos..end_pos].to_string())
}

fn remove_block(text: &str, start: &str, end: &str) -> Option<String> {
    let block = find_between(text, start, end)?;
    Some(text.replace(&block, "").replace("\n\n\n", "\n\n"))
}

fn regex_escape(s: &str) -> String {
    s.replace('!', r"\!")
        .replace('<', r"\<")
        .replace('>', r"\>")
        .replace('-', r"\-")
}

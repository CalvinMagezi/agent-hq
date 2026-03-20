use anyhow::Result;
use hq_core::config::HqConfig;

/// Show recent error log lines for services.
pub async fn run(_config: &HqConfig, target: &str, lines: usize) -> Result<()> {
    let targets = resolve_targets(target);

    for target in &targets {
        let err_path = error_log_path_for(target);
        println!("\n── {} errors — last {} lines ──\n", target, lines);

        if err_path.exists() {
            let content = std::fs::read_to_string(&err_path)?;
            let all_lines: Vec<&str> = content.lines().collect();
            let start = all_lines.len().saturating_sub(lines);
            for line in &all_lines[start..] {
                println!("{}", line);
            }
            if all_lines.is_empty() {
                println!("(no errors)");
            }
        } else {
            println!("(no error log yet)");
        }
    }

    // Also show failed jobs from vault
    println!("\n── Failed jobs ──\n");
    let vault_path = &_config.vault_path;
    let failed_dir = vault_path.join("_jobs/failed");
    if failed_dir.exists() {
        let mut entries: Vec<_> = std::fs::read_dir(&failed_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
            .collect();

        entries.sort_by(|a, b| {
            b.metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                .cmp(
                    &a.metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                )
        });

        if entries.is_empty() {
            println!("  No failed jobs");
        }

        for entry in entries.iter().take(lines) {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            println!("  {}", name);
        }
    } else {
        println!("  No failed jobs directory");
    }

    Ok(())
}

fn resolve_targets(target: &str) -> Vec<String> {
    match target {
        "all" => vec!["agent".into(), "relay".into(), "daemon".into()],
        other => vec![other.to_string()],
    }
}

fn error_log_path_for(target: &str) -> std::path::PathBuf {
    let log_dir = if cfg!(target_os = "macos") {
        dirs::home_dir()
            .unwrap_or_default()
            .join("Library/Logs")
    } else {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".local/share/agent-hq/logs")
    };

    let filename = match target {
        "agent" => "hq-agent.error.log",
        "relay" | "discord" => "discord-relay.error.log",
        "daemon" => "hq-daemon.error.log",
        "whatsapp" | "wa" => "agent-hq-whatsapp.error.log",
        "telegram" | "tg" => "agent-hq-telegram.error.log",
        "relay-server" => "agent-hq-relay-server.error.log",
        other => {
            return log_dir.join(format!("hq-{}.error.log", other));
        }
    };

    log_dir.join(filename)
}

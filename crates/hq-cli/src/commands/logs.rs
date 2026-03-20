use anyhow::Result;
use hq_core::config::HqConfig;

/// Show recent service log lines.
pub async fn run(_config: &HqConfig, target: &str, lines: usize) -> Result<()> {
    let targets = resolve_targets(target);

    for target in &targets {
        let log_path = log_path_for(target);
        println!("\n── {} — last {} lines ──\n", target, lines);

        if log_path.exists() {
            let content = std::fs::read_to_string(&log_path)?;
            let all_lines: Vec<&str> = content.lines().collect();
            let start = all_lines.len().saturating_sub(lines);
            for line in &all_lines[start..] {
                println!("{}", line);
            }
            if all_lines.is_empty() {
                println!("(empty)");
            }
        } else {
            println!("(no log file yet)");
        }
    }

    Ok(())
}

fn resolve_targets(target: &str) -> Vec<String> {
    match target {
        "all" => vec![
            "agent".into(),
            "relay".into(),
            "daemon".into(),
        ],
        other => vec![other.to_string()],
    }
}

fn log_path_for(target: &str) -> std::path::PathBuf {
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
        "agent" => "hq-agent.log",
        "relay" | "discord" => "discord-relay.log",
        "daemon" => "hq-daemon.log",
        "whatsapp" | "wa" => "agent-hq-whatsapp.log",
        "telegram" | "tg" => "agent-hq-telegram.log",
        "relay-server" => "agent-hq-relay-server.log",
        "vault-sync" => "agent-hq-vault-sync.log",
        "pwa" => "agent-hq-pwa.log",
        other => {
            // Generic fallback
            return log_dir.join(format!("hq-{}.log", other));
        }
    };

    log_dir.join(filename)
}

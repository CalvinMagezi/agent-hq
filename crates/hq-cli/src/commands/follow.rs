use anyhow::Result;
use hq_core::config::HqConfig;
use std::process::Command;

/// Follow (tail -f) log files for services.
pub async fn run(_config: &HqConfig, target: &str) -> Result<()> {
    let targets = match target {
        "all" => vec!["agent", "relay", "daemon"],
        other => vec![other],
    };

    let log_dir = if cfg!(target_os = "macos") {
        dirs::home_dir()
            .unwrap_or_default()
            .join("Library/Logs")
    } else {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".local/share/agent-hq/logs")
    };

    let files: Vec<String> = targets
        .iter()
        .map(|t| {
            let filename = match *t {
                "agent" => "hq-agent.log",
                "relay" | "discord" => "discord-relay.log",
                "daemon" => "hq-daemon.log",
                "whatsapp" | "wa" => "agent-hq-whatsapp.log",
                "telegram" | "tg" => "agent-hq-telegram.log",
                "relay-server" => "agent-hq-relay-server.log",
                other => return log_dir.join(format!("hq-{}.log", other)).to_string_lossy().to_string(),
            };
            log_dir.join(filename).to_string_lossy().to_string()
        })
        .filter(|f| std::path::Path::new(f).exists())
        .collect();

    if files.is_empty() {
        println!("No log files found for: {}", target);
        return Ok(());
    }

    println!("Following {} log(s) (Ctrl+C to stop)...\n", files.len());

    let mut cmd = Command::new("tail");
    cmd.arg("-f");
    for file in &files {
        cmd.arg(file);
    }

    let mut child = cmd.spawn()?;
    child.wait()?;

    Ok(())
}

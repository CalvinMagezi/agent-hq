use anyhow::Result;
use hq_core::config::HqConfig;
use std::process::Command;

/// Force-kill all Agent HQ processes.
pub async fn run(_config: &HqConfig) -> Result<()> {
    println!("Killing all Agent HQ processes...\n");

    let mut killed = 0;

    // Kill known daemon processes
    let daemons = [
        "com.agent-hq.agent",
        "com.agent-hq.discord-relay",
        "com.agent-hq.relay-server",
        "com.agent-hq.whatsapp",
        "com.agent-hq.telegram",
        "com.agent-hq.vault-sync",
        "com.agent-hq.pwa",
    ];

    for daemon in &daemons {
        // Check PID file
        let pid_dir = if cfg!(target_os = "macos") {
            dirs::home_dir()
                .unwrap_or_default()
                .join("Library/Logs")
        } else {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local/share/agent-hq/pids")
        };

        let pid_file = pid_dir.join(format!("{}.pid", daemon));
        if pid_file.exists() {
            if let Ok(pid_str) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                    #[cfg(unix)]
                    {
                        let _ = Command::new("kill")
                            .args(["-9", &pid.to_string()])
                            .output();
                    }
                    killed += 1;
                    println!("  Killed {} (PID {})", daemon, pid);
                }
            }
            let _ = std::fs::remove_file(&pid_file);
        }

        // Stop via launchd on macOS
        #[cfg(target_os = "macos")]
        {
            let _ = Command::new("launchctl")
                .args(["stop", daemon])
                .output();
        }
    }

    // Kill CLI harness processes
    #[cfg(unix)]
    {
        let patterns = [
            "claude.*--resume|claude.*--print|claude.*--output-format",
            "opencode run",
            "gemini.*--output-format|gemini.*--yolo",
        ];

        for pattern in &patterns {
            let _ = Command::new("pkill")
                .args(["-9", "-f", pattern])
                .output();
        }
    }

    // Clean relay lock
    let relay_lock = dirs::home_dir()
        .unwrap_or_default()
        .join(".discord-relay/bot.lock");
    if relay_lock.exists() {
        let _ = std::fs::remove_file(&relay_lock);
        println!("  Removed relay lock file");
    }

    if killed == 0 {
        println!("No processes were running.");
    } else {
        println!("\nKilled {} process(es). Done.", killed);
    }

    Ok(())
}

use anyhow::Result;
use hq_core::config::HqConfig;
use std::path::PathBuf;

/// Stop running HQ components by sending SIGTERM to their PID files.
pub async fn run(config: &HqConfig, component: &str) -> Result<()> {
    let targets = resolve_targets(component);

    for target in &targets {
        let pid_file = pid_path_for(config, target);
        if pid_file.exists() {
            let pid_str = std::fs::read_to_string(&pid_file)?.trim().to_string();
            if let Ok(pid) = pid_str.parse::<u32>() {
                if is_alive(pid) {
                    #[cfg(unix)]
                    {
                        use std::process::Command;
                        let _ = Command::new("kill").arg(pid.to_string()).output();
                        println!("Stopped {} (PID {})", target, pid);
                    }
                    #[cfg(not(unix))]
                    {
                        println!("Cannot stop {} on this platform (PID {})", target, pid);
                    }
                } else {
                    println!("{} was not running (stale PID file)", target);
                }
            }
            let _ = std::fs::remove_file(&pid_file);
        } else {
            println!("{} was not running", target);
        }
    }

    Ok(())
}

fn resolve_targets(component: &str) -> Vec<String> {
    match component {
        "all" => vec![
            "agent".into(),
            "relay".into(),
            "daemon".into(),
            "relay-server".into(),
        ],
        other => vec![other.to_string()],
    }
}

fn pid_path_for(_config: &HqConfig, target: &str) -> PathBuf {
    let pid_dir = if cfg!(target_os = "macos") {
        dirs::home_dir()
            .unwrap_or_default()
            .join("Library/Logs")
    } else {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".local/share/agent-hq/pids")
    };
    pid_dir.join(format!("com.agent-hq.{}.pid", target))
}

fn is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        use std::process::Command;
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

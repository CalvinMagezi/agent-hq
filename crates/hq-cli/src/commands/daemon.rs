use anyhow::Result;
use hq_core::config::HqConfig;
use std::path::PathBuf;

/// Daemon management: start, stop, status, logs.
pub async fn run(_config: &HqConfig, sub: &str, arg: Option<&str>) -> Result<()> {
    let pid_path = daemon_pid_path();
    let log_path = daemon_log_path();

    match sub {
        "status" | "" => {
            if let Some(pid) = read_pid(&pid_path) {
                if is_alive(pid) {
                    let uptime = get_uptime(pid);
                    println!("Daemon running (PID {}, uptime: {})", pid, uptime);
                } else {
                    println!("Daemon not running (stale PID file)");
                    let _ = std::fs::remove_file(&pid_path);
                }
            } else {
                println!("Daemon not running");
            }
        }
        "start" => {
            if let Some(pid) = read_pid(&pid_path) {
                if is_alive(pid) {
                    println!("Daemon already running (PID {})", pid);
                    return Ok(());
                }
            }

            // The actual daemon process would be spawned here.
            // For now, print instructions since the Rust daemon binary needs to be built.
            println!("Starting daemon...");
            println!(
                "Note: Run `hq-daemon` binary directly, or use `hq start daemon` for service management."
            );
            println!("Daemon log: {}", log_path.display());
        }
        "stop" => {
            if let Some(pid) = read_pid(&pid_path) {
                if is_alive(pid) {
                    #[cfg(unix)]
                    {
                        use std::process::Command;
                        let _ = Command::new("kill").arg(pid.to_string()).output();
                    }
                    let _ = std::fs::remove_file(&pid_path);
                    println!("Daemon stopped (PID {})", pid);
                } else {
                    let _ = std::fs::remove_file(&pid_path);
                    println!("Daemon was not running (cleaned stale PID)");
                }
            } else {
                println!("Daemon not running");
            }
        }
        "logs" => {
            let n: usize = arg.and_then(|s| s.parse().ok()).unwrap_or(40);
            println!("\n── Daemon — last {} lines ──\n", n);
            if log_path.exists() {
                let content = std::fs::read_to_string(&log_path)?;
                let lines: Vec<&str> = content.lines().collect();
                let start = lines.len().saturating_sub(n);
                for line in &lines[start..] {
                    println!("{}", line);
                }
                if lines.is_empty() {
                    println!("(empty)");
                }
            } else {
                println!("(no daemon log yet — has it been started?)");
            }
        }
        _ => {
            println!("Usage: hq daemon [start|stop|status|logs [N]]");
        }
    }

    Ok(())
}

fn daemon_pid_path() -> PathBuf {
    let pid_dir = if cfg!(target_os = "macos") {
        dirs::home_dir()
            .unwrap_or_default()
            .join("Library/Logs")
    } else {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".local/share/agent-hq/pids")
    };
    pid_dir.join("hq-daemon.pid")
}

fn daemon_log_path() -> PathBuf {
    let log_dir = if cfg!(target_os = "macos") {
        dirs::home_dir()
            .unwrap_or_default()
            .join("Library/Logs")
    } else {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".local/share/agent-hq/logs")
    };
    log_dir.join("hq-daemon.log")
}

fn read_pid(path: &PathBuf) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
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
        let _ = pid;
        false
    }
}

fn get_uptime(pid: u32) -> String {
    #[cfg(unix)]
    {
        use std::process::Command;
        Command::new("ps")
            .args(["-o", "etime=", "-p", &pid.to_string()])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "?".to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        "?".to_string()
    }
}

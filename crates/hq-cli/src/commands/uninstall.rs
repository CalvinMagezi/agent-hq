use anyhow::Result;
use hq_core::config::HqConfig;

/// Remove launchd daemons (macOS) or systemd units (Linux).
pub async fn run(_config: &HqConfig, target: &str) -> Result<()> {
    println!("Uninstalling service daemons for: {}\n", target);

    let targets = match target {
        "all" => vec!["agent", "daemon", "relay"],
        other => vec![other],
    };

    #[cfg(target_os = "macos")]
    {
        let launch_agents = dirs::home_dir()
            .unwrap_or_default()
            .join("Library/LaunchAgents");

        for t in &targets {
            let daemon = format!("com.agent-hq.{}", t);
            let plist = launch_agents.join(format!("{}.plist", daemon));

            let _ = std::process::Command::new("launchctl")
                .args(["unload", &plist.to_string_lossy()])
                .output();

            if plist.exists() {
                std::fs::remove_file(&plist)?;
                println!("  Uninstalled: {} daemon", t);
            } else {
                println!("  {} daemon was not installed", t);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let systemd_dir = dirs::home_dir()
            .unwrap_or_default()
            .join(".config/systemd/user");

        for t in &targets {
            let unit_name = format!("agent-hq-{}.service", t);
            let unit_path = systemd_dir.join(&unit_name);

            let _ = std::process::Command::new("systemctl")
                .args(["--user", "disable", "--now", &unit_name])
                .output();

            if unit_path.exists() {
                std::fs::remove_file(&unit_path)?;
                let _ = std::process::Command::new("systemctl")
                    .args(["--user", "daemon-reload"])
                    .output();
                println!("  Uninstalled: {} systemd unit", t);
            } else {
                println!("  {} systemd unit was not installed", t);
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        println!("Service uninstallation not supported on this platform.");
    }

    Ok(())
}

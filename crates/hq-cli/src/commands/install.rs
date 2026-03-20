use anyhow::Result;
use hq_core::config::HqConfig;

/// Install launchd daemons (macOS) or systemd units (Linux).
pub async fn run(_config: &HqConfig, target: &str) -> Result<()> {
    println!("Installing service daemons for: {}\n", target);

    #[cfg(target_os = "macos")]
    {
        println!("macOS: launchd plist installation");
        println!("  The Rust binary does not yet generate plist files.");
        println!("  Use the hq binary directly as a long-running process:");
        println!("    hq start {}", target);
    }

    #[cfg(target_os = "linux")]
    {
        let systemd_dir = dirs::home_dir()
            .unwrap_or_default()
            .join(".config/systemd/user");
        std::fs::create_dir_all(&systemd_dir)?;

        let hq_binary = std::env::current_exe()?;
        let targets = match target {
            "all" => vec!["agent", "daemon", "relay"],
            other => vec![other],
        };

        for t in &targets {
            let unit_name = format!("agent-hq-{}.service", t);
            let unit_path = systemd_dir.join(&unit_name);

            let unit_content = format!(
                "[Unit]\nDescription=Agent HQ — {t}\nAfter=network.target\n\n[Service]\nType=simple\nRestart=on-failure\nRestartSec=5\nExecStart={binary} start {t}\n\n[Install]\nWantedBy=default.target\n",
                t = t,
                binary = hq_binary.display(),
            );

            std::fs::write(&unit_path, unit_content)?;

            let _ = std::process::Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .output();
            let _ = std::process::Command::new("systemctl")
                .args(["--user", "enable", "--now", &unit_name])
                .output();

            println!("  Installed: {}", unit_path.display());
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        println!("Service installation not supported on this platform.");
        println!("Run services manually with: hq start {}", target);
    }

    Ok(())
}

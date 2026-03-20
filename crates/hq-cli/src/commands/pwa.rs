use anyhow::Result;
use hq_core::config::HqConfig;

/// Start the HQ web dashboard (PWA).
pub async fn run(config: &HqConfig, port: u16) -> Result<()> {
    println!("\n── HQ Control Center ──\n");
    println!("Starting web dashboard on http://localhost:{}...", port);
    println!("Vault: {}\n", config.vault_path.display());

    // The web server is in the hq-web crate.
    // For now, try to start it or give instructions.
    println!("The web dashboard runs via the hq-web crate.");
    println!("Start it with: cargo run -p hq-web -- --port {} --vault {}", port, config.vault_path.display());
    println!("\nOr use the built-in WebSocket server:");
    println!("  hq start all");

    // Try opening browser
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(format!("http://localhost:{}", port))
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(format!("http://localhost:{}", port))
            .spawn();
    }

    Ok(())
}

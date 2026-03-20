use anyhow::Result;
use hq_core::config::HqConfig;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

pub async fn run() -> Result<()> {
    println!("HQ Setup Wizard");
    println!("================");
    println!();

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    // Vault path
    let default_vault = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vault");

    print!("Vault path [{}]: ", default_vault.display());
    stdout.flush()?;
    let mut vault_input = String::new();
    stdin.lock().read_line(&mut vault_input)?;
    let vault_path = if vault_input.trim().is_empty() {
        default_vault
    } else {
        PathBuf::from(vault_input.trim())
    };

    // OpenRouter API key
    print!("OpenRouter API key (or press Enter to skip): ");
    stdout.flush()?;
    let mut api_key = String::new();
    stdin.lock().read_line(&mut api_key)?;
    let api_key = api_key.trim();

    // Create config directory
    let hq_dir = HqConfig::hq_dir();
    std::fs::create_dir_all(&hq_dir)?;

    // Create vault directory
    std::fs::create_dir_all(&vault_path)?;

    // Create vault subdirectories
    for dir in &["_jobs/pending", "_jobs/running", "_jobs/done", "_jobs/failed", "_data", "Notebooks"] {
        std::fs::create_dir_all(vault_path.join(dir))?;
    }

    // Write config
    let mut config_content = format!("vault_path: \"{}\"\n", vault_path.display());
    if !api_key.is_empty() {
        config_content.push_str(&format!("openrouter_api_key: \"{}\"\n", api_key));
    }
    config_content.push_str("default_model: \"anthropic/claude-sonnet-4\"\n");
    config_content.push_str("ws_port: 5678\n");

    let config_path = HqConfig::config_file_path();
    std::fs::write(&config_path, &config_content)?;

    println!();
    println!("Setup complete!");
    println!("  Config: {}", config_path.display());
    println!("  Vault:  {}", vault_path.display());
    println!();
    println!("Next steps:");
    println!("  hq status   — check system status");
    println!("  hq chat     — start chatting");

    Ok(())
}

use anyhow::Result;
use hq_core::config::HqConfig;

/// Show vault sync status and manage sync operations.
pub async fn run(config: &HqConfig, sub: &str) -> Result<()> {
    match sub {
        "status" | "" => {
            println!("Vault Sync Status");
            println!("=================\n");

            let vault_path = &config.vault_path;

            // Check sync metadata
            let sync_dir = vault_path.join("_sync");
            let lock_file = vault_path.join("_sync/sync.lock");
            let state_file = vault_path.join("_sync/state.json");

            println!("Vault:     {}", vault_path.display());

            if sync_dir.exists() {
                println!("Sync dir:  exists");
            } else {
                println!("Sync dir:  not initialized");
            }

            if lock_file.exists() {
                let lock_content = std::fs::read_to_string(&lock_file).unwrap_or_default();
                println!("Lock:      active ({})", lock_content.trim());
            } else {
                println!("Lock:      none");
            }

            if state_file.exists() {
                let state = std::fs::read_to_string(&state_file).unwrap_or_default();
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&state) {
                    if let Some(last_sync) = json.get("lastSync").and_then(|v| v.as_str()) {
                        println!("Last sync: {}", last_sync);
                    }
                    if let Some(device) = json.get("deviceId").and_then(|v| v.as_str()) {
                        println!("Device:    {}", device);
                    }
                }
            } else {
                println!("State:     not synced yet");
            }

            // Check embeddings directory
            let embed_dir = vault_path.join("_embeddings");
            if embed_dir.exists() {
                let count = std::fs::read_dir(&embed_dir)
                    .map(|entries| entries.filter_map(|e| e.ok()).count())
                    .unwrap_or(0);
                println!("Embeddings: {} files", count);
            } else {
                println!("Embeddings: not initialized");
            }

            // Check _data directory
            let data_dir = vault_path.join("_data");
            if data_dir.exists() {
                let db_path = data_dir.join("vault.db");
                if db_path.exists() {
                    let size = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
                    println!("Database:  {:.1} MB", size as f64 / 1_048_576.0);
                }
            }
        }
        "reset" => {
            let lock_file = config.vault_path.join("_sync/sync.lock");
            if lock_file.exists() {
                std::fs::remove_file(&lock_file)?;
                println!("Sync lock removed.");
            } else {
                println!("No sync lock to remove.");
            }
        }
        _ => {
            println!("Usage: hq sync [status|reset]");
            println!();
            println!("Subcommands:");
            println!("  status     Show sync status (default)");
            println!("  reset      Remove sync lock");
        }
    }

    Ok(())
}

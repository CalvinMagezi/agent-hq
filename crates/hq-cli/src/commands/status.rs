use anyhow::Result;
use hq_core::config::HqConfig;
use hq_db::Database;
use hq_vault::VaultClient;

pub async fn run(config: &HqConfig) -> Result<()> {
    println!("Agent-HQ Status");
    println!("===============");
    println!();

    // Vault info
    let vault = VaultClient::new(config.vault_path.clone())?;
    let stats = vault.get_stats()?;

    println!("Vault:     {}", config.vault_path.display());
    println!("Notes:     {}", stats.total_notes);
    println!("Jobs:      {} pending, {} running, {} done, {} failed",
        stats.total_jobs.pending,
        stats.total_jobs.running,
        stats.total_jobs.done,
        stats.total_jobs.failed,
    );

    // Database info
    let db_path = config.db_path();
    if db_path.exists() {
        let db = Database::open(&db_path)?;
        let indexed = db.with_conn(|conn| {
            Ok(hq_db::search::indexed_count(conn)?)
        })?;
        println!("DB:        {} ({} indexed notes)", db_path.display(), indexed);
        println!("DB size:   {:.1} MB", stats.db_size_bytes as f64 / 1_048_576.0);
    } else {
        println!("DB:        not initialized (run `hq setup`)");
    }

    // Config
    println!();
    println!("Model:     {}", config.default_model);
    println!("WS port:   {}", config.ws_port);
    println!("OpenRouter: {}", if config.openrouter_api_key.is_some() { "configured" } else { "not set" });
    println!("Discord:   {}", if config.relay.discord_enabled { "enabled" } else { "disabled" });
    println!("Telegram:  {}", if config.relay.telegram_enabled { "enabled" } else { "disabled" });

    Ok(())
}

use anyhow::Result;
use hq_core::config::HqConfig;

/// Restart services — stop then start.
pub async fn run(config: &HqConfig, component: &str) -> Result<()> {
    println!("\n── Stopping all instances ──\n");
    super::stop::run(config, component).await?;

    // Brief pause
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    println!("\n── Starting fresh ──\n");
    super::start::run(config, component).await?;

    Ok(())
}

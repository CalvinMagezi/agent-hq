use anyhow::Result;
use hq_core::config::HqConfig;

/// Diagnose common issues — comprehensive health check.
pub async fn run(config: &HqConfig) -> Result<()> {
    // Doctor is essentially an alias for health with extra checks
    super::health::run(config).await
}

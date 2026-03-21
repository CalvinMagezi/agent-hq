//! Agent worker — polls for pending jobs and processes them.

use anyhow::Result;
use hq_core::config::HqConfig;
use hq_db::Database;
use hq_vault::VaultClient;
use std::sync::Arc;
use tracing::info;

pub async fn run_agent_worker(
    config: &HqConfig,
    vault: Arc<VaultClient>,
    _db: Arc<Database>,
) -> Result<()> {
    let agent_name = &config.agent.name;
    info!(agent = %agent_name, "agent: polling for jobs");

    let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        interval.tick().await;

        let pending = vault.list_pending_jobs().unwrap_or_default();
        if pending.is_empty() {
            continue;
        }

        info!(count = pending.len(), "agent: found pending jobs");

        for job_id in &pending {
            match vault.claim_job(job_id, agent_name) {
                Ok(Some(job)) => {
                    info!(
                        job_id = %job.id,
                        instruction = %job.instruction.chars().take(80).collect::<String>(),
                        "agent: claimed job"
                    );

                    // TODO: wire up AgentSession with LLM provider
                    let result = format!(
                        "Job received by Rust agent worker ({}). \
                         LLM session execution pending implementation. \
                         Instruction: {}",
                        agent_name,
                        job.instruction.chars().take(200).collect::<String>()
                    );
                    let _ = vault.complete_job(&job.id, &result);
                    info!(job_id = %job.id, "agent: completed job (stub)");
                }
                Ok(None) => {
                    // Job was claimed by another worker — race lost
                }
                Err(e) => {
                    tracing::warn!(
                        job_id = %job_id,
                        error = %e,
                        "agent: failed to claim job"
                    );
                }
            }
        }
    }
}

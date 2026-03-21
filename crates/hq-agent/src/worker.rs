//! Job worker — polls the vault for pending jobs and executes them.

use anyhow::Result;
use hq_db::Database;
use hq_llm::LlmProvider;
use hq_vault::VaultClient;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, error, info};

use crate::coding::register_coding_tools;
use crate::governance::ToolGuardian;
use crate::session::{AgentSession, SessionConfig};
use crate::tools::ToolRegistry;
use hq_tools::skills;

// ─── Backoff schedule ───────────────────────────────────────────

/// Backoff delays between poll cycles when no work is found.
/// Index advances each time no job is found; resets on job completion.
const BACKOFF_SCHEDULE: &[Duration] = &[
    Duration::from_secs(0),
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(300),  // 5 min
    Duration::from_secs(900),  // 15 min
    Duration::from_secs(3600), // 60 min
];

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

// ─── AgentWorker ────────────────────────────────────────────────

/// The agent worker: polls for jobs, claims them, runs sessions.
pub struct AgentWorker {
    vault: VaultClient,
    #[allow(dead_code)]
    db: Database,
    provider: Arc<dyn LlmProvider>,
    worker_id: String,
    session_config: SessionConfig,
    allowed_paths: Vec<PathBuf>,
}

impl AgentWorker {
    /// Create a new worker.
    pub fn new(
        vault: VaultClient,
        db: Database,
        provider: Arc<dyn LlmProvider>,
        worker_id: String,
        session_config: SessionConfig,
    ) -> Self {
        // Default allowed paths: the vault directory
        let allowed_paths = vec![vault.vault_path().to_path_buf()];

        Self {
            vault,
            db,
            provider,
            worker_id,
            session_config,
            allowed_paths,
        }
    }

    /// Add an allowed path for tool governance.
    pub fn allow_path(&mut self, path: PathBuf) {
        self.allowed_paths.push(path);
    }

    /// Main run loop: poll for jobs, claim, execute, repeat.
    pub async fn run(&self) -> Result<()> {
        info!(worker_id = %self.worker_id, "agent worker starting");

        let mut backoff_index: usize = 0;

        loop {
            // Poll for pending jobs
            let pending = match self.vault.list_pending_jobs() {
                Ok(jobs) => jobs,
                Err(e) => {
                    error!(error = %e, "failed to list pending jobs");
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    continue;
                }
            };

            if pending.is_empty() {
                let delay = BACKOFF_SCHEDULE[backoff_index.min(BACKOFF_SCHEDULE.len() - 1)];
                if delay.as_secs() > 0 {
                    debug!(
                        delay_secs = delay.as_secs(),
                        backoff_index = backoff_index,
                        "no pending jobs, backing off"
                    );
                }
                tokio::time::sleep(delay).await;
                backoff_index = (backoff_index + 1).min(BACKOFF_SCHEDULE.len() - 1);
                continue;
            }

            // Try to claim the first pending job
            let job_id = &pending[0];
            let job = match self.vault.claim_job(job_id, &self.worker_id) {
                Ok(Some(job)) => job,
                Ok(None) => {
                    debug!(job_id = %job_id, "job already claimed by another worker");
                    continue;
                }
                Err(e) => {
                    error!(job_id = %job_id, error = %e, "failed to claim job");
                    continue;
                }
            };

            info!(
                job_id = %job_id,
                instruction_len = job.instruction.len(),
                "claimed job, starting execution"
            );

            // Reset backoff on successful claim
            backoff_index = 0;

            // Execute the job
            match self.execute_job(job_id, &job.instruction).await {
                Ok(result) => {
                    if let Err(e) = self.vault.complete_job(job_id, &result) {
                        error!(job_id = %job_id, error = %e, "failed to complete job");
                    } else {
                        info!(job_id = %job_id, "job completed successfully");
                    }
                }
                Err(e) => {
                    let error_msg = format!("{:#}", e);
                    error!(job_id = %job_id, error = %error_msg, "job execution failed");
                    if let Err(e2) = self.vault.fail_job(job_id, &error_msg) {
                        error!(job_id = %job_id, error = %e2, "failed to mark job as failed");
                    }
                }
            }
        }
    }

    /// Execute a single job: build tools, create session, run prompt.
    async fn execute_job(&self, job_id: &str, instruction: &str) -> Result<String> {
        // Build tool registry with governance
        let guardian = ToolGuardian::new(
            self.allowed_paths.clone(),
            hq_core::types::SecurityProfile::Guarded,
        );

        let mut registry = ToolRegistry::new();
        register_coding_tools(&mut registry);

        // Wrap all tools with governance
        let mut governed_registry = ToolRegistry::new();
        let _tool_names: Vec<String> = registry.names().map(|n| n.to_string()).collect();
        // We need to re-register because we can't move tools out of the registry easily.
        // Instead, register governed coding tools directly.
        drop(registry);

        let mut raw_registry = ToolRegistry::new();
        register_coding_tools(&mut raw_registry);

        // For now, register governed tools by re-creating them
        // (the governance wrapper needs ownership)
        governed_registry.register(guardian.govern(Box::new(crate::coding::BashTool)));
        governed_registry.register(guardian.govern(Box::new(crate::coding::ReadTool)));
        governed_registry.register(guardian.govern(Box::new(crate::coding::WriteTool)));
        governed_registry.register(guardian.govern(Box::new(crate::coding::EditTool)));
        governed_registry.register(guardian.govern(Box::new(crate::coding::FindTool)));
        governed_registry.register(guardian.govern(Box::new(crate::coding::GrepTool)));
        governed_registry.register(guardian.govern(Box::new(crate::coding::LsTool)));

        // Create session
        let mut session =
            AgentSession::new(self.provider.clone(), governed_registry, self.session_config.clone());

        // ── Context assembly via 5-layer engine ──

        // 1. Load system context: SOUL + MEMORY + PREFERENCES + pinned notes
        let sys_ctx = hq_vault::system::get_system_context(self.vault.vault_path())
            .unwrap_or_default();

        // 2. Query live DB memories (best-effort — Ollama may be offline)
        let db_memory = {
            hq_memory::open_memory_tables(&self.db).ok();
            let mut querier = hq_memory::MemoryQuerier::new(self.db.clone());
            querier.get_recent_context(Some(10_i64), None).ok()
        };

        // 3. Combine static MEMORY.md with live DB memories
        let memory_text = match &db_memory {
            Some(ctx) if !ctx.formatted.is_empty() => {
                format!("{}\n\n---\n\n## Live Agent Memories\n\n{}", sys_ctx.memory, ctx.formatted)
            }
            _ => sys_ctx.memory.clone(),
        };

        // 4. Forward replay: surface precedent memories for this job
        let instruction_with_precedents = {
            let vault_path = self.vault.vault_path().to_path_buf();
            let replay = hq_memory::AwakeReplayEngine::new(self.db.clone(), vault_path);
            match replay.forward_replay(job_id, "hq-agent", instruction, Some(5)) {
                Ok(result) if !result.precedents.is_empty() => {
                    let precedent_text: String = result.precedents.iter()
                        .map(|m| format!("- {}", m.summary))
                        .collect::<Vec<_>>()
                        .join("\n");
                    info!(
                        job_id = %job_id,
                        count = result.precedents.len(),
                        "forward replay: surfaced precedent memories"
                    );
                    format!(
                        "## Relevant Precedents (from past experience)\n\n{precedent_text}\n\n---\n\n{instruction}"
                    )
                }
                _ => instruction.to_string(),
            }
        };

        // 5. Select budget profile based on instruction characteristics
        let profile = if instruction.len() < 100 {
            "quick"
        } else if instruction.to_lowercase().contains("[thorough]") {
            "thorough"
        } else {
            "standard"
        };

        // 6. Build context frame via 5-layer engine
        let harness_instructions = format!(
            "## Current Job\n\n**Job ID**: {job_id}\n\
             Complete the task described in the user's message. \
             Use the available tools to read files, write code, and run commands as needed. \
             When finished, provide a clear summary of what was accomplished."
        );

        let frame_input = hq_context::FrameInput {
            profile: profile.to_string(),
            total_tokens: 128_000, // Default context window
            soul: sys_ctx.soul,
            harness_instructions,
            user_message: instruction_with_precedents.clone(),
            memory: memory_text,
            private_tags: vec!["#internal".to_string(), "#private".to_string()],
            thread: vec![], // Empty at job start
            pinned_notes: sys_ctx.pinned_notes,
            search_results: vec![],
        };

        let engine = hq_context::ContextEngine::new();
        let frame = engine.build_frame(frame_input)?;

        info!(
            job_id = %job_id,
            profile,
            total_used = frame.budget.total_used,
            utilization_pct = format!("{:.1}", frame.budget.utilization_pct),
            "context frame assembled"
        );

        // 7. Enrich with skill hints and set system prompt
        let skills_dir = self.vault.vault_path().join("skills");
        let skill_index = skills::SkillHintIndex::build(&skills_dir);
        let system_prompt = skills::enrich_system_prompt(
            &skill_index,
            &frame.system,
            &instruction_with_precedents,
        );
        session.set_system_prompt(system_prompt);

        // ── Execute with heartbeat ──

        let worker_id = self.worker_id.clone();
        let job_id_owned = job_id.to_string();
        let heartbeat_handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(HEARTBEAT_INTERVAL).await;
                debug!(
                    worker_id = %worker_id,
                    job_id = %job_id_owned,
                    "heartbeat"
                );
            }
        });

        let result = session.prompt(&instruction_with_precedents).await;

        heartbeat_handle.abort();

        let stats = session.stats();
        info!(
            job_id = %job_id,
            input_tokens = stats.total_input_tokens,
            output_tokens = stats.total_output_tokens,
            tool_calls = stats.tool_call_count,
            messages = stats.message_count,
            "job execution stats"
        );

        // ── Post-execution: memory ingestion + reverse replay ──

        if let Ok(ref result_text) = result {
            // Ingest conversation result as memory (best-effort)
            let db_for_memory = self.db.clone();
            let vault_path_for_replay = self.vault.vault_path().to_path_buf();
            let result_owned = result_text.clone();
            let job_id_for_memory = job_id.to_string();
            let instruction_for_memory = instruction.to_string();
            tokio::spawn(async move {
                let mut ingester = hq_memory::MemoryIngester::new(db_for_memory.clone());
                let exchange = format!(
                    "Job: {}\nInstruction: {}\nResult: {}",
                    job_id_for_memory,
                    instruction_for_memory.chars().take(500).collect::<String>(),
                    result_owned.chars().take(2000).collect::<String>(),
                );
                if let Err(e) = ingester.ingest(&exchange, &format!("job:{job_id_for_memory}"), Some("hq-agent")).await {
                    tracing::debug!(error = %e, "memory ingestion skipped (Ollama likely offline)");
                }

                // Reverse replay: credit assignment for memories used during this job
                let replay = hq_memory::AwakeReplayEngine::new(
                    db_for_memory,
                    vault_path_for_replay,
                );
                if let Err(e) = replay.reverse_replay(
                    &job_id_for_memory,
                    "hq-agent",
                    None,
                    None,
                ) {
                    tracing::debug!(error = %e, "reverse replay skipped");
                }
            });
        }

        result
    }
}

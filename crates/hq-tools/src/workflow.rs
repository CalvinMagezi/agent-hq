//! Workflow engine — multi-stage team workflow orchestrator.
//!
//! Port of the TypeScript WorkflowEngine. Runs a team manifest through stages:
//! - Sequential stages: run agents one at a time
//! - Parallel stages: concurrent agents via tokio tasks
//! - Gates: evaluator agent must PASS before proceeding

use anyhow::{Result, bail};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;
use tokio::process::Command;

use crate::registry::HqTool;

// ─── Types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamManifest {
    pub name: String,
    pub stages: Vec<TeamStage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamStage {
    pub stage_id: String,
    pub pattern: String, // "sequential" or "parallel"
    pub agents: Vec<String>,
    pub gates: Option<Vec<QualityGate>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualityGate {
    pub gate_id: String,
    pub evaluator_agent: String,
    pub evaluates_result_of: String,
    pub max_retries: u32,
    pub block_on_failure: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GateOutcome {
    PASS,
    NEEDS_WORK,
    BLOCKED,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowResult {
    pub run_id: String,
    pub team_name: String,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    pub status: String, // "completed", "blocked", "failed"
    pub stages_completed: usize,
    pub total_stages: usize,
    pub gate_results: HashMap<String, String>,
}

// ─── Helpers ────────────────────────────────────────────────────

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn generate_id() -> String {
    let ts = chrono::Utc::now().timestamp_millis();
    let r = uuid::Uuid::new_v4().to_string();
    format!("{ts}-{}", &r[..6])
}

fn parse_gate_verdict(result: &str) -> GateOutcome {
    let upper = result.to_uppercase();
    for line in upper.lines().take(3) {
        if line.contains("BLOCKED") {
            return GateOutcome::BLOCKED;
        }
        if line.contains("NEEDS") && line.contains("WORK") {
            return GateOutcome::NEEDS_WORK;
        }
        if line.contains("PASS") {
            return GateOutcome::PASS;
        }
    }
    GateOutcome::NEEDS_WORK
}

/// Execute a task by shelling out to a CLI harness (claude-code, gemini-cli, etc.).
async fn execute_via_harness(
    harness: &str,
    instruction: &str,
    timeout_secs: u64,
) -> Result<String> {
    // Try claude or kilo CLI
    let (cmd, args) = match harness {
        "claude-code" => ("claude", vec!["-p".to_string(), instruction.to_string()]),
        "gemini-cli" => ("gemini", vec![instruction.to_string()]),
        "kilo-code" => ("kilo", vec!["run".to_string(), "--auto".to_string(), instruction.to_string()]),
        _ => ("claude", vec!["-p".to_string(), instruction.to_string()]),
    };

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        Command::new(cmd).args(&args).output(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Task timed out after {timeout_secs}s"))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Harness {harness} failed: {stderr}");
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Cheap fallback via OpenRouter API.
async fn cheap_api_fallback(
    instruction: &str,
    http: &reqwest::Client,
) -> Result<String> {
    let api_key = std::env::var("OPENROUTER_API_KEY")?;
    let resp = http
        .post("https://openrouter.ai/api/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&json!({
            "model": "moonshotai/kimi-k2.5",
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": instruction}],
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        bail!("API fallback failed: {}", resp.status());
    }

    let data: Value = resp.json().await?;
    let text = data
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    Ok(text.to_string())
}

// ─── WorkflowEngine ────────────────────────────────────────────

pub struct WorkflowEngine {
    vault_path: PathBuf,
    task_timeout_secs: u64,
    http: reqwest::Client,
}

impl WorkflowEngine {
    pub fn new(vault_path: PathBuf) -> Self {
        Self {
            vault_path,
            task_timeout_secs: 600, // 10 min
            http: reqwest::Client::new(),
        }
    }

    pub async fn run(&self, manifest: &TeamManifest, instruction: &str) -> Result<WorkflowResult> {
        let run_id = generate_id();
        let started_at = now_iso();
        let start = std::time::Instant::now();

        let mut gate_results: HashMap<String, String> = HashMap::new();
        let mut prior_results: HashMap<String, String> = HashMap::new();
        let mut stages_completed = 0;
        let mut final_status = "completed".to_string();

        for stage in &manifest.stages {
            let stage_result = self
                .run_stage(stage, instruction, &prior_results, &run_id)
                .await;

            match stage_result {
                Ok((agent_results, gate_outcomes)) => {
                    for (agent, text) in &agent_results {
                        prior_results.insert(
                            format!("{}:{}", stage.stage_id, agent),
                            text.clone(),
                        );
                    }
                    for (gate_id, outcome) in &gate_outcomes {
                        gate_results.insert(gate_id.clone(), format!("{outcome:?}"));
                        if *outcome == GateOutcome::BLOCKED {
                            final_status = "blocked".to_string();
                        }
                    }
                    stages_completed += 1;
                    if final_status == "blocked" {
                        break;
                    }
                }
                Err(e) => {
                    tracing::error!("[workflow] Stage {} failed: {e}", stage.stage_id);
                    final_status = "failed".to_string();
                    break;
                }
            }
        }

        let completed_at = now_iso();
        let duration_ms = start.elapsed().as_millis() as u64;

        // Write retro note
        let retro_dir = self
            .vault_path
            .join("Notebooks/Projects/Agent-HQ/Retros");
        fs::create_dir_all(&retro_dir).await?;
        let retro_path = retro_dir.join(format!("{run_id}-retro.md"));

        let gate_section: Vec<String> = gate_results
            .iter()
            .map(|(k, v)| format!("- {k}: **{v}**"))
            .collect();

        let retro_content = format!(
            "---\nrunId: {run_id}\nteamName: {}\nstatus: {final_status}\ndurationMs: {duration_ms}\n---\n\n# Workflow Retro: {} — {run_id}\n\n**Status**: {final_status} | **Duration**: {}min | **Stages**: {stages_completed}/{}\n\n## Task\n\n{instruction}\n\n## Gate Results\n\n{}\n",
            manifest.name,
            manifest.name,
            duration_ms / 60000,
            manifest.stages.len(),
            if gate_section.is_empty() { "- No gates evaluated".to_string() } else { gate_section.join("\n") },
        );
        fs::write(&retro_path, &retro_content).await?;

        Ok(WorkflowResult {
            run_id,
            team_name: manifest.name.clone(),
            started_at,
            completed_at,
            duration_ms,
            status: final_status,
            stages_completed,
            total_stages: manifest.stages.len(),
            gate_results,
        })
    }

    async fn run_stage(
        &self,
        stage: &TeamStage,
        instruction: &str,
        prior_results: &HashMap<String, String>,
        run_id: &str,
    ) -> Result<(HashMap<String, String>, HashMap<String, GateOutcome>)> {
        let mut agent_results: HashMap<String, String> = HashMap::new();
        let mut gate_outcomes: HashMap<String, GateOutcome> = HashMap::new();

        // Build task instructions with prior context
        let prior_context: String = if prior_results.is_empty() {
            String::new()
        } else {
            let entries: Vec<String> = prior_results
                .iter()
                .map(|(k, v)| {
                    let truncated = &v[..v.len().min(1000)];
                    format!("### {k}\n{truncated}")
                })
                .collect();
            format!("\n\n## Prior Stage Results\n\n{}", entries.join("\n\n"))
        };

        let full_instruction = format!(
            "## Your Task\n\n{instruction}{prior_context}"
        );

        if stage.pattern == "parallel" {
            let mut handles = Vec::new();
            for agent in &stage.agents {
                let instr = full_instruction.clone();
                let harness = "claude-code".to_string(); // default
                let timeout = self.task_timeout_secs;
                let agent_name = agent.clone();
                let http = self.http.clone();

                handles.push(tokio::spawn(async move {
                    let result = match execute_via_harness(&harness, &instr, timeout).await {
                        Ok(r) => r,
                        Err(_) => {
                            // Fallback to API
                            cheap_api_fallback(&instr, &http)
                                .await
                                .unwrap_or_else(|e| format!("[FAILED] {e}"))
                        }
                    };
                    (agent_name, result)
                }));
            }

            for handle in handles {
                if let Ok((name, result)) = handle.await {
                    agent_results.insert(name, result);
                }
            }
        } else {
            // Sequential
            for agent in &stage.agents {
                let result = match execute_via_harness(
                    "claude-code",
                    &full_instruction,
                    self.task_timeout_secs,
                )
                .await
                {
                    Ok(r) => r,
                    Err(_) => {
                        cheap_api_fallback(&full_instruction, &self.http)
                            .await
                            .unwrap_or_else(|e| format!("[FAILED] {e}"))
                    }
                };
                agent_results.insert(agent.clone(), result);
            }
        }

        // Evaluate gates
        if let Some(gates) = &stage.gates {
            for gate in gates {
                let content = agent_results
                    .get(&gate.evaluates_result_of)
                    .cloned()
                    .unwrap_or_else(|| {
                        agent_results.values().cloned().collect::<Vec<_>>().join("\n")
                    });

                let eval_instruction = format!(
                    "You are a quality gate evaluator ({}).\nOriginal task: {instruction}\n\nContent to evaluate:\n{}\n\nReturn verdict on FIRST line: PASS, NEEDS_WORK, or BLOCKED.",
                    gate.evaluator_agent,
                    &content[..content.len().min(4000)],
                );

                let mut outcome = GateOutcome::NEEDS_WORK;
                let mut retries = 0;

                while retries <= gate.max_retries {
                    let eval_result = match execute_via_harness(
                        "claude-code",
                        &eval_instruction,
                        self.task_timeout_secs,
                    )
                    .await
                    {
                        Ok(r) => r,
                        Err(_) => {
                            cheap_api_fallback(&eval_instruction, &self.http)
                                .await
                                .unwrap_or_default()
                        }
                    };

                    outcome = parse_gate_verdict(&eval_result);
                    if outcome == GateOutcome::PASS || outcome == GateOutcome::BLOCKED {
                        break;
                    }
                    retries += 1;
                }

                gate_outcomes.insert(gate.gate_id.clone(), outcome);
            }
        }

        Ok((agent_results, gate_outcomes))
    }
}

// ─── Tool wrapper ───────────────────────────────────────────────

pub struct RunWorkflowTool {
    vault_path: PathBuf,
}

impl RunWorkflowTool {
    pub fn new(vault_path: PathBuf) -> Self {
        Self { vault_path }
    }
}

#[async_trait]
impl HqTool for RunWorkflowTool {
    fn name(&self) -> &str {
        "run_workflow"
    }

    fn description(&self) -> &str {
        "Run a multi-stage team workflow with sequential/parallel stages and quality gates."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "teamName": { "type": "string", "description": "Team manifest name" },
                "instruction": { "type": "string", "description": "Task instruction" },
                "stages": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "stageId": { "type": "string" },
                            "pattern": { "type": "string", "enum": ["sequential", "parallel"] },
                            "agents": { "type": "array", "items": { "type": "string" } }
                        }
                    },
                    "description": "Stage definitions (if not loading from file)"
                },
                "taskTimeoutSecs": { "type": "integer", "description": "Per-task timeout (default: 600)" }
            },
            "required": ["teamName", "instruction"]
        })
    }

    fn category(&self) -> &str {
        "workflow"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let team_name = args
            .get("teamName")
            .and_then(|v| v.as_str())
            .unwrap_or("default");
        let instruction = args
            .get("instruction")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        // Try to load team manifest from file, or use inline stages
        let stages: Vec<TeamStage> = if let Some(stages_val) = args.get("stages").and_then(|v| v.as_array()) {
            stages_val
                .iter()
                .map(|s| TeamStage {
                    stage_id: s.get("stageId").and_then(|v| v.as_str()).unwrap_or("s1").to_string(),
                    pattern: s.get("pattern").and_then(|v| v.as_str()).unwrap_or("sequential").to_string(),
                    agents: s.get("agents").and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default(),
                    gates: None,
                })
                .collect()
        } else {
            // Default single-stage sequential
            vec![TeamStage {
                stage_id: "s1".to_string(),
                pattern: "sequential".to_string(),
                agents: vec!["default".to_string()],
                gates: None,
            }]
        };

        let manifest = TeamManifest {
            name: team_name.to_string(),
            stages,
        };

        let engine = WorkflowEngine::new(self.vault_path.clone());
        let result = engine.run(&manifest, instruction).await?;

        Ok(serde_json::to_value(&result)?)
    }
}

//! Model benchmark tool — benchmarks AI models via OpenRouter.
//!
//! Port of the TypeScript `benchmark_model` tool. Runs 10 benchmark tests
//! covering tool-use, JSON extraction, code gen, context handling,
//! instruction following, summarization, multi-turn, error recovery,
//! markdown gen, and cost routing.

use anyhow::{Result, bail};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::fs;

use crate::registry::HqTool;

const DEFAULT_BASELINE: &str = "google/gemini-2.5-flash";
const JUDGE_MODEL: &str = "google/gemini-2.5-flash-lite";
const PER_TEST_BUDGET_CAP: f64 = 0.10;
const OR_BASE: &str = "https://openrouter.ai/api/v1";

// ─── Test definitions ───────────────────────────────────────────

struct BenchmarkTest {
    name: &'static str,
    category: &'static str,
    system: &'static str,
    user: &'static str,
    context_padding: Option<usize>,
}

fn get_test_suite(suite: &str) -> Vec<BenchmarkTest> {
    let quick = vec![
        BenchmarkTest {
            name: "Tool-use accuracy",
            category: "agentic",
            system: "You are an AI assistant with access to three tools:\n1. vault_search(query) 2. vault_write_note(folder, title, content) 3. bash(command)\nWhen you need to use a tool, respond with JSON: {\"tool\": \"tool_name\", \"input\": {...}}",
            user: "Find all notes about \"Kolaborate\" in the vault.",
            context_padding: None,
        },
        BenchmarkTest {
            name: "JSON extraction",
            category: "structured-output",
            system: "Extract structured metadata from the given note content. Return ONLY a JSON object with: title (string), tags (string array, max 4), noteType (project/meeting/idea/reference/task), priority (1-5).",
            user: "# SiteSeer Phase 2 Kickoff\n\nMet with the construction team today to discuss the next phase of SiteSeer deployment. Key decisions: moving to real-time monitoring with IoT sensors, budget approved for 3 pilot sites in Kampala. Timeline: 6 weeks for MVP.",
            context_padding: None,
        },
        BenchmarkTest {
            name: "Code generation (TypeScript/Bun)",
            category: "coding",
            system: "You are a TypeScript developer using the Bun runtime. Write clean, typed code. No explanations — only the code.",
            user: "Write a TypeScript function `parseVaultFrontmatter(content: string): { data: Record<string, unknown>; body: string }` that detects YAML frontmatter between --- delimiters.",
            context_padding: None,
        },
    ];

    let standard_extra = vec![
        BenchmarkTest {
            name: "Context window stress (50K)",
            category: "context",
            system: "You are a research assistant. Answer the question based ONLY on the provided context. Quote the exact relevant passage.",
            user: "", // filled dynamically
            context_padding: Some(50000),
        },
        BenchmarkTest {
            name: "Instruction following",
            category: "structured-output",
            system: "Follow the instructions EXACTLY. Any deviation is a failure.",
            user: "Generate a task delegation plan. Requirements:\n1. Output must be valid JSON\n2. Keys: taskId, assignee, steps, estimatedMinutes\n3. steps: array of exactly 3 strings\n4. taskId: TASK-NNNN\n5. estimatedMinutes: 15-120\n6. assignee: agent-alpha\n\nTask: Research TypeScript 6.0 features.",
            context_padding: None,
        },
        BenchmarkTest {
            name: "Project-relevant summarization",
            category: "synthesis",
            system: "You are a daily synthesis engine. Given news headlines and project descriptions, find 2 unexpected connections.",
            user: "## Headlines\n- Poland surpasses Switzerland as 20th largest economy\n- Nvidia unveils DLSS 5\n- Kenya stops Russia recruiting citizens\n- Meta AI compute partnership\n\n## Projects\n- Agent-HQ: AI agent orchestration\n- Kolaborate: African talent/BPO\n- SiteSeer: IoT monitoring Uganda",
            context_padding: None,
        },
    ];

    let full_extra = vec![
        BenchmarkTest {
            name: "Multi-turn tool use",
            category: "agentic",
            system: "You are an AI agent with tools: vault_search(query), vault_read(path), vault_write_note(folder, title, content). Respond with JSON tool calls.",
            user: "Search the vault for notes about \"budget\". Start with step 1.",
            context_padding: None,
        },
        BenchmarkTest {
            name: "Error recovery",
            category: "agentic",
            system: "You are an AI agent. Use JSON tool calls. When a tool fails, try a different approach.",
            user: "Read the file at Notebooks/Reports/quarterly.md\n\nTool result: ERROR — File not found.\n\nWhat do you do next?",
            context_padding: None,
        },
        BenchmarkTest {
            name: "Vault note generation",
            category: "structured-output",
            system: "Generate a complete vault note with YAML frontmatter (noteType, tags, createdAt, pinned). Use markdown with wikilinks ([[note]]).",
            user: "Create a project kickoff note for \"CloudSync\" — vault sync via CRDTs.",
            context_padding: None,
        },
        BenchmarkTest {
            name: "Cost-aware routing",
            category: "reasoning",
            system: "Route tasks to modes: quick ($0.001), standard ($0.05), thorough ($0.50). Respond with JSON array.",
            user: "Classify: 1. Fix typo in README 2. Implement OAuth2 PKCE 3. Redesign event sourcing 4. Update version to 1.2.3 5. Add input validation",
            context_padding: None,
        },
    ];

    match suite {
        "quick" => quick,
        "standard" => {
            let mut all = quick;
            all.extend(standard_extra);
            all
        }
        _ => {
            let mut all = quick;
            all.extend(standard_extra);
            all.extend(full_extra);
            all
        }
    }
}

// ─── OpenRouter helpers ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct LLMResponse {
    choices: Vec<LLMChoice>,
    usage: Option<LLMUsage>,
}

#[derive(Debug, Deserialize)]
struct LLMChoice {
    message: LLMMessage,
}

#[derive(Debug, Deserialize)]
struct LLMMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LLMUsage {
    prompt_tokens: u64,
    completion_tokens: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct JudgeScore {
    correctness: f64,
    completeness: f64,
    format: f64,
    notes: String,
}

async fn call_model(
    http: &Client,
    api_key: &str,
    model_id: &str,
    system: &str,
    user: &str,
) -> Result<(String, u64, u64, u128)> {
    let start = std::time::Instant::now();
    let resp = http
        .post(format!("{OR_BASE}/chat/completions"))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .header("HTTP-Referer", "https://github.com/CalvinMagezi/agent-hq")
        .header("X-Title", "Agent-HQ Benchmark")
        .timeout(std::time::Duration::from_secs(120))
        .json(&json!({
            "model": model_id,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
            "max_tokens": 2048,
        }))
        .send()
        .await?;

    let latency_ms = start.elapsed().as_millis();

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("OpenRouter {status}: {body}");
    }

    let data: LLMResponse = resp.json().await?;
    let content = data
        .choices
        .first()
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default();
    let (prompt_tokens, completion_tokens) = data
        .usage
        .map(|u| (u.prompt_tokens, u.completion_tokens))
        .unwrap_or((0, 0));

    Ok((content, prompt_tokens, completion_tokens, latency_ms))
}

async fn judge_response(
    http: &Client,
    api_key: &str,
    system: &str,
    user: &str,
    response: &str,
) -> JudgeScore {
    let prompt = format!(
        "Rate this AI response on 1-5 scale.\n\nSystem: {}\nUser: {}\n\nResponse:\n{}\n\nReturn ONLY JSON: {{\"correctness\": N, \"completeness\": N, \"format\": N, \"notes\": \"...\"}}",
        &system[..system.len().min(300)],
        &user[..user.len().min(500)],
        &response[..response.len().min(2000)],
    );

    match call_model(http, api_key, JUDGE_MODEL, "Be concise. Output only valid JSON.", &prompt).await {
        Ok((text, _, _, _)) => {
            let cleaned = text
                .trim()
                .trim_start_matches("```json")
                .trim_start_matches("```")
                .trim_end_matches("```")
                .trim();
            match serde_json::from_str::<JudgeScore>(cleaned) {
                Ok(mut score) => {
                    score.correctness = score.correctness.clamp(1.0, 5.0);
                    score.completeness = score.completeness.clamp(1.0, 5.0);
                    score.format = score.format.clamp(1.0, 5.0);
                    score
                }
                Err(_) => JudgeScore {
                    correctness: 3.0,
                    completeness: 3.0,
                    format: 3.0,
                    notes: "Judge parse failed — default scores".to_string(),
                },
            }
        }
        Err(_) => JudgeScore {
            correctness: 3.0,
            completeness: 3.0,
            format: 3.0,
            notes: "Judge call failed — default scores".to_string(),
        },
    }
}

fn generate_context_padding(target_chars: usize) -> (String, &'static str) {
    let needle = "The quarterly budget allocation for SiteSeer Phase 2 was confirmed at $47,500 USD on March 3rd.";
    let fillers = [
        "Meeting notes from the design review covered component architecture.",
        "The infrastructure team reported 99.7% uptime for the past quarter.",
        "Marketing analysis showed a 23% increase in user engagement.",
        "Security audit findings included three low-severity issues.",
        "The product roadmap for Q2 includes feature flags and A/B testing.",
        "Database optimization reduced average query time from 45ms to 12ms.",
        "Customer feedback highlighted the need for better mobile responsiveness.",
        "The DevOps pipeline migration saved approximately 40 minutes per deployment.",
    ];

    let mut lines = Vec::new();
    let mut chars = 0;
    let mut needle_inserted = false;
    let insert_point = (target_chars as f64 * 0.6) as usize;

    while chars < target_chars {
        if !needle_inserted && chars > insert_point {
            lines.push(needle.to_string());
            chars += needle.len();
            needle_inserted = true;
        }
        let filler = fillers[lines.len() % fillers.len()];
        lines.push(filler.to_string());
        chars += filler.len() + 1;
    }

    if !needle_inserted {
        let pos = (lines.len() as f64 * 0.6) as usize;
        lines.insert(pos, needle.to_string());
    }

    (lines.join("\n"), needle)
}

// ─── Main tool ──────────────────────────────────────────────────

pub struct BenchmarkModelTool {
    vault_path: PathBuf,
    http: Client,
}

impl BenchmarkModelTool {
    pub fn new(vault_path: PathBuf) -> Self {
        Self {
            vault_path,
            http: Client::new(),
        }
    }
}

#[async_trait]
impl HqTool for BenchmarkModelTool {
    fn name(&self) -> &str {
        "benchmark_model"
    }

    fn description(&self) -> &str {
        "Benchmark an AI model via OpenRouter against Agent-HQ workloads. Tests tool-use, code gen, JSON extraction, reasoning, and context handling. User-triggered only."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "modelId": { "type": "string", "description": "OpenRouter model ID to benchmark" },
                "compareWith": { "type": "string", "description": "Baseline model ID (default: google/gemini-2.5-flash)" },
                "suite": { "type": "string", "enum": ["quick", "standard", "full"], "description": "Test suite size (default: standard)" }
            },
            "required": ["modelId"]
        })
    }

    fn category(&self) -> &str {
        "benchmark"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let api_key = std::env::var("OPENROUTER_API_KEY")
            .map_err(|_| anyhow::anyhow!("OPENROUTER_API_KEY not configured"))?;

        let model_id = args
            .get("modelId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let baseline_id = args
            .get("compareWith")
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASELINE);
        let suite = args
            .get("suite")
            .and_then(|v| v.as_str())
            .unwrap_or("standard");

        let tests = get_test_suite(suite);
        let mut total_cost = 0.0_f64;
        let mut model_scores: Vec<(String, f64, u128)> = Vec::new();
        let mut baseline_scores: Vec<(String, f64)> = Vec::new();

        for test in &tests {
            let user_prompt = if test.context_padding.is_some() {
                let (padding, _) = generate_context_padding(50000);
                format!("## Vault Context\n{padding}\n\n## Question\nWhat was the confirmed quarterly budget allocation for SiteSeer Phase 2?")
            } else {
                test.user.to_string()
            };

            // Run target model
            match call_model(&self.http, &api_key, model_id, test.system, &user_prompt).await {
                Ok((content, prompt_tokens, completion_tokens, latency_ms)) => {
                    let cost = (prompt_tokens as f64 * 0.5 + completion_tokens as f64 * 1.5) / 1_000_000.0;
                    total_cost += cost;
                    if cost <= PER_TEST_BUDGET_CAP {
                        let score = judge_response(&self.http, &api_key, test.system, &user_prompt, &content).await;
                        let avg = (score.correctness + score.completeness + score.format) / 3.0;
                        model_scores.push((test.name.to_string(), avg, latency_ms));
                    } else {
                        model_scores.push((test.name.to_string(), 0.0, latency_ms));
                    }
                }
                Err(e) => {
                    tracing::warn!("[benchmark] {model_id} failed on {}: {e}", test.name);
                    model_scores.push((test.name.to_string(), 0.0, 0));
                }
            }

            // Run baseline
            match call_model(&self.http, &api_key, baseline_id, test.system, &user_prompt).await {
                Ok((content, _, _, _)) => {
                    let score = judge_response(&self.http, &api_key, test.system, &user_prompt, &content).await;
                    let avg = (score.correctness + score.completeness + score.format) / 3.0;
                    baseline_scores.push((test.name.to_string(), avg));
                }
                Err(_) => {
                    baseline_scores.push((test.name.to_string(), 0.0));
                }
            }
        }

        // Compute averages
        let valid_model: Vec<f64> = model_scores.iter().filter(|s| s.1 > 0.0).map(|s| s.1).collect();
        let model_avg = if valid_model.is_empty() { 0.0 } else { valid_model.iter().sum::<f64>() / valid_model.len() as f64 };
        let valid_baseline: Vec<f64> = baseline_scores.iter().filter(|s| s.1 > 0.0).map(|s| s.1).collect();
        let baseline_avg = if valid_baseline.is_empty() { 0.0 } else { valid_baseline.iter().sum::<f64>() / valid_baseline.len() as f64 };
        let avg_latency: u128 = {
            let valid: Vec<u128> = model_scores.iter().filter(|s| s.2 > 0).map(|s| s.2).collect();
            if valid.is_empty() { 0 } else { valid.iter().sum::<u128>() / valid.len() as u128 }
        };

        // Write report
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let short_name = model_id.split('/').last().unwrap_or(model_id);

        let report_dir = self.vault_path.join("Notebooks").join("AI Intelligence");
        fs::create_dir_all(&report_dir).await?;
        let file_path = report_dir.join(format!("Benchmark — {short_name} — {today}.md"));

        let mut report = format!(
            "---\nnoteType: benchmark-report\nmodel: {model_id}\ncomparedWith: {baseline_id}\nsuite: {suite}\ndate: {today}\ntotalCost: {total_cost:.4}\navgQualityScore: {model_avg:.2}\navgLatencyMs: {avg_latency}\n---\n\n# Benchmark: {short_name} vs {}\n\n## Results\n\n| Test | Model | Baseline | Latency |\n|------|-------|----------|---------|\n",
            baseline_id.split('/').last().unwrap_or(baseline_id),
        );

        for (i, (name, score, latency)) in model_scores.iter().enumerate() {
            let b_score = baseline_scores.get(i).map(|s| s.1).unwrap_or(0.0);
            report.push_str(&format!(
                "| {name} | {score:.1}/5 | {b_score:.1}/5 | {latency}ms |\n"
            ));
        }

        report.push_str(&format!(
            "\n## Summary\n\n- **Model**: `{model_id}`\n- **Baseline**: `{baseline_id}`\n- **Suite**: {suite} ({} tests)\n- **Avg quality**: {model_avg:.1}/5 (baseline: {baseline_avg:.1}/5)\n- **Avg latency**: {avg_latency}ms\n- **Total cost**: ${total_cost:.4}\n",
            tests.len(),
        ));

        fs::write(&file_path, &report).await?;

        Ok(json!({
            "modelId": model_id,
            "baseline": baseline_id,
            "suite": suite,
            "testCount": tests.len(),
            "avgScore": format!("{model_avg:.1}"),
            "baselineAvgScore": format!("{baseline_avg:.1}"),
            "avgLatencyMs": avg_latency,
            "totalCost": format!("${total_cost:.4}"),
            "reportPath": file_path.to_string_lossy(),
        }))
    }
}

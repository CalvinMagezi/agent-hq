//! Planning tools — 11 tools for cross-agent planning system.
//!
//! Port of the TypeScript planning tools. These interact with the plan DB
//! (SQLite) for plan creation, status tracking, questions, codemap, and
//! asset management.

use anyhow::{Result, bail};
use async_trait::async_trait;
use hq_db::Database;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;

use crate::registry::HqTool;

// ─── Helpers ────────────────────────────────────────────────────

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn generate_id() -> String {
    let ts = chrono::Utc::now().timestamp_millis();
    let r = uuid::Uuid::new_v4().to_string();
    format!("plan-{ts}-{}", &r[..6])
}

fn sanitize_name(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join("-");
    if s.is_empty() {
        "v".to_string()
    } else {
        s
    }
}

async fn ensure_plan_folder(vault_path: &std::path::Path, plan_id: &str) -> Result<PathBuf> {
    let dir = vault_path.join("_plans").join("active").join(plan_id);
    fs::create_dir_all(dir.join("assets/screenshots")).await?;
    fs::create_dir_all(dir.join("assets/diagrams")).await?;
    fs::create_dir_all(dir.join("assets/scenarios")).await?;
    Ok(dir)
}

/// Derive phases heuristically based on instruction keywords.
fn derive_phases(instruction: &str, mode: &str) -> Vec<Value> {
    let max = match mode {
        "act" => 2,
        "sketch" => 3,
        _ => 5,
    };

    let instr = instruction.to_lowercase();
    let subject_re = regex_lite::Regex::new(
        r"\b(?:add|create|build|implement|fix|refactor|update|improve|migrate)\s+(?:a\s+|an\s+|the\s+)?([a-z]+(?:\s+[a-z]+){0,3})"
    ).ok();
    let subject = subject_re
        .and_then(|re| re.captures(&instr))
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "implementation".to_string());

    let phases = if instr.contains("fix") || instr.contains("bug") || instr.contains("error") {
        vec![
            json!({"phaseId": "phase-1", "title": "Identify root cause", "role": "researcher", "harness": "gemini-cli", "status": "pending"}),
            json!({"phaseId": "phase-2", "title": format!("Fix {subject}"), "role": "coder", "harness": "claude-code", "status": "pending"}),
            json!({"phaseId": "phase-3", "title": "Verify fix and add regression test", "role": "qa", "harness": "claude-code", "status": "pending"}),
        ]
    } else if instr.contains("refactor") || instr.contains("rewrite") || instr.contains("migrate") {
        vec![
            json!({"phaseId": "phase-1", "title": "Audit current implementation", "role": "researcher", "harness": "gemini-cli", "status": "pending"}),
            json!({"phaseId": "phase-2", "title": format!("Refactor {subject}"), "role": "coder", "harness": "claude-code", "status": "pending"}),
            json!({"phaseId": "phase-3", "title": "Verify behaviour unchanged", "role": "qa", "harness": "claude-code", "status": "pending"}),
            json!({"phaseId": "phase-4", "title": "Update docs and tests", "role": "coder", "harness": "claude-code", "status": "pending"}),
        ]
    } else if instr.contains("test") || instr.contains("spec") || instr.contains("coverage") {
        vec![
            json!({"phaseId": "phase-1", "title": "Analyse coverage gaps", "role": "researcher", "harness": "gemini-cli", "status": "pending"}),
            json!({"phaseId": "phase-2", "title": format!("Write tests for {subject}"), "role": "qa", "harness": "claude-code", "status": "pending"}),
            json!({"phaseId": "phase-3", "title": "Run suite and fix failures", "role": "qa", "harness": "claude-code", "status": "pending"}),
        ]
    } else {
        vec![
            json!({"phaseId": "phase-1", "title": "Analyse requirements and codebase", "role": "researcher", "harness": "gemini-cli", "status": "pending"}),
            json!({"phaseId": "phase-2", "title": format!("Implement {subject}"), "role": "coder", "harness": "claude-code", "status": "pending"}),
            json!({"phaseId": "phase-3", "title": "Write tests and verify", "role": "qa", "harness": "claude-code", "status": "pending"}),
            json!({"phaseId": "phase-4", "title": "Document changes", "role": "coder", "harness": "claude-code", "status": "pending"}),
            json!({"phaseId": "phase-5", "title": "Integration and smoke check", "role": "devops", "harness": "claude-code", "status": "pending"}),
        ]
    };

    phases.into_iter().take(max).collect()
}

// ─── 1. plan_create ─────────────────────────────────────────────

pub struct PlanCreateTool {
    vault_path: PathBuf,
    db: Arc<Database>,
}

impl PlanCreateTool {
    pub fn new(vault_path: PathBuf, db: Arc<Database>) -> Self {
        Self { vault_path, db }
    }
}

#[async_trait]
impl HqTool for PlanCreateTool {
    fn name(&self) -> &str { "plan_create" }
    fn description(&self) -> &str { "Create a new cross-agent plan with phases, questions, and flow diagram." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "instruction": { "type": "string", "description": "High-level goal" },
                "project": { "type": "string", "description": "Project name (auto-detected if omitted)" },
                "mode": { "type": "string", "enum": ["act", "sketch", "blueprint"], "description": "Planning depth" }
            },
            "required": ["instruction"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let instruction = args.get("instruction").and_then(|v| v.as_str()).unwrap_or_default();
        let project = args.get("project").and_then(|v| v.as_str()).unwrap_or("default");
        let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("sketch");

        let plan_id = generate_id();
        let now = now_iso();
        let phases = derive_phases(instruction, mode);

        let plan_dir = ensure_plan_folder(&self.vault_path, &plan_id).await?;

        // Write plan.md
        let title = &instruction[..instruction.len().min(100)];
        let phase_md: Vec<String> = phases.iter().enumerate().map(|(i, p)| {
            format!(
                "### Phase {:02}: {}\n- **Role**: `{}`\n- **Harness**: `{}`\n- **Status**: pending\n",
                i + 1,
                p["title"].as_str().unwrap_or(""),
                p["role"].as_str().unwrap_or(""),
                p["harness"].as_str().unwrap_or(""),
            )
        }).collect();

        let plan_content = format!(
            "---\nplanId: {plan_id}\ntitle: \"{}\"\nproject: {project}\nstatus: delegated\nplanningMode: {mode}\ncreatedAt: {now}\nupdatedAt: {now}\n---\n\n# Plan: {title}\n\n## Phases\n\n{}\n",
            title.replace('"', "'"),
            phase_md.join("\n"),
        );
        fs::write(plan_dir.join("plan.md"), &plan_content).await?;

        // Write manifest.json
        let manifest = json!({
            "planId": plan_id,
            "version": 1,
            "planningMode": mode,
            "assets": [],
            "createdAt": now,
            "updatedAt": now,
        });
        fs::write(
            plan_dir.join("manifest.json"),
            serde_json::to_string_pretty(&manifest)?,
        ).await?;

        // Store in DB
        let db = self.db.clone();
        let plan_id_c = plan_id.clone();
        let instruction_c = instruction.to_string();
        let project_c = project.to_string();
        let phases_json = serde_json::to_string(&phases)?;
        let mode_c = mode.to_string();
        let now_c = now.clone();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO plans (id, project, title, status, instruction, phases, planning_mode, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'delegated', ?4, ?5, ?6, ?7, ?7)",
                    rusqlite::params![plan_id_c, project_c, &instruction_c[..instruction_c.len().min(100)], instruction_c, phases_json, mode_c, now_c],
                )?;
                Ok(())
            })
        }).await??;

        Ok(json!({
            "planId": plan_id,
            "title": title,
            "status": "delegated",
            "planningMode": mode,
            "phases": phases,
            "planFolder": format!("_plans/active/{plan_id}/"),
        }))
    }
}

// ─── 2. plan_status ─────────────────────────────────────────────

pub struct PlanStatusTool {
    db: Arc<Database>,
}

impl PlanStatusTool {
    pub fn new(db: Arc<Database>) -> Self { Self { db } }
}

#[async_trait]
impl HqTool for PlanStatusTool {
    fn name(&self) -> &str { "plan_status" }
    fn description(&self) -> &str { "Get current status, phases, and signals for a plan." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "planId": { "type": "string", "description": "Plan ID" }
            },
            "required": ["planId"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let plan_id = args.get("planId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT id, project, title, status, instruction, phases, planning_mode, updated_at FROM plans WHERE id = ?1"
                )?;
                let row = stmt.query_row([&plan_id], |row| {
                    Ok(json!({
                        "planId": row.get::<_, String>(0)?,
                        "project": row.get::<_, String>(1)?,
                        "title": row.get::<_, String>(2)?,
                        "status": row.get::<_, String>(3)?,
                        "instruction": row.get::<_, String>(4)?,
                        "phases": serde_json::from_str::<Value>(&row.get::<_, String>(5)?).unwrap_or(json!([])),
                        "planningMode": row.get::<_, String>(6)?,
                        "updatedAt": row.get::<_, String>(7)?,
                    }))
                }).map_err(|_| anyhow::anyhow!("Plan not found: {plan_id}"))?;
                Ok(row)
            })
        }).await?
    }
}

// ─── 3. plan_answer ─────────────────────────────────────────────

pub struct PlanAnswerTool {
    db: Arc<Database>,
}

impl PlanAnswerTool {
    pub fn new(db: Arc<Database>) -> Self { Self { db } }
}

#[async_trait]
impl HqTool for PlanAnswerTool {
    fn name(&self) -> &str { "plan_answer" }
    fn description(&self) -> &str { "Answer a clarifying question in a plan." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "planId": { "type": "string" },
                "questionId": { "type": "integer" },
                "answer": { "type": "string" }
            },
            "required": ["planId", "questionId", "answer"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let plan_id = args.get("planId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let question_id = args.get("questionId").and_then(|v| v.as_i64()).unwrap_or(0);
        let answer = args.get("answer").and_then(|v| v.as_str()).unwrap_or_default().to_string();

        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE plan_questions SET answer = ?1, answered_at = ?2 WHERE plan_id = ?3 AND id = ?4",
                    rusqlite::params![answer, now_iso(), plan_id, question_id],
                )?;
                Ok(json!({ "acknowledged": true }))
            })
        }).await?
    }
}

// ─── 4. plan_search ─────────────────────────────────────────────

pub struct PlanSearchTool {
    db: Arc<Database>,
}

impl PlanSearchTool {
    pub fn new(db: Arc<Database>) -> Self { Self { db } }
}

#[async_trait]
impl HqTool for PlanSearchTool {
    fn name(&self) -> &str { "plan_search" }
    fn description(&self) -> &str { "Search past plans and reusable patterns." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "project": { "type": "string" }
            },
            "required": ["query"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let project = args.get("project").and_then(|v| v.as_str()).map(|s| s.to_string());

        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                let like = format!("%{query}%");
                let mut stmt = if let Some(ref proj) = project {
                    let mut s = conn.prepare(
                        "SELECT id, title, status, planning_mode FROM plans WHERE (title LIKE ?1 OR instruction LIKE ?1) AND project = ?2 LIMIT 10"
                    )?;
                    let rows: Vec<Value> = s.query_map(rusqlite::params![like, proj], |row| {
                        Ok(json!({
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "status": row.get::<_, String>(2)?,
                            "planningMode": row.get::<_, String>(3)?,
                        }))
                    })?.filter_map(|r| r.ok()).collect();
                    return Ok(json!({ "plans": rows }));
                } else {
                    let mut s = conn.prepare(
                        "SELECT id, title, status, planning_mode FROM plans WHERE title LIKE ?1 OR instruction LIKE ?1 LIMIT 10"
                    )?;
                    let rows: Vec<Value> = s.query_map([&like], |row| {
                        Ok(json!({
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "status": row.get::<_, String>(2)?,
                            "planningMode": row.get::<_, String>(3)?,
                        }))
                    })?.filter_map(|r| r.ok()).collect();
                    return Ok(json!({ "plans": rows }));
                };
            })
        }).await?
    }
}

// ─── 5. plan_update ─────────────────────────────────────────────

pub struct PlanUpdateTool {
    vault_path: PathBuf,
    db: Arc<Database>,
}

impl PlanUpdateTool {
    pub fn new(vault_path: PathBuf, db: Arc<Database>) -> Self { Self { vault_path, db } }
}

#[async_trait]
impl HqTool for PlanUpdateTool {
    fn name(&self) -> &str { "plan_update" }
    fn description(&self) -> &str { "Update plan status, outcome, or phases." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "planId": { "type": "string" },
                "status": { "type": "string" },
                "outcome": { "type": "string" },
                "phasesUpdate": { "type": "array" },
                "filesTouched": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["planId"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let plan_id = args.get("planId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let status = args.get("status").and_then(|v| v.as_str()).map(|s| s.to_string());
        let outcome = args.get("outcome").and_then(|v| v.as_str()).map(|s| s.to_string());

        let db = self.db.clone();
        let now = now_iso();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                if let Some(ref s) = status {
                    conn.execute(
                        "UPDATE plans SET status = ?1, updated_at = ?2 WHERE id = ?3",
                        rusqlite::params![s, now, plan_id],
                    )?;
                }
                if let Some(ref o) = outcome {
                    conn.execute(
                        "UPDATE plans SET outcome = ?1, updated_at = ?2 WHERE id = ?3",
                        rusqlite::params![o, now, plan_id],
                    )?;
                }
                Ok(json!({ "updated": true, "newStatus": status.unwrap_or_default() }))
            })
        }).await?
    }
}

// ─── 6. codemap_query ───────────────────────────────────────────

pub struct CodemapQueryTool {
    db: Arc<Database>,
}

impl CodemapQueryTool {
    pub fn new(db: Arc<Database>) -> Self { Self { db } }
}

#[async_trait]
impl HqTool for CodemapQueryTool {
    fn name(&self) -> &str { "codemap_query" }
    fn description(&self) -> &str { "Query the progressive codebase understanding for a project." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project": { "type": "string" },
                "query": { "type": "string" },
                "filePatterns": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["project"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let project = args.get("project").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let query = args.get("query").and_then(|v| v.as_str()).map(|s| s.to_string());

        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT file_path, purpose, key_exports, confidence FROM codemap WHERE project = ?1 ORDER BY confidence DESC LIMIT 20"
                )?;
                let rows: Vec<Value> = stmt.query_map([&project], |row| {
                    Ok(json!({
                        "filePath": row.get::<_, String>(0)?,
                        "purpose": row.get::<_, Option<String>>(1)?,
                        "keyExports": row.get::<_, Option<String>>(2)?,
                        "confidence": row.get::<_, f64>(3)?,
                    }))
                })?.filter_map(|r| r.ok()).collect();

                let filtered = if let Some(ref q) = query {
                    let q = q.to_lowercase();
                    rows.into_iter()
                        .filter(|r| {
                            let fp = r["filePath"].as_str().unwrap_or("").to_lowercase();
                            let purpose = r["purpose"].as_str().unwrap_or("").to_lowercase();
                            fp.contains(&q) || purpose.contains(&q)
                        })
                        .collect()
                } else {
                    rows
                };

                Ok(json!({ "files": filtered, "project": project }))
            })
        }).await?
    }
}

// ─── 7. codemap_update ─────────────────────────────────────────

pub struct CodemapUpdateTool {
    db: Arc<Database>,
}

impl CodemapUpdateTool {
    pub fn new(db: Arc<Database>) -> Self { Self { db } }
}

#[async_trait]
impl HqTool for CodemapUpdateTool {
    fn name(&self) -> &str { "codemap_update" }
    fn description(&self) -> &str { "Record codebase observations — agents call this after exploring files." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project": { "type": "string" },
                "entries": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "file_path": { "type": "string" },
                            "purpose": { "type": "string" },
                            "key_exports": { "type": "array" },
                            "patterns": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": ["file_path"]
                    }
                }
            },
            "required": ["project", "entries"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let project = args.get("project").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let entries = args.get("entries").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        let db = self.db.clone();
        let now = now_iso();
        let count = entries.len().min(50);
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                for entry in entries.iter().take(50) {
                    let file_path = entry.get("file_path").and_then(|v| v.as_str()).unwrap_or_default();
                    let purpose = entry.get("purpose").and_then(|v| v.as_str()).unwrap_or_default();
                    let key_exports = entry.get("key_exports").map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string());
                    conn.execute(
                        "INSERT OR REPLACE INTO codemap (project, file_path, purpose, key_exports, confidence, updated_at)
                         VALUES (?1, ?2, ?3, ?4, 0.5, ?5)",
                        rusqlite::params![project, file_path, purpose, key_exports, now],
                    )?;
                }
                Ok(json!({ "updated": count, "project": project }))
            })
        }).await?
    }
}

// ─── 8. plan_attach ─────────────────────────────────────────────

pub struct PlanAttachTool {
    vault_path: PathBuf,
    db: Arc<Database>,
}

impl PlanAttachTool {
    pub fn new(vault_path: PathBuf, db: Arc<Database>) -> Self { Self { vault_path, db } }
}

#[async_trait]
impl HqTool for PlanAttachTool {
    fn name(&self) -> &str { "plan_attach" }
    fn description(&self) -> &str { "Attach an asset (screenshot, diagram, scenario) to a plan folder." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "planId": { "type": "string" },
                "type": { "type": "string", "enum": ["screenshot", "diagram", "scenario"] },
                "sourcePath": { "type": "string", "description": "Absolute path to file" },
                "label": { "type": "string" },
                "phaseId": { "type": "string" }
            },
            "required": ["planId", "type", "sourcePath", "label"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let plan_id = args.get("planId").and_then(|v| v.as_str()).unwrap_or_default();
        let asset_type = args.get("type").and_then(|v| v.as_str()).unwrap_or("diagram");
        let source_path = args.get("sourcePath").and_then(|v| v.as_str()).unwrap_or_default();
        let label = args.get("label").and_then(|v| v.as_str()).unwrap_or_default();

        if !tokio::fs::try_exists(source_path).await.unwrap_or(false) {
            bail!("Source file not found: {source_path}");
        }

        let plan_dir = ensure_plan_folder(&self.vault_path, plan_id).await?;
        let asset_subdir = format!("assets/{asset_type}s");
        let filename = PathBuf::from(source_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let dest = plan_dir.join(&asset_subdir).join(&filename);
        tokio::fs::copy(source_path, &dest).await?;

        let rel_path = format!("{asset_subdir}/{filename}");
        let asset_id = format!("asset-{}", uuid::Uuid::new_v4());

        Ok(json!({
            "assetId": asset_id,
            "relativePath": rel_path,
            "label": label,
        }))
    }
}

// ─── 9. plan_visualize ──────────────────────────────────────────

pub struct PlanVisualizeTool {
    vault_path: PathBuf,
    db: Arc<Database>,
}

impl PlanVisualizeTool {
    pub fn new(vault_path: PathBuf, db: Arc<Database>) -> Self { Self { vault_path, db } }
}

#[async_trait]
impl HqTool for PlanVisualizeTool {
    fn name(&self) -> &str { "plan_visualize" }
    fn description(&self) -> &str { "Generate a diagram for a plan (flow, architecture, sequence, dependency)." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "planId": { "type": "string" },
                "diagramType": { "type": "string", "enum": ["architecture", "flow", "sequence", "dependency"] },
                "title": { "type": "string" },
                "description": { "type": "string" }
            },
            "required": ["planId", "diagramType"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let plan_id = args.get("planId").and_then(|v| v.as_str()).unwrap_or_default();
        let diagram_type = args.get("diagramType").and_then(|v| v.as_str()).unwrap_or("flow");
        let title = args.get("title").and_then(|v| v.as_str());

        let plan_dir = ensure_plan_folder(&self.vault_path, plan_id).await?;
        let target_dir = plan_dir.join("assets/diagrams");

        let diagram_title = title.unwrap_or(plan_id);
        let safe_name = sanitize_name(diagram_title);

        // Generate a simple SVG flow diagram as fallback
        let steps = vec!["Analyse", "Implement", "Test", "Deploy"];
        let svg_content = generate_flow_svg(diagram_title, &steps);
        let svg_path = target_dir.join(format!("{safe_name}.svg"));
        fs::write(&svg_path, &svg_content).await?;

        let rel_path = format!("assets/diagrams/{safe_name}.svg");
        Ok(json!({
            "diagramPath": rel_path,
            "displayName": format!("{safe_name}.svg"),
        }))
    }
}

fn generate_flow_svg(title: &str, steps: &[&str]) -> String {
    let w = 320;
    let node_h = 40;
    let node_w = 240;
    let gap_y = 22;
    let header_h = 44;
    let cx = w / 2;
    let total_h = header_h + steps.len() as i32 * (node_h + gap_y) + 16;

    let stroke_color = "#3b82f6";
    let fill_color = "#e2e8f0";
    let bg_color = "#0d1526";
    let label_color = "#94a3b8";

    let mut nodes = String::new();
    for (i, step) in steps.iter().enumerate() {
        let node_y = header_h + i as i32 * (node_h + gap_y);
        if i > 0 {
            let y1 = node_y - gap_y + 2;
            let y2 = node_y - 4;
            nodes.push_str(&format!(
                "<line x1=\"{cx}\" y1=\"{y1}\" x2=\"{cx}\" y2=\"{y2}\" stroke=\"{stroke_color}\" stroke-width=\"1.5\" marker-end=\"url(#arr)\"/>",
            ));
        }
        let x = cx - node_w / 2;
        nodes.push_str(&format!(
            "<rect x=\"{x}\" y=\"{node_y}\" width=\"{node_w}\" height=\"{node_h}\" rx=\"7\" fill=\"rgba(59,130,246,0.1)\" stroke=\"{stroke_color}\" stroke-width=\"1.2\"/>",
        ));
        let escaped = step.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        let text_y = node_y + 25;
        nodes.push_str(&format!(
            "<text x=\"{cx}\" y=\"{text_y}\" text-anchor=\"middle\" fill=\"{fill_color}\" font-family=\"monospace\" font-size=\"10.5\">{escaped}</text>",
        ));
    }

    let escaped_title = title.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{total_h}\">\
  <defs><marker id=\"arr\" markerWidth=\"6\" markerHeight=\"6\" refX=\"3\" refY=\"3\" orient=\"auto\"><path d=\"M0,0 L0,6 L6,3 z\" fill=\"{stroke_color}\"/></marker></defs>\
  <rect width=\"{w}\" height=\"{total_h}\" fill=\"{bg_color}\" rx=\"10\"/>\
  <text x=\"{cx}\" y=\"27\" text-anchor=\"middle\" fill=\"{label_color}\" font-family=\"monospace\" font-size=\"11\" font-weight=\"600\">{escaped_title}</text>\
  {nodes}\
</svg>"
    )
}

// ─── 10. plan_gallery ───────────────────────────────────────────

pub struct PlanGalleryTool {
    vault_path: PathBuf,
    db: Arc<Database>,
}

impl PlanGalleryTool {
    pub fn new(vault_path: PathBuf, db: Arc<Database>) -> Self { Self { vault_path, db } }
}

#[async_trait]
impl HqTool for PlanGalleryTool {
    fn name(&self) -> &str { "plan_gallery" }
    fn description(&self) -> &str { "List all assets attached to a plan." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "planId": { "type": "string" },
                "type": { "type": "string", "enum": ["screenshot", "diagram", "scenario"] }
            },
            "required": ["planId"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let plan_id = args.get("planId").and_then(|v| v.as_str()).unwrap_or_default();
        let plan_dir = self.vault_path.join("_plans/active").join(plan_id);

        let mut assets = Vec::new();
        for subdir in &["screenshots", "diagrams", "scenarios"] {
            let dir = plan_dir.join("assets").join(subdir);
            if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    assets.push(json!({
                        "type": subdir.trim_end_matches('s'),
                        "filename": entry.file_name().to_string_lossy(),
                        "path": format!("assets/{subdir}/{}", entry.file_name().to_string_lossy()),
                    }));
                }
            }
        }

        Ok(json!({
            "assets": assets,
            "totalCount": assets.len(),
            "planFolder": format!("_plans/active/{plan_id}/"),
        }))
    }
}

// ─── 11. plan_phase_update ──────────────────────────────────────

pub struct PlanPhaseUpdateTool {
    vault_path: PathBuf,
    db: Arc<Database>,
}

impl PlanPhaseUpdateTool {
    pub fn new(vault_path: PathBuf, db: Arc<Database>) -> Self { Self { vault_path, db } }
}

#[async_trait]
impl HqTool for PlanPhaseUpdateTool {
    fn name(&self) -> &str { "plan_phase_update" }
    fn description(&self) -> &str { "Mark a phase as in_progress/completed/failed/skipped. Auto-completes plan when all phases done." }
    fn category(&self) -> &str { "planning" }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "planId": { "type": "string" },
                "phaseId": { "type": "string" },
                "status": { "type": "string", "enum": ["in_progress", "completed", "failed", "skipped"] },
                "notes": { "type": "string" }
            },
            "required": ["planId", "phaseId", "status"]
        })
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let plan_id = args.get("planId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let phase_id = args.get("phaseId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let status = args.get("status").and_then(|v| v.as_str()).unwrap_or("completed").to_string();
        let notes = args.get("notes").and_then(|v| v.as_str()).map(|s| s.to_string());

        let db = self.db.clone();
        let now = now_iso();
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                // Read current phases
                let phases_str: String = conn.query_row(
                    "SELECT phases FROM plans WHERE id = ?1",
                    [&plan_id],
                    |row| row.get(0),
                ).map_err(|_| anyhow::anyhow!("Plan not found: {plan_id}"))?;

                let mut phases: Vec<Value> = serde_json::from_str(&phases_str).unwrap_or_default();

                // Update the specific phase
                let mut found = false;
                for phase in &mut phases {
                    if phase.get("phaseId").and_then(|v| v.as_str()) == Some(&phase_id) {
                        phase["status"] = json!(status);
                        if let Some(ref n) = notes {
                            phase["notes"] = json!(n);
                        }
                        found = true;
                    }
                }
                if !found {
                    anyhow::bail!("Phase not found: {phase_id}");
                }

                // Check if all phases are terminal
                let terminal = ["completed", "failed", "skipped"];
                let all_done = phases.iter().all(|p| {
                    p.get("status")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| terminal.contains(&s))
                });
                let any_failed = phases.iter().any(|p| {
                    p.get("status").and_then(|v| v.as_str()) == Some("failed")
                });

                let plan_status = if all_done {
                    if any_failed { "failed" } else { "completed" }
                } else if status == "in_progress" {
                    "in_progress"
                } else {
                    "in_progress"
                };

                let phases_json = serde_json::to_string(&phases)?;
                conn.execute(
                    "UPDATE plans SET phases = ?1, status = ?2, updated_at = ?3 WHERE id = ?4",
                    rusqlite::params![phases_json, plan_status, now, plan_id],
                )?;

                let completed_count = phases.iter().filter(|p| {
                    p.get("status").and_then(|v| v.as_str()) == Some("completed")
                }).count();

                Ok(json!({
                    "updated": true,
                    "phaseId": phase_id,
                    "phaseStatus": status,
                    "planStatus": plan_status,
                    "progress": format!("{completed_count}/{} phases completed", phases.len()),
                    "autoCompleted": all_done,
                }))
            })
        }).await?
    }
}

/// All planning tools for batch registration.
pub fn planning_tools(vault_path: PathBuf, db: Arc<Database>) -> Vec<Box<dyn HqTool>> {
    vec![
        Box::new(PlanCreateTool::new(vault_path.clone(), db.clone())),
        Box::new(PlanStatusTool::new(db.clone())),
        Box::new(PlanAnswerTool::new(db.clone())),
        Box::new(PlanSearchTool::new(db.clone())),
        Box::new(PlanUpdateTool::new(vault_path.clone(), db.clone())),
        Box::new(CodemapQueryTool::new(db.clone())),
        Box::new(CodemapUpdateTool::new(db.clone())),
        Box::new(PlanAttachTool::new(vault_path.clone(), db.clone())),
        Box::new(PlanVisualizeTool::new(vault_path.clone(), db.clone())),
        Box::new(PlanGalleryTool::new(vault_path.clone(), db.clone())),
        Box::new(PlanPhaseUpdateTool::new(vault_path, db)),
    ]
}

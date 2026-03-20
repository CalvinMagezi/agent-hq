//! DrawIt diagram tools — 6 tools for diagram generation, export, and analysis.
//!
//! Port of the TypeScript DrawIt tools. Wraps the `drawit` CLI binary.

use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::fs;
use tokio::process::Command;

use crate::registry::HqTool;

// ─── Helpers ────────────────────────────────────────────────────

async fn find_drawit_bin() -> Result<String> {
    if let Ok(output) = Command::new("which").arg("drawit").output().await {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }
    }
    let fallback = "/opt/homebrew/bin/drawit";
    if tokio::fs::try_exists(fallback).await.unwrap_or(false) {
        return Ok(fallback.to_string());
    }
    bail!("DrawIt CLI not found. Install: npm i -g @chamuka-labs/drawit-cli")
}

async fn run_drawit(args: &[&str], timeout_secs: u64) -> Result<String> {
    let bin = find_drawit_bin().await?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        Command::new(&bin).args(args).output(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("drawit timed out after {timeout_secs}s"))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("drawit failed: {stderr}");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn ensure_diagrams_dir(vault_path: &std::path::Path, subfolder: Option<&str>) -> Result<PathBuf> {
    let base = vault_path.join("Notebooks").join("Diagrams");
    let dir = match subfolder {
        Some(s) => base.join(s),
        None => base,
    };
    fs::create_dir_all(&dir).await?;
    Ok(dir)
}

fn output_path(vault_path: &std::path::Path, ext: &str) -> PathBuf {
    let now = chrono::Utc::now().timestamp_millis();
    let mut hasher = Sha256::new();
    hasher.update(format!("{now}{}", rand_hex()));
    let hash = hex::encode(&hasher.finalize()[..4]);
    let dir = vault_path.join("_jobs").join("outputs");
    dir.join(format!("diagram-{now}-{hash}.{ext}"))
}

fn rand_hex() -> String {
    let r: u32 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{r:08x}")
}

fn sanitize_name(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { ' ' })
        .collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join("-");
    if s.is_empty() { "diagram".to_string() } else { s }
}

async fn export_to_svg(drawit_path: &str, vault_path: &std::path::Path, padding: u32) -> Result<PathBuf> {
    let svg_path = output_path(vault_path, "svg");
    let dir = svg_path.parent().unwrap();
    fs::create_dir_all(dir).await?;
    run_drawit(
        &[
            "export",
            drawit_path,
            "--format",
            "svg",
            "--output",
            svg_path.to_str().unwrap_or_default(),
            "--padding",
            &padding.to_string(),
        ],
        30,
    )
    .await?;
    Ok(svg_path)
}

/// Build NDJSON from structured input (nodes + edges).
pub fn build_structured_diagram(
    title: &str,
    nodes: &[String],
    edges: &[String],
    theme: &str,
) -> String {
    let is_dark = theme == "dark";
    let bg = if is_dark { "#0a0f1e" } else { "#ffffff" };
    let text_color = if is_dark { "#e2e8f0" } else { "#333333" };
    let palette: &[&str] = if is_dark {
        &["#1e3a5f", "#2d4a3f", "#4a2d5f", "#5f3a1e", "#1e5f5a", "#5f1e3a"]
    } else {
        &["#e3f2fd", "#e8f5e9", "#f3e5f5", "#fff3e0", "#e0f7fa", "#fce4ec"]
    };
    let strokes: &[&str] = if is_dark {
        &["#3b82f6", "#34d399", "#a78bfa", "#f59e0b", "#22d3ee", "#f87171"]
    } else {
        &["#1976d2", "#4caf50", "#7b1fa2", "#ff9800", "#00bcd4", "#f44336"]
    };

    let cols = (nodes.len() as f64).sqrt().ceil() as usize;
    let (node_w, node_h, gap_x, gap_y, pad) = (180, 60, 80, 80, 80);
    let rows = (nodes.len() + cols - 1) / cols;
    let canvas_w = pad * 2 + cols * node_w + cols.saturating_sub(1) * gap_x;
    let canvas_h = pad * 2 + rows * node_h + rows.saturating_sub(1) * gap_y;

    let mut lines = vec![serde_json::to_string(&json!({
        "width": canvas_w,
        "height": canvas_h,
        "background": bg,
        "metadata": { "name": title, "diagramType": "architecture" },
    }))
    .unwrap()];

    let mut node_ids = std::collections::HashMap::new();
    for (i, label) in nodes.iter().enumerate() {
        let id = format!("n{i}");
        node_ids.insert(label.clone(), id.clone());
        let col = i % cols;
        let row = i / cols;
        let x = pad + col * (node_w + gap_x);
        let y = pad + row * (node_h + gap_y);
        let ci = i % palette.len();
        lines.push(
            serde_json::to_string(&json!({
                "id": id,
                "type": "node",
                "position": { "x": x, "y": y },
                "size": { "width": node_w, "height": node_h },
                "shape": "rectangle",
                "zIndex": 2,
                "style": {
                    "fillStyle": palette[ci],
                    "strokeStyle": strokes[ci],
                    "lineWidth": 2,
                    "fillOpacity": 1,
                    "strokeOpacity": 1,
                    "cornerRadii": { "topLeft": 8, "topRight": 8, "bottomRight": 8, "bottomLeft": 8 },
                },
                "text": {
                    "content": label,
                    "fontSize": 14,
                    "fontFamily": "sans-serif",
                    "color": text_color,
                    "textAlign": "center",
                    "verticalAlign": "middle",
                },
            }))
            .unwrap(),
        );
    }

    for (i, pair) in edges.iter().enumerate() {
        let parts: Vec<&str> = pair.split('>').map(|s| s.trim()).collect();
        if parts.len() != 2 {
            continue;
        }
        let source_id = node_ids.get(parts[0]);
        let target_id = node_ids.get(parts[1]);
        if let (Some(s), Some(t)) = (source_id, target_id) {
            let stroke = if is_dark { "#94a3b8" } else { "#64748B" };
            lines.push(
                serde_json::to_string(&json!({
                    "id": format!("e{i}"),
                    "type": "edge",
                    "source": s,
                    "target": t,
                    "zIndex": 1,
                    "style": {
                        "strokeStyle": stroke,
                        "lineWidth": 2,
                        "arrowheadEnd": true,
                        "strokeOpacity": 0.8,
                        "routing": "orthogonal",
                    },
                }))
                .unwrap(),
            );
        }
    }

    lines.join("\n") + "\n"
}

// ─── Tool 1: drawit_render ──────────────────────────────────────

pub struct DrawItRenderTool {
    vault_path: PathBuf,
}

impl DrawItRenderTool {
    pub fn new(vault_path: PathBuf) -> Self {
        Self { vault_path }
    }
}

#[async_trait]
impl HqTool for DrawItRenderTool {
    fn name(&self) -> &str {
        "drawit_render"
    }

    fn description(&self) -> &str {
        "All-in-one diagram pipeline: save NDJSON as .drawit, export to SVG/PNG. Use load_skill('drawit') first to learn the NDJSON format."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Diagram name (becomes filename)" },
                "content": { "type": "string", "description": "Full NDJSON content" },
                "folder": { "type": "string", "description": "Subfolder under Notebooks/Diagrams/" },
                "svgOnly": { "type": "boolean", "description": "Skip PNG conversion" }
            },
            "required": ["name", "content"]
        })
    }

    fn category(&self) -> &str {
        "diagram"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("diagram");
        let content = args.get("content").and_then(|v| v.as_str()).unwrap_or_default();
        let folder = args.get("folder").and_then(|v| v.as_str());
        let svg_only = args.get("svgOnly").and_then(|v| v.as_bool()).unwrap_or(false);

        let dir = ensure_diagrams_dir(&self.vault_path, folder).await?;
        let safe_name = sanitize_name(name);
        let drawit_path = dir.join(format!("{safe_name}.drawit"));
        fs::write(&drawit_path, content).await?;

        let svg_path = export_to_svg(
            drawit_path.to_str().unwrap_or_default(),
            &self.vault_path,
            20,
        )
        .await?;

        let file_path = if svg_only {
            svg_path.clone()
        } else {
            svg_path.clone() // PNG conversion requires resvg; return SVG path
        };

        let display_name = format!(
            "{safe_name}.{}",
            if svg_only { "svg" } else { "svg" }
        );

        Ok(json!({
            "message": format!(
                "Diagram saved: {}\nSVG exported: {}\n[FILE: {} | {display_name}]",
                drawit_path.display(),
                svg_path.display(),
                file_path.display(),
            ),
            "drawitPath": drawit_path.to_string_lossy(),
            "svgPath": svg_path.to_string_lossy(),
        }))
    }
}

// ─── Tool 2: drawit_export ──────────────────────────────────────

pub struct DrawItExportTool {
    vault_path: PathBuf,
}

impl DrawItExportTool {
    pub fn new(vault_path: PathBuf) -> Self {
        Self { vault_path }
    }
}

#[async_trait]
impl HqTool for DrawItExportTool {
    fn name(&self) -> &str {
        "drawit_export"
    }

    fn description(&self) -> &str {
        "Export an existing .drawit file to SVG format."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "file": { "type": "string", "description": "Absolute path to the .drawit file" },
                "format": { "type": "string", "enum": ["svg", "png"], "description": "Output format" },
                "padding": { "type": "integer", "description": "Padding in pixels (default 20)" }
            },
            "required": ["file", "format"]
        })
    }

    fn category(&self) -> &str {
        "diagram"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let file = args.get("file").and_then(|v| v.as_str()).unwrap_or_default();
        let padding = args.get("padding").and_then(|v| v.as_u64()).unwrap_or(20) as u32;

        if !tokio::fs::try_exists(file).await.unwrap_or(false) {
            bail!("File not found: {file}");
        }

        let svg_path = export_to_svg(file, &self.vault_path, padding).await?;
        let display_name = PathBuf::from(file)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
            + ".svg";

        Ok(json!({
            "message": format!("Exported SVG: {}\n[FILE: {} | {display_name}]", svg_path.display(), svg_path.display()),
            "svgPath": svg_path.to_string_lossy(),
        }))
    }
}

// ─── Tool 3: drawit_map ────────────────────────────────────────

pub struct DrawItMapTool {
    vault_path: PathBuf,
}

impl DrawItMapTool {
    pub fn new(vault_path: PathBuf) -> Self {
        Self { vault_path }
    }
}

#[async_trait]
impl HqTool for DrawItMapTool {
    fn name(&self) -> &str {
        "drawit_map"
    }

    fn description(&self) -> &str {
        "Analyze a codebase and generate a .drawit architecture map. Wraps `drawit map`."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Codebase path (default: cwd)" },
                "depth": { "type": "integer", "description": "Max directory depth (default 4)" },
                "mode": { "type": "string", "enum": ["auto", "files", "dirs"], "description": "Map mode" },
                "include": { "type": "string", "description": "File extensions glob" },
                "split": { "type": "boolean", "description": "One diagram per subdirectory" }
            }
        })
    }

    fn category(&self) -> &str {
        "diagram"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let dir = ensure_diagrams_dir(&self.vault_path, Some("codebases")).await?;
        let target_path = args
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or(".");
        let dir_name = PathBuf::from(target_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let safe_name = sanitize_name(&dir_name);
        let output_file = dir.join(format!("{safe_name}-map.drawit"));

        let mut cmd_args = vec![
            "map",
            target_path,
            "--output",
            output_file.to_str().unwrap_or_default(),
        ];
        let depth_str;
        if let Some(d) = args.get("depth").and_then(|v| v.as_u64()) {
            depth_str = d.to_string();
            cmd_args.push("--depth");
            cmd_args.push(&depth_str);
        }
        if let Some(m) = args.get("mode").and_then(|v| v.as_str()) {
            cmd_args.push("--mode");
            cmd_args.push(m);
        }
        if let Some(inc) = args.get("include").and_then(|v| v.as_str()) {
            cmd_args.push("--include");
            cmd_args.push(inc);
        }
        if args.get("split").and_then(|v| v.as_bool()).unwrap_or(false) {
            cmd_args.push("--split");
        }

        run_drawit(&cmd_args, 60).await?;

        Ok(json!({
            "message": format!("Codebase map generated: {}", output_file.display()),
            "drawitPath": output_file.to_string_lossy(),
        }))
    }
}

// ─── Tool 4: drawit_flow ───────────────────────────────────────

pub struct DrawItFlowTool {
    vault_path: PathBuf,
}

impl DrawItFlowTool {
    pub fn new(vault_path: PathBuf) -> Self {
        Self { vault_path }
    }
}

#[async_trait]
impl HqTool for DrawItFlowTool {
    fn name(&self) -> &str {
        "drawit_flow"
    }

    fn description(&self) -> &str {
        "Generate a flowchart from a list of steps. Steps ending with '?' become decision diamonds."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Ordered step labels. Questions become diamonds."
                },
                "name": { "type": "string", "description": "Diagram name (default: 'flow')" },
                "renderPng": { "type": "boolean", "description": "Also export to PNG (default: true)" }
            },
            "required": ["steps"]
        })
    }

    fn category(&self) -> &str {
        "diagram"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let steps: Vec<String> = args
            .get("steps")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        if steps.is_empty() {
            bail!("At least one step is required");
        }

        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("flow");
        let safe_name = sanitize_name(name);
        let dir = ensure_diagrams_dir(&self.vault_path, None).await?;
        let output_file = dir.join(format!("{safe_name}.drawit"));

        let mut cmd_args: Vec<&str> = vec!["flow"];
        let step_refs: Vec<&str> = steps.iter().map(|s| s.as_str()).collect();
        cmd_args.extend_from_slice(&step_refs);
        cmd_args.push("--output");
        let output_str = output_file.to_string_lossy().to_string();
        cmd_args.push(&output_str);

        run_drawit(&cmd_args, 30).await?;

        Ok(json!({
            "message": format!("Flowchart generated: {}", output_file.display()),
            "drawitPath": output_file.to_string_lossy(),
        }))
    }
}

// ─── Tool 5: drawit_analyze ────────────────────────────────────

pub struct DrawItAnalyzeTool {
    vault_path: PathBuf,
}

impl DrawItAnalyzeTool {
    pub fn new(vault_path: PathBuf) -> Self {
        Self { vault_path }
    }
}

#[async_trait]
impl HqTool for DrawItAnalyzeTool {
    fn name(&self) -> &str {
        "drawit_analyze"
    }

    fn description(&self) -> &str {
        "Analyze diagrams or generate from project artifacts. Actions: validate, inspect, deps, routes, schema."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["validate", "inspect", "deps", "routes", "schema"],
                    "description": "Analysis action"
                },
                "path": { "type": "string", "description": "Path to .drawit file or project directory" },
                "strict": { "type": "boolean", "description": "Strict validation (validate only)" },
                "renderPng": { "type": "boolean", "description": "Export to PNG (deps/routes/schema)" }
            },
            "required": ["action", "path"]
        })
    }

    fn category(&self) -> &str {
        "diagram"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("validate");
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or_default();
        let strict = args.get("strict").and_then(|v| v.as_bool()).unwrap_or(false);

        if !tokio::fs::try_exists(path).await.unwrap_or(false) {
            bail!("Path not found: {path}");
        }

        match action {
            "validate" => {
                let mut cmd_args = vec!["validate", path];
                if strict {
                    cmd_args.push("--strict");
                }
                let result = run_drawit(&cmd_args, 30).await?;
                Ok(json!({ "result": if result.is_empty() { "Diagram is valid.".to_string() } else { result } }))
            }
            "inspect" => {
                let result = run_drawit(&["inspect", path, "--elements"], 30).await?;
                Ok(json!({ "result": result }))
            }
            action @ ("deps" | "routes" | "schema") => {
                let dir = ensure_diagrams_dir(&self.vault_path, None).await?;
                let dir_name = PathBuf::from(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let safe_name = sanitize_name(&format!("{dir_name}-{action}"));
                let output_file = dir.join(format!("{safe_name}.drawit"));
                let output_str = output_file.to_string_lossy().to_string();
                run_drawit(&[action, path, "--output", &output_str], 60).await?;
                Ok(json!({
                    "message": format!("{action} diagram generated: {}", output_file.display()),
                    "drawitPath": output_file.to_string_lossy(),
                }))
            }
            _ => bail!("Unknown action: {action}"),
        }
    }
}

// ─── Tool 6: create_diagram ────────────────────────────────────

pub struct CreateDiagramTool {
    vault_path: PathBuf,
}

impl CreateDiagramTool {
    pub fn new(vault_path: PathBuf) -> Self {
        Self { vault_path }
    }
}

#[async_trait]
impl HqTool for CreateDiagramTool {
    fn name(&self) -> &str {
        "create_diagram"
    }

    fn description(&self) -> &str {
        "Create a diagram from structured input — no NDJSON knowledge needed. Provide title, node labels, and edges ('NodeA>NodeB')."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "Diagram title" },
                "nodes": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Node labels"
                },
                "edges": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Connections as 'Source>Target'"
                },
                "theme": { "type": "string", "enum": ["dark", "light"], "description": "Color theme (default: dark)" }
            },
            "required": ["title", "nodes"]
        })
    }

    fn category(&self) -> &str {
        "diagram"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("diagram");
        let nodes: Vec<String> = args
            .get("nodes")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let edges: Vec<String> = args
            .get("edges")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let theme = args.get("theme").and_then(|v| v.as_str()).unwrap_or("dark");

        if nodes.is_empty() {
            bail!("At least one node is required");
        }

        let content = build_structured_diagram(title, &nodes, &edges, theme);
        let dir = ensure_diagrams_dir(&self.vault_path, None).await?;
        let safe_name = sanitize_name(title);
        let drawit_path = dir.join(format!("{safe_name}.drawit"));
        fs::write(&drawit_path, &content).await?;

        // Export to SVG
        let svg_path = export_to_svg(
            drawit_path.to_str().unwrap_or_default(),
            &self.vault_path,
            20,
        )
        .await?;

        let display_name = format!("{safe_name}.svg");
        Ok(json!({
            "message": format!(
                "Diagram created: {}\n[FILE: {} | {display_name}]",
                drawit_path.display(),
                svg_path.display(),
            ),
            "drawitPath": drawit_path.to_string_lossy(),
            "svgPath": svg_path.to_string_lossy(),
        }))
    }
}

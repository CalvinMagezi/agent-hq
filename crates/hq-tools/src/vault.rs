//! Vault tools — 7 tools for reading, writing, searching, and managing vault notes.

use anyhow::{Result, bail};
use async_trait::async_trait;
use hq_db::Database;
use hq_vault::VaultClient;
use serde_json::{Value, json};
use std::sync::Arc;

use crate::registry::HqTool;

// ─── Helpers ────────────────────────────────────────────────────

/// Reject paths that escape the vault root via `..` or absolute prefixes.
fn validate_path(path: &str) -> Result<()> {
    if path.contains("..") || path.starts_with('/') || path.starts_with('\\') {
        bail!("path traversal not allowed: {}", path);
    }
    Ok(())
}

fn note_to_json(note: &hq_core::types::Note) -> Value {
    json!({
        "path": note.path,
        "title": note.title,
        "content": note.content,
        "tags": note.tags,
        "modified_at": note.modified_at.to_rfc3339(),
    })
}

// ─── VaultSearchTool ────────────────────────────────────────────

/// Keyword search via the FTS5 index in the database.
pub struct VaultSearchTool {
    db: Arc<Database>,
}

impl VaultSearchTool {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }
}

#[async_trait]
impl HqTool for VaultSearchTool {
    fn name(&self) -> &str {
        "vault_search"
    }

    fn description(&self) -> &str {
        "Search vault notes by keyword query (FTS5). Returns matching paths, titles, and snippets."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search query" },
                "limit": { "type": "integer", "description": "Max results (default 20)", "default": 20 }
            },
            "required": ["query"]
        })
    }

    fn category(&self) -> &str {
        "vault"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20) as usize;

        let db = self.db.clone();
        let results: Vec<hq_core::types::SearchResult> = tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| hq_db::search::keyword_search(conn, &query, limit))
        })
        .await??;

        let items: Vec<Value> = results
            .into_iter()
            .map(|r| {
                json!({ "path": r.note_path, "title": r.title, "snippet": r.snippet, "relevance": r.relevance })
            })
            .collect();

        Ok(json!({ "results": items, "count": items.len() }))
    }
}

// ─── VaultReadTool ──────────────────────────────────────────────

/// Read a single note by relative path.
pub struct VaultReadTool {
    vault: Arc<VaultClient>,
}

impl VaultReadTool {
    pub fn new(vault: Arc<VaultClient>) -> Self {
        Self { vault }
    }
}

#[async_trait]
impl HqTool for VaultReadTool {
    fn name(&self) -> &str {
        "vault_read"
    }

    fn description(&self) -> &str {
        "Read a vault note by its relative path. Returns title, content, tags, and metadata."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative path inside the vault (e.g. Notebooks/Projects/foo.md)" }
            },
            "required": ["path"]
        })
    }

    fn category(&self) -> &str {
        "vault"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        validate_path(path)?;

        let vault = self.vault.clone();
        let path_owned = path.to_string();
        let note = tokio::task::spawn_blocking(move || vault.read_note(&path_owned)).await??;
        Ok(note_to_json(&note))
    }
}

// ─── VaultContextTool ───────────────────────────────────────────

/// Read the four system context files: SOUL, MEMORY, PREFERENCES, HEARTBEAT.
pub struct VaultContextTool {
    vault: Arc<VaultClient>,
}

impl VaultContextTool {
    pub fn new(vault: Arc<VaultClient>) -> Self {
        Self { vault }
    }
}

#[async_trait]
impl HqTool for VaultContextTool {
    fn name(&self) -> &str {
        "vault_context"
    }

    fn description(&self) -> &str {
        "Read system context files (SOUL.md, MEMORY.md, PREFERENCES.md, HEARTBEAT.md) from the vault root."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {},
            "required": []
        })
    }

    fn category(&self) -> &str {
        "vault"
    }

    async fn execute(&self, _args: Value) -> Result<Value> {
        let vault = self.vault.clone();
        let ctx = tokio::task::spawn_blocking(move || -> Result<Value> {
            let read = |name: &str| -> String {
                vault
                    .read_note(name)
                    .map(|n| n.content)
                    .unwrap_or_default()
            };
            Ok(json!({
                "soul": read("SOUL.md"),
                "memory": read("MEMORY.md"),
                "preferences": read("PREFERENCES.md"),
                "heartbeat": read("HEARTBEAT.md"),
            }))
        })
        .await??;
        Ok(ctx)
    }
}

// ─── VaultListTool ──────────────────────────────────────────────

/// List markdown files in a vault directory.
pub struct VaultListTool {
    vault: Arc<VaultClient>,
}

impl VaultListTool {
    pub fn new(vault: Arc<VaultClient>) -> Self {
        Self { vault }
    }
}

#[async_trait]
impl HqTool for VaultListTool {
    fn name(&self) -> &str {
        "vault_list"
    }

    fn description(&self) -> &str {
        "List markdown files in a vault directory. Optionally recurse into subdirectories."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "directory": { "type": "string", "description": "Relative directory to list (default: root)", "default": "" },
                "recursive": { "type": "boolean", "description": "Recurse into subdirectories", "default": false }
            },
            "required": []
        })
    }

    fn category(&self) -> &str {
        "vault"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let dir = args
            .get("directory")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let recursive = args
            .get("recursive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        validate_path(dir)?;

        let vault = self.vault.clone();
        let dir_owned = dir.to_string();
        let paths = tokio::task::spawn_blocking(move || {
            if recursive {
                vault.list_notes_recursive(&dir_owned)
            } else {
                vault.list_notes(&dir_owned)
            }
        })
        .await??;

        Ok(json!({ "paths": paths, "count": paths.len() }))
    }
}

// ─── VaultBatchReadTool ─────────────────────────────────────────

/// Read up to 20 notes at once.
pub struct VaultBatchReadTool {
    vault: Arc<VaultClient>,
}

impl VaultBatchReadTool {
    pub fn new(vault: Arc<VaultClient>) -> Self {
        Self { vault }
    }
}

#[async_trait]
impl HqTool for VaultBatchReadTool {
    fn name(&self) -> &str {
        "vault_batch_read"
    }

    fn description(&self) -> &str {
        "Read up to 20 vault notes at once. Returns an array of notes (or errors for missing paths)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Array of relative paths (max 20)",
                    "maxItems": 20
                }
            },
            "required": ["paths"]
        })
    }

    fn category(&self) -> &str {
        "vault"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let paths: Vec<String> = args
            .get("paths")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        if paths.len() > 20 {
            bail!("batch_read limited to 20 paths, got {}", paths.len());
        }

        for p in &paths {
            validate_path(p)?;
        }

        let vault = self.vault.clone();
        let results = tokio::task::spawn_blocking(move || -> Vec<Value> {
            paths
                .iter()
                .map(|p| match vault.read_note(p) {
                    Ok(note) => note_to_json(&note),
                    Err(e) => json!({ "path": p, "error": e.to_string() }),
                })
                .collect()
        })
        .await?;

        Ok(json!({ "notes": results, "count": results.len() }))
    }
}

// ─── VaultWriteNoteTool ─────────────────────────────────────────

/// Write a note, restricted to the `Notebooks/` prefix.
pub struct VaultWriteNoteTool {
    vault: Arc<VaultClient>,
}

impl VaultWriteNoteTool {
    pub fn new(vault: Arc<VaultClient>) -> Self {
        Self { vault }
    }
}

#[async_trait]
impl HqTool for VaultWriteNoteTool {
    fn name(&self) -> &str {
        "vault_write_note"
    }

    fn description(&self) -> &str {
        "Write or update a vault note. Path must start with Notebooks/ (safety restriction)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative path starting with Notebooks/" },
                "title": { "type": "string", "description": "Note title" },
                "content": { "type": "string", "description": "Markdown content body" },
                "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional tags", "default": [] }
            },
            "required": ["path", "title", "content"]
        })
    }

    fn category(&self) -> &str {
        "vault"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let tags: Vec<String> = args
            .get("tags")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        validate_path(&path)?;
        if !path.starts_with("Notebooks/") {
            bail!("vault_write_note is restricted to Notebooks/ prefix, got: {path}");
        }

        let mut frontmatter = std::collections::HashMap::new();
        frontmatter.insert(
            "title".to_string(),
            serde_yaml::Value::String(title.clone()),
        );
        if !tags.is_empty() {
            frontmatter.insert(
                "tags".to_string(),
                serde_yaml::Value::Sequence(
                    tags.iter()
                        .map(|t| serde_yaml::Value::String(t.clone()))
                        .collect(),
                ),
            );
        }

        let note = hq_core::types::Note {
            title: title.clone(),
            content,
            path: path.clone(),
            frontmatter,
            note_type: None,
            tags,
            pinned: false,
            source: None,
            embedding_status: None,
            created_at: None,
            updated_at: None,
            modified_at: chrono::Utc::now(),
        };

        let vault = self.vault.clone();
        let path_ret = path.clone();
        tokio::task::spawn_blocking(move || vault.write_note(&path, &note)).await??;

        Ok(json!({ "ok": true, "path": path_ret }))
    }
}

// ─── VaultCreateJobTool ─────────────────────────────────────────

/// Create a new job in the vault pending queue.
pub struct VaultCreateJobTool {
    vault: Arc<VaultClient>,
}

impl VaultCreateJobTool {
    pub fn new(vault: Arc<VaultClient>) -> Self {
        Self { vault }
    }
}

#[async_trait]
impl HqTool for VaultCreateJobTool {
    fn name(&self) -> &str {
        "vault_create_job"
    }

    fn description(&self) -> &str {
        "Create a new background job in the vault pending queue."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "instruction": { "type": "string", "description": "Job instruction / prompt" },
                "model": { "type": "string", "description": "Optional model override" }
            },
            "required": ["instruction"]
        })
    }

    fn category(&self) -> &str {
        "vault"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let instruction = args
            .get("instruction")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let model = args
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let vault = self.vault.clone();
        let job = tokio::task::spawn_blocking(move || {
            vault.create_job(&instruction, model.as_deref())
        })
        .await??;

        Ok(json!({
            "ok": true,
            "job_id": job.id,
            "status": "pending",
        }))
    }
}

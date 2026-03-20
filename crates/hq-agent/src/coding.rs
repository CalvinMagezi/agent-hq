//! Coding tools — bash, file I/O, search tools for agent sessions.

use anyhow::Result;
use async_trait::async_trait;
use hq_core::types::{ToolResult, ToolResultContent};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tracing::{debug, warn};

use crate::tools::AgentTool;

// ─── Constants ──────────────────────────────────────────────────

const BASH_TIMEOUT_SECS: u64 = 120;
const MAX_OUTPUT_BYTES: usize = 50 * 1024; // 50 KB
const FIND_FILE_LIMIT: usize = 200;

// ─── Helpers ────────────────────────────────────────────────────

fn text_result(text: impl Into<String>) -> ToolResult {
    ToolResult {
        content: vec![ToolResultContent {
            r#type: "text".to_string(),
            text: text.into(),
        }],
        details: None,
    }
}

fn truncate_output(output: &str, max_bytes: usize) -> String {
    if output.len() <= max_bytes {
        output.to_string()
    } else {
        let truncated = &output[..max_bytes];
        format!(
            "{}\n\n... [output truncated, {} bytes total]",
            truncated,
            output.len()
        )
    }
}

// ─── BashTool ───────────────────────────────────────────────────

/// Execute a shell command via `bash -c`.
pub struct BashTool;

#[async_trait]
impl AgentTool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }

    fn description(&self) -> &str {
        "Execute a bash command and return its output. Commands have a 120 second timeout."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute"
                },
                "timeout": {
                    "type": "integer",
                    "description": "Optional timeout in seconds (default 120)"
                }
            }
        })
    }

    async fn execute(&self, _id: &str, args: Value) -> Result<ToolResult> {
        let command = args
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing required parameter: command"))?;

        let timeout_secs = args
            .get("timeout")
            .and_then(|v| v.as_u64())
            .unwrap_or(BASH_TIMEOUT_SECS);

        debug!(command = %command, timeout = timeout_secs, "executing bash command");

        let result = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            tokio::process::Command::new("bash")
                .arg("-c")
                .arg(command)
                .output(),
        )
        .await;

        match result {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let exit_code = output.status.code().unwrap_or(-1);

                let mut text = String::new();
                if !stdout.is_empty() {
                    text.push_str(&stdout);
                }
                if !stderr.is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str("STDERR:\n");
                    text.push_str(&stderr);
                }
                if text.is_empty() {
                    text = format!("(no output, exit code {})", exit_code);
                } else if exit_code != 0 {
                    text.push_str(&format!("\n(exit code {})", exit_code));
                }

                Ok(text_result(truncate_output(&text, MAX_OUTPUT_BYTES)))
            }
            Ok(Err(e)) => Ok(text_result(format!("Error executing command: {}", e))),
            Err(_) => Ok(text_result(format!(
                "Command timed out after {}s",
                timeout_secs
            ))),
        }
    }
}

// ─── ReadTool ───────────────────────────────────────────────────

/// Read a file with line numbers (cat -n style).
pub struct ReadTool;

#[async_trait]
impl AgentTool for ReadTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "Read a file from disk with line numbers. Supports offset and limit parameters \
         for reading specific sections of large files."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["file_path"],
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file to read"
                },
                "offset": {
                    "type": "integer",
                    "description": "Line number to start reading from (1-based)"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of lines to read (default: 2000)"
                }
            }
        })
    }

    async fn execute(&self, _id: &str, args: Value) -> Result<ToolResult> {
        let file_path = args
            .get("file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing required parameter: file_path"))?;

        let offset = args
            .get("offset")
            .and_then(|v| v.as_u64())
            .unwrap_or(1) as usize;
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(2000) as usize;

        debug!(path = %file_path, offset = offset, limit = limit, "reading file");

        let path = Path::new(file_path);
        if !path.exists() {
            return Ok(text_result(format!("File not found: {}", file_path)));
        }

        let content = tokio::fs::read_to_string(path).await?;
        let lines: Vec<&str> = content.lines().collect();
        let total_lines = lines.len();

        // offset is 1-based
        let start = if offset > 0 { offset - 1 } else { 0 };
        let end = (start + limit).min(total_lines);

        if start >= total_lines {
            return Ok(text_result(format!(
                "Offset {} exceeds file length ({} lines)",
                offset, total_lines
            )));
        }

        let mut output = String::new();
        for (i, line) in lines[start..end].iter().enumerate() {
            let line_num = start + i + 1;
            // cat -n format: right-aligned line numbers with tab
            output.push_str(&format!("{:>6}\t{}\n", line_num, line));
        }

        if end < total_lines {
            output.push_str(&format!(
                "\n... ({} more lines, {} total)",
                total_lines - end,
                total_lines
            ));
        }

        Ok(text_result(output))
    }
}

// ─── WriteTool ──────────────────────────────────────────────────

/// Write content to a file, creating parent directories as needed.
pub struct WriteTool;

#[async_trait]
impl AgentTool for WriteTool {
    fn name(&self) -> &str {
        "write_file"
    }

    fn description(&self) -> &str {
        "Write content to a file. Creates parent directories if they don't exist. \
         Overwrites existing files."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["file_path", "content"],
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file to write"
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file"
                }
            }
        })
    }

    async fn execute(&self, _id: &str, args: Value) -> Result<ToolResult> {
        let file_path = args
            .get("file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing required parameter: file_path"))?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing required parameter: content"))?;

        debug!(path = %file_path, bytes = content.len(), "writing file");

        let path = Path::new(file_path);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        tokio::fs::write(path, content).await?;
        Ok(text_result(format!(
            "Successfully wrote {} bytes to {}",
            content.len(),
            file_path
        )))
    }
}

// ─── EditTool ───────────────────────────────────────────────────

/// Exact string replacement in a file.
pub struct EditTool;

#[async_trait]
impl AgentTool for EditTool {
    fn name(&self) -> &str {
        "edit_file"
    }

    fn description(&self) -> &str {
        "Perform an exact string replacement in a file. The old_string must appear \
         exactly once in the file (unless replace_all is true)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["file_path", "old_string", "new_string"],
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file to edit"
                },
                "old_string": {
                    "type": "string",
                    "description": "The exact text to find and replace"
                },
                "new_string": {
                    "type": "string",
                    "description": "The replacement text"
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "Replace all occurrences (default: false)"
                }
            }
        })
    }

    async fn execute(&self, _id: &str, args: Value) -> Result<ToolResult> {
        let file_path = args
            .get("file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing required parameter: file_path"))?;
        let old_string = args
            .get("old_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing required parameter: old_string"))?;
        let new_string = args
            .get("new_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing required parameter: new_string"))?;
        let replace_all = args
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        debug!(path = %file_path, replace_all = replace_all, "editing file");

        let path = Path::new(file_path);
        if !path.exists() {
            return Ok(text_result(format!("File not found: {}", file_path)));
        }

        let content = tokio::fs::read_to_string(path).await?;
        let occurrences = content.matches(old_string).count();

        if occurrences == 0 {
            return Ok(text_result(
                "Error: old_string not found in file. Make sure you have the exact text.",
            ));
        }

        if !replace_all && occurrences > 1 {
            return Ok(text_result(format!(
                "Error: old_string found {} times. Provide more context to make it unique, \
                 or set replace_all=true.",
                occurrences
            )));
        }

        let new_content = if replace_all {
            content.replace(old_string, new_string)
        } else {
            content.replacen(old_string, new_string, 1)
        };

        tokio::fs::write(path, &new_content).await?;
        Ok(text_result(format!(
            "Successfully replaced {} occurrence(s) in {}",
            if replace_all { occurrences } else { 1 },
            file_path
        )))
    }
}

// ─── FindTool ───────────────────────────────────────────────────

/// Glob-based file finder.
pub struct FindTool;

#[async_trait]
impl AgentTool for FindTool {
    fn name(&self) -> &str {
        "find_files"
    }

    fn description(&self) -> &str {
        "Find files matching a glob pattern. Returns up to 200 matching file paths."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern (e.g., \"**/*.rs\", \"src/**/*.ts\")"
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search in (defaults to current directory)"
                }
            }
        })
    }

    async fn execute(&self, _id: &str, args: Value) -> Result<ToolResult> {
        let pattern = args
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing required parameter: pattern"))?;
        let base_path = args
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or(".");

        debug!(pattern = %pattern, path = %base_path, "finding files");

        // Build full glob pattern
        let full_pattern = if pattern.starts_with('/') {
            pattern.to_string()
        } else {
            format!("{}/{}", base_path, pattern)
        };

        // Run glob in a blocking task since it does filesystem I/O
        let results = tokio::task::spawn_blocking(move || -> Result<Vec<String>> {
            let mut files = Vec::new();
            for entry in glob::glob(&full_pattern)? {
                match entry {
                    Ok(path) => {
                        files.push(path.display().to_string());
                        if files.len() >= FIND_FILE_LIMIT {
                            break;
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, "glob entry error");
                    }
                }
            }
            files.sort();
            Ok(files)
        })
        .await??;

        if results.is_empty() {
            Ok(text_result("No files found matching the pattern."))
        } else {
            let truncated = if results.len() >= FIND_FILE_LIMIT {
                format!("\n\n(results limited to {} files)", FIND_FILE_LIMIT)
            } else {
                String::new()
            };
            Ok(text_result(format!(
                "{} file(s) found:\n{}{}",
                results.len(),
                results.join("\n"),
                truncated
            )))
        }
    }
}

// ─── GrepTool ───────────────────────────────────────────────────

/// Search file contents using ripgrep (`rg`).
pub struct GrepTool;

#[async_trait]
impl AgentTool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }

    fn description(&self) -> &str {
        "Search file contents using ripgrep (rg). Supports regex patterns, \
         file type filters, and context lines."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern to search for"
                },
                "path": {
                    "type": "string",
                    "description": "File or directory to search in (defaults to current directory)"
                },
                "file_type": {
                    "type": "string",
                    "description": "File type filter (e.g., \"rs\", \"ts\", \"py\")"
                },
                "context": {
                    "type": "integer",
                    "description": "Number of context lines to show around matches"
                },
                "case_insensitive": {
                    "type": "boolean",
                    "description": "Case insensitive search (default: false)"
                }
            }
        })
    }

    async fn execute(&self, _id: &str, args: Value) -> Result<ToolResult> {
        let pattern = args
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing required parameter: pattern"))?;
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or(".");
        let file_type = args.get("file_type").and_then(|v| v.as_str());
        let context = args.get("context").and_then(|v| v.as_u64());
        let case_insensitive = args
            .get("case_insensitive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        debug!(pattern = %pattern, path = %path, "running grep");

        let mut cmd = tokio::process::Command::new("rg");
        cmd.arg("--no-heading")
            .arg("--line-number")
            .arg("--color=never");

        if case_insensitive {
            cmd.arg("-i");
        }
        if let Some(ft) = file_type {
            cmd.arg("--type").arg(ft);
        }
        if let Some(ctx) = context {
            cmd.arg("-C").arg(ctx.to_string());
        }

        cmd.arg(pattern).arg(path);

        let result = tokio::time::timeout(Duration::from_secs(30), cmd.output()).await;

        match result {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.is_empty() {
                    Ok(text_result("No matches found."))
                } else {
                    Ok(text_result(truncate_output(&stdout, MAX_OUTPUT_BYTES)))
                }
            }
            Ok(Err(e)) => {
                // rg not found — provide a helpful message
                Ok(text_result(format!(
                    "Error running ripgrep: {}. Is `rg` installed?",
                    e
                )))
            }
            Err(_) => Ok(text_result("Grep timed out after 30 seconds.")),
        }
    }
}

// ─── LsTool ─────────────────────────────────────────────────────

/// List directory contents with file sizes.
pub struct LsTool;

#[async_trait]
impl AgentTool for LsTool {
    fn name(&self) -> &str {
        "list_dir"
    }

    fn description(&self) -> &str {
        "List directory contents with file sizes. Shows files and subdirectories."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the directory to list"
                }
            }
        })
    }

    async fn execute(&self, _id: &str, args: Value) -> Result<ToolResult> {
        let dir_path = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing required parameter: path"))?;

        debug!(path = %dir_path, "listing directory");

        let path = Path::new(dir_path);
        if !path.exists() {
            return Ok(text_result(format!("Directory not found: {}", dir_path)));
        }
        if !path.is_dir() {
            return Ok(text_result(format!("Not a directory: {}", dir_path)));
        }

        let path_owned = path.to_path_buf();
        let entries = tokio::task::spawn_blocking(move || -> Result<Vec<String>> {
            let mut items = Vec::new();
            for entry in std::fs::read_dir(&path_owned)? {
                let entry = entry?;
                let metadata = entry.metadata()?;
                let name = entry.file_name().to_string_lossy().to_string();

                if metadata.is_dir() {
                    items.push(format!("  {}/ (dir)", name));
                } else {
                    let size = metadata.len();
                    let size_str = format_size(size);
                    items.push(format!("  {} ({})", name, size_str));
                }
            }
            items.sort();
            Ok(items)
        })
        .await??;

        if entries.is_empty() {
            Ok(text_result(format!("{} (empty directory)", dir_path)))
        } else {
            Ok(text_result(format!(
                "{}:\n{}",
                dir_path,
                entries.join("\n")
            )))
        }
    }
}

fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

// ─── Registration helper ────────────────────────────────────────

/// Register all coding tools into a ToolRegistry.
pub fn register_coding_tools(registry: &mut crate::tools::ToolRegistry) {
    registry.register(Box::new(BashTool));
    registry.register(Box::new(ReadTool));
    registry.register(Box::new(WriteTool));
    registry.register(Box::new(EditTool));
    registry.register(Box::new(FindTool));
    registry.register(Box::new(GrepTool));
    registry.register(Box::new(LsTool));
}

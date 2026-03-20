//! Tool governance — security profiles and path-based access control.

use anyhow::Result;
use async_trait::async_trait;
use hq_core::types::{SecurityProfile, ToolResult, ToolResultContent};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tracing::{debug, warn};

use crate::tools::AgentTool;

// ─── Tool call limits per security profile ──────────────────────

fn tool_call_limit(profile: &SecurityProfile) -> u32 {
    match profile {
        SecurityProfile::Minimal => 10,
        SecurityProfile::Standard => 20,
        SecurityProfile::Guarded => 40,
        SecurityProfile::Admin => 50,
    }
}

// ─── Path-sensitive tools ───────────────────────────────────────

/// Tools that interact with the filesystem and need path checks.
const PATH_TOOLS: &[&str] = &[
    "read_file",
    "write_file",
    "edit_file",
    "find_files",
    "list_dir",
    "bash",
];

/// Which argument keys contain file paths for each tool.
fn path_args_for_tool(tool_name: &str) -> &[&str] {
    match tool_name {
        "read_file" | "write_file" | "edit_file" => &["file_path"],
        "find_files" | "list_dir" => &["path"],
        _ => &[],
    }
}

// ─── ToolGuardian ───────────────────────────────────────────────

/// Governs tool execution with path restrictions and call limits.
#[derive(Debug, Clone)]
pub struct ToolGuardian {
    allowed_paths: Vec<PathBuf>,
    profile: SecurityProfile,
}

impl ToolGuardian {
    /// Create a new guardian with the given allowed paths and security profile.
    pub fn new(allowed_paths: Vec<PathBuf>, profile: SecurityProfile) -> Self {
        Self {
            allowed_paths,
            profile,
        }
    }

    /// Wrap a tool with governance checks.
    pub fn govern(&self, tool: Box<dyn AgentTool>) -> Box<dyn AgentTool> {
        Box::new(GovernedTool {
            inner: tool,
            allowed_paths: self.allowed_paths.clone(),
            profile: self.profile.clone(),
            call_count: Arc::new(AtomicU32::new(0)),
            call_limit: tool_call_limit(&self.profile),
        })
    }

    /// Get the security profile.
    pub fn profile(&self) -> &SecurityProfile {
        &self.profile
    }
}

// ─── GovernedTool ───────────────────────────────────────────────

/// A tool wrapped with governance: path checking and call limits.
struct GovernedTool {
    inner: Box<dyn AgentTool>,
    allowed_paths: Vec<PathBuf>,
    profile: SecurityProfile,
    call_count: Arc<AtomicU32>,
    call_limit: u32,
}

impl GovernedTool {
    /// Check if a path is within the allowed paths.
    fn is_path_allowed(&self, path: &str) -> bool {
        if self.allowed_paths.is_empty() {
            return true;
        }

        let target = Path::new(path);

        // Attempt to canonicalize; fall back to the raw path
        let resolved = target
            .canonicalize()
            .unwrap_or_else(|_| target.to_path_buf());

        self.allowed_paths
            .iter()
            .any(|allowed| resolved.starts_with(allowed))
    }

    /// Validate path arguments in the tool call.
    fn check_paths(&self, args: &Value) -> Option<String> {
        let tool_name = self.inner.name();
        let path_keys = path_args_for_tool(tool_name);

        for key in path_keys {
            if let Some(path_val) = args.get(*key).and_then(|v| v.as_str()) {
                if !self.is_path_allowed(path_val) {
                    return Some(format!(
                        "Access denied: path '{}' is outside allowed directories. \
                         Allowed: {:?}",
                        path_val, self.allowed_paths
                    ));
                }
            }
        }

        None
    }
}

#[async_trait]
impl AgentTool for GovernedTool {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn description(&self) -> &str {
        self.inner.description()
    }

    fn parameters(&self) -> Value {
        self.inner.parameters()
    }

    async fn execute(&self, id: &str, args: Value) -> Result<ToolResult> {
        // Check call limit
        let count = self.call_count.fetch_add(1, Ordering::SeqCst);
        if count >= self.call_limit {
            warn!(
                tool = self.inner.name(),
                count = count,
                limit = self.call_limit,
                profile = ?self.profile,
                "tool call limit exceeded"
            );
            return Ok(ToolResult {
                content: vec![ToolResultContent {
                    r#type: "text".to_string(),
                    text: format!(
                        "Tool call limit exceeded ({}/{} for {:?} profile). \
                         Please complete the task with the information you have.",
                        count, self.call_limit, self.profile
                    ),
                }],
                details: None,
            });
        }

        // Check path restrictions for filesystem tools
        if PATH_TOOLS.contains(&self.inner.name()) {
            if let Some(denial) = self.check_paths(&args) {
                debug!(
                    tool = self.inner.name(),
                    denial = %denial,
                    "path access denied by governance"
                );
                return Ok(ToolResult {
                    content: vec![ToolResultContent {
                        r#type: "text".to_string(),
                        text: denial,
                    }],
                    details: None,
                });
            }
        }

        // Execute the inner tool
        self.inner.execute(id, args).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_call_limits() {
        assert_eq!(tool_call_limit(&SecurityProfile::Minimal), 10);
        assert_eq!(tool_call_limit(&SecurityProfile::Standard), 20);
        assert_eq!(tool_call_limit(&SecurityProfile::Guarded), 40);
        assert_eq!(tool_call_limit(&SecurityProfile::Admin), 50);
    }
}

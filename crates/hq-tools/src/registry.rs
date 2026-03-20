//! Tool registry — trait definition, registry struct, discovery.

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Every tool in the HQ system implements this trait.
#[async_trait]
pub trait HqTool: Send + Sync {
    /// Machine-readable name (e.g. `vault_search`).
    fn name(&self) -> &str;

    /// Human-readable description shown during discovery.
    fn description(&self) -> &str;

    /// JSON Schema for the tool's input parameters.
    fn parameters(&self) -> Value;

    /// Execute the tool with the given arguments, returning a JSON result.
    async fn execute(&self, args: Value) -> Result<Value>;

    /// Optional category tag used for filtering in `discover`.
    fn category(&self) -> &str {
        "general"
    }
}

/// Compact summary returned by `list` and `discover`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSummary {
    pub name: String,
    pub description: String,
    pub category: String,
    pub parameters: Value,
}

/// Central registry of all available tools.
pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn HqTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// Register a tool. Overwrites any existing tool with the same name.
    pub fn register(&mut self, tool: Box<dyn HqTool>) {
        let name = tool.name().to_string();
        self.tools.insert(name, tool);
    }

    /// Look up a tool by name.
    pub fn get(&self, name: &str) -> Option<&dyn HqTool> {
        self.tools.get(name).map(|t| t.as_ref())
    }

    /// List summaries of every registered tool.
    pub fn list(&self) -> Vec<ToolSummary> {
        let mut out: Vec<ToolSummary> = self
            .tools
            .values()
            .map(|t| ToolSummary {
                name: t.name().to_string(),
                description: t.description().to_string(),
                category: t.category().to_string(),
                parameters: t.parameters(),
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Discover tools matching an optional category and/or free-text query.
    ///
    /// - If `category` is `Some`, only tools whose category matches are returned.
    /// - If `query` is `Some`, the name and description are searched (case-insensitive substring).
    pub fn discover(&self, category: Option<&str>, query: Option<&str>) -> Vec<ToolSummary> {
        self.tools
            .values()
            .filter(|t| {
                if let Some(cat) = category {
                    if t.category() != cat {
                        return false;
                    }
                }
                if let Some(q) = query {
                    let q_lower = q.to_lowercase();
                    let in_name = t.name().to_lowercase().contains(&q_lower);
                    let in_desc = t.description().to_lowercase().contains(&q_lower);
                    if !in_name && !in_desc {
                        return false;
                    }
                }
                true
            })
            .map(|t| ToolSummary {
                name: t.name().to_string(),
                description: t.description().to_string(),
                category: t.category().to_string(),
                parameters: t.parameters(),
            })
            .collect()
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

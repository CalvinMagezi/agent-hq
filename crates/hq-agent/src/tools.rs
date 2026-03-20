//! Tool trait and registry for agent tool execution.

use anyhow::Result;
use async_trait::async_trait;
use hq_core::types::{ToolDefinition, ToolResult};
use serde_json::Value;
use std::collections::HashMap;

/// Trait for tools that an agent can invoke during a session.
#[async_trait]
pub trait AgentTool: Send + Sync {
    /// Unique name of this tool (e.g., "bash", "read_file").
    fn name(&self) -> &str;

    /// Human-readable description shown to the LLM.
    fn description(&self) -> &str;

    /// JSON Schema for the tool's parameters.
    fn parameters(&self) -> Value;

    /// Execute the tool with the given arguments.
    /// `id` is the tool_call_id from the LLM response.
    async fn execute(&self, id: &str, args: Value) -> Result<ToolResult>;
}

/// Registry holding all available tools for a session.
pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn AgentTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// Register a tool. Overwrites any existing tool with the same name.
    pub fn register(&mut self, tool: Box<dyn AgentTool>) {
        let name = tool.name().to_string();
        self.tools.insert(name, tool);
    }

    /// Look up a tool by name.
    pub fn get(&self, name: &str) -> Option<&dyn AgentTool> {
        self.tools.get(name).map(|b| b.as_ref())
    }

    /// Return tool definitions for LLM function calling.
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .map(|t| ToolDefinition {
                name: t.name().to_string(),
                description: t.description().to_string(),
                parameters: t.parameters(),
            })
            .collect()
    }

    /// Number of registered tools.
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Iterate over tool names.
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.tools.keys().map(|s| s.as_str())
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

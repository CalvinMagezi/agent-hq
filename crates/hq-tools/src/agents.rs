//! Agent definition loading — parse agent markdown files, list/load agents as tools.

use anyhow::Result;
use async_trait::async_trait;
use hq_core::types::{AgentDefinition, AgentVertical};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

use crate::registry::HqTool;

// ─── Parsing ────────────────────────────────────────────────────

/// Parse an agent definition from `<agents_dir>/<vertical>/<name>.md`.
pub fn parse_agent_file(agents_dir: &Path, vertical: &str, name: &str) -> Option<AgentDefinition> {
    let agent_path = agents_dir.join(vertical).join(format!("{name}.md"));
    let raw = std::fs::read_to_string(&agent_path).ok()?;

    let matter = gray_matter::Matter::<gray_matter::engine::YAML>::new();
    let result = matter.parse(&raw);

    // Extract frontmatter as YAML, then deserialize into AgentDefinition fields.
    let fm_yaml = match &result.data {
        Some(gray_matter::Pod::Hash(map)) => {
            let yaml_map: serde_yaml::Mapping = map
                .iter()
                .map(|(k, v)| {
                    (
                        serde_yaml::Value::String(k.clone()),
                        pod_to_yaml(v),
                    )
                })
                .collect();
            serde_yaml::Value::Mapping(yaml_map)
        }
        _ => serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
    };

    // Deserialize what we can from frontmatter, then fill in defaults.
    let mut agent: AgentDefinition = serde_yaml::from_value(fm_yaml).ok().unwrap_or_else(|| {
        AgentDefinition {
            name: name.to_string(),
            display_name: name.to_string(),
            version: None,
            vertical: None,
            base_role: None,
            preferred_harness: None,
            preferred_model: None,
            max_turns: None,
            tags: Vec::new(),
            auto_load: false,
            instruction: String::new(),
            fallback_chain: Vec::new(),
        }
    });

    // Always override name from filename and instruction from content body.
    if agent.name.is_empty() {
        agent.name = name.to_string();
    }
    if agent.display_name.is_empty() {
        agent.display_name = agent.name.clone();
    }
    agent.instruction = result.content;

    // If vertical wasn't in frontmatter, infer from directory name.
    if agent.vertical.is_none() {
        agent.vertical = match vertical {
            "engineering" => Some(AgentVertical::Engineering),
            "qa" => Some(AgentVertical::Qa),
            "research" => Some(AgentVertical::Research),
            "content" => Some(AgentVertical::Content),
            "ops" => Some(AgentVertical::Ops),
            _ => None,
        };
    }

    Some(agent)
}

/// List all agents, optionally filtered by vertical.
pub fn list_agents(agents_dir: &Path, vertical_filter: Option<&str>) -> Vec<AgentDefinition> {
    let Ok(entries) = std::fs::read_dir(agents_dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let vertical = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Skip if vertical filter doesn't match
        if let Some(filter) = vertical_filter {
            if vertical != filter {
                continue;
            }
        }

        // Skip hidden directories
        if vertical.starts_with('.') {
            continue;
        }

        let Ok(agent_files) = std::fs::read_dir(&path) else {
            continue;
        };

        for agent_entry in agent_files.flatten() {
            let agent_path = agent_entry.path();
            if agent_path.extension().is_some_and(|ext| ext == "md") {
                let name = agent_path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if let Some(agent) = parse_agent_file(agents_dir, &vertical, &name) {
                    out.push(agent);
                }
            }
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Build a prompt-ready section from an agent definition.
pub fn build_agent_prompt_section(agent: &AgentDefinition) -> String {
    let mut parts = Vec::new();
    parts.push(format!("## Agent: {} ({})", agent.display_name, agent.name));

    if let Some(ref v) = agent.vertical {
        parts.push(format!("**Vertical**: {v:?}"));
    }
    if let Some(ref r) = agent.base_role {
        parts.push(format!("**Role**: {r:?}"));
    }
    if !agent.tags.is_empty() {
        parts.push(format!("**Tags**: {}", agent.tags.join(", ")));
    }

    parts.push(String::new());
    parts.push(agent.instruction.clone());

    parts.join("\n")
}

// ─── ListAgentsTool ─────────────────────────────────────────────

pub struct ListAgentsTool {
    agents_dir: PathBuf,
}

impl ListAgentsTool {
    pub fn new(agents_dir: PathBuf) -> Self {
        Self { agents_dir }
    }
}

#[async_trait]
impl HqTool for ListAgentsTool {
    fn name(&self) -> &str {
        "list_agents"
    }

    fn description(&self) -> &str {
        "List all available agent definitions, optionally filtered by vertical (engineering, qa, research, content, ops)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "vertical": {
                    "type": "string",
                    "description": "Filter by vertical (engineering, qa, research, content, ops)",
                    "enum": ["engineering", "qa", "research", "content", "ops"]
                }
            },
            "required": []
        })
    }

    fn category(&self) -> &str {
        "agents"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let vertical = args.get("vertical").and_then(|v| v.as_str());

        let agents = list_agents(&self.agents_dir, vertical);
        let summaries: Vec<Value> = agents
            .iter()
            .map(|a| {
                json!({
                    "name": a.name,
                    "display_name": a.display_name,
                    "vertical": a.vertical,
                    "base_role": a.base_role,
                    "tags": a.tags,
                })
            })
            .collect();

        Ok(json!({ "agents": summaries, "count": summaries.len() }))
    }
}

// ─── LoadAgentTool ──────────────────────────────────────────────

pub struct LoadAgentTool {
    agents_dir: PathBuf,
}

impl LoadAgentTool {
    pub fn new(agents_dir: PathBuf) -> Self {
        Self { agents_dir }
    }
}

#[async_trait]
impl HqTool for LoadAgentTool {
    fn name(&self) -> &str {
        "load_agent"
    }

    fn description(&self) -> &str {
        "Load a specific agent definition by vertical and name. Returns full instruction and metadata."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "vertical": { "type": "string", "description": "Agent vertical (e.g. engineering)" },
                "name": { "type": "string", "description": "Agent name (filename without .md)" }
            },
            "required": ["vertical", "name"]
        })
    }

    fn category(&self) -> &str {
        "agents"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let vertical = args
                .get("vertical")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default();

            match parse_agent_file(&self.agents_dir, vertical, name) {
                Some(agent) => {
                    let prompt = build_agent_prompt_section(&agent);
                    Ok(json!({
                        "name": agent.name,
                        "display_name": agent.display_name,
                        "vertical": agent.vertical,
                        "base_role": agent.base_role,
                        "preferred_harness": agent.preferred_harness,
                        "preferred_model": agent.preferred_model,
                        "tags": agent.tags,
                        "instruction": agent.instruction,
                        "prompt_section": prompt,
                    }))
                }
                None => Ok(json!({ "error": format!("agent not found: {vertical}/{name}") })),
            }
    }
}

// ─── Helpers ────────────────────────────────────────────────────

fn pod_to_yaml(pod: &gray_matter::Pod) -> serde_yaml::Value {
    match pod {
        gray_matter::Pod::String(s) => serde_yaml::Value::String(s.clone()),
        gray_matter::Pod::Integer(i) => serde_yaml::Value::Number(serde_yaml::Number::from(*i)),
        gray_matter::Pod::Float(f) => serde_yaml::Value::Number(serde_yaml::Number::from(*f)),
        gray_matter::Pod::Boolean(b) => serde_yaml::Value::Bool(*b),
        gray_matter::Pod::Null => serde_yaml::Value::Null,
        gray_matter::Pod::Array(arr) => {
            serde_yaml::Value::Sequence(arr.iter().map(pod_to_yaml).collect())
        }
        gray_matter::Pod::Hash(map) => {
            let mapping: serde_yaml::Mapping = map
                .iter()
                .map(|(k, v)| (serde_yaml::Value::String(k.clone()), pod_to_yaml(v)))
                .collect();
            serde_yaml::Value::Mapping(mapping)
        }
    }
}

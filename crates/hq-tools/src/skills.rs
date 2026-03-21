//! Skill loading — parse SKILL.md files, list/load skills as tools.

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

use crate::registry::HqTool;

// ─── Types ──────────────────────────────────────────────────────

/// Parsed skill definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDefinition {
    pub name: String,
    pub description: String,
    pub auto_load: bool,
    /// Keywords that trigger contextual loading when found in a task/instruction.
    pub hints: Vec<String>,
    pub content: String,
}

/// Compact metadata returned by list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    pub auto_load: bool,
    pub hints: Vec<String>,
}

// ─── Parsing ────────────────────────────────────────────────────

/// Parse a single skill from `<skills_dir>/<name>/SKILL.md`.
/// Name is sanitized to prevent path traversal.
pub fn parse_skill(skills_dir: &Path, name: &str) -> Option<SkillDefinition> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return None;
    }
    let skill_path = skills_dir.join(name).join("SKILL.md");
    let raw = std::fs::read_to_string(&skill_path).ok()?;

    let matter = gray_matter::Matter::<gray_matter::engine::YAML>::new();
    let result = matter.parse(&raw);

    let description = result
        .data
        .as_ref()
        .and_then(|d| match d {
            gray_matter::Pod::Hash(map) => map
                .get("description")
                .and_then(|v| match v {
                    gray_matter::Pod::String(s) => Some(s.clone()),
                    _ => None,
                }),
            _ => None,
        })
        .unwrap_or_else(|| format!("Skill: {name}"));

    let auto_load = result
        .data
        .as_ref()
        .and_then(|d| match d {
            gray_matter::Pod::Hash(map) => map
                .get("autoLoad")
                .and_then(|v| match v {
                    gray_matter::Pod::Boolean(b) => Some(*b),
                    _ => None,
                }),
            _ => None,
        })
        .unwrap_or(false);

    let hints = result
        .data
        .as_ref()
        .and_then(|d| match d {
            gray_matter::Pod::Hash(map) => map.get("hints").and_then(|v| match v {
                gray_matter::Pod::Array(arr) => Some(
                    arr.iter()
                        .filter_map(|item| match item {
                            gray_matter::Pod::String(s) => Some(s.to_lowercase()),
                            _ => None,
                        })
                        .collect(),
                ),
                _ => None,
            }),
            _ => None,
        })
        .unwrap_or_default();

    Some(SkillDefinition {
        name: name.to_string(),
        description,
        auto_load,
        hints,
        content: result.content,
    })
}

/// List all skills in the skills directory.
pub fn list_skills(skills_dir: &Path) -> Vec<SkillMeta> {
    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if let Some(skill) = parse_skill(skills_dir, &name) {
                out.push(SkillMeta {
                    name: skill.name,
                    description: skill.description,
                    auto_load: skill.auto_load,
                    hints: skill.hints,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

// ─── SkillHintIndex ─────────────────────────────────────────────

/// Lightweight in-memory index of skill metadata.
///
/// Built once at startup from the skills directory. Holds only names and
/// one-line descriptions — no skill content is ever loaded into the index.
/// Agents discover skills passively via the catalog block injected into
/// prompts and load full content on-demand with `load_skill`.
pub struct SkillHintIndex {
    entries: Vec<SkillHintEntry>,
}

struct SkillHintEntry {
    name: String,
    description: String,
    hints: Vec<String>,
}

impl SkillHintIndex {
    /// Build the index by scanning the skills directory.
    ///
    /// Reads only frontmatter (name, description, hints) — no content loaded.
    /// Returns an empty index if the directory doesn't exist.
    pub fn build(skills_dir: &Path) -> Self {
        let metas = list_skills(skills_dir);
        let entries = metas
            .into_iter()
            .map(|m| SkillHintEntry {
                name: m.name,
                description: m.description,
                hints: m.hints,
            })
            .collect();

        Self { entries }
    }

    /// Returns true if the index has any skills at all.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Generate a compact skill catalog block for prompt injection.
    ///
    /// Each skill gets one line: name, description, and hint keywords.
    /// Agents use `load_skill` tool to fetch full content on-demand.
    /// Typically <50 bytes per skill — negligible context cost.
    pub fn catalog_block(&self) -> String {
        if self.entries.is_empty() {
            return String::new();
        }

        let mut out = String::from("# Available HQ Skills\n\n");
        out.push_str("Use `load_skill` tool to load full instructions for any skill.\n\n");

        for entry in &self.entries {
            out.push_str(&format!("- **{}**: {}", entry.name, entry.description));
            if !entry.hints.is_empty() {
                out.push_str(&format!(" [hints: {}]", entry.hints.join(", ")));
            }
            out.push('\n');
        }

        out
    }
}

/// Enrich a base system prompt with the skill catalog.
///
/// This is the single function all entry points should call. Extremely
/// lightweight: injects only skill names and descriptions (~1 line each),
/// never full skill content. If no skills exist, returns the base prompt
/// unchanged.
pub fn enrich_system_prompt(
    index: &SkillHintIndex,
    base_prompt: &str,
    _instruction: &str,
) -> String {
    let catalog = index.catalog_block();

    if catalog.is_empty() {
        return base_prompt.to_string();
    }

    let mut result = String::with_capacity(base_prompt.len() + catalog.len() + 4);
    result.push_str(base_prompt);
    result.push_str("\n\n");
    result.push_str(&catalog);
    result
}

// ─── ListSkillsTool ─────────────────────────────────────────────

pub struct ListSkillsTool {
    skills_dir: PathBuf,
}

impl ListSkillsTool {
    pub fn new(skills_dir: PathBuf) -> Self {
        Self { skills_dir }
    }
}

#[async_trait]
impl HqTool for ListSkillsTool {
    fn name(&self) -> &str {
        "list_skills"
    }

    fn description(&self) -> &str {
        "List all available skills with name, description, auto-load status, and hint keywords. \
         Use hints to determine which skills are relevant to the current task — \
         if any hint keyword appears in the user's message, load that skill with load_skill."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {},
            "required": []
        })
    }

    fn category(&self) -> &str {
        "skills"
    }

    async fn execute(&self, _args: Value) -> Result<Value> {
        let skills = list_skills(&self.skills_dir);
        Ok(json!({ "skills": skills, "count": skills.len() }))
    }
}

// ─── LoadSkillTool ──────────────────────────────────────────────

pub struct LoadSkillTool {
    skills_dir: PathBuf,
}

impl LoadSkillTool {
    pub fn new(skills_dir: PathBuf) -> Self {
        Self { skills_dir }
    }
}

#[async_trait]
impl HqTool for LoadSkillTool {
    fn name(&self) -> &str {
        "load_skill"
    }

    fn description(&self) -> &str {
        "Load a skill by name. Returns the full skill content (instructions)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Skill name (directory name)" }
            },
            "required": ["name"]
        })
    }

    fn category(&self) -> &str {
        "skills"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default();

            match parse_skill(&self.skills_dir, name) {
                Some(skill) => Ok(json!({
                    "name": skill.name,
                    "description": skill.description,
                    "content": skill.content,
                    "auto_load": skill.auto_load,
                })),
                None => Ok(json!({ "error": format!("skill not found: {name}") })),
            }
        }
    }
}

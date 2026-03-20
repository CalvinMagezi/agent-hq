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
    pub content: String,
}

/// Compact metadata returned by list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    pub auto_load: bool,
}

// ─── Parsing ────────────────────────────────────────────────────

/// Parse a single skill from `<skills_dir>/<name>/SKILL.md`.
pub fn parse_skill(skills_dir: &Path, name: &str) -> Option<SkillDefinition> {
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

    Some(SkillDefinition {
        name: name.to_string(),
        description,
        auto_load,
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
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Concatenate all auto-loaded skill contents into a single string.
pub fn get_auto_loaded_skill_content(skills_dir: &Path) -> String {
    let metas = list_skills(skills_dir);
    let mut parts = Vec::new();
    for meta in &metas {
        if meta.auto_load {
            if let Some(skill) = parse_skill(skills_dir, &meta.name) {
                parts.push(format!(
                    "## Skill: {}\n\n{}",
                    skill.name, skill.content
                ));
            }
        }
    }
    parts.join("\n\n---\n\n")
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
        "List all available skills with name, description, and auto-load status."
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

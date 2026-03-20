//! System context — SOUL.md, MEMORY.md, PREFERENCES.md, HEARTBEAT.md
//!
//! The `_system/` directory in the vault holds identity and state files
//! that define agent personality, memory, preferences, and heartbeat.

use anyhow::{Context, Result};
use chrono::Utc;
use hq_core::types::{Note, SystemContext};
use std::collections::HashMap;
use std::path::Path;
use tracing::debug;

const SYSTEM_DIR: &str = "_system";

/// Well-known system file names.
pub const SOUL_FILE: &str = "SOUL.md";
pub const MEMORY_FILE: &str = "MEMORY.md";
pub const PREFERENCES_FILE: &str = "PREFERENCES.md";
pub const HEARTBEAT_FILE: &str = "HEARTBEAT.md";
pub const CONFIG_FILE: &str = "CONFIG.md";
pub const DIGEST_TOPICS_FILE: &str = "DIGEST-TOPICS.md";

/// Read a system file by name (e.g. "SOUL.md") from `_system/`.
/// Returns the raw content string or an empty string if the file doesn't exist.
pub fn read_system_file(vault_path: &Path, name: &str) -> Result<String> {
    let path = vault_path.join(SYSTEM_DIR).join(name);
    if !path.exists() {
        debug!(file = name, "system file does not exist, returning empty");
        return Ok(String::new());
    }
    std::fs::read_to_string(&path)
        .with_context(|| format!("reading system file: {}", name))
}

/// Write a system file by name to `_system/`.
pub fn write_system_file(vault_path: &Path, name: &str, content: &str) -> Result<()> {
    let dir = vault_path.join(SYSTEM_DIR);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(name);
    std::fs::write(&path, content)?;
    debug!(file = name, "wrote system file");
    Ok(())
}

/// Read all system files and pinned notes into a `SystemContext`.
pub fn get_system_context(vault_path: &Path) -> Result<SystemContext> {
    let soul = read_system_file(vault_path, SOUL_FILE)?;
    let memory = read_system_file(vault_path, MEMORY_FILE)?;
    let preferences = read_system_file(vault_path, PREFERENCES_FILE)?;
    let heartbeat = read_system_file(vault_path, HEARTBEAT_FILE)?;

    // Parse config key-value table from CONFIG.md
    let config_raw = read_system_file(vault_path, CONFIG_FILE)?;
    let config = parse_config_table(&config_raw);

    // Scan for pinned notes
    let pinned_notes = get_pinned_notes(vault_path)?;

    Ok(SystemContext {
        soul,
        memory,
        preferences,
        heartbeat,
        config,
        pinned_notes,
    })
}

/// Scan `Notebooks/` recursively for notes with `pinned: true` in frontmatter.
/// Returns at most 10 pinned notes.
pub fn get_pinned_notes(vault_path: &Path) -> Result<Vec<Note>> {
    let notebooks_dir = vault_path.join("Notebooks");
    if !notebooks_dir.exists() {
        return Ok(Vec::new());
    }

    let mut pinned = Vec::new();
    collect_pinned(&notebooks_dir, vault_path, &mut pinned, 10)?;
    Ok(pinned)
}

fn collect_pinned(
    dir: &Path,
    vault_root: &Path,
    out: &mut Vec<Note>,
    limit: usize,
) -> Result<()> {
    if out.len() >= limit {
        return Ok(());
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    for entry in entries {
        if out.len() >= limit {
            break;
        }
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with('.') {
                collect_pinned(&path, vault_root, out, limit)?;
            }
        } else if path.extension().is_some_and(|ext| ext == "md") {
            // Quick check for pinned frontmatter without full parse
            if let Ok(content) = std::fs::read_to_string(&path) {
                if content.contains("pinned: true") || content.contains("pinned: yes") {
                    if let Ok(rel) = path.strip_prefix(vault_root) {
                        let rel_str = rel.to_string_lossy().to_string();
                        match crate::notes::read_note(vault_root, &rel_str) {
                            Ok(note) => out.push(note),
                            Err(_) => {} // skip unparseable notes
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Update the heartbeat file with worker status and metadata.
pub fn update_heartbeat(
    vault_path: &Path,
    worker_id: &str,
    metadata: &HashMap<String, String>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let mut content = format!(
        "---\nnoteType: system-file\nfileName: heartbeat\nversion: 1\nlastProcessed: \"{}\"\nworkerId: \"{}\"\n",
        now, worker_id
    );

    for (key, value) in metadata {
        content.push_str(&format!("{}: \"{}\"\n", key, value));
    }

    content.push_str("---\n# Heartbeat\n\n");
    content.push_str(&format!("Last heartbeat: {}\n", now));
    content.push_str(&format!("Worker: {}\n", worker_id));

    write_system_file(vault_path, HEARTBEAT_FILE, &content)
}

/// Parse a markdown table (key-value) from CONFIG.md.
fn parse_config_table(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();

    // Skip frontmatter
    let body = if raw.starts_with("---") {
        if let Some(end) = raw[3..].find("---") {
            &raw[end + 6..]
        } else {
            raw
        }
    } else {
        raw
    };

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('|') && trimmed.ends_with('|') {
            let cells: Vec<&str> = trimmed
                .trim_matches('|')
                .split('|')
                .map(|s| s.trim())
                .collect();
            if cells.len() >= 2 {
                let key = cells[0].trim();
                let value = cells[1].trim();
                // Skip header row and separator
                if !key.is_empty()
                    && !value.is_empty()
                    && key != "Key"
                    && !key.starts_with("---")
                    && !key.starts_with('-')
                {
                    map.insert(key.to_string(), value.to_string());
                }
            }
        }
    }

    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_config_table() {
        let raw = r#"---
noteType: system-file
---
# Configuration

| Key | Value |
|-----|-------|
| DEFAULT_MODEL | gemini-2.5-flash |
| orchestration_mode | internal |
"#;
        let config = parse_config_table(raw);
        assert_eq!(config.get("DEFAULT_MODEL").unwrap(), "gemini-2.5-flash");
        assert_eq!(config.get("orchestration_mode").unwrap(), "internal");
    }
}

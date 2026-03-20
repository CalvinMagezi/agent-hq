use anyhow::{Context, Result};
use chrono::Utc;
use hq_core::types::Note;
use std::path::{Path, PathBuf};
use tracing::debug;

use crate::frontmatter;

/// Read a note from the vault by relative path.
pub fn read_note(vault_path: &Path, rel_path: &str) -> Result<Note> {
    let full_path = vault_path.join(rel_path);
    let raw = std::fs::read_to_string(&full_path)
        .with_context(|| format!("reading note: {}", rel_path))?;

    let (fm, content) = frontmatter::parse(&raw)?;

    let title = fm
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| extract_title_from_content(&content, rel_path));

    let metadata = std::fs::metadata(&full_path)?;
    let modified_at = metadata
        .modified()
        .map(|t| chrono::DateTime::<Utc>::from(t))
        .unwrap_or_else(|_| Utc::now());

    let tags: Vec<String> = fm
        .get("tags")
        .and_then(|v| {
            if let serde_yaml::Value::Sequence(seq) = v {
                Some(
                    seq.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect(),
                )
            } else {
                None
            }
        })
        .unwrap_or_default();

    let pinned = fm
        .get("pinned")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Ok(Note {
        path: rel_path.to_string(),
        title,
        content,
        frontmatter: fm,
        note_type: None,
        tags,
        pinned,
        source: None,
        embedding_status: None,
        created_at: None,
        updated_at: None,
        modified_at,
    })
}

/// Write a note to the vault.
pub fn write_note(vault_path: &Path, rel_path: &str, note: &Note) -> Result<()> {
    let full_path = vault_path.join(rel_path);

    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let raw = frontmatter::serialize(&note.frontmatter, &note.content)?;
    std::fs::write(&full_path, raw)?;
    debug!(path = %rel_path, "wrote note");
    Ok(())
}

/// List all markdown files in a directory (non-recursive).
pub fn list_notes(vault_path: &Path, dir: &str) -> Result<Vec<String>> {
    let full_path = vault_path.join(dir);
    if !full_path.exists() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    for entry in std::fs::read_dir(&full_path)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "md") {
            if let Ok(rel) = path.strip_prefix(vault_path) {
                paths.push(rel.to_string_lossy().to_string());
            }
        }
    }
    paths.sort();
    Ok(paths)
}

/// List all markdown files recursively.
pub fn list_notes_recursive(vault_path: &Path, dir: &str) -> Result<Vec<String>> {
    let full_path = vault_path.join(dir);
    if !full_path.exists() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    walk_dir(&full_path, vault_path, &mut paths)?;
    paths.sort();
    Ok(paths)
}

fn walk_dir(dir: &Path, vault_root: &Path, out: &mut Vec<String>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            // Skip hidden directories and _data
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with('.') && name != "_data" {
                walk_dir(&path, vault_root, out)?;
            }
        } else if path.extension().is_some_and(|ext| ext == "md") {
            if let Ok(rel) = path.strip_prefix(vault_root) {
                out.push(rel.to_string_lossy().to_string());
            }
        }
    }
    Ok(())
}

fn extract_title_from_content(content: &str, rel_path: &str) -> String {
    // Try to find first heading
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("# ") {
            return heading.trim().to_string();
        }
    }
    // Fallback to filename without extension
    PathBuf::from(rel_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| rel_path.to_string())
}

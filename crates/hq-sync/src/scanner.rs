//! Full vault scanner — recursive directory walk with ignore rules.

use anyhow::Result;
use std::path::Path;

use crate::hash;

/// A file entry discovered during a vault scan.
#[derive(Debug, Clone)]
pub struct FileEntry {
    /// Relative path from vault root (forward slashes).
    pub path: String,
    /// File size in bytes.
    pub size: u64,
    /// Last modification time as Unix timestamp (seconds).
    pub mtime: u64,
    /// SHA-256 hex hash of file contents.
    pub content_hash: String,
}

/// Directories to ignore during scanning and watching.
const IGNORED_DIRS: &[&str] = &[
    ".obsidian",
    "_embeddings",
    ".git",
    "node_modules",
    ".tmp",
    "_history",
];

/// File names to ignore.
const IGNORED_FILES: &[&str] = &[".DS_Store"];

/// Recursively scan a vault directory, returning all `.md` files.
/// Applies the same ignore rules as the file watcher.
pub fn scan_vault(vault_path: &Path) -> Result<Vec<FileEntry>> {
    let mut entries = Vec::new();
    walk_vault(vault_path, vault_path, &mut entries)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Check whether a path component should be ignored.
pub(crate) fn should_ignore(path: &Path) -> bool {
    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            let name_str = name.to_string_lossy();

            // Ignore hidden directories (starting with .)
            if name_str.starts_with('.') {
                for ignored in IGNORED_DIRS {
                    if name_str == *ignored {
                        return true;
                    }
                }
                // .git is already in IGNORED_DIRS, but also catch .obsidian etc.
                if name_str == ".git" || name_str == ".obsidian" {
                    return true;
                }
            }

            for ignored in IGNORED_DIRS {
                if name_str == *ignored {
                    return true;
                }
            }

            for ignored in IGNORED_FILES {
                if name_str == *ignored {
                    return true;
                }
            }
        }
    }
    false
}

fn walk_vault(dir: &Path, vault_root: &Path, out: &mut Vec<FileEntry>) -> Result<()> {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };

    for entry in read_dir {
        let entry = entry?;
        let path = entry.path();
        let file_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Skip ignored names
        if IGNORED_DIRS.contains(&file_name.as_str()) || IGNORED_FILES.contains(&file_name.as_str())
        {
            continue;
        }

        // Skip hidden dirs/files not explicitly listed
        if file_name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            walk_vault(&path, vault_root, out)?;
        } else if path.extension().is_some_and(|ext| ext == "md") {
            let metadata = std::fs::metadata(&path)?;
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let content_hash = hash::hash_file(&path)?;
            let rel_path = path
                .strip_prefix(vault_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            out.push(FileEntry {
                path: rel_path,
                size: metadata.len(),
                mtime,
                content_hash,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_ignore() {
        assert!(should_ignore(Path::new(".obsidian/plugins")));
        assert!(should_ignore(Path::new("_embeddings/index.db")));
        assert!(should_ignore(Path::new(".git/HEAD")));
        assert!(should_ignore(Path::new("node_modules/pkg")));
        assert!(should_ignore(Path::new(".tmp/cache")));
        assert!(should_ignore(Path::new("_history/old")));
        assert!(!should_ignore(Path::new("Notebooks/daily.md")));
    }
}

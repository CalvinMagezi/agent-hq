use walkdir::WalkDir;
use std::collections::HashMap;

#[napi]
pub fn walk_vault_files(root: String, skip_patterns: Vec<String>, ext_filter: Option<String>) -> Vec<String> {
    let mut files = Vec::new();
    let walker = WalkDir::new(&root).into_iter();

    for entry in walker.filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !skip_patterns.iter().any(|p| name.contains(p))
    }) {
        if let Ok(entry) = entry {
            if entry.file_type().is_file() {
                if let Some(ext) = &ext_filter {
                    if entry.path().extension().and_then(|s| s.to_str()) == Some(ext) {
                        if let Ok(rel_path) = entry.path().strip_prefix(&root) {
                            files.push(rel_path.to_string_lossy().into_owned());
                        }
                    }
                } else {
                    if let Ok(rel_path) = entry.path().strip_prefix(&root) {
                        files.push(rel_path.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    files
}

#[napi]
pub fn resolve_wikilinks(vault_root: String, wikilinks: Vec<String>) -> Vec<Option<String>> {
    // 1. Index the vault files first for O(1) resolution
    let mut index = HashMap::new();
    let walker = WalkDir::new(&vault_root).into_iter();

    for entry in walker {
        if let Ok(entry) = entry {
            if entry.file_type().is_file() && entry.path().extension().and_then(|s| s.to_str()) == Some("md") {
                let stem = entry.path().file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if let Ok(rel_path) = entry.path().strip_prefix(&vault_root) {
                    // Storing only the most likely candidate (first match)
                    // In real Obsidian, this is more complex (relative paths etc.)
                    index.entry(stem.to_string()).or_insert_with(|| rel_path.to_string_lossy().into_owned());
                }
            }
        }
    }

    // 2. Resolve each wikilink
    wikilinks.into_iter().map(|link| {
        // Handle alias: [[Link|Alias]] -> Link
        let target = if let Some(pos) = link.find('|') {
            &link[..pos]
        } else {
            &link
        };
        
        index.get(target).cloned()
    }).collect()
}

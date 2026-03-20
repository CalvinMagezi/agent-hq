//! NoteQuery — chainable, fluent query builder for vault notes.
//!
//! Ported from `packages/vault-client/src/noteQuery.ts`.
//! Provides a composable API for filtering notes by tags, noteType, date ranges,
//! status, and custom frontmatter predicates without requiring SQL or embeddings.
//!
//! Usage:
//! ```ignore
//! let results = vault.query("Projects")
//!     .with_tags(vec!["agent-hq"], TagMatchMode::Any)
//!     .of_type(NoteType::Report)
//!     .modified_after("2026-03-01")
//!     .pinned(true)
//!     .limit(10)
//!     .sort_by(SortField::UpdatedAt, SortDir::Desc)
//!     .exec()?;
//! ```

use anyhow::Result;
use hq_core::types::{EmbeddingStatus, Note, NoteType};
use std::path::{Path, PathBuf};

use crate::frontmatter;

/// Sort field for query results.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortField {
    UpdatedAt,
    CreatedAt,
    Title,
}

/// Sort direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDir {
    Asc,
    Desc,
}

/// Tag match mode — any or all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagMatchMode {
    Any,
    All,
}

/// Internal filter state.
struct QueryFilters {
    tags: Option<Vec<String>>,
    tag_match_mode: TagMatchMode,
    note_type: Option<NoteType>,
    embedding_status: Option<EmbeddingStatus>,
    pinned: Option<bool>,
    source: Option<String>,
    modified_after: Option<String>,
    modified_before: Option<String>,
    created_after: Option<String>,
    created_before: Option<String>,
    title_contains: Option<String>,
    content_contains: Option<String>,
    custom: Option<Box<dyn Fn(&std::collections::HashMap<String, serde_yaml::Value>, &str) -> bool>>,
    max_results: Option<usize>,
    sort_field: SortField,
    sort_dir: SortDir,
    columns: Option<Vec<String>>,
}

impl Default for QueryFilters {
    fn default() -> Self {
        Self {
            tags: None,
            tag_match_mode: TagMatchMode::Any,
            note_type: None,
            embedding_status: None,
            pinned: None,
            source: None,
            modified_after: None,
            modified_before: None,
            created_after: None,
            created_before: None,
            title_contains: None,
            content_contains: None,
            custom: None,
            max_results: None,
            sort_field: SortField::UpdatedAt,
            sort_dir: SortDir::Desc,
            columns: None,
        }
    }
}

/// A chainable query builder for vault notes.
pub struct NoteQuery {
    vault_path: PathBuf,
    folder: String,
    filters: QueryFilters,
}

impl NoteQuery {
    /// Create a new query scoped to `Notebooks/{folder}` inside the vault.
    pub fn new(vault_path: impl Into<PathBuf>, folder: impl Into<String>) -> Self {
        Self {
            vault_path: vault_path.into(),
            folder: folder.into(),
            filters: QueryFilters::default(),
        }
    }

    /// Filter notes that have ANY (or ALL) of the given tags.
    pub fn with_tags(mut self, tags: Vec<String>, match_mode: TagMatchMode) -> Self {
        self.filters.tags = Some(tags);
        self.filters.tag_match_mode = match_mode;
        self
    }

    /// Filter by noteType.
    pub fn of_type(mut self, note_type: NoteType) -> Self {
        self.filters.note_type = Some(note_type);
        self
    }

    /// Filter by embedding status.
    pub fn with_embedding_status(mut self, status: EmbeddingStatus) -> Self {
        self.filters.embedding_status = Some(status);
        self
    }

    /// Only pinned notes (or only unpinned if `value` is `false`).
    pub fn pinned(mut self, value: bool) -> Self {
        self.filters.pinned = Some(value);
        self
    }

    /// Filter by source field.
    pub fn from_source(mut self, source: impl Into<String>) -> Self {
        self.filters.source = Some(source.into());
        self
    }

    /// Notes modified after this ISO date string.
    pub fn modified_after(mut self, date: impl Into<String>) -> Self {
        self.filters.modified_after = Some(date.into());
        self
    }

    /// Notes modified before this ISO date string.
    pub fn modified_before(mut self, date: impl Into<String>) -> Self {
        self.filters.modified_before = Some(date.into());
        self
    }

    /// Notes created after this ISO date string.
    pub fn created_after(mut self, date: impl Into<String>) -> Self {
        self.filters.created_after = Some(date.into());
        self
    }

    /// Notes created before this ISO date string.
    pub fn created_before(mut self, date: impl Into<String>) -> Self {
        self.filters.created_before = Some(date.into());
        self
    }

    /// Filter by title substring (case-insensitive).
    pub fn title_contains(mut self, text: impl Into<String>) -> Self {
        self.filters.title_contains = Some(text.into());
        self
    }

    /// Filter by content substring (case-insensitive).
    pub fn content_contains(mut self, text: impl Into<String>) -> Self {
        self.filters.content_contains = Some(text.into());
        self
    }

    /// Custom frontmatter/content predicate.
    pub fn where_fn(
        mut self,
        predicate: impl Fn(&std::collections::HashMap<String, serde_yaml::Value>, &str) -> bool + 'static,
    ) -> Self {
        self.filters.custom = Some(Box::new(predicate));
        self
    }

    /// Limit results.
    pub fn limit(mut self, max: usize) -> Self {
        self.filters.max_results = Some(max);
        self
    }

    /// Sort results.
    pub fn sort_by(mut self, field: SortField, dir: SortDir) -> Self {
        self.filters.sort_field = field;
        self.filters.sort_dir = dir;
        self
    }

    /// Select specific columns (reduces memory for large result sets).
    /// Column names correspond to `Note` field names.
    pub fn select(mut self, columns: Vec<String>) -> Self {
        self.filters.columns = Some(columns);
        self
    }

    /// Execute the query and return matching notes.
    pub fn exec(&self) -> Result<Vec<Note>> {
        let dir = self.vault_path.join("Notebooks").join(&self.folder);
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut results = Vec::new();
        self.scan_dir(&dir, &mut results)?;

        // Sort
        let field = self.filters.sort_field;
        let dir = self.filters.sort_dir;
        results.sort_by(|a, b| {
            let cmp = match field {
                SortField::Title => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
                SortField::UpdatedAt => {
                    let av = a.updated_at.as_deref().unwrap_or("");
                    let bv = b.updated_at.as_deref().unwrap_or("");
                    av.cmp(bv)
                }
                SortField::CreatedAt => {
                    let av = a.created_at.as_deref().unwrap_or("");
                    let bv = b.created_at.as_deref().unwrap_or("");
                    av.cmp(bv)
                }
            };
            match dir {
                SortDir::Asc => cmp,
                SortDir::Desc => cmp.reverse(),
            }
        });

        // Limit
        if let Some(max) = self.filters.max_results {
            results.truncate(max);
        }

        Ok(results)
    }

    /// Count matching notes without loading full content into the result set.
    pub fn count(&self) -> Result<usize> {
        let dir = self.vault_path.join("Notebooks").join(&self.folder);
        if !dir.exists() {
            return Ok(0);
        }

        let mut count = 0;
        self.count_dir(&dir, &mut count)?;
        Ok(count)
    }

    // ─── Private helpers ───────────────────────────────────────────

    fn scan_dir(&self, dir: &Path, results: &mut Vec<Note>) -> Result<()> {
        let entries = std::fs::read_dir(dir)?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                self.scan_dir(&path, results)?;
            } else if Self::is_eligible_md(&path) {
                if let Ok(note) = self.try_load_and_filter(&path) {
                    if let Some(note) = note {
                        results.push(note);
                    }
                }
            }
        }
        Ok(())
    }

    fn count_dir(&self, dir: &Path, count: &mut usize) -> Result<()> {
        let entries = std::fs::read_dir(dir)?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                self.count_dir(&path, count)?;
            } else if Self::is_eligible_md(&path) {
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    if let Ok((fm, content)) = frontmatter::parse(&raw) {
                        if self.matches_filters(&fm, &content, &path) {
                            *count += 1;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn is_eligible_md(path: &Path) -> bool {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default();
        name.ends_with(".md") && name != "_meta.md"
    }

    fn try_load_and_filter(&self, path: &Path) -> Result<Option<Note>> {
        let raw = std::fs::read_to_string(path)?;
        let (fm, content) = frontmatter::parse(&raw)?;

        if !self.matches_filters(&fm, &content, path) {
            return Ok(None);
        }

        let note = self.parse_note(path, &fm, &content)?;
        Ok(Some(note))
    }

    fn matches_filters(
        &self,
        fm: &std::collections::HashMap<String, serde_yaml::Value>,
        content: &str,
        full_path: &Path,
    ) -> bool {
        let f = &self.filters;

        // noteType: exact match
        if let Some(ref nt) = f.note_type {
            let fm_type = fm.get("noteType").and_then(|v| v.as_str()).unwrap_or("");
            let expected = match nt {
                NoteType::Note => "note",
                NoteType::Digest => "digest",
                NoteType::SystemFile => "system-file",
                NoteType::Report => "report",
            };
            if fm_type != expected {
                return false;
            }
        }

        // pinned: exact match
        if let Some(pinned_val) = f.pinned {
            let fm_pinned = fm.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
            if fm_pinned != pinned_val {
                return false;
            }
        }

        // embeddingStatus: exact match
        if let Some(ref es) = f.embedding_status {
            let fm_es = fm
                .get("embeddingStatus")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let expected = match es {
                EmbeddingStatus::Pending => "pending",
                EmbeddingStatus::Processing => "processing",
                EmbeddingStatus::Embedded => "embedded",
                EmbeddingStatus::Failed => "failed",
            };
            if fm_es != expected {
                return false;
            }
        }

        // source: exact match
        if let Some(ref source) = f.source {
            let fm_source = fm.get("source").and_then(|v| v.as_str()).unwrap_or("");
            if fm_source != source {
                return false;
            }
        }

        // Tag filtering
        if let Some(ref tags) = f.tags {
            if !tags.is_empty() {
                let note_tags: Vec<String> = fm
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

                match f.tag_match_mode {
                    TagMatchMode::All => {
                        if !tags.iter().all(|t| note_tags.contains(t)) {
                            return false;
                        }
                    }
                    TagMatchMode::Any => {
                        if !tags.iter().any(|t| note_tags.contains(t)) {
                            return false;
                        }
                    }
                }
            }
        }

        // Date range filtering (ISO string comparison)
        if let Some(ref after) = f.modified_after {
            let updated = fm.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("");
            if updated.is_empty() || updated < after.as_str() {
                return false;
            }
        }
        if let Some(ref before) = f.modified_before {
            let updated = fm.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("");
            if updated.is_empty() || updated > before.as_str() {
                return false;
            }
        }
        if let Some(ref after) = f.created_after {
            let created = fm.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");
            if created.is_empty() || created < after.as_str() {
                return false;
            }
        }
        if let Some(ref before) = f.created_before {
            let created = fm.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");
            if created.is_empty() || created > before.as_str() {
                return false;
            }
        }

        // Title substring (case-insensitive)
        if let Some(ref needle) = f.title_contains {
            let title = full_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !title.contains(&needle.to_lowercase()) {
                return false;
            }
        }

        // Content substring (case-insensitive)
        if let Some(ref needle) = f.content_contains {
            if !content.to_lowercase().contains(&needle.to_lowercase()) {
                return false;
            }
        }

        // Custom predicate
        if let Some(ref pred) = f.custom {
            if !pred(fm, content) {
                return false;
            }
        }

        true
    }

    fn parse_note(
        &self,
        path: &Path,
        fm: &std::collections::HashMap<String, serde_yaml::Value>,
        content: &str,
    ) -> Result<Note> {
        let get_str = |key: &str| -> Option<String> {
            fm.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
        };

        let title = get_str("title").unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        });

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

        let pinned = fm.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);

        let note_type = get_str("noteType").and_then(|s| match s.as_str() {
            "note" => Some(NoteType::Note),
            "digest" => Some(NoteType::Digest),
            "system-file" => Some(NoteType::SystemFile),
            "report" => Some(NoteType::Report),
            _ => None,
        });

        let embedding_status = get_str("embeddingStatus").and_then(|s| match s.as_str() {
            "pending" => Some(EmbeddingStatus::Pending),
            "processing" => Some(EmbeddingStatus::Processing),
            "embedded" => Some(EmbeddingStatus::Embedded),
            "failed" => Some(EmbeddingStatus::Failed),
            _ => None,
        });

        let metadata = std::fs::metadata(path)?;
        let modified_at = metadata
            .modified()
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t))
            .unwrap_or_else(|_| chrono::Utc::now());

        // Determine relative path from vault root
        let rel_path = path
            .strip_prefix(&self.vault_path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string());

        Ok(Note {
            title,
            content: content.to_string(),
            path: rel_path,
            frontmatter: fm.clone(),
            note_type,
            tags,
            pinned,
            source: get_str("source"),
            embedding_status,
            created_at: get_str("createdAt"),
            updated_at: get_str("updatedAt"),
            modified_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn setup_vault(tmp: &tempfile::TempDir) {
        let notebooks = tmp.path().join("Notebooks").join("TestFolder");
        std::fs::create_dir_all(&notebooks).unwrap();

        // Note 1: tagged, pinned
        let mut fm1 = HashMap::new();
        fm1.insert(
            "title".to_string(),
            serde_yaml::Value::String("Alpha Note".to_string()),
        );
        fm1.insert(
            "tags".to_string(),
            serde_yaml::Value::Sequence(vec![
                serde_yaml::Value::String("rust".to_string()),
                serde_yaml::Value::String("hq".to_string()),
            ]),
        );
        fm1.insert("pinned".to_string(), serde_yaml::Value::Bool(true));
        fm1.insert(
            "updatedAt".to_string(),
            serde_yaml::Value::String("2026-03-15T00:00:00Z".to_string()),
        );
        fm1.insert(
            "createdAt".to_string(),
            serde_yaml::Value::String("2026-03-01T00:00:00Z".to_string()),
        );
        let content1 = crate::frontmatter::serialize(&fm1, "# Alpha\n\nSome alpha content.").unwrap();
        std::fs::write(notebooks.join("alpha.md"), content1).unwrap();

        // Note 2: different tags, not pinned
        let mut fm2 = HashMap::new();
        fm2.insert(
            "title".to_string(),
            serde_yaml::Value::String("Beta Note".to_string()),
        );
        fm2.insert(
            "tags".to_string(),
            serde_yaml::Value::Sequence(vec![serde_yaml::Value::String("python".to_string())]),
        );
        fm2.insert(
            "updatedAt".to_string(),
            serde_yaml::Value::String("2026-03-20T00:00:00Z".to_string()),
        );
        fm2.insert(
            "createdAt".to_string(),
            serde_yaml::Value::String("2026-03-10T00:00:00Z".to_string()),
        );
        let content2 = crate::frontmatter::serialize(&fm2, "# Beta\n\nBeta content here.").unwrap();
        std::fs::write(notebooks.join("beta.md"), content2).unwrap();

        // _meta.md should be ignored
        std::fs::write(notebooks.join("_meta.md"), "ignored").unwrap();
    }

    #[test]
    fn exec_returns_all_without_filters() {
        let tmp = tempfile::TempDir::new().unwrap();
        setup_vault(&tmp);

        let results = NoteQuery::new(tmp.path(), "TestFolder").exec().unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn filter_by_tag_any() {
        let tmp = tempfile::TempDir::new().unwrap();
        setup_vault(&tmp);

        let results = NoteQuery::new(tmp.path(), "TestFolder")
            .with_tags(vec!["rust".to_string()], TagMatchMode::Any)
            .exec()
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Alpha Note");
    }

    #[test]
    fn filter_pinned() {
        let tmp = tempfile::TempDir::new().unwrap();
        setup_vault(&tmp);

        let results = NoteQuery::new(tmp.path(), "TestFolder")
            .pinned(true)
            .exec()
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Alpha Note");
    }

    #[test]
    fn count_matches() {
        let tmp = tempfile::TempDir::new().unwrap();
        setup_vault(&tmp);

        let count = NoteQuery::new(tmp.path(), "TestFolder")
            .pinned(true)
            .count()
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn content_contains_filter() {
        let tmp = tempfile::TempDir::new().unwrap();
        setup_vault(&tmp);

        let results = NoteQuery::new(tmp.path(), "TestFolder")
            .content_contains("beta content")
            .exec()
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Beta Note");
    }

    #[test]
    fn limit_works() {
        let tmp = tempfile::TempDir::new().unwrap();
        setup_vault(&tmp);

        let results = NoteQuery::new(tmp.path(), "TestFolder")
            .limit(1)
            .exec()
            .unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn date_range_filter() {
        let tmp = tempfile::TempDir::new().unwrap();
        setup_vault(&tmp);

        let results = NoteQuery::new(tmp.path(), "TestFolder")
            .modified_after("2026-03-18")
            .exec()
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Beta Note");
    }

    #[test]
    fn nonexistent_folder_returns_empty() {
        let tmp = tempfile::TempDir::new().unwrap();
        let results = NoteQuery::new(tmp.path(), "NoSuchFolder").exec().unwrap();
        assert!(results.is_empty());
    }
}

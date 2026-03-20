//! AtomicQueue — directory-as-queue with atomic rename transitions.
//!
//! Generalizes the Agent-HQ pattern of pending/ -> active/ -> done/ (or failed/)
//! directories into a reusable utility. Concurrency safety: `fs::rename` is atomic
//! on the same filesystem. If two processes race to claim the same item, exactly one
//! succeeds; the other gets NotFound and moves on.

use anyhow::{bail, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// An item in the queue.
#[derive(Debug, Clone)]
pub struct QueueItem {
    /// Filename (e.g., "task-123.md")
    pub name: String,
    /// Full path to the file in its current stage
    pub path: PathBuf,
    /// Current stage directory name
    pub stage: String,
}

/// A filesystem-backed queue with named stages and atomic transitions.
#[derive(Debug, Clone)]
pub struct AtomicQueue {
    root: PathBuf,
    stages: Vec<String>,
    extension: String,
}

impl AtomicQueue {
    /// Create a new `AtomicQueue`, ensuring all stage directories exist.
    pub fn new(root: impl Into<PathBuf>, stages: Vec<String>, extension: Option<String>) -> Result<Self> {
        let root = root.into();
        let extension = extension.unwrap_or_else(|| ".md".to_string());

        for stage in &stages {
            let dir = root.join(stage);
            if !dir.exists() {
                std::fs::create_dir_all(&dir)?;
            }
        }

        Ok(Self { root, stages, extension })
    }

    /// Add a new item to a stage by writing content.
    pub fn enqueue(&self, name: &str, stage: &str, content: &str) -> Result<QueueItem> {
        self.assert_stage(stage)?;
        let file_path = self.root.join(stage).join(name);
        std::fs::write(&file_path, content)?;
        Ok(QueueItem {
            name: name.to_string(),
            path: file_path,
            stage: stage.to_string(),
        })
    }

    /// Atomically move one item from `from_stage` to `to_stage`.
    /// Returns the item if successful, `None` if nothing was available.
    ///
    /// This is the core "claim" operation — safe for concurrent callers.
    pub fn dequeue(&self, from_stage: &str, to_stage: &str) -> Result<Option<QueueItem>> {
        self.assert_stage(from_stage)?;
        self.assert_stage(to_stage)?;

        let from_dir = self.root.join(from_stage);
        if !from_dir.exists() {
            return Ok(None);
        }

        let entries = self.list_filenames(&from_dir)?;

        for name in entries {
            let from_path = from_dir.join(&name);
            let to_path = self.root.join(to_stage).join(&name);

            match std::fs::rename(&from_path, &to_path) {
                Ok(()) => {
                    return Ok(Some(QueueItem {
                        name,
                        path: to_path,
                        stage: to_stage.to_string(),
                    }));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            }
        }

        Ok(None)
    }

    /// Atomically move a specific item between stages.
    /// Returns `true` if successful, `false` if the item wasn't in `from_stage`.
    pub fn transition(&self, name: &str, from_stage: &str, to_stage: &str) -> Result<bool> {
        self.assert_stage(from_stage)?;
        self.assert_stage(to_stage)?;

        let from_path = self.root.join(from_stage).join(name);
        let to_dir = self.root.join(to_stage);
        std::fs::create_dir_all(&to_dir)?;
        let to_path = to_dir.join(name);

        match std::fs::rename(&from_path, &to_path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// List all items in a given stage.
    pub fn list(&self, stage: &str) -> Result<Vec<QueueItem>> {
        self.assert_stage(stage)?;
        let dir = self.root.join(stage);
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let names = self.list_filenames(&dir)?;
        Ok(names
            .into_iter()
            .map(|name| {
                let path = dir.join(&name);
                QueueItem {
                    name,
                    path,
                    stage: stage.to_string(),
                }
            })
            .collect())
    }

    /// Count items in a stage without reading file contents.
    pub fn count(&self, stage: &str) -> Result<usize> {
        self.assert_stage(stage)?;
        let dir = self.root.join(stage);
        if !dir.exists() {
            return Ok(0);
        }
        Ok(self.list_filenames(&dir)?.len())
    }

    /// Get counts for all stages.
    pub fn stats(&self) -> Result<HashMap<String, usize>> {
        let mut result = HashMap::new();
        for stage in &self.stages {
            result.insert(stage.clone(), self.count(stage)?);
        }
        Ok(result)
    }

    /// Find which stage an item is currently in, or `None` if not found.
    pub fn find(&self, name: &str) -> Option<QueueItem> {
        for stage in &self.stages {
            let file_path = self.root.join(stage).join(name);
            if file_path.exists() {
                return Some(QueueItem {
                    name: name.to_string(),
                    path: file_path,
                    stage: stage.clone(),
                });
            }
        }
        None
    }

    /// Reap stale items: move items in `from_stage` back to `to_stage` if their
    /// mtime is older than `max_age_secs`. Useful for recovering leaked claims
    /// (e.g., running -> pending when a worker crashes).
    pub fn reap(&self, from_stage: &str, to_stage: &str, max_age_secs: u64) -> Result<usize> {
        self.assert_stage(from_stage)?;
        self.assert_stage(to_stage)?;

        let dir = self.root.join(from_stage);
        if !dir.exists() {
            return Ok(0);
        }

        let now = std::time::SystemTime::now();
        let max_age = std::time::Duration::from_secs(max_age_secs);
        let mut count = 0;

        for name in self.list_filenames(&dir)? {
            let file_path = dir.join(&name);
            match std::fs::metadata(&file_path) {
                Ok(meta) => {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(age) = now.duration_since(modified) {
                            if age > max_age {
                                let dest_path = self.root.join(to_stage).join(&name);
                                match std::fs::rename(&file_path, &dest_path) {
                                    Ok(()) => count += 1,
                                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                                    Err(e) => return Err(e.into()),
                                }
                            }
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            }
        }

        Ok(count)
    }

    /// Purge old items from a terminal stage (done/failed/completed).
    /// Deletes files older than `max_age_secs`.
    pub fn purge(&self, stage: &str, max_age_secs: u64) -> Result<usize> {
        self.assert_stage(stage)?;

        let dir = self.root.join(stage);
        if !dir.exists() {
            return Ok(0);
        }

        let now = std::time::SystemTime::now();
        let max_age = std::time::Duration::from_secs(max_age_secs);
        let mut count = 0;

        for name in self.list_filenames(&dir)? {
            let file_path = dir.join(&name);
            match std::fs::metadata(&file_path) {
                Ok(meta) => {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(age) = now.duration_since(modified) {
                            if age > max_age {
                                match std::fs::remove_file(&file_path) {
                                    Ok(()) => count += 1,
                                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                                    Err(e) => return Err(e.into()),
                                }
                            }
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            }
        }

        Ok(count)
    }

    /// List filenames in a directory that match the configured extension.
    fn list_filenames(&self, dir: &Path) -> Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(&self.extension) {
                names.push(name);
            }
        }
        names.sort();
        Ok(names)
    }

    /// Validate that a stage name is in the configured list.
    fn assert_stage(&self, stage: &str) -> Result<()> {
        if !self.stages.contains(&stage.to_string()) {
            bail!(
                "Unknown stage \"{}\". Valid stages: {}",
                stage,
                self.stages.join(", ")
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_queue(tmp: &TempDir) -> AtomicQueue {
        AtomicQueue::new(
            tmp.path(),
            vec![
                "pending".to_string(),
                "running".to_string(),
                "completed".to_string(),
                "failed".to_string(),
            ],
            None,
        )
        .unwrap()
    }

    #[test]
    fn enqueue_and_list() {
        let tmp = TempDir::new().unwrap();
        let q = make_queue(&tmp);
        q.enqueue("task-1.md", "pending", "# Hello").unwrap();
        let items = q.list("pending").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "task-1.md");
    }

    #[test]
    fn transition_and_find() {
        let tmp = TempDir::new().unwrap();
        let q = make_queue(&tmp);
        q.enqueue("task-1.md", "pending", "# Hello").unwrap();
        assert!(q.transition("task-1.md", "pending", "running").unwrap());
        assert!(!q.transition("task-1.md", "pending", "running").unwrap()); // already moved

        let found = q.find("task-1.md").unwrap();
        assert_eq!(found.stage, "running");
    }

    #[test]
    fn dequeue_claims_one() {
        let tmp = TempDir::new().unwrap();
        let q = make_queue(&tmp);
        q.enqueue("a.md", "pending", "A").unwrap();
        q.enqueue("b.md", "pending", "B").unwrap();

        let item = q.dequeue("pending", "running").unwrap().unwrap();
        assert_eq!(item.stage, "running");
        assert_eq!(q.count("pending").unwrap(), 1);
        assert_eq!(q.count("running").unwrap(), 1);
    }

    #[test]
    fn stats_returns_all_stages() {
        let tmp = TempDir::new().unwrap();
        let q = make_queue(&tmp);
        q.enqueue("a.md", "pending", "A").unwrap();
        q.enqueue("b.md", "completed", "B").unwrap();

        let s = q.stats().unwrap();
        assert_eq!(s["pending"], 1);
        assert_eq!(s["running"], 0);
        assert_eq!(s["completed"], 1);
        assert_eq!(s["failed"], 0);
    }

    #[test]
    fn invalid_stage_errors() {
        let tmp = TempDir::new().unwrap();
        let q = make_queue(&tmp);
        assert!(q.enqueue("x.md", "bogus", "X").is_err());
    }
}

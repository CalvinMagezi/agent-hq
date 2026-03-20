//! File watcher — monitors vault directory for `.md` file changes with debouncing and stability checks.

use anyhow::Result;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::hash;
use crate::scanner;

/// The type of file change detected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeType {
    Created,
    Modified,
    Deleted,
}

/// A file change event emitted after debouncing and stability checks.
#[derive(Debug, Clone)]
pub struct FileChange {
    /// Absolute path to the changed file.
    pub path: PathBuf,
    /// Type of change.
    pub change_type: ChangeType,
    /// SHA-256 hash of file contents (empty for deletions).
    pub content_hash: String,
    /// File size in bytes (0 for deletions).
    pub size: u64,
    /// Last modification time as Unix timestamp (0 for deletions).
    pub mtime: u64,
    /// When the change was detected (Unix timestamp ms).
    pub detected_at: u64,
}

/// Debounce interval per path.
const DEBOUNCE_MS: u64 = 300;
/// Stability wait — re-stat after this delay to confirm mtime is stable.
const STABILITY_MS: u64 = 1000;

/// Watches a vault directory for `.md` file changes.
pub struct FileWatcher {
    _watcher: RecommendedWatcher,
    shutdown_tx: Option<mpsc::Sender<()>>,
}

impl FileWatcher {
    /// Start watching the vault directory recursively.
    /// Calls `on_change` for each debounced, stability-checked file change.
    pub async fn start<F>(vault_path: &Path, on_change: F) -> Result<Self>
    where
        F: Fn(FileChange) + Send + Sync + 'static,
    {
        let vault_path = vault_path.to_path_buf();
        let on_change = Arc::new(on_change);
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

        // Pending events: path -> (last_event_time, event_kind)
        let pending: Arc<Mutex<HashMap<PathBuf, (u64, EventKind)>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let (event_tx, mut event_rx) = mpsc::channel::<Event>(256);

        // Create the notify watcher
        let tx_clone = event_tx.clone();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx_clone.blocking_send(event);
            }
        })?;

        watcher.watch(&vault_path, RecursiveMode::Recursive)?;
        info!(path = %vault_path.display(), "file watcher started");

        // Spawn the event processing loop
        let pending_clone = pending.clone();
        let vault_path_clone = vault_path.clone();
        let on_change_clone = on_change.clone();

        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(100));

            loop {
                tokio::select! {
                    _ = shutdown_rx.recv() => {
                        info!("file watcher shutting down");
                        break;
                    }
                    Some(event) = event_rx.recv() => {
                        Self::handle_event(&pending_clone, &vault_path_clone, event);
                    }
                    _ = tick.tick() => {
                        Self::flush_pending(
                            &pending_clone,
                            &on_change_clone,
                        ).await;
                    }
                }
            }
        });

        Ok(Self {
            _watcher: watcher,
            shutdown_tx: Some(shutdown_tx),
        })
    }

    /// Stop watching.
    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.try_send(());
        }
    }

    fn handle_event(
        pending: &Arc<Mutex<HashMap<PathBuf, (u64, EventKind)>>>,
        vault_path: &Path,
        event: Event,
    ) {
        for path in &event.paths {
            // Only watch .md files
            if path.extension().is_none_or(|ext| ext != "md") {
                continue;
            }

            // Check ignore rules using the relative path
            if let Ok(rel) = path.strip_prefix(vault_path) {
                if scanner::should_ignore(rel) {
                    continue;
                }
            }

            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            if let Ok(mut map) = pending.lock() {
                map.insert(path.clone(), (now_ms, event.kind));
                debug!(path = %path.display(), kind = ?event.kind, "queued change event");
            }
        }
    }

    async fn flush_pending<F>(
        pending: &Arc<Mutex<HashMap<PathBuf, (u64, EventKind)>>>,
        on_change: &Arc<F>,
    ) where
        F: Fn(FileChange) + Send + Sync + 'static,
    {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        // Collect paths that have passed the debounce window
        let ready: Vec<(PathBuf, EventKind)> = {
            let map = match pending.lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            map.iter()
                .filter(|(_, (event_time, _))| now_ms.saturating_sub(*event_time) >= DEBOUNCE_MS)
                .map(|(path, (_, kind))| (path.clone(), *kind))
                .collect()
        };

        if ready.is_empty() {
            return;
        }

        for (path, kind) in ready {
            // Remove from pending
            if let Ok(mut map) = pending.lock() {
                map.remove(&path);
            }

            // Determine change type
            let is_delete = matches!(kind, EventKind::Remove(_));

            if is_delete {
                on_change(FileChange {
                    path: path.clone(),
                    change_type: ChangeType::Deleted,
                    content_hash: String::new(),
                    size: 0,
                    mtime: 0,
                    detected_at: now_ms,
                });
                continue;
            }

            // Stability check: wait STABILITY_MS then re-stat
            let mtime_before = get_mtime(&path);
            tokio::time::sleep(Duration::from_millis(STABILITY_MS)).await;
            let mtime_after = get_mtime(&path);

            // If file disappeared during stability wait, treat as delete
            if mtime_after.is_none() {
                continue;
            }

            // If mtime changed during stability window, skip (will be re-queued)
            if mtime_before != mtime_after {
                debug!(path = %path.display(), "mtime unstable, skipping");
                continue;
            }

            let mtime = mtime_after.unwrap_or(0);
            let metadata = std::fs::metadata(&path).ok();
            let size = metadata.map(|m| m.len()).unwrap_or(0);

            let content_hash = match hash::hash_file(&path) {
                Ok(h) => h,
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "failed to hash file");
                    continue;
                }
            };

            let change_type = if matches!(kind, EventKind::Create(_)) {
                ChangeType::Created
            } else {
                ChangeType::Modified
            };

            on_change(FileChange {
                path: path.clone(),
                change_type,
                content_hash,
                size,
                mtime,
                detected_at: now_ms,
            });
        }
    }
}

/// Get mtime of a file as Unix timestamp seconds, or None if file doesn't exist.
fn get_mtime(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

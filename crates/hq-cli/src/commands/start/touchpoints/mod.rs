//! Touch Points Engine — reactive file-change handlers with synaptic chain propagation.
//!
//! Touch points fire in response to vault file changes (create, modify, delete).
//! Each touch point can produce secondary changes that trigger downstream handlers,
//! forming "synaptic chains" with a configurable depth limit (default 3).
//!
//! Configuration is read from `.vault/_system/TOUCHPOINT-CONFIG.md`.

pub mod conversation_learner;
pub mod folder_organizer;
pub mod frontmatter_fixer;
pub mod size_watchdog;
pub mod stale_thread_detector;
pub mod tag_suggester;

use anyhow::Result;
use hq_sync::{FileChange, ChangeType};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{info, warn};

// ─── Touch Point trait ───────────────────────────────────────

/// A reactive handler that responds to vault file changes.
#[async_trait::async_trait]
pub trait TouchPoint: Send + Sync {
    /// Human-readable name (must match TOUCHPOINT-CONFIG.md keys).
    fn name(&self) -> &str;

    /// Whether this touch point should fire for the given change.
    fn matches(&self, change: &FileChange) -> bool;

    /// Execute the handler. Returns paths of files modified by this handler
    /// (to trigger downstream chain propagation).
    async fn execute(&self, change: &FileChange, ctx: &TouchPointContext) -> Result<Vec<PathBuf>>;

    /// Optional chain target — after this touch point fires, trigger this one next.
    fn chains_to(&self) -> Option<&str> {
        None
    }
}

/// Shared context for touch point execution.
pub struct TouchPointContext {
    pub vault_path: PathBuf,
}

// ─── Engine ──────────────────────────────────────────────────

/// Maximum chain propagation depth to prevent infinite loops.
const MAX_CHAIN_DEPTH: u32 = 3;

pub struct TouchPointEngine {
    points: Vec<Box<dyn TouchPoint>>,
    ctx: Arc<TouchPointContext>,
    enabled: HashSet<String>,
    log_path: PathBuf,
}

impl TouchPointEngine {
    /// Create the engine with all registered touch points.
    pub fn new(vault_path: PathBuf) -> Self {
        let ctx = Arc::new(TouchPointContext {
            vault_path: vault_path.clone(),
        });

        let points: Vec<Box<dyn TouchPoint>> = vec![
            Box::new(frontmatter_fixer::FrontmatterFixer),
            Box::new(size_watchdog::SizeWatchdog),
            Box::new(tag_suggester::TagSuggester),
            Box::new(folder_organizer::FolderOrganizer),
            Box::new(conversation_learner::ConversationLearner),
            Box::new(stale_thread_detector::StaleThreadDetector),
        ];

        let enabled = load_config(&vault_path);
        let log_path = vault_path.join("_system").join("TOUCHPOINT-LOG.md");

        Self {
            points,
            ctx,
            enabled,
            log_path,
        }
    }

    /// Reload configuration from TOUCHPOINT-CONFIG.md.
    pub fn reload_config(&mut self) {
        self.enabled = load_config(&self.ctx.vault_path);
    }

    /// Process a file change through all matching, enabled touch points.
    /// Handles chain propagation up to MAX_CHAIN_DEPTH.
    pub async fn process(&self, change: &FileChange) {
        self.process_with_depth(change, 0, &mut HashSet::new()).await;
    }

    async fn process_with_depth(
        &self,
        change: &FileChange,
        depth: u32,
        visited: &mut HashSet<String>,
    ) {
        if depth >= MAX_CHAIN_DEPTH {
            tracing::debug!("touchpoints: max chain depth reached, stopping");
            return;
        }

        for point in &self.points {
            let name = point.name().to_string();

            // Check if enabled
            if !self.enabled.contains(&name) {
                continue;
            }

            // Check if matches
            if !point.matches(change) {
                continue;
            }

            // Prevent re-entry within the same chain
            let visit_key = format!("{}:{}", name, change.path.display());
            if visited.contains(&visit_key) {
                continue;
            }
            visited.insert(visit_key);

            // Execute
            match point.execute(change, &self.ctx).await {
                Ok(modified_paths) => {
                    // Log the execution
                    let chain_str = point
                        .chains_to()
                        .map(|c| format!(" | chain\u{2192}{c}"))
                        .unwrap_or_else(|| " | terminal".to_string());
                    let rel_path = change
                        .path
                        .strip_prefix(&self.ctx.vault_path)
                        .unwrap_or(&change.path);
                    self.append_log(&name, &rel_path.display().to_string(), &chain_str);

                    // Chain propagation: if this touch point modified files, process them
                    if let Some(chain_target) = point.chains_to() {
                        for modified_path in modified_paths {
                            let chained_change = FileChange {
                                path: modified_path.clone(),
                                change_type: ChangeType::Modified,
                                content_hash: String::new(),
                                size: std::fs::metadata(&modified_path)
                                    .map(|m| m.len())
                                    .unwrap_or(0),
                                mtime: 0,
                                detected_at: change.detected_at,
                            };
                            // Only run the chain target, not all points
                            for p in &self.points {
                                if p.name() == chain_target
                                    && self.enabled.contains(chain_target)
                                    && p.matches(&chained_change)
                                {
                                    let chain_visit_key =
                                        format!("{}:{}", chain_target, modified_path.display());
                                    if !visited.contains(&chain_visit_key) {
                                        visited.insert(chain_visit_key);
                                        if let Err(e) =
                                            p.execute(&chained_change, &self.ctx).await
                                        {
                                            warn!(
                                                touch_point = chain_target,
                                                error = %e,
                                                "touchpoints: chain target failed"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!(
                        touch_point = %name,
                        error = %e,
                        path = %change.path.display(),
                        "touchpoints: handler failed"
                    );
                }
            }
        }
    }

    fn append_log(&self, name: &str, path: &str, detail: &str) {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let line = format!("[{now}] {name} | {path}{detail}\n");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
        {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    }
}

// ─── Config loader ───────────────────────────────────────────

fn load_config(vault_path: &Path) -> HashSet<String> {
    let config_path = vault_path
        .join("_system")
        .join("TOUCHPOINT-CONFIG.md");
    let mut enabled = HashSet::new();

    if let Ok(content) = std::fs::read_to_string(&config_path) {
        // Check global enable
        if content.contains("enabled: false") {
            return enabled;
        }

        // Parse "- name: true/false" lines
        for line in content.lines() {
            let line = line.trim().trim_start_matches("- ");
            if let Some((name, value)) = line.split_once(':') {
                let name = name.trim();
                let value = value.trim();
                if value == "true" {
                    enabled.insert(name.to_string());
                }
            }
        }
    } else {
        // No config = all enabled by default
        for name in &[
            "frontmatter-fixer",
            "size-watchdog",
            "tag-suggester",
            "folder-organizer",
            "conversation-learner",
            "stale-thread-detector",
        ] {
            enabled.insert(name.to_string());
        }
    }

    info!(count = enabled.len(), "touchpoints: loaded config");
    enabled
}

// ─── Daemon integration ──────────────────────────────────────

/// Start the file watcher and touch point engine as a background task.
/// Returns a handle that keeps the watcher alive.
pub async fn start_watcher(vault_path: PathBuf) -> Result<hq_sync::FileWatcher> {
    let engine = Arc::new(TouchPointEngine::new(vault_path.clone()));

    let watcher = hq_sync::FileWatcher::start(&vault_path, move |change| {
        let engine = engine.clone();
        // Spawn a tokio task to handle the change asynchronously
        // (the FileWatcher callback is sync, but our handlers are async)
        tokio::spawn(async move {
            engine.process(&change).await;
        });
    })
    .await?;

    info!("touchpoints: file watcher started on {}", vault_path.display());
    Ok(watcher)
}

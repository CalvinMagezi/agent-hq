//! Embedded web UI server with API endpoints and WebSocket.

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::{Html, IntoResponse},
    routing::get,
};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tracing::info;

/// Shared server state.
pub struct WsState {
    pub tx: broadcast::Sender<String>,
    pub vault_path: PathBuf,
    pub static_dir: Option<PathBuf>,
}

impl WsState {
    pub fn new(vault_path: PathBuf, static_dir: Option<PathBuf>) -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx, vault_path, static_dir }
    }

    pub fn broadcast(&self, msg: &str) {
        let _ = self.tx.send(msg.to_string());
    }
}

/// Create the full web router.
pub fn create_router(state: Arc<WsState>) -> Router {
    Router::new()
        .route("/", get(index_handler))
        .route("/manifest.json", get(manifest_handler))
        .route("/ws", get(ws_handler))
        .route("/health", get(health_handler))
        .route("/api/vault-status", get(vault_status_handler))
        .route("/api/daemon-status", get(daemon_status_handler))
        .route("/api/news", get(news_handler))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

// ─── Static ──────────────────────────────────────────────────

async fn index_handler(State(state): State<Arc<WsState>>) -> impl IntoResponse {
    if let Some(ref dir) = state.static_dir {
        let path = dir.join("index.html");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return Html(content);
        }
    }
    Html("<h1>HQ Control Center</h1><p>No web UI found. Place index.html in web/dist/</p>".to_string())
}

async fn manifest_handler(State(state): State<Arc<WsState>>) -> impl IntoResponse {
    if let Some(ref dir) = state.static_dir {
        let path = dir.join("manifest.json");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return (
                [("content-type", "application/json")],
                content,
            );
        }
    }
    ([("content-type", "application/json")], "{}".to_string())
}

// ─── Health ──────────────────────────────────────────────────

async fn health_handler() -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

// ─── API: Vault Status ──────────────────────────────────────

async fn vault_status_handler(State(state): State<Arc<WsState>>) -> impl IntoResponse {
    let vault = &state.vault_path;

    let count_files = |dir: &str| -> usize {
        let path = vault.join(dir);
        std::fs::read_dir(&path)
            .map(|entries| entries.filter_map(|e| e.ok()).filter(|e| {
                e.path().extension().is_some_and(|ext| ext == "md")
            }).count())
            .unwrap_or(0)
    };

    // Count all notes recursively
    fn count_notes(dir: &std::path::Path) -> usize {
        let mut count = 0;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name = path.file_name().unwrap_or_default().to_string_lossy();
                    if !name.starts_with('.') && !name.starts_with('_') {
                        count += count_notes(&path);
                    }
                } else if path.extension().is_some_and(|ext| ext == "md") {
                    count += 1;
                }
            }
        }
        count
    }

    let total_notes = count_notes(&vault.join("Notebooks"));

    axum::Json(serde_json::json!({
        "total_notes": total_notes,
        "jobs_pending": count_files("_jobs/pending"),
        "jobs_running": count_files("_jobs/running"),
        "jobs_done": count_files("_jobs/done"),
        "jobs_failed": count_files("_jobs/failed"),
    }))
}

// ─── API: Daemon Status ─────────────────────────────────────

async fn daemon_status_handler(State(state): State<Arc<WsState>>) -> impl IntoResponse {
    let status_path = state.vault_path.join("DAEMON-STATUS.md");
    let content = std::fs::read_to_string(&status_path).unwrap_or_default();

    // Parse frontmatter
    let mut task_count = 0u64;
    let mut total_runs = 0u64;
    let mut total_errors = 0u64;
    let mut started_at = String::new();

    if content.starts_with("---") {
        if let Some(end) = content[3..].find("---") {
            let fm = &content[3..3 + end];
            for line in fm.lines() {
                if let Some(v) = line.strip_prefix("task_count: ") {
                    task_count = v.trim().parse().unwrap_or(0);
                }
                if let Some(v) = line.strip_prefix("total_runs: ") {
                    total_runs = v.trim().parse().unwrap_or(0);
                }
                if let Some(v) = line.strip_prefix("total_errors: ") {
                    total_errors = v.trim().parse().unwrap_or(0);
                }
                if let Some(v) = line.strip_prefix("started_at: ") {
                    started_at = v.trim().to_string();
                }
            }
        }
    }

    // Parse task table
    let mut tasks = Vec::new();
    let mut in_table = false;
    for line in content.lines() {
        if line.starts_with("| Task") {
            in_table = true;
            continue;
        }
        if line.starts_with("|---") {
            continue;
        }
        if in_table && line.starts_with("| `") {
            let cols: Vec<&str> = line.split('|').map(|s| s.trim()).collect();
            if cols.len() >= 5 {
                let name = cols[1].trim_matches('`').to_string();
                let interval = cols[2].to_string();
                let runs: u64 = cols[3].parse().unwrap_or(0);
                let errors: u64 = cols[4].parse().unwrap_or(0);
                tasks.push(serde_json::json!({
                    "name": name,
                    "interval": interval,
                    "runs": runs,
                    "errors": errors,
                }));
            }
        }
    }

    axum::Json(serde_json::json!({
        "task_count": task_count,
        "total_runs": total_runs,
        "total_errors": total_errors,
        "started_at": started_at,
        "tasks": tasks,
    }))
}

// ─── API: News ──────────────────────────────────────────────

async fn news_handler(State(state): State<Arc<WsState>>) -> impl IntoResponse {
    let news_path = state.vault_path.join("_system").join("NEWS-PULSE.md");
    let content = std::fs::read_to_string(&news_path).unwrap_or_default();

    let mut items = Vec::new();
    let mut current_source = String::new();

    for line in content.lines() {
        if line.starts_with("## ") {
            current_source = line[3..].trim().to_string();
        } else if line.starts_with("- [") {
            // Parse: - [Title](url)
            if let Some(close_bracket) = line.find("](") {
                let title = &line[3..close_bracket];
                let rest = &line[close_bracket + 2..];
                if let Some(close_paren) = rest.find(')') {
                    let url = &rest[..close_paren];
                    items.push(serde_json::json!({
                        "title": title,
                        "url": url,
                        "source": current_source,
                    }));
                }
            }
        }
    }

    axum::Json(serde_json::json!({ "items": items }))
}

// ─── WebSocket ──────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<WsState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(socket: WebSocket, state: Arc<WsState>) {
    let mut rx = state.tx.subscribe();
    let (mut sender, mut receiver) = socket.split();

    use futures::{SinkExt, StreamExt};

    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    info!(msg = %text, "ws client message");
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}

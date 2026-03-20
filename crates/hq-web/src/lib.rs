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
        .route("/api/wa-message", axum::routing::post(wa_message_handler))
        .route("/api/search", get(search_handler))
        .route("/api/vault-asset", get(vault_asset_handler))
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

// ─── API: Search ────────────────────────────────────────────

async fn search_handler(
    State(state): State<Arc<WsState>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let query = params.get("q").cloned().unwrap_or_default();
    let limit: usize = params.get("limit").and_then(|l| l.parse().ok()).unwrap_or(20);

    if query.is_empty() {
        return axum::Json(serde_json::json!({"results": [], "error": "no query"}));
    }

    // Try filesystem search (FTS not always initialized)
    let vault = &state.vault_path;
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    fn search_dir(
        dir: &std::path::Path, root: &std::path::Path,
        query: &str, results: &mut Vec<serde_json::Value>, limit: usize,
    ) {
        if results.len() >= limit { return; }
        let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
        for entry in entries.flatten() {
            if results.len() >= limit { break; }
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                if !name.starts_with('.') && !name.starts_with('_') {
                    search_dir(&path, root, query, results, limit);
                }
            } else if path.extension().is_some_and(|e| e == "md") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if content.to_lowercase().contains(query) {
                        let rel = path.strip_prefix(root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                        let title = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                        let snippet = content.lines()
                            .find(|l| l.to_lowercase().contains(query))
                            .unwrap_or("").trim().chars().take(150).collect::<String>();
                        results.push(serde_json::json!({
                            "note_path": rel, "title": title, "snippet": snippet, "relevance": 1.0
                        }));
                    }
                }
            }
        }
    }

    search_dir(&vault.join("Notebooks"), vault, &query_lower, &mut results, limit);
    axum::Json(serde_json::json!({"results": results}))
}

// ─── API: Vault Asset ───────────────────────────────────────

async fn vault_asset_handler(
    State(state): State<Arc<WsState>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let path_param = params.get("path").cloned().unwrap_or_default();
    if path_param.is_empty() || path_param.contains("..") {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            [("content-type", "text/plain")],
            "bad path".to_string(),
        );
    }

    let full_path = state.vault_path.join(&path_param);
    match std::fs::read(&full_path) {
        Ok(data) => {
            let mime = match full_path.extension().and_then(|e| e.to_str()) {
                Some("png") => "image/png",
                Some("jpg" | "jpeg") => "image/jpeg",
                Some("gif") => "image/gif",
                Some("svg") => "image/svg+xml",
                Some("pdf") => "application/pdf",
                Some("md") => "text/markdown",
                _ => "application/octet-stream",
            };
            (axum::http::StatusCode::OK, [("content-type", mime)], unsafe { String::from_utf8_unchecked(data) })
        }
        Err(_) => (axum::http::StatusCode::NOT_FOUND, [("content-type", "text/plain")], "not found".to_string()),
    }
}

// ─── API: WhatsApp Message (bridge endpoint) ────────────────

async fn wa_message_handler(
    State(state): State<Arc<WsState>>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> impl IntoResponse {
    let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
    if text.is_empty() {
        return axum::Json(serde_json::json!({"error": "no text provided"}));
    }

    // Spawn claude CLI and get response
    let result = spawn_harness_for_wa(text, &state.vault_path).await;

    match result {
        Ok(response) => axum::Json(serde_json::json!({"response": response})),
        Err(e) => axum::Json(serde_json::json!({"error": e.to_string()})),
    }
}

async fn spawn_harness_for_wa(prompt: &str, vault_path: &std::path::Path) -> anyhow::Result<String> {
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;

    let mut child = Command::new("claude")
        .args([
            "--dangerously-skip-permissions",
            "--output-format", "stream-json",
            "--verbose",
            "--max-turns", "100",
            "--model", "opus",
            "-p", prompt,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .current_dir(vault_path.parent().unwrap_or(vault_path))
        .kill_on_drop(true)
        .spawn()?;

    let stdout = child.stdout.take().unwrap();
    let mut reader = tokio::io::BufReader::new(stdout).lines();
    let mut accumulated = String::new();

    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() { continue; }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
            let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
            // Skip result if we already have text
            if msg_type == "result" && !accumulated.is_empty() { continue; }
            // Extract assistant text
            if msg_type == "assistant" {
                if let Some(msg) = json.get("message") {
                    if let Some(content) = msg.get("content").and_then(|v| v.as_array()) {
                        for block in content {
                            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                    accumulated.push_str(t);
                                }
                            }
                        }
                    }
                }
            }
            if msg_type == "result" {
                if let Some(t) = json.get("result").and_then(|v| v.as_str()) {
                    accumulated.push_str(t);
                }
            }
        }
    }

    let _ = child.wait().await;
    if accumulated.is_empty() {
        anyhow::bail!("No response from harness");
    }
    Ok(accumulated)
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

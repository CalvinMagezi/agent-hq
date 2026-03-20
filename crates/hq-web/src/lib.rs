//! Embedded web UI server.
//!
//! Serves the React PWA build output and provides a WebSocket endpoint
//! for real-time communication with the control center.

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
    routing::get,
};
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::info;

/// Events broadcast to all connected WebSocket clients.
#[derive(Debug, Clone)]
pub enum WsEvent {
    /// Job status changed
    JobStatus {
        job_id: String,
        status: String,
        streaming_text: Option<String>,
    },
    /// Agent heartbeat
    Heartbeat { worker_id: String, timestamp: String },
    /// System status update
    SystemStatus { message: String },
}

/// WebSocket server state shared across connections.
pub struct WsState {
    pub tx: broadcast::Sender<String>,
}

impl WsState {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    /// Broadcast a JSON message to all connected clients.
    pub fn broadcast(&self, msg: &str) {
        let _ = self.tx.send(msg.to_string());
    }
}

/// Create the web router with WebSocket and static file serving.
pub fn create_router(state: Arc<WsState>) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(health_handler))
        .with_state(state)
}

async fn health_handler() -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

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

//! Agent relay protocol — WebSocket message types for client-server communication.

use serde::{Deserialize, Serialize};

// ─── Connection ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthMessage {
    pub api_key: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthAckMessage {
    pub success: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub session_token: Option<String>,
    #[serde(default)]
    pub server_version: Option<String>,
}

// ─── Jobs ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSubmitMessage {
    pub instruction: String,
    #[serde(default)]
    pub job_type: Option<String>,
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub security_profile: Option<String>,
    #[serde(default)]
    pub model_override: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSubmittedMessage {
    pub job_id: String,
    #[serde(default)]
    pub request_id: Option<String>,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobStatusMessage {
    pub job_id: String,
    pub status: String,
    #[serde(default)]
    pub streaming_text: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobStreamMessage {
    pub job_id: String,
    pub delta: String,
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobCompleteMessage {
    pub job_id: String,
    pub status: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub stats: Option<serde_json::Value>,
    #[serde(default)]
    pub completed_at: Option<String>,
}

// ─── Chat ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSendMessage {
    pub content: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub model_override: Option<String>,
    #[serde(default)]
    pub images: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatDeltaMessage {
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    pub delta: String,
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatFinalMessage {
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    pub content: String,
    #[serde(default)]
    pub stats: Option<serde_json::Value>,
}

// ─── System ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemStatusResponse {
    pub status: String,
    pub agent_online: bool,
    pub pending_jobs: usize,
    pub running_jobs: usize,
    pub connected_clients: usize,
    pub vault_path: String,
    pub server_version: String,
    pub uptime: u64,
}

// ─── Traces ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceStatusResponse {
    pub traces: Vec<TraceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceInfo {
    pub trace_id: String,
    pub job_id: String,
    pub instruction: Option<String>,
    pub status: String,
    pub total_tasks: u32,
    pub completed_tasks: u32,
    pub failed_tasks: u32,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub spans: Vec<SpanInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpanInfo {
    pub span_id: String,
    pub task_id: Option<String>,
    pub r#type: String,
    pub name: String,
    pub status: String,
    pub claimed_by: Option<String>,
    pub duration_ms: Option<u64>,
}

// ─── Union Message ──────────────────────────────────────────────

/// All relay protocol message types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RelayMessage {
    // Connection
    Auth(AuthMessage),
    #[serde(rename = "auth-ack")]
    AuthAck(AuthAckMessage),
    Ping { timestamp: i64 },
    Pong { timestamp: i64 },

    // Jobs
    #[serde(rename = "job:submit")]
    JobSubmit(JobSubmitMessage),
    #[serde(rename = "job:submitted")]
    JobSubmitted(JobSubmittedMessage),
    #[serde(rename = "job:status")]
    JobStatus(JobStatusMessage),
    #[serde(rename = "job:stream")]
    JobStream(JobStreamMessage),
    #[serde(rename = "job:complete")]
    JobComplete(JobCompleteMessage),
    #[serde(rename = "job:cancel")]
    JobCancel { job_id: String },

    // Chat
    #[serde(rename = "chat:send")]
    ChatSend(ChatSendMessage),
    #[serde(rename = "chat:delta")]
    ChatDelta(ChatDeltaMessage),
    #[serde(rename = "chat:final")]
    ChatFinal(ChatFinalMessage),
    #[serde(rename = "chat:abort")]
    ChatAbort {
        request_id: Option<String>,
        reason: Option<String>,
    },

    // System
    #[serde(rename = "system:status")]
    SystemStatus,
    #[serde(rename = "system:status-response")]
    SystemStatusResponse(SystemStatusResponse),
    #[serde(rename = "system:event")]
    SystemEvent {
        event: String,
        data: Option<serde_json::Value>,
        timestamp: Option<i64>,
    },
    #[serde(rename = "system:subscribe")]
    SystemSubscribe { events: Vec<String> },

    // Commands
    #[serde(rename = "cmd:execute")]
    CmdExecute {
        command: String,
        args: Option<serde_json::Value>,
        request_id: Option<String>,
    },
    #[serde(rename = "cmd:result")]
    CmdResult {
        request_id: Option<String>,
        success: bool,
        output: Option<String>,
        error: Option<String>,
    },

    // Traces
    #[serde(rename = "trace:status")]
    TraceStatus {
        trace_id: Option<String>,
        job_id: Option<String>,
    },
    #[serde(rename = "trace:status-response")]
    TraceStatusResponse(TraceStatusResponse),
    #[serde(rename = "trace:progress")]
    TraceProgress {
        trace_id: String,
        job_id: String,
        completed_tasks: u32,
        total_tasks: u32,
        failed_tasks: u32,
        summary: Option<String>,
        timestamp: i64,
    },

    // Error
    Error {
        code: String,
        message: String,
        request_id: Option<String>,
    },
}

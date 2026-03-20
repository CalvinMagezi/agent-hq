use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

// ─── Enumerations ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum JobType {
    Background,
    Rpc,
    Interactive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Pending,
    Running,
    #[serde(rename = "waiting_for_user")]
    WaitingForUser,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SecurityProfile {
    Minimal,
    Standard,
    Guarded,
    Admin,
}

impl Default for SecurityProfile {
    fn default() -> Self {
        Self::Guarded
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoteType {
    Note,
    Digest,
    #[serde(rename = "system-file")]
    SystemFile,
    Report,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddingStatus {
    Pending,
    Processing,
    Embedded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessType {
    ClaudeCode,
    Opencode,
    GeminiCli,
    CodexCli,
    QwenCode,
    MistralVibe,
    KiloCode,
    Coo,
    Hq,
    Any,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentVertical {
    Engineering,
    Qa,
    Research,
    Content,
    Ops,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentRole {
    Coder,
    Researcher,
    Reviewer,
    Planner,
    Devops,
    Workspace,
}

// ─── Core Domain Types ──────────────────────────────────────────

/// A job in the vault queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    #[serde(alias = "jobId")]
    pub id: String,
    #[serde(default = "default_job_type")]
    pub r#type: JobType,
    pub status: JobStatus,
    #[serde(default = "default_priority")]
    pub priority: u8,
    #[serde(default, alias = "securityProfile")]
    pub security_profile: SecurityProfile,
    #[serde(default, alias = "modelOverride")]
    pub model: Option<String>,
    #[serde(default, alias = "thinkingLevel")]
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(default, alias = "workerId")]
    pub agent: Option<String>,
    #[serde(default, alias = "threadId")]
    pub thread_id: Option<String>,
    pub instruction: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default, alias = "streamingText")]
    pub streaming_text: Option<String>,
    #[serde(default, alias = "conversationHistory")]
    pub conversation_history: Vec<ConversationMessage>,
    #[serde(default, alias = "steeringMessage")]
    pub steering_message: Option<String>,
    #[serde(default)]
    pub stats: Option<JobStats>,
    #[serde(alias = "createdAt")]
    pub created_at: String,
    #[serde(default, alias = "updatedAt")]
    pub updated_at: Option<String>,
    #[serde(default, alias = "traceId")]
    pub trace_id: Option<String>,
    #[serde(default, alias = "spanId")]
    pub span_id: Option<String>,
    /// Absolute path on disk (runtime only, not serialized to frontmatter)
    #[serde(skip)]
    pub file_path: Option<PathBuf>,
}

fn default_job_type() -> JobType {
    JobType::Background
}

fn default_priority() -> u8 {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobStats {
    #[serde(default, rename = "promptTokens")]
    pub prompt_tokens: u64,
    #[serde(default, rename = "completionTokens")]
    pub completion_tokens: u64,
    #[serde(default, rename = "totalTokens")]
    pub total_tokens: u64,
    #[serde(default)]
    pub cost: f64,
    #[serde(default, rename = "toolCalls")]
    pub tool_calls: u32,
    #[serde(default, rename = "messageCount")]
    pub message_count: u32,
}

/// A note in the vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub title: String,
    pub content: String,
    pub path: String,
    #[serde(default)]
    pub frontmatter: HashMap<String, serde_yaml::Value>,
    #[serde(default, rename = "noteType")]
    pub note_type: Option<NoteType>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default, rename = "embeddingStatus")]
    pub embedding_status: Option<EmbeddingStatus>,
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<String>,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<String>,
    pub modified_at: DateTime<Utc>,
}

/// Match type for search results.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatchType {
    Keyword,
    Semantic,
    Hybrid,
}

/// A search result from vault search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub note_path: String,
    pub title: String,
    pub notebook: String,
    pub snippet: String,
    pub tags: Vec<String>,
    pub relevance: f64,
    pub match_type: MatchType,
}

/// A graph link between two notes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphLink {
    pub target: String,
    pub score: f64,
    pub link_type: String,
}

/// Link state tracking for change detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkState {
    pub last_linked_at: i64,
    pub content_hash: String,
}

/// Search index statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchStats {
    pub fts_count: usize,
    pub embedding_count: usize,
}

/// A task record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRecord {
    pub task_id: String,
    pub job_id: String,
    pub instruction: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub target_harness_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: String,
}

/// System context (SOUL, MEMORY, PREFERENCES, HEARTBEAT).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SystemContext {
    pub soul: String,
    pub memory: String,
    pub preferences: String,
    pub heartbeat: String,
    #[serde(default)]
    pub config: HashMap<String, String>,
    #[serde(default)]
    pub pinned_notes: Vec<Note>,
}

/// Agent definition (loaded from markdown frontmatter).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub name: String,
    #[serde(default, rename = "displayName")]
    pub display_name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub vertical: Option<AgentVertical>,
    #[serde(default, rename = "baseRole")]
    pub base_role: Option<AgentRole>,
    #[serde(default, rename = "preferredHarness")]
    pub preferred_harness: Option<HarnessType>,
    #[serde(default, rename = "preferredModel")]
    pub preferred_model: Option<String>,
    #[serde(default, rename = "maxTurns")]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, rename = "autoLoad")]
    pub auto_load: bool,
    pub instruction: String,
    #[serde(default, rename = "fallbackChain")]
    pub fallback_chain: Vec<HarnessType>,
}

// ─── LLM Chat Types ─────────────────────────────────────────────

/// LLM chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

/// A tool call from the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Tool definition for LLM function calling.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Tool execution result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub content: Vec<ToolResultContent>,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResultContent {
    pub r#type: String,
    pub text: String,
}

// ─── Context Engine Types ───────────────────────────────────────

/// A fully assembled, token-budgeted context frame.
#[derive(Debug, Clone)]
pub struct ContextFrame {
    pub frame_id: String,
    pub system: String,
    pub memory: String,
    pub turns: Vec<ConversationTurn>,
    pub injections: Vec<ContextInjection>,
    pub user_message: String,
    pub budget: TokenBudget,
}

#[derive(Debug, Clone)]
pub struct ConversationTurn {
    pub role: String,
    pub content: String,
    pub tokens: usize,
    pub compacted: bool,
}

#[derive(Debug, Clone)]
pub struct ContextInjection {
    pub source: String,
    pub label: String,
    pub content: String,
    pub tokens: usize,
    pub score: f64,
    pub tier: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TokenBudget {
    pub limit: usize,
    pub layers: HashMap<String, LayerBudget>,
    pub remaining: usize,
    pub total_used: usize,
    pub utilization_pct: f64,
}

#[derive(Debug, Clone)]
pub struct LayerBudget {
    pub allocated: usize,
    pub used: usize,
    pub compacted: usize,
}

/// Budget profile fractions (must sum to 1.0).
#[derive(Debug, Clone)]
pub struct BudgetProfile {
    pub response_reserve: f64,
    pub system: f64,
    pub user_message: f64,
    pub memory: f64,
    pub thread: f64,
    pub injections: f64,
}

// ─── Relay Types ────────────────────────────────────────────────

/// Normalized message from any platform.
#[derive(Debug, Clone)]
pub struct UnifiedMessage {
    pub id: String,
    pub chat_id: String,
    pub user_id: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub platform: PlatformId,
    pub reply_to_id: Option<String>,
    pub reply_content: Option<String>,
    pub is_voice_note: bool,
    pub media_type: Option<String>,
    pub media_buffer: Option<Vec<u8>>,
    pub harness_override: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlatformId {
    Discord,
    Telegram,
    Whatsapp,
    GoogleChat,
    Web,
}

/// Platform capabilities.
#[derive(Debug, Clone)]
pub struct PlatformCapabilities {
    pub max_message_length: usize,
    pub supports_reactions: bool,
    pub supports_streaming: bool,
    pub supports_voice: bool,
    pub supports_media: bool,
    pub format_type: String,
}

// ─── Stats ──────────────────────────────────────────────────────

/// Vault statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStats {
    pub total_notes: usize,
    pub total_jobs: JobCounts,
    pub vault_path: PathBuf,
    pub db_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct JobCounts {
    pub pending: usize,
    pub running: usize,
    pub done: usize,
    pub failed: usize,
}

// ─── Session Types ──────────────────────────────────────────────

/// Session event emitted during agent execution.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    TextDelta(String),
    TextDone(String),
    ToolStart {
        tool_name: String,
        tool_call_id: String,
    },
    ToolEnd {
        tool_name: String,
        tool_call_id: String,
        result: String,
    },
    TurnEnd {
        turn: u32,
    },
    Error(String),
    Compaction {
        old_messages: usize,
        new_messages: usize,
    },
}

/// Worker session info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerSession {
    pub worker_id: String,
    pub status: String,
    pub last_heartbeat: String,
    pub current_job_id: Option<String>,
}

/**
 * Agent Relay Protocol — Message types.
 *
 * Discriminated union of all messages exchanged between
 * relay clients and the relay server.
 */

// ─── Connection ────────────────────────────────────────────────

export interface AuthMessage {
  type: "auth";
  /** API key or session token */
  apiKey: string;
  /** Client identifier (optional) */
  clientId?: string;
  /** Client type hint */
  clientType?: "web" | "cli" | "discord" | "mobile" | "obsidian" | "whatsapp";
}

export interface AuthAckMessage {
  type: "auth-ack";
  /** Whether authentication succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Assigned session token for this connection */
  sessionToken?: string;
  /** Server version */
  serverVersion: string;
}

export interface PingMessage {
  type: "ping";
  timestamp: number;
}

export interface PongMessage {
  type: "pong";
  timestamp: number;
}

// ─── Jobs ──────────────────────────────────────────────────────

export interface JobSubmitMessage {
  type: "job:submit";
  /** Task instruction */
  instruction: string;
  /** Job type (default: "background") */
  jobType?: "background" | "rpc" | "interactive";
  /** Priority 0-100 (default: 50) */
  priority?: number;
  /** Security profile */
  securityProfile?: "minimal" | "standard" | "admin";
  /** Override model */
  modelOverride?: string;
  /** Thread ID for conversation context */
  threadId?: string;
  /** Client-provided request ID for tracking */
  requestId?: string;
}

export interface JobSubmittedMessage {
  type: "job:submitted";
  jobId: string;
  requestId?: string;
  status: "pending";
  createdAt: string;
}

export interface JobStatusMessage {
  type: "job:status";
  jobId: string;
  status: "pending" | "running" | "done" | "failed" | "waiting_for_user";
  /** Partial/streaming output */
  streamingText?: string;
  /** Final result (when done) */
  result?: string;
  /** Error message (when failed) */
  error?: string;
  updatedAt: string;
}

export interface JobStreamMessage {
  type: "job:stream";
  jobId: string;
  /** Streaming text chunk */
  delta: string;
  /** Index of this chunk */
  index: number;
}

export interface JobLogMessage {
  type: "job:log";
  jobId: string;
  level: "info" | "warn" | "error" | "debug";
  content: string;
  timestamp: string;
}

export interface JobCompleteMessage {
  type: "job:complete";
  jobId: string;
  status: "done" | "failed";
  result?: string;
  error?: string;
  /** Token usage stats */
  stats?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  };
  completedAt: string;
}

export interface JobCancelMessage {
  type: "job:cancel";
  jobId: string;
}

// ─── Chat ──────────────────────────────────────────────────────

export interface ChatSendMessage {
  type: "chat:send";
  /** User message content */
  content: string;
  /** Thread ID for continuing a conversation */
  threadId?: string;
  /** Client-provided request ID */
  requestId?: string;
  /** Model override */
  modelOverride?: string;
}

export interface ChatDeltaMessage {
  type: "chat:delta";
  requestId?: string;
  threadId?: string;
  /** Streaming text delta */
  delta: string;
  /** Chunk index */
  index: number;
}

export interface ChatToolMessage {
  type: "chat:tool";
  requestId?: string;
  /** Tool name being called */
  toolName: string;
  /** Tool input */
  toolInput?: Record<string, unknown>;
  /** Tool result (if available) */
  toolResult?: string;
}

export interface ChatFinalMessage {
  type: "chat:final";
  requestId?: string;
  threadId?: string;
  /** Complete response text */
  content: string;
  /** Token usage */
  stats?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  };
}

export interface ChatAbortMessage {
  type: "chat:abort";
  requestId?: string;
  reason?: string;
}

// ─── System ────────────────────────────────────────────────────

export interface SystemStatusMessage {
  type: "system:status";
  /** Request system status */
}

export interface SystemStatusResponseMessage {
  type: "system:status-response";
  status: "healthy" | "degraded" | "offline";
  agentOnline: boolean;
  pendingJobs: number;
  runningJobs: number;
  connectedClients: number;
  vaultPath: string;
  serverVersion: string;
  uptime: number;
}

export interface SystemEventMessage {
  type: "system:event";
  /** Event name from VaultSync EventBus */
  event: string;
  /** Event payload */
  data?: Record<string, unknown>;
  timestamp: string;
}

export interface SystemAgentsMessage {
  type: "system:agents";
  agents: Array<{
    workerId: string;
    status: "online" | "offline" | "busy";
    lastSeen?: string;
  }>;
}

export interface SystemSubscribeMessage {
  type: "system:subscribe";
  /** Events to subscribe to (e.g. "job:*", "system:*") */
  events: string[];
}

// ─── Commands ──────────────────────────────────────────────────

export interface CmdExecuteMessage {
  type: "cmd:execute";
  /** Command name */
  command: string;
  /** Command arguments */
  args?: Record<string, unknown>;
  requestId?: string;
}

export interface CmdResultMessage {
  type: "cmd:result";
  requestId?: string;
  success: boolean;
  output?: string;
  error?: string;
}

// ─── Trace ─────────────────────────────────────────────────────

export interface TraceStatusMessage {
  type: "trace:status";
  /** Specific trace ID to query. Omit for all active traces. */
  traceId?: string;
  /** Look up by job ID instead */
  jobId?: string;
}

export interface TraceStatusResponseMessage {
  type: "trace:status-response";
  traces: Array<{
    traceId: string;
    jobId: string;
    instruction: string | null;
    status: string;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    startedAt: string;
    completedAt: string | null;
    spans: Array<{
      spanId: string;
      taskId: string | null;
      type: string;
      name: string;
      status: string;
      claimedBy: string | null;
      durationMs: number | null;
    }>;
  }>;
}

export interface TraceProgressMessage {
  type: "trace:progress";
  traceId: string;
  jobId: string;
  completedTasks: number;
  totalTasks: number;
  failedTasks: number;
  /** Human-readable status line e.g. "3/5 complete, 0 failed" */
  summary: string;
  /** Latest span event for display */
  latestEvent?: {
    spanId: string;
    taskId: string | null;
    eventType: string;
    message: string | null;
  };
  timestamp: string;
}

export interface TraceCancelTaskMessage {
  type: "trace:cancel-task";
  /** Task IDs to cancel */
  taskIds: string[];
  reason?: string;
}

export interface TraceCancelTaskResultMessage {
  type: "trace:cancel-task-result";
  taskId: string;
  success: boolean;
  error?: string;
}

// ─── Error ─────────────────────────────────────────────────────

export interface RelayErrorMessage {
  type: "error";
  code: string;
  message: string;
  requestId?: string;
}

// ─── Union Type ────────────────────────────────────────────────

export type RelayMessage =
  | AuthMessage
  | AuthAckMessage
  | PingMessage
  | PongMessage
  | JobSubmitMessage
  | JobSubmittedMessage
  | JobStatusMessage
  | JobStreamMessage
  | JobLogMessage
  | JobCompleteMessage
  | JobCancelMessage
  | ChatSendMessage
  | ChatDeltaMessage
  | ChatToolMessage
  | ChatFinalMessage
  | ChatAbortMessage
  | SystemStatusMessage
  | SystemStatusResponseMessage
  | SystemEventMessage
  | SystemAgentsMessage
  | SystemSubscribeMessage
  | CmdExecuteMessage
  | CmdResultMessage
  | TraceStatusMessage
  | TraceStatusResponseMessage
  | TraceProgressMessage
  | TraceCancelTaskMessage
  | TraceCancelTaskResultMessage
  | RelayErrorMessage;

export type RelayMessageType = RelayMessage["type"];

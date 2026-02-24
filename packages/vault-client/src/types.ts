/** Core types for the VaultClient, mirroring Convex schema structures */

export type JobType = "background" | "rpc" | "interactive";
export type JobStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "done"
  | "failed"
  | "cancelled";
export type SecurityProfile = "minimal" | "standard" | "guarded" | "admin";
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type NoteType = "note" | "digest" | "system-file" | "report";
export type EmbeddingStatus = "pending" | "processing" | "embedded" | "failed";
export type HarnessType = "claude-code" | "opencode" | "gemini-cli" | "openclaw" | "any";
export type TaskStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";
export type RelayStatus = "healthy" | "degraded" | "offline";

export interface Job {
  jobId: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  securityProfile: SecurityProfile;
  modelOverride: string | null;
  thinkingLevel: ThinkingLevel | null;
  workerId: string | null;
  threadId: string | null;
  instruction: string;
  result?: string;
  streamingText?: string;
  conversationHistory?: ConversationMessage[];
  steeringMessage?: string;
  stats?: JobStats;
  createdAt: string;
  updatedAt?: string;
  /** Distributed trace ID for orchestration flows */
  traceId?: string;
  /** Root span ID for this job */
  spanId?: string;
  /** Path to the job file on disk */
  _filePath: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface JobStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  toolCalls: number;
  messageCount: number;
}

export interface Note {
  title: string;
  content: string;
  noteType: NoteType;
  tags: string[];
  pinned: boolean;
  source: string;
  embeddingStatus: EmbeddingStatus;
  relatedNotes: string[];
  createdAt: string;
  updatedAt: string;
  /** Path relative to vault root */
  _filePath: string;
}

export interface SearchResult {
  noteId: string;
  title: string;
  notebook: string;
  snippet: string;
  tags: string[];
  relevance: number;
  _filePath: string;
}

export interface DelegationSecurityConstraints {
  /** Regex patterns for blocked shell commands (e.g., ["^git\\s", "rm\\s+-rf"]) */
  blockedCommands?: string[];
  /** Filesystem access level */
  filesystemAccess?: "full" | "read-only" | "restricted";
  /** Allowed directory paths when filesystemAccess is "restricted" */
  allowedDirectories?: string[];
  /** Block all git commands */
  noGit?: boolean;
  /** Block network access */
  noNetwork?: boolean;
  /** Max execution time in ms (overrides deadlineMs) */
  maxExecutionMs?: number;
}

export interface DelegatedTask {
  taskId: string;
  jobId: string;
  targetHarnessType: HarnessType;
  status: TaskStatus;
  priority: number;
  deadlineMs: number;
  dependsOn: string[];
  claimedBy: string | null;
  claimedAt: string | null;
  instruction: string;
  result?: string;
  error?: string;
  createdAt: string;
  /** Distributed trace ID — links back to parent orchestration */
  traceId?: string;
  /** Span ID for this delegation task */
  spanId?: string;
  /** Parent span ID (the HQ job span) */
  parentSpanId?: string;
  /** Security constraints enforced at the relay level */
  securityConstraints?: DelegationSecurityConstraints;
  _filePath: string;
}

export interface RelayHealth {
  relayId: string;
  harnessType: string;
  displayName: string;
  status: RelayStatus;
  lastHeartbeat: string | null;
  tasksCompleted: number;
  tasksFailed: number;
  avgResponseTimeMs: number;
  capabilities: string[];
  discordChannelId: string | null;
  _filePath: string;
}

export interface SystemContext {
  soul: string;
  memory: string;
  preferences: string;
  heartbeat: string;
  config: Record<string, string>;
  pinnedNotes: Note[];
}

export interface UsageEntry {
  timestamp: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

export interface WorkerSession {
  workerId: string;
  status: "online" | "offline" | "busy";
  lastHeartbeat: string;
  currentJobId: string | null;
  modelConfig?: {
    provider: string;
    model: string;
  };
}

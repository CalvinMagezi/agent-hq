/**
 * Infinite Session — Type definitions.
 *
 * Session lifecycle: create → active → [checkpoint] → resume → archive
 * Messages flow through a global sequence counter for cross-surface ordering.
 */

export type SurfaceType = "discord" | "cli" | "rest" | "whatsapp" | "telegram" | "agent";
export type SessionStatus = "active" | "suspended" | "archived";
export type MessageStatus = "final" | "streaming" | "interrupted";

// ─── Session ────────────────────────────────────────────────

export interface Session {
  sessionId: string;
  /** Back-compat with existing _threads/ system */
  threadId: string;
  status: SessionStatus;
  /** Model active at session creation (may change mid-session) */
  model: string;
  /** Number of completed checkpoints */
  checkpointCount: number;
  /** Current segment index (checkpointCount + 1 after checkpoint) */
  currentSegment: number;
  /** Total messages across all segments */
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
  /** If this session was forked/resumed from another */
  resumedFrom?: string;
}

// ─── Surface Link ───────────────────────────────────────────

export interface SessionSurface {
  surface: SurfaceType;
  /** Surface-specific channel/conversation ID */
  channelId: string;
  sessionId: string;
  linkedAt: string;
  /** Last message seq this surface has seen (for catch-up) */
  lastSeenSeq: number;
}

// ─── Message ────────────────────────────────────────────────

export interface SessionMessage {
  /** Monotonic auto-increment — global ordering across surfaces */
  seq: number;
  sessionId: string;
  segmentIndex: number;
  role: "user" | "assistant";
  /** Which surface sent this message */
  surface: SurfaceType;
  content: string;
  timestamp: string;
  tokens?: number;
  /** For assistant messages: links to the user message it responds to */
  replyToSeq?: number;
  status: MessageStatus;
}

// ─── Checkpoint ─────────────────────────────────────────────

export interface CheckpointFact {
  type: "fact" | "decision" | "goal";
  content: string;
}

export interface CheckpointToolResult {
  tool: string;
  summary: string;
}

export interface Checkpoint {
  checkpointId: string;
  sessionId: string;
  segmentIndex: number;
  /** LLM-generated or extractive summary of the segment */
  summary: string;
  /** Structured facts/decisions/goals extracted from the segment */
  keyFacts: CheckpointFact[];
  /** Goals still in progress at checkpoint time */
  activeGoals: string[];
  /** Condensed tool output summaries */
  toolResults?: CheckpointToolResult[];
  /** First message seq in this segment */
  messageSeqStart: number;
  /** Last message seq in this segment */
  messageSeqEnd: number;
  /** Token count of the summary */
  tokenCount: number;
  /** Model active during this segment */
  model: string;
  createdAt: string;
}

// ─── Recall ─────────────────────────────────────────────────

export interface RecallResult {
  message: SessionMessage;
  checkpoint?: Checkpoint;
  relevanceScore: number;
}

// ─── Resume Context ─────────────────────────────────────────

export interface SessionResumeContext {
  session: Session;
  /** Checkpoints ordered oldest → newest */
  checkpointChain: Checkpoint[];
  /** Messages from the current (uncheckpointed) segment */
  recentMessages: SessionMessage[];
  /** Merged and deduplicated facts from all checkpoints */
  accumulatedFacts: CheckpointFact[];
  /** Active goals from latest checkpoint, minus completed ones */
  activeGoals: string[];
  /** All linked surfaces */
  surfaces: SessionSurface[];
}

// ─── Message Batching ───────────────────────────────────────

export interface MessageBatchConfig {
  /** Debounce window in ms (2000 for Discord, 500 for CLI) */
  batchWindowMs: number;
  /** Max messages in a batch before forcing flush (default: 10) */
  maxBatchMessages: number;
}

export interface BatchedInput {
  messages: Array<{ content: string; surface: SurfaceType; timestamp: string }>;
  /** All messages joined with \n */
  mergedContent: string;
  batchSize: number;
}

// ─── Session Manager Config ─────────────────────────────────

export interface SessionManagerConfig {
  /** Vault path for SessionStore SQLite database */
  vaultPath: string;
  /** Optional LLM summarizer for checkpoint creation */
  summarizer?: (text: string, maxTokens: number) => Promise<string>;
  /** Per-surface batch config overrides */
  batchConfig?: Partial<Record<SurfaceType, MessageBatchConfig>>;
}

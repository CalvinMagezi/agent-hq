/**
 * @repo/agent-core — Canonical types for Agent-HQ's agent loop.
 *
 * These replace all Pi SDK type imports. The shape is structurally compatible
 * with Pi SDK's AgentTool so existing tool implementations work unchanged.
 */

// ── Agent Tool ──────────────────────────────────────────────────────

/** Tool result returned by execute(). */
export interface ToolResult {
  content: { type: string; text: string }[];
  details?: Record<string, unknown>;
}

/**
 * Canonical agent tool shape — structurally compatible with Pi SDK's AgentTool
 * and hq-tools' AgentToolShape. All HQ tools implement this interface.
 *
 * Uses `any` for the schema parameter to avoid TypeBox version conflicts
 * between packages. The shape is enforced at runtime, not compile time.
 */
export interface HQAgentTool<S = any> {
  name: string;
  description: string;
  parameters: S;
  label: string;
  execute: (
    toolCallId: string,
    args: any,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ) => Promise<ToolResult>;
}

// ── Chat Messages ───────────────────────────────────────────────────

export interface ContentPart {
  type: "text" | "tool_use" | "tool_result" | "image";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  /** Base64 image data for vision */
  data?: string;
  mediaType?: string;
}

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

// ── Model Config ────────────────────────────────────────────────────

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: "google" | "anthropic" | "openrouter" | "ollama";
  api: "google-generative-ai" | "anthropic" | "openai-completions";
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
}

// ── Session ─────────────────────────────────────────────────────────

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export interface SessionStats {
  usage: SessionUsage;
  toolCalls: number;
  totalMessages: number;
  turns: number;
}

export interface SessionEvent {
  type:
    | "text_delta"
    | "text_done"
    | "tool_start"
    | "tool_end"
    | "turn_start"
    | "turn_end"
    | "error"
    | "usage";
  delta?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: unknown;
  toolResult?: ToolResult;
  error?: Error;
  usage?: Partial<SessionUsage>;
}

export type SessionEventHandler = (event: SessionEvent) => void | Promise<void>;

export interface SessionOptions {
  tools: HQAgentTool[];
  model: ModelConfig;
  systemPrompt?: string;
  /** Max tool-call turns before stopping (safety limit) */
  maxTurns?: number;
  /** Temperature for LLM calls */
  temperature?: number;
  /** Enable context compaction when usage exceeds threshold */
  compaction?: {
    enabled: boolean;
    /** Fraction of context window that triggers compaction (0-1) */
    threshold: number;
    /** Number of recent messages to preserve during compaction */
    keepRecent: number;
  };
  /** Retry config for transient LLM errors */
  retry?: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

export interface AgentSession {
  /** Send a prompt and run the tool loop until completion */
  prompt(text: string): Promise<void>;
  /** Abort the current prompt execution */
  abort(): void;
  /** Subscribe to session events */
  on(handler: SessionEventHandler): () => void;
  /** Get accumulated session stats */
  getStats(): SessionStats;
  /** Get current context usage as fraction (0-1) */
  getContextUsage(): number;
  /** Get the full message transcript */
  getMessages(): ChatMessage[];
  /** Load previously saved state (for session resumption) */
  loadState(state: SessionState): void;
  /** Save state for later resumption */
  saveState(): SessionState;
  /** Inject a mid-turn steering message */
  steer(message: string): void;
}

export interface SessionState {
  sessionId: string;
  messages: ChatMessage[];
  stats: SessionStats;
  createdAt: string;
  modelId: string;
}

// ── Bash Spawn Hook (for governance) ────────────────────────────────

export interface BashSpawnContext {
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
}

/**
 * Spawn hook for bash tool — transforms the spawn context (e.g., strip env vars,
 * audit log, block dangerous commands by throwing).
 * Returns the (possibly modified) context, or throws to block execution.
 */
export type BashSpawnHook = (ctx: BashSpawnContext) => BashSpawnContext | Promise<BashSpawnContext>;

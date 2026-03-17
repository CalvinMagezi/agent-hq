/**
 * Context Engine — Core types.
 *
 * These types define the contract between the engine and all consumers
 * (relay adapters, harnesses, the HQ agent, REST endpoints).
 */

// ─── Context Frame (the engine's output) ─────────────────────────

export interface ContextFrame {
  /** Unique frame ID for tracing and observability */
  frameId: string;

  /** Assembled system prompt (soul + harness instructions) */
  system: string;

  /** Memory block (facts, goals, preferences) — separated for models that support it */
  memory: string;

  /** Conversation turns (compacted as needed) */
  turns: ConversationTurn[];

  /** Injected context blocks (notes, search results, pinned items, reply-to) */
  injections: ContextInjection[];

  /** The user's current message (possibly enriched with metadata) */
  userMessage: string;

  /** Token accounting for the entire frame */
  budget: TokenBudget;

  /** Observability metadata */
  meta: FrameMeta;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  /** Token count of this turn */
  tokens: number;
  /** Whether this turn was compacted (summarized or truncated) */
  compacted: boolean;
  /** Original turn index in the thread */
  originalIndex?: number;
  /** Timestamp if available */
  timestamp?: string;
}

export interface ContextInjection {
  /** Source type for attribution */
  source: "pinned_note" | "search_result" | "reply_to" | "profile" | "custom";
  /** Display label */
  label: string;
  /** The injected text content */
  content: string;
  /** Token count */
  tokens: number;
  /** Relevance score (0-1) used for pruning decisions */
  score: number;
  /** Original note/chunk ID for tracing */
  sourceId?: string;
  /** Disclosure tier: "index" = compact metadata only, "full" = complete content */
  tier?: "index" | "full";
  /** Reference for on-demand expansion of index-tier injections */
  detailRef?: string;
}

// ─── Token Budget ────────────────────────────────────────────────

export interface TokenBudget {
  /** Total tokens available for this model's context window */
  limit: number;

  /** Per-layer allocation and actual usage */
  layers: Record<ContextLayer, LayerBudget>;

  /** Tokens remaining after full assembly */
  remaining: number;

  /** Whether any layer triggered compaction */
  compacted: boolean;

  /** Total tokens used across all layers */
  totalUsed: number;

  /** Utilization as a percentage (0-100) */
  utilizationPct: number;
}

export interface LayerBudget {
  /** Tokens allocated to this layer */
  allocated: number;
  /** Tokens actually used */
  used: number;
  /** Whether compaction was triggered */
  compacted: boolean;
}

export type ContextLayer =
  | "responseReserve"
  | "system"
  | "memory"
  | "thread"
  | "injections"
  | "userMessage";

// ─── Budget Profiles ─────────────────────────────────────────────

export type BudgetProfileName = "quick" | "standard" | "thorough" | "delegation";

export interface BudgetProfile {
  /** Fractional allocation per layer (must sum to 1.0) */
  responseReserve: number;
  system: number;
  memory: number;
  thread: number;
  injections: number;
  userMessage: number;
}

// ─── Frame Metadata ──────────────────────────────────────────────

export interface FrameMeta {
  /** Assembly timestamp */
  assembledAt: string;
  /** Time taken to build the frame (ms) */
  assemblyTimeMs: number;
  /** Model the frame was built for */
  model: string;
  /** Budget profile used */
  profile: BudgetProfileName;
  /** Number of thread turns included */
  threadTurnsIncluded: number;
  /** Number of thread turns that were summarized away */
  threadTurnsSummarized: number;
  /** Number of injections included */
  injectionsIncluded: number;
  /** Number of chunk index hits during injection assembly */
  chunkIndexHits: number;
  /** Compaction events that occurred during assembly */
  compactionEvents: CompactionEvent[];
  /** Harness hint passed by the caller */
  harnessHint?: string;
  /** Tokens saved by compaction (sum of before - after across events) */
  tokensSaved: number;
  /** Tokens saved by progressive disclosure (index tier vs full content) */
  injectionTokensSaved: number;
}

export interface CompactionEvent {
  layer: ContextLayer;
  strategy: "summarize" | "truncate" | "drop" | "prune";
  tokensBefore: number;
  tokensAfter: number;
}

// ─── Engine Configuration ────────────────────────────────────────

export interface ContextEngineConfig {
  /** VaultClient instance for reading vault data */
  vault: VaultClientLike;
  /** Target model ID (used to look up token limits) */
  model: string;
  /** Budget profile (default: "standard") */
  profile?: BudgetProfileName;
  /** Use exact tokenizer instead of byte heuristic (slower) */
  precision?: boolean;
  /** Optional LLM-backed summarizer for thread compaction */
  summarizer?: SummarizerFn;
  /** Maximum injections per frame (default: 8) */
  maxInjections?: number;
  /** SQLite path for chunk index (default: vault/_embeddings/chunks.db) */
  chunkIndexPath?: string;
  /** Recency window — turns kept at full fidelity (default: 4) */
  recencyWindow?: number;
  /** Maximum tokens per injection chunk (default: 300) */
  maxChunkTokens?: number;
}

export interface FrameInput {
  /** Thread ID for conversation context */
  threadId?: string;
  /** The user's current message */
  userMessage: string;
  /** Content of the message being replied to (if any) */
  replyTo?: string;
  /** Harness type hint for system prompt customization */
  harnessHint?: string;
  /** Additional injections provided by the caller */
  extraInjections?: Omit<ContextInjection, "tokens" | "score">[];
  /** Override specific budget allocations */
  budgetOverrides?: Partial<BudgetProfile>;
  /** Override the channel/thread for conversation lookup */
  channelId?: string;
}

// ─── Adapter Interfaces ──────────────────────────────────────────

/**
 * Minimal vault client interface — decouples engine from VaultClient implementation.
 * Any object satisfying this shape works (VaultClient, SyncedVaultClient, mock, etc.)
 */
export interface VaultClientLike {
  getAgentContext(): Promise<{
    soul: string;
    memory: string;
    preferences: string;
    config: Record<string, string>;
    pinnedNotes: Array<{ title: string; content: string; tags?: string[] }>;
  }>;
  searchNotes(query: string, limit: number): Promise<Array<{
    title: string;
    content: string;
    notebook?: string;
    tags?: string[];
  }>>;
  getRecentMessages?(channelId: string, limit: number): Promise<Array<{
    role: "user" | "assistant";
    content: string;
    timestamp?: string;
  }>>;
  getMemoryFacts?(): Promise<Array<{
    type: "fact" | "goal";
    content: string;
    deadline?: string;
  }>>;
}

/**
 * Summarizer function signature — provided by the host app.
 * The engine calls this when it needs to summarize thread turns.
 * Should return a concise summary of the provided text.
 */
export type SummarizerFn = (text: string, maxTokens: number) => Promise<string>;

// ─── Chunk Index Types ───────────────────────────────────────────

export interface NoteChunk {
  /** Parent note identifier */
  noteId: string;
  /** Chunk index within the note */
  chunkIndex: number;
  /** Chunk text content */
  text: string;
  /** Token count */
  tokens: number;
  /** Tags inherited from parent note */
  tags: string[];
  /** Last modified timestamp of parent note */
  modifiedAt: string;
  /** Whether parent note is pinned */
  pinned: boolean;
}

export interface ScoredChunk extends NoteChunk {
  /** Composite relevance score (0-1) */
  score: number;
}

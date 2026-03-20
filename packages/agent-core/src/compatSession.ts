/**
 * Compatibility adapter — exposes the same API shape that Pi SDK's
 * createAgentSession returned, so apps/agent/index.ts needs minimal changes.
 *
 * This is a transitional layer. Over time, index.ts should migrate to
 * use NativeAgentSession directly and this file can be deleted.
 */

import { NativeAgentSession } from "./session.js";
import type {
  HQAgentTool,
  ModelConfig,
  SessionEvent,
  SessionState,
} from "./types.js";
import type { ModelProvider } from "./providers/base.js";

// ── Compat Event Types ──────────────────────────────────────────────

export interface CompatSessionEvent {
  type:
    | "message_update"
    | "message_stop"
    | "tool_execution_start"
    | "tool_execution_end"
    | "auto_retry_start"
    | "auto_retry_end";
  [key: string]: unknown;
}

export type CompatEventHandler = (event: CompatSessionEvent) => void | Promise<void>;

// ── Compat Session ──────────────────────────────────────────────────

export interface CompatSession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(handler: CompatEventHandler): () => void;
  steer(message: string): Promise<void>;
  getContextUsage(): { tokens: number; contextWindow: number; percent: number } | null;
  getSessionStats(): {
    tokens?: { input: number; output: number; cacheRead: number; total: number };
    cost?: number;
    toolCalls?: number;
    totalMessages?: number;
  } | null;
  setActiveToolsByName(names: string[]): void;
  setThinkingLevel(level: string): void;
  readonly thinkingLevel?: string;
  /** Save/load for session persistence */
  saveState(): SessionState;
  loadState(state: SessionState): void;
}

// ── Compat Settings Manager ─────────────────────────────────────────

export interface CompatSettingsManagerConfig {
  compaction?: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
  retry?: {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

// ── Factory ─────────────────────────────────────────────────────────

export interface CreateCompatSessionOptions {
  tools: HQAgentTool[];
  model: ModelConfig;
  settingsManager?: CompatSettingsManagerConfig;
  thinkingLevel?: string;
}

/**
 * Drop-in replacement for Pi SDK's createAgentSession().
 * Returns { session } matching the same API shape.
 */
export function createCompatSession(
  options: CreateCompatSessionOptions,
  provider: ModelProvider,
): { session: CompatSession } {
  const settings = options.settingsManager;
  const nativeSession = new NativeAgentSession(
    {
      tools: options.tools,
      model: options.model,
      maxTurns: 200,
      compaction: settings?.compaction
        ? {
            enabled: settings.compaction.enabled,
            threshold: 0.75,
            keepRecent: Math.max(5, Math.floor(settings.compaction.keepRecentTokens / 2000)),
          }
        : undefined,
      retry: settings?.retry
        ? {
            maxRetries: settings.retry.maxRetries,
            baseDelayMs: settings.retry.baseDelayMs,
            maxDelayMs: settings.retry.maxDelayMs,
          }
        : undefined,
    },
    provider,
  );

  let currentThinkingLevel = options.thinkingLevel;
  const activeToolNames: Set<string> | null = null;

  // Convert NativeAgentSession events to compat events
  const subscribers = new Set<CompatEventHandler>();

  nativeSession.on((event: SessionEvent) => {
    const compat = translateEvent(event);
    if (compat) {
      for (const handler of subscribers) {
        try {
          handler(compat);
        } catch {
          // Don't break session on subscriber errors
        }
      }
    }
  });

  const session: CompatSession = {
    async prompt(text: string) {
      await nativeSession.prompt(text);
    },

    async abort() {
      nativeSession.abort();
    },

    subscribe(handler: CompatEventHandler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },

    async steer(message: string) {
      nativeSession.steer(message);
    },

    getContextUsage() {
      const fraction = nativeSession.getContextUsage();
      const contextWindow = options.model.contextWindow;
      const tokens = Math.round(fraction * contextWindow);
      return {
        tokens,
        contextWindow,
        percent: Math.round(fraction * 100),
      };
    },

    getSessionStats() {
      const stats = nativeSession.getStats();
      return {
        tokens: {
          input: stats.usage.inputTokens,
          output: stats.usage.outputTokens,
          cacheRead: stats.usage.cacheReadTokens,
          total: stats.usage.totalTokens,
        },
        cost: stats.usage.estimatedCost,
        toolCalls: stats.toolCalls,
        totalMessages: stats.totalMessages,
      };
    },

    setActiveToolsByName(_names: string[]) {
      // Tool filtering is handled by governance layer, not session
    },

    setThinkingLevel(level: string) {
      currentThinkingLevel = level;
    },

    get thinkingLevel() {
      return currentThinkingLevel;
    },

    saveState() {
      return nativeSession.saveState();
    },

    loadState(state: SessionState) {
      nativeSession.loadState(state);
    },
  };

  return { session };
}

// ── Event Translation ───────────────────────────────────────────────

function translateEvent(event: SessionEvent): CompatSessionEvent | null {
  switch (event.type) {
    case "text_delta":
      return {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: event.delta ?? "",
        },
      };

    case "text_done":
      return { type: "message_stop" };

    case "tool_start":
      return {
        type: "tool_execution_start",
        toolCall: {
          name: event.toolName,
          tool: { name: event.toolName },
          arguments: event.toolInput,
        },
      };

    case "tool_end":
      return {
        type: "tool_execution_end",
        toolResult: event.toolResult
          ? { error: undefined }
          : { error: "Tool execution failed" },
      };

    case "error":
      // Errors during tool execution are already handled via tool_end
      return null;

    default:
      return null;
  }
}

/**
 * NativeAgentSession — the core agent loop.
 *
 * prompt → LLM → tool dispatch → repeat
 *
 * This replaces Pi SDK's createAgentSession with zero external dependencies.
 * Uses ModelProvider for LLM calls and HQAgentTool for tool execution.
 */

import { randomUUID } from "crypto";
import type {
  AgentSession,
  HQAgentTool,
  ChatMessage,
  ToolCall,
  SessionEvent,
  SessionEventHandler,
  SessionOptions,
  SessionStats,
  SessionUsage,
  SessionState,
  ModelConfig,
} from "./types.js";
import type { ModelProvider, ToolDefinition, ChatResponse } from "./providers/base.js";
import { ProviderError } from "./providers/openai.js";

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_RETRY = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30000 };
const DEFAULT_COMPACTION = { enabled: true, threshold: 0.75, keepRecent: 10 };

export class NativeAgentSession implements AgentSession {
  private messages: ChatMessage[] = [];
  private tools: Map<string, HQAgentTool> = new Map();
  private toolDefinitions: ToolDefinition[] = [];
  private provider: ModelProvider;
  private model: ModelConfig;
  private systemPrompt: string;
  private maxTurns: number;
  private temperature?: number;
  private compaction: NonNullable<SessionOptions["compaction"]>;
  private retry: NonNullable<SessionOptions["retry"]>;
  private subscribers: Set<SessionEventHandler> = new Set();
  private abortController: AbortController | null = null;
  private steerMessage: string | null = null;
  private sessionId: string;

  // Stats
  private usage: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, estimatedCost: 0 };
  private toolCallCount = 0;
  private turnCount = 0;

  constructor(
    options: SessionOptions,
    provider: ModelProvider,
  ) {
    this.provider = provider;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt ?? "";
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.temperature = options.temperature;
    this.compaction = options.compaction ?? DEFAULT_COMPACTION;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.sessionId = randomUUID();

    for (const tool of options.tools) {
      this.tools.set(tool.name, tool);
      this.toolDefinitions.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
        },
      });
    }
  }

  async prompt(text: string): Promise<void> {
    this.abortController = new AbortController();

    // Inject any pending steering message before the user prompt
    if (this.steerMessage) {
      this.messages.push({ role: "user", content: `[SYSTEM STEERING]: ${this.steerMessage}` });
      this.steerMessage = null;
    }

    this.messages.push({ role: "user", content: text });

    let turns = 0;

    while (turns < this.maxTurns) {
      if (this.abortController.signal.aborted) break;

      this.turnCount++;
      turns++;
      this.emit({ type: "turn_start" });

      // Check compaction
      if (this.compaction.enabled && this.getContextUsage() > this.compaction.threshold) {
        await this.compact();
      }

      // Call LLM with retry
      const response = await this.callWithRetry();

      // Track usage
      this.updateUsage(response.usage);

      // Build assistant message
      const assistantMsg: ChatMessage = { role: "assistant", content: response.content };
      if (response.toolCalls.length > 0) {
        assistantMsg.tool_calls = response.toolCalls;
      }
      this.messages.push(assistantMsg);

      // Emit text content
      if (response.content) {
        this.emit({ type: "text_delta", delta: response.content });
        this.emit({ type: "text_done", text: response.content });
      }

      // No tool calls — conversation turn complete
      if (response.toolCalls.length === 0) {
        this.emit({ type: "turn_end" });
        break;
      }

      // Execute tool calls
      for (const toolCall of response.toolCalls) {
        if (this.abortController.signal.aborted) break;

        const tool = this.tools.get(toolCall.function.name);
        if (!tool) {
          // Unknown tool — return error to the model
          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: `Error: Unknown tool "${toolCall.function.name}". Available tools: ${[...this.tools.keys()].join(", ")}`,
          });
          this.toolCallCount++;
          continue;
        }

        this.emit({
          type: "tool_start",
          toolName: toolCall.function.name,
          toolCallId: toolCall.id,
          toolInput: toolCall.function.arguments,
        });

        let args: unknown;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        try {
          const result = await tool.execute(
            toolCall.id,
            args as any,
            this.abortController.signal,
          );

          this.emit({
            type: "tool_end",
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            toolResult: result,
          });

          // Append tool result message
          const resultText = result.content.map(c => c.text).join("\n");
          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: resultText,
          });
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: `Tool execution error: ${errorMsg}`,
          });
          this.emit({
            type: "error",
            error: err instanceof Error ? err : new Error(errorMsg),
            toolName: toolCall.function.name,
          });
        }

        this.toolCallCount++;
      }

      // Inject mid-turn steering
      if (this.steerMessage) {
        this.messages.push({ role: "user", content: `[SYSTEM STEERING]: ${this.steerMessage}` });
        this.steerMessage = null;
      }

      this.emit({ type: "turn_end" });
    }

    this.abortController = null;
  }

  abort(): void {
    this.abortController?.abort();
  }

  on(handler: SessionEventHandler): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  getStats(): SessionStats {
    return {
      usage: { ...this.usage },
      toolCalls: this.toolCallCount,
      totalMessages: this.messages.length,
      turns: this.turnCount,
    };
  }

  getContextUsage(): number {
    // Rough estimate: ~4 chars per token
    const charCount = this.messages.reduce((sum, m) => {
      const content = typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map(p => p.text ?? "").join("");
      return sum + content.length;
    }, 0);
    const estimatedTokens = Math.ceil(charCount / 4);
    return estimatedTokens / this.model.contextWindow;
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  loadState(state: SessionState): void {
    this.messages = state.messages;
    this.sessionId = state.sessionId;
    this.usage = state.stats.usage;
    this.toolCallCount = state.stats.toolCalls;
    this.turnCount = state.stats.turns;
  }

  saveState(): SessionState {
    return {
      sessionId: this.sessionId,
      messages: [...this.messages],
      stats: this.getStats(),
      createdAt: new Date().toISOString(),
      modelId: this.model.id,
    };
  }

  steer(message: string): void {
    this.steerMessage = message;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async callWithRetry(): Promise<ChatResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      try {
        return await this.provider.chat({
          messages: this.messages,
          tools: this.toolDefinitions.length > 0 ? this.toolDefinitions : undefined,
          model: this.model.id,
          maxTokens: this.model.maxTokens,
          temperature: this.temperature,
          systemPrompt: this.systemPrompt,
        });
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        const isTransient = err instanceof ProviderError && err.isTransient;
        if (!isTransient || attempt === this.retry.maxRetries) {
          throw lastError;
        }

        // Exponential backoff
        const delay = Math.min(
          this.retry.baseDelayMs * Math.pow(2, attempt),
          this.retry.maxDelayMs,
        );
        await new Promise(r => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error("Retry exhausted");
  }

  private async compact(): Promise<void> {
    const keepRecent = this.compaction.keepRecent;
    if (this.messages.length <= keepRecent + 2) return;

    // Keep system context and recent messages, summarize the middle
    const toSummarize = this.messages.slice(0, -keepRecent);
    const recent = this.messages.slice(-keepRecent);

    // Create a summary using the provider
    const summaryPrompt = `Summarize the following conversation context concisely, preserving key decisions, tool results, and important details:\n\n${toSummarize.map(m => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n").slice(0, 8000)}`;

    try {
      const resp = await this.provider.chat({
        messages: [{ role: "user", content: summaryPrompt }],
        model: this.model.id,
        maxTokens: 2000,
        systemPrompt: "You are a conversation summarizer. Be concise but preserve critical details.",
      });

      this.messages = [
        { role: "user", content: `[Context Summary]: ${resp.content}` },
        { role: "assistant", content: "Understood. I have the context from our prior conversation." },
        ...recent,
      ];
    } catch {
      // If compaction fails, just truncate old messages
      this.messages = recent;
    }
  }

  private updateUsage(usage: ChatResponse["usage"]): void {
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.cacheReadTokens += usage.cacheReadTokens;
    this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens;

    // Estimate cost based on model config
    this.usage.estimatedCost =
      (this.usage.inputTokens * this.model.cost.input / 1_000_000) +
      (this.usage.outputTokens * this.model.cost.output / 1_000_000) +
      (this.usage.cacheReadTokens * this.model.cost.cacheRead / 1_000_000);

    this.emit({ type: "usage", usage: { ...this.usage } });
  }

  private emit(event: SessionEvent): void {
    for (const handler of this.subscribers) {
      try {
        handler(event);
      } catch {
        // Don't let subscriber errors break the session
      }
    }
  }
}

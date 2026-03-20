/**
 * ModelProvider interface — the abstraction that makes Agent-HQ provider-agnostic.
 *
 * Each provider (Anthropic, OpenAI/OpenRouter/Ollama, Gemini) implements this
 * interface using raw fetch(). Zero SDK dependencies.
 */

import type { ChatMessage, ToolCall, ModelConfig } from "../types.js";

// ── Provider Request/Response ───────────────────────────────────────

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  };
  finishReason: "stop" | "tool_use" | "length" | "error";
}

export interface StreamChunk {
  type: "text_delta" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "done" | "error";
  delta?: string;
  toolCall?: Partial<ToolCall>;
  usage?: ChatResponse["usage"];
  error?: string;
}

// ── Provider Interface ──────────────────────────────────────────────

export interface ModelProvider {
  readonly id: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream?(request: ChatRequest): AsyncIterable<StreamChunk>;
}

// ── Provider Factory ────────────────────────────────────────────────

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

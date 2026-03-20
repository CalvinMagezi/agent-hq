/**
 * @repo/agent-core — Agent-HQ's own agent execution engine.
 *
 * Zero AI SDK dependencies. Provider-agnostic. Bun-native.
 *
 * Replaces:
 *   @mariozechner/pi-coding-agent  → NativeAgentSession, createCodingTools
 *   @mariozechner/pi-agent-core    → HQAgentTool type
 *   @mariozechner/pi-ai            → ModelConfig, resolveProvider
 */

// Types
export type {
  HQAgentTool,
  ToolResult,
  AgentSession,
  SessionOptions,
  SessionEvent,
  SessionEventHandler,
  SessionState,
  SessionStats,
  SessionUsage,
  ChatMessage,
  ContentPart,
  ToolCall,
  ToolCallFunction,
  ModelConfig,
  ModelCost,
  BashSpawnContext,
  BashSpawnHook,
} from "./types.js";

// Session
export { NativeAgentSession } from "./session.js";

// Coding tools
export {
  createCodingTools,
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
} from "./codingTools.js";

// Compat layer (transitional — wraps NativeAgentSession in Pi SDK-like API)
export { createCompatSession } from "./compatSession.js";
export type { CompatSession, CompatSessionEvent, CompatEventHandler, CreateCompatSessionOptions } from "./compatSession.js";

// Providers (re-exported for convenience)
export { resolveProvider } from "./providers/index.js";
export type { ModelProvider, ChatRequest, ChatResponse, ToolDefinition } from "./providers/base.js";
export { OpenAIProvider, ProviderError } from "./providers/openai.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export { GeminiProvider } from "./providers/gemini.js";

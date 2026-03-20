/**
 * Provider factory — resolves the right ModelProvider from a ModelConfig.
 *
 * Zero SDK dependencies. All providers use raw fetch().
 */

export type { ModelProvider, ChatRequest, ChatResponse, StreamChunk, ToolDefinition, ProviderConfig } from "./base.js";
export { OpenAIProvider, ProviderError } from "./openai.js";
export { AnthropicProvider } from "./anthropic.js";
export { GeminiProvider } from "./gemini.js";

import type { ModelProvider } from "./base.js";
import type { ModelConfig } from "../types.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";

/**
 * Create a ModelProvider from a ModelConfig + API keys.
 *
 * Provider routing:
 *   google    → GeminiProvider (direct API)
 *   anthropic → AnthropicProvider (Messages API)
 *   openrouter/ollama → OpenAIProvider (OpenAI-compatible)
 */
export function resolveProvider(
  config: ModelConfig,
  keys: {
    anthropicApiKey?: string;
    geminiApiKey?: string;
    openrouterApiKey?: string;
    ollamaBaseUrl?: string;
  },
): ModelProvider {
  switch (config.provider) {
    case "anthropic":
      if (!keys.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY required for Anthropic provider");
      return new AnthropicProvider({
        apiKey: keys.anthropicApiKey,
        baseUrl: config.baseUrl,
      });

    case "google":
      if (!keys.geminiApiKey) throw new Error("GEMINI_API_KEY required for Google provider");
      return new GeminiProvider({
        apiKey: keys.geminiApiKey,
        baseUrl: config.baseUrl,
      });

    case "ollama":
      // Ollama uses OpenAI-compatible API, no auth needed
      return new OpenAIProvider({
        apiKey: "ollama",
        baseUrl: config.baseUrl || keys.ollamaBaseUrl || "http://localhost:11434/v1",
      });

    case "openrouter":
    default:
      if (!keys.openrouterApiKey) throw new Error("OPENROUTER_API_KEY required for OpenRouter provider");
      return new OpenAIProvider({
        apiKey: keys.openrouterApiKey,
        baseUrl: config.baseUrl || "https://openrouter.ai/api/v1",
        extraHeaders: {
          "HTTP-Referer": "https://agent-hq.local",
          "X-Title": "Agent-HQ",
        },
      });
  }
}

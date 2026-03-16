/**
 * LLM model & embedding provider abstraction.
 *
 * Supports multiple providers with automatic detection from env vars:
 * - Gemini (via GEMINI_API_KEY)
 * - Anthropic (via ANTHROPIC_API_KEY)
 * - OpenRouter (via OPENROUTER_API_KEY) — routes to any model
 * - Ollama (local, no key)
 *
 * Consumers that only need embeddings can use fetchEmbedding() directly
 * (plain fetch, zero SDK deps). Legacy getLanguageModel/getEmbeddingModel
 * still work for backward compat but require @openrouter/ai-sdk-provider.
 */

// ── Provider config types ───────────────────────────────────────────

export type EmbeddingProviderType = "gemini" | "openrouter" | "ollama" | "none";
export type ChatProviderType = "gemini" | "anthropic" | "openrouter" | "ollama" | "none";

export interface EmbeddingProviderConfig {
  type: EmbeddingProviderType;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export interface ChatProviderConfig {
  type: ChatProviderType;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

// ── Provider resolution ─────────────────────────────────────────────

/**
 * Detect the best available embedding provider from environment variables.
 * Priority: Gemini → OpenRouter → Ollama → none
 */
export function resolveEmbeddingProvider(): EmbeddingProviderConfig {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    return {
      type: "gemini",
      apiKey: geminiKey,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: process.env.EMBEDDING_MODEL ?? "text-embedding-004",
    };
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    return {
      type: "openrouter",
      apiKey: openrouterKey,
      baseUrl: "https://openrouter.ai/api/v1",
      model: process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
    };
  }

  // Only return Ollama if explicitly configured via OLLAMA_BASE_URL
  const ollamaUrl = process.env.OLLAMA_BASE_URL;
  if (ollamaUrl) {
    return {
      type: "ollama",
      baseUrl: ollamaUrl,
      model: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
    };
  }

  return { type: "none", model: "" };
}

/**
 * Detect the best available chat provider from environment variables.
 * Priority: Gemini → Anthropic → OpenRouter → none
 */
export function resolveChatProvider(): ChatProviderConfig {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    return {
      type: "gemini",
      apiKey: geminiKey,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: process.env.DEFAULT_MODEL ?? "gemini-2.5-flash",
    };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      type: "anthropic",
      apiKey: anthropicKey,
      baseUrl: "https://api.anthropic.com/v1",
      model: process.env.DEFAULT_MODEL ?? "claude-sonnet-4-6",
    };
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    return {
      type: "openrouter",
      apiKey: openrouterKey,
      baseUrl: "https://openrouter.ai/api/v1",
      model: process.env.DEFAULT_MODEL ?? "moonshotai/kimi-k2.5",
    };
  }

  return { type: "none", model: "" };
}

/**
 * Detect the best available vision provider from environment variables.
 * Priority: Gemini → OpenRouter → Anthropic → none
 */
export function resolveVisionProvider(): ChatProviderConfig {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    return {
      type: "gemini",
      apiKey: geminiKey,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: process.env.VISION_MODEL ?? "gemini-2.5-flash",
    };
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    return {
      type: "openrouter",
      apiKey: openrouterKey,
      baseUrl: "https://openrouter.ai/api/v1",
      model: process.env.VISION_MODEL ?? "google/gemini-2.5-flash-preview-05-20",
    };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      type: "anthropic",
      apiKey: anthropicKey,
      baseUrl: "https://api.anthropic.com/v1",
      model: process.env.VISION_MODEL ?? "claude-sonnet-4-6",
    };
  }

  return { type: "none", model: "" };
}

// ── Embedding fetcher (zero SDK deps) ───────────────────────────────

/**
 * Fetch an embedding vector for the given text using the specified provider.
 * Returns null if the provider is "none" or if the request fails.
 */
export async function fetchEmbedding(
  text: string,
  provider: EmbeddingProviderConfig,
): Promise<number[] | null> {
  if (provider.type === "none") return null;

  try {
    if (provider.type === "gemini") {
      const url = `${provider.baseUrl}/models/${provider.model}:embedContent?key=${provider.apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${provider.model}`,
          content: { parts: [{ text }] },
        }),
      });
      if (!res.ok) throw new Error(`Gemini embedding error: ${res.status}`);
      const json = await res.json() as { embedding?: { values?: number[] } };
      return json.embedding?.values ?? null;
    }

    if (provider.type === "openrouter") {
      const res = await fetch(`${provider.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: provider.model, input: text }),
      });
      if (!res.ok) throw new Error(`OpenRouter embedding error: ${res.status}`);
      const json = await res.json() as { data: Array<{ embedding: number[] }> };
      return json.data[0]?.embedding ?? null;
    }

    if (provider.type === "ollama") {
      const res = await fetch(`${provider.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: provider.model, prompt: text }),
      });
      if (!res.ok) throw new Error(`Ollama embedding error: ${res.status}`);
      const json = await res.json() as { embedding?: number[] };
      return json.embedding ?? null;
    }

    return null;
  } catch (err) {
    console.error(`[models] Embedding failed (${provider.type}):`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Check if the resolved embedding provider is actually available.
 * For Ollama, this verifies the server is reachable.
 * For API-key providers, checks the key is non-empty.
 */
export async function isEmbeddingProviderAvailable(
  provider: EmbeddingProviderConfig,
): Promise<boolean> {
  if (provider.type === "none") return false;
  if (provider.type === "ollama") {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${provider.baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }
  return !!provider.apiKey;
}

// ── Legacy functions (backward compat) ──────────────────────────────

export function getLanguageModel(modelOverride?: string) {
  // Dynamic import to avoid requiring these as vault-client dependencies
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createOpenRouter } = require("@openrouter/ai-sdk-provider");
  const openrouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY!,
  });
  const model =
    modelOverride ?? process.env.DEFAULT_MODEL ?? "moonshotai/kimi-k2.5";
  return openrouter.chat(model);
}

export function getEmbeddingModel() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createOpenRouter } = require("@openrouter/ai-sdk-provider");
  const openrouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY!,
  });
  return openrouter.textEmbeddingModel(
    process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
  );
}

/** Default model configurations */
export const MODEL_DEFAULTS = {
  chat: "gemini-2.5-flash",
  embedding: "openai/text-embedding-3-small",
  geminiEmbedding: "text-embedding-004",
  cheapChat: "google/gemini-2.5-flash",
  embeddingDimensions: 1536,
} as const;

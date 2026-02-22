/**
 * LLM model configuration via OpenRouter.
 * Ported from packages/convex/convex/lib/models.ts
 *
 * Note: Consumers must have @openrouter/ai-sdk-provider and ai installed.
 * This module provides factory functions for creating model instances.
 */

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
  chat: "moonshotai/kimi-k2.5",
  embedding: "openai/text-embedding-3-small",
  cheapChat: "google/gemini-2.5-flash",
  embeddingDimensions: 1536,
} as const;

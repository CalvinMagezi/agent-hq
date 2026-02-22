/**
 * OpenRouter model pricing — cost per 1M tokens (USD).
 * Ported from packages/convex/convex/lib/pricing.ts
 */

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Moonshot
  "moonshotai/kimi-k2.5": { inputPer1M: 0.5, outputPer1M: 2.8 },
  "moonshotai/kimi-k2": { inputPer1M: 0.5, outputPer1M: 2.8 },

  // Anthropic
  "anthropic/claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "anthropic/claude-3.5-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "anthropic/claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },

  // OpenAI
  "openai/gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "openai/gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "openai/gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },

  // Google (via OpenRouter)
  "google/gemini-2.5-flash": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "google/gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "google/gemini-3-flash-preview": { inputPer1M: 0.1, outputPer1M: 0.4 },

  // Google (direct API — bare model IDs)
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "gemini-3-flash-preview": { inputPer1M: 0.5, outputPer1M: 3.0 },
  "gemini-3-pro-preview": { inputPer1M: 2.0, outputPer1M: 12.0 },
  "gemini-3.1-pro-preview": { inputPer1M: 2.0, outputPer1M: 12.0 },

  // DeepSeek
  "deepseek/deepseek-chat-v3": { inputPer1M: 0.27, outputPer1M: 1.1 },
  "deepseek/deepseek-r1": { inputPer1M: 0.55, outputPer1M: 2.19 },

  // Meta
  "meta-llama/llama-4-maverick": { inputPer1M: 0.2, outputPer1M: 0.6 },
};

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 3.0 };

export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  return (
    (promptTokens * pricing.inputPer1M +
      completionTokens * pricing.outputPer1M) /
    1_000_000
  );
}

export function getModelPricing(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}

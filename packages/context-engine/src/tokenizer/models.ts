/**
 * Model context window limits.
 *
 * Maps model ID prefixes/exact names to their maximum context window size.
 * Used by the budget allocator to determine total available tokens.
 */

const MODEL_LIMITS: Record<string, number> = {
  // Anthropic Claude
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4": 200_000,
  "claude-3.5": 200_000,

  // Google Gemini
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,

  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4.1": 1_000_000,
  "gpt-4-turbo": 128_000,
  "o1": 200_000,
  "o3": 200_000,

  // OpenRouter model paths (commonly used in Agent HQ)
  "google/gemini": 1_000_000,
  "anthropic/claude": 200_000,
  "openai/gpt-4o": 128_000,
  "moonshotai/kimi": 128_000,
};

const DEFAULT_LIMIT = 128_000;

/**
 * Get the context window token limit for a model.
 * Matches exact names first, then prefix matches, then falls back to default.
 */
export function getModelLimit(model: string): number {
  // Exact match
  if (model in MODEL_LIMITS) return MODEL_LIMITS[model];

  // Prefix match — try progressively shorter prefixes
  const parts = model.split(/[-/]/);
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join("-");
    if (prefix in MODEL_LIMITS) return MODEL_LIMITS[prefix];

    // Also try with slash separator (for OpenRouter paths)
    const slashPrefix = parts.slice(0, i).join("/");
    if (slashPrefix in MODEL_LIMITS) return MODEL_LIMITS[slashPrefix];
  }

  return DEFAULT_LIMIT;
}

/**
 * Check if a model has a large context window (>500K tokens).
 * Useful for deciding whether aggressive compaction is needed.
 */
export function isLargeContextModel(model: string): boolean {
  return getModelLimit(model) > 500_000;
}

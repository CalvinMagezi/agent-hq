/**
 * Model Registry — Type definitions.
 *
 * Single source of truth for model capabilities across Agent HQ.
 */

export type ModelProvider =
  | "anthropic"
  | "google"
  | "openai"
  | "openrouter"
  | "ollama"
  | "other";

export type ModelTier = "flash" | "standard" | "pro";

export interface ModelSpec {
  /** Canonical model ID (e.g. "claude-sonnet-4-6") */
  id: string;
  /** LLM provider */
  provider: ModelProvider;
  /** Input context window size in tokens */
  contextWindow: number;
  /** Maximum output tokens */
  maxOutputTokens: number;
  /** Performance tier — used for fallback chain grouping */
  tier: ModelTier;
  /** Short aliases (e.g. ["sonnet", "claude-sonnet"]) */
  aliases?: string[];
  /** Cost per 1M input tokens (USD) */
  inputCostPer1M?: number;
  /** Cost per 1M output tokens (USD) */
  outputCostPer1M?: number;
  /** When this spec was last verified/updated */
  updatedAt?: string;
}

export interface ModelRegistryConfig {
  /** Path to vault for loading _system/MODEL-REGISTRY.md overrides */
  vaultPath?: string;
  /** Additional specs to merge (for testing or custom models) */
  extraSpecs?: ModelSpec[];
}

export interface CheckpointConfig {
  /** Context utilization % to trigger checkpoint */
  thresholdPct: number;
  /** Target token count for checkpoint summaries */
  summaryTargetTokens: number;
  /** Max number of checkpoints to load into context */
  maxChainDepth: number;
}

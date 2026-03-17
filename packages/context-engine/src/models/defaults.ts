/**
 * Model Registry — Default specs.
 *
 * Single hardcoded baseline for all known models.
 * Overridable at runtime via _system/MODEL-REGISTRY.md vault file.
 *
 * LATEST SERIES (as of March 2026):
 *   - Claude 4.6 (Anthropic)
 *   - Gemini 3.1 (Google)
 *   - GPT-5.4 / o3 (OpenAI)
 *   - Qwen 3.5 (Ollama local)
 */

import type { ModelSpec } from "./types.js";

export const DEFAULT_SPECS: ModelSpec[] = [
  // ─── Anthropic Claude 4.6 series (1M context) ────────────────
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    tier: "pro",
    aliases: ["opus", "claude-opus", "claude-opus-4"],
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    tier: "standard",
    aliases: ["sonnet", "claude-sonnet", "claude-sonnet-4"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    tier: "flash",
    aliases: ["haiku", "claude-haiku", "claude-haiku-4", "claude-haiku-4-5"],
  },

  // ─── Anthropic Claude legacy (kept for prefix matching) ──────
  {
    id: "claude-3.5-sonnet",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    tier: "standard",
    aliases: ["claude-3.5"],
  },

  // ─── Google Gemini 3.1 series (latest) ────────────────────────
  {
    id: "gemini-3.1-pro-preview",
    provider: "google",
    contextWindow: 2_000_000,
    maxOutputTokens: 65_536,
    tier: "pro",
    aliases: ["gemini-pro", "gemini-3.1-pro", "gemini-3-pro"],
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    provider: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    tier: "flash",
    aliases: ["gemini-3.1-flash-lite", "gemini-3-flash-lite"],
  },
  {
    id: "gemini-3-flash-preview",
    provider: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    tier: "flash",
    aliases: ["gemini-3-flash"],
  },

  // ─── Google Gemini 2.x (still widely used) ───────────────────
  {
    id: "gemini-2.5-flash",
    provider: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    tier: "flash",
    aliases: ["gemini-flash"],
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    tier: "pro",
  },
  {
    id: "gemini-2.0-flash",
    provider: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    tier: "flash",
  },
  {
    id: "gemini-1.5-pro",
    provider: "google",
    contextWindow: 2_000_000,
    maxOutputTokens: 65_536,
    tier: "pro",
  },
  {
    id: "gemini-1.5-flash",
    provider: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    tier: "flash",
  },

  // ─── OpenAI GPT-5.4 series (latest) ──────────────────────────
  {
    id: "gpt-5.4",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    tier: "pro",
    aliases: ["gpt-5.4-turbo"],
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 16_384,
    tier: "standard",
  },
  {
    id: "gpt-5",
    provider: "openai",
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    tier: "pro",
  },
  {
    id: "o3",
    provider: "openai",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    tier: "pro",
  },
  {
    id: "o1",
    provider: "openai",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    tier: "pro",
  },

  // ─── OpenAI legacy (kept for prefix matching) ────────────────
  {
    id: "gpt-4.1",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    tier: "standard",
  },
  {
    id: "gpt-4.1-mini",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    tier: "flash",
  },
  {
    id: "gpt-4o",
    provider: "openai",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    tier: "standard",
  },
  {
    id: "gpt-4-turbo",
    provider: "openai",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    tier: "standard",
  },

  // ─── OpenRouter prefixed paths ────────────────────────────────
  {
    id: "google/gemini",
    provider: "openrouter",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    tier: "standard",
  },
  {
    id: "anthropic/claude",
    provider: "openrouter",
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    tier: "standard",
  },
  {
    id: "openai/gpt-5",
    provider: "openrouter",
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    tier: "pro",
  },
  {
    id: "openai/gpt-4o",
    provider: "openrouter",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    tier: "standard",
  },
  {
    id: "moonshotai/kimi",
    provider: "openrouter",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    tier: "standard",
    aliases: ["kimi"],
  },

  // ─── Local — Qwen 3.5 series only (M4 MacBook Pro 24GB) ─────
  // 9b is the primary workhorse (6.6GB, 100% GPU, 262K context)
  // 0.6b and 2b for lightweight/fast tasks
  // No gemma, no 32b+ (won't fit in 24GB comfortably)
  {
    id: "qwen3.5:9b",
    provider: "ollama",
    contextWindow: 262_144,
    maxOutputTokens: 8_192,
    tier: "standard",
    aliases: ["qwen3.5", "qwen", "qwen-9b"],
  },
  {
    id: "qwen3.5:2b",
    provider: "ollama",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    tier: "flash",
    aliases: ["qwen-2b"],
  },
  {
    id: "qwen3.5:0.8b",
    provider: "ollama",
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    tier: "flash",
    aliases: ["qwen-0.8b", "qwen-tiny"],
  },
  // Generic ollama/ prefix fallback for unknown local models
  {
    id: "ollama/",
    provider: "ollama",
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    tier: "flash",
  },
];

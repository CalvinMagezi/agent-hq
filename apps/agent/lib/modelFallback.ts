/**
 * LLM Fallback Chain — Multi-provider resilience with error classification.
 *
 * Inspired by CodeBuff's three-tier cascade (finetuned → primary → fallback).
 * When a model call fails with a transient error, automatically retry with
 * the next model in the chain. Abort errors (user cancellation, auth failures)
 * are never retried.
 *
 * Builds on top of the existing retry.ts module (which handles same-model
 * retries with exponential backoff). This module handles cross-model fallback.
 *
 * Usage:
 *   const chain = getFallbackChain("gemini-2.5-flash");
 *   const result = await executeWithFallback(chain, async (modelId) => {
 *     return await callLLM(modelId, prompt);
 *   });
 */

import { logger } from "./logger.js";

// ── Types ────────────────────────────────────────────────────────────

export interface ModelFallbackConfig {
    /** The primary model to try first. */
    primary: string;
    /** Ordered list of fallback models to try on failure. */
    fallbacks: string[];
    /** Total number of retries across all models. */
    maxRetries: number;
}

export type ErrorClassification = "abort" | "retry";

// ── Fallback Chain Definitions ───────────────────────────────────────

/**
 * Pre-defined fallback chains per model family.
 * First element is the primary; rest are fallbacks in order.
 *
 * Design principles:
 * - Each tier has a different provider (for provider-level outages)
 * - Tiers are roughly capability-matched (flash→flash, pro→pro)
 * - Chains are short (3 models max) to avoid latency accumulation
 */
const FALLBACK_CHAINS: Record<string, string[]> = {
    // ── Gemini 3.x tier (primary Gemini harness models) ──────────────
    // Primary: OAuth free (1000 RPD) → cheap OpenRouter → mid OpenRouter → Pro OpenRouter
    "gemini-3-flash-preview": [
        "gemini-3-flash-preview",                   // OAuth, 1000 RPD free
        "google/gemini-3.1-flash-lite-preview",     // OpenRouter, $0.25/1M (cheapest)
        "google/gemini-3-flash-preview",            // OpenRouter, $0.50/1M
        "google/gemini-3.1-pro-preview",            // OpenRouter, $2.00/1M (heavy use)
    ],
    // Heavy/explicit Pro chain
    "gemini-3.1-pro-preview": [
        "gemini-3.1-pro-preview",
        "google/gemini-3.1-pro-preview",
        "google/gemini-3.1-pro-preview-customtools",
        "claude-opus-4-6",
    ],
    // Lite chain (direct API only — CLI OAuth doesn't support it yet)
    "gemini-3.1-flash-lite-preview": [
        "gemini-3.1-flash-lite-preview",
        "google/gemini-3.1-flash-lite-preview",
        "google/gemini-3-flash-preview",
    ],

    // ── Flash tier (fast, cheap) ──────────────────────────────────
    "gemini-2.5-flash": ["gemini-2.5-flash", "claude-sonnet-4-6", "gpt-4.1-mini"],
    "claude-sonnet-4-6": ["claude-sonnet-4-6", "gemini-3-flash-preview", "gpt-4.1-mini"],
    "gpt-4.1-mini": ["gpt-4.1-mini", "gemini-3-flash-preview", "claude-sonnet-4-6"],

    // ── Pro tier (smart, capable) ─────────────────────────────────
    "gemini-2.5-pro": ["gemini-2.5-pro", "claude-opus-4-6", "gpt-5"],
    "claude-opus-4-6": ["claude-opus-4-6", "gemini-3.1-pro-preview", "gpt-5"],
    "gpt-5": ["gpt-5", "claude-opus-4-6", "gemini-3.1-pro-preview"],

    // ── Specialized ───────────────────────────────────────────────
    "gemini-2.5-flash-lite": ["gemini-2.5-flash-lite", "gemini-3-flash-preview"],

    // ── Worker tier (free/cheap models for background vault tasks) ─
    // Tries local Ollama first (free), then cheap 3.x cloud fallbacks.
    "ollama/qwen3.5:9b": ["ollama/qwen3.5:9b", "gemini-3.1-flash-lite-preview", "gemini-3-flash-preview"],
    "ollama/llama3.2:3b": ["ollama/llama3.2:3b", "gemini-3.1-flash-lite-preview", "gemini-3-flash-preview"],
};

// ── Error Classification ─────────────────────────────────────────────

/**
 * Classify an error as "abort" (don't retry) or "retry" (try next model).
 *
 * Abort conditions:
 * - User cancellation / abort signal
 * - Authentication failures (won't succeed with different provider key anyway
 *   unless it's a provider-specific key issue, but we err on the side of caution)
 * - Content policy / safety violations (same prompt will fail on any model)
 * - Context overflow (needs prompt reduction, not model change)
 *
 * Retry conditions:
 * - Rate limits (different provider may have capacity)
 * - Server errors (5xx — transient)
 * - Network errors (transient)
 * - Timeout (different provider may respond faster)
 * - Overloaded / capacity errors
 */
export function classifyError(error: Error): ErrorClassification {
    const msg = error.message.toLowerCase();

    // ── Abort: don't retry ────────────────────────────────────────
    if (msg.includes("abort") || msg.includes("cancel")) return "abort";
    if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized")) return "abort";
    if (msg.includes("invalid") && msg.includes("key")) return "abort";
    if (msg.includes("safety") || msg.includes("content_filter") || msg.includes("blocked")) return "abort";
    if (msg.includes("context") && (msg.includes("too large") || msg.includes("exceeded"))) return "abort";

    // ── Retry: try next model ─────────────────────────────────────
    return "retry";
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Get the fallback chain for a given model ID.
 * Unknown models get no fallbacks (single-model chain).
 */
export function getFallbackChain(modelId: string): ModelFallbackConfig {
    // Try exact match
    const chain = FALLBACK_CHAINS[modelId];
    if (chain) {
        return {
            primary: chain[0],
            fallbacks: chain.slice(1),
            maxRetries: chain.length - 1,
        };
    }

    // Try stripping provider prefix (e.g. "google/gemini-2.5-flash" → "gemini-2.5-flash")
    const bareId = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
    const bareChain = FALLBACK_CHAINS[bareId];
    if (bareChain) {
        return {
            primary: bareChain[0],
            fallbacks: bareChain.slice(1),
            maxRetries: bareChain.length - 1,
        };
    }

    // Unknown model — no fallback
    return {
        primary: modelId,
        fallbacks: [],
        maxRetries: 0,
    };
}

/**
 * Get the list of all model IDs in a fallback chain (primary + fallbacks).
 * Useful for reporting which models were attempted.
 */
export function getChainModelIds(chain: ModelFallbackConfig): string[] {
    return [chain.primary, ...chain.fallbacks];
}

/**
 * Execute a function with cross-model fallback.
 *
 * Tries the primary model first. On transient failure, moves to the next
 * model in the chain. Abort errors are thrown immediately without retry.
 *
 * @param chain - The fallback chain configuration
 * @param execute - Function to execute with a given model ID
 * @param onFallback - Optional callback when falling back to next model
 * @returns The result from the first successful execution
 * @throws The last error if all models fail, or an abort error immediately
 */
export async function executeWithFallback<T>(
    chain: ModelFallbackConfig,
    execute: (modelId: string) => Promise<T>,
    onFallback?: (fromModel: string, toModel: string, error: Error) => void,
): Promise<T> {
    const allModels = [chain.primary, ...chain.fallbacks];
    let lastError: Error | null = null;

    for (let i = 0; i < allModels.length; i++) {
        const modelId = allModels[i];

        try {
            return await execute(modelId);
        } catch (error: any) {
            lastError = error instanceof Error ? error : new Error(String(error));
            const classification = classifyError(lastError);

            if (classification === "abort") {
                logger.warn("Model call aborted (non-retryable)", {
                    model: modelId,
                    error: lastError.message,
                    classification,
                });
                throw lastError;
            }

            // Log the transient failure
            logger.warn("Model call failed, checking fallback", {
                model: modelId,
                error: lastError.message,
                classification,
                attemptIndex: i + 1,
                totalModels: allModels.length,
            });

            // Notify callback if there's a next model
            const nextIdx = i + 1;
            if (nextIdx < allModels.length && onFallback) {
                onFallback(modelId, allModels[nextIdx], lastError);
            }
        }
    }

    throw lastError ?? new Error("All models in fallback chain failed");
}

/**
 * Build fallback chain info for inclusion in delegation task frontmatter.
 * Returns a compact string representation: "primary|fallback1|fallback2"
 */
export function serializeFallbackChain(chain: ModelFallbackConfig): string {
    return [chain.primary, ...chain.fallbacks].join("|");
}

/**
 * Parse a serialized fallback chain from frontmatter.
 */
export function deserializeFallbackChain(serialized: string): ModelFallbackConfig {
    const models = serialized.split("|").filter(Boolean);
    return {
        primary: models[0] || "",
        fallbacks: models.slice(1),
        maxRetries: Math.max(0, models.length - 1),
    };
}

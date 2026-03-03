/**
 * Centralized model configuration builder.
 *
 * Detects provider from model ID and available API keys,
 * then builds a Pi SDK Model config object.
 *
 * Supports:
 * - Google Generative AI (via GEMINI_API_KEY)
 * - OpenRouter (via OPENROUTER_API_KEY, fallback for all models)
 */

import { getModel } from "@mariozechner/pi-ai";
export { getFallbackChain } from "./modelFallback.js";

export interface BuildModelConfigOptions {
    modelId: string;
    geminiApiKey?: string;
    openrouterApiKey?: string;
}

// ── Known Model Context Windows ──────────────────────────────────────

export interface ModelSpecs {
    contextWindow: number;
    maxOutputTokens: number;
    provider: "google" | "anthropic" | "openai" | "openrouter";
}

const MODEL_SPECS: Record<string, ModelSpecs> = {
    "gemini-2.5-flash": { contextWindow: 1048576, maxOutputTokens: 65536, provider: "google" },
    "gemini-2.5-flash-lite": { contextWindow: 1048576, maxOutputTokens: 65536, provider: "google" },
    "gemini-2.5-pro": { contextWindow: 1048576, maxOutputTokens: 65536, provider: "google" },
    "claude-opus-4-6": { contextWindow: 200000, maxOutputTokens: 32000, provider: "anthropic" },
    "claude-sonnet-4-6": { contextWindow: 200000, maxOutputTokens: 16000, provider: "anthropic" },
    "claude-haiku-4-5": { contextWindow: 200000, maxOutputTokens: 8192, provider: "anthropic" },
    "gpt-5": { contextWindow: 200000, maxOutputTokens: 32768, provider: "openai" },
    "gpt-4.1-mini": { contextWindow: 1048576, maxOutputTokens: 32768, provider: "openai" },
};

/** Get known specs for a model ID. Returns undefined for unknown models. */
export function getModelSpecs(modelId: string): ModelSpecs | undefined {
    // Try exact match
    if (MODEL_SPECS[modelId]) return MODEL_SPECS[modelId];
    // Try stripping provider prefix
    const bareId = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
    return MODEL_SPECS[bareId];
}

/** Get context window size for a model (defaults to 200K if unknown). */
export function getContextWindow(modelId: string): number {
    return getModelSpecs(modelId)?.contextWindow ?? 200000;
}

/**
 * Returns true if the model ID refers to a Gemini model.
 * Matches bare IDs like "gemini-2.5-flash" and prefixed IDs like "google/gemini-2.5-flash".
 */
function isGeminiModel(modelId: string): boolean {
    return modelId.startsWith("gemini-") || modelId.startsWith("google/gemini-");
}

/** Strip the "google/" prefix from an OpenRouter-style model ID. */
function stripGooglePrefix(modelId: string): string {
    return modelId.startsWith("google/") ? modelId.slice("google/".length) : modelId;
}

/** Ensure an OpenRouter-style "google/" prefix is present. */
function ensureGooglePrefix(modelId: string): string {
    return modelId.startsWith("google/") ? modelId : `google/${modelId}`;
}

/**
 * Build a Pi SDK Model config object from a model ID string.
 *
 * Provider routing:
 *  - Gemini models + GEMINI_API_KEY → Google Generative AI direct
 *  - Gemini models without GEMINI_API_KEY → OpenRouter (auto-prefix google/)
 *  - All other models → OpenRouter
 */
export function buildModelConfig(options: BuildModelConfigOptions): any {
    const { modelId, geminiApiKey, openrouterApiKey } = options;

    // ── Google direct path ──────────────────────────────────────────
    if (isGeminiModel(modelId) && geminiApiKey) {
        const bareId = stripGooglePrefix(modelId);

        // Try the Pi SDK built-in registry first — it has exact specs
        const registryModel = getModel("google", bareId as any);
        if (registryModel) {
            return registryModel;
        }

        // Unknown Gemini model — construct a sensible default
        return {
            id: bareId,
            name: bareId,
            provider: "google",
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            reasoning: bareId.includes("pro") || bareId.includes("thinking"),
            input: ["text", "image"],
            cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1048576,
            maxTokens: 65536,
        };
    }

    // ── OpenRouter path ─────────────────────────────────────────────
    const effectiveId = isGeminiModel(modelId)
        ? ensureGooglePrefix(modelId) // Gemini via OpenRouter needs "google/" prefix
        : modelId;

    // Special handling for Moonshot models with known pricing
    if (effectiveId.startsWith("moonshotai/")) {
        return {
            id: effectiveId,
            name: "Kimi k2.5",
            provider: "openrouter",
            api: "openai-completions",
            baseUrl: "https://openrouter.ai/api/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0.3, output: 0.3, cacheRead: 0.075, cacheWrite: 0.3 },
            contextWindow: 200000,
            maxTokens: 8192,
        };
    }

    // Generic OpenRouter model
    return {
        id: effectiveId,
        name: effectiveId.split("/").pop() || effectiveId,
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: effectiveId.includes("thinking") || effectiveId.includes("reasoning"),
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
    };
}

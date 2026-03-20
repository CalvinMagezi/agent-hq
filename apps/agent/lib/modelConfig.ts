/**
 * Centralized model configuration builder.
 *
 * Detects provider from model ID and available API keys,
 * then builds a Pi SDK Model config object.
 *
 * Supports:
 * - Google Generative AI (via GEMINI_API_KEY)
 * - Anthropic direct (via ANTHROPIC_API_KEY)
 * - OpenRouter (via OPENROUTER_API_KEY, fallback for all models)
 */

export { getFallbackChain } from "./modelFallback.js";

export interface BuildModelConfigOptions {
    modelId: string;
    geminiApiKey?: string;
    anthropicApiKey?: string;
    openrouterApiKey?: string;
    ollamaBaseUrl?: string;
}

// ── Known Model Context Windows ──────────────────────────────────────

export interface ModelSpecs {
    contextWindow: number;
    maxOutputTokens: number;
    provider: "google" | "anthropic" | "openai" | "openrouter" | "ollama";
}

const MODEL_SPECS: Record<string, ModelSpecs> = {
    // ── Gemini 3.x (OAuth free tier — primary target) ────────────────
    "gemini-3-flash-preview": { contextWindow: 1048576, maxOutputTokens: 65536, provider: "google" },
    "gemini-3.1-flash-lite-preview": { contextWindow: 1048576, maxOutputTokens: 65536, provider: "google" },
    "gemini-3.1-pro-preview": { contextWindow: 1048576, maxOutputTokens: 65536, provider: "google" },
    "gemini-3.1-pro-preview-customtools": { contextWindow: 1048576, maxOutputTokens: 65536, provider: "google" },
    // ── Gemini 2.5 (kept for backward compat) ───────────────────────
    "gemini-2.5-flash": { contextWindow: 1048576, maxOutputTokens: 65536, provider: "google" },
    "gemini-2.5-flash-lite": { contextWindow: 1048576, maxOutputTokens: 65536, provider: "google" },
    "gemini-2.5-pro": { contextWindow: 1048576, maxOutputTokens: 65536, provider: "google" },
    "claude-opus-4-6": { contextWindow: 200000, maxOutputTokens: 32000, provider: "anthropic" },
    "claude-sonnet-4-6": { contextWindow: 200000, maxOutputTokens: 16000, provider: "anthropic" },
    "claude-haiku-4-5": { contextWindow: 200000, maxOutputTokens: 8192, provider: "anthropic" },
    "gpt-5": { contextWindow: 200000, maxOutputTokens: 32768, provider: "openai" },
    "gpt-4.1-mini": { contextWindow: 1048576, maxOutputTokens: 32768, provider: "openai" },
    // Ollama local models (free, no API key required)
    "ollama/qwen3.5:9b": { contextWindow: 32768, maxOutputTokens: 4096, provider: "ollama" },
    "ollama/llama3.2:3b": { contextWindow: 32768, maxOutputTokens: 4096, provider: "ollama" },
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

/**
 * Returns true if the model ID refers to a local Ollama model.
 * Matches IDs with "ollama/" prefix.
 */
export function isOllamaModel(modelId: string): boolean {
    return modelId.startsWith("ollama/");
}

/**
 * Returns true if the model ID refers to an Anthropic model.
 * Matches bare IDs like "claude-sonnet-4-6" and prefixed IDs like "anthropic/claude-sonnet-4-6".
 */
export function isAnthropicModel(modelId: string): boolean {
    return modelId.startsWith("claude-") || modelId.startsWith("anthropic/claude-");
}

/** Strip the "anthropic/" prefix from a model ID. */
function stripAnthropicPrefix(modelId: string): string {
    return modelId.startsWith("anthropic/") ? modelId.slice("anthropic/".length) : modelId;
}

/**
 * Check if the local Ollama server is healthy.
 * Returns true if the server responds within 2 seconds.
 */
export async function checkOllamaHealth(baseUrl: string = "http://localhost:11434"): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
        clearTimeout(timeout);
        return res.ok;
    } catch {
        return false;
    }
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
    const { modelId, geminiApiKey, anthropicApiKey, openrouterApiKey, ollamaBaseUrl } = options;

    // ── Ollama local path ───────────────────────────────────────────
    if (isOllamaModel(modelId)) {
        const bareId = modelId.slice("ollama/".length); // e.g. "qwen3.5:9b"
        const base = ollamaBaseUrl ?? "http://localhost:11434";
        return {
            id: bareId,
            name: bareId,
            provider: "openrouter", // OpenAI-compat — Pi SDK treats it like OpenRouter
            api: "openai-completions",
            baseUrl: `${base}/v1`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 4096,
        };
    }

    // ── Google direct path ──────────────────────────────────────────
    if (isGeminiModel(modelId) && geminiApiKey) {
        const bareId = stripGooglePrefix(modelId);
        const specs = getModelSpecs(bareId);
        return {
            id: bareId,
            name: bareId,
            provider: "google",
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            reasoning: bareId.includes("pro") || bareId.includes("thinking"),
            input: ["text", "image"],
            cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
            contextWindow: specs?.contextWindow ?? 1048576,
            maxTokens: specs?.maxOutputTokens ?? 65536,
        };
    }

    // ── Anthropic direct path ──────────────────────────────────────
    if (isAnthropicModel(modelId) && anthropicApiKey) {
        const bareId = stripAnthropicPrefix(modelId);
        const specs = getModelSpecs(bareId);
        return {
            id: bareId,
            name: bareId,
            provider: "anthropic",
            api: "anthropic",
            baseUrl: "https://api.anthropic.com/v1",
            reasoning: bareId.includes("opus"),
            input: ["text", "image"],
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            contextWindow: specs?.contextWindow ?? 200000,
            maxTokens: specs?.maxOutputTokens ?? 16000,
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

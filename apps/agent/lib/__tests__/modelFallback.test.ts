import { describe, test, expect } from "bun:test";
import {
    classifyError,
    getFallbackChain,
    getChainModelIds,
    executeWithFallback,
    serializeFallbackChain,
    deserializeFallbackChain,
} from "../modelFallback";

describe("modelFallback", () => {
    describe("classifyError", () => {
        test("abort: user cancellation", () => {
            expect(classifyError(new Error("Request aborted by user"))).toBe("abort");
            expect(classifyError(new Error("Operation cancelled"))).toBe("abort");
        });

        test("abort: auth errors", () => {
            expect(classifyError(new Error("401 Unauthorized"))).toBe("abort");
            expect(classifyError(new Error("403 Forbidden"))).toBe("abort");
            expect(classifyError(new Error("Invalid API key"))).toBe("abort");
        });

        test("abort: safety violations", () => {
            expect(classifyError(new Error("Content blocked by safety filter"))).toBe("abort");
            expect(classifyError(new Error("content_filter triggered"))).toBe("abort");
        });

        test("abort: context overflow", () => {
            expect(classifyError(new Error("Context too large for model"))).toBe("abort");
            expect(classifyError(new Error("Token limit exceeded in context"))).toBe("abort");
        });

        test("retry: rate limits", () => {
            expect(classifyError(new Error("Rate limit exceeded"))).toBe("retry");
            expect(classifyError(new Error("429 Too Many Requests"))).toBe("retry");
        });

        test("retry: server errors", () => {
            expect(classifyError(new Error("500 Internal Server Error"))).toBe("retry");
            expect(classifyError(new Error("502 Bad Gateway"))).toBe("retry");
            expect(classifyError(new Error("503 Service Unavailable"))).toBe("retry");
            expect(classifyError(new Error("504 Gateway Timeout"))).toBe("retry");
        });

        test("retry: network errors", () => {
            expect(classifyError(new Error("fetch failed: ECONNRESET"))).toBe("retry");
            expect(classifyError(new Error("Network error during request"))).toBe("retry");
        });

        test("retry: capacity errors", () => {
            expect(classifyError(new Error("Model is overloaded"))).toBe("retry");
            expect(classifyError(new Error("No capacity available"))).toBe("retry");
        });

        test("retry: default for unknown errors", () => {
            expect(classifyError(new Error("Something unexpected happened"))).toBe("retry");
        });
    });

    describe("getFallbackChain", () => {
        test("known model returns full chain", () => {
            const chain = getFallbackChain("gemini-2.5-flash");
            expect(chain.primary).toBe("gemini-2.5-flash");
            expect(chain.fallbacks).toContain("claude-sonnet-4-6");
            expect(chain.fallbacks).toContain("gpt-4.1-mini");
            expect(chain.maxRetries).toBe(2);
        });

        test("pro tier models have pro fallbacks", () => {
            const chain = getFallbackChain("claude-opus-4-6");
            expect(chain.primary).toBe("claude-opus-4-6");
            expect(chain.fallbacks).toContain("gemini-3.1-pro-preview");
            expect(chain.fallbacks).toContain("gpt-5");
        });

        test("strips provider prefix", () => {
            const chain = getFallbackChain("google/gemini-2.5-flash");
            expect(chain.primary).toBe("gemini-2.5-flash");
            expect(chain.fallbacks.length).toBeGreaterThan(0);
        });

        test("unknown model returns single-model chain", () => {
            const chain = getFallbackChain("custom-model-xyz");
            expect(chain.primary).toBe("custom-model-xyz");
            expect(chain.fallbacks).toHaveLength(0);
            expect(chain.maxRetries).toBe(0);
        });
    });

    describe("getChainModelIds", () => {
        test("returns all models in order", () => {
            const chain = getFallbackChain("gemini-2.5-flash");
            const ids = getChainModelIds(chain);
            expect(ids[0]).toBe("gemini-2.5-flash");
            expect(ids.length).toBe(3);
        });
    });

    describe("executeWithFallback", () => {
        test("succeeds on first try", async () => {
            const chain = getFallbackChain("gemini-2.5-flash");
            const result = await executeWithFallback(chain, async (modelId) => {
                return `success-${modelId}`;
            });
            expect(result).toBe("success-gemini-2.5-flash");
        });

        test("falls back on transient error", async () => {
            const chain = getFallbackChain("gemini-2.5-flash");
            let attempt = 0;
            const result = await executeWithFallback(chain, async (modelId) => {
                attempt++;
                if (attempt === 1) throw new Error("503 Service Unavailable");
                return `success-${modelId}`;
            });
            expect(result).toBe("success-claude-sonnet-4-6");
            expect(attempt).toBe(2);
        });

        test("aborts immediately on auth error", async () => {
            const chain = getFallbackChain("gemini-2.5-flash");
            let attempt = 0;
            try {
                await executeWithFallback(chain, async () => {
                    attempt++;
                    throw new Error("401 Unauthorized");
                });
                expect(true).toBe(false); // Should not reach here
            } catch (err: any) {
                expect(err.message).toContain("401");
                expect(attempt).toBe(1); // Only tried once
            }
        });

        test("throws last error when all models fail", async () => {
            const chain = getFallbackChain("gemini-2.5-flash");
            let attempt = 0;
            try {
                await executeWithFallback(chain, async () => {
                    attempt++;
                    throw new Error("503 Service Unavailable");
                });
                expect(true).toBe(false);
            } catch (err: any) {
                expect(err.message).toContain("503");
                expect(attempt).toBe(3); // Tried all 3 models
            }
        });

        test("calls onFallback callback", async () => {
            const chain = getFallbackChain("gemini-2.5-flash");
            const fallbacks: Array<{ from: string; to: string }> = [];

            await executeWithFallback(
                chain,
                async (modelId) => {
                    if (modelId === "gemini-2.5-flash") throw new Error("503 overloaded");
                    return "ok";
                },
                (from, to) => {
                    fallbacks.push({ from, to });
                },
            );

            expect(fallbacks).toHaveLength(1);
            expect(fallbacks[0].from).toBe("gemini-2.5-flash");
            expect(fallbacks[0].to).toBe("claude-sonnet-4-6");
        });

        test("single-model chain throws on failure", async () => {
            const chain = getFallbackChain("custom-unknown-model");
            try {
                await executeWithFallback(chain, async () => {
                    throw new Error("503 down");
                });
                expect(true).toBe(false);
            } catch (err: any) {
                expect(err.message).toContain("503");
            }
        });
    });

    describe("serialization", () => {
        test("round-trips correctly", () => {
            const chain = getFallbackChain("gemini-2.5-flash");
            const serialized = serializeFallbackChain(chain);
            expect(serialized).toBe("gemini-2.5-flash|claude-sonnet-4-6|gpt-4.1-mini");

            const deserialized = deserializeFallbackChain(serialized);
            expect(deserialized.primary).toBe("gemini-2.5-flash");
            expect(deserialized.fallbacks).toEqual(["claude-sonnet-4-6", "gpt-4.1-mini"]);
            expect(deserialized.maxRetries).toBe(2);
        });

        test("handles single model", () => {
            const chain = getFallbackChain("custom-xyz");
            const serialized = serializeFallbackChain(chain);
            expect(serialized).toBe("custom-xyz");

            const deserialized = deserializeFallbackChain(serialized);
            expect(deserialized.primary).toBe("custom-xyz");
            expect(deserialized.fallbacks).toHaveLength(0);
        });
    });
});

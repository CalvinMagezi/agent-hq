/**
 * SBLU Client
 *
 * Generic client for calling any SBLU via Ollama, with:
 * - Trust-level-based routing (shadow / canary / majority / primary)
 * - Circuit breaker per SBLU
 * - Structured JSON output parsing
 * - Fallback to baseline on any failure
 *
 * Usage:
 *   const client = new SBLUClient(vaultPath);
 *   const result = await client.call("cartographer", prompt, systemPrompt, baselineFn);
 */

import { SBLURegistry } from "./sbluRegistry.js";
import { getBreakerForSBLU } from "./circuitBreaker.js";
import type { TrustLevel } from "./sbluRegistry.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export interface SBLUCallOptions {
    /** Max tokens in the SBLU response. Default: 1024 */
    maxTokens?: number;
    /** Timeout in ms. Default: 30_000 */
    timeoutMs?: number;
    /** If true, parse response as JSON. Default: true */
    parseJson?: boolean;
}

export type BaselineFn<T> = () => Promise<T>;

export interface SBLUCallResult<T> {
    output: T;
    /** Which path was taken */
    source: "sblu" | "baseline";
    /** True if SBLU ran in shadow mode (output not used in production) */
    shadowRun: boolean;
    /** Similarity between SBLU and baseline outputs (0–1), if both ran */
    similarity?: number;
    model?: string;
}

export class SBLUClient {
    private registry: SBLURegistry;

    constructor(vaultPath: string) {
        this.registry = new SBLURegistry(vaultPath);
    }

    /**
     * Call an SBLU with trust-level routing.
     *
     * @param sbluName   Kebab-case SBLU name (e.g. "cartographer")
     * @param prompt     User-facing prompt for the SBLU
     * @param systemPrompt  System instruction for the SBLU
     * @param baselineFn Deterministic fallback — called when SBLU is unavailable or in shadow/canary
     * @param options    Call options
     */
    async call<T>(
        sbluName: string,
        prompt: string,
        systemPrompt: string,
        baselineFn: BaselineFn<T>,
        options: SBLUCallOptions = {},
    ): Promise<SBLUCallResult<T>> {
        const entry = this.registry.read(sbluName);
        const breaker = getBreakerForSBLU(sbluName);
        const maxTokens = options.maxTokens ?? 1024;
        const timeoutMs = options.timeoutMs ?? 30_000;
        const parseJson = options.parseJson ?? true;

        // ── Trust level 0: baseline only ─────────────────────────────
        if (!entry || entry.trustLevel === 0) {
            const output = await baselineFn();
            return { output, source: "baseline", shadowRun: false };
        }

        const model = entry.model ?? entry.baseModel;
        const trustLevel = entry.trustLevel as TrustLevel;

        // ── Determine if SBLU should run this request ─────────────────
        const shouldUseSBLU = this.shouldUseSBLU(trustLevel);

        // ── Trust level 1: shadow (SBLU runs but output not used) ─────
        if (trustLevel === 1) {
            const [baselineOutput, sbluOutput] = await Promise.allSettled([
                baselineFn(),
                this.callOllama(model, prompt, systemPrompt, maxTokens, timeoutMs, parseJson),
            ]);

            const baseline = baselineOutput.status === "fulfilled" ? baselineOutput.value : null;
            if (sbluOutput.status === "fulfilled" && sbluOutput.value !== null) {
                // Compute similarity and store as preference pair for later DPO
                const similarity = computeOutputSimilarity(baseline, sbluOutput.value);
                this.registry.recordRun(sbluName, { shadowRun: true, qualityScore: similarity });
                breaker.recordSuccess();
                console.log(
                    `[sblu:${sbluName}] Shadow run — similarity=${similarity.toFixed(3)} model=${model}`,
                );
                // Check for auto-promotion to canary
                this.maybeAutoPromote(sbluName);
            } else {
                this.registry.recordRun(sbluName, { shadowRun: true, error: true });
                breaker.recordFailure();
                this.syncCircuitState(sbluName, breaker);
            }

            // Shadow mode always returns baseline
            return {
                output: baseline as T,
                source: "baseline",
                shadowRun: true,
                similarity: sbluOutput.status === "fulfilled"
                    ? computeOutputSimilarity(baseline, sbluOutput.value)
                    : undefined,
                model,
            };
        }

        // ── Trust levels 2–4: production routing ──────────────────────
        if (shouldUseSBLU && breaker.shouldRoute()) {
            try {
                const sbluOutput = await this.callOllama(
                    model, prompt, systemPrompt, maxTokens, timeoutMs, parseJson,
                );
                if (sbluOutput !== null) {
                    breaker.recordSuccess();
                    this.registry.recordRun(sbluName, {
                        canaryRun: trustLevel === 2,
                        error: false,
                    });
                    this.syncCircuitState(sbluName, breaker);
                    return { output: sbluOutput as T, source: "sblu", shadowRun: false, model };
                }
            } catch (err) {
                console.warn(`[sblu:${sbluName}] Call failed, routing to baseline:`, err);
                breaker.recordFailure();
                this.registry.recordRun(sbluName, { error: true });
                this.syncCircuitState(sbluName, breaker);
            }
        }

        // Fall through to baseline
        const output = await baselineFn();
        return { output, source: "baseline", shadowRun: false };
    }

    // ── Private ──────────────────────────────────────────────────────────

    /** Returns true if this call should be routed to the SBLU based on trust level */
    private shouldUseSBLU(trustLevel: TrustLevel): boolean {
        if (trustLevel <= 1) return false;
        if (trustLevel === 2) return Math.random() < 0.05; // 5% canary
        if (trustLevel === 3) return Math.random() < 0.70; // 70% majority
        return true; // trustLevel 4+ = primary
    }

    /** Call Ollama and return parsed response */
    private async callOllama<T>(
        model: string,
        prompt: string,
        systemPrompt: string,
        maxTokens: number,
        timeoutMs: number,
        parseJson: boolean,
    ): Promise<T | null> {
        const body = {
            model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt },
            ],
            max_tokens: maxTokens,
            stream: false,
            ...(parseJson ? { format: "json" } : {}),
        };

        const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
            throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
        }

        const data = (await res.json()) as {
            choices: Array<{ message: { content: string } }>;
        };
        const content = data.choices[0]?.message?.content;
        if (!content) return null;

        if (!parseJson) return content as T;

        try {
            return JSON.parse(content) as T;
        } catch {
            // Try to extract JSON from wrapped response
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]) as T;
            }
            throw new Error(`SBLU returned non-JSON: ${content.substring(0, 200)}`);
        }
    }

    /**
     * Auto-promote an SBLU to the next trust level if promotion criteria are met.
     * Promotion criteria (from SBLU plan):
     *   shadow → canary:   10+ shadow runs, qualityScore >= 0.85, circuit CLOSED, model trained
     *   canary → majority: 72h of canary, errorRate7d < 2%, qualityScore >= 0.85
     *   majority → primary: 7 days of majority, same criteria
     *
     * Auto-demotion is handled separately by the circuit breaker.
     */
    private maybeAutoPromote(sbluName: string): void {
        const entry = this.registry.read(sbluName);
        if (!entry) return;

        const currentLevel = entry.trustLevel;

        // shadow (1) → canary (2): need fine-tuned model + quality threshold
        if (currentLevel === 1) {
            const modelIsTrained = entry.model !== null && entry.trainedAt !== null;
            const enoughRuns = entry.shadowRunCount >= 10;
            const qualityOk = entry.qualityScore !== null && entry.qualityScore >= 0.85;
            const circuitOk = entry.circuitState === "CLOSED";

            if (modelIsTrained && enoughRuns && qualityOk && circuitOk) {
                const result = this.registry.promote(sbluName);
                if (result.promoted) {
                    console.log(`[sblu:${sbluName}] AUTO-PROMOTED shadow → canary (quality=${entry.qualityScore?.toFixed(3)})`);
                }
            }
        }

        // canary (2) → majority (3): requires errorRate7d tracked by auditor
        // majority (3) → primary (4): same — these happen via the auditor's weekly review
        // (not in shadow loop — tracked over days, not per-call)
    }

    /** Keep registry circuit state in sync with in-memory breaker */
    private syncCircuitState(
        sbluName: string,
        breaker: ReturnType<typeof getBreakerForSBLU>,
    ): void {
        const state = breaker.getState();
        this.registry.setCircuitState(sbluName, state);
    }
}

// ── Similarity Heuristic ──────────────────────────────────────────────

/**
 * Rough similarity between two outputs (0–1).
 * For JSON objects: intersection of keys / union of keys (Jaccard-like).
 * For arrays: overlap ratio.
 * For primitives: exact match = 1, else 0.
 */
function computeOutputSimilarity(a: unknown, b: unknown): number {
    if (a === null || b === null) return 0;
    if (JSON.stringify(a) === JSON.stringify(b)) return 1.0;

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length === 0 && b.length === 0) return 1.0;
        if (a.length === 0 || b.length === 0) return 0;
        // Count items from b that also appear in a (by stringified value)
        const aSet = new Set(a.map(x => JSON.stringify(x)));
        const overlap = b.filter(x => aSet.has(JSON.stringify(x))).length;
        return overlap / Math.max(a.length, b.length);
    }

    if (typeof a === "object" && typeof b === "object") {
        const aKeys = new Set(Object.keys(a as object));
        const bKeys = Object.keys(b as object);
        if (aKeys.size === 0 && bKeys.length === 0) return 1.0;
        const intersection = bKeys.filter(k => aKeys.has(k)).length;
        const union = new Set([...aKeys, ...bKeys]).size;
        return union > 0 ? intersection / union : 0;
    }

    return 0;
}

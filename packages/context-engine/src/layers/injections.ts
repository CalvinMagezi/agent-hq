/**
 * Injections Layer — Assembles contextual injections from vault data.
 *
 * Sources (in priority order):
 * 1. Reply-to context (highest score: 1.0)
 * 2. Pinned notes (score: 0.85)
 * 3. Semantic search results (score: 0.6)
 * 4. Extra injections from caller (score: 0.7)
 *
 * When injections exceed budget, lowest-scored items are pruned.
 */

import type {
    VaultClientLike,
    ContextInjection,
    CompactionEvent,
} from "../types.js";
import { truncateToTokens } from "../tokenizer/counter.js";

export interface InjectionsLayerInput {
    vault: VaultClientLike;
    userMessage: string;
    replyTo?: string;
    extraInjections?: Omit<ContextInjection, "tokens" | "score">[];
    allocation: number;
    maxInjections: number;
    maxChunkTokens: number;
    count: (text: string) => number;
}

export interface InjectionsLayerOutput {
    injections: ContextInjection[];
    tokens: number;
    chunkIndexHits: number;
    compacted: boolean;
    compactionEvents: CompactionEvent[];
}

/**
 * Assemble all injections within the given token budget.
 */
export async function assembleInjectionsLayer(
    input: InjectionsLayerInput
): Promise<InjectionsLayerOutput> {
    const {
        vault,
        userMessage,
        replyTo,
        extraInjections,
        allocation,
        maxInjections,
        maxChunkTokens,
        count,
    } = input;

    const injections: ContextInjection[] = [];
    const compactionEvents: CompactionEvent[] = [];
    let totalTokens = 0;
    let compacted = false;
    let chunkIndexHits = 0;

    // 1. Reply-to context (highest priority)
    if (replyTo) {
        const replyTokens = count(replyTo);
        injections.push({
            source: "reply_to",
            label: "Replying to",
            content: replyTo,
            tokens: replyTokens,
            score: 1.0,
        });
        totalTokens += replyTokens;
    }

    // 2. Pinned notes
    const ctx = await vault.getAgentContext();
    if (ctx.pinnedNotes?.length) {
        for (const note of ctx.pinnedNotes.slice(0, 3)) {
            if (injections.length >= maxInjections) break;
            if (totalTokens >= allocation) break;

            const chunk = note.content.slice(0, 1200); // Rough pre-trim
            let tokens = count(chunk);
            let content = chunk;

            if (tokens > maxChunkTokens) {
                const result = truncateToTokens(chunk, maxChunkTokens, count);
                content = result.text;
                tokens = count(content);
                compacted = true;
            }

            injections.push({
                source: "pinned_note",
                label: note.title,
                content: `[${note.title}]: ${content}`,
                tokens,
                score: 0.85,
            });
            totalTokens += tokens;
        }
    }

    // 3. Semantic search results
    try {
        const searchResults = await vault.searchNotes(userMessage, 5);
        chunkIndexHits = searchResults.length;

        for (const result of searchResults) {
            if (injections.length >= maxInjections) break;
            if (totalTokens >= allocation) break;

            // Skip duplicates from pinned notes
            if (injections.some((i) => i.label === result.title)) continue;

            let content = result.content.slice(0, 800);
            let tokens = count(content);

            if (tokens > maxChunkTokens) {
                const truncResult = truncateToTokens(content, maxChunkTokens, count);
                content = truncResult.text;
                tokens = count(content);
                compacted = true;
            }

            const notebook = result.notebook ? ` (${result.notebook})` : "";
            injections.push({
                source: "search_result",
                label: `${result.title}${notebook}`,
                content: `[${result.title}${notebook}]: ${content}`,
                tokens,
                score: 0.6,
            });
            totalTokens += tokens;
        }
    } catch {
        // Search may fail — non-critical
    }

    // 4. Extra injections from caller
    if (extraInjections?.length) {
        for (const extra of extraInjections) {
            if (injections.length >= maxInjections) break;
            if (totalTokens >= allocation) break;

            const tokens = count(extra.content);
            injections.push({
                ...extra,
                tokens,
                score: 0.7,
            });
            totalTokens += tokens;
        }
    }

    // Budget enforcement — prune lowest-scored if over budget
    if (totalTokens > allocation) {
        injections.sort((a, b) => b.score - a.score);
        let running = 0;
        const kept: ContextInjection[] = [];

        for (const inj of injections) {
            if (running + inj.tokens <= allocation) {
                kept.push(inj);
                running += inj.tokens;
            }
        }

        const pruned = injections.length - kept.length;
        if (pruned > 0) {
            compactionEvents.push({
                layer: "injections",
                strategy: "prune",
                tokensBefore: totalTokens,
                tokensAfter: running,
            });
            compacted = true;
        }

        injections.length = 0;
        injections.push(...kept);
        totalTokens = running;
    }

    return { injections, tokens: totalTokens, chunkIndexHits, compacted, compactionEvents };
}

/**
 * Memory Layer — Assembles memory + preferences with fact-level granularity.
 *
 * Pulls MEMORY.md, PREFERENCES.md, and structured facts/goals from the vault.
 * When the memory exceeds its budget, oldest facts are pruned first.
 */

import type { VaultClientLike, CompactionEvent } from "../types.js";
import { truncateToTokens } from "../tokenizer/counter.js";

export interface MemoryLayerInput {
    vault: VaultClientLike;
    allocation: number;
    count: (text: string) => number;
    /** Optional: live memory querier from @repo/vault-memory */
    liveMemory?: { formatted: string };
}

export interface MemoryLayerOutput {
    memory: string;
    tokens: number;
    compacted: boolean;
    compactionEvents: CompactionEvent[];
}

/**
 * Assemble the memory layer from vault data.
 */
export async function assembleMemoryLayer(
    input: MemoryLayerInput
): Promise<MemoryLayerOutput> {
    const { vault, allocation, count } = input;
    const compactionEvents: CompactionEvent[] = [];

    const ctx = await vault.getAgentContext();
    const parts: string[] = [];

    if (ctx.memory) parts.push(ctx.memory);
    if (ctx.preferences) parts.push(ctx.preferences);

    // Live memory from vault-memory (Ollama-consolidated cross-harness insights)
    if (input.liveMemory?.formatted) {
        parts.push(input.liveMemory.formatted);
    }

    // Add structured facts/goals if available
    if (vault.getMemoryFacts) {
        try {
            const facts = await vault.getMemoryFacts();
            const factLines = facts
                .filter((f) => f.type === "fact")
                .map((f) => `- ${f.content}`);
            const goalLines = facts
                .filter((f) => f.type === "goal")
                .map((f) => {
                    const deadline = f.deadline ? ` (by ${f.deadline})` : "";
                    return `- ${f.content}${deadline}`;
                });

            if (factLines.length) parts.push("Facts:\n" + factLines.join("\n"));
            if (goalLines.length) parts.push("Goals:\n" + goalLines.join("\n"));
        } catch {
            // getMemoryFacts may not be implemented
        }
    }

    let memory = parts.join("\n\n");
    let tokens = count(memory);
    let compacted = false;

    if (tokens > allocation) {
        const originalTokens = tokens;
        const result = truncateToTokens(memory, allocation, count);
        memory = result.text;
        tokens = count(memory);
        compacted = result.truncated;
        if (result.truncated) {
            compactionEvents.push({
                layer: "memory",
                strategy: "truncate",
                tokensBefore: originalTokens,
                tokensAfter: tokens,
            });
        }
    }

    return { memory, tokens, compacted, compactionEvents };
}

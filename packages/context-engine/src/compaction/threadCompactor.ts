/**
 * Thread Compactor — Summarization strategies for thread history.
 *
 * Implements the spec's multi-tier compaction:
 * 1. LLM-backed summarization (if summarizer provided)
 * 2. Extractive fallback (first/last sentence per turn)
 * 3. Key-fact extraction ([REMEMBER:] and [GOAL:] tags)
 */

import type { SummarizerFn } from "../types.js";
import { truncateToTokens } from "../tokenizer/counter.js";

/**
 * Extract key facts ([REMEMBER:] and [GOAL:] tags) from text.
 * These facts are promoted to the memory layer.
 */
export function extractKeyFacts(
    text: string
): Array<{ type: "fact" | "goal"; content: string }> {
    const facts: Array<{ type: "fact" | "goal"; content: string }> = [];
    const lines = text.split("\n");

    for (const line of lines) {
        const rememberMatch = line.match(/\[REMEMBER:\s*(.+?)\]/i);
        if (rememberMatch) {
            facts.push({ type: "fact", content: rememberMatch[1].trim() });
        }

        const goalMatch = line.match(/\[GOAL:\s*(.+?)\]/i);
        if (goalMatch) {
            facts.push({ type: "goal", content: goalMatch[1].trim() });
        }
    }

    return facts;
}

/**
 * Extractive summarization fallback.
 * Takes the first and last sentence of each turn's content.
 */
export function extractiveSummarize(text: string, maxTokens: number, count: (s: string) => number): string {
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    if (lines.length <= 4) {
        // Short enough — try to fit as-is
        const result = truncateToTokens(text, maxTokens, count);
        return result.text;
    }

    // Take first 2 and last 2 lines
    const summary = [
        ...lines.slice(0, 2),
        `  ... (${lines.length - 4} messages condensed) ...`,
        ...lines.slice(-2),
    ].join("\n");

    if (count(summary) <= maxTokens) {
        return summary;
    }

    return truncateToTokens(summary, maxTokens, count).text;
}

/**
 * Compact thread text using the best available method.
 */
export async function compactThread(
    text: string,
    maxTokens: number,
    count: (s: string) => number,
    summarizer?: SummarizerFn
): Promise<{ text: string; method: "summarize" | "truncate" }> {
    // Try LLM summarizer first
    if (summarizer && maxTokens >= 100) {
        try {
            const summary = await summarizer(text, maxTokens);
            return { text: summary, method: "summarize" };
        } catch {
            // Fall through to extractive
        }
    }

    // Extractive fallback
    const summary = extractiveSummarize(text, maxTokens, count);
    return { text: summary, method: "truncate" };
}

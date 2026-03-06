/**
 * Thread Layer — Conversation history with compaction.
 *
 * Implements the spec's thread compaction pipeline:
 * 1. Recency window — last N turns at full fidelity
 * 2. Summary band — older turns summarized (LLM or extractive fallback)
 * 3. Drop — if still over budget, older segments dropped with marker
 */

import type {
    VaultClientLike,
    ConversationTurn,
    CompactionEvent,
    SummarizerFn,
} from "../types.js";
import { truncateToTokens } from "../tokenizer/counter.js";

export interface ThreadLayerInput {
    vault: VaultClientLike;
    threadId?: string;
    channelId?: string;
    allocation: number;
    recencyWindow: number;
    count: (text: string) => number;
    summarizer?: SummarizerFn;
}

export interface ThreadLayerOutput {
    turns: ConversationTurn[];
    tokens: number;
    turnsSummarized: number;
    compacted: boolean;
    compactionEvents: CompactionEvent[];
}

/**
 * Assemble the thread layer from recent conversation history.
 */
export async function assembleThreadLayer(
    input: ThreadLayerInput
): Promise<ThreadLayerOutput> {
    const {
        vault,
        threadId,
        channelId,
        allocation,
        recencyWindow,
        count,
        summarizer,
    } = input;

    const turns: ConversationTurn[] = [];
    const compactionEvents: CompactionEvent[] = [];
    let turnsSummarized = 0;
    let compacted = false;

    const id = threadId ?? channelId;
    if (!id || !vault.getRecentMessages) {
        return { turns, tokens: 0, turnsSummarized: 0, compacted: false, compactionEvents };
    }

    let rawTurns: Array<{
        role: "user" | "assistant";
        content: string;
        timestamp?: string;
    }>;

    try {
        rawTurns = await vault.getRecentMessages(id, 30);
    } catch {
        return { turns, tokens: 0, turnsSummarized: 0, compacted: false, compactionEvents };
    }

    if (rawTurns.length === 0) {
        return { turns, tokens: 0, turnsSummarized: 0, compacted: false, compactionEvents };
    }

    // Split into recency window and older turns
    const recentTurns = rawTurns.slice(-recencyWindow);
    const olderTurns = rawTurns.slice(0, -recencyWindow);

    // Process older turns with compaction
    if (olderTurns.length > 0) {
        const olderText = olderTurns
            .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
            .join("\n");
        const olderTokens = count(olderText);

        // Budget for older turns = total allocation minus recent turns' tokens
        const recentTokens = recentTurns.reduce(
            (sum, t) => sum + count(t.content) + 10, // +10 for role prefix overhead
            0
        );
        const olderBudget = Math.max(0, allocation - recentTokens);

        if (olderTokens > olderBudget && olderBudget > 50) {
            // Compact older turns
            let compactedText: string;

            if (summarizer && olderBudget >= 100) {
                try {
                    compactedText = await summarizer(olderText, olderBudget);
                } catch {
                    compactedText = truncateToTokens(olderText, olderBudget, count).text;
                }
            } else {
                compactedText = truncateToTokens(olderText, olderBudget, count).text;
            }

            turns.push({
                role: "assistant",
                content: `[Earlier conversation summary]\n${compactedText}`,
                tokens: count(compactedText),
                compacted: true,
            });

            turnsSummarized = olderTurns.length;
            compacted = true;

            compactionEvents.push({
                layer: "thread",
                strategy: summarizer ? "summarize" : "truncate",
                tokensBefore: olderTokens,
                tokensAfter: count(compactedText),
            });
        } else if (olderBudget <= 50 && olderTurns.length > 0) {
            // Not enough budget — drop older turns
            turns.push({
                role: "assistant",
                content: `[... ${olderTurns.length} earlier messages omitted ...]`,
                tokens: 15,
                compacted: true,
            });
            turnsSummarized = olderTurns.length;
            compacted = true;

            compactionEvents.push({
                layer: "thread",
                strategy: "drop",
                tokensBefore: olderTokens,
                tokensAfter: 15,
            });
        } else {
            // Older turns fit within budget — include at full fidelity
            for (const t of olderTurns) {
                turns.push({
                    role: t.role,
                    content: t.content,
                    tokens: count(t.content),
                    compacted: false,
                    timestamp: t.timestamp,
                });
            }
        }
    }

    // Recent turns: always at full fidelity
    for (const t of recentTurns) {
        turns.push({
            role: t.role,
            content: t.content,
            tokens: count(t.content),
            compacted: false,
            timestamp: t.timestamp,
        });
    }

    const totalTokens = turns.reduce((sum, t) => sum + t.tokens, 0);
    return { turns, tokens: totalTokens, turnsSummarized, compacted, compactionEvents };
}

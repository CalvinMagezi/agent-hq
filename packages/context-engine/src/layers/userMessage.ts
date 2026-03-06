/**
 * User Message Layer — Current turn processing.
 *
 * Handles the user's current message with token-aware truncation.
 * This is the simplest layer — rarely needs compaction since user
 * messages are typically short.
 */

import type { CompactionEvent } from "../types.js";
import { truncateToTokens } from "../tokenizer/counter.js";

export interface UserMessageLayerInput {
    userMessage: string;
    allocation: number;
    count: (text: string) => number;
}

export interface UserMessageLayerOutput {
    userMessage: string;
    tokens: number;
    compactionEvents: CompactionEvent[];
}

/**
 * Process the user message, truncating if it exceeds budget.
 */
export function assembleUserMessageLayer(
    input: UserMessageLayerInput
): UserMessageLayerOutput {
    const { allocation, count } = input;
    const compactionEvents: CompactionEvent[] = [];

    let userMessage = input.userMessage;
    let tokens = count(userMessage);

    if (tokens > allocation) {
        const originalTokens = tokens;
        const result = truncateToTokens(userMessage, allocation, count);
        userMessage = result.text;
        tokens = count(userMessage);
        if (result.truncated) {
            compactionEvents.push({
                layer: "userMessage",
                strategy: "truncate",
                tokensBefore: originalTokens,
                tokensAfter: tokens,
            });
        }
    }

    return { userMessage, tokens, compactionEvents };
}

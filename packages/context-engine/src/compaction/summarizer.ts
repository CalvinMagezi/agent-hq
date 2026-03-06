/**
 * Summarizer — LLM-backed summarization abstraction.
 *
 * The engine accepts a SummarizerFn callback so the host app
 * controls which LLM provider does the summarization.
 * This module provides the extractive fallback used when no
 * LLM summarizer is configured.
 */

import type { SummarizerFn } from "../types.js";

/**
 * Create an extractive summarizer (no LLM required).
 * Takes the first sentence of each paragraph.
 */
export function createExtractiveSummarizer(): SummarizerFn {
    return async (text: string, maxTokens: number): Promise<string> => {
        const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
        const sentences: string[] = [];

        for (const para of paragraphs) {
            // Extract first sentence
            const sentenceMatch = para.match(/^[^.!?]*[.!?]/);
            if (sentenceMatch) {
                sentences.push(sentenceMatch[0].trim());
            } else {
                // No sentence boundary — take first 100 chars
                sentences.push(para.slice(0, 100).trim());
            }
        }

        let summary = sentences.join(" ");

        // Rough token estimate — trim if over budget
        const estimatedTokens = Math.ceil(summary.length / 3.5);
        if (estimatedTokens > maxTokens) {
            const ratio = maxTokens / estimatedTokens;
            const cutPoint = Math.floor(summary.length * ratio);
            summary = summary.slice(0, cutPoint).trimEnd() + "...";
        }

        return summary;
    };
}

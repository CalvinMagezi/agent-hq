/**
 * Chunk Truncator — Token-aware text truncation utilities.
 *
 * Re-exports the core truncation from tokenizer/counter.ts
 * and adds chunk-specific truncation helpers.
 */

export { truncateToTokens } from "../tokenizer/counter.js";

/**
 * Truncate a content chunk to a maximum token count,
 * preserving sentence boundaries when possible.
 */
export function truncateChunk(
    content: string,
    maxTokens: number,
    count: (s: string) => number
): { text: string; truncated: boolean; tokens: number } {
    const currentTokens = count(content);
    if (currentTokens <= maxTokens) {
        return { text: content, truncated: false, tokens: currentTokens };
    }

    // Try to cut at sentence boundary
    const ratio = maxTokens / currentTokens;
    let cutPoint = Math.floor(content.length * ratio);

    // Look for sentence-ending punctuation near the cut point
    const sentenceEnd = content.lastIndexOf(". ", cutPoint);
    if (sentenceEnd > cutPoint * 0.7) {
        cutPoint = sentenceEnd + 1;
    }

    const truncated = content.slice(0, cutPoint).trimEnd() + " ...";
    const tokens = count(truncated);

    return { text: truncated, truncated: true, tokens };
}

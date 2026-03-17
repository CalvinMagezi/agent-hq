/**
 * Chunk Index — Note chunking and scoring for precise context injection.
 *
 * Splits vault notes into semantic chunks (~200 tokens each) and scores
 * them by relevance, recency, pin status, and tag overlap.
 *
 * Scoring formula:
 *   score = (relevance × 0.5) + (recency × 0.2) + (pin_boost × 0.2) + (tag_match × 0.1)
 *
 * Phase 4 implementation — uses in-memory index (SQLite integration deferred
 * until VaultSync integration is complete).
 */

import type { NoteChunk, ScoredChunk } from "../types.js";

const DEFAULT_CHUNK_SIZE = 200; // tokens per chunk

/**
 * Split a note into semantic chunks at paragraph boundaries.
 */
export function chunkNote(
    noteId: string,
    content: string,
    tags: string[],
    pinned: boolean,
    modifiedAt: string,
    count: (text: string) => number,
    targetChunkSize = DEFAULT_CHUNK_SIZE
): NoteChunk[] {
    if (!content.trim()) return [];

    const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0);
    const chunks: NoteChunk[] = [];
    let currentChunk = "";
    let chunkIndex = 0;

    for (const para of paragraphs) {
        const paraTokens = count(para);

        if (currentChunk && count(currentChunk + "\n\n" + para) > targetChunkSize) {
            // Current chunk is full — emit it
            chunks.push({
                noteId,
                chunkIndex: chunkIndex++,
                text: currentChunk.trim(),
                tokens: count(currentChunk.trim()),
                tags,
                modifiedAt,
                pinned,
            });
            currentChunk = para;
        } else if (paraTokens > targetChunkSize) {
            // Single paragraph exceeds chunk size — force-split
            if (currentChunk) {
                chunks.push({
                    noteId,
                    chunkIndex: chunkIndex++,
                    text: currentChunk.trim(),
                    tokens: count(currentChunk.trim()),
                    tags,
                    modifiedAt,
                    pinned,
                });
                currentChunk = "";
            }
            chunks.push({
                noteId,
                chunkIndex: chunkIndex++,
                text: para.trim(),
                tokens: paraTokens,
                tags,
                modifiedAt,
                pinned,
            });
        } else {
            currentChunk = currentChunk ? currentChunk + "\n\n" + para : para;
        }
    }

    // Emit remaining content
    if (currentChunk.trim()) {
        chunks.push({
            noteId,
            chunkIndex: chunkIndex++,
            text: currentChunk.trim(),
            tokens: count(currentChunk.trim()),
            tags,
            modifiedAt,
            pinned,
        });
    }

    return chunks;
}

/**
 * Score chunks against a query and conversation tags.
 */
export function scoreChunks(
    chunks: NoteChunk[],
    query: string,
    conversationTags: string[],
    now = new Date()
): ScoredChunk[] {
    const queryTerms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);

    return chunks.map((chunk) => {
        // Relevance: simple term overlap (FTS5 replacement for in-memory)
        const chunkLower = chunk.text.toLowerCase();
        const matchingTerms = queryTerms.filter((term) => chunkLower.includes(term));
        const relevance = queryTerms.length > 0 ? matchingTerms.length / queryTerms.length : 0;

        // Recency: exponential decay (half-life = 7 days)
        const ageMs = now.getTime() - new Date(chunk.modifiedAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recency = Math.exp(-ageDays / 7);

        // Pin boost
        const pinBoost = chunk.pinned ? 1.0 : 0.0;

        // Tag match
        const tagMatch =
            conversationTags.length > 0 && chunk.tags.length > 0
                ? chunk.tags.filter((t) =>
                    conversationTags.some((ct) => ct.toLowerCase() === t.toLowerCase())
                ).length / Math.max(conversationTags.length, 1)
                : 0;

        // Composite score
        const score =
            relevance * 0.5 + recency * 0.2 + pinBoost * 0.2 + tagMatch * 0.1;

        return { ...chunk, score };
    });
}

/**
 * Simple in-memory chunk index.
 * SQLite persistence deferred to Phase 4 VaultSync integration.
 */
export class ChunkIndex {
    private chunks: Map<string, NoteChunk[]> = new Map();

    /**
     * Index (or re-index) a note's chunks.
     */
    index(
        noteId: string,
        content: string,
        tags: string[],
        pinned: boolean,
        modifiedAt: string,
        count: (text: string) => number
    ): void {
        const noteChunks = chunkNote(noteId, content, tags, pinned, modifiedAt, count);
        this.chunks.set(noteId, noteChunks);
    }

    /**
     * Remove a note from the index.
     */
    remove(noteId: string): void {
        this.chunks.delete(noteId);
    }

    /**
     * Query the index and return top-K scored chunks.
     * When metadataOnly is true, chunk text is replaced with the first sentence
     * (progressive disclosure tier-1). Callers can expand via the full query later.
     */
    query(
        queryText: string,
        conversationTags: string[],
        topK: number,
        metadataOnly = false
    ): ScoredChunk[] {
        const allChunks = Array.from(this.chunks.values()).flat();
        const scored = scoreChunks(allChunks, queryText, conversationTags);
        scored.sort((a, b) => b.score - a.score);
        const results = scored.slice(0, topK);

        if (metadataOnly) {
            return results.map((chunk) => {
                const firstSentence = extractFirstSentence(chunk.text);
                return {
                    ...chunk,
                    text: firstSentence,
                    tokens: Math.ceil(firstSentence.length / 3.5),
                };
            });
        }

        return results;
    }

    /** Total number of indexed notes */
    get noteCount(): number {
        return this.chunks.size;
    }

    /** Total number of chunks across all notes */
    get chunkCount(): number {
        return Array.from(this.chunks.values()).reduce((sum, c) => sum + c.length, 0);
    }
}

/**
 * Extract the first sentence from a chunk for progressive disclosure.
 * Falls back to the first 80 characters if no sentence boundary is found.
 */
function extractFirstSentence(text: string): string {
    const match = text.match(/^[^.!?]*[.!?]/);
    if (match && match[0].length <= 200) return match[0].trim();
    // No sentence boundary — take first 80 chars
    return text.length > 80 ? text.slice(0, 80) + "..." : text;
}

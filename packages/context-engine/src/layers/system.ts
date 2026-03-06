/**
 * System Layer — Assembles the system prompt from soul + harness instructions.
 *
 * The system layer is the highest-priority content layer (after response reserve).
 * It always gets its full allocation; if it happens to underspend, the surplus
 * cascades to lower-priority layers.
 */

import type { VaultClientLike, CompactionEvent } from "../types.js";
import { truncateToTokens } from "../tokenizer/counter.js";

export interface SystemLayerInput {
    vault: VaultClientLike;
    harnessHint?: string;
    allocation: number;
    count: (text: string) => number;
}

export interface SystemLayerOutput {
    system: string;
    tokens: number;
    compactionEvents: CompactionEvent[];
}

/**
 * Build the system prompt from vault context and harness hint.
 */
export async function assembleSystemLayer(
    input: SystemLayerInput
): Promise<SystemLayerOutput> {
    const { vault, harnessHint, allocation, count } = input;
    const compactionEvents: CompactionEvent[] = [];

    const ctx = await vault.getAgentContext();
    const parts: string[] = [];

    if (ctx.soul) parts.push(ctx.soul);

    // Add harness-specific instructions
    if (harnessHint) {
        const instructions = buildHarnessInstructions(harnessHint);
        if (instructions) parts.push(instructions);
    }

    let system = parts.join("\n\n");
    let tokens = count(system);

    if (tokens > allocation) {
        const result = truncateToTokens(system, allocation, count);
        const originalTokens = tokens;
        system = result.text;
        tokens = count(system);
        if (result.truncated) {
            compactionEvents.push({
                layer: "system",
                strategy: "truncate",
                tokensBefore: originalTokens,
                tokensAfter: tokens,
            });
        }
    }

    return { system, tokens, compactionEvents };
}

/**
 * Build harness-specific system instructions based on the harness hint.
 */
export function buildHarnessInstructions(harnessHint: string): string {
    switch (harnessHint) {
        case "gemini-cli":
            return (
                "You are a Google Workspace specialist. " +
                "Primary role: managing Google Docs, Sheets, Drive, Gmail, Calendar. " +
                "Also excel at research, analysis, and summarization."
            );
        case "opencode":
            return (
                "You are a multi-model coding assistant. " +
                "Specialize in code generation, model comparison, and file operations."
            );
        case "claude-code":
            return (
                "You are a personal AI assistant. " +
                "Specialize in code editing, git operations, debugging, and complex refactoring."
            );
        case "discord":
            return (
                "You are a personal AI assistant responding via Discord. " +
                "Keep responses concise and conversational. Use Discord-compatible markdown."
            );
        case "whatsapp":
            return (
                "You are a personal AI assistant responding via WhatsApp. " +
                "Keep responses concise. Use *bold* and _italic_ — no complex markdown."
            );
        case "telegram":
            return (
                "You are a personal AI assistant responding in Telegram. " +
                "Use Telegram HTML: <b>bold</b>, <i>italic</i>, <code>code</code>. " +
                "Do NOT use markdown syntax."
            );
        default:
            return "";
    }
}

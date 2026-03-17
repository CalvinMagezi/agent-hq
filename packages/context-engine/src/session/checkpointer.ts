/**
 * Checkpointer — Model-aware checkpoint creation for infinite sessions.
 *
 * Creates structured checkpoints when context window fills up.
 * Reuses extractKeyFacts() from compaction/threadCompactor for fact extraction.
 */

import { randomUUID } from "crypto";
import { extractKeyFacts } from "../compaction/threadCompactor.js";
import { createExtractiveSummarizer } from "../compaction/summarizer.js";
import { getDefaultRegistry } from "../models/registry.js";
import type { CheckpointConfig } from "../models/types.js";
import type { SummarizerFn } from "../types.js";
import type {
  SessionMessage,
  Checkpoint,
  CheckpointFact,
  CheckpointToolResult,
} from "./types.js";

/**
 * Get checkpoint config from the model registry.
 * Convenience re-export so consumers don't need to import the registry directly.
 */
export function getCheckpointConfig(modelId: string): CheckpointConfig {
  return getDefaultRegistry().getCheckpointConfig(modelId);
}

export class Checkpointer {
  private summarizer?: SummarizerFn;
  private tokenCounter: (text: string) => number;

  constructor(opts: {
    summarizer?: SummarizerFn;
    tokenCounter: (text: string) => number;
  }) {
    this.summarizer = opts.summarizer;
    this.tokenCounter = opts.tokenCounter;
  }

  /**
   * Create a checkpoint from a segment's messages.
   *
   * 3-pass process:
   * 1. Extract structured facts (REMEMBER/GOAL/DONE tags + decision patterns)
   * 2. Summarize the conversation (LLM or extractive fallback)
   * 3. Preserve important tool results
   */
  async createCheckpoint(
    sessionId: string,
    segmentIndex: number,
    messages: SessionMessage[],
    config: CheckpointConfig,
    model: string
  ): Promise<Checkpoint> {
    if (messages.length === 0) {
      throw new Error("Cannot create checkpoint from empty messages");
    }

    // ─── Pass 1: Extract structured facts ───────────────────
    const allText = messages.map((m) => m.content).join("\n");
    const tagFacts = extractKeyFacts(allText);

    // Also scan for decision patterns
    const decisionPatterns = /\b(decided|agreed|chose|will use|going with|settled on|picked)\b/i;
    const decisionFacts: CheckpointFact[] = [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const lines = msg.content.split("\n");
      for (const line of lines) {
        if (decisionPatterns.test(line) && line.length < 300) {
          decisionFacts.push({ type: "decision", content: line.trim() });
        }
      }
    }

    const keyFacts: CheckpointFact[] = [
      ...tagFacts,
      ...decisionFacts,
    ];

    // Deduplicate by content
    const seen = new Set<string>();
    const dedupedFacts = keyFacts.filter((f) => {
      if (seen.has(f.content)) return false;
      seen.add(f.content);
      return true;
    });

    // Extract active goals (goals not marked DONE)
    const donePatterns = messages
      .flatMap((m) => {
        const matches = m.content.match(/\[DONE:\s*(.+?)\]/gi) ?? [];
        return matches.map((match) => {
          const inner = match.match(/\[DONE:\s*(.+?)\]/i);
          return inner?.[1]?.trim().toLowerCase() ?? "";
        });
      })
      .filter(Boolean);

    const activeGoals = dedupedFacts
      .filter((f) => f.type === "goal")
      .filter((f) => !donePatterns.some((d) => f.content.toLowerCase().includes(d)))
      .map((f) => f.content);

    // ─── Pass 2: Summarize conversation ─────────────────────
    const conversationText = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    let summary: string;
    const targetTokens = config.summaryTargetTokens;

    if (this.summarizer && targetTokens >= 100) {
      try {
        summary = await this.summarizer(
          `Summarize this conversation segment, preserving: user intent, key decisions, tool results, unresolved questions, and active tasks.\n\n${conversationText}`,
          targetTokens
        );
      } catch {
        // LLM failed — use extractive
        const extractive = createExtractiveSummarizer();
        summary = await extractive(conversationText, targetTokens);
      }
    } else {
      const extractive = createExtractiveSummarizer();
      summary = await extractive(conversationText, targetTokens);
    }

    // ─── Pass 3: Preserve tool results ──────────────────────
    const toolResults = this.extractToolResults(messages);

    // ─── Build checkpoint ───────────────────────────────────
    const seqs = messages.map((m) => m.seq);

    return {
      checkpointId: `ckpt-${Date.now()}-${randomUUID().slice(0, 8)}`,
      sessionId,
      segmentIndex,
      summary,
      keyFacts: dedupedFacts,
      activeGoals,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      messageSeqStart: Math.min(...seqs),
      messageSeqEnd: Math.max(...seqs),
      tokenCount: this.tokenCounter(summary),
      model,
      createdAt: new Date().toISOString(),
    };
  }

  // ─── Private ──────────────────────────────────────────────

  /**
   * Scan assistant messages for tool output patterns.
   * Looks for code blocks, file paths, and command outputs.
   */
  private extractToolResults(messages: SessionMessage[]): CheckpointToolResult[] {
    const results: CheckpointToolResult[] = [];
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;

    for (const msg of messages) {
      if (msg.role !== "assistant") continue;

      // Look for code blocks that look like tool outputs
      let match: RegExpExecArray | null;
      while ((match = codeBlockRegex.exec(msg.content)) !== null) {
        const lang = match[1] ?? "output";
        const content = match[2].trim();

        // Skip very short blocks (likely inline code examples)
        if (content.length < 50) continue;

        // Summarize: first line + "..." + last line
        const lines = content.split("\n");
        const summaryText =
          lines.length <= 3
            ? content
            : `${lines[0]}\n... (${lines.length} lines)\n${lines[lines.length - 1]}`;

        results.push({
          tool: lang,
          summary: summaryText.slice(0, 200),
        });

        // Limit to 5 tool results per checkpoint
        if (results.length >= 5) return results;
      }
    }

    return results;
  }
}

/**
 * Context Engine — Unified context management for Agent HQ.
 *
 * Assembles token-budgeted context frames from vault data,
 * providing a single API that all relay adapters and harnesses consume.
 *
 * Usage:
 *   const engine = new ContextEngine({ vault, model: "claude-sonnet-4-5" });
 *   const frame = await engine.buildFrame({ userMessage: "Hello", threadId });
 *   // frame.system → system prompt
 *   // frame.turns → conversation history (compacted)
 *   // frame.injections → relevant vault content
 *   // frame.budget → token accounting
 */

export * from "./types.js";
export { PROFILES } from "./budget/profiles.js";
export { getModelLimit, isLargeContextModel } from "./tokenizer/models.js";
export { countTokensFast, countTokensPrecise } from "./tokenizer/counter.js";

// Layers
export { assembleSystemLayer, buildHarnessInstructions } from "./layers/system.js";
export { assembleMemoryLayer } from "./layers/memory.js";
export { assembleThreadLayer } from "./layers/thread.js";
export { assembleInjectionsLayer } from "./layers/injections.js";
export { assembleUserMessageLayer } from "./layers/userMessage.js";

// Compaction
export { extractKeyFacts, extractiveSummarize, compactThread } from "./compaction/threadCompactor.js";
export { truncateChunk } from "./compaction/chunkTruncator.js";
export { createExtractiveSummarizer } from "./compaction/summarizer.js";

// Vault
export { adaptVaultClient, createMockVault } from "./vault/adapter.js";
export { ChunkIndex, chunkNote, scoreChunks } from "./vault/chunkIndex.js";

// Observability
export { MetricsCollector, extractMetrics } from "./observability/metrics.js";
export type { FrameMetrics } from "./observability/metrics.js";
export { TraceLogger } from "./observability/tracing.js";
export type { TraceEntry } from "./observability/tracing.js";

import { randomUUID } from "crypto";

import type {
  ContextEngineConfig,
  ContextFrame,
  ContextInjection,
  ContextLayer,
  ConversationTurn,
  CompactionEvent,
  FrameInput,
  FrameMeta,
  BudgetProfileName,
  SummarizerFn,
} from "./types.js";

import { createCounter, truncateToTokens } from "./tokenizer/counter.js";
import { getModelLimit } from "./tokenizer/models.js";
import { PROFILES, mergeProfile } from "./budget/profiles.js";
import { computeAllocations, cascadeSurplus, buildBudget } from "./budget/allocator.js";

export class ContextEngine {
  private config: Required<
    Pick<ContextEngineConfig, "model" | "profile" | "precision" | "maxInjections" | "recencyWindow" | "maxChunkTokens">
  > & ContextEngineConfig;

  private count: (text: string) => number;

  constructor(config: ContextEngineConfig) {
    this.config = {
      ...config,
      profile: config.profile ?? "standard",
      precision: config.precision ?? false,
      maxInjections: config.maxInjections ?? 8,
      recencyWindow: config.recencyWindow ?? 4,
      maxChunkTokens: config.maxChunkTokens ?? 300,
    };

    this.count = createCounter(this.config.precision);
  }

  /**
   * Build a complete context frame for one conversation turn.
   *
   * This is the primary API. Call it once per incoming message,
   * then use the returned frame to construct your LLM call.
   */
  async buildFrame(input: FrameInput): Promise<ContextFrame> {
    const start = performance.now();
    const frameId = randomUUID().slice(0, 12);
    const compactionEvents: CompactionEvent[] = [];

    // Resolve profile and budget
    const profileName = this.config.profile;
    const baseProfile = PROFILES[profileName];
    const profile = input.budgetOverrides
      ? mergeProfile(baseProfile, input.budgetOverrides)
      : baseProfile;

    const modelLimit = getModelLimit(this.config.model);
    const allocations = computeAllocations(modelLimit, profile);

    // ─── Layer 1: System Prompt ──────────────────────────────

    const ctx = await this.config.vault.getAgentContext();
    const systemParts: string[] = [];

    if (ctx.soul) systemParts.push(ctx.soul);

    // Add harness-specific instructions if hinted
    if (input.harnessHint) {
      systemParts.push(this.buildHarnessInstructions(input.harnessHint));
    }

    let system = systemParts.join("\n\n");
    let systemTokens = this.count(system);

    if (systemTokens > allocations.layers.system) {
      const result = truncateToTokens(system, allocations.layers.system, this.count);
      system = result.text;
      systemTokens = this.count(system);
      if (result.truncated) {
        compactionEvents.push({
          layer: "system",
          strategy: "truncate",
          tokensBefore: this.count(systemParts.join("\n\n")),
          tokensAfter: systemTokens,
        });
      }
    }

    // ─── Layer 2: User Message ───────────────────────────────

    let userMessage = input.userMessage;
    let userTokens = this.count(userMessage);

    if (userTokens > allocations.layers.userMessage) {
      const result = truncateToTokens(userMessage, allocations.layers.userMessage, this.count);
      userMessage = result.text;
      userTokens = this.count(userMessage);
      if (result.truncated) {
        compactionEvents.push({
          layer: "userMessage",
          strategy: "truncate",
          tokensBefore: this.count(input.userMessage),
          tokensAfter: userTokens,
        });
      }
    }

    // ─── Layer 3: Memory ─────────────────────────────────────

    const memoryParts: string[] = [];
    if (ctx.memory) memoryParts.push(ctx.memory);
    if (ctx.preferences) memoryParts.push(ctx.preferences);

    // Add structured facts/goals if available
    if (this.config.vault.getMemoryFacts) {
      try {
        const facts = await this.config.vault.getMemoryFacts();
        const factLines = facts.filter((f: any) => f.type === "fact").map((f: any) => `- ${f.content}`);
        const goalLines = facts.filter((f: any) => f.type === "goal").map((f: any) => {
          const deadline = f.deadline ? ` (by ${f.deadline})` : "";
          return `- ${f.content}${deadline}`;
        });
        if (factLines.length) memoryParts.push("Facts:\n" + factLines.join("\n"));
        if (goalLines.length) memoryParts.push("Goals:\n" + goalLines.join("\n"));
      } catch {
        // getMemoryFacts may not be implemented — that's fine
      }
    }

    let memory = memoryParts.join("\n\n");
    let memoryTokens = this.count(memory);
    let memoryCompacted = false;

    if (memoryTokens > allocations.layers.memory) {
      const result = truncateToTokens(memory, allocations.layers.memory, this.count);
      memory = result.text;
      memoryTokens = this.count(memory);
      memoryCompacted = result.truncated;
      if (result.truncated) {
        compactionEvents.push({
          layer: "memory",
          strategy: "truncate",
          tokensBefore: this.count(memoryParts.join("\n\n")),
          tokensAfter: memoryTokens,
        });
      }
    }

    // ─── Surplus cascading (phase 1) ─────────────────────────
    // Recalculate available budget for thread and injections based on what
    // system, userMessage, and memory actually used.

    const phase1Usage: Partial<Record<ContextLayer, number>> = {
      responseReserve: allocations.layers.responseReserve, // always fully reserved
      system: systemTokens,
      userMessage: userTokens,
      memory: memoryTokens,
    };
    const cascaded = cascadeSurplus(allocations, phase1Usage);

    // ─── Layer 4: Thread History ─────────────────────────────

    const turns: ConversationTurn[] = [];
    let threadTokens = 0;
    let threadTurnsSummarized = 0;
    let threadCompacted = false;
    const threadBudget = cascaded.layers.thread;

    if (input.threadId || input.channelId) {
      const rawTurns = await this.loadThreadTurns(
        input.threadId ?? input.channelId!
      );

      if (rawTurns.length > 0) {
        // Apply recency window — last N turns always at full fidelity
        const recencyWindow = this.config.recencyWindow;
        const recentTurns = rawTurns.slice(-recencyWindow);
        const olderTurns = rawTurns.slice(0, -recencyWindow);

        // Older turns: summarize if we have a summarizer, otherwise truncate
        if (olderTurns.length > 0) {
          const olderText = olderTurns
            .map(t => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
            .join("\n");
          const olderTokens = this.count(olderText);

          // Budget for older turns = threadBudget minus what recent turns need
          const recentTokens = recentTurns.reduce(
            (sum, t) => sum + this.count(t.content) + 10, // +10 for role prefix
            0
          );
          const olderBudget = Math.max(0, threadBudget - recentTokens);

          if (olderTokens > olderBudget && olderBudget > 50) {
            // Compact older turns
            let compactedText: string;

            if (this.config.summarizer && olderBudget >= 100) {
              try {
                compactedText = await this.config.summarizer(olderText, olderBudget);
              } catch {
                // Summarizer failed — fall back to truncation
                compactedText = truncateToTokens(olderText, olderBudget, this.count).text;
              }
            } else {
              compactedText = truncateToTokens(olderText, olderBudget, this.count).text;
            }

            turns.push({
              role: "assistant",
              content: `[Earlier conversation summary]\n${compactedText}`,
              tokens: this.count(compactedText),
              compacted: true,
            });

            threadTurnsSummarized = olderTurns.length;
            threadCompacted = true;

            compactionEvents.push({
              layer: "thread",
              strategy: this.config.summarizer ? "summarize" : "truncate",
              tokensBefore: olderTokens,
              tokensAfter: this.count(compactedText),
            });
          } else if (olderBudget <= 50 && olderTurns.length > 0) {
            // Not enough budget for older turns — drop them
            turns.push({
              role: "assistant",
              content: `[... ${olderTurns.length} earlier messages omitted ...]`,
              tokens: 15,
              compacted: true,
            });
            threadTurnsSummarized = olderTurns.length;
            threadCompacted = true;

            compactionEvents.push({
              layer: "thread",
              strategy: "drop",
              tokensBefore: olderTokens,
              tokensAfter: 15,
            });
          } else {
            // Older turns fit within budget — include them
            for (const t of olderTurns) {
              turns.push({
                role: t.role,
                content: t.content,
                tokens: this.count(t.content),
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
            tokens: this.count(t.content),
            compacted: false,
            timestamp: t.timestamp,
          });
        }

        threadTokens = turns.reduce((sum, t) => sum + t.tokens, 0);
      }
    }

    // ─── Layer 5: Injections ─────────────────────────────────

    const injections: ContextInjection[] = [];
    let injectionTokens = 0;
    let injectionCompacted = false;
    const injectionBudget = cascaded.layers.injections;
    let chunkIndexHits = 0;

    // Reply-to context (highest priority injection)
    if (input.replyTo) {
      const replyTokens = this.count(input.replyTo);
      injections.push({
        source: "reply_to",
        label: "Replying to",
        content: input.replyTo,
        tokens: replyTokens,
        score: 1.0,
      });
      injectionTokens += replyTokens;
    }

    // Pinned notes
    if (ctx.pinnedNotes?.length) {
      for (const note of ctx.pinnedNotes.slice(0, 3)) {
        if (injections.length >= this.config.maxInjections) break;
        if (injectionTokens >= injectionBudget) break;

        const chunk = note.content.slice(0, 1200); // Rough pre-trim
        let tokens = this.count(chunk);

        let content = chunk;
        if (tokens > this.config.maxChunkTokens) {
          const result = truncateToTokens(chunk, this.config.maxChunkTokens, this.count);
          content = result.text;
          tokens = this.count(content);
          injectionCompacted = true;
        }

        injections.push({
          source: "pinned_note",
          label: note.title,
          content: `[${note.title}]: ${content}`,
          tokens,
          score: 0.85,
        });
        injectionTokens += tokens;
      }
    }

    // Semantic search results
    try {
      const searchResults = await this.config.vault.searchNotes(input.userMessage, 5);
      chunkIndexHits = searchResults.length;

      for (const result of searchResults) {
        if (injections.length >= this.config.maxInjections) break;
        if (injectionTokens >= injectionBudget) break;

        // Skip if we already have this note as a pinned injection
        if (injections.some(i => i.label === result.title)) continue;

        let content = result.content.slice(0, 800);
        let tokens = this.count(content);

        if (tokens > this.config.maxChunkTokens) {
          const truncResult = truncateToTokens(content, this.config.maxChunkTokens, this.count);
          content = truncResult.text;
          tokens = this.count(content);
          injectionCompacted = true;
        }

        const notebook = result.notebook ? ` (${result.notebook})` : "";
        injections.push({
          source: "search_result",
          label: `${result.title}${notebook}`,
          content: `[${result.title}${notebook}]: ${content}`,
          tokens,
          score: 0.6, // Base score — would be replaced by chunk index scoring
        });
        injectionTokens += tokens;
      }
    } catch {
      // Search may fail — non-critical
    }

    // Extra injections from caller
    if (input.extraInjections?.length) {
      for (const extra of input.extraInjections) {
        if (injections.length >= this.config.maxInjections) break;
        if (injectionTokens >= injectionBudget) break;

        const tokens = this.count(extra.content);
        injections.push({
          ...extra,
          tokens,
          score: 0.7,
        });
        injectionTokens += tokens;
      }
    }

    // If injections exceed budget, prune lowest-scored
    if (injectionTokens > injectionBudget) {
      injections.sort((a, b) => b.score - a.score);
      let running = 0;
      const kept: ContextInjection[] = [];
      for (const inj of injections) {
        if (running + inj.tokens <= injectionBudget) {
          kept.push(inj);
          running += inj.tokens;
        }
      }

      const pruned = injections.length - kept.length;
      if (pruned > 0) {
        compactionEvents.push({
          layer: "injections",
          strategy: "prune",
          tokensBefore: injectionTokens,
          tokensAfter: running,
        });
        injectionCompacted = true;
      }

      injections.length = 0;
      injections.push(...kept);
      injectionTokens = running;
    }

    // ─── Build Final Budget ──────────────────────────────────

    const usage: Record<ContextLayer, number> = {
      responseReserve: allocations.layers.responseReserve,
      system: systemTokens,
      userMessage: userTokens,
      memory: memoryTokens,
      thread: threadTokens,
      injections: injectionTokens,
    };

    const compacted: Record<ContextLayer, boolean> = {
      responseReserve: false,
      system: compactionEvents.some(e => e.layer === "system"),
      userMessage: compactionEvents.some(e => e.layer === "userMessage"),
      memory: memoryCompacted,
      thread: threadCompacted,
      injections: injectionCompacted,
    };

    const budget = buildBudget(modelLimit, cascaded, usage, compacted);

    // ─── Build Metadata ──────────────────────────────────────

    const assemblyTimeMs = performance.now() - start;

    const meta: FrameMeta = {
      assembledAt: new Date().toISOString(),
      assemblyTimeMs: Math.round(assemblyTimeMs * 100) / 100,
      model: this.config.model,
      profile: profileName,
      threadTurnsIncluded: turns.length,
      threadTurnsSummarized,
      injectionsIncluded: injections.length,
      chunkIndexHits,
      compactionEvents,
      harnessHint: input.harnessHint,
    };

    // ─── Return Frame ────────────────────────────────────────

    return {
      frameId,
      system,
      memory,
      turns,
      injections,
      userMessage,
      budget,
      meta,
    };
  }

  /**
   * Serialize a ContextFrame to a flat string.
   * Useful for harnesses that accept a single text input (CLI harnesses).
   */
  flatten(frame: ContextFrame): string {
    const parts: string[] = [];

    if (frame.memory) {
      parts.push("MEMORY:\n" + frame.memory);
    }

    if (frame.injections.length > 0) {
      parts.push(
        "CONTEXT:\n" +
        frame.injections.map((i: ContextInjection) => `- ${i.content}`).join("\n")
      );
    }

    if (frame.turns.length > 0) {
      parts.push(
        "RECENT CONVERSATION:\n" +
        frame.turns
          .map((t: ConversationTurn) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
          .join("\n")
      );
    }

    parts.push(`User: ${frame.userMessage}`);

    return parts.join("\n\n");
  }

  // ─── Private Helpers ───────────────────────────────────────

  private async loadThreadTurns(
    threadOrChannelId: string
  ): Promise<Array<{ role: "user" | "assistant"; content: string; timestamp?: string }>> {
    if (this.config.vault.getRecentMessages) {
      try {
        return await this.config.vault.getRecentMessages(threadOrChannelId, 30);
      } catch {
        return [];
      }
    }
    return [];
  }

  private buildHarnessInstructions(harnessHint: string): string {
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
      default:
        return "";
    }
  }
}

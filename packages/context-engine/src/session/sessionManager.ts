/**
 * Session Manager — Lifecycle orchestrator for infinite sessions.
 *
 * Composes around ContextEngine (not modifying it) to add:
 * - Session persistence and crash recovery
 * - Automatic checkpointing when context fills
 * - Message batching and interrupt detection
 * - Cross-surface session linking
 * - Full recall of past conversation
 */

import { ContextEngine } from "../index.js";
import type { ContextFrame, FrameInput, SummarizerFn } from "../types.js";
import { countTokensFast } from "../tokenizer/counter.js";
import { getDefaultRegistry } from "../models/registry.js";

import { SessionStore } from "./sessionStore.js";
import { MessageQueue } from "./messageQueue.js";
import { Checkpointer, getCheckpointConfig } from "./checkpointer.js";
import { RecallEngine } from "./recall.js";
import type {
  Session,
  SessionResumeContext,
  Checkpoint,
  RecallResult,
  BatchedInput,
  SurfaceType,
  MessageBatchConfig,
  CheckpointFact,
} from "./types.js";

export interface SessionManagerConfig {
  /** ContextEngine instance to compose around */
  engine: ContextEngine;
  /** Vault path for SessionStore SQLite database */
  vaultPath: string;
  /** Optional LLM summarizer for checkpoint creation */
  summarizer?: SummarizerFn;
  /** Per-surface batch config overrides */
  batchConfig?: Partial<Record<SurfaceType, MessageBatchConfig>>;
}

export class SessionManager {
  private engine: ContextEngine;
  private store: SessionStore;
  private queue: MessageQueue;
  private checkpointer: Checkpointer;
  private recall: RecallEngine;
  private checkpointPending: Set<string> = new Set();

  constructor(config: SessionManagerConfig) {
    this.engine = config.engine;
    this.store = new SessionStore(config.vaultPath);
    this.queue = new MessageQueue(config.batchConfig);
    this.checkpointer = new Checkpointer({
      summarizer: config.summarizer,
      tokenCounter: countTokensFast,
    });
    this.recall = new RecallEngine(this.store);
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /** Create a new session. Optionally link it to a surface immediately. */
  async createSession(opts: {
    surface?: SurfaceType;
    channelId?: string;
    model: string;
    title?: string;
  }): Promise<string> {
    const session = this.store.createSession({ model: opts.model });

    if (opts.surface && opts.channelId) {
      this.store.linkSurface(session.sessionId, opts.surface, opts.channelId);
    }

    return session.sessionId;
  }

  /** Resume an existing session (after crash, restart, or surface switch). */
  async resumeSession(sessionId: string): Promise<SessionResumeContext> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const checkpoints = this.store.getCheckpoints(sessionId);
    const recentMessages = this.store.getSegmentMessages(sessionId, session.currentSegment);
    const surfaces = this.store.getSurfaces(sessionId);

    // Merge and deduplicate facts from all checkpoints
    const factSet = new Map<string, CheckpointFact>();
    for (const cp of checkpoints) {
      for (const fact of cp.keyFacts) {
        factSet.set(fact.content, fact);
      }
    }
    const accumulatedFacts = Array.from(factSet.values());

    // Active goals from latest checkpoint, minus any DONE in later segments
    const latestCheckpoint = checkpoints[checkpoints.length - 1];
    const activeGoals = latestCheckpoint?.activeGoals ?? [];

    return {
      session,
      checkpointChain: checkpoints,
      recentMessages,
      accumulatedFacts,
      activeGoals,
      surfaces,
    };
  }

  /** Resume by surface channel (find the active session for this Discord channel, etc). */
  async resumeByChannel(
    surface: SurfaceType,
    channelId: string
  ): Promise<SessionResumeContext | null> {
    const session = this.store.getSessionBySurface(surface, channelId);
    if (!session) return null;
    return this.resumeSession(session.sessionId);
  }

  /** Archive a session (mark as archived, stop processing). */
  async archiveSession(sessionId: string): Promise<void> {
    this.store.updateSession(sessionId, { status: "archived" });
    this.queue.flushAll(sessionId);
  }

  /** Link a surface channel to an existing session. */
  async linkSurface(
    sessionId: string,
    surface: SurfaceType,
    channelId: string
  ): Promise<void> {
    this.store.linkSurface(sessionId, surface, channelId);
  }

  // ─── Per-Turn API ─────────────────────────────────────────

  /**
   * Send a user message. Handles batching, persistence, and frame building.
   *
   * Returns the built context frame plus batch info and assigned seq number.
   */
  async sendMessage(
    sessionId: string,
    content: string,
    surface: SurfaceType
  ): Promise<{ frame: ContextFrame; batch: BatchedInput; seq: number }> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // Batch the message (waits for debounce window to close)
    const batch = await this.queue.enqueue(sessionId, { content, surface });

    // Persist all batched messages to SQLite
    let lastSeq = 0;
    for (const msg of batch.messages) {
      lastSeq = this.store.appendMessage(sessionId, {
        segmentIndex: session.currentSegment,
        role: "user",
        surface: msg.surface,
        content: msg.content,
      });
    }

    // Build context frame with session awareness
    const frame = await this.buildSessionFrame(sessionId, {
      userMessage: batch.mergedContent,
    });

    // Check if we should checkpoint (async, don't block response)
    this.maybeCheckpointAsync(sessionId, session, frame);

    return { frame, batch, seq: lastSeq };
  }

  /**
   * Record an assistant response.
   * Call this after the LLM responds so the message is persisted for future context.
   */
  async recordAssistantResponse(
    sessionId: string,
    content: string,
    surface: SurfaceType,
    replyToSeq?: number
  ): Promise<number> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    return this.store.appendMessage(sessionId, {
      segmentIndex: session.currentSegment,
      role: "assistant",
      surface,
      content,
      replyToSeq,
    });
  }

  // ─── Interrupt Detection ──────────────────────────────────

  /**
   * Check for user messages that arrived after a given seq.
   * Use this during streaming to detect interrupts.
   */
  getInterruptsSince(sessionId: string, sinceSeq: number) {
    return this.store.getMessagesSince(sessionId, sinceSeq, 10)
      .filter((m) => m.role === "user");
  }

  // ─── Recall ───────────────────────────────────────────────

  /** Search past conversation for relevant context. */
  recallByQuery(sessionId: string, query: string, limit?: number): RecallResult[] {
    return this.recall.recallByQuery(sessionId, query, limit);
  }

  // ─── Explicit Checkpoint ──────────────────────────────────

  /** Force a checkpoint. Normally auto-triggered by buildSessionFrame. */
  async checkpoint(sessionId: string): Promise<Checkpoint> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const messages = this.store.getSegmentMessages(sessionId, session.currentSegment);
    if (messages.length === 0) throw new Error("No messages to checkpoint");

    const config = getCheckpointConfig(session.model);
    const cp = await this.checkpointer.createCheckpoint(
      sessionId,
      session.currentSegment,
      messages,
      config,
      session.model
    );

    this.store.saveCheckpoint(cp);
    this.store.updateSession(sessionId, {
      checkpointCount: session.checkpointCount + 1,
      currentSegment: session.currentSegment + 1,
    });

    this.checkpointPending.delete(sessionId);
    return cp;
  }

  // ─── Model Switch ─────────────────────────────────────────

  /** Update the active model for a session (e.g., user runs !model opus). */
  async switchModel(sessionId: string, newModel: string): Promise<void> {
    this.store.updateSession(sessionId, { model: newModel });
  }

  // ─── Access ───────────────────────────────────────────────

  /** Get the underlying store (for advanced queries). */
  getStore(): SessionStore {
    return this.store;
  }

  /** Clean up resources. */
  close(): void {
    this.store.close();
  }

  // ─── Private ──────────────────────────────────────────────

  /**
   * Build a context frame with session awareness.
   * Injects checkpoint chain and recall results as extra injections.
   */
  private async buildSessionFrame(
    sessionId: string,
    input: Omit<FrameInput, "extraInjections"> & { extraInjections?: FrameInput["extraInjections"] }
  ): Promise<ContextFrame> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const extraInjections: Array<{ source: "custom"; label: string; content: string }> = [];

    // Load checkpoint chain
    const checkpoints = this.store.getCheckpoints(sessionId);
    if (checkpoints.length > 0) {
      const config = getCheckpointConfig(session.model);
      const chainDepth = config.maxChainDepth;

      // Latest checkpoint: full summary
      const latest = checkpoints[checkpoints.length - 1];
      extraInjections.push({
        source: "custom" as const,
        label: "Session Context (latest)",
        content: `[Previous conversation checkpoint]\n${latest.summary}`,
      });

      // Older checkpoints: key facts only (merged)
      const olderCheckpoints = checkpoints.slice(
        Math.max(0, checkpoints.length - chainDepth),
        checkpoints.length - 1
      );
      if (olderCheckpoints.length > 0) {
        const allFacts = olderCheckpoints.flatMap((cp) => cp.keyFacts);
        const uniqueFacts = new Map<string, string>();
        for (const f of allFacts) {
          uniqueFacts.set(f.content, f.type);
        }
        if (uniqueFacts.size > 0) {
          const factsText = Array.from(uniqueFacts.entries())
            .map(([content, type]) => `- [${type}] ${content}`)
            .join("\n");
          extraInjections.push({
            source: "custom" as const,
            label: "Session Facts (accumulated)",
            content: `[Key facts from earlier conversation]\n${factsText}`,
          });
        }
      }

      // Active goals
      const activeGoals = latest.activeGoals;
      if (activeGoals.length > 0) {
        extraInjections.push({
          source: "custom" as const,
          label: "Active Goals",
          content: `[Active goals]\n${activeGoals.map((g) => `- ${g}`).join("\n")}`,
        });
      }
    }

    // If user message references past context, add recall results
    if (input.userMessage && RecallEngine.looksLikePastReference(input.userMessage)) {
      const recallResults = this.recall.recallByQuery(sessionId, input.userMessage, 3);
      for (const result of recallResults) {
        if (!result.checkpoint) {
          extraInjections.push({
            source: "custom" as const,
            label: `Past message (seq ${result.message.seq})`,
            content: `[From earlier in conversation] ${result.message.role}: ${result.message.content.slice(0, 500)}`,
          });
        }
      }
    }

    // Merge with any caller-provided injections
    const allInjections = [
      ...extraInjections,
      ...(input.extraInjections ?? []),
    ];

    return this.engine.buildFrame({
      ...input,
      extraInjections: allInjections,
    });
  }

  /**
   * Check utilization and trigger async checkpoint if needed.
   * Does NOT block the response — checkpointing happens in the background.
   */
  private maybeCheckpointAsync(
    sessionId: string,
    session: Session,
    frame: ContextFrame
  ): void {
    if (this.checkpointPending.has(sessionId)) return;

    const config = getCheckpointConfig(session.model);
    if (frame.budget.utilizationPct >= config.thresholdPct) {
      this.checkpointPending.add(sessionId);

      // Run checkpoint in background (don't await)
      queueMicrotask(() => {
        this.checkpoint(sessionId).catch((err) => {
          console.error(`[SessionManager] Checkpoint failed for ${sessionId}:`, err);
          this.checkpointPending.delete(sessionId);
        });
      });
    }
  }
}

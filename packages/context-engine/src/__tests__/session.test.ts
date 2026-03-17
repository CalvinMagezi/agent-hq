import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { SessionStore } from "../session/sessionStore.js";
import { MessageQueue } from "../session/messageQueue.js";
import { Checkpointer, getCheckpointConfig } from "../session/checkpointer.js";
import { RecallEngine } from "../session/recall.js";
import type { SessionMessage, SurfaceType } from "../session/types.js";

// ─── Test helpers ───────────────────────────────────────────

let tmpDir: string;
let store: SessionStore;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
  store = new SessionStore(tmpDir);
}

function teardown() {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ─── SessionStore ───────────────────────────────────────────

describe("SessionStore", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("creates and retrieves a session", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });
    expect(session.sessionId).toContain("session-");
    expect(session.status).toBe("active");
    expect(session.model).toBe("claude-sonnet-4-6");
    expect(session.messageCount).toBe(0);

    const retrieved = store.getSession(session.sessionId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.sessionId).toBe(session.sessionId);
  });

  test("updates session fields", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });
    store.updateSession(session.sessionId, {
      status: "archived",
      model: "claude-opus-4-6",
      checkpointCount: 2,
    });

    const updated = store.getSession(session.sessionId);
    expect(updated!.status).toBe("archived");
    expect(updated!.model).toBe("claude-opus-4-6");
    expect(updated!.checkpointCount).toBe(2);
  });

  test("appends messages with auto-incrementing seq", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });

    const seq1 = store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "user",
      surface: "cli",
      content: "Hello",
    });

    const seq2 = store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "assistant",
      surface: "cli",
      content: "Hi there!",
      replyToSeq: seq1,
    });

    expect(seq2).toBeGreaterThan(seq1);

    // Message count updated
    const updated = store.getSession(session.sessionId);
    expect(updated!.messageCount).toBe(2);
  });

  test("getMessagesSince returns messages after given seq", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });

    const seq1 = store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "user",
      surface: "cli",
      content: "First",
    });

    store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "assistant",
      surface: "cli",
      content: "Second",
    });

    store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "user",
      surface: "discord",
      content: "Third from Discord",
    });

    const since = store.getMessagesSince(session.sessionId, seq1);
    expect(since.length).toBe(2);
    expect(since[0].content).toBe("Second");
    expect(since[1].content).toBe("Third from Discord");
    expect(since[1].surface).toBe("discord");
  });

  test("getSegmentMessages filters by segment", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });

    store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "user",
      surface: "cli",
      content: "Segment 0 message",
    });

    store.appendMessage(session.sessionId, {
      segmentIndex: 1,
      role: "user",
      surface: "cli",
      content: "Segment 1 message",
    });

    const seg0 = store.getSegmentMessages(session.sessionId, 0);
    expect(seg0.length).toBe(1);
    expect(seg0[0].content).toBe("Segment 0 message");

    const seg1 = store.getSegmentMessages(session.sessionId, 1);
    expect(seg1.length).toBe(1);
    expect(seg1[0].content).toBe("Segment 1 message");
  });

  test("getRecentMessages returns latest N messages in order", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });

    for (let i = 0; i < 10; i++) {
      store.appendMessage(session.sessionId, {
        segmentIndex: 0,
        role: "user",
        surface: "cli",
        content: `Message ${i}`,
      });
    }

    const recent = store.getRecentMessages(session.sessionId, 3);
    expect(recent.length).toBe(3);
    expect(recent[0].content).toBe("Message 7");
    expect(recent[2].content).toBe("Message 9");
  });

  test("saves and retrieves checkpoints", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });

    store.saveCheckpoint({
      checkpointId: "ckpt-1",
      sessionId: session.sessionId,
      segmentIndex: 0,
      summary: "We discussed the auth module refactoring",
      keyFacts: [{ type: "decision", content: "Use JWT instead of sessions" }],
      activeGoals: ["Complete auth refactor by Friday"],
      messageSeqStart: 1,
      messageSeqEnd: 20,
      tokenCount: 150,
      model: "claude-sonnet-4-6",
      createdAt: new Date().toISOString(),
    });

    const checkpoints = store.getCheckpoints(session.sessionId);
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0].summary).toContain("auth module");
    expect(checkpoints[0].keyFacts[0].content).toBe("Use JWT instead of sessions");
    expect(checkpoints[0].activeGoals[0]).toBe("Complete auth refactor by Friday");
  });

  test("surface linking works", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });

    store.linkSurface(session.sessionId, "discord", "channel-123");
    store.linkSurface(session.sessionId, "cli", "terminal-main");

    const fromDiscord = store.getSessionBySurface("discord", "channel-123");
    expect(fromDiscord).not.toBeNull();
    expect(fromDiscord!.sessionId).toBe(session.sessionId);

    const fromCli = store.getSessionBySurface("cli", "terminal-main");
    expect(fromCli!.sessionId).toBe(session.sessionId);

    const surfaces = store.getSurfaces(session.sessionId);
    expect(surfaces.length).toBe(2);
  });

  test("FTS5 message search", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });

    store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "user",
      surface: "cli",
      content: "How do we handle authentication with JWT tokens?",
    });

    store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "assistant",
      surface: "cli",
      content: "I recommend using RS256 signed JWT tokens with short expiry.",
    });

    store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "user",
      surface: "cli",
      content: "What about the database migration?",
    });

    const results = store.searchMessages(session.sessionId, "JWT tokens");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content.includes("JWT"))).toBe(true);
  });

  test("getActiveSessions returns only active sessions", () => {
    store.createSession({ model: "claude-sonnet-4-6" });
    const archived = store.createSession({ model: "claude-opus-4-6" });
    store.updateSession(archived.sessionId, { status: "archived" });
    store.createSession({ model: "gemini-2.5-flash" });

    const active = store.getActiveSessions();
    expect(active.length).toBe(2);
    expect(active.every((s) => s.status === "active")).toBe(true);
  });
});

// ─── MessageQueue ───────────────────────────────────────────

describe("MessageQueue", () => {
  test("agent surface has no batching (immediate)", async () => {
    const queue = new MessageQueue();
    const batch = await queue.enqueue("session-1", {
      content: "Hello",
      surface: "agent",
    });
    expect(batch.batchSize).toBe(1);
    expect(batch.mergedContent).toBe("Hello");
  });

  test("flush returns pending batch", async () => {
    const queue = new MessageQueue({
      cli: { batchWindowMs: 10000, maxBatchMessages: 10 },
    });

    // Start a batch (don't await — it would wait for the timer)
    const promise = queue.enqueue("session-1", {
      content: "Hello",
      surface: "cli",
    });

    expect(queue.pendingCount).toBe(1);

    // Flush immediately
    const flushed = queue.flush("session-1", "cli");
    expect(flushed).not.toBeNull();
    expect(flushed!.batchSize).toBe(1);
    expect(flushed!.mergedContent).toBe("Hello");

    // Promise should also resolve
    const result = await promise;
    expect(result.batchSize).toBe(1);
  });

  test("max batch size triggers immediate flush", async () => {
    const queue = new MessageQueue({
      cli: { batchWindowMs: 10000, maxBatchMessages: 3 },
    });

    // Enqueue 3 messages (hits max)
    queue.enqueue("session-1", { content: "One", surface: "cli" });
    queue.enqueue("session-1", { content: "Two", surface: "cli" });
    const batch = await queue.enqueue("session-1", {
      content: "Three",
      surface: "cli",
    });

    expect(batch.batchSize).toBe(3);
    expect(batch.mergedContent).toBe("One\nTwo\nThree");
    expect(queue.pendingCount).toBe(0);
  });

  test("flushAll clears all batches for a session", () => {
    const queue = new MessageQueue({
      discord: { batchWindowMs: 10000, maxBatchMessages: 10 },
      cli: { batchWindowMs: 10000, maxBatchMessages: 10 },
    });

    queue.enqueue("session-1", { content: "Discord msg", surface: "discord" });
    queue.enqueue("session-1", { content: "CLI msg", surface: "cli" });

    expect(queue.pendingCount).toBe(2);

    const results = queue.flushAll("session-1");
    expect(results.length).toBe(2);
    expect(queue.pendingCount).toBe(0);
  });
});

// ─── Checkpointer ───────────────────────────────────────────

describe("Checkpointer", () => {
  test("getCheckpointConfig returns model-appropriate thresholds", () => {
    // Small model (128K)
    const small = getCheckpointConfig("gpt-4o");
    expect(small.thresholdPct).toBe(70);
    expect(small.maxChainDepth).toBe(3);

    // Large model (1M)
    const large = getCheckpointConfig("claude-opus-4-6");
    expect(large.thresholdPct).toBe(85);
    expect(large.maxChainDepth).toBe(10);

    // Huge model (2M)
    const huge = getCheckpointConfig("gemini-1.5-pro");
    expect(huge.thresholdPct).toBe(90);
    expect(huge.maxChainDepth).toBe(10);
  });

  test("creates checkpoint with fact extraction", async () => {
    const checkpointer = new Checkpointer({
      tokenCounter: (s) => Math.ceil(s.length / 4),
    });

    const messages: SessionMessage[] = [
      {
        seq: 1,
        sessionId: "s1",
        segmentIndex: 0,
        role: "user",
        surface: "cli",
        content: "Let's refactor the auth module",
        timestamp: new Date().toISOString(),
        status: "final",
      },
      {
        seq: 2,
        sessionId: "s1",
        segmentIndex: 0,
        role: "assistant",
        surface: "cli",
        content:
          "I've decided to use JWT tokens for authentication.\n[REMEMBER: Auth uses JWT with RS256]\n[GOAL: Complete auth refactor]",
        timestamp: new Date().toISOString(),
        status: "final",
      },
      {
        seq: 3,
        sessionId: "s1",
        segmentIndex: 0,
        role: "user",
        surface: "cli",
        content: "Great approach",
        timestamp: new Date().toISOString(),
        status: "final",
      },
    ];

    const config = { thresholdPct: 75, summaryTargetTokens: 500, maxChainDepth: 5 };
    const cp = await checkpointer.createCheckpoint("s1", 0, messages, config, "claude-sonnet-4-6");

    expect(cp.sessionId).toBe("s1");
    expect(cp.segmentIndex).toBe(0);
    expect(cp.messageSeqStart).toBe(1);
    expect(cp.messageSeqEnd).toBe(3);
    expect(cp.summary.length).toBeGreaterThan(0);
    expect(cp.model).toBe("claude-sonnet-4-6");

    // Should have extracted facts
    expect(cp.keyFacts.some((f) => f.content.includes("JWT"))).toBe(true);
    expect(cp.keyFacts.some((f) => f.type === "goal")).toBe(true);

    // Should have extracted decision
    expect(cp.keyFacts.some((f) => f.type === "decision")).toBe(true);

    // Active goals
    expect(cp.activeGoals.length).toBeGreaterThan(0);
  });

  test("handles empty messages", async () => {
    const checkpointer = new Checkpointer({
      tokenCounter: (s) => Math.ceil(s.length / 4),
    });

    const config = { thresholdPct: 75, summaryTargetTokens: 500, maxChainDepth: 5 };

    expect(
      checkpointer.createCheckpoint("s1", 0, [], config, "claude-sonnet-4-6")
    ).rejects.toThrow("Cannot create checkpoint from empty messages");
  });
});

// ─── RecallEngine ───────────────────────────────────────────

describe("RecallEngine", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("recallByQuery finds matching messages", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });
    const recall = new RecallEngine(store);

    store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "user",
      surface: "cli",
      content: "The authentication system uses JWT tokens with RS256 signing",
    });

    store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "assistant",
      surface: "cli",
      content: "I recommend rotating the signing keys every 90 days",
    });

    const results = recall.recallByQuery(session.sessionId, "JWT authentication");
    expect(results.length).toBeGreaterThan(0);
  });

  test("recallBySegment returns all segment messages", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });
    const recall = new RecallEngine(store);

    store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "user",
      surface: "cli",
      content: "Msg in segment 0",
    });

    store.appendMessage(session.sessionId, {
      segmentIndex: 1,
      role: "user",
      surface: "cli",
      content: "Msg in segment 1",
    });

    const seg0 = recall.recallBySegment(session.sessionId, 0);
    expect(seg0.length).toBe(1);
    expect(seg0[0].content).toBe("Msg in segment 0");
  });

  test("looksLikePastReference detects reference patterns", () => {
    expect(RecallEngine.looksLikePastReference("remember when we discussed auth?")).toBe(true);
    expect(RecallEngine.looksLikePastReference("you mentioned earlier")).toBe(true);
    expect(RecallEngine.looksLikePastReference("what did we decide about the API?")).toBe(true);
    expect(RecallEngine.looksLikePastReference("go back to the auth discussion")).toBe(true);
    expect(RecallEngine.looksLikePastReference("deploy the app")).toBe(false);
    expect(RecallEngine.looksLikePastReference("write a function")).toBe(false);
  });
});

// ─── Cross-Surface Integration ──────────────────────────────

describe("Cross-Surface", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("messages from multiple surfaces share ordering", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });

    const seq1 = store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "user",
      surface: "discord",
      content: "Hello from Discord",
    });

    const seq2 = store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "user",
      surface: "cli",
      content: "Hello from CLI",
    });

    const seq3 = store.appendMessage(session.sessionId, {
      segmentIndex: 0,
      role: "assistant",
      surface: "discord",
      content: "I see messages from both surfaces",
      replyToSeq: seq1,
    });

    expect(seq2).toBeGreaterThan(seq1);
    expect(seq3).toBeGreaterThan(seq2);

    // All messages visible regardless of surface
    const all = store.getRecentMessages(session.sessionId, 10);
    expect(all.length).toBe(3);
    expect(all[0].surface).toBe("discord");
    expect(all[1].surface).toBe("cli");
    expect(all[2].surface).toBe("discord");
  });

  test("session linked from two surfaces", () => {
    const session = store.createSession({ model: "claude-sonnet-4-6" });
    store.linkSurface(session.sessionId, "discord", "channel-abc");
    store.linkSurface(session.sessionId, "cli", "terminal-1");

    // Both surfaces find the same session
    const fromDiscord = store.getSessionBySurface("discord", "channel-abc");
    const fromCli = store.getSessionBySurface("cli", "terminal-1");
    expect(fromDiscord!.sessionId).toBe(fromCli!.sessionId);
  });
});

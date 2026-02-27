import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FbmqCli } from "../fbmqCli";
import { JobQueue } from "../jobQueue";
import { DelegationQueue } from "../delegationQueue";
import { jobCodec, getPriority, parsePriority } from "../codecs/jobCodec";
import { delegationCodec } from "../codecs/delegationCodec";
import type { Job, DelegatedTask } from "@repo/vault-client";

// ─── Test fixtures ──────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    jobId: `job-test-${Date.now()}`,
    type: "background",
    status: "pending",
    priority: 50,
    securityProfile: "standard",
    modelOverride: null,
    thinkingLevel: null,
    workerId: null,
    threadId: null,
    instruction: "# Test Instruction\n\nDo the thing.",
    createdAt: new Date().toISOString(),
    traceId: "trace-abc-123",
    spanId: "span-xyz",
    _filePath: "",
    ...overrides,
  };
}

function makeTask(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    taskId: `task-test-${Date.now()}`,
    jobId: "job-parent-123",
    targetHarnessType: "claude-code",
    status: "pending",
    priority: 60,
    deadlineMs: 600000,
    dependsOn: [],
    claimedBy: null,
    claimedAt: null,
    instruction: "# Research Task\n\nInvestigate the problem.",
    createdAt: new Date().toISOString(),
    traceId: "trace-task-456",
    spanId: "span-task-789",
    parentSpanId: "span-parent-000",
    _filePath: "",
    ...overrides,
  };
}

// ─── FbmqCli tests ─────────────────────────────────────────────────

describe("FbmqCli", () => {
  let tempDir: string;
  let cli: FbmqCli;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fbmq-test-cli-"));
    cli = new FbmqCli(tempDir);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("init creates queue directories", async () => {
    await cli.init(true);
    expect(existsSync(join(tempDir, "pending"))).toBe(true);
    expect(existsSync(join(tempDir, "processing"))).toBe(true);
    expect(existsSync(join(tempDir, "done"))).toBe(true);
    expect(existsSync(join(tempDir, "failed"))).toBe(true);
    expect(existsSync(join(tempDir, ".tmp"))).toBe(true);
    // Check a bucket with priority dirs
    expect(existsSync(join(tempDir, "pending/00/0-critical"))).toBe(true);
    expect(existsSync(join(tempDir, "pending/ff/3-low"))).toBe(true);
  });

  test("push returns 32-char message ID", async () => {
    const id = await cli.push("# Hello World\n\nTest message.", {
      priority: "high",
      tags: ["test", "unit"],
      correlationId: "corr-123",
    });
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  test("depth reports correct count", async () => {
    const before = await cli.depth();
    await cli.push("Message 1", { priority: "normal" });
    await cli.push("Message 2", { priority: "normal" });
    const after = await cli.depth();
    expect(after - before).toBe(2);
  });

  test("pop claims a message and returns path", async () => {
    // Push a high-priority message
    await cli.push("Urgent task", { priority: "critical" });
    const depthBefore = await cli.depth();

    const claimedPath = await cli.pop();
    expect(claimedPath).not.toBeNull();
    expect(claimedPath!).toContain("processing/");
    expect(existsSync(claimedPath!)).toBe(true);

    // Depth should include processing messages
    const depthAfter = await cli.depth();
    expect(depthAfter).toBe(depthBefore); // depth counts pending + processing
  });

  test("cat returns message body without headers", async () => {
    // Drain any leftover messages from prior tests
    let stale = await cli.pop();
    while (stale) {
      await cli.ack(stale);
      stale = await cli.pop();
    }

    await cli.push("# My Body\n\nContent here.", { priority: "normal" });
    const claimed = await cli.pop();
    expect(claimed).not.toBeNull();

    const body = await cli.cat(claimed!);
    expect(body).toContain("# My Body");
    expect(body).toContain("Content here.");
  });

  test("inspect returns parsed headers", async () => {
    await cli.push("Test body", {
      priority: "high",
      correlationId: "test-corr",
      tags: ["tag1", "tag2"],
    });
    const claimed = await cli.pop();
    expect(claimed).not.toBeNull();

    const headers = await cli.inspect(claimed!);
    expect(headers.priority).toBe("high");
    expect(headers.correlationId).toBe("test-corr");
    expect(headers.tags).toContain("tag1");
    expect(headers.tags).toContain("tag2");
  });

  test("ack moves message to done/", async () => {
    await cli.push("To be completed", { priority: "normal" });
    const claimed = await cli.pop();
    expect(claimed).not.toBeNull();

    await cli.ack(claimed!);
    // Original path should no longer exist
    expect(existsSync(claimed!)).toBe(false);
  });

  test("nack returns message to pending or failed", async () => {
    await cli.push("To be retried", { priority: "normal" });
    const claimed = await cli.pop();
    expect(claimed).not.toBeNull();

    const depthBefore = await cli.depth();
    await cli.nack(claimed!);
    // Should still be in the queue (returned to pending or sent to failed)
    expect(existsSync(claimed!)).toBe(false); // no longer in processing
  });

  test("pop returns null on empty queue", async () => {
    // Drain the queue
    let msg = await cli.pop();
    while (msg) {
      await cli.ack(msg);
      msg = await cli.pop();
    }

    const result = await cli.pop();
    expect(result).toBeNull();
  });
});

// ─── Job codec round-trip tests ─────────────────────────────────────

describe("jobCodec", () => {
  test("priority mapping is correct", () => {
    expect(getPriority(100)).toBe("critical");
    expect(getPriority(80)).toBe("critical");
    expect(getPriority(75)).toBe("critical");
    expect(getPriority(74)).toBe("high");
    expect(getPriority(50)).toBe("high");
    expect(getPriority(49)).toBe("normal");
    expect(getPriority(25)).toBe("normal");
    expect(getPriority(24)).toBe("low");
    expect(getPriority(0)).toBe("low");
  });

  test("round-trip preserves core fields", () => {
    const original = makeJob({
      jobId: "job-roundtrip-1",
      type: "rpc",
      priority: 80,
      securityProfile: "admin",
      modelOverride: "claude-opus-4-6",
      thinkingLevel: "high",
      threadId: "thread-abc",
      traceId: "trace-round",
      spanId: "span-round",
      instruction: "# Complex Task\n\nWith **markdown** and `code`.",
    });

    const serialized = jobCodec.serialize(original);
    expect(serialized.priority).toBe("critical"); // 80 -> critical
    expect(serialized.tags).toBe("rpc,admin");
    expect(serialized.correlationId).toBe("trace-round");
    expect(serialized.body).toBe(original.instruction);

    // Simulate what fbmq inspect + cat would return
    const headers = {
      priority: serialized.priority,
      correlationId: serialized.correlationId,
      tags: serialized.tags?.split(","),
      custom: serialized.custom,
    };

    const deserialized = jobCodec.deserialize("/fake/path.md", serialized.body, headers);
    expect(deserialized.jobId).toBe("job-roundtrip-1");
    expect(deserialized.type).toBe("rpc");
    expect(deserialized.securityProfile).toBe("admin");
    expect(deserialized.modelOverride).toBe("claude-opus-4-6");
    expect(deserialized.thinkingLevel).toBe("high");
    expect(deserialized.threadId).toBe("thread-abc");
    expect(deserialized.traceId).toBe("trace-round");
    expect(deserialized.spanId).toBe("span-round");
    expect(deserialized.instruction).toBe(original.instruction);
  });

  test("round-trip preserves result and stats", () => {
    const original = makeJob({
      result: "Task completed successfully.\nMultiple lines.",
      stats: { promptTokens: 100, completionTokens: 200, totalTokens: 300, cost: 0.01, toolCalls: 3, messageCount: 5 },
      conversationHistory: [
        { role: "user", content: "Do it", timestamp: "2026-01-01T00:00:00Z" },
        { role: "assistant", content: "Done", timestamp: "2026-01-01T00:01:00Z" },
      ],
    });

    const serialized = jobCodec.serialize(original);
    const headers = {
      priority: serialized.priority,
      correlationId: serialized.correlationId,
      custom: serialized.custom,
    };

    const deserialized = jobCodec.deserialize("/fake.md", serialized.body, headers);
    expect(deserialized.result).toBe(original.result);
    expect(deserialized.stats).toEqual(original.stats);
    expect(deserialized.conversationHistory).toEqual(original.conversationHistory);
  });
});

// ─── Delegation codec round-trip tests ──────────────────────────────

describe("delegationCodec", () => {
  test("round-trip preserves all fields including deps and security", () => {
    const original = makeTask({
      taskId: "task-round-1",
      targetHarnessType: "gemini-cli",
      priority: 70,
      deadlineMs: 300000,
      dependsOn: ["task-a", "task-b"],
      securityConstraints: {
        noGit: true,
        filesystemAccess: "read-only",
        blockedCommands: ["^rm\\s", "^sudo"],
      },
    });

    const serialized = delegationCodec.serialize(original);
    const headers = {
      priority: serialized.priority,
      correlationId: serialized.correlationId,
      custom: serialized.custom,
    };

    const deserialized = delegationCodec.deserialize("/fake.md", serialized.body, headers);
    expect(deserialized.taskId).toBe("task-round-1");
    expect(deserialized.targetHarnessType).toBe("gemini-cli");
    expect(deserialized.deadlineMs).toBe(300000);
    expect(deserialized.dependsOn).toEqual(["task-a", "task-b"]);
    expect(deserialized.securityConstraints).toEqual(original.securityConstraints);
  });
});

// ─── JobQueue end-to-end tests ──────────────────────────────────────

describe("JobQueue", () => {
  let tempDir: string;
  let queue: JobQueue;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fbmq-test-jq-"));
    queue = new JobQueue({ queueRoot: tempDir });
    await queue.init();
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("enqueue + dequeue round-trip", async () => {
    const job = makeJob({ jobId: "job-e2e-1", instruction: "Build the widget" });
    const msgId = await queue.enqueue(job);
    expect(msgId).toHaveLength(32);

    const depth = await queue.depth();
    expect(depth).toBeGreaterThanOrEqual(1);

    const dequeued = await queue.dequeue();
    expect(dequeued).not.toBeNull();
    expect(dequeued!.jobId).toBe("job-e2e-1");
    expect(dequeued!.instruction).toContain("Build the widget");
    expect(dequeued!._filePath).toContain("processing/");

    await queue.complete(dequeued!._filePath);
  });

  test("dequeue returns null when empty", async () => {
    // Drain first
    let msg = await queue.dequeue();
    while (msg) {
      await queue.complete(msg._filePath);
      msg = await queue.dequeue();
    }
    const result = await queue.dequeue();
    expect(result).toBeNull();
  });

  test("priority ordering: critical before normal", async () => {
    const normal = makeJob({ jobId: "job-normal", priority: 30, instruction: "Normal task" });
    const critical = makeJob({ jobId: "job-critical", priority: 90, instruction: "Critical task" });

    await queue.enqueue(normal);
    await queue.enqueue(critical);

    const first = await queue.dequeue();
    expect(first).not.toBeNull();
    expect(first!.jobId).toBe("job-critical");
    await queue.complete(first!._filePath);

    const second = await queue.dequeue();
    expect(second).not.toBeNull();
    expect(second!.jobId).toBe("job-normal");
    await queue.complete(second!._filePath);
  });
});

// ─── DelegationQueue tests ──────────────────────────────────────────

describe("DelegationQueue", () => {
  let mainDir: string;
  let stagedDir: string;
  let queue: DelegationQueue;

  beforeAll(async () => {
    mainDir = mkdtempSync(join(tmpdir(), "fbmq-test-dq-main-"));
    stagedDir = mkdtempSync(join(tmpdir(), "fbmq-test-dq-staged-"));
    queue = new DelegationQueue({ queueRoot: mainDir }, stagedDir);
    await queue.init();
  });

  afterAll(() => {
    rmSync(mainDir, { recursive: true, force: true });
    rmSync(stagedDir, { recursive: true, force: true });
  });

  test("task without deps goes to main queue", async () => {
    const task = makeTask({ taskId: "task-nodep", dependsOn: [] });
    await queue.enqueue(task);

    expect(await queue.depth()).toBeGreaterThanOrEqual(1);
    expect(await queue.stagedDepth()).toBe(0);
  });

  test("task with deps goes to staged queue", async () => {
    const task = makeTask({ taskId: "task-withdep", dependsOn: ["task-a"] });
    const mainBefore = await queue.depth();
    await queue.enqueue(task);

    expect(await queue.depth()).toBe(mainBefore); // main unchanged
    expect(await queue.stagedDepth()).toBeGreaterThanOrEqual(1);
  });

  test("promoteReady moves tasks with met deps to main", async () => {
    // Drain both queues first
    let msg = await queue.dequeue();
    while (msg) {
      await queue.complete(msg._filePath);
      msg = await queue.dequeue();
    }

    // Stage a task with dependency on "dep-1"
    const task = makeTask({ taskId: "task-promote", dependsOn: ["dep-1"] });
    await queue.enqueue(task);
    expect(await queue.stagedDepth()).toBeGreaterThanOrEqual(1);

    // Promote with dep-1 completed
    await queue.promoteReady(new Set(["dep-1"]));

    // Task should now be in main queue
    const dequeued = await queue.dequeue();
    expect(dequeued).not.toBeNull();
    expect(dequeued!.taskId).toBe("task-promote");
    await queue.complete(dequeued!._filePath);
  });

  test("harness type filtering via nack", async () => {
    const task = makeTask({ taskId: "task-claude-only", targetHarnessType: "claude-code" });
    await queue.enqueue(task);

    // Try to dequeue for gemini — should nack and return null
    const result = await queue.dequeue("gemini-cli");
    expect(result).toBeNull();

    // Should still be in queue (nacked back)
    // Give fbmq a moment to process the nack
    const forClaude = await queue.dequeue("claude-code");
    expect(forClaude).not.toBeNull();
    expect(forClaude!.taskId).toBe("task-claude-only");
    await queue.complete(forClaude!._filePath);
  });
});

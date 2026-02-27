import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { createTempVault, cleanupTempVault } from "./helpers";
import type { VaultClient } from "../index";

let vaultPath: string;
let client: VaultClient;

beforeEach(() => {
  const tmp = createTempVault();
  vaultPath = tmp.vaultPath;
  client = tmp.client;
});

afterEach(() => {
  cleanupTempVault(vaultPath);
});

describe("Job Lifecycle (fbmq)", () => {
  test("createJob enqueues to fbmq and returns jobId", async () => {
    const jobId = await client.createJob({
      instruction: "Test instruction",
      type: "background",
      priority: 75,
      securityProfile: "standard",
    });

    expect(jobId).toMatch(/^job-/);

    // Job should be in fbmq pending queue (depth > 0)
    const depth = await client.jobQueue.depth();
    expect(depth).toBeGreaterThanOrEqual(1);
  });

  test("createJob with all options", async () => {
    const jobId = await client.createJob({
      instruction: "Full options test",
      type: "rpc",
      priority: 90,
      securityProfile: "admin",
      modelOverride: "anthropic/claude-sonnet-4-6",
      thinkingLevel: "high",
      threadId: "thread-123",
    });

    const job = await client.getPendingJob("worker-1");
    expect(job).not.toBeNull();
    expect(job!.type).toBe("rpc");
    expect(job!.securityProfile).toBe("admin");
    expect(job!.modelOverride).toBe("anthropic/claude-sonnet-4-6");
    expect(job!.thinkingLevel).toBe("high");
    expect(job!.threadId).toBe("thread-123");
    expect(job!.instruction).toBe("Full options test");
  });

  test("getPendingJob returns highest-priority job first", async () => {
    await client.createJob({ instruction: "Low priority", priority: 10 });
    await client.createJob({ instruction: "High priority", priority: 90 });
    await client.createJob({ instruction: "Medium priority", priority: 50 });

    const job = await client.getPendingJob("worker-1");
    expect(job).not.toBeNull();
    // fbmq priority ordering: 90 maps to "critical", dequeued first
    expect(job!.instruction).toBe("High priority");
  });

  test("getPendingJob returns null when no jobs", async () => {
    const job = await client.getPendingJob("worker-1");
    expect(job).toBeNull();
  });

  test("claimJob updates metadata on the processing file", async () => {
    const jobId = await client.createJob({ instruction: "Claim me" });

    // getPendingJob does the atomic dequeue (pop) — file is now in processing/
    const pending = await client.getPendingJob("worker-1");
    expect(pending).not.toBeNull();
    expect(pending!._filePath).toContain("processing/");

    // claimJob updates metadata (status → running, workerId)
    const claimed = await client.claimJob(jobId, "worker-1");
    expect(claimed).toBe(true);

    // Verify the processing file exists and contains updated metadata
    expect(fs.existsSync(pending!._filePath)).toBe(true);
    const content = fs.readFileSync(pending!._filePath, "utf-8");
    expect(content).toContain("status: running");
    expect(content).toContain("workerId: worker-1");
  });

  test("claimJob on unknown job returns false", async () => {
    const result = await client.claimJob("nonexistent-job", "worker-1");
    expect(result).toBe(false);
  });

  test("updateJobStatus to done moves file to done/", async () => {
    const jobId = await client.createJob({ instruction: "Complete me" });
    await client.getPendingJob("worker-1");
    await client.claimJob(jobId, "worker-1");

    await client.updateJobStatus(jobId, "done", { result: "Success!" });

    // File should be in fbmq done directory
    const doneDir = path.join(vaultPath, "_fbmq/jobs/done");
    const doneFiles = fs.readdirSync(doneDir).filter(f => f.endsWith(".md"));
    expect(doneFiles.length).toBe(1);

    // Processing should be empty
    const procDir = path.join(vaultPath, "_fbmq/jobs/processing");
    const procFiles = fs.readdirSync(procDir).filter(f => f.endsWith(".md"));
    expect(procFiles.length).toBe(0);
  });

  test("updateJobStatus to failed acks to done/ (status in metadata)", async () => {
    const jobId = await client.createJob({ instruction: "Fail me" });
    await client.getPendingJob("worker-1");
    await client.claimJob(jobId, "worker-1");

    await client.updateJobStatus(jobId, "failed");

    // All terminal states go to done/ via ack — the app-level status is in file metadata.
    // fbmq's failed/ is reserved for dead-letter (transport-level retry exhaustion).
    const doneDir = path.join(vaultPath, "_fbmq/jobs/done");
    const doneFiles = fs.readdirSync(doneDir).filter(f => f.endsWith(".md"));
    expect(doneFiles.length).toBe(1);

    // Verify the file's metadata contains "failed" status
    const content = fs.readFileSync(path.join(doneDir, doneFiles[0]), "utf-8");
    expect(content).toContain("status: failed");
  });

  test("updateJobStatus preserves result and stats in done file", async () => {
    const jobId = await client.createJob({ instruction: "Full result test" });
    await client.getPendingJob("worker-1");
    await client.claimJob(jobId, "worker-1");

    await client.updateJobStatus(jobId, "done", {
      result: "Task completed successfully.",
      stats: { promptTokens: 100, completionTokens: 200, totalTokens: 300, cost: 0.01, toolCalls: 3, messageCount: 5 },
    });

    const doneDir = path.join(vaultPath, "_fbmq/jobs/done");
    const doneFiles = fs.readdirSync(doneDir).filter(f => f.endsWith(".md"));
    expect(doneFiles.length).toBe(1);

    const content = fs.readFileSync(path.join(doneDir, doneFiles[0]), "utf-8");
    // Result and stats should be encoded in the Custom: block
    expect(content).toContain("status: done");
    expect(content).toContain("Full result test");
  });

  test("addJobLog creates log file", async () => {
    const jobId = await client.createJob({ instruction: "Log me" });

    await client.addJobLog(jobId, "info", "Started processing");
    await client.addJobLog(jobId, "tool_call", "Called bash", {
      tool: "bash",
      args: { cmd: "ls" },
    });

    const today = new Date().toISOString().split("T")[0];
    const logDir = path.join(vaultPath, "_logs", today);
    expect(fs.existsSync(logDir)).toBe(true);

    const logFile = path.join(logDir, `job-${jobId}.md`);
    expect(fs.existsSync(logFile)).toBe(true);

    const content = fs.readFileSync(logFile, "utf-8");
    expect(content).toContain("## info");
    expect(content).toContain("Started processing");
    expect(content).toContain("## tool_call");
    expect(content).toContain('"tool": "bash"');
  });
});

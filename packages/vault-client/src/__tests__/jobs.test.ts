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

describe("Job Lifecycle", () => {
  test("createJob creates file in _jobs/pending with correct frontmatter", async () => {
    const jobId = await client.createJob({
      instruction: "Test instruction",
      type: "background",
      priority: 75,
      securityProfile: "standard",
    });

    expect(jobId).toMatch(/^job-\d+-[a-z0-9]+$/);

    const files = fs.readdirSync(path.join(vaultPath, "_jobs/pending"));
    expect(files.length).toBe(1);
    expect(files[0]).toBe(`${jobId}.md`);

    const content = fs.readFileSync(
      path.join(vaultPath, "_jobs/pending", files[0]),
      "utf-8",
    );
    expect(content).toContain("status: pending");
    expect(content).toContain("priority: 75");
    expect(content).toContain("Test instruction");
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
    expect(job!.priority).toBe(90);
    expect(job!.securityProfile).toBe("admin");
    expect(job!.modelOverride).toBe("anthropic/claude-sonnet-4-6");
    expect(job!.thinkingLevel).toBe("high");
    expect(job!.threadId).toBe("thread-123");
  });

  test("getPendingJob returns highest-priority job", async () => {
    await client.createJob({ instruction: "Low priority", priority: 10 });
    await client.createJob({ instruction: "High priority", priority: 90 });
    await client.createJob({ instruction: "Medium priority", priority: 50 });

    const job = await client.getPendingJob("worker-1");
    expect(job).not.toBeNull();
    expect(job!.instruction).toBe("High priority");
    expect(job!.priority).toBe(90);
  });

  test("getPendingJob returns null when no jobs", async () => {
    const job = await client.getPendingJob("worker-1");
    expect(job).toBeNull();
  });

  test("claimJob moves file from pending to running", async () => {
    const jobId = await client.createJob({ instruction: "Claim me" });

    const claimed = await client.claimJob(jobId, "worker-1");
    expect(claimed).toBe(true);

    const pendingFiles = fs.readdirSync(path.join(vaultPath, "_jobs/pending"));
    expect(pendingFiles.filter((f) => f.endsWith(".md")).length).toBe(0);

    const runningFiles = fs.readdirSync(path.join(vaultPath, "_jobs/running"));
    expect(runningFiles.filter((f) => f.endsWith(".md")).length).toBe(1);
  });

  test("claimJob on already-claimed job returns false", async () => {
    const jobId = await client.createJob({ instruction: "Race condition" });

    const first = await client.claimJob(jobId, "worker-1");
    expect(first).toBe(true);

    const second = await client.claimJob(jobId, "worker-2");
    expect(second).toBe(false);
  });

  test("updateJobStatus to done moves file", async () => {
    const jobId = await client.createJob({ instruction: "Complete me" });
    await client.claimJob(jobId, "worker-1");

    await client.updateJobStatus(jobId, "done", { result: "Success!" });

    const doneFiles = fs.readdirSync(path.join(vaultPath, "_jobs/done"));
    expect(doneFiles.filter((f) => f.endsWith(".md")).length).toBe(1);

    const runningFiles = fs.readdirSync(path.join(vaultPath, "_jobs/running"));
    expect(runningFiles.filter((f) => f.endsWith(".md")).length).toBe(0);
  });

  test("updateJobStatus to failed moves file", async () => {
    const jobId = await client.createJob({ instruction: "Fail me" });
    await client.claimJob(jobId, "worker-1");

    await client.updateJobStatus(jobId, "failed");

    const failedFiles = fs.readdirSync(path.join(vaultPath, "_jobs/failed"));
    expect(failedFiles.filter((f) => f.endsWith(".md")).length).toBe(1);
  });

  test("updateJobStatus with streaming text updates body", async () => {
    const jobId = await client.createJob({ instruction: "Stream me" });
    await client.claimJob(jobId, "worker-1");

    await client.updateJobStatus(jobId, "running", {
      streamingText: "Processing step 1...\nProcessing step 2...",
    });

    const runningFiles = fs.readdirSync(path.join(vaultPath, "_jobs/running"));
    const content = fs.readFileSync(
      path.join(vaultPath, "_jobs/running", runningFiles[0]),
      "utf-8",
    );
    expect(content).toContain("## Streaming Output");
    expect(content).toContain("Processing step 1...");
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

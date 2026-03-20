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

describe("End-to-End Integration", () => {
  test("full job lifecycle: create → claim → complete", async () => {
    // 1. Create a job
    const jobId = await client.createJob({
      instruction: "Research and implement feature X",
      type: "background",
      priority: 80,
      securityProfile: "standard",
    });

    // 2. Verify job is pending
    const pendingCount = client.jobQueue.count("pending");
    expect(pendingCount).toBeGreaterThanOrEqual(1);

    // 3. Dequeue the job (atomic rename — file moves to running/)
    const pendingJob = await client.getPendingJob("hq-worker");
    expect(pendingJob).not.toBeNull();
    expect(pendingJob!.jobId).toBe(jobId);
    expect(pendingJob!.instruction).toBe("Research and implement feature X");
    expect(pendingJob!._filePath).toContain("running/");

    // 4. Claim the job (update metadata on running file)
    const claimed = await client.claimJob(jobId, "hq-worker");
    expect(claimed).toBe(true);

    // 5. Verify no more pending jobs
    const noPending = await client.getPendingJob("hq-worker");
    expect(noPending).toBeNull();

    // 6. Complete the job
    await client.updateJobStatus(jobId, "done", {
      result: "Feature X fully implemented.",
    });

    // 7. Verify file is in done/
    const doneDir = path.join(vaultPath, "_jobs/done");
    const doneFiles = fs.readdirSync(doneDir).filter(f => f.endsWith(".md"));
    expect(doneFiles.length).toBe(1);

    // Running should be empty
    const runningDir = path.join(vaultPath, "_jobs/running");
    const runningFiles = fs.readdirSync(runningDir).filter(f => f.endsWith(".md"));
    expect(runningFiles.length).toBe(0);
  });

  test("task lifecycle: submit → claim → complete", async () => {
    const jobId = "workflow-test-123";

    // 1. Submit a task
    await client.submitTask(jobId, {
      taskId: "task-1",
      instruction: "Implement the login page",
      targetHarnessType: "claude-code",
    });

    // 2. Verify it's pending
    const pendingCount = client.taskQueue.count("pending");
    expect(pendingCount).toBe(1);

    // 3. Get task by ID
    const task = await client.getTask("task-1");
    expect(task).not.toBeNull();
    expect(task!.jobId).toBe(jobId);
    expect(task!.instruction).toBe("Implement the login page");

    // 4. Get tasks for job
    const tasks = await client.getTasksForJob(jobId);
    expect(tasks.length).toBe(1);

    // 5. Claim the task
    const claimed = await client.claimTask("task-1", "worker-1");
    expect(claimed).toBe(true);

    // 6. Complete the task
    await client.completeTask("task-1", "Login page implemented successfully");

    // 7. Verify completed
    const completed = await client.getTask("task-1");
    expect(completed!.status).toBe("completed");
    expect(completed!.result).toBe("Login page implemented successfully");
  });

  test("full note lifecycle: create → search → update → pin", async () => {
    // Create several notes
    await client.createNote("Projects", "AI Project", "Building an AI assistant with RAG", {
      tags: ["ai", "project"],
    });
    await client.createNote("Memories", "Meeting Notes", "Discussed ML pipeline design", {
      tags: ["meeting"],
    });
    await client.createNote("Projects", "Web App", "React frontend with Next.js", {
      tags: ["web", "project"],
    });

    // Search finds relevant notes
    const searchResults = await client.searchNotes("AI assistant");
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].title).toBe("AI Project");

    // Update a note
    const notes = await client.listNotes("Projects");
    const aiNote = notes.find((n) => n.title === "AI Project")!;
    await client.updateNote(aiNote._filePath, undefined, { pinned: true });

    // Pinned notes includes it
    const pinned = await client.getPinnedNotes();
    expect(pinned.some((n) => n.title === "AI Project")).toBe(true);

    // Agent context includes pinned notes
    const ctx = await client.getAgentContext();
    expect(ctx.pinnedNotes.some((n) => n.title === "AI Project")).toBe(true);
  });

  test("approval lifecycle: create → check → resolve", async () => {
    // Create approval
    const id = await client.createApproval({
      title: "Deploy to production",
      description: "Deploy v2.0 to production servers",
      toolName: "bash",
      toolArgs: { cmd: "deploy --prod" },
      riskLevel: "high",
      jobId: "job-deploy",
    });

    // Check — should be pending
    const pending = await client.getApproval(id);
    expect(pending!.status).toBe("pending");

    // Resolve
    await client.resolveApproval(id, "approved", "admin-user");

    // Check — should be approved
    const resolved = await client.getApproval(id);
    expect(resolved!.status).toBe("approved");
    expect(resolved!.resolvedBy).toBe("admin-user");
  });

  test("usage tracking logs entries", async () => {
    await client.logUsage(
      "anthropic/claude-sonnet-4-6",
      { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    );

    const today = new Date().toISOString().split("T")[0];
    const dailyFile = path.join(vaultPath, "_usage/daily", `${today}.md`);
    expect(fs.existsSync(dailyFile)).toBe(true);

    const content = fs.readFileSync(dailyFile, "utf-8");
    expect(content).toContain("anthropic/claude-sonnet-4-6");
    expect(content).toContain("1000");
    expect(content).toContain("500");
  });
});

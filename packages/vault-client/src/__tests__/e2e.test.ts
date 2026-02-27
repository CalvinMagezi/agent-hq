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

describe("End-to-End Integration (fbmq)", () => {
  test("full job lifecycle: create → claim → complete", async () => {
    // 1. Create a job
    const jobId = await client.createJob({
      instruction: "Research and implement feature X",
      type: "background",
      priority: 80,
      securityProfile: "standard",
    });

    // 2. Verify job is pending (depth > 0)
    const depth = await client.jobQueue.depth();
    expect(depth).toBeGreaterThanOrEqual(1);

    // 3. Dequeue the job (atomic pop — file moves to processing/)
    const pendingJob = await client.getPendingJob("hq-worker");
    expect(pendingJob).not.toBeNull();
    expect(pendingJob!.jobId).toBe(jobId);
    expect(pendingJob!.instruction).toBe("Research and implement feature X");
    expect(pendingJob!._filePath).toContain("processing/");

    // 4. Claim the job (update metadata on processing file)
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
    const doneDir = path.join(vaultPath, "_fbmq/jobs/done");
    const doneFiles = fs.readdirSync(doneDir).filter(f => f.endsWith(".md"));
    expect(doneFiles.length).toBe(1);

    // Processing should be empty
    const procDir = path.join(vaultPath, "_fbmq/jobs/processing");
    const procFiles = fs.readdirSync(procDir).filter(f => f.endsWith(".md"));
    expect(procFiles.length).toBe(0);
  });

  test("delegation lifecycle: create tasks → promote deps → dequeue → complete", async () => {
    // 1. Create parent job
    const jobId = await client.createJob({
      instruction: "Orchestrate feature X",
      type: "background",
      priority: 80,
    });
    await client.getPendingJob("hq-worker");
    await client.claimJob(jobId, "hq-worker");

    // 2. Create delegation tasks
    //    research-1 has no deps → goes to main queue
    //    code-1 depends on research-1 → goes to staged queue
    await client.createDelegatedTasks(jobId, [
      {
        taskId: "research-1",
        instruction: "Research existing implementations of feature X",
        targetHarnessType: "gemini-cli",
        priority: 90,
      },
      {
        taskId: "code-1",
        instruction: "Implement feature X based on research",
        targetHarnessType: "claude-code",
        dependsOn: ["research-1"],
      },
    ]);

    // 3. Main queue should have research-1, staged should have code-1
    const mainDepth = await client.delegationQueue.depth();
    const stagedDepth = await client.delegationQueue.stagedDepth();
    expect(mainDepth).toBeGreaterThanOrEqual(1);
    expect(stagedDepth).toBeGreaterThanOrEqual(1);

    // 4. Gemini relay dequeues research-1
    const geminiTasks = await client.getPendingTasks("gemini-cli");
    expect(geminiTasks.length).toBe(1);
    expect(geminiTasks[0].taskId).toBe("research-1");

    // 5. Claude-code should get nothing (code-1 is still staged)
    const claudeTasks = await client.getPendingTasks("claude-code");
    expect(claudeTasks.length).toBe(0);

    // 6. Claim and complete research-1
    const taskClaimed = await client.claimTask("research-1", "discord-relay-gemini-cli");
    expect(taskClaimed).toBe(true);

    await client.updateTaskStatus("research-1", "completed", "Found 3 implementations...");

    // 7. Promote ready tasks — code-1's dependency is now met
    await client.delegationQueue.promoteReady(new Set(["research-1"]));

    // 8. Now claude-code should see code-1
    const unblocked = await client.getPendingTasks("claude-code");
    expect(unblocked.length).toBe(1);
    expect(unblocked[0].taskId).toBe("code-1");

    // 9. Claim and complete code-1
    await client.claimTask("code-1", "discord-relay-claude-code");
    await client.updateTaskStatus("code-1", "completed", "Feature X implemented.");

    // 10. Complete the parent job
    await client.updateJobStatus(jobId, "done", {
      result: "Feature X fully implemented with research and code.",
    });

    // 11. Verify final state
    const jobDoneDir = path.join(vaultPath, "_fbmq/jobs/done");
    const jobDoneFiles = fs.readdirSync(jobDoneDir).filter(f => f.endsWith(".md"));
    expect(jobDoneFiles.length).toBe(1);

    const delegDoneDir = path.join(vaultPath, "_fbmq/delegation/done");
    const delegDoneFiles = fs.readdirSync(delegDoneDir).filter(f => f.endsWith(".md"));
    expect(delegDoneFiles.length).toBe(2); // research-1 + code-1
  });

  test("priority ordering: critical jobs processed before normal", async () => {
    await client.createJob({ instruction: "Low priority task", priority: 10 });
    await client.createJob({ instruction: "Critical task", priority: 95 });
    await client.createJob({ instruction: "Medium task", priority: 50 });

    // Dequeue order should respect priority: critical → high → normal → low
    const first = await client.getPendingJob("worker");
    expect(first).not.toBeNull();
    expect(first!.instruction).toBe("Critical task");
    await client.updateJobStatus(first!.jobId, "done");

    const second = await client.getPendingJob("worker");
    expect(second).not.toBeNull();
    expect(second!.instruction).toBe("Medium task");
    await client.updateJobStatus(second!.jobId, "done");

    const third = await client.getPendingJob("worker");
    expect(third).not.toBeNull();
    expect(third!.instruction).toBe("Low priority task");
    await client.updateJobStatus(third!.jobId, "done");
  });

  test("harness type filtering: only matching relay gets task", async () => {
    const jobId = await client.createJob({
      instruction: "Delegated work",
      type: "background",
    });
    await client.getPendingJob("worker");
    await client.claimJob(jobId, "worker");

    await client.createDelegatedTasks(jobId, [
      {
        taskId: "claude-task",
        instruction: "Only for Claude Code",
        targetHarnessType: "claude-code",
        priority: 80,
      },
    ]);

    // Gemini relay should not get this task
    const geminiResult = await client.getPendingTasks("gemini-cli");
    expect(geminiResult.length).toBe(0);

    // Claude relay should get it
    const claudeResult = await client.getPendingTasks("claude-code");
    expect(claudeResult.length).toBe(1);
    expect(claudeResult[0].taskId).toBe("claude-task");
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

  test("relay health lifecycle: register → heartbeat → check", async () => {
    // Register relay
    await client.upsertRelayHealth("relay-claude", {
      harnessType: "claude-code",
      displayName: "Claude Code Relay",
      status: "healthy",
      capabilities: ["code", "git"],
    });

    // Check health
    const relays = await client.getRelayHealthAll();
    const claude = relays.find((r) => r.relayId === "relay-claude");
    expect(claude).toBeDefined();
    expect(claude!.status).toBe("healthy");
    expect(claude!.capabilities).toContain("code");

    // Update to degraded
    await client.upsertRelayHealth("relay-claude", {
      status: "degraded",
    });

    const updated = await client.getRelayHealthAll();
    const updatedClaude = updated.find((r) => r.relayId === "relay-claude");
    expect(updatedClaude!.status).toBe("degraded");
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

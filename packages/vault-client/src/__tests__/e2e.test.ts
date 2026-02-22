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
  test("full job lifecycle: create → claim → delegate → complete", async () => {
    // 1. Create a job
    const jobId = await client.createJob({
      instruction: "Research and implement feature X",
      type: "background",
      priority: 80,
      securityProfile: "standard",
    });

    // 2. Verify job is pending
    const pendingJob = await client.getPendingJob("hq-worker");
    expect(pendingJob).not.toBeNull();
    expect(pendingJob!.jobId).toBe(jobId);
    expect(pendingJob!.instruction).toBe("Research and implement feature X");

    // 3. Claim the job
    const claimed = await client.claimJob(jobId, "hq-worker");
    expect(claimed).toBe(true);

    // 4. Verify no more pending jobs
    const noPending = await client.getPendingJob("hq-worker");
    expect(noPending).toBeNull();

    // 5. Create delegation tasks
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

    // 6. Verify gemini-cli can see its task (no dependencies)
    const geminiTasks = await client.getPendingTasks("gemini-cli");
    expect(geminiTasks.length).toBe(1);
    expect(geminiTasks[0].taskId).toBe("research-1");

    // 7. Verify claude-code task is blocked
    const claudeTasks = await client.getPendingTasks("claude-code");
    expect(claudeTasks.length).toBe(0); // Blocked by research-1

    // 8. Relay claims the research task
    const taskClaimed = await client.claimTask("research-1", "discord-relay-gemini-cli");
    expect(taskClaimed).toBe(true);

    // 9. Complete the research task
    await client.updateTaskStatus("research-1", "completed", "Found 3 implementations...");

    // 10. Now claude-code task should be unblocked
    const unblocked = await client.getPendingTasks("claude-code");
    expect(unblocked.length).toBe(1);
    expect(unblocked[0].taskId).toBe("code-1");

    // 11. Claim and complete the code task
    await client.claimTask("code-1", "discord-relay-claude-code");
    await client.updateTaskStatus("code-1", "completed", "Feature X implemented in 3 files.");

    // 12. Verify all tasks for the job
    const allTasks = await client.getTasksForJob(jobId);
    expect(allTasks.length).toBe(2);
    expect(allTasks.every((t) => t.status === "completed")).toBe(true);

    // 13. Complete the parent job
    await client.updateJobStatus(jobId, "done", {
      result: "Feature X fully implemented with research and code.",
    });

    // 14. Verify files are in correct directories
    const pending = fs.readdirSync(path.join(vaultPath, "_jobs/pending"));
    const running = fs.readdirSync(path.join(vaultPath, "_jobs/running"));
    const done = fs.readdirSync(path.join(vaultPath, "_jobs/done"));
    expect(pending.filter((f) => f.endsWith(".md")).length).toBe(0);
    expect(running.filter((f) => f.endsWith(".md")).length).toBe(0);
    expect(done.filter((f) => f.endsWith(".md")).length).toBe(1);

    const delPending = fs.readdirSync(path.join(vaultPath, "_delegation/pending"));
    const delClaimed = fs.readdirSync(path.join(vaultPath, "_delegation/claimed"));
    const delCompleted = fs.readdirSync(path.join(vaultPath, "_delegation/completed"));
    expect(delPending.filter((f) => f.endsWith(".md")).length).toBe(0);
    expect(delClaimed.filter((f) => f.endsWith(".md")).length).toBe(0);
    expect(delCompleted.filter((f) => f.endsWith(".md")).length).toBe(2);
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

    // Update to busy
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

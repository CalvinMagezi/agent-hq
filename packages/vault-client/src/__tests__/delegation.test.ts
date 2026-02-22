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

describe("Delegation", () => {
  test("createDelegatedTasks creates files in pending", async () => {
    await client.createDelegatedTasks("job-123", [
      {
        taskId: "task-1",
        instruction: "Do research",
        targetHarnessType: "gemini-cli",
        priority: 80,
      },
      {
        taskId: "task-2",
        instruction: "Write code",
        targetHarnessType: "claude-code",
      },
    ]);

    const files = fs.readdirSync(path.join(vaultPath, "_delegation/pending"));
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    expect(mdFiles.length).toBe(2);
    expect(mdFiles.sort()).toEqual(["task-task-1.md", "task-task-2.md"]);
  });

  test("getPendingTasks filters by harness type", async () => {
    await client.createDelegatedTasks("job-123", [
      { taskId: "t1", instruction: "For claude", targetHarnessType: "claude-code" },
      { taskId: "t2", instruction: "For gemini", targetHarnessType: "gemini-cli" },
      { taskId: "t3", instruction: "For any", targetHarnessType: "any" },
    ]);

    const claudeTasks = await client.getPendingTasks("claude-code");
    expect(claudeTasks.length).toBe(2); // t1 + t3 (any)
    const taskIds = claudeTasks.map((t) => t.taskId).sort();
    expect(taskIds).toEqual(["t1", "t3"]);

    const geminiTasks = await client.getPendingTasks("gemini-cli");
    expect(geminiTasks.length).toBe(2); // t2 + t3 (any)
  });

  test("claimTask moves from pending to claimed", async () => {
    await client.createDelegatedTasks("job-123", [
      { taskId: "claim-me", instruction: "Test", targetHarnessType: "claude-code" },
    ]);

    const claimed = await client.claimTask("claim-me", "relay-1");
    expect(claimed).toBe(true);

    const pendingFiles = fs.readdirSync(path.join(vaultPath, "_delegation/pending"));
    expect(pendingFiles.filter((f) => f.endsWith(".md")).length).toBe(0);

    const claimedFiles = fs.readdirSync(path.join(vaultPath, "_delegation/claimed"));
    expect(claimedFiles.filter((f) => f.endsWith(".md")).length).toBe(1);
  });

  test("double-claim returns false", async () => {
    await client.createDelegatedTasks("job-123", [
      { taskId: "race-me", instruction: "Test", targetHarnessType: "any" },
    ]);

    const first = await client.claimTask("race-me", "relay-1");
    expect(first).toBe(true);

    const second = await client.claimTask("race-me", "relay-2");
    expect(second).toBe(false);
  });

  test("updateTaskStatus to completed moves to completed dir", async () => {
    await client.createDelegatedTasks("job-123", [
      { taskId: "complete-me", instruction: "Test", targetHarnessType: "any" },
    ]);
    await client.claimTask("complete-me", "relay-1");

    await client.updateTaskStatus("complete-me", "completed", "The result text");

    const completedFiles = fs.readdirSync(path.join(vaultPath, "_delegation/completed"));
    expect(completedFiles.filter((f) => f.endsWith(".md")).length).toBe(1);

    const content = fs.readFileSync(
      path.join(vaultPath, "_delegation/completed", completedFiles[0]),
      "utf-8",
    );
    expect(content).toContain("status: completed");
    expect(content).toContain("result: The result text");
  });

  test("getTasksForJob returns tasks across all status dirs", async () => {
    await client.createDelegatedTasks("job-456", [
      { taskId: "t-a", instruction: "Pending", targetHarnessType: "any" },
      { taskId: "t-b", instruction: "Will claim", targetHarnessType: "any" },
      { taskId: "t-c", instruction: "Will complete", targetHarnessType: "any" },
    ]);

    await client.claimTask("t-b", "relay-1");
    await client.claimTask("t-c", "relay-2");
    await client.updateTaskStatus("t-c", "completed", "Done");

    const tasks = await client.getTasksForJob("job-456");
    expect(tasks.length).toBe(3);

    const statuses = tasks.map((t) => t.status).sort();
    expect(statuses).toEqual(["claimed", "completed", "pending"]);
  });

  test("tasks with dependsOn are not returned until dependencies complete", async () => {
    await client.createDelegatedTasks("job-789", [
      { taskId: "dep-1", instruction: "First", targetHarnessType: "any" },
      {
        taskId: "dep-2",
        instruction: "Depends on dep-1",
        targetHarnessType: "any",
        dependsOn: ["dep-1"],
      },
    ]);

    // dep-2 should NOT appear since dep-1 is not completed
    const before = await client.getPendingTasks("claude-code");
    expect(before.length).toBe(1);
    expect(before[0].taskId).toBe("dep-1");

    // Complete dep-1
    await client.claimTask("dep-1", "relay-1");
    await client.updateTaskStatus("dep-1", "completed", "Done");

    // Now dep-2 should appear
    const after = await client.getPendingTasks("claude-code");
    expect(after.length).toBe(1);
    expect(after[0].taskId).toBe("dep-2");
  });

  test("getRelayHealthAll reads relay health files", async () => {
    // Create a relay health file
    await client.upsertRelayHealth("relay-test", {
      harnessType: "claude-code",
      displayName: "Test Relay",
      status: "healthy",
      capabilities: ["code", "git"],
    });

    const relays = await client.getRelayHealthAll();
    expect(relays.length).toBeGreaterThanOrEqual(1);

    const testRelay = relays.find((r) => r.relayId === "relay-test");
    expect(testRelay).toBeDefined();
    expect(testRelay!.harnessType).toBe("claude-code");
    expect(testRelay!.capabilities).toEqual(["code", "git"]);
  });

  test("upsertRelayHealth creates and updates", async () => {
    // Create
    await client.upsertRelayHealth("relay-new", {
      harnessType: "opencode",
      displayName: "New Relay",
      status: "offline",
    });

    let relays = await client.getRelayHealthAll();
    let relay = relays.find((r) => r.relayId === "relay-new");
    expect(relay!.status).toBe("offline");

    // Update
    await client.upsertRelayHealth("relay-new", {
      status: "healthy",
    });

    relays = await client.getRelayHealthAll();
    relay = relays.find((r) => r.relayId === "relay-new");
    expect(relay!.status).toBe("healthy");
  });
});

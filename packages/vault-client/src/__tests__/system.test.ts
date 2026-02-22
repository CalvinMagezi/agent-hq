import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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

describe("System Context", () => {
  test("getAgentContext reads all system files", async () => {
    const ctx = await client.getAgentContext();

    expect(ctx.soul).toContain("helpful AI assistant");
    expect(ctx.memory).toContain("Key Facts");
    expect(ctx.preferences).toContain("Preferences");
    expect(ctx.heartbeat).toContain("Heartbeat");
    expect(ctx.config).toBeDefined();
    expect(ctx.config.DEFAULT_MODEL).toBe("test-model");
  });

  test("getAgentContext includes pinned notes", async () => {
    await client.createNote("Projects", "Pinned Note", "Important context", {
      pinned: true,
    });

    const ctx = await client.getAgentContext();
    expect(ctx.pinnedNotes.length).toBe(1);
    expect(ctx.pinnedNotes[0].title).toBe("Pinned Note");
  });

  test("getSetting returns config value", async () => {
    const model = await client.getSetting("DEFAULT_MODEL");
    expect(model).toBe("test-model");
  });

  test("getSetting returns null for missing key", async () => {
    const missing = await client.getSetting("NONEXISTENT_KEY");
    expect(missing).toBeNull();
  });

  test("setSetting creates new key", async () => {
    await client.setSetting("NEW_KEY", "new_value");

    const value = await client.getSetting("NEW_KEY");
    expect(value).toBe("new_value");
  });

  test("setSetting updates existing key", async () => {
    await client.setSetting("DEFAULT_MODEL", "updated-model");

    const value = await client.getSetting("DEFAULT_MODEL");
    expect(value).toBe("updated-model");
  });

  test("settings persist across reads", async () => {
    await client.setSetting("PERSIST_KEY", "persist_value");

    // Re-read
    const val1 = await client.getSetting("PERSIST_KEY");
    const val2 = await client.getSetting("PERSIST_KEY");
    expect(val1).toBe("persist_value");
    expect(val2).toBe("persist_value");
  });
});

describe("Worker Heartbeat", () => {
  test("workerHeartbeat creates session file", async () => {
    await client.workerHeartbeat("worker-test", {
      status: "online",
      currentJobId: null,
    });

    // Verify file was created in _agent-sessions/
    const { default: fs } = await import("fs");
    const { default: path } = await import("path");
    const sessionFile = path.join(vaultPath, "_agent-sessions", "worker-worker-test.md");
    expect(fs.existsSync(sessionFile)).toBe(true);

    const content = fs.readFileSync(sessionFile, "utf-8");
    expect(content).toContain("workerId: worker-test");
    expect(content).toContain("status: online");
  });

  test("workerHeartbeat updates existing session", async () => {
    await client.workerHeartbeat("worker-test", { status: "online" });
    await client.workerHeartbeat("worker-test", {
      status: "busy",
      currentJobId: "job-123",
    });

    const { default: fs } = await import("fs");
    const { default: path } = await import("path");
    const sessionFile = path.join(vaultPath, "_agent-sessions", "worker-worker-test.md");
    const content = fs.readFileSync(sessionFile, "utf-8");
    expect(content).toContain("status: busy");
    expect(content).toContain("currentJobId: job-123");
  });
});

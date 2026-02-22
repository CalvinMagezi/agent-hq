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

describe("Threads", () => {
  test("createThread creates file in active", async () => {
    const threadId = await client.createThread("Test Conversation");

    expect(threadId).toMatch(/^thread-\d+-[a-z0-9]+$/);

    const files = fs.readdirSync(path.join(vaultPath, "_threads/active"));
    expect(files.filter((f) => f.endsWith(".md")).length).toBe(1);

    const content = fs.readFileSync(
      path.join(vaultPath, "_threads/active", files[0]),
      "utf-8",
    );
    expect(content).toContain("status: active");
    expect(content).toContain("# Test Conversation");
  });

  test("createThread with default title", async () => {
    const threadId = await client.createThread();

    const threads = await client.listThreads();
    expect(threads.length).toBe(1);
    expect(threads[0].title).toBe("New Conversation");
  });

  test("appendMessage adds message to thread", async () => {
    const threadId = await client.createThread("Chat");

    await client.appendMessage(threadId, "user", "Hello!");
    await client.appendMessage(threadId, "assistant", "Hi there! How can I help?");

    const filePath = path.join(vaultPath, "_threads/active", `${threadId}.md`);
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).toContain("## User");
    expect(content).toContain("Hello!");
    expect(content).toContain("## Assistant");
    expect(content).toContain("Hi there! How can I help?");
  });

  test("appendMessage throws for missing thread", async () => {
    await expect(
      client.appendMessage("nonexistent-thread", "user", "Hello"),
    ).rejects.toThrow("Thread not found");
  });

  test("listThreads returns all active threads", async () => {
    await client.createThread("Thread One");
    await client.createThread("Thread Two");
    await client.createThread("Thread Three");

    const threads = await client.listThreads();
    expect(threads.length).toBe(3);

    const titles = threads.map((t) => t.title).sort();
    expect(titles).toEqual(["Thread One", "Thread Three", "Thread Two"]);
  });

  test("listThreads returns empty for no threads", async () => {
    const threads = await client.listThreads();
    expect(threads.length).toBe(0);
  });
});

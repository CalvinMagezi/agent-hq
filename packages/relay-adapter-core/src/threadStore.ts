/**
 * VaultThreadStore — cross-platform conversation thread persistence.
 *
 * Stores thread JSON at `.vault/_threads/{threadId}.json`.
 * Flat directory — all platforms share one folder. `originPlatform`
 * field used for filtering. Thread context is trimmed to ~maxTokens
 * by character count approximation when building system context.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import type { PlatformId } from "./platformBridge.js";

// ─── Types ────────────────────────────────────────────────────────

export interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Which harness produced this message (assistant only). */
  harness?: string;
}

export interface Thread {
  id: string;
  originPlatform: PlatformId;
  title?: string;
  activeHarness: string;
  messages: ThreadMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ThreadMeta {
  id: string;
  originPlatform: PlatformId;
  title?: string;
  activeHarness: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadStore {
  createThread(opts: { platform: PlatformId; harness: string; title?: string }): Promise<string>;
  getThread(threadId: string): Promise<Thread | null>;
  appendMessage(threadId: string, msg: ThreadMessage): Promise<void>;
  listThreads(opts?: { platform?: PlatformId; limit?: number }): Promise<ThreadMeta[]>;
  forkThread(sourceThreadId: string, targetPlatform: PlatformId): Promise<string>;
  getThreadContext(threadId: string, maxTokens?: number): Promise<string>;
  setActiveHarness(threadId: string, harness: string): Promise<void>;
  getActiveHarness(threadId: string): Promise<string>;
}

// ─── Implementation ───────────────────────────────────────────────

/** Approximate chars per token. */
const CHARS_PER_TOKEN = 4;

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class VaultThreadStore implements ThreadStore {
  private threadsDir: string;

  constructor(vaultRoot = ".vault") {
    this.threadsDir = join(vaultRoot, "_threads");
  }

  private ensureDir(): void {
    if (!existsSync(this.threadsDir)) {
      mkdirSync(this.threadsDir, { recursive: true });
    }
  }

  private static SAFE_ID = /^[a-zA-Z0-9_-]{1,120}$/;

  private threadPath(threadId: string): string {
    if (!VaultThreadStore.SAFE_ID.test(threadId)) {
      throw new Error(`Invalid thread ID: ${threadId}`);
    }
    return join(this.threadsDir, `${threadId}.json`);
  }

  private readThread(threadId: string): Thread | null {
    const p = this.threadPath(threadId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as Thread;
    } catch {
      return null;
    }
  }

  private writeThread(thread: Thread): void {
    this.ensureDir();
    writeFileSync(this.threadPath(thread.id), JSON.stringify(thread, null, 2), "utf-8");
  }

  async createThread(opts: { platform: PlatformId; harness: string; title?: string }): Promise<string> {
    const id = generateId();
    const now = Date.now();
    const thread: Thread = {
      id,
      originPlatform: opts.platform,
      title: opts.title,
      activeHarness: opts.harness,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.writeThread(thread);
    return id;
  }

  async getThread(threadId: string): Promise<Thread | null> {
    return this.readThread(threadId);
  }

  async appendMessage(threadId: string, msg: ThreadMessage): Promise<void> {
    const thread = this.readThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    thread.messages.push(msg);
    thread.updatedAt = Date.now();
    this.writeThread(thread);
  }

  async listThreads(opts?: { platform?: PlatformId; limit?: number }): Promise<ThreadMeta[]> {
    this.ensureDir();
    let files: string[];
    try {
      files = readdirSync(this.threadsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const threads: ThreadMeta[] = [];
    for (const f of files) {
      const threadId = f.replace(".json", "");
      const t = this.readThread(threadId);
      if (!t) continue;
      if (opts?.platform && t.originPlatform !== opts.platform) continue;
      threads.push({
        id: t.id,
        originPlatform: t.originPlatform,
        title: t.title,
        activeHarness: t.activeHarness,
        messageCount: t.messages.length,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      });
    }

    // Sort by most recent first
    threads.sort((a, b) => b.updatedAt - a.updatedAt);
    return opts?.limit ? threads.slice(0, opts.limit) : threads;
  }

  async forkThread(sourceThreadId: string, targetPlatform: PlatformId): Promise<string> {
    const source = this.readThread(sourceThreadId);
    if (!source) throw new Error(`Source thread not found: ${sourceThreadId}`);

    const newId = generateId();
    const now = Date.now();
    const forked: Thread = {
      id: newId,
      originPlatform: targetPlatform,
      title: source.title ? `${source.title} (fork)` : undefined,
      activeHarness: source.activeHarness,
      messages: [...source.messages],
      createdAt: now,
      updatedAt: now,
    };
    this.writeThread(forked);
    return newId;
  }

  async getThreadContext(threadId: string, maxTokens = 4000): Promise<string> {
    const thread = this.readThread(threadId);
    if (!thread || thread.messages.length === 0) return "";

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const lines: string[] = [];
    let totalChars = 0;

    // Walk messages in reverse, collect until budget exceeded
    const selected: ThreadMessage[] = [];
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const msg = thread.messages[i];
      const chars = msg.content.length + 20; // 20 for role header
      if (totalChars + chars > maxChars && selected.length > 0) break;
      selected.unshift(msg);
      totalChars += chars;
    }

    for (const msg of selected) {
      const roleLabel = msg.role === "user" ? "User" : `Assistant (${msg.harness ?? "relay"})`;
      lines.push(`**${roleLabel}**: ${msg.content}`);
    }

    return lines.join("\n\n");
  }

  async setActiveHarness(threadId: string, harness: string): Promise<void> {
    const thread = this.readThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    thread.activeHarness = harness;
    thread.updatedAt = Date.now();
    this.writeThread(thread);
  }

  async getActiveHarness(threadId: string): Promise<string> {
    const thread = this.readThread(threadId);
    return thread?.activeHarness ?? "auto";
  }
}

import { spawn } from "bun";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { BaseHarness, ChunkCallback, HarnessCallOptions, HarnessUsageStats } from "./base.js";
import type { ChannelSettings } from "../types.js";

const SESSION_FILE = "sessions.json";
const SETTINGS_FILE = "channel-settings.json";
const USAGE_FILE = "usage.json";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONCURRENT_CALLS = 3;

interface CodexSession {
  threadId: string;
  lastActivity: string;
  channelId: string;
}

interface SessionStore {
  sessions: Record<string, CodexSession>;
}

export interface CodexConfig {
  codexPath: string;
  projectDir?: string;
  relayDir: string;
  defaultModel?: string;
}

/**
 * Codex CLI harness (codex exec --json).
 *
 * Codex CLI is a non-interactive agent tool. It supports session resumption
 * via thread IDs. The system instruction is prepended to each prompt since
 * Codex does not have a separate system prompt flag (it auto-reads AGENTS.md,
 * but we need dynamic context per message).
 *
 * JSONL output shape (one event per line):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
 *
 * CLI usage:
 *   codex exec --json --dangerously-bypass-approvals-and-sandbox [-m model] [-C dir] "prompt"
 *   codex exec resume <thread_id> --json --dangerously-bypass-approvals-and-sandbox "follow-up"
 */
export class CodexHarness implements BaseHarness {
  readonly harnessName = "Codex CLI" as const;

  private config: CodexConfig;
  private sessions: SessionStore = { sessions: {} };
  private channelSettings: Record<string, ChannelSettings> = {};
  private activeProcesses = new Set<string>();
  private activeProcs = new Map<string, { kill(signal?: number): void }>();
  private killedChannels = new Set<string>();
  private globalActiveCount = 0;
  private usage: HarnessUsageStats = {
    totalCostUsd: 0,
    totalTurns: 0,
    totalCalls: 0,
    lastCallCostUsd: 0,
    lastCallAt: "",
    byModel: {},
  };

  constructor(config: CodexConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    await mkdir(this.config.relayDir, { recursive: true });

    try {
      const raw = await readFile(join(this.config.relayDir, SESSION_FILE), "utf-8");
      this.sessions = JSON.parse(raw);
      const count = Object.keys(this.sessions.sessions).length;
      if (count > 0) console.log(`[Codex] Loaded ${count} saved session(s)`);
    } catch {
      this.sessions = { sessions: {} };
    }

    try {
      const raw = await readFile(join(this.config.relayDir, SETTINGS_FILE), "utf-8");
      this.channelSettings = JSON.parse(raw);
    } catch {
      this.channelSettings = {};
    }

    try {
      const raw = await readFile(join(this.config.relayDir, USAGE_FILE), "utf-8");
      this.usage = JSON.parse(raw);
    } catch {
      // Fresh usage stats
    }
  }

  kill(channelId: string): boolean {
    const proc = this.activeProcs.get(channelId);
    if (!proc) return false;
    this.killedChannels.add(channelId);
    proc.kill();
    return true;
  }

  async call(
    prompt: string,
    channelId: string,
    options?: HarnessCallOptions,
  ): Promise<string> {
    if (this.activeProcesses.has(channelId)) {
      return "I'm still working on your previous message. Please wait, or use `!reset` to start fresh.";
    }
    if (this.globalActiveCount >= MAX_CONCURRENT_CALLS) {
      return "All Codex slots are busy right now. Please try again in a moment.";
    }

    this.activeProcesses.add(channelId);
    this.globalActiveCount++;

    try {
      return await this.spawnOnce(prompt, channelId, options);
    } finally {
      this.activeProcesses.delete(channelId);
      this.globalActiveCount--;
    }
  }

  async callWithChunks(
    prompt: string,
    channelId: string,
    options?: HarnessCallOptions,
    onChunk?: ChunkCallback,
  ): Promise<string> {
    if (this.activeProcesses.has(channelId)) {
      return "I'm still working on your previous message. Please wait, or use `!reset` to start fresh.";
    }
    if (this.globalActiveCount >= MAX_CONCURRENT_CALLS) {
      return "All Codex slots are busy right now. Please try again in a moment.";
    }

    this.activeProcesses.add(channelId);
    this.globalActiveCount++;

    try {
      return await this.spawnOnce(prompt, channelId, options, onChunk);
    } finally {
      this.activeProcesses.delete(channelId);
      this.globalActiveCount--;
    }
  }

  private async spawnOnce(
    prompt: string,
    channelId: string,
    options?: HarnessCallOptions,
    onChunk?: ChunkCallback,
  ): Promise<string> {
    const settings = {
      ...this.channelSettings[channelId],
      ...options?.channelSettings,
    };

    const existingSession = this.sessions.sessions[channelId];

    // Build args: resume existing session or start fresh
    const args: string[] = [this.config.codexPath, "exec"];

    if (!options?.continueSession && existingSession?.threadId) {
      // Resume using the stored thread ID
      args.push("resume", existingSession.threadId);
    }

    args.push(
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
    );

    const model = settings.model || this.config.defaultModel;
    if (model) {
      args.push("-m", model);
    }

    // Working directory: first addDir replaces cwd, rest become --add-dir
    if (settings.addDirs?.length) {
      args.push("-C", settings.addDirs[0]);
      for (const dir of settings.addDirs.slice(1)) {
        args.push("--add-dir", dir);
      }
    }

    // Attach files by embedding paths in the prompt (codex has no --file flag)
    let fullPrompt = prompt;
    if (options?.filePaths?.length) {
      const fileHeader = options.filePaths.map((p) => `[Attached file: ${p}]`).join("\n");
      fullPrompt = `${fileHeader}\n\n${prompt}`;
    }

    // Prepend system instruction since codex has no separate system prompt flag
    if (settings.systemPrompt) {
      fullPrompt = `[Instructions]\n${settings.systemPrompt}\n\n[Message]\n${fullPrompt}`;
    }

    // '-' tells codex to read the prompt from stdin — avoids arg-length limits
    // and shell escaping issues with long system-context strings.
    args.push("-");

    const resumeLabel = !options?.continueSession && existingSession?.threadId
      ? `resume=${existingSession.threadId.substring(0, 8)}...`
      : "new session";

    console.log(
      `[Codex] Spawning for channel ${channelId.substring(0, 8)}... model=${model || "default"} (${resumeLabel}, ${fullPrompt.length} chars)`,
    );

    try {
      const proc = spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.config.projectDir || undefined,
      });
      this.activeProcs.set(channelId, proc);

      // Write prompt via stdin (args has '-' as prompt placeholder)
      proc.stdin.write(fullPrompt);
      proc.stdin.end();

      const outputPromise = (async () => {
        const stderrPromise = new Response(proc.stderr).text();

        let output = "";
        const reader = proc.stdout!.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          output += chunk;
          onChunk?.(chunk);
        }
        const tail = decoder.decode();
        if (tail) { output += tail; onChunk?.(tail); }

        const stderr = await stderrPromise;
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          console.error("[Codex] stderr:", stderr.substring(0, 500));
          return `Error: Codex exited with code ${exitCode}. ${stderr.substring(0, 200)}`;
        }

        return this.parseOutput(output, channelId);
      })();

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          proc.kill();
          reject(new Error("Codex CLI timed out"));
        }, DEFAULT_TIMEOUT_MS);
      });

      const result = await Promise.race([outputPromise, timeoutPromise]);
      this.activeProcs.delete(channelId);
      if (this.killedChannels.delete(channelId)) {
        return "Request cancelled by user.";
      }
      return result;
    } catch (error: any) {
      this.activeProcs.delete(channelId);
      if (this.killedChannels.delete(channelId)) {
        return "Request cancelled by user.";
      }
      if (error.message?.includes("timed out")) {
        return "Codex took too long to respond (5 min timeout). Try a shorter or simpler request.";
      }
      console.error("[Codex] Error:", error.message);
      return "Error: Could not run Codex CLI. Is 'codex' installed and authenticated?";
    }
  }

  /**
   * Parse JSONL output from Codex CLI.
   *
   * Events:
   *   {"type":"thread.started","thread_id":"<uuid>"}
   *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
   *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
   */
  private parseOutput(raw: string, channelId: string): string {
    if (!raw.trim()) {
      return "Codex finished but returned no text. Use `!continue` to follow up.";
    }

    const lines = raw.trim().split("\n").filter(Boolean);
    const textParts: string[] = [];
    let threadId: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const line of lines) {
      let data: any;
      try {
        data = JSON.parse(line);
      } catch {
        // Non-JSON line (e.g. progress output) — ignore
        continue;
      }

      if (data.type === "thread.started" && data.thread_id) {
        threadId = data.thread_id;
      }

      if (data.type === "item.completed" && data.item?.type === "agent_message" && data.item?.text) {
        textParts.push(data.item.text);
      }

      if (data.type === "turn.completed" && data.usage) {
        totalInputTokens += data.usage.input_tokens ?? 0;
        totalOutputTokens += data.usage.output_tokens ?? 0;
      }
    }

    // Track usage (codex doesn't report cost in USD, so we estimate at $0)
    if (totalOutputTokens > 0) {
      this.usage.totalCalls += 1;
      this.usage.totalTurns += 1;
      this.usage.lastCallAt = new Date().toISOString();
      this.persistUsage().catch(() => {});
      console.log(`[Codex] Tokens: in=${totalInputTokens} out=${totalOutputTokens}`);
    }

    // Persist session thread ID
    if (threadId) {
      this.sessions.sessions[channelId] = {
        threadId,
        lastActivity: new Date().toISOString(),
        channelId,
      };
      this.persistSessions().catch(() => {});
      console.log(`[Codex] Session: ${threadId.substring(0, 12)}...`);
    }

    const text = textParts.join("\n");
    return text.trim() || "Codex finished but returned no text. Use `!continue` to follow up.";
  }

  // ── Session Management ──────────────────────────────────────────────

  async resetSession(channelId: string): Promise<void> {
    delete this.sessions.sessions[channelId];
    await this.persistSessions();
  }

  getSession(channelId: string): { sessionId: string | null } {
    return { sessionId: this.sessions.sessions[channelId]?.threadId ?? null };
  }

  // ── Channel Settings ────────────────────────────────────────────────

  getChannelSettings(channelId: string): ChannelSettings {
    return { ...this.channelSettings[channelId] };
  }

  async setChannelSettings(
    channelId: string,
    settings: Partial<ChannelSettings>,
  ): Promise<ChannelSettings> {
    this.channelSettings[channelId] = {
      ...this.channelSettings[channelId],
      ...settings,
    };
    await this.persistSettings();
    return this.channelSettings[channelId];
  }

  async clearChannelSettings(channelId: string): Promise<void> {
    delete this.channelSettings[channelId];
    await this.persistSettings();
  }

  // ── Usage ───────────────────────────────────────────────────────────

  getUsage(): HarnessUsageStats {
    return { ...this.usage };
  }

  async resetUsage(): Promise<void> {
    this.usage = {
      totalCostUsd: 0,
      totalTurns: 0,
      totalCalls: 0,
      lastCallCostUsd: 0,
      lastCallAt: "",
      byModel: {},
    };
    await this.persistUsage();
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private async persistSessions(): Promise<void> {
    await writeFile(
      join(this.config.relayDir, SESSION_FILE),
      JSON.stringify(this.sessions, null, 2),
    );
  }

  private async persistSettings(): Promise<void> {
    await writeFile(
      join(this.config.relayDir, SETTINGS_FILE),
      JSON.stringify(this.channelSettings, null, 2),
    );
  }

  private async persistUsage(): Promise<void> {
    await writeFile(
      join(this.config.relayDir, USAGE_FILE),
      JSON.stringify(this.usage, null, 2),
    );
  }
}

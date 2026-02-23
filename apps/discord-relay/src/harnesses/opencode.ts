import { spawn } from "bun";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { BaseHarness, HarnessCallOptions, HarnessUsageStats } from "./base.js";
import type { ChannelSettings } from "../types.js";

const SESSION_FILE = "sessions.json";
const SETTINGS_FILE = "channel-settings.json";
const USAGE_FILE = "usage.json";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONCURRENT_CALLS = 3;

interface SessionStore {
  sessions: Record<string, { sessionId: string | null; lastActivity: string; channelId: string }>;
}

export interface OpenCodeConfig {
  opencodePath: string;
  projectDir?: string;
  relayDir: string;
}

export class OpenCodeHarness implements BaseHarness {
  readonly harnessName = "OpenCode" as const;

  private config: OpenCodeConfig;
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

  constructor(config: OpenCodeConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    await mkdir(this.config.relayDir, { recursive: true });

    try {
      const raw = await readFile(join(this.config.relayDir, SESSION_FILE), "utf-8");
      this.sessions = JSON.parse(raw);
      const count = Object.keys(this.sessions.sessions).length;
      if (count > 0) console.log(`[OpenCode] Loaded ${count} saved session(s)`);
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

  /** Force-kill the running CLI process for a channel. */
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
      return "All OpenCode slots are busy right now. Please try again in a moment.";
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

  private async spawnOnce(
    prompt: string,
    channelId: string,
    options?: HarnessCallOptions,
  ): Promise<string> {
    const settings = {
      ...this.channelSettings[channelId],
      ...options?.channelSettings,
    };

    const args: string[] = [
      this.config.opencodePath,
      "run",
      "--format", "json",
    ];

    // Session continuity
    const existingSession = this.sessions.sessions[channelId];
    if (options?.continueSession) {
      args.push("--continue");
    } else if (existingSession?.sessionId) {
      args.push("--session", existingSession.sessionId);
    }

    if (settings.model) {
      args.push("--model", settings.model);
    }
    if (settings.effort) {
      args.push("--variant", settings.effort);
    }
    if (settings.agent) {
      args.push("--agent", settings.agent);
    }
    if (settings.addDirs?.length) {
      // OpenCode --dir changes the working directory (only one supported)
      args.push("--dir", settings.addDirs[0]);
    }

    // Attach files
    if (options?.filePaths?.length) {
      for (const fp of options.filePaths) {
        args.push("--file", fp);
      }
    }

    args.push(prompt);

    const resumeLabel = options?.continueSession
      ? "continue"
      : existingSession?.sessionId
        ? `session=${existingSession.sessionId.substring(0, 8)}...`
        : "new session";

    console.log(
      `[OpenCode] Spawning for channel ${channelId.substring(0, 8)}... model=${settings.model || "default"} (${resumeLabel}, ${prompt.length} chars)`,
    );

    try {
      const proc = spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.config.projectDir || undefined,
      });
      this.activeProcs.set(channelId, proc);

      const outputPromise = (async () => {
        const output = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          console.error("[OpenCode] stderr:", stderr.substring(0, 500));
          return `Error: OpenCode exited with code ${exitCode}. ${stderr.substring(0, 200)}`;
        }

        return this.parseOutput(output, channelId);
      })();

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          proc.kill();
          reject(new Error("OpenCode CLI timed out"));
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
        return "OpenCode took too long to respond (5 min timeout). Try a shorter or simpler request.";
      }
      console.error("[OpenCode] Error:", error.message);
      return "Error: Could not run OpenCode CLI. Is 'opencode' installed and authenticated?";
    }
  }

  /**
   * Parse JSON output from OpenCode CLI.
   * OpenCode outputs a single JSON object with the response.
   * We parse flexibly since the schema isn't fully documented.
   */
  /**
   * Parse NDJSON output from OpenCode CLI.
   *
   * OpenCode emits three event types per turn:
   *   {"type":"step_start", "sessionID":"ses_...", "part":{...}}
   *   {"type":"text",       "sessionID":"ses_...", "part":{"type":"text","text":"..."}}
   *   {"type":"step_finish", "sessionID":"ses_...", "part":{"type":"step-finish","cost":0.01,...}}
   *
   * For tool-use turns there may also be:
   *   {"type":"tool_call",  "part":{"type":"tool-call","name":"...","input":"..."}}
   *   {"type":"tool_result","part":{"type":"tool-result","output":"..."}}
   */
  private parseOutput(raw: string, channelId: string): string {
    if (!raw.trim().startsWith("{") && !raw.trim().startsWith("[")) {
      return raw.trim() || "OpenCode finished but returned no text. Use `!continue` to follow up.";
    }

    const lines = raw.trim().split("\n").filter(Boolean);
    const textParts: string[] = [];
    let sessionId: string | null = null;
    let totalCost = 0;
    let totalTokens = 0;

    for (const line of lines) {
      let data: any;
      try {
        data = JSON.parse(line);
      } catch {
        if (textParts.length === 0) textParts.push(line);
        continue;
      }

      // Session ID — OpenCode uses capital-D "sessionID"
      if (!sessionId) {
        sessionId = data.sessionID ?? data.sessionId ?? data.session_id ?? null;
      }
      if (!sessionId && data.part?.sessionID) {
        sessionId = data.part.sessionID;
      }

      // Text content — nested inside data.part.text
      if (data.type === "text" && data.part?.text) {
        textParts.push(data.part.text);
      }

      // Step finish — extract cost and token info
      if (data.type === "step_finish" && data.part) {
        const cost = data.part.cost ?? 0;
        totalCost += cost;
        if (data.part.tokens?.total) {
          totalTokens += data.part.tokens.total;
        }
      }

      // Fallback: top-level text fields (for future format changes)
      if (!data.type && data.result !== undefined) {
        textParts.push(String(data.result));
      } else if (!data.type && data.text !== undefined) {
        textParts.push(String(data.text));
      }
    }

    // Track usage
    if (totalCost > 0) {
      this.usage.totalCostUsd += totalCost;
      this.usage.totalCalls += 1;
      this.usage.totalTurns += 1;
      this.usage.lastCallCostUsd = totalCost;
      this.usage.lastCallAt = new Date().toISOString();
      this.persistUsage().catch(() => {});
      console.log(
        `[OpenCode] Cost: $${totalCost.toFixed(4)} | Tokens: ${totalTokens}`,
      );
    }

    // Persist session
    if (sessionId) {
      this.sessions.sessions[channelId] = {
        sessionId,
        lastActivity: new Date().toISOString(),
        channelId,
      };
      this.persistSessions().catch(() => {});
      console.log(`[OpenCode] Session: ${sessionId.substring(0, 12)}...`);
    }

    const text = textParts.join("");
    return text.trim() || "OpenCode finished but returned no text. Use `!continue` to follow up.";
  }

  // ── Session Management ────────────────────────────────────────────

  async resetSession(channelId: string): Promise<void> {
    delete this.sessions.sessions[channelId];
    await this.persistSessions();
  }

  getSession(channelId: string): { sessionId: string | null } {
    return { sessionId: this.sessions.sessions[channelId]?.sessionId ?? null };
  }

  // ── Channel Settings ──────────────────────────────────────────────

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

  // ── Usage ─────────────────────────────────────────────────────────

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

  // ── Persistence ───────────────────────────────────────────────────

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

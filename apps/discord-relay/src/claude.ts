import { spawn } from "bun";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type {
  SessionStore,
  RelayConfig,
  ChannelSettings,
  ClaudeCallOptions,
} from "./types.js";
import type { BaseHarness, HarnessCallOptions, HarnessUsageStats } from "./harnesses/base.js";

const SESSION_FILE = "sessions.json";
const SETTINGS_FILE = "channel-settings.json";
const USAGE_FILE = "usage.json";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_TURNS = 15;
const DEFAULT_MAX_BUDGET_USD = 2.0;
const DEFAULT_MODEL = "sonnet";
const MAX_CONCURRENT_CALLS = 3;
const MAX_AUTO_CONTINUES = 3; // Auto-continue up to 3 times (60 total turns)

/** @deprecated Use HarnessUsageStats from ./harnesses/base.js */
export interface UsageStats {
  totalCostUsd: number;
  totalTurns: number;
  totalCalls: number;
  lastCallCostUsd: number;
  lastCallAt: string;
  byModel: Record<string, { calls: number; costUsd: number; turns: number }>;
}

export class ClaudeHarness implements BaseHarness {
  readonly harnessName = "Claude Code" as const;
  private config: RelayConfig;
  private sessions: SessionStore;
  private channelSettings: Record<string, ChannelSettings> = {};
  private activeProcesses: Set<string> = new Set();
  private activeProcs = new Map<string, { kill(signal?: number): void }>();
  private killedChannels = new Set<string>();
  private globalActiveCount = 0;
  private usage: UsageStats = {
    totalCostUsd: 0,
    totalTurns: 0,
    totalCalls: 0,
    lastCallCostUsd: 0,
    lastCallAt: "",
    byModel: {},
  };

  constructor(config: RelayConfig) {
    this.config = config;
    this.sessions = { sessions: {} };
  }

  async init(): Promise<void> {
    await mkdir(this.config.relayDir, { recursive: true });

    // Load sessions
    const sessionFile = join(this.config.relayDir, SESSION_FILE);
    try {
      const raw = await readFile(sessionFile, "utf-8");
      this.sessions = JSON.parse(raw);
      const count = Object.keys(this.sessions.sessions).length;
      if (count > 0) {
        console.log(`[Claude] Loaded ${count} saved session(s)`);
      }
    } catch {
      this.sessions = { sessions: {} };
    }

    // Load channel settings
    const settingsFile = join(this.config.relayDir, SETTINGS_FILE);
    try {
      const raw = await readFile(settingsFile, "utf-8");
      this.channelSettings = JSON.parse(raw);
    } catch {
      this.channelSettings = {};
    }

    // Load usage stats
    const usageFile = join(this.config.relayDir, USAGE_FILE);
    try {
      const raw = await readFile(usageFile, "utf-8");
      this.usage = JSON.parse(raw);
    } catch {
      // Fresh usage stats
    }
  }

  /**
   * BaseHarness.call() — delegates to callClaude() for interface compliance.
   */
  async call(
    prompt: string,
    channelId: string,
    options?: HarnessCallOptions,
  ): Promise<string> {
    return this.callClaude(prompt, channelId, options as ClaudeCallOptions);
  }

  /** Force-kill the running CLI process for a channel. */
  kill(channelId: string): boolean {
    const proc = this.activeProcs.get(channelId);
    if (!proc) return false;
    this.killedChannels.add(channelId);
    proc.kill();
    return true;
  }

  /**
   * Call Claude Code CLI with a prompt.
   * Rejects if the channel already has an active call (no queuing).
   * Enforces a global concurrency limit across all channels.
   */
  async callClaude(
    prompt: string,
    channelId: string,
    options?: ClaudeCallOptions,
  ): Promise<string> {
    // Reject if this channel already has an active call
    if (this.activeProcesses.has(channelId)) {
      return "I'm still working on your previous message. Please wait for it to finish, or use `!reset` to start fresh.";
    }

    // Enforce global concurrency limit
    if (this.globalActiveCount >= MAX_CONCURRENT_CALLS) {
      return "All Claude slots are busy right now. Please try again in a moment.";
    }

    this.activeProcesses.add(channelId);
    this.globalActiveCount++;

    try {
      return await this.executeCall(prompt, channelId, options);
    } finally {
      this.activeProcesses.delete(channelId);
      this.globalActiveCount--;
    }
  }

  /**
   * Execute a call with auto-continue support.
   * If Claude hits the turn limit, automatically continues the session
   * up to MAX_AUTO_CONTINUES times, concatenating partial results.
   */
  private async executeCall(
    prompt: string,
    channelId: string,
    options?: ClaudeCallOptions,
  ): Promise<string> {
    const parts: string[] = [];
    let continueCount = 0;
    let currentPrompt = prompt;
    let isAutoContinue = false;

    while (true) {
      const result = await this.spawnOnce(
        currentPrompt,
        channelId,
        options,
        isAutoContinue,
      );

      // Save session ID for resume continuity
      if (result.sessionId) {
        const existingSession = this.sessions.sessions[channelId];
        const isNew = !existingSession?.sessionId;
        this.sessions.sessions[channelId] = {
          sessionId: result.sessionId,
          lastActivity: new Date().toISOString(),
          channelId,
        };
        await this.persistSessions();
        console.log(
          `[Claude] Session ${isNew ? "created" : "continued"}: ${result.sessionId.substring(0, 12)}...`,
        );
      }

      // Collect partial text
      if (result.text) {
        parts.push(result.text);
      }

      // Auto-continue if we hit the turn limit and haven't exceeded max continues
      if (
        result.subtype === "error_max_turns" &&
        continueCount < MAX_AUTO_CONTINUES &&
        this.sessions.sessions[channelId]?.sessionId
      ) {
        continueCount++;
        console.log(
          `[Claude] Auto-continuing (${continueCount}/${MAX_AUTO_CONTINUES}) for channel ${channelId.substring(0, 8)}...`,
        );
        // On auto-continue, we use --continue with a nudge prompt
        currentPrompt = "Continue where you left off.";
        isAutoContinue = true;
        continue;
      }

      // Budget exceeded — stop but return what we have
      if (result.subtype === "error_max_budget" && parts.length > 1) {
        parts.push(
          "\n\n_Hit budget limit after auto-continuing. Use `!budget <amount>` to adjust._",
        );
      }

      break;
    }

    if (continueCount > 0) {
      console.log(
        `[Claude] Completed with ${continueCount} auto-continue(s) for channel ${channelId.substring(0, 8)}`,
      );
    }

    return parts.join("\n\n---\n\n");
  }

  /**
   * Spawn a single Claude CLI process and return the parsed result.
   * When isAutoContinue=true, uses --continue instead of --resume.
   */
  private async spawnOnce(
    prompt: string,
    channelId: string,
    options: ClaudeCallOptions | undefined,
    isAutoContinue: boolean,
  ): Promise<{ text: string; sessionId: string | null; subtype: string | null }> {
    const args: string[] = [
      this.config.claudePath,
      "--dangerously-skip-permissions",
      "--max-turns", String(DEFAULT_MAX_TURNS),
    ];

    // Session continuity
    const existingSession = this.sessions.sessions[channelId];
    if (isAutoContinue || options?.continueSession) {
      args.push("--continue");
    } else if (existingSession?.sessionId) {
      args.push("--resume", existingSession.sessionId);
    }

    args.push("--output-format", "json");

    // Apply channel settings
    const settings = {
      ...this.channelSettings[channelId],
      ...options?.channelSettings,
    };

    args.push("--model", settings.model || DEFAULT_MODEL);
    if (settings.effort) {
      args.push("--effort", settings.effort);
    }
    if (settings.systemPrompt) {
      args.push("--append-system-prompt", settings.systemPrompt);
    }
    if (settings.allowedTools?.length) {
      args.push("--allowed-tools", ...settings.allowedTools);
    }
    if (settings.addDirs?.length) {
      args.push("--add-dir", ...settings.addDirs);
    }

    const budget = settings.maxBudget || DEFAULT_MAX_BUDGET_USD;
    args.push("--max-budget-usd", String(budget));

    args.push("-p", prompt);

    const modelLabel = settings.model || "default";
    const resumeLabel = isAutoContinue
      ? "auto-continue"
      : existingSession?.sessionId
        ? `resume=${existingSession.sessionId.substring(0, 8)}...`
        : "new session";
    console.log(
      `[Claude] Spawning for channel ${channelId.substring(0, 8)}... model=${modelLabel} (${resumeLabel}, ${prompt.length} chars)`,
    );

    try {
      const proc = spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.config.projectDir || undefined,
        env: {
          ...process.env,
          CLAUDECODE: undefined,
          CLAUDE_CODE_ENTRYPOINT: undefined,
        },
      });
      this.activeProcs.set(channelId, proc);

      const outputPromise = (async () => {
        const output = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          console.error("[Claude] stderr:", stderr.substring(0, 500));
          return {
            text: `Error: Claude exited with code ${exitCode}. ${stderr.substring(0, 200)}`,
            sessionId: null as string | null,
            subtype: null as string | null,
          };
        }

        return this.parseJsonOutput(output);
      })();

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          proc.kill();
          reject(new Error("Claude CLI timed out"));
        }, DEFAULT_TIMEOUT_MS);
      });

      const result = await Promise.race([outputPromise, timeoutPromise]);
      this.activeProcs.delete(channelId);
      if (this.killedChannels.delete(channelId)) {
        return { text: "Request cancelled by user.", sessionId: null, subtype: null };
      }
      return result;
    } catch (error: any) {
      this.activeProcs.delete(channelId);
      if (this.killedChannels.delete(channelId)) {
        return { text: "Request cancelled by user.", sessionId: null, subtype: null };
      }
      console.error("[Claude] Error:", error.message);
      if (error.message.includes("timed out")) {
        return {
          text: "Claude took too long to respond (5 min timeout). Try a shorter or simpler request.",
          sessionId: null,
          subtype: null,
        };
      }
      return {
        text: "Error: Could not run Claude CLI. Is 'claude' installed and authenticated?",
        sessionId: null,
        subtype: null,
      };
    }
  }

  /**
   * Parse JSON output from Claude CLI.
   * Extracts the response text, session ID, and subtype.
   * Handles error subtypes (max_turns, budget exceeded, etc.) gracefully.
   */
  private parseJsonOutput(raw: string): {
    text: string;
    sessionId: string | null;
    subtype: string | null;
  } {
    try {
      const data = JSON.parse(raw);

      const sessionId: string | null = data.session_id ?? null;
      const subtype: string | null = data.subtype ?? null;
      let text: string;

      // Track usage
      const costUsd = data.total_cost_usd ?? data.cost_usd ?? 0;
      const numTurns = data.num_turns ?? 0;
      if (costUsd > 0) {
        this.trackUsage(costUsd, numTurns, data.modelUsage);
      }

      // Log cost info
      if (costUsd > 0) {
        const durationSec = data.duration_ms
          ? Math.round(data.duration_ms / 1000) + "s"
          : "?";
        console.log(
          `[Claude] Cost: $${costUsd.toFixed(4)} | Turns: ${numTurns} | Duration: ${durationSec} | Session total: $${this.usage.totalCostUsd.toFixed(4)}`,
        );
      }

      // Extract result text (handle error subtypes gracefully)
      if (data.subtype === "error_max_turns") {
        // On auto-continue, the caller will handle this; just return partial result
        text = data.result ? String(data.result) : "";
      } else if (data.subtype === "error_max_budget") {
        text = data.result
          ? String(data.result)
          : "Hit the budget limit for this call. Use `!budget <amount>` to adjust.";
      } else if (data.result !== undefined) {
        text = String(data.result);
      } else if (data.content !== undefined) {
        text = String(data.content);
      } else if (data.message !== undefined) {
        text = String(data.message);
      } else {
        text = "Claude finished but returned no text. Use `!continue` to follow up.";
      }

      return { text: text.trim(), sessionId, subtype };
    } catch {
      console.warn("[Claude] Failed to parse JSON output, using raw text");

      const sessionMatch =
        raw.match(/"session_id"\s*:\s*"([^"]+)"/) ||
        raw.match(/Session ID:\s*([a-f0-9-]+)/i);

      return {
        text: raw.trim(),
        sessionId: sessionMatch ? sessionMatch[1] : null,
        subtype: null,
      };
    }
  }

  /** Track usage stats from a completed call */
  private trackUsage(
    costUsd: number,
    turns: number,
    modelUsage?: Record<string, { costUSD?: number }>,
  ): void {
    this.usage.totalCostUsd += costUsd;
    this.usage.totalTurns += turns;
    this.usage.totalCalls += 1;
    this.usage.lastCallCostUsd = costUsd;
    this.usage.lastCallAt = new Date().toISOString();

    if (modelUsage) {
      for (const [model, info] of Object.entries(modelUsage)) {
        const existing = this.usage.byModel[model] || {
          calls: 0,
          costUsd: 0,
          turns: 0,
        };
        existing.calls += 1;
        existing.costUsd += info.costUSD ?? 0;
        existing.turns += turns;
        this.usage.byModel[model] = existing;
      }
    }

    this.persistUsage().catch(() => {});
  }

  // ── Channel Settings ──────────────────────────────────────────────

  /** Get current settings for a channel */
  getChannelSettings(channelId: string): ChannelSettings {
    return { ...this.channelSettings[channelId] };
  }

  /** Update settings for a channel (merges with existing) */
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

  /** Clear all settings for a channel */
  async clearChannelSettings(channelId: string): Promise<void> {
    delete this.channelSettings[channelId];
    await this.persistSettings();
  }

  // ── Session Management ────────────────────────────────────────────

  /** Reset session for a channel */
  async resetSession(channelId: string): Promise<void> {
    delete this.sessions.sessions[channelId];
    await this.persistSessions();
  }

  /** Get session info for a channel */
  getSession(channelId: string): { sessionId: string | null } {
    return {
      sessionId: this.sessions.sessions[channelId]?.sessionId ?? null,
    };
  }

  // ── Usage ────────────────────────────────────────────────────────

  /** Get current usage stats */
  getUsage(): UsageStats {
    return { ...this.usage };
  }

  /** Reset usage counters */
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
    const sessionFile = join(this.config.relayDir, SESSION_FILE);
    await writeFile(sessionFile, JSON.stringify(this.sessions, null, 2));
  }

  private async persistSettings(): Promise<void> {
    const settingsFile = join(this.config.relayDir, SETTINGS_FILE);
    await writeFile(
      settingsFile,
      JSON.stringify(this.channelSettings, null, 2),
    );
  }

  private async persistUsage(): Promise<void> {
    const usageFile = join(this.config.relayDir, USAGE_FILE);
    await writeFile(usageFile, JSON.stringify(this.usage, null, 2));
  }
}

import { spawn } from "bun";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { BaseHarness, ChunkCallback, HarnessCallOptions, HarnessUsageStats } from "./base.js";
import type { ChannelSettings } from "../types.js";

const SETTINGS_FILE = "channel-settings.json";
const USAGE_FILE = "usage.json";
const PLUGINS_FILE = "gemini-plugins.json";
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes (Gemini preview models retry with backoff)
const MAX_CONCURRENT_CALLS = 3;

export interface GeminiMcpServer {
  command?: string;          // stdio: executable (e.g. "npx", "uvx")
  args?: string[];           // stdio: arguments
  env?: Record<string, string>;
  cwd?: string;
  httpUrl?: string;          // Streamable HTTP transport
  url?: string;              // SSE transport
  headers?: Record<string, string>;
  timeout?: number;
  trust?: boolean;           // Bypass per-tool confirmation (consistent with --yolo)
  description?: string;
}

export interface GeminiConfig {
  geminiPath: string;
  projectDir?: string;
  relayDir: string;
  defaultModel?: string; // Override Gemini CLI's default model (avoids rate-limited preview models)
}

/**
 * Gemini CLI harness.
 *
 * Gemini CLI is stateless — it does not support session resumption.
 * Each call is independent. Session methods are no-ops that always return null.
 *
 * CLI: gemini -p "prompt" --output-format json --yolo [--model <model>] [--include-directories dir...]
 *
 * JSON output shape:
 *   { "response": "...", "stats": { "models": { "<name>": { "tokens": { total, prompt, response } } } } }
 */
export class GeminiHarness implements BaseHarness {
  readonly harnessName = "Gemini CLI" as const;

  private config: GeminiConfig;
  private channelSettings: Record<string, ChannelSettings> = {};
  private plugins: Record<string, GeminiMcpServer> = {};
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

  constructor(config: GeminiConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    await mkdir(this.config.relayDir, { recursive: true });

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

    try {
      const raw = await readFile(join(this.config.relayDir, PLUGINS_FILE), "utf-8");
      this.plugins = JSON.parse(raw);
    } catch {
      this.plugins = {};
    }

    // Sync plugins to project-level .gemini/settings.json so Gemini CLI picks them up
    await this.syncPluginsToSettings();
  }

  /** Force-kill the running CLI process for a channel (SIGKILL — Gemini ignores SIGTERM). */
  kill(channelId: string): boolean {
    const proc = this.activeProcs.get(channelId);
    if (!proc) return false;
    this.killedChannels.add(channelId);
    proc.kill(9); // SIGKILL
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
      return "All Gemini slots are busy right now. Please try again in a moment.";
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
      return "All Gemini slots are busy right now. Please try again in a moment.";
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

    const args: string[] = [
      this.config.geminiPath,
      "--output-format", "json",
      "--yolo", // auto-approve tool actions in non-interactive mode
    ];

    const model = settings.model || this.config.defaultModel;
    if (model) {
      args.push("--model", model);
    }

    // Map addDirs → --include-directories (supports multiple)
    if (settings.addDirs?.length) {
      args.push("--include-directories", ...settings.addDirs);
    }

    // Attach files via --all-files or individual includes
    // Gemini CLI doesn't have a --file flag; files are context via directories
    // For specific file paths, include their parent dirs
    if (options?.filePaths?.length) {
      const dirs = [...new Set(options.filePaths.map((p) => p.substring(0, p.lastIndexOf("/"))))].filter(Boolean);
      if (dirs.length) args.push("--include-directories", ...dirs);
    }

    // Prompt must come last as positional arg or -p flag
    args.push("-p", prompt);

    console.log(
      `[Gemini CLI] Spawning for channel ${channelId.substring(0, 8)}... model=${settings.model || "default"} (stateless, ${prompt.length} chars)`,
    );

    try {
      const proc = spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.config.projectDir || undefined,
      });
      this.activeProcs.set(channelId, proc);

      const outputPromise = (async () => {
        // Drain stderr concurrently to avoid pipe deadlock while streaming stdout
        const stderrPromise = new Response(proc.stderr).text();
        const exitedPromise = proc.exited;

        // Stream stdout with optional chunk callback
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

        const [stderr, exitCode] = await Promise.all([stderrPromise, exitedPromise]);

        // Always try parsing stdout first — Gemini CLI often exits with code 1
        // due to non-fatal MCP discovery errors while still producing valid output
        const parsed = this.parseOutput(output, settings.model);

        if (exitCode !== 0) {
          console.warn(`[Gemini CLI] exit code ${exitCode} (non-fatal MCP/network errors likely)`);
          if (parsed && !parsed.startsWith("Gemini CLI finished but")) return parsed;
          console.error("[Gemini CLI] stderr:", stderr.substring(0, 500));
          return `Error: Gemini CLI exited with code ${exitCode}. ${stderr.substring(0, 200)}`;
        }

        return parsed;
      })();

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          proc.kill(9); // SIGKILL — Gemini CLI ignores SIGTERM during API retries
          reject(new Error("Gemini CLI timed out"));
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
        return "Gemini CLI took too long to respond (5 min timeout). Try a shorter or simpler request.";
      }
      console.error("[Gemini CLI] Error:", error.message);
      return "Error: Could not run Gemini CLI. Is 'gemini' installed and authenticated?";
    }
  }

  /**
   * Parse JSON output from Gemini CLI.
   *
   * Official JSON schema:
   *   {
   *     "response": "string",
   *     "stats": {
   *       "models": { "<model-name>": { "tokens": { prompt, response, cached, total } } },
   *       "tools": { totalCalls, totalSuccess, ... },
   *       "files": { totalLinesAdded, totalLinesRemoved }
   *     },
   *     "error": { ... }  // only on error
   *   }
   *
   * Falls back to plain text if JSON parsing fails (--output-format json may not be
   * supported on older Gemini CLI versions).
   */
  private parseOutput(raw: string, model?: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
      return "Gemini CLI finished but returned no text. Try rephrasing your request.";
    }

    if (trimmed.startsWith("{")) {
      try {
        const data = JSON.parse(trimmed);

        if (data.error) {
          console.error("[Gemini CLI] API error:", JSON.stringify(data.error).substring(0, 200));
          return `Gemini error: ${data.error.message ?? JSON.stringify(data.error)}`;
        }

        const text: string = data.response ?? data.text ?? data.result ?? data.content ?? "";

        // Extract token usage from stats
        if (data.stats?.models) {
          let totalTokens = 0;
          for (const [modelName, info] of Object.entries(data.stats.models as Record<string, any>)) {
            const tokens = info?.tokens?.total ?? 0;
            totalTokens += tokens;
            const key = modelName || model || "gemini";
            const existing = this.usage.byModel[key] ?? { calls: 0, costUsd: 0, turns: 0 };
            existing.calls += 1;
            existing.turns += 1;
            this.usage.byModel[key] = existing;
          }
          this.usage.totalTurns += 1;
          this.usage.totalCalls += 1;
          this.usage.lastCallAt = new Date().toISOString();
          this.persistUsage().catch(() => {});
          if (totalTokens > 0) {
            console.log(`[Gemini CLI] Tokens: ${totalTokens}`);
          }
        }

        return text.trim() || "Gemini CLI finished but returned no text. Try rephrasing your request.";
      } catch {
        // Fall through to plain text
      }
    }

    // Plain text fallback (older Gemini CLI versions or --output-format not supported)
    return trimmed;
  }

  // ── Plugin / MCP Server Management ───────────────────────────────

  getPlugins(): Record<string, GeminiMcpServer> {
    return { ...this.plugins };
  }

  async addPlugin(name: string, config: GeminiMcpServer): Promise<void> {
    this.plugins[name] = config;
    await this.persistPlugins();
    await this.syncPluginsToSettings();
  }

  async removePlugin(name: string): Promise<boolean> {
    if (!(name in this.plugins)) return false;
    delete this.plugins[name];
    await this.persistPlugins();
    await this.syncPluginsToSettings();
    return true;
  }

  async clearPlugins(): Promise<void> {
    this.plugins = {};
    await this.persistPlugins();
    await this.syncPluginsToSettings();
  }

  /**
   * Write a project-level .gemini/settings.json containing the configured MCP servers.
   * Gemini CLI automatically loads this when cwd is projectDir (or any parent).
   * Only writes the mcpServers section — global settings in ~/.gemini/settings.json are merged by Gemini CLI itself.
   */
  private async syncPluginsToSettings(): Promise<void> {
    const projectDir = this.config.projectDir || process.cwd();
    const geminiDir = join(projectDir, ".gemini");
    await mkdir(geminiDir, { recursive: true });
    const settingsPath = join(geminiDir, "settings.json");

    // Read existing settings to preserve non-mcpServers keys
    let existing: Record<string, any> = {};
    try {
      const raw = await readFile(settingsPath, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      // No existing settings — start fresh
    }

    if (Object.keys(this.plugins).length === 0) {
      // Remove mcpServers if no plugins configured
      delete existing.mcpServers;
    } else {
      existing.mcpServers = this.plugins;
    }

    await writeFile(settingsPath, JSON.stringify(existing, null, 2));
  }

  // ── Session Management (no-op — Gemini CLI is stateless) ──────────

  async resetSession(_channelId: string): Promise<void> {
    // Gemini CLI has no persistent sessions — nothing to reset
  }

  getSession(_channelId: string): { sessionId: string | null } {
    return { sessionId: null };
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

  private async persistPlugins(): Promise<void> {
    await writeFile(
      join(this.config.relayDir, PLUGINS_FILE),
      JSON.stringify(this.plugins, null, 2),
    );
  }
}

/**
 * LocalHarness — spawns AI CLI tools (claude / opencode / gemini / codex)
 * directly inside the relay adapter process.
 *
 * Sessions are persisted across restarts. Each harness type has its own
 * session entry so switching between them doesn't lose context.
 *
 * Orphan prevention: tracks spawned PIDs in a sidecar file and reaps them
 * on startup (crash recovery). Kill uses process-tree walk to ensure all
 * child processes (MCP servers, etc.) are cleaned up.
 */

import { spawn } from "bun";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { dirname, join } from "path";

export type LocalHarnessType = "claude-code" | "opencode" | "gemini-cli" | "codex-cli";

/** Resolve a CLI command to its full path for use in launchd/cron contexts where PATH is limited. */
function resolveCommand(name: string): string {
  try {
    return execSync(`which ${name}`, { encoding: "utf8" }).trim() || name;
  } catch {
    // Common install locations as fallback
    const knownPaths = [
      `${process.env.HOME}/.local/bin/${name}`,
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
    ];
    for (const p of knownPaths) {
      if (existsSync(p)) return p;
    }
    return name;
  }
}

interface SessionEntry {
  sessionId: string | null;
  lastActivity: string;
}

interface HarnessStateFile {
  sessions: Record<LocalHarnessType, SessionEntry>;
}

const BLANK_SESSION: SessionEntry = { sessionId: null, lastActivity: "" };
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const TIMEOUT_MS = 60 * 60 * 1000; // 1 hour process timeout
const MAX_AUTO_CONTINUES = 3; // Auto-continue up to 3 times when hitting turn limit

// ─── Process tree helpers ────────────────────────────────────────────────────

/** Kill a process and all its descendants (depth-first). */
function killProcessTree(pid: number): void {
  try {
    // Find children first, then kill bottom-up
    const childrenStr = execSync(`pgrep -P ${pid} 2>/dev/null`, { encoding: "utf-8" }).trim();
    for (const childPid of childrenStr.split("\n").filter(Boolean)) {
      killProcessTree(parseInt(childPid, 10));
    }
  } catch { /* no children */ }
  try {
    process.kill(pid, "SIGKILL");
  } catch { /* already dead */ }
}

/** Check if a PID is alive. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

export class LocalHarness {
  private sessions: Record<LocalHarnessType, SessionEntry> = {
    "claude-code": { ...BLANK_SESSION },
    "opencode": { ...BLANK_SESSION },
    "gemini-cli": { ...BLANK_SESSION },
    "codex-cli": { ...BLANK_SESSION },
  };
  private stateFile: string;
  private pidFile: string; // tracks active child PID for orphan reaping
  private runningHarnesses = new Set<LocalHarnessType>(); // tracks which harness types are currently running
  private activeKills = new Map<LocalHarnessType, () => void>();
  private activePids = new Map<LocalHarnessType, number>();

  constructor(stateFile: string) {
    this.stateFile = stateFile;
    this.pidFile = join(dirname(stateFile), ".harness-active-pid");
    this.load();
    this.reapOrphans();

    // Best-effort cleanup on process exit (SIGTERM, SIGINT, uncaught exception)
    const cleanup = () => this.dispose();
    process.on("exit", cleanup);
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
  }

  /** Clean up all active child processes. Call on graceful shutdown. */
  dispose(): void {
    for (const [harness, pid] of this.activePids) {
      if (pidIsAlive(pid)) {
        console.log(`[local-harness] Disposing ${harness} — killing process tree (PID ${pid})`);
        killProcessTree(pid);
      }
    }
    this.clearPidFile();
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.stateFile, "utf8")) as HarnessStateFile;
      if (data.sessions) {
        for (const k of Object.keys(data.sessions) as LocalHarnessType[]) {
          if (this.sessions[k] !== undefined) {
            this.sessions[k] = data.sessions[k];
          }
        }
        console.log("[local-harness] Loaded persisted sessions");
      }
    } catch {
      // First run — use defaults
    }
  }

  private save(): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify({ sessions: this.sessions }, null, 2), "utf8");
    } catch (err) {
      console.error("[local-harness] Failed to save sessions:", err);
    }
  }

  /** Reap orphaned child processes from a previous crash. */
  private reapOrphans(): void {
    try {
      if (!existsSync(this.pidFile)) return;
      const raw = readFileSync(this.pidFile, "utf8").trim();
      const pid = parseInt(raw, 10);
      if (isNaN(pid) || pid <= 0) return;
      if (pidIsAlive(pid)) {
        console.log(`[local-harness] Reaping orphaned process tree (PID ${pid})`);
        killProcessTree(pid);
      }
    } catch { /* ignore */ }
    this.clearPidFile();
  }

  /** Write the active child PID to disk for crash recovery. */
  private writePidFile(pid: number): void {
    try { writeFileSync(this.pidFile, String(pid), "utf8"); } catch { /* best effort */ }
  }

  /** Remove the PID file after normal completion. */
  private clearPidFile(): void {
    try { if (existsSync(this.pidFile)) unlinkSync(this.pidFile); } catch { /* ignore */ }
  }

  isRunning(harness?: LocalHarnessType): boolean {
    if (harness) return this.runningHarnesses.has(harness);
    return this.runningHarnesses.size > 0;
  }

  /** Kill a specific harness process (or all) and its entire process tree. */
  kill(harness?: LocalHarnessType): void {
    if (harness) {
      const pid = this.activePids.get(harness);
      if (pid && pidIsAlive(pid)) {
        console.log(`[local-harness] Killing ${harness} process tree (PID ${pid})`);
        killProcessTree(pid);
      }
      this.activeKills.get(harness)?.();
      this.activePids.delete(harness);
      this.activeKills.delete(harness);
      this.runningHarnesses.delete(harness);
    } else {
      // Kill all
      for (const [h, pid] of this.activePids) {
        if (pidIsAlive(pid)) killProcessTree(pid);
      }
      this.activePids.clear();
      this.activeKills.clear();
      this.runningHarnesses.clear();
    }
    this.clearPidFile();
  }

  resetSession(harness: LocalHarnessType): void {
    this.sessions[harness] = { ...BLANK_SESSION };
    this.save();
    console.log(`[local-harness] Session reset for ${harness}`);
  }

  async run(harness: LocalHarnessType, prompt: string, onToken?: (token: string) => void): Promise<string> {
    if (this.runningHarnesses.has(harness)) {
      return `${harness} is still processing another message. Please wait, or type !reset to cancel.`;
    }
    this.runningHarnesses.add(harness);
    try {
      switch (harness) {
        case "claude-code": return await this.runClaude(prompt, onToken);
        case "opencode": return await this.runOpenCode(prompt, onToken);
        case "gemini-cli": return await this.runGemini(prompt, onToken);
        case "codex-cli": return await this.runCodex(prompt, onToken);
      }
    } finally {
      this.runningHarnesses.delete(harness);
      this.activeKills.delete(harness);
      this.activePids.delete(harness);
      this.clearPidFile();
    }
  }

  private async runClaude(prompt: string, onToken?: (token: string) => void): Promise<string> {
    const parts: string[] = [];
    let continueCount = 0;
    let currentPrompt = prompt;
    let useResume = true; // first call uses --resume, subsequent use --continue
    let lastStderr = "";

    while (true) {
      const result = await this.spawnClaude(currentPrompt, onToken, useResume);

      if (result.text) parts.push(result.text);
      if (result.stderr) lastStderr = result.stderr;

      // Auto-continue if we hit the turn limit
      if (
        result.hitTurnLimit &&
        continueCount < MAX_AUTO_CONTINUES &&
        this.sessions["claude-code"].sessionId
      ) {
        continueCount++;
        console.log(
          `[local-harness] Auto-continuing Claude (${continueCount}/${MAX_AUTO_CONTINUES})`,
        );
        currentPrompt = "Continue where you left off.";
        useResume = false; // use --continue for auto-continues
        continue;
      }

      break;
    }

    if (continueCount > 0) {
      console.log(`[local-harness] Claude completed with ${continueCount} auto-continue(s)`);
    }

    const joined = parts.join("\n\n---\n\n").trim();
    if (joined) return joined;

    // Surface the actual error instead of a generic message
    if (lastStderr) {
      const shortErr = lastStderr.substring(0, 300);
      return `Claude CLI error: ${shortErr}`;
    }
    return "No response from Claude.";
  }

  private async spawnClaude(
    prompt: string,
    onToken?: (token: string) => void,
    useResume = true,
  ): Promise<{ text: string; hitTurnLimit: boolean; stderr: string }> {
    const session = this.sessions["claude-code"];
    const age = session.lastActivity
      ? Date.now() - new Date(session.lastActivity).getTime()
      : Infinity;
    const hasLiveSession = session.sessionId && age < SESSION_TTL_MS;

    const cmd = [
      resolveCommand("claude"),
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", "100",
      "--model", "sonnet",
    ];
    if (hasLiveSession && session.sessionId) {
      if (useResume) {
        cmd.push("--resume", session.sessionId);
      } else {
        cmd.push("--continue");
      }
    }
    cmd.push("-p", prompt);

    const proc = spawn({
      cmd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) =>
            k !== "CLAUDECODE" &&
            k !== "CLAUDE_CODE_ENTRYPOINT" &&
            k !== "CLAUDE_CODE_SESSION_ACCESS_TOKEN"
          ),
        ),
        HQ_BROWSER_PORT: process.env.HQ_BROWSER_PORT ?? "19200",
      },
    });
    this.writePidFile(proc.pid);
    this.activePids.set("claude-code", proc.pid);
    this.activeKills.set("claude-code", () => killProcessTree(proc.pid));

    let text = "";
    let newSessionId: string | null = null;
    let hitTurnLimit = false;

    // Capture stderr for diagnostics
    const stderrPromise = new Response(proc.stderr).text();

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as Record<string, any>;
            if (typeof msg.session_id === "string") newSessionId = msg.session_id;

            if (msg.type === "assistant") {
              const content = msg.message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && block.text) {
                    text += block.text;
                    onToken?.(block.text);
                  }
                }
              }
            } else if (msg.type === "result") {
              if (msg.subtype === "error_max_turns") hitTurnLimit = true;
              // Extract result text if present (newer CLI versions include it)
              if (typeof msg.result === "string" && msg.result) {
                if (!text) {
                  text = msg.result;
                  onToken?.(text);
                }
              }
            }
          } catch { /* non-JSON */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;
    const stderrText = await stderrPromise;

    if (stderrText.trim()) {
      console.warn(`[local-harness] Claude stderr: ${stderrText.trim().substring(0, 500)}`);
    }
    if (exitCode !== 0 && !text) {
      console.error(`[local-harness] Claude exited with code ${exitCode}`);
    }

    if (newSessionId) {
      this.sessions["claude-code"] = {
        sessionId: newSessionId,
        lastActivity: new Date().toISOString(),
      };
      this.save();
    }

    return { text: text.trim(), hitTurnLimit, stderr: stderrText.trim() };
  }

  private async runOpenCode(prompt: string, onToken?: (token: string) => void): Promise<string> {
    const cmd = [resolveCommand("opencode"), "run", "-m", "anthropic/claude-sonnet-4-6", "-p", prompt];
    const { stdout, stderr } = await this.exec(cmd, "opencode");
    const text = stdout.trim() || stderr.trim() || "No response from OpenCode.";
    if (onToken && text) onToken(text);
    return text;
  }

  private async runGemini(prompt: string, onToken?: (token: string) => void): Promise<string> {
    const cmd = [resolveCommand("gemini"), "--yolo", "-p", prompt];
    const { stdout, stderr } = await this.exec(cmd, "gemini-cli");
    const text = stdout.trim() || stderr.trim() || "No response from Gemini.";
    if (onToken && text) onToken(text);
    return text;
  }

  private async runCodex(prompt: string, onToken?: (token: string) => void): Promise<string> {
    const session = this.sessions["codex-cli"];
    const age = session.lastActivity
      ? Date.now() - new Date(session.lastActivity).getTime()
      : Infinity;
    const threadId = session.sessionId && age < SESSION_TTL_MS ? session.sessionId : null;

    const cmd = [resolveCommand("codex"), "exec"];
    if (threadId) cmd.push("resume", threadId);
    cmd.push("--json", "--dangerously-bypass-approvals-and-sandbox", "-");

    const proc = spawn({
      cmd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HQ_BROWSER_PORT: process.env.HQ_BROWSER_PORT ?? "19200" },
    });
    this.writePidFile(proc.pid);
    this.activePids.set("codex-cli", proc.pid);
    this.activeKills.set("codex-cli", () => killProcessTree(proc.pid));

    proc.stdin.write(prompt);
    proc.stdin.end();

    let text = "";
    let newThreadId: string | null = null;
    const stderrPromise = new Response(proc.stderr).text();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.type === "thread.started" && data.thread_id) newThreadId = data.thread_id;
            if (data.type === "item.completed" && data.item?.type === "agent_message" && data.item?.text) {
              const segment = data.item.text;
              text += segment;
              onToken?.(segment);
            }
          } catch { /* ignore */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;
    const stderrText = await stderrPromise;

    if (stderrText.trim()) {
      console.warn(`[local-harness] Codex stderr: ${stderrText.trim().substring(0, 500)}`);
    }
    if (exitCode !== 0 && !text) {
      console.error(`[local-harness] Codex exited with code ${exitCode}`);
    }

    if (newThreadId) {
      this.sessions["codex-cli"] = { sessionId: newThreadId, lastActivity: new Date().toISOString() };
      this.save();
    }

    return text.trim() || "No response from Codex.";
  }

  private exec(cmd: string[], harnessType?: LocalHarnessType): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn({
        cmd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HQ_BROWSER_PORT: process.env.HQ_BROWSER_PORT ?? "19200" },
      });

      this.writePidFile(proc.pid);
      if (harnessType) {
        this.activePids.set(harnessType, proc.pid);
        this.activeKills.set(harnessType, () => killProcessTree(proc.pid));
      }

      const timer = setTimeout(() => {
        killProcessTree(proc.pid);
        reject(new Error(`Harness timed out after ${TIMEOUT_MS / 60000} minutes`));
      }, TIMEOUT_MS);

      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
        .then(([stdout, stderr]) => {
          clearTimeout(timer);
          resolve({ stdout, stderr });
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}

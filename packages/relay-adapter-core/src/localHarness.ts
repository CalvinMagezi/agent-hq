/**
 * LocalHarness — spawns AI CLI tools (claude / opencode / gemini / codex)
 * directly inside the relay adapter process.
 *
 * Sessions are persisted across restarts. Each harness type has its own
 * session entry so switching between them doesn't lose context.
 */

import { spawn } from "bun";
import { readFileSync, writeFileSync } from "fs";

export type LocalHarnessType = "claude-code" | "opencode" | "gemini-cli" | "codex-cli";

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

export class LocalHarness {
  private sessions: Record<LocalHarnessType, SessionEntry> = {
    "claude-code": { ...BLANK_SESSION },
    "opencode": { ...BLANK_SESSION },
    "gemini-cli": { ...BLANK_SESSION },
    "codex-cli": { ...BLANK_SESSION },
  };
  private stateFile: string;
  private running = false;
  private activeKill: (() => void) | null = null;

  constructor(stateFile: string) {
    this.stateFile = stateFile;
    this.load();
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

  isRunning(): boolean {
    return this.running;
  }

  kill(): void {
    this.activeKill?.();
  }

  resetSession(harness: LocalHarnessType): void {
    this.sessions[harness] = { ...BLANK_SESSION };
    this.save();
    console.log(`[local-harness] Session reset for ${harness}`);
  }

  async run(harness: LocalHarnessType, prompt: string, onToken?: (token: string) => void): Promise<string> {
    if (this.running) {
      return "Still processing your previous message. Please wait, or type !reset to cancel.";
    }
    this.running = true;
    try {
      switch (harness) {
        case "claude-code": return await this.runClaude(prompt, onToken);
        case "opencode": return await this.runOpenCode(prompt, onToken);
        case "gemini-cli": return await this.runGemini(prompt, onToken);
        case "codex-cli": return await this.runCodex(prompt, onToken);
      }
    } finally {
      this.running = false;
      this.activeKill = null;
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
      "claude",
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
        ...process.env,
        // Prevent "cannot launch inside another Claude Code session" error
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
        HQ_BROWSER_PORT: process.env.HQ_BROWSER_PORT ?? "19200",
      },
    });
    this.activeKill = () => proc.kill();

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
    const cmd = ["opencode", "run", "-m", "anthropic/claude-sonnet-4-6", "-p", prompt];
    const { stdout, stderr } = await this.exec(cmd);
    const text = stdout.trim() || stderr.trim() || "No response from OpenCode.";
    if (onToken && text) onToken(text);
    return text;
  }

  private async runGemini(prompt: string, onToken?: (token: string) => void): Promise<string> {
    const cmd = ["gemini", "--yolo", "-p", prompt];
    const { stdout, stderr } = await this.exec(cmd);
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

    const cmd = ["codex", "exec"];
    if (threadId) cmd.push("resume", threadId);
    cmd.push("--json", "--dangerously-bypass-approvals-and-sandbox", "-");

    const proc = spawn({
      cmd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HQ_BROWSER_PORT: process.env.HQ_BROWSER_PORT ?? "19200" },
    });
    this.activeKill = () => proc.kill();

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

  private exec(cmd: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn({
        cmd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HQ_BROWSER_PORT: process.env.HQ_BROWSER_PORT ?? "19200" },
      });

      this.activeKill = () => proc.kill();

      const timer = setTimeout(() => {
        proc.kill();
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

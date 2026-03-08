/**
 * LocalHarness — spawns AI CLI tools (claude / opencode / gemini) directly
 * inside the WhatsApp relay process.
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
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — match Discord harness
const TIMEOUT_MS = 60 * 60 * 1000; // 1 hour process timeout

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

  async run(harness: LocalHarnessType, prompt: string): Promise<string> {
    if (this.running) {
      return "Still processing your previous message. Please wait, or type !reset to cancel.";
    }
    this.running = true;
    try {
      switch (harness) {
        case "claude-code": return await this.runClaude(prompt);
        case "opencode": return await this.runOpenCode(prompt);
        case "gemini-cli": return await this.runGemini(prompt);
        case "codex-cli": return await this.runCodex(prompt);
      }
    } finally {
      this.running = false;
      this.activeKill = null;
    }
  }

  // ── Claude Code ─────────────────────────────────────────────

  private async runClaude(prompt: string): Promise<string> {
    const session = this.sessions["claude-code"];
    const age = session.lastActivity
      ? Date.now() - new Date(session.lastActivity).getTime()
      : Infinity;
    const resume = session.sessionId && age < SESSION_TTL_MS ? session.sessionId : null;

    const cmd = [
      "claude",
      "--dangerously-skip-permissions",
      "--output-format", "json",
      "--max-turns", "100",
      "--model", "sonnet",
    ];
    if (resume) cmd.push("--resume", resume);
    cmd.push("-p", prompt);

    const { stdout, stderr } = await this.exec(cmd);

    // Parse Claude JSON stream — look for result message and session_id
    let text = "";
    let newSessionId: string | null = null;
    let hitTurnLimit = false;

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        if (msg.type === "result") {
          if (msg.subtype === "error_max_turns") {
            hitTurnLimit = true;
          }
          if (typeof msg.result === "string" && msg.result) {
            text = msg.result;
          }
        }
        if (typeof msg.session_id === "string") {
          newSessionId = msg.session_id;
        }
      } catch {
        // Non-JSON line — ignore
      }
    }

    // Friendly fallback for turn limit (don't expose raw JSON)
    if (!text && hitTurnLimit) {
      text = "Reached the session turn limit. Type !reset to start a fresh conversation.";
    }

    // Only fall back to raw stdout if it doesn't look like JSON
    if (!text) {
      const raw = stdout.trim();
      text = raw.startsWith("{") || raw.startsWith("[") ? "" : raw;
    }

    if (newSessionId) {
      this.sessions["claude-code"] = {
        sessionId: newSessionId,
        lastActivity: new Date().toISOString(),
      };
      this.save();
    }

    return text || stderr.trim() || "No response from Claude.";
  }

  // ── OpenCode ────────────────────────────────────────────────

  private async runOpenCode(prompt: string): Promise<string> {
    const cmd = ["opencode", "run", "-m", "anthropic/claude-sonnet-4-6", "-p", prompt];
    const { stdout, stderr } = await this.exec(cmd);
    return stdout.trim() || stderr.trim() || "No response from OpenCode.";
  }

  // ── Gemini CLI ──────────────────────────────────────────────

  private async runGemini(prompt: string): Promise<string> {
    const cmd = ["gemini", "--yolo", "-p", prompt];
    const { stdout, stderr } = await this.exec(cmd);
    return stdout.trim() || stderr.trim() || "No response from Gemini.";
  }

  // ── Codex CLI ───────────────────────────────────────────────

  private async runCodex(prompt: string): Promise<string> {
    const session = this.sessions["codex-cli"];
    const age = session.lastActivity
      ? Date.now() - new Date(session.lastActivity).getTime()
      : Infinity;
    const threadId = session.sessionId && age < SESSION_TTL_MS ? session.sessionId : null;

    // New:    codex exec --json --dangerously-bypass-approvals-and-sandbox -
    // Resume: codex exec resume <thread_id> --json --dangerously-bypass-approvals-and-sandbox -
    // '-' = read prompt from stdin (avoids arg-length limits and escaping issues)
    const cmd = ["codex", "exec"];
    if (threadId) cmd.push("resume", threadId);
    cmd.push("--json", "--dangerously-bypass-approvals-and-sandbox", "-");

    // Use direct spawn with stdin: "pipe" (exec() helper uses stdin: "ignore")
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn({
        cmd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });

      this.activeKill = () => proc.kill();

      proc.stdin.write(prompt);
      proc.stdin.end();

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Codex timed out after ${TIMEOUT_MS / 60000} minutes`));
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

    // Parse JSONL — extract text from item.completed agent_message events
    const textParts: string[] = [];
    let newThreadId: string | null = null;
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const data = JSON.parse(trimmed);
        if (data.type === "thread.started" && data.thread_id) {
          newThreadId = data.thread_id;
        }
        if (data.type === "item.completed" && data.item?.type === "agent_message" && data.item?.text) {
          textParts.push(data.item.text);
        }
      } catch { /* non-JSON line — ignore */ }
    }

    if (newThreadId) {
      this.sessions["codex-cli"] = { sessionId: newThreadId, lastActivity: new Date().toISOString() };
      this.save();
    }

    return textParts.join("\n").trim() || result.stderr.trim() || "No response from Codex.";
  }

  // ── Process runner ──────────────────────────────────────────

  private exec(cmd: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn({
        cmd,
        stdin: "ignore",   // close stdin immediately — prevents interactive hang
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
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

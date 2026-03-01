/**
 * CommandHandler — Relay-protocol port of Discord ! commands.
 *
 * Handles cmd:execute messages from relay clients, providing the same
 * command set as the Discord relay's handleCommand function.
 */

import type { ServerWebSocket } from "bun";
import type { ClientData } from "../clientRegistry";
import type { VaultBridge } from "../bridges/vaultBridge";
import type { CmdExecuteMessage } from "@repo/agent-relay-protocol";

function formatTimeAgo(isoString: string | null | undefined): string {
  if (!isoString) return "never";
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export class CommandHandler {
  private bridge: VaultBridge;
  private debug: boolean;
  /** Per-session settings: sessionToken → settings */
  private sessionSettings = new Map<string, Record<string, unknown>>();

  constructor(bridge: VaultBridge, debug = false) {
    this.bridge = bridge;
    this.debug = debug;
  }

  async handleCommand(
    ws: ServerWebSocket<ClientData>,
    msg: CmdExecuteMessage,
  ): Promise<void> {
    const { command, args, requestId } = msg;
    const sessionToken = ws.data.sessionToken;

    let output: string;
    let success = true;

    try {
      output = await this.dispatch(command, args ?? {}, sessionToken);
    } catch (err) {
      success = false;
      output = err instanceof Error ? err.message : "Command failed";
    }

    ws.send(
      JSON.stringify({
        type: "cmd:result",
        requestId,
        success,
        output,
      }),
    );
  }

  private getSettings(sessionToken: string): Record<string, unknown> {
    if (!this.sessionSettings.has(sessionToken)) {
      this.sessionSettings.set(sessionToken, {});
    }
    return this.sessionSettings.get(sessionToken)!;
  }

  private async dispatch(
    command: string,
    args: Record<string, unknown>,
    sessionToken: string,
  ): Promise<string> {
    const settings = this.getSettings(sessionToken);

    switch (command) {
      // ─── Session ────────────────────────────────────────────────
      case "reset":
      case "new": {
        this.sessionSettings.delete(sessionToken);
        return "Session and settings reset. Fresh start.";
      }

      case "session": {
        const lines = ["**Session Info**"];
        const model = settings.model as string | undefined;
        const threadId = settings.threadId as string | undefined;
        if (model) lines.push(`Model: \`${model}\``);
        if (threadId) lines.push(`Thread: \`${threadId}\``);
        if (lines.length === 1) lines.push("No custom settings.");
        return lines.join("\n");
      }

      // ─── Model ──────────────────────────────────────────────────
      case "model": {
        const defaultModel = process.env.DEFAULT_MODEL ?? "moonshotai/kimi-k2.5";
        const modelArg = args.model as string | undefined;
        if (!modelArg) {
          const current = settings.model as string | undefined;
          return current
            ? `Current model: \`${current}\`\nSet with: model <id>`
            : `Using default model: \`${defaultModel}\`\nSet with: model <id>`;
        }
        settings.model = modelArg;
        return `Model set to \`${modelArg}\`.`;
      }

      // ─── Thread ─────────────────────────────────────────────────
      case "thread": {
        const threadArg = args.threadId as string | undefined;
        if (!threadArg) {
          const current = settings.threadId as string | undefined;
          if (current) return `Current thread: \`${current}\``;
          // Create a new thread
          const newThreadId = await this.bridge.client.createThread();
          settings.threadId = newThreadId;
          return `New thread created: \`${newThreadId}\``;
        }
        settings.threadId = threadArg;
        return `Thread set to \`${threadArg}\`.`;
      }

      // ─── Status ─────────────────────────────────────────────────
      case "hq":
      case "hq-status":
      case "status": {
        const { pendingJobs, runningJobs, agentOnline } =
          await this.bridge.getSystemStatus();

        const lines = [
          "**HQ Status**",
          `Agent: ${agentOnline ? "online" : "offline"}`,
          `Pending jobs: ${pendingJobs}`,
          `Running jobs: ${runningJobs}`,
        ];
        return lines.join("\n");
      }

      // ─── Memory ─────────────────────────────────────────────────
      case "memory": {
        const memoryPath = require("path").join(
          this.bridge.vaultDir,
          "_system",
          "MEMORY.md",
        );
        const fs = require("fs");
        if (!fs.existsSync(memoryPath)) {
          return "No memories stored yet.";
        }
        const content = fs.readFileSync(memoryPath, "utf-8") as string;
        // Strip frontmatter
        const lines = content.split("\n");
        const bodyStart = lines.findIndex((l, i) => i > 0 && l === "---") + 1;
        const body = bodyStart > 0 ? lines.slice(bodyStart).join("\n") : content;
        return body.substring(0, 1500) || "Memory file is empty.";
      }

      // ─── Threads ────────────────────────────────────────────────
      case "threads": {
        const threads = await this.bridge.listThreads();
        if (!(threads as any[]).length) return "No threads found.";
        const lines = ["**Recent Threads:**"];
        for (const t of (threads as any[]).slice(0, 10)) {
          lines.push(`- \`${t.threadId}\`: ${t.title ?? "Untitled"} (${formatTimeAgo(t.updatedAt)})`);
        }
        return lines.join("\n");
      }

      // ─── Notes search ───────────────────────────────────────────
      case "search": {
        const query = args.query as string | undefined;
        if (!query) return "Usage: search <query>";
        const results = await this.bridge.searchNotes(query, 5);
        if (!results.length) return `No notes found for: "${query}"`;
        const lines = [`**Search: "${query}"**`];
        for (const r of results) {
          lines.push(`- **${r.title}**: ${r.snippet.substring(0, 150)}...`);
        }
        return lines.join("\n");
      }

      // ─── Delegation ─────────────────────────────────────────────
      case "delegate": {
        const task = args.task as string | undefined;
        const targetHarness = (args.targetHarness ?? "any") as "gemini-cli" | "claude-code" | "any";
        if (!task) return "Usage: delegate <task> [targetHarness]";

        const taskId = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const jobId = `wa-job-${Date.now()}`;
        await this.bridge.createDelegationTask({
          taskId,
          jobId,
          instruction: task,
          targetHarnessType: targetHarness,
        });

        return taskId;
      }

      case "task-result": {
        const taskId = args.taskId as string | undefined;
        if (!taskId) return "Usage: task-result <taskId>";
        const result = this.bridge.getDelegationResult(taskId);
        return result ?? "__pending__";
      }

      case "job-result": {
        const jobId = args.jobId as string | undefined;
        if (!jobId) return "Usage: job-result <jobId>";
        const result = this.bridge.getJobResult(jobId);
        return result ?? "__pending__";
      }

      // ─── Settings ───────────────────────────────────────────────
      case "clear":
      case "defaults": {
        this.sessionSettings.delete(sessionToken);
        return "All session settings cleared.";
      }

      // ─── Help ───────────────────────────────────────────────────
      case "help":
      case "commands": {
        return [
          "**Relay Commands**",
          "",
          "**Session**",
          "`reset` — Clear session settings",
          "`session` — Show current session info",
          "`thread` — Show/create thread",
          "`thread {threadId}` — Switch to thread",
          "",
          "**Model**",
          "`model` — Show current model",
          "`model {id}` — Set model",
          "",
          "**System**",
          "`status` — HQ system status",
          "`memory` — View stored memories",
          "`threads` — List recent threads",
          "`search {query}` — Search vault notes",
          "",
          "**Settings**",
          "`clear` — Reset all session settings",
        ].join("\n");
      }

      default:
        return `Unknown command: \`${command}\`. Try \`help\` for available commands.`;
    }
  }
}

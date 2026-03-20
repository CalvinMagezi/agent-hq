/**
 * Harness delegation tool — allows the HQ agent to spawn other CLI
 * harnesses (Claude Code, Gemini CLI) for specialized sub-tasks.
 *
 * This makes HQ the orchestrator harness — it handles vault context,
 * task management, and briefs itself, but delegates complex coding
 * to Claude Code and workspace ops to Gemini CLI.
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "bun";
import { execSync } from "child_process";
import type { HQAgentTool, ToolResult } from "@repo/agent-core";

// ── Types ───────────────────────────────────────────────────────────

type DelegateHarness = "claude-code" | "gemini-cli" | "opencode";

const HARNESS_COMMANDS: Record<DelegateHarness, string> = {
  "claude-code": "claude",
  "gemini-cli": "gemini",
  "opencode": "opencode",
};

const HARNESS_DESCRIPTIONS: Record<DelegateHarness, string> = {
  "claude-code": "Complex coding tasks — refactoring, debugging, multi-file changes, code review",
  "gemini-cli": "Google Workspace tasks — calendar, gmail, drive, sheets",
  "opencode": "Alternative coding harness with different model backends",
};

// ── Tool ────────────────────────────────────────────────────────────

const DelegateSchema = Type.Object({
  harness: Type.Union(
    [Type.Literal("claude-code"), Type.Literal("gemini-cli"), Type.Literal("opencode")],
    { description: "Which CLI harness to delegate to" },
  ),
  instruction: Type.String({
    description: "The task instruction to pass to the harness",
  }),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the harness (defaults to current)",
  })),
});

/**
 * Create the delegate_to_harness tool for use in hq-run.ts.
 */
export function createDelegateToHarnessTool(defaultCwd: string): HQAgentTool {
  return {
    name: "delegate_to_harness",
    description: `Delegate a task to a specialized CLI harness. Use this when the task needs capabilities beyond your tools.

Available harnesses:
${Object.entries(HARNESS_DESCRIPTIONS).map(([k, v]) => `- **${k}**: ${v}`).join("\n")}

Guidelines:
- Use claude-code for complex multi-file coding, debugging, test writing
- Use gemini-cli for Google Workspace operations (calendar, email, drive)
- Try to handle simple tasks yourself first; only delegate when specialized tools are needed`,
    parameters: DelegateSchema,
    label: "Delegate to Harness",
    execute: async (_id, args) => {
      const { harness, instruction, cwd } = args as {
        harness: DelegateHarness;
        instruction: string;
        cwd?: string;
      };

      const workDir = cwd ?? defaultCwd;
      const cmdName = HARNESS_COMMANDS[harness];

      // Resolve command path
      let cmdPath: string;
      try {
        cmdPath = execSync(`which ${cmdName}`, { encoding: "utf-8" }).trim();
      } catch {
        return {
          content: [{
            type: "text",
            text: `Error: ${cmdName} CLI not found. Install it or use a different harness.`,
          }],
        };
      }

      // Build command args based on harness type
      const cmdArgs = buildHarnessArgs(harness, cmdPath, instruction);

      try {
        const proc = spawn({
          cmd: cmdArgs,
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: { ...process.env },
        });

        // Set a generous timeout (5 minutes)
        const timeout = setTimeout(() => {
          try { proc.kill(); } catch { /* already dead */ }
        }, 5 * 60 * 1000);

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        clearTimeout(timeout);
        const exitCode = await proc.exited;

        // Parse NDJSON output for Claude Code
        let result = "";
        if (harness === "claude-code") {
          result = parseClaudeNDJSON(stdout);
        } else {
          result = stdout.trim();
        }

        if (!result && stderr.trim()) {
          result = `[stderr]: ${stderr.trim().slice(0, 2000)}`;
        }

        if (!result) {
          result = exitCode === 0
            ? "(harness completed with no output)"
            : `(harness exited with code ${exitCode})`;
        }

        // Truncate very long output
        if (result.length > 30000) {
          result = result.slice(0, 15000) + "\n\n[... truncated ...]\n\n" + result.slice(-15000);
        }

        return {
          content: [{ type: "text", text: result }],
          details: { harness, exitCode },
        };
      } catch (err: unknown) {
        return {
          content: [{
            type: "text",
            text: `Delegation to ${harness} failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildHarnessArgs(harness: DelegateHarness, cmdPath: string, instruction: string): string[] {
  switch (harness) {
    case "claude-code":
      return [
        cmdPath,
        "--print",                       // Non-interactive, print result
        "--output-format", "stream-json", // NDJSON for parsing
        "--max-turns", "50",
        "--dangerously-skip-permissions",
        instruction,
      ];

    case "gemini-cli":
      return [cmdPath, "-p", instruction];

    case "opencode":
      return [cmdPath, "--prompt", instruction];

    default:
      return [cmdPath, instruction];
  }
}

function parseClaudeNDJSON(output: string): string {
  const texts: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.type === "assistant" || msg.type === "message") {
        const content = msg.message?.content ?? msg.content;
        if (typeof content === "string") {
          texts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              texts.push(block.text);
            }
          }
        }
      } else if (msg.type === "result" && typeof msg.result === "string") {
        texts.push(msg.result);
      }
    } catch {
      // Non-JSON line
    }
  }
  return texts.join("") || output.trim();
}

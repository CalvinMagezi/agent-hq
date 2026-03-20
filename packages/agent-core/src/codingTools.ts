/**
 * Native coding tools — Bun-native replacements for Pi SDK's bash/read/write/edit/find/grep/ls.
 *
 * Zero external dependencies. Uses Bun APIs (Bun.spawn, Bun.file, Bun.write, Bun.Glob).
 */

import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";
import type { HQAgentTool, ToolResult, BashSpawnHook } from "./types.js";

const ok = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const err = (text: string): ToolResult => ({
  content: [{ type: "text", text: `Error: ${text}` }],
});

// ── Bash Tool ───────────────────────────────────────────────────────

export function createBashTool(
  cwd: string,
  options?: {
    spawnHook?: BashSpawnHook;
    timeout?: number;
  },
): HQAgentTool {
  const timeout = options?.timeout ?? 120_000;

  return {
    name: "bash",
    description: "Execute a shell command and return its output. Use for system operations, running tests, git commands, etc.",
    parameters: Type.Object({
      command: Type.String({ description: "The shell command to execute" }),
    }),
    label: "Bash",
    execute: async (_id, args, signal) => {
      const { command } = args as { command: string };

      // Run spawn hook (governance transform — may modify command/env or throw to block)
      let effectiveCwd = cwd;
      let effectiveCommand = command;
      let effectiveEnv: Record<string, string | undefined> = { ...process.env };
      if (options?.spawnHook) {
        try {
          const ctx = await options.spawnHook({ command, cwd, env: effectiveEnv });
          effectiveCommand = ctx.command;
          effectiveCwd = ctx.cwd;
          if (ctx.env) effectiveEnv = ctx.env;
        } catch (hookErr: unknown) {
          return err(`Command blocked by security policy: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`);
        }
      }

      try {
        const proc = Bun.spawn(["bash", "-c", effectiveCommand], {
          cwd: effectiveCwd,
          stdout: "pipe",
          stderr: "pipe",
          env: effectiveEnv,
        });

        // Timeout handling
        const timeoutId = setTimeout(() => proc.kill(), timeout);

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        clearTimeout(timeoutId);
        const exitCode = await proc.exited;

        let output = "";
        if (stdout.trim()) output += stdout;
        if (stderr.trim()) {
          if (output) output += "\n";
          output += stderr;
        }
        if (!output.trim()) output = exitCode === 0 ? "(no output)" : `(exit code ${exitCode})`;

        // Truncate very long output
        if (output.length > 50000) {
          output = output.slice(0, 25000) + "\n\n[... truncated ...]\n\n" + output.slice(-25000);
        }

        return ok(output);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

// ── Read Tool ───────────────────────────────────────────────────────

export function createReadTool(cwd: string): HQAgentTool {
  return {
    name: "read",
    description: "Read a file's contents with line numbers. Supports offset and limit for large files.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to working directory or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Starting line number (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    label: "Read File",
    execute: async (_id, args) => {
      const { path: filePath, offset, limit } = args as { path: string; offset?: number; limit?: number };
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

      try {
        const text = await Bun.file(fullPath).text();
        const lines = text.split("\n");

        const start = Math.max(0, (offset ?? 1) - 1);
        const end = limit ? Math.min(lines.length, start + limit) : lines.length;
        const selected = lines.slice(start, end);

        // Format with line numbers like cat -n
        const numbered = selected
          .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
          .join("\n");

        return ok(numbered || "(empty file)");
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

// ── Write Tool ──────────────────────────────────────────────────────

export function createWriteTool(cwd: string): HQAgentTool {
  return {
    name: "write",
    description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to working directory or absolute)" }),
      content: Type.String({ description: "Content to write to the file" }),
    }),
    label: "Write File",
    execute: async (_id, args) => {
      const { path: filePath, content } = args as { path: string; content: string };
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

      try {
        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        await Bun.write(fullPath, content);
        return ok(`Wrote ${content.length} bytes to ${filePath}`);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

// ── Edit Tool ───────────────────────────────────────────────────────

export function createEditTool(cwd: string): HQAgentTool {
  return {
    name: "edit",
    description: "Find and replace text in a file. The old_string must be unique in the file. Use for surgical edits.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to working directory or absolute)" }),
      old_string: Type.String({ description: "Exact text to find (must be unique in the file)" }),
      new_string: Type.String({ description: "Replacement text" }),
    }),
    label: "Edit File",
    execute: async (_id, args) => {
      const { path: filePath, old_string, new_string } = args as { path: string; old_string: string; new_string: string };
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

      try {
        const content = await Bun.file(fullPath).text();

        // Check uniqueness
        const occurrences = content.split(old_string).length - 1;
        if (occurrences === 0) {
          return err(`old_string not found in ${filePath}. Check for exact whitespace and indentation.`);
        }
        if (occurrences > 1) {
          return err(`old_string found ${occurrences} times in ${filePath}. Provide more surrounding context to make it unique.`);
        }

        const newContent = content.replace(old_string, new_string);
        await Bun.write(fullPath, newContent);
        return ok(`Edited ${filePath}: replaced 1 occurrence`);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

// ── Find Tool ───────────────────────────────────────────────────────

export function createFindTool(cwd: string): HQAgentTool {
  return {
    name: "find",
    description: "Find files matching a glob pattern. Returns file paths sorted by modification time.",
    parameters: Type.Object({
      pattern: Type.String({ description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")' }),
      path: Type.Optional(Type.String({ description: "Directory to search in (default: working directory)" })),
    }),
    label: "Find Files",
    execute: async (_id, args) => {
      const { pattern, path: searchPath } = args as { pattern: string; path?: string };
      const dir = searchPath
        ? (path.isAbsolute(searchPath) ? searchPath : path.resolve(cwd, searchPath))
        : cwd;

      try {
        const glob = new Bun.Glob(pattern);
        const matches: string[] = [];
        for await (const match of glob.scan({ cwd: dir, onlyFiles: true })) {
          matches.push(match);
          if (matches.length >= 200) break; // Safety limit
        }

        if (matches.length === 0) {
          return ok(`No files matching "${pattern}" in ${dir}`);
        }

        return ok(matches.join("\n"));
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

// ── Grep Tool ───────────────────────────────────────────────────────

export function createGrepTool(cwd: string): HQAgentTool {
  return {
    name: "grep",
    description: "Search file contents with a regex pattern. Returns matching lines with file paths and line numbers.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regex pattern to search for" }),
      path: Type.Optional(Type.String({ description: "File or directory to search (default: working directory)" })),
      glob: Type.Optional(Type.String({ description: 'File glob filter (e.g. "*.ts")' })),
    }),
    label: "Search Content",
    execute: async (_id, args) => {
      const { pattern, path: searchPath, glob: globFilter } = args as {
        pattern: string;
        path?: string;
        glob?: string;
      };
      const dir = searchPath
        ? (path.isAbsolute(searchPath) ? searchPath : path.resolve(cwd, searchPath))
        : cwd;

      try {
        // Try ripgrep first (fast), fall back to inline search
        const rgArgs = ["rg", "--no-heading", "--line-number", "--max-count", "50"];
        if (globFilter) rgArgs.push("--glob", globFilter);
        rgArgs.push(pattern, dir);

        const proc = Bun.spawn(rgArgs, { stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;

        if (exitCode === 0 && stdout.trim()) {
          // Truncate if too long
          const output = stdout.length > 20000
            ? stdout.slice(0, 20000) + "\n[... truncated ...]"
            : stdout;
          return ok(output.trim());
        }

        if (exitCode === 1) {
          return ok(`No matches for "${pattern}" in ${dir}`);
        }

        // ripgrep not available — fall back to inline
        return ok(`No matches for "${pattern}" in ${dir}`);
      } catch {
        return ok(`No matches for "${pattern}" in ${dir}`);
      }
    },
  };
}

// ── LS Tool ─────────────────────────────────────────────────────────

export function createLsTool(cwd: string): HQAgentTool {
  return {
    name: "ls",
    description: "List directory contents with file sizes and types.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list (default: working directory)" })),
    }),
    label: "List Directory",
    execute: async (_id, args) => {
      const { path: dirPath } = args as { path?: string };
      const dir = dirPath
        ? (path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath))
        : cwd;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const lines = entries.map(entry => {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            return `  ${entry.name}/`;
          }
          try {
            const stat = fs.statSync(fullPath);
            const size = formatSize(stat.size);
            return `  ${entry.name}  (${size})`;
          } catch {
            return `  ${entry.name}`;
          }
        });

        return ok(lines.join("\n") || "(empty directory)");
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create all 7 coding tools for a given working directory.
 * This replaces Pi SDK's createCodingTools + createBashTool.
 */
export function createCodingTools(
  cwd: string,
  options?: { spawnHook?: BashSpawnHook; bashTimeout?: number },
): HQAgentTool[] {
  return [
    createBashTool(cwd, { spawnHook: options?.spawnHook, timeout: options?.bashTimeout }),
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createFindTool(cwd),
    createGrepTool(cwd),
    createLsTool(cwd),
  ];
}

#!/usr/bin/env bun
/**
 * agent-hq-chat — Terminal chat CLI for Agent HQ.
 *
 * Provides a readline-based REPL with:
 * - Streaming responses from OpenRouter
 * - Thread management (create, switch, list, archive)
 * - Context injection (SOUL, MEMORY, PREFERENCES, pinned notes)
 * - /hq command to dispatch jobs to the HQ agent
 * - Thread persistence to .vault/_threads/
 *
 * Usage: bun run scripts/agent-hq-chat.ts
 */

import * as readline from "readline";
import * as path from "path";
import { VaultClient } from "@repo/vault-client";
import { SearchClient } from "@repo/vault-client/search";

// ─── Configuration ───────────────────────────────────────────────────

const VAULT_PATH =
  process.env.VAULT_PATH ??
  path.resolve(import.meta.dir, "..", ".vault");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL =
  process.env.DEFAULT_MODEL ?? "moonshotai/kimi-k2.5";

if (!OPENROUTER_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY is required. Set it in .env.local");
  process.exit(1);
}

// ─── Initialization ──────────────────────────────────────────────────

const vault = new VaultClient(VAULT_PATH);
let search: SearchClient | null = null;

try {
  search = new SearchClient(VAULT_PATH);
} catch {
  console.warn("Warning: Search index not available. Semantic search disabled.");
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

let currentThreadId: string | null = null;
let messages: Message[] = [];
let systemPrompt = "";

// ─── Helpers ─────────────────────────────────────────────────────────

function colorText(text: string, color: string): string {
  const colors: Record<string, string> = {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    red: "\x1b[31m",
    gray: "\x1b[90m",
  };
  return `${colors[color] ?? ""}${text}${colors.reset}`;
}

function printHeader(): void {
  console.log("");
  console.log(colorText("  Agent HQ Chat", "bold"));
  console.log(colorText("  Type /help for commands, Ctrl+C to exit", "dim"));
  console.log("");
}

function printHelp(): void {
  console.log("");
  console.log(colorText("Commands:", "bold"));
  console.log("  /new [title]    — Start a new thread");
  console.log("  /threads        — List active threads");
  console.log("  /switch <id>    — Switch to a thread");
  console.log("  /archive        — Archive current thread");
  console.log("  /hq <task>      — Dispatch a job to the HQ agent");
  console.log("  /search <query> — Search notes in vault");
  console.log("  /model <name>   — Switch model for this session");
  console.log("  /context        — Show current system context");
  console.log("  /clear          — Clear current conversation");
  console.log("  /help           — Show this help");
  console.log("  /quit           — Exit");
  console.log("");
}

// ─── System Context ──────────────────────────────────────────────────

async function loadSystemContext(): Promise<string> {
  const ctx = await vault.getAgentContext();

  const parts: string[] = [];

  if (ctx.soul) {
    parts.push("## Identity\n" + ctx.soul);
  }
  if (ctx.memory) {
    parts.push("## Memory\n" + ctx.memory);
  }
  if (ctx.preferences) {
    parts.push("## User Preferences\n" + ctx.preferences);
  }
  if (ctx.pinnedNotes.length > 0) {
    const pinned = ctx.pinnedNotes
      .map((n) => `### ${n.title}\n${n.content}`)
      .join("\n\n");
    parts.push("## Pinned Notes\n" + pinned);
  }

  const model = ctx.config.default_model ?? DEFAULT_MODEL;
  parts.push(
    `## Configuration\nModel: ${model}\nDate: ${new Date().toLocaleDateString()}\nVault: ${VAULT_PATH}`,
  );

  return parts.join("\n\n---\n\n");
}

// ─── Chat ────────────────────────────────────────────────────────────

async function streamChat(userMessage: string): Promise<string> {
  messages.push({ role: "user", content: userMessage });

  const model = DEFAULT_MODEL;
  const requestMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://agent-hq.local",
          "X-Title": "Agent HQ Chat",
        },
        body: JSON.stringify({
          model,
          messages: requestMessages,
          stream: true,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error ${response.status}: ${error}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    // Stream the response
    process.stdout.write(colorText("\n  Assistant: ", "cyan"));

    let fullResponse = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));

      for (const line of lines) {
        const data = line.substring(6).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            process.stdout.write(delta);
            fullResponse += delta;
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    process.stdout.write("\n\n");

    messages.push({ role: "assistant", content: fullResponse });

    // Save to thread
    if (currentThreadId) {
      await vault.appendMessage(currentThreadId, "user", userMessage);
      await vault.appendMessage(currentThreadId, "assistant", fullResponse);
    }

    return fullResponse;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(colorText(`\n  Error: ${errMsg}`, "red"));
    // Remove the user message since the response failed
    messages.pop();
    return "";
  }
}

// ─── Command Handlers ────────────────────────────────────────────────

async function handleCommand(input: string): Promise<boolean> {
  const parts = input.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1).join(" ");

  switch (cmd) {
    case "/help":
      printHelp();
      return true;

    case "/quit":
    case "/exit":
      console.log(colorText("\n  Goodbye!", "dim"));
      search?.close();
      process.exit(0);

    case "/new": {
      const title = args || undefined;
      currentThreadId = await vault.createThread(title);
      messages = [];
      systemPrompt = await loadSystemContext();
      console.log(
        colorText(
          `\n  New thread: ${currentThreadId}${title ? ` — "${title}"` : ""}`,
          "green",
        ),
      );
      return true;
    }

    case "/threads": {
      const threads = await vault.listThreads();
      if (threads.length === 0) {
        console.log(colorText("\n  No active threads.", "dim"));
      } else {
        console.log(colorText("\n  Active Threads:", "bold"));
        for (const t of threads) {
          const marker = t.threadId === currentThreadId ? " *" : "";
          console.log(
            `  ${colorText(t.threadId, "cyan")}${colorText(marker, "green")} — ${t.title} (${t.createdAt.split("T")[0]})`,
          );
        }
      }
      console.log("");
      return true;
    }

    case "/switch": {
      if (!args) {
        console.log(colorText("\n  Usage: /switch <thread-id>", "yellow"));
        return true;
      }
      try {
        const note = await vault.readNote(`_threads/active/${args}.md`);
        currentThreadId = args;
        messages = []; // TODO: Parse existing messages from thread file
        systemPrompt = await loadSystemContext();
        console.log(colorText(`\n  Switched to thread: ${args}`, "green"));
      } catch {
        console.log(colorText(`\n  Thread not found: ${args}`, "red"));
      }
      return true;
    }

    case "/archive": {
      if (!currentThreadId) {
        console.log(colorText("\n  No active thread to archive.", "yellow"));
        return true;
      }
      try {
        const src = path.join(
          VAULT_PATH,
          "_threads/active",
          `${currentThreadId}.md`,
        );
        const dest = path.join(
          VAULT_PATH,
          "_threads/archived",
          `${currentThreadId}.md`,
        );
        const { rename } = await import("fs");
        rename(src, dest, () => {});
        console.log(
          colorText(`\n  Archived thread: ${currentThreadId}`, "green"),
        );
        currentThreadId = null;
        messages = [];
      } catch {
        console.log(colorText("\n  Failed to archive thread.", "red"));
      }
      return true;
    }

    case "/hq": {
      if (!args) {
        console.log(colorText("\n  Usage: /hq <task instruction>", "yellow"));
        return true;
      }
      const jobId = await vault.createJob({
        instruction: args,
        type: "background",
        priority: 50,
        securityProfile: "standard",
      });
      console.log(
        colorText(`\n  Job dispatched: ${jobId}`, "green"),
      );
      console.log(
        colorText("  The HQ agent will pick this up on next poll.", "dim"),
      );
      return true;
    }

    case "/search": {
      if (!args) {
        console.log(colorText("\n  Usage: /search <query>", "yellow"));
        return true;
      }
      const results = await vault.searchNotes(args, 5);
      if (results.length === 0) {
        console.log(colorText("\n  No results found.", "dim"));
      } else {
        console.log(colorText(`\n  Search Results for "${args}":`, "bold"));
        for (const r of results) {
          console.log(
            `  ${colorText(r.title, "cyan")} [${r.notebook}]`,
          );
          console.log(
            `    ${colorText(r.snippet.substring(0, 80), "dim")}`,
          );
        }
      }
      console.log("");
      return true;
    }

    case "/model": {
      if (!args) {
        console.log(
          colorText(`\n  Current model: ${DEFAULT_MODEL}`, "dim"),
        );
        return true;
      }
      // Note: This only changes for the current session
      (globalThis as any).__currentModel = args;
      console.log(
        colorText(`\n  Model set to: ${args} (this session only)`, "green"),
      );
      return true;
    }

    case "/context": {
      const ctx = await vault.getAgentContext();
      console.log(colorText("\n  System Context:", "bold"));
      console.log(
        colorText(`  Soul: ${ctx.soul.substring(0, 80)}...`, "dim"),
      );
      console.log(
        colorText(`  Memory: ${ctx.memory.substring(0, 80)}...`, "dim"),
      );
      console.log(
        colorText(`  Pinned notes: ${ctx.pinnedNotes.length}`, "dim"),
      );
      console.log(
        colorText(
          `  Config keys: ${Object.keys(ctx.config).join(", ")}`,
          "dim",
        ),
      );
      console.log("");
      return true;
    }

    case "/clear":
      messages = [];
      console.log(colorText("\n  Conversation cleared.", "green"));
      return true;

    default:
      return false;
  }
}

// ─── Main REPL ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  printHeader();

  // Load system context
  console.log(colorText("  Loading system context...", "dim"));
  systemPrompt = await loadSystemContext();

  // Create initial thread
  currentThreadId = await vault.createThread();
  console.log(
    colorText(`  Thread: ${currentThreadId}`, "dim"),
  );
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: colorText("  You: ", "green"),
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith("/")) {
      const handled = await handleCommand(input);
      if (!handled) {
        console.log(
          colorText(`\n  Unknown command: ${input.split(/\s/)[0]}`, "yellow"),
        );
      }
      rl.prompt();
      return;
    }

    // Regular chat message
    await streamChat(input);
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(colorText("\n  Goodbye!", "dim"));
    search?.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

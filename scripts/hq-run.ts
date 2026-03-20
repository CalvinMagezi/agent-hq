#!/usr/bin/env bun
/**
 * hq-run — HQ Agent as an ultra-light CLI harness.
 *
 * Spawnable by LocalHarness just like Claude Code, Gemini CLI, or OpenCode.
 * Outputs NDJSON matching Claude Code's stream-json format so relay adapters
 * parse it without changes.
 *
 * Usage:
 *   bun run scripts/hq-run.ts --prompt "What projects am I working on?"
 *   bun run scripts/hq-run.ts --prompt "Fix the bug" --model gemini-3-flash-preview
 *   bun run scripts/hq-run.ts --resume <sessionId> --prompt "Continue"
 *   bun run scripts/hq-run.ts --prompt "list files" --output-format text
 *
 * Provider routing is automatic based on env vars:
 *   ANTHROPIC_API_KEY → Anthropic direct
 *   GEMINI_API_KEY    → Google direct
 *   OPENROUTER_API_KEY → OpenRouter (any model)
 *   OLLAMA_BASE_URL    → Local Ollama
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import {
  NativeAgentSession,
  createCodingTools,
  resolveProvider,
  OpenAIProvider,
  type SessionEvent,
  type SessionState,
  type HQAgentTool,
  type ModelProvider,
} from "@repo/agent-core";
import { buildModelConfig, getContextWindow } from "../apps/agent/lib/modelConfig.js";
import { createDefaultRegistry, createHQGatewayTools } from "@repo/hq-tools";
import type { HQContext } from "@repo/hq-tools";
import { createDelegateToHarnessTool } from "../apps/agent/lib/harnessDelegate.js";
import { scanInbox, formatInbox } from "../apps/agent/lib/inbox.js";
import { computeMetrics, formatMetrics } from "../apps/agent/lib/evaluator.js";

// ── Parse Args ──────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    prompt: { type: "string", short: "p" },
    model: { type: "string", short: "m" },
    resume: { type: "string", short: "r" },
    "output-format": { type: "string", default: "stream-json" },
    cwd: { type: "string" },
  },
  strict: false,
});

const prompt = values.prompt as string | undefined;
if (!prompt) {
  console.error("Usage: hq-run --prompt <text> [--model <id>] [--resume <sessionId>] [--output-format stream-json|text]");
  process.exit(1);
}

const outputFormat = (values["output-format"] as string) ?? "stream-json";
const workingDir = (values.cwd as string) ?? process.cwd();

// ── Environment ─────────────────────────────────────────────────────

// Load .env from monorepo root if available
const envPath = path.resolve(workingDir, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const VAULT_PATH = process.env.VAULT_PATH || path.resolve(workingDir, ".vault");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
const NVIDIA_NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY;
const DEFAULT_MODEL = process.env.HQ_MODEL || process.env.DEFAULT_MODEL || "moonshotai/kimi-k2.5";
const FALLBACK_MODEL = process.env.HQ_FALLBACK_MODEL || "google/gemini-3.1-flash-lite-preview";

const SESSION_DIR = path.join(VAULT_PATH, "_system", "hq-sessions");

// ── NDJSON Output ───────────────────────────────────────────────────

function emitJson(obj: Record<string, unknown>) {
  if (outputFormat === "stream-json") {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }
}

function emitText(text: string) {
  if (outputFormat === "text") {
    process.stdout.write(text);
  }
}

// ── Build System Prompt ─────────────────────────────────────────────

function buildSystemPrompt(): string {
  const sections: string[] = [];

  sections.push(`You are the HQ agent for Agent-HQ, a local-first AI orchestration hub.
Working directory: ${workingDir}
Vault location: ${VAULT_PATH}
Current time: ${new Date().toISOString()}`);

  // Load user preferences
  const prefsPath = path.join(VAULT_PATH, "PREFERENCES.md");
  if (fs.existsSync(prefsPath)) {
    const prefs = fs.readFileSync(prefsPath, "utf-8").slice(0, 2000);
    sections.push(`## User Preferences\n${prefs}`);
  }

  // Load lessons from prior tasks
  const lessonsPath = path.join(VAULT_PATH, "_system", "LESSONS.md");
  if (fs.existsSync(lessonsPath)) {
    const lessons = fs.readFileSync(lessonsPath, "utf-8").slice(0, 3000);
    sections.push(`## Lessons from Prior Tasks\n${lessons}`);
  }

  // Load SOUL.md (mission/values)
  const soulPath = path.join(VAULT_PATH, "SOUL.md");
  if (fs.existsSync(soulPath)) {
    const soul = fs.readFileSync(soulPath, "utf-8").slice(0, 1000);
    sections.push(`## Mission\n${soul}`);
  }

  // Load memory
  const memoryPath = path.join(VAULT_PATH, "MEMORY.md");
  if (fs.existsSync(memoryPath)) {
    const memory = fs.readFileSync(memoryPath, "utf-8").slice(0, 2000);
    sections.push(`## Memory\n${memory}`);
  }

  sections.push(`## Behavior
- Always check vault context before answering
- Write outputs to .vault/, never to the Agent-HQ repo
- Use lessons from prior tasks to improve
- For complex coding, delegate to Claude Code via delegate_to_harness
- For Google Workspace, delegate to Gemini CLI via delegate_to_harness
- Handle simple tasks (vault search, reading, writing, summaries) yourself
- Be concise and direct`);

  return sections.join("\n\n");
}

// ── Build Tools ─────────────────────────────────────────────────────

function buildTools(): HQAgentTool[] {
  const tools: HQAgentTool[] = [];

  // Coding tools (bash, read, write, edit, find, grep, ls)
  tools.push(...createCodingTools(workingDir));

  // HQ gateway tools (discover + call — access to entire tool registry)
  try {
    const hqCtx: HQContext = {
      vaultPath: VAULT_PATH,
      securityProfile: "standard",
    };
    const registry = createDefaultRegistry(hqCtx);
    const [discoverTool, callTool] = createHQGatewayTools(registry, hqCtx);
    tools.push(discoverTool as HQAgentTool, callTool as HQAgentTool);
  } catch {
    // HQ tools registry may not be available — continue without
  }

  // Harness delegation — spawn Claude Code, Gemini CLI for specialized tasks
  tools.push(createDelegateToHarnessTool(workingDir) as HQAgentTool);

  // Inbox scanner tool — check pending work
  tools.push(createInboxTool());

  // Performance metrics tool
  tools.push(createMetricsTool());

  return tools;
}

// ── Inline Tools (inbox, metrics) ───────────────────────────────────

function createInboxTool(): HQAgentTool {
  const { Type } = require("@sinclair/typebox");
  return {
    name: "scan_inbox",
    description: "Scan the vault for pending work items — inbox notes, pending jobs, failed jobs, stale tasks. Returns a prioritized list.",
    parameters: Type.Object({}),
    label: "Scan Inbox",
    execute: async () => {
      const items = scanInbox(VAULT_PATH);
      return { content: [{ type: "text", text: formatInbox(items) }] };
    },
  };
}

function createMetricsTool(): HQAgentTool {
  const { Type } = require("@sinclair/typebox");
  return {
    name: "agent_metrics",
    description: "Get agent performance metrics — success rate, token usage, duration, top lessons. Useful for morning briefs and status reports.",
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "Number of days to look back (default 30)" })),
    }),
    label: "Agent Metrics",
    execute: async (_id, args) => {
      const days = (args as any)?.days ?? 30;
      const metrics = computeMetrics(VAULT_PATH, days);
      return { content: [{ type: "text", text: formatMetrics(metrics) }] };
    },
  };
}

// ── Session Persistence ─────────────────────────────────────────────

function loadSession(sessionId: string): SessionState | null {
  const filePath = path.join(SESSION_DIR, `${sessionId}.json`);
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveSession(state: SessionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const filePath = path.join(SESSION_DIR, `${state.sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));

  // Clean up sessions older than 4 hours
  try {
    const files = fs.readdirSync(SESSION_DIR);
    const cutoff = Date.now() - 4 * 60 * 60 * 1000;
    for (const file of files) {
      const fPath = path.join(SESSION_DIR, file);
      const stat = fs.statSync(fPath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fPath);
      }
    }
  } catch {
    // Cleanup is best-effort
  }
}

// ── Main ────────────────────────────────────────────────────────────

/**
 * NVIDIA NIM model ID mapping — NIM uses its own model identifiers.
 * Maps from our model IDs to NIM-compatible IDs.
 */
const NIM_MODEL_MAP: Record<string, string> = {
  "moonshotai/kimi-k2.5": "moonshotai/kimi-k2.5",
  "kimi-k2.5": "moonshotai/kimi-k2.5",
};

/**
 * Resolve the best provider for a given model.
 * Priority: NVIDIA NIM (free) → OpenRouter → other providers.
 */
function resolveProviderForModel(modelId: string): { provider: ModelProvider; label: string } {
  const nimModelId = NIM_MODEL_MAP[modelId];

  // Try NVIDIA NIM first (free, 40 RPM)
  if (nimModelId && NVIDIA_NIM_API_KEY) {
    return {
      provider: new OpenAIProvider({
        apiKey: NVIDIA_NIM_API_KEY,
        baseUrl: "https://integrate.api.nvidia.com/v1",
      }),
      label: "nvidia-nim",
    };
  }

  // Fall back to standard provider resolution
  const keys = {
    anthropicApiKey: ANTHROPIC_API_KEY,
    geminiApiKey: GEMINI_API_KEY,
    openrouterApiKey: OPENROUTER_API_KEY,
    ollamaBaseUrl: OLLAMA_BASE_URL,
  };
  const model = buildModelConfig({
    modelId,
    geminiApiKey: GEMINI_API_KEY,
    anthropicApiKey: ANTHROPIC_API_KEY,
    openrouterApiKey: OPENROUTER_API_KEY,
    ollamaBaseUrl: OLLAMA_BASE_URL,
  });
  return {
    provider: resolveProvider(model, keys),
    label: model.provider,
  };
}

function buildSession(modelId: string, tools: HQAgentTool[], systemPrompt: string, providerOverride?: { provider: ModelProvider; label: string }) {
  const model = buildModelConfig({
    modelId,
    geminiApiKey: GEMINI_API_KEY,
    anthropicApiKey: ANTHROPIC_API_KEY,
    openrouterApiKey: OPENROUTER_API_KEY,
    ollamaBaseUrl: OLLAMA_BASE_URL,
  });
  const { provider, label } = providerOverride ?? resolveProviderForModel(modelId);
  const session = new NativeAgentSession(
    {
      tools,
      model,
      systemPrompt,
      maxTurns: 100,
      compaction: { enabled: true, threshold: 0.75, keepRecent: 10 },
      retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30000 },
    },
    provider,
  );
  return { session, modelId, providerLabel: label };
}

function subscribeSession(session: NativeAgentSession): { getText: () => string } {
  let fullText = "";
  session.on((event: SessionEvent) => {
    switch (event.type) {
      case "text_delta":
        emitJson({
          type: "assistant",
          message: { content: [{ type: "text", text: event.delta ?? "" }] },
        });
        emitText(event.delta ?? "");
        fullText += event.delta ?? "";
        break;
      case "tool_start":
        emitJson({ type: "tool_use", name: event.toolName, input: event.toolInput });
        break;
      case "tool_end":
        emitJson({
          type: "tool_result",
          name: event.toolName,
          result: event.toolResult?.content?.map(c => c.text).join("\n") ?? "",
        });
        break;
      case "error":
        emitJson({ type: "error", message: event.error?.message ?? "Unknown error" });
        if (outputFormat === "text") process.stderr.write(`Error: ${event.error?.message}\n`);
        break;
    }
  });
  return { getText: () => fullText };
}

/**
 * Build a fallback chain of { modelId, provider } attempts.
 *
 * For Kimi K2.5:  NVIDIA NIM (free) → OpenRouter (cheap) → fallback model
 * For other models: standard provider → fallback model
 */
function buildProviderChain(requestedModel: string): { modelId: string; providerOverride?: { provider: ModelProvider; label: string } }[] {
  const chain: { modelId: string; providerOverride?: { provider: ModelProvider; label: string } }[] = [];
  const isKimi = requestedModel.includes("kimi-k2.5");

  if (isKimi) {
    // Step 1: Try NVIDIA NIM (free, 40 RPM)
    if (NVIDIA_NIM_API_KEY) {
      chain.push({
        modelId: requestedModel,
        providerOverride: {
          provider: new OpenAIProvider({
            apiKey: NVIDIA_NIM_API_KEY,
            baseUrl: "https://integrate.api.nvidia.com/v1",
          }),
          label: "nvidia-nim",
        },
      });
    }
    // Step 2: Try OpenRouter ($0.45/M — essentially free)
    if (OPENROUTER_API_KEY) {
      chain.push({
        modelId: requestedModel,
        providerOverride: {
          provider: new OpenAIProvider({
            apiKey: OPENROUTER_API_KEY,
            baseUrl: "https://openrouter.ai/api/v1",
            extraHeaders: { "HTTP-Referer": "https://agent-hq.local", "X-Title": "Agent-HQ" },
          }),
          label: "openrouter",
        },
      });
    }
  } else {
    // Non-Kimi model: use standard provider resolution
    chain.push({ modelId: requestedModel });
  }

  // Final fallback: different model entirely
  if (requestedModel !== FALLBACK_MODEL) {
    chain.push({ modelId: FALLBACK_MODEL });
  }

  return chain;
}

async function main() {
  const requestedModel = (values.model as string) ?? DEFAULT_MODEL;
  const tools = buildTools();
  const systemPrompt = buildSystemPrompt();

  const chain = buildProviderChain(requestedModel);

  let session: NativeAgentSession | null = null;
  let usedModel = requestedModel;
  let usedProvider = "unknown";

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const isLast = i === chain.length - 1;

    try {
      const built = buildSession(step.modelId, tools, systemPrompt, step.providerOverride);
      session = built.session;
      usedModel = built.modelId;
      usedProvider = built.providerLabel;

      // Resume prior session if requested
      const resumeId = values.resume as string | undefined;
      if (resumeId) {
        const state = loadSession(resumeId);
        if (state) {
          session.loadState(state);
          emitJson({ type: "system", message: `Resumed session ${resumeId}` });
        }
      }

      subscribeSession(session);

      if (i > 0) {
        process.stderr.write(`[HQ] Falling back to ${step.modelId} via ${built.providerLabel}\n`);
      } else {
        process.stderr.write(`[HQ] Using ${step.modelId} via ${built.providerLabel}\n`);
      }

      await session.prompt(prompt!);
      break; // Success
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      if (isLast) {
        emitJson({ type: "error", message: msg });
        if (outputFormat === "text") process.stderr.write(`Fatal: ${msg}\n`);
        process.exit(1);
      }

      const nextStep = chain[i + 1];
      process.stderr.write(`[HQ] ${step.modelId} via ${step.providerOverride?.label ?? "auto"} failed: ${msg.slice(0, 150)}\n`);
      process.stderr.write(`[HQ] → trying ${nextStep.modelId} via ${nextStep.providerOverride?.label ?? "auto"}...\n`);
      session = null;
    }
  }

  if (!session) process.exit(1);

  // Save session for resumption
  const state = session.saveState();
  saveSession(state);
  emitJson({ session_id: state.sessionId });

  if (outputFormat === "text") process.stdout.write("\n");

  const stats = session.getStats();
  process.stderr.write(
    `\n[HQ] model=${usedModel} via ${usedProvider} | ${stats.turns} turns, ${stats.toolCalls} tool calls, ${stats.usage.totalTokens} tokens ($${stats.usage.estimatedCost.toFixed(4)})\n`
  );
}

main().catch((err) => {
  console.error("hq-run fatal:", err);
  process.exit(1);
});

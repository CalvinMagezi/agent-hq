#!/usr/bin/env bun
/**
 * agent-hq-daemon — Local replacement for Convex cron jobs.
 *
 * A single long-running process that handles all interval-based tasks:
 * - 1 min: Expire stale approvals
 * - 2 min: Process heartbeat note
 * - 5 min: Health checks (stuck jobs, offline workers, relay health)
 * - 10 min: Process pending embeddings
 * - 1 hr: Clean up stale jobs (>7 days old)
 * - 2 hr: Note linking (semantic similarity + wikilinks)
 * - 12 hr: Topic MOC generation (auto-growing Maps of Content)
 *
 * Usage: bun run scripts/agent-hq-daemon.ts
 */

import { loadMonorepoEnv } from "@repo/env-loader";
// Daemon runs from repo root but many agent-specific vars live in apps/agent/.env.local.
// Load from both locations so MORNING_BRIEF_ENABLED, etc. are picked up.
loadMonorepoEnv();
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
const DAEMON_SCRIPT_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(DAEMON_SCRIPT_DIR, "..");
// Also load agent-specific env (dotenv won't override already-set vars)
import { config as dotenvConfig } from "dotenv";
const agentEnvPath = path.join(REPO_ROOT, "apps/agent/.env.local");
if (fs.existsSync(agentEnvPath)) dotenvConfig({ path: agentEnvPath });
import { spawn } from "child_process";
import { VaultClient, resolveEmbeddingProvider, isEmbeddingProviderAvailable } from "@repo/vault-client";
import { SyncedVaultClient } from "@repo/vault-sync";
import { SearchClient } from "@repo/vault-client/search";
import { calculateCost } from "@repo/vault-client/pricing";
import { createMemorySystem } from "@repo/vault-memory";
import { notify, notifyIfMeaningful } from "./notificationService.js";
import { driftAwareInterval } from "./lib/scheduler.js";
import type { DaemonContext } from "./daemon/context.js";
import { processHeartbeat as _processHeartbeat } from "./daemon/heartbeat.js";
import { refreshNewsPulse as _refreshNewsPulse } from "./daemon/newsPulse.js";
// note-linking + topic-mocs removed — replaced by connection-weaver + daily-synthesis touchpoints
import {
  expireApprovals as _expireApprovals,
  healthCheck as _healthCheck,
  relayHealthCheck as _relayHealthCheck,
  processEmbeddings as _processEmbeddings,
  forgetWeakMemories as _forgetWeakMemories,
  consolidateMemory as _consolidateMemory,
  cleanupStaleJobs as _cleanupStaleJobs,
  cleanupDelegationArtifacts as _cleanupDelegationArtifacts,
} from "./daemon/healthAndCleanup.js";
import {
  planStatusSync as _planStatusSync,
  planKnowledgeExtraction as _planKnowledgeExtraction,
  planArchival as _planArchival,
} from "./daemon/planMaintenance.js";

// ─── Configuration ───────────────────────────────────────────────────

const VAULT_PATH =
  process.env.VAULT_PATH ??
  path.resolve(import.meta.dir, "..", ".vault");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
const embeddingProvider = resolveEmbeddingProvider();
const STALE_JOB_DAYS = 7;
const STUCK_JOB_HOURS = 2;
const OFFLINE_WORKER_SECONDS = 30;
const RELAY_STALE_SECONDS = 60;

const HQ_BROWSER_PORT = parseInt(process.env.HQ_BROWSER_PORT ?? "19200", 10);
const HQ_BROWSER_ENABLED = process.env.HQ_BROWSER_ENABLED === "true"; // opt-in to enable

// ─── Initialization ──────────────────────────────────────────────────

const vault = new SyncedVaultClient(VAULT_PATH);
let search: SearchClient;

try {
  search = new SearchClient(VAULT_PATH);
} catch (err) {
  console.error("[daemon] Failed to initialize search client:", err);
  process.exit(1);
}

console.log(`[daemon] Started. Vault: ${VAULT_PATH}`);
console.log(`[daemon] Press Ctrl+C to stop.`);

// ─── Memory System (Ollama/qwen3.5:9b) ──────────────────────────────
const memorySystem = createMemorySystem(VAULT_PATH);

// ─── Build DaemonContext (shared across all task modules) ────────────
// Forward-declared; `localTimestamp` and `recordTaskRun` are defined below.
// The context is fully initialized after those functions are defined.
let _daemonCtx: DaemonContext | null = null;

function getDaemonCtx(): DaemonContext {
  if (!_daemonCtx) {
    _daemonCtx = {
      vault, search, memorySystem, vaultPath: VAULT_PATH,
      openrouterApiKey: OPENROUTER_API_KEY,
      embeddingModel: EMBEDDING_MODEL,
      embeddingProvider,
      localTimestamp, recordTaskRun, recordDailyActivity,
      notify, notifyIfMeaningful,
    };
  }
  return _daemonCtx;
}

// ─── Task wrappers (delegate to extracted modules with context) ──────
const expireApprovals = () => _expireApprovals(getDaemonCtx());
const processHeartbeat = () => _processHeartbeat(getDaemonCtx());
const healthCheck = () => _healthCheck(getDaemonCtx());
const relayHealthCheck = () => _relayHealthCheck(getDaemonCtx());
const processEmbeddings = () => _processEmbeddings(getDaemonCtx());
const forgetWeakMemories = () => _forgetWeakMemories(getDaemonCtx());
const consolidateMemory = async () => {
  await _consolidateMemory(getDaemonCtx());
  // Process any pending delta extractions from recent queries (pattern separation)
  try {
    const deltaCount = await memorySystem.querier.processPendingDeltas();
    if (deltaCount > 0) console.log(`[daemon] Computed ${deltaCount} memory deltas`);
  } catch (err) {
    console.error("[daemon] Delta processing failed:", err);
  }
};
const cleanupStaleJobs = () => _cleanupStaleJobs(getDaemonCtx());
const cleanupDelegationArtifacts = () => _cleanupDelegationArtifacts(getDaemonCtx());
const refreshNewsPulse = () => _refreshNewsPulse(getDaemonCtx());

// Planning System Wrappers
const planStatusSync = () => _planStatusSync(getDaemonCtx());
const planKnowledgeExtraction = () => _planKnowledgeExtraction(getDaemonCtx());
const planArchival = () => _planArchival(getDaemonCtx());

// ─── Awake Replay Helpers ────────────────────────────────────────────

function extractJobIdFromPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1].split(".")[0];
}

function extractTaskIdFromPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1].split(".")[0];
}

// ─── Startup Validation ─────────────────────────────────────────────

function validatePrerequisites(): void {
  const warnings: string[] = [];

  if (embeddingProvider.type === "ollama") {
    // Ollama needs async check — just note it
    warnings.push(`Embedding provider: Ollama (${embeddingProvider.baseUrl}) — will verify at first use`);
  } else if (embeddingProvider.type === "none") {
    warnings.push("No embedding provider configured — FTS5 keyword search active, vector search disabled. Set GEMINI_API_KEY, OPENROUTER_API_KEY, or OLLAMA_BASE_URL for embeddings.");
  } else {
    console.log(`[daemon] Embedding provider: ${embeddingProvider.type} (model: ${embeddingProvider.model})`);
  }
  const requiredFiles = ["SOUL.md", "MEMORY.md", "PREFERENCES.md", "HEARTBEAT.md"];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(VAULT_PATH, "_system", file))) {
      warnings.push(`Missing system file: _system/${file}`);
    }
  }

  const requiredDirs = [
    "_jobs/pending", "_jobs/running", "_jobs/done", "_jobs/failed",
    "_delegation/pending", "_delegation/claimed", "_delegation/completed",
    "_agent-sessions",
  ];
  for (const dir of requiredDirs) {
    if (!fs.existsSync(path.join(VAULT_PATH, dir))) {
      warnings.push(`Missing directory: ${dir}`);
    }
  }

  if (warnings.length > 0) {
    console.warn("[daemon] Startup warnings:");
    for (const w of warnings) {
      console.warn(`  - ${w}`);
    }
  } else {
    console.log("[daemon] All prerequisites validated.");
  }
}

validatePrerequisites();

// ─── Daemon Status Tracking ─────────────────────────────────────────

/** Return an ISO-like timestamp in local time with UTC offset (e.g. 2026-02-22T20:25:45+03:00) */
function localTimestamp(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
    sign + pad(Math.floor(Math.abs(off) / 60)) + ":" + pad(Math.abs(off) % 60)
  );
}

const STATUS_FILE = path.join(VAULT_PATH, "_system/DAEMON-STATUS.md");
const daemonStartedAt = localTimestamp();

interface TaskRunStatus {
  lastRun: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  runCount: number;
  errorCount: number;
}

const taskRunStatus: Record<string, TaskRunStatus> = {};

function recordTaskRun(taskName: string, success: boolean, error?: string): void {
  const s = taskRunStatus[taskName] ??= {
    lastRun: null, lastSuccess: null, lastError: null, runCount: 0, errorCount: 0,
  };
  s.lastRun = localTimestamp();
  s.runCount++;
  if (success) {
    s.lastSuccess = s.lastRun;
  } else {
    s.lastError = error ?? "unknown error";
    s.errorCount++;
  }
}

/** Write _system/CRON-SCHEDULE.md so all agents always know what's scheduled */
async function writeCronSchedule(): Promise<void> {
  const schedulePath = path.join(VAULT_PATH, "_system/CRON-SCHEDULE.md");

  // ── Daemon tasks ──
  const daemonRows = [
    { interval: "Every 30s", task: "promote-delegation", description: "Move completed delegation tasks to done" },
    { interval: "Every 1min", task: "expire-approvals", description: "Expire human-in-the-loop approvals past deadline" },
    { interval: "Every 5min", task: "heartbeat", description: "Process HEARTBEAT.md for actionable tasks" },
    { interval: "Every 5min", task: "health-check", description: "Detect stuck jobs & offline workers, alert on issues" },
    { interval: "Every 5min", task: "relay-health", description: "Check relay bot connectivity" },
    { interval: "Every 30min", task: "memory-consolidation", description: "Consolidate cross-harness memories via Ollama qwen3.5:9b" },
    { interval: "Every 30min", task: "embeddings", description: "Embed new/modified vault notes into FTS5 + vector index" },
    { interval: "Monthly 1st", task: "budget-reset", description: "Reset currentMonthUsd/todayUsd counters in budget.md" },
    { interval: "Every 1hr", task: "stale-cleanup", description: "Delete jobs >7 days old" },
    { interval: "Every 1hr", task: "delegation-cleanup", description: "Purge stale delegation signals and oversized result files" },
    { interval: "Every 2hr", task: "note-linking", description: "Add semantic Related Notes sections to all embedded notes" },
    { interval: "Every 12hr", task: "topic-mocs", description: "Auto-generate Maps of Content per tag cluster" },
    { interval: "Daily 8pm", task: "daily-brief", description: "Send end-of-day summary to Telegram with all task activity" },
    { interval: "Daily 6am", task: "morning-brief-audio", description: "Generate local audio brief via Kokoro TTS (MORNING_BRIEF_ENABLED=true)" },
    { interval: "Daily 6:30am", task: "morning-brief-notebooklm", description: "Generate NotebookLM deep-dive audio brief (MORNING_BRIEF_ENABLED=true)" },
    { interval: "Daily 8am + Mon 9am", task: "model-intelligence", description: "AI model catalog diff (daily) + deep analysis with news (weekly Mondays)" },
  ];

  // ── Claude Code scheduled tasks — load from SKILL.md files ──
  const claudeTasksDir = path.join(os.homedir(), ".claude/scheduled-tasks");
  const claudeRows: { schedule: string; task: string; model: string; description: string; status: string }[] = [];
  if (fs.existsSync(claudeTasksDir)) {
    for (const entry of fs.readdirSync(claudeTasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const skillPath = path.join(claudeTasksDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const raw = fs.readFileSync(skillPath, "utf-8");
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm: Record<string, string> = {};
      for (const line of fmMatch[1].split("\n")) {
        const [key, ...rest] = line.split(":");
        if (key && rest.length) fm[key.trim()] = rest.join(":").trim().replace(/^"|"$/g, "");
      }
      claudeRows.push({
        task: fm.name ?? entry.name,
        schedule: fm.schedule ?? "?",
        model: fm.model ?? "?",
        description: fm.description ?? "",
        status: "✅ loaded",
      });
    }
  }

  const now = localTimestamp();
  const lines: string[] = [
    `---`,
    `noteType: system-file`,
    `fileName: cron-schedule`,
    `lastUpdated: "${now}"`,
    `---`,
    `# Cron Schedule`,
    ``,
    `_Auto-generated by daemon on startup. All agents can reference this._`,
    `_Last updated: ${now}_`,
    ``,
    `## Daemon Tasks (TypeScript logic, always running)`,
    ``,
    `| Interval | Task | What it does |`,
    `|---|---|---|`,
    ...daemonRows.map(r => `| ${r.interval} | \`${r.task}\` | ${r.description} |`),
    ``,
    `## Claude Code Scheduled Tasks (AI reasoning, via \`~/.claude/scheduled-tasks/\`)`,
    ``,
    claudeRows.length === 0 ? `_No tasks found in ${claudeTasksDir}_` : `_${claudeRows.length} task(s) registered and running via daemon_`,
    ``,
    `| Schedule | Task | Model | Status | What it does |`,
    `|---|---|---|---|---|`,
    ...(claudeRows.length > 0 ? claudeRows.map(r => `| \`${r.schedule}\` | \`${r.task}\` | ${r.model} | ${r.status} | ${r.description} |`) : [`| — | — | — | ❌ none loaded | —`]),
    ``,
    `## Notification Channels`,
    ``,
    `- **Primary**: Telegram (Calvin's preferred channel)`,
    `- **Fallback**: Discord webhook`,
    `- **Daily brief**: 8 PM EAT — full summary of all task activity`,
    `- **Instant alerts**: Stuck jobs, broken links (if >0), soul drift, memory insights`,
    ``,
    `## How to query`,
    ``,
    `Ask any agent: _"What crons are scheduled?", "When does the daily brief fire?",`,
    `"What did vault-stale-jobs do today?", "Is note-linking running?"_`,
  ];

  fs.writeFileSync(schedulePath, lines.join("\n") + "\n", "utf-8");
  console.log("[daemon] CRON-SCHEDULE.md written to _system/");
}

async function writeDaemonStatus(): Promise<void> {
  try {
    const matter = await import("gray-matter").then((m) => m.default);
    const frontmatter: Record<string, unknown> = {
      noteType: "system-file",
      fileName: "daemon-status",
      daemonStartedAt,
      lastUpdated: localTimestamp(),
      pid: process.pid,
      apiKeys: {
        openrouter: !!OPENROUTER_API_KEY,
        gemini: !!process.env.GEMINI_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
      },
      embeddingProvider: embeddingProvider.type,
    };

    const lines: string[] = ["# Daemon Status", ""];
    lines.push(`**Started:** ${daemonStartedAt}`);
    lines.push(`**PID:** ${process.pid}`);
    lines.push(`**Vault:** ${VAULT_PATH}`);
    lines.push(`**Embedding Provider:** ${embeddingProvider.type} (model: ${embeddingProvider.model || "n/a"})`);
    lines.push(`**API Keys:** OpenRouter=${OPENROUTER_API_KEY ? "set" : "not set"}, Gemini=${process.env.GEMINI_API_KEY ? "set" : "not set"}, Anthropic=${process.env.ANTHROPIC_API_KEY ? "set" : "not set"}`);
    lines.push("");
    lines.push("## Task Status");
    lines.push("");
    lines.push("| Task | Last Run | Last Success | Runs | Errors | Last Error |");
    lines.push("|------|----------|--------------|------|--------|------------|");

    // We reference the tasks array defined later — this is fine since writeDaemonStatus
    // is only called after tasks is initialized in the scheduler
    for (const taskName of Object.keys(taskRunStatus)) {
      const s = taskRunStatus[taskName];
      const lastRun = s.lastRun ?? "never";
      const lastSuccess = s.lastSuccess ?? "never";
      const lastError = s.lastError ? s.lastError.substring(0, 50) : "-";
      lines.push(`| ${taskName} | ${lastRun} | ${lastSuccess} | ${s.runCount} | ${s.errorCount} | ${lastError} |`);
    }

    // ── Claude Code scheduled task status (from log file) ──
    lines.push("");
    lines.push("## Claude Code Scheduled Tasks");
    lines.push("");
    const scheduledLogPath = path.join(VAULT_PATH, "_logs/scheduled-tasks.log");
    const claudeTasksDir2 = path.join(os.homedir(), ".claude/scheduled-tasks");
    const claudeTaskNames: string[] = [];
    if (fs.existsSync(claudeTasksDir2)) {
      for (const entry of fs.readdirSync(claudeTasksDir2, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith("_")) claudeTaskNames.push(entry.name);
      }
    }
    if (claudeTaskNames.length === 0) {
      lines.push("_No Claude Code scheduled tasks found in ~/.claude/scheduled-tasks/_");
    } else {
      // Read last run for each task from the log
      const lastRunMap: Record<string, string> = {};
      if (fs.existsSync(scheduledLogPath)) {
        for (const line of fs.readFileSync(scheduledLogPath, "utf-8").split("\n").filter(Boolean)) {
          const m = line.match(/^\[(.+?)\]\s+([\w-]+):\s+(.+)$/);
          if (m) lastRunMap[m[2]] = `${m[1]} — ${m[3]}`;
        }
      }
      lines.push("| Task | Last Run |");
      lines.push("|---|---|");
      for (const name of claudeTaskNames) {
        lines.push(`| \`${name}\` | ${lastRunMap[name] ?? "never"} |`);
      }
    }

    fs.writeFileSync(STATUS_FILE, matter.stringify(lines.join("\n"), frontmatter), "utf-8");
  } catch (err) {
    console.error("[daemon] Failed to write status file:", err);
  }
}

// ─── Tasks ──────────────────────────────────────────────────────────
// Task implementations extracted to scripts/daemon/ modules.
// Wrapper functions defined above (after getDaemonCtx) delegate to them.

// ─── Task: Daily End-of-Day Brief (every 24hr, fires at ~8pm EAT) ────

const DAILY_BRIEF_HOUR_EAT = 20; // 8 PM East Africa Time (UTC+3)
const SBLU_RETRAIN_HOUR_EAT = 3;  // 3 AM East Africa Time — machine idle, no active users

/** Track which activities happened since last brief (reset after send) */
const dailyActivityLog: { time: string; task: string; detail: string }[] = [];

/** Called by other tasks to record a meaningful activity for the daily brief */
export function recordDailyActivity(task: string, detail: string): void {
  dailyActivityLog.push({ time: localTimestamp(), task, detail });
}

async function sendDailyBrief(): Promise<void> {
  // Build from two sources: taskRunStatus (daemon tasks) + scheduled-tasks.log (Claude Code tasks)
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  // ── Section 1: Daemon task runs today ──
  const daemonLines: string[] = [];
  for (const [name, s] of Object.entries(taskRunStatus)) {
    // Skip noisy low-value tasks in the brief
    const skip = ["expire-approvals", "promote-delegation"].includes(name);
    if (skip) continue;
    if (s.runCount === 0) continue;
    const status = s.errorCount > 0 ? `⚠️ ${s.errorCount} error(s)` : "✅";
    daemonLines.push(`  ${status} <b>${name}</b> — ran ${s.runCount}x, last: ${s.lastSuccess ?? "never succeeded"}`);
  }

  // ── Section 2: Claude Code scheduled tasks (from log file) ──
  const scheduledLogPath = path.join(VAULT_PATH, "_logs/scheduled-tasks.log");
  const claudeLines: string[] = [];
  if (fs.existsSync(scheduledLogPath)) {
    const logContent = fs.readFileSync(scheduledLogPath, "utf-8");
    const lines = logContent.split("\n").filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^\[(.+?)\]\s+([\w-]+):\s+(.+)$/);
      if (!match) continue;
      const [, ts, task, detail] = match;
      const entryDate = new Date(ts);
      if (entryDate >= todayStart) {
        claudeLines.push(`  ✅ <b>${task}</b> — ${detail}`);
      }
    }
  }

  // ── Section 3: Vault-written output files (check mtime) ──
  const outputFiles: { label: string; file: string }[] = [
    { label: "Project Pulse", file: "_system/PROJECT-PULSE.md" },
    { label: "Memory Digest", file: "_system/MEMORY.md" },
    { label: "Link Health", file: "_system/LINK-HEALTH.md" },
    { label: "Orphan Notes", file: "_system/ORPHAN-NOTES.md" },
    { label: "Soul Health", file: "_system/SOUL-HEALTH.md" },
    { label: "Heartbeat", file: "_system/HEARTBEAT.md" },
  ];
  const writtenToday: string[] = [];
  for (const { label, file } of outputFiles) {
    const fullPath = path.join(VAULT_PATH, file);
    if (fs.existsSync(fullPath)) {
      const mtime = fs.statSync(fullPath).mtime;
      if (mtime >= todayStart) {
        writtenToday.push(`  📄 <b>${label}</b> updated — ask me to summarise it`);
      }
    }
  }

  // ── Build the brief ──
  if (daemonLines.length === 0 && claudeLines.length === 0 && writtenToday.length === 0) {
    // Nothing meaningful happened — skip (don't spam with empty briefs)
    console.log("[daily-brief] Nothing meaningful to report, skipping notification");
    return;
  }

  const dateStr = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const parts: string[] = [`📋 <b>Daily Agent Brief — ${dateStr}</b>\n`];

  if (daemonLines.length > 0) {
    parts.push(`<b>Daemon Tasks</b>:\n${daemonLines.join("\n")}`);
  }
  if (claudeLines.length > 0) {
    parts.push(`<b>Scheduled Micro-Tasks</b>:\n${claudeLines.join("\n")}`);
  }
  if (writtenToday.length > 0) {
    parts.push(`<b>Vault Reports Ready</b>:\n${writtenToday.join("\n")}`);
  }

  // Error summary
  const errorTasks = Object.entries(taskRunStatus).filter(([, s]) => s.errorCount > 0);
  if (errorTasks.length > 0) {
    const errLines = errorTasks.map(([name, s]) => `  ❌ <b>${name}</b>: ${s.lastError?.slice(0, 80)}`);
    parts.push(`<b>Issues to Review</b>:\n${errLines.join("\n")}`);
  }

  parts.push(`\n<i>Reply with any task name above to get details.</i>`);

  const message = parts.join("\n\n");

  // Write brief to vault as a note too
  const briefPath = path.join(VAULT_PATH, `_logs/daily-briefs/${now.toISOString().slice(0, 10)}.md`);
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, `# Daily Brief — ${dateStr}\n\n${message.replace(/<[^>]+>/g, "")}\n`, "utf-8");

  await notify(message, `daily-brief:${now.toISOString().slice(0, 10)}`);
  console.log("[daily-brief] Sent end-of-day brief");

  // Reset run counts for next day's brief (keep error state for review)
  for (const s of Object.values(taskRunStatus)) {
    s.runCount = 0;
  }
}

async function promoteDelegationReady(): Promise<void> {
  try {
    // Find all completed task IDs from fbmq's flat done/ directory
    const completedIds = new Set<string>();
    const completedDir = path.join(VAULT_PATH, "_fbmq/delegation/done");
    if (fs.existsSync(completedDir)) {
      const files = fs.readdirSync(completedDir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(completedDir, file), "utf-8");
          // taskId is in the Custom: continuation block, e.g. "  taskId: research-1"
          const match = raw.match(/^\s+taskId:\s*(.+)$/m);
          if (match) completedIds.add(match[1].trim());
        } catch { }
      }
    }

    // Also check legacy _delegation/completed/ for tasks completed before migration
    const legacyDir = path.join(VAULT_PATH, "_delegation/completed");
    if (fs.existsSync(legacyDir)) {
      const files = fs.readdirSync(legacyDir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(legacyDir, file), "utf-8");
          const match = raw.match(/taskId:\s*["']?([^"'\n]+)/);
          if (match) completedIds.add(match[1].trim());
        } catch { }
      }
    }

    if (completedIds.size > 0) {
      await vault.delegationQueue.promoteReady(completedIds);
    }
  } catch (err) {
    console.error("[promote] Error promoting delegated tasks:", err);
  }
}

// ─── Claude Code Scheduled Tasks ─────────────────────────────────────

const CLAUDE_SCHEDULED_TASKS_DIR = path.join(os.homedir(), ".claude/scheduled-tasks");

interface ClaudeScheduledTask {
  name: string;
  description: string;
  schedule: string; // cron expression
  model: string;
  prompt: string;
  lastFiredMinute: number; // epoch minutes, to prevent double-fire
}

/** Parse a SKILL.md file into a ClaudeScheduledTask */
function parseClaudeSkill(skillPath: string): ClaudeScheduledTask | null {
  try {
    const raw = fs.readFileSync(skillPath, "utf-8");
    // Extract YAML frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return null;
    const fm: Record<string, string> = {};
    for (const line of fmMatch[1].split("\n")) {
      const [key, ...rest] = line.split(":");
      if (key && rest.length) fm[key.trim()] = rest.join(":").trim().replace(/^"|"$/g, "");
    }
    if (!fm.name || !fm.schedule || !fm.model) return null;
    return {
      name: fm.name,
      description: fm.description ?? "",
      schedule: fm.schedule,
      model: fm.model,
      prompt: fmMatch[2].trim(),
      lastFiredMinute: 0,
    };
  } catch {
    return null;
  }
}

/** Match a 5-field cron expression against a Date (min hour dom month dow) */
function matchesCron(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hourF, domF, monthF, dowF] = fields;
  const val = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  return fields.every((f, i) => {
    if (f === "*") return true;
    if (f.startsWith("*/")) return val[i] % parseInt(f.slice(2)) === 0;
    return parseInt(f) === val[i];
  });
}

/** Load all SKILL.md tasks from ~/.claude/scheduled-tasks/ */
function loadClaudeScheduledTasks(): ClaudeScheduledTask[] {
  if (!fs.existsSync(CLAUDE_SCHEDULED_TASKS_DIR)) return [];
  const tasks: ClaudeScheduledTask[] = [];
  for (const entry of fs.readdirSync(CLAUDE_SCHEDULED_TASKS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const skillPath = path.join(CLAUDE_SCHEDULED_TASKS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const task = parseClaudeSkill(skillPath);
    if (task) {
      tasks.push(task);
      console.log(`[claude-cron] Loaded: ${task.name} (${task.schedule})`);
    }
  }
  return tasks;
}

/** Tracks tasks currently executing — prevents concurrent duplicate runs */
const claudeRunning = new Set<string>();

/** Run a Claude Code scheduled task via `claude -p` non-interactively.
 *  Lock-file + in-memory Set guarantee no two instances of the same task run at once. */
async function runClaudeScheduledTask(task: ClaudeScheduledTask): Promise<void> {
  // ── In-memory guard (same process) ──
  if (claudeRunning.has(task.name)) {
    console.log(`[claude-cron] ${task.name} already running — skipping`);
    return;
  }

  // ── Lock file guard (survives daemon restart mid-run) ──
  const lockDir = path.join(VAULT_PATH, "_logs/.claude-cron-locks");
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, `${task.name}.lock`);

  if (fs.existsSync(lockFile)) {
    const lockContent = fs.readFileSync(lockFile, "utf-8").trim();
    const [pidStr, startedStr] = lockContent.split("\n");
    const lockedPid = parseInt(pidStr);
    const lockedAt = parseInt(startedStr);
    const ageMs = Date.now() - lockedAt;
    // Stale lock: older than 20 minutes or PID no longer exists
    const pidAlive = !isNaN(lockedPid) && (() => {
      try { process.kill(lockedPid, 0); return true; } catch { return false; }
    })();
    if (pidAlive && ageMs < 20 * 60 * 1000) {
      console.log(`[claude-cron] ${task.name} locked by PID ${lockedPid} (${Math.floor(ageMs / 1000)}s ago) — skipping`);
      return;
    }
    // Stale lock — remove it
    fs.unlinkSync(lockFile);
    console.warn(`[claude-cron] ${task.name} stale lock removed (was PID ${lockedPid})`);
  }

  // Acquire
  fs.writeFileSync(lockFile, `${process.pid}\n${Date.now()}`, "utf-8");
  claudeRunning.add(task.name);

  const logPath = path.join(VAULT_PATH, "_logs/scheduled-tasks.log");
  if (!fs.existsSync(path.dirname(logPath))) fs.mkdirSync(path.dirname(logPath), { recursive: true });

  console.log(`[claude-cron] Running: ${task.name}`);
  return new Promise((resolve) => {
    const proc = spawn(
      "claude",
      ["-p", task.prompt, "--model", task.model, "--dangerously-skip-permissions", "--no-session-persistence"],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } }
    );

    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timeoutHandle = setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
        console.warn(`[claude-cron] ${task.name} timed out after 15min — killed`);
      }
    }, 15 * 60 * 1000);

    proc.on("close", (code) => {
      clearTimeout(timeoutHandle);
      // Release
      claudeRunning.delete(task.name);
      try { fs.unlinkSync(lockFile); } catch { /* already gone */ }

      const ts = new Date().toISOString();
      const status = code === 0 ? "ok" : `exit ${code}`;
      fs.appendFileSync(logPath, `[${ts}] ${task.name}: completed (${status})\n`, "utf-8");
      if (code !== 0) {
        console.error(`[claude-cron] ${task.name} failed (exit ${code}):\n${stderr.slice(0, 500)}`);
      } else {
        console.log(`[claude-cron] ${task.name} done`);
      }
      resolve();
    });
  });
}

// ─── Scheduler ───────────────────────────────────────────────────────

const tasks: {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
  lastRun: number;
}[] = [
    {
      name: "promote-delegation",
      intervalMs: 30 * 1000,
      fn: promoteDelegationReady,
      lastRun: 0,
    },
    {
      name: "expire-approvals",
      intervalMs: 60 * 1000,
      fn: expireApprovals,
      lastRun: 0,
    },
    {
      name: "heartbeat",
      intervalMs: 5 * 60 * 1000, // Lengthened from 2min; events handle fast path
      fn: processHeartbeat,
      lastRun: 0,
    },
    {
      name: "health-check",
      intervalMs: 5 * 60 * 1000,
      fn: healthCheck,
      lastRun: 0,
    },
    {
      name: "relay-health",
      intervalMs: 5 * 60 * 1000,
      fn: relayHealthCheck,
      lastRun: 0,
    },
    {
      name: "news-pulse",
      intervalMs: 15 * 60 * 1000, // every 15 minutes
      fn: refreshNewsPulse,
      lastRun: 0,
    },
    {
      name: "memory-consolidation",
      intervalMs: 30 * 60 * 1000,
      fn: consolidateMemory,
      lastRun: 0,
    },
    {
      name: "memory-forgetting",
      intervalMs: 24 * 60 * 60 * 1000, // every 24 hours
      fn: forgetWeakMemories,
      lastRun: 0,
    },
    {
      name: "embeddings",
      intervalMs: 30 * 60 * 1000, // Lengthened from 10min; events handle fast path
      fn: processEmbeddings,
      lastRun: 0,
    },
    {
      name: "budget-reset",
      intervalMs: 60 * 60 * 1000, // checked every hour; only fires on 1st of month
      fn: async () => {
        const now = new Date();
        if (now.getDate() !== 1 || now.getHours() !== 0) return;

        // Avoid re-running if already reset this month
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const flagPath = path.join(VAULT_PATH, "_embeddings", `.budget-reset-${monthKey}`);
        if (fs.existsSync(flagPath)) return;

        const budgetPath = path.join(VAULT_PATH, "_usage", "budget.md");
        if (!fs.existsSync(budgetPath)) return;

        try {
          const raw = fs.readFileSync(budgetPath, "utf-8");
          const { default: matter } = await import("gray-matter");
          const parsed = matter(raw);
          parsed.data.currentMonthUsd = 0;
          parsed.data.todayUsd = 0;
          parsed.data.lastChecked = now.toISOString();
          fs.writeFileSync(budgetPath, matter.stringify(parsed.content, parsed.data), "utf-8");
          fs.writeFileSync(flagPath, now.toISOString());
          console.log(`[budget-reset] Monthly budget counters reset for ${monthKey}`);
        } catch (err) {
          console.error("[budget-reset] Failed:", err);
        }
      },
      lastRun: 0,
    },
    {
      name: "stale-cleanup",
      intervalMs: 60 * 60 * 1000,
      fn: cleanupStaleJobs,
      lastRun: 0,
    },
    {
      name: "delegation-cleanup",
      intervalMs: 60 * 60 * 1000,
      fn: cleanupDelegationArtifacts,
      lastRun: 0,
    },
    // note-linking + topic-mocs removed — replaced by touchpoints
    {
      name: "daily-brief",
      intervalMs: 60 * 60 * 1000, // checked every hour
      fn: async () => {
        // Only fire during the target hour (8 PM EAT = 17:00 UTC)
        const nowHour = new Date().getHours();
        if (nowHour === DAILY_BRIEF_HOUR_EAT) {
          await sendDailyBrief();
        }
      },
      lastRun: 0,
    },
    {
      name: "morning-brief-audio",
      intervalMs: 60 * 60 * 1000, // checked every hour
      fn: async () => {
        // Only enabled when MORNING_BRIEF_ENABLED=true
        if (process.env.MORNING_BRIEF_ENABLED !== "true") return;

        // Fire at 6 AM EAT
        const nowHour = new Date().getHours();
        if (nowHour !== 6) return;

        // Flag file prevents re-running if daemon restarts mid-morning
        const todayKey = new Date().toISOString().slice(0, 10);
        const flagPath = path.join(VAULT_PATH, "_embeddings", `.morning-brief-${todayKey}`);
        if (fs.existsSync(flagPath)) return;

        console.log("[morning-brief] 6 AM — generating daily audio brief...");
        fs.writeFileSync(flagPath, new Date().toISOString());

        const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), "morning-brief-audio.ts");
        const result = Bun.spawnSync(
          ["bun", "run", scriptPath],
          {
            env: { ...process.env, MORNING_BRIEF_ENABLED: "true" },
            stdout: "inherit",
            stderr: "inherit",
          }
        );

        if (result.exitCode === 0) {
          console.log("[morning-brief] Audio brief generated successfully");
          logActivity("morning-brief-audio", "Daily audio brief generated");
        } else {
          console.warn(`[morning-brief] Script exited with code ${result.exitCode}`);
          // Remove flag so it can retry next hour if it failed
          fs.rmSync(flagPath, { force: true });
        }
      },
      lastRun: 0,
    },
    {
      name: "morning-brief-notebooklm",
      intervalMs: 60 * 60 * 1000, // checked every hour
      fn: async () => {
        if (process.env.MORNING_BRIEF_ENABLED !== "true") return;

        // Fire at 6:30 AM EAT — 30 min after the local Kokoro brief
        const now = new Date();
        if (now.getHours() !== 6 || now.getMinutes() < 25) return;

        const todayKey = now.toISOString().slice(0, 10);
        const flagPath = path.join(VAULT_PATH, "_embeddings", `.morning-brief-nlm-${todayKey}`);
        if (fs.existsSync(flagPath)) return;

        console.log("[morning-brief-nlm] 6:30 AM — generating NotebookLM deep-dive...");
        fs.writeFileSync(flagPath, new Date().toISOString());

        const scriptPath = path.join(DAEMON_SCRIPT_DIR, "morning-brief-notebooklm.ts");
        const result = Bun.spawnSync(
          ["bun", "run", scriptPath],
          {
            env: { ...process.env, MORNING_BRIEF_ENABLED: "true" },
            stdout: "inherit",
            stderr: "inherit",
            timeout: 20 * 60 * 1000, // 20 min timeout (NLM generation is slow)
          }
        );

        if (result.exitCode === 0) {
          console.log("[morning-brief-nlm] NotebookLM brief generated successfully");
          logActivity("morning-brief-notebooklm", "NotebookLM deep-dive brief generated");
        } else {
          console.warn(`[morning-brief-nlm] Script exited with code ${result.exitCode}`);
          fs.rmSync(flagPath, { force: true });
        }
      },
      lastRun: 0,
    },
    {
      name: "model-intelligence",
      intervalMs: 60 * 60 * 1000, // checked every hour
      fn: async () => {
        const nowHour = new Date().getHours();
        const dayOfWeek = new Date().getDay(); // 0 = Sunday, 1 = Monday

        // Daily quick check at 8 AM EAT, weekly deep dive Monday 9 AM EAT
        const isDailyTime = nowHour === 8;
        const isWeeklyTime = dayOfWeek === 1 && nowHour === 9;
        if (!isDailyTime && !isWeeklyTime) return;

        const todayKey = new Date().toISOString().slice(0, 10);
        const runMode = isWeeklyTime ? "weekly" : "daily";
        const flagPath = path.join(VAULT_PATH, "_embeddings", `.model-intel-${runMode}-${todayKey}`);
        if (fs.existsSync(flagPath)) return;

        console.log(`[model-intelligence] ${runMode} model tracking...`);

        const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), "workflows/model-tracker.ts");
        const result = Bun.spawnSync(
          ["bun", "run", scriptPath, `--mode=${runMode}`],
          {
            env: { ...process.env },
            stdout: "inherit",
            stderr: "inherit",
          }
        );

        if (result.exitCode === 0) {
          fs.writeFileSync(flagPath, new Date().toISOString());
          logActivity("model-intelligence", `${runMode} model intelligence updated`);
          console.log(`[model-intelligence] ${runMode} run complete`);
        } else {
          console.warn(`[model-intelligence] Script exited with code ${result.exitCode}`);
        }
      },
      lastRun: 0,
    },
    {
      name: "sblu-retraining",
      intervalMs: 60 * 60 * 1000, // checked every hour
      fn: async () => {
        // Only fire at 3 AM EAT — machine is idle, no active users, no training interference
        const nowHour = new Date().getHours();
        if (nowHour !== SBLU_RETRAIN_HOUR_EAT) return;

        // Avoid re-running if already ran today
        const todayKey = new Date().toISOString().slice(0, 10);
        const flagPath = path.join(VAULT_PATH, "_embeddings", `.sblu-retrain-${todayKey}`);
        if (fs.existsSync(flagPath)) return;

        console.log("[sblu-retraining] 3 AM slot — checking SBLU retraining eligibility...");

        // Spawn retrain.ts as a subprocess — non-blocking, logs to daemon stdout
        const proc = Bun.spawn(
          ["bun", "scripts/sblu/retrain.ts", "--vault", VAULT_PATH],
          {
            cwd: path.resolve(VAULT_PATH, ".."),
            stdout: "inherit",
            stderr: "inherit",
            env: { ...process.env, VAULT_PATH },
          },
        );

        const exitCode = await proc.exited;
        if (exitCode === 0) {
          // Mark as done for today
          fs.writeFileSync(flagPath, new Date().toISOString());
          console.log("[sblu-retraining] Retraining cycle complete");
        } else {
          console.warn(`[sblu-retraining] Retrain script exited with code ${exitCode}`);
        }
      },
      lastRun: 0,
    },
    // ─── HQ Browser health-check (every 5 min) ──────────────────────────
    {
      name: "browser-health",
      intervalMs: 5 * 60 * 1000,
      fn: checkHQBrowserHealth,
      lastRun: 0,
    },
    // ─── Team Optimizer (every 7 days) ──────────────────────────────────
    {
      name: "team-optimizer",
      intervalMs: 7 * 24 * 60 * 60 * 1000, // weekly
      fn: async () => {
        try {
          // Lazy import to avoid loading hq-tools at startup
          const { scheduledOptimizationCycle } = await import("../packages/hq-tools/src/teamOptimizer.js");
          const { initPerformanceTracker } = await import("../packages/hq-tools/src/performanceTracker.js");
          const teamsDir = path.resolve(import.meta.dir, "../packages/hq-tools/teams");
          initPerformanceTracker(VAULT_PATH);
          await scheduledOptimizationCycle(teamsDir);
          console.log("[team-optimizer] Weekly optimization cycle complete — pending-optimizations written if data available");
        } catch (err) {
          console.warn("[team-optimizer] Skipped (hq-tools not built or insufficient data):", err instanceof Error ? err.message : err);
        }
      },
      lastRun: 0,
    },
    // ─── Planning System Maintenance ────────────────────────────────────
    {
      name: "plan-sync",
      intervalMs: 1 * 60 * 1000, // every minute
      fn: planStatusSync,
      lastRun: 0,
    },
    {
      name: "plan-extraction",
      intervalMs: 10 * 60 * 1000, // every 10 min
      fn: planKnowledgeExtraction,
      lastRun: 0,
    },
    {
      name: "plan-archival",
      intervalMs: 60 * 60 * 1000, // every hour
      fn: planArchival,
      lastRun: 0,
    },
  ];


async function runScheduler(): Promise<void> {
  // ── HQ Browser server (start on daemon startup) ─────────────────────
  await startHQBrowser();

  // ── Vault Workers (opt-in via VAULT_WORKERS_ENABLED=true) ──────────
  const VAULT_WORKERS_ENABLED = process.env.VAULT_WORKERS_ENABLED === "true";
  let workerRunner: import("./vault-workers/index.js").WorkerRunner | null = null;

  if (VAULT_WORKERS_ENABLED) {
    console.log("[daemon] Vault workers enabled — loading worker registry...");
    const { getWorkers, createWorkerRunner } = await import("./vault-workers/index.js");
    workerRunner = createWorkerRunner(vault, search);
    for (const worker of getWorkers()) {
      tasks.push({
        name: `worker:${worker.name}`,
        intervalMs: worker.intervalMs,
        fn: () => workerRunner!.run(worker),
        lastRun: 0,
      });
    }
    console.log(`[daemon] Registered ${getWorkers().length} vault workers`);
  } else {
    console.log("[daemon] Vault workers disabled (set VAULT_WORKERS_ENABLED=true to enable)");
  }

  // Start the vault sync engine (file watching + change detection)
  try {
    await vault.startSync();
    console.log("[daemon] Vault sync engine started (event-driven mode)");

    // Event-driven: process embeddings immediately when notes are created or modified
    vault.on("note:created", async (event) => {
      try {
        await processEmbeddings();
        recordTaskRun("embeddings", true);
      } catch (err) {
        recordTaskRun("embeddings", false, String(err));
      }
    });

    vault.on("note:modified", async (event) => {
      // Only re-embed if the note is in Notebooks/
      if (event.path.startsWith("Notebooks/")) {
        try {
          await processEmbeddings();
          recordTaskRun("embeddings", true);
        } catch (err) {
          recordTaskRun("embeddings", false, String(err));
        }
      }
    });

    // Event-driven: process heartbeat immediately when system files change
    vault.on("system:modified", async (event) => {
      if (event.path.includes("HEARTBEAT.md")) {
        try {
          await processHeartbeat();
          recordTaskRun("heartbeat", true);
        } catch (err) {
          recordTaskRun("heartbeat", false, String(err));
        }
      }

      // Proactive notifications when Claude Code scheduled tasks write their outputs
      if (event.path.includes("PROJECT-PULSE.md")) {
        await notify(
          `📊 <b>Daily Project Pulse</b> is ready — ask me:\n<i>"Summarise my project pulse for today"</i>`,
          `project-pulse:${new Date().toDateString()}`
        );
      }
      if (event.path.includes("ORPHAN-NOTES.md")) {
        await notify(
          `🗂 <b>Orphan Notes Report</b> updated — some notes in your vault may need linking.\nAsk me: <i>"Show my orphan notes"</i>`,
          `orphan-notes:${new Date().toDateString()}`
        );
      }
      if (event.path.includes("SOUL-HEALTH.md")) {
        await notify(
          `🔍 <b>Weekly Soul Check</b> complete — identity alignment report is ready.\nAsk me: <i>"How is the agent's soul health?"</i>`,
          `soul-health:${new Date().toDateString()}`
        );
      }
      if (event.path.includes("LINK-HEALTH.md")) {
        const content = fs.existsSync(path.join(VAULT_PATH, event.path))
          ? fs.readFileSync(path.join(VAULT_PATH, event.path), "utf-8")
          : "";
        const match = content.match(/brokenCount:\s*(\d+)/);
        const broken = match ? parseInt(match[1]) : 0;
        await notifyIfMeaningful(
          "vault-dead-links",
          `${broken} broken link(s) found`,
          broken > 0,
          (s) => `🔗 <b>Link Health</b>: ${s} in your vault. Ask me: <i>"Show broken links"</i>`
        );
      }
    });

    vault.on("approval:created", async () => {
      try {
        await expireApprovals();
        recordTaskRun("expire-approvals", true);
      } catch (err) {
        recordTaskRun("expire-approvals", false, String(err));
      }
    });

    // ─── Awake Replay: Reverse replay on job completion ───
    vault.on("job:status-changed", async (event) => {
      if (event.path.includes("_jobs/done/")) {
        try {
          const jobId = extractJobIdFromPath(event.path);
          const result = await memorySystem.awakeReplay.reverseReplay({
            triggerRef: jobId,
            triggerSource: "job:status-changed",
          });
          if (result.replayedCount > 0) {
            console.log(`[awake-replay] Reverse: ${result.replayedCount} memories replayed, credit +${result.creditDelta.toFixed(3)}`);
          }
        } catch (err) {
          console.error("[awake-replay] Job reverse replay failed:", err);
        }
      }
    });

    // ─── Awake Replay: Forward replay on job creation ───
    vault.on("job:created", async (event) => {
      try {
        const fullPath = path.join(VAULT_PATH, event.path);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, "utf-8");
          const jobId = extractJobIdFromPath(event.path);
          const fwdResult = await memorySystem.awakeReplay.forwardReplay({
            triggerRef: jobId,
            triggerSource: "job:created",
            instructionText: content,
          });
          if (fwdResult.replayedCount > 0) {
            console.log(`[awake-replay] Forward: ${fwdResult.replayedCount} precedents found for ${jobId}`);
          }
        }
      } catch (err) {
        console.error("[awake-replay] Job forward replay failed:", err);
      }
    });

    // ─── Awake Replay: Reverse replay on delegation completion ───
    vault.on("task:completed", async (event) => {
      try {
        const taskId = extractTaskIdFromPath(event.path);
        const taskResult = await memorySystem.awakeReplay.reverseReplay({
          triggerRef: taskId,
          triggerSource: "task:completed",
        });
        if (taskResult.replayedCount > 0) {
          console.log(`[awake-replay] Task reverse: ${taskResult.replayedCount} memories replayed, credit +${taskResult.creditDelta.toFixed(3)}`);
        }
      } catch (err) {
        console.error("[awake-replay] Task reverse replay failed:", err);
      }
    });

    console.log("[daemon] Event subscriptions registered (embeddings, heartbeat, approvals)");

    // ─── Touch Points (event-driven intelligent vault reactions) ─────────────
    try {
      const { createTouchPointEngine } = await import("./touchpoints/engine.js");
      const { ChannelRouter } = await import("./touchpoints/channelRouter.js");
      const { frontmatterFixer } = await import("./touchpoints/points/frontmatterFixer.js");
      const { sizeWatchdog } = await import("./touchpoints/points/sizeWatchdog.js");
      const { tagSuggester } = await import("./touchpoints/points/tagSuggester.js");
      const { folderOrganizer } = await import("./touchpoints/points/folderOrganizer.js");
      const { conversationLearner } = await import("./touchpoints/points/conversationLearner.js");
      const { staleThreadDetector } = await import("./touchpoints/points/staleThreadDetector.js");
      const { newsClusterer } = await import("./touchpoints/points/newsClusterer.js");
      const { newsLinker } = await import("./touchpoints/points/newsLinker.js");
      const { connectionWeaver } = await import("./touchpoints/points/connectionWeaver.js");
      const { dailySynthesis } = await import("./touchpoints/points/dailySynthesis.js");
      const { vaultHealth } = await import("./touchpoints/points/vaultHealth.js");

      const channelRouter = new ChannelRouter(VAULT_PATH);

      const tpEngine = createTouchPointEngine({
        vault,
        search,
        memoryIngester: memorySystem.ingester,
        vaultPath: VAULT_PATH,
        llm: async (prompt: string, systemPrompt?: string) => {
          // Reuse vault-workers LLM cascade (Ollama → Gemini Flash Lite → Flash)
          const { WorkerRunner } = await import("./vault-workers/index.js");
          // llmCall is not exported from vault-workers, build it inline via Ollama
          const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
          const OLLAMA_MODEL = process.env.VAULT_WORKER_MODEL ?? "qwen3.5:9b";
          const body = {
            model: OLLAMA_MODEL,
            messages: [
              ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
              { role: "user", content: prompt.slice(0, 8000) },
            ],
            max_tokens: 1024,
            stream: false,
          };
          const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(90_000),
          });
          if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
          const data = await res.json() as { choices: Array<{ message: { content: string } }> };
          const content = data.choices[0]?.message?.content;
          if (!content) throw new Error("Ollama returned no content");
          return content;
        },
        notify: channelRouter,
      });

      tpEngine
        .register(frontmatterFixer)
        .register(sizeWatchdog)
        .register(tagSuggester)
        .register(folderOrganizer)
        .register(conversationLearner)
        .register(staleThreadDetector)
        .register(newsClusterer)
        .register(newsLinker)
        .register(connectionWeaver)
        .register(dailySynthesis)
        .register(vaultHealth);

      tpEngine.start(vault);

      // Register periodic touchpoint tasks
      tasks.push({
        name: "daily-synthesis",
        intervalMs: 60 * 60 * 1000, // check every hour (touchpoint self-gates to 8:30-10pm EAT)
        fn: () => tpEngine.runPeriodic("daily-synthesis"),
        lastRun: 0,
      });
      tasks.push({
        name: "vault-health",
        intervalMs: 6 * 60 * 60 * 1000, // every 6 hours
        fn: () => tpEngine.runPeriodic("vault-health"),
        lastRun: 0,
      });

      // Register stale-thread-detector as a periodic daemon task (6hr)
      tasks.push({
        name: "stale-thread-detector",
        intervalMs: 6 * 60 * 60 * 1000,
        fn: () => tpEngine.runPeriodic("stale-thread-detector"),
        lastRun: 0,
      });

      console.log("[daemon] Touch Point Engine started with 6 touch points");
    } catch (err) {
      console.warn("[daemon] Touch Point Engine failed to load (non-fatal):", err instanceof Error ? err.message : err);
    }
  } catch (err) {
    console.warn("[daemon] Vault sync engine failed to start, falling back to polling-only:", err);
  }

  // Write initial status and cron schedule before running any tasks
  await writeDaemonStatus();
  await writeCronSchedule();

  // Run all tasks immediately on startup
  for (const task of tasks) {
    try {
      await task.fn();
      task.lastRun = Date.now();
      recordTaskRun(task.name, true);
    } catch (err) {
      console.error(`[${task.name}] Error on startup:`, err);
      recordTaskRun(task.name, false, String(err));
    }
  }
  await writeDaemonStatus();

  // Main loop — check every 30 seconds (safety-net polling fallback)
  driftAwareInterval(async () => {
    const now = Date.now();
    let statusDirty = false;
    for (const task of tasks) {
      if (now - task.lastRun >= task.intervalMs) {
        try {
          await task.fn();
          recordTaskRun(task.name, true);
        } catch (err) {
          console.error(`[${task.name}] Error:`, err);
          recordTaskRun(task.name, false, String(err));
        }
        task.lastRun = now;
        statusDirty = true;
      }
    }
    if (statusDirty) {
      await writeDaemonStatus();
    }
  }, 30_000);

  // ── Claude Code cron tasks (wall-clock schedule, checked every 60s) ──
  const claudeCronTasks = loadClaudeScheduledTasks();
  console.log(`[claude-cron] ${claudeCronTasks.length} task(s) registered`);

  driftAwareInterval(async () => {
    const now = new Date();
    const currentMinute = Math.floor(Date.now() / 60_000);
    for (const task of claudeCronTasks) {
      if (task.lastFiredMinute === currentMinute) continue; // already fired this minute
      if (matchesCron(task.schedule, now)) {
        task.lastFiredMinute = currentMinute;
        runClaudeScheduledTask(task).catch((err) => {
          console.error(`[claude-cron] ${task.name} error:`, err);
        });
      }
    }
  }, 60_000);
}

// ─── HQ Browser Server Lifecycle ─────────────────────────────────────

let hqBrowserProc: ReturnType<typeof Bun.spawn> | null = null;

async function startHQBrowser(): Promise<void> {
  if (!HQ_BROWSER_ENABLED) return;

  // Locate the binary relative to the repo root (scripts/../packages/hq-browser/bin/hq-browser)
  const repoRoot = path.resolve(import.meta.dir, "..");
  const binaryPath = path.join(repoRoot, "packages/hq-browser/bin/hq-browser");

  if (!fs.existsSync(binaryPath)) {
    console.warn(
      `[hq-browser] Binary not found at ${binaryPath}. ` +
      `Run: cd packages/hq-browser && make build  (requires Go 1.22+)`
    );
    return;
  }

  // Check if already running on the port
  try {
    const res = await fetch(`http://127.0.0.1:${HQ_BROWSER_PORT}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      console.log(`[hq-browser] Already running on :${HQ_BROWSER_PORT}`);
      return;
    }
  } catch {
    // Not running — proceed to start
  }

  hqBrowserProc = Bun.spawn(
    [binaryPath, "--port", String(HQ_BROWSER_PORT), "--vault", VAULT_PATH, "--headless"],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, VAULT_PATH },
    },
  );
  console.log(`[hq-browser] Started (pid ${hqBrowserProc.pid}) on :${HQ_BROWSER_PORT}`);
}

async function stopHQBrowser(): Promise<void> {
  if (hqBrowserProc) {
    hqBrowserProc.kill("SIGTERM");
    hqBrowserProc = null;
    console.log("[hq-browser] Stopped");
  }
}

async function checkHQBrowserHealth(): Promise<void> {
  if (!HQ_BROWSER_ENABLED) return;
  try {
    const res = await fetch(`http://127.0.0.1:${HQ_BROWSER_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn("[hq-browser] Health check failed — attempting restart:", String(err));
    hqBrowserProc?.kill("SIGTERM");
    hqBrowserProc = null;
    await startHQBrowser();
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log("\n[daemon] Shutting down...");
  await stopHQBrowser();
  await vault.stopSync().catch(() => { });
  search.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[daemon] Received SIGTERM, shutting down...");
  await stopHQBrowser();
  await vault.stopSync().catch(() => { });
  search.close();
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────────────────

runScheduler().catch((err) => {
  console.error("[daemon] Fatal error:", err);
  process.exit(1);
});

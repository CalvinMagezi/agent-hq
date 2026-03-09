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

import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import { VaultClient } from "@repo/vault-client";
import { SyncedVaultClient } from "@repo/vault-sync";
import { SearchClient } from "@repo/vault-client/search";
import { calculateCost } from "@repo/vault-client/pricing";
import { createMemorySystem } from "@repo/vault-memory";
import { notify, notifyIfMeaningful } from "./notificationService.js";

// ─── Configuration ───────────────────────────────────────────────────

const VAULT_PATH =
  process.env.VAULT_PATH ??
  path.resolve(import.meta.dir, "..", ".vault");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
const STALE_JOB_DAYS = 7;
const STUCK_JOB_HOURS = 2;
const OFFLINE_WORKER_SECONDS = 30;
const RELAY_STALE_SECONDS = 60;

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

// ─── Startup Validation ─────────────────────────────────────────────

function validatePrerequisites(): void {
  const warnings: string[] = [];

  if (!OPENROUTER_API_KEY) {
    warnings.push("OPENROUTER_API_KEY is not set — embeddings will be skipped");
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
    { interval: "Every 30s",  task: "promote-delegation",     description: "Move completed delegation tasks to done" },
    { interval: "Every 1min", task: "expire-approvals",        description: "Expire human-in-the-loop approvals past deadline" },
    { interval: "Every 5min", task: "heartbeat",               description: "Process HEARTBEAT.md for actionable tasks" },
    { interval: "Every 5min", task: "health-check",            description: "Detect stuck jobs & offline workers, alert on issues" },
    { interval: "Every 5min", task: "relay-health",            description: "Check relay bot connectivity" },
    { interval: "Every 30min",task: "memory-consolidation",    description: "Consolidate cross-harness memories via Ollama qwen3.5:9b" },
    { interval: "Every 30min",task: "embeddings",              description: "Embed new/modified vault notes into FTS5 + vector index" },
    { interval: "Every 1hr",  task: "stale-cleanup",           description: "Delete jobs >7 days old" },
    { interval: "Every 1hr",  task: "delegation-cleanup",      description: "Purge stale delegation signals and oversized result files" },
    { interval: "Every 2hr",  task: "note-linking",            description: "Add semantic Related Notes sections to all embedded notes" },
    { interval: "Every 12hr", task: "topic-mocs",              description: "Auto-generate Maps of Content per tag cluster" },
    { interval: "Daily 8pm",  task: "daily-brief",             description: "Send end-of-day summary to Telegram with all task activity" },
  ];

  // ── Claude Code scheduled tasks — load from SKILL.md files ──
  const claudeTasksDir = path.join(
    process.env.HOME ?? "/Users/" + (process.env.USER ?? ""),
    ".claude/scheduled-tasks"
  );
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
        brave: !!process.env.BRAVE_API_KEY,
        gemini: !!process.env.GEMINI_API_KEY,
      },
    };

    const lines: string[] = ["# Daemon Status", ""];
    lines.push(`**Started:** ${daemonStartedAt}`);
    lines.push(`**PID:** ${process.pid}`);
    lines.push(`**Vault:** ${VAULT_PATH}`);
    lines.push(`**API Keys:** OpenRouter=${OPENROUTER_API_KEY ? "set" : "MISSING"}, Brave=${process.env.BRAVE_API_KEY ? "set" : "not set"}, Gemini=${process.env.GEMINI_API_KEY ? "set" : "not set"}`);
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
    const claudeTasksDir2 = path.join(process.env.HOME ?? "", ".claude/scheduled-tasks");
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

// ─── Task: Expire Stale Approvals (every 1 min) ─────────────────────

async function expireApprovals(): Promise<void> {
  const pendingDir = path.join(VAULT_PATH, "_approvals/pending");
  if (!fs.existsSync(pendingDir)) return;

  const files = fs
    .readdirSync(pendingDir)
    .filter((f) => f.endsWith(".md"));
  const now = Date.now();
  let expired = 0;

  for (const file of files) {
    try {
      const filePath = path.join(pendingDir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const matter = await import("gray-matter").then((m) => m.default);
      const { data } = matter(raw);

      if (data.expiresAt && new Date(data.expiresAt).getTime() < now) {
        await vault.resolveApproval(data.approvalId, "rejected", "system", "Expired");
        expired++;
      }
    } catch {
      // Skip malformed files
    }
  }

  if (expired > 0) {
    console.log(`[approvals] Expired ${expired} stale approval(s)`);
  }
}

// ─── Task: Process Heartbeat (every 2 min) ───────────────────────────

const HEARTBEAT_STATE_PATH = path.join(VAULT_PATH, "_system/heartbeat-state.json");
const ACTIVE_HOURS = { start: 8, end: 24 }; // Only dispatch user tasks during these hours (local time)
const HEARTBEAT_WRITE_INTERVAL_MS = 10 * 60 * 1000; // Only write lastProcessed every 10 min when idle

interface HeartbeatState {
  lastChecks: Record<string, number>;
  lastStatus: "ok" | "alert";
  alerts: string[];
}

function loadHeartbeatState(): HeartbeatState {
  try {
    if (fs.existsSync(HEARTBEAT_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(HEARTBEAT_STATE_PATH, "utf-8"));
    }
  } catch { /* use defaults */ }
  return { lastChecks: {}, lastStatus: "ok", alerts: [] };
}

function saveHeartbeatState(state: HeartbeatState): void {
  fs.writeFileSync(HEARTBEAT_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

function isActiveHours(): boolean {
  const hour = new Date().getHours();
  return hour >= ACTIVE_HOURS.start && hour < ACTIVE_HOURS.end;
}

/** Rotating health checks — each cycle runs the most overdue check */
function runRotatingCheck(state: HeartbeatState): { check: string; result: string; isAlert: boolean } | null {
  const checks: Record<string, () => { result: string; isAlert: boolean }> = {
    jobs: () => {
      const pending = countFiles(path.join(VAULT_PATH, "_jobs/pending"));
      const running = countFiles(path.join(VAULT_PATH, "_jobs/running"));
      const failed = countFiles(path.join(VAULT_PATH, "_jobs/failed"));
      const isAlert = running > 10 || failed > 20;
      return {
        result: `pending=${pending} running=${running} failed=${failed}`,
        isAlert,
      };
    },
    workers: () => {
      const sessionsDir = path.join(VAULT_PATH, "_agent-sessions");
      if (!fs.existsSync(sessionsDir)) return { result: "no sessions dir", isAlert: false };
      const files = fs.readdirSync(sessionsDir).filter(f => f.startsWith("worker-") && f.endsWith(".md"));
      return { result: `${files.length} worker session(s)`, isAlert: false };
    },
    relay: () => {
      const healthDir = path.join(VAULT_PATH, "_delegation/relay-health");
      if (!fs.existsSync(healthDir)) return { result: "no relay health dir", isAlert: false };
      const files = fs.readdirSync(healthDir).filter(f => f.endsWith(".md"));
      return { result: `${files.length} relay(s) tracked`, isAlert: false };
    },
    disk: () => {
      const embeddingsDir = path.join(VAULT_PATH, "_embeddings");
      let dbSize = "n/a";
      if (fs.existsSync(embeddingsDir)) {
        const dbFile = path.join(embeddingsDir, "search.db");
        if (fs.existsSync(dbFile)) {
          const stat = fs.statSync(dbFile);
          dbSize = `${(stat.size / 1024 / 1024).toFixed(1)}MB`;
        }
      }
      return { result: `embeddings db=${dbSize}`, isAlert: false };
    },
  };

  // Find the most overdue check
  const now = Date.now();
  let oldestCheck: string | null = null;
  let oldestTime = Infinity;

  for (const name of Object.keys(checks)) {
    const lastRun = state.lastChecks[name] ?? 0;
    if (lastRun < oldestTime) {
      oldestTime = lastRun;
      oldestCheck = name;
    }
  }

  if (!oldestCheck) return null;

  try {
    const { result, isAlert } = checks[oldestCheck]();
    state.lastChecks[oldestCheck] = now;
    return { check: oldestCheck, result, isAlert };
  } catch (err) {
    state.lastChecks[oldestCheck] = now;
    return { check: oldestCheck, result: `error: ${err}`, isAlert: true };
  }
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith(".md")).length;
}

async function processHeartbeat(): Promise<void> {
  const heartbeatPath = path.join(VAULT_PATH, "_system/HEARTBEAT.md");
  if (!fs.existsSync(heartbeatPath)) return;

  try {
    const matter = await import("gray-matter").then((m) => m.default);
    const raw = fs.readFileSync(heartbeatPath, "utf-8");
    const { data, content } = matter(raw);

    // Look for pending actions section
    const actionsMatch = content.match(
      /## Pending Actions\s*\n([\s\S]*?)(?=\n##|$)/,
    );

    let actionsProcessed = 0;
    let updatedContent = content.trim();

    if (actionsMatch && isActiveHours()) {
      const actionsText = actionsMatch[1].trim();
      if (actionsText !== "_No pending actions._" && actionsText) {
        // Extract individual tasks (lines starting with - or *)
        const pendingTasks = actionsText
          .split("\n")
          .filter((line) => /^[-*]\s+/.test(line))
          .map((line) => line.replace(/^[-*]\s+/, "").trim())
          .filter(Boolean);

        // Create a background job for each task
        for (const task of pendingTasks) {
          const jobId = await vault.createJob({
            instruction: task,
            type: "background",
            priority: 40,
            securityProfile: "standard",
          });
          console.log(`[heartbeat] Created job ${jobId}: ${task.substring(0, 60)}...`);
          actionsProcessed++;
        }

        // Clear the pending actions
        if (actionsProcessed > 0) {
          updatedContent = updatedContent.replace(
            /## Pending Actions\s*\n[\s\S]*?(?=\n##|$)/,
            "## Pending Actions\n\n_No pending actions._\n",
          );
        }
      }
    } else if (actionsMatch && !isActiveHours()) {
      const actionsText = actionsMatch[1].trim();
      if (actionsText !== "_No pending actions._" && actionsText) {
        console.log(`[heartbeat] Pending actions deferred — outside active hours (${ACTIVE_HOURS.start}:00-${ACTIVE_HOURS.end}:00)`);
      }
    }

    // Run a rotating health check
    const state = loadHeartbeatState();
    const checkResult = runRotatingCheck(state);

    if (checkResult) {
      const { check, result, isAlert } = checkResult;
      if (isAlert) {
        state.alerts.push(`[${localTimestamp()}] ${check}: ${result}`);
        // Keep only last 10 alerts
        if (state.alerts.length > 10) state.alerts = state.alerts.slice(-10);
        state.lastStatus = "alert";
        console.log(`[heartbeat] ALERT ${check}: ${result}`);
      } else {
        state.lastStatus = "ok";
      }
      saveHeartbeatState(state);
    }

    // Update the Alerts section in the heartbeat file
    if (state.alerts.length > 0) {
      const alertsSection = "## Alerts\n\n" + state.alerts.map(a => `- ${a}`).join("\n") + "\n";
      if (updatedContent.includes("## Alerts")) {
        updatedContent = updatedContent.replace(
          /## Alerts\s*\n[\s\S]*?(?=\n##|$)/,
          alertsSection,
        );
      } else {
        updatedContent = updatedContent.trimEnd() + "\n\n" + alertsSection;
      }
    } else if (updatedContent.includes("## Alerts")) {
      // Remove alerts section when no alerts
      updatedContent = updatedContent.replace(/\n*## Alerts\s*\n[\s\S]*?(?=\n##|$)/, "");
    }

    // Early exit: skip writing if idle and recently written
    if (actionsProcessed === 0) {
      const last = data.lastProcessed ? new Date(data.lastProcessed).getTime() : 0;
      if (Date.now() - last < HEARTBEAT_WRITE_INTERVAL_MS && !checkResult?.isAlert) {
        return; // HEARTBEAT_OK — nothing to update
      }
    }

    // Write back with clean content (no newline accumulation)
    data.lastProcessed = localTimestamp();
    data.status = state.lastStatus;
    fs.writeFileSync(heartbeatPath, matter.stringify(updatedContent.trim(), data), "utf-8");

    if (actionsProcessed > 0) {
      console.log(`[heartbeat] Processed ${actionsProcessed} action(s)`);
    }
  } catch (err) {
    console.error("[heartbeat] Error:", err);
  }
}

// ─── Task: Health Check (every 5 min) ────────────────────────────────

async function healthCheck(): Promise<void> {
  const now = Date.now();

  // Check for stuck jobs (running > STUCK_JOB_HOURS)
  const runningDir = path.join(VAULT_PATH, "_jobs/running");
  if (fs.existsSync(runningDir)) {
    const files = fs
      .readdirSync(runningDir)
      .filter((f) => f.endsWith(".md"));

    for (const file of files) {
      try {
        const filePath = path.join(runningDir, file);
        const matter = await import("gray-matter").then((m) => m.default);
        const { data } = matter(fs.readFileSync(filePath, "utf-8"));

        const updatedAt = data.updatedAt ?? data.createdAt;
        if (updatedAt) {
          const elapsed = now - new Date(updatedAt).getTime();
          if (elapsed > STUCK_JOB_HOURS * 3600 * 1000) {
            await vault.updateJobStatus(data.jobId, "failed", {
              result: `Job stuck for ${Math.round(elapsed / 3600000)}h, marked as failed by health check`,
            });
            console.log(`[health] Failed stuck job: ${data.jobId}`);
            await notify(
              `⚠️ <b>Health Alert</b>: Job <code>${data.jobId}</code> was stuck for ${Math.round(elapsed / 3600000)}h and has been marked failed.`,
              `stuck-job:${data.jobId}`
            );
          }
        }
      } catch {
        // Skip
      }
    }
  }

  // Check for offline workers
  const sessionsDir = path.join(VAULT_PATH, "_agent-sessions");
  if (fs.existsSync(sessionsDir)) {
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".md"));

    for (const file of files) {
      try {
        const filePath = path.join(sessionsDir, file);
        const matter = await import("gray-matter").then((m) => m.default);
        const raw = fs.readFileSync(filePath, "utf-8");
        const { data, content } = matter(raw);

        if (data.status === "online" && data.lastHeartbeat) {
          const elapsed = now - new Date(data.lastHeartbeat).getTime();
          if (elapsed > OFFLINE_WORKER_SECONDS * 1000) {
            data.status = "offline";
            fs.writeFileSync(filePath, matter.stringify(content.trim(), data), "utf-8");
            console.log(`[health] Worker ${data.workerId} marked offline`);
          }
        }
      } catch {
        // Skip
      }
    }
  }
}

// ─── Task: Relay Health Check (every 5 min) ──────────────────────────

async function relayHealthCheck(): Promise<void> {
  const now = Date.now();
  const relays = await vault.getRelayHealthAll();

  for (const relay of relays) {
    if (relay.lastHeartbeat) {
      const elapsed = now - new Date(relay.lastHeartbeat).getTime();

      let newStatus = relay.status;
      if (elapsed > RELAY_STALE_SECONDS * 2 * 1000) {
        newStatus = "offline";
      } else if (elapsed > RELAY_STALE_SECONDS * 1000) {
        newStatus = "degraded";
      }

      if (newStatus !== relay.status) {
        await vault.upsertRelayHealth(relay.relayId, { status: newStatus });
        console.log(
          `[relay-health] ${relay.displayName}: ${relay.status} -> ${newStatus}`,
        );
      }
    }
  }

  // Time out stale claimed tasks
  const claimedDir = path.join(VAULT_PATH, "_delegation/claimed");
  if (fs.existsSync(claimedDir)) {
    const files = fs
      .readdirSync(claimedDir)
      .filter((f) => f.endsWith(".md"));
    const matter = await import("gray-matter").then((m) => m.default);

    for (const file of files) {
      try {
        const filePath = path.join(claimedDir, file);
        const { data } = matter(fs.readFileSync(filePath, "utf-8"));

        if (data.claimedAt && data.deadlineMs) {
          const elapsed = now - new Date(data.claimedAt).getTime();
          if (elapsed > data.deadlineMs) {
            await vault.updateTaskStatus(data.taskId, "timeout");
            console.log(`[relay-health] Task ${data.taskId} timed out`);
          }
        }
      } catch {
        // Skip
      }
    }
  }
}

// ─── Task: Embedding Processor (every 10 min) ───────────────────────

async function processEmbeddings(): Promise<void> {
  if (!OPENROUTER_API_KEY) {
    return; // Skip if no API key
  }

  const pendingNotes = await vault.getNotesForEmbedding("pending", 10);
  if (pendingNotes.length === 0) return;

  console.log(`[embeddings] Processing ${pendingNotes.length} note(s)...`);

  for (const note of pendingNotes) {
    try {
      // Mark as processing
      await vault.updateNote(note._filePath, undefined, {
        embeddingStatus: "processing",
      });

      // Generate embedding via OpenRouter
      const text = `${note.title}\n\n${note.content}`.substring(0, 8000);
      const response = await fetch(
        "https://openrouter.ai/api/v1/embeddings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: text,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status}`);
      }

      const result = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      const embedding = result.data[0]?.embedding;

      if (!embedding) {
        throw new Error("No embedding returned");
      }

      // Store embedding in search index
      search.storeEmbedding(note._filePath, embedding, EMBEDDING_MODEL);

      // Also index for FTS
      search.indexNote(note._filePath, note.title, note.content, note.tags);

      // Update frontmatter
      await vault.updateNote(note._filePath, undefined, {
        embeddingStatus: "embedded",
        embeddedAt: new Date().toISOString(),
        embeddingModel: EMBEDDING_MODEL,
      });

      console.log(`[embeddings] Embedded: ${note.title}`);
    } catch (err) {
      await vault.updateNote(note._filePath, undefined, {
        embeddingStatus: "failed",
      });
      console.error(`[embeddings] Failed: ${note.title}:`, err);
    }
  }
}

// ─── Task: Memory Forgetting Cycle (every 24 hr) ─────────────────────
// Implements "Synaptic Homeostasis": decay low-importance old memories,
// prune those that have fallen below the relevance threshold.
// This prevents noise accumulation and keeps signal/noise ratio high.

async function forgetWeakMemories(): Promise<void> {
  try {
    const result = memorySystem.forgetter.runCycle();
    if (result.decayed > 0 || result.pruned > 0) {
      console.log(`[memory-decay] Decayed ${result.decayed}, pruned ${result.pruned} memories. DB now: ${result.statsAfter.total} total`);
    }
  } catch (err) {
    console.error("[daemon] Memory forgetting cycle failed:", err);
  }
}

// ─── Task: News Pulse (every 1 hr) ───────────────────────────────────
// Fetches the top headlines from trusted RSS feeds and writes a compact
// "Current News Pulse" section to _system/HEARTBEAT.md so all agents
// have ambient awareness of current events without burning context.
// Runs every 15 minutes. Each feed contributes up to 3 headlines.

const NEWS_PULSE_FEEDS = [
  // Global news (verified fresh, free RSS)
  { url: "https://www.theguardian.com/world/rss", label: "Guardian" },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", label: "Al Jazeera" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", label: "BBC" },
  // Tech
  { url: "https://techcrunch.com/feed/", label: "TechCrunch" },
  { url: "https://www.theverge.com/rss/index.xml", label: "The Verge" },
  { url: "https://www.wired.com/feed/rss", label: "Wired" },
  { url: "https://news.ycombinator.com/rss", label: "HN" },
  { url: "https://simonwillison.net/atom/everything/", label: "Simon Willison" },
  // Africa / Business
  { url: "https://techcabal.com/feed/", label: "TechCabal" },
  // AI / Research
  { url: "https://www.technologyreview.com/feed/", label: "MIT Tech Review" },
];

/**
 * Strip characters that could be used for prompt injection or markdown manipulation.
 * RSS titles from untrusted feeds are written into HEARTBEAT.md which all agents read.
 */
function sanitizePulseText(raw: string): string {
  return raw
    .replace(/\r?\n|\r/g, " ")           // no newlines — would break markdown structure
    .replace(/#{1,6}\s/g, "")            // no markdown headings
    .replace(/`{1,3}[^`]*`{1,3}/g, "")  // no code blocks/inline code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // collapse existing links to label only
    .replace(/[*_~|\\]/g, "")           // no emphasis, strikethrough, table, escape chars
    .replace(/\s{2,}/g, " ")            // collapse whitespace
    .trim()
    .slice(0, 100);
}

/** Validate a URL is a safe https link before embedding in markdown. */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

async function refreshNewsPulse(): Promise<void> {
  const heartbeatPath = path.join(VAULT_PATH, "_system/HEARTBEAT.md");
  if (!fs.existsSync(heartbeatPath)) return;

  const PULSE_MARKER = "<!-- agent-hq-news-pulse -->";
  const now = new Date().toUTCString();

  // Fetch all feeds concurrently (parallel, not sequential)
  const feedResults = await Promise.allSettled(
    NEWS_PULSE_FEEDS.map(async (feed) => {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "AgentHQ-Pulse/1.0" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return { label: feed.label, items: [] as string[] };
      const xml = await res.text();
      const isAtom = /<feed[\s>]/.test(xml);
      const blockTag = isAtom ? "entry" : "item";
      const blockRegex = new RegExp(`<${blockTag}>[\\s\\S]*?<\\/${blockTag}>`, "gi");

      const items: string[] = [];
      for (const match of xml.matchAll(blockRegex)) {
        if (items.length >= 3) break;
        const block = match[0];
        const rawTitle = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]
          ?.replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
          .replace(/&#8220;/g, "\u201C").replace(/&#8221;/g, "\u201D").replace(/&#[0-9]+;/g, "") || "";
        const rawLink = isAtom
          ? (block.match(/\shref=["']([^"']+)["']/i)?.[1] || "")
          : (block.match(/<link[^>]*>([^<]+)<\/link>/i)?.[1]?.trim() || "");

        const title = sanitizePulseText(rawTitle);
        if (!title || !rawLink || !isSafeUrl(rawLink)) continue;
        const link = rawLink.slice(0, 300);
        items.push(`- **[${feed.label}]** [${title}](${link})`);
      }
      return { label: feed.label, items };
    })
  );

  const lines: string[] = feedResults
    .filter((r): r is PromiseFulfilledResult<{ label: string; items: string[] }> => r.status === "fulfilled")
    .flatMap((r) => r.value.items);

  if (lines.length === 0) return;

  const pulseSection = `${PULSE_MARKER}\n## Current News Pulse\n_Updated: ${now}_\n\n${lines.join("\n")}\n`;

  try {
    const existing = fs.readFileSync(heartbeatPath, "utf-8");
    let updated: string;
    if (existing.includes(PULSE_MARKER)) {
      // Replace from the marker to end-of-file (pulse is always last section)
      const escapedMarker = PULSE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      updated = existing.replace(new RegExp(`${escapedMarker}[\\s\\S]*$`), pulseSection);
    } else {
      updated = existing.trimEnd() + "\n\n" + pulseSection;
    }
    fs.writeFileSync(heartbeatPath, updated, "utf-8");
    console.log(`[news-pulse] Updated HEARTBEAT.md with ${lines.length} headline(s)`);
  } catch (err) {
    console.error("[news-pulse] Failed to update HEARTBEAT.md:", err);
  }
}

// ─── Task: Memory Consolidation (every 30 min) ───────────────────────

async function consolidateMemory(): Promise<void> {
  try {
    const insight = await memorySystem.consolidator.runCycle();
    if (insight) {
      await memorySystem.consolidator.refreshMemoryFile();
      await notifyIfMeaningful(
        "memory-consolidation",
        "new cross-harness connections found",
        true,
        () => `🧠 <b>Memory consolidation</b> complete — new insight recorded in Notebooks/Memories/`
      );
    }
  } catch (err) {
    console.error("[daemon] Memory consolidation failed:", err);
  }
}

// ─── Task: Stale Job Cleanup (every 1 hr) ────────────────────────────

async function cleanupStaleJobs(): Promise<void> {
  const now = Date.now();
  const maxAge = STALE_JOB_DAYS * 24 * 3600 * 1000;
  let cleaned = 0;

  try {
    // fbmq: reap jobs stuck in processing > 2 hours (7200s)
    await vault.jobQueue.reap(7200);
    // fbmq: purge done/failed messages older than maxAge
    await vault.jobQueue.purge(STALE_JOB_DAYS * 24 * 3600);
    cleaned++;
  } catch (err) {
    console.error("[cleanup] fbmq job queue cleanup failed:", err);
  }

  // Clean old log files
  const logsDir = path.join(VAULT_PATH, "_logs");
  if (fs.existsSync(logsDir)) {
    const dateDirs = fs.readdirSync(logsDir, { withFileTypes: true });
    for (const d of dateDirs) {
      if (d.isDirectory()) {
        const dirPath = path.join(logsDir, d.name);
        const stat = fs.statSync(dirPath);
        if (now - stat.mtimeMs > maxAge) {
          fs.rmSync(dirPath, { recursive: true });
          cleaned++;
        }
      }
    }
  }

  if (cleaned > 0) {
    console.log(`[cleanup] FBMQ reap/purge completed and removed ${cleaned} stale item(s)`);
  }
}

// ─── Task: Delegation Artifact Cleanup (every 1 hr) ─────────────────

async function cleanupDelegationArtifacts(): Promise<void> {
  const now = Date.now();
  const signalMaxAge = 60 * 60 * 1000;     // 1 hour — signals should be consumed fast
  const resultMaxAge = 7 * 24 * 3600 * 1000; // 7 days — same as job files
  let cleaned = 0;

  try {
    // fbmq delegation queues cleanup
    await vault.delegationQueue.reap(7200);
    await vault.delegationQueue.purge(7 * 24 * 3600);
    cleaned++;
  } catch (err) {
    console.error("[delegation-cleanup] fbmq delegation queue cleanup failed:", err);
  }

  // Clean up stale cancellation signals
  const signalsDir = path.join(VAULT_PATH, "_delegation/signals");
  if (fs.existsSync(signalsDir)) {
    for (const file of fs.readdirSync(signalsDir).filter(f => f.endsWith(".md"))) {
      try {
        const filePath = path.join(signalsDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > signalMaxAge) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch { /* skip */ }
    }
  }

  // Clean up old result overflow files
  const resultsDir = path.join(VAULT_PATH, "_delegation/results");
  if (fs.existsSync(resultsDir)) {
    for (const file of fs.readdirSync(resultsDir).filter(f => f.endsWith(".md"))) {
      try {
        const filePath = path.join(resultsDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > resultMaxAge) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch { /* skip */ }
    }
  }

  // Clean up stale live output files (relay crashed mid-task and never deleted)
  const liveDir = path.join(VAULT_PATH, "_delegation/live");
  if (fs.existsSync(liveDir)) {
    for (const file of fs.readdirSync(liveDir).filter(f => f.endsWith(".md"))) {
      try {
        const filePath = path.join(liveDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > signalMaxAge) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch { /* skip */ }
    }
  }

  if (cleaned > 0) {
    console.log(`[delegation-cleanup] Removed ${cleaned} stale artifact(s)`);
  }
}

// ─── Task: Note Linking (every 2 hr) ─────────────────────────────────

const SIMILARITY_THRESHOLD = 0.75;
const MAX_LINKS_PER_NOTE = 5;
const TAG_BONUS_PER_SHARED = 0.05;
const TAG_BONUS_CAP = 0.15;
const GRAPH_LINK_MARKER = "<!-- agent-hq-graph-links -->";

interface EmbeddedNote {
  absPath: string;
  relPath: string;
  title: string;
  tags: string[];
  contentHash: string;
}

interface NoteLink {
  relPath: string;
  title: string;
  score: number;
  type: string;
}

async function processNoteLinking(): Promise<void> {
  const stats = search.getStats();
  if (stats.embeddingCount < 2) return;

  console.log(
    `[linking] Processing note links across ${stats.embeddingCount} embedded notes...`,
  );

  const notebooksDir = path.join(VAULT_PATH, "Notebooks");
  if (!fs.existsSync(notebooksDir)) return;

  const matter = await import("gray-matter").then((m) => m.default);

  // Step 1: Scan all embedded notes
  const embeddedNotes: EmbeddedNote[] = [];

  const scanDir = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith(".md")) {
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          const { data } = matter(raw);
          if (data.embeddingStatus === "embedded") {
            const relPath = path.relative(VAULT_PATH, fullPath);
            // Strip the managed section before hashing so link updates don't trigger re-linking
            const contentForHash = raw.replace(
              new RegExp(`${escapeRegex(GRAPH_LINK_MARKER)}[\\s\\S]*$`),
              "",
            );
            embeddedNotes.push({
              absPath: fullPath,
              relPath,
              title: path.basename(entry.name, ".md"),
              tags: data.tags ?? [],
              contentHash: Bun.hash(contentForHash).toString(36),
            });
          }
        } catch {
          // Skip
        }
      }
    }
  };

  scanDir(notebooksDir);

  // Step 2: Identify dirty notes (changed since last linked or never linked)
  const dirtyNotes = embeddedNotes.filter((note) => {
    const state = search.getLinkState(note.relPath);
    if (!state) return true;
    return state.contentHash !== note.contentHash;
  });

  if (dirtyNotes.length === 0) {
    console.log("[linking] No notes need relinking.");
    return;
  }

  console.log(
    `[linking] ${dirtyNotes.length} of ${embeddedNotes.length} note(s) need relinking...`,
  );

  // Build tag index for bonus scoring
  const tagIndex = new Map<string, string[]>();
  for (const note of embeddedNotes) {
    for (const tag of note.tags) {
      const existing = tagIndex.get(tag) ?? [];
      existing.push(note.relPath);
      tagIndex.set(tag, existing);
    }
  }

  // Step 3: Find similar notes and compute final scores
  const pendingUpdates = new Map<
    string,
    { links: NoteLink[]; tags: string[] }
  >();

  for (const note of dirtyNotes) {
    const similar = search.findSimilarNotes(
      note.relPath,
      MAX_LINKS_PER_NOTE * 2,
      SIMILARITY_THRESHOLD,
    );

    // Apply tag bonus
    const scored: NoteLink[] = similar.map((hit) => {
      const targetNote = embeddedNotes.find((n) => n.relPath === hit.notePath);
      let tagBonus = 0;
      if (targetNote) {
        const sharedTags = note.tags.filter((t) =>
          targetNote.tags.includes(t),
        );
        tagBonus = Math.min(
          sharedTags.length * TAG_BONUS_PER_SHARED,
          TAG_BONUS_CAP,
        );
      }
      return {
        relPath: hit.notePath,
        title: hit.title,
        score: hit.relevance + tagBonus,
        type: tagBonus > 0 ? "semantic+tags" : "semantic",
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const topLinks = scored.slice(0, MAX_LINKS_PER_NOTE);

    if (topLinks.length > 0) {
      pendingUpdates.set(note.relPath, { links: topLinks, tags: note.tags });
    }
  }

  // Step 4: Enforce bidirectionality — for every A→B, also queue B→A
  const bidirectionalUpdates = new Map(pendingUpdates);

  for (const [sourcePath, { links }] of pendingUpdates) {
    for (const link of links) {
      let targetEntry = bidirectionalUpdates.get(link.relPath);
      if (!targetEntry) {
        const targetNote = embeddedNotes.find(
          (n) => n.relPath === link.relPath,
        );
        targetEntry = { links: [], tags: targetNote?.tags ?? [] };
        bidirectionalUpdates.set(link.relPath, targetEntry);
      }
      const alreadyLinked = targetEntry.links.some(
        (l) => l.relPath === sourcePath,
      );
      if (!alreadyLinked) {
        const sourceNote = embeddedNotes.find(
          (n) => n.relPath === sourcePath,
        );
        targetEntry.links.push({
          relPath: sourcePath,
          title: sourceNote?.title ?? path.basename(sourcePath, ".md"),
          score: link.score,
          type: link.type,
        });
      }
    }
  }

  // Step 5: Write wikilinks into note bodies and update frontmatter
  let updated = 0;
  for (const [notePath, { links }] of bidirectionalUpdates) {
    try {
      const absPath = path.join(VAULT_PATH, notePath);
      if (!fs.existsSync(absPath)) continue;

      const raw = fs.readFileSync(absPath, "utf-8");
      const { data, content } = matter(raw);

      // Build the Related Notes section with wikilinks
      const relatedSection = buildRelatedSection(links);

      // Replace or append the managed section
      let newContent: string;
      if (content.includes(GRAPH_LINK_MARKER)) {
        newContent = content.replace(
          new RegExp(`${escapeRegex(GRAPH_LINK_MARKER)}[\\s\\S]*$`),
          relatedSection,
        );
      } else {
        newContent = content.trimEnd() + "\n\n" + relatedSection;
      }

      // Also update frontmatter relatedNotes for non-Obsidian consumers
      data.relatedNotes = links.map((l) => `[[${l.title}]]`);
      data.updatedAt = new Date().toISOString();

      fs.writeFileSync(
        absPath,
        matter.stringify(newContent.trim(), data),
        "utf-8",
      );

      // Record state so we skip this note next cycle (unless content changes)
      const contentForHash = fs
        .readFileSync(absPath, "utf-8")
        .replace(
          new RegExp(`${escapeRegex(GRAPH_LINK_MARKER)}[\\s\\S]*$`),
          "",
        );
      search.setLinkState(notePath, Bun.hash(contentForHash).toString(36));

      // Store links in SQLite for analysis
      search.removeGraphLinks(notePath);
      for (const link of links) {
        search.addGraphLink(notePath, link.relPath, link.score, link.type);
      }

      updated++;
    } catch (err) {
      console.error(`[linking] Error updating ${notePath}:`, err);
    }
  }

  if (updated > 0) {
    console.log(`[linking] Updated links for ${updated} note(s)`);
    await notifyIfMeaningful(
      "note-linking",
      `${updated} note(s) updated`,
      updated >= 5, // only notify when it's meaningful (5+ notes relinked)
      (s) => `🔗 <b>Note Linking</b> complete — ${s} with new semantic connections in your vault.`
    );
  }
}

function buildRelatedSection(links: NoteLink[]): string {
  const lines = [GRAPH_LINK_MARKER, "## Related Notes", ""];

  for (const link of links) {
    const scoreLabel = (link.score * 100).toFixed(0);
    const typeIndicator = link.type.includes("tags") ? " #" : "";
    lines.push(
      `- [[${link.title}]]${typeIndicator} _(${scoreLabel}% similar)_`,
    );
  }

  lines.push(""); // trailing newline
  return lines.join("\n");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Task: Topic MOC Generation (every 12 hr) ───────────────────────

const MOC_LINK_MARKER = "<!-- agent-hq-moc-links -->";
const MIN_NOTES_FOR_MOC = 3;
const SKIP_TAGS = new Set([
  "auto-generated",
  "daily-digest",
  "weekly-analysis",
  "moc",
]);

async function processTopicMOCs(): Promise<void> {
  const matter = await import("gray-matter").then((m) => m.default);
  const mocDir = path.join(VAULT_PATH, "_moc");
  if (!fs.existsSync(mocDir)) {
    fs.mkdirSync(mocDir, { recursive: true });
  }

  const tagCounts = search.getAllTags();
  let created = 0;
  let updated = 0;

  for (const [tag, count] of tagCounts) {
    if (count < MIN_NOTES_FOR_MOC || SKIP_TAGS.has(tag)) continue;

    const notePaths = search.getTaggedNotePaths(tag);
    if (notePaths.length < MIN_NOTES_FOR_MOC) continue;

    const safeName = tag.replace(/[/\\:*?"<>|]/g, "-");
    const titleCase =
      tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " ");
    const mocPath = path.join(mocDir, `Topic - ${safeName}.md`);

    // Build wikilinks section
    const wikilinks = notePaths
      .map((p) => {
        const title = path.basename(p, ".md");
        return `- [[${title}]]`;
      })
      .join("\n");

    const managedSection = `${MOC_LINK_MARKER}\n### Linked Notes\n\n${wikilinks}\n`;

    if (!fs.existsSync(mocPath)) {
      // Create new MOC
      const frontmatter = {
        tags: ["moc", tag],
        autoGenerated: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const content = [
        `# ${titleCase}`,
        "",
        "```dataview",
        `TABLE noteType, tags, updatedAt`,
        `FROM "Notebooks"`,
        `WHERE contains(tags, "${tag}")`,
        `SORT updatedAt DESC`,
        "```",
        "",
        managedSection,
      ].join("\n");

      fs.writeFileSync(
        mocPath,
        matter.stringify(content, frontmatter),
        "utf-8",
      );
      created++;
    } else {
      // Update existing MOC's managed section
      const raw = fs.readFileSync(mocPath, "utf-8");
      const { data, content } = matter(raw);

      let newContent: string;
      if (content.includes(MOC_LINK_MARKER)) {
        newContent = content.replace(
          new RegExp(`${escapeRegex(MOC_LINK_MARKER)}[\\s\\S]*$`),
          managedSection,
        );
      } else {
        newContent = content.trimEnd() + "\n\n" + managedSection;
      }

      data.updatedAt = new Date().toISOString();
      fs.writeFileSync(
        mocPath,
        matter.stringify(newContent.trim(), data),
        "utf-8",
      );
      updated++;
    }
  }

  if (created + updated > 0) {
    console.log(`[moc] Created ${created}, updated ${updated} topic MOC(s)`);
    await notifyIfMeaningful(
      "topic-mocs",
      `${created} created, ${updated} updated`,
      true,
      (s) => `📚 <b>MOC pages</b> updated — ${s}\nOpen <i>_moc/</i> in Obsidian to browse.`
    );
  }
}

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

const CLAUDE_SCHEDULED_TASKS_DIR = path.join(
  process.env.HOME ?? "/Users/" + (process.env.USER ?? ""),
  ".claude/scheduled-tasks"
);

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
    {
      name: "note-linking",
      intervalMs: 2 * 60 * 60 * 1000,
      fn: processNoteLinking,
      lastRun: 0,
    },
    {
      name: "topic-mocs",
      intervalMs: 12 * 60 * 60 * 1000,
      fn: processTopicMOCs,
      lastRun: 0,
    },
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
  ];

async function runScheduler(): Promise<void> {
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

    // Event-driven: expire approvals when new ones are created
    vault.on("approval:created", async () => {
      try {
        await expireApprovals();
        recordTaskRun("expire-approvals", true);
      } catch (err) {
        recordTaskRun("expire-approvals", false, String(err));
      }
    });

    console.log("[daemon] Event subscriptions registered (embeddings, heartbeat, approvals)");
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
  setInterval(async () => {
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

  setInterval(async () => {
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

// ─── Graceful Shutdown ───────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log("\n[daemon] Shutting down...");
  await vault.stopSync().catch(() => { });
  search.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[daemon] Received SIGTERM, shutting down...");
  await vault.stopSync().catch(() => { });
  search.close();
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────────────────

runScheduler().catch((err) => {
  console.error("[daemon] Fatal error:", err);
  process.exit(1);
});

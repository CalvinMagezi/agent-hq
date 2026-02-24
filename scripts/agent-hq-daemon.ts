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
import { VaultClient } from "@repo/vault-client";
import { SyncedVaultClient } from "@repo/vault-sync";
import { SearchClient } from "@repo/vault-client/search";
import { calculateCost } from "@repo/vault-client/pricing";
import { startBridge, stopBridge, type BridgeContext } from "./openclaw-bridge";
import { OpenClawAdapter } from "@repo/vault-client/openclaw-adapter";
import { AuditLogger } from "./openclaw-bridge/audit";

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

// ─── Startup Validation ─────────────────────────────────────────────

function validatePrerequisites(): void {
  const warnings: string[] = [];

  if (!OPENROUTER_API_KEY) {
    warnings.push("OPENROUTER_API_KEY is not set — embeddings will be skipped");
  }
  if (!process.env.BRAVE_API_KEY) {
    warnings.push("BRAVE_API_KEY is not set — web digest search will be unavailable");
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

// ─── Task: Stale Job Cleanup (every 1 hr) ────────────────────────────

async function cleanupStaleJobs(): Promise<void> {
  const now = Date.now();
  const maxAge = STALE_JOB_DAYS * 24 * 3600 * 1000;
  let cleaned = 0;

  for (const dir of ["done", "failed"]) {
    const fullDir = path.join(VAULT_PATH, `_jobs/${dir}`);
    if (!fs.existsSync(fullDir)) continue;

    const files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        const filePath = path.join(fullDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Skip
      }
    }
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
    console.log(`[cleanup] Removed ${cleaned} stale item(s)`);
  }
}

// ─── Task: Delegation Artifact Cleanup (every 1 hr) ─────────────────

async function cleanupDelegationArtifacts(): Promise<void> {
  const now = Date.now();
  const signalMaxAge = 60 * 60 * 1000;     // 1 hour — signals should be consumed fast
  const resultMaxAge = 7 * 24 * 3600 * 1000; // 7 days — same as job files
  let cleaned = 0;

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
  }
}

// ─── OpenClaw Bridge & Watchdog ──────────────────────────────────────

let bridgeCtx: BridgeContext | null = null;

function initBridge(): void {
  try {
    bridgeCtx = startBridge(VAULT_PATH);
  } catch (err) {
    console.error("[openclaw-bridge] Failed to start:", err);
    bridgeCtx = null;
  }
}

async function openclawWatchdog(): Promise<void> {
  if (!bridgeCtx) return;

  const adapter = bridgeCtx.adapter;
  const audit = bridgeCtx.audit;
  const config = adapter.getConfig();

  // Skip if integration is disabled
  if (!config.enabled) return;

  // 1. Check heartbeat staleness
  const heartbeat = adapter.readHeartbeat();
  if (heartbeat && heartbeat.lastHeartbeat) {
    const elapsed = Date.now() - new Date(heartbeat.lastHeartbeat).getTime();
    if (elapsed > 10 * 60_000) {
      console.warn("[openclaw-watchdog] OpenClaw offline (no heartbeat for >10 min)");
    } else if (elapsed > 2 * 60_000) {
      console.warn("[openclaw-watchdog] OpenClaw degraded (no heartbeat for >2 min)");
    }
  }

  // 2. Check rate anomalies from audit log
  const recentEntries = audit.getRecentEntries(60); // last hour
  const requestCount = recentEntries.filter(
    (e) => e.status === "accepted",
  ).length;
  const errorCount = recentEntries.filter(
    (e) => e.status === "error",
  ).length;
  const blockedCount = recentEntries.filter(
    (e) => e.action === "access_blocked" || e.status === "blocked",
  ).length;

  // Circuit breaker: too many requests/hour
  if (requestCount > (config.rateLimit.perHour || 500)) {
    console.error(
      `[openclaw-watchdog] CIRCUIT BREAKER: ${requestCount} requests in last hour exceeds limit`,
    );
    adapter.tripCircuitBreaker("rate_limit_exceeded");
    return;
  }

  // Circuit breaker: high error rate
  if (requestCount > 10 && errorCount / requestCount > 0.5) {
    console.error(
      `[openclaw-watchdog] CIRCUIT BREAKER: Error rate ${Math.round((errorCount / requestCount) * 100)}% exceeds 50%`,
    );
    adapter.tripCircuitBreaker("high_error_rate");
    return;
  }

  // Circuit breaker: blocked access attempts
  if (blockedCount > 5) {
    console.error(
      `[openclaw-watchdog] CIRCUIT BREAKER: ${blockedCount} blocked access attempts in last hour`,
    );
    adapter.tripCircuitBreaker("unauthorized_access_pattern");
    return;
  }

  // 3. Check delegation task backlog
  const pendingDir = path.join(VAULT_PATH, "_delegation", "pending");
  if (fs.existsSync(pendingDir)) {
    const openclawPending = fs
      .readdirSync(pendingDir)
      .filter((f) => f.includes("openclaw-"));
    if (openclawPending.length > 20) {
      console.warn(
        `[openclaw-watchdog] High delegation backlog: ${openclawPending.length} pending OpenClaw tasks`,
      );
    }
  }

  // 4. Auto-recover circuit breaker (half-open → closed after cooldown)
  if (config.circuitBreaker.status === "open" && config.circuitBreaker.openedAt) {
    const elapsed =
      Date.now() - new Date(config.circuitBreaker.openedAt).getTime();
    if (elapsed > (config.circuitBreaker.cooldownMinutes ?? 30) * 60_000) {
      console.log(
        "[openclaw-watchdog] Circuit breaker cooldown elapsed, resetting to closed",
      );
      adapter.resetCircuitBreaker();
    }
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────

interface ScheduledTask {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
  lastRun: number;
}

const tasks: ScheduledTask[] = [
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
    name: "openclaw-watchdog",
    intervalMs: 2 * 60 * 1000,
    fn: openclawWatchdog,
    lastRun: 0,
  },
];

async function runScheduler(): Promise<void> {
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

  // Start the OpenClaw Bridge HTTP server
  initBridge();

  // Write initial status before running any tasks
  await writeDaemonStatus();

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
}

// ─── Graceful Shutdown ───────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log("\n[daemon] Shutting down...");
  if (bridgeCtx) stopBridge(bridgeCtx);
  await vault.stopSync().catch(() => {});
  search.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[daemon] Received SIGTERM, shutting down...");
  if (bridgeCtx) stopBridge(bridgeCtx);
  await vault.stopSync().catch(() => {});
  search.close();
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────────────────

runScheduler().catch((err) => {
  console.error("[daemon] Fatal error:", err);
  process.exit(1);
});

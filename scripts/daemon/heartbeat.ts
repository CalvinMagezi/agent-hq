/**
 * Daemon Task: Process Heartbeat (every 5 min)
 *
 * Reads _system/HEARTBEAT.md, dispatches pending actions as background jobs
 * during active hours, runs rotating health checks, and manages alerts.
 */

import * as fs from "fs";
import * as path from "path";
import type { DaemonContext } from "./context.js";

const ACTIVE_HOURS = { start: 8, end: 24 };
const HEARTBEAT_WRITE_INTERVAL_MS = 10 * 60 * 1000;

interface HeartbeatState {
  lastChecks: Record<string, number>;
  lastStatus: "ok" | "alert";
  alerts: string[];
}

function loadHeartbeatState(statePath: string): HeartbeatState {
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, "utf-8"));
    }
  } catch { /* use defaults */ }
  return { lastChecks: {}, lastStatus: "ok", alerts: [] };
}

function saveHeartbeatState(statePath: string, state: HeartbeatState): void {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

function isActiveHours(): boolean {
  const hour = new Date().getHours();
  return hour >= ACTIVE_HOURS.start && hour < ACTIVE_HOURS.end;
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith(".md")).length;
}

/** Rotating health checks — each cycle runs the most overdue check */
function runRotatingCheck(
  state: HeartbeatState,
  vaultPath: string,
): { check: string; result: string; isAlert: boolean } | null {
  const checks: Record<string, () => { result: string; isAlert: boolean }> = {
    jobs: () => {
      const pending = countFiles(path.join(vaultPath, "_jobs/pending"));
      const running = countFiles(path.join(vaultPath, "_jobs/running"));
      const failed = countFiles(path.join(vaultPath, "_jobs/failed"));
      const isAlert = running > 10 || failed > 20;
      return {
        result: `pending=${pending} running=${running} failed=${failed}`,
        isAlert,
      };
    },
    workers: () => {
      const sessionsDir = path.join(vaultPath, "_agent-sessions");
      if (!fs.existsSync(sessionsDir)) return { result: "no sessions dir", isAlert: false };
      const files = fs.readdirSync(sessionsDir).filter(f => f.startsWith("worker-") && f.endsWith(".md"));
      return { result: `${files.length} worker session(s)`, isAlert: false };
    },
    relay: () => {
      const healthDir = path.join(vaultPath, "_delegation/relay-health");
      if (!fs.existsSync(healthDir)) return { result: "no relay health dir", isAlert: false };
      const files = fs.readdirSync(healthDir).filter(f => f.endsWith(".md"));
      return { result: `${files.length} relay(s) tracked`, isAlert: false };
    },
    disk: () => {
      const embeddingsDir = path.join(vaultPath, "_embeddings");
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

export async function processHeartbeat(ctx: DaemonContext): Promise<void> {
  const heartbeatPath = path.join(ctx.vaultPath, "_system/HEARTBEAT.md");
  if (!fs.existsSync(heartbeatPath)) return;

  const statePath = path.join(ctx.vaultPath, "_system/heartbeat-state.json");

  try {
    const matter = await import("gray-matter").then((m) => m.default);
    const raw = fs.readFileSync(heartbeatPath, "utf-8");
    const { data, content } = matter(raw);

    const actionsMatch = content.match(
      /## Pending Actions\s*\n([\s\S]*?)(?=\n##|$)/,
    );

    let actionsProcessed = 0;
    let updatedContent = content.trim();

    if (actionsMatch && isActiveHours()) {
      const actionsText = actionsMatch[1].trim();
      if (actionsText !== "_No pending actions._" && actionsText) {
        const pendingTasks = actionsText
          .split("\n")
          .filter((line) => /^[-*]\s+/.test(line))
          .map((line) => line.replace(/^[-*]\s+/, "").trim())
          .filter(Boolean);

        for (const task of pendingTasks) {
          const jobId = await ctx.vault.createJob({
            instruction: task,
            type: "background",
            priority: 40,
            securityProfile: "standard",
          });
          console.log(`[heartbeat] Created job ${jobId}: ${task.substring(0, 60)}...`);
          actionsProcessed++;
        }

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
    const state = loadHeartbeatState(statePath);
    const checkResult = runRotatingCheck(state, ctx.vaultPath);

    if (checkResult) {
      const { check, result, isAlert } = checkResult;
      if (isAlert) {
        state.alerts.push(`[${ctx.localTimestamp()}] ${check}: ${result}`);
        if (state.alerts.length > 10) state.alerts = state.alerts.slice(-10);
        state.lastStatus = "alert";
        console.log(`[heartbeat] ALERT ${check}: ${result}`);
      } else {
        state.lastStatus = "ok";
      }
      saveHeartbeatState(statePath, state);
    }

    // Update the Alerts section
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
      updatedContent = updatedContent.replace(/\n*## Alerts\s*\n[\s\S]*?(?=\n##|$)/, "");
    }

    // Early exit: skip writing if idle and recently written
    if (actionsProcessed === 0) {
      const last = data.lastProcessed ? new Date(data.lastProcessed).getTime() : 0;
      if (Date.now() - last < HEARTBEAT_WRITE_INTERVAL_MS && !checkResult?.isAlert) {
        return;
      }
    }

    data.lastProcessed = ctx.localTimestamp();
    data.status = state.lastStatus;
    fs.writeFileSync(heartbeatPath, matter.stringify(updatedContent.trim(), data), "utf-8");

    if (actionsProcessed > 0) {
      console.log(`[heartbeat] Processed ${actionsProcessed} action(s)`);
    }
  } catch (err) {
    console.error("[heartbeat] Error:", err);
  }
}

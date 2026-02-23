#!/usr/bin/env bun
/**
 * agent-hq-status — CLI system health checker.
 *
 * Reads vault status files and prints a formatted dashboard.
 *
 * Usage: bun run status
 */

import * as path from "path";
import * as fs from "fs";

const VAULT_PATH =
  process.env.VAULT_PATH ??
  path.resolve(import.meta.dir, "..", ".vault");

// ─── ANSI Helpers ───────────────────────────────────────────────────

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function formatTimeAgo(isoString: string | null | undefined): string {
  if (!isoString || isoString === "null") return red("never");
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 0) return green("just now");
  if (ms < 60_000) return green(`${Math.round(ms / 1000)}s ago`);
  if (ms < 3_600_000) return green(`${Math.round(ms / 60_000)}m ago`);
  if (ms < 86_400_000) return yellow(`${Math.round(ms / 3_600_000)}h ago`);
  return red(`${Math.round(ms / 86_400_000)}d ago`);
}

function statusColor(status: string): string {
  switch (status) {
    case "online": case "healthy": case "OK": return green(status);
    case "degraded": case "busy": return yellow(status);
    case "offline": case "FAILED": return red(status);
    default: return dim(status);
  }
}

// ─── Read Status Files ──────────────────────────────────────────────

async function main(): Promise<void> {
  const matter = await import("gray-matter").then((m) => m.default);

  console.log(bold("\nAgent-HQ System Status"));
  console.log("=".repeat(50));

  // ── API Keys ────────────────────────────────────────────────────
  console.log("");
  console.log(bold("Environment:"));

  // Check .env.local for keys
  const envPaths = [
    path.join(VAULT_PATH, "../apps/agent/.env.local"),
    path.join(VAULT_PATH, "../.env.local"),
  ];

  let envKeys: Record<string, boolean> = {
    OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
    BRAVE_API_KEY: !!process.env.BRAVE_API_KEY,
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
  };

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const key of Object.keys(envKeys)) {
        if (!envKeys[key]) {
          const match = content.match(new RegExp(`^${key}=(.+)`, "m"));
          if (match && match[1].trim()) {
            envKeys[key] = true;
          }
        }
      }
    }
  }

  for (const [key, set] of Object.entries(envKeys)) {
    const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c);
    console.log(`  ${key}: ${set ? green("set") : key === "OPENROUTER_API_KEY" ? red("MISSING") : yellow("not set")}`);
  }

  // ── Daemon ──────────────────────────────────────────────────────
  console.log("");
  const daemonPath = path.join(VAULT_PATH, "_system/DAEMON-STATUS.md");
  if (fs.existsSync(daemonPath)) {
    const { data } = matter(fs.readFileSync(daemonPath, "utf-8"));
    const uptime = data.daemonStartedAt ? formatTimeAgo(data.daemonStartedAt) : "unknown";
    console.log(bold("Daemon:") + `     ${green("Running")} (PID ${data.pid}, started ${uptime})`);
    console.log(`  Last updated: ${formatTimeAgo(data.lastUpdated)}`);
  } else {
    console.log(bold("Daemon:") + `     ${red("Not running")} (no DAEMON-STATUS.md)`);
  }

  // ── Heartbeat ───────────────────────────────────────────────────
  const hbPath = path.join(VAULT_PATH, "_system/HEARTBEAT.md");
  if (fs.existsSync(hbPath)) {
    const { data } = matter(fs.readFileSync(hbPath, "utf-8"));
    console.log(bold("Heartbeat:") + `  Last processed ${formatTimeAgo(data.lastProcessed)}`);
  } else {
    console.log(bold("Heartbeat:") + `  ${red("HEARTBEAT.md missing")}`);
  }

  // ── Workers ─────────────────────────────────────────────────────
  console.log("");
  console.log(bold("Workers:"));
  const sessionsDir = path.join(VAULT_PATH, "_agent-sessions");
  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir).filter((f) => f.startsWith("worker-") && f.endsWith(".md"));
    if (files.length === 0) {
      console.log(`  ${dim("No worker sessions found")}`);
    }
    for (const file of files) {
      const { data } = matter(fs.readFileSync(path.join(sessionsDir, file), "utf-8"));
      console.log(`  ${data.workerId ?? file}: ${statusColor(data.status ?? "unknown")}  heartbeat ${formatTimeAgo(data.lastHeartbeat)}`);
    }
  } else {
    console.log(`  ${dim("No _agent-sessions/ directory")}`);
  }

  // ── Relay Bots ──────────────────────────────────────────────────
  console.log("");
  console.log(bold("Relay Bots:"));
  const relayDir = path.join(VAULT_PATH, "_delegation/relay-health");
  if (fs.existsSync(relayDir)) {
    const files = fs.readdirSync(relayDir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) {
      console.log(`  ${dim("No relay health files found")}`);
    }
    for (const file of files) {
      const { data } = matter(fs.readFileSync(path.join(relayDir, file), "utf-8"));
      const name = data.displayName ?? data.relayId ?? file.replace(".md", "");
      const stats = `${data.tasksCompleted ?? 0} completed, ${data.tasksFailed ?? 0} failed`;
      console.log(`  ${name}: ${statusColor(data.status ?? "unknown")}  heartbeat ${formatTimeAgo(data.lastHeartbeat)}  (${dim(stats)})`);
    }
  } else {
    console.log(`  ${dim("No relay health directory")}`);
  }

  // ── Daemon Tasks ────────────────────────────────────────────────
  if (fs.existsSync(daemonPath)) {
    console.log("");
    console.log(bold("Daemon Tasks:"));
    const raw = fs.readFileSync(daemonPath, "utf-8");
    // Parse the markdown table
    const tableLines = raw.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Task") && !l.startsWith("|---"));
    for (const line of tableLines) {
      const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cols.length >= 5) {
        const [name, lastRun, lastSuccess, runs, errors] = cols;
        const errCount = parseInt(errors) || 0;
        const errLabel = errCount > 0 ? red(`${errors} errors`) : green("0 errors");
        console.log(`  ${name.padEnd(20)} last: ${formatTimeAgo(lastRun === "never" ? null : lastRun)}  ${runs} runs, ${errLabel}`);
      }
    }
  }

  // ── Scheduled Workflows ─────────────────────────────────────────
  console.log("");
  console.log(bold("Scheduled Workflows:"));
  const wfPath = path.join(VAULT_PATH, "_system/WORKFLOW-STATUS.md");
  if (fs.existsSync(wfPath)) {
    const { data } = matter(fs.readFileSync(wfPath, "utf-8"));
    const workflows = data.workflows as Record<string, { lastRun: string; success: boolean; lastSuccess: string | null; lastError: string | null }> | undefined;
    if (workflows && Object.keys(workflows).length > 0) {
      for (const [name, wf] of Object.entries(workflows)) {
        const status = wf.success ? green("OK") : red("FAILED");
        const errorInfo = wf.lastError ? `  ${dim(wf.lastError.substring(0, 60))}` : "";
        console.log(`  ${name.padEnd(25)} ${status}  last: ${formatTimeAgo(wf.lastRun)}${errorInfo}`);
      }
    } else {
      console.log(`  ${dim("No workflow runs recorded yet")}`);
    }
  } else {
    console.log(`  ${dim("No WORKFLOW-STATUS.md (workflows haven't run yet)")}`);
  }

  // ── Launchd Agents ──────────────────────────────────────────────
  console.log("");
  console.log(bold("Launchd Agents:"));
  const launchDir = path.join(process.env.HOME ?? "", "Library/LaunchAgents");
  const plistNames = [
    "memory-consolidation", "web-digest",
    "preference-tracker", "knowledge-analysis",
    "project-tracker", "model-tracker",
  ];
  for (const name of plistNames) {
    const plistPath = path.join(launchDir, `com.agent-hq.${name}.plist`);
    const installed = fs.existsSync(plistPath);
    console.log(`  com.agent-hq.${name}: ${installed ? green("installed") : red("not installed")}`);
  }

  console.log("");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
